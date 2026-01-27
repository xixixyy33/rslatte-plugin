import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { CheckinRecordIndexFile, FinanceRecordIndexFile, RSLatteListsIndexFile, FinanceStatsCacheFile, CheckinStatsCacheFile, TaskStatsCacheFile } from "../types/recordIndexTypes";

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
      throw new Error(`RecordIndexStore: path conflicts with an existing file: ${cur}`);
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
    throw new Error(`RecordIndexStore: file path conflicts with an existing folder: ${norm}`);
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

export class RecordIndexStore {
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
    await ensureFolder(this.app, normalizePath(`${dir}/archive`));
  }

  private checkinIndexPath(archived: boolean): string {
    const dir = this.getBaseDir();
    return normalizePath(`${dir}/${archived ? "archive/" : ""}checkin-record-index.json`);
  }

  private financeIndexPath(archived: boolean): string {
    const dir = this.getBaseDir();
    return normalizePath(`${dir}/${archived ? "archive/" : ""}finance-record-index.json`);
  }

  private listsIndexPath(archived: boolean): string {
    const dir = this.getBaseDir();
    return normalizePath(`${dir}/${archived ? "archive/" : ""}rslatte-lists-index.json`);
  }

  private financeStatsCachePath(): string {
    const dir = this.getBaseDir();
    return normalizePath(`${dir}/finance-stats-cache.json`);
  }

  private checkinStatsCachePath(): string {
    const dir = this.getBaseDir();
    return normalizePath(`${dir}/checkin-stats-cache.json`);
  }

  private taskStatsCachePath(): string {
    const dir = this.getBaseDir();
    return normalizePath(`${dir}/task-stats-cache.json`);
  }
  
  /**
   * 获取特定空间的打卡统计缓存路径
   * @param spaceId 空间ID
   * @param settings 插件设置（用于解析索引目录）
   */
  public static getCheckinStatsCachePathForSpace(spaceId: string, settings: any, app: App): string {
    const { resolveSpaceIndexDir } = require("../services/spaceContext");
    const indexDir = resolveSpaceIndexDir(settings, spaceId, [settings?.rslattePanelIndexDir]);
    return normalizePath(`${indexDir}/checkin-stats-cache.json`);
  }

  public async readCheckinIndex(archived: boolean): Promise<CheckinRecordIndexFile> {
    const p = this.checkinIndexPath(archived);
    const fallback: CheckinRecordIndexFile = { version: 1, updatedAt: nowIso(), items: [] };
    try {
      if (await this.app.vault.adapter.exists(p)) return readJsonFile(this.app, p, fallback);
    } catch {
      // ignore
    }

    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/${archived ? "archive/" : ""}checkin-record-index.json`);
      try {
        if (await this.app.vault.adapter.exists(legacyPath)) return readJsonFile(this.app, legacyPath, fallback);
      } catch {
        // ignore
      }
    }
    return fallback;
  }

  public async writeCheckinIndex(archived: boolean, file: CheckinRecordIndexFile): Promise<void> {
    const p = this.checkinIndexPath(archived);
    const out: CheckinRecordIndexFile = { version: 1, updatedAt: nowIso(), items: file.items ?? [] };
    await writeJsonFile(this.app, p, out);
  }

  public async readFinanceIndex(archived: boolean): Promise<FinanceRecordIndexFile> {
    const p = this.financeIndexPath(archived);
    const fallback: FinanceRecordIndexFile = { version: 1, updatedAt: nowIso(), items: [] };
    try {
      if (await this.app.vault.adapter.exists(p)) return readJsonFile(this.app, p, fallback);
    } catch {
      // ignore
    }

    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/${archived ? "archive/" : ""}finance-record-index.json`);
      try {
        if (await this.app.vault.adapter.exists(legacyPath)) return readJsonFile(this.app, legacyPath, fallback);
      } catch {
        // ignore
      }
    }
    return fallback;
  }

  public async writeFinanceIndex(archived: boolean, file: FinanceRecordIndexFile): Promise<void> {
    const p = this.financeIndexPath(archived);
    const out: FinanceRecordIndexFile = { version: 1, updatedAt: nowIso(), items: file.items ?? [] };
    await writeJsonFile(this.app, p, out);
  }

  public async readListsIndex(archived: boolean): Promise<RSLatteListsIndexFile> {
    const p = this.listsIndexPath(archived);
    const fallback: RSLatteListsIndexFile = {
      version: 1,
      updatedAt: nowIso(),
      checkinItems: [],
      financeCategories: [],
      financeSubcategoriesByCategoryId: {},
      tombstoneCheckinIds: [],
      tombstoneFinanceIds: [],
    };
    try {
      if (await this.app.vault.adapter.exists(p)) return readJsonFile(this.app, p, fallback);
    } catch {
      // ignore
    }

    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/${archived ? "archive/" : ""}rslatte-lists-index.json`);
      try {
        if (await this.app.vault.adapter.exists(legacyPath)) return readJsonFile(this.app, legacyPath, fallback);
      } catch {
        // ignore
      }
    }
    return fallback;
  }

  public async writeListsIndex(archived: boolean, file: RSLatteListsIndexFile): Promise<void> {
    const p = this.listsIndexPath(archived);
    const out: RSLatteListsIndexFile = {
      version: 1,
      updatedAt: nowIso(),
      checkinItems: file.checkinItems ?? [],
      financeCategories: file.financeCategories ?? [],
      financeSubcategoriesByCategoryId: (file as any).financeSubcategoriesByCategoryId ?? {},
      tombstoneCheckinIds: file.tombstoneCheckinIds ?? [],
      tombstoneFinanceIds: file.tombstoneFinanceIds ?? [],
    };
    await writeJsonFile(this.app, p, out);
  }

  /**
   * 读取财务统计缓存（轻量级全量数据，用于侧边栏统计）
   * - 不受归档机制影响，始终保持全量数据
   * - 只包含统计所需的最小字段
   */
  public async readFinanceStatsCache(): Promise<FinanceStatsCacheFile> {
    const p = this.financeStatsCachePath();
    const fallback: FinanceStatsCacheFile = { version: 1, updatedAt: nowIso(), items: [] };
    try {
      if (await this.app.vault.adapter.exists(p)) return readJsonFile(this.app, p, fallback);
    } catch {
      // ignore
    }

    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/finance-stats-cache.json`);
      try {
        if (await this.app.vault.adapter.exists(legacyPath)) return readJsonFile(this.app, legacyPath, fallback);
      } catch {
        // ignore
      }
    }
    return fallback;
  }

  /**
   * 写入财务统计缓存
   */
  public async writeFinanceStatsCache(file: FinanceStatsCacheFile): Promise<void> {
    const p = this.financeStatsCachePath();
    const out: FinanceStatsCacheFile = { version: 1, updatedAt: nowIso(), items: file.items ?? [] };
    await writeJsonFile(this.app, p, out);
  }

  /**
   * 读取打卡统计缓存（轻量级全量数据，用于月度统计）
   * - 不受归档机制影响，始终保持全量数据
   * - 只包含统计所需的最小字段
   */
  public async readCheckinStatsCache(): Promise<CheckinStatsCacheFile> {
    const p = this.checkinStatsCachePath();
    const fallback: CheckinStatsCacheFile = { version: 1, updatedAt: nowIso(), items: [] };
    try {
      if (await this.app.vault.adapter.exists(p)) return readJsonFile(this.app, p, fallback);
    } catch {
      // ignore
    }

    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/checkin-stats-cache.json`);
      try {
        if (await this.app.vault.adapter.exists(legacyPath)) return readJsonFile(this.app, legacyPath, fallback);
      } catch {
        // ignore
      }
    }
    return fallback;
  }

  /**
   * 写入打卡统计缓存
   */
  public async writeCheckinStatsCache(file: CheckinStatsCacheFile): Promise<void> {
    const p = this.checkinStatsCachePath();
    const out: CheckinStatsCacheFile = { version: 1, updatedAt: nowIso(), items: file.items ?? [] };
    await writeJsonFile(this.app, p, out);
  }

  /**
   * 读取任务统计缓存（轻量级全量数据，用于月度统计）
   * - 不受归档机制影响，始终保持全量数据
   * - 只包含统计所需的最小字段
   */
  public async readTaskStatsCache(): Promise<TaskStatsCacheFile> {
    const p = this.taskStatsCachePath();
    const fallback: TaskStatsCacheFile = { version: 1, updatedAt: nowIso(), items: [] };
    try {
      if (await this.app.vault.adapter.exists(p)) return readJsonFile(this.app, p, fallback);
    } catch {
      // ignore
    }

    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/task-stats-cache.json`);
      try {
        if (await this.app.vault.adapter.exists(legacyPath)) return readJsonFile(this.app, legacyPath, fallback);
      } catch {
        // ignore
      }
    }
    return fallback;
  }

  /**
   * 写入任务统计缓存
   */
  public async writeTaskStatsCache(file: TaskStatsCacheFile): Promise<void> {
    const p = this.taskStatsCachePath();
    const out: TaskStatsCacheFile = { version: 1, updatedAt: nowIso(), items: file.items ?? [] };
    await writeJsonFile(this.app, p, out);
  }
}
