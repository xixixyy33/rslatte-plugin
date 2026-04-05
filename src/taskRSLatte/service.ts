import { App, Notice, TFile, moment, normalizePath } from "obsidian";
import { apiTry, RSLatteApiClient } from "../api";
import type { RSLattePluginSettings } from "../types/settings";
import type { JournalService } from "../services/journalService";
import { RSLatteIndexStore } from "./indexStore";
import { SyncQueue } from "./syncQueue";
import { parseRSLatteFile, buildDescPrefix, TASK_DESC_PREFIX_STRIP_RE } from "./parser";
import {
  writeBackMetaIdByUid,
  patchMetaLineIfUid,
  appendLinkedScheduleUidToTaskMeta,
  writeBackMetaIdByUidRemoveKeys,
  metaLineHasUid,
} from "./shared";
import { getDefaultScheduleCategoryId, sanitizeScheduleCategoryIdForMeta } from "./schedule";
import { archiveIndexByMonths, type ArchiveResult } from "./archiver";
import { isScheduleMemoLine, type RSLatteIndexItem, type RSLatteItemType, type RSLatteParsedLine } from "./types";
import { archiveStableKey } from "./keys";
// import { buildIndexLocator } from "./indexLocator";
import type { TaskCategoryDef, TaskDateField, TaskTimeRangeDef } from "../types/taskTypes";
import { fnv1a32 } from "../utils/hash";
import { scanAllCachedWithStore } from "../rslatteSync/scanPipeline";
import type { ContactsInteractionEntry } from "../contactsRSLatte/types";
import { extractContactUidFromWikiTarget, parseContactRefsFromMarkdown } from "../services/contacts/contactRefParser";
import { enrichWorkEventRefWithTaskContacts } from "../services/contacts/taskWorkEventContactRef";
import { getNearestHeadingTitle } from "../services/markdown/headingLocator";
import { flushQueueUpsertV2 } from "../rslatteSync/upsertFlusher";
import { runReconcileAfterRebuild, runReconcileForType, runReconcileSchedule } from "../rslatteSync/reconcileRunner";
import type { WorkEventService } from "../services/workEventService";
import { nextSolarDateForLunarBirthday } from "../utils/lunar";
import { resolveSpaceIndexDir, resolveSpaceQueueDir } from "../services/space/spaceContext";
import {
  computeTaskTags,
  getTaskTodayKey,
  getTopImportantTasks,
  sanitizeTaskCategoryForMeta,
} from "./task";
import {
  applyMemoIndexDerivedFields,
  applyScheduleIndexDerivedFields,
  applyTaskIndexDerivedFields,
  filterParsedLinesForMemoIndex,
  mergeScheduleItemsByFiles,
  normalizeScheduleItems,
} from "./indexMerge";
import {
  displayPhaseAfterTaskCheckbox,
  indexItemTaskDisplayPhase,
  normalizeRepeatRuleToken,
  reconcileTaskDisplayPhase,
  toIsoNow,
} from "./utils";
import { toLocalOffsetIsoString } from "../utils/localCalendarYmd";
import { normalizeArchiveThresholdDays } from "../constants/defaults";
import type { ScheduleCreateInput } from "../types/scheduleTypes";

export type TaskRSLatteHost = {
  app: App;
  api: RSLatteApiClient;
  settingsRef: () => RSLattePluginSettings;
  saveSettings: () => Promise<boolean>;
  journalSvc: JournalService;
  /** UI refresh hook */
  refreshSidePanel: () => void;
  /** ✅ Work Event Stream（仅记录成功动作，用于统计子插件读取） */
  workEventSvc?: WorkEventService;
  /** 上报 DB 同步状态（用于侧边栏状态灯）。不要求持久化。 */
  reportDbSync?: (ok: boolean, err?: string) => void;
  /**
   * Step6-5.5.1：上报 task/memo 各自的 pending/failed 计数（用于 tooltip）。
   * - 不要求持久化；仅用于 UI 展示。
   */
  reportDbSyncWithCounts?: (
    moduleKey: "task" | "memo",
    meta: { pendingCount?: number; failedCount?: number; ok?: boolean; err?: string }
  ) => void;
};

export type TaskStatusAction = "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED";

/** Step6-5.2 plumbing: allow selecting task/memo modules; callers may ignore for now. */
export type TaskMemoModules = { task?: boolean; memo?: boolean };

const momentFn = moment as any;

function todayYmd() {
  return momentFn().format("YYYY-MM-DD");
}

function nowIso() {
  // ISO with timezone offset (for intra-day ordering on stats)
  return momentFn().format("YYYY-MM-DDTHH:mm:ssZ");
}

const TASK_LINE_RE = /^(\s*[-*+]\s*)\[(.)\](\s+.*)$/u;
const DONE_TOKEN_RE = /\s*✅\uFE0F?\s*\d{4}-\d{2}-\d{2}/gu;
const CANCEL_TOKEN_RE = /\s*❌\uFE0F?\s*\d{4}-\d{2}-\d{2}/gu;
const START_TOKEN_RE_G = /\s*🛫\uFE0F?\s*\d{4}-\d{2}-\d{2}/gu;
// const START_TOKEN_RE_T = /🛫\uFE0F?\s*\d{4}-\d{2}-\d{2}/u;

function statusToMark(s: TaskStatusAction): string {
  if (s === "DONE") return "x";
  if (s === "IN_PROGRESS") return "/";
  if (s === "CANCELLED") return "-";
  return " ";
}

function stripStatusTokens(body: string, opts: { done?: boolean; cancelled?: boolean; start?: boolean }): string {
  let t = body;
  if (opts.done) t = t.replace(DONE_TOKEN_RE, "");
  if (opts.cancelled) t = t.replace(CANCEL_TOKEN_RE, "");
  if (opts.start) t = t.replace(START_TOKEN_RE_G, "");
  // normalize spaces (keep comment intact)
  t = t.replace(/\s{2,}/g, " ").trimEnd();
  return t;
}

function ensureToken(body: string, token: string): string {
  const b = (body ?? "").trimEnd();
  // If the token already exists (icon + date), do nothing.
  if (b.includes(token.split(" ")[0])) {
    // More strict check is done by regex strip above; here we keep it simple.
    // If user already has ✅/❌ with a date, we will overwrite via strip+append.
  }
  return b.length ? `${b} ${token}` : token;
}

function safeNormFolder(p: string) {
  const t = normalizePath((p || "").trim());
  return t.replace(/^\/+/, "").replace(/\/+$/, "");
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function withinFolders(filePath: string, folders: string[]): boolean {
  if (!folders.length) return true;
  const p = normalizePath(filePath);
  return folders.some((f) => {
    const nf = safeNormFolder(f);
    if (!nf) return false;
    return p === nf || p.startsWith(nf + "/");
  });
}

function normTag(t: string): string {
  const s = (t ?? "").trim();
  if (!s) return "";
  return s.replace(/^#/, "").toLowerCase();
}

function extractTags(app: App, file: TFile, content?: string): Set<string> {
  const out = new Set<string>();

  // 1) Properties/frontmatter tags
  try {
    const cache = app.metadataCache.getFileCache(file);
    const fm: any = cache?.frontmatter;
    const fmTags = fm?.tags;
    if (Array.isArray(fmTags)) {
      for (const t of fmTags) {
        const nt = normTag(String(t));
        if (nt) out.add(nt);
      }
    } else if (typeof fmTags === "string") {
      for (const part of fmTags.split(/[\s,]+/g)) {
        const nt = normTag(part);
        if (nt) out.add(nt);
      }
    }

    // 2) Inline tags parsed by metadata cache
    const inline = cache?.tags ?? [];
    for (const t of inline) {
      const nt = normTag(String((t as any)?.tag ?? ""));
      if (nt) out.add(nt);
    }
  } catch {
    // ignore cache errors
  }

  // 3) Fallback scan in content (when cache not ready or tags are unusual)
  if (content) {
    // YAML frontmatter tags (Obsidian properties)
    const fm = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
    if (fm) {
      const body = fm[1];
      // tags: [a, b]  OR  tags: a b
      const line = body.match(/^tags\s*:\s*(.+)$/im);
      if (line) {
        const rhs = line[1].trim();
        const arr = rhs.match(/^\[(.*)\]$/);
        const rawList = arr ? arr[1] : rhs;
        for (const part of rawList.split(/[\s,]+/g)) {
          const nt = normTag(part.replace(/^['\"]|['\"]$/g, ""));
          if (nt) out.add(nt);
        }
      }

      // tags:
      //   - a
      //   - b
      const block = body.match(/^tags\s*:\s*\n((?:\s*-\s*.+\n?)+)/im);
      if (block) {
        const lines = block[1].split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
        for (const l of lines) {
          const m = l.match(/^-\s*(.+)$/);
          if (!m) continue;
          const nt = normTag(m[1].trim().replace(/^['\"]|['\"]$/g, ""));
          if (nt) out.add(nt);
        }
      }
    }

    const m = content.match(/#[\p{L}\p{N}_\-\/]+/gu);
    if (m) {
      for (const raw of m) {
        const nt = normTag(raw);
        if (nt) out.add(nt);
      }
    }
  }

  return out;
}

const META_SYNC_TAG_MAX_LEN = 64;
const META_SYNC_MAX_TAGS = 48;
const META_SYNC_MAX_SCHEDULE_LINKS = 32;
const META_SYNC_MAX_CONTACT_UIDS = 16;

/** 契约 §十三：白名单 meta_sync，供后端 jsonb 与手机 JSON 管道透传 */
function buildMetaSyncFromParsedLine(p: RSLatteParsedLine): Record<string, unknown> | undefined {
  const schema_version = 1;
  const out: Record<string, unknown> = { schema_version };
  const ex: Record<string, unknown> = ((p as any).extra ?? {}) as Record<string, unknown>;

  const pushTrimmedTags = (key: string, arr: unknown) => {
    if (!Array.isArray(arr)) return;
    const slim = arr
      .map((x) => String(x ?? "").trim().slice(0, META_SYNC_TAG_MAX_LEN))
      .filter(Boolean)
      .slice(0, META_SYNC_MAX_TAGS);
    if (slim.length) out[key] = slim;
  };

  const parseLinkedSchedules = (): string[] => {
    const fromArr = (p as any).linked_schedule_uids;
    if (Array.isArray(fromArr)) {
      return fromArr
        .map((x: unknown) => String(x ?? "").trim())
        .filter(Boolean)
        .slice(0, META_SYNC_MAX_SCHEDULE_LINKS);
    }
    const raw = String(ex.linked_schedule_uids ?? "").trim();
    if (!raw) return [];
    return raw
      .split(/[,;]/g)
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, META_SYNC_MAX_SCHEDULE_LINKS);
  };

  if (p.itemType === "task") {
    const links = parseLinkedSchedules();
    if (links.length) out.linked_schedule_uids = links;

    if (p.task_phase) out.task_phase = String(p.task_phase).slice(0, 64);
    if (p.wait_until) out.wait_until = String(p.wait_until).slice(0, 32);
    if (p.follow_up) out.follow_up = String(p.follow_up).slice(0, 32);
    if (p.original_due) out.original_due = String(p.original_due).slice(0, 32);
    if (typeof p.postpone_count === "number" && Number.isFinite(p.postpone_count)) {
      out.postpone_count = Math.max(0, Math.floor(p.postpone_count));
    }
    if (p.starred === true) out.starred = true;
    if (p.complexity) out.complexity = String(p.complexity).slice(0, 32);
    if (typeof p.estimate_h === "number" && Number.isFinite(p.estimate_h)) {
      out.estimate_h = p.estimate_h;
    }
    if (typeof p.importance_score === "number" && Number.isFinite(p.importance_score)) {
      out.importance_score = p.importance_score;
    }
    if (p.importance_is_risk === true) out.importance_is_risk = true;
    if (p.importance_is_today_action === true) out.importance_is_today_action = true;
    if (p.progress_updated) out.progress_updated = String(p.progress_updated).slice(0, 48);

    const uids = p.follow_contact_uids;
    if (Array.isArray(uids) && uids.length) {
      out.follow_contact_uids = uids
        .map((x) => String(x ?? "").trim())
        .filter(Boolean)
        .slice(0, META_SYNC_MAX_CONTACT_UIDS);
    }

    pushTrimmedTags("task_tags", p.task_tags);
  }

  if (p.itemType === "memo") {
    const ltu = String(ex.linked_task_uid ?? "").trim();
    if (ltu) out.linked_task_uid = ltu.slice(0, 128);
    pushTrimmedTags("memo_tags", p.memo_tags);
    pushTrimmedTags("schedule_tags", p.schedule_tags);
    for (const k of ["arranged_date", "arranged_start", "arranged_end"] as const) {
      const v = ex[k];
      if (v !== undefined && v !== null && String(v).trim()) {
        out[k] = String(v).trim().slice(0, 32);
      }
    }
  }

  if (p.itemType === "schedule") {
    pushTrimmedTags("schedule_tags", p.schedule_tags);
    const ltu = String(ex.linked_task_uid ?? "").trim();
    if (ltu) out.linked_task_uid = ltu.slice(0, 128);
    const lo = String(ex.linked_output_id ?? "").trim();
    if (lo) out.linked_output_id = lo.slice(0, 128);
    const sc = String(ex.schedule_category ?? "").trim();
    if (sc) out.schedule_category = sc.slice(0, 64);
  }

  if (Object.keys(out).length <= 1) return undefined;
  return out;
}

function fileMatchesTags(app: App, file: TFile, content: string, includeTags: string[], excludeTags: string[]): boolean {
  const tags = extractTags(app, file, content);
  const ex = (excludeTags ?? []).map(normTag).filter(Boolean);
  if (ex.some((t) => tags.has(t))) return false;

  const inc = (includeTags ?? []).map(normTag).filter(Boolean);
  if (!inc.length) return true;
  return inc.some((t) => tags.has(t));
}

/** 日程入库载荷 → POST /schedules/upsert-batch（与 rslatte_schedule 对齐） */
function buildScheduleCreatePayload(p: RSLatteParsedLine): any | null {
  const sanitize = (s: any): string | undefined => {
    if (s === undefined || s === null) return undefined;
    const str = String(s);
    try {
      return str.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
    } catch {
      return str.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
    }
  };
  const ex = ((p as any).extra ?? {}) as Record<string, unknown>;
  const sd = String(ex.schedule_date ?? (p as any).memoDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sd)) return null;

  let durationMin: number | undefined;
  const dmr = ex.duration_min;
  if (dmr !== undefined && dmr !== null && String(dmr).trim() !== "") {
    const n = Number(dmr);
    if (Number.isFinite(n) && n >= 0) durationMin = Math.floor(n);
  }

  const payload: any = {
    uid: (p as any).uid,
    status: p.status,
    text: sanitize(p.text) ?? "",
    raw: sanitize(p.raw) ?? "",
    file_path: p.filePath,
    line_no: p.lineNo,
    source_hash: p.sourceHash,
    schedule_date: sd,
    start_time: String(ex.start_time ?? "").trim() || undefined,
    end_time: String(ex.end_time ?? "").trim() || undefined,
    duration_min: durationMin,
    schedule_category: String(ex.schedule_category ?? "").trim() || undefined,
    linked_task_uid: String(ex.linked_task_uid ?? "").trim() || undefined,
    linked_output_id: String(ex.linked_output_id ?? "").trim() || undefined,
  };
  const metaSync = buildMetaSyncFromParsedLine(p as RSLatteParsedLine);
  if (metaSync) payload.meta_sync = metaSync;
  for (const k of Object.keys(payload)) {
    if (payload[k] === undefined || payload[k] === null || payload[k] === "") delete payload[k];
  }
  return payload;
}

function buildCreatePayload(p: RSLatteParsedLine): any {
  // Defensive: strip unpaired UTF-16 surrogates. These can be produced if any upstream
  // logic accidentally splits emoji. The backend (Python) will reject such strings.
  const sanitize = (s: any): string | undefined => {
    if (s === undefined || s === null) return undefined;
    const str = String(s);
    try {
      // Remove lone high/low surrogates.
      return str.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
    } catch {
      // Fallback without lookbehind support
      return str.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
    }
  };

  if (p.itemType === "schedule") {
    const sp = buildScheduleCreatePayload(p);
    if (sp) return sp;
  }

  const payload: any = {
    item_type: p.itemType,
    uid: (p as any).uid,
    status: p.status,
    text: sanitize(p.text),
    raw: sanitize(p.raw),
    file_path: p.filePath,
    line_no: p.lineNo,
    source_hash: p.sourceHash,

    created_date: p.created_date,
    due_date: p.planned_end,
    start_date: p.actual_start,
    scheduled_date: p.planned_start,
    done_date: p.done_date,
    cancelled_date: p.cancelled_date,

    memo_date: p.memoDate,
    memo_mmdd: p.memoMmdd,
    repeat_rule: (p.repeatRule ? String(p.repeatRule).toLowerCase() : undefined),
  };

  // ===== Memo compatibility fixes (v2 meta / yearly rule) =====
  // 1) When meta line overrides type to memo, 📅 may have been parsed into due_date earlier.
  if (payload.item_type === "memo" && !payload.memo_date && payload.due_date) {
    payload.memo_date = payload.due_date;
    delete payload.due_date;
  }

  // 2) Backend DB constraint for yearly memos requires memo_mmdd (MM-DD). Derive it from memo_date.
  const rr = (payload.repeat_rule ?? "").toString().toLowerCase();
  if (payload.item_type === "memo" && rr === "yearly") {
    if (!payload.memo_mmdd && typeof payload.memo_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(payload.memo_date)) {
      payload.memo_mmdd = payload.memo_date.slice(5); // "MM-DD"
    }

    // For yearly repeating memos, memo_mmdd is the canonical date key.
    // Some backend schemas enforce memo_date IS NULL for yearly; omit it to be safe.
    delete payload.memo_date;
  }

  // 3) Backend DB: memo 分类与农历（从 meta 行解析进 extra，重建索引时需写入 DB）
  if (payload.item_type === "memo") {
    const extra: Record<string, string | number | boolean | undefined> = (p as any).extra ?? {};
    const catStr = String(extra.cat ?? "").trim();
    if (catStr) payload.cat = catStr;
    const lunarStr = String(extra.lunar ?? "").trim();
    if (/^\d{2}-\d{2}$/.test(lunarStr)) payload.memo_lunar_mmdd = lunarStr;
    if (extra.leap === "1" || extra.leap === 1 || extra.leap === true) payload.memo_leap = true;
  }

  const metaSync = buildMetaSyncFromParsedLine(p as RSLatteParsedLine);
  if (metaSync) payload.meta_sync = metaSync;

  // clean undefined
  for (const k of Object.keys(payload)) {
    if (payload[k] === undefined || payload[k] === null || payload[k] === "") delete payload[k];
  }

  // repeat_rule normalize
  const rrAllowed = new Set(["none", "weekly", "monthly", "quarterly", "yearly"]);
  if (payload.repeat_rule) {
    const n = normalizeRepeatRuleToken(String(payload.repeat_rule));
    payload.repeat_rule = rrAllowed.has(n) ? (n as any) : "none";
  }

  return payload;
}

function parseRSLatteCommentFromLine(line: string): { comment?: string; before: string; after: string } {
  const m = (line || "").match(/(<!--\s*rslatte:[^>]*-->)/i);
  if (!m) return { before: line, after: "" };
  const comment = m[1];
  const idx = line.indexOf(comment);
  return { comment, before: line.slice(0, idx), after: line.slice(idx + comment.length) };
}

function upsertRSLatteComment(line: string, type: RSLatteItemType, id: number): string {
  const { comment, before, after } = parseRSLatteCommentFromLine(line);

  const kv: Record<string, string> = {};
  if (comment) {
    const inside = comment
      .replace(/^<!--\s*/i, "")
      .replace(/\s*-->$/i, "")
      .trim();

    // inside expected like: rslatte:type=task;tid=123
    const raw = inside.replace(/^rslatte:/i, "").trim();
    const parts = raw.replace(/\s+/g, " ").split(/[;\s]+/g).map((x) => x.trim()).filter(Boolean);
    for (const p of parts) {
      const m = p.match(/^([A-Za-z0-9_\-:]+)=(.+)$/);
      if (!m) continue;
      kv[m[1]] = m[2];
    }
  }

  kv["type"] = type;
  if (type === "task") kv["tid"] = String(id);
  if (type === "memo") kv["mid"] = String(id);

  // rebuild stable order: type, tid/mid, rest
  const keys = Object.keys(kv);
  const ordered: string[] = [];
  if (kv["type"]) ordered.push(`type=${kv["type"]}`);
  if (type === "task" && kv["tid"]) ordered.push(`tid=${kv["tid"]}`);
  if (type === "memo" && kv["mid"]) ordered.push(`mid=${kv["mid"]}`);

  for (const k of keys) {
    if (k === "type" || k === "tid" || k === "mid") continue;
    ordered.push(`${k}=${kv[k]}`);
  }

  const newComment = `<!-- rslatte:${ordered.join(";")} -->`;

  // IMPORTANT: Tasks plugin parses task metadata from the end of the line backwards.
  // If the HTML comment is placed at the end, Tasks will stop parsing and won't
  // recognize dates like 📅/➕/🛫/⏳/✅/❌.
  // Therefore, always place the rslatte comment BEFORE the first metadata token.
  const core = `${before ?? ""}${after ?? ""}`; // line without old rslatte comment
  const tokenRe = /\s(📅|➕|⏳|🛫|✅|❌|🔁)\s/u;
  const mToken = core.match(tokenRe);
  if (mToken && typeof (mToken as any).index === "number") {
    const idx = (mToken as any).index as number;
    const left = core.slice(0, idx).trimEnd();
    const right = core.slice(idx).trimStart();
    return `${left} ${newComment} ${right}`.replace(/\s{2,}/g, " ").trimEnd();
  }

  // No metadata token found -> append at end (still safe for non-Tasks use cases)
  return `${core.trimEnd()} ${newComment}`.replace(/\s{2,}/g, " ").trimEnd();
}

export class TaskRSLatteService {
  private store: RSLatteIndexStore;
  private queue: SyncQueue;

  // Prevent re-entrant refresh/sync loops (e.g. Side Panel auto refresh + write-back).
  private refreshPromise: Promise<void> | null = null;
  private flushPromise: Promise<void> | null = null;

  constructor(private host: TaskRSLatteHost) {
    const tp = this.host.settingsRef().taskPanel;
    const s = this.host.settingsRef();
    const indexDir = resolveSpaceIndexDir(s, undefined, [tp?.rslatteIndexDir]);
    const queueDir = normalizePath(`${resolveSpaceQueueDir(s, undefined, [tp?.rslatteIndexDir])}/taskmemo`);

    this.store = new RSLatteIndexStore(host.app, indexDir, queueDir);
    this.queue = new SyncQueue(() => this.store.readQueue(), (q) => this.store.writeQueue(q));
  }

  private addCycleDate(fromYmd: string, rule: string, steps = 1): string | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromYmd)) return null;
    const d = new Date(`${fromYmd}T12:00:00`);
    const rr = normalizeRepeatRuleToken(String(rule ?? "").trim().toLowerCase());
    const n = Math.max(1, Number(steps) || 1);
    if (rr === "weekly") d.setDate(d.getDate() + 7 * n);
    else if (rr === "monthly") d.setMonth(d.getMonth() + n);
    else if (rr === "quarterly") d.setMonth(d.getMonth() + 3 * n);
    else if (rr === "yearly") d.setFullYear(d.getFullYear() + n);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }

  private async createNextCycleTaskFromDone(
    it: Pick<RSLatteIndexItem, "uid" | "text"> & Partial<RSLatteIndexItem>,
    repeatRule: string,
    generatedOnYmd: string,
    plannedEndYmd: string,
    plannedStartYmd?: string
  ): Promise<void> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(plannedEndYmd)) return;

    const text = String((it as any).text ?? "").trim();
    if (!text) return;
    const anchor = /^\d{4}-\d{2}-\d{2}$/.test(String(plannedStartYmd ?? "")) ? String(plannedStartYmd) : plannedEndYmd;
    const toUtcDay = (ymd: string) => {
      const [y, m, d] = ymd.split("-").map((x) => Number(x));
      return Date.UTC(y, (m || 1) - 1, d || 1);
    };
    const todayUtc = toUtcDay(generatedOnYmd);
    let step = 1;
    while (step < 200) {
      const nextAnchor = this.addCycleDate(anchor, repeatRule, step);
      if (!nextAnchor) return;
      if (toUtcDay(nextAnchor) >= todayUtc) break;
      step += 1;
    }
    const nextDue = this.addCycleDate(plannedEndYmd, repeatRule, step);
    const nextStart = plannedStartYmd ? this.addCycleDate(plannedStartYmd, repeatRule, step) : null;
    if (!nextDue) return;

    const uid = `lg_${Math.random().toString(16).slice(2, 12)}`;
    const tsIso = nowIso();
    const descPrefix = buildDescPrefix({
      starred: !!(it as any).starred,
      complexity: (it as any).complexity,
    });
    const estimate = Number((it as any).estimate_h ?? 0);
    const metaParts = [`uid=${uid}`, `type=task`, `ts=${tsIso}`, `task_phase=todo`];
    if (estimate > 0) metaParts.push(`estimate_h=${estimate}`);
    if ((it as any).complexity && (it as any).complexity !== "normal") metaParts.push(`complexity=${(it as any).complexity}`);
    const line = `- [ ] ${descPrefix}${text} 📅 ${nextDue}${nextStart ? ` ⏳ ${nextStart}` : ""} 🔁 ${repeatRule} ➕ ${generatedOnYmd}`;
    const meta = `  <!-- rslatte:${metaParts.join(";")} -->`;

    const rules = (this.host.settingsRef().journalAppendRules ?? []) as any[];
    const r = (rules.find((x) => x.module === "task") ?? { h1: "# 任务追踪", h2: "## 新增任务" }) as any;
    const currentSpaceId = (this.host as any).getCurrentSpaceId?.() || "";
    const spaces = (this.host.settingsRef() as any).spaces || {};
    const currentSpace = spaces[currentSpaceId];
    const spaceSnapshot = currentSpace?.settingsSnapshot || {};
    const spaceDiaryPath = spaceSnapshot.diaryPath;
    const spaceDiaryNameFormat = spaceSnapshot.diaryNameFormat;
    const spaceDiaryTemplate = spaceSnapshot.diaryTemplate;
    const originalPathOverride = (this.host.journalSvc as any)._diaryPathOverride;
    const originalFormatOverride = (this.host.journalSvc as any)._diaryNameFormatOverride;
    const originalTemplateOverride = (this.host.journalSvc as any)._diaryTemplateOverride;
    try {
      this.host.journalSvc.setDiaryPathOverride(
        spaceDiaryPath || null,
        spaceDiaryNameFormat || null,
        spaceDiaryTemplate || null
      );
      await this.host.journalSvc.upsertLinesToDiaryH1H2(nextDue, r.h1, r.h2, [line, meta], { mode: "append" });
    } finally {
      this.host.journalSvc.setDiaryPathOverride(originalPathOverride, originalFormatOverride, originalTemplateOverride);
    }
  }

  /** settings change -> update base dir */
  public refreshStoreBaseDir() {
    const tp = this.host.settingsRef().taskPanel;
    const s = this.host.settingsRef();
    const indexDir = resolveSpaceIndexDir(s, undefined, [tp?.rslatteIndexDir]);
    const queueDir = normalizePath(`${resolveSpaceQueueDir(s, undefined, [tp?.rslatteIndexDir])}/taskmemo`);
    this.store = new RSLatteIndexStore(this.host.app, indexDir, queueDir);
    this.queue = new SyncQueue(() => this.store.readQueue(), (q) => this.store.writeQueue(q));
  }

  public async ensureReady(): Promise<void> {
    await this.store.ensureLayout();
  }

  /**
   * When other modules move/rename markdown files (e.g. diary auto-archive),
   * task/memo indexes may still point to the old file path until the next scan.
   *
   * This helper rewrites stored filePath references so UI jumps won't break.
   * Best-effort: does NOT read markdown contents and does NOT trigger DB sync.
   */
  public async rewriteSourcePaths(moves: Array<{ from: string; to: string }>): Promise<{ updated: number }> {
    if (!moves?.length) return { updated: 0 };
    await this.ensureReady();

    const norm = (p: string) => normalizePath(String(p ?? "").trim());
    const pairs = moves
      .map((m) => ({ from: norm(m.from), to: norm(m.to) }))
      .filter((m) => !!m.from && !!m.to && m.from !== m.to);
    if (!pairs.length) return { updated: 0 };

    let updated = 0;

    // 1) rewrite task / memo / schedule indexes
    for (const type of ["task", "memo", "schedule"] as const) {
      const idx = await this.store.readIndex(type);
      let changed = false;
      for (const it of idx.items ?? []) {
        const fp = norm((it as any)?.filePath);
        const hit = pairs.find((p) => p.from === fp);
        if (!hit) continue;
        (it as any).filePath = hit.to;
        changed = true;
        updated++;
      }
      if (changed) await this.store.writeIndex(type, idx);
    }

    // 2) rewrite sync queue ops
    try {
      const q = await this.store.readQueue();
      let qChanged = false;
      for (const op of q.ops ?? []) {
        const fp = norm((op as any)?.filePath);
        const hit = pairs.find((p) => p.from === fp);
        if (!hit) continue;
        (op as any).filePath = hit.to;
        qChanged = true;
      }
      if (qChanged) await this.store.writeQueue(q);
    } catch {
      // ignore
    }

    // 3) rewrite scan-cache keys (file-level cache)
    try {
      const c = await this.store.readScanCache();
      const files = c.files ?? {};
      let cChanged = false;
      for (const p of pairs) {
        const oldRec = files[p.from];
        if (!oldRec) continue;
        const newRec = files[p.to];
        // merge conservatively to avoid losing cached fingerprints
        const merged = newRec
          ? {
              mtime: Math.max(Number(newRec.mtime ?? 0), Number(oldRec.mtime ?? 0)),
              size: Math.max(Number(newRec.size ?? 0), Number(oldRec.size ?? 0)),
              hash: newRec.hash ?? oldRec.hash,
              included: (newRec.included ?? oldRec.included) === true,
            }
          : oldRec;
        delete files[p.from];
        files[p.to] = merged;
        cChanged = true;
      }
      if (cChanged) {
        c.files = files;
        await this.store.writeScanCache(c);
      }
    } catch {
      // ignore
    }

    return { updated };
  }

  private get tp() {
    return this.host.settingsRef().taskPanel;
  }

  private get enableSync() {
    return (this.tp?.enableDbSync ?? true) === true;
  }

  /** 当前空间日记根（与 record 扫描一致），用于并入 task/memo/schedule 候选路径 */
  private getEffectiveDiaryRootForTaskScan(): string {
    const s = this.host.settingsRef() as any;
    const currentSpaceId = String(s?.currentSpaceId ?? "");
    const spaces = s?.spaces || {};
    const currentSpace = spaces[currentSpaceId];
    const spaceDiaryPath = currentSpace?.settingsSnapshot?.diaryPath;
    return normalizePath(String(spaceDiaryPath ?? s.diaryPath ?? "").trim());
  }

  /**
   * 任务域扫描目录：taskFolders +（若未被任一 folder 覆盖则并入）日记根，保证「日记按月」子目录下的 `.md` 参与重建。
   */
  private getTaskScanFolders(): string[] {
    const tp = this.tp;
    let folders = uniq((tp?.taskFolders ?? []).map(safeNormFolder).filter(Boolean));
    const diaryRoot = this.getEffectiveDiaryRootForTaskScan();
    if (diaryRoot) {
      const covered = folders.some((f) => {
        if (!f) return false;
        return (
          diaryRoot === f ||
          diaryRoot.startsWith(f + "/") ||
          f.startsWith(diaryRoot + "/")
        );
      });
      if (!covered) folders.push(diaryRoot);
    }
    return uniq(folders.filter(Boolean));
  }

  private async listCandidateMarkdownFiles(): Promise<TFile[]> {
    const folders = this.getTaskScanFolders();
    const files = this.host.app.vault.getMarkdownFiles();
    return files.filter((f) => withinFolders(f.path, folders));
  }

  /** 扫描文件 -> 解析出 task/memo */
  private async scanAllCached(
    prevTasks: RSLatteIndexItem[],
    prevMemos: RSLatteIndexItem[],
    opts?: { fixUidAndMeta?: boolean }
  ): Promise<{ tasks: RSLatteParsedLine[]; memos: RSLatteParsedLine[]; includedFilePaths: string[]; touchedFilePaths: string[]; removedFilePaths: string[]; contactInteractionsByFile: Record<string, { mtime: number; entries: ContactsInteractionEntry[] }> }>{
    const tp = this.tp;
    const files = await this.listCandidateMarkdownFiles();
    
    // ✅ DEBUG: 打印扫描前的文件列表
    const debugLogEnabled = (this.host as any)?.isDebugLogEnabled?.() === true;
    if (debugLogEnabled && files.length > 0) {
      console.log(`[RSLatte][taskRSLatte] scanAllCached: Starting scan with ${files.length} candidate files:`, {
        totalFiles: files.length,
        files: files.slice(0, 50).map((f) => ({
          path: f.path,
          mtime: toLocalOffsetIsoString(new Date((f.stat as any)?.mtime ?? 0)),
        })), // 只显示前50个
      });
    }

    // Build a filter key that invalidates the cache when relevant settings change.
    const folders = this.getTaskScanFolders().sort();
    const inc = uniq((tp?.includeTags ?? []).map(normTag).filter(Boolean)).sort();
    const ex = uniq((tp?.excludeTags ?? []).map(normTag).filter(Boolean)).sort();
    const filterKey = fnv1a32(JSON.stringify({ folders, inc, ex }));

    const contactInteractionsByFile: Record<string, { mtime: number; entries: ContactsInteractionEntry[] }> = {};
    const mapTaskStatus = (st: any): any => {
      const s = String(st ?? "").toUpperCase();
      if (s === "DONE") return "done";
      if (s === "IN_PROGRESS") return "in_progress";
      if (s === "CANCELLED") return "cancelled";
      if (s === "TODO") return "todo";
      return "unknown";
    };

    const r = await scanAllCachedWithStore(
      {
        app: this.host.app,
        store: this.store,
        files,
        includeTags: tp?.includeTags ?? [],
        excludeTags: tp?.excludeTags ?? [],
        filterKey,
        debugLogEnabled: () => debugLogEnabled, // ✅ 传递 DEBUG 开关给 scanAllCachedWithStore
        prevTasks,
        prevMemos,
        fileMatchesTags,
        parseRSLatteFile: (filePath, content, pOpts) => parseRSLatteFile(filePath, content, { fixUidAndMeta: !!pOpts.fixUidAndMeta }),
        onIncludedFileParsed: async ({ filePath, mtime, content, parsed }) => {
          // Step3: extract contact refs from *task lines* only, with status derived from task parser.
          // Best-effort: never throw.
          try {
            const nowIso = toIsoNow();
            const contentLines = String(content ?? "").replace(/\r\n/g, "\n").split("\n");
            const allTask = parseContactRefsFromMarkdown(content, {
              source_path: filePath,
              source_type: "task",
              updated_at: nowIso,
            });
            const allMemo = parseContactRefsFromMarkdown(content, {
              source_path: filePath,
              source_type: "memo",
              updated_at: nowIso,
            });

            // Group refs by line_no (1-based)
            const byLine = new Map<number, ContactsInteractionEntry[]>();
            for (const e of allTask) {
              const ln = Number(e.line_no ?? 0);
              if (!ln) continue;
              const arr = byLine.get(ln) ?? [];
              arr.push(e);
              byLine.set(ln, arr);
            }
            const byLineMemo = new Map<number, ContactsInteractionEntry[]>();
            for (const e of allMemo) {
              const ln = Number(e.line_no ?? 0);
              if (!ln) continue;
              const arr = byLineMemo.get(ln) ?? [];
              arr.push(e);
              byLineMemo.set(ln, arr);
            }

            const out: ContactsInteractionEntry[] = [];
            for (const t of parsed?.tasks ?? []) {
              const ln = Number((t as any)?.lineNo ?? -1);
              if (ln < 0) continue;
              const lineNo1 = ln + 1;
              const refs = (byLine.get(lineNo1) ?? []).slice();
              for (const r of refs) (r as any).follow_association_type = "strong";

              // Extra-robust: 任务描述中 [[C_xxx]] 为强关联，整段活跃期「关注中」，完成/取消后「已结束」
              try {
                const lineText = String(contentLines[ln] ?? (t as any)?.raw ?? "");
                const re = /\[\[([^\]]+)\]\]/g;
                const found = new Set<string>();
                let m: RegExpExecArray | null;
                while ((m = re.exec(lineText)) !== null) {
                  const inside = String(m[1] ?? "");
                  const target = (inside.split("|")[0] ?? "").trim();
                  const uid = extractContactUidFromWikiTarget(target);
                  if (uid) found.add(uid);
                }

                if (found.size > 0) {
                  const existing = new Set(refs.map((x) => String((x as any)?.contact_uid ?? "").trim()).filter(Boolean));
                  const heading = getNearestHeadingTitle(contentLines, ln);
                  const snippet = String(lineText ?? "").trimEnd().slice(0, 240);
                  for (const uid of found) {
                    if (!uid || existing.has(uid)) continue;
                    refs.push({
                      contact_uid: uid,
                      source_path: filePath,
                      source_type: "task",
                      snippet,
                      line_no: lineNo1,
                      heading,
                      updated_at: nowIso,
                      key: `${uid}|${filePath}|task|${lineNo1}`,
                      follow_association_type: "strong",
                    } as any);
                  }
                }
              } catch {
                // ignore
              }
              // meta 中 follow_contact_uids 为弱关联，仅「跟进中」「等待中」时「关注中」，其他状态「已结束」
              const followUids: string[] = Array.isArray((t as any)?.follow_contact_uids) ? (t as any).follow_contact_uids : [];
              const existingRefUids = new Set(refs.map((x) => String((x as any)?.contact_uid ?? "").trim()).filter(Boolean));
              if (followUids.length > 0) {
                const heading = getNearestHeadingTitle(contentLines, ln);
                const snippet = String(contentLines[ln] ?? (t as any)?.raw ?? "").trimEnd().slice(0, 240);
                for (const uid of followUids) {
                  const u = String(uid ?? "").trim();
                  if (!u || existingRefUids.has(u)) continue;
                  refs.push({
                    contact_uid: u,
                    source_path: filePath,
                    source_type: "task",
                    snippet,
                    line_no: lineNo1,
                    heading,
                    updated_at: nowIso,
                    key: `${u}|${filePath}|task|${lineNo1}`,
                    follow_association_type: "weak",
                  } as any);
                  existingRefUids.add(u);
                }
              }

              if (!refs || refs.length === 0) continue;
              const status = mapTaskStatus((t as any)?.status);
              const taskPhase = String((t as any)?.task_phase ?? "").trim();
              const taskPhaseOpt = taskPhase || undefined;
              for (const r of refs) {
                const assoc = (r as any).follow_association_type as "strong" | "weak" | undefined;
                const followStatus: "following" | "ended" =
                  assoc === "strong"
                    ? (status === "done" || status === "cancelled" ? "ended" : "following")
                    : (taskPhase === "waiting_others" || taskPhase === "waiting_until" ? "following" : "ended");
                out.push({
                  ...r,
                  status,
                  follow_status: followStatus,
                  task_phase: taskPhaseOpt,
                  updated_at: nowIso,
                  source_block_id: String((t as any)?.uid ?? "") || undefined,
                } as any);
              }
            }

            for (const m of parsed?.memos ?? []) {
              const ln = Number((m as any)?.lineNo ?? -1);
              if (ln < 0) continue;
              const lineNo1 = ln + 1;
              const refs = (byLineMemo.get(lineNo1) ?? []).slice();
              for (const r of refs) (r as any).follow_association_type = "strong";
              // 兜底：生日提醒等场景可能没有 [[C_xxx|姓名]]，但会在 meta 中写 contact_uid
              try {
                const rawMetaUid = String((m as any)?.extra?.contact_uid ?? "").trim();
                const metaUid = extractContactUidFromWikiTarget(rawMetaUid) || rawMetaUid.replace(/^C_/, "");
                if (metaUid) {
                  const existing = new Set(refs.map((x) => String((x as any)?.contact_uid ?? "").trim()).filter(Boolean));
                  if (!existing.has(metaUid)) {
                    const heading = getNearestHeadingTitle(contentLines, ln);
                    const snippet = String(contentLines[ln] ?? (m as any)?.raw ?? "").trimEnd().slice(0, 240);
                    refs.push({
                      contact_uid: metaUid,
                      source_path: filePath,
                      source_type: "memo",
                      snippet,
                      line_no: lineNo1,
                      heading,
                      updated_at: nowIso,
                      key: `${metaUid}|${filePath}|memo|${lineNo1}`,
                      follow_association_type: "strong",
                    } as any);
                  }
                }
              } catch {
                // ignore
              }

              if (!refs || refs.length === 0) continue;
              const status = mapTaskStatus((m as any)?.status);
              const memoSourceType = isScheduleMemoLine(m as any) ? "schedule" : "memo";
              for (const r of refs) {
                out.push({
                  ...r,
                  source_type: memoSourceType,
                  status,
                  follow_status: status === "done" || status === "cancelled" ? "ended" : "following",
                  updated_at: nowIso,
                  source_block_id: String((m as any)?.uid ?? "") || undefined,
                } as any);
              }
            }

            contactInteractionsByFile[filePath] = { mtime: Number(mtime ?? 0), entries: out };
          } catch {
            // ignore
          }
        },
      },
      { fixUidAndMeta: opts?.fixUidAndMeta === true }
    );

    return { ...r, contactInteractionsByFile };
  }

  /**
   * 针对单个任务文件构建联系人互动条目（与 scanAllCached 中 onIncludedFileParsed 逻辑一致）。
   * 用于新增/编辑任务后立即刷新该文件对应的 contacts-interactions，避免依赖全量扫描时序。
   */
  public async buildContactInteractionsForFile(filePath: string): Promise<{ mtime: number; entries: ContactsInteractionEntry[] }> {
    const path = normalizePath(String(filePath ?? "").trim());
    if (!path) return { mtime: 0, entries: [] };
    const af = this.host.app.vault.getAbstractFileByPath(path);
    if (!af || !(af instanceof TFile)) return { mtime: 0, entries: [] };
    const content = await this.host.app.vault.read(af);
    const mtime = Number((af.stat as any)?.mtime ?? 0);
    const contentLines = String(content ?? "").replace(/\r\n/g, "\n").split("\n");
    const nowIso = toIsoNow();
    const parsed = parseRSLatteFile(path, content, { fixUidAndMeta: false });
    const mapTaskStatus = (st: any): string => {
      const s = String(st ?? "").toUpperCase();
      if (s === "DONE") return "done";
      if (s === "IN_PROGRESS") return "in_progress";
      if (s === "CANCELLED") return "cancelled";
      if (s === "TODO") return "todo";
      return "unknown";
    };
    const all = parseContactRefsFromMarkdown(content, { source_path: path, source_type: "task", updated_at: nowIso });
    const allMemo = parseContactRefsFromMarkdown(content, { source_path: path, source_type: "memo", updated_at: nowIso });
    const byLine = new Map<number, ContactsInteractionEntry[]>();
    for (const e of all) {
      const ln = Number(e.line_no ?? 0);
      if (!ln) continue;
      const arr = byLine.get(ln) ?? [];
      arr.push(e);
      byLine.set(ln, arr);
    }
    const byLineMemo = new Map<number, ContactsInteractionEntry[]>();
    for (const e of allMemo) {
      const ln = Number(e.line_no ?? 0);
      if (!ln) continue;
      const arr = byLineMemo.get(ln) ?? [];
      arr.push(e);
      byLineMemo.set(ln, arr);
    }
    const out: ContactsInteractionEntry[] = [];
    for (const t of parsed?.tasks ?? []) {
      const ln = Number((t as any)?.lineNo ?? -1);
      if (ln < 0) continue;
      const lineNo1 = ln + 1;
      const refs = (byLine.get(lineNo1) ?? []).slice();
      for (const r of refs) (r as any).follow_association_type = "strong";
      try {
        const lineText = String(contentLines[ln] ?? (t as any)?.raw ?? "");
        const re = /\[\[([^\]]+)\]\]/g;
        let m: RegExpExecArray | null;
        const found = new Set<string>();
        while ((m = re.exec(lineText)) !== null) {
          const target = (String(m[1] ?? "").split("|")[0] ?? "").trim();
          const uid = extractContactUidFromWikiTarget(target);
          if (uid) found.add(uid);
        }
        if (found.size > 0) {
          const existing = new Set(refs.map((x) => String((x as any)?.contact_uid ?? "").trim()).filter(Boolean));
          const heading = getNearestHeadingTitle(contentLines, ln);
          const snippet = String(lineText ?? "").trimEnd().slice(0, 240);
          for (const uid of found) {
            if (!uid || existing.has(uid)) continue;
            refs.push({
              contact_uid: uid,
              source_path: path,
              source_type: "task",
              snippet,
              line_no: lineNo1,
              heading,
              updated_at: nowIso,
              key: `${uid}|${path}|task|${lineNo1}`,
              follow_association_type: "strong",
            } as any);
            existing.add(uid);
          }
        }
      } catch {
        // ignore
      }
      const followUids: string[] = Array.isArray((t as any)?.follow_contact_uids) ? (t as any).follow_contact_uids : [];
      const existingRefUids = new Set(refs.map((x) => String((x as any)?.contact_uid ?? "").trim()).filter(Boolean));
      if (followUids.length > 0) {
        const heading = getNearestHeadingTitle(contentLines, ln);
        const snippet = String(contentLines[ln] ?? (t as any)?.raw ?? "").trimEnd().slice(0, 240);
        for (const uid of followUids) {
          const u = String(uid ?? "").trim();
          if (!u || existingRefUids.has(u)) continue;
          refs.push({
            contact_uid: u,
            source_path: path,
            source_type: "task",
            snippet,
            line_no: lineNo1,
            heading,
            updated_at: nowIso,
            key: `${u}|${path}|task|${lineNo1}`,
            follow_association_type: "weak",
          } as any);
          existingRefUids.add(u);
        }
      }
      if (!refs?.length) continue;
      const status = mapTaskStatus((t as any)?.status);
      const taskPhase = String((t as any)?.task_phase ?? "").trim();
      const taskPhaseOpt = taskPhase || undefined;
      for (const r of refs) {
        const assoc = (r as any).follow_association_type as "strong" | "weak" | undefined;
        const followStatus: "following" | "ended" =
          assoc === "strong"
            ? (status === "done" || status === "cancelled" ? "ended" : "following")
            : (taskPhase === "waiting_others" || taskPhase === "waiting_until" ? "following" : "ended");
        out.push({
          ...r,
          status,
          follow_status: followStatus,
          task_phase: taskPhaseOpt,
          updated_at: nowIso,
          source_block_id: String((t as any)?.uid ?? "") || undefined,
        } as any);
      }
    }
    for (const m of parsed?.memos ?? []) {
      const ln = Number((m as any)?.lineNo ?? -1);
      if (ln < 0) continue;
      const lineNo1 = ln + 1;
      const refs = (byLineMemo.get(lineNo1) ?? []).slice();
      for (const r of refs) (r as any).follow_association_type = "strong";
      // 兜底：生日提醒等场景可能没有 [[C_xxx|姓名]]，但会在 meta 中写 contact_uid
      try {
        const rawMetaUid = String((m as any)?.extra?.contact_uid ?? "").trim();
        const metaUid = extractContactUidFromWikiTarget(rawMetaUid) || rawMetaUid.replace(/^C_/, "");
        if (metaUid) {
          const existing = new Set(refs.map((x) => String((x as any)?.contact_uid ?? "").trim()).filter(Boolean));
          if (!existing.has(metaUid)) {
            const heading = getNearestHeadingTitle(contentLines, ln);
            const snippet = String(contentLines[ln] ?? (m as any)?.raw ?? "").trimEnd().slice(0, 240);
            refs.push({
              contact_uid: metaUid,
              source_path: path,
              source_type: "memo",
              snippet,
              line_no: lineNo1,
              heading,
              updated_at: nowIso,
              key: `${metaUid}|${path}|memo|${lineNo1}`,
              follow_association_type: "strong",
            } as any);
          }
        }
      } catch {
        // ignore
      }
      if (!refs?.length) continue;
      const status = mapTaskStatus((m as any)?.status);
      const memoSourceType = isScheduleMemoLine(m as any) ? "schedule" : "memo";
      for (const r of refs) {
        out.push({
          ...r,
          source_type: memoSourceType,
          status,
          follow_status: status === "done" || status === "cancelled" ? "ended" : "following",
          updated_at: nowIso,
          source_block_id: String((m as any)?.uid ?? "") || undefined,
        } as any);
      }
    }
    return { mtime, entries: out };
  }

  // =========================
  // Query for UI (from index)
  // =========================

  private resolveDateToken(token: string): string | undefined {
    const t = (token ?? "").trim();
    if (!t) return undefined;
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    const lower = t.toLowerCase();

    const isToday = t === "今日" || t === "今天" || lower === "today";
    if (isToday) return momentFn().format("YYYY-MM-DD");

    const isWeek = t === "本周" || t === "本週" || lower === "this_week" || lower === "thisweek";
    if (isWeek) return momentFn().startOf("week").format("YYYY-MM-DD");

    const isMonth = t === "本月" || lower === "this_month" || lower === "thismonth";
    if (isMonth) return momentFn().startOf("month").format("YYYY-MM-DD");

    const isQuarter = t === "本季度" || lower === "this_quarter" || lower === "thisquarter";
    if (isQuarter) return momentFn().startOf("quarter").format("YYYY-MM-DD");

    return undefined;
  }

  private getFieldDate(it: RSLatteIndexItem, field: TaskDateField): string | undefined {
    switch (field) {
      case "due": return it.planned_end;
      case "start": return it.actual_start;
      case "scheduled": return it.planned_start;
      case "created": return it.created_date;
      case "done": return it.done_date;
      case "cancelled": return it.cancelled_date;
      default: return undefined;
    }
  }

  private statusMatches(it: RSLatteIndexItem, statuses: string[]): boolean {
    const wanted = (statuses ?? []).map(s => (s ?? "").trim()).filter(Boolean);
    if (!wanted.length) return true;
    const name = (it.status ?? "UNKNOWN").toUpperCase();

    const markToName = (m: string) => {
      const mm = (m ?? "").trim();
      if (mm === "x" || mm === "X") return "DONE";
      if (mm === "/") return "IN_PROGRESS";
      if (mm === "-") return "CANCELLED";
      if (mm === "") return "TODO"; // [ ]
      return "UNKNOWN";
    };

    return wanted.some((s) => {
      if (s.length === 1 || s === " ") {
        const n = markToName(s === " " ? "" : s);
        return n === name;
      }
      return s.toUpperCase() === name;
    });
  }

  private rangesMatch(it: RSLatteIndexItem, ranges: TaskTimeRangeDef[]): boolean {
    const rs = (ranges ?? []).filter(Boolean);
    if (!rs.length) return true;

    for (const r of rs) {
      const left = this.getFieldDate(it, r.field);
      const right = this.resolveDateToken(r.value);
      if (!left || !right) return false;
      const a = left;
      const b = right;
      switch (r.op) {
        case ">": if (!(a > b)) return false; break;
        case ">=": if (!(a >= b)) return false; break;
        case "<": if (!(a < b)) return false; break;
        case "<=": if (!(a <= b)) return false; break;
        default: return false;
      }
    }
    return true;
  }

  /** 供 Side Panel 2 使用：从索引中查询某个分类下的任务 */
  public async queryCategory(category: TaskCategoryDef): Promise<RSLatteIndexItem[]> {
    await this.ensureReady();

    let idx = await this.store.readIndex("task");
    if (!(idx.items ?? []).length) {
      await this.refreshIndexAndSync({ sync: this.enableSync });
      idx = await this.store.readIndex("task");
    }

    const max = Math.min(Math.max(Number(category.maxItems || 0), 1), 30);
    const items = (idx.items ?? []).filter((it) => {
      if (it.archived) return false;
      if (!this.statusMatches(it, category.statuses ?? [])) return false;
      if (!this.rangesMatch(it, category.timeRanges ?? [])) return false;
      return true;
    });

    const field = category.sortField;
    const order = category.sortOrder;
    const getKey = (t: RSLatteIndexItem) => this.getFieldDate(t, field);

    items.sort((a, b) => {
      const ka = getKey(a);
      const kb = getKey(b);
      const aMiss = !ka;
      const bMiss = !kb;
      if (aMiss && bMiss) {
        if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
        return (a.lineNo ?? 0) - (b.lineNo ?? 0);
      }
      if (aMiss) return 1;
      if (bMiss) return -1;
      if (ka === kb) {
        if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
        return (a.lineNo ?? 0) - (b.lineNo ?? 0);
      }
      const cmp = ka! < kb! ? -1 : 1;
      return order === "desc" ? -cmp : cmp;
    });

    return items.slice(0, max);
  }

  /**
   * 任务清单分区数据（第十二节新结构）：供侧栏 1→2→3→4 渲染，互斥与排序在内部完成
   */
  public async getTaskListsForSidePanel(): Promise<{
    focus: RSLatteIndexItem[];
    todayAction: RSLatteIndexItem[];
    todayFollowUp: RSLatteIndexItem[];
    overdue: RSLatteIndexItem[];
    otherRisk: RSLatteIndexItem[];
    otherActive: RSLatteIndexItem[];
    closedCancelled: RSLatteIndexItem[];
    closedDone: RSLatteIndexItem[];
  }> {
    await this.ensureReady();
    let idx = await this.store.readIndex("task");
    if (!(idx.items ?? []).length) {
      await this.refreshIndexAndSync({ sync: this.enableSync });
      idx = await this.store.readIndex("task");
    }
    const today = getTaskTodayKey(this.tp);
    const overdueWithinDays = Math.min(30, Math.max(1, Number(this.tp?.overdueWithinDays) ?? 3));
    const closedWindowDays = Math.min(90, Math.max(1, Number(this.tp?.closedTaskWindowDays) ?? 7));
    const focusTopN = Math.min(10, Math.max(3, Number(this.tp?.focusTopN) ?? 3));
    const closedStart = momentFn(today, "YYYY-MM-DD").subtract(closedWindowDays - 1, "days").format("YYYY-MM-DD");

    const itemKey = (it: RSLatteIndexItem) =>
      String((it as any).uid ?? "").trim() || `${(it as any).filePath ?? ""}#${(it as any).lineNo ?? 0}`;
    const isActive = (it: RSLatteIndexItem) => {
      if ((it as any).archived) return false;
      const st = String((it as any).status ?? "").toUpperCase();
      return st !== "DONE" && st !== "CANCELLED";
    };
    const toYmd = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined);
    const addDays = (ymd: string, days: number) =>
      momentFn(ymd, "YYYY-MM-DD").add(days, "days").format("YYYY-MM-DD");
    const todayEnd = addDays(today, overdueWithinDays);

    const all = (idx.items ?? []) as RSLatteIndexItem[];
    const active = all.filter(isActive);
    const inSet = (set: Set<string>, it: RSLatteIndexItem) => set.has(itemKey(it));
    const addToSet = (set: Set<string>, items: RSLatteIndexItem[]) =>
      items.forEach((it) => set.add(itemKey(it)));

    const indexTagsDay = (idx as { tagsDerivedForYmd?: string }).tagsDerivedForYmd;
    const focus = getTopImportantTasks(active, today, this.tp, focusTopN, { indexTagsDay });
    const inFocus = new Set<string>();
    addToSet(inFocus, focus);

    const todayAction: RSLatteIndexItem[] = [];
    for (const it of active) {
      if (inSet(inFocus, it)) continue;
      const due = toYmd((it as any).planned_end);
      const start = toYmd((it as any).actual_start);
      if (due === today || start === today) todayAction.push(it);
    }
    todayAction.sort((a, b) => ((b as any).importance_score ?? 0) - ((a as any).importance_score ?? 0));
    const inTodayAction = new Set<string>();
    addToSet(inTodayAction, todayAction);

    const todayFollowUp: RSLatteIndexItem[] = [];
    const phase = (it: RSLatteIndexItem) =>
      reconcileTaskDisplayPhase(String((it as any).status ?? ""), (it as any).task_phase, {
        wait_until: (it as any).wait_until,
        follow_up: (it as any).follow_up,
      });
    const waitUntil = (it: RSLatteIndexItem) => toYmd((it as any).wait_until);
    const followUp = (it: RSLatteIndexItem) => toYmd((it as any).follow_up);
    for (const it of active) {
      if (inSet(inTodayAction, it)) continue;
      if (inSet(inFocus, it)) continue;
      if ((phase(it) === "waiting_until" && waitUntil(it) === today) || (phase(it) === "waiting_others" && followUp(it) === today))
        todayFollowUp.push(it);
    }
    todayFollowUp.sort((a, b) => ((b as any).importance_score ?? 0) - ((a as any).importance_score ?? 0));
    const inTodayFollowUp = new Set<string>();
    addToSet(inTodayFollowUp, todayFollowUp);

    const overdue: RSLatteIndexItem[] = [];
    const due = (it: RSLatteIndexItem) => toYmd((it as any).planned_end);
    const postponeCount = (it: RSLatteIndexItem) => Math.max(0, Number((it as any).postpone_count) ?? 0);
    const originalDue = (it: RSLatteIndexItem) => toYmd((it as any).original_due);
    for (const it of active) {
      if (inSet(inTodayAction, it) || inSet(inTodayFollowUp, it)) continue;
      if (inSet(inFocus, it)) continue;
      const d = due(it);
      if (!d) continue;
      if (d < today) overdue.push(it);
      else if (d >= today && d <= todayEnd) overdue.push(it);
      else if (postponeCount(it) > 2 && originalDue(it) && today > originalDue(it)!) overdue.push(it);
    }
    overdue.sort((a, b) => {
      const da = due(a) ?? "9999-99-99";
      const db = due(b) ?? "9999-99-99";
      return da.localeCompare(db);
    });
    const inOverdue = new Set<string>();
    addToSet(inOverdue, overdue);

    const riskTags = new Set(["已延期", "高拖延风险", "假活跃"]);
    const tagsFresh = indexTagsDay === today;
    const hasRiskTag = (it: RSLatteIndexItem) => {
      const arr = (it as any).task_tags as string[] | undefined;
      if (tagsFresh && Array.isArray(arr) && arr.length > 0) {
        return arr.some((t) => riskTags.has(t));
      }
      const tags = computeTaskTags(it, today, this.tp);
      return tags.some((t) => riskTags.has(t));
    };
    const otherRisk: RSLatteIndexItem[] = [];
    for (const it of active) {
      if (inSet(inTodayAction, it) || inSet(inTodayFollowUp, it) || inSet(inOverdue, it)) continue;
      if (inSet(inFocus, it)) continue;
      if (hasRiskTag(it)) otherRisk.push(it);
    }
    otherRisk.sort((a, b) => {
      const da = due(a) ?? "9999-99-99";
      const db = due(b) ?? "9999-99-99";
      return da.localeCompare(db);
    });
    const inOtherRisk = new Set<string>();
    addToSet(inOtherRisk, otherRisk);

    const otherActive: RSLatteIndexItem[] = [];
    for (const it of active) {
      if (inSet(inTodayAction, it) || inSet(inTodayFollowUp, it) || inSet(inOverdue, it) || inSet(inOtherRisk, it))
        continue;
      otherActive.push(it);
    }
    otherActive.sort((a, b) => {
      const da = due(a) ?? "9999-99-99";
      const db = due(b) ?? "9999-99-99";
      return da.localeCompare(db);
    });

    const closed = all.filter((it) => (it as any).status === "DONE" || (it as any).status === "CANCELLED");
    const cancelledDate = (it: RSLatteIndexItem) => toYmd((it as any).cancelled_date);
    const doneDate = (it: RSLatteIndexItem) => toYmd((it as any).done_date);
    const closedCancelled = closed
      .filter((it) => (it as any).status === "CANCELLED" && cancelledDate(it) && cancelledDate(it)! >= closedStart && cancelledDate(it)! <= today)
      .sort((a, b) => (cancelledDate(b) ?? "").localeCompare(cancelledDate(a) ?? ""));
    const closedDone = closed
      .filter((it) => (it as any).status === "DONE" && doneDate(it) && doneDate(it)! >= closedStart && doneDate(it)! <= today)
      .sort((a, b) => (doneDate(b) ?? "").localeCompare(doneDate(a) ?? ""));

    return {
      focus,
      todayAction,
      todayFollowUp,
      overdue,
      otherRisk,
      otherActive,
      closedCancelled,
      closedDone,
    };
  }

  /**
   * 重要性 Top N：从候选池中取前 n 条并应用约束（风险类最多 1 条，至少 1 条今天明确要处理）
   */
  public async getTopImportantTasks(n: number): Promise<RSLatteIndexItem[]> {
    await this.ensureReady();
    let idx = await this.store.readIndex("task");
    if (!(idx.items ?? []).length) {
      await this.refreshIndexAndSync({ sync: this.enableSync });
      idx = await this.store.readIndex("task");
    }
    const active = (idx.items ?? []).filter((it) => {
      if ((it as any).archived) return false;
      const st = String((it as any).status ?? "").toUpperCase();
      return st !== "DONE" && st !== "CANCELLED";
    });
    const today = getTaskTodayKey(this.tp);
    const indexTagsDay = (idx as { tagsDerivedForYmd?: string }).tagsDerivedForYmd;
    return getTopImportantTasks(active, today, this.tp, Math.max(0, Math.min(10, n)), { indexTagsDay });
  }

  /** 提醒索引根级 tagsDerivedForYmd（与 memo_tags 是否可直读相关） */
  public async getMemoIndexTagsDerivedDay(): Promise<string | undefined> {
    const idx = await this.store.readIndex("memo");
    return idx.tagsDerivedForYmd;
  }

  /** 日程索引根级 tagsDerivedForYmd */
  public async getScheduleIndexTagsDerivedDay(): Promise<string | undefined> {
    const idx = await this.store.readIndex("schedule");
    return idx.tagsDerivedForYmd;
  }

  /** 任务索引根级 tagsDerivedForYmd（与 task_tags 是否可直读一致，见 getTaskListsForSidePanel） */
  public async getTaskIndexTagsDerivedDay(): Promise<string | undefined> {
    const idx = await this.store.readIndex("task");
    return idx.tagsDerivedForYmd;
  }

  /** schedule pipeline 归档等：读取 schedule-index 条目（经 IndexStore，与 mergeIntoIndex 路径一致） */
  public async readScheduleIndexItems(): Promise<RSLatteIndexItem[]> {
    const idx = await this.store.readIndex("schedule");
    return (idx.items ?? []) as RSLatteIndexItem[];
  }

  /**
   * 合并写入索引：task / memo / **schedule**（日程走 schedule-index，与 schedule pipeline 同源逻辑）。
   * @param scheduleOpts 仅当 type==="schedule" 时有效：`replaceAll` 表示全量替换（重建/归档裁剪）；否则按 touched/removed 做增量合并。
   */
  public async mergeIntoIndex(
    type: RSLatteItemType,
    parsed: RSLatteParsedLine[],
    scheduleOpts?: { touchedFilePaths?: string[]; removedFilePaths?: string[]; replaceAll?: boolean }
  ): Promise<RSLatteIndexItem[]> {
    if (type === "schedule") {
      return this.mergeScheduleIntoIndex(parsed ?? [], scheduleOpts);
    }

    const idx = await this.store.readIndex(type);
    const existing = idx.items ?? [];

    const linesToMerge = type === "memo" ? filterParsedLinesForMemoIndex(parsed ?? []) : (parsed ?? []);

    // Idempotent archive support: closed tasks/memos may remain in daily notes and thus be re-scanned.
    // If they were archived already (and removed from main index), we should not re-add them to main index
    // when they are still older than the archive cutoff.
    // Archive cutoff (idempotency support): closed items older than the cutoff and already present in archive-map
    // should not be re-added to main index when they are re-scanned from daily notes.
    const today = momentFn().format("YYYY-MM-DD");
    const thresholdDaysRaw = this.tp.archiveThresholdDays;
    const keepMonthsRaw = this.tp.archiveKeepMonths;
    const thresholdDays = normalizeArchiveThresholdDays(
      Number.isFinite(thresholdDaysRaw)
        ? Number(thresholdDaysRaw)
        : Number.isFinite(keepMonthsRaw)
          ? Math.max(0, Math.floor(Number(keepMonthsRaw))) * 30
          : 90,
    );
    const cutoff = momentFn(today).startOf("day").subtract(thresholdDays, "days").format("YYYY-MM-DD");

    const mapFile = await this.store.readArchiveMap();
    const archivedKeys = mapFile.keys ?? {};
    const keyOf = (it: any): string => archiveStableKey(type, it);

    // v2: prefer uid as the primary key so index entries survive line number drift.
    const byUid = new Map<string, RSLatteIndexItem>();
    const byLoc = new Map<string, RSLatteIndexItem>();
    for (const it of existing) {
      if ((it as any)?.uid) byUid.set(String((it as any).uid), it);
      byLoc.set(`${it.filePath}#${it.lineNo}`, it);
    }

    const seenAt = toIsoNow();
    const merged: RSLatteIndexItem[] = [];

    for (const p of linesToMerge) {
      const old = p.uid ? byUid.get(p.uid) : byLoc.get(`${p.filePath}#${p.lineNo}`);

      const itemId = p.itemType === "task" ? (p.tid ?? old?.itemId) : (p.mid ?? old?.itemId);

      // If item already has a DB id but no pushed marker yet, initialize lastPushedHash
      // to current sourceHash so we don't enqueue a storm of updates after upgrading.
      const lastPushedHash = (old as any)?.lastPushedHash ?? (itemId != null ? p.sourceHash : undefined);
      const lastPushedAt = (old as any)?.lastPushedAt ?? (itemId != null ? seenAt : undefined);

      // If already archived and still eligible for archiving, keep it out of main index.
      // NOTE: memo archiving rules differ from task.
      const stableKey = keyOf({ ...p, itemId });

      const getArchiveDateForIdempotency = (): string | null => {
        // 1) CLOSED items (task + memo): archive by ✅/❌ date
        if (p.status === "CANCELLED") return p.cancelled_date || today;
        if (p.status === "DONE") return p.done_date || today;

        // 2) task: non-closed tasks are never archived
        if (type === "task") return null;

        // 3) memo: non-closed
        let rule = normalizeRepeatRuleToken(String((p as any).repeatRule || "").trim().toLowerCase());
        if (!rule) rule = (p as any).memoMmdd ? "yearly" : "none";
        const allowed = new Set(["none", "weekly", "monthly", "quarterly", "yearly"]);
        const rr = allowed.has(rule) ? rule : "none";
        if (rr !== "none") return null;

        const md = String((p as any).memoDate || "").trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(md)) return md;
        return null;
      };

      const archiveDate = getArchiveDateForIdempotency();
      if (archiveDate && archiveDate < cutoff && archivedKeys[stableKey]) {
        continue;
      }

      merged.push({
        ...(old ?? {}),
        ...p,
        // if parser couldn't extract uid (auto refresh w/o fix), keep old uid
        uid: p.uid ?? (old as any)?.uid,
        itemId: itemId ?? undefined,
        lastPushedHash: (old as any)?.lastPushedHash ?? lastPushedHash,
        lastPushedAt: (old as any)?.lastPushedAt ?? lastPushedAt,
        seenAt,
        archived: old?.archived ?? false,
      } as RSLatteIndexItem);
    }

    if (type === "task") {
      const { items: taskItems, tagsDerivedForYmd } = applyTaskIndexDerivedFields(merged, this.tp);
      await this.store.writeIndex(type, {
        version: 1,
        updatedAt: seenAt,
        items: taskItems,
        tagsDerivedForYmd,
      });
      await this.writeImportanceToTaskMeta(taskItems);
    } else {
      await this.writeMemoIndexWithDerivedTags(merged, seenAt);
    }
    return merged;
  }

  /** 日程索引：增量/全量合并、写 schedule_tags、触发 e2 自动下一条提醒（与 schedule pipeline 共用） */
  private async mergeScheduleIntoIndex(
    parsed: RSLatteParsedLine[],
    opts?: { touchedFilePaths?: string[]; removedFilePaths?: string[]; replaceAll?: boolean }
  ): Promise<RSLatteIndexItem[]> {
    const seenAt = toIsoNow();
    const panel = (this.host.settingsRef() as any)?.taskPanel;
    const idx = await this.store.readIndex("schedule");
    const existing = idx.items ?? [];
    let merged: RSLatteIndexItem[];
    if (opts?.replaceAll) {
      merged = normalizeScheduleItems(parsed as any[]);
    } else {
      merged = mergeScheduleItemsByFiles({
        existing,
        scanned: parsed ?? [],
        touchedFilePaths: opts?.touchedFilePaths,
        removedFilePaths: opts?.removedFilePaths,
      });
    }
    const { items, tagsDerivedForYmd } = applyScheduleIndexDerivedFields(merged, panel);
    await this.store.writeIndex("schedule", {
      version: 1,
      updatedAt: seenAt,
      items,
      tagsDerivedForYmd,
    });
    await this.e2AutoCreateNextMemoEntries(items);
    if (this.enableSync) {
      const list = (items ?? []).filter((x) => !(x as any)?.archived) as RSLatteIndexItem[];
      await this.enqueueMissingIds("schedule", list);
      await this.enqueueUpdates("schedule", list);
      const raw = Number(this.tp?.upsertBatchSize ?? 50);
      const batchSize = Math.max(1, Math.min(500, Number.isFinite(raw) ? Math.floor(raw) : 50));
      await this.flushQueue(batchSize, 10, { maxBatches: 3 });
    }
    return items;
  }

  /** 提醒索引：写入 memo_tags 与根级 tagsDerivedForYmd（日历日，与 queryReminderBuckets 一致） */
  private async writeMemoIndexWithDerivedTags(items: RSLatteIndexItem[], updatedAtIso?: string): Promise<void> {
    const seenAt = updatedAtIso ?? toIsoNow();
    const panel = (this.host.settingsRef() as any)?.taskPanel;
    const { items: withTags, tagsDerivedForYmd } = applyMemoIndexDerivedFields(items, panel);
    await this.store.writeIndex("memo", { version: 1, updatedAt: seenAt, items: withTags, tagsDerivedForYmd });
  }

  /** 将任务重要性得分写回各任务 meta 行（与标签触发场景一致） */
  private async writeImportanceToTaskMeta(items: RSLatteIndexItem[]): Promise<void> {
    const app = this.host.app;
    const byPath = new Map<string, RSLatteIndexItem[]>();
    for (const it of items) {
      if ((it as any).itemType !== "task") continue;
      const fp = String((it as any).filePath ?? "").trim();
      if (!fp) continue;
      const list = byPath.get(fp) ?? [];
      list.push(it);
      byPath.set(fp, list);
    }
    for (const [filePath, list] of byPath) {
      const af = app.vault.getAbstractFileByPath(filePath);
      if (!af || !(af instanceof TFile)) continue;
      try {
        const content = await app.vault.read(af);
        const lines = (content ?? "").split(/\r?\n/);
        let fileChanged = false;
        for (const it of list) {
          const uid = String((it as any).uid ?? "").trim();
          if (!uid) continue;
          const lineNo = Number((it as any).lineNo ?? 0);
          const lineIdx = lineNo + 1;
          if (lineIdx < 0 || lineIdx >= lines.length) continue;
          const score = (it as any).importance_score;
          const scoreStr = typeof score === "number" && Number.isFinite(score) ? String(Math.round(score)) : "0";
          const res = patchMetaLineIfUid(lines[lineIdx], uid, { importance: scoreStr });
          if (res?.changed) {
            lines[lineIdx] = res.line;
            fileChanged = true;
          }
        }
        if (fileChanged) await app.vault.modify(af, lines.join("\n"));
      } catch (e) {
        console.warn("[RSLatte][task] writeImportanceToTaskMeta failed for", filePath, e);
      }
    }
  }

  // =========================
  // Memo: auto advance next reminder date (write back)
  // =========================

  private isYmd(s?: string): boolean {
    return !!(s ?? "").match(/^\d{4}-\d{2}-\d{2}$/);
  }

  private computeNextByRepeat(baseYmd: string, rrRaw: string, todayYmd: string, mmddHint?: string): string {
    const rr = normalizeRepeatRuleToken(String(rrRaw ?? "").trim().toLowerCase());
    const today = momentFn(todayYmd, "YYYY-MM-DD").startOf("day");
    const base = momentFn(baseYmd, "YYYY-MM-DD").startOf("day");
    if (!base.isValid()) return baseYmd;

    const clampDayInMonth = (year: number, month0: number, day: number) => {
      const m0 = momentFn({ year, month: month0, day: 1 }).startOf("day");
      const dim = m0.daysInMonth();
      m0.date(Math.min(day, dim));
      return m0;
    };

    const addMonthsClamped = (dt: any, months: number, day: number) => {
      const m0 = dt.clone().startOf("month").add(months, "month");
      const dim = m0.daysInMonth();
      m0.date(Math.min(day, dim));
      return m0.startOf("day");
    };

    let next = base.clone().startOf("day");

    if (rr === "none") {
      return base.format("YYYY-MM-DD");
    }

    if (rr === "yearly") {
      const mmdd = (mmddHint && /^\d{2}-\d{2}$/.test(mmddHint)) ? mmddHint : base.format("MM-DD");
      const [mm, dd] = mmdd.split("-").map((x: string) => Number(x));
      next = clampDayInMonth(today.year(), mm - 1, dd);
      if (next.isBefore(today)) next = clampDayInMonth(today.year() + 1, mm - 1, dd);
      return next.format("YYYY-MM-DD");
    }

    if (rr === "monthly") {
      const dd = base.date();
      next = clampDayInMonth(today.year(), today.month(), dd);
      if (next.isBefore(today)) {
        const t = today.clone().startOf("month").add(1, "month");
        next = clampDayInMonth(t.year(), t.month(), dd);
      }
      return next.format("YYYY-MM-DD");
    }

    if (rr === "weekly") {
      next = base.clone().startOf("day");
      if (next.isBefore(today)) {
        const diff = today.diff(next, "days");
        const add = Math.ceil(diff / 7) * 7;
        next = next.add(add, "days").startOf("day");
      }
      return next.format("YYYY-MM-DD");
    }

    if (rr === "quarterly") {
      const dd = base.date();
      next = base.clone().startOf("day");
      // every 3 months from base date
      let guard = 0;
      while (next.isBefore(today) && guard++ < 60) {
        next = addMonthsClamped(next, 3, dd);
      }
      return next.format("YYYY-MM-DD");
    }

    return base.format("YYYY-MM-DD");
  }

  private async applyMemoNextPatches(
    patches: Array<{ uid: string; filePath: string; newNext: string; patchLine: boolean }>
  ): Promise<{ applied: Set<string>; newRawByUid: Map<string, string> }> {
    const applied = new Set<string>();
    const newRawByUid = new Map<string, string>();
    if (!patches.length) return { applied, newRawByUid };

    // Backward compatible: accept legacy "ledger:" prefix from older vaults.
    const RSLATTE_META_LINE_RE = /^\s*<!--\s*(?:rslatte|ledger):([^>]*)-->\s*$/i;

    const parseKv = (raw: string): Record<string, string> => {
      const txt = (raw ?? "").trim();
      if (!txt) return {};
      const parts = txt
        .replace(/\s+/g, " ")
        .split(/[;\s]+/g)
        .map((x) => x.trim())
        .filter(Boolean);
      const kv: Record<string, string> = {};
      for (const p of parts) {
        const m = p.match(/^([A-Za-z0-9_\-:]+)=(.+)$/);
        if (!m) continue;
        const k = m[1].trim();
        const v = m[2].trim();
        if (k) kv[k] = v;
      }
      return kv;
    };

    const buildMetaLine = (kv: Record<string, string>): string => {
      const uid = (kv["uid"] ?? "").trim();
      const type = (kv["type"] ?? kv["rslatte:type"] ?? "").trim();
      const tid = (kv["tid"] ?? kv["task_id"] ?? "").trim();
      const mid = (kv["mid"] ?? kv["memo_id"] ?? "").trim();

      const ordered: string[] = [];
      if (uid) ordered.push(`uid=${uid}`);
      if (type) ordered.push(`type=${type}`);
      if (tid) ordered.push(`tid=${tid}`);
      if (mid) ordered.push(`mid=${mid}`);

      for (const k of Object.keys(kv)) {
        if (k === "uid" || k === "type" || k === "rslatte:type" || k === "tid" || k === "task_id" || k === "mid" || k === "memo_id") continue;
        const v = (kv[k] ?? "").trim();
        if (!v) continue;
        ordered.push(`${k}=${v}`);
      }
      return `  <!-- rslatte:${ordered.join(";")} -->`;
    };

    const patchMemoLineDate = (line: string, newYmd: string): string => {
      return (line ?? "").replace(/(📅\uFE0F?\s*)(\d{4}-\d{2}-\d{2}|\d{2}-\d{2})/u, `$1${newYmd}`);
    };

    // group by file
    const byFile = new Map<string, Array<{ uid: string; newNext: string; patchLine: boolean }>>();
    for (const p of patches) {
      if (!p.uid || !p.filePath || !this.isYmd(p.newNext)) continue;
      const arr = byFile.get(p.filePath) ?? [];
      arr.push({ uid: p.uid, newNext: p.newNext, patchLine: p.patchLine });
      byFile.set(p.filePath, arr);
    }

    for (const [filePath, ps] of byFile.entries()) {
      const file = this.host.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) continue;
      const content = await this.host.app.vault.read(file);
      const lines = (content ?? "").split(/\r?\n/);
      let changed = false;

      // build uid->metaIdx map (first occurrence)
      const metaIdxByUid = new Map<string, number>();
      for (let i = 0; i < lines.length; i++) {
        const m = (lines[i] ?? "").match(RSLATTE_META_LINE_RE);
        if (!m) continue;
        const kv = parseKv((m[1] ?? "").trim());
        const uid = String(kv["uid"] ?? "").trim();
        if (!uid) continue;
        if (!metaIdxByUid.has(uid)) metaIdxByUid.set(uid, i);
      }

      for (const p of ps) {
        const metaIdx = metaIdxByUid.get(p.uid);
        if (metaIdx == null) continue; // meta missing: do NOT insert (safety)

        const m = (lines[metaIdx] ?? "").match(RSLATTE_META_LINE_RE);
        if (!m) continue;
        const kv = parseKv((m[1] ?? "").trim());
        if (String(kv["uid"] ?? "").trim() !== p.uid) continue;

        const beforeNext = String(kv["next"] ?? "").trim();
        if (beforeNext !== p.newNext) {
          kv["next"] = p.newNext;
          const built = buildMetaLine(kv);
          if (built !== lines[metaIdx]) {
            lines[metaIdx] = built;
            changed = true;
          }
        }

        if (p.patchLine) {
          const li = metaIdx - 1;
          if (li >= 0 && li < lines.length) {
            const before = lines[li];
            const after = patchMemoLineDate(before, p.newNext);
            if (after !== before) {
              lines[li] = after;
              changed = true;
            }
            newRawByUid.set(p.uid, lines[li]);
          }
        }

        applied.add(p.uid);
      }

      if (changed) {
        await this.host.app.vault.modify(file, lines.join("\n"));
      }
    }

    return { applied, newRawByUid };
  }

  private async autoAdvanceMemoNextDates(memos: RSLatteIndexItem[]): Promise<RSLatteIndexItem[]> {
    const today = getTaskTodayKey((this.host.settingsRef() as any)?.taskPanel ?? {});
    const allowed = new Set(["none", "weekly", "monthly", "quarterly", "yearly"]);

    const patches: Array<{ uid: string; filePath: string; lineNo: number; newNext: string; patchLine: boolean }> = [];
    const uidToNext = new Map<string, string>();

    for (const it of memos) {
      const uid = String((it as any).uid ?? "").trim();
      if (!uid) continue;
      if (it.archived) continue;
      if (it.status === "DONE" || it.status === "CANCELLED") continue;
      if (String((it as any)?.extra?.invalidated ?? "").trim() === "1") continue;

      const extra: Record<string, string> = (it as any).extra ?? {};
      const cat = String(extra["cat"] ?? "").trim();
      const dateType = String(extra["date_type"] ?? "").trim();

      let rr = String((it as any).repeatRule ?? "").trim().toLowerCase();
      if (!rr) rr = String(extra["repeat_rule"] ?? "").trim().toLowerCase();
      if (!rr) rr = (it as any).memoMmdd ? "yearly" : "none";
      rr = normalizeRepeatRuleToken(rr);
      if (!allowed.has(rr)) rr = "none";

      const metaNextRaw = String(extra["next"] ?? "").trim();
      const metaNext = this.isYmd(metaNextRaw) ? metaNextRaw : "";
      const memoDateRaw = String((it as any).memoDate ?? "").trim();
      const memoDate = this.isYmd(memoDateRaw) ? memoDateRaw : "";

      const curNext = metaNext || memoDate;

      // Compute next
      let computedNext = curNext;

      const isLunar = cat === "lunarBirthday" || dateType === "lunar";
      if (isLunar) {
        const lunarMmdd = String(extra["lunar"] ?? (it as any).memoMmdd ?? "").trim();
        const leap = String(extra["leap"] ?? "").trim() === "1";
        if (/^\d{2}-\d{2}$/.test(lunarMmdd)) {
          computedNext = nextSolarDateForLunarBirthday(lunarMmdd, leap, today);
        }
      } else {
        const base = curNext || memoDate;
        if (this.isYmd(base)) {
          computedNext = this.computeNextByRepeat(base, rr, today, (it as any).memoMmdd);
        }
      }

      // Ensure we always have a meta next for scheduling UI.
      // Only auto-advance when repeating (rr != none) and current next is before today.
      const needSetNext = this.isYmd(computedNext) && !metaNext;
      const needAdvance = this.isYmd(curNext) && curNext < today && (isLunar || rr !== "none");
      const needAlign = this.isYmd(metaNext) && this.isYmd(memoDate) && metaNext !== memoDate;

      if ((needSetNext || needAdvance || needAlign) && this.isYmd(computedNext)) {
        if (computedNext !== metaNext || computedNext !== memoDate) {
          patches.push({ uid, filePath: it.filePath, lineNo: it.lineNo, newNext: computedNext, patchLine: (isLunar || rr !== "none" || needAlign) });
          uidToNext.set(uid, computedNext);
        }
      }
    }

    const { applied, newRawByUid } = await this.applyMemoNextPatches(patches);

    let changed = false;
    for (const it of memos) {
      const uid = String((it as any).uid ?? "").trim();
      if (!uid || !applied.has(uid)) continue;
      const next = uidToNext.get(uid);
      if (!next) continue;
      const extra: Record<string, string> = (it as any).extra ?? {};
      (it as any).extra = { ...extra, next };
      (it as any).memoDate = next;

      // If we patched the list line, also refresh raw + sourceHash.
      const newRaw = newRawByUid.get(uid);
      if (newRaw != null) {
        (it as any).raw = newRaw;
        const normRaw = String(newRaw).trimEnd();
        (it as any).sourceHash = fnv1a32(`memo|${it.filePath}|${it.lineNo}|${normRaw}`);
      }
      changed = true;
    }

    if (changed) {
      const seenAt = toIsoNow();
      await this.writeMemoIndexWithDerivedTags(memos, seenAt);
    }

    return memos;
  }

  private async autoCreateNextMemoEntries(memos: RSLatteIndexItem[]): Promise<number> {
    const today = todayYmd();
    const allowed = new Set(["none", "weekly", "monthly", "quarterly", "yearly"]);
    const getScheduleBaseDate = (x: any): string => {
      const memoDate = String(x?.memoDate ?? "").trim();
      if (this.isYmd(memoDate)) return memoDate;
      const extra = (x?.extra ?? {}) as Record<string, string>;
      const scheduleDate = String(extra?.schedule_date ?? "").trim();
      return this.isYmd(scheduleDate) ? scheduleDate : "";
    };
    const childKey = new Set<string>();
    for (const it of memos) {
      const extra: Record<string, string> = (it as any).extra ?? {};
      const parentUid = String(extra["auto_parent_uid"] ?? "").trim();
      const d = getScheduleBaseDate(it as any);
      if (parentUid && this.isYmd(d)) childKey.add(`${parentUid}|${d}`);
    }

    let created = 0;
    const rules = (this.host.settingsRef().journalAppendRules ?? []) as any[];
    const sanitize = (v: any) => String(v ?? "").trim().replace(/[;\s]+/g, "_");
    const genUid = () => `lg_${Math.random().toString(16).slice(2, 12)}`;

    for (const it of memos) {
      const uid = String((it as any).uid ?? "").trim();
      if (!uid) continue;
      if (it.archived) continue;
      const extra: Record<string, string> = (it as any).extra ?? {};
      const cat = String(extra["cat"] ?? "").trim();
      const isSchedule = isScheduleMemoLine({ extra } as any);
      const status = String((it as any).status ?? "").trim().toUpperCase();
      const isClosed = status === "DONE" || status === "CANCELLED";
      if (isClosed && !isSchedule) continue;
      if (String(extra["invalidated"] ?? "").trim() === "1") continue;

      const baseDate = getScheduleBaseDate(it as any);
      if (!this.isYmd(baseDate)) continue;

      let rr = String((it as any).repeatRule ?? "").trim().toLowerCase();
      if (!rr) rr = (it as any).memoMmdd ? "yearly" : "none";
      rr = normalizeRepeatRuleToken(rr);
      if (!allowed.has(rr)) rr = "none";

      const isLunar = cat === "lunarBirthday" || String(extra["date_type"] ?? "").trim() === "lunar";
      if (!isLunar && rr === "none") continue;
      // 生成条件：
      // - 周期条目一旦超期（baseDate < today）自动续下一条；
      // - 日程在未超期时手动完成/取消，也提前续下一条。
      const shouldSpawnByOverdue = baseDate < today;
      const shouldSpawnByEarlyClose = isSchedule && isClosed && baseDate > today;
      if (!shouldSpawnByOverdue && !shouldSpawnByEarlyClose) continue;

      let nextYmd = "";
      const seed = shouldSpawnByEarlyClose
        ? momentFn(baseDate, "YYYY-MM-DD").add(1, "day").format("YYYY-MM-DD")
        : today;
      if (isLunar) {
        const lunarMmdd = String(extra["lunar"] ?? (it as any).memoMmdd ?? "").trim();
        const leap = String(extra["leap"] ?? "").trim() === "1";
        if (/^\d{2}-\d{2}$/.test(lunarMmdd)) {
          nextYmd = nextSolarDateForLunarBirthday(lunarMmdd, leap, seed);
        }
      } else {
        nextYmd = this.computeNextByRepeat(baseDate, rr, seed, (it as any).memoMmdd);
      }
      if (!this.isYmd(nextYmd)) continue;

      const already = childKey.has(`${uid}|${nextYmd}`);
      // 仅用“子条目是否已存在”做防重；
      // last_auto_spawned 可能在历史异常时已写入但子条目并未真正落盘，不能再作为强阻断条件。
      if (already) continue;

      const tsIso = nowIso();
      const text = String((it as any).text ?? "").trim() || String((it as any).raw ?? "").trim();
      if (!text) continue;
      const repToken = rr !== "none" ? ` 🔁 ${rr}` : "";
      const line = `- [/] ${text} 📅 ${nextYmd}${repToken} ➕ ${today}`;

      const carry: Record<string, string> = {};
      for (const [k, v] of Object.entries(extra ?? {})) {
        const kk = String(k ?? "").trim();
        if (!kk) continue;
        if (kk === "next" || kk === "last_auto_spawned" || kk === "invalidated" || kk === "invalidated_date" || kk === "invalidated_time") continue;
        const vv = String(v ?? "").trim();
        if (!vv) continue;
        carry[kk] = vv;
      }
      carry["auto_parent_uid"] = uid;
      carry["auto_spawned_from"] = baseDate;
      if (isSchedule) {
        carry["schedule_date"] = nextYmd;
      }

      const uidNew = genUid();
      const metaParts: string[] = [`uid=${uidNew}`, `type=${isSchedule ? "schedule" : "memo"}`, `ts=${sanitize(tsIso)}`];
      if (isSchedule) metaParts.push(`todo_time=${sanitize(tsIso)}`);
      else metaParts.push(`in_progress_time=${sanitize(tsIso)}`);
      for (const [k, v] of Object.entries(carry)) {
        const sv = sanitize(v);
        if (!sv) continue;
        metaParts.push(`${k}=${sv}`);
      }
      const meta = `  <!-- rslatte:${metaParts.join(";")} -->`;

      const rule = (isSchedule
        ? rules.find((x) => x.module === "schedule")
        : rules.find((x) => x.module === "memo")
      ) ?? { h1: "# 任务追踪", h2: isSchedule ? "## 新增日程" : "## 新增提醒" };
      const r = rule as any;
      await this.host.journalSvc.upsertLinesToDiaryH1H2(nextYmd, r.h1, r.h2, [line, meta], { mode: "append" });
      await writeBackMetaIdByUid(this.host.app, it.filePath, uid, { last_auto_spawned: nextYmd }, Number((it as any).lineNo ?? 0));
      if (cat === "solarBirthday" || cat === "lunarBirthday") {
        const rawContactUid = String(extra["contact_uid"] ?? "").trim();
        const contactUid = extractContactUidFromWikiTarget(rawContactUid) || rawContactUid.replace(/^C_/, "");
        if (contactUid) {
          await this.appendBirthMemoUidToContact(contactUid, uidNew, String(extra["contact_file"] ?? "").trim());
        }
      }
      childKey.add(`${uid}|${nextYmd}`);
      created++;
    }

    return created;
  }

  /** 供 schedule pipeline 调用：按当前 schedule-index 执行一次周期续写（防重）。 */
  public async e2AutoCreateNextMemoEntries(items: RSLatteIndexItem[]): Promise<number> {
    return this.autoCreateNextMemoEntries(Array.isArray(items) ? items : []);
  }

  /**
   * 主入口：刷新索引；必要时把缺 id 的 item 入队并与后端同步
   */
  public async refreshIndexAndSync(opts?: { sync?: boolean; noticeOnError?: boolean; forceFullSync?: boolean; modules?: TaskMemoModules }): Promise<void> {
    // Avoid re-entrant refresh loops.
    if (this.refreshPromise) return this.refreshPromise;

    // For Notice clarity: label by selected modules.
    const label = (() => {
      const m = opts?.modules;
      if (!m) return "任务/提醒";
      const onlyTask = m.task === true && m.memo !== true;
      const onlyMemo = m.memo === true && m.task !== true;
      if (onlyTask) return "任务";
      if (onlyMemo) return "提醒";
      return "任务/提醒";
    })();
    this.refreshPromise = this.refreshIndexAndSyncInner(opts)
      .catch((e) => {
        if (opts?.noticeOnError !== false) {
          new Notice(`${label}索引刷新失败：${(e as any)?.message ?? String(e)}`);
        }
        throw e;
      })
      .finally(() => {
        this.refreshPromise = null;
      });
    return this.refreshPromise;
  }



  // =========================
  // E2: atomic pipeline helpers (Engine.runE2)
  // =========================

  /** 清除扫描缓存，使下次扫描强制重新读取并解析所有文件。用于 manual_refresh 时避免复用旧缓存导致已删除任务仍显示。 */
  public async clearScanCache(): Promise<void> {
    try {
      await this.store.writeScanCache({ filterKey: "", files: {} } as any);
    } catch {
      // ignore
    }
  }

  public async e2ScanIncremental(
    modules?: TaskMemoModules,
    opts?: { fixUidAndMeta?: boolean }
  ): Promise<{
    modules: { task: boolean; memo: boolean };
    tasks: RSLatteParsedLine[];
    memos: RSLatteParsedLine[];
    includedFilePaths: string[];
    touchedFilePaths: string[];
    removedFilePaths: string[];
    contactInteractionsByFile: Record<string, { mtime: number; entries: ContactsInteractionEntry[] }>;
    fullScan: boolean;
  }> {
    await this.ensureReady();
    const normModules = (m?: TaskMemoModules): { task: boolean; memo: boolean } => {
      if (!m) return { task: true, memo: true };
      return { task: m.task === true, memo: m.memo === true };
    };
    const mods = normModules(modules);
    const prevTaskIndex = await this.store.readIndex("task");
    const prevMemoIndex = await this.store.readIndex("memo");
    const fixUidAndMeta = opts?.fixUidAndMeta === true;
    const { tasks, memos, includedFilePaths, touchedFilePaths, removedFilePaths, contactInteractionsByFile } = await this.scanAllCached(
      prevTaskIndex.items ?? [],
      prevMemoIndex.items ?? [],
      { fixUidAndMeta }
    );
    return {
      modules: mods,
      tasks: mods.task ? tasks : [],
      memos: mods.memo ? memos : [],
      includedFilePaths,
      touchedFilePaths,
      removedFilePaths,
      contactInteractionsByFile,
      fullScan: false,
    };
  }

  public async e2ScanFull(modules?: TaskMemoModules): Promise<{
    modules: { task: boolean; memo: boolean };
    tasks: RSLatteParsedLine[];
    memos: RSLatteParsedLine[];
    includedFilePaths: string[];
    touchedFilePaths: string[];
    removedFilePaths: string[];
    contactInteractionsByFile: Record<string, { mtime: number; entries: ContactsInteractionEntry[] }>;
    fullScan: boolean;
  }> {
    await this.ensureReady();
    const normModules = (m?: TaskMemoModules): { task: boolean; memo: boolean } => {
      if (!m) return { task: true, memo: true };
      return { task: m.task === true, memo: m.memo === true };
    };
    const mods = normModules(modules);

    // Clear scan cache so full scan re-reads all files.
    await this.clearScanCache();

    const prevTaskIndex = await this.store.readIndex("task");
    const prevMemoIndex = await this.store.readIndex("memo");
    const { tasks, memos, includedFilePaths, touchedFilePaths, removedFilePaths, contactInteractionsByFile } = await this.scanAllCached(
      prevTaskIndex.items ?? [],
      prevMemoIndex.items ?? [],
      { fixUidAndMeta: true }
    );

    return {
      modules: mods,
      tasks: mods.task ? tasks : [],
      memos: mods.memo ? memos : [],
      includedFilePaths,
      touchedFilePaths,
      removedFilePaths,
      contactInteractionsByFile,
      fullScan: true,
    };
  }

  public async e2ApplyScanToIndex(scan: { modules: { task: boolean; memo: boolean }; tasks: RSLatteParsedLine[]; memos: RSLatteParsedLine[] }): Promise<{    modules: { task: boolean; memo: boolean };  }> {
    await this.ensureReady();
    const mods = scan.modules;

    let taskIndexItems: RSLatteIndexItem[] = [];
    let memoIndexItems: RSLatteIndexItem[] = [];

    if (mods.task) taskIndexItems = await this.mergeIntoIndex("task", scan.tasks ?? []);
    if (mods.memo) memoIndexItems = await this.mergeIntoIndex("memo", scan.memos ?? []);

    if (mods.task) taskIndexItems = await this.dedupeDuplicateItemIds("task", taskIndexItems);
    if (mods.memo) memoIndexItems = await this.dedupeDuplicateItemIds("memo", memoIndexItems);

    // If some items already have tid/mid, but the queue still contains old create ops,
    // prune them to prevent endless retries.
    const taskWithId = (taskIndexItems ?? []).filter((x) => (x as any)?.itemId != null);
    const memoWithId = (memoIndexItems ?? []).filter((x) => (x as any)?.itemId != null);
    const taskKeysWithId = new Set(taskWithId.map((x) => `${(x as any).filePath}#${(x as any).lineNo}`));
    const memoKeysWithId = new Set(memoWithId.map((x) => `${(x as any).filePath}#${(x as any).lineNo}`));
    const taskHashWithId = new Set(taskWithId.map((x) => String((x as any).sourceHash || "")).filter(Boolean));
    const memoHashWithId = new Set(memoWithId.map((x) => String((x as any).sourceHash || "")).filter(Boolean));
    if (mods.task) await this.queue.pruneCreatesWithIds("task", taskKeysWithId, taskHashWithId);
    if (mods.memo) await this.queue.pruneCreatesWithIds("memo", memoKeysWithId, memoHashWithId);

    if (mods.memo) {
      await this.autoCreateNextMemoEntries(memoIndexItems);
    }

    // Update status-lamp counts (pending/failed)
    try {
      await this.reportDbSyncCounts(mods);
    } catch {
      // ignore
    }

    return { modules: mods };
  }

  public async e2ArchiveOutOfRange(modules?: TaskMemoModules): Promise<{    modules: { task: boolean; memo: boolean };    archivedCount: number;    cutoffDate: string;  }> {
    const normModules = (m?: TaskMemoModules): { task: boolean; memo: boolean } => {
      if (!m) return { task: true, memo: true };
      return { task: m.task === true, memo: m.memo === true };
    };
    const mods = normModules(modules);
    const r = await this.archiveNow(mods);
    // archiveNow already saves settings + lastRunKey
    return { modules: mods, archivedCount: Number((r as any)?.archivedCount ?? 0), cutoffDate: String((r as any)?.cutoffDate ?? "") };
  }

  public async e2BuildOps(mods: { task: boolean; memo: boolean }, opts?: { forceFullSync?: boolean }): Promise<{    enqueued: number;  }> {
    await this.ensureReady();
    if (!this.enableSync) return { enqueued: 0 };

    const before = (await this.queue.listAll())?.length ?? 0;

    const forceFullSync = opts?.forceFullSync === true;

    if (mods.task) {
      const idx = await this.store.readIndex("task");
      const items = (idx.items ?? []) as any as RSLatteIndexItem[];
      await this.enqueueMissingIds("task", items);
      if (forceFullSync) {
        const missing = await this.findMissingDbItemIds("task", items);
        await this.enqueueRepairOrForceUpdates("task", items, missing);
      } else {
        await this.enqueueUpdates("task", items);
      }
    }

    if (mods.memo) {
      const idx = await this.store.readIndex("memo");
      const items = (idx.items ?? []) as any as RSLatteIndexItem[];
      await this.enqueueMissingIds("memo", items);
      if (forceFullSync) {
        const missing = await this.findMissingDbItemIds("memo", items);
        await this.enqueueRepairOrForceUpdates("memo", items, missing);
      } else {
        await this.enqueueUpdates("memo", items);
      }
    }

    const after = (await this.queue.listAll())?.length ?? 0;
    return { enqueued: Math.max(0, after - before) };
  }

  /** 日程索引 → 同步队列（与 scheduleSpecAtomic.buildOps 对齐） */
  public async e2BuildOpsSchedule(opts?: { forceFullSync?: boolean }): Promise<{ enqueued: number }> {
    await this.ensureReady();
    if (!this.enableSync) return { enqueued: 0 };

    const before = (await this.queue.listAll())?.length ?? 0;
    const forceFullSync = opts?.forceFullSync === true;

    const idx = await this.store.readIndex("schedule");
    const items = (idx.items ?? []) as any as RSLatteIndexItem[];

    await this.enqueueMissingIds("schedule", items);
    if (forceFullSync) {
      const missing = await this.findMissingDbItemIds("schedule", items);
      await this.enqueueRepairOrForceUpdates("schedule", items, missing);
    } else {
      await this.enqueueUpdates("schedule", items);
    }

    const after = (await this.queue.listAll())?.length ?? 0;
    return { enqueued: Math.max(0, after - before) };
  }

  public async e2ReconcileForType(
    itemType: "task" | "memo",
    scan: { includedFilePaths: string[]; tasks?: RSLatteParsedLine[]; memos?: RSLatteParsedLine[] }
  ): Promise<void> {
    await this.ensureReady();

    const requireQueueEmpty = (this.tp as any)?.reconcileRequireQueueEmpty !== false;
    const requireFileClean = (this.tp as any)?.reconcileRequireFileClean !== false;

    const lines = itemType === "task" ? (scan?.tasks ?? []) : (scan?.memos ?? []);

    await runReconcileForType({
      itemType,
      enableSync: this.enableSync,
      api: this.host.api,
      queue: this.queue as any,
      requireQueueEmpty,
      requireFileClean,
      includedFilePaths: scan?.includedFilePaths ?? [],
      lines,
    });
  }

  /** 日程：扫描重建后与 POST /schedules/reconcile 对齐（scan.memos 为日程行） */
  public async e2ReconcileSchedule(scan: { includedFilePaths: string[]; memos?: RSLatteParsedLine[] }): Promise<void> {
    await this.ensureReady();

    const requireQueueEmpty = (this.tp as any)?.reconcileRequireQueueEmpty !== false;
    const requireFileClean = (this.tp as any)?.reconcileRequireFileClean !== false;

    const lines = (scan?.memos ?? []) as RSLatteParsedLine[];

    await runReconcileSchedule({
      enableSync: this.enableSync,
      api: this.host.api,
      queue: this.queue as any,
      requireQueueEmpty,
      requireFileClean,
      includedFilePaths: scan?.includedFilePaths ?? [],
      lines,
      dbg: (this.host as any).dbg,
    });
  }

  private async refreshIndexAndSyncInner(opts?: { sync?: boolean; noticeOnError?: boolean; forceFullSync?: boolean; modules?: TaskMemoModules }): Promise<void> {
    await this.ensureReady();

    // Step6-5.3: optional per-module execution (task/memo). If `modules` is provided,
    // only the modules explicitly set to true will be processed. If omitted, process both.
    const normModules = (m?: TaskMemoModules): { task: boolean; memo: boolean } => {
      if (!m) return { task: true, memo: true };
      return { task: m.task === true, memo: m.memo === true };
    };
    const mods = normModules(opts?.modules);
    if (!mods.task && !mods.memo) return;

    // Incremental scan: reuse previous index items for unchanged files.
    const prevTaskIndex = await this.store.readIndex("task");
    const prevMemoIndex = await this.store.readIndex("memo");
    const fixUidAndMeta = !!opts?.forceFullSync || opts?.noticeOnError === true;
    const { tasks, memos, includedFilePaths, removedFilePaths, contactInteractionsByFile } = await this.scanAllCached(
      prevTaskIndex.items ?? [],
      prevMemoIndex.items ?? [],
      { fixUidAndMeta }
    );

    // 同步任务/提醒中的联系人引用到 contacts-interactions，使联系人侧栏与笔记中的「动态互动」能显示最新任务
    try {
      const store = (this.host as any)?.contactsIndex?.getInteractionsStore?.();
      if (store && typeof (store as any).applyFileUpdates === "function") {
        const byFile = contactInteractionsByFile ?? {};
        const upserts = Object.keys(byFile).map((fp) => ({
          source_path: fp,
          mtime: Number((byFile as any)[fp]?.mtime ?? 0),
          entries: Array.isArray((byFile as any)[fp]?.entries) ? (byFile as any)[fp].entries : [],
        }));
        const removals = Array.isArray(removedFilePaths) ? removedFilePaths : [];
        await (store as any).applyFileUpdates({ upserts, removals });
      }
    } catch {
      // never block task refresh
    }

    // Only update selected module indexes; keep others untouched.
    let taskIndexItems = (prevTaskIndex.items ?? []) as any;
    let memoIndexItems = (prevMemoIndex.items ?? []) as any;
    if (mods.task) taskIndexItems = await this.mergeIntoIndex("task", tasks);
    if (mods.memo) memoIndexItems = await this.mergeIntoIndex("memo", memos);

    // ✅ Local de-dup: if the rebuilt index contains duplicate itemId,
    // keep one as the canonical record, and treat other duplicates as "new rows" (create + write back new id).
    if (mods.task) taskIndexItems = await this.dedupeDuplicateItemIds("task", taskIndexItems);
    if (mods.memo) memoIndexItems = await this.dedupeDuplicateItemIds("memo", memoIndexItems);


    // If some tasks already have tid/mid, but the queue still contains old create ops,
    // prune them to prevent endless retries.
    const taskWithId = taskIndexItems.filter((x: RSLatteIndexItem) => x.itemId != null);
    const memoWithId = memoIndexItems.filter((x: RSLatteIndexItem) => x.itemId != null);
    const taskKeysWithId = new Set<string>(taskWithId.map((x: RSLatteIndexItem) => `${x.filePath}#${x.lineNo}`));
    const memoKeysWithId = new Set<string>(memoWithId.map((x: RSLatteIndexItem) => `${x.filePath}#${x.lineNo}`));
    const taskHashWithId = new Set<string>(taskWithId.map((x: any) => String(x.sourceHash || "")).filter(Boolean));
    const memoHashWithId = new Set<string>(memoWithId.map((x: any) => String(x.sourceHash || "")).filter(Boolean));
    if (mods.task) await this.queue.pruneCreatesWithIds("task", taskKeysWithId, taskHashWithId);
    if (mods.memo) await this.queue.pruneCreatesWithIds("memo", memoKeysWithId, memoHashWithId);

    // 周期提醒超过提醒日后：自动新增下一条到对应提醒日记（幂等检查：child + last_auto_spawned）。
    if (mods.memo) await this.autoCreateNextMemoEntries(memoIndexItems);

    if (opts?.sync !== false) {
      if (mods.task) await this.enqueueMissingIds("task", taskIndexItems);
      if (mods.memo) await this.enqueueMissingIds("memo", memoIndexItems);

      if (opts?.forceFullSync) {
        // ✅ rebuild：做一次“索引 -> DB 存在性校验”，避免 DB 重置/丢数据时只 update 不 create。
        // - 若发现 itemId 在 DB 不存在：改为 enqueue create（并在成功后回写新的 id 覆盖旧 id）。
        const missingTaskIds = mods.task ? await this.findMissingDbItemIds("task", taskIndexItems) : new Set<number>();
        const missingMemoIds = mods.memo ? await this.findMissingDbItemIds("memo", memoIndexItems) : new Set<number>();
        if (mods.task) await this.enqueueRepairOrForceUpdates("task", taskIndexItems, missingTaskIds);
        if (mods.memo) await this.enqueueRepairOrForceUpdates("memo", memoIndexItems, missingMemoIds);
      } else {
        if (mods.task) await this.enqueueUpdates("task", taskIndexItems);
        if (mods.memo) await this.enqueueUpdates("memo", memoIndexItems);
      }

      const raw = Number(this.tp?.upsertBatchSize ?? 50);
      const batchSize = Math.max(1, Math.min(500, Number.isFinite(raw) ? Math.floor(raw) : 50));
      await this.flushQueue(batchSize, 10, { drainAll: !!opts?.forceFullSync, manualRetryNow: !!opts?.noticeOnError });

      if (opts?.forceFullSync) {
        await this.maybeReconcileAfterRebuild({
          includedFilePaths,
          tasks: mods.task ? tasks : [],
          memos: mods.memo ? memos : [],
        });
      }

      // Step6-5.5.1：task/memo 各自状态灯计数（pending/failed）
      await this.reportDbSyncCounts(mods);
    }
  }

  /**
   * Step6-5.5.1：计算并上报 task/memo 各自 pending/failed
   * - pending：需要入库（无 id / hash 不一致 / 尚未 pushed）
   * - failed：最近一次入库失败（dbSyncState === failed）
   */
  public async reportDbSyncCounts(mods: { task: boolean; memo: boolean }): Promise<void> {
    if (!this.enableSync) return;
    if (!this.host.reportDbSyncWithCounts) return;

    const compute = async (type: "task" | "memo"): Promise<{ pending: number; failed: number }> => {
      const idx = await this.store.readIndex(type);
      const items = (idx.items ?? []) as any[];
      let pending = 0;
      let failed = 0;
      for (const it of items) {
        if (it?.archived) continue;
        const st = String(it?.dbSyncState ?? "").trim();
        if (st === "failed") {
          failed++;
          continue;
        }
        const itemId = it?.itemId;
        const sourceHash = String(it?.sourceHash || "");
        const last = String((it as any)?.lastPushedHash || "");
        if (itemId == null) {
          pending++;
          continue;
        }
        if (!last || (sourceHash && last !== sourceHash)) {
          pending++;
          continue;
        }
      }
      return { pending, failed };
    };

    if (mods.task) {
      const c = await compute("task");
      this.host.reportDbSyncWithCounts("task", {
        pendingCount: c.pending,
        failedCount: c.failed,
        ok: c.failed === 0,
        err: c.failed > 0 ? "部分任务入库失败（可刷新重试）" : undefined,
      });
    }
    if (mods.memo) {
      const c = await compute("memo");
      this.host.reportDbSyncWithCounts("memo", {
        pendingCount: c.pending,
        failedCount: c.failed,
        ok: c.failed === 0,
        err: c.failed > 0 ? "部分提醒入库失败（可刷新重试）" : undefined,
      });
    }
  }

  /**
   * ✅ 检查一批 itemId 在 DB 是否存在，返回“缺失的 id 集合”。
   * - 仅在 forceFullSync（扫描重建）阶段调用。
   * - 若 DB 不可用/接口失败：返回空集合（不阻断刷新流程）。
   */
  private async findMissingDbItemIds(type: RSLatteItemType, items: RSLatteIndexItem[]): Promise<Set<number>> {
    if (!this.enableSync) return new Set();

    const ids = Array.from(new Set(
      (items ?? [])
        .map((x) => x.itemId)
        .filter((x): x is number => typeof x === "number" && x > 0)
    ));
    if (!ids.length) return new Set();

    const missing = new Set<number>();

    // chunk to avoid oversized payload (backend max 500)
    const chunkSize = 400;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      try {
        const resp: any = await apiTry(
          type === "schedule" ? "检查日程是否入库" : "检查任务/提醒是否入库",
          () =>
            type === "schedule"
              ? (this.host.api as any).schedulesExists({ ids: chunk }, { include_deleted: true })
              : (this.host.api as any).rslatteItemsExists({ ids: chunk }, { type, include_deleted: true })
        );
        const miss = (resp?.missing ?? []) as any[];
        for (const m of miss) {
          if (typeof m === "number") missing.add(m);
          if (typeof m === "string" && /^\d+$/.test(m)) missing.add(Number(m));
        }
      } catch (e) {
        // Don't block rebuild on DB check failure; just fall back to update-only.
        return new Set();
      }
    }

    return missing;
  }

  /**
   * ✅ 本地去重：同一个 itemId 在索引里出现多次时
   * - 保留第一个作为“覆盖/更新”的 canonical
   * - 其余条目：清空 itemId，当作新条目入库（create 成功后会回写新 id 覆盖旧 id）
   */
  private async dedupeDuplicateItemIds(type: RSLatteItemType, items: RSLatteIndexItem[]): Promise<RSLatteIndexItem[]> {
    const list = (items ?? []).map((x) => ({ ...x } as any)) as RSLatteIndexItem[];

    // count ids
    const counts = new Map<number, number>();
    for (const it of list) {
      const id = (it as any).itemId as any;
      if (typeof id === "number" && id > 0) counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    const seen = new Set<number>();
    let changed = false;

    for (const it of list) {
      const id = (it as any).itemId as any;
      if (typeof id !== "number" || id <= 0) continue;
      if ((counts.get(id) ?? 0) <= 1) continue;

      if (!seen.has(id)) {
        // canonical
        seen.add(id);
        continue;
      }

      // duplicate => treat as new
      (it as any).itemId = undefined;
      (it as any).lastPushedHash = undefined;
      (it as any).lastPushedAt = undefined;
      changed = true;
    }

    if (changed) {
      const now = toIsoNow();
      await this.store.writeIndex(type, { version: 1, updatedAt: now, items: list as any });
    }

    return list;
  }

  /**
   * ✅ rebuild 专用：
   * - 若 itemId 在 DB 缺失：enqueue create（用 payload 重新入库，成功后回写新 id 覆盖旧 id）
   * - 否则：enqueue update（全量校验）
   */
  private async enqueueRepairOrForceUpdates(type: RSLatteItemType, items: RSLatteIndexItem[], missingIds: Set<number>): Promise<void> {
    if (!this.enableSync) return;

    for (const it of items) {
      if (it.archived) continue;
      if (it.itemId == null) continue;

      const payload = buildCreatePayload(it as any);

      if (missingIds && missingIds.has(it.itemId)) {
        // DB 中不存在：用 create 修复（成功后 writeBackId 会覆盖旧 id）
        await this.queue.enqueue("upsert", type, {
          filePath: it.filePath,
          lineNo: it.lineNo,
          payload,
        });
      } else {
        await this.queue.enqueue("upsert", type, {
          filePath: it.filePath,
          lineNo: it.lineNo,
          itemId: it.itemId,
          payload,
        });
      }
    }
  }

  /** 强制把所有已存在 itemId 的条目都 enqueue update，用于“重建索引”后全量校验入库。 */
  private async enqueueForceUpdates(type: RSLatteItemType, items: RSLatteIndexItem[]): Promise<void> {
    if (!this.enableSync) return;

    for (const it of items) {
      if (it.archived) continue;
      if (it.itemId == null) continue;

      const payload = buildCreatePayload(it as any);
      await this.queue.enqueue("upsert", type, {
        filePath: it.filePath,
        lineNo: it.lineNo,
        itemId: it.itemId,
        payload,
      });
    }
  }

  private async enqueueMissingIds(type: RSLatteItemType, items: RSLatteIndexItem[]): Promise<void> {
    if (!this.enableSync) return;

    for (const it of items) {
      if (it.archived) continue;
      if (it.itemId != null) continue;

      const payload = buildCreatePayload(it);

      await this.queue.enqueue("upsert", type, {
        filePath: it.filePath,
        lineNo: it.lineNo,
        payload,
      });
    }
  }

  private async enqueueUpdates(type: RSLatteItemType, items: RSLatteIndexItem[]): Promise<void> {
    if (!this.enableSync) return;

    for (const it of items) {
      if (it.archived) continue;
      if (it.itemId == null) continue;

      const last = (it as any).lastPushedHash as string | undefined;
      // sourceHash excludes rslatte comment, so tid/mid write-back won't trigger false updates.
      if (last && last === it.sourceHash) continue;

      const payload = buildCreatePayload(it as any);
      await this.queue.enqueue("upsert", type, {
        filePath: it.filePath,
        lineNo: it.lineNo,
        itemId: it.itemId,
        payload,
      });
    }
  }

  private async markIndexPushed(type: RSLatteItemType, filePath: string, lineNo: number, itemId: number | undefined, sourceHash: string | undefined): Promise<void> {
    const idx = await this.store.readIndex(type);
    let changed = false;
    const now = toIsoNow();

    idx.items = (idx.items ?? []).map((it: any) => {
      if (it.filePath === filePath && it.lineNo === lineNo) {
        const next: any = { ...it };
        // allow overwrite (DB reset -> create returns a new id)
        if (itemId != null && (next.itemId == null || next.itemId !== itemId)) next.itemId = itemId;
        if (sourceHash) next.lastPushedHash = sourceHash;
        next.lastPushedAt = now;
        changed = true;
        return next;
      }
      return it;
    });

    if (changed) await this.store.writeIndex(type, { ...idx, updatedAt: now });
  }


  public async flushQueue(limit = 50, maxTries = 10, opts?: { drainAll?: boolean; manualRetryNow?: boolean; maxBatches?: number }): Promise<void> {
    if (!this.enableSync) return;

    // Prevent concurrent flushes (UI auto refresh can call refreshIndexAndSync repeatedly).
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.flushQueueInner(limit, maxTries, opts).finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  private async flushQueueInner(limit = 50, maxTries = 10, opts?: { drainAll?: boolean; manualRetryNow?: boolean; maxBatches?: number }): Promise<void> {
    return await flushQueueUpsertV2({
      app: this.host.app,
      enableSync: this.enableSync,
      queue: this.queue,
      store: this.store,
      api: this.host.api,
      refreshSidePanel: this.host.refreshSidePanel,
      reportDbSync: this.host.reportDbSync,
      limit,
      maxTries,
      opts,
    });
  }

  
  /**
   * ✅ Reconcile（仅用于“扫描重建(forceFullSync)”后的 DB 清理）
   * 安全门：
   * - 设置项 reconcileRequireQueueEmpty=true 时：队列非空则跳过
   * - 仅在本次扫描 scope_file_paths 范围内清理（避免误删其它目录的数据）
   */
  private async maybeReconcileAfterRebuild(ctx: { includedFilePaths: string[]; tasks: RSLatteParsedLine[]; memos: RSLatteParsedLine[] }): Promise<void> {
    return await runReconcileAfterRebuild({
      enableSync: this.enableSync,
      api: this.host.api,
      queue: this.queue,
      requireQueueEmpty: (this.tp?.reconcileRequireQueueEmpty ?? true) === true,
      requireFileClean: (this.tp?.reconcileRequireFileClean ?? true) === true,
      includedFilePaths: ctx.includedFilePaths,
      tasks: ctx.tasks,
      memos: ctx.memos,
      dbg: (this.host as any).dbg,
    });
  }


/** 把 DB 主键回写到任务行的 HTML 注释里 */
  private async writeBackId(filePath: string, lineNo: number, type: RSLatteItemType, itemId: number): Promise<void> {
    const af = this.host.app.vault.getAbstractFileByPath(filePath);
    if (!af || !(af instanceof TFile)) return;

    const content = await this.host.app.vault.read(af);
    const lines = content.split(/\r?\n/);
    // IMPORTANT: In this codebase, parsed/indexed `lineNo` is 0-based (see parse loop using i).
    // So here we must treat it as a direct array index. A wrong 1-based conversion will write the
    // rslatte comment into the previous line (often a heading), which is exactly the bug we saw.
    const idx = Number(lineNo);
    if (!Number.isFinite(idx) || idx < 0 || idx >= lines.length) return;

    const oldLine = lines[idx];

    // Safety guard: only write back rslatte comment into a real task line (checkbox list item).
    // This prevents accidental insertion into headings or other non-task lines when lineNo is wrong.
    const isTaskLine = /^\s*[-*+]\s*\[[^\]]\]\s+/.test(oldLine);
    if (!isTaskLine) {
      (this.host as any).dbg?.("taskRSLatte", "writeBackId skipped: target line is not a task line", {
        filePath,
        lineNo,
        idx,
        type,
        itemId,
        linePreview: oldLine.slice(0, 120),
      });
      return;
    }
    const newLine = upsertRSLatteComment(oldLine, type, itemId);
    if (newLine === oldLine) return;

    lines[idx] = newLine;
    await this.host.app.vault.modify(af, lines.join("\n"));
  }

  // =========================
  // UI actions (task status)
  // =========================

  /**
   * Apply a status change to a task line and write meta timestamps.
   * - Updates checkbox mark: TODO[ ] / IN_PROGRESS[/] / DONE[x] / CANCELLED[-]
   * - Keeps other tokens intact, but:
   *    - DONE: ensures "✅ YYYY-MM-DD" and removes "❌"
   *    - CANCELLED: ensures "❌ YYYY-MM-DD" and removes "✅"
   *    - TODO: removes both "✅" and "❌"
   * - Writes v2 meta comment timestamp fields (append-only; does not delete old keys).
   * - Emits a Work Event (success only).
   */
  public async applyTaskStatusAction(
    it: Pick<RSLatteIndexItem, "filePath" | "lineNo" | "uid" | "text" | "raw" | "status">,
    to: TaskStatusAction,
    opts?: { skipWorkEvent?: boolean }
  ): Promise<void> {
    const filePath = String(it.filePath ?? "");
    const uid = String((it as any).uid ?? "").trim();
    if (!filePath) throw new Error("missing filePath");

    const af = this.host.app.vault.getAbstractFileByPath(filePath);
    if (!af || !(af instanceof TFile)) throw new Error("file not found");

    const content = await this.host.app.vault.read(af);
    const lines = (content ?? "").split(/\r?\n/);

    const findTaskLineByUid = (): number | null => {
      if (!uid) return null;
      for (let i = 0; i < lines.length; i++) {
        if (!metaLineHasUid(lines[i], uid)) continue;
        const taskIdx = i - 1;
        if (taskIdx >= 0 && String(lines[taskIdx] ?? "").match(TASK_LINE_RE)) return taskIdx;
      }
      return null;
    };

    // Prefer the indexed lineNo; fallback to uid meta scan if user edited the file.
    let idx = Number(it.lineNo);
    if (!Number.isFinite(idx) || idx < 0 || idx >= lines.length) idx = -1;
    if (idx >= 0) {
      const ok = !!String(lines[idx] ?? "").match(TASK_LINE_RE);
      if (!ok) idx = -1;
    }
    if (idx < 0) {
      const byUid = findTaskLineByUid();
      if (byUid == null) throw new Error("cannot locate task line (lineNo invalid and uid not found)");
      idx = byUid;
    }

    const oldLine = lines[idx] ?? "";
    const m = oldLine.match(TASK_LINE_RE);
    if (!m) throw new Error("target line is not a task checkbox line");

    const prefix = m[1] ?? "- ";
    const bodyWithSpace = m[3] ?? " ";
    const newMark = statusToMark(to);
    const today = todayYmd();

    let body = String(bodyWithSpace).trimEnd();
    if (to === "DONE") {
      body = stripStatusTokens(body, { done: true, cancelled: true });
      body = ensureToken(body, `✅ ${today}`);
    } else if (to === "CANCELLED") {
      body = stripStatusTokens(body, { done: true, cancelled: true });
      body = ensureToken(body, `❌ ${today}`);
    } else if (to === "TODO") {
      body = stripStatusTokens(body, { done: true, cancelled: true });
    } else if (to === "IN_PROGRESS") {
      if (!/\s*🛫\uFE0F?\s*\d{4}-\d{2}-\d{2}/u.test(body)) body = ensureToken(body, `🛫 ${today}`);
    }

    const newLine = `${prefix}[${newMark}] ${body.trim()}`;

    if (newLine !== oldLine) {
      lines[idx] = newLine;
      await this.host.app.vault.modify(af, lines.join("\n"));
    }

    const tsIso = nowIso();
    const patch: Record<string, string> = {};
    if (to === "DONE") {
      patch["done_time"] = tsIso;
      patch["task_phase"] = "done";
    }
    if (to === "CANCELLED") {
      patch["cancelled_time"] = tsIso;
      patch["task_phase"] = "cancelled";
    }
    if (to === "IN_PROGRESS") {
      patch["in_progress_time"] = tsIso;
      patch["task_phase"] = "in_progress";
    }
    if (to === "TODO") {
      patch["todo_time"] = tsIso;
      patch["task_phase"] = "todo";
    }

    if (uid) {
      try {
        await writeBackMetaIdByUid(this.host.app, filePath, uid, patch, idx);
      } catch (e) {
        (this.host as any).dbg?.("taskRSLatte", "applyTaskStatusAction meta patch failed", { filePath, uid, err: String((e as any)?.message ?? e) });
      }
    }

    // ✅ Work Event (success only)
    if (!opts?.skipWorkEvent) {
      try {
        const phaseBefore = indexItemTaskDisplayPhase(it as any);
        const phaseAfter = displayPhaseAfterTaskCheckbox(to);
        const txt = String(it.text ?? "").trim() || String(it.raw ?? "").trim();
        const short = txt.length > 80 ? txt.slice(0, 80) + "…" : txt;
        let short_desc = short;
        const icon = to === "DONE" ? "✅" : to === "CANCELLED" ? "❌" : to === "IN_PROGRESS" ? "▶" : "⏸";

        // ✅ 判断任务状态变更的具体 action
        let action: string;
        if (to === "DONE") {
          action = "done";
          short_desc = "任务完成 " + short_desc;
        } else if (to === "CANCELLED") {
          action = "cancelled";
          short_desc = "任务取消 " + short_desc;
        } else if (to === "IN_PROGRESS") {
          const prevStatusMatch = oldLine.match(TASK_LINE_RE);
          const prevStatusMark = prevStatusMatch?.[2] ?? " ";
          const prevStatus = prevStatusMark === " " ? "TODO" : prevStatusMark === "/" ? "IN_PROGRESS" : prevStatusMark === "x" ? "DONE" : "CANCELLED";
          const hasStartDate = /🛫\uFE0F?\s*\d{4}-\d{2}-\d{2}/.test(oldLine);
          if (prevStatus === "TODO" && !hasStartDate) {
            action = "start";
            short_desc = "任务开始 " + short_desc;
          } else {
            action = "continued";
            short_desc = "任务继续 " + short_desc;
          }
        } else {
          action = "paused";
          short_desc = "任务暂停 " + short_desc;
        }

        void this.host.workEventSvc?.append({
          ts: tsIso,
          kind: "task",
          action: action as any,
          source: "ui",
          summary: `${icon} ${short_desc}`,
          ref: enrichWorkEventRefWithTaskContacts(
            {
              uid: uid || undefined,
              file_path: filePath,
              line_no: idx,
              to,
              task_phase_before: phaseBefore,
              task_phase_after: phaseAfter,
            },
            {
              taskLine: oldLine,
              followContactUids: Array.isArray((it as any).follow_contact_uids)
                ? ((it as any).follow_contact_uids as string[]).map((x) => String(x ?? "").trim()).filter(Boolean)
                : [],
            }
          ),
        } as any);
      } catch {
        // ignore
      }
    }
  }

  /**
   * 带进度信息的任务状态变更（开始处理/等待他人/进入等待/完成任务时使用）
   * 更新 checkbox、可选 progress_note / task_phase / wait_until，并写 meta progress_updated。
   */
  public async applyTaskStatusWithProgress(
    it: Pick<RSLatteIndexItem, "filePath" | "lineNo" | "uid" | "text" | "raw" | "status">,
    to: "IN_PROGRESS" | "DONE",
    opts: {
      progress_note?: string;
      task_phase?: "in_progress" | "waiting_others" | "waiting_until";
      wait_until?: string;
      follow_up?: string;
      follow_contact_uids?: string[];
      followContactUids?: string[];
      follow_contact_names?: string[];
      followContactNames?: string[];
      /** 标记完成时写入 meta 的工时评估（小时），须 > 0 */
      estimate_h?: number;
      skipWorkEvent?: boolean;
    }
  ): Promise<void> {
    const filePath = String(it.filePath ?? "");
    const uid = String((it as any).uid ?? "").trim();
    if (!filePath) throw new Error("missing filePath");

    const af = this.host.app.vault.getAbstractFileByPath(filePath);
    if (!af || !(af instanceof TFile)) throw new Error("file not found");

    const content = await this.host.app.vault.read(af);
    const lines = (content ?? "").split(/\r?\n/);

    const findTaskLineByUid = (): number | null => {
      if (!uid) return null;
      for (let i = 0; i < lines.length; i++) {
        if (!metaLineHasUid(lines[i], uid)) continue;
        const taskIdx = i - 1;
        if (taskIdx >= 0 && String(lines[taskIdx] ?? "").match(TASK_LINE_RE)) return taskIdx;
      }
      return null;
    };

    let idx = Number(it.lineNo);
    if (!Number.isFinite(idx) || idx < 0 || idx >= lines.length) idx = -1;
    if (idx >= 0 && !String(lines[idx] ?? "").match(TASK_LINE_RE)) idx = -1;
    if (idx < 0) {
      const byUid = findTaskLineByUid();
      if (byUid == null) throw new Error("cannot locate task line");
      idx = byUid;
    }

    const oldLine = lines[idx] ?? "";
    const m = oldLine.match(TASK_LINE_RE);
    if (!m) throw new Error("target line is not a task checkbox line");

    const prefix = m[1] ?? "- ";
    let body = String(m[3] ?? " ").trimEnd();
    const today = todayYmd();
    const tsIso = nowIso();

    if (to === "DONE") {
      body = stripStatusTokens(body, { done: true, cancelled: true });
      body = ensureToken(body, `✅ ${today}`);
      lines[idx] = `${prefix}[x] ${body}`;
    } else {
      if (!/\s*🛫\uFE0F?\s*\d{4}-\d{2}-\d{2}/u.test(body)) body = ensureToken(body, `🛫 ${today}`);
      lines[idx] = `${prefix}[/] ${body}`;
    }

    await this.host.app.vault.modify(af, lines.join("\n"));

    // 周期任务：完成后自动在“当前日期的下一次周期日”创建下一条任务
    if (to === "DONE") {
      const rrFromLine = (() => {
        const mm = String(oldLine ?? "").match(/🔁\uFE0F?\s*(weekly|monthly|seasonly|quarterly|yearly)\b/i);
        return mm ? String(mm[1] ?? "").trim().toLowerCase() : "";
      })();
      const rr = normalizeRepeatRuleToken(rrFromLine || String((it as any).repeatRule ?? "").trim().toLowerCase());
      if (rr === "weekly" || rr === "monthly" || rr === "quarterly" || rr === "yearly") {
        const dueFromLine = (() => {
          const mm = String(oldLine ?? "").match(/📅\uFE0F?\s*(\d{4}-\d{2}-\d{2})/);
          return mm ? String(mm[1] ?? "").trim() : "";
        })();
        const startFromLine = (() => {
          const mm = String(oldLine ?? "").match(/⏳\uFE0F?\s*(\d{4}-\d{2}-\d{2})/);
          return mm ? String(mm[1] ?? "").trim() : "";
        })();
        const plannedEnd = dueFromLine || String((it as any).planned_end ?? "").trim();
        const plannedStart = startFromLine || String((it as any).planned_start ?? "").trim() || undefined;
        await this.createNextCycleTaskFromDone(it as any, rr, today, plannedEnd, plannedStart);
      }
    }

    const progressNoteRaw = opts.progress_note != null && opts.progress_note !== "" ? opts.progress_note.trim().slice(0, 2000) : "";
    const patch: Record<string, string> = {
      progress_updated: tsIso,
      ...(progressNoteRaw && { progress_note: progressNoteRaw.replace(/\s+/g, "\u200B") }),
    };
    if (to === "IN_PROGRESS") {
      patch["in_progress_time"] = tsIso;
      patch["task_phase"] = opts.task_phase ?? "in_progress";
      if (opts.wait_until && /^\d{4}-\d{2}-\d{2}$/.test(opts.wait_until)) patch["wait_until"] = opts.wait_until;
      if (opts.task_phase === "waiting_others" && opts.follow_up && /^\d{4}-\d{2}-\d{2}$/.test(opts.follow_up)) patch["follow_up"] = opts.follow_up;
      const followUids = Array.isArray(opts.follow_contact_uids)
        ? opts.follow_contact_uids
        : Array.isArray(opts.followContactUids)
          ? opts.followContactUids
          : [];
      if ((opts.task_phase === "waiting_others" || opts.task_phase === "waiting_until") && followUids.length > 0) {
        const normUids = followUids.map((u) => String(u ?? "").trim()).filter(Boolean);
        if (normUids.length > 0) patch["follow_contact_uids"] = normUids.join(",");
        const followNames = Array.isArray(opts.follow_contact_names)
          ? opts.follow_contact_names
          : Array.isArray(opts.followContactNames)
            ? opts.followContactNames
            : [];
        if (followNames.length > 0 && normUids.length > 0) {
          const normNames = normUids.map((uid, idx) => {
            const raw = String(followNames[idx] ?? "").trim();
            const fallback = uid;
            return (raw || fallback).replace(/[;\r\n|]+/g, " ").trim() || fallback;
          });
          patch["follow_contact_name"] = normNames.join("|");
        }
      }
    } else {
      patch["done_time"] = tsIso;
      patch["task_phase"] = "done";
      const est = Number(opts.estimate_h);
      if (Number.isFinite(est) && est > 0) {
        patch["estimate_h"] = String(est);
      }
    }

    if (uid) {
      try {
        await writeBackMetaIdByUid(this.host.app, filePath, uid, patch, idx);
      } catch (e) {
        (this.host as any).dbg?.("taskRSLatte", "applyTaskStatusWithProgress meta patch failed", { filePath, uid });
      }
    }

    if (!opts?.skipWorkEvent) {
      try {
        const phaseBefore = indexItemTaskDisplayPhase(it as any);
        const phaseAfter = to === "DONE" ? "done" : (opts.task_phase ?? "in_progress");
        const txt = String(it.text ?? "").trim() || String(it.raw ?? "").trim();
        const short = txt.length > 80 ? txt.slice(0, 80) + "…" : txt;
        const icon = to === "DONE" ? "✅" : "▶";
        const summary = to === "DONE" ? `任务完成 ${short}` : `任务进行 ${short}`;
        const followUids = Array.isArray(opts.follow_contact_uids)
          ? opts.follow_contact_uids.map((u) => String(u ?? "").trim()).filter(Boolean)
          : Array.isArray(opts.followContactUids)
            ? opts.followContactUids.map((u) => String(u ?? "").trim()).filter(Boolean)
            : [];
        void this.host.workEventSvc?.append({
          ts: tsIso,
          kind: "task",
          action: to === "DONE" ? "done" : "continued",
          source: "ui",
          summary: `${icon} ${summary}`,
          ref: enrichWorkEventRefWithTaskContacts(
            {
              uid,
              file_path: filePath,
              line_no: idx,
              to,
              task_phase: opts.task_phase,
              task_phase_before: phaseBefore,
              task_phase_after: phaseAfter,
            },
            { taskLine: oldLine, followContactUids: followUids }
          ),
        } as any);
      } catch { /* ignore */ }
    }
  }

  /**
   * 延期：到期日 + N 天，延期原因追加到 progress_note，postpone_count +1，仅首次延期写入 original_due。
   */
  public async postponeTask(
    it: Pick<RSLatteIndexItem, "filePath" | "lineNo" | "uid" | "text" | "raw" | "planned_end" | "postpone_count" | "original_due" | "progress_note">,
    days: number,
    reason: string
  ): Promise<void> {
    const filePath = String(it.filePath ?? "");
    const uid = String((it as any).uid ?? "").trim();
    if (!filePath) throw new Error("missing filePath");
    if (!Number.isFinite(days) || days < 1) throw new Error("延期天数须为正整数");

    const af = this.host.app.vault.getAbstractFileByPath(filePath);
    if (!af || !(af instanceof TFile)) throw new Error("file not found");

    const content = await this.host.app.vault.read(af);
    const lines = (content ?? "").split(/\r?\n/);

    const findTaskLineByUid = (): number | null => {
      if (!uid) return null;
      for (let i = 0; i < lines.length; i++) {
        if (!metaLineHasUid(lines[i], uid)) continue;
        const taskIdx = i - 1;
        if (taskIdx >= 0 && String(lines[taskIdx] ?? "").match(TASK_LINE_RE)) return taskIdx;
      }
      return null;
    };

    let idx = Number(it.lineNo);
    if (idx < 0 || idx >= lines.length) idx = -1;
    if (idx >= 0 && !String(lines[idx] ?? "").match(TASK_LINE_RE)) idx = -1;
    if (idx < 0) {
      const byUid = findTaskLineByUid();
      if (byUid == null) throw new Error("cannot locate task line");
      idx = byUid;
    }

    const oldLine = lines[idx] ?? "";
    const mm = oldLine.match(TASK_LINE_RE);
    if (!mm) throw new Error("target line is not a task checkbox line");

    const currentDue = (it as any).planned_end ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(currentDue)) throw new Error("当前到期日格式异常");

    const nextDue = (() => {
      const d = new Date(currentDue + "T12:00:00");
      d.setDate(d.getDate() + days);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    })();

    const pc = ((it as any).postpone_count ?? 0) + 1;
    const prefix = mm[1] ?? "- ";
    const mark = mm[2] ?? " ";
    let body = String(mm[3] ?? " ");
    const tokenRe = /\s(📅|➕|⏳|🛫|✅|❌|🔁)\s/u;
    const tokenMatch = body.match(tokenRe);
    let descPart = body;
    let tokenPart = "";
    if (tokenMatch && typeof (tokenMatch as any).index === "number") {
      const cut = (tokenMatch as any).index as number;
      descPart = body.slice(0, cut).trimEnd();
      tokenPart = body.slice(cut).trimStart();
    }
    const pureDesc = descPart.replace(TASK_DESC_PREFIX_STRIP_RE, "").trim();
    const newPrefixDesc = buildDescPrefix({
      starred: !!(it as any).starred,
      postpone_count: pc,
      complexity: (it as any).complexity,
    });
    const restTokens = tokenPart.replace(/\s*📅\uFE0F?\s*\d{4}-\d{2}-\d{2}/g, "").replace(/\s{2,}/g, " ").trim();
    const newBody = `${newPrefixDesc}${pureDesc} 📅 ${nextDue}${restTokens ? " " + restTokens : ""}`.replace(/\s{2,}/g, " ").trim();
    lines[idx] = `${prefix}[${mark}] ${newBody}`;
    await this.host.app.vault.modify(af, lines.join("\n"));
    const progressNoteValue = [((it as any).progress_note ?? "").trim(), `延期${days}天：${(reason ?? "").trim() || "无说明"}`].filter(Boolean).join("\n").slice(0, 2000);
    const patch: Record<string, string> = {
      postpone_count: String(pc),
      progress_updated: nowIso(),
      progress_note: progressNoteValue.replace(/\s+/g, "\u200B"),
    };
    if ((it as any).original_due == null || (it as any).original_due === "") patch["original_due"] = currentDue;

    if (uid) {
      try {
        await writeBackMetaIdByUid(this.host.app, filePath, uid, patch, idx);
      } catch (e) {
        (this.host as any).dbg?.("taskRSLatte", "postponeTask meta patch failed", { filePath, uid });
      }
    }
  }

  /**
   * 星标/取消星标：写 meta starred，并更新任务行描述首字符 ⭐
   */
  public async setTaskStarred(
    it: Pick<RSLatteIndexItem, "filePath" | "lineNo" | "uid" | "text" | "raw" | "starred" | "postpone_count" | "complexity">,
    starred: boolean
  ): Promise<void> {
    const filePath = String(it.filePath ?? "");
    const uid = String((it as any).uid ?? "").trim();
    if (!filePath) throw new Error("missing filePath");

    const af = this.host.app.vault.getAbstractFileByPath(filePath);
    if (!af || !(af instanceof TFile)) throw new Error("file not found");

    const content = await this.host.app.vault.read(af);
    const lines = (content ?? "").split(/\r?\n/);

    const findTaskLineByUid = (): number | null => {
      if (!uid) return null;
      for (let i = 0; i < lines.length; i++) {
        if (!metaLineHasUid(lines[i], uid)) continue;
        const taskIdx = i - 1;
        if (taskIdx >= 0 && String(lines[taskIdx] ?? "").match(TASK_LINE_RE)) return taskIdx;
      }
      return null;
    };

    let idx = Number(it.lineNo);
    if (idx < 0 || idx >= lines.length) idx = -1;
    if (idx >= 0 && !String(lines[idx] ?? "").match(TASK_LINE_RE)) idx = -1;
    if (idx < 0) {
      const byUid = findTaskLineByUid();
      if (byUid == null) throw new Error("cannot locate task line");
      idx = byUid;
    }

    const oldLine = lines[idx] ?? "";
    const m = oldLine.match(TASK_LINE_RE);
    if (!m) throw new Error("target line is not a task checkbox line");

    const bodyAll = String(m[3] ?? " ");
    const tokenRe = /\s(📅|➕|⏳|🛫|✅|❌|🔁)\s/u;
    const mt = bodyAll.match(tokenRe);
    let descPart = bodyAll;
    let tokenPart = "";
    if (mt && typeof (mt as any).index === "number") {
      const cut = (mt as any).index as number;
      descPart = bodyAll.slice(0, cut).trimEnd();
      tokenPart = bodyAll.slice(cut).trimStart();
    }

    const descPrefix = buildDescPrefix({
      starred,
      postpone_count: (it as any).postpone_count,
      complexity: (it as any).complexity,
    });
    const pureDesc = (descPart ?? "").replace(TASK_DESC_PREFIX_STRIP_RE, "").trim();
    const newDesc = `${descPrefix}${pureDesc}`.trim();
    const newBody = `${newDesc} ${tokenPart}`.replace(/\s{2,}/g, " ").trimEnd();
    const newLine = `${m[1] ?? "- "}[${m[2] ?? " "}] ${newBody}`;
    if (newLine !== oldLine) {
      lines[idx] = newLine;
      await this.host.app.vault.modify(af, lines.join("\n"));
    }

    if (uid) {
      try {
        await writeBackMetaIdByUid(this.host.app, filePath, uid, { starred: starred ? "1" : "0" }, idx);
      } catch (e) {
        (this.host as any).dbg?.("taskRSLatte", "setTaskStarred meta patch failed", { filePath, uid });
      }
    }
  }

  /**
   * Edit task basic fields (same as AddTaskModal): description text + 📅 due + optional 🛫 start + optional ⏳ scheduled.
   * - Keeps checkbox mark/status.
   * - Keeps other tokens intact (➕/✅/❌/🔁 etc.).
   * - Only rewrites these date tokens: 📅/🛫/⏳.
   * - Preserves inline html comments (e.g. legacy <!-- rslatte:... -->) by keeping all comments from the
   *   description segment.
   * - Writes v2 meta comment `updated_time` and emits a Work Event (success only).
   */
  

  public async applyMemoStatusAction(
    it: Pick<RSLatteIndexItem, "filePath" | "lineNo" | "text" | "raw" | "status"> & { uid?: string },
    to: TaskStatusAction,
    opts?: { skipWorkEvent?: boolean; /** 为 true 时不执行「提前闭环周期提醒」自动生成下一条（如提醒→任务/日程安排后） */ skipPeriodicReschedule?: boolean }
  ): Promise<void> {
    const filePath = String(it.filePath ?? "");
    const uid = String((it as any).uid ?? "").trim();
    if (!filePath) throw new Error("missing filePath");

    const af = this.host.app.vault.getAbstractFileByPath(filePath);
    if (!af || !(af instanceof TFile)) throw new Error("file not found");

    const content = await this.host.app.vault.read(af);
    const lines = (content ?? "").split(/\r?\n/);

    const findLineByUid = (): number | null => {
      if (!uid) return null;
      for (let i = 0; i < lines.length; i++) {
        if (!metaLineHasUid(lines[i], uid)) continue;
        const idx = i - 1;
        if (idx >= 0 && lines[idx] && /^\s*-\s*\[.\]\s+/.test(lines[idx])) return idx;
      }
      return null;
    };

    let idx = findLineByUid();
    if (idx == null) {
      // fallback: lineNo (0-based)
      const ln = Number((it as any).lineNo ?? -1);
      if (ln >= 0 && ln < lines.length) idx = ln;
    }
    if (idx == null) throw new Error("line not found");

    const oldLine = lines[idx] ?? "";
    const mm = oldLine.match(/^\s*(\-\s*)\[(.)\]\s*(.*)$/);
    if (!mm) throw new Error("invalid memo line");

    const prefix = mm[1] ?? "- ";
    // const oldMark = (mm[2] ?? " ").trim();
    const body = String(mm[3] ?? "");

    const markTo = (st: TaskStatusAction): string => {
      if (st === "DONE") return "x";
      if (st === "CANCELLED") return "-";
      if (st === "IN_PROGRESS") return "/";
      return " ";
    };

    // remove existing done/cancel tokens when switching
    let newBody = body;

    // Strip DONE/CANCELLED date tokens; add only when needed.
    newBody = newBody.replace(/\s✅\uFE0F?\s*\d{4}-\d{2}-\d{2}/gu, "");
    newBody = newBody.replace(/\s❌\uFE0F?\s*\d{4}-\d{2}-\d{2}/gu, "");
    newBody = newBody.replace(/\s{2,}/g, " ").trimEnd();

    const today = todayYmd();
    if (to === "DONE") {
      newBody = `${newBody} ✅ ${today}`.replace(/\s{2,}/g, " ").trimEnd();
    } else if (to === "CANCELLED") {
      newBody = `${newBody} ❌ ${today}`.replace(/\s{2,}/g, " ").trimEnd();
    }

    const newLine = `${prefix}[${markTo(to)}] ${newBody}`.replace(/\s{2,}/g, " ").trimEnd();

    if (newLine !== oldLine) {
      lines[idx] = newLine;
      await this.host.app.vault.modify(af, lines.join("\n"));
    }

    const tsIso = nowIso();
    const patch: Record<string, string> = {};
    if (to === "DONE") patch["done_time"] = tsIso;
    if (to === "CANCELLED") patch["cancelled_time"] = tsIso;
    if (to === "IN_PROGRESS") patch["in_progress_time"] = tsIso;
    if (to === "TODO") patch["todo_time"] = tsIso;

    if (uid) {
      try {
        await writeBackMetaIdByUid(this.host.app, filePath, uid, patch, idx);
      } catch (e) {
        (this.host as any).dbg?.("taskRSLatte", "applyMemoStatusAction meta patch failed", {
          filePath,
          uid,
          err: String((e as any)?.message ?? e),
        });
      }
    }

    // 提前闭环周期提醒：若当前提醒尚未到期且被手动完成/取消，立即生成下一条提醒。
    if ((to === "DONE" || to === "CANCELLED") && uid && opts?.skipPeriodicReschedule !== true) {
      try {
        const anyIt = it as any;
        const extra: Record<string, string> = (anyIt?.extra ?? {}) as any;
        const cat = String(extra["cat"] ?? "").trim();
        const isLunar = cat === "lunarBirthday" || String(extra["date_type"] ?? "").trim() === "lunar";
        const isSchedule = isScheduleMemoLine({ extra } as any);
        const baseDate = this.isYmd(String(anyIt?.memoDate ?? "").trim())
          ? String(anyIt?.memoDate ?? "").trim()
          : String(extra["schedule_date"] ?? "").trim();
        const today = todayYmd();
        let rr = String(anyIt?.repeatRule ?? "").trim().toLowerCase();
        if (!rr) rr = String(extra["repeat_rule"] ?? "").trim().toLowerCase();
        if (!rr) rr = anyIt?.memoMmdd ? "yearly" : "none";
        rr = normalizeRepeatRuleToken(rr);
        const allowed = new Set(["none", "weekly", "monthly", "quarterly", "yearly"]);
        if (!allowed.has(rr)) rr = "none";

        const isRepeating = isLunar || rr !== "none";
        const isEarlyClose = this.isYmd(baseDate) && baseDate > today;
        const invalidated = String(extra["invalidated"] ?? "").trim() === "1";
        if (isRepeating && isEarlyClose && !invalidated) {
          const seed = momentFn(baseDate, "YYYY-MM-DD").add(1, "day").format("YYYY-MM-DD");
          let nextYmd = "";
          if (isLunar) {
            const lunarMmdd = String(extra["lunar"] ?? anyIt?.memoMmdd ?? "").trim();
            const leap = String(extra["leap"] ?? "").trim() === "1";
            if (/^\d{2}-\d{2}$/.test(lunarMmdd)) {
              nextYmd = nextSolarDateForLunarBirthday(lunarMmdd, leap, seed);
            }
          } else {
            nextYmd = this.computeNextByRepeat(baseDate, rr, seed, anyIt?.memoMmdd);
          }

          if (this.isYmd(nextYmd)) {
            const itemsForDedup = isSchedule
              ? await (async () => {
                try {
                  const baseDir = String((this.store as any)?.getBaseDir?.() ?? "").trim();
                  if (!baseDir) return [] as RSLatteIndexItem[];
                  const p = normalizePath(`${baseDir}/schedule-index.json`);
                  const ok = await this.host.app.vault.adapter.exists(p);
                  if (!ok) return [] as RSLatteIndexItem[];
                  const raw = await this.host.app.vault.adapter.read(p);
                  const parsed = raw ? JSON.parse(raw) : null;
                  return (Array.isArray(parsed?.items) ? parsed.items : []) as RSLatteIndexItem[];
                } catch {
                  return [] as RSLatteIndexItem[];
                }
              })()
              : (((await this.store.readIndex("memo")).items ?? []) as RSLatteIndexItem[]);
            const exists = itemsForDedup.some((x) => {
              const ex = (x as any)?.extra ?? {};
              const p = String(ex?.auto_parent_uid ?? "").trim();
              const d = this.isYmd(String((x as any)?.memoDate ?? "").trim())
                ? String((x as any)?.memoDate ?? "").trim()
                : String(((x as any)?.extra ?? {})?.schedule_date ?? "").trim();
              return p === uid && d === nextYmd;
            });
            if (!exists) {
              const rules = (this.host.settingsRef().journalAppendRules ?? []) as any[];
              const rule = (isSchedule
                ? rules.find((x) => x.module === "schedule")
                : rules.find((x) => x.module === "memo")
              ) ?? { h1: "# 任务追踪", h2: isSchedule ? "## 新增日程" : "## 新增提醒" };
              const r = rule as any;
              const text = String(anyIt?.text ?? "").trim() || String(anyIt?.raw ?? "").trim();
              const repToken = rr !== "none" ? ` 🔁 ${rr}` : "";
              const line = `- [/] ${text} 📅 ${nextYmd}${repToken} ➕ ${today}`;
              const tsCreate = nowIso();
              const sanitize = (v: any) => String(v ?? "").trim().replace(/[;\s]+/g, "_");
              const uidNew = `lg_${Math.random().toString(16).slice(2, 12)}`;
              const carry: Record<string, string> = {};
              for (const [k, v] of Object.entries(extra ?? {})) {
                const kk = String(k ?? "").trim();
                if (!kk) continue;
                if (kk === "next" || kk === "last_auto_spawned" || kk === "invalidated" || kk === "invalidated_date" || kk === "invalidated_time") continue;
                const vv = String(v ?? "").trim();
                if (!vv) continue;
                carry[kk] = vv;
              }
              carry["auto_parent_uid"] = uid;
              carry["auto_spawned_from"] = baseDate;
              if (isSchedule) carry["schedule_date"] = nextYmd;
              const metaParts: string[] = [`uid=${uidNew}`, `type=${isSchedule ? "schedule" : "memo"}`, `ts=${sanitize(tsCreate)}`];
              if (isSchedule) metaParts.push(`todo_time=${sanitize(tsCreate)}`);
              else metaParts.push(`in_progress_time=${sanitize(tsCreate)}`);
              for (const [k, v] of Object.entries(carry)) {
                const sv = sanitize(v);
                if (!sv) continue;
                metaParts.push(`${k}=${sv}`);
              }
              const meta = `  <!-- rslatte:${metaParts.join(";")} -->`;
              await this.host.journalSvc.upsertLinesToDiaryH1H2(nextYmd, r.h1, r.h2, [line, meta], { mode: "append" });
              await writeBackMetaIdByUid(this.host.app, filePath, uid, { last_auto_spawned: nextYmd }, idx);
              if (cat === "solarBirthday" || cat === "lunarBirthday") {
                const rawContactUid = String(extra["contact_uid"] ?? "").trim();
                const contactUid = extractContactUidFromWikiTarget(rawContactUid) || rawContactUid.replace(/^C_/, "");
                if (contactUid) {
                  await this.appendBirthMemoUidToContact(contactUid, uidNew, String(extra["contact_file"] ?? "").trim());
                }
              }
            }
          }
        }
      } catch {
        // ignore
      }
    }

    // ✅ Work Event (success only)；外部批量写入若已由统一入口记事件，可传 skipWorkEvent: true
    if (!opts?.skipWorkEvent) {
      try {
        const isSched = isScheduleMemoLine(it as any);
        const txt = String((it as any).text ?? "").trim() || String((it as any).raw ?? "").trim();
        const short = txt.length > 80 ? txt.slice(0, 80) + "…" : txt;
        let short_desc = short;
        const icon = to === "DONE" ? "✅" : to === "CANCELLED" ? "❌" : to === "IN_PROGRESS" ? "▶" : "⏸";
        if (isSched) {
          if (to === "DONE") short_desc = "日程完成 " + short_desc;
          else if (to === "CANCELLED") short_desc = "日程取消 " + short_desc;
          else if (to === "IN_PROGRESS") short_desc = "日程继续 " + short_desc;
          else short_desc = "日程待办 " + short_desc;
        } else {
          if (to === "DONE") {
            short_desc = "提醒完成 " + short_desc;
          } else if (to === "CANCELLED") {
            short_desc = "提醒取消 " + short_desc;
          } else if (to === "IN_PROGRESS") {
            short_desc = "提醒继续 " + short_desc;
          } else {
            short_desc = "提醒暂停 " + short_desc;
          }
        }
        // 当状态为 CANCELLED 时，使用 action: "cancelled"，其他状态使用 action: "status"
        const action = to === "CANCELLED" ? "cancelled" : "status";
        void this.host.workEventSvc?.append({
          ts: tsIso,
          kind: isSched ? "schedule" : "memo",
          action: action as any,
          source: "ui",
          ref: {
            uid,
            file_path: filePath,
            line_no: idx,
            status: to,
            ...(isSched ? { category: "schedule" } : {}),
          },
          summary: `${icon} ${short_desc}`,
          metrics: { status: to, ...(isSched ? { category: "schedule" } : {}) },
        });
      } catch (e) {
        // ignore
      }
    }
  }

  /**
   * 提醒经「安排」生成任务或日程后：将清单行置为已完成（`- [x]`）并写入关联 uid（不触发周期提醒提前生成下一条）。
   */
  public async markMemoAsArrangedAfterDerivation(
    it: Pick<RSLatteIndexItem, "filePath" | "lineNo" | "text" | "raw" | "status"> & { uid?: string },
    link: { kind: "task" | "schedule"; targetUid: string }
  ): Promise<void> {
    await this.applyMemoStatusAction(it, "DONE", { skipWorkEvent: true, skipPeriodicReschedule: true });
    const uid = String((it as any).uid ?? "").trim();
    const filePath = String(it.filePath ?? "").trim();
    const targetUid = String(link.targetUid ?? "").trim();
    if (!uid || !filePath || !targetUid) return;
    const idx = Number((it as any).lineNo ?? -1);
    const today = todayYmd();
    const patch: Record<string, string> = {
      arranged_at: today,
      memo_arranged: "1",
      ...(link.kind === "task"
        ? { arranged_task_uid: targetUid }
        : { arranged_schedule_uid: targetUid }),
    };
    await writeBackMetaIdByUid(this.host.app, filePath, uid, patch, Number.isFinite(idx) && idx >= 0 ? idx : undefined);
  }

public async updateTaskBasicInfo(
    it: Pick<RSLatteIndexItem, "filePath" | "lineNo" | "uid" | "text" | "raw">,
    patch: {
      text: string;
      planned_end: string;
      planned_start?: string;
      estimate_h?: number;
      complexity?: "high" | "normal" | "light";
      repeatRule?: string;
      /** 有键且非空则写入；有键且空串则删除 meta 中的 task_category */
      task_category?: string | null;
    },
    opts?: { skipWorkEvent?: boolean }
  ): Promise<void> {
    const filePath = String(it.filePath ?? "");
    const uid = String((it as any).uid ?? "").trim();
    if (!filePath) throw new Error("missing filePath");

    const newText = String(patch.text ?? "").trim();
    const planned_end = String(patch.planned_end ?? "").trim();
    const planned_start = String(patch.planned_start ?? "").trim();
    const rrRaw = normalizeRepeatRuleToken(String(patch.repeatRule ?? "").trim().toLowerCase());
    const rrAllowed = new Set(["weekly", "monthly", "quarterly", "yearly"]);
    const rr = rrAllowed.has(rrRaw) ? rrRaw : "";

    if (!newText) throw new Error("任务描述不能为空");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(planned_end)) throw new Error("计划结束日为必填，且格式必须为 YYYY-MM-DD");
    if (planned_start && !/^\d{4}-\d{2}-\d{2}$/.test(planned_start)) throw new Error("计划开始日格式必须为 YYYY-MM-DD");

    const af = this.host.app.vault.getAbstractFileByPath(filePath);
    if (!af || !(af instanceof TFile)) throw new Error("file not found");

    const content = await this.host.app.vault.read(af);
    const lines = (content ?? "").split(/\r?\n/);

    const findTaskLineByUid = (): number | null => {
      if (!uid) return null;
      for (let i = 0; i < lines.length; i++) {
        if (!metaLineHasUid(lines[i], uid)) continue;
        const taskIdx = i - 1;
        if (taskIdx >= 0 && String(lines[taskIdx] ?? "").match(TASK_LINE_RE)) return taskIdx;
      }
      return null;
    };

    // Prefer indexed lineNo; fallback to uid scan.
    let idx = Number(it.lineNo);
    if (!Number.isFinite(idx) || idx < 0 || idx >= lines.length) idx = -1;
    if (idx >= 0) {
      const ok = !!String(lines[idx] ?? "").match(TASK_LINE_RE);
      if (!ok) idx = -1;
    }
    if (idx < 0) {
      const byUid = findTaskLineByUid();
      if (byUid == null) throw new Error("cannot locate task line (lineNo invalid and uid not found)");
      idx = byUid;
    }

    const oldLine = lines[idx] ?? "";
    const m = oldLine.match(TASK_LINE_RE);
    if (!m) throw new Error("target line is not a task checkbox line");

    const prefix = m[1] ?? "- ";
    const mark = m[2] ?? " ";
    const bodyAll = String(m[3] ?? " ");

    // Split by first metadata token to preserve existing tokens order as much as possible.
    const tokenRe = /\s(📅|➕|⏳|🛫|✅|❌|🔁)\s/u;
    const mt = bodyAll.match(tokenRe);
    let descPart = bodyAll;
    let tokenPart = "";
    if (mt && typeof (mt as any).index === "number") {
      const cut = (mt as any).index as number;
      descPart = bodyAll.slice(0, cut).trimEnd();
      tokenPart = bodyAll.slice(cut).trimStart();
    }

    // Preserve all inline html comments from the description segment.
    const comments: string[] = [];
    const commentRe = /<!--[^>]*-->/g;
    let cm: RegExpExecArray | null;
    while ((cm = commentRe.exec(descPart)) !== null) {
      comments.push(cm[0]);
    }

    // 描述首字符标记（⭐↪🧠🍃，延期为 ↪）；开始日期不在此编辑，保留行上已有的 🛫
    const descPrefix = buildDescPrefix({
      starred: !!(it as any).starred,
      postpone_count: (it as any).postpone_count,
      complexity: patch.complexity && patch.complexity !== "normal" ? patch.complexity : (it as any).complexity,
    });
    const newDesc = `${descPrefix}${newText}${comments.length ? " " + comments.join(" ") : ""}`.trimEnd();

    // Remove existing 📅/🛫/⏳ tokens only; keep others intact. 保留已有 🛫（实际开始日由「开始处理任务」写入）
    const startMatch = tokenPart.match(/\s*🛫\uFE0F?\s*(\d{4}-\d{2}-\d{2})/);
    const existingStart = startMatch ? startMatch[1] : "";
    let rest = tokenPart;
    rest = rest.replace(/\s*📅\uFE0F?\s*\d{4}-\d{2}-\d{2}/g, "");
    rest = rest.replace(/\s*🛫\uFE0F?\s*\d{4}-\d{2}-\d{2}/g, "");
    rest = rest.replace(/\s*⏳\uFE0F?\s*\d{4}-\d{2}-\d{2}/g, "");
    rest = rest.replace(/\s*🔁\uFE0F?\s*(none|weekly|monthly|seasonly|quarterly|yearly)/gi, "");
    rest = rest.replace(/\s{2,}/g, " ").trim();

    const insert = `📅 ${planned_end}${existingStart ? ` 🛫 ${existingStart}` : ""}${planned_start ? ` ⏳ ${planned_start}` : ""}${rr ? ` 🔁 ${rr}` : ""}`.trim();
    const newBody = `${newDesc} ${insert}${rest ? " " + rest : ""}`.replace(/\s{2,}/g, " ").trimEnd();
    const newLine = `${prefix}[${mark}] ${newBody}`.replace(/\s{2,}/g, " ").trimEnd();

    if (newLine !== oldLine) {
      lines[idx] = newLine;
      await this.host.app.vault.modify(af, lines.join("\n"));
    }

    const tsIso = nowIso();
    const metaPatch: Record<string, string> = { updated_time: tsIso };
    if (patch.estimate_h != null && patch.estimate_h > 0) metaPatch.estimate_h = String(patch.estimate_h);
    if (patch.complexity && patch.complexity !== "normal") metaPatch.complexity = patch.complexity;
    if ("task_category" in patch && patch.task_category != null && String(patch.task_category).trim() !== "") {
      metaPatch.task_category = sanitizeTaskCategoryForMeta(String(patch.task_category));
    }
    if (uid) {
      try {
        await writeBackMetaIdByUid(this.host.app, filePath, uid, metaPatch, idx);
        if ("task_category" in patch && (patch.task_category == null || String(patch.task_category).trim() === "")) {
          await writeBackMetaIdByUidRemoveKeys(this.host.app, filePath, uid, ["task_category"], idx);
        }
      } catch (e) {
        (this.host as any).dbg?.("taskRSLatte", "updateTaskBasicInfo meta patch failed", { filePath, uid, err: String((e as any)?.message ?? e) });
      }
    }

    // Work Event (success only)；外部批量写入若已由统一入口记事件，可传 skipWorkEvent: true
    if (!opts?.skipWorkEvent) {
      try {
        const ph = indexItemTaskDisplayPhase(it as any);
        const short = newText.length > 80 ? newText.slice(0, 80) + "…" : newText;
        void this.host.workEventSvc?.append({
          ts: tsIso,
          kind: "task",
          action: "update",
          source: "ui",
          summary: `✏️ 修改任务 ${short}`,
          ref: enrichWorkEventRefWithTaskContacts(
            {
              uid: uid || undefined,
              file_path: filePath,
              line_no: idx,
              task_phase_before: ph,
              task_phase_after: ph,
            },
            {
              taskLine: newLine,
              followContactUids: Array.isArray((it as any).follow_contact_uids)
                ? ((it as any).follow_contact_uids as string[]).map((x) => String(x ?? "").trim()).filter(Boolean)
                : [],
            }
          ),
          metrics: { due: planned_end, scheduled: planned_start || undefined },
        } as any);
      } catch {
        // ignore
      }
    }
  }

  // =========================
  // Create in today's journal
  // =========================

  

  public async updateMemoBasicInfo(
    it: Pick<RSLatteIndexItem, "filePath" | "lineNo" | "uid" | "text" | "raw">,
    patch: {
      text: string;
      memoDate: string; // YYYY-MM-DD or MM-DD
      repeatRule?: string;
      metaExtra?: Record<string, string | number | boolean | undefined | null>;
    },
    opts?: { skipWorkEvent?: boolean }
  ): Promise<void> {
    const filePath = String(it.filePath ?? "");
    const uid = String((it as any).uid ?? "").trim();
    if (!filePath) throw new Error("missing filePath");

    const newText = String(patch.text ?? "").trim();
    const memoDate = String(patch.memoDate ?? "").trim();
    const repeat = normalizeRepeatRuleToken(String(patch.repeatRule ?? "").trim().toLowerCase());

    if (!newText) throw new Error("提醒内容不能为空");
    const isYmd = /^\d{4}-\d{2}-\d{2}$/.test(memoDate);
    const isMmdd = /^\d{2}-\d{2}$/.test(memoDate);
    if (!isYmd && !isMmdd) throw new Error("日期必须为 YYYY-MM-DD 或 MM-DD");

    const allowed = new Set(["none", "weekly", "monthly", "quarterly", "yearly"]);
    const rr = allowed.has(repeat) ? repeat : "none";

    const af = this.host.app.vault.getAbstractFileByPath(filePath);
    if (!af || !(af instanceof TFile)) throw new Error("file not found");

    const content = await this.host.app.vault.read(af);
    const lines = (content ?? "").split(/\r?\n/);

    const findLineByUid = (): number | null => {
      if (!uid) return null;
      for (let i = 0; i < lines.length; i++) {
        if (!metaLineHasUid(lines[i], uid)) continue;
        const idx = i - 1;
        if (idx >= 0 && lines[idx] && /^\s*-\s*\[.\]\s+/.test(lines[idx])) return idx;
      }
      return null;
    };

    let idx = findLineByUid();
    if (idx == null) {
      const ln = Number((it as any).lineNo ?? -1);
      if (ln >= 0 && ln < lines.length) idx = ln;
    }
    if (idx == null) throw new Error("line not found");

    const oldLine = lines[idx] ?? "";
    const mm = oldLine.match(/^\s*(\-\s*)\[(.)\]\s*(.*)$/);
    if (!mm) throw new Error("invalid memo line");

    const prefix = mm[1] ?? "- ";
    const mark = mm[2] ?? " ";
    const body = String(mm[3] ?? "");

    // preserve inline rslatte comment(s) if any
    const comments: string[] = [];
    const commentRe = /(<!--\s*rslatte:[^>]*-->)/gi;
    let cm: RegExpExecArray | null;
    while ((cm = commentRe.exec(body)) !== null) {
      comments.push(cm[0]);
    }
    const bodyNoComment = body.replace(commentRe, "").trim();

    // split description and token-part by the first 📅 token (so we don't duplicate old text)
    const dateTokenRe = /\s📅\uFE0F?\s*/u;
    const tokenIdx = bodyNoComment.search(dateTokenRe);
    // let descPart = bodyNoComment.trimEnd();
    let tokenPart = "";
    if (tokenIdx >= 0) {
      // descPart = bodyNoComment.slice(0, tokenIdx).trimEnd();
      tokenPart = bodyNoComment.slice(tokenIdx).trim();
    }

    // remove existing 📅 token and 🔁 token only; keep other tokens (➕/✅/❌ etc.)
    let rest = tokenPart;
    rest = rest.replace(/\s📅\uFE0F?\s*(\d{4}-\d{2}-\d{2}|\d{2}-\d{2})/gu, "");
    rest = rest.replace(/\s*🔁\uFE0F?\s*([A-Za-z_]+)\b/gu, "");
    rest = rest.replace(/\s{2,}/g, " ").trim();

    const newDesc = `${newText}${comments.length ? " " + comments.join(" ") : ""}`.trimEnd();
    const insert = `📅 ${memoDate}${rr !== "none" ? ` 🔁 ${rr}` : ""}`.trim();
    const newBody = `${newDesc} ${insert}${rest ? " " + rest : ""}`.replace(/\s{2,}/g, " ").trimEnd();
    const newLine = `${prefix}[${mark}] ${newBody}`.replace(/\s{2,}/g, " ").trimEnd();

    if (newLine !== oldLine) {
      lines[idx] = newLine;
      await this.host.app.vault.modify(af, lines.join("\n"));
    }

    const tsIso = nowIso();
    const metaPatch: Record<string, string> = { updated_time: tsIso };

    // merge metaExtra (sanitize to avoid breaking meta parser)
    const extra = patch.metaExtra ?? {};
    for (const [k0, v0] of Object.entries(extra)) {
      const k = String(k0 ?? "").trim();
      if (!k) continue;
      const v = v0 as any;
      if (v === undefined || v === null) continue;
      const sv = typeof v === "boolean" ? (v ? "1" : "0") : String(v).trim();
      if (!sv) continue;
      metaPatch[k] = sv.replace(/[;\s]+/g, "_");
    }

    if (uid) {
      try {
        await writeBackMetaIdByUid(this.host.app, filePath, uid, metaPatch, idx);
      } catch (e) {
        (this.host as any).dbg?.("taskRSLatte", "updateMemoBasicInfo meta patch failed", {
          filePath,
          uid,
          err: String((e as any)?.message ?? e),
        });
      }
    }

    // ✅ Work Event (success only)，由调用方（如手机同步）自行写入时传 skipWorkEvent: true
    if (!opts?.skipWorkEvent) {
      try {
        const short = newText.length > 80 ? newText.slice(0, 80) + "…" : newText;
        void this.host.workEventSvc?.append({
          ts: tsIso,
          kind: "memo",
          action: "update",
          source: "ui",
          ref: { uid, file_path: filePath, line_no: idx },
          summary: `✏️ 修改提醒 ${short}`,
          metrics: { memoDate, repeatRule: rr },
        });
      } catch (e) {
        // ignore
      }
    }
  }

public async createTodayTask(
    text: string,
    dueDate: string,
    _startDate?: string,
    scheduledDate?: string,
    opts?: {
      estimate_h?: number;
      complexity?: "high" | "normal" | "light";
      repeatRule?: string;
      /** 任务业务分类名称快照，写入 meta `task_category` */
      task_category?: string;
    }
  ): Promise<{ uid: string; diaryPath?: string } | undefined> {
    const t = (text ?? "").trim();
    if (!t) return undefined;

    const today = todayYmd();
    const due = (dueDate ?? "").trim();
    const scheduled = (scheduledDate ?? "").trim();
    const rrRaw = normalizeRepeatRuleToken(String(opts?.repeatRule ?? "").trim().toLowerCase());
    const rrAllowed = new Set(["weekly", "monthly", "quarterly", "yearly"]);
    const rr = rrAllowed.has(rrRaw) ? rrRaw : "";

    if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) {
      throw new Error("到期日期（due）为必填，且格式必须为 YYYY-MM-DD");
    }
    if (scheduled && !/^\d{4}-\d{2}-\d{2}$/.test(scheduled)) {
      throw new Error("计划日期（scheduled）格式必须为 YYYY-MM-DD");
    }

    const descPrefix = buildDescPrefix({
      complexity: opts?.complexity && opts.complexity !== "normal" ? opts.complexity : undefined,
    });
    const uid = `lg_${Math.random().toString(16).slice(2, 12)}`;
    const line = `- [ ] ${descPrefix}${t} 📅 ${due}${scheduled ? ` ⏳ ${scheduled}` : ""}${rr ? ` 🔁 ${rr}` : ""} ➕ ${today}`;
    const tsIso = momentFn().format("YYYY-MM-DDTHH:mm:ssZ");
    const metaParts = [`uid=${uid}`, `type=task`, `ts=${tsIso}`, `task_phase=todo`];
    if (opts?.estimate_h != null && opts.estimate_h > 0) metaParts.push(`estimate_h=${opts.estimate_h}`);
    if (opts?.complexity && opts.complexity !== "normal") metaParts.push(`complexity=${opts.complexity}`);
    const tcSafe = opts?.task_category ? sanitizeTaskCategoryForMeta(opts.task_category) : "";
    if (tcSafe) metaParts.push(`task_category=${tcSafe}`);
    const meta = `  <!-- rslatte:${metaParts.join(";")} -->`;
    // ✅ 按“日志追加清单”配置写入日记（强制启用：任务）
    const rules = (this.host.settingsRef().journalAppendRules ?? []) as any[];
    const r = (rules.find((x) => x.module === "task") ?? { h1: "# 任务追踪", h2: "## 新增任务" }) as any;
    // ✅ 获取当前空间的日记配置，确保写入到正确的空间日记
    const currentSpaceId = (this.host as any).getCurrentSpaceId?.() || "";
    const spaces = (this.host.settingsRef() as any).spaces || {};
    const currentSpace = spaces[currentSpaceId];
    const spaceSnapshot = currentSpace?.settingsSnapshot || {};
    const spaceDiaryPath = spaceSnapshot.diaryPath;
    const spaceDiaryNameFormat = spaceSnapshot.diaryNameFormat;
    const spaceDiaryTemplate = spaceSnapshot.diaryTemplate;
    
    // 临时设置日记配置覆盖（用于空间隔离）
    const originalPathOverride = (this.host.journalSvc as any)._diaryPathOverride;
    const originalFormatOverride = (this.host.journalSvc as any)._diaryNameFormatOverride;
    const originalTemplateOverride = (this.host.journalSvc as any)._diaryTemplateOverride;
    
    let writtenDiaryPath: string | undefined;
    try {
      // 优先使用空间的配置，否则使用全局配置（null 表示使用全局设置）
      this.host.journalSvc.setDiaryPathOverride(
        spaceDiaryPath || null,
        spaceDiaryNameFormat || null,
        spaceDiaryTemplate || null
      );
      await this.host.journalSvc.upsertLinesToDiaryH1H2(today, r.h1, r.h2, [line, meta], { mode: "append" });
      const file = await this.host.journalSvc.ensureDailyNoteForDateKey(today);
      writtenDiaryPath = file?.path;
    } finally {
      // 恢复原来的覆盖设置
      this.host.journalSvc.setDiaryPathOverride(originalPathOverride, originalFormatOverride, originalTemplateOverride);
    }

    // WorkEvent：由 executionOrchestrator 在 UI 经 runExecutionFlow 写入
    return { uid, diaryPath: writtenDiaryPath };
  }

  /**
   * ✅ 查找已存在的联系人生日提醒（通过 contact_uid）
   */
  public async findContactBirthdayMemo(contactUid: string): Promise<RSLatteIndexItem | null> {
    await this.ensureReady();
    const idx = await this.store.readIndex("memo");
    const items = (idx.items ?? []) as RSLatteIndexItem[];
    
    for (const it of items) {
      if (it.archived) continue;
      if (it.itemType !== "memo") continue;
      const extra = (it as any).extra ?? {};
      const memoContactUid = String(extra.contact_uid ?? "").trim();
      if (memoContactUid === contactUid) {
        // 检查是否是生日提醒（有 yearly 重复规则，且是 lunarBirthday 或 solarBirthday）
        const rule = String(it.repeatRule ?? "").trim().toLowerCase();
        const cat = String(extra.cat ?? "").trim();
        if (rule === "yearly" && (cat === "lunarBirthday" || cat === "solarBirthday")) {
          return it;
        }
      }
    }
    return null;
  }

  public async findMemoByUid(memoUid: string): Promise<RSLatteIndexItem | null> {
    await this.ensureReady();
    const uid = String(memoUid ?? "").trim();
    if (!uid) return null;
    const idx = await this.store.readIndex("memo");
    const items = (idx.items ?? []) as RSLatteIndexItem[];
    const hit = items.find((it) => !it.archived && it.itemType === "memo" && String((it as any).uid ?? "").trim() === uid) ?? null;
    if (!hit) return null;
    const af = this.host.app.vault.getAbstractFileByPath(String(hit.filePath ?? "").trim());
    if (!(af instanceof TFile)) return null;
    return hit;
  }

  public async findTaskByUid(taskUid: string): Promise<RSLatteIndexItem | null> {
    await this.ensureReady();
    const uid = String(taskUid ?? "").trim();
    if (!uid) return null;
    const idx = await this.store.readIndex("task");
    const items = (idx.items ?? []) as RSLatteIndexItem[];
    const hit =
      items.find((it) => !it.archived && it.itemType === "task" && String((it as any).uid ?? "").trim() === uid) ?? null;
    if (!hit) return null;
    const af = this.host.app.vault.getAbstractFileByPath(String(hit.filePath ?? "").trim());
    if (!(af instanceof TFile)) return null;
    return hit;
  }

  /** 从 schedule-index 按 uid 查找日程条目（与 queryScheduleBuckets 数据源一致） */
  public async findScheduleByUid(scheduleUid: string): Promise<RSLatteIndexItem | null> {
    await this.ensureReady();
    const uid = String(scheduleUid ?? "").trim();
    if (!uid) return null;
    const idx = await this.store.readIndex("schedule");
    const rows = (idx.items ?? []) as RSLatteIndexItem[];
    const hit = rows.find((it) => !it.archived && String((it as any).uid ?? "").trim() === uid) ?? null;
    if (!hit) return null;
    const af = this.host.app.vault.getAbstractFileByPath(String(hit.filePath ?? "").trim());
    if (!(af instanceof TFile)) return null;
    return hit;
  }

  /**
   * 将日程 uid 追加写入任务 meta `linked_schedule_uids`（逗号分隔），并写入 `progress_updated` 为当前时间；不修改任务勾选行与状态。
   */
  public async appendLinkedScheduleUidToTask(
    it: Pick<RSLatteIndexItem, "filePath" | "lineNo" | "uid">,
    scheduleUid: string
  ): Promise<{ ok: boolean; changed: boolean; reason?: string }> {
    const filePath = String(it.filePath ?? "").trim();
    const taskUid = String((it as any).uid ?? "").trim();
    const su = String(scheduleUid ?? "").trim();
    if (!filePath || !taskUid || !su) return { ok: false, changed: false, reason: "missing filePath/taskUid/scheduleUid" };
    const hint = Number.isFinite(Number(it.lineNo)) ? Number(it.lineNo) : undefined;
    return appendLinkedScheduleUidToTaskMeta(this.host.app, filePath, taskUid, su, hint);
  }

  public async appendBirthMemoUidToContact(contactUid: string, memoUid: string, contactFilePath?: string): Promise<boolean> {
    await this.ensureReady();
    const uid = String(contactUid ?? "").trim();
    const memo = String(memoUid ?? "").trim();
    if (!uid || !memo) return false;

    let file: TFile | null = null;
    const directPath = normalizePath(String(contactFilePath ?? "").trim());
    if (directPath) {
      const af = this.host.app.vault.getAbstractFileByPath(directPath);
      if (af instanceof TFile) file = af;
    }
    if (!file) {
      try {
        const idx = await (this.host as any)?.contactsIndex?.getIndexStore?.().readIndex?.();
        const hit = (idx?.items ?? []).find((it: any) => String(it?.contact_uid ?? "").trim() === uid);
        const p = normalizePath(String(hit?.file_path ?? "").trim());
        if (p) {
          const af = this.host.app.vault.getAbstractFileByPath(p);
          if (af instanceof TFile) file = af;
        }
      } catch {
        // ignore
      }
    }
    if (!file) return false;

    try {
      await this.host.app.fileManager.processFrontMatter(file, (fm: any) => {
        const extra = (fm?.extra && typeof fm.extra === "object") ? { ...fm.extra } : {};
        const oldListRaw = (extra as any).birth_memo_uids;
        const listRaw = Array.isArray(oldListRaw)
          ? oldListRaw.map((x: any) => String(x ?? "").trim()).filter(Boolean)
          : String(oldListRaw ?? "").split(/[|,;\s]+/g).map((x) => x.trim()).filter(Boolean);
        const oldSingle = String((extra as any).birth_memo_uid ?? "").trim();
        if (oldSingle) listRaw.push(oldSingle);
        if (!listRaw.includes(memo)) listRaw.push(memo);
        const list = [...new Set(listRaw)];
        extra.birth_memo_uids = list;
        extra.birth_memo_uid = memo;
        extra.birthday_memo = true;
        fm.extra = extra;
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 按联系人 uid 取消其关联的提醒条目（仅取消未闭环条目）。
   */
  public async cancelMemosByContactUid(contactUid: string): Promise<number> {
    await this.ensureReady();
    const uid = String(contactUid ?? "").trim();
    if (!uid) return 0;
    const idx = await this.store.readIndex("memo");
    const items = (idx.items ?? []) as RSLatteIndexItem[];
    let changed = 0;
    for (const it of items) {
      if (it.archived || it.itemType !== "memo") continue;
      const extra = (it as any).extra ?? {};
      const memoUidRaw = String(extra.contact_uid ?? "").trim();
      const memoUidNorm = extractContactUidFromWikiTarget(memoUidRaw) || memoUidRaw.replace(/^C_/, "");
      if (!memoUidNorm || memoUidNorm !== uid) continue;
      const st = String((it as any).status ?? "").trim().toUpperCase();
      if (st === "DONE" || st === "CANCELLED") continue;
      await this.applyMemoStatusAction(it as any, "CANCELLED", { skipWorkEvent: true });
      changed += 1;
    }
    return changed;
  }

  public async invalidateMemosByUids(memoUids: string[]): Promise<number> {
    await this.ensureReady();
    const uids = [...new Set((memoUids ?? []).map((x) => String(x ?? "").trim()).filter(Boolean))];
    if (!uids.length) return 0;
    // 先刷新一次 memo 索引，避免刚写入/自动生成后的 uid 查找不到
    try {
      await this.refreshIndexAndSync({ sync: false, noticeOnError: false, modules: { memo: true } as any });
    } catch {
      // ignore
    }
    let changed = 0;
    for (const uid of uids) {
      const it = await this.findMemoByUid(uid);
      if (!it) continue;
      const st = String((it as any)?.status ?? "").trim().toUpperCase();
      // 仅处理“进行中”条目（对应 - [/]）；历史已完成/取消不强制改为失效
      if (st !== "IN_PROGRESS" && st !== "IN-PROGRESS") continue;
      const invalidated = String(((it as any)?.extra ?? {}).invalidated ?? "").trim() === "1";
      if (invalidated) continue;
      await this.setMemoInvalidated(it as any, true);
      changed += 1;
    }
    return changed;
  }

  /**
   * ✅ 创建或更新联系人生日提醒（支持农历和阳历）
   */
  public async createOrUpdateContactBirthdayMemo(opts: {
    contactUid: string;
    contactName: string;
    contactFile: string;
    birthdayType: "solar" | "lunar";
    month: number;
    day: number;
    leapMonth?: boolean;
    birthMemoUid?: string;
  }): Promise<string | undefined> {
    await this.ensureReady();
    const { contactUid, contactName, contactFile, birthdayType, month, day, leapMonth = false } = opts;
    
    if (!month || !day) return undefined;
    
    const today = todayYmd();
    const tsIso = momentFn().format("YYYY-MM-DDTHH:mm:ssZ");
    const contactRef = `[[C_${contactUid}|${contactName}]]`;
    const memoText = `${contactRef} 的${birthdayType === "solar" ? "阳历" : "农历"}生日`;
    
    let displayDate: string; // 显示在 📅 后面的日期（YYYY-MM-DD）
    let metaExtra: Record<string, string> = {
      contact_uid: contactUid,
      contact_file: contactFile,
      contact_name: contactName,
    };
    
    if (birthdayType === "lunar") {
      // 农历生日
      const lunarMmdd = `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const nextSolarDate = nextSolarDateForLunarBirthday(lunarMmdd, leapMonth, today);
      displayDate = nextSolarDate; // 显示下一次阳历日期
      
      metaExtra.cat = "lunarBirthday";
      metaExtra.date_type = "lunar";
      metaExtra.lunar = lunarMmdd;
      metaExtra.leap = leapMonth ? "1" : "0";
      metaExtra.next = nextSolarDate;
    } else {
      // 阳历生日：计算下一次阳历日期
      const thisYear = momentFn().year();
      const thisYearDate = momentFn({ year: thisYear, month: month - 1, day: day }).startOf("day");
      const todayMoment = momentFn(today, "YYYY-MM-DD").startOf("day");
      if (thisYearDate.isSameOrAfter(todayMoment)) {
        displayDate = thisYearDate.format("YYYY-MM-DD");
      } else {
        displayDate = momentFn({ year: thisYear + 1, month: month - 1, day: day }).format("YYYY-MM-DD");
      }
      
      metaExtra.cat = "solarBirthday";
      metaExtra.date_type = "solar";
      metaExtra.next = displayDate;
    }
    
    // v2: 强绑定联系人 frontmatter 中的 birth_memo_uid
    // - 有 uid：优先按 uid 找，找不到则新建
    // - 无 uid：按规则新建（不再按 contact_uid 回捞旧记录）
    const boundUid = String(opts.birthMemoUid ?? "").trim();
    const existingMemo = boundUid ? await this.findMemoByUid(boundUid) : null;
    
    if (existingMemo) {
      const st = String((existingMemo as any)?.status ?? "").trim().toUpperCase();
      if (st === "CANCELLED" || st === "DONE") {
        // 重新开启生日提醒时，先恢复状态，再覆盖最新内容与日期。
        await this.applyMemoStatusAction(existingMemo as any, "IN_PROGRESS", { skipWorkEvent: true });
      }
      // 更新现有提醒
      await this.updateMemoBasicInfo(
        existingMemo,
        {
          text: memoText,
          memoDate: displayDate, // YYYY-MM-DD 格式
          repeatRule: "yearly",
          metaExtra: metaExtra,
        }
      );
      const retUid = String((existingMemo as any)?.uid ?? "").trim() || boundUid || undefined;
      if (retUid) {
        await this.appendBirthMemoUidToContact(contactUid, retUid, contactFile);
      }
      return retUid;
    } else {
      // 创建新提醒
      const uid = `lg_${Math.random().toString(16).slice(2, 12)}`; // 10 hex chars
      const repToken = " 🔁 yearly";
      const line = `- [/] ${memoText} 📅 ${displayDate}${repToken} ➕ ${today}`;
      
      const extraParts: string[] = [];
      for (const [k0, v0] of Object.entries(metaExtra)) {
        const k = String(k0 ?? "").trim();
        if (!k) continue;
        const v = String(v0 ?? "").trim();
        if (!v) continue;
        // avoid breaking the rslatte meta parser (split by ';' and whitespace)
        const safeV = v.replace(/[;\s]+/g, "_");
        extraParts.push(`${k}=${safeV}`);
      }
      const meta = `  <!-- rslatte:uid=${uid};type=memo;ts=${tsIso};in_progress_time=${tsIso}${extraParts.length ? `;${extraParts.join(";")}` : ""} -->`;

      // ✅ 按"日志追加清单"配置写入日记（强制启用：提醒）
      const rules = (this.host.settingsRef().journalAppendRules ?? []) as any[];
      const r = (rules.find((x) => x.module === "memo") ?? { h1: "# 任务追踪", h2: "## 新增提醒" }) as any;
      // ✅ 获取当前空间的日记配置，确保写入到正确的空间日记
      const currentSpaceId = (this.host as any).getCurrentSpaceId?.() || "";
      const spaces = (this.host.settingsRef() as any).spaces || {};
      const currentSpace = spaces[currentSpaceId];
      const spaceSnapshot = currentSpace?.settingsSnapshot || {};
      const spaceDiaryPath = spaceSnapshot.diaryPath;
      const spaceDiaryNameFormat = spaceSnapshot.diaryNameFormat;
      const spaceDiaryTemplate = spaceSnapshot.diaryTemplate;
      
      // 临时设置日记配置覆盖（用于空间隔离）
      const originalPathOverride = (this.host.journalSvc as any)._diaryPathOverride;
      const originalFormatOverride = (this.host.journalSvc as any)._diaryNameFormatOverride;
      const originalTemplateOverride = (this.host.journalSvc as any)._diaryTemplateOverride;
      
      try {
        // 优先使用空间的配置，否则使用全局配置（null 表示使用全局设置）
        this.host.journalSvc.setDiaryPathOverride(
          spaceDiaryPath || null,
          spaceDiaryNameFormat || null,
          spaceDiaryTemplate || null
        );
        
        await this.host.journalSvc.upsertLinesToDiaryH1H2(today, r.h1, r.h2, [line, meta], { mode: "append" });
      } finally {
        // 恢复原来的覆盖设置
        this.host.journalSvc.setDiaryPathOverride(originalPathOverride, originalFormatOverride, originalTemplateOverride);
      }

      void this.host.workEventSvc?.append({
        ts: tsIso,
        kind: "memo",
        action: "create",
        source: "ui",
        ref: { uid, text: memoText, memo_date: displayDate, repeat_rule: "yearly", record_date: today, ...(metaExtra ? { meta_extra: metaExtra as any } : {}) },
        summary: `🗒 新建提醒 ${memoText}`,
        metrics: { memo_date: displayDate, repeat_rule: "yearly" },
      });
      await this.appendBirthMemoUidToContact(contactUid, uid, contactFile);
      return uid;
    }
  }

  public async createTodayMemo(
    text: string,
    dateOrMmdd: string,
    repeatRule?: string,
    metaExtra?: Record<string, string | number | boolean | undefined | null>
  ): Promise<string | undefined> {
    // const tp = this.tp;
    const t = (text ?? "").trim();
    if (!t) return undefined;

    const today = todayYmd();
    const d = (dateOrMmdd ?? "").trim();
    if (!d) return undefined;

    const isMmdd = /^\d{2}-\d{2}$/.test(d);
    const isYmd = /^\d{4}-\d{2}-\d{2}$/.test(d);
    if (!isMmdd && !isYmd) return undefined;

    const repeat = (repeatRule ?? "").trim().toLowerCase();
    const allowed = new Set(["none", "weekly", "monthly", "quarterly", "yearly"]);
    const rr = allowed.has(repeat) ? repeat : "none";
    const repToken = rr !== "none" ? ` 🔁 ${rr}` : "";
    // v2: create with uid + next-line meta comment (do NOT insert legacy inline comment)
    const uid = `lg_${Math.random().toString(16).slice(2, 12)}`; // 10 hex chars
    const line = `- [/] ${t} 📅 ${d}${repToken} ➕ ${today}`;
    const tsIso = momentFn().format("YYYY-MM-DDTHH:mm:ssZ");
    const extraParts: string[] = [];
    for (const [k0, v0] of Object.entries(metaExtra ?? {})) {
      const k = String(k0 ?? "").trim();
      if (!k) continue;
      const v = v0 as any;
      if (v === undefined || v === null) continue;
      const sv = typeof v === "boolean" ? (v ? "1" : "0") : String(v).trim();
      if (!sv) continue;
      // avoid breaking the rslatte meta parser (split by ';' and whitespace)
      const safeV = sv.replace(/[;\s]+/g, "_");
      extraParts.push(`${k}=${safeV}`);
    }
    const meta = `  <!-- rslatte:uid=${uid};type=memo;ts=${tsIso};in_progress_time=${tsIso}${extraParts.length ? `;${extraParts.join(";")}` : ""} -->`;

    // ✅ 按“日志追加清单”配置写入日记（强制启用：提醒）
    const rules = (this.host.settingsRef().journalAppendRules ?? []) as any[];
    const r = (rules.find((x) => x.module === "memo") ?? { h1: "# 任务追踪", h2: "## 新增提醒" }) as any;
    // ✅ 获取当前空间的日记配置，确保写入到正确的空间日记
    const currentSpaceId = (this.host as any).getCurrentSpaceId?.() || "";
    const spaces = (this.host.settingsRef() as any).spaces || {};
    const currentSpace = spaces[currentSpaceId];
    const spaceSnapshot = currentSpace?.settingsSnapshot || {};
    const spaceDiaryPath = spaceSnapshot.diaryPath;
    const spaceDiaryNameFormat = spaceSnapshot.diaryNameFormat;
    const spaceDiaryTemplate = spaceSnapshot.diaryTemplate;
    
    // 临时设置日记配置覆盖（用于空间隔离）
    const originalPathOverride = (this.host.journalSvc as any)._diaryPathOverride;
    const originalFormatOverride = (this.host.journalSvc as any)._diaryNameFormatOverride;
    const originalTemplateOverride = (this.host.journalSvc as any)._diaryTemplateOverride;
    
    try {
      // 优先使用空间的配置，否则使用全局配置（null 表示使用全局设置）
      this.host.journalSvc.setDiaryPathOverride(
        spaceDiaryPath || null,
        spaceDiaryNameFormat || null,
        spaceDiaryTemplate || null
      );
      
      await this.host.journalSvc.upsertLinesToDiaryH1H2(today, r.h1, r.h2, [line, meta], { mode: "append" });
    } finally {
      // 恢复原来的覆盖设置
      this.host.journalSvc.setDiaryPathOverride(originalPathOverride, originalFormatOverride, originalTemplateOverride);
    }

    // WorkEvent：由 executionOrchestrator（经 runExecutionFlow）写入
    return uid;
  }

  public async createScheduleMemo(opts: ScheduleCreateInput): Promise<string | undefined> {
    const text = String(opts?.text ?? "").trim();
    const scheduleDate = String(opts?.scheduleDate ?? "").trim();
    const startTime = String(opts?.startTime ?? "").trim();
    const durationMin = Math.max(5, Math.min(24 * 60, Math.floor(Number(opts?.durationMin ?? 60))));
    if (!text || !this.isYmd(scheduleDate) || !/^\d{2}:\d{2}$/.test(startTime)) return undefined;

    const start = momentFn(`${scheduleDate} ${startTime}`, "YYYY-MM-DD HH:mm");
    if (!start?.isValid?.()) return undefined;
    const end = start.clone().add(durationMin, "minutes");
    const endTime = end.format("HH:mm");
    const timePrefix = `${startTime}-${endTime}`;
    const lineText = `${timePrefix} ${text}`.trim();
    const repeat = String(opts?.repeatRule ?? "none").trim().toLowerCase();
    const allowed = new Set(["none", "weekly", "monthly", "quarterly", "yearly"]);
    const rr = allowed.has(repeat) ? repeat : "none";

    const uid = `lg_${Math.random().toString(16).slice(2, 12)}`;
    const repToken = rr !== "none" ? ` 🔁 ${rr}` : "";
    const createdYmd = todayYmd();
    const line = `- [/] ${lineText} 📅 ${scheduleDate}${repToken} ➕ ${createdYmd}`;
    const tsIso = momentFn().format("YYYY-MM-DDTHH:mm:ssZ");
    const sm = (this.host.settingsRef() as any)?.scheduleModule;
    const fallbackId = getDefaultScheduleCategoryId(sm);
    const category =
      sanitizeScheduleCategoryIdForMeta(String(opts?.category ?? "").trim()) || fallbackId;
    const linkedTaskRaw = String(opts?.linkedTaskUid ?? "").trim();
    const linkedTaskSafe = linkedTaskRaw.replace(/[;\s]+/g, "_");
    const linkedMeta = linkedTaskSafe ? `;linked_task_uid=${linkedTaskSafe}` : "";
    const linkedOutRaw = String(opts?.linkedOutputId ?? "").trim();
    const linkedOutSafe = linkedOutRaw.replace(/[;\s]+/g, "_");
    const linkedOutMeta = linkedOutSafe ? `;linked_output_id=${linkedOutSafe}` : "";
    const timerLogRaw = String(opts?.timerLog ?? "").trim();
    const timerLogEncoded = timerLogRaw ? encodeURIComponent(timerLogRaw) : "";
    const timerMeta = timerLogEncoded ? `;timer_log=${timerLogEncoded}` : "";
    const meta = `  <!-- rslatte:uid=${uid};type=schedule;ts=${tsIso};schedule_category=${category};schedule_date=${scheduleDate};start_time=${startTime};end_time=${endTime};duration_min=${durationMin}${linkedMeta}${linkedOutMeta}${timerMeta} -->`;

    const rules = (this.host.settingsRef().journalAppendRules ?? []) as any[];
    const r = (rules.find((x) => x.module === "schedule")
      ?? { h1: "# 任务追踪", h2: "## 新增日程" }) as any;
    const currentSpaceId = (this.host as any).getCurrentSpaceId?.() || "";
    const spaces = (this.host.settingsRef() as any).spaces || {};
    const currentSpace = spaces[currentSpaceId];
    const spaceSnapshot = currentSpace?.settingsSnapshot || {};
    const spaceDiaryPath = spaceSnapshot.diaryPath;
    const spaceDiaryNameFormat = spaceSnapshot.diaryNameFormat;
    const spaceDiaryTemplate = spaceSnapshot.diaryTemplate;

    const originalPathOverride = (this.host.journalSvc as any)._diaryPathOverride;
    const originalFormatOverride = (this.host.journalSvc as any)._diaryNameFormatOverride;
    const originalTemplateOverride = (this.host.journalSvc as any)._diaryTemplateOverride;
    try {
      this.host.journalSvc.setDiaryPathOverride(spaceDiaryPath || null, spaceDiaryNameFormat || null, spaceDiaryTemplate || null);
      await this.host.journalSvc.upsertLinesToDiaryH1H2(scheduleDate, r.h1, r.h2, [line, meta], { mode: "append" });
    } finally {
      this.host.journalSvc.setDiaryPathOverride(originalPathOverride, originalFormatOverride, originalTemplateOverride);
    }

    // WorkEvent：由 executionOrchestrator（经 runExecutionFlow）写入
    return uid;
  }

  /**
   * 合并写入匹配 uid 的 rslatte meta 行（日程结束后的 followup_* 等；任务/提醒条目不必回写日程）。
   */
  public async patchMemoRslatteMetaByUid(
    it: Pick<RSLatteIndexItem, "filePath" | "lineNo" | "uid">,
    patch: Record<string, string>
  ): Promise<void> {
    const filePath = normalizePath(String(it.filePath ?? "").trim());
    const uid = String((it as any).uid ?? "").trim();
    if (!filePath || !uid) throw new Error("缺少 filePath 或 uid");
    const safe: Record<string, string> = {};
    for (const [k, v] of Object.entries(patch ?? {})) {
      const kk = String(k ?? "").trim();
      if (!kk) continue;
      const sv = String(v ?? "").trim().replace(/[;\s]+/g, "_");
      if (!sv) continue;
      safe[kk] = sv;
    }
    if (Object.keys(safe).length === 0) return;
    const idx = Number((it as any).lineNo ?? -1);
    const r = await writeBackMetaIdByUid(this.host.app, filePath, uid, safe, idx >= 0 ? idx : undefined);
    if (!r.ok) throw new Error(r.reason ?? "meta 写入失败");
  }

  /**
   * 更新已有日程行与下一行 meta（与 createScheduleMemo 格式一致）。
   * 若修改了 schedule_date，则从原日记文件删除该条目并追加到新日期对应日记（与新增日程相同的 H1/H2 规则）。
   */
  public async updateScheduleBasicInfo(
    it: Pick<RSLatteIndexItem, "filePath" | "lineNo" | "uid" | "text" | "raw">,
    patch: {
      text: string;
      scheduleDate: string;
      startTime: string;
      durationMin: number;
      category: string;
      repeatRule: string;
    },
    opts?: { skipWorkEvent?: boolean }
  ): Promise<void> {
    const filePath = normalizePath(String(it.filePath ?? "").trim());
    const uid = String((it as any).uid ?? "").trim();
    if (!filePath || !uid) throw new Error("缺少 filePath 或 uid");

    const text = String(patch.text ?? "").trim();
    const scheduleDate = String(patch.scheduleDate ?? "").trim();
    const startTime = String(patch.startTime ?? "").trim();
    const durationMin = Math.max(5, Math.min(24 * 60, Math.floor(Number(patch.durationMin ?? 60))));
    if (!text) throw new Error("日程描述不能为空");
    if (!this.isYmd(scheduleDate)) throw new Error("日期须为 YYYY-MM-DD");
    if (!/^\d{2}:\d{2}$/.test(startTime)) throw new Error("开始时间须为 HH:mm");

    const sm = (this.host.settingsRef() as any)?.scheduleModule;
    const category =
      sanitizeScheduleCategoryIdForMeta(String(patch.category ?? "").trim()) || getDefaultScheduleCategoryId(sm);

    const repeat = String(patch.repeatRule ?? "none").trim().toLowerCase();
    const allowed = new Set(["none", "weekly", "monthly", "quarterly", "yearly"]);
    const rr = allowed.has(repeat) ? repeat : "none";

    const start = momentFn(`${scheduleDate} ${startTime}`, "YYYY-MM-DD HH:mm");
    if (!start?.isValid?.()) throw new Error("开始时间无效");
    const end = start.clone().add(durationMin, "minutes");
    const endTime = end.format("HH:mm");
    const timePrefix = `${startTime}-${endTime}`;
    const lineText = `${timePrefix} ${text}`.trim();
    const repToken = rr !== "none" ? ` 🔁 ${rr}` : "";

    const af = this.host.app.vault.getAbstractFileByPath(filePath);
    if (!af || !(af instanceof TFile)) throw new Error("file not found");

    const content = await this.host.app.vault.read(af);
    const lines = (content ?? "").split(/\r?\n/);

    const findLineIdxByUid = (): number | null => {
      if (!uid) return null;
      for (let i = 0; i < lines.length; i++) {
        if (!metaLineHasUid(lines[i], uid)) continue;
        const idx = i - 1;
        if (idx >= 0 && lines[idx] && /^\s*-\s*\[.\]\s+/.test(lines[idx])) return idx;
      }
      const ln = Number((it as any).lineNo ?? -1);
      if (ln >= 0 && ln < lines.length) return ln;
      return null;
    };

    const parseMetaKv = (metaLine: string): Record<string, string> => {
      const m = metaLine.match(/^\s*<!--\s*rslatte:([^>]*)-->\s*$/i);
      if (!m) return {};
      const raw = String(m[1] ?? "").trim();
      const parts = raw.split(/[;\s]+/).map((x) => x.trim()).filter(Boolean);
      const kv: Record<string, string> = {};
      for (const p of parts) {
        const mm = p.match(/^([A-Za-z0-9_\-:]+)=(.+)$/);
        if (!mm) continue;
        kv[mm[1].trim()] = mm[2].trim();
      }
      return kv;
    };

    const idx = findLineIdxByUid();
    if (idx == null) throw new Error("未找到日程行");
    const metaIdx = idx + 1;
    if (metaIdx >= lines.length || !/^\s*<!--\s*rslatte:/i.test(lines[metaIdx] ?? "")) {
      throw new Error("未找到日程 meta 行");
    }
    const oldKv = parseMetaKv(lines[metaIdx]);
    const typeOk = String(oldKv.type ?? "").trim().toLowerCase() === "schedule";
    const catOk = String(oldKv.cat ?? "").trim().toLowerCase() === "schedule";
    const sd0 = String(oldKv.schedule_date ?? "").trim();
    const st0 = String(oldKv.start_time ?? "").trim();
    /** 与 createScheduleMemo 一致的日程 meta 形态（兼容曾误写 cat=generalReminder 等混合行） */
    const metaLooksLikeSchedule =
      /^\d{4}-\d{2}-\d{2}$/.test(sd0) && /^\d{1,2}:\d{2}$/.test(st0);
    const exIt = ((it as any)?.extra ?? {}) as Record<string, string>;
    const indexLooksLikeSchedule =
      String(exIt.type ?? "").trim().toLowerCase() === "schedule" ||
      String(exIt.cat ?? "").trim().toLowerCase() === "schedule" ||
      (/^\d{4}-\d{2}-\d{2}$/.test(String(exIt.schedule_date ?? "").trim()) &&
        /^\d{1,2}:\d{2}$/.test(String(exIt.start_time ?? "").trim()));
    if (!typeOk && !catOk && !metaLooksLikeSchedule && !indexLooksLikeSchedule) {
      throw new Error("该条目不是日程（meta 需含 type=schedule，或旧版 cat=schedule，或 schedule_date+start_time）");
    }

    const oldScheduleDate = String(oldKv.schedule_date ?? (it as any).memoDate ?? "").trim();
    const linkedTaskRaw = String(oldKv.linked_task_uid ?? "").trim();
    const linkedMeta = linkedTaskRaw ? `;linked_task_uid=${linkedTaskRaw.replace(/[;\s]+/g, "_")}` : "";
    const followSegs: string[] = [];
    const fuTk = String(oldKv.followup_task_uid ?? "").trim();
    const fuMk = String(oldKv.followup_memo_uid ?? "").trim();
    const fuTid = String(oldKv.followup_task_tid ?? "").trim();
    const fuMid = String(oldKv.followup_memo_mid ?? "").trim();
    const fuSch = String(oldKv.followup_schedule_uid ?? "").trim();
    const fuSchTid = String(oldKv.followup_schedule_tid ?? "").trim();
    const san = (s: string) => s.replace(/[;\s]+/g, "_");
    if (fuTk) followSegs.push(`followup_task_uid=${san(fuTk)}`);
    if (fuMk) followSegs.push(`followup_memo_uid=${san(fuMk)}`);
    if (fuTid) followSegs.push(`followup_task_tid=${san(fuTid)}`);
    if (fuMid) followSegs.push(`followup_memo_mid=${san(fuMid)}`);
    if (fuSch) followSegs.push(`followup_schedule_uid=${san(fuSch)}`);
    if (fuSchTid) followSegs.push(`followup_schedule_tid=${san(fuSchTid)}`);
    const followMeta = followSegs.length ? `;${followSegs.join(";")}` : "";

    const oldLine = lines[idx] ?? "";
    const lmm = oldLine.match(/^\s*(-\s*)\[(.)\]\s*(.*)$/);
    if (!lmm) throw new Error("invalid schedule line");
    const dashPart = lmm[1] ?? "- ";
    const mark = lmm[2] ?? "/";

    const plusM = /\s➕\s*(\d{4}-\d{2}-\d{2})/.exec(String(oldLine));
    const createdYmd = (plusM && plusM[1]) ? plusM[1] : todayYmd();

    const newLine = `${dashPart}[${mark}] ${lineText} 📅 ${scheduleDate}${repToken} ➕ ${createdYmd}`.replace(/\s{2,}/g, " ").trimEnd();
    const tsIso = nowIso();
    const meta = `  <!-- rslatte:uid=${uid};type=schedule;ts=${tsIso};schedule_category=${category};schedule_date=${scheduleDate};start_time=${startTime};end_time=${endTime};duration_min=${durationMin};updated_time=${tsIso}${linkedMeta}${followMeta} -->`;

    const rules = (this.host.settingsRef().journalAppendRules ?? []) as any[];
    const r = (rules.find((x) => x.module === "schedule") ?? { h1: "# 任务追踪", h2: "## 新增日程" }) as any;

    const currentSpaceId = (this.host as any).getCurrentSpaceId?.() || "";
    const spaces = (this.host.settingsRef() as any).spaces || {};
    const currentSpace = spaces[currentSpaceId];
    const spaceSnapshot = currentSpace?.settingsSnapshot || {};
    const spaceDiaryPath = spaceSnapshot.diaryPath;
    const spaceDiaryNameFormat = spaceSnapshot.diaryNameFormat;
    const spaceDiaryTemplate = spaceSnapshot.diaryTemplate;

    const originalPathOverride = (this.host.journalSvc as any)._diaryPathOverride;
    const originalFormatOverride = (this.host.journalSvc as any)._diaryNameFormatOverride;
    const originalTemplateOverride = (this.host.journalSvc as any)._diaryTemplateOverride;

    try {
      this.host.journalSvc.setDiaryPathOverride(spaceDiaryPath || null, spaceDiaryNameFormat || null, spaceDiaryTemplate || null);

      if (oldScheduleDate && scheduleDate !== oldScheduleDate) {
        lines.splice(idx, 2);
        await this.host.app.vault.modify(af, lines.join("\n"));
        await this.host.journalSvc.upsertLinesToDiaryH1H2(scheduleDate, r.h1, r.h2, [newLine, meta], { mode: "append" });
      } else {
        lines[idx] = newLine;
        lines[metaIdx] = meta;
        await this.host.app.vault.modify(af, lines.join("\n"));
      }
    } finally {
      this.host.journalSvc.setDiaryPathOverride(originalPathOverride, originalFormatOverride, originalTemplateOverride);
    }

    if (!opts?.skipWorkEvent) {
      try {
        void this.host.workEventSvc?.append({
          ts: tsIso,
          kind: "schedule",
          action: "update",
          source: "ui",
          ref: { uid, file_path: filePath, line_no: idx, category: "schedule" },
          summary: `✏️ 修改日程 ${text.length > 80 ? text.slice(0, 80) + "…" : text}`,
          metrics: { scheduleDate, repeatRule: rr, category: "schedule" },
        } as any);
      } catch {
        // ignore
      }
    }
  }

  public async queryScheduleBuckets(opts?: {
    upcomingDays?: number;
    recentClosedDays?: number;
  }): Promise<{
    todayFocus: RSLatteIndexItem[];
    upcoming: RSLatteIndexItem[];
    overdue: RSLatteIndexItem[];
    activeOther: RSLatteIndexItem[];
    recentClosed: RSLatteIndexItem[];
  }> {
    await this.ensureReady();
    const schedIdx = await this.store.readIndex("schedule");
    const items = (schedIdx.items ?? []) as RSLatteIndexItem[];
    const upcomingDays = Math.max(1, Math.min(30, Number(opts?.upcomingDays ?? 5) || 5));
    const recentClosedDays = Math.max(7, Math.min(100, Number(opts?.recentClosedDays ?? 30) || 30));
    const today = todayYmd();
    const dayMs = 24 * 60 * 60 * 1000;
    const toUtcDay = (ymd: string): number | null => {
      const m = String(ymd ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return null;
      return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    };
    const getScheduleDate = (it: RSLatteIndexItem): string => {
      const extra = ((it as any)?.extra ?? {}) as Record<string, string>;
      const fromExtra = String(extra.schedule_date ?? "").trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(fromExtra)) return fromExtra;
      return String((it as any)?.memoDate ?? "").trim();
    };
    const diffDays = (targetYmd: string): number | null => {
      const a = toUtcDay(today);
      const b = toUtcDay(targetYmd);
      if (a == null || b == null) return null;
      return Math.floor((b - a) / dayMs);
    };
    const getStartTime = (it: RSLatteIndexItem): string => {
      const t = String(((it as any)?.extra ?? {})?.start_time ?? "").trim();
      return /^\d{2}:\d{2}$/.test(t) ? t : "99:99";
    };
    const dueStartSort = (a: RSLatteIndexItem, b: RSLatteIndexItem): number => {
      const da = getScheduleDate(a);
      const db = getScheduleDate(b);
      const cmpDate = da.localeCompare(db);
      if (cmpDate !== 0) return cmpDate;
      return getStartTime(a).localeCompare(getStartTime(b));
    };
    const closeTime = (it: RSLatteIndexItem): number => {
      const extra = ((it as any)?.extra ?? {}) as Record<string, string>;
      const done = String((it as any)?.done_date ?? "").trim();
      const cancelled = String((it as any)?.cancelled_date ?? "").trim();
      const invalidated = String(extra.invalidated_date ?? "").trim();
      const c = done || cancelled || invalidated;
      const u = toUtcDay(c);
      return u == null ? 0 : u;
    };

    const todayFocus: RSLatteIndexItem[] = [];
    const upcoming: RSLatteIndexItem[] = [];
    const overdue: RSLatteIndexItem[] = [];
    const activeOther: RSLatteIndexItem[] = [];
    const recentClosed: RSLatteIndexItem[] = [];
    for (const it of items) {
      if (it.archived) continue;
      const itemType = String((it as any)?.itemType ?? "").trim();
      if (itemType !== "memo" && itemType !== "schedule") continue;
      const extra = ((it as any)?.extra ?? {}) as Record<string, string>;
      if (!isScheduleMemoLine(it as any)) continue;
      const status = String((it as any)?.status ?? "").trim().toUpperCase();
      const invalidated = String(extra.invalidated ?? "").trim() === "1";
      const dateYmd = getScheduleDate(it);
      const dd = diffDays(dateYmd);
      const closedYmd = String((it as any)?.done_date ?? "").trim()
        || String((it as any)?.cancelled_date ?? "").trim()
        || String(extra.invalidated_date ?? "").trim()
        || (invalidated ? String((it as any)?.updated_date ?? "").trim() : "");
      const closedDiff = diffDays(closedYmd);
      if ((status === "DONE" || status === "CANCELLED" || invalidated) && closedDiff != null && closedDiff <= 0 && Math.abs(closedDiff) <= recentClosedDays) {
        recentClosed.push(it);
        continue;
      }
      if (status === "DONE" || status === "CANCELLED" || invalidated) continue;
      if (dd === 0) todayFocus.push(it);
      else if (dd != null && dd > 0 && dd <= upcomingDays) upcoming.push(it);
      else if (dd != null && dd < 0) overdue.push(it);
      else activeOther.push(it);
    }

    todayFocus.sort(dueStartSort);
    upcoming.sort(dueStartSort);
    overdue.sort(dueStartSort);
    activeOther.sort(dueStartSort);
    recentClosed.sort((a, b) => closeTime(b) - closeTime(a));
    return { todayFocus, upcoming, overdue, activeOther, recentClosed };
  }

  // =========================
  // Important memos (today + N days)
  // =========================

  public async listImportantMemos(lookaheadDays: number): Promise<RSLatteIndexItem[]> {
    await this.ensureReady();

    // read memo index; if empty, try a lightweight scan to populate
    let idx = await this.store.readIndex("memo");
    if (!(idx.items ?? []).length) {
      await this.refreshIndexAndSync({ sync: false });
      idx = await this.store.readIndex("memo");
    }

    const items = idx.items ?? [];
    const today = momentFn().startOf("day");
    const end = today.clone().add(Math.max(0, lookaheadDays), "days");

    const out: RSLatteIndexItem[] = [];

    for (const it of items) {
      if (it.archived) continue;
      if (it.status === "DONE" || it.status === "CANCELLED") continue;
      if (isScheduleMemoLine(it)) continue;

      const extra: Record<string, string> = (it as any).extra ?? {};
      if (String(extra["invalidated"] ?? "").trim() === "1") continue;

      // memo scheduling
      let rule = String(it.repeatRule || "").trim().toLowerCase();
      if (!rule) rule = (it.memoMmdd ? "yearly" : "none");
      const allowed = new Set(["none", "weekly", "monthly", "quarterly", "yearly"]);
      const rr = allowed.has(rule) ? rule : "none";

      const metaNext = String(extra["next"] ?? "").trim();
      const isLunar = String(extra["cat"] ?? "").trim() === "lunarBirthday" || String(extra["date_type"] ?? "").trim() === "lunar";

      let nextYmd: string | null = null;
      if (isLunar) {
        const lunarMmdd = String(extra["lunar"] ?? it.memoMmdd ?? "").trim();
        const leap = String(extra["leap"] ?? "").trim() === "1";
        if (/^\d{2}-\d{2}$/.test(lunarMmdd)) {
          nextYmd = nextSolarDateForLunarBirthday(lunarMmdd, leap, today.format("YYYY-MM-DD"));
        }
      } else {
        // base date: meta next > memoDate > memoMmdd
        let baseYmd = this.isYmd(metaNext) ? metaNext : (this.isYmd(it.memoDate) ? String(it.memoDate) : "");
        if (!baseYmd && it.memoMmdd && /^\d{2}-\d{2}$/.test(it.memoMmdd)) {
          const [mm, dd] = it.memoMmdd.split("-").map((x) => Number(x));
          const base = momentFn({ year: today.year(), month: mm - 1, day: 1 }).startOf("day");
          const dim = base.daysInMonth();
          base.date(Math.min(dd, dim));
          baseYmd = base.format("YYYY-MM-DD");
        }
        if (this.isYmd(baseYmd)) {
          nextYmd = this.computeNextByRepeat(baseYmd, rr, today.format("YYYY-MM-DD"), it.memoMmdd);
        }
      }

      if (!nextYmd || !this.isYmd(nextYmd)) continue;
      const next = momentFn(nextYmd, "YYYY-MM-DD").startOf("day");
      if (next.isBefore(today)) continue;
      if (next.isAfter(end)) continue;

      out.push({ ...it, memoDate: next.format("YYYY-MM-DD") });
    }

    // sort by memoDate asc
    out.sort((a, b) => String(a.memoDate || "").localeCompare(String(b.memoDate || "")));
    return out;
  }

  /**
   * v28：全量提醒清单（用于侧边栏管理）
   * - 返回过滤后的总数 total
   * - items 为最多 maxItems 条（按 memoDate/next 升序）
   */
  public async queryAllMemosWithTotal(opts: {
    maxItems: number;
    statuses: Array<"DONE" | "CANCELLED" | "TODO" | "IN_PROGRESS">;
  }): Promise<{ items: RSLatteIndexItem[]; total: number }> {
    await this.ensureReady();

    const maxItems = Math.max(1, Math.min(200, Math.floor(Number(opts?.maxItems ?? 50))));
    const stSet = new Set(
      (Array.isArray(opts?.statuses) ? opts.statuses : ["TODO", "IN_PROGRESS"])
        .map((x) => String(x || "").trim().toUpperCase())
        .filter(Boolean)
    );
    if (stSet.size === 0) stSet.add("TODO");

    let idx = await this.store.readIndex("memo");
    if (!(idx.items ?? []).length) {
      await this.refreshIndexAndSync({ sync: false });
      idx = await this.store.readIndex("memo");
    }

    const items = (idx.items ?? []) as RSLatteIndexItem[];
    const today = todayYmd();

    const mapped: Array<{ it: RSLatteIndexItem; sortKey: string }> = [];

    for (const it of items) {
      if ((it as any).archived) continue;
      if (String((it as any)?.extra?.invalidated ?? "").trim() === "1") continue;
      if (isScheduleMemoLine(it)) continue;
      const st = String((it as any).status ?? "").trim().toUpperCase();
      if (!stSet.has(st as any)) continue;

      // pick a date for ordering:
      // - open memos: next (memoDate / meta next)
      // - closed memos: done/cancelled date if available, else fallback
      const anyIt: any = it as any;
      const extra: Record<string, string> = (anyIt.extra ?? {}) as any;

      let pick = "";
      if (st === "DONE") pick = String(anyIt.done_date ?? "");
      else if (st === "CANCELLED") pick = String(anyIt.cancelled_date ?? "");

      // open / fallback
      if (!this.isYmd(pick)) {
        const metaNext = String(extra["next"] ?? "").trim();
        pick = this.isYmd(metaNext)
          ? metaNext
          : (this.isYmd(String(anyIt.memoDate ?? "")) ? String(anyIt.memoDate) : "");

        // if still empty but mmdd exists (non-lunar), compute next by repeat
        if (!this.isYmd(pick) && /^\d{2}-\d{2}$/.test(String(anyIt.memoMmdd ?? "").trim())) {
          const mmdd = String(anyIt.memoMmdd).trim();
          let rr = String(anyIt.repeatRule ?? "").trim().toLowerCase();
          if (!rr) rr = "yearly";
          const allowed = new Set(["none", "weekly", "monthly", "quarterly", "yearly"]);
          rr = allowed.has(rr) ? rr : "none";
          pick = this.computeNextByRepeat(`${today.slice(0, 4)}-${mmdd}`, rr, today, mmdd);
        }
      }

      const sortKey = this.isYmd(pick) ? pick : "9999-99-99";
      mapped.push({ it: { ...it, memoDate: this.isYmd(pick) ? pick : (anyIt.memoDate ?? anyIt.memoMmdd) }, sortKey });
    }

    mapped.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    const total = mapped.length;
    const out = mapped.slice(0, maxItems).map((x) => x.it);
    return { items: out, total };
  }

  public async queryReminderBuckets(opts?: {
    upcomingDays?: number;
    recentClosedDays?: number;
  }): Promise<{
    todayFocus: RSLatteIndexItem[];
    overdue: RSLatteIndexItem[];
    activeOther: RSLatteIndexItem[];
    recentClosed: RSLatteIndexItem[];
  }> {
    await this.ensureReady();
    let idx = await this.store.readIndex("memo");
    if (!(idx.items ?? []).length) {
      await this.refreshIndexAndSync({ sync: false });
      idx = await this.store.readIndex("memo");
    }
    const items = (idx.items ?? []) as RSLatteIndexItem[];
    const upcomingDays = Math.max(1, Math.min(30, Number(opts?.upcomingDays ?? 5) || 5));
    const recentClosedDays = Math.max(7, Math.min(100, Number(opts?.recentClosedDays ?? 30) || 30));
    const today = todayYmd();
    const dayMs = 24 * 60 * 60 * 1000;
    const toUtcDay = (ymd: string): number | null => {
      const m = String(ymd ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return null;
      return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    };
    const diffDays = (targetYmd: string): number | null => {
      const a = toUtcDay(today);
      const b = toUtcDay(targetYmd);
      if (a == null || b == null) return null;
      return Math.floor((b - a) / dayMs);
    };
    const createdTime = (it: RSLatteIndexItem): number => {
      const c = String((it as any)?.created_date ?? "").trim();
      const u = toUtcDay(c);
      return u == null ? Number.MAX_SAFE_INTEGER : u;
    };
    const dueTime = (it: RSLatteIndexItem): number => {
      const d = String((it as any)?.memoDate ?? "").trim();
      const u = toUtcDay(d);
      return u == null ? Number.MAX_SAFE_INTEGER : u;
    };
    const closeTime = (it: RSLatteIndexItem): number => {
      const extra = ((it as any)?.extra ?? {}) as Record<string, string>;
      const done = String((it as any)?.done_date ?? "").trim();
      const cancelled = String((it as any)?.cancelled_date ?? "").trim();
      const invalidated = String(extra.invalidated_date ?? "").trim();
      const c = done || cancelled || invalidated;
      const u = toUtcDay(c);
      return u == null ? 0 : u;
    };

    const todayFocus: RSLatteIndexItem[] = [];
    const overdue: RSLatteIndexItem[] = [];
    const activeOther: RSLatteIndexItem[] = [];
    const recentClosed: RSLatteIndexItem[] = [];

    for (const it of items) {
      if (it.archived || it.itemType !== "memo") continue;
      if (isScheduleMemoLine(it)) continue;
      const extra = ((it as any)?.extra ?? {}) as Record<string, string>;
      const status = String((it as any)?.status ?? "").trim().toUpperCase();
      const invalidated = String(extra.invalidated ?? "").trim() === "1";
      const dateYmd = String((it as any)?.memoDate ?? "").trim();
      const dd = diffDays(dateYmd);

      // 近期完成/取消/失效
      const closedYmd = String((it as any)?.done_date ?? "").trim()
        || String((it as any)?.cancelled_date ?? "").trim()
        || String(extra.invalidated_date ?? "").trim()
        || (invalidated ? String((it as any)?.updated_date ?? "").trim() : "")
        || (invalidated ? String((it as any)?.created_date ?? "").trim() : "");
      const closedDiff = diffDays(closedYmd);
      if ((status === "DONE" || status === "CANCELLED" || invalidated) && closedDiff != null && closedDiff <= 0 && Math.abs(closedDiff) <= recentClosedDays) {
        recentClosed.push(it);
        continue;
      }

      // 仅活跃提醒参与以下三组
      if (status === "DONE" || status === "CANCELLED" || invalidated) continue;

      if (dd != null && dd < 0) {
        overdue.push(it);
      } else if (dd != null && dd >= 0 && dd <= upcomingDays) {
        todayFocus.push(it);
      } else {
        activeOther.push(it);
      }
    }

    // 今日关注：先今日，再即将到期；同组按创建时间升序
    const todayItems = todayFocus.filter((x) => diffDays(String((x as any)?.memoDate ?? "").trim()) === 0).sort((a, b) => createdTime(a) - createdTime(b));
    const upcomingItems = todayFocus.filter((x) => {
      const d = diffDays(String((x as any)?.memoDate ?? "").trim());
      return d != null && d > 0 && d <= upcomingDays;
    }).sort((a, b) => createdTime(a) - createdTime(b));

    overdue.sort((a, b) => dueTime(a) - dueTime(b));
    activeOther.sort((a, b) => dueTime(a) - dueTime(b));
    recentClosed.sort((a, b) => closeTime(b) - closeTime(a));

    return {
      todayFocus: [...todayItems, ...upcomingItems],
      overdue,
      activeOther,
      recentClosed,
    };
  }

  public async setMemoInvalidated(
    it: Pick<RSLatteIndexItem, "filePath" | "lineNo" | "uid" | "text" | "raw">,
    invalidated: boolean
  ): Promise<void> {
    const filePath = String(it.filePath ?? "");
    const uid = String((it as any).uid ?? "").trim();
    if (!filePath || !uid) throw new Error("missing filePath/uid");

    const af = this.host.app.vault.getAbstractFileByPath(filePath);
    if (!af || !(af instanceof TFile)) throw new Error("file not found");

    const content = await this.host.app.vault.read(af);
    const lines = (content ?? "").split(/\r?\n/);
    const findLineByUid = (): number | null => {
      if (!uid) return null;
      for (let i = 0; i < lines.length; i++) {
        if (!metaLineHasUid(lines[i], uid)) continue;
        const idx = i - 1;
        if (idx >= 0 && lines[idx] && /^\s*-\s*\[.\]\s+/.test(lines[idx])) return idx;
      }
      return null;
    };
    let idx = findLineByUid();
    if (idx == null) {
      const ln = Number((it as any).lineNo ?? -1);
      if (ln >= 0 && ln < lines.length) idx = ln;
    }
    if (idx == null) throw new Error("line not found");

    const oldLine = lines[idx] ?? "";
    const mm = oldLine.match(/^\s*(\-\s*)\[(.)\]\s*(.*)$/);
    if (!mm) throw new Error("invalid memo line");
    const prefix = mm[1] ?? "- ";
    const body = String(mm[3] ?? "");
    const tokenRe = /\s(📅|➕|⏳|🛫|✅|❌|🔁)\s/u;
    const mt = body.match(tokenRe);
    let descPart = body;
    let tokenPart = "";
    if (mt && typeof (mt as any).index === "number") {
      const cut = (mt as any).index as number;
      descPart = body.slice(0, cut).trimEnd();
      tokenPart = body.slice(cut).trimStart();
    }
    let desc = String(descPart ?? "").trim();
    desc = desc.replace(/^🚫\s*/u, "").trim();
    if (invalidated) {
      desc = desc ? `🚫 ${desc}` : "🚫";
    }
    const mergedBody = `${desc}${tokenPart ? ` ${tokenPart}` : ""}`.replace(/\s{2,}/g, " ").trimEnd();
    const newLine = `${prefix}[${invalidated ? "-" : "/"}] ${mergedBody}`.replace(/\s{2,}/g, " ").trimEnd();
    if (newLine !== oldLine) {
      lines[idx] = newLine;
      await this.host.app.vault.modify(af, lines.join("\n"));
    }

    const tsIso = nowIso();
    await writeBackMetaIdByUid(
      this.host.app,
      filePath,
      uid,
      {
        invalidated: invalidated ? "1" : "0",
        invalidated_date: invalidated ? todayYmd() : "",
        invalidated_time: invalidated ? tsIso : "",
      },
      idx
    );
  }

  // =========================
  // Archive (index only)
  // =========================

  public async archiveNow(modules?: TaskMemoModules): Promise<ArchiveResult> {
    await this.ensureReady();

    // Step6-5.3: optional per-module archive (task/memo). If `modules` is provided,
    // only the modules explicitly set to true will be archived. If omitted, archive both.
    const normModules = (m?: TaskMemoModules): { task: boolean; memo: boolean } => {
      if (!m) return { task: true, memo: true };
      return { task: m.task === true, memo: m.memo === true };
    };
    const mods = normModules(modules);
    if (!mods.task && !mods.memo) {
      return { archivedCount: 0, byMonth: {}, cutoffDate: todayYmd() };
    }

    const thresholdDaysRaw = this.tp.archiveThresholdDays;
    const keepMonthsRaw = this.tp.archiveKeepMonths;
    const thresholdDays = normalizeArchiveThresholdDays(
      Number.isFinite(thresholdDaysRaw)
        ? Number(thresholdDaysRaw)
        : Number.isFinite(keepMonthsRaw)
          ? Math.max(0, Math.floor(Number(keepMonthsRaw))) * 30
          : 90,
    );

    const emptyRes: ArchiveResult = { archivedCount: 0, byMonth: {}, cutoffDate: todayYmd() };
    const taskRes = mods.task ? await archiveIndexByMonths(this.store, "task", thresholdDays) : emptyRes;
    const memoRes = mods.memo ? await archiveIndexByMonths(this.store, "memo", thresholdDays) : emptyRes;

    // merge results so UI can show a single notice
    const byMonth: Record<string, number> = { ...(taskRes.byMonth ?? {}) };
    for (const [k, v] of Object.entries(memoRes.byMonth ?? {})) {
      byMonth[k] = (byMonth[k] ?? 0) + (v ?? 0);
    }
    const r: ArchiveResult = {
      archivedCount: (taskRes.archivedCount ?? 0) + (memoRes.archivedCount ?? 0),
      byMonth,
      cutoffDate: (mods.task ? taskRes.cutoffDate : memoRes.cutoffDate) ?? taskRes.cutoffDate ?? memoRes.cutoffDate ?? todayYmd(),
    };

    // mark run date
    this.tp.archiveLastRunKey = todayYmd();
    await this.host.saveSettings();
    return r;
  }

  public async autoArchiveIfNeeded(_modules?: TaskMemoModules): Promise<void> {
    void _modules; // Step6-5.2: reserved for future per-module auto-archive.
    if ((this.tp.autoArchiveEnabled ?? true) !== true) return;

    const today = todayYmd();
    if (this.tp.archiveLastRunKey === today) return;

    const r = await this.archiveNow();
    if (r.archivedCount > 0) {
      new Notice(`索引已归档：${r.archivedCount} 条（< ${r.cutoffDate}）`);
    }
  }
}