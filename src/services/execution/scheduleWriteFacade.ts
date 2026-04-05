import type { TaskRSLatteService } from "../../taskRSLatte/service";
import type { ScheduleCreateInput } from "../../types/scheduleTypes";

/**
 * 日程「写笔记」推荐入口；schedule-index 更新走 executionOrchestrator（E2 manual_refresh）。
 */
export async function writeScheduleCreate(
  svc: TaskRSLatteService,
  opts: ScheduleCreateInput
): Promise<string | undefined> {
  return svc.createScheduleMemo(opts);
}

/** 日程更新门面：修改日程信息 */
export async function writeScheduleUpdateBasicInfo(
  svc: TaskRSLatteService,
  ...args: Parameters<TaskRSLatteService["updateScheduleBasicInfo"]>
): ReturnType<TaskRSLatteService["updateScheduleBasicInfo"]> {
  return svc.updateScheduleBasicInfo(...args);
}

/** 日程更新门面：状态流转（底层复用 memo 状态机） */
export async function writeScheduleApplyStatus(
  svc: TaskRSLatteService,
  ...args: Parameters<TaskRSLatteService["applyMemoStatusAction"]>
): ReturnType<TaskRSLatteService["applyMemoStatusAction"]> {
  return svc.applyMemoStatusAction(...args);
}

/** 日程更新门面：星标（复用统一 starred 能力） */
export async function writeScheduleSetStarred(
  svc: TaskRSLatteService,
  ...args: Parameters<TaskRSLatteService["setTaskStarred"]>
): ReturnType<TaskRSLatteService["setTaskStarred"]> {
  return svc.setTaskStarred(...args);
}

/** 日程更新门面：失效/恢复周期（底层复用 memo 失效能力） */
export async function writeScheduleSetInvalidated(
  svc: TaskRSLatteService,
  ...args: Parameters<TaskRSLatteService["setMemoInvalidated"]>
): ReturnType<TaskRSLatteService["setMemoInvalidated"]> {
  return svc.setMemoInvalidated(...args);
}
