import type { RSLatteIndexItem, RSLatteItemType, RSLatteParsedLine } from "./types";

/**
 * v2 key helpers
 *
 * - Index matching should prefer uid to survive line number drift.
 * - Archive idempotency markers should prefer DB id, then uid.
 */

export function indexMatchKey(it: Pick<RSLatteParsedLine, "filePath" | "lineNo" | "uid">): string {
  if (it.uid) return `uid:${it.uid}`;
  return `${it.filePath}#${it.lineNo}`;
}

export function archiveStableKey(type: RSLatteItemType, it: Partial<RSLatteIndexItem>): string {
  const id = (it as any)?.itemId ?? (it as any)?.tid ?? (it as any)?.mid;
  if (id != null) return `${type}:${id}`;
  const uid = String((it as any)?.uid ?? "").trim();
  if (uid) return `${type}:uid=${uid}`;

  // Legacy fallback: filePath#line#hash
  const fp = String((it as any)?.filePath ?? "");
  const ln = String((it as any)?.lineNo ?? "");
  const h = String((it as any)?.sourceHash ?? (it as any)?.source_hash ?? "");
  return `${type}:fp=${fp}#${ln}#${h}`;
}
