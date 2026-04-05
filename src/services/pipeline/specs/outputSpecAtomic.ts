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
import { OutputIndexStore } from "../../../outputRSLatte/indexStore";
import { apiTry } from "../../../api";
import { resolveSpaceIndexDir } from "../../space/spaceContext";
import { rebuildKnowledgeIndexJson } from "../../knowledgeIndexWriter";
import { localYmdFromInstant, toLocalOffsetIsoString } from "../../../utils/localCalendarYmd";

function ok<T>(data: T, warnings?: string[]): RSLatteResult<T> {
  return warnings?.length ? { ok: true, data, warnings } : { ok: true, data };
}

function fail(code: string, message: string, detail?: unknown): RSLatteResult<never> {
  const error: RSLatteError = { code, message, detail };
  return { ok: false, error };
}

function mkNoopStats(moduleKey: "output"): RSLatteModuleStats {
  return { moduleKey, items: {}, meta: {} } as any;
}

function mkNoopSummary(ctx: RSLatteAtomicOpContext, startedAt: string, message: string, gate?: RSLatteReconcileGate): RSLatteModuleOpSummary {
  return {
    moduleKey: ctx.moduleKey,
    mode: ctx.mode,
    op: ctx.op === "reconcile" ? "reconcile" : "stats",
    startedAt,
    finishedAt: toLocalOffsetIsoString(),
    metrics: { noop: 1 },
    message,
    gate,
  } as any;
}

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
  if (Array.isArray(tags)) return tags.map((x) => String(x).trim()).filter(Boolean);
  if (typeof tags === "string") {
    return tags
      .split(/[\s,，]+/)
      .map((x) => x.replace(/^#/, "").trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeDomains(v: any): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") return v.split(/[,，]+/).map((x) => x.trim()).filter(Boolean);
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

async function buildOutputIndexItem(app: any, file: TFile): Promise<any | null> {
  try {
    const cache = app?.metadataCache?.getFileCache?.(file);
    const fm = cache?.frontmatter ?? ({} as any);

    const outputId = (fm?.output_id ? String(fm.output_id).trim() : "") || undefined;
    const title = file.basename;
    const status = (fm?.status ? String(fm.status).trim() : "") || "todo";
    const type = fm?.type ? String(fm.type).trim() : undefined;
    const docCategory = fm?.["文档分类"] ? String(fm["文档分类"]).trim() : undefined;

    const tags = normalizeTags(fm?.tags);
    const domains = normalizeDomains(fm?.["领域"] ?? fm?.domains ?? fm?.domain);

    const createDate = toIsoDate(fm?.create ?? fm?.created ?? fm?.created_date) ?? toDayKeyFromMs(file.stat?.ctime) ?? undefined;

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
      (toIsoDate(fm?.done_date ?? fm?.completed_date)
        ? toLocalOffsetIsoString(
            new Date(String(toIsoDate(fm?.done_date ?? fm?.completed_date)) + "T00:00:00"),
          )
        : undefined);

    const doneDate = doneTime
      ? localYmdFromInstant(doneTime) ?? toIsoDate(doneTime)
      : toIsoDate(fm?.done ?? fm?.done_date ?? fm?.completed ?? fm?.completed_date);

    let cancelledTime = toIsoDateTime(
      fm?.cancelled_time ??
        fm?.cancelled ??
        fm?.cancel_time ??
        fm?.deleted_time ??
        fm?.delete_time ??
        fm?.deleted_at ??
        fm?.delete_at
    );
    let cancelledDate = toIsoDate(fm?.cancelled ?? fm?.cancelled_date ?? fm?.cancel_date ?? fm?.deleted_date ?? fm?.delete_date);

    if (!cancelledTime && String(status) === "cancelled") {
      const ms = file.stat?.mtime;
      if (ms && Number.isFinite(ms)) cancelledTime = toLocalOffsetIsoString(new Date(ms));
    }
    if (!cancelledDate && cancelledTime) {
      cancelledDate = localYmdFromInstant(cancelledTime) ?? toIsoDate(cancelledTime) ?? undefined;
    }

    return {
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
  } catch {
    return null;
  }
}

/**
 * Output ModuleSpecAtomic.
 *
 * ## §8.1 语义标签
 *
 * - **`rebuildActiveOnly`**：`replaceAll` → **`refreshIndexNow({ mode: "full" })`**；扩展是否遍历旧物理归档树由 **`outputPanel.fullRebuildScanLegacyArchiveDirs`** 控制（见 `outputRSLatte`）。
 * - **`rebuildAfterPhysicalArchive`**：`archiveOutOfRange` → **`archiveOutputFilesNow`**（搬迁）后索引与台账由 **`outputRSLatte` / 管线** 后续步骤对齐（含 **`archiveIndexForArchivedFiles`** 等，与实现一致）。
 * - **`scanFull`**：用于门控/差分的文件枚举**可能**含 `archiveRoots`、`done` 归档根、`cancelledArchiveDirs` 等，与上项 **`replaceAll` 的 I/O 范围**不必逐文件一致；以 `refreshIndexNow` 为准。
 *
 * ## §8.4 台账与扫描集合（单一说明入口）
 *
 * - **`types/outputTypes.ts` 文件头**：`archiveRoots` / `fullRebuildScanLegacyArchiveDirs` / `.history/output-ledger.json` 分工与执行顺序。
 * - **`outputRefreshScanPlan.ts`**：`buildOutputRefreshScanPlan`、`mergeOutputPrimaryScanRoots`（与 `refreshIndexNow` 对齐）。
 * - **《索引优化方案》§10.6**：索引归档与时间窗、台账事件类型。
 *
 * 登记：`PIPELINE_ATOMIC_REBUILD_SCOPE_REGISTRY.output`（`rebuildScopeSemantics.ts`）。
 */
export function createOutputSpecAtomic(plugin: any): ModuleSpecAtomic {

// runId-scoped delta snapshot (used for gate.deltaSize)
const deltaByRunId = new Map<string, { addedIds: string[]; updatedIds: string[]; removedIds: string[] }>();

// runId-scoped dirty scan snapshot (used for gate2)
const dirtyByRunId = new Map<string, { uidMissingFiles: string[]; parseErrorFiles: string[] }>();

// runId-scoped flag so we only clear dbSyncForceFullNext.output after a successful flush
const forceFullByRunId = new Map<string, boolean>();

const isUrlCheckable = (): boolean => {
  try {
    const apiBaseUrl = String((plugin?.settings as any)?.apiBaseUrl ?? "").trim();
    if (!apiBaseUrl) return false;
    const lower = apiBaseUrl.toLowerCase();
    if (!(lower.startsWith("http://") || lower.startsWith("https://"))) return false;
    // eslint-disable-next-line no-new
    new URL(apiBaseUrl);
    return true;
  } catch {
    return false;
  }
};

const shouldForceFullNext = (): boolean => {
  try {
    return !!(plugin?.settings as any)?.dbSyncForceFullNext?.output;
  } catch {
    return false;
  }
};



const isDbSyncEnabled = (): boolean => {
  try {
    const enabled = typeof plugin?.isPipelineModuleEnabled === 'function' ? plugin.isPipelineModuleEnabled('output') !== false : true;
    if (!enabled) return false;

    if (!isUrlCheckable()) return false;

    const op: any = (plugin?.settings as any)?.outputPanel ?? {};
    const v = op.enableDbSync;
    const on = v === undefined ? false : Boolean(v);
    return Boolean(on);
  } catch {
    return false;
  }
};


const readSyncCounts = async (): Promise<{ pendingCount: number; failedCount: number }> => {
  try {
    await plugin.outputRSLatte?.ensureReady?.();
    const st: any = await plugin.outputRSLatte?.readSyncState?.().catch(() => ({ byId: {} } as any));
    const byId = (st as any)?.byId ?? {};
    const states = Object.values(byId);
    const failedCount = states.filter((s: any) => s?.dbSyncState === 'failed').length;
    const pendingCount = states.filter((s: any) => !s || !s.dbSyncState || s.dbSyncState === 'pending').length;
    return { pendingCount, failedCount };
  } catch {
    return { pendingCount: 0, failedCount: 0 };
  }
};

  return {
    key: "output",
    label: "Output",

    // --- incremental scan (P2) ---
    async scanIncremental(ctx) {
      try {
        const app = plugin?.app;
        const settings = plugin?.settings;
        const op = settings?.outputPanel;

        const scanRoots: string[] = Array.isArray(op?.archiveRoots) ? op.archiveRoots : [];
        const roots = scanRoots.map((x) => normalizePath(String(x ?? "").trim())).filter(Boolean);

        if (!app || roots.length === 0) {
          const r: RSLatteScanResult<string> = {
            mode: "inc",
            changedFiles: [],
            addedIds: [],
            updatedIds: [],
            removedIds: [],
            meta: { scannedAt: Date.now(), reason: !app ? "NO_APP" : "NO_OUTPUT_ROOTS" },
          };
          return ok(r);
        }

        const indexDir = resolveSpaceIndexDir(settings as any, undefined, [op?.rslatteIndexDir]);
        const store = new OutputIndexStore(app, indexDir);
        const prev = await store.readIndex();
        const prevItems = prev?.items ?? [];

        const prevByPath = new Map<string, any>();
        for (const it of prevItems) {
          const p = normalizePath(String((it as any)?.filePath ?? (it as any)?.file_path ?? "").trim());
          if (p) prevByPath.set(p, it);
        }

        const changedFiles = new Set<string>();
        const addedIds = new Set<string>();
        const updatedIds = new Set<string>();
        const removedIds = new Set<string>();

        // Gate2: dirty files tracking (uidMissing / parseError)
        const uidMissingFiles = new Set<string>();
        const parseErrorFiles = new Set<string>();

        const walkMdFiles = async (folder: TFolder, opts?: { skipArchivedChildren?: boolean; doneArchiveRoot?: string }) => {
          for (const ch of folder.children) {
            if (ch instanceof TFolder) {
              if (opts?.skipArchivedChildren) {
                if (ch.name === "_archived") continue;
                const doneRoot = normalizePath(String(opts?.doneArchiveRoot ?? "").trim()).replace(/\/+$/g, "");
                const p = normalizePath(ch.path);
                if (doneRoot && (p === doneRoot || p.startsWith(doneRoot + "/"))) continue;
              }
              await walkMdFiles(ch, opts);
            } else if (ch instanceof TFile) {
              if (ch.extension.toLowerCase() !== "md") continue;
              yieldFile(ch);
            }
          }
        };

        const files: TFile[] = [];
        const yieldFile = (f: TFile) => {
          files.push(f);
        };

        const doneArchiveRoot = normalizePath(String(op?.archiveRootDir ?? "99-Archive").trim() || "99-Archive");

        // incremental: scan active roots only (skip archived children to avoid duplicates)
        for (const r of roots) {
          const af = app.vault.getAbstractFileByPath(r);
          if (af instanceof TFolder) await walkMdFiles(af, { skipArchivedChildren: true, doneArchiveRoot });
          else if (af instanceof TFile) {
            if (af.extension.toLowerCase() === "md") yieldFile(af);
          }
        }

        const curPathSet = new Set<string>();
        const getIdFor = async (file: TFile, prevIt?: any): Promise<string> => {
          const prevId = String((prevIt as any)?.outputId ?? (prevIt as any)?.output_id ?? "").trim();
          if (prevId) return prevId;
          try {
            const fm = await readFrontmatter(app, file);
            const id = String((fm as any)?.output_id ?? (fm as any)?.outputId ?? "").trim();
            if (!id) uidMissingFiles.add(file.path);
            return id || `path:${file.path}`;
          } catch {
            parseErrorFiles.add(file.path);
            return `path:${file.path}`;
          }
        };

        for (const f of files) {
          const p = normalizePath(f.path);
          curPathSet.add(p);
          const prevIt = prevByPath.get(p);
          if (!prevIt) {
            const id = await getIdFor(f);
            addedIds.add(id);
            changedFiles.add(p);
            continue;
          }
          const prevM = Number((prevIt as any)?.mtimeMs ?? (prevIt as any)?.mtime_ms ?? 0);
          const curM = Number(f.stat?.mtime ?? 0);
          if (prevM !== curM) {
            const id = await getIdFor(f, prevIt);
            updatedIds.add(id);
            changedFiles.add(p);
          }
        }

        // removed: prev items whose filePath no longer exists
        for (const it of prevItems) {
          const p = normalizePath(String((it as any)?.filePath ?? (it as any)?.file_path ?? "").trim());
          if (!p) continue;
          if (curPathSet.has(p)) continue;
          const id = String((it as any)?.outputId ?? (it as any)?.output_id ?? "").trim() || `path:${p}`;
          removedIds.add(id);
          changedFiles.add(p);
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
          console.log(`[RSLatte][output][manual_refresh] scanIncremental: Scanned files:`, {
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
    async applyDelta(_ctx, scan) {
      const startedAt = toLocalOffsetIsoString();
      try {
        const app = plugin?.app;
        const settings = plugin?.settings;
        const op = settings?.outputPanel;

        const s = (scan ?? {}) as RSLatteScanResult<string>;
        const changedFiles: string[] = Array.isArray((s as any).changedFiles) ? (s as any).changedFiles : [];

        if (!app || changedFiles.length === 0) {
          return ok({ startedAt, applied: { changed: 0, removed: 0 } });
        }

        // Keep index dir resolution aligned with OutputRSLatteService (F2: space bucketing).
        const indexDir = resolveSpaceIndexDir(settings as any, undefined, [op?.rslatteIndexDir]);
        const store = new OutputIndexStore(app, indexDir);
        await store.ensureLayout();

        const prev = await store.readIndex();
        const prevItems = (prev?.items ?? []) as any[];
        // ✅ 构建旧快照映射，用于检测文件修改时间变化
        const prevItemsByPath = new Map<string, any>();
        const byPath = new Map<string, any>();
        for (const it of prevItems) {
          const p = normalizePath(String((it as any)?.filePath ?? (it as any)?.file_path ?? "").trim());
          if (p) {
            prevItemsByPath.set(p, it);
            byPath.set(p, it);
          }
        }

        let removed = 0;
        let touched = 0;

        for (const fp of changedFiles) {
          const p = normalizePath(String(fp ?? "").trim());
          if (!p) continue;
          const af = app.vault.getAbstractFileByPath(p);
          if (af instanceof TFile && af.extension.toLowerCase() === "md") {
            const it = await buildOutputIndexItem(app, af);
            if (it) {
              byPath.set(p, it);
              touched++;
            }
          } else {
            if (byPath.delete(p)) removed++;
          }
        }

        const next = {
          version: Number((prev as any)?.version ?? 2),
          updatedAt: toLocalOffsetIsoString(),
          items: Array.from(byPath.values()),
          cancelledArchiveDirs: Array.isArray((prev as any)?.cancelledArchiveDirs) ? (prev as any).cancelledArchiveDirs : [],
        };
        await store.writeIndex(next as any);

        // Best-effort: refresh in-memory snapshot so side panel sees changes immediately.
        const ledAny: any = plugin.outputRSLatte as any;
        if (ledAny) {
          ledAny.snapshot = next;
        }
        // Best-effort: refresh UI if plugin exposes a hook.
        try {
          plugin.refreshSidePanel?.();
        } catch {
          // ignore
        }

        // ✅ 检测文件修改时间变化，写入 WorkEvent（与 refreshIndexNow 中的逻辑一致）
        // 一个文件一天只记录一次更新
        const workEventSvc = plugin?.workEventSvc;
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
          // 检查所有更新的文件
          for (const [filePath, newItem] of byPath.entries()) {
            const prevItem = prevItemsByPath.get(filePath);
            if (prevItem) {
              const prevMtime = prevItem.mtimeMs ?? 0;
              const newMtime = newItem.mtimeMs ?? 0;
              
              // 如果 mtime 变化了，且新 mtime 是今天，写入 WorkEvent
              if (newMtime > prevMtime && newMtime >= todayStart.getTime() && newMtime <= todayEnd.getTime()) {
                // ✅ 检查今天是否已经有 update 事件：一个文件一天只记录一次更新
                if (!todayUpdateEventsByPath.has(filePath)) {
                  // 获取文件信息用于 WorkEvent
                  const file = app.vault.getAbstractFileByPath(filePath);
                  if (file instanceof TFile) {
                    // append 方法会自动处理时间戳转换，直接传入 ISO 字符串即可
                    void workEventSvc.append({
                      ts: toLocalOffsetIsoString(new Date(newMtime)),
                      kind: "output",
                      action: "update",
                      source: "auto",
                      ref: {
                        file_path: filePath,
                        output_id: newItem.outputId,
                        status: newItem.status,
                        docCategory: newItem.docCategory,
                        type: newItem.type,
                        domains: newItem.domains,
                      },
                      summary: `📝 输出文件更新 ${newItem.title || filePath}`,
                    });
                  }
                }
              }
            }
          }
        }

        // ✅ 在索引更新完成后，尝试写入日记（无论是否启用数据库同步，内部会检查规则是否启用）
        try {
          await (plugin as any).writeTodayOutputProgressToJournalFromIndex?.();
        } catch (e: any) {
          // 日记写入失败不应影响索引更新，只记录警告
          console.warn("[rslatte] writeTodayOutputProgressToJournalFromIndex failed in applyDelta", e);
        }

        const addedIds: string[] = Array.isArray((s as any).addedIds) ? (s as any).addedIds.map((x: any) => String(x)) : [];
        const updatedIds: string[] = Array.isArray((s as any).updatedIds) ? (s as any).updatedIds.map((x: any) => String(x)) : [];
        const removedIds: string[] = Array.isArray((s as any).removedIds) ? (s as any).removedIds.map((x: any) => String(x)) : [];

        return ok({ startedAt, applied: { changed: touched, removed, addedIds, updatedIds, removedIds } });
      } catch (e: any) {
        return ok({ startedAt, applied: { changed: 0, removed: 0 } }, [`applyDelta failed: ${e?.message ?? String(e)}`]);
      }
    },

    // --- rebuild scan (P2)：差分元数据；范围见文件头 §8.1（与 `replaceAll`→`refreshIndexNow` 可不完全一致）---
    async scanFull(ctx) {
      try {
        const app = plugin?.app;
        const settings = plugin?.settings;
        const op = settings?.outputPanel;
        const scanRoots: string[] = Array.isArray(op?.archiveRoots) ? op.archiveRoots : [];
        const roots = scanRoots.map((x) => normalizePath(String(x ?? "").trim())).filter(Boolean);

        if (!app || roots.length === 0) {
          const r: RSLatteScanResult<string> = {
            mode: "full",
            changedFiles: [],
            addedIds: [],
            updatedIds: [],
            removedIds: [],
            meta: { scannedAt: Date.now(), reason: !app ? "NO_APP" : "NO_OUTPUT_ROOTS" },
          };
          return ok(r);
        }

        // F2: bucket by space -> index lives under <centralRoot>/<spaceId>/index
        const indexDir = resolveSpaceIndexDir(settings as any, undefined, [op?.rslatteIndexDir]);
        const store = new OutputIndexStore(app, indexDir);
        const prev = await store.readIndex();
        const prevItems = prev?.items ?? [];
        const prevById = new Map<string, any>();
        const prevByPath = new Map<string, any>();
        for (const it of prevItems) {
          const id = String((it as any)?.outputId ?? (it as any)?.output_id ?? "").trim() || "";
          const p = normalizePath(String((it as any)?.filePath ?? (it as any)?.file_path ?? "").trim());
          if (id) prevById.set(id, it);
          if (p) prevByPath.set(p, it);
        }

        const changedFiles = new Set<string>();
        const addedIds = new Set<string>();
        const updatedIds = new Set<string>();
        const removedIds = new Set<string>();

        // Gate2: dirty files tracking (uidMissing / parseError)
        const uidMissingFiles = new Set<string>();
        const parseErrorFiles = new Set<string>();

        const files: TFile[] = [];
        const yieldFile = (f: TFile) => files.push(f);

        const doneArchiveRoot = normalizePath(String(op?.archiveRootDir ?? "99-Archive").trim() || "99-Archive");

        const walkMdFiles = async (folder: TFolder, opts?: { skipArchivedChildren?: boolean }) => {
          for (const ch of folder.children) {
            if (ch instanceof TFolder) {
              if (opts?.skipArchivedChildren) {
                if (ch.name === "_archived") continue;
                const p = normalizePath(ch.path);
                if (doneArchiveRoot && (p === doneArchiveRoot || p.startsWith(doneArchiveRoot + "/"))) continue;
              }
              await walkMdFiles(ch, opts);
            } else if (ch instanceof TFile) {
              if (ch.extension.toLowerCase() !== "md") continue;
              yieldFile(ch);
            }
          }
        };

        // 1) active roots
        for (const r of roots) {
          const af = app.vault.getAbstractFileByPath(r);
          if (af instanceof TFolder) await walkMdFiles(af, { skipArchivedChildren: true });
          else if (af instanceof TFile) {
            if (af.extension.toLowerCase() === "md") yieldFile(af);
          }
        }

        // 2) cancelledArchiveDirs cache (best-effort)
        const cancelledDirs: string[] = Array.isArray((prev as any)?.cancelledArchiveDirs) ? (prev as any).cancelledArchiveDirs : [];
        for (const d of cancelledDirs) {
          const p = normalizePath(String(d ?? "").trim());
          if (!p) continue;
          const af = app.vault.getAbstractFileByPath(p);
          if (af instanceof TFolder) await walkMdFiles(af, { skipArchivedChildren: false });
        }

        // 3) done archive root
        if (doneArchiveRoot) {
          const af = app.vault.getAbstractFileByPath(doneArchiveRoot);
          if (af instanceof TFolder) await walkMdFiles(af, { skipArchivedChildren: false });
        }

        const curIds = new Set<string>();
        const curPaths = new Set<string>();

        const getIdFor = async (file: TFile, prevIt?: any): Promise<string> => {
          const prevId = String((prevIt as any)?.outputId ?? (prevIt as any)?.output_id ?? "").trim();
          if (prevId) return prevId;
          try {
            const fm = await readFrontmatter(app, file);
            const id = String((fm as any)?.output_id ?? (fm as any)?.outputId ?? "").trim();
            if (!id) uidMissingFiles.add(file.path);
            return id || `path:${file.path}`;
          } catch {
            parseErrorFiles.add(file.path);
            return `path:${file.path}`;
          }
        };

        for (const f of files) {
          const p = normalizePath(f.path);
          curPaths.add(p);
          changedFiles.add(p);
          const prevIt = prevByPath.get(p);
          const id = await getIdFor(f, prevIt);
          curIds.add(id);

          if (!prevIt) {
            addedIds.add(id);
            continue;
          }

          const prevM = Number((prevIt as any)?.mtimeMs ?? (prevIt as any)?.mtime_ms ?? 0);
          const curM = Number(f.stat?.mtime ?? 0);
          if (prevM !== curM) updatedIds.add(id);
        }

        // removed ids: based on prev index (id) if path no longer exists
        for (const it of prevItems) {
          const p = normalizePath(String((it as any)?.filePath ?? (it as any)?.file_path ?? "").trim());
          if (!p) continue;
          if (curPaths.has(p)) continue;
          const id = String((it as any)?.outputId ?? (it as any)?.output_id ?? "").trim() || `path:${p}`;
          removedIds.add(id);
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
          console.log(`[RSLatte][output][manual_refresh] scanFull: Scanned files:`, {
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
  const startedAt = toLocalOffsetIsoString();
  try {
    // §8.1 `rebuildActiveOnly`：`refreshIndexNow(full)` + fullRebuildScanLegacyArchiveDirs
    const okRun = await plugin.runOutputManualOp?.("重建", async () => {
      await plugin.outputRSLatte?.ensureReady?.();
      await plugin.outputRSLatte?.refreshIndexNow?.({ mode: "full" });

      // P4: DB sync moved to buildOps/flushQueue.
      // ✅ 无论是否启用数据库同步，都尝试写入日记（内部会检查规则是否启用）
      try {
        await (plugin as any).writeTodayOutputProgressToJournalFromIndex?.();
      } catch (e: any) {
        console.warn("[rslatte] writeTodayOutputProgressToJournalFromIndex failed in replaceAll", e);
      }

      try {
        await rebuildKnowledgeIndexJson(plugin);
      } catch (e: any) {
        console.warn("[rslatte] rebuildKnowledgeIndexJson after output replaceAll failed", e);
      }
    });

    if (okRun === false) {
      return ok({ rebuilt: 0, skippedByPluginGuard: 1, startedAt });
    }

    const s = (scan ?? {}) as any;
    const addedIds = Array.isArray(s.addedIds) ? s.addedIds.map((x: any) => String(x)) : [];
    const updatedIds = Array.isArray(s.updatedIds) ? s.updatedIds.map((x: any) => String(x)) : [];
    const removedIds = Array.isArray(s.removedIds) ? s.removedIds.map((x: any) => String(x)) : [];

    if (ctx?.runId) deltaByRunId.set(String(ctx.runId), { addedIds, updatedIds, removedIds });

    return ok({ startedAt, applied: { addedIds, updatedIds, removedIds } });
  } catch (e: any) {
    return fail("OUTPUT_REBUILD_FAILED", "Output rebuild failed", { message: e?.message ?? String(e) });
  }
},

    // --- archive (P6) — §8.1 `rebuildAfterPhysicalArchive`：物理搬迁 + 索引/台账对齐（见 outputRSLatte / pipelineManager）---
    async archiveOutOfRange(ctx) {
      const startedAt = toLocalOffsetIsoString();
      try {
        const enabled = typeof plugin?.isPipelineModuleEnabled === "function" ? plugin.isPipelineModuleEnabled("output") !== false : true;
        const uiAny: any = (plugin?.settings as any)?.uiHeaderButtons ?? {};
        const allowByUi = uiAny?.output?.archive === false ? false : true;
        if (!enabled || !allowByUi) {
          return ok({ startedAt, skipped: 1, reason: !enabled ? "MODULE_DISABLED" : "ARCHIVE_DISABLED" } as any);
        }

        const app = plugin?.app;
        const settings: any = plugin?.settings as any;
        const op: any = settings?.outputPanel ?? {};
        if (!app) return ok({ startedAt, skipped: 1, reason: "NO_APP" } as any);

        const indexDir = resolveSpaceIndexDir(settings as any, undefined, [op?.rslatteIndexDir]);
        const store = new OutputIndexStore(app, indexDir);

        const before = await store.readIndex().catch(() => null as any);
        const beforeItems: any[] = Array.isArray((before as any)?.items) ? (before as any).items : [];
        const beforeById = new Map<string, any>();
        for (const it of beforeItems) {
          const id = String((it as any)?.outputId ?? (it as any)?.output_id ?? "").trim();
          if (id) beforeById.set(id, it);
        }

        // Run legacy archive implementation (moves DONE/CANCELLED beyond threshold)
        let moved = 0;
        const reason = ctx?.mode === "auto_archive" ? "auto_archive" : (ctx?.mode === "manual_archive" ? "manual_archive" : (ctx?.mode === "rebuild" ? "rebuild" : "manual_refresh"));
        if (typeof (plugin as any)?.archiveOutputFilesNow === "function") {
          moved = Number(await (plugin as any).archiveOutputFilesNow({ reason })) || 0;
        }

        // Re-read index after moves
        const after = await store.readIndex().catch(() => null as any);
        const afterItems: any[] = Array.isArray((after as any)?.items) ? (after as any).items : [];
        const afterById = new Map<string, any>();
        for (const it of afterItems) {
          const id = String((it as any)?.outputId ?? (it as any)?.output_id ?? "").trim();
          if (id) afterById.set(id, it);
        }

        const addedIds: string[] = [];
        const updatedIds: string[] = [];
        const removedIds: string[] = [];

        for (const [id, it] of afterById.entries()) {
          const prev = beforeById.get(id);
          if (!prev) {
            addedIds.push(id);
            continue;
          }
          const p0 = String((prev as any)?.filePath ?? (prev as any)?.file_path ?? "").trim();
          const p1 = String((it as any)?.filePath ?? (it as any)?.file_path ?? "").trim();
          const m0 = Number((prev as any)?.mtimeMs ?? (prev as any)?.mtime_ms ?? 0);
          const m1 = Number((it as any)?.mtimeMs ?? (it as any)?.mtime_ms ?? 0);
          if (p0 !== p1 || m0 !== m1) updatedIds.push(id);
        }
        for (const [id] of beforeById.entries()) {
          if (!afterById.has(id)) removedIds.push(id);
        }

        if (ctx?.runId) deltaByRunId.set(String(ctx.runId), { addedIds, updatedIds, removedIds });

        return ok({ startedAt, archivedCount: moved, applied: { addedIds, updatedIds, removedIds } } as any);
      } catch (e: any) {
        return fail("OUTPUT_ARCHIVE_FAILED", "Output archiveOutOfRange failed", { message: e?.message ?? String(e) });
      }
    },

// --- db sync (P4) ---
async buildOps(_ctx, applied) {
  try {
    const a: any = applied ?? {};
    const delta = (a.applied ?? a.delta ?? a) as any;
    const addedIds: string[] = Array.isArray(delta?.addedIds) ? delta.addedIds.map((x: any) => String(x)) : [];
    const updatedIds: string[] = Array.isArray(delta?.updatedIds) ? delta.updatedIds.map((x: any) => String(x)) : [];
    const removedIds: string[] = Array.isArray(delta?.removedIds) ? delta.removedIds.map((x: any) => String(x)) : [];

    const ops: any[] = [];
    for (const id of [...addedIds, ...updatedIds]) ops.push({ kind: 'upsert', id });
    for (const id of removedIds) ops.push({ kind: 'delete', id });

    return ok({ ops, counts: { upsert: addedIds.length + updatedIds.length, delete: removedIds.length } });
  } catch (e: any) {
    return fail('OUTPUT_BUILDOPS_FAILED', 'Output buildOps failed', { message: e?.message ?? String(e) });
  }
},

async flushQueue(ctx, opts: RSLatteFlushQueueOptions) {
  try {
    const enabledDb = isDbSyncEnabled();
    if (!enabledDb) return ok({ flushed: 0, skipped: 1, reason: 'DBSYNC_DISABLED' });

    // Determine whether we should attempt a sync in this cycle.
    // - rebuild: always (drainAll)
    // - incremental: if there are any deltas OR retry is requested OR there are pending/failed
    const rid = String((ctx as any)?.runId ?? '');
    const d = rid ? deltaByRunId.get(rid) : undefined;
    const deltaSize = d ? (d.addedIds.length + d.updatedIds.length + d.removedIds.length) : 0;

    // Engine passes retry flags as true by default. We only sync when:
    // - rebuild (drainAll)
    // - there is real delta in this run
    // - there are pending/failed from last sync
    const forceFull = shouldForceFullNext();
    if (forceFull && rid) forceFullByRunId.set(rid, true);

    let should = Boolean(opts?.drainAll) || deltaSize > 0 || forceFull;

    const { pendingCount, failedCount } = await readSyncCounts();
    if (pendingCount > 0 || failedCount > 0) should = true;

    if (!should) return ok({ flushed: 0, skipped: 1, reason: 'NO_DELTA' });

    const reason = ctx?.phase === 'rebuild' || ctx?.mode === 'rebuild' ? 'rebuild' : (ctx?.mode?.startsWith('auto') ? 'auto_timer' : 'manual_refresh');
    await (plugin as any).syncOutputFilesToDb?.({ reason });

    // clear one-shot forceFull flag after a successful sync
    if (rid && forceFullByRunId.get(rid)) {
      forceFullByRunId.delete(rid);
      await plugin?.consumeForceFullFlag?.("output", true);
    }

    return ok({ flushed: 1, reason });
  } catch (e: any) {
    return fail('OUTPUT_FLUSH_FAILED', 'Output flushQueue failed', { message: e?.message ?? String(e) });
  }
},

async getReconcileGate(ctx) {
  try {
    const dbSyncEnabled = isDbSyncEnabled();

    if (!dbSyncEnabled) {
      const gate: any = { dbSyncEnabled: false, pendingCount: 0, failedCount: 0, deltaSize: 0 };
      return ok(gate);
    }

    await plugin.outputRSLatte?.ensureReady?.();
    const st = await plugin.outputRSLatte?.readSyncState?.().catch(() => ({ byId: {} } as any));
    const byId = (st as any)?.byId ?? {};
    const states = Object.values(byId);
    const failedCount = states.filter((x: any) => x?.dbSyncState === 'failed').length;
    const pendingCount = states.filter((x: any) => !x?.dbSyncState || x?.dbSyncState === 'pending').length;

    const rid = String((ctx as any)?.runId ?? '');
    const d = rid ? deltaByRunId.get(rid) : undefined;
    const deltaSize = d ? (d.addedIds.length + d.updatedIds.length + d.removedIds.length) : 0;

    // gate2: dirty files / uid missing (best-effort)
    const dirty = rid ? dirtyByRunId.get(rid) : undefined;
    let uidMissingCount = (dirty?.uidMissingFiles?.length ?? 0);
    const parseErrorCount = (dirty?.parseErrorFiles?.length ?? 0);

    // additional safety: count missing ids from current index
    const app = plugin?.app;
    const settings = plugin?.settings;
    const op2 = settings?.outputPanel as any;
    const indexDir = resolveSpaceIndexDir(settings as any, undefined, [op2?.rslatteIndexDir]);
    if (app) {
      const store = new OutputIndexStore(app, indexDir);
      const idx = await store.readIndex().catch(() => null as any);
      const items = (idx as any)?.items ?? [];
      const miss = items.filter((it: any) => !String((it as any)?.outputId ?? (it as any)?.output_id ?? '').trim()).length;
      uidMissingCount = Math.max(uidMissingCount, miss);
    }

    const dirtyCount = uidMissingCount + parseErrorCount;

    const gate: any = { dbSyncEnabled: true, pendingCount, failedCount, deltaSize, uidMissingCount, parseErrorCount, dirtyCount };
    return ok(gate);
  } catch (e: any) {
    const gate: any = { dbSyncEnabled: true, pendingCount: 0, failedCount: 0, deltaSize: 0 };
    return ok(gate, [`getReconcileGate failed: ${e?.message ?? String(e)}`]);
  }
},

    async reconcile(ctx, _input) {
      const startedAt = toLocalOffsetIsoString();
      try {
        const gateR = await (this as any).getReconcileGate(ctx);
        const gate = gateR?.ok ? gateR.data : ({ dbSyncEnabled: false } as any);

        // Safety: if gate says not enabled/queue not empty/dirty, skip.
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
        const settings = plugin?.settings;
        const op = settings?.outputPanel as any;
        const indexDir = resolveSpaceIndexDir(settings as any, undefined, [op?.rslatteIndexDir]);

        const scopePaths: string[] = [];
        if (app) {
          const store = new OutputIndexStore(app, indexDir);
          const idx = await store.readIndex().catch(() => null as any);
          const items = (idx as any)?.items ?? [];
          for (const it of items) {
            const p = normalizePath(String((it as any)?.filePath ?? (it as any)?.file_path ?? '').trim());
            if (p) scopePaths.push(p);
          }
        }

        if (!scopePaths.length) {
          return ok(mkNoopSummary(ctx, startedAt, "NO_SCOPE_OUTPUT_FILES", gate));
        }

        const api = (plugin as any)?.api;
        if (!api?.outputFilesReconcile) {
          return ok(mkNoopSummary(ctx, startedAt, "NO_API_CLIENT", gate));
        }

        const uniq = Array.from(new Set(scopePaths));
        const resp: any = await apiTry("Reconcile 输出(output)", () => api.outputFilesReconcile({ scope_file_paths: uniq }));
        return ok({
          moduleKey: ctx.moduleKey,
          mode: ctx.mode,
          op: "reconcile",
          startedAt,
          finishedAt: toLocalOffsetIsoString(),
          metrics: {
            keep_paths: Number(resp?.keep_paths ?? 0),
            marked_deleted: Number(resp?.marked_deleted ?? 0),
            candidates: Number(resp?.candidates ?? 0),
          },
          message: `output_files_reconcile ok marked_deleted=${resp?.marked_deleted ?? 0}`,
          gate,
        } as any);
      } catch (e: any) {
        const gate: any = { dbSyncEnabled: true };
        return ok(mkNoopSummary(ctx, startedAt, `RECONCILE_FAILED:${e?.message ?? String(e)}`, gate));
      }
    },

    async stats(_ctx) {
      return ok(mkNoopStats("output"));
    },
  };
}
