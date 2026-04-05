import { normalizePath } from "obsidian";

const momentFn = (window as any).moment as undefined | ((inp?: any, fmt?: any, strict?: any) => any);

/** ISO 周键，与 Review 工具栏一致：`YYYY-Www` */
export function isoWeekKeyFromStartYmd(startYmd: string): string {
  const m = momentFn?.(startYmd, "YYYY-MM-DD", true);
  if (!m?.isValid?.()) return "";
  const y = m.isoWeekYear();
  const w = m.isoWeek();
  return `${y}-W${String(w).padStart(2, "0")}`;
}

/** 自然月键：`YYYY-MM`（取周期起始日的历月） */
export function calendarMonthKeyFromStartYmd(startYmd: string): string {
  const m = momentFn?.(startYmd, "YYYY-MM-DD", true);
  return m?.isValid?.() ? m.format("YYYY-MM") : "";
}

/** 历季键：`YYYY-Q1`～`Q4`（Q1=1–3 月） */
export function calendarQuarterKeyFromStartYmd(startYmd: string): string {
  const m = momentFn?.(startYmd, "YYYY-MM-DD", true);
  if (!m?.isValid?.()) return "";
  const month = m.month() + 1;
  const q = Math.floor((month - 1) / 3) + 1;
  return `${m.year()}-Q${q}`;
}

function diaryDirNorm(diaryDir: string): string {
  return normalizePath(String(diaryDir ?? "").trim().replace(/\/+$/g, ""));
}

/**
 * 周报/月报与「日记根目录」同级：取 `diaryPath` 的**上一级**作为 `weekly/`、`monthly/` 的父路径。
 * 例：`10-Personal/11-Daily/diary` → `10-Personal/11-Daily/weekly/...`（与 `diary` 文件夹并列）。
 * 若日记路径仅一层且无 `/`（如顶层 `diary`），无父级则退回为原路径，行为同旧版 `diary/weekly`。
 */
export function periodReportBaseDirFromDiaryPath(diaryDir: string): string {
  const norm = diaryDirNorm(diaryDir);
  if (!norm) return "";
  const i = norm.lastIndexOf("/");
  if (i <= 0) return norm;
  return norm.slice(0, i);
}

/**
 * 周报相对 vault 路径：`{日记路径的上一级}/weekly/YYYY-Www.md`
 */
export function buildWeeklyReportVaultPath(diaryDir: string, startYmd: string): string {
  const base = periodReportBaseDirFromDiaryPath(diaryDir);
  const wk = isoWeekKeyFromStartYmd(startYmd);
  if (!base || !wk) return "";
  return normalizePath(`${base}/weekly/${wk}.md`);
}

/**
 * 月报相对 vault 路径：`{日记路径的上一级}/monthly/YYYY-MM.md`
 */
export function buildMonthlyReportVaultPath(diaryDir: string, startYmd: string): string {
  const base = periodReportBaseDirFromDiaryPath(diaryDir);
  const mk = calendarMonthKeyFromStartYmd(startYmd);
  if (!base || !mk) return "";
  return normalizePath(`${base}/monthly/${mk}.md`);
}

/**
 * 季报相对 vault 路径：`{日记路径的上一级}/quarterly/YYYY-Qn.md`
 */
export function buildQuarterlyReportVaultPath(diaryDir: string, startYmd: string): string {
  const base = periodReportBaseDirFromDiaryPath(diaryDir);
  const qk = calendarQuarterKeyFromStartYmd(startYmd);
  if (!base || !qk) return "";
  return normalizePath(`${base}/quarterly/${qk}.md`);
}
