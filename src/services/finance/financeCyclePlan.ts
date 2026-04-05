/**
 * 财务周期表：匹配键、ID 生成、冲突检测
 * @see docs/V2改造方案/记录类管理优化方案.md「已定稿」
 */

import type { FinanceCyclePlanRow } from "../../types/rslatteTypes";
import { normalizeFinanceCycleType, type FinanceCycleType } from "../../types/rslatteTypes";
import { normalizeFinanceSubcategory } from "./financeSubcategory";

export function generateFinanceCyclePlanId(): string {
  const rnd =
    typeof crypto !== "undefined" && crypto.getRandomValues
      ? Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("")
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return `FCP_${rnd}`;
}

export function normFinanceInstitution(s: string): string {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function normKeySub(s: string): string {
  return normalizeFinanceSubcategory(String(s ?? ""));
}

/** 未软删的周期计划 */
export function activeFinanceCyclePlans(plans: FinanceCyclePlanRow[] | undefined): FinanceCyclePlanRow[] {
  const arr = Array.isArray(plans) ? plans : [];
  return arr.filter((p) => !String(p?.deletedAt ?? "").trim());
}

/** 四元组全等（用于查找表行） */
export function matchFinanceCyclePlanQuadruple(
  row: FinanceCyclePlanRow,
  catId: string,
  subcategory: string,
  institutionName: string,
  cycleType: FinanceCycleType
): boolean {
  if (String(row.catId) !== String(catId)) return false;
  if (normKeySub(row.subcategory) !== normKeySub(subcategory)) return false;
  if (normFinanceInstitution(row.institutionName) !== normFinanceInstitution(institutionName)) return false;
  return normalizeFinanceCycleType(row.cycleType) === normalizeFinanceCycleType(cycleType);
}

export function findFinanceCyclePlanByQuadruple(
  plans: FinanceCyclePlanRow[] | undefined,
  catId: string,
  subcategory: string,
  institutionName: string,
  cycleType: FinanceCycleType
): FinanceCyclePlanRow | null {
  for (const p of activeFinanceCyclePlans(plans)) {
    if (matchFinanceCyclePlanQuadruple(p, catId, subcategory, institutionName, cycleType)) return p;
  }
  return null;
}

/**
 * 是否存在**已启用**的周期计划：同分类+子类+机构，但周期类型与当前选择不同 → 禁止保存
 */
export function findConflictingEnabledFinanceCyclePlan(
  plans: FinanceCyclePlanRow[] | undefined,
  catId: string,
  subcategory: string,
  institutionName: string,
  selectedCycle: FinanceCycleType
): FinanceCyclePlanRow | null {
  if (selectedCycle === "none") return null;
  const inst = normFinanceInstitution(institutionName);
  const sub = normKeySub(subcategory);
  for (const p of activeFinanceCyclePlans(plans)) {
    if (!p.enabled) continue;
    if (String(p.catId) !== String(catId)) continue;
    if (normKeySub(p.subcategory) !== sub) continue;
    if (normFinanceInstitution(p.institutionName) !== inst) continue;
    if (normalizeFinanceCycleType(p.cycleType) !== normalizeFinanceCycleType(selectedCycle)) return p;
  }
  return null;
}

/** 同四元组且已存在行但未启用 → 提示启用 */
export function findDisabledQuadruplePlan(
  plans: FinanceCyclePlanRow[] | undefined,
  catId: string,
  subcategory: string,
  institutionName: string,
  cycleType: FinanceCycleType
): FinanceCyclePlanRow | null {
  const hit = findFinanceCyclePlanByQuadruple(plans, catId, subcategory, institutionName, cycleType);
  if (hit && !hit.enabled) return hit;
  return null;
}

/** 同分类+子分类+机构是否存在已启用周期行（不限定周期类型；用于「无周期」流水提示） */
export function findAnyEnabledFinanceCyclePlanSameTriple(
  plans: FinanceCyclePlanRow[] | undefined,
  catId: string,
  subcategory: string,
  institutionName: string
): FinanceCyclePlanRow | null {
  const sub = normKeySub(subcategory);
  const inst = normFinanceInstitution(institutionName);
  for (const p of activeFinanceCyclePlans(plans)) {
    if (!p.enabled) continue;
    if (String(p.catId) !== String(catId)) continue;
    if (normKeySub(p.subcategory) !== sub) continue;
    if (normFinanceInstitution(p.institutionName) !== inst) continue;
    return p;
  }
  return null;
}

export function findFinanceCyclePlanById(
  plans: FinanceCyclePlanRow[] | undefined,
  id: string
): FinanceCyclePlanRow | null {
  const sid = String(id ?? "").trim();
  if (!sid) return null;
  for (const p of activeFinanceCyclePlans(plans)) {
    if (String(p.id) === sid) return p;
  }
  return null;
}
