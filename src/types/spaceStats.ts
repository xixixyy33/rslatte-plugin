import type { RSLatteModuleKey, RSLattePipelineMode } from "../services/pipeline/types";
import type { RSLattePipelinePhase } from "../services/pipeline/moduleSpec";

/**
 * Space-scoped stats written to: <centralRoot>/<spaceId>/stats/
 *
 * Goal:
 * - Provide lightweight, space-aware status + KPI snapshots for UI cards and a global overview.
 * - Keep the schema stable; only add optional fields in future steps.
 */

export type SpaceStatsSchemaVersion = 1;

// -----------------------------
// KPI shapes (per module)
// -----------------------------

export type RSLatteModuleKpiTask = {
  overdue: number;
  dueTodayDone: number;
  dueTodayTotal: number;
  next7d: number;
};

export type RSLatteModuleKpiMemo = {
  total: number;
  new7d: number;
};

export type RSLatteModuleKpiCheckin = {
  todayDone: number;
  todayTotal: number;
  streak: number;
};

export type RSLatteModuleKpiFinance = {
  mtdSpend: number;
  mtdNet: number;
  topCategoryName: string;
  topCategoryAmount: number;
};

export type RSLatteModuleKpiProject = {
  activeProjects: number;
  dueNext14d: number;
  overdue?: number; // 超过截至日期的项目数量
};

export type RSLatteModuleKpiOutput = {
  generatedThisWeek: number;
  lastGeneratedAt: string;
  staleCount?: number; // 超过30天没有完成或取消的输出数量
};

export type RSLatteModuleKpiContacts = {
  touched30d: number;
  upcoming30d: number;
};

/** Module KPI payload - keep keys stable. */
export type RSLatteModuleKpiByModule = {
  task?: RSLatteModuleKpiTask;
  memo?: RSLatteModuleKpiMemo;
  checkin?: RSLatteModuleKpiCheckin;
  finance?: RSLatteModuleKpiFinance;
  project?: RSLatteModuleKpiProject;
  output?: RSLatteModuleKpiOutput;
  contacts?: RSLatteModuleKpiContacts;
};

// -----------------------------
// Module stats file
// -----------------------------

export type RSLatteModuleSyncSummary = {
  dbSyncEnabled?: boolean;
  pendingCount?: number;
  failedCount?: number;
};

export type RSLatteModuleCountsSummary = {
  total?: number;
  active?: number;
  archived?: number;
  parseErrorFiles?: number;
};

export type RSLatteModuleRunSummary = {
  runId: string;
  startedAt: string;
  finishedAt: string;
  mode: RSLattePipelineMode;
  phase: RSLattePipelinePhase;
};

export type RSLatteModuleStatsFileV1 = {
  schema_version: SpaceStatsSchemaVersion;
  updated_at: string;
  vault_id: string;
  space_id: string;
  module_key: RSLatteModuleKey;

  run?: RSLatteModuleRunSummary;
  sync?: RSLatteModuleSyncSummary;
  counts?: RSLatteModuleCountsSummary;
  kpi?: RSLatteModuleKpiByModule;
};

// -----------------------------
// Space (aggregated) stats file
// -----------------------------

export type RSLatteSpaceStatsSyncStatus = "off" | "ok" | "pending" | "failed" | "unknown";

export type RSLatteSpaceStatsModuleEntryV1 = {
  updated_at: string;
  module_key: RSLatteModuleKey;
  sync_status: RSLatteSpaceStatsSyncStatus;
  pending_count?: number;
  failed_count?: number;
  counts?: RSLatteModuleCountsSummary;
  kpi?: RSLatteModuleKpiByModule;
};

export type RSLatteSpaceStatsAggV1 = {
  pending_total: number;
  failed_total: number;
  modules_enabled?: number;
};

export type RSLatteSpaceStatsFileV1 = {
  schema_version: SpaceStatsSchemaVersion;
  updated_at: string;
  vault_id: string;
  space_id: string;
  modules: Record<string, RSLatteSpaceStatsModuleEntryV1>;
  agg: RSLatteSpaceStatsAggV1;
};
