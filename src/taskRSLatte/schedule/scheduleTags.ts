/**
 * 日程（schedule-index）衍生展示标签：与 queryScheduleBuckets 的日期窗口逻辑对齐。
 */
import type { TaskPanelSettings } from "../../types/taskTypes";
import type { RSLatteIndexItem, RSLatteParsedLine } from "../types";
import { isScheduleMemoLine } from "../types";
import { normalizeRepeatRuleToken } from "../utils";

export const SCHEDULE_TAG_META: Record<string, { label: string; fullName: string; colorOrder: number }> = {
  已超期: { label: "超期", fullName: "已超期", colorOrder: 1 },
  今日日程: { label: "今日", fullName: "今日日程", colorOrder: 3 },
  即将开始: { label: "将始", fullName: "即将开始", colorOrder: 3 },
  全天: { label: "全天", fullName: "全天日程", colorOrder: 4 },
  重复: { label: "重复", fullName: "重复日程", colorOrder: 4 },
  近期闭环: { label: "闭环", fullName: "近期完成/取消/失效", colorOrder: 4 },
};

function toUtcDay(ymd: string): number | null {
  const m = String(ymd ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function diffDaysFrom(todayYmd: string, targetYmd: string): number | null {
  const a = toUtcDay(todayYmd);
  const b = toUtcDay(targetYmd);
  if (a == null || b == null) return null;
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.floor((b - a) / dayMs);
}

function getScheduleDate(it: RSLatteParsedLine | RSLatteIndexItem): string {
  const extra = ((it as any)?.extra ?? {}) as Record<string, string>;
  const fromExtra = String(extra.schedule_date ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(fromExtra)) return fromExtra;
  return String((it as any)?.memoDate ?? "").trim();
}

/** 是否视为「全天」：持续 ≥23h 或起止覆盖整日 */
function isAllDaySchedule(it: RSLatteParsedLine | RSLatteIndexItem): boolean {
  const extra = ((it as any)?.extra ?? {}) as Record<string, string>;
  const dur = Math.floor(Number(extra.duration_min ?? 0));
  if (Number.isFinite(dur) && dur >= 23 * 60) return true;
  const st = String(extra.start_time ?? "").trim();
  const et = String(extra.end_time ?? "").trim();
  if (st === "00:00" && et === "23:59") return true;
  return false;
}

/**
 * 单条日程展示标签；非日程形态返回空数组。
 */
export function computeScheduleTags(
  it: RSLatteParsedLine | RSLatteIndexItem,
  todayYmd: string,
  panel?: TaskPanelSettings | null
): string[] {
  if (!isScheduleMemoLine(it)) return [];

  const upcomingDays = Math.max(1, Math.min(30, Number(panel?.scheduleUpcomingDays ?? 5) || 5));
  const recentClosedDays = Math.max(7, Math.min(100, Number(panel?.scheduleRecentClosedDays ?? 30) || 30));

  const extra = ((it as any)?.extra ?? {}) as Record<string, string>;
  const status = String((it as any)?.status ?? "").trim().toUpperCase();
  const invalidated = String(extra.invalidated ?? "").trim() === "1";
  const dateYmd = getScheduleDate(it);
  const dd = /^\d{4}-\d{2}-\d{2}$/.test(dateYmd) ? diffDaysFrom(todayYmd, dateYmd) : null;

  const closedYmd =
    String((it as any)?.done_date ?? "").trim() ||
    String((it as any)?.cancelled_date ?? "").trim() ||
    String(extra.invalidated_date ?? "").trim() ||
    (invalidated ? String((it as any)?.updated_date ?? "").trim() : "");
  const closedDiff = closedYmd ? diffDaysFrom(todayYmd, closedYmd) : null;

  if (
    (status === "DONE" || status === "CANCELLED" || invalidated) &&
    closedDiff != null &&
    closedDiff <= 0 &&
    Math.abs(closedDiff) <= recentClosedDays
  ) {
    return ["近期闭环"];
  }
  if (status === "DONE" || status === "CANCELLED" || invalidated) {
    return [];
  }

  const tags: string[] = [];
  if (dd === 0) tags.push("今日日程");
  else if (dd != null && dd > 0 && dd <= upcomingDays) tags.push("即将开始");
  else if (dd != null && dd < 0) tags.push("已超期");

  if (isAllDaySchedule(it)) tags.push("全天");

  let rr = String((it as any).repeatRule ?? "").trim().toLowerCase();
  if (!rr) rr = String(extra.repeat_rule ?? "").trim().toLowerCase();
  rr = normalizeRepeatRuleToken(rr);
  const allowed = new Set(["none", "weekly", "monthly", "quarterly", "yearly"]);
  const rrn = allowed.has(rr) ? rr : "none";
  if (rrn !== "none") tags.push("重复");

  return tags;
}
