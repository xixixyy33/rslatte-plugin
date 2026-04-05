/** 索引/合并维度：日程独立 schedule-index；解析层日程行仍为 itemType=memo + isScheduleMemoLine */
export type RSLatteItemType = "task" | "memo" | "schedule";

export type RSLatteStatus = "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED" | "UNKNOWN";

/**
 * 从 Markdown 行解析出来的“任务/提醒”结构
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

  // ===== task fields（第六节 6.6 表 snake_case）=====
  /** 创建日，任务行 ➕ */
  created_date?: string;
  /** 计划结束日，任务行 📅 */
  planned_end?: string;
  /** 实际开始日，任务行 🛫 */
  actual_start?: string;
  /** 计划开始日，任务行 ⏳ */
  planned_start?: string;
  /** 实际完成日，任务行 ✅ */
  done_date?: string;
  /** 实际取消日，任务行 ❌ */
  cancelled_date?: string;

  // ===== task phase & progress（下一行 meta，键名保持）=====
  /** 任务展示阶段（含闭环）：todo | in_progress | waiting_others | waiting_until | done | cancelled（解析时与 checkbox 对齐） */
  task_phase?: string;
  /** 任务进度信息 */
  progress_note?: string;
  /** 任务进度最后更新时间 ISO */
  progress_updated?: string;
  /** 等待到期日期 YYYY-MM-DD（task_phase=waiting_until 时） */
  wait_until?: string;
  /** 下一次跟进时间 YYYY-MM-DD（task_phase=waiting_others 时） */
  follow_up?: string;
  /** 关联联系人 UID 列表（来自 meta follow_contact_uids） */
  follow_contact_uids?: string[];
  /** 关联联系人姓名列表（来自 meta follow_contact_name，与 follow_contact_uids 按顺序对应） */
  follow_contact_names?: string[];
  /** 历史已延期次数 */
  postpone_count?: number;
  /** 首次延期前计划结束日（meta original_due） */
  original_due?: string;
  /** 是否星标 */
  starred?: boolean;
  /** 工时评估（小时） */
  estimate_h?: number;
  /** 任务复杂度 high | normal | light */
  complexity?: string;
  /** 任务标签（由索引更新时计算写入，不解析自 md） */
  task_tags?: string[];
  /** 提醒衍生展示标签（memo-index 合并写入，非日程行） */
  memo_tags?: string[];
  /** 日程衍生展示标签（schedule-index 写入） */
  schedule_tags?: string[];
  /** 任务重要性得分（索引更新时计算并写入 index + meta） */
  importance_score?: number;
  /** 是否为风险类（已超期/已延期/高拖延风险/假活跃之一） */
  importance_is_risk?: boolean;
  /** 是否为「今天明确要处理」（今天到期/今天等待/今天应跟进） */
  importance_is_today_action?: boolean;

  // ===== memo fields =====
  memoDate?: string;          // YYYY-MM-DD
  memoMmdd?: string;          // MM-DD
  repeatRule?: string;        // e.g. none/weekly/monthly/quarterly/yearly（历史 seasonly 解析为 quarterly）
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
  /**
   * 衍生 tags 计算时所依据的日历日 YYYY-MM-DD（**[X-Pipeline]** 与「今日」侧栏一致性契约）。
   * - **任务**：与 `getTaskTodayKey(taskPanel)` 一致；`getTaskListsForSidePanel` 在 **`tagsDerivedForYmd === today`** 时直读 **`task_tags`**，否则现算。
   * - **提醒**：与 `queryReminderBuckets` / `writeMemoIndexWithDerivedTags` 所用日历日一致；侧栏芯片同规则直读 **`memo_tags`**。
   * - **日程**：与 `queryScheduleBuckets` / `applyScheduleIndexDerivedFields` 所用日一致；直读 **`schedule_tags`** 条件同上。
   * 详见 `docs/V2改造方案/索引优化方案.md` §7.2、`docs/CODE_MAP.md` §3.1 / §3.2 / §3.2-1。
   */
  tagsDerivedForYmd?: string;
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

/**
 * 日程条目（独立 schedule-index）不得合并进 memo-index。
 * 以 meta `type=schedule` 为准（解析器会写入 extra.type）；兼容旧数据 extra.cat=schedule、行内注释、或 schedule_date+start_time 形态。
 */
export function isScheduleMemoLine(p: Partial<RSLatteParsedLine> | null | undefined): boolean {
  if (String((p as any)?.itemType ?? "").trim().toLowerCase() === "schedule") return true;
  const extra = ((p as any)?.extra ?? {}) as Record<string, string>;
  if (String(extra.cat ?? "").trim().toLowerCase() === "schedule") return true;
  if (String(extra.type ?? "").trim().toLowerCase() === "schedule") return true;
  const rc = String((p as any)?.rslatteComment ?? "").trim().toLowerCase();
  if (rc.includes("cat=schedule")) return true;
  if (rc.includes("type=schedule")) return true;
  const sd = String(extra.schedule_date ?? "").trim();
  const st = String(extra.start_time ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(sd) && /^\d{1,2}:\d{2}$/.test(st)) return true;
  return false;
}
