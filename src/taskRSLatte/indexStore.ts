import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { RSLatteIndexFile, RSLatteIndexItem, RSLatteItemType, RSLatteScanCacheFile, SyncQueueFile } from "./types";

export type ArchiveMapFile = {
  version: number;
  updatedAt: string;
  /**
   * A stable set of archived keys.
   *
   * Key format is defined by archiver/service. Recommended:
   * - With DB id:    "task:<tid>" / "memo:<mid>"
   * - Without DB id: "task:fp=<file>#<line>#<hash>" (hash should be source_hash)
   */
  keys: Record<string, string>; // key -> monthKey (YYYY-MM)
};

function nowIso() {
  return new Date().toISOString();
}

async function ensureFolder(app: App, path: string) {
  const norm = normalizePath(path).replace(/\/+$/g, "");
  if (!norm) return;

  const parts = norm.split("/").filter(Boolean);
  let cur = "";
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p;
    const af = app.vault.getAbstractFileByPath(cur);
    // If a file already occupies this path, folder creation will always fail.
    if (af && af instanceof TFile) {
      throw new Error(`RSLatteIndexStore: path conflicts with an existing file: ${cur}`);
    }
    if (!af) {
      try {
        await app.vault.createFolder(cur);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        // Obsidian may throw even if the folder was created concurrently in another call.
        if (msg.includes("Folder already exists") || msg.includes("EEXIST")) {
          continue;
        }
        throw e;
      }
    }
  }
}


async function ensureFile(app: App, path: string, initialContent: string): Promise<TFile> {
  const norm = normalizePath(path);
  const af = app.vault.getAbstractFileByPath(norm);

  if (af instanceof TFile) return af;
  if (af instanceof TFolder) {
    throw new Error(`RSLatteIndexStore: file path conflicts with an existing folder: ${norm}`);
  }

  // Ensure parent folders exist
  await ensureFolder(app, norm.split("/").slice(0, -1).join("/"));

  try {
    return await app.vault.create(norm, initialContent);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.includes("File already exists") || msg.includes("EEXIST")) {
      const af2 = app.vault.getAbstractFileByPath(norm);
      if (af2 instanceof TFile) return af2;
    }
    throw e;
  }
}

async function readJsonFile<T>(app: App, path: string, fallback: T): Promise<T> {
  const norm = normalizePath(path);

  // 1) Try via vault (requires a TFile in the in-memory file map)
  const af = app.vault.getAbstractFileByPath(norm);
  if (af instanceof TFile) {
    try {
      const raw = await app.vault.read(af);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  }

  // 2) During very early onload, Obsidian's file map may not yet contain the file.
  //    Fall back to adapter read so we don't crash on "File already exists" races.
  try {
    // adapter.exists is cheap and avoids throwing on read
    const exists = await app.vault.adapter.exists(norm);
    if (!exists) return fallback;
    const raw = await app.vault.adapter.read(norm);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(app: App, path: string, obj: any): Promise<void> {
  const norm = normalizePath(path);
  await ensureFolder(app, norm.split("/").slice(0, -1).join("/"));

  const existing = app.vault.getAbstractFileByPath(norm);
  const content = JSON.stringify(obj, null, 2);

  if (existing instanceof TFile) {
    await app.vault.modify(existing, content);
    return;
  }
  if (existing instanceof TFolder) {
    throw new Error(`RSLatteIndexStore: file path conflicts with an existing folder: ${norm}`);
  }

  // Create with race-safety
  try {
    await app.vault.create(norm, content);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.includes("File already exists") || msg.includes("EEXIST")) {
      const af2 = app.vault.getAbstractFileByPath(norm);
      if (af2 instanceof TFile) {
        await app.vault.modify(af2, content);
        return;
      }

      // Obsidian may know the file exists (adapter), but not yet expose it as a TFile.
      // Write via adapter to make the operation idempotent and avoid init failure.
      await app.vault.adapter.write(norm, content);
      return;
    }
    throw e;
  }
}

export class RSLatteIndexStore {
  private app: App;
  /** index base dir (F2 layout: <centralRoot>/<spaceId>/index) */
  private indexDir: string;
  /** queue base dir (F2 layout: <centralRoot>/<spaceId>/queue/<module>) */
  private queueDir: string;

  constructor(app: App, indexDir: string, queueDir?: string) {
    this.app = app;
    this.indexDir = String(indexDir ?? "");
    this.queueDir = String(queueDir ?? indexDir ?? "");
  }

  public getBaseDir(): string {
    return normalizePath((this.indexDir ?? "").trim() || "95-Tasks/.rslatte");
  }

  public getQueueDir(): string {
    return normalizePath((this.queueDir ?? "").trim() || this.getBaseDir());
  }

  /**
   * F2 best-effort legacy root (pre-space, pre-bucketing): <centralRoot>
   * - new indexDir pattern: <centralRoot>/<spaceId>/index
   */
  private getLegacyRootDir(): string | null {
    const dir = this.getBaseDir();
    const parts = dir.split("/").filter(Boolean);
    if (parts.length < 3) return null;
    const last = parts[parts.length - 1];
    if (last !== "index") return null;
    const spaceId = parts[parts.length - 2];
    // uuid-like check (best-effort)
    if (!/^[0-9a-fA-F-]{32,36}$/.test(spaceId) || spaceId.indexOf("-") < 0) return null;
    return normalizePath(parts.slice(0, -2).join("/"));
  }

  public async ensureLayout(): Promise<void> {
    const dir = this.getBaseDir();
    await ensureFolder(this.app, dir);
    await ensureFolder(this.app, normalizePath(`${dir}/archive`));
    const qdir = this.getQueueDir();
    if (qdir && qdir !== dir) await ensureFolder(this.app, qdir);
  }

  private indexPath(type: RSLatteItemType): string {
    const dir = this.getBaseDir();
    return normalizePath(`${dir}/${type === "task" ? "task-index.json" : "memo-index.json"}`);
  }

  private queuePath(): string {
    const dir = this.getQueueDir();
    return normalizePath(`${dir}/sync-queue.json`);
  }

  private archiveMapPath(): string {
    const dir = this.getBaseDir();
    return normalizePath(`${dir}/archive/archive-map.json`);
  }

  private scanCachePath(): string {
    const dir = this.getBaseDir();
    return normalizePath(`${dir}/scan-cache.json`);
  }

  public async readIndex(type: RSLatteItemType): Promise<RSLatteIndexFile> {
    const p = this.indexPath(type);
    const fallback: RSLatteIndexFile = { version: 1, updatedAt: nowIso(), items: [] };
    try {
      if (await this.app.vault.adapter.exists(p)) {
        return readJsonFile(this.app, p, fallback);
      }
    } catch {
      // ignore
    }

    // F2 fallback: legacy (pre-space) central root
    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/${type === "task" ? "task-index.json" : "memo-index.json"}`);
      try {
        if (await this.app.vault.adapter.exists(legacyPath)) {
          return readJsonFile(this.app, legacyPath, fallback);
        }
      } catch {
        // ignore
      }
    }

    return fallback;
  }

  public async readArchiveMap(): Promise<ArchiveMapFile> {
    const p = this.archiveMapPath();
    const fallback: ArchiveMapFile = { version: 1, updatedAt: nowIso(), keys: {} };
    try {
      if (await this.app.vault.adapter.exists(p)) return readJsonFile(this.app, p, fallback);
    } catch {
      // ignore
    }

    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/archive/archive-map.json`);
      try {
        if (await this.app.vault.adapter.exists(legacyPath)) return readJsonFile(this.app, legacyPath, fallback);
      } catch {
        // ignore
      }
    }
    return fallback;
  }

  public async writeArchiveMap(m: ArchiveMapFile): Promise<void> {
    const p = this.archiveMapPath();
    const out: ArchiveMapFile = { version: 1, updatedAt: nowIso(), keys: m.keys ?? {} };
    await writeJsonFile(this.app, p, out);
  }

  public async writeIndex(type: RSLatteItemType, file: RSLatteIndexFile): Promise<void> {
    const p = this.indexPath(type);
    const out: RSLatteIndexFile = {
      version: 1,
      updatedAt: nowIso(),
      items: file.items ?? [],
    };
    await writeJsonFile(this.app, p, out);
  }

  public async readQueue(): Promise<SyncQueueFile> {
    const p = this.queuePath();
    const fallback: SyncQueueFile = { version: 1, updatedAt: nowIso(), ops: [] };
    try {
      if (await this.app.vault.adapter.exists(p)) return readJsonFile(this.app, p, fallback);
    } catch {
      // ignore
    }

    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/sync-queue.json`);
      try {
        if (await this.app.vault.adapter.exists(legacyPath)) return readJsonFile(this.app, legacyPath, fallback);
      } catch {
        // ignore
      }
    }
    return fallback;
  }

  public async writeQueue(q: SyncQueueFile): Promise<void> {
    const p = this.queuePath();
    const out: SyncQueueFile = { version: 1, updatedAt: nowIso(), ops: q.ops ?? [] };
    await writeJsonFile(this.app, p, out);
  }

  public async readScanCache(): Promise<RSLatteScanCacheFile> {
    const p = this.scanCachePath();
    const fallback: RSLatteScanCacheFile = { version: 1, updatedAt: nowIso(), filterKey: "", files: {} };
    try {
      if (await this.app.vault.adapter.exists(p)) return readJsonFile(this.app, p, fallback);
    } catch {
      // ignore
    }

    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/scan-cache.json`);
      try {
        if (await this.app.vault.adapter.exists(legacyPath)) return readJsonFile(this.app, legacyPath, fallback);
      } catch {
        // ignore
      }
    }
    return fallback;
  }

  public async writeScanCache(c: RSLatteScanCacheFile): Promise<void> {
    const p = this.scanCachePath();
    const out: RSLatteScanCacheFile = {
      version: 1,
      updatedAt: nowIso(),
      filterKey: c.filterKey || "",
      files: c.files ?? {},
    };
    await writeJsonFile(this.app, p, out);
  }

  public archivePath(monthKey: string, type: RSLatteItemType): string {
    const dir = this.getBaseDir();
    const name = type === "task" ? `task-archive-${monthKey}.json` : `memo-archive-${monthKey}.json`;
    return normalizePath(`${dir}/archive/${name}`);
  }

  public async appendToArchive(monthKey: string, type: RSLatteItemType, items: RSLatteIndexItem[]): Promise<void> {
    const p = this.archivePath(monthKey, type);
    const existed = await readJsonFile<RSLatteIndexFile>(this.app, p, { version: 1, updatedAt: nowIso(), items: [] });
    // Deduplicate defensively. Some flows may attempt to archive the same closed tasks again
    // (e.g. because the original tasks remain in journals and get re-scanned).
    const keyOf = (it: any): string => {
      const id = it?.itemId ?? it?.tid ?? it?.mid;
      if (id != null) return `${type}:${id}`;
      const fp = String(it?.filePath ?? "");
      const ln = String(it?.lineNo ?? "");
      const h = String(it?.sourceHash ?? it?.source_hash ?? "");
      return `${type}:fp=${fp}#${ln}#${h}`;
    };

    const existingKeys = new Set<string>();
    for (const it of existed.items ?? []) existingKeys.add(keyOf(it));

    const toAdd: RSLatteIndexItem[] = [];
    for (const it of items ?? []) {
      const k = keyOf(it);
      if (existingKeys.has(k)) continue;
      existingKeys.add(k);
      toAdd.push(it);
    }

    if (!toAdd.length) return;
    const merged = [...(existed.items ?? []), ...toAdd];
    await writeJsonFile(this.app, p, { version: 1, updatedAt: nowIso(), items: merged });
  }
}
