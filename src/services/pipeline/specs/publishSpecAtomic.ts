import type {
  ModuleSpecAtomic,
  RSLatteAtomicOpContext,
  RSLatteModuleOpSummary,
  RSLatteReconcileGate,
} from "../moduleSpec";
import type { RSLatteResult, RSLatteScanResult } from "../types";

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
    finishedAt: new Date().toISOString(),
    metrics: { noop: 1 },
    message,
    gate,
  } as any;
}

/**
 * Create Publish ModuleSpecAtomic.
 *
 * 发布模块只支持 rebuild 操作，不支持数据库同步和归档。
 */
export function createPublishSpecAtomic(plugin: any): ModuleSpecAtomic {
  return {
    key: "publish",
    label: "Publish",

    // --- rebuild scan (P2) ---
    async scanFull(ctx) {
      try {
        const app = plugin?.app;
        const settings = plugin?.settings;
        const op = settings?.publishPanel;

        if (!app) {
          const r: RSLatteScanResult<string> = {
            mode: "full",
            changedFiles: [],
            addedIds: [],
            updatedIds: [],
            removedIds: [],
            meta: { scannedAt: Date.now(), reason: "NO_APP" },
          };
          return ok(r);
        }

        // 发布模块不支持增量扫描，只支持全量重建
        // 这里返回一个空的扫描结果，实际的重建逻辑在 replaceAll 中
        const r: RSLatteScanResult<string> = {
          mode: "full",
          changedFiles: [],
          addedIds: [],
          updatedIds: [],
          removedIds: [],
          meta: { scannedAt: Date.now(), reason: "PUBLISH_FULL_REBUILD" },
        };
        return ok(r);
      } catch (e: any) {
        const r: RSLatteScanResult<string> = {
          mode: "full",
          changedFiles: [],
          addedIds: [],
          updatedIds: [],
          removedIds: [],
          meta: { scannedAt: Date.now(), reason: "SCAN_FAILED" },
        };
        return ok(r, [`scanFull failed: ${e?.message ?? String(e)}`]);
      }
    },

    async replaceAll(ctx, scan) {
      const startedAt = new Date().toISOString();
      try {
        // 调用发布服务的 refreshIndexNow 方法进行重建
        await plugin.publishRSLatte?.ensureReady?.();
        await plugin.publishRSLatte?.refreshIndexNow?.();

        const s = (scan ?? {}) as any;
        const addedIds = Array.isArray(s.addedIds) ? s.addedIds.map((x: any) => String(x)) : [];
        const updatedIds = Array.isArray(s.updatedIds) ? s.updatedIds.map((x: any) => String(x)) : [];
        const removedIds = Array.isArray(s.removedIds) ? s.removedIds.map((x: any) => String(x)) : [];

        return ok({ startedAt, applied: { addedIds, updatedIds, removedIds } });
      } catch (e: any) {
        return fail("PUBLISH_REBUILD_FAILED", "Publish rebuild failed", { message: e?.message ?? String(e) });
      }
    },

    // 发布模块不支持增量扫描
    async scanIncremental(ctx) {
      const r: RSLatteScanResult<string> = {
        mode: "inc",
        changedFiles: [],
        addedIds: [],
        updatedIds: [],
        removedIds: [],
        meta: { scannedAt: Date.now(), reason: "PUBLISH_NO_INCREMENTAL" },
      };
      return ok(r);
    },

    // 发布模块不支持归档
    async archiveOutOfRange(ctx) {
      const startedAt = new Date().toISOString();
      return ok({ startedAt, skipped: 1, reason: "PUBLISH_NO_ARCHIVE" } as any);
    },

    // 发布模块不支持数据库同步
    async buildOps(_ctx, _applied) {
      return ok({ ops: [], counts: { upsert: 0, delete: 0 } });
    },

    async flushQueue(ctx, opts) {
      // 发布模块不支持数据库同步
      return ok({ flushed: 0, skipped: 1, reason: "PUBLISH_NO_DBSYNC" });
    },

    async getReconcileGate(ctx) {
      try {
        // 发布模块不支持数据库同步
        const gate: any = { dbSyncEnabled: false, pendingCount: 0, failedCount: 0, deltaSize: 0 };
        return ok(gate);
      } catch (e: any) {
        const gate: any = { dbSyncEnabled: false, pendingCount: 0, failedCount: 0, deltaSize: 0 };
        return ok(gate);
      }
    },
  };
}
