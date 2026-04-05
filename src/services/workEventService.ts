import { normalizePath, type App } from "obsidian";
import type { RSLattePluginSettings } from "../types/settings";
import type { AuditService } from "./auditService";
import { resolveSpaceBaseDir } from "./space/spaceContext";
import { toLocalOffsetIsoString } from "../utils/localCalendarYmd";
import { normalizeWorkEventSource, type WorkEventSource } from "../types/stats/workEvent";

/**
 * Work Event Stream
 * - append-only JSONL
 * - 仅记录“成功动作”，用于统计子插件读取
 * - 失败不阻断主流程
 */
export type WorkEventKind =
  | "checkin"
  | "finance"
  | "health"
  | "task"
  | "projecttask"
  | "memo"
  | "schedule"
  | "contact"
  | "project"
  | "milestone"
  | "output"
  | "file"
  | "sync"
  | "capture";

export type WorkEventAction =
  | "create"
  | "update"
  | "publish"
  | "recall"
  | "status"
  | "delete"
  | "archive"
  | "cancelled"
  | "done"
  | "start"
  | "recover"
  | "paused"
  | "continued";

export type WorkEvent = {
  /** ISO string */
  ts: string;
  kind: WorkEventKind;
  action: WorkEventAction;
  /** 关联对象信息：task_uid/project_id/file_path 等 */
  ref?: Record<string, any>;
  /** 单行摘要（时间轴直接展示） */
  summary?: string;
  /** 可选数值：amount/delta/count 等 */
  metrics?: Record<string, any>;
  /** 事件来源：ui/auto/reconcile */
  source?: WorkEventSource;
  /** 可选：唯一 id（后续若要去重/追踪可用） */
  event_id?: string;
};

/**
 * 索引文件数据结构
 */
interface EventIndexEntry {
  /** 文件偏移量（字节位置） */
  offset: number;
  /** 事件时间戳（ISO string） */
  ts: string;
  /** 事件类型 */
  kind: WorkEventKind;
  /** 最后更新时间 */
  updated_at?: string;
}

interface MonthIndex {
  /** 月份键（YYYYMM） */
  month: string;
  /** 索引条目列表 */
  events: EventIndexEntry[];
  /** 索引版本 */
  version: number;
  /** 最后更新时间 */
  updated_at: string;
}

/**
 * WorkEvent 事件类型注册表条目
 */
export interface WorkEventRegistryEntry {
  /** 代码位置（文件路径:行号） */
  codeLocation: string;
  /** 模块名称 */
  module: string;
  /** 事件类型 */
  kind: WorkEventKind;
  /** 操作类型 */
  action: WorkEventAction;
  /** 事件来源 */
  source: WorkEventSource;
  /** 说明 */
  description: string;
  /** 注册时间 */
  registeredAt: string;
}

/**
 * WorkEvent 事件类型注册表
 */
export interface WorkEventRegistry {
  /** 注册表版本 */
  version: number;
  /** 最后更新时间 */
  updatedAt: string;
  /** 注册条目列表 */
  entries: WorkEventRegistryEntry[];
}

export class WorkEventService {
  private _ready: Promise<void> | null = null;

  // Month-sharded append writer with best-effort Node handle cache (desktop only).
  private _curMonth: string | null = null;
  private _curPath: string | null = null;
  private _nodeHandle: any | null = null; // fs.promises.FileHandle (desktop)
  private _nodeFs: any | null = null; // require('fs') handle (desktop)
  private _writeChain: Promise<void> = Promise.resolve();

  // 内存缓存：最近读取的索引和事件数据
  private _indexCache: Map<string, MonthIndex> = new Map();
  private _eventCache: Map<string, { events: WorkEvent[]; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存过期时间

  // 事件类型注册表
  private _registry: Map<string, WorkEventRegistryEntry> = new Map();
  private _registryInitialized: boolean = false;

  constructor(
    private app: App,
    private settingsRef: () => RSLattePluginSettings,
    private auditSvc?: AuditService
  ) {
    // 初始化时注册所有已知的事件类型
    this.initializeRegistry();
  }

  /**
   * 生成注册表键（用于快速查找）
   * @private
   */
  private getRegistryKey(kind: WorkEventKind, action: WorkEventAction, source: WorkEventSource): string {
    return `${kind}:${action}:${source}`;
  }

  /**
   * 初始化注册表（注册所有已知的事件类型）
   * @private
   */
  private initializeRegistry(): void {
    if (this._registryInitialized) return;

    // 所有已知的事件类型注册（基于分析报告）
    const knownEvents: Omit<WorkEventRegistryEntry, "registeredAt">[] = [
      { codeLocation: "src/main.ts:1838", module: "打卡管理", kind: "checkin", action: "create", source: "ui", description: "新增打卡" },
      { codeLocation: "src/main.ts:1838", module: "打卡管理", kind: "checkin", action: "delete", source: "ui", description: "取消打卡" },
      { codeLocation: "src/ui/modals/FinanceRecordModal.ts:326", module: "财务管理", kind: "finance", action: "create", source: "ui", description: "创建财务记录" },
      { codeLocation: "src/ui/modals/FinanceRecordModal.ts:326", module: "财务管理", kind: "finance", action: "update", source: "ui", description: "更新财务记录" },
      { codeLocation: "src/ui/modals/FinanceRecordModal.ts:326", module: "财务管理", kind: "finance", action: "delete", source: "ui", description: "删除财务记录" },
      { codeLocation: "src/ui/modals/AddHealthRecordModal.ts", module: "健康管理", kind: "health", action: "create", source: "ui", description: "新增健康记录" },
      { codeLocation: "src/ui/modals/AddHealthRecordModal.ts", module: "健康管理", kind: "health", action: "update", source: "ui", description: "保存健康日/周/月卡片（多指标合并一条事件）" },
      { codeLocation: "src/ui/modals/EditHealthEntryModal.ts", module: "健康管理", kind: "health", action: "update", source: "ui", description: "侧栏修改单条健康记录（独立弹窗）" },
      { codeLocation: "src/ui/views/HealthSidePanelView.ts", module: "健康管理", kind: "health", action: "delete", source: "ui", description: "撤销/删除健康记录（日记取消行）" },
      { codeLocation: "src/taskRSLatte/service.ts:2388", module: "任务管理", kind: "task", action: "create", source: "ui", description: "创建任务" },
      { codeLocation: "src/taskRSLatte/service.ts:2193", module: "任务管理", kind: "task", action: "update", source: "ui", description: "更新任务信息" },
      // { codeLocation: "src/taskRSLatte/service.ts:1945", module: "任务管理", kind: "task", action: "status", source: "ui", description: "任务状态变更（TODO/IN_PROGRESS/DONE）" }, // 已废弃：已拆分为具体的 action（start/continued/done/cancelled/paused）
      { codeLocation: "src/taskRSLatte/service.ts:1945", module: "任务管理", kind: "task", action: "start", source: "ui", description: "任务首次开始" },
      { codeLocation: "src/taskRSLatte/service.ts:1945", module: "任务管理", kind: "task", action: "continued", source: "ui", description: "任务继续（恢复进行中）" },
      { codeLocation: "src/taskRSLatte/service.ts:1945", module: "任务管理", kind: "task", action: "done", source: "ui", description: "任务完成" },
      { codeLocation: "src/taskRSLatte/service.ts:1945", module: "任务管理", kind: "task", action: "cancelled", source: "ui", description: "任务取消" },
      { codeLocation: "src/taskRSLatte/service.ts:1945", module: "任务管理", kind: "task", action: "paused", source: "ui", description: "任务暂停（回到 TODO）" },
      { codeLocation: "src/projectManager/service.ts:1433", module: "项目管理", kind: "projecttask", action: "create", source: "ui", description: "创建项目任务" },
      { codeLocation: "src/projectManager/service.ts:1649", module: "项目管理", kind: "projecttask", action: "update", source: "ui", description: "迁移项目任务" },
      { codeLocation: "src/projectManager/service.ts:1968", module: "项目管理", kind: "projecttask", action: "update", source: "ui", description: "更新项目任务信息" },
      // { codeLocation: "src/projectManager/service.ts:1810", module: "项目管理", kind: "projecttask", action: "status", source: "ui", description: "项目任务状态变更" }, // 已废弃：已拆分为具体的 action（start/continued/done/cancelled/paused）
      { codeLocation: "src/projectManager/service.ts:1810", module: "项目管理", kind: "projecttask", action: "paused", source: "ui", description: "项目任务暂停" },
      { codeLocation: "src/projectManager/service.ts:1810", module: "项目管理", kind: "projecttask", action: "start", source: "ui", description: "项目任务首次开始" },
      { codeLocation: "src/projectManager/service.ts:1810", module: "项目管理", kind: "projecttask", action: "continued", source: "ui", description: "项目任务继续（恢复进行中）" },
      { codeLocation: "src/projectManager/service.ts:1810", module: "项目管理", kind: "projecttask", action: "done", source: "ui", description: "项目任务完成" },
      { codeLocation: "src/projectManager/service.ts:1810", module: "项目管理", kind: "projecttask", action: "cancelled", source: "ui", description: "项目任务取消" },
      { codeLocation: "src/taskRSLatte/service.ts:2444", module: "提醒管理", kind: "memo", action: "create", source: "ui", description: "创建提醒" },
      { codeLocation: "src/taskRSLatte/service.ts:2339", module: "提醒管理", kind: "memo", action: "update", source: "ui", description: "更新提醒" },
      { codeLocation: "src/taskRSLatte/service.ts:2069", module: "提醒管理", kind: "memo", action: "status", source: "ui", description: "提醒状态变更" },
      { codeLocation: "src/taskRSLatte/service.ts:2069", module: "提醒管理", kind: "memo", action: "cancelled", source: "ui", description: "提醒取消" },
      { codeLocation: "src/services/execution/buildExecutionWorkEvents.ts", module: "日程管理", kind: "schedule", action: "create", source: "ui", description: "创建日程" },
      { codeLocation: "src/taskRSLatte/service.ts:updateScheduleBasicInfo", module: "日程管理", kind: "schedule", action: "update", source: "ui", description: "更新日程信息" },
      { codeLocation: "src/ui/modals/EditScheduleModal.ts", module: "日程管理", kind: "schedule", action: "update", source: "ui", description: "更新日程（弹窗保存）" },
      { codeLocation: "src/ui/views/TaskSidePanelView.ts", module: "日程管理", kind: "schedule", action: "done", source: "ui", description: "日程结束" },
      { codeLocation: "src/ui/views/TaskSidePanelView.ts", module: "日程管理", kind: "schedule", action: "cancelled", source: "ui", description: "日程取消" },
      { codeLocation: "src/ui/views/TaskSidePanelView.ts", module: "日程管理", kind: "schedule", action: "status", source: "ui", description: "日程周期/失效状态变更" },
      { codeLocation: "src/ui/views/TaskSidePanelView.ts", module: "日程管理", kind: "schedule", action: "recover", source: "ui", description: "日程恢复" },
      { codeLocation: "src/taskRSLatte/service.ts:applyMemoStatusAction", module: "日程管理", kind: "schedule", action: "status", source: "ui", description: "日程状态变更（侧栏/同步路径）" },
      { codeLocation: "src/taskRSLatte/service.ts:applyMemoStatusAction", module: "日程管理", kind: "schedule", action: "cancelled", source: "ui", description: "日程取消（侧栏/同步路径）" },
      { codeLocation: "src/ui/modals/AddContactModal.ts:761", module: "联系人管理", kind: "contact", action: "create", source: "ui", description: "创建联系人" },
      { codeLocation: "src/ui/modals/EditContactModal.ts:891", module: "联系人管理", kind: "contact", action: "update", source: "ui", description: "更新联系人信息" },
      { codeLocation: "src/ui/modals/EditContactModal.ts:891", module: "联系人管理", kind: "contact", action: "status", source: "ui", description: "联系人状态变更" },
      { codeLocation: "src/ui/views/ContactsSidePanelView.ts:1001", module: "联系人管理", kind: "contact", action: "cancelled", source: "ui", description: "联系人取消" },
      { codeLocation: "src/ui/views/ContactsSidePanelView.ts:1001", module: "联系人管理", kind: "contact", action: "status", source: "ui", description: "联系人状态恢复" },
      { codeLocation: "src/main.ts:2343", module: "联系人管理", kind: "contact", action: "archive", source: "auto", description: "归档联系人（批量）" },
      { codeLocation: "src/main.ts:2343", module: "联系人管理", kind: "contact", action: "archive", source: "ui", description: "归档联系人（批量）" },
      { codeLocation: "src/projectManager/service.ts:674", module: "项目管理", kind: "project", action: "create", source: "ui", description: "创建项目" },
      { codeLocation: "src/projectManager/service.ts:838", module: "项目管理", kind: "project", action: "update", source: "ui", description: "更新项目信息" },
      { codeLocation: "src/projectManager/service.ts:1279", module: "项目管理", kind: "project", action: "done", source: "ui", description: "项目完成" },
      { codeLocation: "src/projectManager/service.ts:1333", module: "项目管理", kind: "project", action: "cancelled", source: "ui", description: "项目取消" },
      { codeLocation: "src/projectManager/service.ts:923", module: "项目管理", kind: "project", action: "start", source: "ui", description: "项目开始" },
      { codeLocation: "src/projectManager/service.ts:1348", module: "项目管理", kind: "project", action: "recover", source: "ui", description: "项目恢复（从 cancelled 恢复到 in-progress）" },
      { codeLocation: "src/projectManager/service.ts:944", module: "项目管理", kind: "milestone", action: "create", source: "ui", description: "创建里程碑" },
      { codeLocation: "src/projectManager/service.ts:1165", module: "项目管理", kind: "milestone", action: "update", source: "ui", description: "更新里程碑（重命名/改级别/改父级）" },
      { codeLocation: "src/projectManager/service.ts:1228", module: "项目管理", kind: "milestone", action: "update", source: "ui", description: "更新里程碑（重命名）" },
      // { codeLocation: "src/projectManager/service.ts:1068", module: "项目管理", kind: "milestone", action: "status", source: "ui", description: "里程碑状态变更" }, // 已废弃：已拆分为具体的 action（done/cancelled/recover）
      { codeLocation: "src/projectManager/service.ts:1068", module: "项目管理", kind: "milestone", action: "done", source: "ui", description: "里程碑完成" },
      { codeLocation: "src/projectManager/service.ts:1068", module: "项目管理", kind: "milestone", action: "cancelled", source: "ui", description: "里程碑取消" },
      { codeLocation: "src/projectManager/service.ts:1068", module: "项目管理", kind: "milestone", action: "recover", source: "ui", description: "里程碑恢复（恢复到 active）" },
      { codeLocation: "src/ui/modals/CreateOutputDocModal.ts:258", module: "输出管理", kind: "output", action: "create", source: "ui", description: "创建输出" },
      { codeLocation: "src/ui/modals/EditOutputMetaModal.ts", module: "输出管理", kind: "output", action: "update", source: "ui", description: "修正输出 frontmatter（✏️）" },
      { codeLocation: "src/ui/modals/PublishToKnowledgeModal.ts", module: "输出管理", kind: "output", action: "publish", source: "ui", description: "发布到知识库（30-Knowledge）" },
      { codeLocation: "src/ui/modals/RecallOutputFromKnowledgeModal.ts", module: "输出管理", kind: "output", action: "recall", source: "ui", description: "从知识库打回输出（迁回存档目录）" },
      { codeLocation: "src/outputRSLatte/service.ts:324", module: "输出管理", kind: "output", action: "update", source: "auto", description: "输出文件更新（检测到文件修改时间变化）" },
      // { codeLocation: "src/ui/views/OutputSidePanelView.ts:147", module: "输出管理", kind: "output", action: "status", source: "ui", description: "输出状态变更（todo/in-progress/done）" }, // 已废弃：已拆分为具体的 action（start/continued/done/cancelled/paused/recover）
      { codeLocation: "src/ui/views/OutputSidePanelView.ts:145", module: "输出管理", kind: "output", action: "start", source: "ui", description: "输出开始（首次开始）" },
      { codeLocation: "src/ui/views/OutputSidePanelView.ts:145", module: "输出管理", kind: "output", action: "continued", source: "ui", description: "输出继续（恢复进行中）" },
      { codeLocation: "src/ui/views/OutputSidePanelView.ts:145", module: "输出管理", kind: "output", action: "done", source: "ui", description: "输出完成" },
      { codeLocation: "src/ui/views/OutputSidePanelView.ts:145", module: "输出管理", kind: "output", action: "cancelled", source: "ui", description: "输出取消" },
      { codeLocation: "src/ui/views/OutputSidePanelView.ts:145", module: "输出管理", kind: "output", action: "paused", source: "ui", description: "输出暂停（从 in-progress 到 todo）" },
      { codeLocation: "src/ui/views/OutputSidePanelView.ts:145", module: "输出管理", kind: "output", action: "recover", source: "ui", description: "输出恢复待办（从 done/cancelled 到 todo）" },
      { codeLocation: "src/plugin/outputManager.ts:426", module: "输出管理", kind: "output", action: "archive", source: "auto", description: "归档输出（批量）" },
      { codeLocation: "src/plugin/journalWriter.ts; CaptureView; modals", module: "快速记录", kind: "capture", action: "create", source: "ui", description: "快速记录：加入待整理 / 三合一新建任务·提醒·日程" },
      { codeLocation: "src/ui/views/CaptureView.ts; journalWriter", module: "快速记录", kind: "capture", action: "update", source: "ui", description: "快速记录：打开整理、刷新、输入转今日任务等" },
      { codeLocation: "src/plugin/journalWriter.ts", module: "快速记录", kind: "capture", action: "done", source: "ui", description: "待整理标为已整理 / 计时结束生成日程" },
      { codeLocation: "src/plugin/journalWriter.ts", module: "快速记录", kind: "capture", action: "cancelled", source: "ui", description: "待整理标为取消" },
      { codeLocation: "src/plugin/journalWriter.ts", module: "快速记录", kind: "capture", action: "paused", source: "ui", description: "待整理标为暂不处理 / 计时暂停" },
      { codeLocation: "src/ui/views/CaptureView.ts", module: "快速记录", kind: "capture", action: "start", source: "ui", description: "专注计时开始" },
      { codeLocation: "src/ui/views/CaptureView.ts", module: "快速记录", kind: "capture", action: "continued", source: "ui", description: "专注计时继续" },
      { codeLocation: "src/plugin/journalWriter.ts", module: "快速记录", kind: "capture", action: "recover", source: "ui", description: "待整理恢复为待处理" },
    ];

    for (const entry of knownEvents) {
      const key = this.getRegistryKey(entry.kind, entry.action, entry.source);
      this._registry.set(key, {
        ...entry,
        registeredAt: toLocalOffsetIsoString(),
      });
    }

    this._registryInitialized = true;
  }

  /**
   * 注册新的事件类型（在写入前必须先注册）
   * @param entry 事件类型注册信息
   * @returns 是否注册成功（如果已存在则返回 false）
   */
  registerEventType(entry: Omit<WorkEventRegistryEntry, "registeredAt">): boolean {
    const key = this.getRegistryKey(entry.kind, entry.action, entry.source);
    if (this._registry.has(key)) {
      // 已存在，可以选择更新或返回 false
      return false;
    }
    this._registry.set(key, {
      ...entry,
      registeredAt: toLocalOffsetIsoString(),
    });
    return true;
  }

  /**
   * 检查事件类型是否已注册
   * @param kind 事件类型
   * @param action 操作类型
   * @param source 事件来源
   * @returns 是否已注册
   */
  isEventTypeRegistered(kind: WorkEventKind, action: WorkEventAction, source: WorkEventSource): boolean {
    const key = this.getRegistryKey(kind, action, source);
    return this._registry.has(key);
  }

  /**
   * 获取事件类型注册信息
   * @param kind 事件类型
   * @param action 操作类型
   * @param source 事件来源
   * @returns 注册信息，如果未注册则返回 undefined
   */
  getEventTypeInfo(kind: WorkEventKind, action: WorkEventAction, source: WorkEventSource): WorkEventRegistryEntry | undefined {
    const key = this.getRegistryKey(kind, action, source);
    return this._registry.get(key);
  }

  /**
   * 获取所有已注册的事件类型
   * @returns 注册表副本
   */
  getRegistry(): WorkEventRegistry {
    return {
      version: 1,
      updatedAt: toLocalOffsetIsoString(),
      entries: Array.from(this._registry.values()),
    };
  }

  /**
   * 导出注册表（供后端参考）
   * @returns JSON 格式的注册表
   */
  exportRegistry(): string {
    const registry = this.getRegistry();
    return JSON.stringify(registry, null, 2);
  }

  /**
   * 将注册表保存到文件（供后端参考）
   * @param filePath 保存路径，默认为工作事件目录下的 registry.json
   * @returns 是否保存成功
   */
  async saveRegistryToFile(filePath?: string): Promise<boolean> {
    if (!this.isEnabled()) return false;
    
    try {
      const adapter: any = this.app.vault.adapter as any;
      const targetPath = filePath || this.resolveRegistryPath();
      
      await this.ensureDirForPath(targetPath);
      
      const registry = this.getRegistry();
      const content = JSON.stringify(registry, null, 2);
      
      if (typeof adapter?.write === "function") {
        await adapter.write(targetPath, content);
        return true;
      }
    } catch (e: any) {
      try {
        await this.auditSvc?.appendAuditLog({
          action: "WORK_EVENT_REGISTRY_SAVE_FAILED",
          err: String(e?.message ?? e),
          path: filePath,
        });
      } catch {
        // ignore
      }
    }
    return false;
  }

  /**
   * 解析注册表文件路径
   * @private
   */
  private resolveRegistryPath(): string {
    const legacy = this.getLegacyWorkEventPath();
    const parts = legacy.split("/").filter(Boolean);
    parts.pop(); // 移除文件名，只保留目录
    const dir = parts.join("/");
    return normalizePath(`${dir}/work-events-registry.json`);
  }

  /**
   * 按条件查询注册表
   * @param filter 筛选条件
   * @returns 匹配的注册条目列表
   */
  queryRegistry(filter?: {
    kind?: WorkEventKind[];
    action?: WorkEventAction[];
    source?: WorkEventSource[];
    module?: string[];
  }): WorkEventRegistryEntry[] {
    let entries = Array.from(this._registry.values());

    if (filter) {
      if (filter.kind && filter.kind.length > 0) {
        entries = entries.filter((e) => filter.kind!.includes(e.kind));
      }
      if (filter.action && filter.action.length > 0) {
        entries = entries.filter((e) => filter.action!.includes(e.action));
      }
      if (filter.source && filter.source.length > 0) {
        entries = entries.filter((e) => filter.source!.includes(e.source));
      }
      if (filter.module && filter.module.length > 0) {
        entries = entries.filter((e) => filter.module!.includes(e.module));
      }
    }

    return entries;
  }

  isEnabled(): boolean {
    const s = this.settingsRef() as any;
    return s?.workEventEnabled !== false;
  }

  /** Legacy single file path (used to infer base dir + prefix): <spaceBase>/<workEventRelPath> */
  private getLegacyWorkEventPath(): string {
    const s = this.settingsRef() as any;
    // F2: bucket by space -> workevents live under <centralRoot>/<spaceId>/.events
    const base = resolveSpaceBaseDir(this.settingsRef() as any);
    const rel = String(s?.workEventRelPath ?? ".events/work-events.jsonl").trim() || ".events/work-events.jsonl";
    return normalizePath(`${base}/${rel}`);
  }

  /** Resolve sharded path: <dir>/<prefix>-YYYYMM.jsonl */
  private resolveShardPath(monthKey: string): string {
    const legacy = this.getLegacyWorkEventPath();
    const parts = legacy.split("/").filter(Boolean);
    const file = parts.pop() ?? "work-events.jsonl";
    const dir = parts.join("/");
    const prefix = String(file).replace(/\.jsonl$/i, "") || "work-events";
    const shardName = `${prefix}-${monthKey}.jsonl`;
    return normalizePath(`${dir}/${shardName}`);
  }

  /** Resolve index path: <dir>/<prefix>-YYYYMM.idx */
  private resolveIndexPath(monthKey: string): string {
    const legacy = this.getLegacyWorkEventPath();
    const parts = legacy.split("/").filter(Boolean);
    const file = parts.pop() ?? "work-events.jsonl";
    const dir = parts.join("/");
    const prefix = String(file).replace(/\.jsonl$/i, "") || "work-events";
    const indexName = `${prefix}-${monthKey}.idx`;
    return normalizePath(`${dir}/${indexName}`);
  }

  /**
   * 生成本地时区的 ISO 格式时间戳（而不是 UTC）
   * 例如：2026-01-22T00:38:00+08:00（而不是 2026-01-21T16:38:00Z）
   * 
   * 这是一个静态方法，可以在外部调用，用于生成 WorkEvent 的时间戳
   */
  static toLocalISOString(date?: Date): string {
    return toLocalOffsetIsoString(date ?? new Date());
  }

  /**
   * 将 UTC 时间戳转换为本地时区的 ISO 格式
   * 如果已经是本地时区格式（包含时区偏移），则直接返回
   */
  private convertToLocalISOString(ts: string): string {
    // 如果已经是本地时区格式（包含 + 或 - 时区偏移），直接返回
    if (/[+-]\d{2}:\d{2}$/.test(ts)) {
      return ts;
    }
    
    // 如果是 UTC 格式（以 Z 结尾），转换为本地时区
    if (ts.endsWith('Z')) {
      const date = new Date(ts);
      return WorkEventService.toLocalISOString(date);
    }
    
    // 其他格式，尝试解析并转换
    try {
      const date = new Date(ts);
      if (!isNaN(date.getTime())) {
        return WorkEventService.toLocalISOString(date);
      }
    } catch {
      // ignore
    }
    
    // 无法解析，返回原值
    return ts;
  }

  private toMonthKey(isoTs: string): string {
    const d = new Date(isoTs);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const mm = m < 10 ? `0${m}` : String(m);
    return `${y}${mm}`;
  }

  private getNodeFs(): any | null {
    if (this._nodeFs) return this._nodeFs;
    try {
      const req = (globalThis as any)?.require ?? (window as any)?.require;
      if (typeof req !== "function") return null;
      const fs = req("fs");
      if (fs && fs.promises) {
        this._nodeFs = fs;
        return fs;
      }
    } catch {
      // ignore
    }
    return null;
  }

  private async closeNodeHandle(): Promise<void> {
    const h: any = this._nodeHandle;
    this._nodeHandle = null;
    this._curMonth = null;
    this._curPath = null;
    try {
      if (h && typeof h.close === "function") await h.close();
    } catch {
      // ignore
    }
  }

  private async ensureNodeHandleFor(monthKey: string, shardPath: string): Promise<any | null> {
    const adapter: any = this.app.vault.adapter as any;
    const fs = this.getNodeFs();
    if (!fs) return null;
    if (typeof adapter?.getFullPath !== "function") return null;

    // Switch month/path => close old handle.
    if (this._curMonth !== monthKey || this._curPath !== shardPath || !this._nodeHandle) {
      await this.closeNodeHandle();
      try {
        const full = adapter.getFullPath(shardPath);
        this._nodeHandle = await fs.promises.open(full, "a");
        this._curMonth = monthKey;
        this._curPath = shardPath;
      } catch {
        await this.closeNodeHandle();
        return null;
      }
    }
    return this._nodeHandle;
  }

  private async ensureDirForPath(filePath: string) {
    const adapter: any = this.app.vault.adapter as any;
    const parts = filePath.split("/").filter(Boolean);
    if (parts.length <= 1) return;
    const dir = parts.slice(0, -1).join("/");
    try {
      if (adapter?.mkdir) await adapter.mkdir(dir);
    } catch {
      // ignore
    }
  }

  /**
   * 确保事件流文件存在（创建空文件）。
   * 仅用于启动时/首次写入前的“就绪”。失败不阻断。
   */
  async ensureReady(): Promise<void> {
    if (!this.isEnabled()) return;
    if (this._ready) return this._ready;

    this._ready = (async () => {
      const adapter: any = this.app.vault.adapter as any;
      // Ensure current month shard exists (best-effort, never blocks).
      const nowIso = toLocalOffsetIsoString();
      const monthKey = this.toMonthKey(nowIso);
      const path = this.resolveShardPath(monthKey);
      try {
        await this.ensureDirForPath(path);
        const exists = typeof adapter?.exists === "function" ? await adapter.exists(path) : false;
        if (!exists && typeof adapter?.write === "function") {
          await adapter.write(path, "");
        }
      } catch (e: any) {
        // optional audit
        try {
          await this.auditSvc?.appendAuditLog({
            action: "WORK_EVENT_ENSURE_FAILED",
            err: String(e?.message ?? e),
            path,
          });
        } catch {
          // ignore
        }
      }
    })();

    return this._ready;
  }

  /**
   * 读取或创建索引文件
   * @private
   */
  private async loadIndex(monthKey: string): Promise<MonthIndex | null> {
    // 先检查内存缓存
    const cached = this._indexCache.get(monthKey);
    if (cached) return cached;

    const adapter: any = this.app.vault.adapter as any;
    const indexPath = this.resolveIndexPath(monthKey);

    try {
      if (typeof adapter?.read === "function") {
        const exists = typeof adapter?.exists === "function" ? await adapter.exists(indexPath) : false;
        if (exists) {
          const content = await adapter.read(indexPath);
          const index = JSON.parse(content) as MonthIndex;
          // 验证版本和格式
          if (index && index.month === monthKey && Array.isArray(index.events)) {
            this._indexCache.set(monthKey, index);
            return index;
          }
        }
      }
    } catch {
      // ignore
    }

    // 如果索引不存在，返回空索引
    const emptyIndex: MonthIndex = {
      month: monthKey,
      events: [],
      version: 1,
      updated_at: toLocalOffsetIsoString(),
    };
    return emptyIndex;
  }

  /**
   * 保存索引文件
   * @private
   */
  private async saveIndex(monthKey: string, index: MonthIndex): Promise<void> {
    const adapter: any = this.app.vault.adapter as any;
    const indexPath = this.resolveIndexPath(monthKey);

    try {
      index.updated_at = toLocalOffsetIsoString();
      await this.ensureDirForPath(indexPath);
      
      if (typeof adapter?.write === "function") {
        await adapter.write(indexPath, JSON.stringify(index, null, 2));
        // 更新内存缓存
        this._indexCache.set(monthKey, index);
        // 清除事件缓存（索引已更新）
        this._eventCache.delete(monthKey);
      }
    } catch (e: any) {
      // ignore errors, but log if audit service available
      try {
        await this.auditSvc?.appendAuditLog({
          action: "WORK_EVENT_INDEX_SAVE_FAILED",
          err: String(e?.message ?? e),
          path: indexPath,
        });
      } catch {
        // ignore
      }
    }
  }

  /**
   * 获取文件当前大小（用于计算偏移量）
   * @private
   */
  private async getFileSize(path: string): Promise<number> {
    const adapter: any = this.app.vault.adapter as any;
    try {
      if (typeof adapter?.read === "function") {
        const exists = typeof adapter?.exists === "function" ? await adapter.exists(path) : false;
        if (exists) {
          const content = await adapter.read(path);
          return content ? content.length : 0;
        }
      }
    } catch {
      // ignore
    }
    return 0;
  }

  /** append one event (JSONL). failure never blocks */
  async append(event: Omit<WorkEvent, "ts"> & { ts?: string }): Promise<void> {
    if (!this.isEnabled()) return;
    const adapter: any = this.app.vault.adapter as any;

    // Serialize writes to keep JSONL append order stable.
    this._writeChain = this._writeChain
      .then(async () => {
        const sourceValue: WorkEventSource = normalizeWorkEventSource(event.source); // 默认 ui；历史 mobile 并入 ui
        
        // ✅ 确保时间戳使用本地时区格式
        // 如果传入的是 UTC 时间戳（以 Z 结尾），自动转换为本地时区
        const eventTs = event.ts ?? WorkEventService.toLocalISOString();
        const localTs = this.convertToLocalISOString(eventTs);

        let eid = String(event.event_id ?? "").trim();
        if (!eid) {
          try {
            const c: any = typeof crypto !== "undefined" ? crypto : null;
            if (c && typeof c.randomUUID === "function") eid = c.randomUUID();
          } catch {
            eid = "";
          }
        }
        if (!eid) eid = `t:${Date.now()}:${Math.random().toString(36).slice(2, 12)}`;

        const record: WorkEvent = {
          ts: localTs,
          kind: event.kind,
          action: event.action,
          ref: event.ref,
          summary: event.summary,
          metrics: event.metrics,
          source: sourceValue,
          event_id: eid,
        };

        // ✅ 验证事件类型是否已注册（写入前必须注册）
        const isRegistered = this.isEventTypeRegistered(record.kind, record.action, sourceValue);
        if (!isRegistered) {
          // 未注册的事件类型：记录警告但不阻断写入（向后兼容）
          // 建议：在添加新的 workEvent 写入前，先在 initializeRegistry 中注册
          try {
            await this.auditSvc?.appendAuditLog({
              action: "WORK_EVENT_UNREGISTERED",
              kind: record.kind,
              action2: record.action,
              source: sourceValue,
              message: `未注册的事件类型: ${record.kind}:${record.action}:${sourceValue}，请在 workEventService.ts 的 initializeRegistry 中注册`,
            });
          } catch {
            // ignore
          }
          // 开发模式下在控制台输出警告
          if ((globalThis as any).__DEV__) {
            console.warn(
              `[RSLatte] ⚠️ 未注册的 WorkEvent 类型: ${record.kind}:${record.action}:${sourceValue}`,
              "\n请在 workEventService.ts 的 initializeRegistry() 方法中注册此事件类型"
            );
          }
        }

        const line = JSON.stringify(record) + "\n";
        const monthKey = this.toMonthKey(record.ts);
        const path = this.resolveShardPath(monthKey);

        try {
          await this.ensureDirForPath(path);

          // 获取写入前的文件大小（作为偏移量）
          const offset = await this.getFileSize(path);

          // Desktop fast path: Node fs handle cache (append without repeated ensure/exists).
          const h = await this.ensureNodeHandleFor(monthKey, path);
          if (h && typeof h.write === "function") {
            await h.write(line);
            // 更新索引
            await this.updateIndexForAppend(monthKey, offset, record);
            return;
          }

          // Generic path: Obsidian adapter append.
          await this.ensureReady();
          if (typeof adapter?.append === "function") {
            // Some adapters require file exists.
            try {
              const exists = typeof adapter?.exists === "function" ? await adapter.exists(path) : true;
              if (!exists && typeof adapter?.write === "function") await adapter.write(path, "");
            } catch {
              // ignore
            }
            await adapter.append(path, line);
            // 更新索引
            await this.updateIndexForAppend(monthKey, offset, record);
            return;
          }

          // Fallback: read + write (slow, but safe)
          if (typeof adapter?.read === "function" && typeof adapter?.write === "function") {
            let cur = "";
            try {
              cur = await adapter.read(path);
            } catch {
              cur = "";
            }
            await adapter.write(path, cur + line);
            // 更新索引
            await this.updateIndexForAppend(monthKey, cur.length, record);
          }
        } catch (e: any) {
          try {
            await this.auditSvc?.appendAuditLog({
              action: "WORK_EVENT_APPEND_FAILED",
              err: String(e?.message ?? e),
              path,
              kind: (event as any)?.kind,
              action2: (event as any)?.action,
            });
          } catch {
            // ignore
          }
        }
      })
      .catch(() => {
        // keep chain alive
      });

    return this._writeChain;
  }

  /**
   * 更新索引（追加新事件时）
   * @private
   */
  private async updateIndexForAppend(monthKey: string, offset: number, event: WorkEvent): Promise<void> {
    try {
      const index = await this.loadIndex(monthKey);
      if (!index) return;

      // 添加新的索引条目
      index.events.push({
        offset,
        ts: event.ts,
        kind: event.kind,
      });

      // 保存索引（异步，不阻塞）
      void this.saveIndex(monthKey, index);
    } catch {
      // ignore errors
    }
  }

  /** best-effort close (desktop node handle) */
  async close(): Promise<void> {
    await this.closeNodeHandle();
  }

  /**
   * 读取最新的工作事件条目（用于工作台操作日志）
   * @param limit 返回的最大条目数，默认 20
   */
  async readLatestEvents(limit: number = 20): Promise<WorkEvent[]> {
    if (!this.isEnabled()) return [];
    
    try {
      const adapter: any = this.app.vault.adapter as any;
      const nowIso = toLocalOffsetIsoString();
      const monthKey = this.toMonthKey(nowIso);
      const path = this.resolveShardPath(monthKey);
      
      // 读取当前月份的事件文件
      let content = "";
      try {
        if (typeof adapter?.read === "function") {
          const exists = typeof adapter?.exists === "function" ? await adapter.exists(path) : false;
          if (exists) {
            content = await adapter.read(path);
          }
        }
      } catch {
        // ignore
      }

      // 解析 JSONL 格式
      const lines = content.split("\n").filter((line: string) => line.trim());
      const events: WorkEvent[] = [];
      
      // 从后往前读取（最新的在前）
      for (let i = lines.length - 1; i >= 0 && events.length < limit; i--) {
        try {
          const event = JSON.parse(lines[i]) as WorkEvent;
          if (event && event.ts) {
            events.unshift(event); // 保持时间顺序（旧的在前）
          }
        } catch {
          // ignore invalid lines
        }
      }

      // 如果当前月份的事件不足，尝试读取上个月的文件
      if (events.length < limit) {
        try {
          const prevMonth = new Date();
          prevMonth.setMonth(prevMonth.getMonth() - 1);
          const prevMonthKey = this.toMonthKey(toLocalOffsetIsoString(prevMonth));
          const prevPath = this.resolveShardPath(prevMonthKey);
          
          let prevContent = "";
          if (typeof adapter?.read === "function") {
            const exists = typeof adapter?.exists === "function" ? await adapter.exists(prevPath) : false;
            if (exists) {
              prevContent = await adapter.read(prevPath);
            }
          }

          const prevLines = prevContent.split("\n").filter((line: string) => line.trim());
          for (let i = prevLines.length - 1; i >= 0 && events.length < limit; i--) {
            try {
              const event = JSON.parse(prevLines[i]) as WorkEvent;
              if (event && event.ts) {
                events.unshift(event);
              }
            } catch {
              // ignore invalid lines
            }
          }
        } catch {
          // ignore
        }
      }

      // 按时间倒序排列（最新的在前）
      return events.slice(-limit).reverse();
    } catch (e) {
      console.warn("[RSLatte] readLatestEvents failed:", e);
      return [];
    }
  }

  /**
   * 读取指定月份的事件文件内容（使用索引优化）
   * @private
   */
  private async readMonthEvents(monthKey: string, useIndex: boolean = true): Promise<WorkEvent[]> {
    if (!this.isEnabled()) return [];

    // 检查内存缓存
    const cached = this._eventCache.get(monthKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.events;
    }

    const adapter: any = this.app.vault.adapter as any;
    const path = this.resolveShardPath(monthKey);

    // 如果使用索引且索引存在，尝试增量读取
    if (useIndex) {
      const index = await this.loadIndex(monthKey);
      if (index && index.events.length > 0) {
        try {
          // 使用索引进行快速读取
          const events = await this.readEventsWithIndex(path, index, adapter);
          // 更新缓存
          this._eventCache.set(monthKey, { events, timestamp: Date.now() });
          return events;
        } catch {
          // 如果索引读取失败，回退到全量读取
        }
      }
    }

    // 回退到全量读取（兼容模式）
    let content = "";
    try {
      if (typeof adapter?.read === "function") {
        const exists = typeof adapter?.exists === "function" ? await adapter.exists(path) : false;
        if (exists) {
          content = await adapter.read(path);
        }
      }
    } catch {
      // ignore
    }
    const lines = content.split("\n").filter((line: string) => line.trim());
    const events: WorkEvent[] = [];
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as WorkEvent;
        if (event && event.ts) {
          events.push(event);
        }
      } catch {
        // ignore invalid lines
      }
    }
    
    // 更新缓存
    this._eventCache.set(monthKey, { events, timestamp: Date.now() });
    return events;
  }

  /**
   * 使用索引读取事件（增量读取）
   * @private
   */
  private async readEventsWithIndex(
    path: string,
    index: MonthIndex,
    adapter: any
  ): Promise<WorkEvent[]> {
    const events: WorkEvent[] = [];
    
    // 如果索引为空，返回空数组
    if (!index.events || index.events.length === 0) {
      return events;
    }

    // 读取整个文件（对于小文件，直接读取可能更快）
    // 对于大文件，可以使用索引来只读取需要的部分
    let content = "";
    try {
      if (typeof adapter?.read === "function") {
        const exists = typeof adapter?.exists === "function" ? await adapter.exists(path) : false;
        if (exists) {
          content = await adapter.read(path);
        }
      }
    } catch {
      return events;
    }

    // 使用索引来验证和快速解析
    const lines = content.split("\n").filter((line: string) => line.trim());
    
    // 如果索引条目数与行数匹配，使用索引来快速验证
    if (index.events.length === lines.length) {
      for (let i = 0; i < lines.length; i++) {
        try {
          const event = JSON.parse(lines[i]) as WorkEvent;
          const indexEntry = index.events[i];
          
          // 验证时间戳和类型是否匹配
          if (event && event.ts && event.ts === indexEntry.ts && event.kind === indexEntry.kind) {
            events.push(event);
          } else {
            // 如果不匹配，回退到解析整行
            if (event && event.ts) {
              events.push(event);
            }
          }
        } catch {
          // ignore invalid lines
        }
      }
    } else {
      // 索引不匹配，重新构建索引或直接解析
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as WorkEvent;
          if (event && event.ts) {
            events.push(event);
          }
        } catch {
          // ignore invalid lines
        }
      }
      
      // 如果索引过期，可以选择重建索引（这里暂时不自动重建，避免阻塞）
    }

    return events;
  }

  /**
   * 重建索引（用于索引损坏或过期的情况）
   * @param monthKey 月份键（YYYYMM），如果为空则重建当前月份
   */
  async rebuildIndex(monthKey?: string): Promise<void> {
    if (!this.isEnabled()) return;
    
    if (!monthKey) {
      const nowIso = toLocalOffsetIsoString();
      monthKey = this.toMonthKey(nowIso);
    }
    
    await this.rebuildIndexInternal(monthKey);
  }

  /**
   * 重建索引（内部实现）
   * @private
   */
  private async rebuildIndexInternal(monthKey: string): Promise<void> {
    const adapter: any = this.app.vault.adapter as any;
    const path = this.resolveShardPath(monthKey);
    
    try {
      let content = "";
      if (typeof adapter?.read === "function") {
        const exists = typeof adapter?.exists === "function" ? await adapter.exists(path) : false;
        if (!exists) return;
        content = await adapter.read(path);
      }

      const lines = content.split("\n").filter((line: string) => line.trim());
      const index: MonthIndex = {
        month: monthKey,
        events: [],
        version: 1,
        updated_at: toLocalOffsetIsoString(),
      };

      let offset = 0;
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as WorkEvent;
          if (event && event.ts) {
            index.events.push({
              offset,
              ts: event.ts,
              kind: event.kind,
            });
          }
        } catch {
          // ignore invalid lines
        }
        offset += line.length + 1; // +1 for newline
      }

      await this.saveIndex(monthKey, index);
    } catch {
      // ignore errors
    }
  }

  /**
   * 生成月份键列表（从指定日期向前回溯）
   * @private
   */
  private generateMonthKeys(fromDate: Date, maxMonths: number): string[] {
    const keys: string[] = [];
    const current = new Date(fromDate);
    for (let i = 0; i < maxMonths; i++) {
      keys.push(this.toMonthKey(toLocalOffsetIsoString(current)));
      current.setMonth(current.getMonth() - 1);
    }
    return keys;
  }

  /**
   * 支持跨月份读取最新事件
   * @param limit 返回的最大条目数，默认 20
   * @param maxMonths 最多向前查找的月份数，默认 3
   */
  async readLatestEventsAcrossMonths(limit: number = 20, maxMonths: number = 3): Promise<WorkEvent[]> {
    if (!this.isEnabled()) return [];
    try {
      const now = new Date();
      const monthKeys = this.generateMonthKeys(now, maxMonths);
      const allEvents: WorkEvent[] = [];
      
      // 读取所有月份的事件
      for (const monthKey of monthKeys) {
        const events = await this.readMonthEvents(monthKey);
        allEvents.push(...events);
      }
      
      // 按时间戳倒序排列（最新的在前）
      allEvents.sort((a, b) => b.ts.localeCompare(a.ts));
      
      // 返回前 limit 条
      return allEvents.slice(0, limit);
    } catch (e) {
      console.warn("[RSLatte] readLatestEventsAcrossMonths failed:", e);
      return [];
    }
  }

  /**
   * 按日期范围查询事件
   * @param startDate 开始日期（包含）
   * @param endDate 结束日期（包含）
   * @param spaceIds 可选：指定空间ID列表
   */
  async readEventsByDateRange(
    startDate: Date,
    endDate: Date,
    spaceIds?: string[]
  ): Promise<WorkEvent[]> {
    if (!this.isEnabled()) return [];
    try {
      // 生成日期范围内的所有月份键
      const monthKeys = new Set<string>();
      const current = new Date(startDate);
      const end = new Date(endDate);
      
      while (current <= end) {
        monthKeys.add(this.toMonthKey(toLocalOffsetIsoString(current)));
        current.setMonth(current.getMonth() + 1);
      }
      
      const allEvents: WorkEvent[] = [];
      
      // 读取所有月份的事件
      for (const monthKey of Array.from(monthKeys)) {
        const events = await this.readMonthEvents(monthKey);
        allEvents.push(...events);
      }
      
      // 按时间范围过滤（须用时间数值比较：事件 ts 常为本地偏移 ISO，与 toISOString() 的 Z 混用字符串比较会误判）
      const startMs = startDate.getTime();
      const endMs = endDate.getTime();
      let filtered = allEvents.filter((e) => {
        const t = Date.parse(String(e.ts ?? ""));
        return Number.isFinite(t) && t >= startMs && t <= endMs;
      });
      
      // 按空间过滤（如果指定）
      if (spaceIds && spaceIds.length > 0) {
        filtered = filtered.filter((e) => {
          // 从文件路径推断空间ID
          const refPath = e.ref?.file_path || "";
          // 假设空间ID可以从路径中提取（例如：<spaceId>/...）
          // 这里需要根据实际的空间路径结构来实现
          // 暂时使用简单的路径匹配
          return spaceIds.some((spaceId) => refPath.includes(`/${spaceId}/`) || refPath.startsWith(`${spaceId}/`));
        });
      }
      
      // 按时间戳倒序排列（最新的在前）
      filtered.sort((a, b) => {
        const ta = Date.parse(String(a.ts ?? ""));
        const tb = Date.parse(String(b.ts ?? ""));
        const na = Number.isFinite(ta) ? ta : 0;
        const nb = Number.isFinite(tb) ? tb : 0;
        return nb - na;
      });

      return filtered;
    } catch (e) {
      console.warn("[RSLatte] readEventsByDateRange failed:", e);
      return [];
    }
  }

  /**
   * 按条件筛选查询事件
   * @param filter 筛选条件
   */
  async readEventsByFilter(filter: {
    kind?: WorkEventKind[];
    action?: WorkEventAction[];
    spaceIds?: string[];
    startDate?: Date;
    endDate?: Date;
    limit?: number;
  }): Promise<WorkEvent[]> {
    if (!this.isEnabled()) return [];
    try {
      let events: WorkEvent[] = [];
      
      // 如果指定了日期范围，使用日期范围查询
      if (filter.startDate && filter.endDate) {
        events = await this.readEventsByDateRange(
          filter.startDate,
          filter.endDate,
          filter.spaceIds
        );
      } else {
        // 否则读取最近的事件（默认最近3个月）
        const now = new Date();
        const monthKeys = this.generateMonthKeys(now, 3);
        for (const monthKey of monthKeys) {
          const monthEvents = await this.readMonthEvents(monthKey);
          events.push(...monthEvents);
        }
      }
      
      // 按 kind 过滤
      if (filter.kind && filter.kind.length > 0) {
        events = events.filter((e) => filter.kind!.includes(e.kind));
      }
      
      // 按 action 过滤
      if (filter.action && filter.action.length > 0) {
        events = events.filter((e) => filter.action!.includes(e.action));
      }
      
      // 按空间过滤（如果指定）
      if (filter.spaceIds && filter.spaceIds.length > 0) {
        events = events.filter((e) => {
          const refPath = e.ref?.file_path || "";
          return filter.spaceIds!.some((spaceId) => 
            refPath.includes(`/${spaceId}/`) || refPath.startsWith(`${spaceId}/`)
          );
        });
      }
      
      // 按时间戳倒序排列（最新的在前）
      events.sort((a, b) => b.ts.localeCompare(a.ts));
      
      // 应用 limit
      if (filter.limit && filter.limit > 0) {
        events = events.slice(0, filter.limit);
      }
      
      return events;
    } catch (e) {
      console.warn("[RSLatte] readEventsByFilter failed:", e);
      return [];
    }
  }
}
