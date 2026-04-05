import { ButtonComponent, Modal, Notice, Setting, TextAreaComponent, TextComponent } from "obsidian";
import type RSLattePlugin from "../../main";
import type { RSLatteIndexItem } from "../../taskRSLatte/types";
import { getDefaultScheduleCategoryId, mountScheduleCategoryDropdown } from "../../taskRSLatte/schedule/scheduleCategory";
import type { ScheduleCategory, ScheduleRepeatRule } from "../../types/scheduleTypes";
import { writeScheduleUpdateBasicInfo } from "../../services/execution/scheduleWriteFacade";
import { EXECUTION_RECIPE } from "../../services/execution/executionOrchestrator";
import { buildWorkEventUiAction } from "../../services/execution/buildExecutionWorkEvents";
import { runExecutionFlowUi } from "../helpers/runExecutionFlowUi";
import { normalizeRepeatRuleToken } from "../../taskRSLatte/utils";

/** 从索引/行文本中取出日程描述（去掉行首 HH:mm-HH:mm 段） */
function extractScheduleDescription(raw: string): string {
  const t = String(raw ?? "").trim();
  const re = /^(\d{1,2}:\d{2}-\d{1,2}:\d{2})\s+([\s\S]*)$/;
  const m = t.match(re);
  if (m) return String(m[2] ?? "").trim();
  return t;
}

export class EditScheduleModal extends Modal {
  constructor(app: any, private plugin: RSLattePlugin, private item: RSLatteIndexItem) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("修改日程");

    const ex = ((this.item as any)?.extra ?? {}) as Record<string, string>;
    const scheduleMod = (this.plugin.settings as any)?.scheduleModule;

    let desc = extractScheduleDescription(String(this.item.text ?? this.item.raw ?? ""));
    let dateYmd = String(ex.schedule_date ?? (this.item as any).memoDate ?? "").trim();
    let startTime = String(ex.start_time ?? "").trim();
    let durationMin = Math.max(5, Math.min(24 * 60, Math.floor(Number(ex.duration_min ?? 60))));
    let repeatRule: ScheduleRepeatRule = "none";
    {
      const rrNorm = normalizeRepeatRuleToken(String((this.item as any).repeatRule ?? "none").trim().toLowerCase());
      if (["none", "weekly", "monthly", "quarterly", "yearly"].includes(rrNorm)) repeatRule = rrNorm as ScheduleRepeatRule;
    }

    let category: ScheduleCategory =
      String(ex.schedule_category ?? "").trim() || getDefaultScheduleCategoryId(scheduleMod);

    let descInput!: TextAreaComponent;
    let dateInput!: TextComponent;
    let startInput!: TextComponent;
    let durationInput!: TextComponent;
    let saveBtn!: ButtonComponent;

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

    const refresh = () => {
      const okDesc = !!String(desc ?? "").trim();
      const okDate = isYmd(dateYmd);
      const okStart = parseHm(startTime) != null;
      const n = Number(durationMin);
      const okDur = Number.isFinite(n) && n >= 5 && n <= 24 * 60;
      saveBtn?.setDisabled(!(okDesc && okDate && okStart && okDur));
      descInput?.inputEl?.classList.toggle("is-invalid", !okDesc);
      dateInput?.inputEl?.classList.toggle("is-invalid", !okDate);
      startInput?.inputEl?.classList.toggle("is-invalid", !okStart);
      durationInput?.inputEl?.classList.toggle("is-invalid", !okDur);
      return okDesc && okDate && okStart && okDur;
    };

    new Setting(contentEl)
      .setName("日程描述*")
      .addTextArea((t) => {
        descInput = t;
        t.setPlaceholder("例如：和[[C_xxx|张三]]确认需求细节");
        t.inputEl.rows = 3;
        t.setValue(desc);
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
        t.setValue(dateYmd);
        t.onChange((v) => {
          dateYmd = String(v ?? "").trim();
          refresh();
        });
      });

    new Setting(contentEl)
      .setName("开始时间*")
      .addText((t) => {
        startInput = t;
        t.setPlaceholder("11:30");
        t.setValue(startTime);
        t.onChange((v) => {
          startTime = String(v ?? "").trim();
          refresh();
        });
      });

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

    new Setting(contentEl).addButton((b) => {
      saveBtn = b;
      b.setButtonText("保存");
      b.setCta();
      b.onClick(() => void doSave());
    });

    const doSave = async () => {
      if (!refresh()) return;
      try {
        const normStart = parseHm(startTime);
        if (!normStart) return;
        await writeScheduleUpdateBasicInfo(this.plugin.taskRSLatte, this.item as any, {
          text: desc,
          scheduleDate: dateYmd,
          startTime: normStart,
          durationMin,
          category,
          repeatRule,
        }, { skipWorkEvent: true });
        await runExecutionFlowUi(this.plugin, EXECUTION_RECIPE.updateScheduleAndRefresh, {
          sync: false,
          workEvent: buildWorkEventUiAction({
            kind: "schedule",
            action: "update",
            summary: `✏️ 修改日程 ${desc || "未命名日程"}`,
            ref: { uid: (this.item as any).uid, file_path: this.item.filePath, line_no: this.item.lineNo, category: "schedule" },
            metrics: { memo_date: dateYmd, repeat_rule: repeatRule, schedule_category: category, duration_min: durationMin },
          }),
        }, { actionLabel: "更新日程" });
        new Notice("日程已更新");
        this.close();
      } catch (e: any) {
        new Notice(`更新失败：${e?.message ?? String(e)}`);
      }
    };

    refresh();
  }
}
