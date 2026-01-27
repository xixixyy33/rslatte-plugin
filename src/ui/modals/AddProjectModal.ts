import { App, ButtonComponent, Modal, Notice, Setting, TextComponent } from "obsidian";
import type RSLattePlugin from "../../main";

export class AddProjectModal extends Modal {
  constructor(app: App, private plugin: RSLattePlugin) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("新增项目");

    let name = "";
    let due = ""; // 可选

    let nameInput!: TextComponent;
    let saveBtn!: ButtonComponent;

    const isValidYmd = (s: string) => !s || /^\d{4}-\d{2}-\d{2}$/.test(s);

    const refresh = () => {
      const nameOk = (name ?? "").trim().length > 0;
      const dueOk = isValidYmd((due ?? "").trim());
      saveBtn?.setDisabled(!(nameOk && dueOk));
      nameInput?.inputEl?.classList.toggle("is-invalid", !nameOk);
    };

    new Setting(contentEl)
      .setName("项目名称*")
      .addText((t) => {
        nameInput = t;
        t.setPlaceholder("例如：生态适配 Phase1");
        t.onChange((v) => {
          name = v ?? "";
          refresh();
        });
        t.inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            void doSave();
          }
        });
      });

    new Setting(contentEl)
      .setName("截至时间")
      .setDesc("选填；格式 YYYY-MM-DD")
      .addText((t) => {
        t.inputEl.type = "date";
        t.setValue("");
        t.onChange((v) => {
          due = (v ?? "").trim();
          t.inputEl.classList.toggle("is-invalid", !isValidYmd(due));
          refresh();
        });
        t.inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            void doSave();
          }
        });
      });

    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });
    saveBtn = new ButtonComponent(btnRow).setButtonText("创建").setCta().onClick(() => void doSave());
    new ButtonComponent(btnRow).setButtonText("关闭").onClick(() => this.close());

    const doSave = async () => {
      refresh();
      if (saveBtn.disabled) return;
      try {
        await this.plugin.projectMgr.createProject((name ?? "").trim(), (due ?? "").trim() || undefined);
        new Notice("项目已创建");
        this.plugin.refreshSidePanel();
        this.close();
      } catch (e: any) {
        new Notice(`创建失败：${e?.message ?? String(e)}`);
      }
    };

    window.setTimeout(() => {
      nameInput?.inputEl?.focus();
      refresh();
    }, 0);
  }
}
