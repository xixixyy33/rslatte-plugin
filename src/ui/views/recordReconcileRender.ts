import { moment, normalizePath, Notice, TFile } from "obsidian";

import type RSLattePlugin from "../../main";
import { VIEW_TYPE_CONTACTS, VIEW_TYPE_PROJECTS, VIEW_TYPE_TASKS } from "../../constants/viewTypes";
import type { ProjectEntry, ProjectTaskItem } from "../../projectManager/types";
import { getProjectTaskTagsOrCompute } from "../../projectManager/projectDerivatives";
import { getTaskTodayKey } from "../../taskRSLatte/task/taskTags";
import { DAY_CARD_HIDDEN_TASK_TAG_KEYS } from "../helpers/dayEntryCards";
import { TaskSidePanelView } from "./TaskSidePanelView";
import type { RecordLine } from "./recordTodayModel";
import {
  buildTodayReconcileZonesModel,
  type ReconcileDayBucket,
  type NewCountsBucket,
  type TodayReconcileZonesModel,
} from "./todayReconcileZonesModel";
import {
  appendDayEntryReminderCard,
  appendDayEntryScheduleCard,
  appendDayEntryTaskLikeCard,
} from "../helpers/dayEntryCards";
import type { RSLatteIndexItem } from "../../taskRSLatte/types";
import { labelForScheduleCategoryId } from "../../taskRSLatte/schedule/scheduleCategory";
import {
  formatScheduleTimeSummary,
  isScheduleInProgressNow,
  scheduleItemOverlapKeys,
  scheduleItemStableKey,
  stripRedundantScheduleTimeRangePrefix,
} from "../helpers/scheduleCalendarModel";
import {
  resolveScheduleCalendarLinkFlags,
  type ScheduleCalendarLinkFlags,
} from "../helpers/scheduleCalendarLinkResolve";
import { renderTextWithContactRefsResolved } from "../helpers/renderTextWithContactRefs";
import { createHeaderRow } from "../helpers/moduleHeader";
import { ContactsSidePanelView } from "./ContactsSidePanelView";
import { ProjectSidePanelView, type ScrollToProjectNavOpts } from "./ProjectSidePanelView";

const momentFn = moment as any;

function stripReconcileDesc(raw: string): string {
  return String(raw ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*⭐\s*/u, "")
    .trim();
}

async function lookupContactDisplayName(plugin: RSLattePlugin, uid: string): Promise<string | null> {
  const u = String(uid ?? "").trim();
  if (!u) return null;
  try {
    const store = plugin.contactsIndex?.getIndexStore?.();
    if (!store) return null;
    const idx = await store.readIndex();
    const hit = (idx?.items ?? []).find((x) => String((x as any)?.contact_uid ?? "").trim() === u);
    const nm = String((hit as any)?.display_name ?? "").trim();
    return nm || null;
  } catch {
    return null;
  }
}

function appendScheduleLinkIconNodes(wrap: HTMLElement, flags: ScheduleCalendarLinkFlags): void {
  if (!flags || (!flags.task && !flags.projectTask && !flags.output)) return;
  if (flags.task) {
    const el = wrap.createSpan({ cls: "rslatte-schedule-cal-link-emoji", text: "🗂" });
    el.title = "关联任务";
  }
  if (flags.projectTask) {
    const el = wrap.createSpan({ cls: "rslatte-schedule-cal-link-emoji", text: "🎯" });
    el.title = "关联项目任务";
  }
  if (flags.output) {
    const el = wrap.createSpan({ cls: "rslatte-schedule-cal-link-emoji", text: "📄" });
    el.title = "关联输出";
  }
}

function mountScheduleLinkIconsOnRailSeg(seg: HTMLElement, flags: ScheduleCalendarLinkFlags | undefined): void {
  if (!flags || (!flags.task && !flags.projectTask && !flags.output)) return;
  const wrap = seg.createDiv({ cls: "rslatte-schedule-cal-link-icons rslatte-schedule-cal-link-icons--rail" });
  appendScheduleLinkIconNodes(wrap, flags);
}

function mountScheduleLinkIconsOnCardRow(top: HTMLElement, flags: ScheduleCalendarLinkFlags | undefined): void {
  if (!flags || (!flags.task && !flags.projectTask && !flags.output)) return;
  const wrap = top.createDiv({ cls: "rslatte-schedule-cal-link-icons rslatte-schedule-cal-link-icons--card" });
  appendScheduleLinkIconNodes(wrap, flags);
}

/** 与列表行一致的跳转载荷（打开源笔记日程行） */
function recordLineFromScheduleItem(it: RSLatteIndexItem): RecordLine {
  const fp = normalizePath(String((it as any).filePath ?? "").trim());
  const ln = Number((it as any).lineNo ?? 0);
  const rawDesc = stripRedundantScheduleTimeRangePrefix(it, String((it as any)?.text ?? "").trim());
  const title = stripReconcileDesc(rawDesc).slice(0, 120) || "（无标题）";
  return {
    kindLabel: "日程",
    title,
    tags: [],
    meta: "",
    filePath: fp || undefined,
    lineNo: Number.isFinite(ln) ? ln : undefined,
  };
}

/** 「今日核对」面板渲染参数（由 TodayView 子页签调用） */
export type RenderRecordReconcileBodyArgs = {
  plugin: RSLattePlugin;
  container: HTMLElement;
  isCurrentSeq: () => boolean;
};

const BUCKET_ORDER: ReconcileDayBucket[] = ["lateNight", "morning", "afternoon", "evening"];
const BUCKET_LABEL: Record<ReconcileDayBucket, string> = {
  lateNight: "凌晨00-05",
  morning: "上午06-12",
  afternoon: "下午13-18",
  evening: "晚上19-24",
};

const EMOJI: Record<keyof NewCountsBucket, string> = {
  task: "🗂",
  reminder: "⏰",
  schedule: "📅",
  capture: "✍",
  projectTask: "🎯",
  contact: "🪪",
  output: "📄",
};

/** 悬停符号时 title 提示（原独立图例行已移除） */
const NEW_COUNT_TITLE: Record<keyof NewCountsBucket, string> = {
  reminder: "提醒",
  task: "任务",
  schedule: "日程",
  capture: "快速记录",
  projectTask: "项目任务",
  contact: "联系人",
  output: "输出",
};

const NEW_COUNT_KEY_ORDER: (keyof NewCountsBucket)[] = [
  "task",
  "reminder",
  "schedule",
  "capture",
  "projectTask",
  "contact",
  "output",
];

function formatNewBucketLine(bucket: ReconcileDayBucket, data: NewCountsBucket): string {
  const parts: string[] = [];
  NEW_COUNT_KEY_ORDER.forEach((k) => {
    const n = data[k] ?? 0;
    if (n > 0) parts.push(`${EMOJI[k]}${n}`);
  });
  if (!parts.length) return "";
  return `${BUCKET_LABEL[bucket]}：${parts.join(" ")}`;
}

function jumpToSidebarByNewCountKey(plugin: RSLattePlugin, key: keyof NewCountsBucket): void {
  const openTaskTab = async (tab: "memo" | "schedule" | "task") => {
    await (plugin as any).activateTaskView?.();
    const leaf = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_TASKS)[0];
    const viewAny = leaf?.view as any;
    if (viewAny && typeof viewAny.switchToSubTab === "function") {
      await viewAny.switchToSubTab(tab);
    }
  };
  if (key === "task") {
    void openTaskTab("task");
    return;
  }
  if (key === "projectTask") {
    void (plugin as any).activateProjectView?.();
    return;
  }
  if (key === "contact") {
    void (plugin as any).activateContactsView?.();
    return;
  }
  if (key === "output") {
    void (plugin as any).activateOutputView?.();
    return;
  }
  if (key === "capture") {
    void (plugin as any).activateCaptureView?.();
    return;
  }
  if (key === "reminder") {
    void openTaskTab("memo");
    return;
  }
  if (key === "schedule") {
    void openTaskTab("schedule");
    return;
  }
  void (plugin as any).activateTaskView?.();
}

function appendNewBucketLineRow(
  plugin: RSLattePlugin,
  parent: HTMLElement,
  bucket: ReconcileDayBucket,
  data: NewCountsBucket,
): void {
  const hasAny = NEW_COUNT_KEY_ORDER.some((k) => (data[k] ?? 0) > 0);
  if (!hasAny) return;
  const row = parent.createDiv({ cls: "rslatte-reconcile-new-line" });
  row.createSpan({ text: `${BUCKET_LABEL[bucket]}：` });
  NEW_COUNT_KEY_ORDER.forEach((k) => {
    const n = data[k] ?? 0;
    if (n <= 0) return;
    const chip = row.createSpan({ cls: "rslatte-reconcile-new-count" });
    chip.setAttr("title", NEW_COUNT_TITLE[k]);
    chip.setText(`${EMOJI[k]}${n}`);
    chip.tabIndex = 0;
    chip.addClass("rslatte-reconcile-jump");
    chip.addEventListener("click", (ev) => {
      ev.stopPropagation();
      jumpToSidebarByNewCountKey(plugin, k);
    });
    chip.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      ev.stopPropagation();
      jumpToSidebarByNewCountKey(plugin, k);
    });
  });
}

async function openRecordLine(plugin: RSLattePlugin, L: RecordLine): Promise<void> {
  const uid = String(L.ref?.contactUid ?? "").trim();
  if (uid) {
    await (plugin as any).activateContactsView?.();
    const leaves = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_CONTACTS);
    const v = leaves[0]?.view;
    if (v instanceof ContactsSidePanelView) await v.focusContactByUid(uid);
    return;
  }
  const pid = String(L.ref?.projectId ?? "").trim();
  if (pid && L.kindLabel === "项目") {
    const snap = plugin.projectMgr?.getSnapshot?.();
    const p = (snap?.projects ?? []).find((x) => String(x.projectId ?? "") === pid);
    if (p) {
      await (plugin as any).activateProjectView?.();
      const leaves = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_PROJECTS);
      const v = leaves[0]?.view;
      if (v instanceof ProjectSidePanelView) await v.openProgressTabForProject(p);
    }
    return;
  }

  /** 今日核对·更新区 / 闭环区：清单任务 → 任务管理侧栏并展开分区、高亮行 */
  if (L.kindLabel === "任务") {
    let fp = normalizePath(String(L.filePath ?? "").trim());
    let ln = Number(L.lineNo ?? NaN);
    const tuid = String(L.ref?.taskUid ?? "").trim();
    if ((!fp || !Number.isFinite(ln)) && tuid) {
      try {
        const it = await plugin.taskRSLatte.findTaskByUid(tuid);
        if (it?.filePath != null && it.lineNo != null) {
          fp = normalizePath(String(it.filePath));
          ln = Number(it.lineNo);
        }
      } catch {
        // fallthrough
      }
    }
    if (fp && Number.isFinite(ln)) {
      try {
        await (plugin as any).activateTaskView?.();
        const leaf = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_TASKS)[0];
        const v = leaf?.view;
        if (v instanceof TaskSidePanelView) {
          await v.focusTaskRowByFileLine(fp, ln);
          return;
        }
      } catch (e: any) {
        new Notice(`跳转失败：${e?.message ?? String(e)}`);
      }
      void (plugin as any).noteNav?.openNoteAtLine?.(fp, ln + 1);
    }
    return;
  }

  /** 今日核对·更新区 / 闭环区：项目任务 → 项目管理侧栏进度 Tab 并定位里程碑与任务行 */
  if (L.kindLabel === "项目任务") {
    const tid = String(L.ref?.taskUid ?? "").trim();
    let p: ProjectEntry | undefined;
    let pt: ProjectTaskItem | undefined;
    const snap = plugin.projectMgr?.getSnapshot?.();
    if (tid) {
      for (const proj of snap?.projects ?? []) {
        const hit = (proj.taskItems ?? []).find((x) => String(x.taskId ?? "") === tid);
        if (hit) {
          p = proj;
          pt = hit;
          break;
        }
      }
    }
    if (p && pt) {
      try {
        await (plugin as any).activateProjectView?.();
        const leaf = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_PROJECTS)[0];
        const view = leaf?.view;
        if (view instanceof ProjectSidePanelView) {
          const folder = normalizePath(String(p.folderPath ?? "").trim());
          const projectKey = folder || String(p.projectId ?? "").trim();
          const todayKeyNav = getTaskTodayKey(plugin.settings?.taskPanel ?? undefined);
          const panelNav = plugin.settings?.taskPanel;
          const taskTagsNav = getProjectTaskTagsOrCompute(pt, todayKeyNav, panelNav).filter(
            (k) => !DAY_CARD_HIDDEN_TASK_TAG_KEYS.has(k)
          );
          const navOpts: ScrollToProjectNavOpts = {
            applyTaskTagKeys: taskTagsNav.length > 0 ? taskTagsNav : undefined,
            ensureTaskStatus: String(pt.statusName ?? "").trim() || undefined,
          };
          await view.scrollToProject(
            projectKey,
            String(pt.milestonePath ?? pt.milestone ?? ""),
            String(pt.sourceFilePath ?? p.tasklistFilePath ?? ""),
            Number(pt.lineNo ?? 0),
            navOpts
          );
          return;
        }
      } catch (e: any) {
        new Notice(`跳转失败：${e?.message ?? String(e)}`);
      }
    }
    const pit = tid ? findProjectTaskById(plugin, tid) : null;
    if (pit) void (plugin as any).noteNav?.openNoteAtLine?.(pit.fp, pit.lineNo + 1);
    return;
  }

  const fp = String(L.filePath ?? "").trim();
  const ln = Number(L.lineNo ?? NaN);
  // 日程 / 提醒等：打开源笔记并定位行
  if (fp && Number.isFinite(ln)) {
    void (plugin as any).noteNav?.openNoteAtLine?.(fp, ln + 1);
    return;
  }
  const taskUid = String(L.ref?.taskUid ?? "").trim();
  if (taskUid) {
    try {
      const it = await plugin.taskRSLatte.findTaskByUid(taskUid);
      if (it?.filePath != null && it.lineNo != null) {
        await (plugin as any).activateTaskView?.();
        const leaf = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_TASKS)[0];
        const v = leaf?.view;
        if (v instanceof TaskSidePanelView) {
          await v.focusTaskRowByFileLine(normalizePath(String(it.filePath)), Number(it.lineNo));
          return;
        }
      }
    } catch {
      // fallthrough
    }
    let p2: ProjectEntry | undefined;
    let pt2: ProjectTaskItem | undefined;
    const snap2 = plugin.projectMgr?.getSnapshot?.();
    for (const proj of snap2?.projects ?? []) {
      const hit = (proj.taskItems ?? []).find((x) => String(x.taskId ?? "") === taskUid);
      if (hit) {
        p2 = proj;
        pt2 = hit;
        break;
      }
    }
    if (p2 && pt2) {
      try {
        await (plugin as any).activateProjectView?.();
        const leaf = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_PROJECTS)[0];
        const view = leaf?.view;
        if (view instanceof ProjectSidePanelView) {
          const folder = normalizePath(String(p2.folderPath ?? "").trim());
          const projectKey = folder || String(p2.projectId ?? "").trim();
          const todayKeyNav = getTaskTodayKey(plugin.settings?.taskPanel ?? undefined);
          const taskTagsNav = getProjectTaskTagsOrCompute(pt2, todayKeyNav, plugin.settings?.taskPanel).filter(
            (k) => !DAY_CARD_HIDDEN_TASK_TAG_KEYS.has(k)
          );
          const navOpts: ScrollToProjectNavOpts = {
            applyTaskTagKeys: taskTagsNav.length > 0 ? taskTagsNav : undefined,
            ensureTaskStatus: String(pt2.statusName ?? "").trim() || undefined,
          };
          await view.scrollToProject(
            projectKey,
            String(pt2.milestonePath ?? pt2.milestone ?? ""),
            String(pt2.sourceFilePath ?? p2.tasklistFilePath ?? ""),
            Number(pt2.lineNo ?? 0),
            navOpts
          );
          return;
        }
      } catch {
        // fallthrough
      }
    }
    const pit = findProjectTaskById(plugin, taskUid);
    if (pit) void (plugin as any).noteNav?.openNoteAtLine?.(pit.fp, pit.lineNo + 1);
  }
  const outp = String(L.ref?.outputPath ?? L.filePath ?? "").trim();
  if (outp && L.kindLabel === "输出") {
    const f = plugin.app.vault.getAbstractFileByPath(outp);
    if (!(f instanceof TFile)) {
      new Notice("未找到输出文件");
      return;
    }
    try {
      const leaf = plugin.app.workspace.getLeaf(false);
      await leaf.openFile(f, { active: true, state: { mode: "preview" } as any });
    } catch (e: any) {
      console.warn("openRecordLine output preview", e);
      new Notice(`打开失败：${e?.message ?? String(e)}`);
    }
    return;
  }
  if (outp) {
    void (plugin as any).noteNav?.openNoteAtLine?.(outp, 1);
  }
}

function findProjectTaskById(
  plugin: RSLattePlugin,
  taskId: string
): { fp: string; lineNo: number } | null {
  const snap = plugin.projectMgr?.getSnapshot?.();
  for (const p of snap?.projects ?? []) {
    for (const t of p.taskItems ?? []) {
      if (String(t.taskId ?? "") === taskId) {
        const fp = String(t.sourceFilePath ?? p.tasklistFilePath ?? "").trim();
        if (fp) return { fp, lineNo: t.lineNo };
      }
    }
  }
  return null;
}

/** 与「今日执行」一致：分区下数据块使用 rslatte-section + rslatte-section-title-row，h4 前带 icon */
function renderReconcileSectionBlock(
  parent: HTMLElement,
  icon: string,
  title: string,
  renderBody: (body: HTMLElement) => void,
): void {
  const sec = parent.createDiv({ cls: "rslatte-section rslatte-task-section rslatte-expanded" });
  const { left } = createHeaderRow(
    sec,
    "rslatte-section-title-row",
    "rslatte-section-title-left",
    "rslatte-task-actions",
  );
  left.createEl("h4", { text: `${icon} ${title}` });
  const body = sec.createDiv({ cls: "rslatte-reconcile-item-body" });
  renderBody(body);
}

function wireClickableCard(el: HTMLElement, onClick: () => void): void {
  el.tabIndex = 0;
  el.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onClick();
  });
  el.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      ev.stopPropagation();
      onClick();
    }
  });
}

function renderReconcileStatCard(parent: HTMLElement, title: string, bodyText: string, onClick: () => void): void {
  const card = parent.createDiv({ cls: "rslatte-today-stat-item rslatte-today-stat-item--clickable" });
  card.title = "点击查看详情";
  card.createDiv({ cls: "rslatte-today-stat-item-title", text: title });
  card.createDiv({ cls: "rslatte-today-stat-item-body", text: bodyText });
  wireClickableCard(card, onClick);
}

function appendRecordLineCard(plugin: RSLattePlugin, wrap: HTMLElement, L: RecordLine): void {
  if (L.kindLabel === "任务") {
    appendDayEntryTaskLikeCard(plugin.app, wrap, {
      kindLabel: "任务",
      task: {
        status: "DONE",
        text: L.title,
      },
      tagKeys: L.tags,
      onClick: () => void openRecordLine(plugin, L),
    });
    return;
  }
  if (L.kindLabel === "项目任务") {
    appendDayEntryTaskLikeCard(plugin.app, wrap, {
      kindLabel: "项目任务",
      task: {
        status: "DONE",
        text: L.title,
      },
      tagKeys: L.tags,
      onClick: () => void openRecordLine(plugin, L),
    });
    return;
  }
  if (L.kindLabel === "提醒") {
    const fake: RSLatteIndexItem = {
      text: L.title,
      status: "DONE",
      filePath: L.filePath,
      lineNo: L.lineNo,
    } as RSLatteIndexItem;
    appendDayEntryReminderCard(plugin.app, wrap, {
      memo: fake,
      tagKeys: L.tags,
      onClick: () => void openRecordLine(plugin, L),
    });
    return;
  }
  if (L.kindLabel === "日程") {
    const fake: RSLatteIndexItem = {
      text: L.title,
      filePath: L.filePath,
      lineNo: L.lineNo,
    } as RSLatteIndexItem;
    appendDayEntryScheduleCard(plugin.app, wrap, {
      item: fake,
      tagKeys: L.tags,
      onClick: () => void openRecordLine(plugin, L),
    });
    return;
  }
  const card = wrap.createDiv({ cls: "rslatte-day-card rslatte-day-card--task rslatte-day-card--interactive" });
  card.tabIndex = 0;
  card.onclick = () => void openRecordLine(plugin, L);
  const main = card.createDiv({ cls: "rslatte-day-card__main" });
  main.createSpan({ cls: "rslatte-day-card__kind", text: L.kindLabel });
  main.createDiv({ cls: "rslatte-day-card__desc", text: L.title });
  if (L.meta) main.createSpan({ cls: "rslatte-muted", text: L.meta });
}

/** 「更新区」任务/项目任务：第一行标签+圆点+描述+标签，第二行起为变更说明+时刻 */
function renderDayCardsForUpdateLines(plugin: RSLattePlugin, parent: HTMLElement, lines: RecordLine[]): void {
  const wrap = parent.createDiv({ cls: "rslatte-today-focus-cards" });
  for (const L of lines) {
    if (L.changeRows?.length && (L.kindLabel === "任务" || L.kindLabel === "项目任务")) {
      appendDayEntryTaskLikeCard(plugin.app, wrap, {
        kindLabel: L.kindLabel,
        task: {
          status: L.dotStatus ?? "TODO",
          text: L.title,
          task_phase: L.dotTaskPhase,
        },
        tagKeys: L.tags,
        onClick: () => void openRecordLine(plugin, L),
      });
      const card = wrap.lastElementChild as HTMLElement | null;
      if (card) {
        card.addClass("rslatte-day-card--reconcile-update");
        const sub = card.createDiv({ cls: "rslatte-day-card__changes" });
        for (const r of L.changeRows) {
          const crow = sub.createDiv({ cls: "rslatte-day-card__change-row" });
          crow.createSpan({ cls: "rslatte-day-card__change-detail", text: r.detail });
          crow.createSpan({ cls: "rslatte-day-card__change-time rslatte-muted", text: r.timeLabel });
        }
      }
      continue;
    }
    appendRecordLineCard(plugin, wrap, L);
  }
}

function renderDayCardsForLines(plugin: RSLattePlugin, parent: HTMLElement, lines: RecordLine[]): void {
  const wrap = parent.createDiv({ cls: "rslatte-today-focus-cards" });
  for (const L of lines) {
    appendRecordLineCard(plugin, wrap, L);
  }
}

/**
 * 与日程日历 `CalendarView` 展开区一致：多行泳道、刻度竖线、重叠高亮竖线、此刻刻度、列表行与条带 hover 联动。
 */
async function renderScheduleTimelineSwimlane(
  plugin: RSLattePlugin,
  parent: HTMLElement,
  pack: TodayReconcileZonesModel["scheduleTimeline"],
): Promise<void> {
  const items = pack.items ?? [];
  if (!items.length) {
    parent.createDiv({ cls: "rslatte-muted", text: "（今日无带起止时刻的已结束日程）" });
    return;
  }

  const wrap = parent.createDiv({ cls: "rslatte-reconcile-schedule-swimlane" });
  const nowM = momentFn();
  const nowMins = nowM.hour() * 60 + nowM.minute();
  const todayYmd = String(plugin.getTodayKey?.() ?? "").trim();

  const linkFlagMap = await resolveScheduleCalendarLinkFlags(plugin, items);
  const { segments: swimSegs, laneCount } = pack;
  const lanePx = 14;
  const laneGap = 3;
  const railPad = 4;
  const innerH = railPad * 2 + laneCount * lanePx + Math.max(0, laneCount - 1) * laneGap;
  const scaleMarks: { label: string; frac: number; align: "start" | "center" | "end" }[] = [
    { label: "00:00", frac: 0, align: "start" },
    { label: "06:00", frac: 6 / 24, align: "center" },
    { label: "12:00", frac: 12 / 24, align: "center" },
    { label: "18:00", frac: 18 / 24, align: "center" },
    { label: "24:00", frac: 1, align: "end" },
  ];

  const keyToRowEl = new Map<string, HTMLElement>();
  const list = wrap.createDiv({ cls: "rslatte-schedule-cal-list" });
  const schedMod = (plugin.settings as any)?.scheduleModule;
  const overlapKeys = scheduleItemOverlapKeys(items);

  for (const it of items) {
    const rowEl = list.createDiv({ cls: "rslatte-schedule-cal-item" });
    if (isScheduleInProgressNow(it, pack.dayYmd, todayYmd, nowMins)) {
      rowEl.addClass("is-in-progress");
    }
    const itemKey = scheduleItemStableKey(it);
    rowEl.dataset.rslatteScheduleKey = itemKey;
    keyToRowEl.set(itemKey, rowEl);
    if (overlapKeys.has(itemKey)) {
      rowEl.addClass("rslatte-schedule-cal-item--overlap");
    }
    const extra = ((it as any)?.extra ?? {}) as Record<string, unknown>;
    const catId = String(extra.schedule_category ?? "").trim();
    const catLabel = catId ? labelForScheduleCategoryId(schedMod, catId) : "";
    const top = rowEl.createDiv({ cls: "rslatte-schedule-cal-item-top" });
    const topLeft = top.createDiv({ cls: "rslatte-schedule-cal-item-top-left" });
    topLeft.createSpan({ cls: "rslatte-schedule-cal-item-time", text: formatScheduleTimeSummary(it) });
    if (catLabel) {
      topLeft.createSpan({ cls: "rslatte-schedule-cal-item-cat", text: catLabel });
    }
    mountScheduleLinkIconsOnCardRow(top, linkFlagMap.get(itemKey));

    const stDone = String((it as any)?.status ?? "").toUpperCase() === "DONE";
    const rawDesc = stripRedundantScheduleTimeRangePrefix(it, String((it as any)?.text ?? "").trim());
    const textHost = rowEl.createDiv({ cls: "rslatte-schedule-cal-item-text" });
    if (stDone) {
      textHost.createSpan({ cls: "rslatte-schedule-cal-item-done-prefix", text: "✅ " });
    }
    const textBody = textHost.createSpan({ cls: "rslatte-schedule-cal-item-text-body" });
    if (!rawDesc) {
      textBody.setText("（无标题）");
    } else {
      try {
        await renderTextWithContactRefsResolved(plugin.app, textBody, rawDesc, (uid) =>
          lookupContactDisplayName(plugin, uid),
        );
      } catch {
        textBody.setText(rawDesc);
      }
    }
    if (overlapKeys.has(itemKey)) {
      const badge = rowEl.createSpan({ cls: "rslatte-schedule-cal-overlap-badge", text: "叠" });
      badge.title = "与其他日程时间段重叠";
    }

    rowEl.style.cursor = "pointer";
    rowEl.title = "打开笔记并定位到日程行";
    const navLine = recordLineFromScheduleItem(it);
    rowEl.onclick = () => void openRecordLine(plugin, navLine);
  }

  const rail = wrap.createDiv({ cls: "rslatte-schedule-cal-rail" });
  list.before(rail);

  const track = rail.createDiv({ cls: "rslatte-schedule-cal-rail-track" });
  track.style.minHeight = `${innerH}px`;
  const railInner = rail.createDiv({ cls: "rslatte-schedule-cal-rail-inner" });
  railInner.style.height = `${innerH}px`;

  for (const m of scaleMarks) {
    const vl = railInner.createDiv({
      cls: `rslatte-schedule-cal-rail-scale-vline rslatte-schedule-cal-rail-scale-vline--${m.align}`,
    });
    vl.style.left = `${m.frac * 100}%`;
    vl.style.height = `${innerH}px`;
    vl.title = m.label;
  }

  for (const reg of pack.overlapRegions ?? []) {
    const mid = (reg.start + reg.end) / 2;
    const line = railInner.createDiv({ cls: "rslatte-schedule-cal-rail-overlap-line" });
    line.style.left = `${(mid / 1440) * 100}%`;
    line.style.height = `${innerH}px`;
    line.style.top = "0";
    line.title = "该时刻附近有多条日程重叠";
  }

  for (const s of swimSegs) {
    const seg = railInner.createDiv({ cls: "rslatte-schedule-cal-rail-seg" });
    seg.style.left = `${s.leftPct}%`;
    seg.style.width = `${s.widthPct}%`;
    const topPx = railPad + s.lane * (lanePx + laneGap);
    seg.style.top = `${topPx}px`;
    seg.style.height = `${lanePx - 2}px`;
    if (isScheduleInProgressNow(s.item, pack.dayYmd, todayYmd, nowMins)) {
      seg.addClass("is-in-progress");
    }
    const sk = scheduleItemStableKey(s.item);
    seg.dataset.rslatteScheduleKey = sk;
    seg.addClass("rslatte-schedule-cal-rail-seg--interactive");
    const onSegEnter = () => {
      const row = keyToRowEl.get(sk);
      if (row) row.addClass("rslatte-schedule-cal-item--rail-hover");
    };
    const onSegLeave = () => {
      const row = keyToRowEl.get(sk);
      if (row) row.removeClass("rslatte-schedule-cal-item--rail-hover");
    };
    seg.addEventListener("mouseenter", onSegEnter);
    seg.addEventListener("mouseleave", onSegLeave);
    mountScheduleLinkIconsOnRailSeg(seg, linkFlagMap.get(sk));
    seg.style.cursor = "pointer";
    seg.title = formatScheduleTimeSummary(s.item);
    seg.onclick = (ev) => {
      ev.stopPropagation();
      void openRecordLine(plugin, recordLineFromScheduleItem(s.item));
    };
  }

  if (pack.dayYmd === todayYmd && todayYmd) {
    const tick = railInner.createDiv({ cls: "rslatte-schedule-cal-now-tick" });
    tick.style.left = `${(nowMins / 1440) * 100}%`;
    tick.style.height = `${innerH}px`;
    tick.style.top = "0";
    tick.title = "当前时刻";
  }

  const scale = rail.createDiv({ cls: "rslatte-schedule-cal-rail-scale" });
  for (const m of scaleMarks) {
    const tickEl = scale.createSpan({
      cls: `rslatte-schedule-cal-rail-scale-label rslatte-schedule-cal-rail-scale-label--${m.align}`,
      text: m.label,
    });
    tickEl.style.left = `${m.frac * 100}%`;
  }
}

/**
 * 渲染「今日核对」七分区（状态、新增、闭环、轨迹、更新、复盘摘要）。
 */
export async function renderRecordReconcileBody(args: RenderRecordReconcileBodyArgs): Promise<void> {
  const { plugin, container, isCurrentSeq } = args;
  let model: TodayReconcileZonesModel;
  try {
    model = await buildTodayReconcileZonesModel(plugin);
  } catch (e) {
    container.createDiv({ cls: "rslatte-muted", text: `加载失败：${String((e as any)?.message ?? e)}` });
    return;
  }
  if (!isCurrentSeq()) return;

  // 1 状态区
  const z1 = container.createDiv({ cls: "rslatte-today-execute-region" });
  z1.createDiv({ cls: "rslatte-today-execute-region-title rslatte-today-execute-region-title-first", text: "今日跟进" });
  const followSec = z1.createDiv({ cls: "rslatte-section rslatte-task-section rslatte-expanded" });
  const { left: z1L } = createHeaderRow(
    followSec,
    "rslatte-section-title-row",
    "rslatte-section-title-left",
    "rslatte-task-actions",
  );
  z1L.createEl("h4", { text: "🧭 跟进一览" });
  const statusRow = followSec.createDiv({ cls: "rslatte-reconcile-status-dots" });
  const dot = (label: string, on: boolean, onClick: () => void) => {
    const sp = statusRow.createSpan({ cls: "rslatte-reconcile-status-item rslatte-reconcile-jump" });
    sp.setText(`${label}${on ? "🟢" : "⚪"}`);
    sp.title = `打开${label}侧边栏`;
    sp.tabIndex = 0;
    sp.addEventListener("click", (ev) => {
      ev.stopPropagation();
      onClick();
    });
    sp.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      ev.stopPropagation();
      onClick();
    });
  };
  dot("任务", model.followUp.taskProgress, () => void jumpToSidebarByNewCountKey(plugin, "task"));
  dot("联系人", model.followUp.contactInteraction, () => void (plugin as any).activateContactsView?.());
  dot("项目", model.followUp.projectProgress, () => void (plugin as any).activateProjectView?.());

  // 2 新增区
  const z2 = container.createDiv({ cls: "rslatte-today-execute-region" });
  z2.createDiv({ cls: "rslatte-today-execute-region-title", text: "今日新增" });
  const newSec = z2.createDiv({ cls: "rslatte-section rslatte-task-section rslatte-expanded" });
  const { left: z2L } = createHeaderRow(
    newSec,
    "rslatte-section-title-row",
    "rslatte-section-title-left",
    "rslatte-task-actions",
  );
  z2L.createEl("h4", { text: "📋 分时段新增" });
  const newBody = newSec.createDiv({ cls: "rslatte-reconcile-item-body" });
  for (const b of BUCKET_ORDER) {
    appendNewBucketLineRow(plugin, newBody, b, model.newByBucket[b]);
  }
  if (!BUCKET_ORDER.some((b) => formatNewBucketLine(b, model.newByBucket[b]))) {
    newBody.createDiv({ cls: "rslatte-muted", text: "（无新增计数）" });
  }

  // 3 闭环区
  const z3 = container.createDiv({ cls: "rslatte-today-execute-region" });
  z3.createDiv({ cls: "rslatte-today-execute-region-title", text: "今日闭环" });
  renderReconcileSectionBlock(z3, "✅", "今日完成项", (body) => {
    renderReconcileSectionBlock(body, "🗂", "任务", (inner) => {
      renderDayCardsForLines(plugin, inner, model.closedDone.tasks);
    });
    renderReconcileSectionBlock(body, "🎯", "项目任务", (inner) => {
      renderDayCardsForLines(plugin, inner, model.closedDone.projectTasks);
    });
  });
  renderReconcileSectionBlock(z3, "🔒", "今日关闭项", (body) => {
    renderReconcileSectionBlock(body, "📅", "日程", (inner) => {
      renderDayCardsForLines(plugin, inner, model.closedShut.schedules);
    });
    renderReconcileSectionBlock(body, "⏰", "提醒", (inner) => {
      renderDayCardsForLines(plugin, inner, model.closedShut.reminders);
    });
  });
  renderReconcileSectionBlock(z3, "📤", "今日输出结果", (body) => {
    renderReconcileSectionBlock(body, "📄", "完成整理的草稿", (inner) => {
      renderDayCardsForLines(plugin, inner, model.closedOutput.drafts);
    });
    renderReconcileSectionBlock(body, "🚀", "发布", (inner) => {
      renderDayCardsForLines(plugin, inner, model.closedOutput.published);
    });
  });

  // 4 轨迹
  const z4 = container.createDiv({ cls: "rslatte-today-execute-region" });
  z4.createDiv({ cls: "rslatte-today-execute-region-title", text: "今日日程轨迹（已完成）" });
  const swimSec = z4.createDiv({ cls: "rslatte-section rslatte-task-section rslatte-expanded" });
  const { left: z4L } = createHeaderRow(
    swimSec,
    "rslatte-section-title-row",
    "rslatte-section-title-left",
    "rslatte-task-actions",
  );
  z4L.createEl("h4", { text: "🛤 已完成泳道" });
  const swimBody = swimSec.createDiv({ cls: "rslatte-reconcile-item-body" });
  await renderScheduleTimelineSwimlane(plugin, swimBody, model.scheduleTimeline);

  // 5 更新区
  const z5 = container.createDiv({ cls: "rslatte-today-execute-region" });
  z5.createDiv({ cls: "rslatte-today-execute-region-title", text: "今日更新" });
  renderReconcileSectionBlock(z5, "📊", "任务状态变化", (body) => {
    renderDayCardsForUpdateLines(plugin, body, model.updates.taskStatus);
    if (!model.updates.taskStatus.length) body.createDiv({ cls: "rslatte-muted", text: "（无）" });
  });
  renderReconcileSectionBlock(z5, "📆", "延期 / 改期", (body) => {
    renderDayCardsForUpdateLines(plugin, body, model.updates.postpone);
    if (!model.updates.postpone.length) body.createDiv({ cls: "rslatte-muted", text: "（无）" });
  });
  renderReconcileSectionBlock(z5, "⏳", "等待 / 跟进变化", (body) => {
    renderDayCardsForUpdateLines(plugin, body, model.updates.waitFollow);
    if (!model.updates.waitFollow.length) body.createDiv({ cls: "rslatte-muted", text: "（无）" });
  });
  renderReconcileSectionBlock(z5, "🎯", "项目推进变化（next action）", (body) => {
    renderDayCardsForLines(plugin, body, model.updates.projectNextAction);
    if (!model.updates.projectNextAction.length) body.createDiv({ cls: "rslatte-muted", text: "（无）" });
  });
  renderReconcileSectionBlock(z5, "👤", "联系人变化", (body) => {
    renderReconcileSectionBlock(body, "💬", "今日互动（卡片）", (inner) => {
      const cw = inner.createDiv({ cls: "rslatte-today-focus-cards" });
      if (!model.updates.contactDynamics.length) {
        cw.createDiv({ cls: "rslatte-muted", text: "（无）" });
      } else {
        for (const c of model.updates.contactDynamics) {
          appendRecordLineCard(plugin, cw, {
            kindLabel: "联系人",
            title: c.displayName,
            tags: [],
            meta: `+${c.newInteractionsToday} 条 · 最后互动 ${c.lastAtLabel}`,
            filePath: c.filePath,
            ref: { contactUid: c.contactUid },
          });
        }
      }
    });
    renderReconcileSectionBlock(body, "📝", "资料 / 跟进字段更新", (inner) => {
      renderDayCardsForLines(plugin, inner, model.updates.contactProfileUpdates);
    });
  });

  // 6 复盘摘要
  const z6 = container.createDiv({ cls: "rslatte-today-execute-region" });
  z6.createDiv({ cls: "rslatte-today-execute-region-title", text: "今日复盘摘要" });
  const recapList = z6.createDiv({ cls: "rslatte-today-stat-list" });

  renderReconcileStatCard(recapList, "🗂 任务摘要", model.recap.task, () => {
    void (plugin as any).activateTaskView?.();
  });
  renderReconcileStatCard(recapList, "📁 项目摘要", model.recap.project, () => {
    void (plugin as any).activateProjectView?.();
  });
  renderReconcileStatCard(
    recapList,
    "📅 日程摘要",
    `${model.recap.schedule}\n${model.recap.scheduleDoneBreakdown}`.trim(),
    () => {
      void (plugin as any).activateRSLatteView?.();
    },
  );
  renderReconcileStatCard(recapList, "👤 联系人摘要", model.recap.contact, () => {
    void (plugin as any).activateContactsView?.();
  });
  renderReconcileStatCard(recapList, "✍ 输出摘要", model.recap.output, () => {
    void (plugin as any).activateOutputView?.();
  });
}
