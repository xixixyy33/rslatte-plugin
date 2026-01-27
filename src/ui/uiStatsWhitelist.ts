/**
 * Step S1: UI stats whitelist
 *
 * 目的：把 UI（状态灯 / tooltip / 侧边栏 notice）依赖的统计字段固定成白名单。
 * 后续重构必须保证这些字段的语义与输出不变。
 */

/** 状态灯（getDbSyncIndicator）依赖字段（_dbSyncMeta[moduleKey]） */
export const UI_DB_SYNC_META_WHITELIST = [
  "status",        // 'ok' | 'pending' | 'error' | unknown
  "at",            // ISO string
  "pendingCount",  // number
  "failedCount",   // number
  "err",           // string | undefined
] as const;

/** Pipeline run result（engine.run / engine.runE2）供 UI 使用的字段 */
export const UI_RUN_RESULT_WHITELIST = [
  // identity
  "moduleKey",
  "mode",
  "skipped",
  "skipReason",

  // db-sync gate snapshot (mainly for tooltip/notice)
  "dbSyncEnabled",
  "pendingCount",
  "failedCount",

  // archive notice
  "archivedCount",
  "cutoffDate",

  // reconcile flags (tooltip)
  "reconcileExecuted",
  "reconcileSkipped",
  "reconcileReason",
] as const;

export const UI_STATS_WHITELIST = {
  dbSyncMeta: UI_DB_SYNC_META_WHITELIST,
  runResult: UI_RUN_RESULT_WHITELIST,
} as const;

export type UiDbSyncMetaKey = typeof UI_DB_SYNC_META_WHITELIST[number];
export type UiRunResultKey = typeof UI_RUN_RESULT_WHITELIST[number];
