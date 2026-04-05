import { App, TFile, TFolder, normalizePath } from "obsidian";
import { appendOutputArchivedFromIndexLedgerEvent, readMergedOutputLedgerMaps } from "./outputHistoryLedger";
import { buildOutputRefreshScanPlan, mergeOutputPrimaryScanRoots } from "./outputRefreshScanPlan";
import { normalizeArchiveThresholdDays } from "../constants/defaults";
import type { RSLattePluginSettings } from "../types/settings";
import type { OutputIndexFile, OutputIndexItem, OutputPanelSettings, OutputTimelineTimeField } from "../types/outputTypes";
import { OutputIndexStore } from "./indexStore";
import { resolveSpaceIndexDir } from "../services/space/spaceContext";
import { monthKeyFromYmd } from "../taskRSLatte/utils";
import { localYmdFromInstant, toLocalOffsetIsoString } from "../utils/localCalendarYmd";

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
    try {
      return toLocalOffsetIsoString(new Date(v));
    } catch {
      return undefined;
    }
  }
  const s = String(v).trim();
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  return toLocalOffsetIsoString(d);
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
      /** 批量改写输出 frontmatter 后同步 DB / 日记（与 OutputSidePanelView 一致） */
      syncOutputToDbBestEffort?: (reason: string) => Promise<void>;
      /** 写 `.history` 台账（主索引归档迁出等） */
      ledgerPluginRef?: () => import("../main").default | null | undefined;
    }
  ) {}

  private get settings(): OutputPanelSettings {
    const s = this.host.settingsRef();
    const op = s.outputPanel;
    return op as any;
  }

  /** 项目输出契约条目：用于重建前后一致性诊断。 */
  private isProjectOutputContractItem(it: OutputIndexItem): boolean {
    const kind = String((it as any)?.outputDocumentKind ?? "").trim().toLowerCase();
    const outputId = String((it as any)?.outputId ?? "").trim();
    const projectId = String((it as any)?.projectId ?? "").trim();
    return kind === "project" && !!outputId && !!projectId;
  }

  /** 判断路径是否落在任一扫描根下（前缀匹配）。 */
  private isPathUnderAnyRoot(filePath: string, roots: string[]): boolean {
    const p = normalizePath(String(filePath ?? "").trim());
    if (!p) return false;
    for (const r0 of roots) {
      const r = normalizePath(String(r0 ?? "").trim()).replace(/\/+$/g, "");
      if (!r) continue;
      if (p === r || p.startsWith(r + "/")) return true;
    }
    return false;
  }

  /**
   * 兜底发现项目 `pro_files` 根：
   * - 优先用 projectMgr 快照（低开销）
   * - 若快照为空，回退从 projectRootDir 递归发现名为 `pro_files` 的目录（避免重建时漏掉项目输出）
   */
  private collectProjectProFilesRoots(): string[] {
    const roots = new Set<string>();
    try {
      const projSnap = (this.host as any).projectMgr?.getSnapshot?.();
      const projects = (projSnap?.projects ?? []) as Array<{ folderPath?: string }>;
      for (const p of projects) {
        const fp = normalizePath(String(p?.folderPath ?? "").trim());
        if (!fp) continue;
        roots.add(normalizePath(`${fp}/pro_files`));
      }
      if (roots.size > 0) return Array.from(roots);
    } catch {
      // ignore and fallback below
    }

    // fallback：从 projectRootDir 递归发现 pro_files
    try {
      const s: any = this.host.settingsRef() as any;
      const projectRootDir = normalizePath(String(s?.projectRootDir ?? "").trim());
      const rootAf = projectRootDir ? this.host.app.vault.getAbstractFileByPath(projectRootDir) : null;
      if (!(rootAf instanceof TFolder)) return Array.from(roots);

      const walk = (folder: TFolder) => {
        for (const ch of folder.children) {
          if (!(ch instanceof TFolder)) continue;
          if (ch.name === "pro_files") {
            roots.add(normalizePath(ch.path));
            continue;
          }
          walk(ch);
        }
      };
      walk(rootAf);
    } catch {
      // ignore fallback errors
    }
    return Array.from(roots);
  }

  /** 输出重建一致性诊断：帮助定位“upsert 后在全量重建里丢失”的原因。 */
  private logProjectOutputDropDiagnostics(prevItems: OutputIndexItem[], nextItems: OutputIndexItem[], scanRoots: string[]): void {
    try {
      const prevMap = new Map<string, OutputIndexItem>();
      for (const it of prevItems ?? []) prevMap.set(String(it.filePath ?? "").trim(), it);
      const nextSet = new Set<string>((nextItems ?? []).map((it) => String(it.filePath ?? "").trim()));

      for (const [fp, it] of prevMap) {
        if (!fp || !this.isProjectOutputContractItem(it)) continue;
        if (nextSet.has(fp)) continue;
        const inRoots = this.isPathUnderAnyRoot(fp, scanRoots);
        console.warn("[RSLatte][output-index] project output dropped after rebuild", {
          filePath: fp,
          outputId: (it as any).outputId,
          projectId: (it as any).projectId,
          reason: inRoots ? "rebuild_parse_or_filter_miss" : "scan_roots_miss",
          scanRootsCount: scanRoots.length,
        });
      }
    } catch {
      // diagnose only
    }
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

  /** 索引归档阈值：早于该日（按本地日界）的 DONE 条目可从主索引迁出（仍留在知识库路径下时）。 */
  private getOutputIndexArchiveCutoffDayKey(): string {
    const days = normalizeArchiveThresholdDays(this.settings.archiveThresholdDays);
    const localMid = new Date();
    localMid.setHours(0, 0, 0, 0);
    localMid.setDate(localMid.getDate() - days);
    const y = localMid.getFullYear();
    const m = String(localMid.getMonth() + 1).padStart(2, "0");
    const d = String(localMid.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  /** 用于与 archiveThresholdDays 比较的参考日（优先 doneDate，否则 mtime 日） */
  private itemDayKeyForIndexArchive(it: OutputIndexItem): string | null {
    const ds = String(it.doneDate ?? "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(ds)) return ds;
    return toDayKeyFromMs(it.mtimeMs);
  }

  /**
   * 合并 `.history/output-ledger.json` 中记录的 **知识库路径**：若 Vault 中仍有对应 md 且尚未进入本次扫描集合，则补建索引项。
   * @see `types/outputTypes.ts` 文件头 §8.4（台账与磁盘扫描顺序）
   */
  private async mergeLedgerKnowledgePathsIntoScan(
    items: OutputIndexItem[],
    seen: Set<string>,
  ): Promise<void> {
    try {
      const maps = await readMergedOutputLedgerMaps(this.host.app, this.host.settingsRef() as any);
      for (const kPath of maps.byKnowledgePath.keys()) {
        const p = normalizePath(String(kPath ?? "").trim());
        if (!p || seen.has(p)) continue;
        const af = this.host.app.vault.getAbstractFileByPath(p);
        if (!(af instanceof TFile)) continue;
        if (af.extension.toLowerCase() !== "md") continue;
        seen.add(af.path);
        const it = await this.buildItemFromFile(af);
        if (it) items.push(it);
      }
    } catch (e) {
      console.warn("[RSLatte][output] mergeLedgerKnowledgePathsIntoScan failed:", e);
    }
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

  /**
   * 兜底：若用户手工修改了 md 文件名，扫描时同步修正父目录中的“输出名”片段。
   * 约束：
   * - 仅处理符合 `【文档分类】输出名(-n)` 命名约定的父目录
   * - 仅当 frontmatter 的 `文档分类/doc_category` 与目录前缀一致时生效
   * - 保留原目录后缀 `-n`（如有），并做重名避让
   */
  private async syncFolderNameByMdFileName(file: TFile, fm?: Record<string, unknown>): Promise<TFile> {
    try {
      const parentPath = normalizePath(String(file.path).split("/").slice(0, -1).join("/"));
      const parentName = parentPath.split("/").pop() ?? "";
      const parentDir = parentPath.split("/").slice(0, -1).join("/");
      const parentAf = this.host.app.vault.getAbstractFileByPath(parentPath);
      if (!(parentAf instanceof TFolder)) return file;

      const docCategory =
        (fm?.["文档分类"] ? String(fm["文档分类"]).trim() : "") ||
        (fm?.doc_category ? String(fm.doc_category).trim() : "");
      if (!docCategory) return file;

      const m = parentName.match(/^【(.+?)】(.+?)(-\d+)?$/);
      if (!m) return file;
      const folderCat = String(m[1] ?? "").trim();
      const folderOutputName = String(m[2] ?? "").trim();
      if (folderCat !== docCategory) return file;
      // 目录名与文件名必须保持一致（去掉 `【文档分类】` 前缀后）；
      // - 无后缀目录：`folderOutputName === file.basename`
      // - 有后缀目录：`${folderOutputName}${suffix} === file.basename`
      // 避免把“目录带 -2 但文件不带 -2”误判为一致，导致无法自愈。
      const folderRawSuffix = String(m[3] ?? "");
      const isConsistent = folderRawSuffix
        ? `${folderOutputName}${folderRawSuffix}` === file.basename
        : folderOutputName === file.basename;
      if (isConsistent) return file;

      // 统一口径：目标目录名始终直接跟随当前文件基名，不继承旧目录后缀。
      let wantedFolderPath = normalizePath(`${parentDir}/【${docCategory}】${file.basename}`);
      const exists = (p: string) => !!this.host.app.vault.getAbstractFileByPath(p);
      if (wantedFolderPath !== parentPath && exists(wantedFolderPath)) {
        let i = 2;
        while (exists(normalizePath(`${parentDir}/【${docCategory}】${file.basename}-${i}`))) i++;
        wantedFolderPath = normalizePath(`${parentDir}/【${docCategory}】${file.basename}-${i}`);
      }
      if (wantedFolderPath === parentPath) return file;

      try {
        await this.host.app.vault.rename(parentAf, wantedFolderPath);
      } catch (e: any) {
        const msg = String(e?.message ?? e ?? "");
        // 并发刷新/重建时，父目录可能已被其他流程改名（ENOENT）或目标已被占用（EEXIST）；
        // 这两类都属于“自愈改名竞争”，不应中断主流程。
        if (/ENOENT|no such file or directory|EEXIST|already exists|Destination file already exists/i.test(msg)) return file;
        throw e;
      }
      const renamedPath = normalizePath(`${wantedFolderPath}/${file.name}`);
      const renamedAf = this.host.app.vault.getAbstractFileByPath(renamedPath);
      if (renamedAf instanceof TFile) return renamedAf;
      return file;
    } catch (e) {
      console.warn("[RSLatte][output] syncFolderNameByMdFileName failed:", e);
      return file;
    }
  }
  /**
   * 重建中央输出索引：物理扫描顺序与台账合并见 **`types/outputTypes.ts` §8.4**、`buildOutputRefreshScanPlan`。
   */
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

    // §8.4：第一段扫描根 = archiveRoots + 各项目 pro_files（与 `mergeOutputPrimaryScanRoots` 单一实现）
    const uniqScanRoots = mergeOutputPrimaryScanRoots(op?.archiveRoots ?? [], this.collectProjectProFilesRoots());
    const scanPlan = buildOutputRefreshScanPlan(op, mode);

    // If scanRoots are empty, do nothing (avoid scanning the entire vault by accident).
    // IMPORTANT: do NOT wipe existing snapshot/cancelledArchiveDirs cache, otherwise the UI may lose
    // knowledge about per-top-level _archived dirs and require an expensive full rescan.
    if (!uniqScanRoots.length) {
      const prev = await this.getSnapshot();
      this.snapshot = {
        version: 2,
        updatedAt: toLocalOffsetIsoString(),
        items: (prev?.items ?? []) as OutputIndexItem[],
        cancelledArchiveDirs: (prev?.cancelledArchiveDirs ?? []) as string[],
      };
      await this.store!.writeIndex(this.snapshot);
      this.lastFullScanAt = Date.now();
      return;
    }

    // doneArchiveRoot: global archive root（与 `buildOutputRefreshScanPlan` 一致）
    const doneArchiveRoot = scanPlan.doneArchiveRoot;

    // cancelledArchiveDirs: per-top-level "_archived" dirs (CANCELLED docs)
    // - active mode: keep previous cache (no discovery)
    // - full mode: (re)discover based on scan roots + previous cache
    const prevDirs = (await this.getSnapshot())?.cancelledArchiveDirs ?? [];
    const cancelledDirs = mode === "full" ? await this.discoverCancelledArchiveDirs(uniqScanRoots, prevDirs) : prevDirs;

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
    for (const r of uniqScanRoots) {
      await scanPath(r, "active");
    }

    if (mode === "full" && scanPlan.includesLegacyPhysicalArchive) {
      // 2) DONE archive root（旧版「笔记归档」目的地，如 99-Archive）
      await scanPath(doneArchiveRoot, "archived");

      // 3) CANCELLED per-top-level _archived dirs
      for (const d of cancelledDirs) {
        await scanPath(d, "archived");
      }
    }

    // 4) 与合并后的台账对齐：ledger 中的知识库路径若仍有文件，补入索引（发布到知识库后主流程不依赖再扫物理归档目录）
    await this.mergeLedgerKnowledgePathsIntoScan(items, seen);

    // active mode: prune DONE/CANCELLED items to keep the index lightweight.
    // When the user enables showing archived statuses (done/cancelled), the view will trigger a full refresh.
    const finalItems = mode === "active"
      ? items.filter((it) => {
          const st = String((it as any).status ?? "").toLowerCase();
          return st !== "done" && st !== "cancelled";
        })
      : items;

    // ✅ 诊断：重建后若丢失「项目输出契约条目」，打印原因（roots miss / parse miss）
    this.logProjectOutputDropDiagnostics(prevSnapshot?.items ?? [], finalItems, uniqScanRoots);

    // keep only latest by mtime for storage compactness
    finalItems.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
    const trimmed = finalItems.slice(0, STORE_CAP);

    // ✅ 先写入主索引（包含所有扫描到的文件，包括归档目录中的）
    // 这样 archiveIndexForArchivedFiles 才能读取到完整的索引并清理
    this.snapshot = {
      version: 2,
      updatedAt: toLocalOffsetIsoString(),
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
                  ts: toLocalOffsetIsoString(new Date(newMtime)),
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

    this.snapshot = { version: 2, updatedAt: toLocalOffsetIsoString(), items: trimmed, cancelledArchiveDirs };
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
   * 索引归档（主索引 → 按月 JSON + archive-map）：
   * - 笔记仍在「输出笔记归档根」或 `_archived` 下时，按路径迁出；
   * - **或** DONE 且路径落在 **输出文档扫描根**（如知识库目录）、且超过 **archiveThresholdDays**（相对 doneDate / mtime 日）时迁出，并在对应根下 **`.history/output-ledger`** 追加 `output_archived_from_index`（不要求再做笔记物理归档）。
   */
  public async archiveIndexForArchivedFiles(): Promise<void> {
    await this.ensureReady();
    if (!this.store) return;

    const op = this.settings;
    const doneArchiveRoot = normalizePath(String((op as any)?.archiveRootDir ?? "99-Archive").trim() || "99-Archive");
    const fallbackDayYmd = localYmdFromInstant(new Date()) ?? "1970-01-01";

    const idx = await this.getSnapshot();
    const mapFile = await this.store.readArchiveMap();
    const archiveMap = mapFile.map ?? {};

    const keep: OutputIndexItem[] = [];
    const toArchiveByMonth: Record<string, OutputIndexItem[]> = {};
    let hasArchivedItems = false; // 标记是否有归档文件需要处理

    const cutoffDay = this.getOutputIndexArchiveCutoffDayKey();
    const archiveRootsNorm = this.normalizeRootList(op?.archiveRoots ?? []);

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
      const inArchiveMap = !!archiveMap[filePath];

      const refDay = this.itemDayKeyForIndexArchive(it);
      const st = String(it.status ?? "").toLowerCase();
      /** 已发布在扫描根（如知识库）下、DONE 且超过索引归档阈值：仅迁出主索引，不要求笔记再搬到 99-Archive */
      const timeArchiveKnowledgeDone =
        !isDoneArchived &&
        !isCancelledArchived &&
        !inArchiveMap &&
        st === "done" &&
        this.isPathUnderAnyRoot(filePath, archiveRootsNorm) &&
        !!refDay &&
        refDay < cutoffDay;

      // 物理归档目录、已在 map、或「知识库 DONE 超时」：主索引迁出
      if (isDoneArchived || isCancelledArchived || inArchiveMap || timeArchiveKnowledgeDone) {
        hasArchivedItems = true;
        if (inArchiveMap) continue;

        let monthKey: string;
        if (timeArchiveKnowledgeDone) {
          monthKey = safeMonthKeyFromDate(refDay) || monthKeyFromYmd(fallbackDayYmd);
        } else if (isDoneArchived && it.doneDate) {
          monthKey = safeMonthKeyFromDate(it.doneDate) || monthKeyFromYmd(fallbackDayYmd);
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
              monthKey = createKey || monthKeyFromYmd(fallbackDayYmd);
            }
          } else {
            const createKey = safeMonthKeyFromDate(it.createDate);
            monthKey = createKey || monthKeyFromYmd(fallbackDayYmd);
          }
        } else {
          const createKey = safeMonthKeyFromDate(it.createDate);
          monthKey = createKey || monthKeyFromYmd(fallbackDayYmd);
        }

        (toArchiveByMonth[monthKey] ??= []).push(it);
      } else {
        keep.push(it);
      }
    }

    let archivedCount = 0;

    const tsLedger = toLocalOffsetIsoString();
    const ledgerPlg = this.host.ledgerPluginRef?.() ?? null;

    for (const [mk, items] of Object.entries(toArchiveByMonth)) {
      const added = await this.store.appendToArchive(mk, items);
      if (added > 0) {
        archivedCount += added;
        for (const it of items) {
          const path = String(it.filePath ?? "").trim();
          if (path) archiveMap[path] = mk;
        }
        if (ledgerPlg) {
          for (const it of items) {
            const fp = String((it as any).filePath ?? "").trim();
            if (!fp) continue;
            const oid =
              String((it as any).outputId ?? (it as any).output_id ?? "")
                .trim() || undefined;
            void appendOutputArchivedFromIndexLedgerEvent(ledgerPlg, {
              sourceOutputPath: fp,
              outputId: oid,
              archiveMonthKey: mk,
              tsIso: tsLedger,
            });
          }
        }
      }
    }

    // 更新主索引和归档映射
    // ✅ 即使 archivedCount === 0（所有文件都已归档过），只要检测到归档文件，也要更新主索引移除它们
    if (hasArchivedItems) {
      this.snapshot = {
        version: 2,
        updatedAt: toLocalOffsetIsoString(),
        items: keep,
        cancelledArchiveDirs: idx.cancelledArchiveDirs ?? [],
      };
      await this.store.writeIndex(this.snapshot);
      // 只有在有新归档项时才更新归档映射
      if (archivedCount > 0) {
        await this.store.writeArchiveMap({ version: 1, updatedAt: toLocalOffsetIsoString(), map: archiveMap });
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
          updatedAt: toLocalOffsetIsoString(), 
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
      let workingFile = file;
      const cache0 = this.host.app.metadataCache.getFileCache(workingFile);
      const fm0 = (cache0?.frontmatter ?? {}) as Record<string, unknown>;
      workingFile = await this.syncFolderNameByMdFileName(workingFile, fm0);

      const cache = this.host.app.metadataCache.getFileCache(workingFile);
      const fm = cache?.frontmatter ?? ({} as any);

      const outputId = (fm?.output_id ? String(fm.output_id).trim() : "") || undefined;

      const title = workingFile.basename;

      const status = (fm?.status ? String(fm.status).trim() : "") || "todo";
      const type = fm?.type ? String(fm.type).trim() : undefined;
      const docCategory =
        (fm?.["文档分类"] ? String(fm["文档分类"]).trim() : "") ||
        (fm?.doc_category ? String(fm.doc_category).trim() : "") ||
        undefined;

      const rawKind = fm?.output_document_kind ? String(fm.output_document_kind).trim().toLowerCase() : "";
      const outputDocumentKind: "general" | "project" | undefined =
        rawKind === "project" ? "project" : rawKind === "general" ? "general" : undefined;

      const projectId =
        (fm?.project_id ? String(fm.project_id).trim() : "") ||
        (fm?.projectId ? String(fm.projectId).trim() : "") ||
        undefined;
      const projectName =
        (fm?.project_name ? String(fm.project_name).trim() : "") ||
        (fm?.projectName ? String(fm.projectName).trim() : "") ||
        undefined;

      const resumeAt = toIsoDate(fm?.resume_at ?? fm?.resumeAt) || undefined;

      const tags = normalizeTags(fm?.tags);
      const domains = normalizeDomains(fm?.["领域"] ?? fm?.domains ?? fm?.domain);

      const createDate = toIsoDate(fm?.create ?? fm?.created ?? fm?.created_date) ?? (toDayKeyFromMs(workingFile.stat?.ctime) ?? undefined);
      const linkedScheduleUid =
        (fm?.linked_schedule_uid ? String(fm.linked_schedule_uid).trim() : "") ||
        (fm?.linkedScheduleUid ? String(fm.linkedScheduleUid).trim() : "") ||
        undefined;
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
        (toIsoDate(fm?.done_date ?? fm?.completed_date)
          ? toLocalOffsetIsoString(new Date(String(toIsoDate(fm?.done_date ?? fm?.completed_date)) + "T00:00:00"))
          : undefined);

      // done_time 为 UTC ISO 时，doneDate 须用本地日历日，勿用字符串前缀（否则与 Obsidian 本机「今天」错位）
      const doneDate = doneTime
        ? localYmdFromInstant(doneTime) ?? toIsoDate(doneTime)
        : toIsoDate(fm?.done ?? fm?.done_date ?? fm?.completed ?? fm?.completed_date);

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
        const ms = workingFile.stat?.mtime;
        if (ms && Number.isFinite(ms)) cancelledTime = toLocalOffsetIsoString(new Date(ms));
      }
      if (!cancelledDate && cancelledTime) {
        cancelledDate = localYmdFromInstant(cancelledTime) ?? toIsoDate(cancelledTime) ?? undefined;
      }

      const it: OutputIndexItem = {
        outputId,
        filePath: workingFile.path,
        title,
        outputDocumentKind,
        docCategory,
        tags,
        type,
        status,
        projectId: projectId || undefined,
        projectName: projectName || undefined,
        resumeAt: resumeAt || undefined,
        createDate,
        doneDate,
        doneTime,
        cancelledDate,
        cancelledTime,
        domains,
        ctimeMs: workingFile.stat?.ctime,
        mtimeMs: workingFile.stat?.mtime,
        linkedScheduleUid: linkedScheduleUid || undefined,
      };

      return it;
    } catch (e) {
      console.warn("OutputRSLatte buildItemFromFile failed:", e);
      return null;
    }
  }

  /**
   * status=waiting_until 且 resume_at≤今日 时自动恢复为 in-progress（打开侧栏/刷新索引时补跑）。
   */
  public async resumeWaitingOutputsIfDue(): Promise<number> {
    const snap = this.snapshot ?? (await this.getSnapshot());
    const items = snap?.items ?? [];
    const today = toDayKeyFromMs(Date.now());
    if (!today) return 0;

    let n = 0;
    const nowIso = toLocalOffsetIsoString();

    for (const it of items) {
      if (String(it.status ?? "").trim() !== "waiting_until") continue;
      const ra = String(it.resumeAt ?? "").trim().slice(0, 10);
      if (!ra || ra > today) continue;

      const af = this.host.app.vault.getAbstractFileByPath(it.filePath);
      if (!(af instanceof TFile)) continue;

      await this.host.app.fileManager.processFrontMatter(af, (fm: any) => {
        fm.status = "in-progress";
        fm.resumed_time = nowIso;
      });
      try {
        this.host.app.metadataCache.trigger("changed", af);
      } catch {
        // ignore
      }
      try {
        await this.upsertFile(af);
      } catch {
        // ignore
      }

      void this.host.workEventSvc?.append({
        ts: nowIso,
        kind: "output",
        action: "continued",
        source: "auto",
        ref: { file_path: it.filePath, status: "in-progress" },
        summary: `⏳→▶ 输出等待到期自动继续 ${af.basename}`,
      });
      n++;
    }

    if (n > 0) {
      try {
        await this.host.syncOutputToDbBestEffort?.("resume_waiting_until");
      } catch {
        // ignore
      }
      try {
        this.host.refreshSidePanel();
      } catch {
        // ignore
      }
    }

    return n;
  }
}
