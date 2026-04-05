import type { App } from "obsidian";
import { apiTry, type RSLatteApiClient } from "../api";
import type { RSLatteIndexStore } from "../taskRSLatte/indexStore";
import type { SyncQueue } from "../taskRSLatte/syncQueue";
import { buildIndexLocator, findIndexPos } from "../taskRSLatte/indexLocator";
import { writeBackMetaIdByUid } from "../taskRSLatte/shared";

export type FlushQueueOpts = { drainAll?: boolean; manualRetryNow?: boolean; maxBatches?: number };

export async function flushQueueUpsertV2(params: {
  app: App;
  enableSync: boolean;
  queue: SyncQueue;
  store: RSLatteIndexStore;
  api: RSLatteApiClient;
  refreshSidePanel: () => void;
  reportDbSync?: (ok: boolean, err?: string) => void;
  limit: number;
  maxTries: number;
  opts?: FlushQueueOpts;
}): Promise<void> {
  const { app, enableSync, queue, store, api, refreshSidePanel, reportDbSync, limit, maxTries, opts } = params;
  if (!enableSync) return;

  if (opts?.manualRetryNow) {
    try {
      await (queue as any).reviveDeadOps?.();
      await (queue as any).bumpFailedOpsToNow?.();
    } catch {
      // ignore
    }
  }

  let hadAnyBatch = false;
  let hardError: string | null = null;

  const maxBatches = (opts?.maxBatches ?? (opts?.drainAll ? 200 : 5));

  for (let batchNo = 0; batchNo < maxBatches; batchNo++) {
    const due = await queue.pickDue(limit);
    if (!due.length) break;

    const taskIdx = await store.readIndex("task");
    const memoIdx = await store.readIndex("memo");
    const scheduleIdx = await store.readIndex("schedule");
    const taskLocator = buildIndexLocator(taskIdx.items ?? []);
    const memoLocator = buildIndexLocator(memoIdx.items ?? []);
    const scheduleLocator = buildIndexLocator(scheduleIdx.items ?? []);

    let taskChanged = false;
    let memoChanged = false;
    let scheduleChanged = false;
    const nowIso = new Date().toISOString();

    const patchIndex = (type: "task" | "memo" | "schedule", o: any, patch: (it: any) => void) => {
      const uid = (o?.payload as any)?.uid;
      if (type === "task") {
        const i = findIndexPos(taskLocator, { uid, filePath: o.filePath, lineNo: o.lineNo });
        if (i == null) return;
        const it = (taskIdx.items as any[])[i];
        patch(it);
        taskChanged = true;
        return;
      }
      if (type === "memo") {
        const j = findIndexPos(memoLocator, { uid, filePath: o.filePath, lineNo: o.lineNo });
        if (j == null) return;
        const it = (memoIdx.items as any[])[j];
        patch(it);
        memoChanged = true;
        return;
      }
      const k = findIndexPos(scheduleLocator, { uid, filePath: o.filePath, lineNo: o.lineNo });
      if (k == null) return;
      const it = (scheduleIdx.items as any[])[k];
      patch(it);
      scheduleChanged = true;
    };

    const groups: Record<string, any[]> = { task: [], memo: [], schedule: [] };
    for (const o of due) {
      if (o.itemType === "task") groups.task.push(o);
      else if (o.itemType === "schedule") groups.schedule.push(o);
      else groups.memo.push(o);
    }

    const processGroup = async (type: "task" | "memo" | "schedule", ops: any[]) => {
      if (!ops.length) return;

      const missingUid = ops.filter((o) => !(o?.payload as any)?.uid);
      for (const o of missingUid) {
        const err = "missing uid (请先手动刷新补齐 uid)";
        await queue.markFailure(o.opId, err, maxTries);
        patchIndex(type, o, (it) => {
          it.dbSyncState = "failed";
          it.dbLastAttemptAt = nowIso;
          it.dbLastError = err;
          it.dbLastAction = "upsert";
          it.dbLastOpId = o.opId;
          it.dbSyncTries = (o.tries ?? 0) + 1;
        });
      }

      const goodOps = ops.filter((o) => !!(o?.payload as any)?.uid);
      if (!goodOps.length) return;

      try {
        const items = goodOps.map((o) => ({ ...o.payload }));
        const resp: any =
          type === "schedule"
            ? await apiTry("同步日程(v2)", () => (api as any).schedulesUpsertBatch({ items }))
            : await apiTry("同步任务/提醒(v2)", () => (api as any).rslatteItemsUpsertBatch(type, { items }));
        hadAnyBatch = true;

        const results: any[] = resp?.results ?? [];
        const byUid = new Map<string, any>();
        for (const r of results) {
          if (r && r.uid) byUid.set(String(r.uid), r);
        }

        for (const o of goodOps) {
          const uid = String((o.payload as any).uid);
          const r = byUid.get(uid);
          const sh = (o.payload as any)?.source_hash || (o.payload as any)?.sourceHash;

          if (!r || r.ok !== true) {
            const err = r?.message || r?.detail || r?.error || "unknown error";
            await queue.markFailure(o.opId, String(err), maxTries);
            patchIndex(type, o, (it) => {
              it.dbSyncState = "failed";
              it.dbLastAttemptAt = nowIso;
              it.dbLastError = String(err).slice(0, 400);
              it.dbLastAction = "upsert";
              it.dbLastOpId = o.opId;
              it.dbSyncTries = (o.tries ?? 0) + 1;
            });
            continue;
          }

          const newId = r.item_id;
          patchIndex(type, o, (it) => {
            if (typeof newId === "number" && (it.itemId == null || it.itemId != newId)) it.itemId = newId;
            if (sh) it.lastPushedHash = sh;
            it.lastPushedAt = nowIso;

            it.dbSyncState = "ok";
            it.dbLastAttemptAt = nowIso;
            it.dbLastOkAt = nowIso;
            it.dbLastError = undefined;
            it.dbLastAction = "upsert";
            it.dbLastOpId = o.opId;
            it.dbSyncTries = 0;
          });

          if (typeof newId === "number") {
            try {
              const patch: Record<string, string> =
                type === "task"
                  ? { tid: String(newId) }
                  : type === "memo"
                    ? { mid: String(newId) }
                    : { sid: String(newId) };
              await writeBackMetaIdByUid(app, o.filePath, uid, patch, o.lineNo);
            } catch (err) {
              console.warn("rslatte-plugin: writeBackMetaIdByUid failed", err);
            }
          }

          await queue.markSuccess(o.opId);
        }
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        hardError = msg;
        reportDbSync?.(false, msg);

        for (const o of goodOps) {
          await queue.markFailure(o.opId, msg, maxTries);
          patchIndex(type, o, (it) => {
            it.dbSyncState = "failed";
            it.dbLastAttemptAt = nowIso;
            it.dbLastError = String(msg).slice(0, 400);
            it.dbLastAction = "upsert";
            it.dbLastOpId = o.opId;
            it.dbSyncTries = (o.tries ?? 0) + 1;
          });
        }
      }
    };

    await processGroup("task", groups.task);
    await processGroup("memo", groups.memo);
    await processGroup("schedule", groups.schedule);

    if (taskChanged) await store.writeIndex("task", { ...taskIdx, updatedAt: nowIso } as any);
    if (memoChanged) await store.writeIndex("memo", { ...memoIdx, updatedAt: nowIso } as any);
    if (scheduleChanged) await store.writeIndex("schedule", { ...scheduleIdx, updatedAt: nowIso } as any);

    if (hardError) break;
    await new Promise((r) => window.setTimeout(r, 150));
  }

  if (hadAnyBatch && !hardError) {
    reportDbSync?.(true);
    refreshSidePanel();
  }
}
