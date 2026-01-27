import { TFile, normalizePath, moment } from "obsidian";
// ✅ moment 从 Obsidian 导入，但 TypeScript 类型定义可能不完整，使用类型断言
const momentFn = moment as any;
import type RSLattePlugin from "../main";
import type { RSLatteModuleKey } from "./pipeline/types";
import type { RSLatteReconcileGate, RSLatteModuleStats } from "./pipeline/moduleSpec";
import type { SpaceCtx } from "../types/space";
import { resolveSpaceIndexDir, resolveSpaceQueueDir, resolveSpaceStatsDir } from "./spaceContext";
import { RSLATTE_EVENT_SPACE_STATS_UPDATED } from "../constants/space";
import {
  RSLatteModuleStatsFileV1,
  RSLatteSpaceStatsFileV1,
  RSLatteSpaceStatsModuleEntryV1,
  RSLatteSpaceStatsSyncStatus,
  RSLatteModuleKpiByModule,
} from "../types/spaceStats";
import type { RSLatteIndexFile, RSLatteIndexItem } from "../taskRSLatte/types";
import type { CheckinRecordIndexFile, FinanceRecordIndexFile, RSLatteListsIndexFile, CheckinItemIndexItem } from "../types/recordIndexTypes";
import { nextSolarDateForLunarBirthday } from "../utils/lunar";
import { ProjectIndexStore } from "../projectRSLatte/indexStore";
import { OutputIndexStore } from "../outputRSLatte/indexStore";
import { ContactsIndexStore } from "../contactsRSLatte/indexStore";
import { fnv1a32 } from "../utils/hash";
import { StatusCalculationService } from "./statusCalculationService";

function isoNow(): string {
  return new Date().toISOString();
}

function todayYmd(): string {
  return momentFn().format("YYYY-MM-DD");
}

function ymdAdd(ymd: string, days: number): string {
  return momentFn(ymd, "YYYY-MM-DD").add(days, "day").format("YYYY-MM-DD");
}

function ymdBetween(x: string, a: string, b: string): boolean {
  return x >= a && x <= b;
}

async function ensureFolder(app: any, path: string): Promise<void> {
  const p = normalizePath(path);
  if (!p) return;
  try {
    const ok = await app.vault.adapter.exists(p);
    if (ok) return;
  } catch {
    // ignore
  }

  const parts = p.split("/").filter(Boolean);
  let cur = "";
  for (const seg of parts) {
    cur = cur ? `${cur}/${seg}` : seg;
    try {
      const ok = await app.vault.adapter.exists(cur);
      if (!ok) await app.vault.createFolder(cur);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes("Folder already exists") || msg.includes("EEXIST")) continue;
      // keep going best-effort
    }
  }
}

async function writeJson(app: any, path: string, obj: any): Promise<void> {
  const p = normalizePath(path);
  await ensureFolder(app, p.split("/").slice(0, -1).join("/"));
  const text = JSON.stringify(obj, null, 2);
  const ok = await app.vault.adapter.exists(p);
  if (ok) {
    await app.vault.adapter.write(p, text);
    return;
  }
  await app.vault.create(p, text);
}

async function readJson<T>(app: any, path: string, fallback: T): Promise<T> {
  const p = normalizePath(path);
  try {
    const ok = await app.vault.adapter.exists(p);
    if (!ok) return fallback;
    const raw = await app.vault.adapter.read(p);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// 已迁移到 StatusCalculationService.calculateSyncStatus
// 所有状态计算逻辑已统一到 StatusCalculationService

export class SpaceStatsService {
  constructor(private plugin: RSLattePlugin) {}

  private getStatsDir(ctx: SpaceCtx): string {
    return resolveSpaceStatsDir((this.plugin as any).settings, ctx.spaceId);
  }

  /** 检查模块是否启用（按空间区分） */
  private isModuleEnabled(moduleKey: RSLatteModuleKey, ctx: SpaceCtx): boolean {
    // 优先从空间的 settingsSnapshot 中读取
    if (ctx.space?.settingsSnapshot) {
      const spaceSettings = ctx.space.settingsSnapshot as any;
      
      // 检查空间的 moduleEnabledV2
      const v2 = spaceSettings?.moduleEnabledV2;
      if (v2 && typeof v2[moduleKey] === "boolean") {
        return v2[moduleKey];
      }
      
      // 对于特殊模块，检查对应的字段
      if (moduleKey === "finance" && v2 && typeof v2.finance === "boolean") {
        return v2.finance;
      }
      if (moduleKey === "checkin" && v2 && typeof v2.checkin === "boolean") {
        return v2.checkin;
      }
      if (moduleKey === "contacts" && v2 && typeof v2.contacts === "boolean") {
        return v2.contacts;
      }
      
      // 检查空间的 moduleEnabled（旧版本）
      const old = spaceSettings?.moduleEnabled;
      if (old) {
        const oldKeyMap: Record<string, string> = {
          task: "task",
          memo: "task",
          checkin: "record",
          finance: "record",
          project: "project",
          output: "output",
        };
        const oldKey = oldKeyMap[moduleKey] || moduleKey;
        if (typeof old[oldKey] === "boolean") {
          return old[oldKey];
        }
      }
    }
    
    // 如果没有空间配置或空间配置中没有设置，使用全局设置
    // 优先使用插件提供的检查方法（更准确）
    if ((this.plugin as any).isPipelineModuleEnabled) {
      return (this.plugin as any).isPipelineModuleEnabled(moduleKey);
    }
    
    // 对于特定模块，使用专门的检查方法（这些方法检查全局设置）
    if (moduleKey === "finance") {
      return (this.plugin as any).isFinanceModuleEnabled?.() ?? true;
    }
    
    if (moduleKey === "contacts") {
      return (this.plugin as any).isContactsModuleEnabledV2?.() ?? false;
    }
    
    // Fallback: 直接从全局设置中检查
    const s: any = (this.plugin as any).settings;
    const v2 = s?.moduleEnabledV2;
    if (v2 && typeof v2[moduleKey] === "boolean") {
      return v2[moduleKey];
    }

    // 检查旧版本的模块启用设置（moduleEnabled）
    const old = s?.moduleEnabled;
    // 模块键映射（旧版本）
    const oldKeyMap: Record<string, string> = {
      task: "task",
      memo: "task", // memo 和 task 共用同一个启用开关（旧版本）
      checkin: "record", // checkin 属于 record 模块
      finance: "record", // finance 属于 record 模块
      project: "project",
      output: "output",
    };
    const oldKey = oldKeyMap[moduleKey] || moduleKey;
    if (old && typeof old[oldKey] === "boolean") {
      return old[oldKey];
    }

    // 默认启用（向后兼容）
    return true;
  }

  /** 检查模块的 DB 同步是否启用（按空间：优先从 ctx.space.settingsSnapshot 读取，否则用当前空间） */
  private isModuleDbSyncEnabled(moduleKey: RSLatteModuleKey, ctx: SpaceCtx): boolean {
    const urlCheckable = ((): boolean => {
      const apiBaseUrl = String((this.plugin as any).settings?.apiBaseUrl ?? "").trim();
      if (!apiBaseUrl) return false;
      const lower = apiBaseUrl.toLowerCase();
      if (!(lower.startsWith("http://") || lower.startsWith("https://"))) return false;
      try {
        new URL(apiBaseUrl);
        return true;
      } catch {
        return false;
      }
    })();
    if (!urlCheckable) return false;

    // 优先从该空间的 settingsSnapshot 读取（与 isModuleEnabled 一致，保证状态灯按空间正确）
    if (ctx.space?.settingsSnapshot) {
      const s = ctx.space.settingsSnapshot as any;
      switch (moduleKey) {
        case "checkin":
          return s?.checkinPanel?.enableDbSync !== false;
        case "finance":
          return s?.financePanel?.enableDbSync !== false;
        case "task":
          return (s?.taskModule?.enableDbSync ?? s?.taskPanel?.enableDbSync) !== false;
        case "memo":
          return (s?.memoModule?.enableDbSync ?? s?.taskPanel?.enableDbSync) !== false;
        case "project":
          return (s?.projectEnableDbSync ?? true) !== false;
        case "output": {
          const op = s?.outputPanel ?? {};
          return (op.enableDbSync === undefined ? true : !!op.enableDbSync);
        }
        case "contacts": {
          const cm = s?.contactsModule ?? {};
          return !!cm?.enableDbSync;
        }
        default:
          return false;
      }
    }

    // 无空间快照时使用插件方法（当前空间）
    if (typeof (this.plugin as any).isModuleDbSyncEnabled === "function") {
      return (this.plugin as any).isModuleDbSyncEnabled(moduleKey);
    }

    const s = (this.plugin as any).settings;
    if (!s) return false;
    switch (moduleKey) {
      case "checkin":
        return s.checkinPanel?.enableDbSync !== false;
      case "finance":
        return s.financePanel?.enableDbSync !== false;
      case "task":
        return (s.taskModule?.enableDbSync ?? s.taskPanel?.enableDbSync) !== false;
      case "memo":
        return (s.memoModule?.enableDbSync ?? s.taskPanel?.enableDbSync) !== false;
      case "project":
        return (s.projectEnableDbSync ?? true) !== false;
      case "output": {
        const op = s.outputPanel ?? {};
        return (op.enableDbSync === undefined ? true : !!op.enableDbSync);
      }
      case "contacts":
        return !!(s.contactsModule?.enableDbSync);
      default:
        return false;
    }
  }

  private moduleStatsPath(ctx: SpaceCtx, moduleKey: RSLatteModuleKey): string {
    return normalizePath(`${this.getStatsDir(ctx)}/${moduleKey}.json`);
  }

  private spaceStatsPath(ctx: SpaceCtx): string {
    return normalizePath(`${this.getStatsDir(ctx)}/space.json`);
  }

  /**
   * 方案A：从队列文件读取真实的 pending/failed 计数
   * 这是唯一真实来源，不依赖内存状态
   */
  private async readQueueCountsForModule(
    ctx: SpaceCtx,
    moduleKey: RSLatteModuleKey
  ): Promise<{ pending: number; failed: number }> {
    const app = (this.plugin as any).app;
    const s: any = (this.plugin as any).settings;
    
    try {
      // task/memo: 从索引文件读取，通过检查dbSyncState和itemId/sourceHash来判断
      if (moduleKey === "task" || moduleKey === "memo") {
        const taskRSLatte = (this.plugin as any).taskRSLatte;
        if (taskRSLatte && taskRSLatte.store) {
          try {
            const idx = await taskRSLatte.store.readIndex(moduleKey);
            const items = (idx.items ?? []) as any[];
            let pending = 0;
            let failed = 0;
            
            for (const it of items) {
              if (it?.archived) continue;
              const st = String(it?.dbSyncState ?? "").trim();
              if (st === "failed") {
                failed++;
                continue;
              }
              const itemId = it?.itemId;
              const sourceHash = String(it?.sourceHash || "");
              const last = String((it as any)?.lastPushedHash || "");
              if (itemId == null) {
                pending++;
                continue;
              }
              if (!last || (sourceHash && last !== sourceHash)) {
                pending++;
                continue;
              }
            }
            
            return { pending, failed };
          } catch (e) {
            console.warn(`[RSLatte][SpaceStats] Failed to read task/memo queue counts for ${moduleKey}:`, e);
          }
        }
        return { pending: 0, failed: 0 };
      }
      
      // project: 从队列文件读取
      if (moduleKey === "project") {
        try {
          const queueDir = normalizePath(`${resolveSpaceQueueDir(s, ctx.spaceId, [s?.projectRSLatteIndexDir])}/project`);
          const syncQueue = (this.plugin as any).projectManager?._syncQueue;
          
          if (syncQueue && syncQueue.listAll) {
            const ops = await syncQueue.listAll();
            const pendingCount = ops.length;
            const failedOps = ops.filter((o: any) => Boolean((o as any).last_error));
            const failedCount = failedOps.length;
            return { pending: pendingCount, failed: failedCount };
          }
          
          // 如果无法从syncQueue获取，尝试直接从队列文件读取
          const queuePath = normalizePath(`${queueDir}/sync-queue.json`);
          const exists = await app.vault.adapter.exists(queuePath);
          if (exists) {
            const queue = await readJson<{ version: number; updatedAt: string; ops: any[] }>(app, queuePath, { version: 1, updatedAt: "", ops: [] });
            const ops = queue.ops ?? [];
            const pendingCount = ops.length;
            const failedOps = ops.filter((o: any) => Boolean((o as any).last_error));
            const failedCount = failedOps.length;
            return { pending: pendingCount, failed: failedCount };
          }
        } catch (e) {
          console.warn(`[RSLatte][SpaceStats] Failed to read project queue counts:`, e);
        }
        return { pending: 0, failed: 0 };
      }
      
      // checkin/finance: 从recordRSLatte服务的索引快照读取
      if (moduleKey === "checkin" || moduleKey === "finance") {
        const recordRSLatte = (this.plugin as any).recordRSLatte;
        if (recordRSLatte) {
          try {
            const norm = (v: any) => String(v ?? "").trim();
            
            if (moduleKey === "checkin") {
              const snap = await recordRSLatte.getCheckinSnapshot(false);
              const items = (snap.items ?? []) as any[];
              let pending = 0;
              let failed = 0;
              
              // 计算hash的函数（与recordSync.ts中一致）
              const computeCheckinHash = (it: any): string => {
                const rd = norm(it.recordDate);
                const id = norm(it.checkinId);
                const note = norm(it.note);
                const del = it.isDelete ? "1" : "0";
                return fnv1a32(`${rd}|${id}|${note}|${del}`);
              };
              
              // needsSync判断（与recordSync.ts中一致）
              const needsSync = (it: any, computeHash: (x: any) => string): boolean => {
                const src = norm(it.dbSourceHash) || computeHash(it);
                const last = norm(it.dbLastSyncedHash);
                const st = norm(it.dbSyncState);
                if (st === "failed" || st === "dirty" || st === "pending") return true;
                if (!last) return true;
                return last !== src;
              };
              
              for (const it of items ?? []) {
                const st = String(it?.dbSyncState ?? "").trim();
                if (st === "failed") {
                  failed++;
                  continue;
                }
                // 使用needsSync判断是否需要同步
                if (needsSync(it, computeCheckinHash)) {
                  pending++;
                }
              }
              
              return { pending, failed };
            } else if (moduleKey === "finance") {
              const snap = await recordRSLatte.getFinanceSnapshot(false);
              const items = (snap.items ?? []) as any[];
              let pending = 0;
              let failed = 0;
              
              // 计算hash的函数（与recordSync.ts中一致）
              const computeFinanceHash = (it: any): string => {
                const rd = norm(it.recordDate);
                const id = norm(it.categoryId);
                const ty = norm(it.type);
                const amt = String(Number(it.amount ?? 0));
                const note = norm(it.note);
                const del = it.isDelete ? "1" : "0";
                return fnv1a32(`${rd}|${id}|${ty}|${amt}|${note}|${del}`);
              };
              
              // needsSync判断（与recordSync.ts中一致）
              const needsSync = (it: any, computeHash: (x: any) => string): boolean => {
                const src = norm(it.dbSourceHash) || computeHash(it);
                const last = norm(it.dbLastSyncedHash);
                const st = norm(it.dbSyncState);
                if (st === "failed" || st === "dirty" || st === "pending") return true;
                if (!last) return true;
                return last !== src;
              };
              
              for (const it of items ?? []) {
                const st = String(it?.dbSyncState ?? "").trim();
                if (st === "failed") {
                  failed++;
                  continue;
                }
                // 使用needsSync判断是否需要同步
                if (needsSync(it, computeFinanceHash)) {
                  pending++;
                }
              }
              
              return { pending, failed };
            }
          } catch (e) {
            console.warn(`[RSLatte][SpaceStats] Failed to read ${moduleKey} queue counts:`, e);
          }
        }
        return { pending: 0, failed: 0 };
      }
      
      // output: 从outputRSLatte服务的syncState文件读取（考虑空间隔离）
      if (moduleKey === "output") {
        try {
          const s: any = (this.plugin as any).settings;
          const op: any = s?.outputPanel ?? {};
          // 直接使用 OutputIndexStore 读取特定空间的 syncState
          const indexDir = resolveSpaceIndexDir(s, ctx.spaceId, [op.rslatteIndexDir]);
          const store = new OutputIndexStore(app, indexDir);
          const syncState = await store.readSyncState();
          const byId = syncState?.byId ?? {};
          const items = Object.values(byId) as any[];
          
          let pending = 0;
          let failed = 0;
          
          for (const it of items) {
            const st = String(it?.dbSyncState ?? "").trim();
            if (st === "failed") {
              failed++;
            } else if (st !== "ok") {
              // pending 或其他非 ok 状态（包括空字符串）
              pending++;
            }
          }
          
          return { pending, failed };
        } catch (e) {
          console.warn(`[RSLatte][SpaceStats] Failed to read output queue counts:`, e);
        }
        return { pending: 0, failed: 0 };
      }
      
      // contacts: contacts模块没有队列文件，同步是实时的
      // 由于contacts模块的同步是即时执行的（tryContactsDbSyncByPaths），没有持久化的队列状态
      // 因此无法从文件读取队列计数，只能返回0（表示没有队列机制）
      // 实际的同步状态会通过markDbSyncWithCounts更新到_dbSyncMeta中
      if (moduleKey === "contacts") {
        // contacts模块的同步是实时的，没有队列文件
        // 如果需要获取同步状态，应该从_dbSyncMeta读取，但根据方案A的要求，我们优先从文件读取
        // 由于contacts没有队列文件，这里返回0
        return { pending: 0, failed: 0 };
      }
      
      return { pending: 0, failed: 0 };
    } catch (e) {
      console.warn(`[RSLatte][SpaceStats] Failed to read queue counts for ${moduleKey}:`, e);
      return { pending: 0, failed: 0 };
    }
  }

  private async computeTaskMemoCountsAndKpi(
    ctx: SpaceCtx,
    moduleKey: "task" | "memo"
  ): Promise<{ counts: any; kpi: RSLatteModuleKpiByModule }>
  {
    const app = (this.plugin as any).app;
    const s: any = (this.plugin as any).settings;
    
    // 使用特定空间的索引目录
    const spaceIndexDir = resolveSpaceIndexDir(s, ctx.spaceId, [s?.taskPanel?.rslatteIndexDir]);
    
    if (this.plugin.isDebugLogEnabled()) {
      console.log(`[RSLatte][SpaceStats][DEBUG] computeTaskMemoCountsAndKpi for module: ${moduleKey}, spaceId: ${ctx.spaceId}, indexDir: ${spaceIndexDir}`);
    }

    // 直接从特定空间的索引文件读取，不经过回退逻辑
    const type = moduleKey === "task" ? "task" : "memo";
    const indexPath = normalizePath(`${spaceIndexDir}/${type}-index.json`);
    const fallback: RSLatteIndexFile = { version: 1, updatedAt: new Date().toISOString(), items: [] };
    
    let idx: RSLatteIndexFile;
    try {
      const exists = await app.vault.adapter.exists(indexPath);
      if (this.plugin.isDebugLogEnabled()) {
        console.log(`[RSLatte][SpaceStats][DEBUG] Reading index file: ${indexPath}, exists: ${exists}`);
      }
      if (!exists) {
        idx = fallback;
      } else {
        const raw = await app.vault.adapter.read(indexPath);
        idx = raw ? (JSON.parse(raw) as RSLatteIndexFile) : fallback;
        const itemCount = Array.isArray(idx.items) ? idx.items.length : 0;
        if (this.plugin.isDebugLogEnabled()) {
          console.log(`[RSLatte][SpaceStats][DEBUG] File ${type}-index.json contains ${itemCount} items`);
        }
      }
    } catch (e) {
      if (this.plugin.isDebugLogEnabled()) {
        console.warn(`[RSLatte][SpaceStats][DEBUG] Error reading ${indexPath}:`, e);
      }
      idx = fallback;
    }
    const items = Array.isArray((idx as any)?.items) ? ((idx as any).items as any[]) : [];
    const archived = items.filter((it) => (it as any)?.archived === true);
    const active = items.filter((it) => (it as any)?.archived !== true);

    const counts = { total: items.length, active: active.length, archived: archived.length };
    const t = todayYmd();

    if (moduleKey === "memo") {
      const since = ymdAdd(t, -6);
      const new7d = active.filter((it: RSLatteIndexItem) => {
        const d = String((it as any).memoDate ?? "").slice(0, 10);
        if (d && d.length === 10) return ymdBetween(d, since, t);
        const seen = String((it as any).seenAt ?? "").slice(0, 10);
        return seen && seen.length === 10 ? ymdBetween(seen, since, t) : false;
      }).length;

      return { counts, kpi: { memo: { total: active.length, new7d } } };
    }

    // task KPI
    const activeTasks = active as RSLatteIndexItem[];
    const overdue = activeTasks.filter((it) => {
      const st = String((it as any).status ?? "");
      if (st === "DONE" || st === "CANCELLED") return false;
      const due = String((it as any).dueDate ?? "");
      return due && due.length === 10 && due < t;
    }).length;

    const dueTodayAll = activeTasks.filter((it) => {
      const due = String((it as any).dueDate ?? "");
      return due === t;
    });
    const dueTodayTotal = dueTodayAll.length;
    const dueTodayDone = dueTodayAll.filter((it) => String((it as any).status ?? "") === "DONE").length;

    const next7End = ymdAdd(t, 7);
    const next7d = activeTasks.filter((it) => {
      const st = String((it as any).status ?? "");
      if (st === "DONE" || st === "CANCELLED") return false;
      const due = String((it as any).dueDate ?? "");
      return due && due.length === 10 && due > t && due <= next7End;
    }).length;

    return { counts, kpi: { task: { overdue, dueTodayDone, dueTodayTotal, next7d } } };
  }

  /**
   * 直接读取特定空间的索引文件，不经过回退逻辑
   */
  private async readSpaceIndexFile<T>(
    app: any,
    spaceIndexDir: string,
    filename: string,
    fallback: T
  ): Promise<T> {
    const path = normalizePath(`${spaceIndexDir}/${filename}`);
    try {
      const exists = await app.vault.adapter.exists(path);
      if (this.plugin.isDebugLogEnabled()) {
        console.log(`[RSLatte][SpaceStats][DEBUG] Reading index file: ${path}, exists: ${exists}`);
      }
      if (!exists) {
        if (this.plugin.isDebugLogEnabled()) {
          console.log(`[RSLatte][SpaceStats][DEBUG] File not found, returning fallback`);
        }
        return fallback;
      }
      const raw = await app.vault.adapter.read(path);
      const parsed = raw ? (JSON.parse(raw) as T) : fallback;
      // 如果是索引文件，记录项目数量
      if (filename.includes("index.json") && (parsed as any)?.items) {
        const itemCount = Array.isArray((parsed as any).items) ? (parsed as any).items.length : 0;
        if (this.plugin.isDebugLogEnabled()) {
          console.log(`[RSLatte][SpaceStats][DEBUG] File ${filename} contains ${itemCount} items`);
        }
      }
      return parsed;
    } catch (e) {
      if (this.plugin.isDebugLogEnabled()) {
        console.warn(`[RSLatte][SpaceStats][DEBUG] Error reading ${path}:`, e);
      }
      return fallback;
    }
  }

  private async computeRecordCountsAndKpi(
    ctx: SpaceCtx,
    moduleKey: "checkin" | "finance"
  ): Promise<{ counts: any; kpi: RSLatteModuleKpiByModule }>
  {
    const app = (this.plugin as any).app;
    const s: any = (this.plugin as any).settings;
    
    // 使用特定空间的索引目录
    const spaceIndexDir = resolveSpaceIndexDir(s, ctx.spaceId, [s?.rslattePanelIndexDir]);
    
    if (this.plugin.isDebugLogEnabled()) {
      console.log(`[RSLatte][SpaceStats][DEBUG] computeRecordCountsAndKpi for module: ${moduleKey}, spaceId: ${ctx.spaceId}, indexDir: ${spaceIndexDir}`);
    }

    const t = todayYmd();

    if (moduleKey === "checkin") {
      // 直接从特定空间的索引文件读取，不经过回退逻辑
      const snap: CheckinRecordIndexFile = await this.readSpaceIndexFile(
        app,
        spaceIndexDir,
        "checkin-record-index.json",
        { version: 1, updatedAt: new Date().toISOString(), items: [] } as CheckinRecordIndexFile
      );
      const items = Array.isArray((snap as any)?.items) ? ((snap as any).items as any[]) : [];
      // 过滤掉已删除的项目
      const validItems = items.filter((r) => !(r as any)?.isDelete);
      const total = validItems.length;
      if (this.plugin.isDebugLogEnabled()) {
        console.log(`[RSLatte][SpaceStats][DEBUG] checkin: read ${items.length} items (${validItems.length} valid) from index file for space ${ctx.spaceId}`);
      }
      
      // 警告：如果索引文件包含数据，但用户期望为空，可能是索引文件包含了其他空间的数据
      // 这通常发生在重建索引时，RecordRSLatte 服务扫描了所有空间的日记文件
      if (total > 0) {
        console.warn(`[RSLatte][SpaceStats] WARNING: Index file for space ${ctx.spaceId} contains ${total} checkin items. If this is incorrect, the index file may contain data from other spaces. Please rebuild the index for this space only.`);
      }

      // 读取清单数据（也直接从特定空间的索引文件读取）
      const lists: RSLatteListsIndexFile = await this.readSpaceIndexFile(
        app,
        spaceIndexDir,
        "rslatte-lists-index.json",
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          checkinItems: [],
          financeCategories: [],
          financeSubcategoriesByCategoryId: {},
          tombstoneCheckinIds: [],
          tombstoneFinanceIds: [],
        } as RSLatteListsIndexFile
      );
      const listItems: CheckinItemIndexItem[] = Array.isArray((lists as any)?.checkinItems) ? (lists as any).checkinItems : [];
      const activeDefs = listItems.filter((x) => (x as any)?.active === true && !(x as any)?.deletedAt);
      const todaySet = new Set<string>();
      for (const r of validItems) {
        if (String((r as any)?.recordDate ?? "") !== t) continue;
        const id = String((r as any)?.checkinId ?? "").trim();
        if (id) todaySet.add(id);
      }
      const todayTotal = activeDefs.length;
      const todayDone = activeDefs.filter((d) => todaySet.has(String((d as any).id))).length;

      // streak: consecutive days where ALL active checkins are done
      let streak = 0;
      if (todayTotal > 0) {
        const byDay = new Map<string, Set<string>>();
        for (const r of items) {
          if ((r as any)?.isDelete === true) continue;
          const day = String((r as any)?.recordDate ?? "").trim();
          const id = String((r as any)?.checkinId ?? "").trim();
          if (!day || !id) continue;
          if (!byDay.has(day)) byDay.set(day, new Set());
          byDay.get(day)!.add(id);
        }
        let cur = t;
        while (true) {
          const set = byDay.get(cur);
          if (!set) break;
          const doneCnt = activeDefs.filter((d) => set.has(String((d as any).id))).length;
          if (doneCnt < todayTotal) break;
          streak++;
          cur = ymdAdd(cur, -1);
        }
      }

      return { counts: { total, active: total, archived: 0 }, kpi: { checkin: { todayDone, todayTotal, streak } } };
    }

    // finance
    // 直接从特定空间的索引文件读取，不经过回退逻辑
    const snap: FinanceRecordIndexFile = await this.readSpaceIndexFile(
      app,
      spaceIndexDir,
      "finance-record-index.json",
      { version: 1, updatedAt: new Date().toISOString(), items: [] } as FinanceRecordIndexFile
    );
    const items = Array.isArray((snap as any)?.items) ? ((snap as any).items as any[]) : [];
    // 过滤掉已删除的项目
    const validItems = items.filter((r) => !(r as any)?.isDelete);
    const total = validItems.length;
    if (this.plugin.isDebugLogEnabled()) {
      console.log(`[RSLatte][SpaceStats][DEBUG] finance: read ${items.length} items (${validItems.length} valid) from index file for space ${ctx.spaceId}`);
      // 检查索引文件中的空间ID（如果有的话）
      if (items.length > 0) {
        const firstItem = items[0];
        console.log(`[RSLatte][SpaceStats][DEBUG] First finance item sample:`, {
          financeId: (firstItem as any)?.financeId,
          recordDate: (firstItem as any)?.recordDate,
          spaceId: (firstItem as any)?.spaceId,
        });
      }
    }
    const ym = t.slice(0, 7);

    let mtdSpend = 0;
    let mtdNet = 0;
    const catAgg = new Map<string, number>();

    for (const r of validItems) {
      const d = String((r as any)?.recordDate ?? "");
      if (!d.startsWith(ym)) continue;
      const amt = num((r as any)?.amount);
      mtdNet += amt;
      const typ = String((r as any)?.type ?? "");
      const isExpense = typ === "expense" || amt < 0;
      if (isExpense) {
        const spend = Math.abs(amt);
        mtdSpend += spend;
        const cname = String((r as any)?.categoryName ?? (r as any)?.categoryId ?? "").trim() || "(未分类)";
        catAgg.set(cname, (catAgg.get(cname) ?? 0) + spend);
      }
    }

    let topCategoryName = "";
    let topCategoryAmount = 0;
    for (const [k, v] of catAgg.entries()) {
      if (v > topCategoryAmount) {
        topCategoryAmount = v;
        topCategoryName = k;
      }
    }

    return {
      counts: { total, active: total, archived: 0 },
      kpi: { finance: { mtdSpend, mtdNet, topCategoryName, topCategoryAmount } },
    };
  }

  private async computeProjectCountsAndKpi(ctx: SpaceCtx): Promise<{ counts: any; kpi: RSLatteModuleKpiByModule }>
  {
    const app = (this.plugin as any).app;
    const s: any = (this.plugin as any).settings;
    const indexDir = resolveSpaceIndexDir(s, ctx.spaceId, [s?.projectRSLatteIndexDir]);
    const queueDir = normalizePath(`${resolveSpaceQueueDir(s, ctx.spaceId, [s?.projectRSLatteIndexDir])}/project`);
    const store = new ProjectIndexStore(app, indexDir, queueDir);
    const idx = await store.readIndex().catch(() => null as any);
    const items: any[] = Array.isArray((idx as any)?.items) ? (idx as any).items : [];
    const total = items.length;
    const active = items.filter((it) => {
      const st = String((it as any).status ?? "");
      return st !== "done" && st !== "cancelled";
    });

    const t = todayYmd();
    const end = ymdAdd(t, 14);
    const dueNext14d = active.filter((it) => {
      const due = String((it as any).due_date ?? (it as any).dueDate ?? "");
      return due && due.length === 10 && ymdBetween(due, t, end);
    }).length;

    // 计算超过截至日期的项目数量
    const overdue = active.filter((it) => {
      const due = String((it as any).due_date ?? (it as any).dueDate ?? "");
      if (!due || due.length !== 10) return false;
      return due < t; // 截至日期在今天之前
    }).length;

    return {
      counts: { total, active: active.length, archived: total - active.length },
      kpi: { project: { activeProjects: active.length, dueNext14d, overdue } },
    };
  }

  private async computeOutputCountsAndKpi(ctx: SpaceCtx): Promise<{ counts: any; kpi: RSLatteModuleKpiByModule }>
  {
    const app = (this.plugin as any).app;
    const s: any = (this.plugin as any).settings;
    const indexDir = resolveSpaceIndexDir(s, ctx.spaceId, [s?.outputPanel?.rslatteIndexDir, s?.outputRSLatteIndexDir]);
    const store = new OutputIndexStore(app, indexDir);
    const idx = await store.readIndex().catch(() => null as any);
    const items: any[] = Array.isArray((idx as any)?.items) ? (idx as any).items : [];
    const total = items.length;

    const t = todayYmd();
    const since = ymdAdd(t, -6);
    const generatedThisWeek = items.filter((it) => {
      const d = String((it as any).createDate ?? "").slice(0, 10);
      if (d && d.length === 10) return ymdBetween(d, since, t);
      const ctime = (it as any).ctimeMs;
      if (Number.isFinite(Number(ctime))) {
        const y = momentFn(Number(ctime)).format("YYYY-MM-DD");
        return ymdBetween(y, since, t);
      }
      return false;
    }).length;

    let lastGeneratedAt = "";
    let maxM = 0;
    for (const it of items) {
      const m = num((it as any).mtimeMs);
      if (m > maxM) maxM = m;
    }
    if (maxM > 0) lastGeneratedAt = new Date(maxM).toISOString();

    // 计算超过30天没有完成或取消的输出数量
    const staleThreshold = ymdAdd(t, -30);
    const staleCount = items.filter((it) => {
      const status = String((it as any).status ?? "");
      // 只统计未完成和未取消的
      if (status === "done" || status === "cancelled") return false;
      
      // 检查最后修改时间或创建时间
      const mtime = (it as any).mtimeMs;
      const ctime = (it as any).ctimeMs;
      const lastDate = mtime ? momentFn(Number(mtime)).format("YYYY-MM-DD") : 
                       (ctime ? momentFn(Number(ctime)).format("YYYY-MM-DD") : "");
      
      if (!lastDate || lastDate.length !== 10) return false;
      return lastDate < staleThreshold; // 最后活动时间在30天前
    }).length;

    return {
      counts: { total, active: total, archived: 0 },
      kpi: { output: { generatedThisWeek, lastGeneratedAt, staleCount } },
    };
  }

  private async computeContactsCountsAndKpi(ctx: SpaceCtx): Promise<{ counts: any; kpi: RSLatteModuleKpiByModule }>
  {
    const app = (this.plugin as any).app;
    const s: any = (this.plugin as any).settings;
    const indexDir = resolveSpaceIndexDir(s, ctx.spaceId);
    const store = new ContactsIndexStore(app, () => indexDir);
    const idx = await store.readIndex().catch(() => null as any);
    const items: any[] = Array.isArray((idx as any)?.items) ? (idx as any).items : [];
    const total = items.length;
    const active = items.filter((it) => String((it as any).status ?? "") !== "cancelled");

    const t = todayYmd();
    const since30 = ymdAdd(t, -29);
    const touched30d = active.filter((it) => {
      const last = String((it as any).last_interaction_at ?? "").slice(0, 10);
      return last && last.length === 10 ? ymdBetween(last, since30, t) : false;
    }).length;

    // upcoming30d: compute next birthday from frontmatter (best-effort)
    const end30 = ymdAdd(t, 30);
    let upcoming30d = 0;
    for (const it of active) {
      const p = String((it as any).file_path ?? "").trim();
      if (!p) continue;
      const af = app.vault.getAbstractFileByPath(p);
      if (!(af instanceof TFile)) continue;
      const fm = app.metadataCache.getFileCache(af)?.frontmatter as any;
      const b = fm?.birthday;
      if (!b || typeof b !== "object") continue;

      let nextYmd: string | null = null;
      const typ = String(b.type ?? "");
      const mm = Number(b.month ?? 0);
      const dd = Number(b.day ?? 0);
      const leap = !!b.leap_month;

      try {
        if (typ === "solar" && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
          const cand = `${t.slice(0, 4)}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
          nextYmd = cand >= t ? cand : `${String(Number(t.slice(0, 4)) + 1)}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
        } else if (typ === "lunar" && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 30) {
          nextYmd = nextSolarDateForLunarBirthday(`${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`, leap, t);
        }
      } catch {
        nextYmd = null;
      }

      if (nextYmd && nextYmd.length === 10 && ymdBetween(nextYmd, t, end30)) upcoming30d++;
    }

    return {
      counts: { total, active: active.length, archived: total - active.length, parseErrorFiles: num((idx as any)?.parseErrorFiles?.length) },
      kpi: { contacts: { touched30d, upcoming30d } },
    };
  }

  private async computeCountsAndKpi(ctx: SpaceCtx, moduleKey: RSLatteModuleKey): Promise<{ counts: any; kpi: RSLatteModuleKpiByModule }>
  {
    if (moduleKey === "task" || moduleKey === "memo") return this.computeTaskMemoCountsAndKpi(ctx, moduleKey);
    if (moduleKey === "checkin" || moduleKey === "finance") return this.computeRecordCountsAndKpi(ctx, moduleKey);
    if (moduleKey === "project") return this.computeProjectCountsAndKpi(ctx);
    if (moduleKey === "output") return this.computeOutputCountsAndKpi(ctx);
    if (moduleKey === "contacts") return this.computeContactsCountsAndKpi(ctx);
    return { counts: {}, kpi: {} };
  }

  public async writeModuleStats(args: {
    ctx: SpaceCtx;
    moduleKey: RSLatteModuleKey;
    runId: string;
    mode: any;
    phase: any;
    startedAt: string;
    finishedAt: string;
    gate?: RSLatteReconcileGate;
    stats?: RSLatteModuleStats;
  }): Promise<void>
  {
    const app = (this.plugin as any).app;
    const { ctx, moduleKey } = args;

    // 防御性检查：确保 ctx 和 ctx.vaultId 存在
    if (!ctx) {
      throw new Error("writeModuleStats: ctx is undefined");
    }
    if (!ctx.vaultId || ctx.vaultId.trim() === "") {
      throw new Error("writeModuleStats: ctx.vaultId is empty");
    }
    if (!ctx.spaceId || ctx.spaceId.trim() === "") {
      throw new Error("writeModuleStats: ctx.spaceId is empty");
    }

    const { counts, kpi } = await this.computeCountsAndKpi(ctx, moduleKey);

    const gate = args.gate ?? ({} as any);
    const out: RSLatteModuleStatsFileV1 = {
      schema_version: 1,
      updated_at: isoNow(),
      vault_id: ctx.vaultId,
      space_id: ctx.spaceId,
      module_key: moduleKey,
      run: {
        runId: String(args.runId),
        startedAt: args.startedAt,
        finishedAt: args.finishedAt,
        mode: args.mode,
        phase: args.phase,
      },
      sync: {
        dbSyncEnabled: gate.dbSyncEnabled === true,
        pendingCount: num((gate as any).pendingCount),
        failedCount: num((gate as any).failedCount),
      },
      counts,
      kpi,
    };

    await writeJson(app, this.moduleStatsPath(ctx, moduleKey), out);

    // Notify UI listeners (Hub etc.)
    try {
      ((this.plugin as any).app?.workspace as any)?.trigger?.(RSLATTE_EVENT_SPACE_STATS_UPDATED, {
        spaceId: ctx.spaceId,
        moduleKey,
        updatedAt: out.updated_at,
      });
    } catch {
      // ignore
    }
  }

  public async refreshSpaceStats(ctx: SpaceCtx, enabledModules?: RSLatteModuleKey[], force?: boolean): Promise<void>
  {
    const app = (this.plugin as any).app;
    const statsDir = this.getStatsDir(ctx);
    await ensureFolder(app, statsDir);

    const modules: RSLatteModuleKey[] = enabledModules && enabledModules.length
      ? enabledModules
      : (["task", "memo", "checkin", "finance", "project", "output", "contacts"] as any);

    // 调试日志：记录刷新开始
    if (this.plugin.isDebugLogEnabled()) {
      console.log(`[RSLatte][SpaceStats] Starting refresh for space ${ctx.spaceId}, force: ${force}, modules:`, modules);
    }

    const entries: Record<string, RSLatteSpaceStatsModuleEntryV1> = {};
    let pending_total = 0;
    let failed_total = 0;

    for (const mk of modules) {
      // 检查模块是否启用，如果未启用则跳过该模块（不生成统计数据）
      if (!this.isModuleEnabled(mk, ctx)) {
        if (this.plugin.isDebugLogEnabled()) {
          console.log(`[RSLatte][SpaceStats] Skipping disabled module: ${mk} for space ${ctx.spaceId}`);
        }
        continue; // 跳过未启用的模块，不生成统计数据
      }
      
      const path = this.moduleStatsPath(ctx, mk);
      const empty: any = null;
      const mod = await readJson<any>(app, path, empty);
      
      // 调试日志：检查统计数据文件
      if (this.plugin.isDebugLogEnabled()) {
        if (mk === "checkin") {
          console.log(`[RSLatte][SpaceStats][DEBUG] Module: ${mk}, File exists: ${!!mod}, Path: ${path}`);
          if (mod) {
            console.log(`[RSLatte][SpaceStats][DEBUG] File content - sync:`, mod?.sync);
            console.log(`[RSLatte][SpaceStats][DEBUG] File content - dbSyncEnabled:`, mod?.sync?.dbSyncEnabled);
            console.log(`[RSLatte][SpaceStats][DEBUG] File content - pendingCount:`, mod?.sync?.pendingCount);
            console.log(`[RSLatte][SpaceStats][DEBUG] File content - failedCount:`, mod?.sync?.failedCount);
          }
        }
      }
      
      if (!mod || force) {
        // 如果模块统计数据文件不存在，或者强制刷新，从索引重新计算统计数据
        // 这样可以确保即使 afterStats hook 没有执行，也能显示统计数据
        if (this.plugin.isDebugLogEnabled()) {
          console.log(`[RSLatte][SpaceStats][DEBUG] Recomputing stats for module: ${mk}, spaceId: ${ctx.spaceId}, force: ${force}, fileExists: ${!!mod}`);
        }
        try {
          const { counts, kpi } = await this.computeCountsAndKpi(ctx, mk);
          if (this.plugin.isDebugLogEnabled()) {
            console.log(`[RSLatte][SpaceStats][DEBUG] Computed stats for module: ${mk}, spaceId: ${ctx.spaceId}, counts:`, counts, `kpi:`, kpi);
          }
          
          // 尝试从插件的内存状态中获取同步状态
          let syncStatus: RSLatteSpaceStatsSyncStatus = "unknown";
          let pendingCount = 0;
          let failedCount = 0;
          
          const isDbSyncEnabled = this.isModuleDbSyncEnabled(mk, ctx);
          
          // 调试日志：检查 DB 同步状态
          if (this.plugin.isDebugLogEnabled() && mk === "checkin") {
            console.log(`[RSLatte][SpaceStats][DEBUG] Module: ${mk}, DB Sync Enabled: ${isDbSyncEnabled}`);
          }
          
          if (!isDbSyncEnabled) {
            syncStatus = "off";
          } else {
            // 方案A：直接从队列文件读取真实的 pending/failed 计数（唯一真实来源）
            try {
              const queueCounts = await this.readQueueCountsForModule(ctx, mk);
              pendingCount = queueCounts.pending;
              failedCount = queueCounts.failed;
              
              // 使用统一的状态计算服务计算状态
              const gate: RSLatteReconcileGate = {
                dbSyncEnabled: isDbSyncEnabled,
                pendingCount,
                failedCount,
              } as any;
              syncStatus = StatusCalculationService.calculateSyncStatus(gate);
              
              // 调试日志
              if (this.plugin.isDebugLogEnabled() && mk === "checkin") {
                console.log(`[RSLatte][SpaceStats][DEBUG] Using queue counts for ${mk}:`, {
                  pendingCount,
                  failedCount,
                  syncStatus,
                });
              }
              
              // 同时更新 _dbSyncMeta（保持一致性，用于侧边栏状态灯）
              if ((this.plugin as any).markDbSyncWithCounts) {
                (this.plugin as any).markDbSyncWithCounts(mk, {
                  pendingCount,
                  failedCount,
                  ok: failedCount === 0,
                  err: failedCount > 0 ? `部分${mk}同步失败` : undefined,
                });
              }
            } catch (e) {
              console.warn(`[RSLatte][SpaceStats] Failed to read queue counts for ${mk}:`, e);
              // 如果读取失败，使用 unknown 状态
              syncStatus = "unknown";
            }
          }
          
          // 调试日志：最终状态
          if (this.plugin.isDebugLogEnabled() && mk === "checkin") {
            console.log(`[RSLatte][SpaceStats][DEBUG] Final sync status for ${mk}:`, syncStatus);
          }
          
          // 创建统计文件（即使 afterStats hook 没有执行）
          try {
            // 方案A：gate 信息已经通过 readQueueCountsForModule 获取，直接使用
            const gate: any = {
              dbSyncEnabled: isDbSyncEnabled,
              pendingCount,
              failedCount,
            };
            
            // 写入统计文件
            await this.writeModuleStats({
              ctx,
              moduleKey: mk,
              runId: `refresh-${Date.now()}`,
              mode: "refresh",
              phase: "done",
              startedAt: isoNow(),
              finishedAt: isoNow(),
              gate,
            });
            
            if (this.plugin.isDebugLogEnabled() && mk === "checkin") {
              console.log(`[RSLatte][SpaceStats][DEBUG] Created stats file for ${mk} with gate:`, gate);
            }
          } catch (writeError) {
            console.warn(`[RSLatte][SpaceStats] Failed to write stats file for module ${mk}:`, writeError);
            if (this.plugin.isDebugLogEnabled() && mk === "checkin") {
              console.error(`[RSLatte][SpaceStats][DEBUG] Write error details:`, writeError);
            }
          }
          
          entries[mk] = {
            updated_at: isoNow(),
            module_key: mk,
            sync_status: syncStatus,
            pending_count: pendingCount,
            failed_count: failedCount,
            counts,
            kpi,
          };
        } catch (e) {
          // 如果计算失败，跳过该模块
          console.warn(`[RSLatte][SpaceStats] Failed to compute stats for module ${mk}:`, e);
        }
        // 如果强制刷新或文件不存在，已重新计算并写入，跳过文件读取逻辑
        if (force || !mod) continue;
      }
      
      // 文件存在且不强制刷新时，检查模块是否仍然启用
      // 如果模块已关闭，跳过该模块（不添加到 entries 中）
      if (!this.isModuleEnabled(mk, ctx)) {
        if (this.plugin.isDebugLogEnabled()) {
          console.log(`[RSLatte][SpaceStats] Module ${mk} is disabled, skipping existing stats file for space ${ctx.spaceId}`);
        }
        continue; // 跳过未启用的模块，不添加到 entries 中
      }
      
      // 文件存在且不强制刷新时，从文件读取现有统计数据
      // 方案A：即使从文件读取，也重新从队列文件读取最新的pending/failed计数，确保数据准确
      let pending = num(mod?.sync?.pendingCount);
      let failed = num(mod?.sync?.failedCount);
      
      // 记录文件中的原始数据（用于验证）
      const filePending = pending;
      const fileFailed = failed;
      
      // 如果DB同步已启用，从队列文件读取最新的计数（覆盖文件中的旧数据）
      const isDbSyncEnabled = this.isModuleDbSyncEnabled(mk, ctx);
      if (isDbSyncEnabled) {
        try {
          const queueCounts = await this.readQueueCountsForModule(ctx, mk);
          const queuePending = queueCounts.pending;
          const queueFailed = queueCounts.failed;
          
          // 状态验证：检查文件数据与队列文件数据是否一致
          const dataInconsistent = 
            filePending !== queuePending || 
            fileFailed !== queueFailed;
          
          if (dataInconsistent) {
            // 发现数据不一致，记录警告
            console.warn(
              `[RSLatte][SpaceStats] Data inconsistency detected for module ${mk} (space ${ctx.spaceId}):`,
              `file: pending=${filePending}, failed=${fileFailed};`,
              `queue: pending=${queuePending}, failed=${queueFailed}.`,
              `Updating file with queue data.`
            );
            
            // 调试日志：详细记录不一致情况
            if (this.plugin.isDebugLogEnabled()) {
              console.log(`[RSLatte][SpaceStats][DEBUG] Module ${mk} data inconsistency:`, {
                file: { pending: filePending, failed: fileFailed },
                queue: { pending: queuePending, failed: queueFailed },
                diff: {
                  pending: queuePending - filePending,
                  failed: queueFailed - fileFailed,
                },
              });
            }
          }
          
          // 使用队列文件的数据（更准确）
          pending = queuePending;
          failed = queueFailed;
          
          // 如果计数有变化，更新统计文件
          if (dataInconsistent) {
            const gate: any = {
              dbSyncEnabled: true,
              pendingCount: pending,
              failedCount: failed,
            };
            await this.writeModuleStats({
              ctx,
              moduleKey: mk,
              runId: `refresh-${Date.now()}`,
              mode: "refresh",
              phase: "done",
              startedAt: isoNow(),
              finishedAt: isoNow(),
              gate,
            });
            
            // 调试日志：记录文件更新
            if (this.plugin.isDebugLogEnabled()) {
              console.log(`[RSLatte][SpaceStats][DEBUG] Updated stats file for module ${mk} with corrected data`);
            }
          }
        } catch (e) {
          console.warn(`[RSLatte][SpaceStats] Failed to read queue counts for module ${mk}:`, e);
          // 如果读取失败，记录警告但继续使用文件中的计数
          if (this.plugin.isDebugLogEnabled()) {
            console.warn(`[RSLatte][SpaceStats][DEBUG] Using file data as fallback for module ${mk}:`, {
              pending,
              failed,
            });
          }
        }
      } else {
        // DB同步未启用，使用文件中的数据
        if (this.plugin.isDebugLogEnabled()) {
          console.log(`[RSLatte][SpaceStats][DEBUG] Module ${mk} DB sync disabled, using file data`);
        }
      }
      
      // 从统计文件的 sync 对象计算 sync_status，使用统一的状态计算服务
      const gateFromFile: RSLatteReconcileGate = {
        dbSyncEnabled: mod?.sync?.dbSyncEnabled === true,
        pendingCount: pending,
        failedCount: failed,
      } as any;
      const st = StatusCalculationService.calculateSyncStatus(gateFromFile);
      
      pending_total += pending;
      failed_total += failed;

      entries[mk] = {
        updated_at: String(mod.updated_at ?? mod?.run?.finishedAt ?? isoNow()),
        module_key: mk,
        sync_status: st,
        pending_count: pending,
        failed_count: failed,
        counts: mod.counts,
        kpi: mod.kpi,
      };
    }

    const out: RSLatteSpaceStatsFileV1 = {
      schema_version: 1,
      updated_at: isoNow(),
      vault_id: ctx.vaultId,
      space_id: ctx.spaceId,
      modules: entries,
      agg: { pending_total, failed_total, modules_enabled: modules.length },
    };

    await writeJson(app, this.spaceStatsPath(ctx), out);

    // 调试日志：记录刷新完成
    if (this.plugin.isDebugLogEnabled()) {
      console.log(`[RSLatte][SpaceStats] Completed refresh for space ${ctx.spaceId}:`, {
        modules: Object.keys(entries).length,
        pending_total,
        failed_total,
        updated_at: out.updated_at,
      });
    }

    // ✅ 如果所有模块都被跳过（entries 为空），不触发事件，避免无限循环
    // 这种情况发生在所有模块都关闭时
    if (Object.keys(entries).length === 0) {
      if (this.plugin.isDebugLogEnabled()) {
        console.log(`[RSLatte][SpaceStats] All modules skipped for space ${ctx.spaceId}, not triggering update event to avoid infinite loop`);
      }
      return; // 提前返回，不触发事件
    }

    // Notify UI listeners (Hub etc.)
    try {
      ((this.plugin as any).app?.workspace as any)?.trigger?.(RSLATTE_EVENT_SPACE_STATS_UPDATED, {
        spaceId: ctx.spaceId,
        moduleKey: "space",
        updatedAt: out.updated_at,
      });
    } catch {
      // ignore
    }
  }
}
