import { Notice, TFile, TFolder, normalizePath, moment } from "obsidian";
import type { App, TAbstractFile } from "obsidian";
import type { RSLattePluginSettings } from "../types/settings";
import type { RSLatteApiClient } from "../api";
import { genFileId, genProjectId } from "../utils/id";
import { patchYamlFrontmatterText, readFrontmatter } from "../utils/frontmatter";
import { parseMilestoneNodes, parseMilestonesAndCounts, hasMilestoneHeading, parseTaskItems, DEFAULT_MILESTONE_PATH } from "./parser";
import type { ProjectEntry, ProjectSnapshot, ProjectStatus } from "./types";
import { ProjectIndexStore } from "../projectRSLatte/indexStore";
import { ProjectSyncQueue } from "../projectRSLatte/syncQueue";
import { archiveProjectIndexByMonths } from "../projectRSLatte/archiver";
import type { ProjectRSLatteIndexItem } from "../projectRSLatte/types";
import { toIsoNow, todayYmd as todayYmd2, monthKeyFromYmd, isYmd as isYmd2 } from "../taskRSLatte/utils";
import type { WorkEventService } from "../services/workEventService";
import { resolveSpaceIndexDir, resolveSpaceQueueDir } from "../services/spaceContext";

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
};

const MIN_REFRESH_INTERVAL_MS = 20_000; // 防抖/节流底线
const MAX_DIRTY_PER_TICK = 8;

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

function escapeRegExp(s: string): string {
  return String(s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeProjectStatus(input: any): ProjectStatus {
  const raw = String(input ?? "").trim();
  const t = raw.toLowerCase();
  if (!t) return "todo";
  if (t === "todo") return "todo";
  if (t === "done") return "done";
  if (t === "cancelled") return "cancelled";
  if (t === "in-progress" || t === "inprogress" || t === "in_progress") return "in-progress";
  // keep unknown values as-is (string union allows it)
  return raw as any;
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
  private _refreshInFlight = false;
  private _refreshOwner: "auto" | "manual" | "other" | null = null;
  private _pendingFull = false;
  private _pendingFullTimer: number | null = null;
  private _lastRefreshStartedAt = 0;

  constructor(private host: Host) {}

  private dbg(...args: any[]) {
    if (!(this.host.settingsRef() as any)?.debugLogEnabled) return;
    console.log("[rslatte][projectMgr]", ...args);
  }

  private dbgw(...args: any[]) {
    if (!(this.host.settingsRef() as any)?.debugLogEnabled) return;
    console.warn("[rslatte][projectMgr]", ...args);
  }

  /**
   * Best-effort: bump/update the project task meta line's ts=... field.
   * - Prefer the immediate next-line meta bound to the task_id.
   * - Otherwise, update the first meta line in the file that contains the same task_id.
   * - If not found, insert a new meta line immediately under the task line.
   */
  private bumpProjectTaskMetaTsInLines(lines: string[], taskIdx: number, taskId?: string): boolean {
    const tid = String(taskId ?? "").trim();
    if (!tid) return false;

    const isRSLatteMeta = (l: string) => /^\s*<!--\s*rslatte:/i.test(String(l ?? ""));
    const hasTid = (l: string) => String(l ?? "").includes(`task_id=${tid}`);
    const now = toIsoNow();

    const patchLine = (line: string): string => {
      if (!/ts\s*=\s*/i.test(line)) {
        // append before '-->'
        return line.replace(/-->\s*$/, `;ts=${now} -->`);
      }
      return line.replace(/ts\s*=\s*[^;>\s]+/i, `ts=${now}`);
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
    lines.splice(taskIdx + 1, 0, `${indent}  <!-- rslatte:task_id=${tid};type=project_task;ts=${now} -->`);
    return true;
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

  /**
   * ✅ Step4：供自动定时器调用的增量刷新 + 可选 DB 同步（静默，不弹 Notice）。
   * - 仅做增量刷新（refreshDirty）
   * - 若 enableDbSync=true，则 enqueue + flush
   */
  public async autoRefreshIncrementalAndSync(): Promise<void> {
    try {
      await this.refreshDirty({ reason: "auto_timer" });
    } catch (e) {
      console.warn("ProjectManager auto refreshDirty failed", e);
    }

    if (!this.isDbSyncEnabled()) return;

    try {
      // Auto mode must respect queue backoff; otherwise a transient failure will
      // cause tight loops (repeated /replace /upsert requests every tick).
      // - enqueue: do not forceDue (only update payload when needed)
      // - flush: do NOT force (pickDue will respect next_retry_at)
      await this.persistIndexAndEnqueueSync({ forceEnqueue: false, forceDue: false });
      await this.flushSyncQueue({ force: false });
    } catch (e) {
      console.warn("ProjectManager auto sync failed", e);
    }
  }

  public async ensureReady(): Promise<void> {
    await this.ensureProjectRSLatteReady();
    // 启动时：如果索引存在且有数据，标记所有项目为 dirty 并增量刷新（不扫描文件系统，只刷新有变化的）
    // 如果索引不存在或为空，才进行全量扫描
    const hasIndexData = await this.checkIndexHasData();
    if (!hasIndexData) {
      // 索引不存在或为空，需要全量扫描重建索引
      await this.refreshAll({ reason: "startup" });
    } else {
      // 索引存在，标记所有索引中的项目为 dirty，然后增量刷新
      // 这样会正确解析文件并构建完整的树形结构，而不是从索引构建不完整的数据
      await this.markIndexProjectsDirtyAndRefresh();
    }
    this.registerVaultListeners();
  }

  /** 检查索引是否存在且有数据 */
  private async checkIndexHasData(): Promise<boolean> {
    try {
      if (!this._idxStore) return false;
      const idx = await this._idxStore.readIndex();
      return (idx.items ?? []).length > 0;
    } catch (e) {
      return false;
    }
  }

  /** 从索引读取项目路径，标记为 dirty，然后触发增量刷新 */
  private async markIndexProjectsDirtyAndRefresh(): Promise<void> {
    try {
      if (!this._idxStore) return;
      const idx = await this._idxStore.readIndex();
      const items = idx.items ?? [];
      
      // 从索引读取项目路径，标记为 dirty
      const settings = this.host.settingsRef();
      const root = norm(settings.projectRootDir);
      const archive = norm(settings.projectArchiveDir);
      
      for (const it of items) {
        const folderPath = String((it as any).folder_path ?? "").trim();
        if (!folderPath) continue;
        if (!root || !isUnder(folderPath, root)) continue;
        if (archive && isUnder(folderPath, archive)) continue;
        
        // 检查文件夹是否仍然存在
        const folderAf = this.host.app.vault.getAbstractFileByPath(folderPath);
        if (folderAf && folderAf instanceof TFolder) {
          this._dirtyFolders.add(folderPath);
        }
      }
      
      // 触发增量刷新，这会正确解析文件并构建完整的树形结构
      await this.refreshDirty({ reason: "startup_incremental" });
    } catch (e) {
      console.warn("[projectMgr] markIndexProjectsDirtyAndRefresh failed:", e);
    }
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
    const n = Math.max(1, Math.floor(Number(v ?? 90)));
    return Number.isFinite(n) ? n : 90;
  }

  private async ensureProjectRSLatteReady(): Promise<void> {
    const dir = this.getRSLatteIndexDir();
    if (this._idxStore && this._idxStore.getBaseDir() === dir && this._syncQueue) return;
    const s: any = this.host.settingsRef() as any;
    const queueDir = normalizePath(`${resolveSpaceQueueDir(s, undefined, [s.projectRSLatteIndexDir])}/project`);
    const store = new ProjectIndexStore(this.host.app, dir, queueDir);
    await store.ensureLayout();
    const q = new ProjectSyncQueue(store);
    await q.compact();
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
  }

  /**
   * v25：项目自动归档（每日一次）
   * - 归档项目文件夹：status=done/cancelled 且完成/取消日期早于阈值天数
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
   */
  public async createProject(projectName: string, dueYmd?: string): Promise<ProjectEntry> {
    const name = (projectName ?? "").trim();
    if (!name) throw new Error("项目名称为必填");

    if (dueYmd && !isYmd(dueYmd)) throw new Error("截至时间格式必须为 YYYY-MM-DD");

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

    // 分析图命名规范："[项目名称]-项目分析图.md"（按用户要求固定为 .md）
    const analysisFilePath = norm(`${folderPath}/${name}-项目分析图.md`);

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

    // 写 frontmatter
    await this.host.app.fileManager.processFrontMatter(taskFile, (fm) => {
      fm.file_id = fm.file_id ?? taskFileId;
      fm.file_role = fm.file_role ?? "project_tasklist";
      fm.project_id = pid;
      fm.project_name = name;
      if (dueYmd) fm.due = dueYmd;
    });

    await this.host.app.fileManager.processFrontMatter(infoFile, (fm) => {
      fm.file_id = fm.file_id ?? infoFileId;
      fm.file_role = fm.file_role ?? "project_info";
      fm.project_id = pid;
      fm.project_name = name;
      fm.status = "todo";
      fm.create = todayYmd();
      if (dueYmd) fm.due = dueYmd;
    });

    // ⚠️ Excalidraw 模板文件的正文包含 compressed-json；这里不要用 processFrontMatter，
    // 直接做“文本级 frontmatter 补齐”，避免重写正文导致 Excalidraw 解析失败。
    await patchYamlFrontmatterText(this.host.app, analysisFile, {
      file_id: analysisFileId,
      file_role: "project_analysis",
      project_id: pid,
      project_name: name,
    });

    // 更新索引
    await this.refreshOneFolder(folderPath, { reason: "create" });
    this.host.refreshSidePanel();

    // ✅ Work Event (success only)
    void this.host.workEventSvc?.append({
      ts: new Date().toISOString(),
      kind: "project",
      action: "create",
      source: "ui",
      ref: {
        project_id: pid,
        project_name: name,
        folder_path: folderPath,
        due: dueYmd || undefined,
        files: {
          tasklist: tasklistFilePath,
          info: infoFilePath,
          analysis: analysisFilePath,
        },
      },
      summary: `📁 新建项目 ${name}`,
      metrics: { due: dueYmd || undefined, file_count: 3 },
    });

    const created = this._byFolder.get(folderPath);
    if (!created) throw new Error("项目创建后索引未刷新");
    return created;
  }

  /**
   * 修改项目名称/截至时间：
   * - project_id 不变
   * - 若项目目录为以项目名命名的文件夹，则同步重命名文件夹
   * - 同步更新各文件 frontmatter 中的 project_name/due
   * - 同步重命名分析图为 “[项目名]-项目分析图”
   */
  public async updateProjectInfo(projectFolderPath: string, opts: { projectName: string; dueYmd?: string }): Promise<void> {
    const folder = norm(projectFolderPath);
    const oldEntry = this._byFolder.get(folder);
    const oldNameHint = String((oldEntry as any)?.projectName ?? (oldEntry as any)?.project_name ?? "").trim();
    const newName = (opts.projectName ?? "").trim();
    const dueYmd = (opts.dueYmd ?? "").trim() || undefined;
    if (!folder) throw new Error("项目路径为空");
    if (!newName) throw new Error("项目名称为必填");
    if (dueYmd && !isYmd(dueYmd)) throw new Error("截至时间格式必须为 YYYY-MM-DD");

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

    // 3) update frontmatter
    await this.host.app.fileManager.processFrontMatter(infoFile, (fm) => {
      fm.file_id = fm.file_id ?? genFileId();
      fm.file_role = fm.file_role ?? "project_info";
      fm.project_name = newName;
      if (dueYmd) fm.due = dueYmd;
      else delete (fm as any).due;
    });
    await this.host.app.fileManager.processFrontMatter(taskFile, (fm) => {
      fm.file_id = fm.file_id ?? genFileId();
      fm.file_role = fm.file_role ?? "project_tasklist";
      fm.project_name = newName;
      if (dueYmd) fm.due = dueYmd;
      else delete (fm as any).due;
    });
    if (analysisFile) {
      // Excalidraw：只做文本级 frontmatter 更新，避免重写正文
      const afm = await readFrontmatter(this.host.app, analysisFile);
      const upd: Record<string, any> = {
        project_name: newName,
        file_role: String(afm.file_role ?? "").trim() || "project_analysis",
      };
      if (!String(afm.file_id ?? "").trim()) upd.file_id = genFileId();
      await patchYamlFrontmatterText(this.host.app, analysisFile, upd);
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
      ts: new Date().toISOString(),
      kind: "project",
      action: "update",
      source: "ui",
      ref: {
        project_id: (oldEntry as any)?.projectId ?? (oldEntry as any)?.project_id ?? undefined,
        old_project_name: oldNameHint || undefined,
        project_name: newName,
        old_folder_path: oldFolderPath,
        folder_path: curFolderPath,
        due: dueYmd || undefined,
      },
      summary: oldNameHint && oldNameHint !== newName ? `✏️ 项目重命名 ${oldNameHint} → ${newName}` : `✏️ 更新项目信息 ${newName}`,
      metrics: { due: dueYmd || undefined },
    });
  }

  public async addMilestone(
    projectFolderPath: string,
    milestoneName: string,
    opts?: { level?: 1 | 2 | 3; parentPath?: string }
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
    // ✅ 写入创建时间的 rslatte 注释
    block.push(`<!-- rslatte:milestone_status=active;ts=${toIsoNow()} -->`);
    block.push("");

    lines.splice(insertAt, 0, ...block);
    await this.host.app.vault.modify(taskFile, lines.join("\n"));

    // 更新项目信息：start 为空则设为今天；status => in-progress
    const infoPath = p?.infoFilePath || norm(`${folder}/项目信息.md`);
    const infoAf = this.host.app.vault.getAbstractFileByPath(infoPath);
    if (infoAf && infoAf instanceof TFile) {
      await this.host.app.fileManager.processFrontMatter(infoAf, (fm) => {
        const curStart = String(fm.start ?? "").trim();
        if (!curStart) fm.start = todayYmd();
        if (fm.status === "todo") {
          void this.host.workEventSvc?.append({
            ts: new Date().toISOString(),
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

    void this.host.workEventSvc?.append({
      ts: new Date().toISOString(),
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
  public async listMilestonesMeta(projectFolderPath: string): Promise<Array<{ path: string; name: string; level: 1 | 2 | 3; parentPath?: string; milestoneStatus?: "active" | "done" | "cancelled" }>> {
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
    return parseMilestoneNodes(md).map((n) => ({
      path: String((n as any).path ?? "").trim(),
      name: String((n as any).name ?? "").trim(),
      level: (Number((n as any).level ?? 1) || 1) as 1 | 2 | 3,
      parentPath: String((n as any).parentPath ?? "").trim() || undefined,
      milestoneStatus: (n as any).milestoneStatus,
    })).filter((x) => Boolean(x.path));
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
      const meta = `<!-- rslatte:milestone_status=${status};ts=${toIsoNow()} -->`;

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

    // ✅ 根据状态拆分为具体的 action
    const action = status === "done" ? "done" : status === "cancelled" ? "cancelled" : "recover";
    const icon = status === "done" ? "✅" : status === "cancelled" ? "⛔" : "⏸";
    const summaryText = status === "done" ? "里程碑完成" : status === "cancelled" ? "里程碑取消" : "里程碑恢复";
    
    void this.host.workEventSvc?.append({
      ts: new Date().toISOString(),
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

  /** Update milestone (rename / change level / change parent). */
  public async updateMilestone(
    projectFolderPath: string,
    fromMilestonePath: string,
    opts: { name?: string; level?: 1 | 2 | 3; parentPath?: string }
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

      this._dirtyFolders.add(folder);
      await this.refreshDirty({ reason: "rename_milestone" });
      this.host.refreshSidePanel();

      void this.host.workEventSvc?.append({
        ts: new Date().toISOString(),
        kind: "milestone",
        action: "update",
        source: "ui",
        ref: {
          project_id: (p as any)?.projectId ?? (p as any)?.project_id ?? undefined,
          project_name: (p as any)?.projectName ?? (p as any)?.project_name ?? undefined,
          folder_path: folder,
          from_milestone_path: fromPath,
          milestone_path: (newLevel === 1 ? newLeaf : `${newParentPath} / ${newLeaf}`).trim(),
          level: newLevel,
          parent_milestone: newParentPath || undefined,
        },
        summary: `✏️ 更新里程碑 ${fromPath} → ${(newLevel === 1 ? newLeaf : `${newParentPath} / ${newLeaf}`).trim()}`,
      });
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

    this._dirtyFolders.add(folder);
    await this.refreshDirty({ reason: "update_milestone" });
    this.host.refreshSidePanel();

    void this.host.workEventSvc?.append({
      ts: new Date().toISOString(),
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
      const nowIso = new Date().toISOString();
      const d = todayYmd();
      (fm as any).done = d;
      (fm as any).done_time = nowIso;

      // clean legacy keys
      delete (fm as any).done_date;
      delete (fm as any).doneDate;
      delete (fm as any).completed_time;
      delete (fm as any).completed_date;
      delete (fm as any).completed;

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
      ts: new Date().toISOString(),
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
      const nowIso = new Date().toISOString();
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
      ts: new Date().toISOString(),
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
    await this.host.app.fileManager.processFrontMatter(af, (fm) => {
      fm.status = "in-progress";
      
      // 清除 cancelled 相关字段
      delete (fm as any).cancelled;
      delete (fm as any).cancelled_time;
      delete (fm as any).cancelled_date;
      delete (fm as any).cancel_time;
      delete (fm as any).cancel_date;
      delete (fm as any).deleted_time;
      delete (fm as any).deleted_date;
      delete (fm as any).delete_time;
      delete (fm as any).delete_date;
    });
    this._dirtyFolders.add(folder);
    await this.refreshDirty({ reason: "recover" });
    this.host.refreshSidePanel();

    void this.host.workEventSvc?.append({
      ts: new Date().toISOString(),
      kind: "project",
      action: "recover",
      source: "ui",
      ref: {
        project_id: (p as any)?.projectId ?? (p as any)?.project_id ?? undefined,
        project_name: (p as any)?.projectName ?? (p as any)?.project_name ?? undefined,
        folder_path: folder,
        status: "in-progress",
      },
      summary: `🔄 项目恢复 ${(p as any)?.projectName ?? ""}`.trim() || "🔄 项目恢复",
    });
  }

  /**
   * 在指定里程碑下新增任务（插入到该里程碑最后一条任务后，即下一个里程碑标题之前）
   * 任务格式与 AddTaskModal 保持一致（Tasks 元数据字段：📅/🛫/⏳/➕）
   */
  public async addTaskToMilestone(
    projectFolderPath: string,
    milestoneName: string,
    text: string,
    dueDate: string,
    startDate?: string,
    scheduledDate?: string
  ): Promise<void> {
    const folder = norm(projectFolderPath);
    // milestoneName is now treated as a milestone PATH (L1 / L2 / L3).
    // (kept parameter name for compatibility)
    const name = String(milestoneName ?? "").trim();
    const t = String(text ?? "").trim();
    if (!name) throw new Error("里程碑名称为空");
    if (!t) throw new Error("任务描述为空");

    const due = String(dueDate ?? "").trim();
    const start = String(startDate ?? "").trim();
    const scheduled = String(scheduledDate ?? "").trim();

    if (!isYmd(due)) throw new Error("到期日期（due）为必填，且格式必须为 YYYY-MM-DD");
    if (start && !isYmd(start)) throw new Error("开始日期（start）格式必须为 YYYY-MM-DD");
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

    // ✅ keep the visible task line clean (single-line), and put rslatte meta on the *next line*
    // to match Task Manager's writing style (prevents breaking visual text & keeps parsing safe).
    const taskLine = `- [ ] ${t} ➕ ${today}${start ? ` 🛫 ${start}` : ""}${scheduled ? ` ⏳ ${scheduled}` : ""} 📅 ${due}`;
    const metaLine = `  <!-- rslatte:task_id=${taskId};type=project_task;ts=${toIsoNow()} -->`;

    // 如果插入点前一行不是空行且不是任务行，也允许直接插入（保持简单）
    lines.splice(insertAt, 0, taskLine, metaLine);

    await this.host.app.vault.modify(taskFile, lines.join("\n"));

    // 更新项目信息：start 为空则设为今天；status => in-progress
    const infoPath = p?.infoFilePath || norm(`${folder}/项目信息.md`);
    const infoAf = this.host.app.vault.getAbstractFileByPath(infoPath);
    if (infoAf && infoAf instanceof TFile) {
      await this.host.app.fileManager.processFrontMatter(infoAf, (fm) => {
        const curStart = String(fm.start ?? "").trim();
        if (!curStart) fm.start = today;
        // 避免往 done/cancelled 的项目里写回 todo 状态
        const curSt = normalizeProjectStatus(fm.status);
        if (curSt !== "done" && curSt !== "cancelled") fm.status = "in-progress";
      });
    }

    this._dirtyFolders.add(folder);
    await this.refreshDirty({ reason: "add_task" });
    this.host.refreshSidePanel();

    void this.host.workEventSvc?.append({
      ts: new Date().toISOString(),
      kind: "projecttask",
      action: "create",
      source: "ui",
      ref: {
        task_id: taskId,
        text: t,
        due,
        start: start || undefined,
        scheduled: scheduled || undefined,
        project_id: (p as any)?.projectId ?? (p as any)?.project_id ?? undefined,
        project_name: (p as any)?.projectName ?? (p as any)?.project_name ?? undefined,
        folder_path: folder,
        milestone: node.path,
      },
      summary: `🧩 新增项目任务 ${t}`,
      metrics: { due, start: start || undefined, scheduled: scheduled || undefined },
    });
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

    this._dirtyFolders.add(folder);
    await this.refreshDirty({ reason: "move_project_task_milestone" });
    this.host.refreshSidePanel();

    // emit work event (best-effort)
    try {
      const tid = String(taskRef.taskId ?? "").trim();
      const prevItem = (p?.taskItems ?? []).find((x) => (tid && x.taskId === tid) || x.lineNo === taskRef.lineNo);
      const text = (prevItem?.text ?? "").trim() || "(项目任务)";
      void this.host.workEventSvc?.append({
        ts: new Date().toISOString(),
        kind: "projecttask",
        action: "update",
        source: "ui",
        ref: {
          task_id: tid || undefined,
          text,
          project_id: p?.projectId || undefined,
          project_name: p?.projectName || undefined,
          folder_path: folder,
          from_milestone: fromPath || undefined,
          to_milestone: toPath,
          file_path: taskFile.path,
        },
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
    next: "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED"
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
    if (this.bumpProjectTaskMetaTsInLines(lines, idx, taskRef.taskId)) {
      changed = true;
    }

    if (changed) {
      await this.host.app.vault.modify(taskFile, lines.join("\n"));
    }

    // refresh index and enqueue db sync if enabled
    this._dirtyFolders.add(folder);
    await this.refreshDirty({ reason: "set_project_task_status" });
    this.host.refreshSidePanel();

    // emit work event (best-effort)
    try {
      const tid = String(taskRef.taskId ?? "").trim();
      const prevItem = (p?.taskItems ?? []).find((x) => (tid && x.taskId === tid) || x.lineNo === taskRef.lineNo);
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
        
        // 检查任务是否曾经开始过（通过检查是否有 🛫 标记或 startDate）
        // 🛫 标记会在任务首次开始或恢复时添加
        const hasStartDate = /🛫\s*\d{4}-\d{2}-\d{2}/.test(oldLine) || (prevItem?.startDate != null);
        
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
        ts: new Date().toISOString(),
        kind: "projecttask",
        action: action as any,
        source: "ui",
        ref: {
          task_id: tid || undefined,
          to: next,
          text,
          project_id: p?.projectId || undefined,
          project_name: p?.projectName || undefined,
          folder_path: folder,
          milestone,
          file_path: taskFile.path,
          line_no: idx,
        },
        summary: `${icon} 项目任务 ${text}`,
      });
    } catch {
      // ignore
    }
  }

  /**
   * Update a project task's basic info (text + due/start/scheduled) by editing the task line.
   * Keep the line single-line and preserve existing HTML comments (e.g. <!-- rslatte:task_id=... -->).
   */
  public async updateProjectTaskBasicInfo(
    projectFolderPath: string,
    taskRef: { taskId?: string; lineNo?: number },
    patch: { text: string; due: string; start?: string; scheduled?: string }
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

    const oldLine = lines[idx];

    const prefixMatch = oldLine.match(/^(\s*-\s*\[[ x\/-]\]\s*)/);
    const prefix = prefixMatch ? prefixMatch[1] : "";
    const body0 = prefix ? oldLine.slice(prefix.length) : oldLine;

    // Extract and preserve HTML comments
    const comments = (body0.match(/<!--[^]*?-->/g) ?? []).map((x) => x.trim()).filter(Boolean);
    let body = body0.replace(/<!--[^]*?-->/g, " ");

    // Remove old due/start/scheduled tokens
    body = body
      .replace(/\s*📅\s*\d{4}-\d{2}-\d{2}/g, " ")
      .replace(/\s*🛫\s*\d{4}-\d{2}-\d{2}/g, " ")
      .replace(/\s*⏳\s*\d{4}-\d{2}-\d{2}/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();

    // Keep remaining tokens (created/done/cancelled/etc.) after replacing the description
    const rest = body.replace(/^.*?(?=(\s*[➕✅❌🔁🆔]|\s*$))/, "").trim();

    const tokens: string[] = [];
    if (start) tokens.push(`🛫 ${start}`);
    if (scheduled) tokens.push(`⏳ ${scheduled}`);
    tokens.push(`📅 ${due}`);

    let nextLine = `${prefix}${text}`;
    if (tokens.length) nextLine += ` ${tokens.join(" ")}`;
    if (rest) nextLine += ` ${rest}`;
    if (comments.length) nextLine += ` ${comments.join(" ")}`;
    nextLine = oneLine(nextLine);

    let changed = false;
    if (nextLine !== oldLine) {
      lines[idx] = nextLine;
      changed = true;
    }

    // ✅ update operation timestamp in task meta
    if (this.bumpProjectTaskMetaTsInLines(lines, idx, taskRef.taskId)) {
      changed = true;
    }

    if (changed) {
      await this.host.app.vault.modify(taskFile, lines.join("\n"));
    }

    this._dirtyFolders.add(folder);
    await this.refreshDirty({ reason: "update_project_task_basic" });
    this.host.refreshSidePanel();

    try {
      const tid = String(taskRef.taskId ?? "").trim();
      const prevItem = (p?.taskItems ?? []).find((x) => (tid && x.taskId === tid) || x.lineNo === taskRef.lineNo);
      const milestone = String((prevItem as any)?.milestonePath ?? prevItem?.milestone ?? "").trim() || undefined;
      void this.host.workEventSvc?.append({
        ts: new Date().toISOString(),
        kind: "projecttask",
        action: "update",
        source: "ui",
        ref: {
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
        },
        summary: `✏️ 修改项目任务 ${text}`,
        metrics: { due, start: start || undefined, scheduled: scheduled || undefined },
      });
    } catch {
      // ignore
    }
  }

  /**
   * 归档：把 status=done/cancelled 且（完成/取消日期 <= 今天-阈值天数）的项目文件夹移动到 projectArchiveDir
   * - 阈值天数：settings.projectArchiveThresholdDays（默认 90）
   */
  public async archiveDoneAndCancelledNow(opts?: { quiet?: boolean }): Promise<number> {
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

    const thresholdDays = Math.max(1, Math.floor(Number((settings as any).projectArchiveThresholdDays ?? 90)));
    const cutoff = (moment as any)().subtract(thresholdDays, "days").format("YYYY-MM-DD");

    const pickDate = (p: any): string | "" => {
      const st = String(p.status ?? "").trim();
      const raw = st === "cancelled" ? (p.cancelled ?? "") : (p.done ?? "");
      const m = String(raw || "").trim().match(/^(\d{4}-\d{2}-\d{2})/);
      return m ? m[1] : "";
    };

    let moved = 0;
    for (const p of this._snapshot.projects) {
      const st = String(p.status ?? "").trim();
      if (st !== "done" && st !== "cancelled") continue;

      const d = pickDate(p);
      if (!d) continue; // 没有完成/取消日期时，不自动归档，避免误移动
      if (d > cutoff) continue;

      const folderAf = this.host.app.vault.getAbstractFileByPath(p.folderPath);
      if (!folderAf || !(folderAf instanceof TFolder)) continue;

      let target = norm(`${archiveDir}/${p.projectName}`);
      const exists = this.host.app.vault.getAbstractFileByPath(target);
      if (exists) target = norm(`${archiveDir}/${p.projectName}-${p.projectId}`);

      try {
        await this.host.app.vault.rename(folderAf, target);
        moved++;
      } catch (e: any) {
        console.warn("archive project move failed", p.folderPath, e);
      }
    }

    // 归档后：项目被移动了，需要刷新以检测移动后的位置
    // 但文件系统事件应该已经标记了相关文件夹为 dirty，所以使用增量刷新即可
    // 如果移动操作没有触发文件系统事件，可以手动标记为 dirty
    for (let i = 0; i < moved; i++) {
      // 移动操作会触发文件系统事件，自动标记为 dirty
      // 这里只需要触发增量刷新即可
    }
    await this.refreshDirty({ reason: "archive_post" });
    
    // ✅ 归档后，将已归档项目的索引信息归档到索引的归档目录中
    if (moved > 0) {
      try {
        await this.archiveIndexNow({ quiet: true });
      } catch (e) {
        console.warn("项目索引归档失败", e);
      }
    }
    
    this.host.refreshSidePanel();
    return moved;
  }

  /**
   * 全量刷新（扫描项目目录）
   * - forceSync=true：手动触发时使用，刷新完成后立即落盘索引并尽快 flush 同步队列
   */
  public async refreshAll(opts?: { reason?: string; forceSync?: boolean }): Promise<void> {
    // 并发保护：同一时间只跑一个 refresh；其余请求合并
    if (this._refreshInFlight) {
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

    try {
      const settings = this.host.settingsRef();
      const root = norm(settings.projectRootDir);
      const archive = norm(settings.projectArchiveDir);
      if (!root) {
        this.commitSnapshot([]);
        return;
      }
      const rootAf = this.host.app.vault.getAbstractFileByPath(root);
      if (!rootAf || !(rootAf instanceof TFolder)) {
        this.commitSnapshot([]);
        return;
      }

      const folders = (rootAf.children ?? []).filter((x) => x instanceof TFolder) as TFolder[];
      const scanned = new Set<string>();
      const out: ProjectEntry[] = [];
      for (const f of folders) {
        if (archive && (f.path === archive || isUnder(f.path, archive))) continue;
        scanned.add(norm(f.path));
        const one = await this.refreshOneFolder(f.path, { reason: opts?.reason || "full" });
        if (one) out.push(one);
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
        await this.persistIndexAndEnqueueSync();
        await this.flushSyncQueue({ force: true });
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
    if (this._refreshInFlight) return;

    // 即使没有 dirty，也要做一次孤儿清理，避免“项目被归档/删除后索引仍残留”
    const removed = this.pruneOrphanFolders();

    const dirty = Array.from(this._dirtyFolders);
    if (!dirty.length) {
      if (removed > 0) {
        this.commitSnapshot(Array.from(this._byFolder.values()), { keepOtherFolders: false });
      }
      return;
    }

    // 节流：一次最多处理 N 个，剩余留到下一轮 interval
    const batch = dirty.slice(0, MAX_DIRTY_PER_TICK);
    batch.forEach((x) => this._dirtyFolders.delete(x));

    this._refreshInFlight = true;
    this._refreshOwner = (() => {
      const r = String(opts?.reason ?? "").toLowerCase();
      if (r.startsWith("auto") || r.includes("auto")) return "auto";
      if (r.includes("manual")) return "manual";
      return "other";
    })();
    try {
      for (const folder of batch) {
        await this.refreshOneFolder(folder, { reason: opts?.reason || "dirty" });
      }
      this.commitSnapshot(Array.from(this._byFolder.values()), { keepOtherFolders: false });
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
    if (opts?.keepOtherFolders) {
      const map = new Map<string, ProjectEntry>();
      for (const old of this._snapshot.projects) map.set(old.folderPath, old);
      for (const cur of projects) map.set(cur.folderPath, cur);
      this._snapshot = { projects: Array.from(map.values()), updatedAt: now };
    } else {
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
      create_date: isYmd2(p.create ?? "") ? p.create : undefined,
      due_date: isYmd2(p.due ?? "") ? p.due : undefined,
      start_date: isYmd2(p.start ?? "") ? p.start : undefined,
      done_date: isYmd2(p.done ?? "") ? p.done : undefined,
      cancelled_date: isYmd2(p.cancelled ?? "") ? p.cancelled : undefined,
      folder_path: p.folderPath,
      info_file_path: p.infoFilePath,
      tasklist_file_path: p.tasklistFilePath,
      analysis_file_path: p.analysisFilePath,
      milestones: (p.milestones ?? []).map((m) => ({
        name: m.name,
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
      updated_at: toIsoNow(),
    };
  }

  private async persistIndexAndEnqueueSync(opts?: { forceEnqueue?: boolean; forceDue?: boolean }): Promise<void> {
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
              .map((m) => `${pid}::MS::${String(m?.name ?? "").trim()}`)
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

          await q.enqueue(
            "upsert_project",
            pid,
            {
              project_id: pid,
              project_name: p.projectName,
              status: p.status,
              create_date: p.create,
              due_date: p.due,
              start_date: p.start,
              done_date: p.done,
              cancelled_date: p.cancelled,
              project_path: projectPath,
              folder_path: projectPath,
              info_file_path: p.infoFilePath,
              tasklist_file_path: p.tasklistFilePath,
              analysis_file_path: p.analysisFilePath,
            },
            { forceDue, snapshotKey }
          );

          // items/*：统一使用 items 数组（里程碑 + 任务）
          const milestoneId = (name: string) => `${pid}::MS::${String(name ?? "").trim()}`;
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
            const mid = milestoneId(m.name);
            itemsPayload.push({
              project_id: pid,
              item_id: mid,
              item_type: "milestone",
              milestone_id: mid,
              title: m.name,
              status: mapMilestoneStatus(m),
              position: idx,
              source_file_path: p.tasklistFilePath,
              source_anchor: m.name,
              created_date: m.createdDate,
              done_date: m.doneDate,
              cancelled_date: m.cancelledDate,
            });
          });
          (p.taskItems ?? []).forEach((it, idx) => {
            const mid = milestoneId(it.milestone);
            itemsPayload.push({
              project_id: pid,
              item_id: it.taskId || `${pid}::T::${it.lineNo}`,
              item_type: "task",
              milestone_id: mid,
              title: it.text,
              status: mapTaskStatus(it.statusName),
              position: it.lineNo ?? idx,
              source_file_path: p.tasklistFilePath,
              source_anchor: it.milestone,
              source_line: (it.lineNo ?? 0) + 1,
              raw_text: it.rawLine,
              created_date: it.createdDate,
              start_date: it.startDate,
              scheduled_date: it.scheduledDate,
              due_date: it.dueDate,
              done_date: it.doneDate,
              cancelled_date: it.cancelledDate,
            });
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
    const create = isYmd(fm.create) ? String(fm.create).trim() : undefined;
    const due = isYmd(fm.due) ? String(fm.due).trim() : undefined;
    const start = isYmd(fm.start) ? String(fm.start).trim() : undefined;
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
      create,
      due,
      start,
      done,
      cancelled,
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
