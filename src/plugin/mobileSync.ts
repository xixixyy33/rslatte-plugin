/**
 * 手机端数据同步模块
 * - 从后端拉取手机（PWA）上传的操作记录
 * - 将打卡/财务写入今日日记与中央索引，任务/备忘按设计写入对应 MD
 * - 生成操作记录，事件来源为「手机」
 */
import { Notice, normalizePath } from "obsidian";
import type RSLattePlugin from "../main";
import type {
  MobileOp,
  MobileOpKind,
  MobileOpPayloadCheckin,
  MobileOpPayloadFinance,
  MobileOpPayloadMemo,
  MobileOpPayloadProject,
  MobileOpPayloadTask,
} from "../api";
import { moment } from "obsidian";
import { buildFinanceNoteWithSubcategory } from "../services/finance/financeSubcategory";
const momentFn = moment as any;

export function createMobileSync(plugin: RSLattePlugin) {
  return {
    /**
     * 从手机同步：拉取并应用操作记录
     * - 若 backend 配置了 mobile_sync_config：先 POST /mobile/sync/run-now（拉取 operator 入库、刷新 plugin_date、锁定 mobile）
     * - 调用 listMobileOps 获取后端记录的手机操作，依次应用并 mark-synced / report-sync-error
     * - 若此前调过 run-now：最后 POST /mobile/sync/complete（清空 operator、刷新 plugin_date、解锁 mobile）
     */
    async syncFromMobile(): Promise<{ applied: number; skipped: number; errors: string[] }> {
      const errors: string[] = [];
      let applied = 0;
      let skipped = 0;
      let jsonMode = false;

      const vaultOk = await (plugin as any).vaultSvc?.ensureVaultReadySafe?.("syncFromMobile");
      if (!vaultOk) {
        new Notice("无法连接后端，请检查网络与 API 配置");
        return { applied: 0, skipped: 0, errors: ["vault not ready"] };
      }

      try {
        const runResp = await plugin.api.mobileSyncRunNow();
        jsonMode = runResp?.ok === true;
      } catch (_) {
        // 未配置 mobile_sync 时忽略，走原有拉取 DB 流程
      }

      try {
        let resp: { ok: boolean; ops: MobileOp[] };
        try {
          resp = await plugin.api.listMobileOps({ limit: 200 });
        } catch (e: any) {
          const msg = e?.message ?? String(e);
          errors.push(msg);
          new Notice("拉取手机操作记录失败");
          return { applied: 0, skipped: 0, errors };
        }

        const ops = resp?.ops ?? [];
        if (ops.length === 0) {
          new Notice("暂无手机端新操作");
          return { applied: 0, skipped: 0, errors: [] };
        }

        const appliedIds: string[] = [];
        let appliedCheckin = false;
        let appliedFinance = false;
        let appliedTask = false;
        let appliedMemo = false;
        let appliedProject = false;

        for (const op of ops) {
          try {
            // 后端已置错（如 uid 重复）：不应用、不标记已同步，保持未同步队列以便手机端提示用户
            if ((op as MobileOp).plugin_sync_error) {
              skipped++;
              errors.push(`${op.kind}:${op.id} ${(op as MobileOp).plugin_sync_error}`);
              continue;
            }
            if (op.kind === "checkin") {
            const ok = await applyCheckinOp(plugin, op.payload as MobileOpPayloadCheckin, op.action);
            if (ok) { applied++; appliedCheckin = true; }
            else skipped++;
            appliedIds.push(op.id);
          } else if (op.kind === "finance") {
            const ok = await applyFinanceOp(plugin, op.payload as MobileOpPayloadFinance, op.action);
            if (ok) { applied++; appliedFinance = true; }
            else skipped++;
            appliedIds.push(op.id);
          } else if (op.kind === "task") {
            if (op.action === "create") {
              const result = await applyTaskOp(plugin, op);
              if (result.ok) {
                applied++;
                appliedTask = true;
                appliedIds.push(op.id);
              } else {
                skipped++;
                const msg = result.error ?? "创建失败，将下次重试";
                errors.push(`task:${op.id} ${msg}`);
                try { await plugin.api.reportMobileOpError(op.id, msg); } catch (_) {}
              }
            } else if (op.action === "update") {
              const ok = await applyTaskUpdateOp(plugin, op);
              if (ok) {
                applied++;
                appliedTask = true;
                appliedIds.push(op.id);
                await emitMobileWorkEvent(plugin, op);
              } else {
                skipped++;
                const msg = "未找到对应任务或应用失败，将下次重试";
                errors.push(`task:${op.id} ${msg}`);
                try { await plugin.api.reportMobileOpError(op.id, msg); } catch (_) {}
              }
            } else {
              // delete：仅写操作记录，不写日记
              await emitMobileWorkEvent(plugin, op);
              skipped++;
              appliedIds.push(op.id);
            }
          } else if (op.kind === "memo") {
            if (op.action === "create") {
              const result = await applyMemoCreateOp(plugin, op);
              if (result.ok) {
                applied++;
                appliedMemo = true;
                appliedIds.push(op.id);
                await emitMobileWorkEvent(plugin, op);
              } else {
                skipped++;
                const msg = result.error ?? "创建失败，将下次重试";
                errors.push(`memo:${op.id} ${msg}`);
                try { await plugin.api.reportMobileOpError(op.id, msg); } catch (_) {}
              }
            } else if (op.action === "update") {
              const ok = await applyMemoOp(plugin, op);
              if (ok) {
                applied++;
                appliedMemo = true;
                appliedIds.push(op.id);
                await emitMobileWorkEvent(plugin, op);
              } else {
                skipped++;
                const msg = "未找到对应备忘或应用失败，将下次重试";
                errors.push(`memo:${op.id} ${msg}`);
                try { await plugin.api.reportMobileOpError(op.id, msg); } catch (_) {}
              }
            } else {
              await emitMobileWorkEvent(plugin, op);
              skipped++;
              appliedIds.push(op.id);
            }
          } else if (op.kind === "project") {
            if (op.action === "upsert_item") {
              const ok = await applyProjectOp(plugin, op.payload as MobileOpPayloadProject);
              if (ok) {
                applied++;
                appliedProject = true;
                appliedIds.push(op.id);
              } else {
                skipped++;
                const msg = "未找到对应项目任务或应用失败，将下次重试";
                errors.push(`project:${op.id} ${msg}`);
                try {
                  await plugin.api.reportMobileOpError(op.id, msg);
                } catch (_) {}
              }
            } else {
              skipped++;
              appliedIds.push(op.id);
            }
          }
          } catch (e: any) {
            errors.push(`${op.kind}:${op.id} ${e?.message ?? String(e)}`);
          }
        }

        if (appliedIds.length > 0) {
          try {
            await plugin.api.markMobileOpsSynced(appliedIds);
          } catch (_) {
            // 后端未实现 mark-synced 或网络失败时忽略，下次仍会拉取到已处理项（仅冗余写入）
          }
        }

        // 同步完成后触发对应模块的索引刷新并入库，避免用户再手动刷新
        if (appliedCheckin || appliedFinance) {
          try {
            await (plugin as any).syncRecordIndexToDbNow?.({
              reason: "syncFromMobile",
              modules: { checkin: appliedCheckin, finance: appliedFinance },
            });
          } catch (e) {
            console.warn("RSLatte syncFromMobile: syncRecordIndexToDbNow failed", e);
          }
        }
        if (appliedTask || appliedMemo) {
          try {
            const enableDbSync = (plugin as any).isTaskDbSyncEnabledV2?.() ?? (plugin as any).isMemoDbSyncEnabledV2?.() ?? true;
            await (plugin as any).taskRSLatte?.refreshIndexAndSync?.({
              sync: !!enableDbSync,
              noticeOnError: false,
            });
          } catch (e) {
            console.warn("RSLatte syncFromMobile: taskRSLatte.refreshIndexAndSync failed", e);
          }
        }
        if (appliedProject) {
          try {
            await (plugin as any).projectMgr?.markIndexProjectsDirtyAndRefresh?.();
          } catch (e) {
            console.warn("RSLatte syncFromMobile: projectMgr.markIndexProjectsDirtyAndRefresh failed", e);
          }
        }

        // 从 DB 刷新今日打卡/财务状态（含手机已写入 DB 的数据）
        try {
          await (plugin as any).syncTodayCheckinsFromDb?.(true, 0);
          await (plugin as any).syncTodayFinancesFromDb?.(true, 0);
        } catch (_) {
          await (plugin as any).hydrateTodayFromRecordIndex?.();
        }

        plugin.refreshSidePanel();
        if (applied > 0) {
          new Notice(`已同步 ${applied} 条手机操作${errors.length ? "，部分失败" : ""}`);
        }
        return { applied, skipped, errors };
      } finally {
        if (jsonMode) {
          try {
            await plugin.api.mobileSyncComplete();
          } catch (_) {
            errors.push("解锁 mobile 失败，请稍后在手机端重试同步");
          }
        }
      }
    },
  };
}

async function applyCheckinOp(
  plugin: RSLattePlugin,
  p: MobileOpPayloadCheckin,
  action: string
): Promise<boolean> {
  const dateKey = (p.record_date || plugin.getTodayKey()).slice(0, 10);
  if (!dateKey || !p.checkin_id) return false;

  await plugin.recordRSLatte?.ensureReady();
  await plugin.recordRSLatte?.upsertCheckinRecord({
    recordDate: dateKey,
    checkinId: p.checkin_id,
    checkinName: (plugin.settings.checkinItems ?? []).find((x: any) => x.id === p.checkin_id)?.name ?? p.checkin_id,
    note: p.note,
    isDelete: !!p.is_delete,
    tsMs: Date.now(),
  });

  const name = (plugin.settings.checkinItems ?? []).find((x: any) => x.id === p.checkin_id)?.name ?? p.checkin_id;
  const timeStr = momentFn().format("HH:mm");
  const mark = p.is_delete ? "❌" : "✅";
  const line = `- ${dateKey} ${timeStr} ${p.checkin_id} ${name} ${mark}${p.note ? " " + p.note : ""}`;
  await (plugin as any).appendJournalByModule?.("checkin", dateKey, [line]);

  await emitMobileWorkEvent(plugin, {
    id: "",
    ts: new Date().toISOString(),
    kind: "checkin",
    action: p.is_delete ? "delete" : "create",
    payload: p,
  }, { checkin_name: name, checkin_id: p.checkin_id, note: p.note });
  return true;
}

async function applyFinanceOp(
  plugin: RSLattePlugin,
  p: MobileOpPayloadFinance,
  action: string
): Promise<boolean> {
  const dateKey = (p.record_date || plugin.getTodayKey()).slice(0, 10);
  if (!dateKey || !p.category_id) return false;

  const subCategory = (p.sub_category != null && String(p.sub_category).trim() !== "") ? String(p.sub_category).trim() : "";
  const noteOnly = (p.note != null && String(p.note).trim() !== "") ? String(p.note).trim() : "";
  const noteToStore = buildFinanceNoteWithSubcategory(subCategory, noteOnly) || undefined;

  await plugin.recordRSLatte?.ensureReady();
  const cat = (plugin.settings.financeCategories ?? []).find((c: any) => c.id === p.category_id);
  const type = (cat as any)?.type === "income" ? "income" : "expense";
  await plugin.recordRSLatte?.upsertFinanceRecord({
    recordDate: dateKey,
    categoryId: p.category_id,
    amount: Number(p.amount ?? 0),
    note: noteToStore,
    isDelete: !!p.is_delete,
    tsMs: Date.now(),
  });

  const timeStr = momentFn().format("HH:mm");
  const safeCatName = String(cat?.name ?? p.category_id).trim().replace(/\s+/g, "");
  const subCatBracket = subCategory ? `【${subCategory}】` : "";
  const noteField = subCatBracket ? (noteOnly ? `${subCatBracket} ${noteOnly}` : subCatBracket) : (noteOnly || "-");
  const amountNum = Number(p.amount ?? 0);
  const isDelete = !!p.is_delete;
  const signedForDisplay = type === "income" ? Math.abs(amountNum) : -Math.abs(amountNum);
  const line = isDelete
    ? `- ❌ ${dateKey} ${timeStr} ${type} ${p.category_id} ${safeCatName || p.category_id} ${noteField} ${Math.abs(amountNum).toFixed(2)}`
    : `- ${dateKey} ${type} ${p.category_id} ${safeCatName || p.category_id} ${noteField} ${signedForDisplay >= 0 ? "+" : ""}${signedForDisplay.toFixed(2)}`;
  await (plugin as any).appendJournalByModule?.("finance", dateKey, [line]);

  await emitMobileWorkEvent(plugin, {
    id: "",
    ts: new Date().toISOString(),
    kind: "finance",
    action: p.is_delete ? "delete" : "create",
    payload: p,
  }, { category_id: p.category_id, category_name: cat?.name ?? p.category_id, amount: p.amount, record_date: dateKey });
  return true;
}

/** 应用手机端项目任务 upsert_item：更新 vault 中对应项目任务清单 MD 的任务状态 */
async function applyProjectOp(
  plugin: RSLattePlugin,
  p: MobileOpPayloadProject
): Promise<boolean> {
  const item = p?.item;
  if (!item || (item.item_type || "").toLowerCase() !== "task") return false;
  const path = (item.source_file_path || "").trim();
  if (!path) return false;
  const folderPath = normalizePath(path.replace(/\/[^/]+$/, ""));
  const taskId = (item.item_id || "").trim();
  const lineNo = typeof item.source_line === "number" ? item.source_line : undefined;
  const raw = String((item.status || "TODO") ?? "").trim().toUpperCase().replace("-", "_");
  const status: "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED" =
    raw === "DONE" ? "DONE" : raw === "CANCELLED" ? "CANCELLED" : raw === "IN_PROGRESS" ? "IN_PROGRESS" : "TODO";
  try {
    await (plugin as any).projectMgr?.setProjectTaskStatus?.(folderPath, { taskId, lineNo }, status);
    return true;
  } catch (_) {
    return false;
  }
}

/** 手机端 task update：写回描述/到期/开始/计划日期，并应用 status 到 vault（与侧边栏一致） */
async function applyTaskUpdateOp(plugin: RSLattePlugin, op: MobileOp): Promise<boolean> {
  if (op.kind !== "task" || op.action !== "update") return false;
  const p = op.payload as MobileOpPayloadTask;
  const uid = String(p?.uid ?? "").trim();
  if (!uid) return false;
  const taskRSLatte = (plugin as any).taskRSLatte;
  if (!taskRSLatte?.store?.readIndex) return false;
  await taskRSLatte.ensureReady();
  const idx = await taskRSLatte.store.readIndex("task");
  const items = (idx?.items ?? []) as any[];
  const it = items.find((x) => String((x as any)?.uid ?? "").trim() === uid);
  if (!it) return false;

  const text = String(p?.text ?? "").trim();
  const dueDate = String(p?.due_date ?? "").trim().slice(0, 10);
  const startDate = (p?.start_date ?? "").toString().trim().slice(0, 10) || undefined;
  const scheduledDate = (p?.scheduled_date ?? "").toString().trim().slice(0, 10) || undefined;
  const hasValidDue = /^\d{4}-\d{2}-\d{2}$/.test(dueDate);
  const hasValidTextAndDue = text && hasValidDue;
  if (hasValidTextAndDue && taskRSLatte.updateTaskBasicInfo) {
    const start = startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? startDate : undefined;
    const scheduled = scheduledDate && /^\d{4}-\d{2}-\d{2}$/.test(scheduledDate) ? scheduledDate : undefined;
    await taskRSLatte.updateTaskBasicInfo(it, {
      text,
      due: dueDate,
      start,
      scheduled,
    }, { skipWorkEvent: true });
  }

  const rawStatus = (p.status ?? "").toString().trim();
  if (rawStatus && taskRSLatte.applyTaskStatusAction) {
    const to = normaliseTaskStatusToAction(rawStatus);
    await taskRSLatte.applyTaskStatusAction(it, to);
  }

  return true;
}

function normaliseTaskStatusToAction(s: string): "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED" {
  const u = s.toUpperCase();
  if (u === "TODO") return "TODO";
  if (u === "IN_PROGRESS" || u === "INPROGRESS") return "IN_PROGRESS";
  if (u === "DONE") return "DONE";
  if (u === "CANCELLED" || u === "CANCELED") return "CANCELLED";
  return "TODO";
}

const UID_EXISTS_MSG = "条目 uid 已存在，请前往 Obsidian 检查该条数据异常原因";

/** 手机端 memo create：从 payload 取 text、memo_date、repeat_rule、meta_extra，写入当日日记的「新增备忘」。返回 { ok, error? } 供同步循环统一上报。 */
async function applyMemoCreateOp(plugin: RSLattePlugin, op: MobileOp): Promise<{ ok: boolean; error?: string }> {
  if (op.kind !== "memo" || op.action !== "create") return { ok: false };
  const p = op.payload as MobileOpPayloadMemo & { repeat_rule?: string; meta_extra?: Record<string, string | number | boolean | undefined | null> };
  const text = String(p?.text ?? "").trim();
  if (!text) return { ok: false, error: "创建失败，将下次重试" };
  const today = plugin.getTodayKey().slice(0, 10);
  const memoDateRaw = String(p?.memo_date ?? today).trim();
  const memoDate = memoDateRaw || today;
  const isMmdd = /^\d{2}-\d{2}$/.test(memoDate);
  const isYmd = /^\d{4}-\d{2}-\d{2}$/.test(memoDate);
  if (!isMmdd && !isYmd) return { ok: false, error: "创建失败，将下次重试" };
  const taskRSLatte = (plugin as any).taskRSLatte;
  if (!taskRSLatte?.createTodayMemo) return { ok: false, error: "创建失败，将下次重试" };
  const payloadUid = String((p as any)?.uid ?? (p as any)?.id ?? "").trim();
  if (payloadUid && taskRSLatte.store?.readIndex) {
    await taskRSLatte.ensureReady();
    const idx = await taskRSLatte.store.readIndex("memo");
    const items = (idx?.items ?? []) as Array<{ uid?: string; id?: string }>;
    if (items.some((m) => String(m?.uid ?? m?.id ?? "").trim() === payloadUid)) {
      return { ok: false, error: UID_EXISTS_MSG };
    }
  }
  const repeatRule = (p?.repeat_rule != null && String(p.repeat_rule).trim())
    ? String(p.repeat_rule).trim().toLowerCase()
    : undefined;
  const metaExtra = p?.meta_extra != null && typeof p.meta_extra === "object"
    ? p.meta_extra
    : undefined;
  try {
    await taskRSLatte.createTodayMemo(text, memoDate, repeatRule, metaExtra);
    return { ok: true };
  } catch (_) {
    return { ok: false, error: "创建失败，将下次重试" };
  }
}

/** 手机端 memo update：按 uid 在索引中查找备忘，写回 text/日期/重复规则，并应用 status 到 vault（与侧边栏一致） */
async function applyMemoOp(plugin: RSLattePlugin, op: MobileOp): Promise<boolean> {
  if (op.kind !== "memo" || op.action !== "update") return false;
  const p = op.payload as MobileOpPayloadMemo & { uid?: string; status?: string };
  const uid = String(p?.uid ?? "").trim();
  const text = String(p?.text ?? "").trim();
  const statusRaw = (p?.status ?? "").toString().trim();
  if (!uid || (!text && !statusRaw)) return false;
  const taskRSLatte = (plugin as any).taskRSLatte;
  if (!taskRSLatte?.store?.readIndex || !taskRSLatte?.updateMemoBasicInfo) return false;
  await taskRSLatte.ensureReady();
  const idx = await taskRSLatte.store.readIndex("memo");
  const items = (idx?.items ?? []) as any[];
  const it = items.find((x) => String((x as any)?.uid ?? "").trim() === uid);
  if (!it) return false;

  const memoDate = String(p.memo_date ?? (p as any).meta_extra?.next ?? "").trim();
  const isYmd = /^\d{4}-\d{2}-\d{2}$/.test(memoDate);
  const isMmdd = /^\d{2}-\d{2}$/.test(memoDate);
  if (text && (isYmd || isMmdd)) {
    const repeatRule = String((p as any).repeat_rule ?? "").trim().toLowerCase() || undefined;
    const metaExtra = (p as any).meta_extra != null && typeof (p as any).meta_extra === "object"
      ? (p as any).meta_extra as Record<string, string | number | boolean | undefined | null>
      : undefined;
    await taskRSLatte.updateMemoBasicInfo(it, {
      text,
      memoDate,
      repeatRule,
      metaExtra,
    }, { skipWorkEvent: true });
  }

  if (statusRaw && taskRSLatte.applyMemoStatusAction) {
    const to = normaliseTaskStatusToAction(statusRaw);
    await taskRSLatte.applyMemoStatusAction(it, to, { skipWorkEvent: true });
  }

  try {
    await taskRSLatte.refreshIndexAndSync?.({ sync: false, noticeOnError: false });
  } catch (_) {
    // 索引稍后会被其它流程刷新
  }
  return true;
}

/** 将手机端 task create 写入当日日记（调用 createTodayTask），并记一条来源为手机的 event。返回 { ok, error? } 供同步循环统一上报。 */
async function applyTaskOp(plugin: RSLattePlugin, op: MobileOp): Promise<{ ok: boolean; error?: string }> {
  if (op.kind !== "task" || op.action !== "create") return { ok: false };
  const p = op.payload as MobileOpPayloadTask;
  const text = (p?.text ?? "").trim();
  if (!text) return { ok: false, error: "创建失败，将下次重试" };
  const today = plugin.getTodayKey().slice(0, 10);
  const due = (p.due_date ?? today).toString().trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return { ok: false, error: "创建失败，将下次重试" };
  const start = (p.start_date ?? "").toString().trim().slice(0, 10) || undefined;
  const scheduled = (p.scheduled_date ?? "").toString().trim().slice(0, 10) || undefined;
  if (start && !/^\d{4}-\d{2}-\d{2}$/.test(start)) return { ok: false, error: "创建失败，将下次重试" };
  if (scheduled && !/^\d{4}-\d{2}-\d{2}$/.test(scheduled)) return { ok: false, error: "创建失败，将下次重试" };
  const taskRSLatte = (plugin as any).taskRSLatte;
  if (!taskRSLatte?.createTodayTask) return { ok: false, error: "创建失败，将下次重试" };
  const payloadUid = String((p as any)?.uid ?? (p as any)?.id ?? "").trim();
  if (payloadUid && taskRSLatte.store?.readIndex) {
    await taskRSLatte.ensureReady();
    const idx = await taskRSLatte.store.readIndex("task");
    const items = (idx?.items ?? []) as Array<{ uid?: string; id?: string }>;
    if (items.some((t) => String(t?.uid ?? t?.id ?? "").trim() === payloadUid)) {
      return { ok: false, error: UID_EXISTS_MSG };
    }
  }
  await taskRSLatte.createTodayTask(text, due, start, scheduled, {
    source: "mobile",
    mobile_op_id: op.id,
  });
  return { ok: true };
}

async function emitMobileWorkEvent(
  plugin: RSLattePlugin,
  op: MobileOp,
  extraRef?: Record<string, unknown>
): Promise<void> {
  const kind = op.kind as "checkin" | "finance" | "task" | "memo";
  const action = (op.action === "create" ? "create" : op.action === "update" ? "update" : "delete") as any;
  const payload = op.payload as Record<string, unknown>;
  let summary: string;
  if (kind === "checkin") {
    const name = (extraRef?.checkin_name as string) ?? (payload.checkin_id as string);
    const note = (extraRef?.note as string) ?? (payload.note as string);
    summary = action === "delete"
      ? `❌ 取消打卡 ${name}${note ? " - " + note : ""}`.trim()
      : `✅ 打卡 ${name}${note ? " - " + note : ""}`.trim();
  } else if (kind === "finance") {
    const catName = (extraRef?.category_name as string) ?? (payload.category_id as string);
    const amount = payload.amount ?? extraRef?.amount;
    const dateKey = (extraRef?.record_date as string) ?? (payload.record_date as string) ?? "";
    summary = action === "delete"
      ? `❌ 取消账单 ${catName} ${amount}（日期：${dateKey}）`
      : `💰 新增账单 ${catName} ${Number(amount ?? 0)}`;
  } else if (kind === "task") {
    const t = (payload.text ?? extraRef?.text ?? "") as string;
    const short = t.length > 80 ? t.slice(0, 80) + "…" : t;
    if (action === "create") summary = `📝 新建任务 ${t || "(无描述)"}`;
    else if (action === "update") summary = `✏️ 修改任务 ${short || "(无描述)"}`;
    else summary = `❌ 删除任务 ${short || "(无描述)"}`;
  } else if (kind === "memo") {
    const t = (payload.text ?? "") as string;
    const short = t.length > 80 ? t.slice(0, 80) + "…" : t;
    if (action === "create") summary = `新建备忘 ${short || "(无描述)"}`;
    else if (action === "update") summary = `修改备忘 ${short || "(无描述)"}`;
    else summary = `删除备忘 ${short || "(无描述)"}`;
  } else {
    summary = `${kind} ${op.action}`;
  }
  try {
    await plugin.workEventSvc?.append?.({
      ts: op.ts,
      kind,
      action,
      ref: { mobile_op_id: op.id, ...payload, ...extraRef },
      summary,
      source: "mobile",
    });
  } catch (_) {
    // ignore
  }
}
