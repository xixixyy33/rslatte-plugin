/**
 * 健康日记行：主行 + HTML 注释 meta（rslatte:health:meta）
 * 与财务 financeJournalMeta 同构，供 recordRSLatte 扫描与弹窗写入共用。
 * 主行首列日期为「日记锚点」（日=当日；周=周一；月=1号），行尾可带说明；meta.card_ref 为逻辑卡片 D:/W:/M:。
 * 主行在 `health` 后为**中文指标名**与展示用数值（饮水量为 Nml）；metric_key 与饮水杯数在 meta 中。
 */

import {
  healthMainLineValueDisplay,
  healthMetricKeyFromMainLineLabel,
  healthMetricMainLineLabel,
} from "../../types/healthTypes";

export type HealthJournalMetaPayload = {
  entry_id: string;
  metric_key: string;
  /** day | week | month */
  period?: string;
  /** 逻辑卡片：D:YYYY-MM-DD | W:YYYY-Www | M:YYYY-MM */
  card_ref?: string;
  is_delete?: boolean;
  /** 饮食日记正文（≤100 字），与 metric diet 配套；主行仅热量 emoji */
  diet_note?: string;
  /** 饮水量：杯数（与 metric_key=water_cups 配套；主行写总毫升） */
  cups?: number;
  /** 睡眠：开始入睡时间 HH:mm（与 metric_key=sleep_hours 配套；主行仍为时长小时数） */
  sleep_start_hm?: string;
  /** 本条首次写入 UTC 毫秒时间戳；编辑时保留原值 */
  created_at_ms?: number;
};

const META_PREFIX = "<!-- rslatte:health:meta ";

/** 合法正整数毫秒时间戳；非法返回 undefined */
export function normalizeHealthCreatedAtMs(raw: unknown): number | undefined {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseInt(String(raw).trim(), 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(Math.min(n, Number.MAX_SAFE_INTEGER));
}

/** 校验并规范为 HH:mm（24h）；非法则返回 undefined */
export function normalizeSleepStartHm(raw: string): string | undefined {
  const s = String(raw ?? "").trim();
  if (!s) return undefined;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return undefined;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) return undefined;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** 主行：`health` 后为中文指标名或旧版英文 key；值为展示用（如 2000ml、70.00、🔥🔥） */
export const HEALTH_DIARY_MAIN_LINE_RE =
  /^\s*[-*]\s+(?:(❌|✅)\s+)?(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?\s+health\s+(\S+)\s+(\S+)(?:\s+(.*))?$/;

export const HEALTH_META_LINE_RE = /^\s*<!--\s*rslatte:health:meta\s+(\{[\s\S]*\})\s*-->\s*$/;

export function parseHealthMetaCommentLine(line: string): HealthJournalMetaPayload | null {
  const m = String(line ?? "").match(HEALTH_META_LINE_RE);
  if (!m) return null;
  try {
    const o = JSON.parse(m[1]) as Record<string, unknown>;
    const entry_id = String(o.entry_id ?? "").trim();
    const metric_key = String(o.metric_key ?? "").trim();
    if (!entry_id || !metric_key) return null;
    const period = String(o.period ?? "day").trim() || "day";
    const card_ref = String(o.card_ref ?? "").trim() || undefined;
    const diet_note_raw = o.diet_note;
    const diet_note =
      diet_note_raw === undefined || diet_note_raw === null
        ? undefined
        : String(diet_note_raw).trim() || undefined;
    const cupsRaw = o.cups;
    const cups =
      typeof cupsRaw === "number" && Number.isFinite(cupsRaw)
        ? Math.max(0, Math.min(30, Math.floor(cupsRaw)))
        : undefined;
    const sshRaw = o.sleep_start_hm;
    const sleep_start_hm =
      sshRaw === undefined || sshRaw === null
        ? undefined
        : (() => {
            const n = normalizeSleepStartHm(String(sshRaw));
            return n;
          })();
    const created_at_ms = normalizeHealthCreatedAtMs(o.created_at_ms);
    return {
      entry_id,
      metric_key,
      period,
      card_ref,
      is_delete: o.is_delete === true,
      diet_note,
      cups,
      sleep_start_hm,
      ...(created_at_ms != null ? { created_at_ms } : {}),
    };
  } catch {
    return null;
  }
}

export function stringifyHealthMetaComment(meta: HealthJournalMetaPayload): string {
  const obj: Record<string, unknown> = {
    entry_id: meta.entry_id,
    metric_key: meta.metric_key,
  };
  const p = String(meta.period ?? "day").trim();
  if (p && p !== "day") obj.period = p;
  const cr = String(meta.card_ref ?? "").trim();
  if (cr) obj.card_ref = cr;
  const dn = String(meta.diet_note ?? "").trim();
  if (dn) obj.diet_note = dn.slice(0, 100);
  if (meta.is_delete === true) obj.is_delete = true;
  if (typeof meta.cups === "number" && Number.isFinite(meta.cups) && String(meta.metric_key ?? "").trim() === "water_cups") {
    obj.cups = Math.max(0, Math.min(30, Math.floor(meta.cups)));
  }
  const ssh = normalizeSleepStartHm(String(meta.sleep_start_hm ?? ""));
  if (ssh && String(meta.metric_key ?? "").trim() === "sleep_hours") obj.sleep_start_hm = ssh;
  const cam = normalizeHealthCreatedAtMs(meta.created_at_ms);
  if (cam != null) obj.created_at_ms = cam;
  return `${META_PREFIX.trim()} ${JSON.stringify(obj)} -->`;
}

export function buildHealthListItemLine(args: {
  /** 日记文件对应日（日卡片=当日；周=周一；月=1号） */
  anchorDateKey: string;
  metricKey: string;
  /** 业务存储值：如饮水为杯数字符串「4」、体重「70.00」 */
  valueToken: string;
  /** 行尾自由文本（如饮食日记），与 cardDisplay 用空格拼接 */
  note?: string;
  timeHm?: string;
  isDelete?: boolean;
  /** 行尾展示的卡片标识，如 D:2026-03-30、W:2026-W13、M:2026-03 */
  cardDisplay?: string;
  /** 饮水 ml = 杯数 × 每杯毫升；默认 500 */
  waterCupMl?: number;
}): string {
  const ts = String(args.timeHm ?? "").trim() || "08:00";
  const nameCol = healthMetricMainLineLabel(args.metricKey);
  const valCol = healthMainLineValueDisplay(args.metricKey, args.valueToken, { waterCupMl: args.waterCupMl });
  const note = String(args.note ?? "").trim();
  const disp = String(args.cardDisplay ?? "").trim();
  const parts: string[] = [];
  if (note) parts.push(note);
  if (disp) parts.push(disp);
  const tail = parts.length ? ` ${parts.join(" ")}` : "";
  if (args.isDelete) {
    return `- ❌ ${args.anchorDateKey} ${ts} health ${nameCol} ${valCol}${tail}`;
  }
  return `- ${args.anchorDateKey} ${ts} health ${nameCol} ${valCol}${tail}`;
}

export function generateHealthEntryId(): string {
  const rnd =
    typeof crypto !== "undefined" && crypto.getRandomValues
      ? Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("")
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return `HE_${rnd}`;
}

export function peekHealthMetaAfterMain(
  lines: string[],
  mainLineIndex: number
): { lineIndex: number; meta: HealthJournalMetaPayload } | null {
  let j = mainLineIndex + 1;
  while (j < lines.length && String(lines[j] ?? "").trim() === "") j++;
  if (j >= lines.length) return null;
  const meta = parseHealthMetaCommentLine(lines[j] ?? "");
  if (!meta) return null;
  return { lineIndex: j, meta };
}

function healthMainValueMatchesIndex(metricKey: string, mainVal: string, indexValueStr: string, waterCupMl: number): boolean {
  const want = String(indexValueStr ?? "").trim();
  const raw = String(mainVal ?? "").trim();
  if (!want && !raw) return true;
  const mk = String(metricKey ?? "").trim();
  if (mk === "water_cups") {
    const wantCups = parseInt(want, 10);
    if (!Number.isFinite(wantCups)) return raw === want;
    const mMl = raw.match(/^(\d+)\s*ml$/i);
    if (mMl) {
      const ml = parseInt(mMl[1], 10);
      if (!Number.isFinite(ml)) return false;
      const derived = Math.max(0, Math.round(ml / waterCupMl));
      return derived === wantCups;
    }
    const asCups = parseInt(raw, 10);
    return Number.isFinite(asCups) && asCups === wantCups;
  }
  return raw === want;
}

/**
 * 在已拆分的日记行中查找某条健康记录主行行号（0-based）。
 * 优先按 `entry_id` + `metric_key`（meta 下一行）取文件中最后一次出现。
 * 无 entry_id 时按同日 + 指标 + 主行展示值尽力匹配（legacy，无 meta 行）。
 */
export function findHealthMainLineIndexInDiaryLines(
  lines: string[],
  dayKey: string,
  opts: {
    entryId?: string;
    metricKey: string;
    valueStr: string;
    isDelete?: boolean;
    waterCupMl?: number;
  },
): number | null {
  const eid = String(opts.entryId ?? "").trim();
  const wantMk = String(opts.metricKey ?? "").trim();
  const wantDel = !!opts.isDelete;
  const waterMlPer = Math.max(50, Math.min(2000, Number(opts.waterCupMl) || 500));

  let lastByEntry: number | null = null;
  if (eid) {
    for (let i = 0; i < lines.length; i++) {
      const m = String(lines[i] ?? "").match(HEALTH_DIARY_MAIN_LINE_RE);
      if (!m) continue;
      const rd = m[2];
      if (rd !== dayKey) continue;
      const mark = (m[1] ?? "") as string;
      const peek = peekHealthMetaAfterMain(lines, i);
      if (!peek || String(peek.meta.entry_id ?? "").trim() !== eid) continue;
      const metaMk = String(peek.meta.metric_key ?? "").trim();
      if (metaMk !== wantMk) continue;
      const lineIsDel = mark === "❌" || peek.meta.is_delete === true;
      if (lineIsDel !== wantDel) continue;
      lastByEntry = i;
    }
    if (lastByEntry != null) return lastByEntry;
  }

  let lastLegacy: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = String(lines[i] ?? "").match(HEALTH_DIARY_MAIN_LINE_RE);
    if (!m) continue;
    const rd = m[2];
    if (rd !== dayKey) continue;
    const mark = (m[1] ?? "") as string;
    const isDelLine = mark === "❌";
    if (isDelLine !== wantDel) continue;
    const token = String(m[4] ?? "").trim();
    const mk = healthMetricKeyFromMainLineLabel(token);
    if (mk !== wantMk) continue;
    const mainVal = String(m[5] ?? "").trim();
    if (!healthMainValueMatchesIndex(wantMk, mainVal, opts.valueStr, waterMlPer)) continue;
    const peek = peekHealthMetaAfterMain(lines, i);
    if (peek) continue;
    lastLegacy = i;
  }
  return lastLegacy;
}
