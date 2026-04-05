import type { App } from "obsidian";
import { TFile } from "obsidian";
import type { ContactIndexItem } from "../../contactsRSLatte/types";
import { computeOverdueLine } from "../../services/contacts/contactInteractionDisplay";
import type { ProjectEntry, ProjectTaskItem } from "../../projectManager/types";
import { compareTasksForNextAction, getProjectTaskTagsOrCompute } from "../../projectManager/projectDerivatives";
import { daysBetweenYmd } from "../../projectManager/projectRiskAndProgress";
import { computeTaskTags } from "../../taskRSLatte/task/taskTags";
import { reconcileTaskDisplayPhase } from "../../taskRSLatte/utils";
import type { RSLatteIndexItem } from "../../taskRSLatte/types";
import type { TaskPanelSettings } from "../../types/taskTypes";
import type { OutputIndexItem } from "../../types/outputTypes";
import { outputIndexItemIsProjectKind } from "../../types/outputTypes";

const RISK_TAG_KEYS = ["已超期", "高拖延风险", "假活跃"] as const;

/** 去零宽/BOM，将 Inbox 行尾或文件名解析出的日期统一为 YYYY-MM-DD（失败返回 null） */
function normalizeCaptureInboxYmd(raw: unknown): string | null {
  const s = String(raw ?? "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .slice(0, 24);
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{4})[./](\d{2})[./](\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

/**
 * Inbox「今日新增」条数：条目 `addDate`（YYYY-MM-DD）与任务日或本地日历日任一相同即计入。
 * 与 `buildTodayExecuteStatsModel` 内逻辑一致；Today 视图在聚合抛错时可用作兜底，避免误显示 0。
 */
export function countInboxItemsAddedOnTaskOrCalendarDay(
  items: Array<{ addDate?: string }>,
  todayKey: string,
  calendarTodayYmd?: string,
): number {
  const calYmd = normalizeCaptureInboxYmd(calendarTodayYmd);
  const taskYmd = normalizeCaptureInboxYmd(todayKey);
  return items.filter((x) => {
    const d = normalizeCaptureInboxYmd(x.addDate);
    if (!d) return false;
    if (taskYmd && d === taskYmd) return true;
    if (calYmd && d === calYmd) return true;
    return false;
  }).length;
}

export type TodayContactStatEntry = { uid: string; name: string };

export type TodayExecuteStatsModel = {
  inbox: { addedToday: number; backlog: number };
  projects: { active: number; pushing: number; riskNext: number; fakeActive: number };
  taskRisk: { overdue: number; delay: number; fake: number };
  waiting: {
    waitTotal: number;
    waitToday: number;
    followTotal: number;
    followToday: number;
    riskHighDelay: number;
  };
  output: { general: number; project: number };
  contacts: {
    birthday: TodayContactStatEntry[];
    followUp: TodayContactStatEntry[];
    stale: TodayContactStatEntry[];
  };
};

function itemKey(it: RSLatteIndexItem): string {
  const uid = String((it as any)?.uid ?? "").trim();
  if (uid) return `uid:${uid}`;
  return `${String((it as any)?.filePath ?? "")}#${Number((it as any)?.lineNo ?? -1)}`;
}

function mergeTaskBuckets(listsData: {
  focus?: RSLatteIndexItem[];
  todayAction?: RSLatteIndexItem[];
  todayFollowUp?: RSLatteIndexItem[];
  overdue?: RSLatteIndexItem[];
  otherRisk?: RSLatteIndexItem[];
  otherActive?: RSLatteIndexItem[];
}): Map<string, RSLatteIndexItem> {
  const buckets: RSLatteIndexItem[][] = [
    listsData.focus ?? [],
    listsData.todayAction ?? [],
    listsData.todayFollowUp ?? [],
    listsData.overdue ?? [],
    listsData.otherRisk ?? [],
    listsData.otherActive ?? [],
  ];
  const byKey = new Map<string, RSLatteIndexItem>();
  for (const arr of buckets) {
    for (const it of arr) {
      byKey.set(itemKey(it), it);
    }
  }
  return byKey;
}

function indexTaskOpen(it: RSLatteIndexItem): boolean {
  const st = String((it as any).status ?? "").toUpperCase().replace(/-/g, "_");
  return st !== "DONE" && st !== "CANCELLED";
}

function indexTaskDisplayPhase(it: RSLatteIndexItem): string {
  return reconcileTaskDisplayPhase(String((it as any).status ?? ""), (it as any).task_phase, {
    wait_until: (it as any).wait_until,
    follow_up: (it as any).follow_up,
  });
}

function collectNextActionTasksSorted(p: ProjectEntry): ProjectTaskItem[] {
  const tasks = (p.taskItems ?? []) as ProjectTaskItem[];
  const nexts = tasks.filter((t) => t.is_next_action_for_l1);
  return [...nexts].sort(compareTasksForNextAction);
}

/** 与 `projectDerivatives.projectTaskToTaskLike` 一致，供现算标签 */
function projectTaskToTaskLikeForTags(pt: ProjectTaskItem): Record<string, unknown> {
  return { ...pt, status: pt.statusName };
}

/**
 * 执行统计用项目任务标签：若快照 `projectDerivedForYmd` 与当前任务日不一致则现算，
 * 避免 hydrate/隔夜后仍用昨日 `project_task_tags` 导致「已超期」等全丢。
 */
function projectTaskTagsForStats(
  pt: ProjectTaskItem,
  p: ProjectEntry,
  todayKey: string,
  panel?: TaskPanelSettings | null,
): string[] {
  const derived = String((p as any).projectDerivedForYmd ?? "").trim().slice(0, 10);
  const tk = String(todayKey ?? "").trim().slice(0, 10);
  if (derived && tk && derived !== tk) {
    return computeTaskTags(projectTaskToTaskLikeForTags(pt) as any, tk, panel);
  }
  return getProjectTaskTagsOrCompute(pt, todayKey, panel);
}

function isProjectFakeActiveStale(p: ProjectEntry, todayYmd: string): boolean {
  const derived = String((p as any).projectDerivedForYmd ?? "").trim();
  const ptags = (p as any).project_tags as string[] | undefined;
  if (derived === todayYmd && Array.isArray(ptags) && ptags.includes("stale_progress")) return true;
  const pr = String(p.progress_updated ?? "").trim();
  const m = pr.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!m) return false;
  return daysBetweenYmd(m[1], todayYmd) >= 5;
}

function projectTaskRowKey(p: ProjectEntry, pt: ProjectTaskItem): string {
  const tid = String(pt.taskId ?? "").trim();
  if (tid) return `pt:${tid}`;
  const fp = String(pt.sourceFilePath ?? p.tasklistFilePath ?? "").trim();
  return `pt:${fp}#${Number(pt.lineNo ?? -1)}`;
}

/** 侧栏任务：仅当索引衍生日与任务日一致时用 `task_tags`，否则 `computeTaskTags`（避免隔夜索引导致统计全 0） */
function sidePanelTaskTagsForStats(
  it: RSLatteIndexItem,
  todayKey: string,
  taskPanel: TaskPanelSettings | undefined,
  indexTagsDerivedYmd?: string,
): string[] {
  const tk = String(todayKey ?? "").trim().slice(0, 10);
  const id = String(indexTagsDerivedYmd ?? "").trim().slice(0, 10);
  const arr = (it as any).task_tags as string[] | undefined;
  if (id && tk && id === tk && Array.isArray(arr) && arr.length > 0) return [...arr];
  return computeTaskTags(it, todayKey, taskPanel);
}

function followUidsFromTaskLike(uidsRaw: unknown, namesRaw: unknown): string[] {
  const uids: string[] = Array.isArray(uidsRaw)
    ? (uidsRaw as unknown[]).map((x) => String(x ?? "").trim()).filter(Boolean)
    : [];
  if (uids.length) return uids;
  const legacy = (uidsRaw as string | undefined) ? String(uidsRaw).split(/[,;]/).map((x) => x.trim()).filter(Boolean) : [];
  if (legacy.length) return legacy;
  const names: string[] = Array.isArray(namesRaw)
    ? (namesRaw as unknown[]).map((x) => String(x ?? "").trim()).filter(Boolean)
    : [];
  return names;
}

async function buildBirthdayEntriesToday(
  app: App,
  items: ContactIndexItem[],
  todayKey: string,
): Promise<TodayContactStatEntry[]> {
  const m = todayKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return [];
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  const out: TodayContactStatEntry[] = [];
  for (const it of items) {
    if (it.archived) continue;
    if (String(it.status ?? "").trim() === "cancelled") continue;
    const uid = String(it.contact_uid ?? "").trim();
    if (!uid) continue;
    const fp = String(it.file_path ?? "").trim();
    if (!fp) continue;
    const f = app.vault.getAbstractFileByPath(fp);
    if (!f || !(f instanceof TFile)) continue;
    const fm = app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
    const b = fm?.birthday;
    if (!b || typeof b !== "object") continue;
    const typ = String((b as any).type ?? "solar").trim().toLowerCase();
    if (typ === "lunar") continue;
    const bm = Number((b as any).month) || 0;
    const bd = Number((b as any).day) || 0;
    if (bm !== mm || bd !== dd) continue;
    out.push({ uid, name: String(it.display_name ?? "").trim() || uid });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  return out;
}

export type BuildTodayExecuteStatsCtx = {
  app: App;
  todayKey: string;
  taskPanel: TaskPanelSettings | undefined;
  listsData: {
    focus?: RSLatteIndexItem[];
    todayAction?: RSLatteIndexItem[];
    todayFollowUp?: RSLatteIndexItem[];
    overdue?: RSLatteIndexItem[];
    otherRisk?: RSLatteIndexItem[];
    otherActive?: RSLatteIndexItem[];
  };
  projects: ProjectEntry[];
  inboxItemsAllStatuses: Array<{ addDate?: string }>;
  backlogCount: number;
  /** Obsidian 本地日历 YYYY-MM-DD（`plugin.getTodayKey()`）；与 `todayKey` 任务日并用统计 Inbox「今日新增」 */
  calendarTodayYmd?: string;
  contactItems: ContactIndexItem[];
  outputItems: OutputIndexItem[];
  /** 任务索引 `tagsDerivedForYmd`；与 todayKey 一致时才直读 `task_tags`，否则现算（与 getTaskListsForSidePanel 一致） */
  taskIndexTagsDerivedYmd?: string;
  contactFollowupOverdueDays: number;
};

/**
 * 聚合 Today「今日执行」执行统计区所需指标（与侧栏标签/阶段语义对齐）。
 */
export async function buildTodayExecuteStatsModel(ctx: BuildTodayExecuteStatsCtx): Promise<TodayExecuteStatsModel> {
  const {
    app,
    todayKey,
    taskPanel,
    listsData,
    projects,
    inboxItemsAllStatuses,
    backlogCount,
    calendarTodayYmd,
    contactItems,
    outputItems,
    taskIndexTagsDerivedYmd,
    contactFollowupOverdueDays,
  } = ctx;

  const addedToday = countInboxItemsAddedOnTaskOrCalendarDay(inboxItemsAllStatuses, todayKey, calendarTodayYmd);

  let active = 0;
  let pushing = 0;
  let riskNext = 0;
  let fakeActive = 0;

  for (const p of projects) {
    const pst = String(p?.status ?? "").trim().toLowerCase();
    if (pst === "done" || pst === "cancelled" || pst === "canceled") continue;
    active++;
    if (isProjectFakeActiveStale(p, todayKey)) fakeActive++;

    /** 一级轨「下一步」可多条（每根一级里程碑一条）；推进中/风险任一条命中即计入该项目 */
    const nextSorted = collectNextActionTasksSorted(p);
    let hasPushing = false;
    let hasRiskNext = false;
    for (const pt of nextSorted) {
      const ph = reconcileTaskDisplayPhase(String(pt.statusName ?? ""), pt.task_phase, {
        wait_until: pt.wait_until,
        follow_up: pt.follow_up,
      });
      if (ph === "in_progress" || ph === "waiting_others") hasPushing = true;
      const ptags = projectTaskTagsForStats(pt, p, todayKey, taskPanel);
      if (RISK_TAG_KEYS.some((k) => ptags.includes(k))) hasRiskNext = true;
    }
    if (hasPushing) pushing++;
    if (hasRiskNext) riskNext++;
  }

  const byKey = mergeTaskBuckets(listsData);
  let taskOverdue = 0;
  let taskDelay = 0;
  let taskFake = 0;
  for (const it of byKey.values()) {
    if (!indexTaskOpen(it)) continue;
    const tags = sidePanelTaskTagsForStats(it, todayKey, taskPanel, taskIndexTagsDerivedYmd);
    if (tags.includes("已超期")) taskOverdue++;
    if (tags.includes("高拖延风险")) taskDelay++;
    if (tags.includes("假活跃")) taskFake++;
  }
  const seenPt = new Set<string>();
  for (const p of projects) {
    const pst = String(p?.status ?? "").trim().toLowerCase();
    if (pst === "done" || pst === "cancelled" || pst === "canceled") continue;
    for (const pt of (p.taskItems ?? []) as ProjectTaskItem[]) {
      const st = String(pt.statusName ?? "").toUpperCase();
      if (st === "DONE" || st === "CANCELLED") continue;
      const k = projectTaskRowKey(p, pt);
      if (seenPt.has(k)) continue;
      seenPt.add(k);
      const ptags = projectTaskTagsForStats(pt, p, todayKey, taskPanel);
      if (ptags.includes("已超期")) taskOverdue++;
      if (ptags.includes("高拖延风险")) taskDelay++;
      if (ptags.includes("假活跃")) taskFake++;
    }
  }

  let waitTotal = 0;
  let waitToday = 0;
  let followTotal = 0;
  let followToday = 0;
  let riskHighDelay = 0;

  for (const it of byKey.values()) {
    if (!indexTaskOpen(it)) continue;
    const st = String((it as any).status ?? "").toUpperCase().replace(/-/g, "_");
    if (st !== "IN_PROGRESS") continue;
    const ph = indexTaskDisplayPhase(it);
    const tags = sidePanelTaskTagsForStats(it, todayKey, taskPanel, taskIndexTagsDerivedYmd);
    const hitToday = tags.includes("今日应处理");
    const hitDelay = tags.includes("高拖延风险");
    if (ph === "waiting_until") {
      waitTotal++;
      if (hitToday) waitToday++;
      if (hitDelay) riskHighDelay++;
    } else if (ph === "waiting_others") {
      followTotal++;
      if (hitToday) followToday++;
      if (hitDelay) riskHighDelay++;
    }
  }

  const seenPtW = new Set<string>();
  for (const p of projects) {
    const pst = String(p?.status ?? "").trim().toLowerCase();
    if (pst === "done" || pst === "cancelled" || pst === "canceled") continue;
    for (const pt of (p.taskItems ?? []) as ProjectTaskItem[]) {
      const st = String(pt.statusName ?? "").toUpperCase();
      if (st !== "IN_PROGRESS") continue;
      const k = projectTaskRowKey(p, pt);
      if (seenPtW.has(k)) continue;
      seenPtW.add(k);
      const ph = reconcileTaskDisplayPhase(String(pt.statusName ?? ""), pt.task_phase, {
        wait_until: pt.wait_until,
        follow_up: pt.follow_up,
      });
      const ptags = projectTaskTagsForStats(pt, p, todayKey, taskPanel);
      const hitToday = ptags.includes("今日应处理");
      const hitDelay = ptags.includes("高拖延风险");
      if (ph === "waiting_until") {
        waitTotal++;
        if (hitToday) waitToday++;
        if (hitDelay) riskHighDelay++;
      } else if (ph === "waiting_others") {
        followTotal++;
        if (hitToday) followToday++;
        if (hitDelay) riskHighDelay++;
      }
    }
  }

  const uidToName = new Map<string, string>();
  for (const it of contactItems) {
    const uid = String(it.contact_uid ?? "").trim();
    if (!uid) continue;
    uidToName.set(uid, String(it.display_name ?? "").trim() || uid);
  }

  const followUidSet = new Set<string>();
  for (const it of byKey.values()) {
    if (!indexTaskOpen(it)) continue;
    const st = String((it as any).status ?? "").toUpperCase().replace(/-/g, "_");
    if (st !== "IN_PROGRESS") continue;
    const ph = indexTaskDisplayPhase(it);
    const wu = String((it as any).wait_until ?? "").trim();
    const fu = String((it as any).follow_up ?? "").trim();
    let hit = false;
    if (ph === "waiting_until" && wu === todayKey) hit = true;
    if (ph === "waiting_others" && fu === todayKey) hit = true;
    if (!hit) continue;
    for (const u of followUidsFromTaskLike((it as any).follow_contact_uids, (it as any).follow_contact_names)) {
      followUidSet.add(u);
    }
  }
  for (const p of projects) {
    const pst = String(p?.status ?? "").trim().toLowerCase();
    if (pst === "done" || pst === "cancelled" || pst === "canceled") continue;
    for (const pt of (p.taskItems ?? []) as ProjectTaskItem[]) {
      const st = String(pt.statusName ?? "").toUpperCase();
      if (st !== "IN_PROGRESS") continue;
      const ph = reconcileTaskDisplayPhase(String(pt.statusName ?? ""), pt.task_phase, {
        wait_until: pt.wait_until,
        follow_up: pt.follow_up,
      });
      const wu = String(pt.wait_until ?? "").trim();
      const fu = String(pt.follow_up ?? "").trim();
      let hit = false;
      if (ph === "waiting_until" && wu === todayKey) hit = true;
      if (ph === "waiting_others" && fu === todayKey) hit = true;
      if (!hit) continue;
      for (const u of followUidsFromTaskLike(pt.follow_contact_uids, pt.follow_contact_names)) {
        followUidSet.add(u);
      }
    }
  }
  const followUp: TodayContactStatEntry[] = [];
  for (const uid of followUidSet) {
    followUp.push({ uid, name: uidToName.get(uid) ?? uid });
  }
  followUp.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));

  const overdueDays = Math.max(1, Math.min(3650, contactFollowupOverdueDays || 30));
  const stale: TodayContactStatEntry[] = [];
  for (const it of contactItems) {
    if (it.archived) continue;
    if (String(it.status ?? "").trim() === "cancelled") continue;
    const uid = String(it.contact_uid ?? "").trim();
    if (!uid) continue;
    const last = String(it.last_interaction_at ?? "").trim();
    const o = computeOverdueLine(last, last, overdueDays, todayKey, taskPanel);
    if (o.kind === "days") {
      stale.push({ uid, name: String(it.display_name ?? "").trim() || uid });
    }
  }
  stale.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));

  const birthday = await buildBirthdayEntriesToday(app, contactItems, todayKey);

  const inProgressOut = outputItems.filter((it) => {
    const st = String(it.status ?? "todo").trim();
    return st === "in-progress" || st === "todo" || st === "waiting_until";
  });
  let outGeneral = 0;
  let outProject = 0;
  for (const it of inProgressOut) {
    if (outputIndexItemIsProjectKind(it)) outProject++;
    else outGeneral++;
  }

  return {
    inbox: { addedToday, backlog: backlogCount },
    projects: { active, pushing, riskNext, fakeActive },
    taskRisk: { overdue: taskOverdue, delay: taskDelay, fake: taskFake },
    waiting: {
      waitTotal,
      waitToday,
      followTotal,
      followToday,
      riskHighDelay,
    },
    output: { general: outGeneral, project: outProject },
    contacts: { birthday, followUp, stale },
  };
}
