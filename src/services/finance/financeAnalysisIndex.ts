import { moment, normalizePath } from "obsidian";
import type {
  FinanceBudgetConfigFile,
  FinanceCyclePlanRow,
  FinanceDataPoolConfigFile,
  FinanceDataPoolItem,
  FinanceDataPoolNode,
} from "../../types/rslatteTypes";
import { fnv1a32 } from "../../utils/hash";
import { extractFinanceMeta, normalizeFinanceSubcategory } from "./financeSubcategory";
import { computeFinanceRuleAlertsForPeriodKey, readFinanceRulesAlertSnapshot } from "./financeRulesAnalysis";
import { validateFinanceRuleConfig } from "./financeRuleValidator";
import { rotateAnalysisSnapshotBeforeWrite, rollbackOneAnalysisSnapshot } from "../../utils/analysisSnapshotRotate";

const momentFn = moment as any;

export type FinanceAnalysisGrain = "day" | "week" | "month";

export type FinanceStatsSnapshotFile = {
  version: 1;
  generatedAt: string;
  spaceId: string;
  mode: string;
  grain: FinanceAnalysisGrain;
  periodKey: string;
  summary: {
    validCount: number;
    incomeTotal: number;
    expenseTotal: number;
    balance: number;
    budgetUsageRatio?: number;
    activeAlertCountBySeverity: { high: number; warning: number; notice: number };
  };
  poolStats: Record<string, number>;
  derivedMetrics: {
    cashflow_gap: number;
    surplus_rate?: number;
    free_expense_ratio?: number;
    essential_expense_ratio?: number;
  };
  alertSummary: {
    total: number;
    high: number;
    warning: number;
    notice: number;
  };
};

export type FinanceAlertSnapshotItem = {
  ruleId: string;
  algorithmId: string;
  severity: "high" | "warning" | "notice";
  title: string;
  message: string;
  effectivePeriod: string;
  detectedAt: string;
  relatedEntryIds?: string[];
  explain?: Record<string, unknown>;
  status: "new" | "ongoing" | "resolved" | "ignored";
  alertFingerprint: string;
};

export type FinanceAlertsSnapshotFile = {
  version: 1;
  generatedAt: string;
  spaceId: string;
  mode: string;
  grain: FinanceAnalysisGrain;
  periodKey: string;
  summary: {
    total: number;
    high: number;
    warning: number;
    notice: number;
  };
  statusSummary?: {
    new: number;
    ongoing: number;
    resolved: number;
    ignored: number;
  };
  items: FinanceAlertSnapshotItem[];
};

export type FinanceAnalysisIndexFile = {
  version: 1;
  generatedAt: string;
  spaceId: string;
  mode: string;
  latest: {
    grain: FinanceAnalysisGrain;
    periodKey: string;
    summary: FinanceStatsSnapshotFile["summary"];
    alertSummary: FinanceStatsSnapshotFile["alertSummary"];
  };
  snapshots: Array<{
    grain: FinanceAnalysisGrain;
    periodKey: string;
    statsRef: string;
    alertsRef: string;
    summary: FinanceStatsSnapshotFile["summary"];
    alertSummary: FinanceStatsSnapshotFile["alertSummary"];
  }>;
  activeAlerts: Array<{
    ruleId: string;
    title: string;
    severity: "high" | "warning" | "notice";
    effectivePeriod: string;
    detectedAt: string;
    alertFingerprint: string;
    status: "new" | "ongoing" | "resolved" | "ignored";
  }>;
  configHashes: {
    rules: string;
    pools: string;
    budget: string;
    cycle: string;
  };
};

async function ensureFolder(plugin: any, path: string): Promise<void> {
  const p = normalizePath(String(path ?? "").trim());
  if (!p) return;
  const exists = await plugin.app.vault.adapter.exists(p);
  if (exists) return;
  const parts = p.split("/");
  let cur = "";
  for (const seg of parts) {
    cur = cur ? `${cur}/${seg}` : seg;
    const ok = await plugin.app.vault.adapter.exists(cur);
    if (!ok) {
      try {
        await plugin.app.vault.createFolder(cur);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (msg.includes("Folder already exists") || msg.includes("EEXIST")) continue;
        throw e;
      }
    }
  }
}

function parseJsonSafe(raw: string): any | null {
  try {
    const j = JSON.parse(String(raw ?? ""));
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

async function readFinanceConfigFiles(plugin: any): Promise<{
  pool: FinanceDataPoolConfigFile | null;
  budget: FinanceBudgetConfigFile | null;
  rulesText: string;
  poolsText: string;
  budgetText: string;
}> {
  const root = String(plugin?.getSpaceIndexDir?.() ?? "").trim();
  if (!root) return { pool: null, budget: null, rulesText: "", poolsText: "", budgetText: "" };
  const cfgDir = normalizePath(`${root}/finance-config`);
  const poolPath = normalizePath(`${cfgDir}/finance-data-pools.json`);
  const budgetPath = normalizePath(`${cfgDir}/finance-budgets.json`);
  const rulesPath = normalizePath(`${cfgDir}/finance-rules.json`);

  const readOrEmpty = async (p: string) => {
    const ok = await plugin.app.vault.adapter.exists(p);
    if (!ok) return "";
    return String(await plugin.app.vault.adapter.read(p) ?? "");
  };

  const poolsText = await readOrEmpty(poolPath);
  const budgetText = await readOrEmpty(budgetPath);
  const rulesText = await readOrEmpty(rulesPath);

  const poolJ = parseJsonSafe(poolsText);
  const budgetJ = parseJsonSafe(budgetText);

  const pool: FinanceDataPoolConfigFile | null =
    poolJ && Number(poolJ.schema_version) === 1 && Array.isArray(poolJ.items)
      ? (poolJ as FinanceDataPoolConfigFile)
      : null;
  const budget: FinanceBudgetConfigFile | null =
    budgetJ && Number(budgetJ.schema_version) === 1 && Array.isArray(budgetJ.items)
      ? (budgetJ as FinanceBudgetConfigFile)
      : null;

  return { pool, budget, rulesText, poolsText, budgetText };
}

function isDeleted(r: any): boolean {
  return (
    r?.is_delete === true ||
    r?.isDelete === true ||
    String(r?.is_delete || r?.isDelete || "").toLowerCase() === "true"
  );
}

function normRecordDate(r: any): string {
  return String(r?.recordDate ?? r?.record_date ?? "").trim();
}

function normType(r: any): "income" | "expense" {
  return String(r?.type ?? "") === "income" ? "income" : "expense";
}

function normCatId(r: any): string {
  return String(r?.categoryId ?? r?.category_id ?? "").trim();
}

function normSubcategoryFromRecord(r: any): string {
  const parsed = extractFinanceMeta(String(r?.note ?? ""));
  return normalizeFinanceSubcategory(String(r?.subcategory ?? r?.subCategory ?? "")) || parsed.subcategory || "";
}

function normInstitutionFromRecord(r: any): string {
  const parsed = extractFinanceMeta(String(r?.note ?? ""));
  return String(parsed.institutionName || r?.institutionName || r?.institution_name || "").trim().replace(/\s+/g, " ");
}

function nodeMatch(r: any, node: FinanceDataPoolNode): boolean {
  const catId = normCatId(r);
  if (!catId || catId !== String(node.financeTypeId ?? "").trim()) return false;
  const sub = normSubcategoryFromRecord(r);
  const inst = normInstitutionFromRecord(r);
  const subs = (node as any).subCategories;
  const insts = (node as any).institutionNames;
  if (subs !== "ALL") {
    const arr = Array.isArray(subs) ? subs.map((x: any) => String(x ?? "").trim()) : [];
    if (!arr.includes(sub)) return false;
  }
  if (insts && insts !== "ALL") {
    const arr = Array.isArray(insts) ? insts.map((x: any) => String(x ?? "").trim().replace(/\s+/g, " ")) : [];
    if (!arr.includes(inst)) return false;
  }
  return true;
}

function filterRecordsByPool(records: any[], pool: FinanceDataPoolConfigFile | null, poolId: string): any[] {
  const pid = String(poolId ?? "").trim();
  if (!pid || !pool) return [];
  const item = (pool.items ?? []).find((x) => String((x as any)?.poolId ?? "").trim() === pid) as FinanceDataPoolItem | undefined;
  if (!item) return [];
  const nodes = Array.isArray((item as any).nodes) ? ((item as any).nodes as FinanceDataPoolNode[]) : [];
  if (!nodes.length) return [];
  return records.filter((r) => nodes.some((n) => nodeMatch(r, n)));
}

function inPeriod(recordDate: string, grain: FinanceAnalysisGrain, periodKey: string): boolean {
  if (!recordDate || !periodKey) return false;
  if (grain === "day") return recordDate === periodKey;
  if (grain === "week") {
    const m = momentFn(recordDate, "YYYY-MM-DD", true);
    if (!m.isValid()) return false;
    return m.format("GGGG-[W]WW") === periodKey;
  }
  return recordDate.startsWith(`${periodKey}-`) || recordDate.startsWith(periodKey);
}

function countSeverity(items: Array<{ severity?: string }>) {
  let high = 0;
  let warning = 0;
  let notice = 0;
  for (const it of items) {
    const s = String(it?.severity ?? "notice");
    if (s === "high") high++;
    else if (s === "warning") warning++;
    else notice++;
  }
  return { high, warning, notice };
}

function buildStatsSnapshot(args: {
  spaceId: string;
  mode: string;
  grain: FinanceAnalysisGrain;
  periodKey: string;
  periodRecords: any[];
  pool: FinanceDataPoolConfigFile | null;
  budget: FinanceBudgetConfigFile | null;
  alertSeverity: { high: number; warning: number; notice: number };
  alertCount: number;
}): FinanceStatsSnapshotFile {
  let validCount = 0;
  let incomeTotal = 0;
  let expenseTotal = 0;
  for (const r of args.periodRecords) {
    if (isDeleted(r)) continue;
    validCount++;
    const amt = Math.abs(Number(r?.amount ?? 0));
    if (!Number.isFinite(amt)) continue;
    if (normType(r) === "income") incomeTotal += amt;
    else expenseTotal += amt;
  }
  const balance = incomeTotal - expenseTotal;

  const poolStats: Record<string, number> = {};
  for (const p of args.pool?.items ?? []) {
    const poolId = String((p as any)?.poolId ?? "").trim();
    if (!poolId) continue;
    const rows = filterRecordsByPool(args.periodRecords, args.pool, poolId).filter((r) => !isDeleted(r));
    poolStats[poolId] = rows.reduce((sum, r) => sum + Math.abs(Number(r?.amount ?? 0) || 0), 0);
  }

  const freeExpense = Number(poolStats.DP_EXPENSE_FREE ?? 0);
  const essentialExpense = Number(poolStats.DP_EXPENSE_ESSENTIAL ?? 0);
  const totalBudget = (args.budget?.items ?? []).find((x: any) => String(x?.budgetId ?? "").trim() === "BUDGET_TOTAL_MONTH");
  const budgetAmount = Number(totalBudget?.amount ?? NaN);

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    spaceId: args.spaceId,
    mode: args.mode,
    grain: args.grain,
    periodKey: args.periodKey,
    summary: {
      validCount,
      incomeTotal,
      expenseTotal,
      balance,
      budgetUsageRatio: Number.isFinite(budgetAmount) && budgetAmount > 0 ? expenseTotal / budgetAmount : undefined,
      activeAlertCountBySeverity: { ...args.alertSeverity },
    },
    poolStats,
    derivedMetrics: {
      cashflow_gap: expenseTotal - incomeTotal,
      surplus_rate: incomeTotal > 0 ? (incomeTotal - expenseTotal) / incomeTotal : undefined,
      free_expense_ratio: incomeTotal > 0 ? freeExpense / incomeTotal : undefined,
      essential_expense_ratio: incomeTotal > 0 ? essentialExpense / incomeTotal : undefined,
    },
    alertSummary: {
      total: args.alertCount,
      high: args.alertSeverity.high,
      warning: args.alertSeverity.warning,
      notice: args.alertSeverity.notice,
    },
  };
}

function buildAlertFingerprint(item: any): string {
  const ruleId = String(item?.ruleId ?? "");
  const effectivePeriod = String(item?.effectivePeriod ?? "");
  const related = Array.isArray(item?.relatedEntryIds) ? item.relatedEntryIds.map((x: any) => String(x ?? "")).filter(Boolean).sort().join(",") : "";
  const key = `${ruleId}|${effectivePeriod}|${related}`;
  return fnv1a32(key);
}

function countStatus(items: Array<{ status?: string }>) {
  let nNew = 0;
  let ongoing = 0;
  let resolved = 0;
  let ignored = 0;
  for (const it of items) {
    const s = String(it?.status ?? "new");
    if (s === "ongoing") ongoing++;
    else if (s === "resolved") resolved++;
    else if (s === "ignored") ignored++;
    else nNew++;
  }
  return { new: nNew, ongoing, resolved, ignored };
}

function periodKeyByGrainFromAlert(item: any, grain: FinanceAnalysisGrain): string {
  const detectedAt = String(item?.detectedAt ?? "");
  const m = momentFn(detectedAt);
  if (!m.isValid()) return "";
  if (grain === "day") return m.format("YYYY-MM-DD");
  if (grain === "week") return m.format("GGGG-[W]WW");
  return String(item?.effectivePeriod ?? m.format("YYYY-MM"));
}

/** 仅写入单自然月的 stats + alerts（不含索引；供按需历史月与自动补上月）。 */
async function writeFinanceMonthAnalysisSnapshotsFiles(
  plugin: any,
  ctx: {
    baseDir: string;
    spaceId: string;
    mode: string;
    monthKey: string;
    allRecords: any[];
    pool: FinanceDataPoolConfigFile | null;
    budget: FinanceBudgetConfigFile | null;
    cyclePlans: FinanceCyclePlanRow[];
    rulesObj: Record<string, any>;
    backupBefore: boolean;
  },
): Promise<{
  statsRel: string;
  alertsRel: string;
  summary: FinanceStatsSnapshotFile["summary"];
  alertSummary: FinanceStatsSnapshotFile["alertSummary"];
} | null> {
  const { baseDir, spaceId, mode, monthKey, allRecords, pool, budget, cyclePlans, rulesObj, backupBefore } = ctx;
  const activeForRules = allRecords.filter((r: any) => !isDeleted(r));
  const periodAlertItems = computeFinanceRuleAlertsForPeriodKey({
    periodKey: monthKey,
    records: activeForRules,
    pool,
    budget,
    cyclePlans,
    rules: rulesObj,
  });
  const sev = countSeverity(periodAlertItems as any[]);
  const periodRecords = allRecords.filter((r: any) => inPeriod(normRecordDate(r), "month", monthKey));
  const statsSnapshot = buildStatsSnapshot({
    spaceId,
    mode: String(mode ?? ""),
    grain: "month",
    periodKey: monthKey,
    periodRecords,
    pool,
    budget,
    alertSeverity: sev,
    alertCount: periodAlertItems.length,
  });
  const statsRel = `snapshots/month/${monthKey}.stats.json`;
  const statsPath = normalizePath(`${baseDir}/${statsRel}`);
  const alertsRel = `snapshots/month/${monthKey}.alerts.json`;
  const alertsPath = normalizePath(`${baseDir}/${alertsRel}`);
  const adapter = plugin.app.vault.adapter;
  if (backupBefore) {
    await rotateAnalysisSnapshotBeforeWrite(adapter, statsPath);
    await rotateAnalysisSnapshotBeforeWrite(adapter, alertsPath);
  }
  await ensureFolder(plugin, normalizePath(`${baseDir}/snapshots/month`));
  await adapter.write(statsPath, JSON.stringify(statsSnapshot, null, 2));

  let prevItems: FinanceAlertSnapshotItem[] = [];
  try {
    const okPrev = await plugin.app.vault.adapter.exists(alertsPath);
    if (okPrev) {
      const rawPrev = await plugin.app.vault.adapter.read(alertsPath);
      const jp = parseJsonSafe(rawPrev);
      if (jp && Number(jp.version) === 1 && Array.isArray(jp.items)) {
        prevItems = jp.items as FinanceAlertSnapshotItem[];
      }
    }
  } catch {
    // ignore
  }
  const prevByFp = new Map<string, FinanceAlertSnapshotItem>();
  for (const p of prevItems) {
    const fp = String(p?.alertFingerprint ?? "").trim();
    if (fp) prevByFp.set(fp, p);
  }

  const currentAlertItems: FinanceAlertSnapshotItem[] = periodAlertItems.map((a: any) => {
    const fp = buildAlertFingerprint(a);
    const prev = prevByFp.get(fp);
    const prevStatus = String(prev?.status ?? "").trim();
    const status: FinanceAlertSnapshotItem["status"] =
      prevStatus === "ignored" ? "ignored" : prev ? "ongoing" : "new";
    return {
      ruleId: String(a.ruleId ?? ""),
      algorithmId: String(a.algorithmId ?? ""),
      severity: (String(a.severity ?? "notice") as any) as "high" | "warning" | "notice",
      title: String(a.title ?? a.ruleId ?? ""),
      message: String(a.message ?? ""),
      effectivePeriod: String(a.effectivePeriod ?? ""),
      detectedAt: String(a.detectedAt ?? ""),
      relatedEntryIds: Array.isArray(a.relatedEntryIds) ? a.relatedEntryIds.map((x: any) => String(x ?? "")).filter(Boolean) : undefined,
      explain: a.explain && typeof a.explain === "object" ? a.explain : undefined,
      status,
      alertFingerprint: fp,
    };
  });

  const currentFpSet = new Set<string>(currentAlertItems.map((x) => x.alertFingerprint));
  const resolvedItems: FinanceAlertSnapshotItem[] = [];
  for (const p of prevItems) {
    const fp = String(p?.alertFingerprint ?? "").trim();
    if (!fp || currentFpSet.has(fp)) continue;
    resolvedItems.push({
      ...p,
      status: "resolved",
      detectedAt: new Date().toISOString(),
      relatedEntryIds: Array.isArray(p.relatedEntryIds) ? p.relatedEntryIds : undefined,
    });
  }

  const alertItems: FinanceAlertSnapshotItem[] = [...currentAlertItems, ...resolvedItems];
  alertItems.sort((a, b) => {
    const rankStatus = (s: string) => (s === "new" ? 0 : s === "ongoing" ? 1 : s === "ignored" ? 2 : 3);
    const rankSeverity = (s: string) => (s === "high" ? 0 : s === "warning" ? 1 : 2);
    const rs = rankStatus(String(a.status)) - rankStatus(String(b.status));
    if (rs !== 0) return rs;
    return rankSeverity(String(a.severity)) - rankSeverity(String(b.severity));
  });

  const statusSummary = countStatus(alertItems);
  const alertsSnapshot: FinanceAlertsSnapshotFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    spaceId,
    mode: String(mode ?? ""),
    grain: "month",
    periodKey: monthKey,
    summary: {
      total: alertItems.length,
      high: sev.high,
      warning: sev.warning,
      notice: sev.notice,
    },
    statusSummary,
    items: alertItems,
  };
  await plugin.app.vault.adapter.write(alertsPath, JSON.stringify(alertsSnapshot, null, 2));
  return {
    statsRel,
    alertsRel,
    summary: statsSnapshot.summary,
    alertSummary: statsSnapshot.alertSummary,
  };
}

/** 按需写入指定月份（backupExisting 时按 Review 策略轮转，主文件 + bak1 + bak2 共 3 版）。不包含主索引写入。 */
export async function writeFinanceAnalysisSnapshotsForMonths(
  plugin: any,
  monthKeys: string[],
  mode: string,
  opts?: { backupExisting?: boolean },
): Promise<void> {
  const keys = [...new Set(monthKeys.map((k) => String(k).trim()).filter((k) => /^\d{4}-\d{2}$/.test(k)))].sort();
  if (!keys.length) return;
  const spaceId = String(plugin?.getSpaceCtx?.()?.spaceId ?? "default");
  const root = String(filterFinanceSpaceRoot(plugin) ?? "");
  if (!root) return;
  const baseDir = normalizePath(`${root}/finance-analysis`);
  await ensureFolder(plugin, baseDir);
  const { pool, budget, rulesText } = await readFinanceConfigFiles(plugin);
  const vr = validateFinanceRuleConfig({ ruleText: rulesText, pool, budget });
  const rulesObj = (vr.file?.rules ?? {}) as Record<string, any>;
  const cyclePlans = Array.isArray(plugin?.settings?.financeCyclePlans)
    ? (plugin.settings.financeCyclePlans as FinanceCyclePlanRow[])
    : [];
  const fsnapA = await plugin?.recordRSLatte?.getFinanceSnapshot?.(false);
  const fsnapB = await plugin?.recordRSLatte?.getFinanceSnapshot?.(true);
  const allRecords = [...(Array.isArray(fsnapA?.items) ? fsnapA.items : []), ...(Array.isArray(fsnapB?.items) ? fsnapB.items : [])];
  const backupBefore = opts?.backupExisting === true;
  for (const mk of keys) {
    await writeFinanceMonthAnalysisSnapshotsFiles(plugin, {
      baseDir,
      spaceId,
      mode,
      monthKey: mk,
      allRecords,
      pool,
      budget,
      cyclePlans,
      rulesObj,
      backupBefore,
    });
  }
}

function filterFinanceSpaceRoot(plugin: any): string {
  return String(plugin?.getSpaceIndexDir?.() ?? "").trim();
}

/** 自动刷新：若上一自然月快照缺失则补写（不扫全历史）。 */
export async function ensurePrevMonthFinanceSnapshotsIfMissing(plugin: any, mode: string): Promise<void> {
  const root = filterFinanceSpaceRoot(plugin);
  if (!root) return;
  const prev = momentFn().subtract(1, "month").format("YYYY-MM");
  const statsPath = normalizePath(`${root}/finance-analysis/snapshots/month/${prev}.stats.json`);
  const alertsPath = normalizePath(`${root}/finance-analysis/snapshots/month/${prev}.alerts.json`);
  const ad = plugin.app.vault.adapter;
  const hasStats = await ad.exists(statsPath);
  const hasAlerts = await ad.exists(alertsPath);
  if (hasStats && hasAlerts) return;
  await writeFinanceAnalysisSnapshotsForMonths(plugin, [prev], mode, { backupExisting: false });
}

/** stats / alerts 各回退一档（依赖 `.bak1.json` 链，与 Review 同为至多 3 版）。 */
export async function restoreFinanceMonthSnapshotsFromBackup(plugin: any, monthKey: string): Promise<{ stats: boolean; alerts: boolean }> {
  const mk = String(monthKey ?? "").trim();
  const out = { stats: false, alerts: false };
  if (!/^\d{4}-\d{2}$/.test(mk)) return out;
  const root = filterFinanceSpaceRoot(plugin);
  if (!root) return out;
  const ad = plugin.app.vault.adapter;
  const statsPath = normalizePath(`${root}/finance-analysis/snapshots/month/${mk}.stats.json`);
  const alertsPath = normalizePath(`${root}/finance-analysis/snapshots/month/${mk}.alerts.json`);
  try {
    if (await rollbackOneAnalysisSnapshot(ad, statsPath)) out.stats = true;
  } catch {
    // ignore
  }
  try {
    if (await rollbackOneAnalysisSnapshot(ad, alertsPath)) out.alerts = true;
  } catch {
    // ignore
  }
  return out;
}

export async function writeFinanceAnalysisSnapshotsAndIndex(plugin: any, mode: string): Promise<void> {
  try {
    const spaceId = String(plugin?.getSpaceCtx?.()?.spaceId ?? "default");
    const root = String(plugin?.getSpaceIndexDir?.() ?? "").trim();
    if (!root) return;
    const baseDir = normalizePath(`${root}/finance-analysis`);
    await ensureFolder(plugin, baseDir);

    const dayKey = momentFn().format("YYYY-MM-DD");
    const weekKey = momentFn().format("GGGG-[W]WW");
    const currentMonthKey = momentFn().format("YYYY-MM");

    const { pool, budget, rulesText, poolsText, budgetText } = await readFinanceConfigFiles(plugin);
    const cycleHash = fnv1a32(JSON.stringify(Array.isArray(plugin?.settings?.financeCyclePlans) ? plugin.settings.financeCyclePlans : []));
    const configHashes = {
      rules: fnv1a32(rulesText),
      pools: fnv1a32(poolsText),
      budget: fnv1a32(budgetText),
      cycle: cycleHash,
    };

    const fsnapA = await plugin?.recordRSLatte?.getFinanceSnapshot?.(false);
    const fsnapB = await plugin?.recordRSLatte?.getFinanceSnapshot?.(true);
    const allRecords = [...(Array.isArray(fsnapA?.items) ? fsnapA.items : []), ...(Array.isArray(fsnapB?.items) ? fsnapB.items : [])];

    const vr = validateFinanceRuleConfig({ ruleText: rulesText, pool, budget });
    const rulesObj = (vr.file?.rules ?? {}) as Record<string, any>;
    const cyclePlans = Array.isArray(plugin?.settings?.financeCyclePlans)
      ? (plugin.settings.financeCyclePlans as FinanceCyclePlanRow[])
      : [];

    const rulesSnap = await readFinanceRulesAlertSnapshot(plugin);
    const allAlertsForDayWeek = Array.isArray(rulesSnap?.alerts) ? rulesSnap!.alerts : [];

    const grains: Array<{ grain: FinanceAnalysisGrain; periodKey: string }> = [
      { grain: "day", periodKey: dayKey },
      { grain: "week", periodKey: weekKey },
    ];

    const snapshotRefs: FinanceAnalysisIndexFile["snapshots"] = [];
    for (const g of grains) {
      const periodRecords = allRecords.filter((r: any) => inPeriod(normRecordDate(r), g.grain, g.periodKey));
      const periodAlertItems = allAlertsForDayWeek.filter((a: any) => periodKeyByGrainFromAlert(a, g.grain) === g.periodKey);
      const sev = countSeverity(periodAlertItems as any[]);

      const statsSnapshot = buildStatsSnapshot({
        spaceId,
        mode: String(mode ?? ""),
        grain: g.grain,
        periodKey: g.periodKey,
        periodRecords,
        pool,
        budget,
        alertSeverity: sev,
        alertCount: periodAlertItems.length,
      });
      const statsRel = `snapshots/${g.grain}/${g.periodKey}.stats.json`;
      const statsPath = normalizePath(`${baseDir}/${statsRel}`);
      await ensureFolder(plugin, normalizePath(`${baseDir}/snapshots/${g.grain}`));
      await plugin.app.vault.adapter.write(statsPath, JSON.stringify(statsSnapshot, null, 2));

      const alertsRel = `snapshots/${g.grain}/${g.periodKey}.alerts.json`;
      const alertsPath = normalizePath(`${baseDir}/${alertsRel}`);

      let prevDwItems: FinanceAlertSnapshotItem[] = [];
      try {
        const okPrev = await plugin.app.vault.adapter.exists(alertsPath);
        if (okPrev) {
          const rawPrev = await plugin.app.vault.adapter.read(alertsPath);
          const jp = parseJsonSafe(rawPrev);
          if (jp && Number(jp.version) === 1 && Array.isArray(jp.items)) {
            prevDwItems = jp.items as FinanceAlertSnapshotItem[];
          }
        }
      } catch {
        // ignore
      }
      const prevByFpDw = new Map<string, FinanceAlertSnapshotItem>();
      for (const p of prevDwItems) {
        const fp = String(p?.alertFingerprint ?? "").trim();
        if (fp) prevByFpDw.set(fp, p);
      }

      const currentDwItems: FinanceAlertSnapshotItem[] = periodAlertItems.map((a: any) => {
        const fp = buildAlertFingerprint(a);
        const prev = prevByFpDw.get(fp);
        const prevStatus = String(prev?.status ?? "").trim();
        const status: FinanceAlertSnapshotItem["status"] =
          prevStatus === "ignored" ? "ignored" : prev ? "ongoing" : "new";
        return {
          ruleId: String(a.ruleId ?? ""),
          algorithmId: String(a.algorithmId ?? ""),
          severity: (String(a.severity ?? "notice") as any) as "high" | "warning" | "notice",
          title: String(a.title ?? a.ruleId ?? ""),
          message: String(a.message ?? ""),
          effectivePeriod: String(a.effectivePeriod ?? ""),
          detectedAt: String(a.detectedAt ?? ""),
          relatedEntryIds: Array.isArray(a.relatedEntryIds) ? a.relatedEntryIds.map((x: any) => String(x ?? "")).filter(Boolean) : undefined,
          explain: a.explain && typeof a.explain === "object" ? a.explain : undefined,
          status,
          alertFingerprint: fp,
        };
      });

      const currentFpSetDw = new Set<string>(currentDwItems.map((x) => x.alertFingerprint));
      const resolvedDw: FinanceAlertSnapshotItem[] = [];
      for (const p of prevDwItems) {
        const fp = String(p?.alertFingerprint ?? "").trim();
        if (!fp || currentFpSetDw.has(fp)) continue;
        resolvedDw.push({
          ...p,
          status: "resolved",
          detectedAt: new Date().toISOString(),
          relatedEntryIds: Array.isArray(p.relatedEntryIds) ? p.relatedEntryIds : undefined,
        });
      }

      const alertItemsDw: FinanceAlertSnapshotItem[] = [...currentDwItems, ...resolvedDw];
      alertItemsDw.sort((a, b) => {
        const rankStatus = (s: string) => (s === "new" ? 0 : s === "ongoing" ? 1 : s === "ignored" ? 2 : 3);
        const rankSeverity = (s: string) => (s === "high" ? 0 : s === "warning" ? 1 : 2);
        const rs = rankStatus(String(a.status)) - rankStatus(String(b.status));
        if (rs !== 0) return rs;
        return rankSeverity(String(a.severity)) - rankSeverity(String(b.severity));
      });

      const statusSummaryDw = countStatus(alertItemsDw);
      const alertsSnapshotDw: FinanceAlertsSnapshotFile = {
        version: 1,
        generatedAt: new Date().toISOString(),
        spaceId,
        mode: String(mode ?? ""),
        grain: g.grain,
        periodKey: g.periodKey,
        summary: {
          total: alertItemsDw.length,
          high: sev.high,
          warning: sev.warning,
          notice: sev.notice,
        },
        statusSummary: statusSummaryDw,
        items: alertItemsDw,
      };
      await plugin.app.vault.adapter.write(alertsPath, JSON.stringify(alertsSnapshotDw, null, 2));

      snapshotRefs.push({
        grain: g.grain,
        periodKey: g.periodKey,
        statsRef: statsRel,
        alertsRef: alertsRel,
        summary: statsSnapshot.summary,
        alertSummary: statsSnapshot.alertSummary,
      });
    }

    const monthWritten = await writeFinanceMonthAnalysisSnapshotsFiles(plugin, {
      baseDir,
      spaceId,
      mode,
      monthKey: currentMonthKey,
      allRecords,
      pool,
      budget,
      cyclePlans,
      rulesObj,
      backupBefore: false,
    });
    if (monthWritten) {
      snapshotRefs.push({
        grain: "month",
        periodKey: currentMonthKey,
        statsRef: monthWritten.statsRel,
        alertsRef: monthWritten.alertsRel,
        summary: monthWritten.summary,
        alertSummary: monthWritten.alertSummary,
      });
    }

    const latest =
      snapshotRefs.find((x) => x.grain === "month" && x.periodKey === currentMonthKey) ??
      snapshotRefs.filter((x) => x.grain === "month").slice(-1)[0] ??
      snapshotRefs[0];
    if (!latest) return;

    // activeAlerts 以当月 alerts snapshot 为准（过滤 resolved）
    let monthAlerts: FinanceAnalysisIndexFile["activeAlerts"] = [];
    try {
      const monthAlertsPath = normalizePath(`${baseDir}/snapshots/month/${currentMonthKey}.alerts.json`);
      const ok = await plugin.app.vault.adapter.exists(monthAlertsPath);
      if (ok) {
        const raw = await plugin.app.vault.adapter.read(monthAlertsPath);
        const j = parseJsonSafe(raw);
        const items = Array.isArray(j?.items) ? j.items : [];
        monthAlerts = items
          .filter((a: any) => String(a?.status ?? "new") !== "resolved")
          .map((a: any) => ({
            ruleId: String(a?.ruleId ?? ""),
            title: String(a?.title ?? a?.ruleId ?? ""),
            severity: (String(a?.severity ?? "notice") as any) as "high" | "warning" | "notice",
            effectivePeriod: String(a?.effectivePeriod ?? ""),
            detectedAt: String(a?.detectedAt ?? ""),
            alertFingerprint: String(a?.alertFingerprint ?? ""),
            status: (String(a?.status ?? "new") as any) as "new" | "ongoing" | "resolved" | "ignored",
          }))
          .sort((a: any, b: any) => {
            const rs = (s: string) => (s === "new" ? 0 : s === "ongoing" ? 1 : s === "ignored" ? 2 : 3);
            const rv = (s: string) => (s === "high" ? 0 : s === "warning" ? 1 : 2);
            const ds = rs(String(a.status)) - rs(String(b.status));
            if (ds !== 0) return ds;
            return rv(String(a.severity)) - rv(String(b.severity));
          })
          .slice(0, 50);
      }
    } catch {
      // ignore
    }

    const indexFile: FinanceAnalysisIndexFile = {
      version: 1,
      generatedAt: new Date().toISOString(),
      spaceId,
      mode: String(mode ?? ""),
      latest: {
        grain: latest.grain,
        periodKey: latest.periodKey,
        summary: latest.summary,
        alertSummary: latest.alertSummary,
      },
      snapshots: snapshotRefs,
      activeAlerts: monthAlerts,
      configHashes,
    };
    const indexPath = normalizePath(`${baseDir}/finance-analysis.index.json`);
    await plugin.app.vault.adapter.write(indexPath, JSON.stringify(indexFile, null, 2));
  } catch (e) {
    console.warn("[RSLatte][finance-analysis] write analysis index/snapshots failed", e);
  }
}

export async function readFinanceAnalysisIndex(plugin: any): Promise<FinanceAnalysisIndexFile | null> {
  try {
    const root = String(plugin?.getSpaceIndexDir?.() ?? "").trim();
    if (!root) return null;
    const path = normalizePath(`${root}/finance-analysis/finance-analysis.index.json`);
    const ok = await plugin.app.vault.adapter.exists(path);
    if (!ok) return null;
    const raw = await plugin.app.vault.adapter.read(path);
    const j = parseJsonSafe(raw);
    if (!j || Number(j.version) !== 1) return null;
    return j as FinanceAnalysisIndexFile;
  } catch (e) {
    console.warn("[RSLatte][finance-analysis] read finance-analysis.index.json failed", e);
    return null;
  }
}

export async function readFinanceStatsSnapshot(
  plugin: any,
  grain: FinanceAnalysisGrain,
  periodKey: string
): Promise<FinanceStatsSnapshotFile | null> {
  try {
    const root = String(plugin?.getSpaceIndexDir?.() ?? "").trim();
    if (!root) return null;
    const path = normalizePath(`${root}/finance-analysis/snapshots/${grain}/${periodKey}.stats.json`);
    const ok = await plugin.app.vault.adapter.exists(path);
    if (!ok) return null;
    const raw = await plugin.app.vault.adapter.read(path);
    const j = parseJsonSafe(raw);
    if (!j || Number(j.version) !== 1) return null;
    return j as FinanceStatsSnapshotFile;
  } catch (e) {
    console.warn("[RSLatte][finance-analysis] read stats snapshot failed", e);
    return null;
  }
}

export async function readFinanceAlertsSnapshot(
  plugin: any,
  grain: FinanceAnalysisGrain,
  periodKey: string
): Promise<FinanceAlertsSnapshotFile | null> {
  try {
    const root = String(plugin?.getSpaceIndexDir?.() ?? "").trim();
    if (!root) return null;
    const path = normalizePath(`${root}/finance-analysis/snapshots/${grain}/${periodKey}.alerts.json`);
    const ok = await plugin.app.vault.adapter.exists(path);
    if (!ok) return null;
    const raw = await plugin.app.vault.adapter.read(path);
    const j = parseJsonSafe(raw);
    if (!j || Number(j.version) !== 1) return null;
    return j as FinanceAlertsSnapshotFile;
  } catch (e) {
    console.warn("[RSLatte][finance-analysis] read alerts snapshot failed", e);
    return null;
  }
}
