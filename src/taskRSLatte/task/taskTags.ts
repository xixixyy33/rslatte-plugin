/**
 * 任务标签：计算逻辑与展示元数据（缩写、颜色、排序）
 * 见 docs/V2改造方案/执行类管理优化方案.md · 任务管理优化 · 第十节
 */
import type { RSLatteIndexItem, RSLatteParsedLine } from "../types";
import type { TaskPanelSettings } from "../../types/taskTypes";
import { reconcileTaskDisplayPhase } from "../utils";
import { todayLocalYmd } from "../../utils/localCalendarYmd";

/** 标签 key（内部一致用中文全称，与方案 10.1 表一致） */
export const TASK_TAG_KEYS = [
  "已超期",
  "已延期",
  "高拖延风险",
  "今日应处理",
  "等待跟进",
  "假活跃",
  "活跃任务",
] as const;

export type TaskTagKey = (typeof TASK_TAG_KEYS)[number];

/** 展示缩写、完整名、颜色排序（1=红 2=橙 3=黄 4=绿），同色按标签名排序 */
export const TASK_TAG_META: Record<
  string,
  { label: string; fullName: string; colorOrder: number }
> = {
  已超期: { label: "超期", fullName: "已超期", colorOrder: 1 },
  已延期: { label: "延期", fullName: "已延期", colorOrder: 3 },
  高拖延风险: { label: "拖延", fullName: "高拖延风险", colorOrder: 2 },
  今日应处理: { label: "今日", fullName: "今日应处理", colorOrder: 3 },
  等待跟进: { label: "跟进", fullName: "等待跟进", colorOrder: 3 },
  假活跃: { label: "假活", fullName: "假活跃", colorOrder: 3 },
  活跃任务: { label: "活跃", fullName: "活跃任务", colorOrder: 4 },
  /** 项目一级里程碑轨「下一步」（第十节）；与 `project_task_tags` 共用 */
  next_action: { label: "下一步", fullName: "里程碑下一步", colorOrder: 3 },
};

/** 根据任务基准日期设置计算「今天」YYYY-MM-DD */
export function getTaskTodayKey(panel?: TaskPanelSettings | null): string {
  if (!panel || panel.taskBaseDateMode !== "zone" || !panel.taskBaseTimeZone) {
    try {
      return (window as any).moment?.().format("YYYY-MM-DD") ?? todayLocalYmd();
    } catch {
      return todayLocalYmd();
    }
  }
  try {
    const zone = String(panel.taskBaseTimeZone).trim();
    const m = (window as any).moment?.().tz?.(zone);
    if (m && typeof m.format === "function") return m.format("YYYY-MM-DD");
    return new Date().toLocaleDateString("en-CA", { timeZone: zone });
  } catch {
    return todayLocalYmd();
  }
}

function toYmd(s?: string): string | null {
  if (!s || typeof s !== "string") return null;
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** 进度最后更新时间：优先 progress_updated，缺失用 actual_start 或 created_date 兜底 */
function getProgressUpdatedYmd(t: RSLatteParsedLine | RSLatteIndexItem): string | null {
  const anyT = t as any;
  return (
    toYmd(anyT.progress_updated) ??
    toYmd(anyT.actual_start) ??
    toYmd(anyT.created_date) ??
    null
  );
}

/** 是否活跃（未完成且未取消的进行中状态） */
function isActive(t: RSLatteParsedLine | RSLatteIndexItem): boolean {
  const status = String((t as any).status ?? "").toUpperCase();
  if (status === "DONE" || status === "CANCELLED") return false;
  if (status === "TODO") return true;
  if (status === "IN_PROGRESS") return true;
  return false;
}

/** 是否已超期：计划结束日 < 今天 且未完成、未取消 */
function isOverdue(t: RSLatteParsedLine | RSLatteIndexItem, today: string): boolean {
  if (!isActive(t)) return false;
  const due = toYmd((t as any).planned_end);
  return !!due && due < today;
}

/** 计算未更新进度天数（与今天比较）；无日期返回 Infinity */
function daysSinceProgress(t: RSLatteParsedLine | RSLatteIndexItem, today: string): number {
  const ymd = getProgressUpdatedYmd(t);
  if (!ymd) return Infinity;
  try {
    const momentFn = (window as any).moment;
    if (momentFn && typeof momentFn === "function") {
      const a = momentFn(ymd, "YYYY-MM-DD", true);
      const b = momentFn(today, "YYYY-MM-DD", true);
      if (a.isValid() && b.isValid()) return b.diff(a, "days");
    }
  } catch {}
  const a = new Date(ymd).getTime();
  const b = new Date(today).getTime();
  return Math.floor((b - a) / (24 * 60 * 60 * 1000));
}

/**
 * 计算任务标签（纯函数）
 * @param t 任务项（索引项或解析行）
 * @param today 今天 YYYY-MM-DD
 * @param panel 任务面板设置（假活跃阈值等）
 * @returns 按展示顺序排列的 tag key 数组
 */
export function computeTaskTags(
  t: RSLatteParsedLine | RSLatteIndexItem,
  today: string,
  panel?: TaskPanelSettings | null
): string[] {
  const anyT = t as any;
  const phase = reconcileTaskDisplayPhase(String(anyT.status ?? ""), anyT.task_phase, {
    wait_until: anyT.wait_until,
    follow_up: anyT.follow_up,
  });
  const due = toYmd(anyT.planned_end);
  const plannedStart = toYmd(anyT.planned_start);
  const waitUntil = toYmd(anyT.wait_until);
  const followUp = toYmd(anyT.follow_up);
  const postponeCount = Math.max(0, Number(anyT.postpone_count) ?? 0);
  const starred = !!(anyT.starred === true || anyT.starred === 1 || anyT.starred === "1");
  const fakeThreshold = Math.max(0, Number(panel?.fakeActiveThresholdDays) ?? 3);
  const daysNoProgress = daysSinceProgress(t, today);

  const active = isActive(t);
  const overdue = isOverdue(t, today);

  const tags: string[] = [];

  if (active) tags.push("活跃任务");

  if (overdue) tags.push("已超期");
  if (due === today) tags.push("今日应处理");
  /** ⏳ 计划开始日=任务日且待办/处理中 →「今日」（仅有 ⏳ 无 📅 时侧栏也能与 Today 行动清单一致） */
  if (
    plannedStart === today &&
    active &&
    (phase === "todo" || phase === "in_progress")
  ) {
    tags.push("今日应处理");
  }
  if (waitUntil === today && phase === "waiting_until") tags.push("今日应处理");
  if (starred && active) tags.push("今日应处理");
  if (followUp === today && phase === "waiting_others") tags.push("今日应处理");

  if (postponeCount > 0) tags.push("已延期");

  if (postponeCount > 2) tags.push("高拖延风险");
  if (overdue && postponeCount >= 1) tags.push("高拖延风险");
  if (
    (phase === "in_progress" || phase === "waiting_others") &&
    daysNoProgress > 5
  )
    tags.push("高拖延风险");
  if (phase === "waiting_until" && waitUntil && waitUntil <= today)
    tags.push("高拖延风险");

  if (phase === "waiting_others") tags.push("等待跟进");
  if (phase === "waiting_until" && waitUntil && waitUntil <= today)
    tags.push("等待跟进");

  if (
    (phase === "in_progress" || phase === "waiting_others") &&
    daysNoProgress >= fakeThreshold
  )
    tags.push("假活跃");

  return sortTagKeysForDisplay([...new Set(tags)]);
}

/** 按颜色顺序（红→橙→黄→绿），同色按标签名字典序 */
export function sortTagKeysForDisplay(keys: string[]): string[] {
  return keys.slice().sort((a, b) => {
    const orderA = TASK_TAG_META[a]?.colorOrder ?? 99;
    const orderB = TASK_TAG_META[b]?.colorOrder ?? 99;
    if (orderA !== orderB) return orderA - orderB;
    const labelA = TASK_TAG_META[a]?.label ?? a;
    const labelB = TASK_TAG_META[b]?.label ?? b;
    return labelA.localeCompare(labelB, "zh-CN");
  });
}
