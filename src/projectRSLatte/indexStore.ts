import { App, normalizePath } from "obsidian";
import type { ProjectRSLatteArchiveMap, ProjectRSLatteIndexFile, ProjectRSLatteIndexItem, ProjectSyncQueueFile } from "./types";
import { safeJsonParse, toIsoNow } from "../taskRSLatte/utils";

async function ensureFolder(app: App, path: string): Promise<void> {
  const p = normalizePath(path);
  if (!p) return;
  const exists = await app.vault.adapter.exists(p);
  if (exists) return;
  // create parent first
  const parts = p.split("/");
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    const e = await app.vault.adapter.exists(cur);
    if (!e) await app.vault.adapter.mkdir(cur);
  }
}

async function readTextFile(app: App, path: string, fallback: string = ""): Promise<string> {
  const p = normalizePath(path);
  if (!p) return fallback;
  try {
    const ok = await app.vault.adapter.exists(p);
    if (!ok) return fallback;
    return await app.vault.adapter.read(p);
  } catch {
    return fallback;
  }
}

async function writeTextFile(app: App, path: string, content: string): Promise<void> {
  const p = normalizePath(path);
  await ensureFolder(app, p.split("/").slice(0, -1).join("/"));
  await app.vault.adapter.write(p, content ?? "");
}

async function readJsonFile<T>(app: App, path: string, fallback: T): Promise<T> {
  const txt = await readTextFile(app, path, "");
  if (!txt) return fallback;
  return safeJsonParse<T>(txt, fallback);
}

async function writeJsonFile(app: App, path: string, obj: any): Promise<void> {
  await writeTextFile(app, path, JSON.stringify(obj ?? {}, null, 2));
}

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
    return normalizePath((this.indexDir || "").trim() || "95-Tasks/.rslatte");
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
    await ensureFolder(this.app, dir);
    await ensureFolder(this.app, `${dir}/archive`);
    await ensureFolder(this.app, this.getQueueDir());
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
    try {
      if (await this.app.vault.adapter.exists(p)) return readJsonFile<ProjectRSLatteIndexFile>(this.app, p, fallback);
    } catch {
      // ignore
    }
    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/project-index.json`);
      try {
        if (await this.app.vault.adapter.exists(legacyPath)) return readJsonFile<ProjectRSLatteIndexFile>(this.app, legacyPath, fallback);
      } catch {
        // ignore
      }
    }
    return fallback;
  }

  public async writeIndex(items: ProjectRSLatteIndexItem[]): Promise<void> {
    await writeJsonFile(this.app, this.indexPath(), { version: 1, updatedAt: toIsoNow(), items: items ?? [] });
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
    try {
      if (await this.app.vault.adapter.exists(p)) return readJsonFile<ProjectRSLatteArchiveMap>(this.app, p, fallback);
    } catch {
      // ignore
    }
    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/project-archive-map.json`);
      try {
        if (await this.app.vault.adapter.exists(legacyPath)) return readJsonFile<ProjectRSLatteArchiveMap>(this.app, legacyPath, fallback);
      } catch {
        // ignore
      }
    }
    return fallback;
  }

  public async writeArchiveMap(map: Record<string, string>): Promise<void> {
    await writeJsonFile(this.app, this.archiveMapPath(), { version: 1, updatedAt: toIsoNow(), map: map ?? {} });
  }

  public async appendToArchive(monthKey: string, items: ProjectRSLatteIndexItem[]): Promise<number> {
    const p = this.archivePath(monthKey);
    const existed = await readJsonFile<ProjectRSLatteIndexFile>(this.app, p, { version: 1, updatedAt: toIsoNow(), items: [] });
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
    await writeJsonFile(this.app, p, { version: 1, updatedAt: toIsoNow(), items: merged });
    return toAdd.length;
  }

  public async readQueue(): Promise<ProjectSyncQueueFile> {
    const p = this.queuePath();
    const fallback: ProjectSyncQueueFile = { version: 1, updatedAt: toIsoNow(), ops: [] };
    try {
      if (await this.app.vault.adapter.exists(p)) return readJsonFile<ProjectSyncQueueFile>(this.app, p, fallback);
    } catch {
      // ignore
    }
    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/project-sync-queue.json`);
      try {
        if (await this.app.vault.adapter.exists(legacyPath)) return readJsonFile<ProjectSyncQueueFile>(this.app, legacyPath, fallback);
      } catch {
        // ignore
      }
    }
    return fallback;
  }

  public async writeQueue(ops: any[]): Promise<void> {
    await writeJsonFile(this.app, this.queuePath(), { version: 1, updatedAt: toIsoNow(), ops: ops ?? [] });
  }
}
