import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { RSLattePluginSettings } from "../types/settings";
import type { OutputIndexFile, OutputIndexItem, OutputPanelSettings, OutputTimelineTimeField } from "../types/outputTypes";
import { OutputIndexStore } from "./indexStore";
import { resolveSpaceIndexDir } from "../services/spaceContext";
import { monthKeyFromYmd } from "../taskRSLatte/utils";

// 未使用的函数，保留以备将来使用
// function clamp(n: number, min: number, max: number): number {
//   return Math.max(min, Math.min(max, n));
// }

function toDayKeyFromMs(ms?: number): string | null {
  if (!ms || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function normalizeTags(tags: any): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map(x => String(x).trim()).filter(Boolean);
  if (typeof tags === "string") {
    return tags
      .split(/[\s,，]+/)
      .map(x => x.replace(/^#/, "").trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeDomains(v: any): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
  if (typeof v === "string") {
    return v.split(/[,，]+/).map(x => x.trim()).filter(Boolean);
  }
  return [];
}

function toIsoDate(v: any): string | undefined {
  if (!v) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : undefined;
}

function toIsoDateTime(v: any): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "number" && Number.isFinite(v)) {
    try { return new Date(v).toISOString(); } catch { return undefined; }
  }
  const s = String(v).trim();
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

export class OutputRSLatteService {
  private store: OutputIndexStore | null = null;
  private snapshot: OutputIndexFile | null = null;
  private lastFullScanAt = 0;
  
  // ✅ 内存优化：快照访问时间戳（用于过期清理）
  private snapshotLastAccess = 0;
  
  // ✅ 快照过期时间：5分钟（300000毫秒）
  private readonly SNAPSHOT_EXPIRE_MS = 5 * 60 * 1000;

  constructor(
    private host: {
      app: App;
      settingsRef: () => RSLattePluginSettings;
      refreshSidePanel: () => void;
      workEventSvc?: any; // WorkEventService，可选
    }
  ) {}

  private get settings(): OutputPanelSettings {
    const s = this.host.settingsRef();
    const op = s.outputPanel;
    return op as any;
  }

  private getIndexBaseDir(): string {
    const s: any = this.host.settingsRef() as any;
    const op: any = s.outputPanel ?? {};
    // F2: bucket by space -> index lives under <centralRoot>/<spaceId>/index
    return resolveSpaceIndexDir(s, undefined, [op.rslatteIndexDir]);
  }

  public async ensureReady(): Promise<void> {
    if (this.store) return;
    this.store = new OutputIndexStore(this.host.app, this.getIndexBaseDir());
    await this.store.ensureLayout();
    // ✅ 内存优化：不再预加载快照，改为按需加载
  }

  /**
   * ✅ 内存优化：清理过期的快照
   */
  private cleanupExpiredSnapshots(): void {
    const now = Date.now();
    if (this.snapshot && now - this.snapshotLastAccess > this.SNAPSHOT_EXPIRE_MS) {
      this.snapshot = null;
    }
  }

  /**
   * ✅ 内存优化：手动清理所有快照（供内存紧张时调用）
   */
  public clearAllSnapshots(): void {
    this.snapshot = null;
    this.snapshotLastAccess = 0;
  }

  /** 当输出中央索引目录被修改时，重建 store */
  public async resetStore(): Promise<void> {
    // @ts-ignore - allow setting to null to force re-init
    this.store = null;
    this.clearAllSnapshots();
    this.lastFullScanAt = 0;
    await this.ensureReady();
  }

  public async getSnapshot(): Promise<OutputIndexFile> {
    await this.ensureReady();
    
    // ✅ 内存优化：清理过期快照
    this.cleanupExpiredSnapshots();
    
    if (!this.snapshot) {
      this.snapshot = await this.store!.readIndex();
    }
    this.snapshotLastAccess = Date.now();
    return this.snapshot;
  }

  /** DB 同步：读取上次同步快照 */
  public async readSyncState() {
    await this.ensureReady();
    return await this.store!.readSyncState();
  }

  /** DB 同步：写入本次同步快照 */
  public async writeSyncState(state: any) {
    await this.ensureReady();
    await this.store!.writeSyncState(state);
  }


  private normalizeRootList(list: any): string[] {
    return (list ?? [])
      .map((x: any) => normalizePath(String(x ?? "").trim()))
      .filter((x: string) => !!x);
  }

  private getTopLevelDir(filePath: string): string | null {
    const p = normalizePath(String(filePath ?? "")).replace(/^\/+/, "");
    const parts = p.split("/").filter(Boolean);
    if (parts.length >= 2) return parts[0];
    return null;
  }

  private computeCancelledArchiveDirForPath(filePath: string): string | null {
    const top = this.getTopLevelDir(filePath);
    if (!top) return null;
    return normalizePath(`${top}/_archived`);
  }

  private async discoverCancelledArchiveDirs(scanRoots: string[], existing: string[]): Promise<string[]> {
    const out = new Set<string>();

    // keep existing that still exist
    for (const d of existing) {
      const af = this.host.app.vault.getAbstractFileByPath(d);
      if (af instanceof TFolder) out.add(normalizePath(d));
    }

    // derive candidates from top-level segments of scan roots
    const tops = new Set<string>();
    for (const r of scanRoots) {
      const parts = normalizePath(r).replace(/^\/+/, "").split("/").filter(Boolean);
      if (parts.length) tops.add(parts[0]);
    }
    for (const top of tops) {
      const cand = normalizePath(`${top}/_archived`);
      const af = this.host.app.vault.getAbstractFileByPath(cand);
      if (af instanceof TFolder) out.add(cand);
    }

    return Array.from(out);
  }

  private isCancelledArchivedPath(path: string): boolean {
    const p = normalizePath(String(path ?? ""));
    return /(^|\/)\_archived(\/|$)/.test(p);
  }

  private isDoneArchivedPath(path: string, doneArchiveRoot: string): boolean {
    const root = normalizePath(String(doneArchiveRoot ?? "")).replace(/\/+$/g, "");
    if (!root) return false;
    const p = normalizePath(String(path ?? ""));
    return p === root || p.startsWith(root + "/");
  }
  public async refreshIndexNow(opts?: { mode?: "active" | "full" }): Promise<void> {
    await this.ensureReady();

    const op = this.settings;
    const mode = (opts?.mode ?? "full") as ("active" | "full");

    // ✅ 读取旧快照，用于检测文件修改时间变化
    const prevSnapshot = await this.getSnapshot();
    const prevItemsByPath = new Map<string, OutputIndexItem>();
    for (const item of (prevSnapshot?.items ?? [])) {
      prevItemsByPath.set(item.filePath, item);
    }

    // scanRoots: user-configured active roots for output docs
    const scanRoots = this.normalizeRootList(op?.archiveRoots ?? []);

    // If scanRoots are empty, do nothing (avoid scanning the entire vault by accident).
    // IMPORTANT: do NOT wipe existing snapshot/cancelledArchiveDirs cache, otherwise the UI may lose
    // knowledge about per-top-level _archived dirs and require an expensive full rescan.
    if (!scanRoots.length) {
      const prev = await this.getSnapshot();
      this.snapshot = {
        version: 2,
        updatedAt: new Date().toISOString(),
        items: (prev?.items ?? []) as OutputIndexItem[],
        cancelledArchiveDirs: (prev?.cancelledArchiveDirs ?? []) as string[],
      };
      await this.store!.writeIndex(this.snapshot);
      this.lastFullScanAt = Date.now();
      return;
    }

    // doneArchiveRoot: global archive root (DONE docs are archived under this root)
    const doneArchiveRoot = normalizePath(String((op as any)?.archiveRootDir ?? "99-Archive").trim() || "99-Archive");

    // cancelledArchiveDirs: per-top-level "_archived" dirs (CANCELLED docs)
    // - active mode: keep previous cache (no discovery)
    // - full mode: (re)discover based on scan roots + previous cache
    const prevDirs = (await this.getSnapshot())?.cancelledArchiveDirs ?? [];
    const cancelledDirs = mode === "full" ? await this.discoverCancelledArchiveDirs(scanRoots, prevDirs) : prevDirs;

    // 说明：maxItems 仅用于 UI 展示；中央索引需存全量数据，用于 DB 同步/归档。
    // 为避免极端情况下索引过大，这里加一个上限。
    const STORE_CAP = 10000;

    const items: OutputIndexItem[] = [];
    const seen = new Set<string>();

    const scanFolder = async (folder: TFolder, opts?: { skipArchivedChildren?: boolean }) => {
      for (const ch of folder.children) {
        if (ch instanceof TFolder) {
          const name = ch.name;
          // When scanning active roots, we skip special archive dirs to avoid duplicate/expensive scans.
          if (opts?.skipArchivedChildren) {
            if (name === "_archived") continue;
            const p = normalizePath(ch.path);
            if (this.isDoneArchivedPath(p, doneArchiveRoot)) continue;
          }
          await scanFolder(ch, opts);
        } else if (ch instanceof TFile) {
          if (ch.extension.toLowerCase() !== "md") continue;
          if (seen.has(ch.path)) continue;
          seen.add(ch.path);
          const it = await this.buildItemFromFile(ch);
          if (it) items.push(it);
        }
      }
    };

    const scanPath = async (p: string, mode: "active" | "archived") => {
      const af = this.host.app.vault.getAbstractFileByPath(p);
      if (!af) return;
      if (af instanceof TFolder) {
        await scanFolder(af, { skipArchivedChildren: mode === "active" });
      } else if (af instanceof TFile) {
        if (af.extension.toLowerCase() === "md") {
          if (seen.has(af.path)) return;
          seen.add(af.path);
          const it = await this.buildItemFromFile(af);
          if (it) items.push(it);
        }
      }
    };

    // 1) Active scan roots
    for (const r of scanRoots) {
      await scanPath(r, "active");
    }

    if (mode === "full") {
      // 2) DONE archive root (global)
      await scanPath(doneArchiveRoot, "archived");

      // 3) CANCELLED per-top-level _archived dirs
      for (const d of cancelledDirs) {
        await scanPath(d, "archived");
      }
    }

    // active mode: prune DONE/CANCELLED items to keep the index lightweight.
    // When the user enables showing archived statuses (done/cancelled), the view will trigger a full refresh.
    const finalItems = mode === "active"
      ? items.filter((it) => {
          const st = String((it as any).status ?? "").toLowerCase();
          return st !== "done" && st !== "cancelled";
        })
      : items;

    // keep only latest by mtime for storage compactness
    finalItems.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
    const trimmed = finalItems.slice(0, STORE_CAP);

    // ✅ 先写入主索引（包含所有扫描到的文件，包括归档目录中的）
    // 这样 archiveIndexForArchivedFiles 才能读取到完整的索引并清理
    this.snapshot = {
      version: 2,
      updatedAt: new Date().toISOString(),
      items: trimmed,
      cancelledArchiveDirs: cancelledDirs,
    };
    await this.store!.writeIndex(this.snapshot);

    // ✅ 检测文件修改时间变化，写入 WorkEvent（在归档清理之前，使用完整的文件列表）
    const workEventSvc = this.host.workEventSvc;
    if (workEventSvc && workEventSvc.isEnabled()) {
      const today = new Date();
      const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const todayEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999);

      // 预先读取今天的所有 output 事件（避免在循环中重复读取）
      const todayEvents = await workEventSvc.readEventsByFilter({
        kind: ["output"],
        startDate: todayStart,
        endDate: todayEnd,
      });

      // 构建今天已有 update 事件的映射（file_path -> true），用于去重
      // ✅ 一个文件一天只记录一次更新
      const todayUpdateEventsByPath = new Set<string>();
      for (const evt of todayEvents) {
        if (evt.action === "update") {
          const filePath = String(evt.ref?.file_path ?? "");
          if (filePath) {
            todayUpdateEventsByPath.add(filePath);
          }
        }
      }

      for (const newItem of trimmed) {
        const prevItem = prevItemsByPath.get(newItem.filePath);
        if (prevItem) {
          const prevMtime = prevItem.mtimeMs ?? 0;
          const newMtime = newItem.mtimeMs ?? 0;
          
          // 如果 mtime 变化了，且新 mtime 是今天，写入 WorkEvent
          if (newMtime > prevMtime && newMtime >= todayStart.getTime() && newMtime <= todayEnd.getTime()) {
            // ✅ 检查今天是否已经有 update 事件：一个文件一天只记录一次更新
            if (!todayUpdateEventsByPath.has(newItem.filePath)) {
              // 获取文件信息用于 WorkEvent
              const file = this.host.app.vault.getAbstractFileByPath(newItem.filePath);
              if (file instanceof TFile) {
                // append 方法会自动处理时间戳转换，直接传入 ISO 字符串即可
                void workEventSvc.append({
                  ts: new Date(newMtime).toISOString(), // append 方法会自动转换为本地时间
                  kind: "output",
                  action: "update",
                  source: "auto",
                  ref: {
                    file_path: newItem.filePath,
                    output_id: newItem.outputId,
                    status: newItem.status,
                    docCategory: newItem.docCategory,
                    type: newItem.type,
                    domains: newItem.domains,
                  },
                  summary: `📝 输出文件更新 ${newItem.title || newItem.filePath}`,
                });
              }
            }
          }
        }
      }
    }

    // ✅ 如果使用 full 模式，扫描归档目录后需要清理主索引：将已归档的文件移到归档索引
    // 这样主索引只保留未归档的文件，UI 层就不需要再做过滤了
    if (mode === "full") {
      await this.archiveIndexForArchivedFiles();
      // archiveIndexForArchivedFiles 会更新 this.snapshot 和写入索引
    }

    this.lastFullScanAt = Date.now();
  }

  /** Refresh with throttling to avoid expensive rescans on rapid UI refreshes */
  public async refreshIndexIfStale(minIntervalMs: number = 30_000, opts?: { mode?: "active" | "full" }): Promise<void> {
    const now = Date.now();
    if (now - this.lastFullScanAt < minIntervalMs) return;
    try {
      await this.refreshIndexNow({ mode: (opts?.mode ?? "active") });
    } catch (e) {
      console.warn("OutputRSLatte refreshIndex failed:", e);
    }
  }

  public async upsertFile(file: TFile): Promise<void> {
    await this.ensureReady();
    const it = await this.buildItemFromFile(file);
    if (!it) return;

    const snap = await this.getSnapshot();
    const items = (snap.items ?? []).filter(x => x.filePath !== file.path);
    items.push(it);
    items.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));

    const STORE_CAP = 10000;
    const trimmed = items.slice(0, STORE_CAP);

    // keep/update discovered cancelled archive dirs if this file is under _archived
    let cancelledArchiveDirs = (snap.cancelledArchiveDirs ?? []) as string[];
    if (this.isCancelledArchivedPath(file.path)) {
      const d = this.computeCancelledArchiveDirForPath(file.path);
      if (d && !cancelledArchiveDirs.includes(d)) cancelledArchiveDirs = [...cancelledArchiveDirs, d];
    }

    this.snapshot = { version: 2, updatedAt: new Date().toISOString(), items: trimmed, cancelledArchiveDirs };
    await this.store!.writeIndex(this.snapshot);
  }


  public pickTimelineDayKey(item: OutputIndexItem, field: OutputTimelineTimeField): string | null {
    switch (field) {
      case "mtime":
        return toDayKeyFromMs(item.mtimeMs);
      case "create":
        return item.createDate ?? toDayKeyFromMs(item.ctimeMs);
      case "done":
        return item.doneDate ?? null;
      default:
        return toDayKeyFromMs(item.mtimeMs);
    }
  }

  /**
   * 归档已归档文件的索引：将已归档文件的索引项从主索引移动到归档索引
   * - done 状态的文件归档到 99-Archive
   * - cancelled 状态的文件归档到 _archived
   */
  public async archiveIndexForArchivedFiles(): Promise<void> {
    await this.ensureReady();
    if (!this.store) return;

    const op = this.settings;
    const doneArchiveRoot = normalizePath(String((op as any)?.archiveRootDir ?? "99-Archive").trim() || "99-Archive");

    const idx = await this.getSnapshot();
    const mapFile = await this.store.readArchiveMap();
    const archiveMap = mapFile.map ?? {};

    const keep: OutputIndexItem[] = [];
    const toArchiveByMonth: Record<string, OutputIndexItem[]> = {};
    let hasArchivedItems = false; // 标记是否有归档文件需要处理

    // 辅助函数：安全地从日期字符串提取月份键
    const safeMonthKeyFromDate = (dateStr: string | undefined | null): string | null => {
      if (!dateStr) return null;
      const s = String(dateStr).trim();
      // 验证日期格式：YYYY-MM-DD 或至少 YYYY-MM
      if (/^\d{4}-\d{2}(-\d{2})?$/.test(s) && s.length >= 7) {
        return monthKeyFromYmd(s.length >= 10 ? s : `${s}-01`);
      }
      return null;
    };

    for (const it of idx.items ?? []) {
      const filePath = String(it.filePath ?? "").trim();
      if (!filePath) {
        keep.push(it);
        continue;
      }

      // 检查文件是否在归档目录中
      const isDoneArchived = this.isDoneArchivedPath(filePath, doneArchiveRoot);
      const isCancelledArchived = this.isCancelledArchivedPath(filePath);

      // 如果文件在归档目录中，或者已经在归档映射中，都应该从主索引移除
      if (isDoneArchived || isCancelledArchived || archiveMap[filePath]) {
        hasArchivedItems = true;
        // 如果已经在归档映射中，直接跳过（不需要再次归档）
        if (archiveMap[filePath]) continue;
        
        // 否则，需要添加到归档索引
        // 确定归档月份键（基于 doneDate 或 cancelledDate，如果没有则使用 createDate）
        let monthKey: string;
        if (isDoneArchived && it.doneDate) {
          monthKey = safeMonthKeyFromDate(it.doneDate) || monthKeyFromYmd(new Date().toISOString().slice(0, 10));
        } else if (isCancelledArchived) {
          // cancelled 状态：优先使用 cancelledDate，否则从 cancelledTime 提取，再否则使用 createDate
          const cancelledDateKey = safeMonthKeyFromDate(it.cancelledDate);
          if (cancelledDateKey) {
            monthKey = cancelledDateKey;
          } else if (it.cancelledTime) {
            const dateStr = it.cancelledTime.slice(0, 10);
            const timeKey = safeMonthKeyFromDate(dateStr);
            if (timeKey) {
              monthKey = timeKey;
            } else {
              const createKey = safeMonthKeyFromDate(it.createDate);
              monthKey = createKey || monthKeyFromYmd(new Date().toISOString().slice(0, 10));
            }
          } else {
            const createKey = safeMonthKeyFromDate(it.createDate);
            monthKey = createKey || monthKeyFromYmd(new Date().toISOString().slice(0, 10));
          }
        } else {
          const createKey = safeMonthKeyFromDate(it.createDate);
          monthKey = createKey || monthKeyFromYmd(new Date().toISOString().slice(0, 10));
        }

        (toArchiveByMonth[monthKey] ??= []).push(it);
      } else {
        // 文件不在归档目录中，保留在主索引
        keep.push(it);
      }
    }

    let archivedCount = 0;

    for (const [mk, items] of Object.entries(toArchiveByMonth)) {
      const added = await this.store.appendToArchive(mk, items);
      if (added > 0) {
        archivedCount += added;
        for (const it of items) {
          const path = String(it.filePath ?? "").trim();
          if (path) archiveMap[path] = mk;
        }
      }
    }

    // 更新主索引和归档映射
    // ✅ 即使 archivedCount === 0（所有文件都已归档过），只要检测到归档文件，也要更新主索引移除它们
    if (hasArchivedItems) {
      this.snapshot = {
        version: 2,
        updatedAt: new Date().toISOString(),
        items: keep,
        cancelledArchiveDirs: idx.cancelledArchiveDirs ?? [],
      };
      await this.store.writeIndex(this.snapshot);
      // 只有在有新归档项时才更新归档映射
      if (archivedCount > 0) {
        await this.store.writeArchiveMap({ version: 1, updatedAt: new Date().toISOString(), map: archiveMap });
      }
      // ✅ 同步修剪 output-sync-state.json：移除已归档条目的 byId，与主索引保持一致
      try {
        const syncFile = await this.store.readSyncState();
        const byId = (syncFile as any)?.byId ?? {};
        const filteredById: Record<string, any> = {};
        for (const [id, ent] of Object.entries(byId)) {
          const fp = (ent as any)?.filePath ?? "";
          if (!fp) continue;
          const np = normalizePath(String(fp));
          if (archiveMap[fp] || archiveMap[np]) continue;
          if (this.isDoneArchivedPath(np, doneArchiveRoot) || this.isCancelledArchivedPath(np)) continue;
          filteredById[id] = ent;
        }
        await this.store.writeSyncState({ 
          version: 1, 
          updatedAt: new Date().toISOString(), 
          byId: filteredById 
        });
      } catch (e) {
        console.warn("OutputRSLatte prune sync state failed:", e);
      }
    }
  }

  /** Build one index item from file cache/frontmatter */
  public async buildItemFromFile(file: TFile): Promise<OutputIndexItem | null> {
    try {
      const cache = this.host.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter ?? ({} as any);

      const outputId = (fm?.output_id ? String(fm.output_id).trim() : "") || undefined;

      const title = file.basename;

      const status = (fm?.status ? String(fm.status).trim() : "") || "todo";
      const type = fm?.type ? String(fm.type).trim() : undefined;
      const docCategory = fm?.["文档分类"] ? String(fm["文档分类"]).trim() : undefined;

      const tags = normalizeTags(fm?.tags);
      const domains = normalizeDomains(fm?.["领域"] ?? fm?.domains ?? fm?.domain);

      const createDate = toIsoDate(fm?.create ?? fm?.created ?? fm?.created_date) ?? (toDayKeyFromMs(file.stat?.ctime) ?? undefined);
      // done: prefer precise timestamp in `done_time`, fallback to `done` (may be a date-only field)
      const doneTime =
        toIsoDateTime(
          fm?.done_time ??
            fm?.done ??
            fm?.completed_time ??
            fm?.done_at ??
            fm?.completed_at ??
            fm?.doneDate ??
            fm?.completed
        ) ??
        // If only a date is provided, keep it as a day marker
        (toIsoDate(fm?.done_date ?? fm?.completed_date) ? new Date(String(toIsoDate(fm?.done_date ?? fm?.completed_date)) + "T00:00:00").toISOString() : undefined);

      const doneDate = doneTime ? toIsoDate(doneTime) : toIsoDate(fm?.done ?? fm?.done_date ?? fm?.completed ?? fm?.completed_date);

      // cancelled info (best-effort). Prefer precise timestamp in `cancelled_time`, fallback to `cancelled` (may be date-only).
      let cancelledTime = toIsoDateTime(
        fm?.cancelled_time ??
          fm?.cancelled ??
          fm?.cancel_time ??
          fm?.deleted_time ??
          fm?.delete_time ??
          fm?.deleted_at ??
          fm?.delete_at
      );
      let cancelledDate = toIsoDate(
        fm?.cancelled ?? fm?.cancelled_date ?? fm?.cancel_date ?? fm?.deleted_date ?? fm?.delete_date
      );

      if (!cancelledTime && String(status) === "cancelled") {
        // fallback: use current mtime, but note that without a persisted cancelled_time,
        // subsequent edits would change mtime; front-end may choose to persist cancelled_time.
        const ms = file.stat?.mtime;
        if (ms && Number.isFinite(ms)) cancelledTime = new Date(ms).toISOString();
      }
      if (!cancelledDate && cancelledTime) {
        cancelledDate = toIsoDate(cancelledTime) ?? undefined;
      }

      const it: OutputIndexItem = {
        outputId,
        filePath: file.path,
        title,
        docCategory,
        tags,
        type,
        status,
        createDate,
        doneDate,
        doneTime,
        cancelledDate,
        cancelledTime,
        domains,
        ctimeMs: file.stat?.ctime,
        mtimeMs: file.stat?.mtime,
      };

      return it;
    } catch (e) {
      console.warn("OutputRSLatte buildItemFromFile failed:", e);
      return null;
    }
  }
}
