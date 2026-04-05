/**
 * 任务管理侧栏：任务 / 提醒 / 日程卡片操作按钮的稳定 id。
 * 设置中勾选 id 表示该按钮收入「⋯」更多菜单（显隐条件仍由侧栏逻辑决定）。
 */

export const TASK_CARD_ACTION_CATALOG: Array<{ id: string; icon: string; label: string }> = [
  { id: "task_edit", icon: "✏️", label: "修改任务信息" },
  { id: "task_restore", icon: "♻️", label: "恢复（已完成/已取消）" },
  { id: "task_start", icon: "▶", label: "开始处理 / 重新激活" },
  { id: "task_wait_others", icon: "↻", label: "等待他人处理" },
  { id: "task_wait_until", icon: "⏸", label: "进入等待状态（等到某日）" },
  { id: "task_cancel", icon: "⛔", label: "取消任务" },
  { id: "task_done", icon: "✅", label: "完成任务" },
  { id: "task_postpone", icon: "↪", label: "延期" },
  { id: "task_star", icon: "⭐", label: "星标 / 取消星标" },
  { id: "task_record_schedule", icon: "📅", label: "录日程（仅进行中任务）" },
];

export const MEMO_CARD_ACTION_CATALOG: Array<{ id: string; icon: string; label: string }> = [
  { id: "memo_edit", icon: "✏️", label: "修改提醒信息" },
  { id: "memo_star", icon: "⭐", label: "星标 / 取消星标" },
  { id: "memo_invalidate", icon: "🚫", label: "失效 / 恢复周期" },
  { id: "memo_arrange", icon: "📌", label: "安排（转任务或转日程）" },
  { id: "memo_cancel", icon: "⛔", label: "标记为取消" },
  { id: "memo_done", icon: "✅", label: "标记为完成" },
];

export const MEMO_CLOSED_CARD_ACTION_CATALOG: Array<{ id: string; icon: string; label: string }> = [
  { id: "memo_closed_restore", icon: "♻️", label: "恢复" },
];

export const SCHEDULE_CARD_ACTION_CATALOG: Array<{ id: string; icon: string; label: string }> = [
  { id: "schedule_edit", icon: "✏️", label: "修改日程信息" },
  { id: "schedule_star", icon: "⭐", label: "星标 / 取消星标" },
  { id: "schedule_invalidate", icon: "🚫", label: "失效 / 恢复周期" },
  { id: "schedule_cancel", icon: "⛔", label: "标记为取消" },
  { id: "schedule_end", icon: "✅", label: "直接结束日程" },
  { id: "schedule_end_followup", icon: "⏭", label: "结束并新增任务/提醒/日程" },
];

export const SCHEDULE_CLOSED_CARD_ACTION_CATALOG: Array<{ id: string; icon: string; label: string }> = [
  { id: "schedule_closed_restore", icon: "♻️", label: "恢复" },
  { id: "schedule_closed_followup", icon: "🗂", label: "后续安排（已完成且无 followup 时）" },
];

export const PROJECT_TASK_CARD_ACTION_CATALOG: Array<{ id: string; icon: string; label: string }> = [
  { id: "project_task_edit", icon: "✏️", label: "修改项目任务信息" },
  { id: "project_task_start", icon: "▶", label: "开始处理 / 重新激活" },
  { id: "project_task_wait_others", icon: "↻", label: "等待他人处理" },
  { id: "project_task_wait_until", icon: "⏸", label: "进入等待状态（等到某日）" },
  { id: "project_task_cancel", icon: "⛔", label: "取消项目任务" },
  { id: "project_task_done", icon: "✅", label: "完成项目任务" },
  { id: "project_task_record_schedule", icon: "📅", label: "录日程（仅进行中任务）" },
  { id: "project_task_postpone", icon: "↪", label: "延期" },
  { id: "project_task_star", icon: "⭐", label: "星标 / 取消星标" },
];

export const PROJECT_MILESTONE_CARD_ACTION_CATALOG: Array<{ id: string; icon: string; label: string }> = [
  { id: "milestone_edit", icon: "✏️", label: "修改里程碑" },
  { id: "milestone_done", icon: "✅", label: "标记里程碑完成" },
  { id: "milestone_cancel", icon: "⛔", label: "取消里程碑" },
  { id: "milestone_postpone", icon: "↪", label: "里程碑延期" },
  { id: "milestone_restore", icon: "⏸", label: "恢复里程碑" },
  { id: "milestone_add", icon: "➕", label: "新增任务或子里程碑" },
];

export const PROJECT_CARD_ACTION_CATALOG: Array<{ id: string; icon: string; label: string }> = [
  { id: "project_recover", icon: "🔄", label: "恢复项目" },
  { id: "project_postpone", icon: "↪", label: "项目延期" },
  { id: "project_add_milestone", icon: "➕", label: "添加里程碑" },
  { id: "project_chart", icon: "📊", label: "打开项目分析图" },
  { id: "project_archive_doc", icon: "📄", label: "创建项目存档文件" },
  { id: "project_cancel", icon: "❌", label: "取消项目" },
  { id: "project_done", icon: "✅", label: "完成项目" },
];
