import moment from "moment";

const momentFn = moment as any;

/** 日卡片：逻辑日 = 所选日；日记锚点 = 同日 */
export function formatDayCardRef(dateKey: string): string {
  const d = String(dateKey ?? "").trim();
  return d ? `D:${d}` : "";
}

/** 周卡片：ISO 周年 + ISO 周序号，展示形如 W:2026-W13 */
export function formatWeekCardRef(isoYear: number, isoWeek: number): string {
  const y = Math.floor(Number(isoYear));
  const w = Math.floor(Number(isoWeek));
  if (!Number.isFinite(y) || !Number.isFinite(w) || w < 1 || w > 53) return "";
  return `W:${y}-W${String(w).padStart(2, "0")}`;
}

/** 月卡片：M:YYYY-MM */
export function formatMonthCardRef(year: number, month1to12: number): string {
  const y = Math.floor(Number(year));
  const m = Math.floor(Number(month1to12));
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return "";
  return `M:${y}-${String(m).padStart(2, "0")}`;
}

export function parseDayCardRef(ref: string): string | null {
  const m = String(ref ?? "").match(/^D:(\d{4}-\d{2}-\d{2})$/);
  return m ? m[1] : null;
}

export function parseWeekCardRef(ref: string): { isoYear: number; isoWeek: number } | null {
  const m = String(ref ?? "").match(/^W:(\d{4})-W(\d{1,2})$/);
  if (!m) return null;
  const isoYear = Number(m[1]);
  const isoWeek = Number(m[2]);
  if (!Number.isFinite(isoYear) || !Number.isFinite(isoWeek)) return null;
  return { isoYear, isoWeek };
}

export function parseMonthCardRef(ref: string): { y: number; m: number } | null {
  const m = String(ref ?? "").match(/^M:(\d{4})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mon = Number(m[2]);
  if (!Number.isFinite(y) || !Number.isFinite(mon) || mon < 1 || mon > 12) return null;
  return { y, m: mon };
}

/** 周卡片写入用：该 ISO 周的周一 YYYY-MM-DD */
export function mondayKeyOfIsoWeek(isoYear: number, isoWeek: number): string {
  return momentFn().isoWeekYear(isoYear).isoWeek(isoWeek).startOf("isoWeek").format("YYYY-MM-DD");
}

/** 月卡片写入用：当月 1 号 */
export function firstDayKeyOfMonth(year: number, month1to12: number): string {
  return momentFn(`${year}-${String(month1to12).padStart(2, "0")}-01`, "YYYY-MM-DD", true).format("YYYY-MM-DD");
}

/** 任取一周内某一天 → 周标识 + 周一锚点 */
export function weekCardFromAnyDateKey(dateKey: string): { cardRef: string; anchorDateKey: string } {
  const m = momentFn(dateKey, "YYYY-MM-DD", true);
  if (!m.isValid()) return { cardRef: "", anchorDateKey: "" };
  const isoY = m.isoWeekYear();
  const isoW = m.isoWeek();
  return {
    cardRef: formatWeekCardRef(isoY, isoW),
    anchorDateKey: m.clone().startOf("isoWeek").format("YYYY-MM-DD"),
  };
}

/** 从索引项反推卡片标识（无 meta 的旧数据按锚点日期推断） */
export function inferCardRefFromItem(args: {
  recordDate: string;
  period?: string;
  cardRef?: string;
}): string {
  const cr = String(args.cardRef ?? "").trim();
  if (cr) return cr;
  const rd = String(args.recordDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rd)) return "";
  const p = String(args.period ?? "day").trim().toLowerCase() || "day";
  if (p === "week") {
    const m = momentFn(rd, "YYYY-MM-DD", true);
    if (!m.isValid()) return "";
    return formatWeekCardRef(m.isoWeekYear(), m.isoWeek());
  }
  if (p === "month") {
    return formatMonthCardRef(Number(rd.slice(0, 4)), Number(rd.slice(5, 7)));
  }
  return formatDayCardRef(rd);
}
