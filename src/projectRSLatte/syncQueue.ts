import { toIsoNow } from "../taskRSLatte/utils";
import type { ProjectSyncOp, ProjectSyncQueueFile } from "./types";
import { ProjectIndexStore } from "./indexStore";
import { fnv1a32, randomUUID } from "../utils/hash";

const MAX_BACKOFF_MS = 60 * 60 * 1000; // 1h

function nowMs() { return Date.now(); }

function computeBackoffMs(tries: number) {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, Math.min(tries, 10))); // 1s..1024s..cap
  const jitter = Math.floor(Math.random() * 500);
  return base + jitter;
}

function opKey(kind: ProjectSyncOp["kind"], projectId: string): string {
  return `${kind}|${projectId}`;
}

function stableOpId(kind: ProjectSyncOp["kind"], projectId: string, snapshotKey?: string): string {
  // Deterministic-ish id for idempotency: key + snapshotKey hash
  const key = opKey(kind, projectId);
  const h = fnv1a32(`${key}|${snapshotKey ?? ""}`);
  // UUID-like but stable enough
  const hex = (h + fnv1a32(`x|${key}`) + fnv1a32(`y|${key}`) + fnv1a32(`z|${key}`)).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}` || randomUUID();
}

export class ProjectSyncQueue {
  private _q: ProjectSyncQueueFile | null = null;

  constructor(private store: ProjectIndexStore) {}

  private async loadQ(): Promise<ProjectSyncQueueFile> {
    if (this._q) return this._q;
    const f = await this.store.readQueue();
    this._q = { version: 1, updatedAt: f.updatedAt || toIsoNow(), ops: (f.ops ?? []) as ProjectSyncOp[] };
    // normalize
    const _now = nowMs();
    this._q.ops = (this._q.ops ?? []).map((o) => {
      const rawTry = Number((o as any).try_count ?? 0);
      const rawNext = Number((o as any).next_retry_at);
      // sanitize next_retry_at: older queue files may store "" which becomes 0 -> causes endless 500ms flush loop
      const next = Number.isFinite(rawNext) && rawNext > 0 ? rawNext : _now;
      return {
        ...o,
        project_id: String((o as any).project_id || "").trim(),
        enqueued_at: (o as any).enqueued_at || toIsoNow(),
        try_count: Number.isFinite(rawTry) && rawTry >= 0 ? rawTry : 0,
        next_retry_at: next,
      } as ProjectSyncOp;
    }) as ProjectSyncOp[];
    return this._q;
  }

  private async saveQ(q: ProjectSyncQueueFile): Promise<void> {
    q.updatedAt = toIsoNow();
    await this.store.writeQueue(q.ops ?? []);
  }

  public async listAll(): Promise<ProjectSyncOp[]> {
    const q = await this.loadQ();
    return q.ops ?? [];
  }

  public async size(): Promise<number> {
    const q = await this.loadQ();
    return (q.ops ?? []).length;
  }

  public async hasProject(projectId: string): Promise<boolean> {
    const pid = String(projectId || "").trim();
    if (!pid) return false;
    const q = await this.loadQ();
    return (q.ops ?? []).some((o) => String(o.project_id) === pid);
  }

  /**
   * Enqueue or update (upsert) an op by (kind, project_id).
   * - default: do NOT reset next_retry_at/backoff, to avoid infinite request loops
   * - forceDue: move next_retry_at to now
   */
  public async enqueue(kind: ProjectSyncOp["kind"], projectId: string, payload: any, opts?: { snapshotKey?: string; forceDue?: boolean }): Promise<string> {
    const q = await this.loadQ();
    const pid = String(projectId || "").trim();
    if (!pid) return "";

    const key = opKey(kind, pid);
    const ops = q.ops ?? [];
    const idx = ops.findIndex((o) => opKey(o.kind, o.project_id) === key);

    const snapshotKey = opts?.snapshotKey;
    const now = nowMs();

    if (idx >= 0) {
      const cur = ops[idx] as any;
      ops[idx] = {
        ...(cur as any),
        payload,
        snapshot_key: snapshotKey ?? cur.snapshot_key,
        // keep backoff schedule unless forceDue
        next_retry_at: opts?.forceDue ? now : Number(cur.next_retry_at ?? now),
      } as ProjectSyncOp;
      q.ops = ops;
      await this.saveQ(q);
      return String((cur as any).op_id || "");
    }

    const opId = stableOpId(kind, pid, snapshotKey);
    const op: ProjectSyncOp = {
      op_id: opId,
      kind,
      project_id: pid,
      payload,
      enqueued_at: toIsoNow(),
      snapshot_key: snapshotKey,
      try_count: 0,
      next_retry_at: now,
    } as any;

    q.ops = [...ops, op];
    await this.saveQ(q);
    return opId;
  }

  /** Keep only the latest op for each (kind, project_id). */
  public async compact(): Promise<void> {
    const q = await this.loadQ();
    const ops = q.ops ?? [];
    const last = new Map<string, number>();
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i];
      last.set(opKey(o.kind, o.project_id), i);
    }
    const keep: ProjectSyncOp[] = [];
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i];
      if (last.get(opKey(o.kind, o.project_id)) !== i) continue;
      keep.push(o);
    }
    q.ops = keep;
    await this.saveQ(q);
  }

  public async pickDue(limit: number, opts?: { force?: boolean }): Promise<ProjectSyncOp[]> {
    const q = await this.loadQ();
    const now = nowMs();
    const ops = (q.ops ?? []) as ProjectSyncOp[];
    const due = opts?.force
      ? [...ops].sort((a: any, b: any) => Number(a.next_retry_at ?? 0) - Number(b.next_retry_at ?? 0))
      : ops.filter((o: any) => Number(o.next_retry_at ?? 0) <= now);
    return due.slice(0, Math.max(1, Number(limit) || 1));
  }

  public async markSuccess(opId: string): Promise<void> {
    const q = await this.loadQ();
    q.ops = (q.ops ?? []).filter((o) => o.op_id !== opId);
    await this.saveQ(q);
  }

  public async markFailure(opId: string, err: string, maxTries: number): Promise<void> {
    const q = await this.loadQ();
    const ops = q.ops ?? [];
    const idx = ops.findIndex((o) => o.op_id === opId);
    if (idx < 0) return;

    const cur: any = ops[idx];
    const tries = Number(cur.try_count ?? 0) + 1;
    const now = nowMs();
    if (tries >= maxTries) {
      ops[idx] = { ...cur, try_count: tries, next_retry_at: Number.MAX_SAFE_INTEGER, last_error: err, last_try_at: toIsoNow() } as ProjectSyncOp;
    } else {
      const delay = computeBackoffMs(tries);
      ops[idx] = { ...cur, try_count: tries, next_retry_at: now + delay, last_error: err, last_try_at: toIsoNow() } as ProjectSyncOp;
    }

    q.ops = ops;
    await this.saveQ(q);
  }

  /**
   * @returns earliest next_retry_at among all ops, or null when queue is empty.
   *
   * IMPORTANT: returning Number.MAX_SAFE_INTEGER for empty queue will overflow
   * setTimeout() delay coercion (ToInt32) and can cause a fast refresh loop.
   */
  public async nextRetryAt(): Promise<number | null> {
    const ops = await this.listAll();
    if (!ops.length) return null;

    let min = Number.MAX_SAFE_INTEGER;
    for (const o of ops) {
      const t = Number((o as any).next_retry_at ?? Number.MAX_SAFE_INTEGER);
      if (Number.isFinite(t) && t < min) min = t;
    }
    return min === Number.MAX_SAFE_INTEGER ? null : min;
  }
}
