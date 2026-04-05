import { App, ButtonComponent, Modal, Notice, Setting, TextAreaComponent } from "obsidian";

import type RSLattePlugin from "../../main";
import type { RSLatteIndexItem } from "../../taskRSLatte/types";
import { getTaskBusinessCategories } from "../../taskRSLatte/task/taskBusinessCategory";
import { writeTaskUpdateBasicInfo } from "../../services/execution/taskWriteFacade";
import { EXECUTION_RECIPE } from "../../services/execution/executionOrchestrator";
import { buildWorkEventUiAction } from "../../services/execution/buildExecutionWorkEvents";
import { runExecutionFlowUi } from "../helpers/runExecutionFlowUi";
import { indexItemTaskDisplayPhase, normalizeRepeatRuleToken } from "../../taskRSLatte/utils";

/**
 * Edit basic task fields (same as AddTaskModal):
 * - description, due (required), scheduled (optional)
 * - 开始日期不在此编辑，由「开始处理任务」时写入
 * - estimateH, complexity
 */
export class EditTaskModal extends Modal {
  constructor(app: App, private plugin: RSLattePlugin, private item: RSLatteIndexItem) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("修改任务");

    // 勿用 text||raw：解析出的 text 为空串时 raw 是整行，会导致再次写入时叠一层 buildDescPrefix，出现重复 ↪/🧠/标题
    let text = String(this.item.text ?? "").trim();
    let due = String((this.item as any).planned_end || "").trim();
    let scheduled = String((this.item as any).planned_start || "").trim();
    let estimateH = (this.item as any).estimate_h != null ? String((this.item as any).estimate_h) : "";
    let complexity: "high" | "normal" | "light" =
      (this.item as any).complexity === "high" ? "high"
      : (this.item as any).complexity === "light" ? "light" : "normal";
    let repeatRule: "none" | "weekly" | "monthly" | "quarterly" | "yearly" = (() => {
      const rr = normalizeRepeatRuleToken(String((this.item as any).repeatRule ?? "").trim().toLowerCase());
      if (rr === "weekly" || rr === "monthly" || rr === "quarterly" || rr === "yearly") return rr;
      return "none";
    })();
    const extraMeta = ((this.item as any).extra ?? {}) as Record<string, string>;
    let taskCategory = String(extraMeta.task_category ?? "").trim();

    let textInput!: TextAreaComponent;
    let saveBtn!: ButtonComponent;

    const isValidYmd = (s: string) => !s || /^\d{4}-\d{2}-\d{2}$/.test(s);

    const refresh = () => {
      const dueOk = /^\d{4}-\d{2}-\d{2}$/.test((due ?? "").trim());
      const scheduledOk = isValidYmd((scheduled ?? "").trim());
      const estOk = !estimateH || /^\d+(\.\d)?$/.test(String(estimateH).trim());

      const ok = (text ?? "").trim().length > 0 && dueOk && scheduledOk && estOk;
      saveBtn?.setDisabled(!ok);
      textInput?.inputEl?.classList.toggle("is-invalid", !(text ?? "").trim());
      return ok;
    };

    const descSetting = new Setting(contentEl)
      .setName("任务描述*")
      .addTextArea((t) => {
        textInput = t;
        t.setPlaceholder("例如：买牛奶");
        t.setValue(text);

        // 视觉上允许自动换行，但内容保持单行（禁止换行符）
        const ta = t.inputEl;
        ta.rows = 2;
        ta.style.width = "100%";
        ta.style.resize = "none";
        ta.style.whiteSpace = "pre-wrap";
        ta.style.overflowWrap = "anywhere";
        ta.style.wordBreak = "break-word";

        let inSanitize = false;
        const sanitizeAndResize = () => {
          if (inSanitize) return;
          inSanitize = true;
          try {
            const raw = t.getValue() ?? "";
            const single = raw.replace(/[\r\n]+/g, " ");
            if (single !== raw) {
              const pos = ta.selectionStart ?? single.length;
              t.setValue(single);
              try { ta.setSelectionRange(Math.max(0, pos - 1), Math.max(0, pos - 1)); } catch { }
            }
            text = single;
            ta.style.height = "auto";
            ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
          } finally {
            inSanitize = false;
          }
          refresh();
        };

        t.onChange(() => sanitizeAndResize());
        ta.addEventListener("input", () => sanitizeAndResize());
        ta.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            void doSave();
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
            const ta = textInput?.inputEl;
            if (ta) {
              ta.focus();
              try { ta.setSelectionRange(next.length, next.length); } catch {}
            }
          } catch (e) {
            console.warn("[RSLatte][task][insertContact] failed", e);
            new Notice("插入联系人失败");
          }
        });
      });

    new Setting(contentEl)
      .setName("计划结束日*")
      .addText((t) => {
        t.inputEl.type = "date";
        if (due) t.setValue(due);
        t.onChange((v) => {
          due = (v ?? "").trim();
          t.inputEl.classList.toggle("is-invalid", !/^\d{4}-\d{2}-\d{2}$/.test(due));
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
      .addText((t) => {
        t.inputEl.type = "date";
        t.setValue(scheduled || "");
        t.onChange((v) => {
          scheduled = (v ?? "").trim();
          t.inputEl.classList.toggle("is-invalid", !isValidYmd(scheduled));
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
        t.inputEl.type = "number";
        t.inputEl.placeholder = "例如 2 或 1.5";
        t.setValue(estimateH || "");
        t.onChange((v) => {
          estimateH = (v ?? "").trim();
          t.inputEl.classList.toggle("is-invalid", !!(estimateH && !/^\d+(\.\d)?$/.test(estimateH)));
          refresh();
        });
      });

    new Setting(contentEl)
      .setName("任务复杂度")
      .addDropdown((dd) => {
        dd.addOption("normal", "一般任务");
        dd.addOption("high", "高脑力 🧠");
        dd.addOption("light", "轻量任务 🍃");
        dd.setValue(complexity);
        dd.onChange((v) => {
          complexity = (v as "high" | "normal" | "light") || "normal";
          refresh();
        });
      });

    new Setting(contentEl)
      .setName("周期任务")
      .setDesc("每次都需要重新完成一次；仅任务使用该口径。")
      .addDropdown((d) => {
        d.addOption("none", "不设置");
        d.addOption("weekly", "每周");
        d.addOption("monthly", "每月");
        d.addOption("quarterly", "每季");
        d.addOption("yearly", "每年");
        d.setValue(repeatRule);
        d.onChange((v) => {
          const vv = String(v ?? "").trim().toLowerCase();
          if (vv === "weekly" || vv === "monthly" || vv === "quarterly" || vv === "yearly") repeatRule = vv;
          else repeatRule = "none";
          refresh();
        });
      });

    new Setting(contentEl)
      .setName("任务分类")
      .setDesc("选「（不分类）」将移除 meta 中的分类字段；历史快照名称若不在当前列表中仍会显示在选项中。")
      .addDropdown((d) => {
        const cats = [...getTaskBusinessCategories(this.plugin.settings?.taskPanel)];
        if (taskCategory && !cats.includes(taskCategory)) cats.unshift(taskCategory);
        d.addOption("", "（不分类）");
        for (const c of cats) d.addOption(c, c);
        d.setValue(taskCategory);
        d.onChange((v) => {
          taskCategory = v;
          refresh();
        });
      });

    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });
    saveBtn = new ButtonComponent(btnRow).setButtonText("保存").setCta().onClick(() => void doSave());
    new ButtonComponent(btnRow).setButtonText("关闭").onClick(() => this.close());

    const doSave = async () => {
      if (!refresh()) return;
      try {
        const est = (estimateH ?? "").trim();
        await writeTaskUpdateBasicInfo(this.plugin.taskRSLatte, this.item as any, {
          text: (text ?? "").trim(),
          planned_end: (due ?? "").trim(),
          planned_start: (scheduled ?? "").trim(),
          estimate_h: est ? Number(est) : undefined,
          complexity: complexity !== "normal" ? complexity : undefined,
          repeatRule: repeatRule !== "none" ? repeatRule : undefined,
          task_category: taskCategory.trim() === "" ? "" : taskCategory.trim(),
        }, { skipWorkEvent: true });
        await runExecutionFlowUi(this.plugin, EXECUTION_RECIPE.updateTaskAndRefresh, {
          sync: (this.plugin.isTaskDbSyncEnabledV2?.() ?? (this.plugin.settings.taskPanel.enableDbSync !== false)),
          noticeOnError: true,
          workEvent: buildWorkEventUiAction({
            kind: "task",
            action: "update",
            summary: `✏️ 修改任务 ${(text ?? "").trim() || "未命名任务"}`,
            ref: {
              uid: (this.item as any).uid,
              file_path: this.item.filePath,
              line_no: this.item.lineNo,
              task_phase_before: indexItemTaskDisplayPhase(this.item as any),
              task_phase_after: indexItemTaskDisplayPhase(this.item as any),
            },
            metrics: { due: (due ?? "").trim(), scheduled: (scheduled ?? "").trim() || undefined },
            taskContactEnrich: {
              taskLine: String((this.item as any).raw ?? this.item.text ?? ""),
              followContactUids: Array.isArray((this.item as any).follow_contact_uids)
                ? (this.item as any).follow_contact_uids.map((x: string) => String(x ?? "").trim()).filter(Boolean)
                : [],
            },
          }),
        }, { actionLabel: "更新任务" });
        new Notice("已更新任务");
        this.close();
      } catch (e: any) {
        new Notice(`更新失败：${e?.message ?? String(e)}`);
      }
    };

    window.setTimeout(() => {
      textInput?.inputEl?.focus();
      refresh();
    }, 0);
  }
}
