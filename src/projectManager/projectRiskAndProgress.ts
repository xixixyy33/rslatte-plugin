/**
 * 项目风险分 V1（第九节）与三级里程碑加权总进度（9.4.1）
 */
import type { MilestoneProgress, ProjectEntry, ProjectTaskItem } from "./types";
import { isProjectOpenForRiskSummary } from "./projectStatus";

/** 解析 milestone_weight：缺省 1，限制 1–100 */
export function effectiveMilestoneWeight(m: Pick<MilestoneProgress, "milestone_weight"> | undefined): number {
  const n = Number((m as any)?.milestone_weight);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(100, Math.floor(n));
}

function toYmd(s?: string): string | null {
  if (!s || typeof s !== "string") return null;
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** YYYY-MM-DD 比较：a < b 返回负数 */
export function compareYmd(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** 将 progress_updated（ISO 或日期前缀）转为可排序的时间戳；无效则 null */
export function progressUpdatedToMs(s?: string): number | null {
  const y = toYmd(s);
  if (y) {
    const t = Date.parse(y + "T12:00:00");
    if (Number.isFinite(t)) return t;
  }
  if (s && typeof s === "string") {
    const t = Date.parse(s);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

function isCancelledMilestone(m: MilestoneProgress): boolean {
  return String((m as any).milestoneStatus ?? "").toLowerCase() === "cancelled";
}

function isDoneMilestone(m: MilestoneProgress): boolean {
  return String((m as any).milestoneStatus ?? "").toLowerCase() === "done";
}

/**
 * 三级里程碑加权完成比例 [0,1]。
 * - 排除 milestone_status=cancelled 的节点（不参与分母）
 * - done 节点子树视为 100%
 * - 叶级 active 视为 0%（无子里程碑时）
 */
export function computeWeightedMilestoneProgressRatio(milestones: MilestoneProgress[] | undefined): number {
  const list = (milestones ?? []).filter((m) => m && !isCancelledMilestone(m));
  if (!list.length) return 0;

  const byPath = new Map<string, MilestoneProgress>();
  for (const m of list) {
    const path = String((m as any).path ?? (m as any).name ?? "").trim();
    if (path) byPath.set(path, m);
  }

  const childrenOf = new Map<string, MilestoneProgress[]>();
  for (const m of list) {
    const path = String((m as any).path ?? "").trim();
    const parent = String((m as any).parentPath ?? "").trim();
    if (!path) continue;
    if (!parent) continue;
    const arr = childrenOf.get(parent) ?? [];
    arr.push(m);
    childrenOf.set(parent, arr);
  }

  const memo = new Map<string, number>();

  const ratioFor = (path: string): number => {
    if (memo.has(path)) return memo.get(path)!;
    const node = byPath.get(path);
    if (!node) {
      memo.set(path, 0);
      return 0;
    }
    if (isDoneMilestone(node)) {
      memo.set(path, 1);
      return 1;
    }
    const children = (childrenOf.get(path) ?? []).filter((c) => !isCancelledMilestone(c));
    if (!children.length) {
      memo.set(path, 0);
      return 0;
    }
    let wSum = 0;
    let acc = 0;
    for (const c of children) {
      const cp = String((c as any).path ?? "").trim();
      if (!cp) continue;
      const w = effectiveMilestoneWeight(c);
      wSum += w;
      acc += w * ratioFor(cp);
    }
    const r = wSum > 0 ? acc / wSum : 0;
    memo.set(path, r);
    return r;
  };

  const roots = list.filter((m) => {
    const lv = Number((m as any).level ?? 1) || 1;
    return lv === 1;
  });
  if (!roots.length) return 0;

  let wSum = 0;
  let acc = 0;
  for (const r of roots) {
    const path = String((r as any).path ?? "").trim();
    if (!path) continue;
    const w = effectiveMilestoneWeight(r);
    wSum += w;
    acc += w * ratioFor(path);
  }
  return wSum > 0 ? acc / wSum : 0;
}

export type ProjectRiskLevelKey = "low" | "medium" | "high" | "severe";

export interface ProjectRiskSummary {
  score: number;
  levelKey: ProjectRiskLevelKey;
  /** 与任务标签 CSS 后缀一致：green / yellow / orange / red */
  colorSuffix: "green" | "yellow" | "orange" | "red";
  levelLabel: string;
}

function riskLevelFromScore(score: number): Omit<ProjectRiskSummary, "score"> {
  if (score <= 2) return { levelKey: "low", colorSuffix: "green", levelLabel: "低风险" };
  if (score <= 5) return { levelKey: "medium", colorSuffix: "yellow", levelLabel: "中风险" };
  if (score <= 8) return { levelKey: "high", colorSuffix: "orange", levelLabel: "高风险" };
  return { levelKey: "severe", colorSuffix: "red", levelLabel: "严重风险" };
}

/** 从 fromYmd 到 toYmd 的天数差（日历日，用于进展停滞等） */
export function daysBetweenYmd(fromYmd: string, toYmd: string): number {
  const a = Date.parse(fromYmd + "T12:00:00");
  const b = Date.parse(toYmd + "T12:00:00");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.floor((b - a) / 86400000);
}

function taskProgressYmd(t: ProjectTaskItem): string | null {
  return toYmd(t.progress_updated) ?? toYmd(t.actual_start) ?? toYmd(t.created_date);
}

/** 第九节 9.5 风险分 V1 */
export function computeProjectRiskSummary(project: ProjectEntry, todayYmd: string): ProjectRiskSummary {
  let score = 0;

  const pe = toYmd(project.planned_end);
  if (pe && compareYmd(pe, todayYmd) < 0) {
    if (isProjectOpenForRiskSummary(project.status)) score += 4;
  }

  const milestones = project.milestones ?? [];
  for (const m of milestones) {
    if (String((m as any).milestoneStatus ?? "").toLowerCase() !== "active") continue;
    const lv = Number((m as any).level ?? 1) || 1;
    if (lv !== 1) continue;
    const mpe = toYmd((m as any).planned_end);
    if (mpe && compareYmd(mpe, todayYmd) < 0) score += 3;
  }

  const tasks = project.taskItems ?? [];
  let overdueTaskPts = 0;
  for (const t of tasks) {
    if (t.statusName === "DONE" || t.statusName === "CANCELLED") continue;
    const due = toYmd(t.planned_end);
    if (due && compareYmd(due, todayYmd) < 0) {
      overdueTaskPts += 1;
    }
  }
  score += Math.min(4, overdueTaskPts);

  const pu = toYmd(project.progress_updated);
  if (pu) {
    const d = daysBetweenYmd(pu, todayYmd);
    if (d >= 5) {
      if (isProjectOpenForRiskSummary(project.status)) score += 2;
    }
  }

  let staleInProgPts = 0;
  for (const t of tasks) {
    if (t.statusName === "DONE" || t.statusName === "CANCELLED") continue;
    const phase = t.task_phase;
    if (phase !== "in_progress" && phase !== "waiting_others") continue;
    const ty = taskProgressYmd(t);
    if (!ty) continue;
    if (daysBetweenYmd(ty, todayYmd) >= 5) staleInProgPts += 1;
  }
  score += Math.min(3, staleInProgPts);

  let waitDuePts = 0;
  for (const t of tasks) {
    if (t.statusName === "DONE" || t.statusName === "CANCELLED") continue;
    if (t.task_phase !== "waiting_until") continue;
    const wu = toYmd(t.wait_until);
    if (wu && (compareYmd(wu, todayYmd) < 0 || wu === todayYmd)) waitDuePts += 1;
  }
  score += Math.min(3, waitDuePts);

  let followStalePts = 0;
  for (const t of tasks) {
    if (t.statusName === "DONE" || t.statusName === "CANCELLED") continue;
    if (t.task_phase !== "waiting_others") continue;
    const ty = taskProgressYmd(t);
    if (!ty) continue;
    if (daysBetweenYmd(ty, todayYmd) >= 3) followStalePts += 1;
  }
  score += Math.min(2, followStalePts);

  let postponeGt2Pts = 0;
  for (const t of tasks) {
    if (t.statusName === "DONE" || t.statusName === "CANCELLED") continue;
    const pc = Number(t.postpone_count ?? 0);
    if (pc > 2) postponeGt2Pts += 1;
  }
  score += Math.min(3, postponeGt2Pts);

  for (const t of tasks) {
    if (t.statusName === "DONE" || t.statusName === "CANCELLED") continue;
    const due = toYmd(t.planned_end);
    if (!due || compareYmd(due, todayYmd) >= 0) continue;
    const pc = Number(t.postpone_count ?? 0);
    if (pc >= 1) score += 1;
  }

  for (const t of tasks) {
    if (t.statusName === "DONE" || t.statusName === "CANCELLED") continue;
    if (!t.starred) continue;
    const due = toYmd(t.planned_end);
    if (due && compareYmd(due, todayYmd) < 0) score += 3;
  }

  for (const t of tasks) {
    if (t.statusName === "DONE" || t.statusName === "CANCELLED") continue;
    if (t.statusName !== "TODO") continue;
    if (!t.starred) continue;
    const due = toYmd(t.planned_end);
    if (!due) continue;
    const untilDue = daysBetweenYmd(todayYmd, due);
    if (untilDue >= 0 && untilDue <= 3) score += 2;
  }

  score = Math.max(0, Math.floor(score));
  return { score, ...riskLevelFromScore(score) };
}

/** 未完成任务数：非 DONE、非 CANCELLED */
export function countProjectIncompleteTasks(tasks: ProjectTaskItem[] | undefined): number {
  return (tasks ?? []).filter((t) => t.statusName !== "DONE" && t.statusName !== "CANCELLED").length;
}

/** 任务总数（分母排除取消） */
export function countProjectTasksExcludingCancelled(tasks: ProjectTaskItem[] | undefined): number {
  return (tasks ?? []).filter((t) => t.statusName !== "CANCELLED").length;
}
