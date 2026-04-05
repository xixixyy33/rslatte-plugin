/** 日程分类内部 id（与设置中「日程分类」列表一致，写入 meta `schedule_category`） */
export type ScheduleCategory = string;

export type ScheduleRepeatRule = "none" | "weekly" | "monthly" | "quarterly" | "yearly";

export type ScheduleCreateInput = {
  text: string;
  scheduleDate: string;
  startTime: string;
  durationMin: number;
  category?: ScheduleCategory;
  repeatRule?: ScheduleRepeatRule;
  /** 从任务「录日程」创建时写入笔记 meta，进入 schedule-index 的 extra，便于与任务关联分析 */
  linkedTaskUid?: string;
  /** 与输出文档关联：写入日程 meta `linked_output_id`（与 frontmatter output_id 一致） */
  linkedOutputId?: string;
  /** 计时器日志（可选）：会写入日程 meta 的 timer_log，值为 encodeURIComponent 后的紧凑文本 */
  timerLog?: string;
};

/** 日程「结束并增加任务/提醒/日程」时仅写在日程 meta：`followup_task_uid` / `followup_memo_uid` / `followup_schedule_uid` 及对应 `*_tid`/`*_mid`（与任务侧 linked_schedule、提醒侧 arranged_schedule 区分） */
