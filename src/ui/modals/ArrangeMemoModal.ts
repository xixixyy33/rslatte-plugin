import {
  App,
  ButtonComponent,
  Modal,
  Notice,
  Setting,
  TextAreaComponent,
  moment,
} from "obsidian";

import type RSLattePlugin from "../../main";
import { buildWorkEventScheduleCreateUi, buildWorkEventTaskCreateUi } from "../../services/execution/buildExecutionWorkEvents";
import { EXECUTION_RECIPE } from "../../services/execution/executionOrchestrator";
import { writeScheduleCreate } from "../../services/execution/scheduleWriteFacade";
import { writeTaskTodayCreate } from "../../services/execution/taskWriteFacade";
import type { RSLatteIndexItem } from "../../taskRSLatte/types";
import { getDefaultTaskBusinessCategoryName, getTaskBusinessCategories } from "../../taskRSLatte/task/taskBusinessCategory";
import { getDefaultScheduleCategoryId, mountScheduleCategoryDropdown } from "../../taskRSLatte/schedule/scheduleCategory";
import type { ScheduleCategory, ScheduleRepeatRule } from "../../types/scheduleTypes";
import { runExecutionFlowUi } from "../helpers/runExecutionFlowUi";

const momentFn = moment as any;

export function defaultMemoDescriptionForArrange(m: RSLatteIndexItem): string {
  let t = String(m.text || m.raw || "").trim();
  if (t.startsWith("⭐ ")) t = t.slice(2).trim();
  return t;
}

export function defaultMemoDueYmd(m: RSLatteIndexItem, fallbackToday: string): string {
  const d = String(m.memoDate ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  return fallbackToday;
}

/**
 * 任务侧栏提醒卡片：安排 → 转任务 / 转日程；创建后回写提醒 meta 并置 `- [x]`（DONE，不触发周期下一条）。
 */
export class ArrangeMemoModal extends Modal {
  constructor(
    app: App,
    private plugin: RSLattePlugin,
    private memo: RSLatteIndexItem,
    private onDone?: () => void
  ) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText("安排提醒");
    this.renderChoose();
  }

  private renderChoose() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", {
      text: "将当前提醒转为任务或日程；提交成功后会在本提醒的 meta 中记录新条目 uid，并把本行标为已安排（- [x]）。",
      cls: "setting-item-description",
    });

    const row = contentEl.createDiv({ cls: "rslatte-modal-actions" });
    new ButtonComponent(row)
      .setButtonText("转为任务")
      .setCta()
      .onClick(() => this.renderTaskForm());
    new ButtonComponent(row).setButtonText("转为日程").setCta().onClick(() => this.renderScheduleForm());
    new ButtonComponent(row).setButtonText("关闭").onClick(() => this.close());
  }

  private renderTaskForm() {
    const { contentEl } = this;
    contentEl.empty();

    const today = this.plugin.getTodayKey().slice(0, 10);
    let text = defaultMemoDescriptionForArrange(this.memo);
    let due = defaultMemoDueYmd(this.memo, today);
    let scheduled = "";
    let estimateH = "";
    let complexity: "high" | "normal" | "light" = "normal";
    let repeatRule: "none" | "weekly" | "monthly" | "quarterly" | "yearly" = "none";
    let taskCategory = getDefaultTaskBusinessCategoryName(this.plugin.settings?.taskPanel);

    const isValidYmd = (s: string) => !s || /^\d{4}-\d{2}-\d{2}$/.test(s);

    const backRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });
    new ButtonComponent(backRow).setButtonText("← 返回").onClick(() => this.renderChoose());

    let textInput!: TextAreaComponent;
    let saveBtn!: ButtonComponent;

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
      .setDesc("默认同提醒正文，可改。")
      .addTextArea((t) => {
        textInput = t;
        t.setPlaceholder("例如：买牛奶");
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
              try {
                ta.setSelectionRange(Math.max(0, pos - 1), Math.max(0, pos - 1));
              } catch {
                /* ignore */
              }
            }
            text = single;
            ta.style.height = "auto";
            ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
          } finally {
            inSanitize = false;
          }
          refresh();
        };
        t.setValue(text);
        t.onChange(() => sanitizeAndResize());
        ta.addEventListener("input", () => sanitizeAndResize());
      });

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
              try {
                ta.setSelectionRange(next.length, next.length);
              } catch {
                /* ignore */
              }
            }
          } catch (e) {
            console.warn("[RSLatte][ArrangeMemo][insertContact] failed", e);
            new Notice("插入联系人失败");
          }
        });
      });

    new Setting(contentEl)
      .setName("计划结束日*")
      .setDesc("任务用于需要完成的事项；纯提醒类事项建议使用提醒模块。")
      .addText((t) => {
        t.inputEl.type = "date";
        t.setValue(due);
        t.onChange((v) => {
          due = (v ?? "").trim();
          t.inputEl.classList.toggle("is-invalid", !/^\d{4}-\d{2}-\d{2}$/.test(due));
          refresh();
        });
      });

    new Setting(contentEl)
      .setName("计划开始日")
      .setDesc("")
      .addText((t) => {
        t.inputEl.type = "date";
        t.setValue("");
        t.onChange((v) => {
          scheduled = (v ?? "").trim();
          t.inputEl.classList.toggle("is-invalid", !isValidYmd(scheduled));
          refresh();
        });
      });

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

    new Setting(contentEl)
      .setName("任务分类")
      .setDesc("与任务管理设置中的分类列表一致；写入任务 meta。")
      .addDropdown((d) => {
        const cats = getTaskBusinessCategories(this.plugin.settings?.taskPanel);
        for (const c of cats) d.addOption(c, c);
        d.setValue(cats.includes(taskCategory) ? taskCategory : cats[0]);
        d.onChange((v) => {
          taskCategory = v;
        });
      });

    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });
    saveBtn = new ButtonComponent(btnRow)
      .setButtonText("创建任务并标记本提醒")
      .setCta()
      .onClick(() =>
        void (async () => {
          if (!refresh()) return;
          const descTrim = (textInput?.getValue?.() ?? text ?? "").trim();
          const dueTrim = due.trim();
          if (!descTrim) {
            new Notice("任务描述不能为空");
            return;
          }
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dueTrim)) {
            new Notice("计划结束日为必填，且格式必须为 YYYY-MM-DD");
            return;
          }
          const schedTrim = scheduled.trim();
          if (schedTrim && !/^\d{4}-\d{2}-\d{2}$/.test(schedTrim)) {
            new Notice("计划开始日格式必须为 YYYY-MM-DD");
            return;
          }
          try {
            const est = (estimateH ?? "").trim();
            const createOpts: Record<string, unknown> = {
              estimate_h: est ? Number(est) : undefined,
              complexity: complexity !== "normal" ? complexity : undefined,
              repeatRule: repeatRule !== "none" ? repeatRule : undefined,
              task_category: taskCategory,
            };
            const fr = await writeTaskTodayCreate(
              this.plugin.taskRSLatte,
              descTrim,
              dueTrim,
              "",
              schedTrim,
              createOpts as any
            );
            if (!fr) {
              new Notice("创建任务失败");
              return;
            }
            const recordDate = this.plugin.getTodayKey().slice(0, 10);
            await runExecutionFlowUi(this.plugin, EXECUTION_RECIPE.tripleSaveTask, {
              facadeResult: { kind: "task", uid: fr.uid, diaryPath: fr.diaryPath },
              sourceRef: {
                itemType: "memo",
                uid: String((this.memo as any)?.uid ?? ""),
                filePath: String(this.memo.filePath ?? ""),
                lineNo: Number(this.memo.lineNo ?? -1),
              },
              clientOpId: `arrange-memo-to-task:${String((this.memo as any)?.uid ?? "")}:${String(fr.uid ?? "")}`,
              workEvent: buildWorkEventTaskCreateUi({
                uid: fr.uid,
                text: descTrim,
                due: dueTrim,
                ...(schedTrim ? { scheduled: schedTrim } : {}),
                recordDate,
              }),
              sync: (this.plugin.isTaskDbSyncEnabledV2?.() ?? (this.plugin.settings.taskPanel.enableDbSync !== false)),
              noticeOnError: true,
            }, { actionLabel: "提醒转任务" });
            await this.plugin.taskRSLatte.markMemoAsArrangedAfterDerivation(this.memo as any, {
              kind: "task",
              targetUid: fr.uid,
            });
            const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "memo", "manual_refresh");
            if (!r.ok) console.warn("[ArrangeMemo] memo refresh after arrange", r.error?.message);
            new Notice("已创建任务并标记本提醒为已安排");
            this.onDone?.();
            this.close();
          } catch (e: any) {
            new Notice(`失败：${e?.message ?? String(e)}`);
          }
        })()
      );
    window.setTimeout(() => {
      textInput?.inputEl?.focus();
      refresh();
    }, 0);
  }

  private renderScheduleForm() {
    const { contentEl } = this;
    contentEl.empty();

    const today = this.plugin.getTodayKey().slice(0, 10);
    const scheduleMod = (this.plugin.settings as any)?.scheduleModule;
    let desc = defaultMemoDescriptionForArrange(this.memo);
    let dateYmd = defaultMemoDueYmd(this.memo, today);
    let startTime = "";
    let durationMin = 60;
    let category: ScheduleCategory = getDefaultScheduleCategoryId(scheduleMod);
    let repeatRule: ScheduleRepeatRule = "none";

    const parseHm = (v: string): string | null => {
      const s = String(v ?? "").trim();
      const m = s.match(/^(\d{1,2}):(\d{1,2})$/);
      if (!m) return null;
      const hh = Number(m[1]);
      const mm = Number(m[2]);
      if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
      if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
      return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    };

    const backRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });
    new ButtonComponent(backRow).setButtonText("← 返回").onClick(() => this.renderChoose());

    let descTa!: TextAreaComponent;
    new Setting(contentEl)
      .setName("日程描述")
      .setDesc("默认同提醒正文，可改。")
      .addTextArea((t) => {
        descTa = t;
        t.inputEl.rows = 3;
        t.setValue(desc);
        t.onChange((v) => {
          desc = String(v ?? "").replace(/\r?\n+/g, " ");
        });
      });

    new Setting(contentEl)
      .setName("日程日期*")
      .setDesc("")
      .addText((t) => {
        t.inputEl.type = "date";
        t.setValue(dateYmd);
        t.onChange((v) => {
          dateYmd = (v ?? "").trim();
          t.inputEl.classList.toggle("is-invalid", !/^\d{4}-\d{2}-\d{2}$/.test(dateYmd));
        });
      });

    new Setting(contentEl)
      .setName("开始时间 *")
      .setDesc("HH:mm")
      .addText((t) => {
        t.setValue(startTime);
        t.onChange((v) => {
          startTime = (v ?? "").trim();
        });
      });

    new Setting(contentEl)
      .setName("时长（分钟）*")
      .addText((t) => {
        t.inputEl.type = "number";
        t.setValue(String(durationMin));
        t.onChange((v) => {
          durationMin = Math.max(5, Math.min(24 * 60, Math.floor(Number(v) || 60)));
        });
      });

    new Setting(contentEl)
      .setName("类型")
      .addDropdown((d) => {
        category = mountScheduleCategoryDropdown(d, scheduleMod, category, (id) => {
          category = id as ScheduleCategory;
        });
      });

    new Setting(contentEl)
      .setName("重复")
      .addDropdown((d) => {
        d.addOption("none", "不重复");
        d.addOption("weekly", "每周");
        d.addOption("monthly", "每月");
        d.addOption("quarterly", "每季");
        d.addOption("yearly", "每年");
        d.setValue(repeatRule);
        d.onChange((v) => {
          repeatRule = (v as ScheduleRepeatRule) || "none";
        });
      });

    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });
    new ButtonComponent(btnRow)
      .setButtonText("创建日程并标记本提醒")
      .setCta()
      .onClick(() =>
        void (async () => {
          const text = (descTa?.getValue?.() ?? desc ?? "").trim().replace(/\r?\n+/g, " ");
          const normStart = parseHm(startTime);
          if (!text) {
            new Notice("日程描述不能为空");
            return;
          }
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) {
            new Notice("日程日期须为 YYYY-MM-DD");
            return;
          }
          if (!normStart) {
            new Notice("开始时间须为 HH:mm");
            return;
          }
          try {
            const uid = await writeScheduleCreate(this.plugin.taskRSLatte, {
              text,
              scheduleDate: dateYmd,
              startTime: normStart,
              durationMin,
              category,
              repeatRule,
            });
            if (!uid) {
              new Notice("创建日程失败：参数不完整");
              return;
            }
            const endM = momentFn(`${dateYmd} ${normStart}`, "YYYY-MM-DD HH:mm").add(durationMin, "minutes");
            const endTimeStr = endM.format("HH:mm");
            const lineText = `${normStart}-${endTimeStr} ${text}`.trim();
            await runExecutionFlowUi(this.plugin, EXECUTION_RECIPE.tripleSaveSchedule, {
              facadeResult: { kind: "schedule", uid },
              sourceRef: {
                itemType: "memo",
                uid: String((this.memo as any)?.uid ?? ""),
                filePath: String(this.memo.filePath ?? ""),
                lineNo: Number(this.memo.lineNo ?? -1),
              },
              clientOpId: `arrange-memo-to-schedule:${String((this.memo as any)?.uid ?? "")}:${String(uid ?? "")}`,
              workEvent: buildWorkEventScheduleCreateUi({
                uid,
                lineText,
                scheduleDate: dateYmd,
                repeatRule,
                scheduleCategory: category,
                startTime: normStart,
                endTime: endTimeStr,
                durationMin,
              }),
              sync: false,
            }, { actionLabel: "提醒转日程" });
            await this.plugin.taskRSLatte.markMemoAsArrangedAfterDerivation(this.memo as any, {
              kind: "schedule",
              targetUid: uid,
            });
            const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "memo", "manual_refresh");
            if (!r.ok) console.warn("[ArrangeMemo] memo refresh after arrange", r.error?.message);
            new Notice("已创建日程并标记本提醒为已安排");
            this.onDone?.();
            this.close();
          } catch (e: any) {
            new Notice(`失败：${e?.message ?? String(e)}`);
          }
        })()
      );
  }
}
