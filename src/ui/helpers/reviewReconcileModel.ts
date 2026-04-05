import { moment } from "obsidian";
import type RSLattePlugin from "../../main";
import type { ProjectEntry } from "../../projectManager/types";
import type { RSLatteIndexItem } from "../../taskRSLatte/types";
import { isScheduleMemoLine } from "../../taskRSLatte/types";
import type { OutputIndexItem } from "../../types/outputTypes";
import {
  readOutputItemsMergedForReview,
  readTaskMemoScheduleMergedForReview,
  reviewMergeArchiveShardsForGrain,
} from "./reviewIndexMerge";
import { readReviewPeriodWorkEventAggregates } from "./reviewWorkEventPeriodStats";

const momentFn = moment as any;

/** 创建日→完成日间隔 ≥ 此天数，计入「长周期完成」（仅 done 样本） */
const OUTPUT_DONE_LONG_CYCLE_DAYS = 21;

export type ReviewReconcileGrain = "week" | "month" | "quarter";

function ymdInRange(ymd: string, startYmd: string, endYmd: string): boolean {
  const s = String(ymd ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return s >= startYmd && s <= endYmd;
}

/** fromYmd、toYmd 均为合法 YYYY-MM-DD 时返回 to − from 的天数 */
function ymdDaysDiff(fromYmd: string, toYmd: string): number | null {
  const a = momentFn(fromYmd, "YYYY-MM-DD", true);
  const b = momentFn(toYmd, "YYYY-MM-DD", true);
  if (!a.isValid() || !b.isValid()) return null;
  return b.diff(a, "days");
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

function prevPeriodRange(startYmd: string, endYmd: string): { prevStart: string; prevEnd: string } | null {
  const a = momentFn(startYmd, "YYYY-MM-DD", true);
  const b = momentFn(endYmd, "YYYY-MM-DD", true);
  if (!a.isValid() || !b.isValid()) return null;
  const days = b.diff(a, "days") + 1;
  if (days < 1) return null;
  const prevEnd = a.clone().subtract(1, "day");
  const prevStart = prevEnd.clone().subtract(days - 1, "day");
  return { prevStart: prevStart.format("YYYY-MM-DD"), prevEnd: prevEnd.format("YYYY-MM-DD") };
}

function countOutputsNewInRange(items: OutputIndexItem[], startYmd: string, endYmd: string): number {
  let n = 0;
  for (const it of items) {
    const st = String(it.status ?? "").toLowerCase();
    if (st === "cancelled") continue;
    const cd = String(it.createDate ?? "").trim();
    if (ymdInRange(cd, startYmd, endYmd)) n += 1;
  }
  return n;
}

/** 核对页 rollup：「周期内完成」「周期内新建」及可客观归因的周期事实（不含开放项清单） */
type PeriodRollup = {
  tasksDone: number;
  memosDone: number;
  schedulesDone: number;
  outputsDone: number;
  tasksNew: number;
  memosNew: number;
  schedulesNew: number;
  outputsNew: number;
  /** 新建联系人（contact+create）；未开操作日志为 0 */
  contactCreates: number;
  taskWithDueClosed: number;
  taskOnTime: number;
  taskLate: number;
  scheduleClosedInPeriod: number;
  scheduleSameDayClose: number;
  /** 提醒：本周期内完成且 memoDate 合法（与执行页「晚于提醒日完成」同源） */
  memosDoneWithReminderYmd: number;
  memosDoneLateAfterReminderYmd: number;
  /** 项目快照 status=done 且 frontmatter done 落在周期内 */
  projectsDone: number;
  /** 操作日志 output/publish 次数（未开日志为 0） */
  outputsPublished: number;
  /** 操作日志 kind=contact 事件条数（未开日志为 0） */
  contactEvents: number;
  /** 本周期完成且创建→完成 ≥ OUTPUT_DONE_LONG_CYCLE_DAYS 的输出篇数 */
  outputsDoneLongCycle: number;
};

async function rollupPeriod(
  plugin: RSLattePlugin,
  startYmd: string,
  endYmd: string,
  mergeArch: boolean,
): Promise<PeriodRollup> {
  const workEventEnabled = plugin.workEventSvc?.isEnabled?.() === true;
  const out: PeriodRollup = {
    tasksDone: 0,
    memosDone: 0,
    schedulesDone: 0,
    outputsDone: 0,
    tasksNew: 0,
    memosNew: 0,
    schedulesNew: 0,
    outputsNew: 0,
    contactCreates: 0,
    taskWithDueClosed: 0,
    taskOnTime: 0,
    taskLate: 0,
    scheduleClosedInPeriod: 0,
    scheduleSameDayClose: 0,
    memosDoneWithReminderYmd: 0,
    memosDoneLateAfterReminderYmd: 0,
    projectsDone: 0,
    outputsPublished: 0,
    contactEvents: 0,
    outputsDoneLongCycle: 0,
  };

  const taskItems = await readTaskMemoScheduleMergedForReview(
    plugin,
    "task-index.json",
    startYmd,
    endYmd,
    mergeArch,
  );
  for (const it of taskItems) {
    if ((it as any).archived && !mergeArch) continue;
    const st = String(it.status ?? "").toUpperCase().replace(/-/g, "_");
    const dd = String(it.done_date ?? "").trim();
    if (st === "DONE" && ymdInRange(dd, startYmd, endYmd)) {
      out.tasksDone += 1;
      const pe = String(it.planned_end ?? "").trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(pe)) {
        out.taskWithDueClosed += 1;
        if (dd <= pe) out.taskOnTime += 1;
        else out.taskLate += 1;
      }
    }
    if (!workEventEnabled) {
      const cd = String(it.created_date ?? "").trim();
      if (ymdInRange(cd, startYmd, endYmd)) out.tasksNew += 1;
    }
  }

  const memoItems = await readTaskMemoScheduleMergedForReview(
    plugin,
    "memo-index.json",
    startYmd,
    endYmd,
    mergeArch,
  );
  for (const it of memoItems) {
    if ((it as any).archived && !mergeArch) continue;
    if (!isReminderMemoLine(it)) continue;
    const st = String(it.status ?? "").toUpperCase().replace(/-/g, "_");
    const dd = String(it.done_date ?? "").trim();
    if (st === "DONE" && ymdInRange(dd, startYmd, endYmd)) {
      out.memosDone += 1;
      const md = String(it.memoDate ?? "").trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(md)) {
        out.memosDoneWithReminderYmd += 1;
        if (dd > md) out.memosDoneLateAfterReminderYmd += 1;
      }
    }
    if (!workEventEnabled) {
      const cd = String(it.created_date ?? "").trim();
      if (ymdInRange(cd, startYmd, endYmd)) out.memosNew += 1;
    }
  }

  const schedItems = await readTaskMemoScheduleMergedForReview(
    plugin,
    "schedule-index.json",
    startYmd,
    endYmd,
    mergeArch,
  );
  for (const it of schedItems) {
    if ((it as any).archived && !mergeArch) continue;
    const st = String(it.status ?? "").toUpperCase().replace(/-/g, "_");
    const dd = String(it.done_date ?? "").trim();
    if (st === "DONE" && ymdInRange(dd, startYmd, endYmd)) {
      out.schedulesDone += 1;
      out.scheduleClosedInPeriod += 1;
      const anchor = scheduleAnchorYmd(it);
      if (anchor && dd === anchor) out.scheduleSameDayClose += 1;
    }
    if (!workEventEnabled) {
      const cd = String(it.created_date ?? "").trim();
      if (ymdInRange(cd, startYmd, endYmd)) out.schedulesNew += 1;
    }
  }

  try {
    let items: OutputIndexItem[] = [];
    if (mergeArch) {
      items = await readOutputItemsMergedForReview(plugin, startYmd, endYmd, true);
    } else {
      const svc = plugin.outputRSLatte;
      if (svc?.getSnapshot) {
        const snap = await svc.getSnapshot();
        items = (snap.items ?? []) as OutputIndexItem[];
      }
    }
    let doneN = 0;
    let longC = 0;
    for (const it of items) {
      const st = String(it.status ?? "").toLowerCase();
      if (st !== "done") continue;
      const dd = String(it.doneDate ?? "").trim();
      if (!ymdInRange(dd, startYmd, endYmd)) continue;
      doneN += 1;
      const cd = String(it.createDate ?? "").trim();
      const gap = ymdDaysDiff(cd, dd);
      if (gap !== null && gap >= OUTPUT_DONE_LONG_CYCLE_DAYS) longC += 1;
    }
    out.outputsDone = doneN;
    out.outputsDoneLongCycle = longC;
    if (!workEventEnabled) {
      out.outputsNew = countOutputsNewInRange(items, startYmd, endYmd);
    }
  } catch {
    // ignore
  }

  try {
    if (plugin.projectMgr) {
      await plugin.projectMgr.ensureReady();
      const snap = plugin.projectMgr.getSnapshot?.();
      const projects: ProjectEntry[] = Array.isArray(snap?.projects) ? snap!.projects! : [];
      for (const p of projects) {
        if (String(p.status ?? "").toLowerCase() !== "done") continue;
        const d = String(p.done ?? "").trim();
        if (ymdInRange(d, startYmd, endYmd)) out.projectsDone += 1;
      }
    }
  } catch (e) {
    console.warn("[RSLatte] rollupPeriod projectsDone skipped:", e);
  }

  const weAg = await readReviewPeriodWorkEventAggregates(plugin, startYmd, endYmd);
  out.outputsPublished = weAg.outputsPublished;
  out.contactEvents = weAg.contactEvents;
  if (workEventEnabled) {
    out.tasksNew = weAg.tasksCreated;
    out.memosNew = weAg.memosCreated;
    out.schedulesNew = weAg.schedulesCreated;
    out.outputsNew = weAg.outputsNew;
    out.contactCreates = weAg.contactCreates;
  }

  return out;
}

/**
 * Review「核对」：基于**周期内已闭环**及时性、**完成/新建**环比、可客观归因的**输出/项目/联系人/提醒**事实与启发式建议。
 * 不包含开放项、风险分桶、待推进清单（依赖当前快照的列表已移除）。
 */
export type ReviewReconcileModel = {
  startYmd: string;
  endYmd: string;
  grain: ReviewReconcileGrain;
  timeliness: {
    taskWithDueClosed: number;
    taskOnTime: number;
    taskLate: number;
    taskOnTimeRateText: string;
    scheduleClosedInPeriod: number;
    scheduleSameDayClose: number;
    scheduleSameDayRateText: string;
    /** 提醒（非日程类）：本周期内完成且带提醒日的样本中，完成日≤提醒日的占比 */
    memoDoneWithReminderYmd: number;
    memoDoneLateAfterReminderYmd: number;
    memoOnTimeRateText: string;
  };
  /** 本周期可展示计数（与环比对照用） */
  periodFacts: {
    projectsDone: number;
    outputsPublished: number;
    contactEvents: number;
    outputsDoneLongCycle: number;
  };
  vsPrev: {
    prevRangeText: string;
    tasksDoneDelta: number;
    memosDoneDelta: number;
    schedulesDoneDelta: number;
    outputsDoneDelta: number;
    projectsDoneDelta: number;
    tasksNewDelta: number;
    memosNewDelta: number;
    schedulesNewDelta: number;
    outputsNewDelta: number;
    contactCreatesDelta: number;
    outputsPublishedDelta: number;
    contactEventsDelta: number;
    hasPrev: boolean;
  };
  suggestions: string[];
};

export async function buildReviewReconcileModel(
  plugin: RSLattePlugin,
  startYmd: string,
  endYmd: string,
  grain: ReviewReconcileGrain,
): Promise<ReviewReconcileModel> {
  const mergeArch = reviewMergeArchiveShardsForGrain(grain);
  const curRoll = await rollupPeriod(plugin, startYmd, endYmd, mergeArch);
  const prevR = prevPeriodRange(startYmd, endYmd);
  let prevRoll: PeriodRollup | null = null;
  if (prevR) {
    try {
      prevRoll = await rollupPeriod(plugin, prevR.prevStart, prevR.prevEnd, mergeArch);
    } catch {
      prevRoll = null;
    }
  }

  const taskOnTimeRateText =
    curRoll.taskWithDueClosed > 0
      ? `${Math.round((100 * curRoll.taskOnTime) / curRoll.taskWithDueClosed)}%（有截止日且本周期内闭环的任务）`
      : "—（本周期无带截止日且已完成的任务样本）";
  const scheduleSameDayRateText =
    curRoll.scheduleClosedInPeriod > 0
      ? `${Math.round((100 * curRoll.scheduleSameDayClose) / curRoll.scheduleClosedInPeriod)}%（完成日=日程日）`
      : "—（本周期无已闭环日程样本）";

  const memoW = curRoll.memosDoneWithReminderYmd;
  const memoLate = curRoll.memosDoneLateAfterReminderYmd;
  const memoOnTime = memoW - memoLate;
  const memoOnTimeRateText =
    memoW > 0
      ? `${Math.round((100 * memoOnTime) / memoW)}%（完成日≤提醒日）`
      : "—（本周期无「带提醒日且已完成」的提醒样本）";

  const vsPrev = {
    prevRangeText: prevR ? `${prevR.prevStart}～${prevR.prevEnd}` : "",
    tasksDoneDelta: prevRoll ? curRoll.tasksDone - prevRoll.tasksDone : 0,
    memosDoneDelta: prevRoll ? curRoll.memosDone - prevRoll.memosDone : 0,
    schedulesDoneDelta: prevRoll ? curRoll.schedulesDone - prevRoll.schedulesDone : 0,
    outputsDoneDelta: prevRoll ? curRoll.outputsDone - prevRoll.outputsDone : 0,
    projectsDoneDelta: prevRoll ? curRoll.projectsDone - prevRoll.projectsDone : 0,
    tasksNewDelta: prevRoll ? curRoll.tasksNew - prevRoll.tasksNew : 0,
    memosNewDelta: prevRoll ? curRoll.memosNew - prevRoll.memosNew : 0,
    schedulesNewDelta: prevRoll ? curRoll.schedulesNew - prevRoll.schedulesNew : 0,
    outputsNewDelta: prevRoll ? curRoll.outputsNew - prevRoll.outputsNew : 0,
    contactCreatesDelta: prevRoll ? curRoll.contactCreates - prevRoll.contactCreates : 0,
    outputsPublishedDelta: prevRoll ? curRoll.outputsPublished - prevRoll.outputsPublished : 0,
    contactEventsDelta: prevRoll ? curRoll.contactEvents - prevRoll.contactEvents : 0,
    hasPrev: !!prevRoll,
  };

  const workEventEnabled = plugin.workEventSvc?.isEnabled?.() === true;
  const grainWord = grain === "month" ? "本月" : grain === "quarter" ? "本季" : "本周";
  const suggestions: string[] = [];
  if (curRoll.taskLate > curRoll.taskOnTime && curRoll.taskWithDueClosed >= 3) {
    suggestions.push(
      `${grainWord}内「晚于计划结束日才标记完成」的任务多于「按时完成」，可适当把计划日设得更现实或拆小任务，提高及时率。`,
    );
  }
  if (memoLate > memoOnTime && memoW >= 3) {
    suggestions.push(
      `${grainWord}内「晚于提醒日才勾选完成」的提醒多于「在提醒日及之前完成」，可检视是否提醒日偏紧或收尾偏晚。`,
    );
  }
  if (curRoll.outputsDoneLongCycle >= 2) {
    suggestions.push(
      `本周期有 ${curRoll.outputsDoneLongCycle} 篇输出从创建到完成间隔较长（≥${OUTPUT_DONE_LONG_CYCLE_DAYS} 天），可关注是否曾长期搁置或范围偏大。`,
    );
  }
  if (workEventEnabled && curRoll.outputsPublished > 0 && curRoll.outputsDone === 0) {
    suggestions.push("本周期操作日志中有输出「发布」记录，但索引中无本周期「完成」输出，可核对发布与 done 状态是否一致。");
  }
  if (workEventEnabled && curRoll.outputsPublished > curRoll.outputsDone + 2) {
    suggestions.push("本周期「发布」次数（日志）明显多于索引中本周期「完成」篇数，可关注完成态是否与发布节奏同步。");
  }
  if (vsPrev.hasPrev && vsPrev.tasksDoneDelta < 0 && Math.abs(vsPrev.tasksDoneDelta) >= 2) {
    suggestions.push(`较上一同期完成任务数少 ${Math.abs(vsPrev.tasksDoneDelta)} 条，注意是否积压或计划过载。`);
  }
  if (vsPrev.hasPrev && vsPrev.contactCreatesDelta < -1) {
    suggestions.push("新建联系人数较上一同期偏少；若有拓展关系需求，可关注录入节奏。");
  }
  if (vsPrev.hasPrev && vsPrev.projectsDoneDelta <= -2) {
    suggestions.push("项目「完结」数（快照 done 落在周期内）较上一同期偏少；若有收尾预期可核对项目状态。");
  }
  if (curRoll.scheduleClosedInPeriod > 0 && curRoll.scheduleSameDayClose < curRoll.scheduleClosedInPeriod * 0.5) {
    suggestions.push("已闭环日程中，当日打卡完成的比例不高，可尝试在日程当日结束前勾选完成，便于复盘时间分配。");
  }

  return {
    startYmd,
    endYmd,
    grain,
    timeliness: {
      taskWithDueClosed: curRoll.taskWithDueClosed,
      taskOnTime: curRoll.taskOnTime,
      taskLate: curRoll.taskLate,
      taskOnTimeRateText,
      scheduleClosedInPeriod: curRoll.scheduleClosedInPeriod,
      scheduleSameDayClose: curRoll.scheduleSameDayClose,
      scheduleSameDayRateText,
      memoDoneWithReminderYmd: memoW,
      memoDoneLateAfterReminderYmd: memoLate,
      memoOnTimeRateText,
    },
    periodFacts: {
      projectsDone: curRoll.projectsDone,
      outputsPublished: curRoll.outputsPublished,
      contactEvents: curRoll.contactEvents,
      outputsDoneLongCycle: curRoll.outputsDoneLongCycle,
    },
    vsPrev,
    suggestions: suggestions.slice(0, 8),
  };
}
