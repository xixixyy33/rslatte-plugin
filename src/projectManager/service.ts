import { Notice, TFile, TFolder, normalizePath, moment } from "obsidian";
import type { App, TAbstractFile } from "obsidian";
import type { RSLattePluginSettings } from "../types/settings";
import type { RSLatteApiClient } from "../api";
import { genFileId, genProjectId } from "../utils/id";
import { patchYamlFrontmatterText, readFrontmatter } from "../utils/frontmatter";
import { parseMilestoneNodes, parseMilestonesAndCounts, hasMilestoneHeading, parseTaskItems, DEFAULT_MILESTONE_PATH } from "./parser";
import type { ProjectEntry, ProjectSnapshot, ProjectStatus, ProjectTaskItem } from "./types";
import { applyProjectSnapshotDerivatives } from "./projectDerivatives";
import { getTaskTodayKey } from "../taskRSLatte/task/taskTags";
import { buildDescPrefix, TASK_DESC_PREFIX_STRIP_RE } from "../taskRSLatte/parser";
import { ProjectIndexStore } from "../projectRSLatte/indexStore";
import { ProjectSyncQueue } from "../projectRSLatte/syncQueue";
import { archiveProjectIndexByMonths } from "../projectRSLatte/archiver";
import type { ProjectRSLatteIndexItem } from "../projectRSLatte/types";
import { reconcileTaskDisplayPhase, toIsoNow, todayYmd as todayYmd2, monthKeyFromYmd, isYmd as isYmd2, safeJsonParse } from "../taskRSLatte/utils";
import type { WorkEventService } from "../services/workEventService";
import { resolveSpaceIndexDir, resolveSpaceQueueDir } from "../services/space/spaceContext";
import { enrichWorkEventRefWithTaskContacts } from "../services/contacts/taskWorkEventContactRef";
import { toLocalOffsetIsoString } from "../utils/localCalendarYmd";
import { normalizeArchiveThresholdDays } from "../constants/defaults";
import { runProjectPostPhysicalArchiveSteps } from "../services/pipeline/helpers/archiveOrchestration";
import { yieldIfArchiveBatchBoundary } from "../utils/archiveBatchYield";
import {
  assertCanMarkPendingArchive,
  getRecoverProjectTransition,
  isProjectEligibleForFolderArchiveByStatus,
  isProjectTerminalForCoerceInProgress,
  normalizeProjectStatus,
} from "./projectStatus";

/**
 * 一级里程碑轨上的「下一步」任务（`applyProjectSnapshotDerivatives` 写入 `is_next_action_for_l1`）。
 * - 除「新建单条任务」外：在 **`refreshDirty` 之前** 从当前快照 `prevItem` 读取，避免完成后衍生把该位清空导致误记为 false。
 * - **新建单条任务**：在 **`refreshDirty` 之后** 用新 `task_id` 从刷新后的快照读取。
 */
function snapshotIsNextActionForL1(item: ProjectTaskItem | undefined | null): boolean {
  return Boolean(item?.is_next_action_for_l1);
}

/** 项目任务 WorkEvent.ref：写入 contact_uids_strong / contact_uids_weak 供联系人互动从 WorkEvent 重放 */
function enrichProjectTaskWorkEventRef(
  ref: Record<string, any>,
  lines: string[],
  lineIdx: number,
  item?: ProjectTaskItem,
  weakExtra?: string[]
): Record<string, any> {
  const line = String(lines[lineIdx] ?? "");
  const fromItem = ((item?.follow_contact_uids ?? []) as string[]).map((u) => String(u ?? "").trim()).filter(Boolean);
  const extra = (weakExtra ?? []).map((u) => String(u ?? "").trim()).filter(Boolean);
  const merged = [...new Set([...fromItem, ...extra])];
  return enrichWorkEventRefWithTaskContacts(ref, { taskLine: line, followContactUids: merged });
}

type Host = {
  app: App;
  api: RSLatteApiClient;
  settingsRef: () => RSLattePluginSettings;
  saveSettings: () => Promise<boolean>;
  refreshSidePanel: () => void;
  /** ✅ Work Event Stream（仅记录成功动作，用于统计子插件读取） */
  workEventSvc?: WorkEventService;
  // 侧边栏状态灯：模块级同步状态（pending/failed/ok）
  reportDbSyncWithCounts?: (meta: { pendingCount?: number; failedCount?: number; ok?: boolean; err?: string }) => void;
  /** 插件 manifest.version，与侧栏 hydrate 快照 `schemaVersion` 对齐（第八节） */
  getPluginVersion?: () => string;
};

/** 项目任务索引行 → 与任务清单一致的展示阶段（WorkEvent / Today 核对） */
function projectTaskRowPhase(t: ProjectTaskItem | undefined): string {
  if (!t) return "todo";
  return reconcileTaskDisplayPhase(String(t.statusName ?? ""), t.task_phase, {
    wait_until: t.wait_until,
    follow_up: t.follow_up,
  });
}

/** 契约 §十三：`project_info.meta_sync` 白名单 */
function buildProjectInfoMetaSyncForDb(p: ProjectEntry): Record<string, unknown> | undefined {
  const schema_version = 1;
  const o: Record<string, unknown> = { schema_version };
  const tags = Array.isArray((p as any).project_tags) ? ((p as any).project_tags as string[]) : [];
  const slim = tags.map((x) => String(x).trim().slice(0, 64)).filter(Boolean).slice(0, 48);
  if (slim.length) o.project_tags = slim;
  const zh = String((p as any).project_status_display_zh ?? "").trim();
  if (zh) o.project_status_display_zh = zh.slice(0, 128);
  if (Object.keys(o).length <= 1) return undefined;
  return o;
}

/** 契约 §十三：`project_task_item.meta_sync`（项目内任务行） */
function buildProjectTaskItemMetaSyncForDb(it: ProjectTaskItem): Record<string, unknown> | undefined {
  const schema_version = 1;
  const o: Record<string, unknown> = { schema_version };
  const ls = (it as any).linked_schedule_uids;
  if (Array.isArray(ls) && ls.length) {
    o.linked_schedule_uids = ls
      .map((x: unknown) => String(x ?? "").trim())
      .filter(Boolean)
      .slice(0, 32);
  }
  if (Object.keys(o).length <= 1) return undefined;
  return o;
}

const MIN_REFRESH_INTERVAL_MS = 20_000; // 防抖/节流底线
const MAX_DIRTY_PER_TICK = 8;
/** 启动增量清 dirty 时防止异常死循环 */
const MAX_STARTUP_DIRTY_DRAIN_ROUNDS = 500;

const PANEL_HYDRATE_FILENAME = "project-panel-hydrate.json";

function chunk<T>(arr: T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size || 1));
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function todayYmd(): string {
  try {
    // Obsidian 内置 moment
    // @ts-ignore
    const m = (window as any).moment?.();
    if (m?.format) return m.format("YYYY-MM-DD");
  } catch {}
  const d = new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function isYmd(s: any): boolean {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
}

/** 一级里程碑「即将超期」天数，与设置及 `applyProjectSnapshotDerivatives` 一致 */
function progressMilestoneUpcomingDaysFromSettings(s: RSLattePluginSettings | null | undefined): number {
  const pp = (s as any)?.projectPanel ?? {};
  return Math.max(0, Math.min(30, Number(pp.progressMilestoneUpcomingDays ?? 3) || 3));
}

/** 项目概要「即将超期」天数（第九节 9.4），与 `applyProjectSnapshotDerivatives` 一致 */
function progressProjectUpcomingDaysFromSettings(s: RSLattePluginSettings | null | undefined): number {
  const pp = (s as any)?.projectPanel ?? {};
  return Math.max(0, Math.min(30, Number(pp.progressProjectUpcomingDays ?? 5) || 5));
}

function escapeRegExp(s: string): string {
  return String(s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function norm(p: string): string {
  return normalizePath((p ?? "").trim());
}

function isUnder(path: string, root: string): boolean {
  const p = norm(path);
  const r = norm(root);
  if (!p || !r) return false;
  return p === r || p.startsWith(r + "/");
}

async function safeRead(app: App, file: TFile): Promise<string> {
  try {
    return await app.vault.read(file);
  } catch {
    return "";
  }
}

/** 里程碑 rslatte meta 键输出顺序（与延期、状态变更共用） */
const MILESTONE_META_KEY_ORDER: string[] = [
  "milestone_status",
  "ts",
  "milestone_created_date",
  "milestone_done_date",
  "milestone_cancelled_date",
  "milestone_planned_end",
  "milestone_weight",
  "milestone_original_planned_end",
  "milestone_postpone_count",
  "milestone_postpone_reason",
];

function clampMilestoneWeightInput(v: unknown): number | undefined {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return undefined;
  return Math.min(100, Math.max(1, n));
}

function parseRslatteMilestoneKvFromLine(line: string): Record<string, string> | null {
  const mm = String(line ?? "").match(/<!--\s*rslatte:([\s\S]*?)-->/i);
  if (!mm?.[1]) return null;
  const body = mm[1].replace(/\s+/g, " ").trim();
  const kv: Record<string, string> = {};
  body.split(/[;\s]+/).forEach((seg) => {
    const eq = seg.indexOf("=");
    if (eq > 0) kv[seg.slice(0, eq).trim()] = seg.slice(eq + 1).trim();
  });
  return kv;
}

function buildMilestoneRslatteMetaComment(kv: Record<string, string>): string {
  const parts: string[] = [];
  for (const k of MILESTONE_META_KEY_ORDER) {
    const v = kv[k];
    if (v !== undefined && v !== "") parts.push(`${k}=${v}`);
  }
  for (const k of Object.keys(kv)) {
    if (!MILESTONE_META_KEY_ORDER.includes(k)) parts.push(`${k}=${kv[k]}`);
  }
  return `<!-- rslatte:${parts.join(";")} -->`;
}

export class ProjectManagerService {
  private _snapshot: ProjectSnapshot = { projects: [], updatedAt: 0 };
  private _byFolder = new Map<string, ProjectEntry>();
  
  // ✅ 内存优化：快照访问时间戳（用于过期清理）
  private snapshotLastAccess = 0;
  
  // ✅ 快照过期时间：5分钟（300000毫秒）
  private readonly SNAPSHOT_EXPIRE_MS = 5 * 60 * 1000;

  // v23：项目中央索引/队列/归档
  private _idxStore: ProjectIndexStore | null = null;
  private _syncQueue: ProjectSyncQueue | null = null;
  private _syncMetaById: Map<string, { status?: string; syncedAt?: string; lastError?: string; pendingOps?: number }> = new Map();
  private _syncInFlight = false;
  private _syncDebounce: number | null = null;
  private _indexDebounce: number | null = null;
  private _syncCooldownUntil = 0; // ms timestamp

  private _timer: number | null = null;
  private _dirtyFolders = new Set<string>();
  /** ensureReady 完整启动流程只跑一遍，并发 await 共享同一 Promise（避免重复 refresh / 重复挂 vault 监听） */
  private _ensureReadyPromise: Promise<void> | null = null;
  /** 本轮插件生命周期内 ensureReady 是否已成功跑完（用于侧栏 SWR：仅首次未完成前可灌 hydrate） */
  private _ensureReadySettled = false;
  private _vaultListenersRegistered = false;
  private _refreshInFlight = false;
  private _refreshOwner: "auto" | "manual" | "other" | null = null;
  private _pendingFull = false;
  private _pendingFullTimer: number | null = null;
  private _lastRefreshStartedAt = 0;

  constructor(private host: Host) {}

  /** 与插件设置 `debugLogEnabled` 一致，供性能诊断日志使用 */
  private isDebugLogEnabled(): boolean {
    return !!(this.host.settingsRef() as any)?.debugLogEnabled;
  }

  private dbg(...args: any[]) {
    if (!this.isDebugLogEnabled()) return;
    console.log("[rslatte][projectMgr]", ...args);
  }

  private dbgw(...args: any[]) {
    if (!this.isDebugLogEnabled()) return;
    console.warn("[rslatte][projectMgr]", ...args);
  }

  /**
   * Best-effort: bump/update the project task meta line's ts=... and optional estimate_h/complexity.
   * - Prefer the immediate next-line meta bound to the task_id.
   * - Otherwise, update the first meta line in the file that contains the same task_id.
   * - If not found, insert a new meta line immediately under the task line.
   */
  private bumpProjectTaskMetaTsInLines(
    lines: string[],
    taskIdx: number,
    taskId?: string,
    extra?: { estimateH?: number; complexity?: "high" | "normal" | "light" }
  ): boolean {
    const tid = String(taskId ?? "").trim();
    if (!tid) return false;

    const isRSLatteMeta = (l: string) => /^\s*<!--\s*rslatte:/i.test(String(l ?? ""));
    const hasTid = (l: string) => String(l ?? "").includes(`task_id=${tid}`);
    const now = toIsoNow();

    const patchLine = (line: string): string => {
      let out = line;
      if (!/ts\s*=\s*/i.test(out)) {
        out = out.replace(/-->\s*$/, `;ts=${now} -->`);
      } else {
        out = out.replace(/ts\s*=\s*[^;>\s]+/i, `ts=${now}`);
      }
      if (extra?.estimateH != null && Number(extra.estimateH) > 0) {
        const val = String(Math.round(Number(extra.estimateH)));
        if (out.includes("estimate_h=")) {
          out = out.replace(/estimate_h\s*=\s*[^;>\s]+/i, `estimate_h=${val}`);
        } else {
          out = out.replace(/-->\s*$/, `;estimate_h=${val} -->`);
        }
      }
      if (extra?.complexity && (extra.complexity === "high" || extra.complexity === "light")) {
        if (out.includes("complexity=")) {
          out = out.replace(/complexity\s*=\s*[^;>\s]+/i, `complexity=${extra.complexity}`);
        } else {
          out = out.replace(/-->\s*$/, `;complexity=${extra.complexity} -->`);
        }
      }
      return out;
    };

    // 1) preferred: immediate next-line meta
    if (taskIdx + 1 < lines.length && isRSLatteMeta(lines[taskIdx + 1]) && hasTid(lines[taskIdx + 1])) {
      const old = lines[taskIdx + 1];
      const neu = patchLine(old);
      if (neu !== old) lines[taskIdx + 1] = neu;
      return neu !== old;
    }

    // 2) find any meta line containing task_id
    for (let i = 0; i < lines.length; i++) {
      if (!isRSLatteMeta(lines[i])) continue;
      if (!hasTid(lines[i])) continue;
      const old = lines[i];
      const neu = patchLine(old);
      if (neu !== old) lines[i] = neu;
      return neu !== old;
    }

    // 3) insert a new meta line under the task line
    const indent = String(lines[taskIdx] ?? "").match(/^\s*/)?.[0] ?? "";
    const parts = [`task_id=${tid}`, `type=project_task`, `ts=${now}`];
    if (extra?.estimateH != null && Number(extra.estimateH) > 0) parts.push(`estimate_h=${Math.round(Number(extra.estimateH))}`);
    if (extra?.complexity && (extra.complexity === "high" || extra.complexity === "light")) parts.push(`complexity=${extra.complexity}`);
    lines.splice(taskIdx + 1, 0, `${indent}  <!-- rslatte:${parts.join(";")} -->`);
    return true;
  }

  /**
   * 合并任意 meta 键值到项目任务下一行 meta；若 progress_note 在 patch 中，调用方应已做 \s+ -> \u200B 编码。
   */
  private patchProjectTaskMetaInLines(
    lines: string[],
    taskIdx: number,
    taskId: string | undefined,
    patch: Record<string, string>
  ): boolean {
    const tid = String(taskId ?? "").trim();
    if (!tid || Object.keys(patch).length === 0) return false;

    const isRSLatteMeta = (l: string) => /^\s*<!--\s*rslatte:/i.test(String(l ?? ""));
    const hasTid = (l: string) => String(l ?? "").includes(`task_id=${tid}`);

    const parseMetaLine = (line: string): Map<string, string> => {
      const m = line.match(/<!--\s*rslatte:([^>]*)-->/i);
      const body = (m?.[1] ?? "").trim();
      const map = new Map<string, string>();
      const parts = body.split(";").map((s) => s.trim()).filter(Boolean);
      for (const part of parts) {
        const eq = part.indexOf("=");
        if (eq <= 0) continue;
        const k = part.slice(0, eq).trim();
        const v = part.slice(eq + 1).trim();
        map.set(k, v);
      }
      return map;
    };

    const buildMetaLine = (indent: string, map: Map<string, string>): string => {
      const order = ["task_id", "type", "ts", "task_phase", "wait_until", "follow_up", "follow_contact_uids", "follow_contact_name", "progress_note", "progress_updated", "postpone_count", "original_due", "starred", "estimate_h", "complexity"];
      const seen = new Set<string>();
      const parts: string[] = [];
      for (const k of order) {
        const v = map.get(k);
        if (v != null) { parts.push(`${k}=${v}`); seen.add(k); }
      }
      for (const [k, v] of map) {
        if (!seen.has(k)) parts.push(`${k}=${v}`);
      }
      return `${indent}  <!-- rslatte:${parts.join(";")} -->`;
    };

    let metaIdx = -1;
    if (taskIdx + 1 < lines.length && isRSLatteMeta(lines[taskIdx + 1]) && hasTid(lines[taskIdx + 1])) {
      metaIdx = taskIdx + 1;
    } else {
      for (let i = 0; i < lines.length; i++) {
        if (!isRSLatteMeta(lines[i])) continue;
        if (!hasTid(lines[i])) continue;
        metaIdx = i;
        break;
      }
    }
    if (metaIdx < 0) return false;

    const indent = String(lines[taskIdx] ?? "").match(/^\s*/)?.[0] ?? "";
    const map = parseMetaLine(lines[metaIdx]);
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined && v !== null) map.set(k, String(v));
    }
    const newLine = buildMetaLine(indent, map);
    if (newLine !== lines[metaIdx]) {
      lines[metaIdx] = newLine;
      return true;
    }
    return false;
  }

  /**
   * 更新项目信息文件的 frontmatter：写入最后更新进展时间 progress_updated（ISO）。
   * 在新增/更新里程碑、新增/更新项目任务时调用。
   */
  private async bumpProjectInfoProgressUpdated(folder: string): Promise<void> {
    const p = this._byFolder.get(folder);
    const infoPath = p?.infoFilePath || norm(`${folder}/项目信息.md`);
    const af = this.host.app.vault.getAbstractFileByPath(infoPath);
    if (!af || !(af instanceof TFile)) return;
    try {
      await this.host.app.fileManager.processFrontMatter(af, (fm) => {
        (fm as Record<string, unknown>)["progress_updated"] = toIsoNow();
      });
    } catch {
      // best-effort，不阻断主流程
    }
  }

  /**
   * ✅ 内存优化：清理过期的快照（项目快照较小，但也可以清理以减少内存占用）
   */
  private cleanupExpiredSnapshots(): void {
    const now = Date.now();
    // 项目快照相对较小，但如果超过5分钟未访问，也可以清理 _byFolder 映射
    if (now - this.snapshotLastAccess > this.SNAPSHOT_EXPIRE_MS) {
      // 清理 _byFolder 映射（快照本身保留，因为项目列表通常不会很大）
      this._byFolder.clear();
    }
  }

  /**
   * ✅ 内存优化：手动清理所有快照（供内存紧张时调用）
   */
  public clearAllSnapshots(): void {
    this._snapshot = { projects: [], updatedAt: 0 };
    this._byFolder.clear();
    this.snapshotLastAccess = 0;
    this._ensureReadyPromise = null;
    this._ensureReadySettled = false;
    void this.removePanelHydrateFileBestEffort();
  }

  /** @internal 项目管理侧栏 SWR：避免二次打开用磁盘快照覆盖已刷新内存 */
  public isEnsureReadySettled(): boolean {
    return this._ensureReadySettled;
  }

  public getSnapshot(): ProjectSnapshot {
    // ✅ 内存优化：清理过期快照
    this.cleanupExpiredSnapshots();
    
    // ✅ UI consistency: always reflect latest DB sync meta in snapshot.
    //
    // Reason:
    // - Backend/queue status can change without any file mtime change (e.g. URL 恢复后重试成功).
    // - refreshDirty() may keep cached ProjectEntry objects, so the UI can otherwise keep showing
    //   a stale "Failed to fetch" even after the queue has been drained.
    //
    // We mutate the cached snapshot in-place (cheap) so views can immediately render updated sync status.
    try {
      const dbSyncEnabled = this.isDbSyncEnabled();
      for (const p of (this._snapshot.projects ?? []) as any[]) {
        const pid = String(p?.projectId ?? p?.project_id ?? "").trim();
        if (!dbSyncEnabled) {
          // when module db sync is off: hide any stale badges
          delete p.dbSyncStatus;
          delete p.dbSyncedAt;
          delete p.dbLastError;
          delete p.dbPendingOps;
          continue;
        }
        const meta = this._syncMetaById.get(pid);
        if (meta) {
          p.dbSyncStatus = meta.status;
          p.dbSyncedAt = meta.syncedAt;
          p.dbLastError = meta.lastError;
          p.dbPendingOps = meta.pendingOps;
        } else {
          // meta missing => clear to avoid stale display
          delete p.dbSyncStatus;
          delete p.dbSyncedAt;
          delete p.dbLastError;
          delete p.dbPendingOps;
        }
      }
    } catch {
      // ignore
    }
    
    this.snapshotLastAccess = Date.now();
    return this._snapshot;
  }

  /**
   * 手动触发：刷新项目清单 + 强制触发一次 DB 同步。
   *
   * 说明：用户点击“刷新”按钮时，期望能看到 /projects/upsert 等网络请求。
   * 这里不依赖“索引是否变化”的差异判断，直接显式入队并 force flush。
   */
  public async manualRefreshAndSync(): Promise<void> {
    // 与任务管理一致：自动刷新进行中时，手动刷新直接提示并退出
    if (this._refreshInFlight && this._refreshOwner === "auto") {
      new Notice("项目自动刷新正在进行中，手动刷新失败");
      return;
    }
    // 手动刷新应该使用增量刷新，而不是全量扫描
    // 如果用户需要全量重建索引，应该使用"扫描重建"按钮
    await this.manualRefreshIncrementalAndSync();
  }

  /**
   * Step3：侧边栏「🔄 刷新」使用增量更新 + 同步。
   * - 增量：仅处理 dirty folders（由 vault 事件标记）
   * - 同步：仅同步索引差异（不强制全量入队）
   */
  public async manualRefreshIncrementalAndSync(): Promise<void> {
    if (this._refreshInFlight && this._refreshOwner === "auto") {
      new Notice("项目自动刷新正在进行中，手动刷新失败");
      return;
    }
    await this.refreshDirty({ reason: "manual_refresh" });
    if (!this.isDbSyncEnabled()) {
      new Notice("项目数据库同步未开启");
      return;
    }
    // 立即做一次差异检测 + 入队，并 force flush（但不 forceEnqueue 全量）
    await this.persistIndexAndEnqueueSync({ forceEnqueue: false, forceDue: true });
    await this.flushSyncQueue({ force: true });
  }

  public async ensureReady(): Promise<void> {
    if (!this._ensureReadyPromise) {
      const run = (async () => {
        const tAll = performance.now();
        if (this.isDebugLogEnabled()) this.dbg("perf", "ensureReady:start");
        await this.ensureProjectRSLatteReady();
        if (this.isDebugLogEnabled()) {
          this.dbg("perf", "ensureReady:after ensureProjectRSLatteReady", { ms: +(performance.now() - tAll).toFixed(1) });
        }
        // 启动时：一次 readIndex 同时判断「是否有数据」并供标脏使用（F1，避免重复读盘）
        // 有数据则标脏并循环 refreshDirty 直至清空（F4 / 8-3）
        // 无数据则全量扫描
        const indexItems = await this.readProjectIndexItems();
        const hasIndexData = (indexItems?.length ?? 0) > 0;
        if (this.isDebugLogEnabled()) {
          this.dbg("perf", "ensureReady:after readProjectIndexItems (merged)", {
            hasIndexData,
            itemCount: indexItems?.length ?? 0,
            msSinceStart: +(performance.now() - tAll).toFixed(1),
          });
        }
        if (!hasIndexData) {
          const tFull = performance.now();
          await this.refreshAll({ reason: "startup" });
          if (this.isDebugLogEnabled()) {
            this.dbg("perf", "ensureReady:branch refreshAll done", {
              ms: +(performance.now() - tFull).toFixed(1),
              _byFolderSize: this._byFolder.size,
            });
          }
        } else {
          const tInc = performance.now();
          await this.markIndexFoldersDirtyFromItemsThenDrain(indexItems!);
          if (this.isDebugLogEnabled()) {
            this.dbg("perf", "ensureReady:branch markIndex+refreshDirty drain done", {
              ms: +(performance.now() - tInc).toFixed(1),
              _byFolderSize: this._byFolder.size,
            });
          }
        }
        this.registerVaultListeners();
        this._ensureReadySettled = true;
        if (this.isDebugLogEnabled()) {
          this.dbg("perf", "ensureReady:total", {
            ms: +(performance.now() - tAll).toFixed(1),
            _byFolderSize: this._byFolder.size,
            remainingDirtyFolders: this._dirtyFolders.size,
            maxDirtyPerTick: MAX_DIRTY_PER_TICK,
          });
        }
      })();
      this._ensureReadyPromise = run.catch((e) => {
        this._ensureReadyPromise = null;
        this._ensureReadySettled = false;
        throw e;
      });
    }
    return this._ensureReadyPromise;
  }

  /** 读取中央索引 items（无 store 或失败返回 null）— ensureReady / 标脏 / checkIndexHasData 共用 */
  private async readProjectIndexItems(): Promise<ProjectRSLatteIndexItem[] | null> {
    try {
      if (!this._idxStore) return null;
      const t0 = performance.now();
      const idx = await this._idxStore.readIndex();
      const items = idx.items ?? [];
      if (this.isDebugLogEnabled()) {
        this.dbg("perf", "readProjectIndexItems", {
          itemCount: items.length,
          readIndexMs: +(performance.now() - t0).toFixed(1),
        });
      }
      return items;
    } catch {
      return null;
    }
  }

  /** 侧栏/后台路径：索引是否有数据（单独读盘，非 ensureReady 热路径） */
  public async checkIndexHasData(): Promise<boolean> {
    const items = await this.readProjectIndexItems();
    return (items?.length ?? 0) > 0;
  }

  /**
   * 从已读取的索引项标脏，并循环 refreshDirty 直至 dirty 清空（第八节 F4 / 8-3）。
   */
  private async markIndexFoldersDirtyFromItemsThenDrain(items: ProjectRSLatteIndexItem[]): Promise<void> {
    const tAll = performance.now();
    try {
      const settings = this.host.settingsRef();
      const root = norm(settings.projectRootDir);
      const archive = norm(settings.projectArchiveDir);

      let markedDirty = 0;
      for (const it of items) {
        const folderPath = String((it as any).folder_path ?? "").trim();
        if (!folderPath) continue;
        if (!root || !isUnder(folderPath, root)) continue;
        if (archive && isUnder(folderPath, archive)) continue;

        const folderAf = this.host.app.vault.getAbstractFileByPath(folderPath);
        if (folderAf && folderAf instanceof TFolder) {
          this._dirtyFolders.add(folderPath);
          markedDirty++;
        }
      }
      if (this.isDebugLogEnabled()) {
        this.dbg("perf", "markIndexFoldersDirtyFromItems:marked", {
          indexItemCount: items.length,
          markedDirty,
        });
      }

      let rounds = 0;
      while (this._dirtyFolders.size > 0) {
        rounds++;
        if (rounds > MAX_STARTUP_DIRTY_DRAIN_ROUNDS) {
          console.warn("[projectMgr] markIndexFoldersDirtyFromItems: drain aborted (max rounds)", {
            remaining: this._dirtyFolders.size,
          });
          break;
        }
        await this.refreshDirty({ reason: "startup_incremental" });
      }
      if (this.isDebugLogEnabled()) {
        this.dbg("perf", "markIndexFoldersDirtyFromItems:total", {
          ms: +(performance.now() - tAll).toFixed(1),
          rounds,
          remainingDirty: this._dirtyFolders.size,
        });
      }
    } catch (e) {
      console.warn("[projectMgr] markIndexFoldersDirtyFromItemsThenDrain failed:", e);
    }
  }

  /** 从索引读取项目路径、标脏并 drain（供侧栏后台加载等；内部单次 readIndex） */
  public async markIndexProjectsDirtyAndRefresh(): Promise<void> {
    const items = await this.readProjectIndexItems();
    if (!items?.length) return;
    await this.markIndexFoldersDirtyFromItemsThenDrain(items);
  }


  /** 标记所有项目为 dirty，然后触发增量刷新 */
  public async markAllProjectsDirtyAndRefresh(): Promise<void> {
    try {
      // 将所有现有项目标记为 dirty，让增量刷新检查它们是否有变化
      for (const folderPath of this._byFolder.keys()) {
        this._dirtyFolders.add(folderPath);
      }
      // 触发增量刷新（只刷新有变化的项目）
      await this.refreshDirty({ reason: "startup_incremental" });
    } catch (e) {
      console.warn("[projectMgr] markAllProjectsDirtyAndRefresh failed:", e);
    }
  }

  public stop(): void {
    if (this._timer) window.clearInterval(this._timer);
    this._timer = null;
  }

  private getRSLatteIndexDir(): string {
    const s: any = this.host.settingsRef() as any;
    // F2: bucket by space -> index lives under <centralRoot>/<spaceId>/index
    return resolveSpaceIndexDir(s, undefined, [s.projectRSLatteIndexDir]);
  }

  /** 与 `ProjectIndexStore` 同目录：`project-panel-hydrate.json`（第八节 SWR） */
  private getPanelHydrateVaultPath(): string {
    return normalizePath(`${this.getRSLatteIndexDir()}/${PANEL_HYDRATE_FILENAME}`);
  }

  private getHydrateSchemaVersion(): string {
    return String(this.host.getPluginVersion?.() ?? "0.0.1").trim() || "0.0.1";
  }

  private async writeVaultTextRelPath(relOrFull: string, text: string): Promise<void> {
    const p = normalizePath(relOrFull);
    if (!p) return;
    const adapter = this.host.app.vault.adapter;
    const parts = p.split("/").filter(Boolean);
    if (parts.length < 1) return;
    let cur = "";
    for (let i = 0; i < parts.length - 1; i++) {
      cur = cur ? `${cur}/${parts[i]}` : parts[i];
      if (!(await adapter.exists(cur))) await adapter.mkdir(cur);
    }
    await adapter.write(p, text);
  }

  /**
   * 尝试读取侧栏 hydrate 快照；`schemaVersion` 须与当前插件 manifest.version 一致。
   */
  public async tryReadPanelHydrateSnapshot(expectedSchemaVersion: string): Promise<ProjectSnapshot | null> {
    const p = this.getPanelHydrateVaultPath();
    try {
      const adapter = this.host.app.vault.adapter;
      if (!(await adapter.exists(p))) return null;
      const txt = await adapter.read(p);
      const raw = safeJsonParse<any>(txt, null);
      if (!raw || typeof raw !== "object") return null;
      if (String(raw.schemaVersion ?? "").trim() !== String(expectedSchemaVersion ?? "").trim()) return null;
      const snap = raw.snapshot;
      if (!snap || !Array.isArray(snap.projects)) return null;
      return {
        projects: snap.projects as ProjectEntry[],
        updatedAt: Number(snap.updatedAt) || 0,
      };
    } catch {
      return null;
    }
  }

  /** 将快照灌入内存（不读盘）；随后应 `ensureReady` + `refreshDirty` 再收敛 */
  public applyPanelHydrateSnapshot(snap: ProjectSnapshot): void {
    const projects = (snap.projects ?? []) as ProjectEntry[];
    const s = this.host.settingsRef();
    applyProjectSnapshotDerivatives(projects, {
      taskPanel: s?.taskPanel,
      todayYmd: getTaskTodayKey(s?.taskPanel),
      progressMilestoneUpcomingDays: progressMilestoneUpcomingDaysFromSettings(s),
      progressProjectUpcomingDays: progressProjectUpcomingDaysFromSettings(s),
    });
    this._snapshot = { projects, updatedAt: Number(snap.updatedAt) || Date.now() };
    this._byFolder.clear();
    for (const p of projects) {
      const fp = String(p?.folderPath ?? "").trim();
      if (fp) this._byFolder.set(fp, p);
    }
    this.snapshotLastAccess = Date.now();
    // 由调用方（如 ProjectSidePanelView.onOpen）紧接着 `render()`，避免此处二次刷新
  }

  /**
   * 将当前 `getSnapshot()` 写入 hydrate 文件（仅应在项目管理侧栏打开且刷新成功后调用，第八节 8-9）。
   */
  public async writePanelHydrateSnapshot(): Promise<void> {
    const snap = this.getSnapshot();
    const body = JSON.stringify(
      {
        schemaVersion: this.getHydrateSchemaVersion(),
        savedAt: toIsoNow(),
        snapshot: snap,
      },
      null,
      2
    );
    await this.writeVaultTextRelPath(this.getPanelHydrateVaultPath(), body);
  }

  private async removePanelHydrateFileBestEffort(): Promise<void> {
    try {
      const p = this.getPanelHydrateVaultPath();
      const adapter = this.host.app.vault.adapter;
      if (await adapter.exists(p)) await adapter.remove(p);
    } catch {
      // ignore
    }
  }

  private isDbSyncEnabled(): boolean {
    const s = this.host.settingsRef();
    // 默认为 true（与任务管理一致）
    const v = (s as any).projectEnableDbSync;
    return v === undefined ? true : Boolean(v);
  }

  private isAutoArchiveEnabled(): boolean {
    const s = this.host.settingsRef();
    const v = (s as any).projectAutoArchiveEnabled;
    return v === undefined ? true : Boolean(v);
  }

  private getArchiveThresholdDays(): number {
    const s = this.host.settingsRef();
    const v = (s as any).projectArchiveThresholdDays;
    return normalizeArchiveThresholdDays(v ?? 90);
  }

  private async ensureProjectRSLatteReady(): Promise<void> {
    const dir = this.getRSLatteIndexDir();
    if (this._idxStore && this._idxStore.getBaseDir() === dir && this._syncQueue) {
      if (this.isDebugLogEnabled()) this.dbg("perf", "ensureProjectRSLatteReady:skip (store ready)", { dir });
      return;
    }
    const t0 = performance.now();
    const s: any = this.host.settingsRef() as any;
    const queueDir = normalizePath(`${resolveSpaceQueueDir(s, undefined, [s.projectRSLatteIndexDir])}/project`);
    const store = new ProjectIndexStore(this.host.app, dir, queueDir);
    await store.ensureLayout();
    const t1 = performance.now();
    const q = new ProjectSyncQueue(store);
    await q.compact();
    const t2 = performance.now();
    this._idxStore = store;
    this._syncQueue = q;

    // 初始化模块级状态灯：根据队列统计 pending/failed
    try {
      const ops = await q.listAll();
      const pendingCount = ops.length;
      const failedOps = ops.filter((o: any) => Boolean((o as any).last_error));
      const failedCount = failedOps.length;
      const err = failedOps.length ? String((failedOps[0] as any).last_error ?? "") : undefined;
      this.host.reportDbSyncWithCounts?.({
        pendingCount,
        failedCount,
        ok: failedCount === 0 && pendingCount === 0,
        err: err || undefined,
      });
    } catch {}
    const t3 = performance.now();

    // load sync meta from central index (best-effort)
    try {
      const idx = await store.readIndex();
      this._syncMetaById.clear();
      for (const it of (idx.items ?? [])) {
        const pid = String((it as any).project_id ?? "").trim();
        if (!pid) continue;
        this._syncMetaById.set(pid, {
          status: String((it as any).db_sync_status ?? "").trim() || undefined,
          syncedAt: (it as any).db_synced_at ?? undefined,
          lastError: (it as any).db_last_error ?? undefined,
          pendingOps: Number((it as any).db_pending_ops ?? 0) || undefined,
        });
      }
    } catch (e) {
      console.warn("project rslatte: failed to load sync meta", e);
    }
    const t4 = performance.now();
    if (this.isDebugLogEnabled()) {
      this.dbg("perf", "ensureProjectRSLatteReady:cold", {
        dir,
        ensureLayoutMs: +(t1 - t0).toFixed(1),
        compactMs: +(t2 - t1).toFixed(1),
        listAllAndReportMs: +(t3 - t2).toFixed(1),
        readIndexSyncMetaMs: +(t4 - t3).toFixed(1),
        totalMs: +(t4 - t0).toFixed(1),
      });
    }
  }

  /**
   * v25：项目自动归档（每日一次）
   * - 笔记归档：pending_archive 超阈值、或 cancelled 超阈值（见 archiveDoneAndCancelledNow）
   */
  public async autoArchiveIfNeeded(): Promise<void> {
    if (!this.isAutoArchiveEnabled()) return;
    const s = this.host.settingsRef() as any;
    const last = String(s.projectArchiveLastRunKey ?? "").trim();
    const today = todayYmd2();
    if (last === today) return;
    try {
      await this.archiveDoneAndCancelledNow({ quiet: true });
      s.projectArchiveLastRunKey = today;
      await this.host.saveSettings();
    } catch (e) {
      console.warn("project autoArchiveIfNeeded failed", e);
    }
  }

  /**
   * 兼容保留（已废弃）：旧版本用于“归档项目索引”。
   * v25 起不再使用项目索引归档，改为归档项目文件夹。
   */
  public async archiveIndexNow(opts?: { quiet?: boolean }): Promise<{ archivedCount: number; cutoffDate: string }> {
    await this.ensureProjectRSLatteReady();
    const store = this._idxStore!;
    const res = await archiveProjectIndexByMonths(store, this.getArchiveThresholdDays());
    if (!opts?.quiet) {
      new Notice(`项目索引归档完成：${res.archivedCount} 条（<= ${res.cutoffDate}）`);
    }
    return { archivedCount: res.archivedCount, cutoffDate: res.cutoffDate };
  }

  // v26：不再使用项目模块内部 timer；统一由 main.ts 的 autoRefreshIndexIntervalMin 驱动。

  private registerVaultListeners() {
    if (this._vaultListenersRegistered) return;
    const { app } = this.host;
    const onAny = (af: TAbstractFile) => {
      const root = this.host.settingsRef().projectRootDir;
      const archive = this.host.settingsRef().projectArchiveDir;

      const path = af?.path ?? "";
      if (!path) return;
      // 只关心项目目录范围；归档目录不参与扫描
      if (!isUnder(path, root)) return;
      if (archive && isUnder(path, archive)) return;

      const folder = this.getProjectFolderByPath(path);
      if (!folder) return;
      this._dirtyFolders.add(folder);
    };

    this.host.app.vault.on("modify", onAny);
    this.host.app.vault.on("create", onAny);
    this.host.app.vault.on("delete", onAny);
    this.host.app.vault.on("rename", onAny);
    this._vaultListenersRegistered = true;
  }

  /**
   * 清理已不存在/已移出项目根目录/已在归档目录下的项目缓存（用于避免“项目被归档后仍残留在索引/缓存”）。
   * 说明：rename 到归档目录时，vault 事件拿不到旧路径，因此只能靠周期性清理。
   */
  private pruneOrphanFolders(): number {
    const settings = this.host.settingsRef();
    const root = norm(settings.projectRootDir);
    const archive = norm(settings.projectArchiveDir);
    if (!root) {
      const n = this._byFolder.size;
      this._byFolder.clear();
      this._dirtyFolders.clear();
      return n;
    }

    let removed = 0;
    for (const folder of Array.from(this._byFolder.keys())) {
      if (!isUnder(folder, root)) {
        this._byFolder.delete(folder);
        removed++;
        continue;
      }
      if (archive && isUnder(folder, archive)) {
        this._byFolder.delete(folder);
        removed++;
        continue;
      }
      const af = this.host.app.vault.getAbstractFileByPath(folder);
      if (!af || !(af instanceof TFolder)) {
        this._byFolder.delete(folder);
        removed++;
        continue;
      }
    }

    // dirty 队列也同步清理
    for (const folder of Array.from(this._dirtyFolders.values())) {
      if (!isUnder(folder, root)) {
        this._dirtyFolders.delete(folder);
        continue;
      }
      if (archive && isUnder(folder, archive)) {
        this._dirtyFolders.delete(folder);
        continue;
      }
      const af = this.host.app.vault.getAbstractFileByPath(folder);
      if (!af || !(af instanceof TFolder)) {
        this._dirtyFolders.delete(folder);
        continue;
      }
    }
    return removed;
  }

  private getProjectFolderByPath(path: string): string | null {
    const root = norm(this.host.settingsRef().projectRootDir);
    const p = norm(path);
    if (!root || !p || !p.startsWith(root + "/")) return null;
    const rest = p.slice(root.length + 1);
    const seg = rest.split("/")[0];
    if (!seg) return null;
    return `${root}/${seg}`;
  }

  private async ensureFolder(path: string): Promise<TFolder> {
    const p = norm(path);
    const { app } = this.host;
    const af = app.vault.getAbstractFileByPath(p);
    if (af && af instanceof TFolder) return af;
    await app.vault.createFolder(p);
    const created = app.vault.getAbstractFileByPath(p);
    if (!created || !(created instanceof TFolder)) throw new Error(`创建目录失败：${p}`);
    return created;
  }

  private async readTemplate(path: string): Promise<string> {
    let p = String(path ?? "").trim();
    if (!p) return "";

    // 兼容 settings 里写了 [[path]] / [[path|alias]]
    const wiki = p.match(/^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/);
    if (wiki) p = wiki[1];

    p = norm(p);
    if (!p) return "";

    const tryPaths = [p];
    // 兼容用户只填了不带后缀的模板路径
    if (!/\.[A-Za-z0-9]+$/.test(p)) {
      tryPaths.push(p + ".md");
      tryPaths.push(p + ".canvas");
      tryPaths.push(p + ".excalidraw.md");
    }

    for (const tp of tryPaths) {
      const af = this.host.app.vault.getAbstractFileByPath(tp);
      if (af && af instanceof TFile) {
        return await safeRead(this.host.app, af);
      }
    }
    return "";
  }

  private async ensureUniqueProjectId(id: string): Promise<string> {
    // 简单冲突检测：扫一遍现有项目 frontmatter.project_id
    const used = new Set<string>();
    for (const p of this._snapshot.projects) {
      used.add((p.projectId ?? "").trim());
    }
    let cur = (id ?? "").trim();
    while (cur && used.has(cur)) {
      cur = genProjectId();
    }
    return cur;
  }

  /**
   * 创建项目文件夹与三类文件：项目任务清单/项目信息/项目分析图
   * 6.6：计划结束日必填，计划开始日可选；写入 created_date、planned_end、planned_start，不写 create/due。
   */
  public async createProject(projectName: string, plannedEndYmd: string, plannedStartYmd?: string): Promise<ProjectEntry> {
    const name = (projectName ?? "").trim();
    if (!name) throw new Error("项目名称为必填");
    if (!plannedEndYmd || !isYmd(plannedEndYmd)) throw new Error("计划结束日为必填，格式必须为 YYYY-MM-DD");
    if (plannedStartYmd && !isYmd(plannedStartYmd)) throw new Error("计划开始日格式必须为 YYYY-MM-DD");

    const settings = this.host.settingsRef();
    const root = norm(settings.projectRootDir);
    if (!root) throw new Error("未配置项目目录");

    const folderPath = norm(`${root}/${name}`);
    if (this.host.app.vault.getAbstractFileByPath(folderPath)) {
      throw new Error("已存在同名项目文件夹，请更换项目名称");
    }

    await this.ensureFolder(folderPath);

    let pid = await this.ensureUniqueProjectId(genProjectId());

    // 文件名
    const tasklistFilePath = norm(`${folderPath}/项目任务清单.md`);
    const infoFilePath = norm(`${folderPath}/项目信息.md`);

    const analysisTplPath = String(settings.projectAnalysisTemplatePath ?? "").trim();
    const analysisSuffix = (() => {
      const low = norm(analysisTplPath).toLowerCase();
      if (low.endsWith(".canvas")) return ".canvas";
      if (low.endsWith(".excalidraw.md")) return ".excalidraw.md";
      if (low.endsWith(".excalidraw")) return ".excalidraw";
      return ".md";
    })();
    const analysisFilePath = norm(`${folderPath}/${name}-项目分析图${analysisSuffix}`);

    const tasklistTpl = await this.readTemplate(settings.projectTasklistTemplatePath);
    const infoTpl = await this.readTemplate(settings.projectInfoTemplatePath);
    const analysisTplContent = await this.readTemplate(settings.projectAnalysisTemplatePath);

    // 创建文件
    const taskFile = await this.host.app.vault.create(tasklistFilePath, tasklistTpl || "");
    const infoFile = await this.host.app.vault.create(infoFilePath, infoTpl || "");
    const analysisFile = await this.host.app.vault.create(analysisFilePath, analysisTplContent || "");

    const taskFileId = genFileId();
    const infoFileId = genFileId();
    const analysisFileId = genFileId();

    // 写 frontmatter（6.6 新键，删旧键）
    await this.host.app.fileManager.processFrontMatter(taskFile, (fm) => {
      fm.file_id = fm.file_id ?? taskFileId;
      fm.file_role = fm.file_role ?? "project_tasklist";
      fm.project_id = pid;
      fm.project_name = name;
      (fm as any).planned_end = plannedEndYmd;
      delete (fm as any).due;
      delete (fm as any).create;
    });

    await this.host.app.fileManager.processFrontMatter(infoFile, (fm) => {
      fm.file_id = fm.file_id ?? infoFileId;
      fm.file_role = fm.file_role ?? "project_info";
      fm.project_id = pid;
      fm.project_name = name;
      fm.status = "todo";
      (fm as any).created_date = todayYmd();
      (fm as any).planned_end = plannedEndYmd;
      if (plannedStartYmd) (fm as any).planned_start = plannedStartYmd;
      delete (fm as any).create;
      delete (fm as any).due;
      delete (fm as any).start;
    });

    // ⚠️ Excalidraw：文本级 frontmatter 补齐。Canvas 为纯 JSON，不可注入 YAML。
    const analysisExt = String(analysisFile.extension ?? "").toLowerCase();
    if (analysisExt !== "canvas") {
      await patchYamlFrontmatterText(this.host.app, analysisFile, {
        file_id: analysisFileId,
        file_role: "project_analysis",
        project_id: pid,
        project_name: name,
      });
    }

    // 更新索引
    await this.refreshOneFolder(folderPath, { reason: "create" });
    this.host.refreshSidePanel();

    // ✅ Work Event (success only)
    void this.host.workEventSvc?.append({
      ts: toLocalOffsetIsoString(),
      kind: "project",
      action: "create",
      source: "ui",
      ref: {
        project_id: pid,
        project_name: name,
        folder_path: folderPath,
        planned_end: plannedEndYmd,
        planned_start: plannedStartYmd || undefined,
        files: {
          tasklist: tasklistFilePath,
          info: infoFilePath,
          analysis: analysisFilePath,
        },
      },
      summary: `📁 新建项目 ${name}`,
      metrics: { planned_end: plannedEndYmd, planned_start: plannedStartYmd || undefined, file_count: 3 },
    });

    const created = this._byFolder.get(folderPath);
    if (!created) throw new Error("项目创建后索引未刷新");
    return created;
  }

  /**
   * 修改项目名称与计划日期（6.6：planned_end/planned_start，删旧键 due/start/create）
   */
  public async updateProjectInfo(projectFolderPath: string, opts: { projectName: string; planned_end?: string; planned_start?: string }): Promise<void> {
    const folder = norm(projectFolderPath);
    const oldEntry = this._byFolder.get(folder);
    const oldNameHint = String((oldEntry as any)?.projectName ?? (oldEntry as any)?.project_name ?? "").trim();
    const newName = (opts.projectName ?? "").trim();
    const planned_end = (opts.planned_end ?? "").trim() || undefined;
    const planned_start = (opts.planned_start ?? "").trim() || undefined;
    if (!folder) throw new Error("项目路径为空");
    if (!newName) throw new Error("项目名称为必填");
    if (planned_end && !isYmd(planned_end)) throw new Error("计划结束日格式必须为 YYYY-MM-DD");
    if (planned_start && !isYmd(planned_start)) throw new Error("计划开始日格式必须为 YYYY-MM-DD");

    const settings = this.host.settingsRef();
    const root = norm(settings.projectRootDir);
    if (!root) throw new Error("未配置项目目录");

    // 1) rename folder (if under root)
    const oldFolderPath = folder;
    let curFolderPath = folder;
    const folderAf0 = this.host.app.vault.getAbstractFileByPath(curFolderPath);
    if (!folderAf0 || !(folderAf0 instanceof TFolder)) throw new Error("未找到项目文件夹");

    const targetFolderPath = norm(`${root}/${newName}`);
    if (isUnder(curFolderPath, root) && curFolderPath !== targetFolderPath) {
      const existed = this.host.app.vault.getAbstractFileByPath(targetFolderPath);
      if (existed && existed !== folderAf0) throw new Error("目标项目文件夹已存在，请更换项目名称");
      await this.host.app.vault.rename(folderAf0, targetFolderPath);
      curFolderPath = targetFolderPath;

      // 清理旧 key，避免“幽灵项目”残留
      this._byFolder.delete(oldFolderPath);
      this._dirtyFolders.delete(oldFolderPath);
    }

    // 2) locate files in renamed folder
    const folderAf = this.host.app.vault.getAbstractFileByPath(curFolderPath);
    if (!folderAf || !(folderAf instanceof TFolder)) throw new Error("未找到项目文件夹");
    const files = folderAf.children.filter((x) => x instanceof TFile) as TFile[];

    const pickByName = (names: string[]): TFile | undefined => files.find((f) => names.includes(f.name));
    const pickByRole = async (role: string): Promise<TFile | undefined> => {
      for (const f of files) {
        const ext = String(f.extension ?? "").toLowerCase();
        if (ext !== "md" && ext !== "excalidraw") continue;
        try {
          const fm = await readFrontmatter(this.host.app, f);
          const r = String((fm as any).file_role ?? (fm as any).fileRole ?? "").trim();
          if (r === role) return f;
        } catch {}
      }
      return undefined;
    };

    const infoFile = pickByName(["项目信息.md"]) ?? (await pickByRole("project_info"));
    const taskFile = pickByName(["项目任务清单.md", "项目清单.md"]) ?? (await pickByRole("project_tasklist"));
    const analysisFile =
      (await pickByRole("project_analysis")) ??
      (() => {
        const isMatch = (base: string): boolean => {
          const b = String(base ?? "").trim();
          if (!b) return false;
          return b === "项目分析图" || b.endsWith("-项目分析图") || b.includes("项目分析图");
        };
        const score = (base: string): number => {
          const b = String(base ?? "").trim();
          if (b === `${newName}-项目分析图`) return 100;
          if (b === `${folderAf.name}-项目分析图`) return 95;
          if (b === "项目分析图") return 90;
          if (b.endsWith("-项目分析图")) return 80;
          if (b.includes("项目分析图")) return 70;
          return 0;
        };
        const candidates = files
          .filter((f) => isMatch(f.basename))
          .sort((a, b) => score(b.basename) - score(a.basename));
        return candidates[0];
      })();

    if (!infoFile || !taskFile) throw new Error("项目文件不完整（缺少 项目信息/项目任务清单）");

    // 3) update frontmatter（6.6 新键，删旧键）
    await this.host.app.fileManager.processFrontMatter(infoFile, (fm) => {
      fm.file_id = fm.file_id ?? genFileId();
      fm.file_role = fm.file_role ?? "project_info";
      fm.project_name = newName;
      if (planned_end) (fm as any).planned_end = planned_end;
      else delete (fm as any).planned_end;
      delete (fm as any).due;
      delete (fm as any).create;
      delete (fm as any).start;
    });
    await this.host.app.fileManager.processFrontMatter(taskFile, (fm) => {
      fm.file_id = fm.file_id ?? genFileId();
      fm.file_role = fm.file_role ?? "project_tasklist";
      fm.project_name = newName;
      if (planned_end) (fm as any).planned_end = planned_end;
      else delete (fm as any).planned_end;
      delete (fm as any).due;
    });
    if (analysisFile) {
      const aext = String(analysisFile.extension ?? "").toLowerCase();
      if (aext !== "canvas") {
        const afm = await readFrontmatter(this.host.app, analysisFile);
        const upd: Record<string, any> = {
          project_name: newName,
          file_role: String(afm.file_role ?? "").trim() || "project_analysis",
        };
        if (!String(afm.file_id ?? "").trim()) upd.file_id = genFileId();
        await patchYamlFrontmatterText(this.host.app, analysisFile, upd);
      }
    }

    // 4) rename analysis file to include new project name
    if (analysisFile) {
      // 注意：excalidraw 常见后缀为 .excalidraw 或 .excalidraw.md
      // 这里通过截取 “-项目分析图” 后缀来保留完整扩展名（可能是多段扩展名）
      const marker = "-项目分析图";
      const fullName = analysisFile.name; // e.g. 旧名-项目分析图.excalidraw.md
      const idx = fullName.indexOf(marker);
      const tail = idx >= 0 ? fullName.slice(idx + marker.length) : (analysisFile.extension ? `.${analysisFile.extension}` : "");
      const desired = norm(`${curFolderPath}/${newName}${marker}${tail ?? ""}`);

      if (analysisFile.path !== desired) {
        const existed = this.host.app.vault.getAbstractFileByPath(desired);
        if (!existed || existed === analysisFile) {
          await this.host.app.vault.rename(analysisFile, desired);
        }
      }
    }

    // 5) refresh index + enqueue db sync (mtime_key changed anyway, but这里也 force 一次更直观)
    this._dirtyFolders.add(curFolderPath);
    await this.refreshDirty({ reason: "edit_project" });
    if (this.isDbSyncEnabled()) {
      // 手动触发：确保把新的 folder/file path 写回 DB
      await this.persistIndexAndEnqueueSync({ forceEnqueue: true });
    }
    this.host.refreshSidePanel();

    // ✅ Work Event (success only)
    void this.host.workEventSvc?.append({
      ts: toLocalOffsetIsoString(),
      kind: "project",
      action: "update",
      source: "ui",
      ref: {
        project_id: (oldEntry as any)?.projectId ?? (oldEntry as any)?.project_id ?? undefined,
        old_project_name: oldNameHint || undefined,
        project_name: newName,
        old_folder_path: oldFolderPath,
        folder_path: curFolderPath,
        planned_end: planned_end || undefined,
        planned_start: planned_start || undefined,
      },
      summary: oldNameHint && oldNameHint !== newName ? `✏️ 项目重命名 ${oldNameHint} → ${newName}` : `✏️ 更新项目信息 ${newName}`,
      metrics: { planned_end: planned_end || undefined, planned_start: planned_start || undefined },
    });
  }

  public async addMilestone(
    projectFolderPath: string,
    milestoneName: string,
    opts?: { level?: 1 | 2 | 3; parentPath?: string; plannedEnd?: string; milestoneWeight?: number }
  ): Promise<void> {
    const folder = norm(projectFolderPath);
    const name = (milestoneName ?? "").trim();
    if (!folder) throw new Error("项目路径为空");
    if (!name) throw new Error("里程碑名称为必填");

    const level = Math.max(1, Math.min(3, Number(opts?.level ?? 1) || 1)) as 1 | 2 | 3;
    const parentPath = String(opts?.parentPath ?? "").trim();
    if (level > 1 && !parentPath) throw new Error("非一级里程碑必须选择父里程碑");

    const p = this._byFolder.get(folder);
    const taskPath = p?.tasklistFilePath || norm(`${folder}/项目任务清单.md`);
    const af = this.host.app.vault.getAbstractFileByPath(taskPath);
    // 兼容旧文件名：项目清单.md
    let taskFile: TFile | null = af instanceof TFile ? af : null;
    if (!taskFile) {
      const legacy = this.host.app.vault.getAbstractFileByPath(norm(`${folder}/项目清单.md`));
      if (legacy instanceof TFile) taskFile = legacy;
    }
    if (!taskFile) throw new Error("未找到项目任务清单文件");

    const text = await safeRead(this.host.app, taskFile);
    const lines = text.split(/\r?\n/);
    const nodes = parseMilestoneNodes(text);

    const parentNode =
      level > 1 ? nodes.find((n) => String((n as any).path ?? "").trim() === parentPath) : undefined;
    if (level > 1) {
      if (!parentNode) throw new Error("未找到父里程碑（请先创建父里程碑）");
      if (Number(parentNode.level) !== level - 1) {
        throw new Error(`父里程碑层级不匹配：当前选择的是 level${level}，父里程碑必须为 level${level - 1}`);
      }
    }

    const newPath = (level === 1 ? name : `${parentPath} / ${name}`).trim();
    if (nodes.some((n) => String((n as any).path ?? "").trim() === newPath)) {
      new Notice("该里程碑路径已存在");
      return;
    }

    const insertAt = level === 1 ? lines.length : Math.max(0, Math.min(lines.length, Number(parentNode!.blockEndLineNo ?? lines.length)));

    const prefix = "#".repeat(level);
    const headingLine = `${prefix} ${name}`;

    // Keep spacing neat: ensure a blank line before and after inserted heading.
    const block: string[] = [];
    const prev = insertAt - 1 >= 0 ? String(lines[insertAt - 1] ?? "") : "";
    if (insertAt > 0 && prev.trim() !== "") block.push("");
    block.push(headingLine);
    const metaKv: Record<string, string> = {
      milestone_status: "active",
      ts: toIsoNow(),
      milestone_created_date: todayYmd(),
    };
    const pe = String(opts?.plannedEnd ?? "").trim();
    if (level === 1 && pe && isYmd(pe)) metaKv.milestone_planned_end = pe;
    const mw = clampMilestoneWeightInput(opts?.milestoneWeight);
    if (mw !== undefined && mw > 1) metaKv.milestone_weight = String(mw);
    block.push(buildMilestoneRslatteMetaComment(metaKv));
    block.push("");

    lines.splice(insertAt, 0, ...block);
    await this.host.app.vault.modify(taskFile, lines.join("\n"));

    // 更新项目信息：start 为空则设为今天；status => in-progress
    const infoPath = p?.infoFilePath || norm(`${folder}/项目信息.md`);
    const infoAf = this.host.app.vault.getAbstractFileByPath(infoPath);
    if (infoAf && infoAf instanceof TFile) {
      await this.host.app.fileManager.processFrontMatter(infoAf, (fm) => {
        const curStart = String((fm as any).actual_start ?? fm.start ?? "").trim();
        if (!curStart) (fm as any).actual_start = todayYmd();
        delete (fm as any).start;
        if (fm.status === "todo") {
          void this.host.workEventSvc?.append({
            ts: toLocalOffsetIsoString(),
            kind: "project",
            action: "start",
            source: "ui",
            ref: {
              project_id: (p as any)?.projectId ?? (p as any)?.project_id ?? undefined,
              project_name: (p as any)?.projectName ?? (p as any)?.project_name ?? undefined,
              folder_path: folder,
            },
            summary: `🛫 项目开始，创建第一个里程碑 ${newPath}`,
          });
        }
        fm.status = "in-progress";
      });
    }

    this._dirtyFolders.add(folder);
    await this.refreshDirty({ reason: "add_milestone" });
    this.host.refreshSidePanel();
    await this.bumpProjectInfoProgressUpdated(folder);

    void this.host.workEventSvc?.append({
      ts: toLocalOffsetIsoString(),
      kind: "milestone",
      action: "create",
      source: "ui",
      ref: {
        project_id: (p as any)?.projectId ?? (p as any)?.project_id ?? undefined,
        project_name: (p as any)?.projectName ?? (p as any)?.project_name ?? undefined,
        folder_path: folder,
        milestone: name,
        milestone_path: newPath,
        level,
        parent_milestone: parentPath || undefined,
      },
      summary: `🏁 新增里程碑 ${newPath}`,
    });
  }

  /** List milestone meta for UI (path/level/parent/status). */
  public async listMilestonesMeta(projectFolderPath: string): Promise<
    Array<{
      path: string;
      name: string;
      level: 1 | 2 | 3;
      parentPath?: string;
      milestoneStatus?: "active" | "done" | "cancelled";
      /** meta milestone_planned_end，YYYY-MM-DD */
      planned_end?: string;
      /** meta milestone_weight，1–100 */
      milestone_weight?: number;
    }>
  > {
    const folder = norm(projectFolderPath);
    const p = this._byFolder.get(folder);
    const taskPath = p?.tasklistFilePath || norm(`${folder}/项目任务清单.md`);
    const af = this.host.app.vault.getAbstractFileByPath(taskPath);

    let taskFile: TFile | null = af instanceof TFile ? af : null;
    if (!taskFile) {
      const legacy = this.host.app.vault.getAbstractFileByPath(norm(`${folder}/项目清单.md`));
      if (legacy instanceof TFile) taskFile = legacy;
    }
    if (!taskFile) return [];

    const md = await safeRead(this.host.app, taskFile);
    return parseMilestoneNodes(md)
      .map((n) => ({
        path: String((n as any).path ?? "").trim(),
        name: String((n as any).name ?? "").trim(),
        level: (Number((n as any).level ?? 1) || 1) as 1 | 2 | 3,
        parentPath: String((n as any).parentPath ?? "").trim() || undefined,
        milestoneStatus: (n as any).milestoneStatus,
        planned_end: (n as any).planned_end && isYmd((n as any).planned_end) ? String((n as any).planned_end).trim() : undefined,
        milestone_weight:
          (n as any).milestone_weight != null && Number.isFinite(Number((n as any).milestone_weight))
            ? clampMilestoneWeightInput((n as any).milestone_weight)
            : undefined,
      }))
      .filter((x) => Boolean(x.path));
  }

  /** Update milestone status in markdown (done/cancelled/active). */

  /** Update milestone status in markdown (done/cancelled/active). */
  public async setMilestoneStatus(
    projectFolderPath: string,
    milestonePath: string,
    status: "active" | "done" | "cancelled"
  ): Promise<void> {
    const folder = norm(projectFolderPath);
    const path = String(milestonePath ?? "").trim();
    if (!path) throw new Error("里程碑路径为空");

    const p = this._byFolder.get(folder);
    const taskPath = p?.tasklistFilePath || norm(`${folder}/项目任务清单.md`);
    const af = this.host.app.vault.getAbstractFileByPath(taskPath);
    let taskFile: TFile | null = af instanceof TFile ? af : null;
    if (!taskFile) {
      const legacy = this.host.app.vault.getAbstractFileByPath(norm(`${folder}/项目清单.md`));
      if (legacy instanceof TFile) taskFile = legacy;
    }
    if (!taskFile) throw new Error("未找到项目任务清单文件");

    const md = await safeRead(this.host.app, taskFile);
    const lines = md.split(/\r?\n/);

    const nodes = parseMilestoneNodes(md);
    const node = nodes.find((n) => String((n as any).path ?? "").trim() === path);
    if (!node) throw new Error("未找到该里程碑标题");

    const h = Number((node as any).headingLineNo ?? -1);
    const rangeEnd = Math.min(lines.length, Number((node as any).insertBeforeLineNo ?? lines.length));
    if (!(h >= 0) || h >= lines.length) throw new Error("里程碑行号无效");

    const isRSLatte = (s: string) => /^\s*<!--\s*rslatte:/i.test(String(s ?? ""));
    const hasStatusLine = (s: string) => /milestone_status\s*=\s*/i.test(String(s ?? ""));

    // Collect all milestone_status lines within the milestone block range (heading -> first next heading of ANY level).
    // Tolerate: missing / multiple lines /乱序.
    const statusIdxs: number[] = [];
    for (let i = h + 1; i < rangeEnd; i++) {
      const raw = String(lines[i] ?? "");
      if (!raw.trim()) continue;
      if (!isRSLatte(raw)) continue;
      if (hasStatusLine(raw)) statusIdxs.push(i);
    }

    if (status === "active") {
      // restore: remove ALL milestone_status lines if exist
      for (const i of statusIdxs.slice().sort((a, b) => b - a)) {
        lines.splice(i, 1);
      }
    } else {
      let baseKv: Record<string, string> = {};
      if (statusIdxs.length) {
        const keepLine = String(lines[Math.min(...statusIdxs)] ?? "");
        const parsed = parseRslatteMilestoneKvFromLine(keepLine);
        if (parsed) baseKv = { ...parsed };
      }
      baseKv.milestone_status = status;
      baseKv.ts = toIsoNow();
      if (status === "done") {
        baseKv.milestone_done_date = todayYmd();
        delete baseKv.milestone_cancelled_date;
      } else if (status === "cancelled") {
        baseKv.milestone_cancelled_date = todayYmd();
        delete baseKv.milestone_done_date;
      }
      const meta = buildMilestoneRslatteMetaComment(baseKv);

      if (statusIdxs.length) {
        // keep the closest one to the heading, delete duplicates
        const keep = Math.min(...statusIdxs);
        lines[keep] = meta;
        for (const i of statusIdxs
          .filter((x) => x !== keep)
          .slice()
          .sort((a, b) => b - a)) {
          lines.splice(i, 1);
        }
      } else {
        // Insert right under heading, but after other rslatte comment lines (if any), and before the first blank line.
        let insertAt = h + 1;
        while (insertAt < rangeEnd) {
          const s = String(lines[insertAt] ?? "");
          if (!s.trim()) break;
          if (!isRSLatte(s)) break;
          insertAt++;
        }
        lines.splice(insertAt, 0, meta);
      }
    }

    await this.host.app.vault.modify(taskFile, lines.join("\n"));
    this._dirtyFolders.add(folder);
    await this.refreshDirty({ reason: "milestone_status" });
    this.host.refreshSidePanel();
    await this.bumpProjectInfoProgressUpdated(folder);

    // ✅ 根据状态拆分为具体的 action
    const action = status === "done" ? "done" : status === "cancelled" ? "cancelled" : "recover";
    const icon = status === "done" ? "✅" : status === "cancelled" ? "⛔" : "⏸";
    const summaryText = status === "done" ? "里程碑完成" : status === "cancelled" ? "里程碑取消" : "里程碑恢复";
    
    void this.host.workEventSvc?.append({
      ts: toLocalOffsetIsoString(),
      kind: "milestone",
      action: action as any,
      source: "ui",
      ref: {
        project_id: (p as any)?.projectId ?? (p as any)?.project_id ?? undefined,
        project_name: (p as any)?.projectName ?? (p as any)?.project_name ?? undefined,
        folder_path: folder,
        milestone_path: path,
        status,
      },
      summary: `${icon} ${summaryText} ${path}`,
    });
  }

  /**
   * 更新里程碑 meta：`milestone_planned_end`、`milestone_weight`（第九节 9.4.1）。
   * - 仅一级里程碑维护计划完成日；二三级传入 `plannedEnd` 时会从 meta 中移除计划相关键。
   * - `plannedEnd === undefined`：不修改计划完成日；`""`：删除；合法 YYYY-MM-DD：写入（仅一级）。
   * - `milestoneWeight === undefined`：不修改权重；`1` 或无效：删除 `milestone_weight`（缺省按 1）；2–100：写入。
   * 若无 `milestone_status` 行且需写入上述任一字段，则插入一行。
   */
  private async patchMilestoneMetaAugment(
    taskFile: TFile,
    milestonePath: string,
    augment: { plannedEnd?: string; milestoneWeight?: number }
  ): Promise<void> {
    const peDefined = augment.plannedEnd !== undefined;
    const mwDefined = augment.milestoneWeight !== undefined;
    if (!peDefined && !mwDefined) return;

    const text = await safeRead(this.host.app, taskFile);
    const lines = text.split(/\r?\n/);
    const nodes = parseMilestoneNodes(text);
    const node = nodes.find((n) => String((n as any).path ?? "").trim() === milestonePath);
    if (!node) return;
    const lvl = Number((node as any).level ?? 1) || 1;
    const h = Number((node as any).headingLineNo ?? -1);
    const rangeEnd = Math.min(lines.length, Number((node as any).insertBeforeLineNo ?? lines.length));
    let lastIdx = -1;
    for (let i = h + 1; i < rangeEnd; i++) {
      if (/<!--\s*rslatte:.*milestone_status\s*=/i.test(String(lines[i] ?? ""))) lastIdx = i;
    }

    const trimmedPe = peDefined ? String(augment.plannedEnd ?? "").trim() : "";
    const mwClamped = mwDefined ? clampMilestoneWeightInput(augment.milestoneWeight) : undefined;
    const needWeightInFile = mwDefined && mwClamped !== undefined && mwClamped > 1;
    const needPlannedInFile = lvl === 1 && peDefined && trimmedPe.length > 0 && isYmd(trimmedPe);

    if (lastIdx < 0) {
      if (!needPlannedInFile && !needWeightInFile) return;
      const kv: Record<string, string> = {
        milestone_status: "active",
        ts: toIsoNow(),
      };
      if (needPlannedInFile) kv.milestone_planned_end = trimmedPe;
      if (needWeightInFile && mwClamped != null) kv.milestone_weight = String(mwClamped);
      let insertAt = h + 1;
      while (insertAt < rangeEnd) {
        const s = String(lines[insertAt] ?? "");
        if (!s.trim()) break;
        if (!/^\s*<!--\s*rslatte:/i.test(s)) break;
        insertAt++;
      }
      lines.splice(insertAt, 0, buildMilestoneRslatteMetaComment(kv));
      await this.host.app.vault.modify(taskFile, lines.join("\n"));
      return;
    }

    const kv = parseRslatteMilestoneKvFromLine(String(lines[lastIdx] ?? "")) ?? {};
    if (peDefined) {
      if (lvl !== 1) {
        delete kv.milestone_planned_end;
        delete kv.milestone_original_planned_end;
      } else if (!trimmedPe) {
        delete kv.milestone_planned_end;
      } else if (isYmd(trimmedPe)) {
        kv.milestone_planned_end = trimmedPe;
      } else {
        return;
      }
    }
    if (mwDefined) {
      if (mwClamped === undefined || mwClamped <= 1) delete kv.milestone_weight;
      else kv.milestone_weight = String(mwClamped);
    }
    const fullLine = String(lines[lastIdx] ?? "");
    const newComment = buildMilestoneRslatteMetaComment(kv);
    lines[lastIdx] = fullLine.replace(/<!--\s*rslatte:[\s\S]*?-->/i, newComment);
    await this.host.app.vault.modify(taskFile, lines.join("\n"));
  }

  /** Update milestone (rename / change level / change parent). */
  public async updateMilestone(
    projectFolderPath: string,
    fromMilestonePath: string,
    opts: { name?: string; level?: 1 | 2 | 3; parentPath?: string; plannedEnd?: string; milestoneWeight?: number }
  ): Promise<void> {
    const folder = norm(projectFolderPath);
    const fromPath = String(fromMilestonePath ?? "").trim();
    if (!fromPath) throw new Error("里程碑路径为空");

    const p = this._byFolder.get(folder);
    const taskPath = p?.tasklistFilePath || norm(`${folder}/项目任务清单.md`);
    const af = this.host.app.vault.getAbstractFileByPath(taskPath);
    let taskFile: TFile | null = af instanceof TFile ? af : null;
    if (!taskFile) {
      const legacy = this.host.app.vault.getAbstractFileByPath(norm(`${folder}/项目清单.md`));
      if (legacy instanceof TFile) taskFile = legacy;
    }
    if (!taskFile) throw new Error("未找到项目任务清单文件");

    const md = await safeRead(this.host.app, taskFile);
    let lines = md.split(/\r?\n/);
    const nodes = parseMilestoneNodes(md);
    const node = nodes.find((n) => String((n as any).path ?? "").trim() === fromPath);
    if (!node) throw new Error("未找到该里程碑标题");

    const oldLevel = (Number((node as any).level ?? 1) || 1) as 1 | 2 | 3;
    const oldLeaf = String((node as any).name ?? "").trim();
    const oldParentPath = oldLevel > 1 ? fromPath.split(" / ").slice(0, -1).join(" / ").trim() : "";
    const newLeaf = String(opts?.name ?? oldLeaf).trim();
    if (!newLeaf) throw new Error("里程碑名称为必填");

    const newLevel = Math.max(1, Math.min(3, Number(opts?.level ?? oldLevel) || oldLevel)) as 1 | 2 | 3;
    let newParentPath = String(opts?.parentPath ?? "").trim();
    // Backwards-compatible: if user only renames and doesn't pass parentPath, keep the original parent.
    if (newLevel > 1 && !newParentPath && newLevel === oldLevel) newParentPath = oldParentPath;
    if (newLevel > 1 && !newParentPath) throw new Error("非一级里程碑必须选择父里程碑");

    // validate parent level
    if (newLevel > 1) {
      const parentNode = nodes.find((n) => String((n as any).path ?? "").trim() === newParentPath);
      if (!parentNode) throw new Error("未找到父里程碑");
      if (Number((parentNode as any).level ?? 1) !== newLevel - 1) {
        throw new Error(`父里程碑层级不匹配：当前选择的是 level${newLevel}，父里程碑必须为 level${newLevel - 1}`);
      }
      // prevent moving into own subtree
      const h0 = Number((node as any).headingLineNo ?? -1);
      const h1 = Number((node as any).blockEndLineNo ?? lines.length);
      const ph = Number((parentNode as any).headingLineNo ?? -1);
      if (ph >= h0 && ph < h1) throw new Error("不能将里程碑移动到其子里程碑下");
    }

    const newPath = (newLevel === 1 ? newLeaf : `${newParentPath} / ${newLeaf}`).trim();
    const exists = nodes.some((n) => String((n as any).path ?? "").trim() === newPath && String((n as any).path ?? "").trim() !== fromPath);
    if (exists) throw new Error("目标里程碑路径已存在");

    const start = Number((node as any).headingLineNo ?? -1);
    const end = Math.max(start, Math.min(lines.length, Number((node as any).blockEndLineNo ?? lines.length)));
    if (!(start >= 0)) throw new Error("里程碑行号无效");

    // Rename-only should NEVER change milestone order.
    // Only when level/parent changes do we need to move the whole block.
    const isRenameOnly =
      newLevel === oldLevel &&
      (newLevel === 1 ? !newParentPath : String(newParentPath ?? "").trim() === String(oldParentPath ?? "").trim());
    if (isRenameOnly) {
      const cur = String(lines[start] ?? "");
      const hm = cur.match(/^(#{1,3})\s+(.+?)\s*$/);
      if (!hm) throw new Error("里程碑标题格式无效");
      lines[start] = `${hm[1]} ${newLeaf}`;
      await this.host.app.vault.modify(taskFile, lines.join("\n"));

      const finalPathRename = (newLevel === 1 ? newLeaf : `${newParentPath} / ${newLeaf}`).trim();
      if (opts.plannedEnd !== undefined || opts.milestoneWeight !== undefined) {
        await this.patchMilestoneMetaAugment(taskFile, finalPathRename, {
          ...(opts.plannedEnd !== undefined ? { plannedEnd: opts.plannedEnd } : {}),
          ...(opts.milestoneWeight !== undefined ? { milestoneWeight: opts.milestoneWeight } : {}),
        });
      }
      if (newLevel > 1) {
        await this.patchMilestoneMetaAugment(taskFile, finalPathRename, { plannedEnd: "" });
      }

      this._dirtyFolders.add(folder);
      await this.refreshDirty({ reason: "rename_milestone" });
      this.host.refreshSidePanel();

      void this.host.workEventSvc?.append({
        ts: toLocalOffsetIsoString(),
        kind: "milestone",
        action: "update",
        source: "ui",
        ref: {
          project_id: (p as any)?.projectId ?? (p as any)?.project_id ?? undefined,
          project_name: (p as any)?.projectName ?? (p as any)?.project_name ?? undefined,
          folder_path: folder,
          from_milestone_path: fromPath,
          milestone_path: finalPathRename,
          level: newLevel,
          parent_milestone: newParentPath || undefined,
        },
        summary: `✏️ 更新里程碑 ${fromPath} → ${finalPathRename}`,
      });
      await this.bumpProjectInfoProgressUpdated(folder);
      return;
    }

    const block = lines.slice(start, end);
    const delta = newLevel - oldLevel;

    // adjust headings inside block (only #..###)
    const adjusted = block.map((ln, idx) => {
      const m = String(ln ?? "").match(/^(#{1,3})\s+(.+?)\s*$/);
      if (!m) return ln;
      const cur = Math.min(3, Math.max(1, m[1].length)) as 1 | 2 | 3;
      const nextLevel = (cur + delta) as number;
      if (nextLevel < 1 || nextLevel > 3) {
        throw new Error("调整层级后将超过 1~3 层限制，请先调整子里程碑结构");
      }
      const title = idx === 0 ? newLeaf : String(m[2] ?? "").trim();
      return `${"#".repeat(nextLevel)} ${title}`;
    });

    // remove block
    lines.splice(start, end - start);

    // recompute insertion point on updated text
    const updatedText = lines.join("\n");
    const nodes2 = parseMilestoneNodes(updatedText);
    let insertAt = lines.length;
    if (newLevel > 1) {
      const parent2 = nodes2.find((n) => String((n as any).path ?? "").trim() === newParentPath);
      if (!parent2) throw new Error("未找到父里程碑（移动后）");
      insertAt = Math.max(0, Math.min(lines.length, Number((parent2 as any).blockEndLineNo ?? lines.length)));
    }

    // ensure spacing
    const insertBlock: string[] = [];
    const prev = insertAt - 1 >= 0 ? String(lines[insertAt - 1] ?? "") : "";
    if (insertAt > 0 && prev.trim() !== "") insertBlock.push("");
    insertBlock.push(...adjusted);
    // ensure trailing blank after heading block for readability
    if (insertBlock.length && String(insertBlock[insertBlock.length - 1] ?? "").trim() !== "") insertBlock.push("");

    lines.splice(insertAt, 0, ...insertBlock);
    await this.host.app.vault.modify(taskFile, lines.join("\n"));

    if (opts.plannedEnd !== undefined || opts.milestoneWeight !== undefined) {
      await this.patchMilestoneMetaAugment(taskFile, newPath, {
        ...(opts.plannedEnd !== undefined ? { plannedEnd: opts.plannedEnd } : {}),
        ...(opts.milestoneWeight !== undefined ? { milestoneWeight: opts.milestoneWeight } : {}),
      });
    }
    if (newLevel > 1) {
      await this.patchMilestoneMetaAugment(taskFile, newPath, { plannedEnd: "" });
    }

    this._dirtyFolders.add(folder);
    await this.refreshDirty({ reason: "update_milestone" });
    this.host.refreshSidePanel();
    await this.bumpProjectInfoProgressUpdated(folder);

    void this.host.workEventSvc?.append({
      ts: toLocalOffsetIsoString(),
      kind: "milestone",
      action: "update",
      source: "ui",
      ref: {
        project_id: (p as any)?.projectId ?? (p as any)?.project_id ?? undefined,
        project_name: (p as any)?.projectName ?? (p as any)?.project_name ?? undefined,
        folder_path: folder,
        from_milestone_path: fromPath,
        milestone_path: newPath,
        level: newLevel,
        parent_milestone: newParentPath || undefined,
      },
      summary: `✏️ 更新里程碑 ${fromPath} → ${newPath}`,
    });
  }

  public async markDone(projectFolderPath: string): Promise<void> {
    const folder = norm(projectFolderPath);
    const p = this._byFolder.get(folder);
    const infoPath = p?.infoFilePath || norm(`${folder}/项目信息.md`);
    const af = this.host.app.vault.getAbstractFileByPath(infoPath);
    if (!af || !(af instanceof TFile)) throw new Error("未找到项目信息文件");
    await this.host.app.fileManager.processFrontMatter(af, (fm) => {
      fm.status = "done";
      // 约定：done=YYYY-MM-DD（用于筛选/展示）；done_time=ISO 时间（用于精确时间/排序）
      const nowIso = toLocalOffsetIsoString();
      const d = todayYmd();
      (fm as any).done = d;
      (fm as any).done_time = nowIso;

      // clean legacy keys
      delete (fm as any).done_date;
      delete (fm as any).doneDate;
      delete (fm as any).completed_time;
      delete (fm as any).completed_date;
      delete (fm as any).completed;

      delete (fm as any).pending_archive_at;
      delete (fm as any).pending_archive_time;
      delete (fm as any).pendingArchiveAt;

      delete (fm as any).cancelled;
      delete (fm as any).cancelled_time;
      delete (fm as any).cancelled_date;
      delete (fm as any).cancel_time;
      delete (fm as any).cancel_date;
      delete (fm as any).deleted_time;
      delete (fm as any).deleted_date;
    });
    this._dirtyFolders.add(folder);
    await this.refreshDirty({ reason: "done" });
    this.host.refreshSidePanel();

    void this.host.workEventSvc?.append({
      ts: toLocalOffsetIsoString(),
      kind: "project",
      action: "done",
      source: "ui",
      ref: {
        project_id: (p as any)?.projectId ?? (p as any)?.project_id ?? undefined,
        project_name: (p as any)?.projectName ?? (p as any)?.project_name ?? undefined,
        folder_path: folder,
        status: "done",
      },
      summary: `✅ 项目完成 ${(p as any)?.projectName ?? ""}`.trim() || "✅ 项目完成",
    });
  }

  /**
   * 取消项目：status=cancelled，并写入取消日期
   * - 兼容字段：cancelled / cancelled_date
   */
  public async markCancelled(projectFolderPath: string): Promise<void> {
    const folder = norm(projectFolderPath);
    const p = this._byFolder.get(folder);
    const infoPath = p?.infoFilePath || norm(`${folder}/项目信息.md`);
    const af = this.host.app.vault.getAbstractFileByPath(infoPath);
    if (!af || !(af instanceof TFile)) throw new Error("未找到项目信息文件");
    await this.host.app.fileManager.processFrontMatter(af, (fm) => {
      fm.status = "cancelled";
      // 约定：cancelled=YYYY-MM-DD；cancelled_time=ISO 时间
      const nowIso = toLocalOffsetIsoString();
      const d = todayYmd();
      (fm as any).cancelled = d;
      (fm as any).cancelled_time = nowIso;

      // clean legacy keys
      delete (fm as any).cancelled_date;
      delete (fm as any).cancel_time;
      delete (fm as any).cancel_date;
      delete (fm as any).deleted_time;
      delete (fm as any).delete_time;
      delete (fm as any).deleted_date;
      delete (fm as any).delete_date;

      delete (fm as any).pending_archive_at;
      delete (fm as any).pending_archive_time;
      delete (fm as any).pendingArchiveAt;

      delete (fm as any).done;
      delete (fm as any).done_time;
      delete (fm as any).done_date;
      delete (fm as any).doneDate;
      delete (fm as any).completed_time;
      delete (fm as any).completed_date;
      delete (fm as any).completed;
    });
    this._dirtyFolders.add(folder);
    await this.refreshDirty({ reason: "cancelled" });
    this.host.refreshSidePanel();

    void this.host.workEventSvc?.append({
      ts: toLocalOffsetIsoString(),
      kind: "project",
      action: "cancelled",
      source: "ui",
      ref: {
        project_id: (p as any)?.projectId ?? (p as any)?.project_id ?? undefined,
        project_name: (p as any)?.projectName ?? (p as any)?.project_name ?? undefined,
        folder_path: folder,
        status: "cancelled",
      },
      summary: `🚫 项目取消 ${(p as any)?.projectName ?? ""}`.trim() || "🚫 项目取消",
    });
  }

  /**
   * 标记待归档：仅适用于已完成项目。写入 status=pending_archive 与 pending_archive_at=今日。
   * 超过「项目归档阈值」天后，由笔记归档将文件夹移入归档目录并配合索引归档。
   */
  public async markPendingArchive(projectFolderPath: string): Promise<void> {
    const folder = norm(projectFolderPath);
    const p = this._byFolder.get(folder);
    const infoPath = p?.infoFilePath || norm(`${folder}/项目信息.md`);
    const af = this.host.app.vault.getAbstractFileByPath(infoPath);
    if (!af || !(af instanceof TFile)) throw new Error("未找到项目信息文件");
    const curSt = normalizeProjectStatus(p?.status ?? "");
    assertCanMarkPendingArchive(curSt);
    await this.host.app.fileManager.processFrontMatter(af, (fm) => {
      fm.status = "pending_archive";
      const d = todayYmd();
      const nowIso = toLocalOffsetIsoString();
      (fm as any).pending_archive_at = d;
      (fm as any).pending_archive_time = nowIso;
    });
    this._dirtyFolders.add(folder);
    await this.refreshDirty({ reason: "pending_archive" });
    this.host.refreshSidePanel();

    void this.host.workEventSvc?.append({
      ts: toLocalOffsetIsoString(),
      kind: "project",
      action: "pending_archive",
      source: "ui",
      ref: {
        project_id: (p as any)?.projectId ?? (p as any)?.project_id ?? undefined,
        project_name: (p as any)?.projectName ?? (p as any)?.project_name ?? undefined,
        folder_path: folder,
        status: "pending_archive",
      },
      summary: `🗄 项目待归档 ${(p as any)?.projectName ?? ""}`.trim() || "🗄 项目待归档",
    });
  }

  /**
   * 项目延期（6.8）：按天数推迟 planned_end，写入 original_planned_end（首次）、postpone_count+1、postpone_reason，bump progress_updated。
   */
  public async postponeProject(projectFolderPath: string, days: number, reason?: string): Promise<void> {
    const folder = norm(projectFolderPath);
    const p = this._byFolder.get(folder);
    const infoPath = p?.infoFilePath || norm(`${folder}/项目信息.md`);
    const af = this.host.app.vault.getAbstractFileByPath(infoPath);
    if (!af || !(af instanceof TFile)) throw new Error("未找到项目信息文件");
    const current = String(p?.planned_end ?? "").trim();
    if (!current || !isYmd(current)) throw new Error("项目缺少计划结束日，无法延期");
    const d = new Date(current + "T12:00:00");
    d.setDate(d.getDate() + Math.max(1, Math.floor(days)));
    const newPlannedEnd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    await this.host.app.fileManager.processFrontMatter(af, (fm) => {
      (fm as any).planned_end = newPlannedEnd;
      const orig = (fm as any).original_planned_end;
      if (!orig || !isYmd(String(orig))) (fm as any).original_planned_end = current;
      (fm as any).postpone_count = Math.max(0, Number((fm as any).postpone_count) || 0) + 1;
      if (reason != null) (fm as any).postpone_reason = String(reason).trim().slice(0, 500) || undefined;
      (fm as Record<string, unknown>)["progress_updated"] = toIsoNow();
    });
    this._dirtyFolders.add(folder);
    await this.refreshDirty({ reason: "postpone_project" });
    this.host.refreshSidePanel();
  }

  /**
   * 里程碑延期（6.8）：只更新该里程碑最后一条带 milestone_status 的 meta 行上的计划与延期字段。
   */
  public async postponeMilestone(projectFolderPath: string, milestonePath: string, days: number, reason?: string): Promise<void> {
    const folder = norm(projectFolderPath);
    const p = this._byFolder.get(folder);
    const taskPath = p?.tasklistFilePath || norm(`${folder}/项目任务清单.md`);
    let taskFile: TFile | null = this.host.app.vault.getAbstractFileByPath(taskPath) instanceof TFile
      ? this.host.app.vault.getAbstractFileByPath(taskPath) as TFile
      : null;
    if (!taskFile) {
      const leg = this.host.app.vault.getAbstractFileByPath(norm(`${folder}/项目清单.md`));
      if (leg instanceof TFile) taskFile = leg;
    }
    if (!taskFile) throw new Error("未找到项目任务清单文件");
    const text = await safeRead(this.host.app, taskFile);
    const lines = text.split(/\r?\n/);
    const nodes = parseMilestoneNodes(text);
    const node = nodes.find((n) => String((n as any).path ?? "").trim() === milestonePath);
    if (!node) throw new Error("未找到该里程碑");
    const nodeLevel = Number((node as any).level ?? 1) || 1;
    if (nodeLevel !== 1) throw new Error("仅一级里程碑支持计划完成日延期");
    const from = (node as any).headingLineNo != null ? (node as any).headingLineNo + 1 : 0;
    const to = (node as any).insertBeforeLineNo != null ? (node as any).insertBeforeLineNo : lines.length;
    let lastStatusLineIdx = -1;
    for (let j = from; j < to; j++) {
      const s = String(lines[j] ?? "").trim();
      if (/<!--\s*rslatte:.*milestone_status\s*=/i.test(s)) lastStatusLineIdx = j;
    }
    if (lastStatusLineIdx < 0) throw new Error("该里程碑下未找到带 milestone_status 的 meta 行，无法延期");
    const line = String(lines[lastStatusLineIdx] ?? "");
    const mm = line.match(/<!--\s*rslatte:([\s\S]*?)-->/i);
    if (!mm?.[1]) throw new Error("无法解析里程碑 meta");
    const body = mm[1].replace(/\s+/g, " ").trim();
    const kv: Record<string, string> = {};
    body.split(/[;\s]+/).forEach((seg) => {
      const eq = seg.indexOf("=");
      if (eq > 0) kv[seg.slice(0, eq).trim()] = seg.slice(eq + 1).trim();
    });
    const currentPlanned = kv["milestone_planned_end"] && /^\d{4}-\d{2}-\d{2}$/.test(kv["milestone_planned_end"]) ? kv["milestone_planned_end"] : undefined;
    const base = currentPlanned ?? todayYmd();
    const d = new Date(base + "T12:00:00");
    d.setDate(d.getDate() + Math.max(1, Math.floor(days)));
    const newPlannedEnd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    kv["milestone_planned_end"] = newPlannedEnd;
    if (!kv["milestone_original_planned_end"] || !/^\d{4}-\d{2}-\d{2}$/.test(kv["milestone_original_planned_end"]))
      kv["milestone_original_planned_end"] = currentPlanned ?? base;
    kv["milestone_postpone_count"] = String(Math.max(0, parseInt(kv["milestone_postpone_count"] || "0", 10)) + 1);
    if (reason != null) kv["milestone_postpone_reason"] = String(reason).trim().slice(0, 500) || "";
    const newComment = buildMilestoneRslatteMetaComment(kv);
    const newLine = line.replace(/<!--\s*rslatte:[\s\S]*?-->/i, newComment);
    lines[lastStatusLineIdx] = newLine;
    await this.host.app.vault.modify(taskFile, lines.join("\n"));
    this._dirtyFolders.add(folder);
    await this.refreshDirty({ reason: "postpone_milestone" });
    this.host.refreshSidePanel();
    await this.bumpProjectInfoProgressUpdated(folder);
  }

  /**
   * 恢复项目：将状态从 cancelled 改为 in-progress
   * - 清除 cancelled 相关字段
   * - 设置 status 为 in-progress
   */
  public async recoverProject(projectFolderPath: string): Promise<void> {
    const folder = norm(projectFolderPath);
    const p = this._byFolder.get(folder);
    const infoPath = p?.infoFilePath || norm(`${folder}/项目信息.md`);
    const af = this.host.app.vault.getAbstractFileByPath(infoPath);
    if (!af || !(af instanceof TFile)) throw new Error("未找到项目信息文件");
    const cur = normalizeProjectStatus(
      p?.status ?? (await readFrontmatter(this.host.app, af, { preferCache: false }))?.status
    );
    const tr = getRecoverProjectTransition(cur);
    await this.host.app.fileManager.processFrontMatter(af, (fm) => {
      if (tr.clearPendingArchiveFields) {
        fm.status = "done";
        delete (fm as any).pending_archive_at;
        delete (fm as any).pending_archive_time;
        delete (fm as any).pendingArchiveAt;
        return;
      }

      fm.status = "in-progress";

      if (tr.clearCancelledFields) {
        delete (fm as any).cancelled;
        delete (fm as any).cancelled_time;
        delete (fm as any).cancelled_date;
        delete (fm as any).cancel_time;
        delete (fm as any).cancel_date;
        delete (fm as any).deleted_time;
        delete (fm as any).deleted_date;
        delete (fm as any).delete_time;
        delete (fm as any).delete_date;
      }
    });
    this._dirtyFolders.add(folder);
    await this.refreshDirty({ reason: "recover" });
    this.host.refreshSidePanel();

    void this.host.workEventSvc?.append({
      ts: toLocalOffsetIsoString(),
      kind: "project",
      action: "recover",
      source: "ui",
      ref: {
        project_id: (p as any)?.projectId ?? (p as any)?.project_id ?? undefined,
        project_name: (p as any)?.projectName ?? (p as any)?.project_name ?? undefined,
        folder_path: folder,
        status: tr.refStatus,
      },
      summary:
        `${tr.workEventSummaryPrefix} ${(p as any)?.projectName ?? ""}`.trim() || tr.workEventSummaryPrefix,
    });
  }

  /**
   * 在指定里程碑下新增任务（插入到该里程碑最后一条任务后，即下一个里程碑标题之前）
   * 任务格式与任务清单一致：📅/⏳/➕；开始日期 🛫 不在新增时写入，由「开始处理」时写入。
   */
  public async addTaskToMilestone(
    projectFolderPath: string,
    milestoneName: string,
    text: string,
    dueDate: string,
    scheduledDate?: string,
    estimateH?: number,
    complexity?: "high" | "normal" | "light"
  ): Promise<void> {
    const folder = norm(projectFolderPath);
    // milestoneName is now treated as a milestone PATH (L1 / L2 / L3).
    // (kept parameter name for compatibility)
    const name = String(milestoneName ?? "").trim();
    const t = String(text ?? "").trim();
    if (!name) throw new Error("里程碑名称为空");
    if (!t) throw new Error("任务描述为空");

    const due = String(dueDate ?? "").trim();
    const scheduled = String(scheduledDate ?? "").trim();

    if (!isYmd(due)) throw new Error("到期日期（due）为必填，且格式必须为 YYYY-MM-DD");
    if (scheduled && !isYmd(scheduled)) throw new Error("计划日期（scheduled）格式必须为 YYYY-MM-DD");

    const p = this._byFolder.get(folder);
    const taskPath = p?.tasklistFilePath || norm(`${folder}/项目任务清单.md`);
    const af = this.host.app.vault.getAbstractFileByPath(taskPath);
    // 兼容旧文件名：项目清单.md
    let taskFile: TFile | null = af instanceof TFile ? af : null;
    if (!taskFile) {
      const legacy = this.host.app.vault.getAbstractFileByPath(norm(`${folder}/项目清单.md`));
      if (legacy instanceof TFile) taskFile = legacy;
    }
    if (!taskFile) throw new Error("未找到项目任务清单文件");

    const md = await safeRead(this.host.app, taskFile);
    if (!hasMilestoneHeading(md, name)) throw new Error("未找到该里程碑标题");

    const lines = md.split(/\r?\n/);
    const nodes = parseMilestoneNodes(md);
    const matches = nodes.filter((n) => n.path === name || (!name.includes("/") && n.name === name));
    if (!matches.length) throw new Error("未找到该里程碑标题");
    if (matches.length > 1 && !nodes.some((n) => n.path === name)) {
      throw new Error("存在多个同名里程碑，请在下拉框中选择‘路径（一级 / 二级 / 三级）’形式的里程碑");
    }
    const node = matches.find((n) => n.path === name) ?? matches[0];

    // Insert point: BEFORE the first next heading of ANY level after this milestone heading.
    // This ensures tasks added to a parent milestone won't be placed into a child milestone.
    const insertAt = Math.max(0, Math.min(lines.length, Number(node.insertBeforeLineNo ?? lines.length)));

    const today = todayYmd();
    const taskId = this.genProjectTaskId();

    // 开始日期 🛫 不在新增时写入，由「开始处理」时写入；与任务清单一致。
    const descPrefixNew = buildDescPrefix({
      complexity: complexity && (complexity === "high" || complexity === "light") ? complexity : undefined,
    });
    const taskLine = `- [ ] ${descPrefixNew}${t} ➕ ${today}${scheduled ? ` ⏳ ${scheduled}` : ""} 📅 ${due}`;
    const metaParts = [`task_id=${taskId}`, `type=project_task`, `ts=${toIsoNow()}`, `task_phase=todo`];
    if (estimateH != null && Number(estimateH) > 0) metaParts.push(`estimate_h=${Number(estimateH)}`);
    if (complexity && (complexity === "high" || complexity === "light")) metaParts.push(`complexity=${complexity}`);
    const metaLine = `  <!-- rslatte:${metaParts.join(";")} -->`;

    // 如果插入点前一行不是空行且不是任务行，也允许直接插入（保持简单）
    lines.splice(insertAt, 0, taskLine, metaLine);

    await this.host.app.vault.modify(taskFile, lines.join("\n"));

    // 更新项目信息：start 为空则设为今天；status => in-progress
    const infoPath = p?.infoFilePath || norm(`${folder}/项目信息.md`);
    const infoAf = this.host.app.vault.getAbstractFileByPath(infoPath);
    if (infoAf && infoAf instanceof TFile) {
      await this.host.app.fileManager.processFrontMatter(infoAf, (fm) => {
        const curStart = String((fm as any).actual_start ?? fm.start ?? "").trim();
        if (!curStart) (fm as any).actual_start = today;
        delete (fm as any).start;
        // 避免往已闭环/待归档的项目里写回进行中状态
        const curSt = normalizeProjectStatus(fm.status);
        if (!isProjectTerminalForCoerceInProgress(curSt)) fm.status = "in-progress";
      });
    }

    this._dirtyFolders.add(folder);
    await this.refreshDirty({ reason: "add_task" });
    this.host.refreshSidePanel();
    await this.bumpProjectInfoProgressUpdated(folder);

    const pAfterCreate = this._byFolder.get(folder);
    const itemAfterCreate = (pAfterCreate?.taskItems ?? []).find((x) => String(x.taskId ?? "") === taskId);
    const is_next_action_for_l1 = snapshotIsNextActionForL1(itemAfterCreate);

    void this.host.workEventSvc?.append({
      ts: toLocalOffsetIsoString(),
      kind: "projecttask",
      action: "create",
      source: "ui",
      ref: enrichProjectTaskWorkEventRef(
        {
          task_id: taskId,
          text: t,
          due,
          scheduled: scheduled || undefined,
          estimate_h: estimateH,
          complexity,
          project_id: (p as any)?.projectId ?? (p as any)?.project_id ?? undefined,
          project_name: (p as any)?.projectName ?? (p as any)?.project_name ?? undefined,
          folder_path: folder,
          milestone: node.path,
          file_path: taskFile.path,
          line_no: insertAt,
          task_phase_after: "todo",
          is_next_action_for_l1,
        },
        lines,
        insertAt,
        undefined
      ),
      summary: `🧩 新增项目任务 ${t}`,
      metrics: { due, scheduled: scheduled || undefined },
    });
  }

  /**
   * CSV/批量导入：在同一里程碑下批量新增任务。
   * 仅支持任务字段：描述、计划开始日(可选)、计划结束日(必填)、工时评估(可选)。
   */
  public async addTasksToMilestoneBatch(
    projectFolderPath: string,
    milestoneName: string,
    rows: Array<{
      text: string;
      dueDate: string;
      scheduledDate?: string;
      estimateH?: number;
      complexity?: "high" | "normal" | "light";
    }>,
  ): Promise<{ created: number }> {
    const folder = norm(projectFolderPath);
    const name = String(milestoneName ?? "").trim();
    if (!name) throw new Error("里程碑名称为空");
    if (!Array.isArray(rows) || !rows.length) return { created: 0 };

    const prepared = rows
      .map((r) => ({
        text: String(r?.text ?? "").trim(),
        due: String(r?.dueDate ?? "").trim(),
        scheduled: String(r?.scheduledDate ?? "").trim(),
        estimateH: r?.estimateH,
        complexity: r?.complexity,
      }))
      .filter((x) => x.text);
    if (!prepared.length) throw new Error("没有可导入的任务");

    for (const it of prepared) {
      if (!isYmd(it.due)) throw new Error(`存在非法计划结束日：${it.due || "空"}`);
      if (it.scheduled && !isYmd(it.scheduled)) throw new Error(`存在非法计划开始日：${it.scheduled}`);
      if (it.estimateH != null && !(Number(it.estimateH) > 0)) throw new Error("工时评估必须大于 0");
    }

    const p = this._byFolder.get(folder);
    const taskPath = p?.tasklistFilePath || norm(`${folder}/项目任务清单.md`);
    const af = this.host.app.vault.getAbstractFileByPath(taskPath);
    let taskFile: TFile | null = af instanceof TFile ? af : null;
    if (!taskFile) {
      const legacy = this.host.app.vault.getAbstractFileByPath(norm(`${folder}/项目清单.md`));
      if (legacy instanceof TFile) taskFile = legacy;
    }
    if (!taskFile) throw new Error("未找到项目任务清单文件");

    const md = await safeRead(this.host.app, taskFile);
    if (!hasMilestoneHeading(md, name)) throw new Error("未找到该里程碑标题");
    const lines = md.split(/\r?\n/);
    const nodes = parseMilestoneNodes(md);
    const matches = nodes.filter((n) => n.path === name || (!name.includes("/") && n.name === name));
    if (!matches.length) throw new Error("未找到该里程碑标题");
    if (matches.length > 1 && !nodes.some((n) => n.path === name)) {
      throw new Error("存在多个同名里程碑，请在下拉框中选择‘路径（一级 / 二级 / 三级）’形式的里程碑");
    }
    const node = matches.find((n) => n.path === name) ?? matches[0];
    const insertAt = Math.max(0, Math.min(lines.length, Number(node.insertBeforeLineNo ?? lines.length)));

    const today = todayYmd();
    const blockLines: string[] = [];
    for (const it of prepared) {
      const taskId = this.genProjectTaskId();
      const descPrefixNew = buildDescPrefix({
        complexity: it.complexity && (it.complexity === "high" || it.complexity === "light") ? it.complexity : undefined,
      });
      const taskLine = `- [ ] ${descPrefixNew}${it.text} ➕ ${today}${it.scheduled ? ` ⏳ ${it.scheduled}` : ""} 📅 ${it.due}`;
      const metaParts = [`task_id=${taskId}`, `type=project_task`, `ts=${toIsoNow()}`, `task_phase=todo`];
      if (it.estimateH != null && Number(it.estimateH) > 0) metaParts.push(`estimate_h=${Number(it.estimateH)}`);
      if (it.complexity && (it.complexity === "high" || it.complexity === "light")) metaParts.push(`complexity=${it.complexity}`);
      blockLines.push(taskLine, `  <!-- rslatte:${metaParts.join(";")} -->`);
    }

    lines.splice(insertAt, 0, ...blockLines);
    await this.host.app.vault.modify(taskFile, lines.join("\n"));

    const infoPath = p?.infoFilePath || norm(`${folder}/项目信息.md`);
    const infoAf = this.host.app.vault.getAbstractFileByPath(infoPath);
    if (infoAf && infoAf instanceof TFile) {
      await this.host.app.fileManager.processFrontMatter(infoAf, (fm) => {
        const curStart = String((fm as any).actual_start ?? fm.start ?? "").trim();
        if (!curStart) (fm as any).actual_start = today;
        delete (fm as any).start;
        const curSt = normalizeProjectStatus(fm.status);
        if (!isProjectTerminalForCoerceInProgress(curSt)) fm.status = "in-progress";
      });
    }

    this._dirtyFolders.add(folder);
    await this.refreshDirty({ reason: "add_task_batch" });
    this.host.refreshSidePanel();
    await this.bumpProjectInfoProgressUpdated(folder);

    void this.host.workEventSvc?.append({
      ts: toLocalOffsetIsoString(),
      kind: "projecttask",
      action: "create",
      source: "ui",
      ref: {
        project_id: (p as any)?.projectId ?? (p as any)?.project_id ?? undefined,
        project_name: (p as any)?.projectName ?? (p as any)?.project_name ?? undefined,
        folder_path: folder,
        milestone: node.path,
        created_count: prepared.length,
        /** 批量创建无法在单条 ref 上表达多条是否 NA；今日核对以单条 create 的 ref 为准 */
        is_next_action_for_l1: false,
      },
      summary: `🧩 批量新增项目任务 ${prepared.length} 条`,
      metrics: { count: prepared.length },
    });

    return { created: prepared.length };
  }

  /**
   * List milestone paths from the project tasklist file.
   * Milestones are defined as headings: `#` / `##` / `###`.
   *
   * Returned values are PATH strings: `一级 / 二级 / 三级`.
   */
  public async listMilestoneNames(projectFolderPath: string): Promise<string[]> {
    const folder = norm(projectFolderPath);
    const p = this._byFolder.get(folder);
    const taskPath = p?.tasklistFilePath || norm(`${folder}/项目任务清单.md`);
    const af = this.host.app.vault.getAbstractFileByPath(taskPath);

    // 兼容旧文件名：项目清单.md
    let taskFile: TFile | null = af instanceof TFile ? af : null;
    if (!taskFile) {
      const legacy = this.host.app.vault.getAbstractFileByPath(norm(`${folder}/项目清单.md`));
      if (legacy instanceof TFile) taskFile = legacy;
    }
    if (!taskFile) return [];

    const md = await safeRead(this.host.app, taskFile);
    const nodes = parseMilestoneNodes(md);
    const ms = nodes
      .filter((n) => String((n as any).milestoneStatus ?? "active") !== "cancelled")
      .map((x) => String((x as any)?.path ?? "").trim())
      .filter(Boolean);

    // de-dup while preserving order
    const seen = new Set<string>();
    const out: string[] = [];
    // Always include the default milestone path for safety.
    for (const n of [DEFAULT_MILESTONE_PATH, ...ms]) {
      if (!n) continue;
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
    return out;
  }

  /**
   * Move a project task line from its current milestone block to another milestone block.
   * This edits the underlying markdown file and refreshes the project index.
   */
  public async moveProjectTaskToMilestone(
    projectFolderPath: string,
    taskRef: { taskId?: string; lineNo?: number },
    toMilestoneName: string
  ): Promise<void> {
    const folder = norm(projectFolderPath);
    // toMilestoneName is now treated as a milestone PATH (L1 / L2 / L3).
    // (kept parameter name for compatibility)
    const toPath = String(toMilestoneName ?? "").trim();
    if (!toPath) throw new Error("目标里程碑名称为空");

    const p = this._byFolder.get(folder);
    const taskPath = p?.tasklistFilePath || norm(`${folder}/项目任务清单.md`);
    const af = this.host.app.vault.getAbstractFileByPath(taskPath);
    let taskFile: TFile | null = af instanceof TFile ? af : null;
    if (!taskFile) {
      const legacy = this.host.app.vault.getAbstractFileByPath(norm(`${folder}/项目清单.md`));
      if (legacy instanceof TFile) taskFile = legacy;
    }
    if (!taskFile) throw new Error("未找到项目任务清单文件");

    const md = await safeRead(this.host.app, taskFile);
    const lines = md.split(/\r?\n/);

	const locateTaskSpan = (): { taskIdx: number; metaIdx: number | null } => {
      const isTaskLine = (l: string) => /^\s*[-*]\s+\[[ xX\/-]\]/.test(l ?? "");
      const isRSLatteMeta = (l: string) => /^\s*<!--\s*rslatte:/i.test(l ?? "");
      const tid = String(taskRef.taskId ?? "").trim();
      const hasTid = (l: string) => (tid ? String(l ?? "").includes(`task_id=${tid}`) : false);

      const getMetaIdxForTask = (taskIdx: number): number | null => {
        if (taskIdx < 0 || taskIdx >= lines.length) return null;
        const next = taskIdx + 1;
        if (next < lines.length && isRSLatteMeta(lines[next] ?? "") && (!tid || hasTid(lines[next] ?? ""))) return next;
        return null;
      };

      const isBoundTask = (idx: number): boolean => {
        if (idx < 0 || idx >= lines.length) return false;
        if (!isTaskLine(lines[idx] ?? "")) return false;
        if (!tid) return true;
        if (hasTid(lines[idx] ?? "")) return true;
        const mi = getMetaIdxForTask(idx);
        return mi !== null && hasTid(lines[mi] ?? "");
      };

      if (tid) {
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i] ?? "";
          if (!hasTid(l)) continue;

          if (isTaskLine(l)) {
            return { taskIdx: i, metaIdx: getMetaIdxForTask(i) };
          }

          if (isRSLatteMeta(l) && isBoundTask(i - 1)) {
            return { taskIdx: i - 1, metaIdx: i };
          }

          // meta moved: search nearby for a bound task line
          for (let k = Math.max(0, i - 8); k <= Math.min(lines.length - 1, i + 8); k++) {
            if (isBoundTask(k)) return { taskIdx: k, metaIdx: getMetaIdxForTask(k) };
          }
        }
      }

      // Fallback: locate by lineNo (may point to task line or meta line)
      const ln = taskRef.lineNo;
      if (typeof ln === "number" && ln >= 0 && ln < lines.length) {
        if (isBoundTask(ln)) return { taskIdx: ln, metaIdx: getMetaIdxForTask(ln) };
        if (isRSLatteMeta(lines[ln] ?? "") && isBoundTask(ln - 1)) return { taskIdx: ln - 1, metaIdx: ln };
        if (isRSLatteMeta(lines[ln] ?? "") && isBoundTask(ln + 1)) return { taskIdx: ln + 1, metaIdx: getMetaIdxForTask(ln + 1) };
      }

      throw new Error("未找到要迁移的任务行（task_id/line_no 均未匹配）");
    };

    const { taskIdx, metaIdx } = locateTaskSpan();

    const milestonePathAtLine = (idx: number): string => {
      const headingRe = /^(#{1,3})\s+(.+?)\s*$/;
      const stack: Array<{ level: 1 | 2 | 3; path: string }> = [];
      let cur = "";
      const end = Math.min(lines.length - 1, Math.max(0, idx));
      for (let i = 0; i <= end; i++) {
        const hm = (lines[i] ?? "").match(headingRe);
        if (!hm) continue;
        const level = Math.min(3, Math.max(1, hm[1].length)) as 1 | 2 | 3;
        const name = String(hm[2] ?? "").trim();
        if (!name) continue;
        while (stack.length >= level) stack.pop();
        const parentPath = stack.length ? stack[stack.length - 1].path : "";
        const path = (parentPath ? `${parentPath} / ${name}` : name).trim();
        stack.push({ level, path });
        cur = path;
      }
      return cur;
    };

    const fromPath = milestonePathAtLine(taskIdx);
    if (fromPath && fromPath === toPath) return;

    // remove the task line (and its meta line if present)
    const span: string[] = [];
    span.push(lines[taskIdx]);
    const removeCount = metaIdx === taskIdx + 1 ? 2 : 1;
    if (removeCount === 2) span.push(lines[taskIdx + 1]);
    lines.splice(taskIdx, removeCount);

    // re-locate the target milestone node (after removal)
    let md2 = lines.join("\n");
    let nodes = parseMilestoneNodes(md2);
    let matches = nodes.filter((n) => n.path === toPath || (!toPath.includes("/") && n.name === toPath));

    // If target is the default milestone and it doesn't exist yet, create it at file end.
    if (!matches.length && toPath === DEFAULT_MILESTONE_PATH) {
      // keep a blank line before the heading if needed
      if (lines.length && String(lines[lines.length - 1] ?? "").trim() !== "") lines.push("");
      lines.push(`# ${DEFAULT_MILESTONE_PATH}`);
      lines.push("");
      md2 = lines.join("\n");
      nodes = parseMilestoneNodes(md2);
      matches = nodes.filter((n) => n.path === toPath || n.name === toPath);
    }

    if (!matches.length) throw new Error("未找到目标里程碑标题");
    if (matches.length > 1 && !nodes.some((n) => n.path === toPath)) {
      throw new Error("存在多个同名里程碑，请在下拉框中选择‘路径（一级 / 二级 / 三级）’形式的里程碑");
    }
    const node = matches.find((n) => n.path === toPath) ?? matches[0];
    const insertAt = Math.max(0, Math.min(lines.length, Number(node.insertBeforeLineNo ?? lines.length)));

    lines.splice(insertAt, 0, ...span);

    // ✅ bump meta op time for the moved task (best-effort).
    const isTaskLine = (l: string) => /^\s*[-*]\s+\[[ xX\/-]\]/.test(l ?? "");
    const rel = span.findIndex((l) => isTaskLine(l));
    const insertedTaskIdx = insertAt + (rel >= 0 ? rel : 0);
    this.bumpProjectTaskMetaTsInLines(lines, insertedTaskIdx, taskRef.taskId);

    await this.host.app.vault.modify(taskFile, lines.join("\n"));

    const tidMove = String(taskRef.taskId ?? "").trim();
    const prevItemMove = (p?.taskItems ?? []).find((x) => (tidMove && x.taskId === tidMove) || x.lineNo === taskRef.lineNo);
    const is_next_action_for_l1_move = snapshotIsNextActionForL1(prevItemMove as ProjectTaskItem | undefined);

    this._dirtyFolders.add(folder);
    await this.refreshDirty({ reason: "move_project_task_milestone" });
    this.host.refreshSidePanel();

    // emit work event (best-effort)
    try {
      const tid = String(taskRef.taskId ?? "").trim();
      const prevItem = (p?.taskItems ?? []).find((x) => (tid && x.taskId === tid) || x.lineNo === taskRef.lineNo);
      const text = (prevItem?.text ?? "").trim() || "(项目任务)";
      void this.host.workEventSvc?.append({
        ts: toLocalOffsetIsoString(),
        kind: "projecttask",
        action: "update",
        source: "ui",
        ref: enrichProjectTaskWorkEventRef(
          {
            task_id: tid || undefined,
            text,
            project_id: p?.projectId || undefined,
            project_name: p?.projectName || undefined,
            folder_path: folder,
            from_milestone: fromPath || undefined,
            to_milestone: toPath,
            file_path: taskFile.path,
            line_no: insertedTaskIdx,
            is_next_action_for_l1: is_next_action_for_l1_move,
          },
          lines,
          insertedTaskIdx,
          prevItem as ProjectTaskItem | undefined
        ),
        summary: `↔️ 迁移项目任务 ${text}（${fromPath || ""} → ${toPath}）`.replace(/\s+/g, " ").trim(),
      });
    } catch {
      // ignore
    }
  }

  /**
   * Update a project task's status by editing the actual task line in the tasklist file.
   * This intentionally does NOT rely on the Tasks plugin checkbox processing.
   */
  public async setProjectTaskStatus(
    projectFolderPath: string,
    taskRef: { taskId?: string; lineNo?: number },
    next: "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED",
    opts?: { estimateH?: number }
  ): Promise<void> {
    const folder = norm(projectFolderPath);
    const p = this._byFolder.get(folder);
    const taskPath = p?.tasklistFilePath || norm(`${folder}/项目任务清单.md`);
    const af = this.host.app.vault.getAbstractFileByPath(taskPath);
    let taskFile: TFile | null = af instanceof TFile ? af : null;
    if (!taskFile) {
      const legacy = this.host.app.vault.getAbstractFileByPath(norm(`${folder}/项目清单.md`));
      if (legacy instanceof TFile) taskFile = legacy;
    }
    if (!taskFile) throw new Error("未找到项目任务清单文件");

    const md = await safeRead(this.host.app, taskFile);
    const lines = md.split(/\r?\n/);

    const locateTaskLine = (): number => {
      const isTaskLine = (l: string) => /^\s*[-*]\s+\[[ xX\/-]\]/.test(l ?? "");
      const isRSLatteMeta = (l: string) => /^\s*<!--\s*rslatte:/i.test(l ?? "");
      const tid = String(taskRef.taskId ?? "").trim();
      const hasTid = (l: string) => (tid ? String(l ?? "").includes(`task_id=${tid}`) : false);

      const isCandidateTask = (idx: number): boolean => {
        if (idx < 0 || idx >= lines.length) return false;
        if (!isTaskLine(lines[idx] ?? "")) return false;
        // Must bind to the same task_id either inline or in the immediate next-line meta
        if (tid && hasTid(lines[idx] ?? "")) return true;
        if (tid && idx + 1 < lines.length && isRSLatteMeta(lines[idx + 1] ?? "") && hasTid(lines[idx + 1] ?? "")) return true;
        return !tid;
      };

      if (tid) {
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i] ?? "";
          if (!hasTid(l)) continue;

          if (isTaskLine(l)) return i;

          // next-line meta (preferred)
          if (isRSLatteMeta(l) && isCandidateTask(i - 1)) return i - 1;

          // meta line moved: search nearby for a bound task line
          for (let k = Math.max(0, i - 8); k <= Math.min(lines.length - 1, i + 8); k++) {
            if (isCandidateTask(k)) return k;
          }

          // do NOT return the meta line itself
        }
      }

      // Fallback: locate by lineNo (may point to task line or meta line)
      const ln = taskRef.lineNo;
      if (typeof ln === "number" && ln >= 0 && ln < lines.length) {
        if (isCandidateTask(ln)) return ln;
        if (isRSLatteMeta(lines[ln] ?? "") && isCandidateTask(ln - 1)) return ln - 1;
        if (isRSLatteMeta(lines[ln] ?? "") && isCandidateTask(ln + 1)) return ln + 1;
      }

      throw new Error("未找到要更新的任务行（task_id/line_no 均未匹配）");
    };

    const idx = locateTaskLine();

    const tidNR = String(taskRef.taskId ?? "").trim();
    const prevBeforeStatusRefresh = (p?.taskItems ?? []).find(
      (x) => (tidNR && x.taskId === tidNR) || x.lineNo === taskRef.lineNo
    );
    const is_next_action_for_l1_status = snapshotIsNextActionForL1(prevBeforeStatusRefresh as ProjectTaskItem | undefined);

    const toMark = (s: typeof next): " " | "x" | "/" | "-" => {
      if (s === "DONE") return "x";
      if (s === "IN_PROGRESS") return "/";
      if (s === "CANCELLED") return "-";
      return " ";
    };

    const todayYmd = (() => {
      try {
        return (moment as any)().format("YYYY-MM-DD");
      } catch {
        const d = new Date();
        const yyyy = String(d.getFullYear());
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        return `${yyyy}-${mm}-${dd}`;
      }
    })();

    const removeStatusDates = (line: string): string =>
      line
        // ✅ 2026-01-01 / ❌ 2026-01-01
        .replace(/\s*[✅❌]\s*\d{4}-\d{2}-\d{2}/g, "")
        .replace(/\s{2,}/g, " ")
        .trimEnd();

    const insertBeforeFirstComment = (line: string, insertion: string): string => {
      const pos = line.indexOf("<!--");
      if (pos < 0) return `${line}${insertion}`;
      const left = line.slice(0, pos).trimEnd();
      const right = line.slice(pos);
      return `${left}${insertion} ${right}`.replace(/\s{2,}/g, " ");
    };

    const oldLine = lines[idx];
    // 1) checkbox mark
    let newLine = oldLine.replace(/^([\s]*-\s*\[)([ x\/-])([\]\s])/, `$1${toMark(next)}$3`);
    // 2) align with task rslatte: write/remove ✅/❌ dates
    newLine = removeStatusDates(newLine);
    if (next === "DONE") newLine = insertBeforeFirstComment(newLine, ` ✅ ${todayYmd}`);
    if (next === "CANCELLED") newLine = insertBeforeFirstComment(newLine, ` ❌ ${todayYmd}`);
    // 3) 当状态变为 IN_PROGRESS 时，如果还没有 🛫 标记，则添加它（用于记录 start_date）
    if (next === "IN_PROGRESS") {
      const hasStartDate = /🛫\s*\d{4}-\d{2}-\d{2}/.test(newLine);
      if (!hasStartDate) {
        newLine = insertBeforeFirstComment(newLine, ` 🛫 ${todayYmd}`);
      }
    }

    let changed = false;
    if (newLine !== oldLine) {
      lines[idx] = newLine;
      changed = true;
    }

    // ✅ also write operation time into the task meta (ts=...), keeping the task+meta contract.
    const bumpExtra =
      next === "DONE" && opts?.estimateH != null && Number(opts.estimateH) > 0
        ? { estimateH: Number(opts.estimateH) }
        : undefined;
    if (this.bumpProjectTaskMetaTsInLines(lines, idx, taskRef.taskId, bumpExtra)) {
      changed = true;
    }

    const tidForMeta = String(taskRef.taskId ?? "").trim();
    if (tidForMeta) {
      const displayPhase =
        next === "DONE" ? "done" : next === "CANCELLED" ? "cancelled" : next === "TODO" ? "todo" : "in_progress";
      if (this.patchProjectTaskMetaInLines(lines, idx, taskRef.taskId, { task_phase: displayPhase })) {
        changed = true;
      }
    }

    if (changed) {
      await this.host.app.vault.modify(taskFile, lines.join("\n"));
    }

    // refresh index and enqueue db sync if enabled
    this._dirtyFolders.add(folder);
    await this.refreshDirty({ reason: "set_project_task_status" });
    this.host.refreshSidePanel();
    await this.bumpProjectInfoProgressUpdated(folder);

    // emit work event (best-effort)
    try {
      const tid = String(taskRef.taskId ?? "").trim();
      const prevItem = (p?.taskItems ?? []).find((x) => (tid && x.taskId === tid) || x.lineNo === taskRef.lineNo);
      const phaseBeforeSt = projectTaskRowPhase(prevItem);
      const phaseAfterSt =
        next === "DONE" ? "done" : next === "CANCELLED" ? "cancelled" : next === "TODO" ? "todo" : "in_progress";
      const text = (prevItem?.text ?? "").trim() || "(项目任务)";
      const milestone = String((prevItem as any)?.milestonePath ?? prevItem?.milestone ?? "").trim() || undefined;
      const icon = next === "DONE" ? "✅" : next === "CANCELLED" ? "⛔" : next === "IN_PROGRESS" ? "▶" : "⏸";
      
      // ✅ 判断 IN_PROGRESS 是 start 还是 continued
      let action: string;
      if (next === "DONE") {
        action = "done";
      } else if (next === "CANCELLED") {
        action = "cancelled";
      } else if (next === "IN_PROGRESS") {
        // 从 oldLine 解析之前的状态（修改前的 checkbox mark）
        const prevStatusMatch = oldLine.match(/^[\s]*-\s*\[([ x\/-])\]/);
        const prevStatusMark = prevStatusMatch?.[1] ?? " ";
        const prevStatus = prevStatusMark === " " ? "TODO" : prevStatusMark === "/" ? "IN_PROGRESS" : prevStatusMark === "x" ? "DONE" : "CANCELLED";
        
        // 检查任务是否曾经开始过（通过检查是否有 🛫 标记或 actual_start）
        const hasStartDate = /🛫\s*\d{4}-\d{2}-\d{2}/.test(oldLine) || ((prevItem as any)?.actual_start != null);
        
        // 判断逻辑：
        // 1. 如果之前是 TODO 且从未开始过（没有 🛫 标记），则是 start（首次开始）
        // 2. 如果之前是 TODO 但曾经开始过（有 🛫 标记），则是 continued（恢复进行中）
        // 3. 如果之前是其他状态（DONE/CANCELLED/IN_PROGRESS），则是 continued（恢复或继续）
        if (prevStatus === "TODO" && !hasStartDate) {
          action = "start"; // 首次开始
        } else {
          action = "continued"; // 继续（恢复进行中）
        }
      } else {
        action = "paused";
      }
      
      void this.host.workEventSvc?.append({
        ts: toLocalOffsetIsoString(),
        kind: "projecttask",
        action: action as any,
        source: "ui",
        ref: enrichProjectTaskWorkEventRef(
          {
            task_id: tid || undefined,
            to: next,
            text,
            project_id: p?.projectId || undefined,
            project_name: p?.projectName || undefined,
            folder_path: folder,
            milestone,
            file_path: taskFile.path,
            line_no: idx,
            task_phase_before: phaseBeforeSt,
            task_phase_after: phaseAfterSt,
            is_next_action_for_l1: is_next_action_for_l1_status,
          },
          lines,
          idx,
          prevItem as ProjectTaskItem | undefined
        ),
        summary: `${icon} 项目任务 ${text}`,
      });
    } catch {
      // ignore
    }
  }

  /** 项目任务：追加关联日程 uid 到 meta `linked_schedule_uids`（逗号分隔）。 */
  public async appendLinkedScheduleUidToProjectTask(
    projectFolderPath: string,
    taskRef: { taskId?: string; lineNo?: number },
    scheduleUid: string
  ): Promise<{ ok: boolean; changed: boolean; reason?: string }> {
    const folder = norm(projectFolderPath);
    const p = this._byFolder.get(folder);
    const su = String(scheduleUid ?? "").trim();
    if (!su) return { ok: false, changed: false, reason: "missing scheduleUid" };
    const taskPath = p?.tasklistFilePath || norm(`${folder}/项目任务清单.md`);
    const af = this.host.app.vault.getAbstractFileByPath(taskPath);
    let taskFile: TFile | null = af instanceof TFile ? af : null;
    if (!taskFile) {
      const legacy = this.host.app.vault.getAbstractFileByPath(norm(`${folder}/项目清单.md`));
      if (legacy instanceof TFile) taskFile = legacy;
    }
    if (!taskFile) return { ok: false, changed: false, reason: "tasklist file not found" };
    const md = await safeRead(this.host.app, taskFile);
    const lines = md.split(/\r?\n/);
    const locateTaskLine = (): number => {
      const isTaskLine = (l: string) => /^\s*[-*]\s+\[[ xX\/-]\]/.test(l ?? "");
      const isRSLatteMeta = (l: string) => /^\s*<!--\s*rslatte:/i.test(l ?? "");
      const tid = String(taskRef.taskId ?? "").trim();
      const hasTid = (l: string) => (tid ? String(l ?? "").includes(`task_id=${tid}`) : false);
      const isCandidateTask = (idx: number): boolean => {
        if (idx < 0 || idx >= lines.length) return false;
        if (!isTaskLine(lines[idx] ?? "")) return false;
        if (tid && hasTid(lines[idx] ?? "")) return true;
        if (tid && idx + 1 < lines.length && isRSLatteMeta(lines[idx + 1] ?? "") && hasTid(lines[idx + 1] ?? "")) return true;
        return !tid;
      };
      if (tid) {
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i] ?? "";
          if (!hasTid(l)) continue;
          if (isTaskLine(l)) return i;
          if (isRSLatteMeta(l) && isCandidateTask(i - 1)) return i - 1;
          for (let k = Math.max(0, i - 8); k <= Math.min(lines.length - 1, i + 8); k++) {
            if (isCandidateTask(k)) return k;
          }
        }
      }
      const ln = taskRef.lineNo;
      if (typeof ln === "number" && ln >= 0 && ln < lines.length) {
        if (isCandidateTask(ln)) return ln;
        if (isRSLatteMeta(lines[ln] ?? "") && isCandidateTask(ln - 1)) return ln - 1;
        if (isRSLatteMeta(lines[ln] ?? "") && isCandidateTask(ln + 1)) return ln + 1;
      }
      throw new Error("未找到项目任务行");
    };
    const idx = locateTaskLine();
    const prevItem = (p?.taskItems ?? []).find((x) => {
      const tid = String(taskRef.taskId ?? "").trim();
      return (tid && x.taskId === tid) || x.lineNo === taskRef.lineNo;
    });
    const oldList = Array.isArray((prevItem as any)?.linked_schedule_uids)
      ? ((prevItem as any).linked_schedule_uids as string[]).map((x) => String(x ?? "").trim()).filter(Boolean)
      : [];
    const merged = Array.from(new Set([...oldList, su]));
    let changed = false;
    if (this.patchProjectTaskMetaInLines(lines, idx, taskRef.taskId, { linked_schedule_uids: merged.join(",") })) changed = true;
    if (this.bumpProjectTaskMetaTsInLines(lines, idx, taskRef.taskId)) changed = true;
    if (!changed) return { ok: true, changed: false };
    await this.host.app.vault.modify(taskFile, lines.join("\n"));
    this._dirtyFolders.add(folder);
    await this.refreshDirty({ reason: "append_project_task_linked_schedule" });
    this.host.refreshSidePanel();
    await this.bumpProjectInfoProgressUpdated(folder);
    return { ok: true, changed: true };
  }

  /**
   * 设置项目任务阶段（处理中/等待他人/等待中），并可选写入进度备注、等待到期日。
   * 会将任务设为 [/]，无 🛫 时写入开始日期；meta 写入 task_phase、progress_updated、progress_note（编码）、wait_until。
   */
  public async setProjectTaskPhase(
    projectFolderPath: string,
    taskRef: { taskId?: string; lineNo?: number },
    phase: "in_progress" | "waiting_others" | "waiting_until",
    opts?: { progressNote?: string; waitUntil?: string; followUp?: string; followContactUids?: string[]; followContactNames?: string[] }
  ): Promise<void> {
    const folder = norm(projectFolderPath);
    const p = this._byFolder.get(folder);
    const taskPath = p?.tasklistFilePath || norm(`${folder}/项目任务清单.md`);
    let taskFile: TFile | null = this.host.app.vault.getAbstractFileByPath(taskPath) instanceof TFile
      ? this.host.app.vault.getAbstractFileByPath(taskPath) as TFile
      : null;
    if (!taskFile) {
      const leg = this.host.app.vault.getAbstractFileByPath(norm(`${folder}/项目清单.md`));
      if (leg instanceof TFile) taskFile = leg;
    }
    if (!taskFile) throw new Error("未找到项目任务清单文件");

    const md = await safeRead(this.host.app, taskFile);
    const lines = md.split(/\r?\n/);

    const locateTaskLine = (): number => {
      const isTaskLine = (l: string) => /^\s*[-*]\s+\[[ xX\/-]\]/.test(l ?? "");
      const isRSLatteMeta = (l: string) => /^\s*<!--\s*rslatte:/i.test(l ?? "");
      const tid = String(taskRef.taskId ?? "").trim();
      const hasTid = (l: string) => (tid ? String(l ?? "").includes(`task_id=${tid}`) : false);
      const isCandidateTask = (idx: number): boolean => {
        if (idx < 0 || idx >= lines.length) return false;
        if (!isTaskLine(lines[idx] ?? "")) return false;
        if (tid && hasTid(lines[idx] ?? "")) return true;
        if (tid && idx + 1 < lines.length && isRSLatteMeta(lines[idx + 1] ?? "") && hasTid(lines[idx + 1] ?? "")) return true;
        return !tid;
      };
      if (tid) {
        for (let i = 0; i < lines.length; i++) {
          if (!hasTid(lines[i] ?? "")) continue;
          if (isTaskLine(lines[i] ?? "")) return i;
          if (isRSLatteMeta(lines[i] ?? "") && isCandidateTask(i - 1)) return i - 1;
          for (let k = Math.max(0, i - 8); k <= Math.min(lines.length - 1, i + 8); k++) {
            if (isCandidateTask(k)) return k;
          }
        }
      }
      const ln = taskRef.lineNo;
      if (typeof ln === "number" && ln >= 0 && ln < lines.length) {
        if (isCandidateTask(ln)) return ln;
        if (isRSLatteMeta(lines[ln] ?? "") && isCandidateTask(ln - 1)) return ln - 1;
        if (isRSLatteMeta(lines[ln] ?? "") && isCandidateTask(ln + 1)) return ln + 1;
      }
      throw new Error("未找到要更新的任务行");
    };

    const idx = locateTaskLine();
    const oldLineForPhaseEvent = lines[idx] ?? "";
    const tidPh = String(taskRef.taskId ?? "").trim();
    const prevItemForPhase = (p?.taskItems ?? []).find((x) => (tidPh && x.taskId === tidPh) || x.lineNo === taskRef.lineNo);
    const phaseBeforeMeta = projectTaskRowPhase(prevItemForPhase);
    const today = todayYmd();
    const insertBeforeFirstComment = (line: string, insertion: string): string => {
      const pos = line.indexOf("<!--");
      if (pos < 0) return `${line}${insertion}`;
      const left = line.slice(0, pos).trimEnd();
      const right = line.slice(pos);
      return `${left}${insertion} ${right}`.replace(/\s{2,}/g, " ");
    };

    let newLine = lines[idx];
    if (!/^[\s]*-\s*\[\s*\/\s*\]/.test(newLine)) {
      newLine = newLine.replace(/^([\s]*-\s*\[)([ x\/-])([\]\s])/, "$1/$3");
    }
    if (!/🛫\s*\d{4}-\d{2}-\d{2}/.test(newLine)) {
      newLine = insertBeforeFirstComment(newLine, ` 🛫 ${today}`);
    }
    lines[idx] = newLine;

    const progressNoteRaw = opts?.progressNote != null && opts.progressNote !== "" ? opts.progressNote.trim().slice(0, 2000) : "";
    const patch: Record<string, string> = {
      task_phase: phase,
      progress_updated: toIsoNow(),
      ...(progressNoteRaw && { progress_note: progressNoteRaw.replace(/\s+/g, "\u200B") }),
      ...(phase === "waiting_until" && opts?.waitUntil && /^\d{4}-\d{2}-\d{2}$/.test(opts.waitUntil) && { wait_until: opts.waitUntil }),
      ...(phase === "waiting_others" && opts?.followUp && /^\d{4}-\d{2}-\d{2}$/.test(opts.followUp) && { follow_up: opts.followUp }),
    };
    if ((phase === "waiting_others" || phase === "waiting_until") && Array.isArray(opts?.followContactUids) && opts.followContactUids.length > 0) {
      const normUids = opts.followContactUids.map((u) => String(u ?? "").trim()).filter(Boolean);
      if (normUids.length > 0) patch.follow_contact_uids = normUids.join(",");
      const followNames = Array.isArray(opts?.followContactNames) ? opts.followContactNames : [];
      if (followNames.length > 0 && normUids.length > 0) {
        const normNames = normUids.map((uid, idx) => {
          const raw = String(followNames[idx] ?? "").trim();
          const fallback = uid;
          return (raw || fallback).replace(/[;\r\n|]+/g, " ").trim() || fallback;
        });
        patch.follow_contact_name = normNames.join("|");
      }
    }
    this.patchProjectTaskMetaInLines(lines, idx, taskRef.taskId, patch);

    await this.host.app.vault.modify(taskFile, lines.join("\n"));
    this._dirtyFolders.add(folder);
    await this.refreshDirty({ reason: "set_project_task_phase" });
    this.host.refreshSidePanel();
    await this.bumpProjectInfoProgressUpdated(folder);

    try {
      const tidEv = String(taskRef.taskId ?? "").trim();
      const textEv = (prevItemForPhase?.text ?? "").trim() || "(项目任务)";
      const milestoneEv = String((prevItemForPhase as any)?.milestonePath ?? prevItemForPhase?.milestone ?? "").trim() || undefined;
      const phaseAfterMeta = phase;
      let actionEv: "start" | "continued" | "paused" = "continued";
      let icon = "▶";
      if (phase === "in_progress") {
        const prevStatusMatch = oldLineForPhaseEvent.match(/^[\s]*-\s*\[([ x\/-])\]/);
        const prevStatusMark = prevStatusMatch?.[1] ?? " ";
        const prevStatus =
          prevStatusMark === " " ? "TODO" : prevStatusMark === "/" ? "IN_PROGRESS" : prevStatusMark === "x" ? "DONE" : "CANCELLED";
        const hasStartDate = /🛫\s*\d{4}-\d{2}-\d{2}/.test(oldLineForPhaseEvent) || !!(prevItemForPhase as any)?.actual_start;
        if (prevStatus === "TODO" && !hasStartDate) actionEv = "start";
        icon = "▶";
      } else if (phase === "waiting_others") {
        actionEv = "continued";
        icon = "↻";
      } else {
        actionEv = "paused";
        icon = "⏸";
      }
      const weakFromOpts = Array.isArray(opts?.followContactUids)
        ? opts.followContactUids.map((u) => String(u ?? "").trim()).filter(Boolean)
        : [];
      void this.host.workEventSvc?.append({
        ts: toLocalOffsetIsoString(),
        kind: "projecttask",
        action: actionEv as any,
        source: "ui",
        ref: enrichProjectTaskWorkEventRef(
          {
            task_id: tidEv || undefined,
            to: "IN_PROGRESS",
            task_phase: phase,
            text: textEv,
            project_id: p?.projectId || undefined,
            project_name: p?.projectName || undefined,
            folder_path: folder,
            milestone: milestoneEv,
            file_path: taskFile.path,
            line_no: idx,
            task_phase_before: phaseBeforeMeta,
            task_phase_after: phaseAfterMeta,
            is_next_action_for_l1: snapshotIsNextActionForL1(prevItemForPhase as ProjectTaskItem | undefined),
          },
          lines,
          idx,
          prevItemForPhase as ProjectTaskItem | undefined,
          weakFromOpts
        ),
        summary: `${icon} 项目任务进展 ${textEv}`,
      });
    } catch {
      // ignore
    }
  }

  /**
   * 项目任务延期：到期日顺延 N 天，meta 追加 progress_note、postpone_count，首次延期写入 original_due；任务行描述前加 ↪。
   */
  public async postponeProjectTask(
    projectFolderPath: string,
    taskRef: { taskId?: string; lineNo?: number },
    days: number,
    reason?: string
  ): Promise<void> {
    const folder = norm(projectFolderPath);
    const p = this._byFolder.get(folder);
    const taskPath = p?.tasklistFilePath || norm(`${folder}/项目任务清单.md`);
    let taskFile: TFile | null = this.host.app.vault.getAbstractFileByPath(taskPath) instanceof TFile
      ? this.host.app.vault.getAbstractFileByPath(taskPath) as TFile
      : null;
    if (!taskFile) {
      const leg = this.host.app.vault.getAbstractFileByPath(norm(`${folder}/项目清单.md`));
      if (leg instanceof TFile) taskFile = leg;
    }
    if (!taskFile) throw new Error("未找到项目任务清单文件");

    const md = await safeRead(this.host.app, taskFile);
    const lines = md.split(/\r?\n/);

    const locateTaskLine = (): number => {
      const isTaskLine = (l: string) => /^\s*[-*]\s+\[[ xX\/-]\]/.test(l ?? "");
      const isRSLatteMeta = (l: string) => /^\s*<!--\s*rslatte:/i.test(l ?? "");
      const tid = String(taskRef.taskId ?? "").trim();
      const hasTid = (l: string) => (tid ? String(l ?? "").includes(`task_id=${tid}`) : false);
      const isCandidateTask = (idx: number): boolean => {
        if (idx < 0 || idx >= lines.length) return false;
        if (!isTaskLine(lines[idx] ?? "")) return false;
        if (tid && hasTid(lines[idx] ?? "")) return true;
        if (tid && idx + 1 < lines.length && isRSLatteMeta(lines[idx + 1] ?? "") && hasTid(lines[idx + 1] ?? "")) return true;
        return !tid;
      };
      if (tid) {
        for (let i = 0; i < lines.length; i++) {
          if (!hasTid(lines[i] ?? "")) continue;
          if (isTaskLine(lines[i] ?? "")) return i;
          if (isRSLatteMeta(lines[i] ?? "") && isCandidateTask(i - 1)) return i - 1;
          for (let k = Math.max(0, i - 8); k <= Math.min(lines.length - 1, i + 8); k++) {
            if (isCandidateTask(k)) return k;
          }
        }
      }
      const ln = taskRef.lineNo;
      if (typeof ln === "number" && ln >= 0 && ln < lines.length) {
        if (isCandidateTask(ln)) return ln;
        if (isRSLatteMeta(lines[ln] ?? "") && isCandidateTask(ln - 1)) return ln - 1;
        if (isRSLatteMeta(lines[ln] ?? "") && isCandidateTask(ln + 1)) return ln + 1;
      }
      throw new Error("未找到要更新的任务行");
    };

    const idx = locateTaskLine();
    const oldLine = lines[idx] ?? "";
    const prefixMatch = oldLine.match(/^(\s*-\s*\[[ x\/-]\]\s*)/);
    const prefix = prefixMatch ? prefixMatch[1] : "";
    let body = prefix ? oldLine.slice(prefix.length) : oldLine;
    body = body.replace(/<!--[^]*?-->/g, " ");
    const dueMatch = body.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
    const currentDue = dueMatch?.[1] ?? "";
    if (!currentDue || !isYmd(currentDue)) throw new Error("无法解析当前到期日");

    const nextDue = (() => {
      const d = new Date(currentDue + "T12:00:00");
      d.setDate(d.getDate() + Math.max(1, Math.floor(days)));
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    })();

    const tokenRe = /\s(📅|➕|⏳|🛫|✅|❌)\s/u;
    const mt = body.match(tokenRe);
    let descPart = body;
    let tokenPart = "";
    if (mt && typeof (mt as any).index === "number") {
      const cut = (mt as any).index as number;
      descPart = body.slice(0, cut).trimEnd();
      tokenPart = body.slice(cut).trimStart();
    }
    const pureDesc = descPart.replace(TASK_DESC_PREFIX_STRIP_RE, "").trim();
    const prevItem = (p?.taskItems ?? []).find((x) => (taskRef.taskId && x.taskId === taskRef.taskId) || x.lineNo === taskRef.lineNo) as ProjectTaskItem | undefined;
    const is_next_action_for_l1_postpone = snapshotIsNextActionForL1(prevItem);
    const pc = Math.max(0, (prevItem as any)?.postpone_count ?? 0) + 1;
    const newPrefixDesc = buildDescPrefix({
      starred: !!(prevItem as any)?.starred,
      postpone_count: pc,
      complexity: (prevItem as any)?.complexity,
    });
    const restTokens = tokenPart.replace(/\s*📅\s*\d{4}-\d{2}-\d{2}/g, "").replace(/\s{2,}/g, " ").trim();
    const newBody = `${newPrefixDesc}${pureDesc} 📅 ${nextDue}${restTokens ? " " + restTokens : ""}`.replace(/\s{2,}/g, " ").trim();
    lines[idx] = `${prefix}${newBody}`;

    const progressNoteValue = [((prevItem as any)?.progress_note ?? "").trim(), `延期${days}天：${(reason ?? "").trim() || "无说明"}`].filter(Boolean).join("\n").slice(0, 2000);
    const patch: Record<string, string> = {
      postpone_count: String(pc),
      progress_updated: toIsoNow(),
      progress_note: progressNoteValue.replace(/\s+/g, "\u200B"),
    };
    if ((prevItem as any)?.original_due == null || (prevItem as any)?.original_due === "") patch["original_due"] = currentDue;
    this.patchProjectTaskMetaInLines(lines, idx, taskRef.taskId, patch);

    await this.host.app.vault.modify(taskFile, lines.join("\n"));
    this._dirtyFolders.add(folder);
    await this.refreshDirty({ reason: "postpone_project_task" });
    this.host.refreshSidePanel();
    await this.bumpProjectInfoProgressUpdated(folder);

    try {
      const tidP = String(taskRef.taskId ?? "").trim();
      const textP = (prevItem?.text ?? "").trim() || "(项目任务)";
      const milestoneP = String((prevItem as any)?.milestonePath ?? prevItem?.milestone ?? "").trim() || undefined;
      const phP = projectTaskRowPhase(prevItem);
      void this.host.workEventSvc?.append({
        ts: toLocalOffsetIsoString(),
        kind: "projecttask",
        action: "update",
        source: "ui",
        ref: enrichProjectTaskWorkEventRef(
          {
            task_id: tidP || undefined,
            text: textP,
            project_id: p?.projectId || undefined,
            project_name: p?.projectName || undefined,
            folder_path: folder,
            milestone: milestoneP,
            file_path: taskFile.path,
            line_no: idx,
            task_phase_before: phP,
            task_phase_after: phP,
            days,
            is_next_action_for_l1: is_next_action_for_l1_postpone,
          },
          lines,
          idx,
          prevItem as ProjectTaskItem | undefined
        ),
        summary: `↪ 延期项目任务 ${textP}`,
        metrics: { postpone_days: days },
      });
    } catch {
      // ignore
    }
  }

  /**
   * 项目任务星标/取消星标：写 meta starred，并更新任务行描述首字符 ⭐。
   */
  public async setProjectTaskStarred(
    projectFolderPath: string,
    taskRef: { taskId?: string; lineNo?: number },
    task: Pick<ProjectTaskItem, "text" | "starred" | "postpone_count" | "complexity">,
    starred: boolean
  ): Promise<void> {
    const folder = norm(projectFolderPath);
    const p = this._byFolder.get(folder);
    const taskPath = p?.tasklistFilePath || norm(`${folder}/项目任务清单.md`);
    let taskFile: TFile | null = this.host.app.vault.getAbstractFileByPath(taskPath) instanceof TFile
      ? this.host.app.vault.getAbstractFileByPath(taskPath) as TFile
      : null;
    if (!taskFile) {
      const leg = this.host.app.vault.getAbstractFileByPath(norm(`${folder}/项目清单.md`));
      if (leg instanceof TFile) taskFile = leg;
    }
    if (!taskFile) throw new Error("未找到项目任务清单文件");

    const md = await safeRead(this.host.app, taskFile);
    const lines = md.split(/\r?\n/);

    const locateTaskLine = (): number => {
      const isTaskLine = (l: string) => /^\s*[-*]\s+\[[ xX\/-]\]/.test(l ?? "");
      const isRSLatteMeta = (l: string) => /^\s*<!--\s*rslatte:/i.test(l ?? "");
      const tid = String(taskRef.taskId ?? "").trim();
      const hasTid = (l: string) => (tid ? String(l ?? "").includes(`task_id=${tid}`) : false);
      const isCandidateTask = (idx: number): boolean => {
        if (idx < 0 || idx >= lines.length) return false;
        if (!isTaskLine(lines[idx] ?? "")) return false;
        if (tid && hasTid(lines[idx] ?? "")) return true;
        if (tid && idx + 1 < lines.length && isRSLatteMeta(lines[idx + 1] ?? "") && hasTid(lines[idx + 1] ?? "")) return true;
        return !tid;
      };
      if (tid) {
        for (let i = 0; i < lines.length; i++) {
          if (!hasTid(lines[i] ?? "")) continue;
          if (isTaskLine(lines[i] ?? "")) return i;
          if (isRSLatteMeta(lines[i] ?? "") && isCandidateTask(i - 1)) return i - 1;
          for (let k = Math.max(0, i - 8); k <= Math.min(lines.length - 1, i + 8); k++) {
            if (isCandidateTask(k)) return k;
          }
        }
      }
      const ln = taskRef.lineNo;
      if (typeof ln === "number" && ln >= 0 && ln < lines.length) {
        if (isCandidateTask(ln)) return ln;
        if (isRSLatteMeta(lines[ln] ?? "") && isCandidateTask(ln - 1)) return ln - 1;
        if (isRSLatteMeta(lines[ln] ?? "") && isCandidateTask(ln + 1)) return ln + 1;
      }
      throw new Error("未找到要更新的任务行");
    };

    const idx = locateTaskLine();
    const oldLine = lines[idx] ?? "";
    const prefixMatch = oldLine.match(/^(\s*-\s*\[[ x\/-]\]\s*)/);
    const prefix = prefixMatch ? prefixMatch[1] : "";
    let bodyAll = prefix ? oldLine.slice(prefix.length) : oldLine;
    bodyAll = bodyAll.replace(/<!--[^]*?-->/g, " ");
    const tokenRe = /\s(📅|➕|⏳|🛫|✅|❌)\s/u;
    const mt = bodyAll.match(tokenRe);
    let descPart = bodyAll;
    let tokenPart = "";
    if (mt && typeof (mt as any).index === "number") {
      const cut = (mt as any).index as number;
      descPart = bodyAll.slice(0, cut).trimEnd();
      tokenPart = bodyAll.slice(cut).trimStart();
    }
    const descPrefix = buildDescPrefix({
      starred,
      postpone_count: task.postpone_count ?? 0,
      complexity: task.complexity,
    });
    const pureDesc = descPart.replace(TASK_DESC_PREFIX_STRIP_RE, "").trim();
    const newDesc = `${descPrefix}${pureDesc}`.trim();
    const newBody = `${newDesc} ${tokenPart}`.replace(/\s{2,}/g, " ").trimEnd();
    const newLine = `${prefix}${newBody}`;
    let changed = false;
    if (newLine !== oldLine) {
      lines[idx] = newLine;
      changed = true;
    }
    if (this.patchProjectTaskMetaInLines(lines, idx, taskRef.taskId, { starred: starred ? "1" : "0" })) changed = true;
    if (changed) await this.host.app.vault.modify(taskFile, lines.join("\n"));
    this._dirtyFolders.add(folder);
    await this.refreshDirty({ reason: "set_project_task_starred" });
    this.host.refreshSidePanel();
    await this.bumpProjectInfoProgressUpdated(folder);
  }

  /**
   * Update a project task's basic info (text + due/scheduled + 可选 start；工时与复杂度写 meta)。
   * 开始日期不在弹窗填写时可不传，由「开始处理」时写入。
   */
  public async updateProjectTaskBasicInfo(
    projectFolderPath: string,
    taskRef: { taskId?: string; lineNo?: number },
    patch: { text: string; due: string; start?: string; scheduled?: string; estimateH?: number; complexity?: "high" | "normal" | "light" }
  ): Promise<void> {
    const folder = norm(projectFolderPath);
    const p = this._byFolder.get(folder);
    const taskPath = p?.tasklistFilePath || norm(`${folder}/项目任务清单.md`);
    const af = this.host.app.vault.getAbstractFileByPath(taskPath);
    let taskFile: TFile | null = af instanceof TFile ? af : null;
    if (!taskFile) {
      const legacy = this.host.app.vault.getAbstractFileByPath(norm(`${folder}/项目清单.md`));
      if (legacy instanceof TFile) taskFile = legacy;
    }
    if (!taskFile) throw new Error("未找到项目任务清单文件");

    const md = await safeRead(this.host.app, taskFile);
    const lines = md.split(/\r?\n/);

const locateTaskLine = (): number => {
      const isTaskLine = (l: string) => /^\s*[-*]\s+\[[ xX\/-]\]/.test(l ?? "");
      const isRSLatteMeta = (l: string) => /^\s*<!--\s*rslatte:/i.test(l ?? "");
      const tid = String(taskRef.taskId ?? "").trim();
      const hasTid = (l: string) => (tid ? String(l ?? "").includes(`task_id=${tid}`) : false);

      const isCandidateTask = (idx: number): boolean => {
        if (idx < 0 || idx >= lines.length) return false;
        if (!isTaskLine(lines[idx] ?? "")) return false;
        // Must bind to the same task_id either inline or in the immediate next-line meta
        if (tid && hasTid(lines[idx] ?? "")) return true;
        if (tid && idx + 1 < lines.length && isRSLatteMeta(lines[idx + 1] ?? "") && hasTid(lines[idx + 1] ?? "")) return true;
        return !tid;
      };

      if (tid) {
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i] ?? "";
          if (!hasTid(l)) continue;

          if (isTaskLine(l)) return i;

          // next-line meta (preferred)
          if (isRSLatteMeta(l) && isCandidateTask(i - 1)) return i - 1;

          // meta line moved: search nearby for a bound task line
          for (let k = Math.max(0, i - 8); k <= Math.min(lines.length - 1, i + 8); k++) {
            if (isCandidateTask(k)) return k;
          }

          // do NOT return the meta line itself
        }
      }

      // Fallback: locate by lineNo (may point to task line or meta line)
      const ln = taskRef.lineNo;
      if (typeof ln === "number" && ln >= 0 && ln < lines.length) {
        if (isCandidateTask(ln)) return ln;
        if (isRSLatteMeta(lines[ln] ?? "") && isCandidateTask(ln - 1)) return ln - 1;
        if (isRSLatteMeta(lines[ln] ?? "") && isCandidateTask(ln + 1)) return ln + 1;
      }

      throw new Error("未找到要更新的任务行（task_id/line_no 均未匹配）");
    };

    const idx = locateTaskLine();

    const oneLine = (s: string) => String(s ?? "").replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
    const text = oneLine(patch.text);
    const due = String(patch.due ?? "").trim();
    const start = String(patch.start ?? "").trim();
    const scheduled = String(patch.scheduled ?? "").trim();
    if (!text) throw new Error("任务描述不能为空");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error("到期日期为必填，格式必须为 YYYY-MM-DD");
    if (start && !/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error("开始日期格式必须为 YYYY-MM-DD");
    if (scheduled && !/^\d{4}-\d{2}-\d{2}$/.test(scheduled)) throw new Error("计划日期格式必须为 YYYY-MM-DD");
    const estimateH = patch.estimateH != null ? Number(patch.estimateH) : undefined;
    const complexity = patch.complexity && (patch.complexity === "high" || patch.complexity === "normal" || patch.complexity === "light") ? patch.complexity : undefined;

    const oldLine = lines[idx];

    const prefixMatch = oldLine.match(/^(\s*-\s*\[[ x\/-]\]\s*)/);
    const linePrefix = prefixMatch ? prefixMatch[1] : "";
    const bodyAll = linePrefix ? oldLine.slice(linePrefix.length) : oldLine;

    // 与任务清单 updateTaskBasicInfo 一致：按「空格 + 日期类 token + 空格」切开描述与尾部 token；延期前缀为 ↪（旧为 ⏳），计划开始仍为 ⏳ 日期。
    const tokenRe = /\s(📅|➕|⏳|🛫|✅|❌)\s/u;
    const mt = bodyAll.match(tokenRe);
    let descPart = bodyAll;
    let tokenPart = "";
    if (mt && typeof (mt as any).index === "number") {
      const cut = (mt as any).index as number;
      descPart = bodyAll.slice(0, cut).trimEnd();
      tokenPart = bodyAll.slice(cut).trimStart();
    }

    const comments: string[] = [];
    const commentRe = /<!--[^>]*-->/g;
    let cmm: RegExpExecArray | null;
    while ((cmm = commentRe.exec(descPart)) !== null) {
      comments.push(cmm[0]);
    }

    const tidForPrev = String(taskRef.taskId ?? "").trim();
    const prevItem = (p?.taskItems ?? []).find(
      (x) => (tidForPrev && x.taskId === tidForPrev) || x.lineNo === taskRef.lineNo
    );
    const is_next_action_for_l1_basic = snapshotIsNextActionForL1(prevItem as ProjectTaskItem | undefined);

    const complexityForLine =
      complexity != null
        ? complexity === "normal"
          ? undefined
          : complexity === "high" || complexity === "light"
            ? complexity
            : undefined
        : (prevItem as any)?.complexity === "high" || (prevItem as any)?.complexity === "light"
          ? ((prevItem as any).complexity as "high" | "light")
          : undefined;

    const descPrefix = buildDescPrefix({
      starred: !!(prevItem as any)?.starred,
      postpone_count: Number((prevItem as any)?.postpone_count ?? 0) || 0,
      complexity: complexityForLine,
    });

    const newDesc = `${descPrefix}${text}${comments.length ? " " + comments.join(" ") : ""}`.trimEnd();

    const startMatch = tokenPart.match(/\s*🛫\uFE0F?\s*(\d{4}-\d{2}-\d{2})/);
    const existingStartFromLine = startMatch?.[1] ?? "";
    const startToWrite = (start && /^\d{4}-\d{2}-\d{2}$/.test(start) ? start : "") || existingStartFromLine;

    let rest = tokenPart;
    rest = rest.replace(/\s*📅\uFE0F?\s*\d{4}-\d{2}-\d{2}/g, " ");
    rest = rest.replace(/\s*🛫\uFE0F?\s*\d{4}-\d{2}-\d{2}/g, " ");
    rest = rest.replace(/\s*⏳\uFE0F?\s*\d{4}-\d{2}-\d{2}/g, " ");
    rest = rest.replace(/\s{2,}/g, " ").trim();

    const insert = `📅 ${due}${startToWrite ? ` 🛫 ${startToWrite}` : ""}${scheduled ? ` ⏳ ${scheduled}` : ""}`.trim();
    const newBody = `${newDesc} ${insert}${rest ? " " + rest : ""}`.replace(/\s{2,}/g, " ").trimEnd();
    let nextLine = `${linePrefix}${newBody}`;
    nextLine = oneLine(nextLine);

    let changed = false;
    if (nextLine !== oldLine) {
      lines[idx] = nextLine;
      changed = true;
    }

    // ✅ update operation timestamp + estimate_h/complexity in task meta
    if (this.bumpProjectTaskMetaTsInLines(lines, idx, taskRef.taskId, {
      ...(estimateH != null && { estimateH }),
      ...(complexity && { complexity }),
    })) {
      changed = true;
    }

    if (changed) {
      await this.host.app.vault.modify(taskFile, lines.join("\n"));
    }

    this._dirtyFolders.add(folder);
    await this.refreshDirty({ reason: "update_project_task_basic" });
    this.host.refreshSidePanel();
    await this.bumpProjectInfoProgressUpdated(folder);

    try {
      const tid = String(taskRef.taskId ?? "").trim();
      const prevItem = (p?.taskItems ?? []).find((x) => (tid && x.taskId === tid) || x.lineNo === taskRef.lineNo);
      const milestone = String((prevItem as any)?.milestonePath ?? prevItem?.milestone ?? "").trim() || undefined;
      const phU = projectTaskRowPhase(prevItem as ProjectTaskItem | undefined);
      void this.host.workEventSvc?.append({
        ts: toLocalOffsetIsoString(),
        kind: "projecttask",
        action: "update",
        source: "ui",
        ref: enrichProjectTaskWorkEventRef(
          {
            task_id: tid || undefined,
            text,
            due,
            start: start || undefined,
            scheduled: scheduled || undefined,
            project_id: p?.projectId || undefined,
            project_name: p?.projectName || undefined,
            folder_path: folder,
            milestone,
            file_path: taskFile.path,
            line_no: idx,
            task_phase_before: phU,
            task_phase_after: phU,
            is_next_action_for_l1: is_next_action_for_l1_basic,
          },
          lines,
          idx,
          prevItem as ProjectTaskItem | undefined
        ),
        summary: `✏️ 修改项目任务 ${text}`,
        metrics: { due, start: start || undefined, scheduled: scheduled || undefined },
      });
    } catch {
      // ignore
    }
  }

  /**
   * 笔记归档：将 status=pending_archive 且 pending_archive_at 超阈值，或 status=cancelled 且取消日超阈值的项目文件夹移入 projectArchiveDir；随后 archiveIndexNow 做索引分片归档。
   * 已完成但未标记待归档的项目不因天数自动移动（保留在项目目录随时可查看）。
   * - 阈值：settings.projectArchiveThresholdDays（默认 90）
   * - **§8.7**：`batchLimit` 每成功搬迁 N 个文件夹后让出主线程一次（默认不限制，与旧行为一致）。
   */
  public async archiveDoneAndCancelledNow(opts?: { quiet?: boolean; batchLimit?: number }): Promise<number> {
    // 与任务管理一致：自动刷新进行中时，手动归档直接提示并退出
    if (this._refreshInFlight && this._refreshOwner === "auto") {
      if (!opts?.quiet) new Notice("项目自动刷新正在进行中，归档失败");
      return 0;
    }
    const settings = this.host.settingsRef();
    const root = norm(settings.projectRootDir);
    const archiveDir = norm(settings.projectArchiveDir);
    if (!root || !archiveDir) throw new Error("未配置项目目录/归档目录");

    await this.ensureFolder(archiveDir);
    // 归档前：使用增量刷新，只刷新有变化的项目（不需要全量扫描）
    await this.refreshDirty({ reason: "archive_pre" });

    const thresholdDays = normalizeArchiveThresholdDays((settings as any).projectArchiveThresholdDays ?? 90);
    const cutoff = (moment as any)().subtract(thresholdDays, "days").format("YYYY-MM-DD");

    const pickArchiveCutoffDate = (p: any): string | "" => {
      const st = normalizeProjectStatus(p.status);
      if (st === "pending_archive") {
        const raw = String((p as any).pending_archive_at ?? "").trim();
        const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
        return m ? m[1] : "";
      }
      if (st === "cancelled") {
        const raw = String(p.cancelled ?? "").trim();
        const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
        return m ? m[1] : "";
      }
      return "";
    };

    let moved = 0;
    const tRename = performance.now();
    for (const p of this._snapshot.projects) {
      if (!isProjectEligibleForFolderArchiveByStatus(p.status)) continue;

      const d = pickArchiveCutoffDate(p);
      if (!d) continue;
      if (d > cutoff) continue;

      const folderAf = this.host.app.vault.getAbstractFileByPath(p.folderPath);
      if (!folderAf || !(folderAf instanceof TFolder)) continue;

      let target = norm(`${archiveDir}/${p.projectName}`);
      const exists = this.host.app.vault.getAbstractFileByPath(target);
      if (exists) target = norm(`${archiveDir}/${p.projectName}-${p.projectId}`);

      try {
        await this.host.app.vault.rename(folderAf, target);
        moved++;
        await yieldIfArchiveBatchBoundary({ batchLimit: opts?.batchLimit, successCount: moved });
      } catch (e: any) {
        console.warn("archive project move failed", p.folderPath, e);
      }
    }
    if (this.isDebugLogEnabled()) {
      this.dbg("perf", "archiveDoneAndCancelledNow:rename phase", {
        moved,
        renamePhaseMs: +(performance.now() - tRename).toFixed(1),
        batchLimit: opts?.batchLimit ?? null,
      });
    }

    // §8.2：搬迁后固定顺序 — refreshDirty(archive_post) → archiveIndexNow → refreshSidePanel
    await runProjectPostPhysicalArchiveSteps({
      refreshDirty: (o) => this.refreshDirty(o),
      archiveIndexNow: (o) => this.archiveIndexNow(o),
      refreshSidePanel: () => this.host.refreshSidePanel(),
      moved,
      quiet: opts?.quiet,
    });
    return moved;
  }

  /**
   * 全量刷新（扫描项目目录）
   * - forceSync=true：手动触发时使用，刷新完成后立即落盘索引并尽快 flush 同步队列
   */
  public async refreshAll(opts?: { reason?: string; forceSync?: boolean }): Promise<void> {
    // 并发保护：同一时间只跑一个 refresh；其余请求合并
    if (this._refreshInFlight) {
      if (this.isDebugLogEnabled()) {
        this.dbg("perf", "refreshAll:skipped (refreshInFlight)", { reason: opts?.reason });
      }
      this._pendingFull = true;
      // refreshDirty 结束时也会检查 _pendingFull；这里再加一层“自愈”定时器，避免 pending 被吞掉。
      if (!this._pendingFullTimer) {
        this._pendingFullTimer = window.setTimeout(() => {
          this._pendingFullTimer = null;
          if (this._pendingFull && !this._refreshInFlight) {
            this._pendingFull = false;
            void this.refreshAll({ reason: "pending", forceSync: opts?.forceSync });
          }
        }, 300);
      }
      return;
    }

    // 最小间隔保护，避免“按钮连点 + 文件事件”造成风暴
    const now = Date.now();
    if (now - this._lastRefreshStartedAt < 800) {
      if (this.isDebugLogEnabled()) {
        this.dbg("perf", "refreshAll:skipped (throttle <800ms)", { reason: opts?.reason, sinceLastMs: now - this._lastRefreshStartedAt });
      }
      this._pendingFull = true;
      return;
    }
    this._lastRefreshStartedAt = now;
    this._refreshInFlight = true;
    this._refreshOwner = (() => {
      const r = String(opts?.reason ?? "").toLowerCase();
      if (r.startsWith("auto") || r.includes("auto")) return "auto";
      if (r.includes("manual")) return "manual";
      return "other";
    })();

    const tScan = performance.now();
    try {
      const settings = this.host.settingsRef();
      const root = norm(settings.projectRootDir);
      const archive = norm(settings.projectArchiveDir);
      if (!root) {
        if (this.isDebugLogEnabled()) this.dbg("perf", "refreshAll:empty (no projectRootDir)");
        this.commitSnapshot([]);
        return;
      }
      const rootAf = this.host.app.vault.getAbstractFileByPath(root);
      if (!rootAf || !(rootAf instanceof TFolder)) {
        if (this.isDebugLogEnabled()) this.dbg("perf", "refreshAll:empty (root not folder)", { root });
        this.commitSnapshot([]);
        return;
      }

      const folders = (rootAf.children ?? []).filter((x) => x instanceof TFolder) as TFolder[];
      const scanned = new Set<string>();
      const out: ProjectEntry[] = [];
      const perFolderMs: { path: string; ms: number }[] = [];
      for (const f of folders) {
        if (archive && (f.path === archive || isUnder(f.path, archive))) continue;
        scanned.add(norm(f.path));
        const tf = performance.now();
        const one = await this.refreshOneFolder(f.path, { reason: opts?.reason || "full" });
        if (this.isDebugLogEnabled()) {
          perFolderMs.push({ path: f.path, ms: +(performance.now() - tf).toFixed(1) });
        }
        if (one) out.push(one);
      }

      if (this.isDebugLogEnabled()) {
        const slowest = [...perFolderMs].sort((a, b) => b.ms - a.ms).slice(0, 10);
        this.dbg("perf", "refreshAll:scan done", {
          reason: opts?.reason,
          childFolderCount: folders.length,
          scannedProjectFolders: scanned.size,
          entriesBuilt: out.length,
          scanPhaseMs: +(performance.now() - tScan).toFixed(1),
          slowest10: slowest,
        });
      }

      // 清理：全量扫描后，把已不存在/已移出 root 的缓存剔除，避免“幽灵项目”残留
      for (const k of Array.from(this._byFolder.keys())) {
        const kk = norm(k);
        if (!scanned.has(kk)) {
          this._byFolder.delete(k);
        }
      }
      // dirty 队列也同步清理
      for (const k of Array.from(this._dirtyFolders.values())) {
        const kk = norm(k);
        if (!scanned.has(kk)) this._dirtyFolders.delete(k);
      }

      // NOTE: snapshot 应与“项目根目录”保持一致；归档后的项目会被移出 root，因此不应残留在 snapshot/index。
      this.commitSnapshot(Array.from(this._byFolder.values()), { keepOtherFolders: false });

      // 手动刷新：希望“立刻”触发一次索引落盘 + 同步 flush
      if (opts?.forceSync) {
        // 取消 debounce，避免用户感觉“点了没反应”
        if (this._indexDebounce) {
          window.clearTimeout(this._indexDebounce);
          this._indexDebounce = null;
        }
        const tPersist = performance.now();
        await this.persistIndexAndEnqueueSync();
        if (this.isDebugLogEnabled()) {
          this.dbg("perf", "refreshAll:persistIndexAndEnqueueSync", { ms: +(performance.now() - tPersist).toFixed(1) });
        }
        const tFlush = performance.now();
        await this.flushSyncQueue({ force: true });
        if (this.isDebugLogEnabled()) {
          this.dbg("perf", "refreshAll:flushSyncQueue", { ms: +(performance.now() - tFlush).toFixed(1) });
        }
      }
      if (this.isDebugLogEnabled()) {
        this.dbg("perf", "refreshAll:total", { reason: opts?.reason, ms: +(performance.now() - tScan).toFixed(1), _byFolderSize: this._byFolder.size });
      }
    } finally {
      this._refreshInFlight = false;
      this._refreshOwner = null;
      if (this._pendingFull) {
        this._pendingFull = false;
        // 让出事件循环，避免递归
        window.setTimeout(() => void this.refreshAll({ reason: "pending" }), 0);
      }
    }
  }

  public async refreshDirty(opts?: { reason?: string }): Promise<void> {
    if (this._refreshInFlight) {
      if (this.isDebugLogEnabled()) this.dbg("perf", "refreshDirty:skipped (refreshInFlight)", { reason: opts?.reason });
      return;
    }

    // 即使没有 dirty，也要做一次孤儿清理，避免“项目被归档/删除后索引仍残留”
    const removed = this.pruneOrphanFolders();

    const dirty = Array.from(this._dirtyFolders);
    if (!dirty.length) {
      if (removed > 0) {
        this.commitSnapshot(Array.from(this._byFolder.values()), { keepOtherFolders: false });
      }
      if (this.isDebugLogEnabled() && removed === 0) {
        this.dbg("perf", "refreshDirty:no-op (no dirty)", { reason: opts?.reason });
      }
      return;
    }

    // 节流：一次最多处理 N 个，剩余留到下一轮 interval
    const batch = dirty.slice(0, MAX_DIRTY_PER_TICK);
    batch.forEach((x) => this._dirtyFolders.delete(x));

    const t0 = performance.now();
    this._refreshInFlight = true;
    this._refreshOwner = (() => {
      const r = String(opts?.reason ?? "").toLowerCase();
      if (r.startsWith("auto") || r.includes("auto")) return "auto";
      if (r.includes("manual")) return "manual";
      return "other";
    })();
    const perFolderMs: { path: string; ms: number }[] = [];
    try {
      for (const folder of batch) {
        const tf = performance.now();
        await this.refreshOneFolder(folder, { reason: opts?.reason || "dirty" });
        if (this.isDebugLogEnabled()) {
          perFolderMs.push({ path: folder, ms: +(performance.now() - tf).toFixed(1) });
        }
      }
      this.commitSnapshot(Array.from(this._byFolder.values()), { keepOtherFolders: false });
      if (this.isDebugLogEnabled()) {
        this.dbg("perf", "refreshDirty:batch done", {
          reason: opts?.reason,
          batchSize: batch.length,
          remainingDirty: this._dirtyFolders.size,
          prunedOrphans: removed,
          totalMs: +(performance.now() - t0).toFixed(1),
          perFolderMs,
          maxDirtyPerTick: MAX_DIRTY_PER_TICK,
        });
      }
    } finally {
      this._refreshInFlight = false;
      this._refreshOwner = null;

      // 若 refreshAll 在 dirty 刷新期间被触发，补跑一次 full refresh
      if (this._pendingFull) {
        this._pendingFull = false;
        window.setTimeout(() => void this.refreshAll({ reason: "pending_after_dirty" }), 0);
      }
    }
  }

  private commitSnapshot(projects: ProjectEntry[], opts?: { keepOtherFolders?: boolean }) {
    // keepOtherFolders: true => 仅更新传入列表中的 folder；其余沿用旧值（用于全量扫描阶段）
    const now = Date.now();
    const s = this.host.settingsRef();
    const derivCtx = {
      taskPanel: s?.taskPanel,
      todayYmd: getTaskTodayKey(s?.taskPanel),
      progressMilestoneUpcomingDays: progressMilestoneUpcomingDaysFromSettings(s),
      progressProjectUpcomingDays: progressProjectUpcomingDaysFromSettings(s),
    };
    if (opts?.keepOtherFolders) {
      const map = new Map<string, ProjectEntry>();
      for (const old of this._snapshot.projects) map.set(old.folderPath, old);
      for (const cur of projects) map.set(cur.folderPath, cur);
      const merged = Array.from(map.values());
      applyProjectSnapshotDerivatives(merged, derivCtx);
      this._snapshot = { projects: merged, updatedAt: now };
    } else {
      applyProjectSnapshotDerivatives(projects, derivCtx);
      this._snapshot = { projects, updatedAt: now };
    }

    // UI 刷新 + 中央索引/同步节流
    this.host.refreshSidePanel();
    this.scheduleIndexPersist();
  }

  private scheduleIndexPersist(): void {
    if (this._indexDebounce) return;
    this._indexDebounce = window.setTimeout(() => {
      this._indexDebounce = null;
      void this.persistIndexAndEnqueueSync();
    }, 800);
  }

  private toRSLatteItem(p: ProjectEntry): ProjectRSLatteIndexItem {
    return {
      project_id: String(p.projectId ?? "").trim(),
      project_name: String(p.projectName ?? "").trim(),
      status: String(p.status ?? "todo"),
      create_date: isYmd2(p.created_date ?? "") ? p.created_date : undefined,
      due_date: isYmd2(p.planned_end ?? "") ? p.planned_end : undefined,
      start_date: isYmd2(p.actual_start ?? "") ? p.actual_start : undefined,
      done_date: isYmd2(p.done ?? "") ? p.done : undefined,
      cancelled_date: isYmd2(p.cancelled ?? "") ? p.cancelled : undefined,
      pending_archive_date: isYmd2((p as any).pending_archive_at ?? "") ? String((p as any).pending_archive_at) : undefined,
      folder_path: p.folderPath,
      info_file_path: p.infoFilePath,
      tasklist_file_path: p.tasklistFilePath,
      analysis_file_path: p.analysisFilePath,
      milestones: (p.milestones ?? []).map((m) => ({
        name: m.name,
        path: String((m as any).path ?? m.name ?? "").trim() || undefined,
        done: m.done,
        todo: m.todo,
        inprogress: m.inprogress,
        total: m.total,
      })),
      mtime_key: p.mtimeKey,
      db_sync_status: (p as any).dbSyncStatus,
      db_synced_at: (p as any).dbSyncedAt,
      db_last_error: (p as any).dbLastError,
      db_pending_ops: (p as any).dbPendingOps,
      project_tags: Array.isArray((p as any).project_tags) ? [...((p as any).project_tags as string[])] : undefined,
      project_status_display_zh: (() => {
        const z = String((p as any).project_status_display_zh ?? "").trim();
        return z || undefined;
      })(),
      updated_at: toIsoNow(),
    };
  }

  private async persistIndexAndEnqueueSync(opts?: { forceEnqueue?: boolean; forceDue?: boolean }): Promise<void> {
    const tPersist = this.isDebugLogEnabled() ? performance.now() : 0;
    try {
      await this.ensureProjectRSLatteReady();
      const store = this._idxStore!;
      const q = this._syncQueue!;

      const safeListAll = async (): Promise<any[]> => {
        const fn = (q as any)?.listAll;
        if (typeof fn !== "function") {
          console.warn("[rslatte][projectMgr] syncQueue.listAll missing", q);
          return [];
        }
        try {
          const r = await fn.call(q);
          return Array.isArray(r) ? r : [];
        } catch (e) {
          console.warn("[rslatte][projectMgr] syncQueue.listAll failed", e);
          return [];
        }
      };

      // 若项目曾被归档过，就不再写回主索引（避免被扫描反复“复活”）
      const amap = await store.readArchiveMap();
      const archivedIds = new Set(Object.keys(amap.map ?? {}));

      // 读取上一次索引，用于增量判断（mtime_key 是否变化）
      const prevIndex = await store.readIndex();
      const prevById = new Map<string, any>();
      for (const it of prevIndex.items ?? []) {
        const pid = String((it as any).project_id ?? "").trim();
        if (pid) prevById.set(pid, it);
      }

      // 当前队列中 pending 的数量，用于写回索引 & UI 展示
      const pendingCountById = new Map<string, number>();
      for (const op of await safeListAll()) {
        const pid = String(op.project_id ?? "").trim();
        if (!pid) continue;
        pendingCountById.set(pid, (pendingCountById.get(pid) ?? 0) + 1);
      }

      // --- Lightweight existence preflight (manual rebuild safety check) ---
      // ✅ 仅在“扫描重建/手动全量同步”时执行：
      // - 用户明确触发 rebuild 时，我们会尽量确保“索引加载到的数据都能覆盖入库”。
      // - 日常增量刷新不做 DB 是否存在探测，避免 DB 被清空时自动触发大规模补录。
      const projectMissingInDb = new Set<string>();
      const milestoneMissingByProject = new Map<string, Set<string>>();
      const shouldPreflightExists = this.isDbSyncEnabled() && Boolean(opts?.forceEnqueue);

      if (shouldPreflightExists) {
        try {
          const pids = (this._snapshot.projects ?? [])
            .map((p) => String(p.projectId ?? "").trim())
            .filter(Boolean)
            .filter((pid) => !archivedIds.has(pid));

          // projects/exists (max 500)
          for (const part of chunk(Array.from(new Set(pids)), 500)) {
            const r = await this.host.api.projectsExists({ ids: part }, { include_deleted: true });
            for (const m of (r?.missing ?? [])) projectMissingInDb.add(String(m));
          }

          // milestones/exists per project (avoid cross-project same id)
          for (const p of this._snapshot.projects ?? []) {
            const pid = String(p.projectId ?? "").trim();
            if (!pid || archivedIds.has(pid)) continue;
            const mids = (p.milestones ?? [])
              .map((m) => `${pid}::MS::${String((m as any)?.path ?? m?.name ?? "").trim()}`)
              .filter(Boolean);
            if (!mids.length) continue;
            const missing = new Set<string>();
            for (const part of chunk(Array.from(new Set(mids)), 500)) {
              const r = await this.host.api.milestonesExists(
                { ids: part },
                { project_id: pid, include_deleted: true }
              );
              for (const mid of (r?.missing ?? [])) missing.add(String(mid));
            }
            if (missing.size) milestoneMissingByProject.set(pid, missing);
          }

          const total = (this._snapshot.projects ?? []).filter((p) => {
            const pid = String(p.projectId ?? "").trim();
            return pid && !archivedIds.has(pid);
          }).length;
          this.dbg("exists preflight (manual)", {
            total,
            projectMissing: projectMissingInDb.size,
            milestoneMissingProjects: milestoneMissingByProject.size,
          });
        } catch (e) {
          this.dbgw("exists preflight failed", e);
        }
      }

      // DB sync enqueue（仅在启用时）
      if (this.isDbSyncEnabled()) {
        // ✅ rebuild(扫描重建) 场景：强制全量入队，确保索引中的数据“存在则覆盖、缺失则新增”。
        // 日常增量刷新：只在内容变化时入队，不因 DB 缺失而自动触发大规模补录。
        const forceAll = Boolean(opts?.forceEnqueue);

        for (const p of this._snapshot.projects ?? []) {
          const pid = String(p.projectId ?? "").trim();
          if (!pid) continue;
          if (archivedIds.has(pid)) continue;

          const prev = prevById.get(pid);
          const prevMtime = String(prev?.mtime_key ?? "");

          // 只有内容有变（mtime_key 变化）才自动入队；扫描重建/手动刷新可强制入队。
          // 即使当前 project_id 已经有 pending op，也允许“更新 payload”（queue 会保持 backoff，不会刷爆）。
          const changed = !prev || prevMtime !== String(p.mtimeKey ?? "");
          const shouldEnqueue = forceAll || changed;
          if (!shouldEnqueue) continue;

          // === DB payload mapping ===
          const projectPath = p.folderPath;
          const forceDue = Boolean(opts?.forceDue || forceAll);
          const snapshotKey = String(p.mtimeKey ?? "");

          const projectPayload: Record<string, unknown> = {
            project_id: pid,
            project_name: p.projectName,
            status: p.status,
            create_date: p.created_date,
            due_date: p.planned_end,
            start_date: p.actual_start,
            done_date: p.done,
            cancelled_date: p.cancelled,
            pending_archive_date: isYmd2((p as any).pending_archive_at ?? "")
              ? String((p as any).pending_archive_at)
              : undefined,
            project_path: projectPath,
            folder_path: projectPath,
            info_file_path: p.infoFilePath,
            tasklist_file_path: p.tasklistFilePath,
            analysis_file_path: p.analysisFilePath,
          };
          const pMeta = buildProjectInfoMetaSyncForDb(p);
          if (pMeta) projectPayload.meta_sync = pMeta;
          await q.enqueue("upsert_project", pid, projectPayload, { forceDue, snapshotKey });

          // items/*：统一使用 items 数组（里程碑 + 任务）
          const milestoneStableKey = (m: { path?: string; name?: string }) =>
            String((m as any)?.path ?? (m as any)?.name ?? "").trim();
          const taskMilestoneKey = (it: ProjectTaskItem) =>
            String((it as any)?.milestonePath ?? it.milestone ?? "").trim();
          const milestoneIdFromKey = (key: string) => `${pid}::MS::${String(key ?? "").trim()}`;
          const mapTaskStatus = (s: string): string => {
            if (s === "DONE") return "DONE";
            if (s === "IN_PROGRESS") return "IN_PROGRESS";
            if (s === "CANCELLED") return "CANCELLED";
            // default
            return "TODO";
          };
          const mapMilestoneStatus = (m: any): string => {
            const total = Number(m?.total ?? 0);
            const done = Number(m?.done ?? 0);
            const ip = Number(m?.inprogress ?? 0);
            if (total > 0 && done === total) return "DONE";
            if (ip > 0) return "IN_PROGRESS";
            return "TODO";
          };

          const itemsPayload: any[] = [];
          (p.milestones ?? []).forEach((m, idx) => {
            const msKey = milestoneStableKey(m);
            if (!msKey) return;
            const mid = milestoneIdFromKey(msKey);
            itemsPayload.push({
              project_id: pid,
              item_id: mid,
              item_type: "milestone",
              milestone_id: mid,
              title: m.name,
              status: mapMilestoneStatus(m),
              position: idx,
              source_file_path: p.tasklistFilePath,
              source_anchor: msKey,
              created_date: m.created_date,
              done_date: m.done_date,
              cancelled_date: m.cancelled_date,
            });
          });
          (p.taskItems ?? []).forEach((it, idx) => {
            const tk = taskMilestoneKey(it);
            const mid = milestoneIdFromKey(tk);
            const taskRow: Record<string, unknown> = {
              project_id: pid,
              item_id: it.taskId || `${pid}::T::${it.lineNo}`,
              item_type: "task",
              milestone_id: mid,
              title: it.text,
              status: mapTaskStatus(it.statusName),
              position: it.lineNo ?? idx,
              source_file_path: p.tasklistFilePath,
              source_anchor: tk,
              source_line: (it.lineNo ?? 0) + 1,
              raw_text: it.rawLine,
              created_date: it.created_date,
              start_date: it.actual_start,
              scheduled_date: it.planned_start,
              due_date: it.planned_end,
              done_date: it.done_date,
              cancelled_date: it.cancelled_date,
            };
            const tMeta = buildProjectTaskItemMetaSyncForDb(it);
            if (tMeta) taskRow.meta_sync = tMeta;
            itemsPayload.push(taskRow);
          });

          // ✅ 使用 replace 保证：里程碑删除/任务迁移等“移除类变更”能同步到 DB。
          // - DB reset / 新 vault 场景也更稳（无需依赖历史差异）
          // - 如果你希望后续再做“仅 upsert”，可在这里按缺失/变更类型细分
          // 避免发送空的 items 数组（可能导致 409 Conflict）
          if (itemsPayload.length > 0) {
            await q.enqueue("replace_items", pid, { items: itemsPayload }, { forceDue, snapshotKey });
          } else {
            // 如果项目没有里程碑和任务，跳过 replace_items 操作
            // 避免发送空请求导致错误
            this.dbg("skip replace_items (empty)", { project_id: pid, projectName: p.projectName });
          }

          // pending meta
          this._syncMetaById.set(pid, {
            ...(this._syncMetaById.get(pid) ?? {}),
            status: "pending",
            pendingOps: (pendingCountById.get(pid) ?? 0) + 2,
          });
          pendingCountById.set(pid, (pendingCountById.get(pid) ?? 0) + 2);
        }

        await q.compact();
        this.scheduleSyncFlush();
      }

      // 写主索引（带上 sync meta）
      const items: ProjectRSLatteIndexItem[] = [];
      for (const p of this._snapshot.projects ?? []) {
        const pid = String(p.projectId ?? "").trim();
        if (pid && archivedIds.has(pid)) continue;

        const prev = prevById.get(pid);
        const meta = this._syncMetaById.get(pid);
        const it: ProjectRSLatteIndexItem = {
          ...this.toRSLatteItem(p),
          // carry forward previous meta if newer is absent
          db_sync_status: (p as any).dbSyncStatus ?? meta?.status ?? prev?.db_sync_status,
          db_synced_at: (p as any).dbSyncedAt ?? meta?.syncedAt ?? prev?.db_synced_at,
          db_last_error: (p as any).dbLastError ?? meta?.lastError ?? prev?.db_last_error,
          db_pending_ops: (p as any).dbPendingOps ?? meta?.pendingOps ?? pendingCountById.get(pid) ?? prev?.db_pending_ops,
        };
        items.push(it);
      }
      await store.writeIndex(items);

      // refresh cache meta (so refreshOneFolder can attach without reading file again)
      this._syncMetaById.clear();
      for (const it of items) {
        const pid = String((it as any).project_id ?? "").trim();
        if (!pid) continue;
        this._syncMetaById.set(pid, {
          status: String((it as any).db_sync_status ?? "").trim() || undefined,
          syncedAt: (it as any).db_synced_at ?? undefined,
          lastError: (it as any).db_last_error ?? undefined,
          pendingOps: Number((it as any).db_pending_ops ?? 0) || undefined,
        });
      }
    } catch (e) {
      console.warn("persistIndexAndEnqueueSync failed", e);
    } finally {
      if (this.isDebugLogEnabled() && tPersist) {
        this.dbg("perf", "persistIndexAndEnqueueSync:total", {
          ms: +(performance.now() - tPersist).toFixed(1),
          snapshotProjectCount: (this._snapshot.projects ?? []).length,
          forceEnqueue: !!opts?.forceEnqueue,
        });
      }
    }
  }

  /** Generate a stable-ish id for embedding into project task lines.
   *  Format: PT_YYYYMMDD_xxxxxx
   */
  private genProjectTaskId(): string {
    const d = (moment as any)().format("YYYYMMDD");
    const r = Math.random().toString(36).slice(2, 8);
    return `PT_${d}_${r}`;
  }

  private scheduleSyncFlush(delayMs: number = 1200): void {
    // setTimeout() coerces delay via ToInt32 (32-bit signed). Passing a huge
    // number (e.g. Number.MAX_SAFE_INTEGER) will overflow and effectively
    // become 0, causing a fast loop.
    const SAFE_MAX = 2147483647; // 2^31-1
    const safeDelay = Math.min(SAFE_MAX, Math.max(500, Number(delayMs) || 0));
    this.dbg("scheduleSyncFlush", { delayMs, safeDelay, hasDebounce: !!this._syncDebounce });
    if (this._syncDebounce) return;
    this._syncDebounce = window.setTimeout(() => {
      this._syncDebounce = null;
      void this.flushSyncQueue();
    }, safeDelay);
  }

  private async flushSyncQueue(opts?: { force?: boolean }): Promise<void> {
    this.dbg("flushSyncQueue:start", { force: !!opts?.force });
    if (!this.isDbSyncEnabled()) return;
    await this.ensureProjectRSLatteReady();
    const q = this._syncQueue;
    if (!q) return;
    if (this._syncInFlight) return;

    let willRefreshSidePanel = false;

    const now = Date.now();
    if (now < this._syncCooldownUntil && !opts?.force) {
      this.scheduleSyncFlush(Math.max(500, this._syncCooldownUntil - now));
      return;
    }

    const store = this._idxStore!;

    this._syncInFlight = true;
    try {
      const due = await q.pickDue(10, { force: Boolean(opts?.force) });
      this.dbg("flushSyncQueue:due", { due: due.length });
      if (!due.length) {
        const nextAt = await q.nextRetryAt();
        if (typeof nextAt === "number" && Number.isFinite(nextAt)) {
          const d = Math.max(500, nextAt - Date.now());
          this.scheduleSyncFlush(d);
        }
        // nothing changed => do NOT refresh UI
        return;
      }

      // there are due ops, we will update badges/meta => refresh UI once in finally
      willRefreshSidePanel = true;

      for (const op of due) {
        try {
          if (op.kind === "upsert_project") {
            await this.host.api.projectsUpsert(op.payload);
          } else if (op.kind === "replace_items") {
            await this.host.api.projectItemsReplace(op.project_id, op.payload);
          } else if (op.kind === "upsert_items") {
            await this.host.api.projectItemsUpsert(op.project_id, op.payload);
          }

          await q.markSuccess(op.op_id);

          const pendingOps = (await q.listAll()).filter((x) => String(x.project_id) === String(op.project_id)).length;

          // update meta => ok
          const nowIso = toIsoNow();
          const status = pendingOps > 0 ? "pending" : "ok";
          this._syncMetaById.set(op.project_id, { status, syncedAt: nowIso, lastError: undefined, pendingOps });
          await store.patchIndexItem(op.project_id, {
            db_sync_status: status,
            db_synced_at: nowIso,
            db_last_error: undefined,
            db_pending_ops: pendingOps,
          });
        } catch (err: any) {
          const status = Number(err?.status ?? 0);
          const msg = String(err?.message ?? err ?? "unknown_error");

          // 400/422/409：请求体不匹配/校验错误/冲突 => 不重试，避免刷接口
          // 409 Conflict 通常是因为请求参数为空或格式不正确
          if (status === 400 || status === 422 || status === 409) {
            console.warn("project db sync fatal", op.kind, op.project_id, status, msg, err?.data);
            await q.markSuccess(op.op_id); // drop
            const pendingOps = (await q.listAll()).filter((x) => String(x.project_id) === String(op.project_id)).length;
            this._syncMetaById.set(op.project_id, { status: "error", lastError: `${status}: ${msg}`, pendingOps });
            await store.patchIndexItem(op.project_id, {
              db_sync_status: "error",
              db_last_error: `${status}: ${msg}`,
              db_pending_ops: pendingOps,
            });
            // fatal: stop this flush cycle
            break;
          }

          // transient: backoff + keep pending
          await q.markFailure(op.op_id, msg, 8);
          const pendingOps = (await q.listAll()).filter((x) => String(x.project_id) === String(op.project_id)).length;
          this._syncMetaById.set(op.project_id, { status: "pending", lastError: msg, pendingOps });
          await store.patchIndexItem(op.project_id, {
            db_sync_status: "pending",
            db_last_error: msg,
            db_pending_ops: pendingOps,
          });
          console.warn("project db sync failed", op.kind, op.project_id, status || "", msg);
          break;
        }
      }
    } finally {
      this._syncInFlight = false;

      // schedule next flush if needed
      const nextAt = await q.nextRetryAt();
      if (typeof nextAt === "number" && Number.isFinite(nextAt)) {
        const d = Math.max(500, nextAt - Date.now());
        this.scheduleSyncFlush(d);
      }

      // 模块级状态灯：更新 pending/failed 计数（即使本轮没有 due ops，也更新一次）
      try {
        const ops = await q.listAll();
        const pendingCount = ops.length;
        const failedOps = ops.filter((o: any) => Boolean((o as any).last_error));
        const failedCount = failedOps.length;
        const err = failedOps.length ? String((failedOps[0] as any).last_error ?? "") : undefined;
        this.host.reportDbSyncWithCounts?.({
          pendingCount,
          failedCount,
          ok: failedCount === 0 && pendingCount === 0,
          err: err || undefined,
        });
      } catch {}

      // UI refresh to show sync badges
      this.dbg("flushSyncQueue:finally", { willRefreshSidePanel });
      if (willRefreshSidePanel) {
        this.host.refreshSidePanel();
      }
    }
  }

  private async refreshOneFolder(folderPath: string, opts?: { reason?: string }): Promise<ProjectEntry | null> {
    const folder = norm(folderPath);
    const settings = this.host.settingsRef();
    const root = norm(settings.projectRootDir);
    const archive = norm(settings.projectArchiveDir);
    if (!folder || !root || !isUnder(folder, root)) return null;
    if (archive && isUnder(folder, archive)) return null;

    const folderAf = this.host.app.vault.getAbstractFileByPath(folder);
    if (!folderAf || !(folderAf instanceof TFolder)) return null;

    // locate files (支持重命名)：优先按固定文件名，其次按 frontmatter.file_role
    const files = folderAf.children.filter((x) => x instanceof TFile) as TFile[];

    const pickByName = (names: string[]): TFile | undefined => files.find((f) => names.includes(f.name));
    const pickByRole = async (role: string): Promise<TFile | undefined> => {
      for (const f of files) {
        // 只对 md/excalidraw 这类文本文件尝试读取 frontmatter
        const ext = String(f.extension ?? "").toLowerCase();
        if (ext !== "md" && ext !== "excalidraw") continue;
        try {
          const fm = await readFrontmatter(this.host.app, f);
          const r = String((fm as any).file_role ?? (fm as any).fileRole ?? "").trim();
          if (r === role) return f;
        } catch {}
      }
      return undefined;
    };

    const infoFile = pickByName(["项目信息.md"]) ?? (await pickByRole("project_info"));
    const taskFile =
      pickByName(["项目任务清单.md", "项目清单.md"]) ?? (await pickByRole("project_tasklist"));

    if (!infoFile || !taskFile) {
      // 缺文件就不纳入列表
      this._byFolder.delete(folder);
      return null;
    }

    // ⚠️ 重要：项目状态（done/cancelled 等）常由插件按钮写入 frontmatter。
    // Obsidian 的 metadataCache 在写入后可能短时间仍返回旧值，导致“点取消/完成后刷新仍不更新”。
    // 这里强制从文本读取，确保 UI 立即反映最新状态。
    const fm = await readFrontmatter(this.host.app, infoFile, { preferCache: false });
    const projectId = String(fm.project_id ?? fm.projectId ?? "").trim();
    const projectName = String(fm.project_name ?? fm.projectName ?? folderAf.name ?? "").trim() || folderAf.name;
    const status: ProjectStatus = normalizeProjectStatus(fm.status ?? "todo");
    // 6.6/6-B：优先新键，兼容 create/due/start
    const created_date = isYmd((fm as any).created_date ?? fm.create) ? String((fm as any).created_date ?? fm.create).trim() : undefined;
    const planned_start = isYmd((fm as any).planned_start) ? String((fm as any).planned_start).trim() : undefined;
    const planned_end = isYmd((fm as any).planned_end ?? fm.due) ? String((fm as any).planned_end ?? fm.due).trim() : undefined;
    const actual_start = isYmd((fm as any).actual_start ?? fm.start) ? String((fm as any).actual_start ?? fm.start).trim() : undefined;
    const original_planned_end = isYmd((fm as any).original_planned_end) ? String((fm as any).original_planned_end).trim() : undefined;
    const postpone_count = typeof (fm as any).postpone_count === "number" ? (fm as any).postpone_count : (/^\d+$/.test(String((fm as any).postpone_count ?? "").trim()) ? Number(String((fm as any).postpone_count).trim()) : undefined);
    const postpone_reason = typeof (fm as any).postpone_reason === "string" ? String((fm as any).postpone_reason).trim() || undefined : undefined;
    const doneRaw = (fm as any).done;
    const doneTimeRaw = (fm as any).done_time ?? (fm as any).completed_time ?? (fm as any).done_at ?? (fm as any).completed_at;
    const doneDateRaw = (fm as any).done_date ?? (fm as any).doneDate ?? (fm as any).done_date_str;
    const done =
      isYmd(doneRaw) ? String(doneRaw).trim()
        : (typeof doneTimeRaw === "string" && doneTimeRaw ? String(doneTimeRaw).slice(0, 10) : undefined)
          ?? (isYmd(doneDateRaw) ? String(doneDateRaw).trim() : undefined);

    const cancelledRaw = (fm as any).cancelled;
    const cancelledTimeRaw = (fm as any).cancelled_time ?? (fm as any).cancel_time ?? (fm as any).deleted_time ?? (fm as any).delete_time;
    const cancelledDateRaw = (fm as any).cancelled_date ?? (fm as any).cancelledDate ?? (fm as any).cancelled_date_str;
    const cancelled =
      isYmd(cancelledRaw) ? String(cancelledRaw).trim()
        : (typeof cancelledTimeRaw === "string" && cancelledTimeRaw ? String(cancelledTimeRaw).slice(0, 10) : undefined)
          ?? (isYmd(cancelledDateRaw) ? String(cancelledDateRaw).trim() : undefined);

    const paRaw = (fm as any).pending_archive_at ?? (fm as any).pendingArchiveAt;
    const pending_archive_at =
      isYmd(paRaw) ? String(paRaw).trim() : undefined;

    const progress_updatedRaw = (fm as any).progress_updated ?? (fm as any).progressUpdated;
    const progress_updated =
      typeof progress_updatedRaw === "string" && progress_updatedRaw.trim()
        ? String(progress_updatedRaw).trim().slice(0, 10)
        : undefined;

    const taskText = await safeRead(this.host.app, taskFile);
    const milestones = parseMilestonesAndCounts(taskText);
    const taskItems = parseTaskItems(taskText);

    // analysis file: 优先按 file_role，其次匹配 *包含* “项目分析图” 的文件（兼容旧项目改名后文件名未同步）
    const analysis =
      (await pickByRole("project_analysis")) ??
      (() => {
        const candidates = folderAf.children.filter((x) => x instanceof TFile) as TFile[];

        const isMatch = (base: string): boolean => {
          const b = String(base ?? "").trim();
          if (!b) return false;
          return b === "项目分析图" || b.endsWith("-项目分析图") || b.includes("项目分析图");
        };

        const score = (base: string): number => {
          const b = String(base ?? "").trim();
          if (b === `${projectName}-项目分析图`) return 100;
          if (b === `${folderAf.name}-项目分析图`) return 95;
          if (b === "项目分析图") return 90;
          if (b.endsWith("-项目分析图")) return 80;
          if (b.includes("项目分析图")) return 70;
          return 0;
        };

        const matched = candidates
          .filter((f) => isMatch(f.basename))
          .sort((a, b) => score(b.basename) - score(a.basename));

        return matched[0];
      })();

    // mtimeKey: 只要任何一个文件修改即可变化（用于将来更细的增量策略）
    const mtimeKey = `${(infoFile.stat?.mtime ?? 0)}|${(taskFile.stat?.mtime ?? 0)}|${(analysis?.stat?.mtime ?? 0)}`;

    // 如果没变且已有缓存，则直接返回缓存（避免频繁 parse）
    const prev = this._byFolder.get(folder);
    if (prev && prev.mtimeKey === mtimeKey) return prev;

    const entry: ProjectEntry = {
      folderPath: folder,
      projectId: projectId || prev?.projectId || "",
      projectName,
      status,
      created_date: created_date || undefined,
      planned_start: planned_start || undefined,
      planned_end: planned_end || undefined,
      actual_start: actual_start || undefined,
      done,
      cancelled,
      pending_archive_at,
      original_planned_end: original_planned_end || undefined,
      postpone_count,
      postpone_reason,
      progress_updated: progress_updated || undefined,
      infoFilePath: infoFile.path,
      tasklistFilePath: taskFile.path,
      analysisFilePath: analysis?.path,
      milestones,
      taskItems,
      refreshedAt: Date.now(),
      mtimeKey,
    };

    // attach DB sync meta (best-effort)
    const meta = this._syncMetaById.get(entry.projectId);
    if (meta) {
      (entry as any).dbSyncStatus = meta.status;
      (entry as any).dbSyncedAt = meta.syncedAt;
      (entry as any).dbLastError = meta.lastError;
      (entry as any).dbPendingOps = meta.pendingOps;
    }

    this._byFolder.set(folder, entry);
    return entry;
  }
}
