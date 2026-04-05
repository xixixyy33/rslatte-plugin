import { App, normalizePath } from "obsidian";
import type { ContactsIndexFile, ContactsInteractionEntry, ContactsInteractionSourceType, ContactsInteractionsBySourceFile, ContactsInteractionsIndexFile } from "./types";
import { createEmptyContactsInteractionsIndexFile } from "./types";
import { fnv1a32, safeJsonParse, toIsoNow } from "../taskRSLatte/utils";
import { mergeInteractionEventsWithPrevious } from "../services/contacts/contactInteractionEventsMerge";
import { sortKeyLatestInteractionMs } from "../services/contacts/contactInteractionDisplay";
import { trimInteractionEventsForContactUid } from "../services/contacts/contactInteractionWindowTrim";
import { appendContactInteractionOverflowArchive } from "../services/contacts/contactInteractionArchive";
import { writeContactsInteractionReplicaSnapshot } from "../services/contacts/contactsInteractionReplica";
import { pathExistsVaultOrAdapter, readTextVaultFirst, writeTextRaceSafe } from "../internal/indexJsonIo";

const CONTACTS_INDEX_IO_CTX = { label: "ContactsIndexStore" } as const;
const CONTACTS_INTERACTIONS_IO_CTX = { label: "ContactsInteractionsStore" } as const;

export class ContactsIndexStore {
  private app: App;
  private centralIndexDirRef: () => string;

  constructor(app: App, centralIndexDirRef: () => string) {
    this.app = app;
    this.centralIndexDirRef = centralIndexDirRef;
  }

  private getBaseDir(): string {
    // ✅ Use the unified central index dir setting ("索引目录（中央索引/队列/归档）")
    const base = normalizePath((this.centralIndexDirRef() ?? "").trim() || "00-System/.rslatte");
    return base;
  }

  /**
   * F2 best-effort legacy root (pre-space, pre-bucketing): <centralRoot>
   * - new baseDir pattern: <centralRoot>/<spaceId>/index
   */
  private getLegacyRootDir(): string | null {
    const dir = this.getBaseDir();
    const parts = dir.split("/").filter(Boolean);
    if (parts.length < 3) return null;
    if (parts[parts.length - 1] !== "index") return null;
    const spaceId = parts[parts.length - 2];
    if (spaceId.length !== 36 || !spaceId.includes("-")) return null;
    return normalizePath(parts.slice(0, -2).join("/"));
  }

  private indexPath(): string {
    return normalizePath(`${this.getBaseDir()}/contacts-index.json`);
  }

  private archiveIndexPath(): string {
    // Keep consistent with other modules: archived indexes go under {centralIndexDir}/archive/
    return normalizePath(`${this.getBaseDir()}/archive/contacts-archive-index.json`);
  }

  public async readIndex(): Promise<ContactsIndexFile> {
    const p = this.indexPath();
    let raw = await readTextVaultFirst(this.app, p);
    if (!raw) {
      const legacyRoot = this.getLegacyRootDir();
      if (legacyRoot) {
        raw = await readTextVaultFirst(this.app, normalizePath(`${legacyRoot}/contacts-index.json`));
      }
    }
    const defaultIndex: ContactsIndexFile = { version: 1, updatedAt: toIsoNow(), items: [], parseErrorFiles: [] };
    const parsed = safeJsonParse(raw ?? "", defaultIndex);
    if (parsed && typeof parsed === "object" && (parsed as any).version === 1) {
      return parsed as any;
    }
    return defaultIndex;
  }

  public async readArchiveIndex(): Promise<ContactsIndexFile> {
    const p = this.archiveIndexPath();
    let raw = await readTextVaultFirst(this.app, p);
    if (!raw) {
      const legacyRoot = this.getLegacyRootDir();
      if (legacyRoot) {
        raw = await readTextVaultFirst(this.app, normalizePath(`${legacyRoot}/archive/contacts-archive-index.json`));
      }
    }
    const defaultIndex: ContactsIndexFile = { version: 1, updatedAt: toIsoNow(), items: [], parseErrorFiles: [] };
    const parsed = safeJsonParse(raw ?? "", defaultIndex);
    if (parsed && typeof parsed === "object" && (parsed as any).version === 1) {
      return parsed as any;
    }
    return defaultIndex;
  }

  public async writeIndex(file: ContactsIndexFile): Promise<void> {
    const p = this.indexPath();
    const out: ContactsIndexFile = {
      version: 1,
      updatedAt: file.updatedAt ?? toIsoNow(),
      items: file.items ?? [],
      parseErrorFiles: file.parseErrorFiles ?? [],
    };
    await writeTextRaceSafe(this.app, p, JSON.stringify(out, null, 2), CONTACTS_INDEX_IO_CTX);
  }

  public async writeArchiveIndex(file: ContactsIndexFile): Promise<void> {
    const p = this.archiveIndexPath();
    const out: ContactsIndexFile = {
      version: 1,
      updatedAt: file.updatedAt ?? toIsoNow(),
      items: file.items ?? [],
      parseErrorFiles: file.parseErrorFiles ?? [],
    };
    await writeTextRaceSafe(this.app, p, JSON.stringify(out, null, 2), CONTACTS_INDEX_IO_CTX);
  }

  public getIndexFilePath(): string {
    return this.indexPath();
  }

  public getArchiveIndexFilePath(): string {
    return this.archiveIndexPath();
  }
}

export type ContactsInteractionsContext = {
  contactsDir: string;
  trim: { maxPerContact: number; maxPerSource: number };
  archiveShardMaxBytes: number;
  /** 主索引落盘后重写联系人笔记内「动态互动」块（与侧栏同源） */
  refreshContactNoteDynamicBlocksForUids?: (uids: string[]) => Promise<void>;
  /** 将 `contacts-index.json` 的 `last_interaction_at` 与互动索引中 `interaction_events` 对齐（与侧栏「最后互动」一致） */
  syncContactsIndexLastInteractionAtForUids?: (uids: string[]) => Promise<void>;
  /**
   * 任务/项目任务条目的 interaction_events 由 WorkEvent 重放（§6.2/§6.5）；在 applyFileUpdates 合并快照后调用。
   */
  rebuildTaskProjectInteractionEventsFromWork?: (
    entries: ContactsInteractionEntry[]
  ) => Promise<ContactsInteractionEntry[]>;
};

export class ContactsInteractionsStore {
  private app: App;
  private centralIndexDirRef: () => string;
  /** 为 §6.9：主索引裁剪、溢出归档、首片 `.contacts/<uid>.json` 对齐；未提供则跳过 */
  private interactionsCtxRef?: () => ContactsInteractionsContext | null;

  constructor(app: App, centralIndexDirRef: () => string, interactionsCtxRef?: () => ContactsInteractionsContext | null) {
    this.app = app;
    this.centralIndexDirRef = centralIndexDirRef;
    this.interactionsCtxRef = interactionsCtxRef;
  }

  private getBaseDir(): string {
    const base = normalizePath((this.centralIndexDirRef() ?? "").trim() || "00-System/.rslatte");
    return base;
  }

  private getLegacyRootDir(): string | null {
    const dir = this.getBaseDir();
    const parts = dir.split("/").filter(Boolean);
    if (parts.length < 3) return null;
    if (parts[parts.length - 1] !== "index") return null;
    const spaceId = parts[parts.length - 2];
    if (spaceId.length !== 36) return null;
    return normalizePath(parts.slice(0, -2).join("/"));
  }

  private indexPath(): string {
    return normalizePath(`${this.getBaseDir()}/contacts-interactions.json`);
  }

  public async ensureExists(): Promise<void> {
    const p = this.indexPath();
    if (await pathExistsVaultOrAdapter(this.app, p)) return;

    // F2: if legacy (pre-space) file exists, migrate it forward so we don't
    // accidentally create an empty file that masks the legacy data.
    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/contacts-interactions.json`);
      try {
        if (await pathExistsVaultOrAdapter(this.app, legacyPath)) {
          const raw = await readTextVaultFirst(this.app, legacyPath);
          if (raw && raw.trim()) {
            await writeTextRaceSafe(this.app, p, raw, CONTACTS_INTERACTIONS_IO_CTX);
            return;
          }
        }
      } catch {
        // ignore
      }
    }

    const empty = createEmptyContactsInteractionsIndexFile(toIsoNow());
    await writeTextRaceSafe(this.app, p, JSON.stringify(empty, null, 2), CONTACTS_INTERACTIONS_IO_CTX);
  }

  public async readIndex(): Promise<ContactsInteractionsIndexFile> {
    const p = this.indexPath();
    let raw = await readTextVaultFirst(this.app, p);
    if (!raw) {
      const legacyRoot = this.getLegacyRootDir();
      if (legacyRoot) raw = await readTextVaultFirst(this.app, normalizePath(`${legacyRoot}/contacts-interactions.json`));
    }
    if (!raw) {
      await this.ensureExists();
      raw = await readTextVaultFirst(this.app, p);
    }
    const defaultIndex = createEmptyContactsInteractionsIndexFile(toIsoNow());
    const parsed = safeJsonParse(raw ?? "", defaultIndex);
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as any).schema_version === 1 &&
      (parsed as any).by_contact_uid &&
      (parsed as any).by_source_file
    ) {
      return parsed as any;
    }
    return defaultIndex;
  }

  public async writeIndex(file: ContactsInteractionsIndexFile): Promise<void> {
    const p = this.indexPath();
    const out: ContactsInteractionsIndexFile = {
      schema_version: 1,
      // always refresh timestamp on write
      updated_at: toIsoNow(),
      by_contact_uid: file.by_contact_uid ?? {},
      by_source_file: file.by_source_file ?? {},
    };
    await writeTextRaceSafe(this.app, p, JSON.stringify(out, null, 2), CONTACTS_INTERACTIONS_IO_CTX);
  }

  public getIndexFilePath(): string {
    return this.indexPath();
  }

  /**
   * Read-only query helper for UI.
   * - 默认按条目 updated_at desc（fallback: by_source_file.mtime）
   * - sortMode `latest_interaction`：§6.6.2 主键为 interaction_events 最大 occurred_at（动态无事件→0）；同键时按 updated_at↓，再 path 稳定序
   * - supports lightweight filtering
   */
  public async queryByContactUid(contactUid: string, opts?: {
    limit?: number;
    incompleteOnly?: boolean;
    sourceType?: ContactsInteractionSourceType | "all";
    /** 默认按条目 updated_at；侧栏「互动记录」按最后互动时刻（含 interaction_events） */
    sortMode?: "entry_updated" | "latest_interaction";
  }): Promise<ContactsInteractionEntry[]> {
    const uid = String(contactUid ?? "").trim();
    if (!uid) return [];

    const idx = await this.readIndex();
    const bucket = (idx.by_contact_uid?.[uid] ?? []).slice();
    if (bucket.length === 0) return [];

    const st = (opts?.sourceType ?? "all") as any;
    let out = bucket;
    if (st && st !== "all") {
      out = out.filter((e) => String(e.source_type ?? "") === String(st));
    }

    if (opts?.incompleteOnly) {
      out = out.filter((e) => {
        const s = String(e.status ?? "");
        // keep entries without status (best-effort)
        if (!s) return true;
        return s !== "done" && s !== "cancelled";
      });
    }

    // fallback mtime map
    const mtimeByPath: Record<string, number> = {};
    for (const [p, rec] of Object.entries(idx.by_source_file ?? {})) {
      mtimeByPath[p] = Number((rec as any)?.mtime ?? 0);
    }

    const latestMs = (e: ContactsInteractionEntry): number =>
      sortKeyLatestInteractionMs(e, mtimeByPath[e.source_path]);

    const sortMode = opts?.sortMode ?? "entry_updated";
    out.sort((a, b) => {
      const ta = sortMode === "latest_interaction" ? latestMs(a) : Date.parse(a.updated_at ?? "") || mtimeByPath[a.source_path] || 0;
      const tb = sortMode === "latest_interaction" ? latestMs(b) : Date.parse(b.updated_at ?? "") || mtimeByPath[b.source_path] || 0;
      if (tb !== ta) return tb - ta;
      if (sortMode === "latest_interaction") {
        const ua = Date.parse(a.updated_at ?? "") || mtimeByPath[a.source_path] || 0;
        const ub = Date.parse(b.updated_at ?? "") || mtimeByPath[b.source_path] || 0;
        if (ub !== ua) return ub - ua;
      }
      const ak = `${a.source_path}|${a.line_no ?? -1}`;
      const bk = `${b.source_path}|${b.line_no ?? -1}`;
      return bk.localeCompare(ak);
    });

    const limit = Math.max(1, Math.min(Number(opts?.limit ?? 20) || 20, 200));
    return out.slice(0, limit);
  }

  // -----------------------------
  // Step3: derived index updates
  // -----------------------------

  private entryKey(e: ContactsInteractionEntry): string {
    const k = String((e as any).key ?? "").trim();
    if (k) return k;
    const ln = (e.line_no ?? -1) as any;
    return `${e.contact_uid}|${e.source_path}|${e.source_type}|${ln}`;
  }

  private computeDigest(entries: ContactsInteractionEntry[]): string {
    // Stable-ish digest: only fields that affect rendering / identity.
    // NOTE: we intentionally include snippet/status so UI changes can be detected easily.
    const compact = (entries ?? []).map((e) => ({
      k: this.entryKey(e),
      s: e.status ?? "",
      sn: e.snippet ?? "",
      h: e.heading ?? "",
    }));
    return fnv1a32(JSON.stringify(compact));
  }

  private removeEntriesFromByContactUid(idx: ContactsInteractionsIndexFile, oldEntries: ContactsInteractionEntry[]): void {
    for (const e of oldEntries ?? []) {
      const uid = String(e.contact_uid ?? "").trim();
      if (!uid) continue;
      const bucket = idx.by_contact_uid[uid];
      if (!bucket || bucket.length === 0) continue;
      const key = this.entryKey(e);
      const next = bucket.filter((x) => this.entryKey(x) !== key);
      if (next.length === 0) delete idx.by_contact_uid[uid];
      else idx.by_contact_uid[uid] = next;
    }
  }

  private addEntriesIntoByContactUid(idx: ContactsInteractionsIndexFile, entries: ContactsInteractionEntry[]): void {
    for (const e of entries ?? []) {
      const uid = String(e.contact_uid ?? "").trim();
      if (!uid) continue;
      const key = this.entryKey(e);
      const bucket = idx.by_contact_uid[uid] ?? [];
      // dedupe by key
      if (!bucket.some((x) => this.entryKey(x) === key)) {
        bucket.push(e);
      } else {
        // Replace existing with new content (status/snippet updates)
        const next = bucket.map((x) => (this.entryKey(x) === key ? e : x));
        idx.by_contact_uid[uid] = next;
        continue;
      }
      idx.by_contact_uid[uid] = bucket;
    }
  }

  /**
   * Apply a batch of by_source_file updates in a single read-modify-write.
   * - upserts replace old entries for that source file
   * - removals delete the source file bucket and subtract from by_contact_uid
   */
  public async applyFileUpdates(args: {
    upserts?: Array<{ source_path: string; mtime: number; entries: ContactsInteractionEntry[] }>;
    removals?: string[];
  }): Promise<{ upserted: number; removed: number }> {
    const upserts = args.upserts ?? [];
    const removals = args.removals ?? [];
    if (upserts.length === 0 && removals.length === 0) return { upserted: 0, removed: 0 };

    const idx = await this.readIndex();
    let removedCount = 0;

    const affectedUids = new Set<string>();

    // removals：先记录涉及联系人，再删文件桶
    for (const fp of removals) {
      const path = String(fp ?? "").trim();
      if (!path) continue;
      const old = idx.by_source_file[path];
      if (!old) continue;
      for (const e of old.entries ?? []) {
        const cu = String(e.contact_uid ?? "").trim();
        if (cu) affectedUids.add(cu);
      }
      this.removeEntriesFromByContactUid(idx, old.entries ?? []);
      delete idx.by_source_file[path];
      removedCount++;
    }

    // upserts
    const nowIso = toIsoNow();
    for (const u of upserts) {
      const path = String(u.source_path ?? "").trim();
      if (!path) continue;
      const old = idx.by_source_file[path];
      if (old) this.removeEntriesFromByContactUid(idx, old.entries ?? []);

      const raw = u.entries ?? [];
      const merged = mergeInteractionEventsWithPrevious(old?.entries, raw, nowIso);
      const ctx = this.interactionsCtxRef?.() ?? null;
      let entries = merged.filter((e) => !!(e.contact_uid && e.source_path && e.source_type && e.snippet));
      if (ctx?.rebuildTaskProjectInteractionEventsFromWork) {
        try {
          entries = await ctx.rebuildTaskProjectInteractionEventsFromWork(entries);
        } catch (e) {
          console.warn("[RSLatte][contacts] rebuildTaskProjectInteractionEventsFromWork failed", e);
        }
      }
      const rec: ContactsInteractionsBySourceFile = {
        mtime: Number(u.mtime ?? 0),
        entries_digest: this.computeDigest(entries),
        entries,
      };
      idx.by_source_file[path] = rec;
      this.addEntriesIntoByContactUid(idx, entries);
      for (const e of entries) {
        const cu = String(e.contact_uid ?? "").trim();
        if (cu) affectedUids.add(cu);
      }
    }

    const ctx = this.interactionsCtxRef?.() ?? null;
    if (ctx && affectedUids.size > 0) {
      for (const uid of affectedUids) {
        const removedEv = trimInteractionEventsForContactUid(idx, uid, ctx.trim, (e) => this.entryKey(e));
        if (removedEv.length > 0) {
          try {
            await appendContactInteractionOverflowArchive(this.app, {
              contactsDir: ctx.contactsDir,
              contactUid: uid,
              records: removedEv,
              maxShardBytes: ctx.archiveShardMaxBytes,
            });
          } catch (e) {
            console.warn("[RSLatte][contacts][archive] append overflow failed", uid, e);
          }
        }
      }
    }

    await this.writeIndex(idx);

    if (ctx?.syncContactsIndexLastInteractionAtForUids && affectedUids.size > 0) {
      try {
        await ctx.syncContactsIndexLastInteractionAtForUids([...affectedUids]);
      } catch (e) {
        console.warn("[RSLatte][contacts] syncContactsIndexLastInteractionAtForUids failed", e);
      }
    }

    if (ctx && affectedUids.size > 0) {
      for (const uid of affectedUids) {
        try {
          await writeContactsInteractionReplicaSnapshot(this.app, {
            contactsDir: ctx.contactsDir,
            contactUid: uid,
            getInteractionsStore: () => this,
          });
        } catch (e) {
          console.warn("[RSLatte][contacts][replica] snapshot failed", uid, e);
        }
      }
      if (ctx.refreshContactNoteDynamicBlocksForUids) {
        try {
          await ctx.refreshContactNoteDynamicBlocksForUids([...affectedUids]);
        } catch (e) {
          console.warn("[RSLatte][contacts] refresh contact note dynamic blocks failed", e);
        }
      }
    }

    return { upserted: upserts.length, removed: removedCount };
  }

  /** Cleanup: remove entries of a given source_type whose source_path is NOT in allowedPaths. */
  public async cleanupSourceTypeNotIn(sourceType: ContactsInteractionSourceType, allowedPaths: Set<string>): Promise<number> {
    const st = String(sourceType ?? "").trim() as any;
    if (!st) return 0;
    const idx = await this.readIndex();
    const keys = Object.keys(idx.by_source_file ?? {});
    const removals: string[] = [];
    for (const fp of keys) {
      if (allowedPaths.has(fp)) continue;
      const rec = idx.by_source_file[fp];
      if (!rec || !Array.isArray(rec.entries) || rec.entries.length === 0) continue;
      if (rec.entries.some((e) => String((e as any).source_type ?? "") === st)) {
        removals.push(fp);
      }
    }
    if (removals.length === 0) return 0;
    // Reuse batch removal logic.
    await this.applyFileUpdates({ removals });
    return removals.length;
  }

  /**
   * Rewrite source_path keys after vault rename/move (e.g. diary auto-archive).
   *
   * Important: This does NOT re-parse markdown. It only rewrites stored keys so
   * UI links won't break until the next incremental scan.
   */
  public async rewriteSourcePaths(moves: Array<{ from: string; to: string }>): Promise<{ updated: number }> {
    if (!moves?.length) return { updated: 0 };

    const norm = (p: string) => normalizePath(String(p ?? "").trim());
    const pairs = moves
      .map((m) => ({ from: norm(m.from), to: norm(m.to) }))
      .filter((m) => !!m.from && !!m.to && m.from !== m.to);
    if (!pairs.length) return { updated: 0 };

    const idx = await this.readIndex();
    let updated = 0;
    const pathRewriteUids = new Set<string>();

    for (const p of pairs) {
      const oldRec = idx.by_source_file?.[p.from];
      if (!oldRec) continue;

      const existing = idx.by_source_file?.[p.to];

      // Remove old + existing(to) from by_contact_uid before re-adding merged entries
      this.removeEntriesFromByContactUid(idx, oldRec.entries ?? []);
      if (existing) this.removeEntriesFromByContactUid(idx, existing.entries ?? []);

      // Rewrite source_path in entries
      const rewritten = (oldRec.entries ?? []).map((e) => ({
        ...e,
        source_path: p.to,
      }));

      const merged = dedupeByKey([...(existing?.entries ?? []), ...rewritten], (e) => this.entryKey(e));

      // Remove old key
      delete idx.by_source_file[p.from];

      // Upsert new key with merged entries
      idx.by_source_file[p.to] = {
        mtime: Math.max(Number(existing?.mtime ?? 0), Number(oldRec.mtime ?? 0)),
        entries_digest: this.computeDigest(merged),
        entries: merged,
      };

      this.addEntriesIntoByContactUid(idx, merged);
      for (const e of merged) {
        const cu = String((e as ContactsInteractionEntry).contact_uid ?? "").trim();
        if (cu) pathRewriteUids.add(cu);
      }
      updated++;
    }

    if (updated > 0) {
      await this.writeIndex(idx);
      const ctx = this.interactionsCtxRef?.() ?? null;
      if (ctx?.syncContactsIndexLastInteractionAtForUids && pathRewriteUids.size > 0) {
        try {
          await ctx.syncContactsIndexLastInteractionAtForUids([...pathRewriteUids]);
        } catch (e) {
          console.warn("[RSLatte][contacts] syncContactsIndexLastInteractionAtForUids (rewrite paths) failed", e);
        }
      }
    }
    return { updated };
  }
}

function dedupeByKey<T>(arr: T[], keyOf: (x: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of arr) {
    const k = keyOf(x);
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}
