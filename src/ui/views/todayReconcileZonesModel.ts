/**
 * Today「今日核对」七分区数据模型（展示与跳转，不写业务状态）。
 * 日程轨迹数据与 `scheduleCalendarModel` 泳道/重叠算法对齐，由 `recordReconcileRender.renderScheduleTimelineSwimlane` 按日程日历同款 DOM 渲染。
 */
import { moment, normalizePath } from "obsidian";
import type RSLattePlugin from "../../main";
import type { WorkEvent } from "../../types/stats/workEvent";
import type { OutputIndexItem } from "../../types/outputTypes";
import { getTaskTodayKey, computeTaskTags, TASK_TAG_META } from "../../taskRSLatte/task";
import { calendarTodayYmd, computeMemoTags, MEMO_TAG_META } from "../../taskRSLatte/memo";
import { computeScheduleTags, SCHEDULE_TAG_META } from "../../taskRSLatte/schedule";
import { isScheduleMemoLine, type RSLatteIndexItem } from "../../taskRSLatte/types";
import type { ProjectEntry, ProjectTaskItem } from "../../projectManager/types";
import { getProjectTaskTagsOrCompute } from "../../projectManager/projectDerivatives";
import type { RecordLine, RecordLineChangeRow } from "./recordTodayModel";
import { readMergedOutputLedgerMaps } from "../../outputRSLatte/outputHistoryLedger";
import type { ContactInteractionEvent } from "../../contactsRSLatte/types";
import type { ScheduleSwimlaneSegment } from "../helpers/scheduleCalendarModel";
import {
  buildScheduleDaySwimlaneSegments,
  getScheduleDayIntervalMinutes,
  getScheduleDayOverlapRegions,
  sortSchedulesForDay,
} from "../helpers/scheduleCalendarModel";
import { outputDoneLocalYmd } from "../../utils/localCalendarYmd";

const momentFn = moment as any;

export type ReconcileDayBucket = "lateNight" | "morning" | "afternoon" | "evening";

export type NewCountsBucket = {
  task?: number;
  reminder?: number;
  schedule?: number;
  capture?: number;
  projectTask?: number;
  contact?: number;
  output?: number;
};

/** 与日程日历 `CalendarView` 泳道同源：`buildScheduleDaySwimlaneSegments` + 刻度/重叠竖线数据 */
export type TodayScheduleTimelineModel = {
  items: RSLatteIndexItem[];
  segments: ScheduleSwimlaneSegment[];
  laneCount: number;
  overlapRegions: { start: number; end: number }[];
  dayYmd: string;
};

export type ContactDynamicRow = {
  contactUid: string;
  displayName: string;
  newInteractionsToday: number;
  lastAtLabel: string;
  filePath?: string;
};

export type TodayReconcileZonesModel = {
  taskToday: string;
  calToday: string;
  followUp: { taskProgress: boolean; contactInteraction: boolean; projectProgress: boolean };
  newByBucket: Record<ReconcileDayBucket, NewCountsBucket>;
  closedDone: { tasks: RecordLine[]; projectTasks: RecordLine[] };
  closedShut: { schedules: RecordLine[]; reminders: RecordLine[] };
  closedOutput: { drafts: RecordLine[]; published: RecordLine[] };
  scheduleTimeline: TodayScheduleTimelineModel;
  updates: {
    taskStatus: RecordLine[];
    postpone: RecordLine[];
    waitFollow: RecordLine[];
    projectNextAction: RecordLine[];
    contactDynamics: ContactDynamicRow[];
    contactProfileUpdates: RecordLine[];
  };
  recap: {
    task: string;
    project: string;
    schedule: string;
    scheduleDoneBreakdown: string;
    contact: string;
    output: string;
  };
};

function ymd(s?: string): string {
  if (!s || typeof s !== "string") return "";
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

/**
 * ISO 时间戳 → 与 {@link calendarTodayYmd} 一致的**本地**日历日 YYYY-MM-DD。
 * 解决 `...Z` 在 UTC 与本地跨日导致「主索引 updated_at 为今日」与侧栏 `calToday` 对不上的问题。
 */
function isoToLocalCalendarYmd(s?: string | null): string {
  const raw = String(s ?? "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const d = momentFn(raw);
  return d.isValid() ? d.format("YYYY-MM-DD") : ymd(raw);
}

function eventDay(ts: string): string {
  const d = momentFn(ts);
  return d.isValid() ? d.format("YYYY-MM-DD") : "";
}

function eventHour(ts: string): number | null {
  const d = momentFn(ts);
  if (!d.isValid()) return null;
  return d.hour();
}

function bucketFromHour(h: number): ReconcileDayBucket {
  if (h >= 0 && h < 6) return "lateNight";
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
}

function bumpNew(
  m: Record<ReconcileDayBucket, NewCountsBucket>,
  bucket: ReconcileDayBucket,
  key: keyof NewCountsBucket,
  n = 1
): void {
  const b = m[bucket] ?? {};
  b[key] = (b[key] ?? 0) + n;
  m[bucket] = b;
}

async function readEventsAroundDay(plugin: RSLattePlugin, dayYmd: string): Promise<WorkEvent[]> {
  const spaceId = plugin.getCurrentSpaceId();
  const keys = new Set<string>();
  keys.add(momentFn(dayYmd, "YYYY-MM-DD").format("YYYYMM"));
  keys.add(momentFn(dayYmd, "YYYY-MM-DD").subtract(1, "month").format("YYYYMM"));
  keys.add(momentFn(dayYmd, "YYYY-MM-DD").add(1, "month").format("YYYYMM"));
  const out: WorkEvent[] = [];
  for (const mk of keys) {
    try {
      const evs = await plugin.workEventReader.readEvents(spaceId, mk);
      out.push(...evs);
    } catch {
      // ignore
    }
  }
  return out;
}

function stripDesc(raw: string): string {
  return String(raw ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*⭐\s*/u, "")
    .trim();
}

function tagChipsTask(
  it: RSLatteIndexItem,
  calDay: string,
  panel: any,
  memoTagDay: string | undefined,
  schedTagDay: string | undefined
): string[] {
  const anyIt = it as any;
  const keys: string[] = [];
  const pushMeta = (rec: Record<string, { label: string }>, arr: string[]) => {
    for (const k of arr.slice(0, 3)) {
      const label = rec[k]?.label ?? k;
      if (label) keys.push(label);
    }
  };
  if (String(anyIt.itemType ?? "").toLowerCase() === "task") {
    const arr =
      panel && anyIt.task_tags?.length
        ? anyIt.task_tags
        : computeTaskTags(it, getTaskTodayKey(panel), panel);
    pushMeta(TASK_TAG_META as any, arr);
  } else if (isScheduleMemoLine(it)) {
    const arr =
      schedTagDay === calDay && Array.isArray(anyIt.schedule_tags) && anyIt.schedule_tags.length
        ? anyIt.schedule_tags
        : computeScheduleTags(it, calDay, panel);
    pushMeta(SCHEDULE_TAG_META as any, arr);
  } else {
    const arr =
      memoTagDay === calDay && Array.isArray(anyIt.memo_tags) && anyIt.memo_tags.length
        ? anyIt.memo_tags
        : computeMemoTags(it, calDay, panel);
    pushMeta(MEMO_TAG_META as any, arr);
  }
  return keys.slice(0, 2);
}

function lineFromIndex(
  kindLabel: string,
  it: RSLatteIndexItem,
  meta: string,
  calDay: string,
  panel: any,
  memoTagDay: string | undefined,
  schedTagDay: string | undefined,
  ref?: RecordLine["ref"]
): RecordLine {
  const anyIt = it as any;
  return {
    kindLabel,
    title: stripDesc(String(anyIt.text ?? anyIt.description ?? "（无描述）")).slice(0, 120),
    tags: tagChipsTask(it, calDay, panel, memoTagDay, schedTagDay),
    meta,
    filePath: String(anyIt.filePath ?? "").trim() || undefined,
    lineNo: Number.isFinite(Number(anyIt.lineNo)) ? Number(anyIt.lineNo) : undefined,
    ref: {
      ...ref,
      taskUid: String(anyIt.uid ?? "").trim() || undefined,
      scheduleUid: isScheduleMemoLine(it) ? String(anyIt.uid ?? "").trim() || undefined : ref?.scheduleUid,
    },
  };
}

function reminderClosedYmd(it: RSLatteIndexItem): string {
  const extra = ((it as any)?.extra ?? {}) as Record<string, string>;
  const invalidated = String(extra.invalidated ?? "").trim() === "1";
  return (
    ymd(String((it as any)?.done_date ?? "")) ||
    ymd(String((it as any)?.cancelled_date ?? "")) ||
    ymd(String(extra.invalidated_date ?? "")) ||
    (invalidated ? ymd(String((it as any)?.updated_date ?? "")) : "")
  );
}

function scheduleClosedYmd(it: RSLatteIndexItem): string {
  const extra = ((it as any)?.extra ?? {}) as Record<string, string>;
  return (
    ymd(String((it as any)?.done_date ?? "")) ||
    ymd(String((it as any)?.cancelled_date ?? "")) ||
    ymd(String(extra.invalidated_date ?? ""))
  );
}

function dedupeLines(lines: RecordLine[]): RecordLine[] {
  const seen = new Set<string>();
  const out: RecordLine[] = [];
  for (const L of lines) {
    const k = `${L.kindLabel}|${L.title}|${L.filePath ?? ""}|${L.lineNo ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(L);
  }
  return out;
}

function activeProjectTasks(projects: ProjectEntry[]): Array<{ p: ProjectEntry; t: ProjectTaskItem }> {
  const out: Array<{ p: ProjectEntry; t: ProjectTaskItem }> = [];
  for (const p of projects ?? []) {
    const pst = String(p?.status ?? "").trim();
    if (pst === "done" || pst === "cancelled") continue;
    for (const t of p.taskItems ?? []) {
      const st = String(t.statusName ?? "").toUpperCase();
      if (st === "DONE" || st === "CANCELLED") continue;
      out.push({ p, t });
    }
  }
  return out;
}

function eventOnDay(ts: string, dayYmd: string): boolean {
  return eventDay(ts) === dayYmd;
}

function taskRefUid(e: WorkEvent): string {
  return String(e.ref?.task_uid ?? e.ref?.taskUid ?? e.ref?.uid ?? "").trim();
}

const PHASE_CN: Record<string, string> = {
  todo: "未开始",
  in_progress: "处理中",
  waiting_others: "跟进中",
  waiting_until: "等待中",
  done: "已完成",
  cancelled: "已取消",
};

function phaseCn(p?: string): string {
  const k = String(p ?? "").trim();
  return PHASE_CN[k] || k || "—";
}

function formatEventTimeLocal(ts: string): string {
  const d = momentFn(ts);
  return d.isValid() ? d.format("HH:mm") : (ts.length >= 16 ? ts.slice(11, 16) : ts);
}

/** `projecttask` WorkEvent.ref：一级轨「下一步」任务时为 true（由 `ProjectManagerService` 写入） */
function refIsNextActionForL1(e: WorkEvent): boolean {
  const v = (e.ref as Record<string, unknown> | undefined)?.is_next_action_for_l1;
  return v === true || v === "true";
}

function projectEntryById(projects: ProjectEntry[], projectId: string): ProjectEntry | undefined {
  return projects.find((x) => String(x.projectId ?? "").trim() === projectId);
}

/**
 * 「项目推进变化（next action）」：
 * - 当日 `projecttask` 且 `ref.is_next_action_for_l1`（含状态/阶段/延期/编辑等）；
 * - 若同日存在「下一步」任务的 done/cancelled，则用**当前项目快照**补一行「新任下一步」（无新任务则不出）；
 * - 保留 `kind=project` 且摘要含下一步/推进/milestone 的少量兜底。
 */
function buildProjectNextActionRecordLines(dayEvents: WorkEvent[], projects: ProjectEntry[]): RecordLine[] {
  const lines: RecordLine[] = [];

  for (const e of dayEvents) {
    if (e.kind !== "projecttask") continue;
    if (!refIsNextActionForL1(e)) continue;
    const pid = String(e.ref?.project_id ?? e.ref?.projectId ?? "").trim();
    let pname = String(e.ref?.project_name ?? "").trim();
    if (!pname && pid) pname = String(projectEntryById(projects, pid)?.projectName ?? "").trim();
    const sum = String(e.summary ?? "").trim() || "项目任务（下一步）";
    const title = pname ? `${pname} · ${sum}` : sum;
    lines.push({
      kindLabel: "项目",
      title: title.slice(0, 200),
      tags: ["下一步"],
      meta: formatEventTimeLocal(e.ts),
      ref: { projectId: pid || undefined },
    });
  }

  const pidsNaDone = new Set<string>();
  for (const e of dayEvents) {
    if (e.kind !== "projecttask") continue;
    if (!refIsNextActionForL1(e)) continue;
    if (e.action !== "done" && e.action !== "cancelled") continue;
    const pid = String(e.ref?.project_id ?? e.ref?.projectId ?? "").trim();
    if (pid) pidsNaDone.add(pid);
  }

  for (const pid of pidsNaDone) {
    const p = projectEntryById(projects, pid);
    if (!p) continue;
    const pst = String(p?.status ?? "").trim();
    if (pst === "done" || pst === "cancelled") continue;
    const nextT = (p.taskItems ?? []).find((t) => {
      if (!t.is_next_action_for_l1) return false;
      const st = String(t.statusName ?? "").toUpperCase();
      if (st === "DONE" || st === "CANCELLED") return false;
      return true;
    });
    if (!nextT?.text) continue;
    const closedTids = new Set(
      dayEvents
        .filter(
          (ev) =>
            ev.kind === "projecttask" &&
            refIsNextActionForL1(ev) &&
            (ev.action === "done" || ev.action === "cancelled") &&
            String(ev.ref?.project_id ?? ev.ref?.projectId ?? "").trim() === pid
        )
        .map((ev) => String(ev.ref?.task_id ?? "").trim())
        .filter(Boolean)
    );
    const nextId = String(nextT.taskId ?? "").trim();
    if (nextId && closedTids.has(nextId)) continue;
    const pname = String(p.projectName ?? "").trim() || "项目";
    const nt = String(nextT.text ?? "").trim().slice(0, 80);
    lines.push({
      kindLabel: "项目",
      title: `${pname} · 新任下一步：${nt}`,
      tags: ["下一步"],
      meta: "当前",
      ref: { projectId: pid },
    });
  }

  for (const e of dayEvents) {
    if (e.kind !== "project") continue;
    if (e.action !== "update" && e.action !== "start" && e.action !== "continued") continue;
    if (!/下一步|next|推进|milestone/i.test(String(e.summary ?? ""))) continue;
    const pid = String(e.ref?.project_id ?? e.ref?.projectId ?? "").trim();
    lines.push({
      kindLabel: "项目",
      title: String(e.summary ?? "项目推进").slice(0, 120),
      tags: [],
      meta: formatEventTimeLocal(e.ts),
      ref: { projectId: pid || undefined },
    });
  }

  return lines;
}

function workEventPostponeP(e: WorkEvent): boolean {
  if (e.action !== "update") return false;
  const m = e.metrics ?? {};
  const r = e.ref ?? {};
  if (Number(m.postpone_days) > 0 || Number(r.postpone_days) > 0 || Number(r.days) > 0) return true;
  return /延期|postpone|推迟|改期/i.test(String(e.summary ?? ""));
}

/** 合并后的端点是否落入「等待/跟进」区（跟进中 / 等待中） */
function touchesWaitFollowPhase(phase: string): boolean {
  const p = String(phase ?? "").trim();
  return p === "waiting_others" || p === "waiting_until";
}

function stripSummaryLead(s: string): string {
  return String(s ?? "")
    .replace(/^[\s﻿]*[\u{1F300}-\u{1FAFF}\u2600-\u27BF⭐✅❌⛔▶⏸↻↪☆]+\s*/u, "")
    .trim();
}

function detailFromPhaseOrSummary(e: WorkEvent): string {
  const r = (e.ref ?? {}) as Record<string, unknown>;
  const before = String(r.task_phase_before ?? "").trim();
  const after = String(r.task_phase_after ?? "").trim();
  if (before && after) {
    if (before !== after) return `${phaseCn(before)} → ${phaseCn(after)}`;
    if (before === after && workEventPostponeP(e)) return "到期改期（阶段未变）";
  }
  return stripSummaryLead(String(e.summary ?? e.action)) || String(e.action);
}

function postponeDetailFromEvent(e: WorkEvent): string {
  const m = e.metrics ?? {};
  const r = e.ref ?? {};
  const days = Number(m.postpone_days ?? r.postpone_days ?? r.days ?? NaN);
  if (Number.isFinite(days) && days > 0) return `延期 ${days} 天（到期顺延）`;
  return detailFromPhaseOrSummary(e);
}

/**
 * 当日任务/项目任务：延期单独分桶；其余参与「阶段链合并」后再归入状态区或等待/跟进区。
 */
function classifyTaskFamilyEvent(e: WorkEvent): "postpone" | "phase" | "skip" | null {
  if (e.kind !== "task" && e.kind !== "projecttask") return null;
  if (e.action === "create") return null;
  const sum = String(e.summary ?? "");
  if (/星标/.test(sum)) return "skip";
  const r = (e.ref ?? {}) as Record<string, unknown>;
  if (e.action === "update" && r.starred != null && String(r.task_phase_before ?? "") === String(r.task_phase_after ?? "")) {
    return "skip";
  }
  if (workEventPostponeP(e)) return "postpone";
  return "phase";
}

function inferPhaseAfterFromEvent(e: WorkEvent): string {
  const r = (e.ref ?? {}) as Record<string, unknown>;
  const a = String(r.task_phase_after ?? "").trim();
  if (a) return a;
  const to = String(r.to ?? "").trim().toUpperCase().replace(/-/g, "_");
  if (to === "DONE") return "done";
  if (to === "CANCELLED") return "cancelled";
  if (to === "TODO") return "todo";
  if (to === "IN_PROGRESS") {
    const tp = String(r.task_phase ?? "").trim();
    if (tp === "waiting_others" || tp === "waiting_until" || tp === "in_progress") return tp;
    return "in_progress";
  }
  if (e.action === "done") return "done";
  if (e.action === "cancelled") return "cancelled";
  return "";
}

/** 首条事件缺 task_phase_before 时的弱推断（兼容旧事件） */
function inferPhaseBeforeFirstEvent(e: WorkEvent): string {
  const r = (e.ref ?? {}) as Record<string, unknown>;
  const b = String(r.task_phase_before ?? "").trim();
  if (b) return b;
  if (e.action === "start") return "todo";
  const a = String(r.task_phase_after ?? "").trim();
  if (a) return a;
  return inferPhaseAfterFromEvent(e);
}

/**
 * 同一任务当日多条阶段类事件 → 首条 task_phase_before + 末条 task_phase_after；
 * 相同则返回 null（净变化为 0，不展示）；时间取末条事件。
 */
function mergePhaseChainRow(events: WorkEvent[]): { row: RecordLineChangeRow; inWaitSection: boolean } | null {
  const sorted = [...events].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  if (!sorted.length) return null;
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const r0 = (first.ref ?? {}) as Record<string, unknown>;
  const rN = (last.ref ?? {}) as Record<string, unknown>;
  let start = String(r0.task_phase_before ?? "").trim();
  let end = String(rN.task_phase_after ?? "").trim();
  if (!start) start = inferPhaseBeforeFirstEvent(first);
  if (!end) end = inferPhaseAfterFromEvent(last);
  if (!start || !end) return null;
  if (start === end) return null;
  const inWait = touchesWaitFollowPhase(start) || touchesWaitFollowPhase(end);
  return {
    row: {
      detail: `${phaseCn(start)} → ${phaseCn(end)}`,
      timeLabel: formatEventTimeLocal(last.ts),
    },
    inWaitSection: inWait,
  };
}

type UpdateZoneAgg = {
  key: string;
  isProj: boolean;
  kindLabel: string;
  id: string;
  events: WorkEvent[];
  /** 阶段链合并后的单行（状态区 / 等待区）；有则优先于 events 展开 */
  mergedPhaseRow?: RecordLineChangeRow;
};

function pushUpdateAgg(map: Map<string, UpdateZoneAgg>, key: string, base: Omit<UpdateZoneAgg, "events">, e: WorkEvent): void {
  let g = map.get(key);
  if (!g) {
    g = { ...base, events: [] };
    map.set(key, g);
  }
  g.events.push(e);
}

/** 延期区：多条合并为一行，文案与时间取最后一次延期事件 */
function buildPostponeChangeRows(events: WorkEvent[]): RecordLineChangeRow[] {
  const sorted = [...events].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const last = sorted[sorted.length - 1];
  return [{ detail: postponeDetailFromEvent(last), timeLabel: formatEventTimeLocal(last.ts) }];
}

function recordLineFromUpdateAgg(
  agg: UpdateZoneAgg,
  zone: "status" | "postpone" | "wait",
  taskItems: RSLatteIndexItem[],
  projects: ProjectEntry[],
  calDay: string,
  panel: any,
  memoTagDay: string | undefined,
  schedTagDay: string | undefined,
  taskToday: string
): RecordLine | null {
  const id = agg.id;
  if (!id) return null;
  if (!agg.isProj) {
    const it = taskItems.find((x) => String((x as any).uid ?? "").trim() === id);
    if (it) {
      const L = lineFromIndex(agg.kindLabel, it, "", calDay, panel, memoTagDay, schedTagDay, { taskUid: id });
      let rows: RecordLineChangeRow[];
      if (zone === "postpone") {
        rows =
          agg.events.length > 0
            ? buildPostponeChangeRows(agg.events)
            : [
                {
                  detail: "索引：已延期（今日有进展更新）",
                  timeLabel: formatEventTimeLocal(String((it as any).progress_updated ?? "")) || "—",
                },
              ];
      } else {
        if (!agg.mergedPhaseRow) return null;
        rows = [agg.mergedPhaseRow];
      }
      return {
        ...L,
        title: stripDesc(String((it as any).text ?? "（无描述）")).slice(0, 120),
        changeRows: rows,
        dotStatus: String((it as any).status ?? ""),
        dotTaskPhase: String((it as any).task_phase ?? "").trim() || undefined,
        meta: rows.length ? rows[rows.length - 1].timeLabel : "",
      };
    }
    if (zone === "postpone") {
      if (!agg.events.length) return null;
      const rows = buildPostponeChangeRows(agg.events);
      return {
        kindLabel: agg.kindLabel,
        title: stripSummaryLead(String(agg.events[agg.events.length - 1]?.summary ?? id)).slice(0, 120),
        tags: [],
        meta: rows.length ? rows[rows.length - 1].timeLabel : "",
        changeRows: rows,
        ref: { taskUid: id },
      };
    }
    if (!agg.mergedPhaseRow) return null;
    const rows = [agg.mergedPhaseRow];
    return {
      kindLabel: agg.kindLabel,
      title: stripSummaryLead(String(agg.events[agg.events.length - 1]?.summary ?? id)).slice(0, 120),
      tags: [],
      meta: rows[0]?.timeLabel ?? "",
      changeRows: rows,
      ref: { taskUid: id },
    };
  }
  for (const p of projects ?? []) {
    const t = (p.taskItems ?? []).find((x) => String(x.taskId ?? "") === id);
    if (t) {
      const fp = String(t.sourceFilePath ?? p.tasklistFilePath ?? "").trim();
      const ptags = getProjectTaskTagsOrCompute(t, taskToday, panel);
      let rows: RecordLineChangeRow[];
      if (zone === "postpone") {
        rows =
          agg.events.length > 0
            ? buildPostponeChangeRows(agg.events)
            : [
                {
                  detail: "索引：已延期（今日有进展更新）",
                  timeLabel: formatEventTimeLocal(String(t.progress_updated ?? "")) || "—",
                },
              ];
      } else {
        if (!agg.mergedPhaseRow) return null;
        rows = [agg.mergedPhaseRow];
      }
      return {
        kindLabel: "项目任务",
        title: stripDesc(t.text).slice(0, 120),
        tags: ptags.slice(0, 6),
        meta: rows.length ? rows[rows.length - 1].timeLabel : "",
        filePath: fp || undefined,
        lineNo: t.lineNo,
        ref: { taskUid: id },
        changeRows: rows,
        dotStatus: String(t.statusName ?? ""),
        dotTaskPhase: String(t.task_phase ?? "").trim() || undefined,
      };
    }
  }
  const lastEv = agg.events[agg.events.length - 1];
  const ref = (lastEv?.ref ?? {}) as Record<string, unknown>;
  if (zone === "postpone") {
    if (!agg.events.length) return null;
    const rows = buildPostponeChangeRows(agg.events);
    return {
      kindLabel: "项目任务",
      title: String(ref.text ?? stripSummaryLead(String(lastEv?.summary ?? id))).slice(0, 120),
      tags: [],
      meta: rows.length ? rows[rows.length - 1].timeLabel : "",
      changeRows: rows,
      ref: { taskUid: id },
      dotStatus: "IN_PROGRESS",
      dotTaskPhase: String(ref.task_phase_after ?? ref.task_phase ?? "").trim() || undefined,
    };
  }
  if (!agg.mergedPhaseRow) return null;
  const rows = [agg.mergedPhaseRow];
  return {
    kindLabel: "项目任务",
    title: String(ref.text ?? stripSummaryLead(String(lastEv?.summary ?? id))).slice(0, 120),
    tags: [],
    meta: rows[0]?.timeLabel ?? "",
    changeRows: rows,
    ref: { taskUid: id },
    dotStatus: "IN_PROGRESS",
    dotTaskPhase: String(ref.task_phase_after ?? ref.task_phase ?? "").trim() || undefined,
  };
}

function updateAggsToLines(
  map: Map<string, UpdateZoneAgg>,
  zone: "status" | "postpone" | "wait",
  taskItems: RSLatteIndexItem[],
  projects: ProjectEntry[],
  calDay: string,
  panel: any,
  memoTagDay: string | undefined,
  schedTagDay: string | undefined,
  taskToday: string
): RecordLine[] {
  const out: RecordLine[] = [];
  for (const agg of map.values()) {
    const L = recordLineFromUpdateAgg(agg, zone, taskItems, projects, calDay, panel, memoTagDay, schedTagDay, taskToday);
    if (L) out.push(L);
  }
  return out;
}

function interactionEventOnDay(ev: ContactInteractionEvent, dayYmd: string): boolean {
  const o = String(ev?.occurred_at ?? "").trim();
  return o ? isoToLocalCalendarYmd(o) === dayYmd : false;
}

/**
 * §2.2 新增区：与产品约定一致——仅统计 `action === "create"`，按 `kind` 映射展示列。
 * 旧数据：日程曾记为 `memo` + `create` + `ref.category === "schedule"`，归入日程列。
 */
function reconcileNewColumnFromCreateEvent(e: WorkEvent): keyof NewCountsBucket | null {
  if (e.action !== "create") return null;
  const cat = String(e.ref?.category ?? "").trim().toLowerCase();
  if (e.kind === "memo" && cat === "schedule") return "schedule";
  const map: Partial<Record<WorkEvent["kind"], keyof NewCountsBucket>> = {
    task: "task",
    memo: "reminder",
    schedule: "schedule",
    capture: "capture",
    projecttask: "projectTask",
    contact: "contact",
    output: "output",
  };
  return map[e.kind] ?? null;
}

/** 同日、同列下去重，减轻同步重放 / 重复 append */
function reconcileNewCreateDedupeKey(e: WorkEvent, col: keyof NewCountsBucket): string {
  const r = e.ref ?? {};
  if (col === "task") return `task:${String(r.uid ?? r.task_uid ?? "").trim() || e.ts}`;
  if (col === "reminder") return `memo:${String(r.uid ?? "").trim() || e.ts}`;
  if (col === "schedule") return `sch:${String(r.uid ?? "").trim() || e.ts}`;
  if (col === "capture") {
    return `cap:${e.event_id ? String(e.event_id) : `${e.ts}|${String(e.summary ?? "").slice(0, 64)}`}`;
  }
  if (col === "projectTask") return `pt:${String(r.task_id ?? "").trim() || e.ts}`;
  if (col === "contact") return `ct:${String(r.contact_uid ?? "").trim() || e.ts}`;
  if (col === "output") return `out:${String(r.output_id ?? "").trim() || e.ts}`;
  return `${e.kind}|${e.ts}`;
}

export async function buildTodayReconcileZonesModel(plugin: RSLattePlugin): Promise<TodayReconcileZonesModel> {
  const taskToday = getTaskTodayKey(plugin.settings?.taskPanel ?? undefined);
  const calToday = calendarTodayYmd();
  const panel = plugin.settings?.taskPanel ?? undefined;

  let memoTagDay: string | undefined;
  let schedTagDay: string | undefined;
  try {
    memoTagDay = await plugin.taskRSLatte.getMemoIndexTagsDerivedDay();
    schedTagDay = await plugin.taskRSLatte.getScheduleIndexTagsDerivedDay();
  } catch {
    memoTagDay = undefined;
    schedTagDay = undefined;
  }

  const lists = await plugin.taskRSLatte.getTaskListsForSidePanel();
  const schedules = await plugin.taskRSLatte.queryScheduleBuckets({
    upcomingDays: plugin.settings.taskPanel?.scheduleUpcomingDays ?? 5,
    recentClosedDays: plugin.settings.taskPanel?.scheduleRecentClosedDays ?? 30,
  });
  const reminders = await plugin.taskRSLatte.queryReminderBuckets({
    upcomingDays: plugin.settings.taskPanel?.reminderUpcomingDays ?? 5,
    recentClosedDays: plugin.settings.taskPanel?.recentClosedMemoWindowDays ?? 30,
  });
  const projSnap = plugin.projectMgr?.getSnapshot?.();
  const projects: ProjectEntry[] = Array.isArray(projSnap?.projects) ? projSnap!.projects : [];

  const store = (plugin.taskRSLatte as any)?.store;
  let taskItems: RSLatteIndexItem[] = [];
  let memoItems: RSLatteIndexItem[] = [];
  let scheduleItems: RSLatteIndexItem[] = [];
  try {
    if (store?.readIndex) {
      taskItems = ((await store.readIndex("task"))?.items ?? []) as RSLatteIndexItem[];
      memoItems = ((await store.readIndex("memo"))?.items ?? []) as RSLatteIndexItem[];
      scheduleItems = ((await store.readIndex("schedule"))?.items ?? []) as RSLatteIndexItem[];
    }
  } catch {
    // ignore
  }

  const dayEvents = (await readEventsAroundDay(plugin, taskToday)).filter((e) => eventOnDay(e.ts, taskToday));

  // —— 1）状态区 ——
  let taskProgress = false;
  for (const it of taskItems) {
    if (ymd((it as any).progress_updated) === taskToday) {
      taskProgress = true;
      break;
    }
  }
  let contactInteraction = false;
  try {
    const cidx = await plugin.contactsIndex?.getIndexStore?.().readIndex?.();
    for (const it of cidx?.items ?? []) {
      if (isoToLocalCalendarYmd(String((it as any).last_interaction_at ?? "")) === calToday) {
        contactInteraction = true;
        break;
      }
    }
  } catch {
    // ignore
  }
  let projectProgress = false;
  for (const p of projects) {
    const pst = String(p?.status ?? "").trim();
    if (pst === "done" || pst === "cancelled") continue;
    if (ymd(String(p.progress_updated ?? "")) === taskToday) {
      projectProgress = true;
      break;
    }
  }

  // —— 2）新增区（按工作事件时刻分桶；无时刻则归上午） ——
  const newByBucket: Record<ReconcileDayBucket, NewCountsBucket> = {
    lateNight: {},
    morning: {},
    afternoon: {},
    evening: {},
  };

  const seenNewCreate = new Set<string>();
  for (const e of dayEvents) {
    const col = reconcileNewColumnFromCreateEvent(e);
    if (!col) continue;
    const dk = reconcileNewCreateDedupeKey(e, col);
    if (seenNewCreate.has(dk)) continue;
    seenNewCreate.add(dk);
    const h = eventHour(e.ts);
    const bucket = h === null ? "morning" : bucketFromHour(h);
    bumpNew(newByBucket, bucket, col, 1);
  }

  let outSnap: { items?: OutputIndexItem[] } = { items: [] };
  try {
    outSnap = (await plugin.outputRSLatte?.getSnapshot?.()) ?? { items: [] };
  } catch {
    outSnap = { items: [] };
  }

  // —— 3）闭环区 ——
  const closedTasks: RecordLine[] = [];
  const closedProjTasks: RecordLine[] = [];
  for (const it of lists.closedDone ?? []) {
    if (ymd((it as any).done_date) !== taskToday) continue;
    closedTasks.push(
      lineFromIndex("任务", it, `已完成 ${ymd((it as any).done_date)}`, calToday, panel, memoTagDay, schedTagDay)
    );
  }
  for (const it of lists.closedCancelled ?? []) {
    if (ymd((it as any).cancelled_date) !== taskToday) continue;
    closedTasks.push(
      lineFromIndex("任务", it, `已取消 ${ymd((it as any).cancelled_date)}`, calToday, panel, memoTagDay, schedTagDay)
    );
  }
  for (const p of projects) {
    const pst = String(p?.status ?? "").trim();
    if (pst === "done" || pst === "cancelled") continue;
    for (const t of p.taskItems ?? []) {
      const st = String(t.statusName ?? "").toUpperCase();
      const fp = String(t.sourceFilePath ?? p.tasklistFilePath ?? "").trim();
      if (st === "DONE" && ymd(t.done_date) === taskToday) {
        closedProjTasks.push({
          kindLabel: "项目任务",
          title: `【${String(p.projectName ?? "").trim() || "项目"}】 ${stripDesc(t.text).slice(0, 100)}`,
          tags: getProjectTaskTagsOrCompute(t, taskToday, panel).slice(0, 4),
          meta: `已完成 ${ymd(t.done_date)}`,
          filePath: fp || undefined,
          lineNo: t.lineNo,
          ref: { taskUid: t.taskId },
        });
      } else if (st === "CANCELLED" && ymd(t.cancelled_date) === taskToday) {
        closedProjTasks.push({
          kindLabel: "项目任务",
          title: `【${String(p.projectName ?? "").trim() || "项目"}】 ${stripDesc(t.text).slice(0, 100)}`,
          tags: getProjectTaskTagsOrCompute(t, taskToday, panel).slice(0, 4),
          meta: `已取消 ${ymd(t.cancelled_date)}`,
          filePath: fp || undefined,
          lineNo: t.lineNo,
          ref: { taskUid: t.taskId },
        });
      }
    }
  }

  const closedSchedules: RecordLine[] = [];
  for (const it of schedules.recentClosed ?? []) {
    if (scheduleClosedYmd(it) !== calToday) continue;
    closedSchedules.push(lineFromIndex("日程", it, "已结束", calToday, panel, memoTagDay, schedTagDay));
  }
  const closedReminders: RecordLine[] = [];
  for (const it of reminders.recentClosed ?? []) {
    if (isScheduleMemoLine(it)) continue;
    const cy = reminderClosedYmd(it);
    if (cy !== calToday) continue;
    const st = String((it as any).status ?? "").toUpperCase();
    const meta = st === "CANCELLED" ? "已取消" : st === "DONE" ? "已处理" : "已闭环";
    closedReminders.push(lineFromIndex("提醒", it, meta, calToday, panel, memoTagDay, schedTagDay));
  }

  const closedDrafts: RecordLine[] = [];
  const closedPublished: RecordLine[] = [];
  /** 与侧栏一致：`done_time` 为 UTC ISO 时按本地日历日；否则用 `doneDate` */
  /** 任务日 / 日历日任一命中：避免仅 `doneTime` 有值时 `doneDate` 空导致漏列，且与日程闭环用 calToday 对齐 */
  const outputClosedMatchesToday = (doneY: string): boolean =>
    !!doneY && (doneY === taskToday || doneY === calToday);

  for (const o of outSnap.items ?? []) {
    const st = String(o.status ?? "").toLowerCase();
    const doneY = outputDoneLocalYmd(o.doneDate, o.doneTime);
    if (st === "done" && outputClosedMatchesToday(doneY)) {
      closedDrafts.push({
        kindLabel: "输出",
        title: String(o.title ?? o.outputId ?? "输出").slice(0, 120),
        tags: [],
        meta: `完成 ${doneY}`,
        filePath: o.filePath,
        lineNo: undefined,
        ref: { outputPath: o.filePath },
      });
    }
  }
  try {
    const maps = await readMergedOutputLedgerMaps(plugin.app, plugin.settings);
    const seenPub = new Set<string>();
    for (const ent of maps.byKnowledgePath.values()) {
      for (const ev of ent.events ?? []) {
        if (ev.action !== "publish_to_knowledge") continue;
        if (!eventOnDay(ev.ts, calToday)) continue;
        const k = `${ev.ts}|${ev.output_id ?? ""}|${ev.source_output_path ?? ""}`;
        if (seenPub.has(k)) continue;
        seenPub.add(k);
        const path = String(ev.source_output_path ?? "").trim();
        closedPublished.push({
          kindLabel: "输出",
          title: path ? path.split("/").pop() ?? "发布" : "发布到知识库",
          tags: [],
          meta: `发布 ${eventDay(ev.ts)}`,
          filePath: path || undefined,
          ref: { outputPath: path || undefined },
        });
      }
    }
  } catch {
    // ignore
  }

  // —— 4）轨迹：今日已结束日程，区间与多行泳道与日程日历 `buildScheduleDaySwimlaneSegments` 一致 ——
  const timelineDayItems: RSLatteIndexItem[] = [];
  for (const it of schedules.recentClosed ?? []) {
    if (scheduleClosedYmd(it) !== calToday) continue;
    if (!getScheduleDayIntervalMinutes(it)) continue;
    timelineDayItems.push(it);
  }
  const sortedTimelineItems = sortSchedulesForDay(timelineDayItems);
  const { segments: scheduleSegments, laneCount: scheduleLaneCount } = buildScheduleDaySwimlaneSegments(sortedTimelineItems);
  const scheduleOverlapRegions = getScheduleDayOverlapRegions(sortedTimelineItems);
  const scheduleTimeline: TodayScheduleTimelineModel = {
    items: sortedTimelineItems,
    segments: scheduleSegments,
    laneCount: scheduleLaneCount,
    overlapRegions: scheduleOverlapRegions,
    dayYmd: calToday,
  };

  // Sets：今日新建 / 今日闭环（任务 uid）
  const doneTaskUids = new Set<string>();
  for (const it of lists.closedDone ?? []) {
    if (ymd((it as any).done_date) === taskToday) {
      const u = String((it as any).uid ?? "").trim();
      if (u) doneTaskUids.add(u);
    }
  }
  for (const it of lists.closedCancelled ?? []) {
    if (ymd((it as any).cancelled_date) === taskToday) {
      const u = String((it as any).uid ?? "").trim();
      if (u) doneTaskUids.add(u);
    }
  }
  const doneProjTaskIds = new Set<string>();
  for (const p of projects) {
    for (const t of p.taskItems ?? []) {
      const st = String(t.statusName ?? "").toUpperCase();
      if (st === "DONE" && ymd(t.done_date) === taskToday && t.taskId) doneProjTaskIds.add(String(t.taskId));
      if (st === "CANCELLED" && ymd(t.cancelled_date) === taskToday && t.taskId) doneProjTaskIds.add(String(t.taskId));
    }
  }

  const postponeAggs = new Map<string, UpdateZoneAgg>();
  const phaseAggs = new Map<string, UpdateZoneAgg>();

  for (const e of dayEvents) {
    const uid = taskRefUid(e);
    if (e.kind === "task") {
      const cl = classifyTaskFamilyEvent(e);
      if (cl === "skip" || cl == null) continue;
      // 仅排除今日已闭环：同日新建再「开始处理」等仍应出现在状态/等待区（与 §2.2 新增区并行展示）
      if (uid && doneTaskUids.has(uid)) continue;
      if (!uid) continue;
      if (cl === "postpone") {
        pushUpdateAgg(postponeAggs, `t:${uid}`, { key: uid, isProj: false, kindLabel: "任务", id: uid }, e);
      } else {
        pushUpdateAgg(phaseAggs, `t:${uid}`, { key: uid, isProj: false, kindLabel: "任务", id: uid }, e);
      }
    }
    if (e.kind === "projecttask") {
      const pid = String(e.ref?.task_id ?? e.ref?.taskId ?? "").trim();
      const cl = classifyTaskFamilyEvent(e);
      if (cl === "skip" || cl == null) continue;
      if (pid && doneProjTaskIds.has(pid)) continue;
      if (!pid) continue;
      if (cl === "postpone") {
        pushUpdateAgg(postponeAggs, `pt:${pid}`, { key: pid, isProj: true, kindLabel: "项目任务", id: pid }, e);
      } else {
        pushUpdateAgg(phaseAggs, `pt:${pid}`, { key: pid, isProj: true, kindLabel: "项目任务", id: pid }, e);
      }
    }
  }

  /** 阶段链合并后：净变化为 0 的不展示；含等待/跟进端点 → 等待区，否则 → 状态区 */
  const statusAggs = new Map<string, UpdateZoneAgg>();
  const waitAggs = new Map<string, UpdateZoneAgg>();
  for (const [mapKey, agg] of phaseAggs) {
    const merged = mergePhaseChainRow(agg.events);
    if (!merged) continue;
    const target = merged.inWaitSection ? waitAggs : statusAggs;
    target.set(mapKey, { ...agg, mergedPhaseRow: merged.row });
  }

  // 索引补强：今日 progress_updated 且含「已延期」标签（无对应 WorkEvent 时单独成卡）
  for (const it of taskItems) {
    const uid = String((it as any).uid ?? "").trim();
    if (!uid || doneTaskUids.has(uid)) continue;
    if (ymd((it as any).progress_updated) !== taskToday) continue;
    const tags = computeTaskTags(it, taskToday, panel);
    if (!tags.includes("已延期")) continue;
    if (postponeAggs.has(`t:${uid}`)) continue;
    postponeAggs.set(`t:${uid}`, { key: uid, isProj: false, kindLabel: "任务", id: uid, events: [] });
  }
  for (const { p, t } of activeProjectTasks(projects)) {
    const tid = String(t.taskId ?? "").trim();
    if (!tid || doneProjTaskIds.has(tid)) continue;
    if (ymd(t.progress_updated) !== taskToday) continue;
    const ptags = getProjectTaskTagsOrCompute(t, taskToday, panel);
    if (!ptags.includes("已延期")) continue;
    if (postponeAggs.has(`pt:${tid}`)) continue;
    postponeAggs.set(`pt:${tid}`, { key: tid, isProj: true, kindLabel: "项目任务", id: tid, events: [] });
  }

  const taskStatus = updateAggsToLines(
    statusAggs,
    "status",
    taskItems,
    projects,
    calToday,
    panel,
    memoTagDay,
    schedTagDay,
    taskToday
  );
  const postpone = updateAggsToLines(
    postponeAggs,
    "postpone",
    taskItems,
    projects,
    calToday,
    panel,
    memoTagDay,
    schedTagDay,
    taskToday
  );
  const waitFollow = updateAggsToLines(
    waitAggs,
    "wait",
    taskItems,
    projects,
    calToday,
    panel,
    memoTagDay,
    schedTagDay,
    taskToday
  );

  const projectNextAction = dedupeLines(buildProjectNextActionRecordLines(dayEvents, projects));

  // 联系人动态 + 「资料更新」
  const contactDynamics: ContactDynamicRow[] = [];
  const contactProfileUpdates: RecordLine[] = [];
  const interactionCountByUid = new Map<string, { n: number; lastTs: string }>();
  try {
    await plugin.contactsIndex?.ensureInteractionsIndexReady?.();
    const istore = plugin.contactsIndex?.getInteractionsStore?.();
    const iidx = istore ? await istore.readIndex() : null;
    const byUid = iidx?.by_contact_uid ?? {};
    for (const [uid, entries] of Object.entries(byUid)) {
      let n = 0;
      let lastTs = "";
      for (const ent of entries ?? []) {
        for (const ev of ent.interaction_events ?? []) {
          if (!interactionEventOnDay(ev, calToday)) continue;
          n++;
          const o = String(ev.occurred_at ?? "");
          if (o > lastTs) lastTs = o;
        }
      }
      if (n > 0) {
        interactionCountByUid.set(uid, { n, lastTs });
      }
    }
    const mainIdx = await plugin.contactsIndex?.getIndexStore?.().readIndex?.();
    const nameByUid = new Map<string, string>();
    const pathByUid = new Map<string, string>();
    for (const it of mainIdx?.items ?? []) {
      nameByUid.set(it.contact_uid, it.display_name || it.contact_uid);
      pathByUid.set(it.contact_uid, it.file_path);
    }
    for (const [uid, { n, lastTs }] of interactionCountByUid) {
      contactDynamics.push({
        contactUid: uid,
        displayName: nameByUid.get(uid) ?? uid,
        newInteractionsToday: n,
        lastAtLabel: lastTs.length >= 16 ? lastTs.slice(11, 16) : lastTs || "—",
        filePath: pathByUid.get(uid),
      });
    }
    for (const it of mainIdx?.items ?? []) {
      const uid = String(it.contact_uid ?? "").trim();
      if (!uid) continue;
      if (isoToLocalCalendarYmd(String(it.created_at ?? "")) === calToday) continue;
      const upd = isoToLocalCalendarYmd(String(it.updated_at ?? ""));
      if (upd !== calToday) continue;
      if (isoToLocalCalendarYmd(String(it.last_interaction_at ?? "")) === calToday && interactionCountByUid.has(uid)) continue;
      contactProfileUpdates.push({
        kindLabel: "联系人",
        title: it.display_name || uid,
        tags: [],
        meta: "主索引 updated_at 为今日",
        filePath: it.file_path,
        ref: { contactUid: uid },
      });
    }
  } catch {
    // ignore
  }

  contactDynamics.sort((a, b) => b.newInteractionsToday - a.newInteractionsToday);

  // —— 复盘摘要文案 ——
  const newTaskN =
    (newByBucket.lateNight.task ?? 0) +
    (newByBucket.morning.task ?? 0) +
    (newByBucket.afternoon.task ?? 0) +
    (newByBucket.evening.task ?? 0);
  const newProjTN =
    (newByBucket.lateNight.projectTask ?? 0) +
    (newByBucket.morning.projectTask ?? 0) +
    (newByBucket.afternoon.projectTask ?? 0) +
    (newByBucket.evening.projectTask ?? 0);
  const newRem =
    (newByBucket.lateNight.reminder ?? 0) +
    (newByBucket.morning.reminder ?? 0) +
    (newByBucket.afternoon.reminder ?? 0) +
    (newByBucket.evening.reminder ?? 0);
  const newSch =
    (newByBucket.lateNight.schedule ?? 0) +
    (newByBucket.morning.schedule ?? 0) +
    (newByBucket.afternoon.schedule ?? 0) +
    (newByBucket.evening.schedule ?? 0);
  const newCap =
    (newByBucket.lateNight.capture ?? 0) +
    (newByBucket.morning.capture ?? 0) +
    (newByBucket.afternoon.capture ?? 0) +
    (newByBucket.evening.capture ?? 0);
  const newCont =
    (newByBucket.lateNight.contact ?? 0) +
    (newByBucket.morning.contact ?? 0) +
    (newByBucket.afternoon.contact ?? 0) +
    (newByBucket.evening.contact ?? 0);
  const newOut =
    (newByBucket.lateNight.output ?? 0) +
    (newByBucket.morning.output ?? 0) +
    (newByBucket.afternoon.output ?? 0) +
    (newByBucket.evening.output ?? 0);

  const doneTaskN = closedTasks.filter((x) => String(x.meta ?? "").includes("已完成")).length;
  const doneProjN = closedProjTasks.length;
  const statusUpN = dedupeLines(taskStatus).length;

  let pushedProjects = 0;
  for (const p of projects) {
    const pst = String(p?.status ?? "").trim();
    if (pst === "done" || pst === "cancelled") continue;
    if (ymd(String(p.progress_updated ?? "")) === taskToday) pushedProjects++;
  }
  const naN = projectNextAction.length;

  const schDone = closedSchedules.length;
  let schDoneNone = 0;
  let schDoneTask = 0;
  let schDoneProjTask = 0;
  let schDoneOut = 0;
  const taskPathByUid = new Map<string, string>();
  for (const it of taskItems) {
    const u = String((it as any).uid ?? "").trim();
    if (u) taskPathByUid.set(u, String((it as any).filePath ?? "").trim());
  }
  const projListPaths = new Set(
    projects
      .map((p) => normalizePath(String(p.tasklistFilePath ?? "").trim()))
      .filter((x) => !!x)
  );
  for (const it of schedules.recentClosed ?? []) {
    if (scheduleClosedYmd(it) !== calToday) continue;
    const extra = ((it as any)?.extra ?? {}) as Record<string, string>;
    const lt = String(extra.linked_task_uid ?? "").trim();
    const lo = String(extra.linked_output_id ?? "").trim();
    if (lo) schDoneOut++;
    else if (lt) {
      const fp = normalizePath(taskPathByUid.get(lt) ?? "");
      if (fp && projListPaths.has(fp)) schDoneProjTask++;
      else schDoneTask++;
    } else schDoneNone++;
  }

  const interactPeople = contactDynamics.length;
  const followUpPeople = contactProfileUpdates.length;

  const outStarted = dayEvents.filter((e) => e.kind === "output" && e.action === "start").length;
  const outPub = closedPublished.length;

  const recap = {
    task: `完成 ${doneTaskN} ｜ 新增 ${newTaskN} ｜ 更新 ${statusUpN}`,
    project: `推进 ${pushedProjects} ｜ 更新 NA ${naN}`,
    schedule: `新增 ${newSch} ｜ 完成 ${schDone}`,
    scheduleDoneBreakdown: `完成：无关联 ${schDoneNone} 任务 ${schDoneTask} 项目任务 ${schDoneProjTask} 输出 ${schDoneOut}`,
    contact: `互动 ${interactPeople} ｜ 更新跟进 ${followUpPeople}`,
    output: `新增 ${newOut} ｜ 开始 ${outStarted} ｜ 发布 ${outPub}`,
  };

  return {
    taskToday,
    calToday,
    followUp: {
      taskProgress: taskProgress,
      contactInteraction: contactInteraction,
      projectProgress: projectProgress,
    },
    newByBucket,
    closedDone: { tasks: dedupeLines(closedTasks), projectTasks: dedupeLines(closedProjTasks) },
    closedShut: { schedules: dedupeLines(closedSchedules), reminders: dedupeLines(closedReminders) },
    closedOutput: { drafts: dedupeLines(closedDrafts), published: dedupeLines(closedPublished) },
    scheduleTimeline,
    updates: {
      taskStatus,
      postpone,
      waitFollow,
      projectNextAction,
      contactDynamics,
      contactProfileUpdates: dedupeLines(contactProfileUpdates),
    },
    recap,
  };
}
