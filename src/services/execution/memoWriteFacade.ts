import type { TaskRSLatteService } from "../../taskRSLatte/service";

/**
 * 提醒（memo）「写笔记」推荐入口；索引与侧栏走 executionOrchestrator。
 */
export async function writeMemoTodayCreate(
  svc: TaskRSLatteService,
  ...args: Parameters<TaskRSLatteService["createTodayMemo"]>
): ReturnType<TaskRSLatteService["createTodayMemo"]> {
  return svc.createTodayMemo(...args);
}

/** 提醒更新门面：修改提醒信息 */
export async function writeMemoUpdateBasicInfo(
  svc: TaskRSLatteService,
  ...args: Parameters<TaskRSLatteService["updateMemoBasicInfo"]>
): ReturnType<TaskRSLatteService["updateMemoBasicInfo"]> {
  return svc.updateMemoBasicInfo(...args);
}

/** 提醒更新门面：状态流转 */
export async function writeMemoApplyStatus(
  svc: TaskRSLatteService,
  ...args: Parameters<TaskRSLatteService["applyMemoStatusAction"]>
): ReturnType<TaskRSLatteService["applyMemoStatusAction"]> {
  return svc.applyMemoStatusAction(...args);
}

/** 提醒更新门面：星标（复用统一 starred 能力） */
export async function writeMemoSetStarred(
  svc: TaskRSLatteService,
  ...args: Parameters<TaskRSLatteService["setTaskStarred"]>
): ReturnType<TaskRSLatteService["setTaskStarred"]> {
  return svc.setTaskStarred(...args);
}

/** 提醒更新门面：失效/恢复周期 */
export async function writeMemoSetInvalidated(
  svc: TaskRSLatteService,
  ...args: Parameters<TaskRSLatteService["setMemoInvalidated"]>
): ReturnType<TaskRSLatteService["setMemoInvalidated"]> {
  return svc.setMemoInvalidated(...args);
}

/**
 * 提醒更新门面：按 uid 上行更新（upsertByUid）。
 * - 命中 uid：更新该提醒；
 * - 未命中 uid：当前仅返回 undefined（不自动创建，避免误写）。
 */
export async function writeMemoUpsertByUid(
  svc: TaskRSLatteService,
  uid: string,
  patch: Parameters<TaskRSLatteService["updateMemoBasicInfo"]>[1],
  opts?: Parameters<TaskRSLatteService["updateMemoBasicInfo"]>[2]
): Promise<{ uid?: string; updated: boolean }> {
  const u = String(uid ?? "").trim();
  if (!u) return { updated: false };
  const hit = await svc.findMemoByUid(u);
  if (!hit) return { updated: false };
  await svc.updateMemoBasicInfo(hit as any, patch as any, opts as any);
  return { uid: u, updated: true };
}
