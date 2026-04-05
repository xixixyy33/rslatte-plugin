/**
 * 输出全量/增量刷新时的 **扫描计划**（§8.4）：与 `OutputRSLatteService.refreshIndexNow` 行为对齐，供调试、文档与 Pipeline 注释引用。
 *
 * @see `types/outputTypes.ts` 文件头（台账 vs 物理扫描单一说明）
 * @see `docs/V2改造方案/10-索引优化方案.md` §10.6
 */

import { normalizePath } from "obsidian";
import type { OutputPanelSettings } from "../types/outputTypes";

/** 与 `OutputRSLatteService.normalizeRootList` 同语义，抽到此模块避免计划描述与实现分叉。 */
export function normalizeOutputRootList(list: unknown): string[] {
  return (Array.isArray(list) ? list : [])
    .map((x: unknown) => normalizePath(String(x ?? "").trim()))
    .filter((x: string) => !!x);
}

/**
 * `archiveRoots` 与各项目 **`…/pro_files`** 根合并后再去重，与 `refreshIndexNow` 第一段扫描一致。
 */
export function mergeOutputPrimaryScanRoots(archiveRoots: unknown, projectProFilesRoots: string[]): string[] {
  const merged = [...normalizeOutputRootList(archiveRoots)];
  for (const p of projectProFilesRoots) {
    const n = normalizePath(String(p ?? "").trim());
    if (n) merged.push(n);
  }
  return normalizeOutputRootList(merged);
}

export type OutputRefreshScanPlan = {
  mode: "active" | "full";
  /** 仅 `mode==="full"` 且设置未显式关闭时为 true；与 `refreshIndexNow` 中第二段 walk 门控一致 */
  includesLegacyPhysicalArchive: boolean;
  /** DONE 笔记物理归档根（第二段 walk 之一） */
  doneArchiveRoot: string;
  /** 磁盘 walk 结束后始终执行 `mergeLedgerKnowledgePathsIntoScan` */
  mergesLedgerKnowledgePaths: true;
  /** full：按扫描根重发现 `_archived` 并与缓存合并；active：沿用快照中的 `cancelledArchiveDirs` */
  cancelledArchiveDirs: "full_rediscover" | "reuse_cached";
};

/**
 * 由 **`outputPanel`** 与 **`mode`** 推导本次刷新是否包含「旧版物理归档」扫描；不含具体 Vault 文件列表。
 */
export function buildOutputRefreshScanPlan(
  op: Pick<OutputPanelSettings, "archiveRootDir" | "fullRebuildScanLegacyArchiveDirs">,
  mode: "active" | "full"
): OutputRefreshScanPlan {
  const doneArchiveRoot = normalizePath(String((op as { archiveRootDir?: string })?.archiveRootDir ?? "99-Archive").trim() || "99-Archive");
  const legacyOn =
    mode === "full" && (op as { fullRebuildScanLegacyArchiveDirs?: boolean }).fullRebuildScanLegacyArchiveDirs !== false;
  return {
    mode,
    includesLegacyPhysicalArchive: legacyOn,
    doneArchiveRoot,
    mergesLedgerKnowledgePaths: true,
    cancelledArchiveDirs: mode === "full" ? "full_rediscover" : "reuse_cached",
  };
}
