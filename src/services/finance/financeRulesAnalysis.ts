import { normalizePath, moment } from "obsidian";
import type { FinanceBudgetConfigFile, FinanceCyclePlanRow, FinanceDataPoolConfigFile, FinanceDataPoolItem, FinanceDataPoolNode } from "../../types/rslatteTypes";
import type { FinanceRuleSeverity } from "../../types/financeRuleTypes";
import { validateFinanceRuleConfig } from "./financeRuleValidator";
import { financeAlgorithmRegistry } from "./financeAlgorithmRegistry";
import { extractFinanceMeta, normalizeFinanceSubcategory } from "./financeSubcategory";

const momentFn = moment as any;

export type FinanceRuleAlertItem = {
  ruleId: string;
  severity: FinanceRuleSeverity;
  title: string;
  message: string;
  algorithmId: string;
  effectivePeriod: string; // YYYY-MM / YYYY-Www / YYYY-MM-DD（当前先月）
  detectedAt: string;
  /** 用于后续展开：尽力给出 entry_id 列表 */
  relatedEntryIds?: string[];
  /** 解释参数（供 UI 展示） */
  explain?: Record<string, unknown>;
};

export type FinanceRulesAlertFile = {
  version: 1;
  generatedAt: string;
  spaceId: string;
  mode: string;
  periodKey: string;
  status: "ok" | "error";
  issues?: string[];
  alerts: FinanceRuleAlertItem[];
  summary: {
    total: number;
    high: number;
    warning: number;
    notice: number;
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
}> {
  const root = String(plugin?.getSpaceIndexDir?.() ?? "").trim();
  if (!root) return { pool: null, budget: null, rulesText: "" };
  const cfgDir = normalizePath(`${root}/finance-config`);
  const poolPath = normalizePath(`${cfgDir}/finance-data-pools.json`);
  const budgetPath = normalizePath(`${cfgDir}/finance-budgets.json`);
  const rulesPath = normalizePath(`${cfgDir}/finance-rules.json`);

  const readOrEmpty = async (p: string) => {
    const ok = await plugin.app.vault.adapter.exists(p);
    if (!ok) return "";
    return String(await plugin.app.vault.adapter.read(p) ?? "");
  };

  const poolRaw = await readOrEmpty(poolPath);
  const budgetRaw = await readOrEmpty(budgetPath);
  const rulesRaw = await readOrEmpty(rulesPath);

  const poolJ = parseJsonSafe(poolRaw);
  const budgetJ = parseJsonSafe(budgetRaw);

  const pool: FinanceDataPoolConfigFile | null =
    poolJ && Number(poolJ.schema_version) === 1 && Array.isArray(poolJ.items)
      ? (poolJ as FinanceDataPoolConfigFile)
      : null;
  const budget: FinanceBudgetConfigFile | null =
    budgetJ && Number(budgetJ.schema_version) === 1 && Array.isArray(budgetJ.items)
      ? (budgetJ as FinanceBudgetConfigFile)
      : null;

  return { pool, budget, rulesText: rulesRaw };
}

function isDeleted(r: any): boolean {
  return (
    r?.is_delete === true ||
    r?.isDelete === true ||
    String(r?.is_delete || r?.isDelete || "").toLowerCase() === "true"
  );
}

function normEntryId(r: any): string {
  return String(r?.entry_id ?? r?.entryId ?? "").trim();
}

function normCatId(r: any): string {
  return String(r?.category_id ?? r?.categoryId ?? "").trim();
}

function normRecordDate(r: any): string {
  return String(r?.record_date ?? r?.recordDate ?? "").trim();
}

function normInstitutionFromRecord(r: any): string {
  // 以 meta 为准（note 中解析），其次取 index 字段
  const parsed = extractFinanceMeta(String(r?.note ?? ""));
  return String(parsed.institutionName || r?.institutionName || r?.institution_name || "").trim().replace(/\s+/g, " ");
}

function normSubcategoryFromRecord(r: any): string {
  const parsed = extractFinanceMeta(String(r?.note ?? ""));
  return normalizeFinanceSubcategory(String(r?.subcategory ?? r?.subCategory ?? "")) || parsed.subcategory || "";
}

function normSceneTagsFromRecord(r: any): string[] {
  const parsed = extractFinanceMeta(String(r?.note ?? ""));
  const fromMeta = Array.isArray((parsed as any).sceneTags) ? (parsed as any).sceneTags : [];
  const fromIndex = Array.isArray((r as any)?.sceneTags) ? (r as any).sceneTags : [];
  const out = (fromMeta.length ? fromMeta : fromIndex)
    .map((x: any) => String(x ?? "").trim())
    .filter(Boolean);
  return Array.from(new Set(out));
}

function applyRecordFilters(records: any[], filters: any): any[] {
  if (!filters || typeof filters !== "object") return records;
  const policy = String((filters as any).sceneTagPolicy ?? "");
  const excluded = Array.isArray((filters as any).excludeSceneTags)
    ? (filters as any).excludeSceneTags.map((x: any) => String(x ?? "").trim()).filter(Boolean)
    : [];
  if (policy === "exclude_any_tagged") {
    return records.filter((r) => normSceneTagsFromRecord(r).length === 0);
  }
  if (policy === "exclude_specific_tags" && excluded.length > 0) {
    return records.filter((r) => {
      const tags = normSceneTagsFromRecord(r);
      return !tags.some((t) => excluded.includes(t));
    });
  }
  return records;
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

function pickPool(pool: FinanceDataPoolConfigFile | null, poolId: string): FinanceDataPoolItem | null {
  const pid = String(poolId ?? "").trim();
  if (!pool || !pid) return null;
  const arr = Array.isArray(pool.items) ? pool.items : [];
  for (const it of arr as any[]) {
    if (String(it?.poolId ?? "").trim() === pid) return it as FinanceDataPoolItem;
  }
  return null;
}

function filterRecordsByPool(records: any[], pool: FinanceDataPoolConfigFile | null, poolId: string): any[] {
  const p = pickPool(pool, poolId);
  if (!p) return [];
  const nodes = Array.isArray((p as any).nodes) ? (p as any).nodes : [];
  if (nodes.length === 0) return [];
  return records.filter((r) => nodes.some((n: any) => nodeMatch(r, n)));
}

function monthKey(d: string): string {
  const m = String(d ?? "").match(/^(\d{4}-\d{2})/);
  return m ? m[1] : "";
}

function monthDayCapped(ym: string, day: number): string {
  const base = momentFn(`${ym}-01`, "YYYY-MM-DD");
  if (!base.isValid()) return `${ym}-01`;
  const maxDay = Number(base.daysInMonth?.() ?? 28);
  const d = Math.min(Math.max(1, day), maxDay);
  return `${ym}-${String(d).padStart(2, "0")}`;
}

function parseAnchorDay(anchorDate: string): number {
  const m = String(anchorDate ?? "").match(/^\d{4}-\d{2}-(\d{2})$/);
  if (!m) return 1;
  const d = Number(m[1]);
  return Number.isFinite(d) && d >= 1 && d <= 31 ? d : 1;
}

function monthDiff(aYm: string, bYm: string): number {
  const am = momentFn(`${aYm}-01`, "YYYY-MM-DD", true);
  const bm = momentFn(`${bYm}-01`, "YYYY-MM-DD", true);
  if (!am.isValid() || !bm.isValid()) return 0;
  return am.diff(bm, "months");
}

function isPlanApplicableThisMonth(plan: FinanceCyclePlanRow, periodKey: string): boolean {
  const t = String(plan.cycleType ?? "none");
  if (t === "none" || !periodKey) return false;
  const anchorYm = monthKey(String(plan.anchorDate ?? ""));
  if (!anchorYm) return false;
  const diff = monthDiff(periodKey, anchorYm);
  if (diff < 0) return false;
  if (t === "monthly") return true;
  if (t === "quarterly") return diff % 3 === 0;
  if (t === "halfyearly") return diff % 6 === 0;
  if (t === "yearly") return diff % 12 === 0;
  return false;
}

function dueDateByPlanInMonth(plan: FinanceCyclePlanRow, periodKey: string): string | null {
  if (!isPlanApplicableThisMonth(plan, periodKey)) return null;
  const day = parseAnchorDay(String(plan.anchorDate ?? ""));
  return monthDayCapped(periodKey, day);
}

function planMatchPoolNode(plan: FinanceCyclePlanRow, node: FinanceDataPoolNode, institutionRequired: boolean): boolean {
  if (String(plan.catId ?? "").trim() !== String(node.financeTypeId ?? "").trim()) return false;
  const planSub = normalizeFinanceSubcategory(String(plan.subcategory ?? ""));
  const nodeSubs = (node as any).subCategories;
  if (nodeSubs !== "ALL") {
    const arr = Array.isArray(nodeSubs) ? nodeSubs.map((x: any) => normalizeFinanceSubcategory(String(x ?? ""))) : [];
    if (!arr.includes(planSub)) return false;
  }
  const planInst = String(plan.institutionName ?? "").trim().replace(/\s+/g, " ");
  if (institutionRequired && !planInst) return false;
  const nodeInsts = (node as any).institutionNames;
  if (nodeInsts && nodeInsts !== "ALL") {
    const arr = Array.isArray(nodeInsts) ? nodeInsts.map((x: any) => String(x ?? "").trim().replace(/\s+/g, " ")) : [];
    if (!arr.includes(planInst)) return false;
  }
  return true;
}

function inMonth(r: any, ym: string): boolean {
  const d = normRecordDate(r);
  return !!d && monthKey(d) === ym;
}

function inDay(r: any, dayKey: string): boolean {
  const d = normRecordDate(r);
  return !!d && String(d) === String(dayKey);
}

function sumAbsAmount(records: any[]): number {
  let s = 0;
  for (const r of records) {
    if (isDeleted(r)) continue;
    const n = Math.abs(Number(r?.amount ?? 0));
    if (Number.isFinite(n)) s += n;
  }
  return s;
}

function countRecords(records: any[]): number {
  let n = 0;
  for (const r of records) {
    if (isDeleted(r)) continue;
    n++;
  }
  return n;
}

function median(nums: number[]): number {
  const arr = nums.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (arr.length === 0) return NaN;
  const mid = Math.floor(arr.length / 2);
  if (arr.length % 2 === 1) return arr[mid];
  return (arr[mid - 1] + arr[mid]) / 2;
}

function percentile(nums: number[], p: number): number {
  const arr = nums.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (arr.length === 0) return NaN;
  const pp = Math.min(1, Math.max(0, p));
  const idx = (arr.length - 1) * pp;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return arr[lo];
  const w = idx - lo;
  return arr[lo] * (1 - w) + arr[hi] * w;
}

function mean(nums: number[]): number {
  const arr = nums.filter((x) => Number.isFinite(x));
  if (arr.length === 0) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function severityCount(alerts: FinanceRuleAlertItem[]) {
  let high = 0, warning = 0, notice = 0;
  for (const a of alerts) {
    if (a.severity === "high") high++;
    else if (a.severity === "warning") warning++;
    else notice++;
  }
  return { high, warning, notice };
}

function buildAlert(args: {
  ruleId: string;
  severity: FinanceRuleSeverity;
  title: string;
  message: string;
  algorithmId: string;
  effectivePeriod: string;
  related?: any[];
  explain?: Record<string, unknown>;
}): FinanceRuleAlertItem {
  const relatedEntryIds = (args.related ?? [])
    .map((r) => normEntryId(r))
    .filter(Boolean);
  return {
    ruleId: args.ruleId,
    severity: args.severity,
    title: args.title,
    message: args.message,
    algorithmId: args.algorithmId,
    effectivePeriod: args.effectivePeriod,
    detectedAt: new Date().toISOString(),
    relatedEntryIds: relatedEntryIds.length ? Array.from(new Set(relatedEntryIds)).slice(0, 50) : undefined,
    explain: args.explain,
  };
}

function evalPercentileSpike(ctx: {
  ruleId: string;
  algorithmId: string;
  severity: FinanceRuleSeverity;
  title: string;
  template: string;
  periodKey: string;
  poolId: string;
  pool: FinanceDataPoolConfigFile | null;
  filters?: any;
  records: any[];
  params: any;
}): FinanceRuleAlertItem | null {
  const valueScope = String(ctx.params?.valueScope ?? "single_record");
  const lookback = Math.max(1, Math.floor(Number(ctx.params?.lookbackPeriods ?? 0)));
  const percentileKey = String(ctx.params?.percentile ?? "p90");
  const compareOp = String(ctx.params?.compareOperator ?? "gt");
  const thrMul = Number(ctx.params?.thresholdMultiplier ?? NaN);
  const minSample = Math.max(1, Math.floor(Number(ctx.params?.minSampleSize ?? 1)));
  if (!Number.isFinite(thrMul)) return null;
  if (!(compareOp === "gt" || compareOp === "lt")) return null;

  const p =
    percentileKey === "p75" ? 0.75 : percentileKey === "p95" ? 0.95 : percentileKey === "p90" ? 0.9 : 0.9;

  const bucketCurRaw = filterRecordsByPool(ctx.records, ctx.pool, ctx.poolId).filter((r) => inMonth(r, ctx.periodKey));
  const bucketCur = applyRecordFilters(bucketCurRaw, ctx.filters);

  if (valueScope === "single_record") {
    const curVals = bucketCur
      .filter((r) => !isDeleted(r))
      .map((r) => Math.abs(Number(r?.amount ?? 0)))
      .filter((x) => Number.isFinite(x) && x >= 0);
    if (curVals.length === 0) return null;
    const curMax = Math.max(...curVals);

    const histVals: number[] = [];
    for (let i = 1; i <= lookback; i++) {
      const key = momentFn(`${ctx.periodKey}-01`, "YYYY-MM-DD").subtract(i, "months").format("YYYY-MM");
      const bucketRaw = filterRecordsByPool(ctx.records, ctx.pool, ctx.poolId).filter((r) => inMonth(r, key));
      const bucket = applyRecordFilters(bucketRaw, ctx.filters);
      for (const r of bucket) {
        if (isDeleted(r)) continue;
        const v = Math.abs(Number(r?.amount ?? 0));
        if (Number.isFinite(v)) histVals.push(v);
      }
    }
    if (histVals.length < minSample) return null;
    const pv = percentile(histVals, p);
    if (!Number.isFinite(pv)) return null;
    const bound = pv * thrMul;
    const hit = compareOp === "gt" ? curMax > bound : curMax < bound;
    if (!hit) return null;

    const related = bucketCur.filter((r) => Math.abs(Number(r?.amount ?? 0)) === curMax);
    return buildAlert({
      ruleId: ctx.ruleId,
      severity: ctx.severity,
      title: ctx.title,
      message: ctx.template,
      algorithmId: ctx.algorithmId,
      effectivePeriod: ctx.periodKey,
      related,
      explain: { valueScope, percentile: percentileKey, percentileValue: pv, thresholdMultiplier: thrMul, bound, currentMax: curMax, lookbackPeriods: lookback },
    });
  }

  if (valueScope === "period_value") {
    const curSum = sumAbsAmount(bucketCur);
    const histSums: number[] = [];
    for (let i = 1; i <= lookback; i++) {
      const key = momentFn(`${ctx.periodKey}-01`, "YYYY-MM-DD").subtract(i, "months").format("YYYY-MM");
      const bucketRaw = filterRecordsByPool(ctx.records, ctx.pool, ctx.poolId).filter((r) => inMonth(r, key));
      const bucket = applyRecordFilters(bucketRaw, ctx.filters);
      histSums.push(sumAbsAmount(bucket));
    }
    if (histSums.length < minSample) return null;
    const pv = percentile(histSums, p);
    if (!Number.isFinite(pv)) return null;
    const bound = pv * thrMul;
    const hit = compareOp === "gt" ? curSum > bound : curSum < bound;
    if (!hit) return null;
    return buildAlert({
      ruleId: ctx.ruleId,
      severity: ctx.severity,
      title: ctx.title,
      message: ctx.template,
      algorithmId: ctx.algorithmId,
      effectivePeriod: ctx.periodKey,
      related: bucketCur,
      explain: { valueScope, percentile: percentileKey, percentileValue: pv, thresholdMultiplier: thrMul, bound, currentValue: curSum, lookbackPeriods: lookback },
    });
  }

  return null;
}

function evalNewEntityGrowth(ctx: {
  ruleId: string;
  algorithmId: string;
  severity: FinanceRuleSeverity;
  title: string;
  template: string;
  periodKey: string;
  poolId: string;
  pool: FinanceDataPoolConfigFile | null;
  filters?: any;
  records: any[];
  params: any;
}): FinanceRuleAlertItem | null {
  const entityKey = String(ctx.params?.entityKey ?? "institutionName");
  const institutionRequired = ctx.params?.institutionRequired === true;
  const lookback = Math.max(1, Math.floor(Number(ctx.params?.lookbackPeriods ?? 0)));
  const historyMode = String(ctx.params?.historyWindowMode ?? "period_avg");
  const newDef = String(ctx.params?.newEntityDefinition ?? "not_seen_before_current_period");
  const thresholdMode = String(ctx.params?.thresholdMode ?? "offset");
  const thresholdValue = Number(ctx.params?.thresholdValue ?? NaN);
  const minSample = Math.max(1, Math.floor(Number(ctx.params?.minSampleSize ?? 1)));
  if (!Number.isFinite(thresholdValue)) return null;

  const bucketAllRaw = filterRecordsByPool(ctx.records, ctx.pool, ctx.poolId);
  const bucketAll = applyRecordFilters(bucketAllRaw, ctx.filters);
  const bucketCur = bucketAll.filter((r) => inMonth(r, ctx.periodKey));
  const normalizeEntity = (r: any): string => {
    const v =
      entityKey === "institutionName"
        ? normInstitutionFromRecord(r)
        : entityKey === "subcategory"
          ? normSubcategoryFromRecord(r)
          : String((r as any)?.[entityKey] ?? "").trim();
    if (!v) return "";
    if (institutionRequired && entityKey === "institutionName" && !v) return "";
    return v;
  };
  const curEntities = new Set<string>();
  for (const r of bucketCur) {
    const v = normalizeEntity(r);
    if (v) curEntities.add(v);
  }

  const seenBeforeYm = (untilYm: string): Set<string> => {
    const out = new Set<string>();
    for (const r of bucketAll) {
      const ym = monthKey(normRecordDate(r));
      if (!ym) continue;
      if (ym >= untilYm) continue;
      const v = normalizeEntity(r);
      if (v) out.add(v);
    }
    return out;
  };

  const curNewEntities: string[] = [];
  if (newDef === "not_seen_in_lookback_window") {
    const lbUntil = momentFn(`${ctx.periodKey}-01`, "YYYY-MM-DD").subtract(lookback, "months").format("YYYY-MM");
    const seen = seenBeforeYm(lbUntil);
    for (const e of curEntities) if (!seen.has(e)) curNewEntities.push(e);
  } else {
    const seen = seenBeforeYm(ctx.periodKey);
    for (const e of curEntities) if (!seen.has(e)) curNewEntities.push(e);
  }
  const curCount = curNewEntities.length;

  const series: number[] = [];
  for (let i = 1; i <= lookback; i++) {
    const key = momentFn(`${ctx.periodKey}-01`, "YYYY-MM-DD").subtract(i, "months").format("YYYY-MM");
    const bucket = bucketAll.filter((r) => inMonth(r, key));
    const ents = new Set<string>();
    for (const r of bucket) {
      const v = normalizeEntity(r);
      if (v) ents.add(v);
    }
    const seen = seenBeforeYm(key);
    let n = 0;
    for (const e of ents) if (!seen.has(e)) n++;
    series.push(n);
  }
  if (series.length < minSample) return null;
  const baseline = historyMode === "period_median" ? median(series) : mean(series);
  if (!Number.isFinite(baseline)) return null;

  let bound = baseline;
  if (thresholdMode === "multiplier") bound = baseline * thresholdValue;
  else if (thresholdMode === "offset") bound = baseline + thresholdValue;
  else bound = thresholdValue;

  if (!(curCount > bound)) return null;
  return buildAlert({
    ruleId: ctx.ruleId,
    severity: ctx.severity,
    title: ctx.title,
    message: ctx.template,
    algorithmId: ctx.algorithmId,
    effectivePeriod: ctx.periodKey,
    related: bucketCur,
    explain: {
      entityKey,
      institutionRequired,
      currentNewEntityCount: curCount,
      baselineNewEntityCount: baseline,
      bound,
      historySeries: series,
      newEntities: curNewEntities.slice(0, 24),
    },
  });
}

function evalDerivedMetricDeviation(ctx: {
  ruleId: string;
  algorithmId: string;
  severity: FinanceRuleSeverity;
  title: string;
  template: string;
  periodKey: string;
  pool: FinanceDataPoolConfigFile | null;
  filters?: any;
  records: any[];
  params: any;
}): FinanceRuleAlertItem | null {
  const metricKey = String(ctx.params?.metricKey ?? "");
  const inputs = ctx.params?.metricInputs ?? {};
  const compareMode = String(ctx.params?.compareMode ?? "previous_period");
  const compareOp = String(ctx.params?.compareOperator ?? "gt");
  const thresholdMode = String(ctx.params?.thresholdMode ?? "multiplier");
  const thresholdValue = Number(ctx.params?.thresholdValue ?? NaN);
  const lookback = Math.max(1, Math.floor(Number(ctx.params?.lookbackPeriods ?? 0)));
  const minSample = Math.max(1, Math.floor(Number(ctx.params?.minSampleSize ?? 1)));
  const zeroIncomePolicy = String(ctx.params?.zeroIncomePolicy ?? "skip");
  if (!metricKey) return null;
  if (!Number.isFinite(thresholdValue)) return null;
  if (!(compareOp === "gt" || compareOp === "lt")) return null;

  const incomePoolId = String(inputs?.incomePoolId ?? "").trim();
  const expensePoolId = String(inputs?.expensePoolId ?? "").trim();
  if (!incomePoolId || !expensePoolId) return null;

  const monthlyPoolSum = (poolId: string, ym: string) => {
    const bucketRaw = filterRecordsByPool(ctx.records, ctx.pool, poolId).filter((r) => inMonth(r, ym));
    const bucket = applyRecordFilters(bucketRaw, ctx.filters);
    return sumAbsAmount(bucket);
  };

  const metricFor = (ym: string): { metric: number; income: number; expense: number } | null => {
    const inc = monthlyPoolSum(incomePoolId, ym);
    const exp = monthlyPoolSum(expensePoolId, ym);
    if (metricKey === "cashflow_gap") return { metric: exp - inc, income: inc, expense: exp };
    if (metricKey === "surplus_rate") {
      if (inc <= 0) {
        if (zeroIncomePolicy === "zero") return { metric: 0, income: inc, expense: exp };
        if (zeroIncomePolicy === "treat_as_negative_max") return { metric: -1, income: inc, expense: exp };
        if (zeroIncomePolicy === "treat_as_invalid") return null;
        return null;
      }
      return { metric: (inc - exp) / inc, income: inc, expense: exp };
    }
    return null;
  };

  const cur = metricFor(ctx.periodKey);
  if (!cur) return null;

  let baseline: number | null = null;
  let series: number[] = [];
  if (compareMode === "previous_period") {
    const prevKey = momentFn(`${ctx.periodKey}-01`, "YYYY-MM-DD").subtract(1, "months").format("YYYY-MM");
    const prev = metricFor(prevKey);
    if (!prev) return null;
    baseline = prev.metric;
    series = [prev.metric];
  } else {
    for (let i = 1; i <= lookback; i++) {
      const key = momentFn(`${ctx.periodKey}-01`, "YYYY-MM-DD").subtract(i, "months").format("YYYY-MM");
      const v = metricFor(key);
      if (!v) continue;
      series.push(v.metric);
    }
    if (series.length < minSample) return null;
    baseline = compareMode === "history_median" ? median(series) : mean(series);
  }
  if (baseline === null || !Number.isFinite(baseline)) return null;

  let bound = baseline;
  if (thresholdMode === "multiplier") bound = baseline * thresholdValue;
  else if (thresholdMode === "offset") bound = baseline + thresholdValue;
  else bound = thresholdValue;

  const hit = compareOp === "gt" ? cur.metric > bound : cur.metric < bound;
  if (!hit) return null;

  const related = [
    ...applyRecordFilters(
      filterRecordsByPool(ctx.records, ctx.pool, incomePoolId).filter((r) => inMonth(r, ctx.periodKey)),
      ctx.filters
    ),
    ...applyRecordFilters(
      filterRecordsByPool(ctx.records, ctx.pool, expensePoolId).filter((r) => inMonth(r, ctx.periodKey)),
      ctx.filters
    ),
  ];
  return buildAlert({
    ruleId: ctx.ruleId,
    severity: ctx.severity,
    title: ctx.title,
    message: ctx.template,
    algorithmId: ctx.algorithmId,
    effectivePeriod: ctx.periodKey,
    related,
    explain: { metricKey, currentValue: cur.metric, baselineValue: baseline, bound, incomeValue: cur.income, expenseValue: cur.expense, compareMode, compareOperator: compareOp, thresholdMode, thresholdValue, historySeries: series },
  });
}

function evalSequenceAnomaly(ctx: {
  ruleId: string;
  algorithmId: string;
  severity: FinanceRuleSeverity;
  title: string;
  template: string;
  periodKey: string;
  pool: FinanceDataPoolConfigFile | null;
  records: any[];
  target: any;
  params: any;
}): FinanceRuleAlertItem | null {
  const unit = String(ctx.params?.sequenceUnit ?? "day");
  const len = Math.max(1, Math.floor(Number(ctx.params?.sequenceLength ?? 0)));
  const op = String(ctx.params?.relationOperator ?? "gt");
  const leftPoolId = String(ctx.target?.leftPoolId ?? "").trim();
  const rightPoolId = String(ctx.target?.rightPoolId ?? "").trim();
  if (!leftPoolId || !rightPoolId) return null;
  if (!(op === "gt" || op === "gte" || op === "lt" || op === "lte")) return null;

  const cmp = (a: number, b: number) => {
    if (op === "gt") return a > b;
    if (op === "gte") return a >= b;
    if (op === "lt") return a < b;
    return a <= b;
  };

  const slices: { key: string; left: number; right: number }[] = [];
  if (unit === "month") {
    for (let i = 0; i < len; i++) {
      const key = momentFn(`${ctx.periodKey}-01`, "YYYY-MM-DD").subtract(i, "months").format("YYYY-MM");
      const left = sumAbsAmount(filterRecordsByPool(ctx.records, ctx.pool, leftPoolId).filter((r) => inMonth(r, key)));
      const right = sumAbsAmount(filterRecordsByPool(ctx.records, ctx.pool, rightPoolId).filter((r) => inMonth(r, key)));
      slices.push({ key, left, right });
    }
  } else if (unit === "week") {
    const now = momentFn();
    for (let i = 0; i < len; i++) {
      const ws = now.clone().startOf("week").subtract(i, "weeks");
      const we = ws.clone().endOf("week");
      const key = `${ws.format("YYYY-[W]WW")}`;
      const left = sumAbsAmount(
        filterRecordsByPool(ctx.records, ctx.pool, leftPoolId).filter((r) => {
          const d = normRecordDate(r);
          const m = momentFn(d, "YYYY-MM-DD", true);
          return m.isValid() && m.isSameOrAfter(ws, "day") && m.isSameOrBefore(we, "day");
        })
      );
      const right = sumAbsAmount(
        filterRecordsByPool(ctx.records, ctx.pool, rightPoolId).filter((r) => {
          const d = normRecordDate(r);
          const m = momentFn(d, "YYYY-MM-DD", true);
          return m.isValid() && m.isSameOrAfter(ws, "day") && m.isSameOrBefore(we, "day");
        })
      );
      slices.push({ key, left, right });
    }
  } else {
    const now = momentFn();
    for (let i = 0; i < len; i++) {
      const day = now.clone().subtract(i, "days").format("YYYY-MM-DD");
      const left = sumAbsAmount(filterRecordsByPool(ctx.records, ctx.pool, leftPoolId).filter((r) => inDay(r, day)));
      const right = sumAbsAmount(filterRecordsByPool(ctx.records, ctx.pool, rightPoolId).filter((r) => inDay(r, day)));
      slices.push({ key: day, left, right });
    }
  }

  const ok = slices.length === len && slices.every((s) => cmp(s.left, s.right));
  if (!ok) return null;

  const related = [
    ...filterRecordsByPool(ctx.records, ctx.pool, leftPoolId),
    ...filterRecordsByPool(ctx.records, ctx.pool, rightPoolId),
  ];
  return buildAlert({
    ruleId: ctx.ruleId,
    severity: ctx.severity,
    title: ctx.title,
    message: ctx.template,
    algorithmId: ctx.algorithmId,
    effectivePeriod: ctx.periodKey,
    related,
    explain: { sequenceUnit: unit, sequenceLength: len, relationOperator: op, slices: slices.slice().reverse() },
  });
}

function evalPeriodBreak(ctx: {
  ruleId: string;
  algorithmId: string;
  severity: FinanceRuleSeverity;
  title: string;
  template: string;
  periodKey: string;
  poolId: string;
  pool: FinanceDataPoolConfigFile | null;
  cyclePlans?: FinanceCyclePlanRow[];
  filters?: any;
  records: any[];
  params: any;
}): FinanceRuleAlertItem | null {
  const cycleType = String(ctx.params?.cycleType ?? "");
  const allowed = Math.max(0, Math.floor(Number(ctx.params?.allowedDeviation ?? 0)));
  const lookback = Math.max(1, Math.floor(Number(ctx.params?.lookbackPeriods ?? 0)));
  const sourceMode = String(ctx.params?.expectedSourceMode ?? "history_inference");
  const expectedAnchorRaw = ctx.params?.expectedAnchor;
  const institutionRequired = ctx.params?.institutionRequired === true;
  if (!cycleType) return null;
  if (cycleType !== "yearly") return null;

  const bucketAllRaw = filterRecordsByPool(ctx.records, ctx.pool, ctx.poolId);
  const bucketAll = applyRecordFilters(bucketAllRaw, ctx.filters);
  const bucketCur = bucketAll.filter((r) => inMonth(r, ctx.periodKey));
  const curByInst = new Map<string, any[]>();
  for (const r of bucketCur) {
    const inst = normInstitutionFromRecord(r);
    if (institutionRequired && !inst) continue;
    const key = inst || "__ALL__";
    const arr = curByInst.get(key) ?? [];
    arr.push(r);
    curByInst.set(key, arr);
  }
  if (curByInst.size === 0) return null;

  const parseExpectedYearlyMonth = (anchor: any): number => {
    if (Number.isFinite(Number(anchor))) {
      const n = Math.floor(Number(anchor));
      if (n >= 1 && n <= 12) return n;
    }
    const s = String(anchor ?? "").trim();
    if (!s) return 0;
    const ymd = s.match(/^\d{4}-(\d{2})-\d{2}$/);
    if (ymd) {
      const mm = Number(ymd[1]);
      return mm >= 1 && mm <= 12 ? mm : 0;
    }
    const ym = s.match(/^\d{4}-(\d{2})$/);
    if (ym) {
      const mm = Number(ym[1]);
      return mm >= 1 && mm <= 12 ? mm : 0;
    }
    return 0;
  };

  const expectedMonthByInst = new Map<string, number>();
  const sourceUsedByInst = new Map<string, string>();

  const expectedAnchorMonth = parseExpectedYearlyMonth(expectedAnchorRaw);
  if (expectedAnchorMonth > 0) {
    for (const [inst] of curByInst.entries()) {
      expectedMonthByInst.set(inst, expectedAnchorMonth);
      sourceUsedByInst.set(inst, "expected_anchor");
    }
  }

  const applyFixedSchedule = (): boolean => {
    const poolDef = pickPool(ctx.pool, ctx.poolId);
    const nodes = Array.isArray((poolDef as any)?.nodes) ? ((poolDef as any).nodes as FinanceDataPoolNode[]) : [];
    const plansRaw = Array.isArray(ctx.cyclePlans) ? ctx.cyclePlans : [];
    const plans = plansRaw.filter((p) => p && p.enabled && !String(p.deletedAt ?? "").trim() && String(p.cycleType ?? "none") !== "none");
    const matched = plans.filter((p) => nodes.some((n) => planMatchPoolNode(p, n, institutionRequired)));
    if (matched.length === 0) return false;

    for (const [inst] of curByInst.entries()) {
      const cand = matched.filter((p) => {
        const pInst = String(p.institutionName ?? "").trim().replace(/\s+/g, " ");
        if (institutionRequired) return pInst === inst;
        return true;
      });
      if (cand.length === 0) continue;
      const counts = new Map<number, number>();
      for (const p of cand) {
        const m = momentFn(String(p.anchorDate ?? ""), "YYYY-MM-DD", true);
        if (!m.isValid()) continue;
        const mm = Number(m.format("M"));
        if (!Number.isFinite(mm) || mm < 1 || mm > 12) continue;
        counts.set(mm, (counts.get(mm) ?? 0) + 1);
      }
      let bestM = 0;
      let bestC = 0;
      for (const [m, c] of counts.entries()) {
        if (c > bestC) {
          bestC = c;
          bestM = m;
        }
      }
      if (bestM <= 0) continue;
      expectedMonthByInst.set(inst, bestM);
      sourceUsedByInst.set(inst, "fixed_schedule");
    }
    return true;
  };

  if (sourceMode === "fixed_schedule" || sourceMode === "hybrid") {
    const used = applyFixedSchedule();
    if (sourceMode === "fixed_schedule" && !used && expectedMonthByInst.size === 0) return null;
  }

  const currentStart = momentFn(`${ctx.periodKey}-01`, "YYYY-MM-DD", true);
  const histStart = currentStart.clone().subtract(lookback, "years").startOf("month");
  for (const [inst] of curByInst.entries()) {
    if (expectedMonthByInst.has(inst)) continue;
    if (sourceMode === "fixed_schedule") continue;
    const counts = new Map<number, number>();
    for (const r of bucketAll) {
      const inst2 = normInstitutionFromRecord(r) || "__ALL__";
      if (inst2 !== inst) continue;
      const m = momentFn(normRecordDate(r), "YYYY-MM-DD", true);
      if (!m.isValid()) continue;
      if (!m.isBefore(currentStart, "month")) continue;
      if (m.isBefore(histStart, "month")) continue;
      const mm = Number(m.format("M"));
      counts.set(mm, (counts.get(mm) ?? 0) + 1);
    }
    let bestM = 0;
    let bestC = 0;
    for (const [m, c] of counts.entries()) {
      if (c > bestC) {
        bestC = c;
        bestM = m;
      }
    }
    if (bestM > 0) {
      expectedMonthByInst.set(inst, bestM);
      sourceUsedByInst.set(inst, sourceMode === "hybrid" ? "hybrid:history_inference" : "history_inference");
    }
  }

  const curMonth = Number(momentFn(`${ctx.periodKey}-01`, "YYYY-MM-DD").format("M"));
  const off: any[] = [];
  const mismatches: any[] = [];
  for (const [inst, recs] of curByInst.entries()) {
    const expM = expectedMonthByInst.get(inst);
    if (!expM) continue;
    const diff = Math.min(Math.abs(curMonth - expM), 12 - Math.abs(curMonth - expM));
    if (diff > allowed) {
      off.push(...recs);
      mismatches.push({
        institutionName: inst === "__ALL__" ? "" : inst,
        expectedMonth: expM,
        currentMonth: curMonth,
        diffMonths: diff,
        expectedSource: sourceUsedByInst.get(inst) ?? "",
      });
    }
  }
  if (off.length === 0) return null;

  return buildAlert({
    ruleId: ctx.ruleId,
    severity: ctx.severity,
    title: ctx.title,
    message: ctx.template,
    algorithmId: ctx.algorithmId,
    effectivePeriod: ctx.periodKey,
    related: off,
    explain: {
      cycleType,
      allowedDeviationMonths: allowed,
      lookbackPeriods: lookback,
      expectedSourceMode: sourceMode,
      expectedAnchorMonth: expectedAnchorMonth > 0 ? expectedAnchorMonth : undefined,
      mismatches: mismatches.slice(0, 12),
    },
  });
}

function evalCompositeAnd(ctx: {
  ruleId: string;
  severity: FinanceRuleSeverity;
  title: string;
  template: string;
  periodKey: string;
  pool: FinanceDataPoolConfigFile | null;
  budget: FinanceBudgetConfigFile | null;
  cyclePlans?: FinanceCyclePlanRow[];
  records: any[];
  params: any;
}): FinanceRuleAlertItem | null {
  const conds = Array.isArray(ctx.params?.conditions) ? ctx.params.conditions : [];
  const minHit = ctx.params?.minConditionsHit != null ? Math.max(1, Math.floor(Number(ctx.params.minConditionsHit))) : conds.length;
  if (conds.length === 0) return null;
  const hits: FinanceRuleAlertItem[] = [];
  for (const c of conds as any[]) {
    const alg = String(c?.algorithmId ?? "").trim();
    const target = c?.target ?? {};
    const params = c?.params ?? {};
    const a = evalOneAlgorithm({
      ruleId: `${ctx.ruleId}::cond`,
      algorithmId: alg,
      severity: "notice",
      title: "条件命中",
      template: "条件命中",
      periodKey: ctx.periodKey,
      pool: ctx.pool,
      budget: ctx.budget,
      cyclePlans: ctx.cyclePlans,
      records: ctx.records,
      target,
      filters: c?.filters ?? {},
      params,
    });
    if (a) hits.push(a);
  }
  if (hits.length < minHit) return null;
  const related = hits.flatMap((h) => (h.relatedEntryIds ?? []).map((id) => ({ entry_id: id })));
  return buildAlert({
    ruleId: ctx.ruleId,
    severity: ctx.severity,
    title: ctx.title,
    message: ctx.template,
    algorithmId: "ALG_COMPOSITE_AND",
    effectivePeriod: ctx.periodKey,
    related,
    explain: { minConditionsHit: minHit, hitCount: hits.length },
  });
}

function evalBudgetBreach(ctx: {
  ruleId: string;
  algorithmId: string;
  severity: FinanceRuleSeverity;
  title: string;
  template: string;
  periodKey: string; // YYYY-MM
  poolId: string;
  budgetId: string;
  budget: FinanceBudgetConfigFile | null;
  pool: FinanceDataPoolConfigFile | null;
  records: any[];
  params: any;
}): FinanceRuleAlertItem | null {
  const b = (ctx.budget?.items ?? []).find((x: any) => String(x?.budgetId ?? "").trim() === ctx.budgetId);
  if (!b || b.enabled === false) return null;
  const amount = Number(b.amount ?? 0);
  if (!(Number.isFinite(amount) && amount >= 0)) return null;
  const threshold = Number(ctx.params?.budgetThreshold ?? 1);
  const mode = String(ctx.params?.budgetMode ?? "breach");
  const bucket = filterRecordsByPool(ctx.records, ctx.pool, ctx.poolId).filter((r) => inMonth(r, ctx.periodKey));
  const spent = sumAbsAmount(bucket);
  const ratio = amount > 0 ? spent / amount : Infinity;
  const hit = mode === "warn" ? ratio >= threshold : ratio >= threshold;
  if (!hit) return null;
  return buildAlert({
    ruleId: ctx.ruleId,
    severity: ctx.severity,
    title: ctx.title,
    message: ctx.template,
    algorithmId: ctx.algorithmId,
    effectivePeriod: ctx.periodKey,
    related: bucket,
    explain: { spent, budget: amount, ratio, budgetMode: mode, threshold },
  });
}

function evalAbsoluteThreshold(ctx: {
  ruleId: string;
  algorithmId: string;
  severity: FinanceRuleSeverity;
  title: string;
  template: string;
  periodKey: string;
  poolId: string;
  pool: FinanceDataPoolConfigFile | null;
  records: any[];
  params: any;
}): FinanceRuleAlertItem | null {
  const thr = Number(ctx.params?.thresholdValue ?? NaN);
  const op = String(ctx.params?.compareOperator ?? "gt");
  const target = String(ctx.params?.compareTarget ?? "single_record");
  if (!(Number.isFinite(thr) && thr >= 0)) return null;
  const bucket = filterRecordsByPool(ctx.records, ctx.pool, ctx.poolId).filter((r) => inMonth(r, ctx.periodKey));
  if (target !== "single_record") return null;
  const hits = bucket.filter((r) => Math.abs(Number(r?.amount ?? 0)) > thr);
  if (op !== "gt") return null;
  if (hits.length === 0) return null;
  const maxV = Math.max(...hits.map((r) => Math.abs(Number(r?.amount ?? 0))));
  return buildAlert({
    ruleId: ctx.ruleId,
    severity: ctx.severity,
    title: ctx.title,
    message: ctx.template,
    algorithmId: ctx.algorithmId,
    effectivePeriod: ctx.periodKey,
    related: hits,
    explain: { threshold: thr, max: maxV, hitCount: hits.length },
  });
}

function evalRatioAnomaly(ctx: {
  ruleId: string;
  algorithmId: string;
  severity: FinanceRuleSeverity;
  title: string;
  template: string;
  periodKey: string;
  pool: FinanceDataPoolConfigFile | null;
  records: any[];
  target: any;
  params: any;
}): FinanceRuleAlertItem | null {
  const numPool = String(ctx.target?.numeratorPoolId ?? "").trim();
  const denPool = String(ctx.target?.denominatorPoolId ?? "").trim();
  if (!numPool || !denPool) return null;
  const timeGrain = String(ctx.params?.timeGrain ?? "month");

  const bucketByGrain = (poolId: string, offset: number): any[] => {
    const poolRows = filterRecordsByPool(ctx.records, ctx.pool, poolId);
    if (timeGrain === "week") {
      const ws = momentFn().startOf("week").subtract(offset, "weeks");
      const we = ws.clone().endOf("week");
      return poolRows.filter((r) => {
        const d = normRecordDate(r);
        const m = momentFn(d, "YYYY-MM-DD", true);
        return m.isValid() && m.isSameOrAfter(ws, "day") && m.isSameOrBefore(we, "day");
      });
    }
    // default month
    const key = momentFn(`${ctx.periodKey}-01`, "YYYY-MM-DD").subtract(offset, "months").format("YYYY-MM");
    return poolRows.filter((r) => inMonth(r, key));
  };

  const numBucket = bucketByGrain(numPool, 0);
  const denBucket = bucketByGrain(denPool, 0);
  const num = sumAbsAmount(numBucket);
  const den = sumAbsAmount(denBucket);
  const ratio = den > 0 ? num / den : Infinity;
  const mode = String(ctx.params?.ratioMode ?? "absolute_threshold");
  if (mode === "absolute_threshold") {
    const thr = Number(ctx.params?.ratioThreshold ?? NaN);
    if (!(Number.isFinite(thr) && thr >= 0)) return null;
    if (!(ratio > thr)) return null;
    return buildAlert({
      ruleId: ctx.ruleId,
      severity: ctx.severity,
      title: ctx.title,
      message: ctx.template,
      algorithmId: ctx.algorithmId,
      effectivePeriod: ctx.periodKey,
      related: [...numBucket, ...denBucket],
      explain: { ratio, threshold: thr, numerator: num, denominator: den, numeratorPoolId: numPool, denominatorPoolId: denPool },
    });
  }
  if (mode === "baseline_compare") {
    const lookback = Math.max(1, Math.floor(Number(ctx.params?.lookbackPeriods ?? 0)));
    const baselineMethod = String(ctx.params?.baselineMethod ?? "mean");
    const thrMul = Number(ctx.params?.thresholdMultiplier ?? NaN);
    const thrOff = Number(ctx.params?.thresholdOffset ?? NaN);
    const minSample = Math.max(1, Math.floor(Number(ctx.params?.minSampleSize ?? 1)));
    const cur = ratio;
    const series: number[] = [];
    for (let i = 1; i <= lookback; i++) {
      const n2 = sumAbsAmount(bucketByGrain(numPool, i));
      const d2 = sumAbsAmount(bucketByGrain(denPool, i));
      if (d2 <= 0) continue;
      series.push(n2 / d2);
    }
    if (series.length < minSample) return null;
    const base = baselineMethod === "median" ? median(series) : mean(series);
    if (!Number.isFinite(base)) return null;
    let hit = false;
    if (Number.isFinite(thrMul)) hit = cur > base * thrMul;
    else if (Number.isFinite(thrOff)) hit = cur > base + thrOff;
    if (!hit) return null;
    return buildAlert({
      ruleId: ctx.ruleId,
      severity: ctx.severity,
      title: ctx.title,
      message: ctx.template,
      algorithmId: ctx.algorithmId,
      effectivePeriod: ctx.periodKey,
      related: [...numBucket, ...denBucket],
      explain: { ratio: cur, baseline: base, historySeries: series, numeratorPoolId: numPool, denominatorPoolId: denPool },
    });
  }
  return null;
}

function evalBaselineDeviation(ctx: {
  ruleId: string;
  algorithmId: string;
  severity: FinanceRuleSeverity;
  title: string;
  template: string;
  periodKey: string;
  poolId: string;
  pool: FinanceDataPoolConfigFile | null;
  filters?: any;
  records: any[];
  params: any;
}): FinanceRuleAlertItem | null {
  const timeGrain = String(ctx.params?.timeGrain ?? "month");
  const currentPeriod = String(ctx.params?.currentPeriod ?? "current");
  const partialPeriodStrategy = String(ctx.params?.partialPeriodStrategy ?? "close_only");
  const lookback = Math.max(1, Math.floor(Number(ctx.params?.lookbackPeriods ?? 0)));
  const baselineMethod = String(ctx.params?.baselineMethod ?? "mean");
  const compareOp = String(ctx.params?.compareOperator ?? "gt");
  const thresholdMode = String(ctx.params?.thresholdMode ?? "multiplier");
  const thresholdValue = Number(ctx.params?.thresholdValue ?? NaN);
  const minSample = Math.max(1, Math.floor(Number(ctx.params?.minSampleSize ?? 1)));
  const statMetric = String(ctx.params?.statMetric ?? "sum");

  const poolRecordsRaw = filterRecordsByPool(ctx.records, ctx.pool, ctx.poolId);
  const poolRecords = applyRecordFilters(poolRecordsRaw, ctx.filters);

  const metricValue = (bucket: any[]): number =>
    statMetric === "count"
      ? countRecords(bucket)
      : statMetric === "single_max"
        ? Math.max(0, ...bucket.filter((r) => !isDeleted(r)).map((r) => Math.abs(Number(r?.amount ?? 0))))
        : sumAbsAmount(bucket);

  const weekWindow = (baseStart: any): { start: any; end: any } => {
    if (partialPeriodStrategy === "same_day_progress") {
      const nowW = momentFn().startOf("week");
      const days = Math.max(0, momentFn().diff(nowW, "days"));
      const end = baseStart.clone().add(days, "days").endOf("day");
      return { start: baseStart.clone().startOf("day"), end };
    }
    return { start: baseStart.clone().startOf("week"), end: baseStart.clone().endOf("week") };
  };

  const bucketByOffset = (offset: number): any[] => {
    if (timeGrain === "day") {
      if (currentPeriod === "rolling_3d") {
        const baseDay = momentFn().startOf("day").subtract(offset, "days");
        const start = baseDay.clone().subtract(2, "days");
        const end = baseDay.clone().endOf("day");
        return poolRecords.filter((r) => {
          const d = normRecordDate(r);
          const m = momentFn(d, "YYYY-MM-DD", true);
          return m.isValid() && m.isSameOrAfter(start, "day") && m.isSameOrBefore(end, "day");
        });
      }
      const dayKey = momentFn().subtract(offset, "days").format("YYYY-MM-DD");
      return poolRecords.filter((r) => inDay(r, dayKey));
    }

    if (timeGrain === "week") {
      const ws = momentFn().startOf("week").subtract(offset, "weeks");
      const { start, end } = weekWindow(ws);
      return poolRecords.filter((r) => {
        const d = normRecordDate(r);
        const m = momentFn(d, "YYYY-MM-DD", true);
        return m.isValid() && m.isSameOrAfter(start, "day") && m.isSameOrBefore(end, "day");
      });
    }

    // month（默认）
    const baseMonth = momentFn(`${ctx.periodKey}-01`, "YYYY-MM-DD", true);
    const monthStart = (baseMonth.isValid() ? baseMonth : momentFn().startOf("month")).clone().subtract(offset, "months");
    return poolRecords.filter((r) => {
      const d = normRecordDate(r);
      const m = momentFn(d, "YYYY-MM-DD", true);
      return m.isValid() && m.isSame(monthStart, "month");
    });
  };

  const bucketCur = bucketByOffset(0);
  const curVal = metricValue(bucketCur);

  const series: number[] = [];
  for (let i = 1; i <= lookback; i++) {
    const bucket = bucketByOffset(i);
    const v = metricValue(bucket);
    if (Number.isFinite(v)) series.push(v);
  }
  if (series.length < minSample) return null;
  const base = baselineMethod === "median" ? median(series) : mean(series);
  if (!Number.isFinite(base)) return null;
  if (!Number.isFinite(thresholdValue)) return null;

  let pass = false;
  let bound = base;
  if (thresholdMode === "multiplier") bound = base * thresholdValue;
  else if (thresholdMode === "offset") bound = base + thresholdValue;
  else if (thresholdMode === "absolute_value") bound = thresholdValue;

  if (compareOp === "gt") pass = curVal > bound;
  else if (compareOp === "lt") pass = curVal < bound;
  if (!pass) return null;

  return buildAlert({
    ruleId: ctx.ruleId,
    severity: ctx.severity,
    title: ctx.title,
    message: ctx.template,
    algorithmId: ctx.algorithmId,
    effectivePeriod: ctx.periodKey,
    related: bucketCur,
    explain: { currentValue: curVal, baselineValue: base, bound, compareOperator: compareOp, thresholdMode, thresholdValue, historySeries: series },
  });
}

function evalCountAnomaly(ctx: {
  ruleId: string;
  algorithmId: string;
  severity: FinanceRuleSeverity;
  title: string;
  template: string;
  periodKey: string;
  poolId: string;
  pool: FinanceDataPoolConfigFile | null;
  filters?: any;
  records: any[];
  params: any;
}): FinanceRuleAlertItem | null {
  const thr = Number(ctx.params?.countThreshold ?? NaN);
  const window = String(ctx.params?.countWindow ?? "");
  if (!Number.isFinite(thr)) return null;
  let filterFn: (r: any) => boolean = () => false;
  if (window === "current_month") filterFn = (r) => inMonth(r, ctx.periodKey);
  else if (window === "rolling_7d") {
    const start = momentFn().startOf("day").subtract(6, "days");
    const end = momentFn().endOf("day");
    filterFn = (r) => {
      const d = normRecordDate(r);
      if (!d) return false;
      const m = momentFn(d, "YYYY-MM-DD", true);
      return m.isValid() && m.isSameOrAfter(start, "day") && m.isSameOrBefore(end, "day");
    };
  }
  else if (window === "today") {
    const today = momentFn().format("YYYY-MM-DD");
    filterFn = (r) => normRecordDate(r) === today;
  } else if (window === "current_week") {
    const ws = momentFn().startOf("week");
    const we = momentFn().endOf("week");
    filterFn = (r) => {
      const d = normRecordDate(r);
      if (!d) return false;
      const m = momentFn(d, "YYYY-MM-DD", true);
      return m.isValid() && m.isSameOrAfter(ws, "day") && m.isSameOrBefore(we, "day");
    };
  } else {
    filterFn = (r) => inMonth(r, ctx.periodKey);
  }
  const bucketRaw = filterRecordsByPool(ctx.records, ctx.pool, ctx.poolId).filter(filterFn);
  const bucket = applyRecordFilters(bucketRaw, ctx.filters);
  const n = countRecords(bucket);
  if (!(n >= thr)) return null;
  return buildAlert({
    ruleId: ctx.ruleId,
    severity: ctx.severity,
    title: ctx.title,
    message: ctx.template,
    algorithmId: ctx.algorithmId,
    effectivePeriod: ctx.periodKey,
    related: bucket,
    explain: { count: n, threshold: thr, window },
  });
}

function evalExpectedMissing(ctx: {
  ruleId: string;
  algorithmId: string;
  severity: FinanceRuleSeverity;
  title: string;
  template: string;
  periodKey: string;
  poolId: string;
  pool: FinanceDataPoolConfigFile | null;
  cyclePlans?: FinanceCyclePlanRow[];
  records: any[];
  params: any;
}): FinanceRuleAlertItem | null {
  const timeGrain = String(ctx.params?.timeGrain ?? "month");
  const lookback = Math.max(1, Math.floor(Number(ctx.params?.lookbackPeriods ?? 0)));
  const minHits = Math.max(1, Math.floor(Number(ctx.params?.minExpectedHits ?? 1)));
  const grace = Math.max(0, Math.floor(Number(ctx.params?.graceDays ?? 0)));
  const sourceMode = String(ctx.params?.expectedSourceMode ?? "history_inference");
  const institutionRequired = ctx.params?.institutionRequired === true;
  const bucketAll = filterRecordsByPool(ctx.records, ctx.pool, ctx.poolId);
  const bucketCur =
    timeGrain === "week"
      ? bucketAll.filter((r) => {
          const d = normRecordDate(r);
          const m = momentFn(d, "YYYY-MM-DD", true);
          if (!m.isValid()) return false;
          return m.isSame(momentFn(), "week");
        })
      : bucketAll.filter((r) => inMonth(r, ctx.periodKey));

  const runFixedSchedule = (): { used: boolean; misses: { planId: string; institutionName: string; dueDate: string; graceDays: number }[]; matchedPlanCount: number } => {
    const poolDef = pickPool(ctx.pool, ctx.poolId);
    const nodes = Array.isArray((poolDef as any)?.nodes) ? ((poolDef as any).nodes as FinanceDataPoolNode[]) : [];
    const plansRaw = Array.isArray(ctx.cyclePlans) ? ctx.cyclePlans : [];
    const plans = plansRaw.filter((p) => p && p.enabled && !String(p.deletedAt ?? "").trim() && String(p.cycleType ?? "none") !== "none");
    const matchedPlans = plans.filter((p) => nodes.some((n) => planMatchPoolNode(p, n, institutionRequired)));
    if (matchedPlans.length === 0) return { used: false, misses: [], matchedPlanCount: 0 };

    const now = momentFn();
    const misses: { planId: string; institutionName: string; dueDate: string; graceDays: number }[] = [];
    for (const p of matchedPlans) {
      const dueDate = dueDateByPlanInMonth(p, ctx.periodKey);
      if (!dueDate) continue;
      const pGrace = Number.isFinite(Number(p.graceDays)) ? Math.max(0, Math.floor(Number(p.graceDays))) : grace;
      const due = momentFn(dueDate, "YYYY-MM-DD", true).add(pGrace, "days");
      if (!due.isValid() || now.isBefore(due, "day")) continue;

      const inst = String(p.institutionName ?? "").trim().replace(/\s+/g, " ");
      const sub = normalizeFinanceSubcategory(String(p.subcategory ?? ""));
      const curHits = bucketCur.filter((r) => {
        if (normCatId(r) !== String(p.catId ?? "").trim()) return false;
        if (normalizeFinanceSubcategory(normSubcategoryFromRecord(r)) !== sub) return false;
        if (institutionRequired) return normInstitutionFromRecord(r) === inst;
        return true;
      });
      if (countRecords(curHits) > 0) continue;
      misses.push({ planId: String(p.id ?? ""), institutionName: inst, dueDate, graceDays: pGrace });
    }
    return { used: true, misses, matchedPlanCount: matchedPlans.length };
  };

  // fixed_schedule：只看周期表
  if (sourceMode === "fixed_schedule") {
    const r = runFixedSchedule();
    if (!r.used) return null;
    if (r.misses.length === 0) return null;
    return buildAlert({
      ruleId: ctx.ruleId,
      severity: ctx.severity,
      title: ctx.title,
      message: ctx.template,
      algorithmId: ctx.algorithmId,
      effectivePeriod: ctx.periodKey,
      related: [],
      explain: {
        expectedSourceMode: "fixed_schedule",
        institutionRequired,
        matchedPlanCount: r.matchedPlanCount,
        missingPlanCount: r.misses.length,
        missingSamples: r.misses.slice(0, 12),
      },
    });
  }

  // hybrid：优先周期表，若无匹配计划再回退 history_inference
  if (sourceMode === "hybrid") {
    const r = runFixedSchedule();
    if (r.used) {
      if (r.misses.length === 0) return null;
      return buildAlert({
        ruleId: ctx.ruleId,
        severity: ctx.severity,
        title: ctx.title,
        message: ctx.template,
        algorithmId: ctx.algorithmId,
        effectivePeriod: ctx.periodKey,
        related: [],
        explain: {
          expectedSourceMode: "hybrid:fixed_schedule",
          institutionRequired,
          matchedPlanCount: r.matchedPlanCount,
          missingPlanCount: r.misses.length,
          missingSamples: r.misses.slice(0, 12),
        },
      });
    }
  }

  // history_inference（以及 hybrid 回退）：从历史发生规律推断本期应发生点
  const now = momentFn();
  const keyFn = (r: any) => {
    if (!institutionRequired) return "__ALL__";
    return normInstitutionFromRecord(r) || "__NO_INST__";
  };

  const groups = new Set<string>();
  for (const r of bucketAll) {
    const k = keyFn(r);
    if (k !== "__NO_INST__") groups.add(k);
  }
  if (groups.size === 0) return null;

  const misses: { groupKey: string; inferredAnchorDay: number; dueDate: string; historyHitPeriods: number }[] = [];
  for (const g of groups) {
    const curGroup = bucketCur.filter((r) => keyFn(r) === g);
    if (countRecords(curGroup) > 0) continue;

    const histHits: string[] = [];
    const histDays: number[] = [];
    for (let i = 1; i <= lookback; i++) {
      if (timeGrain === "week") {
        const ws = momentFn().startOf("week").subtract(i, "weeks");
        const we = ws.clone().endOf("week");
        const bucketW = bucketAll.filter((r) => {
          if (keyFn(r) !== g) return false;
          const d = normRecordDate(r);
          const m = momentFn(d, "YYYY-MM-DD", true);
          return m.isValid() && m.isSameOrAfter(ws, "day") && m.isSameOrBefore(we, "day");
        });
        if (countRecords(bucketW) <= 0) continue;
        histHits.push(ws.format("YYYY-[W]WW"));
        for (const rr of bucketW) {
          const d = momentFn(normRecordDate(rr), "YYYY-MM-DD", true);
          if (d.isValid()) histDays.push(Number(d.isoWeekday()));
        }
      } else {
        const ym = momentFn(`${ctx.periodKey}-01`, "YYYY-MM-DD").subtract(i, "months").format("YYYY-MM");
        const bucketM = bucketAll.filter((r) => inMonth(r, ym) && keyFn(r) === g);
        if (countRecords(bucketM) <= 0) continue;
        histHits.push(ym);
        for (const rr of bucketM) {
          const d = momentFn(normRecordDate(rr), "YYYY-MM-DD", true);
          if (d.isValid()) histDays.push(Number(d.format("D")));
        }
      }
    }
    if (histHits.length < minHits) continue;
    const anchorDay = timeGrain === "week" ? Math.max(1, Math.min(7, Math.round(median(histDays)))) : Math.max(1, Math.min(31, Math.round(median(histDays))));
    const dueDate =
      timeGrain === "week"
        ? momentFn().startOf("week").add(anchorDay - 1, "days").format("YYYY-MM-DD")
        : monthDayCapped(ctx.periodKey, anchorDay);
    const due = momentFn(dueDate, "YYYY-MM-DD", true).add(grace, "days");
    if (!due.isValid() || now.isBefore(due, "day")) continue;
    misses.push({ groupKey: g, inferredAnchorDay: anchorDay, dueDate, historyHitPeriods: histHits.length });
  }
  if (misses.length === 0) return null;

  return buildAlert({
    ruleId: ctx.ruleId,
    severity: ctx.severity,
    title: ctx.title,
    message: ctx.template,
    algorithmId: ctx.algorithmId,
    effectivePeriod: ctx.periodKey,
    related: [],
    explain: {
      expectedSourceMode: sourceMode === "hybrid" ? "hybrid:history_inference" : "history_inference",
      institutionRequired,
      lookbackPeriods: lookback,
      minExpectedHits: minHits,
      graceDays: grace,
      missingGroupCount: misses.length,
      missingSamples: misses.slice(0, 12),
    },
  });
}

function evalCompositeLinkage(ctx: {
  ruleId: string;
  severity: FinanceRuleSeverity;
  title: string;
  template: string;
  periodKey: string;
  pool: FinanceDataPoolConfigFile | null;
  budget: FinanceBudgetConfigFile | null;
  cyclePlans?: FinanceCyclePlanRow[];
  records: any[];
  params: any;
}): FinanceRuleAlertItem | null {
  const logic = String(ctx.params?.logicOperator ?? "AND");
  const windowConstraint = String(ctx.params?.windowConstraint ?? "");
  const minConditionsHit = ctx.params?.minConditionsHit != null ? Math.max(1, Math.floor(Number(ctx.params.minConditionsHit))) : 1;
  const conds = Array.isArray(ctx.params?.conditions) ? ctx.params.conditions : [];
  if (conds.length === 0) return null;
  const hits: FinanceRuleAlertItem[] = [];
  for (const c of conds as any[]) {
    const cid = String(c?.conditionId ?? "").trim() || "condition";
    const alg = String(c?.algorithmId ?? "").trim();
    const target = c?.target ?? {};
    const params = c?.params ?? {};
    const title = `条件 ${cid}`;
    const template = `条件 ${cid} 命中`;
    const sev: FinanceRuleSeverity = "notice";
    const a = evalOneAlgorithm({
      ruleId: `${ctx.ruleId}::${cid}`,
      algorithmId: alg,
      severity: sev,
      title,
      template,
      periodKey: ctx.periodKey,
      pool: ctx.pool,
      budget: ctx.budget,
      cyclePlans: ctx.cyclePlans,
      records: ctx.records,
      target,
      filters: c?.filters ?? {},
      params,
    });
    if (a) hits.push(a);
  }
  let ok = logic === "AND" ? hits.length === conds.length : hits.length >= minConditionsHit;
  if (ok && windowConstraint === "same_period" && hits.length > 1) {
    const p0 = String(hits[0].effectivePeriod ?? "");
    ok = hits.every((h) => String(h.effectivePeriod ?? "") === p0);
  }
  if (!ok) return null;
  const related = hits.flatMap((h) => (h.relatedEntryIds ?? []).map((id) => ({ entry_id: id })));
  return buildAlert({
    ruleId: ctx.ruleId,
    severity: ctx.severity,
    title: ctx.title,
    message: ctx.template,
    algorithmId: "ALG_COMPOSITE_LINKAGE",
    effectivePeriod: ctx.periodKey,
    related,
    explain: { logicOperator: logic, windowConstraint, minConditionsHit, hitConditions: hits.map((h) => h.ruleId) },
  });
}

function evalOneAlgorithm(args: {
  ruleId: string;
  algorithmId: string;
  severity: FinanceRuleSeverity;
  title: string;
  template: string;
  periodKey: string;
  pool: FinanceDataPoolConfigFile | null;
  budget: FinanceBudgetConfigFile | null;
  cyclePlans?: FinanceCyclePlanRow[];
  records: any[];
  target: any;
  filters?: any;
  params: any;
}): FinanceRuleAlertItem | null {
  const alg = String(args.algorithmId ?? "").trim();
  if (!alg) return null;
  if (alg === "ALG_BUDGET_BREACH") {
    return evalBudgetBreach({
      ruleId: args.ruleId,
      algorithmId: alg,
      severity: args.severity,
      title: args.title,
      template: args.template,
      periodKey: args.periodKey,
      poolId: String(args.target?.targetPoolId ?? "").trim(),
      budgetId: String(args.target?.budgetId ?? "").trim(),
      budget: args.budget,
      pool: args.pool,
      records: args.records,
      params: args.params,
    });
  }
  if (alg === "ALG_ABSOLUTE_THRESHOLD") {
    return evalAbsoluteThreshold({
      ruleId: args.ruleId,
      algorithmId: alg,
      severity: args.severity,
      title: args.title,
      template: args.template,
      periodKey: args.periodKey,
      poolId: String(args.target?.targetPoolId ?? "").trim(),
      pool: args.pool,
      records: args.records,
      params: args.params,
    });
  }
  if (alg === "ALG_RATIO_ANOMALY") {
    return evalRatioAnomaly({
      ruleId: args.ruleId,
      algorithmId: alg,
      severity: args.severity,
      title: args.title,
      template: args.template,
      periodKey: args.periodKey,
      pool: args.pool,
      records: args.records,
      target: args.target,
      params: args.params,
    });
  }
  if (alg === "ALG_BASELINE_DEVIATION") {
    return evalBaselineDeviation({
      ruleId: args.ruleId,
      algorithmId: alg,
      severity: args.severity,
      title: args.title,
      template: args.template,
      periodKey: args.periodKey,
      poolId: String(args.target?.targetPoolId ?? "").trim(),
      pool: args.pool,
      filters: args.filters,
      records: args.records,
      params: args.params,
    });
  }
  if (alg === "ALG_COUNT_ANOMALY") {
    return evalCountAnomaly({
      ruleId: args.ruleId,
      algorithmId: alg,
      severity: args.severity,
      title: args.title,
      template: args.template,
      periodKey: args.periodKey,
      poolId: String(args.target?.targetPoolId ?? "").trim(),
      pool: args.pool,
      filters: args.filters,
      records: args.records,
      params: args.params,
    });
  }
  if (alg === "ALG_EXPECTED_MISSING") {
    return evalExpectedMissing({
      ruleId: args.ruleId,
      algorithmId: alg,
      severity: args.severity,
      title: args.title,
      template: args.template,
      periodKey: args.periodKey,
      poolId: String(args.target?.targetPoolId ?? "").trim(),
      pool: args.pool,
      records: args.records,
      params: args.params,
    });
  }
  if (alg === "ALG_PERCENTILE_SPIKE") {
    return evalPercentileSpike({
      ruleId: args.ruleId,
      algorithmId: alg,
      severity: args.severity,
      title: args.title,
      template: args.template,
      periodKey: args.periodKey,
      poolId: String(args.target?.targetPoolId ?? "").trim(),
      pool: args.pool,
      filters: args.filters,
      records: args.records,
      params: args.params,
    });
  }
  if (alg === "ALG_NEW_ENTITY_GROWTH") {
    return evalNewEntityGrowth({
      ruleId: args.ruleId,
      algorithmId: alg,
      severity: args.severity,
      title: args.title,
      template: args.template,
      periodKey: args.periodKey,
      poolId: String(args.target?.targetPoolId ?? "").trim(),
      pool: args.pool,
      filters: args.filters,
      records: args.records,
      params: args.params,
    });
  }
  if (alg === "ALG_DERIVED_METRIC_DEVIATION") {
    return evalDerivedMetricDeviation({
      ruleId: args.ruleId,
      algorithmId: alg,
      severity: args.severity,
      title: args.title,
      template: args.template,
      periodKey: args.periodKey,
      pool: args.pool,
      filters: args.filters,
      records: args.records,
      params: args.params,
    });
  }
  if (alg === "ALG_SEQUENCE_ANOMALY") {
    return evalSequenceAnomaly({
      ruleId: args.ruleId,
      algorithmId: alg,
      severity: args.severity,
      title: args.title,
      template: args.template,
      periodKey: args.periodKey,
      pool: args.pool,
      records: args.records,
      target: args.target,
      params: args.params,
    });
  }
  if (alg === "ALG_PERIOD_BREAK") {
    return evalPeriodBreak({
      ruleId: args.ruleId,
      algorithmId: alg,
      severity: args.severity,
      title: args.title,
      template: args.template,
      periodKey: args.periodKey,
      poolId: String(args.target?.targetPoolId ?? "").trim(),
      pool: args.pool,
      cyclePlans: args.cyclePlans,
      filters: args.filters,
      records: args.records,
      params: args.params,
    });
  }
  if (alg === "ALG_COMPOSITE_AND") {
    return evalCompositeAnd({
      ruleId: args.ruleId,
      severity: args.severity,
      title: args.title,
      template: args.template,
      periodKey: args.periodKey,
      pool: args.pool,
      budget: args.budget,
      cyclePlans: args.cyclePlans,
      records: args.records,
      params: args.params,
    });
  }
  if (alg === "ALG_COMPOSITE_LINKAGE") {
    return evalCompositeLinkage({
      ruleId: args.ruleId,
      severity: args.severity,
      title: args.title,
      template: args.template,
      periodKey: args.periodKey,
      pool: args.pool,
      budget: args.budget,
      cyclePlans: args.cyclePlans,
      records: args.records,
      params: args.params,
    });
  }
  // 其它算法先不执行（后续逐个补齐）
  return null;
}

/**
 * 对单个自然月执行规则引擎（与 writeFinanceRulesAlertSnapshot 一致）。
 * `records` 须为未删除的全量财务索引条目，算法内部按 periodKey 取当月与回看窗口。
 */
export function computeFinanceRuleAlertsForPeriodKey(args: {
  periodKey: string;
  records: any[];
  pool: FinanceDataPoolConfigFile | null;
  budget: FinanceBudgetConfigFile | null;
  cyclePlans: FinanceCyclePlanRow[];
  rules: Record<string, any>;
}): FinanceRuleAlertItem[] {
  const { periodKey, records, pool, budget, cyclePlans, rules } = args;
  const alerts: FinanceRuleAlertItem[] = [];
  const reg = financeAlgorithmRegistry();
  for (const [ruleId, r] of Object.entries(rules)) {
    if ((r as any)?.enabled === false) continue;
    const algorithmId = String((r as any)?.algorithmId ?? "").trim();
    if (!algorithmId || !reg[algorithmId]) continue;
    const sev = (String((r as any)?.severity ?? "notice") as any) as FinanceRuleSeverity;
    const msg = (r as any)?.message ?? {};
    const title = String(msg?.title ?? (r as any)?.ruleName ?? ruleId);
    const template = String(msg?.template ?? title);
    const target = (r as any)?.target ?? {};
    const params = (r as any)?.params ?? {};
    const a = evalOneAlgorithm({
      ruleId,
      algorithmId,
      severity: sev,
      title,
      template,
      periodKey,
      pool,
      budget,
      cyclePlans,
      records,
      target,
      filters: (r as any)?.filters ?? {},
      params,
    });
    if (a) alerts.push(a);
  }
  const sevRank: Record<string, number> = { high: 0, warning: 1, notice: 2 };
  alerts.sort((a, b) => (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9));
  return alerts;
}

export async function writeFinanceRulesAlertSnapshot(plugin: any, mode: string): Promise<void> {
  try {
    const spaceId = String(plugin?.getSpaceCtx?.()?.spaceId ?? "default");
    const root = String(plugin?.getSpaceIndexDir?.() ?? "").trim();
    if (!root) return;
    const dir = normalizePath(`${root}/finance-analysis`);
    const path = normalizePath(`${dir}/finance-rules.alerts.json`);
    await ensureFolder(plugin, dir);

    const { pool, budget, rulesText } = await readFinanceConfigFiles(plugin);
    const vr = validateFinanceRuleConfig({ ruleText: rulesText, pool, budget });
    const issues = vr.issues.filter((x) => x.level === "error").map((x) => (x.ruleId ? `[${x.ruleId}] ${x.message}` : x.message));
    const rules = (vr.file?.rules ?? {}) as Record<string, any>;

    const fsnap = await plugin?.recordRSLatte?.getFinanceSnapshot?.(false);
    const items = Array.isArray(fsnap?.items) ? fsnap.items : [];
    const activeItems = items.filter((x: any) => !isDeleted(x));
    const cyclePlans = Array.isArray(plugin?.settings?.financeCyclePlans) ? (plugin.settings.financeCyclePlans as FinanceCyclePlanRow[]) : [];

    const periodKey = momentFn().format("YYYY-MM");
    const alerts = computeFinanceRuleAlertsForPeriodKey({
      periodKey,
      pool,
      budget,
      cyclePlans,
      rules,
      records: activeItems,
    });

    const sc = severityCount(alerts);
    const file: FinanceRulesAlertFile = {
      version: 1,
      generatedAt: new Date().toISOString(),
      spaceId,
      mode: String(mode ?? ""),
      periodKey,
      status: issues.length ? "error" : "ok",
      issues: issues.length ? issues.slice(0, 50) : undefined,
      alerts,
      summary: {
        total: alerts.length,
        high: sc.high,
        warning: sc.warning,
        notice: sc.notice,
      },
    };
    await plugin.app.vault.adapter.write(path, JSON.stringify(file, null, 2));
  } catch (e) {
    console.warn("[RSLatte][finance-analysis] write rules alerts failed", e);
  }
}

export async function readFinanceRulesAlertSnapshot(plugin: any): Promise<FinanceRulesAlertFile | null> {
  try {
    const root = String(plugin?.getSpaceIndexDir?.() ?? "").trim();
    if (!root) return null;
    const path = normalizePath(`${root}/finance-analysis/finance-rules.alerts.json`);
    const ok = await plugin.app.vault.adapter.exists(path);
    if (!ok) return null;
    const raw = await plugin.app.vault.adapter.read(path);
    const j = JSON.parse(String(raw ?? "{}"));
    if (!j || typeof j !== "object") return null;
    if (j.version !== 1) return null;
    return j as FinanceRulesAlertFile;
  } catch (e) {
    console.warn("[RSLatte][finance-analysis] read rules alerts failed", e);
    return null;
  }
}

