import { normalizePath } from "obsidian";
import type { RSLatteIndexItem } from "../../taskRSLatte/types";
import { isScheduleMemoLine } from "../../taskRSLatte/types";

/** 日程业务日 YYYY-MM-DD（与 scheduleTags.getScheduleDate 一致） */
export function getScheduleDateYmd(it: RSLatteIndexItem): string | null {
  const extra = ((it as any)?.extra ?? {}) as Record<string, unknown>;
  const fromExtra = String(extra.schedule_date ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(fromExtra)) return fromExtra;
  const md = String((it as any)?.memoDate ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(md)) return md;
  return null;
}

/**
 * 日历格计数与日程日历列表：排除取消（CANCELLED）、失效；含已完成（DONE）。
 * 已取消条目不会进入 `groupScheduleItemsByDate`，故迷你日历与展开区均不展示。
 */
export function isCalendarScheduleItem(it: RSLatteIndexItem): boolean {
  if (!isScheduleMemoLine(it)) return false;
  const st = String((it as any)?.status ?? "").toUpperCase();
  if (st === "CANCELLED") return false;
  const extra = ((it as any)?.extra ?? {}) as Record<string, unknown>;
  if (String(extra.invalidated ?? "").trim() === "1") return false;
  return getScheduleDateYmd(it) != null;
}

/** 未闭环日程（用于重叠检测、进行中判断） */
export function isOpenScheduleItem(it: RSLatteIndexItem): boolean {
  if (!isCalendarScheduleItem(it)) return false;
  const st = String((it as any)?.status ?? "").toUpperCase();
  return st !== "DONE" && st !== "CANCELLED";
}

/** 密度点：0 / 1 / 2 / 3 档 */
export function densityDotsForCount(n: number): 0 | 1 | 2 | 3 {
  if (n <= 0) return 0;
  if (n <= 2) return 1;
  if (n <= 5) return 2;
  return 3;
}

type DayInterval = { start: number; end: number };

/** 当日日程在时间轴上的 [start,end) 分钟，与泳道/条带布局一致 */
export function getScheduleDayIntervalMinutes(it: RSLatteIndexItem): DayInterval | null {
  const extra = ((it as any)?.extra ?? {}) as Record<string, unknown>;
  const dur = Math.floor(Number(extra.duration_min ?? 0));
  const st = String(extra.start_time ?? "").trim();
  const et = String(extra.end_time ?? "").trim();

  if (Number.isFinite(dur) && dur >= 23 * 60) return { start: 0, end: 1440 };
  if (st === "00:00" && et === "23:59") return { start: 0, end: 1440 };

  const hm = st.match(/^(\d{1,2}):(\d{2})$/);
  if (!hm) {
    // 无开始时间：不参与精细重叠，避免误判；全天占位
    if (!st && (!Number.isFinite(dur) || dur <= 0)) return { start: 0, end: 1440 };
    if (!st) return { start: 0, end: 1440 };
    return null;
  }
  const start = Number(hm[1]) * 60 + Number(hm[2]);
  const duration = Number.isFinite(dur) && dur > 0 ? dur : 60;
  let end = start + duration;
  if (end > 1440) end = 1440;
  if (end <= start) end = Math.min(1440, start + 30);
  return { start, end };
}

/** 当日「未闭环」日程是否存在时间段重叠（含全天与定时交叉） */
export function dayHasOpenScheduleOverlap(items: RSLatteIndexItem[]): boolean {
  const open = items.filter(isOpenScheduleItem);
  if (open.length < 2) return false;
  const intervals: DayInterval[] = [];
  for (const it of open) {
    const iv = getScheduleDayIntervalMinutes(it);
    if (iv) intervals.push(iv);
  }
  if (intervals.length < 2) return false;
  for (let i = 0; i < intervals.length; i++) {
    for (let j = i + 1; j < intervals.length; j++) {
      const a = intervals[i];
      const b = intervals[j];
      if (Math.max(a.start, b.start) < Math.min(a.end, b.end)) return true;
    }
  }
  return false;
}

/** 稳定键：用于列表与重叠集合对齐 */
export function scheduleItemStableKey(it: RSLatteIndexItem): string {
  const u = String((it as any)?.uid ?? "").trim();
  if (u) return `uid:${u}`;
  return `loc:${normalizePath(String((it as any)?.filePath ?? ""))}#${Number((it as any)?.lineNo ?? 0)}`;
}

function mergeDayIntervals(intervals: DayInterval[]): DayInterval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out: DayInterval[] = [];
  let cur = { ...sorted[0] };
  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i];
    if (n.start < cur.end) cur.end = Math.max(cur.end, n.end);
    else {
      out.push(cur);
      cur = { ...n };
    }
  }
  out.push(cur);
  return out;
}

/**
 * 当日在日历上展示的日程（含已完成）之间，时间段真正相交的区间并集。
 * 用于泳道竖线、迷你日历角标；与「仅未闭环」无关，避免已完成与进行中交叉时角标缺失。
 */
export function getScheduleDayOverlapRegions(items: RSLatteIndexItem[]): DayInterval[] {
  const list = items.filter(isCalendarScheduleItem);
  const intervals: DayInterval[] = [];
  for (const it of list) {
    const iv = getScheduleDayIntervalMinutes(it);
    if (iv) intervals.push(iv);
  }
  if (intervals.length < 2) return [];
  const raw: DayInterval[] = [];
  for (let i = 0; i < intervals.length; i++) {
    for (let j = i + 1; j < intervals.length; j++) {
      const a = intervals[i];
      const b = intervals[j];
      const s = Math.max(a.start, b.start);
      const e = Math.min(a.end, b.end);
      if (s < e) raw.push({ start: s, end: e });
    }
  }
  return mergeDayIntervals(raw);
}

export function dayHasScheduleTimeOverlap(items: RSLatteIndexItem[]): boolean {
  return getScheduleDayOverlapRegions(items).length > 0;
}

/** 参与至少一对时间重叠的条目键集合 */
export function scheduleItemOverlapKeys(items: RSLatteIndexItem[]): Set<string> {
  const list = items.filter(isCalendarScheduleItem);
  const ivs: { start: number; end: number; key: string }[] = [];
  for (const it of list) {
    const iv = getScheduleDayIntervalMinutes(it);
    if (!iv) continue;
    ivs.push({ ...iv, key: scheduleItemStableKey(it) });
  }
  const hit = new Set<string>();
  for (let i = 0; i < ivs.length; i++) {
    for (let j = i + 1; j < ivs.length; j++) {
      const a = ivs[i];
      const b = ivs[j];
      if (Math.max(a.start, b.start) < Math.min(a.end, b.end)) {
        hit.add(a.key);
        hit.add(b.key);
      }
    }
  }
  return hit;
}

export function groupScheduleItemsByDate(items: RSLatteIndexItem[]): Map<string, RSLatteIndexItem[]> {
  const m = new Map<string, RSLatteIndexItem[]>();
  for (const it of items) {
    if (!isCalendarScheduleItem(it)) continue;
    const d = getScheduleDateYmd(it)!;
    const arr = m.get(d) ?? [];
    arr.push(it);
    m.set(d, arr);
  }
  return m;
}

/** 当日列表：按开始时间排序，无时间排后 */
export function sortSchedulesForDay(items: RSLatteIndexItem[]): RSLatteIndexItem[] {
  return [...items].sort((a, b) => {
    const ea = ((a as any)?.extra ?? {}) as Record<string, unknown>;
    const eb = ((b as any)?.extra ?? {}) as Record<string, unknown>;
    const ta = String(ea.start_time ?? "").trim();
    const tb = String(eb.start_time ?? "").trim();
    const pa = /^(\d{1,2}):(\d{2})$/.test(ta) ? ta : "99:99";
    const pb = /^(\d{1,2}):(\d{2})$/.test(tb) ? tb : "99:99";
    const c = pa.localeCompare(pb);
    if (c !== 0) return c;
    return String((a as any)?.text ?? "").localeCompare(String((b as any)?.text ?? ""), "zh-Hans");
  });
}

/** 日时间轴上的条带位置（0–100%） */
export function scheduleBarLayout(it: RSLatteIndexItem): { leftPct: number; widthPct: number } {
  const iv = getScheduleDayIntervalMinutes(it);
  if (!iv) return { leftPct: 0, widthPct: 2 };
  const widthPct = Math.max(((iv.end - iv.start) / 1440) * 100, 2);
  const leftPct = (iv.start / 1440) * 100;
  return { leftPct, widthPct };
}

export type ScheduleSwimlaneSegment = {
  item: RSLatteIndexItem;
  lane: number;
  leftPct: number;
  widthPct: number;
};

/**
 * 将当日日程排成多行泳道：时间段重叠的条目不在同一行，便于看出并行。
 * 贪心：按开始时间排序，每条放入「上一条结束时间 ≤ 本条开始」的最低序号行。
 */
export function buildScheduleDaySwimlaneSegments(items: RSLatteIndexItem[]): {
  segments: ScheduleSwimlaneSegment[];
  laneCount: number;
} {
  type Row = { item: RSLatteIndexItem; start: number; end: number; leftPct: number; widthPct: number };
  const rows: Row[] = [];
  for (const it of items) {
    const iv = getScheduleDayIntervalMinutes(it);
    if (!iv) continue;
    const widthPct = Math.max(((iv.end - iv.start) / 1440) * 100, 2);
    const leftPct = (iv.start / 1440) * 100;
    rows.push({ item: it, start: iv.start, end: iv.end, leftPct, widthPct });
  }
  rows.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.end - a.end;
  });

  const laneEnds: number[] = [];
  const segments: ScheduleSwimlaneSegment[] = [];
  for (const r of rows) {
    let lane = -1;
    for (let j = 0; j < laneEnds.length; j++) {
      if (laneEnds[j] <= r.start) {
        lane = j;
        break;
      }
    }
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(r.end);
    } else {
      laneEnds[lane] = r.end;
    }
    segments.push({ item: r.item, lane, leftPct: r.leftPct, widthPct: r.widthPct });
  }
  const laneCount = Math.max(1, laneEnds.length);
  return { segments, laneCount };
}

/** 当前时刻（分钟）是否落在条内；仅当 dateYmd === 选中且为「今天」时有意义 */
export function isScheduleInProgressNow(it: RSLatteIndexItem, dateYmd: string, todayYmd: string, nowMins: number): boolean {
  if (dateYmd !== todayYmd) return false;
  if (!isOpenScheduleItem(it)) return false;
  const iv = getScheduleDayIntervalMinutes(it);
  if (!iv) return false;
  return nowMins >= iv.start && nowMins < iv.end;
}

/** 展示用时间文案 */
export function formatScheduleTimeSummary(it: RSLatteIndexItem): string {
  const extra = ((it as any)?.extra ?? {}) as Record<string, unknown>;
  const st = String(extra.start_time ?? "").trim();
  const dur = Math.floor(Number(extra.duration_min ?? 0));
  const et = String(extra.end_time ?? "").trim();
  if (Number.isFinite(dur) && dur >= 23 * 60) return "全天";
  if (st === "00:00" && et === "23:59") return "全天";
  if (/^\d{1,2}:\d{2}$/.test(st)) {
    if (Number.isFinite(dur) && dur > 0) return `${st} · ${dur} 分钟`;
    if (/^\d{1,2}:\d{2}$/.test(et)) return `${st} – ${et}`;
    return st;
  }
  return st || "时间未填";
}

/** `6:30` / `06:30` → `06:30`；支持 `24:00` */
function normalizeScheduleHmForCompare(raw: string): string | null {
  const t = String(raw ?? "").trim();
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h === 24 && min === 0) return "24:00";
  if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function expectedEndHmFromStartAndDuration(startHmNorm: string, durMin: number): string | null {
  if (!/^\d{2}:\d{2}$/.test(startHmNorm) || !Number.isFinite(durMin) || durMin <= 0) return null;
  const [h, mm] = startHmNorm.split(":").map(Number);
  let endM = h * 60 + mm + Math.floor(durMin);
  if (endM > 1440) endM = 1440;
  const eh = Math.floor(endM / 60);
  const em = endM % 60;
  if (eh >= 24 && em === 0) return "24:00";
  return `${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`;
}

/**
 * 日程日历等展示用：去掉行首与索引 meta 一致的 `HH:MM-HH:MM` 前缀（与 createScheduleMemo 写入的 timePrefix 重复）。
 * 仅当解析出的起止与 `start_time` / `end_time` 或 `start_time`+`duration_min` 一致时才截取，避免误删正文。
 */
export function stripRedundantScheduleTimeRangePrefix(it: RSLatteIndexItem, displayText: string): string {
  const s0 = String(displayText ?? "").trimStart();
  const re = /^(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})(\s+|$)/;
  const m = s0.match(re);
  if (!m) return s0.trim();

  const g1 = normalizeScheduleHmForCompare(m[1] ?? "");
  const g2 = normalizeScheduleHmForCompare(m[2] ?? "");
  if (!g1 || !g2) return s0.trim();

  const extra = ((it as any)?.extra ?? {}) as Record<string, unknown>;
  const metaSt = normalizeScheduleHmForCompare(String(extra.start_time ?? ""));
  if (!metaSt || metaSt !== g1) return s0.trim();

  const metaEt = normalizeScheduleHmForCompare(String(extra.end_time ?? ""));
  const dur = Math.floor(Number(extra.duration_min ?? 0));
  const expectedFromDur = expectedEndHmFromStartAndDuration(metaSt, dur);

  const endOk =
    (metaEt != null && metaEt === g2) ||
    (expectedFromDur != null && expectedFromDur === g2);

  if (!endOk) return s0.trim();

  return s0.slice(m[0].length).trim();
}
