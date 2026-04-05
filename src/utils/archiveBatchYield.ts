/**
 * 《代码结构优化方案》§8.7：归档日等场景下连续 `vault.rename` / `renameFile` 时，
 * 按可选 `batchLimit` 在成功移动若干次后 **requestAnimationFrame**（无则 **setTimeout(0)**）让出主线程，
 * 减轻 UI 卡顿与文件事件堆积。
 */
export async function yieldIfArchiveBatchBoundary(opts: {
  batchLimit?: number;
  /** 当前已成功移动（或等价 rename）的累计次数，从 1 递增 */
  successCount: number;
}): Promise<void> {
  const lim = opts.batchLimit;
  if (typeof lim !== "number" || !Number.isFinite(lim) || lim <= 0) return;
  const n = Math.floor(lim);
  const c = opts.successCount;
  if (c <= 0 || c % n !== 0) return;
  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(() => resolve(), 0);
    }
  });
}
