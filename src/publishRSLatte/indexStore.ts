import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { PublishIndexFile } from "../types/publishTypes";

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
      throw new Error(`PublishIndexStore: path conflicts with an existing file: ${cur}`);
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
    throw new Error(`PublishIndexStore: file path conflicts with an existing folder: ${norm}`);
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

export class PublishIndexStore {
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
  }

  private indexPath(): string {
    const dir = this.getBaseDir();
    return normalizePath(`${dir}/publish-index.json`);
  }

  public async readIndex(): Promise<PublishIndexFile> {
    const p = this.indexPath();
    const fallback: PublishIndexFile = { version: 1, updatedAt: nowIso(), items: [] };
    try {
      if (await this.app.vault.adapter.exists(p)) return readJsonFile(this.app, p, fallback);
    } catch {
      // ignore
    }
    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/publish-index.json`);
      try {
        if (await this.app.vault.adapter.exists(legacyPath)) return readJsonFile(this.app, legacyPath, fallback);
      } catch {
        // ignore
      }
    }
    return fallback;
  }

  public async writeIndex(file: PublishIndexFile): Promise<void> {
    const p = this.indexPath();
    const out: PublishIndexFile = {
      version: 1,
      updatedAt: nowIso(),
      items: file.items ?? [],
    };
    await writeJsonFile(this.app, p, out);
  }
}
