import { moment } from "obsidian";
import type { RSLatteIndexItem } from "../../taskRSLatte/types";
import { labelForScheduleCategoryId } from "../../taskRSLatte/schedule/scheduleCategory";

const momentFn = moment as any;

function ymdInRange(ymd: string, startYmd: string, endYmd: string): boolean {
  const s = String(ymd ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return s >= startYmd && s <= endYmd;
}

function scheduleAnchorYmd(it: RSLatteIndexItem): string {
  const ex = (it.extra ?? {}) as Record<string, unknown>;
  const sd = String(ex.schedule_date ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(sd)) return sd;
  return String(it.memoDate ?? "").trim();
}

/** 单块时长（分钟）：同 reviewExecuteModel */
export function scheduleBlockMinutesForViz(it: RSLatteIndexItem): number {
  const ex = (it.extra ?? {}) as Record<string, unknown>;
  const dm = Math.floor(Number(ex.duration_min));
  if (Number.isFinite(dm) && dm > 0) return Math.min(dm, 24 * 60);
  const st = String(ex.start_time ?? "").trim();
  const et = String(ex.end_time ?? "").trim();
  const rm = (x: string) => x.match(/^(\d{1,2}):(\d{2})$/);
  const m1 = rm(st);
  const m2 = rm(et);
  if (m1 && m2) {
    const a = Number(m1[1]) * 60 + Number(m1[2]);
    const b = Number(m2[1]) * 60 + Number(m2[2]);
    let d = b - a;
    if (d < 0) d += 24 * 60;
    if (d > 0 && d <= 24 * 60) return d;
  }
  return 0;
}

function scheduleCategoryId(it: RSLatteIndexItem): string {
  const ex = (it.extra ?? {}) as Record<string, unknown>;
  return String(ex.schedule_category ?? "").trim() || "_uncat";
}

/** 解析为「当天分钟数」0–1440；无效则 null */
function parseStartEndMinutesOfDay(it: RSLatteIndexItem): { start: number; end: number } | null {
  const ex = (it.extra ?? {}) as Record<string, unknown>;
  const st = String(ex.start_time ?? "").trim();
  const et = String(ex.end_time ?? "").trim();
  const rm = (x: string) => x.match(/^(\d{1,2}):(\d{2})$/);
  const m1 = rm(st);
  const m2 = rm(et);
  if (!m1 || !m2) return null;
  const a = Number(m1[1]) * 60 + Number(m1[2]);
  const b = Number(m2[1]) * 60 + Number(m2[2]);
  let d = b - a;
  if (d < 0) d += 24 * 60;
  if (d <= 0 || d > 24 * 60) return null;
  return { start: a, end: b > a ? b : a + d };
}

function enumerateYmds(startYmd: string, endYmd: string): string[] {
  const out: string[] = [];
  const cur = momentFn(startYmd, "YYYY-MM-DD", true);
  const end = momentFn(endYmd, "YYYY-MM-DD", true);
  if (!cur.isValid() || !end.isValid()) return out;
  const c = cur.clone();
  while (c.isSameOrBefore(end, "day")) {
    out.push(c.format("YYYY-MM-DD"));
    c.add(1, "day");
  }
  return out;
}

/** 周视图栅格：6:00–22:00 */
const GRID_START_H = 6;
const GRID_END_H = 22;
const GRID_START_MIN = GRID_START_H * 60;
const GRID_END_MIN = GRID_END_H * 60;

export type ReviewExecuteScheduleDayStack = {
  ymd: string;
  /** 横轴标签：周用「一 3/31」，月用「31」 */
  barLabel: string;
  totalMinutes: number;
  count: number;
  byCategory: { categoryId: string; categoryLabel: string; minutes: number }[];
};

export type ReviewExecuteScheduleWeekBlock = {
  columnYmd: string;
  startMinOfDay: number;
  endMinOfDay: number;
  categoryId: string;
  categoryLabel: string;
  title: string;
};

export type ReviewExecuteScheduleVizModel = {
  grain: "week" | "month" | "quarter";
  periodStartYmd: string;
  periodEndYmd: string;
  completedCount: number;
  completedMinutesTotal: number;
  /** 周期内逐日（用于堆叠柱 + 月热力数据） */
  dayStacks: ReviewExecuteScheduleDayStack[];
  /** 周：时间栅格用的列（与 period 对齐） */
  weekDayYmds: string[];
  weekDayLabels: string[];
  weekGridBlocks: ReviewExecuteScheduleWeekBlock[];
  /** 月：日历格，leading 个空位后接当月各日 */
  monthLeadingBlanks: number;
  monthHeatCells: (null | { ymd: string; totalMinutes: number; count: number })[];
  /** 图例顺序（有数据的分类优先） */
  categoryLegend: { id: string; label: string; slot: number }[];
};

function mondayFirstLeadingBlanks(ymd: string): number {
  const m = momentFn(ymd, "YYYY-MM-DD", true);
  if (!m.isValid()) return 0;
  const dow = m.day();
  return dow === 0 ? 6 : dow - 1;
}

export function buildReviewExecuteScheduleViz(
  schedItems: RSLatteIndexItem[],
  startYmd: string,
  endYmd: string,
  grain: "week" | "month" | "quarter",
  scheduleModule: { scheduleCategoryDefs?: { id: string; label: string }[]; defaultScheduleCategoryId?: string } | undefined,
): ReviewExecuteScheduleVizModel {
  const sm = scheduleModule;
  const includeArchivedRows = grain === "quarter";
  const completed = schedItems.filter((it) => {
    if ((it as any).archived && !includeArchivedRows) return false;
    const st = String(it.status ?? "").toUpperCase().replace(/-/g, "_");
    const dd = String(it.done_date ?? "").trim();
    return st === "DONE" && ymdInRange(dd, startYmd, endYmd);
  });

  let completedMinutesTotal = 0;
  const byDoneDay = new Map<string, { byCat: Record<string, number>; total: number; count: number }>();

  for (const it of completed) {
    const dd = String(it.done_date ?? "").trim();
    const mins = scheduleBlockMinutesForViz(it);
    completedMinutesTotal += mins;
    const cat = scheduleCategoryId(it);
    if (!byDoneDay.has(dd)) byDoneDay.set(dd, { byCat: {}, total: 0, count: 0 });
    const row = byDoneDay.get(dd)!;
    row.count += 1;
    row.total += mins;
    row.byCat[cat] = (row.byCat[cat] ?? 0) + mins;
  }

  const dayYmds = enumerateYmds(startYmd, endYmd);
  const catIdsSeen = new Set<string>();
  for (const it of completed) catIdsSeen.add(scheduleCategoryId(it));

  const dayStacks: ReviewExecuteScheduleDayStack[] = dayYmds.map((ymd) => {
    const row = byDoneDay.get(ymd);
    const byCat = row?.byCat ?? {};
    const segs: { categoryId: string; categoryLabel: string; minutes: number }[] = [];
    for (const [cid, minutes] of Object.entries(byCat)) {
      if (minutes <= 0) continue;
      segs.push({
        categoryId: cid,
        categoryLabel: labelForScheduleCategoryId(sm, cid === "_uncat" ? "" : cid),
        minutes,
      });
    }
    segs.sort((a, b) => b.minutes - a.minutes);
    const m = momentFn(ymd, "YYYY-MM-DD", true);
    const barLabel =
      grain === "week"
        ? `${["日", "一", "二", "三", "四", "五", "六"][m.day()]} ${m.format("M/D")}`
        : grain === "quarter"
          ? m.format("M/D")
          : m.format("D");
    return {
      ymd,
      barLabel,
      totalMinutes: row?.total ?? 0,
      count: row?.count ?? 0,
      byCategory: segs,
    };
  });

  const weekGridBlocks: ReviewExecuteScheduleWeekBlock[] = [];
  if (grain === "week") {
    for (const it of completed) {
      const anchor = scheduleAnchorYmd(it);
      const done = String(it.done_date ?? "").trim();
      const columnYmd = ymdInRange(anchor, startYmd, endYmd) ? anchor : done;
      if (!ymdInRange(columnYmd, startYmd, endYmd)) continue;
      const te = parseStartEndMinutesOfDay(it);
      if (!te) continue;
      let s = te.start;
      let e = te.end;
      s = Math.max(s, GRID_START_MIN);
      e = Math.min(e, GRID_END_MIN);
      if (e <= s) continue;
      const cat = scheduleCategoryId(it);
      weekGridBlocks.push({
        columnYmd,
        startMinOfDay: s,
        endMinOfDay: e,
        categoryId: cat,
        categoryLabel: labelForScheduleCategoryId(sm, cat === "_uncat" ? "" : cat),
        title: String(it.text ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || "日程",
      });
    }
  }

  const monthLeadingBlanks = grain === "month" ? mondayFirstLeadingBlanks(startYmd) : 0;
  const monthHeatCells: (null | { ymd: string; totalMinutes: number; count: number })[] = [];
  if (grain === "month") {
    for (let i = 0; i < monthLeadingBlanks; i++) monthHeatCells.push(null);
    for (const ymd of dayYmds) {
      const row = byDoneDay.get(ymd);
      monthHeatCells.push({
        ymd,
        totalMinutes: row?.total ?? 0,
        count: row?.count ?? 0,
      });
    }
  }

  const legendIds = Array.from(catIdsSeen).filter((id) => id !== "_uncat");
  legendIds.sort();
  if (catIdsSeen.has("_uncat")) legendIds.push("_uncat");
  const categoryLegend = legendIds.map((id, i) => ({
    id,
    label: labelForScheduleCategoryId(sm, id === "_uncat" ? "" : id),
    slot: i % 8,
  }));

  return {
    grain,
    periodStartYmd: startYmd,
    periodEndYmd: endYmd,
    completedCount: completed.length,
    completedMinutesTotal,
    dayStacks,
    weekDayYmds: dayYmds,
    weekDayLabels: dayYmds.map((ymd) => {
      const m = momentFn(ymd, "YYYY-MM-DD", true);
      return `${["日", "一", "二", "三", "四", "五", "六"][m.day()]} ${m.format("M/D")}`;
    }),
    weekGridBlocks,
    monthLeadingBlanks,
    monthHeatCells,
    categoryLegend,
  };
}

export { GRID_START_H, GRID_END_H, GRID_START_MIN, GRID_END_MIN };
