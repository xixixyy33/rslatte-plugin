import type { CheckinItemDef, FinanceCatDef, FinanceCyclePlanRow, DailyState, JournalPanel } from "./rslatteTypes";
import type { TaskPanelSettings } from "./taskTypes";
import type { KnowledgePanelSettings } from "./knowledgeTypes";
import type { OutputPanelSettings } from "./outputTypes";
import type { RSLatteSpaceConfig } from "./space";

export type JournalAppendModule =
  | "checkin"
  | "finance"
  | "health"
  | "task"
  | "memo"
  | "schedule"
  | "project"
  | "output";

// ===== UI：侧边栏标题栏按钮显隐（仅控制 🧱🗄🔄；➕ 始终展示） =====
export type UiModuleKey =
  | "checkin"
  | "finance"
  | "health"
  | "memo"
  | "schedule"
  | "task"
  | "project"
  | "output"
  | "contacts";
export type UiHeaderButtonKey = "rebuild" | "archive" | "refresh";
export type UiHeaderButtonVisibility = Record<UiHeaderButtonKey, boolean>;
export type UiHeaderButtonsConfig = Record<UiModuleKey, UiHeaderButtonVisibility>;

// ===== UI：打卡项显示形式 =====
export type CheckinDisplayStyle = "buttons" | "checklist";


export type ProjectArchiveTemplateDef = {
  /** Stable id used in settings UI */
  id: string;

  /** Dropdown label shown in project side panel */
  name: string;

  /** Template file path in vault (optional). If no extension is provided, .md will be tried */
  templatePath: string;

  /** Target relative directory under the project folder, e.g. "pro_files" or "pro_files/docs" */
  targetRelPath: string;

  /** Open the created file after creation */
  openAfterCreate?: boolean;

  /** 常用（收藏）。用于在“创建项目存档文件”下拉中置顶 */
  favorite?: boolean;

  /** 来自 outputPanel.templates 合并时：写入新建文档 frontmatter */
  tags?: string[];
  type?: string;
  docCategory?: string;
};

/** 日志追加清单：按模块控制写入位置 */
export type JournalAppendRule = {
  module: JournalAppendModule;
  /** 是否启用该模块的日志追加（打卡/财务/任务/提醒/日程强制启用） */
  enabled: boolean;
  /** 记录追加一级目录（H1） */
  h1: string;
  /** 数据存放二级目录（H2） */
  h2: string;
};

/** 插件设置结构 */
export interface RSLattePluginSettings {
  refreshInterval: number;
  apiBaseUrl: string;

  /** 后端账号鉴权：登录成功后保存的 JWT（明文存于 data.json，请勿分享库文件） */
  apiAuthAccessToken?: string;
  /** 上次成功登录的账号名（仅展示/回填，非密钥） */
  apiBackendUserName?: string;
  /**
   * 用于 JWT 静默续期：与账号名一并由「登录并保存」写入，**明文存于 data.json**。
   * 清除登录或更换 API Base URL 时会清空。未写入时过期后需再登录一次以启用自动续期。
   */
  apiBackendPassword?: string;

  /** ✅ 当前空间 UUID（与后端一致）。default = 全 0 UUID */
  currentSpaceId: string;

  /** ✅ 空间配置表：key=space UUID（Step F0：仅承载元信息；后续逐步下沉模块配置） */
  spaces: Record<string, RSLatteSpaceConfig>;

  /**
   * ✅ DB Sync 开关从 OFF→ON 时的一次性“全量入库”标记。
   * - 由设置页 toggle 写入
   * - 由各模块 atomic spec 在一次 buildOps/flush 成功后清除
   */
  dbSyncForceFullNext?: {
    task?: boolean;
    memo?: boolean;
    schedule?: boolean;
    checkin?: boolean;
    finance?: boolean;
    health?: boolean;
    project?: boolean;
    output?: boolean;
    knowledge?: boolean;
    // contacts: C1 仅占位（未接入 pipeline），不参与 forceFull
  };

  /** ✅ 统一的中央索引目录（四个模块共用：打卡/任务/项目/输出） */
  centralIndexDir?: string; // default: 00-System/.rslatte (V2)

  /** V2 知识库目录：启用后可使用 00-System/10-Personal/20-Work/30-Knowledge/90-Archive；新内容可选用对应路径 */
  useV2DirectoryStructure?: boolean;
  /** V2 目录根路径（相对 vault；为空则用 vault 根）。仅当 useV2DirectoryStructure 为 true 时生效 */
  v2DirectoryRoot?: string;

  /** ✅ Work Event Stream：统计用“工作事件流”（JSONL） */
  workEventEnabled?: boolean; // default: true
  /** Work Event Stream 相对路径（相对 centralIndexDir）。默认：.events/work-events.jsonl */
  workEventRelPath?: string;
  /** 为 true 时：WorkEvent JSONL 与后端 `rslatte_work_event` 双写；随自动刷新 tick 批量 upsert */
  workEventDbSyncEnabled?: boolean;

  /**
   * 用户在「插件初始化环境检查」中确认完成，且当前强制项均已满足时，业务模块才按 moduleEnabledV2 生效。
   * 新库首次安装默认为 false；升级且无此键时由 main 迁移为 true。
   */
  pluginEnvInitGateCompleted?: boolean;
  /** 无法读取 vault.getConfig 时，用户已在检查工具中确认已核对 Obsidian「文件与链接」 */
  envObsidianFilesLinksManualAck?: boolean;

  /** 模块启用开关：关闭后侧边栏与该模块索引生成机制都停用 */
  moduleEnabled?: { record: boolean; task: boolean; project: boolean; output: boolean };



  /** v6-2：模块启用开关（拆分版，逐步启用） */
  moduleEnabledV2?: {
    /** 日志管理（仅影响设置/显示，非索引模块） */
    journal?: boolean;
    checkin?: boolean;
    finance?: boolean;
    task?: boolean;
    memo?: boolean;
    /** 日程管理 */
    schedule?: boolean;
    project?: boolean;
    output?: boolean;
    /** 联系人管理（C1：模块骨架） */
    contacts?: boolean;
    /** 发布管理 */
    publish?: boolean;
    /** 健康管理（侧栏 + 今日记录 + 索引 / pipeline） */
    health?: boolean;
  };

  /** v6-2：打卡模块同步/归档参数（逐步启用） */
  checkinPanel?: {
    enableDbSync?: boolean;
    autoArchiveEnabled?: boolean;
    archiveThresholdDays?: number;
  };

  /** v6-2：财务模块同步/归档参数（逐步启用） */
  financePanel?: {
    enableDbSync?: boolean;
    autoArchiveEnabled?: boolean;
    archiveThresholdDays?: number;
  };

  /** 健康模块参数（索引 / 归档 / DB 同步开关；后端入库 API 未接入时 flush 为占位） */
  healthPanel?: {
    enableDbSync?: boolean;
    autoArchiveEnabled?: boolean;
    archiveThresholdDays?: number;
    archiveLastRunKey?: string;
    /** 饮水目标杯数（用于今日记录完成度分母等） */
    waterGoalCups?: number;
    /** 日卡片「点杯」换算：每杯水量 ml（默认 500） */
    waterCupVolumeMl?: number;
    /** 目标体重 kg（默认 55）；体重趋势图虚线参考 */
    targetWeightKg?: number;
    /** 目标腰围 cm（默认 75）；腰围趋势图虚线参考 */
    targetWaistCm?: number;
    /**
     * 合并后 9 项是否参与维护/展示；缺省或未列出的键视为 true。
     * 日维（体重/饮水/睡眠/饮食）至少须保留一项，由设置页校验。
     */
    healthMetricsEnabled?: Partial<Record<string, boolean>>;
    /**
     * 健康分析月快照（*.stats.json）中按块生成；缺省或未列出的 id 视为 true。
     * id 见 `healthAnalysisGenerationCatalog.HEALTH_STATS_METRIC_CATALOG`。
     */
    healthStatsMetricsEnabled?: Partial<Record<string, boolean>>;
    /**
     * 健康规则告警（*.alerts.json）与 alert-index 基础项；缺省或未列出的 id 视为 true。
     * id 为 ruleId 或基础诊断 code，见 `HEALTH_RULE_ALERT_CATALOG`。
     */
    healthRuleAlertsEnabled?: Partial<Record<string, boolean>>;
  };

  /** v6-4：任务模块同步/归档参数（逐步启用） */
  taskModule?: {
    enableDbSync?: boolean;
    autoArchiveEnabled?: boolean;
    archiveThresholdDays?: number;
    /** v6-5：任务模块上次自动归档执行日期（YYYY-MM-DD），用于“每日只执行一次” */
    archiveLastRunKey?: string;
    /** v6-5：任务模块增量刷新水位（ms）——预留，v6-5.x 逐步启用 */
    lastDiaryScanMs?: number;
  };

  /** v6-4：提醒模块同步/归档参数（逐步启用） */
  memoModule?: {
    enableDbSync?: boolean;
    autoArchiveEnabled?: boolean;
    archiveThresholdDays?: number;
    /** v6-5：提醒模块上次自动归档执行日期（YYYY-MM-DD），用于“每日只执行一次” */
    archiveLastRunKey?: string;
    /** v6-5：提醒模块增量刷新水位（ms）——预留，v6-5.x 逐步启用 */
    lastDiaryScanMs?: number;
  };

  /** 日程模块归档与 DB 同步（pipeline schedule 轨） */
  scheduleModule?: {
    enableDbSync?: boolean;
    autoArchiveEnabled?: boolean;
    archiveThresholdDays?: number;
    archiveLastRunKey?: string;
    lastDiaryScanMs?: number;
    /** 日程分类：内部 id + 展示名；按空间在 settingsSnapshot 中独立存储 */
    scheduleCategoryDefs?: Array<{ id: string; label: string }>;
    /** 新建日程默认分类 id（须为 scheduleCategoryDefs 中一项） */
    defaultScheduleCategoryId?: string;
    /** 侧栏日程卡片（活跃）：勾选 id 收入「⋯」，见 `sidePanelCardActions.ts` */
    sidePanelScheduleCardActionsInMore?: string[];
    /** 侧栏近期闭环日程卡片 */
    sidePanelScheduleClosedCardActionsInMore?: string[];
  };

  /** vC1：联系人模块同步/归档/目录参数（占位，后续逐步启用） */
  contactsModule?: {
    enableDbSync?: boolean;
    autoArchiveEnabled?: boolean;
    archiveThresholdDays?: number;

    /** 联系人目录根路径（group = 子目录） */
    contactsDir?: string;
    /** @deprecated 模板路径（已废弃，联系人文件改为代码生成） */
    templatePath?: string;
    /** 分组目录黑名单（默认：templates、_archived） */
    groupDirBlacklist?: string[];

    /** 归档目录根路径（默认：{contactsDir}/_archived） */
    archiveDir?: string;
    /** 联系人模块上次自动归档执行日期（YYYY-MM-DD），用于“每日只执行一次” */
    archiveLastRunKey?: string;

    /** Step 1：互动写入章节（手动/动态共用，默认：## 互动记录） */
    eventSectionHeader?: string;

    /** Step 1：手动互动子标题（默认：### 手动互动；留空则直接写在章节下） */
    manualEventSubHeader?: string;

    /** Step 6：动态互动子标题（默认：### 动态互动；留空则直接写在章节下） */
    dynamicEventSubHeader?: string;

    /** @deprecated 旧键：手动互动写入目标章节（默认：## 互动记录） */
    manualEventSectionHeader?: string;

    /** 超期未联系天数（自然日），默认 30 */
    contactFollowupOverdueDays?: number;
    /** 主索引每联系人互动事件全局上限 */
    interactionEventsMaxPerContactInIndex?: number;
    /** 主索引每联系人、每 source 上限 */
    interactionEventsMaxPerSourcePerContact?: number;
    /** §6.9：溢出写入 `.contacts/<uid>_NNN.json` 时单分片最大字节 */
    contactInteractionArchiveShardMaxBytes?: number;
    /** 动态条目 title/meta 间展示最近几条互动时间 */
    interactionTimelinePreviewCount?: number;
    /** 「联系人详细信息」页签不展示的 frontmatter 键 */
    contactDetailsFieldBlacklist?: string[];

    /** 互动统计：当前统计日（任务基准时区 YYYY-MM-DD） */
    contactsInteractionStatsDateKey?: string;
    /** 当日每条目手动保存的额外计数（uid -> count） */
    contactsInteractionManualNewTodayByUid?: Record<string, number>;
    /** 首次启用联系人互动统计的 ISO 时间（用于不产生历史 NEW 堆积） */
    contactsInteractionFirstEnabledAt?: string;
  };
  /** 自动刷新索引开关（定时增量更新） */
  autoRefreshIndexEnabled?: boolean; // default: true
  /** 自动刷新频率（分钟） */
  autoRefreshIndexIntervalMin?: number; // default: 30

  /** 当前 vault 的唯一 ID（只生成一次/可重置） */
  vaultId: string;

  checkinItems: CheckinItemDef[];
  /** 打卡项显示形式：buttons（按钮+热力图）/ checklist（清单+勾选框+近30天次数） */
  checkinDisplayStyle?: CheckinDisplayStyle;
  financeCategories: FinanceCatDef[];
  /**
   * 财务周期表（catId+子分类+机构+周期类型 匹配 meta.cycle_id）
   * @see docs/V2改造方案/记录类管理优化方案.md
   */
  financeCyclePlans?: FinanceCyclePlanRow[];
  /** 当前库财务管理默认币种（展示/后续多币种扩展） */
  financeManagementCurrency?: string;
  /** 机构名相似度告警：已忽略的输入归一化串，不再提示 */
  financeInstitutionSimilarIgnore?: string[];

  /** UI “done/todo” 状态缓存，不作为事实来源 */
  dailyState: Record<string, DailyState>;

  /** 旧：今日日志跳转（仍保留以兼容已有逻辑） */
  todayNotePathTemplate: string;
  todayNoteDateFormat: string;
  todayJumpHeadings: { label: string; heading: string }[];
  todayInsertBeforeHeading: string;
  journalPanels: JournalPanel[];

  /** Review 周报 *.md 内按「标题行」统计字数的子窗口（与 journalPanels 独立） */
  weeklyJournalPanels?: JournalPanel[];
  /** Review 月报 *.md 内子窗口（独立） */
  monthlyJournalPanels?: JournalPanel[];
  /** Review 季报 *.md 内子窗口（独立） */
  quarterlyJournalPanels?: JournalPanel[];

  /** 是否在侧边栏展示“今日日志/日志子窗口” */
  showJournalPanels?: boolean;

  /** 日志子窗口父目录（一级标题），默认为"碎碎念" */
  journalPanelParentHeading?: string;

  /** 日志追加清单（按模块） */
  journalAppendRules?: JournalAppendRule[];


  /** 调试日志：开启后会把关键事件打印到 Console */
  debugLogEnabled: boolean;

  financeLogHeading: string;
  financeLogLinePrefix: string;

  checkinLogHeading: string;
  checkinLogLinePrefix: string;

  /** @deprecated 旧开关：是否写入日记（已迁移到 journalAppendRules）。保留以兼容历史配置。 */
  enableJournalAppend: boolean;
  /** @deprecated 旧：记录追加目录锚点（已迁移）。保留以兼容历史配置。 */
  appendAnchorHeading: string;

  /**
   * 新：日记模板信息（后续用于“日记不存在时创建”）
   * 注意：当前 refactor 仅保留字段，不改变既有行为。
   */
  diaryTemplate: string;        // 日记模板（用于日记不存在时创建）
  diaryPath: string;            // 日记路径
  diaryNameFormat: string;      // 日记名称格式（比如：YYYYMMDD）

  /** 日记月归档：目录名（moment 格式，如 YYYYMM；也可包含子目录，如 YYYY/MM） */
  diaryArchiveMonthDirName: string;
  /** 日记月归档：阈值（天）。早于 today-threshold 的日记会被移动到月归档目录。<=0 表示不启用 */
  diaryArchiveThresholdDays: number;
  /** 日记月归档：上次自动归档执行日期（YYYY-MM-DD），用于避免重复跑 */
  diaryArchiveLastRunKey?: string;

  /** 在 Review「记录」页展示周期周报入口（路径 `{diaryPath 上一级}/weekly/YYYY-Www.md`，与日记根目录同级） */
  reviewRecordsWeeklyEnabled?: boolean;
  /** 在 Review「记录」页展示周期月报入口（路径 `{diaryPath 上一级}/monthly/YYYY-MM.md`） */
  reviewRecordsMonthlyEnabled?: boolean;
  /** 在 Review「记录」页展示周期季报入口（路径 `{diaryPath 上一级}/quarterly/YYYY-Qn.md`） */
  /** 为 true 时任意粒度下记录页 bundle 均含季报；为 false 时仅 grain=quarter 时仍构建季报（供「周期季报」分区） */
  reviewRecordsQuarterlyEnabled?: boolean;
  /** 周报模板（相对 vault；不存在则创建空笔记） */
  weeklyReportTemplatePath?: string;
  /** 月报模板（相对 vault） */
  monthlyReportTemplatePath?: string;
  /** 季报模板（相对 vault；默认 t_quarterly） */
  quarterlyReportTemplatePath?: string;
  /** Review「记录」在周视图下是否显示「周期周报」分区（默认 true） */
  reviewPeriodReportShowWeekly?: boolean;
  /** Review「记录」在月视图下是否显示「周期月报」分区（默认 true） */
  reviewPeriodReportShowMonthly?: boolean;
  /** Review「记录」在季视图下是否显示「周期季报」分区（默认 true） */
  reviewPeriodReportShowQuarterly?: boolean;

  /** V2 快速记录（Capture）：待整理写入路径与文件名格式，按空间配置 */
  captureModule?: {
    /** 待整理条目写入目录（相对 vault），默认 10-Personal/17-Inbox */
    captureInboxDir: string;
    /** 待整理文件名格式（moment 格式），默认 YYYYMMDD，如 20260317 */
    captureInboxFileNameFormat: string;
    /** 待整理文件全部处理完成后归档到此目录（相对 vault），默认 90-Archive/93-System */
    captureArchiveDir?: string;
    /** 时间轴列表展示哪些状态：待处理([ ])、已整理([x])、取消([-])、暂不处理([/]) */
    captureShowStatuses?: { todo?: boolean; done?: boolean; cancelled?: boolean; paused?: boolean };
    /** Capture 条目类型推荐词典（高级配置） */
    captureTypeRecommendationDict?: {
      scheduleStrong?: string[];
      scheduleWeak?: string[];
      memoStrong?: string[];
      memoWeak?: string[];
      taskStrong?: string[];
      taskWeak?: string[];
    };
    /** Capture 即时计时显示模式：digital（数字）/ clock（钟表） */
    captureTimerDisplayMode?: "digital" | "clock";
    /** Capture 即时计时状态（用于崩溃恢复） */
    captureInstantTimerState?: {
      status: "idle" | "running" | "paused";
      purpose?: string;
      linkedTaskUid?: string;
      startedAt?: string;
      endedAt?: string;
      events?: Array<{ type: "start" | "pause" | "resume"; ts: string }>;
    };
  };

  /** Side Panel 2：任务管理 */
  taskPanel: TaskPanelSettings;

  /** Side Panel 3：项目管理 */
  projectRootDir: string;                 // 项目目录（每个子文件夹=一个项目）
  projectArchiveDir: string;              // 项目归档目录（不参与扫描）
  projectTasklistTemplatePath: string;    // 项目任务清单模板
  projectInfoTemplatePath: string;        // 项目信息模板
  projectAnalysisTemplatePath: string;    // 项目分析图模板

  /** 项目存档文件模板清单（与上述三个“标准项目文档模板”分开维护） */
  projectArchiveTemplates?: ProjectArchiveTemplateDef[];

  /** 项目存档文件模板：最近使用（按最近优先，存模板 id；用于下拉优先展示） */
  projectArchiveTemplateRecentIds?: string[];

  /** v23：项目中央索引目录（索引/队列/归档） */
  projectRSLatteIndexDir?: string;         // default: 00-System/.rslatte (V2)
  /** v23：是否启用项目与后端数据库同步 */
  projectEnableDbSync?: boolean;          // default: true
  /** v23：是否启用项目索引自动归档（每日一次） */
  projectAutoArchiveEnabled?: boolean;    // default: true
  /** v23：项目索引归档阈值（天）。DONE 用 done_date，CANCELLED 用 cancelled_date */
  projectArchiveThresholdDays?: number;   // default: 90
  /** v23：上次项目索引自动归档执行日期（YYYY-MM-DD） */
  projectArchiveLastRunKey?: string;

  /** 项目管理侧栏 UI（第九节）：分区折叠、双页签、项目进度管理搜索等 */
  projectPanel?: {
    projectAdvanceDescMaxLen?: number;
    inProgressListCollapsed?: boolean;
    doneListCollapsed?: boolean;
    pendingArchiveListCollapsed?: boolean;
    cancelledListCollapsed?: boolean;
    milestonesListCollapsed?: boolean;
    mainTab?: "list" | "progress";
    progressSelectedProjectId?: string;
    progressSearchCollapsed?: boolean;
    /** 无筛选时「最近 N 条」的 N，默认 5 */
    projectSearchDefaultLimit?: number;
    progressSortKey?:
      | "progress_updated"
      | "planned_end"
      | "created_date"
      | "done"
      | "cancelled"
      | "pending_archive"
      | "name"
      | "actual_start";
    progressSortAsc?: boolean;
    /** 待开始（status=todo），默认 true */
    progressFilterStatusTodo?: boolean;
    progressFilterStatusInProgress?: boolean;
    progressFilterStatusDone?: boolean;
    progressFilterStatusCancelled?: boolean;
    /** 项目状态多选下拉是否展开（仅 UI） */
    progressStatusFilterOpen?: boolean;
    progressFilterName?: string;
    /** 未选中项目时是否展开「可选项目列表」表格（第八节：默认仅筛选项 + 空态） */
    progressProjectPickerExpanded?: boolean;

    /** 第五节「项目进度图」：时间轴左右余量（天），默认约一月 */
    progressChartMarginDays?: number;
    /** 同轨任务排序：planned_end | file_order */
    progressChartTaskSort?: "planned_end" | "file_order";
    /** 横向缩放档位：week | month | quarter，默认 month */
    progressChartZoom?: "week" | "month" | "quarter";
    /** 里程碑时间线：overlay 叠加 | separate 独立条 | hidden 不显示 */
    progressChartMilestoneMode?: "overlay" | "separate" | "hidden";
    /** 完成度汇总：count | hours | both */
    progressChartSummaryMode?: "count" | "hours" | "both";
    /** 收起「项目进度图」区块的项目键（projectId 或 folderPath） */
    progressChartCollapsedKeys?: string[];
    /** 项目进度图：隐藏已完成（DONE）任务条，默认 false */
    progressChartHideDone?: boolean;
    /** 项目里程碑/任务清单：状态多选过滤（TODO/IN_PROGRESS/DONE/CANCELLED） */
    progressTaskListFilterStatuses?: Array<"TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED">;
    /**
     * 项目里程碑/任务清单：任务标签多选过滤（与 `TASK_TAG_META` / 项目任务衍生标签 key 一致）。
     * **空数组或未设置**：不按标签过滤（显示所有符合状态的任务）。
     */
    progressTaskListFilterTagKeys?: string[];
    /** 项目里程碑/任务清单：每个里程碑最多展示任务数（10/20/30/50/100） */
    progressTaskListDisplayLimit?: number;

    /** 里程碑即将超期天数：planned_end 在今天之后且 <= N 天内时标为「即将超期」（默认 3） */
    progressMilestoneUpcomingDays?: number;
    /** 项目概要「即将超期」天数：项目 planned_end 在今天之后且 <= N 天内写入 project_soon_overdue（默认 5，第九节 9.4） */
    progressProjectUpcomingDays?: number;
    /** 项目任务卡片（项目管理侧栏）：勾选 id 收入「⋯」 */
    sidePanelProjectTaskCardActionsInMore?: string[];
    /** 里程碑卡片（项目管理侧栏）：勾选 id 收入「⋯」 */
    sidePanelProjectMilestoneCardActionsInMore?: string[];
    /** 项目卡片（项目管理侧栏）：勾选 id 收入「⋯」 */
    sidePanelProjectCardActionsInMore?: string[];
  };

  /** Side Panel 4：输出管理 */
  outputPanel?: OutputPanelSettings;

  /** 知识库：`30-Knowledge` 下二级目录表（供「发布到知识库」等） */
  knowledgePanel?: KnowledgePanelSettings;

  /** Side Panel 1：打卡管理（打卡/财务）中央索引 */
  rslattePanelIndexDir?: string;          // default: 00-System/.rslatte (V2)
  /** Side Panel 1：是否启用打卡/财务与后端数据库同步 */
  rslattePanelEnableDbSync?: boolean;     // default: true
  /** Side Panel 1：是否启用打卡/财务中央索引自动归档（每日一次） */
  rslattePanelAutoArchiveEnabled?: boolean; // default: false
  /** Side Panel 1：索引归档阈值（天）。把阈值天之前的记录移动到 archive 索引 */
  rslattePanelArchiveThresholdDays?: number; // default: 90
  /** Side Panel 1：上次索引自动归档执行日期（YYYY-MM-DD） */
  rslattePanelArchiveLastRunKey?: string;

  /** UI：侧边栏标题栏按钮显隐（仅控制 🧱🗄🔄；➕ 始终展示） */
  uiHeaderButtons?: UiHeaderButtonsConfig;

  /** Side Panel 1：日记扫描增量水位（epoch ms）。用于增量更新索引 */
  rslattePanelLastDiaryScanMs?: number;

  /** Side Panel 1：是否在侧边栏展示财务统计饼图（本月/上月支出） */
  rslattePanelShowFinancePieCharts?: boolean;

  /** Stats: 统计功能设置 */
  statsSettings?: {
    /** 中央索引目录（workevent 数据存储的根目录） */
    centralIndexDir?: string;
    /** 空间配置列表 */
    spaces?: Array<{
      id: string;
      name: string;
      /** 空间背景色（用于时间轴中event的底色） */
      backgroundColor?: string;
      /** 是否启用数据获取（关闭时不显示该空间的数据，也不自动生成统计数据）；未设置时视为 true */
      enabled?: boolean;
    }>;
    /** 模块颜色配置 */
    moduleColors?: Record<string, string>;
    /** 模块名称配置（用户自定义的模块显示名称） */
    moduleNames?: Record<string, string>;
    /** 模块启用配置（控制模块是否参与统计） */
    moduleEnabled?: Record<string, boolean>;
  };
}
