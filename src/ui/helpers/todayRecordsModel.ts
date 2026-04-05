import { moment, normalizePath } from "obsidian";
import type RSLattePlugin from "../../main";
import { readFinanceAlertsSnapshot, type FinanceAlertSnapshotItem } from "../../services/finance/financeAnalysisIndex";
import { checkinDifficultyEmojiOnly } from "../../types/rslatteTypes";
import type { CheckinRecordIndexItem, FinanceRecordIndexItem } from "../../types/recordIndexTypes";
import type { JournalPanel } from "../../types/rslatteTypes";
import { healthMainLineValueDisplay, healthMetricLabelZh } from "../../types/healthTypes";
import { inferCardRefFromItem, parseDayCardRef } from "../../services/health/healthCardRef";
import {
  HEALTH_CANONICAL_DAY_KEYS,
  normalizeIndexMetricKeyToCanonical,
  readHealthMetricsEnabledForUi,
} from "../../services/health/healthCanonicalMetrics";

/** 忽略空白符；整行仅为 Markdown 分隔线 `---` 的行不计入字数 */
export function countJournalMeaningfulChars(raw: string): number {
  const lines = String(raw ?? "").split("\n");
  const kept: string[] = [];
  for (const ln of lines) {
    const t = ln.trim();
    if (!t) continue;
    if (/^-{3,}$/.test(t)) continue;
    kept.push(ln);
  }
  return kept.join("\n").replace(/\s/g, "").length;
}

function isEmptyPoolFinanceAlert(title: string, message: string): boolean {
  const s = `${title}\n${message}`;
  return s.includes("数据池为空") || s.includes("规则依赖数据池为空");
}

function severityLabel(sev: FinanceAlertSnapshotItem["severity"]): string {
  if (sev === "high") return "高";
  if (sev === "warning") return "警示";
  return "提示";
}

const momentFn = moment as any;

/** 索引写入/更新时间戳对应的本地日历 YYYY-MM-DD；无效则返回空串 */
function tsMsToLocalYmd(tsMs: number | undefined): string {
  const n = Number(tsMs);
  if (!Number.isFinite(n) || n <= 0) return "";
  const m = momentFn(n);
  return m.isValid() ? m.format("YYYY-MM-DD") : "";
}

/**
 * 财务告警的 detectedAt 多为 `toISOString()`（UTC）。用字符串 `startsWith(任务日)` 会与本地日历错位
 *（例如东八区 3/30 凌晨对应 UTC 仍为 3/29）。此处统一解析为「本地」YYYY-MM-DD 再与任务日比较。
 */
function financeAlertDetectedLocalYmd(detectedAtRaw: string): string {
  const s = String(detectedAtRaw ?? "").trim();
  if (!s) return "";
  const m = momentFn(s);
  if (m.isValid()) return m.format("YYYY-MM-DD");
  const head = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return head ? head[1] : "";
}

/** 「今日财务告警」：检测时刻落在任务日本地，或关联流水中含任务日账单（如月度超预算） */
function financeAlertRelevantToTaskDay(
  a: FinanceAlertSnapshotItem,
  taskTodayKey: string,
  entryDateById: Map<string, string>,
): boolean {
  if (financeAlertDetectedLocalYmd(a.detectedAt) === taskTodayKey) return true;
  const ids = a.relatedEntryIds;
  if (!Array.isArray(ids) || ids.length === 0) return false;
  for (const raw of ids) {
    const eid = String(raw ?? "").trim();
    if (!eid) continue;
    if (entryDateById.get(eid) === taskTodayKey) return true;
  }
  return false;
}

async function withJournalSpaceOverride<T>(plugin: RSLattePlugin, run: () => Promise<T>): Promise<T> {
  const currentSpaceId = plugin.getCurrentSpaceId();
  const spaces = (plugin.settings as any).spaces || {};
  const currentSpace = spaces[currentSpaceId];
  const spaceSnapshot = currentSpace?.settingsSnapshot || {};
  const spaceDiaryPath = spaceSnapshot.diaryPath;
  const spaceDiaryNameFormat = spaceSnapshot.diaryNameFormat;
  const spaceDiaryTemplate = spaceSnapshot.diaryTemplate;

  const originalPathOverride = (plugin.journalSvc as any)._diaryPathOverride;
  const originalFormatOverride = (plugin.journalSvc as any)._diaryNameFormatOverride;
  const originalTemplateOverride = (plugin.journalSvc as any)._diaryTemplateOverride;
  try {
    plugin.journalSvc.setDiaryPathOverride(
      spaceDiaryPath || null,
      spaceDiaryNameFormat || null,
      spaceDiaryTemplate || null
    );
    return await run();
  } finally {
    plugin.journalSvc.setDiaryPathOverride(originalPathOverride, originalFormatOverride, originalTemplateOverride);
  }
}

export type TodayRecordsCheckinStatusRow = {
  id: string;
  name: string;
  done: boolean;
  difficultyEmoji: string;
  streak: number;
};

export type TodayRecordsCheckinRecordRow = {
  tag: "今日" | "补录";
  name: string;
  recordDate: string;
  checkinId: string;
};

export type TodayRecordsFinanceRecordRow = {
  tag: "今日" | "补录";
  categoryName: string;
  subcategory: string;
  type: "income" | "expense";
  amountAbs: number;
  displayDate: string;
  /** 有则今日记录卡片可跳转财务侧栏并高亮流水行 */
  entryId?: string;
};

export type TodayRecordsFinanceAlertRow = {
  severityLabel: string;
  title: string;
  message: string;
};

export type TodayRecordsHealthRecordRow = {
  tag: "今日" | "补录";
  metricLabel: string;
  metricKey: string;
  summaryLine: string;
  displayDate: string;
  entryId?: string;
};

export type TodayRecordsJournalPanelRow = {
  id: string;
  label: string;
  hasContent: boolean;
  charCount: number;
};

/** 今日记录页签顶部四灯：打卡/财务/健康 仅「今日」索引或 WorkEvent（不含补录）；日记为各面板有效字符合计 */
export type TodayRecordsStatusLights = {
  checkin: boolean;
  finance: boolean;
  health: boolean;
  journal: boolean;
};

export type TodayRecordsModel = {
  taskTodayKey: string;
  checkinEnabled: boolean;
  financeEnabled: boolean;
  healthEnabled: boolean;
  journalEnabled: boolean;
  /** 顶栏四状态灯（与列表卡片「今日/补录」标签一致） */
  statusLights: TodayRecordsStatusLights;
  checkinStatusRows: TodayRecordsCheckinStatusRow[];
  checkinRecords: TodayRecordsCheckinRecordRow[];
  financeHasExpense: boolean;
  financeHasIncome: boolean;
  financeRecords: TodayRecordsFinanceRecordRow[];
  financeAlerts: TodayRecordsFinanceAlertRow[];
  healthRecords: TodayRecordsHealthRecordRow[];
  /** 任务日已覆盖的日卡片指标数（与 HEALTH_DAY_CARD_METRICS 对齐） */
  healthDayDone: number;
  healthDayTotal: number;
  healthWaterGoalCups: number;
  journalPanelRows: TodayRecordsJournalPanelRow[];
  summary: {
    checkinDone: number;
    checkinTotal: number;
    financeExpenseN: number;
    financeIncomeN: number;
    financeExpenseSum: number;
    financeIncomeSum: number;
    healthDayDone: number;
    healthDayTotal: number;
    journalTotalChars: number;
    journalPanelChars: Array<{ id: string; label: string; count: number }>;
  };
};

function mergeFinanceIndexItems(rr: NonNullable<RSLattePlugin["recordRSLatte"]>): Promise<FinanceRecordIndexItem[]> {
  return (async () => {
    const active = await rr.getFinanceSnapshot(false);
    const arch = await rr.getFinanceSnapshot(true);
    const out: FinanceRecordIndexItem[] = [];
    const seen = new Set<string>();
    for (const it of [...(active.items ?? []), ...(arch.items ?? [])]) {
      const x = it as FinanceRecordIndexItem;
      const k = `${x.entryId ?? ""}|${x.recordDate}|${x.categoryId}|${x.type}|${x.amount}|${x.tsMs ?? 0}|${x.isDelete ? 1 : 0}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(x);
    }
    return out;
  })();
}

function mergeCheckinIndexItems(rr: NonNullable<RSLattePlugin["recordRSLatte"]>): Promise<CheckinRecordIndexItem[]> {
  return (async () => {
    const active = await rr.getCheckinSnapshot(false);
    const arch = await rr.getCheckinSnapshot(true);
    const out: CheckinRecordIndexItem[] = [];
    const seen = new Set<string>();
    for (const it of [...(active.items ?? []), ...(arch.items ?? [])]) {
      const x = it as CheckinRecordIndexItem;
      const k = `${x.recordDate}|${x.checkinId}|${x.tsMs ?? 0}|${x.isDelete ? 1 : 0}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(x);
    }
    return out;
  })();
}

/**
 * Today 侧栏「今日记录」子页签数据：打卡/财务/日记与底部摘要（任务日与索引一致）。
 */
export async function buildTodayRecordsModel(plugin: RSLattePlugin, taskTodayKey: string): Promise<TodayRecordsModel> {
  const checkinEnabled = plugin.isPipelineModuleEnabled("checkin");
  const financeEnabled = plugin.isPipelineModuleEnabled("finance");
  const healthEnabled = plugin.isHealthModuleEnabled();
  const journalEnabled = plugin.settings.showJournalPanels !== false;

  const todayState = plugin.getOrCreateTodayState();
  const activeCheckins = (plugin.settings.checkinItems ?? []).filter((x) => x.active);

  const checkinStatusRows: TodayRecordsCheckinStatusRow[] = activeCheckins.map((item: any) => ({
    id: String(item.id ?? ""),
    name: String(item.name ?? ""),
    done: !!todayState.checkinsDone[String(item.id)],
    difficultyEmoji: checkinDifficultyEmojiOnly(item.checkinDifficulty),
    streak: Math.max(0, Number(item.continuousDays ?? 0) || 0),
  }));

  const checkinDone = checkinStatusRows.filter((r) => r.done).length;
  const checkinTotal = checkinStatusRows.length;

  let checkinRecords: TodayRecordsCheckinRecordRow[] = [];
  let financeRecordsRows: TodayRecordsFinanceRecordRow[] = [];
  let financeHasExpense = false;
  let financeHasIncome = false;
  let financeAlerts: TodayRecordsFinanceAlertRow[] = [];
  let healthRecordsRows: TodayRecordsHealthRecordRow[] = [];
  let healthDayDone = 0;
  let healthDayTotal = HEALTH_CANONICAL_DAY_KEYS.length;
  const healthWaterGoalCups = Math.max(
    1,
    Math.min(30, Number((plugin.settings as any).healthPanel?.waterGoalCups) || 8),
  );

  const taskDiaryPathNorm = await withJournalSpaceOverride(plugin, async () =>
    normalizePath(plugin.journalSvc.buildDailyNotePathForDateKey(taskTodayKey))
  );

  if (plugin.recordRSLatte && checkinEnabled) {
    try {
      const nameById = new Map<string, string>();
      for (const c of activeCheckins) nameById.set(String((c as any).id), String((c as any).name ?? ""));

      const workEvOn = plugin.workEventSvc?.isEnabled?.() === true;
      const dayKeyOk = /^\d{4}-\d{2}-\d{2}$/.test(taskTodayKey);

      if (workEvOn && dayKeyOk) {
        const mday = momentFn(taskTodayKey, "YYYY-MM-DD", true);
        if (mday.isValid()) {
          const evts = await plugin.workEventSvc.readEventsByDateRange(
            mday.clone().startOf("day").toDate(),
            mday.clone().endOf("day").toDate(),
          );
          const tmp: Array<TodayRecordsCheckinRecordRow & { _ts: string }> = [];
          for (const e of evts) {
            if (e.kind !== "checkin" || e.action !== "create") continue;
            const ref = e.ref ?? {};
            if (ref.is_delete === true || e.metrics?.is_delete === true) continue;
            const recordDate = String(ref.record_date ?? ref.recordDate ?? "").trim();
            const checkinId = String(ref.checkin_id ?? ref.checkinId ?? "").trim();
            if (!recordDate || !checkinId) continue;
            const nm = String(ref.checkin_name ?? ref.checkinName ?? nameById.get(checkinId) ?? checkinId);
            const tag: "今日" | "补录" = recordDate === taskTodayKey ? "今日" : "补录";
            tmp.push({ tag, name: nm, recordDate, checkinId, _ts: e.ts });
          }
          tmp.sort((a, b) => a._ts.localeCompare(b._ts));
          checkinRecords = tmp.map(({ _ts: _t, ...r }) => r);
        }
      }

      if (!workEvOn) {
        const cItems = await mergeCheckinIndexItems(plugin.recordRSLatte);
        const rows: TodayRecordsCheckinRecordRow[] = [];
        for (const it of cItems) {
          if (it.isDelete) continue;
          if (it.recordDate !== taskTodayKey) continue;
          const nm = String(it.checkinName ?? nameById.get(String(it.checkinId)) ?? it.checkinId);
          rows.push({ tag: "今日", name: nm, recordDate: it.recordDate, checkinId: String(it.checkinId) });
        }
        rows.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans"));
        checkinRecords = rows;
      }
    } catch {
      checkinRecords = [];
    }
  }

  if (plugin.recordRSLatte && financeEnabled) {
    try {
      const catById = new Map<string, { name: string; type: string }>();
      for (const c of plugin.settings.financeCategories ?? []) {
        catById.set(String((c as any).id), { name: String((c as any).name ?? ""), type: String((c as any).type ?? "expense") });
      }

      const workEvOn = plugin.workEventSvc?.isEnabled?.() === true;
      const dayKeyOk = /^\d{4}-\d{2}-\d{2}$/.test(taskTodayKey);

      if (workEvOn && dayKeyOk) {
        const mday = momentFn(taskTodayKey, "YYYY-MM-DD", true);
        if (mday.isValid()) {
          const evts = await plugin.workEventSvc.readEventsByDateRange(
            mday.clone().startOf("day").toDate(),
            mday.clone().endOf("day").toDate(),
          );
          const tmp: Array<TodayRecordsFinanceRecordRow & { _ts: string }> = [];
          for (const e of evts) {
            if (e.kind !== "finance" || e.action !== "create") continue;
            const ref = e.ref ?? {};
            if (ref.is_delete === true || e.metrics?.is_delete === true) continue;
            const recordDate = String(ref.record_date ?? ref.recordDate ?? "").trim();
            const categoryId = String(ref.category_id ?? ref.categoryId ?? "").trim();
            if (!recordDate || !categoryId) continue;
            const amtRaw = Number(ref.amount ?? e.metrics?.amount ?? 0);
            const cat = catById.get(categoryId);
            const typeFromRef =
              ref.type === "income" || ref.type === "expense" ? (ref.type as "income" | "expense") : null;
            const type: "income" | "expense" = typeFromRef ?? (amtRaw >= 0 ? "income" : "expense");
            const categoryName = String(ref.category_name ?? ref.categoryName ?? cat?.name ?? categoryId);
            const sub = String(ref.subcategory ?? "").trim();
            const entryId = String(ref.entry_id ?? ref.entryId ?? "").trim();
            const tag: "今日" | "补录" = recordDate === taskTodayKey ? "今日" : "补录";
            const amountAbs = Math.abs(Number.isFinite(amtRaw) ? amtRaw : 0);
            const row: TodayRecordsFinanceRecordRow & { _ts: string } = {
              tag,
              categoryName,
              subcategory: sub,
              type,
              amountAbs,
              displayDate: recordDate,
              _ts: e.ts,
            };
            if (entryId) row.entryId = entryId;
            tmp.push(row);
          }
          tmp.sort((a, b) => a._ts.localeCompare(b._ts));
          financeRecordsRows = tmp.map(({ _ts: _t, ...r }) => r);
          for (const r of financeRecordsRows) {
            if (r.type === "expense") financeHasExpense = true;
            else financeHasIncome = true;
          }
        }
      }

      if (!workEvOn) {
        const fItems = await mergeFinanceIndexItems(plugin.recordRSLatte);
        const picked: FinanceRecordIndexItem[] = [];
        for (const it of fItems) {
          if (it.isDelete) continue;
          const fp = it.sourceFilePath ? normalizePath(String(it.sourceFilePath)) : "";
          const onTaskDayNote = fp && fp === taskDiaryPathNorm;
          if (it.recordDate === taskTodayKey || onTaskDayNote) {
            picked.push(it);
          }
        }
        picked.sort((a, b) => (a.tsMs ?? 0) - (b.tsMs ?? 0));

        for (const it of picked) {
          if (it.type === "expense") {
            financeHasExpense = true;
          } else {
            financeHasIncome = true;
          }

          const cat = catById.get(String(it.categoryId));
          const categoryName = String(it.categoryName ?? cat?.name ?? it.categoryId);
          const sub = String(it.subcategory ?? "").trim();
          const tag: "今日" | "补录" = it.recordDate === taskTodayKey ? "今日" : "补录";
          const eid = String(it.entryId ?? (it as any).entry_id ?? "").trim();
          const row: TodayRecordsFinanceRecordRow = {
            tag,
            categoryName,
            subcategory: sub,
            type: it.type,
            amountAbs: Math.abs(Number(it.amount) || 0),
            displayDate: it.recordDate,
          };
          if (eid) row.entryId = eid;
          financeRecordsRows.push(row);
        }
      }

      const financeEntryDatesByEntryId = new Map<string, string>();
      try {
        const allFin = await mergeFinanceIndexItems(plugin.recordRSLatte);
        for (const it of allFin) {
          if (it.isDelete) continue;
          const eid = String(it.entryId ?? (it as any).entry_id ?? "").trim();
          if (!eid) continue;
          const rd = String(it.recordDate ?? "").trim();
          if (rd) financeEntryDatesByEntryId.set(eid, rd);
        }
      } catch {
        // ignore
      }

      const monthKey = taskTodayKey.slice(0, 7);
      const alertSnap = await readFinanceAlertsSnapshot(plugin, "month", monthKey);
      const alertItems = (alertSnap?.items ?? []) as FinanceAlertSnapshotItem[];
      const todayAlerts: TodayRecordsFinanceAlertRow[] = [];
      for (const a of alertItems) {
        if (!financeAlertRelevantToTaskDay(a, taskTodayKey, financeEntryDatesByEntryId)) continue;
        if (a.status === "resolved" || a.status === "ignored") continue;
        if (isEmptyPoolFinanceAlert(a.title, a.message)) continue;
        todayAlerts.push({
          severityLabel: severityLabel(a.severity),
          title: a.title,
          message: a.message,
        });
      }
      financeAlerts = todayAlerts;
    } catch {
      financeRecordsRows = [];
      financeAlerts = [];
    }
  }

  if (healthEnabled && plugin.recordRSLatte) {
    try {
      const dayKeyOk = /^\d{4}-\d{2}-\d{2}$/.test(taskTodayKey);
      const hpPre = (plugin.settings as any).healthPanel ?? {};
      const enDay = readHealthMetricsEnabledForUi(hpPre);
      const dayMetricSet = new Set<string>();
      for (const k of HEALTH_CANONICAL_DAY_KEYS) {
        if (enDay[k]) dayMetricSet.add(k);
      }
      healthDayTotal = Math.max(1, dayMetricSet.size);

      if (dayKeyOk) {
        const snap = await plugin.recordRSLatte.getHealthSnapshot(false);
        const hp = (plugin.settings as any).healthPanel ?? {};
        const waterCupMl = Math.max(50, Math.min(2000, Number(hp.waterCupVolumeMl) || 500));
        const tmp: Array<TodayRecordsHealthRecordRow & { _ord: number; _sortTs: number }> = [];
        const covered = new Set<string>();
        let ord = 0;
        for (const it of snap.items ?? []) {
          if (it.isDelete) continue;
          const period = String(it.period ?? "day").trim().toLowerCase();
          if (period !== "day") continue;
          const cref = inferCardRefFromItem({
            recordDate: it.recordDate,
            period: it.period,
            cardRef: it.cardRef,
          });
          const dOnly = parseDayCardRef(cref);
          if (!dOnly || !/^\d{4}-\d{2}-\d{2}$/.test(dOnly)) continue;

          const isTodayCard = dOnly === taskTodayKey;
          const touchedToday = tsMsToLocalYmd(it.tsMs) === taskTodayKey;
          if (!isTodayCard && !touchedToday) continue;

          const tag: "今日" | "补录" = isTodayCard ? "今日" : "补录";

          const metricKey = String(it.metricKey ?? "").trim();
          const valDisp = String(it.valueStr ?? "").trim();
          const valShown = healthMainLineValueDisplay(metricKey, valDisp, { waterCupMl });
          const note = String(it.note ?? "").trim();
          const sleepHm = String(it.sleepStartHm ?? "").trim();
          const sleepExtra = metricKey === "sleep_hours" && sleepHm ? ` 入睡${sleepHm}` : "";
          const summaryLine =
            valDisp === "_" || valDisp === "." || valDisp === "—"
              ? `${healthMetricLabelZh(metricKey)}${note ? ` ${note}` : ""}`.trim()
              : `${healthMetricLabelZh(metricKey)} ${valShown}${sleepExtra}${note ? ` ${note}` : ""}`.trim();
          const entryId = String(it.entryId ?? "").trim();
          const ts = Number(it.tsMs);
          tmp.push({
            tag,
            metricKey,
            metricLabel: healthMetricLabelZh(metricKey),
            summaryLine: summaryLine || healthMetricLabelZh(metricKey),
            displayDate: dOnly,
            entryId: entryId || undefined,
            _ord: ord++,
            _sortTs: Number.isFinite(ts) ? ts : 0,
          });
          const dayCanon = normalizeIndexMetricKeyToCanonical(metricKey);
          if (isTodayCard && dayCanon && dayMetricSet.has(dayCanon)) covered.add(dayCanon);
        }
        tmp.sort((a, b) => {
          if (a.tag !== b.tag) return a.tag === "今日" ? -1 : 1;
          if (a.tag === "补录" && b.tag === "补录") return b._sortTs - a._sortTs;
          return a._ord - b._ord;
        });
        healthRecordsRows = tmp.map(({ _ord: _x, _sortTs: _s, ...r }) => r);
        healthDayDone = covered.size;
      }
    } catch {
      healthRecordsRows = [];
      healthDayDone = 0;
    }
  }

  let journalPanelRows: TodayRecordsJournalPanelRow[] = [];
  let journalTotalChars = 0;
  const journalPanelChars: Array<{ id: string; label: string; count: number }> = [];

  if (journalEnabled) {
    const panels: JournalPanel[] = plugin.settings.journalPanels ?? [];
    const fullTexts = await withJournalSpaceOverride(plugin, () =>
      plugin.journalSvc.readPanelsSectionFullTextForDateKey(taskTodayKey, panels)
    );
    for (const p of panels) {
      const id = String(p.id ?? "").trim();
      if (!id) continue;
      const label = String(p.label || p.heading || id).trim() || id;
      const text = fullTexts[id] ?? "";
      const charCount = countJournalMeaningfulChars(text);
      journalTotalChars += charCount;
      journalPanelChars.push({ id, label, count: charCount });
      journalPanelRows.push({
        id,
        label,
        hasContent: charCount > 0,
        charCount,
      });
    }
  }

  const statusLights: TodayRecordsStatusLights = {
    checkin: checkinEnabled && checkinRecords.some((r) => r.tag === "今日"),
    finance: financeEnabled && financeRecordsRows.some((r) => r.tag === "今日"),
    health: healthEnabled && healthRecordsRows.some((r) => r.tag === "今日"),
    journal: journalEnabled && journalTotalChars > 0,
  };

  return {
    taskTodayKey,
    checkinEnabled,
    financeEnabled,
    healthEnabled,
    journalEnabled,
    statusLights,
    checkinStatusRows,
    checkinRecords,
    financeHasExpense,
    financeHasIncome,
    financeRecords: financeRecordsRows,
    financeAlerts,
    healthRecords: healthRecordsRows,
    healthDayDone,
    healthDayTotal,
    healthWaterGoalCups,
    journalPanelRows,
    summary: {
      checkinDone,
      checkinTotal,
      financeExpenseN: financeRecordsRows.filter((r) => r.type === "expense").length,
      financeIncomeN: financeRecordsRows.filter((r) => r.type === "income").length,
      financeExpenseSum: financeRecordsRows.filter((r) => r.type === "expense").reduce((s, r) => s + r.amountAbs, 0),
      financeIncomeSum: financeRecordsRows.filter((r) => r.type === "income").reduce((s, r) => s + r.amountAbs, 0),
      healthDayDone,
      healthDayTotal,
      journalTotalChars,
      journalPanelChars,
    },
  };
}
