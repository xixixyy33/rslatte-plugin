import { moment, normalizePath } from "obsidian";
import type { HealthRecordIndexItem } from "../../types/recordIndexTypes";
import { fnv1a32 } from "../../utils/hash";
import {
  HEALTH_CANONICAL_METRICS_ORDER,
  normalizeIndexMetricKeyToCanonical,
  readHealthMetricsEnabledFlags,
  type HealthCanonicalMetricKey,
} from "./healthCanonicalMetrics";
import {
  inferCardRefFromItem,
  mondayKeyOfIsoWeek,
  parseDayCardRef,
  parseMonthCardRef,
  parseWeekCardRef,
} from "./healthCardRef";
import {
  mapLegacyDietLevelToHeat,
  parseBloodPressureStorage,
  parseGlucoseMonthStorage,
  parseMenstruationMonthStorage,
} from "../../types/healthTypes";
import {
  isHealthRuleOrBaseAlertEnabled,
  isHealthStatsMetricOutputEnabled,
} from "./healthAnalysisGenerationCatalog";
import { rotateAnalysisSnapshotBeforeWrite, rollbackOneAnalysisSnapshot } from "../../utils/analysisSnapshotRotate";

const momentFn = moment as any;

/** 单日聚合单元（日卡去重） */
type DayAggCell = {
  weight?: { ts: number; v: number };
  water?: { ts: number; cups: number };
  sleep?: { ts: number; h: number };
  dietMaxRank: number;
  dietHadRecord: boolean;
};

export type HealthStatsSnapshotFile = {
  version: 1;
  generatedAt: string;
  spaceId: string;
  mode: string;
  grain: "month";
  periodKey: string;
  summary: {
    validCount: number;
    byPeriod: { day: number; week: number; month: number };
    canonicalTally: Partial<Record<HealthCanonicalMetricKey, number>>;
  };
  /** 各合并项在该月内最后一条（按 tsMs）的预览 */
  latestByCanonical: Partial<
    Record<
      HealthCanonicalMetricKey,
      { recordDate: string; valueStr: string; period: string; entryId?: string }
    >
  >;
  /** 衍生指标：对齐 `05-记录类管理优化方案.md` §四「指标体系（统计页签）」中可在自然月内聚合的部分 */
  derived: {
    sleepUnder7Days: number;
    sleepUnder5Days: number;
    /** 日卡·有体重记录的天数；均值/极值均按「每自然日取最新一条」 */
    avgWeight?: number;
    weightSamples: number;
    /** 本月自然日天数 */
    daysInMonth?: number;
    sleepRecordedDays?: number;
    sleepAvgHours?: number;
    maxConsecutiveSleepUnder7?: number;
    maxConsecutiveSleepUnder5?: number;
    waterRecordedDays?: number;
    waterGoalMetDays?: number;
    /** 有饮水记录的日子中，达标（杯数≥目标）占比 0–1 */
    waterGoalMetRateAmongRecorded?: number;
    waterAvgCups?: number;
    weightMin?: number;
    weightMax?: number;
    /** 按日期升序：首末日体重差（kg） */
    weightDeltaFirstLastKg?: number;
    dietRecordedDays?: number;
    /** 主行热量档为 🔥🔥🔥 的天数 */
    dietHighHeatDays?: number;
    dietHighHeatRateAmongRecorded?: number;
    waistLatestCm?: number;
    waistWeekRecordsInMonth?: number;
    bpLatestSystolic?: number;
    bpLatestDiastolic?: number;
    bpWeekRecordsInMonth?: number;
    rhrLatestBpm?: number;
    rhrAvgBpm?: number;
    rhrWeekRecordsInMonth?: number;
    /** 月内有体重记录的相邻自然日之间，体重变化绝对值的最大值（kg） */
    weightMaxAdjacentDeltaKg?: number;
  };
  /** 以 anchor 日为截止：近 7 / 30 自然日滚动窗口（日卡按日去重，数据取自全索引含归档） */
  rolling?: HealthRollingSnapshot;
  alertSummary: {
    total: number;
    high: number;
    warning: number;
    notice: number;
  };
};

export type HealthRollingBucketMetrics = {
  sleepAvgHours?: number;
  sleepDaysRecorded?: number;
  waterAvgCups?: number;
  waterDaysRecorded?: number;
  waterGoalMetRateAmongRecorded?: number;
  weightAvgKg?: number;
  weightDaysRecorded?: number;
  /** 紧邻的前 7 个自然日（anchor-13～anchor-7）体重日均 */
  weightAvgPrev7Kg?: number;
  /** 近 7 日体重日均 − 前一 7 日体重日均（kg） */
  weightDelta7VsPrev7Kg?: number;
  dietHighHeatDays?: number;
  dietDaysRecorded?: number;
  /** 窗口内每个自然日都要求「已启用的日数据项」均有记录的天数占比（分母为窗口天数） */
  dayFullCompletionRate?: number;
};

export type HealthRollingSnapshot = {
  anchorYmd: string;
  last7Days: HealthRollingBucketMetrics;
  last30Days: HealthRollingBucketMetrics;
};

export type HealthEnabledDayMetrics = {
  weight: boolean;
  water_cups: boolean;
  sleep_hours: boolean;
  diet: boolean;
};

export type HealthRuleAlertContext = {
  derived: HealthStatsSnapshotFile["derived"];
  rolling?: HealthRollingSnapshot;
  waterGoalCups: number;
  allItems: HealthRecordIndexItem[];
  enabledDayMetrics: HealthEnabledDayMetrics;
  /** 截止 anchor 的近 7 日日卡图（与 rolling 一致） */
  rollDayMap7: Map<string, DayAggCell>;
  rollD7Dates: string[];
};

export type HealthAlertSnapshotItem = {
  ruleId: string;
  severity: "high" | "warning" | "notice";
  title: string;
  message: string;
  effectivePeriod: string;
  detectedAt: string;
  relatedEntryIds?: string[];
  status: "new" | "ongoing" | "resolved" | "ignored";
  alertFingerprint: string;
};

export type HealthAlertsSnapshotFile = {
  version: 1;
  generatedAt: string;
  spaceId: string;
  mode: string;
  grain: "month";
  periodKey: string;
  summary: {
    total: number;
    high: number;
    warning: number;
    notice: number;
  };
  statusSummary?: {
    new: number;
    ongoing: number;
    resolved: number;
    ignored: number;
  };
  items: HealthAlertSnapshotItem[];
};

export type HealthAnalysisIndexFile = {
  version: 1;
  generatedAt: string;
  spaceId: string;
  mode: string;
  latest: {
    periodKey: string;
    summary: HealthStatsSnapshotFile["summary"];
    alertSummary: HealthStatsSnapshotFile["alertSummary"];
  };
  snapshots: Array<{
    periodKey: string;
    statsRef: string;
    alertsRef: string;
    summary: HealthStatsSnapshotFile["summary"];
    alertSummary: HealthStatsSnapshotFile["alertSummary"];
  }>;
};

async function ensureFolder(plugin: any, path: string): Promise<void> {
  const p = normalizePath(String(path ?? "").trim());
  if (!p) return;
  const exists = await plugin.app.vault.adapter.exists(p);
  if (exists) return;
  const parts = p.split("/");
  let cur = "";
  for (const seg of parts) {
    cur = cur ? `${cur}/${seg}` : seg;
    const ok = await plugin.app.vault.adapter.exists(cur);
    if (!ok) {
      try {
        await plugin.app.vault.createFolder(cur);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (msg.includes("Folder already exists") || msg.includes("EEXIST")) continue;
        throw e;
      }
    }
  }
}

function parseJsonSafe(raw: string): any | null {
  try {
    const j = JSON.parse(String(raw ?? ""));
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

/** 该索引行是否落在自然月 periodKey（YYYY-MM）内 */
export function healthItemTouchesMonth(it: HealthRecordIndexItem, monthKey: string): boolean {
  if (it.isDelete) return false;
  const cref = inferCardRefFromItem({
    recordDate: it.recordDate,
    period: it.period,
    cardRef: it.cardRef,
  });
  const p = String(it.period ?? "day").trim().toLowerCase();
  if (p === "month") {
    const m = parseMonthCardRef(cref);
    if (m) return `${m.y}-${String(m.m).padStart(2, "0")}` === monthKey;
  }
  if (p === "week") {
    const w = parseWeekCardRef(cref);
    if (w) {
      const mon = mondayKeyOfIsoWeek(w.isoYear, w.isoWeek);
      let cur = momentFn(mon, "YYYY-MM-DD", true);
      if (!cur.isValid()) return false;
      for (let i = 0; i < 7; i++) {
        if (cur.format("YYYY-MM") === monthKey) return true;
        cur = cur.clone().add(1, "day");
      }
      return false;
    }
  }
  const d = parseDayCardRef(cref) || String(it.recordDate ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d.slice(0, 7) === monthKey;
  const rd = String(it.recordDate ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(rd)) return rd.slice(0, 7) === monthKey;
  return false;
}

function countSeverity(items: Array<{ severity?: string }>): { high: number; warning: number; notice: number } {
  let high = 0;
  let warning = 0;
  let notice = 0;
  for (const it of items) {
    const s = String(it?.severity ?? "notice").toLowerCase();
    if (s === "high") high++;
    else if (s === "warning") warning++;
    else notice++;
  }
  return { high, warning, notice };
}

function countStatus(items: Array<{ status?: string }>) {
  let nNew = 0;
  let ongoing = 0;
  let resolved = 0;
  let ignored = 0;
  for (const it of items) {
    const s = String(it?.status ?? "new");
    if (s === "ongoing") ongoing++;
    else if (s === "resolved") resolved++;
    else if (s === "ignored") ignored++;
    else nNew++;
  }
  return { new: nNew, ongoing, resolved, ignored };
}

function buildAlertFingerprint(ruleId: string, effectivePeriod: string, related: string[]): string {
  const rel = related.slice().sort().join(",");
  return fnv1a32(`${ruleId}|${effectivePeriod}|${rel}`);
}

function buildHealthRuleAlerts(
  monthItems: HealthRecordIndexItem[],
  monthKey: string,
  ctx?: HealthRuleAlertContext,
): Omit<HealthAlertSnapshotItem, "status" | "alertFingerprint">[] {
  const out: Omit<HealthAlertSnapshotItem, "status" | "alertFingerprint">[] = [];
  const nowIso = new Date().toISOString();

  for (const it of monthItems) {
    if (it.isDelete) continue;
    const mk = String(it.metricKey ?? "").trim();
    const eid = String(it.entryId ?? "").trim();
    const rel = eid ? [eid] : [];

    if (mk === "sleep_hours") {
      const h = parseInt(String(it.valueStr ?? "").trim(), 10);
      if (Number.isFinite(h) && h < 5) {
        out.push({
          ruleId: "HEALTH_RULE_SLEEP_LT_5H",
          severity: "high",
          title: "睡眠过少（日）",
          message: `${it.recordDate} 记录睡眠 ${h} 小时，低于 5 小时。`,
          effectivePeriod: monthKey,
          detectedAt: nowIso,
          relatedEntryIds: rel.length ? rel : undefined,
        });
      } else if (Number.isFinite(h) && h < 6) {
        out.push({
          ruleId: "HEALTH_RULE_SLEEP_LT_6H",
          severity: "warning",
          title: "睡眠偏少（日）",
          message: `${it.recordDate} 记录睡眠 ${h} 小时，低于 6 小时。`,
          effectivePeriod: monthKey,
          detectedAt: nowIso,
          relatedEntryIds: rel.length ? rel : undefined,
        });
      } else if (Number.isFinite(h) && h < 7) {
        out.push({
          ruleId: "HEALTH_RULE_SLEEP_LT_7H",
          severity: "notice",
          title: "睡眠不足（日·提示）",
          message: `${it.recordDate} 记录睡眠 ${h} 小时，低于 7 小时。`,
          effectivePeriod: monthKey,
          detectedAt: nowIso,
          relatedEntryIds: rel.length ? rel : undefined,
        });
      }
    }

    if (mk === "bp" || mk === "bp_systolic" || mk === "bp_diastolic") {
      const pr = parseBloodPressureStorage(String(it.valueStr ?? ""));
      if (!pr) continue;
      const { systolic: s, diastolic: d } = pr;
      if (s > 180 || d > 120) {
        out.push({
          ruleId: "HEALTH_RULE_BP_EMERGENCY",
          severity: "high",
          title: "血压达到紧急关注线（周）",
          message: `${it.recordDate} 血压 ${s}/${d} mmHg（参考：收缩压>180 或 舒张压>120 建议尽快复测/就医）。`,
          effectivePeriod: monthKey,
          detectedAt: nowIso,
          relatedEntryIds: rel.length ? rel : undefined,
        });
      } else if (s >= 140 || d >= 90) {
        out.push({
          ruleId: "HEALTH_RULE_BP_HIGH",
          severity: "warning",
          title: "血压偏高（周）",
          message: `${it.recordDate} 血压 ${s}/${d} mmHg，达到 140/90 关注阈值。`,
          effectivePeriod: monthKey,
          detectedAt: nowIso,
          relatedEntryIds: rel.length ? rel : undefined,
        });
      } else if ((s >= 130 && s <= 139) || (d >= 80 && d <= 89)) {
        out.push({
          ruleId: "HEALTH_RULE_BP_STAGE1",
          severity: "notice",
          title: "血压升高一期（周）",
          message: `${it.recordDate} 血压 ${s}/${d} mmHg，收缩压 130–139 或 舒张压 80–89（未达 140/90），建议关注与复测。`,
          effectivePeriod: monthKey,
          detectedAt: nowIso,
          relatedEntryIds: rel.length ? rel : undefined,
        });
      }
    }

    if (mk === "rhr") {
      const r = parseInt(String(it.valueStr ?? "").trim(), 10);
      if (!Number.isFinite(r) || r <= 0) continue;
      if (r > 100) {
        out.push({
          ruleId: "HEALTH_RULE_RHR_HIGH",
          severity: "high",
          title: "心率偏高（周）",
          message: `${it.recordDate} 心率 ${r} 次/分，高于 100。`,
          effectivePeriod: monthKey,
          detectedAt: nowIso,
          relatedEntryIds: rel.length ? rel : undefined,
        });
      } else if (r >= 90) {
        out.push({
          ruleId: "HEALTH_RULE_RHR_BORDERLINE_HIGH",
          severity: "warning",
          title: "心率偏高边缘（周）",
          message: `${it.recordDate} 心率 ${r} 次/分，处于 90–100 区间，建议结合状态复测。`,
          effectivePeriod: monthKey,
          detectedAt: nowIso,
          relatedEntryIds: rel.length ? rel : undefined,
        });
      } else if (r < 50) {
        out.push({
          ruleId: "HEALTH_RULE_RHR_LOW",
          severity: "notice",
          title: "心率偏低（关注）",
          message: `${it.recordDate} 心率 ${r} 次/分，低于 50，若无症状可继续观察，不适请就医。`,
          effectivePeriod: monthKey,
          detectedAt: nowIso,
          relatedEntryIds: rel.length ? rel : undefined,
        });
      }
    }

    if (mk === "glucose") {
      const g = parseGlucoseMonthStorage(String(it.valueStr ?? ""));
      if (!g) continue;
      const f = parseFloat(g.fasting);
      const p2 = parseFloat(g.post2h);
      const dmF = Number.isFinite(f) && f >= 7.0;
      const dmP2 = Number.isFinite(p2) && p2 >= 11.1;
      if (dmF || dmP2) {
        out.push({
          ruleId: "HEALTH_RULE_GLUCOSE_DM_RANGE",
          severity: "high",
          title: "血糖达到糖尿病诊断参考线（月）",
          message: `血糖记录：空腹 ${g.fasting} / 餐后2h ${g.post2h} mmol/L（参考：空腹≥7.0 或 餐后2h≥11.1 须尽快就医确认）。`,
          effectivePeriod: monthKey,
          detectedAt: nowIso,
          relatedEntryIds: rel.length ? rel : undefined,
        });
      } else {
        const attF = Number.isFinite(f) && f >= 6.2;
        const attP2 = Number.isFinite(p2) && p2 >= 7.9;
        if (attF || attP2) {
          out.push({
            ruleId: "HEALTH_RULE_GLUCOSE_ATTENTION",
            severity: "warning",
            title: "血糖需关注（月）",
            message: `血糖记录：空腹 ${g.fasting} / 餐后2h ${g.post2h} mmol/L（已达关注线：空腹≥6.2 或 餐后≥7.9）。`,
            effectivePeriod: monthKey,
            detectedAt: nowIso,
            relatedEntryIds: rel.length ? rel : undefined,
          });
        } else {
          const borF = Number.isFinite(f) && f >= 5.6 && f < 6.2;
          const borP2 = Number.isFinite(p2) && p2 >= 7.8 && p2 < 7.9;
          if (borF || borP2) {
            out.push({
              ruleId: "HEALTH_RULE_GLUCOSE_BORDERLINE",
              severity: "notice",
              title: "血糖边界值（月）",
              message: `血糖记录：空腹 ${g.fasting} / 餐后2h ${g.post2h} mmol/L，接近关注阈值，建议规律监测。`,
              effectivePeriod: monthKey,
              detectedAt: nowIso,
              relatedEntryIds: rel.length ? rel : undefined,
            });
          }
        }
      }
    }

    if (mk === "menstruation") {
      const pm = parseMenstruationMonthStorage(String(it.valueStr ?? ""));
      if (!pm) continue;
      const sd = momentFn(pm.start, "YYYY-MM-DD", true);
      const ed = momentFn(pm.end, "YYYY-MM-DD", true);
      if (sd.isValid() && ed.isValid()) {
        const dur = ed.diff(sd, "days") + 1;
        if (dur > 7) {
          out.push({
            ruleId: "HEALTH_RULE_MENSES_LONG",
            severity: "warning",
            title: "经期偏长（月）",
            message: `本次记录经期 ${dur} 天（起止 ${pm.start}～${pm.end}），超过 7 天建议关注。`,
            effectivePeriod: monthKey,
            detectedAt: nowIso,
            relatedEntryIds: rel.length ? rel : undefined,
          });
        }
        if (pm.flow >= 5) {
          out.push({
            ruleId: "HEALTH_RULE_MENSES_FLOW_HIGH",
            severity: "notice",
            title: "月经量档偏高（月）",
            message: `本次月经量记录为最高档（🩸5），若出血量明显偏大建议就医评估。`,
            effectivePeriod: monthKey,
            detectedAt: nowIso,
            relatedEntryIds: rel.length ? rel : undefined,
          });
        }
      }
    }
  }

  if (ctx) {
    const { derived, rolling, waterGoalCups, allItems, enabledDayMetrics, rollDayMap7, rollD7Dates } = ctx;
    const anchor = rolling?.anchorYmd ?? "";

    if ((derived.maxConsecutiveSleepUnder7 ?? 0) >= 3) {
      out.push({
        ruleId: "HEALTH_RULE_SLEEP_STREAK_LT7",
        severity: "warning",
        title: "连续多日睡眠偏少",
        message: `本月存在最长 ${derived.maxConsecutiveSleepUnder7} 天连续睡眠 <7 小时（自然日有记录即计入 streak）。`,
        effectivePeriod: monthKey,
        detectedAt: nowIso,
      });
    }
    if ((derived.maxConsecutiveSleepUnder5 ?? 0) >= 5) {
      out.push({
        ruleId: "HEALTH_RULE_SLEEP_STREAK_LT5",
        severity: "high",
        title: "连续多日睡眠过少",
        message: `本月存在最长 ${derived.maxConsecutiveSleepUnder5} 天连续睡眠 <5 小时，请关注作息与健康状况。`,
        effectivePeriod: monthKey,
        detectedAt: nowIso,
      });
    }
    if ((derived.weightMaxAdjacentDeltaKg ?? 0) >= 1.5) {
      out.push({
        ruleId: "HEALTH_RULE_WEIGHT_DAY_JUMP",
        severity: "notice",
        title: "相邻日体重波动较大",
        message: `本月相邻有记录自然日之间，体重最大波动 ${derived.weightMaxAdjacentDeltaKg} kg（≥1.5），多为水分/饮食波动，持续上升可结合饮食与睡眠看。`,
        effectivePeriod: monthKey,
        detectedAt: nowIso,
      });
    }

    const d7 = rolling?.last7Days;
    if (d7) {
      if (
        (d7.sleepDaysRecorded ?? 0) >= 4 &&
        d7.sleepAvgHours != null &&
        d7.sleepAvgHours < 6
      ) {
        out.push({
          ruleId: "HEALTH_RULE_SLEEP_ROLL7_AVG_LT6",
          severity: "warning",
          title: "近7日平均睡眠偏少",
          message: `截至 ${anchor}，近 7 个自然日有 ${d7.sleepDaysRecorded} 天睡眠记录，平均 ${d7.sleepAvgHours} h（<6）。`,
          effectivePeriod: monthKey,
          detectedAt: nowIso,
        });
      } else if (
        (d7.sleepDaysRecorded ?? 0) >= 3 &&
        d7.sleepAvgHours != null &&
        d7.sleepAvgHours < 7
      ) {
        out.push({
          ruleId: "HEALTH_RULE_SLEEP_ROLL7_AVG_LT7",
          severity: "notice",
          title: "近7日平均睡眠不足",
          message: `截至 ${anchor}，近 7 个自然日有 ${d7.sleepDaysRecorded} 天睡眠记录，平均 ${d7.sleepAvgHours} h（<7）。`,
          effectivePeriod: monthKey,
          detectedAt: nowIso,
        });
      }
      if (
        d7.dayFullCompletionRate != null &&
        d7.dayFullCompletionRate < 0.7 &&
        (enabledDayMetrics.weight ||
          enabledDayMetrics.water_cups ||
          enabledDayMetrics.sleep_hours ||
          enabledDayMetrics.diet)
      ) {
        out.push({
          ruleId: "HEALTH_RULE_DAY_FULL_ROLL7_LT70",
          severity: "notice",
          title: "近7日「日卡全项」完成率偏低",
          message: `截至 ${anchor}，按当前启用的日卡项统计，近 7 个自然日「各项均有记录」的占比约 ${Math.round(d7.dayFullCompletionRate * 100)}%（<70%）。`,
          effectivePeriod: monthKey,
          detectedAt: nowIso,
        });
      }
      {
        let sleepRec = 0;
        let allRecordedUnder7 = true;
        for (const dk of rollD7Dates) {
          const h = rollDayMap7.get(dk)?.sleep?.h;
          if (h === undefined) continue;
          sleepRec++;
          if (h >= 7) allRecordedUnder7 = false;
        }
        if (rollD7Dates.length >= 5 && sleepRec >= 5 && allRecordedUnder7) {
          out.push({
            ruleId: "HEALTH_RULE_SLEEP_ROLL7_ALL_DAYS_LT7H",
            severity: "notice",
            title: "近7个自然日睡眠均不足7小时",
            message: `截至 ${anchor}，近 7 个自然日中，凡有睡眠记录的日期均 <7 小时（至少 5 天有记录）。`,
            effectivePeriod: monthKey,
            detectedAt: nowIso,
          });
        }
      }
      if (
        (d7.dietDaysRecorded ?? 0) >= 4 &&
        (d7.dietHighHeatDays ?? 0) >= 4
      ) {
        out.push({
          ruleId: "HEALTH_RULE_DIET_HIGH_STREAK7",
          severity: "warning",
          title: "近7日高热量饮食偏多",
          message: `截至 ${anchor}，近 7 日中有 ${d7.dietHighHeatDays} 天为高热量档（🔥🔥🔥），且不少于 4 天有饮食记录。`,
          effectivePeriod: monthKey,
          detectedAt: nowIso,
        });
      }
      if (
        (d7.waterDaysRecorded ?? 0) >= 5 &&
        d7.waterGoalMetRateAmongRecorded != null &&
        d7.waterGoalMetRateAmongRecorded < 0.5
      ) {
        out.push({
          ruleId: "HEALTH_RULE_WATER_LOW_ROLL7",
          severity: "warning",
          title: "近7日饮水达标率偏低",
          message: `截至 ${anchor}，近 7 日有饮水记录 ${d7.waterDaysRecorded} 天，达标（≥${waterGoalCups} 杯）占比 ${Math.round((d7.waterGoalMetRateAmongRecorded ?? 0) * 100)}%。`,
          effectivePeriod: monthKey,
          detectedAt: nowIso,
        });
      }
      if (d7.weightDelta7VsPrev7Kg != null && d7.weightDelta7VsPrev7Kg >= 1) {
        out.push({
          ruleId: "HEALTH_RULE_WEIGHT_7D_UP",
          severity: "notice",
          title: "近7日体重均值上升",
          message: `截至 ${anchor}，近 7 日体重日均较前 7 日上升约 ${d7.weightDelta7VsPrev7Kg} kg（≥1）。`,
          effectivePeriod: monthKey,
          detectedAt: nowIso,
        });
      }
    }

    const d30 = rolling?.last30Days;
    if (
      d30 &&
      (d30.sleepDaysRecorded ?? 0) >= 10 &&
      d30.sleepAvgHours != null &&
      d30.sleepAvgHours < 7
    ) {
      out.push({
        ruleId: "HEALTH_RULE_SLEEP_ROLL30_AVG_LT7",
        severity: "notice",
        title: "近30日平均睡眠不足",
        message: `截至 ${anchor}，近 30 个自然日有 ${d30.sleepDaysRecorded} 天睡眠记录，平均 ${d30.sleepAvgHours} h（<7）。`,
        effectivePeriod: monthKey,
        detectedAt: nowIso,
      });
    }
    if (d30 && (d30.dietDaysRecorded ?? 0) >= 10) {
      const rec = d30.dietDaysRecorded ?? 0;
      const high = d30.dietHighHeatDays ?? 0;
      if (rec > 0 && high / rec > 0.5) {
        out.push({
          ruleId: "HEALTH_RULE_DIET_HIGH_RATIO30",
          severity: "warning",
          title: "近30日高热量占比较高",
          message: `截至 ${anchor}，近 30 日有饮食热量记录 ${rec} 天，其中 ${high} 天为高热量档（🔥🔥🔥），占比超过 50%。`,
          effectivePeriod: monthKey,
          detectedAt: nowIso,
        });
      }
    }
    if (
      d30 &&
      (d30.waterDaysRecorded ?? 0) >= 12 &&
      d30.waterGoalMetRateAmongRecorded != null &&
      d30.waterGoalMetRateAmongRecorded < 0.4
    ) {
      out.push({
        ruleId: "HEALTH_RULE_WATER_LOW_ROLL30",
        severity: "notice",
        title: "近30日饮水达标率偏低",
        message: `截至 ${anchor}，近 30 日有饮水记录 ${d30.waterDaysRecorded} 天，达标（≥${waterGoalCups} 杯）占比 ${Math.round((d30.waterGoalMetRateAmongRecorded ?? 0) * 100)}%。`,
        effectivePeriod: monthKey,
        detectedAt: nowIso,
      });
    }

    if (anchor && /^\d{4}-\d{2}-\d{2}$/.test(anchor)) {
      const a = momentFn(anchor, "YYYY-MM-DD", true);
      if (a.isValid()) {
        const wStart = a.clone().subtract(27, "days").format("YYYY-MM-DD");
        const wEnd = anchor;
        const pStart = a.clone().subtract(55, "days").format("YYYY-MM-DD");
        const pEnd = a.clone().subtract(28, "days").format("YYYY-MM-DD");
        const avgN = avgWaistWeekInRange(allItems, wStart, wEnd);
        const avgP = avgWaistWeekInRange(allItems, pStart, pEnd);
        if (avgN != null && avgP != null && avgN - avgP >= 3) {
          out.push({
            ruleId: "HEALTH_RULE_WAIST_4W_VS_PREV4W_UP3",
            severity: "notice",
            title: "近4周腰围周卡均值较前一4周上升",
            message: `截至 ${anchor}，最近约 4 周腰围周卡均值 ${avgN} cm，较前约 4 周均值 ${avgP} cm 上升 ≥3 cm。`,
            effectivePeriod: monthKey,
            detectedAt: nowIso,
          });
        }
        const rStart = a.clone().subtract(55, "days").format("YYYY-MM-DD");
        const rMean = rhrMeanAndCountInRange(allItems, rStart, anchor);
        const rLast = latestRhrWeekInRange(allItems, rStart, anchor);
        if (rMean && rMean.n >= 3 && rLast && rLast.v >= rMean.mean + 10) {
          out.push({
            ruleId: "HEALTH_RULE_RHR_LAST_WEEK_VS_8W_MEAN_PLUS10",
            severity: "warning",
            title: "最近周卡心率明显高于近8周均值",
            message: `截至 ${anchor}，最近一条周卡心率 ${rLast.v} 次/分，较近约 8 周周卡心率均值 ${rMean.mean} 高出 ≥10。`,
            effectivePeriod: monthKey,
            detectedAt: nowIso,
          });
        }
      }
    }

    let monthBpOrRhrElevated = false;
    for (const it of monthItems) {
      if (it.isDelete) continue;
      const mk = String(it.metricKey ?? "").trim();
      if (mk === "bp" || mk === "bp_systolic" || mk === "bp_diastolic") {
        const pr = parseBloodPressureStorage(String(it.valueStr ?? ""));
        if (pr && (pr.systolic >= 130 || pr.diastolic >= 80)) {
          monthBpOrRhrElevated = true;
          break;
        }
      }
      if (mk === "rhr") {
        const r = parseInt(String(it.valueStr ?? "").trim(), 10);
        if (Number.isFinite(r) && r >= 90) {
          monthBpOrRhrElevated = true;
          break;
        }
      }
    }
    if (
      monthBpOrRhrElevated &&
      d7 &&
      (d7.sleepDaysRecorded ?? 0) >= 3 &&
      d7.sleepAvgHours != null &&
      d7.sleepAvgHours < 7
    ) {
      out.push({
        ruleId: "HEALTH_RULE_COMBO_BP_RHR_ELEVATED_AND_SLEEP_ROLL7",
        severity: "warning",
        title: "血压/心率偏高且近7日睡眠偏少",
        message: `本月有血压达到一期及以上（≥130/80）或静息心率≥90 的记录，且截至 ${anchor} 近7日平均睡眠 ${d7.sleepAvgHours} h（<7）。`,
        effectivePeriod: monthKey,
        detectedAt: nowIso,
      });
    }
    if (
      d7 &&
      d7.weightDelta7VsPrev7Kg != null &&
      d7.weightDelta7VsPrev7Kg >= 0.5 &&
      (d7.dietHighHeatDays ?? 0) >= 3 &&
      (d7.sleepDaysRecorded ?? 0) >= 3 &&
      d7.sleepAvgHours != null &&
      d7.sleepAvgHours < 7
    ) {
      out.push({
        ruleId: "HEALTH_RULE_COMBO_WEIGHT_UP_HEAT_SLEEP",
        severity: "notice",
        title: "体重上升伴随高热量与睡眠不足（近7日）",
        message: `截至 ${anchor}，近7日体重日均较前7日上升约 ${d7.weightDelta7VsPrev7Kg} kg，且高热量饮食日较多、平均睡眠 <7 h。`,
        effectivePeriod: monthKey,
        detectedAt: nowIso,
      });
    }

    appendMenstruationCycleGapAlerts(out, allItems, monthKey, nowIso);
  }

  return out;
}

function itemTsMs(it: HealthRecordIndexItem): number {
  return typeof it.tsMs === "number" && Number.isFinite(it.tsMs) ? it.tsMs : 0;
}

function dietHeatRankFromItem(it: HealthRecordIndexItem): number {
  const mk = String(it.metricKey ?? "").trim();
  let raw = String(it.valueStr ?? "").trim();
  if (mk === "diet_level") raw = mapLegacyDietLevelToHeat(raw);
  if (raw === "🔥🔥🔥") return 3;
  if (raw === "🔥🔥") return 2;
  if (raw === "🔥") return 1;
  return 0;
}

/**
 * 日卡：在 [startYmd, endYmd] 内按自然日聚合（同日多条取 tsMs 最新）。
 * 供月快照、滚动窗口与健康基础诊断共用。
 */
export function buildDayAggregateMapForYmdRange(
  items: HealthRecordIndexItem[],
  startYmd: string,
  endYmd: string,
): Map<string, DayAggCell> {
  const map = new Map<string, DayAggCell>();
  const ensure = (dk: string): DayAggCell => {
    let c = map.get(dk);
    if (!c) {
      c = { dietMaxRank: 0, dietHadRecord: false };
      map.set(dk, c);
    }
    return c;
  };
  for (const it of items) {
    if (it.isDelete) continue;
    const p = String(it.period ?? "day").trim().toLowerCase();
    if (p !== "day") continue;
    const dk = String(it.recordDate ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dk) || dk < startYmd || dk > endYmd) continue;
    const ts = itemTsMs(it);
    const mk = String(it.metricKey ?? "").trim();
    const cell = ensure(dk);
    if (mk === "weight") {
      const w = parseFloat(String(it.valueStr ?? "").trim());
      if (Number.isFinite(w) && w > 0 && w < 300) {
        const prev = cell.weight;
        if (!prev || ts >= prev.ts) cell.weight = { ts, v: w };
      }
    } else if (mk === "water_cups") {
      const c = parseInt(String(it.valueStr ?? "").trim(), 10);
      if (Number.isFinite(c) && c >= 0 && c <= 64) {
        const prev = cell.water;
        if (!prev || ts >= prev.ts) cell.water = { ts, cups: c };
      }
    } else if (mk === "sleep_hours") {
      const h = parseInt(String(it.valueStr ?? "").trim(), 10);
      if (Number.isFinite(h) && h >= 0 && h <= 24) {
        const prev = cell.sleep;
        if (!prev || ts >= prev.ts) cell.sleep = { ts, h };
      }
    } else if (mk === "diet" || mk === "diet_level" || mk === "diet_text") {
      cell.dietHadRecord = true;
      const r = dietHeatRankFromItem(it);
      if (r > cell.dietMaxRank) cell.dietMaxRank = r;
    }
  }
  return map;
}

function buildDayAggregateMap(monthKey: string, monthItems: HealthRecordIndexItem[]): Map<string, DayAggCell> {
  const start = `${monthKey}-01`;
  const end = momentFn(`${monthKey}-01`, "YYYY-MM-DD", true).endOf("month").format("YYYY-MM-DD");
  return buildDayAggregateMapForYmdRange(monthItems, start, end);
}

/** 生成该月滚动统计的截止日：历史月用月末，当月用今天（不超过月末） */
function computeRollingAnchorYmd(monthKey: string): string {
  const curMonth = momentFn().format("YYYY-MM");
  const endOfM = momentFn(`${monthKey}-01`, "YYYY-MM-DD", true).endOf("month").format("YYYY-MM-DD");
  if (monthKey < curMonth) return endOfM;
  const today = momentFn().format("YYYY-MM-DD");
  return today <= endOfM ? today : endOfM;
}

function enumerateYmdInclusive(startYmd: string, endYmd: string): string[] {
  const out: string[] = [];
  let d = momentFn(startYmd, "YYYY-MM-DD", true);
  const end = momentFn(endYmd, "YYYY-MM-DD", true);
  if (!d.isValid() || !end.isValid()) return out;
  while (d.isSameOrBefore(end, "day")) {
    out.push(d.format("YYYY-MM-DD"));
    d = d.clone().add(1, "day");
  }
  return out;
}

function computeDayFullCompletionRate(
  dayMap: Map<string, DayAggCell>,
  dates: string[],
  en: HealthEnabledDayMetrics,
): number | undefined {
  if (!en.weight && !en.water_cups && !en.sleep_hours && !en.diet) return undefined;
  let full = 0;
  for (const dk of dates) {
    const c = dayMap.get(dk);
    if (!c) continue;
    let ok = true;
    if (en.weight && !c.weight) ok = false;
    if (en.water_cups && !c.water) ok = false;
    if (en.sleep_hours && !c.sleep) ok = false;
    if (en.diet && !c.dietHadRecord) ok = false;
    if (ok) full++;
  }
  return dates.length ? full / dates.length : undefined;
}

function avgWaistWeekInRange(items: HealthRecordIndexItem[], startYmd: string, endYmd: string): number | null {
  const vals: number[] = [];
  for (const it of items) {
    if (it.isDelete) continue;
    if (String(it.period ?? "day").trim().toLowerCase() !== "week") continue;
    if (String(it.metricKey ?? "").trim() !== "waist") continue;
    const dk = String(it.recordDate ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dk) || dk < startYmd || dk > endYmd) continue;
    const w = parseFloat(String(it.valueStr ?? "").trim());
    if (Number.isFinite(w) && w > 0 && w < 300) vals.push(w);
  }
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

function rhrMeanAndCountInRange(
  items: HealthRecordIndexItem[],
  startYmd: string,
  endYmd: string,
): { mean: number; n: number } | null {
  const vals: number[] = [];
  for (const it of items) {
    if (it.isDelete) continue;
    if (String(it.period ?? "day").trim().toLowerCase() !== "week") continue;
    if (String(it.metricKey ?? "").trim() !== "rhr") continue;
    const dk = String(it.recordDate ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dk) || dk < startYmd || dk > endYmd) continue;
    const r = parseInt(String(it.valueStr ?? "").trim(), 10);
    if (Number.isFinite(r) && r > 0 && r < 250) vals.push(r);
  }
  if (!vals.length) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return { mean: Math.round(mean * 10) / 10, n: vals.length };
}

function latestRhrWeekInRange(
  items: HealthRecordIndexItem[],
  startYmd: string,
  endYmd: string,
): { v: number; ts: number } | null {
  let best: { v: number; ts: number } | null = null;
  for (const it of items) {
    if (it.isDelete) continue;
    if (String(it.period ?? "day").trim().toLowerCase() !== "week") continue;
    if (String(it.metricKey ?? "").trim() !== "rhr") continue;
    const dk = String(it.recordDate ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dk) || dk < startYmd || dk > endYmd) continue;
    const r = parseInt(String(it.valueStr ?? "").trim(), 10);
    if (!Number.isFinite(r) || r <= 0 || r >= 250) continue;
    const ts = itemTsMs(it);
    if (!best || ts >= best.ts) best = { v: r, ts };
  }
  return best;
}

function appendMenstruationCycleGapAlerts(
  out: Omit<HealthAlertSnapshotItem, "status" | "alertFingerprint">[],
  allItems: HealthRecordIndexItem[],
  monthKey: string,
  nowIso: string,
): void {
  const starts: string[] = [];
  for (const it of allItems) {
    if (it.isDelete) continue;
    if (String(it.metricKey ?? "").trim() !== "menstruation") continue;
    if (String(it.period ?? "day").trim().toLowerCase() !== "month") continue;
    const pm = parseMenstruationMonthStorage(String(it.valueStr ?? ""));
    if (pm?.start && /^\d{4}-\d{2}-\d{2}$/.test(pm.start)) starts.push(pm.start);
  }
  if (starts.length < 2) return;
  starts.sort();
  const uniq = [...new Set(starts)];
  if (uniq.length < 2) return;
  const lastGap = momentFn(uniq[uniq.length - 1], "YYYY-MM-DD", true).diff(
    momentFn(uniq[uniq.length - 2], "YYYY-MM-DD", true),
    "days",
  );
  if (!Number.isFinite(lastGap) || lastGap <= 0) return;
  if (lastGap < 21 || lastGap > 35) {
    out.push({
      ruleId: "HEALTH_RULE_MENSES_CYCLE_INTERVAL",
      severity: "warning",
      title: "月经周期间隔偏离常见范围",
      message: `索引中最近两次月经开始日间隔 ${lastGap} 天（参考约 21～35 天），请结合自身周期观察或咨询专业人士。`,
      effectivePeriod: monthKey,
      detectedAt: nowIso,
    });
  }
}

function rollBucketMetrics(
  dayMap: Map<string, DayAggCell>,
  dates: string[],
  waterGoalCups: number,
): HealthRollingBucketMetrics {
  let sleepSum = 0;
  let sleepN = 0;
  let waterSum = 0;
  let waterN = 0;
  let waterMet = 0;
  const ws: number[] = [];
  let dietRec = 0;
  let dietHigh = 0;
  for (const dk of dates) {
    const c = dayMap.get(dk);
    if (c?.sleep) {
      sleepSum += c.sleep.h;
      sleepN++;
    }
    if (c?.water) {
      waterN++;
      waterSum += c.water.cups;
      if (c.water.cups >= waterGoalCups) waterMet++;
    }
    if (c?.weight) ws.push(c.weight.v);
    if (c?.dietHadRecord) {
      dietRec++;
      if (c.dietMaxRank >= 3) dietHigh++;
    }
  }
  const weightAvgKg =
    ws.length > 0 ? Math.round((ws.reduce((a, b) => a + b, 0) / ws.length) * 100) / 100 : undefined;
  return {
    sleepAvgHours: sleepN ? Math.round((sleepSum / sleepN) * 100) / 100 : undefined,
    sleepDaysRecorded: sleepN || undefined,
    waterAvgCups: waterN ? Math.round((waterSum / waterN) * 100) / 100 : undefined,
    waterDaysRecorded: waterN || undefined,
    waterGoalMetRateAmongRecorded: waterN ? Math.round((waterMet / waterN) * 1000) / 1000 : undefined,
    weightAvgKg,
    weightDaysRecorded: ws.length || undefined,
    dietHighHeatDays: dietHigh || undefined,
    dietDaysRecorded: dietRec || undefined,
  };
}

function computeRollingSnapshot(
  allItems: HealthRecordIndexItem[],
  monthKey: string,
  waterGoalCups: number,
  enabledDay: HealthEnabledDayMetrics,
): {
  rolling: HealthRollingSnapshot;
  rollDayMap7: Map<string, DayAggCell>;
  rollD7Dates: string[];
} {
  const anchor = computeRollingAnchorYmd(monthKey);
  const start30 = momentFn(anchor, "YYYY-MM-DD", true).subtract(29, "days").format("YYYY-MM-DD");
  const dayMap = buildDayAggregateMapForYmdRange(allItems, start30, anchor);
  const d7start = momentFn(anchor, "YYYY-MM-DD", true).subtract(6, "days").format("YYYY-MM-DD");
  const d7dates = enumerateYmdInclusive(d7start, anchor);
  const d30dates = enumerateYmdInclusive(start30, anchor);
  const rollDayMap7 = buildDayAggregateMapForYmdRange(allItems, d7start, anchor);
  const last7 = rollBucketMetrics(dayMap, d7dates, waterGoalCups);
  const last30 = rollBucketMetrics(dayMap, d30dates, waterGoalCups);
  last7.dayFullCompletionRate = computeDayFullCompletionRate(dayMap, d7dates, enabledDay);
  last30.dayFullCompletionRate = computeDayFullCompletionRate(dayMap, d30dates, enabledDay);
  const prev7End = momentFn(anchor, "YYYY-MM-DD", true).subtract(7, "days").format("YYYY-MM-DD");
  const prev7Start = momentFn(anchor, "YYYY-MM-DD", true).subtract(13, "days").format("YYYY-MM-DD");
  const prev7dates = enumerateYmdInclusive(prev7Start, prev7End);
  const prevBucket = rollBucketMetrics(dayMap, prev7dates, waterGoalCups);
  if (last7.weightAvgKg != null && prevBucket.weightAvgKg != null) {
    last7.weightAvgPrev7Kg = prevBucket.weightAvgKg;
    last7.weightDelta7VsPrev7Kg = Math.round((last7.weightAvgKg - prevBucket.weightAvgKg) * 100) / 100;
  }
  return {
    rolling: { anchorYmd: anchor, last7Days: last7, last30Days: last30 },
    rollDayMap7,
    rollD7Dates: d7dates,
  };
}

/** 从设置组装「日卡完成率」判定用的启用项（缺省视为启用） */
export function healthEnabledDayMetricsFromPanel(healthPanel: any): HealthEnabledDayMetrics {
  const f = readHealthMetricsEnabledFlags(healthPanel ?? {});
  return {
    weight: f.weight,
    water_cups: f.water_cups,
    sleep_hours: f.sleep_hours,
    diet: f.diet,
  };
}

function computeDerivedMonthMetrics(
  monthKey: string,
  monthItems: HealthRecordIndexItem[],
  dayMap: Map<string, DayAggCell>,
  waterGoalCups: number,
): HealthStatsSnapshotFile["derived"] {
  const m0 = momentFn(`${monthKey}-01`, "YYYY-MM-DD", true);
  const daysInMonth = m0.isValid() ? m0.daysInMonth() : 30;
  const dates: string[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    dates.push(`${monthKey}-${String(d).padStart(2, "0")}`);
  }

  let sleepUnder7 = 0;
  let sleepUnder5 = 0;
  let sleepSum = 0;
  let sleepN = 0;
  let maxU7 = 0;
  let maxU5 = 0;
  let streak7 = 0;
  let streak5 = 0;
  for (const dk of dates) {
    const cell = dayMap.get(dk);
    const h = cell?.sleep?.h;
    if (h === undefined) {
      streak7 = 0;
      streak5 = 0;
      continue;
    }
    sleepSum += h;
    sleepN++;
    if (h < 7) {
      sleepUnder7++;
      streak7++;
      maxU7 = Math.max(maxU7, streak7);
    } else streak7 = 0;
    if (h < 5) {
      sleepUnder5++;
      streak5++;
      maxU5 = Math.max(maxU5, streak5);
    } else streak5 = 0;
  }

  const weights: { dk: string; v: number }[] = [];
  let waterSum = 0;
  let waterN = 0;
  let waterMet = 0;
  for (const dk of dates) {
    const cell = dayMap.get(dk);
    if (cell?.weight) weights.push({ dk, v: cell.weight.v });
    if (cell?.water) {
      waterN++;
      waterSum += cell.water.cups;
      if (cell.water.cups >= waterGoalCups) waterMet++;
    }
  }
  weights.sort((a, b) => a.dk.localeCompare(b.dk));
  let weightMin: number | undefined;
  let weightMax: number | undefined;
  let avgWeight: number | undefined;
  let deltaFirstLast: number | undefined;
  if (weights.length) {
    const vs = weights.map((x) => x.v);
    weightMin = Math.min(...vs);
    weightMax = Math.max(...vs);
    avgWeight = Math.round((vs.reduce((a, b) => a + b, 0) / vs.length) * 100) / 100;
    if (weights.length >= 2) {
      deltaFirstLast = Math.round((weights[weights.length - 1].v - weights[0].v) * 100) / 100;
    }
  }
  let weightMaxAdjacentDeltaKg: number | undefined;
  if (weights.length >= 2) {
    let maxD = 0;
    for (let i = 1; i < weights.length; i++) {
      maxD = Math.max(maxD, Math.abs(weights[i].v - weights[i - 1].v));
    }
    weightMaxAdjacentDeltaKg = Math.round(maxD * 100) / 100;
  }

  let dietRec = 0;
  let dietHigh = 0;
  for (const dk of dates) {
    const cell = dayMap.get(dk);
    if (!cell?.dietHadRecord) continue;
    dietRec++;
    if (cell.dietMaxRank >= 3) dietHigh++;
  }

  const weekWaist: number[] = [];
  const weekRhr: number[] = [];
  let latestBp: { sys: number; dia: number; ts: number } | null = null;
  let waistLatest: number | undefined;
  let waistLatestTs = -1;
  let bpWeekN = 0;
  for (const it of monthItems) {
    if (it.isDelete) continue;
    if (String(it.period ?? "day").trim().toLowerCase() !== "week") continue;
    const ts = itemTsMs(it);
    const mk = String(it.metricKey ?? "").trim();
    if (mk === "waist") {
      const w = parseFloat(String(it.valueStr ?? "").trim());
      if (Number.isFinite(w) && w > 0 && w < 300) {
        weekWaist.push(w);
        if (ts >= waistLatestTs) {
          waistLatestTs = ts;
          waistLatest = w;
        }
      }
    } else if (mk === "rhr") {
      const r = parseInt(String(it.valueStr ?? "").trim(), 10);
      if (Number.isFinite(r) && r > 0 && r < 250) weekRhr.push(r);
    } else if (mk === "bp" || mk === "bp_systolic" || mk === "bp_diastolic") {
      bpWeekN++;
      const pr = parseBloodPressureStorage(String(it.valueStr ?? ""));
      if (pr && (!latestBp || ts >= latestBp.ts)) latestBp = { sys: pr.systolic, dia: pr.diastolic, ts };
    }
  }

  const rhrAvg =
    weekRhr.length > 0 ? Math.round((weekRhr.reduce((a, b) => a + b, 0) / weekRhr.length) * 10) / 10 : undefined;
  let rhrLatestBpm: number | undefined;
  let rhrLts = -1;
  for (const it of monthItems) {
    if (it.isDelete) continue;
    if (String(it.period ?? "day").trim().toLowerCase() !== "week") continue;
    if (String(it.metricKey ?? "").trim() !== "rhr") continue;
    const ts = itemTsMs(it);
    const r = parseInt(String(it.valueStr ?? "").trim(), 10);
    if (Number.isFinite(r) && r > 0 && r < 250 && ts >= rhrLts) {
      rhrLts = ts;
      rhrLatestBpm = r;
    }
  }

  return {
    sleepUnder7Days: sleepUnder7,
    sleepUnder5Days: sleepUnder5,
    avgWeight,
    weightSamples: weights.length,
    daysInMonth,
    sleepRecordedDays: sleepN,
    sleepAvgHours: sleepN > 0 ? Math.round((sleepSum / sleepN) * 100) / 100 : undefined,
    maxConsecutiveSleepUnder7: maxU7,
    maxConsecutiveSleepUnder5: maxU5,
    waterRecordedDays: waterN,
    waterGoalMetDays: waterN > 0 ? waterMet : undefined,
    waterGoalMetRateAmongRecorded: waterN > 0 ? Math.round((waterMet / waterN) * 1000) / 1000 : undefined,
    waterAvgCups: waterN > 0 ? Math.round((waterSum / waterN) * 100) / 100 : undefined,
    weightMin,
    weightMax,
    weightDeltaFirstLastKg: deltaFirstLast,
    dietRecordedDays: dietRec,
    dietHighHeatDays: dietHigh,
    dietHighHeatRateAmongRecorded: dietRec > 0 ? Math.round((dietHigh / dietRec) * 1000) / 1000 : undefined,
    waistLatestCm: waistLatest,
    waistWeekRecordsInMonth: weekWaist.length,
    bpLatestSystolic: latestBp?.sys,
    bpLatestDiastolic: latestBp?.dia,
    bpWeekRecordsInMonth: bpWeekN,
    rhrLatestBpm,
    rhrAvgBpm: rhrAvg,
    rhrWeekRecordsInMonth: weekRhr.length,
    weightMaxAdjacentDeltaKg,
  };
}

/** 按设置从月统计快照中剔除用户关闭的指标块（仅影响落盘与侧栏读取，不参与再次告警计算）。 */
export function applyHealthStatsMetricOutputFilters(
  snap: HealthStatsSnapshotFile,
  healthPanel: any,
): HealthStatsSnapshotFile {
  const hp = healthPanel ?? {};
  let summary = snap.summary;
  if (!isHealthStatsMetricOutputEnabled(hp, "stats_summary")) {
    summary = { validCount: 0, byPeriod: { day: 0, week: 0, month: 0 }, canonicalTally: {} };
  }
  let latestByCanonical = snap.latestByCanonical;
  if (!isHealthStatsMetricOutputEnabled(hp, "stats_latest")) {
    latestByCanonical = {};
  }
  const d: HealthStatsSnapshotFile["derived"] = { ...snap.derived };
  if (!isHealthStatsMetricOutputEnabled(hp, "stats_derived_sleep")) {
    delete d.sleepUnder7Days;
    delete d.sleepUnder5Days;
    delete d.sleepRecordedDays;
    delete d.sleepAvgHours;
    delete d.maxConsecutiveSleepUnder7;
    delete d.maxConsecutiveSleepUnder5;
  }
  if (!isHealthStatsMetricOutputEnabled(hp, "stats_derived_water")) {
    delete d.waterRecordedDays;
    delete d.waterGoalMetDays;
    delete d.waterGoalMetRateAmongRecorded;
    delete d.waterAvgCups;
  }
  if (!isHealthStatsMetricOutputEnabled(hp, "stats_derived_weight")) {
    delete d.avgWeight;
    delete d.weightSamples;
    delete d.weightMin;
    delete d.weightMax;
    delete d.weightDeltaFirstLastKg;
    delete d.weightMaxAdjacentDeltaKg;
  }
  if (!isHealthStatsMetricOutputEnabled(hp, "stats_derived_diet")) {
    delete d.dietRecordedDays;
    delete d.dietHighHeatDays;
    delete d.dietHighHeatRateAmongRecorded;
  }
  if (!isHealthStatsMetricOutputEnabled(hp, "stats_derived_week_cards")) {
    delete d.waistLatestCm;
    delete d.waistWeekRecordsInMonth;
    delete d.bpLatestSystolic;
    delete d.bpLatestDiastolic;
    delete d.bpWeekRecordsInMonth;
    delete d.rhrLatestBpm;
    delete d.rhrAvgBpm;
    delete d.rhrWeekRecordsInMonth;
  }
  const anyDerived =
    isHealthStatsMetricOutputEnabled(hp, "stats_derived_sleep") ||
    isHealthStatsMetricOutputEnabled(hp, "stats_derived_water") ||
    isHealthStatsMetricOutputEnabled(hp, "stats_derived_weight") ||
    isHealthStatsMetricOutputEnabled(hp, "stats_derived_diet") ||
    isHealthStatsMetricOutputEnabled(hp, "stats_derived_week_cards");
  if (!anyDerived) {
    delete d.daysInMonth;
  }
  const rolling = isHealthStatsMetricOutputEnabled(hp, "stats_rolling") ? snap.rolling : undefined;
  const derived: HealthStatsSnapshotFile["derived"] = {
    sleepUnder7Days: d.sleepUnder7Days ?? 0,
    sleepUnder5Days: d.sleepUnder5Days ?? 0,
    weightSamples: d.weightSamples ?? 0,
    ...d,
  };
  return { ...snap, summary, latestByCanonical, derived, rolling };
}

function buildStatsSnapshot(
  spaceId: string,
  mode: string,
  monthKey: string,
  monthItems: HealthRecordIndexItem[],
  opts: {
    waterGoalCups: number;
    allItems: HealthRecordIndexItem[];
    enabledDayMetrics: HealthEnabledDayMetrics;
    /** 用于过滤写入 alerts 的规则；缺省视为全部启用 */
    healthPanel?: any;
  },
): {
  snapshot: HealthStatsSnapshotFile;
  rollDayMap7: Map<string, DayAggCell>;
  rollD7Dates: string[];
  rawAlertsFiltered: Omit<HealthAlertSnapshotItem, "status" | "alertFingerprint">[];
} {
  const byPeriod = { day: 0, week: 0, month: 0 };
  const canonicalTally: Partial<Record<HealthCanonicalMetricKey, number>> = {};
  const latestTs = new Map<HealthCanonicalMetricKey, { ts: number; it: HealthRecordIndexItem }>();

  for (const it of monthItems) {
    if (it.isDelete) continue;
    const p = String(it.period ?? "day").trim().toLowerCase();
    if (p === "week") byPeriod.week++;
    else if (p === "month") byPeriod.month++;
    else byPeriod.day++;

    const canon = normalizeIndexMetricKeyToCanonical(String(it.metricKey ?? ""));
    if (canon) {
      canonicalTally[canon] = (canonicalTally[canon] ?? 0) + 1;
      const ts = itemTsMs(it);
      const prev = latestTs.get(canon);
      if (!prev || ts >= prev.ts) latestTs.set(canon, { ts, it });
    }
  }

  const latestByCanonical: HealthStatsSnapshotFile["latestByCanonical"] = {};
  for (const c of HEALTH_CANONICAL_METRICS_ORDER) {
    const hit = latestTs.get(c);
    if (!hit) continue;
    const x = hit.it;
    latestByCanonical[c] = {
      recordDate: String(x.recordDate ?? "").trim(),
      valueStr: String(x.valueStr ?? "").trim(),
      period: String(x.period ?? "day").trim().toLowerCase(),
      entryId: String(x.entryId ?? "").trim() || undefined,
    };
  }

  const dayMap = buildDayAggregateMap(monthKey, monthItems);
  const derived = computeDerivedMonthMetrics(monthKey, monthItems, dayMap, opts.waterGoalCups);
  const { rolling, rollDayMap7, rollD7Dates } = computeRollingSnapshot(
    opts.allItems,
    monthKey,
    opts.waterGoalCups,
    opts.enabledDayMetrics,
  );

  const rawAlertsAll = buildHealthRuleAlerts(monthItems, monthKey, {
    derived,
    rolling,
    waterGoalCups: opts.waterGoalCups,
    allItems: opts.allItems,
    enabledDayMetrics: opts.enabledDayMetrics,
    rollDayMap7,
    rollD7Dates,
  });
  const hp = opts.healthPanel;
  const rawAlertsFiltered = rawAlertsAll.filter((a) => isHealthRuleOrBaseAlertEnabled(hp, a.ruleId));
  const sev = countSeverity(rawAlertsFiltered as any[]);

  return {
    snapshot: {
      version: 1,
      generatedAt: new Date().toISOString(),
      spaceId,
      mode: String(mode ?? ""),
      grain: "month",
      periodKey: monthKey,
      summary: {
        validCount: monthItems.filter((x) => !x.isDelete).length,
        byPeriod,
        canonicalTally,
      },
      latestByCanonical,
      derived,
      rolling,
      alertSummary: {
        total: rawAlertsFiltered.length,
        high: sev.high,
        warning: sev.warning,
        notice: sev.notice,
      },
    },
    rollDayMap7,
    rollD7Dates,
    rawAlertsFiltered,
  };
}

function healthAnalysisSpaceRoot(plugin: any): string {
  return String(plugin?.getSpaceIndexDir?.() ?? "").trim();
}

async function writeHealthMonthSnapshotsInternal(
  plugin: any,
  ctx: {
    baseDir: string;
    spaceId: string;
    mode: string;
    monthKey: string;
    all: HealthRecordIndexItem[];
    waterGoalCups: number;
    enabledDayMetrics: HealthEnabledDayMetrics;
    healthPanel: any;
    backupBefore: boolean;
  },
): Promise<HealthAnalysisIndexFile["snapshots"][number] | null> {
  const { baseDir, spaceId, mode, monthKey, all, waterGoalCups, enabledDayMetrics, healthPanel, backupBefore } = ctx;
  const monthItems = all.filter((it) => healthItemTouchesMonth(it, monthKey));
  const { snapshot: statsSnapshotBuilt, rawAlertsFiltered } = buildStatsSnapshot(
    spaceId,
    mode,
    monthKey,
    monthItems,
    {
      waterGoalCups,
      allItems: all,
      enabledDayMetrics,
      healthPanel,
    },
  );
  const statsSnapshot = applyHealthStatsMetricOutputFilters(statsSnapshotBuilt, healthPanel);
  const statsRel = `snapshots/month/${monthKey}.stats.json`;
  const statsPath = normalizePath(`${baseDir}/${statsRel}`);
  const alertsRel = `snapshots/month/${monthKey}.alerts.json`;
  const alertsPath = normalizePath(`${baseDir}/${alertsRel}`);
  const adapter = plugin.app.vault.adapter;
  if (backupBefore) {
    await rotateAnalysisSnapshotBeforeWrite(adapter, statsPath);
    await rotateAnalysisSnapshotBeforeWrite(adapter, alertsPath);
  }
  await ensureFolder(plugin, normalizePath(`${baseDir}/snapshots/month`));
  await adapter.write(statsPath, JSON.stringify(statsSnapshot, null, 2));

  const alertItems = await mergeAlertLifecycleAsync(plugin, baseDir, monthKey, rawAlertsFiltered);
  const sev = countSeverity(alertItems.filter((x) => x.status !== "resolved"));
  const statusSummary = countStatus(alertItems);

  const alertsSnapshot: HealthAlertsSnapshotFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    spaceId,
    mode: String(mode ?? ""),
    grain: "month",
    periodKey: monthKey,
    summary: {
      total: alertItems.filter((x) => x.status !== "resolved").length,
      high: sev.high,
      warning: sev.warning,
      notice: sev.notice,
    },
    statusSummary,
    items: alertItems,
  };
  await adapter.write(alertsPath, JSON.stringify(alertsSnapshot, null, 2));

  return {
    periodKey: monthKey,
    statsRef: statsRel,
    alertsRef: alertsRel,
    summary: statsSnapshot.summary,
    alertSummary: statsSnapshot.alertSummary,
  };
}

/** 按需写入指定月份健康快照（backupExisting 时主+bak1+bak2 共 3 版）。不更新 health-analysis.index.json。 */
export async function writeHealthAnalysisSnapshotsForMonths(
  plugin: any,
  monthKeys: string[],
  mode: string,
  opts?: { backupExisting?: boolean },
): Promise<void> {
  const keys = [...new Set(monthKeys.map((k) => String(k).trim()).filter((k) => /^\d{4}-\d{2}$/.test(k)))].sort();
  if (!keys.length) return;
  const spaceId = String(plugin?.getSpaceCtx?.()?.spaceId ?? "default");
  const root = healthAnalysisSpaceRoot(plugin);
  if (!root) return;
  const baseDir = normalizePath(`${root}/health-analysis`);
  await ensureFolder(plugin, baseDir);
  await plugin?.recordRSLatte?.ensureReady?.();
  const [snapA, snapB] = await Promise.all([
    plugin?.recordRSLatte?.getHealthSnapshot?.(false),
    plugin?.recordRSLatte?.getHealthSnapshot?.(true),
  ]);
  const all: HealthRecordIndexItem[] = [
    ...(Array.isArray(snapA?.items) ? snapA.items : []),
    ...(Array.isArray(snapB?.items) ? snapB.items : []),
  ];
  const waterGoalCups = Math.max(1, Math.min(30, Number(plugin?.settings?.healthPanel?.waterGoalCups ?? 8) || 8));
  const enabledDayMetrics = healthEnabledDayMetricsFromPanel(plugin?.settings?.healthPanel);
  const healthPanel = plugin?.settings?.healthPanel;
  const backupBefore = opts?.backupExisting === true;
  for (const mk of keys) {
    await writeHealthMonthSnapshotsInternal(plugin, {
      baseDir,
      spaceId,
      mode,
      monthKey: mk,
      all,
      waterGoalCups,
      enabledDayMetrics,
      healthPanel,
      backupBefore,
    });
  }
}

/** 自动刷新：若上一自然月健康快照缺失则补写。 */
export async function ensurePrevMonthHealthSnapshotsIfMissing(plugin: any, mode: string): Promise<void> {
  const root = healthAnalysisSpaceRoot(plugin);
  if (!root) return;
  const prev = momentFn().subtract(1, "month").format("YYYY-MM");
  const statsPath = normalizePath(`${root}/health-analysis/snapshots/month/${prev}.stats.json`);
  const alertsPath = normalizePath(`${root}/health-analysis/snapshots/month/${prev}.alerts.json`);
  const ad = plugin.app.vault.adapter;
  const hasStats = await ad.exists(statsPath);
  const hasAlerts = await ad.exists(alertsPath);
  if (hasStats && hasAlerts) return;
  await writeHealthAnalysisSnapshotsForMonths(plugin, [prev], mode, { backupExisting: false });
}

/** stats / alerts 各回退一档（`.bak1.json` 链，至多 3 版）。 */
export async function restoreHealthMonthSnapshotsFromBackup(
  plugin: any,
  monthKey: string,
): Promise<{ stats: boolean; alerts: boolean }> {
  const mk = String(monthKey ?? "").trim();
  const out = { stats: false, alerts: false };
  if (!/^\d{4}-\d{2}$/.test(mk)) return out;
  const root = healthAnalysisSpaceRoot(plugin);
  if (!root) return out;
  const ad = plugin.app.vault.adapter;
  const statsPath = normalizePath(`${root}/health-analysis/snapshots/month/${mk}.stats.json`);
  const alertsPath = normalizePath(`${root}/health-analysis/snapshots/month/${mk}.alerts.json`);
  try {
    if (await rollbackOneAnalysisSnapshot(ad, statsPath)) out.stats = true;
  } catch {
    // ignore
  }
  try {
    if (await rollbackOneAnalysisSnapshot(ad, alertsPath)) out.alerts = true;
  } catch {
    // ignore
  }
  return out;
}

export async function writeHealthAnalysisSnapshotsAndIndex(plugin: any, mode: string): Promise<void> {
  try {
    const spaceId = String(plugin?.getSpaceCtx?.()?.spaceId ?? "default");
    const root = String(plugin?.getSpaceIndexDir?.() ?? "").trim();
    if (!root) return;
    const baseDir = normalizePath(`${root}/health-analysis`);
    await ensureFolder(plugin, baseDir);
    await ensureFolder(plugin, normalizePath(`${baseDir}/snapshots/month`));

    await plugin?.recordRSLatte?.ensureReady?.();
    const [snapA, snapB] = await Promise.all([
      plugin?.recordRSLatte?.getHealthSnapshot?.(false),
      plugin?.recordRSLatte?.getHealthSnapshot?.(true),
    ]);
    const all: HealthRecordIndexItem[] = [
      ...(Array.isArray(snapA?.items) ? snapA.items : []),
      ...(Array.isArray(snapB?.items) ? snapB.items : []),
    ];

    const monthKeyNow = momentFn().format("YYYY-MM");

    const waterGoalCups = Math.max(1, Math.min(30, Number(plugin?.settings?.healthPanel?.waterGoalCups ?? 8) || 8));
    const enabledDayMetrics = healthEnabledDayMetricsFromPanel(plugin?.settings?.healthPanel);

    const healthPanel = plugin?.settings?.healthPanel;

    const snapshotRef = await writeHealthMonthSnapshotsInternal(plugin, {
      baseDir,
      spaceId,
      mode,
      monthKey: monthKeyNow,
      all,
      waterGoalCups,
      enabledDayMetrics,
      healthPanel,
      backupBefore: false,
    });

    const snapshotRefs: HealthAnalysisIndexFile["snapshots"] = snapshotRef ? [snapshotRef] : [];
    const latestRef = snapshotRef;
    if (!latestRef) return;

    const indexFile: HealthAnalysisIndexFile = {
      version: 1,
      generatedAt: new Date().toISOString(),
      spaceId,
      mode: String(mode ?? ""),
      latest: {
        periodKey: latestRef.periodKey,
        summary: latestRef.summary,
        alertSummary: latestRef.alertSummary,
      },
      snapshots: snapshotRefs,
    };
    const indexPath = normalizePath(`${baseDir}/health-analysis.index.json`);
    await plugin.app.vault.adapter.write(indexPath, JSON.stringify(indexFile, null, 2));
  } catch (e) {
    console.warn("[RSLatte][health-analysis] write snapshots/index failed", e);
  }
}

async function mergeAlertLifecycleAsync(
  plugin: any,
  baseDir: string,
  monthKey: string,
  currentRaw: Omit<HealthAlertSnapshotItem, "status" | "alertFingerprint">[],
): Promise<HealthAlertSnapshotItem[]> {
  const alertsPath = normalizePath(`${baseDir}/snapshots/month/${monthKey}.alerts.json`);
  let prevItems: HealthAlertSnapshotItem[] = [];
  try {
    const okPrev = await plugin.app.vault.adapter.exists(alertsPath);
    if (okPrev) {
      const rawPrev = await plugin.app.vault.adapter.read(alertsPath);
      const jp = parseJsonSafe(String(rawPrev ?? ""));
      if (jp && Number(jp.version) === 1 && Array.isArray(jp.items)) {
        prevItems = jp.items as HealthAlertSnapshotItem[];
      }
    }
  } catch {
    // ignore
  }

  const prevByFp = new Map<string, HealthAlertSnapshotItem>();
  for (const p of prevItems) {
    const fp = String(p?.alertFingerprint ?? "").trim();
    if (fp) prevByFp.set(fp, p);
  }

  const currentAlertItems: HealthAlertSnapshotItem[] = currentRaw.map((a) => {
    const rel = Array.isArray(a.relatedEntryIds) ? a.relatedEntryIds : [];
    const fp = buildAlertFingerprint(a.ruleId, a.effectivePeriod, rel);
    const prev = prevByFp.get(fp);
    const prevStatus = String(prev?.status ?? "").trim();
    const status: HealthAlertSnapshotItem["status"] =
      prevStatus === "ignored" ? "ignored" : prev ? "ongoing" : "new";
    return {
      ...a,
      status,
      alertFingerprint: fp,
    };
  });

  const currentFpSet = new Set(currentAlertItems.map((x) => x.alertFingerprint));
  const resolvedItems: HealthAlertSnapshotItem[] = [];
  for (const p of prevItems) {
    const fp = String(p?.alertFingerprint ?? "").trim();
    if (!fp || currentFpSet.has(fp)) continue;
    resolvedItems.push({
      ...p,
      status: "resolved",
      detectedAt: new Date().toISOString(),
      relatedEntryIds: Array.isArray(p.relatedEntryIds) ? p.relatedEntryIds : undefined,
    });
  }

  const alertItems = [...currentAlertItems, ...resolvedItems];
  alertItems.sort((a, b) => {
    const rankStatus = (s: string) => (s === "new" ? 0 : s === "ongoing" ? 1 : s === "ignored" ? 2 : 3);
    const rankSeverity = (s: string) => (s === "high" ? 0 : s === "warning" ? 1 : 2);
    const rs = rankStatus(String(a.status)) - rankStatus(String(b.status));
    if (rs !== 0) return rs;
    return rankSeverity(String(a.severity)) - rankSeverity(String(b.severity));
  });
  return alertItems;
}

export async function readHealthAnalysisIndex(plugin: any): Promise<HealthAnalysisIndexFile | null> {
  try {
    const root = String(plugin?.getSpaceIndexDir?.() ?? "").trim();
    if (!root) return null;
    const path = normalizePath(`${root}/health-analysis/health-analysis.index.json`);
    const ok = await plugin.app.vault.adapter.exists(path);
    if (!ok) return null;
    const raw = await plugin.app.vault.adapter.read(path);
    const j = parseJsonSafe(String(raw ?? ""));
    if (!j || j.version !== 1) return null;
    return j as HealthAnalysisIndexFile;
  } catch (e) {
    console.warn("[RSLatte][health-analysis] read index failed", e);
    return null;
  }
}

export async function readHealthStatsSnapshot(plugin: any, monthKey: string): Promise<HealthStatsSnapshotFile | null> {
  try {
    const root = String(plugin?.getSpaceIndexDir?.() ?? "").trim();
    if (!root || !/^\d{4}-\d{2}$/.test(monthKey)) return null;
    const path = normalizePath(`${root}/health-analysis/snapshots/month/${monthKey}.stats.json`);
    const ok = await plugin.app.vault.adapter.exists(path);
    if (!ok) return null;
    const raw = await plugin.app.vault.adapter.read(path);
    const j = parseJsonSafe(String(raw ?? ""));
    if (!j || j.version !== 1) return null;
    return j as HealthStatsSnapshotFile;
  } catch (e) {
    console.warn("[RSLatte][health-analysis] read stats snapshot failed", e);
    return null;
  }
}

export async function readHealthAlertsSnapshot(plugin: any, monthKey: string): Promise<HealthAlertsSnapshotFile | null> {
  try {
    const root = String(plugin?.getSpaceIndexDir?.() ?? "").trim();
    if (!root || !/^\d{4}-\d{2}$/.test(monthKey)) return null;
    const path = normalizePath(`${root}/health-analysis/snapshots/month/${monthKey}.alerts.json`);
    const ok = await plugin.app.vault.adapter.exists(path);
    if (!ok) return null;
    const raw = await plugin.app.vault.adapter.read(path);
    const j = parseJsonSafe(String(raw ?? ""));
    if (!j || j.version !== 1) return null;
    return j as HealthAlertsSnapshotFile;
  } catch (e) {
    console.warn("[RSLatte][health-analysis] read alerts snapshot failed", e);
    return null;
  }
}
