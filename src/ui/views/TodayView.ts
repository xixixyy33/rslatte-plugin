import { ItemView, Notice, WorkspaceLeaf, normalizePath } from "obsidian";
import type RSLattePlugin from "../../main";
import { VIEW_TYPE_CONTACTS, VIEW_TYPE_OUTPUTS, VIEW_TYPE_PROJECTS, VIEW_TYPE_TASKS, VIEW_TYPE_TODAY } from "../../constants/viewTypes";
import type { ContactIndexItem } from "../../contactsRSLatte/types";
import type { OutputIndexItem } from "../../types/outputTypes";
import { isScheduleMemoLine, type RSLatteIndexItem } from "../../taskRSLatte/types";
import { computeTaskTags, getTaskTodayKey, TASK_TAG_META } from "../../taskRSLatte/task/taskTags";
import { calendarTodayYmd, computeMemoTags, MEMO_TAG_META } from "../../taskRSLatte/memo/memoTags";
import { computeScheduleTags, SCHEDULE_TAG_META } from "../../taskRSLatte/schedule/scheduleTags";
import type { ProjectEntry, ProjectTaskItem } from "../../projectManager/types";
import { compareTasksForNextAction, getProjectTaskTagsOrCompute } from "../../projectManager/projectDerivatives";
import { compareYmd, computeProjectRiskSummary, daysBetweenYmd } from "../../projectManager/projectRiskAndProgress";
import { reconcileTaskDisplayPhase } from "../../taskRSLatte/utils";
import { buildDescPrefix } from "../../taskRSLatte/parser";
import { createHeaderRow } from "../helpers/moduleHeader";
import { renderTextWithContactRefs } from "../helpers/renderTextWithContactRefs";
import {
  appendDayEntryReminderCard,
  appendDayEntryScheduleCard,
  appendDayEntryTaskLikeCard,
  dayCardEntryStatusTitle,
  dayCardStatusIcon,
  DAY_CARD_HIDDEN_TASK_TAG_KEYS,
} from "../helpers/dayEntryCards";
import { renderRecordReconcileBody } from "./recordReconcileRender";
import { buildTodayRecordsModel } from "../helpers/todayRecordsModel";
import {
  buildTodayExecuteStatsModel,
  countInboxItemsAddedOnTaskOrCalendarDay,
  type TodayContactStatEntry,
} from "../helpers/todayExecuteStats";
import { renderTodayRecordsBody } from "./todayRecordsRender";
import { ContactsSidePanelView } from "./ContactsSidePanelView";
import { OutputSidePanelView } from "./OutputSidePanelView";
import { ProjectSidePanelView, type ScrollToProjectNavOpts } from "./ProjectSidePanelView";
import { TaskSidePanelView } from "./TaskSidePanelView";

type TodaySubTab = "execute" | "reconcile" | "records";

/** 项目推进卡片「下一步」行：不展示「活跃任务」与冗余的「下一步」任务标签 */
const TODAY_PUSH_NEXT_TAGS_HIDDEN = new Set<string>([...DAY_CARD_HIDDEN_TASK_TAG_KEYS, "next_action"]);

/** 超期/风险任务卡片：须命中其一（与 `TASK_TAG_META` 键一致） */
const TODAY_OVERDUE_RISK_CARD_TAGS = new Set<string>(["已超期", "高拖延风险", "假活跃"]);

/** Hub「今日核对」与新开 Today 叶：首帧落在核对子页签时置位，由 onOpen 消费 */
let _pendingOpenTodayReconcile = false;
export function markPendingOpenTodayReconcileTab(): void {
  _pendingOpenTodayReconcile = true;
}

/**
 * V2 工作流：Today 侧栏
 * - **今日执行**：「执行清单」+「执行统计」两大区（清单含重点/行动/项目推进占位/等待跟进/日程/超期风险；统计含 Inbox·项目·超期·等待及占位项）
 * - **今日核对**：七分区（见 `todayReconcileZonesModel` / `recordReconcileRender`）
 * - **今日记录**：打卡/财务/日记摘要与跳转（见 `todayRecordsModel` / `todayRecordsRender`）
 */
export class TodayView extends ItemView {
  private plugin: RSLattePlugin;
  private _renderSeq = 0;
  private _memoIndexTagDay: string | undefined;
  private _scheduleIndexTagDay: string | undefined;
  /** 任务索引 `tagsDerivedForYmd`，与任务日一致时才直读 `task_tags` */
  private _taskIndexTagDay: string | undefined;
  private _subTab: TodaySubTab = "execute";
  /** 执行统计「联系人动态」：+n 展开人名 */
  private _statsContactExpand: { birth: boolean; follow: boolean; stale: boolean } = {
    birth: false,
    follow: false,
    stale: false,
  };

  constructor(leaf: WorkspaceLeaf, plugin: RSLattePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_TODAY; }
  getDisplayText(): string {
    if (this._subTab === "reconcile") return "今日核对";
    if (this._subTab === "records") return "今日记录";
    return "今天";
  }
  getIcon(): string { return "list-todo"; }

  async onOpen() {
    if (_pendingOpenTodayReconcile) {
      this._subTab = "reconcile";
      _pendingOpenTodayReconcile = false;
    }
    void this.render();
  }

  async onClose() {}

  /** 工作流「今日核对」或外链：切换到核对子页签并刷新 */
  public openReconcileSubTab(): void {
    if (_pendingOpenTodayReconcile) {
      _pendingOpenTodayReconcile = false;
    }
    if (this._subTab !== "reconcile") {
      this._subTab = "reconcile";
      void this.render();
    }
  }

  private isStarred(it: RSLatteIndexItem): boolean {
    return !!((it as any)?.starred === true || (it as any)?.starred === 1 || (it as any)?.starred === "1");
  }

  private itemKey(it: RSLatteIndexItem): string {
    const uid = String((it as any)?.uid ?? "").trim();
    if (uid) return `uid:${uid}`;
    return `${String((it as any)?.filePath ?? "")}#${Number((it as any)?.lineNo ?? -1)}`;
  }

  /**
   * 星标项目任务且侧栏上带有「今日」任务标签（内部键 `今日应处理`；优先快照 `project_task_tags`）。
   */
  private projectTaskMatchesStarredTodayTag(it: ProjectTaskItem, todayKey: string): boolean {
    if (!this.isStarred(it as any)) return false;
    const st = String(it.statusName ?? "").toUpperCase();
    if (st === "DONE" || st === "CANCELLED") return false;
    const panel = this.plugin.settings?.taskPanel ?? undefined;
    const tags = getProjectTaskTagsOrCompute(it, todayKey, panel);
    return tags.includes("今日应处理");
  }

  /** 任务标签：索引日与任务日一致时优先 `task_tags`，否则现算（与侧栏清单 / 执行统计一致） */
  private getTaskTagKeysForItem(it: RSLatteIndexItem, todayKey: string): string[] {
    const anyIt = it as any;
    const panel = this.plugin.settings?.taskPanel;
    const idxDay = String(this._taskIndexTagDay ?? "").trim().slice(0, 10);
    const tk = String(todayKey ?? "").trim().slice(0, 10);
    if (idxDay && tk && idxDay === tk && Array.isArray(anyIt.task_tags) && anyIt.task_tags.length > 0) {
      return anyIt.task_tags as string[];
    }
    return computeTaskTags(it, todayKey, panel);
  }

  /** 提醒标签：索引日与日历日一致时用 memo_tags，否则现算 */
  private getMemoTagKeysForItem(m: RSLatteIndexItem): string[] {
    const anyIt = m as any;
    const panel = this.plugin.settings?.taskPanel;
    const calDay = calendarTodayYmd();
    if (this._memoIndexTagDay === calDay && Array.isArray(anyIt.memo_tags) && anyIt.memo_tags.length > 0) {
      return anyIt.memo_tags as string[];
    }
    return computeMemoTags(m, calDay, panel);
  }

  private stripTaskBodyComments(s: string): string {
    return String(s ?? "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/^\s*⭐\s*/u, "")
      .trim();
  }

  private async openTodayFocusTask(it: RSLatteIndexItem): Promise<void> {
    try {
      await this.plugin.activateTaskView();
      const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_TASKS)[0];
      const view = leaf?.view;
      if (view instanceof TaskSidePanelView) {
        await view.focusTaskRowByFileLine(it.filePath, it.lineNo);
        return;
      }
    } catch (e: any) {
      new Notice(`跳转失败：${e?.message ?? String(e)}`);
    }
  }

  private async openTodayFocusProjectTask(p: ProjectEntry, pt: ProjectTaskItem): Promise<void> {
    try {
      await this.plugin.activateProjectView();
      const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_PROJECTS)[0];
      const view = leaf?.view;
      if (view instanceof ProjectSidePanelView) {
        // 与 ProjectSidePanelView 解析顺序一致：优先规范化后的项目根路径，再退回 projectId，避免 id/路径串冲突时跳到错误项目。
        const folder = normalizePath(String(p.folderPath ?? "").trim());
        const projectKey = folder || String(p.projectId ?? "").trim();
        const todayKeyNav = getTaskTodayKey(this.plugin.settings?.taskPanel ?? undefined);
        const panelNav = this.plugin.settings?.taskPanel;
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

  private async openTodayFocusReminder(m: RSLatteIndexItem): Promise<void> {
    try {
      await this.plugin.activateTaskView();
      const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_TASKS)[0];
      const view = leaf?.view;
      if (view instanceof TaskSidePanelView) {
        await view.focusMemoRowByFileLine(m.filePath, m.lineNo);
        return;
      }
    } catch (e: any) {
      new Notice(`跳转失败：${e?.message ?? String(e)}`);
    }
  }

  /** 今日重点：任务 / 项目任务 / 提醒 三类卡片（可复用样式见 dayEntryCards） */
  private renderTodayFocusCards(
    parent: HTMLElement,
    opts: {
      focusTasks: RSLatteIndexItem[];
      focusProjectRows: Array<{ p: ProjectEntry; pt: ProjectTaskItem }>;
      focusReminders: RSLatteIndexItem[];
      todayKey: string;
    }
  ): void {
    const { focusTasks, focusProjectRows, focusReminders, todayKey } = opts;
    const panel = this.plugin.settings?.taskPanel;
    const n = focusTasks.length + focusProjectRows.length + focusReminders.length;
    if (n === 0) {
      parent.createDiv({ cls: "rslatte-muted", text: "（无重点事项）" });
      return;
    }
    for (const it of focusTasks) {
      const anyIt = it as any;
      appendDayEntryTaskLikeCard(this.app, parent, {
        kindLabel: "任务",
        task: {
          status: String(anyIt.status ?? ""),
          text: this.stripTaskBodyComments(String(anyIt.text ?? anyIt.raw ?? "")) || "（无描述）",
          starred: !!anyIt.starred,
          postpone_count: anyIt.postpone_count,
          complexity: anyIt.complexity,
          task_phase: anyIt.task_phase,
        },
        tagKeys: this.getTaskTagKeysForItem(it, todayKey),
        onClick: () => void this.openTodayFocusTask(it),
      });
    }
    for (const { p, pt } of focusProjectRows) {
      const taskTags = getProjectTaskTagsOrCompute(pt, todayKey, panel);
      appendDayEntryTaskLikeCard(this.app, parent, {
        kindLabel: "项目任务",
        task: {
          status: String(pt.statusName ?? ""),
          text: this.stripTaskBodyComments(String(pt.text ?? "")) || "（无描述）",
          starred: !!pt.starred,
          postpone_count: pt.postpone_count,
          complexity: pt.complexity,
          task_phase: pt.task_phase,
        },
        tagKeys: taskTags,
        onClick: () => void this.openTodayFocusProjectTask(p, pt),
      });
    }
    for (const m of focusReminders) {
      appendDayEntryReminderCard(this.app, parent, {
        memo: m,
        tagKeys: this.getMemoTagKeysForItem(m),
        onClick: () => void this.openTodayFocusReminder(m),
      });
    }
  }

  /** 与侧栏分区 `toYmd(actual_start)` 一致 */
  private taskActualStartYmd(it: RSLatteIndexItem): string | undefined {
    const s = String((it as any)?.actual_start ?? "").trim();
    if (s && /^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    return undefined;
  }

  private projectTaskRowKey(p: ProjectEntry, pt: ProjectTaskItem): string {
    const tid = String(pt.taskId ?? "").trim();
    if (tid) return `pt:${tid}`;
    const fp = normalizePath(String(pt.sourceFilePath ?? p.tasklistFilePath ?? "").trim());
    return `pt:${fp}#${Number(pt.lineNo ?? -1)}`;
  }

  /**
   * 今日行动清单（§1.3）：任务两类合并去重；A 为 IN_PROGRESS/TODO+今日应处理并排除 focus 桶前 3 条 itemKey，
   * B 为 🛫 日期=任务日（同排除）；提醒「即将到期」且排除 1.2 已展示提醒；
   * 项目任务 IN_PROGRESS/TODO+今日应处理，排除 1.2 星标重点行（projectTaskRowKey）。
   */
  private buildTodayActionEntries(opts: {
    listsData: {
      focus?: RSLatteIndexItem[];
      todayAction?: RSLatteIndexItem[];
      todayFollowUp?: RSLatteIndexItem[];
      overdue?: RSLatteIndexItem[];
      otherRisk?: RSLatteIndexItem[];
      otherActive?: RSLatteIndexItem[];
    };
    reminderTodayFocus: RSLatteIndexItem[];
    projects: ProjectEntry[];
    focusTopTasks: RSLatteIndexItem[];
    focusReminders: RSLatteIndexItem[];
    focusProjectRows: Array<{ p: ProjectEntry; pt: ProjectTaskItem }>;
    todayKey: string;
  }): {
    tasks: RSLatteIndexItem[];
    memos: RSLatteIndexItem[];
    projectRows: Array<{ p: ProjectEntry; pt: ProjectTaskItem }>;
  } {
    const {
      listsData,
      reminderTodayFocus,
      projects,
      focusTopTasks,
      focusReminders,
      focusProjectRows,
      todayKey,
    } = opts;
    const panel = this.plugin.settings?.taskPanel;

    const focusTaskKeys = new Set(focusTopTasks.map((t) => this.itemKey(t)));
    const focusMemoKeys = new Set(focusReminders.map((m) => this.itemKey(m)));
    const focusPtKeys = new Set(focusProjectRows.map(({ p, pt }) => this.projectTaskRowKey(p, pt)));

    let dbgPtTotal = 0;
    let dbgSkipFocus = 0;
    let dbgSkipStatus = 0;
    let dbgSkipTag = 0;
    const dbgTagSkipSamples: Array<{
      rowKey: string;
      taskId?: string;
      textSnippet: string;
      statusName: string;
      ptStNorm: string;
      tags: string[];
      project_task_tags_len: number;
    }> = [];

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
        byKey.set(this.itemKey(it), it);
      }
    }

    const actionTaskMap = new Map<string, RSLatteIndexItem>();
    for (const it of byKey.values()) {
      if (focusTaskKeys.has(this.itemKey(it))) continue;
      const st = String((it as any).status ?? "").toUpperCase().replace(/-/g, "_");
      const tags = this.getTaskTagKeysForItem(it, todayKey);
      const startYmd = this.taskActualStartYmd(it);
      const matchProcessingTagged =
        (st === "IN_PROGRESS" || st === "TODO") && tags.includes("今日应处理");
      const matchStartToday = startYmd === todayKey;
      if (matchProcessingTagged || matchStartToday) {
        actionTaskMap.set(this.itemKey(it), it);
      }
    }
    const tasks = [...actionTaskMap.values()].sort(
      (a, b) => ((b as any).importance_score ?? 0) - ((a as any).importance_score ?? 0),
    );

    const memos: RSLatteIndexItem[] = [];
    for (const m of reminderTodayFocus) {
      if (focusMemoKeys.has(this.itemKey(m))) continue;
      if (!this.getMemoTagKeysForItem(m).includes("即将到期")) continue;
      memos.push(m);
    }
    memos.sort((a, b) =>
      String((a as any).memoDate ?? "").localeCompare(String((b as any).memoDate ?? "")),
    );

    const projectRows: Array<{ p: ProjectEntry; pt: ProjectTaskItem }> = [];
    for (const p of projects) {
      const pst = String(p?.status ?? "").trim();
      if (pst === "done" || pst === "cancelled") continue;
      const titems = (p.taskItems ?? []) as ProjectTaskItem[];
      for (const pt of titems) {
        dbgPtTotal++;
        const rowKey = this.projectTaskRowKey(p, pt);
        if (focusPtKeys.has(rowKey)) {
          dbgSkipFocus++;
          continue;
        }
        const ptSt = String(pt.statusName ?? "").toUpperCase().replace(/-/g, "_");
        if (ptSt !== "IN_PROGRESS" && ptSt !== "TODO") {
          dbgSkipStatus++;
          continue;
        }
        const ptags = getProjectTaskTagsOrCompute(pt, todayKey, panel);
        if (!ptags.includes("今日应处理")) {
          dbgSkipTag++;
          if (this.plugin.isDebugLogEnabled() && dbgTagSkipSamples.length < 12) {
            const raw = (pt as any).project_task_tags;
            dbgTagSkipSamples.push({
              rowKey,
              taskId: pt.taskId,
              textSnippet: String(pt.text ?? "").slice(0, 48),
              statusName: String(pt.statusName ?? ""),
              ptStNorm: ptSt,
              tags: [...ptags],
              project_task_tags_len: Array.isArray(raw) ? raw.length : 0,
            });
          }
          continue;
        }
        projectRows.push({ p, pt });
      }
    }
    projectRows.sort(
      (a, b) => ((b.pt as any).importance_score ?? 0) - ((a.pt as any).importance_score ?? 0),
    );

    if (this.plugin.isDebugLogEnabled()) {
      const includedSamples = projectRows.slice(0, 8).map(({ p, pt }) => ({
        rowKey: this.projectTaskRowKey(p, pt),
        taskId: pt.taskId,
        textSnippet: String(pt.text ?? "").slice(0, 48),
        tags: getProjectTaskTagsOrCompute(pt, todayKey, panel),
      }));
      this.plugin.dbg("todayAction", "buildTodayActionEntries", {
        todayKey,
        projectsLen: projects.length,
        focusPtKeysCount: focusPtKeys.size,
        focusPtKeySample: [...focusPtKeys].slice(0, 6),
        projectTaskScanned: dbgPtTotal,
        projectRowsIncluded: projectRows.length,
        skipFocusPt: dbgSkipFocus,
        skipStatus: dbgSkipStatus,
        skipNoTodayTag: dbgSkipTag,
        tagSkipSamples: dbgTagSkipSamples,
        includedSamples,
        indexTasksForAction: tasks.length,
        memosForAction: memos.length,
      });
    }

    return { tasks, memos, projectRows };
  }

  /** 顺序：任务 → 即将到期提醒 → 项目任务；卡片与跳转同 `renderTodayFocusCards` */
  private renderTodayActionCards(
    parent: HTMLElement,
    opts: {
      tasks: RSLatteIndexItem[];
      memos: RSLatteIndexItem[];
      projectRows: Array<{ p: ProjectEntry; pt: ProjectTaskItem }>;
      todayKey: string;
    },
  ): void {
    const { tasks, memos, projectRows, todayKey } = opts;
    const panel = this.plugin.settings?.taskPanel;
    const n = tasks.length + memos.length + projectRows.length;
    if (n === 0) {
      parent.createDiv({ cls: "rslatte-muted", text: "（无今日行动）" });
      return;
    }
    for (const it of tasks) {
      const anyIt = it as any;
      appendDayEntryTaskLikeCard(this.app, parent, {
        kindLabel: "任务",
        task: {
          status: String(anyIt.status ?? ""),
          text: this.stripTaskBodyComments(String(anyIt.text ?? anyIt.raw ?? "")) || "（无描述）",
          starred: !!anyIt.starred,
          postpone_count: anyIt.postpone_count,
          complexity: anyIt.complexity,
          task_phase: anyIt.task_phase,
        },
        tagKeys: this.getTaskTagKeysForItem(it, todayKey),
        onClick: () => void this.openTodayFocusTask(it),
      });
    }
    for (const m of memos) {
      appendDayEntryReminderCard(this.app, parent, {
        memo: m,
        tagKeys: this.getMemoTagKeysForItem(m),
        onClick: () => void this.openTodayFocusReminder(m),
      });
    }
    for (const { p, pt } of projectRows) {
      const taskTags = getProjectTaskTagsOrCompute(pt, todayKey, panel);
      appendDayEntryTaskLikeCard(this.app, parent, {
        kindLabel: "项目任务",
        task: {
          status: String(pt.statusName ?? ""),
          text: this.stripTaskBodyComments(String(pt.text ?? "")) || "（无描述）",
          starred: !!pt.starred,
          postpone_count: pt.postpone_count,
          complexity: pt.complexity,
          task_phase: pt.task_phase,
        },
        tagKeys: taskTags,
        onClick: () => void this.openTodayFocusProjectTask(p, pt),
      });
    }
  }

  /** 任务清单项：展示阶段为等待到期 / 等待跟进（与侧栏 `reconcileTaskDisplayPhase` 一致） */
  private indexTaskIsWaitingFollowPhase(it: RSLatteIndexItem): boolean {
    const ph = reconcileTaskDisplayPhase(String((it as any).status ?? ""), (it as any).task_phase, {
      wait_until: (it as any).wait_until,
      follow_up: (it as any).follow_up,
    });
    return ph === "waiting_until" || ph === "waiting_others";
  }

  private projectTaskIsWaitingFollowPhase(pt: ProjectTaskItem): boolean {
    const ph = reconcileTaskDisplayPhase(String(pt.statusName ?? ""), pt.task_phase, {
      wait_until: pt.wait_until,
      follow_up: pt.follow_up,
    });
    return ph === "waiting_until" || ph === "waiting_others";
  }

  /**
   * 等待中/跟进中事项（§1.3b）：任务与项目任务均需「等待中/跟进中」阶段 + 任务标签「今日应处理」；
   * 清单任务排除今日重点任务前 3 条（与行动清单一致）。
   */
  private buildTodayFollowUpCardEntries(opts: {
    listsData: {
      focus?: RSLatteIndexItem[];
      todayAction?: RSLatteIndexItem[];
      todayFollowUp?: RSLatteIndexItem[];
      overdue?: RSLatteIndexItem[];
      otherRisk?: RSLatteIndexItem[];
      otherActive?: RSLatteIndexItem[];
    };
    projects: ProjectEntry[];
    focusTopTasks: RSLatteIndexItem[];
    todayKey: string;
  }): {
    tasks: RSLatteIndexItem[];
    projectRows: Array<{ p: ProjectEntry; pt: ProjectTaskItem }>;
  } {
    const { listsData, projects, focusTopTasks, todayKey } = opts;
    const panel = this.plugin.settings?.taskPanel;
    const focusTaskKeys = new Set(focusTopTasks.map((t) => this.itemKey(t)));

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
        byKey.set(this.itemKey(it), it);
      }
    }

    const taskList: RSLatteIndexItem[] = [];
    for (const it of byKey.values()) {
      if (focusTaskKeys.has(this.itemKey(it))) continue;
      if (!this.indexTaskIsWaitingFollowPhase(it)) continue;
      if (!this.getTaskTagKeysForItem(it, todayKey).includes("今日应处理")) continue;
      taskList.push(it);
    }
    taskList.sort((a, b) => ((b as any).importance_score ?? 0) - ((a as any).importance_score ?? 0));

    const projectRows: Array<{ p: ProjectEntry; pt: ProjectTaskItem }> = [];
    const seenPt = new Set<string>();
    for (const p of projects) {
      const pst = String(p?.status ?? "").trim();
      if (pst === "done" || pst === "cancelled") continue;
      const titems = (p.taskItems ?? []) as ProjectTaskItem[];
      for (const pt of titems) {
        const ptDone = String(pt.statusName ?? "").toUpperCase();
        if (ptDone === "DONE" || ptDone === "CANCELLED") continue;
        if (!this.projectTaskIsWaitingFollowPhase(pt)) continue;
        if (!getProjectTaskTagsOrCompute(pt, todayKey, panel).includes("今日应处理")) continue;
        const k = this.projectTaskRowKey(p, pt);
        if (seenPt.has(k)) continue;
        seenPt.add(k);
        projectRows.push({ p, pt });
      }
    }
    projectRows.sort(
      (a, b) => ((b.pt as any).importance_score ?? 0) - ((a.pt as any).importance_score ?? 0),
    );

    return { tasks: taskList, projectRows };
  }

  /** 顺序：任务 → 项目任务；卡片与跳转同 `renderTodayActionCards`（无提醒） */
  private renderTodayFollowUpCards(
    parent: HTMLElement,
    opts: {
      tasks: RSLatteIndexItem[];
      projectRows: Array<{ p: ProjectEntry; pt: ProjectTaskItem }>;
      todayKey: string;
    },
  ): void {
    const { tasks, projectRows, todayKey } = opts;
    const panel = this.plugin.settings?.taskPanel;
    const n = tasks.length + projectRows.length;
    if (n === 0) {
      parent.createDiv({ cls: "rslatte-muted", text: "（无等待/跟进事项）" });
      return;
    }
    for (const it of tasks) {
      const anyIt = it as any;
      appendDayEntryTaskLikeCard(this.app, parent, {
        kindLabel: "任务",
        task: {
          status: String(anyIt.status ?? ""),
          text: this.stripTaskBodyComments(String(anyIt.text ?? anyIt.raw ?? "")) || "（无描述）",
          starred: !!anyIt.starred,
          postpone_count: anyIt.postpone_count,
          complexity: anyIt.complexity,
          task_phase: anyIt.task_phase,
        },
        tagKeys: this.getTaskTagKeysForItem(it, todayKey),
        onClick: () => void this.openTodayFocusTask(it),
      });
    }
    for (const { p, pt } of projectRows) {
      const taskTags = getProjectTaskTagsOrCompute(pt, todayKey, panel);
      appendDayEntryTaskLikeCard(this.app, parent, {
        kindLabel: "项目任务",
        task: {
          status: String(pt.statusName ?? ""),
          text: this.stripTaskBodyComments(String(pt.text ?? "")) || "（无描述）",
          starred: !!pt.starred,
          postpone_count: pt.postpone_count,
          complexity: pt.complexity,
          task_phase: pt.task_phase,
        },
        tagKeys: taskTags,
        onClick: () => void this.openTodayFocusProjectTask(p, pt),
      });
    }
  }

  private tagsHitOverdueRiskCard(tags: string[]): boolean {
    for (const t of tags) {
      if (TODAY_OVERDUE_RISK_CARD_TAGS.has(t)) return true;
    }
    return false;
  }

  /**
   * 超期/风险任务（§1.5）：任务标签含「已超期」「高拖延风险」「假活跃」之一，且不含「今日应处理」、不在 `focus` 桶；
   * 项目任务同理，且不在今日重点项目任务行（星标+今日应处理）。
   */
  private buildTodayOverdueRiskCardEntries(opts: {
    listsData: {
      focus?: RSLatteIndexItem[];
      todayAction?: RSLatteIndexItem[];
      todayFollowUp?: RSLatteIndexItem[];
      overdue?: RSLatteIndexItem[];
      otherRisk?: RSLatteIndexItem[];
      otherActive?: RSLatteIndexItem[];
    };
    projects: ProjectEntry[];
    focusProjectRows: Array<{ p: ProjectEntry; pt: ProjectTaskItem }>;
    todayKey: string;
  }): {
    tasks: RSLatteIndexItem[];
    projectRows: Array<{ p: ProjectEntry; pt: ProjectTaskItem }>;
  } {
    const { listsData, projects, focusProjectRows, todayKey } = opts;
    const panel = this.plugin.settings?.taskPanel;
    const focusTaskKeys = new Set((listsData.focus ?? []).map((t) => this.itemKey(t)));
    const focusPtKeys = new Set(focusProjectRows.map(({ p, pt }) => this.projectTaskRowKey(p, pt)));

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
        byKey.set(this.itemKey(it), it);
      }
    }

    const tasks: RSLatteIndexItem[] = [];
    for (const it of byKey.values()) {
      if (focusTaskKeys.has(this.itemKey(it))) continue;
      const tags = this.getTaskTagKeysForItem(it, todayKey);
      if (tags.includes("今日应处理")) continue;
      if (!this.tagsHitOverdueRiskCard(tags)) continue;
      tasks.push(it);
    }
    tasks.sort((a, b) => ((b as any).importance_score ?? 0) - ((a as any).importance_score ?? 0));

    const projectRows: Array<{ p: ProjectEntry; pt: ProjectTaskItem }> = [];
    const seenPt = new Set<string>();
    for (const p of projects) {
      const pst = String(p?.status ?? "").trim();
      if (pst === "done" || pst === "cancelled") continue;
      const titems = (p.taskItems ?? []) as ProjectTaskItem[];
      for (const pt of titems) {
        const st = String(pt.statusName ?? "").toUpperCase();
        if (st === "DONE" || st === "CANCELLED") continue;
        const k = this.projectTaskRowKey(p, pt);
        if (focusPtKeys.has(k)) continue;
        const ptags = getProjectTaskTagsOrCompute(pt, todayKey, panel);
        if (ptags.includes("今日应处理")) continue;
        if (!this.tagsHitOverdueRiskCard(ptags)) continue;
        if (seenPt.has(k)) continue;
        seenPt.add(k);
        projectRows.push({ p, pt });
      }
    }
    projectRows.sort(
      (a, b) => ((b.pt as any).importance_score ?? 0) - ((a.pt as any).importance_score ?? 0),
    );

    return { tasks, projectRows };
  }

  private renderTodayOverdueRiskCards(
    parent: HTMLElement,
    opts: {
      tasks: RSLatteIndexItem[];
      projectRows: Array<{ p: ProjectEntry; pt: ProjectTaskItem }>;
      todayKey: string;
    },
  ): void {
    const { tasks, projectRows, todayKey } = opts;
    const panel = this.plugin.settings?.taskPanel;
    const n = tasks.length + projectRows.length;
    if (n === 0) {
      parent.createDiv({ cls: "rslatte-muted", text: "（无超期或风险任务）" });
      return;
    }
    for (const it of tasks) {
      const anyIt = it as any;
      appendDayEntryTaskLikeCard(this.app, parent, {
        kindLabel: "任务",
        task: {
          status: String(anyIt.status ?? ""),
          text: this.stripTaskBodyComments(String(anyIt.text ?? anyIt.raw ?? "")) || "（无描述）",
          starred: !!anyIt.starred,
          postpone_count: anyIt.postpone_count,
          complexity: anyIt.complexity,
          task_phase: anyIt.task_phase,
        },
        tagKeys: this.getTaskTagKeysForItem(it, todayKey),
        onClick: () => void this.openTodayFocusTask(it),
      });
    }
    for (const { p, pt } of projectRows) {
      const taskTags = getProjectTaskTagsOrCompute(pt, todayKey, panel);
      appendDayEntryTaskLikeCard(this.app, parent, {
        kindLabel: "项目任务",
        task: {
          status: String(pt.statusName ?? ""),
          text: this.stripTaskBodyComments(String(pt.text ?? "")) || "（无描述）",
          starred: !!pt.starred,
          postpone_count: pt.postpone_count,
          complexity: pt.complexity,
          task_phase: pt.task_phase,
        },
        tagKeys: taskTags,
        onClick: () => void this.openTodayFocusProjectTask(p, pt),
      });
    }
  }

  /** `schedule_date` / `memoDate` 的 YYYY-MM-DD（与 `queryScheduleBuckets` 一致） */
  private getScheduleItemDateYmd(it: RSLatteIndexItem): string {
    const extra = ((it as any)?.extra ?? {}) as Record<string, string>;
    const fromExtra = String(extra.schedule_date ?? "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(fromExtra)) return fromExtra;
    return String((it as any)?.memoDate ?? "").trim();
  }

  /** 日程标签：索引衍生日与日历日一致时用 `schedule_tags`；否则按任务日现算 */
  private getScheduleTagKeysForTodayItem(it: RSLatteIndexItem, taskTodayKey: string): string[] {
    const anyIt = it as any;
    const panel = this.plugin.settings?.taskPanel;
    const calDay = calendarTodayYmd();
    if (this._scheduleIndexTagDay === calDay && Array.isArray(anyIt.schedule_tags) && anyIt.schedule_tags.length > 0) {
      return anyIt.schedule_tags as string[];
    }
    return computeScheduleTags(it, taskTodayKey, panel);
  }

  /**
   * 任务日当天日程：从 `queryScheduleBuckets` 各活跃桶合并去重后按日程日期过滤（任务日 = 日历日时与侧栏「今日安排」一致）。
   */
  private buildTodayScheduleItemsForTaskDay(
    groups: {
      todayFocus?: RSLatteIndexItem[];
      upcoming?: RSLatteIndexItem[];
      overdue?: RSLatteIndexItem[];
      activeOther?: RSLatteIndexItem[];
    },
    taskTodayKey: string,
  ): RSLatteIndexItem[] {
    const pool = [
      ...(groups.todayFocus ?? []),
      ...(groups.upcoming ?? []),
      ...(groups.overdue ?? []),
      ...(groups.activeOther ?? []),
    ];
    const seen = new Set<string>();
    const out: RSLatteIndexItem[] = [];
    for (const it of pool) {
      if (!isScheduleMemoLine(it)) continue;
      if (this.getScheduleItemDateYmd(it) !== taskTodayKey) continue;
      const k = this.itemKey(it);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(it);
    }
    const stKey = (it: RSLatteIndexItem) => {
      const t = String(((it as any)?.extra ?? {})?.start_time ?? "").trim();
      return /^\d{2}:\d{2}$/.test(t) ? t : "99:99";
    };
    out.sort((a, b) => {
      const c = this.getScheduleItemDateYmd(a).localeCompare(this.getScheduleItemDateYmd(b));
      if (c !== 0) return c;
      return stKey(a).localeCompare(stKey(b));
    });
    return out;
  }

  private async openTodayScheduleItem(it: RSLatteIndexItem): Promise<void> {
    try {
      await this.plugin.activateTaskView();
      const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_TASKS)[0];
      const view = leaf?.view;
      if (view instanceof TaskSidePanelView) {
        await view.focusScheduleByFileLine(it.filePath, it.lineNo);
        return;
      }
    } catch (e: any) {
      new Notice(`跳转失败：${e?.message ?? String(e)}`);
    }
  }

  private renderTodayScheduleCards(parent: HTMLElement, items: RSLatteIndexItem[], taskTodayKey: string): void {
    if (!items.length) {
      parent.createDiv({ cls: "rslatte-muted", text: "（无今日日程）" });
      return;
    }
    for (const it of items) {
      appendDayEntryScheduleCard(this.app, parent, {
        item: it,
        displayText: this.stripTaskBodyComments(String((it as any).text ?? (it as any).raw ?? "")) || "（无描述）",
        tagKeys: this.getScheduleTagKeysForTodayItem(it, taskTodayKey),
        onClick: () => void this.openTodayScheduleItem(it),
      });
    }
  }

  private projectTaskActualStartYmd(pt: ProjectTaskItem): string | undefined {
    const s = String(pt.actual_start ?? "").trim();
    if (s && /^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    return undefined;
  }

  /** 与快照 `stale_progress` / 侧栏「假活跃」一致：进展更新日距今 ≥5 天（未完结项目） */
  private isProjectFakeActiveStale(p: ProjectEntry, todayYmd: string): boolean {
    const derived = String((p as any).projectDerivedForYmd ?? "").trim();
    const ptags = (p as any).project_tags as string[] | undefined;
    if (derived === todayYmd && Array.isArray(ptags) && ptags.includes("stale_progress")) return true;
    const pr = String(p.progress_updated ?? "").trim();
    const m = pr.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!m) return false;
    return daysBetweenYmd(m[1], todayYmd) >= 5;
  }

  private collectNextActionTasksSorted(p: ProjectEntry): ProjectTaskItem[] {
    const tasks = (p.taskItems ?? []) as ProjectTaskItem[];
    const nexts = tasks.filter((t) => t.is_next_action_for_l1);
    return [...nexts].sort(compareTasksForNextAction);
  }

  /** 单条一级「下一步」是否触发「项目推进项」展示条件（不含假活跃项；假活跃整项目另判） */
  private projectNextActionMatchesPushLine(pt: ProjectTaskItem, todayKey: string): boolean {
    const panel = this.plugin.settings?.taskPanel;
    const st = String(pt.statusName ?? "").toUpperCase().replace(/-/g, "_");
    const phase = reconcileTaskDisplayPhase(String(pt.statusName ?? ""), pt.task_phase, {
      wait_until: pt.wait_until,
      follow_up: pt.follow_up,
    });
    if (st === "IN_PROGRESS" && phase === "in_progress") return true;
    if (this.projectTaskActualStartYmd(pt) === todayKey) return true;
    if (
      (phase === "waiting_others" || phase === "waiting_until") &&
      getProjectTaskTagsOrCompute(pt, todayKey, panel).includes("今日应处理")
    ) {
      return true;
    }
    return false;
  }

  private projectQualifiesForPush(p: ProjectEntry, todayKey: string): boolean {
    const pst = String(p?.status ?? "").trim().toLowerCase();
    if (pst === "done" || pst === "cancelled" || pst === "canceled") return false;
    if (this.isProjectFakeActiveStale(p, todayKey)) return true;
    for (const pt of this.collectNextActionTasksSorted(p)) {
      if (this.projectNextActionMatchesPushLine(pt, todayKey)) return true;
    }
    return false;
  }

  private buildTodayProjectPushRows(
    projects: ProjectEntry[],
    todayKey: string,
  ): Array<{ p: ProjectEntry; nextTasks: ProjectTaskItem[] }> {
    const rows: Array<{ p: ProjectEntry; nextTasks: ProjectTaskItem[] }> = [];
    for (const p of projects) {
      if (!this.projectQualifiesForPush(p, todayKey)) continue;
      rows.push({ p, nextTasks: this.collectNextActionTasksSorted(p) });
    }
    rows.sort((a, b) => {
      const sa = computeProjectRiskSummary(a.p, todayKey).score;
      const sb = computeProjectRiskSummary(b.p, todayKey).score;
      if (sb !== sa) return sb - sa;
      return String(a.p.projectName ?? "").localeCompare(String(b.p.projectName ?? ""), "zh-Hans-CN");
    });
    return rows;
  }

  private wireTodayInteractiveCard(card: HTMLElement, onClick: () => void): void {
    card.addClass("rslatte-day-card--interactive");
    card.tabIndex = 0;
    card.setAttr("role", "button");
    card.addEventListener("click", () => void onClick());
    card.addEventListener("keydown", (ev) => {
      if ((ev as KeyboardEvent).key === "Enter" || (ev as KeyboardEvent).key === " ") {
        ev.preventDefault();
        void onClick();
      }
    });
  }

  /** 项目卡片首行右侧：风险等级 + 超期/延期/即将超期/假活跃（与侧栏概要语义对齐） */
  private appendTodayProjectHeadChips(tagsWrap: HTMLElement, p: ProjectEntry, todayKey: string): void {
    const r = computeProjectRiskSummary(p, todayKey);
    const riskChip = tagsWrap.createSpan({
      cls: `rslatte-day-card__tag rslatte-task-tag rslatte-task-tag--${r.colorSuffix}`,
      text: r.levelLabel,
    });
    riskChip.setAttr("title", `风险分 ${r.score}`);
    const isClosed = ["done", "cancelled", "canceled"].includes(String(p.status ?? "").trim().toLowerCase());
    if (isClosed) return;
    const pe = String(p.planned_end ?? "").match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
    const soonN = Math.max(
      0,
      Math.min(30, Number(this.plugin.settings?.projectPanel?.progressProjectUpcomingDays ?? 5) || 5),
    );
    const addHint = (label: string, suffix: string, title?: string) => {
      const chip = tagsWrap.createSpan({ cls: `rslatte-day-card__tag rslatte-task-tag ${suffix}`, text: label });
      if (title) chip.setAttr("title", title);
    };
    if (pe && compareYmd(pe, todayKey) <= 0) {
      addHint("超期", "rslatte-task-tag--red", `计划完成日：${pe}`);
    }
    const postponeCount = Math.max(0, Number((p as any).postpone_count ?? 0) || 0);
    if (postponeCount >= 1) addHint("延期", "rslatte-task-tag--orange", `延期次数：${postponeCount}`);
    if (pe && compareYmd(pe, todayKey) > 0) {
      const until = daysBetweenYmd(todayKey, pe);
      if (until >= 0 && until <= soonN) {
        addHint("即将超期", "rslatte-task-tag--orange", `计划完成日：${pe}（${soonN} 天内）`);
      }
    }
    if (this.isProjectFakeActiveStale(p, todayKey)) {
      addHint("假活跃", "rslatte-task-tag--orange", "进展多日未更新");
    }
  }

  private appendPushNextRowTaskTagChips(rowMain: HTMLElement, tagKeys: string[]): void {
    const visible = tagKeys.filter((k) => k && !TODAY_PUSH_NEXT_TAGS_HIDDEN.has(k));
    if (!visible.length) return;
    const colorNames: Record<number, string> = { 1: "red", 2: "orange", 3: "yellow", 4: "green" };
    const wrap = rowMain.createDiv({ cls: "rslatte-day-card__tags" });
    for (const key of visible.slice(0, 6)) {
      const info = TASK_TAG_META[key] ?? MEMO_TAG_META[key] ?? SCHEDULE_TAG_META[key];
      const label = info?.label ?? key;
      const fullName = info?.fullName ?? key;
      const colorOrder = info?.colorOrder ?? 4;
      const chip = wrap.createSpan({ cls: "rslatte-day-card__tag rslatte-task-tag" });
      chip.setText(label);
      chip.setAttr("title", fullName);
      chip.addClass(`rslatte-task-tag--${colorNames[colorOrder] ?? "green"}`);
    }
  }

  private async openTodayProjectProgress(p: ProjectEntry): Promise<void> {
    try {
      await this.plugin.activateProjectView();
      const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_PROJECTS)[0];
      const view = leaf?.view;
      if (view instanceof ProjectSidePanelView) {
        await view.openProgressTabForProject(p);
        return;
      }
    } catch (e: any) {
      new Notice(`跳转失败：${e?.message ?? String(e)}`);
    }
  }

  private renderTodayProjectPushCards(
    parent: HTMLElement,
    rows: Array<{ p: ProjectEntry; nextTasks: ProjectTaskItem[] }>,
    todayKey: string,
  ): void {
    const panel = this.plugin.settings?.taskPanel;
    for (const { p, nextTasks } of rows) {
      const card = parent.createDiv({ cls: "rslatte-today-project-card" });
      this.wireTodayInteractiveCard(card, () => void this.openTodayProjectProgress(p));

      const headMain = card.createDiv({ cls: "rslatte-day-card__main rslatte-today-project-card__head" });
      headMain.createSpan({ cls: "rslatte-day-card__kind", text: "项目" });
      const titleEl = headMain.createDiv({
        cls: "rslatte-today-project-card__title",
        text: p.projectName || "（未命名项目）",
      });
      const folderHint = normalizePath(String(p.folderPath ?? "").trim());
      if (folderHint) titleEl.setAttr("title", folderHint);
      const headTags = headMain.createDiv({ cls: "rslatte-day-card__tags" });
      this.appendTodayProjectHeadChips(headTags, p, todayKey);

      if (!nextTasks.length) {
        card.createDiv({
          cls: "rslatte-muted rslatte-today-project-card__empty-next",
          text: "（当前无一级里程碑「下一步」任务）",
        });
        continue;
      }
      for (const pt of nextTasks) {
        const main = card.createDiv({ cls: "rslatte-day-card__main" });
        main.createSpan({ cls: "rslatte-day-card__kind", text: "下一步" });
        const dot = main.createSpan({ cls: "rslatte-day-card__dot" });
        dot.setText(dayCardStatusIcon(String(pt.statusName ?? ""), pt.task_phase));
        dot.setAttr(
          "title",
          dayCardEntryStatusTitle({
            status: String(pt.statusName ?? ""),
            task_phase: pt.task_phase,
          } as RSLatteIndexItem),
        );
        const desc = main.createDiv({ cls: "rslatte-day-card__desc" });
        const display =
          buildDescPrefix({
            starred: !!pt.starred,
            postpone_count: pt.postpone_count,
            complexity: pt.complexity,
          }) + (this.stripTaskBodyComments(String(pt.text ?? "")) || "（无描述）");
        renderTextWithContactRefs(this.app, desc, display);
        this.appendPushNextRowTaskTagChips(main, getProjectTaskTagsOrCompute(pt, todayKey, panel));
      }
    }
  }

  private renderExecuteStatClickableBlock(
    parent: HTMLElement,
    title: string,
    bodyText: string,
    onClick: () => void,
  ): void {
    const card = parent.createDiv({ cls: "rslatte-today-stat-item rslatte-today-stat-item--clickable" });
    card.title = "点击查看详情";
    card.createDiv({ cls: "rslatte-today-stat-item-title", text: title });
    card.createDiv({ cls: "rslatte-today-stat-item-body", text: bodyText });
    this.wireTodayInteractiveCard(card, onClick);
  }

  private renderContactStatSubline(
    parent: HTMLElement,
    prefixLabel: string,
    count: number,
    entries: TodayContactStatEntry[],
    expandKey: "birth" | "follow" | "stale",
    maxInline: number,
  ): void {
    const row = parent.createDiv({ cls: "rslatte-today-stat-contact-line" });
    row.createSpan({ cls: "rslatte-today-stat-contact-k", text: `${prefixLabel} ${count}：` });
    const n = entries.length;
    if (n === 0) {
      row.createSpan({ cls: "rslatte-muted", text: "—" });
      return;
    }
    const expanded = this._statsContactExpand[expandKey];
    const show = expanded ? entries : entries.slice(0, maxInline);
    for (let i = 0; i < show.length; i++) {
      if (i > 0) row.createSpan({ text: "、" });
      const e = show[i];
      const nameEl = row.createSpan({ cls: "rslatte-today-stat-contact-name", text: e.name });
      nameEl.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void this.openStatsContactUid(e.uid);
      });
    }
    const rest = n - maxInline;
    if (!expanded && rest > 0) {
      const more = row.createSpan({ cls: "rslatte-today-stat-contact-more", text: ` +${rest}` });
      more.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this._statsContactExpand[expandKey] = true;
        void this.render();
      });
    }
  }

  private async openStatsCaptureInbox(): Promise<void> {
    try {
      await (this.plugin as any).activateCaptureView?.();
    } catch (e: any) {
      new Notice(`跳转失败：${e?.message ?? String(e)}`);
    }
  }

  private async openStatsProjectList(): Promise<void> {
    try {
      await this.plugin.activateProjectView();
      const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_PROJECTS)[0];
      const v = leaf?.view;
      if (v instanceof ProjectSidePanelView) await v.openProjectListTabFromStats();
    } catch (e: any) {
      new Notice(`跳转失败：${e?.message ?? String(e)}`);
    }
  }

  private async openStatsTodayHandling(): Promise<void> {
    try {
      await this.plugin.activateTaskView();
      const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_TASKS)[0];
      const v = leaf?.view;
      if (v instanceof TaskSidePanelView) await v.openTodayHandlingFromStats();
    } catch (e: any) {
      new Notice(`跳转失败：${e?.message ?? String(e)}`);
    }
  }

  private async openStatsOutputInProgress(): Promise<void> {
    try {
      await this.plugin.activateOutputView();
      const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_OUTPUTS)[0];
      const v = leaf?.view;
      if (v instanceof OutputSidePanelView) await v.openInProgressListFromStats();
    } catch (e: any) {
      new Notice(`跳转失败：${e?.message ?? String(e)}`);
    }
  }

  private async openStatsContactUid(uid: string): Promise<void> {
    const u = String(uid ?? "").trim();
    if (!u) return;
    try {
      await (this.plugin as any).activateContactsView?.();
      const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CONTACTS)[0];
      const v = leaf?.view;
      if (v instanceof ContactsSidePanelView) await v.focusContactByUid(u);
    } catch (e: any) {
      new Notice(`跳转失败：${e?.message ?? String(e)}`);
    }
  }

  private async render() {
    const seq = ++this._renderSeq;
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("rslatte-today-view");

    const stickyHead = container.createDiv({ cls: "rslatte-today-sticky-head" });
    const tabs = stickyHead.createDiv({ cls: "rslatte-task-subtabs rslatte-today-subtabs" });
    const addTab = (id: TodaySubTab, label: string) => {
      const btn = tabs.createEl("button", { text: label, cls: "rslatte-task-subtab" });
      if (this._subTab === id) btn.addClass("is-active");
      btn.onclick = () => {
        if (this._subTab === id) return;
        this._subTab = id;
        void this.render();
      };
    };
    addTab("execute", "今日执行");
    addTab("reconcile", "今日核对");
    addTab("records", "今日记录");

    const todayKey = getTaskTodayKey(this.plugin.settings?.taskPanel ?? undefined);

    if (this._subTab === "records") {
      const headerSection = stickyHead.createDiv({ cls: "rslatte-section rslatte-records-header rslatte-today-header" });
      const { left: headerLeft, right: headerRight } = createHeaderRow(
        headerSection,
        "rslatte-section-title-row",
        "rslatte-section-title-left",
        "rslatte-task-actions",
      );
      headerLeft.createEl("h3", { text: "今日记录" });
      const dateSpan = headerLeft.createEl("span", { cls: "rslatte-today-date rslatte-muted" });
      dateSpan.setText(` ${todayKey}`);
      const refreshBtn = headerRight.createEl("button", { text: "🔄", cls: "rslatte-icon-btn" });
      refreshBtn.title = "刷新";
      refreshBtn.onclick = () => void this.refresh();
      const content = container.createDiv({ cls: "rslatte-records-content" });
      const model = await buildTodayRecordsModel(this.plugin, todayKey);
      if (seq !== this._renderSeq) return;
      renderTodayRecordsBody({ plugin: this.plugin, container: content, model });
      return;
    }

    if (this._subTab === "reconcile") {
      const headerSection = stickyHead.createDiv({ cls: "rslatte-section rslatte-records-header rslatte-today-header" });
      const { left: headerLeft, right: headerRight } = createHeaderRow(
        headerSection,
        "rslatte-section-title-row",
        "rslatte-section-title-left",
        "rslatte-task-actions",
      );
      headerLeft.createEl("h3", { text: "今日核对" });
      const dateSpan = headerLeft.createEl("span", { cls: "rslatte-today-date rslatte-muted" });
      dateSpan.setText(` ${todayKey}`);
      const refreshBtn = headerRight.createEl("button", { text: "🔄", cls: "rslatte-icon-btn" });
      refreshBtn.title = "刷新";
      refreshBtn.onclick = () => void this.refresh();
      const content = container.createDiv({ cls: "rslatte-records-content" });
      await renderRecordReconcileBody({
        plugin: this.plugin,
        container: content,
        isCurrentSeq: () => seq === this._renderSeq,
      });
      return;
    }

    const headerSection = stickyHead.createDiv({ cls: "rslatte-section rslatte-today-header" });
    const { left: headerLeft, right: headerRight } = createHeaderRow(
      headerSection,
      "rslatte-section-title-row",
      "rslatte-section-title-left",
      "rslatte-task-actions",
    );
    headerLeft.createEl("h3", { text: "今日执行" });
    const dateSpan = headerLeft.createEl("span", { cls: "rslatte-today-date rslatte-muted" });
    dateSpan.setText(` ${todayKey}`);
    const refreshBtn = headerRight.createEl("button", { text: "🔄", cls: "rslatte-icon-btn" });
    refreshBtn.title = "刷新";
    refreshBtn.onclick = () => void this.refresh();

    const listsData = await this.plugin.taskRSLatte.getTaskListsForSidePanel();
    const scheduleGroups = await this.plugin.taskRSLatte.queryScheduleBuckets({
      upcomingDays: this.plugin.settings.taskPanel?.scheduleUpcomingDays ?? 5,
      recentClosedDays: this.plugin.settings.taskPanel?.scheduleRecentClosedDays ?? 30,
    });
    const reminderGroups = await this.plugin.taskRSLatte.queryReminderBuckets({
      upcomingDays: this.plugin.settings.taskPanel?.reminderUpcomingDays ?? 5,
      recentClosedDays: this.plugin.settings.taskPanel?.recentClosedMemoWindowDays ?? 30,
    });
    const tr = this.plugin.taskRSLatte as any;
    if (tr && typeof tr.getMemoIndexTagsDerivedDay === "function") {
      this._memoIndexTagDay = await tr.getMemoIndexTagsDerivedDay();
    } else {
      this._memoIndexTagDay = undefined;
    }
    if (tr && typeof tr.getScheduleIndexTagsDerivedDay === "function") {
      this._scheduleIndexTagDay = await tr.getScheduleIndexTagsDerivedDay();
    } else {
      this._scheduleIndexTagDay = undefined;
    }
    if (tr && typeof tr.getTaskIndexTagsDerivedDay === "function") {
      this._taskIndexTagDay = await tr.getTaskIndexTagsDerivedDay();
    } else {
      this._taskIndexTagDay = undefined;
    }
    const backlogCount = await ((this.plugin as any).getCaptureInboxBacklogCount?.() ?? Promise.resolve(0));
    if (seq !== this._renderSeq) return;

    /**
     * 项目快照：与项目管理侧栏 SWR 一致——ensureReady 未完成前先从 `project-panel-hydrate.json` 灌内存，
     * 再 await ensureReady；避免仅打开 Today、或空间切换后快照被清空时行动清单长期无项目任务。
     */
    let dbgHydrateApplied = false;
    let dbgWasSettledBefore = false;
    if (this.plugin.projectMgr) {
      try {
        const pm = this.plugin.projectMgr;
        dbgWasSettledBefore = pm.isEnsureReadySettled();
        if (!dbgWasSettledBefore) {
          const ver = String(this.plugin.manifest?.version ?? "0.0.1");
          const hydrated = await pm.tryReadPanelHydrateSnapshot(ver);
          if (hydrated && (hydrated.projects?.length ?? 0) > 0) {
            pm.applyPanelHydrateSnapshot(hydrated);
            dbgHydrateApplied = true;
          }
        }
        await pm.ensureReady();
      } catch (e) {
        console.warn("[RSLatte][TodayView] projectMgr hydrate/ensureReady failed", e);
        if (this.plugin.isDebugLogEnabled()) {
          this.plugin.dbg("todayView", "project_bootstrap_error", {
            seq,
            todayKey,
            err: (e as any)?.message ?? String(e),
          });
        }
      }
    }
    if (seq !== this._renderSeq) return;

    /** 与今日核对 / 今日记录一致：正文包在 rslatte-records-content 下，统一顶距与滚动区结构 */
    const content = container.createDiv({ cls: "rslatte-records-content" });

    const projSnap = this.plugin.projectMgr?.getSnapshot?.();
    if (this.plugin.isDebugLogEnabled()) {
      const projs = Array.isArray(projSnap?.projects) ? projSnap!.projects : [];
      let projectTaskItemCount = 0;
      let activeProjectCount = 0;
      for (const p of projs) {
        const st = String(p?.status ?? "").trim().toLowerCase();
        if (st !== "done" && st !== "cancelled") activeProjectCount++;
        projectTaskItemCount += (p.taskItems ?? []).length;
      }
      this.plugin.dbg("todayView", "project_snapshot_after_bootstrap", {
        seq,
        todayKey,
        wasSettledBeforeBootstrap: dbgWasSettledBefore,
        hydrateApplied: dbgHydrateApplied,
        ensureReadySettledNow: this.plugin.projectMgr?.isEnsureReadySettled?.() ?? null,
        snapshotProjectCount: projs.length,
        snapshotActiveProjectCount: activeProjectCount,
        snapshotProjectTaskItemCount: projectTaskItemCount,
        snapshotUpdatedAt: projSnap?.updatedAt ?? null,
      });
    }

    // —— 执行清单区 ——
    const checklistRegion = content.createDiv({ cls: "rslatte-today-execute-region rslatte-today-execute-checklist" });
    checklistRegion.createDiv({ cls: "rslatte-today-execute-region-title rslatte-today-execute-region-title-first", text: "执行清单" });

    // 1) 今日重点处理
    const focusSection = checklistRegion.createDiv({ cls: "rslatte-section rslatte-task-section rslatte-expanded" });
    const { left: focusLeft, right: focusRight } = createHeaderRow(
      focusSection,
      "rslatte-section-title-row",
      "rslatte-section-title-left",
      "rslatte-task-actions",
    );
    focusLeft.createEl("h4", { text: "🔥 今日重点处理" });
    const focusTopTasks = (listsData.focus ?? []).slice(0, 3);
    /** 仅提醒标签「今日关注」，不要求星标 */
    const focusReminders = (reminderGroups.todayFocus ?? []).filter((m) =>
      this.getMemoTagKeysForItem(m).includes("今日关注"),
    );
    const focusProjectRows: Array<{ p: ProjectEntry; pt: ProjectTaskItem }> = [];
    const projects: ProjectEntry[] = Array.isArray(projSnap?.projects) ? projSnap!.projects : [];
    for (const p of projects) {
      const pst = String(p?.status ?? "").trim();
      if (pst === "done" || pst === "cancelled") continue;
      const tasks = (p.taskItems ?? []) as ProjectTaskItem[];
      for (const pt of tasks) {
        if (!this.projectTaskMatchesStarredTodayTag(pt, todayKey)) continue;
        focusProjectRows.push({ p, pt });
      }
    }
    const focusTotal = focusTopTasks.length + focusProjectRows.length + focusReminders.length;
    focusRight.createEl("span", { cls: "rslatte-muted", text: `${focusTotal}` });
    const focusList = focusSection.createDiv({ cls: "rslatte-today-focus-cards" });
    this.renderTodayFocusCards(focusList, {
      focusTasks: focusTopTasks,
      focusProjectRows,
      focusReminders,
      todayKey,
    });

    // 2) 今日行动清单（仅今日行动，不含等待/跟进）
    const actionSection = checklistRegion.createDiv({ cls: "rslatte-section rslatte-task-section rslatte-expanded" });
    const { left: actionLeft, right: actionRight } = createHeaderRow(
      actionSection,
      "rslatte-section-title-row",
      "rslatte-section-title-left",
      "rslatte-task-actions",
    );
    actionLeft.createEl("h4", { text: "📋 今日行动清单" });
    const actionEntries = this.buildTodayActionEntries({
      listsData,
      reminderTodayFocus: reminderGroups.todayFocus ?? [],
      projects,
      focusTopTasks,
      focusReminders,
      focusProjectRows,
      todayKey,
    });
    const actionTotal =
      actionEntries.tasks.length + actionEntries.memos.length + actionEntries.projectRows.length;
    actionRight.createEl("span", { cls: "rslatte-muted", text: `${actionTotal}` });
    const actionList = actionSection.createDiv({ cls: "rslatte-today-focus-cards" });
    this.renderTodayActionCards(actionList, { ...actionEntries, todayKey });

    // 3) 项目推进项（一级轨下一步 + 假活跃项目；项目卡片见 Today优化方案 §1.3c）
    const projectPushSection = checklistRegion.createDiv({ cls: "rslatte-section rslatte-task-section rslatte-expanded" });
    const { left: ppLeft, right: ppRight } = createHeaderRow(
      projectPushSection,
      "rslatte-section-title-row",
      "rslatte-section-title-left",
      "rslatte-task-actions",
    );
    ppLeft.createEl("h4", { text: "🚀 项目推进项" });
    const pushRows = this.buildTodayProjectPushRows(projects, todayKey);
    ppRight.createEl("span", { cls: "rslatte-muted", text: `${pushRows.length}` });
    const projectPushList = projectPushSection.createDiv({ cls: "rslatte-today-focus-cards" });
    if (pushRows.length === 0) {
      projectPushList.createDiv({ cls: "rslatte-muted", text: "（暂无符合推进条件的项目）" });
    } else {
      this.renderTodayProjectPushCards(projectPushList, pushRows, todayKey);
    }

    // 4) 等待中 / 跟进中事项
    const followSection = checklistRegion.createDiv({ cls: "rslatte-section rslatte-task-section rslatte-expanded" });
    const { left: followLeft, right: followRight } = createHeaderRow(
      followSection,
      "rslatte-section-title-row",
      "rslatte-section-title-left",
      "rslatte-task-actions",
    );
    followLeft.createEl("h4", { text: "⏳ 等待中 / 跟进中事项" });
    const followCardEntries = this.buildTodayFollowUpCardEntries({
      listsData,
      projects,
      focusTopTasks,
      todayKey,
    });
    const followCardTotal = followCardEntries.tasks.length + followCardEntries.projectRows.length;
    followRight.createEl("span", { cls: "rslatte-muted", text: `${followCardTotal}` });
    const followList = followSection.createDiv({ cls: "rslatte-today-focus-cards" });
    this.renderTodayFollowUpCards(followList, { ...followCardEntries, todayKey });

    // 5) 今日日程
    const scheduleSection = checklistRegion.createDiv({ cls: "rslatte-section rslatte-task-section rslatte-expanded" });
    const { left: scheduleLeft, right: scheduleRight } = createHeaderRow(
      scheduleSection,
      "rslatte-section-title-row",
      "rslatte-section-title-left",
      "rslatte-task-actions",
    );
    scheduleLeft.createEl("h4", { text: "🗓 今日日程" });
    const todayScheduleItems = this.buildTodayScheduleItemsForTaskDay(scheduleGroups, todayKey);
    scheduleRight.createEl("span", { cls: "rslatte-muted", text: `${todayScheduleItems.length}` });
    const scheduleList = scheduleSection.createDiv({ cls: "rslatte-today-focus-cards" });
    this.renderTodayScheduleCards(scheduleList, todayScheduleItems, todayKey);

    // 6) 超期 / 风险任务
    const overdueSection = checklistRegion.createDiv({ cls: "rslatte-section rslatte-task-section rslatte-expanded" });
    const { left: overdueLeft, right: overdueRight } = createHeaderRow(
      overdueSection,
      "rslatte-section-title-row",
      "rslatte-section-title-left",
      "rslatte-task-actions",
    );
    overdueLeft.createEl("h4", { text: "⏰ 超期 / 风险任务" });
    const overdueRiskEntries = this.buildTodayOverdueRiskCardEntries({
      listsData,
      projects,
      focusProjectRows,
      todayKey,
    });
    const overdueRiskTotal = overdueRiskEntries.tasks.length + overdueRiskEntries.projectRows.length;
    overdueRight.createEl("span", { cls: "rslatte-muted", text: `${overdueRiskTotal}` });
    const overdueRiskListEl = overdueSection.createDiv({ cls: "rslatte-today-focus-cards" });
    this.renderTodayOverdueRiskCards(overdueRiskListEl, { ...overdueRiskEntries, todayKey });

    let contactItems: ContactIndexItem[] = [];
    try {
      contactItems = (await this.plugin.contactsIndex?.getIndexStore?.()?.readIndex?.())?.items ?? [];
    } catch {
      contactItems = [];
    }
    let outputItems: OutputIndexItem[] = [];
    try {
      await this.plugin.outputRSLatte?.refreshIndexNow?.({ mode: "full" });
      const osnap = await this.plugin.outputRSLatte?.getSnapshot?.();
      outputItems = (osnap?.items ?? []) as OutputIndexItem[];
    } catch {
      outputItems = [];
    }
    if (seq !== this._renderSeq) return;

    const cmAny: any = (this.plugin.settings as any).contactsModule ?? {};
    const contactFollowupOverdueDays = Number(cmAny.contactFollowupOverdueDays ?? 30) || 30;

    const calendarTodayYmdForStats = String(this.plugin.getTodayKey?.() ?? "").trim().slice(0, 10);
    /** 执行统计前再拉一次全状态 Inbox，避免与「未清理」计数之间隔了长渲染导致列表不一致 */
    const inboxForStats = await ((this.plugin as any).listCaptureInboxItems?.({
      todo: true,
      done: true,
      cancelled: true,
      paused: true,
    }) ?? Promise.resolve([]));
    if (seq !== this._renderSeq) return;
    if (this.plugin.isDebugLogEnabled()) {
      this.plugin.dbg("todayView", "execute_stats_inbox", {
        backlogCount,
        inboxForStatsLen: inboxForStats.length,
        addedTodayPrecalc: countInboxItemsAddedOnTaskOrCalendarDay(inboxForStats, todayKey, calendarTodayYmdForStats),
        addDatesSample: inboxForStats.slice(0, 16).map((i: { addDate?: string }) => i.addDate),
        todayKey,
        calendarTodayYmdForStats,
      });
    }
    let statsModel = await buildTodayExecuteStatsModel({
      app: this.app,
      todayKey,
      taskPanel: this.plugin.settings?.taskPanel,
      listsData,
      projects,
      inboxItemsAllStatuses: inboxForStats,
      backlogCount,
      calendarTodayYmd: calendarTodayYmdForStats,
      contactItems,
      outputItems,
      taskIndexTagsDerivedYmd: this._taskIndexTagDay,
      contactFollowupOverdueDays,
    }).catch((e) => {
      console.warn("[RSLatte][TodayView] buildTodayExecuteStatsModel failed", e);
      return null;
    });
    if (!statsModel) {
      const addedTodayFallback = countInboxItemsAddedOnTaskOrCalendarDay(inboxForStats, todayKey, calendarTodayYmdForStats);
      statsModel = {
        inbox: { addedToday: addedTodayFallback, backlog: backlogCount },
        projects: { active: 0, pushing: 0, riskNext: 0, fakeActive: 0 },
        taskRisk: { overdue: 0, delay: 0, fake: 0 },
        waiting: { waitTotal: 0, waitToday: 0, followTotal: 0, followToday: 0, riskHighDelay: 0 },
        output: { general: 0, project: 0 },
        contacts: { birthday: [], followUp: [], stale: [] },
      };
    }
    if (seq !== this._renderSeq) return;

    // —— 执行统计区 ——
    const statsRegion = content.createDiv({ cls: "rslatte-today-execute-region rslatte-today-execute-stats" });
    const statsTitleRow = statsRegion.createDiv({ cls: "rslatte-today-stats-header" });
    statsTitleRow.createDiv({ cls: "rslatte-today-execute-region-title", text: "执行统计" });
    const statsDashLink = statsTitleRow.createSpan({ cls: "rslatte-today-link", text: "工作台" });
    statsDashLink.title = "打开 RSLatte工作台";
    statsDashLink.style.cursor = "pointer";
    statsDashLink.onclick = () => void this.plugin.activateHubView();

    const statList = statsRegion.createDiv({ cls: "rslatte-today-stat-list" });

    const sm = statsModel;
    this.renderExecuteStatClickableBlock(
      statList,
      "📥 Inbox / 快速记录",
      `今日新增 ${sm.inbox.addedToday} ｜ 未清理 ${sm.inbox.backlog}`,
      () => void this.openStatsCaptureInbox(),
    );
    this.renderExecuteStatClickableBlock(
      statList,
      "🎯 活跃项目",
      `活跃 ${sm.projects.active} ｜ 推进中 ${sm.projects.pushing} ｜ 风险 ${sm.projects.riskNext} ｜ 假活跃 ${sm.projects.fakeActive}`,
      () => void this.openStatsProjectList(),
    );
    this.renderExecuteStatClickableBlock(
      statList,
      "🗂 任务风险",
      `已超期 ${sm.taskRisk.overdue} ｜ 高拖延 ${sm.taskRisk.delay} ｜ 假活跃 ${sm.taskRisk.fake}`,
      () => void this.openStatsTodayHandling(),
    );
    this.renderExecuteStatClickableBlock(
      statList,
      "⏸ 等待推进",
      `等待 ${sm.waiting.waitTotal}（今${sm.waiting.waitToday}）｜ 跟进 ${sm.waiting.followTotal}（今${sm.waiting.followToday}）｜ 风险 ${sm.waiting.riskHighDelay}`,
      () => void this.openStatsTodayHandling(),
    );

    const contactBlock = statList.createDiv({ cls: "rslatte-today-stat-item" });
    contactBlock.createDiv({ cls: "rslatte-today-stat-item-title", text: "👤 联系人动态" });
    this.renderContactStatSubline(
      contactBlock,
      "生日",
      sm.contacts.birthday.length,
      sm.contacts.birthday,
      "birth",
      2,
    );
    this.renderContactStatSubline(
      contactBlock,
      "待跟进",
      sm.contacts.followUp.length,
      sm.contacts.followUp,
      "follow",
      2,
    );
    this.renderContactStatSubline(
      contactBlock,
      "未互动",
      sm.contacts.stale.length,
      sm.contacts.stale,
      "stale",
      2,
    );

    this.renderExecuteStatClickableBlock(
      statList,
      "✍ 输出候选",
      `一般 ${sm.output.general} ｜ 项目 ${sm.output.project}`,
      () => void this.openStatsOutputInProgress(),
    );
  }

  public refresh() {
    void this.render();
  }
}
