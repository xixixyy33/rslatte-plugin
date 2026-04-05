export type ContactStatus = "active" | "cancelled" | string;

export type ContactIndexItem = {
  contact_uid: string;
  display_name: string;
  /**
   * Ordering/grouping key:
   * - Chinese: best-effort pinyin initials (MVP)
   * - English: normalized upper-case
   */
  sortname?: string;
  aliases: string[];
  group_name: string;
  title: string;

  status: ContactStatus;
  cancelled_at?: string | null;

  tags?: string[];
  avatar_path?: string | null;
  file_path: string;

  created_at?: string | null;
  updated_at?: string | null;
  last_interaction_at?: string | null;

  /** archived contacts are moved to {contactsDir}/_archived/... */
  archived?: boolean;
  archived_at?: string | null;
  archive_path?: string;

  /** 用于增量判断的 key（mtime 拼接） */
  mtime_key?: string;
};

export type ContactsIndexFile = {
  version: 1;
  updatedAt: string;
  items: ContactIndexItem[];
  /** best-effort parse errors for error classification */
  parseErrorFiles?: string[];
};

// -----------------------------
// Contacts Interactions Index
// -----------------------------

/**
 * Source types that can contribute dynamic interaction entries.
 * Keep this list stable; add new values over time.
 */
export type ContactsInteractionSourceType =
  | "task"
  | "project_task"
  | "memo"
  | "schedule"
  | "diary"
  | "output"
  /** 侧栏「记互动」写入主索引的手动记录 */
  | "manual_note"
  | "other";

/**
 * Optional status for task-like sources.
 * - only present when the source parser can confidently infer status.
 */
export type ContactsInteractionStatus =
  | "todo"
  | "in_progress"
  | "done"
  | "cancelled"
  | "blocked"
  | "unknown";

/** 单条「实际互动」时刻（第六章）；存于主索引条目的 interaction_events */
export type ContactInteractionEvent = {
  /** 本地时区 ISO，精度到分钟 */
  occurred_at: string;
  event_kind?: "status_change" | "leave_waiting" | "complete" | "manual_note" | string;
  summary?: string;
};

export type ContactsInteractionEntry = {
  contact_uid: string;

  /** vault-relative path */
  source_path: string;
  source_type: ContactsInteractionSourceType;

  /** 稳定去重 id（任务 uid / 提醒 uid 等），优先于行号 */
  stable_source_id?: string;

  /** single-line snippet used for rendering */
  snippet: string;

  /** best-effort location info */
  line_no?: number;
  heading?: string;

  /** task/project_task only */
  status?: ContactsInteractionStatus;

  /** 是否关注中：任务/项目任务活跃时为 following，完成或取消后为 ended，用于联系人动态条目前展示 */
  follow_status?: "following" | "ended";

  /** 任务阶段（仅 task）：in_progress | waiting_others | waiting_until */
  task_phase?: string;

  /** 任务关联方式（仅 task）：strong=描述中[[C_xxx]]，整段活跃期为关注中；weak=meta 中 follow_contact_uids，仅跟进中/等待中为关注中 */
  follow_association_type?: "strong" | "weak";

  /** ISO string */
  updated_at: string;

  /** 实际互动时间线（可选；未写入时 UI 仍可用 updated_at） */
  interaction_events?: ContactInteractionEvent[];

  /** optional stable key for dedupe */
  key?: string;
  /** optional future-proof linkage (e.g. task uid / block id) */
  source_block_id?: string;
};

/**
 * `<contactsDir>/.contacts/<contact_uid>.json` 首片内单条来源快照（与主索引 `ContactsInteractionEntry` 对齐的关键字段 + 事件线）。
 * schema_version 2 起使用 `entries`，不再使用扁平 `events`。
 */
export type ContactsReplicaFirstShardEntry = {
  source_path: string;
  source_type: ContactsInteractionSourceType;
  stable_source_id?: string;
  line_no?: number;
  key?: string;
  source_block_id?: string;
  follow_association_type?: "strong" | "weak";
  interaction_events?: ContactInteractionEvent[];
};

export type ContactsReplicaFirstShardFile = {
  schema_version: 2;
  contact_uid: string;
  updated_at: string;
  display_last_at: string | null;
  entries: ContactsReplicaFirstShardEntry[];
};

/**
 * 溢出归档分片（`.contacts/<uid>_NNN.json`）中单条互动行：与首片条目一致的关键来源字段 + 一条 `event`。
 * schema_version 2 分片使用 `records`；旧版 v1 仅含扁平 `events`。
 */
export type ContactInteractionArchiveEventRecord = {
  source_path: string;
  source_type: ContactsInteractionSourceType | string;
  stable_source_id?: string;
  line_no?: number;
  key?: string;
  source_block_id?: string;
  follow_association_type?: "strong" | "weak";
  event: ContactInteractionEvent;
};

export type ContactsInteractionsBySourceFile = {
  /** epoch ms */
  mtime: number;
  /** stable digest for quick change detection */
  entries_digest: string;
  entries: ContactsInteractionEntry[];
};

/**
 * On-disk file: {centralIndexDir}/contacts-interactions.json
 */
export type ContactsInteractionsIndexFile = {
  schema_version: 1;
  /** ISO string */
  updated_at: string;
  by_contact_uid: Record<string, ContactsInteractionEntry[]>;
  by_source_file: Record<string, ContactsInteractionsBySourceFile>;
};

export function createEmptyContactsInteractionsIndexFile(nowIso?: string): ContactsInteractionsIndexFile {
  const ts = nowIso ?? new Date().toISOString();
  return {
    schema_version: 1,
    updated_at: ts,
    by_contact_uid: {},
    by_source_file: {},
  };
}
