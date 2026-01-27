import { App, normalizePath } from "obsidian";
import type { ContactsIndexFile, ContactsInteractionEntry, ContactsInteractionSourceType, ContactsInteractionsBySourceFile, ContactsInteractionsIndexFile } from "./types";
import { createEmptyContactsInteractionsIndexFile } from "./types";
import { fnv1a32, safeJsonParse, toIsoNow } from "../taskRSLatte/utils";

async function ensureFolder(app: App, path: string): Promise<void> {
  const p = normalizePath(path);
  if (!p) return;
  const exists = await app.vault.adapter.exists(p);
  if (exists) return;

  const parts = p.split("/");
  let cur = "";
  for (const seg of parts) {
    cur = cur ? `${cur}/${seg}` : seg;
    const ok = await app.vault.adapter.exists(cur);
    if (!ok) {
      try {
        await app.vault.createFolder(cur);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (msg.includes("Folder already exists") || msg.includes("EEXIST")) continue;
        throw e;
      }
    }
  }
}

async function readTextFile(app: App, path: string): Promise<string | null> {
  try {
    const ok = await app.vault.adapter.exists(path);
    if (!ok) return null;
    return await app.vault.adapter.read(path);
  } catch {
    return null;
  }
}

async function writeTextFile(app: App, path: string, text: string): Promise<void> {
  await ensureFolder(app, path.split("/").slice(0, -1).join("/"));
  const ok = await app.vault.adapter.exists(path);
  if (ok) await app.vault.adapter.write(path, text);
  else await app.vault.create(path, text);
}

export class ContactsIndexStore {
  private app: App;
  private centralIndexDirRef: () => string;

  constructor(app: App, centralIndexDirRef: () => string) {
    this.app = app;
    this.centralIndexDirRef = centralIndexDirRef;
  }

  private getBaseDir(): string {
    // ✅ Use the unified central index dir setting ("索引目录（中央索引/队列/归档）")
    const base = normalizePath((this.centralIndexDirRef() ?? "").trim() || "95-Tasks/.rslatte");
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
    let raw = await readTextFile(this.app, p);
    if (!raw) {
      const legacyRoot = this.getLegacyRootDir();
      if (legacyRoot) {
        raw = await readTextFile(this.app, normalizePath(`${legacyRoot}/contacts-index.json`));
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
    let raw = await readTextFile(this.app, p);
    if (!raw) {
      const legacyRoot = this.getLegacyRootDir();
      if (legacyRoot) {
        raw = await readTextFile(this.app, normalizePath(`${legacyRoot}/archive/contacts-archive-index.json`));
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
    await writeTextFile(this.app, p, JSON.stringify(out, null, 2));
  }

  public async writeArchiveIndex(file: ContactsIndexFile): Promise<void> {
    const p = this.archiveIndexPath();
    const out: ContactsIndexFile = {
      version: 1,
      updatedAt: file.updatedAt ?? toIsoNow(),
      items: file.items ?? [],
      parseErrorFiles: file.parseErrorFiles ?? [],
    };
    await writeTextFile(this.app, p, JSON.stringify(out, null, 2));
  }

  public getIndexFilePath(): string {
    return this.indexPath();
  }

  public getArchiveIndexFilePath(): string {
    return this.archiveIndexPath();
  }
}

export class ContactsInteractionsStore {
  private app: App;
  private centralIndexDirRef: () => string;

  constructor(app: App, centralIndexDirRef: () => string) {
    this.app = app;
    this.centralIndexDirRef = centralIndexDirRef;
  }

  private getBaseDir(): string {
    const base = normalizePath((this.centralIndexDirRef() ?? "").trim() || "95-Tasks/.rslatte");
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
    const ok = await this.app.vault.adapter.exists(p);
    if (ok) return;

    // F2: if legacy (pre-space) file exists, migrate it forward so we don't
    // accidentally create an empty file that masks the legacy data.
    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/contacts-interactions.json`);
      try {
        const legacyOk = await this.app.vault.adapter.exists(legacyPath);
        if (legacyOk) {
          const raw = await this.app.vault.adapter.read(legacyPath);
          if (raw && raw.trim()) {
            await writeTextFile(this.app, p, raw);
            return;
          }
        }
      } catch {
        // ignore
      }
    }

    const empty = createEmptyContactsInteractionsIndexFile(toIsoNow());
    await writeTextFile(this.app, p, JSON.stringify(empty, null, 2));
  }

  public async readIndex(): Promise<ContactsInteractionsIndexFile> {
    const p = this.indexPath();
    let raw = await readTextFile(this.app, p);
    if (!raw) {
      const legacyRoot = this.getLegacyRootDir();
      if (legacyRoot) raw = await readTextFile(this.app, normalizePath(`${legacyRoot}/contacts-interactions.json`));
    }
    if (!raw) {
      await this.ensureExists();
      raw = await readTextFile(this.app, p);
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
    await writeTextFile(this.app, p, JSON.stringify(out, null, 2));
  }

  public getIndexFilePath(): string {
    return this.indexPath();
  }

  /**
   * Read-only query helper for UI.
   * - sorts by updated_at desc (fallback: by_source_file.mtime)
   * - supports lightweight filtering
   */
  public async queryByContactUid(contactUid: string, opts?: {
    limit?: number;
    incompleteOnly?: boolean;
    sourceType?: ContactsInteractionSourceType | "all";
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

    out.sort((a, b) => {
      const ta = Date.parse(a.updated_at ?? "") || mtimeByPath[a.source_path] || 0;
      const tb = Date.parse(b.updated_at ?? "") || mtimeByPath[b.source_path] || 0;
      if (tb !== ta) return tb - ta;
      // stable tie-breaker
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

    // removals
    for (const fp of removals) {
      const path = String(fp ?? "").trim();
      if (!path) continue;
      const old = idx.by_source_file[path];
      if (!old) continue;
      this.removeEntriesFromByContactUid(idx, old.entries ?? []);
      delete idx.by_source_file[path];
      removedCount++;
    }

    // upserts
    for (const u of upserts) {
      const path = String(u.source_path ?? "").trim();
      if (!path) continue;
      const old = idx.by_source_file[path];
      if (old) this.removeEntriesFromByContactUid(idx, old.entries ?? []);

      const entries = (u.entries ?? []).filter((e) => !!(e.contact_uid && e.source_path && e.source_type && e.snippet));
      const rec: ContactsInteractionsBySourceFile = {
        mtime: Number(u.mtime ?? 0),
        entries_digest: this.computeDigest(entries),
        entries,
      };
      idx.by_source_file[path] = rec;
      this.addEntriesIntoByContactUid(idx, entries);
    }

    await this.writeIndex(idx);
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
      updated++;
    }

    if (updated > 0) {
      await this.writeIndex(idx);
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
