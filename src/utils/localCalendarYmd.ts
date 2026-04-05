/**
 * 插件内 **时刻（datetime）** 落盘与统计的推荐格式：本机时区偏移的 ISO 8601（如 `2026-03-30T03:51:50.727+08:00`）。
 * - 勿用 `toISOString()`（UTC `Z`）写入业务时间，否则与本地日历日、展示不一致。
 * - **纯日期**业务键请用 `todayLocalYmd` / `localYmdFromInstant` / `formatLocalYmd`，不要用 UTC 截断。
 * `new Date(s)` 可解析本格式与 `Z` 格式。
 */
export function toLocalOffsetIsoString(isoOrDate?: string | Date | null): string {
  const d =
    isoOrDate == null
      ? new Date()
      : typeof isoOrDate === "string"
        ? new Date(isoOrDate)
        : isoOrDate;
  if (Number.isNaN(d.getTime())) {
    return toLocalOffsetIsoString(new Date());
  }
  const pad = (n: number, w = 2) => String(Math.trunc(n)).padStart(w, "0");
  const y = d.getFullYear();
  const mo = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const h = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  const ms = pad(d.getMilliseconds(), 3);
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  const zh = pad(Math.floor(abs / 60));
  const zm = pad(abs % 60);
  return `${y}-${mo}-${day}T${h}:${mi}:${s}.${ms}${sign}${zh}:${zm}`;
}

/** 当前本机日历日 `YYYY-MM-DD`（与 `calendarTodayYmd` / 任务侧「自然日」对齐用途） */
export function todayLocalYmd(): string {
  return formatLocalYmd(new Date());
}

/** 按本机历日格式化为 `YYYY-MM-DD`（基于本地年/月/日分量，不经 UTC 截断） */
export function formatLocalYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 日历日加减（本地历日） */
export function addDaysLocalYmd(ymd: string, deltaDays: number): string {
  const m = String(ymd ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(ymd ?? "").slice(0, 10);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() + deltaDays);
  return formatLocalYmd(d);
}

/** 含该日期的自然周（周一为一周起点）的周一日期 `YYYY-MM-DD` */
export function weekStartMondayLocalYmd(d: Date): string {
  const dt = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const w = dt.getDay() || 7;
  dt.setDate(dt.getDate() - (w - 1));
  return formatLocalYmd(dt);
}

/**
 * 将带时区的 ISO 时刻转为用户本机日历日 YYYY-MM-DD（避免 `...Z` 被当成 UTC 日切片）。
 * 纯 `YYYY-MM-DD` 无时分则原样返回（视为用户日历日，不做偏移）。
 */
export function localYmdFromInstant(isoOrDate: string | Date | undefined | null): string | undefined {
  if (isoOrDate == null) return undefined;
  if (isoOrDate instanceof Date) {
    if (Number.isNaN(isoOrDate.getTime())) return undefined;
    return formatLocalYmd(isoOrDate);
  }
  const s = String(isoOrDate).trim();
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  return formatLocalYmd(d);
}

/**
 * 输出「完成」展示/统计用日历日：若存在 `done_time` 等时刻字段，以本地日为准；否则用 `doneDate` 的 YMD 前缀。
 */
export function outputDoneLocalYmd(doneDate?: string | null, doneTime?: string | null): string {
  const t = String(doneTime ?? "").trim();
  if (t && /T/i.test(t)) {
    const y = localYmdFromInstant(t);
    if (y) return y;
  }
  const d = String(doneDate ?? "").trim();
  const m = d.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  return localYmdFromInstant(t) ?? "";
}
