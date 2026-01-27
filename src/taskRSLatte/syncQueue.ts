import type { RSLatteItemType, SyncQueueFile, SyncQueueOp } from "./types";
import { fnv1a32, randomUUID } from "../utils/hash";

const MAX_BACKOFF_MS = 60 * 60 * 1000; // 1h

function nowMs() { return Date.now(); }

function computeBackoffMs(tries: number) {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, Math.min(tries, 10))); // 1s..1024s..cap
  const jitter = Math.floor(Math.random() * 500);
  return base + jitter;
}

function stableUuidFrom(base: string): string {
  // Build a deterministic UUID-like string (32 hex) using 4x FNV-1a 32bit.
  // This is not cryptographically secure, but is stable and good enough for idempotency keys.
  const h1 = fnv1a32(`a|${base}`);
  const h2 = fnv1a32(`b|${base}`);
  const h3 = fnv1a32(`c|${base}`);
  const h4 = fnv1a32(`d|${base}`);
  const hex = `${h1}${h2}${h3}${h4}`.slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function opKey(
  action: SyncQueueOp["action"],
  type: RSLatteItemType,
  filePath: string,
  lineNo: number,
  uid?: string
): string {
  // v2: prefer uid as the idempotency key. This makes the queue stable
  // across line number changes (e.g. inserting meta lines).
  if (uid) return `${action}|${type}|uid=${uid}`;
  return `${action}|${type}|${filePath}|${lineNo}`;
}

export class SyncQueue {
  constructor(private load: () => Promise<SyncQueueFile>, private save: (q: SyncQueueFile) => Promise<void>) {}

  public async enqueue(action: SyncQueueOp["action"], type: RSLatteItemType, base: Omit<SyncQueueOp, "opId"|"action"|"itemType"|"tries"|"nextRetryAt">): Promise<string> {
    const q = await this.load();
    const ops = q.ops ?? [];

    // Upsert by (action, type, filePath, lineNo) to avoid infinite enqueue loops.
    const uid = (base as any)?.payload?.uid as string | undefined;
    const key = opKey(action, type, base.filePath, base.lineNo, uid);
    const idx = ops.findIndex((o) =>
      opKey(o.action, o.itemType, o.filePath, o.lineNo, (o as any)?.payload?.uid) === key
    );

    if (idx >= 0) {
      const cur = ops[idx];
      ops[idx] = {
        ...cur,
        itemId: base.itemId ?? cur.itemId,
        payload: base.payload ?? cur.payload,
        // Keep backoff schedule. Do NOT reset nextRetryAt here, otherwise
        // frequent index refreshes would override exponential backoff and
        // cause endless sync-batch calls.
        nextRetryAt: (cur.nextRetryAt ?? nowMs()),
      };
      q.ops = ops;
      await this.save(q);
      return cur.opId;
    }

    // Deterministic op_id for idempotency. Include source_hash if present.
    const src = (base as any)?.payload?.source_hash ?? (base as any)?.payload?.sourceHash ?? "";
    const opId = stableUuidFrom(`${key}|${src || ""}`) || randomUUID();

    const op: SyncQueueOp = {
      opId,
      action,
      itemType: type,
      filePath: base.filePath,
      lineNo: base.lineNo,
      itemId: base.itemId,
      payload: base.payload,
      tries: 0,
      nextRetryAt: nowMs(),
    };

    q.ops = [...ops, op];
    await this.save(q);
    return opId;
  }

  /**
   * Remove redundant create ops when an item already has a DB id.
   * - keys: filePath#lineNo
   * - sourceHashes: optional; if provided, also prune by payload.source_hash
   */
  public async pruneCreatesWithIds(type: RSLatteItemType, keys: Set<string>, sourceHashes?: Set<string>): Promise<number> {
    const q = await this.load();
    const before = q.ops ?? [];
    const after = before.filter((o) => {
      if (o.itemType !== type) return true;
      if (o.action !== "create") return true;
      const k = `${o.filePath}#${o.lineNo}`;
      if (keys.has(k)) return false;
      const sh = String((o as any)?.payload?.source_hash ?? (o as any)?.payload?.sourceHash ?? "");
      if (sourceHashes && sh && sourceHashes.has(sh)) return false;
      return true;
    });
    q.ops = after;
    if (after.length !== before.length) {
      await this.save(q);
    }
    return before.length - after.length;
  }



  /**
   * Revive ops that have been marked as "give up" (nextRetryAt = MAX_SAFE_INTEGER).
   * Intended to be called on manual refresh so the user can retry failed sync.
   */
  public async reviveDeadOps(): Promise<number> {
    const q = await this.load();
    const ops = q.ops ?? [];
    const now = nowMs();
    let revived = 0;

    q.ops = ops.map((o) => {
      if ((o.nextRetryAt ?? 0) === Number.MAX_SAFE_INTEGER) {
        revived++;
        return { ...o, tries: 0, nextRetryAt: now };
      }
      return o;
    });

    if (revived > 0) {
      q.updatedAt = new Date().toISOString();
      await this.save(q);
    }
    return revived;
  }



  /**
   * On manual refresh, users often expect "retry now" even if backoff is scheduled.
   * This moves all failed ops (ops with lastError) to be due immediately.
   * Does NOT reset tries.
   */
  public async bumpFailedOpsToNow(): Promise<number> {
    const q = await this.load();
    const ops = q.ops ?? [];
    const now = nowMs();
    let bumped = 0;

    q.ops = ops.map((o) => {
      if (o.lastError && (o.nextRetryAt ?? 0) > now) {
        bumped++;
        return { ...o, nextRetryAt: now };
      }
      return o;
    });

    if (bumped > 0) {
      q.updatedAt = new Date().toISOString();
      await this.save(q);
    }
    return bumped;
  }
  public async listAll(): Promise<SyncQueueOp[]> {
    const q = await this.load();
    return q.ops ?? [];
  }

  public async pickDue(limit: number): Promise<SyncQueueOp[]> {
    const q = await this.load();
    const now = nowMs();
    const due = (q.ops ?? []).filter((o) => (o.nextRetryAt ?? 0) <= now);
    return due.slice(0, Math.max(1, limit));
  }

  public async markSuccess(opId: string): Promise<void> {
    const q = await this.load();
    q.ops = (q.ops ?? []).filter((o) => o.opId !== opId);
    await this.save(q);
  }

  public async markFailure(opId: string, err: string, maxTries: number): Promise<void> {
    const q = await this.load();
    const ops = q.ops ?? [];
    const idx = ops.findIndex((o) => o.opId === opId);
    if (idx < 0) return;

    const cur = ops[idx];
    const tries = (cur.tries ?? 0) + 1;
    if (tries >= maxTries) {
      // give up (keep record as lastError but don't retry)
      ops[idx] = { ...cur, tries, nextRetryAt: Number.MAX_SAFE_INTEGER, lastError: err };
    } else {
      const delay = computeBackoffMs(tries);
      ops[idx] = { ...cur, tries, nextRetryAt: nowMs() + delay, lastError: err };
    }

    q.ops = ops;
    await this.save(q);
  }
}
