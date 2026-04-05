import type {
  ModuleSpecAtomic,
  RSLatteAtomicOpContext,
  RSLatteModuleStats,
  RSLatteModuleOpSummary,
  RSLatteReconcileGate,
  RSLatteFlushQueueOptions,
} from "../moduleSpec";
import type { RSLatteResult, RSLatteError, RSLatteScanResult } from "../types";
import { TFile, TFolder, normalizePath } from "obsidian";
import { readFrontmatter } from "../../../utils/frontmatter";
import { ProjectIndexStore } from "../../../projectRSLatte/indexStore";
import { apiTry } from "../../../api";
import { buildProjectTaskContactEntriesFromMarkdownContent } from "../../contacts/projectTaskContactInteractions";
import type { ContactsInteractionEntry } from "../../../contactsRSLatte/types";
import { resolveSpaceIndexDir, resolveSpaceQueueDir } from "../../space/spaceContext";

/**
 * ## §8.1 语义标签
 *
 * - **`rebuildActiveOnly`**：`replaceAll` → `projectMgr.refreshAll`：只枚举 **`projectRootDir`** 下直接子文件夹，**排除** **`projectArchiveDir`**（与 `scanFull` 差分逻辑一致）。
 * - **`rebuildAfterPhysicalArchive`**：`archiveOutOfRange` → `archiveDoneAndCancelledNow`：搬迁项目夹后 **`archiveIndexNow`**（`archiveProjectIndexByMonths`）。
 *
 * 登记：`PIPELINE_ATOMIC_REBUILD_SCOPE_REGISTRY.project`（`rebuildScopeSemantics.ts`）。
 */

function ok<T>(data: T, warnings?: string[]): RSLatteResult<T> {
  return warnings?.length ? { ok: true, data, warnings } : { ok: true, data };
}

function fail(code: string, message: string, detail?: unknown): RSLatteResult<never> {
  const error: RSLatteError = { code, message, detail };
  return { ok: false, error };
}

function mkNoopStats(moduleKey: "project"): RSLatteModuleStats {
  return { moduleKey, items: {}, meta: {} } as any;
}

function mkNoopSummary(ctx: RSLatteAtomicOpContext, startedAt: string, message: string, gate?: RSLatteReconcileGate): RSLatteModuleOpSummary {
  return {
    moduleKey: ctx.moduleKey,
    mode: ctx.mode,
    op: ctx.op === "reconcile" ? "reconcile" : "stats",
    startedAt,
    finishedAt: new Date().toISOString(),
    metrics: { noop: 1 },
    message,
    gate,
  } as any;
}

/**
 * Create Project ModuleSpecAtomic.
 *
 * - **rebuild**：`manualRefreshAndSync` + `writeTodayProjectProgressToJournal`（见 `replaceAll` 内链）。
 * - **§8.1**：见文件头 `rebuildActiveOnly` / `rebuildAfterPhysicalArchive`。
 */
export function createProjectSpecAtomic(plugin: any): ModuleSpecAtomic {

const getIndexDir = (): string => {
  const s: any = plugin?.settings ?? {};
  return resolveSpaceIndexDir(s, undefined, [s.projectRSLatteIndexDir]);
};

const getQueueDir = (): string => {
  const s: any = plugin?.settings ?? {};
  return normalizePath(`${resolveSpaceQueueDir(s, undefined, [s.projectRSLatteIndexDir])}/project`);
};

// runId-scoped delta snapshot (used for gate.deltaSize)
const deltaByRunId = new Map<string, { addedIds: string[]; updatedIds: string[]; removedIds: string[] }>();

// runId-scoped dirty scan snapshot (used for gate2)
const dirtyByRunId = new Map<string, { uidMissingFiles: string[]; parseErrorFiles: string[] }>();

// runId-scoped flag so we only clear dbSyncForceFullNext.project after a successful flush
const forceFullByRunId = new Map<string, boolean>();

const computeDbSyncEnabled = (): boolean => {
  try {
    return plugin?.isProjectDbSyncEnabled?.() === true;
  } catch {
    return false;
  }
};

const getForceFullFlag = (): boolean => {
  try {
    return !!(plugin?.settings as any)?.dbSyncForceFullNext?.project;
  } catch {
    return false;
  }
};

const ensureBackendSafe = async (): Promise<boolean> => {
  try {
    // ✅ C0：ensureVaultReadySafe 内部会判断 shouldTouchBackendNow() 并做 warn 节流
    const ok = await plugin?.vaultSvc?.ensureVaultReadySafe?.("projectSpecAtomic");
    return ok !== false;
  } catch {
    return false;
  }
};


// 未使用的函数，保留以备将来使用
// const writeIndexFromSnapshot = async (): Promise<void> => {
//   const app = plugin?.app;
//   if (!app) return;
//   const store = new ProjectIndexStore(app, getIndexDir(), getQueueDir());
//   await store.ensureLayout();
//   const snap = (plugin?.projectMgr as any)?.getSnapshot?.() ?? (plugin?.projectMgr as any)?._snapshot;
//   const projects = (snap?.projects ?? []) as any[];
//   const items = projects
//     .map((p: any) => {
//       const pid = String(p?.projectId ?? p?.project_id ?? '').trim();
//       if (!pid) return null;
//       return {
//         project_id: pid,
//         project_name: String(p?.projectName ?? p?.project_name ?? '').trim(),
//         status: String(p?.status ?? 'todo'),
//         create_date: String(p?.create ?? p?.create_date ?? '').match(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/) ? String(p?.create ?? p?.create_date) : undefined,
//         due_date: String(p?.due ?? p?.due_date ?? '').match(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/) ? String(p?.due ?? p?.due_date) : undefined,
//         start_date: String(p?.start ?? p?.start_date ?? '').match(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/) ? String(p?.start ?? p?.start_date) : undefined,
//         done_date: String(p?.done ?? p?.done_date ?? '').match(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/) ? String(p?.done ?? p?.done_date) : undefined,
//         cancelled_date: String(p?.cancelled ?? p?.cancelled_date ?? '').match(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/) ? String(p?.cancelled ?? p?.cancelled_date) : undefined,
//         folder_path: p?.folderPath ?? p?.folder_path,
//         info_file_path: p?.infoFilePath ?? p?.info_file_path,
//         tasklist_file_path: p?.tasklistFilePath ?? p?.tasklist_file_path,
//         analysis_file_path: p?.analysisFilePath ?? p?.analysis_file_path,
//         milestones: (p?.milestones ?? []).map((m: any) => ({
//           name: m?.name,
//           done: m?.done,
//           todo: m?.todo,
//           inprogress: m?.inprogress,
//           total: m?.total,
//         })),
//         mtime_key: p?.mtimeKey ?? p?.mtime_key,
//         updated_at: new Date().toISOString(),
//       };
//     })
//     .filter(Boolean);
//   await store.writeIndex(items as any);
// };

  return {
    key: "project",
    label: "Project",

    // --- incremental scan (P2) ---
    async scanIncremental(ctx) {
      try {
        const app = plugin?.app;
        const settings = plugin?.settings;
        const root = normalizePath(String(settings?.projectRootDir ?? "").trim());
        const archiveDir = normalizePath(String(settings?.projectArchiveDir ?? "").trim());

        if (!app || !root) {
          const r: RSLatteScanResult<string> = {
            mode: "inc",
            changedFiles: [],
            addedIds: [],
            updatedIds: [],
            removedIds: [],
            meta: { scannedAt: Date.now(), reason: !app ? "NO_APP" : "NO_PROJECT_ROOT" },
          };
          return ok(r);
        }

        const store = new ProjectIndexStore(app, getIndexDir(), getQueueDir());
        const prev = await store.readIndex();
        const prevItems = prev?.items ?? [];

        const prevByFolder = new Map<string, any>();
        const prevById = new Map<string, any>();
        for (const it of prevItems) {
          const pid = String((it as any)?.project_id ?? "").trim();
          const folder = normalizePath(String((it as any)?.folder_path ?? "").trim());
          if (pid) prevById.set(pid, it);
          if (folder) prevByFolder.set(folder, it);
        }

        const rootAf = app.vault.getAbstractFileByPath(root);
        const curFolders: string[] = [];
        if (rootAf instanceof TFolder) {
          for (const ch of rootAf.children) {
            if (!(ch instanceof TFolder)) continue;
            const fp = normalizePath(ch.path);
            if (!fp) continue;
            if (archiveDir && (fp === archiveDir || fp.startsWith(archiveDir + "/"))) continue;
            curFolders.push(fp);
          }
        }

        const changedFiles = new Set<string>();
        const addedIds = new Set<string>();
        const updatedIds = new Set<string>();
        const removedIds = new Set<string>();

        const uidMissingFiles = new Set<string>();
        const parseErrorFiles = new Set<string>();

        const getFile = (p: string): TFile | null => {
          const af = app.vault.getAbstractFileByPath(normalizePath(p));
          return af instanceof TFile ? af : null;
        };

        const pickByRole = async (folder: TFolder, role: string): Promise<TFile | null> => {
          const candidates = folder.children.filter((x) => x instanceof TFile) as TFile[];
          for (const f of candidates) {
            const fm = await readFrontmatter(app, f);
            if (String((fm as any)?.file_role ?? "").trim() === role) return f;
          }
          return null;
        };

        const computeMtimeKey = async (folderPath: string): Promise<{ pid?: string; mtimeKey?: string; files: string[] }> => {
          const folderAf = app.vault.getAbstractFileByPath(folderPath);
          if (!(folderAf instanceof TFolder)) return { files: [] };

          const info = getFile(`${folderPath}/项目信息.md`) ?? (await pickByRole(folderAf, "project_info"));
          const task = getFile(`${folderPath}/项目任务清单.md`) ?? (await pickByRole(folderAf, "project_tasklist"));
          const analysis = (await pickByRole(folderAf, "project_analysis")) ?? null;

          const files: string[] = [];
          if (info) files.push(info.path);
          if (task) files.push(task.path);
          if (analysis) files.push(analysis.path);

          const pid = (() => {
            const prevIt = prevByFolder.get(folderPath);
            const prevPid = String((prevIt as any)?.project_id ?? "").trim();
            if (prevPid) return prevPid;
            return "";
          })();

          let pidResolved = pid;
          if (!pidResolved && info) {
            try {
              const fm = await readFrontmatter(app, info);
              pidResolved = String((fm as any)?.project_id ?? "").trim();
              if (!pidResolved) uidMissingFiles.add(info.path);
            } catch {
              parseErrorFiles.add(info.path);
            }
          }

          const mk = `${info?.stat?.mtime ?? 0}|${task?.stat?.mtime ?? 0}|${analysis?.stat?.mtime ?? 0}`;
          return { pid: pidResolved || undefined, mtimeKey: mk, files };
        };

        const curById = new Map<string, { folder: string; mtimeKey: string; files: string[] }>();
        for (const folderPath of curFolders) {
          const r = await computeMtimeKey(folderPath);
          const pid = String(r.pid ?? "").trim();
          if (!pid) continue;
          curById.set(pid, { folder: folderPath, mtimeKey: String(r.mtimeKey ?? ""), files: r.files ?? [] });
        }

        // added/updated
        for (const [pid, cur] of curById.entries()) {
          const prevIt = prevById.get(pid);
          if (!prevIt) {
            addedIds.add(pid);
            for (const f of cur.files) changedFiles.add(f);
            continue;
          }
          const prevKey = String((prevIt as any)?.mtime_key ?? "");
          if (prevKey !== String(cur.mtimeKey ?? "")) {
            updatedIds.add(pid);
            for (const f of cur.files) changedFiles.add(f);
          }
        }

        // removed
        const curIdSet = new Set(curById.keys());
        for (const it of prevItems) {
          const pid = String((it as any)?.project_id ?? "").trim();
          if (!pid) continue;
          if (curIdSet.has(pid)) continue;
          removedIds.add(pid);
          const paths = [
            String((it as any)?.info_file_path ?? ""),
            String((it as any)?.tasklist_file_path ?? ""),
            String((it as any)?.analysis_file_path ?? ""),
          ].filter(Boolean);
          for (const p of paths) changedFiles.add(normalizePath(p));
        }

        const res: RSLatteScanResult<string> = {
          mode: "inc",
          changedFiles: Array.from(changedFiles),
          addedIds: Array.from(addedIds),
          updatedIds: Array.from(updatedIds),
          removedIds: Array.from(removedIds),
          meta: {
            scannedAt: Date.now(),
            reason: ctx?.reason,
            uidMissingFiles: Array.from(uidMissingFiles),
            parseErrorFiles: Array.from(parseErrorFiles),
          },
        };
        if (ctx?.runId) {
          dirtyByRunId.set(String(ctx.runId), {
            uidMissingFiles: Array.from(uidMissingFiles),
            parseErrorFiles: Array.from(parseErrorFiles),
          });
        }
        
        // ✅ DEBUG: 打印扫描到的文件清单
        const debugLogEnabled = (plugin?.settings as any)?.debugLogEnabled === true;
        if (debugLogEnabled && (changedFiles.size > 0 || addedIds.size > 0 || updatedIds.size > 0 || removedIds.size > 0)) {
          console.log(`[RSLatte][project][manual_refresh] scanIncremental: Scanned files:`, {
            changedFiles: Array.from(changedFiles).sort(),
            addedIds: Array.from(addedIds).sort(),
            updatedIds: Array.from(updatedIds).sort(),
            removedIds: Array.from(removedIds).sort(),
            uidMissingFiles: Array.from(uidMissingFiles).sort(),
            parseErrorFiles: Array.from(parseErrorFiles).sort(),
          });
        }
        
        return ok(res);
      } catch (e: any) {
        const res: RSLatteScanResult<string> = {
          mode: "inc",
          changedFiles: [],
          addedIds: [],
          updatedIds: [],
          removedIds: [],
          meta: { scannedAt: Date.now(), reason: "SCAN_FAILED" },
        };
        return ok(res, [`scanIncremental failed: ${e?.message ?? String(e)}`]);
      }
    },
    async applyDelta(ctx, scan) {
      const startedAt = new Date().toISOString();
      try {
        await plugin.projectMgr?.ensureReady?.();

        const s = (scan ?? {}) as RSLatteScanResult<string>;
        const changedFiles: string[] = Array.isArray((s as any).changedFiles) ? (s as any).changedFiles : [];
        const addedIds: string[] = Array.isArray((s as any).addedIds) ? (s as any).addedIds.map((x: any) => String(x)) : [];
        const updatedIds: string[] = Array.isArray((s as any).updatedIds) ? (s as any).updatedIds.map((x: any) => String(x)) : [];
        const removedIds: string[] = Array.isArray((s as any).removedIds) ? (s as any).removedIds.map((x: any) => String(x)) : [];

        // Derive folder paths from changed files (best-effort)
        const folders = new Set<string>();
        for (const fp of changedFiles) {
          const p = normalizePath(String(fp ?? "").trim());
          if (!p) continue;
          const parts = p.split("/").filter(Boolean);
          if (parts.length <= 1) continue;
          folders.add(normalizePath(parts.slice(0, -1).join("/")));
        }

        // Also try to map ids -> folder_path from existing central index
        try {
          const app = plugin?.app;
          // const settings = plugin?.settings; // 未使用

          if (app) {
            const store = new ProjectIndexStore(app, getIndexDir(), getQueueDir());
            const prev = await store.readIndex();
            const byId = new Map<string, any>();
            for (const it of prev?.items ?? []) {
              const pid = String((it as any)?.project_id ?? "").trim();
              if (pid) byId.set(pid, it);
            }
            for (const pid of [...addedIds, ...updatedIds, ...removedIds]) {
              const it = byId.get(String(pid ?? "").trim());
              const folder = normalizePath(String((it as any)?.folder_path ?? "").trim());
              if (folder) folders.add(folder);
            }
          }
        } catch {
          // best-effort only
        }

        // Feed folders into legacy dirty refresh so that snapshot + index persistence stay consistent.
        const mgrAny: any = plugin.projectMgr as any;
        const dirtySet: any = mgrAny?._dirtyFolders;
        if (dirtySet && typeof dirtySet.add === "function") {
          for (const f of folders) dirtySet.add(f);
        }

        await plugin.projectMgr?.refreshDirty?.({ reason: ctx?.reason || "engine_applyDelta" });

        
// Force index persistence to happen within this engine step (avoid debounce delay).
// ⚠️ P4: do NOT enqueue DB sync here; DB sync is handled in buildOps/flushQueue.
if (mgrAny?._indexDebounce) {
  window.clearTimeout(mgrAny._indexDebounce);
  mgrAny._indexDebounce = null;
}

// Write central index JSON (keep format/path) without touching DB sync queue.
try {
  const app = plugin?.app;
  // const settings = plugin?.settings; // 未使用
  if (app) {
    const indexDir = getIndexDir();
    const store = new ProjectIndexStore(app, indexDir, getQueueDir());
    await store.ensureLayout();
    const snap = (plugin.projectMgr?.getSnapshot?.() ?? (plugin.projectMgr as any)?._snapshot) as any;
    const projects = Array.isArray(snap?.projects) ? snap.projects : [];

    const toRSLatteItem = (p: any) => ({
      project_id: String(p?.projectId ?? "").trim(),
      project_name: String(p?.projectName ?? "").trim(),
      status: String(p?.status ?? "todo"),
      create_date: (typeof p?.create === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(p.create)) ? p.create : undefined,
      due_date: (typeof p?.due === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(p.due)) ? p.due : undefined,
      start_date: (typeof p?.start === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(p.start)) ? p.start : undefined,
      done_date: (typeof p?.done === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(p.done)) ? p.done : undefined,
      cancelled_date: (typeof p?.cancelled === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(p.cancelled)) ? p.cancelled : undefined,
      folder_path: p?.folderPath,
      info_file_path: p?.infoFilePath,
      tasklist_file_path: p?.tasklistFilePath,
      analysis_file_path: p?.analysisFilePath,
      milestones: (p?.milestones ?? []).map((m: any) => ({
        name: m?.name,
        path: String(m?.path ?? m?.name ?? "").trim() || undefined,
        done: m?.done,
        todo: m?.todo,
        inprogress: m?.inprogress,
        total: m?.total,
      })),
      mtime_key: p?.mtimeKey,
      db_sync_status: (p as any)?.dbSyncStatus,
      db_synced_at: (p as any)?.dbSyncedAt,
      db_last_error: (p as any)?.dbLastError,
      db_pending_ops: (p as any)?.dbPendingOps,
      project_tags: Array.isArray(p?.project_tags) ? [...p.project_tags] : undefined,
      project_status_display_zh: String(p?.project_status_display_zh ?? "").trim() || undefined,
      updated_at: new Date().toISOString(),
    });

    const items = projects.map(toRSLatteItem).filter((x: any) => String(x.project_id ?? '').trim());
    await store.writeIndex(items as any);
  }
} catch {
  // best-effort index write; legacy code also has debounce persistence
}

// Step4: update contacts-interactions index for *project_task* source, incrementally (best-effort).
try {
  const app2 = plugin?.app;
  const store2 = plugin?.contactsIndex?.getInteractionsStore?.();
  if (app2 && store2 && typeof (store2 as any).applyFileUpdates === "function") {
    const snap = (plugin.projectMgr?.getSnapshot?.() ?? (plugin.projectMgr as any)?._snapshot) as any;
    const projects = Array.isArray(snap?.projects) ? snap.projects : [];

    // Only recompute interactions for projects whose folderPath is in the dirty folder set.
    const folderSet = new Set<string>(Array.from(folders));

    // Fallback: even if scanIncremental misses changed folders (e.g. indexDir mismatch or mtime_key drift),
    // detect updates by comparing tasklist file mtime with the existing contacts-interactions by_source_file.mtime.
    try {
      const idxNow: any = await (store2 as any).readIndex?.();
      const bySrc: any = idxNow?.by_source_file ?? {};
      for (const p of projects) {
        const folder = normalizePath(String(p?.folderPath ?? p?.folder_path ?? '').trim());
        if (!folder) continue;
        const tasklistPath = normalizePath(String(p?.tasklistFilePath ?? p?.tasklist_file_path ?? '').trim());
        if (!tasklistPath) continue;
        const af = app2.vault.getAbstractFileByPath(tasklistPath);
        if (!(af instanceof TFile)) continue;
        const curMtime = Number((af.stat as any)?.mtime ?? 0);
        const prevMtime = Number(bySrc?.[tasklistPath]?.mtime ?? 0);
        if (curMtime && curMtime !== prevMtime) folderSet.add(folder);
        // If we never indexed this tasklist before, still consider it dirty (cheap, single-file read later).
        if (curMtime && !prevMtime) folderSet.add(folder);
      }
    } catch {
      // ignore
    }


    // Resolve removed tasklist paths from central index (by removedIds)
    const removedTasklistPaths: string[] = [];
    try {
      const indexDir2 = getIndexDir();
      const pStore = new ProjectIndexStore(app2, indexDir2, getQueueDir());
      const prev2 = await pStore.readIndex();
      const byId2 = new Map<string, any>();
      for (const it of prev2?.items ?? []) {
        const pid = String((it as any)?.project_id ?? "").trim();
        if (pid) byId2.set(pid, it);
      }
      for (const pid of removedIds) {
        const it = byId2.get(String(pid ?? "").trim());
        const taskFp = normalizePath(String((it as any)?.tasklist_file_path ?? "").trim());
        if (taskFp) removedTasklistPaths.push(taskFp);
      }

      // Also handle rename/move of tasklist file path for dirty projects:
      // if project_id still exists but tasklist_file_path changed, remove the old path bucket.
      for (const p of projects) {
        const folder = normalizePath(String(p?.folderPath ?? p?.folder_path ?? "").trim());
        if (!folder || !folderSet.has(folder)) continue;
        const pid = String(p?.projectId ?? p?.project_id ?? "").trim();
        if (!pid) continue;
        const prevIt = byId2.get(pid);
        if (!prevIt) continue;
        const prevPath = normalizePath(String((prevIt as any)?.tasklist_file_path ?? "").trim());
        const curPath = normalizePath(String(p?.tasklistFilePath ?? p?.tasklist_file_path ?? "").trim());
        if (prevPath && curPath && prevPath !== curPath) removedTasklistPaths.push(prevPath);
      }
    } catch {
      // ignore
    }

    const nowIso = new Date().toISOString();
    const byFile: Record<string, { mtime: number; entries: ContactsInteractionEntry[] }> = {};

    for (const p of projects) {
      const folder = normalizePath(String(p?.folderPath ?? p?.folder_path ?? "").trim());
      if (!folder || !folderSet.has(folder)) continue;
      const tasklistPath = normalizePath(String(p?.tasklistFilePath ?? p?.tasklist_file_path ?? "").trim());
      if (!tasklistPath) continue;

      const af = app2.vault.getAbstractFileByPath(tasklistPath);
      if (!(af instanceof TFile)) continue;

      const content = await app2.vault.cachedRead(af);
      const out = buildProjectTaskContactEntriesFromMarkdownContent(content, tasklistPath, nowIso);
      byFile[tasklistPath] = { mtime: Number((af.stat as any)?.mtime ?? 0), entries: out };
    }

    const upserts = Object.keys(byFile).map((fp) => ({
      source_path: fp,
      mtime: Number((byFile as any)[fp]?.mtime ?? 0),
      entries: Array.isArray((byFile as any)[fp]?.entries) ? (byFile as any)[fp].entries : [],
    }));

    // removals: removed projects' tasklist files, plus changed tasklist files that no longer exist
    const removalSet = new Set<string>(removedTasklistPaths);
    for (const fp of changedFiles) {
      const pth = normalizePath(String(fp ?? "").trim());
      if (!pth) continue;
      if (!pth.endsWith(".md")) continue;
      // Heuristic: tasklist file candidates
      const isTaskList = pth.endsWith("项目任务清单.md") || pth.includes("任务清单");
      if (!isTaskList) continue;
      const af = app2.vault.getAbstractFileByPath(pth);
      if (!(af instanceof TFile)) removalSet.add(pth);
    }

    const removals = Array.from(removalSet);
    await (store2 as any).applyFileUpdates({ upserts, removals });
  }
} catch {
  // never block project pipeline
}

// 与曾用 legacy incrementalRefresh 一致：Pipeline 增量应用后 best-effort 写今日项目进度日记（内部有变化检测）
await (plugin as any).writeTodayProjectProgressToJournal?.();

if (ctx?.runId) deltaByRunId.set(String(ctx.runId), { addedIds, updatedIds, removedIds });

return ok({
  startedAt,
  forceFullSync: getForceFullFlag(),
  applied: {
    folderCount: folders.size,
    addedIds,
    updatedIds,
    removedIds,
  },
});
      } catch (e: any) {
        return ok(
          { startedAt, applied: { folderCount: 0, added: 0, updated: 0, removed: 0 } },
          [`applyDelta failed: ${e?.message ?? String(e)}`]
        );
      }
    },

    // --- rebuild scan (P2) — 差分元数据；枚举范围与 §8.1 `rebuildActiveOnly` 一致（跳过 projectArchiveDir）---
    async scanFull(ctx) {
      try {
        const app = plugin?.app;
        const settings = plugin?.settings;
        const root = normalizePath(String(settings?.projectRootDir ?? "").trim());
        const archiveDir = normalizePath(String(settings?.projectArchiveDir ?? "").trim());

        if (!app || !root) {
          const r: RSLatteScanResult<string> = {
            mode: "full",
            changedFiles: [],
            addedIds: [],
            updatedIds: [],
            removedIds: [],
            meta: { scannedAt: Date.now(), reason: !app ? "NO_APP" : "NO_PROJECT_ROOT" },
          };
          return ok(r);
        }

        const store = new ProjectIndexStore(app, getIndexDir(), getQueueDir());
        const prev = await store.readIndex();
        const prevItems = prev?.items ?? [];

        const prevById = new Map<string, any>();
        for (const it of prevItems) {
          const pid = String((it as any)?.project_id ?? "").trim();
          if (pid) prevById.set(pid, it);
        }

        const changedFiles = new Set<string>();
        const addedIds = new Set<string>();
        const updatedIds = new Set<string>();
        const removedIds = new Set<string>();

        const uidMissingFiles = new Set<string>();
        const parseErrorFiles = new Set<string>();

        const rootAf = app.vault.getAbstractFileByPath(root);
        const folders: TFolder[] = [];
        if (rootAf instanceof TFolder) {
          for (const ch of rootAf.children) {
            if (!(ch instanceof TFolder)) continue;
            const fp = normalizePath(ch.path);
            if (!fp) continue;
            if (archiveDir && (fp === archiveDir || fp.startsWith(archiveDir + "/"))) continue;
            folders.push(ch);
          }
        }

        const pickByRole = async (folder: TFolder, role: string): Promise<TFile | null> => {
          const candidates = folder.children.filter((x) => x instanceof TFile) as TFile[];
          for (const f of candidates) {
            const fm = await readFrontmatter(app, f);
            if (String((fm as any)?.file_role ?? "").trim() === role) return f;
          }
          return null;
        };

        const getFile = (p: string): TFile | null => {
          const af = app.vault.getAbstractFileByPath(normalizePath(p));
          return af instanceof TFile ? af : null;
        };

        const curIds = new Set<string>();

        for (const folder of folders) {
          const folderPath = normalizePath(folder.path);
          const info = getFile(`${folderPath}/项目信息.md`) ?? (await pickByRole(folder, "project_info"));
          const task = getFile(`${folderPath}/项目任务清单.md`) ?? (await pickByRole(folder, "project_tasklist"));
          const analysis = (await pickByRole(folder, "project_analysis")) ?? null;

          const files: string[] = [];
          if (info) files.push(info.path);
          if (task) files.push(task.path);
          if (analysis) files.push(analysis.path);
          for (const f of files) changedFiles.add(f);

          let pid = "";
          if (info) {
            try {
              const fm = await readFrontmatter(app, info);
              pid = String((fm as any)?.project_id ?? "").trim();
              if (!pid) uidMissingFiles.add(info.path);
            } catch {
              parseErrorFiles.add(info.path);
            }
          }
          if (!pid) continue;
          curIds.add(pid);

          const mk = `${info?.stat?.mtime ?? 0}|${task?.stat?.mtime ?? 0}|${analysis?.stat?.mtime ?? 0}`;
          const prevIt = prevById.get(pid);
          if (!prevIt) {
            addedIds.add(pid);
          } else {
            const prevKey = String((prevIt as any)?.mtime_key ?? "");
            if (prevKey !== mk) updatedIds.add(pid);
          }
        }

        for (const it of prevItems) {
          const pid = String((it as any)?.project_id ?? "").trim();
          if (!pid) continue;
          if (curIds.has(pid)) continue;
          removedIds.add(pid);
        }

        const res: RSLatteScanResult<string> = {
          mode: "full",
          changedFiles: Array.from(changedFiles),
          addedIds: Array.from(addedIds),
          updatedIds: Array.from(updatedIds),
          removedIds: Array.from(removedIds),
          meta: {
            scannedAt: Date.now(),
            reason: ctx?.reason,
            uidMissingFiles: Array.from(uidMissingFiles),
            parseErrorFiles: Array.from(parseErrorFiles),
          },
        };
        if (ctx?.runId) {
          dirtyByRunId.set(String(ctx.runId), {
            uidMissingFiles: Array.from(uidMissingFiles),
            parseErrorFiles: Array.from(parseErrorFiles),
          });
        }
        
        // ✅ DEBUG: 打印扫描到的文件清单
        const debugLogEnabled = (plugin?.settings as any)?.debugLogEnabled === true;
        if (debugLogEnabled && (changedFiles.size > 0 || addedIds.size > 0 || updatedIds.size > 0 || removedIds.size > 0)) {
          console.log(`[RSLatte][project][manual_refresh] scanFull: Scanned files:`, {
            changedFiles: Array.from(changedFiles).sort(),
            addedIds: Array.from(addedIds).sort(),
            updatedIds: Array.from(updatedIds).sort(),
            removedIds: Array.from(removedIds).sort(),
            uidMissingFiles: Array.from(uidMissingFiles).sort(),
            parseErrorFiles: Array.from(parseErrorFiles).sort(),
          });
        }
        
        return ok(res);
      } catch (e: any) {
        const res: RSLatteScanResult<string> = {
          mode: "full",
          changedFiles: [],
          addedIds: [],
          updatedIds: [],
          removedIds: [],
          meta: { scannedAt: Date.now(), reason: "SCAN_FAILED" },
        };
        return ok(res, [`scanFull failed: ${e?.message ?? String(e)}`]);
      }
    },

async replaceAll(ctx, scan) {
  const startedAt = new Date().toISOString();
  try {
    await plugin.projectMgr?.ensureReady?.();

    // §8.1 `rebuildActiveOnly`：`refreshAll` 不扫 projectArchiveDir。P4：DB sync 在 buildOps/flushQueue。
    await plugin.projectMgr?.refreshAll?.({ reason: ctx?.reason || "engine_replaceAll", forceSync: false });

    // Cancel debounce persistence to avoid implicit enqueue/flush.
    const mgrAny: any = plugin.projectMgr as any;
    if (mgrAny?._indexDebounce) {
      window.clearTimeout(mgrAny._indexDebounce);
      mgrAny._indexDebounce = null;
    }

    // Write central index JSON now (best-effort), keep format/path.
    try {
      const app = plugin?.app;
      // const settings = plugin?.settings; // 未使用
      if (app) {
        const indexDir = getIndexDir();
        const store = new ProjectIndexStore(app, indexDir, getQueueDir());
        await store.ensureLayout();
        const snap = (plugin.projectMgr?.getSnapshot?.() ?? (plugin.projectMgr as any)?._snapshot) as any;
        const projects = Array.isArray(snap?.projects) ? snap.projects : [];
        const toRSLatteItem = (p: any) => ({
          project_id: String(p?.projectId ?? "").trim(),
          project_name: String(p?.projectName ?? "").trim(),
          status: String(p?.status ?? "todo"),
          create_date: (typeof p?.create === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(p.create)) ? p.create : undefined,
          due_date: (typeof p?.due === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(p.due)) ? p.due : undefined,
          start_date: (typeof p?.start === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(p.start)) ? p.start : undefined,
          done_date: (typeof p?.done === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(p.done)) ? p.done : undefined,
          cancelled_date: (typeof p?.cancelled === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(p.cancelled)) ? p.cancelled : undefined,
          folder_path: p?.folderPath,
          info_file_path: p?.infoFilePath,
          tasklist_file_path: p?.tasklistFilePath,
          analysis_file_path: p?.analysisFilePath,
          milestones: (p?.milestones ?? []).map((m: any) => ({
            name: m?.name,
            path: String(m?.path ?? m?.name ?? "").trim() || undefined,
            done: m?.done,
            todo: m?.todo,
            inprogress: m?.inprogress,
            total: m?.total,
          })),
          mtime_key: p?.mtimeKey,
          db_sync_status: (p as any)?.dbSyncStatus,
          db_synced_at: (p as any)?.dbSyncedAt,
          db_last_error: (p as any)?.dbLastError,
          db_pending_ops: (p as any)?.dbPendingOps,
          project_tags: Array.isArray(p?.project_tags) ? [...p.project_tags] : undefined,
          project_status_display_zh: String(p?.project_status_display_zh ?? "").trim() || undefined,
          updated_at: new Date().toISOString(),
        });
        const items = projects.map(toRSLatteItem).filter((x: any) => String(x.project_id ?? '').trim());
        await store.writeIndex(items as any);
      }
    } catch {
      // ignore
    }

    // Step4: update contacts-interactions index for *project_task* source, rebuild (best-effort).
    try {
      const app2 = plugin?.app;
      const store2 = plugin?.contactsIndex?.getInteractionsStore?.();
      if (app2 && store2) {
        const snap = (plugin.projectMgr?.getSnapshot?.() ?? (plugin.projectMgr as any)?._snapshot) as any;
        const projects = Array.isArray(snap?.projects) ? snap.projects : [];
        const nowIso = new Date().toISOString();
        const byFile: Record<string, { mtime: number; entries: ContactsInteractionEntry[] }> = {};

        for (const p of projects) {
          const tasklistPath = normalizePath(String(p?.tasklistFilePath ?? p?.tasklist_file_path ?? "").trim());
          if (!tasklistPath) continue;
          const af = app2.vault.getAbstractFileByPath(tasklistPath);
          if (!(af instanceof TFile)) continue;

          const content = await app2.vault.cachedRead(af);
          const out = buildProjectTaskContactEntriesFromMarkdownContent(content, tasklistPath, nowIso);
          byFile[tasklistPath] = { mtime: Number((af.stat as any)?.mtime ?? 0), entries: out };
        }

        const upserts = Object.keys(byFile).map((fp) => ({
          source_path: fp,
          mtime: Number((byFile as any)[fp]?.mtime ?? 0),
          entries: Array.isArray((byFile as any)[fp]?.entries) ? (byFile as any)[fp].entries : [],
        }));

        await (store2 as any).applyFileUpdates?.({ upserts, removals: [] });
        const allowed = new Set(Object.keys(byFile));
        await (store2 as any).cleanupSourceTypeNotIn?.("project_task", allowed);
      }
    } catch {
      // never block project pipeline
    }

    // Best-effort: keep legacy journal write behavior.
    await (plugin as any).writeTodayProjectProgressToJournal?.();

    const s = (scan ?? {}) as any;
    const addedIds = Array.isArray(s.addedIds) ? s.addedIds.map((x: any) => String(x)) : [];
    const updatedIds = Array.isArray(s.updatedIds) ? s.updatedIds.map((x: any) => String(x)) : [];
    const removedIds = Array.isArray(s.removedIds) ? s.removedIds.map((x: any) => String(x)) : [];



    if (ctx?.runId) deltaByRunId.set(String(ctx.runId), { addedIds, updatedIds, removedIds });

return ok({ startedAt, applied: { addedIds, updatedIds, removedIds } });
  } catch (e: any) {
    return fail("PROJECT_REBUILD_FAILED", "Project rebuild failed", { message: e?.message ?? String(e) });
  }
},

    // --- archive (P6) — §8.1 `rebuildAfterPhysicalArchive`：`archiveDoneAndCancelledNow` 内搬迁 + `archiveIndexNow` ---
    async archiveOutOfRange(ctx) {
      const startedAt = new Date().toISOString();
      try {
        const enabled = typeof plugin?.isPipelineModuleEnabled === "function" ? plugin.isPipelineModuleEnabled("project") !== false : true;
        const uiAny: any = (plugin?.settings as any)?.uiHeaderButtons ?? {};
        const allowByUi = uiAny?.project?.archive === false ? false : true;
        if (!enabled || !allowByUi) {
          return ok({ startedAt, skipped: 1, reason: !enabled ? "MODULE_DISABLED" : "ARCHIVE_DISABLED" } as any);
        }

        const app = plugin?.app;
        if (!app) return ok({ startedAt, skipped: 1, reason: "NO_APP" } as any);

        // index dir: prefer explicit centralIndexDir, then projectRSLatteIndexDir, fallback to task panel
        const indexDir = getIndexDir();
        const store = new ProjectIndexStore(app, indexDir, getQueueDir());

        const before = await store.readIndex().catch(() => null as any);
        const beforeItems: any[] = Array.isArray((before as any)?.items) ? (before as any).items : [];
        const beforeIds = new Set<string>(beforeItems.map((it) => String((it as any)?.project_id ?? (it as any)?.projectId ?? "").trim()).filter(Boolean));

        const mgrAny: any = plugin.projectMgr as any;
        let moved = 0;
        if (typeof mgrAny?.archiveDoneAndCancelledNow === "function") {
          const quiet = ctx?.mode === "manual_archive" ? false : true;
          moved = Number(await mgrAny.archiveDoneAndCancelledNow({ quiet })) || 0;
        }

        const after = await store.readIndex().catch(() => null as any);
        const afterItems: any[] = Array.isArray((after as any)?.items) ? (after as any).items : [];
        const afterIds = new Set<string>(afterItems.map((it) => String((it as any)?.project_id ?? (it as any)?.projectId ?? "").trim()).filter(Boolean));

        const addedIds: string[] = [];
        const updatedIds: string[] = [];
        const removedIds: string[] = [];

        for (const id of afterIds) {
          if (!beforeIds.has(id)) addedIds.push(id);
        }
        for (const id of beforeIds) {
          if (!afterIds.has(id)) removedIds.push(id);
        }

        if (ctx?.runId) deltaByRunId.set(String(ctx.runId), { addedIds, updatedIds, removedIds });

        return ok({ startedAt, archivedCount: moved, applied: { addedIds, updatedIds, removedIds } } as any);
      } catch (e: any) {
        return fail("PROJECT_ARCHIVE_FAILED", "Project archiveOutOfRange failed", { message: e?.message ?? String(e) });
      }
    },

// --- db sync (P4) ---
async buildOps(ctx, applied) {
  try {
    if (!computeDbSyncEnabled()) {
      return ok({ skipped: 1 } as any);
    }

    const forceFullSync = ((applied as any)?.forceFullSync === true) || getForceFullFlag() || ctx?.mode === 'rebuild' || ctx?.phase === 'rebuild';
    if (forceFullSync && ctx?.runId) forceFullByRunId.set(String(ctx.runId), true);

    const a: any = applied ?? {};
    const delta = (a.applied ?? a.delta ?? a) as any;
    const addedIds: string[] = Array.isArray(delta?.addedIds) ? delta.addedIds.map((x: any) => String(x)) : [];
    const updatedIds: string[] = Array.isArray(delta?.updatedIds) ? delta.updatedIds.map((x: any) => String(x)) : [];
    const removedIds: string[] = Array.isArray(delta?.removedIds) ? delta.removedIds.map((x: any) => String(x)) : [];

    const ops: any[] = [];
    for (const id of [...addedIds, ...updatedIds]) ops.push({ kind: 'upsert', id });
    for (const id of removedIds) ops.push({ kind: 'delete', id });

    // BuildOps is also the "enqueue" bridge for legacy ProjectSyncQueue.
    // - rebuild: forceEnqueue=true
    // - auto/manual: forceEnqueue=false (delta-based)
    const mgrAny: any = plugin.projectMgr as any;
    if (typeof mgrAny?.persistIndexAndEnqueueSync === 'function') {
      const forceEnqueue = forceFullSync || ctx?.phase === 'rebuild' || ctx?.mode === 'rebuild';
      const mode = String(ctx?.mode ?? "");
      const isAuto = mode.startsWith("auto");
      // In auto mode do not forceDue existing ops; let the queue backoff work.
      await mgrAny.persistIndexAndEnqueueSync({ forceEnqueue, forceDue: !isAuto });
    }

    return ok({ ops, counts: { upsert: addedIds.length + updatedIds.length, delete: removedIds.length } });
  } catch (e: any) {
    return fail('PROJECT_BUILDOPS_FAILED', 'Project buildOps failed', { message: e?.message ?? String(e) });
  }
},

async flushQueue(ctx, opts: RSLatteFlushQueueOptions) {
  try {
    if (!computeDbSyncEnabled()) {
      return ok({ skipped: 1 } as any);
    }

    const forceFullSync = (ctx?.runId && forceFullByRunId.get(String(ctx.runId)) === true) || getForceFullFlag();
    const backendOk = await ensureBackendSafe();
    if (!backendOk) {
      return ok({ flushed: 0, skipped: 1 } as any, ['BACKEND_UNAVAILABLE']);
    }

    const mgrAny: any = plugin.projectMgr as any;
    // IMPORTANT:
    // ProjectManager has its own retry/backoff (next_retry_at). In auto mode we must
    // NOT force-flush the queue; otherwise retryPending/retryFailed will bypass the
    // backoff and create tight request loops when backend is down.
    const mode = String(ctx?.mode ?? "");
    const isAuto = mode.startsWith("auto");
    const force = Boolean(forceFullSync || opts?.drainAll || (!isAuto && (opts?.retryFailed || opts?.retryPending)));
    if (typeof mgrAny?.flushSyncQueue === 'function') {
      await mgrAny.flushSyncQueue({ force });
    }
    // clear one-shot force-full flag only after a successful flush
    if (ctx?.runId && forceFullByRunId.get(String(ctx.runId)) === true) {
      forceFullByRunId.delete(String(ctx.runId));
      await plugin?.consumeForceFullFlag?.("project", true);
    }
    if (!ctx?.runId && getForceFullFlag()) {
      await plugin?.consumeForceFullFlag?.("project", true);
    }

    return ok({ flushed: 1, force, forceFullSync });
  } catch (e: any) {
    return fail('PROJECT_FLUSH_FAILED', 'Project flushQueue failed', { message: e?.message ?? String(e) });
  }
},

async getReconcileGate(ctx) {
  try {
    const dbSyncEnabled = computeDbSyncEnabled();

    if (!dbSyncEnabled) {
      const gate: any = { dbSyncEnabled: false, pendingCount: 0, failedCount: 0, deltaSize: 0 };
      return ok(gate);
    }

    // Read queue counts from central index dir (json) - best-effort.
    const app = plugin?.app;
    const indexDir = getIndexDir();
    let pendingCount = 0;
    let failedCount = 0;
    if (app) {
      const store = new ProjectIndexStore(app, indexDir, getQueueDir());
      const q = await store.readQueue().catch(() => ({ ops: [] } as any));
      const ops = Array.isArray((q as any)?.ops) ? (q as any).ops : [];
      pendingCount = ops.length;
      failedCount = ops.filter((o: any) => Boolean(o?.last_error)).length;
    }

    const rid = String((ctx as any)?.runId ?? '');
    const d = rid ? deltaByRunId.get(rid) : undefined;
    const deltaSize = d ? (d.addedIds.length + d.updatedIds.length + d.removedIds.length) : 0;

    // gate2: dirty files / uid missing (best-effort)
    const dirty = rid ? dirtyByRunId.get(rid) : undefined;
    let uidMissingCount = (dirty?.uidMissingFiles?.length ?? 0);
    const parseErrorCount = (dirty?.parseErrorFiles?.length ?? 0);

    // additional safety: count missing ids from current index
    if (app) {
      const idx = await (new ProjectIndexStore(app, indexDir, getQueueDir())).readIndex().catch(() => null as any);
      const items = (idx as any)?.items ?? [];
      const miss = items.filter((it: any) => !String(it?.project_id ?? '').trim()).length;
      uidMissingCount = Math.max(uidMissingCount, miss);
    }

    const dirtyCount = uidMissingCount + parseErrorCount;

    const gate: any = {
      dbSyncEnabled: true,
      pendingCount,
      failedCount,
      deltaSize,
      uidMissingCount,
      parseErrorCount,
      dirtyCount,
    };
    return ok(gate);
  } catch (e: any) {
    const gate: any = { dbSyncEnabled: true, pendingCount: 0, failedCount: 0, deltaSize: 0 };
    return ok(gate, [`getReconcileGate failed: ${e?.message ?? String(e)}`]);
  }
},

    async reconcile(ctx, _input) {
      const startedAt = new Date().toISOString();
      try {
        const gateR = await (this as any).getReconcileGate(ctx);
        const gate = gateR?.ok ? gateR.data : ({ dbSyncEnabled: false } as any);

        // Safety: if gate says not enabled or dirty, skip.
        const pending = Number((gate as any)?.pendingCount ?? 0);
        const failed = Number((gate as any)?.failedCount ?? 0);
        const dirtyCount = Number((gate as any)?.dirtyCount ?? 0) || (Number((gate as any)?.uidMissingCount ?? 0) + Number((gate as any)?.parseErrorCount ?? 0));
        if (!(gate as any)?.dbSyncEnabled) {
          return ok(mkNoopSummary(ctx, startedAt, "DBSYNC_DISABLED", gate));
        }
        if (pending > 0 || failed > 0) {
          return ok(mkNoopSummary(ctx, startedAt, "GATE1_QUEUE_NOT_EMPTY", gate));
        }
        if (dirtyCount > 0) {
          return ok(mkNoopSummary(ctx, startedAt, "GATE2_DIRTY_FILES", gate));
        }

        const app = plugin?.app;
        const indexDir = getIndexDir();
        const presentIds: string[] = [];
        if (app) {
          const store = new ProjectIndexStore(app, indexDir, getQueueDir());
          const idx = await store.readIndex().catch(() => null as any);
          const items = (idx as any)?.items ?? [];
          for (const it of items) {
            const pid = String((it as any)?.project_id ?? '').trim();
            if (pid) presentIds.push(pid);
          }
        }

        if (!presentIds.length) {
          return ok(mkNoopSummary(ctx, startedAt, "NO_PRESENT_PROJECTS", gate));
        }

        const api = (plugin as any)?.api;
        if (!api?.projectsReconcile) {
          return ok(mkNoopSummary(ctx, startedAt, "NO_API_CLIENT", gate));
        }

        const resp: any = await apiTry("Reconcile 项目(project)", () => api.projectsReconcile({ present_project_ids: Array.from(new Set(presentIds)) }));
        return ok({
          moduleKey: ctx.moduleKey,
          mode: ctx.mode,
          op: "reconcile",
          startedAt,
          finishedAt: new Date().toISOString(),
          metrics: {
            keep: Number(resp?.keep ?? 0),
            marked_deleted: Number(resp?.marked_deleted ?? 0),
            candidates: Number(resp?.candidates ?? 0),
          },
          message: `projects_reconcile ok marked_deleted=${resp?.marked_deleted ?? 0}`,
          gate,
        } as any);
      } catch (e: any) {
        const gate: any = { dbSyncEnabled: true };
        return ok(mkNoopSummary(ctx, startedAt, `RECONCILE_FAILED:${e?.message ?? String(e)}`, gate));
      }
    },

    async stats(_ctx) {
      return ok(mkNoopStats("project"));
    },
  };
}
