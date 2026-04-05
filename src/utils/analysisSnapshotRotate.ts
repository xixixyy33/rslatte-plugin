import type { DataAdapter } from "obsidian";

/** 与 Review `REVIEW_SNAPSHOT_MAX_VERSIONS` 对齐：含当前主文件共保留 3 份内容（主文件 + bak1 + bak2） */
export const ANALYSIS_SNAPSHOT_MAX_VERSIONS = 3;

/** `…/2026-01.stats.json` → `…/2026-01.stats.bak1.json` / `.bak2.json` */
export function analysisSnapshotBackupPaths(mainPath: string): { bak1: string; bak2: string } {
  const p = String(mainPath ?? "").trim();
  if (!p.endsWith(".json")) {
    return { bak1: `${p}.bak1.json`, bak2: `${p}.bak2.json` };
  }
  const base = p.slice(0, -".json".length);
  return { bak1: `${base}.bak1.json`, bak2: `${base}.bak2.json` };
}

/**
 * 写入主文件前调用：主文件内容下推到 bak1，bak1→bak2，丢弃最旧。
 */
export async function rotateAnalysisSnapshotBeforeWrite(adapter: DataAdapter, mainPath: string): Promise<void> {
  const main = String(mainPath ?? "").trim();
  if (!main) return;
  const okMain = await adapter.exists(main);
  if (!okMain) return;
  const { bak1, bak2 } = analysisSnapshotBackupPaths(main);

  if (await adapter.exists(bak2)) {
    try {
      await adapter.remove(bak2);
    } catch {
      // ignore
    }
  }
  if (await adapter.exists(bak1)) {
    try {
      const b1 = await adapter.read(bak1);
      await adapter.write(bak2, b1);
      await adapter.remove(bak1);
    } catch {
      // ignore
    }
  }
  try {
    const cur = await adapter.read(main);
    await adapter.write(bak1, cur);
  } catch {
    // ignore
  }
}

/**
 * 回退一档：主文件 ← bak1；bak2 → bak1。
 * @returns 是否成功（无 bak1 则为 false）
 */
export async function rollbackOneAnalysisSnapshot(adapter: DataAdapter, mainPath: string): Promise<boolean> {
  const main = String(mainPath ?? "").trim();
  if (!main) return false;
  const { bak1, bak2 } = analysisSnapshotBackupPaths(main);
  if (!(await adapter.exists(bak1))) return false;
  try {
    const prev = await adapter.read(bak1);
    await adapter.write(main, prev);
    if (await adapter.exists(bak2)) {
      const older = await adapter.read(bak2);
      await adapter.write(bak1, older);
      await adapter.remove(bak2);
    } else {
      await adapter.remove(bak1);
    }
    return true;
  } catch (e) {
    console.warn("[RSLatte] rollbackOneAnalysisSnapshot failed", mainPath, e);
    return false;
  }
}
