import type { WorkEventKind } from "../../types/stats/workEvent";
import type { RSLattePluginSettings } from "../../types/settings";

/** 默认模块颜色（作为后备） */
const DEFAULT_MODULE_COLORS: Record<WorkEventKind, string> = {
  checkin: "#4CAF50", // 绿色
  finance: "#FF9800", // 橙色
  health: "#E91E63", // 粉（健康）
  task: "#2196F3", // 蓝色
  projecttask: "#9C27B0", // 紫色
  memo: "#9C27B0", // 紫色
  schedule: "#00897B", // 青绿（日程）
  contact: "#E91E63", // 粉色
  project: "#00BCD4", // 青色
  milestone: "#009688", // 青绿色
  output: "#795548", // 棕色
  file: "#607D8B", // 蓝灰色
  sync: "#FFC107", // 黄色
  capture: "#5C6BC0", // 靛蓝（快速记录）
};

/** 获取模块颜色（从设置中读取，如果没有则使用默认值） */
export function getModuleColor(kind: WorkEventKind, settings?: RSLattePluginSettings): string {
  const statsSettings = (settings as any)?.statsSettings;
  if (statsSettings?.moduleColors?.[kind]) {
    return statsSettings.moduleColors[kind];
  }
  return DEFAULT_MODULE_COLORS[kind] || "#757575";
}
