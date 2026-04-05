import { App, normalizePath } from "obsidian";
import type { ProjectRSLatteArchiveMap, ProjectRSLatteIndexFile, ProjectRSLatteIndexItem, ProjectSyncQueueFile } from "./types";
import { toIsoNow } from "../taskRSLatte/utils";
import {
  ensureFolderChain,
  pathExistsVaultOrAdapter,
  readJsonVaultFirst,
  writeJsonRaceSafe,
} from "../internal/indexJsonIo";

const PROJECT_INDEX_IO_CTX = { label: "ProjectIndexStore" } as const;

export class ProjectIndexStore {
  private app: App;
  private indexDir: string;
  private queueDir: string;

  constructor(app: App, indexDir: string, queueDir?: string) {
    this.app = app;
    this.indexDir = indexDir;
    this.queueDir = queueDir ?? indexDir;
  }

  public getBaseDir(): string {
    return normalizePath((this.indexDir || "").trim() || "00-System/.rslatte");
  }

  public getQueueDir(): string {
    return normalizePath((this.queueDir || "").trim() || this.getBaseDir());
  }

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
    await ensureFolderChain(this.app, dir, PROJECT_INDEX_IO_CTX);
    await ensureFolderChain(this.app, `${dir}/archive`, PROJECT_INDEX_IO_CTX);
    await ensureFolderChain(this.app, this.getQueueDir(), PROJECT_INDEX_IO_CTX);
  }

  public indexPath(): string {
    return normalizePath(`${this.getBaseDir()}/project-index.json`);
  }

  public archiveMapPath(): string {
    return normalizePath(`${this.getBaseDir()}/project-archive-map.json`);
  }

  public archivePath(monthKey: string): string {
    return normalizePath(`${this.getBaseDir()}/archive/project-archive-${monthKey}.json`);
  }

  public queuePath(): string {
    return normalizePath(`${this.getQueueDir()}/sync-queue.json`);
  }

  public async readIndex(): Promise<ProjectRSLatteIndexFile> {
    const p = this.indexPath();
    const fallback: ProjectRSLatteIndexFile = { version: 1, updatedAt: toIsoNow(), items: [] };
    if (await pathExistsVaultOrAdapter(this.app, p)) {
      return readJsonVaultFirst<ProjectRSLatteIndexFile>(this.app, p, fallback);
    }
    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/project-index.json`);
      if (await pathExistsVaultOrAdapter(this.app, legacyPath)) {
        return readJsonVaultFirst<ProjectRSLatteIndexFile>(this.app, legacyPath, fallback);
      }
    }
    return fallback;
  }

  public async writeIndex(items: ProjectRSLatteIndexItem[]): Promise<void> {
    await writeJsonRaceSafe(
      this.app,
      this.indexPath(),
      { version: 1, updatedAt: toIsoNow(), items: items ?? [] },
      PROJECT_INDEX_IO_CTX
    );
  }

  /** Patch a single index item in-place (used to record DB sync status) */
  public async patchIndexItem(projectId: string, patch: Partial<ProjectRSLatteIndexItem>): Promise<boolean> {
    const pid = String(projectId || "").trim();
    if (!pid) return false;
    const idx = await this.readIndex();
    const items = idx.items ?? [];
    const i = items.findIndex((x) => String((x as any)?.project_id ?? "").trim() === pid);
    if (i < 0) return false;
    items[i] = { ...items[i], ...(patch as any) };
    await this.writeIndex(items);
    return true;
  }

  public async readArchiveMap(): Promise<ProjectRSLatteArchiveMap> {
    const p = this.archiveMapPath();
    const fallback: ProjectRSLatteArchiveMap = { version: 1, updatedAt: toIsoNow(), map: {} };
    if (await pathExistsVaultOrAdapter(this.app, p)) {
      return readJsonVaultFirst<ProjectRSLatteArchiveMap>(this.app, p, fallback);
    }
    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/project-archive-map.json`);
      if (await pathExistsVaultOrAdapter(this.app, legacyPath)) {
        return readJsonVaultFirst<ProjectRSLatteArchiveMap>(this.app, legacyPath, fallback);
      }
    }
    return fallback;
  }

  public async writeArchiveMap(map: Record<string, string>): Promise<void> {
    await writeJsonRaceSafe(
      this.app,
      this.archiveMapPath(),
      { version: 1, updatedAt: toIsoNow(), map: map ?? {} },
      PROJECT_INDEX_IO_CTX
    );
  }

  public async appendToArchive(monthKey: string, items: ProjectRSLatteIndexItem[]): Promise<number> {
    const p = this.archivePath(monthKey);
    const existed = await readJsonVaultFirst<ProjectRSLatteIndexFile>(this.app, p, {
      version: 1,
      updatedAt: toIsoNow(),
      items: [],
    });
    const seen = new Set<string>();
    for (const it of existed.items ?? []) {
      const id = String((it as any)?.project_id ?? "");
      if (id) seen.add(id);
    }
    const toAdd: ProjectRSLatteIndexItem[] = [];
    for (const it of items ?? []) {
      const id = String((it as any)?.project_id ?? "");
      if (!id) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      toAdd.push(it);
    }
    if (!toAdd.length) return 0;
    const merged = [...(existed.items ?? []), ...toAdd];
    await writeJsonRaceSafe(this.app, p, { version: 1, updatedAt: toIsoNow(), items: merged }, PROJECT_INDEX_IO_CTX);
    return toAdd.length;
  }

  public async readQueue(): Promise<ProjectSyncQueueFile> {
    const p = this.queuePath();
    const fallback: ProjectSyncQueueFile = { version: 1, updatedAt: toIsoNow(), ops: [] };
    if (await pathExistsVaultOrAdapter(this.app, p)) {
      return readJsonVaultFirst<ProjectSyncQueueFile>(this.app, p, fallback);
    }
    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/project-sync-queue.json`);
      if (await pathExistsVaultOrAdapter(this.app, legacyPath)) {
        return readJsonVaultFirst<ProjectSyncQueueFile>(this.app, legacyPath, fallback);
      }
    }
    return fallback;
  }

  public async writeQueue(ops: any[]): Promise<void> {
    await writeJsonRaceSafe(
      this.app,
      this.queuePath(),
      { version: 1, updatedAt: toIsoNow(), ops: ops ?? [] },
      PROJECT_INDEX_IO_CTX
    );
  }
}
