export type TaskDateField = "due" | "start" | "scheduled" | "created" | "done" | "cancelled";

export type TaskSortOrder = "asc" | "desc";

export type TaskTimeOp = ">" | ">=" | "<" | "<=";

/** 时间范围定义：多个范围做交集（AND） */
export type TaskTimeRangeDef = {
  field: TaskDateField;
  op: TaskTimeOp;
  /** 支持 YYYY-MM-DD / 今日 / 本周 / 本月 / 本季度（以及对应英文别名） */
  value: string;
};

/** 分类定义：最多 5 个 */
export type TaskCategoryDef = {
  id: string;
  name: string;
  maxItems: number; // <=30
  sortField: TaskDateField;
  sortOrder: TaskSortOrder;
  /** 支持多个 status；默认按 checkbox 标记（" ","/","x","-"）或其语义别名（TODO/IN_PROGRESS/DONE/CANCELLED）匹配 */
  statuses: string[];
  timeRanges: TaskTimeRangeDef[];
};

/** 内置任务清单 ID */
export type BuiltinTaskListId =
  | "todayTodo"
  | "weekTodo"
  | "inProgress"
  | "overdue"
  | "todayDone"
  | "cancelled7d"
  | "allTasks";

/** 内置清单的展示/排序配置 */
export type BuiltinTaskListDef = {
  enabled: boolean;
  maxItems: number; // <=30
  sortField: TaskDateField;
  sortOrder: TaskSortOrder;
  /** 是否默认收起 */
  defaultCollapsed?: boolean; // default: false
};

export type TaskPanelSettings = {
  /** 任务数据所在目录（支持多个目录，按需遍历子目录） */
  taskFolders: string[];
  /** 文档包含 tags（求并集）：配置后要求至少命中一个 */
  includeTags: string[];
  /** 文档不包含 tags（求并集）：配置后要求全部不命中 */
  excludeTags: string[];
  /**
   * 任务清单（内置清单，不再支持自定义 timeRanges）
   * - todayTodo: 今日待完成（due=今天 且 TODO/IN_PROGRESS）
   * - weekTodo: 待本周完成（due 在本周 且 TODO/IN_PROGRESS）
   * - inProgress: 进行中任务（IN_PROGRESS 或 start<今天 的 TODO）
   * - overdue: 超期未完成（due<今天 且 TODO/IN_PROGRESS）
   * - todayDone: 今日已完成（done=今天 或 cancelled=今天）
   * - cancelled7d: 近七天取消任务（cancelled 在近 7 天内）
   */
  builtinLists?: Partial<Record<BuiltinTaskListId, BuiltinTaskListDef>>;

  /** v26：内置任务清单的显示顺序（可在设置中用 ↑↓ 调整） */
  builtinListOrder?: BuiltinTaskListId[];

  /** v5：侧边栏清单折叠状态（key=listId, true=collapsed）。由 UI 自动维护。 */
  collapsedLists?: Record<string, boolean>;

  /** 旧版自定义分类（兼容读取；新 UI 不再维护） */
  categories?: TaskCategoryDef[];

  /** v22：索引/队列/归档所在目录（vault 相对路径） */
  rslatteIndexDir?: string; // default: 95-Tasks/.rslatte
  /** v22：是否启用与后端 rslatte-items 的同步（断连时会离线积压队列） */
  enableDbSync?: boolean; // default: true

  /** v26：flushQueue 调用 upsert-batch 的批大小（每批最多 N 条）。 */
  upsertBatchSize?: number; // default: 50

  /** v26：Reconcile 安全门：当同步队列非空时，跳过 reconcile（避免误删）。 */
  reconcileRequireQueueEmpty?: boolean; // default: true

  /**
   * v27：Reconcile 安全门：仅对“干净文件”执行 reconcile。
   * 干净文件定义：在本次扫描结果中，该文件内不存在 uidMissing（即每条任务/备忘都已具备 uid）。
   * 目的：避免“部分文件未补齐 uid/未纳入 present_uids”导致 reconcile 误删。
   */
  reconcileRequireFileClean?: boolean; // default: true
  /** v22：重要事项（备忘录）默认展示范围：今天 + N 天 */
  memoLookaheadDays?: number; // default: 7
  /** v22：是否在 RSLatte（Side Panel 1）“今日日志”下方展示重要事项 */
  showImportantMemosInRSLattePanel?: boolean; // default: true

  /** v28：全量备忘清单（显示在事项提醒下方） */
  memoAllEnabled?: boolean; // default: true
  memoAllMaxItems?: number; // default: 50
  memoAllStatuses?: Array<"DONE" | "CANCELLED" | "TODO" | "IN_PROGRESS">; // default: ["TODO","IN_PROGRESS"]

  /** v22：是否启用自动归档（每天打开知识库触发一次） */
  autoArchiveEnabled?: boolean; // default: true
  /** v22：归档阈值（天）。DONE 用 ✅ 日期，CANCELLED 用 ❌ 日期；早于“今天-阈值”的闭环任务会从主索引搬迁到 archive/*.json */
  archiveThresholdDays?: number; // default: 90
  /** v22（兼容旧配置）：归档保留窗口（月）。已废弃；仅当 archiveThresholdDays 未配置时才会使用 */
  archiveKeepMonths?: number; // default: 3
  /** v22：上次自动归档执行日期（YYYY-MM-DD），用于“每日只执行一次” */
  archiveLastRunKey?: string;

  /** v22：新增任务写入今日日记的 H2 分区标题（会自动转成 H2） */
  taskInsertSectionH2?: string; // default: "任务"
  /** v22：新增备忘写入今日日记的 H2 分区标题（会自动转成 H2） */
  memoInsertSectionH2?: string; // default: "重要事项"
};

export type ParsedTaskItem = {
  filePath: string;
  line: number; // 0-based
  rawLine: string;
  text: string;

  statusMark: string;  // e.g. " ", "x", "/", "-"
  statusName: "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED" | "UNKNOWN";

  due?: string;       // YYYY-MM-DD
  start?: string;     // YYYY-MM-DD
  scheduled?: string; // YYYY-MM-DD
  created?: string;   // YYYY-MM-DD
  done?: string;      // YYYY-MM-DD
  cancelled?: string; // YYYY-MM-DD
};
