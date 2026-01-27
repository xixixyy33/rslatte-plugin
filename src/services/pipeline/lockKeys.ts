/**
 * Single source of truth for pipeline lock keys.
 *
 * Goals (Step S4):
 * - Centralize the lockKey rules so Engine never hardcodes them.
 * - Keep existing behavior:
 *   - checkin|finance -> share the same lock key: "record" (mutual exclusion across both modules)
 *   - others          -> lockKey === moduleKey
 */

import type { RSLatteLockGroup, RSLatteLockKey, RSLatteModuleKey } from "./types";

/** Resolve lock key for a module (stable rule). */
/** Resolve lock *group* for a module (no scope prefix). */
export function getLockGroupForModule(moduleKey: RSLatteModuleKey): RSLatteLockGroup {
  // ✅ Shared lock group for record-rslatte modules (checkin/finance)
  if (moduleKey === "checkin" || moduleKey === "finance") return "record";
  return moduleKey;
}

/**
 * Build scoped lock key.
 *
 * Step F3: include vaultId + spaceId to avoid cross-space mutual exclusion.
 * scopeKey recommended: "<vaultId>:<spaceId>"
 */
export function buildScopedLockKey(scopeKey: string, moduleKey: RSLatteModuleKey): RSLatteLockKey {
  const group = getLockGroupForModule(moduleKey);
  return `${scopeKey}:${group}`;
}

/**
 * Backward-compatible alias (no scope prefix).
 *
 * ⚠️ Deprecated in Step F3: prefer buildScopedLockKey().
 */
export function getLockKeyForModule(moduleKey: RSLatteModuleKey): RSLatteLockKey {
  return String(getLockGroupForModule(moduleKey));
}
