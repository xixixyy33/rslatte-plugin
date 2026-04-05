// Canonical project status synced to DB.
export type ProjectRSLatteItemStatus = "todo" | "in-progress" | "done" | "cancelled" | string;

export type ProjectRSLatteMilestone = {
  name: string;
  /** 多级里程碑全路径，与任务 `milestone` 一致；一级可与 `name` 相同 */
  path?: string;
  done: number;
  todo: number;
  inprogress: number;
  total: number;
};

export type ProjectRSLatteIndexItem = {
  project_id: string;
  project_name: string;
  status: ProjectRSLatteItemStatus;

  create_date?: string;    // YYYY-MM-DD
  due_date?: string;       // YYYY-MM-DD
  start_date?: string;     // YYYY-MM-DD
  done_date?: string;      // YYYY-MM-DD
  cancelled_date?: string; // YYYY-MM-DD
  /** 待归档标记日（YYYY-MM-DD），与 frontmatter pending_archive_at 一致 */
  pending_archive_date?: string;

  folder_path: string;
  info_file_path: string;
  tasklist_file_path: string;
  analysis_file_path?: string;

  milestones?: ProjectRSLatteMilestone[];

  /** 快照衍生：risk_*、project_overdue、project_postponed、project_soon_overdue、stale_progress 等 */
  project_tags?: string[];
  /** 快照衍生：项目状态中文（如 进行中） */
  project_status_display_zh?: string;

  /** 用于增量判断的 key（mtime 拼接） */
  mtime_key?: string;
  updated_at?: string; // ISO

  // ===== DB sync meta (stored in central index) =====
  /** ok | pending | error | off */
  db_sync_status?: "ok" | "pending" | "error" | "off" | string;
  /** last successful sync time (ISO) */
  db_synced_at?: string;
  /** last error message (short) */
  db_last_error?: string;
  /** pending ops count for this project (best-effort) */
  db_pending_ops?: number;
};

export type ProjectRSLatteIndexFile = {
  version: 1;
  updatedAt: string;
  items: ProjectRSLatteIndexItem[];
};

export type ProjectRSLatteArchiveMap = {
  version: 1;
  updatedAt: string;
  /** project_id -> monthKey (YYYY-MM) */
  map: Record<string, string>;
};

export type ProjectSyncOp =
  | {
      op_id: string;
      kind: "upsert_project";
      project_id: string;
      payload: any;
      enqueued_at: string;
      /** mtime/snapshot key used to decide whether this op is stale */
      snapshot_key?: string;
      try_count?: number;
      next_retry_at?: number; // ms
      last_error?: string;
      last_try_at?: string;
    }
  | {
      op_id: string;
      kind: "replace_items" | "upsert_items";
      project_id: string;
      payload: any;
      enqueued_at: string;
      snapshot_key?: string;
      try_count?: number;
      next_retry_at?: number; // ms
      last_error?: string;
      last_try_at?: string;
    };

export type ProjectSyncQueueFile = {
  version: 1;
  updatedAt: string;
  ops: ProjectSyncOp[];
};

export type ProjectArchiveResult = {
  archivedCount: number;
  byMonth: Record<string, number>;
  cutoffDate: string;
};
