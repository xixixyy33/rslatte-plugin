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
  HEALTH_DAY_CARD_METRICS,
  HEALTH_MONTH_CARD_METRICS,
  HEALTH_WEEK_CARD_METRICS,
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
  parseMonthCardRef,
  parseWeekCardRef,
  weekCardFromAnyDateKey,
} from "../../services/health/healthCardRef";
import { toLocalOffsetIsoString } from "../../utils/localCalendarYmd";
import {
  HEALTH_CANONICAL_MONTH_KEYS,
  HEALTH_CANONICAL_WEEK_KEYS,
  healthCanonicalToPeriod,
  readHealthMetricsEnabledForUi,
  type HealthCanonicalMetricKey,
} from "../../services/health/healthCanonicalMetrics";

const momentFn = moment as any;

type HealthTab = "day" | "week" | "month";

export type HealthCardModalOptions = {
  onSuccess?: (anchorDateKey?: string) => void;
  initialTab?: HealthTab;
  /** 今日打卡等处：只录入该合并项 */
  singleCanonicalMetric?: HealthCanonicalMetricKey;
  /** 与 singleCanonicalMetric 联用：锚定「今天」对应卡片，不展示日期/周/月选择控件 */
  lockAnchorToToday?: boolean;
};

type LoadedPrev = {
  entryId: string;
  valueStr: string;
  note?: string;
  sleepStartHm?: string;
  /** 与 meta.created_at_ms / 索引一致；旧数据可由 tsMs 回填 */
  createdAtMs?: number;
};
type LoadedMap = Map<string, LoadedPrev>;

function clampDietNoteChars(s: string, max = 100): string {
  const arr = [...String(s ?? "")];
  return arr.length <= max ? arr.join("") : arr.slice(0, max).join("");
}

/**
 * 健康录入：日 / 周 / 月卡片子页签；保存时按指标拆成多条日记行 + 索引条目（同一 card_ref）。
 */
export class HealthCardModal extends Modal {
  private tab: HealthTab = "day";
  private dayDateKey: string;
  private weekPickKey: string;
  /** 月卡片：YYYY-MM，与 monthDayPick 同步 */
  private monthKey: string;
  /** 月卡片：任一天 YYYY-MM-DD，用于日期控件与推导月份 */
  private monthDayPick: string;
  private fieldVals: Record<string, string> = {};
  private loadedByMetric: LoadedMap = new Map();
  private bodyEl!: HTMLDivElement;
  private saveBtn!: ButtonComponent;
  /** 页签按钮需在切换时更新 is-active（仅 onOpen 里建一次会卡在初始高亮） */
  private tabButtons: Partial<Record<HealthTab, HTMLButtonElement>> = {};
  /** 旧版 diet_level + diet_text 两行，保存统一 diet 后需撤销 */
  private legacyDietRows: Array<{
    entryId: string;
    metricKey: string;
    valueStr: string;
    note?: string;
  }> = [];

  constructor(
    app: App,
    private plugin: RSLattePlugin,
    private opts: HealthCardModalOptions = {},
  ) {
    super(app);
    const today = this.plugin.getTodayKey();
    this.dayDateKey = today;
    this.weekPickKey = today;
    this.monthKey = today.slice(0, 7);
    this.monthDayPick = today;
    if (opts.singleCanonicalMetric) {
      this.tab = healthCanonicalToPeriod(opts.singleCanonicalMetric);
    } else if (opts.initialTab) {
      this.tab = opts.initialTab;
    }
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("rslatte-health-card-modal");
    if (this.opts.lockAnchorToToday) {
      const t = String(this.plugin.getTodayKey() ?? "").trim().slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
        this.dayDateKey = t;
        this.weekPickKey = t;
        this.monthDayPick = t;
        this.monthKey = t.slice(0, 7);
      }
    }
    this.titleEl.setText(this.opts.singleCanonicalMetric ? "健康录入" : "健康卡片");

    this.tabButtons = {};
    const hp = (this.plugin.settings as any).healthPanel ?? {};
    const en = readHealthMetricsEnabledForUi(hp);
    const showWeek = HEALTH_CANONICAL_WEEK_KEYS.some((k) => en[k]);
    const showMonth = HEALTH_CANONICAL_MONTH_KEYS.some((k) => en[k]);
    if (this.tab === "week" && !showWeek) this.tab = "day";
    if (this.tab === "month" && !showMonth) this.tab = "day";

    if (!this.opts.singleCanonicalMetric) {
      const tabRow = contentEl.createDiv({ cls: "rslatte-task-subtabs rslatte-health-card-tabs" });
      const mkTab = (t: HealthTab, label: string) => {
        const btn = tabRow.createEl("button", {
          type: "button",
          cls: "rslatte-task-subtab",
          text: label,
        });
        this.tabButtons[t] = btn;
        btn.onclick = () => {
          this.tab = t;
          this.syncHealthTabActive();
          void this.refreshBody();
        };
      };
      mkTab("day", "日卡片");
      if (showWeek) mkTab("week", "周卡片");
      if (showMonth) mkTab("month", "月卡片");
      this.syncHealthTabActive();
    }

    const scrollWrap = contentEl.createDiv({ cls: "rslatte-health-card-scroll" });
    this.bodyEl = scrollWrap.createDiv({ cls: "rslatte-health-card-body" });
    const footer = contentEl.createDiv({ cls: "rslatte-modal-footer" });
    new ButtonComponent(footer).setButtonText("取消").onClick(() => this.close());
    this.saveBtn = new ButtonComponent(footer).setButtonText("保存").setCta();
    this.saveBtn.onClick(() => void this.runSave());

    await this.refreshBody();
  }

  private syncHealthTabActive(): void {
    (["day", "week", "month"] as const).forEach((k) => {
      const btn = this.tabButtons[k];
      if (!btn) return;
      btn.classList.toggle("is-active", this.tab === k);
    });
  }

  /** 当前设置下该周期可编辑的存盘 metric_key 列表 */
  private effectiveMetricKeysForPeriod(period: HealthTab): string[] {
    const hp = (this.plugin.settings as any).healthPanel ?? {};
    const en = readHealthMetricsEnabledForUi(hp);
    const sc = this.opts.singleCanonicalMetric;
    if (sc) {
      const want = healthCanonicalToPeriod(sc);
      if (period !== want) return [];
      if ((HEALTH_DAY_CARD_METRICS as readonly string[]).includes(sc)) return [sc];
      if ((HEALTH_WEEK_CARD_METRICS as readonly string[]).includes(sc)) return [sc];
      return [sc];
    }
    if (period === "day") return HEALTH_DAY_CARD_METRICS.filter((k) => en[k]);
    if (period === "week") return HEALTH_WEEK_CARD_METRICS.filter((k) => en[k]);
    return HEALTH_MONTH_CARD_METRICS.filter((k) => en[k]);
  }

  private cardContext():
    | { ok: false; msg: string }
    | {
        ok: true;
        period: HealthTab;
        cardRef: string;
        cardDisplay: string;
        anchorDateKey: string;
        metricKeys: readonly string[];
      } {
    if (this.tab === "day") {
      const dk = String(this.dayDateKey ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) return { ok: false, msg: "请选择有效日期（YYYY-MM-DD）" };
      const cardRef = formatDayCardRef(dk);
      const metricKeys = this.effectiveMetricKeysForPeriod("day");
      if (!metricKeys.length) return { ok: false, msg: "未启用任何日数据项，请在设置 → 健康管理中勾选。" };
      return {
        ok: true,
        period: "day",
        cardRef,
        cardDisplay: cardRef,
        anchorDateKey: dk,
        metricKeys,
      };
    }
    if (this.tab === "week") {
      const pk = String(this.weekPickKey ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(pk)) return { ok: false, msg: "请填写周内任一天（YYYY-MM-DD）" };
      const { cardRef, anchorDateKey } = weekCardFromAnyDateKey(pk);
      if (!cardRef) return { ok: false, msg: "无法解析周卡片" };
      const metricKeys = this.effectiveMetricKeysForPeriod("week");
      if (!metricKeys.length) return { ok: false, msg: "未启用任何周数据项，请在设置 → 健康管理中勾选。" };
      return {
        ok: true,
        period: "week",
        cardRef,
        cardDisplay: cardRef,
        anchorDateKey,
        metricKeys,
      };
    }
    const md = String(this.monthDayPick ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(md)) return { ok: false, msg: "请选择月份内日期（YYYY-MM-DD）" };
    const y = Number(md.slice(0, 4));
    const mon = Number(md.slice(5, 7));
    if (!Number.isFinite(y) || !Number.isFinite(mon) || mon < 1 || mon > 12) return { ok: false, msg: "日期无效" };
    this.monthKey = `${String(y).padStart(4, "0")}-${String(mon).padStart(2, "0")}`;
    const cardRef = formatMonthCardRef(y, mon);
    const anchorDateKey = firstDayKeyOfMonth(y, mon);
    const metricKeys = this.effectiveMetricKeysForPeriod("month");
    if (!metricKeys.length) return { ok: false, msg: "未启用任何月数据项，请在设置 → 健康管理中勾选。" };
    return {
      ok: true,
      period: "month",
      cardRef,
      cardDisplay: cardRef,
      anchorDateKey,
      metricKeys,
    };
  }

  private async loadSnapshotForCard(
    cardRef: string,
    period: string,
    metricKeys: readonly string[],
  ): Promise<void> {
    this.loadedByMetric.clear();
    this.legacyDietRows = [];
    for (const k of metricKeys) this.fieldVals[k] = "";
    const wantPeriod = String(period ?? "day").trim().toLowerCase();
    if (wantPeriod === "day") {
      if (metricKeys.includes("diet")) {
        this.fieldVals["diet_heat"] = "";
        this.fieldVals["diet_note"] = "";
      }
      if (metricKeys.includes("sleep_hours")) {
        this.fieldVals["sleep_start_hm"] = "";
      }
    }
    if (wantPeriod === "week" && metricKeys.includes("bp")) {
      this.fieldVals.bp_sys = "";
      this.fieldVals.bp_dia = "";
    }
    if (wantPeriod === "month") {
      if (metricKeys.includes("glucose")) {
        this.fieldVals.monthGFast = "";
        this.fieldVals.monthG2h = "";
      }
      if (metricKeys.includes("menstruation")) {
        this.fieldVals.monthMStart = "";
        this.fieldVals.monthMEnd = "";
        this.fieldVals.monthMFlow = "";
        this.fieldVals.monthMCramps = "no";
      }
    }

    try {
      await this.plugin.recordRSLatte?.ensureReady?.();
      const snap = await this.plugin.recordRSLatte?.getHealthSnapshot(false);
      const wantRef = String(cardRef ?? "").trim();

      for (const it of snap?.items ?? []) {
        if (it.isDelete) continue;
        const p = String(it.period ?? "day").trim().toLowerCase();
        if (p !== wantPeriod) continue;
        const ir = inferCardRefFromItem({
          recordDate: it.recordDate,
          period: it.period,
          cardRef: it.cardRef,
        });
        if (ir !== wantRef) continue;
        if (!metricKeys.includes(it.metricKey)) continue;
        const eid = String(it.entryId ?? "").trim();
        if (!eid) continue;
        const lp: LoadedPrev = {
          entryId: eid,
          valueStr: String(it.valueStr ?? ""),
          note: it.note ? String(it.note) : undefined,
        };
        if (it.metricKey === "sleep_hours" && it.sleepStartHm) lp.sleepStartHm = String(it.sleepStartHm);
        const ca = normalizeHealthCreatedAtMs(it.createdAtMs) ?? normalizeHealthCreatedAtMs(it.tsMs);
        if (ca != null) lp.createdAtMs = ca;
        this.loadedByMetric.set(it.metricKey, lp);
        if (it.metricKey === "diet") {
          const heat = String(it.valueStr ?? "").trim();
          this.fieldVals["diet_heat"] = isDietHeatLevel(heat) ? heat : "";
          this.fieldVals["diet_note"] = clampDietNoteChars(String(it.note ?? "").trim(), 100);
        } else if (it.metricKey === "menstruation_cramps") {
          const vs = String(it.valueStr ?? "").trim().toLowerCase();
          this.fieldVals[it.metricKey] =
            vs === "是" || vs === "yes" || vs === "y" || vs === "true" || vs === "1" ? "yes" : vs === "否" || vs === "no" || vs === "n" || vs === "false" || vs === "0" ? "no" : vs;
        } else if (it.metricKey === "sleep_hours") {
          this.fieldVals["sleep_hours"] = String(it.valueStr ?? "").trim();
          this.fieldVals["sleep_start_hm"] = String(it.sleepStartHm ?? "").trim();
        } else if (it.metricKey === "bp") {
          const pr = parseBloodPressureStorage(String(it.valueStr ?? ""));
          if (pr) {
            this.fieldVals.bp_sys = String(pr.systolic);
            this.fieldVals.bp_dia = String(pr.diastolic);
          }
        } else if (it.metricKey === "glucose") {
          const g = parseGlucoseMonthStorage(String(it.valueStr ?? ""));
          if (g) {
            this.fieldVals.monthGFast = g.fasting;
            this.fieldVals.monthG2h = g.post2h;
          }
        } else if (it.metricKey === "menstruation") {
          const mn = parseMenstruationMonthStorage(String(it.valueStr ?? ""));
          if (mn) {
            this.fieldVals.monthMStart = mn.start;
            this.fieldVals.monthMEnd = mn.end;
            this.fieldVals.monthMFlow = String(mn.flow);
            this.fieldVals.monthMCramps = mn.crampsYes ? "yes" : "no";
          }
        } else {
          this.fieldVals[it.metricKey] = String(it.valueStr ?? "").trim();
        }
      }

      if (wantPeriod === "week" && metricKeys.includes("bp") && !this.loadedByMetric.has("bp")) {
        let sys = "";
        let dia = "";
        let lpSys: LoadedPrev | undefined;
        let lpDia: LoadedPrev | undefined;
        for (const it of snap?.items ?? []) {
          if (it.isDelete) continue;
          const p = String(it.period ?? "day").trim().toLowerCase();
          if (p !== "week") continue;
          const ir = inferCardRefFromItem({
            recordDate: it.recordDate,
            period: it.period,
            cardRef: it.cardRef,
          });
          if (ir !== wantRef) continue;
          const eid = String(it.entryId ?? "").trim();
          if (!eid) continue;
          const ca = normalizeHealthCreatedAtMs(it.createdAtMs) ?? normalizeHealthCreatedAtMs(it.tsMs);
          if (it.metricKey === "bp_systolic") {
            sys = String(it.valueStr ?? "").trim();
            lpSys = {
              entryId: eid,
              valueStr: sys,
              note: it.note ? String(it.note) : undefined,
              ...(ca != null ? { createdAtMs: ca } : {}),
            };
          }
          if (it.metricKey === "bp_diastolic") {
            dia = String(it.valueStr ?? "").trim();
            lpDia = {
              entryId: eid,
              valueStr: dia,
              note: it.note ? String(it.note) : undefined,
              ...(ca != null ? { createdAtMs: ca } : {}),
            };
          }
        }
        if (sys || dia) {
          this.fieldVals.bp_sys = sys;
          this.fieldVals.bp_dia = dia;
          if (lpSys) this.loadedByMetric.set("bp_systolic", lpSys);
          if (lpDia) this.loadedByMetric.set("bp_diastolic", lpDia);
        }
      }

      if (wantPeriod === "month" && metricKeys.includes("glucose") && !this.loadedByMetric.has("glucose")) {
        let f = "";
        let p = "";
        let lpF: LoadedPrev | undefined;
        let lpP: LoadedPrev | undefined;
        for (const it of snap?.items ?? []) {
          if (it.isDelete) continue;
          const per = String(it.period ?? "day").trim().toLowerCase();
          if (per !== "month") continue;
          const ir = inferCardRefFromItem({
            recordDate: it.recordDate,
            period: it.period,
            cardRef: it.cardRef,
          });
          if (ir !== wantRef) continue;
          const eid = String(it.entryId ?? "").trim();
          if (!eid) continue;
          const ca = normalizeHealthCreatedAtMs(it.createdAtMs) ?? normalizeHealthCreatedAtMs(it.tsMs);
          if (it.metricKey === "glucose_fasting") {
            f = String(it.valueStr ?? "").trim();
            lpF = {
              entryId: eid,
              valueStr: f,
              note: it.note ? String(it.note) : undefined,
              ...(ca != null ? { createdAtMs: ca } : {}),
            };
          }
          if (it.metricKey === "glucose_postprandial") {
            p = String(it.valueStr ?? "").trim();
            lpP = {
              entryId: eid,
              valueStr: p,
              note: it.note ? String(it.note) : undefined,
              ...(ca != null ? { createdAtMs: ca } : {}),
            };
          }
        }
        if (f || p) {
          this.fieldVals.monthGFast = f;
          this.fieldVals.monthG2h = p;
          if (lpF) this.loadedByMetric.set("glucose_fasting", lpF);
          if (lpP) this.loadedByMetric.set("glucose_postprandial", lpP);
        }
      }

      if (wantPeriod === "month" && metricKeys.includes("menstruation") && !this.loadedByMetric.has("menstruation")) {
        let ms = "";
        let me = "";
        let mf = "";
        let mc = "no";
        const leg: Record<string, LoadedPrev | undefined> = {};
        for (const it of snap?.items ?? []) {
          if (it.isDelete) continue;
          const per = String(it.period ?? "day").trim().toLowerCase();
          if (per !== "month") continue;
          const ir = inferCardRefFromItem({
            recordDate: it.recordDate,
            period: it.period,
            cardRef: it.cardRef,
          });
          if (ir !== wantRef) continue;
          const eid = String(it.entryId ?? "").trim();
          if (!eid) continue;
          const ca = normalizeHealthCreatedAtMs(it.createdAtMs) ?? normalizeHealthCreatedAtMs(it.tsMs);
          const lp: LoadedPrev = {
            entryId: eid,
            valueStr: String(it.valueStr ?? ""),
            note: it.note ? String(it.note) : undefined,
            ...(ca != null ? { createdAtMs: ca } : {}),
          };
          if (it.metricKey === "menstruation_start") {
            ms = String(it.valueStr ?? "").trim();
            leg.menstruation_start = lp;
          }
          if (it.metricKey === "menstruation_end") {
            me = String(it.valueStr ?? "").trim();
            leg.menstruation_end = lp;
          }
          if (it.metricKey === "menstruation_flow") {
            mf = String(it.valueStr ?? "").trim();
            leg.menstruation_flow = lp;
          }
          if (it.metricKey === "menstruation_cramps") {
            const vs = String(it.valueStr ?? "").trim().toLowerCase();
            mc =
              vs === "是" || vs === "yes" || vs === "y" || vs === "true" || vs === "1"
                ? "yes"
                : "no";
            leg.menstruation_cramps = lp;
          }
        }
        if (ms || me || mf || mc === "yes") {
          this.fieldVals.monthMStart = ms;
          this.fieldVals.monthMEnd = me;
          this.fieldVals.monthMFlow = mf;
          this.fieldVals.monthMCramps = mc;
          for (const k of ["menstruation_start", "menstruation_end", "menstruation_flow", "menstruation_cramps"] as const) {
            const x = leg[k];
            if (x) this.loadedByMetric.set(k, x);
          }
        }
      }

      if (wantPeriod === "day" && metricKeys.includes("diet") && !this.loadedByMetric.has("diet")) {
        for (const it of snap?.items ?? []) {
          if (it.isDelete) continue;
          const p = String(it.period ?? "day").trim().toLowerCase();
          if (p !== "day") continue;
          const ir = inferCardRefFromItem({ recordDate: it.recordDate, period: it.period, cardRef: it.cardRef });
          if (ir !== wantRef) continue;
          const mk = String(it.metricKey ?? "");
          if (mk !== "diet_level" && mk !== "diet_text") continue;
          const eid = String(it.entryId ?? "").trim();
          if (!eid) continue;
          if (mk === "diet_level") {
            this.legacyDietRows.push({
              entryId: eid,
              metricKey: "diet_level",
              valueStr: String(it.valueStr ?? ""),
              note: it.note ? String(it.note) : undefined,
            });
            const h = mapLegacyDietLevelToHeat(String(it.valueStr ?? ""));
            if (isDietHeatLevel(h)) this.fieldVals["diet_heat"] = h;
          } else {
            this.legacyDietRows.push({
              entryId: eid,
              metricKey: "diet_text",
              valueStr: String(it.valueStr ?? ""),
              note: it.note ? String(it.note) : undefined,
            });
            const vs = String(it.valueStr ?? "").trim();
            const nt = String(it.note ?? "").trim();
            const txt = vs === "_" || vs === "." || vs === "—" ? nt : [vs, nt].filter(Boolean).join(" ").trim();
            if (txt) this.fieldVals["diet_note"] = clampDietNoteChars(txt, 100);
          }
        }
      }
    } catch (e) {
      console.warn("loadSnapshotForCard failed", e);
    }
  }

  /**
   * @param skipRemoteReload 为 true 时不重新拉快照（避免饮水杯点击后 loadSnapshot 清空未写入索引的 fieldVals）
   */
  private async refreshBody(opts?: { skipRemoteReload?: boolean }): Promise<void> {
    this.bodyEl.empty();
    const ctx = this.cardContext();
    if (!ctx.ok) {
      this.bodyEl.createDiv({ cls: "rslatte-muted", text: ctx.msg });
      return;
    }

    const anchorToday = !!this.opts.singleCanonicalMetric && !!this.opts.lockAnchorToToday;

    if (this.tab === "day") {
      if (ctx.ok && ctx.period === "day") {
        const m = momentFn(ctx.anchorDateKey, "YYYY-MM-DD");
        const wdZh = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
        const wdLab = m.isValid() ? `（${wdZh[m.day()]}）` : "";
        if (anchorToday) {
          this.bodyEl.createDiv({
            cls: "rslatte-muted rslatte-health-lock-today-hint",
            text: `维护今日 · ${ctx.cardDisplay}${wdLab}`,
          });
        } else {
          this.bodyEl.createDiv({
            cls: "rslatte-setting-hint rslatte-health-day-anchor-hint",
            text: `当前卡片：${ctx.cardDisplay}，日记锚点：${ctx.anchorDateKey}${wdLab}`,
          });
        }
      }
      if (!anchorToday) {
        new Setting(this.bodyEl)
          .setName("日期")
          .addText((t) => {
            t.inputEl.type = "date";
            t.setValue(this.dayDateKey);
            t.onChange((v) => {
              this.dayDateKey = String(v ?? "").trim().slice(0, 10);
              void this.refreshBody();
            });
          });
      }
    } else if (this.tab === "week") {
      const wctx = this.cardContext();
      if (wctx.ok && wctx.period === "week") {
        if (anchorToday) {
          this.bodyEl.createDiv({
            cls: "rslatte-muted rslatte-health-lock-today-hint",
            text: `维护本周（含今日）· ${wctx.cardDisplay}，锚点 ${wctx.anchorDateKey}（周一）`,
          });
        } else {
          this.bodyEl.createDiv({
            cls: "rslatte-setting-hint rslatte-health-week-anchor-hint",
            text: `当前卡片：${wctx.cardDisplay}，日记锚点：${wctx.anchorDateKey}（周一）`,
          });
        }
      }
      if (!anchorToday) {
        const weekRow = this.bodyEl.createDiv({ cls: "setting-item rslatte-health-week-pick-row" });
        weekRow.createDiv({ cls: "setting-item-info" }).createDiv({
          cls: "setting-item-name",
          text: "周内任一天",
        });
        const weekCtrl = weekRow.createDiv({ cls: "setting-item-control rslatte-health-week-pick-control" });
        const dateInp = weekCtrl.createEl("input", {
          type: "date",
          cls: "rslatte-health-week-date-input",
          attr: { title: "选择该周内任意一天（YYYY-MM-DD）" },
        });
        dateInp.value = /^\d{4}-\d{2}-\d{2}$/.test(this.weekPickKey) ? this.weekPickKey : "";
        dateInp.addEventListener("change", () => {
          this.weekPickKey = String(dateInp.value ?? "").trim().slice(0, 10);
          void this.refreshBody();
        });
        if (wctx.ok && wctx.period === "week") {
          const pw = parseWeekCardRef(wctx.cardDisplay);
          if (pw) {
            const wtag = weekCtrl.createSpan({
              cls: "rslatte-health-week-tag",
              text: `W${String(pw.isoWeek).padStart(2, "0")}`,
            });
            wtag.title = wctx.cardDisplay;
          }
        }
      }
    } else if (this.tab === "month") {
      const mctx = this.cardContext();
      if (mctx.ok && mctx.period === "month") {
        if (anchorToday) {
          this.bodyEl.createDiv({
            cls: "rslatte-muted rslatte-health-lock-today-hint",
            text: `维护本月（含今日）· ${mctx.cardDisplay}`,
          });
        } else {
          this.bodyEl.createDiv({
            cls: "rslatte-setting-hint rslatte-health-month-anchor-hint",
            text: `当前卡片：${mctx.cardDisplay}，日记锚点：${mctx.anchorDateKey}`,
          });
        }
      }
      if (!anchorToday) {
        const monthRow = this.bodyEl.createDiv({ cls: "setting-item rslatte-health-month-pick-row" });
        monthRow.createDiv({ cls: "setting-item-info" }).createDiv({
          cls: "setting-item-name",
          text: "月份（任一天）",
        });
        const monthCtrl = monthRow.createDiv({ cls: "setting-item-control rslatte-health-month-pick-control" });
        const monthDateInp = monthCtrl.createEl("input", {
          type: "date",
          cls: "rslatte-health-month-date-input",
          attr: { title: "选择该月内任意一天，用于定位月卡片" },
        });
        monthDateInp.value = /^\d{4}-\d{2}-\d{2}$/.test(this.monthDayPick) ? this.monthDayPick : "";
        monthDateInp.addEventListener("change", () => {
          this.monthDayPick = String(monthDateInp.value ?? "").trim().slice(0, 10);
          if (/^\d{4}-\d{2}-\d{2}$/.test(this.monthDayPick)) {
            this.monthKey = this.monthDayPick.slice(0, 7);
          }
          void this.refreshBody();
        });
        if (mctx.ok && mctx.period === "month") {
          const pm = parseMonthCardRef(mctx.cardDisplay);
          if (pm) {
            const mtag = monthCtrl.createSpan({
              cls: "rslatte-health-month-tag",
              text: `M${String(pm.m).padStart(2, "0")}`,
            });
            mtag.title = mctx.cardDisplay;
          }
        }
      }
    }

    const ctx2 = this.cardContext();
    if (!ctx2.ok) return;

    if (!opts?.skipRemoteReload) {
      await this.loadSnapshotForCard(ctx2.cardRef, ctx2.period, ctx2.metricKeys);
    }

    if (this.tab === "day") {
      this.renderDayCardFields();
      return;
    }

    if (this.tab === "month") {
      this.renderMonthCardFields();
      return;
    }

    for (const key of ctx2.metricKeys) {
      if (key === "menstruation_cramps") {
        new Setting(this.bodyEl).setName(healthMetricLabelZh(key)).addDropdown((dd) => {
          const NONE = "__none__";
          dd.addOption(NONE, "（未填）");
          dd.addOption("no", "否");
          dd.addOption("yes", "是");
          const cur = String(this.fieldVals[key] ?? "").trim().toLowerCase();
          const norm =
            cur === "是" || cur === "yes" || cur === "y" || cur === "true" || cur === "1"
              ? "yes"
              : cur === "否" || cur === "no" || cur === "n" || cur === "false" || cur === "0"
                ? "no"
                : NONE;
          dd.setValue(norm);
          dd.onChange((v) => {
            this.fieldVals[key] = v === "yes" ? "yes" : v === "no" ? "no" : "";
          });
        });
        continue;
      }
      if (key === "bp" && ctx2.period === "week") {
        const bpRow = this.bodyEl.createDiv({ cls: "setting-item rslatte-health-bp-setting-item" });
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
        continue;
      }
      if ((key === "waist" || key === "rhr") && ctx2.period === "week") {
        const st = new Setting(this.bodyEl).setName(healthMetricLabelZh(key));
        if (key === "waist") st.setDesc("范围 0～200；超出时输入框标红。");
        if (key === "rhr") st.setDesc("次/分，建议 30～220；超出时输入框标红。");
        st.addText((t) => {
          t.inputEl.type = "text";
          t.inputEl.autocomplete = "off";
          t.inputEl.classList.add("rslatte-health-metric-input");
          t.inputEl.inputMode = key === "waist" ? "decimal" : "numeric";
          t.setValue(this.fieldVals[key] ?? "");
          const item = t.inputEl.closest(".setting-item") as HTMLElement | null;
          if (!item) return;
          item.addClass("rslatte-health-week-metric-validate-item");
          const errEl = item.createDiv({ cls: "rslatte-health-inline-error" });
          const sync = () => {
            const val = t.inputEl.value;
            this.fieldVals[key] = val;
            const msg = key === "waist" ? this.validateWaistInline(val) : this.validateRhrInline(val);
            errEl.setText(msg ?? "");
            errEl.toggleClass("is-visible", !!msg);
            t.inputEl.classList.toggle("rslatte-health-input--error", !!msg);
          };
          t.onChange(sync);
          t.inputEl.addEventListener("input", sync);
          sync();
        });
        continue;
      }
      const ph = (() => {
        if (key.includes("menstruation") && key.includes("start")) return "YYYY-MM-DD";
        if (key.includes("menstruation") && key.includes("end")) return "YYYY-MM-DD";
        if (key === "menstruation_flow") return "1-5";
        return "";
      })();
      const st = new Setting(this.bodyEl).setName(healthMetricLabelZh(key));
      st.addText((t) => {
        if (ph) t.setPlaceholder(ph);
        t.setValue(this.fieldVals[key] ?? "");
        t.onChange((v) => {
          this.fieldVals[key] = String(v ?? "");
        });
      });
    }
  }

  private getWaterCupMl(): number {
    const s = (this.plugin.settings as any).healthPanel ?? {};
    return Math.max(50, Math.min(2000, Number(s.waterCupVolumeMl) || 500));
  }

  /** 体重：输入过程中即时校验（空为未填，不报错） */
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

  /** 周卡片腰围：输入过程中即时校验（空为未填，不报错） */
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

  /** 周卡片心率（存盘 rhr）：即时校验（空为未填，不报错） */
  private validateRhrInline(raw: string): string | null {
    const t = String(raw ?? "").trim();
    if (!t) return null;
    if (!/^\d*$/.test(t)) return "仅允许数字";
    const n = parseInt(t, 10);
    if (!Number.isFinite(n)) return null;
    if (n < 30 || n > 220) return "心率建议在 30～220 次/分";
    return null;
  }

  private renderDayCardFields(): void {
    const ctx = this.cardContext();
    if (!ctx.ok || ctx.period !== "day") return;
    const keys = new Set(ctx.metricKeys);

    if (keys.has("weight")) {
    new Setting(this.bodyEl)
        .setName(healthMetricLabelZh("weight"))
        .addText((t) => {
          t.inputEl.type = "text";
          t.inputEl.inputMode = "decimal";
          t.inputEl.autocomplete = "off";
          t.inputEl.classList.add("rslatte-health-weight-input");
          t.setValue(this.fieldVals.weight ?? "");
          // Obsidian TextComponent 无可靠 containerEl；错误区挂在整行 setting-item 上（与财务侧栏等一致）
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
    }

    if (keys.has("water_cups")) {
    const maxCups = 8;
    const curCups = Math.max(0, Math.min(maxCups, parseInt(String(this.fieldVals.water_cups ?? "0"), 10) || 0));
    const mlPer = this.getWaterCupMl();
    const waterRow = this.bodyEl.createDiv({ cls: "setting-item" });
    const waterInfo = waterRow.createDiv({ cls: "setting-item-info" });
    waterInfo.createDiv({ cls: "setting-item-name", text: healthMetricLabelZh("water_cups") });
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
        void this.refreshBody({ skipRemoteReload: true });
      };
    }
    waterBlock.createDiv({
      cls: "rslatte-health-water-cups-summary",
      text: `已选 ${curCups} 杯 · 约 ${curCups * mlPer} ml`,
    });
    }

    if (keys.has("sleep_hours")) {
    const sleepN = (() => {
      const n = parseInt(String(this.fieldVals.sleep_hours ?? ""), 10);
      return Number.isFinite(n) ? Math.min(24, Math.max(0, n)) : 0;
    })();
    const sleepRow = this.bodyEl.createDiv({ cls: "setting-item rslatte-health-sleep-setting-item" });
    const sleepInfo = sleepRow.createDiv({ cls: "setting-item-info" });
    sleepInfo.createDiv({
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
    }

    if (keys.has("diet")) {
    const DIET_NONE = "__none__";
    const dietRow = this.bodyEl.createDiv({ cls: "setting-item rslatte-health-diet-setting-item" });
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
    }
  }

  /** 月卡片：合并血糖 + 合并月经 */
  private renderMonthCardFields(): void {
    const ctx = this.cardContext();
    if (!ctx.ok || ctx.period !== "month") return;
    const keys = new Set(ctx.metricKeys);

    if (keys.has("glucose")) {
    const gRow = this.bodyEl.createDiv({ cls: "setting-item rslatte-health-month-glucose-item" });
    gRow.createDiv({ cls: "setting-item-info" }).createDiv({
      cls: "setting-item-name",
      text: "血糖（mmol/L）",
    });
    const gCtrl = gRow.createDiv({ cls: "setting-item-control rslatte-health-month-glucose-inline" });
    gCtrl.createSpan({ cls: "rslatte-health-month-glucose-lab", text: "空腹" });
    const gFast = gCtrl.createEl("input", {
      type: "text",
      cls: "rslatte-health-month-glucose-inp",
      attr: { inputmode: "decimal", placeholder: "如 5.1", title: "空腹血糖 mmol/L" },
    });
    gFast.value = String(this.fieldVals.monthGFast ?? "");
    gCtrl.createSpan({ cls: "rslatte-health-month-glucose-lab", text: "餐后2h" });
    const g2h = gCtrl.createEl("input", {
      type: "text",
      cls: "rslatte-health-month-glucose-inp",
      attr: { inputmode: "decimal", placeholder: "如 7.2", title: "餐后两小时 mmol/L" },
    });
    g2h.value = String(this.fieldVals.monthG2h ?? "");
    gCtrl.createSpan({ cls: "rslatte-health-month-glucose-unit", text: "mmol/L" });
    const syncG = () => {
      this.fieldVals.monthGFast = String(gFast.value ?? "");
      this.fieldVals.monthG2h = String(g2h.value ?? "");
    };
    gFast.addEventListener("input", syncG);
    g2h.addEventListener("input", syncG);
    }

    if (keys.has("menstruation")) {
    const mSection = this.bodyEl.createDiv({ cls: "rslatte-health-month-menses-section" });
    mSection.createDiv({ cls: "rslatte-health-month-menses-title", text: healthMetricLabelZh("menstruation") });

    const rangeRow = mSection.createDiv({ cls: "setting-item rslatte-health-month-menses-range" });
    const rangeInfo = rangeRow.createDiv({ cls: "setting-item-info" });
    rangeInfo.createDiv({ cls: "setting-item-name", text: "月经起止" });
    rangeInfo.createDiv({
      cls: "setting-item-description",
      text: "在同一月历中先点开始日，再点结束日；可翻页跨月。仅一天时点一次后确定即可。",
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
        anchorHint: this.monthDayPick,
        onConfirm: (a, b) => {
          this.fieldVals.monthMStart = a;
          this.fieldVals.monthMEnd = b;
          void this.refreshBody({ skipRemoteReload: true });
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
    const flowRow = flowWrap.createDiv({
      cls: `rslatte-health-menses-flow-row${String(this.fieldVals.monthMFlow ?? "").trim() ? "" : " is-pristine"}`,
    });
    const curFlow = Math.max(0, Math.min(5, parseInt(String(this.fieldVals.monthMFlow ?? "0"), 10) || 0));
    for (let i = 1; i <= 5; i++) {
      const on = i <= curFlow;
      const b = flowRow.createEl("button", {
        type: "button",
        cls: `rslatte-health-menses-drop${on ? " is-on" : ""}`,
        text: String(i),
        attr: { "aria-label": `月经量 ${i} 档` },
      });
      b.onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.fieldVals.monthMFlow = String(i);
        void this.refreshBody({ skipRemoteReload: true });
      };
    }

    const crWrap = comboCtrl.createDiv({ cls: "rslatte-health-menses-cramps-wrap" });
    crWrap.createSpan({ cls: "rslatte-health-menses-cramps-title", text: "痛经" });
    crWrap.createSpan({ cls: "rslatte-health-menses-icon-lab", text: "⚡" });
    const cramps = String(this.fieldVals.monthMCramps ?? "no").trim() === "yes";
    const crBtns = crWrap.createDiv({ cls: "rslatte-health-menses-cramps-btns" });
    const mkCr = (yes: boolean, label: string) => {
      const btn = crBtns.createEl("button", {
        type: "button",
        cls: `rslatte-health-menses-cramp-btn${cramps === yes ? " is-active" : ""}`,
        text: label,
      });
      btn.onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.fieldVals.monthMCramps = yes ? "yes" : "no";
        void this.refreshBody({ skipRemoteReload: true });
      };
    };
    mkCr(false, "否");
    mkCr(true, "是⚡");
    }
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
      if (!/^\d+$/.test(v)) return "心率须为整数（次/分）";
      const n = parseInt(v, 10);
      if (n < 30 || n > 220) return "心率建议在 30～220 次/分";
      return null;
    }
    if (["glucose_fasting", "glucose_postprandial"].includes(metricKey)) {
      if (!/^-?\d+(\.\d+)?$/.test(v)) return `${healthMetricLabelZh(metricKey)} 须为数字`;
    }
    return null;
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
    /** 饮食日记正文，写入 meta.diet_note（主行不写） */
    dietNoteForMeta?: string;
    prev?: LoadedPrev;
    timeHm: string;
    journal: (lines: string[]) => Promise<void>;
    replacer: (eid: string, pair: string[]) => Promise<boolean>;
    /** sleep_hours：meta.sleep_start_hm */
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
    if (!this.plugin.isHealthModuleEnabled()) {
      new Notice("请先在设置 → 模块管理中启用「健康」");
      return;
    }
    const ctx = this.cardContext();
    if (!ctx.ok) {
      new Notice(ctx.msg);
      return;
    }

    if (ctx.period === "week") {
      if (ctx.metricKeys.includes("waist")) {
        const we = this.validateWaistInline(String(this.fieldVals.waist ?? ""));
        if (we) {
          new Notice(we);
          return;
        }
      }
      if (ctx.metricKeys.includes("rhr")) {
        const re = this.validateRhrInline(String(this.fieldVals.rhr ?? ""));
        if (re) {
          new Notice(re);
          return;
        }
      }
    }

    this.saveBtn.setDisabled(true);
    try {
      await this.plugin.recordRSLatte?.ensureReady?.();
      const timeHm = momentFn().format("HH:mm");
      const journal = (lines: string[]) =>
        ((this.plugin as any).appendJournalByModule?.("health", ctx.anchorDateKey, lines) ?? Promise.resolve());
      const replacer = (eid: string, pair: string[]) =>
        ((this.plugin as any).replaceHealthJournalPairByEntryId?.(ctx.anchorDateKey, eid, pair) ?? Promise.resolve(false)) as Promise<boolean>;

      let touched = 0;
      /** 本次保存是否出现过「无 entryId 的新增 persist」 */
      let workEvHadNewEntry = false;
      /** 本次保存是否出现过更新已有行、删除行、或清理 legacy 行 */
      let workEvHadUpdateOrDelete = false;

      const saveMetric = async (metricKey: string): Promise<"ok" | "skip" | "invalid"> => {
        const prev = this.loadedByMetric.get(metricKey);

        if (metricKey === "menstruation" && ctx.period === "month") {
          if (this.isMenstruationMonthFormEmpty()) {
            if (prev?.entryId) {
              workEvHadUpdateOrDelete = true;
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
              workEvHadUpdateOrDelete = true;
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
          return "invalid";
        }
        if (parts === "empty" && prev) {
          workEvHadUpdateOrDelete = true;
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
        if (ok) {
          if (prev?.entryId) workEvHadUpdateOrDelete = true;
          else workEvHadNewEntry = true;
          if (metricKey === "bp" && ctx.period === "week") {
            for (const lk of ["bp_systolic", "bp_diastolic"] as const) {
              const leg = this.loadedByMetric.get(lk);
              if (!leg?.entryId) continue;
              workEvHadUpdateOrDelete = true;
              await this.deleteOne({
                anchorDateKey: ctx.anchorDateKey,
                cardRef: ctx.cardRef,
                cardDisplay: ctx.cardDisplay,
                period: ctx.period,
                metricKey: lk,
                prev: leg,
                timeHm,
                journal,
              });
            }
          }
          if (metricKey === "glucose" && ctx.period === "month") {
            for (const lk of ["glucose_fasting", "glucose_postprandial"] as const) {
              const leg = this.loadedByMetric.get(lk);
              if (!leg?.entryId) continue;
              workEvHadUpdateOrDelete = true;
              await this.deleteOne({
                anchorDateKey: ctx.anchorDateKey,
                cardRef: ctx.cardRef,
                cardDisplay: ctx.cardDisplay,
                period: ctx.period,
                metricKey: lk,
                prev: leg,
                timeHm,
                journal,
              });
            }
          }
          if (metricKey === "menstruation" && ctx.period === "month") {
            for (const lk of [
              "menstruation_start",
              "menstruation_end",
              "menstruation_flow",
              "menstruation_cramps",
            ] as const) {
              const leg = this.loadedByMetric.get(lk);
              if (!leg?.entryId) continue;
              workEvHadUpdateOrDelete = true;
              await this.deleteOne({
                anchorDateKey: ctx.anchorDateKey,
                cardRef: ctx.cardRef,
                cardDisplay: ctx.cardDisplay,
                period: ctx.period,
                metricKey: lk,
                prev: leg,
                timeHm,
                journal,
              });
            }
          }
        }
        return ok ? "ok" : "skip";
      };

      if (ctx.period === "day") {
        for (const metricKey of ctx.metricKeys) {
          if (metricKey === "diet") {
            const heat = String(this.fieldVals.diet_heat ?? "").trim();
            const noteD = clampDietNoteChars(String(this.fieldVals.diet_note ?? ""), 100);
            const prevDiet = this.loadedByMetric.get("diet");
            const hasHeat = isDietHeatLevel(heat);

            if (!hasHeat && !noteD) {
              if (prevDiet) {
                workEvHadUpdateOrDelete = true;
                await this.deleteOne({
                  anchorDateKey: ctx.anchorDateKey,
                  cardRef: ctx.cardRef,
                  cardDisplay: ctx.cardDisplay,
                  period: "day",
                  metricKey: "diet",
                  prev: {
                    entryId: prevDiet.entryId,
                    valueStr: prevDiet.valueStr,
                    note: prevDiet.note,
                  },
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
              if (ok) {
                touched++;
                if (prevDiet?.entryId) workEvHadUpdateOrDelete = true;
                else workEvHadNewEntry = true;
              }

              const legacy = this.legacyDietRows.slice();
              this.legacyDietRows = [];
              for (const leg of legacy) {
                workEvHadUpdateOrDelete = true;
                await this.deleteOne({
                  anchorDateKey: ctx.anchorDateKey,
                  cardRef: ctx.cardRef,
                  cardDisplay: ctx.cardDisplay,
                  period: "day",
                  metricKey: leg.metricKey,
                  prev: { entryId: leg.entryId, valueStr: leg.valueStr, note: leg.note },
                  timeHm,
                  journal,
                });
                touched++;
              }
            }
            continue;
          }

          const r = await saveMetric(metricKey);
          if (r === "invalid") {
            if (metricKey === "weight") {
              const e = this.validateMetric("weight", String(this.fieldVals.weight ?? ""));
              if (e) new Notice(e);
            }
            return;
          }
          if (r === "ok") touched++;
        }
      } else if (ctx.period === "month") {
        for (const metricKey of ctx.metricKeys) {
          const r = await saveMetric(metricKey);
          if (r === "invalid") return;
          if (r === "ok") touched++;
        }
      } else {
        for (const metricKey of ctx.metricKeys) {
          const r = await saveMetric(metricKey);
          if (r === "invalid") return;
          if (r === "ok") touched++;
        }
      }

      if (touched === 0) {
        new Notice("没有可保存的字段（请至少填写一项）");
        return;
      }

      const workEventAction: "create" | "update" =
        workEvHadNewEntry && !workEvHadUpdateOrDelete ? "create" : "update";
      const periodZh = ctx.period === "day" ? "日" : ctx.period === "week" ? "周" : "月";
      try {
        await this.plugin.workEventSvc?.append({
          ts: toLocalOffsetIsoString(),
          kind: "health",
          action: workEventAction,
          source: "ui",
          ref: {
            period: ctx.period,
            card_ref: ctx.cardRef,
            anchor_date: ctx.anchorDateKey,
          },
          summary:
            workEventAction === "create"
              ? `健康${periodZh}卡片 ${ctx.cardDisplay} 新建记录（${touched} 项）`
              : `健康${periodZh}卡片 ${ctx.cardDisplay} 已保存（${touched} 项）`,
        });
      } catch {
        // ignore
      }

      new Notice("健康卡片已保存");
      this.close();
      this.opts.onSuccess?.(ctx.anchorDateKey);
      this.plugin.refreshSidePanel();
    } catch (e: any) {
      new Notice(`保存失败：${e?.message ?? String(e)}`);
    } finally {
      this.saveBtn.setDisabled(false);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** 兼容旧入口：等同于 HealthCardModal */
export class AddHealthRecordModal extends HealthCardModal {
  constructor(app: App, plugin: RSLattePlugin, onSuccess?: (dateKey?: string) => void) {
    super(app, plugin, { onSuccess });
  }
}
