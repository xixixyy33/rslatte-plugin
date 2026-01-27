/**
 * Minimal Lunar (Chinese) -> Solar conversion helpers (1900-2100).
 *
 * This is intentionally dependency-free to keep the plugin self-contained.
 *
 * References: common public-domain lunarInfo bitmask tables (widely used in
 * JavaScript lunar calendar implementations).
 */

import { moment } from "obsidian";

// 1900-2100 (inclusive)
// eslint-disable-next-line @typescript-eslint/naming-convention
const LUNAR_INFO: number[] = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5d0, 0x14573, 0x052d0, 0x0a9a8, 0x0e950, 0x06aa0,
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b5a0, 0x195a6,
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x05ac0, 0x0ab60, 0x096d5, 0x092e0,
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
  0x05aa0, 0x076a3, 0x096d0, 0x04bd7, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0,
  0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4,
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0,
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160,
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252,
  0x0d520,
];
const momentFn = moment as any;
const SOLAR_START = momentFn("1900-01-31", "YYYY-MM-DD").startOf("day"); // 1900 lunar 1-1

function leapMonth(year: number): number {
  return LUNAR_INFO[year - 1900] & 0xf;
}

function leapDays(year: number): number {
  const lm = leapMonth(year);
  if (lm === 0) return 0;
  return (LUNAR_INFO[year - 1900] & 0x10000) ? 30 : 29;
}

function monthDays(year: number, month: number): number {
  // month: 1..12
  return (LUNAR_INFO[year - 1900] & (0x10000 >> month)) ? 30 : 29;
}

function yearDays(year: number): number {
  let sum = 348; // 12*29
  const info = LUNAR_INFO[year - 1900];
  for (let i = 0x8000; i > 0x8; i >>= 1) {
    sum += (info & i) ? 1 : 0;
  }
  return sum + leapDays(year);
}

export type SolarYmd = { year: number; month: number; day: number };

/**
 * Convert lunar date -> solar date.
 * @param year solar year used for conversion
 * @param month lunar month 1..12
 * @param day lunar day 1..30
 * @param isLeapMonth whether lunar month is leap month
 */
export function lunar2solar(year: number, month: number, day: number, isLeapMonth: boolean): SolarYmd {
  if (year < 1900 || year > 2100) throw new Error("农历换算仅支持 1900-2100");
  if (month < 1 || month > 12) throw new Error("农历月份必须为 1-12");
  if (day < 1 || day > 30) throw new Error("农历日期必须为 1-30");

  // Days offset from 1900-01-31
  let offset = 0;
  for (let y = 1900; y < year; y++) offset += yearDays(y);

  const lm = leapMonth(year);
  const hasLeap = lm > 0;
  if (isLeapMonth && (!hasLeap || lm !== month)) {
    // This year doesn't have requested leap month; fallback to non-leap same month.
    isLeapMonth = false;
  }

  for (let m = 1; m < month; m++) {
    offset += monthDays(year, m);
    if (hasLeap && m === lm) offset += leapDays(year);
  }

  // current month
  if (hasLeap && month === lm && isLeapMonth) {
    // first add normal month days
    offset += monthDays(year, month);
  }

  offset += (day - 1);

  const solar = SOLAR_START.clone().add(offset, "days");
  return { year: solar.year(), month: solar.month() + 1, day: solar.date() };
}

export function solarYmdToStr(s: SolarYmd): string {
  return `${s.year}-${String(s.month).padStart(2, "0")}-${String(s.day).padStart(2, "0")}`;
}

/**
 * For a given Gregorian year, find the solar date that corresponds to the lunar MM-DD
 * occurrence that falls within that Gregorian year.
 *
 * NOTE:
 * Lunar year does NOT align with Gregorian year. For example, lunar month 12 often falls
 * in the following Gregorian year. Therefore, for a target Gregorian year G, the lunar date
 * may belong to lunar year G-1 or G.
 */
function solarDateForLunarMmddInGregorianYear(
  gregYear: number,
  lunarMonth: number,
  lunarDay: number,
  isLeapMonth: boolean,
): SolarYmd {
  const candPrev = lunar2solar(gregYear - 1, lunarMonth, lunarDay, isLeapMonth);
  const candCurr = lunar2solar(gregYear, lunarMonth, lunarDay, isLeapMonth);

  const prevInYear = candPrev.year === gregYear;
  const currInYear = candCurr.year === gregYear;

  if (prevInYear && !currInYear) return candPrev;
  if (currInYear && !prevInYear) return candCurr;

  // Fallback (should be rare): choose the candidate closer to the target year.
  // Prefer the one not earlier than Jan 1 of the target year.
  if (candCurr.year > gregYear) return candPrev;
  return candCurr;
}

/**
 * Compute next solar date for a lunar birthday (MM-DD + leap flag).
 */
export function nextSolarDateForLunarBirthday(lunarMmdd: string, isLeapMonth: boolean, todayYmd?: string): string {
  const m = (lunarMmdd ?? "").trim().match(/^(\d{2})-(\d{2})$/);
  if (!m) throw new Error("农历日期格式必须为 MM-DD");
  const lm = Number(m[1]);
  const ld = Number(m[2]);
  const today = todayYmd ? momentFn(todayYmd, "YYYY-MM-DD").startOf("day") : momentFn().startOf("day");

  const y = today.year();
  const s0 = solarYmdToStr(solarDateForLunarMmddInGregorianYear(y, lm, ld, isLeapMonth));
  if (momentFn(s0, "YYYY-MM-DD").isSameOrAfter(today)) return s0;
  return solarYmdToStr(solarDateForLunarMmddInGregorianYear(y + 1, lm, ld, isLeapMonth));
}
