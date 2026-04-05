/**
 * Review「季」视图：合并主索引与 archive 分片（任务/提醒/日程/输出），避免长周期内已归档条目缺失。
 */
import { normalizePath } from "obsidian";
import type RSLattePlugin from "../../main";
import { resolveSpaceIndexDir } from "../../services/space/spaceContext";
import { archiveStableKey } from "../../taskRSLatte/keys";
import type { RSLatteIndexFile, RSLatteIndexItem, RSLatteItemType } from "../../taskRSLatte/types";
import type { OutputIndexFile, OutputIndexItem } from "../../types/outputTypes";

const momentFn = (window as any).moment as undefined | ((inp?: any, fmt?: any, strict?: any) => any);

/** 闭区间 [startYmd,endYmd] 覆盖的历月键 YYYY-MM */
export function enumerateCalendarMonthKeysBetween(startYmd: string, endYmd: string): string[] {
  const s = momentFn?.(startYmd, "YYYY-MM-DD", true);
  const e = momentFn?.(endYmd, "YYYY-MM-DD", true);
  if (!s?.isValid?.() || !e?.isValid?.()) return [];
  const keys: string[] = [];
  const cur = s.clone().startOf("month");
  const endM = e.clone().startOf("month");
  while (cur.isSameOrBefore(endM, "month")) {
    keys.push(cur.format("YYYY-MM"));
    cur.add(1, "month");
  }
  return keys;
}

function indexFileNameToItemType(fileName: "task-index.json" | "memo-index.json" | "schedule-index.json"): RSLatteItemType {
  if (fileName === "task-index.json") return "task";
  if (fileName === "memo-index.json") return "memo";
  return "schedule";
}

async function readJsonPath<T>(plugin: RSLattePlugin, path: string, fallback: T): Promise<T> {
  try {
    const ok = await plugin.app.vault.adapter.exists(path);
    if (!ok) return fallback;
    const raw = await plugin.app.vault.adapter.read(path);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 主索引 + 周期内各月 archive 分片合并（按 stableKey 去重，主索引优先）。
 */
export async function readTaskMemoScheduleMergedForReview(
  plugin: RSLattePlugin,
  fileName: "task-index.json" | "memo-index.json" | "schedule-index.json",
  startYmd: string,
  endYmd: string,
  mergeArchiveShards: boolean,
): Promise<RSLatteIndexItem[]> {
  const spaceId = plugin.getCurrentSpaceId();
  const dir = resolveSpaceIndexDir(plugin.settings, spaceId);
  const mainPath = normalizePath(`${dir}/${fileName}`);
  const fallback: RSLatteIndexFile = { version: 1, updatedAt: "", items: [] };
  const main = await readJsonPath<RSLatteIndexFile>(plugin, mainPath, fallback);
  const type = indexFileNameToItemType(fileName);
  const keyOf = (it: RSLatteIndexItem) => archiveStableKey(type, it);
  const byKey = new Map<string, RSLatteIndexItem>();
  for (const it of main.items ?? []) {
    byKey.set(keyOf(it), it);
  }
  if (!mergeArchiveShards) {
    return Array.from(byKey.values());
  }
  const months = enumerateCalendarMonthKeysBetween(startYmd, endYmd);
  const archBase = normalizePath(`${dir}/archive`);
  const archPrefix =
    fileName === "task-index.json" ? "task-archive-" : fileName === "memo-index.json" ? "memo-archive-" : "schedule-archive-";
  for (const mk of months) {
    const ap = normalizePath(`${archBase}/${archPrefix}${mk}.json`);
    const arch = await readJsonPath<RSLatteIndexFile>(plugin, ap, fallback);
    for (const it of arch.items ?? []) {
      const k = keyOf(it);
      if (!byKey.has(k)) byKey.set(k, it);
    }
  }
  return Array.from(byKey.values());
}

/**
 * 主 output-index + 周期内 output-archive-YYYY-MM 合并（按 filePath 去重，主索引优先）。
 */
export async function readOutputItemsMergedForReview(
  plugin: RSLattePlugin,
  startYmd: string,
  endYmd: string,
  mergeArchiveShards: boolean,
): Promise<OutputIndexItem[]> {
  const spaceId = plugin.getCurrentSpaceId();
  const dir = resolveSpaceIndexDir(plugin.settings, spaceId);
  const mainPath = normalizePath(`${dir}/output-index.json`);
  const fallback: OutputIndexFile = { version: 2, updatedAt: "", items: [], cancelledArchiveDirs: [] };
  const main = await readJsonPath<OutputIndexFile>(plugin, mainPath, fallback);
  const byPath = new Map<string, OutputIndexItem>();
  for (const it of main.items ?? []) {
    const p = String(it.filePath ?? "").trim();
    if (p) byPath.set(normalizePath(p), it);
  }
  if (!mergeArchiveShards) {
    return Array.from(byPath.values());
  }
  const months = enumerateCalendarMonthKeysBetween(startYmd, endYmd);
  const archBase = normalizePath(`${dir}/archive`);
  for (const mk of months) {
    const ap = normalizePath(`${archBase}/output-archive-${mk}.json`);
    const arch = await readJsonPath<OutputIndexFile>(plugin, ap, fallback);
    for (const it of arch.items ?? []) {
      const p = String(it.filePath ?? "").trim();
      if (!p) continue;
      const nk = normalizePath(p);
      if (!byPath.has(nk)) byPath.set(nk, it);
    }
  }
  return Array.from(byPath.values());
}

/** 季报统计：任务/提醒/日程/输出是否合并归档分片 */
export function reviewMergeArchiveShardsForGrain(grain: "week" | "month" | "quarter"): boolean {
  return grain === "quarter";
}
