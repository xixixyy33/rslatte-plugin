/**
 * 任务索引衍生字段：与 `taskTags` / `taskImportance` 成对，供 `mergeIntoIndex("task")` 使用。
 */
import type { TaskPanelSettings } from "../../types/taskTypes";
import type { RSLatteIndexItem } from "../types";
import { computeTaskImportanceFromTags, computeTaskTags, getTaskTodayKey } from "../task";

export function applyTaskIndexDerivedFields(
  items: RSLatteIndexItem[],
  taskPanel: TaskPanelSettings | null | undefined
): { items: RSLatteIndexItem[]; tagsDerivedForYmd: string } {
  const taskToday = getTaskTodayKey(taskPanel);
  for (const it of items) {
    const tags = computeTaskTags(it, taskToday, taskPanel);
    (it as any).task_tags = tags;
    const imp = computeTaskImportanceFromTags(it, tags, taskToday);
    (it as any).importance_score = imp.score;
    (it as any).importance_is_risk = imp.isRisk;
    (it as any).importance_is_today_action = imp.isTodayAction;
  }
  return { items, tagsDerivedForYmd: taskToday };
}
