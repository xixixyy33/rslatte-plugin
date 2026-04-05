import type {
  ModuleSpecAtomic,
  RSLatteAtomicOpContext,
  RSLatteFlushQueueOptions,
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

const CHECKIN_MODULES = { checkin: true, finance: false, health: false } as const;

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

function computeCheckinGateFromMeta(plugin: any, dbSyncEnabled: boolean): RSLatteReconcileGate {
  const gate: RSLatteReconcileGate = { dbSyncEnabled };
  if (!dbSyncEnabled) return gate;
  try {
    const meta: any = plugin?._dbSyncMeta?.checkin ?? {};
    const pending = Number(meta?.pendingCount ?? 0);
    const failed = Number(meta?.failedCount ?? 0);
    gate.pendingCount = pending;
    gate.failedCount = failed;
    gate.deltaSize = pending + failed;
  } catch {
    // ignore
  }
  return gate;
}

export function createCheckinSpecAtomic(plugin: any): ModuleSpecAtomic {
  // runId-scoped flag so we only clear dbSyncForceFullNext.checkin after a successful flush
  const forceFullByRunId = new Map<string, boolean>();

  let lastDeltaSize = 0;

  const computeDbSyncEnabled = (): boolean => {
    try {
      return plugin?.isCheckinDbSyncEnabled?.() === true;
    } catch {
      return false;
    }
  };

  const getForceFullFlag = (): boolean => {
    try {
      return !!(plugin?.settings as any)?.dbSyncForceFullNext?.checkin;
    } catch {
      return false;
    }
  };

  const ensureBackendSafe = async (): Promise<boolean> => {
    try {
      // ✅ C0：ensureVaultReadySafe 内部会判断 shouldTouchBackendNow() 并做 warn 节流
      const ok = await plugin?.vaultSvc?.ensureVaultReadySafe?.("checkinSpecAtomic");
      return ok !== false;
    } catch {
      return false;
    }
  };

  return {
    key: "checkin",
    label: "Checkin",

    async scanIncremental(ctx) {
      try {
        await plugin?.recordRSLatte?.ensureReady?.();
        const scan: any = await plugin?.recordRSLatte?.scanIncrementalFromDiary?.({ modules: CHECKIN_MODULES });
        return ok(scan ?? { empty: true, modules: CHECKIN_MODULES, kind: "incremental" });
      } catch (e: any) {
        return fail("CHECKIN_SCAN_INCREMENTAL_FAILED", "Checkin scanIncremental failed", { message: e?.message ?? String(e) });
      }
    },

    async applyDelta(_ctx, scan: any) {
      if (scan?.empty) {
        lastDeltaSize = 0;
        // ✅ forceFull 由 buildOps/flushQueue 消费（这里不改索引语义）
        return ok({ changedDays: 0, forceFullSync: getForceFullFlag() } as any);
      }
      try {
        await plugin?.recordRSLatte?.ensureReady?.();
        const applied: any = await plugin?.recordRSLatte?.applyIncrementalScan?.(scan, { updateLists: true });
        lastDeltaSize = Number(applied?.changedDays ?? applied?.scannedDays ?? 0);
        return ok({ ...(applied ?? { changedDays: 0 }), forceFullSync: getForceFullFlag() } as any);
      } catch (e: any) {
        return fail("CHECKIN_APPLY_DELTA_FAILED", "Checkin applyDelta failed", { message: e?.message ?? String(e) });
      }
    },

    async scanFull(_ctx) {
      try {
        await plugin?.recordRSLatte?.ensureReady?.();
        const scan: any = await plugin?.recordRSLatte?.scanFullFromDiaryRange?.({
          reconcileMissingDays: true,
          modules: CHECKIN_MODULES,
          scanAllDiaryDates: _ctx?.mode === "rebuild",
        });
        return ok(scan ?? { empty: true, modules: CHECKIN_MODULES, kind: "full" });
      } catch (e: any) {
        return fail("CHECKIN_SCAN_FULL_FAILED", "Checkin scanFull failed", { message: e?.message ?? String(e) });
      }
    },

    async replaceAll(_ctx, scan: any) {
      try {
        await plugin?.recordRSLatte?.ensureReady?.();
        if (scan?.empty) {
          lastDeltaSize = 0;
          return ok({ changedDays: 0, forceFullSync: true } as any);
        }
        const applied: any = await plugin?.recordRSLatte?.applyFullReplace?.(scan, { updateLists: true });
        lastDeltaSize = Number(applied?.changedDays ?? applied?.scannedDays ?? 0);
        return ok({ ...(applied ?? { changedDays: 0 }), forceFullSync: true } as any);
      } catch (e: any) {
        return fail("CHECKIN_REPLACE_ALL_FAILED", "Checkin replaceAll failed", { message: e?.message ?? String(e) });
      }
    },

    async archiveOutOfRange(ctx) {
      const startedAt = new Date().toISOString();
      try {
        await plugin?.recordRSLatte?.ensureReady?.();
        const r: any = await plugin?.recordRSLatte?.archiveNow?.(CHECKIN_MODULES);
        const archivedCount = Number(r?.checkinArchived ?? 0);
        const listsArchived = Number(r?.listsArchivedCheckin ?? 0);
        return ok(
          mkSummary(
            legacyCtxFromAtomic(ctx, "archive"),
            startedAt,
            { archivedCount, listsArchived },
            String(r?.cutoffDate ?? "")
          )
        );
      } catch (e: any) {
        return fail("CHECKIN_ARCHIVE_FAILED", "Checkin archiveOutOfRange failed", { message: e?.message ?? String(e) });
      }
    },

    async buildOps(ctx, applied: any) {
      // ✅ D5: dbSyncEnabled=false => skip (defensive; engine normally won't call)
      if (!computeDbSyncEnabled()) {
        return ok({ skipped: 1 } as any);
      }

      // forceFullSync: rebuild OR one-shot force flag
      const forceFullSync = applied?.forceFullSync === true || getForceFullFlag();
      if (forceFullSync && ctx?.runId) forceFullByRunId.set(ctx.runId, true);

      // If backend isn't reachable, do not throw; just warn (throttled) inside ensureVaultReadySafe
      const backendOk = await ensureBackendSafe();
      if (!backendOk) {
        return ok({ listsSynced: 0, skipped: 1 } as any, ["BACKEND_UNAVAILABLE"]);
      }

      try {
        // 先同步清单（打卡项）确保字典存在。force=true 时忽略 lastKey 判定。
        await plugin?.syncRecordListsToDbNow?.(forceFullSync || ctx.mode === "rebuild", { modules: CHECKIN_MODULES });
        return ok({ listsSynced: 1, forceFullSync } as any);
      } catch (e: any) {
        // 不阻断：失败只影响 DB sync，不影响本地
        console.warn(`[RSLatte][checkin][${ctx.mode}] syncRecordListsToDbNow failed`, e);
        return ok({ listsSynced: 0, forceFullSync } as any, ["LISTS_SYNC_FAILED"]);
      }
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
        // ✅ D5: forceFullSync => use a reason that matches /rebuild/i so autoSyncRecordIndexToDb enters full-upsert mode
        const reason = forceFullSync ? "manual_rebuild_checkin" : String(ctx.mode);
        await plugin?.syncRecordIndexToDbNow?.({ reason, modules: CHECKIN_MODULES });

        // clear force-full flag only after a successful flush
        if (ctx?.runId && forceFullByRunId.get(ctx.runId) === true) {
          forceFullByRunId.delete(ctx.runId);
          await plugin?.consumeForceFullFlag?.("checkin", true);
        }
        // If runId is missing, still best-effort clear when it was a one-shot run
        if (!ctx?.runId && getForceFullFlag()) {
          await plugin?.consumeForceFullFlag?.("checkin", true);
        }

        return ok({ indexSynced: 1 } as any);
      } catch (e: any) {
        // D5: 即使失败也不阻断其他功能；只返回 warn 结果，engine 仍会记录失败
        console.warn(`[RSLatte][checkin][${ctx.mode}] syncRecordIndexToDbNow failed`, e);
        return ok({ indexSynced: 0 } as any, ["INDEX_SYNC_FAILED"]);
      }
    },

    async getReconcileGate(_ctx) {
      const dbSyncEnabled = computeDbSyncEnabled();
      const gate = computeCheckinGateFromMeta(plugin, dbSyncEnabled) as any;
      gate.deltaSize = Number(lastDeltaSize ?? gate.deltaSize ?? 0);
      return ok(gate);
    },

    async reconcile(ctx) {
      const startedAt = new Date().toISOString();
      const dbSyncEnabled = computeDbSyncEnabled();
      const gate = computeCheckinGateFromMeta(plugin, dbSyncEnabled);
      
      // ✅ DEBUG: 记录 reconcile 开始
      const debugLogEnabled = (plugin?.settings as any)?.debugLogEnabled === true;
      if (debugLogEnabled) {
        console.log(`[RSLatte][checkin][reconcile] Starting reconcile: mode=${ctx.mode}, dbSyncEnabled=${dbSyncEnabled}`);
      }
      
      try {
        if (!dbSyncEnabled) {
          if (debugLogEnabled) {
            console.log(`[RSLatte][checkin][reconcile] Skipping: dbSyncEnabled=false`);
          }
          return ok(mkSummary(legacyCtxFromAtomic(ctx, "reconcile"), startedAt, { skipped: 1 }, "DBSYNC_DISABLED", gate));
        }

        // ✅ 对于 manual_refresh 模式，先检查增量扫描是否有变化
        // ✅ 只有在有变化时才进行全量重建和 reconcile API 调用
        let shouldReconcile = true;
        let incrementalScan: any = null;
        let r: any = null;
        
        if (ctx.mode === "manual_refresh") {
          try {
            await plugin?.recordRSLatte?.ensureReady?.();
            
            // ✅ DEBUG: 记录 reconcile 开始前的状态
            if (debugLogEnabled) {
              const lastScanMs = (plugin?.recordRSLatte as any)?.getLastDiaryScanMs?.() ?? 0;
              console.log(`[RSLatte][checkin][reconcile] manual_refresh: Starting incremental scan, lastScanMs=${new Date(lastScanMs).toISOString()} (${lastScanMs})`);
            }
            
            // ✅ manual_refresh 模式下，使用 forceIncludeEqualMtime=true 来扫描 mtime === sinceMs 的文件
            // ✅ 这样可以处理 Obsidian 缓存或文件系统时间精度问题，确保手动刷新时能检测到所有可能的变化
            incrementalScan = await plugin?.recordRSLatte?.scanIncrementalFromDiary?.({ modules: CHECKIN_MODULES, forceIncludeEqualMtime: true });
            
            // ✅ DEBUG: 记录增量扫描的结果
            if (debugLogEnabled) {
              console.log(`[RSLatte][checkin][reconcile] manual_refresh: Incremental scan result:`, {
                isNull: !incrementalScan,
                dayKeysScanned: incrementalScan?.dayKeysScanned?.size ?? 0,
                parsedByDay: incrementalScan?.parsedByDay?.size ?? 0,
                maxMtime: incrementalScan?.maxMtime,
                sinceMs: incrementalScan?.sinceMs,
              });
            }
            
            // ✅ 如果增量扫描返回 null，说明没有文件被修改，跳过 reconcile
            if (!incrementalScan) {
              shouldReconcile = false;
              console.log(`[RSLatte][checkin][reconcile] manual_refresh: No file changes detected, skipping reconcile API call`);
              r = { scannedDays: 0, clearedDays: 0, cutoffDate: null, dayKeysScanned: new Set<string>(), dayKeysToReplace: new Set<string>() };
            } else {
              // ✅ 即使 dayKeysScanned 为空，如果扫描到了文件（mtime 更新），也需要 reconcile（可能是删除）
              const hasScannedFiles = incrementalScan.dayKeysScanned && incrementalScan.dayKeysScanned.size > 0;
              const hasParsedRecords = incrementalScan.parsedByDay && incrementalScan.parsedByDay.size > 0;
              
              if (!hasScannedFiles && !hasParsedRecords) {
                // ✅ 这种情况不应该发生（因为我们已经修复了 scanIncrementalFromDiary），但为了安全起见
                console.warn(`[RSLatte][checkin][reconcile] manual_refresh: Incremental scan returned empty result, skipping reconcile`);
                shouldReconcile = false;
                r = { scannedDays: 0, clearedDays: 0, cutoffDate: null, dayKeysScanned: new Set<string>(), dayKeysToReplace: new Set<string>() };
              } else {
                // ✅ 对于 manual_refresh 模式，只对增量扫描检测到的日期进行 reconcile
                // ✅ 不需要进行全量重建，直接使用增量扫描的结果
                if (hasParsedRecords) {
                  console.log(`[RSLatte][checkin][reconcile] manual_refresh: Records detected (scannedDays=${incrementalScan.dayKeysScanned?.size ?? 0}), applying incremental scan first`);
                  // ✅ 先应用增量扫描，更新索引和 lastDiaryScanMs
                  await plugin?.recordRSLatte?.applyIncrementalScan?.(incrementalScan, { updateLists: true });
                  
                  // ✅ 使用增量扫描的结果，只对检测到的日期进行 reconcile
                  r = {
                    scannedDays: incrementalScan.dayKeysScanned?.size ?? 0,
                    clearedDays: 0,
                    cutoffDate: incrementalScan.cutoffDate ?? '',
                    dayKeysScanned: incrementalScan.dayKeysScanned ?? new Set<string>(),
                    dayKeysToReplace: incrementalScan.dayKeysScanned ?? new Set<string>(), // ✅ 增量扫描中，dayKeysScanned 就是需要替换的日期
                  };
                } else {
                  console.log(`[RSLatte][checkin][reconcile] manual_refresh: Files modified but no records found (possible deletions, scannedDays=${incrementalScan.dayKeysScanned?.size ?? 0}), updating lastDiaryScanMs and using incremental scan result for reconcile`);
                  // ✅ 文件被修改但没有记录，可能是删除，需要对这些日期进行 reconcile 来检测删除
                  // ✅ 更新 lastDiaryScanMs，避免下次扫描时跳过已修改的文件
                  if (incrementalScan.maxMtime && incrementalScan.maxMtime > 0) {
                    const currentLastMs = (plugin?.recordRSLatte as any)?.getLastDiaryScanMs?.() ?? 0;
                    if (incrementalScan.maxMtime > currentLastMs) {
                      (plugin?.recordRSLatte as any)?.setLastDiaryScanMs?.(incrementalScan.maxMtime);
                      await (plugin as any)?.saveSettings?.();
                    }
                  }
                  
                  // ✅ 对于删除的情况，使用增量扫描的结果
                  const dayKeysForReconcile = incrementalScan.dayKeysScanned ?? new Set<string>();
                  if (dayKeysForReconcile.size > 0) {
                    r = {
                      scannedDays: dayKeysForReconcile.size,
                      clearedDays: 0,
                      cutoffDate: incrementalScan.cutoffDate ?? '',
                      dayKeysScanned: dayKeysForReconcile,
                      dayKeysToReplace: dayKeysForReconcile, // ✅ 对于删除的情况，dayKeysScanned 就是需要替换的日期
                    };
                  } else {
                    r = { scannedDays: 0, clearedDays: 0, cutoffDate: null, dayKeysScanned: new Set<string>(), dayKeysToReplace: new Set<string>() };
                  }
                }
              }
            }
          } catch (e: any) {
            // ✅ 如果增量扫描失败，仍然进行全量重建（保守策略）
            console.warn(`[RSLatte][checkin][reconcile] Incremental scan failed, falling back to full rebuild:`, e);
            r = await plugin?.recordRSLatte?.rebuildIndexFromDiaryRange?.(true, true, CHECKIN_MODULES, true);
          }
        } else {
          // ✅ rebuild 模式：直接进行全量重建
          await plugin?.recordRSLatte?.ensureReady?.();
          r = await plugin?.recordRSLatte?.rebuildIndexFromDiaryRange?.(true, true, CHECKIN_MODULES, true);
        }
        
        // ✅ 调用后端 reconcile API 校准数据库中的记录（只有在需要时才调用）
        if (!shouldReconcile) {
          lastDeltaSize = 0;
          return ok(
            mkSummary(
              legacyCtxFromAtomic(ctx, "reconcile"),
              startedAt,
              { reconciled: 0, scannedDays: 0, clearedDays: 0, skipped: 1 },
              "NO_CHANGES_DETECTED",
              gate
            )
          );
        }
        
        const api = (plugin as any)?.api;
        if (!api?.checkinRecordsReconcile) {
          console.warn(`[RSLatte][checkin][reconcile] checkinRecordsReconcile API not available`);
        } else {
          try {
            // 获取当前索引中的打卡记录，构建 present_comp_keys
            const csnap = await plugin?.recordRSLatte?.getCheckinSnapshot?.(false);
            const items = (csnap?.items ?? []) as any[];
            
            // 构建 present_comp_keys: 格式为 "YYYY-MM-DD|checkin_id"
            const presentCompKeys = new Set<string>();
            const scopeDates = new Set<string>();
            
            for (const item of items) {
              if (item.isDelete) continue; // 跳过已删除的记录
              const recordDate = String(item.recordDate ?? "");
              const checkinId = String(item.checkinId ?? "");
              if (recordDate && checkinId && /^\d{4}-\d{2}-\d{2}$/.test(recordDate)) {
                presentCompKeys.add(`${recordDate}|${checkinId}`);
                scopeDates.add(recordDate);
              }
            }
            
            // ✅ 对于 manual_refresh 模式，只对增量扫描检测到的日期进行 reconcile
            // ✅ 对于 rebuild 模式，使用全量扫描的结果
            const dayKeysScanned = r?.dayKeysScanned;
            const dayKeysToReplace = r?.dayKeysToReplace;
            
            // ✅ 合并所有扫描到的日期和需要替换的日期
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
            
            // ✅ 对于 manual_refresh 模式，只使用增量扫描检测到的日期，不使用索引中的其他日期
            // ✅ 这样可以确保只对实际修改的文件进行 reconcile
            // ✅ 对于 rebuild 模式，如果没有扫描到任何日期，使用索引中存在的日期范围
            if (ctx.mode !== "manual_refresh" && allScannedDates.size === 0 && scopeDates.size > 0) {
              for (const d of scopeDates) allScannedDates.add(d);
            }
            
            const scannedDates = Array.from(allScannedDates).sort();
            
            // ✅ 只保留 scope_dates 范围内的 present_comp_keys
            // ✅ 这样可以确保 present_comp_keys 和 scope_dates 的日期范围一致
            const filteredPresentCompKeys = new Set<string>();
            if (scannedDates.length > 0) {
              const scopeDatesSet = new Set(scannedDates);
              for (const key of presentCompKeys) {
                // key 格式: "YYYY-MM-DD|checkin_id"
                const datePart = key.split('|')[0];
                if (scopeDatesSet.has(datePart)) {
                  filteredPresentCompKeys.add(key);
                }
              }
            } else {
              // ✅ 如果没有 scope_dates，使用所有 present_comp_keys（fallback）
              for (const key of presentCompKeys) {
                filteredPresentCompKeys.add(key);
              }
            }
            
            // ✅ DEBUG: 记录 reconcile 使用的日期范围
            if (debugLogEnabled) {
              console.log(`[RSLatte][checkin][reconcile] manual_refresh: Using scanned dates for reconcile:`, {
                mode: ctx.mode,
                scannedDatesCount: scannedDates.length,
                scannedDates: scannedDates,
                dayKeysScannedCount: dayKeysScanned?.size ?? 0,
                dayKeysToReplaceCount: dayKeysToReplace?.size ?? 0,
                presentCompKeysBeforeFilter: presentCompKeys.size,
                presentCompKeysAfterFilter: filteredPresentCompKeys.size,
              });
            }
            
            // ✅ 调试日志：记录 reconcile 的条件判断
            console.log(`[RSLatte][checkin][reconcile] Debug: scannedDates.length=${scannedDates.length}, presentCompKeys.size=${filteredPresentCompKeys.size} (filtered from ${presentCompKeys.size}), dayKeysScanned.size=${dayKeysScanned?.size ?? 0}, dayKeysToReplace.size=${dayKeysToReplace?.size ?? 0}`);
            
            // ✅ 即使没有扫描到日期，如果有索引记录，也要进行 reconcile（处理日记被完全清空的情况）
            // ✅ 如果扫描到了日期但没有任何记录，也要进行 reconcile（处理日记中记录被清空的情况）
            if (scannedDates.length > 0 || filteredPresentCompKeys.size > 0) {
              const reconcilePayload = {
                scope_dates: scannedDates.length > 0 ? scannedDates : Array.from(scopeDates).sort(),
                present_comp_keys: Array.from(filteredPresentCompKeys).sort(),
                scope_file_paths: [],
                dry_run: false,
              };
              
              console.log(`[RSLatte][checkin][reconcile] Calling checkinRecordsReconcile API with payload:`, {
                scope_dates_count: reconcilePayload.scope_dates.length,
                present_comp_keys_count: reconcilePayload.present_comp_keys.length,
                scope_dates: reconcilePayload.scope_dates.slice(0, 5), // 只显示前5个
                present_comp_keys: reconcilePayload.present_comp_keys.slice(0, 5), // 只显示前5个
              });
              
              const reconcileResp: any = await api.checkinRecordsReconcile(reconcilePayload);
              const markedDeleted = Number(reconcileResp?.marked_deleted ?? 0);
              const keep = Number(reconcileResp?.keep ?? 0);
              
              console.log(`[RSLatte][checkin][reconcile] API response: marked_deleted=${markedDeleted}, keep=${keep}`);
              
              lastDeltaSize = 0;
              return ok(
                mkSummary(
                  legacyCtxFromAtomic(ctx, "reconcile"),
                  startedAt,
                  { 
                    reconciled: 1, 
                    scannedDays: Number(r?.scannedDays ?? 0), 
                    clearedDays: Number(r?.clearedDays ?? 0),
                    marked_deleted: markedDeleted,
                    keep: keep,
                  },
                  `reconcile ok marked_deleted=${markedDeleted} keep=${keep}`,
                  gate
                )
              );
            } else {
              // ✅ 调试日志：记录为什么没有调用 API
              console.warn(`[RSLatte][checkin][reconcile] Skipping API call: scannedDates.length=${scannedDates.length}, presentCompKeys.size=${presentCompKeys.size}`);
            }
          } catch (e: any) {
            // ✅ 如果后端 reconcile 失败，记录警告但不阻断流程
            console.warn(`[RSLatte][checkin][reconcile] checkinRecordsReconcile failed:`, e);
          }
        }
        
        // ✅ 如果没有 API 或调用失败，仍然返回本地重建的结果
        lastDeltaSize = 0;
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
        return fail("CHECKIN_RECONCILE_FAILED", "Checkin reconcile failed", { message: e?.message ?? String(e) });
      }
    },

    async stats(_ctx) {
      const dbSyncEnabled = computeDbSyncEnabled();
      const gate = computeCheckinGateFromMeta(plugin, dbSyncEnabled);
      const st: RSLatteModuleStats = {
        moduleKey: "checkin",
        items: {
          pendingCount: Number((gate as any)?.pendingCount ?? 0),
          failedCount: Number((gate as any)?.failedCount ?? 0),
        },
      } as any;
      return ok(st);
    },
  };
}
