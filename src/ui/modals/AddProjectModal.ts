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
    let plannedStart = "";
    let plannedEnd = ""; // 必填

    let nameInput!: TextComponent;
    let saveBtn!: ButtonComponent;
    const dateRefs: { warnEl?: HTMLElement; startEl?: HTMLInputElement; endEl?: HTMLInputElement } = {};

    const isValidYmd = (s: string) => !s || /^\d{4}-\d{2}-\d{2}$/.test(s);

    const refresh = () => {
      const nameOk = (name ?? "").trim().length > 0;
      const startTrim = (plannedStart ?? "").trim();
      const endTrim = (plannedEnd ?? "").trim();
      const plannedEndOk = isValidYmd(endTrim) && endTrim.length > 0;
      const startOk = isValidYmd(startTrim);
      const orderBad = Boolean(startTrim && endTrim && startOk && plannedEndOk && startTrim > endTrim);
      const ok = nameOk && plannedEndOk && startOk && !orderBad;
      saveBtn?.setDisabled(!ok);
      nameInput?.inputEl?.classList.toggle("is-invalid", !nameOk);
      const w = dateRefs.warnEl;
      if (w) {
        w.textContent = orderBad ? "计划开始日不能晚于计划结束日，请更正。" : "";
        w.style.display = orderBad ? "block" : "none";
      }
      dateRefs.startEl?.classList.toggle("is-invalid", !startOk || orderBad);
      dateRefs.endEl?.classList.toggle("is-invalid", !plannedEndOk || orderBad);
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
      .setName("计划开始日")
      .setDesc("选填；格式 YYYY-MM-DD")
      .addText((t) => {
        t.inputEl.type = "date";
        t.setValue("");
        dateRefs.startEl = t.inputEl;
        t.onChange((v) => {
          plannedStart = (v ?? "").trim();
          refresh();
        });
      });

    new Setting(contentEl)
      .setName("计划结束日*")
      .setDesc("必填；格式 YYYY-MM-DD")
      .addText((t) => {
        t.inputEl.type = "date";
        t.setValue("");
        dateRefs.endEl = t.inputEl;
        t.onChange((v) => {
          plannedEnd = (v ?? "").trim();
          refresh();
        });
        t.inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            void doSave();
          }
        });
      });

    dateRefs.warnEl = contentEl.createDiv({ cls: "rslatte-task-date-order-warning" });
    dateRefs.warnEl.style.display = "none";

    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });
    saveBtn = new ButtonComponent(btnRow).setButtonText("创建").setCta().onClick(() => void doSave());
    new ButtonComponent(btnRow).setButtonText("关闭").onClick(() => this.close());

    const doSave = async () => {
      refresh();
      if (saveBtn.disabled) return;
      const startYmd = (plannedStart ?? "").trim();
      const endYmd = (plannedEnd ?? "").trim();
      if (!endYmd || !/^\d{4}-\d{2}-\d{2}$/.test(endYmd)) {
        new Notice("计划结束日为必填，格式 YYYY-MM-DD");
        return;
      }
      if (startYmd && /^\d{4}-\d{2}-\d{2}$/.test(startYmd) && startYmd > endYmd) {
        new Notice("计划开始日不能晚于计划结束日，请更正");
        return;
      }
      try {
        await this.plugin.projectMgr.createProject(
          (name ?? "").trim(),
          endYmd,
          (plannedStart ?? "").trim() || undefined
        );
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
