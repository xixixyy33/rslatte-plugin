import type { RSLatteModuleKey, RSLattePipelineMode } from "../../services/pipeline/types";
import type { RSLatteModuleOpSummary, RSLatteReconcileGate } from "../../services/pipeline/moduleSpec";

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: any): string {
  return v === undefined || v === null ? "" : String(v);
}

export type UiRunResultSummary = {
  moduleKey: RSLatteModuleKey | string;
  mode: RSLattePipelineMode | string;
  skipped: boolean;
  skipReason: string;

  dbSyncEnabled: boolean;
  pendingCount: number;
  failedCount: number;

  archivedCount: number;
  cutoffDate: string;

  reconcileExecuted: boolean;
  reconcileSkipped: boolean;
  reconcileReason: string;
};

/**
 * Step S1: Normalize pipeline run result for UI.
 * - UI 只依赖该函数输出的白名单字段
 * - 兼容 engine.run 与 engine.runE2 不同结构
 */
export function normalizeRunSummaryForUi(result: any): UiRunResultSummary {
  const moduleKey = result?.moduleKey ?? "";
  const mode = result?.mode ?? "";
  const skipped = result?.skipped === true;
  const skipReason = str(result?.reason ?? result?.skipReason ?? "");

  const summary: RSLatteModuleOpSummary | undefined = (result?.summary ?? result?.data?.summary) as any;
  const gate: RSLatteReconcileGate | undefined = (result?.gate ?? summary?.gate ?? result?.data?.gate) as any;

  const dbSyncEnabled = gate?.dbSyncEnabled === true;
  const pendingCount = num((gate as any)?.pendingCount ?? (summary as any)?.gate?.pendingCount);
  const failedCount = num((gate as any)?.failedCount ?? (summary as any)?.gate?.failedCount);

  const archivedCount = num(
    (summary as any)?.metrics?.archivedCount ??
      (result as any)?.archivedCount ??
      (result as any)?.data?.archivedCount
  );

  // 对于 task/memo：archiveOutOfRange 返回 mkSummary(..., message=cutoffDate)
  const cutoffDate = str(
    summary?.message ??
      (result as any)?.cutoffDate ??
      (result as any)?.data?.cutoffDate
  );

  const rec = (result?.reconcile ?? result?.data?.reconcile) as any;
  const reconcileExecuted = rec?.executed === true;
  const reconcileSkipped = rec?.skipped === true;
  const reconcileReason = str(rec?.reason ?? "");

  return {
    moduleKey,
    mode,
    skipped,
    skipReason,
    dbSyncEnabled,
    pendingCount,
    failedCount,
    archivedCount,
    cutoffDate,
    reconcileExecuted,
    reconcileSkipped,
    reconcileReason,
  };
}

export const getUiStatsFromRunResult = normalizeRunSummaryForUi;
