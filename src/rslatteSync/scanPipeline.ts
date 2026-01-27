import type { App, TFile } from "obsidian";
import { moment } from "obsidian";
// ✅ moment 从 Obsidian 导入，但 TypeScript 类型定义可能不完整，使用类型断言
const momentFn = moment as any;
import type { RSLatteIndexStore } from "../taskRSLatte/indexStore";
import type { RSLatteIndexItem, RSLatteParsedLine, RSLatteScanCacheFile } from "../taskRSLatte/types";
import { fnv1a32 } from "../utils/hash";

/**
 * Scan pipeline skeleton (Task/Memo flavor).
 *
 * Goal of Step10: extract the *flow* for reuse (project/output will be able
 * to reuse this module by swapping the parse function and settings).
 *
 * This module intentionally keeps behavior identical to the previous inlined
 * implementation in taskRSLatte/service.ts.
 */

export type ScanWithCacheOpts = {
  /** When true, parser may update content to ensure uid/meta. Only used in manual refresh/force full scan. */
  fixUidAndMeta?: boolean;
};

export type ScanWithCacheDeps = {
  app: App;
  store: RSLatteIndexStore;
  files: TFile[];
  includeTags: string[];
  excludeTags: string[];
  /** Used to invalidate scan cache when filter settings change. */
  filterKey: string;
  prevTasks: RSLatteIndexItem[];
  prevMemos: RSLatteIndexItem[];

  fileMatchesTags: (app: App, file: TFile, content: string, includeTags: string[], excludeTags: string[]) => boolean;
  parseRSLatteFile: (filePath: string, content: string, opts: { fixUidAndMeta: boolean }) => {
    tasks: RSLatteParsedLine[];
    memos: RSLatteParsedLine[];
    updatedContent?: string;
  };

  /** Optional hook invoked when an included file is read+parsed in this scan run (i.e. changed/new). */
  onIncludedFileParsed?: (args: {
    filePath: string;
    mtime: number;
    size: number;
    content: string;
    parsed: { tasks: RSLatteParsedLine[]; memos: RSLatteParsedLine[] };
  }) => void | Promise<void>;
  
  /** Optional DEBUG log enabled function */
  debugLogEnabled?: () => boolean;
};

export async function scanAllCachedWithStore(
  deps: ScanWithCacheDeps,
  opts?: ScanWithCacheOpts
): Promise<{ tasks: RSLatteParsedLine[]; memos: RSLatteParsedLine[]; includedFilePaths: string[]; touchedFilePaths: string[]; removedFilePaths: string[] }>{
  const { app, store, files, includeTags, excludeTags, filterKey, prevTasks, prevMemos, fileMatchesTags, parseRSLatteFile, onIncludedFileParsed } = deps;

  const includedFilePaths: string[] = [];
  // Files that were actually read+parsed in this scan run (only meaningful for incremental).
  // Used by higher-level pipelines to update derived indexes (e.g. contacts-interactions) without re-reading all files.
  const touchedFilePaths: string[] = [];
  // Files removed from candidate set OR became excluded by tags.
  const removedFilePaths: string[] = [];

  let cache: RSLatteScanCacheFile = await store.readScanCache();
  if (!cache || cache.filterKey !== filterKey) {
    cache = { version: 1, updatedAt: new Date().toISOString(), filterKey, files: {} };
  }

  // Group previous index items by file for reuse.
  const stripIndex = (it: RSLatteIndexItem): RSLatteParsedLine => {
    const { itemId, lastPushedHash, lastPushedAt, seenAt, archived, ...rest } = it as any;
    return rest as RSLatteParsedLine;
  };

  const prevByFile = new Map<string, { tasks: RSLatteParsedLine[]; memos: RSLatteParsedLine[] }>();
  for (const it of prevTasks ?? []) {
    const bucket = prevByFile.get(it.filePath) ?? { tasks: [], memos: [] };
    bucket.tasks.push(stripIndex(it));
    prevByFile.set(it.filePath, bucket);
  }
  for (const it of prevMemos ?? []) {
    const bucket = prevByFile.get(it.filePath) ?? { tasks: [], memos: [] };
    bucket.memos.push(stripIndex(it));
    prevByFile.set(it.filePath, bucket);
  }

  const today = momentFn().format("YYYY-MM-DD");
  const tasks: RSLatteParsedLine[] = [];
  const memos: RSLatteParsedLine[] = [];

  let cacheChanged = false;
  const nextFiles: Record<string, any> = {};

  for (const f of files) {
    const fp = { mtime: Number((f as any).stat?.mtime ?? 0), size: Number((f as any).stat?.size ?? 0) };
    const old = (cache.files ?? ({} as any))[f.path];

    // If unchanged and we know it was excluded by tags last time, skip without reading.
    if (old && old.mtime === fp.mtime && old.size === fp.size && old.included === false) {
      nextFiles[f.path] = old;
      continue;
    }

    // If unchanged and included, reuse previous parsed lines from index.
    // ✅ 但需要验证内容哈希，确保文件内容确实未改变（防止手动删除任务后缓存未更新）
    if (old && old.mtime === fp.mtime && old.size === fp.size && old.included === true) {
      // ✅ 即使 mtime/size 相同，也读取文件内容验证哈希，确保内容确实未改变
      // 这对于检测手动删除任务等情况很重要
      let shouldReuse = false;
      try {
        const content = await app.vault.read(f);
        const contentHash = fnv1a32(content);
        if (old.hash === contentHash) {
          // 内容哈希匹配，可以安全重用
          const reuse = prevByFile.get(f.path);
          if (reuse && (reuse.tasks.length || reuse.memos.length)) {
            tasks.push(...reuse.tasks);
            memos.push(...reuse.memos);
            includedFilePaths.push(f.path);
            nextFiles[f.path] = old;
            shouldReuse = true;
          }
        }
        // 如果哈希不匹配，fall through 到重新解析
      } catch (e) {
        // 读取失败，fall through 到重新解析
        console.warn("[rslatte-scan] Failed to verify content hash, will re-parse", f.path, e);
      }
      if (shouldReuse) continue;
      // No previous items or content hash mismatch -> fall through to read & parse.
    }

    // Changed or new file -> read content and parse.
    const original = await app.vault.read(f);
    let content = original;
    const included = fileMatchesTags(app, f, content, includeTags ?? [], excludeTags ?? []);
    const fixUid = opts?.fixUidAndMeta === true;

    // If it was previously included but now excluded, mark for cleanup in derived indexes.
    if (old && old.included === true && included === false) {
      removedFilePaths.push(f.path);
    }

    // Parse once (optionally fixing uid + inserting/updating meta comment lines).
    let parsedFile = parseRSLatteFile(f.path, content, { fixUidAndMeta: included && fixUid });

    // Manual refresh: write back uid/meta changes if needed.
    if (included && fixUid && parsedFile.updatedContent && parsedFile.updatedContent !== content) {
      try {
        content = parsedFile.updatedContent;
        await app.vault.modify(f, content);
        // After write-back, update local fingerprint to reduce immediate re-scan.
        fp.mtime = Date.now();
        fp.size = content.length;
      } catch (e) {
        // Write-back failed -> fall back to original content parse (no fix), but keep scanning.
        console.warn("[rslatte-scan] fixUidAndMeta write-back failed", f.path, e);
        content = original;
        parsedFile = parseRSLatteFile(f.path, content, { fixUidAndMeta: false });
      }
    }

    const contentHash = fnv1a32(content);
    nextFiles[f.path] = { mtime: fp.mtime, size: fp.size, hash: contentHash, included };
    if (!old || old.mtime !== fp.mtime || old.size !== fp.size || old.included !== included || old.hash !== contentHash) {
      cacheChanged = true;
    }
    if (!included) continue;

    includedFilePaths.push(f.path);
    // This file was read+parsed in this run.
    touchedFilePaths.push(f.path);

    // Allow callers to compute derived indexes without re-reading the file.
    try {
      await onIncludedFileParsed?.({
        filePath: f.path,
        mtime: fp.mtime,
        size: fp.size,
        content,
        parsed: { tasks: parsedFile.tasks, memos: parsedFile.memos },
      });
    } catch (e) {
      // Best-effort: never block the main scan.
      console.warn("[rslatte-scan] onIncludedFileParsed failed", f.path, e);
    }

    // created 缺失时 fallback：用文件创建时间
    const createdFallback = momentFn((f as any).stat?.ctime ?? Date.now()).format("YYYY-MM-DD");
    for (const parsed of [...parsedFile.tasks, ...parsedFile.memos]) {
      if (!parsed.createdDate) parsed.createdDate = createdFallback;
      // DONE/CANCELLED 但缺少日期：用今天补齐（便于归档/统计）
      if (parsed.status === "DONE" && !parsed.doneDate) parsed.doneDate = today;
      if (parsed.status === "CANCELLED" && !parsed.cancelledDate) parsed.cancelledDate = today;
    }

    tasks.push(...parsedFile.tasks);
    memos.push(...parsedFile.memos);
  }

  // Purge entries for files no longer in the candidate set.
  const prevKeys = Object.keys(cache.files ?? {});
  if (prevKeys.length !== Object.keys(nextFiles).length) cacheChanged = true;
  else {
    for (const k of prevKeys) {
      if (!(k in nextFiles)) {
        cacheChanged = true;
        break;
      }
    }
  }

  // Files removed from candidate set (deleted, moved out of folders, renamed).
  // Only meaningful when previous cache existed.
  for (const k of prevKeys) {
    if (!(k in nextFiles)) {
      removedFilePaths.push(k);
    }
  }

  if (cacheChanged) {
    const nextCache: RSLatteScanCacheFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      filterKey,
      files: nextFiles,
    };
    await store.writeScanCache(nextCache);
  }

  // ✅ DEBUG: 打印扫描结果
  const debugLogEnabled = deps.debugLogEnabled?.() === true;
  if (debugLogEnabled) {
    console.log(`[RSLatte][scanAllCachedWithStore] Scan completed:`, {
      totalScannedFiles: files.length,
      includedFilePaths: includedFilePaths.length,
      touchedFilePaths: touchedFilePaths.length,
      removedFilePaths: removedFilePaths.length,
      tasksCount: tasks.length,
      memosCount: memos.length,
      includedFiles: includedFilePaths.sort().slice(0, 20), // 只显示前20个
      touchedFiles: touchedFilePaths.sort().slice(0, 20), // 只显示前20个
      removedFiles: removedFilePaths.sort().slice(0, 20), // 只显示前20个
    });
  }

  return { tasks, memos, includedFilePaths, touchedFilePaths, removedFilePaths };
}
