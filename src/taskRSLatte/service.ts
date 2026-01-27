import { App, Notice, TFile, moment, normalizePath } from "obsidian";
import { apiTry, RSLatteApiClient } from "../api";
import type { RSLattePluginSettings } from "../types/settings";
import type { JournalService } from "../services/journalService";
import { RSLatteIndexStore } from "./indexStore";
import { SyncQueue } from "./syncQueue";
import { parseRSLatteFile } from "./parser";
import { writeBackMetaIdByUid } from "./metaWriter";
import { archiveIndexByMonths, type ArchiveResult } from "./archiver";
import type { RSLatteIndexItem, RSLatteItemType, RSLatteParsedLine } from "./types";
import { archiveStableKey } from "./keys";
// import { buildIndexLocator } from "./indexLocator";
import type { BuiltinTaskListDef, BuiltinTaskListId, TaskCategoryDef, TaskDateField, TaskTimeRangeDef } from "../types/taskTypes";
import { fnv1a32 } from "../utils/hash";
import { scanAllCachedWithStore } from "../rslatteSync/scanPipeline";
import type { ContactsInteractionEntry } from "../contactsRSLatte/types";
import { extractContactUidFromWikiTarget, parseContactRefsFromMarkdown } from "../services/contacts/contactRefParser";
import { getNearestHeadingTitle } from "../services/markdown/headingLocator";
import { flushQueueUpsertV2 } from "../rslatteSync/upsertFlusher";
import { runReconcileAfterRebuild, runReconcileForType } from "../rslatteSync/reconcileRunner";
import type { WorkEventService } from "../services/workEventService";
import { nextSolarDateForLunarBirthday } from "../utils/lunar";
import { resolveSpaceIndexDir, resolveSpaceQueueDir } from "../services/spaceContext";

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

function fileMatchesTags(app: App, file: TFile, content: string, includeTags: string[], excludeTags: string[]): boolean {
  const tags = extractTags(app, file, content);
  const ex = (excludeTags ?? []).map(normTag).filter(Boolean);
  if (ex.some((t) => tags.has(t))) return false;

  const inc = (includeTags ?? []).map(normTag).filter(Boolean);
  if (!inc.length) return true;
  return inc.some((t) => tags.has(t));
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

  const payload: any = {
    item_type: p.itemType,
    uid: (p as any).uid,
    status: p.status,
    text: sanitize(p.text),
    raw: sanitize(p.raw),
    file_path: p.filePath,
    line_no: p.lineNo,
    source_hash: p.sourceHash,

    created_date: p.createdDate,
    due_date: p.dueDate,
    start_date: p.startDate,
    scheduled_date: p.scheduledDate,
    done_date: p.doneDate,
    cancelled_date: p.cancelledDate,

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

  // clean undefined
  for (const k of Object.keys(payload)) {
    if (payload[k] === undefined || payload[k] === null || payload[k] === "") delete payload[k];
  }

  // repeat_rule normalize
  const rrAllowed = new Set(["none","weekly","monthly","seasonly","yearly"]); 
  if (payload.repeat_rule && !rrAllowed.has(payload.repeat_rule)) payload.repeat_rule = "none";

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

    // 1) rewrite task/memo indexes
    for (const type of ["task", "memo"] as const) {
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

  private async listCandidateMarkdownFiles(): Promise<TFile[]> {
    const tp = this.tp;
    const folders = uniq((tp?.taskFolders ?? []).map(safeNormFolder).filter(Boolean));

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
        files: files.slice(0, 50).map(f => ({ path: f.path, mtime: new Date((f.stat as any)?.mtime ?? 0).toISOString() })), // 只显示前50个
      });
    }

    // Build a filter key that invalidates the cache when relevant settings change.
    const folders = uniq((tp?.taskFolders ?? []).map(safeNormFolder).filter(Boolean)).sort();
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
            const nowIso = new Date().toISOString();
            const contentLines = String(content ?? "").replace(/\r\n/g, "\n").split("\n");
            const all = parseContactRefsFromMarkdown(content, {
              source_path: filePath,
              source_type: "task",
              updated_at: nowIso,
            });

            // Group refs by line_no (1-based)
            const byLine = new Map<number, ContactsInteractionEntry[]>();
            for (const e of all) {
              const ln = Number(e.line_no ?? 0);
              if (!ln) continue;
              const arr = byLine.get(ln) ?? [];
              arr.push(e);
              byLine.set(ln, arr);
            }

            const out: ContactsInteractionEntry[] = [];
            for (const t of parsed?.tasks ?? []) {
              const ln = Number((t as any)?.lineNo ?? -1);
              if (ln < 0) continue;
              const lineNo1 = ln + 1;
              const refs = (byLine.get(lineNo1) ?? []).slice();

              // Extra-robust: if a single task line contains multiple contact refs but the
              // file-level parser missed some (e.g. unusual link target/path), parse the
              // current line again and补齐缺失联系人。
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
                    } as any);
                  }
                }
              } catch {
                // ignore
              }

              if (!refs || refs.length === 0) continue;
              const status = mapTaskStatus((t as any)?.status);
              for (const r of refs) {
                out.push({
                  ...r,
                  status,
                  updated_at: nowIso,
                  source_block_id: String((t as any)?.uid ?? "") || undefined,
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
      case "due": return it.dueDate;
      case "start": return it.startDate;
      case "scheduled": return it.scheduledDate;
      case "created": return it.createdDate;
      case "done": return it.doneDate;
      case "cancelled": return it.cancelledDate;
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
   * 供 Side Panel 2 使用：从索引中查询内置任务清单
   * （不再支持自定义 timeRanges/categories）
   */
  public async queryBuiltinListWithTotal(
    listId: BuiltinTaskListId,
    cfg: BuiltinTaskListDef
  ): Promise<{ items: RSLatteIndexItem[]; total: number }> {
    await this.ensureReady();

    let idx = await this.store.readIndex("task");
    if (!(idx.items ?? []).length) {
      await this.refreshIndexAndSync({ sync: this.enableSync });
      idx = await this.store.readIndex("task");
    }

    const today = momentFn().format("YYYY-MM-DD");
    const weekStart = momentFn(today).startOf("isoWeek").format("YYYY-MM-DD");
    const weekEnd = momentFn(today).endOf("isoWeek").format("YYYY-MM-DD");
    const cancelled7dStart = momentFn(today).startOf("day").subtract(6, "days").format("YYYY-MM-DD");

    const isTodoLike = (s: string) => s === "TODO" || s === "IN_PROGRESS";

    const match = (it: RSLatteIndexItem): boolean => {
      if (it.archived) return false;

      const st = (it.status ?? "UNKNOWN").toUpperCase();
      const due = it.dueDate;
      const start = it.startDate;
      const done = it.doneDate;
      const cancelled = it.cancelledDate;

      switch (listId) {
        case "todayTodo":
          return !!due && due === today && isTodoLike(st);
        case "weekTodo":
          return !!due && due >= weekStart && due <= weekEnd && isTodoLike(st);
        case "inProgress":
          if (st === "IN_PROGRESS") return true;
          return st === "TODO" && !!start && start < today;
        case "overdue":
          return !!due && due < today && isTodoLike(st);
        case "todayDone":
          return (st === "DONE" || st === "CANCELLED") && ((done === today) || (cancelled === today));
        case "cancelled7d":
          return st === "CANCELLED" && !!cancelled && cancelled >= cancelled7dStart && cancelled <= today;
        case "allTasks":
          // 全量任务清单：返回所有未归档的任务，不限制状态和日期
          return true;
        default:
          return false;
      }
    };

    const max = Math.min(Math.max(Number(cfg.maxItems || 0), 1), 30);
    const itemsAll = (idx.items ?? []).filter(match);
    const total = itemsAll.length;

    const field = cfg.sortField;
    const order = cfg.sortOrder;
    const getKey = (t: RSLatteIndexItem) => this.getFieldDate(t, field);

    itemsAll.sort((a, b) => {
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

    return { items: itemsAll.slice(0, max), total };
  }

  public async queryBuiltinList(listId: BuiltinTaskListId, cfg: BuiltinTaskListDef): Promise<RSLatteIndexItem[]> {
    const { items } = await this.queryBuiltinListWithTotal(listId, cfg);
    return items;
  }

  private async mergeIntoIndex(type: RSLatteItemType, parsed: RSLatteParsedLine[]): Promise<RSLatteIndexItem[]> {
    const idx = await this.store.readIndex(type);
    const existing = idx.items ?? [];

    // Idempotent archive support: closed tasks/memos may remain in daily notes and thus be re-scanned.
    // If they were archived already (and removed from main index), we should not re-add them to main index
    // when they are still older than the archive cutoff.
    // Archive cutoff (idempotency support): closed items older than the cutoff and already present in archive-map
    // should not be re-added to main index when they are re-scanned from daily notes.
    const today = momentFn().format("YYYY-MM-DD");
    const thresholdDaysRaw = this.tp.archiveThresholdDays;
    const keepMonthsRaw = this.tp.archiveKeepMonths;
    const thresholdDays = Number.isFinite(thresholdDaysRaw)
      ? Math.max(1, Math.min(3650, Math.floor(Number(thresholdDaysRaw))))
      : (Number.isFinite(keepMonthsRaw) ? Math.max(0, Math.floor(Number(keepMonthsRaw))) * 30 : 90);
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

    const seenAt = new Date().toISOString();
    const merged: RSLatteIndexItem[] = [];

    for (const p of parsed) {
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
        if (p.status === "CANCELLED") return p.cancelledDate || today;
        if (p.status === "DONE") return p.doneDate || today;

        // 2) task: non-closed tasks are never archived
        if (type === "task") return null;

        // 3) memo: non-closed
        let rule = String((p as any).repeatRule || "").trim().toLowerCase();
        if (!rule) rule = (p as any).memoMmdd ? "yearly" : "none";
        const allowed = new Set(["none", "weekly", "monthly", "seasonly", "yearly"]);
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

    await this.store.writeIndex(type, { version: 1, updatedAt: seenAt, items: merged });
    return merged;
  }

  // =========================
  // Memo: auto advance next reminder date (write back)
  // =========================

  private isYmd(s?: string): boolean {
    return !!(s ?? "").match(/^\d{4}-\d{2}-\d{2}$/);
  }

  private computeNextByRepeat(baseYmd: string, rr: string, todayYmd: string, mmddHint?: string): string {
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

    if (rr === "seasonly") {
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
    const today = todayYmd();
    const allowed = new Set(["none", "weekly", "monthly", "seasonly", "yearly"]);

    const patches: Array<{ uid: string; filePath: string; lineNo: number; newNext: string; patchLine: boolean }> = [];
    const uidToNext = new Map<string, string>();

    for (const it of memos) {
      const uid = String((it as any).uid ?? "").trim();
      if (!uid) continue;
      if (it.archived) continue;
      if (it.status === "DONE" || it.status === "CANCELLED") continue;

      const extra: Record<string, string> = (it as any).extra ?? {};
      const cat = String(extra["cat"] ?? "").trim();
      const dateType = String(extra["date_type"] ?? "").trim();

      let rr = String((it as any).repeatRule ?? "").trim().toLowerCase();
      if (!rr) rr = (it as any).memoMmdd ? "yearly" : "none";
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
      const seenAt = new Date().toISOString();
      await this.store.writeIndex("memo", { version: 1, updatedAt: seenAt, items: memos });
    }

    return memos;
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
      if (!m) return "任务/备忘";
      const onlyTask = m.task === true && m.memo !== true;
      const onlyMemo = m.memo === true && m.task !== true;
      if (onlyTask) return "任务";
      if (onlyMemo) return "备忘";
      return "任务/备忘";
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

    // Clear scan cache (real implementation; previous main.ts attempted a non-existing signature).
    try {
      await this.store.writeScanCache({ filterKey: "", files: {} } as any);
    } catch {
      // ignore
    }

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
      // Memo: keep the same behavior as the non-E2 refresh pipeline.
      // Auto advance next reminder date and write back to files if needed.
      memoIndexItems = await this.autoAdvanceMemoNextDates(memoIndexItems);
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
    const { tasks, memos, includedFilePaths } = await this.scanAllCached(
      prevTaskIndex.items ?? [],
      prevMemoIndex.items ?? [],
      { fixUidAndMeta }
    );

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

    // ✅ Step5-2b: auto-advance memo "next" reminder date (e.g., birthdays/anniversaries)
    // when the current next date is overdue. Write back to meta + keep index/UI consistent.
    if (mods.memo) memoIndexItems = await this.autoAdvanceMemoNextDates(memoIndexItems);

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
        err: c.failed > 0 ? "部分备忘入库失败（可刷新重试）" : undefined,
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
          "检查任务/备忘是否入库",
          () => (this.host.api as any).rslatteItemsExists({ ids: chunk }, { type, include_deleted: true })
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
      const now = new Date().toISOString();
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
    const now = new Date().toISOString();

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
  public async applyTaskStatusAction(it: Pick<RSLatteIndexItem, "filePath" | "lineNo" | "uid" | "text" | "raw" | "status">, to: TaskStatusAction): Promise<void> {
    const filePath = String(it.filePath ?? "");
    const uid = String((it as any).uid ?? "").trim();
    if (!filePath) throw new Error("missing filePath");

    const af = this.host.app.vault.getAbstractFileByPath(filePath);
    if (!af || !(af instanceof TFile)) throw new Error("file not found");

    const content = await this.host.app.vault.read(af);
    const lines = (content ?? "").split(/\r?\n/);

    const findTaskLineByUid = (): number | null => {
      if (!uid) return null;
      const metaLineRe = /^\s*<!--\s*rslatte:([^>]*)-->\s*$/i;
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(metaLineRe);
        if (!m) continue;
        const kvRaw = String(m[1] ?? "");
        if (!kvRaw.includes("uid=")) continue;
        // quick check first
        if (!kvRaw.includes(`uid=${uid}`)) continue;
        const taskIdx = i - 1;
        if (taskIdx >= 0) return taskIdx;
        return null;
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
      // keep tokens as-is
    }

    const newLine = `${prefix}[${newMark}] ${body.trim()}`;

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
      // Best-effort: do not fail the action if meta patch fails.
      try {
        await writeBackMetaIdByUid(this.host.app, filePath, uid, patch, idx);
      } catch (e) {
        (this.host as any).dbg?.("taskRSLatte", "applyTaskStatusAction meta patch failed", { filePath, uid, err: String((e as any)?.message ?? e) });
      }
    }

    // ✅ Work Event (success only)
    try {
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
        // 从 oldLine 解析之前的状态（修改前的 checkbox mark）
        const prevStatusMatch = oldLine.match(TASK_LINE_RE);
        const prevStatusMark = prevStatusMatch?.[2] ?? " "; // checkbox mark 在第二个捕获组
        const prevStatus = prevStatusMark === " " ? "TODO" : prevStatusMark === "/" ? "IN_PROGRESS" : prevStatusMark === "x" ? "DONE" : "CANCELLED";
        
        // 检查任务是否曾经开始过（通过检查是否有 🛫 标记）
        // 注意：START_TOKEN_RE_G 是全局正则，使用 match 而不是 test 来避免状态问题
        const hasStartDate = /🛫\uFE0F?\s*\d{4}-\d{2}-\d{2}/.test(oldLine);
        
        // 判断逻辑：
        // 1. 如果之前是 TODO 且从未开始过（没有 🛫 标记），则是 start（首次开始）
        // 2. 如果之前是 TODO 但曾经开始过（有 🛫 标记），则是 continued（恢复进行中）
        // 3. 如果之前是其他状态（DONE/CANCELLED/IN_PROGRESS），则是 continued（恢复或继续）
        if (prevStatus === "TODO" && !hasStartDate) {
          action = "start"; // 首次开始
          short_desc = "任务开始 " + short_desc;
        } else {
          action = "continued"; // 继续（恢复进行中）
          short_desc = "任务继续 " + short_desc;
        }
      } else {
        // to === "TODO"
        action = "paused";
        short_desc = "任务暂停 " + short_desc;
      }
      
      void this.host.workEventSvc?.append({
        ts: tsIso,
        kind: "task",
        action: action as any,
        source: "ui",
        summary: `${icon} ${short_desc}`,
        ref: { uid: uid || undefined, file_path: filePath, line_no: idx, to },
      } as any);
    } catch {
      // ignore
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
    opts?: { skipWorkEvent?: boolean }
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
      const metaLineRe = /^\s*<!--\s*rslatte:([^>]*)-->\s*$/i;
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(metaLineRe);
        if (!m) continue;
        const kvRaw = String(m[1] ?? "");
        if (!kvRaw.includes("uid=")) continue;
        if (!kvRaw.includes(`uid=${uid}`)) continue;
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

    // ✅ Work Event (success only)；手机同步时由 mobileSync 统一写入，传 skipWorkEvent: true
    if (!opts?.skipWorkEvent) {
      try {
        const txt = String((it as any).text ?? "").trim() || String((it as any).raw ?? "").trim();
        const short = txt.length > 80 ? txt.slice(0, 80) + "…" : txt;
        let short_desc = short;
        const icon = to === "DONE" ? "✅" : to === "CANCELLED" ? "❌" : to === "IN_PROGRESS" ? "▶" : "⏸";
        if (to === "DONE") {
          short_desc = "备忘完成 " + short_desc;
        } else if (to === "CANCELLED") {
          short_desc = "备忘取消 " + short_desc;
        } else if (to === "IN_PROGRESS") {
          short_desc = "备忘继续 " + short_desc;
        } else {
          short_desc = "备忘暂停 " + short_desc;
        }
        // 当状态为 CANCELLED 时，使用 action: "cancelled"，其他状态使用 action: "status"
        const action = to === "CANCELLED" ? "cancelled" : "status";
        void this.host.workEventSvc?.append({
          ts: tsIso,
          kind: "memo",
          action: action as any,
          source: "ui",
          ref: { uid, file_path: filePath, line_no: idx, status: to },
          summary: `${icon} ${short_desc}`,
          metrics: { status: to },
        });
      } catch (e) {
        // ignore
      }
    }
  }

public async updateTaskBasicInfo(
    it: Pick<RSLatteIndexItem, "filePath" | "lineNo" | "uid" | "text" | "raw">,
    patch: { text: string; due: string; start?: string; scheduled?: string },
    opts?: { skipWorkEvent?: boolean }
  ): Promise<void> {
    const filePath = String(it.filePath ?? "");
    const uid = String((it as any).uid ?? "").trim();
    if (!filePath) throw new Error("missing filePath");

    const newText = String(patch.text ?? "").trim();
    const due = String(patch.due ?? "").trim();
    const start = String(patch.start ?? "").trim();
    const scheduled = String(patch.scheduled ?? "").trim();

    if (!newText) throw new Error("任务描述不能为空");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error("到期日期（due）为必填，且格式必须为 YYYY-MM-DD");
    if (start && !/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error("开始日期（start）格式必须为 YYYY-MM-DD");
    if (scheduled && !/^\d{4}-\d{2}-\d{2}$/.test(scheduled)) throw new Error("计划日期（scheduled）格式必须为 YYYY-MM-DD");

    const af = this.host.app.vault.getAbstractFileByPath(filePath);
    if (!af || !(af instanceof TFile)) throw new Error("file not found");

    const content = await this.host.app.vault.read(af);
    const lines = (content ?? "").split(/\r?\n/);

    const findTaskLineByUid = (): number | null => {
      if (!uid) return null;
      const metaLineRe = /^\s*<!--\s*rslatte:([^>]*)-->\s*$/i;
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(metaLineRe);
        if (!m) continue;
        const kvRaw = String(m[1] ?? "");
        if (!kvRaw.includes("uid=")) continue;
        if (!kvRaw.includes(`uid=${uid}`)) continue;
        const taskIdx = i - 1;
        if (taskIdx >= 0) return taskIdx;
        return null;
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

    const newDesc = `${newText}${comments.length ? " " + comments.join(" ") : ""}`.trimEnd();

    // Remove existing 📅/🛫/⏳ tokens only; keep others intact.
    let rest = tokenPart;
    rest = rest.replace(/\s📅\s\d{4}-\d{2}-\d{2}/g, "");
    rest = rest.replace(/\s🛫\s\d{4}-\d{2}-\d{2}/g, "");
    rest = rest.replace(/\s⏳\s\d{4}-\d{2}-\d{2}/g, "");
    rest = rest.replace(/\s{2,}/g, " ").trim();

    const insert = `📅 ${due}${start ? ` 🛫 ${start}` : ""}${scheduled ? ` ⏳ ${scheduled}` : ""}`.trim();
    const newBody = `${newDesc} ${insert}${rest ? " " + rest : ""}`.replace(/\s{2,}/g, " ").trimEnd();
    const newLine = `${prefix}[${mark}] ${newBody}`.replace(/\s{2,}/g, " ").trimEnd();

    if (newLine !== oldLine) {
      lines[idx] = newLine;
      await this.host.app.vault.modify(af, lines.join("\n"));
    }

    const tsIso = nowIso();
    if (uid) {
      try {
        await writeBackMetaIdByUid(this.host.app, filePath, uid, { updated_time: tsIso }, idx);
      } catch (e) {
        (this.host as any).dbg?.("taskRSLatte", "updateTaskBasicInfo meta patch failed", { filePath, uid, err: String((e as any)?.message ?? e) });
      }
    }

    // Work Event (success only)；手机同步时由 mobileSync 统一写入，传 skipWorkEvent: true
    if (!opts?.skipWorkEvent) {
      try {
        const short = newText.length > 80 ? newText.slice(0, 80) + "…" : newText;
        void this.host.workEventSvc?.append({
          ts: tsIso,
          kind: "task",
          action: "update",
          source: "ui",
          summary: `✏️ 修改任务 ${short}`,
          ref: { uid: uid || undefined, file_path: filePath, line_no: idx },
          metrics: { due, start: start || undefined, scheduled: scheduled || undefined },
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
    const repeat = String(patch.repeatRule ?? "").trim().toLowerCase();

    if (!newText) throw new Error("备忘内容不能为空");
    const isYmd = /^\d{4}-\d{2}-\d{2}$/.test(memoDate);
    const isMmdd = /^\d{2}-\d{2}$/.test(memoDate);
    if (!isYmd && !isMmdd) throw new Error("日期必须为 YYYY-MM-DD 或 MM-DD");

    const allowed = new Set(["none", "weekly", "monthly", "seasonly", "yearly"]);
    const rr = allowed.has(repeat) ? repeat : "none";

    const af = this.host.app.vault.getAbstractFileByPath(filePath);
    if (!af || !(af instanceof TFile)) throw new Error("file not found");

    const content = await this.host.app.vault.read(af);
    const lines = (content ?? "").split(/\r?\n/);

    const findLineByUid = (): number | null => {
      if (!uid) return null;
      const metaLineRe = /^\s*<!--\s*rslatte:([^>]*)-->\s*$/i;
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(metaLineRe);
        if (!m) continue;
        const kvRaw = String(m[1] ?? "");
        if (!kvRaw.includes("uid=")) continue;
        if (!kvRaw.includes(`uid=${uid}`)) continue;
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
          summary: `✏️ 修改备忘 ${short}`,
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
    startDate?: string,
    scheduledDate?: string,
    opts?: { source?: "ui" | "mobile"; mobile_op_id?: string }
  ): Promise<void> {
    // const tp = this.tp;
    const t = (text ?? "").trim();
    if (!t) return;

    const today = todayYmd();
    const due = (dueDate ?? "").trim();
    const start = (startDate ?? "").trim();
    const scheduled = (scheduledDate ?? "").trim();

    // due 必填
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) {
      throw new Error("到期日期（due）为必填，且格式必须为 YYYY-MM-DD");
    }

    // optional dates validation
    if (start && !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
      throw new Error("开始日期（start）格式必须为 YYYY-MM-DD");
    }
    if (scheduled && !/^\d{4}-\d{2}-\d{2}$/.test(scheduled)) {
      throw new Error("计划日期（scheduled）格式必须为 YYYY-MM-DD");
    }

    // v2: create with uid + next-line meta comment (do NOT insert legacy inline comment)
    const uid = `lg_${Math.random().toString(16).slice(2, 12)}`; // 10 hex chars
    const line = `- [ ] ${t} 📅 ${due}${start ? ` 🛫 ${start}` : ""}${scheduled ? ` ⏳ ${scheduled}` : ""} ➕ ${today}`;
    // ts: ISO with timezone offset (for intra-day ordering on stats)
    const tsIso = momentFn().format("YYYY-MM-DDTHH:mm:ssZ");
    const meta = `  <!-- rslatte:uid=${uid};type=task;ts=${tsIso} -->`;
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

    // ✅ Work Event (success only)
    const source = opts?.source ?? "ui";
    void this.host.workEventSvc?.append({
      ts: tsIso,
      kind: "task",
      action: "create",
      source,
      ref: {
        uid,
        text: t,
        due,
        start: start || undefined,
        scheduled: scheduled || undefined,
        record_date: today,
        ...(opts?.mobile_op_id && { mobile_op_id: opts.mobile_op_id }),
      },
      summary: `📝 新建任务 ${t}`,
      metrics: { due, start: start || undefined, scheduled: scheduled || undefined },
    });
  }

  /**
   * ✅ 查找已存在的联系人生日备忘（通过 contact_uid）
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
        // 检查是否是生日备忘（有 yearly 重复规则，且是 lunarBirthday 或 solarBirthday）
        const rule = String(it.repeatRule ?? "").trim().toLowerCase();
        const cat = String(extra.cat ?? "").trim();
        if (rule === "yearly" && (cat === "lunarBirthday" || cat === "solarBirthday")) {
          return it;
        }
      }
    }
    return null;
  }

  /**
   * ✅ 创建或更新联系人生日备忘（支持农历和阳历）
   */
  public async createOrUpdateContactBirthdayMemo(opts: {
    contactUid: string;
    contactName: string;
    contactFile: string;
    birthdayType: "solar" | "lunar";
    month: number;
    day: number;
    leapMonth?: boolean;
  }): Promise<void> {
    await this.ensureReady();
    const { contactUid, contactName, contactFile, birthdayType, month, day, leapMonth = false } = opts;
    
    if (!month || !day) return;
    
    const today = todayYmd();
    const tsIso = momentFn().format("YYYY-MM-DDTHH:mm:ssZ");
    const memoText = `${contactName}的生日`;
    
    let displayDate: string; // 显示在 📅 后面的日期（YYYY-MM-DD）
    let metaExtra: Record<string, string> = {
      contact_uid: contactUid,
      contact_file: contactFile,
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
    
    // 检查是否已存在
    const existingMemo = await this.findContactBirthdayMemo(contactUid);
    
    if (existingMemo) {
      // 更新现有备忘
      await this.updateMemoBasicInfo(
        existingMemo,
        {
          text: memoText,
          memoDate: displayDate, // YYYY-MM-DD 格式
          repeatRule: "yearly",
          metaExtra: metaExtra,
        }
      );
    } else {
      // 创建新备忘
      const uid = `lg_${Math.random().toString(16).slice(2, 12)}`; // 10 hex chars
      const repToken = " 🔁 yearly";
      const line = `- [ ] ${memoText} 📅 ${displayDate}${repToken} ➕ ${today}`;
      
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
      const meta = `  <!-- rslatte:uid=${uid};type=memo;ts=${tsIso}${extraParts.length ? `;${extraParts.join(";")}` : ""} -->`;

      // ✅ 按"日志追加清单"配置写入日记（强制启用：备忘）
      const rules = (this.host.settingsRef().journalAppendRules ?? []) as any[];
      const r = (rules.find((x) => x.module === "memo") ?? { h1: "# 任务追踪", h2: "## 新增备忘" }) as any;
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
        summary: `🗒 新建备忘 ${memoText}`,
        metrics: { memo_date: displayDate, repeat_rule: "yearly" },
      });
    }
  }

  public async createTodayMemo(
    text: string,
    dateOrMmdd: string,
    repeatRule?: string,
    metaExtra?: Record<string, string | number | boolean | undefined | null>
  ): Promise<void> {
    // const tp = this.tp;
    const t = (text ?? "").trim();
    if (!t) return;

    const today = todayYmd();
    const d = (dateOrMmdd ?? "").trim();
    if (!d) return;

    const isMmdd = /^\d{2}-\d{2}$/.test(d);
    const isYmd = /^\d{4}-\d{2}-\d{2}$/.test(d);
    if (!isMmdd && !isYmd) return;

    const repeat = (repeatRule ?? "").trim().toLowerCase();
    const allowed = new Set(["none", "weekly", "monthly", "seasonly", "yearly"]);
    const rr = allowed.has(repeat) ? repeat : "none";
    const repToken = rr !== "none" ? ` 🔁 ${rr}` : "";
    // v2: create with uid + next-line meta comment (do NOT insert legacy inline comment)
    const uid = `lg_${Math.random().toString(16).slice(2, 12)}`; // 10 hex chars
    const line = `- [ ] ${t} 📅 ${d}${repToken} ➕ ${today}`;
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
    const meta = `  <!-- rslatte:uid=${uid};type=memo;ts=${tsIso}${extraParts.length ? `;${extraParts.join(";")}` : ""} -->`;

    // ✅ 按“日志追加清单”配置写入日记（强制启用：备忘）
    const rules = (this.host.settingsRef().journalAppendRules ?? []) as any[];
    const r = (rules.find((x) => x.module === "memo") ?? { h1: "# 任务追踪", h2: "## 新增备忘" }) as any;
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
      ref: { uid, text: t, memo_date: d, repeat_rule: rr, record_date: today, ...(metaExtra ? { meta_extra: metaExtra as any } : {}) },
      summary: `🗒 新建备忘 ${t}`,
      metrics: { memo_date: d, repeat_rule: rr },
    });
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

      const extra: Record<string, string> = (it as any).extra ?? {};

      // memo scheduling
      let rule = String(it.repeatRule || "").trim().toLowerCase();
      if (!rule) rule = (it.memoMmdd ? "yearly" : "none");
      const allowed = new Set(["none", "weekly", "monthly", "seasonly", "yearly"]);
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
   * v28：全量备忘清单（用于侧边栏管理）
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
      const st = String((it as any).status ?? "").trim().toUpperCase();
      if (!stSet.has(st as any)) continue;

      // pick a date for ordering:
      // - open memos: next (memoDate / meta next)
      // - closed memos: done/cancelled date if available, else fallback
      const anyIt: any = it as any;
      const extra: Record<string, string> = (anyIt.extra ?? {}) as any;

      let pick = "";
      if (st === "DONE") pick = String(anyIt.doneDate ?? "");
      else if (st === "CANCELLED") pick = String(anyIt.cancelledDate ?? "");

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
          const allowed = new Set(["none", "weekly", "monthly", "seasonly", "yearly"]);
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
    const thresholdDays = Number.isFinite(thresholdDaysRaw)
      ? Math.max(1, Math.min(3650, Math.floor(Number(thresholdDaysRaw))))
      : (Number.isFinite(keepMonthsRaw) ? Math.max(0, Math.floor(Number(keepMonthsRaw))) * 30 : 90);

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