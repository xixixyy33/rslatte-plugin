import type { TaskRSLatteService } from "../../taskRSLatte/service";

/**
 * 任务「写笔记」推荐入口：侧栏 / 三合一 / Capture / 移动端等应优先经此调用，
 * 写 vault 仍由 TaskRSLatteService 承担；索引与侧栏走 executionOrchestrator。
 */
export async function writeTaskTodayCreate(
  svc: TaskRSLatteService,
  ...args: Parameters<TaskRSLatteService["createTodayTask"]>
): ReturnType<TaskRSLatteService["createTodayTask"]> {
  return svc.createTodayTask(...args);
}

/** 任务更新门面：修改任务信息 */
export async function writeTaskUpdateBasicInfo(
  svc: TaskRSLatteService,
  ...args: Parameters<TaskRSLatteService["updateTaskBasicInfo"]>
): ReturnType<TaskRSLatteService["updateTaskBasicInfo"]> {
  return svc.updateTaskBasicInfo(...args);
}

/** 任务更新门面：状态流转（checkbox + meta） */
export async function writeTaskApplyStatus(
  svc: TaskRSLatteService,
  ...args: Parameters<TaskRSLatteService["applyTaskStatusAction"]>
): ReturnType<TaskRSLatteService["applyTaskStatusAction"]> {
  return svc.applyTaskStatusAction(...args);
}

/** 任务更新门面：带进度/跟进信息的状态流转 */
export async function writeTaskApplyStatusWithProgress(
  svc: TaskRSLatteService,
  ...args: Parameters<TaskRSLatteService["applyTaskStatusWithProgress"]>
): ReturnType<TaskRSLatteService["applyTaskStatusWithProgress"]> {
  return svc.applyTaskStatusWithProgress(...args);
}

/** 任务更新门面：延期 */
export async function writeTaskPostpone(
  svc: TaskRSLatteService,
  ...args: Parameters<TaskRSLatteService["postponeTask"]>
): ReturnType<TaskRSLatteService["postponeTask"]> {
  return svc.postponeTask(...args);
}

/** 任务更新门面：星标 */
export async function writeTaskSetStarred(
  svc: TaskRSLatteService,
  ...args: Parameters<TaskRSLatteService["setTaskStarred"]>
): ReturnType<TaskRSLatteService["setTaskStarred"]> {
  return svc.setTaskStarred(...args);
}
