import { App, ButtonComponent, Modal, Notice, Setting, TextAreaComponent } from "obsidian";

import type RSLattePlugin from "../../main";
import { getDefaultTaskBusinessCategoryName } from "../../taskRSLatte/task/taskBusinessCategory";
import { buildCaptureWorkEventUi, buildWorkEventTaskCreateUi } from "../../services/execution/buildExecutionWorkEvents";
import { EXECUTION_RECIPE } from "../../services/execution/executionOrchestrator";
import { writeTaskTodayCreate } from "../../services/execution/taskWriteFacade";
import { runExecutionFlowUi } from "../helpers/runExecutionFlowUi";

export type AddTaskModalFlowOpts = {
  initialText?: string;
  initialDue?: string;
  initialScheduled?: string;
  modalTitle?: string;
  onBackToTypeSelect?: () => void;
  /** 若提供：保存成功后调用，再关闭弹窗（用于日程结束并建任务等串联流程） */
  onCreated?: (res: { uid: string; diaryPath?: string }) => void | Promise<void>;
  skipDefaultNotice?: boolean;
  /** 来自 Capture 三合一：WorkEvent 记为 kind capture（含 ref.capture_op） */
  captureQuickRecordWorkEvent?: boolean;
};

export class AddTaskModal extends Modal {
  constructor(
    app: App,
    private plugin: RSLattePlugin,
    private flow?: AddTaskModalFlowOpts
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(this.flow?.modalTitle ?? "新增任务");

    let text = this.flow?.initialText ?? "";
    // 默认填入今天（用户可清空以表示不写入 📅）
    const today = (() => {
      try {
        // Obsidian 内置 moment（本地时区）
        // @ts-ignore
        const m = (window as any).moment?.();
        if (m?.format) return m.format("YYYY-MM-DD");
      } catch {
        // ignore
      }
      const d = new Date();
      const yyyy = String(d.getFullYear());
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}`;
    })();

    // due 必填：默认今天（flow.initialDue 优先）
    let due = /^\d{4}-\d{2}-\d{2}$/.test(String(this.flow?.initialDue ?? "").trim())
      ? String(this.flow?.initialDue ?? "").trim()
      : today;

    // scheduled 可选；不再使用 start（开始日期由「开始处理任务」时写入）
    let scheduled = /^\d{4}-\d{2}-\d{2}$/.test(String(this.flow?.initialScheduled ?? "").trim())
      ? String(this.flow?.initialScheduled ?? "").trim()
      : "";
    let estimateH = "";
    let complexity: "high" | "normal" | "light" = "normal";
    let repeatRule: "none" | "weekly" | "monthly" | "quarterly" | "yearly" = "none";
    let taskCategory = getDefaultTaskBusinessCategoryName(this.plugin.settings?.taskPanel);

    let textInput!: TextAreaComponent;
    let saveBtn!: ButtonComponent;
    /** 计划开始/结束日行内校验：标红 + 文案 */
    const dateRefs: { warnEl?: HTMLElement; dueEl?: HTMLInputElement; schedEl?: HTMLInputElement } = {};

    const isValidYmd = (s: string) => !s || /^\d{4}-\d{2}-\d{2}$/.test(s);

    const refresh = () => {
      const dueTrim = (due ?? "").trim();
      const schedTrim = (scheduled ?? "").trim();
      const dueOk = /^\d{4}-\d{2}-\d{2}$/.test(dueTrim);
      const scheduledOk = isValidYmd(schedTrim);
      const estOk = !estimateH || /^\d+(\.\d)?$/.test(String(estimateH).trim());
      const dateOrderBad = Boolean(schedTrim && dueOk && schedTrim > dueTrim);

      const ok =
        (text ?? "").trim().length > 0 && dueOk && scheduledOk && estOk && !dateOrderBad;
      saveBtn?.setDisabled(!ok);
      textInput?.inputEl?.classList.toggle("is-invalid", !(text ?? "").trim());

      const w = dateRefs.warnEl;
      if (w) {
        w.textContent = dateOrderBad ? "计划开始日不能晚于计划结束日，请更正。" : "";
        w.style.display = dateOrderBad ? "block" : "none";
      }
      dateRefs.dueEl?.classList.toggle("is-invalid", !dueOk || dateOrderBad);
      dateRefs.schedEl?.classList.toggle("is-invalid", !scheduledOk || dateOrderBad);
      return ok;
    };

    const descSetting = new Setting(contentEl)
      .setName("任务描述*")
      .setDesc("")
      .addTextArea((t) => {
        textInput = t;
        t.setPlaceholder("例如：买牛奶");

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
            // auto height (capped)
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
      .setDesc("任务用于需要完成的事项；纯提醒类事项建议使用提醒模块。")
      .addText((t) => {
        // 用浏览器原生日期选择器
        t.inputEl.type = "date";
        t.setValue(due);
        dateRefs.dueEl = t.inputEl;
        t.onChange((v) => {
          due = (v ?? "").trim();
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
      .setDesc("")
      .addText((t) => {
        t.inputEl.type = "date";
        t.setValue(scheduled);
        dateRefs.schedEl = t.inputEl;
        t.onChange((v) => {
          scheduled = (v ?? "").trim();
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

    new Setting(contentEl)
      .setName("工时评估 h")
      .setDesc("非必填，单位：小时，可小数")
      .addText((t) => {
        t.inputEl.type = "number";
        t.inputEl.placeholder = "例如 2 或 1.5";
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

    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });
    if (this.flow?.onBackToTypeSelect) {
      new ButtonComponent(btnRow)
        .setButtonText("← 返回类型选择")
        .onClick(() => {
          this.close();
          try {
            this.flow?.onBackToTypeSelect?.();
          } catch {
            // ignore
          }
        });
    }
    saveBtn = new ButtonComponent(btnRow).setButtonText("保存").setCta().onClick(() => void doSave());
    new ButtonComponent(btnRow).setButtonText("关闭").onClick(() => this.close());

    const doSave = async () => {
      if (!refresh()) return;

      const dueTrim = (due ?? "").trim();
      const schedTrim = (scheduled ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dueTrim)) {
        new Notice("计划结束日为必填，且格式必须为 YYYY-MM-DD");
        return;
      }
      if (schedTrim && schedTrim > dueTrim) {
        new Notice("计划开始日不能晚于计划结束日，请更正");
        return;
      }

      try {
        const est = (estimateH ?? "").trim();
        const createOpts: any = {
          estimate_h: est ? Number(est) : undefined,
          complexity: complexity !== "normal" ? complexity : undefined,
          repeatRule: repeatRule !== "none" ? repeatRule : undefined,
          task_category: taskCategory,
        };
        const fr = await writeTaskTodayCreate(
          this.plugin.taskRSLatte,
          text,
          dueTrim,
          "",
          (scheduled ?? "").trim(),
          createOpts
        );
        if (!fr) return;
        const recordDate = this.plugin.getTodayKey().slice(0, 10);
        const textShort = text.length > 50 ? text.slice(0, 50) + "…" : text;
        await runExecutionFlowUi(this.plugin, EXECUTION_RECIPE.tripleSaveTask, {
          facadeResult: { kind: "task", uid: fr.uid, diaryPath: fr.diaryPath },
          workEvent: this.flow?.captureQuickRecordWorkEvent
            ? buildCaptureWorkEventUi({
                action: "create",
                summary: `🗃️ 快速记录→任务 ${textShort}`,
                ref: {
                  capture_op: "quickadd_task",
                  task_uid: fr.uid,
                  due: dueTrim,
                  record_date: recordDate,
                  ...(schedTrim ? { scheduled: schedTrim } : {}),
                },
              })
            : buildWorkEventTaskCreateUi({
                uid: fr.uid,
                text,
                due: dueTrim,
                ...(schedTrim ? { scheduled: schedTrim } : {}),
                recordDate,
              }),
          sync: (this.plugin.isTaskDbSyncEnabledV2?.() ?? (this.plugin.settings.taskPanel.enableDbSync !== false)),
          noticeOnError: true,
        }, { actionLabel: "创建任务" });
        if (this.flow?.onCreated) {
          await this.flow.onCreated({ uid: fr.uid, diaryPath: fr.diaryPath });
          this.close();
          return;
        }
        if (!this.flow?.skipDefaultNotice) new Notice("已写入今日日记：任务");
        this.close();
      } catch (e: any) {
        new Notice(`写入失败：${e?.message ?? String(e)}`);
      }
    };

    window.setTimeout(() => {
      if ((text ?? "").trim() && textInput) {
        textInput.setValue(text);
        text = (textInput.getValue() ?? "").replace(/[\r\n]+/g, " ");
      }
      textInput?.inputEl?.focus();
      refresh();
    }, 0);
  }
}
