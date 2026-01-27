import type { RSLattePluginSettings } from "../types/settings";
import { DEFAULT_SPACE_ID } from "./space";

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

  // ✅ 统一中央索引目录（四个模块共用）
  centralIndexDir: "95-Tasks/.rslatte",

  // ✅ Work Event Stream（统计用工作事件流）
  workEventEnabled: true,
  workEventRelPath: ".events/work-events.jsonl",

  moduleEnabled: { record: true, task: true, project: true, output: true },
  // v6-2：模块拆分（逐步启用）
  moduleEnabledV2: { journal: true, checkin: true, finance: true, task: true, memo: true, project: true, output: true, contacts: true, mobile: true },
  // 手机模块按空间开关：space_id -> boolean；未列出的空间使用 moduleEnabledV2.mobile 作为默认
  mobileModuleBySpace: {},

  // v6-2：打卡/财务模块同步&归档参数（逐步启用；当前运行仍以统一配置表为准）
  checkinPanel: { enableDbSync: false, autoArchiveEnabled: true, archiveThresholdDays: 90 },
  financePanel: { enableDbSync: false, autoArchiveEnabled: true, archiveThresholdDays: 90 },

  // v6-4：任务/备忘模块同步&归档参数（逐步启用；当前运行仍以 taskPanel 的统一配置为准）
  // v6-5：补齐 archiveLastRunKey/lastDiaryScanMs（预留字段；本步不改变运行行为）
  taskModule: { enableDbSync: false, autoArchiveEnabled: true, archiveThresholdDays: 90, archiveLastRunKey: "", lastDiaryScanMs: 0 },
  memoModule: { enableDbSync: false, autoArchiveEnabled: true, archiveThresholdDays: 90, archiveLastRunKey: "", lastDiaryScanMs: 0 },

  // vC1：联系人模块（仅骨架；默认关闭）
  contactsModule: {
    enableDbSync: false,
    autoArchiveEnabled: true,
    archiveThresholdDays: 90,
    contactsDir: "90-Contacts",
    templatePath: "91-Templates/t_contact.md",
    archiveDir: "90-Contacts/_archived",
    archiveLastRunKey: "",

    // Step 1/6：互动写入章节 + 子标题
    // - eventSectionHeader：手动/动态共用的“互动记录”章节
    // - manualEventSubHeader：手动互动写入的子标题（可为空）
    // - dynamicEventSubHeader：动态互动摘要写入的子标题（可为空）
    eventSectionHeader: "## 互动记录",
    manualEventSubHeader: "### 手动互动",
    dynamicEventSubHeader: "### 动态互动",

    // Backward compatibility (deprecated): older setting key used by some versions
    manualEventSectionHeader: "## 互动记录",
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
  financeCategories: [
    { id: "CW_FOOD", name: "餐饮", type: "expense", active: true },
    { id: "CW_TRAN", name: "交通", type: "expense", active: true },
    { id: "CW_SAL", name: "工资", type: "income", active: true },
  ],
  todayNotePathTemplate: "01-Daily/{{date}}.md",
  todayNoteDateFormat: "YYYY-MM-DD",
  todayJumpHeadings: [],
  todayInsertBeforeHeading: "",
  journalPanels: [
    { id: "JP_ACCUM", label: "📝 今日积累", heading: "### 今日积累", maxLines: 20 },
    { id: "JP_SPORT", label: "🏃 今日运动", heading: "### 今日运动", maxLines: 20 },
  ],
  showJournalPanels: true,
  journalPanelParentHeading: "碎碎念",

  // ===== 日志追加清单（按模块） =====
  journalAppendRules: [
    // 强制启用：打卡/财务/任务/备忘（这些数据的存档在日记中）
    { module: "checkin", enabled: true, h1: "# 操作日志", h2: "## 打卡记录" },
    { module: "finance", enabled: true, h1: "# 操作日志", h2: "## 财务记录" },
    { module: "task", enabled: true, h1: "# 任务追踪", h2: "## 新增任务" },
    { module: "memo", enabled: true, h1: "# 任务追踪", h2: "## 新增备忘" },
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
  diaryTemplate: "91-Templates/t_daily.md",
  diaryPath: "01-Diary",
  diaryNameFormat: "YYYYMMDD",
  diaryArchiveMonthDirName: "YYYYMM",
  diaryArchiveThresholdDays: 30,
  diaryArchiveLastRunKey: "",

  // ===== 项目管理 =====
  projectRootDir: "03-Projects",
  projectArchiveDir: "03-Projects/_archived",
  projectTasklistTemplatePath: "91-Templates/t_project_tasklist.md",
  projectInfoTemplatePath: "91-Templates/t_project_info.md",
  projectAnalysisTemplatePath: "91-Templates/t_project_excalidraw.md",

  // 项目存档文件模板（与上面三个“标准项目文档模板”分开维护）
  projectArchiveTemplates: [],

  // 项目存档文件模板：最近使用（按最近优先）
  projectArchiveTemplateRecentIds: [],

  // v23：项目中央索引/同步/归档（仅索引，不修改原始项目文件）
  projectRSLatteIndexDir: "95-Tasks/.rslatte",
  projectEnableDbSync: false,
  projectAutoArchiveEnabled: true,
  projectArchiveThresholdDays: 90,
  projectArchiveLastRunKey: "",

  taskPanel: {
    taskFolders: ["01-Diary"],
    includeTags: [],
    excludeTags: [],
    rslatteIndexDir: "95-Tasks/.rslatte",
    enableDbSync: false,
    // v26：任务/备忘 upsert-batch 每批条目数
    upsertBatchSize: 50,
    // v26：Reconcile 安全门：队列必须为空
    reconcileRequireQueueEmpty: true,
    // v27：Reconcile 安全门：仅对“干净文件”（无 uidMissing）执行
    reconcileRequireFileClean: true,
    memoLookaheadDays: 7,
    showImportantMemosInRSLattePanel: true,
    // v28：全量备忘清单（显示在事项提醒下方）
    memoAllEnabled: true,
    memoAllMaxItems: 50,
    memoAllStatuses: ["TODO", "IN_PROGRESS"],
    autoArchiveEnabled: true,
    // 归档阈值（天）：DONE 用 ✅ 日期，CANCELLED 用 ❌ 日期。默认 90 天。
    archiveThresholdDays: 90,
    // 兼容旧配置：若 archiveThresholdDays 未配置则回退到该字段（月）。
    archiveKeepMonths: 3,
    taskInsertSectionH2: "任务",
    memoInsertSectionH2: "重要事项",
    builtinLists: {
      todayTodo: { enabled: true, maxItems: 20, sortField: "due", sortOrder: "asc" },
      weekTodo: { enabled: true, maxItems: 20, sortField: "due", sortOrder: "asc" },
      inProgress: { enabled: true, maxItems: 20, sortField: "start", sortOrder: "asc" },
      overdue: { enabled: true, maxItems: 20, sortField: "due", sortOrder: "asc" },
      todayDone: { enabled: true, maxItems: 20, sortField: "done", sortOrder: "desc" },
      cancelled7d: { enabled: true, maxItems: 20, sortField: "cancelled", sortOrder: "desc" },
    },
    // 内置清单显示顺序（↑↓ 可调整）
    builtinListOrder: ["todayTodo", "weekTodo", "inProgress", "overdue", "todayDone", "cancelled7d"],
    // v5：各清单折叠状态（key=listId, true=collapsed）
    collapsedLists: {},
    // categories: [] // legacy
  },

  // ===== 输出管理（Side Panel 4） =====
  outputPanel: {
    rslatteIndexDir: "95-Tasks/.rslatte",
    enableDbSync: false,
    autoArchiveEnabled: true,
    archiveThresholdDays: 90,
    archiveRootDir: "99-Archive",
    archiveRoots: ["00-Inbox", "02-Notes"],
    templates: [],
    timelineTimeField: "mtime",
    maxItems: 20,
    // showStatuses 已移除：侧边栏现在按三个清单（进行中/已完成/取消）分类显示所有状态
  },

  // ===== 发布管理（Side Panel 5） =====
  publishPanel: {
    documentDirs: [],
    publishChannels: [],
  },

  // ===== 打卡管理（Side Panel 1）中央索引 / 同步 / 归档 =====
  rslattePanelIndexDir: "95-Tasks/.rslatte",
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
    memo: { rebuild: true, archive: true, refresh: true },
    task: { rebuild: true, archive: true, refresh: true },
    project: { rebuild: true, archive: true, refresh: true },
    output: { rebuild: true, archive: true, refresh: true },
    contacts: { rebuild: true, archive: true, refresh: true },
  },
};