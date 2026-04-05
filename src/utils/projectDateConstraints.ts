import { normalizePath } from "obsidian";
import type { ProjectEntry } from "../projectManager/types";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** 新增项目任务 / CSV：相对项目与所属里程碑的日期边界 */
export type ProjectTaskDateBounds = {
  projectPlannedStart?: string;
  projectPlannedEnd?: string;
  /** 任务「计划结束日」上限：优先一级里程碑 milestone_planned_end，否则项目 planned_end */
  taskDueMaxYmd?: string;
  taskDueMaxLabel?: string;
};

export function resolveProjectTaskDateBounds(
  snapshotProjects: ProjectEntry[],
  projectFolderPath: string,
  milestonePath: string,
): ProjectTaskDateBounds {
  const folder = normalizePath(String(projectFolderPath ?? "").trim());
  const proj = snapshotProjects.find((p) => normalizePath(String(p.folderPath ?? "").trim()) === folder);
  if (!proj) return {};
  const ps = String(proj.planned_start ?? "").trim();
  const pe = String(proj.planned_end ?? "").trim();
  const projStart = YMD.test(ps) ? ps : undefined;
  const projEnd = YMD.test(pe) ? pe : undefined;
  const mp = String(milestonePath ?? "").trim();
  const ms = proj.milestones?.find((m) => String(m.path ?? "").trim() === mp);
  const mPe = ms?.planned_end ? String(ms.planned_end).trim() : "";
  const msEnd = YMD.test(mPe) ? mPe : undefined;
  if (msEnd) {
    return {
      projectPlannedStart: projStart,
      projectPlannedEnd: projEnd,
      taskDueMaxYmd: msEnd,
      taskDueMaxLabel: "里程碑计划完成日",
    };
  }
  if (projEnd) {
    return {
      projectPlannedStart: projStart,
      projectPlannedEnd: projEnd,
      taskDueMaxYmd: projEnd,
      taskDueMaxLabel: "项目计划结束日",
    };
  }
  return { projectPlannedStart: projStart, projectPlannedEnd: projEnd };
}

export type TaskDateValidation = { ok: boolean; messages: string[] };

/** 校验单条任务：计划开始/结束相对项目与上限 */
export function validateProjectTaskDates(opts: {
  plannedStart?: string;
  plannedEnd: string;
  bounds: ProjectTaskDateBounds;
}): TaskDateValidation {
  const messages: string[] = [];
  const end = String(opts.plannedEnd ?? "").trim();
  const start = String(opts.plannedStart ?? "").trim();
  if (!YMD.test(end)) return { ok: false, messages: [] };
  if (start && YMD.test(start)) {
    if (start > end) messages.push("计划开始日不能晚于计划结束日");
  }
  const b = opts.bounds;
  if (b.projectPlannedStart && start && YMD.test(start) && start < b.projectPlannedStart) {
    messages.push(`计划开始日不能早于项目计划开始日（${b.projectPlannedStart}）`);
  }
  if (b.taskDueMaxYmd && end > b.taskDueMaxYmd) {
    const label = b.taskDueMaxLabel ?? "计划完成/结束";
    messages.push(`计划结束日不能晚于${label}（${b.taskDueMaxYmd}）`);
  }
  return { ok: messages.length === 0, messages };
}
