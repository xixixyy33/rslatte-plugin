import { App, normalizePath } from "obsidian";
import { ensureFolderChain, readJsonVaultFirst, writeJsonRaceSafe } from "../internal/indexJsonIo";
import type { RSLatteIndexFile, RSLatteIndexItem, RSLatteItemType, RSLatteScanCacheFile, SyncQueueFile } from "./types";

const INDEX_JSON_IO_CTX = { label: "RSLatteIndexStore" } as const;

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
    return normalizePath((this.indexDir ?? "").trim() || "00-System/.rslatte");
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
    await ensureFolderChain(this.app, dir, INDEX_JSON_IO_CTX);
    await ensureFolderChain(this.app, normalizePath(`${dir}/archive`), INDEX_JSON_IO_CTX);
    const qdir = this.getQueueDir();
    if (qdir && qdir !== dir) await ensureFolderChain(this.app, qdir, INDEX_JSON_IO_CTX);
  }

  private indexPath(type: RSLatteItemType): string {
    const dir = this.getBaseDir();
    const name =
      type === "task" ? "task-index.json" : type === "memo" ? "memo-index.json" : "schedule-index.json";
    return normalizePath(`${dir}/${name}`);
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
        return readJsonVaultFirst(this.app, p, fallback);
      }
    } catch {
      // ignore
    }

    // F2 fallback: legacy (pre-space) central root
    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyName =
        type === "task" ? "task-index.json" : type === "memo" ? "memo-index.json" : "schedule-index.json";
      const legacyPath = normalizePath(`${legacyRoot}/${legacyName}`);
      try {
        if (await this.app.vault.adapter.exists(legacyPath)) {
          return readJsonVaultFirst(this.app, legacyPath, fallback);
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
      if (await this.app.vault.adapter.exists(p)) return readJsonVaultFirst(this.app, p, fallback);
    } catch {
      // ignore
    }

    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/archive/archive-map.json`);
      try {
        if (await this.app.vault.adapter.exists(legacyPath)) return readJsonVaultFirst(this.app, legacyPath, fallback);
      } catch {
        // ignore
      }
    }
    return fallback;
  }

  public async writeArchiveMap(m: ArchiveMapFile): Promise<void> {
    const p = this.archiveMapPath();
    const out: ArchiveMapFile = { version: 1, updatedAt: nowIso(), keys: m.keys ?? {} };
    await writeJsonRaceSafe(this.app, p, out, INDEX_JSON_IO_CTX);
  }

  public async writeIndex(type: RSLatteItemType, file: RSLatteIndexFile): Promise<void> {
    const p = this.indexPath(type);
    const out: RSLatteIndexFile = {
      ...file,
      version: 1,
      updatedAt: nowIso(),
      items: file.items ?? [],
    };
    await writeJsonRaceSafe(this.app, p, out, INDEX_JSON_IO_CTX);
  }

  public async readQueue(): Promise<SyncQueueFile> {
    const p = this.queuePath();
    const fallback: SyncQueueFile = { version: 1, updatedAt: nowIso(), ops: [] };
    try {
      if (await this.app.vault.adapter.exists(p)) return readJsonVaultFirst(this.app, p, fallback);
    } catch {
      // ignore
    }

    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/sync-queue.json`);
      try {
        if (await this.app.vault.adapter.exists(legacyPath)) return readJsonVaultFirst(this.app, legacyPath, fallback);
      } catch {
        // ignore
      }
    }
    return fallback;
  }

  public async writeQueue(q: SyncQueueFile): Promise<void> {
    const p = this.queuePath();
    const out: SyncQueueFile = { version: 1, updatedAt: nowIso(), ops: q.ops ?? [] };
    await writeJsonRaceSafe(this.app, p, out, INDEX_JSON_IO_CTX);
  }

  public async readScanCache(): Promise<RSLatteScanCacheFile> {
    const p = this.scanCachePath();
    const fallback: RSLatteScanCacheFile = { version: 1, updatedAt: nowIso(), filterKey: "", files: {} };
    try {
      if (await this.app.vault.adapter.exists(p)) return readJsonVaultFirst(this.app, p, fallback);
    } catch {
      // ignore
    }

    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/scan-cache.json`);
      try {
        if (await this.app.vault.adapter.exists(legacyPath)) return readJsonVaultFirst(this.app, legacyPath, fallback);
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
    await writeJsonRaceSafe(this.app, p, out, INDEX_JSON_IO_CTX);
  }

  public archivePath(monthKey: string, type: RSLatteItemType): string {
    const dir = this.getBaseDir();
    const name =
      type === "task"
        ? `task-archive-${monthKey}.json`
        : type === "memo"
          ? `memo-archive-${monthKey}.json`
          : `schedule-archive-${monthKey}.json`;
    return normalizePath(`${dir}/archive/${name}`);
  }

  public async appendToArchive(monthKey: string, type: RSLatteItemType, items: RSLatteIndexItem[]): Promise<void> {
    const p = this.archivePath(monthKey, type);
    const existed = await readJsonVaultFirst<RSLatteIndexFile>(this.app, p, { version: 1, updatedAt: nowIso(), items: [] });
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
    await writeJsonRaceSafe(this.app, p, { version: 1, updatedAt: nowIso(), items: merged }, INDEX_JSON_IO_CTX);
  }
}
