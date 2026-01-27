/**
 * Work Event 类型定义（用于统计功能）
 */
export type WorkEventKind =
  | "checkin"
  | "finance"
  | "task"
  | "projecttask"
  | "memo"
  | "contact"
  | "project"
  | "milestone"
  | "output"
  | "file"
  | "sync";

export type WorkEventAction = "create" | "update" | "status" | "delete" | "archive" | "cancelled" | "done" | "start" | "recover" | "paused" | "continued";

export type WorkEventSource = "ui" | "auto" | "reconcile" | "mobile";

export interface WorkEvent {
  /** ISO string */
  ts: string;
  kind: WorkEventKind;
  action: WorkEventAction;
  /** 关联对象信息：task_uid/project_id/file_path 等 */
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
