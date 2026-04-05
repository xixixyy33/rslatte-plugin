import type RSLattePlugin from "../../main";
import type { RSLatteIndexItem } from "../../taskRSLatte/types";
import { scheduleItemStableKey } from "./scheduleCalendarModel";

/** 日程日历泳道/卡片上展示的关联类型（与 `linked_task_uid` / `linked_output_id` 及项目任务 id 解析一致） */
export type ScheduleCalendarLinkFlags = {
  task: boolean;
  projectTask: boolean;
  output: boolean;
};

function emptyFlags(): ScheduleCalendarLinkFlags {
  return { task: false, projectTask: false, output: false };
}

/**
 * 同步：`linked_task_uid` 是否对应项目任务清单中的 `task_id`（与 Today 泳道 emoji 一致用 🎯）。
 */
export function scheduleLinkedTaskIdIsProjectTask(plugin: RSLattePlugin, linkedTaskUid: string): boolean {
  const tid = String(linkedTaskUid ?? "").trim();
  if (!tid) return false;
  try {
    const snap: any = plugin.projectMgr?.getSnapshot?.();
    const projects = Array.isArray(snap?.projects) ? snap.projects : [];
    for (const p of projects) {
      const tasks = Array.isArray((p as any).taskItems) ? (p as any).taskItems : [];
      for (const t of tasks) {
        if (String((t as any)?.taskId ?? "").trim() === tid) return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
}

/**
 * 为选中日程列表解析关联维度（任务索引 uid vs 项目任务 task_id）。
 * 仅处理含 `linked_task_uid` 或 `linked_output_id` 的条目。
 */
export async function resolveScheduleCalendarLinkFlags(
  plugin: RSLattePlugin,
  items: RSLatteIndexItem[]
): Promise<Map<string, ScheduleCalendarLinkFlags>> {
  const out = new Map<string, ScheduleCalendarLinkFlags>();
  for (const it of items) {
    const ex = ((it as any)?.extra ?? {}) as Record<string, unknown>;
    const ltu = String(ex.linked_task_uid ?? "").trim();
    const loid = String(ex.linked_output_id ?? "").trim();
    if (!ltu && !loid) continue;
    const flags = emptyFlags();
    if (loid) flags.output = true;
    if (ltu) {
      const taskHit = await plugin.taskRSLatte.findTaskByUid(ltu);
      if (taskHit) flags.task = true;
      else if (scheduleLinkedTaskIdIsProjectTask(plugin, ltu)) flags.projectTask = true;
      else flags.task = true;
    }
    out.set(scheduleItemStableKey(it), flags);
  }
  return out;
}
