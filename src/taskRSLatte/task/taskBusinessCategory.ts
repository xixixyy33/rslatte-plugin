import type { TaskPanelSettings } from "../../types/taskTypes";

/** 首次安装或未配置时的默认分类（与设置页初始一致） */
export const DEFAULT_TASK_BUSINESS_CATEGORY_NAMES = ["学习", "工作", "生活"] as const;

export function getTaskBusinessCategories(tp: TaskPanelSettings | undefined): string[] {
  const raw = (tp as any)?.taskBusinessCategories;
  if (Array.isArray(raw) && raw.length > 0) {
    const out = raw.map((x) => String(x ?? "").trim()).filter(Boolean);
    if (out.length > 0) return [...new Set(out)];
  }
  return [...DEFAULT_TASK_BUSINESS_CATEGORY_NAMES];
}

/** 新建任务弹窗等使用的默认分类名（须在列表中；否则取列表首项） */
export function getDefaultTaskBusinessCategoryName(tp: TaskPanelSettings | undefined): string {
  const list = getTaskBusinessCategories(tp);
  const def = String((tp as any)?.defaultTaskBusinessCategory ?? "").trim();
  if (def && list.includes(def)) return def;
  return list[0] ?? "工作";
}

/** 写入 rslatte meta：避免破坏分号分隔；与提醒 extra 安全规则一致 */
export function sanitizeTaskCategoryForMeta(name: string): string {
  return String(name ?? "").trim().replace(/[;\s]+/g, "_");
}
