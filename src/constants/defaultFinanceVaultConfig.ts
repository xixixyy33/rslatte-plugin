/**
 * 财务：默认分类 / 数据池 / 预算 / 规则 JSON（与
 * docs/V2改造方案/05-01-财务统计优化方案JSON存档.md 中归档一致）。
 * 数据池与预算、规则在设置页「无文件」时的占位与「载入推荐模板」同源。
 */
import type { FinanceBudgetConfigFile, FinanceCatDef, FinanceDataPoolConfigFile } from "../types/rslatteTypes";

import financeBudgetsJson from "./financeDefaults/finance-budgets.default.json";
import financeCategoriesJson from "./financeDefaults/finance-categories.default.json";
import financePoolsJson from "./financeDefaults/finance-data-pools.default.json";
import financeRulesJson from "./financeDefaults/finance-rules.default.json";

function mapFinanceCategoryExportItems(raw: unknown): FinanceCatDef[] {
  const j = raw as { items?: unknown[] };
  const items = Array.isArray(j?.items) ? j.items : [];
  return items
    .map((x: any) => ({
      id: String(x?.id ?? "").trim(),
      name: String(x?.name ?? "").trim(),
      type: (x?.type === "income" ? "income" : "expense") as "income" | "expense",
      active: x?.active !== false,
      subCategories: Array.isArray(x?.subCategories)
        ? x.subCategories.map((s: unknown) => String(s ?? "").trim()).filter(Boolean)
        : [],
      institutionNames: Array.isArray(x?.institutionNames)
        ? x.institutionNames.map((s: unknown) => String(s ?? "").trim()).filter(Boolean)
        : [],
    }))
    .filter((c) => c.id && c.name);
}

/** 插件 data.json 默认 `financeCategories`（与文档「二）财务分类」一致） */
export const DEFAULT_FINANCE_CATEGORIES: FinanceCatDef[] = mapFinanceCategoryExportItems(financeCategoriesJson);

export const DEFAULT_FINANCE_POOL_CONFIG: FinanceDataPoolConfigFile =
  financePoolsJson as unknown as FinanceDataPoolConfigFile;

export const DEFAULT_FINANCE_BUDGET_CONFIG: FinanceBudgetConfigFile =
  financeBudgetsJson as unknown as FinanceBudgetConfigFile;

/** 规则 JSON 根对象（version + defaults + assumptions + rules） */
export const DEFAULT_FINANCE_RULES_CONFIG: Record<string, unknown> = financeRulesJson as unknown as Record<
  string,
  unknown
>;

export function cloneDefaultFinancePoolConfig(): FinanceDataPoolConfigFile {
  return JSON.parse(JSON.stringify(DEFAULT_FINANCE_POOL_CONFIG)) as FinanceDataPoolConfigFile;
}

export function cloneDefaultFinanceBudgetConfig(): FinanceBudgetConfigFile {
  return JSON.parse(JSON.stringify(DEFAULT_FINANCE_BUDGET_CONFIG)) as FinanceBudgetConfigFile;
}

export function cloneDefaultFinanceRulesConfig(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(DEFAULT_FINANCE_RULES_CONFIG)) as Record<string, unknown>;
}
