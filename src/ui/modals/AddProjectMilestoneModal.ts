import { App, ButtonComponent, DropdownComponent, Modal, Notice, Setting, TextComponent } from "obsidian";
import type RSLattePlugin from "../../main";

export class AddProjectMilestoneModal extends Modal {
  constructor(app: App, private plugin: RSLattePlugin, private projectFolderPath: string) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("添加里程碑");

    let name = "";
    let level: 1 | 2 | 3 = 1;
    let parentPath = "";

    let milestonesMeta: Array<{ path: string; level: 1 | 2 | 3 }> = [];

    let nameInput!: TextComponent;
    let levelDd!: DropdownComponent;
    let parentDd!: DropdownComponent;
    let saveBtn!: ButtonComponent;

    const refresh = () => {
      const ok = (name ?? "").trim().length > 0 && (level === 1 || Boolean(parentPath));
      saveBtn?.setDisabled(!ok);
      nameInput?.inputEl?.classList.toggle("is-invalid", !ok);
      return ok;
    };

    const rebuildParentOptions = () => {
      if (!parentDd) return;
      parentDd.selectEl.empty();
      const requiredParentLevel = (level === 2 ? 1 : level === 3 ? 2 : 0);
      if (requiredParentLevel === 0) {
        parentDd.addOption("", "（无需父里程碑）");
        parentDd.setValue("");
        parentDd.setDisabled(true);
        parentPath = "";
        refresh();
        return;
      }

      const options = milestonesMeta
        .filter((x) => Number(x.level) === requiredParentLevel)
        .map((x) => x.path)
        .filter(Boolean);

      parentDd.addOption("", options.length ? "请选择父里程碑" : "（请先创建父里程碑）");
      for (const p of options) parentDd.addOption(p, p);
      parentDd.setDisabled(!options.length);
      if (!options.includes(parentPath)) parentPath = "";
      parentDd.setValue(parentPath);
      refresh();
    };

    new Setting(contentEl)
      .setName("里程碑名称*")
      .setDesc("将写入项目任务清单为标题：# / ## / ###")
      .addText((t) => {
        nameInput = t;
        t.setPlaceholder("例如：需求确认");
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
      .setName("里程碑层级")
      .setDesc("最多支持三层：一级(#)、二级(##)、三级(###)")
      .addDropdown((dd) => {
        levelDd = dd;
        dd.addOption("1", "一级 (#)");
        dd.addOption("2", "二级 (##)");
        dd.addOption("3", "三级 (###)");
        dd.setValue(String(level));
        dd.onChange((v) => {
          const n = Math.max(1, Math.min(3, Number(v) || 1)) as 1 | 2 | 3;
          level = n;
          rebuildParentOptions();
        });
      });

    new Setting(contentEl)
      .setName("父里程碑")
      .setDesc("非一级里程碑必须选择父里程碑：二级选一级为父；三级选二级为父")
      .addDropdown((dd) => {
        parentDd = dd;
        dd.addOption("", "加载中...");
        dd.setValue("");
        dd.setDisabled(true);
        dd.onChange((v) => {
          parentPath = String(v ?? "");
          refresh();
        });
      });

    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });
    saveBtn = new ButtonComponent(btnRow).setButtonText("保存").setCta().onClick(() => void doSave());
    new ButtonComponent(btnRow).setButtonText("关闭").onClick(() => this.close());

    const doSave = async () => {
      if (!refresh()) return;
      try {
        await this.plugin.projectMgr.addMilestone(this.projectFolderPath, (name ?? "").trim(), {
          level,
          parentPath: parentPath || undefined,
        });
        new Notice("里程碑已添加");
        this.plugin.refreshSidePanel();
        this.close();
      } catch (e: any) {
        new Notice(`添加失败：${e?.message ?? String(e)}`);
      }
    };

    window.setTimeout(() => {
      nameInput?.inputEl?.focus();
      refresh();
    }, 0);

    // load milestone meta for parent dropdown
    (async () => {
      try {
        const meta = await this.plugin.projectMgr.listMilestonesMeta(this.projectFolderPath);
        milestonesMeta = (meta ?? []).map((x: any) => ({
          path: String(x?.path ?? "").trim(),
          level: (Number(x?.level ?? 1) || 1) as 1 | 2 | 3,
        })).filter((x) => Boolean(x.path));
      } catch {
        milestonesMeta = [];
      }
      rebuildParentOptions();
    })();
  }
}
