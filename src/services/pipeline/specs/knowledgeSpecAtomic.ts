import { normalizePath } from "obsidian";

import type {
  ModuleSpecAtomic,
  RSLatteAtomicOpContext,
  RSLatteFlushQueueOptions,
  RSLatteModuleStats,
  RSLatteModuleOpSummary,
  RSLatteReconcileGate,
} from "../moduleSpec";
import type { RSLatteResult, RSLatteScanResult } from "../types";
import { rebuildKnowledgeIndexJson, tryReadKnowledgeIndexJson } from "../../knowledgeIndexWriter";
import { toLocalOffsetIsoString } from "../../../utils/localCalendarYmd";

function ok<T>(data: T, warnings?: string[]): RSLatteResult<T> {
  return warnings?.length ? { ok: true, data, warnings } : { ok: true, data };
}

function fail(code: string, message: string, detail?: unknown): RSLatteResult<never> {
  const error = { code, message, detail };
  return { ok: false, error };
}

function mkSummary(ctx: RSLatteAtomicOpContext, startedAt: string, message?: string, gate?: RSLatteReconcileGate): RSLatteModuleOpSummary {
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

function computeKnowledgeGateFromMeta(plugin: any, dbSyncEnabled: boolean): RSLatteReconcileGate {
  const gate: RSLatteReconcileGate = { dbSyncEnabled };
  if (!dbSyncEnabled) return gate;
  try {
    const meta: any = plugin?._dbSyncMeta?.knowledge ?? {};
    gate.pendingCount = Number(meta?.pendingCount ?? 0);
    gate.failedCount = Number(meta?.failedCount ?? 0);
    gate.deltaSize = Number(gate.pendingCount ?? 0) + Number(gate.failedCount ?? 0);
  } catch {
    /* ignore */
  }
  return gate;
}

/**
 * 知识库轻量索引：扫描 `30-Knowledge` 写入中央 `knowledge-index.json`（不按 space 分文件）。
 */
export function createKnowledgeSpecAtomic(plugin: any): ModuleSpecAtomic {
  const forceFullByRunId = new Map<string, boolean>();

  const computeDbSyncEnabled = (): boolean => {
    try {
      return plugin?.isKnowledgeDbSyncEnabled?.() === true;
    } catch {
      return false;
    }
  };

  const ensureBackendSafe = async (): Promise<boolean> => {
    try {
      const ok2 = await plugin?.vaultSvc?.ensureVaultReadySafe?.("knowledgeSpecAtomic");
      return ok2 !== false;
    } catch {
      return false;
    }
  };

  const getForceFullFlag = (): boolean => {
    try {
      return !!(plugin?.settings as any)?.dbSyncForceFullNext?.knowledge;
    } catch {
      return false;
    }
  };

  const isDebug = () => (plugin?.settings as any)?.debugLogEnabled === true;
  const dbgStart = (mode: string, step: string) => {
    if (!isDebug()) return;
    console.log(`[RSLatte][knowledge][${mode}] ${step}: start`);
  };
  const dbgEnd = (mode: string, step: string, t0: number, count?: number) => {
    if (!isDebug()) return;
    const payload: Record<string, unknown> = { costMs: Date.now() - t0 };
    if (typeof count === "number") payload.count = count;
    console.log(`[RSLatte][knowledge][${mode}] ${step}: done`, payload);
  };
  return {
    key: "knowledge" as any,
    label: "Knowledge",

    async scanFull(ctx) {
      const t0 = Date.now();
      dbgStart(String(ctx?.mode ?? "rebuild"), "scanFull");
      const r: RSLatteScanResult<string> = {
        mode: "full",
        changedFiles: [],
        addedIds: [],
        updatedIds: [],
        removedIds: [],
        meta: { scannedAt: Date.now(), reason: "KNOWLEDGE_INDEX_REBUILD" },
      };
      dbgEnd(String(ctx?.mode ?? "rebuild"), "scanFull", t0, 0);
      return ok(r);
    },

    async replaceAll(ctx, _scan) {
      const startedAt = toLocalOffsetIsoString();
      const t0 = Date.now();
      dbgStart(String(ctx?.mode ?? "rebuild"), "replaceAll");
      try {
        if (!plugin?.app) {
          dbgEnd(String(ctx?.mode ?? "rebuild"), "replaceAll", t0, 0);
          return ok({ startedAt, skipped: 1, reason: "NO_APP", forceFullSync: getForceFullFlag() } as any);
        }
        const { count } = await rebuildKnowledgeIndexJson(plugin);
        dbgEnd(String(ctx?.mode ?? "rebuild"), "replaceAll", t0, count);
        return ok({ startedAt, applied: { itemCount: count }, forceFullSync: getForceFullFlag() } as any);
      } catch (e: any) {
        return fail("KNOWLEDGE_INDEX_FAILED", "Knowledge index rebuild failed", {
          message: e?.message ?? String(e),
        });
      }
    },

    async scanIncremental(ctx) {
      const t0 = Date.now();
      dbgStart(String(ctx?.mode ?? "manual_refresh"), "scanIncremental");
      const r: RSLatteScanResult<string> = {
        mode: "inc",
        changedFiles: [],
        addedIds: [],
        updatedIds: [],
        removedIds: [],
        meta: { scannedAt: Date.now(), reason: "KNOWLEDGE_USE_REPLACEALL" },
      };
      dbgEnd(String(ctx?.mode ?? "manual_refresh"), "scanIncremental", t0, 0);
      return ok(r);
    },

    async applyDelta(_ctx, _scan) {
      const startedAt = toLocalOffsetIsoString();
      const t0 = Date.now();
      dbgStart(String(_ctx?.mode ?? "manual_refresh"), "applyDelta");
      try {
        if (!plugin?.app) {
          dbgEnd(String(_ctx?.mode ?? "manual_refresh"), "applyDelta", t0, 0);
          return ok({ startedAt, skipped: 1, reason: "NO_APP", forceFullSync: getForceFullFlag() } as any);
        }
        const { count } = await rebuildKnowledgeIndexJson(plugin);
        dbgEnd(String(_ctx?.mode ?? "manual_refresh"), "applyDelta", t0, count);
        return ok({ startedAt, applied: { itemCount: count }, forceFullSync: getForceFullFlag() } as any);
      } catch (e: any) {
        return fail("KNOWLEDGE_INDEX_FAILED", "Knowledge index manual_refresh failed", {
          message: e?.message ?? String(e),
        });
      }
    },

    async archiveOutOfRange(_ctx) {
      const startedAt = toLocalOffsetIsoString();
      return ok({ startedAt, skipped: 1, reason: "KNOWLEDGE_NO_ARCHIVE" } as any);
    },

    async buildOps(ctx, applied: any) {
      if (!computeDbSyncEnabled()) {
        return ok({ skipped: 1 } as any);
      }
      const forceFullSync = applied?.forceFullSync === true || getForceFullFlag();
      if (forceFullSync && ctx?.runId) forceFullByRunId.set(ctx.runId, true);
      const backendOk = await ensureBackendSafe();
      if (!backendOk) {
        return ok({ listsSynced: 0, skipped: 1, forceFullSync } as any, ["BACKEND_UNAVAILABLE"]);
      }
      return ok({ listsSynced: 0, forceFullSync } as any);
    },

    async flushQueue(ctx, _opts: RSLatteFlushQueueOptions) {
      if (!computeDbSyncEnabled()) {
        return ok({ skipped: 1 } as any);
      }
      const forceFullSync = (ctx?.runId && forceFullByRunId.get(ctx.runId) === true) || getForceFullFlag();
      const backendOk = await ensureBackendSafe();
      if (!backendOk) {
        return ok({ indexSynced: 0, skipped: 1 } as any, ["BACKEND_UNAVAILABLE"]);
      }
      try {
        await plugin?.syncKnowledgeIndexToDbNow?.({ reason: forceFullSync ? "manual_rebuild_knowledge" : String(ctx.mode) });
        if (ctx?.runId && forceFullByRunId.get(ctx.runId) === true) {
          forceFullByRunId.delete(ctx.runId);
          await plugin?.consumeForceFullFlag?.("knowledge", true);
        }
        if (!ctx?.runId && getForceFullFlag()) {
          await plugin?.consumeForceFullFlag?.("knowledge", true);
        }
        return ok({ indexSynced: 1 } as any);
      } catch (e: any) {
        console.warn(`[RSLatte][knowledge][${ctx.mode}] syncKnowledgeIndexToDbNow failed`, e);
        return ok({ indexSynced: 0 } as any, ["INDEX_SYNC_FAILED"]);
      }
    },

    async getReconcileGate(_ctx) {
      const dbSyncEnabled = computeDbSyncEnabled();
      const gate = computeKnowledgeGateFromMeta(plugin, dbSyncEnabled) as any;
      gate.allowReconcileWithoutDbSync = true;
      return ok(gate);
    },

    async reconcile(ctx) {
      const startedAt = toLocalOffsetIsoString();
      const dbSyncEnabled = computeDbSyncEnabled();
      const gate: RSLatteReconcileGate = {
        ...computeKnowledgeGateFromMeta(plugin, dbSyncEnabled),
        allowReconcileWithoutDbSync: true,
      };

      try {
        if (!plugin?.app) {
          return ok(mkSummary(ctx, startedAt, "NO_APP", gate));
        }
        const { count } = await rebuildKnowledgeIndexJson(plugin);

        if (dbSyncEnabled) {
          const api = (plugin as any)?.api;
          if (api?.knowledgeDocsReconcile) {
            try {
              const idx = await tryReadKnowledgeIndexJson(plugin);
              const kr = normalizePath(String(idx?.knowledgeRoot ?? ""));
              const items = idx?.items ?? [];
              const present = items.map((it: any) => normalizePath(String(it.path ?? ""))).filter(Boolean);
              if (kr || present.length > 0) {
                const reconcileResp: any = await api.knowledgeDocsReconcile({
                  knowledge_root: kr,
                  present_file_paths: present.sort(),
                  dry_run: false,
                });
                const markedDeleted = Number(reconcileResp?.marked_deleted ?? 0);
                const keep = Number(reconcileResp?.keep ?? 0);
                return ok(mkSummary(ctx, startedAt, `reconcile ok items=${count} marked_deleted=${markedDeleted} keep=${keep}`, gate));
              }
            } catch (e: any) {
              console.warn(`[RSLatte][knowledge][reconcile] knowledgeDocsReconcile failed`, e);
            }
          }
        }

        return ok(mkSummary(ctx, startedAt, `local index rebuilt items=${count}`, gate));
      } catch (e: any) {
        return fail("KNOWLEDGE_RECONCILE_FAILED", "Knowledge reconcile failed", { message: e?.message ?? String(e) });
      }
    },

    async stats(_ctx) {
      const dbSyncEnabled = computeDbSyncEnabled();
      const g = computeKnowledgeGateFromMeta(plugin, dbSyncEnabled);
      const st: RSLatteModuleStats = {
        moduleKey: "knowledge" as any,
        items: {
          pendingCount: Number((g as any)?.pendingCount ?? 0),
          failedCount: Number((g as any)?.failedCount ?? 0),
        },
      } as any;
      return ok(st);
    },
  };
}
