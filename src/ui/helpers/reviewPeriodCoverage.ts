import { moment } from "obsidian";
import type { RSLattePluginSettings } from "../../types/settings";
import { normalizeArchiveThresholdDays } from "../../constants/defaults";

const momentFn = moment as any;

/** 与 WorkEvent 分片 `*-YYYYMM.jsonl` 对齐的月份键列表 */
export function workEventMonthKeysForYmdRange(startYmd: string, endYmd: string): string[] {
  const s = momentFn(startYmd, "YYYY-MM-DD", true);
  const e = momentFn(endYmd, "YYYY-MM-DD", true);
  if (!s.isValid() || !e.isValid()) return [];
  const keys = new Set<string>();
  const cur = s.clone().startOf("month");
  const endM = e.clone().startOf("month");
  while (cur.isSameOrBefore(endM, "month")) {
    keys.add(cur.format("YYYYMM"));
    cur.add(1, "month");
  }
  return Array.from(keys).sort();
}

/** 任务/提醒/日程/项目主索引归档：取各模块阈值的最小值（最激进归档 = 主索引保留窗口最短） */
export function minMainIndexArchiveThresholdDays(settings: RSLattePluginSettings): number {
  const s = settings as any;
  const projectDays = s?.projectArchiveThresholdDays ?? s?.projectModule?.archiveThresholdDays;
  const nums = [
    normalizeArchiveThresholdDays(s?.taskModule?.archiveThresholdDays ?? 90),
    normalizeArchiveThresholdDays(s?.memoModule?.archiveThresholdDays ?? 90),
    normalizeArchiveThresholdDays(s?.scheduleModule?.archiveThresholdDays ?? 90),
    normalizeArchiveThresholdDays(projectDays ?? 90),
  ];
  return Math.min(...nums);
}

/** 主索引「仍较完整」的近似起点：早于该日的已闭环条目可能已迁出主索引 */
export function mainIndexRetentionStartYmd(todayYmd: string, settings: RSLattePluginSettings): string {
  const days = minMainIndexArchiveThresholdDays(settings);
  const t = momentFn(todayYmd, "YYYY-MM-DD", true);
  if (!t.isValid()) return todayYmd;
  return t.clone().subtract(days, "days").format("YYYY-MM-DD");
}

export type ReviewIndexCoverageRisk = "none" | "partial" | "full_outside";

export type ReviewIndexCoverageAssessment = {
  risk: ReviewIndexCoverageRisk;
  /** 今日回溯阈值得到的主索引近似保留起点 */
  retentionStartYmd: string;
  minThresholdDays: number;
  /** 是否允许写入历史快照（full_outside 时 false） */
  allowSnapshot: boolean;
  /** 给用户看的说明 */
  summary: string;
};

/**
 * 判断 Review 所选周期相对「主索引归档窗口」的风险。
 * - full_outside：周期结束日早于 retentionStartYmd → 主索引大概率缺大量历史行，禁止快照。
 * - partial：周期与窗口交界 → 可快照但需提示「仅含主索引仍存在的条目」。
 */
export function assessReviewIndexCoverageForPeriod(
  startYmd: string,
  endYmd: string,
  todayYmd: string,
  settings: RSLattePluginSettings,
  opts?: { grain?: "week" | "month" | "quarter" },
): ReviewIndexCoverageAssessment {
  const minThresholdDays = minMainIndexArchiveThresholdDays(settings);
  const retentionStartYmd = mainIndexRetentionStartYmd(todayYmd, settings);
  if (opts?.grain === "quarter") {
    return {
      risk: "none",
      retentionStartYmd,
      minThresholdDays,
      allowSnapshot: true,
      summary:
        "季报统计已合并任务/提醒/日程与输出索引的**归档分片**（与侧栏实时计算口径一致），可按当前数据生成快照。",
    };
  }
  let risk: ReviewIndexCoverageRisk = "none";
  if (endYmd < retentionStartYmd) {
    risk = "full_outside";
  } else if (startYmd < retentionStartYmd && endYmd >= retentionStartYmd) {
    risk = "partial";
  }
  const allowSnapshot = risk !== "full_outside";
  let summary = "";
  if (risk === "full_outside") {
    summary = `周期结束日 ${endYmd} 早于主索引近似保留起点 ${retentionStartYmd}（归档阈值最小 ${minThresholdDays} 天）。已闭环任务/提醒/日程等可能已从主索引迁出，无法仅靠主索引还原本周期全貌，不建议生成历史快照。可调高归档阈值或从归档 JSON 恢复后再试。`;
  } else if (risk === "partial") {
    summary = `周期与主索引保留窗口交界（保留起点约 ${retentionStartYmd}）。${startYmd}～${retentionStartYmd} 一段内已归档条目可能不在主索引中，快照仅反映当前主索引 + WorkEvent 可读部分。`;
  } else {
    summary = `主索引保留窗口覆盖本周期（保留起点约 ${retentionStartYmd}，归档阈值最小 ${minThresholdDays} 天），可按当前主索引与操作日志生成快照。`;
  }
  return { risk, retentionStartYmd, minThresholdDays, allowSnapshot, summary };
}

export type ParsedReviewPeriodRange = { ok: true; periodKey: string; startYmd: string; endYmd: string } | { ok: false; error: string };

/** 将周键 `YYYY-Www`、月键 `YYYY-MM` 或季键 `YYYY-Qn` 解析为起止日（与 `ReviewView.computePeriod` 一致） */
export function parseReviewPeriodKeyToRange(
  grain: "week" | "month" | "quarter",
  periodKeyRaw: string,
): ParsedReviewPeriodRange {
  const key = String(periodKeyRaw ?? "").trim();
  if (grain === "week") {
    const m = key.match(/^(\d{4})-W(\d{2})$/i);
    if (!m) return { ok: false, error: "周格式应为 YYYY-Www，例如 2026-W14" };
    const y = Number(m[1]);
    const w = Number(m[2]);
    if (!Number.isFinite(y) || !Number.isFinite(w) || w < 1 || w > 53) return { ok: false, error: "周序号无效" };
    const start = momentFn().isoWeekYear(y).isoWeek(w).startOf("isoWeek");
    const end = start.clone().endOf("isoWeek");
    if (!start.isValid()) return { ok: false, error: "无法解析该 ISO 周" };
    return {
      ok: true,
      periodKey: `${y}-W${String(w).padStart(2, "0")}`,
      startYmd: start.format("YYYY-MM-DD"),
      endYmd: end.format("YYYY-MM-DD"),
    };
  }
  if (grain === "quarter") {
    const mq = key.match(/^(\d{4})-Q([1-4])$/i);
    if (!mq) return { ok: false, error: "季格式应为 YYYY-Q1～Q4，例如 2026-Q1" };
    const y = Number(mq[1]);
    const q = Number(mq[2]);
    if (!Number.isFinite(y) || !Number.isFinite(q)) return { ok: false, error: "季键无效" };
    const startMonth = (q - 1) * 3;
    const start = momentFn({ year: y, month: startMonth, day: 1 }).startOf("month");
    const end = start.clone().add(2, "month").endOf("month");
    if (!start.isValid()) return { ok: false, error: "无法解析该季" };
    return {
      ok: true,
      periodKey: `${y}-Q${q}`,
      startYmd: start.format("YYYY-MM-DD"),
      endYmd: end.format("YYYY-MM-DD"),
    };
  }
  const m2 = key.match(/^(\d{4})-(\d{2})$/);
  if (!m2) return { ok: false, error: "月格式应为 YYYY-MM" };
  const y = Number(m2[1]);
  const mo = Number(m2[2]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) return { ok: false, error: "月份无效" };
  const start = momentFn({ year: y, month: mo - 1, day: 1 }).startOf("month");
  const end = start.clone().endOf("month");
  if (!start.isValid()) return { ok: false, error: "无法解析该月" };
  return {
    ok: true,
    periodKey: start.format("YYYY-MM"),
    startYmd: start.format("YYYY-MM-DD"),
    endYmd: end.format("YYYY-MM-DD"),
  };
}
