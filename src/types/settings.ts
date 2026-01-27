import type { CheckinItemDef, FinanceCatDef, DailyState, JournalPanel } from "./rslatteTypes";
import type { TaskPanelSettings } from "./taskTypes";
import type { OutputPanelSettings } from "./outputTypes";
import type { RSLatteSpaceConfig } from "./space";

export type JournalAppendModule = "checkin" | "finance" | "task" | "memo" | "project" | "output";

// ===== UI：侧边栏标题栏按钮显隐（仅控制 🧱🗄🔄；➕ 始终展示） =====
export type UiModuleKey = "checkin" | "finance" | "memo" | "task" | "project" | "output" | "contacts";
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
};

/** 日志追加清单：按模块控制写入位置 */
export type JournalAppendRule = {
  module: JournalAppendModule;
  /** 是否启用该模块的日志追加（部分模块会被强制启用） */
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
    checkin?: boolean;
    finance?: boolean;
    project?: boolean;
    output?: boolean;
    // contacts: C1 仅占位（未接入 pipeline），不参与 forceFull
  };

  /** ✅ 统一的中央索引目录（四个模块共用：打卡/任务/项目/输出） */
  centralIndexDir?: string; // default: 95-Tasks/.rslatte

  /** ✅ Work Event Stream：统计用“工作事件流”（JSONL） */
  workEventEnabled?: boolean; // default: true
  /** Work Event Stream 相对路径（相对 centralIndexDir）。默认：.events/work-events.jsonl */
  workEventRelPath?: string;

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
    project?: boolean;
    output?: boolean;
    /** 联系人管理（C1：模块骨架） */
    contacts?: boolean;
    /** 手机模块（PWA 同步）；未指定空间用 mobileModuleBySpace[spaceId]，再 fallback 到此默认 */
    mobile?: boolean;
    /** 发布管理 */
    publish?: boolean;
  };

  /** 手机模块按空间覆盖：space_id -> boolean；未列出的空间使用 moduleEnabledV2.mobile */
  mobileModuleBySpace?: Record<string, boolean>;

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

  /** v6-4：备忘模块同步/归档参数（逐步启用） */
  memoModule?: {
    enableDbSync?: boolean;
    autoArchiveEnabled?: boolean;
    archiveThresholdDays?: number;
    /** v6-5：备忘模块上次自动归档执行日期（YYYY-MM-DD），用于“每日只执行一次” */
    archiveLastRunKey?: string;
    /** v6-5：备忘模块增量刷新水位（ms）——预留，v6-5.x 逐步启用 */
    lastDiaryScanMs?: number;
  };

  /** vC1：联系人模块同步/归档/目录参数（占位，后续逐步启用） */
  contactsModule?: {
    enableDbSync?: boolean;
    autoArchiveEnabled?: boolean;
    archiveThresholdDays?: number;

    /** 联系人目录根路径（group = 子目录） */
    contactsDir?: string;
    /** 模板路径（t_contact.md） */
    templatePath?: string;

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
  /** UI “done/todo” 状态缓存，不作为事实来源 */
  dailyState: Record<string, DailyState>;

  /** 旧：今日日志跳转（仍保留以兼容已有逻辑） */
  todayNotePathTemplate: string;
  todayNoteDateFormat: string;
  todayJumpHeadings: { label: string; heading: string }[];
  todayInsertBeforeHeading: string;
  journalPanels: JournalPanel[];

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
  projectRSLatteIndexDir?: string;         // default: 95-Tasks/.rslatte
  /** v23：是否启用项目与后端数据库同步 */
  projectEnableDbSync?: boolean;          // default: true
  /** v23：是否启用项目索引自动归档（每日一次） */
  projectAutoArchiveEnabled?: boolean;    // default: true
  /** v23：项目索引归档阈值（天）。DONE 用 done_date，CANCELLED 用 cancelled_date */
  projectArchiveThresholdDays?: number;   // default: 90
  /** v23：上次项目索引自动归档执行日期（YYYY-MM-DD） */
  projectArchiveLastRunKey?: string;

  /** Side Panel 4：输出管理 */
  outputPanel?: OutputPanelSettings;

  /** Side Panel 5：发布管理 */
  publishPanel?: import("./publishTypes").PublishPanelSettings;

  /** Side Panel 1：打卡管理（打卡/财务）中央索引 */
  rslattePanelIndexDir?: string;          // default: 95-Tasks/.rslatte
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
      /** 是否启用数据获取（关闭时不显示该空间的数据，也不自动生成统计数据） */
      enabled?: boolean;
    }>;
    /** 是否自动生成月度统计（每月1号） */
    autoGenerateMonthlyStats?: boolean;
    /** 模块颜色配置 */
    moduleColors?: Record<string, string>;
    /** 模块名称配置（用户自定义的模块显示名称） */
    moduleNames?: Record<string, string>;
    /** 模块启用配置（控制模块是否参与统计） */
    moduleEnabled?: Record<string, boolean>;
  };
}
