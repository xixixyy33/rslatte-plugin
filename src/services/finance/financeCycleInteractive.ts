/**
 * 记账弹窗：周期表交互（confirm + 写设置）
 */

import type RSLattePlugin from "../../main";
import { Notice } from "obsidian";
import type { FinanceCyclePlanRow } from "../../types/rslatteTypes";
import { FINANCE_CYCLE_LABELS, normalizeFinanceCycleType, type FinanceCycleType } from "../../types/rslatteTypes";
import {
  findConflictingEnabledFinanceCyclePlan,
  findDisabledQuadruplePlan,
  findFinanceCyclePlanByQuadruple,
  generateFinanceCyclePlanId,
  normFinanceInstitution,
} from "./financeCyclePlan";
import { normalizeFinanceSubcategory } from "./financeSubcategory";

export type CycleMetaResolution = {
  /** 写入 meta.cycle_id；undefined 表示不写入该键（无周期流水） */
  cycleIdForMeta?: string;
};

/**
 * 在保存前调用：可能改写 plugin.settings.financeCyclePlans 并 saveSettings（启用行 / 新增行）。
 * @returns null 表示用户取消或冲突阻断
 */
export async function interactiveResolveCycleMetaForSave(
  plugin: RSLattePlugin,
  args: {
    catId: string;
    subcategory: string;
    institutionName: string;
    cycleType: FinanceCycleType;
    recordDateKey: string;
  }
): Promise<CycleMetaResolution | null> {
  const { catId, institutionName, cycleType, recordDateKey } = args;
  const sub = normalizeFinanceSubcategory(args.subcategory);
  const plans = plugin.settings.financeCyclePlans ?? [];
  if (!plugin.settings.financeCyclePlans) plugin.settings.financeCyclePlans = plans;

  if (cycleType === "none") {
    return { cycleIdForMeta: undefined };
  }

  const conflict = findConflictingEnabledFinanceCyclePlan(plans, catId, sub, institutionName, cycleType);
  if (conflict) {
    new Notice(
      `与周期表冲突：同分类+子分类+机构已存在「${FINANCE_CYCLE_LABELS[normalizeFinanceCycleType(conflict.cycleType)]}」周期计划，不能改为「${FINANCE_CYCLE_LABELS[cycleType]}」`
    );
    return null;
  }

  const quad = findFinanceCyclePlanByQuadruple(plans, catId, sub, institutionName, cycleType);
  if (quad?.enabled) {
    if (!quad.referenced) {
      quad.referenced = true;
      await plugin.saveSettings();
    }
    return { cycleIdForMeta: quad.id };
  }

  const disabledHit = findDisabledQuadruplePlan(plans, catId, sub, institutionName, cycleType);
  if (disabledHit) {
    const ok = window.confirm(
      "周期表中已有相同项但未启用，是否在设置中启用该周期计划？"
    );
    if (!ok) {
      return { cycleIdForMeta: "none" };
    }
    disabledHit.enabled = true;
    disabledHit.referenced = true;
    await plugin.saveSettings();
    new Notice("已启用周期计划");
    return { cycleIdForMeta: disabledHit.id };
  }

  const add = window.confirm(
    "当前周期项尚未在「财务管理 · 周期表」中登记，是否加入周期表？（选「取消」将仅在 meta 中标记为不入表）"
  );
  if (!add) {
    return { cycleIdForMeta: "none" };
  }

  const row: FinanceCyclePlanRow = sanitizeFinanceCyclePlanRow({
    id: generateFinanceCyclePlanId(),
    catId,
    subcategory: sub,
    institutionName: normFinanceInstitution(institutionName),
    cycleType,
    anchorDate: recordDateKey,
    graceDays: 3,
    enabled: true,
    referenced: true,
  });
  plans.push(row);
  await plugin.saveSettings();
  new Notice("已加入周期表");
  return { cycleIdForMeta: row.id };
}

function sanitizeFinanceCyclePlanRow(r: FinanceCyclePlanRow): FinanceCyclePlanRow {
  return {
    id: String(r.id ?? "").trim(),
    catId: String(r.catId ?? "").trim(),
    subcategory: normalizeFinanceSubcategory(String(r.subcategory ?? "")),
    institutionName: normFinanceInstitution(String(r.institutionName ?? "")),
    cycleType: normalizeFinanceCycleType(r.cycleType),
    anchorDate: String(r.anchorDate ?? "").trim(),
    graceDays: Math.max(0, Math.floor(Number(r.graceDays ?? 0))),
    enabled: !!r.enabled,
    referenced: !!r.referenced,
    deletedAt: r.deletedAt ? String(r.deletedAt) : undefined,
  };
}
