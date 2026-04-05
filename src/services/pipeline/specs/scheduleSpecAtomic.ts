import type {
  ModuleSpecAtomic,
  RSLatteAtomicOpContext,
  RSLatteFlushQueueOptions,
  RSLatteModuleOpSummary,
  RSLatteModuleStats,
  RSLatteReconcileGate,
} from "../moduleSpec";
import type { RSLatteResult, RSLatteError } from "../types";
import { isScheduleMemoLine, type RSLatteIndexItem, type RSLatteParsedLine } from "../../../taskRSLatte/types";
import { normalizeArchiveThresholdDays } from "../../../constants/defaults";

const SCHEDULE_MODULES = { task: false, memo: true } as const;

function ok<T>(data: T): RSLatteResult<T> {
  return { ok: true, data };
}

function fail(code: string, message: string, detail?: unknown): RSLatteResult<never> {
  const error: RSLatteError = { code, message, detail };
  return { ok: false, error };
}

function legacyCtxFromAtomic(ctx: RSLatteAtomicOpContext, op: any) {
  return {
    moduleKey: "schedule" as const,
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
    moduleKey: "schedule",
    mode: ctx.mode,
    op: ctx.op,
    startedAt,
    finishedAt: new Date().toISOString(),
    metrics,
    message,
    gate: gate ?? { dbSyncEnabled: false },
  } as any;
}

/** 日程 DB 同步：`scheduleModule.enableDbSync`（`isScheduleDbSyncEnabledV2`） */
async function computeScheduleGate(plugin: any, dbSyncEnabled: boolean): Promise<RSLatteReconcileGate> {
  const gate: RSLatteReconcileGate = { dbSyncEnabled };
  if (!dbSyncEnabled) return gate;

  try {
    const store = plugin?.taskRSLatte?.store;
    if (!store || typeof store.readIndex !== "function") return gate;

    const idx: any = await store.readIndex("schedule");
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

function isScheduleMemo(it: any): boolean {
  return isScheduleMemoLine(it);
}

export function createScheduleSpecAtomic(_plugin: any): ModuleSpecAtomic {
  const plugin = _plugin;
  const isDebug = () => (plugin?.settings as any)?.debugLogEnabled === true;
  const dbgStart = (mode: string, step: string) => {
    if (!isDebug()) return;
    console.log(`[RSLatte][schedule][${mode}] ${step}: start`);
  };
  const dbgEnd = (mode: string, step: string, t0: number, count?: number) => {
    if (!isDebug()) return;
    const payload: Record<string, unknown> = { costMs: Date.now() - t0 };
    if (typeof count === "number") payload.count = count;
    console.log(`[RSLatte][schedule][${mode}] ${step}: done`, payload);
  };
  let lastDeltaSize = 0;

  const forceFullByRunId = new Map<string, boolean>();

  const computeDbSyncEnabled = (): boolean => {
    try {
      return plugin?.isScheduleDbSyncEnabledV2?.() === true;
    } catch {
      return false;
    }
  };

  const getForceFullFlag = (): boolean => {
    try {
      return !!(plugin?.settings as any)?.dbSyncForceFullNext?.schedule;
    } catch {
      return false;
    }
  };

  return {
    key: "schedule",
    label: "Schedule",

    async scanIncremental(_ctx_unused) {
      const mode = String(_ctx_unused?.mode ?? "manual_refresh");
      const t0 = Date.now();
      dbgStart(mode, "scanIncremental");
      try {
        await plugin?.taskRSLatte?.ensureReady?.();
        const scan: any = await plugin?.taskRSLatte?.e2ScanIncremental?.(SCHEDULE_MODULES, { fixUidAndMeta: false });
        const memos = Array.isArray(scan?.memos) ? scan.memos.filter((m: any) => isScheduleMemo(m)) : [];
        lastDeltaSize = memos.length;
        dbgEnd(mode, "scanIncremental", t0, memos.length);
        return ok({
          ...(scan ?? {}),
          modules: SCHEDULE_MODULES,
          tasks: [],
          memos,
          fullScan: false,
          scheduleOnly: true,
        });
      } catch (e: any) {
        return fail("SCHEDULE_SCAN_INCREMENTAL_FAILED", `Schedule scanIncremental failed: ${e?.message ?? String(e)}`);
      }
    },

    async applyDelta(_ctx_unused, scan: any) {
      const mode = String(_ctx_unused?.mode ?? "manual_refresh");
      const t0 = Date.now();
      dbgStart(mode, "applyDelta");
      try {
        const memos = Array.isArray(scan?.memos) ? scan.memos.filter((m: any) => isScheduleMemo(m)) : [];
        const merged = await plugin.taskRSLatte.mergeIntoIndex("schedule", memos, {
          touchedFilePaths: Array.isArray(scan?.touchedFilePaths) ? scan.touchedFilePaths : [],
          removedFilePaths: Array.isArray(scan?.removedFilePaths) ? scan.removedFilePaths : [],
        });
        try {
          const store = plugin?.contactsIndex?.getInteractionsStore?.();
          if (store && typeof store.applyFileUpdates === "function") {
            const byFile = (scan?.contactInteractionsByFile && typeof scan.contactInteractionsByFile === "object") ? scan.contactInteractionsByFile : {};
            const upserts = Object.keys(byFile).map((fp) => {
              const entries = Array.isArray((byFile as any)[fp]?.entries) ? (byFile as any)[fp].entries : [];
              return {
                source_path: fp,
                mtime: Number((byFile as any)[fp]?.mtime ?? 0),
                entries: entries.filter((e: any) => String(e?.source_type ?? "").trim() === "schedule"),
              };
            });
            await store.applyFileUpdates({ upserts, removals: [] });
          }
        } catch {
          // ignore
        }
        dbgEnd(mode, "applyDelta", t0, merged.length);
        const forceFullSync = getForceFullFlag();
        return ok({ modules: SCHEDULE_MODULES, scheduleOnly: true, written: merged.length, forceFullSync });
      } catch (e: any) {
        return fail("SCHEDULE_APPLY_DELTA_FAILED", `Schedule applyDelta failed: ${e?.message ?? String(e)}`);
      }
    },

    async scanFull(_ctx_unused) {
      const mode = String(_ctx_unused?.mode ?? "rebuild");
      const t0 = Date.now();
      dbgStart(mode, "scanFull");
      try {
        await plugin?.taskRSLatte?.ensureReady?.();
        const scan: any = await plugin?.taskRSLatte?.e2ScanFull?.(SCHEDULE_MODULES);
        const memos = Array.isArray(scan?.memos) ? scan.memos.filter((m: any) => isScheduleMemo(m)) : [];
        lastDeltaSize = memos.length;
        dbgEnd(mode, "scanFull", t0, memos.length);
        return ok({
          ...(scan ?? {}),
          modules: SCHEDULE_MODULES,
          tasks: [],
          memos,
          fullScan: true,
          scheduleOnly: true,
        });
      } catch (e: any) {
        return fail("SCHEDULE_SCAN_FULL_FAILED", `Schedule scanFull failed: ${e?.message ?? String(e)}`);
      }
    },

    async replaceAll(_ctx_unused, scan: any) {
      const mode = String(_ctx_unused?.mode ?? "rebuild");
      const t0 = Date.now();
      dbgStart(mode, "replaceAll");
      try {
        const memos = Array.isArray(scan?.memos) ? scan.memos.filter((m: any) => isScheduleMemo(m)) : [];
        const next = await plugin.taskRSLatte.mergeIntoIndex("schedule", memos, { replaceAll: true });
        try {
          const store = plugin?.contactsIndex?.getInteractionsStore?.();
          if (store) {
            const byFile = (scan?.contactInteractionsByFile && typeof scan.contactInteractionsByFile === "object") ? scan.contactInteractionsByFile : {};
            const upserts = Object.keys(byFile).map((fp) => {
              const entries = Array.isArray((byFile as any)[fp]?.entries) ? (byFile as any)[fp].entries : [];
              return {
                source_path: fp,
                mtime: Number((byFile as any)[fp]?.mtime ?? 0),
                entries: entries.filter((e: any) => String(e?.source_type ?? "").trim() === "schedule"),
              };
            });
            const removals = Array.isArray(scan?.removedFilePaths) ? scan.removedFilePaths : [];
            await (store as any).applyFileUpdates?.({ upserts, removals });
            const allowed = new Set(Array.isArray(scan?.includedFilePaths) ? scan.includedFilePaths : []);
            await (store as any).cleanupSourceTypeNotIn?.("schedule", allowed);
          }
        } catch {
          // ignore
        }
        dbgEnd(mode, "replaceAll", t0, next.length);
        return ok({ modules: SCHEDULE_MODULES, scheduleOnly: true, written: next.length, forceFullSync: true });
      } catch (e: any) {
        return fail("SCHEDULE_REPLACE_ALL_FAILED", `Schedule replaceAll failed: ${e?.message ?? String(e)}`);
      }
    },

    async archiveOutOfRange(ctx) {
      const startedAt = new Date().toISOString();
      try {
        await plugin?.taskRSLatte?.ensureReady?.();
        const items = await plugin.taskRSLatte.readScheduleIndexItems();
        const cutoffDays = normalizeArchiveThresholdDays((plugin?.settings as any)?.scheduleModule?.archiveThresholdDays ?? 90);
        const today = new Date();
        const cutoff = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - cutoffDays));
        const toDate = (ymd: string): Date | null => {
          const m = String(ymd ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
          if (!m) return null;
          return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
        };
        let archivedCount = 0;
        const remain: RSLatteIndexItem[] = [];
        for (const it of items) {
          const st = String((it as any)?.status ?? "").trim().toUpperCase();
          const extra = ((it as any)?.extra ?? {}) as Record<string, string>;
          const invalidated = String(extra.invalidated ?? "").trim() === "1";
          if (!(st === "DONE" || st === "CANCELLED" || invalidated)) {
            remain.push(it);
            continue;
          }
          const ymd = String((it as any)?.done_date ?? "").trim()
            || String((it as any)?.cancelled_date ?? "").trim()
            || String(extra.invalidated_date ?? "").trim();
          const d = toDate(ymd);
          if (!d || d >= cutoff) {
            remain.push(it);
            continue;
          }
          archivedCount++;
        }
        if (archivedCount > 0) {
          await plugin.taskRSLatte.mergeIntoIndex("schedule", remain as RSLatteParsedLine[], { replaceAll: true });
        }
        return ok(mkSummary(legacyCtxFromAtomic(ctx, "archive"), startedAt, { archivedCount }, "OK"));
      } catch {
        return ok(mkSummary(legacyCtxFromAtomic(ctx, "archive"), startedAt, { archivedCount: 0 }, "SCHEDULE_ARCHIVE_BEST_EFFORT"));
      }
    },

    async buildOps(ctx, applied: any) {
      try {
        await plugin?.taskRSLatte?.ensureReady?.();
        const forceFullSync = applied?.forceFullSync === true;
        if (forceFullSync && ctx?.runId) forceFullByRunId.set(ctx.runId, true);
        const r: any = await plugin?.taskRSLatte?.e2BuildOpsSchedule?.({ forceFullSync });
        return ok(r ?? { enqueued: 0 });
      } catch (e: any) {
        return fail("SCHEDULE_BUILD_OPS_FAILED", `Schedule buildOps failed: ${e?.message ?? String(e)}`);
      }
    },

    async flushQueue(ctx, opts: RSLatteFlushQueueOptions) {
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

        if (ctx?.runId && forceFullByRunId.get(ctx.runId) === true) {
          forceFullByRunId.delete(ctx.runId);
          await plugin?.consumeForceFullFlag?.("schedule", true);
        }

        return ok({ flushed: 1 } as any);
      } catch (e: any) {
        return fail("SCHEDULE_FLUSH_QUEUE_FAILED", `Schedule flushQueue failed: ${e?.message ?? String(e)}`);
      }
    },

    async getReconcileGate(_ctx) {
      const dbSyncEnabled = computeDbSyncEnabled();
      const gate = (await computeScheduleGate(plugin, dbSyncEnabled)) as any;
      gate.deltaSize = Number(lastDeltaSize ?? 0);
      return ok(gate);
    },

    async reconcile(ctx, input: any) {
      const startedAt = new Date().toISOString();
      const dbSyncEnabled = computeDbSyncEnabled();
      const gate = await computeScheduleGate(plugin, dbSyncEnabled);
      try {
        if (!dbSyncEnabled) {
          return ok(mkSummary(legacyCtxFromAtomic(ctx, "reconcile"), startedAt, { skipped: 1 }, "DBSYNC_DISABLED", gate));
        }
        await plugin?.taskRSLatte?.ensureReady?.();
        const scan = input?.scan ?? {};
        await plugin?.taskRSLatte?.e2ReconcileSchedule?.(scan);
        lastDeltaSize = 0;
        return ok(mkSummary(legacyCtxFromAtomic(ctx, "reconcile"), startedAt, { reconciled: 1 }, "OK", gate));
      } catch (e: any) {
        return fail("SCHEDULE_RECONCILE_FAILED", `Schedule reconcile failed: ${e?.message ?? String(e)}`);
      }
    },

    async stats(_ctx) {
      const gate = await computeScheduleGate(plugin, computeDbSyncEnabled());
      const st: RSLatteModuleStats = {
        moduleKey: "schedule",
        items: {
          pendingCount: Number((gate as any)?.pendingCount ?? 0),
          failedCount: Number((gate as any)?.failedCount ?? 0),
        },
      } as any;
      return ok(st);
    },
  };
}
