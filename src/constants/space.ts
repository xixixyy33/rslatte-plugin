/**
 * ✅ Space UUID（与后端一致）
 * - default space 固定为全 0 UUID
 */
export const DEFAULT_SPACE_ID = "00000000-0000-0000-0000-000000000000";

/** Workspace event name: emitted after current space is changed */
export const RSLATTE_EVENT_SPACE_CHANGED = "rslatte:space-changed";

/** Workspace event name: emitted after stats files are updated for a space/module */
export const RSLATTE_EVENT_SPACE_STATS_UPDATED = "rslatte:space-stats-updated";

/** Workspace event name: emitted when DB sync status changes (for Hub view refresh) */
export const RSLATTE_EVENT_DB_SYNC_STATUS_CHANGED = "rslatte:db-sync-status-changed";
