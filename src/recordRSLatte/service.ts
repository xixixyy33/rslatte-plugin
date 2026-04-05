import { App, TFile, TFolder, normalizePath, moment } from "obsidian";
// ✅ moment 从 Obsidian 导入，但 TypeScript 类型定义可能不完整，使用类型断言
const momentFn = moment as any;
import type { RSLattePluginSettings } from "../types/settings";
import type {
  CheckinRecordIndexFile,
  CheckinRecordIndexItem,
  FinanceRecordIndexFile,
  FinanceRecordIndexItem,
  HealthRecordIndexFile,
  HealthRecordIndexItem,
  RSLatteListsIndexFile,
  CheckinItemIndexItem,
  FinanceCatIndexItem,
  FinanceStatsCacheFile,
  FinanceStatsCacheItem,
  CheckinStatsCacheFile,
  CheckinStatsCacheItem,
  TaskStatsCacheFile,
  TaskStatsCacheItem,
} from "../types/recordIndexTypes";
import { RecordIndexStore } from "./indexStore";
import { RSLatteIndexStore } from "../taskRSLatte/indexStore";
import { fnv1a32 } from "../utils/hash";
import { extractFinanceMeta, extractFinanceSubcategory, normalizeFinanceSubcategory } from "../services/finance/financeSubcategory";
import {
  buildFinanceMainNoteParts,
  FINANCE_DIARY_MAIN_LINE_RE,
  peekFinanceMetaAfterMain,
} from "../services/finance/financeJournalMeta";
import {
  HEALTH_DIARY_MAIN_LINE_RE,
  normalizeHealthCreatedAtMs,
  peekHealthMetaAfterMain,
} from "../services/health/healthJournalMeta";
import { healthMetricKeyFromMainLineLabel } from "../types/healthTypes";
import { normalizeFinanceCycleType } from "../types/rslatteTypes";
import { resolveSpaceIndexDir } from "../services/space/spaceContext";
import { normalizeArchiveThresholdDays } from "../constants/defaults";
import type { RSLatteIndexItem } from "../taskRSLatte/types";
import type {
  FinanceAnomalyCycleIdMissingItem,
  FinanceAnomalyDuplicateCrossFileItem,
  FinanceAnomalyDuplicateItem,
  FinanceAnomalyLegacyItem,
  FinanceAnomalyScanResult,
} from "../types/financeAnomalyTypes";

function nowIso() {
  return new Date().toISOString();
}

// 未使用的函数，保留以备将来使用
// function toDayKeyFromMs(ms?: number): string | null {
//   if (!ms || !Number.isFinite(ms)) return null;
//   const d = new Date(ms);
//   const y = d.getFullYear();
//   const m = String(d.getMonth() + 1).padStart(2, "0");
//   const day = String(d.getDate()).padStart(2, "0");
//   return `${y}-${m}-${day}`;
// }

function normalizeDateKey(v: any): string | null {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function cutoffDateKey(todayKey: string, thresholdDays: number): string {
  const n = normalizeArchiveThresholdDays(thresholdDays);
  return momentFn(todayKey, "YYYY-MM-DD").subtract(n, "days").format("YYYY-MM-DD");
}

/** Which record sub-modules to operate on. (Step6-3 split checkin/finance；health 仅显式 true 时扫描) */
export type RecordModules = {
  checkin?: boolean;
  finance?: boolean;
  health?: boolean;
};

function normalizeModules(mods?: RecordModules): Required<RecordModules> {
  if (!mods) return { checkin: true, finance: true, health: false };
  const hasAnyExplicit =
    mods.checkin !== undefined || mods.finance !== undefined || mods.health !== undefined;
  if (!hasAnyExplicit) return { checkin: true, finance: true, health: false };
  return {
    checkin: mods.checkin !== false,
    finance: mods.finance !== false,
    health: mods.health === true,
  };
}

/** 单日解析结果（打卡 / 财务 / 健康） */
export type RecordDayParsedMaps = {
  checkins: Map<string, CheckinRecordIndexItem>;
  finances: Map<string, FinanceRecordIndexItem>;
  healths: Map<string, HealthRecordIndexItem>;
};

export type RecordIncrementalScan = {
  kind: "incremental";
  modules: Required<RecordModules>;
  cutoffDate: string;
  sinceMs: number;
  maxMtime: number;
  dayKeysScanned: Set<string>;
  parsedByDay: Map<string, RecordDayParsedMaps>;
  discoveredCheckins: Map<string, string>;
  discoveredFinanceCats: Map<string, { name?: string; type: "income" | "expense" }>;
};

export type RecordFullScan = {
  kind: "full";
  modules: Required<RecordModules>;
  cutoffDate: string;
  scannedDays: number;
  clearedDays: number;
  maxMtime: number;
  dayKeysScanned: Set<string>;
  dayKeysToReplace: Set<string>;
  parsedByDay: Map<string, RecordDayParsedMaps>;
  discoveredCheckins: Map<string, string>;
  discoveredFinanceCats: Map<string, { name?: string; type: "income" | "expense" }>;
};

export type RecordApplyResult = {
  cutoffDate: string;
  scannedDays: number;
  clearedDays?: number;
  changedDays: number;
};

type DbSyncState = "pending" | "dirty" | "synced" | "failed";

function normStr(v: any): string {
  return String(v ?? "").trim();
}

function computeCheckinSourceHash(it: Pick<CheckinRecordIndexItem, "recordDate" | "checkinId" | "note" | "isDelete">): string {
  const base = [normStr(it.recordDate), normStr(it.checkinId), normStr(it.note), it.isDelete ? "1" : "0"].join("|");
  return fnv1a32(base);
}

function computeFinanceSourceHash(
  it: Pick<
    FinanceRecordIndexItem,
    | "recordDate"
    | "categoryId"
    | "entryId"
    | "type"
    | "amount"
    | "note"
    | "subcategory"
    | "institutionName"
    | "cycleType"
    | "cycleId"
    | "sceneTags"
    | "isDelete"
  >
): string {
  const amt = Number(it.amount ?? 0);
  const tags = Array.isArray(it.sceneTags) ? it.sceneTags.map((x) => normStr(x)).filter(Boolean).join(",") : "";
  const base = [
    normStr(it.recordDate),
    normStr(it.categoryId),
    normStr(it.entryId),
    normStr(it.type),
    String(amt),
    normStr(it.note),
    normStr(it.subcategory),
    normStr(it.institutionName),
    normStr(it.cycleType),
    normStr(it.cycleId),
    tags,
    it.isDelete ? "1" : "0",
  ].join("|");
  return fnv1a32(base);
}

function computeHealthSourceHash(
  it: Pick<
    HealthRecordIndexItem,
    "recordDate" | "entryId" | "metricKey" | "period" | "cardRef" | "valueStr" | "note" | "sleepStartHm" | "isDelete"
  >
): string {
  const base = [
    normStr(it.recordDate),
    normStr(it.entryId),
    normStr(it.metricKey),
    normStr(it.period),
    normStr(it.cardRef),
    normStr(it.valueStr),
    normStr(it.note),
    normStr(it.sleepStartHm),
    it.isDelete ? "1" : "0",
  ].join("|");
  return fnv1a32(base);
}

function mergeDbSyncMeta<T extends { dbSourceHash?: string; dbLastSyncedHash?: string; dbSyncState?: DbSyncState; dbLastSyncedAt?: string; dbLastTriedAt?: string; dbRetryCount?: number; dbLastError?: string }>(
  newer: T,
  older?: T
): T {
  const src = normStr((newer as any).dbSourceHash);
  const oldSrc = normStr((older as any)?.dbSourceHash);
  const lastSyncedHash = normStr((older as any)?.dbLastSyncedHash);
  const oldState = (older as any)?.dbSyncState as DbSyncState | undefined;

  // carry over
  (newer as any).dbLastSyncedHash = lastSyncedHash || undefined;
  (newer as any).dbLastSyncedAt = (older as any)?.dbLastSyncedAt;

  // If hash matches last-synced, it's synced.
  if (src && lastSyncedHash && src === lastSyncedHash) {
    (newer as any).dbSyncState = "synced";
    (newer as any).dbRetryCount = 0;
    (newer as any).dbLastError = undefined;
    return newer;
  }

  // If previously pending/dirty/failed and content hash unchanged, keep that state (so retry works).
  if (oldState && (oldState === "pending" || oldState === "dirty" || oldState === "failed") && src && oldSrc && src === oldSrc) {
    (newer as any).dbSyncState = oldState;
    (newer as any).dbRetryCount = (older as any)?.dbRetryCount;
    (newer as any).dbLastTriedAt = (older as any)?.dbLastTriedAt;
    (newer as any).dbLastError = (older as any)?.dbLastError;
    return newer;
  }

  // Otherwise: mark as dirty if it had been synced before, else pending
  (newer as any).dbSyncState = lastSyncedHash ? "dirty" : "pending";
  (newer as any).dbRetryCount = 0;
  (newer as any).dbLastError = undefined;
  (newer as any).dbLastTriedAt = undefined;
  return newer;
}

export class RecordRSLatteService {
  private store: RecordIndexStore | null = null;
  private checkinSnap: CheckinRecordIndexFile | null = null;
  private financeSnap: FinanceRecordIndexFile | null = null;
  private healthSnap: HealthRecordIndexFile | null = null;
  private checkinArchiveSnap: CheckinRecordIndexFile | null = null;
  private financeArchiveSnap: FinanceRecordIndexFile | null = null;
  private healthArchiveSnap: HealthRecordIndexFile | null = null;

  // ✅ 清单索引（打卡项/财务分类）
  private listsSnap: RSLatteListsIndexFile | null = null;
  private listsArchiveSnap: RSLatteListsIndexFile | null = null;

  // ✅ 内存优化：快照访问时间戳（用于过期清理）
  private checkinSnapLastAccess = 0;
  private financeSnapLastAccess = 0;
  private healthSnapLastAccess = 0;
  private checkinArchiveSnapLastAccess = 0;
  private financeArchiveSnapLastAccess = 0;
  private healthArchiveSnapLastAccess = 0;
  private listsSnapLastAccess = 0;
  private listsArchiveSnapLastAccess = 0;
  
  // ✅ 快照过期时间：5分钟（300000毫秒）
  private readonly SNAPSHOT_EXPIRE_MS = 5 * 60 * 1000;

  constructor(
    private host: {
      app: App;
      settingsRef: () => RSLattePluginSettings;
      saveSettings: () => Promise<void>;
      getTodayKey: () => string;
    }
  ) {}

  /**
   * Finance subcategories cached in lists index (UI helper only).
   * Values are inferred from finance notes prefix: 【子分类】...
   */
  /**
   * ✅ 获取财务分类的子分类列表
   * 优先从 settings.financeCategories 中获取，如果不存在则从索引中提取
   */
  public async getFinanceSubcategories(categoryId: string): Promise<string[]> {
    // ✅ 优先从设置中的财务分类获取子分类列表
    const settings = this.settings;
    const cat = settings.financeCategories?.find(c => c.id === categoryId);
    if (cat && cat.subCategories && cat.subCategories.length > 0) {
      return cat.subCategories;
    }
    
    // ✅ 如果设置中没有，则从索引中提取（兼容旧逻辑）
    await this.ensureReady();
    const id = String(categoryId ?? "").trim();
    if (!id) return [];
    const snap = await this.getListsSnapshot(false);
    const map = (snap as any).financeSubcategoriesByCategoryId ?? {};
    const arr = Array.isArray(map[id]) ? map[id] : [];
    // normalize and dedupe
    const out: string[] = [];
    const seen = new Set<string>();
    for (const it of arr) {
      const v = normalizeFinanceSubcategory(String(it));
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out;
  }

  /** 获取某财务分类的机构名列表（优先 settings） */
  public async getFinanceInstitutions(categoryId: string): Promise<string[]> {
    const id = String(categoryId ?? "").trim();
    if (!id) return [];
    const cat = this.settings.financeCategories?.find((c) => String((c as any)?.id ?? "") === id);
    const direct = Array.isArray((cat as any)?.institutionNames) ? (cat as any).institutionNames : [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const it of direct) {
      const v = String(it ?? "").trim().replace(/\s+/g, " ");
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out;
  }

  /** 从历史财务记录中提取场景标签（去重，最多 200 个） */
  public async getFinanceSceneTagsHistory(): Promise<string[]> {
    await this.ensureReady();
    const active = await this.getFinanceSnapshot(false);
    const arch = await this.getFinanceSnapshot(true);
    const out: string[] = [];
    const seen = new Set<string>();
    const pushTag = (tag: string) => {
      const v = String(tag ?? "").trim().replace(/\s+/g, " ");
      if (!v) return;
      const key = v.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(v);
    };
    for (const it of [...(active.items ?? []), ...(arch.items ?? [])]) {
      const note = String((it as any)?.note ?? "");
      if (!note) continue;
      const meta = extractFinanceMeta(note);
      for (const t of meta.sceneTags ?? []) pushTag(t);
      if (out.length >= 200) break;
    }
    return out;
  }

  private async rememberFinanceSubcategory(categoryId: string, subcategory: string): Promise<void> {
    await this.ensureReady();
    const id = String(categoryId ?? "").trim();
    const sub = normalizeFinanceSubcategory(subcategory);
    if (!id || !sub) return;

    const snap = await this.getListsSnapshot(false);
    const map: Record<string, string[]> = (snap as any).financeSubcategoriesByCategoryId ?? {};
    const old = Array.isArray(map[id]) ? map[id] : [];
    // Move to front, keep max 30
    const next = [sub, ...old.filter((x) => normalizeFinanceSubcategory(String(x)) !== sub)].slice(0, 30);
    map[id] = next;
    (snap as any).financeSubcategoriesByCategoryId = map;
    this.listsSnap = { ...(snap as any), version: 1, updatedAt: nowIso() };
    await this.store!.writeListsIndex(false, this.listsSnap as any);
  }

  private get settings() {
    return this.host.settingsRef();
  }

  private getIndexBaseDir(): string {
    const s: any = this.settings as any;
    // Prefer unified centralIndexDir; fallback to legacy rslattePanelIndexDir.
    return resolveSpaceIndexDir(s, undefined, [s.rslattePanelIndexDir]);
  }

  public isDbSyncEnabled(): boolean {
    const s = this.settings;
    return !!(s.rslattePanelEnableDbSync ?? true);
  }

  public isAutoArchiveEnabled(): boolean {
    const s = this.settings;
    return !!(s.rslattePanelAutoArchiveEnabled ?? false);
  }

  /** v6-3：checkin auto archive（优先使用拆分后的配置） */
  private isCheckinAutoArchiveEnabled(): boolean {
    const s: any = this.settings as any;
    const v = s?.checkinPanel?.autoArchiveEnabled;
    if (typeof v === 'boolean') return v;
    return this.isAutoArchiveEnabled();
  }

  /** v6-3：finance auto archive（优先使用拆分后的配置） */
  private isFinanceAutoArchiveEnabled(): boolean {
    const s: any = this.settings as any;
    const v = s?.financePanel?.autoArchiveEnabled;
    if (typeof v === 'boolean') return v;
    return this.isAutoArchiveEnabled();
  }

  public getArchiveThresholdDays(): number {
    const s = this.settings;
    const v = Number(s.rslattePanelArchiveThresholdDays ?? 90);
    return normalizeArchiveThresholdDays(v);
  }

  /** v6-3：checkin archive threshold（优先使用拆分后的配置） */
  private getCheckinArchiveThresholdDays(): number {
    const s: any = this.settings as any;
    const v = Number(s?.checkinPanel?.archiveThresholdDays);
    if (Number.isFinite(v)) return normalizeArchiveThresholdDays(v);
    return this.getArchiveThresholdDays();
  }

  /** v6-3：finance archive threshold（优先使用拆分后的配置） */
  private getFinanceArchiveThresholdDays(): number {
    const s: any = this.settings as any;
    const v = Number(s?.financePanel?.archiveThresholdDays);
    if (Number.isFinite(v)) return normalizeArchiveThresholdDays(v);
    return this.getArchiveThresholdDays();
  }

  private getHealthArchiveThresholdDays(): number {
    const s: any = this.settings as any;
    const v = Number(s?.healthPanel?.archiveThresholdDays);
    if (Number.isFinite(v)) return normalizeArchiveThresholdDays(v);
    return this.getArchiveThresholdDays();
  }

  private isHealthAutoArchiveEnabled(): boolean {
    const s: any = this.settings as any;
    const v = s?.healthPanel?.autoArchiveEnabled;
    if (typeof v === "boolean") return v;
    return this.isAutoArchiveEnabled();
  }

  /** 本次扫描涉及的模块中取最大归档窗口（天） */
  private getScanCutoffDateKeyForModules(todayKey: string, mods: Required<RecordModules>): string {
    const parts: number[] = [];
    if (mods.checkin) parts.push(this.getCheckinArchiveThresholdDays());
    if (mods.finance) parts.push(this.getFinanceArchiveThresholdDays());
    if (mods.health) parts.push(this.getHealthArchiveThresholdDays());
    const days = parts.length ? Math.max(...parts) : this.getArchiveThresholdDays();
    return cutoffDateKey(todayKey, days);
  }

  // 未使用的方法，保留以备将来使用
  // private getScanThresholdDays(mods: RecordModules): number {
  //   // rebuild 扫描范围：覆盖所选模块的最大阈值（确保两类数据都能被扫描到）
  //   if (mods.checkin && !mods.finance) return this.getCheckinArchiveThresholdDays();
  //   if (mods.finance && !mods.checkin) return this.getFinanceArchiveThresholdDays();
  //   return Math.max(this.getCheckinArchiveThresholdDays(), this.getFinanceArchiveThresholdDays());
  // }

  public async ensureReady(): Promise<void> {
    if (this.store) return;
    this.store = new RecordIndexStore(this.host.app, this.getIndexBaseDir());
    await this.store.ensureLayout();
    
    // ✅ 内存优化：不再预加载所有快照，改为按需加载
    // 只检查清单索引是否为空（用于 bootstrap）
    const listsSnap = await this.store.readListsIndex(false);
    if ((listsSnap.checkinItems?.length ?? 0) === 0 && (listsSnap.financeCategories?.length ?? 0) === 0) {
      try {
        await this.syncListsIndexFromSettings({ reason: "bootstrap" });
      } catch (e) {
        console.warn("RecordRSLatte syncListsIndexFromSettings bootstrap failed:", e);
      }
    }

    // 仅在索引为空时，尝试从日记构建一次基础索引（避免每次启动都全量扫描）
    const checkinSnap = await this.store.readCheckinIndex(false);
    const financeSnap = await this.store.readFinanceIndex(false);
    const healthSnap0 = await this.store.readHealthIndex(false);
    if (
      (checkinSnap.items?.length ?? 0) === 0 &&
      (financeSnap.items?.length ?? 0) === 0 &&
      (healthSnap0.items?.length ?? 0) === 0
    ) {
      try {
        await this.refreshIndexFromDiaryScan();
      } catch (e) {
        console.warn("RecordRSLatte refreshIndexFromDiaryScan failed:", e);
      }
    }
  }

  /**
   * ✅ 内存优化：清理过期的快照
   */
  private cleanupExpiredSnapshots(): void {
    const now = Date.now();
    
    if (this.checkinSnap && now - this.checkinSnapLastAccess > this.SNAPSHOT_EXPIRE_MS) {
      this.checkinSnap = null;
    }
    if (this.financeSnap && now - this.financeSnapLastAccess > this.SNAPSHOT_EXPIRE_MS) {
      this.financeSnap = null;
    }
    if (this.checkinArchiveSnap && now - this.checkinArchiveSnapLastAccess > this.SNAPSHOT_EXPIRE_MS) {
      this.checkinArchiveSnap = null;
    }
    if (this.financeArchiveSnap && now - this.financeArchiveSnapLastAccess > this.SNAPSHOT_EXPIRE_MS) {
      this.financeArchiveSnap = null;
    }
    if (this.healthSnap && now - this.healthSnapLastAccess > this.SNAPSHOT_EXPIRE_MS) {
      this.healthSnap = null;
    }
    if (this.healthArchiveSnap && now - this.healthArchiveSnapLastAccess > this.SNAPSHOT_EXPIRE_MS) {
      this.healthArchiveSnap = null;
    }
    if (this.listsSnap && now - this.listsSnapLastAccess > this.SNAPSHOT_EXPIRE_MS) {
      this.listsSnap = null;
    }
    if (this.listsArchiveSnap && now - this.listsArchiveSnapLastAccess > this.SNAPSHOT_EXPIRE_MS) {
      this.listsArchiveSnap = null;
    }
  }

  /**
   * ✅ 内存优化：手动清理所有快照（供内存紧张时调用）
   */
  public clearAllSnapshots(): void {
    this.checkinSnap = null;
    this.financeSnap = null;
    this.healthSnap = null;
    this.checkinArchiveSnap = null;
    this.financeArchiveSnap = null;
    this.healthArchiveSnap = null;
    this.listsSnap = null;
    this.listsArchiveSnap = null;
    
    // 重置访问时间戳
    this.checkinSnapLastAccess = 0;
    this.financeSnapLastAccess = 0;
    this.healthSnapLastAccess = 0;
    this.checkinArchiveSnapLastAccess = 0;
    this.financeArchiveSnapLastAccess = 0;
    this.healthArchiveSnapLastAccess = 0;
    this.listsSnapLastAccess = 0;
    this.listsArchiveSnapLastAccess = 0;
  }

  /** 当中央索引目录被修改时，重建 store */
  public async resetStore(): Promise<void> {
    // @ts-ignore
    this.store = null;
    this.clearAllSnapshots();
    await this.ensureReady();
  }

  public async getCheckinSnapshot(archived: boolean = false): Promise<CheckinRecordIndexFile> {
    await this.ensureReady();
    
    // ✅ 内存优化：清理过期快照
    this.cleanupExpiredSnapshots();
    
    if (archived) {
      if (!this.checkinArchiveSnap) {
        this.checkinArchiveSnap = await this.store!.readCheckinIndex(true);
      }
      this.checkinArchiveSnapLastAccess = Date.now();
      return this.checkinArchiveSnap;
    }
    if (!this.checkinSnap) {
      this.checkinSnap = await this.store!.readCheckinIndex(false);
    }
    this.checkinSnapLastAccess = Date.now();
    return this.checkinSnap;
  }

  public async getFinanceSnapshot(archived: boolean = false): Promise<FinanceRecordIndexFile> {
    await this.ensureReady();
    
    // ✅ 内存优化：清理过期快照
    this.cleanupExpiredSnapshots();
    
    if (archived) {
      if (!this.financeArchiveSnap) {
        this.financeArchiveSnap = await this.store!.readFinanceIndex(true);
      }
      this.financeArchiveSnapLastAccess = Date.now();
      return this.financeArchiveSnap;
    }
    if (!this.financeSnap) {
      this.financeSnap = await this.store!.readFinanceIndex(false);
    }
    this.financeSnapLastAccess = Date.now();
    return this.financeSnap;
  }

  public async getHealthSnapshot(archived: boolean = false): Promise<HealthRecordIndexFile> {
    await this.ensureReady();
    this.cleanupExpiredSnapshots();
    if (archived) {
      if (!this.healthArchiveSnap) {
        this.healthArchiveSnap = await this.store!.readHealthIndex(true);
      }
      this.healthArchiveSnapLastAccess = Date.now();
      return this.healthArchiveSnap;
    }
    if (!this.healthSnap) {
      this.healthSnap = await this.store!.readHealthIndex(false);
    }
    this.healthSnapLastAccess = Date.now();
    return this.healthSnap;
  }

  /**
   * 同步更新财务统计缓存：从主索引和归档索引合并全量数据
   * - 统计缓存不受归档影响，始终保持全量数据
   * - 只存储统计所需的最小字段
   */
  /**
   * 同步财务统计缓存（轻量级全量数据，用于月度统计）
   * - 从主索引和归档索引读取所有财务记录
   * - 转换为轻量级统计缓存项，只记录最终状态（isDelete）
   * - 基于 recordDate + categoryId + subcategory 去重，保留最新的状态
   * @param spaceId 空间ID，如果提供则同步特定空间的缓存
   */
  private async syncFinanceStatsCache(spaceId?: string): Promise<void> {
    await this.ensureReady();
    try {
      // 如果指定了空间ID，需要创建特定空间的索引存储来读取数据
      let activeF: FinanceRecordIndexFile;
      let archF: FinanceRecordIndexFile;
      
      if (spaceId) {
        // 为特定空间创建索引存储
        const s: any = this.settings as any;
        const spaceIndexDir = resolveSpaceIndexDir(s, spaceId, [s.rslattePanelIndexDir]);
        const spaceStore = new RecordIndexStore(this.host.app, spaceIndexDir);
        activeF = await spaceStore.readFinanceIndex(false);
        archF = await spaceStore.readFinanceIndex(true);
      } else {
        // 使用当前空间的索引（向后兼容）
        activeF = await this.getFinanceSnapshot(false);
        archF = await this.getFinanceSnapshot(true);
      }

      // 合并主索引和归档索引的所有记录
      const allItems = [...(activeF.items ?? []), ...(archF.items ?? [])];

      // 转换为轻量级统计缓存项，并去重（基于 recordDate + categoryId + subcategory）
      // 使用临时 Map 存储时间戳用于比较，确保保留最新的记录
      const cacheMap = new Map<string, FinanceStatsCacheItem>();
      const tsMap = new Map<string, number>(); // 用于存储每个 key 对应的最新 tsMs
      
      for (const it of allItems) {
        const subFromNote = extractFinanceSubcategory(it.note ?? "").subcategory;
        const subcategory = normStr(it.subcategory) || subFromNote;
        const key = normStr(it.entryId)
          ? `${it.recordDate}::${String(it.categoryId)}::${normStr(it.entryId)}`
          : `${it.recordDate}::${String(it.categoryId)}::legacy::${subcategory}::${Number(it.tsMs ?? 0)}`;
        const currentTs = it.tsMs ?? 0;
        const existingTs = tsMap.get(key) ?? 0;
        
        // 如果当前记录更新（tsMs 更大），则更新缓存
        if (!cacheMap.has(key) || currentTs > existingTs) {
          cacheMap.set(key, {
            recordDate: it.recordDate,
            categoryId: String(it.categoryId),
            type: it.type,
            amount: Number(it.amount ?? 0),
            subcategory: subcategory || undefined, // 空字符串转为 undefined
            isDelete: !!it.isDelete,
          });
          tsMap.set(key, currentTs);
        }
      }

      const cacheItems = Array.from(cacheMap.values()).sort((a, b) =>
        a.recordDate === b.recordDate ? 0 : a.recordDate.localeCompare(b.recordDate)
      );

      const cache: FinanceStatsCacheFile = {
        version: 1,
        updatedAt: nowIso(),
        items: cacheItems,
      };

      // 如果指定了空间ID，写入到特定空间的缓存文件
      if (spaceId) {
        const s: any = this.settings as any;
        const spaceIndexDir = resolveSpaceIndexDir(s, spaceId, [s.rslattePanelIndexDir]);
        const spaceStore = new RecordIndexStore(this.host.app, spaceIndexDir);
        await spaceStore.writeFinanceStatsCache(cache);
      } else {
        // 使用当前空间的存储（向后兼容）
        await this.store!.writeFinanceStatsCache(cache);
      }
    } catch (e) {
      // best-effort: 统计缓存更新失败不影响主流程
      console.warn("[RSLatte] Failed to sync finance stats cache:", e);
    }
  }

  /**
   * 获取财务统计缓存（用于侧边栏统计和月度统计）
   * @param spaceId 空间ID，如果提供则获取特定空间的缓存
   */
  public async getFinanceStatsCache(spaceId?: string): Promise<FinanceStatsCacheFile> {
    await this.ensureReady();
    
    if (spaceId) {
      // 为特定空间创建索引存储来读取缓存
      const s: any = this.settings as any;
      const spaceIndexDir = resolveSpaceIndexDir(s, spaceId, [s.rslattePanelIndexDir]);
      const spaceStore = new RecordIndexStore(this.host.app, spaceIndexDir);
      const cache = await spaceStore.readFinanceStatsCache();
      
      // 如果缓存为空，尝试同步一次（首次使用）
      if (!cache.items || cache.items.length === 0) {
        await this.syncFinanceStatsCache(spaceId);
        return await spaceStore.readFinanceStatsCache();
      }
      return cache;
    } else {
      // 使用当前空间的存储（向后兼容）
      return await this.store!.readFinanceStatsCache();
    }
  }

  /**
   * 同步打卡统计缓存（轻量级全量数据，用于月度统计）
   * - 从主索引和归档索引读取所有打卡记录
   * - 转换为轻量级统计缓存项，只记录最终状态（isDelete）
   * - 基于 recordDate + checkinId 去重，保留最新的状态
   * @param spaceId 空间ID，如果提供则同步特定空间的缓存
   */
  private async syncCheckinStatsCache(spaceId?: string): Promise<void> {
    await this.ensureReady();
    try {
      // 如果指定了空间ID，需要创建特定空间的索引存储来读取数据
      let activeC: CheckinRecordIndexFile;
      let archC: CheckinRecordIndexFile;
      
      if (spaceId) {
        // 为特定空间创建索引存储
        const s: any = this.settings as any;
        const spaceIndexDir = resolveSpaceIndexDir(s, spaceId, [s.rslattePanelIndexDir]);
        const spaceStore = new RecordIndexStore(this.host.app, spaceIndexDir);
        activeC = await spaceStore.readCheckinIndex(false);
        archC = await spaceStore.readCheckinIndex(true);
      } else {
        // 使用当前空间的索引（向后兼容）
        activeC = await this.getCheckinSnapshot(false);
        archC = await this.getCheckinSnapshot(true);
      }

      // 合并主索引和归档索引的所有记录
      const allItems = [...(activeC.items ?? []), ...(archC.items ?? [])];

      // 转换为轻量级统计缓存项，并去重（基于 recordDate + checkinId）
      // 使用临时 Map 存储时间戳用于比较，确保保留最新的记录
      const cacheMap = new Map<string, CheckinStatsCacheItem>();
      const tsMap = new Map<string, number>(); // 用于存储每个 key 对应的最新 tsMs
      
      for (const it of allItems) {
        const key = `${it.recordDate}::${String(it.checkinId)}`;
        const currentTs = it.tsMs ?? 0;
        const existingTs = tsMap.get(key) ?? 0;
        
        // 如果当前记录更新（tsMs 更大），则更新缓存
        if (!cacheMap.has(key) || currentTs > existingTs) {
          cacheMap.set(key, {
            recordDate: it.recordDate,
            checkinId: String(it.checkinId),
            isDelete: !!it.isDelete,
          });
          tsMap.set(key, currentTs);
        }
      }

      const cacheItems = Array.from(cacheMap.values()).sort((a, b) =>
        a.recordDate === b.recordDate 
          ? (a.checkinId.localeCompare(b.checkinId))
          : a.recordDate.localeCompare(b.recordDate)
      );

      const cache: CheckinStatsCacheFile = {
        version: 1,
        updatedAt: nowIso(),
        items: cacheItems,
      };

      // 如果指定了空间ID，写入到特定空间的缓存文件
      if (spaceId) {
        const s: any = this.settings as any;
        const spaceIndexDir = resolveSpaceIndexDir(s, spaceId, [s.rslattePanelIndexDir]);
        const spaceStore = new RecordIndexStore(this.host.app, spaceIndexDir);
        await spaceStore.writeCheckinStatsCache(cache);
      } else {
        // 使用当前空间的存储（向后兼容）
        await this.store!.writeCheckinStatsCache(cache);
      }
    } catch (e) {
      // best-effort: 统计缓存更新失败不影响主流程
      console.warn("[RSLatte] Failed to sync checkin stats cache:", e);
    }
  }

  /**
   * 同步任务统计缓存（轻量级全量数据，用于月度统计）
   * - 从任务索引读取所有任务记录
   * - 转换为轻量级统计缓存项，只记录统计所需字段
   * - 基于 uid 去重，保留最新的状态
   * @param spaceId 空间ID，如果提供则同步特定空间的缓存
   */
  private async syncTaskStatsCache(spaceId?: string): Promise<void> {
    await this.ensureReady();
    try {
      // 获取任务索引存储路径
      const s: any = this.settings as any;
      let taskIndexDir: string;
      
      if (spaceId) {
        // 为特定空间创建任务索引存储
        taskIndexDir = resolveSpaceIndexDir(s, spaceId, [s.centralIndexDir || "00-System/.rslatte"]);
      } else {
        // 使用当前空间的索引（向后兼容）
        taskIndexDir = s.centralIndexDir || "00-System/.rslatte";
      }

      const taskStore = new RSLatteIndexStore(this.host.app, taskIndexDir);
      
      // 读取任务索引（主索引和归档索引）
      const activeIndex = await taskStore.readIndex("task");
      // TODO: 如果有归档索引，也需要读取
      // const archivedIndex = await taskStore.readIndex("task");

      // 合并所有任务项
      const allItems: RSLatteIndexItem[] = [...(activeIndex.items ?? [])];
      
      // 过滤出任务项（itemType 为 "task"）
      const taskItems = allItems.filter(item => item.itemType === "task");

      // 转换为轻量级统计缓存项，并去重（基于 uid）
      // 使用临时 Map 存储时间戳用于比较，确保保留最新的记录
      const cacheMap = new Map<string, TaskStatsCacheItem>();
      const tsMap = new Map<string, number>(); // 用于存储每个 uid 对应的最新 seenAt 时间戳

      for (const it of taskItems) {
        const uid = it.uid;
        if (!uid) continue; // 跳过没有 uid 的任务

        // 使用 seenAt 时间戳来判断最新记录
        const currentTs = it.seenAt ? new Date(it.seenAt).getTime() : 0;
        const existingTs = tsMap.get(uid) ?? 0;

        // 如果当前记录更新（seenAt 更大），则更新缓存
        if (!cacheMap.has(uid) || currentTs > existingTs) {
          // 判断是否已删除（状态为 CANCELLED 或 archived）
          const isDelete = it.status === "CANCELLED" || !!it.archived;

          // 将 RSLatteStatus 转换为 TaskStatsCacheItem 的 status 类型（排除 UNKNOWN）
          let status: "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED";
          if (it.status === "UNKNOWN" || !it.status) {
            status = "TODO";
          } else if (it.status === "TODO" || it.status === "IN_PROGRESS" || it.status === "DONE" || it.status === "CANCELLED") {
            status = it.status;
          } else {
            status = "TODO";
          }

          cacheMap.set(uid, {
            uid: uid,
            status: status,
            createdDate: it.created_date || undefined,
            doneDate: it.done_date || undefined,
            cancelledDate: it.cancelled_date || undefined,
            dueDate: it.planned_end || undefined,
            isDelete: isDelete,
          });
          tsMap.set(uid, currentTs);
        }
      }

      const cacheItems = Array.from(cacheMap.values()).sort((a, b) => {
        // 按创建日期排序，如果没有创建日期则按 uid 排序
        if (a.createdDate && b.createdDate) {
          return a.createdDate.localeCompare(b.createdDate);
        }
        if (a.createdDate) return -1;
        if (b.createdDate) return 1;
        return a.uid.localeCompare(b.uid);
      });

      const cache: TaskStatsCacheFile = {
        version: 1,
        updatedAt: nowIso(),
        items: cacheItems,
      };

      // 如果指定了空间ID，写入到特定空间的缓存文件
      if (spaceId) {
        const spaceIndexDir = resolveSpaceIndexDir(s, spaceId, [s.rslattePanelIndexDir]);
        const spaceStore = new RecordIndexStore(this.host.app, spaceIndexDir);
        await spaceStore.writeTaskStatsCache(cache);
      } else {
        // 使用当前空间的存储（向后兼容）
        await this.store!.writeTaskStatsCache(cache);
      }
    } catch (e) {
      // best-effort: 统计缓存更新失败不影响主流程
      console.warn("[RSLatte] Failed to sync task stats cache:", e);
    }
  }

  /**
   * 获取任务统计缓存（用于月度统计）
   * 如果缓存为空或不存在，自动同步一次
   * @param spaceId 空间ID，如果提供则获取特定空间的缓存
   */
  public async getTaskStatsCache(spaceId?: string): Promise<TaskStatsCacheFile> {
    await this.ensureReady();
    
    let cache: TaskStatsCacheFile;
    if (spaceId) {
      // 为特定空间创建索引存储来读取缓存
      const s: any = this.settings as any;
      const spaceIndexDir = resolveSpaceIndexDir(s, spaceId, [s.rslattePanelIndexDir]);
      const spaceStore = new RecordIndexStore(this.host.app, spaceIndexDir);
      cache = await spaceStore.readTaskStatsCache();
      
      // 如果缓存为空，尝试同步一次（首次使用）
      if (!cache.items || cache.items.length === 0) {
        await this.syncTaskStatsCache(spaceId);
        return await spaceStore.readTaskStatsCache();
      }
      return cache;
    } else {
      // 使用当前空间的存储（向后兼容）
      cache = await this.store!.readTaskStatsCache();
      
      // 如果缓存为空，尝试同步一次（首次使用）
      if (!cache.items || cache.items.length === 0) {
        await this.syncTaskStatsCache();
        return await this.store!.readTaskStatsCache();
      }
      return cache;
    }
  }

  /**
   * 获取打卡统计缓存（用于月度统计）
   * 如果缓存为空或不存在，自动同步一次
   * @param spaceId 空间ID，如果提供则获取特定空间的缓存
   */
  public async getCheckinStatsCache(spaceId?: string): Promise<CheckinStatsCacheFile> {
    await this.ensureReady();
    
    let cache: CheckinStatsCacheFile;
    if (spaceId) {
      // 为特定空间创建索引存储来读取缓存
      const s: any = this.settings as any;
      const spaceIndexDir = resolveSpaceIndexDir(s, spaceId, [s.rslattePanelIndexDir]);
      const spaceStore = new RecordIndexStore(this.host.app, spaceIndexDir);
      cache = await spaceStore.readCheckinStatsCache();
      
      // 如果缓存为空，尝试同步一次（首次使用）
      if (!cache.items || cache.items.length === 0) {
        await this.syncCheckinStatsCache(spaceId);
        return await spaceStore.readCheckinStatsCache();
      }
    } else {
      // 使用当前空间的存储（向后兼容）
      cache = await this.store!.readCheckinStatsCache();
      // 如果缓存为空，尝试同步一次（首次使用）
      if (!cache.items || cache.items.length === 0) {
        await this.syncCheckinStatsCache();
        return await this.store!.readCheckinStatsCache();
      }
    }
    return cache;
  }

  public async getListsSnapshot(archived: boolean = false): Promise<RSLatteListsIndexFile> {
    await this.ensureReady();
    
    // ✅ 内存优化：清理过期快照
    this.cleanupExpiredSnapshots();
    
    if (archived) {
      if (!this.listsArchiveSnap) {
        this.listsArchiveSnap = await this.store!.readListsIndex(true);
      }
      this.listsArchiveSnapLastAccess = Date.now();
      return this.listsArchiveSnap;
    }
    if (!this.listsSnap) {
      this.listsSnap = await this.store!.readListsIndex(false);
    }
    this.listsSnapLastAccess = Date.now();
    return this.listsSnap;
  }

  /**
   * Step3：把“清单索引（lists index）”中已发现的条目合并回 settings（便于 UI 展示 + DB 同步清单）。
   * - 仅补齐 settings 中缺失的条目
   * - 新增条目默认 active=false
   * - 不会恢复 deletedAt/tombstone 条目
   *
   * 注意：该方法只修改 settings 内存对象；调用方按需再 host.saveSettings()。
   */
  public async mergeListsIndexIntoSettings(): Promise<{ addedCheckins: number; addedFinance: number }> {
    await this.ensureReady();
    const snap = await this.getListsSnapshot(false);
    const sAny: any = this.settings as any;

    if (!Array.isArray(sAny.checkinItems)) sAny.checkinItems = [];
    if (!Array.isArray(sAny.financeCategories)) sAny.financeCategories = [];

    const existC = new Set((sAny.checkinItems as any[]).map((x) => String(x?.id ?? "")));
    const existF = new Set((sAny.financeCategories as any[]).map((x) => String(x?.id ?? "")));

    let addedCheckins = 0;
    let addedFinance = 0;

    for (const it of snap.checkinItems ?? []) {
      if ((it as any)?.deletedAt) continue;
      const id = String((it as any)?.id ?? "").trim();
      if (!id || existC.has(id)) continue;
      (sAny.checkinItems as any[]).push({
        id,
        name: String((it as any)?.name ?? id),
        active: false,
        checkinDifficulty: "normal",
      });
      existC.add(id);
      addedCheckins++;
    }

    for (const it of snap.financeCategories ?? []) {
      if ((it as any)?.deletedAt) continue;
      const id = String((it as any)?.id ?? "").trim();
      if (!id || existF.has(id)) continue;
      const type = (String((it as any)?.type ?? "expense") === "income" ? "income" : "expense") as any;
      (sAny.financeCategories as any[]).push({ id, name: String((it as any)?.name ?? id), type, active: false });
      existF.add(id);
      addedFinance++;
    }

    if (addedCheckins > 0) {
      (sAny.checkinItems as any[]).sort((a, b) => String(a?.id ?? "").localeCompare(String(b?.id ?? "")));
    }
    if (addedFinance > 0) {
      (sAny.financeCategories as any[]).sort((a, b) => String(a?.id ?? "").localeCompare(String(b?.id ?? "")));
    }

    return { addedCheckins, addedFinance };
  }

  /** 永久 tombstone 集合（用于防止复用已删除 id） */
  private async reconcileListTombstonesWithCurrentLists(): Promise<void> {
    // ✅ 确保获取最新的设置（空间切换后设置可能已更新）
    // 通过重新调用 settingsRef() 确保获取的是当前空间的设置
    const currentSettings = this.settings;
    
    // ✅ 确保读取的是当前空间的索引文件（空间切换后 listsSnap 可能已被清空，需要重新读取）
    // 如果 listsSnap 为 null，getListsSnapshot 会自动重新读取，但为了确保数据一致性，先确保 ready
    await this.ensureReady();
    
    // ✅ 强制重新读取快照，确保使用的是当前空间的索引（空间切换后可能缓存了旧空间的快照）
    // 如果 store 的 baseDir 已经改变（空间切换），需要重新读取
    const currentBaseDir = this.getIndexBaseDir();
    if (this.store && this.store.getBaseDir() !== currentBaseDir) {
      // Store 指向的目录已改变，需要重置并重新初始化
      this.store = null;
      this.listsSnap = null;
      await this.ensureReady();
    }
    
    const snap = await this.getListsSnapshot(false);

    const curC = new Set(
      (currentSettings.checkinItems ?? [])
        .map((it) => String((it as any).id ?? "").trim())
        .filter((x) => !!x)
    );
    const curF = new Set(
      (currentSettings.financeCategories ?? [])
        .map((it) => String((it as any).id ?? "").trim())
        .filter((x) => !!x)
    );

    const tombC = new Set((snap.tombstoneCheckinIds ?? []).map((x) => String(x)));
    const tombF = new Set((snap.tombstoneFinanceIds ?? []).map((x) => String(x)));

    let changed = false;

    // ✅ 若某个 ID 已经存在于当前列表（即便是禁用态），则不应继续保留 tombstone（否则会误报冲突）
    for (const id of curC) {
      if (tombC.delete(id)) changed = true;
    }
    for (const id of curF) {
      if (tombF.delete(id)) changed = true;
    }

    // ✅ 若 lists index 中该条目本身带 deletedAt，但它已经在当前列表里，则视为“已恢复”
    const outCheckins = (snap.checkinItems ?? []).map((it) => {
      const id = String((it as any).id ?? "");
      if (curC.has(id) && (it as any).deletedAt) {
        changed = true;
        return { ...(it as any), deletedAt: null };
      }
      return it as any;
    });

    const outFinance = (snap.financeCategories ?? []).map((it) => {
      const id = String((it as any).id ?? "");
      if (curF.has(id) && (it as any).deletedAt) {
        changed = true;
        return { ...(it as any), deletedAt: null };
      }
      return it as any;
    });

    if (!changed) return;

    const out: RSLatteListsIndexFile = {
      version: 1,
      updatedAt: nowIso(),
      checkinItems: outCheckins,
      financeCategories: outFinance,
      tombstoneCheckinIds: Array.from(tombC.values()).sort(),
      tombstoneFinanceIds: Array.from(tombF.values()).sort(),
    };

    this.listsSnap = out;
    await this.store!.writeListsIndex(false, out);
  }

  getListTombstones(): Promise<{ checkin: Set<string>; finance: Set<string> }> {
    return (async () => {
      // ✅ 兜底：若某个 ID 已经在当前列表里，则自动移除 tombstone，避免误报“历史删除冲突”
      await this.reconcileListTombstonesWithCurrentLists();
      const snap = await this.getListsSnapshot(false);
      return {
        checkin: new Set((snap.tombstoneCheckinIds ?? []).map((x) => String(x))),
        finance: new Set((snap.tombstoneFinanceIds ?? []).map((x) => String(x))),
      };
    })();
  }

  /** 用于 settings 保存前校验：当前清单 id 不允许与历史删除 id 冲突 */
  public async validateListIdsNotInTombstones(): Promise<{ ok: boolean; message?: string }> {
    const { checkin, finance } = await this.getListTombstones();
    const bad: string[] = [];
    for (const it of this.settings.checkinItems ?? []) {
      const id = String(it.id ?? "").trim();
      if (!id) continue;
      if (checkin.has(id)) bad.push(id);
    }
    for (const it of this.settings.financeCategories ?? []) {
      const id = String(it.id ?? "").trim();
      if (!id) continue;
      if (finance.has(id)) bad.push(id);
    }
    if (bad.length > 0) {
      return {
        ok: false,
        message: `ID 与历史已删除条目冲突：${bad.slice(0, 10).join(", ")}${bad.length > 10 ? " ..." : ""}（请在设置页清单中查看红色高亮项）`,
      };
    }
    return { ok: true };
  }

  /** 生成不与 tombstone / 当前清单冲突的 id（防止误复用） */
  public async genUniqueListId(
    prefix: "DK" | "CW",
    ctx?: { checkinItems?: Array<{ id?: string }>; financeCategories?: Array<{ id?: string }> }
  ): Promise<string> {
    const { checkin, finance } = await this.getListTombstones();
    const forbidden = new Set<string>();

    const add = (v: any) => {
      const s = String(v ?? "").trim();
      if (s) forbidden.add(s);
    };

    // tombstones
    for (const id of (prefix === "DK" ? checkin : finance)) add(id);

    // settings
    const cks = ctx?.checkinItems ?? this.settings.checkinItems ?? [];
    const fins = ctx?.financeCategories ?? this.settings.financeCategories ?? [];
    if (prefix === "DK") cks.forEach((x) => add(x.id));
    if (prefix === "CW") fins.forEach((x) => add(x.id));

    // index + archive (兜底)
    const ls = await this.getListsSnapshot(false);
    const la = await this.getListsSnapshot(true);
    if (prefix === "DK") {
      (ls.checkinItems ?? []).forEach((x) => add(x.id));
      (la.checkinItems ?? []).forEach((x) => add(x.id));
    } else {
      (ls.financeCategories ?? []).forEach((x) => add(x.id));
      (la.financeCategories ?? []).forEach((x) => add(x.id));
    }

    for (let i = 0; i < 40; i++) {
      const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
      const id = `${prefix}_${rand}`;
      if (!forbidden.has(id)) return id;
    }
    // 极低概率：退化策略
    const rand2 = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
    return `${prefix}_${rand2}`;
  }

  /** 同步：settings 清单 -> 中央索引（软删除 + tombstone） */
  public async syncListsIndexFromSettings(_opts?: { reason?: string }): Promise<void> {
    await this.ensureReady();
    const now = nowIso();

    const active = await this.getListsSnapshot(false);
    const archived = await this.getListsSnapshot(true);

    const tombC = new Set((active.tombstoneCheckinIds ?? []).map((x) => String(x)));
    const tombF = new Set((active.tombstoneFinanceIds ?? []).map((x) => String(x)));
    // 合并 archive 里的 tombstone（兜底）
    (archived.tombstoneCheckinIds ?? []).forEach((x) => tombC.add(String(x)));
    (archived.tombstoneFinanceIds ?? []).forEach((x) => tombF.add(String(x)));

    const curCheckins = (this.settings.checkinItems ?? []).map((x) => ({
      id: String(x.id ?? "").trim(),
      name: String(x.name ?? "").trim(),
      active: !!x.active,
      continuousDays: typeof (x as any).continuousDays === "number" ? (x as any).continuousDays : undefined,
    })).filter((x) => !!x.id);

    const curFinance = (this.settings.financeCategories ?? []).map((x) => ({
      id: String(x.id ?? "").trim(),
      name: String(x.name ?? "").trim(),
      type: ((x.type as any) === "income" ? "income" : "expense") as "income" | "expense",
      active: !!x.active,
    })).filter((x) => !!x.id);

    const byIdC = new Map<string, CheckinItemIndexItem>();
    for (const it of (active.checkinItems ?? [])) byIdC.set(String(it.id), { ...it });
    const byIdF = new Map<string, FinanceCatIndexItem>();
    for (const it of (active.financeCategories ?? [])) byIdF.set(String(it.id), { ...it });

    const seenC = new Set<string>();
    for (const cur of curCheckins) {
      seenC.add(cur.id);
      const old = byIdC.get(cur.id);
      const continuousDays = (cur as any).continuousDays;
      if (old) {
        // 若已删除（deletedAt 存在），说明用户尝试复用历史 id，此处不自动恢复，留给保存校验处理
        if (!old.deletedAt) {
          old.name = cur.name;
          old.active = cur.active;
          if (continuousDays !== undefined) old.continuousDays = continuousDays;
          else if (old.continuousDays === undefined) old.continuousDays = 0;
          old.updatedAt = now;
        }
        byIdC.set(cur.id, old);
      } else {
        byIdC.set(cur.id, {
          id: cur.id,
          name: cur.name,
          active: cur.active,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          continuousDays: continuousDays ?? 0,
        });
      }
    }

    const seenF = new Set<string>();
    for (const cur of curFinance) {
      seenF.add(cur.id);
      const old = byIdF.get(cur.id);
      if (old) {
        if (!old.deletedAt) {
          old.name = cur.name;
          old.type = cur.type;
          old.active = cur.active;
          old.updatedAt = now;
        }
        byIdF.set(cur.id, old);
      } else {
        byIdF.set(cur.id, { id: cur.id, name: cur.name, type: cur.type, active: cur.active, createdAt: now, updatedAt: now, deletedAt: null });
      }
    }

    // 软删除：settings 中不存在的条目，记录 deletedAt，并写入 tombstone
    for (const [id, it] of byIdC.entries()) {
      if (!seenC.has(id) && !it.deletedAt) {
        it.deletedAt = now;
        it.updatedAt = now;
        tombC.add(id);
      }
    }
    for (const [id, it] of byIdF.entries()) {
      if (!seenF.has(id) && !it.deletedAt) {
        it.deletedAt = now;
        it.updatedAt = now;
        tombF.add(id);
      }
    }

    const out: RSLatteListsIndexFile = {
      version: 1,
      updatedAt: now,
      checkinItems: Array.from(byIdC.values()).sort((a, b) => String(a.id).localeCompare(String(b.id))),
      financeCategories: Array.from(byIdF.values()).sort((a, b) => String(a.id).localeCompare(String(b.id))),
      tombstoneCheckinIds: Array.from(tombC.values()).sort(),
      tombstoneFinanceIds: Array.from(tombF.values()).sort(),
    };

    this.listsSnap = out;
    await this.store!.writeListsIndex(false, out);
  }

  /** 归档：超过阈值天数的已删除条目，从 active lists index 移入 archive lists index */
  public async archiveDeletedListsNow(modules?: RecordModules): Promise<{ checkinArchived: number; financeArchived: number; cutoffIso: string }> {
    await this.ensureReady();
    const mods = normalizeModules(modules);
    const cutoffIsoC = momentFn().subtract(this.getCheckinArchiveThresholdDays(), "days").toISOString();
    const cutoffIsoF = momentFn().subtract(this.getFinanceArchiveThresholdDays(), "days").toISOString();
    const cutoffIso = (mods.checkin && !mods.finance)
      ? cutoffIsoC
      : (mods.finance && !mods.checkin)
        ? cutoffIsoF
        : (cutoffIsoC < cutoffIsoF ? cutoffIsoC : cutoffIsoF);

    const active = await this.getListsSnapshot(false);
    const arch = await this.getListsSnapshot(true);

    const canMoveC = (it: { deletedAt?: string | null }) => {
      const d = it.deletedAt ? String(it.deletedAt) : "";
      return !!d && d <= cutoffIsoC;
    };
    const canMoveF = (it: { deletedAt?: string | null }) => {
      const d = it.deletedAt ? String(it.deletedAt) : "";
      return !!d && d <= cutoffIsoF;
    };

    const moveC = mods.checkin ? (active.checkinItems ?? []).filter(canMoveC) : [];
    const keepC = mods.checkin ? (active.checkinItems ?? []).filter((x) => !canMoveC(x)) : (active.checkinItems ?? []);
    const moveF = mods.finance ? (active.financeCategories ?? []).filter(canMoveF) : [];
    const keepF = mods.finance ? (active.financeCategories ?? []).filter((x) => !canMoveF(x)) : (active.financeCategories ?? []);

    const mergeC = new Map<string, CheckinItemIndexItem>();
    for (const it of (arch.checkinItems ?? [])) mergeC.set(String(it.id), it);
    for (const it of moveC) mergeC.set(String(it.id), it);

    const mergeF = new Map<string, FinanceCatIndexItem>();
    for (const it of (arch.financeCategories ?? [])) mergeF.set(String(it.id), it);
    for (const it of moveF) mergeF.set(String(it.id), it);

    // tombstone 永久保存：放在 active 里即可；这里也同步写一份到 archive 以便手工迁移时不丢
    const outActive: RSLatteListsIndexFile = {
      version: 1,
      updatedAt: nowIso(),
      checkinItems: keepC,
      financeCategories: keepF,
      tombstoneCheckinIds: active.tombstoneCheckinIds ?? [],
      tombstoneFinanceIds: active.tombstoneFinanceIds ?? [],
    };
    const outArch: RSLatteListsIndexFile = {
      version: 1,
      updatedAt: nowIso(),
      checkinItems: mods.checkin ? Array.from(mergeC.values()) : (arch.checkinItems ?? []),
      financeCategories: mods.finance ? Array.from(mergeF.values()) : (arch.financeCategories ?? []),
      tombstoneCheckinIds: Array.from(new Set([...(arch.tombstoneCheckinIds ?? []), ...(active.tombstoneCheckinIds ?? [])])),
      tombstoneFinanceIds: Array.from(new Set([...(arch.tombstoneFinanceIds ?? []), ...(active.tombstoneFinanceIds ?? [])])),
    };

    this.listsSnap = outActive;
    this.listsArchiveSnap = outArch;
    await this.store!.writeListsIndex(false, outActive);
    await this.store!.writeListsIndex(true, outArch);

    return { checkinArchived: moveC.length, financeArchived: moveF.length, cutoffIso };
  }

  public async getTodayCheckin(checkinId: string): Promise<CheckinRecordIndexItem | null> {
    const todayKey = this.host.getTodayKey();
    const snap = await this.getCheckinSnapshot(false);
    const id = String(checkinId);
    const items = snap.items ?? [];
    // 取最新
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it?.recordDate === todayKey && String(it.checkinId) === id) return it;
    }
    return null;
  }

  /**
   * 指定日期是否存在该打卡项的有效记录（未取消/未删除）。
   * 用于连续打卡天数：昨日有记录则 +1，无则置 0 或 1。会查主索引 + 归档索引。
   */
  public async hasEffectiveCheckinRecordOnDate(checkinId: string, dateKey: string): Promise<boolean> {
    const id = String(checkinId).trim();
    const dk = normalizeDateKey(dateKey);
    if (!dk) return false;
    const active = await this.getCheckinSnapshot(false);
    const arch = await this.getCheckinSnapshot(true);
    const items = [...(active.items ?? []), ...(arch.items ?? [])];
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it?.recordDate === dk && String(it.checkinId) === id) return !it.isDelete;
    }
    return false;
  }

  /**
   * 返回该打卡项所有有效打卡日期（未删除），去重后按日期倒序（最新在前）。
   * 用于重建索引后按完整历史重算连续打卡天数（含补打卡）。
   */
  public async getEffectiveCheckinRecordDates(checkinId: string): Promise<string[]> {
    const id = String(checkinId).trim();
    const active = await this.getCheckinSnapshot(false);
    const arch = await this.getCheckinSnapshot(true);
    const set = new Set<string>();
    for (const it of [...(active.items ?? []), ...(arch.items ?? [])]) {
      if (String(it?.checkinId) !== id || it?.isDelete) continue;
      const dk = normalizeDateKey(it.recordDate);
      if (dk) set.add(dk);
    }
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  }

  public async getTodayFinance(categoryId: string): Promise<FinanceRecordIndexItem | null> {
    const list = await this.getTodayFinanceRecordsForCategory(categoryId);
    if (list.length === 0) return null;
    return list[list.length - 1];
  }

  /** 今日该分类下全部明细（未删除在前筛选由调用方决定；此处返回全部含已删除供对账） */
  public async getTodayFinanceRecordsForCategory(categoryId: string, opts?: { activeOnly?: boolean }): Promise<FinanceRecordIndexItem[]> {
    const todayKey = this.host.getTodayKey();
    const snap = await this.getFinanceSnapshot(false);
    const id = String(categoryId);
    const items = (snap.items ?? []).filter((x) => x?.recordDate === todayKey && String(x.categoryId) === id);
    const activeOnly = opts?.activeOnly === true;
    const filtered = activeOnly ? items.filter((x) => !x.isDelete) : items;
    return filtered.sort((a, b) => (a.tsMs ?? 0) - (b.tsMs ?? 0));
  }

  public async upsertCheckin(item: CheckinRecordIndexItem): Promise<void> {
    await this.ensureReady();
    const snap = await this.getCheckinSnapshot(false);
    const rd = normalizeDateKey(item.recordDate) ?? this.host.getTodayKey();
    const id = String(item.checkinId);

    const old = (snap.items ?? []).find((x) => x.recordDate === rd && String(x.checkinId) === id);
    const items = (snap.items ?? []).filter((x) => !(x.recordDate === rd && String(x.checkinId) === id));

    const newer: CheckinRecordIndexItem = {
      recordDate: rd,
      checkinId: id,
      checkinName: item.checkinName,
      note: (item.note ?? "").trim() || undefined,
      isDelete: !!item.isDelete,
      tsMs: Number(item.tsMs ?? Date.now()),
    };
    (newer as any).dbSourceHash = computeCheckinSourceHash(newer);
    mergeDbSyncMeta(newer as any, old as any);

    items.push(newer);
    items.sort((a, b) => (a.recordDate === b.recordDate ? (a.tsMs ?? 0) - (b.tsMs ?? 0) : a.recordDate.localeCompare(b.recordDate)));
    this.checkinSnap = { version: 1, updatedAt: nowIso(), items };
    await this.store!.writeCheckinIndex(false, this.checkinSnap);

    // ✅ 同步更新打卡统计缓存
    await this.syncCheckinStatsCache();

    // ✅ Notify UI (settings tab) that record index has changed, so used-id locks can refresh.
    // Best-effort: should never block primary UI actions.
    try {
      this.host.app.workspace.trigger("rslatte:recordIndexChanged", { module: "checkin" });
    } catch {
      // ignore
    }
  }

  public async upsertFinance(item: FinanceRecordIndexItem): Promise<void> {
    await this.ensureReady();
    const snap = await this.getFinanceSnapshot(false);
    const rd = normalizeDateKey(item.recordDate) ?? this.host.getTodayKey();
    const id = String(item.categoryId);
    const eid = normStr(item.entryId);

    const matchKey = (x: FinanceRecordIndexItem) => {
      if (eid) return x.recordDate === rd && String(x.categoryId) === id && normStr(x.entryId) === eid;
      return x.recordDate === rd && String(x.categoryId) === id && !normStr(x.entryId);
    };

    const old = (snap.items ?? []).find(matchKey);
    const items = (snap.items ?? []).filter((x) => !matchKey(x));

    const newer: FinanceRecordIndexItem = {
      recordDate: rd,
      entryId: eid || undefined,
      categoryId: id,
      categoryName: item.categoryName,
      type: item.type,
      subcategory: normStr(item.subcategory) || undefined,
      amount: Number(item.amount ?? 0),
      note: (item.note ?? "").trim() || undefined,
      institutionName: normStr((item as any).institutionName) || undefined,
      cycleType: normStr((item as any).cycleType) || undefined,
      cycleId: normStr((item as any).cycleId) || normStr((old as any)?.cycleId) || undefined,
      sceneTags: Array.isArray((item as any).sceneTags)
        ? Array.from(new Set(((item as any).sceneTags as any[]).map((x) => String(x ?? "").trim()).filter(Boolean)))
        : undefined,
      isDelete: !!item.isDelete,
      tsMs: Number(item.tsMs ?? Date.now()),
      sourceFilePath: normStr(item.sourceFilePath) || normStr(old?.sourceFilePath) || undefined,
      sourceLineMain: (() => {
        const fromItem = item.sourceLineMain;
        if (fromItem !== undefined && fromItem !== null && Number.isFinite(Number(fromItem))) return Number(fromItem);
        const fromOld = old?.sourceLineMain;
        if (fromOld !== undefined && fromOld !== null && Number.isFinite(Number(fromOld))) return Number(fromOld);
        return undefined;
      })(),
    };
    (newer as any).dbSourceHash = computeFinanceSourceHash(newer);
    mergeDbSyncMeta(newer as any, old as any);

    items.push(newer);
    items.sort((a, b) => (a.recordDate === b.recordDate ? (a.tsMs ?? 0) - (b.tsMs ?? 0) : a.recordDate.localeCompare(b.recordDate)));
    this.financeSnap = { version: 1, updatedAt: nowIso(), items };
    await this.store!.writeFinanceIndex(false, this.financeSnap);

    // ✅ 同步更新财务统计缓存
    await this.syncFinanceStatsCache();

    // ✅ Notify UI (settings tab) that record index has changed, so used-id locks can refresh.
    try {
      this.host.app.workspace.trigger("rslatte:recordIndexChanged", { module: "finance" });
    } catch {
      // ignore
    }

    // ✅ Learn subcategory mapping for better UI (no DB). Best-effort.
    try {
      const sub = normStr(newer.subcategory) || extractFinanceSubcategory(newer.note ?? "").subcategory;
      if (sub) await this.rememberFinanceSubcategory(id, sub);
    } catch {
      // ignore
    }
  }

  /** ✅ 兼容旧调用：UI 会调用 upsertCheckinRecord / upsertFinanceRecord */
  public async upsertCheckinRecord(item: CheckinRecordIndexItem): Promise<void> {
    return this.upsertCheckin(item);
  }

  /** ✅ 兼容旧调用：UI 会调用 upsertCheckinRecord / upsertFinanceRecord */
  public async upsertFinanceRecord(item: FinanceRecordIndexItem): Promise<void> {
    return this.upsertFinance(item);
  }

  public async upsertHealth(item: HealthRecordIndexItem): Promise<void> {
    await this.ensureReady();
    const snap = await this.getHealthSnapshot(false);
    const rd = normalizeDateKey(item.recordDate) ?? this.host.getTodayKey();
    const eid = normStr(item.entryId);

    const matchKey = (x: HealthRecordIndexItem) => {
      if (eid) return x.recordDate === rd && normStr(x.entryId) === eid;
      return x.recordDate === rd && normStr(x.metricKey) === normStr(item.metricKey) && !normStr(x.entryId);
    };

    const old = (snap.items ?? []).find(matchKey);
    const items = (snap.items ?? []).filter((x) => !matchKey(x));

    const fromItemCa = normalizeHealthCreatedAtMs((item as any).createdAtMs);
    const fromOldCa = normalizeHealthCreatedAtMs((old as any)?.createdAtMs);
    const mergedCreatedAt = fromItemCa ?? fromOldCa;

    const newer: HealthRecordIndexItem = {
      recordDate: rd,
      entryId: eid || undefined,
      metricKey: String(item.metricKey ?? "").trim(),
      period: String(item.period ?? "day").trim() || "day",
      cardRef: normStr(item.cardRef) || undefined,
      valueStr: String(item.valueStr ?? "").trim(),
      note: normStr(item.note) || undefined,
      sleepStartHm: normStr(item.sleepStartHm) || undefined,
      isDelete: !!item.isDelete,
      tsMs: Number(item.tsMs ?? Date.now()),
      ...(mergedCreatedAt != null ? { createdAtMs: mergedCreatedAt } : {}),
      sourceFilePath: normStr(item.sourceFilePath) || normStr(old?.sourceFilePath) || undefined,
      sourceLineMain: (() => {
        const fromItem = item.sourceLineMain;
        if (fromItem !== undefined && fromItem !== null && Number.isFinite(Number(fromItem))) return Number(fromItem);
        const fromOld = old?.sourceLineMain;
        if (fromOld !== undefined && fromOld !== null && Number.isFinite(Number(fromOld))) return Number(fromOld);
        return undefined;
      })(),
    };
    (newer as any).dbSourceHash = computeHealthSourceHash(newer);
    mergeDbSyncMeta(newer as any, old as any);

    items.push(newer);
    items.sort((a, b) => (a.recordDate === b.recordDate ? (a.tsMs ?? 0) - (b.tsMs ?? 0) : a.recordDate.localeCompare(b.recordDate)));
    this.healthSnap = { version: 1, updatedAt: nowIso(), items };
    await this.store!.writeHealthIndex(false, this.healthSnap);

    try {
      this.host.app.workspace.trigger("rslatte:recordIndexChanged", { module: "health" });
    } catch {
      // ignore
    }
  }

  public async upsertHealthRecord(item: HealthRecordIndexItem): Promise<void> {
    return this.upsertHealth(item);
  }

  /**
   * Flush current active record indexes (checkin/finance) to disk.
   * Used when we only update per-item DB sync meta and want a single write.
   */
  public async flushActiveIndexes(): Promise<void> {
    await this.ensureReady();
    const c = await this.getCheckinSnapshot(false);
    const f = await this.getFinanceSnapshot(false);
    const h = await this.getHealthSnapshot(false);
    this.checkinSnap = { version: 1, updatedAt: nowIso(), items: c.items ?? [] };
    this.financeSnap = { version: 1, updatedAt: nowIso(), items: f.items ?? [] };
    this.healthSnap = { version: 1, updatedAt: nowIso(), items: h.items ?? [] };
    await this.store!.writeCheckinIndex(false, this.checkinSnap);
    await this.store!.writeFinanceIndex(false, this.financeSnap);
    await this.store!.writeHealthIndex(false, this.healthSnap);
    
    // ✅ 同步更新统计缓存
    await this.syncCheckinStatsCache();
    await this.syncFinanceStatsCache();
  }

  /** 自动归档：每日一次。把阈值日前的记录从 active 索引移动到 archive 索引 */
  public async autoArchiveIfNeeded(): Promise<void> {
    const s: any = this.settings as any;
    const todayKey = this.host.getTodayKey();

    const runOne = async (k: "checkin" | "finance" | "health") => {
      const enabled =
        k === "checkin"
          ? (this.host as any).isCheckinModuleEnabled?.() ?? true
          : k === "finance"
            ? (this.host as any).isFinanceModuleEnabled?.() ?? false
            : (this.host as any).isHealthModuleEnabled?.() === true;
      if (!enabled) return;

      const autoEnabled =
        k === "checkin"
          ? this.isCheckinAutoArchiveEnabled()
          : k === "finance"
            ? this.isFinanceAutoArchiveEnabled()
            : this.isHealthAutoArchiveEnabled();
      if (!autoEnabled) return;

      const last = String(
        (k === "checkin"
          ? s?.checkinPanel?.archiveLastRunKey
          : k === "finance"
            ? s?.financePanel?.archiveLastRunKey
            : s?.healthPanel?.archiveLastRunKey) ?? s.rslattePanelArchiveLastRunKey ?? ""
      ).trim();
      if (last === todayKey) return;

      const mods: RecordModules =
        k === "checkin"
          ? { checkin: true, finance: false, health: false }
          : k === "finance"
            ? { checkin: false, finance: true, health: false }
            : { checkin: false, finance: false, health: true };

      await this.archiveNow(mods);

      if (!s.checkinPanel) s.checkinPanel = {};
      if (!s.financePanel) s.financePanel = {};
      if (!s.healthPanel) s.healthPanel = {};
      if (k === "checkin") s.checkinPanel.archiveLastRunKey = todayKey;
      else if (k === "finance") s.financePanel.archiveLastRunKey = todayKey;
      else s.healthPanel.archiveLastRunKey = todayKey;

      // legacy：保留写入，便于旧版本识别
      s.rslattePanelArchiveLastRunKey = todayKey;
      await this.host.saveSettings();
    };

    await runOne("checkin");
    await runOne("finance");
    await runOne("health");
  }

  public async archiveNow(modules?: RecordModules): Promise<{
    cutoffDate: string;
    checkinArchived: number;
    financeArchived: number;
    healthArchived: number;
    listsArchivedCheckin: number;
    listsArchivedFinance: number;
  }> {
    await this.ensureReady();
    const mods = normalizeModules(modules);
    const todayKey = this.host.getTodayKey();

    const cutoffC = cutoffDateKey(todayKey, this.getCheckinArchiveThresholdDays());
    const cutoffF = cutoffDateKey(todayKey, this.getFinanceArchiveThresholdDays());
    const cutoffH = cutoffDateKey(todayKey, this.getHealthArchiveThresholdDays());
    const cutoffParts: string[] = [];
    if (mods.checkin) cutoffParts.push(cutoffC);
    if (mods.finance) cutoffParts.push(cutoffF);
    if (mods.health) cutoffParts.push(cutoffH);
    const cutoff =
      cutoffParts.length === 0
        ? cutoffDateKey(todayKey, this.getArchiveThresholdDays())
        : cutoffParts.sort()[0];

    const activeC = await this.getCheckinSnapshot(false);
    const archC = await this.getCheckinSnapshot(true);
    const activeF = await this.getFinanceSnapshot(false);
    const archF = await this.getFinanceSnapshot(true);
    const activeH = await this.getHealthSnapshot(false);
    const archH = await this.getHealthSnapshot(true);

    const moveCheckin = mods.checkin ? (activeC.items ?? []).filter((x) => x.recordDate < cutoffC) : [];
    const keepCheckin = mods.checkin ? (activeC.items ?? []).filter((x) => !(x.recordDate < cutoffC)) : (activeC.items ?? []);

    const moveFinance = mods.finance ? (activeF.items ?? []).filter((x) => x.recordDate < cutoffF) : [];
    const keepFinance = mods.finance ? (activeF.items ?? []).filter((x) => !(x.recordDate < cutoffF)) : (activeF.items ?? []);

    const moveHealth = mods.health ? (activeH.items ?? []).filter((x) => x.recordDate < cutoffH) : [];
    const keepHealth = mods.health ? (activeH.items ?? []).filter((x) => !(x.recordDate < cutoffH)) : (activeH.items ?? []);

    // merge into archive without duplicates (recordDate + id)
    const mergeC = new Map<string, CheckinRecordIndexItem>();
    for (const it of (archC.items ?? [])) mergeC.set(`${it.recordDate}::${String(it.checkinId)}`, it);
    for (const it of moveCheckin) mergeC.set(`${it.recordDate}::${String(it.checkinId)}`, it);

    const finMergeKey = (it: FinanceRecordIndexItem) =>
      normStr(it.entryId)
        ? `${it.recordDate}::${String(it.categoryId)}::${normStr(it.entryId)}`
        : `${it.recordDate}::${String(it.categoryId)}::legacy`;
    const mergeF = new Map<string, FinanceRecordIndexItem>();
    for (const it of (archF.items ?? [])) mergeF.set(finMergeKey(it), it);
    for (const it of moveFinance) mergeF.set(finMergeKey(it), it);

    const healthMergeKey = (it: HealthRecordIndexItem) =>
      normStr(it.entryId)
        ? `${it.recordDate}::${normStr(it.entryId)}`
        : `${it.recordDate}::m::${normStr(it.metricKey)}`;
    const mergeH = new Map<string, HealthRecordIndexItem>();
    for (const it of (archH.items ?? [])) mergeH.set(healthMergeKey(it), it);
    for (const it of moveHealth) mergeH.set(healthMergeKey(it), it);

    const newArchC = Array.from(mergeC.values()).sort((a, b) => (a.recordDate === b.recordDate ? (a.tsMs ?? 0) - (b.tsMs ?? 0) : a.recordDate.localeCompare(b.recordDate)));
    const newArchF = Array.from(mergeF.values()).sort((a, b) => (a.recordDate === b.recordDate ? (a.tsMs ?? 0) - (b.tsMs ?? 0) : a.recordDate.localeCompare(b.recordDate)));
    const newArchH = Array.from(mergeH.values()).sort((a, b) => (a.recordDate === b.recordDate ? (a.tsMs ?? 0) - (b.tsMs ?? 0) : a.recordDate.localeCompare(b.recordDate)));

    this.checkinSnap = { version: 1, updatedAt: nowIso(), items: keepCheckin };
    this.financeSnap = { version: 1, updatedAt: nowIso(), items: keepFinance };
    this.healthSnap = { version: 1, updatedAt: nowIso(), items: keepHealth };
    this.checkinArchiveSnap = { version: 1, updatedAt: nowIso(), items: newArchC };
    this.financeArchiveSnap = { version: 1, updatedAt: nowIso(), items: newArchF };
    this.healthArchiveSnap = { version: 1, updatedAt: nowIso(), items: newArchH };

    await this.store!.writeCheckinIndex(false, this.checkinSnap);
    await this.store!.writeFinanceIndex(false, this.financeSnap);
    await this.store!.writeHealthIndex(false, this.healthSnap);
    await this.store!.writeCheckinIndex(true, this.checkinArchiveSnap);
    await this.store!.writeFinanceIndex(true, this.financeArchiveSnap);
    await this.store!.writeHealthIndex(true, this.healthArchiveSnap);
    
    // ✅ 同步更新统计缓存
    await this.syncCheckinStatsCache();
    await this.syncFinanceStatsCache();

    // 同时归档“已删除”的清单条目（打卡项/财务分类）
    const listsRes = await this.archiveDeletedListsNow(mods);

    return {
      cutoffDate: cutoff,
      checkinArchived: moveCheckin.length,
      financeArchived: moveFinance.length,
      healthArchived: moveHealth.length,
      listsArchivedCheckin: listsRes.checkinArchived,
      listsArchivedFinance: listsRes.financeArchived,
    };
  }

  /**
   * 基础索引构建：扫描 diaryPath 下的日记文件（根据 diaryNameFormat 解析日期），
   * 从“## 打卡记录 / ## 账单信息”里提取可解析的行，写入中央索引。
   */
  public async refreshIndexFromDiaryScan(): Promise<void> {
    // 为了保证“扫描重建索引”可用：旧入口直接走 rebuild；reconcileMissingDays 清理已删日记对应日期
    await this.rebuildIndexFromDiaryRange(true, true, undefined, true);
  }

  private getLastDiaryScanMs(): number {
    const v = Number((this.settings as any).rslattePanelLastDiaryScanMs ?? 0);
    return Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
  }

  private setLastDiaryScanMs(v: number) {
    (this.settings as any).rslattePanelLastDiaryScanMs = Math.max(0, Math.floor(Number(v) || 0));
  }

  private parseDiaryDateFromFile(f: TFile): string | null {
    const base = f.basename;
    const fmt = String(this.settings.diaryNameFormat ?? "YYYYMMDD").trim() || "YYYYMMDD";
    const m = momentFn(base, fmt, true);
    if (!m.isValid()) return null;
    return m.format("YYYY-MM-DD");
  }

  private parseDiaryForDay(raw: string, dayKey: string, fileMtimeMs: number, sourceFilePath: string): {
    checkins: Map<string, CheckinRecordIndexItem>;
    finances: Map<string, FinanceRecordIndexItem>;
    healths: Map<string, HealthRecordIndexItem>;
    discoveredCheckins: Map<string, string>; // id->name
    discoveredFinanceCats: Map<string, { name?: string; type: "income" | "expense" }>;
  } {
    const lines = raw.split("\n");

    const checkins = new Map<string, CheckinRecordIndexItem>();
    const finances = new Map<string, FinanceRecordIndexItem>();
    const healths = new Map<string, HealthRecordIndexItem>();
    const discoveredCheckins = new Map<string, string>();
    const discoveredFinanceCats = new Map<string, { name?: string; type: "income" | "expense" }>();

    // - 2026-01-02 12:30 DK_xxx 名称 ✅ note
    const checkinRe = /^\s*[-*]\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+([A-Za-z0-9_]+)\s+(.+?)\s+(✅|❌)\s*(.*)$/;

    // finance: record / cancel
    // 记录：- 2026-01-02 expense CW_FOOD note -12.00
    // 取消：- ❌ 2026-01-02 12:30 expense CW_FOOD 餐饮 note 12.00
    const finLineRe = FINANCE_DIARY_MAIN_LINE_RE;

    // 按“最后一行 wins”决定同一条目最终状态（约定：同一条目多次出现取最后一行）
    // 注意：不要用 tsMs 判定新旧，否则会因 fileMtime/时间字段不一致导致取消状态被覆盖。
    const lastCheckinLine = new Map<string, number>();
    const lastFinanceLine = new Map<string, number>();
    const lastHealthLine = new Map<string, number>();
    /** legacy：无 meta 时按分类单日一条；有 entryId 时按 entryId 多条 */
    const lastFinanceItem = new Map<string, FinanceRecordIndexItem>();
    const lastActiveFinanceByEntryId = new Map<string, FinanceRecordIndexItem>();
    const lastActiveHealthByEntryId = new Map<string, HealthRecordIndexItem>();

    const pickLastLine = (id: string, lineNo: number, map: Map<string, number>) => {
      const old = map.get(id);
      return old == null || lineNo >= old;
    };

    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];

      // ---- checkin ----
      const mc = ln.match(checkinRe);
      if (mc) {
        const rd = mc[1];
        if (rd !== dayKey) continue;
        const time = mc[2];
        const checkinId = String(mc[3]);
        const name = String(mc[4]).trim();
        const mark = mc[5];
        const note = (mc[6] ?? "").trim();
        const ts = momentFn(`${rd} ${time}`, "YYYY-MM-DD HH:mm", true);
        const tsMs = ts.isValid() ? ts.valueOf() : (fileMtimeMs + i);

        // 同一 checkinId 在同一天可能出现多条（补记/取消/恢复），取最后一行。
        if (pickLastLine(checkinId, i, lastCheckinLine)) {
          lastCheckinLine.set(checkinId, i);
          const it: CheckinRecordIndexItem = {
            recordDate: rd,
            checkinId,
            checkinName: name,
            note: note || undefined,
            isDelete: mark === "❌",
            tsMs,
          };
          (it as any).dbSourceHash = computeCheckinSourceHash(it);
          checkins.set(checkinId, it);
        }
        discoveredCheckins.set(checkinId, name);
        continue;
      }

      // ---- finance ----
      const mf = ln.match(finLineRe);
      if (mf) {
        const mark = (mf[1] ?? "") as any;
        const rd = mf[2];
        if (rd !== dayKey) continue;
        const time = mf[3] ?? "";
        const type = (mf[4] as any) === "income" ? "income" : "expense";
        const catId = String(mf[5]);
        const tail = String(mf[6] ?? "").trim();

        let tsMs = fileMtimeMs + i;
        if (time) {
          const ts = momentFn(`${rd} ${time}`, "YYYY-MM-DD HH:mm", true);
          if (ts.isValid()) tsMs = ts.valueOf();
        }

        // extract last amount
        const mAmt = tail.match(/([+-]?\d+(?:\.\d+)?)(?!.*[+-]?\d+(?:\.\d+)?)/);
        const amtRaw = mAmt ? Number(mAmt[1]) : NaN;
        const hasAmt = Number.isFinite(amtRaw);
        const beforeAmt = mAmt ? tail.slice(0, (mAmt.index ?? tail.length)).trim() : tail;

        // heuristic catName & note
        let catName: string | undefined;
        let note: string | undefined;
        const tokens = beforeAmt ? beforeAmt.split(/\s+/).filter(Boolean) : [];

        const normalizeName = (s: string) => String(s ?? "").trim().replace(/\s+/g, "");
        const knownCatName = (() => {
          const hit = (this.settings.financeCategories ?? []).find((x) => String((x as any)?.id ?? "") === catId);
          return hit ? String((hit as any).name ?? "") : "";
        })();

        const firstLooksLikeName = (t: string) => /[^\x00-\x7F]/.test(t) && !/[0-9]/.test(t) && t.length <= 20;

        if (mark) {
          // cancel line typically includes categoryName
          catName = tokens[0];
          note = tokens.slice(1).join(" ").trim() || undefined;
        } else if (
          tokens.length >= 2 &&
          // 优先：若与“已配置分类名”一致，则稳定解析为分类名（兼容英文分类名 & 规避旧格式 note 误判）
          (normalizeName(tokens[0]) && normalizeName(tokens[0]) === normalizeName(knownCatName))
        ) {
          catName = tokens[0];
          note = tokens.slice(1).join(" ").trim() || undefined;
        } else if (tokens.length >= 2 && firstLooksLikeName(tokens[0])) {
          // 次级：中文名启发式
          catName = tokens[0];
          note = tokens.slice(1).join(" ").trim() || undefined;
        } else {
          note = beforeAmt || undefined;
        }

        const parsedMeta = extractFinanceMeta(note ?? "");
        discoveredFinanceCats.set(catId, { name: catName, type });

        const metaPeek = peekFinanceMetaAfterMain(lines, i);
        if (metaPeek) {
          const eid = metaPeek.meta.entry_id;
          const key = `id:${eid}`;
          if (!pickLastLine(key, i, lastFinanceLine)) continue;
          lastFinanceLine.set(key, i);

          const parsedBody = extractFinanceMeta(note ?? "");
          const cycleT = normalizeFinanceCycleType(String(metaPeek.meta.cycle_type ?? "none"));
          const indexNote =
            buildFinanceMainNoteParts({
              subcategory: metaPeek.meta.subcategory,
              institutionName: metaPeek.meta.institution_name ?? "",
              cycleType: cycleT,
              bodyNote: parsedBody.body,
            }) || undefined;
          const sceneTags =
            metaPeek.meta.scene_tags && metaPeek.meta.scene_tags.length > 0
              ? metaPeek.meta.scene_tags
              : parsedBody.sceneTags?.length
                ? parsedBody.sceneTags
                : undefined;
          const instName = metaPeek.meta.institution_name || parsedMeta.institutionName || undefined;
          const metaCycleId = normStr(metaPeek.meta.cycle_id);
          const cycleIdField = metaCycleId || undefined;

          const isDel = mark === "❌" || metaPeek.meta.is_delete === true;
          if (isDel) {
            const prev = lastActiveFinanceByEntryId.get(eid);
            const amountBase = prev?.amount ?? (hasAmt ? amtRaw : 0);
            const amtSigned =
              (prev?.type ?? type) === "expense" ? -Math.abs(Number(amountBase)) : Math.abs(Number(amountBase));
            const it: FinanceRecordIndexItem = {
              recordDate: rd,
              entryId: eid,
              categoryId: catId,
              categoryName: catName || prev?.categoryName,
              type: prev?.type ?? type,
              subcategory: metaPeek.meta.subcategory,
              amount: Number.isFinite(amtSigned) ? amtSigned : 0,
              note: indexNote ?? prev?.note,
              institutionName: instName || prev?.institutionName,
              cycleType: cycleT,
              cycleId: cycleIdField,
              sceneTags: sceneTags ?? prev?.sceneTags,
              isDelete: true,
              tsMs,
              sourceFilePath,
              sourceLineMain: i,
            };
            (it as any).dbSourceHash = computeFinanceSourceHash(it);
            finances.set(key, it);
            continue;
          }

          if (!hasAmt) continue;
          let amount = amtRaw;
          if (type === "expense" && amount > 0) amount = -Math.abs(amount);
          if (type === "income" && amount < 0) amount = Math.abs(amount);

          const rec: FinanceRecordIndexItem = {
            recordDate: rd,
            entryId: eid,
            categoryId: catId,
            categoryName: catName,
            type,
            subcategory: metaPeek.meta.subcategory,
            amount,
            note: indexNote,
            institutionName: instName,
            cycleType: cycleT,
            cycleId: cycleIdField,
            sceneTags,
            isDelete: false,
            tsMs,
            sourceFilePath,
            sourceLineMain: i,
          };
          (rec as any).dbSourceHash = computeFinanceSourceHash(rec);
          finances.set(key, rec);
          lastActiveFinanceByEntryId.set(eid, rec);
          continue;
        }

        // —— 无合法 meta：legacy（同日同分类仅保留最后一行）——
        const key = catId;
        const prevNonDel = lastFinanceItem.get(key);
        if (!pickLastLine(key, i, lastFinanceLine)) continue;
        lastFinanceLine.set(key, i);

        if (mark === "❌") {
          const prev = prevNonDel;
          const amount = prev?.amount ?? (hasAmt ? Math.abs(amtRaw) : 0);
          const it: FinanceRecordIndexItem = {
            recordDate: rd,
            categoryId: catId,
            categoryName: catName || prev?.categoryName,
            type: prev?.type ?? type,
            amount: prev?.amount ?? (type === "expense" ? -Math.abs(amount) : Math.abs(amount)),
            note: note ?? prev?.note,
            institutionName: parsedMeta.institutionName || prev?.institutionName,
            cycleType: parsedMeta.cycleType || prev?.cycleType,
            sceneTags: (parsedMeta.sceneTags?.length ?? 0) > 0 ? parsedMeta.sceneTags : prev?.sceneTags,
            isDelete: true,
            tsMs,
            sourceFilePath,
            sourceLineMain: i,
          };
          (it as any).dbSourceHash = computeFinanceSourceHash(it);
          finances.set(key, it);
          continue;
        }

        if (!hasAmt) continue;
        let amount = amtRaw;
        if (type === "expense" && amount > 0) amount = -Math.abs(amount);
        if (type === "income" && amount < 0) amount = Math.abs(amount);

        const rec: FinanceRecordIndexItem = {
          recordDate: rd,
          categoryId: catId,
          categoryName: catName,
          type,
          amount,
          note: note || undefined,
          institutionName: parsedMeta.institutionName || undefined,
          cycleType: parsedMeta.cycleType || undefined,
          sceneTags: parsedMeta.sceneTags?.length ? parsedMeta.sceneTags : undefined,
          isDelete: false,
          tsMs,
          sourceFilePath,
          sourceLineMain: i,
        };
        (rec as any).dbSourceHash = computeFinanceSourceHash(rec);
        finances.set(key, rec);
        lastFinanceItem.set(key, rec);
        continue;
      }

      // ---- health ----
      const mh = ln.match(HEALTH_DIARY_MAIN_LINE_RE);
      if (mh) {
        const mark = (mh[1] ?? "") as string;
        const rd = mh[2];
        if (rd !== dayKey) continue;
        const time = mh[3] ?? "";
        const metricToken = String(mh[4] ?? "").trim();
        let valueStr = String(mh[5] ?? "").trim();
        const noteTail = String(mh[6] ?? "").trim();
        const waterMlPer = Math.max(50, Math.min(2000, Number(this.settings.healthPanel?.waterCupVolumeMl) || 500));

        const resolveWaterCupsValueStr = (mk: string, rawMainVal: string, cupsFromMeta?: number): string => {
          if (String(mk ?? "").trim() !== "water_cups") return rawMainVal;
          if (typeof cupsFromMeta === "number" && Number.isFinite(cupsFromMeta)) {
            return String(Math.max(0, Math.min(30, Math.floor(cupsFromMeta))));
          }
          const mMl = rawMainVal.match(/^(\d+)\s*ml$/i);
          if (mMl) {
            const ml = parseInt(mMl[1], 10);
            if (Number.isFinite(ml) && ml >= 0) {
              return String(Math.max(0, Math.round(ml / waterMlPer)));
            }
          }
          return rawMainVal;
        };

        let tsMs = fileMtimeMs + i;
        if (time) {
          const ts = momentFn(`${rd} ${time}`, "YYYY-MM-DD HH:mm", true);
          if (ts.isValid()) tsMs = ts.valueOf();
        }

        const metaPeek = peekHealthMetaAfterMain(lines, i);
        if (metaPeek) {
          const eid = String(metaPeek.meta.entry_id ?? "").trim();
          const key = `id:${eid}`;
          if (!pickLastLine(key, i, lastHealthLine)) continue;
          lastHealthLine.set(key, i);

          const period = String(metaPeek.meta.period ?? "day").trim() || "day";
          const cardRef = String(metaPeek.meta.card_ref ?? "").trim() || undefined;
          const isDel = mark === "❌" || metaPeek.meta.is_delete === true;
          const mkResolvedBase =
            String(metaPeek.meta.metric_key ?? "").trim() || healthMetricKeyFromMainLineLabel(metricToken);
          valueStr = resolveWaterCupsValueStr(mkResolvedBase, valueStr, metaPeek.meta.cups);
          const cam = normalizeHealthCreatedAtMs(metaPeek.meta.created_at_ms);

          if (isDel) {
            const prev = lastActiveHealthByEntryId.get(eid);
            const prevCa = normalizeHealthCreatedAtMs(prev?.createdAtMs);
            const mergedCa = cam ?? prevCa;
            const tsMsForItem = mergedCa ?? tsMs;
            const mkDel = mkResolvedBase;
            const metaDietDel = String(metaPeek.meta.diet_note ?? "").trim();
            const noteDel =
              mkDel === "diet" && metaDietDel ? metaDietDel : noteTail || prev?.note;
            const sleepHmDel =
              mkDel === "sleep_hours"
                ? metaPeek.meta.sleep_start_hm || prev?.sleepStartHm
                : undefined;
            const it: HealthRecordIndexItem = {
              recordDate: rd,
              entryId: eid,
              metricKey: mkDel,
              period,
              cardRef: cardRef || prev?.cardRef,
              valueStr: valueStr || prev?.valueStr || "",
              note: noteDel,
              sleepStartHm: sleepHmDel,
              isDelete: true,
              tsMs: tsMsForItem,
              ...(mergedCa != null ? { createdAtMs: mergedCa } : {}),
              sourceFilePath,
              sourceLineMain: i,
            };
            (it as any).dbSourceHash = computeHealthSourceHash(it);
            healths.set(key, it);
            continue;
          }

          const mkResolved = mkResolvedBase;
          const metaDietNote = String(metaPeek.meta.diet_note ?? "").trim();
          const noteForIndex =
            mkResolved === "diet" && metaDietNote ? metaDietNote : noteTail || undefined;
          const tsMsForRec = cam ?? tsMs;
          const rec: HealthRecordIndexItem = {
            recordDate: rd,
            entryId: eid,
            metricKey: mkResolved,
            period,
            cardRef,
            valueStr,
            note: noteForIndex,
            sleepStartHm: mkResolved === "sleep_hours" ? metaPeek.meta.sleep_start_hm : undefined,
            isDelete: false,
            tsMs: tsMsForRec,
            ...(cam != null ? { createdAtMs: cam } : {}),
            sourceFilePath,
            sourceLineMain: i,
          };
          (rec as any).dbSourceHash = computeHealthSourceHash(rec);
          healths.set(key, rec);
          lastActiveHealthByEntryId.set(eid, rec);
          continue;
        }

        const metricKey = healthMetricKeyFromMainLineLabel(metricToken);
        valueStr = resolveWaterCupsValueStr(metricKey, valueStr, undefined);

        const key = `m:${metricKey}`;
        if (!pickLastLine(key, i, lastHealthLine)) continue;
        lastHealthLine.set(key, i);

        if (mark === "❌") {
          const prev = healths.get(key);
          const it: HealthRecordIndexItem = {
            recordDate: rd,
            metricKey,
            period: "day",
            valueStr: valueStr || prev?.valueStr || "",
            note: noteTail || prev?.note,
            isDelete: true,
            tsMs,
            sourceFilePath,
            sourceLineMain: i,
          };
          (it as any).dbSourceHash = computeHealthSourceHash(it);
          healths.set(key, it);
          continue;
        }

        const rec: HealthRecordIndexItem = {
          recordDate: rd,
          metricKey,
          period: "day",
          valueStr,
          note: noteTail || undefined,
          isDelete: false,
          tsMs,
          sourceFilePath,
          sourceLineMain: i,
        };
        (rec as any).dbSourceHash = computeHealthSourceHash(rec);
        healths.set(key, rec);
        continue;
      }
    }

    return { checkins, finances, healths, discoveredCheckins, discoveredFinanceCats };
  }

  /**
   * ✅ 从财务记录中提取子分类并补全到财务分类清单中
   */
  private async enrichFinanceCategoriesWithSubcategories(financeRecords: FinanceRecordIndexItem[]): Promise<void> {
    if (!financeRecords || financeRecords.length === 0) return;
    
    const settings = this.host.settingsRef();
    const financeCategories = settings.financeCategories ?? [];
    if (financeCategories.length === 0) return;
    
    // 收集每个分类的子分类（从记录中提取）
    const subcategoriesByCategory = new Map<string, Set<string>>();
    
    let totalRecords = 0;
    let recordsWithSubcategory = 0;
    
    for (const record of financeRecords) {
      totalRecords++;
      const categoryId = String(record.categoryId ?? "").trim();
      if (!categoryId) continue;
      
      // 从 note 中提取子分类
      const note = record.note ?? "";
      const { subcategory } = extractFinanceSubcategory(note);
      
      if (this.settings.debugLogEnabled && note) {
        console.log(`[RSLatte][enrichFinance] Record ${categoryId}: note="${note}", extracted subcategory="${subcategory}"`);
      }
      
      if (!subcategory) continue;
      
      const normalized = normalizeFinanceSubcategory(subcategory);
      if (!normalized) continue;
      
      recordsWithSubcategory++;
      
      if (!subcategoriesByCategory.has(categoryId)) {
        subcategoriesByCategory.set(categoryId, new Set<string>());
      }
      subcategoriesByCategory.get(categoryId)!.add(normalized);
    }
    
    if (this.settings.debugLogEnabled) {
      console.log(`[RSLatte][enrichFinance] 扫描了 ${totalRecords} 条记录，其中 ${recordsWithSubcategory} 条包含子分类，涉及 ${subcategoriesByCategory.size} 个分类`);
    }
    
    // 将提取的子分类添加到对应财务分类的 subCategories 列表中
    let changed = false;
    let addedCount = 0;
    
    for (const cat of financeCategories) {
      const categoryId = String(cat.id ?? "").trim();
      if (!categoryId) continue;
      
      const discoveredSubs = subcategoriesByCategory.get(categoryId);
      if (!discoveredSubs || discoveredSubs.size === 0) continue;
      
      // 初始化 subCategories 数组（如果不存在）
      if (!cat.subCategories) {
        cat.subCategories = [];
      }
      
      // 添加新的子分类（去重）
      for (const sub of discoveredSubs) {
        if (!cat.subCategories.includes(sub)) {
          cat.subCategories.push(sub);
          changed = true;
          addedCount++;
          
          if (this.settings.debugLogEnabled) {
            console.log(`[RSLatte][enrichFinance] 为分类 ${categoryId}(${cat.name}) 添加子分类: ${sub}`);
          }
        }
      }
    }
    
    // 如果有变更，保存设置
    if (changed) {
      await this.host.saveSettings();
      if (this.settings.debugLogEnabled) {
        console.log(`[RSLatte][RecordRSLatte] 已从财务记录中补全 ${subcategoriesByCategory.size} 个分类的子分类，共添加 ${addedCount} 个子分类`);
      }
    } else if (this.settings.debugLogEnabled) {
      console.log(`[RSLatte][enrichFinance] 未发现新的子分类需要添加`);
    }
  }

  private async addMissingListsFromDiary(discovered: {
    checkins: Map<string, string>;
    financeCats: Map<string, { name?: string; type: "income" | "expense" }>;
  }): Promise<void> {
    const now = nowIso();
    const active = await this.getListsSnapshot(false);
    const arch = await this.getListsSnapshot(true);

    // 决策用 tombstone：active + archive 合并（兜底）
    const tombDecisionC = new Set((active.tombstoneCheckinIds ?? []).map((x) => String(x)));
    const tombDecisionF = new Set((active.tombstoneFinanceIds ?? []).map((x) => String(x)));
    (arch.tombstoneCheckinIds ?? []).forEach((x) => tombDecisionC.add(String(x)));
    (arch.tombstoneFinanceIds ?? []).forEach((x) => tombDecisionF.add(String(x)));

    // 输出用 tombstone：仅写回 active 的 tombstone（避免污染 archive）
    const outTombC = new Set((active.tombstoneCheckinIds ?? []).map((x) => String(x)));
    const outTombF = new Set((active.tombstoneFinanceIds ?? []).map((x) => String(x)));

    const byIdC = new Map<string, CheckinItemIndexItem>();
    for (const it of (active.checkinItems ?? [])) byIdC.set(String(it.id), { ...it });
    for (const it of (arch.checkinItems ?? [])) if (!byIdC.has(String(it.id))) byIdC.set(String(it.id), { ...it });

    const byIdF = new Map<string, FinanceCatIndexItem>();
    for (const it of (active.financeCategories ?? [])) byIdF.set(String(it.id), { ...it });
    for (const it of (arch.financeCategories ?? [])) if (!byIdF.has(String(it.id))) byIdF.set(String(it.id), { ...it });

    // 未使用的函数已删除：_shouldRestoreAutoDeleted
    // const _shouldRestoreAutoDeleted = (it: { createdAt?: string | null; deletedAt?: string | null }) => {
      // const ca = it.createdAt ? Date.parse(String(it.createdAt)) : NaN;
      // const da = it.deletedAt ? Date.parse(String(it.deletedAt)) : NaN;
      // if (!Number.isFinite(ca) || !Number.isFinite(da)) return false;
      // createdAt 与 deletedAt 相差很小（例如“重建后未合并 settings，随后 settings-save 误删”）
      // return Math.abs(da - ca) <= 2 * 60 * 1000;
    // };

    let changed = false;

    // Checkin
    for (const [idRaw, nameRaw] of discovered.checkins.entries()) {
      const id = String(idRaw ?? "").trim();
      if (!id) continue;
      const name = String(nameRaw ?? "").trim();

      const exist = byIdC.get(id);
      if (exist) {
        // ✅ 若历史被删除(tombstone)或软删除(deletedAt)但现在在日记里再次出现，则认为“恢复”，并移除 tombstone
        const wasDeleted = Boolean((exist as any).deletedAt);
        const wasTomb = tombDecisionC.has(id);
        if (wasDeleted || wasTomb) {
          (exist as any).deletedAt = null;
          (exist as any).updatedAt = now;
          (exist as any).active = false;
          if (name) (exist as any).name = name;
          byIdC.set(id, { ...(exist as any) });
          outTombC.delete(id);
          changed = true;
        }
        continue;
      }

      if (tombDecisionC.has(id)) {
        // ✅ 历史 tombstone 但列表里不存在：按“恢复”处理，写入新条目并移除 tombstone（以当前日记为准）
        byIdC.set(id, { id, name: name || id, active: false, createdAt: now, updatedAt: now, deletedAt: null });
        outTombC.delete(id);
        changed = true;
        continue;
      }

      // 新增
      byIdC.set(id, { id, name: name || id, active: false, createdAt: now, updatedAt: now, deletedAt: null });
      changed = true;
    }

    // Finance
    for (const [idRaw, meta] of discovered.financeCats.entries()) {
      const id = String(idRaw ?? "").trim();
      if (!id) continue;

      const exist = byIdF.get(id);
      if (exist) {
        const wasDeleted = Boolean((exist as any).deletedAt);
        const wasTomb = tombDecisionF.has(id);
        if (wasDeleted || wasTomb) {
          (exist as any).deletedAt = null;
          (exist as any).updatedAt = now;
          (exist as any).active = false;
          if (meta?.name) (exist as any).name = String(meta.name);
          (exist as any).type = (meta?.type === "income" ? "income" : "expense");
          byIdF.set(id, { ...(exist as any) });
          outTombF.delete(id);
          changed = true;
        }
        continue;
      }

      if (tombDecisionF.has(id)) {
        byIdF.set(id, {
          id,
          name: meta?.name || id,
          type: meta.type,
          active: false,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        });
        outTombF.delete(id);
        changed = true;
        continue;
      }

      byIdF.set(id, {
        id,
        name: meta?.name || id,
        type: meta.type,
        active: false,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
      changed = true;
    }

    if (!changed) return;

    const out: RSLatteListsIndexFile = {
      version: 1,
      updatedAt: now,
      checkinItems: Array.from(byIdC.values()).sort((a, b) => String(a.id).localeCompare(String(b.id))),
      financeCategories: Array.from(byIdF.values()).sort((a, b) => String(a.id).localeCompare(String(b.id))),
      tombstoneCheckinIds: Array.from(outTombC.values()).sort(),
      tombstoneFinanceIds: Array.from(outTombF.values()).sort(),
    };

    this.listsSnap = out;
    await this.store!.writeListsIndex(false, out);

    // ✅ 关键：把 lists index 中新增的条目合并到 settings，避免后续 settings-save 把它们误 tombstone，且让 UI 能显示
    try {
      const r = await this.mergeListsIndexIntoSettings();
      if ((r.addedCheckins ?? 0) > 0 || (r.addedFinance ?? 0) > 0) {
        await this.host.saveSettings();
      }
    } catch (e) {
      console.warn('RecordRSLatte mergeListsIndexIntoSettings after rebuild failed:', e);
    }
  }


  
  /**
   * ✅ E2-05：原子化 Step A（record 增量扫描）：仅扫描 diaryPath 下 mtime > waterline 且在 cutoff 范围内的日记。
   * - 不写入索引、不改水位，只返回扫描结果。
   */
  public async scanIncrementalFromDiary(opts?: { modules?: RecordModules; forceIncludeEqualMtime?: boolean }): Promise<RecordIncrementalScan | null> {
    await this.ensureReady();
    const mods = normalizeModules(opts?.modules);
    if (!mods.checkin && !mods.finance && !mods.health) return null;
    const forceIncludeEqualMtime = opts?.forceIncludeEqualMtime === true;

    const s = this.settings;
    // 获取当前空间ID，然后从空间的 settingsSnapshot 中获取 diaryPath
    const currentSpaceId = (s as any).currentSpaceId || "";
    const spaces = (s as any).spaces || {};
    const currentSpace = spaces[currentSpaceId];
    const spaceDiaryPath = currentSpace?.settingsSnapshot?.diaryPath;
    // 优先使用空间的 diaryPath，否则使用全局的 diaryPath
    const diaryRoot = normalizePath(String(spaceDiaryPath ?? s.diaryPath ?? '').trim());
    
    if (s.debugLogEnabled) {
      console.log(`[RSLatte][RecordRSLatte][DEBUG] scanIncrementalFromDiary: currentSpaceId=${currentSpaceId}, spaceDiaryPath=${spaceDiaryPath || '(empty)'}, globalDiaryPath=${s.diaryPath || '(empty)'}, finalDiaryRoot=${diaryRoot || '(empty)'}`);
    }
    
    if (!diaryRoot) return null;

    const rootAf = this.host.app.vault.getAbstractFileByPath(diaryRoot);
    if (!rootAf) return null;

    const todayKey = this.host.getTodayKey();
    const cutoff = this.getScanCutoffDateKeyForModules(todayKey, mods);
    const sinceMs = this.getLastDiaryScanMs();
    
    // ✅ DEBUG: 记录增量扫描的起始参数
    if (s.debugLogEnabled) {
      console.log(`[RSLatte][RecordRSLatte][DEBUG] scanIncrementalFromDiary: sinceMs=${new Date(sinceMs).toISOString()} (${sinceMs}), cutoff=${cutoff}, diaryRoot=${diaryRoot}`);
    }

    const dayKeysScanned = new Set<string>();
    const discoveredCheckins = new Map<string, string>();
    const discoveredFinanceCats = new Map<string, { name?: string; type: 'income' | 'expense' }>();
    const parsedByDay = new Map<string, RecordDayParsedMaps>();
    let maxMtime = sinceMs;
    
    // ✅ 收集扫描到的文件清单（用于 DEBUG 日志）
    const scannedFiles: Array<{ path: string; dayKey: string; mtime: number }> = [];

    const scanFile = async (f: TFile) => {
      if (f.extension.toLowerCase() !== 'md') return;
      const mtime = Number(f.stat?.mtime ?? 0);
      
      // ✅ 如果 forceIncludeEqualMtime 为 true，即使 mtime === sinceMs 也进行扫描（用于 manual_refresh）
      // ✅ 这样可以处理 Obsidian 缓存或文件系统时间精度问题
      const shouldSkip = !Number.isFinite(mtime) || (mtime < sinceMs) || (!forceIncludeEqualMtime && mtime === sinceMs);
      
      // ✅ DEBUG: 记录文件 mtime 比较情况（所有文件，不只是跳过的）
      if (s.debugLogEnabled) {
        const mtimeDate = new Date(mtime).toISOString();
        const sinceDate = new Date(sinceMs).toISOString();
        const diff = mtime - sinceMs;
        if (mtime < sinceMs) {
          console.log(`[RSLatte][RecordRSLatte][DEBUG] scanIncrementalFromDiary: Skipping file ${f.path} (mtime=${mtimeDate} < sinceMs=${sinceDate}, diff=${diff}ms)`);
        } else if (mtime === sinceMs) {
          if (forceIncludeEqualMtime) {
            console.log(`[RSLatte][RecordRSLatte][DEBUG] scanIncrementalFromDiary: Including file ${f.path} (mtime=${mtimeDate} === sinceMs=${sinceDate}, diff=${diff}ms, forceIncludeEqualMtime=true)`);
          } else {
            console.log(`[RSLatte][RecordRSLatte][DEBUG] scanIncrementalFromDiary: Skipping file ${f.path} (mtime=${mtimeDate} === sinceMs=${sinceDate}, diff=${diff}ms, forceIncludeEqualMtime=false)`);
          }
        } else {
          console.log(`[RSLatte][RecordRSLatte][DEBUG] scanIncrementalFromDiary: File modified: ${f.path} (mtime=${mtimeDate} > sinceMs=${sinceDate}, diff=${diff}ms, forceIncludeEqualMtime=${forceIncludeEqualMtime})`);
        }
      }
      
      if (shouldSkip) return;

      const dayKey = this.parseDiaryDateFromFile(f);
      if (!dayKey) return;
      if (dayKey < cutoff) return;

      // ✅ 记录扫描到的文件
      scannedFiles.push({ path: f.path, dayKey, mtime });

      const raw = await this.host.app.vault.read(f);
      maxMtime = Math.max(maxMtime, mtime);

      const parsed = this.parseDiaryForDay(raw, dayKey, mtime || Date.now(), f.path);
      dayKeysScanned.add(dayKey);
      parsedByDay.set(dayKey, {
        checkins: mods.checkin ? parsed.checkins : new Map<string, CheckinRecordIndexItem>(),
        finances: mods.finance ? parsed.finances : new Map<string, FinanceRecordIndexItem>(),
        healths: mods.health ? parsed.healths : new Map<string, HealthRecordIndexItem>(),
      });
      if (mods.checkin) {
        for (const [id, name] of parsed.discoveredCheckins.entries()) discoveredCheckins.set(id, name);
      }
      if (mods.finance) {
        for (const [id, meta] of parsed.discoveredFinanceCats.entries()) discoveredFinanceCats.set(id, meta);
      }
    };

    const scanFolder = async (folder: TFolder) => {
      for (const ch of folder.children) {
        if (ch instanceof TFolder) await scanFolder(ch);
        else if (ch instanceof TFile) await scanFile(ch);
      }
    };

    if (rootAf instanceof TFolder) await scanFolder(rootAf);
    else if (rootAf instanceof TFile) await scanFile(rootAf);

    // ✅ DEBUG: 打印扫描结果摘要
    if (s.debugLogEnabled) {
      console.log(`[RSLatte][RecordRSLatte][DEBUG] scanIncrementalFromDiary: Scan completed:`, {
        scannedFilesCount: scannedFiles.length,
        dayKeysScannedCount: dayKeysScanned.size,
        parsedByDayCount: parsedByDay.size,
        maxMtime: maxMtime > sinceMs ? new Date(maxMtime).toISOString() : 'unchanged',
        sinceMs: new Date(sinceMs).toISOString(),
      });
    }

    // ✅ DEBUG: 打印扫描到的文件清单
    if (s.debugLogEnabled && scannedFiles.length > 0) {
      const sortedFiles = scannedFiles.sort((a, b) => a.dayKey.localeCompare(b.dayKey));
      console.log(`[RSLatte][RecordRSLatte][DEBUG] scanIncrementalFromDiary: Scanned ${scannedFiles.length} files:`, {
        total: scannedFiles.length,
        days: Array.from(dayKeysScanned).sort(),
        files: sortedFiles.map(f => `${f.dayKey} ${f.path} (mtime: ${new Date(f.mtime).toISOString()})`),
      });
    }
    
    // ✅ DEBUG: 如果扫描到了文件但 dayKeysScanned 为空，说明文件被修改但可能没有记录（比如删除）
    if (s.debugLogEnabled && scannedFiles.length > 0 && dayKeysScanned.size === 0) {
      console.log(`[RSLatte][RecordRSLatte][DEBUG] scanIncrementalFromDiary: Files modified but no records found (possible deletions):`, {
        scannedFiles: scannedFiles.map(f => `${f.dayKey} ${f.path} (mtime: ${new Date(f.mtime).toISOString()})`),
      });
    }
    
    // ✅ DEBUG: 如果没有扫描到任何文件
    if (s.debugLogEnabled && scannedFiles.length === 0) {
      console.log(`[RSLatte][RecordRSLatte][DEBUG] scanIncrementalFromDiary: No files modified since last scan (sinceMs=${new Date(sinceMs).toISOString()})`);
    }

    // ✅ 即使 dayKeysScanned 为空，如果扫描到了文件（mtime 更新了），也应该返回结果
    // ✅ 这样 reconcile 可以检测到删除的情况（文件被修改，但扫描不到记录）
    if (dayKeysScanned.size === 0 && scannedFiles.length === 0) return null;
    
    // ✅ 如果扫描到了文件但 dayKeysScanned 为空，返回一个特殊标记，表示文件被修改但可能没有记录
    // ✅ maxMtime 会被更新为扫描到的文件的最大 mtime，用于更新 lastDiaryScanMs
    if (dayKeysScanned.size === 0 && scannedFiles.length > 0) {
      // ✅ 收集所有扫描到的日期（即使没有记录）
      const modifiedDayKeys = new Set<string>();
      for (const f of scannedFiles) {
        modifiedDayKeys.add(f.dayKey);
      }
      
      return {
        kind: 'incremental',
        modules: mods,
        cutoffDate: cutoff,
        sinceMs,
        maxMtime,
        dayKeysScanned: modifiedDayKeys, // ✅ 返回修改过的日期，即使没有记录
        parsedByDay: new Map(), // ✅ 空 Map，表示没有记录
        discoveredCheckins: new Map(),
        discoveredFinanceCats: new Map(),
      };
    }

    return {
      kind: 'incremental',
      modules: mods,
      cutoffDate: cutoff,
      sinceMs,
      maxMtime,
      dayKeysScanned,
      parsedByDay,
      discoveredCheckins,
      discoveredFinanceCats,
    };
  }

  /**
   * ✅ E2-05：原子化 Step B（record 增量应用）：把 scan 结果写入 active/archive 索引，并推进 waterline。
   */
  public async applyIncrementalScan(scan: RecordIncrementalScan, opts?: { updateLists?: boolean }): Promise<RecordApplyResult> {
    await this.ensureReady();
    const updateLists = !!opts?.updateLists;
    const mods = normalizeModules(scan?.modules);

    const daySet = scan?.dayKeysScanned ?? new Set<string>();
    const changedDays = daySet.size;
    if (changedDays === 0) {
      return { cutoffDate: scan?.cutoffDate ?? '', scannedDays: 0, changedDays: 0 };
    }

    // apply
    const activeC = mods.checkin ? ((await this.getCheckinSnapshot(false)).items ?? []) : [];
    const archC = mods.checkin ? ((await this.getCheckinSnapshot(true)).items ?? []) : [];
    const activeF = mods.finance ? ((await this.getFinanceSnapshot(false)).items ?? []) : [];
    const archF = mods.finance ? ((await this.getFinanceSnapshot(true)).items ?? []) : [];
    const activeH = mods.health ? ((await this.getHealthSnapshot(false)).items ?? []) : [];
    const archH = mods.health ? ((await this.getHealthSnapshot(true)).items ?? []) : [];

    const keyC = (rd: string, cid: string) => `${rd}::${cid}`;
    const keyF = (rd: string, fid: string) => `${rd}::${fid}`;
    const keyH = (it: HealthRecordIndexItem) => {
      const rd = String(it.recordDate);
      const eid = normStr(it.entryId);
      if (eid) return `${rd}::${eid}`;
      return `${rd}::m::${normStr(it.metricKey)}`;
    };
    const oldCMap = new Map<string, CheckinRecordIndexItem>();
    const oldFMap = new Map<string, FinanceRecordIndexItem>();
    const oldHMap = new Map<string, HealthRecordIndexItem>();
    if (mods.checkin) {
      for (const it of [...activeC, ...archC]) {
        if (!it?.recordDate) continue;
        if (!daySet.has(String(it.recordDate))) continue;
        oldCMap.set(keyC(String(it.recordDate), String(it.checkinId)), it);
      }
    }
    if (mods.finance) {
      for (const it of [...activeF, ...archF]) {
        if (!it?.recordDate) continue;
        if (!daySet.has(String(it.recordDate))) continue;
        oldFMap.set(keyF(String(it.recordDate), String(it.categoryId)), it);
      }
    }
    if (mods.health) {
      for (const it of [...activeH, ...archH]) {
        if (!it?.recordDate) continue;
        if (!daySet.has(String(it.recordDate))) continue;
        oldHMap.set(keyH(it), it);
      }
    }

    const keepCActive = mods.checkin ? activeC.filter((x) => !daySet.has(x.recordDate)) : [];
    const keepCArch = mods.checkin ? archC.filter((x) => !daySet.has(x.recordDate)) : [];
    const keepFActive = mods.finance ? activeF.filter((x) => !daySet.has(x.recordDate)) : [];
    const keepFArch = mods.finance ? archF.filter((x) => !daySet.has(x.recordDate)) : [];
    const keepHActive = mods.health ? activeH.filter((x) => !daySet.has(x.recordDate)) : [];
    const keepHArch = mods.health ? archH.filter((x) => !daySet.has(x.recordDate)) : [];

    const addC: CheckinRecordIndexItem[] = [];
    const addF: FinanceRecordIndexItem[] = [];
    const addH: HealthRecordIndexItem[] = [];
    for (const parsed of (scan?.parsedByDay ?? new Map()).values()) {
      if (mods.checkin) {
        for (const it of parsed.checkins.values()) {
          const k = keyC(String(it.recordDate), String(it.checkinId));
          const old = oldCMap.get(k);
          (it as any).dbSourceHash = normStr((it as any).dbSourceHash) || computeCheckinSourceHash(it);
          mergeDbSyncMeta(it as any, old as any);
          addC.push(it);
        }
      }
      if (mods.finance) {
        for (const it of parsed.finances.values()) {
          const k = keyF(String(it.recordDate), String(it.categoryId));
          const old = oldFMap.get(k);
          (it as any).dbSourceHash = normStr((it as any).dbSourceHash) || computeFinanceSourceHash(it);
          mergeDbSyncMeta(it as any, old as any);
          addF.push(it);
        }
      }
      if (mods.health) {
        for (const it of parsed.healths.values()) {
          const k = keyH(it);
          const old = oldHMap.get(k);
          (it as any).dbSourceHash = normStr((it as any).dbSourceHash) || computeHealthSourceHash(it);
          mergeDbSyncMeta(it as any, old as any);
          addH.push(it);
        }
      }
    }

    if (mods.checkin) {
      const outCActive = [...keepCActive, ...addC].sort((a, b) =>
        a.recordDate === b.recordDate ? (a.tsMs ?? 0) - (b.tsMs ?? 0) : a.recordDate.localeCompare(b.recordDate)
      );
      this.checkinSnap = { version: 1, updatedAt: nowIso(), items: outCActive };
      // archive 仅删除被覆盖日期（保持一致性）
      this.checkinArchiveSnap = { version: 1, updatedAt: nowIso(), items: keepCArch };
      await this.store!.writeCheckinIndex(false, this.checkinSnap);
      await this.store!.writeCheckinIndex(true, this.checkinArchiveSnap);
      
      // ✅ 同步更新打卡统计缓存
      await this.syncCheckinStatsCache();
    }

    if (mods.finance) {
      const outFActive = [...keepFActive, ...addF].sort((a, b) =>
        a.recordDate === b.recordDate ? (a.tsMs ?? 0) - (b.tsMs ?? 0) : a.recordDate.localeCompare(b.recordDate)
      );
      this.financeSnap = { version: 1, updatedAt: nowIso(), items: outFActive };
      this.financeArchiveSnap = { version: 1, updatedAt: nowIso(), items: keepFArch };
      await this.store!.writeFinanceIndex(false, this.financeSnap);
      await this.store!.writeFinanceIndex(true, this.financeArchiveSnap);
      // ✅ 同步更新财务统计缓存
      await this.syncFinanceStatsCache();
    }

    if (mods.health) {
      const outHActive = [...keepHActive, ...addH].sort((a, b) =>
        a.recordDate === b.recordDate ? (a.tsMs ?? 0) - (b.tsMs ?? 0) : a.recordDate.localeCompare(b.recordDate)
      );
      this.healthSnap = { version: 1, updatedAt: nowIso(), items: outHActive };
      this.healthArchiveSnap = { version: 1, updatedAt: nowIso(), items: keepHArch };
      await this.store!.writeHealthIndex(false, this.healthSnap);
      await this.store!.writeHealthIndex(true, this.healthArchiveSnap);
    }

    if (updateLists) {
      await this.addMissingListsFromDiary({
        checkins: mods.checkin ? (scan?.discoveredCheckins ?? new Map()) : new Map<string, string>(),
        financeCats: mods.finance ? (scan?.discoveredFinanceCats ?? new Map()) : new Map<string, { name?: string; type: 'income' | 'expense' }>(),
      });
    }

    // update waterline
    if (Number(scan?.maxMtime ?? 0) > Number(scan?.sinceMs ?? 0)) {
      this.setLastDiaryScanMs(Number(scan?.maxMtime ?? 0));
      await this.host.saveSettings();
    }

    return { cutoffDate: scan?.cutoffDate ?? '', scannedDays: changedDays, changedDays };
  }

  /**
   * ✅ E2-05：原子化 Step A（record 全量扫描）：扫描日记树，必要时补充“缺失日记天”用于清理。
   * - **scanAllDiaryDates**（Pipeline `rebuild` / 显式全量重建）：不按归档阈值跳过旧日期的日记文件，读遍 `diaryPath` 下可解析日期的 `.md`（含 `YYYYMM/`），再由 **`archiveOutOfRange`** 做索引归档瘦身。
   * - 默认（未开）：仍用 **归档阈值** 推导 **scanCutoffKey**，早于该日期的文件整份跳过（与增量/刷新性能一致）。
   * - 不写入索引、不改水位，只返回扫描结果；返回的 **cutoffDate** 仍为归档阈值日（供 `applyFullReplace` 等语义），不因 scanAll 而改变。
   */
  public async scanFullFromDiaryRange(opts?: {
    reconcileMissingDays?: boolean;
    modules?: RecordModules;
    /** true：重建索引时扫全库日记日期，再依赖 archiveNow 迁出旧条目 */
    scanAllDiaryDates?: boolean;
  }): Promise<RecordFullScan> {
    await this.ensureReady();
    const mods = normalizeModules(opts?.modules);
    const reconcileMissingDays = !!opts?.reconcileMissingDays;
    const scanAllDiaryDates = opts?.scanAllDiaryDates === true;

    const s = this.settings;
    // 获取当前空间ID，然后从空间的 settingsSnapshot 中获取 diaryPath
    const currentSpaceId = (s as any).currentSpaceId || "";
    const spaces = (s as any).spaces || {};
    const currentSpace = spaces[currentSpaceId];
    const spaceDiaryPath = currentSpace?.settingsSnapshot?.diaryPath;
    // 优先使用空间的 diaryPath，否则使用全局的 diaryPath
    const diaryRoot = normalizePath(String(spaceDiaryPath ?? s.diaryPath ?? '').trim());
    
    if (s.debugLogEnabled) {
      console.log(`[RSLatte][RecordRSLatte][DEBUG] scanFullFromDiaryRange: currentSpaceId=${currentSpaceId}, spaceDiaryPath=${spaceDiaryPath || '(empty)'}, globalDiaryPath=${s.diaryPath || '(empty)'}, finalDiaryRoot=${diaryRoot || '(empty)'}`);
    }
    
    const todayKey = this.host.getTodayKey();
    const thresholdCutoff = this.getScanCutoffDateKeyForModules(todayKey, mods);
    /** 单文件是否跳过：全量重建时不按日龄跳过 */
    const scanCutoffKey = scanAllDiaryDates ? "0000-01-01" : thresholdCutoff;

    const dayKeysScanned = new Set<string>();
    const discoveredCheckins = new Map<string, string>();
    const discoveredFinanceCats = new Map<string, { name?: string; type: 'income' | 'expense' }>();
    const parsedByDay = new Map<string, RecordDayParsedMaps>();
    let maxMtime = 0;
    
    // ✅ 收集扫描到的文件清单（用于 DEBUG 日志）
    const scannedFiles: Array<{ path: string; dayKey: string; mtime: number; checkinCount: number; financeCount: number }> = [];

    const rootAf = diaryRoot ? this.host.app.vault.getAbstractFileByPath(diaryRoot) : null;

    const scanFile = async (f: TFile) => {
      if (f.extension.toLowerCase() !== 'md') return;
      const dayKey = this.parseDiaryDateFromFile(f);
      if (!dayKey) return;
      if (dayKey < scanCutoffKey) return;
      
      const raw = await this.host.app.vault.read(f);
      const mtime = Number(f.stat?.mtime ?? 0);
      if (Number.isFinite(mtime)) maxMtime = Math.max(maxMtime, mtime);

      const parsed = this.parseDiaryForDay(raw, dayKey, mtime || Date.now(), f.path);
      const checkinCount = parsed.checkins.size;
      const financeCount = parsed.finances.size;
      
      // ✅ 记录扫描到的文件
      scannedFiles.push({ path: f.path, dayKey, mtime, checkinCount, financeCount });
      
      if (s.debugLogEnabled && (checkinCount > 0 || financeCount > 0)) {
        console.log(`[RSLatte][RecordRSLatte][DEBUG] Scanning diary file: ${f.path}, dayKey=${dayKey}, spaceId=${currentSpaceId}, checkins=${checkinCount}, finances=${financeCount}`);
      }
      
      dayKeysScanned.add(dayKey);
      parsedByDay.set(dayKey, {
        checkins: mods.checkin ? parsed.checkins : new Map<string, CheckinRecordIndexItem>(),
        finances: mods.finance ? parsed.finances : new Map<string, FinanceRecordIndexItem>(),
        healths: mods.health ? parsed.healths : new Map<string, HealthRecordIndexItem>(),
      });
      if (mods.checkin) {
        for (const [id, name] of parsed.discoveredCheckins.entries()) discoveredCheckins.set(id, name);
      }
      if (mods.finance) {
        for (const [id, meta] of parsed.discoveredFinanceCats.entries()) discoveredFinanceCats.set(id, meta);
      }
    };

    const scanFolder = async (folder: TFolder) => {
      for (const ch of folder.children) {
        if (ch instanceof TFolder) await scanFolder(ch);
        else if (ch instanceof TFile) await scanFile(ch);
      }
    };

    if (rootAf instanceof TFolder) await scanFolder(rootAf);
    else if (rootAf instanceof TFile) await scanFile(rootAf);

    // ✅ DEBUG: 打印扫描到的文件清单
    if (s.debugLogEnabled && scannedFiles.length > 0) {
      const sortedFiles = scannedFiles.sort((a, b) => a.dayKey.localeCompare(b.dayKey));
      const totalCheckins = scannedFiles.reduce((sum, f) => sum + f.checkinCount, 0);
      const totalFinances = scannedFiles.reduce((sum, f) => sum + f.financeCount, 0);
      console.log(`[RSLatte][RecordRSLatte][DEBUG] scanFullFromDiaryRange: Scanned ${scannedFiles.length} files:`, {
        total: scannedFiles.length,
        days: Array.from(dayKeysScanned).sort(),
        totalCheckins,
        totalFinances,
        files: sortedFiles.map(f => `${f.dayKey} ${f.path} (mtime: ${new Date(f.mtime).toISOString()}, checkins: ${f.checkinCount}, finances: ${f.financeCount})`),
      });
    }

    const scannedDays = dayKeysScanned.size;

    // reconcileMissingDays: 若阈值范围内“索引里曾存在某天的数据，但本次扫描未发现该天日记文件”，则在 replace 阶段清理该天
    let clearedDays = 0;
    let dayKeysToReplace = new Set<string>(Array.from(dayKeysScanned.values()));
    
    // 如果目录为空或不存在，且没有扫描到任何文件，清空所有该空间的索引数据
    // 这确保当空间的日记路径指向空目录时，索引也被清空
    const isEmptyDirectory = rootAf instanceof TFolder && dayKeysScanned.size === 0;
    const isMissingDirectory = !rootAf;
    
    if ((isEmptyDirectory || isMissingDirectory) && !reconcileMissingDays) {
      if (s.debugLogEnabled) {
        console.log(`[RSLatte][RecordRSLatte][DEBUG] Diary directory is empty or missing, will clear all index data for space ${currentSpaceId}`);
      }
      // 需要清空所有数据：获取所有现有记录的日期，加入到 dayKeysToReplace 中以清空它们
      const activeC = mods.checkin ? ((await this.getCheckinSnapshot(false)).items ?? []) : [];
      const archC = mods.checkin ? ((await this.getCheckinSnapshot(true)).items ?? []) : [];
      const activeF = mods.finance ? ((await this.getFinanceSnapshot(false)).items ?? []) : [];
      const archF = mods.finance ? ((await this.getFinanceSnapshot(true)).items ?? []) : [];
      const activeH = mods.health ? ((await this.getHealthSnapshot(false)).items ?? []) : [];
      const archH = mods.health ? ((await this.getHealthSnapshot(true)).items ?? []) : [];
      
      const existingDays = new Set<string>();
      const addDay = (d: any) => {
        const dk = String(d ?? '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) return;
        if (dk < scanCutoffKey) return;
        existingDays.add(dk);
      };
      if (mods.checkin) for (const it of [...activeC, ...archC]) addDay((it as any)?.recordDate);
      if (mods.finance) for (const it of [...activeF, ...archF]) addDay((it as any)?.recordDate);
      if (mods.health) for (const it of [...activeH, ...archH]) addDay((it as any)?.recordDate);
      
      // 将所有现有日期加入到 dayKeysToReplace，这样会被清空
      for (const d of existingDays.values()) {
        dayKeysToReplace.add(d);
        clearedDays++;
      }
      
      if (s.debugLogEnabled) {
        console.log(`[RSLatte][RecordRSLatte][DEBUG] Will clear ${existingDays.size} days of index data`);
      }
    }

    if (reconcileMissingDays && rootAf instanceof TFolder) {
      const activeC = mods.checkin ? ((await this.getCheckinSnapshot(false)).items ?? []) : [];
      const archC = mods.checkin ? ((await this.getCheckinSnapshot(true)).items ?? []) : [];
      const activeF = mods.finance ? ((await this.getFinanceSnapshot(false)).items ?? []) : [];
      const archF = mods.finance ? ((await this.getFinanceSnapshot(true)).items ?? []) : [];
      const activeH = mods.health ? ((await this.getHealthSnapshot(false)).items ?? []) : [];
      const archH = mods.health ? ((await this.getHealthSnapshot(true)).items ?? []) : [];

      const existingDays = new Set<string>();
      const addDay = (d: any) => {
        const dk = String(d ?? '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) return;
        if (dk < scanCutoffKey) return;
        existingDays.add(dk);
      };
      if (mods.checkin) for (const it of [...activeC, ...archC]) addDay((it as any)?.recordDate);
      if (mods.finance) for (const it of [...activeF, ...archF]) addDay((it as any)?.recordDate);
      if (mods.health) for (const it of [...activeH, ...archH]) addDay((it as any)?.recordDate);

      for (const d of existingDays.values()) {
        if (!dayKeysToReplace.has(d)) {
          dayKeysToReplace.add(d);
          clearedDays++;
        }
      }
    }

    return {
      kind: 'full',
      modules: mods,
      cutoffDate: thresholdCutoff,
      scannedDays,
      clearedDays,
      maxMtime,
      dayKeysScanned,
      dayKeysToReplace,
      parsedByDay,
      discoveredCheckins,
      discoveredFinanceCats,
    };
  }

  /**
   * ✅ E2-05：原子化 Step B（record replaceAll）：把 scanFull 的结果写入索引，并推进 waterline。
   */
  public async applyFullReplace(scan: RecordFullScan, opts?: { updateLists?: boolean }): Promise<RecordApplyResult> {
    await this.ensureReady();
    const updateLists = !!opts?.updateLists;
    const mods = normalizeModules(scan?.modules);

    let daySet = scan?.dayKeysToReplace ?? new Set<string>();
    
    // 如果扫描结果为空的 dayKeysToReplace（可能是空目录导致的），清空所有索引数据
    // 注意：这里我们只清空 cutoff 范围内的数据，避免影响归档数据
    if (daySet.size === 0 && scan?.scannedDays === 0 && scan?.cutoffDate) {
      const s = this.host.settingsRef();
      if (s.debugLogEnabled) {
        console.log(`[RSLatte][RecordRSLatte][DEBUG] Clearing all index data after cutoff date ${scan.cutoffDate}`);
      }
      // 获取所有现有记录的日期，加入到 daySet 中以清空它们
      const activeC = mods.checkin ? ((await this.getCheckinSnapshot(false)).items ?? []) : [];
      const activeF = mods.finance ? ((await this.getFinanceSnapshot(false)).items ?? []) : [];
      const activeH = mods.health ? ((await this.getHealthSnapshot(false)).items ?? []) : [];
      for (const it of activeC) {
        const d = String(it?.recordDate ?? "");
        if (d && d >= scan.cutoffDate) daySet.add(d);
      }
      for (const it of activeF) {
        const d = String(it?.recordDate ?? "");
        if (d && d >= scan.cutoffDate) daySet.add(d);
      }
      for (const it of activeH) {
        const d = String(it?.recordDate ?? "");
        if (d && d >= scan.cutoffDate) daySet.add(d);
      }
    }

    // apply to index: remove all records for daySet, then re-add
    const activeC = mods.checkin ? ((await this.getCheckinSnapshot(false)).items ?? []) : [];
    const archC = mods.checkin ? ((await this.getCheckinSnapshot(true)).items ?? []) : [];
    const activeF = mods.finance ? ((await this.getFinanceSnapshot(false)).items ?? []) : [];
    const archF = mods.finance ? ((await this.getFinanceSnapshot(true)).items ?? []) : [];
    const activeH = mods.health ? ((await this.getHealthSnapshot(false)).items ?? []) : [];
    const archH = mods.health ? ((await this.getHealthSnapshot(true)).items ?? []) : [];

    const keyC = (rd: string, cid: string) => `${rd}::${cid}`;
    const keyF = (rd: string, fid: string) => `${rd}::${fid}`;
    const keyHfull = (it: HealthRecordIndexItem) => {
      const rd = String(it.recordDate);
      const eid = normStr(it.entryId);
      if (eid) return `${rd}::${eid}`;
      return `${rd}::m::${normStr(it.metricKey)}`;
    };
    const oldCMap = new Map<string, CheckinRecordIndexItem>();
    const oldFMap = new Map<string, FinanceRecordIndexItem>();
    const oldHMap = new Map<string, HealthRecordIndexItem>();

    if (mods.checkin) {
      for (const it of [...activeC, ...archC]) {
        if (!it?.recordDate) continue;
        if (!daySet.has(String(it.recordDate))) continue;
        oldCMap.set(keyC(String(it.recordDate), String(it.checkinId)), it);
      }
    }
    if (mods.finance) {
      for (const it of [...activeF, ...archF]) {
        if (!it?.recordDate) continue;
        if (!daySet.has(String(it.recordDate))) continue;
        oldFMap.set(keyF(String(it.recordDate), String(it.categoryId)), it);
      }
    }
    if (mods.health) {
      for (const it of [...activeH, ...archH]) {
        if (!it?.recordDate) continue;
        if (!daySet.has(String(it.recordDate))) continue;
        oldHMap.set(keyHfull(it), it);
      }
    }

    const keepCActive = mods.checkin ? activeC.filter((x) => !daySet.has(x.recordDate)) : [];
    const keepCArch = mods.checkin ? archC.filter((x) => !daySet.has(x.recordDate)) : [];
    const keepFActive = mods.finance ? activeF.filter((x) => !daySet.has(x.recordDate)) : [];
    const keepFArch = mods.finance ? archF.filter((x) => !daySet.has(x.recordDate)) : [];
    const keepHActive = mods.health ? activeH.filter((x) => !daySet.has(x.recordDate)) : [];
    const keepHArch = mods.health ? archH.filter((x) => !daySet.has(x.recordDate)) : [];

    const addC: CheckinRecordIndexItem[] = [];
    const addF: FinanceRecordIndexItem[] = [];
    const addH: HealthRecordIndexItem[] = [];

    for (const [dayKey, parsed] of (scan?.parsedByDay ?? new Map()).entries()) {
      if (mods.checkin) {
        for (const it of parsed.checkins.values()) {
          const old = oldCMap.get(keyC(dayKey, String(it.checkinId)));
          (it as any).dbSourceHash = normStr((it as any).dbSourceHash) || computeCheckinSourceHash(it);
          mergeDbSyncMeta(it as any, old as any);
          addC.push(it);
        }
      }
      if (mods.finance) {
        for (const it of parsed.finances.values()) {
          const old = oldFMap.get(keyF(dayKey, String(it.categoryId)));
          (it as any).dbSourceHash = normStr((it as any).dbSourceHash) || computeFinanceSourceHash(it);
          mergeDbSyncMeta(it as any, old as any);
          addF.push(it);
        }
      }
      if (mods.health) {
        for (const it of parsed.healths.values()) {
          const old = oldHMap.get(keyHfull(it));
          (it as any).dbSourceHash = normStr((it as any).dbSourceHash) || computeHealthSourceHash(it);
          mergeDbSyncMeta(it as any, old as any);
          addH.push(it);
        }
      }
    }

    if (mods.checkin) {
      const outCActive = [...keepCActive, ...addC].sort((a, b) =>
        a.recordDate === b.recordDate ? (a.tsMs ?? 0) - (b.tsMs ?? 0) : a.recordDate.localeCompare(b.recordDate)
      );
      const outCArch = keepCArch.sort((a, b) =>
        a.recordDate === b.recordDate ? (a.tsMs ?? 0) - (b.tsMs ?? 0) : a.recordDate.localeCompare(b.recordDate)
      );
      this.checkinSnap = { version: 1, updatedAt: nowIso(), items: outCActive };
      this.checkinArchiveSnap = { version: 1, updatedAt: nowIso(), items: outCArch };
      await this.store!.writeCheckinIndex(false, this.checkinSnap);
      await this.store!.writeCheckinIndex(true, this.checkinArchiveSnap);
      
      // ✅ 同步更新打卡统计缓存
      await this.syncCheckinStatsCache();
    }

    if (mods.finance) {
      const outFActive = [...keepFActive, ...addF].sort((a, b) =>
        a.recordDate === b.recordDate ? (a.tsMs ?? 0) - (b.tsMs ?? 0) : a.recordDate.localeCompare(b.recordDate)
      );
      const outFArch = keepFArch.sort((a, b) =>
        a.recordDate === b.recordDate ? (a.tsMs ?? 0) - (b.tsMs ?? 0) : a.recordDate.localeCompare(b.recordDate)
      );
      this.financeSnap = { version: 1, updatedAt: nowIso(), items: outFActive };
      this.financeArchiveSnap = { version: 1, updatedAt: nowIso(), items: outFArch };
      await this.store!.writeFinanceIndex(false, this.financeSnap);
      await this.store!.writeFinanceIndex(true, this.financeArchiveSnap);
      // ✅ 同步更新财务统计缓存
      await this.syncFinanceStatsCache();

      await this.reconcileFinanceCyclePlanReferencesAfterFullRebuild([...outFActive, ...outFArch]);
      await this.writeFinanceManagementSettingsSnapshotBestEffort();
    }

    if (mods.health) {
      const outHActive = [...keepHActive, ...addH].sort((a, b) =>
        a.recordDate === b.recordDate ? (a.tsMs ?? 0) - (b.tsMs ?? 0) : a.recordDate.localeCompare(b.recordDate)
      );
      const outHArch = keepHArch.sort((a, b) =>
        a.recordDate === b.recordDate ? (a.tsMs ?? 0) - (b.tsMs ?? 0) : a.recordDate.localeCompare(b.recordDate)
      );
      this.healthSnap = { version: 1, updatedAt: nowIso(), items: outHActive };
      this.healthArchiveSnap = { version: 1, updatedAt: nowIso(), items: outHArch };
      await this.store!.writeHealthIndex(false, this.healthSnap);
      await this.store!.writeHealthIndex(true, this.healthArchiveSnap);
    }

    if (updateLists) {
      await this.addMissingListsFromDiary({
        checkins: mods.checkin ? (scan?.discoveredCheckins ?? new Map()) : new Map<string, string>(),
        financeCats: mods.finance ? (scan?.discoveredFinanceCats ?? new Map()) : new Map<string, { name?: string; type: 'income' | 'expense' }>(),
      });
      
      // ✅ 财务模块重建索引时，从记录中提取子分类并补全到财务分类清单中
      // 从扫描结果中收集所有财务记录（包括所有扫描到的记录）
      if (mods.finance) {
        const allScannedFinanceRecords: FinanceRecordIndexItem[] = [];
        // 从 parsedByDay 中收集所有扫描到的财务记录
        for (const [_dayKey, parsed] of (scan?.parsedByDay ?? new Map()).entries()) {
          for (const record of parsed.finances.values()) {
            allScannedFinanceRecords.push(record);
          }
        }
        // 也包含保留的活跃记录（这些记录可能不在本次扫描范围内，但包含历史子分类信息）
        allScannedFinanceRecords.push(...keepFActive);
        
        if (allScannedFinanceRecords.length > 0) {
          await this.enrichFinanceCategoriesWithSubcategories(allScannedFinanceRecords);
        }
      }
    }

    // rebuild 也推进增量水位，避免随后 incremental 重扫
    if (Number(scan?.maxMtime ?? 0) > 0) {
      this.setLastDiaryScanMs(Math.max(this.getLastDiaryScanMs(), Number(scan?.maxMtime ?? 0)));
      await this.host.saveSettings();
    }

    return {
      cutoffDate: scan?.cutoffDate ?? '',
      scannedDays: Number(scan?.scannedDays ?? 0),
      clearedDays: Number(scan?.clearedDays ?? 0),
      changedDays: daySet.size,
    };
  }


  /**
   * ✅ Step2（与任务管理一致）：手动刷新 = reconcile（阈值范围内全量扫描重建）。
   * - updateLists=true：扫描过程中发现的新清单（打卡项/财务分类）会写入 lists index，并合并回 settings（默认 active=false）。
   * - reconcileMissingDays=true（默认）：若阈值范围内某天曾存在索引记录，但本次全量扫描未再发现该日日记文件，则在 replace 阶段移除该日索引项（含已删文件场景）。
   * - scanAllDiaryDates=true：读遍日记树下全部可解析日期（含 `YYYYMM/`），再依赖 Pipeline **archiveOutOfRange** 做索引归档；与 Pipeline **`rebuild`** 对齐。
   */
  public async rebuildIndexFromDiaryRange(
    updateLists: boolean = true,
    reconcileMissingDays: boolean = true,
    modules?: RecordModules,
    scanAllDiaryDates?: boolean
  ): Promise<{ cutoffDate: string; scannedDays: number; clearedDays: number; dayKeysScanned?: Set<string>; dayKeysToReplace?: Set<string> }> {
    await this.ensureReady();
    const scan = await this.scanFullFromDiaryRange({
      reconcileMissingDays,
      modules,
      scanAllDiaryDates: scanAllDiaryDates === true,
    });
    const applied = await this.applyFullReplace(scan, { updateLists });
    return {
      cutoffDate: applied.cutoffDate,
      scannedDays: Number(applied.scannedDays ?? 0),
      clearedDays: Number(applied.clearedDays ?? 0),
      dayKeysScanned: scan?.dayKeysScanned, // ✅ 返回扫描到的日期集合，供 reconcile 使用
      dayKeysToReplace: scan?.dayKeysToReplace, // ✅ 返回需要替换的日期集合，供 reconcile 使用
    };
  }


  /**
   * 扫描当前空间日记目录下**全部**符合日记文件名格式的 `.md`：
   * - legacy：财务主行后无合法 `rslatte:finance:meta`（或 JSON 无效 / 缺 entry_id / 缺子分类）
   * - duplicate：同一文件内同一 `entry_id` 出现多组主行+meta
   * - duplicateCrossFiles：同一 `entry_id` 出现在**至少两个不同文件**中（复制日记未换新 id）
   * 不修改索引与文件；供「异常记录清单」UI 使用。
   */
  public async scanFinanceAnomalies(): Promise<FinanceAnomalyScanResult> {
    await this.ensureReady();
    const legacy: FinanceAnomalyLegacyItem[] = [];
    const duplicates: FinanceAnomalyDuplicateItem[] = [];
    const cycleIdMissing: FinanceAnomalyCycleIdMissingItem[] = [];

    const s = this.settings;
    const currentSpaceId = String((s as any).currentSpaceId ?? "");
    const spaces = (s as any).spaces || {};
    const currentSpace = spaces[currentSpaceId];
    const spaceDiaryPath = currentSpace?.settingsSnapshot?.diaryPath;
    const diaryRoot = normalizePath(String(spaceDiaryPath ?? s.diaryPath ?? "").trim());

    const finLineRe = FINANCE_DIARY_MAIN_LINE_RE;

    /** 跨文件统计：每个 entry_id 在哪些文件、哪一行出现 */
    const globalByEntryId = new Map<
      string,
      Array<{ filePath: string; dayKey: string; lineNumber: number; preview: string }>
    >();

    let scannedFileCount = 0;

    const scanOneFile = async (f: TFile) => {
      if (f.extension.toLowerCase() !== "md") return;
      const dayKey = this.parseDiaryDateFromFile(f);
      if (!dayKey) return;
      scannedFileCount++;
      const raw = await this.host.app.vault.read(f);
      const lines = raw.split(/\r?\n/);
      const byEntry = new Map<string, number[]>();

      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i] ?? "";
        if (!finLineRe.test(ln)) continue;
        const mc = ln.match(finLineRe);
        const catId = mc ? String(mc[5] ?? "").trim() : undefined;
        const peek = peekFinanceMetaAfterMain(lines, i);
        if (!peek) {
          legacy.push({
            kind: "legacy_no_meta",
            filePath: f.path,
            dayKey,
            lineNumber: i + 1,
            preview: ln.trim().slice(0, 200),
            categoryId: catId || undefined,
          });
          continue;
        }
        const eid = String(peek.meta.entry_id ?? "").trim();
        if (!eid) continue;

        const ctScan = normalizeFinanceCycleType(String(peek.meta.cycle_type ?? "none"));
        if (ctScan !== "none" && !normStr(peek.meta.cycle_id)) {
          cycleIdMissing.push({
            kind: "cycle_id_missing",
            filePath: f.path,
            dayKey,
            lineNumber: i + 1,
            preview: ln.trim().slice(0, 200),
            entryId: eid,
            categoryId: catId || undefined,
            subcategory: peek.meta.subcategory,
            institutionName: peek.meta.institution_name,
            cycleType: ctScan,
          });
        }

        const arr = byEntry.get(eid) ?? [];
        arr.push(i + 1);
        byEntry.set(eid, arr);

        const pv = ln.trim().slice(0, 140);
        const g = globalByEntryId.get(eid) ?? [];
        g.push({ filePath: f.path, dayKey, lineNumber: i + 1, preview: pv });
        globalByEntryId.set(eid, g);
      }

      for (const [entryId, lineNums] of byEntry.entries()) {
        if (lineNums.length <= 1) continue;
        duplicates.push({
          kind: "duplicate_entry_id",
          filePath: f.path,
          dayKey,
          entryId,
          mainLineNumbers: [...lineNums],
          previews: lineNums.map((ln) => String(lines[ln - 1] ?? "").trim().slice(0, 140)),
        });
      }
    };

    const rootAf = diaryRoot ? this.host.app.vault.getAbstractFileByPath(diaryRoot) : null;
    const walk = async (folder: TFolder) => {
      for (const ch of folder.children) {
        if (ch instanceof TFolder) await walk(ch);
        else if (ch instanceof TFile) await scanOneFile(ch);
      }
    };
    if (rootAf instanceof TFolder) await walk(rootAf);
    else if (rootAf instanceof TFile) await scanOneFile(rootAf);

    const duplicateCrossFiles: FinanceAnomalyDuplicateCrossFileItem[] = [];
    for (const [entryId, occ] of globalByEntryId.entries()) {
      const distinctFiles = new Set(occ.map((o) => o.filePath));
      if (distinctFiles.size < 2) continue;
      const sorted = [...occ].sort(
        (a, b) => a.filePath.localeCompare(b.filePath) || a.lineNumber - b.lineNumber
      );
      duplicateCrossFiles.push({
        kind: "duplicate_entry_id_cross_file",
        entryId,
        occurrences: sorted,
      });
    }
    duplicateCrossFiles.sort((a, b) => a.entryId.localeCompare(b.entryId));

    return { legacy, duplicates, duplicateCrossFiles, cycleIdMissing, scannedFileCount };
  }

  /**
   * 全量重建财务索引后：根据索引中的 cycleId 刷新周期表 referenced（仅此处重算 true/false）。
   */
  private async reconcileFinanceCyclePlanReferencesAfterFullRebuild(allItems: FinanceRecordIndexItem[]): Promise<void> {
    try {
      const used = new Set<string>();
      for (const it of allItems) {
        const ct = normalizeFinanceCycleType((it as any).cycleType ?? "none");
        if (ct === "none") continue;
        const cid = normStr((it as any).cycleId);
        if (!cid || cid === "none") continue;
        used.add(cid);
      }
      const s = this.host.settingsRef();
      const plans = s.financeCyclePlans ?? [];
      let touched = false;
      for (const p of plans) {
        if (String((p as any)?.deletedAt ?? "").trim()) continue;
        const nextRef = used.has(String((p as any).id));
        if ((p as any).referenced !== nextRef) {
          (p as any).referenced = nextRef;
          touched = true;
        }
      }
      if (touched) await this.host.saveSettings();
    } catch (e) {
      console.warn("[RSLatte] reconcileFinanceCyclePlanReferencesAfterFullRebuild failed", e);
    }
  }

  private async writeFinanceManagementSettingsSnapshotBestEffort(): Promise<void> {
    try {
      await this.ensureReady();
      const s = this.host.settingsRef();
      await this.store!.writeFinanceManagementSettingsSnapshot({
        schemaVersion: 1,
        financeManagementCurrency: s.financeManagementCurrency ?? "CNY",
        financeCyclePlans: s.financeCyclePlans ?? [],
        financeInstitutionSimilarIgnore: s.financeInstitutionSimilarIgnore ?? [],
        financeCategories: s.financeCategories ?? [],
      });
    } catch (e) {
      console.warn("[RSLatte] writeFinanceManagementSettingsSnapshotBestEffort failed", e);
    }
  }

  /** ✅ Step1：增量扫描（mtime>waterline），仅更新变更日记对应的当日索引 */
  public async refreshIndexIncrementalFromDiary(opts?: { updateLists?: boolean; modules?: RecordModules }): Promise<void> {
    await this.ensureReady();
    const updateLists = !!opts?.updateLists;
    const scan = await this.scanIncrementalFromDiary({ modules: opts?.modules });
    if (!scan) return;
    await this.applyIncrementalScan(scan, { updateLists });
  }

}
