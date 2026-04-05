import { toLocalOffsetIsoString } from "../utils/localCalendarYmd";

export function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function todayYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function isYmd(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function isMmdd(s: string): boolean {
  return /^\d{2}-\d{2}$/.test(s);
}

export function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** 当前时刻，带本机时区偏移（与 `toLocalOffsetIsoString` 一致）；勿再用 UTC `Z` 写入笔记/meta。 */
export function toIsoNow(): string {
  return toLocalOffsetIsoString();
}

export function monthKeyFromYmd(ymd: string): string {
  // YYYY-MM from YYYY-MM-DD
  return ymd.slice(0, 7);
}

export function firstDayOfMonth(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

export function addMonths(ymd: string, deltaMonths: number): string {
  const [y, m, d] = ymd.split("-").map((x) => parseInt(x, 10));
  const date = new Date(y, m - 1, d);
  date.setMonth(date.getMonth() + deltaMonths);
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export function cmpYmd(a?: string | null, b?: string | null): number {
  const aa = (a ?? "").trim();
  const bb = (b ?? "").trim();
  if (!aa && !bb) return 0;
  if (!aa) return -1;
  if (!bb) return 1;
  return aa.localeCompare(bb);
}

/** 进行中三种子阶段（与 checkbox [/] 配套） */
const IN_PROGRESS_DISPLAY_PHASES = new Set(["in_progress", "waiting_others", "waiting_until"]);

/**
 * 任务展示阶段（含闭环）：以 checkbox 解析出的 status 为准，与 meta 中 task_phase 对齐。
 * 见 docs/V2改造方案/执行类管理优化方案.md · 任务管理优化 · 第二节。
 */
export function reconcileTaskDisplayPhase(
  status: string,
  rawPhase: string | undefined | null,
  hints?: { wait_until?: string; follow_up?: string }
): string {
  const st = String(status ?? "").trim().toUpperCase();
  const phase = String(rawPhase ?? "").trim();

  if (st === "TODO") return "todo";
  if (st === "DONE") return "done";
  if (st === "CANCELLED") return "cancelled";
  if (st === "IN_PROGRESS" || st === "IN-PROGRESS") {
    if (IN_PROGRESS_DISPLAY_PHASES.has(phase)) return phase;
    const wu = hints?.wait_until && /^\d{4}-\d{2}-\d{2}$/.test(String(hints.wait_until).trim());
    const fu = hints?.follow_up && /^\d{4}-\d{2}-\d{2}$/.test(String(hints.follow_up).trim());
    if (wu) return "waiting_until";
    if (fu) return "waiting_others";
    return "in_progress";
  }
  return phase || "todo";
}

/**
 * 从索引项（或侧栏条目）推导展示阶段，供 WorkEvent.ref.task_phase_before/after 与 Today 核对区聚合。
 */
export function indexItemTaskDisplayPhase(it: {
  status?: string;
  task_phase?: string | null;
  wait_until?: string;
  follow_up?: string;
}): string {
  return reconcileTaskDisplayPhase(String(it?.status ?? ""), it?.task_phase, {
    wait_until: (it as { wait_until?: string })?.wait_until,
    follow_up: (it as { follow_up?: string })?.follow_up,
  });
}

/** checkbox 目标状态对应的展示阶段（与 meta task_phase 写入一致） */
export function displayPhaseAfterTaskCheckbox(
  to: "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED"
): "todo" | "in_progress" | "done" | "cancelled" {
  if (to === "DONE") return "done";
  if (to === "CANCELLED") return "cancelled";
  if (to === "TODO") return "todo";
  return "in_progress";
}

/** 合法重复规则（笔记中 🔁 与索引 repeatRule 使用 quarterly，不再写 seasonly） */
export const REPEAT_RULE_CANONICAL = new Set(["none", "weekly", "monthly", "quarterly", "yearly"]);

/**
 * 历史笔记/接口可能仍为 🔁 seasonly；与 quarterly 等价，解析后统一为 quarterly。
 */
export function normalizeRepeatRuleToken(rr: string): string {
  const s = String(rr ?? "").trim().toLowerCase();
  return s === "seasonly" ? "quarterly" : s;
}
