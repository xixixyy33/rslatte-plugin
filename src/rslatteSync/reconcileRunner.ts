import { Notice } from "obsidian";
import { apiTry, type RSLatteApiClient } from "../api";
import type { SyncQueue } from "../taskRSLatte/syncQueue";
import type { RSLatteParsedLine } from "../taskRSLatte/types";

export async function runReconcileAfterRebuild(params: {
  enableSync: boolean;
  api: RSLatteApiClient;
  queue: SyncQueue;
  requireQueueEmpty: boolean;
  requireFileClean: boolean;
  includedFilePaths: string[];
  tasks: RSLatteParsedLine[];
  memos: RSLatteParsedLine[];
  dbg?: (domain: string, msg: string, data?: any) => void;
}): Promise<void> {
  const { enableSync, api, queue, requireQueueEmpty, requireFileClean, includedFilePaths, tasks, memos, dbg } = params;
  if (!enableSync) return;

  let scope_file_paths = Array.from(new Set((includedFilePaths ?? []).filter(Boolean)));
  if (!scope_file_paths.length) return;

  // v27 safety gate: only reconcile on "clean" files (no uidMissing / missing uid in scan result)
  if (requireFileClean) {
    const dirtyFiles = new Set<string>();
    const markIfDirty = (x: RSLatteParsedLine) => {
      if (!x?.filePath) return;
      const missing = (x as any).uidMissing === true || typeof (x as any).uid !== "string" || ((x as any).uid?.length ?? 0) === 0;
      if (missing) dirtyFiles.add(x.filePath);
    };
    (tasks ?? []).forEach(markIfDirty);
    (memos ?? []).forEach(markIfDirty);

    if (dirtyFiles.size > 0) {
      const before = scope_file_paths.length;
      scope_file_paths = scope_file_paths.filter((fp) => !dirtyFiles.has(fp));
      const after = scope_file_paths.length;
      if (before !== after) {
        new Notice(`Reconcile 安全门：已跳过 ${before - after} 个“未补齐 uid”的文件（可在设置中关闭“仅对干净文件执行”）`);
      }
      if (!scope_file_paths.length) return;
    }
  }

  if (requireQueueEmpty) {
    const q = await queue.listAll();
    if ((q?.length ?? 0) > 0) {
      new Notice(`Reconcile 已跳过：同步队列仍有 ${(q?.length ?? 0)} 条待处理/失败任务（可在设置中关闭“队列必须为空才 reconcile”）`);
      return;
    }
  }

  const taskUids = Array.from(new Set((tasks ?? []).map((x: any) => x.uid).filter((x: any): x is string => typeof x === "string" && x.length > 0)));
  const memoUids = Array.from(new Set((memos ?? []).map((x: any) => x.uid).filter((x: any): x is string => typeof x === "string" && x.length > 0)));

  try {
    const r1: any = await apiTry("Reconcile 任务(task)", () => (api as any).rslatteItemsReconcile("task", { scope_file_paths, present_uids: taskUids, present_ids: [] }));
    dbg?.("taskRSLatte", "reconcile task done", r1);
    new Notice(`Reconcile(task) 完成：标记删除 ${(r1?.marked_deleted ?? 0)} 条`);
  } catch (e: any) {
    new Notice(`Reconcile(task) 失败：${e?.message ?? String(e)}`);
  }

  try {
    const r2: any = await apiTry("Reconcile 备忘(memo)", () => (api as any).rslatteItemsReconcile("memo", { scope_file_paths, present_uids: memoUids, present_ids: [] }));
    dbg?.("taskRSLatte", "reconcile memo done", r2);
    new Notice(`Reconcile(memo) 完成：标记删除 ${(r2?.marked_deleted ?? 0)} 条`);
  } catch (e: any) {
    new Notice(`Reconcile(memo) 失败：${e?.message ?? String(e)}`);
  }
}

/**
 * ✅ E2: reconcile for a single item type (task OR memo).
 * - Shares the same safety gates as runReconcileAfterRebuild
 * - Used by Engine.runE2 to avoid cross-module reconcile side effects
 */
export async function runReconcileForType(params: {
  itemType: "task" | "memo";
  enableSync: boolean;
  api: RSLatteApiClient;
  queue: SyncQueue;
  requireQueueEmpty: boolean;
  requireFileClean: boolean;
  includedFilePaths: string[];
  lines: RSLatteParsedLine[];
  dbg?: (domain: string, msg: string, data?: any) => void;
}): Promise<void> {
  const { itemType, enableSync, api, queue, requireQueueEmpty, requireFileClean, includedFilePaths, lines, dbg } = params;
  if (!enableSync) return;

  let scope_file_paths = Array.from(new Set((includedFilePaths ?? []).filter(Boolean)));
  if (!scope_file_paths.length) return;

  // Safety gate: only reconcile on "clean" files (no uidMissing / missing uid in scan result)
  if (requireFileClean) {
    const dirtyFiles = new Set<string>();
    const markIfDirty = (x: RSLatteParsedLine) => {
      if (!x?.filePath) return;
      const missing = (x as any).uidMissing === true || typeof (x as any).uid !== "string" || ((x as any).uid?.length ?? 0) === 0;
      if (missing) dirtyFiles.add(x.filePath);
    };
    (lines ?? []).forEach(markIfDirty);

    if (dirtyFiles.size > 0) {
      const before = scope_file_paths.length;
      scope_file_paths = scope_file_paths.filter((fp) => !dirtyFiles.has(fp));
      const after = scope_file_paths.length;
      if (before !== after) {
        new Notice(`Reconcile 安全门：已跳过 ${before - after} 个“未补齐 uid”的文件（可在设置中关闭“仅对干净文件执行”）`);
      }
      if (!scope_file_paths.length) return;
    }
  }

  if (requireQueueEmpty) {
    const q = await queue.listAll();
    if ((q?.length ?? 0) > 0) {
      new Notice(`Reconcile 已跳过：同步队列仍有 ${(q?.length ?? 0)} 条待处理/失败任务（可在设置中关闭“队列必须为空才 reconcile”）`);
      return;
    }
  }

  const present_uids = Array.from(
    new Set((lines ?? []).map((x: any) => x.uid).filter((x: any): x is string => typeof x === "string" && x.length > 0))
  );

  try {
    const r: any = await apiTry(
      itemType === "task" ? "Reconcile 任务(task)" : "Reconcile 备忘(memo)",
      () => (api as any).rslatteItemsReconcile(itemType, { scope_file_paths, present_uids, present_ids: [] })
    );
    dbg?.("taskRSLatte", `reconcile ${itemType} done`, r);
    new Notice(`Reconcile(${itemType}) 完成：标记删除 ${(r?.marked_deleted ?? 0)} 条`);
  } catch (e: any) {
    new Notice(`Reconcile(${itemType}) 失败：${e?.message ?? String(e)}`);
  }
}
