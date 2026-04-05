/**
 * 单次用户操作配方 ID（与方案「编排层」recipe 名一致，便于 grep / Code Review）。
 */
export const EXECUTION_RECIPE = {
  /** 三合一 / 侧栏 / Capture：新建任务后的索引、联系人互动、侧栏 */
  tripleSaveTask: "execution.tripleSave.task",
  /** 新建提醒后的索引与侧栏 */
  tripleSaveMemo: "execution.tripleSave.memo",
  /** 新建日程后的 schedule 模块 E2 刷新与侧栏 */
  tripleSaveSchedule: "execution.tripleSave.schedule",
  /** 更新类按钮：仅由编排写 WorkEvent（索引刷新仍走现有调用方链路） */
  workEventOnly: "execution.workEvent.only",
  /** 更新类：任务编辑/进展后（task+memo 索引刷新） */
  updateTaskAndRefresh: "execution.update.task.refresh",
  /** 更新类：提醒编辑后（task+memo 索引刷新） */
  updateMemoAndRefresh: "execution.update.memo.refresh",
  /** 更新类：日程编辑后（schedule 模块手动刷新） */
  updateScheduleAndRefresh: "execution.update.schedule.refresh",
  /** 侧栏内部：仅 task 模块手动刷新 */
  panelRefreshTaskOnly: "execution.panel.refresh.task",
  /** 侧栏内部：仅 memo 模块手动刷新 */
  panelRefreshMemoOnly: "execution.panel.refresh.memo",
  /** 侧栏内部：仅 schedule 模块手动刷新 */
  panelRefreshScheduleOnly: "execution.panel.refresh.schedule",
} as const;

export type ExecutionRecipeId = (typeof EXECUTION_RECIPE)[keyof typeof EXECUTION_RECIPE];
