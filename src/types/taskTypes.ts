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

export type TaskPanelSettings = {
  /** 任务数据所在目录（支持多个目录，按需遍历子目录） */
  taskFolders: string[];
  /** 文档包含 tags（求并集）：配置后要求至少命中一个 */
  includeTags: string[];
  /** 文档不包含 tags（求并集）：配置后要求全部不命中 */
  excludeTags: string[];
  /** v5：侧边栏清单折叠状态（key=分区 ID，true=collapsed）。分区 ID：todayAction/todayFollowUp/overdue/otherRisk/otherActive/closedCancelled/closedDone */
  collapsedLists?: Record<string, boolean>;

  /** 旧版自定义分类（兼容读取；新 UI 不再维护） */
  categories?: TaskCategoryDef[];

  /** v22：索引/队列/归档所在目录（vault 相对路径） */
  rslatteIndexDir?: string; // default: 00-System/.rslatte (V2)
  /** v22：是否启用与后端 rslatte-items 的同步（断连时会离线积压队列） */
  enableDbSync?: boolean; // default: true

  /** v26：flushQueue 调用 upsert-batch 的批大小（每批最多 N 条）。 */
  upsertBatchSize?: number; // default: 50

  /** v26：Reconcile 安全门：当同步队列非空时，跳过 reconcile（避免误删）。 */
  reconcileRequireQueueEmpty?: boolean; // default: true

  /**
   * v27：Reconcile 安全门：仅对“干净文件”执行 reconcile。
   * 干净文件定义：在本次扫描结果中，该文件内不存在 uidMissing（即每条任务/提醒都已具备 uid）。
   * 目的：避免“部分文件未补齐 uid/未纳入 present_uids”导致 reconcile 误删。
   */
  reconcileRequireFileClean?: boolean; // default: true
  /** v28：全量提醒清单（显示在事项提醒下方） */
  memoAllEnabled?: boolean; // default: true
  memoAllMaxItems?: number; // default: 50
  memoAllStatuses?: Array<"DONE" | "CANCELLED" | "TODO" | "IN_PROGRESS">; // default: ["TODO","IN_PROGRESS"]
  /** 提醒卡片“即将到期”阈值（天）。默认 5 */
  reminderUpcomingDays?: number;
  /** 事项提醒：近期完成/取消/失效窗口（天）。默认 30，范围 7-100 */
  recentClosedMemoWindowDays?: number;
  /** 日程：即将超期阈值（天）。默认 5 */
  scheduleUpcomingDays?: number;
  /** 日程：近期完成/取消/失效窗口（天）。默认 30，范围 7-100 */
  scheduleRecentClosedDays?: number;

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
  /** v22：新增提醒写入今日日记的 H2 分区标题（会自动转成 H2） */
  memoInsertSectionH2?: string; // default: "提醒"

  /** 任务标签：假活跃阈值（天），处理中/跟进中超过 N 天未更新进度即标为假活跃。默认 3 */
  fakeActiveThresholdDays?: number;
  /** 任务基准日期模式：local=本地日期，zone=指定时区当前日。默认 local */
  taskBaseDateMode?: "local" | "zone";
  /** 任务基准时区（仅 taskBaseDateMode=zone 时有效），如 Asia/Shanghai、UTC */
  taskBaseTimeZone?: string;

  /** 重点关注清单显示条数（重要性 Top N），范围 3–10，默认 3 */
  focusTopN?: number;
  /** 即将超期天数：due 在 [今天, 今天+N] 视为即将超期，默认 3，范围 1–30 */
  overdueWithinDays?: number;
  /** 近期闭环天数：近期取消/近期完成的窗口（今天−N ～ 今天），默认 7，范围 1–90 */
  closedTaskWindowDays?: number;

  /**
   * 任务业务分类（学习/工作/生活等），按空间在 `settingsSnapshot` 中独立存储。
   * 任务 meta 键 `task_category` 存**当时选用的名称快照**，设置中改名/删项不改历史条目。
   */
  taskBusinessCategories?: string[];
  /** 新建任务时默认选中的分类名（须为 `taskBusinessCategories` 中一项） */
  defaultTaskBusinessCategory?: string;

  /**
   * 侧栏任务卡片：勾选 id 表示收入「⋯」更多菜单（仍受状态等显隐条件约束）。
   * 稳定 id 见 `src/constants/sidePanelCardActions.ts`。
   */
  sidePanelTaskCardActionsInMore?: string[];
  /** 侧栏提醒卡片（活跃分区与全量提醒列表）同上 */
  sidePanelMemoCardActionsInMore?: string[];
  /** 侧栏「近期闭环」提醒卡片 */
  sidePanelMemoClosedCardActionsInMore?: string[];
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
