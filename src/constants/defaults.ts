import type { RSLattePluginSettings } from "../types/settings";
import { DEFAULT_KNOWLEDGE_SECONDARY_SUBDIRS } from "../types/knowledgeTypes";
import { DEFAULT_SPACE_ID } from "./space";
import { DEFAULT_SCHEDULE_CATEGORY_DEFS } from "../taskRSLatte/schedule/scheduleCategory";
import { DEFAULT_FINANCE_CATEGORIES } from "./defaultFinanceVaultConfig";

/**
 * 默认设置
 *
 * settings 约定：
 * 1) checkinItems / financeCategories：定义“按钮/清单”的静态配置（可与 DB 同步）
 * 2) dailyState：仅用于 UI “done/todo” 状态缓存，不作为事实来源（事实来源是 DB / 日记）
 * 3) enableJournalAppend：关闭后仍写 DB，但不写日记（方便临时禁用文件写入）
 */
export const DEFAULT_SETTINGS: RSLattePluginSettings = {
  refreshInterval: 600,
  apiBaseUrl: "",
  apiAuthAccessToken: "",
  apiBackendUserName: "",
  apiBackendPassword: "",

  // ✅ Step F0：space（UUID）
  currentSpaceId: DEFAULT_SPACE_ID,
  spaces: {
    [DEFAULT_SPACE_ID]: {
      id: DEFAULT_SPACE_ID,
      name: "默认空间",
      createdAt: "",
      updatedAt: "",
    },
  },

  // ✅ DB sync one-shot full import flags (set by toggle; cleared after success)
  dbSyncForceFullNext: {},

  // ✅ 统一中央索引目录（四个模块共用）；V2 下置于 00-System
  centralIndexDir: "00-System/.rslatte",

  // V2 知识库目录（与草案 00/10/20/30/90 对齐）
  useV2DirectoryStructure: true,
  v2DirectoryRoot: "",

  // ✅ Work Event Stream（统计用工作事件流）
  workEventEnabled: true,
  workEventRelPath: ".events/work-events.jsonl",
  /** JSONL 与后端 `rslatte_work_event` 双写；入库随「自动刷新索引」定时 tick，非实时 */
  workEventDbSyncEnabled: false,

  moduleEnabled: { record: true, task: true, project: true, output: true },
  // v6-2：模块拆分（逐步启用）
  moduleEnabledV2: { journal: true, checkin: true, finance: true, health: true, task: true, memo: true, schedule: true, project: true, output: true, contacts: true, publish: false },

  // v6-2：打卡/财务模块同步&归档参数（逐步启用；当前运行仍以统一配置表为准）
  checkinPanel: { enableDbSync: false, autoArchiveEnabled: true, archiveThresholdDays: 90 },
  financePanel: { enableDbSync: false, autoArchiveEnabled: true, archiveThresholdDays: 90 },
  healthPanel: {
    /** 目标体重（kg），侧栏体重趋势图为虚线参考；默认 55 */
    targetWeightKg: 55,
    /** 目标腰围（cm），侧栏腰围趋势图为虚线参考；默认 75 */
    targetWaistCm: 75,
    waterGoalCups: 8,
    waterCupVolumeMl: 500,
    enableDbSync: false,
    autoArchiveEnabled: true,
    archiveThresholdDays: 90,
    archiveLastRunKey: "",
    healthMetricsEnabled: {},
    healthStatsMetricsEnabled: {},
    healthRuleAlertsEnabled: {},
  },

  financeCyclePlans: [],
  financeManagementCurrency: "CNY",
  financeInstitutionSimilarIgnore: [],

  // v6-4：任务/提醒模块同步&归档参数（逐步启用；当前运行仍以 taskPanel 的统一配置为准）
  // v6-5：补齐 archiveLastRunKey/lastDiaryScanMs（预留字段；本步不改变运行行为）
  taskModule: { enableDbSync: false, autoArchiveEnabled: true, archiveThresholdDays: 90, archiveLastRunKey: "", lastDiaryScanMs: 0 },
  memoModule: { enableDbSync: false, autoArchiveEnabled: true, archiveThresholdDays: 90, archiveLastRunKey: "", lastDiaryScanMs: 0 },
  scheduleModule: {
    enableDbSync: false,
    autoArchiveEnabled: true,
    archiveThresholdDays: 90,
    archiveLastRunKey: "",
    lastDiaryScanMs: 0,
    scheduleCategoryDefs: DEFAULT_SCHEDULE_CATEGORY_DEFS.map((d) => ({ ...d })),
    defaultScheduleCategoryId: "meeting",
    sidePanelScheduleCardActionsInMore: [],
    sidePanelScheduleClosedCardActionsInMore: [],
  },

  // vC1：联系人模块（仅骨架；默认关闭）；V2 下 10-Personal/15-Contacts
  contactsModule: {
    enableDbSync: false,
    autoArchiveEnabled: true,
    archiveThresholdDays: 90,
    contactsDir: "10-Personal/15-Contacts",
    archiveDir: "90-Archive/10-Personal/15-Contacts",
    groupDirBlacklist: ["templates", "_archived"],
    archiveLastRunKey: "",

    // Step 1/6：互动写入章节 + 子标题
    // - eventSectionHeader：手动/动态共用的“互动记录”章节
    // - manualEventSubHeader：手动互动写入的子标题（可为空）
    // - dynamicEventSubHeader：动态互动摘要写入的子标题（可为空）
    eventSectionHeader: "## 互动记录",
    manualEventSubHeader: "### 手动互动",
    dynamicEventSubHeader: "### 动态互动",

    contactFollowupOverdueDays: 30,
    interactionEventsMaxPerContactInIndex: 100,
    interactionEventsMaxPerSourcePerContact: 10,
    /** §6.9：溢出归档分片单文件最大字节（1MB） */
    contactInteractionArchiveShardMaxBytes: 1048576,
    interactionTimelinePreviewCount: 3,
    contactDetailsFieldBlacklist: [],

    // Backward compatibility (deprecated): older setting key used by some versions
    manualEventSectionHeader: "## 互动记录",
  },

  // V2 快速记录（Capture）：待整理写入 Inbox 目录，按空间配置
  captureModule: {
    captureInboxDir: "10-Personal/17-Inbox",
    captureInboxFileNameFormat: "YYYYMMDD",
    captureArchiveDir: "90-Archive/10-Personal/17-Inbox/",
    captureShowStatuses: { todo: true, done: false, cancelled: false, paused: true },
    captureTimerDisplayMode: "digital",
    captureInstantTimerState: { status: "idle", events: [] },
    captureTypeRecommendationDict: {
      scheduleStrong: ["开会", "会议", "复盘", "约见", "面试", "拜访", "会谈", "课程", "值班"],
      scheduleWeak: ["今天", "明天", "后天", "本周", "下周", "下午", "晚上"],
      memoStrong: ["提醒我", "记得", "别忘", "不要忘", "到时提醒", "生日", "纪念日"],
      memoWeak: ["复查", "取快递", "续费", "到期", "过期", "稍后", "晚点"],
      taskStrong: ["整理", "跟进", "提交", "推进", "完成", "修复", "开发", "实现", "评审"],
      taskWeak: ["周报", "报销", "合同", "方案", "文档", "待办", "todo"],
    },
  },

  autoRefreshIndexEnabled: true,
  autoRefreshIndexIntervalMin: 30,

  vaultId: "",
  dailyState: {},
  checkinDisplayStyle: "buttons",

  checkinItems: [
    { id: "DK_READ", name: "阅读", active: true },
    { id: "DK_RUN", name: "跑步", active: true },
    { id: "DK_CODE", name: "写代码", active: true },
  ],
  financeCategories: DEFAULT_FINANCE_CATEGORIES.map((c) => ({
    ...c,
    subCategories: c.subCategories ? [...c.subCategories] : [],
    institutionNames: c.institutionNames ? [...c.institutionNames] : [],
  })),
  todayNotePathTemplate: "10-Personal/11-Daily/{{date}}.md",
  todayNoteDateFormat: "YYYY-MM-DD",
  todayJumpHeadings: [],
  todayInsertBeforeHeading: "",
  journalPanels: [
    { id: "JP_ACCUM", label: "📚 今天学了什么", heading: "### 📚 今天学了什么", maxLines: 20 },
    { id: "JP_SPORT", label: "💡 今天的想法", heading: "### 💡 今天的想法", maxLines: 20 },
    { id: "JP_8LLQ8M", label: "🔗 与知识库的连接", heading: "### 🔗 与知识库的连接", maxLines: 20 },
    { id: "JP_AORMOF", label: "✅ 今天开展的工作", heading: "### ✅ 今天开展的工作", maxLines: 20 },
  ],
  weeklyJournalPanels: [
    { id: "JP_WEEK_SUM", label: "📊 本周关键数据", heading: "## 📊 本周关键数据", maxLines: 20 },
    { id: "JP_42CS0L", label: "⚠️ 本周主要问题", heading: "## ⚠️ 本周主要问题", maxLines: 20 },
    { id: "JP_61KKQ4", label: "🔍 本周高价值事件", heading: "## 🔍 本周高价值事件", maxLines: 20 },
    { id: "JP_EQ7JWA", label: "🎯 下周计划", heading: "## 🎯 下周计划", maxLines: 20 },
    { id: "JP_MIA4ZL", label: "📝 复盘一句话", heading: "## 📝 复盘一句话", maxLines: 20 },
  ],
  monthlyJournalPanels: [
    { id: "JP_MONTH_SUM", label: "📊 本月关键数据", heading: "## 📊 本月关键数据", maxLines: 20 },
    { id: "JP_EKP4I3", label: "🏆 本月最重要的进展", heading: "## 🏆 本月最重要的进展", maxLines: 20 },
    { id: "JP_W64ML7", label: "⚠️ 本月主要问题与模式", heading: "## ⚠️ 本月主要问题与模式", maxLines: 20 },
    { id: "JP_44XOJ4", label: "📈 本月趋势判断", heading: "## 📈 本月趋势判断", maxLines: 20 },
    { id: "JP_0BSETV", label: "🎯 下月重点", heading: "## 🎯 下月重点", maxLines: 20 },
    { id: "JP_ABAQ05", label: "📝 阶段总结", heading: "## 📝 阶段总结", maxLines: 20 },
  ],
  quarterlyJournalPanels: [
    { id: "JP_QUARTER_SUM", label: "🏆二、本季度核心成果", heading: "## 🏆二、本季度核心成果", maxLines: 30 },
    { id: "JP_DEN841", label: "📌三、关键项目进展", heading: "## 📌三、关键项目进展", maxLines: 20 },
    { id: "JP_4IDXLV", label: "📊四、数据复盘", heading: "## 📊四、数据复盘", maxLines: 20 },
    { id: "JP_XM2NPM", label: "✨五、亮点与经验", heading: "## ✨五、亮点与经验", maxLines: 20 },
    { id: "JP_RVXHA3", label: "⚠️六、问题与风险", heading: "## ⚠️六、问题与风险", maxLines: 20 },
    { id: "JP_8614T4", label: "🔭七、下季度计划", heading: "## 🔭七、下季度计划", maxLines: 20 },
  ],
  showJournalPanels: true,
  journalPanelParentHeading: "碎碎念",

  // ===== 日志追加清单（按模块） =====
  journalAppendRules: [
    // 强制启用：打卡/财务/任务/提醒（这些数据的存档在日记中）
    { module: "checkin", enabled: true, h1: "# 操作日志", h2: "## 打卡记录" },
    { module: "finance", enabled: true, h1: "# 操作日志", h2: "## 财务记录" },
    { module: "health", enabled: true, h1: "# 操作日志", h2: "## 健康记录" },
    { module: "task", enabled: true, h1: "# 任务追踪", h2: "## 新增任务" },
    { module: "memo", enabled: true, h1: "# 任务追踪", h2: "## 新增提醒" },
    // 强制启用（与任务/提醒相同，存档在日记中）
    { module: "schedule", enabled: true, h1: "# 任务追踪", h2: "## 新增日程" },
    // 可选：项目/输出（写入当日统计变化/当日文件操作记录）
    { module: "project", enabled: false, h1: "# 进度更新", h2: "## 项目进度" },
    { module: "output", enabled: false, h1: "# 进度更新", h2: "## 输出进度" },
  ],
  debugLogEnabled: false,
  financeLogHeading: "### 财务流水",
  financeLogLinePrefix: "- ",
  checkinLogHeading: "### 打卡记录",
  checkinLogLinePrefix: "- ",
  enableJournalAppend: true,
  appendAnchorHeading: "",
  diaryTemplate: "00-System/01-Templates/t_daily.md",
  diaryPath: "10-Personal/11-Daily/diary",
  diaryNameFormat: "YYYYMMDD",
  diaryArchiveMonthDirName: "YYYYMM",
  diaryArchiveThresholdDays: 30,
  diaryArchiveLastRunKey: "",

  reviewRecordsWeeklyEnabled: false,
  reviewRecordsMonthlyEnabled: false,
  reviewRecordsQuarterlyEnabled: false,
  weeklyReportTemplatePath: "00-System/01-Templates/t_weekly.md",
  monthlyReportTemplatePath: "00-System/01-Templates/t_monthly.md",
  quarterlyReportTemplatePath: "00-System/01-Templates/t_quarterly.md",

  // ===== 项目管理；V2 下 10-Personal/13-Projects，归档 90-Archive/91-Personal ====
  projectRootDir: "10-Personal/13-Projects",
  projectArchiveDir: "90-Archive/10-Personal/13-Projects",
  projectTasklistTemplatePath: "00-System/01-Templates/t_project_tasklist.md",
  projectInfoTemplatePath: "00-System/01-Templates/t_project_info.md",
  projectAnalysisTemplatePath: "00-System/01-Templates/t_project_canvas.canvas",

  // 项目存档文件模板（与上面三个“标准项目文档模板”分开维护）
  projectArchiveTemplates: [],

  // 项目存档文件模板：最近使用（按最近优先）
  projectArchiveTemplateRecentIds: [],

  // v23：项目中央索引/同步/归档（仅索引）；V2 与 centralIndexDir 一致
  projectRSLatteIndexDir: "00-System/.rslatte",
  projectEnableDbSync: false,
  projectAutoArchiveEnabled: true,
  projectArchiveThresholdDays: 90,
  projectArchiveLastRunKey: "",

  taskPanel: {
    taskFolders: ["10-Personal/11-Daily"],
    includeTags: [],
    excludeTags: [],
    rslatteIndexDir: "00-System/.rslatte",
    enableDbSync: false,
    // v26：任务/提醒 upsert-batch 每批条目数
    upsertBatchSize: 50,
    // v26：Reconcile 安全门：队列必须为空
    reconcileRequireQueueEmpty: true,
    // v27：Reconcile 安全门：仅对“干净文件”（无 uidMissing）执行
    reconcileRequireFileClean: true,
    // v28：全量提醒清单（显示在事项提醒下方）
    memoAllEnabled: true,
    memoAllMaxItems: 50,
    memoAllStatuses: ["TODO", "IN_PROGRESS"],
    reminderUpcomingDays: 5,
    recentClosedMemoWindowDays: 30,
    scheduleUpcomingDays: 5,
    scheduleRecentClosedDays: 30,
    autoArchiveEnabled: true,
    // 归档阈值（天）：DONE 用 ✅ 日期，CANCELLED 用 ❌ 日期。默认 90 天。
    archiveThresholdDays: 90,
    // 兼容旧配置：若 archiveThresholdDays 未配置则回退到该字段（月）。
    archiveKeepMonths: 3,
    taskInsertSectionH2: "任务",
    memoInsertSectionH2: "提醒",
    // v5：各分区折叠状态（key=todayAction/todayFollowUp/overdue/otherRisk/otherActive/closedCancelled/closedDone）
    collapsedLists: {},
    overdueWithinDays: 3,
    closedTaskWindowDays: 7,
    taskBusinessCategories: ["学习", "工作", "生活"],
    defaultTaskBusinessCategory: "学习",
    sidePanelTaskCardActionsInMore: [],
    sidePanelMemoCardActionsInMore: [],
    sidePanelMemoClosedCardActionsInMore: [],
    // categories: [] // legacy
  },

  /** 项目管理侧栏 UI（第九节）：折叠、双页签、搜索条数等 */
  projectPanel: {
    projectAdvanceDescMaxLen: 36,
    inProgressListCollapsed: false,
    doneListCollapsed: true,
    pendingArchiveListCollapsed: true,
    cancelledListCollapsed: true,
    milestonesListCollapsed: true,
    mainTab: "list" as const,
    progressSelectedProjectId: "",
    progressSearchCollapsed: false,
    projectSearchDefaultLimit: 5,
    progressSortKey: "progress_updated" as const,
    progressSortAsc: false,
    progressFilterStatusTodo: true,
    progressFilterStatusInProgress: true,
    progressFilterStatusDone: true,
    progressFilterStatusCancelled: true,
    progressFilterName: "",
    progressChartMarginDays: 30,
    progressChartTaskSort: "planned_end" as const,
    progressChartZoom: "month" as const,
    progressChartMilestoneMode: "overlay" as const,
    progressChartSummaryMode: "both" as const,
    progressChartCollapsedKeys: [] as string[],
    progressChartHideDone: false,
    progressTaskListFilterStatuses: ["TODO", "IN_PROGRESS", "DONE", "CANCELLED"] as Array<"TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED">,
    progressTaskListDisplayLimit: 10,
    progressMilestoneUpcomingDays: 3,
    /** 项目概要「即将超期」：计划日在今天之后且 <= N 天内（第九节 9.4） */
    progressProjectUpcomingDays: 5,
    sidePanelProjectTaskCardActionsInMore: [] as string[],
    sidePanelProjectMilestoneCardActionsInMore: [] as string[],
    sidePanelProjectCardActionsInMore: [] as string[],
  },

  // ===== 输出管理（Side Panel 4）；V2 下 00-System 索引，33-Outputs 扫描，90-Archive 归档 =====
  outputPanel: {
    rslatteIndexDir: "00-System/.rslatte",
    enableDbSync: false,
    autoArchiveEnabled: true,
    archiveThresholdDays: 90,
    archiveRootDir: "90-Archive/10-Personal/12-Notes",
    archiveRoots: ["10-Personal/12-Notes"],
    fullRebuildScanLegacyArchiveDirs: true,
    templates: [],
    timelineTimeField: "mtime",
    maxItems: 20,
    templateCreateCounts: {},
    listFilterShowGeneral: true,
    listFilterShowProject: true,
    listFilterMode: "all",
    createOutputExtraFields: [],
    sidePanelMainTab: "list",
    // showStatuses 已移除：侧边栏现在按三个清单（进行中/已完成/取消）分类显示所有状态
  },

  knowledgePanel: {
    secondarySubdirs: DEFAULT_KNOWLEDGE_SECONDARY_SUBDIRS.map((r) => ({ ...r })),
    enableDbSync: false,
  },

  // ===== 打卡管理（Side Panel 1）中央索引 / 同步 / 归档；V2 与 centralIndexDir 一致 =====
  rslattePanelIndexDir: "00-System/.rslatte",
  rslattePanelEnableDbSync: false,
  rslattePanelAutoArchiveEnabled: true,
  rslattePanelArchiveThresholdDays: 90,
  rslattePanelArchiveLastRunKey: "",
  rslattePanelLastDiaryScanMs: 0,
  rslattePanelShowFinancePieCharts: true,

  // ===== UI：侧边栏标题栏按钮显隐（仅控制 🧱🗄🔄；➕ 始终展示） =====
  uiHeaderButtons: {
    checkin: { rebuild: true, archive: true, refresh: true },
    finance: { rebuild: true, archive: true, refresh: true },
    health: { rebuild: true, archive: true, refresh: true },
    memo: { rebuild: true, archive: true, refresh: true },
    schedule: { rebuild: true, archive: true, refresh: true },
    task: { rebuild: true, archive: true, refresh: true },
    project: { rebuild: true, archive: true, refresh: true },
    output: { rebuild: true, archive: true, refresh: true },
    contacts: { rebuild: true, archive: true, refresh: true },
  },
};

/** 模块「索引归档阈值（天）」下限（与 Review 覆盖、主索引保留口径一致） */
export const MIN_ARCHIVE_THRESHOLD_DAYS = 90;
export const MAX_ARCHIVE_THRESHOLD_DAYS = 3650;

export function normalizeArchiveThresholdDays(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return MIN_ARCHIVE_THRESHOLD_DAYS;
  return Math.min(MAX_ARCHIVE_THRESHOLD_DAYS, Math.max(MIN_ARCHIVE_THRESHOLD_DAYS, n));
}

/** 设置页 number 框失焦/变更：解析并钳位；若用户填了小于下限的有限值则返回 `notifyBelowMin`。 */
export function archiveThresholdFromUserInput(inputValue: string): { value: number; notifyBelowMin: boolean } {
  const rawNum = Number(inputValue);
  const rawFloor = Math.floor(rawNum);
  const value = normalizeArchiveThresholdDays(inputValue);
  const notifyBelowMin = Number.isFinite(rawNum) && rawFloor < MIN_ARCHIVE_THRESHOLD_DAYS;
  return { value, notifyBelowMin };
}

/** 加载设置后：将各模块归档阈值收敛到合法区间（修正旧库中小于 90 天的配置）。 */
export function clampModuleArchiveThresholdsInSettings(s: any): void {
  if (!s || typeof s !== "object") return;
  const fix = (obj: any, key: string) => {
    if (!obj || typeof obj !== "object") return;
    if (obj[key] !== undefined && obj[key] !== null) obj[key] = normalizeArchiveThresholdDays(obj[key]);
  };
  fix(s.checkinPanel, "archiveThresholdDays");
  fix(s.financePanel, "archiveThresholdDays");
  fix(s.healthPanel, "archiveThresholdDays");
  fix(s.taskModule, "archiveThresholdDays");
  fix(s.memoModule, "archiveThresholdDays");
  fix(s.scheduleModule, "archiveThresholdDays");
  fix(s.outputPanel, "archiveThresholdDays");
  fix(s.contactsModule, "archiveThresholdDays");
  fix(s.taskPanel, "archiveThresholdDays");
  if (s.rslattePanelArchiveThresholdDays !== undefined && s.rslattePanelArchiveThresholdDays !== null) {
    s.rslattePanelArchiveThresholdDays = normalizeArchiveThresholdDays(s.rslattePanelArchiveThresholdDays);
  }
  if (s.projectArchiveThresholdDays !== undefined && s.projectArchiveThresholdDays !== null) {
    s.projectArchiveThresholdDays = normalizeArchiveThresholdDays(s.projectArchiveThresholdDays);
  }
}