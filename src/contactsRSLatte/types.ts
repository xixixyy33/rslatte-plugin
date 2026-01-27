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
  | "diary"
  | "output"
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

export type ContactsInteractionEntry = {
  contact_uid: string;

  /** vault-relative path */
  source_path: string;
  source_type: ContactsInteractionSourceType;

  /** single-line snippet used for rendering */
  snippet: string;

  /** best-effort location info */
  line_no?: number;
  heading?: string;

  /** task/project_task only */
  status?: ContactsInteractionStatus;

  /** ISO string */
  updated_at: string;

  /** optional stable key for dedupe */
  key?: string;
  /** optional future-proof linkage (e.g. task uid / block id) */
  source_block_id?: string;
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
