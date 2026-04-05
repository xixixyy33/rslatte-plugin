/**
 * 提醒（memo-index，非日程行）衍生展示标签：与 queryReminderBuckets 的日期窗口逻辑对齐。
 * 日历「今天」使用本地 moment 日（与 service.todayYmd 一致），与任务 getTaskTodayKey 可能不同。
 */
import { moment } from "obsidian";
import type { TaskPanelSettings } from "../../types/taskTypes";
import type { RSLatteIndexItem, RSLatteParsedLine } from "../types";
import { isScheduleMemoLine } from "../types";
import { normalizeRepeatRuleToken } from "../utils";

const momentFn = moment as any;

/** 与 mergeIntoIndex / queryReminderBuckets 一致的日历业务日 */
export function calendarTodayYmd(): string {
  return momentFn().format("YYYY-MM-DD");
}

/** 内部键为中文全称，与 TASK_TAG_META 模式一致 */
export const MEMO_TAG_META: Record<string, { label: string; fullName: string; colorOrder: number }> = {
  已超期: { label: "超期", fullName: "已超期", colorOrder: 1 },
  今日关注: { label: "今日", fullName: "今日关注", colorOrder: 3 },
  即将到期: { label: "将到", fullName: "即将到期", colorOrder: 3 },
  重复: { label: "重复", fullName: "重复提醒", colorOrder: 4 },
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

/**
 * 计算单条提醒的展示标签（不含日程行）。
 * @param todayYmd 须与索引写入时 tagsDerivedForYmd、queryReminderBuckets 使用的「今天」一致。
 */
export function computeMemoTags(
  it: RSLatteParsedLine | RSLatteIndexItem,
  todayYmd: string,
  panel?: TaskPanelSettings | null
): string[] {
  if (isScheduleMemoLine(it)) return [];
  const itemType = String((it as any)?.itemType ?? "").trim();
  if (itemType && itemType !== "memo") return [];

  const upcomingDays = Math.max(1, Math.min(30, Number(panel?.reminderUpcomingDays ?? 5) || 5));
  const recentClosedDays = Math.max(7, Math.min(100, Number(panel?.recentClosedMemoWindowDays ?? 30) || 30));

  const extra = ((it as any)?.extra ?? {}) as Record<string, string>;
  const status = String((it as any)?.status ?? "").trim().toUpperCase();
  const invalidated = String(extra.invalidated ?? "").trim() === "1";
  const dateYmd = String((it as any)?.memoDate ?? "").trim();
  const dd = /^\d{4}-\d{2}-\d{2}$/.test(dateYmd) ? diffDaysFrom(todayYmd, dateYmd) : null;

  const closedYmd =
    String((it as any)?.done_date ?? "").trim() ||
    String((it as any)?.cancelled_date ?? "").trim() ||
    String(extra.invalidated_date ?? "").trim() ||
    (invalidated ? String((it as any)?.updated_date ?? "").trim() : "") ||
    (invalidated ? String((it as any)?.created_date ?? "").trim() : "");
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
  if (dd != null && dd < 0) tags.push("已超期");
  else if (dd === 0) tags.push("今日关注");
  else if (dd != null && dd > 0 && dd <= upcomingDays) tags.push("即将到期");

  let rr = String((it as any).repeatRule ?? "").trim().toLowerCase();
  if (!rr) rr = String(extra.repeat_rule ?? "").trim().toLowerCase();
  if (!rr) rr = (it as any).memoMmdd ? "yearly" : "none";
  rr = normalizeRepeatRuleToken(rr);
  const allowed = new Set(["none", "weekly", "monthly", "quarterly", "yearly"]);
  const rrn = allowed.has(rr) ? rr : "none";
  if (rrn !== "none") tags.push("重复");

  return tags;
}
