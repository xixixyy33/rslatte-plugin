import { App, ButtonComponent, DropdownComponent, Modal, Notice, Setting, TextComponent } from "obsidian";
import type RSLattePlugin from "../../main";

/** Edit a milestone: rename / change level / change parent (max 3 levels). */
export class EditProjectMilestoneModal extends Modal {
  constructor(
    app: App,
    private plugin: RSLattePlugin,
    private projectFolderPath: string,
    private milestonePath: string
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("修改里程碑");

    let name = "";
    let level: 1 | 2 | 3 = 1;
    let parentPath = "";
    /** 计划完成日 YYYY-MM-DD，可选；保存时始终传入，空串表示清除 meta milestone_planned_end */
    let plannedEnd = "";
    let milestoneWeight = 1;
    let originalPath = String(this.milestonePath ?? "").trim();

    let milestonesMeta: Array<{
      path: string;
      name: string;
      level: 1 | 2 | 3;
      parentPath?: string;
      planned_end?: string;
      milestone_weight?: number;
    }> = [];

    let nameInput!: TextComponent;
    let plannedEndInput!: TextComponent;
    let plannedEndSetting!: Setting;
    let weightInput!: TextComponent;
    let levelDd!: DropdownComponent;
    let parentDd!: DropdownComponent;
    let saveBtn!: ButtonComponent;

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
      const w = parseWeight();
      const ok =
        (name ?? "").trim().length > 0 && (level === 1 || Boolean(parentPath)) && peOk && w.ok;
      saveBtn?.setDisabled(!ok);
      nameInput?.inputEl?.classList.toggle("is-invalid", !(name ?? "").trim().length > 0 || !(level === 1 || Boolean(parentPath)));
      plannedEndInput?.inputEl?.classList.toggle("is-invalid", !peOk);
      weightInput?.inputEl?.classList.toggle("is-invalid", !w.ok);
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
      .setName("当前里程碑")
      .setDesc(originalPath || "-")
      .addButton((b) => {
        b.setButtonText("打开")
          .onClick(() => {
            // best-effort jump: open tasklist at heading (exact path may differ after edits)
            void this.plugin.openNoteAtHeading(
              `${this.projectFolderPath}/项目任务清单.md`,
              originalPath.split(" / ").slice(-1)[0] || originalPath
            );
          });
      });

    new Setting(contentEl)
      .setName("里程碑名称*")
      .setDesc("将修改标题文本（不影响该里程碑下的任务内容）")
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
      .setDesc("仅一级里程碑；可选，写入 meta milestone_planned_end；留空保存将清除该字段")
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

    new Setting(contentEl)
      .setName("里程碑权重")
      .setDesc("1～100 的整数，默认 1；写入 meta milestone_weight。")
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
        await this.plugin.projectMgr.updateMilestone(this.projectFolderPath, originalPath, {
          name: (name ?? "").trim(),
          level,
          parentPath: parentPath || undefined,
          plannedEnd: level === 1 ? (plannedEnd ?? "").trim() : "",
          milestoneWeight: w.value,
        });
        new Notice("里程碑已更新");
        this.plugin.refreshSidePanel();
        this.close();
      } catch (e: any) {
        new Notice(`更新失败：${e?.message ?? String(e)}`);
      }
    };

    window.setTimeout(() => {
      nameInput?.inputEl?.focus();
      refresh();
    }, 0);

    // load meta
    (async () => {
      try {
        const meta = await this.plugin.projectMgr.listMilestonesMeta(this.projectFolderPath);
        milestonesMeta = (meta ?? []).map((x: any) => ({
          path: String(x?.path ?? "").trim(),
          name: String(x?.name ?? "").trim(),
          level: (Number(x?.level ?? 1) || 1) as 1 | 2 | 3,
          parentPath: String(x?.parentPath ?? "").trim() || undefined,
          planned_end:
            x?.planned_end && /^\d{4}-\d{2}-\d{2}$/.test(String(x.planned_end).trim())
              ? String(x.planned_end).trim()
              : undefined,
          milestone_weight:
            x?.milestone_weight != null && Number.isFinite(Number(x.milestone_weight))
              ? Math.min(100, Math.max(1, Math.floor(Number(x.milestone_weight))))
              : undefined,
        })).filter((x) => Boolean(x.path));
      } catch {
        milestonesMeta = [];
      }

      const cur = milestonesMeta.find((x) => x.path === originalPath);
      if (cur) {
        name = cur.name;
        level = cur.level;
        parentPath = cur.parentPath ?? "";
        plannedEnd = cur.planned_end ?? "";
        milestoneWeight = cur.milestone_weight != null ? cur.milestone_weight : 1;
        nameInput?.setValue(name);
        levelDd?.setValue(String(level));
        plannedEndInput?.setValue(plannedEnd);
        weightInput?.setValue(String(milestoneWeight));
      }
      rebuildParentOptions();
      syncPlannedRow();
      refresh();
    })();
  }
}
