/**
 * 里程碑树：一级 roots 与任务归属路径解析（推进区 / 进度树 / index 衍生层共用）
 */
import { DEFAULT_MILESTONE_PATH, resolveEffectiveMilestonePath } from "./parser";
import type { MilestoneProgress, ProjectEntry, ProjectTaskItem } from "./types";

export type ProjectMilestoneTree = {
  roots: MilestoneProgress[];
  effectivePathForTask: (it: ProjectTaskItem) => string;
  childrenMap: Map<string, MilestoneProgress[]>;
  msIndex: Map<string, { status?: "active" | "done" | "cancelled"; parentPath?: string }>;
};

/** 与 `ProjectSidePanelView.getProjectRootsAndPathResolver` 逻辑一致 */
export function getProjectMilestoneRootsAndResolver(p: ProjectEntry): ProjectMilestoneTree {
  const milestones = (p.milestones ?? []) as MilestoneProgress[];
  const allTasks = ((p as any).taskItems ?? []) as ProjectTaskItem[];

  const msIndex = new Map<string, { status?: "active" | "done" | "cancelled"; parentPath?: string }>();
  for (const m of milestones) {
    const path = String((m as any)?.path ?? (m as any)?.name ?? "").trim();
    if (!path) continue;
    msIndex.set(path, {
      status: (m as any)?.milestoneStatus as any,
      parentPath: String((m as any)?.parentPath ?? "").trim() || undefined,
    });
  }

  const effectivePathForTask = (it: ProjectTaskItem): string => {
    const raw = String((it as any).milestonePath ?? (it as any).milestone ?? "").trim();
    return resolveEffectiveMilestonePath(raw, msIndex);
  };

  let needDefault = false;
  for (const it of allTasks) {
    if (effectivePathForTask(it) === DEFAULT_MILESTONE_PATH) {
      needDefault = true;
      break;
    }
  }

  const merged: MilestoneProgress[] = [...milestones];
  if (needDefault || (!milestones.length && allTasks.length)) {
    merged.push({
      name: DEFAULT_MILESTONE_PATH,
      path: DEFAULT_MILESTONE_PATH,
      level: 1,
      parentPath: "",
      headingLineNo: 1e9,
      milestoneStatus: "active",
      done: 0,
      todo: 0,
      inprogress: 0,
      cancelled: 0,
      total: 0,
    } as any);
  }

  const sorted = [...merged].sort((a: any, b: any) => {
    const la = Number(a?.headingLineNo ?? 1e9);
    const lb = Number(b?.headingLineNo ?? 1e9);
    if (la !== lb) return la - lb;
    return String(a?.name ?? "").localeCompare(String(b?.name ?? ""), "zh-Hans-CN");
  });

  const allPaths = new Set<string>();
  for (const m of sorted) {
    const path = String((m as any)?.path ?? (m as any)?.name ?? "").trim();
    if (path) allPaths.add(path);
  }

  const childrenMap = new Map<string, MilestoneProgress[]>();
  const roots: MilestoneProgress[] = [];
  for (const m of sorted) {
    const path = String((m as any)?.path ?? (m as any)?.name ?? "").trim();
    if (!path) continue;
    const parentPath = String((m as any)?.parentPath ?? "").trim();
    if (parentPath && allPaths.has(parentPath)) {
      const arr = childrenMap.get(parentPath) ?? [];
      arr.push(m);
      childrenMap.set(parentPath, arr);
    } else {
      roots.push(m);
    }
  }
  return { roots, effectivePathForTask, childrenMap, msIndex };
}
