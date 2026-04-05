import type {
  ModuleSpecAtomic,
  RSLatteAtomicOpContext,
  RSLatteFlushQueueOptions,
  RSLatteModuleStats,
  RSLatteModuleOpSummary,
  RSLatteReconcileGate,
} from "../moduleSpec";
import type { RSLatteResult, RSLatteError } from "../types";
import { writeHealthAnalysisAlertIndex } from "../../health/healthAnalysisAlertIndex";
import {
  ensurePrevMonthHealthSnapshotsIfMissing,
  writeHealthAnalysisSnapshotsAndIndex,
} from "../../health/healthAnalysisIndex";

function ok<T>(data: T, warnings?: string[]): RSLatteResult<T> {
  return warnings?.length ? { ok: true, data, warnings } : { ok: true, data };
}

function fail(code: string, message: string, detail?: unknown): RSLatteResult<never> {
  const error: RSLatteError = { code, message, detail };
  return { ok: false, error };
}

const HEALTH_MODULES = { checkin: false, finance: false, health: true } as const;

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

function computeHealthGateFromMeta(plugin: any, dbSyncEnabled: boolean): RSLatteReconcileGate {
  const gate: RSLatteReconcileGate = { dbSyncEnabled };
  if (!dbSyncEnabled) return gate;
  try {
    const meta: any = plugin?._dbSyncMeta?.health ?? {};
    const pending = Number(meta?.pendingCount ?? 0);
    const failed = Number(meta?.failedCount ?? 0);
    gate.pendingCount = pending;
    gate.failedCount = failed;
    gate.deltaSize = pending + failed;
  } catch {
    /* ignore */
  }
  return gate;
}

export function createHealthSpecAtomic(plugin: any): ModuleSpecAtomic {
  const forceFullByRunId = new Map<string, boolean>();
  let lastDeltaSize = 0;

  const computeDbSyncEnabled = (): boolean => {
    try {
      return plugin?.isHealthDbSyncEnabled?.() === true;
    } catch {
      return false;
    }
  };

  const ensureBackendSafe = async (): Promise<boolean> => {
    try {
      const ok2 = await plugin?.vaultSvc?.ensureVaultReadySafe?.("healthSpecAtomic");
      return ok2 !== false;
    } catch {
      return false;
    }
  };

  const getForceFullFlag = (): boolean => {
    try {
      return !!(plugin?.settings as any)?.dbSyncForceFullNext?.health;
    } catch {
      return false;
    }
  };

  return {
    key: "health",
    label: "Health",

    async scanIncremental(ctx) {
      try {
        await plugin?.recordRSLatte?.ensureReady?.();
        const forceEq = ctx.mode === "manual_refresh";
        const scan: any = await plugin?.recordRSLatte?.scanIncrementalFromDiary?.({
          modules: HEALTH_MODULES,
          forceIncludeEqualMtime: forceEq,
        });
        return ok(scan ?? { empty: true, modules: HEALTH_MODULES, kind: "incremental" });
      } catch (e: any) {
        return fail("HEALTH_SCAN_INCREMENTAL_FAILED", "Health scanIncremental failed", { message: e?.message ?? String(e) });
      }
    },

    async applyDelta(ctx, scan: any) {
      // 与 financeSpecAtomic.applyDelta 对齐：无论增量是否为空，都刷新 health-analysis（月 stats/alerts、alert-index），
      // 否则仅「索引无变更」的 tick 从不落盘快照，Review/侧栏统计会一直提示未读取到当月文件。
      const modeStr = String(ctx?.mode ?? "manual_refresh");
      if (scan?.empty) {
        lastDeltaSize = 0;
        try {
          await writeHealthAnalysisAlertIndex(plugin, modeStr);
          await writeHealthAnalysisSnapshotsAndIndex(plugin, modeStr);
          if (modeStr === "auto_refresh") {
            try {
              await ensurePrevMonthHealthSnapshotsIfMissing(plugin, modeStr);
            } catch (e2) {
              console.warn("[RSLatte][health] ensure prev-month snapshots failed", e2);
            }
          }
        } catch (e) {
          console.warn("[RSLatte][health][applyDelta] empty scan: health-analysis write failed", e);
        }
        return ok({ changedDays: 0, forceFullSync: getForceFullFlag() } as any);
      }
      try {
        await plugin?.recordRSLatte?.ensureReady?.();
        const applied: any = await plugin?.recordRSLatte?.applyIncrementalScan?.(scan, { updateLists: false });
        lastDeltaSize = Number(applied?.changedDays ?? applied?.scannedDays ?? 0);
        await writeHealthAnalysisAlertIndex(plugin, modeStr);
        await writeHealthAnalysisSnapshotsAndIndex(plugin, modeStr);
        if (modeStr === "auto_refresh") {
          try {
            await ensurePrevMonthHealthSnapshotsIfMissing(plugin, modeStr);
          } catch (e2) {
            console.warn("[RSLatte][health] ensure prev-month snapshots failed", e2);
          }
        }
        return ok({ ...(applied ?? { changedDays: 0 }), forceFullSync: getForceFullFlag() } as any);
      } catch (e: any) {
        return fail("HEALTH_APPLY_DELTA_FAILED", "Health applyDelta failed", { message: e?.message ?? String(e) });
      }
    },

    async scanFull(_ctx) {
      try {
        await plugin?.recordRSLatte?.ensureReady?.();
        const scan: any = await plugin?.recordRSLatte?.scanFullFromDiaryRange?.({
          reconcileMissingDays: true,
          modules: HEALTH_MODULES,
          scanAllDiaryDates: _ctx?.mode === "rebuild",
        });
        return ok(scan ?? { empty: true, modules: HEALTH_MODULES, kind: "full" });
      } catch (e: any) {
        return fail("HEALTH_SCAN_FULL_FAILED", "Health scanFull failed", { message: e?.message ?? String(e) });
      }
    },

    async replaceAll(ctx, scan: any) {
      try {
        await plugin?.recordRSLatte?.ensureReady?.();
        if (scan?.empty) {
          lastDeltaSize = 0;
          await writeHealthAnalysisAlertIndex(plugin, String(ctx?.mode ?? "rebuild"));
          await writeHealthAnalysisSnapshotsAndIndex(plugin, String(ctx?.mode ?? "rebuild"));
          return ok({ changedDays: 0, forceFullSync: true } as any);
        }
        const applied: any = await plugin?.recordRSLatte?.applyFullReplace?.(scan, { updateLists: false });
        lastDeltaSize = Number(applied?.changedDays ?? applied?.scannedDays ?? 0);
        await writeHealthAnalysisAlertIndex(plugin, String(ctx?.mode ?? "rebuild"));
        await writeHealthAnalysisSnapshotsAndIndex(plugin, String(ctx?.mode ?? "rebuild"));
        return ok({ ...(applied ?? { changedDays: 0 }), forceFullSync: true } as any);
      } catch (e: any) {
        return fail("HEALTH_REPLACE_ALL_FAILED", "Health replaceAll failed", { message: e?.message ?? String(e) });
      }
    },

    async archiveOutOfRange(ctx) {
      const startedAt = new Date().toISOString();
      try {
        await plugin?.recordRSLatte?.ensureReady?.();
        const r: any = await plugin?.recordRSLatte?.archiveNow?.(HEALTH_MODULES);
        const archivedCount = Number(r?.healthArchived ?? 0);
        return ok(mkSummary(legacyCtxFromAtomic(ctx, "archive"), startedAt, { archivedCount }, String(r?.cutoffDate ?? "")));
      } catch (e: any) {
        return fail("HEALTH_ARCHIVE_FAILED", "Health archiveOutOfRange failed", { message: e?.message ?? String(e) });
      }
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
        const reason = forceFullSync ? "manual_rebuild_health" : String(ctx.mode);
        await plugin?.syncRecordIndexToDbNow?.({ reason, modules: HEALTH_MODULES });

        if (ctx?.runId && forceFullByRunId.get(ctx.runId) === true) {
          forceFullByRunId.delete(ctx.runId);
          await plugin?.consumeForceFullFlag?.("health", true);
        }
        if (!ctx?.runId && getForceFullFlag()) {
          await plugin?.consumeForceFullFlag?.("health", true);
        }

        return ok({ indexSynced: 1 } as any);
      } catch (e: any) {
        console.warn(`[RSLatte][health][${ctx.mode}] syncRecordIndexToDbNow failed`, e);
        return ok({ indexSynced: 0 } as any, ["INDEX_SYNC_FAILED"]);
      }
    },

    async getReconcileGate(_ctx) {
      const dbSyncEnabled = computeDbSyncEnabled();
      const gate = computeHealthGateFromMeta(plugin, dbSyncEnabled) as any;
      gate.deltaSize = Number(lastDeltaSize ?? gate.deltaSize ?? 0);
      gate.allowReconcileWithoutDbSync = true;
      return ok(gate);
    },

    async reconcile(ctx) {
      const startedAt = new Date().toISOString();
      const dbSyncEnabled = computeDbSyncEnabled();
      const gate: RSLatteReconcileGate = {
        ...computeHealthGateFromMeta(plugin, dbSyncEnabled),
        deltaSize: Number(lastDeltaSize ?? 0),
        allowReconcileWithoutDbSync: true,
      };

      try {
        // 本地索引校准始终执行；启用 DB 同步时再调 `/health-records/reconcile` 对齐库内软删
        let shouldReconcile = true;
        let r: any = null;

        if (ctx.mode === "manual_refresh") {
          try {
            await plugin?.recordRSLatte?.ensureReady?.();
            const incrementalScan = await plugin?.recordRSLatte?.scanIncrementalFromDiary?.({
              modules: HEALTH_MODULES,
              forceIncludeEqualMtime: true,
            });
            if (!incrementalScan) {
              shouldReconcile = false;
              r = { scannedDays: 0, clearedDays: 0, cutoffDate: null };
            } else {
              const hasScannedFiles = incrementalScan.dayKeysScanned && incrementalScan.dayKeysScanned.size > 0;
              const hasParsed = incrementalScan.parsedByDay && incrementalScan.parsedByDay.size > 0;
              if (!hasScannedFiles && !hasParsed) {
                shouldReconcile = false;
                r = { scannedDays: 0, clearedDays: 0, cutoffDate: null };
              } else if (hasParsed) {
                await plugin?.recordRSLatte?.applyIncrementalScan?.(incrementalScan, { updateLists: false });
                const dks = incrementalScan.dayKeysScanned ?? new Set<string>();
                r = {
                  scannedDays: dks.size ?? 0,
                  clearedDays: 0,
                  cutoffDate: incrementalScan.cutoffDate ?? "",
                  dayKeysScanned: dks,
                  dayKeysToReplace: dks,
                };
              } else if (hasScannedFiles) {
                // 日记已变更但 parsedByDay 为空（例如特殊返回形态）：仍应用增量以按日剔除索引中已删除的条目
                await plugin?.recordRSLatte?.applyIncrementalScan?.(incrementalScan, { updateLists: false });
                const dks = incrementalScan.dayKeysScanned ?? new Set<string>();
                r = {
                  scannedDays: dks.size ?? 0,
                  clearedDays: 0,
                  cutoffDate: incrementalScan.cutoffDate ?? "",
                  dayKeysScanned: dks,
                  dayKeysToReplace: dks,
                };
              } else {
                const dks = incrementalScan.dayKeysScanned ?? new Set<string>();
                r = {
                  scannedDays: dks.size ?? 0,
                  clearedDays: 0,
                  cutoffDate: incrementalScan.cutoffDate ?? "",
                  dayKeysScanned: dks,
                  dayKeysToReplace: dks,
                };
              }
            }
          } catch (e: any) {
            console.warn(`[RSLatte][health][reconcile] incremental failed, full rebuild`, e);
            await plugin?.recordRSLatte?.ensureReady?.();
            r = await plugin?.recordRSLatte?.rebuildIndexFromDiaryRange?.(true, true, HEALTH_MODULES, true);
          }
        } else {
          await plugin?.recordRSLatte?.ensureReady?.();
          r = await plugin?.recordRSLatte?.rebuildIndexFromDiaryRange?.(true, true, HEALTH_MODULES, true);
        }

        if (!shouldReconcile) {
          lastDeltaSize = 0;
          return ok(mkSummary(legacyCtxFromAtomic(ctx, "reconcile"), startedAt, { skipped: 1 }, "NO_CHANGES_DETECTED", gate));
        }

        lastDeltaSize = 0;
        await writeHealthAnalysisAlertIndex(plugin, String(ctx?.mode ?? "manual_refresh"));
        await writeHealthAnalysisSnapshotsAndIndex(plugin, String(ctx?.mode ?? "manual_refresh"));

        if (dbSyncEnabled) {
          const api = (plugin as any)?.api;
          if (api?.healthRecordsReconcile) {
            try {
              const hsnap = await plugin?.recordRSLatte?.getHealthSnapshot?.(false);
              const items = (hsnap?.items ?? []) as any[];
              const presentCompKeys = new Set<string>();
              const scopeDates = new Set<string>();
              for (const item of items) {
                if (item.isDelete) continue;
                const recordDate = String(item.recordDate ?? "");
                const metricKey = String(item.metricKey ?? "").trim();
                const entryId = String(item.entryId ?? "").trim();
                if (!recordDate || !/^\d{4}-\d{2}-\d{2}$/.test(recordDate)) continue;
                if (entryId) {
                  presentCompKeys.add(`${recordDate}|e|${entryId}`);
                  scopeDates.add(recordDate);
                } else if (metricKey) {
                  presentCompKeys.add(`${recordDate}|m|${metricKey}`);
                  scopeDates.add(recordDate);
                }
              }
              const dayKeysScanned = r?.dayKeysScanned;
              const dayKeysToReplace = r?.dayKeysToReplace;
              const allScannedDates = new Set<string>();
              if (dayKeysScanned) {
                for (const d of dayKeysScanned) {
                  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) allScannedDates.add(d);
                }
              }
              if (dayKeysToReplace) {
                for (const d of dayKeysToReplace) {
                  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) allScannedDates.add(d);
                }
              }
              if (ctx.mode !== "manual_refresh" && allScannedDates.size === 0 && scopeDates.size > 0) {
                for (const d of scopeDates) allScannedDates.add(d);
              }
              const scannedDates = Array.from(allScannedDates).sort();
              const filteredPresentCompKeys = new Set<string>();
              if (scannedDates.length > 0) {
                const scopeDatesSet = new Set(scannedDates);
                for (const key of presentCompKeys) {
                  const datePart = key.split("|")[0];
                  if (scopeDatesSet.has(datePart)) filteredPresentCompKeys.add(key);
                }
              } else {
                for (const key of presentCompKeys) filteredPresentCompKeys.add(key);
              }
              if (scannedDates.length > 0 || filteredPresentCompKeys.size > 0) {
                const reconcilePayload = {
                  scope_dates: scannedDates.length > 0 ? scannedDates : Array.from(scopeDates).sort(),
                  present_comp_keys: Array.from(filteredPresentCompKeys).sort(),
                  scope_file_paths: [] as string[],
                  dry_run: false,
                };
                const reconcileResp: any = await api.healthRecordsReconcile(reconcilePayload);
                const markedDeleted = Number(reconcileResp?.marked_deleted ?? 0);
                const keep = Number(reconcileResp?.keep ?? 0);
                return ok(
                  mkSummary(
                    legacyCtxFromAtomic(ctx, "reconcile"),
                    startedAt,
                    {
                      reconciled: 1,
                      scannedDays: Number(r?.scannedDays ?? 0),
                      clearedDays: Number(r?.clearedDays ?? 0),
                      marked_deleted: markedDeleted,
                      keep,
                    },
                    `reconcile ok marked_deleted=${markedDeleted} keep=${keep}`,
                    gate
                  )
                );
              }
            } catch (e: any) {
              console.warn(`[RSLatte][health][reconcile] healthRecordsReconcile failed`, e);
            }
          }
        }

        return ok(
          mkSummary(
            legacyCtxFromAtomic(ctx, "reconcile"),
            startedAt,
            { reconciled: 1, scannedDays: Number(r?.scannedDays ?? 0), clearedDays: Number(r?.clearedDays ?? 0) },
            String(r?.cutoffDate ?? ""),
            gate
          )
        );
      } catch (e: any) {
        return fail("HEALTH_RECONCILE_FAILED", "Health reconcile failed", { message: e?.message ?? String(e) });
      }
    },

    async stats(_ctx) {
      const dbSyncEnabled = computeDbSyncEnabled();
      const gate = computeHealthGateFromMeta(plugin, dbSyncEnabled);
      const st: RSLatteModuleStats = {
        moduleKey: "health",
        items: {
          pendingCount: Number((gate as any)?.pendingCount ?? 0),
          failedCount: Number((gate as any)?.failedCount ?? 0),
        },
      } as any;
      return ok(st);
    },
  };
}
