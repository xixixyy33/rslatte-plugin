import { moment } from "obsidian";
import type { RSLatteIndexItem, RSLatteItemType } from "./types";
import { RSLatteIndexStore } from "./indexStore";
import { archiveStableKey } from "./keys";

export type ArchiveResult = {
  archivedCount: number;
  byMonth: Record<string, number>; // YYYY-MM -> count
  cutoffDate: string; // YYYY-MM-DD
};

/**
 * Compute the date used for archiving.
 *
 * Rules:
 * - task: only archive when CLOSED (DONE/CANCELLED), using ✅/❌ date.
 * - memo:
 *   - repeating memo (weekly/monthly/seasonly/yearly): only archive when DONE/CANCELLED, using ✅/❌ date.
 *   - one-time memo (none): archive by 📅 memoDate even if still TODO.
 */
function getArchiveDate(type: RSLatteItemType, item: RSLatteIndexItem, today: string): string | null {
  // 1) CLOSED items (task + memo)
  if (item.status === "CANCELLED") return item.cancelledDate || today;
  if (item.status === "DONE") return item.doneDate || today;

  // 2) task: non-closed tasks are never archived
  if (type === "task") return null;

  // 3) memo: non-closed
  // normalize repeat rule; historical MM-DD memos without 🔁 should be treated as yearly
  let rule = String((item as any).repeatRule || "").trim().toLowerCase();
  if (!rule) rule = (item as any).memoMmdd ? "yearly" : "none";
  const allowed = new Set(["none", "weekly", "monthly", "seasonly", "yearly"]);
  const rr = allowed.has(rule) ? rule : "none";
  if (rr !== "none") return null;

  const md = String((item as any).memoDate || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(md)) return md;
  return null;
}

export async function archiveIndexByMonths(
  store: RSLatteIndexStore,
  type: RSLatteItemType,
  thresholdDays: number
): Promise<ArchiveResult> {
  const momentFn = moment as any;
  const today = momentFn().format("YYYY-MM-DD");
  const days = Math.max(1, Math.min(3650, Math.floor(Number(thresholdDays) || 90)));
  const cutoff = momentFn(today).startOf("day").subtract(days, "days").format("YYYY-MM-DD");

  const idx = await store.readIndex(type);
  const items = idx.items ?? [];

  // A lightweight map to make archiving idempotent even though original tasks remain in daily notes.
  // Without this, closed tasks that were already archived (and removed from the main index) can be
  // re-scanned and re-archived repeatedly.
  const mapFile = await store.readArchiveMap();
  const archivedKeys = mapFile.keys ?? {};

  const keyOf = (it: any): string => archiveStableKey(type, it);

  const remain: RSLatteIndexItem[] = [];
  const groups: Record<string, RSLatteIndexItem[]> = {};

  for (const it of items) {
    const archiveDate = getArchiveDate(type, it, today);
    if (!archiveDate) {
      remain.push(it);
      continue;
    }

    if (archiveDate >= cutoff) {
      remain.push(it);
      continue;
    }

    // If it has already been archived (key exists), do not append again.
    const k = keyOf(it);
    if (archivedKeys[k]) {
      // Remove it from main index anyway, since it is older than cutoff.
      continue;
    }

    const monthKey = archiveDate.slice(0, 7);
    if (!groups[monthKey]) groups[monthKey] = [];
    groups[monthKey].push({ ...it, archived: true });
  }

  let archivedCount = 0;
  const byMonth: Record<string, number> = {};

  for (const [monthKey, list] of Object.entries(groups)) {
    if (!list.length) continue;
    await store.appendToArchive(monthKey, type, list);
    archivedCount += list.length;
    byMonth[monthKey] = list.length;

    // update map for newly archived items
    for (const it of list) {
      archivedKeys[keyOf(it)] = monthKey;
    }
  }

  // persist archive map (idempotency marker)
  await store.writeArchiveMap({ version: 1, updatedAt: new Date().toISOString(), keys: archivedKeys });

  await store.writeIndex(type, { version: 1, updatedAt: new Date().toISOString(), items: remain });

  return { archivedCount, byMonth, cutoffDate: cutoff };
}
