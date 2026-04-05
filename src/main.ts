import {
  Plugin,
  Notice,
  moment,
  TFile,
  TFolder,
  MarkdownView,
  normalizePath,
  parseYaml,
} from "obsidian";

const momentFn = moment as any;

import { RSLatteApiClient, apiTry, ApiCheckinRecord, ApiFinanceRecord, ApiFinanceSummaryStats, ContactsUpsertItem, ContactsUpsertBatchReq } from "./api";

import { VIEW_TYPE_RSLATTE, VIEW_TYPE_TASKS, VIEW_TYPE_SCHEDULE, VIEW_TYPE_PROJECTS, VIEW_TYPE_OUTPUTS, VIEW_TYPE_FINANCE, VIEW_TYPE_HEALTH, VIEW_TYPE_CHECKIN, VIEW_TYPE_HUB, VIEW_TYPE_TIMELINE, VIEW_TYPE_CALENDAR, VIEW_TYPE_CAPTURE, VIEW_TYPE_TODAY, VIEW_TYPE_KNOWLEDGE, VIEW_TYPE_KNOWLEDGE_PANEL, VIEW_TYPE_REVIEW } from "./constants/viewTypes";
import { clampModuleArchiveThresholdsInSettings, DEFAULT_SETTINGS, normalizeArchiveThresholdDays } from "./constants/defaults";
import { UI_STATS_WHITELIST } from "./ui/uiStatsWhitelist";

import type { RSLattePluginSettings } from "./types/settings";
import type { TaskPanelSettings } from "./types/taskTypes";
import type { CheckinItemDef } from "./types/rslatteTypes";
import { normalizeOutputTemplateDef } from "./types/outputTypes";
import { DEFAULT_KNOWLEDGE_SECONDARY_SUBDIRS, withoutRemovedLegacyKnowledgeSubdirs } from "./types/knowledgeTypes";

import { SettingsService } from "./services/settingsService";
import { AuditService } from "./services/auditService";
import { WorkEventService } from "./services/workEventService";
import { WorkEventReader } from "./services/stats/WorkEventReader";
import { VaultService } from "./services/vaultService";
import { JournalService } from "./services/journalService";
import { FinanceSummaryService } from "./services/financeSummary";
import { NoteNavigator } from "./services/noteNavigator";
import { migrateJumpHeadingsToPanelsIfNeeded } from "./services/legacyMigrations";
import { migrateSpacesIfNeeded } from "./services/space/spaceMigrations";
import { arePluginModulesUnlocked } from "./services/envCheck/pluginEnvCheck";
// 这些导入可能通过 mixin 或其他动态方式使用，保留以备将来使用
// @ts-ignore - Reserved for future use
import {
  buildSpaceCtx,
  getCurrentSpaceId as getCurSpaceIdFromSettings,
  getSpaceConfig as getSpaceConfigFromSettings,
  resolveCentralRootDir,
  resolveSpaceBaseDir,
  resolveSpaceEventsDir,
  resolveSpaceIndexDir,
  resolveSpaceQueueDir,
  resolveSpaceStatsDir,
} from "./services/space/spaceContext";
import { SpacesIndexService } from "./services/space/spacesIndexService";
import { DEFAULT_SPACE_ID, RSLATTE_EVENT_DB_SYNC_STATUS_CHANGED, RSLATTE_EVENT_SPACE_CHANGED } from "./constants/space";
import { TaskRSLatteService } from "./taskRSLatte/service";
import { ProjectManagerService } from "./projectManager/service";
import { registerKnowledgeOutputUpdatedLedgerHook } from "./outputRSLatte/knowledgeOutputUpdatedLedgerHook";
import { OutputRSLatteService } from "./outputRSLatte/service";
import { RecordRSLatteService } from "./recordRSLatte/service";

import { PipelineEngine } from "./services/pipeline/pipelineEngine";
import { AutoRefreshCoordinator } from "./services/pipeline/coordinator";
import type { ModuleRegistry } from "./services/pipeline/moduleRegistry";
// 这些类型导入可能在其他地方使用，保留以备将来使用
// @ts-ignore - Reserved for future use
import type { ModuleSpec, ModuleSpecAny, ModuleSpecAtomic, RSLatteModuleOpContext, RSLatteAtomicOpContext, RSLatteModuleOpSummary, RSLatteModuleStats, RSLatteReconcileGate } from "./services/pipeline/moduleSpec";
import type { RSLatteModuleKey } from "./services/pipeline/types";
import { buildPipelineModuleIsEnabled } from "./plugin/pipelineModuleEnabled";
import { runContactsPostPhysicalArchiveSteps, runContactsPreArchiveEnsureMainIndex } from "./services/pipeline/helpers/archiveOrchestration";

import { debounce } from "./utils/debounce";
import { yieldIfArchiveBatchBoundary } from "./utils/archiveBatchYield";
import { toLocalOffsetIsoString } from "./utils/localCalendarYmd";

import { RSLatteSidePanelView } from "./ui/views/RSLatteSidePanelView";
import { TaskSidePanelView } from "./ui/views/TaskSidePanelView";
import { ProjectSidePanelView } from "./ui/views/ProjectSidePanelView";
import { OutputSidePanelView } from "./ui/views/OutputSidePanelView";
import { FinanceSidePanelView } from "./ui/views/FinanceSidePanelView";
import { HealthSidePanelView } from "./ui/views/HealthSidePanelView";
import { CheckinSidePanelView } from "./ui/views/CheckinSidePanelView";
import { SpaceHubView } from "./ui/views/SpaceHubView";
import { TimelineView } from "./ui/views/stats/TimelineView";
import { CalendarView } from "./ui/views/CalendarView";
import { CaptureView } from "./ui/views/CaptureView";
import { TodayView } from "./ui/views/TodayView";
import { KnowledgeView } from "./ui/views/KnowledgeView";
import { ReviewView } from "./ui/views/ReviewView";
import { ContactsIndexService } from "./contactsRSLatte/indexService";
import { rebuildTaskProjectInteractionEventsFromWorkEvents } from "./services/contacts/rebuildTaskProjectInteractionEventsFromWorkEvents";
import { ContactsIndexStore } from "./contactsRSLatte/indexStore";
import type { ContactIndexItem } from "./contactsRSLatte/types";
import { RSLatteSettingTab } from "./ui/settings/RSLatteSettingTab";
import { InsertContactReferenceModal } from "./ui/modals/InsertContactReferenceModal";
import { buildProjectTaskContactEntriesForFile } from "./services/contacts/projectTaskContactInteractions";
import { replaceContactDynamicGeneratedBlock, statusIconForInteractionWithPhase } from "./services/contacts/contactNoteWriter";
// 这些类型可能通过 mixin 或其他动态方式使用，保留以备将来使用
// @ts-ignore - Reserved for future use
import type { SpaceCtx, RSLatteSpaceConfig } from "./types/space";

import { createAllModules } from "./plugin/index";
import { applyRslatteBundledWorkspaceLayout } from "./plugin/applyBundledWorkspaceLayout";
import { clearLeftRightSidebarsFromCommand } from "./plugin/quadrantWorkspaceLayout";
import { isWorkspacesCorePluginEnabled } from "./plugin/obsidianCorePluginGate";

type DbSyncModuleKey =
  | "record"
  | "checkin"
  | "finance"
  | "health"
  | "knowledge"
  | "task"
  | "memo"
  | "output"
  | "project"
  | "contacts";

export default class RSLattePlugin extends Plugin {
  settings!: RSLattePluginSettings;

  api!: RSLatteApiClient;

  protected settingsSvc!: SettingsService;
  private auditSvc!: AuditService;
  /** Work Event Stream（append-only JSONL）*/
  workEventSvc!: WorkEventService;
  /** Stats: Work Event Reader（用于统计功能）*/
  workEventReader!: WorkEventReader;
  public vaultSvc!: VaultService;
  public journalSvc!: JournalService;
  private financeSummarySvc!: FinanceSummaryService;
  private noteNav!: NoteNavigator;

  /** 打开笔记并按行定位（Review 周报/月报子窗口等） */
  get noteNavigator(): NoteNavigator {
    return this.noteNav;
  }

  // Contacts Side Panel view is registered only when module is enabled (C1).
   protected _contactsViewRegistered: boolean = false;

  // Step C7: contact link popover in Reading/Preview
  public _contactLinkPopoverEl: HTMLElement | null = null;
  public _contactLinkPopoverCleanup: (() => void) | null = null;

  // Contacts index service (scan + local JSON cache)
  contactsIndex!: ContactsIndexService;

  // ✅ Spaces Index Service (维护 spaces-index.json)
  private spacesIndexService!: SpacesIndexService;


  // Task/Memo rslatte service (index + sync + archiving)
  taskRSLatte!: TaskRSLatteService;

  // Project manager service (index + create + actions)
  projectMgr!: ProjectManagerService;

  // Output manager service (central index for output docs)
  outputRSLatte!: OutputRSLatteService;

  // 打卡/财务记录中央索引（可 DB 同步 + 索引归档）
  recordRSLatte!: RecordRSLatteService;

  // PipelineEngine（主路径：侧栏/coordinator -> runE2；legacy engine.run 仅兼容）
  pipelineEngine!: PipelineEngine;

  /** D1: coordinator 驱动 timer 的模块级自动刷新/自动归档调度 */
  protected _autoRefreshCoordinator: AutoRefreshCoordinator | null = null;

  /** engine 共享的模块启用判定（coordinator 模块关闭不调用）*/
  protected _pipelineIsEnabled: ((moduleKey: RSLatteModuleKey) => boolean) | null = null;

  /** D1: coordinator 需要枚举模块顺序 */
  protected _pipelineRegistry: ModuleRegistry | null = null;

  /** Step E1：供 View 层绑定disabled 的统一模块开关（Engine 一致） */
  public isPipelineModuleEnabled(moduleKey: RSLatteModuleKey): boolean {
    try {
      const fn = (this as any)?._pipelineIsEnabled;
      if (typeof fn === "function") return fn(moduleKey) !== false;
      return buildPipelineModuleIsEnabled(this as any)(moduleKey) !== false;
    } catch {
      return false;
    }
  }

  /** 初始化环境检查已确认且当前强制项均通过时，业务模块才按设置启用 */
  public isPluginEnvInitModuleGateOpen(): boolean {
    return arePluginModulesUnlocked(this.app, this);
  }

  /** 仅当核心插件「工作区」启用时显示「一键载入内置工作区」ribbon */
  protected _rslatteWorkspaceLayoutRibbonEl: HTMLElement | null = null;
  protected _rslatteWorkspaceRibbonPollLast: boolean = false;

  protected _lastListsSyncKey: string = "";
  protected _debouncedSyncListsToDb: (() => void) | null = null;


  // Step4：自动刷新索引 + 可 DB 同步
  protected _autoRefreshTimer: number | null = null;
  protected _autoRefreshTickRunning: boolean = false;

  // Step4：手动刷新归档互斥（打卡/财务 record 模块）
  protected _manualRecordRefreshRunning: boolean = false;
  protected _manualRecordArchiveRunning: boolean = false;

  // Step4：输出管理（Output）自动/手动操作互斥
  protected _outputOpInFlight: boolean = false;
  protected _outputOpOwner: "auto" | "manual" | null = null;


  /**
   * 最近一次 DB 同步状态（仅内存，用于侧边栏状态灯提示）
   * - Step6-5.5.1：task/memo 拆分独立指标
   */
  protected _dbSyncMeta: Partial<Record<
    DbSyncModuleKey,
    {
      status: "ok" | "pending" | "error" | "off";
      at?: string;
      err?: string;
      pendingCount?: number;
      failedCount?: number;
    }
  >> = {};

  /** DB Sync 状态灯模块 key（v6-3b：record 拆分为 checkin/finance；v6-5.5：task/memo 拆分）*/
  // @ts-ignore - Reserved for future use
  private static readonly DB_SYNC_KEYS = [
    "record",
    "checkin",
    "finance",
    "health",
    "knowledge",
    "task",
    "memo",
    "output",
    "project",
    "contacts",
  ] as const;
  // 财务汇总缓存（事实来源：DB /stats）
  protected _financeSummaryKey: string = ""; // as_of
  protected _financeSummaryFetchedAt: number = 0;
  protected _financeSummary: {
    monthIncome: number;
    monthExpense: number;
    yearIncome: number;
    yearExpense: number;
  } | null = null;

  // 今日打卡记录缓存（事实来源：DB）
  protected _todayCheckinsKey: string = "";
  protected _todayCheckinsFetchedAt: number = 0;
  protected _todayCheckinsMap: Map<string, ApiCheckinRecord> = new Map();

  // 今日财务记录缓存（事实来源：DB 或本地索引）；同分类可多条（entry_id 区分）
  protected _todayFinancesKey: string = "";
  protected _todayFinancesFetchedAt: number = 0;
  protected _todayFinancesMap: Map<string, ApiFinanceRecord[]> = new Map();

  // 今日日志子窗口预览缓存（用于一次渲染里避免重复读文件）
  protected _todayPanelPreviewKey: string = "";
  protected _todayPanelPreviewFetchedAt: number = 0;
  protected _todayPanelPreview: Record<string, string> = {};

  /** 后端 DB 可用性缓存（用于状态灯：DB sync 开启但后端不可用时标红*/
  protected _backendDbReady: boolean | null = null;
  protected _backendDbReason: string = "";
  protected _backendDbCheckedAt: number = 0;

  // 状态栏空间名称显示项
  private _spaceStatusBarItem: HTMLElement | null = null;

  async onload() {
    // 应用所有拆分的模块
    Object.assign(this, createAllModules(this));

    // debug log bootstrap
    if (this.isDebugLogEnabled()) this.dbg("plugin", "onload", { version: this.manifest.version });

    // services that don't depend on loaded settings
    this.settingsSvc = new SettingsService(this, DEFAULT_SETTINGS);

    const rawPluginData = await this.loadData();
    this.settings = await this.settingsSvc.load();

    // Step F0：space schema migration (default space + currentSpaceId)
    try {
      await migrateSpacesIfNeeded(this.settings, (s) => this.settingsSvc.saveRaw(s));
    } catch (e) {
      console.warn("RSLatte migrateSpacesIfNeeded failed", e);
      // best-effort: ensure runtime has sane values
      try {
        (this.settings as any).spaces = (this.settings as any).spaces || { [DEFAULT_SPACE_ID]: { id: DEFAULT_SPACE_ID, name: "默认空间" } };
        (this.settings as any).currentSpaceId = (this.settings as any).currentSpaceId || DEFAULT_SPACE_ID;
      } catch {}
    }

    // Step S1: print UI stats whitelist (debug only)
    this.dbg("ui", "UI_STATS_WHITELIST", UI_STATS_WHITELIST);


    // v24: outputPanel 新增了多个字段；由于 SettingsService 是浅合并，需在这里补齐默认字段
    try {
      const defOp: any = (DEFAULT_SETTINGS as any).outputPanel ?? {};
      const curOp: any = (this.settings as any).outputPanel ?? {};
      (this.settings as any).outputPanel = Object.assign({}, defOp, curOp);
      if (!Array.isArray((this.settings as any).outputPanel.templates)) {
        (this.settings as any).outputPanel.templates = [];
      }
      if (!Array.isArray((this.settings as any).outputPanel.archiveRoots)) {
        (this.settings as any).outputPanel.archiveRoots = [];
      }
      const op: any = (this.settings as any).outputPanel;
      op.templateCreateCounts = { ...(defOp.templateCreateCounts ?? {}), ...(op.templateCreateCounts ?? {}) };
      if (typeof op.listFilterShowGeneral !== "boolean") op.listFilterShowGeneral = defOp.listFilterShowGeneral !== false;
      if (typeof op.listFilterShowProject !== "boolean") op.listFilterShowProject = defOp.listFilterShowProject !== false;
      if (!Array.isArray(op.createOutputExtraFields)) op.createOutputExtraFields = [];
      if (op.sidePanelMainTab !== "list" && op.sidePanelMainTab !== "knowledge_publish") {
        op.sidePanelMainTab = defOp.sidePanelMainTab ?? "list";
      }
      for (const tpl of op.templates ?? []) {
        try {
          normalizeOutputTemplateDef(tpl);
        } catch {
          // ignore
        }
      }
      // showStatuses 已移除：侧边栏现在按三个清单（进行中/已完成/取消）分类显示所有状态
    } catch (e) {
      console.warn("RSLatte outputPanel defaults merge failed", e);
    }

    try {
      const defKp: any = (DEFAULT_SETTINGS as any).knowledgePanel ?? {};
      const curKp: any = (this.settings as any).knowledgePanel ?? {};
      const mergedKp = { ...defKp, ...curKp };
      if (!Array.isArray(mergedKp.secondarySubdirs)) {
        mergedKp.secondarySubdirs = DEFAULT_KNOWLEDGE_SECONDARY_SUBDIRS.map((r) => ({ ...r }));
      }
      if (!mergedKp.legacyDefaultSubdirsPruned2026) {
        mergedKp.secondarySubdirs = withoutRemovedLegacyKnowledgeSubdirs(mergedKp.secondarySubdirs);
        mergedKp.legacyDefaultSubdirsPruned2026 = true;
      }
      (this.settings as any).knowledgePanel = mergedKp;
    } catch (e) {
      console.warn("RSLatte knowledgePanel defaults merge failed", e);
    }

    
    // v6-2：checkinPanel / financePanel / moduleEnabledV2 新增字段（SettingsService 为浅合并，需补齐默认字段 + 兼容旧配置）
    try {
      const s: any = this.settings as any;

      // 新库首次安装：须先在「插件初始化环境检查」中完成确认后业务模块才生效；已有 data.json 且无此键的升级用户视为已放行
      {
        const rawObj = rawPluginData != null && typeof rawPluginData === "object" ? (rawPluginData as object) : null;
        if (!rawObj || !("pluginEnvInitGateCompleted" in rawObj)) {
          const keys = rawObj ? Object.keys(rawObj) : [];
          s.pluginEnvInitGateCompleted = keys.length > 0;
        }
      }

      // moduleEnabledV2
      const defME2: any = (DEFAULT_SETTINGS as any).moduleEnabledV2 ?? {};
      const curME2: any = s.moduleEnabledV2 ?? {};
      s.moduleEnabledV2 = Object.assign({}, defME2, curME2);

      // 兼容旧：moduleEnabled.record/task/... -> v2
      const meOld: any = s.moduleEnabled ?? {};
      if (s.moduleEnabledV2.checkin === undefined) s.moduleEnabledV2.checkin = meOld.record ?? true;
      if (s.moduleEnabledV2.finance === undefined) s.moduleEnabledV2.finance = meOld.record ?? true;
      if (s.moduleEnabledV2.task === undefined) s.moduleEnabledV2.task = meOld.task ?? true;
      if (s.moduleEnabledV2.memo === undefined) s.moduleEnabledV2.memo = meOld.task ?? true;
      if (s.moduleEnabledV2.schedule === undefined) s.moduleEnabledV2.schedule = s.moduleEnabledV2.memo ?? true;
      if (s.moduleEnabledV2.project === undefined) s.moduleEnabledV2.project = meOld.project ?? true;
      if (s.moduleEnabledV2.output === undefined) s.moduleEnabledV2.output = meOld.output ?? true;
      if (s.moduleEnabledV2.journal === undefined) s.moduleEnabledV2.journal = true;
      if (s.moduleEnabledV2.health === undefined) s.moduleEnabledV2.health = true;

      // checkinPanel / financePanel
      const defCk: any = (DEFAULT_SETTINGS as any).checkinPanel ?? {};
      const curCk: any = s.checkinPanel ?? {};
      s.checkinPanel = Object.assign({}, defCk, curCk);

      const defFi: any = (DEFAULT_SETTINGS as any).financePanel ?? {};
      const curFi: any = s.financePanel ?? {};
      s.financePanel = Object.assign({}, defFi, curFi);

      // 兼容旧：统一配置表（record）
      if (s.checkinPanel.enableDbSync === undefined) s.checkinPanel.enableDbSync = (s.rslattePanelEnableDbSync ?? true);
      if (s.checkinPanel.autoArchiveEnabled === undefined) s.checkinPanel.autoArchiveEnabled = (s.rslattePanelAutoArchiveEnabled ?? false);
      if (s.checkinPanel.archiveThresholdDays === undefined) s.checkinPanel.archiveThresholdDays = (s.rslattePanelArchiveThresholdDays ?? 90);

      if (s.financePanel.enableDbSync === undefined) s.financePanel.enableDbSync = (s.rslattePanelEnableDbSync ?? true);
      if (s.financePanel.autoArchiveEnabled === undefined) s.financePanel.autoArchiveEnabled = (s.rslattePanelAutoArchiveEnabled ?? false);
      if (s.financePanel.archiveThresholdDays === undefined) s.financePanel.archiveThresholdDays = (s.rslattePanelArchiveThresholdDays ?? 90);

      const defHp: any = (DEFAULT_SETTINGS as any).healthPanel ?? {};
      const curHp: any = s.healthPanel ?? {};
      s.healthPanel = Object.assign({}, defHp, curHp);
      if (s.healthPanel.enableDbSync === undefined) s.healthPanel.enableDbSync = s.rslattePanelEnableDbSync ?? false;
      if (s.healthPanel.autoArchiveEnabled === undefined) s.healthPanel.autoArchiveEnabled = s.rslattePanelAutoArchiveEnabled ?? true;
      if (s.healthPanel.archiveThresholdDays === undefined) s.healthPanel.archiveThresholdDays = s.rslattePanelArchiveThresholdDays ?? 90;
      if (s.healthPanel.waterCupVolumeMl === undefined) s.healthPanel.waterCupVolumeMl = (defHp as any).waterCupVolumeMl ?? 500;

      // 健康：日记追加规则（旧库可能无此项，否则 appendJournalByModule("health") 静默失败）
      const jRules: any[] = Array.isArray(s.journalAppendRules) ? s.journalAppendRules : (s.journalAppendRules = []);
      if (!jRules.some((r) => r?.module === "health")) {
        jRules.push({ module: "health", enabled: true, h1: "# 操作日志", h2: "## 健康记录" });
      }

      // v6-4：taskModule / memoModule（仅设置拆分；运行仍然以 taskPanel 为统一入口）
      const defTM: any = (DEFAULT_SETTINGS as any).taskModule ?? {};
      const curTM: any = s.taskModule ?? {};
      s.taskModule = Object.assign({}, defTM, curTM);

      const defMM: any = (DEFAULT_SETTINGS as any).memoModule ?? {};
      const curMM: any = s.memoModule ?? {};
      s.memoModule = Object.assign({}, defMM, curMM);
      const defSM: any = (DEFAULT_SETTINGS as any).scheduleModule ?? {};
      const curSM: any = s.scheduleModule ?? {};
      s.scheduleModule = Object.assign({}, defSM, curSM);
      if (!Array.isArray(s.scheduleModule.scheduleCategoryDefs) || s.scheduleModule.scheduleCategoryDefs.length === 0) {
        s.scheduleModule.scheduleCategoryDefs = JSON.parse(JSON.stringify(defSM.scheduleCategoryDefs ?? []));
      }
      if (!String(s.scheduleModule.defaultScheduleCategoryId ?? "").trim()) {
        s.scheduleModule.defaultScheduleCategoryId = defSM.defaultScheduleCategoryId ?? "meeting";
      }

      // vC1：contactsModule（仅设置拆分；运行暂不依赖）
      const defCM: any = (DEFAULT_SETTINGS as any).contactsModule ?? {};
      const curCM: any = s.contactsModule ?? {};
      s.contactsModule = Object.assign({}, defCM, curCM);

      // 兼容旧：taskPanel 的统一配置
      const legacyTaskEnableDb = (s.taskPanel?.enableDbSync ?? true);
      const legacyTaskAutoArc = (s.taskPanel?.autoArchiveEnabled ?? true);
      const legacyTaskDays = (s.taskPanel?.archiveThresholdDays ?? 90);
      const legacyTaskArcKey = (s.taskPanel?.archiveLastRunKey ?? "");

      if (s.taskModule.enableDbSync === undefined) s.taskModule.enableDbSync = legacyTaskEnableDb;
      if (s.taskModule.autoArchiveEnabled === undefined) s.taskModule.autoArchiveEnabled = legacyTaskAutoArc;
      if (s.taskModule.archiveThresholdDays === undefined) s.taskModule.archiveThresholdDays = legacyTaskDays;

      if (s.memoModule.enableDbSync === undefined) s.memoModule.enableDbSync = legacyTaskEnableDb;
      if (s.memoModule.autoArchiveEnabled === undefined) s.memoModule.autoArchiveEnabled = legacyTaskAutoArc;
      if (s.memoModule.archiveThresholdDays === undefined) s.memoModule.archiveThresholdDays = legacyTaskDays;
      if (s.scheduleModule.enableDbSync === undefined) s.scheduleModule.enableDbSync = legacyTaskEnableDb;
      if (s.scheduleModule.autoArchiveEnabled === undefined) s.scheduleModule.autoArchiveEnabled = legacyTaskAutoArc;
      if (s.scheduleModule.archiveThresholdDays === undefined) s.scheduleModule.archiveThresholdDays = legacyTaskDays;

      // v6-5：预留字段（暂不影响运行逻辑；仅用于后续“任务提醒独立 autoArchive/增量刷新”）
      if (s.taskModule.archiveLastRunKey === undefined) s.taskModule.archiveLastRunKey = legacyTaskArcKey;
      if (s.memoModule.archiveLastRunKey === undefined) s.memoModule.archiveLastRunKey = legacyTaskArcKey;
      if (s.scheduleModule.archiveLastRunKey === undefined) s.scheduleModule.archiveLastRunKey = legacyTaskArcKey;
      if (s.taskModule.lastDiaryScanMs === undefined) s.taskModule.lastDiaryScanMs = 0;
      if (s.memoModule.lastDiaryScanMs === undefined) s.memoModule.lastDiaryScanMs = 0;
      if (s.scheduleModule.lastDiaryScanMs === undefined) s.scheduleModule.lastDiaryScanMs = 0;

      clampModuleArchiveThresholdsInSettings(s);
    } catch (e) {
      console.warn("RSLatte checkin/finance panel defaults merge failed", e);
    }

    // 项目管理侧栏 projectPanel 深合并（第九节）
    try {
      const s: any = this.settings as any;
      const defPp: any = (DEFAULT_SETTINGS as any).projectPanel ?? {};
      const curPp: any = s.projectPanel ?? {};
      s.projectPanel = Object.assign({}, defPp, curPp);
      // 每次启动 Obsidian：默认打开「项目清单」页签（非「项目进度管理」）；同一会话内的页签状态仍写入 settings，在视图未卸载时保留
      s.projectPanel.mainTab = "list";
      await this.settingsSvc.saveRaw(this.settings);
    } catch (e) {
      console.warn("RSLatte projectPanel defaults merge failed", e);
    }

// v25：统一中央索引目录（四个模块共用）
    // - 新增 settings.centralIndexDir
    // - 兼容旧字段：taskPanel.rslatteIndexDir / projectRSLatteIndexDir / outputPanel.rslatteIndexDir / rslattePanelIndexDir
    // - 统一后：所有模块默认读 centralIndexDir（或经由 taskPanel.rslatteIndexDir 回退）
    try {
      const s: any = this.settings as any;
      const pick = (...vals: any[]) => {
        for (const v of vals) {
          const str = String(v ?? "").trim();
          if (str) return str;
        }
        return "";
      };
      const resolved = pick(
        s.centralIndexDir,
        s.taskPanel?.rslatteIndexDir,
        s.projectRSLatteIndexDir,
        s.outputPanel?.rslatteIndexDir,
        s.rslattePanelIndexDir,
        "00-System/.rslatte"
      );
      if (!String(s.centralIndexDir ?? "").trim()) s.centralIndexDir = resolved;

      // 同步写回旧字段，保证旧代码回退逻辑一致      
      if (s.taskPanel) s.taskPanel.rslatteIndexDir = resolved;
      s.projectRSLatteIndexDir = resolved;
      if (s.outputPanel) s.outputPanel.rslatteIndexDir = resolved;
      s.rslattePanelIndexDir = resolved;
    } catch (e) {
      console.warn("RSLatte centralIndexDir migration failed", e);
    }

    this.api = new RSLatteApiClient(this.settings.apiBaseUrl);
    try {
      const tok = String((this.settings as any)?.apiAuthAccessToken ?? "").trim();
      this.api.setAuthToken(tok || null);
    } catch {
      this.api.setAuthToken(null);
    }
    this.api.setAuthRefreshSupport({
      getCredentials: () => {
        const s: any = this.settings as any;
        const u = String(s?.apiBackendUserName ?? "").trim();
        const p = String(s?.apiBackendPassword ?? "");
        if (!u || !p) return null;
        return { userName: u, password: p };
      },
      persistAccessToken: async (token: string) => {
        const s: any = this.settings as any;
        const t = String(token ?? "").trim();
        if (!t || String(s?.apiAuthAccessToken ?? "").trim() === t) return;
        s.apiAuthAccessToken = t;
        await this.saveSettings();
      },
    });
    // Step F4: always attach space scope header (X-Space-Id)
    try {
      this.api.setSpaceId(this.getCurrentSpaceId());
    } catch {
      // ignore
    }

    this.auditSvc = new AuditService(this.app, this.manifest.id, this.manifest.version);

    // Work Event Stream（统计用“工作事件流”，失败不阻断）
    this.workEventSvc = new WorkEventService(this.app, () => this.settings, this.auditSvc);
    // 初始化统计服务
    this.workEventReader = new WorkEventReader(this.app, this.settings);

    try {
      await this.workEventSvc.ensureReady();
    } catch {
      // ignore
    }

    // services that depend on settings
    this.journalSvc = new JournalService(this.app, this.settings, this.auditSvc);
    this.financeSummarySvc = new FinanceSummaryService(this.app, this.journalSvc, () => this.getTodayKey());
    this.noteNav = new NoteNavigator(this.app);

    // Contacts (C2): local index + cache
    this.contactsIndex = new ContactsIndexService(
      this.app,
      () => {
        const sAny: any = this.settings as any;
        return String(sAny?.contactsModule?.contactsDir ?? "90-Contacts");
      },
      () => {
        const sAny: any = this.settings as any;
        const cd = String(sAny?.contactsModule?.contactsDir ?? "90-Contacts");
        const defArc = `${cd}/_archived`;
        return String(sAny?.contactsModule?.archiveDir ?? defArc);
      },
      // F2: bucket by space -> contacts interactions/index live under <centralRoot>/<spaceId>/index
      () => this.getSpaceIndexDir(),
      () => {
        const cm: any = (this.settings as any)?.contactsModule ?? {};
        return {
          trim: {
            maxPerContact: Math.max(10, Math.min(5000, Number(cm.interactionEventsMaxPerContactInIndex ?? 100) || 100)),
            maxPerSource: Math.max(1, Math.min(500, Number(cm.interactionEventsMaxPerSourcePerContact ?? 10) || 10)),
          },
          archiveShardMaxBytes: Math.max(4096, Math.min(20 * 1024 * 1024, Number(cm.contactInteractionArchiveShardMaxBytes ?? 1048576) || 1048576)),
          refreshContactNoteDynamicBlocksForUids: (uids: string[]) => this.refreshContactNoteDynamicBlockForUids(uids),
          syncContactsIndexLastInteractionAtForUids: (uids: string[]) =>
            this.contactsIndex.syncLastInteractionAtForContactUids(uids),
          rebuildTaskProjectInteractionEventsFromWork: (entries) =>
            rebuildTaskProjectInteractionEventsFromWorkEvents(this.workEventSvc, entries),
        };
      },
      () => (this.settings as any)?.taskPanel as TaskPanelSettings | undefined
    );

    // Step0: ensure contacts-interactions index exists (best-effort, never block plugin load)
    try {
      await this.contactsIndex.ensureInteractionsIndexReady();
    } catch (e) {
      console.warn("ContactsInteractions index ensure failed", e);
    }

    // ✅ Initialize Spaces Index Service and update index file
    this.spacesIndexService = new SpacesIndexService(this.app, () => this.settings);
    try {
      await this.spacesIndexService.updateIndex();
    } catch (e) {
      console.warn("RSLatte spaces-index.json update failed on load", e);
    }


    this.vaultSvc = new VaultService(
      {
        settings: this.settings,
        api: this.api,
        refreshSidePanel: () => this.refreshSidePanel(),
        isPluginEnvInitModuleGateOpen: () => this.isPluginEnvInitModuleGateOpen(),
        setBackendDbReady: (ready: boolean, reason?: string) => this.setBackendDbReady(ready, reason),
        getVaultSyncPayload: () => ({
          vault_name: this.app.vault.getName(),
          spaces: (this as any).listSpaces?.()?.map((s: RSLatteSpaceConfig) => ({ space_id: s.id, space_name: s.name ?? null, is_active: true })) ?? [],
        }),
      },
      this.settingsSvc,
      this.auditSvc
    );

    // Task/Memo rslatte
    this.taskRSLatte = new TaskRSLatteService({
      app: this.app,
      api: this.api,
      settingsRef: () => this.settings,
      saveSettings: async () => this.saveSettings(),
      journalSvc: this.journalSvc,
      refreshSidePanel: () => this.refreshSidePanel(),
      workEventSvc: this.workEventSvc,
      // Step6-5.5.1：task/memo 拆分指标
      // 这里reportDbSync 主要用于 flush 的硬错误/整体成功提示；按“最保守策略”同时更新task/memo
      reportDbSync: (ok: boolean, err?: string) => {
        this.markDbSync("task", ok, err);
        this.markDbSync("memo", ok, err);
      },
      reportDbSyncWithCounts: (moduleKey: "task" | "memo", meta: { pendingCount?: number; failedCount?: number; ok?: boolean; err?: string }) =>
        this.markDbSyncWithCounts(moduleKey, meta),
    });

    // Project manager
    this.projectMgr = new ProjectManagerService({
      app: this.app,
      api: this.api,
      settingsRef: () => this.settings,
      saveSettings: async () => this.saveSettings(),
      refreshSidePanel: () => this.refreshSidePanel(),
      workEventSvc: this.workEventSvc,
      // 状态灯：project 模块同步状态（pending/failed/ok     
      reportDbSyncWithCounts: (meta: { pendingCount?: number; failedCount?: number; ok?: boolean; err?: string }) =>
        this.markDbSyncWithCounts("project", meta),
      getPluginVersion: () => String(this.manifest?.version ?? "0.0.1"),
    });

    // Output manager (central index over archive roots)
    this.outputRSLatte = new OutputRSLatteService({
      app: this.app,
      settingsRef: () => this.settings,
      refreshSidePanel: () => this.refreshSidePanel(),
      workEventSvc: this.workEventSvc,
      ledgerPluginRef: () => this,
      syncOutputToDbBestEffort: async (reason) => {
        const enableDbSync = !!this.settings.outputPanel?.enableDbSync;
        if (enableDbSync) await this.syncOutputFilesToDb({ reason });
        else await ((this as any).writeTodayOutputProgressToJournalFromIndex?.() ?? Promise.resolve());
      },
    });

    registerKnowledgeOutputUpdatedLedgerHook(this);

    // Record rslatte (checkin/finance central index + optional archive)
    this.recordRSLatte = new RecordRSLatteService({
      app: this.app,
      settingsRef: () => this.settings,
      saveSettings: async () => { await this.saveSettings(); },
      getTodayKey: () => this.getTodayKey(),
    });

    // Step B1：SidePanel 按钮入口统一Engine（spec bridge 保持旧行为）
    this.pipelineEngine = this.createPipelineEngine();
    // D1: 初始化coordinator（timer tick 仅调用coordinator.tick    
    this.ensureAutoRefreshCoordinator();

    // v26：彻底统一刷新机制
    // - 旧版 Refresh Interval (seconds) 已废弃（原用于侧边栏 timer / 项目内部 timer    
    // - 统一迁移autoRefreshIndexIntervalMin（分钟）
    await this.migrateRefreshIntervalToAutoRefreshIfNeeded();

    // 自动同步“打卡项清单/财务分类清单”到数据库（替代设置页手动按钮）
    this._debouncedSyncListsToDb = debounce(() => {
      void this.syncRecordListsToDb().catch((e) => {
        console.warn("RSLatte syncRecordListsToDb failed:", e);
      });
    }, 1200);

    // view + settings
    // Register views and settings tab as early as possible so UI stays usable even if API init fails.
    this.registerView(VIEW_TYPE_RSLATTE, (leaf) => new RSLatteSidePanelView(leaf, this));
    this.registerView(VIEW_TYPE_TASKS, (leaf) => new TaskSidePanelView(leaf, this));
    this.registerView(VIEW_TYPE_SCHEDULE, (leaf) => new TaskSidePanelView(leaf, this));
    this.registerView(VIEW_TYPE_PROJECTS, (leaf) => new ProjectSidePanelView(leaf, this));
    this.registerView(VIEW_TYPE_OUTPUTS, (leaf) => new OutputSidePanelView(leaf, this));
    this.registerView(VIEW_TYPE_FINANCE, (leaf) => new FinanceSidePanelView(leaf, this));
    this.registerView(VIEW_TYPE_HEALTH, (leaf) => new HealthSidePanelView(leaf, this));
    this.registerView(VIEW_TYPE_CHECKIN, (leaf) => new CheckinSidePanelView(leaf, this));
    this.registerView(VIEW_TYPE_HUB, (leaf) => new SpaceHubView(leaf, this));
    this.registerView(VIEW_TYPE_TIMELINE, (leaf) => new TimelineView(leaf, this));
    this.registerView(VIEW_TYPE_CALENDAR, (leaf) => new CalendarView(leaf, this));
    this.registerView(VIEW_TYPE_CAPTURE, (leaf) => new CaptureView(leaf, this));
    this.registerView(VIEW_TYPE_TODAY, (leaf) => new TodayView(leaf, this));
    this.registerView(VIEW_TYPE_KNOWLEDGE, (leaf) => new KnowledgeView(leaf, this));
    this.registerView(VIEW_TYPE_KNOWLEDGE_PANEL, (leaf) => new KnowledgeView(leaf, this, "sidepanel"));
    this.registerView(VIEW_TYPE_REVIEW, (leaf) => new ReviewView(leaf, this));
    // Contacts（C1）默认关闭：仅在开启时才注册视图，避免vault “undefined=enabled误开启   
    // 始终注册联系人视图，即使模块关闭也保持侧边栏可用
    // 侧边栏内容会在模块未启用时显示"联系人模块未启用"提示
    this.ensureContactsPanelRegistered();
    this.addSettingTab(new RSLatteSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      try {
        if (!this.isPluginEnvInitModuleGateOpen()) {
          const sAny: any = this.settings as any;
          const needInit = sAny.pluginEnvInitGateCompleted !== true;
          new Notice(
            needInit
              ? "RSLatte：请先打开 设置 → RSLatte → 全局配置 → 插件初始化环境检查，Obsidian 强制项、全部目录与模板强制项均通过后点击「完成初始化」。完成前业务模块均不会启用。"
              : "RSLatte：当前仍有强制环境项未满足（Obsidian「文件与链接」、必选目录、模板或人工确认项等），业务模块已暂停。请修复后在「插件初始化环境检查」中重新检测或再次完成初始化。",
            20000,
          );
        }
      } catch (e) {
        console.warn("[RSLatte] blocking env check notice failed", e);
      }
      this.syncRslatteWorkspaceLayoutRibbon();
    });

    // Step F1: Global Space switcher (Ribbon + command)
    try {
      this.addRibbonIcon(
        "layers",
        `RSLatte: Switch Space (Current: ${this.getSpaceConfig()?.name ?? this.getCurrentSpaceId()})`,
        () => this.openSpaceSwitcher()
      );
    } catch (e) {
      console.warn("[RSLatte][space] addRibbonIcon failed", e);
    }

    this.addCommand({
      id: "rslatte-space-switch",
      name: "RSLatte: Switch Space",
      callback: () => this.openSpaceSwitcher(),
    });

    // ✅ 状态栏显示当前空间名称（点击可切换）
    try {
      this._spaceStatusBarItem = this.addStatusBarItem();
      this.updateSpaceStatusBar();
      // 点击状态栏项时切换空间
      this._spaceStatusBarItem.addEventListener("click", () => {
        this.openSpaceSwitcher();
      });
      this._spaceStatusBarItem.style.cursor = "pointer";
      this._spaceStatusBarItem.title = "点击切换空间";
      
      // 添加刷新按钮到状态栏
      const refreshStatusBarItem = this.addStatusBarItem();
      refreshStatusBarItem.createEl("span", { text: "🔄", cls: "rslatte-status-bar-refresh-icon" });
      refreshStatusBarItem.style.cursor = "pointer";
      refreshStatusBarItem.style.marginLeft = "8px";
      refreshStatusBarItem.title = "刷新所有模块";
      refreshStatusBarItem.addEventListener("click", async () => {
        await this.refreshAllModules();
      });
      
      // 监听空间切换事件，更新状态栏显示
      this.registerEvent(
        (this.app.workspace as any).on(RSLATTE_EVENT_SPACE_CHANGED, () => {
          this.updateSpaceStatusBar();
        })
      );
    } catch (e) {
      console.warn("[RSLatte][space] addStatusBarItem failed", e);
    }

    // Step F7: Global Hub overview (spaces grid)
    try {
      this.addRibbonIcon(
        "layout-dashboard",
        "打开 RSLatte工作台",
        () => void this.activateHubView()
      );
    } catch (e) {
      console.warn("[RSLatte][hub] addRibbonIcon failed", e);
    }

    try {
      const ip = (this.app as any).internalPlugins;
      if (ip && typeof ip.on === "function") {
        this.registerEvent(ip.on("change", () => this.syncRslatteWorkspaceLayoutRibbon()));
      }
    } catch (e) {
      console.warn("[RSLatte][workspace-layout] internalPlugins.on failed", e);
    }
    this.registerInterval(
      window.setInterval(() => {
        const on = isWorkspacesCorePluginEnabled(this.app);
        if (on !== this._rslatteWorkspaceRibbonPollLast) {
          this.syncRslatteWorkspaceLayoutRibbon();
        }
      }, 2000),
    );
    this.syncRslatteWorkspaceLayoutRibbon();

    this.addCommand({
      id: "rslatte-load-bundled-workspace",
      name: "载入 RSLatte 内置工作区布局",
      callback: () => void applyRslatteBundledWorkspaceLayout(this),
    });
    this.addCommand({
      id: "rslatte-clear-left-right-sidebars",
      name: "清空左右侧栏（关闭侧栏内所有视图，不载入四象限）",
      callback: () => void clearLeftRightSidebarsFromCommand(this),
    });

    this.addCommand({
      id: "rslatte-hub-open",
      name: "打开侧边栏：RSLatte工作台",
      callback: () => void this.activateHubView(),
    });

    this.addCommand({
      id: "rslatte-capture-open",
      name: "打开侧边栏：快速记录",
      callback: () => (this as any).activateWorkflowView?.("capture"),
    });

    this.addCommand({
      id: "rslatte-open-today-view",
      name: "打开侧边栏：今天",
      callback: () => (this as any).activateWorkflowView?.("today"),
    });

    this.addCommand({
      id: "rslatte-open-review-panel",
      name: "打开侧边栏：回顾",
      callback: () => this.activateReviewView(),
    });

    // Stats: 操作日志（原时间轴视图）
    this.addCommand({
      id: "rslatte-open-timeline",
      name: "打开侧边栏：操作日志",
      callback: () => void this.activateTimelineView(),
    });

    this.addCommand({
      id: "rslatte-open-calendar",
      name: "打开侧边栏：日程日历",
      callback: () => void this.activateCalendarView(),
    });

    // 注册工作台链接处理器
    this.registerObsidianProtocolHandler("rslatte-task", async (params) => {
      const uid = params.uid;
      if (uid) {
        await this.activateTaskView();
        // TODO: 在任务视图中定位到指定任务
      }
    });

    this.registerObsidianProtocolHandler("rslatte-output", async (params) => {
      const id = params.id;
      if (id) {
        await this.activateOutputView();
        // TODO: 在输出视图中定位到指定输出
      }
    });

    this.registerObsidianProtocolHandler("rslatte-project", async (params) => {
      const id = params.id;
      if (id) {
        await this.activateProjectView();
        // TODO: 在项目视图中定位到指定项目
      }
    });

    // 注册命令执行 URI 处理器（用于 Markdown 中的快捷方式）
    this.registerObsidianProtocolHandler("rslatte-command", async (params) => {
      const commandId = params.command || params.id;
      if (commandId && typeof commandId === "string") {
        try {
          // 方法1: 尝试使用 Obsidian 的命令执行 API
          if ((this.app as any).command?.executeCommandById) {
            await (this.app as any).command.executeCommandById(commandId);
            return;
          }
          
          // 方法2: 直接从命令注册表中查找并执行
          const commands = (this.app as any).commands;
          if (commands) {
            // 尝试从 commands.commands 中查找
            const command = commands.commands?.[commandId];
            if (command && command.callback) {
              await command.callback();
              return;
            }
            
            // 尝试从 commands.listCommands 的结果中查找
            const allCommands = commands.listCommands ? commands.listCommands() : [];
            const foundCommand = allCommands.find((cmd: any) => cmd.id === commandId);
            if (foundCommand && foundCommand.callback) {
              await foundCommand.callback();
              return;
            }
          }
          
          // 方法3: 如果是 RSLatte 自己的命令，直接调用对应的方法
          const commandMap: Record<string, () => void | Promise<void>> = {
            "rslatte-hub-open": () => this.activateHubView(),
            /** 旧 ID：命令面板已合并，此处保留供 URI/脚本等仍引用时可用 */
            "rslatte-dashboard-open": () => void this.activateHubView(),
            "rslatte-open-sidepanel": () => this.activateRSLatteView(),
            "rslatte-open-project-panel": () => this.activateProjectView(),
            "rslatte-open-taskpanel": () => this.activateTaskView(),
            "rslatte-open-output-panel": () => this.activateOutputView(),
            "rslatte-open-publish-panel": () => this.activateKnowledgeView(),
            "rslatte-open-finance-panel": () => this.activateFinanceView(),
            "rslatte-open-health-panel": () => this.activateHealthView(),
            "rslatte-open-checkin-panel": () => this.activateCheckinView(),
            "rslatte-open-contacts-panel": () => this.activateContactsView(),
            "rslatte-open-timeline": () => this.activateTimelineView(),
            "rslatte-open-today-view": () => (this as any).activateWorkflowView?.("today"),
            "rslatte-open-review-panel": () => this.activateReviewView(),
            "rslatte-open-calendar": () => this.activateCalendarView(),
            "rslatte-space-switch": () => this.openSpaceSwitcher(),
            "rslatte-open-settings": () => this.openSettings(),
            "rslatte-load-bundled-workspace": () => applyRslatteBundledWorkspaceLayout(this),
            /** 旧 ID：命令面板已合并，此处保留供 URI/脚本等仍引用该 ID 时可用 */
            "rslatte-apply-recommended-workspace": () => applyRslatteBundledWorkspaceLayout(this),
            "rslatte-clear-left-right-sidebars": () => void clearLeftRightSidebarsFromCommand(this),
          };
          
          const handler = commandMap[commandId];
          if (handler) {
            await handler();
            return;
          }
          
          console.warn(`[RSLatte] Command not found: ${commandId}`);
        } catch (e) {
          console.error(`[RSLatte] Failed to execute command: ${commandId}`, e);
        }
      }
    });

    // ✅ 注册模块跳转 URI 处理器（支持通过模块名称打开对应侧边栏）
    // 用法：obsidian://rslatte-open?module=今日打卡（仍兼容 module=今日检查）
    this.registerObsidianProtocolHandler("rslatte-open", async (params) => {
      const moduleName = params.module || params.name;
      if (moduleName && typeof moduleName === "string") {
        try {
          // 模块名称映射表（支持中文名称和英文名称）
          const moduleMap: Record<string, () => void | Promise<void>> = {
            // 中文名称
            "今日打卡": () => this.activateRSLatteView(),
            "今日检查": () => this.activateRSLatteView(),
            "0.今日打卡": () => this.activateRSLatteView(),
            "0.今日检查": () => this.activateRSLatteView(),
            "0. 今日打卡": () => this.activateRSLatteView(),
            "0. 今日检查": () => this.activateRSLatteView(),
            "任务管理": () => this.activateTaskView(),
            "1.任务管理": () => this.activateTaskView(),
            "1. 任务管理": () => this.activateTaskView(),
            "项目管理": () => this.activateProjectView(),
            "2.项目管理": () => this.activateProjectView(),
            "2. 项目管理": () => this.activateProjectView(),
            "输出管理": () => this.activateOutputView(),
            "发布管理": () => this.activateKnowledgeView(),
            "知识库": () => this.activateKnowledgeView(),
            "Knowledge": () => this.activateKnowledgeView(),
            "财务": () => this.activateFinanceView(),
            "健康": () => this.activateHealthView(),
            "打卡": () => this.activateCheckinView(),
            "联系人": () => this.activateContactsView(),
            "Hub": () => this.activateHubView(),
            "工作台": () => void this.activateHubView(),
            "时间轴": () => this.activateTimelineView(),
            "操作日志": () => this.activateTimelineView(),
            "今天": () => (this as any).activateWorkflowView?.("today"),
            "Today": () => (this as any).activateWorkflowView?.("today"),
            "今日执行": () => (this as any).activateWorkflowView?.("today"),
            "回顾": () => this.activateReviewView(),
            "Review": () => this.activateReviewView(),
            "快速记录": () => (this as any).activateWorkflowView?.("capture"),
            "Capture": () => (this as any).activateWorkflowView?.("capture"),
            "知识管理（工作台）": () => this.activateKnowledgeView(),
            // 以下兼容旧名称，均打开知识管理（工作台）
            "知识管理（阅览）": () => this.activateKnowledgeView(),
            "知识库阅览": () => this.activateKnowledgeView(),
            "日程日历": () => this.activateCalendarView(),
            "日历": () => this.activateCalendarView(),
            "设置": () => this.openSettings(),
            // 英文名称（兼容）
            "today-check": () => this.activateRSLatteView(),
            "task": () => this.activateTaskView(),
            "project": () => this.activateProjectView(),
            "output": () => this.activateOutputView(),
            "publish": () => this.activateKnowledgeView(),
            "knowledge": () => this.activateKnowledgeView(),
            "finance": () => this.activateFinanceView(),
            "health": () => this.activateHealthView(),
            "checkin": () => this.activateCheckinView(),
            "contacts": () => this.activateContactsView(),
            "hub": () => this.activateHubView(),
            "dashboard": () => void this.activateHubView(),
            "timeline": () => this.activateTimelineView(),
            "worklog": () => this.activateTimelineView(),
            "capture": () => (this as any).activateWorkflowView?.("capture"),
            "today": () => (this as any).activateWorkflowView?.("today"),
            "review": () => this.activateReviewView(),
            "calendar": () => this.activateCalendarView(),
            "settings": () => this.openSettings(),
          };
          
          const handler = moduleMap[moduleName];
          if (handler) {
            await handler();
            return;
          }
          
          console.warn(`[RSLatte] Module not found: ${moduleName}`);
        } catch (e) {
          console.error(`[RSLatte] Failed to open module: ${moduleName}`, e);
        }
      }
    });

    // vault ready：
    // - URL 未配置不合法 DB sync 全关：绝不触达后    
    // - URL 正常且任一模块开 DB sync：才会触发一次ensure/check
    // - 失败console.warn（节流）+ 标记后端不可用，不阻断启动   
    void this.vaultSvc.ensureVaultReadySafe("onload").catch(() => {
      // ensureVaultReadySafe should never throw; keep startup resilient.
    });

    // 启动时只做本地初始化（不访问后端），避免 URL 异常时刷红    
    // - 今日打卡/财务：从中央索引 hydrate
    // - 财务汇总：从日记正文统计（本地）    
    void this.hydrateTodayFromRecordIndex().catch((e) => {
      console.warn("RSLatte hydrateTodayFromRecordIndex failed:", e);
    });
    void this.refreshFinanceSummaryFromNotes(true, 0).catch((e) => {
      console.warn("RSLatte refreshFinanceSummaryFromNotes failed:", e);
    });

    // 迁移：旧 todayJumpHeadings -> journalPanels
    try {
      await migrateJumpHeadingsToPanelsIfNeeded(this.settings, async () => {
        await this.settingsSvc.saveRaw(this.settings);
      });
    } catch (e) {
      console.warn("RSLatte migration failed:", e);
    }

    // Run rslatte init in background (side panel renders can still call ensureReady()).
    void this.taskRSLatte
      .ensureReady()
            .catch((e) => console.warn("RSLatte taskRSLatte init failed:", e));

    void this.projectMgr
      .ensureReady()
            .catch((e) => console.warn("RSLatte projectMgr init failed:", e));

    void this.outputRSLatte
      .ensureReady()
            .catch((e) => console.warn("RSLatte outputRSLatte init failed:", e));

    void this.recordRSLatte
      .ensureReady()
            .catch((e) => console.warn("RSLatte recordRSLatte init failed:", e));

    // Step4：按设置调度自动增量刷新（增量索引更新DB sync 开启则增量同步   
    this.setupAutoRefreshTimer();

    // Command: Open RSLatte Side Panel
    this.addCommand({
      id: "rslatte-open-sidepanel",
      name: "打开侧边栏：今日打卡",
      callback: () => this.activateRSLatteView(),
    });

    this.addCommand({
      id: "rslatte-open-project-panel",
      name: "打开侧边栏：项目",
      callback: () => this.activateProjectView(),
    });

    this.addCommand({
      id: "rslatte-open-taskpanel",
      name: "打开侧边栏：任务",
      callback: () => this.activateTaskView(),
    });

    this.addCommand({
      id: "rslatte-open-output-panel",
      name: "打开侧边栏：输出",
      callback: () => this.activateOutputView(),
    });

    this.addCommand({
      id: "rslatte-open-publish-panel",
      name: "打开侧边栏：知识管理（工作台）",
      callback: () => this.activateKnowledgeView(),
    });

    this.addCommand({
      id: "rslatte-open-finance-panel",
      name: "打开侧边栏：财务",
      callback: () => this.activateFinanceView(),
    });

    this.addCommand({
      id: "rslatte-open-health-panel",
      name: "打开侧边栏：健康",
      callback: () => this.activateHealthView(),
    });

    this.addCommand({
      id: "rslatte-open-checkin-panel",
      name: "打开侧边栏：打卡",
      callback: () => this.activateCheckinView(),
    });

    this.addCommand({
      id: "rslatte-open-contacts-panel",
      name: "打开侧边栏：联系人",
      callback: () => this.activateContactsView(),
    });

    // Contacts: insert reference (C7 design: [[C_<uid>|Name]])
    this.addCommand({
      id: "rslatte-contacts-insert-reference",
      name: "插入联系人信息",
      callback: async () => {
        // Allow triggering from side panels: fallback to any existing markdown leaf.
        let view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) {
          const leaf = this.app.workspace.getLeavesOfType("markdown").find((l) => l?.view instanceof MarkdownView);
          view = (leaf?.view as any) ?? null;
        }
        if (!view) {
          new Notice("No active Markdown editor.");
          return;
        }

        await this.openContactReferencePicker((ref) => {
          try {
            view!.editor?.replaceSelection(ref);
          } catch (e) {
            console.warn("[RSLatte][contacts][insert] editor insert failed", e);
            new Notice("插入联系人引用失败");
          }
        });
      },
    });

    // Step C7: doc preview contact link popover (Reading/Preview MVP)
    this.setupContactsLinkPostProcessor();

    // ✅ 打开设置窗口命令
    this.addCommand({
      id: "rslatte-open-settings",
      name: "打开 RSLatte 设置",
      callback: () => this.openSettings(),
    });

  }

  onunload() {
        // 调用 core 模块的清理方法
    try { (this as any).cleanupOnUnload?.(); } catch { }
  }


  /** Step4：是否正在自动刷新 tick（全模块）*/
  public isAutoRefreshRunning(): boolean {
    return this._autoRefreshTickRunning;
  }

  /** Step4：record 模块是否正在执行手动操作（刷新归档）*/
  public isRecordManualBusy(): boolean {
    return this._manualRecordRefreshRunning || this._manualRecordArchiveRunning;
  }

  /**
   * Step4：尝试开启record 模块手动操作 * - 若自动刷新正在进行中：弹 Notice 并返false
   * - 若已有手动操作在执行：弹 Notice 并返false
   */
  public tryBeginRecordManualOp(op: "refresh" | "archive"): boolean {
    if (this.isAutoRefreshRunning()) {
      new Notice("自动刷新正在进行中，请稍后再试");
      return false;
    }
    if (this.isRecordManualBusy()) {
      new Notice("打卡/财务正在执行操作，请稍后再试");
      return false;
    }
    if (op === "refresh") this._manualRecordRefreshRunning = true;
    if (op === "archive") this._manualRecordArchiveRunning = true;
    return true;
  }

  /** Step4：record 模块手动操作 */
  public endRecordManualOp(op: "refresh" | "archive"): void {
    if (op === "refresh") this._manualRecordRefreshRunning = false;
    if (op === "archive") this._manualRecordArchiveRunning = false;
  }

  private isModuleEnabled(key: "record" | "task" | "project" | "output"): boolean {
    if (!this.isPluginEnvInitModuleGateOpen()) return false;
    const me: any = (this.settings as any)?.moduleEnabled ?? {};
    const v = me[key];
    return v === undefined ? true : Boolean(v);
  }


  private isTaskDbSyncEnabled(): boolean {
    const tp: any = (this.settings as any).taskPanel ?? {};
    const v = tp.enableDbSync;
    return v === undefined ? true : Boolean(v);
  }

  // ==========================
  // v6-5.1：任务提醒“拆分配置”的运行getter（本步仅提供能力，不改变现有行为
  // ==========================

  /** v6-5.1：任务模块是否启用（优先 moduleEnabledV2.task，fallback 到 moduleEnabled.task）*/
  isTaskModuleEnabledV2(): boolean {
    if (!this.isPluginEnvInitModuleGateOpen()) return false;
    const s: any = this.settings as any;
    const v2 = s?.moduleEnabledV2;
    if (typeof v2?.task === "boolean") return v2.task;
    const old = s?.moduleEnabled;
    if (typeof old?.task === "boolean") return old.task;
    return true;
  }

  /** v6-5.1：提醒模块是否启用（优先 moduleEnabledV2.memo，fallback 到 moduleEnabled.task）*/
  isMemoModuleEnabledV2(): boolean {
    if (!this.isPluginEnvInitModuleGateOpen()) return false;
    const s: any = this.settings as any;
    const v2 = s?.moduleEnabledV2;
    if (typeof v2?.memo === "boolean") return v2.memo;
    const old = s?.moduleEnabled;
    if (typeof old?.task === "boolean") return old.task;
    return true;
  }

  /** v6-5.1：任务模块 DB sync 是否启用（优先 taskModule.enableDbSync，fallback 到 taskPanel.enableDbSync）*/
  isTaskDbSyncEnabledV2(): boolean {
    if (!this.isTaskModuleEnabledV2()) return false;

    // D3: URL 为空/不合法 => 强制视为关闭（与设置页禁用逻辑一致）
    const apiBaseUrl = String((this.settings as any)?.apiBaseUrl ?? "").trim();
    if (!apiBaseUrl) return false;
    const lower = apiBaseUrl.toLowerCase();
    if (!(lower.startsWith("http://") || lower.startsWith("https://"))) return false;
    try {
      // eslint-disable-next-line no-new
      new URL(apiBaseUrl);
    } catch {
      return false;
    }

    const v = (this.settings as any)?.taskModule?.enableDbSync;
    if (typeof v === "boolean") return v;
    return this.isTaskDbSyncEnabled();
  }

  /** v6-5.1：提醒模块 DB sync 是否启用（优先 memoModule.enableDbSync，fallback 到 taskPanel.enableDbSync）*/
  isMemoDbSyncEnabledV2(): boolean {
    if (!this.isMemoModuleEnabledV2()) return false;

    // D3: URL 为空/不合法 => 强制视为关闭（与设置页禁用逻辑一致）
    const apiBaseUrl = String((this.settings as any)?.apiBaseUrl ?? "").trim();
    if (!apiBaseUrl) return false;
    const lower = apiBaseUrl.toLowerCase();
    if (!(lower.startsWith("http://") || lower.startsWith("https://"))) return false;
    try {
      // eslint-disable-next-line no-new
      new URL(apiBaseUrl);
    } catch {
      return false;
    }

    const v = (this.settings as any)?.memoModule?.enableDbSync;
    if (typeof v === "boolean") return v;
    return this.isTaskDbSyncEnabled();
  }

  /** 日程模块是否启用（moduleEnabledV2.schedule；undefined 视为开启） */
  isScheduleModuleEnabledV2(): boolean {
    if (!this.isPluginEnvInitModuleGateOpen()) return false;
    const s: any = this.settings as any;
    const v2 = s?.moduleEnabledV2;
    if (typeof v2?.schedule === "boolean") return v2.schedule;
    const old = s?.moduleEnabled;
    if (typeof old?.task === "boolean") return old.task;
    return true;
  }

  /** 日程 DB 同步（scheduleModule.enableDbSync；与任务/提醒拆分，合并写回仍反映在 taskPanel.enableDbSync） */
  isScheduleDbSyncEnabledV2(): boolean {
    if (!this.isScheduleModuleEnabledV2()) return false;

    const apiBaseUrl = String((this.settings as any)?.apiBaseUrl ?? "").trim();
    if (!apiBaseUrl) return false;
    const lower = apiBaseUrl.toLowerCase();
    if (!(lower.startsWith("http://") || lower.startsWith("https://"))) return false;
    try {
      // eslint-disable-next-line no-new
      new URL(apiBaseUrl);
    } catch {
      return false;
    }

    const v = (this.settings as any)?.scheduleModule?.enableDbSync;
    if (typeof v === "boolean") return v;
    return this.isTaskDbSyncEnabledV2();
  }


  /** v6-x：project 模块是否启用（优化moduleEnabledV2.project，fallback moduleEnabled.project*/

  /** vC1：contacts 模块是否启用（仅moduleEnabledV2.contacts；undefined 视为关闭，避免旧 vault 误开启） */
  isContactsModuleEnabledV2(): boolean {
    if (!this.isPluginEnvInitModuleGateOpen()) return false;
    const s: any = this.settings as any;
    const v2 = s?.moduleEnabledV2;
    return v2?.contacts === true;
  }

  /** vC1：contacts DB sync 是否启用 */
  isContactsDbSyncEnabledV2(): boolean {
    if (!this.isContactsModuleEnabledV2()) return false;

    // D3: URL 为空/不合法 => 强制视为关闭（与设置页禁用逻辑一致）
    const apiBaseUrl = String((this.settings as any)?.apiBaseUrl ?? "").trim();
    if (!apiBaseUrl) return false;
    const lower = apiBaseUrl.toLowerCase();
    if (!(lower.startsWith("http://") || lower.startsWith("https://"))) return false;
    try {
      // eslint-disable-next-line no-new
      new URL(apiBaseUrl);
    } catch {
      return false;
    }

    const v = (this.settings as any)?.contactsModule?.enableDbSync;
    return v === true;
  }

  isProjectModuleEnabledV2(): boolean {
    if (!this.isPluginEnvInitModuleGateOpen()) return false;
    const s: any = this.settings as any;
    const v2 = s?.moduleEnabledV2;
    if (typeof v2?.project === "boolean") return v2.project;
    const old = s?.moduleEnabled;
    if (typeof old?.project === "boolean") return old.project;
    return true;
  }

  /** project DB sync 是否启用（URL 为空/不合法时强制视为关闭）*/
  isProjectDbSyncEnabled(): boolean {
    if (!this.isProjectModuleEnabledV2()) return false;

    const apiBaseUrl = String((this.settings as any)?.apiBaseUrl ?? "").trim();
    if (!apiBaseUrl) return false;
    const lower = apiBaseUrl.toLowerCase();
    if (!(lower.startsWith("http://") || lower.startsWith("https://"))) return false;
    try {
      // eslint-disable-next-line no-new
      new URL(apiBaseUrl);
    } catch {
      return false;
    }

    const v = (this.settings as any)?.projectEnableDbSync;
    if (typeof v === "boolean") return v;
    return true;
  }

  private isOutputDbSyncEnabled(): boolean {
  if (!this.isPluginEnvInitModuleGateOpen()) return false;
  // output module enabled?
  const s: any = this.settings as any;
  const v2 = s?.moduleEnabledV2;
  if (typeof v2?.output === "boolean" && v2.output === false) return false;
  const oldEnabled = s?.moduleEnabled;
  if (typeof oldEnabled?.output === "boolean" && oldEnabled.output === false) return false;

  // URL must be checkable (http/https + parseable); otherwise force OFF
  const apiBaseUrl = String(s?.apiBaseUrl ?? "").trim();
  if (!apiBaseUrl) return false;
  const lower = apiBaseUrl.toLowerCase();
  if (!(lower.startsWith("http://") || lower.startsWith("https://"))) return false;
  try {
    // eslint-disable-next-line no-new
    new URL(apiBaseUrl);
  } catch {
    return false;
  }

  const op: any = s.outputPanel ?? {};
  return !!op.enableDbSync;
}

  /** 
   * 输出索引刷新模式
   * - active：只扫描活跃目录（不加载 done/cancelled 归档）
   * - full：加载 done/cancelled 归档（用于展开同步）
   * @deprecated 此函数当前未使用，保留以备将来使用
   */
  // @ts-ignore - Reserved for future use
  private getOutputIndexRefreshMode(): "active" | "full" {
    const op: any = (this.settings as any).outputPanel ?? {};
    if (!!op.enableDbSync) return "full";
    const st = (op.showStatuses ?? []) as any[];
    const hasArchived = st.some((s) => {
      const v = String(s ?? "").toLowerCase();
      return v === "done" || v === "cancelled";
    });
    return hasArchived ? "full" : "active";
  }

  // ==========================
  // Output op mutex (auto vs manual)
  // ==========================

  private async runOutputAutoOp(fn: () => Promise<void>): Promise<void> {
    // 若手动操作在进行中，则自动刷新归档直接跳过（静默）
    if (this._outputOpInFlight) return;
    this._outputOpInFlight = true;
    this._outputOpOwner = "auto";
    try {
      await fn();
    } finally {
      this._outputOpInFlight = false;
      this._outputOpOwner = null;
    }
  }

  public async runOutputManualOp(label: string, fn: () => Promise<void>): Promise<boolean> {
    // 自动刷新进行中：提示并退出    
    if (this._outputOpInFlight) {
      if (this._outputOpOwner === "auto") new Notice(`输出自动刷新正在进行中，${label}失败`);
      else new Notice(`输出${label}正在进行中`);
      return false;
    }
    this._outputOpInFlight = true;
    this._outputOpOwner = "manual";
    try {
      await fn();
      return true;
    } finally {
      this._outputOpInFlight = false;
      this._outputOpOwner = null;
    }
  }


  /** Side Panel 1：打卡财务是否启用 DB 同步（默认true）*/
  isRSLatteDbSyncEnabled(): boolean {
    // v6-3b：对外仍保留原函数语义：任一子模块开启同步即可视为“record DB sync enabled”
    // 兼容旧字典rslattePanelEnableDbSync    
    return this.isCheckinDbSyncEnabled() || this.isFinanceDbSyncEnabled();
  }

  /** legacy: record(打卡/财务统一) DB sync 开关（旧字段） */
  private getLegacyRecordDbSyncEnabled(): boolean {
    const v = (this.settings as any).rslattePanelEnableDbSync;
    return typeof v === "boolean" ? v : true;
  }

  /** v6-3b：checkin 模块是否启用 */
  isCheckinModuleEnabled(): boolean {
    if (!this.isPluginEnvInitModuleGateOpen()) return false;
    const s: any = this.settings as any;
    const v2 = s?.moduleEnabledV2;
    if (typeof v2?.checkin === "boolean") return v2.checkin;
    const old = s?.moduleEnabled;
    if (typeof old?.record === "boolean") return old.record;
    return true;
  }

  /** v6-3b：finance 模块是否启用 */
  isFinanceModuleEnabled(): boolean {
    if (!this.isPluginEnvInitModuleGateOpen()) return false;
    const s: any = this.settings as any;
    const v2 = s?.moduleEnabledV2;
    if (typeof v2?.finance === "boolean") return v2.finance;
    const old = s?.moduleEnabled;
    if (typeof old?.record === "boolean") return old.record;
    return true;
  }

  /** 健康模块：显式开启（默认关） */
  isHealthModuleEnabled(): boolean {
    if (!this.isPluginEnvInitModuleGateOpen()) return false;
    const v2 = (this.settings as any)?.moduleEnabledV2;
    return v2?.health === true;
  }

  /** 健康模块 DB 同步开关（`health_records` 入库与 `recordSync` / `healthSpecAtomic` 对齐） */
  isHealthDbSyncEnabled(): boolean {
    if (!this.isHealthModuleEnabled()) return false;
    const apiBaseUrl = String((this.settings as any)?.apiBaseUrl ?? "").trim();
    const urlCheckable = (() => {
      if (!apiBaseUrl) return false;
      const lower = apiBaseUrl.toLowerCase();
      if (!(lower.startsWith("http://") || lower.startsWith("https://"))) return false;
      try {
        // eslint-disable-next-line no-new
        new URL(apiBaseUrl);
        return true;
      } catch {
        return false;
      }
    })();
    if (!urlCheckable) return false;
    const v = (this.settings as any)?.healthPanel?.enableDbSync;
    return v === true;
  }

  /** 知识库：`knowledge-index.json` → `knowledge_docs`；需合法 `apiBaseUrl` + `knowledgePanel.enableDbSync` */
  isKnowledgeDbSyncEnabled(): boolean {
    if (!this.isPluginEnvInitModuleGateOpen()) return false;
    const apiBaseUrl = String((this.settings as any)?.apiBaseUrl ?? "").trim();
    const urlCheckable = (() => {
      if (!apiBaseUrl) return false;
      const lower = apiBaseUrl.toLowerCase();
      if (!(lower.startsWith("http://") || lower.startsWith("https://"))) return false;
      try {
        // eslint-disable-next-line no-new
        new URL(apiBaseUrl);
        return true;
      } catch {
        return false;
      }
    })();
    if (!urlCheckable) return false;
    return (this.settings as any)?.knowledgePanel?.enableDbSync === true;
  }

  /**
   * WorkEvent JSONL → `rslatte_work_event`；非实时，随自动刷新 tick 批量 upsert。
   * 需合法 `apiBaseUrl` + `workEventDbSyncEnabled` + `workEventEnabled`。
   */
  isWorkEventDbSyncEnabled(): boolean {
    const s: any = this.settings as any;
    if (s?.workEventDbSyncEnabled !== true) return false;
    try {
      if (this.workEventSvc && !this.workEventSvc.isEnabled()) return false;
    } catch {
      return false;
    }
    const apiBaseUrl = String(s?.apiBaseUrl ?? "").trim();
    if (!apiBaseUrl) return false;
    const lower = apiBaseUrl.toLowerCase();
    if (!(lower.startsWith("http://") || lower.startsWith("https://"))) return false;
    try {
      new URL(apiBaseUrl);
      return true;
    } catch {
      return false;
    }
  }

  /** v6-3b：checkin DB sync 是否启用 */
  isCheckinDbSyncEnabled(): boolean {
    if (!this.isCheckinModuleEnabled()) return false;
    // URL 为空/不合法：强制视为关闭（与设置urlCheckable 对齐）    
    const apiBaseUrl = String((this.settings as any)?.apiBaseUrl ?? "").trim();
    const urlCheckable = (() => {
      if (!apiBaseUrl) return false;
      const lower = apiBaseUrl.toLowerCase();
      if (!(lower.startsWith("http://") || lower.startsWith("https://"))) return false;
      try {
        // eslint-disable-next-line no-new
        new URL(apiBaseUrl);
        return true;
      } catch {
        return false;
      }
    })();
    if (!urlCheckable) return false;
    const v = (this.settings as any)?.checkinPanel?.enableDbSync;
    if (typeof v === "boolean") return v;
    return this.getLegacyRecordDbSyncEnabled();
  }

  /** v6-3b：finance DB sync 是否启用 */
  isFinanceDbSyncEnabled(): boolean {
    if (!this.isFinanceModuleEnabled()) return false;
    // URL 为空/不合法：强制视为关闭（与设置urlCheckable 对齐）   
    const apiBaseUrl = String((this.settings as any)?.apiBaseUrl ?? "").trim();
    const urlCheckable = (() => {
      if (!apiBaseUrl) return false;
      const lower = apiBaseUrl.toLowerCase();
      if (!(lower.startsWith("http://") || lower.startsWith("https://"))) return false;
      try {
        // eslint-disable-next-line no-new
        new URL(apiBaseUrl);
        return true;
      } catch {
        return false;
      }
    })();
    if (!urlCheckable) return false;
    const v = (this.settings as any)?.financePanel?.enableDbSync;
    if (typeof v === "boolean") return v;
    return this.getLegacyRecordDbSyncEnabled();
  }

  /** 检查某模块 DB 同步是否启用（用于 spaceStats 状态灯等）；与 getDbSyncIndicator 逻辑一致 */
  isModuleDbSyncEnabled(moduleKey: DbSyncModuleKey): boolean {
    if (moduleKey === "record") return this.isRSLatteDbSyncEnabled();
    if (moduleKey === "checkin") return this.isCheckinDbSyncEnabled();
    if (moduleKey === "finance") return this.isFinanceDbSyncEnabled();
    if (moduleKey === "health") return this.isHealthDbSyncEnabled();
    if (moduleKey === "knowledge") return this.isKnowledgeDbSyncEnabled();
    if (moduleKey === "task") return this.isTaskDbSyncEnabledV2();
    if (moduleKey === "memo") return this.isMemoDbSyncEnabledV2();
    if (moduleKey === "output") return this.isOutputDbSyncEnabled();
    if (moduleKey === "project") return this.isProjectDbSyncEnabled();
    if (moduleKey === "contacts") return this.isContactsDbSyncEnabledV2();
    return false;
  }

  /**
   * 侧边栏状态灯：展示某模块最近一DB 同步时间   * - ok: 🟢
   * - pending: 🟡（存在待同步项）
   * - error: 🔴
   * - off/unknown:   */
  getDbSyncIndicator(moduleKey: DbSyncModuleKey): { icon: string; title: string } | null {
    const meta = this._dbSyncMeta[moduleKey];

    const dbSyncEnabled = this.isModuleDbSyncEnabled(moduleKey);

    // D9-1：dbSyncEnabled=false 状态灯隐藏
    if (!dbSyncEnabled) return null;

    // D9-1：dbSyncEnabled=true urlCheckable=false 视为 OFF（灯隐藏） 
    const apiBaseUrl = String((this.settings as any)?.apiBaseUrl ?? "").trim();
    const urlCheckable = (() => {
      if (!apiBaseUrl) return false;
      const lower = apiBaseUrl.toLowerCase();
      if (!(lower.startsWith("http://") || lower.startsWith("https://"))) return false;
      try {
        // eslint-disable-next-line no-new
        new URL(apiBaseUrl);
        return true;
      } catch {
        return false;
      }
    })();
    if (!urlCheckable) return null;

    // D9-1：backendReady=false    
    const bk = this.getBackendDbReady();
    const backendReady = bk.ready === true;
    
    const pending = Number(meta?.pendingCount ?? 0);
    const failed = Number(meta?.failedCount ?? 0);
    
    // 如果后端不可用，但当前模块没有 pending/failed 错误，不显示红色
    // 只有当前模块确实有错误时才显示红色，避免一个模块的错误影响所有模块
    if (!backendReady) {
      // 如果当前模块有 pending 或 failed，说明是模块级别的错误，显示红色
      if (pending > 0 || failed > 0) {
        const reason = bk.reason || "Failed to fetch";
        return { icon: "🔴", title: `后端不可用（不影响本地）：${reason}\n待同步：${pending} 失败：${failed}` };
      }
      return null;
    }


    const at = meta?.at ? (moment as any)(meta.at).format("YYYY-MM-DD HH:mm") : "从未";
    const countsLine = (pending > 0 || failed > 0) ? `待同步：${pending} 失败：${failed}` : "";

    // D9-1：backendReady=true queuePending>0/failed>0    
    if (pending > 0 || failed > 0) {
      return { icon: "🟡", title: `最后同步：${at}${countsLine}` };
    }

    // D9-1：backendReady=true queue清空    
    return { icon: "🟢", title: `最后同步：${at}` };
  }


  /**
   * D9-4：ForceFullNext 标记消费/清理（可观测* - ok=true：清标记并保存settings（一次）
   * - ok=false：不清标记，仅记consumed（方便排障）
   */
  async consumeForceFullFlag(moduleKey: string, ok: boolean): Promise<void> {
    try {
      const s: any = this.settings as any;
      if (!s) return;
      if (!s.dbSyncForceFullNext) s.dbSyncForceFullNext = {};
      const cur = !!s.dbSyncForceFullNext[moduleKey];
      if (!cur) return;

      // 统一日志
      try { console.log(`[RSLatte][${moduleKey}][forceFull] consumed ok=${ok}`); } catch {}

      if (ok) {
        s.dbSyncForceFullNext[moduleKey] = false;
        await this.saveSettings();
        try { console.log(`[RSLatte][${moduleKey}][forceFull] cleared`); } catch {}
      }
    } catch {
      // ignore
    }
  }

  private markDbSync(moduleKey: DbSyncModuleKey, ok: boolean, err?: string) {
    const at = toLocalOffsetIsoString();
    this._dbSyncMeta[moduleKey] = ok
      ? { status: "ok", at, pendingCount: 0, failedCount: 0 }
      : { status: "error", at, err: err || "", pendingCount: 0, failedCount: 0 };
  }

  /** 带计数的状态更新（用于在侧边栏状态灯 tooltip 中展示pending/failed 数量*/
  private markDbSyncWithCounts(
    moduleKey: DbSyncModuleKey,
    meta: { pendingCount?: number; failedCount?: number; ok?: boolean; err?: string }
  ) {
    const at = toLocalOffsetIsoString();
    const pending = Number(meta.pendingCount ?? 0);
    const failed = Number(meta.failedCount ?? 0);
    const ok = meta.ok ?? (failed === 0);

    if (!ok || failed > 0) {
      this._dbSyncMeta[moduleKey] = { status: "error", at, err: meta.err || "", pendingCount: pending, failedCount: failed };
    } else if (pending > 0) {
      this._dbSyncMeta[moduleKey] = { status: "pending", at, pendingCount: pending, failedCount: failed };
    } else {
      this._dbSyncMeta[moduleKey] = { status: "ok", at, pendingCount: 0, failedCount: 0 };
    }
    
    // 方案A：触发事件通知 Hub 视图更新（异步触发，不阻塞）
    try {
      const currentSpaceId = this.getCurrentSpaceId();
      (this.app.workspace as any).trigger?.(RSLATTE_EVENT_DB_SYNC_STATUS_CHANGED, {
        moduleKey,
        spaceId: currentSpaceId,
        pendingCount: pending,
        failedCount: failed,
        status: ok ? (pending > 0 ? "pending" : "ok") : "failed",
        timestamp: at,
      });
    } catch (e) {
      // 忽略事件触发错误，不影响主流程
      if (this.isDebugLogEnabled()) {
        console.warn(`[RSLatte] Failed to trigger DB sync status changed event:`, e);
      }
    }
  }

  /** 追加审计日志（包装 auditSvc.appendAuditLog） */
  async appendAuditLog(entry: Record<string, any>): Promise<void> {
    try {
      await this.auditSvc?.appendAuditLog(entry);
    } catch (e) {
      console.warn("RSLatte appendAuditLog failed:", e);
    }
  }

  /** 序列化错误信息用于审计日志 */
  _serializeErrorForAudit(e: any): string {
    if (!e) return "unknown_error";
    if (typeof e === "string") return e;
    if (e?.message) return String(e.message);
    if (e?.toString) return String(e.toString());
    return String(e);
  }

  /** 保存设置（由 createCore 提供实现，这里仅声明类型） */
  async saveSettings(): Promise<boolean> {
    // 实际实现由 createCore 通过 Object.assign 混入
    throw new Error("saveSettings should be provided by createCore");
  }

  /** Debug 日志开关（由 createPluginHelpers 提供实现，这里仅声明类型） */
  isDebugLogEnabled(): boolean {
    // 实际实现由 createPluginHelpers 通过 Object.assign 混入
    return false;
  }

  /** Console 日志（由 createPluginHelpers 提供实现，这里仅声明类型） */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  dbg(_scope: string, _message: string, _data?: any): void {
    // 实际实现由 createPluginHelpers 通过 Object.assign 混入
  }

  /** 刷新侧边栏（由 createCore 提供实现，这里仅声明类型） */
  refreshSidePanel(): void {
    // 实际实现由 createCore 通过 Object.assign 混入
  }

  /**
   * ✅ 内存优化：手动清理所有服务的快照缓存（供内存紧张时调用）
   * 清理后，下次访问时会按需重新加载
   */
  public clearAllSnapshots(): void {
    try {
      this.recordRSLatte?.clearAllSnapshots?.();
      this.outputRSLatte?.clearAllSnapshots?.();
      this.projectMgr?.clearAllSnapshots?.();
      
      // 清理其他可能的缓存
      if ((this as any).contactsIndex?.clearAllSnapshots) {
        (this as any).contactsIndex.clearAllSnapshots();
      }
      
      // 清理任务服务的快照（如果有）
      if ((this as any).taskRSLatte?.clearAllSnapshots) {
        (this as any).taskRSLatte.clearAllSnapshots();
      }
    } catch (e) {
      console.warn("[RSLatte] Failed to clear all snapshots:", e);
    }
  }

  /** 设置后端 DB 可用性状态（由 createCore 提供实现，这里仅声明类型） */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setBackendDbReady(_ready: boolean, _reason?: string): void {
    // 实际实现由 createCore 通过 Object.assign 混入
  }

  /** 获取后端 DB 可用性状态（由 createCore 提供实现，这里仅声明类型） */
  getBackendDbReady(): { ready: boolean | null; reason: string; checkedAt: number } {
    // 实际实现由 createCore 通过 Object.assign 混入
    return { ready: null, reason: "", checkedAt: 0 };
  }

  /** 迁移旧版 Refresh Interval（由 createCore 提供实现，这里仅声明类型） */
  async migrateRefreshIntervalToAutoRefreshIfNeeded(): Promise<void> {
    // 实际实现由 createCore 通过 Object.assign 混入
  }

  /** 同步打卡项清单/财务分类清单到数据库（由 createRecordSync 提供实现，这里仅声明类型） */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async syncRecordListsToDb(_mods?: { checkin?: boolean; finance?: boolean }): Promise<void> {
    // 实际实现由 createRecordSync 通过 Object.assign 混入
  }

  /** 获取当前空间 ID（由 createSpaceManagement 提供实现，这里仅声明类型） */
  getCurrentSpaceId(): string {
    // 实际实现由 createSpaceManagement 通过 Object.assign 混入
    return "";
  }

  /** 获取空间配置（由 createSpaceManagement 提供实现，这里仅声明类型） */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getSpaceConfig(_spaceId?: string): any {
    // 实际实现由 createSpaceManagement 通过 Object.assign 混入
    return {};
  }

  /** 获取空间上下文（由 createSpaceManagement 提供实现，这里仅声明类型） */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getSpaceCtx(_spaceId?: string): any {
    // 实际实现由 createSpaceManagement 通过 Object.assign 混入
    return {};
  }

  /** 获取今天的日期键（由 createPluginHelpers 提供实现，这里仅声明类型） */
  getTodayKey(): string {
    // 实际实现由 createPluginHelpers 通过 Object.assign 混入
    return "";
  }

  /** 获取昨天的日期键 YYYY-MM-DD（由 createPluginHelpers 提供实现） */
  getYesterdayKey(): string {
    return "";
  }

  /** 获取或创建今日状态（由 createPluginHelpers 提供实现，这里仅声明类型） */
  getOrCreateTodayState(): any {
    // 实际实现由 createPluginHelpers 通过 Object.assign 混入
    return {};
  }

  /** 获取空间索引目录（由 createPluginHelpers 提供实现，这里仅声明类型） */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getSpaceIndexDir(_spaceId?: string): string {
    // 实际实现由 createPluginHelpers 通过 Object.assign 混入
    return "";
  }

  /** 获取空间队列目录（由 createPluginHelpers 提供实现，这里仅声明类型） */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getSpaceQueueDir(_spaceId?: string): string {
    // 实际实现由 createPluginHelpers 通过 Object.assign 混入
    return "";
  }

  /** 获取空间统计目录（由 createPluginHelpers 提供实现，这里仅声明类型） */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getSpaceStatsDir(_spaceId?: string): string {
    // 实际实现由 createPluginHelpers 通过 Object.assign 混入
    return "";
  }

  /** 创建 Pipeline Engine（由 createPipelineManager 提供实现，这里仅声明类型） */
  createPipelineEngine(): any {
    // 实际实现由 createPipelineManager 通过 Object.assign 混入
    return null;
  }

  /** 确保自动刷新协调器已初始化（由 createPipelineManager 提供实现，这里仅声明类型） */
  ensureAutoRefreshCoordinator(): void {
    // 实际实现由 createPipelineManager 通过 Object.assign 混入
  }

  /** 设置自动刷新定时器（由 createPipelineManager 提供实现，这里仅声明类型） */
  setupAutoRefreshTimer(): void {
    // 实际实现由 createPipelineManager 通过 Object.assign 混入
  }

  /** 打开空间切换器（由 createSpaceManagement 提供实现，这里仅声明类型） */
  openSpaceSwitcher(): void {
    // 实际实现由 createSpaceManagement 通过 Object.assign 混入
  }

  /**
   * 核心插件「工作区」未启用时不显示一键载入布局 ribbon；启用后再显示（随用户开关同步）。
   */
  syncRslatteWorkspaceLayoutRibbon(): void {
    const on = isWorkspacesCorePluginEnabled(this.app);
    try {
      if (on) {
        if (this._rslatteWorkspaceLayoutRibbonEl?.isConnected) {
          this._rslatteWorkspaceRibbonPollLast = on;
          return;
        }
        if (this._rslatteWorkspaceLayoutRibbonEl && !this._rslatteWorkspaceLayoutRibbonEl.isConnected) {
          this._rslatteWorkspaceLayoutRibbonEl = null;
        }
        this._rslatteWorkspaceLayoutRibbonEl = this.addRibbonIcon(
          "layout-grid",
          "一键载入 RSLatte 工作区",
          () => void applyRslatteBundledWorkspaceLayout(this),
        ) as HTMLElement;
      } else {
        this._rslatteWorkspaceLayoutRibbonEl?.remove();
        this._rslatteWorkspaceLayoutRibbonEl = null;
      }
    } catch (e) {
      console.warn("[RSLatte][workspace-layout] syncRslatteWorkspaceLayoutRibbon failed", e);
    }
    this._rslatteWorkspaceRibbonPollLast = on;
  }

  /**
   * ✅ 打开插件设置窗口
   */
  public openSettings(): void {
    try {
      // 打开设置窗口
      (this.app as any).setting?.open?.();
      // 打开 RSLatte 插件的设置标签页
      const pluginId = this.manifest.id;
      if (pluginId && (this.app as any).setting?.openTabById) {
        (this.app as any).setting.openTabById(pluginId);
      }
    } catch (e) {
      console.warn("[RSLatte] Failed to open settings:", e);
      new Notice("打开设置失败，请手动从设置菜单中打开 RSLatte 设置");
    }
  }

  /**
   * 更新状态栏中的空间名称显示
   */
  private updateSpaceStatusBar(): void {
    if (!this._spaceStatusBarItem) return;
    
    try {
      const spaceConfig = this.getSpaceConfig();
      const spaceName = spaceConfig?.name || this.getCurrentSpaceId() || "默认空间";
      this._spaceStatusBarItem.setText(`📁 ${spaceName}`);
    } catch (e) {
      console.warn("[RSLatte][space] Failed to update status bar:", e);
      if (this._spaceStatusBarItem) {
        this._spaceStatusBarItem.setText("📁 空间");
      }
    }
  }

  /**
   * 依次刷新所有启用的模块（当前空间）
   */
  public async refreshAllModules(): Promise<void> {
    const ctx = this.getSpaceCtx();
    const moduleKeys = ["task", "memo", "checkin", "finance", "project", "output", "contacts"];
    
    const enabledModules: string[] = [];
    for (const key of moduleKeys) {
      try {
        if (this.isPipelineModuleEnabled(key as any)) {
          enabledModules.push(key);
        }
      } catch {
        // ignore
      }
    }

    if (enabledModules.length === 0) {
      new Notice("当前空间没有启用的模块");
      return;
    }

    new Notice(`开始刷新 ${enabledModules.length} 个模块...`);
    
    // 依次刷新：统一 manual_refresh（增量写索引；门控通过时可 reconcile）
    for (let i = 0; i < enabledModules.length; i++) {
      const moduleKey = enabledModules[i];
      try {
        const r = await this.pipelineEngine.runE2(ctx, moduleKey as any, "manual_refresh");
        if (!r.ok) {
          console.warn(`[RSLatte] Failed to refresh module ${moduleKey}:`, r.error.message);
          new Notice(`模块 ${this.getModuleLabel(moduleKey)} 刷新失败：${r.error.message}`);
        } else if (!r.data.skipped) {
          if (this.isDebugLogEnabled()) {
            console.log(`[RSLatte] Module ${moduleKey} refreshed successfully`);
          }
        }
      } catch (e: any) {
        console.warn(`[RSLatte] Error refreshing module ${moduleKey}:`, e);
        new Notice(`模块 ${this.getModuleLabel(moduleKey)} 刷新出错：${e?.message ?? String(e)}`);
      }
      
      // 模块之间稍作延迟，避免并发压力
      if (i < enabledModules.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // 刷新完成后，刷新所有侧边栏
    this.refreshSidePanel();
    new Notice(`已刷新 ${enabledModules.length} 个模块`);
  }

  /**
   * 获取模块的中文标签
   */
  private getModuleLabel(moduleKey: string): string {
    const labels: Record<string, string> = {
      task: "任务",
      memo: "提醒",
      checkin: "打卡",
      finance: "财务",
      project: "项目",
      output: "输出",
      contacts: "联系人",
    };
    return labels[moduleKey] || moduleKey;
  }

  /** 激活 Hub 视图（由 createUiNavigation 提供实现，这里仅声明类型） */
  async activateHubView(): Promise<void> {
    // 实际实现由 createUiNavigation 通过 Object.assign 混入
  }

  /** 激活 RSLatte 视图（由 createUiNavigation 提供实现，这里仅声明类型） */
  async activateRSLatteView(_opts?: { inspectSection?: "checkin" | "finance" | "health" | "journal" }): Promise<void> {
    // 实际实现由 createUiNavigation 通过 Object.assign 混入
  }

  /** 激活健康视图（由 createUiNavigation 提供实现，这里仅声明类型） */
  async activateHealthView(_opts?: {
    contentTab?: "ledger" | "stats";
    entryId?: string;
    recordDate?: string;
  }): Promise<void> {
    // 实际实现由 createUiNavigation 通过 Object.assign 混入
  }

  /** 激活项目视图（由 createUiNavigation 提供实现，这里仅声明类型） */
  async activateProjectView(): Promise<void> {
    // 实际实现由 createUiNavigation 通过 Object.assign 混入
  }

  /** 激活任务视图（由 createUiNavigation 提供实现，这里仅声明类型） */
  async activateTaskView(_opts?: { subTab?: "memo" | "schedule" | "task" }): Promise<void> {
    // 实际实现由 createUiNavigation 通过 Object.assign 混入
  }

  /** 激活 Capture 视图（由 createUiNavigation 提供实现，这里仅声明类型） */
  async activateCaptureView(): Promise<void> {
    // 实际实现由 createUiNavigation 通过 Object.assign 混入
  }

  /** 激活输出视图（由 createUiNavigation 提供实现，这里仅声明类型） */
  async activateOutputView(): Promise<void> {
    // 实际实现由 createUiNavigation 通过 Object.assign 混入
  }

  /** 激活发布视图（§4：已重定向到 Knowledge，由 createUiNavigation 提供实现） */
  async activatePublishView(): Promise<void> {
    // 实际实现由 createUiNavigation 通过 Object.assign 混入
  }

  /** 激活 Knowledge 工作台视图（由 createUiNavigation 提供实现，这里仅声明类型） */
  async activateKnowledgeView(): Promise<void> {
    // 实际实现由 createUiNavigation 通过 Object.assign 混入
  }

  /** 兼容旧调用：与 `activateKnowledgeView` 相同，仅打开知识管理（工作台） */
  async activateKnowledgePanelView(): Promise<void> {
    // 实际实现由 createUiNavigation 通过 Object.assign 混入
  }

  /** 激活财务视图（由 createUiNavigation 提供实现，这里仅声明类型） */
  async activateFinanceView(_opts?: {
    contentTab?: "ledger" | "stats";
    entryId?: string;
    recordDate?: string;
  }): Promise<void> {
    // 实际实现由 createUiNavigation 通过 Object.assign 混入
  }

  /** 激活打卡视图（由 createUiNavigation 提供实现，这里仅声明类型） */
  async activateCheckinView(_opts?: { recordDate?: string; checkinId?: string }): Promise<void> {
    // 实际实现由 createUiNavigation 通过 Object.assign 混入
  }

  /** Review 侧栏（由 createUiNavigation 提供实现；可选粒度/周期键/子页签，见 `Review侧边栏优化方案.md` §4.3） */
  async activateReviewView(_opts?: {
    grain?: "week" | "month" | "quarter";
    periodKey?: string;
    periodOffset?: number;
    subTab?: "execute" | "reconcile" | "records";
  }): Promise<void> {
    // 实际实现由 createUiNavigation 通过 Object.assign 混入
  }

  /** 激活操作日志视图（WorkEvent 时间轴） */
  async activateTimelineView(): Promise<void> {
    if (!this.app.workspace) return;
    let leaf: any = this.app.workspace.getLeavesOfType(VIEW_TYPE_TIMELINE)[0];
    if (!leaf) {
      const newLeaf = this.app.workspace.getRightLeaf(false);
      if (newLeaf) {
        await newLeaf.setViewState({ type: VIEW_TYPE_TIMELINE, active: true });
        leaf = newLeaf;
      }
    }
    if (leaf) {
      this.app.workspace.revealLeaf(leaf);
      // 等待视图渲染完成后再高亮
      window.setTimeout(() => {
        // 尝试多种方式访问容器元素
        const containerEl = (leaf as any).view?.containerEl || (leaf as any).containerEl || (leaf as any).viewEl;
        if (containerEl) {
          containerEl.addClass("rslatte-sidebar-highlight");
          window.setTimeout(() => {
            containerEl.removeClass("rslatte-sidebar-highlight");
          }, 1500);
        }
      }, 200); // 增加延迟时间，确保视图完全渲染
    }
  }

  /** 激活日程日历侧栏（schedule-index 月历 + 选日展开） */
  async activateCalendarView(): Promise<void> {
    if (!this.app.workspace) return;
    let leaf: any = this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR)[0];
    if (!leaf) {
      const newLeaf = this.app.workspace.getRightLeaf(false);
      if (newLeaf) {
        await newLeaf.setViewState({ type: VIEW_TYPE_CALENDAR, active: true });
        leaf = newLeaf;
      }
    }
    if (leaf) {
      this.app.workspace.revealLeaf(leaf);
      window.setTimeout(() => {
        const containerEl = (leaf as any).view?.containerEl || (leaf as any).containerEl || (leaf as any).viewEl;
        if (containerEl) {
          containerEl.addClass("rslatte-sidebar-highlight");
          window.setTimeout(() => {
            containerEl.removeClass("rslatte-sidebar-highlight");
          }, 1500);
        }
      }, 200);
    }
  }

  /** 激活联系人视图（由 createUiNavigation 提供实现，这里仅声明类型） */
  async activateContactsView(): Promise<void> {
    // 实际实现由 createUiNavigation 通过 Object.assign 混入
  }

  /** 确保联系人面板已注册（由 createUiNavigation 提供实现，这里仅声明类型） */
  ensureContactsPanelRegistered(): void {
    // 实际实现由 createUiNavigation 通过 Object.assign 混入
  }

  /** 关闭联系人视图（由 createUiNavigation 提供实现，这里仅声明类型） */
  closeContactsView(): void {
    // 实际实现由 createUiNavigation 通过 Object.assign 混入
  }

  /** 设置联系人链接后处理器（由 createContactsHandler 提供实现，这里仅声明类型） */
  setupContactsLinkPostProcessor(): void {
    // 实际实现由 createContactsHandler 通过 Object.assign 混入
  }

  /** 绑定元素中的联系人链接（由 createContactsHandler 提供实现，这里仅声明类型） */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  bindContactLinksInEl(_el: HTMLElement): void {
    // 实际实现由 createContactsHandler 通过 Object.assign 混入
  }

  /** 从 href 中提取联系人 UID（由 createContactsHandler 提供实现，这里仅声明类型） */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  extractContactUidFromHref(_href: string): string | null {
    // 实际实现由 createContactsHandler 通过 Object.assign 混入
    return null;
  }

  /** 关闭联系人链接弹窗（由 createContactsHandler 提供实现，这里仅声明类型） */
  closeContactLinkPopover(): void {
    // 实际实现由 createContactsHandler 通过 Object.assign 混入
  }

  /** 显示联系人链接弹窗（由 createContactsHandler 提供实现，这里仅声明类型） */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async showContactLinkPopover(_anchor: HTMLElement, _uid: string): Promise<void> {
    // 实际实现由 createContactsHandler 通过 Object.assign 混入
  }

  /** 定位弹窗位置（由 createContactsHandler 提供实现，这里仅声明类型） */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  positionPopover(_pop: HTMLElement, _anchor: HTMLElement): void {
    // 实际实现由 createContactsHandler 通过 Object.assign 混入
  }

  /** 根据 UID 查找联系人（由 createContactsHandler 提供实现，这里仅声明类型） */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async findContactByUid(_uid: string): Promise<any> {
    // 实际实现由 createContactsHandler 通过 Object.assign 混入
    return null;
  }

  /** 从联系人项解析头像资源（由 createContactsHandler 提供实现，这里仅声明类型） */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  resolveAvatarResourceFromItem(_it: any): string | null {
    // 实际实现由 createContactsHandler 通过 Object.assign 混入
    return null;
  }

  /** 从记录索引中水合今日数据（由 createRecordSync 提供实现，这里仅声明类型） */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  hydrateTodayFromRecordIndex(_e?: any): Promise<void> {
    // 实际实现由 createRecordSync 通过 Object.assign 混入
    return Promise.resolve();
  }

  /** 打开指定路径的笔记并定位到标题行（由 createUiNavigation 提供实现，这里仅声明类型） */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async openNoteAtHeading(_path: string, _headingLine: string): Promise<void> {
    // 实际实现由 createUiNavigation 通过 Object.assign 混入
  }

  /** 将今日项目进度写入日记（由 createJournalWriter 提供实现，这里仅声明类型） */
  async writeTodayProjectProgressToJournal(): Promise<void> {
    // 实际实现由 createJournalWriter 通过 Object.assign 混入
  }

  /** 同步输出文件到数据库（由 createOutputManager 提供实现，这里仅声明类型） */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async syncOutputFilesToDb(_opts?: { reason?: string }): Promise<void> {
    // 实际实现由 createOutputManager 通过 Object.assign 混入
  }

  /** 立即归档输出文件（由 createOutputManager 提供实现，这里仅声明类型） */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async archiveOutputFilesNow(_opts?: { reason?: string }): Promise<number> {
    // 实际实现由 createOutputManager 通过 Object.assign 混入
    return 0;
  }

  // =========================
  // Today checkin sync (DB as source of truth)
  // =========================

  /** 获取缓存中的今日打卡记录（可能为空） */
  getTodayCheckinRecord(checkinId: string): ApiCheckinRecord | undefined {
    return this._todayCheckinsMap.get((checkinId ?? "").trim());
  }


  // =========================
  // Today finance sync (DB as source of truth)
  // =========================

  /** 获取缓存中的今日财务记录（可能为空）；同分类多条时返回最近一条未删除，否则最后一条 */
  getTodayFinanceRecord(categoryId: string): ApiFinanceRecord | undefined {
    const list = this.getTodayFinanceRecords(categoryId);
    const active = list.filter((x) => !x.is_delete);
    if (active.length > 0) return active[active.length - 1];
    return list.length > 0 ? list[list.length - 1] : undefined;
  }

  /** 今日该分类下全部缓存明细（按 created_at / 原顺序排列） */
  getTodayFinanceRecords(categoryId: string): ApiFinanceRecord[] {
    const k = (categoryId ?? "").trim();
    return [...(this._todayFinancesMap.get(k) ?? [])];
  }


  // =========================
  // Finance summary stats (DB /stats)
  // =========================

  /** 读取当前缓存（若未加载则返回 0 值） */
  getFinanceSummarySnapshot(): {
    loaded: boolean;
    asOf: string;
    monthIncome: number;
    monthExpense: number;
    yearIncome: number;
    yearExpense: number;
  } {
    const asOf = this._financeSummaryKey || this.getTodayKey();
    const s = this._financeSummary;
    return {
      loaded: !!s,
      asOf,
      monthIncome: s?.monthIncome ?? 0,
      monthExpense: s?.monthExpense ?? 0,
      yearIncome: s?.yearIncome ?? 0,
      yearExpense: s?.yearExpense ?? 0,
    };
  }

  /** 插件启动/跨天时初始化一次（后续由财务upsert 成功后触发刷新） */
  async ensureFinanceSummaryInitialized(opts?: { allowDb?: boolean }): Promise<void> {
    if (!this.isModuleEnabled("record")) return;

    // 启动/打开侧边栏阶段：允许强制只走本地统计（不访问后端）   
    if (opts?.allowDb === false) {
      await this.refreshFinanceSummaryFromNotes(true, 0);
      return;
    }
    // finance 独立开关：关闭 DB sync 时仍可在侧边栏显示“基于笔记统计”的汇总   
    if (!this.isFinanceDbSyncEnabled()) {
      await this.refreshFinanceSummaryFromNotes(true, 0);
      return;
    }
    const todayKey = this.getTodayKey();
    const notLoadedYet = !this._financeSummaryKey || this._financeSummaryFetchedAt <= 0 || !this._financeSummary;
    const dayChanged = this._financeSummaryKey !== todayKey;
    if (notLoadedYet || dayChanged) {
      try {
        await this.refreshFinanceSummaryFromApi(true, 0);
      } catch (e: any) {
        // 失败不阻断：标记后端不可用并降级为本地统计
        this.setBackendDbReady(false, e?.message ?? String(e));
        await this.refreshFinanceSummaryFromNotes(true, 0);
      }
    }
  }

  /** 从后端/stats 拉取财务汇总，并更新缓存（失败不阻断主流程）*/
  async refreshFinanceSummaryFromApi(force: boolean = false, minIntervalMs: number = 10_000): Promise<void> {
    if (!this.isModuleEnabled("record")) return;
    if (!this.isFinanceDbSyncEnabled()) {
      await this.refreshFinanceSummaryFromNotes(force, minIntervalMs);
      return;
    }
    const todayKey = this.getTodayKey();
    const now = Date.now();

    if (!force && this._financeSummaryKey === todayKey && (now - this._financeSummaryFetchedAt) < minIntervalMs) {
      return;
    }

    const vaultOk = await this.vaultSvc?.ensureVaultReadySafe?.("refreshFinanceSummaryFromApi");
    if (!vaultOk) {
      await this.refreshFinanceSummaryFromNotes(force, minIntervalMs);
      return;
    }
    const db = await this.vaultSvc?.checkDbReadySafe?.("refreshFinanceSummaryFromApi");
    if (!db?.ok) {
      await this.refreshFinanceSummaryFromNotes(force, minIntervalMs);
      return;
    }

    try {
      const r = await apiTry("查询财务汇总", () => this.api.getStats("finance_summary", todayKey));
      const stats = r as ApiFinanceSummaryStats;

      const monthIncome = Number(stats?.finance?.month?.income ?? 0);
      const monthExpense = Number(stats?.finance?.month?.expense ?? 0);
      const yearIncome = Number(stats?.finance?.year?.income ?? 0);
      const yearExpense = Number(stats?.finance?.year?.expense ?? 0);

      this._financeSummary = {
        monthIncome: Number.isFinite(monthIncome) ? monthIncome : 0,
        monthExpense: Number.isFinite(monthExpense) ? monthExpense : 0,
        yearIncome: Number.isFinite(yearIncome) ? yearIncome : 0,
        yearExpense: Number.isFinite(yearExpense) ? yearExpense : 0,
      };
      this._financeSummaryKey = stats?.as_of || todayKey;
      this._financeSummaryFetchedAt = now;

      // 更新 UI
      this.refreshSidePanel();
    } catch (e: any) {
      // 后端不可用：标记后端不可用，并降级为本地统计
      this.setBackendDbReady(false, e?.message ?? String(e));
      await this.appendAuditLog({
        action: "FINANCE_SUMMARY_FETCH_FAILED",
        as_of: todayKey,
        error: this._serializeErrorForAudit(e),
      });
      await this.refreshFinanceSummaryFromNotes(force, minIntervalMs);
    }
  }

  /** 关闭 DB 同步时，从日记正文计算财务汇总（不依赖后端） */
  async refreshFinanceSummaryFromNotes(force: boolean = false, minIntervalMs: number = 10_000): Promise<void> {
    if (!this.isModuleEnabled("record")) return;
    const todayKey = this.getTodayKey();
    const now = Date.now();
    if (!force && this._financeSummaryKey === todayKey && (now - this._financeSummaryFetchedAt) < minIntervalMs && this._financeSummary) {
      return;
    }

    try {
      const stats = await this.calcFinanceSummaryFromNotes();
      this._financeSummary = {
        monthIncome: Number(stats.monthIncome ?? 0),
        monthExpense: Number(stats.monthExpense ?? 0),
        yearIncome: Number(stats.yearIncome ?? 0),
        yearExpense: Number(stats.yearExpense ?? 0),
      };
      this._financeSummaryKey = todayKey;
      this._financeSummaryFetchedAt = now;
      this.refreshSidePanel();
    } catch (e: any) {
      // 不强制写 audit；本地计算失败通常是日记不存在/格式异常
      console.warn("RSLatte refreshFinanceSummaryFromNotes failed:", e);
    }
  }

  /** upsert 成功后回写本地缓存与 dailyState，避免再次查询后*/
  applyTodayFinanceRecord(record: ApiFinanceRecord) {
    const todayKey = this.getTodayKey();
    if (!record || String(record.record_date) !== todayKey) return;

    if (this._todayFinancesKey !== todayKey) {
      this._todayFinancesKey = todayKey;
      this._todayFinancesMap = new Map();
    }

    const cat = String(record.category_id);
    const eid = String(record.entry_id ?? "").trim();
    let arr = [...(this._todayFinancesMap.get(cat) ?? [])];
    if (eid) {
      arr = arr.filter((x) => String(x.entry_id ?? "").trim() !== eid);
    } else {
      arr = arr.filter((x) => String(x.entry_id ?? "").trim().length > 0);
    }
    arr.push(record);
    arr.sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
    this._todayFinancesMap.set(cat, arr);
    this._todayFinancesFetchedAt = Date.now();

    const st = this.getOrCreateTodayState();
    const cur = this._todayFinancesMap.get(cat) ?? [];
    st.financeDone[cat] = cur.some((x) => !x.is_delete);
  }


  /**
   * upsert 成功后，用接口返回的记录直接回写本地缓存dailyState，避免再次查询后端  
   * 注意：这里只维护“今天”的状态  
   */
  applyTodayCheckinRecord(record: ApiCheckinRecord) {
    const todayKey = this.getTodayKey();
    if (!record || String(record.record_date) !== todayKey) return;

    // 若跨天（极少发生：打开很久、过零点）则重置缓存
    if (this._todayCheckinsKey !== todayKey) {
      this._todayCheckinsKey = todayKey;
      this._todayCheckinsMap = new Map();
    }

    this._todayCheckinsMap.set(String(record.checkin_id), record);
    this._todayCheckinsFetchedAt = Date.now();

    const st = this.getOrCreateTodayState();
    st.checkinsDone[String(record.checkin_id)] = !record.is_delete;
  }

  /**
   * ✅ 共享的打卡切换业务逻辑（提取自 CheckinModal 和 RSLatteSidePanelView.toggleCheckinQuick）
   * - DB 开启时：DB 成功才回写本地/写日记；失败则 Notice + audit log
   * - DB 关闭时：仅更新本地缓存/中央索引 + 写日记
   * - 无论是否 DB，都会写入中央索引、写日记、记录 Work Event
   */
  async performCheckinToggle(item: CheckinItemDef, note: string = ""): Promise<void> {
    const dateKey = this.getTodayKey();

    // ✅ 仅在"从未初始化/跨天"时才访问后端，避免每次点击都去查 DB
    await ((this as any).ensureTodayCheckinsInitialized?.() ?? Promise.resolve());
    const existing = this.getTodayCheckinRecord(item.id);

    const isActive = !!existing && !existing.is_delete;
    const targetIsDelete = isActive; // 已打卡 -> 取消 (is_delete=true)

    const payload = {
      record_date: dateKey,
      checkin_id: item.id,
      note,
      is_delete: targetIsDelete,
    } as const;

    const dbSync = this.isCheckinDbSyncEnabled?.() ?? this.isRSLatteDbSyncEnabled();
    let appliedRecord: any;

    if (dbSync) {
      let res: any;
      try {
        res = await this.api.upsertCheckinRecord(payload);
        if (!res?.item) throw new Error("upsert 返回为空");
      } catch (e: any) {
        // ❌ DB 失败：不写日记、不刷新状态
        new Notice("打卡记录写入数据库失败（详情已写入审计日志）");

        // ✅ 记住后端不可用：用于状态灯标红（不依赖设置页检查）
        try {
          (this as any).setBackendDbReady?.(false, e?.message ?? "Failed to fetch");
        } catch { }

        await this.appendAuditLog({
          action: "CHECKIN_UPSERT_FAILED",
          payload,
          error: {
            message: e?.message ?? String(e),
            status: e?.status ?? e?.response?.status ?? null,
            data: e?.data ?? e?.response?.data ?? null,
            stack: e?.stack ?? null,
          },
        });
        // ✅ DB 失败：降级为本地写入（不阻断打卡功能）
        res = { item: {
          id: 0,
          record_date: dateKey,
          checkin_id: item.id,
          note,
          is_delete: targetIsDelete,
          created_at: toLocalOffsetIsoString(),
        } };
      }

      // ✅ DB 成功：用 upsert 返回结果回写本地缓存/按钮状态（避免再次拉取 DB）
      appliedRecord = res.item;
      this.applyTodayCheckinRecord(appliedRecord);
    } else {
      // ✅ 离线模式：只更新本地缓存/中央索引 + 写日记
      appliedRecord = {
        id: 0,
        record_date: dateKey,
        checkin_id: item.id,
        note,
        is_delete: targetIsDelete,
        created_at: toLocalOffsetIsoString(),
      };
      this.applyTodayCheckinRecord(appliedRecord);
    }

    // ✅ 无论是否 DB，同步写入"打卡/财务中央索引"
    try {
      await this.recordRSLatte?.upsertCheckinRecord({
        recordDate: dateKey,
        checkinId: item.id,
        checkinName: item.name,
        note,
        isDelete: targetIsDelete,
        tsMs: Date.now(),
      });
    } catch (e) {
      console.warn("recordRSLatte upsertCheckinRecord failed", e);
    }

    // ✅ 打卡时更新连续打卡天数：昨日有记录则 +1，否则置 1（避免刷新异常时纠正为非 0 却昨日无记录的状态）
    if (!targetIsDelete && this.recordRSLatte) {
      try {
        const yesterdayKey = (this as any).getYesterdayKey?.() ?? "";
        if (/^\d{4}-\d{2}-\d{2}$/.test(yesterdayKey)) {
          const yesterdayHad = await this.recordRSLatte.hasEffectiveCheckinRecordOnDate(item.id, yesterdayKey);
          const newContinuous = yesterdayHad ? (Math.max(0, item.continuousDays ?? 0) + 1) : 1;
          const list = this.settings.checkinItems ?? [];
          const idx = list.findIndex((x) => String(x.id) === String(item.id));
          if (idx >= 0) {
            list[idx] = { ...list[idx], continuousDays: newContinuous };
            await this.saveSettings();
            await this.recordRSLatte.syncListsIndexFromSettings?.({ reason: "checkin_continuous_days" });
          }
        }
      } catch (e) {
        console.warn("update checkin continuousDays failed", e);
      }
    }

    // ✅ 以索引为准回填"今日状态"（按钮是否变绿等）
    // 说明：避免出现"日记/热力图已更新，但按钮不变绿，需要重启才能刷新"的问题。
    try {
      await this.hydrateTodayFromRecordIndex();
    } catch {
      // ignore
    }

    await this.saveSettings();
    this.refreshSidePanel();

    // ✅ 追加到日记
    const timeStr = momentFn().format("HH:mm");
    const mark = targetIsDelete ? "❌" : "✅";
    const line = `- ${dateKey} ${timeStr} ${item.id} ${item.name} ${mark}${note ? " " + note : ""}`;
    try {
      // ✅ 按"日志追加清单"配置写入日记（强制启用：打卡）
      await ((this as any).appendJournalByModule?.("checkin", dateKey, [line]) ?? Promise.resolve());
    } catch (e: any) {
      new Notice("打卡已保存，但写入日记失败（详情已写入审计日志）");
      await this.appendAuditLog({
        action: "CHECKIN_JOURNAL_APPEND_FAILED",
        payload,
        error: {
          message: e?.message ?? String(e),
          stack: e?.stack ?? null,
        },
      });
    }

    // ✅ Work Event (success only)
    void this.workEventSvc?.append({
      ts: toLocalOffsetIsoString(),
      kind: "checkin",
      action: targetIsDelete ? "delete" : "create",
      source: "ui",
      ref: {
        record_date: dateKey,
        checkin_id: item.id,
        checkin_name: item.name,
        is_delete: targetIsDelete,
        note: note || undefined,
      },
      summary: `${targetIsDelete ? "❌ 取消打卡" : "✅ 打卡"} ${item.name}${note ? " - " + note : ""}`.trim(),
      metrics: { is_delete: targetIsDelete },
    });

    new Notice(targetIsDelete ? "已取消打卡" : "已打卡");
  }

  /**
   * 轻量归一化连续打卡天数：昨日无记录时，若今日有打卡则置 1，否则置 0；昨日有记录则**不改动**（可能滞后）。
   * 打卡侧栏「🔄 刷新」与今日统一刷新已改为 {@link recomputeCheckinContinuousDaysFromIndex}，避免补打卡后 streak 仍被旧值卡住。
   */
  async normalizeCheckinContinuousDays(): Promise<void> {
    if (!this.recordRSLatte) return;
    const yesterdayKey = (this as any).getYesterdayKey?.() ?? "";
    const todayKey = (this as any).getTodayKey?.() ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(yesterdayKey) || !/^\d{4}-\d{2}-\d{2}$/.test(todayKey)) return;
    const list = this.settings.checkinItems ?? [];
    let changed = false;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      try {
        const hasYesterday = await this.recordRSLatte.hasEffectiveCheckinRecordOnDate(item.id, yesterdayKey);
        if (hasYesterday) continue; // 昨日有记录，保持当前连续天数
        const hasToday = await this.recordRSLatte.hasEffectiveCheckinRecordOnDate(item.id, todayKey);
        const target = hasToday ? 1 : 0;
        if ((item.continuousDays == null ? 0 : item.continuousDays) !== target) {
          list[i] = { ...item, continuousDays: target };
          changed = true;
        }
      } catch {
        // best-effort，单条失败不阻断
      }
    }
    if (changed) {
      await this.saveSettings();
      try {
        await this.recordRSLatte.syncListsIndexFromSettings?.({ reason: "normalize_continuous_days" });
      } catch {
        // ignore
      }
    }
  }

  /**
   * 根据打卡索引的完整历史重算每个打卡项的连续打卡天数（从今天起向前数连续有打卡的天数）。
   * 用于重建索引后、或补打卡历史数据后，保证连续天数与真实记录一致。
   */
  async recomputeCheckinContinuousDaysFromIndex(): Promise<void> {
    if (!this.recordRSLatte) return;
    const todayKey = (this as any).getTodayKey?.() ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(todayKey)) return;
    const list = this.settings.checkinItems ?? [];
    let changed = false;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      try {
        const dates = await this.recordRSLatte.getEffectiveCheckinRecordDates(item.id);
        const dateSet = new Set(dates);
        let streak = 0;
        if (dateSet.has(todayKey)) {
          streak = 1;
          let d = momentFn(todayKey, "YYYY-MM-DD").subtract(1, "day").format("YYYY-MM-DD");
          while (dateSet.has(d)) {
            streak++;
            d = momentFn(d, "YYYY-MM-DD").subtract(1, "day").format("YYYY-MM-DD");
          }
        }
        if ((item.continuousDays == null ? 0 : item.continuousDays) !== streak) {
          list[i] = { ...item, continuousDays: streak };
          changed = true;
        }
      } catch (e) {
        console.warn("recomputeCheckinContinuousDays item failed", item.id, e);
      }
    }
    if (changed) {
      await this.saveSettings();
      try {
        await this.recordRSLatte.syncListsIndexFromSettings?.({ reason: "recompute_continuous_days_from_index" });
      } catch {
        // ignore
      }
    }
  }

  /** ===================== Journal / Navigator façade ===================== */


  /** 手动归档任务索引（设置页/任务侧边栏按钮） */
  async runTaskRSLatteArchiveNow(showNotice = false): Promise<void> {
    if (!this.taskRSLatte) return;
    const r = await this.taskRSLatte.archiveNow();
    if (showNotice) {
      if (r.archivedCount > 0) new Notice(`已归档：${r.archivedCount} 条（< ${r.cutoffDate}）`);
      else new Notice(`无可归档条目（阈值 ${r.cutoffDate}）`);
    }
  }

  async calcFinanceSummaryFromNotes() {
    // 本地统计：不依赖后端；financeSummarySvc 只负责解析日记行
    if (!this.financeSummarySvc) {
      return { monthIncome: 0, monthExpense: 0, yearIncome: 0, yearExpense: 0 };
    }
    return await this.financeSummarySvc.calcFinanceSummaryFromNotes();
  }

  /** Step C2: scan contactsDir and rebuild local contacts-index.json */

  // ==========================
  // Contacts DB Sync (Step C8)
  // ==========================

  private extractYamlFrontmatterBlock(text: string): string | null {
    const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*(\n|$)/);
    return m ? m[1] : null;
  }

  /** 联系人入库侧栏摘要：与契约 `profile.meta_sync` 对齐，白名单扩展在此追加 */
  private buildContactMetaSyncForDb(obj: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { schema_version: 1 };
    const li = obj?.last_interaction_at;
    if (li != null && String(li).trim() !== "") {
      out.last_interaction_at = String(li).trim();
    }
    return out;
  }

  private async buildContactUpsertItemFromFile(file: TFile): Promise<ContactsUpsertItem | null> {
    try {
      const text = await this.app.vault.read(file);
      const yaml = this.extractYamlFrontmatterBlock(text);
      if (!yaml) return null;
      const obj: any = yaml.trim() ? ((parseYaml(yaml) as any) ?? {}) : {};

      if (String(obj?.type ?? "").trim() !== "contact") {
        // contact 文件不参与DB sync（安全兜底）
        return null;
      }

      const item: ContactsUpsertItem = {
        contact_uid: String(obj?.contact_uid ?? "").trim(),
        display_name: String(obj?.display_name ?? "").trim(),
        group_name: String(obj?.group_name ?? "").trim(),
        title: String(obj?.title ?? "").trim(),
        file_path: file.path,

        aliases: Array.isArray(obj?.aliases) ? obj.aliases : [],
        status: (String(obj?.status ?? "active").trim() === "cancelled" ? "cancelled" : "active") as "active" | "cancelled",
        cancelled_at: (obj?.cancelled_at ?? null) as any,
        tags: Array.isArray(obj?.tags) ? obj.tags : [],
        summary: (obj?.summary ?? null) as any,
        company: (obj?.company ?? null) as any,
        department: (obj?.department ?? null) as any,
        avatar_path: (obj?.avatar_path ?? null) as any,
        phones: Array.isArray(obj?.phones) ? obj.phones : [],
        emails: Array.isArray(obj?.emails) ? obj.emails : [],
        im: Array.isArray(obj?.im) ? obj.im : [],
        birthday: (obj?.birthday ?? null) as any,
        last_interaction_at: (obj?.last_interaction_at ?? null) as any,
        extra: (obj?.extra ?? null) as any,
        meta_sync: this.buildContactMetaSyncForDb(obj as Record<string, unknown>),
        archived_at: (obj?.archived_at ?? null) as any,
        is_delete: Boolean(obj?.is_delete ?? false),
        created_at: (obj?.created_at ?? null) as any,
        updated_at: (obj?.updated_at ?? null) as any,
      };

      // 后端约束：display_name/group_name/title 不能为空
      if (!item.contact_uid || !item.display_name || !item.group_name || !item.title) {
        return null;
      }

      return item;
    } catch (e) {
      return null;
    }
  }

  public async tryContactsDbSyncByPaths(paths: string[], reason: string, opts?: { quiet?: boolean }): Promise<void> {
    if (!this.isContactsDbSyncEnabledV2()) return;

    const quiet = !!opts?.quiet;

    // shouldTouchBackendNow + vault header 注入（safe 
    const vaultOk = await this.vaultSvc.ensureVaultReadySafe(`contacts:${reason}`);
    if (!vaultOk) return;

    const db = await this.vaultSvc.checkDbReadySafe(`contacts:${reason}`);
    if (!db.ok) return;

    const items: ContactsUpsertItem[] = [];
    for (const p of paths ?? []) {
      const af = this.app.vault.getAbstractFileByPath(p);
      if (!(af instanceof TFile)) continue;
      const it = await this.buildContactUpsertItemFromFile(af);
      if (it) items.push(it);
    }

    if (!items.length) return;

    const payload: ContactsUpsertBatchReq = { items };

    try {
      await this.api.upsertContactsBatch(payload);
      try { this.setBackendDbReady?.(true, ""); } catch {}
      try {
        this.markDbSyncWithCounts("contacts", { ok: true, pendingCount: 0, failedCount: 0 });
      } catch {
        // ignore
      }
    } catch (e: any) {
      const msg =
        (typeof e?.data?.detail === "string" ? e.data.detail : e?.data?.detail?.message) ||
        e?.data?.reason ||
        e?.message ||
        String(e);

      try { this.setBackendDbReady?.(false, String(msg ?? "")); } catch {}
      try {
        this.markDbSyncWithCounts("contacts", {
          ok: false,
          pendingCount: 0,
          failedCount: Math.max(1, items.length),
          err: String(msg ?? ""),
        });
      } catch {
        // ignore
      }
      console.warn("[Contacts][dbSync] upsert-batch failed:", e);
      if (!quiet) {
        new Notice(`Contacts DB 同步失败${String(msg ?? "").slice(0, 120)}`);
      }
    }
  }

  public async tryContactsDbSyncByPath(path: string, reason: string, opts?: { quiet?: boolean }): Promise<void> {
    if (!path) return;
    await this.tryContactsDbSyncByPaths([path], reason, opts);
  }

  public async rebuildContactsIndex(): Promise<{ ok: true; count: number; indexPath: string; parseErrorFiles: string[] } | { ok: false; error: any }> {
    try {
      const r = await this.contactsIndex.rebuildAndWrite();
      return { ok: true, count: r.count, indexPath: r.indexPath, parseErrorFiles: r.parseErrorFiles };
    } catch (e: any) {
      return { ok: false, error: e };
    }
  }

  /** Step C6: rebuild contacts archive index (scan contactsModule.archiveDir) */
  public async rebuildContactsArchiveIndex(): Promise<{ ok: true; count: number; indexPath: string; parseErrorFiles: string[] } | { ok: false; error: any }> {
    try {
      const r = await this.contactsIndex.rebuildArchiveAndWrite();
      return { ok: true, count: r.count, indexPath: r.indexPath, parseErrorFiles: r.parseErrorFiles };
    } catch (e: any) {
      return { ok: false, error: e };
    }
  }

  /** Step C6: rebuild both main + archive indexes */
  public async rebuildContactsAllIndexes(): Promise<
    | { ok: true; main: { count: number; indexPath: string; parseErrorFiles: string[] }; archive: { count: number; indexPath: string; parseErrorFiles: string[] } }
    | { ok: false; error: any }
  > {
    try {
      const r = await this.contactsIndex.rebuildAllAndWrite();
      return { ok: true, main: r.main, archive: r.archive };
    } catch (e: any) {
      return { ok: false, error: e };
    }
  }

  /**
   * Step X2: rebuild contacts indexes then (best-effort) full upsert into DB (contactsDir + archiveDir).
   *
   * - Only runs DB sync when contacts DB sync is enabled AND backend is touchable (via VaultService gate).
   * - Failures must NOT block local rebuild.
   */
  public async rebuildContactsAllIndexesAndFullDbUpsert(opts?: { quiet?: boolean }): Promise<
    | { ok: true; main: { count: number; indexPath: string; parseErrorFiles: string[] }; archive: { count: number; indexPath: string; parseErrorFiles: string[] } }
    | { ok: false; error: any }
  > {
    const quiet = !!opts?.quiet;

    // 1) Rebuild local indexes first (source-of-truth is md)
    const r = await this.rebuildContactsAllIndexes();

    // 2) Best-effort full DB upsert (方案1：contactsDir + archiveDir)
    try {
      if (this.isContactsDbSyncEnabledV2()) {
        const vaultOk = await this.vaultSvc.ensureVaultReadySafe("contacts:rebuild");
        if (vaultOk) {
          const db = await this.vaultSvc.checkDbReadySafe("contacts:rebuild");
          if (db.ok) {
            const allPaths = await this.listAllContactMdPathsForDbSync();
            await this.tryContactsDbSyncByPaths(allPaths, "rebuild", { quiet: true });
          }
        }
      }
    } catch (e: any) {
      // Do NOT block local usage
      if (!quiet) {
        const msg = e?.message ?? String(e);
        new Notice(`Contacts DB 全量同步失败：${String(msg).slice(0, 120)}`);
      }
    }

    return r as any;
  }

  /**
   * Step X2：列举 **contactsDir + archiveDir** 下全部 `C_*.md`（递归），供 DB upsert / `contactsSpecAtomic.buildOps`。
   * §8.5：与 Pipeline 本地 **`rebuildAndWrite`（仅 active、不扫归档）** 范围**有意不一致**，详 `contactsSpecAtomic.ts` 文件头。
   */
  private async listAllContactMdPathsForDbSync(): Promise<string[]> {
    const roots = [
      normalizePath((this.getContactsDir() ?? "").trim() || "90-Contacts"),
      normalizePath((this.getContactsArchiveDir() ?? "").trim() || ""),
    ].filter((p, i, a) => p && a.indexOf(p) === i);

    const out: string[] = [];
    const seen = new Set<string>();

    const walk = (af: any) => {
      if (!af) return;
      if (af instanceof TFile) {
        const p = String(af.path ?? "");
        if (!p) return;
        if (!/\/C_[^\/]+\.md$/i.test(p)) return;
        if (seen.has(p)) return;
        seen.add(p);
        out.push(p);
        return;
      }
      if (af instanceof TFolder) {
        for (const c of af.children ?? []) walk(c);
      }
    };

    for (const root of roots) {
      const af = this.app.vault.getAbstractFileByPath(root);
      walk(af);
    }

    out.sort((a, b) => a.localeCompare(b));
    return out;
  }

  /**
   * UI helper: open contact picker and return a wiki-link reference `[[C_<uid>|Name]]`.
   * Used by:
   * - command palette insert (current editor)
   * - task/project-task modals (append to description)
   */
  public async openContactReferencePicker(onPick: (ref: string, item: ContactIndexItem) => void): Promise<void> {
    try {
      // Read from space-bucketed index dir directly (works even if Contacts panel is never opened).
      const central = this.getSpaceIndexDir();
      const store = new ContactsIndexStore(this.app, () => central);

      const main = await store.readIndex();
      const arch = await store.readArchiveIndex();

      const map = new Map<string, ContactIndexItem>();
      for (const it of (main.items ?? []) as any[]) {
        const uid = String((it as any).contact_uid ?? "").trim();
        if (!uid) continue;
        map.set(uid, it as any);
      }
      for (const it of (arch.items ?? []) as any[]) {
        const uid = String((it as any).contact_uid ?? "").trim();
        if (!uid) continue;
        if (!map.has(uid)) map.set(uid, it as any);
      }

      const items = Array.from(map.values());
      if (items.length === 0) {
        new Notice("Contacts index is empty. Please rebuild contacts index first.");
        return;
      }

      new InsertContactReferenceModal(this.app, this, items, onPick).open();
    } catch (e: any) {
      console.warn("[RSLatte][contacts][insert] open picker failed", e);
      new Notice("Failed to open contact insert modal.");
    }
  }

  /**
   * 项目任务清单文件更新后，刷新该文件对应的联系人互动索引，并重写受影响联系人的笔记内「动态互动」块，使联系人笔记立即显示最新项目任务状态。
   * 在 setProjectTaskStatus / setProjectTaskPhase 等修改项目任务后调用。
   */
  public async refreshContactInteractionsForTasklistFile(tasklistPath: string): Promise<void> {
    const path = String(tasklistPath ?? "").trim();
    if (!path) return;
    try {
      const store = this.contactsIndex?.getInteractionsStore?.();
      if (!store || typeof (store as any).applyFileUpdates !== "function") return;
      const { mtime, entries } = await buildProjectTaskContactEntriesForFile(this.app, path);
      await (store as any).applyFileUpdates({ upserts: [{ source_path: path, mtime, entries }] });
    } catch (e) {
      console.warn("[RSLatte] refreshContactInteractionsForTasklistFile failed", path, e);
    }
  }

  /**
   * 针对单个任务/日记文件刷新 contacts-interactions 并更新受影响联系人的笔记动态块。
   * 在新增任务写入日记后调用，确保新任务立即出现在联系人的「动态互动」与 contacts-interactions.json。
   */
  public async refreshContactInteractionsForTaskFile(taskFilePath: string): Promise<void> {
    const path = String(taskFilePath ?? "").trim();
    if (!path) return;
    try {
      const store = this.contactsIndex?.getInteractionsStore?.();
      if (!store || typeof (store as any).applyFileUpdates !== "function") return;
      const { mtime, entries } = await this.taskRSLatte.buildContactInteractionsForFile(path);
      await (store as any).applyFileUpdates({ upserts: [{ source_path: path, mtime, entries }] });
    } catch (e) {
      console.warn("[RSLatte] refreshContactInteractionsForTaskFile failed", path, e);
    }
  }

  /**
   * 根据最新互动索引重写指定联系人的笔记内「动态互动」块（用于项目任务更新后立即更新联系人笔记）。
   */
  public async refreshContactNoteDynamicBlockForUids(uids: string[]): Promise<void> {
    if (!uids?.length) return;
    try {
      const idx = await this.contactsIndex.getIndexStore().readIndex();
      const items = (idx.items ?? []) as ContactIndexItem[];
      const byUid = new Map<string, ContactIndexItem>();
      for (const it of items) {
        const uid = String(it.contact_uid ?? "").trim();
        if (uid && !byUid.has(uid)) byUid.set(uid, it);
      }
      const store = this.contactsIndex?.getInteractionsStore?.();
      if (!store || typeof (store as any).queryByContactUid !== "function") return;
      const sAny: any = this.settings as any;
      const cm: any = sAny?.contactsModule ?? {};
      const sectionHeader = String(cm.eventSectionHeader ?? cm.manualEventSectionHeader ?? "## 互动记录").trim() || "## 互动记录";
      const subHeader = String(cm.dynamicEventSubHeader ?? "### 动态互动").trim();
      const tp = sAny.taskPanel as TaskPanelSettings;
      for (const uid of uids) {
        const it = byUid.get(uid);
        if (!it?.file_path) continue;
        const af = this.app.vault.getAbstractFileByPath(it.file_path);
        if (!af || !(af instanceof TFile)) continue;
        try {
          const entries = await (store as any).queryByContactUid(uid, { limit: 20, incompleteOnly: false, sourceType: "all" }) as any[];
          const summaryItems = (entries ?? []).map((e: any) => ({
            statusIcon: statusIconForInteractionWithPhase(String(e.status ?? "").trim(), e.task_phase),
            source_type: String(e.source_type ?? "").trim(),
            snippet: String(e.snippet ?? ""),
            source_path: String(e.source_path ?? ""),
            line_no: typeof e.line_no === "number" ? e.line_no : Number(e.line_no ?? 0) || undefined,
            heading: String(e.heading ?? "").trim() || undefined,
            follow_status: e.follow_status === "following" || e.follow_status === "ended" ? e.follow_status : undefined,
            interaction_events: Array.isArray(e.interaction_events) ? e.interaction_events : undefined,
          }));
          await replaceContactDynamicGeneratedBlock(this.app, af, summaryItems, { limit: 20, sectionHeader, subHeader, taskPanel: tp });
        } catch (e) {
          console.warn("[RSLatte] refreshContactNoteDynamicBlockForUids failed for", uid, e);
        }
      }
    } catch (e) {
      console.warn("[RSLatte] refreshContactNoteDynamicBlockForUids failed", e);
    }
  }

  /**
   * 按当前 contacts-interactions 主索引，重写**所有**联系人笔记中的「动态互动」块。
   * 用于侧栏「刷新联系人」等场景：索引已与侧栏一致时，仍可能未回写 md（此前仅增量路径会写块）。
   */
  public async refreshAllContactNoteDynamicBlocks(): Promise<void> {
    try {
      const idx = await this.contactsIndex.getIndexStore().readIndex();
      const uids = [
        ...new Set(
          (idx.items ?? [])
            .map((it) => String((it as ContactIndexItem).contact_uid ?? "").trim())
            .filter(Boolean),
        ),
      ];
      if (uids.length === 0) return;
      await this.refreshContactNoteDynamicBlockForUids(uids);
    } catch (e) {
      console.warn("[RSLatte] refreshAllContactNoteDynamicBlocks failed", e);
    }
  }

  // =========================
  // Contacts: cancel/restore + archive (C6)
  // =========================
  private getContactsDir(): string {
    const sAny: any = this.settings as any;
    return String(sAny?.contactsModule?.contactsDir ?? "90-Contacts");
  }

  private getContactsArchiveDir(): string {
    const sAny: any = this.settings as any;
    const cd = normalizePath((this.getContactsDir() ?? "").trim() || "90-Contacts");
    const defArc = normalizePath(`${cd}/_archived`);
    const v = String(sAny?.contactsModule?.archiveDir ?? "").trim();
    return normalizePath(v || defArc);
  }

  private getContactsArchiveThresholdDays(): number {
    const sAny: any = this.settings as any;
    return normalizeArchiveThresholdDays(sAny?.contactsModule?.archiveThresholdDays ?? 90);
  }

  private isContactsAutoArchiveEnabled(): boolean {
    const sAny: any = this.settings as any;
    return (sAny?.contactsModule?.autoArchiveEnabled ?? false) === true;
  }

  /**
   * Move eligible cancelled contacts into {contactsArchiveDir}/{group}/C_<uid>.md (and best-effort move avatar file).
   * **§8.7**：`batchLimit` 每成功归档 N 个联系人笔记后让出主线程一次（默认不限制）。
   */
  public async archiveContactsNow(opts?: {
    reason?: "manual" | "auto";
    quiet?: boolean;
    skipDbSync?: boolean;
    batchLimit?: number;
  }): Promise<{ moved: number; skipped: number; movedPaths?: string[] }> {
    const reason = opts?.reason ?? "manual";
    const quiet = opts?.quiet === true;
    const skipDbSync = opts?.skipDbSync === true;

    const contactsDir = normalizePath((this.getContactsDir() ?? "").trim() || "90-Contacts");
    const archiveRoot = this.getContactsArchiveDir();
    const days = this.getContactsArchiveThresholdDays();
    const cutoff = (moment as any)().subtract(Math.floor(days), "days");

    // §8.2：归档前主索引（best-effort）
    await runContactsPreArchiveEnsureMainIndex(this);

    const idx = await this.contactsIndex.getIndexStore().readIndex();
    const items = (idx.items ?? []) as any[];

    let moved = 0;
    let skipped = 0;
    const movedPaths: string[] = [];// for DB sync
    const tArchiveMoves = performance.now();

    const exists = async (p: string) => {
      try { return await this.app.vault.adapter.exists(normalizePath(p)); } catch { return false; }
    };

    for (const it of items) {
      const st = String((it as any).status ?? "active").trim() || "active";
      if (st !== "cancelled") { skipped++; continue; }

      const cancelledAt = String((it as any).cancelled_at ?? "").trim();
      if (!cancelledAt) { skipped++; continue; }

      const m = (moment as any)(cancelledAt);
      if (!m.isValid()) { skipped++; continue; }
      // Only archive if cancelled_at <= cutoff
      if (m.isAfter(cutoff)) { skipped++; continue; }

      const srcPath = normalizePath(String((it as any).file_path ?? "").trim());
      if (!srcPath) { skipped++; continue; }
      if (srcPath === archiveRoot || srcPath.startsWith(archiveRoot + "/")) { skipped++; continue; }

      const af = this.app.vault.getAbstractFileByPath(srcPath);
      if (!(af instanceof TFile)) { skipped++; continue; }

      // Preserve relative path under contactsDir: <group>/C_uid.md
      let rel = srcPath;
      if (rel.startsWith(contactsDir + "/")) rel = rel.slice(contactsDir.length + 1);
      const destPath0 = normalizePath(`${archiveRoot}/${rel}`);

      // avoid overwrite
      let destPath = destPath0;
      if (await exists(destPath)) {
        const base = destPath.replace(/\.md$/i, "");
        let i = 2;
        while (await exists(normalizePath(`${base}-${i}.md`))) i++;
        destPath = normalizePath(`${base}-${i}.md`);
      }
      await this.ensureDirForPath(destPath);

      // best-effort: move avatar file (if any) before moving md
      try {
        const srcDir = srcPath.split("/").slice(0, -1).join("/");
        const destDir = destPath.split("/").slice(0, -1).join("/");

        const fmAvatar = (() => {
          try {
            const cache = this.app.metadataCache.getFileCache(af);
            const v = (cache?.frontmatter as any)?.avatar_path;
            return typeof v === "string" ? v.trim() : "";
          } catch {
            return "";
          }
        })();

        const avatarRelFromIndex = String((it as any).avatar_path ?? "").trim();
        const avatarRel = avatarRelFromIndex || fmAvatar;

        const tryMoveAvatar = async (srcAvatar: string, destAvatar: string): Promise<boolean> => {
          try {
            if (await exists(destAvatar)) return true; // already present
            await this.ensureDirForPath(destAvatar);

            // Prefer Obsidian fileManager when the file is indexed as a TFile.
            const aaf = this.app.vault.getAbstractFileByPath(srcAvatar);
            if (aaf instanceof TFile) {
              await this.app.fileManager.renameFile(aaf, destAvatar);
              return true;
            }

            // Fallback: dot-folders (like .attachments) might not be represented as TFile in some cases.
            if (await exists(srcAvatar)) {
              try {
                // Adapter rename (fast path)
                const adapterAny: any = this.app.vault.adapter as any;
                if (typeof adapterAny.rename === "function") {
                  await adapterAny.rename(srcAvatar, destAvatar);
                  return true;
                }
              } catch {
                // ignore
              }

              // Last resort: copy + remove
              try {
                const bin = await this.app.vault.adapter.readBinary(srcAvatar);
                await this.app.vault.adapter.writeBinary(destAvatar, bin);
                await this.app.vault.adapter.remove(srcAvatar);
                return true;
              } catch {
                // ignore
              }
            }
          } catch {
            // ignore
          }
          return false;
        };

        let handled = false;

        // 1) Prefer avatar_path (relative path)
        if (avatarRel && !avatarRel.startsWith("/") && !avatarRel.match(/^[A-Za-z]:\\/)) {
          const srcAvatar = normalizePath(`${srcDir}/${avatarRel}`);
          const destAvatar = normalizePath(`${destDir}/${avatarRel}`);
          if ((await exists(destAvatar)) || (await exists(srcAvatar))) {
            handled = await tryMoveAvatar(srcAvatar, destAvatar);
          }
        }

        // 2) Fallback: scan {srcDir}/.attachments/{uid}.* (png/jpg/jpeg/webp)
        if (!handled) {
          const uidFromItem = String((it as any).contact_uid ?? (it as any).uid ?? "").trim();
          const uidFromPath = (() => {
            const m = srcPath.match(/\/C_([^\/\.]+)\.md$/i);
            return m ? String(m[1]) : "";
          })();
          const uid = uidFromItem || uidFromPath;

          if (uid) {
            const exts = ["png", "jpg", "jpeg", "webp"];
            for (const ext of exts) {
              const srcAvatar = normalizePath(`${srcDir}/.attachments/${uid}.${ext}`);
              if (!(await exists(srcAvatar))) continue;
              const destAvatar = normalizePath(`${destDir}/.attachments/${uid}.${ext}`);
              handled = await tryMoveAvatar(srcAvatar, destAvatar);
              if (handled) break;
            }
          }
        }
      } catch {
        // ignore
      }

      // move md
      await this.app.fileManager.renameFile(af, destPath);

      // Step C8: mark archived_at (best-effort) and collect for DB sync
      try {
        const nowIso = toLocalOffsetIsoString();
        await this.app.fileManager.processFrontMatter(af, (fm) => {
          (fm as any).archived_at = nowIso;
          (fm as any).updated_at = nowIso;
        });
      } catch {}

      movedPaths.push(af.path);

      moved++;
      await yieldIfArchiveBatchBoundary({ batchLimit: opts?.batchLimit, successCount: moved });
    }

    if (this.isDebugLogEnabled()) {
      this.dbg("perf", "archiveContactsNow:move phase", {
        moved,
        skipped,
        movePhaseMs: +(performance.now() - tArchiveMoves).toFixed(1),
        batchLimit: opts?.batchLimit ?? null,
        reason,
      });
    }

    // §8.2：搬迁后固定顺序 — DB 同步（可选）→ 双索引重建 → WorkEvent
    await runContactsPostPhysicalArchiveSteps(this, {
      movedPaths,
      moved,
      reason,
      quiet,
      skipDbSync,
      archiveRoot,
    });

    if (!quiet) {
      new Notice(`Contacts 归档完成：移动${moved} 个（阈值${days} 天，原因=${reason}）`);
    }
    return { moved, skipped, movedPaths };
  }

  /**
   * Auto archive hook (best-effort): run at most once per day when contactsModule.autoArchiveEnabled === true.
   * Only cancelled contacts with cancelled_at older than threshold will be moved.
   * @deprecated 此函数当前未使用，保留以备将来使用
   */
  // @ts-ignore - Reserved for future use
  private async autoArchiveContactsIfNeeded(): Promise<void> {
    const enabled = (this.settings as any)?.moduleEnabledV2?.contacts === true;
    if (!enabled) return;
    if (!this.isContactsAutoArchiveEnabled()) return;

    const key = (moment as any)().format("YYYY-MM-DD");
    const sAny: any = this.settings as any;
    const last = String(sAny?.contactsModule?.archiveLastRunKey ?? "");
    if (last === key) return;

    try {
      const r = await this.pipelineEngine.runE2(this.getSpaceCtx(), "contacts", "auto_archive");
      if (!(r as any)?.ok) return;
      const data: any = (r as any).data;
      if (data?.skipped) return;

      // Persist last-run key
      if (!sAny.contactsModule) sAny.contactsModule = {};
      sAny.contactsModule.archiveLastRunKey = key;
      await this.saveSettings();
      this.refreshSidePanel();
    } catch {
      // ignore
    }
  }

  /**
   * Manual archive diaries (for testing/verification).
   * Same logic as autoArchiveDiariesIfNeeded but without the "once per day" restriction.
   */
  async archiveDiariesNow(): Promise<{ moved: number; scanned: number; cutoff: string }> {
    const days = Number(this.settings.diaryArchiveThresholdDays ?? 0);
    if (!Number.isFinite(days) || days <= 0) {
      return { moved: 0, scanned: 0, cutoff: "" };
    }

    const fmt = String(this.settings.diaryNameFormat ?? "YYYYMMDD").trim() || "YYYYMMDD";
    if (fmt.includes("/")) {
      return { moved: 0, scanned: 0, cutoff: "" };
    }

    const todayKey = this.getTodayKey();
    const monthPattern = String(this.settings.diaryArchiveMonthDirName ?? "YYYYMM").trim() || "YYYYMM";
    const diaryRoot = normalizePath(String(this.settings.diaryPath ?? "").trim()).replace(/\/+$/g, "");
    const prefix = diaryRoot ? (diaryRoot.endsWith("/") ? diaryRoot : `${diaryRoot}/`) : "";

    const cutoff = (moment as any)(todayKey, "YYYY-MM-DD").subtract(days, "days");

    let moved = 0;
    let scanned = 0;
    const movedPairs: Array<{ from: string; to: string }> = [];

    const files = this.app.vault.getMarkdownFiles();
    for (const f of files) {
      if (prefix && !f.path.startsWith(prefix)) continue;

      const rel = prefix ? f.path.slice(prefix.length) : f.path;
      const relNoExt = rel.replace(/\.md$/i, "").replace(/\\/g, "/");

      const d = (moment as any)(relNoExt, fmt, true);
      if (!d.isValid()) continue;
      scanned++;

      if (!d.isBefore(cutoff, "day")) continue;

      const monthDir = d.format(monthPattern);
      const targetDir = diaryRoot ? normalizePath(`${diaryRoot}/${monthDir}`) : normalizePath(monthDir);
      const targetPath = normalizePath(`${targetDir}/${f.basename}.md`);
      if (targetPath === f.path) continue;

      try {
        await this.auditSvc.ensureDirForPath(targetPath);
        const exists = this.app.vault.getAbstractFileByPath(targetPath);
        if (exists && exists instanceof TFile) {
          // avoid overwriting; keep existing file
          continue;
        }
        const from = f.path;
        await this.app.vault.rename(f, targetPath);
        moved++;
        movedPairs.push({ from, to: targetPath });
      } catch (e) {
        // best-effort: ignore per-file failures
        if (this.isDebugLogEnabled()) {
          this.dbg("diaryArchive", "move_failed", { from: f.path, error: (e as any)?.message ?? String(e) });
        }
      }
    }

    // After diary archive, rewrite stored source paths in indexes so UI links won't break.
    // Best-effort: do not block the archive flow.
    if (movedPairs.length > 0) {
      let taskUpdated = 0;
      let contactsUpdated = 0;
      
      try {
        const result = await this.taskRSLatte?.rewriteSourcePaths(movedPairs);
        taskUpdated = result?.updated ?? 0;
        if (this.isDebugLogEnabled() && taskUpdated > 0) {
          this.dbg("diaryArchive", "rewrite_task_index_success", { updated: taskUpdated, moves: movedPairs.length });
        }
      } catch (e) {
        console.warn("[RSLatte][diaryArchive] Failed to rewrite task index paths:", e);
        if (this.isDebugLogEnabled()) {
          this.dbg("diaryArchive", "rewrite_task_index_failed", { error: (e as any)?.message ?? String(e) });
        }
      }
      
      try {
        // 确保联系人索引已初始化
        if (this.contactsIndex) {
          const result = await this.contactsIndex.rewriteInteractionsSourcePaths(movedPairs);
          contactsUpdated = result?.updated ?? 0;
          if (this.isDebugLogEnabled() && contactsUpdated > 0) {
            this.dbg("diaryArchive", "rewrite_contacts_interactions_success", { updated: contactsUpdated, moves: movedPairs.length });
          }
        }
      } catch (e) {
        console.warn("[RSLatte][diaryArchive] Failed to rewrite contacts interactions paths:", e);
        if (this.isDebugLogEnabled()) {
          this.dbg("diaryArchive", "rewrite_contacts_interactions_failed", { error: (e as any)?.message ?? String(e) });
        }
      }

      // Refresh UI once (debounced) so lists show new paths.
      // 延迟刷新以确保索引更新完成
      setTimeout(() => {
        this.refreshSidePanel();
      }, 100);
    }

    return { moved, scanned, cutoff: cutoff.format("YYYY-MM-DD") };
  }

  /**
   * Auto archive hook (best-effort): run at most once per day.
   *
   * Policy:
   * - If diaryArchiveThresholdDays <= 0 => disabled.
   * - Move diary files older than (today - N days) into month folder under diaryPath.
   *   Example: {{diaryPath}}/202509/20250931.md
   * - diaryPath empty => scan whole vault (not recommended, but supported).
   * - diaryNameFormat containing subfolders (e.g. YYYY/MM/DD) is already "month grouped"; in this case we skip auto-archive by default.
   */
  async autoArchiveDiariesIfNeeded(): Promise<void> {
    const days = Number(this.settings.diaryArchiveThresholdDays ?? 0);
    if (!Number.isFinite(days) || days <= 0) return;

    const fmt = String(this.settings.diaryNameFormat ?? "YYYYMMDD").trim() || "YYYYMMDD";
    if (fmt.includes("/")) return;

    const todayKey = this.getTodayKey();
    const last = String(this.settings.diaryArchiveLastRunKey ?? "");
    if (last === todayKey) return;

    const monthPattern = String(this.settings.diaryArchiveMonthDirName ?? "YYYYMM").trim() || "YYYYMM";
    const diaryRoot = normalizePath(String(this.settings.diaryPath ?? "").trim()).replace(/\/+$/g, "");
    const prefix = diaryRoot ? (diaryRoot.endsWith("/") ? diaryRoot : `${diaryRoot}/`) : "";

    const cutoff = (moment as any)(todayKey, "YYYY-MM-DD").subtract(days, "days");

    let moved = 0;
    let scanned = 0;
    const movedPairs: Array<{ from: string; to: string }> = [];

    const files = this.app.vault.getMarkdownFiles();
    for (const f of files) {
      if (prefix && !f.path.startsWith(prefix)) continue;

      const rel = prefix ? f.path.slice(prefix.length) : f.path;
      const relNoExt = rel.replace(/\.md$/i, "").replace(/\\/g, "/");

      const d = (moment as any)(relNoExt, fmt, true);
      if (!d.isValid()) continue;
      scanned++;

      if (!d.isBefore(cutoff, "day")) continue;

      const monthDir = d.format(monthPattern);
      const targetDir = diaryRoot ? normalizePath(`${diaryRoot}/${monthDir}`) : normalizePath(monthDir);
      const targetPath = normalizePath(`${targetDir}/${f.basename}.md`);
      if (targetPath === f.path) continue;

      try {
        await this.auditSvc.ensureDirForPath(targetPath);
        const exists = this.app.vault.getAbstractFileByPath(targetPath);
        if (exists && exists instanceof TFile) {
          // avoid overwriting; keep existing file
          continue;
        }
        const from = f.path;
        await this.app.vault.rename(f, targetPath);
        moved++;
        movedPairs.push({ from, to: targetPath });
      } catch (e) {
        // best-effort: ignore per-file failures
        if (this.isDebugLogEnabled()) {
          this.dbg("diaryArchive", "move_failed", { from: f.path, error: (e as any)?.message ?? String(e) });
        }
      }
    }

    // Persist last-run key even if nothing moved (avoid scanning repeatedly within the same day)
    this.settings.diaryArchiveLastRunKey = todayKey;
    try { await this.saveSettings(); } catch {}

    if (this.isDebugLogEnabled()) {
      this.dbg("diaryArchive", "auto_archive_done", {
        moved,
        scanned,
        days,
        cutoff: cutoff.format("YYYY-MM-DD"),
        diaryRoot,
        monthPattern,
      });
    }

    // After diary auto-archive, rewrite stored source paths in indexes so UI links won't break.
    // Best-effort: do not block the archive flow.
    if (movedPairs.length > 0) {
      let taskUpdated = 0;
      let contactsUpdated = 0;
      
      try {
        const result = await this.taskRSLatte?.rewriteSourcePaths(movedPairs);
        taskUpdated = result?.updated ?? 0;
        if (this.isDebugLogEnabled() && taskUpdated > 0) {
          this.dbg("diaryArchive", "rewrite_task_index_success", { updated: taskUpdated, moves: movedPairs.length });
        }
      } catch (e) {
        console.warn("[RSLatte][diaryArchive] Failed to rewrite task index paths:", e);
        if (this.isDebugLogEnabled()) {
          this.dbg("diaryArchive", "rewrite_task_index_failed", { error: (e as any)?.message ?? String(e) });
        }
      }
      
      try {
        // 确保联系人索引已初始化
        if (this.contactsIndex) {
          const result = await this.contactsIndex.rewriteInteractionsSourcePaths(movedPairs);
          contactsUpdated = result?.updated ?? 0;
          if (this.isDebugLogEnabled() && contactsUpdated > 0) {
            this.dbg("diaryArchive", "rewrite_contacts_interactions_success", { updated: contactsUpdated, moves: movedPairs.length });
          }
        }
      } catch (e) {
        console.warn("[RSLatte][diaryArchive] Failed to rewrite contacts interactions paths:", e);
        if (this.isDebugLogEnabled()) {
          this.dbg("diaryArchive", "rewrite_contacts_interactions_failed", { error: (e as any)?.message ?? String(e) });
        }
      }
      
      // 延迟刷新以确保索引更新完成
      setTimeout(() => {
        this.refreshSidePanel();
      }, 100);
    }
  }




  /**
   * 自动归档输出文件（当 autoArchiveEnabled 启用时）
   * @deprecated 此函数当前未使用，保留以备将来使用
   */
  // @ts-ignore - Reserved for future use
  private async autoArchiveOutputsIfNeeded(): Promise<void> {
    await this.runOutputAutoOp(async () => {
      try {
        const op: any = (this.settings as any).outputPanel ?? {};
        if (!op.autoArchiveEnabled) return;
        const today = (moment as any)().format("YYYY-MM-DD");
        if (String(op.archiveLastRunKey ?? "") === today) return;

        const moved = await this.archiveOutputFilesNow({ reason: "auto_archive" });
        op.archiveLastRunKey = today;
        await this.saveSettings();

        if (moved > 0 && op.enableDbSync) {
          await this.syncOutputFilesToDb({ reason: "auto_archive" });
        }
      } catch (e) {
        console.warn("RSLatte autoArchiveOutputsIfNeeded failed:", e);
      }
    });
  }

  /**
   * 自动归档 RSLatte 索引（当模块启用且配置了自动归档时）
   * @deprecated 此函数当前未使用，保留以备将来使用
   */
  // @ts-ignore - Reserved for future use
  private async autoArchiveRSLatteIndexIfNeeded(): Promise<void> {
    try {
      // Step5：模块关闭时不启用索引归档（与任务管理一致）
      const me: any = (this.settings as any)?.moduleEnabled ?? {};
      if (me.record === false) return;

      // Ensure ready ensures index files exist even if DB sync is disabled
      await this.recordRSLatte.ensureReady();
      await this.recordRSLatte.autoArchiveIfNeeded();
    } catch (e) {
      console.warn("RSLatte autoArchiveRSLatteIndexIfNeeded failed:", e);
    }
  }

  /** small helper for modals: ensure folder exists for a file path */
  async ensureDirForPath(filePath: string): Promise<void> {
    await this.auditSvc.ensureDirForPath(filePath);
  }
}