import { App, ButtonComponent, DropdownComponent, Modal, Notice, normalizePath, Setting, TextComponent } from "obsidian";
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
    /** 计划完成日 YYYY-MM-DD，可选，写入 meta milestone_planned_end */
    let plannedEnd = "";
    /** 里程碑权重 1–100，默认 1，写入 meta milestone_weight（为 1 时可不写盘） */
    let milestoneWeight = 1;

    let milestonesMeta: Array<{ path: string; level: 1 | 2 | 3 }> = [];
    /** 项目计划结束日，用于一级里程碑「计划完成日」上限 */
    let projectPlannedEndYmd = "";

    let nameInput!: TextComponent;
    let plannedEndInput!: TextComponent;
    let plannedEndSetting!: Setting;
    let weightInput!: TextComponent;
    let levelDd!: DropdownComponent;
    let parentDd!: DropdownComponent;
    let saveBtn!: ButtonComponent;
    let milestoneDateWarnEl!: HTMLElement;

    const isValidYmd = (s: string) => !s || /^\d{4}-\d{2}-\d{2}$/.test((s ?? "").trim());

    const parseWeight = (): { ok: boolean; value: number } => {
      const raw = String(weightInput?.inputEl?.value ?? milestoneWeight ?? "1").trim();
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 1 || n > 100) return { ok: false, value: 1 };
      return { ok: true, value: n };
    };

    const syncPlannedRow = () => {
      if (plannedEndSetting?.settingEl) {
        plannedEndSetting.settingEl.style.display = level === 1 ? "" : "none";
      }
      if (level !== 1) {
        plannedEnd = "";
        plannedEndInput?.setValue("");
      }
    };

    const refresh = () => {
      const pe = (plannedEnd ?? "").trim();
      const peOk = level !== 1 || isValidYmd(pe);
      const projEndOk = projectPlannedEndYmd && /^\d{4}-\d{2}-\d{2}$/.test(projectPlannedEndYmd);
      const msAfterProject =
        level === 1 &&
        pe &&
        projEndOk &&
        /^\d{4}-\d{2}-\d{2}$/.test(pe) &&
        pe > projectPlannedEndYmd;
      const w = parseWeight();
      const ok =
        (name ?? "").trim().length > 0 &&
        (level === 1 || Boolean(parentPath)) &&
        peOk &&
        !msAfterProject &&
        w.ok;
      saveBtn?.setDisabled(!ok);
      nameInput?.inputEl?.classList.toggle("is-invalid", !(name ?? "").trim().length > 0 || !(level === 1 || Boolean(parentPath)));
      plannedEndInput?.inputEl?.classList.toggle("is-invalid", !peOk || msAfterProject);
      weightInput?.inputEl?.classList.toggle("is-invalid", !w.ok);
      if (milestoneDateWarnEl) {
        milestoneDateWarnEl.textContent = msAfterProject
          ? `一级里程碑计划完成日不能晚于项目计划结束日（${projectPlannedEndYmd}）。`
          : "";
        milestoneDateWarnEl.style.display = msAfterProject ? "block" : "none";
      }
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
          syncPlannedRow();
        });
      });

    plannedEndSetting = new Setting(contentEl)
      .setName("计划完成日")
      .setDesc("仅一级里程碑维护；可选，写入 meta milestone_planned_end（YYYY-MM-DD）")
      .addText((t) => {
        plannedEndInput = t;
        t.inputEl.type = "date";
        t.setValue("");
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

    milestoneDateWarnEl = contentEl.createDiv({ cls: "rslatte-task-date-order-warning" });
    milestoneDateWarnEl.style.display = "none";

    new Setting(contentEl)
      .setName("里程碑权重")
      .setDesc("1～100 的整数，默认 1；写入 meta milestone_weight，参与总进度加权（第九节）。")
      .addText((t) => {
        weightInput = t;
        t.setPlaceholder("1");
        t.setValue("1");
        t.inputEl.type = "number";
        t.inputEl.min = "1";
        t.inputEl.max = "100";
        t.onChange((v) => {
          milestoneWeight = parseInt(String(v ?? "1"), 10) || 1;
          refresh();
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
        const w = parseWeight();
        if (!w.ok) {
          new Notice("里程碑权重须为 1～100 的整数");
          return;
        }
        const peSave = level === 1 ? (plannedEnd ?? "").trim() : "";
        if (
          level === 1 &&
          peSave &&
          /^\d{4}-\d{2}-\d{2}$/.test(peSave) &&
          projectPlannedEndYmd &&
          /^\d{4}-\d{2}-\d{2}$/.test(projectPlannedEndYmd) &&
          peSave > projectPlannedEndYmd
        ) {
          new Notice("一级里程碑计划完成日不能晚于项目计划结束日");
          return;
        }
        await this.plugin.projectMgr.addMilestone(this.projectFolderPath, (name ?? "").trim(), {
          level,
          parentPath: parentPath || undefined,
          ...(level === 1 && peSave && /^\d{4}-\d{2}-\d{2}$/.test(peSave) ? { plannedEnd: peSave } : {}),
          milestoneWeight: w.value,
        });
        new Notice("里程碑已添加");
        this.plugin.refreshSidePanel();
        this.close();
      } catch (e: any) {
        new Notice(`添加失败：${e?.message ?? String(e)}`);
      }
    };

    window.setTimeout(() => {
      syncPlannedRow();
      nameInput?.inputEl?.focus();
      refresh();
    }, 0);

    // load milestone meta for parent dropdown + 项目计划结束日（一级里程碑计划完成日上限）
    (async () => {
      try {
        const folder = normalizePath(String(this.projectFolderPath ?? "").trim());
        const proj = this.plugin.projectMgr.getSnapshot().projects.find(
          (p) => normalizePath(String(p.folderPath ?? "").trim()) === folder,
        );
        const pe = String(proj?.planned_end ?? "").trim();
        projectPlannedEndYmd = /^\d{4}-\d{2}-\d{2}$/.test(pe) ? pe : "";
      } catch {
        projectPlannedEndYmd = "";
      }
      refresh();
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
      syncPlannedRow();
    })();
  }
}
