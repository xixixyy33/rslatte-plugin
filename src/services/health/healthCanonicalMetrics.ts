import moment from "moment";
import {
  HEALTH_DAY_CARD_METRICS,
  HEALTH_MONTH_CARD_METRICS,
  HEALTH_WEEK_CARD_METRICS,
} from "../../types/healthTypes";
import type { HealthRecordIndexItem } from "../../types/recordIndexTypes";
import {
  formatDayCardRef,
  formatMonthCardRef,
  inferCardRefFromItem,
  mondayKeyOfIsoWeek,
  parseDayCardRef,
  parseMonthCardRef,
  parseWeekCardRef,
  weekCardFromAnyDateKey,
} from "./healthCardRef";

const momentFn = moment as any;

/** 合并后的 9 个健康数据项（与清单下拉、设置勾选、今日打卡行一致） */
export type HealthCanonicalMetricKey =
  | "weight"
  | "water_cups"
  | "sleep_hours"
  | "diet"
  | "waist"
  | "bp"
  | "rhr"
  | "glucose"
  | "menstruation";

export const HEALTH_CANONICAL_METRICS_ORDER: readonly HealthCanonicalMetricKey[] = [
  "weight",
  "water_cups",
  "sleep_hours",
  "diet",
  "waist",
  "bp",
  "rhr",
  "glucose",
  "menstruation",
] as const;

export const HEALTH_CANONICAL_DAY_KEYS = HEALTH_DAY_CARD_METRICS;
export const HEALTH_CANONICAL_WEEK_KEYS = HEALTH_WEEK_CARD_METRICS;
export const HEALTH_CANONICAL_MONTH_KEYS = HEALTH_MONTH_CARD_METRICS;

/** 索引 metric_key → 合并项（用于筛选匹配、热力图、标题） */
export function normalizeIndexMetricKeyToCanonical(mk: string): HealthCanonicalMetricKey | null {
  const k = String(mk ?? "").trim();
  if (!k) return null;
  if (k === "diet_level" || k === "diet_text" || k === "diet") return "diet";
  if (k === "glucose_fasting" || k === "glucose_postprandial" || k === "glucose") return "glucose";
  if (k.startsWith("menstruation")) return "menstruation";
  if (k === "bp_systolic" || k === "bp_diastolic" || k === "bp") return "bp";
  if ((HEALTH_CANONICAL_METRICS_ORDER as readonly string[]).includes(k)) return k as HealthCanonicalMetricKey;
  return null;
}

/** 某合并项对应的所有索引 metric_key（含兼容旧拆行） */
export function expandCanonicalHealthMetricForFilter(canonical: string): string[] {
  const c = String(canonical ?? "").trim();
  if (c === "diet") return ["diet", "diet_level", "diet_text"];
  if (c === "glucose") return ["glucose", "glucose_fasting", "glucose_postprandial"];
  if (c === "menstruation") {
    return ["menstruation", "menstruation_start", "menstruation_end", "menstruation_flow", "menstruation_cramps"];
  }
  if (c === "bp") return ["bp", "bp_systolic", "bp_diastolic"];
  return [c];
}

/** 短标签：与产品「9 项」文案一致（清单下拉、今日打卡行标题） */
export function healthCanonicalShortLabelZh(k: HealthCanonicalMetricKey): string {
  const m: Record<HealthCanonicalMetricKey, string> = {
    weight: "体重",
    water_cups: "饮水量",
    sleep_hours: "睡眠",
    diet: "饮食",
    waist: "腰围",
    bp: "血压",
    rhr: "心率",
    glucose: "血糖",
    menstruation: "月经",
  };
  return m[k] ?? k;
}

export function healthCanonicalToPeriod(k: HealthCanonicalMetricKey): "day" | "week" | "month" {
  if ((HEALTH_DAY_CARD_METRICS as readonly string[]).includes(k)) return "day";
  if ((HEALTH_WEEK_CARD_METRICS as readonly string[]).includes(k)) return "week";
  return "month";
}

/** 缺省视为启用；不自动改数据（校验在设置页保存时做） */
export function readHealthMetricsEnabledFlags(healthPanel: any): Record<HealthCanonicalMetricKey, boolean> {
  const raw = healthPanel?.healthMetricsEnabled ?? {};
  const out = {} as Record<HealthCanonicalMetricKey, boolean>;
  for (const key of HEALTH_CANONICAL_METRICS_ORDER) {
    out[key] = raw[key] !== false;
  }
  return out;
}

/**
 * UI 用：若日维全部被关（异常/旧数据），至少保留体重，避免健康卡片与热力图无日页签可用。
 */
export function readHealthMetricsEnabledForUi(healthPanel: any): Record<HealthCanonicalMetricKey, boolean> {
  const out = readHealthMetricsEnabledFlags(healthPanel);
  const anyDay = HEALTH_CANONICAL_DAY_KEYS.some((k) => out[k]);
  if (!anyDay) out.weight = true;
  return out;
}

export function countEnabledDayMetrics(healthPanel: any): number {
  const f = readHealthMetricsEnabledFlags(healthPanel);
  return HEALTH_CANONICAL_DAY_KEYS.filter((k) => f[k]).length;
}

export function itemMatchesCanonicalMetricFilter(it: HealthRecordIndexItem, canonicalFilter: string): boolean {
  if (!canonicalFilter) return true;
  const mk = String(it.metricKey ?? "").trim();
  const exp = new Set(expandCanonicalHealthMetricForFilter(canonicalFilter));
  if (exp.has(mk)) return true;
  return normalizeIndexMetricKeyToCanonical(mk) === canonicalFilter;
}

/** 合并项内优先主存盘 key（如 bp 优于 bp_systolic），其次按 expand 顺序 */
function metricKeyRankForCanonical(canonical: HealthCanonicalMetricKey, mk: string): number {
  const order = expandCanonicalHealthMetricForFilter(canonical);
  const idx = order.indexOf(String(mk ?? "").trim());
  return idx < 0 ? 999 : idx;
}

/**
 * 今日打卡侧栏：当前自然日对应的卡片上，该合并项最新一条有效（非删除）索引行。
 * - 日卡：D:todayKey
 * - 周卡：含 today 的 ISO 周
 * - 月卡：today 所在自然月 M:YYYY-MM
 */
export function findLatestActiveHealthItemForCanonicalToday(
  items: HealthRecordIndexItem[] | undefined,
  canonical: HealthCanonicalMetricKey,
  todayKey: string,
): HealthRecordIndexItem | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(todayKey)) return null;
  const period = healthCanonicalToPeriod(canonical);
  const wantKeys = new Set(expandCanonicalHealthMetricForFilter(canonical));
  const list = items ?? [];

  let wantCardRef = "";
  if (period === "day") {
    wantCardRef = formatDayCardRef(todayKey);
  } else if (period === "week") {
    wantCardRef = String(weekCardFromAnyDateKey(todayKey).cardRef ?? "").trim();
  } else {
    const y = Number(todayKey.slice(0, 4));
    const mon = Number(todayKey.slice(5, 7));
    wantCardRef = formatMonthCardRef(y, mon);
  }
  if (!wantCardRef) return null;

  const candidates: HealthRecordIndexItem[] = [];
  for (const it of list) {
    if (it.isDelete) continue;
    const p = String(it.period ?? "day").trim().toLowerCase();
    if (p !== period) continue;
    const mk = String(it.metricKey ?? "").trim();
    if (!wantKeys.has(mk)) continue;
    const ir = inferCardRefFromItem({
      recordDate: it.recordDate,
      period: it.period,
      cardRef: it.cardRef,
    });
    if (ir !== wantCardRef) continue;
    candidates.push(it);
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const rk = metricKeyRankForCanonical(canonical, a.metricKey) - metricKeyRankForCanonical(canonical, b.metricKey);
    if (rk !== 0) return rk;
    return (Number(b.tsMs) || 0) - (Number(a.tsMs) || 0);
  });
  return candidates[0] ?? null;
}

function naturalDaysCoveredByItem(
  it: HealthRecordIndexItem,
  windowStart: ReturnType<typeof momentFn>,
  windowEnd: ReturnType<typeof momentFn>,
): string[] {
  const p = String(it.period ?? "day").trim().toLowerCase();
  const cref = inferCardRefFromItem({
    recordDate: it.recordDate,
    period: it.period,
    cardRef: it.cardRef,
  });

  if (p === "day") {
    const d = parseDayCardRef(cref) || String(it.recordDate ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return [];
    const m = momentFn(d, "YYYY-MM-DD", true);
    if (!m.isValid()) return [];
    if (m.isBefore(windowStart, "day") || m.isAfter(windowEnd, "day")) return [];
    return [d];
  }

  if (p === "week") {
    const w = parseWeekCardRef(cref);
    if (!w) return [];
    const mon = mondayKeyOfIsoWeek(w.isoYear, w.isoWeek);
    const out: string[] = [];
    let cur = momentFn(mon, "YYYY-MM-DD", true);
    for (let i = 0; i < 7; i++) {
      if (!cur.isBefore(windowStart, "day") && !cur.isAfter(windowEnd, "day")) {
        out.push(cur.format("YYYY-MM-DD"));
      }
      cur = cur.clone().add(1, "day");
    }
    return out;
  }

  if (p === "month") {
    const mo = parseMonthCardRef(cref);
    if (!mo) return [];
    let cur = momentFn(`${mo.y}-${String(mo.m).padStart(2, "0")}-01`, "YYYY-MM-DD", true);
    if (!cur.isValid()) return [];
    const out: string[] = [];
    while (cur.month() === mo.m - 1 && cur.year() === mo.y) {
      if (!cur.isBefore(windowStart, "day") && !cur.isAfter(windowEnd, "day")) {
        out.push(cur.format("YYYY-MM-DD"));
      }
      cur = cur.clone().add(1, "day");
    }
    return out;
  }

  return [];
}

/**
 * 最近 30 个自然日（含今天）：该合并项是否有「有效」记录落在该日（周卡铺 7 天、月卡铺当月内落在窗口的日）。
 * 返回长度 30，下标 0 = 最早一天。
 */
export function buildHealthCanonicalHeatPresence(
  items: HealthRecordIndexItem[] | undefined,
  canonical: HealthCanonicalMetricKey,
  todayKey: string,
): boolean[] {
  const end = momentFn(todayKey, "YYYY-MM-DD", true);
  if (!end.isValid()) return Array(30).fill(false);
  const start = end.clone().subtract(29, "days");
  const dayList: string[] = [];
  for (let off = 29; off >= 0; off--) {
    dayList.push(end.clone().subtract(off, "days").format("YYYY-MM-DD"));
  }

  const want = new Set(expandCanonicalHealthMetricForFilter(canonical));
  const perDay = new Map<string, { ts: number; del: boolean }>();

  const list = items ?? [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    const mk = String(it.metricKey ?? "").trim();
    if (!want.has(mk) && normalizeIndexMetricKeyToCanonical(mk) !== canonical) continue;

    const days = naturalDaysCoveredByItem(it, start, end);
    const ts = typeof it.tsMs === "number" && Number.isFinite(it.tsMs) ? it.tsMs : i;
    const del = !!it.isDelete;
    for (const d of days) {
      const cur = perDay.get(d);
      if (!cur || ts >= cur.ts) perDay.set(d, { ts, del });
    }
  }

  return dayList.map((d) => {
    const st = perDay.get(d);
    return !!st && !st.del;
  });
}
