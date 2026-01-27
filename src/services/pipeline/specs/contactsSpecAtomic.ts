/**
 * Contacts atomic spec (Step X3)
 *
 * Goal (MVP):
 * - Make engine.runE2("contacts", "rebuild") work so unified logs appear.
 * - Keep local md as the source-of-truth: scanFull uses existing full rebuild logic.
 * - DB sync is best-effort (方案1 full upsert of contactsDir + archiveDir) and must NOT block local usage.
 *
 * NOTE:
 * - Incremental (manual/auto refresh) uses full-scan fallback (MVP) to keep behavior correct; later we can optimize with file-change delta.
 */

import { Notice } from "obsidian";
import type { RSLatteResult, RSLatteScanResult } from "../types";
import type {
  RSLatteAtomicOpContext,
  RSLatteFlushQueueOptions,
  RSLatteReconcileGate,
  ModuleSpecAtomic,
} from "../moduleSpec";

function ok<T>(data: T): RSLatteResult<T> {
  return { ok: true, data };
}

function fail(code: string, message: string, detail?: unknown): RSLatteResult<any> {
  return { ok: false, error: { code, message, detail } };
}


function legacyCtxFromAtomic(ctx: RSLatteAtomicOpContext, op: any) {
  return {
    moduleKey: ctx.moduleKey,
    mode: ctx.mode,
    op,
    vaultId: ctx.vaultId,
    spaceId: ctx.spaceId,
    requestedAt: ctx.requestedAt,
    reason: (ctx as any).reason,
  };
}

function mkSummary(
  ctx: any,
  startedAt: string,
  metrics?: Record<string, number>,
  message?: string,
  gate?: RSLatteReconcileGate
): any {
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

type BuildOpsState = {
  paths: string[];
  /**
   * If false, flushQueue must NOT fallback to full list even when paths is empty.
   * Used for archive modes where "no moved paths" should mean "no DB write".
   */
  allowFallbackFull?: boolean;
};

export function createContactsSpecAtomic(plugin: any): ModuleSpecAtomic {
  // runId-scoped state (buildOps -> flushQueue)
  const buildOpsByRunId = new Map<string, BuildOpsState>();

  const listAllPaths = async (): Promise<string[]> => {
    // private helper in main.ts (Step X2)
    const fn = (plugin as any).listAllContactMdPathsForDbSync;
    if (typeof fn === "function") return await fn.call(plugin);
    return [];
  };


  const rebuildLocalIndexes = async (ctx: RSLatteAtomicOpContext): Promise<any> => {
    // Source-of-truth: rebuild local contacts indexes (main + archive)
    
    // ✅ DEBUG: 打印扫描前的提示
    const debugLogEnabled = (plugin?.settings as any)?.debugLogEnabled === true;
    if (debugLogEnabled) {
      console.log(`[RSLatte][contacts][manual_refresh] rebuildLocalIndexes: Starting full rebuild of contacts indexes...`);
    }
    
    const r = await (plugin as any).contactsIndex?.rebuildAllAndWrite?.();
    
    // ✅ DEBUG: 打印扫描结果（如果 rebuildAllAndWrite 返回了文件信息）
    if (debugLogEnabled && r) {
      const mainFiles = Array.isArray((r as any)?.main?.scannedFiles) ? (r as any).main.scannedFiles : [];
      const archiveFiles = Array.isArray((r as any)?.archive?.scannedFiles) ? (r as any).archive.scannedFiles : [];
      const allFiles = [...mainFiles, ...archiveFiles].sort();
      console.log(`[RSLatte][contacts][manual_refresh] rebuildLocalIndexes: Completed`, {
        main: {
          count: (r as any)?.main?.count ?? 0,
          scannedFiles: mainFiles.sort(),
          parseErrorFiles: Array.isArray((r as any)?.main?.parseErrorFiles) ? (r as any).main.parseErrorFiles.sort() : [],
        },
        archive: {
          count: (r as any)?.archive?.count ?? 0,
          scannedFiles: archiveFiles.sort(),
          parseErrorFiles: Array.isArray((r as any)?.archive?.parseErrorFiles) ? (r as any).archive.parseErrorFiles.sort() : [],
        },
        totalScannedFiles: allFiles.length,
        scannedFiles: allFiles.slice(0, 20), // 只显示前20个
      });
    }
    
    return { rebuild: r, requestedAt: ctx.requestedAt };
  };

  const shouldDbSyncForMode = (mode: string): boolean => {
    // X4: rebuild/manual_refresh/auto_refresh all do full upsert (方案1) in MVP.
    return mode === "rebuild" || mode === "manual_refresh" || mode === "auto_refresh" || mode === "manual_archive" || mode === "auto_archive";
  };

  const tryBestEffortFullUpsert = async (
    ctx: RSLatteAtomicOpContext,
    paths: string[]
  ): Promise<{ skipped: boolean; reason?: string; upserted?: number }> => {
    // Nothing to write => skip quietly.
    if (!paths || paths.length === 0) {
      return { skipped: true, reason: "EMPTY_OPS" };
    }
    // Toggle off => skip silently (match other modules)
    if (!(plugin as any).isContactsDbSyncEnabledV2?.()) {
      return { skipped: true, reason: "DBSYNC_DISABLED" };
    }

    // X4: rebuild/manual/auto refresh do DB write (方案1 full upsert)
    if (!shouldDbSyncForMode(ctx.mode)) {
      return { skipped: true, reason: "MODE_NOT_SUPPORTED" };
    }

    // ShouldTouchBackendNow + backend readiness (best-effort)
    const vaultOk = await (plugin as any).vaultSvc?.ensureVaultReadySafe?.(`contacts:${ctx.mode}`);
    if (!vaultOk) {
      new Notice("Contacts DB 同步失败：Vault 未就绪");
      return { skipped: true, reason: "VAULT_NOT_READY" };
    }

    const db = await (plugin as any).vaultSvc?.checkDbReadySafe?.(`contacts:${ctx.mode}`);
    if (!db?.ok) {
      new Notice(`Contacts DB 同步失败：${String(db?.reason ?? "后端不可达").slice(0, 120)}`);
      return { skipped: true, reason: "BACKEND_NOT_READY" };
    }

    try {
      // Use existing helper to build payload & call /contacts/upsert-batch.
      await (plugin as any).tryContactsDbSyncByPaths?.(paths, String(ctx.mode), { quiet: true });
      return { skipped: false, upserted: paths.length };
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      new Notice(`Contacts DB 同步失败：${String(msg).slice(0, 120)}`);
      return { skipped: true, reason: "UPSERT_FAILED" };
    }
  };

  return {
    key: "contacts",
    label: "Contacts",

    // -------- incremental (MVP full-scan fallback) --------
    async scanIncremental(ctx: RSLatteAtomicOpContext): Promise<RSLatteResult<RSLatteScanResult>> {
      // MVP: we don't track file deltas yet; return a minimal scan result.
      const res = {
        mode: "inc",
        changedFiles: [],
        addedIds: [],
        updatedIds: [],
        removedIds: [],
        meta: { scannedAt: Date.now(), reason: ctx.mode, fullFallback: true as any },
      } as any;
      
      // ✅ DEBUG: 打印扫描结果（MVP 实现目前返回空列表）
      const debugLogEnabled = (plugin?.settings as any)?.debugLogEnabled === true;
      if (debugLogEnabled) {
        console.log(`[RSLatte][contacts][manual_refresh] scanIncremental: (MVP - full fallback):`, {
          changedFiles: res.changedFiles,
          reason: res.meta.reason,
        });
      }
      
      return ok(res);
    },

    async applyDelta(ctx: RSLatteAtomicOpContext, scan: RSLatteScanResult): Promise<RSLatteResult<any>> {
      // MVP: applyDelta rebuilds full indexes (contactsDir + archiveDir)
      try {
        const r = await rebuildLocalIndexes(ctx);
        return ok({ applied: "full_fallback", rebuild: r, scan });
      } catch (e: any) {
        return fail("CONTACTS_APPLYDELTA_FAILED", "Contacts applyDelta failed", { message: e?.message ?? String(e) });
      }
    },

    // -------- rebuild --------
    async scanFull(ctx: RSLatteAtomicOpContext): Promise<RSLatteResult<any>> {
      try {
        return ok(await rebuildLocalIndexes(ctx));
      } catch (e: any) {
        return fail("CONTACTS_SCANFULL_FAILED", "Contacts scanFull failed", { message: e?.message ?? String(e) });
      }
    },

    async replaceAll(_ctx: RSLatteAtomicOpContext, input: any): Promise<RSLatteResult<any>> {
      // scanFull already writes the index; keep it idempotent.
      return ok(input);
    },

    // -------- archive --------
    async archiveOutOfRange(ctx: RSLatteAtomicOpContext): Promise<RSLatteResult<any>> {
      const startedAt = new Date().toISOString();
      try {
        const reason = ctx.mode === "auto_archive" ? "auto" : "manual";
        // archive is local-only; must succeed even if backend is down
        const r: any = await (plugin as any).archiveContactsNow?.({ reason, quiet: reason === "auto", skipDbSync: true });
        const moved = Number(r?.moved ?? 0);
        const summary = mkSummary(
          legacyCtxFromAtomic(ctx, "archive"),
          startedAt,
          { archivedCount: moved },
          "OK"
        );
        // pass movedPaths to buildOps for optional partial upsert
        (summary as any).movedPaths = Array.isArray(r?.movedPaths) ? r.movedPaths : [];
        return ok(summary);
      } catch (e: any) {
        return fail("CONTACTS_ARCHIVE_FAILED", "Contacts archiveOutOfRange failed", { message: e?.message ?? String(e) });
      }
    },

    // -------- db ops (MVP) --------
    async buildOps(ctx: RSLatteAtomicOpContext, _input: any): Promise<RSLatteResult<any>> {
      try {
        // Only rebuild builds ops for DB sync in X3.
        if (!shouldDbSyncForMode(ctx.mode)) {
          if (ctx.runId) {
            buildOpsByRunId.set(ctx.runId, { paths: [], allowFallbackFull: true });
          }
          return ok({ ops: [] });
        }

        const isArchiveMode = ctx.mode === "manual_archive" || ctx.mode === "auto_archive";

        // For archive: prefer movedPaths; if movedPaths is provided (even empty), do NOT fallback to full.
        // Fallback to full ONLY when movedPaths is not provided (older impl / unexpected input).
        if (isArchiveMode) {
          const hasMovedPathsProp = _input && Object.prototype.hasOwnProperty.call(_input as any, "movedPaths");
          const movedPaths = hasMovedPathsProp && Array.isArray((_input as any).movedPaths)
            ? ((_input as any).movedPaths as string[])
            : undefined;

          if (movedPaths !== undefined) {
            if (ctx.runId) {
              buildOpsByRunId.set(ctx.runId, { paths: movedPaths, allowFallbackFull: false });
            }
            return ok({ ops: movedPaths.map((p) => ({ path: p })) });
          }

          const full = await listAllPaths();
          if (ctx.runId) {
            buildOpsByRunId.set(ctx.runId, { paths: full, allowFallbackFull: true });
          }
          return ok({ ops: full.map((p) => ({ path: p })) });
        }

        // rebuild/manual_refresh/auto_refresh: always full (contactsDir + archiveDir)
        const full = await listAllPaths();
        if (ctx.runId) {
          buildOpsByRunId.set(ctx.runId, { paths: full, allowFallbackFull: true });
        }
        return ok({ ops: full.map((p) => ({ path: p })) });
      } catch (e: any) {
        // buildOps failure must not block local usage; treat as empty ops.
        console.warn("[RSLatte][contacts] buildOps failed:", e);
        if (ctx.runId) {
          buildOpsByRunId.set(ctx.runId, { paths: [], allowFallbackFull: true });
        }
        return ok({ ops: [] });
      }
    },

    async flushQueue(ctx: RSLatteAtomicOpContext, _opts: RSLatteFlushQueueOptions): Promise<RSLatteResult<any>> {
      try {
        const runId = ctx.runId;
        const st = runId ? buildOpsByRunId.get(runId) : undefined;
        if (runId) {
          buildOpsByRunId.delete(runId);
        }

        const isArchiveMode = ctx.mode === "manual_archive" || ctx.mode === "auto_archive";
        let paths: string[] = [];

        if (st) {
          if (isArchiveMode && st.allowFallbackFull === false) {
            // Archive: movedPaths is authoritative (empty => no DB write)
            paths = st.paths ?? [];
          } else {
            // Others: empty => fallback to full
            paths = st.paths && st.paths.length ? st.paths : await listAllPaths();
          }
        } else {
          // No state: be conservative.
          paths = isArchiveMode ? [] : await listAllPaths();
        }

        const r = await tryBestEffortFullUpsert(ctx, paths);
        return ok({ flushed: r.skipped ? 0 : (r.upserted ?? 0), skipped: r.skipped, reason: r.reason });
      } catch (e: any) {
        // Must NOT block local usage.
        const msg = e?.message ?? String(e);
        new Notice(`Contacts DB 同步失败：${String(msg).slice(0, 120)}`);
        return ok({ flushed: 0, skipped: true, reason: "UNCAUGHT" });
      }
    },

    // -------- gate/stats/reconcile --------
    async getReconcileGate(ctx: RSLatteAtomicOpContext): Promise<RSLatteResult<RSLatteReconcileGate>> {
      // X3: only rebuild participates in dbSync/flushQueue.
      const dbSyncEnabled = shouldDbSyncForMode(ctx.mode) && !!(plugin as any).isContactsDbSyncEnabledV2?.();
      return ok({
        dbSyncEnabled,
        pendingCount: 0,
        failedCount: 0,
        deltaSize: 0,
        uidMissingCount: 0,
        parseErrorCount: 0,
        dirtyCount: 0,
      } as any);
    },

    async reconcile(_ctx: RSLatteAtomicOpContext, _input: any): Promise<RSLatteResult<any>> {
      // Contacts does not have reconcile semantics yet.
      return ok({ noop: true });
    },

    async stats(_ctx: RSLatteAtomicOpContext): Promise<RSLatteResult<any>> {
      // Minimal stats for summary; X4/X5 can enrich.
      return ok({});
    },
  };
}
