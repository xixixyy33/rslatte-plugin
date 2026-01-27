import type {
  ModuleSpecAtomic,
  RSLatteAtomicOpContext,
  RSLatteModuleStats,
  RSLatteModuleOpSummary,
  RSLatteReconcileGate,
} from "../moduleSpec";
import type { RSLatteResult, RSLatteError } from "../types";

function ok<T>(data: T, warnings?: string[]): RSLatteResult<T> {
  return warnings?.length ? { ok: true, data, warnings } : { ok: true, data };
}

function fail(code: string, message: string, detail?: unknown): RSLatteResult<never> {
  const error: RSLatteError = { code, message, detail };
  return { ok: false, error };
}

// Memo-only modules selector used by existing taskRSLatte E2 APIs
const MEMO_MODULES = { task: false, memo: true } as const;

function legacyCtxFromAtomic(ctx: RSLatteAtomicOpContext, op: any) {
  return {
    moduleKey: ctx.moduleKey,
    mode: ctx.mode,
    op,
    vaultId: ctx.vaultId,
    spaceId: ctx.spaceId,
    requestedAt: ctx.requestedAt,
    reason: ctx.reason,
  };
}

function mkSummary(
  ctx: any,
  startedAt: string,
  metrics?: Record<string, number>,
  message?: string,
  gate?: RSLatteReconcileGate
): RSLatteModuleOpSummary {
  return {
    moduleKey: ctx.moduleKey,
    mode: ctx.mode,
    op: ctx.op,
    startedAt,
    finishedAt: new Date().toISOString(),
    metrics,
    message,
    gate,
  } as any;
}

/**
 * Same logic as main.ts computeTaskMemoGate, but scoped to memo.
 * - dbSyncEnabled=false => return {dbSyncEnabled:false}
 * - dbSyncEnabled=true => inspect index items to compute pending/failed
 */
async function computeMemoGate(plugin: any, dbSyncEnabled: boolean): Promise<RSLatteReconcileGate> {
  const gate: RSLatteReconcileGate = { dbSyncEnabled };
  if (!dbSyncEnabled) return gate;

  try {
    const store = plugin?.taskRSLatte?.store;
    if (!store || typeof store.readIndex !== "function") return gate;

    const idx: any = await store.readIndex("memo");
    const items: any[] = (idx?.items ?? []) as any[];

    let pending = 0;
    let failed = 0;
    for (const it of items) {
      if (it?.archived) continue;
      const st = String(it?.dbSyncState ?? "").trim();
      if (st === "failed") {
        failed++;
        continue;
      }

      const itemId = it?.itemId;
      const sourceHash = String(it?.sourceHash || "");
      const last = String(it?.lastPushedHash || "");

      if (itemId == null) {
        pending++;
        continue;
      }
      if (!last || (sourceHash && last !== sourceHash)) {
        pending++;
        continue;
      }
    }

    gate.pendingCount = pending;
    gate.failedCount = failed;
    gate.deltaSize = pending + failed;
  } catch {
    // ignore
  }

  return gate;
}

export function createMemoSpecAtomic(plugin: any): ModuleSpecAtomic {
  // runId-scoped flag so we only clear dbSyncForceFullNext.memo after a successful flush
  const forceFullByRunId = new Map<string, boolean>();

  let lastDeltaSize = 0;

  const computeDbSyncEnabled = (): boolean => {
    try {
      return plugin?.isMemoDbSyncEnabledV2?.() === true;
    } catch {
      return false;
    }
  };

  const getForceFullFlag = (): boolean => {
    try {
      return !!(plugin?.settings as any)?.dbSyncForceFullNext?.memo;
    } catch {
      return false;
    }
  };

  return {
    key: "memo",
    label: "Memo",

    async scanIncremental(ctx) {
      try {
        await plugin?.taskRSLatte?.ensureReady?.();
        const fixUidAndMeta = ctx.mode !== "auto_refresh";
        const scan: any = await plugin?.taskRSLatte?.e2ScanIncremental?.(MEMO_MODULES, { fixUidAndMeta });

        const normalizedScan: any = {
          ...(scan ?? {}),
          modules: MEMO_MODULES,
          tasks: Array.isArray(scan?.tasks) ? scan.tasks : [],
          memos: Array.isArray(scan?.memos) ? scan.memos : [],
          includedFilePaths: Array.isArray(scan?.includedFilePaths) ? scan.includedFilePaths : [],
          touchedFilePaths: Array.isArray(scan?.touchedFilePaths) ? scan.touchedFilePaths : [],
          removedFilePaths: Array.isArray(scan?.removedFilePaths) ? scan.removedFilePaths : [],
          fullScan: false,
        };

        // ✅ DEBUG: 打印扫描到的文件清单
        const debugLogEnabled = (plugin?.settings as any)?.debugLogEnabled === true;
        if (debugLogEnabled && (
          (normalizedScan.includedFilePaths?.length ?? 0) > 0 ||
          (normalizedScan.touchedFilePaths?.length ?? 0) > 0 ||
          (normalizedScan.removedFilePaths?.length ?? 0) > 0
        )) {
          console.log(`[RSLatte][memo][manual_refresh] scanIncremental: Scanned files:`, {
            includedFilePaths: normalizedScan.includedFilePaths.sort(),
            touchedFilePaths: normalizedScan.touchedFilePaths?.sort() || [],
            removedFilePaths: normalizedScan.removedFilePaths?.sort() || [],
            tasksCount: normalizedScan.tasks?.length ?? 0,
            memosCount: normalizedScan.memos?.length ?? 0,
          });
        }

        lastDeltaSize = Math.min(100000, Number((normalizedScan?.tasks?.length ?? 0) + (normalizedScan?.memos?.length ?? 0)));
        return ok(normalizedScan);
      } catch (e: any) {
        return fail("MEMO_SCAN_INCREMENTAL_FAILED", "Memo scanIncremental failed", { message: e?.message ?? String(e) });
      }
    },

    async applyDelta(_ctx, scan: any) {
      try {
        await plugin?.taskRSLatte?.ensureReady?.();
        const applied: any = await plugin?.taskRSLatte?.e2ApplyScanToIndex?.(scan);
        // ✅ D3: dbSyncForceFullNext.memo => treat next run as forceFullSync even under incremental/manual
        const forceFullSync = getForceFullFlag();
        return ok({ ...(applied ?? {}), modules: MEMO_MODULES, forceFullSync });
      } catch (e: any) {
        return fail("MEMO_APPLY_DELTA_FAILED", "Memo applyDelta failed", { message: e?.message ?? String(e) });
      }
    },

    async scanFull(_ctx) {
      try {
        await plugin?.taskRSLatte?.ensureReady?.();
        const scan: any = await plugin?.taskRSLatte?.e2ScanFull?.(MEMO_MODULES);
        const normalizedScan: any = {
          ...(scan ?? {}),
          modules: MEMO_MODULES,
          tasks: Array.isArray(scan?.tasks) ? scan.tasks : [],
          memos: Array.isArray(scan?.memos) ? scan.memos : [],
          includedFilePaths: Array.isArray(scan?.includedFilePaths) ? scan.includedFilePaths : [],
          touchedFilePaths: Array.isArray(scan?.touchedFilePaths) ? scan.touchedFilePaths : [],
          removedFilePaths: Array.isArray(scan?.removedFilePaths) ? scan.removedFilePaths : [],
          fullScan: true,
        };
        
        // ✅ DEBUG: 打印扫描到的文件清单
        const debugLogEnabled = (plugin?.settings as any)?.debugLogEnabled === true;
        if (debugLogEnabled && (
          (normalizedScan.includedFilePaths?.length ?? 0) > 0 ||
          (normalizedScan.touchedFilePaths?.length ?? 0) > 0 ||
          (normalizedScan.removedFilePaths?.length ?? 0) > 0
        )) {
          console.log(`[RSLatte][memo][manual_refresh] scanFull: Scanned files:`, {
            includedFilePaths: normalizedScan.includedFilePaths.sort(),
            touchedFilePaths: normalizedScan.touchedFilePaths?.sort() || [],
            removedFilePaths: normalizedScan.removedFilePaths?.sort() || [],
            tasksCount: normalizedScan.tasks?.length ?? 0,
            memosCount: normalizedScan.memos?.length ?? 0,
          });
        }
        
        lastDeltaSize = Math.min(100000, Number((normalizedScan?.tasks?.length ?? 0) + (normalizedScan?.memos?.length ?? 0)));
        return ok(normalizedScan);
      } catch (e: any) {
        return fail("MEMO_SCAN_FULL_FAILED", "Memo scanFull failed", { message: e?.message ?? String(e) });
      }
    },

    async replaceAll(_ctx, scan: any) {
      try {
        await plugin?.taskRSLatte?.ensureReady?.();
        const applied: any = await plugin?.taskRSLatte?.e2ApplyScanToIndex?.(scan);
        return ok({ ...(applied ?? {}), modules: MEMO_MODULES, forceFullSync: true });
      } catch (e: any) {
        return fail("MEMO_REPLACE_ALL_FAILED", "Memo replaceAll failed", { message: e?.message ?? String(e) });
      }
    },

    async archiveOutOfRange(ctx) {
      const startedAt = new Date().toISOString();
      try {
        await plugin?.taskRSLatte?.ensureReady?.();
        const r: any = await plugin?.taskRSLatte?.archiveNow?.(MEMO_MODULES);
        return ok(
          mkSummary(
            legacyCtxFromAtomic(ctx, "archive"),
            startedAt,
            { archivedCount: Number(r?.archivedCount ?? 0) },
            String(r?.cutoffDate ?? "")
          )
        );
      } catch (e: any) {
        return fail("MEMO_ARCHIVE_FAILED", "Memo archiveOutOfRange failed", { message: e?.message ?? String(e) });
      }
    },

    async buildOps(ctx, applied: any) {
      try {
        await plugin?.taskRSLatte?.ensureReady?.();
        const forceFullSync = applied?.forceFullSync === true;
        if (forceFullSync && ctx?.runId) forceFullByRunId.set(ctx.runId, true);
        const r: any = await plugin?.taskRSLatte?.e2BuildOps?.(MEMO_MODULES, { forceFullSync });
        return ok(r ?? { enqueued: 0 });
      } catch (e: any) {
        return fail("MEMO_BUILD_OPS_FAILED", "Memo buildOps failed", { message: e?.message ?? String(e) });
      }
    },

    async flushQueue(ctx, opts) {
      // ✅ D3: dbSyncEnabled=false => skip (defensive; engine normally won't call)
      if (!computeDbSyncEnabled()) {
        return ok({ skipped: 1 } as any);
      }
      try {
        await plugin?.taskRSLatte?.ensureReady?.();
        const tp = plugin?.settings?.taskPanel;
        const raw = Number(tp?.upsertBatchSize ?? 50);
        const batchSize = Math.max(1, Math.min(500, Number.isFinite(raw) ? Math.floor(raw) : 50));
        const manualRetryNow = ctx.mode !== "auto_refresh" && ctx.mode !== "auto_archive";
        await plugin?.taskRSLatte?.flushQueue?.(batchSize, 10, { drainAll: !!opts?.drainAll, manualRetryNow });

        // ✅ D3: clear force-full flag only after a successful flush
        if (ctx?.runId && forceFullByRunId.get(ctx.runId) === true) {
          forceFullByRunId.delete(ctx.runId);
          await plugin?.consumeForceFullFlag?.("memo", true);
        }

        return ok({ flushed: 1 } as any);
      } catch (e: any) {
        return fail("MEMO_FLUSH_QUEUE_FAILED", "Memo flushQueue failed", { message: e?.message ?? String(e) });
      }
    },

    async getReconcileGate(_ctx) {
      const dbSyncEnabled = computeDbSyncEnabled();
      const gate = (await computeMemoGate(plugin, dbSyncEnabled)) as any;
      gate.deltaSize = Number(lastDeltaSize ?? 0);
      return ok(gate);
    },

    async reconcile(ctx, input: any) {
      const startedAt = new Date().toISOString();
      const dbSyncEnabled = computeDbSyncEnabled();
      const gate = await computeMemoGate(plugin, dbSyncEnabled);
      try {
        if (!dbSyncEnabled) {
          return ok(mkSummary(legacyCtxFromAtomic(ctx, "reconcile"), startedAt, { skipped: 1 }, "DBSYNC_DISABLED", gate));
        }
        await plugin?.taskRSLatte?.ensureReady?.();
        const scan = input?.scan ?? {};
        await plugin?.taskRSLatte?.e2ReconcileForType?.("memo", scan);
        lastDeltaSize = 0;
        return ok(mkSummary(legacyCtxFromAtomic(ctx, "reconcile"), startedAt, { reconciled: 1 }, "OK", gate));
      } catch (e: any) {
        return fail("MEMO_RECONCILE_FAILED", "Memo reconcile failed", { message: e?.message ?? String(e) });
      }
    },

    async stats(_ctx) {
      try {
        await plugin?.taskRSLatte?.ensureReady?.();
        await plugin?.taskRSLatte?.reportDbSyncCounts?.(MEMO_MODULES as any);
      } catch {
        // ignore
      }
      const gate = await computeMemoGate(plugin, computeDbSyncEnabled());
      const st: RSLatteModuleStats = {
        moduleKey: "memo",
        items: {
          pendingCount: Number((gate as any)?.pendingCount ?? 0),
          failedCount: Number((gate as any)?.failedCount ?? 0),
        },
      } as any;
      return ok(st);
    },
  };
}
