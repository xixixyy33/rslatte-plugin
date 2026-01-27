import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { OutputIndexFile, OutputIndexItem } from "../types/outputTypes";

export type OutputArchiveMapFile = {
  version: number;
  updatedAt: string;
  /**
   * Map from file path to month key (YYYY-MM) where it was archived
   */
  map: Record<string, string>; // filePath -> monthKey
};

export type OutputSyncStateItem = {
  filePath: string;
  mtimeMs?: number;
  status?: string;
  type?: string;
  tagsHash?: string;
  domainsHash?: string;

  /** DB 同步状态（用于失败重试与排障） */
  dbSyncState?: "pending" | "ok" | "failed";
  dbLastError?: string;
  dbRetryCount?: number;
  dbLastTriedAt?: string;
  dbLastOkAt?: string;
};

export type OutputSyncStateFile = {
  version: number;
  updatedAt: string;
  byId: Record<string, OutputSyncStateItem>;
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
    if (af && af instanceof TFile) {
      throw new Error(`OutputIndexStore: path conflicts with an existing file: ${cur}`);
    }
    if (!af) {
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

async function readJsonFile<T>(app: App, path: string, fallback: T): Promise<T> {
  const norm = normalizePath(path);

  const af = app.vault.getAbstractFileByPath(norm);
  if (af instanceof TFile) {
    try {
      const raw = await app.vault.read(af);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  }

  try {
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

  const content = JSON.stringify(obj, null, 2);
  const existing = app.vault.getAbstractFileByPath(norm);

  if (existing instanceof TFile) {
    await app.vault.modify(existing, content);
    return;
  }
  if (existing instanceof TFolder) {
    throw new Error(`OutputIndexStore: file path conflicts with an existing folder: ${norm}`);
  }

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
      await app.vault.adapter.write(norm, content);
      return;
    }
    throw e;
  }
}

export class OutputIndexStore {
  constructor(private app: App, private baseDir: string) {}

  public getBaseDir(): string {
    return normalizePath((this.baseDir ?? "").trim() || "95-Tasks/.rslatte");
  }

  /**
   * F2 best-effort legacy root (pre-space, pre-bucketing): <centralRoot>
   * - new baseDir pattern: <centralRoot>/<spaceId>/index
   */
  private getLegacyRootDir(): string | null {
    const dir = this.getBaseDir();
    const parts = dir.split("/").filter(Boolean);
    if (parts.length < 3) return null;
    const last = parts[parts.length - 1];
    if (last !== "index") return null;
    const spaceId = parts[parts.length - 2];
    if (!/^[0-9a-fA-F-]{32,36}$/.test(spaceId) || spaceId.indexOf("-") < 0) return null;
    return normalizePath(parts.slice(0, -2).join("/"));
  }

  public async ensureLayout(): Promise<void> {
    const dir = this.getBaseDir();
    await ensureFolder(this.app, dir);
    await ensureFolder(this.app, `${dir}/archive`);
  }

  private indexPath(): string {
    const dir = this.getBaseDir();
    return normalizePath(`${dir}/output-index.json`);
  }

  private syncStatePath(): string {
    const dir = this.getBaseDir();
    return normalizePath(`${dir}/output-sync-state.json`);
  }

  public async readIndex(): Promise<OutputIndexFile> {
    const p = this.indexPath();
    const fallback: OutputIndexFile = { version: 2, updatedAt: nowIso(), items: [], cancelledArchiveDirs: [] };
    try {
      if (await this.app.vault.adapter.exists(p)) return readJsonFile(this.app, p, fallback);
    } catch {
      // ignore
    }
    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/output-index.json`);
      try {
        if (await this.app.vault.adapter.exists(legacyPath)) return readJsonFile(this.app, legacyPath, fallback);
      } catch {
        // ignore
      }
    }
    return fallback;
  }

  public async writeIndex(file: OutputIndexFile): Promise<void> {
    const p = this.indexPath();
    const out: OutputIndexFile = {
      version: 2,
      updatedAt: nowIso(),
      items: file.items ?? [],
      cancelledArchiveDirs: (file as any).cancelledArchiveDirs ?? [],
    };
    await writeJsonFile(this.app, p, out);
  }

  public async readSyncState(): Promise<OutputSyncStateFile> {
    const p = this.syncStatePath();
    const fallback: OutputSyncStateFile = { version: 1, updatedAt: nowIso(), byId: {} };
    try {
      if (await this.app.vault.adapter.exists(p)) return readJsonFile(this.app, p, fallback);
    } catch {
      // ignore
    }
    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/output-sync-state.json`);
      try {
        if (await this.app.vault.adapter.exists(legacyPath)) return readJsonFile(this.app, legacyPath, fallback);
      } catch {
        // ignore
      }
    }
    return fallback;
  }

  public async writeSyncState(state: OutputSyncStateFile): Promise<void> {
    const p = this.syncStatePath();
    const out: OutputSyncStateFile = {
      version: 1,
      updatedAt: nowIso(),
      byId: state.byId ?? {},
    };
    await writeJsonFile(this.app, p, out);
  }

  private archiveMapPath(): string {
    const dir = this.getBaseDir();
    return normalizePath(`${dir}/archive/archive-map.json`);
  }

  public async readArchiveMap(): Promise<OutputArchiveMapFile> {
    const p = this.archiveMapPath();
    const fallback: OutputArchiveMapFile = { version: 1, updatedAt: nowIso(), map: {} };
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

  public async writeArchiveMap(m: OutputArchiveMapFile): Promise<void> {
    const p = this.archiveMapPath();
    const out: OutputArchiveMapFile = { version: 1, updatedAt: nowIso(), map: m.map ?? {} };
    await writeJsonFile(this.app, p, out);
  }

  private archivePath(monthKey: string): string {
    const dir = this.getBaseDir();
    return normalizePath(`${dir}/archive/output-archive-${monthKey}.json`);
  }

  public async appendToArchive(monthKey: string, items: OutputIndexItem[]): Promise<number> {
    const p = this.archivePath(monthKey);
    const existed = await readJsonFile<OutputIndexFile>(this.app, p, { version: 2, updatedAt: nowIso(), items: [], cancelledArchiveDirs: [] });
    
    // Deduplicate defensively by filePath
    const existingPaths = new Set<string>();
    for (const it of existed.items ?? []) {
      const path = String(it.filePath ?? "").trim();
      if (path) existingPaths.add(path);
    }

    const toAdd: OutputIndexItem[] = [];
    for (const it of items ?? []) {
      const path = String(it.filePath ?? "").trim();
      if (path && !existingPaths.has(path)) {
        toAdd.push(it);
        existingPaths.add(path);
      }
    }

    if (toAdd.length === 0) return 0;

    const updated: OutputIndexFile = {
      version: 2,
      updatedAt: nowIso(),
      items: [...(existed.items ?? []), ...toAdd],
      cancelledArchiveDirs: existed.cancelledArchiveDirs ?? [],
    };

    await writeJsonFile(this.app, p, updated);
    return toAdd.length;
  }
}
