import { App, normalizePath } from "obsidian";
import { ensureFolderChain, readJsonVaultFirst, writeJsonRaceSafe } from "../internal/indexJsonIo";
import type {
  CheckinRecordIndexFile,
  FinanceRecordIndexFile,
  HealthRecordIndexFile,
  RSLatteListsIndexFile,
  FinanceStatsCacheFile,
  CheckinStatsCacheFile,
  TaskStatsCacheFile,
} from "../types/recordIndexTypes";

const INDEX_JSON_IO_CTX = { label: "RecordIndexStore" } as const;

function nowIso() {
  return new Date().toISOString();
}

export class RecordIndexStore {
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
    await ensureFolderChain(this.app, normalizePath(`${dir}/archive`), INDEX_JSON_IO_CTX);
  }

  private checkinIndexPath(archived: boolean): string {
    const dir = this.getBaseDir();
    return normalizePath(`${dir}/${archived ? "archive/" : ""}checkin-record-index.json`);
  }

  private financeIndexPath(archived: boolean): string {
    const dir = this.getBaseDir();
    return normalizePath(`${dir}/${archived ? "archive/" : ""}finance-record-index.json`);
  }

  private healthIndexPath(archived: boolean): string {
    const dir = this.getBaseDir();
    return normalizePath(`${dir}/${archived ? "archive/" : ""}health-record-index.json`);
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
    const { resolveSpaceIndexDir } = require("../services/space/spaceContext");
    const indexDir = resolveSpaceIndexDir(settings, spaceId, [settings?.rslattePanelIndexDir]);
    return normalizePath(`${indexDir}/checkin-stats-cache.json`);
  }

  public async readCheckinIndex(archived: boolean): Promise<CheckinRecordIndexFile> {
    const p = this.checkinIndexPath(archived);
    const fallback: CheckinRecordIndexFile = { version: 1, updatedAt: nowIso(), items: [] };
    try {
      if (await this.app.vault.adapter.exists(p)) return readJsonVaultFirst(this.app, p, fallback);
    } catch {
      // ignore
    }

    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/${archived ? "archive/" : ""}checkin-record-index.json`);
      try {
        if (await this.app.vault.adapter.exists(legacyPath)) return readJsonVaultFirst(this.app, legacyPath, fallback);
      } catch {
        // ignore
      }
    }
    return fallback;
  }

  public async writeCheckinIndex(archived: boolean, file: CheckinRecordIndexFile): Promise<void> {
    const p = this.checkinIndexPath(archived);
    const out: CheckinRecordIndexFile = { version: 1, updatedAt: nowIso(), items: file.items ?? [] };
    await writeJsonRaceSafe(this.app, p, out, INDEX_JSON_IO_CTX);
  }

  public async readFinanceIndex(archived: boolean): Promise<FinanceRecordIndexFile> {
    const p = this.financeIndexPath(archived);
    const fallback: FinanceRecordIndexFile = { version: 1, updatedAt: nowIso(), items: [] };
    try {
      if (await this.app.vault.adapter.exists(p)) return readJsonVaultFirst(this.app, p, fallback);
    } catch {
      // ignore
    }

    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/${archived ? "archive/" : ""}finance-record-index.json`);
      try {
        if (await this.app.vault.adapter.exists(legacyPath)) return readJsonVaultFirst(this.app, legacyPath, fallback);
      } catch {
        // ignore
      }
    }
    return fallback;
  }

  public async writeFinanceIndex(archived: boolean, file: FinanceRecordIndexFile): Promise<void> {
    const p = this.financeIndexPath(archived);
    const out: FinanceRecordIndexFile = { version: 1, updatedAt: nowIso(), items: file.items ?? [] };
    await writeJsonRaceSafe(this.app, p, out, INDEX_JSON_IO_CTX);
  }

  public async readHealthIndex(archived: boolean): Promise<HealthRecordIndexFile> {
    const p = this.healthIndexPath(archived);
    const fallback: HealthRecordIndexFile = { version: 1, updatedAt: nowIso(), items: [] };
    try {
      if (await this.app.vault.adapter.exists(p)) return readJsonVaultFirst(this.app, p, fallback);
    } catch {
      // ignore
    }
    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/${archived ? "archive/" : ""}health-record-index.json`);
      try {
        if (await this.app.vault.adapter.exists(legacyPath)) return readJsonVaultFirst(this.app, legacyPath, fallback);
      } catch {
        // ignore
      }
    }
    return fallback;
  }

  public async writeHealthIndex(archived: boolean, file: HealthRecordIndexFile): Promise<void> {
    const p = this.healthIndexPath(archived);
    const out: HealthRecordIndexFile = { version: 1, updatedAt: nowIso(), items: file.items ?? [] };
    await writeJsonRaceSafe(this.app, p, out, INDEX_JSON_IO_CTX);
  }

  /**
   * 财务管理设置快照（与方案「重建索引时覆盖」）：供多端/入库读取，非全量插件设置。
   */
  public async writeFinanceManagementSettingsSnapshot(payload: Record<string, unknown>): Promise<void> {
    const dir = this.getBaseDir();
    const p = normalizePath(`${dir}/finance-management-settings.snapshot.json`);
    await writeJsonRaceSafe(this.app, p, { ...payload, snapshotWrittenAt: nowIso() }, INDEX_JSON_IO_CTX);
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
      if (await this.app.vault.adapter.exists(p)) return readJsonVaultFirst(this.app, p, fallback);
    } catch {
      // ignore
    }

    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/${archived ? "archive/" : ""}rslatte-lists-index.json`);
      try {
        if (await this.app.vault.adapter.exists(legacyPath)) return readJsonVaultFirst(this.app, legacyPath, fallback);
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
    await writeJsonRaceSafe(this.app, p, out, INDEX_JSON_IO_CTX);
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
      if (await this.app.vault.adapter.exists(p)) return readJsonVaultFirst(this.app, p, fallback);
    } catch {
      // ignore
    }

    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/finance-stats-cache.json`);
      try {
        if (await this.app.vault.adapter.exists(legacyPath)) return readJsonVaultFirst(this.app, legacyPath, fallback);
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
    await writeJsonRaceSafe(this.app, p, out, INDEX_JSON_IO_CTX);
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
      if (await this.app.vault.adapter.exists(p)) return readJsonVaultFirst(this.app, p, fallback);
    } catch {
      // ignore
    }

    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/checkin-stats-cache.json`);
      try {
        if (await this.app.vault.adapter.exists(legacyPath)) return readJsonVaultFirst(this.app, legacyPath, fallback);
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
    await writeJsonRaceSafe(this.app, p, out, INDEX_JSON_IO_CTX);
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
      if (await this.app.vault.adapter.exists(p)) return readJsonVaultFirst(this.app, p, fallback);
    } catch {
      // ignore
    }

    const legacyRoot = this.getLegacyRootDir();
    if (legacyRoot) {
      const legacyPath = normalizePath(`${legacyRoot}/task-stats-cache.json`);
      try {
        if (await this.app.vault.adapter.exists(legacyPath)) return readJsonVaultFirst(this.app, legacyPath, fallback);
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
    await writeJsonRaceSafe(this.app, p, out, INDEX_JSON_IO_CTX);
  }
}
