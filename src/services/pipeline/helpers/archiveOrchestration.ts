/**
 * §8.2 归档编排薄层（《代码结构优化方案》）
 *
 * 将「先搬文件 → 再刷新快照/索引 → 再旁路（DB / WorkEvent / 侧栏）」中**顺序敏感**且重复出现的子序列集中在此，
 * 避免 main / projectManager / outputManager 各自手写导致漏步。
 *
 * 与 `rebuildScopeSemantics.ts` 中 **`rebuildAfterPhysicalArchive`** 语义对齐：本文件编排的是**物理搬迁之后**的固定步骤。
 */

import { toLocalOffsetIsoString } from "../../../utils/localCalendarYmd";

// --- 联系人 -----------------------------------------------------------------

/** 归档前：保证主索引与当前 vault 一致（失败忽略，不阻塞搬迁判断）。 */
export async function runContactsPreArchiveEnsureMainIndex(plugin: { rebuildContactsIndex(): Promise<unknown> }): Promise<void> {
  try {
    await plugin.rebuildContactsIndex();
  } catch {
    // ignore
  }
}

/**
 * 联系人笔记迁入归档目录之后（顺序固定）：
 * 1. 按路径 DB 同步（可选）
 * 2. 主索引 + 归档索引全量重建
 * 3. WorkEvent 摘要（moved > 0）
 */
export async function runContactsPostPhysicalArchiveSteps(
  plugin: {
    rebuildContactsAllIndexes(): Promise<unknown>;
    tryContactsDbSyncByPaths(paths: string[], reason: string, opts?: { quiet?: boolean }): Promise<unknown>;
    workEventSvc?: { append(entry: Record<string, unknown>): Promise<unknown> };
  },
  ctx: {
    movedPaths: string[];
    moved: number;
    reason: "manual" | "auto";
    quiet: boolean;
    skipDbSync: boolean;
    archiveRoot: string;
  }
): Promise<void> {
  if (!ctx.skipDbSync) {
    try {
      await plugin.tryContactsDbSyncByPaths(ctx.movedPaths, `archive:${ctx.reason}`, { quiet: ctx.quiet });
    } catch {
      // ignore
    }
  }

  try {
    await plugin.rebuildContactsAllIndexes();
  } catch {
    // ignore
  }

  try {
    if (ctx.moved > 0) {
      await plugin.workEventSvc?.append({
        ts: toLocalOffsetIsoString(),
        kind: "contact",
        action: "archive",
        source: ctx.reason === "auto" ? "auto" : "ui",
        ref: {
          moved: ctx.moved,
          reason: ctx.reason,
          archive_dir: ctx.archiveRoot,
        },
        summary: `🗄 归档联系人：${ctx.moved} 个（原因=${ctx.reason}）`,
        metrics: { moved: ctx.moved },
      });
    }
  } catch {
    // ignore
  }
}

// --- 输出 -------------------------------------------------------------------

/** 输出归档前：必须 full 刷新快照，否则无可归档项；失败则抛错（与原先 outputManager 行为一致）。 */
export async function runOutputPreArchiveRefreshIndexFull(plugin: {
  outputRSLatte: { ensureReady(): Promise<unknown>; refreshIndexNow(opts: { mode: "full" }): Promise<unknown> };
  dbg?: (channel: string, message: string, detail?: unknown) => void;
}): Promise<void> {
  await plugin.outputRSLatte.ensureReady();
  try {
    await plugin.outputRSLatte.refreshIndexNow({ mode: "full" });
  } catch (e: unknown) {
    const msg = e && typeof e === "object" && "message" in e ? String((e as { message?: unknown }).message) : String(e);
    plugin.dbg?.("output", "archiveOutputFilesNow refreshIndexNow failed", e);
    throw new Error(`输出索引刷新失败，无法归档：${msg}`);
  }
}

/**
 * 输出文件/目录搬迁之后：full 刷新索引；失败则 best-effort `archiveIndexForArchivedFiles`（不抛错，避免掩盖已成功的 moved）。
 */
export async function runOutputPostPhysicalArchiveRefresh(plugin: {
  outputRSLatte: {
    refreshIndexNow(opts: { mode: "full" }): Promise<unknown>;
    archiveIndexForArchivedFiles?: () => Promise<unknown>;
  };
  dbg?: (channel: string, message: string, detail?: unknown) => void;
}, moved: number): Promise<void> {
  if (moved <= 0) return;
  try {
    await plugin.outputRSLatte.refreshIndexNow({ mode: "full" });
  } catch (e: unknown) {
    plugin.dbg?.("output", "archiveOutputFilesNow post-move refresh failed", e);
    try {
      await plugin.outputRSLatte.archiveIndexForArchivedFiles?.();
    } catch {
      // ignore
    }
  }
}

// --- 项目 -------------------------------------------------------------------

/**
 * 项目文件夹迁入 `projectArchiveDir` 之后（顺序固定）：
 * 1. `refreshDirty(archive_post)` 收敛移动后的路径
 * 2. `moved > 0` 时 `archiveIndexNow`（索引分片归档）
 * 3. `refreshSidePanel`
 */
export async function runProjectPostPhysicalArchiveSteps(args: {
  refreshDirty: (opts?: { reason?: string }) => Promise<void>;
  archiveIndexNow: (opts?: { quiet?: boolean }) => Promise<unknown>;
  refreshSidePanel: () => void;
  moved: number;
  quiet?: boolean;
}): Promise<void> {
  const { refreshDirty, archiveIndexNow, refreshSidePanel, moved, quiet } = args;
  await refreshDirty({ reason: "archive_post" });
  if (moved > 0) {
    try {
      await archiveIndexNow({ quiet: quiet ?? true });
    } catch (e) {
      console.warn("项目索引归档失败", e);
    }
  }
  refreshSidePanel();
}
