/**
 * 项目快照衍生字段（第十节 项目 index 数据优化）：任务标签、重要性、一级轨「下一步」、项目/里程碑 tags。
 * 在 `commitSnapshot` / `applyPanelHydrateSnapshot` 后统一计算，侧栏与 Today 优先读字段并 best-effort 回退现算。
 */
import type { TaskPanelSettings } from "../types/taskTypes";
import { computeTaskTags, getTaskTodayKey } from "../taskRSLatte/task/taskTags";
import { computeTaskImportanceFromTags } from "../taskRSLatte/task/taskImportance";
import { compareYmd, computeProjectRiskSummary, daysBetweenYmd } from "./projectRiskAndProgress";
import { getProjectMilestoneRootsAndResolver } from "./milestoneTreeUtils";
import { isProjectClosedForUiSummary, normalizeProjectStatus } from "./projectStatus";
import type { MilestoneProgress, ProjectEntry, ProjectTaskItem } from "./types";

const NEXT_ACTION_TAG = "next_action";

function toYmd(s?: string): string | null {
  if (!s || typeof s !== "string") return null;
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function projectTaskToTaskLike(it: ProjectTaskItem): Record<string, unknown> {
  return { ...it, status: it.statusName };
}

/**
 * 一级轨「下一步」：活跃任务按 `planned_end` 升序（合法日期优先），无日期殿后，同键按 `lineNo` 升序。
 * 见 docs/V2改造方案/04-项目管理优化方案.md · 10.3
 */
export function compareTasksForNextAction(a: ProjectTaskItem, b: ProjectTaskItem): number {
  const ay = toYmd(a.planned_end);
  const by = toYmd(b.planned_end);
  const aHas = !!(ay && /^\d{4}-\d{2}-\d{2}$/.test(ay));
  const bHas = !!(by && /^\d{4}-\d{2}-\d{2}$/.test(by));
  if (aHas !== bHas) return aHas ? -1 : 1;
  if (aHas && bHas && ay !== by) return compareYmd(ay!, by!);
  return (a.lineNo ?? 0) - (b.lineNo ?? 0);
}

/** 活跃：非 DONE、非 CANCELLED */
export function isActiveProjectTask(t: ProjectTaskItem): boolean {
  return t.statusName !== "DONE" && t.statusName !== "CANCELLED";
}

export function pickNextActionTaskForL1Track(
  allTasks: ProjectTaskItem[],
  milestonePath: string,
  effectivePathForTask: (it: ProjectTaskItem) => string,
): ProjectTaskItem | null {
  const subtree = allTasks.filter((it) => {
    const ep = effectivePathForTask(it);
    if (!ep || !milestonePath) return false;
    return ep === milestonePath || ep.startsWith(milestonePath + " / ");
  });
  const active = subtree.filter(isActiveProjectTask);
  if (!active.length) return null;
  return [...active].sort(compareTasksForNextAction)[0] ?? null;
}

export type ApplyProjectDerivativesCtx = {
  taskPanel?: TaskPanelSettings | null;
  /** 任务面板「今日」键，与 `getTaskTodayKey(taskPanel)` 一致 */
  todayYmd: string;
  /** 一级里程碑「即将超期」天数，与设置 `projectPanel.progressMilestoneUpcomingDays` 一致 */
  progressMilestoneUpcomingDays?: number;
  /** 项目概要「即将超期」天数，与 `projectPanel.progressProjectUpcomingDays` 一致（第九节 9.4） */
  progressProjectUpcomingDays?: number;
};

/** 项目信息 `status` → 概要区中文（与 9.4 一致）；规范值经 `normalizeProjectStatus` 与 §8.3 对齐 */
export function projectStatusDisplayZh(status: unknown): string {
  const n = normalizeProjectStatus(status);
  if (n === "done") return "已完成";
  if (n === "pending_archive") return "待归档";
  if (n === "cancelled") return "已取消";
  if (n === "in-progress") return "进行中";
  if (n === "todo") return "待开始";
  const raw = String(status ?? "").trim();
  return raw || "—";
}

function buildProjectTags(p: ProjectEntry, todayYmd: string, projectUpcomingDays: number): string[] {
  const r = computeProjectRiskSummary(p, todayYmd);
  const levelMap: Record<string, string> = {
    low: "risk_low",
    medium: "risk_medium",
    high: "risk_high",
    severe: "risk_critical",
  };
  const tags: string[] = [levelMap[r.levelKey] ?? "risk_low"];
  const pe = toYmd(p.planned_end);
  const isClosed = isProjectClosedForUiSummary(p.status);
  if (pe && !isClosed && compareYmd(pe, todayYmd) <= 0) {
    tags.push("project_overdue");
  }
  const postponeCount = Math.max(0, Number((p as any).postpone_count ?? 0) || 0);
  if (!isClosed && postponeCount >= 1) {
    tags.push("project_postponed");
  }
  if (pe && !isClosed && compareYmd(pe, todayYmd) > 0) {
    const untilDue = daysBetweenYmd(todayYmd, pe);
    if (untilDue >= 0 && untilDue <= projectUpcomingDays) {
      tags.push("project_soon_overdue");
    }
  }
  const pu = toYmd(p.progress_updated);
  if (pu && daysBetweenYmd(pu, todayYmd) >= 5 && !isClosed) {
    tags.push("stale_progress");
  }
  return tags;
}

function buildMilestoneTags(m: MilestoneProgress, todayYmd: string, milestoneSoonDays: number): string[] {
  const tags: string[] = [];
  const st = String((m as any).milestoneStatus ?? "active").toLowerCase();
  const level = Number((m as any).level ?? 1) || 1;
  if (st === "done") tags.push("milestone_done");
  else if (st === "cancelled" || st === "canceled") tags.push("milestone_cancelled");
  else {
    tags.push("milestone_active");
    // 超期 / 即将超期 / 延期：仅一级里程碑写入 index（milestone_tags）
    if (level === 1) {
      const mpe = toYmd((m as any).planned_end);
      if (mpe) {
        const cmp = compareYmd(mpe, todayYmd);
        if (cmp < 0) tags.push("milestone_overdue");
        else {
          const untilDue = daysBetweenYmd(todayYmd, mpe);
          if (untilDue >= 0 && untilDue <= milestoneSoonDays) tags.push("milestone_soon_overdue");
        }
      }
      const postponeCount = Math.max(0, Number((m as any).postpone_count ?? 0) || 0);
      if (postponeCount >= 1) tags.push("milestone_postponed");
    }
  }
  return tags;
}

/**
 * 就地写入 `projects` 内各 `ProjectEntry` / `MilestoneProgress` / `ProjectTaskItem` 的衍生字段。
 */
export function applyProjectSnapshotDerivatives(projects: ProjectEntry[], ctx: ApplyProjectDerivativesCtx): void {
  const panel = ctx.taskPanel ?? undefined;
  const todayYmd = String(ctx.todayYmd ?? "").trim() || getTaskTodayKey(panel);
  const milestoneSoonDays = Math.max(0, Math.min(30, Number(ctx.progressMilestoneUpcomingDays ?? 3) || 3));
  const projectUpcomingDays = Math.max(0, Math.min(30, Number(ctx.progressProjectUpcomingDays ?? 5) || 5));

  for (const p of projects ?? []) {
    (p as any).project_tags = buildProjectTags(p, todayYmd, projectUpcomingDays);
    (p as any).project_status_display_zh = projectStatusDisplayZh(p.status);
    (p as any).projectDerivedForYmd = todayYmd;

    for (const m of p.milestones ?? []) {
      (m as any).milestone_tags = buildMilestoneTags(m, todayYmd, milestoneSoonDays);
    }

    const tasks = (p.taskItems ?? []) as ProjectTaskItem[];
    for (const t of tasks) {
      const like = projectTaskToTaskLike(t);
      const tags = computeTaskTags(like as any, todayYmd, panel);
      const imp = computeTaskImportanceFromTags(like as any, tags, todayYmd);
      t.project_task_tags = tags;
      t.importance_score = imp.score;
      t.importance_is_risk = imp.isRisk;
      t.importance_is_today_action = imp.isTodayAction;
      t.is_next_action_for_l1 = false;
      t.next_action_root_path = undefined;
      const idx = t.project_task_tags.indexOf(NEXT_ACTION_TAG);
      if (idx >= 0) t.project_task_tags.splice(idx, 1);
    }

    const { roots, effectivePathForTask } = getProjectMilestoneRootsAndResolver(p);
    for (const root of roots) {
      const milestonePath = String((root as any)?.path ?? (root as any)?.name ?? "").trim();
      if (!milestonePath) continue;
      const next = pickNextActionTaskForL1Track(tasks, milestonePath, effectivePathForTask);
      if (!next) continue;
      next.is_next_action_for_l1 = true;
      next.next_action_root_path = milestonePath;
      if (!next.project_task_tags) next.project_task_tags = [];
      if (!next.project_task_tags.includes(NEXT_ACTION_TAG)) {
        next.project_task_tags = [...next.project_task_tags, NEXT_ACTION_TAG];
      }
    }
  }
}

/** 侧栏 / Today：优先快照 `project_task_tags`，缺省再 `computeTaskTags` */
export function getProjectTaskTagsOrCompute(
  it: ProjectTaskItem,
  todayYmd: string,
  panel?: TaskPanelSettings | null,
): string[] {
  const pre = it.project_task_tags;
  if (Array.isArray(pre) && pre.length > 0) return [...pre];
  return computeTaskTags(projectTaskToTaskLike(it) as any, todayYmd, panel);
}
