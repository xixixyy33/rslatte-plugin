/**
 * Pipeline / coordinator / spaceStats 共用的「模块是否参与调度与统计」判定。
 * 与 createPipelineEngine 内逻辑保持一致，避免未注入 _pipelineIsEnabled 时误当作全开。
 */
import type { RSLatteModuleKey } from "../services/pipeline/types";

export function buildPipelineModuleIsEnabled(plugin: any): (moduleKey: RSLatteModuleKey) => boolean {
  return (moduleKey: RSLatteModuleKey): boolean => {
    if (plugin.isPluginEnvInitModuleGateOpen?.() !== true) return false;
    const v2: any = plugin.settings?.moduleEnabledV2 ?? {};

    if (moduleKey === "task") return plugin.isTaskModuleEnabledV2?.() !== false;
    if (moduleKey === "memo") return plugin.isMemoModuleEnabledV2?.() !== false;
    if (moduleKey === "schedule") {
      if (typeof v2.schedule === "boolean") return v2.schedule;
      return plugin.isMemoModuleEnabledV2?.() !== false;
    }

    if (moduleKey === "checkin") {
      if (typeof v2.checkin === "boolean") return v2.checkin;
      return plugin.isModuleEnabled?.("record") ?? false;
    }
    if (moduleKey === "finance") {
      if (typeof v2.finance === "boolean") return v2.finance;
      return plugin.isModuleEnabled?.("record") ?? false;
    }
    if (moduleKey === "health") {
      return plugin.isHealthModuleEnabled?.() === true;
    }

    if (moduleKey === "project") {
      if (typeof v2.project === "boolean") return v2.project;
      return plugin.isModuleEnabled?.("project") ?? false;
    }
    if (moduleKey === "output") {
      if (typeof v2.output === "boolean") return v2.output;
      return plugin.isModuleEnabled?.("output") ?? false;
    }
    if (moduleKey === "contacts") {
      if (typeof v2.contacts === "boolean") return v2.contacts;
      return plugin.isContactsModuleEnabledV2?.() !== false;
    }
    if (moduleKey === "knowledge") {
      // 与 pipelineManager 一致：允许显式 runE2；是否参与自动调度由 coordinator 单独门控
      return true;
    }
    return false;
  };
}
