import { App, normalizePath } from "obsidian";
import { ensureFolderChain, readJsonVaultFirst, writeJsonRaceSafe } from "../internal/indexJsonIo";
import type { OutputIndexFile, OutputIndexItem } from "../types/outputTypes";
import { toLocalOffsetIsoString } from "../utils/localCalendarYmd";

const INDEX_JSON_IO_CTX = { label: "OutputIndexStore" } as const;

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
  return toLocalOffsetIsoString();
}

export class OutputIndexStore {
  constructor(private app: App, private baseDir: string) {}

  public getBaseDir(): string {
    return normalizePath((this.baseDir ?? "").trim() || "00-System/.rslatte");
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
    await ensureFolderChain(this.app, dir, INDEX_JSON_IO_CTX);
    await ensureFolderChain(this.app, `${dir}/archive`, INDEX_JSON_IO_CTX);
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
      if (await this.app.vault.adapter.exists(p)) return readJsonVaultFirst(this.app, p, fallback);
    } catch {
      // ignore
    }
    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/output-index.json`);
      try {
        if (await this.app.vault.adapter.exists(legacyPath)) return readJsonVaultFirst(this.app, legacyPath, fallback);
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
    await writeJsonRaceSafe(this.app, p, out, INDEX_JSON_IO_CTX);
  }

  public async readSyncState(): Promise<OutputSyncStateFile> {
    const p = this.syncStatePath();
    const fallback: OutputSyncStateFile = { version: 1, updatedAt: nowIso(), byId: {} };
    try {
      if (await this.app.vault.adapter.exists(p)) return readJsonVaultFirst(this.app, p, fallback);
    } catch {
      // ignore
    }
    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/output-sync-state.json`);
      try {
        if (await this.app.vault.adapter.exists(legacyPath)) return readJsonVaultFirst(this.app, legacyPath, fallback);
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
    await writeJsonRaceSafe(this.app, p, out, INDEX_JSON_IO_CTX);
  }

  private archiveMapPath(): string {
    const dir = this.getBaseDir();
    return normalizePath(`${dir}/archive/archive-map.json`);
  }

  public async readArchiveMap(): Promise<OutputArchiveMapFile> {
    const p = this.archiveMapPath();
    const fallback: OutputArchiveMapFile = { version: 1, updatedAt: nowIso(), map: {} };
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

  public async writeArchiveMap(m: OutputArchiveMapFile): Promise<void> {
    const p = this.archiveMapPath();
    const out: OutputArchiveMapFile = { version: 1, updatedAt: nowIso(), map: m.map ?? {} };
    await writeJsonRaceSafe(this.app, p, out, INDEX_JSON_IO_CTX);
  }

  private archivePath(monthKey: string): string {
    const dir = this.getBaseDir();
    return normalizePath(`${dir}/archive/output-archive-${monthKey}.json`);
  }

  public async appendToArchive(monthKey: string, items: OutputIndexItem[]): Promise<number> {
    const p = this.archivePath(monthKey);
    const existed = await readJsonVaultFirst<OutputIndexFile>(this.app, p, {
      version: 2,
      updatedAt: nowIso(),
      items: [],
      cancelledArchiveDirs: [],
    });
    
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

    await writeJsonRaceSafe(this.app, p, updated, INDEX_JSON_IO_CTX);
    return toAdd.length;
  }
}
