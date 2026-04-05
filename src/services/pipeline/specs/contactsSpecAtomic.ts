/**
 * Contacts atomic spec (Step X3)
 *
 * ## §8.1 语义标签
 *
 * - **`rebuildActiveOnly`**：`scanFull` / `applyDelta` → **`rebuildActiveOnlyIndexes`**（`rebuildAndWrite`）：只扫 **`contactsDir`**，不扫 **`archiveDir`**。
 * - **`rebuildAfterPhysicalArchive`**：`archiveOutOfRange` → `archiveContactsNow` 成功后 **`rebuildContactsAllIndexes`**（主索引 + `contacts-archive-index`）。
 *
 * 登记：`PIPELINE_ATOMIC_REBUILD_SCOPE_REGISTRY.contacts`（`rebuildScopeSemantics.ts`）。
 *
 * ## §8.5 DB `flushQueue` 与本地索引扫描范围（显式约定，《代码结构优化方案》）
 *
 * - **本地 JSON 索引**：`rebuildActiveOnlyIndexes` → `contactsIndex.rebuildAndWrite` **只扫 `contactsDir`**（`rebuildActiveOnly`），**不**扫 `archiveDir`，降低日常重建 I/O。
 * - **DB 同步**：`buildOps` 在 rebuild / manual_refresh / auto_refresh 等模式下通过 **`listAllContactMdPathsForDbSync`** 列举 **主目录 + 归档目录** 下全部联系人 md；`flushQueue` 再 **`tryContactsDbSyncByPaths`** 做全量 upsert，使后端 `contacts` 与 Vault **全量对齐**。归档且带 `movedPaths` 时可仅同步搬迁路径（`allowFallbackFull: false`）。
 * - **结论**：索引扫描集 ⊂ DB 路径集 是**有意设计**（索引成本优化 vs DB 契约全量），**不是漏扫归档**。若未来改为「DB 也只 upsert active」，须产品/接口契约确认后再改。
 *
 * - Incremental（manual/auto refresh）当前为全量回退（MVP）；后续可做文件级增量。
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

  /** §8.5：供 `buildOps`/`flushQueue` fallback — **`main.listAllContactMdPathsForDbSync`**（主+归档），与 `rebuildActiveOnlyIndexes` 不同。 */
  const listAllPaths = async (): Promise<string[]> => {
    const fn = (plugin as any).listAllContactMdPathsForDbSync;
    if (typeof fn === "function") return await fn.call(plugin);
    return [];
  };


  /**
   * §8.1 **`rebuildActiveOnly`**：仅主目录 `rebuildAndWrite`，不扫归档树。
   * §8.5 与 `buildOps`/`flushQueue` 的全量 DB 路径列举 **分工不同**（见文件头）；勿将「索引未扫归档」与「DB listAll」混为一谈。
   */
  const rebuildActiveOnlyIndexes = async (ctx: RSLatteAtomicOpContext): Promise<any> => {
    const debugLogEnabled = (plugin?.settings as any)?.debugLogEnabled === true;
    if (debugLogEnabled) {
      console.log(`[RSLatte][contacts][manual_refresh] rebuildActiveOnlyIndexes [rebuildActiveOnly]: Starting...`);
    }

    const r = await (plugin as any).contactsIndex?.rebuildAndWrite?.();

    if (debugLogEnabled && r) {
      const scannedFiles = Array.isArray((r as any)?.scannedFiles) ? (r as any).scannedFiles : [];
      console.log(`[RSLatte][contacts][manual_refresh] rebuildActiveOnlyIndexes: Completed`, {
        count: (r as any)?.count ?? 0,
        scannedFiles: scannedFiles.sort(),
        parseErrorFiles: Array.isArray((r as any)?.parseErrorFiles) ? (r as any).parseErrorFiles.sort() : [],
        sample: scannedFiles.slice(0, 20),
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
      // MVP: applyDelta 与 scanFull 一致，仅重建主索引（不扫归档目录）
      try {
        const r = await rebuildActiveOnlyIndexes(ctx);
        return ok({ applied: "full_fallback", rebuild: r, scan });
      } catch (e: any) {
        return fail("CONTACTS_APPLYDELTA_FAILED", "Contacts applyDelta failed", { message: e?.message ?? String(e) });
      }
    },

    // -------- rebuild --------
    async scanFull(ctx: RSLatteAtomicOpContext): Promise<RSLatteResult<any>> {
      try {
        return ok(await rebuildActiveOnlyIndexes(ctx));
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
    /**
     * §8.5：rebuild / refresh 等模式下此处 **`listAllPaths` → 主+归档全路径**，供后端全量 upsert；本地 `contacts-index.json` 仍仅反映 active 扫描结果（`rebuildActiveOnlyIndexes`）。
     */
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

        // §8.5：rebuild/manual_refresh/auto_refresh — DB 方案 1 全量（主+归档），非索引扫描范围
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

    /**
     * §8.5：按 `buildOps` 缓存路径 `tryContactsDbSyncByPaths`；若路径为空且允许 fallback，再次 **`listAllPaths`（主+归档）** — 与上游仅 active 的索引 JSON 仍可并存。
     */
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
