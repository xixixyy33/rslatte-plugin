import type { ContactInteractionEvent, ContactsInteractionEntry } from "../../contactsRSLatte/types";
import { getTaskTodayKey } from "../../taskRSLatte/task/taskTags";
import type { TaskPanelSettings } from "../../types/taskTypes";
import { toLocalOffsetIsoString } from "../../utils/localCalendarYmd";

const momentFn = (window as any).moment as undefined | ((inp?: any) => any);

/** 将条目 updated_at 转为任务基准时区下的日期键 YYYY-MM-DD */
export function entryUpdatedAtDateKeyInTaskTz(e: ContactsInteractionEntry, panel?: TaskPanelSettings | null): string {
  const raw = String(e.updated_at ?? "").trim();
  if (!raw) return "";
  try {
    if (panel?.taskBaseDateMode === "zone" && panel?.taskBaseTimeZone) {
      const z = String(panel.taskBaseTimeZone).trim();
      const m = momentFn?.(raw);
      if (m?.tz) return m.tz(z).format("YYYY-MM-DD");
    }
  } catch {
    // fallthrough
  }
  try {
    const m = momentFn?.(raw);
    if (m?.format) return m.format("YYYY-MM-DD");
  } catch {
    // ignore
  }
  return raw.slice(0, 10);
}

/** 当日 NEW：条目在任务时区下 updated_at 为今日的数量 + 手动额外计数 */
export function computeNewTodayCount(
  entries: ContactsInteractionEntry[],
  manualExtra: number,
  todayKey: string,
  panel?: TaskPanelSettings | null,
  /** 首次启用互动统计的时间；此前产生的条目不计入 NEW（避免历史堆积） */
  firstEnabledAtIso?: string | null
): number {
  let n = Math.max(0, Math.floor(Number(manualExtra) || 0));
  const fe = String(firstEnabledAtIso ?? "").trim();
  const feMs = fe ? Date.parse(fe) : NaN;
  for (const e of entries) {
    if (fe && !Number.isNaN(feMs)) {
      const u = Date.parse(String(e.updated_at ?? ""));
      if (!Number.isNaN(u) && u < feMs) continue;
    }
    if (entryUpdatedAtDateKeyInTaskTz(e, panel) === todayKey) n += 1;
  }
  return n;
}

/**
 * §6.6.2 互动列表排序「最新互动时间」：
 * - 动态：该条目下 `interaction_events` 的最大 `occurred_at`；**无有效事件时不**用 `updated_at`/`mtime` 冒充（置 0，沉于有真实互动时刻的条目）
 * - 手动：`interaction_events` 内 `occurred_at`；若异常缺失则回退 `updated_at` / 源文件 mtime
 */
export function sortKeyLatestInteractionMs(e: ContactsInteractionEntry, fileMtimeMs?: number): number {
  const evs = (e as ContactsInteractionEntry).interaction_events;
  let maxEv = 0;
  if (Array.isArray(evs)) {
    for (const ev of evs) {
      const t = Date.parse(String((ev as ContactInteractionEvent).occurred_at ?? ""));
      if (!Number.isNaN(t) && t > maxEv) maxEv = t;
    }
  }
  if (maxEv > 0) return maxEv;

  const st = String((e as ContactsInteractionEntry).source_type ?? "").trim();
  if (st === "manual_note") {
    const u = Date.parse(String(e.updated_at ?? ""));
    if (!Number.isNaN(u) && u > 0) return u;
    const m = Number(fileMtimeMs ?? 0);
    return m > 0 ? m : 0;
  }

  return 0;
}

/** 与 {@link sortKeyLatestInteractionMs} 相同（无文件 mtime 兜底） */
export function latestInteractionMsForEntry(e: ContactsInteractionEntry): number {
  return sortKeyLatestInteractionMs(e);
}

/**
 * 主索引窗口内「最后互动」展示用 ISO（**6.7.1**：仅 `interaction_events.occurred_at` 的最大值）。
 * 不把条目 `updated_at` 算入，避免仅有索引刷新、无实际互动事件时与 `.contacts` 副本、`events` 列表脱节。
 */
export function computeDisplayLastAtFromEntries(entries: ContactsInteractionEntry[]): string | null {
  let maxMs = 0;
  for (const e of entries) {
    const evs = (e as ContactsInteractionEntry).interaction_events;
    if (!Array.isArray(evs)) continue;
    for (const ev of evs as ContactInteractionEvent[]) {
      const t = Date.parse(String(ev?.occurred_at ?? ""));
      if (!Number.isNaN(t) && t > maxMs) maxMs = t;
    }
  }
  if (maxMs <= 0) return null;
  return toLocalOffsetIsoString(new Date(maxMs));
}

/**
 * 写入 `contacts-index.json` 的 `last_interaction_at`：与侧栏「最后互动」同一时刻，但按任务基准时区格式化为**带偏移的本地钟面**（避免仅见 UTC `Z` 与界面 `HH:mm` 数字不一致的困惑）。
 * - `taskBaseDateMode === "zone"` 且配置了 `taskBaseTimeZone`：在该时区下输出 `YYYY-MM-DDTHH:mm:ss.SSSZZ`
 * - 否则：本机本地偏移（同上格式）；解析失败则回退 `toISOString()`
 */
export function formatInstantForContactIndexStorage(ms: number, panel?: TaskPanelSettings | null): string {
  try {
    const m = momentFn?.(ms);
    if (!m?.isValid?.()) return new Date(ms).toISOString();
    if (panel?.taskBaseDateMode === "zone" && String(panel.taskBaseTimeZone ?? "").trim()) {
      const z = String(panel.taskBaseTimeZone).trim();
      const c = m.clone?.().tz?.(z);
      if (c?.format) return c.format("YYYY-MM-DDTHH:mm:ss.SSSZZ");
    }
    if (m.format) return m.format("YYYY-MM-DDTHH:mm:ss.SSSZZ");
  } catch {
    // fallthrough
  }
  return toLocalOffsetIsoString(new Date(ms));
}

/**
 * 与 {@link computeDisplayLastAtFromEntries} 取同一「最大 occurred_at」时刻，但输出 {@link formatInstantForContactIndexStorage} 格式供主索引落盘。
 */
export function computeLastInteractionAtForContactIndex(
  entries: ContactsInteractionEntry[],
  panel?: TaskPanelSettings | null
): string | null {
  let maxMs = 0;
  for (const e of entries) {
    const evs = (e as ContactsInteractionEntry).interaction_events;
    if (!Array.isArray(evs)) continue;
    for (const ev of evs as ContactInteractionEvent[]) {
      const t = Date.parse(String(ev?.occurred_at ?? ""));
      if (!Number.isNaN(t) && t > maxMs) maxMs = t;
    }
  }
  if (maxMs <= 0) return null;
  return formatInstantForContactIndexStorage(maxMs, panel);
}

/**
 * 将存储用 ISO（多为 UTC `...Z`）格式化为界面可读时间。
 * - `taskBaseDateMode === "zone"` 且配置了时区：在该时区下显示（与任务「基准日期」一致）
 * - 否则：按本机本地时区显示（与系统时钟一致）
 */
export function formatIsoForDisplay(iso: string | null | undefined, panel?: TaskPanelSettings | null): string {
  const s = String(iso ?? "").trim();
  if (!s) return "";
  try {
    const m = momentFn?.(s);
    if (m?.isValid?.()) {
      if (panel?.taskBaseDateMode === "zone" && panel?.taskBaseTimeZone) {
        const z = String(panel.taskBaseTimeZone).trim();
        if (z && m.clone?.().tz) return m.clone().tz(z).format("YYYY-MM-DD HH:mm");
      }
      if (m.format) return m.format("YYYY-MM-DD HH:mm");
    }
  } catch {
    // fallthrough
  }
  return s.length >= 16 ? s.slice(0, 16).replace("T", " ") : s;
}

/** 去掉任务行前缀与 wiki，便于判断摘要是否与父条目正文重复 */
function normInteractionTextBody(s: string): string {
  return String(s ?? "")
    .replace(/^\s*[-*+]\s*\[[^\]]*\]\s*/u, "")
    .replace(/\[\[[^\]]*\]\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * WorkEvent 重放的 `summary` 常带 `[[C_xxx|姓名]]` + 任务正文，与父条目 `snippet` 重复。
 * 展示实际互动时：若存在「动作前缀 + wiki + 正文」，只保留 wiki 之前部分；否则去掉 wiki 后若与父条目正文同义则不再重复输出正文。
 */
export function compactInteractionEventSummaryForDisplay(summary: string, parentSnippet?: string): string {
  const s = String(summary ?? "").replace(/\s+/g, " ").trim();
  if (!s) return s;
  const idx = s.indexOf("[[");
  if (idx >= 0) {
    const head = s.slice(0, idx).trimEnd();
    if (head.length > 0) return head;
  }
  const rest = s.replace(/\[\[[^\]]*\]\]/g, "").replace(/\s+/g, " ").trim();
  const ps = parentSnippet ? normInteractionTextBody(parentSnippet) : "";
  const rr = normInteractionTextBody(rest);
  if (ps && rr && (ps === rr || ps.includes(rr) || rr.includes(ps))) return "";
  return rest.length > 0 ? rest : s;
}

export type OverdueLineResult = { kind: "empty" | "ok" | "days"; text: string };

/** 自然日超期：last 日期距 todayKey 超过 overdueDays 天 */
export function computeOverdueLine(
  displayLastIso: string | null | undefined,
  lastInteractionAtFm: string | null | undefined,
  overdueDays: number,
  todayKey: string,
  panel?: TaskPanelSettings | null
): OverdueLineResult {
  const raw = String(displayLastIso ?? lastInteractionAtFm ?? "").trim();
  if (!raw) return { kind: "empty", text: "—" };

  let lastYmd = "";
  try {
    if (panel?.taskBaseDateMode === "zone" && panel?.taskBaseTimeZone) {
      const z = String(panel.taskBaseTimeZone).trim();
      const m = momentFn?.(raw);
      if (m?.tz) lastYmd = m.tz(z).format("YYYY-MM-DD");
    }
  } catch {
    // ignore
  }
  if (!lastYmd) {
    const m = momentFn?.(raw);
    lastYmd = m?.format ? m.format("YYYY-MM-DD") : raw.slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lastYmd)) return { kind: "empty", text: "—" };

  const d0 = parseYmd(lastYmd);
  const d1 = parseYmd(todayKey);
  if (!d0 || !d1) return { kind: "ok", text: "未超期" };
  const diffDays = Math.floor((d1.getTime() - d0.getTime()) / (24 * 60 * 60 * 1000));
  if (diffDays <= overdueDays) return { kind: "ok", text: "未超期" };
  return { kind: "days", text: `超期 ${diffDays - overdueDays} 天` };
}

function parseYmd(s: string): Date | null {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 确保联系人互动统计的「日」与任务基准时区一致；跨日则清空手动当日计数 */
export function ensureContactsInteractionRollup(
  cm: Record<string, unknown>,
  panel: TaskPanelSettings | undefined
): { todayKey: string; changed: boolean } {
  const todayKey = getTaskTodayKey(panel ?? undefined);
  let changed = false;
  const prev = String(cm.contactsInteractionStatsDateKey ?? "").trim();
  if (prev && prev !== todayKey) {
    cm.contactsInteractionStatsDateKey = todayKey;
    cm.contactsInteractionManualNewTodayByUid = {};
    changed = true;
  } else if (!prev) {
    cm.contactsInteractionStatsDateKey = todayKey;
    changed = true;
  }
  return { todayKey, changed };
}

export function bumpManualNewToday(cm: Record<string, unknown>, contactUid: string): void {
  const uid = String(contactUid ?? "").trim();
  if (!uid) return;
  const map = (cm.contactsInteractionManualNewTodayByUid as Record<string, number>) ?? {};
  map[uid] = (map[uid] ?? 0) + 1;
  cm.contactsInteractionManualNewTodayByUid = map;
}
