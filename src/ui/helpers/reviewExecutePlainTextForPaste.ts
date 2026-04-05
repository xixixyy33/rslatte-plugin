import type {
  ReviewExecuteModel,
  ReviewExecuteOverviewStrip,
  ReviewExecuteTaskModuleBlock,
  ReviewExecuteMemoModuleBlock,
  ReviewExecuteScheduleModuleBlock,
  ReviewExecuteProjectModuleBlock,
  ReviewExecuteOutputModuleBlock,
  ReviewExecuteContactModuleBlock,
} from "./reviewExecuteModel";

function formatCompactScheduleHours(mins: number): string {
  const m = Math.max(0, Math.floor(Number(mins) || 0));
  if (m === 0) return "0h";
  const h = m / 60;
  if (Number.isInteger(h)) return `${h}h`;
  return `${h.toFixed(1)}h`;
}

function ensureOverviewStrip(model: ReviewExecuteModel): ReviewExecuteOverviewStrip {
  const o = model.overview;
  const defaults: ReviewExecuteOverviewStrip = {
    taskDone: o.tasksDone,
    taskProgressWe: 0,
    taskNew: 0,
    memoDone: o.memosDone,
    memoNew: 0,
    scheduleDone: o.schedulesDone ?? 0,
    scheduleNew: 0,
    projectDone: o.projectsCompletedInPeriod ?? 0,
    projectProgress: o.projectsPushed,
    projectNewWe: 0,
    outputDone: o.outputsDone,
    outputPublished: o.outputsPublished,
    outputProgressWe: 0,
    outputNew: o.outputsNew,
    contactInteract: o.contactEvents,
    contactNew: 0,
  };
  if (!model.overviewStrip) return defaults;
  return { ...defaults, ...model.overviewStrip };
}

function taskModuleLines(model: ReviewExecuteModel): string[] {
  const b = model.taskModuleBlock as ReviewExecuteTaskModuleBlock | undefined;
  if (b) {
    return [
      `· 周期内完成 **${b.completedInPeriod}** · 新建 **${b.created}** · 完成日晚于计划结束 **${b.doneAfterPlannedEnd}** 条`,
      `· 工时评估：日记任务约 **${b.diaryEstimateHours.toFixed(1)} h** + 项目任务约 **${b.projectEstimateHours.toFixed(1)} h**（完成日落在本周期）`,
    ];
  }
  return [model.modules.task];
}

function memoModuleLines(model: ReviewExecuteModel): string[] {
  const m = model.memoModuleBlock as ReviewExecuteMemoModuleBlock | undefined;
  if (m) {
    return [
      `· 周期内完成 **${m.completedInPeriod}** · 新建 **${m.created}** · 完成日晚于提醒日期 **${m.doneAfterMemoDate}**`,
      `· 生日 **${m.birthdayCount}** · 纪念日 **${m.anniversaryCount}** · 到期提醒 **${m.dueReminderCount}** · 一般提醒 **${m.generalReminderCount}**`,
      `· 转任务 **${m.arrangedToTaskCount}** · 转日程 **${m.arrangedToScheduleCount}**`,
    ];
  }
  return [model.modules.memo];
}

function scheduleModuleLines(model: ReviewExecuteModel): string[] {
  const s = model.scheduleModuleBlock as ReviewExecuteScheduleModuleBlock | undefined;
  if (s) {
    const head = [
      `· 周期内完成 **${s.completedInPeriod}** · 新建 **${s.created}** · 完成日晚于计划结束 **${s.doneAfterPlannedEnd}**`,
    ];
    if (s.byCategory.length === 0) {
      head.push("· 本周期无已完成日程分类汇总。");
    } else {
      const parts = s.byCategory.map(
        (row) => `${row.categoryLabel} **${row.count}**（${formatCompactScheduleHours(row.minutes)}）`,
      );
      head.push(`· 分类：${parts.join(" · ")}`);
    }
    return head;
  }
  return [model.modules.schedule];
}

function projectModuleLines(model: ReviewExecuteModel): string[] {
  const b = model.projectModuleBlock as ReviewExecuteProjectModuleBlock | undefined;
  if (b) {
    return [
      `· 周期内完成 **${b.completedInPeriod}** · 周期内有进展的活跃项目 **${b.pushedActiveCount}**`,
    ];
  }
  return [model.modules.project];
}

function outputModuleLines(model: ReviewExecuteModel): string[] {
  const b = model.outputModuleBlock as ReviewExecuteOutputModuleBlock | undefined;
  if (b) {
    return [
      `· 新建 **${b.indexNewInPeriod}** · 完成 **${b.doneInPeriod}** · 发布 **${b.publishedInPeriod}**`,
    ];
  }
  return [model.modules.output];
}

function contactModuleLines(model: ReviewExecuteModel): string[] {
  const b = model.contactModuleBlock as ReviewExecuteContactModuleBlock | undefined;
  if (b) {
    return [`· 周期内动态 **${b.dynamicInPeriod}** · 其中新建 **${b.newInPeriod}**`];
  }
  return [model.modules.contact];
}

/**
 * 将 Review「执行」页模型整理为 Markdown，便于贴入周报/月报。
 * 仅含 A 周期总览（数字）与 C 分模块数据摘要，与执行页 C 区结构化文案一致。
 */
export function formatReviewExecuteModelForPeriodReportPaste(model: ReviewExecuteModel): string {
  const s = ensureOverviewStrip(model);
  const lines: string[] = [];

  lines.push("#### A 周期总览");
  lines.push(`- 任务：完成 **${s.taskDone}** / 进度事件 **${s.taskProgressWe}** / 新增 **${s.taskNew}**`);
  lines.push(`- 提醒：完成 **${s.memoDone}** / 新增 **${s.memoNew}**`);
  lines.push(`- 日程：完成 **${s.scheduleDone}** / 新增 **${s.scheduleNew}**`);
  lines.push(`- 项目：完成 **${s.projectDone}** / 进展 **${s.projectProgress}** / 新增 **${s.projectNewWe}**`);
  lines.push(
    `- 输出：完成 **${s.outputDone}** / 发布 **${s.outputPublished}** / 进度 **${s.outputProgressWe}** / 新增 **${s.outputNew}**`,
  );
  lines.push(`- 联系人：互动 **${s.contactInteract}** / 新增 **${s.contactNew}**`);
  lines.push("");
  lines.push("#### B 分模块数据摘要");
  lines.push("##### 任务");
  for (const ln of taskModuleLines(model)) lines.push(ln);
  lines.push("##### 提醒");
  for (const ln of memoModuleLines(model)) lines.push(ln);
  lines.push("##### 日程");
  for (const ln of scheduleModuleLines(model)) lines.push(ln);
  lines.push("##### 项目");
  for (const ln of projectModuleLines(model)) lines.push(ln);
  lines.push("##### 输出");
  for (const ln of outputModuleLines(model)) lines.push(ln);
  lines.push("##### 联系人");
  for (const ln of contactModuleLines(model)) lines.push(ln);

  return `${lines.join("\n").trim()}\n`;
}
