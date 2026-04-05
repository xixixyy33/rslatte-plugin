/**
 * Pipeline 和自动刷新管理模块
 * 包含 PipelineEngine 创建、自动刷新协调器、定时器等
 */
import { Notice } from "obsidian";
import type RSLattePlugin from "../main";
import { PipelineEngine } from "../services/pipeline/pipelineEngine";
import { AutoRefreshCoordinator } from "../services/pipeline/coordinator";
import { createDefaultModuleRegistry } from "../services/pipeline/moduleRegistry";
import { withProjectOutputAtomicSpecs } from "../services/pipeline/specRegistry";
import { SpaceStatsService } from "../services/space/spaceStatsService";
import { buildSpaceCtx } from "../services/space/spaceContext";
import { runE2SealPreviousPeriodReviewSnapshots } from "../ui/helpers/reviewE2SnapshotSeal";
import type { ModuleRegistry } from "../services/pipeline/moduleRegistry";
import type {
  ModuleSpec,
  ModuleSpecAny,
  ModuleSpecAtomic,
  RSLatteModuleOpContext,
  RSLatteAtomicOpContext,
  RSLatteModuleOpSummary,
  RSLatteModuleStats,
  RSLatteReconcileGate,
  RSLatteFlushQueueOptions,
} from "../services/pipeline/moduleSpec";
import type { RSLatteModuleKey, RSLatteResult } from "../services/pipeline/types";
import { buildPipelineModuleIsEnabled } from "./pipelineModuleEnabled";

export function createPipelineManager(plugin: RSLattePlugin) {
  // 私有字段访问
  const getPipelineRegistry = () => (plugin as any)._pipelineRegistry;
  const setPipelineRegistry = (reg: ModuleRegistry | null) => { (plugin as any)._pipelineRegistry = reg; };
  const getPipelineIsEnabled = () => (plugin as any)._pipelineIsEnabled;
  const setPipelineIsEnabled = (fn: ((moduleKey: RSLatteModuleKey) => boolean) | null) => { (plugin as any)._pipelineIsEnabled = fn; };
  const getAutoRefreshCoordinator = () => (plugin as any)._autoRefreshCoordinator;
  const setAutoRefreshCoordinator = (coord: AutoRefreshCoordinator | null) => { (plugin as any)._autoRefreshCoordinator = coord; };
  const getAutoRefreshTimer = () => (plugin as any)._autoRefreshTimer;
  const setAutoRefreshTimer = (timer: number | null) => { (plugin as any)._autoRefreshTimer = timer; };
  const getAutoRefreshTickRunning = () => (plugin as any)._autoRefreshTickRunning;
  const setAutoRefreshTickRunning = (running: boolean) => { (plugin as any)._autoRefreshTickRunning = running; };

  return {
    /**
     * 创建 PipelineEngine 实例
     * 这是最大的模块，约1000行代码
     */
    createPipelineEngine(): PipelineEngine {
      const ok = <T,>(data: T): RSLatteResult<T> => ({ ok: true, data });
      const fail = (message: string, detail?: any): RSLatteResult<never> => ({
        ok: false,
        error: { code: "OP_FAILED", message, detail },
      });

      const mkSummary = (
        ctx: RSLatteModuleOpContext,
        startedAt: string,
        metrics?: Record<string, number>,
        message?: string,
        gate?: RSLatteReconcileGate
      ): RSLatteModuleOpSummary => ({
        moduleKey: ctx.moduleKey,
        mode: ctx.mode,
        op: ctx.op,
        startedAt,
        finishedAt: new Date().toISOString(),
        metrics,
        message,
        gate,
      });

      const notImplemented = async (ctx: RSLatteModuleOpContext, tag: string): Promise<RSLatteResult<RSLatteModuleOpSummary>> => {
        const startedAt = new Date().toISOString();
        return ok(mkSummary(ctx, startedAt, undefined, `NOT_IMPLEMENTED:${tag}`));
      };

      const notImplementedStats = async (ctx: RSLatteModuleOpContext, tag: string): Promise<RSLatteResult<RSLatteModuleStats>> => {
        // stats 目前主要用于状态灯/tooltip；占位实现避免类型不匹配
        return ok({ moduleKey: ctx.moduleKey, items: { notImplemented: tag } } as any);
      };

      const computeTaskMemoGate = async (
        type: "task" | "memo",
        dbSyncEnabled: boolean
      ): Promise<RSLatteReconcileGate> => {
        const gate: RSLatteReconcileGate = { dbSyncEnabled };
        if (!dbSyncEnabled) return gate;

        try {
          const store = (plugin as any)?.taskRSLatte?.store;
          if (!store || typeof store.readIndex !== "function") return gate;

          const idx: any = await store.readIndex(type);
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
          // deltaSize：用于 reconcile 门控阈值；此处用"待同步总量"的近似值。
          gate.deltaSize = pending + failed;
        } catch {
          // ignore
        }

        return gate;
      };

      const computeRecordGate = (
        moduleKey: "checkin" | "finance",
        dbSyncEnabled: boolean
      ): RSLatteReconcileGate => {
        const gate: RSLatteReconcileGate = { dbSyncEnabled };
        if (!dbSyncEnabled) return gate;
        try {
          const meta: any = (plugin as any)?._dbSyncMeta?.[moduleKey] ?? {};
          const pending = Number(meta?.pendingCount ?? 0);
          const failed = Number(meta?.failedCount ?? 0);
          gate.pendingCount = pending;
          gate.failedCount = failed;
          gate.deltaSize = pending + failed;
        } catch {
          // ignore
        }
        return gate;
      };

      const buildRecordManualIncremental = async (
        ctx: RSLatteModuleOpContext,
        modules: { checkin: boolean; finance: boolean }
      ): Promise<RSLatteResult<RSLatteModuleOpSummary>> => {
        const startedAt = new Date().toISOString();

        const dbSyncEnabled: boolean = (() => {
          if (ctx.moduleKey === "checkin") return (plugin as any)?.isCheckinDbSyncEnabled?.() === true;
          if (ctx.moduleKey === "finance") return (plugin as any)?.isFinanceDbSyncEnabled?.() === true;
          return (plugin as any)?.isRSLatteDbSyncEnabled?.() === true;
        })();

        if (!plugin.tryBeginRecordManualOp("refresh")) {
          return ok(mkSummary(ctx, startedAt, { skippedByPluginGuard: 1 }, "SKIPPED_BY_PLUGIN_GUARD"));
        }

        try {
          if (!plugin.recordRSLatte) return fail("RecordRSLatte not ready");

          // ✅ C2: manual_refresh 也走增量逻辑（复用 auto 的增量扫描），不再走 rebuildRange
          await plugin.recordRSLatte.ensureReady?.();
          // ✅ 传递 modules 参数，确保只刷新指定的模块（避免刷新 finance 时也触发 checkin 的扫描）
          await plugin.recordRSLatte.refreshIndexIncrementalFromDiary?.({ updateLists: true, modules });

          // 若增量扫描过程中发现新的清单项，则合并回 settings，并触发一次 settings-save（用于清单 DB sync）
          const merged = await plugin.recordRSLatte.mergeListsIndexIntoSettings?.();
          const mergedTouched =
            !!merged &&
            ((modules.checkin && (merged.addedCheckins ?? 0) > 0) || (modules.finance && (merged.addedFinance ?? 0) > 0));

          if (mergedTouched) {
            await plugin.saveSettings();
          }

          let listsSynced = 0;
          let indexSynced = 0;

          if (dbSyncEnabled && (plugin as any)?.isRSLatteDbSyncEnabled?.() && (plugin as any)?.isModuleEnabled?.("record") !== false) {
            try {
              // 手动刷新：强制同步一次清单（避免 lastKey 导致"新增清单项未入库"）
              await (plugin as any).syncRecordListsToDbNow?.(true, { modules });
              listsSynced = 1;
            } catch (e) {
              console.warn(`[RSLatte][${ctx.moduleKey}][${ctx.mode}] syncRecordListsToDbNow failed`, e);
            }

            try {
              await (plugin as any).syncRecordIndexToDbNow?.({ reason: `manual_refresh_${ctx.moduleKey}`, modules });
              indexSynced = 1;
            } catch (e) {
              console.warn(`[RSLatte][${ctx.moduleKey}][${ctx.mode}] syncRecordIndexToDbNow failed`, e);
            }
          }

          const gate =
            ctx.moduleKey === "checkin"
              ? computeRecordGate("checkin", dbSyncEnabled)
              : ctx.moduleKey === "finance"
              ? computeRecordGate("finance", dbSyncEnabled)
              : ({ dbSyncEnabled } as RSLatteReconcileGate);

          const metrics: Record<string, number> = {
            refreshed: 1,
            mergedAddedCheckins: Number(modules.checkin ? (merged?.addedCheckins ?? 0) : 0),
            mergedAddedFinance: Number(modules.finance ? (merged?.addedFinance ?? 0) : 0),
            listsSynced,
            indexSynced,
          };

          return ok(mkSummary(ctx, startedAt, metrics, mergedTouched ? "MERGED_LISTS_INTO_SETTINGS" : undefined, gate));
        } catch (e: any) {
          return fail("Record manual incremental refresh failed", { message: e?.message ?? String(e) });
        } finally {
          plugin.endRecordManualOp("refresh");
        }
      };

      const buildRecordRebuild = async (
        ctx: RSLatteModuleOpContext,
        modules: { checkin: boolean; finance: boolean }
      ): Promise<RSLatteResult<RSLatteModuleOpSummary>> => {
        const startedAt = new Date().toISOString();

        const dbSyncEnabled: boolean = (() => {
          if (ctx.moduleKey === "checkin") return (plugin as any)?.isCheckinDbSyncEnabled?.() === true;
          if (ctx.moduleKey === "finance") return (plugin as any)?.isFinanceDbSyncEnabled?.() === true;
          return (plugin as any)?.isRSLatteDbSyncEnabled?.() === true;
        })();

        if (!plugin.tryBeginRecordManualOp("refresh")) {
          return ok(mkSummary(ctx, startedAt, { skippedByPluginGuard: 1 }, "SKIPPED_BY_PLUGIN_GUARD"));
        }

        try {
          if (!plugin.recordRSLatte) return fail("RecordRSLatte not ready");

          const r = await plugin.recordRSLatte.rebuildIndexFromDiaryRange(true, true, modules, true);

          // 若扫描过程中发现新的清单项，则合并回 settings，并触发一次 settings-save（用于清单 DB sync）
          const merged = await plugin.recordRSLatte.mergeListsIndexIntoSettings?.();

          const mergedTouched =
            !!merged &&
            ((modules.checkin && (merged.addedCheckins ?? 0) > 0) || (modules.finance && (merged.addedFinance ?? 0) > 0));

          if (mergedTouched) {
            await plugin.saveSettings();
          }

          let listsSynced = 0;
          let indexSynced = 0;

          if (dbSyncEnabled && (plugin as any)?.isRSLatteDbSyncEnabled?.() && (plugin as any)?.isModuleEnabled?.("record") !== false) {
            try {
              await (plugin as any).syncRecordListsToDbNow?.(true, { modules });
              listsSynced = 1;
            } catch (e) {
              console.warn(`[RSLatte][${ctx.moduleKey}][${ctx.mode}] syncRecordListsToDbNow failed`, e);
            }

            try {
              await (plugin as any).syncRecordIndexToDbNow?.({ reason: `manual_rebuild_${ctx.moduleKey}`, modules });
              indexSynced = 1;
            } catch (e) {
              console.warn(`[RSLatte][${ctx.moduleKey}][${ctx.mode}] syncRecordIndexToDbNow failed`, e);
            }
          }

          const gate =
            ctx.moduleKey === "checkin"
              ? computeRecordGate("checkin", dbSyncEnabled)
              : ctx.moduleKey === "finance"
              ? computeRecordGate("finance", dbSyncEnabled)
              : ({ dbSyncEnabled } as RSLatteReconcileGate);

          const metrics: Record<string, number> = {
            scannedDays: Number(r?.scannedDays ?? 0),
            clearedDays: Number(r?.clearedDays ?? 0),
            mergedAddedCheckins: Number(modules.checkin ? (merged?.addedCheckins ?? 0) : 0),
            mergedAddedFinance: Number(modules.finance ? (merged?.addedFinance ?? 0) : 0),
            listsSynced,
            indexSynced,
          };

          return ok(mkSummary(ctx, startedAt, metrics, mergedTouched ? "MERGED_LISTS_INTO_SETTINGS" : undefined, gate));
        } catch (e: any) {
          return fail("Record rebuild failed", { message: e?.message ?? String(e) });
        } finally {
          plugin.endRecordManualOp("refresh");
        }
      };

      const buildRecordArchive = async (
        ctx: RSLatteModuleOpContext,
        modules: { checkin: boolean; finance: boolean }
      ): Promise<RSLatteResult<RSLatteModuleOpSummary>> => {
        const startedAt = new Date().toISOString();
        const isAuto = ctx.mode === "auto_archive";
        const isManual = ctx.mode === "manual_archive";

        // auto_archive：若 record 正在手动操作中，则跳过（避免并发冲突）
        if (isAuto && plugin.isRecordManualBusy()) {
          return ok(mkSummary(ctx, startedAt, { skippedByPluginGuard: 1 }, "SKIPPED_RECORD_MANUAL_BUSY"));
        }

        // manual_archive：保持旧的"record 手动互斥"保护
        if (isManual) {
          if (!plugin.tryBeginRecordManualOp("archive")) {
            return ok(mkSummary(ctx, startedAt, { skippedByPluginGuard: 1 }, "SKIPPED_BY_PLUGIN_GUARD"));
          }
        }

        try {
          if (!plugin.recordRSLatte) return fail("RecordRSLatte not ready");

          const r: any = await plugin.recordRSLatte.archiveNow(modules);
          const archivedCount = modules.checkin ? Number(r?.checkinArchived ?? 0) : Number(r?.financeArchived ?? 0);
          const listsArchived = modules.checkin ? Number(r?.listsArchivedCheckin ?? 0) : Number(r?.listsArchivedFinance ?? 0);

          const metrics: Record<string, number> = {
            archivedCount,
            listsArchived,
          };

          return ok(mkSummary(ctx, startedAt, metrics, String(r?.cutoffDate ?? "")));
        } catch (e: any) {
          return fail("Record archive failed", { message: e?.message ?? String(e) });
        } finally {
          if (isManual) plugin.endRecordManualOp("archive");
        }
      };

      // B2：auto refresh 复用旧的自动刷新逻辑（增量，不 reconcile；保留原调度策略）
      const buildRecordAutoRefresh = async (ctx: RSLatteModuleOpContext): Promise<RSLatteResult<RSLatteModuleOpSummary>> => {
        const startedAt = new Date().toISOString();
        const reason = "auto_timer";

        // ✅ Step4：若正在手动刷新/归档，则自动刷新跳过 record（避免并发冲突）
        if (plugin.isRecordManualBusy()) {
          return ok(mkSummary(ctx, startedAt, { skippedByPluginGuard: 1 }, "SKIPPED_RECORD_MANUAL_BUSY"));
        }

        try {
          await plugin.recordRSLatte?.ensureReady?.();
          await plugin.recordRSLatte?.refreshIndexIncrementalFromDiary?.({ updateLists: true });

          let listsSynced = 0;
          let indexSynced = 0;

          if ((plugin as any)?.isRSLatteDbSyncEnabled?.()) {
            try {
              await (plugin as any).autoSyncRecordListsToDb?.({ reason });
              listsSynced = 1;
            } catch (e) {
              console.warn(`[RSLatte][${ctx.moduleKey}][${ctx.mode}] autoSyncRecordListsToDb failed`, e);
            }

            try {
              await (plugin as any).autoSyncRecordIndexToDb?.({ reason });
              indexSynced = 1;
            } catch (e) {
              console.warn(`[RSLatte][${ctx.moduleKey}][${ctx.mode}] autoSyncRecordIndexToDb failed`, e);
            }
          }

          return ok(mkSummary(ctx, startedAt, { refreshed: 1, listsSynced, indexSynced }, "OK"));
        } catch (e: any) {
          return fail("Record auto refresh failed", { message: e?.message ?? String(e) });
        }
      };

      // =========================
      // Task / Memo
      // =========================

      const makeTaskMemoSpec = (
        moduleKey: "task" | "memo",
        label: string,
        opts?: { includeAtomic?: boolean }
      ): ModuleSpecAny => {
        const includeAtomic = opts?.includeAtomic !== false;
        const modules = moduleKey === "task" ? { task: true, memo: false } : { task: false, memo: true };

        // Step S1: do NOT rely on free variables; always reference plugin methods
        // (prevents runtime ReferenceError after bundling)
        const computeDbSyncEnabled = () => (moduleKey === "task" ? plugin.isTaskDbSyncEnabledV2() : plugin.isMemoDbSyncEnabledV2());

        let lastDeltaSize = 0; // for reconcile gate

        // legacy 能力（兼容 engine.run）
        const legacy: ModuleSpec = {
          key: moduleKey,
          label,
          incrementalRefresh: async (ctx) => {
            try {
              await plugin.taskRSLatte?.ensureReady?.();
              await plugin.taskRSLatte?.refreshIndexAndSync?.({ sync: computeDbSyncEnabled(), noticeOnError: ctx.mode !== "auto_refresh", modules });
              return ok(mkSummary(ctx, new Date().toISOString(), { refreshed: 1 }, "OK"));
            } catch (e: any) {
              return fail("Task/Memo incrementalRefresh failed", { message: e?.message ?? String(e) });
            }
          },
          rebuild: async (ctx) => {
            try {
              await plugin.taskRSLatte?.ensureReady?.();
              await plugin.taskRSLatte?.refreshIndexAndSync?.({ sync: computeDbSyncEnabled(), noticeOnError: true, forceFullSync: true, modules });
              return ok(mkSummary(ctx, new Date().toISOString(), { rebuilt: 1 }, "OK"));
            } catch (e: any) {
              return fail("Task/Memo rebuild failed", { message: e?.message ?? String(e) });
            }
          },
          archive: async (ctx) => {
            try {
              await plugin.taskRSLatte?.ensureReady?.();
              const r: any = await plugin.taskRSLatte?.archiveNow?.(modules);
              return ok(mkSummary(ctx, new Date().toISOString(), { archivedCount: Number(r?.archivedCount ?? 0) }, String(r?.cutoffDate ?? "")));
            } catch (e: any) {
              return fail("Task/Memo archive failed", { message: e?.message ?? String(e) });
            }
          },
          // legacy reconcile/stats 不再使用（E2 会走 engine.runE2）
          reconcile: (ctx) => notImplemented(ctx, `${moduleKey}:reconcile`),
          stats: async (ctx) => {
            const gate = await computeTaskMemoGate(moduleKey, computeDbSyncEnabled());
            return ok({ moduleKey: ctx.moduleKey, items: { pendingCount: Number((gate as any)?.pendingCount ?? 0), failedCount: Number((gate as any)?.failedCount ?? 0) } } as any);
          },
        };

        // atomic 能力（用于 engine.runE2）
        const atomic: ModuleSpecAtomic = {
          key: moduleKey,
          label,

          async scanIncremental(ctx) {
            try {
              await plugin.taskRSLatte?.ensureReady?.();
              const fixUidAndMeta = ctx.mode !== "auto_refresh";
              const scan: any = await plugin.taskRSLatte?.e2ScanIncremental?.(modules, { fixUidAndMeta });

              // Hardening: the service expects {modules,tasks,memos}. Some older scan results may
              // omit modules or return undefined arrays, which would make applyDelta fail.
              const normalizedScan: any = {
                ...(scan ?? {}),
                modules,
                tasks: Array.isArray(scan?.tasks) ? scan.tasks : [],
                memos: Array.isArray(scan?.memos) ? scan.memos : [],
                includedFilePaths: Array.isArray(scan?.includedFilePaths) ? scan.includedFilePaths : [],
                fullScan: false,
              };
              // deltaSize: 粗略估计（扫描到的行数；实际变更量需要更精细的 cache diff）
              lastDeltaSize = Math.min(100000, Number((normalizedScan?.tasks?.length ?? 0) + (normalizedScan?.memos?.length ?? 0)));
              return ok(normalizedScan);
            } catch (e: any) {
              return fail("Task/Memo scanIncremental failed", { message: e?.message ?? String(e) });
            }
          },

          async applyDelta(_ctx, scan: any) {
            try {
              await plugin.taskRSLatte?.ensureReady?.();
              const applied: any = await plugin.taskRSLatte?.e2ApplyScanToIndex?.(scan);
              return ok({ ...(applied ?? {}), modules, forceFullSync: false });
            } catch (e: any) {
              return fail("Task/Memo applyDelta failed", { message: e?.message ?? String(e) });
            }
          },

          async scanFull(_ctx) {
            try {
              await plugin.taskRSLatte?.ensureReady?.();
              const scan: any = await plugin.taskRSLatte?.e2ScanFull?.(modules);

              const normalizedScan: any = {
                ...(scan ?? {}),
                modules,
                tasks: Array.isArray(scan?.tasks) ? scan.tasks : [],
                memos: Array.isArray(scan?.memos) ? scan.memos : [],
                includedFilePaths: Array.isArray(scan?.includedFilePaths) ? scan.includedFilePaths : [],
                fullScan: true,
              };

              lastDeltaSize = Math.min(100000, Number((normalizedScan?.tasks?.length ?? 0) + (normalizedScan?.memos?.length ?? 0)));
              return ok(normalizedScan);
            } catch (e: any) {
              return fail("Task/Memo scanFull failed", { message: e?.message ?? String(e) });
            }
          },

          async replaceAll(_ctx, scan: any) {
            try {
              await plugin.taskRSLatte?.ensureReady?.();
              const applied: any = await plugin.taskRSLatte?.e2ApplyScanToIndex?.(scan);
              return ok({ ...(applied ?? {}), modules, forceFullSync: true });
            } catch (e: any) {
              return fail("Task/Memo replaceAll failed", { message: e?.message ?? String(e) });
            }
          },

          async archiveOutOfRange(ctx) {
            const startedAt = new Date().toISOString();
            try {
              await plugin.taskRSLatte?.ensureReady?.();
              const r: any = await plugin.taskRSLatte?.archiveNow?.(modules);
              return ok(mkSummary(legacyCtxFromAtomic(ctx, "archive"), startedAt, { archivedCount: Number(r?.archivedCount ?? 0) }, String(r?.cutoffDate ?? "")));
            } catch (e: any) {
              return fail("Task/Memo archiveOutOfRange failed", { message: e?.message ?? String(e) });
            }
          },

          async buildOps(_ctx, applied: any) {
            try {
              await plugin.taskRSLatte?.ensureReady?.();
              const forceFullSync = applied?.forceFullSync === true;
              const r: any = await plugin.taskRSLatte?.e2BuildOps?.(modules, { forceFullSync });
              return ok(r ?? { enqueued: 0 });
            } catch (e: any) {
              return fail("Task/Memo buildOps failed", { message: e?.message ?? String(e) });
            }
          },

          async flushQueue(ctx, opts) {
            try {
              await plugin.taskRSLatte?.ensureReady?.();
              const tp = plugin.settings.taskPanel;
              const raw = Number(tp?.upsertBatchSize ?? 50);
              const batchSize = Math.max(1, Math.min(500, Number.isFinite(raw) ? Math.floor(raw) : 50));
              const manualRetryNow = ctx.mode !== "auto_refresh" && ctx.mode !== "auto_archive";
              await plugin.taskRSLatte?.flushQueue?.(batchSize, 10, { drainAll: !!opts?.drainAll, manualRetryNow });
              return ok({ flushed: 1 });
            } catch (e: any) {
              return fail("Task/Memo flushQueue failed", { message: e?.message ?? String(e) });
            }
          },

          async getReconcileGate(_ctx) {
            const gate = await computeTaskMemoGate(moduleKey, computeDbSyncEnabled()) as any;
            gate.deltaSize = Number(lastDeltaSize ?? 0);
            return ok(gate);
          },

          async reconcile(ctx, input: any) {
            const startedAt = new Date().toISOString();
            const gate = await computeTaskMemoGate(moduleKey, computeDbSyncEnabled());
            try {
              if (computeDbSyncEnabled() !== true) {
                return ok(mkSummary(legacyCtxFromAtomic(ctx, "reconcile"), startedAt, { skipped: 1 }, "DBSYNC_DISABLED", gate));
              }
              await plugin.taskRSLatte?.ensureReady?.();
              const scan = input?.scan ?? {};
              await plugin.taskRSLatte?.e2ReconcileForType?.(moduleKey, scan);
              // reconcile 完成后，deltaSize 归零（避免同一次刷新重复触发 reconcile）
              lastDeltaSize = 0;
              return ok(mkSummary(legacyCtxFromAtomic(ctx, "reconcile"), startedAt, { reconciled: 1 }, "OK", gate));
            } catch (e: any) {
              return fail("Task/Memo reconcile failed", { message: e?.message ?? String(e) });
            }
          },

          async stats(_ctx) {
            try {
              await plugin.taskRSLatte?.ensureReady?.();
              await plugin.taskRSLatte?.reportDbSyncCounts?.(modules as any);
            } catch {}
            const gate = await computeTaskMemoGate(moduleKey, computeDbSyncEnabled());
            const st: RSLatteModuleStats = {
              moduleKey,
              items: {
                pendingCount: Number((gate as any)?.pendingCount ?? 0),
                failedCount: Number((gate as any)?.failedCount ?? 0),
              },
            } as any;
            return ok(st);
          },
        };

        if (!includeAtomic) return legacy as any;
        return { ...(legacy as any), ...(atomic as any) } as any;
      };

      // ✅ D3：task atomic spec 已抽到 src/services/pipeline/specs/taskSpecAtomic.ts
      // ✅ D4：memo atomic spec 已抽到 src/services/pipeline/specs/memoSpecAtomic.ts
      // 这里保留 legacy 能力（engine.run）；engine.runE2 由 specRegistry 合并 atomic。
      const taskSpec: ModuleSpecAny = makeTaskMemoSpec("task", "Task", { includeAtomic: false });
      const memoSpec: ModuleSpecAny = makeTaskMemoSpec("memo", "Memo", { includeAtomic: false });

      const legacyCtxFromAtomic = (ctx: RSLatteAtomicOpContext, op: any): RSLatteModuleOpContext => ({
        moduleKey: ctx.moduleKey,
        mode: ctx.mode,
        op,
        requestedAt: ctx.requestedAt,
        reason: ctx.reason,
      });

      // 未使用的函数，保留以备将来使用
      // const mkAtomicReconcileSummary = (
      //   ctx: RSLatteAtomicOpContext,
      //   startedAt: string,
      //   gate?: RSLatteReconcileGate
      // ): RSLatteModuleOpSummary => ({
      //   moduleKey: ctx.moduleKey,
      //   mode: ctx.mode,
      //   op: "reconcile",
      //   startedAt,
      //   finishedAt: new Date().toISOString(),
      //   metrics: { noop: 1 },
      //   message: "NO_RECONCILE_FOR_RECORD",
      //   gate,
      // });

      const mkRecordAtomicStats = (moduleKey: "checkin" | "finance", dbSyncEnabled: boolean): RSLatteModuleStats => {
        const gate = computeRecordGate(moduleKey, dbSyncEnabled);
        return {
          moduleKey,
          items: {
            pendingCount: Number((gate as any)?.pendingCount ?? 0),
            failedCount: Number((gate as any)?.failedCount ?? 0),
          },
        } as any;
      };

      const makeRecordSpec = (
        moduleKey: "checkin" | "finance",
        label: string,
        modules: { checkin: boolean; finance: boolean },
        opts?: { coalesceAuto?: boolean; includeAtomic?: boolean }
      ): ModuleSpecAny => {
        const coalesceAuto = opts?.coalesceAuto === true;
        const includeAtomic = opts?.includeAtomic !== false;

        let lastDeltaSize = 0;

        const computeDbSyncEnabled = (): boolean => {
          if (moduleKey === "checkin") return (plugin as any)?.isCheckinDbSyncEnabled?.() === true;
          if (moduleKey === "finance") return (plugin as any)?.isFinanceDbSyncEnabled?.() === true;
          return (plugin as any)?.isRSLatteDbSyncEnabled?.() === true;
        };

        // legacy 能力（兼容 engine.run）
        const legacy: ModuleSpec = {
          key: moduleKey,
          label,
          incrementalRefresh: async (ctx) =>
            ctx.mode === "auto_refresh" && coalesceAuto
              ? Promise.resolve(ok(mkSummary(ctx, new Date().toISOString(), { coalescedWithCheckin: 1 }, "COALESCED_WITH_CHECKIN")))
              : ctx.mode === "auto_refresh"
              ? buildRecordAutoRefresh(ctx)
              : buildRecordManualIncremental(ctx, modules),
          rebuild: (ctx) => buildRecordRebuild(ctx, modules),
          archive: (ctx) => buildRecordArchive(ctx, modules),
          reconcile: (ctx) => notImplemented(ctx, `${moduleKey}:reconcile`),
          stats: async (ctx) => {
            const dbSyncEnabled = computeDbSyncEnabled();
            const gate = computeRecordGate(moduleKey, dbSyncEnabled);
            const st: RSLatteModuleStats = {
              moduleKey: ctx.moduleKey,
              items: {
                pendingCount: Number((gate as any)?.pendingCount ?? 0),
                failedCount: Number((gate as any)?.failedCount ?? 0),
              },
            } as any;
            return ok(st);
          },
        };

        // E2 atomic 能力（用于 engine.runE2）
        const atomic: ModuleSpecAtomic = {
          key: moduleKey,
          label,

          async scanIncremental(ctx) {
            // finance auto_refresh: 与 checkin 共用一次扫描（避免双扫）
            if ((ctx.mode === "auto_refresh" || ctx.mode === "auto") && coalesceAuto) {
              return ok({ coalesced: true, modules });
            }
            try {
              await plugin.recordRSLatte?.ensureReady?.();
              const scan: any = await plugin.recordRSLatte?.scanIncrementalFromDiary?.({ modules });
              return ok(scan ?? { empty: true, modules, kind: "incremental" });
            } catch (e: any) {
              return fail("Record scanIncremental failed", { message: e?.message ?? String(e) });
            }
          },

          async applyDelta(ctx, scan: any) {
            if ((ctx.mode === "auto_refresh" || ctx.mode === "auto") && coalesceAuto) {
              lastDeltaSize = 0;
              return ok({ coalescedWithCheckin: 1 });
            }
            if (scan?.empty) {
              lastDeltaSize = 0;
              return ok({ changedDays: 0 });
            }
            try {
              await plugin.recordRSLatte?.ensureReady?.();
              const applied: any = await plugin.recordRSLatte?.applyIncrementalScan?.(scan, { updateLists: true });
              lastDeltaSize = Number(applied?.changedDays ?? applied?.scannedDays ?? 0);
              return ok(applied ?? { changedDays: 0 });
            } catch (e: any) {
              return fail("Record applyDelta failed", { message: e?.message ?? String(e) });
            }
          },

          async scanFull(_ctx) {
            try {
              await plugin.recordRSLatte?.ensureReady?.();
              const scan: any = await plugin.recordRSLatte?.scanFullFromDiaryRange?.({
                reconcileMissingDays: true,
                modules,
                scanAllDiaryDates: _ctx?.mode === "rebuild",
              });
              return ok(scan ?? { empty: true, modules, kind: "full" });
            } catch (e: any) {
              return fail("Record scanFull failed", { message: e?.message ?? String(e) });
            }
          },

          async replaceAll(_ctx, scan: any) {
            try {
              await plugin.recordRSLatte?.ensureReady?.();
              if (scan?.empty) {
                lastDeltaSize = 0;
                return ok({ changedDays: 0 });
              }
              const applied: any = await plugin.recordRSLatte?.applyFullReplace?.(scan, { updateLists: true });
              lastDeltaSize = Number(applied?.changedDays ?? applied?.scannedDays ?? 0);
              return ok(applied ?? { changedDays: 0 });
            } catch (e: any) {
              return fail("Record replaceAll failed", { message: e?.message ?? String(e) });
            }
          },

          async archiveOutOfRange(ctx) {
            const startedAt = new Date().toISOString();
            try {
              await plugin.recordRSLatte?.ensureReady?.();
              const r: any = await plugin.recordRSLatte?.archiveNow?.(modules);
              const archivedCount = modules.checkin ? Number(r?.checkinArchived ?? 0) : Number(r?.financeArchived ?? 0);
              const listsArchived = modules.checkin ? Number(r?.listsArchivedCheckin ?? 0) : Number(r?.listsArchivedFinance ?? 0);
              return ok(mkSummary(legacyCtxFromAtomic(ctx, "archive"), startedAt, { archivedCount, listsArchived }, String(r?.cutoffDate ?? "")));
            } catch (e: any) {
              return fail("Record archiveOutOfRange failed", { message: e?.message ?? String(e) });
            }
          },

          async buildOps(ctx, _applied) {
            try {
              const force = ctx.mode === "rebuild";
              // 先同步清单（打卡项/分类）确保 FK/字典存在
              await plugin.syncRecordListsToDb?.(modules);
              return ok({ listsSynced: 1, force });
            } catch (e: any) {
              console.warn(`[RSLatte][${ctx.moduleKey}][${ctx.mode}] syncRecordListsToDbNow failed`, e);
              return ok({ listsSynced: 0 });
            }
          },

          async flushQueue(_ctx, _opts: RSLatteFlushQueueOptions) {
            try {
              // syncRecordIndexToDbNow 方法不存在，使用 flushActiveIndexes 代替
              await plugin.recordRSLatte?.flushActiveIndexes?.();
              return ok({ indexSynced: 1 });
            } catch (e: any) {
              return fail("Record flushQueue failed", { message: e?.message ?? String(e) });
            }
          },

          async getReconcileGate(_ctx) {
            const dbSyncEnabled = computeDbSyncEnabled();
            const gate = computeRecordGate(moduleKey, dbSyncEnabled) as any;
            // deltaSize：本次变更规模（用于 reconcile 门控）
            gate.deltaSize = Number(lastDeltaSize ?? gate.deltaSize ?? 0);
            return ok(gate);
          },

          async reconcile(ctx) {
            const startedAt = new Date().toISOString();
            const dbSyncEnabled = computeDbSyncEnabled();
            const gate = computeRecordGate(moduleKey, dbSyncEnabled);
            try {
              await plugin.recordRSLatte?.ensureReady?.();
              const r: any = await plugin.recordRSLatte?.rebuildIndexFromDiaryRange?.(true, true, modules);
              lastDeltaSize = 0;
              return ok(mkSummary(legacyCtxFromAtomic(ctx, "reconcile"), startedAt, { reconciled: 1, scannedDays: Number(r?.scannedDays ?? 0), clearedDays: Number(r?.clearedDays ?? 0) }, String(r?.cutoffDate ?? ""), gate));
            } catch (e: any) {
              return fail("Record reconcile failed", { message: e?.message ?? String(e) });
            }
          },

          async stats(_ctx) {
            const dbSyncEnabled = computeDbSyncEnabled();
            return ok(mkRecordAtomicStats(moduleKey, dbSyncEnabled));
          },
        };

        if (!includeAtomic) return legacy as any;
        // 返回同时具备 legacy + atomic 的对象，便于渐进切换调用点
        if (!includeAtomic) return legacy as any;
        return { ...(legacy as any), ...(atomic as any) } as any;
      };

      // ✅ D5：checkin atomic spec 已抽到 src/services/pipeline/specs/checkinSpecAtomic.ts
      // 这里保留 legacy 能力（engine.run）；engine.runE2 由 specRegistry 合并 atomic。
      const checkinSpec: ModuleSpecAny = makeRecordSpec("checkin", "Checkin", { checkin: true, finance: false }, { includeAtomic: false });

      // ✅ D6：finance atomic spec 已抽到 src/services/pipeline/specs/financeSpecAtomic.ts
      // 这里保留 legacy 能力（engine.run）；engine.runE2 由 specRegistry 合并 atomic。
      const financeSpec: ModuleSpecAny = makeRecordSpec("finance", "Finance", { checkin: false, finance: true }, { coalesceAuto: true, includeAtomic: false });

      const projectSpec: ModuleSpec = {
        key: "project",
        label: "Project",
        // incrementalRefresh 仅供 engine.run 兼容；自动/手动增量主路径为 coordinator.tick → runE2 + projectSpecAtomic（scan/apply/buildOps/flush）
        incrementalRefresh: async (ctx) =>
          ok(mkSummary(ctx, new Date().toISOString(), { skipped: 1 }, "USE_ATOMIC_SPEC")),
        rebuild: async (ctx) => {
          const startedAt = new Date().toISOString();
          try {
            await plugin.projectMgr.manualRefreshAndSync();
            await (plugin as any).writeTodayProjectProgressToJournal?.();
            return ok(mkSummary(ctx, startedAt, { rebuilt: 1 }, "OK", { dbSyncEnabled: false }));
          } catch (e: any) {
            return fail("Project rebuild failed", { message: e?.message ?? String(e) });
          }
        },
        archive: async (ctx) => {
          const startedAt = new Date().toISOString();
          try {
            const n = await plugin.projectMgr.archiveDoneAndCancelledNow();
            await (plugin as any).writeTodayProjectProgressToJournal?.();
            return ok(mkSummary(ctx, startedAt, { archivedCount: Number(n ?? 0) }, "OK"));
          } catch (e: any) {
            return fail("Project archive failed", { message: e?.message ?? String(e) });
          }
        },
        reconcile: (ctx) => notImplemented(ctx, "project:reconcile"),
        stats: (ctx) => notImplementedStats(ctx, "project:stats"),
      };

      const outputSpec: ModuleSpec = {
        key: "output",
        label: "Output",
        // ✅ incrementalRefresh 不会被 engine.runE2 调用，但为了类型兼容性保留
        // engine.runE2 会直接调用 outputSpecAtomic 的 scanIncremental、applyDelta 等方法
        // 自动刷新和手动刷新都会走相同的 pipeline 流程，只是手动刷新会执行 reconcile，自动刷新不会
        incrementalRefresh: async (ctx) => {
          // 这个方法不会被 engine.runE2 调用，但为了类型兼容性保留
          // 实际执行会走 outputSpecAtomic 的 pipeline 流程
          return ok(mkSummary(ctx, new Date().toISOString(), { skipped: 1 }, "USE_ATOMIC_SPEC"));
        },
        rebuild: async (ctx) => {
          const startedAt = new Date().toISOString();
          try {
            const okRun = await plugin.runOutputManualOp("重建", async () => {
              await plugin.outputRSLatte?.ensureReady?.();
              await plugin.outputRSLatte?.refreshIndexNow({ mode: "full" });
              if ((plugin.settings.outputPanel as any)?.enableDbSync) {
                await (plugin as any).syncOutputFilesToDb?.({ reason: "rebuild" });
              }
              // 无论是否启用数据库同步，都尝试写入日记（内部会检查规则是否启用）
              await (plugin as any).writeTodayOutputProgressToJournalFromIndex?.();
            });

            if (!okRun) return ok(mkSummary(ctx, startedAt, { skippedByPluginGuard: 1 }, "SKIPPED_BY_PLUGIN_GUARD", { dbSyncEnabled: false }));

            return ok(mkSummary(ctx, startedAt, { rebuilt: 1 }, "OK", { dbSyncEnabled: false }));
          } catch (e: any) {
            return fail("Output rebuild failed", { message: e?.message ?? String(e) });
          }
        },
        archive: async (ctx) => {
          const startedAt = new Date().toISOString();
          try {
            // ✅ D2：auto_archive 不走 manual wrapper（不弹窗/不写日记），仅归档本模块并刷新索引
            if (ctx.mode === "auto_archive") {
              if ((plugin as any)._outputOpInFlight) {
                return ok(mkSummary(ctx, startedAt, { skippedByPluginGuard: 1 }, "SKIPPED_BY_PLUGIN_GUARD"));
              }

              await plugin.outputRSLatte?.ensureReady?.();
              const n = await (plugin as any).archiveOutputFilesNow?.({ reason: "auto_archive" });
              const archivedCount = typeof n === "number" ? n : 0;

              // ✅ 归档后，从索引中移除已归档的文件，并归档索引信息
              await plugin.outputRSLatte?.archiveIndexForArchivedFiles?.();
              await plugin.outputRSLatte?.refreshIndexNow({ mode: "active" });
              if ((plugin.settings.outputPanel as any)?.enableDbSync) {
                await (plugin as any).syncOutputFilesToDb?.({ reason: "auto_archive" });
              }

              return ok(mkSummary(ctx, startedAt, { archivedCount }, "OK"));
            }

            // manual_archive：保持旧逻辑（runOutputManualOp + refreshIndexNow + journal/db）
            let archivedCount = 0;

            const okRun = await plugin.runOutputManualOp("归档", async () => {
              const n = await (plugin as any).archiveOutputFilesNow?.({ reason: "manual_archive" });
              archivedCount = typeof n === "number" ? n : 0;

              // ✅ 归档后，从索引中移除已归档的文件，并归档索引信息
              await plugin.outputRSLatte?.archiveIndexForArchivedFiles?.();
              await plugin.outputRSLatte?.refreshIndexNow({ mode: "active" });
              if ((plugin.settings.outputPanel as any)?.enableDbSync) {
                await (plugin as any).syncOutputFilesToDb?.({ reason: "manual_archive" });
              }
              // 无论是否启用数据库同步，都尝试写入日记（内部会检查规则是否启用）
              await (plugin as any).writeTodayOutputProgressToJournalFromIndex?.();
            });

            if (!okRun) return ok(mkSummary(ctx, startedAt, { skippedByPluginGuard: 1 }, "SKIPPED_BY_PLUGIN_GUARD"));

            return ok(mkSummary(ctx, startedAt, { archivedCount }, "OK"));
          } catch (e: any) {
            return fail("Output archive failed", { message: e?.message ?? String(e) });
          }
        },
        reconcile: (ctx) => notImplemented(ctx, "output:reconcile"),
        stats: (ctx) => notImplementedStats(ctx, "output:stats"),
      };

      // schedule：自动/手动主路径为 runE2 + scheduleSpecAtomic（coordinator tick 单轨 runE2）；legacy 以下占位仅供 engine.run 兼容，勿作 tick 依赖
      const scheduleSpec: ModuleSpec = {
        key: "schedule" as any,
        label: "Schedule",
        incrementalRefresh: (ctx) => notImplemented(ctx, "schedule:incrementalRefresh"),
        rebuild: (ctx) => notImplemented(ctx, "schedule:rebuild"),
        archive: (ctx) => notImplemented(ctx, "schedule:archive"),
        reconcile: (ctx) => notImplemented(ctx, "schedule:reconcile"),
        stats: (ctx) => notImplementedStats(ctx, "schedule:stats"),
      };

      const overridesBase: Partial<Record<RSLatteModuleKey, ModuleSpecAny>> = {
        task: taskSpec,
        memo: memoSpec,
        schedule: scheduleSpec as any,
        checkin: checkinSpec,
        finance: financeSpec,
        project: projectSpec,
        output: outputSpec,
      };

      const overrides: Partial<Record<RSLatteModuleKey, ModuleSpecAny>> = withProjectOutputAtomicSpecs(plugin, overridesBase);

      const registry = createDefaultModuleRegistry(overrides);

      const isEnabled = buildPipelineModuleIsEnabled(plugin);

      // D1: coordinator 需要共享 registry + enabled 判定
      setPipelineRegistry(registry);
      setPipelineIsEnabled(isEnabled);

      const spaceStats = new SpaceStatsService(plugin);

      return new PipelineEngine({
        registry,
        isModuleEnabled: isEnabled,
        // Step S9: pipeline diagnostics output under debug switch
        debug: {
          enabled: () => (plugin as any).isDebugLogEnabled?.() === true,
        },
        // D9-5: runE2 summary needs URL validity + last known backend DB readiness
        getBackendState: () => {
          const apiBaseUrl = String((plugin as any)?.settings?.apiBaseUrl ?? "").trim();
          let urlCheckable = false;
          if (apiBaseUrl) {
            const lower = apiBaseUrl.toLowerCase();
            if (lower.startsWith("http://") || lower.startsWith("https://")) {
              try {
                // eslint-disable-next-line no-new
                new URL(apiBaseUrl);
                urlCheckable = true;
              } catch {
                urlCheckable = false;
              }
            }
          }

          const bk = (plugin as any).getBackendDbReady?.();
          return { urlCheckable, backendReady: (bk as any)?.ready ?? null, reason: String((bk as any)?.reason ?? "") };
        },

        // Step F6: persist per-space stats snapshots after each run.
        afterStats: async (args) => {
          if (!args?.scope) return;
          const scope = args.scope;
          
          // 防御性检查：确保 plugin.settings 存在
          if (!plugin.settings) {
            console.warn("[RSLatte][pipeline] afterStats: plugin.settings is undefined, skipping");
            return;
          }
          
          const ctx = buildSpaceCtx(plugin.settings, scope.spaceId);
          
          // 防御性检查：确保 ctx 和 ctx.vaultId 存在
          if (!ctx) {
            console.warn("[RSLatte][pipeline] afterStats: buildSpaceCtx returned undefined, skipping");
            return;
          }
          
          // 如果 scope 中有 vaultId，使用它；否则使用 buildSpaceCtx 从 settings 中获取的 vaultId
          if (scope.vaultId) {
            ctx.vaultId = scope.vaultId;
          }
          
          // 确保 vaultId 不为空（如果仍然为空，使用默认值或跳过）
          if (!ctx.vaultId || ctx.vaultId.trim() === "") {
            console.warn("[RSLatte][pipeline] afterStats: ctx.vaultId is empty, skipping stats write");
            return;
          }

          try {
            await spaceStats.writeModuleStats({
              ctx: ctx,
              moduleKey: args.moduleKey,
              runId: args.runId,
              mode: args.mode,
              phase: args.phase,
              startedAt: args.startedAt,
              finishedAt: args.finishedAt,
              gate: args.gate,
              stats: args.stats,
            });

            const known: RSLatteModuleKey[] = ["task", "memo", "schedule", "checkin", "finance", "health", "project", "output", "contacts", "knowledge"];
            const enabled = known.filter((k) => {
              try {
                return isEnabled(k);
              } catch {
                return false;
              }
            });
            await spaceStats.refreshSpaceStats(ctx, enabled);
          } catch (e: any) {
            // 捕获并记录错误，但不抛出，避免影响 pipeline 执行
            console.warn("[RSLatte][pipeline] afterStats: error writing stats", {
              moduleKey: args.moduleKey,
              mode: args.mode,
              error: String(e?.message ?? e),
            });
          }
        },
      });
    },

    /** D1: 每模块独立的 auto_refresh interval（ms）。目前默认回落到全局 autoRefreshIndexIntervalMin。 */
    getModuleAutoRefreshIntervalMs(moduleKey: RSLatteModuleKey): number {
      const baseMin = (plugin as any).getAutoRefreshIndexIntervalMin?.();
      const overrides: any = (plugin.settings as any)?.autoRefreshModuleIntervalsMin ?? {};
      const raw = overrides?.[moduleKey];
      const n = Math.floor(Number(raw));
      const min = Number.isFinite(n) && n > 0 ? n : baseMin;
      return min * 60 * 1000;
    },

    /** D1: 初始化/刷新 coordinator（main.ts timer 回调仅调用 coordinator.tick()） */
    ensureAutoRefreshCoordinator(): void {
      if (!getPipelineRegistry()) return;

      // 与 engine 同源：禁止在 _pipelineIsEnabled 未注入时用「全开」兜底（§1.1 / 索引方案 §0.4）
      const isEnabled = getPipelineIsEnabled() ?? buildPipelineModuleIsEnabled(plugin);

      setAutoRefreshCoordinator(new AutoRefreshCoordinator({
        registry: getPipelineRegistry()!,
        engine: plugin.pipelineEngine,
        isModuleEnabled: isEnabled,
        getIntervalMs: (k) => (plugin as any).getModuleAutoRefreshIntervalMs?.(k),
        canAutoRefresh: (k) => {
          // 保留旧策略：record 手动操作中跳过 checkin/finance/health auto_refresh（共享 record 锁）
          if (k === "checkin" || k === "finance" || k === "health") {
            if (k === "checkin" || k === "finance") {
              if (!((plugin as any).isModuleEnabled?.("record") ?? false)) return false;
            }
            if (plugin.isRecordManualBusy()) return false;
          }
          return true;
        },
        canAutoArchive: (k) => {
          // record 模块关闭时不做 checkin/finance auto_archive；健康独立开关
          if (k === "checkin" || k === "finance") {
            if (!((plugin as any).isModuleEnabled?.("record") ?? false)) return false;
            // 手动 busy 时跳过（避免并发冲突）
            if (plugin.isRecordManualBusy()) return false;
          }
          if (k === "health") {
            if (plugin.isRecordManualBusy()) return false;
          }

          // ✅ D2：尊重各模块 autoArchiveEnabled
          const sAny: any = plugin.settings as any;
          if (k === "task") return (sAny?.taskModule?.autoArchiveEnabled ?? true) === true;
          if (k === "memo") return (sAny?.memoModule?.autoArchiveEnabled ?? true) === true;
          if (k === "schedule") return (sAny?.scheduleModule?.autoArchiveEnabled ?? true) === true;
          if (k === "checkin") return (sAny?.checkinPanel?.autoArchiveEnabled ?? false) === true;
          if (k === "finance") return (sAny?.financePanel?.autoArchiveEnabled ?? false) === true;
          if (k === "health") return (sAny?.healthPanel?.autoArchiveEnabled ?? false) === true;
          if (k === "project") return (sAny?.projectAutoArchiveEnabled ?? true) === true;
          if (k === "output") return (sAny?.outputPanel?.autoArchiveEnabled ?? false) === true;
          if (k === "knowledge") return false;

          return true;
        },
        afterTick: () => {
          // UI refresh (best-effort)
          try { (plugin as any).refreshSidePanel?.(); } catch { }
        },
        showNoticeForTaskMemo: true,
      }));
    },

    isAutoRefreshIndexEnabled(): boolean {
      const v: any = (plugin.settings as any)?.autoRefreshIndexEnabled;
      return v === undefined ? true : Boolean(v);
    },

    getAutoRefreshIndexIntervalMin(): number {
      const v: any = (plugin.settings as any)?.autoRefreshIndexIntervalMin;
      const n = Math.max(1, Math.floor(Number(v ?? 30)));
      return Number.isFinite(n) ? n : 30;
    },

    setupAutoRefreshTimer(): void {
      // clear old
      if (getAutoRefreshTimer()) {
        try { window.clearInterval(getAutoRefreshTimer()!); } catch { }
        setAutoRefreshTimer(null);
      }

      if (!(plugin as any).isAutoRefreshIndexEnabled?.()) return;

      // D1: timer 仍只有一个，但调度交给 coordinator
      (plugin as any).ensureAutoRefreshCoordinator?.();

      const min = (plugin as any).getAutoRefreshIndexIntervalMin?.();
      const ms = min * 60 * 1000;

      const timer = window.setInterval(() => {
        void (plugin as any).runAutoRefreshTick?.().catch((e: any) => console.warn("RSLatte autoRefresh tick failed:", e));
      }, ms);

      setAutoRefreshTimer(timer);

      // Obsidian will cleanup on unload too
      plugin.registerInterval(timer);

      if (plugin.isDebugLogEnabled()) {
        plugin.dbg("autoRefresh", "timer_set", { everyMin: min });
      }
    },

    async runAutoRefreshTick(): Promise<void> {
      if (getAutoRefreshTickRunning()) return;
      setAutoRefreshTickRunning(true);
      try {
        // ✅ 遍历所有空间，为每个空间执行自动刷新
        const spaces = (plugin.settings as any).spaces || {};
        const spaceIds = Object.keys(spaces).filter((id) => {
          const space = spaces[id];
          return space && typeof space === "object" && space.id;
        });

        if (spaceIds.length === 0) {
          // 如果没有配置空间，使用当前空间
          const ctx0 = plugin.getSpaceCtx();
          await getAutoRefreshCoordinator()?.tick(ctx0);
          try {
            await runE2SealPreviousPeriodReviewSnapshots(plugin, ctx0.spaceId);
          } catch (e: any) {
            console.warn("[RSLatte] review E2 seal after auto_refresh tick failed:", e);
          }
        } else {
          // 为每个空间执行自动刷新
          for (const spaceId of spaceIds) {
            try {
              // 使用 buildSpaceCtx 构建空间上下文
              const spaceCtx = buildSpaceCtx(plugin.settings, spaceId);
              console.log(`[rslatte] Auto refresh tick: processing space ${spaceId} (${spaceCtx.space?.name || spaceId})`);
              await getAutoRefreshCoordinator()?.tick(spaceCtx);
              try {
                await runE2SealPreviousPeriodReviewSnapshots(plugin, spaceId);
              } catch (e: any) {
                console.warn(`[RSLatte] review E2 seal after tick failed (${spaceId}):`, e);
              }
            } catch (e: any) {
              console.warn(`[rslatte] Auto refresh failed for space ${spaceId}:`, e);
            }
          }
        }

        // Diary: auto archive old diary notes into month folders (best-effort; does not depend on backend)
        await (plugin as any).autoArchiveDiariesIfNeeded?.();

        // Contacts: auto_refresh is handled by coordinator.tick() via engine.runE2; keep auto_archive here (best-effort; does not depend on backend)
        await (plugin as any).autoArchiveContactsIfNeeded?.();

        // WorkEvent：JSONL 与 DB 双写（非实时），与本次自动刷新同周期
        if ((plugin as any).isWorkEventDbSyncEnabled?.() === true) {
          const vaultOk = await (plugin as any).vaultSvc?.ensureVaultReadySafe?.("syncWorkEventsToDb");
          const db = vaultOk ? await (plugin as any).vaultSvc?.checkDbReadySafe?.("syncWorkEventsToDb") : null;
          if (vaultOk && db?.ok) {
            const ids =
              spaceIds.length > 0
                ? spaceIds
                : [String((plugin as any).getCurrentSpaceId?.() ?? "").trim()].filter(Boolean);
            for (const sid of ids) {
              try {
                await (plugin as any).syncWorkEventsToDbForSpace?.(sid, { reason: "auto_refresh_tick" });
              } catch (e: any) {
                console.warn(`[RSLatte] syncWorkEventsToDbForSpace failed (${sid}):`, e);
              }
            }
          }
        }
      } finally {
        setAutoRefreshTickRunning(false);
      }
    },
  };
}
