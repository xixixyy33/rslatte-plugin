/**
 * Work Event 类型定义（用于统计功能）
 */
export type WorkEventKind =
  | "checkin"
  | "finance"
  | "health"
  | "task"
  | "projecttask"
  | "memo"
  | "schedule"
  | "contact"
  | "project"
  | "milestone"
  | "output"
  | "file"
  | "sync"
  | "capture";

export type WorkEventAction =
  | "create"
  | "update"
  | "publish"
  | "recall"
  | "status"
  | "delete"
  | "archive"
  | "cancelled"
  | "done"
  | "start"
  | "recover"
  | "paused"
  | "continued";

export type WorkEventSource = "ui" | "auto" | "reconcile";

/** 读 JSONL / 历史数据时：未知或已下线的来源（如 mobile）归一为 ui */
export function normalizeWorkEventSource(raw: string | undefined | null): WorkEventSource {
  const s = String(raw ?? "").trim();
  if (s === "auto" || s === "reconcile") return s;
  return "ui";
}

export interface WorkEvent {
  /** 事件发生时刻：推荐带本机（或业务时区）偏移的 ISO 8601，如 `2026-03-30T03:51:50.727+08:00`（勿依赖 UTC `Z` 与本地日历对齐） */
  ts: string;
  kind: WorkEventKind;
  action: WorkEventAction;
  /**
   * 关联对象信息：task_uid/project_id/file_path 等。
   * 任务/项目任务状态类事件可带：`task_phase_before` / `task_phase_after`（与 `reconcileTaskDisplayPhase` 一致：todo | in_progress | waiting_others | waiting_until | done | cancelled）。
   * 项目任务：`ref.is_next_action_for_l1` 表示**事件发生当时**该任务是否为一级里程碑轨上的「下一步」（今日核对「项目推进变化」用）；须在 `refreshDirty` 前从快照读取，新建单条任务在刷新后解析。
   */
  ref?: Record<string, any>;
  /** 单行摘要（时间轴直接展示） */
  summary?: string;
  /** 可选数值：amount/delta/count 等 */
  metrics?: Record<string, any>;
  /** 事件来源：ui/auto/reconcile */
  source?: WorkEventSource;
  /** 可选：唯一 id（后续若要去重/追踪可用） */
  event_id?: string;
  /** 空间 ID（从文件路径推断） */
  spaceId?: string;
}
