import {
  App,
  ButtonComponent,
  DropdownComponent,
  Modal,
  Notice,
  Setting,
  TextAreaComponent,
  TextComponent,
  normalizePath,
} from "obsidian";

import type RSLattePlugin from "../../main";
import type { MilestoneProgress, ProjectEntry, ProjectTaskItem } from "../../projectManager/types";
import { DEFAULT_MILESTONE_PATH, resolveEffectiveMilestonePath } from "../../projectManager/parser";

/**
 * 编辑“项目任务”
 * - 可修改：描述、due/start/scheduled、状态、所属里程碑（迁移）
 * - 写回保持：任务行 + meta 行整体更新/移动（由 service 保证）
 * - 里程碑下拉：以路径展示（一级 / 二级 / 三级），同名通过 path 区分
 */
export class EditProjectTaskModal extends Modal {
  constructor(
    app: App,
    private plugin: RSLattePlugin,
    private projectFolderPath: string,
    private task: ProjectTaskItem
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("rslatte-modal");

    contentEl.createEl("h2", { text: "编辑项目任务" });

    const oneLine = (s: string) =>
      String(s ?? "")
        .replace(/[\r\n]+/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();

    const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? "").trim());

    // ===== derive effective milestone baseline (cancelled/missing -> parent/default) =====
    const snap = this.plugin.projectMgr.getSnapshot?.() as any;
    const project: ProjectEntry | undefined = (snap?.projects ?? []).find(
      (x: any) => String(x?.folderPath ?? "") === String(this.projectFolderPath ?? "")
    );

    const msIndex = new Map<string, { status?: "active" | "done" | "cancelled"; parentPath?: string }>();
    const ms = ((project as any)?.milestones ?? []) as MilestoneProgress[];
    for (const m of ms) {
      const path = String((m as any)?.path ?? (m as any)?.name ?? "").trim();
      if (!path) continue;
      msIndex.set(path, {
        status: (m as any)?.milestoneStatus as any,
        parentPath: String((m as any)?.parentPath ?? "").trim() || undefined,
      });
    }

    const rawMilestone = String((this.task as any).milestonePath ?? (this.task as any).milestone ?? "").trim();
    const origEffectiveMilestone = resolveEffectiveMilestonePath(rawMilestone, msIndex);

    const origStatus = String((this.task as any).statusName ?? "TODO").trim() as
      | "TODO"
      | "IN_PROGRESS"
      | "DONE"
      | "CANCELLED";

    // ===== form state =====
    let milestone = origEffectiveMilestone || DEFAULT_MILESTONE_PATH;
    let status = origStatus || "TODO";
    let text = String((this.task as any).text ?? "");
    // 与 projectManager/parser 中 ProjectTaskItem 字段一致（planned_end=📅、planned_start=⏳、estimate_h=meta）
    const tk = this.task as any;
    let due = String(tk.planned_end ?? tk.dueDate ?? "").trim();
    let scheduled = String(tk.planned_start ?? tk.scheduledDate ?? "").trim();
    const estRaw = tk.estimate_h ?? tk.estimateH;
    let estimateH = estRaw != null && estRaw !== "" ? String(estRaw) : "";
    let complexity: "high" | "normal" | "light" =
      (this.task as any).complexity === "high" ? "high"
      : (this.task as any).complexity === "light" ? "light" : "normal";

    let textInput!: TextAreaComponent;
    let dueInput!: TextComponent;
    let scheduledInput!: TextComponent;
    let estimateHInput!: TextComponent;
    let complexityDd!: DropdownComponent;
    let milestoneDd!: DropdownComponent;
    let statusDd!: DropdownComponent;
    let saveBtn!: ButtonComponent;

    const info = contentEl.createDiv({ cls: "rslatte-muted" });
    info.setText(`项目：${this.projectFolderPath}  •  任务：${String((this.task as any).taskId ?? "")}`);

    const refresh = () => {
      text = oneLine(textInput?.getValue?.() ?? text);
      due = String(dueInput?.getValue?.() ?? due).trim();
      scheduled = String(scheduledInput?.getValue?.() ?? scheduled).trim();
      estimateH = String(estimateHInput?.getValue?.() ?? estimateH).trim();
      complexity = (complexityDd?.getValue?.() as "high" | "normal" | "light") || complexity;
      milestone = String(milestoneDd?.getValue?.() ?? milestone).trim() || DEFAULT_MILESTONE_PATH;
      status = (String(statusDd?.getValue?.() ?? status).trim() as any) || "TODO";

      if (!text) {
        saveBtn?.setDisabled(true);
        return false;
      }
      if (!isYmd(due)) {
        saveBtn?.setDisabled(true);
        return false;
      }
      if (scheduled && !isYmd(scheduled)) {
        saveBtn?.setDisabled(true);
        return false;
      }
      if (estimateH && !/^\d+(\.\d+)?$/.test(estimateH)) {
        saveBtn?.setDisabled(true);
        return false;
      }
      if (status === "DONE") {
        const estN = estimateH ? parseFloat(estimateH.replace(",", ".")) : NaN;
        if (!Number.isFinite(estN) || estN <= 0) {
          saveBtn?.setDisabled(true);
          return false;
        }
      }
      saveBtn?.setDisabled(false);
      return true;
    };

    // ===== UI =====
    const descSetting = new Setting(contentEl)
      .setName("任务描述")
      .setDesc("只允许单行（回车会被替换为空格），超长内容会自动换行显示")
      .addTextArea((ta) => {
        textInput = ta;
        ta.setValue(text);
        ta.inputEl.rows = 3;
        // wrap display, but still enforce single-line content
        // @ts-ignore
        ta.inputEl.wrap = "soft";
        ta.inputEl.style.whiteSpace = "pre-wrap";
        // allow long tokens to wrap in narrow panels
        // @ts-ignore
        ta.inputEl.style.overflowWrap = "anywhere";
        // @ts-ignore
        ta.inputEl.style.wordBreak = "break-word";
        ta.inputEl.style.overflowX = "hidden";
        ta.inputEl.style.resize = "vertical";
        ta.inputEl.addEventListener("input", () => {
          // enforce single line
          const cleaned = oneLine(String(ta.getValue() ?? ""));
          if (cleaned !== ta.getValue()) {
            const pos = ta.inputEl.selectionStart ?? cleaned.length;
            ta.setValue(cleaned);
            try {
              ta.inputEl.setSelectionRange(pos, pos);
            } catch {}
          }
          text = cleaned;
          refresh();
        });
        ta.inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            if (!ev.shiftKey) void doSave();
          }
        });
      });

    // 🪪 Insert contact reference (append to end)
    const insertRow = descSetting.controlEl.createDiv({ cls: "rslatte-inline-insert-row" });
    insertRow.style.display = "flex";
    insertRow.style.justifyContent = "flex-end";
    insertRow.style.marginTop = "6px";
    new ButtonComponent(insertRow)
      .setButtonText("🪪 插入联系人")
      .onClick(() => {
        void this.plugin.openContactReferencePicker((ref) => {
          try {
            const cur = textInput?.getValue?.() ?? "";
            const sep = cur && !/\s$/.test(cur) ? " " : "";
            const next = `${cur}${sep}${ref} `;
            textInput?.setValue?.(next);
            text = next;
            refresh();
            const el = textInput?.inputEl;
            if (el) {
              el.focus();
              try { el.setSelectionRange(next.length, next.length); } catch {}
            }
          } catch (e) {
            console.warn("[RSLatte][projectTask][insertContact] failed", e);
            new Notice("插入联系人失败");
          }
        });
      });

    new Setting(contentEl)
      .setName("计划开始日")
      .setDesc("可选，对应任务行 ⏳（计划开始）")
      .addText((t) => {
        scheduledInput = t;
        t.inputEl.type = "date";
        t.setValue(scheduled || "");
        t.onChange((v) => {
          scheduled = (v ?? "").trim();
          t.inputEl.classList.toggle("is-invalid", scheduled && !isYmd(scheduled));
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
      .setName("计划结束日*")
      .setDesc("必填，对应任务行 📅（计划完成/承诺完成日）")
      .addText((t) => {
        dueInput = t;
        t.inputEl.type = "date";
        t.setValue(due || "");
        t.onChange((v) => {
          due = (v ?? "").trim();
          t.inputEl.classList.toggle("is-invalid", !isYmd(due));
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
      .setName("工时评估 h")
      .setDesc("非必填，单位：小时")
      .addText((t) => {
        estimateHInput = t;
        t.inputEl.type = "number";
        t.inputEl.placeholder = "例如 2 或 1.5";
        t.setValue(estimateH || "");
        t.onChange((v) => {
          estimateH = (v ?? "").trim();
          t.inputEl.classList.toggle("is-invalid", estimateH && !/^\d+(\.\d)?$/.test(estimateH));
          refresh();
        });
      });

    new Setting(contentEl)
      .setName("任务复杂度")
      .addDropdown((dd) => {
        complexityDd = dd;
        dd.addOption("normal", "一般任务");
        dd.addOption("high", "高脑力 🧠");
        dd.addOption("light", "轻量任务 🍃");
        dd.setValue(complexity || "normal");
        dd.onChange((v) => {
          complexity = (v as "high" | "normal" | "light") || "normal";
          refresh();
        });
      });

    new Setting(contentEl)
      .setName("所属里程碑")
      .setDesc("以路径展示：一级 / 二级 / 三级（同名可区分）")
      .addDropdown((dd) => {
        milestoneDd = dd;
        dd.addOption(DEFAULT_MILESTONE_PATH, DEFAULT_MILESTONE_PATH);
        // ensure current milestone is selectable even before async options load
        if (milestone && milestone !== DEFAULT_MILESTONE_PATH) dd.addOption(milestone, milestone);
        if (
          origEffectiveMilestone &&
          origEffectiveMilestone !== DEFAULT_MILESTONE_PATH &&
          origEffectiveMilestone !== milestone
        ) {
          dd.addOption(origEffectiveMilestone, origEffectiveMilestone);
        }
        dd.setValue(milestone || DEFAULT_MILESTONE_PATH);
        dd.onChange(() => refresh());
      });

    new Setting(contentEl)
      .setName("状态")
      .addDropdown((dd) => {
        statusDd = dd;
        dd.addOption("TODO", "TODO");
        dd.addOption("IN_PROGRESS", "IN_PROGRESS");
        dd.addOption("DONE", "DONE");
        dd.addOption("CANCELLED", "CANCELLED");
        dd.setValue(status || "TODO");
        dd.onChange(() => refresh());
      });

    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });
    saveBtn = new ButtonComponent(btnRow)
      .setButtonText("保存")
      .setCta()
      .onClick(() => void doSave());
    new ButtonComponent(btnRow).setButtonText("关闭").onClick(() => this.close());

    const doSave = async () => {
      if (!refresh()) return;
      try {
        const ref = { taskId: (this.task as any).taskId, lineNo: (this.task as any).lineNo };

        // 1) milestone migration (based on effective baseline)
        if (milestone && milestone !== origEffectiveMilestone) {
          await this.plugin.projectMgr.moveProjectTaskToMilestone(this.projectFolderPath, ref, milestone);
        }

        // 2) basic info update（开始日期不在弹窗编辑，由「开始处理」时写入；已有 🛫 会保留）
        const est = (estimateH ?? "").trim();
        await this.plugin.projectMgr.updateProjectTaskBasicInfo(this.projectFolderPath, ref, {
          text,
          due,
          scheduled,
          ...(est ? { estimateH: Number(est) } : {}),
          ...(complexity !== "normal" ? { complexity } : {}),
        });

        // 3) status update
        if (status && status !== origStatus) {
          const estForDone =
            status === "DONE" ? parseFloat(String(estimateH ?? "").trim().replace(",", ".")) : NaN;
          await this.plugin.projectMgr.setProjectTaskStatus(
            this.projectFolderPath,
            ref,
            status,
            status === "DONE" && Number.isFinite(estForDone) && estForDone > 0 ? { estimateH: estForDone } : undefined,
          );
        }

        // best-effort: refresh index
        try {
          await this.plugin.projectMgr?.refreshDirty?.({ reason: "edit_project_task" });
        } catch {}

        if (status && status !== origStatus && typeof this.plugin.refreshContactInteractionsForTasklistFile === "function") {
          try {
            const folder = String(this.projectFolderPath ?? "").trim();
            if (folder) {
              const snap = (this.plugin.projectMgr as any)?.getSnapshot?.() as any;
              const projects = Array.isArray(snap?.projects) ? snap.projects : [];
              const proj = projects.find((x: any) => String(x?.folderPath ?? x?.folder_path ?? "").trim() === folder);
              const tasklistPath = (proj as any)?.tasklistFilePath ?? (proj as any)?.tasklist_file_path ?? normalizePath(`${folder}/项目任务清单.md`);
              await this.plugin.refreshContactInteractionsForTasklistFile(tasklistPath);
            }
          } catch (e) {
            console.warn("[RSLatte] refreshContactInteractions after edit project task failed", e);
          }
        }

        new Notice("已修改项目任务");
        this.plugin.refreshSidePanel();
        this.close();
      } catch (e: any) {
        new Notice(`写入失败：${e?.message ?? String(e)}`);
      }
    };

    // async load milestone options
    (async () => {
      try {
        const currentSelected = String(milestoneDd?.getValue?.() ?? milestone).trim();
        const names = await this.plugin.projectMgr.listMilestoneNames(this.projectFolderPath);
        const uniq: string[] = [];
        const seen = new Set<string>();
        for (const n of [DEFAULT_MILESTONE_PATH, ...(names ?? []), milestone, origEffectiveMilestone]) {
          const v = String(n ?? "").trim();
          if (!v) continue;
          if (seen.has(v)) continue;
          seen.add(v);
          uniq.push(v);
        }
        if (milestoneDd?.selectEl) {
          milestoneDd.selectEl.empty();
          for (const n of uniq) milestoneDd.addOption(n, n);
          // preserve user's selection if possible
          const pick =
            (currentSelected && uniq.includes(currentSelected)
              ? currentSelected
              : uniq.includes(milestone)
              ? milestone
              : uniq.includes(origEffectiveMilestone)
              ? origEffectiveMilestone
              : uniq[0]) as string;
          milestoneDd.setValue(pick);
          milestone = pick;
        }
      } catch {
        // ignore
      }
    })();

    window.setTimeout(() => {
      try {
        textInput?.inputEl?.focus();
      } catch {}
      refresh();
    }, 0);
  }
}
