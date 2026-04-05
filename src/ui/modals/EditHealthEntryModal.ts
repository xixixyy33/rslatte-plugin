import { App, ButtonComponent, DropdownComponent, Modal, Notice, Setting } from "obsidian";
import moment from "moment";
import type RSLattePlugin from "../../main";
import { MenstruationRangePickerModal } from "./MenstruationRangePickerModal";
import {
  DIET_HEAT_LEVELS,
  dietHeatLevelDropdownLabel,
  formatBloodPressureStorage,
  formatGlucoseMonthStorage,
  formatMenstruationMonthStorage,
  healthMetricLabelZh,
  isDietHeatLevel,
  mapLegacyDietLevelToHeat,
  parseBloodPressureFormRaw,
  parseBloodPressureStorage,
  parseGlucoseMonthStorage,
  parseMenstruationMonthStorage,
  validateBloodPressurePair,
  validateGlucosePair,
} from "../../types/healthTypes";
import {
  buildHealthListItemLine,
  generateHealthEntryId,
  normalizeHealthCreatedAtMs,
  normalizeSleepStartHm,
  stringifyHealthMetaComment,
  type HealthJournalMetaPayload,
} from "../../services/health/healthJournalMeta";
import {
  firstDayKeyOfMonth,
  formatDayCardRef,
  formatMonthCardRef,
  inferCardRefFromItem,
  parseDayCardRef,
  parseMonthCardRef,
  weekCardFromAnyDateKey,
} from "../../services/health/healthCardRef";
import { toLocalOffsetIsoString } from "../../utils/localCalendarYmd";
import type { HealthRecordIndexItem } from "../../types/recordIndexTypes";
import {
  collectDayWeightSeries,
  collectWeekWaistSeries,
  getHealthTargetWaistCm,
  getHealthTargetWeightKg,
  loadMergedHealthIndexItems,
  renderHealthWaistTrendChart,
  renderHealthWeightTrendChart,
} from "../helpers/healthWeightTrendChart";

const momentFn = moment as any;

type HealthPeriod = "day" | "week" | "month";

type LoadedPrev = {
  entryId: string;
  valueStr: string;
  note?: string;
  sleepStartHm?: string;
  createdAtMs?: number;
};
type LoadedMap = Map<string, LoadedPrev>;

type EditCtx =
  | { ok: false; msg: string }
  | {
      ok: true;
      period: HealthPeriod;
      cardRef: string;
      cardDisplay: string;
      anchorDateKey: string;
    };

function clampDietNoteChars(s: string, max = 100): string {
  const arr = [...String(s ?? "")];
  return arr.length <= max ? arr.join("") : arr.slice(0, max).join("");
}

function canonicalMetricKey(metricKey: string): string {
  const k = String(metricKey ?? "").trim();
  if (k === "diet_level" || k === "diet_text") return "diet";
  return k;
}

function periodLabelZh(period: string): string {
  const p = String(period ?? "day").trim().toLowerCase();
  if (p === "week") return "周";
  if (p === "month") return "月";
  return "日";
}

function buildEditCtx(item: HealthRecordIndexItem): EditCtx {
  const period = (String(item.period ?? "day").trim().toLowerCase() || "day") as HealthPeriod;
  const cardRef =
    String(item.cardRef ?? "").trim() ||
    inferCardRefFromItem({
      recordDate: item.recordDate,
      period: item.period,
      cardRef: item.cardRef,
    });

  if (period === "day") {
    const dk = parseDayCardRef(cardRef) ?? String(item.recordDate ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) return { ok: false, msg: "无法解析日卡片日期" };
    const cr = formatDayCardRef(dk);
    return { ok: true, period: "day", cardRef: cr, cardDisplay: cr, anchorDateKey: dk };
  }
  if (period === "week") {
    const rd = String(item.recordDate ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rd)) return { ok: false, msg: "记录日期无效" };
    const { cardRef: cr, anchorDateKey } = weekCardFromAnyDateKey(rd);
    if (!cr || !anchorDateKey) return { ok: false, msg: "无法解析周卡片" };
    return { ok: true, period: "week", cardRef: cr, cardDisplay: cr, anchorDateKey };
  }
  const m = parseMonthCardRef(cardRef);
  if (!m) return { ok: false, msg: "无法解析月卡片" };
  const anchorDateKey = firstDayKeyOfMonth(m.y, m.m);
  const cr = formatMonthCardRef(m.y, m.m);
  return { ok: true, period: "month", cardRef: cr, cardDisplay: cr, anchorDateKey };
}

export type EditHealthEntryModalOptions = {
  item: HealthRecordIndexItem;
  onSuccess?: (anchorDateKey?: string) => void;
};

/**
 * 侧栏「修改」专用：单条记录编辑，不复用「健康卡片」多页签弹窗。
 */
export class EditHealthEntryModal extends Modal {
  private readonly ctx: EditCtx;
  private readonly canonical: string;
  private readonly originalMetricKey: string;
  /** 从 diet_level / diet_text 升级为 diet 时需先删旧行 */
  private legacyPrev: {
    metricKey: string;
    entryId: string;
    valueStr: string;
    note?: string;
    createdAtMs?: number;
  } | null = null;

  private fieldVals: Record<string, string> = {};
  private loadedByMetric: LoadedMap = new Map();
  private formMount!: HTMLDivElement;
  private saveBtn!: ButtonComponent;

  constructor(
    app: App,
    private plugin: RSLattePlugin,
    private opts: EditHealthEntryModalOptions,
  ) {
    super(app);
    this.ctx = buildEditCtx(opts.item);
    this.originalMetricKey = String(opts.item.metricKey ?? "").trim();
    this.canonical = canonicalMetricKey(this.originalMetricKey);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("rslatte-health-edit-entry-modal");

    if (!this.ctx.ok) {
      this.titleEl.setText("修改健康记录");
      contentEl.createDiv({ cls: "rslatte-muted", text: this.ctx.msg });
      new ButtonComponent(contentEl).setButtonText("关闭").onClick(() => this.close());
      return;
    }

    const entryId = String(this.opts.item.entryId ?? "").trim();
    const label = healthMetricLabelZh(this.canonical === "diet" ? "diet" : this.canonical);
    this.titleEl.setText(`修改 · ${periodLabelZh(this.ctx.period)} · ${label}`);

    const hint = contentEl.createDiv({ cls: "rslatte-muted rslatte-health-edit-hint" });
    hint.style.marginBottom = "10px";
    hint.style.fontSize = "12px";
    hint.setText(`卡片 ${this.ctx.cardDisplay} · 写入日记 ${this.ctx.anchorDateKey}${entryId ? "" : " · 缺少 entry_id，无法保存"}`);

    if (this.ctx.period === "day" && this.canonical === "weight") {
      const chartHost = contentEl.createDiv({ cls: "rslatte-health-weight-chart-modal" });
      try {
        const merged = await loadMergedHealthIndexItems(this.plugin);
        const pts = collectDayWeightSeries(merged);
        const targetKg = getHealthTargetWeightKg(this.plugin.settings);
        renderHealthWeightTrendChart(chartHost, pts, targetKg, { highlightYmd: this.ctx.anchorDateKey });
      } catch (e) {
        console.warn("[RSLatte] weight chart in edit modal:", e);
      }
    }

    if (this.ctx.period === "week" && this.canonical === "waist") {
      const chartHost = contentEl.createDiv({ cls: "rslatte-health-waist-chart-modal" });
      try {
        const merged = await loadMergedHealthIndexItems(this.plugin);
        const pts = collectWeekWaistSeries(merged);
        const targetCm = getHealthTargetWaistCm(this.plugin.settings);
        renderHealthWaistTrendChart(chartHost, pts, targetCm, { highlightYmd: this.ctx.anchorDateKey });
      } catch (e) {
        console.warn("[RSLatte] waist chart in edit modal:", e);
      }
    }

    this.hydrateFromItem(entryId);

    this.formMount = contentEl.createDiv({ cls: "rslatte-health-edit-form" });
    this.renderForm();

    const footer = contentEl.createDiv({ cls: "rslatte-modal-footer" });
    new ButtonComponent(footer).setButtonText("取消").onClick(() => this.close());
    this.saveBtn = new ButtonComponent(footer).setButtonText("保存").setCta();
    this.saveBtn.setDisabled(!entryId);
    this.saveBtn.onClick(() => void this.runSave());
  }

  private getWaterCupMl(): number {
    const s = (this.plugin.settings as any).healthPanel ?? {};
    return Math.max(50, Math.min(2000, Number(s.waterCupVolumeMl) || 500));
  }

  private hydrateFromItem(entryId: string): void {
    const it = this.opts.item;
    const canon = this.canonical;
    const imk = this.originalMetricKey;
    const itemCreatedStamp =
      normalizeHealthCreatedAtMs(it.createdAtMs) ?? normalizeHealthCreatedAtMs(it.tsMs);

    if (!this.ctx.ok) return;

    if (this.ctx.period === "day") {
      if (canon === "weight") this.fieldVals.weight = String(it.valueStr ?? "");
      if (canon === "water_cups") this.fieldVals.water_cups = String(it.valueStr ?? "");
      if (canon === "sleep_hours") {
        this.fieldVals.sleep_hours = String(it.valueStr ?? "");
        this.fieldVals.sleep_start_hm = String(it.sleepStartHm ?? "").trim();
      }
      if (canon === "diet") {
        if (imk === "diet") {
          const heat = String(it.valueStr ?? "").trim();
          this.fieldVals.diet_heat = isDietHeatLevel(heat) ? heat : "";
          this.fieldVals.diet_note = clampDietNoteChars(String(it.note ?? "").trim(), 100);
          if (entryId) {
            this.loadedByMetric.set("diet", {
              entryId,
              valueStr: heat,
              note: it.note ? String(it.note) : undefined,
              ...(itemCreatedStamp != null ? { createdAtMs: itemCreatedStamp } : {}),
            });
          }
        } else if (imk === "diet_level") {
          const h = mapLegacyDietLevelToHeat(String(it.valueStr ?? ""));
          this.fieldVals.diet_heat = isDietHeatLevel(h) ? h : "";
          this.fieldVals.diet_note = "";
          if (entryId) {
            this.legacyPrev = {
              metricKey: "diet_level",
              entryId,
              valueStr: String(it.valueStr ?? ""),
              note: it.note ? String(it.note) : undefined,
              ...(itemCreatedStamp != null ? { createdAtMs: itemCreatedStamp } : {}),
            };
          }
        } else if (imk === "diet_text") {
          this.fieldVals.diet_heat = "";
          const vs = String(it.valueStr ?? "").trim();
          const nt = String(it.note ?? "").trim();
          const txt = vs === "_" || vs === "." || vs === "—" ? nt : [vs, nt].filter(Boolean).join(" ").trim();
          this.fieldVals.diet_note = clampDietNoteChars(txt, 100);
          if (entryId) {
            this.legacyPrev = {
              metricKey: "diet_text",
              entryId,
              valueStr: String(it.valueStr ?? ""),
              note: it.note ? String(it.note) : undefined,
              ...(itemCreatedStamp != null ? { createdAtMs: itemCreatedStamp } : {}),
            };
          }
        }
      }
      if (entryId && ["weight", "water_cups", "sleep_hours"].includes(canon)) {
        const lp: LoadedPrev = {
          entryId,
          valueStr: String(it.valueStr ?? ""),
          note: it.note ? String(it.note) : undefined,
        };
        if (canon === "sleep_hours" && it.sleepStartHm) lp.sleepStartHm = String(it.sleepStartHm);
        if (itemCreatedStamp != null) lp.createdAtMs = itemCreatedStamp;
        this.loadedByMetric.set(canon, lp);
      }
    } else {
      if (canon === "menstruation_cramps") {
        const vs = String(it.valueStr ?? "").trim().toLowerCase();
        this.fieldVals[canon] =
          vs === "是" || vs === "yes" || vs === "y" || vs === "true" || vs === "1"
            ? "yes"
            : vs === "否" || vs === "no" || vs === "n" || vs === "false" || vs === "0"
              ? "no"
              : vs;
      } else if (this.ctx.period === "week" && canon === "bp") {
        const pr = parseBloodPressureStorage(String(it.valueStr ?? ""));
        if (pr) {
          this.fieldVals.bp_sys = String(pr.systolic);
          this.fieldVals.bp_dia = String(pr.diastolic);
        } else {
          this.fieldVals.bp_sys = "";
          this.fieldVals.bp_dia = "";
        }
      } else if (this.ctx.period === "month" && canon === "glucose") {
        const g = parseGlucoseMonthStorage(String(it.valueStr ?? ""));
        if (g) {
          this.fieldVals.monthGFast = g.fasting;
          this.fieldVals.monthG2h = g.post2h;
        } else {
          this.fieldVals.monthGFast = "";
          this.fieldVals.monthG2h = "";
        }
      } else if (this.ctx.period === "month" && canon === "menstruation") {
        const mn = parseMenstruationMonthStorage(String(it.valueStr ?? ""));
        if (mn) {
          this.fieldVals.monthMStart = mn.start;
          this.fieldVals.monthMEnd = mn.end;
          this.fieldVals.monthMFlow = String(mn.flow);
          this.fieldVals.monthMCramps = mn.crampsYes ? "yes" : "no";
        } else {
          this.fieldVals.monthMStart = "";
          this.fieldVals.monthMEnd = "";
          this.fieldVals.monthMFlow = "";
          this.fieldVals.monthMCramps = "no";
        }
      } else {
        this.fieldVals[canon] = String(it.valueStr ?? "");
      }
      if (entryId) {
        this.loadedByMetric.set(canon, {
          entryId,
          valueStr: String(it.valueStr ?? ""),
          note: it.note ? String(it.note) : undefined,
          ...(itemCreatedStamp != null ? { createdAtMs: itemCreatedStamp } : {}),
        });
      }
    }
  }

  private validateWeightInline(raw: string): string | null {
    const t = String(raw ?? "").trim();
    if (!t) return null;
    if (!/^\d*\.?\d*$/.test(t)) return "仅允许数字与小数点";
    const parts = t.split(".");
    if (parts.length > 2) return "格式不正确";
    if (parts[1] && parts[1].length > 2) return "最多两位小数";
    if (t.endsWith(".")) return null;
    const n = parseFloat(t);
    if (!Number.isFinite(n)) return null;
    if (n < 0 || n > 200) return "体重须在 0.00～200.00 kg";
    return null;
  }

  private validateWaistInline(raw: string): string | null {
    const t = String(raw ?? "").trim();
    if (!t) return null;
    if (!/^\d*\.?\d*$/.test(t)) return "仅允许数字与小数点";
    const parts = t.split(".");
    if (parts.length > 2) return "格式不正确";
    if (parts[1] && parts[1].length > 1) return "最多一位小数";
    if (t.endsWith(".")) return null;
    const n = parseFloat(t);
    if (!Number.isFinite(n)) return null;
    if (n < 0 || n > 200) return "腰围须在 0～200 cm";
    return null;
  }

  private validateRhrInline(raw: string): string | null {
    const t = String(raw ?? "").trim();
    if (!t) return null;
    if (!/^\d*$/.test(t)) return "仅允许数字";
    const n = parseInt(t, 10);
    if (!Number.isFinite(n)) return null;
    if (n < 30 || n > 220) return "静息心率建议在 30～220 次/分";
    return null;
  }

  private renderForm(): void {
    if (!this.ctx.ok) return;
    this.formMount.empty();
    const canon = this.canonical;
    const p = this.ctx.period;

    if (p === "day" && canon === "weight") {
      new Setting(this.formMount)
        .setName(healthMetricLabelZh("weight"))
        .setDesc("范围 0.00～200.00 kg，最多两位小数；超出时当场标红。")
        .addText((t) => {
          t.inputEl.type = "text";
          t.inputEl.inputMode = "decimal";
          t.inputEl.autocomplete = "off";
          t.inputEl.classList.add("rslatte-health-weight-input");
          t.setValue(this.fieldVals.weight ?? "");
          const item = t.inputEl.closest(".setting-item") as HTMLElement | null;
          if (!item) return;
          item.addClass("rslatte-health-weight-setting-item");
          const errEl = item.createDiv({ cls: "rslatte-health-inline-error" });
          const sync = () => {
            const val = t.inputEl.value;
            this.fieldVals.weight = val;
            const msg = this.validateWeightInline(val);
            errEl.setText(msg ?? "");
            errEl.toggleClass("is-visible", !!msg);
            t.inputEl.classList.toggle("rslatte-health-input--error", !!msg);
          };
          t.onChange(sync);
          t.inputEl.addEventListener("input", sync);
          sync();
        });
      return;
    }

    if (p === "day" && canon === "water_cups") {
      const maxCups = 8;
      const curCups = Math.max(0, Math.min(maxCups, parseInt(String(this.fieldVals.water_cups ?? "0"), 10) || 0));
      const mlPer = this.getWaterCupMl();
      const waterRow = this.formMount.createDiv({ cls: "setting-item" });
      const waterInfo = waterRow.createDiv({ cls: "setting-item-info" });
      waterInfo.createDiv({ cls: "setting-item-name", text: healthMetricLabelZh("water_cups") });
      waterInfo.createDiv({
        cls: "setting-item-description",
        text: `共 8 杯，点第 n 杯表示饮满前 n 杯；每杯 ${mlPer} ml。`,
      });
      const waterCtrl = waterRow.createDiv({ cls: "setting-item-control" });
      const waterBlock = waterCtrl.createDiv({ cls: "rslatte-health-water-cups-block" });
      const cupRow = waterBlock.createDiv({
        cls: `rslatte-health-water-cups-row rslatte-health-water-cups-row--compact${curCups === 0 ? " is-pristine" : ""}`,
      });
      for (let i = 1; i <= maxCups; i++) {
        const filled = i <= curCups;
        const btn = cupRow.createEl("button", {
          type: "button",
          cls: `rslatte-health-cup rslatte-health-cup--sm${filled ? " is-filled" : ""}`,
          attr: { "aria-label": `第 ${i} 杯` },
        });
        btn.createEl("span", { cls: "rslatte-health-cup-graphic", attr: { "aria-hidden": "true" } });
        btn.onclick = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          this.fieldVals.water_cups = String(i);
          this.renderForm();
        };
      }
      waterBlock.createDiv({
        cls: "rslatte-health-water-cups-summary",
        text: `已选 ${curCups} 杯 · 约 ${curCups * mlPer} ml`,
      });
      return;
    }

    if (p === "day" && canon === "sleep_hours") {
      const sleepN = (() => {
        const n = parseInt(String(this.fieldVals.sleep_hours ?? ""), 10);
        return Number.isFinite(n) ? Math.min(24, Math.max(0, n)) : 0;
      })();
      const sleepRow = this.formMount.createDiv({ cls: "setting-item rslatte-health-sleep-setting-item" });
      sleepRow.createDiv({ cls: "setting-item-info" }).createDiv({
        cls: "setting-item-name",
        text: `${healthMetricLabelZh("sleep_hours")} · 入睡`,
      });
      const sleepCtrl = sleepRow.createDiv({ cls: "setting-item-control rslatte-health-sleep-bedtime-row" });
      const sleepWrap = sleepCtrl.createDiv({ cls: "rslatte-health-sleep-row" });
      const range = sleepWrap.createEl("input", { type: "range", cls: "rslatte-health-sleep-slider" });
      range.min = "0";
      range.max = "24";
      range.step = "1";
      range.value = String(sleepN);
      const lab = sleepWrap.createSpan({ cls: "rslatte-health-sleep-val", text: `${range.value} 小时` });
      this.fieldVals.sleep_hours = range.value;
      range.addEventListener("input", () => {
        lab.setText(`${range.value} 小时`);
        this.fieldVals.sleep_hours = range.value;
      });
      const timeInp = sleepCtrl.createEl("input", {
        type: "time",
        cls: "rslatte-health-sleep-time-input",
        attr: { step: "60", title: "入睡时间（可选）" },
      });
      const curHm = normalizeSleepStartHm(String(this.fieldVals.sleep_start_hm ?? ""));
      timeInp.value = curHm ?? "";
      timeInp.addEventListener("change", () => {
        this.fieldVals.sleep_start_hm = String(timeInp.value ?? "").trim();
      });
      return;
    }

    if (p === "day" && canon === "diet") {
      const DIET_NONE = "__none__";
      const dietRow = this.formMount.createDiv({ cls: "setting-item rslatte-health-diet-setting-item" });
      dietRow.createDiv({ cls: "setting-item-info" }).createDiv({
        cls: "setting-item-name",
        text: `${healthMetricLabelZh("diet")} · 日记`,
      });
      const dietCtrl = dietRow.createDiv({ cls: "setting-item-control rslatte-health-diet-combo-row" });
      const ddHost = dietCtrl.createDiv({ cls: "rslatte-health-diet-combo-dd" });
      const dd = new DropdownComponent(ddHost);
      dd.addOption(DIET_NONE, "（未选）");
      for (const em of DIET_HEAT_LEVELS) {
        dd.addOption(em, dietHeatLevelDropdownLabel(em));
      }
      const curHeat = String(this.fieldVals.diet_heat ?? "").trim();
      dd.setValue((DIET_HEAT_LEVELS as readonly string[]).includes(curHeat) ? curHeat : DIET_NONE);
      dd.onChange((v) => {
        this.fieldVals.diet_heat = v === DIET_NONE ? "" : String(v ?? "");
      });
      const ta = dietCtrl.createEl("textarea", {
        cls: "rslatte-health-diet-note-inline",
        attr: { rows: "3", placeholder: "饮食日记（可选，≤100 字）" },
      });
      ta.value = String(this.fieldVals.diet_note ?? "");
      ta.addEventListener("input", () => {
        const next = clampDietNoteChars(String(ta.value ?? ""), 100);
        this.fieldVals.diet_note = next;
        if (ta.value !== next) ta.value = next;
      });
      return;
    }

    if (p === "week" && canon === "bp") {
      const bpRow = this.formMount.createDiv({ cls: "setting-item rslatte-health-bp-setting-item" });
      bpRow.createDiv({ cls: "setting-item-info" }).createDiv({
        cls: "setting-item-name",
        text: "血压（收缩压 / 舒张压，mmHg）",
      });
      const bpCtrl = bpRow.createDiv({ cls: "setting-item-control rslatte-health-bp-inline" });
      const sysInp = bpCtrl.createEl("input", {
        type: "text",
        cls: "rslatte-health-bp-input",
        attr: { inputmode: "numeric", placeholder: "收缩压", title: "收缩压 mmHg" },
      });
      sysInp.value = String(this.fieldVals.bp_sys ?? "");
      bpCtrl.createSpan({ cls: "rslatte-health-bp-sep", text: "/" });
      const diaInp = bpCtrl.createEl("input", {
        type: "text",
        cls: "rslatte-health-bp-input",
        attr: { inputmode: "numeric", placeholder: "舒张压", title: "舒张压 mmHg" },
      });
      diaInp.value = String(this.fieldVals.bp_dia ?? "");
      bpCtrl.createSpan({ cls: "rslatte-health-bp-unit", text: "mmHg" });
      const syncBp = () => {
        this.fieldVals.bp_sys = String(sysInp.value ?? "");
        this.fieldVals.bp_dia = String(diaInp.value ?? "");
      };
      sysInp.addEventListener("input", syncBp);
      diaInp.addEventListener("input", syncBp);
      return;
    }

    if (p === "month" && canon === "glucose") {
      const gRow = this.formMount.createDiv({ cls: "setting-item rslatte-health-month-glucose-item" });
      gRow.createDiv({ cls: "setting-item-info" }).createDiv({
        cls: "setting-item-name",
        text: "血糖（mmol/L）",
      });
      const gCtrl = gRow.createDiv({ cls: "setting-item-control rslatte-health-month-glucose-inline" });
      gCtrl.createSpan({ cls: "rslatte-health-month-glucose-lab", text: "空腹" });
      const gFast = gCtrl.createEl("input", {
        type: "text",
        cls: "rslatte-health-month-glucose-inp",
        attr: { inputmode: "decimal", placeholder: "如 5.1" },
      });
      gFast.value = String(this.fieldVals.monthGFast ?? "");
      gCtrl.createSpan({ cls: "rslatte-health-month-glucose-lab", text: "餐后2h" });
      const g2h = gCtrl.createEl("input", {
        type: "text",
        cls: "rslatte-health-month-glucose-inp",
        attr: { inputmode: "decimal", placeholder: "如 7.2" },
      });
      g2h.value = String(this.fieldVals.monthG2h ?? "");
      gCtrl.createSpan({ cls: "rslatte-health-month-glucose-unit", text: "mmol/L" });
      const syncG = () => {
        this.fieldVals.monthGFast = String(gFast.value ?? "");
        this.fieldVals.monthG2h = String(g2h.value ?? "");
      };
      gFast.addEventListener("input", syncG);
      g2h.addEventListener("input", syncG);
      return;
    }

    if (p === "month" && canon === "menstruation") {
      const mSection = this.formMount.createDiv({ cls: "rslatte-health-month-menses-section" });
      mSection.createDiv({ cls: "rslatte-health-month-menses-title", text: healthMetricLabelZh("menstruation") });
      const rangeRow = mSection.createDiv({ cls: "setting-item rslatte-health-month-menses-range" });
      const rangeInfo = rangeRow.createDiv({ cls: "setting-item-info" });
      rangeInfo.createDiv({ cls: "setting-item-name", text: "月经起止" });
      rangeInfo.createDiv({
        cls: "setting-item-description",
        text: "在同一月历中先点开始日，再点结束日；可翻页跨月。",
      });
      const rangeCtrl = rangeRow.createDiv({ cls: "setting-item-control rslatte-health-menses-range-inline" });
      const ms0 = String(this.fieldVals.monthMStart ?? "").trim();
      const me0 = String(this.fieldVals.monthMEnd ?? "").trim();
      rangeCtrl.createDiv({
        cls: "rslatte-health-menses-range-summary",
        text: ms0 && me0 ? `${ms0} ～ ${me0}` : "未选择起止日期",
      });
      new ButtonComponent(rangeCtrl).setButtonText("在日历中选起止").onClick(() => {
        new MenstruationRangePickerModal(this.app, {
          initialStart: ms0,
          initialEnd: me0,
          anchorHint: this.ctx.ok ? this.ctx.anchorDateKey : undefined,
          onConfirm: (a, b) => {
            this.fieldVals.monthMStart = a;
            this.fieldVals.monthMEnd = b;
            this.renderForm();
          },
        }).open();
      });
      const comboRow = mSection.createDiv({ cls: "setting-item rslatte-health-month-menses-combo" });
      comboRow.createDiv({ cls: "setting-item-info" }).createDiv({
        cls: "setting-item-name",
        text: "月经量",
      });
      const comboCtrl = comboRow.createDiv({ cls: "setting-item-control rslatte-health-menses-combo-row" });
      const flowWrap = comboCtrl.createDiv({ cls: "rslatte-health-menses-flow-wrap" });
      flowWrap.createSpan({ cls: "rslatte-health-menses-icon-lab", text: "🩸" });
      const curFlow = Math.max(0, Math.min(5, parseInt(String(this.fieldVals.monthMFlow ?? "0"), 10) || 0));
      const flowRow = flowWrap.createDiv({
        cls: `rslatte-health-menses-flow-row${curFlow ? "" : " is-pristine"}`,
      });
      for (let i = 1; i <= 5; i++) {
        const on = i <= curFlow;
        flowRow.createEl("button", {
          type: "button",
          cls: `rslatte-health-menses-drop${on ? " is-on" : ""}`,
          text: String(i),
          attr: { "aria-label": `月经量 ${i}` },
        }).onclick = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          this.fieldVals.monthMFlow = String(i);
          this.renderForm();
        };
      }
      const crWrap = comboCtrl.createDiv({ cls: "rslatte-health-menses-cramps-wrap" });
      crWrap.createSpan({ cls: "rslatte-health-menses-cramps-title", text: "痛经" });
      crWrap.createSpan({ cls: "rslatte-health-menses-icon-lab", text: "⚡" });
      const cramps = String(this.fieldVals.monthMCramps ?? "no").trim() === "yes";
      const crBtns = crWrap.createDiv({ cls: "rslatte-health-menses-cramps-btns" });
      const mkCr = (yes: boolean, label: string) => {
        crBtns.createEl("button", {
          type: "button",
          cls: `rslatte-health-menses-cramp-btn${cramps === yes ? " is-active" : ""}`,
          text: label,
        }).onclick = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          this.fieldVals.monthMCramps = yes ? "yes" : "no";
          this.renderForm();
        };
      };
      mkCr(false, "否");
      mkCr(true, "是⚡");
      return;
    }

    if (p === "week" || p === "month") {
      if (canon === "menstruation_cramps") {
        new Setting(this.formMount).setName(healthMetricLabelZh(canon)).addDropdown((dd) => {
          const NONE = "__none__";
          dd.addOption(NONE, "（未填）");
          dd.addOption("no", "否");
          dd.addOption("yes", "是");
          const cur = String(this.fieldVals[canon] ?? "").trim().toLowerCase();
          const norm =
            cur === "是" || cur === "yes" || cur === "y" || cur === "true" || cur === "1"
              ? "yes"
              : cur === "否" || cur === "no" || cur === "n" || cur === "false" || cur === "0"
                ? "no"
                : NONE;
          dd.setValue(norm);
          dd.onChange((v) => {
            this.fieldVals[canon] = v === "yes" ? "yes" : v === "no" ? "no" : "";
          });
        });
        return;
      }
      if (p === "week" && (canon === "waist" || canon === "rhr")) {
        const st = new Setting(this.formMount).setName(healthMetricLabelZh(canon));
        if (canon === "waist") st.setDesc("范围 0～200；超出时输入框标红。");
        if (canon === "rhr") st.setDesc("次/分，建议 30～220；超出时输入框标红。");
        st.addText((t) => {
          t.inputEl.type = "text";
          t.inputEl.autocomplete = "off";
          t.inputEl.classList.add("rslatte-health-metric-input");
          t.inputEl.inputMode = canon === "waist" ? "decimal" : "numeric";
          t.setValue(this.fieldVals[canon] ?? "");
          const item = t.inputEl.closest(".setting-item") as HTMLElement | null;
          if (!item) return;
          item.addClass("rslatte-health-week-metric-validate-item");
          const errEl = item.createDiv({ cls: "rslatte-health-inline-error" });
          const sync = () => {
            const val = t.inputEl.value;
            this.fieldVals[canon] = val;
            const msg = canon === "waist" ? this.validateWaistInline(val) : this.validateRhrInline(val);
            errEl.setText(msg ?? "");
            errEl.toggleClass("is-visible", !!msg);
            t.inputEl.classList.toggle("rslatte-health-input--error", !!msg);
          };
          t.onChange(sync);
          t.inputEl.addEventListener("input", sync);
          sync();
        });
        return;
      }
      const ph = (() => {
        if (canon.includes("menstruation") && canon.includes("start")) return "YYYY-MM-DD";
        if (canon.includes("menstruation") && canon.includes("end")) return "YYYY-MM-DD";
        if (canon === "menstruation_flow") return "1-5";
        return "";
      })();
      const st = new Setting(this.formMount).setName(healthMetricLabelZh(canon));
      st.addText((t) => {
        if (ph) t.setPlaceholder(ph);
        t.setValue(this.fieldVals[canon] ?? "");
        t.onChange((v) => {
          this.fieldVals[canon] = String(v ?? "");
        });
      });
    }
  }

  private isMenstruationMonthFormEmpty(): boolean {
    const s = String(this.fieldVals.monthMStart ?? "").trim();
    const e = String(this.fieldVals.monthMEnd ?? "").trim();
    const f = String(this.fieldVals.monthMFlow ?? "").trim();
    const c = String(this.fieldVals.monthMCramps ?? "no").trim();
    return !s && !e && !f && c !== "yes";
  }

  private validateMenstruationMonthForm(): string | null {
    const s = String(this.fieldVals.monthMStart ?? "").trim();
    const e = String(this.fieldVals.monthMEnd ?? "").trim();
    const f = String(this.fieldVals.monthMFlow ?? "").trim();
    if (!s || !e || !f) return "请填写月经开始日、结束日，并点选月经量（🩸 1～5）";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}$/.test(e)) return "日期格式须为 YYYY-MM-DD";
    if (s > e) return "开始日不能晚于结束日";
    const fn = parseInt(f, 10);
    if (!Number.isInteger(fn) || fn < 1 || fn > 5) return "月经量请点选 1～5 档";
    return null;
  }

  private buildMenstruationMonthRaw(): string {
    const s = String(this.fieldVals.monthMStart ?? "").trim();
    const e = String(this.fieldVals.monthMEnd ?? "").trim();
    const f = parseInt(String(this.fieldVals.monthMFlow ?? ""), 10);
    const crampsYes = String(this.fieldVals.monthMCramps ?? "no").trim() === "yes";
    return formatMenstruationMonthStorage(s, e, f, crampsYes);
  }

  private validateMetric(metricKey: string, raw: string): string | null {
    const v = String(raw ?? "").trim();
    if (!v) return null;
    if (metricKey === "weight") {
      if (!/^\d+(\.\d{1,2})?$/.test(v)) return "体重须为数字，最多两位小数";
      const n = parseFloat(v);
      if (!Number.isFinite(n) || n < 0 || n > 200) return "体重须在 0.00～200.00 kg";
      return null;
    }
    if (metricKey === "water_cups") {
      if (!/^\d+$/.test(v)) return "杯数须为 0 以上的整数";
      const n = parseInt(v, 10);
      if (n < 0 || n > 8) return "杯数须在 0～8";
      return null;
    }
    if (metricKey === "sleep_hours") {
      if (!/^\d+$/.test(v)) return "睡眠须为整数小时";
      const n = parseInt(v, 10);
      if (n < 0 || n > 24) return "睡眠须在 0～24 小时";
      return null;
    }
    if (metricKey === "menstruation_flow") {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 5) return "月经量须为 1-5 的整数";
      return null;
    }
    if (metricKey === "menstruation_start" || metricKey === "menstruation_end") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${healthMetricLabelZh(metricKey)} 须为 YYYY-MM-DD`;
    }
    if (metricKey === "waist") {
      if (!/^\d+(\.\d{1})?$/.test(v)) return "腰围须为数字，最多一位小数";
      const n = parseFloat(v);
      if (!Number.isFinite(n) || n < 0 || n > 200) return "腰围须在 0～200 cm";
      return null;
    }
    if (metricKey === "bp") {
      const pr = parseBloodPressureFormRaw(v);
      if (!pr) return "血压请填写「收缩压/舒张压」，例如 120/80";
      const pairErr = validateBloodPressurePair(pr.systolic, pr.diastolic);
      if (pairErr) return pairErr;
      return null;
    }
    if (metricKey === "rhr") {
      if (!/^\d+$/.test(v)) return "静息心率须为整数（次/分）";
      const n = parseInt(v, 10);
      if (n < 30 || n > 220) return "静息心率建议在 30～220 次/分";
      return null;
    }
    if (metricKey === "glucose") {
      const m = v.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
      if (!m) return "血糖须为「空腹/餐后2h」两个数字，如 5.1/7.2";
      const f = parseFloat(m[1]);
      const p = parseFloat(m[2]);
      return validateGlucosePair(f, p);
    }
    if (metricKey === "menstruation") {
      const p = parseMenstruationMonthStorage(v);
      if (!p) return "月经数据格式无效";
      if (p.start > p.end) return "开始日不能晚于结束日";
      return null;
    }
    if (["glucose_fasting", "glucose_postprandial"].includes(metricKey)) {
      if (!/^-?\d+(\.\d+)?$/.test(v)) return `${healthMetricLabelZh(metricKey)} 须为数字`;
    }
    return null;
  }

  private buildPersistParts(
    metricKey: string,
    raw: string,
  ): { valueToken: string; note?: string } | "empty" | "invalid" {
    const v = String(raw ?? "").trim();
    if (!v) return "empty";
    const err = this.validateMetric(metricKey, v);
    if (err) {
      if (!["weight", "waist", "rhr"].includes(metricKey)) new Notice(err);
      return "invalid";
    }
    if (metricKey === "menstruation_cramps") {
      return { valueToken: v === "yes" ? "yes" : "no" };
    }
    if (metricKey === "weight") {
      return { valueToken: parseFloat(v).toFixed(2) };
    }
    if (metricKey === "bp") {
      const pr = parseBloodPressureFormRaw(v)!;
      return { valueToken: formatBloodPressureStorage(pr.systolic, pr.diastolic) };
    }
    if (metricKey === "waist") {
      return { valueToken: String(parseFloat(v)) };
    }
    if (metricKey === "glucose") {
      const m = v.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
      if (!m) return "invalid";
      return { valueToken: formatGlucoseMonthStorage(parseFloat(m[1]), parseFloat(m[2])) };
    }
    if (metricKey === "menstruation") {
      return { valueToken: v };
    }
    return { valueToken: v };
  }

  private async persistOne(args: {
    anchorDateKey: string;
    cardRef: string;
    cardDisplay: string;
    period: string;
    metricKey: string;
    valueToken: string;
    note?: string;
    dietNoteForMeta?: string;
    prev?: LoadedPrev;
    timeHm: string;
    journal: (lines: string[]) => Promise<void>;
    replacer: (eid: string, pair: string[]) => Promise<boolean>;
    sleepStartHm?: string;
  }): Promise<boolean> {
    const main = buildHealthListItemLine({
      anchorDateKey: args.anchorDateKey,
      metricKey: args.metricKey,
      valueToken: args.valueToken,
      note: args.metricKey === "diet" ? undefined : args.note,
      timeHm: args.timeHm,
      isDelete: false,
      cardDisplay: args.cardDisplay,
      waterCupMl: this.getWaterCupMl(),
    });
    const entryId = args.prev?.entryId ?? generateHealthEntryId();
    const dietMeta = String(args.dietNoteForMeta ?? "").trim().slice(0, 100);
    const metaPayload: HealthJournalMetaPayload = {
      entry_id: entryId,
      metric_key: args.metricKey,
      period: args.period,
      card_ref: args.cardRef,
    };
    if (args.metricKey === "diet" && dietMeta) metaPayload.diet_note = dietMeta;
    if (args.metricKey === "water_cups") {
      const cups = parseInt(String(args.valueToken ?? "").trim(), 10);
      if (Number.isFinite(cups) && cups >= 0) metaPayload.cups = Math.min(30, Math.floor(cups));
    }
    const ssh = normalizeSleepStartHm(String(args.sleepStartHm ?? ""));
    if (args.metricKey === "sleep_hours" && ssh) metaPayload.sleep_start_hm = ssh;
    const now = Date.now();
    const stampMs = args.prev?.entryId
      ? normalizeHealthCreatedAtMs(args.prev.createdAtMs) ?? now
      : now;
    metaPayload.created_at_ms = stampMs;
    const meta = stringifyHealthMetaComment(metaPayload);

    if (args.prev?.entryId) {
      const ok = await args.replacer(args.prev.entryId, [main, meta]);
      if (!ok) {
        await args.journal([main, meta]);
      }
    } else {
      await args.journal([main, meta]);
    }

    await this.plugin.recordRSLatte?.upsertHealthRecord({
      recordDate: args.anchorDateKey,
      entryId,
      metricKey: args.metricKey,
      period: args.period,
      cardRef: args.cardRef,
      valueStr: args.valueToken,
      note: args.metricKey === "diet" ? dietMeta || undefined : args.note,
      sleepStartHm: args.metricKey === "sleep_hours" ? ssh : undefined,
      isDelete: false,
      tsMs: stampMs,
      createdAtMs: stampMs,
    });
    return true;
  }

  private async deleteOne(args: {
    anchorDateKey: string;
    cardRef: string;
    cardDisplay: string;
    period: string;
    metricKey: string;
    prev: LoadedPrev;
    timeHm: string;
    journal: (lines: string[]) => Promise<void>;
  }): Promise<void> {
    const lineNote = args.metricKey === "diet" ? undefined : args.prev.note;
    const main = buildHealthListItemLine({
      anchorDateKey: args.anchorDateKey,
      metricKey: args.metricKey,
      valueToken: args.prev.valueStr,
      note: lineNote,
      timeHm: args.timeHm,
      isDelete: true,
      cardDisplay: args.cardDisplay,
      waterCupMl: this.getWaterCupMl(),
    });
    const delMeta: HealthJournalMetaPayload = {
      entry_id: args.prev.entryId,
      metric_key: args.metricKey,
      period: args.period,
      card_ref: args.cardRef,
      is_delete: true,
    };
    if (args.metricKey === "diet" && args.prev.note) delMeta.diet_note = String(args.prev.note).trim().slice(0, 100);
    if (args.metricKey === "water_cups") {
      const cups = parseInt(String(args.prev.valueStr ?? "").trim(), 10);
      if (Number.isFinite(cups) && cups >= 0) delMeta.cups = Math.min(30, Math.floor(cups));
    }
    const delSsh = normalizeSleepStartHm(String(args.prev.sleepStartHm ?? ""));
    if (args.metricKey === "sleep_hours" && delSsh) delMeta.sleep_start_hm = delSsh;
    const delCa = normalizeHealthCreatedAtMs(args.prev.createdAtMs);
    if (delCa != null) delMeta.created_at_ms = delCa;
    const meta = stringifyHealthMetaComment(delMeta);
    await args.journal([main, meta]);
    await this.plugin.recordRSLatte?.upsertHealthRecord({
      recordDate: args.anchorDateKey,
      entryId: args.prev.entryId,
      metricKey: args.metricKey,
      period: args.period,
      cardRef: args.cardRef,
      valueStr: args.prev.valueStr,
      note: args.prev.note,
      sleepStartHm: args.metricKey === "sleep_hours" ? delSsh : undefined,
      isDelete: true,
      tsMs: Date.now(),
    });
  }

  private async runSave(): Promise<void> {
    if (!this.ctx.ok) return;
    if (!this.plugin.isHealthModuleEnabled()) {
      new Notice("请先在设置 → 模块管理中启用「健康」");
      return;
    }
    const entryId = String(this.opts.item.entryId ?? "").trim();
    if (!entryId) {
      new Notice("该条缺少 entry_id，无法保存");
      return;
    }

    const wErr = this.validateWeightInline(String(this.fieldVals.weight ?? ""));
    if (this.canonical === "weight" && wErr) {
      new Notice(wErr);
      return;
    }
    const waistErr = this.validateWaistInline(String(this.fieldVals.waist ?? ""));
    if (this.canonical === "waist" && this.ctx.period === "week" && waistErr) {
      new Notice(waistErr);
      return;
    }
    const rhrErr = this.validateRhrInline(String(this.fieldVals.rhr ?? ""));
    if (this.canonical === "rhr" && this.ctx.period === "week" && rhrErr) {
      new Notice(rhrErr);
      return;
    }

    this.saveBtn.setDisabled(true);
    try {
      await this.plugin.recordRSLatte?.ensureReady?.();
      const ctx = this.ctx;
      const timeHm = momentFn().format("HH:mm");
      const journal = (lines: string[]) =>
        ((this.plugin as any).appendJournalByModule?.("health", ctx.anchorDateKey, lines) ?? Promise.resolve());
      const replacer = (eid: string, pair: string[]) =>
        ((this.plugin as any).replaceHealthJournalPairByEntryId?.(ctx.anchorDateKey, eid, pair) ??
          Promise.resolve(false)) as Promise<boolean>;

      let touched = 0;
      const canon = this.canonical;

      const saveMetric = async (metricKey: string): Promise<"ok" | "skip" | "invalid"> => {
        const prev = this.loadedByMetric.get(metricKey);

        if (metricKey === "menstruation" && ctx.period === "month") {
          if (this.isMenstruationMonthFormEmpty()) {
            if (prev?.entryId) {
              await this.deleteOne({
                anchorDateKey: ctx.anchorDateKey,
                cardRef: ctx.cardRef,
                cardDisplay: ctx.cardDisplay,
                period: ctx.period,
                metricKey,
                prev,
                timeHm,
                journal,
              });
              return "ok";
            }
            return "skip";
          }
          const mErr = this.validateMenstruationMonthForm();
          if (mErr) {
            new Notice(mErr);
            return "invalid";
          }
        }

        let raw =
          metricKey === "bp"
            ? (() => {
                const a = String(this.fieldVals.bp_sys ?? "").trim();
                const b = String(this.fieldVals.bp_dia ?? "").trim();
                if (!a && !b) return "";
                return `${a}/${b}`;
              })()
            : metricKey === "glucose" && ctx.period === "month"
              ? (() => {
                  const a = String(this.fieldVals.monthGFast ?? "").trim();
                  const b = String(this.fieldVals.monthG2h ?? "").trim();
                  if (!a && !b) return "";
                  return `${a}/${b}`;
                })()
              : metricKey === "menstruation" && ctx.period === "month"
                ? this.buildMenstruationMonthRaw()
                : String(this.fieldVals[metricKey] ?? "");

        if (metricKey === "glucose" && ctx.period === "month") {
          const a = String(this.fieldVals.monthGFast ?? "").trim();
          const b = String(this.fieldVals.monthG2h ?? "").trim();
          if (!a && !b) {
            if (prev?.entryId) {
              await this.deleteOne({
                anchorDateKey: ctx.anchorDateKey,
                cardRef: ctx.cardRef,
                cardDisplay: ctx.cardDisplay,
                period: ctx.period,
                metricKey,
                prev,
                timeHm,
                journal,
              });
              return "ok";
            }
            return "skip";
          }
          if (!a || !b) {
            new Notice("须同时填写空腹与餐后两小时血糖（mmol/L）");
            return "invalid";
          }
        }

        const parts = this.buildPersistParts(metricKey, raw);
        if (parts === "invalid") {
          if (metricKey === "weight") {
            const e = this.validateMetric("weight", String(this.fieldVals.weight ?? ""));
            if (e) new Notice(e);
          }
          return "invalid";
        }
        if (parts === "empty" && prev) {
          await this.deleteOne({
            anchorDateKey: ctx.anchorDateKey,
            cardRef: ctx.cardRef,
            cardDisplay: ctx.cardDisplay,
            period: ctx.period,
            metricKey,
            prev,
            timeHm,
            journal,
          });
          return "ok";
        }
        if (parts === "empty") return "skip";
        const ok = await this.persistOne({
          anchorDateKey: ctx.anchorDateKey,
          cardRef: ctx.cardRef,
          cardDisplay: ctx.cardDisplay,
          period: ctx.period,
          metricKey,
          valueToken: parts.valueToken,
          note: parts.note,
          prev,
          timeHm,
          journal,
          replacer,
          sleepStartHm: metricKey === "sleep_hours" ? String(this.fieldVals.sleep_start_hm ?? "").trim() : undefined,
        });
        return ok ? "ok" : "skip";
      };

      if (ctx.period === "day" && ["weight", "water_cups", "sleep_hours"].includes(canon)) {
        const r = await saveMetric(canon);
        if (r === "invalid") return;
        if (r === "ok") touched++;
      } else if (ctx.period === "day" && canon === "diet") {
        const heat = String(this.fieldVals.diet_heat ?? "").trim();
        const noteD = clampDietNoteChars(String(this.fieldVals.diet_note ?? ""), 100);
        const prevDiet = this.loadedByMetric.get("diet");
        const hasHeat = isDietHeatLevel(heat);

        if (this.legacyPrev) {
          if (!hasHeat && !noteD) {
            await this.deleteOne({
              anchorDateKey: ctx.anchorDateKey,
              cardRef: ctx.cardRef,
              cardDisplay: ctx.cardDisplay,
              period: "day",
              metricKey: this.legacyPrev.metricKey,
              prev: {
                entryId: this.legacyPrev.entryId,
                valueStr: this.legacyPrev.valueStr,
                note: this.legacyPrev.note,
                ...(this.legacyPrev.createdAtMs != null ? { createdAtMs: this.legacyPrev.createdAtMs } : {}),
              },
              timeHm,
              journal,
            });
            touched++;
          } else {
            if (!hasHeat) {
              new Notice("请选择饮食热量档位（🔥 / 🔥🔥 / 🔥🔥🔥）");
              return;
            }
            const ok = await this.persistOne({
              anchorDateKey: ctx.anchorDateKey,
              cardRef: ctx.cardRef,
              cardDisplay: ctx.cardDisplay,
              period: "day",
              metricKey: "diet",
              valueToken: heat,
              dietNoteForMeta: noteD || undefined,
              prev: prevDiet,
              timeHm,
              journal,
              replacer,
            });
            if (ok) touched++;
            await this.deleteOne({
              anchorDateKey: ctx.anchorDateKey,
              cardRef: ctx.cardRef,
              cardDisplay: ctx.cardDisplay,
              period: "day",
              metricKey: this.legacyPrev.metricKey,
              prev: {
                entryId: this.legacyPrev.entryId,
                valueStr: this.legacyPrev.valueStr,
                note: this.legacyPrev.note,
                ...(this.legacyPrev.createdAtMs != null ? { createdAtMs: this.legacyPrev.createdAtMs } : {}),
              },
              timeHm,
              journal,
            });
            touched++;
          }
        } else {
          if (!hasHeat && !noteD) {
            if (prevDiet) {
              await this.deleteOne({
                anchorDateKey: ctx.anchorDateKey,
                cardRef: ctx.cardRef,
                cardDisplay: ctx.cardDisplay,
                period: "day",
                metricKey: "diet",
                prev: prevDiet,
                timeHm,
                journal,
              });
              touched++;
            }
          } else {
            if (!hasHeat) {
              new Notice("请选择饮食热量档位（🔥 / 🔥🔥 / 🔥🔥🔥）");
              return;
            }
            const ok = await this.persistOne({
              anchorDateKey: ctx.anchorDateKey,
              cardRef: ctx.cardRef,
              cardDisplay: ctx.cardDisplay,
              period: "day",
              metricKey: "diet",
              valueToken: heat,
              dietNoteForMeta: noteD || undefined,
              prev: prevDiet,
              timeHm,
              journal,
              replacer,
            });
            if (ok) touched++;
          }
        }
      } else if (ctx.period === "week" || ctx.period === "month") {
        const r = await saveMetric(canon);
        if (r === "invalid") return;
        if (r === "ok") touched++;
      }

      if (touched === 0) {
        new Notice("没有可保存的变更（可清空字段以删除该条）");
        return;
      }

      try {
        await this.plugin.workEventSvc?.append({
          ts: toLocalOffsetIsoString(),
          kind: "health",
          action: "update",
          source: "ui",
          ref: {
            period: ctx.period,
            card_ref: ctx.cardRef,
            anchor_date: ctx.anchorDateKey,
            entry_id: entryId,
            metric_key: this.originalMetricKey,
          },
          summary: `健康记录已修改 · ${healthMetricLabelZh(canon)}`,
        });
      } catch {
        // ignore
      }

      new Notice("已保存");
      this.close();
      this.opts.onSuccess?.(ctx.anchorDateKey);
      this.plugin.refreshSidePanel();
    } catch (e: any) {
      new Notice(`保存失败：${e?.message ?? String(e)}`);
    } finally {
      this.saveBtn.setDisabled(false);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
