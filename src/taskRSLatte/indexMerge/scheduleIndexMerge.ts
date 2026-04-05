/**
 * 日程索引：按文件增量合并 + `schedule_tags` / `tagsDerivedForYmd`。
 * 与 `scheduleTags` 成对，供 `mergeIntoIndex("schedule")` 与 schedule pipeline 共用。
 */
import type { TaskPanelSettings } from "../../types/taskTypes";
import type { RSLatteIndexItem, RSLatteParsedLine } from "../types";
import { calendarTodayYmd } from "../memo";
import { computeScheduleTags } from "../schedule";

export function normalizeScheduleItems(items: any[]): RSLatteIndexItem[] {
  return (items ?? []).map((it) => ({ ...(it as any), itemType: "schedule" as const })) as RSLatteIndexItem[];
}

/** 增量合并：保留未触碰文件上的旧条目，用本次扫描结果替换触碰/删除文件相关项 */
export function mergeScheduleItemsByFiles(args: {
  existing: RSLatteIndexItem[];
  scanned: RSLatteParsedLine[] | RSLatteIndexItem[];
  touchedFilePaths?: string[];
  removedFilePaths?: string[];
}): RSLatteIndexItem[] {
  const existing = normalizeScheduleItems(args.existing ?? []);
  const scanned = normalizeScheduleItems(args.scanned ?? []);
  const touched = new Set((args.touchedFilePaths ?? []).map((x) => String(x ?? "").trim()).filter(Boolean));
  const removed = new Set((args.removedFilePaths ?? []).map((x) => String(x ?? "").trim()).filter(Boolean));

  const next = existing.filter((it) => {
    const fp = String((it as any)?.filePath ?? "").trim();
    if (!fp) return false;
    if (removed.has(fp)) return false;
    if (touched.has(fp)) return false;
    return true;
  });
  next.push(...scanned);
  return next;
}

export function applyScheduleIndexDerivedFields(
  items: RSLatteIndexItem[],
  panel?: TaskPanelSettings | null,
  dayYmd?: string
): { items: RSLatteIndexItem[]; tagsDerivedForYmd: string } {
  const day = dayYmd ?? calendarTodayYmd();
  const norm = normalizeScheduleItems(items);
  for (const it of norm) {
    (it as any).schedule_tags = computeScheduleTags(it, day, panel);
  }
  return { items: norm, tagsDerivedForYmd: day };
}
