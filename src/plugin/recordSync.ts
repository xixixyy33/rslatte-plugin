/**
 * Record/Checkin/Finance DB 同步模块
 * 包含打卡和财务记录的数据库同步相关方法
 */
import { moment } from "obsidian";
// ✅ moment 从 Obsidian 导入，但 TypeScript 类型定义可能不完整，使用类型断言
const momentFn = moment as any;
import type RSLattePlugin from "../main";
import { normalizeArchiveThresholdDays } from "../constants/defaults";
import { fnv1a32 } from "../utils/hash";
import type { ApiCheckinRecord, ApiFinanceRecord } from "../api";

// DbSyncModuleKey 类型定义（与 main.ts 中的定义保持一致）
type DbSyncModuleKey = "record" | "checkin" | "finance" | "health" | "task" | "memo" | "output" | "project" | "contacts";

/** 打卡类型侧栏扩展 → `checkin_type.meta_sync` */
function buildCheckinTypeMetaSyncForDb(x: {
  checkinDifficulty?: string;
  heatColor?: string;
}): Record<string, unknown> | undefined {
  const difficulty = String(x?.checkinDifficulty ?? "").trim();
  const heat = String(x?.heatColor ?? "").trim();
  if (!difficulty && !heat) return undefined;
  const out: Record<string, unknown> = { schema_version: 1 };
  if (difficulty) out.checkin_difficulty = difficulty;
  if (heat) out.heat_color = heat;
  return out;
}

function resolveCheckinContinuousDays(plugin: RSLattePlugin, checkinId: string): number | undefined {
  const items = (plugin.settings?.checkinItems ?? []) as any[];
  const x = items.find((c: any) => String(c?.id ?? "") === String(checkinId));
  const d = x?.continuousDays;
  return typeof d === "number" && Number.isFinite(d) ? Math.max(0, Math.floor(d)) : undefined;
}

/** 当日连续天数等 → `checkin_records.meta_sync`（与 settings.checkinItems 对齐） */
function buildCheckinRecordMetaSyncForDb(plugin: RSLattePlugin, it: { checkinId?: string }): Record<string, unknown> | undefined {
  const cid = String(it?.checkinId ?? "").trim();
  if (!cid) return undefined;
  const days = resolveCheckinContinuousDays(plugin, cid);
  if (days === undefined) return undefined;
  return { schema_version: 1, continuous_days: days };
}

export function createRecordSync(plugin: RSLattePlugin) {
  // 私有字段的访问需要通过类型断言
  const getLastListsSyncKey = () => (plugin as any)._lastListsSyncKey;
  const setLastListsSyncKey = (key: string) => { (plugin as any)._lastListsSyncKey = key; };
  const getDbSyncMeta = () => (plugin as any)._dbSyncMeta;
  const getTodayCheckinsKey = () => (plugin as any)._todayCheckinsKey;
  const setTodayCheckinsKey = (key: string) => { (plugin as any)._todayCheckinsKey = key; };
  const getTodayCheckinsFetchedAt = () => (plugin as any)._todayCheckinsFetchedAt;
  const setTodayCheckinsFetchedAt = (at: number) => { (plugin as any)._todayCheckinsFetchedAt = at; };
  // 未使用的 getter，保留以备将来使用
  // const getTodayCheckinsMap = () => (plugin as any)._todayCheckinsMap;
  const setTodayCheckinsMap = (map: Map<string, ApiCheckinRecord>) => { (plugin as any)._todayCheckinsMap = map; };
  const getTodayFinancesKey = () => (plugin as any)._todayFinancesKey;
  const setTodayFinancesKey = (key: string) => { (plugin as any)._todayFinancesKey = key; };
  const getTodayFinancesFetchedAt = () => (plugin as any)._todayFinancesFetchedAt;
  const setTodayFinancesFetchedAt = (at: number) => { (plugin as any)._todayFinancesFetchedAt = at; };
  // 未使用的 getter，保留以备将来使用
  // const getTodayFinancesMap = () => (plugin as any)._todayFinancesMap;
  const setTodayFinancesMap = (map: Map<string, ApiFinanceRecord[]>) => { (plugin as any)._todayFinancesMap = map; };
  const getSerializeErrorForAudit = () => (plugin as any)._serializeErrorForAudit;

  return {
    /**
     * 自动同步"打卡项清单/财务分类清单"到数据库
     * - 仅在启用 DB 同步时触发
     * - 仅在内容变化后触发
     * 失败不会阻断插件使用。
     */
    async autoSyncRecordListsToDb(opts?: { reason?: string; modules?: { checkin?: boolean; finance?: boolean } }): Promise<void> {
      if (!plugin.isRSLatteDbSyncEnabled()) return;

      const mods = opts?.modules ?? { checkin: true, finance: true };
      const wantCheckin = mods.checkin !== false;
      const wantFinance = mods.finance !== false;
      const doCheckin = wantCheckin && plugin.isCheckinDbSyncEnabled();
      const doFinance = wantFinance && plugin.isFinanceDbSyncEnabled();
      if (!doCheckin && !doFinance) return;

      const key = JSON.stringify({
        c: doCheckin ? (plugin.settings.checkinItems ?? []) : [],
        f: doFinance ? (plugin.settings.financeCategories ?? []) : [],
      });
      // ✅ 若上次已成功同步且内容未变，则跳过
      if (key === getLastListsSyncKey()) return;

      // ✅ C0：仅在满足 shouldTouchBackendNow() 时才会触达后端；失败仅 warn（节流）并返回
      const vaultOk = await (plugin as any).vaultSvc?.ensureVaultReadySafe?.("autoSyncRecordListsToDb");
      if (!vaultOk) return;

      // ✅ D9：DB Ready 检查统一走 VaultService（内部包含 shouldTouchBackendNow + ensureVaultReadySafe + warn 节流）
      const db = await (plugin as any).vaultSvc?.checkDbReadySafe?.("autoSyncRecordListsToDb");
      if (!db.ok) return;

      const ck = doCheckin
        ? (plugin.settings.checkinItems ?? []).map((x) => {
            const base: any = {
              checkin_id: x.id,
              checkin_name: x.name,
              status: !!x.active,
            };
            const ms = buildCheckinTypeMetaSyncForDb(x as any);
            if (ms) base.meta_sync = ms;
            return base;
          })
        : [];

      const fin = doFinance
        ? (plugin.settings.financeCategories ?? []).map((x) => ({
            category_id: x.id,
            category_name: x.name,
            category_type: x.type,
            status: !!x.active,
            sub_categories: x.subCategories || [],
            institution_names: (Array.isArray((x as any).institutionNames) ? (x as any).institutionNames : [])
              .map((s: string) => String(s ?? "").trim())
              .filter(Boolean),
          }))
        : [];

      try {
        // ✅ 自动刷新：静默重试（不弹 Notice），失败则下次 tick 继续尝试
        // ✅ 严格检查：只有在 doCheckin 为 true 且 ck 数组非空时才调用 checkin 接口
        if (doCheckin && ck.length > 0) await plugin.api.upsertCheckinTypes(ck);
        // ✅ 严格检查：只有在 doFinance 为 true 且 fin 数组非空时才调用 finance 接口
        if (doFinance && fin.length > 0) await plugin.api.upsertFinanceCategories(fin);

        setLastListsSyncKey(key);
        plugin.dbg("autoRefresh", `autoSyncRecordListsToDb ok (${opts?.reason ?? ""})`, {
          checkins: doCheckin ? ck.length : 0,
          finance: doFinance ? fin.length : 0,
        });
      } catch (e) {
        console.warn("RSLatte autoSyncRecordListsToDb failed:", e);
      }
    },

    /**
     * 自动同步"打卡/财务记录索引"到数据库
     * - 自动 tick：只同步阈值范围内（避免全量打爆后端）
     * - 手动触发（刷新/重建后）：同步"当前活跃索引"全量，用于补偿此前失败条目
     */
    async autoSyncRecordIndexToDb(opts?: { reason?: string; modules?: { checkin?: boolean; finance?: boolean; health?: boolean } }): Promise<void> {
      const mods = opts?.modules;
      const fullDefault = mods == null;
      const wantCheckin = fullDefault ? true : mods!.checkin === true;
      const wantFinance = fullDefault ? true : mods!.finance === true;
      const wantHealth = fullDefault ? true : mods!.health === true;

      const doCheckin = wantCheckin && plugin.isCheckinDbSyncEnabled();
      const doFinance = wantFinance && plugin.isFinanceDbSyncEnabled();
      const doHealth = wantHealth && plugin.isHealthDbSyncEnabled();
      if (!doCheckin && !doFinance && !doHealth) return;

      // ✅ C0：先做 vaultReadySafe（内部会判断 shouldTouchBackendNow）；不满足条件/失败则直接返回
      const vaultOk = await (plugin as any).vaultSvc?.ensureVaultReadySafe?.("autoSyncRecordIndexToDb");
      if (!vaultOk) return;

      // ✅ D9：DB Ready 检查统一走 VaultService（内部包含 shouldTouchBackendNow + ensureVaultReadySafe + warn 节流）
      const db = await (plugin as any).vaultSvc?.checkDbReadySafe?.("autoSyncRecordIndexToDb");
      if (!db.ok) return;

      await plugin.recordRSLatte.ensureReady();
      const reason = String(opts?.reason ?? "");
      // ✅ rebuild/强制入库：用于 DB 被重置或历史同步元数据误判为"已同步"的场景。
      // 在该模式下：
      // 1) 先强制同步清单（打卡项/财务分类），确保外键/引用存在
      // 2) 再把索引范围内的记录全部 upsert 一遍（upsert 幂等；同日同类型只有一条）
      const forceFullUpsert = /rebuild/i.test(reason) || /manual_rebuild/i.test(reason);
      // ✅ 统一策略：
      // - 自动 tick：只同步阈值范围内（避免全量打爆后端）
      // - 手动触发（刷新/重建后）：同步"当前活跃索引"全量，用于补偿此前失败条目
      const isAutoTick = /auto|timer|interval/i.test(reason);

      const todayKey = plugin.getTodayKey();
      const days = normalizeArchiveThresholdDays((plugin.settings as any).rslattePanelArchiveThresholdDays ?? 90);
      const cutoff = momentFn(todayKey).subtract(days, "days").format("YYYY-MM-DD");

      // ✅ rebuild 模式：先确保清单已入库（即使内容未变化，也强制推一次）
      if (forceFullUpsert) {
        try {
          setLastListsSyncKey("");
          await (plugin as any).syncRecordListsToDb?.(mods ?? { checkin: true, finance: true });
        } catch (e) {
          console.warn("RSLatte autoSyncRecordIndexToDb: force sync lists failed", e);
          // 不阻断后续记录同步：即使清单同步失败，也尽可能把记录推过去，便于发现后端约束问题
        }
      }

      const cSnap = await plugin.recordRSLatte.getCheckinSnapshot(false);
      const fSnap = await plugin.recordRSLatte.getFinanceSnapshot(false);
      const hSnap = await plugin.recordRSLatte.getHealthSnapshot(false);

      const allCheckins = (cSnap.items ?? []) as any[];
      const allFinances = (fSnap.items ?? []) as any[];
      const allHealth = (hSnap.items ?? []) as any[];
      const scopeCheckins = isAutoTick ? allCheckins.filter((x: any) => String(x.recordDate ?? "") >= cutoff) : allCheckins;
      const scopeFinances = isAutoTick ? allFinances.filter((x: any) => String(x.recordDate ?? "") >= cutoff) : allFinances;
      const scopeHealth = isAutoTick ? allHealth.filter((x: any) => String(x.recordDate ?? "") >= cutoff) : allHealth;

      const norm = (v: any) => String(v ?? "").trim();
      const now = new Date().toISOString();
      const computeCheckinHash = (it: any): string => {
        const rd = norm(it.recordDate);
        const id = norm(it.checkinId);
        const note = norm(it.note);
        const del = it.isDelete ? "1" : "0";
        const ms = buildCheckinRecordMetaSyncForDb(plugin, it);
        const msKey = ms ? JSON.stringify(ms) : "";
        return fnv1a32(`${rd}|${id}|${note}|${del}|${msKey}`);
      };
      const computeFinanceHash = (it: any): string => {
        const rd = norm(it.recordDate);
        const id = norm(it.categoryId);
        const eid = norm(it.entryId);
        const ty = norm(it.type);
        const amt = String(Number(it.amount ?? 0));
        const note = norm(it.note);
        const cyc = norm((it as any).cycleId);
        const del = it.isDelete ? "1" : "0";
        return fnv1a32(`${rd}|${id}|${eid}|${ty}|${amt}|${note}|${cyc}|${del}`);
      };
      const computeHealthHash = (it: any): string => {
        const rd = norm(it.recordDate);
        const eid = norm(it.entryId);
        const mk = norm(it.metricKey);
        const period = norm(it.period);
        const card = norm(it.cardRef);
        const vs = norm(it.valueStr);
        const note = norm(it.note);
        const ssh = norm(it.sleepStartHm);
        const del = it.isDelete ? "1" : "0";
        return fnv1a32(`${rd}|${eid}|${mk}|${period}|${card}|${vs}|${note}|${ssh}|${del}`);
      };
      const needsSync = (it: any, computeHash: (x: any) => string): boolean => {
        const src = norm(it.dbSourceHash) || computeHash(it);
        if (!norm(it.dbSourceHash)) it.dbSourceHash = src;
        const last = norm(it.dbLastSyncedHash);
        const st = norm(it.dbSyncState);
        if (st === "failed" || st === "dirty" || st === "pending") return true;
        if (!last) return true;
        return last !== src;
      };

      // ✅ 本地先去重，避免重复请求。
      // - checkin: key = recordDate::checkinId
      // - finance: key = recordDate::categoryId::entryId（无 entryId 时用 legacy）
      const dedupeByKey = <T extends any>(items: T[], keyFn: (x: T) => string, scoreFn: (x: T) => number): T[] => {
        const map = new Map<string, T>();
        for (const it of items) {
          const k = keyFn(it);
          const old = map.get(k);
          if (!old) {
            map.set(k, it);
            continue;
          }
          // pick later/higher score
          if (scoreFn(it) >= scoreFn(old)) map.set(k, it);
        }
        return Array.from(map.values());
      };

      const checkins = doCheckin
        ? (forceFullUpsert
          ? dedupeByKey(scopeCheckins, (x: any) => `${String(x.recordDate)}::${String(x.checkinId)}`, (x: any) => Number(x.tsMs ?? 0))
          : scopeCheckins.filter((x) => needsSync(x, computeCheckinHash)))
        : [];

      const finKey = (x: any) =>
        norm(x.entryId)
          ? `${String(x.recordDate)}::${String(x.categoryId)}::${norm(x.entryId)}`
          : `${String(x.recordDate)}::${String(x.categoryId)}::legacy`;
      const finances = doFinance
        ? (forceFullUpsert
          ? dedupeByKey(scopeFinances, finKey, (x: any) => Number(x.tsMs ?? 0))
          : scopeFinances.filter((x) => needsSync(x, computeFinanceHash)))
        : [];

      const healthKey = (x: any) =>
        norm(x.entryId) ? `${String(x.recordDate)}::${norm(x.entryId)}` : `${String(x.recordDate)}::m::${norm(x.metricKey)}`;
      const healthItems = doHealth
        ? (forceFullUpsert
          ? dedupeByKey(scopeHealth, healthKey, (x: any) => Number(x.tsMs ?? 0))
          : scopeHealth.filter((x) => needsSync(x, computeHealthHash)))
        : [];

      let errCount = 0;
      let metaTouched = false;

      // ✅ Batch + 串行排队：避免 rebuild 时一次传入过多记录导致请求异常。
      // 每批 50 条，上一批返回后再发下一批。
      const BATCH_SIZE = 50;
      const chunks = <T>(arr: T[], size: number): T[][] => {
        const out: T[][] = [];
        for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
        return out;
      };

      const markOk = (it: any, srcHash: string) => {
        it.dbSyncState = "synced";
        it.dbLastSyncedHash = srcHash;
        it.dbLastSyncedAt = now;
        it.dbLastTriedAt = now;
        it.dbRetryCount = 0;
        it.dbLastError = undefined;
        metaTouched = true;
      };
      const markFail = (it: any, errMsg: string) => {
        errCount++;
        it.dbSyncState = "failed";
        it.dbLastTriedAt = now;
        it.dbRetryCount = Number(it.dbRetryCount ?? 0) + 1;
        it.dbLastError = errMsg || "sync failed";
        metaTouched = true;
      };

      // ----- Checkin batch upsert -----
      for (const batch of chunks(checkins, BATCH_SIZE)) {
        const payloadItems = batch.map((it: any) => {
          const srcHash = norm(it.dbSourceHash) || computeCheckinHash(it);
          it.dbSourceHash = srcHash;
          const row: any = {
            record_date: String(it.recordDate),
            checkin_id: String(it.checkinId),
            note: (it.note ?? "").trim() || undefined,
            is_delete: !!it.isDelete,
          };
          const ms = buildCheckinRecordMetaSyncForDb(plugin, it);
          if (ms) row.meta_sync = ms;
          return row;
        });

        try {
          const resp: any = await plugin.api.upsertCheckinRecordsBatch({ items: payloadItems });
          const results: any[] = Array.isArray(resp?.results) ? resp.results : [];
          if (results.length === 0) {
            // ✅ 兼容后端未返回逐条 results 的情况：只要整体成功，就视为整批成功
            const ok = resp?.ok === true || (typeof resp?.failed === "number" && resp.failed === 0);
            if (ok) {
              for (const it of batch) {
                const srcHash = String(it.dbSourceHash || "");
                markOk(it, srcHash);
              }
            } else {
              // 保守处理：整批失败
              for (const it of batch) {
                markFail(it, "batch sync failed: empty results");
              }
            }
            continue;
          }
          for (const r of results) {
            const idx = Number(r?.index);
            if (!Number.isFinite(idx) || idx < 0 || idx >= batch.length) continue;
            const it = batch[idx];
            const srcHash = String(it.dbSourceHash || "");
            if (r?.ok) markOk(it, srcHash);
            else markFail(it, String(r?.error || r?.message || "sync failed"));
          }
        } catch (e) {
          console.warn("RSLatte auto sync checkin batch failed", e);
          const msg = (e as any)?.message ? String((e as any).message) : "sync failed";
          for (const it of batch) markFail(it, msg);
        }
      }

      // ----- Finance batch upsert -----
      for (const batch of chunks(finances, BATCH_SIZE)) {
        const payloadItems = batch.map((it: any) => {
          const srcHash = norm(it.dbSourceHash) || computeFinanceHash(it);
          it.dbSourceHash = srcHash;
          const eid = norm(it.entryId);
          const cyc = norm((it as any).cycleId);
          return {
            record_date: String(it.recordDate),
            category_id: String(it.categoryId),
            amount: Number(it.amount ?? 0),
            note: (it.note ?? "").trim() || undefined,
            is_delete: !!it.isDelete,
            ...(eid ? { entry_id: eid } : {}),
            ...(cyc ? { cycle_id: cyc } : {}),
          };
        });

        try {
          // Split deletes to single-upsert to avoid backend batch UPDATE omissions on is_delete
          const upsertPayload: any[] = [];
          const upsertItems: any[] = [];
          const deletePayload: any[] = [];
          const deleteItems: any[] = [];

          for (let i = 0; i < payloadItems.length; i++) {
            const pld: any = payloadItems[i];
            const it = batch[i];
            if (pld?.is_delete) {
              deletePayload.push(pld);
              deleteItems.push(it);
            } else {
              upsertPayload.push(pld);
              upsertItems.push(it);
            }
          }

          // 1) batch upsert for non-delete
          if (upsertPayload.length > 0) {
            const resp: any = await plugin.api.upsertFinanceRecordsBatch({ items: upsertPayload });
            const results: any[] = Array.isArray(resp?.results) ? resp.results : [];
            if (results.length === 0) {
              // ✅ 兼容后端未返回逐条 results 的情况：只要整体成功，就视为整批成功
              const ok = resp?.ok === true || (typeof resp?.failed === "number" && resp.failed === 0);
              if (ok) {
                for (const it of upsertItems) {
                  const srcHash = String(it.dbSourceHash || "");
                  markOk(it, srcHash);
                }
              } else {
                for (const it of upsertItems) {
                  markFail(it, "batch sync failed: empty results");
                }
              }
            } else {
              for (const r of results) {
                const idx = Number(r?.index);
                if (!Number.isFinite(idx) || idx < 0 || idx >= upsertItems.length) continue;
                const it = upsertItems[idx];
                const srcHash = String(it.dbSourceHash || "");
                if (r?.ok) markOk(it, srcHash);
                else markFail(it, String(r?.error || r?.message || "sync failed"));
              }
            }
          }

          // 2) single upsert for deletes (is_delete=true)
          if (deletePayload.length > 0) {
            for (let i = 0; i < deletePayload.length; i++) {
              const pld: any = deletePayload[i];
              const it = deleteItems[i];
              const srcHash = String(it.dbSourceHash || "");
              try {
                await plugin.api.upsertFinanceRecord(pld);
                markOk(it, srcHash);
              } catch (eOne) {
                const msg = (eOne as any)?.message ? String((eOne as any).message) : "sync failed";
                markFail(it, msg);
              }
            }
          }
        } catch (e) {
          console.warn("RSLatte auto sync finance batch failed", e);
          const msg = (e as any)?.message ? String((e as any).message) : "sync failed";
          for (const it of batch) markFail(it, msg);
        }
      }

      // ----- Health batch upsert -----
      for (const batch of chunks(healthItems, BATCH_SIZE)) {
        const payloadItems = batch.map((it: any) => {
          const srcHash = norm(it.dbSourceHash) || computeHealthHash(it);
          it.dbSourceHash = srcHash;
          const eid = norm(it.entryId);
          const row: any = {
            record_date: String(it.recordDate),
            metric_key: String(it.metricKey ?? "").trim(),
            period: String(it.period ?? "day").trim() || "day",
            value_str: String(it.valueStr ?? "").trim(),
            is_delete: !!it.isDelete,
          };
          if (eid) row.entry_id = eid;
          const cr = norm(it.cardRef);
          if (cr) row.card_ref = cr;
          const nt = norm(it.note);
          if (nt) row.note = nt;
          const ssh = norm(it.sleepStartHm);
          if (ssh) row.sleep_start_hm = ssh;
          const sfp = norm(it.sourceFilePath);
          if (sfp) row.source_file_path = sfp;
          const sl = it.sourceLineMain;
          if (sl !== undefined && sl !== null && Number.isFinite(Number(sl))) row.source_line_main = Number(sl);
          const cam = (it as any).createdAtMs;
          if (cam !== undefined && cam !== null && Number.isFinite(Number(cam))) row.created_at_ms = Number(cam);
          return row;
        });

        try {
          const upsertPayload: any[] = [];
          const upsertItems: any[] = [];
          const deletePayload: any[] = [];
          const deleteItems: any[] = [];

          for (let i = 0; i < payloadItems.length; i++) {
            const pld: any = payloadItems[i];
            const it = batch[i];
            if (pld?.is_delete) {
              deletePayload.push(pld);
              deleteItems.push(it);
            } else {
              upsertPayload.push(pld);
              upsertItems.push(it);
            }
          }

          if (upsertPayload.length > 0) {
            const resp: any = await plugin.api.upsertHealthRecordsBatch({ items: upsertPayload });
            const results: any[] = Array.isArray(resp?.results) ? resp.results : [];
            if (results.length === 0) {
              const ok = resp?.ok === true || (typeof resp?.failed === "number" && resp.failed === 0);
              if (ok) {
                for (const it of upsertItems) {
                  const srcHash = String(it.dbSourceHash || "");
                  markOk(it, srcHash);
                }
              } else {
                for (const it of upsertItems) {
                  markFail(it, "batch sync failed: empty results");
                }
              }
            } else {
              for (const r of results) {
                const idx = Number(r?.index);
                if (!Number.isFinite(idx) || idx < 0 || idx >= upsertItems.length) continue;
                const it = upsertItems[idx];
                const srcHash = String(it.dbSourceHash || "");
                if (r?.ok) markOk(it, srcHash);
                else markFail(it, String(r?.error || r?.message || "sync failed"));
              }
            }
          }

          if (deletePayload.length > 0) {
            for (let i = 0; i < deletePayload.length; i++) {
              const pld: any = deletePayload[i];
              const it = deleteItems[i];
              const srcHash = String(it.dbSourceHash || "");
              try {
                await plugin.api.upsertHealthRecord(pld);
                markOk(it, srcHash);
              } catch (eOne) {
                const msg = (eOne as any)?.message ? String((eOne as any).message) : "sync failed";
                markFail(it, msg);
              }
            }
          }
        } catch (e) {
          console.warn("RSLatte auto sync health batch failed", e);
          const msg = (e as any)?.message ? String((e as any).message) : "sync failed";
          for (const it of batch) markFail(it, msg);
        }
      }

      if (metaTouched) {
        // persist only once; recordRSLatte will write current active snapshots
        await plugin.recordRSLatte.flushActiveIndexes();
      }

      // ✅ 状态灯：分别记录 checkin/finance 的 pending/failed（不持久化）
      // 注意：自动 tick 只同步 cutoff 范围内，因此 pending/failed 计数也仅统计 scope（避免把"范围外"的脏数据误报为待同步）。
      const countMeta = (items: any[], computeHash: (x: any) => string): { pending: number; failed: number } => {
        let failed = 0;
        let pending = 0;
        for (const it of items ?? []) {
          const st = String(it?.dbSyncState ?? "").trim();
          if (st === "failed") {
            failed++;
            continue;
          }
          // needsSync 会根据 hash/lastSynced 计算是否仍需同步
          if (needsSync(it, computeHash)) pending++;
        }
        return { pending, failed };
      };

      const ckCounts = countMeta(scopeCheckins, computeCheckinHash);
      const fiCounts = countMeta(scopeFinances, computeFinanceHash);
      const hiCounts = countMeta(scopeHealth, computeHealthHash);

      if (doCheckin) {
        (plugin as any).markDbSyncWithCounts("checkin", {
          pendingCount: ckCounts.pending,
          failedCount: ckCounts.failed,
          ok: ckCounts.failed === 0,
          err: ckCounts.failed > 0 ? "部分打卡记录入库失败（可刷新重试）" : undefined,
        });
      }
      if (doFinance) {
        (plugin as any).markDbSyncWithCounts("finance", {
          pendingCount: fiCounts.pending,
          failedCount: fiCounts.failed,
          ok: fiCounts.failed === 0,
          err: fiCounts.failed > 0 ? "部分财务记录入库失败（可刷新重试）" : undefined,
        });
      }
      if (doHealth) {
        (plugin as any).markDbSyncWithCounts("health", {
          pendingCount: hiCounts.pending,
          failedCount: hiCounts.failed,
          ok: hiCounts.failed === 0,
          err: hiCounts.failed > 0 ? "部分健康记录入库失败（可刷新重试）" : undefined,
        });
      }

      // 兼容旧 record 指标：聚合展示（若某模块未参与本次同步，则沿用该模块既有 meta 计数）
      const exCk: any = getDbSyncMeta()?.checkin ?? {};
      const exFi: any = getDbSyncMeta()?.finance ?? {};
      const exHi: any = getDbSyncMeta()?.health ?? {};
      const aggPending =
        (doCheckin ? ckCounts.pending : Number(exCk.pendingCount ?? 0)) +
        (doFinance ? fiCounts.pending : Number(exFi.pendingCount ?? 0)) +
        (doHealth ? hiCounts.pending : Number(exHi.pendingCount ?? 0));
      const aggFailed =
        (doCheckin ? ckCounts.failed : Number(exCk.failedCount ?? 0)) +
        (doFinance ? fiCounts.failed : Number(exFi.failedCount ?? 0)) +
        (doHealth ? hiCounts.failed : Number(exHi.failedCount ?? 0));
      (plugin as any).markDbSyncWithCounts("record", {
        pendingCount: aggPending,
        failedCount: aggFailed,
        ok: aggFailed === 0,
        err: aggFailed > 0 ? `errors=${aggFailed}` : undefined,
      });

      if (errCount > 0 && plugin.isDebugLogEnabled()) {
        plugin.dbg("autoRefresh", "record_db_sync_errors", { count: errCount, reason: opts?.reason });
      }
    },

    /**
     * 自动同步"打卡项清单/财务分类清单"到数据库。
     * - 仅在启用 DB 同步时触发
     * - 仅在内容变化后触发
     * 失败不会阻断插件使用。
     */
    async syncRecordListsToDb(mods?: { checkin?: boolean; finance?: boolean }): Promise<void> {
      if (!plugin.isRSLatteDbSyncEnabled()) return;

      const m = mods ?? { checkin: true, finance: true };
      const wantCheckin = m.checkin !== false;
      const wantFinance = m.finance !== false;
      const doCheckin = wantCheckin && plugin.isCheckinDbSyncEnabled();
      const doFinance = wantFinance && plugin.isFinanceDbSyncEnabled();
      if (!doCheckin && !doFinance) return;

      const key = JSON.stringify({
        c: doCheckin ? (plugin.settings.checkinItems ?? []) : [],
        f: doFinance ? (plugin.settings.financeCategories ?? []) : [],
      });
      if (key === getLastListsSyncKey()) return;

      // ✅ C0：先确保 vaultReadySafe（内部会判断 shouldTouchBackendNow）；不满足条件/失败则直接返回
      const vaultOk = await (plugin as any).vaultSvc?.ensureVaultReadySafe?.("syncRecordListsToDb");
      if (!vaultOk) return;

      // ✅ D9：DB Ready 检查统一走 VaultService（内部包含 shouldTouchBackendNow + ensureVaultReadySafe + warn 节流）
      const db = await (plugin as any).vaultSvc?.checkDbReadySafe?.("syncRecordListsToDb");
      if (!db.ok) return;

      const ck = doCheckin
        ? (plugin.settings.checkinItems ?? []).map((x) => {
            const base: any = {
              checkin_id: x.id,
              checkin_name: x.name,
              status: !!x.active,
            };
            const ms = buildCheckinTypeMetaSyncForDb(x as any);
            if (ms) base.meta_sync = ms;
            return base;
          })
        : [];

      const fin = doFinance
        ? (plugin.settings.financeCategories ?? []).map((x) => ({
            category_id: x.id,
            category_name: x.name,
            category_type: x.type,
            status: !!x.active,
            sub_categories: x.subCategories || [],
            institution_names: (Array.isArray((x as any).institutionNames) ? (x as any).institutionNames : [])
              .map((s: string) => String(s ?? "").trim())
              .filter(Boolean),
          }))
        : [];

      // 逐个接口调用，便于定位失败来源。失败不阻断插件使用，但会触发状态灯标红。
      // ✅ 严格检查：只有在 doCheckin 为 true 且 ck 数组非空时才调用 checkin 接口
      // ✅ 严格检查：只有在 doFinance 为 true 且 fin 数组非空时才调用 finance 接口
      try {
        if (doCheckin && ck.length > 0) {
          await plugin.api.upsertCheckinTypes(ck);
        }
        if (doFinance && fin.length > 0) {
          await plugin.api.upsertFinanceCategories(fin);
        }
      } catch (e: any) {
        const msg = e?.data?.detail?.message || e?.data?.reason || e?.message || String(e);
        plugin.setBackendDbReady(false, msg);
        console.warn(`RSLatte syncRecordListsToDb failed: ${msg}`);
        return;
      }

      // 仅在成功后更新 "last key"，避免失败时永远不再重试
      setLastListsSyncKey(key);
    },

    /**
     * ✅ Public: 立即触发一次"打卡/财务记录索引 -> DB 同步"。
     * - 用于设置页的"扫描重建索引"后，强制做一次全量检查入库。
     */
    async syncRecordIndexToDbNow(opts?: { reason?: string; modules?: { checkin?: boolean; finance?: boolean; health?: boolean } }): Promise<void> {
      await (plugin as any).autoSyncRecordIndexToDb?.(opts);
    },

    /**
     * ✅ Public: 立即触发一次"打卡项清单/财务分类清单 -> DB 同步"。
     * - force=true 时忽略内部 lastKey 判定，强制同步一次。
     */
    async syncRecordListsToDbNow(force = false, opts?: { modules?: { checkin?: boolean; finance?: boolean } }): Promise<void> {
      if (force) {
        setLastListsSyncKey("");
      }
      await (plugin as any).syncRecordListsToDb?.(opts?.modules);
    },

    /**
     * 当关闭 DB 同步时，用"中央索引"恢复今日记录快照到本地缓存（_today...Map）
     * 并同步 dailyState，保证侧边栏/弹窗仍可正常工作（含 note/amount 预填）。
     */
    async hydrateTodayFromRecordIndex(): Promise<void> {
      // moduleEnabled.record=false 时：不读取索引/不更新 dailyState（避免"关闭模块仍产生后台 IO"）
      if (!((plugin as any).isModuleEnabled?.("record") ?? false)) return;
      const todayKey = plugin.getTodayKey();
      await plugin.recordRSLatte.ensureReady();

      // reset day caches if day changed
      if (getTodayCheckinsKey() !== todayKey) {
        setTodayCheckinsKey(todayKey);
        setTodayCheckinsMap(new Map());
        setTodayCheckinsFetchedAt(0);
      }
      if (getTodayFinancesKey() !== todayKey) {
        setTodayFinancesKey(todayKey);
        setTodayFinancesMap(new Map());
        setTodayFinancesFetchedAt(0);
      }

      const st = plugin.getOrCreateTodayState();

      // ✅ 先清空今天的打卡状态，确保只显示今天实际有记录的项
      st.checkinsDone = {};

      try {
        const csnap = await plugin.recordRSLatte.getCheckinSnapshot(false);
        const todayItems = (csnap.items ?? []).filter((x) => String(x.recordDate) === todayKey);
        // rebuild map for today
        const checkinsMap = new Map<string, ApiCheckinRecord>();
        for (const it of todayItems) {
          const id = String(it.checkinId);
          checkinsMap.set(id, {
            id: 0,
            record_date: todayKey,
            checkin_id: id,
            note: it.note,
            is_delete: !!it.isDelete,
            created_at: new Date((it.tsMs ?? Date.now())).toISOString(),
          });
          // ✅ 只设置今天有记录且未删除的项为已打卡
          st.checkinsDone[id] = !it.isDelete;
        }
        setTodayCheckinsMap(checkinsMap);
        setTodayCheckinsFetchedAt(Date.now());
      } catch (e) {
        console.warn("RSLatte hydrateTodayFromRecordIndex (checkin) failed:", e);
      }

      // ✅ 先清空今天的财务状态，确保只显示今天实际有记录的项
      st.financeDone = {};

      try {
        const fsnap = await plugin.recordRSLatte.getFinanceSnapshot(false);
        const todayItems = (fsnap.items ?? []).filter((x) => String(x.recordDate) === todayKey);
        const financesMap = new Map<string, ApiFinanceRecord[]>();
        for (const it of todayItems) {
          const id = String(it.categoryId);
          const row: ApiFinanceRecord = {
            id: 0,
            record_date: todayKey,
            category_id: id,
            entry_id: String(it.entryId ?? "").trim() || undefined,
            cycle_id: String((it as any).cycleId ?? "").trim() || undefined,
            amount: Number(it.amount ?? 0),
            note: it.note,
            is_delete: !!it.isDelete,
            created_at: new Date((it.tsMs ?? Date.now())).toISOString(),
            updated_at: undefined,
          };
          const cur = financesMap.get(id) ?? [];
          cur.push(row);
          financesMap.set(id, cur);
        }
        for (const [id, rows] of financesMap.entries()) {
          rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
          st.financeDone[id] = rows.some((x) => !x.is_delete);
        }
        setTodayFinancesMap(financesMap);
        setTodayFinancesFetchedAt(Date.now());
      } catch (e) {
        console.warn("RSLatte hydrateTodayFromRecordIndex (finance) failed:", e);
      }
    },

    /**
     * 确保"今日打卡记录"已初始化到本地缓存。
     * - 插件启动时会调用一次。
     * - 侧边栏打开时也可调用，但只有在"从未初始化/跨天"时才会访问后端。
     */
    async ensureTodayCheckinsInitialized(opts?: { allowDb?: boolean }): Promise<void> {
      if (!((plugin as any).isModuleEnabled?.("record") ?? false)) return;

      // ✅ 启动/打开侧边栏阶段：允许强制只走本地索引，避免 URL 异常时触发网络报错。
      if (opts?.allowDb === false) {
        await (plugin as any).hydrateTodayFromRecordIndex?.();
        return;
      }

      // ✅ 仅由打卡模块自己的 DB Sync 开关决定是否访问后端
      if (!plugin.isCheckinDbSyncEnabled()) {
        await (plugin as any).hydrateTodayFromRecordIndex?.();
        return;
      }

      const todayKey = plugin.getTodayKey();
      const notLoadedYet = !getTodayCheckinsKey() || getTodayCheckinsFetchedAt() <= 0;
      const dayChanged = getTodayCheckinsKey() !== todayKey;
      if (notLoadedYet || dayChanged) {
        try {
          await (plugin as any).syncTodayCheckinsFromDb?.(true, 0);
        } catch (e) {
          // ✅ 后端不可用时降级：不阻断打卡功能
          console.warn("RSLatte syncTodayCheckinsFromDb failed, fallback to local index:", e);
          await (plugin as any).hydrateTodayFromRecordIndex?.();
        }
      }
    },

    /**
     * 插件启动/跨天时初始化一次
     */
    async ensureTodayFinancesInitialized(opts?: { allowDb?: boolean }): Promise<void> {
      if (!((plugin as any).isModuleEnabled?.("record") ?? false)) return;

      // ✅ 启动/打开侧边栏阶段：允许强制只走本地索引，避免 URL 异常时触发网络报错。
      if (opts?.allowDb === false) {
        await (plugin as any).hydrateTodayFromRecordIndex?.();
        return;
      }
      // ✅ finance 独立开关：即使 checkin 开启 DB sync，也不影响"财务功能"在 URL 异常/关闭时正常使用
      if (!plugin.isFinanceDbSyncEnabled()) {
        await (plugin as any).hydrateTodayFromRecordIndex?.();
        return;
      }
      const todayKey = plugin.getTodayKey();
      const notLoadedYet = !getTodayFinancesKey() || getTodayFinancesFetchedAt() <= 0;
      const dayChanged = getTodayFinancesKey() !== todayKey;
      if (notLoadedYet || dayChanged) {
        try {
          await (plugin as any).syncTodayFinancesFromDb?.(true, 0);
        } catch (e: any) {
          // 失败不阻断主流程：降级为本地索引
          plugin.setBackendDbReady(false, e?.message ?? String(e));
          await (plugin as any).hydrateTodayFromRecordIndex?.();
        }
      }
    },

    /**
     * 从数据库拉取"今日打卡记录"，并刷新侧边栏使用的 dailyState。
     * - 默认 30s 内不重复请求（可 force=true 强制刷新）。
     * - 失败不阻断主流程，但会写入 audit.log 便于排查。
     */
    async syncTodayCheckinsFromDb(force: boolean = false, minIntervalMs: number = 30_000): Promise<void> {
      if (!plugin.isRSLatteDbSyncEnabled()) {
        await (plugin as any).hydrateTodayFromRecordIndex?.();
        return;
      }
      const todayKey = plugin.getTodayKey();
      const now = Date.now();

      if (!force && getTodayCheckinsKey() === todayKey && (now - getTodayCheckinsFetchedAt()) < minIntervalMs) {
        return;
      }

      try {
        // ✅ 后台同步不弹 Notice（避免干扰）；仅在用户显式操作失败时弹窗
        // 后端接口使用 date_from/date_to 过滤；此处只拉取"今天"的记录。
        // include_deleted=true：需要区分 is_delete=true（取消打卡）与未打卡。
        // ⚠️ 注意：listCheckinRecords 返回结构为 { items: ApiCheckinRecord[] }
        const resp = await plugin.api.listCheckinRecords(todayKey, todayKey, true);
        const records = (resp as any)?.items ?? [];

        const map = new Map<string, ApiCheckinRecord>();
        // records 通常按 record_date DESC, id DESC（同一天：新记录在前）。
        // include_deleted=true 时，同一 checkin_id 可能同时存在 is_delete=true/false 的历史记录。
        // 这里必须"只取最新一条"，避免被旧记录覆盖。
        for (const r of (records || [])) {
          const k = String(r.checkin_id);
          if (!map.has(k)) map.set(k, r);
        }
        setTodayCheckinsMap(map);
        setTodayCheckinsKey(todayKey);
        setTodayCheckinsFetchedAt(now);

        // 刷新侧边栏状态（不落盘；每次打开都会以 DB 为准覆盖）
        const st = plugin.getOrCreateTodayState();
        st.checkinsDone = {};
        for (const [id, r] of map.entries()) {
          st.checkinsDone[id] = !r.is_delete;
        }
      } catch (e: any) {
        // 不要把错误显示成"插件崩溃"，只记录到审计方便排查
        await plugin.appendAuditLog({
          action: "SYNC_TODAY_CHECKINS_FAILED",
          record_date: todayKey,
          error: getSerializeErrorForAudit()?.(e),
        });
      }
    },

    /**
     * 从 DB 拉取今日财务记录，刷新 dailyState.financeDone
     */
    async syncTodayFinancesFromDb(force: boolean = false, minIntervalMs: number = 30_000): Promise<void> {
      if (!plugin.isFinanceDbSyncEnabled()) {
        await (plugin as any).hydrateTodayFromRecordIndex?.();
        return;
      }
      const todayKey = plugin.getTodayKey();
      const now = Date.now();

      if (!force && getTodayFinancesKey() === todayKey && (now - getTodayFinancesFetchedAt()) < minIntervalMs) {
        return;
      }

      try {
        const resp = await plugin.api.listFinanceRecords(todayKey, todayKey, true);
        const records = (resp as any)?.items ?? [];

        const byCat = new Map<string, Map<string, ApiFinanceRecord>>();
        for (const r of records || []) {
          const cat = String(r.category_id);
          const eid = String((r as any).entry_id ?? "").trim();
          const dedupeKey = eid || `idrow_${(r as any).id ?? Math.random()}`;
          const inner = byCat.get(cat) ?? new Map();
          if (!inner.has(dedupeKey)) inner.set(dedupeKey, r);
          byCat.set(cat, inner);
        }
        const map = new Map<string, ApiFinanceRecord[]>();
        for (const [cat, inner] of byCat.entries()) {
          const arr = Array.from(inner.values()).sort((a, b) =>
            String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""))
          );
          map.set(cat, arr);
        }

        setTodayFinancesMap(map);
        setTodayFinancesKey(todayKey);
        setTodayFinancesFetchedAt(now);

        const st = plugin.getOrCreateTodayState();
        st.financeDone = {};
        for (const [id, rows] of map.entries()) {
          st.financeDone[id] = (rows ?? []).some((x) => !x.is_delete);
        }
      } catch (e: any) {
        // ✅ 后端不可用：标记为不可用，并降级本地
        plugin.setBackendDbReady(false, e?.message ?? String(e));
        await plugin.appendAuditLog({
          action: "SYNC_TODAY_FINANCE_FAILED",
          record_date: todayKey,
          error: getSerializeErrorForAudit()?.(e),
        });
        await (plugin as any).hydrateTodayFromRecordIndex?.();
      }
    },

    /**
     * 侧边栏状态灯：展示某模块最近一次 DB 同步时间。
     */
    markDbSync(moduleKey: DbSyncModuleKey, ok: boolean, err?: string) {
      const at = new Date().toISOString();
      const meta = getDbSyncMeta();
      meta[moduleKey] = ok
        ? { status: "ok", at, pendingCount: 0, failedCount: 0 }
        : { status: "error", at, err: err || "", pendingCount: 0, failedCount: 0 };
    },

    /**
     * 带计数的状态更新（用于在侧边栏状态灯 tooltip 中展示 pending/failed 数量）
     */
    markDbSyncWithCounts(
      moduleKey: DbSyncModuleKey,
      meta: { pendingCount?: number; failedCount?: number; ok?: boolean; err?: string }
    ) {
      const at = new Date().toISOString();
      const pending = Number(meta.pendingCount ?? 0);
      const failed = Number(meta.failedCount ?? 0);
      const ok = meta.ok ?? (failed === 0);
      const dbSyncMeta = getDbSyncMeta();

      if (!ok || failed > 0) {
        dbSyncMeta[moduleKey] = { status: "error", at, err: meta.err || "", pendingCount: pending, failedCount: failed };
        return;
      }
      if (pending > 0) {
        dbSyncMeta[moduleKey] = { status: "pending", at, pendingCount: pending, failedCount: failed };
        return;
      }
      dbSyncMeta[moduleKey] = { status: "ok", at, pendingCount: 0, failedCount: 0 };
    },
  };
}
