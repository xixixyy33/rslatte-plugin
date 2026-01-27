export type RSLatteItemType = "task" | "memo";

export type RSLatteStatus = "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED" | "UNKNOWN";

/**
 * 从 Markdown 行解析出来的“任务/备忘”结构
 * - lineNo 为 0-based
 */
export type RSLatteParsedLine = {
  itemType: RSLatteItemType;

  /** v2: stable business key (preferred over lineNo). */
  uid?: string;

  /** v2: when uid comes from a dedicated meta comment line, its line number (0-based). */
  metaLineNo?: number;

  /** v2: uid missing marker (auto refresh won't fix, manual refresh can fix). */
  uidMissing?: boolean;

  filePath: string;
  lineNo: number;

  raw: string;
  text: string;
  status: RSLatteStatus;

  // ===== task fields =====
  createdDate?: string;     // YYYY-MM-DD
  dueDate?: string;         // YYYY-MM-DD
  startDate?: string;       // YYYY-MM-DD
  scheduledDate?: string;   // YYYY-MM-DD
  doneDate?: string;        // YYYY-MM-DD
  cancelledDate?: string;   // YYYY-MM-DD

  // ===== memo fields =====
  memoDate?: string;          // YYYY-MM-DD
  memoMmdd?: string;          // MM-DD
  repeatRule?: string;        // e.g. none/weekly/monthly/seasonly/yearly
  lastNotifiedDate?: string;  // YYYY-MM-DD

  // ===== ids (write-back) =====
  tid?: number; // task_id
  mid?: number; // memo_id

  /** stable-ish hash used by backend for de-dup / change detection */
  sourceHash: string;

  /** 原始 html 注释内容（不含 <!-- -->） */
  rslatteComment?: string;

  /** 扩展字段（用于 memo 的 repeat 等） */
  extra?: Record<string, any>;
};

export type RSLatteIndexItem = RSLatteParsedLine & {
  /** 数据库主键（task_id / memo_id） */
  itemId?: number;

  /** 上次成功同步到后端时的 sourceHash（用于判断是否需要 update） */
  lastPushedHash?: string;

  /** 上次成功同步到后端的时间（ISO） */
  lastPushedAt?: string;

  // ===== DB sync tracking (for manual refresh / rebuild) =====
  /** 当前 DB 同步状态：ok/failed/pending */
  dbSyncState?: "ok" | "failed" | "pending";

  /** 上次尝试同步到 DB 的时间（ISO） */
  dbLastAttemptAt?: string;

  /** 上次成功同步到 DB 的时间（ISO） */
  dbLastOkAt?: string;

  /** 上次同步失败原因（短文本） */
  dbLastError?: string;

  /** 上次同步动作：create/update/delete */
  /** backend sync action (v1: create/update/delete; v2: upsert) */
  dbLastAction?: "create" | "update" | "delete" | "upsert";

  /** 上次同步对应的 op_id（用于排查） */
  dbLastOpId?: string;

  /** 失败重试次数（仅用于展示/排查） */
  dbSyncTries?: number;

  /** 上次扫描到该项的时间（ISO） */
  seenAt: string;

  /** 索引记录是否已归档 */
  archived?: boolean;
};

export type RSLatteIndexFile = {
  version: 1;
  updatedAt: string; // ISO
  items: RSLatteIndexItem[];
};

export type SyncQueueOp = {
  opId: string;
  action: "upsert" | "create" | "update" | "delete";
  itemType: RSLatteItemType;
  filePath: string;
  lineNo: number;
  itemId?: number;
  payload: any; // backend RSLatteItemIn-like
  tries: number;
  nextRetryAt: number; // ms epoch
  lastError?: string;
};

export type SyncQueueFile = {
  version: 1;
  updatedAt: string;
  ops: SyncQueueOp[];
};

/**
 * File-level scan cache to avoid re-reading/parsing unchanged markdown files.
 *
 * We only cache file fingerprints + whether a file passed tag filters.
 * For unchanged & included files, we reuse items from the previous index.
 */
export type RSLatteScanCacheFile = {
  version: 1;
  updatedAt: string; // ISO
  /**
   * Changes when relevant settings change (folders / includeTags / excludeTags).
   * When mismatch, the cache should be treated as empty.
   */
  filterKey: string;
  /**
   * Per-file fingerprint.
   * - included=false means the file was excluded by tag filters last time.
   */
  files: Record<
    string,
    {
      mtime: number;
      size: number;
      /** optional content hash (computed only when we read content) */
      hash?: string;
      included: boolean;
    }
  >;
};
