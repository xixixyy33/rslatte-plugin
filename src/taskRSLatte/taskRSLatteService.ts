import { Notice, TFile, normalizePath } from "obsidian";
import type { App } from "obsidian";

import type { RSLatteApiClient, RSLatteItemPayload, RSLatteSyncBatchReq, RSLatteSyncResult, RSLatteItemType } from "../api";
import { apiTry } from "../api";
import { parseRSLatteLine } from "./parser";
import { archiveIndexByMonths } from "./archiver";
import { RSLatteIndexStore } from "./indexStore";
import { SyncQueue } from "./syncQueue";
import type { RSLatteIndexItem, SyncQueueFile, SyncQueueOp } from "./types";
import { fnv1a32, todayYmd, cmpYmd } from "./utils";

export type TaskRSLatteSettings = {
  rootDir: string; // 95-Tasks
  scanDirs: string[];
  includeTags: string[];
  excludeTags: string[];
  keepMonths: number; // archive keep window
  importantDays: number; // memo horizon
};

export const DEFAULT_TASK_RSLATTE_SETTINGS: TaskRSLatteSettings = {
  rootDir: "95-Tasks",
  scanDirs: ["01-Daily"],
  includeTags: [],
  excludeTags: [],
  keepMonths: 3,
  importantDays: 7,
};

export class TaskRSLatteService {
  private app: App;
  private api: RSLatteApiClient;
  private opts: TaskRSLatteSettings;
  private store: RSLatteIndexStore;
  private queue: SyncQueue;
  // private archiver: Archiver;

  // 每日启动只归档一次
  private lastArchiveDayKey: string = "";

  constructor(app: App, api: RSLatteApiClient, opts?: Partial<TaskRSLatteSettings>) {
    this.app = app;
    this.api = api;
    this.opts = { ...DEFAULT_TASK_RSLATTE_SETTINGS, ...(opts ?? {}) };
    const baseDir = `${this.opts.rootDir}/.rslatte`;
    this.store = new RSLatteIndexStore(app, baseDir, baseDir);
    const loadQueue = async () => {
      // TODO: implement queue loading
      return { version: 1, updatedAt: new Date().toISOString(), ops: [] } as SyncQueueFile;
    };
    const saveQueue = async (_q: SyncQueueFile) => {
      // TODO: implement queue saving
    };
    this.queue = new SyncQueue(loadQueue, saveQueue);
    // this.archiver = new Archiver(this.store, { keepMonths: this.opts.keepMonths });
  }

  updateSettings(opts: Partial<TaskRSLatteSettings>) {
    this.opts = { ...this.opts, ...(opts ?? {}) };
    const baseDir = `${this.opts.rootDir}/.rslatte`;
    this.store = new RSLatteIndexStore(this.app, baseDir, baseDir);
    const loadQueue = async () => {
      // TODO: implement queue loading
      return { version: 1, updatedAt: new Date().toISOString(), ops: [] } as SyncQueueFile;
    };
    const saveQueue = async (_q: SyncQueueFile) => {
      // TODO: implement queue saving
    };
    this.queue = new SyncQueue(loadQueue, saveQueue);
    // this.archiver = new Archiver(this.store, { keepMonths: this.opts.keepMonths });
  }

  /** 启动时调用：自动归档（每天只跑一次） */
  async autoArchiveIfNeeded(): Promise<void> {
    const day = todayYmd();
    if (this.lastArchiveDayKey === day) return;
    this.lastArchiveDayKey = day;
    try {
      const thresholdDays = this.opts.keepMonths * 30;
      const taskRes = await archiveIndexByMonths(this.store, "task", thresholdDays);
      const memoRes = await archiveIndexByMonths(this.store, "memo", thresholdDays);
      const total = taskRes.archivedCount + memoRes.archivedCount;
      if (total > 0) {
        new Notice(`RSLatte：已自动归档（截止 ${taskRes.cutoffDate}） tasks=${taskRes.archivedCount}, memos=${memoRes.archivedCount}`);
      }
    } catch (e) {
      console.warn("[rslatte] autoArchive failed", e);
    }
  }

  /** 手动归档（按钮触发） */
  async manualArchive(): Promise<void> {
    // const day = todayYmd();
    const thresholdDays = this.opts.keepMonths * 30;
    const taskRes = await archiveIndexByMonths(this.store, "task", thresholdDays);
    const memoRes = await archiveIndexByMonths(this.store, "memo", thresholdDays);
    new Notice(`RSLatte：归档完成（截止 ${taskRes.cutoffDate}） tasks=${taskRes.archivedCount}, memos=${memoRes.archivedCount}`);
  }

  /** 全量刷新：扫描 vault → 更新 index → 入队 → 尝试同步 */
  async refreshAll(): Promise<{ tasks: number; memos: number; queued: number; synced: number }>
  {
    const scanned = await this.scanAll();
    const queued = await this.reconcileIndexAndEnqueue(scanned.tasks, scanned.memos);
    const synced = await this.flushQueue();
    return { tasks: scanned.tasks.length, memos: scanned.memos.length, queued, synced };
  }

  /** 扫描指定目录下的 markdown 文件，解析 tasks/memos */
  async scanAll(): Promise<{ tasks: RSLatteIndexItem[]; memos: RSLatteIndexItem[] }>
  {
    const files = this.app.vault.getMarkdownFiles();
    const dirs = (this.opts.scanDirs ?? []).map((d) => normalizePath(d));

    const outTasks: RSLatteIndexItem[] = [];
    const outMemos: RSLatteIndexItem[] = [];

    for (const f of files) {
      if (!dirs.some((d) => f.path.startsWith(d))) continue;

      const text = await this.app.vault.read(f);
      if (!this.matchDocTags(text)) continue;

      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const parsed = parseRSLatteLine(f.path, i, lines[i]);
        if (!parsed) continue;
        const item: RSLatteIndexItem = {
          ...parsed,
          itemId: parsed.tid || parsed.mid,
          seenAt: new Date().toISOString(),
        };
        if (parsed.itemType === "task") outTasks.push(item);
        else outMemos.push(item);
      }
    }

    return { tasks: outTasks, memos: outMemos };
  }

  private matchDocTags(text: string): boolean {
    const inc = (this.opts.includeTags ?? []).map((t) => t.trim()).filter(Boolean);
    const exc = (this.opts.excludeTags ?? []).map((t) => t.trim()).filter(Boolean);

    // includeTags: union（任意命中即可）; 若为空 → 放行
    if (inc.length) {
      const ok = inc.some((tag) => hasTag(text, tag));
      if (!ok) return false;
    }
    if (exc.length) {
      const bad = exc.some((tag) => hasTag(text, tag));
      if (bad) return false;
    }
    return true;
  }

  /**
   * 将扫描结果与 index 合并：
   * - 新任务（无 item_id） → enqueue create
   * - 已有 item_id 且内容变更 → enqueue update
   */
  async reconcileIndexAndEnqueue(scannedTasks: RSLatteIndexItem[], scannedMemos: RSLatteIndexItem[]): Promise<number> {
    const taskDoc = await this.store.readIndex("task");
    const memoDoc = await this.store.readIndex("memo");

    const taskMap = new Map<string, RSLatteIndexItem>();
    for (const it of (taskDoc.items ?? [])) taskMap.set(indexKey(it), it);
    const memoMap = new Map<string, RSLatteIndexItem>();
    for (const it of (memoDoc.items ?? [])) memoMap.set(indexKey(it), it);

    let queued = 0;

    // merge tasks
    for (const it of scannedTasks) {
      const k = indexKey(it);
      const prev = taskMap.get(k);
      if (!prev) {
        taskMap.set(k, it);
        if (!it.itemId) {
          await this.enqueueCreate(it);
          queued++;
        }
      } else {
        const merged = { ...prev, ...it };
        taskMap.set(k, merged);
        if (merged.itemId && merged.sourceHash && merged.sourceHash !== prev.sourceHash) {
          await this.enqueueUpdate(merged);
          queued++;
        }
        if (!merged.itemId && it.itemId) {
          // got id from scan
        }
      }
    }

    // merge memos
    for (const it of scannedMemos) {
      const k = indexKey(it);
      const prev = memoMap.get(k);
      if (!prev) {
        memoMap.set(k, it);
        if (!it.itemId) {
          await this.enqueueCreate(it);
          queued++;
        }
      } else {
        const merged = { ...prev, ...it };
        memoMap.set(k, merged);
        if (merged.itemId && merged.sourceHash && merged.sourceHash !== prev.sourceHash) {
          await this.enqueueUpdate(merged);
          queued++;
        }
      }
    }

    taskDoc.items = Array.from(taskMap.values());
    memoDoc.items = Array.from(memoMap.values());
    await this.store.writeIndex("task", taskDoc);
    await this.store.writeIndex("memo", memoDoc);
    return queued;
  }

  /** 批量同步队列（DB 断连时保留队列等待下次） */
  async flushQueue(maxBatch: number = 50): Promise<number> {
    const all = await this.queue.listAll();
    if (!all.length) return 0;

    const batch = all.slice(0, maxBatch);
    // const _rest = all.slice(maxBatch);

    const req: RSLatteSyncBatchReq = {
      ops: batch.map((q: SyncQueueOp) => ({ op_id: q.opId, action: q.action as any, item: q.payload as any }))
    };

    let respResults: RSLatteSyncResult[] = [];
    try {
      const resp = await apiTry("同步任务/备忘", () => this.api.rslatteItemsSyncBatch(req));
      respResults = resp?.results ?? [];
    } catch (e: any) {
      // 断连：累积 tries
      for (const q of batch) {
        await this.queue.markFailure(q.opId, e?.message ?? String(e), 10);
      }
      return 0;
    }

    // success: remove ok ones, keep failed
    let okCount = 0;
    const mapByOp = new Map(respResults.map((r) => [r.op_id, r]));
    for (const q of batch) {
      const r = mapByOp.get(q.opId);
      if (r?.ok) {
        okCount++;
        await this.queue.markSuccess(q.opId);
        if (q.action === "create" && r.item_id) {
          await this.onCreatedItem(q.payload, r.item_id);
        }
      } else {
        await this.queue.markFailure(q.opId, r?.message ?? "unknown error", 10);
      }
    }
    return okCount;
  }

  /**
   * 新建成功后：回写 id 到源文件行（tid/mid），并更新 index 里的 item_id
   */
  private async onCreatedItem(payload: any, item_id: number): Promise<void> {
    const item_type = payload?.item_type as RSLatteItemType;
    const file_path = String(payload?.file_path ?? "");
    const line_no = Number(payload?.line_no ?? 0);
    if (!file_path || !line_no) return;

    // 回写源文件
    await patchRSLatteIdInFile(this.app, { file_path, line_no, item_type, item_id });

    // 更新 index
    if (item_type === "task") {
      const doc = await this.store.readIndex("task");
      for (const it of doc.items) {
        if (it.filePath === file_path && it.lineNo === line_no - 1 && !it.itemId) {
          it.itemId = item_id;
          it.sourceHash = fnv1a32((it.raw ?? "").trim());
          break;
        }
      }
      await this.store.writeIndex("task", doc);
    } else {
      const doc = await this.store.readIndex("memo");
      for (const it of doc.items) {
        if (it.filePath === file_path && it.lineNo === line_no - 1 && !it.itemId) {
          it.itemId = item_id;
          it.sourceHash = fnv1a32((it.raw ?? "").trim());
          break;
        }
      }
      await this.store.writeIndex("memo", doc);
    }
  }

  private async enqueueCreate(it: RSLatteIndexItem): Promise<void> {
    const item = indexedToPayload(it);
    await this.queue.enqueue("create", it.itemType, {
      filePath: it.filePath,
      lineNo: it.lineNo,
      itemId: it.itemId,
      payload: item,
    });
  }

  private async enqueueUpdate(it: RSLatteIndexItem): Promise<void> {
    const item = indexedToPayload(it);
    if (!item.item_id) return;
    await this.queue.enqueue("update", it.itemType, {
      filePath: it.filePath,
      lineNo: it.lineNo,
      itemId: it.itemId,
      payload: item,
    });
  }

  // ===== UI 查询：分类/重要事项 =====

  async listAllTasks(): Promise<RSLatteIndexItem[]> {
    const doc = await this.store.readIndex("task");
    return doc.items ?? [];
  }

  async listAllMemos(): Promise<RSLatteIndexItem[]> {
    const doc = await this.store.readIndex("memo");
    return doc.items ?? [];
  }

  /** 默认：今天 + N 天 */
  async listImportantMemos(opts?: { horizonDays?: number; fromYmd?: string }): Promise<RSLatteIndexItem[]> {
    const horizonDays = Math.max(1, Math.min(365, opts?.horizonDays ?? this.opts.importantDays ?? 7));
    const from = (opts?.fromYmd ?? todayYmd());
    const to = addDays(from, horizonDays);
    const memos = await this.listAllMemos();

    const out: RSLatteIndexItem[] = [];
    for (const m of memos) {
      if ((m.status ?? "").toUpperCase() === "CANCELLED") continue;
      const d = computeMemoNextDate(m, from);
      if (!d) continue;
      if (d >= from && d <= to) out.push({ ...m, memoDate: d });
    }
    out.sort((a, b) => cmpYmd(a.memoDate, b.memoDate));
    return out;
  }
}

function indexKey(it: RSLatteIndexItem): string {
  if (it.itemId) return `${it.itemType}:${it.itemId}`;
  return `${it.itemType}:L:${it.filePath}#${it.lineNo}`;
}

function indexedToPayload(it: RSLatteIndexItem): RSLatteItemPayload {
  // DONE 但无 ✅ 日期：DB 侧会兜底为今天；这里也尽量给一个 done_date（不改原文）
  const status = (it.status ?? "TODO") as any;
  if (it.itemType === "task") {
    const done_date = status === "DONE" && !it.doneDate ? todayYmd() : it.doneDate ?? null;
    return {
      item_type: "task",
      item_id: it.itemId,
      status,
      text: it.text,
      raw: it.raw,
      file_path: it.filePath,
      line_no: it.lineNo + 1, // convert 0-based to 1-based
      created_date: it.createdDate ?? null,
      due_date: it.dueDate ?? null,
      start_date: it.startDate ?? null,
      scheduled_date: it.scheduledDate ?? null,
      done_date: done_date,
      cancelled_date: it.cancelledDate ?? null,
      source_hash: it.sourceHash ?? null,
    } as any;
  }
  return {
    item_type: "memo",
    item_id: it.itemId,
    status,
    text: it.text,
    raw: it.raw,
    file_path: it.filePath,
    line_no: it.lineNo + 1, // convert 0-based to 1-based
    created_date: it.createdDate ?? null,
    memo_date: it.memoDate ?? null,
    memo_mmdd: it.memoMmdd ?? null,
    repeat_rule: (it.repeatRule ?? "none") as any,
    remind_days: (it as any).remindDays ?? 0,
    priority: (it as any).priority ?? 0,
    last_notified_date: (it as any).lastNotifiedDate ?? null,
    source_hash: it.sourceHash ?? null,
  } as any;
}

function hasTag(text: string, tag: string): boolean {
  const t = tag.replace(/^#/, "").trim();
  if (!t) return false;
  const re = new RegExp(`(^|\\s)#${escapeRegExp(t)}(\\s|$)`, "m");
  // 简易：正文里任意 #tag 即认为包含（含 YAML tags 不单独解析）
  return re.test(text);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
}

async function patchRSLatteIdInFile(app: App, args: { file_path: string; line_no: number; item_type: RSLatteItemType; item_id: number }): Promise<void> {
  const f = app.vault.getAbstractFileByPath(args.file_path);
  if (!(f instanceof TFile)) return;
  const text = await app.vault.read(f);
  const lines = text.split(/\r?\n/);
  const idx = args.line_no - 1;
  if (idx < 0 || idx >= lines.length) return;

  const line = lines[idx];
  const updated = upsertRSLatteComment(line, args.item_type, args.item_id);
  if (updated !== line) {
    lines[idx] = updated;
    await app.vault.modify(f, lines.join("\n"));
  }
}

function upsertRSLatteComment(line: string, item_type: RSLatteItemType, item_id: number): string {
  // Backward compatible: accept legacy "ledger:" prefix from older vaults.
  const COMMENT_RE = /<!--\s*(?:rslatte|ledger):\s*([^>]*?)\s*-->/i;
  const m = line.match(COMMENT_RE);
  const idKey = item_type === "task" ? "tid" : "mid";
  if (!m) {
    return `${line} <!-- rslatte:type=${item_type};${idKey}=${item_id} -->`;
  }
  const inside = (m[1] ?? "").trim();
  const parts = inside.split(";").map((x) => x.trim()).filter(Boolean);
  const kv: Record<string, string> = {};
  for (const p of parts) {
    const [k, ...rest] = p.split("=");
    const key = (k ?? "").trim();
    const val = rest.join("=").trim();
    if (!key) continue;
    kv[key] = val;
  }
  kv["type"] = item_type;
  kv[idKey] = String(item_id);
  const rebuilt = Object.entries(kv).map(([k, v]) => `${k}=${v}`).join(";");
  return line.replace(COMMENT_RE, `<!-- rslatte:${rebuilt} -->`);
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map((x) => parseInt(x, 10));
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function computeMemoNextDate(m: RSLatteIndexItem, fromYmd: string): string | null {
  // 绝对日期优先
  if (m.memoDate) return m.memoDate;
  const mmdd = (m.memoMmdd ?? "").trim();
  if (!mmdd) return null;
  const [mm, dd] = mmdd.split("-");
  const y = parseInt(fromYmd.slice(0, 4), 10);
  let candidate = `${y}-${mm}-${dd}`;
  if (candidate < fromYmd) candidate = `${y + 1}-${mm}-${dd}`;
  return candidate;
}
