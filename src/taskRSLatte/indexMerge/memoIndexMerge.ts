/**
 * 提醒索引：解析行过滤（排除日程行）与 `memo_tags` / `tagsDerivedForYmd`。
 * 与 `memoTags` 成对，供 `mergeIntoIndex("memo")` 使用。
 */
import type { TaskPanelSettings } from "../../types/taskTypes";
import type { RSLatteIndexItem, RSLatteParsedLine } from "../types";
import { isScheduleMemoLine } from "../types";
import { calendarTodayYmd, computeMemoTags } from "../memo";

/** 写入 memo-index 前：去掉日程行（日程在 schedule-index） */
export function filterParsedLinesForMemoIndex(parsed: RSLatteParsedLine[]): RSLatteParsedLine[] {
  return (parsed ?? []).filter((p) => !isScheduleMemoLine(p));
}

export function applyMemoIndexDerivedFields(
  items: RSLatteIndexItem[],
  panel?: TaskPanelSettings | null,
  dayYmd?: string
): { items: RSLatteIndexItem[]; tagsDerivedForYmd: string } {
  const tagDay = dayYmd ?? calendarTodayYmd();
  for (const it of items) {
    if (isScheduleMemoLine(it)) continue;
    (it as any).memo_tags = computeMemoTags(it, tagDay, panel);
  }
  return { items, tagsDerivedForYmd: tagDay };
}
