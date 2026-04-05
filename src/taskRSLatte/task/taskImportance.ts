/**
 * 任务重要性计算策略（见 docs/V2改造方案/执行类管理优化方案.md · 任务管理优化 · 第十一节）
 * 用于排序与抓取 Top N（如重点关注清单、Today 今日焦点），候选池 + 权重 + Top N 约束。
 */
import type { RSLatteIndexItem, RSLatteParsedLine } from "../types";
import { reconcileTaskDisplayPhase } from "../utils";
import type { TaskPanelSettings } from "../../types/taskTypes";
import { computeTaskTags, getTaskTodayKey } from "./taskTags";

function toYmd(s?: string): string | null {
  if (!s || typeof s !== "string") return null;
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

export type TaskImportanceResult = {
  score: number;
  isRisk: boolean;
  isTodayAction: boolean;
};

/** 是否在候选池内：今日应处理（含到期=今天、已超期、今天等待/跟进、星标活跃） */
function isInCandidatePool(
  t: RSLatteParsedLine | RSLatteIndexItem,
  today: string,
  panel?: TaskPanelSettings | null
): boolean {
  const tags = computeTaskTags(t, today, panel);
  return isInCandidatePoolFromTags(tags);
}

/** 与 {@link isInCandidatePool} 相同判定，消费已算好的 task_tags（避免重复 computeTaskTags） */
export function isInCandidatePoolFromTags(tags: string[]): boolean {
  return (
    tags.includes("今日应处理") ||
    tags.includes("已超期") ||
    tags.includes("高拖延风险") ||
    tags.includes("假活跃")
  );
}

function indexItemHasDerivativeFields(it: any): boolean {
  return (
    Array.isArray(it?.task_tags) &&
    typeof it.importance_score === "number" &&
    typeof it.importance_is_risk === "boolean" &&
    typeof it.importance_is_today_action === "boolean"
  );
}

/**
 * 在已有 task_tags 的前提下计算重要性（供 mergeIntoIndex 等只算一次标签）
 */
export function computeTaskImportanceFromTags(
  t: RSLatteParsedLine | RSLatteIndexItem,
  tags: string[],
  today: string
): TaskImportanceResult {
  const anyT = t as any;
  const due = toYmd(anyT.planned_end);
  const waitUntil = toYmd(anyT.wait_until);
  const followUp = toYmd(anyT.follow_up);
  const phase = reconcileTaskDisplayPhase(String(anyT.status ?? ""), anyT.task_phase, {
    wait_until: anyT.wait_until,
    follow_up: anyT.follow_up,
  });
  const starred = !!(anyT.starred === true || anyT.starred === 1 || anyT.starred === "1");

  let score = 0;
  if (starred) score += 3;
  if (due === today) score += 3;
  if (tags.includes("已超期")) score += 3;
  if (phase === "waiting_until" && waitUntil === today) score += 2;
  if (phase === "waiting_others" && followUp === today) score += 2;
  if (tags.includes("已延期")) score += 1;
  if (tags.includes("高拖延风险")) score += 1;
  if (tags.includes("假活跃")) score += 1;

  const isRisk = ["已超期", "已延期", "高拖延风险", "假活跃"].some((k) => tags.includes(k));
  const isTodayAction =
    due === today ||
    (phase === "waiting_until" && waitUntil === today) ||
    (phase === "waiting_others" && followUp === today);

  return { score, isRisk, isTodayAction };
}

/**
 * 计算单条任务的重要性得分与分类
 * 复用第十节标签判定，按 11.3 权重累加（每维度只加一次）
 */
export function computeTaskImportance(
  t: RSLatteParsedLine | RSLatteIndexItem,
  today: string,
  panel?: TaskPanelSettings | null
): TaskImportanceResult {
  const tags = computeTaskTags(t, today, panel);
  return computeTaskImportanceFromTags(t, tags, today);
}

export type GetTopImportantTasksOpts = {
  /** 与 getTaskTodayKey() 一致；等于 today 且条目含衍生字段时读索引，避免重复标签/重要性计算 */
  indexTagsDay?: string | null;
};

/**
 * 从候选池中取 Top N，并应用约束：风险类最多 1 条，至少 1 条「今天明确要处理」
 */
export function getTopImportantTasks<T extends RSLatteParsedLine | RSLatteIndexItem>(
  tasks: T[],
  today: string,
  panel: TaskPanelSettings | null | undefined,
  n: number,
  opts?: GetTopImportantTasksOpts
): T[] {
  const useIndex = opts?.indexTagsDay === today;

  const pool = tasks.filter((t) => {
    if (useIndex && indexItemHasDerivativeFields(t)) {
      return isInCandidatePoolFromTags((t as any).task_tags as string[]);
    }
    return isInCandidatePool(t, today, panel);
  });
  if (pool.length === 0 || n <= 0) return [];

  type WithMeta = T & { _score: number; _isRisk: boolean; _isTodayAction: boolean };
  const withMeta: WithMeta[] = pool.map((t) => {
    if (useIndex && indexItemHasDerivativeFields(t)) {
      const anyT = t as any;
      return {
        ...t,
        _score: anyT.importance_score as number,
        _isRisk: anyT.importance_is_risk as boolean,
        _isTodayAction: anyT.importance_is_today_action as boolean,
      } as WithMeta;
    }
    const r = computeTaskImportance(t, today, panel);
    return { ...t, _score: r.score, _isRisk: r.isRisk, _isTodayAction: r.isTodayAction } as WithMeta;
  });

  withMeta.sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    const fa = (a as any).filePath ?? "";
    const fb = (b as any).filePath ?? "";
    if (fa !== fb) return fa.localeCompare(fb);
    return ((a as any).lineNo ?? 0) - ((b as any).lineNo ?? 0);
  });

  const take = Math.min(n, withMeta.length);
  let top: WithMeta[] = withMeta.slice(0, take);
  const rest = withMeta.slice(take);

  // 约束1：风险类最多 1 条；递补时优先非风险，不足时用「被剔除的风险任务 + rest」按分数补足到 n 条
  const riskInTop = top.filter((x) => x._isRisk);
  if (riskInTop.length > 1) {
    const keepRisk = riskInTop[0];
    const removedRisks = riskInTop.slice(1); // 被剔除的风险任务（含可能本该是第2、3名的）
    const nonRiskRest = rest.filter((x) => !x._isRisk);
    top = top.filter((x) => !x._isRisk || x === keepRisk);
    while (top.length < take && nonRiskRest.length > 0) {
      top.push(nonRiskRest.shift()!);
    }
    // 仍不足 n 条时，递补池 = 被剔除的风险任务 + rest，按分数排序后依次补足（保证榜单满 n 条）
    if (top.length < take) {
      const alreadyInTop = new Set(
        top.map((x) => (x as any).uid ?? `${(x as any).filePath}#${(x as any).lineNo}`)
      );
      const remainder = [...removedRisks, ...rest]
        .filter((x) => !alreadyInTop.has((x as any).uid ?? `${(x as any).filePath}#${(x as any).lineNo}`))
        .sort((a, b) => b._score - a._score);
      for (const x of remainder) {
        if (top.length >= take) break;
        top.push(x);
      }
      top.sort((a, b) => b._score - a._score);
    }
  }

  // 约束2：至少 1 条「今天明确要处理」
  const hasTodayAction = top.some((x) => x._isTodayAction);
  if (!hasTodayAction) {
    const todayActionInRest = rest.filter((x) => x._isTodayAction);
    if (todayActionInRest.length > 0) {
      const bestToday = todayActionInRest[0];
      top = top.slice(0, -1).concat([bestToday]);
      top.sort((a, b) => b._score - a._score);
    }
  }

  return top.map(({ _score, _isRisk, _isTodayAction, ...t }) => t as unknown as T);
}

export { getTaskTodayKey };
