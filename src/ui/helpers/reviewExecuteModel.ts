import { moment, normalizePath } from "obsidian";
import type RSLattePlugin from "../../main";
import type { RSLatteIndexItem } from "../../taskRSLatte/types";
import { isScheduleMemoLine } from "../../taskRSLatte/types";
import { labelForScheduleCategoryId } from "../../taskRSLatte/schedule/scheduleCategory";
import type { OutputIndexItem } from "../../types/outputTypes";
import type { ProjectEntry } from "../../projectManager/types";
import type { WorkEvent } from "../../types/stats/workEvent";
import type { ReviewTimelineNav } from "./reviewTimelineNavigate";
import { listProjectsPushedInPeriod, projectKeyOfEntry, readReviewPeriodWorkEventAggregates } from "./reviewWorkEventPeriodStats";
import { buildReviewExecuteScheduleViz, type ReviewExecuteScheduleVizModel } from "./reviewExecuteScheduleViz";
import { collapseWikiLinksForLineDisplay } from "./renderTextWithContactRefs";
import {
  readOutputItemsMergedForReview,
  readTaskMemoScheduleMergedForReview,
  reviewMergeArchiveShardsForGrain,
} from "./reviewIndexMerge";

const momentFn = moment as any;

function ymdInRange(ymd: string, startYmd: string, endYmd: string): boolean {
  const s = String(ymd ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return s >= startYmd && s <= endYmd;
}

function isReminderMemoLine(it: RSLatteIndexItem): boolean {
  if (String(it.itemType ?? "").toLowerCase() !== "memo") return false;
  return !isScheduleMemoLine(it);
}

function scheduleAnchorYmd(it: RSLatteIndexItem): string {
  const ex = (it.extra ?? {}) as Record<string, unknown>;
  const sd = String(ex.schedule_date ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(sd)) return sd;
  return String(it.memoDate ?? "").trim();
}

/** 完成日是否「晚于计划」的比较基准：优先 `planned_end`，否则与索引/侧栏一致的锚点日 `schedule_date`（多数日程仅后者有值） */
function schedulePlanYmdForDoneCompare(it: RSLatteIndexItem): string {
  const pe = String(it.planned_end ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(pe)) return pe;
  const ay = scheduleAnchorYmd(it);
  return /^\d{4}-\d{2}-\d{2}$/.test(ay) ? ay : "";
}

function scheduleRowCategoryId(it: RSLatteIndexItem): string {
  const ex = (it.extra ?? {}) as Record<string, unknown>;
  return String(ex.schedule_category ?? "").trim() || "_uncat";
}

/** 单块日程时长（分钟）：优先 `duration_min`，否则 `end_time`−`start_time`（同日） */
function scheduleBlockMinutes(it: RSLatteIndexItem): number {
  const ex = (it.extra ?? {}) as Record<string, unknown>;
  const dm = Math.floor(Number(ex.duration_min));
  if (Number.isFinite(dm) && dm > 0) return Math.min(dm, 24 * 60);
  const st = String(ex.start_time ?? "").trim();
  const et = String(ex.end_time ?? "").trim();
  const rm = (x: string) => x.match(/^(\d{1,2}):(\d{2})$/);
  const m1 = rm(st);
  const m2 = rm(et);
  if (m1 && m2) {
    const a = Number(m1[1]) * 60 + Number(m1[2]);
    const b = Number(m2[1]) * 60 + Number(m2[2]);
    let d = b - a;
    if (d < 0) d += 24 * 60;
    if (d > 0 && d <= 24 * 60) return d;
  }
  return 0;
}

function countOutputs(
  items: OutputIndexItem[],
  startYmd: string,
  endYmd: string,
): { created: number; done: number } {
  let created = 0;
  let done = 0;
  for (const it of items) {
    const st = String(it.status ?? "").toLowerCase();
    if (st === "cancelled") continue;
    const cd = String(it.createDate ?? "").trim();
    if (ymdInRange(cd, startYmd, endYmd)) created += 1;
    if (st === "done") {
      const dd = String(it.doneDate ?? "").trim();
      if (ymdInRange(dd, startYmd, endYmd)) done += 1;
    }
  }
  return { created, done };
}

/** 与项目关联且在周期内「创建或完成」有日期的输出索引条数（按 projectId，无 id 时按项目目录前缀） */
function countOutputsLinkedToProjectInPeriod(
  outputItems: OutputIndexItem[],
  p: ProjectEntry,
  startYmd: string,
  endYmd: string,
): number {
  const pid = String(p.projectId ?? "").trim();
  const folder = normalizePath(String(p.folderPath ?? "").trim());
  let n = 0;
  for (const oit of outputItems) {
    let linked = false;
    if (pid) {
      if (String(oit.projectId ?? "").trim() === pid) linked = true;
    } else if (folder) {
      const fp = normalizePath(String(oit.filePath ?? ""));
      if (fp && (fp === folder || fp.startsWith(`${folder}/`))) linked = true;
    }
    if (!linked) continue;
    const cd = String(oit.createDate ?? "").trim();
    const dd = String(oit.doneDate ?? "").trim();
    if (ymdInRange(cd, startYmd, endYmd) || ymdInRange(dd, startYmd, endYmd)) n += 1;
  }
  return n;
}

/** 日记任务业务分类（meta `task_category` / extra 镜像） */
function diaryTaskCategoryLabel(it: RSLatteIndexItem): string {
  const ex = (it as any).extra ?? {};
  const s = String(ex.task_category ?? (it as any).task_category ?? "").trim();
  return s || "未分类";
}

const REVIEW_PROJECT_TASK_HOURS_CAT = "项目任务";

export type ReviewExecuteTaskHourEntry = {
  kind: "diary" | "project";
  hours: number;
  /** 列表展示：含标题与工时 */
  label: string;
  nav: ReviewTimelineNav;
};

export type ReviewExecuteTaskHourCategorySlice = {
  label: string;
  totalHours: number;
  taskCount: number;
  top3: ReviewExecuteTaskHourEntry[];
  colorSlot: number;
};

/** 任务工时色条 + Top3 所需数据（日记任务按分类 + 项目任务单独一类） */
export type ReviewExecuteTaskHoursDetail = {
  totalHours: number;
  categories: ReviewExecuteTaskHourCategorySlice[];
  globalTop3: ReviewExecuteTaskHourEntry[];
};

function buildReviewExecuteTaskHoursDetail(
  taskItems: RSLatteIndexItem[],
  projects: ProjectEntry[],
  startYmd: string,
  endYmd: string,
  includeArchivedIndexRows: boolean,
): ReviewExecuteTaskHoursDetail | undefined {
  type Acc = ReviewExecuteTaskHourEntry;
  const byCat = new Map<string, Acc[]>();

  const pushCat = (cat: string, entry: Acc) => {
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat)!.push(entry);
  };

  for (const it of taskItems) {
    if ((it as any).archived && !includeArchivedIndexRows) continue;
    const typ = String(it.itemType ?? "task").toLowerCase();
    if (typ !== "task") continue;
    const st = String(it.status ?? "").toUpperCase().replace(/-/g, "_");
    const dd = String(it.done_date ?? "").trim();
    if (st !== "DONE" || !ymdInRange(dd, startYmd, endYmd)) continue;
    const eh = Number(it.estimate_h);
    if (!Number.isFinite(eh) || eh <= 0) continue;
    const cat = diaryTaskCategoryLabel(it);
    const fp = normalizePath(String(it.filePath ?? "").trim());
    const ln = Number(it.lineNo ?? 0);
    const title = String(it.text ?? it.raw ?? "").replace(/\s+/g, " ").trim().slice(0, 72) || "任务";
    const nav: ReviewTimelineNav = { type: "task_panel", mode: "task", filePath: fp, lineNo: ln };
    pushCat(cat, { kind: "diary", hours: eh, label: `${title} · ${eh.toFixed(1)}h`, nav });
  }

  for (const p of projects) {
    const pName = String(p.projectName ?? projectKeyOfEntry(p)).trim() || projectKeyOfEntry(p);
    const tasklistFp = normalizePath(String(p.tasklistFilePath ?? `${p.folderPath}/项目任务清单.md`).trim());
    for (const t of p.taskItems ?? []) {
      if (String(t.statusName ?? "").toUpperCase() !== "DONE") continue;
      const tdd = String(t.done_date ?? "").trim();
      if (!ymdInRange(tdd, startYmd, endYmd)) continue;
      const eh = Number(t.estimate_h);
      if (!Number.isFinite(eh) || eh <= 0) continue;
      const tf = normalizePath(String(t.sourceFilePath ?? tasklistFp).trim());
      const nav: ReviewTimelineNav = {
        type: "project_panel",
        projectKey: projectKeyOfEntry(p),
        taskFilePath: tf,
        taskLineNo: Number(t.lineNo ?? 0),
      };
      const tText = String(t.text ?? "").replace(/\s+/g, " ").trim().slice(0, 48) || "子任务";
      pushCat(REVIEW_PROJECT_TASK_HOURS_CAT, {
        kind: "project",
        hours: eh,
        label: `${pName} / ${tText} · ${eh.toFixed(1)}h`,
        nav,
      });
    }
  }

  if (byCat.size === 0) return undefined;

  let totalHours = 0;
  const rows: { label: string; total: number; tasks: Acc[] }[] = [];
  for (const [label, tasks] of byCat.entries()) {
    const total = tasks.reduce((s, x) => s + x.hours, 0);
    totalHours += total;
    const sorted = [...tasks].sort((a, b) => b.hours - a.hours);
    rows.push({ label, total, tasks: sorted });
  }
  if (totalHours <= 0) return undefined;

  rows.sort((a, b) => b.total - a.total);

  const allSorted: Acc[] = [];
  for (const r of rows) allSorted.push(...r.tasks);
  allSorted.sort((a, b) => b.hours - a.hours);
  const globalTop3 = allSorted.slice(0, 3);

  const categories: ReviewExecuteTaskHourCategorySlice[] = rows.map((r, i) => ({
    label: r.label,
    totalHours: r.total,
    taskCount: r.tasks.length,
    top3: r.tasks.slice(0, 3),
    colorSlot: i % 8,
  }));

  return { totalHours, categories, globalTop3 };
}

function projectTasksDoneInPeriodStats(
  p: ProjectEntry,
  startYmd: string,
  endYmd: string,
): { count: number; estimateHours: number } {
  let count = 0;
  let estimateHours = 0;
  for (const t of p.taskItems ?? []) {
    if (String(t.statusName ?? "").toUpperCase() !== "DONE") continue;
    const tdd = String(t.done_date ?? "").trim();
    if (!ymdInRange(tdd, startYmd, endYmd)) continue;
    count += 1;
    const eh = Number(t.estimate_h);
    if (Number.isFinite(eh) && eh > 0) estimateHours += eh;
  }
  return { count, estimateHours };
}

/** B 区：frontmatter「完成日」落在本周期内的已完成项目 + 周期内成果摘要 */
export type ReviewExecuteCompletedProjectHighlight = {
  projectKey: string;
  primary: string;
  secondary: string;
};

export type ReviewExecuteProjectHighlight = {
  primary: string;
  /** 未开操作日志时的推进日说明 */
  secondary?: string;
  /** 开操作日志：周期内最近至多 3 条推进事件（ts 新→旧） */
  progressLines?: string[];
  projectKey: string;
};

/** C 区「项目」模块两行摘要 */
export type ReviewExecuteProjectModuleBlock = {
  completedInPeriod: number;
  pushedActiveCount: number;
};

/** C 区「输出」一行摘要：新建以索引 createDate 为准；发布仍为操作日志聚合 */
export type ReviewExecuteOutputModuleBlock = {
  /** 周期内新建：output 索引 createDate */
  indexNewInPeriod: number;
  doneInPeriod: number;
  publishedInPeriod: number;
};

/** C 区「联系人」一行摘要（动态/新建均为 WorkEvent 聚合；未开日志时为 0） */
export type ReviewExecuteContactModuleBlock = {
  dynamicInPeriod: number;
  newInPeriod: number;
};

function formatProjectProgressWeLine(e: WorkEvent): string {
  const sum = String(e.summary ?? "").replace(/\s+/g, " ").trim();
  const kind = String(e.kind ?? "");
  const act = String(e.action ?? "");
  const kindZh: Record<string, string> = { project: "项目", milestone: "里程碑", projecttask: "项目任务" };
  const actZh: Record<string, string> = {
    create: "创建",
    update: "更新",
    publish: "发布",
    status: "状态",
    delete: "删除",
    archive: "归档",
    cancelled: "取消",
    done: "完成",
  };
  const ts = String(e.ts ?? "").trim();
  const ymd = momentFn(ts).isValid() ? momentFn(ts).format("YYYY-MM-DD HH:mm") : "";
  const kindAct = `${kindZh[kind] ?? kind}·${actZh[act] ?? act}`;
  const core = sum || kindAct;
  return ymd ? `${core} · ${ymd}` : core;
}

export type ReviewExecuteOutputHighlight = {
  primary: string;
  /** 完成日 YYYY-MM-DD（与「周期内完成」过滤同源） */
  doneYmd?: string;
  nav: ReviewTimelineNav;
};

/** B 区：提醒 / 日程完成 Top（与输出高亮同构，可点回任务侧栏） */
export type ReviewExecuteIndexLineHighlight = {
  primary: string;
  secondary?: string;
  nav: ReviewTimelineNav;
};

/** B 区：联系人动态（WorkEvent；列表侧每人最新一条后再取至多 3 人） */
export type ReviewExecuteContactSampleHighlight = {
  primary: string;
  secondary: string;
  nav: ReviewTimelineNav;
};

function navFromContactWorkEvent(e: WorkEvent): ReviewTimelineNav {
  const ref = (e.ref ?? {}) as Record<string, unknown>;
  const fp = String(ref.file_path ?? ref.filePath ?? "").trim();
  if (fp) return { type: "open_file", filePath: normalizePath(fp) };
  return { type: "sidebar", target: "contacts" };
}

/** C 区「任务」模块多行摘要（数字由渲染层加主题色加粗） */
export type ReviewExecuteTaskModuleBlock = {
  completedInPeriod: number;
  created: number;
  doneAfterPlannedEnd: number;
  diaryEstimateHours: number;
  projectEstimateHours: number;
};

/** 提醒分类（与 AddMemoModal / extra.cat 一致） */
export type ReviewMemoCategoryKey =
  | "lunarBirthday"
  | "solarBirthday"
  | "anniversary"
  | "dueReminder"
  | "generalReminder";

/** C 区「日程」按分类汇总（仅本周期完成且有条目的分类，可扩展分类不全量列举） */
export type ReviewExecuteScheduleCategoryBreakdown = {
  categoryId: string;
  categoryLabel: string;
  count: number;
  minutes: number;
};

/** C 区「日程」模块多行摘要 */
export type ReviewExecuteScheduleModuleBlock = {
  completedInPeriod: number;
  created: number;
  doneAfterPlannedEnd: number;
  /** 完成日落在周期内的已完成日程，按 schedule_category 聚合；仅含 count>0 的分类 */
  byCategory: ReviewExecuteScheduleCategoryBreakdown[];
};

/** C 区「提醒」模块多行摘要 */
export type ReviewExecuteMemoModuleBlock = {
  completedInPeriod: number;
  created: number;
  doneAfterMemoDate: number;
  /** 农历生日 + 阳历生日 */
  birthdayCount: number;
  anniversaryCount: number;
  dueReminderCount: number;
  generalReminderCount: number;
  arrangedToTaskCount: number;
  arrangedToScheduleCount: number;
};

function normalizeMemoCategory(raw: string): ReviewMemoCategoryKey {
  const s = String(raw ?? "").trim();
  if (s === "lunarBirthday") return "lunarBirthday";
  if (s === "solarBirthday") return "solarBirthday";
  if (s === "anniversary") return "anniversary";
  if (s === "dueReminder") return "dueReminder";
  if (s === "important" || s === "generalReminder" || !s) return "generalReminder";
  return "generalReminder";
}

const MEMO_CAT_LABEL_ZH: Record<ReviewMemoCategoryKey, string> = {
  lunarBirthday: "农历生日",
  solarBirthday: "阳历生日",
  anniversary: "纪念日",
  dueReminder: "到期提醒",
  generalReminder: "一般提醒",
};

function memoReminderYmd(it: RSLatteIndexItem): string {
  const d = String((it as any).memoDate ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "";
}

/** 提醒重要性：分类基础分 + 转任务/转日程 + 星标（Review C 区 Top5） */
function memoImportanceBase(cat: ReviewMemoCategoryKey): number {
  if (cat === "lunarBirthday" || cat === "solarBirthday") return 0;
  if (cat === "anniversary" || cat === "generalReminder") return 1;
  if (cat === "dueReminder") return 2;
  return 1;
}

function computeMemoReviewImportance(it: RSLatteIndexItem, extra: Record<string, unknown>): number {
  const cat = normalizeMemoCategory(String(extra.cat ?? ""));
  let s = memoImportanceBase(cat);
  if (String(extra.arranged_task_uid ?? "").trim()) s += 4;
  if (String(extra.arranged_schedule_uid ?? "").trim()) s += 3;
  if ((it as any).starred === true) s += 2;
  return s;
}

function memoDoneAfterReminderYmd(it: RSLatteIndexItem, md: string): boolean {
  const dd = String(it.done_date ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(dd) && !!md && dd > md;
}

function ymdDiffDaysAsc(a: string, b: string): number {
  const ta = Date.UTC(Number(a.slice(0, 4)), Number(a.slice(5, 7)) - 1, Number(a.slice(8, 10)));
  const tb = Date.UTC(Number(b.slice(0, 4)), Number(b.slice(5, 7)) - 1, Number(b.slice(8, 10)));
  return Math.round((tb - ta) / 86400000);
}

/** A 周期总览单行指标（完成/推进/新增等，与 WorkEvent 及索引对齐） */
export type ReviewExecuteOverviewStrip = {
  taskDone: number;
  taskProgressWe: number;
  taskNew: number;
  memoDone: number;
  memoNew: number;
  projectDone: number;
  /** 开日志：project/milestone/projecttask 事件条数；未开：有推进的活跃项目数 */
  projectProgress: number;
  projectNewWe: number;
  outputDone: number;
  outputPublished: number;
  outputProgressWe: number;
  outputNew: number;
  contactInteract: number;
  contactNew: number;
  /** 日程索引：完成日落在周期内；新建与任务/提醒同源（索引日或 WE） */
  scheduleDone: number;
  scheduleNew: number;
};

/**
 * Review「本周/本月执行」：仅含 **任务、提醒、日程、项目、输出、联系人**（与「记录」页四域分离，避免重复）。
 * 见 `Review侧边栏优化方案.md` §4.3a / §4.4。
 */
export type ReviewExecuteModel = {
  startYmd: string;
  endYmd: string;
  /** 与视图一致：周/月决定日程区展示栅格或热力 */
  grain: "week" | "month" | "quarter";
  workEventEnabled: boolean;
  /** 任务工时；日程统计与图表见 scheduleViz（仅已完成且完成日落在周期内） */
  workload: {
    /** 日记/任务清单索引中已完成且完成日在周期内的 estimate_h 合计 */
    tasksDoneEstimateHours: number;
    /** 全部项目中、完成日在周期内的项目任务 estimate_h 合计 */
    projectTasksDoneEstimateHours: number;
    /** 任务工时色条与分类 Top3（有 estimate_h 的已完成条目） */
    taskHoursDetail?: ReviewExecuteTaskHoursDetail;
    scheduleViz: ReviewExecuteScheduleVizModel;
    /** 旧快照兼容：曾用「锚点在周期内的全部块」 */
    scheduleBlocksInPeriod?: number;
    scheduleMinutesTotal?: number;
  };
  overview: {
    tasksDone: number;
    memosDone: number;
    /** 已迁到 workload.scheduleViz；旧快照可能仍带此字段 */
    schedulesDone?: number;
    projectsPushed: number;
    /** 周期内完成日落在区间内的已完成项目数（执行页总览 ✅） */
    projectsCompletedInPeriod?: number;
    outputsNew: number;
    outputsPublished: number;
    outputsDone: number;
    /** 周期内 WorkEvent kind=contact 条数；未开日志时为 0 */
    contactEvents: number;
  };
  /** A 区单行展示；旧快照可能缺失，渲染侧可回退 */
  overviewStrip?: ReviewExecuteOverviewStrip;
  /** C 区任务模块结构化文案；旧快照无此字段时用 modules.task */
  taskModuleBlock?: ReviewExecuteTaskModuleBlock;
  /** C 区提醒模块结构化文案；旧快照无此字段时用 modules.memo */
  memoModuleBlock?: ReviewExecuteMemoModuleBlock;
  /** C 区日程模块结构化文案；旧快照无此字段时用 modules.schedule */
  scheduleModuleBlock?: ReviewExecuteScheduleModuleBlock;
  /** C 区项目模块结构化摘要；旧快照无此字段时用 modules.project */
  projectModuleBlock?: ReviewExecuteProjectModuleBlock;
  /** C 区输出模块结构化摘要；旧快照无此字段时用 modules.output */
  outputModuleBlock?: ReviewExecuteOutputModuleBlock;
  /** C 区联系人模块结构化摘要；旧快照无此字段时用 modules.contact */
  contactModuleBlock?: ReviewExecuteContactModuleBlock;
  modules: {
    task: string;
    memo: string;
    schedule: string;
    project: string;
    output: string;
    contact: string;
  };
  /** 分模块摘要区：周期内完成/推进的 Top（可点击），按任务/提醒/项目等归类 */
  highlights: {
    completedProjects: ReviewExecuteCompletedProjectHighlight[];
    projectsPushed: ReviewExecuteProjectHighlight[];
    outputsDone: ReviewExecuteOutputHighlight[];
    memosDone: ReviewExecuteIndexLineHighlight[];
    contactsSample: ReviewExecuteContactSampleHighlight[];
  };
};

export async function buildReviewExecuteModel(
  plugin: RSLattePlugin,
  startYmd: string,
  endYmd: string,
  grain: "week" | "month" | "quarter",
): Promise<ReviewExecuteModel> {
  const mergeArch = reviewMergeArchiveShardsForGrain(grain);
  const enTask = plugin.isPipelineModuleEnabled("task");
  const enMemo = plugin.isPipelineModuleEnabled("memo");
  const enSchedule = plugin.isPipelineModuleEnabled("schedule");
  const enOutput = plugin.isPipelineModuleEnabled("output");
  const enProject = plugin.isPipelineModuleEnabled("project");
  const enContacts = plugin.isPipelineModuleEnabled("contacts");
  const modOff = "（模块已关闭）";
  const workEventEnabled = plugin.workEventSvc?.isEnabled?.() === true;
  const workload: ReviewExecuteModel["workload"] = {
    tasksDoneEstimateHours: 0,
    projectTasksDoneEstimateHours: 0,
    scheduleViz: buildReviewExecuteScheduleViz([], startYmd, endYmd, grain, (plugin.settings as any)?.scheduleModule),
  };
  const overview: ReviewExecuteModel["overview"] = {
    tasksDone: 0,
    memosDone: 0,
    projectsPushed: 0,
    outputsNew: 0,
    outputsPublished: 0,
    outputsDone: 0,
    contactEvents: 0,
  };

  let tasksCreated = 0;
  /** 周期内已完成且 done_date > planned_end（有计划结束日）的条数，可随快照冻结、较「当前仍开放超期」更可回溯 */
  let tasksDoneAfterPlannedEnd = 0;
  let memosCreated = 0;
  let memosOpenOverdue = 0;
  let schedulesCreated = 0;

  const taskItems = enTask
    ? await readTaskMemoScheduleMergedForReview(plugin, "task-index.json", startYmd, endYmd, mergeArch)
    : [];
  for (const it of taskItems) {
    if ((it as any).archived && !mergeArch) continue;
    const st = String(it.status ?? "").toUpperCase().replace(/-/g, "_");
    const dd = String(it.done_date ?? "").trim();
    if (st === "DONE" && ymdInRange(dd, startYmd, endYmd)) {
      overview.tasksDone += 1;
      const pe = String(it.planned_end ?? "").trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(pe) && dd > pe) tasksDoneAfterPlannedEnd += 1;
      const eh = Number(it.estimate_h);
      if (Number.isFinite(eh) && eh > 0) workload.tasksDoneEstimateHours += eh;
    }

    const cd = String(it.created_date ?? "").trim();
    if (ymdInRange(cd, startYmd, endYmd)) tasksCreated += 1;
  }

  let memosDoneAfterMemoDate = 0;
  let mcLunar = 0;
  let mcSolar = 0;
  let mcAnniv = 0;
  let mcDue = 0;
  let mcGen = 0;
  let arrangedMemoToTask = 0;
  let arrangedMemoToSch = 0;
  const memoTopCandidates: RSLatteIndexItem[] = [];

  const memoItems = enMemo
    ? await readTaskMemoScheduleMergedForReview(plugin, "memo-index.json", startYmd, endYmd, mergeArch)
    : [];
  for (const it of memoItems) {
    if ((it as any).archived && !mergeArch) continue;
    if (!isReminderMemoLine(it)) continue;
    const extra = ((it as any).extra ?? {}) as Record<string, unknown>;
    if (String(extra.invalidated ?? "").trim() === "1") continue;

    const cat = normalizeMemoCategory(String(extra.cat ?? ""));
    if (cat === "lunarBirthday") mcLunar += 1;
    else if (cat === "solarBirthday") mcSolar += 1;
    else if (cat === "anniversary") mcAnniv += 1;
    else if (cat === "dueReminder") mcDue += 1;
    else mcGen += 1;

    if (String(extra.arranged_task_uid ?? "").trim()) arrangedMemoToTask += 1;
    if (String(extra.arranged_schedule_uid ?? "").trim()) arrangedMemoToSch += 1;

    const st = String(it.status ?? "").toUpperCase().replace(/-/g, "_");
    const dd = String(it.done_date ?? "").trim();
    const md = memoReminderYmd(it);

    if (st === "DONE" && ymdInRange(dd, startYmd, endYmd)) {
      overview.memosDone += 1;
      if (memoDoneAfterReminderYmd(it, md)) memosDoneAfterMemoDate += 1;
      memoTopCandidates.push(it);
    } else if (st !== "DONE" && st !== "CANCELLED") {
      const pe = String(it.planned_end ?? "").trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(pe) && pe <= endYmd) memosOpenOverdue += 1;
      if (md && md <= endYmd) memoTopCandidates.push(it);
    }

    const cd = String(it.created_date ?? "").trim();
    if (ymdInRange(cd, startYmd, endYmd)) memosCreated += 1;
  }

  const memoModuleBlock: ReviewExecuteMemoModuleBlock = {
    completedInPeriod: overview.memosDone,
    created: memosCreated,
    doneAfterMemoDate: memosDoneAfterMemoDate,
    birthdayCount: mcLunar + mcSolar,
    anniversaryCount: mcAnniv,
    dueReminderCount: mcDue,
    generalReminderCount: mcGen,
    arrangedToTaskCount: arrangedMemoToTask,
    arrangedToScheduleCount: arrangedMemoToSch,
  };

  let schedulesDoneInPeriod = 0;
  let schedulesDoneAfterPlannedEnd = 0;
  const schedCatAgg: Record<string, { count: number; minutes: number }> = {};
  const schedItems = enSchedule
    ? await readTaskMemoScheduleMergedForReview(plugin, "schedule-index.json", startYmd, endYmd, mergeArch)
    : [];
  const scheduleModuleCfg = (plugin.settings as any)?.scheduleModule as
    | { scheduleCategoryDefs?: { id: string; label: string }[]; defaultScheduleCategoryId?: string }
    | undefined;
  for (const it of schedItems) {
    if ((it as any).archived && !mergeArch) continue;
    const st = String(it.status ?? "").toUpperCase().replace(/-/g, "_");
    const dd = String(it.done_date ?? "").trim();
    if (st === "DONE" && ymdInRange(dd, startYmd, endYmd)) {
      schedulesDoneInPeriod += 1;
      const planYmd = schedulePlanYmdForDoneCompare(it);
      if (planYmd && dd > planYmd) schedulesDoneAfterPlannedEnd += 1;
      const cid = scheduleRowCategoryId(it);
      const mins = scheduleBlockMinutes(it);
      if (!schedCatAgg[cid]) schedCatAgg[cid] = { count: 0, minutes: 0 };
      schedCatAgg[cid].count += 1;
      schedCatAgg[cid].minutes += mins;
    }
    const cd = String(it.created_date ?? "").trim();
    if (ymdInRange(cd, startYmd, endYmd)) schedulesCreated += 1;
  }
  overview.schedulesDone = schedulesDoneInPeriod;
  const scheduleByCategory: ReviewExecuteScheduleCategoryBreakdown[] = Object.entries(schedCatAgg)
    .filter(([, v]) => v.count > 0)
    .map(([id, v]) => ({
      categoryId: id,
      categoryLabel: labelForScheduleCategoryId(scheduleModuleCfg, id === "_uncat" ? "" : id),
      count: v.count,
      minutes: v.minutes,
    }))
    .sort((a, b) => b.minutes - a.minutes || a.categoryLabel.localeCompare(b.categoryLabel, "zh"));
  const scheduleModuleBlock: ReviewExecuteScheduleModuleBlock = {
    completedInPeriod: schedulesDoneInPeriod,
    created: schedulesCreated,
    doneAfterPlannedEnd: schedulesDoneAfterPlannedEnd,
    byCategory: scheduleByCategory,
  };
  workload.scheduleViz = buildReviewExecuteScheduleViz(
    schedItems,
    startYmd,
    endYmd,
    grain,
    scheduleModuleCfg,
  );

  let outputItems: OutputIndexItem[] = [];
  let outputsCreatedFromIndex = 0;
  if (enOutput) {
    try {
      if (mergeArch) {
        outputItems = await readOutputItemsMergedForReview(plugin, startYmd, endYmd, true);
      } else {
        const svc = plugin.outputRSLatte;
        if (svc?.getSnapshot) {
          const snap = await svc.getSnapshot();
          outputItems = (snap.items ?? []) as OutputIndexItem[];
        }
      }
      const { created, done } = countOutputs(outputItems, startYmd, endYmd);
      outputsCreatedFromIndex = created;
      if (!workEventEnabled) overview.outputsNew = created;
      overview.outputsDone = done;
    } catch (e) {
      console.warn("[RSLatte] buildReviewExecuteModel output snapshot failed:", e);
    }
  }

  const completedInPeriodRows: {
    p: ProjectEntry;
    projectDoneYmd: string;
    tasksInPeriod: number;
    estH: number;
    outputsInPeriod: number;
  }[] = [];
  let projectSnapshotList: ProjectEntry[] = [];

  if (enProject && plugin.projectMgr) {
    try {
      await plugin.projectMgr.ensureReady();
      const snap = plugin.projectMgr.getSnapshot?.();
      projectSnapshotList = Array.isArray(snap?.projects) ? snap!.projects : [];
      for (const p of projectSnapshotList) {
        const { count: projTasksDoneInPeriod, estimateHours: projEstInPeriod } = projectTasksDoneInPeriodStats(
          p,
          startYmd,
          endYmd,
        );
        workload.projectTasksDoneEstimateHours += projEstInPeriod;

        const pst = String(p.status ?? "").toLowerCase();
        if (pst === "done") {
          const projectDoneYmd = String(p.done ?? "").trim();
          if (ymdInRange(projectDoneYmd, startYmd, endYmd)) {
            const outputsInPeriod = countOutputsLinkedToProjectInPeriod(outputItems, p, startYmd, endYmd);
            completedInPeriodRows.push({
              p,
              projectDoneYmd,
              tasksInPeriod: projTasksDoneInPeriod,
              estH: projEstInPeriod,
              outputsInPeriod,
            });
          }
        }
      }
    } catch (e) {
      console.warn("[RSLatte] buildReviewExecuteModel project snapshot failed:", e);
      projectSnapshotList = [];
    }
  }

  workload.taskHoursDetail = buildReviewExecuteTaskHoursDetail(
    enTask ? taskItems : [],
    enProject ? projectSnapshotList : [],
    startYmd,
    endYmd,
    mergeArch,
  );

  const weAg = await readReviewPeriodWorkEventAggregates(plugin, startYmd, endYmd);
  if (workEventEnabled) {
    if (enOutput) {
      overview.outputsNew = weAg.outputsNew;
      overview.outputsPublished = weAg.outputsPublished;
    }
    if (enContacts) overview.contactEvents = weAg.contactEvents;
    if (enTask) tasksCreated = weAg.tasksCreated;
    if (enMemo) memosCreated = weAg.memosCreated;
    if (enSchedule) schedulesCreated = weAg.schedulesCreated;
  }

  const pushedProjectRows = listProjectsPushedInPeriod(projectSnapshotList, workEventEnabled, weAg, startYmd, endYmd);
  overview.projectsPushed = pushedProjectRows.length;

  const projectModuleBlock: ReviewExecuteProjectModuleBlock = {
    completedInPeriod: completedInPeriodRows.length,
    pushedActiveCount: overview.projectsPushed,
  };

  const contactHint = workEventEnabled ? "" : "（未开操作日志则为 0）";
  const projectSrcHint = workEventEnabled
    ? "（操作日志 project/milestone/projecttask）"
    : "（未开操作日志时用 frontmatter progress_updated）";
  const createSrc = workEventEnabled ? "操作日志 create" : "索引创建日";
  const diaryH = workload.tasksDoneEstimateHours;
  const projH = workload.projectTasksDoneEstimateHours;
  const taskModuleBlock: ReviewExecuteTaskModuleBlock = {
    completedInPeriod: overview.tasksDone,
    created: tasksCreated,
    doneAfterPlannedEnd: tasksDoneAfterPlannedEnd,
    diaryEstimateHours: diaryH,
    projectEstimateHours: projH,
  };
  const outputModuleBlock: ReviewExecuteOutputModuleBlock = {
    indexNewInPeriod: outputsCreatedFromIndex,
    doneInPeriod: overview.outputsDone,
    publishedInPeriod: overview.outputsPublished,
  };
  const contactModuleBlock: ReviewExecuteContactModuleBlock = {
    dynamicInPeriod: overview.contactEvents,
    newInPeriod: workEventEnabled ? weAg.contactCreates : 0,
  };
  const modules: ReviewExecuteModel["modules"] = {
    task: enTask
      ? `任务：周期内完成 ${overview.tasksDone} · 新建 ${tasksCreated} · 完成日晚于计划结束 ${tasksDoneAfterPlannedEnd} · 工时 ${diaryH.toFixed(1)}h+${projH.toFixed(1)}h（旧版摘要）`
      : `任务：${modOff}`,
    memo: enMemo
      ? `提醒：完成${overview.memosDone}·新建${memosCreated}·晚于提醒日${memoModuleBlock.doneAfterMemoDate}·开放超期${memosOpenOverdue}（旧版摘要）`
      : `提醒：${modOff}`,
    schedule: enSchedule
      ? `日程：完成${schedulesDoneInPeriod}·新建${schedulesCreated}·完成日晚于计划结束${schedulesDoneAfterPlannedEnd}（${createSrc}；旧版摘要；图表见 B·工作量·日程耗时）`
      : `日程：${modOff}`,
    project: enProject
      ? `项目：完成${completedInPeriodRows.length}·有进展${overview.projectsPushed}${projectSrcHint}（旧版摘要）`
      : `项目：${modOff}`,
    output: enOutput
      ? `输出：新建${outputsCreatedFromIndex}·完成${overview.outputsDone}·发布${overview.outputsPublished}（旧版摘要）`
      : `输出：${modOff}`,
    contact: enContacts
      ? `联系人：动态${overview.contactEvents}·新建${workEventEnabled ? weAg.contactCreates : 0}${contactHint}（旧版摘要）`
      : `联系人：${modOff}`,
  };

  completedInPeriodRows.sort((a, b) => {
    const d = b.projectDoneYmd.localeCompare(a.projectDoneYmd);
    if (d !== 0) return d;
    const sa = a.tasksInPeriod + a.outputsInPeriod;
    const sb = b.tasksInPeriod + b.outputsInPeriod;
    return sb - sa;
  });
  overview.projectsCompletedInPeriod = completedInPeriodRows.length;
  const completedProjectsHigh: ReviewExecuteCompletedProjectHighlight[] = completedInPeriodRows.slice(0, 3).map(
    ({ p, projectDoneYmd, tasksInPeriod, estH, outputsInPeriod }) => {
      const name = String(p.projectName ?? projectKeyOfEntry(p)).trim() || projectKeyOfEntry(p);
      const hPart = estH > 0 ? `~${estH.toFixed(1)}h` : "未汇总工时";
      const secondary = `✅ 项目完成日 ${projectDoneYmd} · 周期内子任务完成 ${tasksInPeriod} · 投入 ${hPart} · 关联输出/文档 ${outputsInPeriod}`;
      return { projectKey: projectKeyOfEntry(p), primary: name, secondary };
    },
  );

  pushedProjectRows.sort((a, b) => b.pu.localeCompare(a.pu));
  const recentByKey = weAg.projectProgressRecentByKey;
  const projectsPushedHigh: ReviewExecuteProjectHighlight[] = pushedProjectRows.slice(0, 3).map(({ p, pu }) => {
    const pk = projectKeyOfEntry(p);
    const primary = String(p.projectName ?? pk).trim() || pk;
    if (workEventEnabled) {
      const evs = recentByKey.get(pk) ?? [];
      const progressLines = evs.map((e) => formatProjectProgressWeLine(e));
      return {
        primary,
        projectKey: pk,
        progressLines: progressLines.length > 0 ? progressLines : undefined,
        secondary:
          progressLines.length === 0 && pu
            ? `本周期有推进，但未解析到事件摘要（最后推进日 ${pu}）`
            : undefined,
      };
    }
    return {
      primary,
      projectKey: pk,
      secondary: pu ? `推进日 ${pu}（未开操作日志，无事件明细）` : undefined,
    };
  });

  const outputsDoneTop = outputItems
    .filter((it) => {
      const st = String(it.status ?? "").toLowerCase();
      const dd = String(it.doneDate ?? "").trim();
      return st === "done" && ymdInRange(dd, startYmd, endYmd);
    })
    .sort((a, b) => (Number(b.mtimeMs) || 0) - (Number(a.mtimeMs) || 0))
    .slice(0, 3)
    .map((it) => {
      const fp = String(it.filePath ?? "").trim();
      const title = String(it.title ?? "").trim() || fp || "（输出）";
      const dd = String(it.doneDate ?? "").trim();
      const doneYmd = /^\d{4}-\d{2}-\d{2}$/.test(dd) ? dd : undefined;
      const nav: ReviewTimelineNav = fp
        ? { type: "open_file", filePath: normalizePath(fp) }
        : { type: "sidebar", target: "output" };
      return { primary: title, doneYmd, nav };
    });

  const clipPrimary = (s: string, max = 96): string => {
    const t = String(s ?? "").replace(/\s+/g, " ").trim();
    if (t.length <= max) return t || "（无标题）";
    return `${t.slice(0, max)}…`;
  };

  const memoScored = memoTopCandidates.map((it) => {
    const ex = ((it as any).extra ?? {}) as Record<string, unknown>;
    const md = memoReminderYmd(it);
    const score = computeMemoReviewImportance(it, ex);
    const late = memoDoneAfterReminderYmd(it, md);
    const lateD = late && md ? ymdDiffDaysAsc(md, String(it.done_date ?? "").trim()) : 0;
    return { it, score, late, lateD };
  });
  memoScored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (Number(b.late) !== Number(a.late)) return Number(b.late) - Number(a.late);
    return b.lateD - a.lateD;
  });
  const memosDoneTop: ReviewExecuteIndexLineHighlight[] = memoScored.slice(0, 5).map(({ it }) => {
    const ex = ((it as any).extra ?? {}) as Record<string, unknown>;
    const cat = normalizeMemoCategory(String(ex.cat ?? ""));
    const parts: string[] = [MEMO_CAT_LABEL_ZH[cat]];
    if ((it as any).starred === true) parts.push("星标");
    if (String(ex.arranged_task_uid ?? "").trim()) parts.push("转任务");
    if (String(ex.arranged_schedule_uid ?? "").trim()) parts.push("转日程");
    const md = memoReminderYmd(it);
    if (memoDoneAfterReminderYmd(it, md)) parts.push("超期完成");
    return {
      primary: clipPrimary(collapseWikiLinksForLineDisplay(String(it.text ?? ""))),
      secondary: parts.join(" · "),
      nav: {
        type: "task_panel",
        mode: "memo",
        filePath: normalizePath(String(it.filePath ?? "")),
        lineNo: Number(it.lineNo) >= 0 ? Number(it.lineNo) : 0,
      },
    };
  });

  const actionZh: Record<string, string> = {
    create: "创建",
    update: "更新",
    publish: "发布",
    status: "状态",
    delete: "删除",
    archive: "归档",
    cancelled: "取消",
    done: "完成",
  };
  const contactsSampleHigh: ReviewExecuteContactSampleHighlight[] = (workEventEnabled ? weAg.contactSamples : []).map(
    (e) => {
      const sum = String(e.summary ?? "").trim();
      const primary = clipPrimary(sum || "（联系人）", 120);
      const ymd = momentFn(String(e.ts ?? "").trim()).isValid()
        ? momentFn(String(e.ts ?? "").trim()).format("YYYY-MM-DD HH:mm")
        : "";
      const act = actionZh[String(e.action)] ?? String(e.action);
      return {
        primary,
        secondary: `${act}${ymd ? ` · ${ymd}` : ""}`,
        nav: navFromContactWorkEvent(e),
      };
    },
  );

  const overviewStrip: ReviewExecuteOverviewStrip = {
    taskDone: enTask ? overview.tasksDone : 0,
    taskProgressWe: workEventEnabled && enTask ? weAg.tasksProgressEventCount : 0,
    taskNew: enTask ? tasksCreated : 0,
    memoDone: enMemo ? overview.memosDone : 0,
    memoNew: enMemo ? memosCreated : 0,
    scheduleDone: enSchedule ? schedulesDoneInPeriod : 0,
    scheduleNew: enSchedule ? schedulesCreated : 0,
    projectDone: enProject ? completedInPeriodRows.length : 0,
    projectProgress:
      workEventEnabled && enProject ? weAg.projectProgressEventCount : enProject ? overview.projectsPushed : 0,
    projectNewWe: workEventEnabled && enProject ? weAg.projectsCreated : 0,
    outputDone: enOutput ? overview.outputsDone : 0,
    outputPublished: enOutput ? overview.outputsPublished : 0,
    outputProgressWe: workEventEnabled && enOutput ? weAg.outputsProgressEventCount : 0,
    outputNew: enOutput ? overview.outputsNew : 0,
    contactInteract:
      workEventEnabled && enContacts ? Math.max(0, overview.contactEvents - weAg.contactCreates) : 0,
    contactNew: workEventEnabled && enContacts ? weAg.contactCreates : 0,
  };

  return {
    startYmd,
    endYmd,
    grain,
    workEventEnabled,
    workload,
    overview,
    overviewStrip,
    taskModuleBlock,
    memoModuleBlock,
    scheduleModuleBlock,
    projectModuleBlock,
    outputModuleBlock,
    contactModuleBlock,
    modules,
    highlights: {
      completedProjects: enProject ? completedProjectsHigh : [],
      projectsPushed: enProject ? projectsPushedHigh : [],
      outputsDone: enOutput ? outputsDoneTop : [],
      memosDone: enMemo ? memosDoneTop : [],
      contactsSample: enContacts && workEventEnabled ? contactsSampleHigh : [],
    },
  };
}
