import { ButtonComponent, Modal, Notice, Setting, TextAreaComponent, TextComponent, moment } from "obsidian";
import type RSLattePlugin from "../../main";
import { buildCaptureWorkEventUi, buildWorkEventScheduleCreateUi } from "../../services/execution/buildExecutionWorkEvents";
import { EXECUTION_RECIPE } from "../../services/execution/executionOrchestrator";
import { writeScheduleCreate } from "../../services/execution/scheduleWriteFacade";
import { runExecutionFlowUi } from "../helpers/runExecutionFlowUi";
import { getDefaultScheduleCategoryId, mountScheduleCategoryDropdown } from "../../taskRSLatte/schedule/scheduleCategory";
import type { ScheduleCategory, ScheduleRepeatRule } from "../../types/scheduleTypes";

const momentFn = moment as any;

export type AddScheduleModalFlowOpts = {
  initialDesc?: string;
  initialDateYmd?: string;
  /** HH:mm，缺省为 09:00（有 flow 时） */
  initialStartTime?: string;
  initialDurationMin?: number;
  initialLinkedTaskUid?: string;
  modalTitle?: string;
  onBackToTypeSelect?: () => void;
  onCreated?: (res: { uid: string }) => void | Promise<void>;
  skipDefaultNotice?: boolean;
  /** 来自 Capture 三合一：WorkEvent 记为 kind capture */
  captureQuickRecordWorkEvent?: boolean;
};

export class AddScheduleModal extends Modal {
  constructor(app: any, private plugin: RSLattePlugin, private flow?: AddScheduleModalFlowOpts) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(this.flow?.modalTitle ?? "新增日程");

    const isYmd = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "").trim());
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

    const parseHourPart = (v: string): number | null => {
      const s = String(v ?? "").trim();
      if (!s || !/^\d{1,2}$/.test(s)) return null;
      const hh = Number(s);
      if (!Number.isFinite(hh) || hh < 0 || hh > 23) return null;
      return hh;
    };
    const parseMinutePart = (v: string): number | null => {
      const s = String(v ?? "").trim();
      if (!s || !/^\d{1,2}$/.test(s)) return null;
      const mm = Number(s);
      if (!Number.isFinite(mm) || mm < 0 || mm > 59) return null;
      return mm;
    };
    const composeStartHm = (hourStr: string, minStr: string): string | null => {
      const h = parseHourPart(hourStr);
      const m = parseMinutePart(minStr);
      if (h === null || m === null) return null;
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    };
    const sanitizeDigits = (v: string, maxLen: number) => String(v ?? "").replace(/\D/g, "").slice(0, maxLen);

    let desc = String(this.flow?.initialDesc ?? "").trim();
    const idY = String(this.flow?.initialDateYmd ?? "").trim();
    let dateYmd = /^\d{4}-\d{2}-\d{2}$/.test(idY) ? idY : "";
    const rawStart = String(this.flow?.initialStartTime ?? "").trim();
    const initialHmNorm = this.flow ? (parseHm(rawStart) ?? parseHm("09:00") ?? "09:00") : "";
    let startHourStr = "";
    let startMinStr = "";
    if (initialHmNorm) {
      const p = initialHmNorm.split(":");
      if (p.length === 2) {
        startHourStr = p[0] ?? "";
        startMinStr = p[1] ?? "";
      }
    }
    let durationMin = Number.isFinite(Number(this.flow?.initialDurationMin))
      ? Math.max(5, Math.min(24 * 60, Math.floor(Number(this.flow?.initialDurationMin))))
      : 60;
    let repeatRule: ScheduleRepeatRule = "none";
    const scheduleMod = (this.plugin.settings as any)?.scheduleModule;
    let category: ScheduleCategory = getDefaultScheduleCategoryId(scheduleMod);

    let descInput!: TextAreaComponent;
    let dateInput!: TextComponent;
    let startHourInput!: HTMLInputElement;
    let startMinInput!: HTMLInputElement;
    let durationInput!: TextComponent;
    let saveBtn!: ButtonComponent;

    const refresh = () => {
      const okDesc = !!String(desc ?? "").trim();
      const okDate = isYmd(dateYmd);
      const okStart = composeStartHm(startHourStr, startMinStr) != null;
      const n = Number(durationMin);
      const okDur = Number.isFinite(n) && n >= 5 && n <= 24 * 60;
      saveBtn?.setDisabled(!(okDesc && okDate && okStart && okDur));
      descInput?.inputEl?.classList.toggle("is-invalid", !okDesc);
      dateInput?.inputEl?.classList.toggle("is-invalid", !okDate);
      startHourInput?.classList.toggle("is-invalid", !okStart);
      startMinInput?.classList.toggle("is-invalid", !okStart);
      durationInput?.inputEl?.classList.toggle("is-invalid", !okDur);
      return okDesc && okDate && okStart && okDur;
    };

    new Setting(contentEl)
      .setName("日程描述*")
      .addTextArea((t) => {
        descInput = t;
        t.setPlaceholder("例如：和[[C_xxx|张三]]确认需求细节");
        t.inputEl.rows = 3;
        t.onChange((v) => {
          desc = String(v ?? "").replace(/\r?\n+/g, " ");
          if (desc !== (v ?? "")) t.setValue(desc);
          refresh();
        });
      });

    const descControl = (contentEl.lastElementChild as HTMLElement | null)?.querySelector(".setting-item-control") as HTMLElement | null;
    if (descControl) {
      const row = descControl.createDiv({ cls: "rslatte-inline-insert-row" });
      row.style.display = "flex";
      row.style.justifyContent = "flex-end";
      row.style.marginTop = "6px";
      new ButtonComponent(row)
        .setButtonText("🪪 插入联系人")
        .onClick(() => {
          void this.plugin.openContactReferencePicker((ref) => {
            const cur = descInput?.getValue?.() ?? "";
            const sep = cur && !/\s$/.test(cur) ? " " : "";
            const next = `${cur}${sep}${ref} `;
            descInput?.setValue?.(next);
            desc = next;
            refresh();
            try {
              const el = descInput?.inputEl;
              if (el) el.setSelectionRange(next.length, next.length);
            } catch {
              // ignore
            }
          });
        });
    }

    new Setting(contentEl)
      .setName("日程分类*")
      .addDropdown((d) => {
        category = mountScheduleCategoryDropdown(d, scheduleMod, category, (id) => {
          category = id as ScheduleCategory;
        });
      });

    new Setting(contentEl)
      .setName("日期*")
      .addText((t) => {
        dateInput = t;
        t.inputEl.type = "date";
        if (dateYmd) t.setValue(dateYmd);
        t.onChange((v) => {
          dateYmd = String(v ?? "").trim();
          refresh();
        });
      });

    const startTimeSetting = new Setting(contentEl).setName("开始时间*");
    startTimeSetting.settingEl.classList.add("rslatte-setting-start-time-hm");
    startTimeSetting.controlEl.empty();
    const startTimeRow = startTimeSetting.controlEl.createDiv({ cls: "rslatte-schedule-start-time-row" });
    startHourInput = startTimeRow.createEl("input", {
      type: "text",
      cls: "rslatte-schedule-start-time-part",
      attr: { inputmode: "numeric", maxlength: "2", "aria-label": "开始时间-时" },
    });
    startHourInput.placeholder = "时";
    startHourInput.value = startHourStr;
    startTimeRow.createSpan({ cls: "rslatte-schedule-start-time-sep", text: ":" });
    startMinInput = startTimeRow.createEl("input", {
      type: "text",
      cls: "rslatte-schedule-start-time-part",
      attr: { inputmode: "numeric", maxlength: "2", "aria-label": "开始时间-分" },
    });
    startMinInput.placeholder = "分";
    startMinInput.value = startMinStr;
    const onStartPartInput = (which: "h" | "m", el: HTMLInputElement) => {
      const next = sanitizeDigits(el.value, 2);
      el.value = next;
      if (which === "h") startHourStr = next;
      else startMinStr = next;
      refresh();
      if (which === "h" && next.length >= 2) startMinInput.focus();
    };
    startHourInput.addEventListener("input", () => onStartPartInput("h", startHourInput));
    startMinInput.addEventListener("input", () => onStartPartInput("m", startMinInput));

    new Setting(contentEl)
      .setName("预约时长（分钟）*")
      .addText((t) => {
        durationInput = t;
        t.setPlaceholder("60");
        t.setValue(String(durationMin));
        t.onChange((v) => {
          const n = Math.floor(Number(v));
          durationMin = Number.isFinite(n) ? n : 60;
          refresh();
        });
      });

    new Setting(contentEl)
      .setName("重复规则")
      .addDropdown((d) => {
        d.addOption("none", "不重复");
        d.addOption("weekly", "每周");
        d.addOption("monthly", "每月");
        d.addOption("quarterly", "每季");
        d.addOption("yearly", "每年");
        d.setValue(repeatRule);
        d.onChange((v) => {
          const vv = String(v ?? "none").trim().toLowerCase();
          repeatRule = (vv === "weekly" || vv === "monthly" || vv === "quarterly" || vv === "yearly") ? (vv as ScheduleRepeatRule) : "none";
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
    saveBtn = new ButtonComponent(btnRow).setButtonText("创建日程").setCta().onClick(() => void doSave());
    new ButtonComponent(btnRow).setButtonText("关闭").onClick(() => this.close());

    const doSave = async () => {
      if (!refresh()) return;
      try {
        const normStart = composeStartHm(startHourStr, startMinStr);
        if (!normStart) return;
        const uid = await writeScheduleCreate(this.plugin.taskRSLatte, {
          text: desc,
          scheduleDate: dateYmd,
          startTime: normStart,
          durationMin,
          category,
          repeatRule,
          ...(this.flow?.initialLinkedTaskUid ? { linkedTaskUid: String(this.flow.initialLinkedTaskUid).trim() } : {}),
        });
        if (!uid) {
          new Notice("创建日程失败：参数不完整");
          return;
        }
        const endM = momentFn(`${dateYmd} ${normStart}`, "YYYY-MM-DD HH:mm").add(durationMin, "minutes");
        const endTimeStr = endM.format("HH:mm");
        const lineText = `${normStart}-${endTimeStr} ${desc}`.trim();
        const descShort = desc.length > 50 ? desc.slice(0, 50) + "…" : desc;
        await runExecutionFlowUi(this.plugin, EXECUTION_RECIPE.tripleSaveSchedule, {
          facadeResult: { kind: "schedule", uid },
          workEvent: this.flow?.captureQuickRecordWorkEvent
            ? buildCaptureWorkEventUi({
                action: "create",
                summary: `🗃️ 快速记录→日程 ${descShort}`,
                ref: {
                  capture_op: "quickadd_schedule",
                  schedule_uid: uid,
                  schedule_date: dateYmd,
                  start_time: normStart,
                  end_time: endTimeStr,
                  duration_min: durationMin,
                  schedule_category: category,
                  repeat_rule: repeatRule,
                  ...(this.flow?.initialLinkedTaskUid ? { linked_task_uid: String(this.flow.initialLinkedTaskUid).trim() } : {}),
                },
              })
            : buildWorkEventScheduleCreateUi({
                uid,
                lineText,
                scheduleDate: dateYmd,
                repeatRule,
                scheduleCategory: category,
                startTime: normStart,
                endTime: endTimeStr,
                durationMin,
                ...(this.flow?.initialLinkedTaskUid ? { linkedTaskUid: String(this.flow.initialLinkedTaskUid).trim() } : {}),
              }),
          sync: false,
        }, { actionLabel: "创建日程" });
        if (this.flow?.onCreated) {
          await this.flow.onCreated({ uid });
          this.close();
          return;
        }
        if (!this.flow?.skipDefaultNotice) new Notice("日程已创建");
        this.close();
      } catch (e: any) {
        new Notice(`创建失败：${e?.message ?? String(e)}`);
      }
    };

    window.setTimeout(() => {
      if (desc && descInput) {
        descInput.setValue(desc);
        desc = String(descInput.getValue() ?? "").replace(/\r?\n+/g, " ");
      }
      refresh();
    }, 0);
    refresh();
  }
}

