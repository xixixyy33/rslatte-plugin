import { ItemView, Menu, Notice, TFile, WorkspaceLeaf, normalizePath } from "obsidian";
import type RSLattePlugin from "../../main";
import { VIEW_TYPE_OUTPUTS, VIEW_TYPE_PROJECTS, VIEW_TYPE_TASKS } from "../../constants/viewTypes";
import { isScheduleMemoLine, type RSLatteIndexItem } from "../../taskRSLatte/types";
import type { ProjectEntry, ProjectTaskItem } from "../../projectManager/types";
import { AddTaskModal } from "../modals/AddTaskModal";
import { AddMemoModal } from "../modals/AddMemoModal";
import { ArrangeMemoModal } from "../modals/ArrangeMemoModal";
import { AddScheduleModal } from "../modals/AddScheduleModal";
import { ScheduleFollowupPostModal } from "../modals/ScheduleFollowupPostModal";
import { RecordTaskScheduleModal } from "../modals/RecordTaskScheduleModal";
import { EditTaskModal } from "../modals/EditTaskModal";
import { EditMemoModal } from "../modals/EditMemoModal";
import { EditScheduleModal } from "../modals/EditScheduleModal";
import { ScheduleEndModal } from "../modals/ScheduleEndModal";
import { EditProjectTaskModal } from "../modals/EditProjectTaskModal";
import { TaskProgressModal } from "../modals/TaskProgressModal";
import { ProjectTaskProgressModal } from "../modals/ProjectTaskProgressModal";
import { buildDescPrefix } from "../../taskRSLatte/parser";
import { computeTaskTags, getTaskTodayKey, TASK_TAG_META } from "../../taskRSLatte/task/taskTags";
import { calendarTodayYmd, computeMemoTags, MEMO_TAG_META } from "../../taskRSLatte/memo/memoTags";
import { computeScheduleTags, SCHEDULE_TAG_META } from "../../taskRSLatte/schedule/scheduleTags";
import { labelForScheduleCategoryId } from "../../taskRSLatte/schedule/scheduleCategory";
import { createHeaderRow, appendDbSyncIndicator } from "../helpers/moduleHeader";
import { getUiHeaderButtonsVisibility } from "../helpers/uiHeaderButtons";
import { normalizeRunSummaryForUi } from "../helpers/normalizeRunSummaryForUi";
import { plainTextFromTextWithContactRefsResolved, renderTextWithContactRefs } from "../helpers/renderTextWithContactRefs";
import { writeTaskApplyStatus, writeTaskSetStarred } from "../../services/execution/taskWriteFacade";
import { writeMemoApplyStatus, writeMemoSetInvalidated, writeMemoSetStarred } from "../../services/execution/memoWriteFacade";
import { writeScheduleApplyStatus, writeScheduleSetInvalidated, writeScheduleSetStarred } from "../../services/execution/scheduleWriteFacade";
import { EXECUTION_RECIPE } from "../../services/execution/executionOrchestrator";
import { buildWorkEventUiAction } from "../../services/execution/buildExecutionWorkEvents";
import { runExecutionFlowUi } from "../helpers/runExecutionFlowUi";
import { outputIndexItemIsProjectKind } from "../../types/outputTypes";
import { displayPhaseAfterTaskCheckbox, indexItemTaskDisplayPhase, normalizeRepeatRuleToken } from "../../taskRSLatte/utils";

/** 侧栏卡片操作：icon 为图标按钮字符；text 预留给少量文字按钮场景 */
type SidePanelCardActionEntry =
  | { id: string; kind: "icon"; icon: string; title: string; run: () => Promise<void> }
  | { id: string; kind: "text"; text: string; title: string; run: () => Promise<void> };

type TaskSubTab = "memo" | "schedule" | "task";

export class TaskSidePanelView extends ItemView {
  private plugin: RSLattePlugin;
  private _renderSeq = 0;
  // Prevent flicker caused by re-entrant refresh (e.g. DB id write-back triggers refreshSidePanel).
  private _renderPromise: Promise<void> | null = null;
  private _pendingRender = false;

  /** milestone expand state: key = `${projectId}::${milestoneName}` */
  private _expandedMilestones = new Set<string>();

  /** 折叠/展开时保存的滚动位置，渲染完成后恢复，避免侧栏跳回顶部 */
  private _savedScrollTop: number | null = null;
  /** 事项提醒四分组折叠状态（仅会话内记忆；不持久化） */
  private _reminderCollapsed: Record<string, boolean> = {};
  /** 顶层子页签（事项提醒 / 日程安排 / 任务清单） */
  private _subTab: TaskSubTab = "memo";
  /** 与索引 memo_tags / schedule_tags 配套的根级业务日（日历日） */
  private _memoIndexTagsDerivedDay: string | undefined;
  private _scheduleIndexTagsDerivedDay: string | undefined;

  constructor(leaf: WorkspaceLeaf, plugin: RSLattePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_TASKS; }
  getDisplayText(): string { return "任务管理"; }
  getIcon(): string { return "check-square"; }

  async onOpen() {
    // v26：不再使用侧边栏内部 timer；统一由 main.ts 的 autoRefreshIndexIntervalMin 驱动。
    this.resetReminderCollapsedToDefault();
    this._subTab = "memo";
    void this.requestRender();
  }

  async onClose() {
    this.resetReminderCollapsedToDefault();
  }

  private resetReminderCollapsedToDefault(): void {
    this._reminderCollapsed = {
      reminderTodayFocus: false,
      reminderOverdue: false,
      reminderActiveOther: true,
      reminderRecentClosed: true,
    };
  }

  private getReminderCollapsed(id: string, defaultCollapsed: boolean): boolean {
    if (!(id in this._reminderCollapsed)) this._reminderCollapsed[id] = defaultCollapsed;
    return !!this._reminderCollapsed[id];
  }

  private setReminderCollapsed(id: string, collapsed: boolean): void {
    this._reminderCollapsed[id] = !!collapsed;
  }

  /** 获取当前 view 所在的滚动容器（侧栏内实际发生滚动的祖先节点） */
  private getScrollContainer(): HTMLElement | null {
    let p: HTMLElement | null = this.containerEl.parentElement;
    while (p) {
      const style = getComputedStyle(p);
      const oy = style.overflowY;
      if (oy === "auto" || oy === "scroll" || oy === "overlay") return p;
      p = p.parentElement;
    }
    const leaf = this.containerEl.closest(".workspace-leaf-content") as HTMLElement | null;
    return leaf;
  }

  public refresh(opts?: { saveScrollPosition?: boolean }) {
    if (opts?.saveScrollPosition) {
      const el = this.getScrollContainer();
      if (el && el.scrollHeight > el.clientHeight) this._savedScrollTop = el.scrollTop;
    }
    void this.requestRender();
  }

  private async manualRefreshTaskIndexAndMaybeSync(): Promise<void> {
    await runExecutionFlowUi(this.plugin, EXECUTION_RECIPE.panelRefreshTaskOnly, { sync: false }, { actionLabel: "刷新任务索引" });
  }

  private async manualRefreshMemoIndexAndMaybeSync(): Promise<void> {
    await runExecutionFlowUi(this.plugin, EXECUTION_RECIPE.panelRefreshMemoOnly, { sync: false }, { actionLabel: "刷新提醒索引" });
  }

  private async manualRefreshScheduleIndexAndMaybeSync(): Promise<void> {
    await runExecutionFlowUi(this.plugin, EXECUTION_RECIPE.panelRefreshScheduleOnly, { sync: false }, { actionLabel: "刷新日程索引" });
  }

  /** Coalesce multiple refresh requests to avoid UI blinking. */
  private async requestRender() {
    if (this._renderPromise) {
      this._pendingRender = true;
      return;
    }
    this._renderPromise = this.render().finally(() => {
      this._renderPromise = null;
    });
    await this._renderPromise;

    if (this._pendingRender) {
      this._pendingRender = false;
      // small delay so the UI doesn't flash twice in quick succession
      window.setTimeout(() => void this.requestRender(), 150);
    }
  }

  private async render() {
    const seq = ++this._renderSeq;

    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();

    // Step E1：模块开关（UI 优先读取 settings.moduleEnabledV2，避免与 legacy 合并逻辑串扰）
    
    const normalizeBool = (v: any, fallback: boolean): boolean => {
      if (v === true || v === "true" || v === 1 || v === "1") return true;
      if (v === false || v === "false" || v === 0 || v === "0") return false;
      if (typeof v === "boolean") return v;
      return fallback;
    };

const me2: any = (this.plugin.settings as any)?.moduleEnabledV2 ?? {};
    const taskEnabled = normalizeBool(me2.task, this.plugin.isPipelineModuleEnabled("task"));
    const memoEnabled = normalizeBool(me2.memo, this.plugin.isPipelineModuleEnabled("memo"));
    const scheduleEnabled = normalizeBool(me2.schedule, memoEnabled);
    if (!taskEnabled && !memoEnabled && !scheduleEnabled) {
      // 两个模块都关闭时：不渲染，并丢弃已保存的滚动位置
      this._savedScrollTop = null;
      return;
    }

    const availableTabs: TaskSubTab[] = [];
    if (memoEnabled) availableTabs.push("memo");
    if (scheduleEnabled) availableTabs.push("schedule");
    if (taskEnabled) availableTabs.push("task");
    if (!availableTabs.includes(this._subTab)) this._subTab = availableTabs[0] ?? "memo";

    const tabs = container.createDiv({ cls: "rslatte-task-subtabs" });
    const renderTab = (id: TaskSubTab, label: string) => {
      if (!availableTabs.includes(id)) return;
      const btn = tabs.createEl("button", { text: label, cls: "rslatte-task-subtab" });
      if (this._subTab === id) btn.addClass("is-active");
      btn.onclick = () => {
        if (this._subTab === id) return;
        this._subTab = id;
        void this.requestRender();
      };
    };
    renderTab("memo", "事项提醒");
    renderTab("schedule", "日程安排");
    renderTab("task", "任务清单");

    // NOTE(UI): 不再展示模块级“任务管理”标题行；直接以“事项提醒 / 任务清单”等分区标题作为顶层。

    const panel = this.plugin.settings.taskPanel;

    // =========================
    // 事项提醒
    // 规则：memo 模块关闭时，此分区完全不渲染（不显示“模块已关闭”空壳）。
    // =========================
    if (memoEnabled && this._subTab === "memo") {
      const upcomingDays = Math.max(1, Math.min(30, Number(panel?.reminderUpcomingDays ?? 5) || 5));
      const recentClosedDays = Math.max(7, Math.min(100, Number((panel as any)?.recentClosedMemoWindowDays ?? 30) || 30));
      // NOTE(UI): 为与“任务清单”标题对齐，事项提醒分区不使用 rslatte-section 的左右 padding。
      const reminderHeaderSection = container.createDiv({ cls: "rslatte-section" });
      const { left: reminderLeft, right: reminderActions } = createHeaderRow(
        reminderHeaderSection,
        "rslatte-section-title-row",
        "rslatte-section-title-left",
        "rslatte-task-actions",
      );
      reminderLeft.createEl("h3", { text: "⏰ 事项提醒" });
      // Step6-5.5.3：状态灯放到右侧 actions 区，方便后续在灯右侧贴归档/刷新按钮
      const memoInd = this.plugin.getDbSyncIndicator?.("memo");
      const memoBtnVis = getUiHeaderButtonsVisibility(this.plugin.settings, "memo");
      const addMemoBtn = reminderActions.createEl("button", { text: "➕", cls: "rslatte-icon-btn" });
      addMemoBtn.title = "新增提醒（写入今日日记）";
      addMemoBtn.onclick = () => new AddMemoModal(this.app, this.plugin).open();

      // status light + right-aligned actions
      appendDbSyncIndicator(reminderLeft, memoInd);

      if (memoBtnVis.rebuild) {
        const memoRebuildBtn = reminderActions.createEl("button", { text: "🧱", cls: "rslatte-icon-btn" });
              memoRebuildBtn.title = "扫描重建提醒索引（全量）";
              memoRebuildBtn.onclick = async () => {
                const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "memo", "rebuild");
                if (!r.ok) {
                  new Notice(`重建失败：${r.error.message}`);
                  return;
                }
                if (!r.data.skipped) new Notice("提醒索引已重建");
                this.refresh();
              };
      }

      if (memoBtnVis.archive) {
        const memoArchiveBtn = reminderActions.createEl("button", { text: "🗄", cls: "rslatte-icon-btn" });
              memoArchiveBtn.title = "索引归档：提醒（按阈值将已闭环条目的索引迁入 archive 分片）";
              memoArchiveBtn.onclick = async () => {
                const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "memo", "manual_archive");
                if (!r.ok) {
                  new Notice(`提醒归档失败：${r.error.message}`);
                  return;
                }
                if (r.data.skipped) return;

                const ui = normalizeRunSummaryForUi(r.data);
                const n = ui.archivedCount;
                const cutoff = ui.cutoffDate;
                if (n > 0) new Notice(`提醒索引归档：${n} 条（< ${cutoff}）`);
                else new Notice(`提醒无可索引归档条目（阈值 < ${cutoff}）`);

                this.refresh();
              };
      }

      if (memoBtnVis.refresh) {
        const memoRefreshBtn = reminderActions.createEl("button", { text: "🔄", cls: "rslatte-icon-btn" });
        memoRefreshBtn.title = "提醒手动刷新（manual_refresh：增量写索引与 DB；门控通过时可 reconcile）";
        memoRefreshBtn.onclick = async () => {
          const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "memo", "manual_refresh");
          if (!r.ok) {
            new Notice(`刷新失败：${r.error.message}`);
            return;
          }
          if (!r.data.skipped) new Notice("提醒索引已刷新");
          this.refresh();
        };
      }
      const reminderSec = container.createDiv({ cls: "rslatte-section rslatte-task-section rslatte-expanded" });
      const memoWrap = reminderSec.createDiv({ cls: "rslatte-task-list" });
      const renderReminderGroups = (
        groups: { todayFocus: RSLatteIndexItem[]; overdue: RSLatteIndexItem[]; activeOther: RSLatteIndexItem[]; recentClosed: RSLatteIndexItem[] },
        recentDays: number,
        suffixText?: string
      ) => {
        memoWrap.empty();
        const makeGroup = (title: string, items: RSLatteIndexItem[], renderer: (wrap: HTMLElement, rows: RSLatteIndexItem[]) => void, emptyText: string) => {
          const id = title === "今日关注"
            ? "reminderTodayFocus"
            : title === "已超期"
              ? "reminderOverdue"
              : title === "活跃条目"
                ? "reminderActiveOther"
                : "reminderRecentClosed";
          const defaultCollapsed = id === "reminderActiveOther" || id === "reminderRecentClosed";
          const collapsed = this.getReminderCollapsed(id, defaultCollapsed);
          const sec = memoWrap.createDiv({
            cls: collapsed
              ? "rslatte-section rslatte-task-section"
              : "rslatte-section rslatte-task-section rslatte-expanded",
          });
          sec.dataset.sectionId = id;
          const titleRow = sec.createDiv({ cls: "rslatte-task-cat-title rslatte-collapsible-head" });
          const left = titleRow.createDiv({ cls: "rslatte-task-cat-left" });
          left.createEl("span", { cls: "rslatte-collapse-arrow", text: collapsed ? "▸" : "▾" });
          left.createEl("h4", { text: title });
          titleRow.createDiv({ cls: "rslatte-task-cat-meta" }).setText(String(items.length));
          titleRow.onclick = (ev) => {
            ev.stopPropagation();
            const next = !this.getReminderCollapsed(id, defaultCollapsed);
            this.setReminderCollapsed(id, next);
            sec.toggleClass("rslatte-expanded", !next);
            const arrow = sec.querySelector(".rslatte-collapse-arrow");
            if (arrow) arrow.setText(next ? "▸" : "▾");
          };
          const listWrap = sec.createDiv({ cls: "rslatte-task-list" });
          if (!items.length) {
            listWrap.createDiv({ cls: "rslatte-task-empty", text: emptyText });
            return;
          }
          renderer(listWrap, items);
        };
        makeGroup("今日关注", groups.todayFocus ?? [], (wrap, rows) => this.renderReminderFlatTimeline(wrap, rows), "（无今日/即将到期提醒）");
        makeGroup("已超期", groups.overdue ?? [], (wrap, rows) => this.renderMemoAllTimeline(wrap, rows), "（无超期提醒）");
        makeGroup("活跃条目", groups.activeOther ?? [], (wrap, rows) => this.renderMemoAllTimeline(wrap, rows), "（无其他活跃提醒）");
        makeGroup(`近期完成/取消/失效（${recentDays}天）`, groups.recentClosed ?? [], (wrap, rows) => this.renderRecentClosedMemoTimeline(wrap, rows), "（近期无完成/取消/失效提醒）");
        if (suffixText) {
          memoWrap.createDiv({ cls: "rslatte-task-empty", text: suffixText });
        }
      };
      // 先同步渲染骨架，确保四个分组标题总是可见
      renderReminderGroups(
        { todayFocus: [], overdue: [], activeOther: [], recentClosed: [] },
        recentClosedDays,
        "加载中…"
      );
      try {
        const groups = await Promise.race([
          this.queryReminderBucketsSafe(upcomingDays, recentClosedDays),
          new Promise<never>((_, reject) =>
            window.setTimeout(() => reject(new Error("事项提醒加载超时（请检查索引刷新/文件量是否过大）")), 15_000)
          ),
        ]);
        if (seq !== this._renderSeq) {
          this._savedScrollTop = null;
          return;
        }
        const tr = this.plugin.taskRSLatte as any;
        if (tr && typeof tr.getMemoIndexTagsDerivedDay === "function") {
          this._memoIndexTagsDerivedDay = await tr.getMemoIndexTagsDerivedDay();
        } else {
          this._memoIndexTagsDerivedDay = undefined;
        }
        renderReminderGroups(groups, recentClosedDays);
      } catch (e: any) {
        console.warn("[RSLatte][TaskSidePanel][reminders] render groups failed", e);
        try { new Notice(`事项提醒加载失败：${e?.message ?? String(e)}`); } catch {}
        renderReminderGroups(
          { todayFocus: [], overdue: [], activeOther: [], recentClosed: [] },
          recentClosedDays,
          `加载失败：${e?.message ?? String(e)}`
        );
      }
    }

    // =========================
    // 日程安排（扫描 memo 行后由 schedule pipeline 按 isScheduleMemoLine 分桶写入 schedule-index）
    // =========================
    if (scheduleEnabled && this._subTab === "schedule") {
      const upcomingDays = Math.max(1, Math.min(30, Number((panel as any)?.scheduleUpcomingDays ?? 5) || 5));
      const recentClosedDays = Math.max(7, Math.min(100, Number((panel as any)?.scheduleRecentClosedDays ?? 30) || 30));
      const scheduleHeaderSection = container.createDiv({ cls: "rslatte-section" });
      const { left: scheduleLeft, right: scheduleActions } = createHeaderRow(
        scheduleHeaderSection,
        "rslatte-section-title-row",
        "rslatte-section-title-left",
        "rslatte-task-actions",
      );
      scheduleLeft.createEl("h3", { text: "📅 日程安排" });
      const scheduleInd = this.plugin.getDbSyncIndicator?.("schedule" as any);
      const scheduleBtnVis = getUiHeaderButtonsVisibility(this.plugin.settings, "schedule" as any);
      const addBtn = scheduleActions.createEl("button", { text: "➕", cls: "rslatte-icon-btn" });
      addBtn.title = "新增日程";
      addBtn.onclick = () => new AddScheduleModal(this.app, this.plugin).open();
      appendDbSyncIndicator(scheduleLeft, scheduleInd);

      if (scheduleBtnVis.rebuild) {
        const rebuildBtn = scheduleActions.createEl("button", { text: "🧱", cls: "rslatte-icon-btn" });
        rebuildBtn.title = "扫描重建日程索引（全量）";
        rebuildBtn.onclick = async () => {
          const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "schedule" as any, "rebuild");
          if (!r.ok) {
            new Notice(`重建失败：${r.error.message}`);
            return;
          }
          if (!r.data.skipped) new Notice("日程索引已重建");
          this.refresh();
        };
      }
      if (scheduleBtnVis.archive) {
        const archiveBtn = scheduleActions.createEl("button", { text: "🗄", cls: "rslatte-icon-btn" });
        archiveBtn.title = "日程归档（按阈值归档已闭环日程）";
        archiveBtn.onclick = async () => {
          const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "schedule" as any, "manual_archive");
          if (!r.ok) {
            new Notice(`日程归档失败：${r.error.message}`);
            return;
          }
          if (!r.data.skipped) new Notice("日程索引归档已执行");
          this.refresh();
        };
      }
      if (scheduleBtnVis.refresh) {
        const refreshBtn = scheduleActions.createEl("button", { text: "🔄", cls: "rslatte-icon-btn" });
        refreshBtn.title = "日程手动刷新（manual_refresh：增量写索引；门控通过时可 reconcile）";
        refreshBtn.onclick = async () => {
          const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "schedule" as any, "manual_refresh");
          if (!r.ok) {
            new Notice(`刷新失败：${r.error.message}`);
            return;
          }
          if (!r.data.skipped) new Notice("日程索引已刷新");
          this.refresh();
        };
      }

      const sec = container.createDiv({ cls: "rslatte-section rslatte-task-section rslatte-expanded" });
      const wrap = sec.createDiv({ cls: "rslatte-task-list" });
      try {
        const groups = await this.queryScheduleBucketsSafe(upcomingDays, recentClosedDays);
        const trs = this.plugin.taskRSLatte as any;
        if (trs && typeof trs.getScheduleIndexTagsDerivedDay === "function") {
          this._scheduleIndexTagsDerivedDay = await trs.getScheduleIndexTagsDerivedDay();
        } else {
          this._scheduleIndexTagsDerivedDay = undefined;
        }
        const makeGroup = (id: string, title: string, rows: RSLatteIndexItem[], onlyRestore: boolean, empty: string) => {
          const defaultCollapsed = id === "scheduleActiveOther" || id === "scheduleRecentClosed";
          const collapsed = this.getReminderCollapsed(id, defaultCollapsed);
          const groupSec = wrap.createDiv({ cls: collapsed ? "rslatte-section rslatte-task-section" : "rslatte-section rslatte-task-section rslatte-expanded" });
          const head = groupSec.createDiv({ cls: "rslatte-task-cat-title rslatte-collapsible-head" });
          const left = head.createDiv({ cls: "rslatte-task-cat-left" });
          left.createEl("span", { cls: "rslatte-collapse-arrow", text: collapsed ? "▸" : "▾" });
          left.createEl("h4", { text: title });
          head.createDiv({ cls: "rslatte-task-cat-meta" }).setText(String(rows.length));
          head.onclick = () => {
            const next = !this.getReminderCollapsed(id, defaultCollapsed);
            this.setReminderCollapsed(id, next);
            groupSec.toggleClass("rslatte-expanded", !next);
            const arrow = groupSec.querySelector(".rslatte-collapse-arrow");
            if (arrow) arrow.setText(next ? "▸" : "▾");
          };
          const list = groupSec.createDiv({ cls: "rslatte-task-list" });
          if (!rows.length) {
            list.createDiv({ cls: "rslatte-task-empty", text: empty });
            return;
          }
          if (onlyRestore) this.renderRecentClosedScheduleTimeline(list, rows);
          else this.renderScheduleAllTimeline(list, rows);
        };
        makeGroup("scheduleToday", "今日安排", groups.todayFocus ?? [], false, "（无今日日程）");
        makeGroup("scheduleUpcoming", "近期日程安排", groups.upcoming ?? [], false, "（无即将到期日程）");
        makeGroup("scheduleOverdue", "已超期", groups.overdue ?? [], false, "（无超期日程）");
        makeGroup("scheduleActiveOther", "活跃条目", groups.activeOther ?? [], false, "（无其他活跃日程）");
        makeGroup("scheduleRecentClosed", `近期完成/取消/失效（${recentClosedDays}天）`, groups.recentClosed ?? [], true, "（近期无闭环日程）");
      } catch (e: any) {
        wrap.createDiv({ cls: "rslatte-task-empty", text: `日程加载失败：${e?.message ?? String(e)}` });
      }
    }

    // 事项提醒已升级为四分组清单，替代旧“全量提醒清单”渲染入口。

    // =========================
    // 任务清单（task 模块关闭时完全不渲染）
    // =========================
    if (!taskEnabled || this._subTab !== "task") {
      // task off: do not render any task section.
      return;
    }

    const taskHeaderSection = container.createDiv({ cls: "rslatte-section" });
    // 任务清单标题（✅动作按钮放这里：从左到右为 新增 → 归档 → 刷新，整体靠右）
    const { left: listLeft, right: listActions } = createHeaderRow(
      taskHeaderSection,
      "rslatte-section-title-row",
      "rslatte-section-title-left",
      "rslatte-task-actions",
    );
    listLeft.createEl("h3", { text: "🗂 任务清单" });
    // Step6-5.5.3：状态灯放到右侧 actions 区，后续在灯右侧贴归档/刷新按钮
    const taskInd = this.plugin.getDbSyncIndicator?.("task");
    const taskBtnVis = getUiHeaderButtonsVisibility(this.plugin.settings, "task");
    const addTaskBtn = listActions.createEl("button", { text: "➕", cls: "rslatte-icon-btn" });
    addTaskBtn.title = "新增任务（写入今日日记）";
    addTaskBtn.onclick = () => new AddTaskModal(this.app, this.plugin).open();

    appendDbSyncIndicator(listLeft, taskInd);

    if (taskBtnVis.rebuild) {
      const rebuildBtn = listActions.createEl("button", { text: "🧱", cls: "rslatte-icon-btn" });
      rebuildBtn.title = "扫描重建任务索引（全量）";
      rebuildBtn.onclick = async () => {
        const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "task", "rebuild");
        if (!r.ok) {
          new Notice(`重建失败：${r.error.message}`);
          return;
        }
        if (!r.data.skipped) new Notice("任务索引已重建");
        this.refresh();
      };
    }

    if (taskBtnVis.archive) {
      const archiveBtn = listActions.createEl("button", { text: "🗄", cls: "rslatte-icon-btn" });
      archiveBtn.title = "索引归档：任务（按阈值将已闭环条目的索引迁入 archive 分片；笔记仍在日记中）";
      archiveBtn.onclick = async () => {
        const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "task", "manual_archive");
        if (!r.ok) {
          new Notice(`任务归档失败：${r.error.message}`);
          return;
        }
        if (r.data.skipped) return;

        const ui = normalizeRunSummaryForUi(r.data);
        const n = ui.archivedCount;
        const cutoff = ui.cutoffDate;
        if (n > 0) new Notice(`任务索引归档：${n} 条（< ${cutoff}）`);
        else new Notice(`任务无可索引归档条目（阈值 < ${cutoff}）`);

        this.refresh();
      };
    }

    if (taskBtnVis.refresh) {
      const refreshBtn = listActions.createEl("button", { text: "🔄", cls: "rslatte-icon-btn" });
      refreshBtn.title = "任务手动刷新（manual_refresh：增量写索引与 DB；门控通过时可 reconcile）";
      refreshBtn.onclick = async () => {
        const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "task", "manual_refresh");
        if (!r.ok) {
          new Notice(`刷新失败：${r.error.message}`);
          return;
        }
        if (!r.data.skipped) new Notice("任务索引已刷新");
        this.refresh();
      };
    }

    // 第十二节：固定分区任务清单（1 重点关注 → 2 今日处理 → 3 其他活跃 → 4 近期闭环）
    let listsData: Awaited<ReturnType<typeof this.plugin.taskRSLatte.getTaskListsForSidePanel>>;
    try {
      listsData = await this.plugin.taskRSLatte.getTaskListsForSidePanel();
    } catch (e: any) {
      container.createDiv({ cls: "rslatte-task-empty", text: `加载失败：${e?.message ?? String(e)}` });
      this._savedScrollTop = null;
      return;
    }
    if (seq !== this._renderSeq) {
      this._savedScrollTop = null;
      return;
    }

    const focusTopN = Math.min(10, Math.max(3, Number((panel as any)?.focusTopN ?? 3) || 3));
    const collapsedLists = (panel as any)?.collapsedLists ?? {};
    const getCollapsed = (id: string, defaultCollapsed: boolean) =>
      collapsedLists[id] !== undefined ? !!collapsedLists[id] : defaultCollapsed;
    const toggleCollapsed = async (id: string) => {
      const tp: any = (this.plugin.settings as any)?.taskPanel ?? {};
      tp.collapsedLists = tp.collapsedLists ?? {};
      const nextCollapsed = !tp.collapsedLists[id];
      tp.collapsedLists[id] = nextCollapsed;
      await this.plugin.saveSettings();
      // 仅切换 DOM，不 refresh()，避免侧栏滚动回顶
      const cont = this.containerEl.children[1] as HTMLElement;
      const sec = cont.querySelector(`[data-section-id="${id}"]`) as HTMLElement | null;
      if (sec) {
        sec.toggleClass("rslatte-expanded", !nextCollapsed);
        const arrow = sec.querySelector(".rslatte-collapse-arrow");
        if (arrow) arrow.setText(nextCollapsed ? "▸" : "▾");
      } else {
        this.refresh();
      }
    };

    // 1）重点关注（不允许折叠）
    const focusSec = container.createDiv({ cls: "rslatte-section rslatte-task-section rslatte-expanded" });
    const focusTitleRow = focusSec.createDiv({ cls: "rslatte-task-cat-title rslatte-collapsible-head" });
    focusTitleRow.createDiv({ cls: "rslatte-task-cat-left" }).createEl("h4", { text: "⭐ 重点关注" });
    const focusMeta = focusTitleRow.createDiv({ cls: "rslatte-task-cat-meta" });
    focusMeta.setText(`重要性 Top ${focusTopN}`);
    const focusListWrap = focusSec.createDiv({ cls: "rslatte-task-list" });
    if (listsData.focus.length === 0) {
      focusListWrap.createDiv({ cls: "rslatte-task-empty", text: "（暂无候选任务）" });
    } else {
      this.renderTimeline(focusListWrap, listsData.focus, "due", { flat: true });
    }

    // 2）今日处理清单（默认展开，子清单互斥）
    const TODAY_SUB_IDS = ["todayAction", "todayFollowUp", "overdue", "otherRisk"] as const;
    const setTodaySectionsCollapsed = async (collapsed: boolean) => {
      const tp: any = (this.plugin.settings as any)?.taskPanel ?? {};
      tp.collapsedLists = tp.collapsedLists ?? {};
      for (const id of TODAY_SUB_IDS) tp.collapsedLists[id] = collapsed;
      await this.plugin.saveSettings();
      const cont = this.containerEl.children[1] as HTMLElement;
      for (const id of TODAY_SUB_IDS) {
        const sec = cont.querySelector(`[data-section-id="${id}"]`) as HTMLElement | null;
        if (sec) {
          sec.toggleClass("rslatte-expanded", !collapsed);
          const arrow = sec.querySelector(".rslatte-collapse-arrow");
          if (arrow) arrow.setText(collapsed ? "▸" : "▾");
        }
      }
    };
    const todaySec = container.createDiv({ cls: "rslatte-section rslatte-task-section rslatte-expanded" });
    const todayTitleRow = todaySec.createDiv({ cls: "rslatte-task-cat-title" });
    todayTitleRow.createDiv({ cls: "rslatte-task-cat-left" }).createEl("h4", { text: "今日处理清单" });
    const todayActions = todayTitleRow.createDiv({ cls: "rslatte-task-cat-actions" });
    const expandAllBtn = todayActions.createEl("button", { text: "全部展开", cls: "rslatte-icon-btn" });
    expandAllBtn.onclick = (e) => {
      e.stopPropagation();
      void setTodaySectionsCollapsed(false);
    };
    const collapseAllBtn = todayActions.createEl("button", { text: "全部折叠", cls: "rslatte-icon-btn" });
    collapseAllBtn.onclick = (e) => {
      e.stopPropagation();
      void setTodaySectionsCollapsed(true);
    };

    const renderSubList = (
      parent: HTMLElement,
      id: string,
      title: string,
      items: RSLatteIndexItem[],
      sortField: string,
      defaultCollapsed: boolean,
      timelineOpts?: { flat?: boolean; noYear?: boolean }
    ) => {
      const collapsed = getCollapsed(id, defaultCollapsed);
      const sec = parent.createDiv({
        cls: collapsed ? "rslatte-section rslatte-task-section" : "rslatte-section rslatte-task-section rslatte-expanded",
      });
      sec.dataset.sectionId = id;
      const titleRow = sec.createDiv({ cls: "rslatte-task-cat-title rslatte-collapsible-head" });
      const left = titleRow.createDiv({ cls: "rslatte-task-cat-left" });
      left.createEl("span", { cls: "rslatte-collapse-arrow", text: collapsed ? "▸" : "▾" });
      left.createEl("h4", { text: title });
      const meta = titleRow.createDiv({ cls: "rslatte-task-cat-meta" });
      meta.setText(String(items.length));
      titleRow.onclick = () => void toggleCollapsed(id);
      const listWrap = sec.createDiv({ cls: "rslatte-task-list" });
      if (items.length === 0) {
        listWrap.createDiv({ cls: "rslatte-task-empty", text: "（无）" });
      } else {
        this.renderTimeline(listWrap, items, sortField, timelineOpts);
      }
    };

    renderSubList(todaySec, "todayAction", "今日行动", listsData.todayAction, "due", false, { flat: true });
    renderSubList(todaySec, "todayFollowUp", "今日跟进", listsData.todayFollowUp, "due", false, { flat: true });
    renderSubList(todaySec, "overdue", "超期/即将超期", listsData.overdue, "due", false, { noYear: true });
    renderSubList(todaySec, "otherRisk", "其他风险", listsData.otherRisk, "due", false, { noYear: true });

    // 3）其他活跃清单（默认收起）
    const otherSec = container.createDiv({ cls: "rslatte-section rslatte-task-section" });
    otherSec.dataset.sectionId = "otherActive";
    const otherCollapsed = getCollapsed("otherActive", true);
    if (!otherCollapsed) otherSec.addClass("rslatte-expanded");
    const otherTitleRow = otherSec.createDiv({ cls: "rslatte-task-cat-title rslatte-collapsible-head" });
    const otherLeft = otherTitleRow.createDiv({ cls: "rslatte-task-cat-left" });
    otherLeft.createEl("span", { cls: "rslatte-collapse-arrow", text: otherCollapsed ? "▸" : "▾" });
    otherLeft.createEl("h4", { text: "其他活跃清单" });
    otherTitleRow.createDiv({ cls: "rslatte-task-cat-meta" }).setText(String(listsData.otherActive.length));
    otherTitleRow.onclick = () => void toggleCollapsed("otherActive");
    const otherListWrap = otherSec.createDiv({ cls: "rslatte-task-list" });
    if (listsData.otherActive.length === 0) {
      otherListWrap.createDiv({ cls: "rslatte-task-empty", text: "（无）" });
    } else {
      this.renderTimeline(otherListWrap, listsData.otherActive, "due", { noYear: true });
    }

    // 4）近期闭环（默认展开）
    const CLOSED_SUB_IDS = ["closedCancelled", "closedDone"] as const;
    const setClosedSectionsCollapsed = async (collapsed: boolean) => {
      const tp: any = (this.plugin.settings as any)?.taskPanel ?? {};
      tp.collapsedLists = tp.collapsedLists ?? {};
      for (const id of CLOSED_SUB_IDS) tp.collapsedLists[id] = collapsed;
      await this.plugin.saveSettings();
      const cont = this.containerEl.children[1] as HTMLElement;
      for (const id of CLOSED_SUB_IDS) {
        const sec = cont.querySelector(`[data-section-id="${id}"]`) as HTMLElement | null;
        if (sec) {
          sec.toggleClass("rslatte-expanded", !collapsed);
          const arrow = sec.querySelector(".rslatte-collapse-arrow");
          if (arrow) arrow.setText(collapsed ? "▸" : "▾");
        }
      }
    };
    const closedSec = container.createDiv({ cls: "rslatte-section rslatte-task-section rslatte-expanded" });
    const closedTitleRow = closedSec.createDiv({ cls: "rslatte-task-cat-title" });
    closedTitleRow.createDiv({ cls: "rslatte-task-cat-left" }).createEl("h4", { text: "近期闭环" });
    const closedActions = closedTitleRow.createDiv({ cls: "rslatte-task-cat-actions" });
    const closedExpandBtn = closedActions.createEl("button", { text: "全部展开", cls: "rslatte-icon-btn" });
    closedExpandBtn.onclick = (e) => {
      e.stopPropagation();
      void setClosedSectionsCollapsed(false);
    };
    const closedCollapseBtn = closedActions.createEl("button", { text: "全部折叠", cls: "rslatte-icon-btn" });
    closedCollapseBtn.onclick = (e) => {
      e.stopPropagation();
      void setClosedSectionsCollapsed(true);
    };
    renderSubList(closedSec, "closedCancelled", "近期取消", listsData.closedCancelled, "cancelled", true, { noYear: true });
    renderSubList(closedSec, "closedDone", "近期完成", listsData.closedDone, "done", true, { noYear: true });

    this.restoreScrollIfSaved();
  }

  /** 渲染结束后恢复之前保存的滚动位置（避免展开/收起清单时侧栏跳回顶部） */
  private restoreScrollIfSaved() {
    const saved = this._savedScrollTop;
    // 若有待执行的合并渲染，保留 _savedScrollTop 供下一次 render 恢复（否则二次 render 会 empty() 导致再次滚到顶部）
    if (!this._pendingRender) this._savedScrollTop = null;
    if (saved == null) return;
    // 双重 rAF 确保在布局/绘制完成后再恢复，避免被重排覆盖
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = this.getScrollContainer();
        if (el) el.scrollTop = saved;
      });
    });
  }

  private renderTimeline(parent: HTMLElement, tasks: RSLatteIndexItem[], sortField: string, opts?: { flat?: boolean; noYear?: boolean }) {
    const wrap = parent.createDiv({ cls: "rslatte-timeline" });

    if (opts?.flat) {
      const itemsWrap = wrap.createDiv({ cls: "rslatte-timeline-day-items" });
      for (const t of tasks) this.renderTimelineItem(itemsWrap, t);
      return;
    }

    let currentYear: string | null = null;
    let currentDay: string | null = null;
    let daySectionEl: HTMLElement | null = null;

    const toDayKey = (iso?: string): string | null => {
      if (!iso) return null;
      // 允许传入 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm:ss...
      const m = String(iso).match(/^(\d{4}-\d{2}-\d{2})/);
      return m ? m[1] : null;
    };

    const pickDateByField = (t: RSLatteIndexItem, field: string): string | null => {
      const anyT: any = t as any;
      switch (field) {
        case "memo": return toDayKey(anyT.memoDate) ?? toDayKey(anyT.memoMmdd);
        case "due": return toDayKey(anyT.planned_end);
        case "start": return toDayKey(anyT.actual_start);
        case "scheduled": return toDayKey(anyT.planned_start);
        case "done": return toDayKey(anyT.done_date);
        case "cancelled": return toDayKey(anyT.cancelled_date);
        case "created": return toDayKey(anyT.created_date);
        default: return toDayKey(anyT.planned_end) ?? toDayKey(anyT.actual_start) ?? toDayKey(anyT.planned_start) ?? toDayKey(anyT.done_date) ?? toDayKey(anyT.created_date);
      }
    };

    const formatDayHeader = (dayKey: string): string => {
      const moment = (window as any).moment;
      if (typeof moment === "function") {
        try {
          const mm = moment(dayKey, "YYYY-MM-DD", true);
          if (mm?.isValid?.()) {
            // 例：2025-12-25（周四）
            return mm.format("YYYY-MM-DD (ddd)");
          }
        } catch { }
      }
      return dayKey;
    };

    const ensureYearHeader = (year: string) => {
      if (currentYear === year) return;
      currentYear = year;
      wrap.createDiv({ cls: "rslatte-timeline-year", text: year });
      // year header 变化时，重置 day
      currentDay = null;
      daySectionEl = null;
    };

    const ensureDaySection = (dayKey: string | null) => {
      const key = dayKey ?? "NO_DATE";
      if (currentDay === key && daySectionEl) return;
      currentDay = key;

      daySectionEl = wrap.createDiv({ cls: "rslatte-timeline-day" });
      const title = daySectionEl.createDiv({ cls: "rslatte-timeline-day-title" });
      title.setText(dayKey ? formatDayHeader(dayKey) : "无日期");
      daySectionEl.createDiv({ cls: "rslatte-timeline-day-items" });
    };

    const noYear = !!opts?.noYear;
    for (const t of tasks) {
      const dayKey = pickDateByField(t, sortField);
      if (dayKey && !noYear) ensureYearHeader(dayKey.slice(0, 4));
      ensureDaySection(dayKey);

      const itemsWrap = daySectionEl!.querySelector<HTMLElement>(".rslatte-timeline-day-items")!;
      this.renderTimelineItem(itemsWrap, t);
    }
  }

  private renderTimelineItem(parent: HTMLElement, t: RSLatteIndexItem) {
    const row = parent.createDiv({ cls: "rslatte-timeline-item" });
    row.tabIndex = 0;
    const pressure = this.getTaskPressureMeta(t);
    if (pressure.level === "overdue") row.addClass("rslatte-task-pressure-overdue");
    else if (pressure.level === "upcoming") row.addClass("rslatte-task-pressure-upcoming");
    else if (pressure.level === "active") row.addClass("rslatte-task-pressure-active");
    // 添加标识属性，用于从其他视图跳转定位（使用规范化路径确保匹配）
    const normalizedFilePath = normalizePath(t.filePath);
    row.setAttribute("data-task-file-path", normalizedFilePath);
    row.setAttribute("data-task-line-no", String(t.lineNo));

    // 左侧时间轴轨道：圆点 + 悬停显示状态名称
    const gutter = row.createDiv({ cls: "rslatte-timeline-gutter" });
    const dot = gutter.createDiv({ cls: "rslatte-timeline-dot" });
    dot.setText(this.statusIcon(t));
    dot.title = this.statusDisplayName(t);
    gutter.createDiv({ cls: "rslatte-timeline-line" });

    // 右侧内容
    const content = row.createDiv({ cls: "rslatte-timeline-content" });

    // title (description)：带首字符标记 ⭐↪🧠🍃（↪=延期，⏳ 仅作计划开始日 token）
    const titleRow = content.createDiv({ cls: "rslatte-timeline-title-row rslatte-task-row" });
    const title = titleRow.createDiv({ cls: "rslatte-timeline-text rslatte-task-title" });
    const displayText = buildDescPrefix({
      starred: !!(t as any).starred,
      postpone_count: (t as any).postpone_count,
      complexity: (t as any).complexity,
    }) + String(t.text ?? "");
    renderTextWithContactRefs(this.app, title, displayText);

    const actionRow = titleRow.createDiv({ cls: "rslatte-task-actions rslatte-task-actions-compact" });

    const refreshAfter = async () => {
      await this.manualRefreshTaskIndexAndMaybeSync();
      this.refresh();
    };

    const taskSt = String((t as any).status ?? "").trim().toUpperCase();
    const isClosedTask = taskSt === "DONE" || taskSt === "CANCELLED";
    const cardButtons: SidePanelCardActionEntry[] = [];
    if (isClosedTask) {
      cardButtons.push({
        id: "task_restore",
        kind: "icon",
        icon: "♻️",
        title: "恢复（与原“开始处理任务”一致）",
        run: async () => {
          new TaskProgressModal(this.app, this.plugin, t, "start", refreshAfter).open();
        },
      });
    } else {
      cardButtons.push({
        id: "task_edit",
        kind: "icon",
        icon: "✏️",
        title: "修改任务信息",
        run: async () => {
          new EditTaskModal(this.app, this.plugin, t).open();
        },
      });

      for (const btn of this.taskActionButtons(t)) {
        if (btn.icon === "▶") {
          cardButtons.push({
            id: "task_start",
            kind: "icon",
            icon: "▶",
            title: btn.title,
            run: async () => {
              new TaskProgressModal(this.app, this.plugin, t, "start", refreshAfter).open();
            },
          });
        } else if (btn.icon === "↻") {
          cardButtons.push({
            id: "task_wait_others",
            kind: "icon",
            icon: "↻",
            title: btn.title,
            run: async () => {
              new TaskProgressModal(this.app, this.plugin, t, "waiting_others", refreshAfter).open();
            },
          });
        } else if (btn.icon === "⏸") {
          if (btn.mode === "pause") {
            cardButtons.push({
              id: "task_wait_until",
              kind: "icon",
              icon: "⏸",
              title: btn.title,
              run: async () => {
                await writeTaskApplyStatus(this.plugin.taskRSLatte, t, "TODO", { skipWorkEvent: true });
                const phPauseBefore = indexItemTaskDisplayPhase(t as any);
                await this.appendUiWorkEvent({
                  kind: "task",
                  action: "paused",
                  summary: `⏸ 任务暂停 ${String(t.text ?? t.raw ?? "").trim() || "未命名任务"}`,
                  ref: {
                    uid: (t as any).uid,
                    file_path: t.filePath,
                    line_no: t.lineNo,
                    to: "TODO",
                    task_phase_before: phPauseBefore,
                    task_phase_after: displayPhaseAfterTaskCheckbox("TODO"),
                  },
                  taskContactEnrich: {
                    taskLine: String((t as any).raw ?? t.text ?? ""),
                    followContactUids: Array.isArray((t as any).follow_contact_uids)
                      ? (t as any).follow_contact_uids.map((x: string) => String(x ?? "").trim()).filter(Boolean)
                      : [],
                  },
                });
                await refreshAfter();
              },
            });
          } else {
            cardButtons.push({
              id: "task_wait_until",
              kind: "icon",
              icon: "⏸",
              title: btn.title,
              run: async () => {
                new TaskProgressModal(this.app, this.plugin, t, "waiting_until", refreshAfter).open();
              },
            });
          }
        } else if (btn.icon === "⛔") {
          cardButtons.push({
            id: "task_cancel",
            kind: "icon",
            icon: "⛔",
            title: btn.title,
            run: async () => {
              await writeTaskApplyStatus(this.plugin.taskRSLatte, t, "CANCELLED", { skipWorkEvent: true });
              const phCancelBefore = indexItemTaskDisplayPhase(t as any);
              await this.appendUiWorkEvent({
                kind: "task",
                action: "cancelled",
                summary: `⛔ 任务取消 ${String(t.text ?? t.raw ?? "").trim() || "未命名任务"}`,
                ref: {
                  uid: (t as any).uid,
                  file_path: t.filePath,
                  line_no: t.lineNo,
                  to: "CANCELLED",
                  task_phase_before: phCancelBefore,
                  task_phase_after: displayPhaseAfterTaskCheckbox("CANCELLED"),
                },
                metrics: { status: "CANCELLED" },
                taskContactEnrich: {
                  taskLine: String((t as any).raw ?? t.text ?? ""),
                  followContactUids: Array.isArray((t as any).follow_contact_uids)
                    ? (t as any).follow_contact_uids.map((x: string) => String(x ?? "").trim()).filter(Boolean)
                    : [],
                },
              });
              await refreshAfter();
            },
          });
        } else if (btn.icon === "✅") {
          cardButtons.push({
            id: "task_done",
            kind: "icon",
            icon: "✅",
            title: btn.title,
            run: async () => {
              new TaskProgressModal(this.app, this.plugin, t, "done", refreshAfter).open();
            },
          });
        } else if (btn.icon === "↪") {
          cardButtons.push({
            id: "task_postpone",
            kind: "icon",
            icon: "↪",
            title: btn.title,
            run: async () => {
              new TaskProgressModal(this.app, this.plugin, t, "postpone", refreshAfter).open();
            },
          });
        } else if (btn.icon === "⭐") {
          cardButtons.push({
            id: "task_star",
            kind: "icon",
            icon: "⭐",
            title: btn.title,
            run: async () => {
              await writeTaskSetStarred(this.plugin.taskRSLatte, t as any, true);
              const phStar = indexItemTaskDisplayPhase(t as any);
              await this.appendUiWorkEvent({
                kind: "task",
                action: "update",
                summary: `⭐ 星标任务 ${String(t.text ?? t.raw ?? "").trim() || "未命名任务"}`,
                ref: {
                  uid: (t as any).uid,
                  file_path: t.filePath,
                  line_no: t.lineNo,
                  starred: true,
                  task_phase_before: phStar,
                  task_phase_after: phStar,
                },
                taskContactEnrich: {
                  taskLine: String((t as any).raw ?? t.text ?? ""),
                  followContactUids: Array.isArray((t as any).follow_contact_uids)
                    ? (t as any).follow_contact_uids.map((x: string) => String(x ?? "").trim()).filter(Boolean)
                    : [],
                },
              });
              await refreshAfter();
            },
          });
        } else if (btn.icon === "☆") {
          cardButtons.push({
            id: "task_star",
            kind: "icon",
            icon: "☆",
            title: btn.title,
            run: async () => {
              await writeTaskSetStarred(this.plugin.taskRSLatte, t as any, false);
              const phUnstar = indexItemTaskDisplayPhase(t as any);
              await this.appendUiWorkEvent({
                kind: "task",
                action: "update",
                summary: `☆ 取消星标任务 ${String(t.text ?? t.raw ?? "").trim() || "未命名任务"}`,
                ref: {
                  uid: (t as any).uid,
                  file_path: t.filePath,
                  line_no: t.lineNo,
                  starred: false,
                  task_phase_before: phUnstar,
                  task_phase_after: phUnstar,
                },
                taskContactEnrich: {
                  taskLine: String((t as any).raw ?? t.text ?? ""),
                  followContactUids: Array.isArray((t as any).follow_contact_uids)
                    ? (t as any).follow_contact_uids.map((x: string) => String(x ?? "").trim()).filter(Boolean)
                    : [],
                },
              });
              await refreshAfter();
            },
          });
        }
      }
    }

    if (!isClosedTask && taskSt === "IN_PROGRESS") {
      cardButtons.push({
        id: "task_record_schedule",
        kind: "icon",
        icon: "📅",
        title: "录日程（关联到本任务，不改变任务状态）",
        run: async () => {
          new RecordTaskScheduleModal(this.app, this.plugin, { kind: "task", taskItem: t }, async () => {
            this.refresh();
          }).open();
        },
      });
    }

    this.mountSidePanelCardActions(actionRow, cardButtons, this.getMoreIdsForSidePanelCard("task"));

    const followRowInfo = this.buildFollowRowInfo(t);
    if (followRowInfo) {
      const followRow = content.createDiv({ cls: "rslatte-task-follow-row" });
      const phrasePrefix = followRowInfo.phase === "waiting_until" ? "等待" : "跟进";
      followRow.createSpan({ cls: "rslatte-task-follow-label", text: phrasePrefix });
      const contactsEl = followRow.createSpan({ cls: "rslatte-task-follow-contacts" });
      renderTextWithContactRefs(this.app, contactsEl, followRowInfo.contactsText);
      followRow.createSpan({ cls: "rslatte-task-follow-status", text: "处理中" });
      followRow.createSpan({ cls: "rslatte-task-follow-date", text: ` · ${followRowInfo.dateLabel}：${followRowInfo.dateValue}` });
    }

    if (this.sidebarItemShowsCheckboxTags(t)) {
      const taskTags =
        Array.isArray((t as any).task_tags) && (t as any).task_tags.length > 0
          ? (t as any).task_tags as string[]
          : computeTaskTags(t, getTaskTodayKey(this.plugin.settings?.taskPanel ?? undefined), this.plugin.settings?.taskPanel ?? undefined);
      if (taskTags.length > 0) {
        const tagsRow = content.createDiv({ cls: "rslatte-task-tags-row" });
        const colorNames: Record<number, string> = { 1: "red", 2: "orange", 3: "yellow", 4: "green" };
        for (const key of taskTags) {
          const info = TASK_TAG_META[key];
          const label = info?.label ?? key;
          const fullName = info?.fullName ?? key;
          const colorOrder = info?.colorOrder ?? 4;
          const chip = tagsRow.createSpan({ cls: "rslatte-task-tag" });
          chip.setText(label);
          chip.setAttr("title", fullName);
          chip.addClass(`rslatte-task-tag--${colorNames[colorOrder] ?? "green"}`);
        }
      }
    }

    this.renderTaskLinkedScheduleRows(content, t);

    const meta = content.createDiv({ cls: "rslatte-timeline-meta" });
    meta.setText(this.buildTimelineMeta(t));
    this.attachTimelineMetaTooltip(meta, this.buildTimelineMetaTooltip(t));

    const from = content.createDiv({ cls: "rslatte-timeline-from" });
    from.setText(this.shortPath(t.filePath));

    const open = async () => {
      try {
        await this.openTaskInFile(t.filePath, t.lineNo);
      } catch (e: any) {
        new Notice(`打开失败：${e?.message ?? String(e)}`);
      }
    };

    row.addEventListener("click", () => void open());
    row.addEventListener("keydown", (ev) => {
      if ((ev as KeyboardEvent).key === "Enter") void open();
    });
  }

  /**
   * 里程碑任务：来自项目管理索引，按“项目 / 里程碑”展示，可展开查看该里程碑下未闭环任务。
   * 目标：在任务管理侧边栏中也能直接操作项目任务状态与编辑信息。
   * @deprecated 此函数当前未使用，保留以备将来使用
   */
  // @ts-ignore - Reserved for future use
  private renderMilestoneTasksSection(container: HTMLElement, _seq: number): void {
    const snap = this.plugin.projectMgr?.getSnapshot?.();
    const projects = (snap?.projects ?? []) as ProjectEntry[];
    const active = projects.filter((p) => {
      const st = String((p as any).status ?? "").trim();
      return st !== "done" && st !== "cancelled";
    });

    const msSec = container.createDiv({ cls: "rslatte-section rslatte-task-section" });
    const msTitleRow = msSec.createDiv({ cls: "rslatte-task-cat-title" });
    msTitleRow.createEl("h4", { text: "📌 里程碑任务" });
    const msMeta = msTitleRow.createDiv({ cls: "rslatte-task-cat-meta" });
    msMeta.setText("点击里程碑展开（仅展示未闭环任务）");

    const msWrap = msSec.createDiv({ cls: "rslatte-task-list" });

    const milestones: Array<{
      key: string;
      project: ProjectEntry;
      milestoneName: string;
      done: number;
      total: number;
      openTasks: ProjectTaskItem[];
    }> = [];

    for (const p of active) {
      const items = (p.taskItems ?? []) as ProjectTaskItem[];
      for (const m of (p.milestones ?? [])) {
        const name = String((m as any).name ?? "").trim();
        if (!name) continue;
        const mPath = String((m as any).path ?? name).trim();
        const key = `${p.projectId}::${mPath}`;
        const openTasks = items.filter((it) => {
          const tp = String((it as any).milestonePath ?? it.milestone ?? "").trim();
          return tp === mPath && (it.statusName === "TODO" || it.statusName === "IN_PROGRESS");
        });
        milestones.push({
          key,
          project: p,
          milestoneName: name,
          done: Number((m as any).done ?? 0),
          total: Number((m as any).total ?? 0),
          openTasks,
        });
      }
    }

    // sort: project name then milestone name
    milestones.sort((a, b) => {
      const pn = String(a.project.projectName ?? "").localeCompare(String(b.project.projectName ?? ""), "zh");
      if (pn !== 0) return pn;
      return a.milestoneName.localeCompare(b.milestoneName, "zh");
    });

    if (milestones.length === 0) {
      msWrap.createDiv({ cls: "rslatte-task-empty", text: "（暂无里程碑任务）" });
      return;
    }

    for (const ms of milestones) {
      const row = msWrap.createDiv({ cls: "rslatte-milestone-row" });
      const isOpen = this._expandedMilestones.has(ms.key);

      // Make the title area clickable to toggle expand/collapse (same UX as Project sidebar)
      const title = row.createDiv({ cls: "rslatte-milestone-title rslatte-milestone-title-clickable" });
      title.onclick = (ev) => {
        ev.stopPropagation();
        if (this._expandedMilestones.has(ms.key)) this._expandedMilestones.delete(ms.key);
        else this._expandedMilestones.add(ms.key);
        this.refresh();
      };

      const togg = title.createEl("button", {
        text: isOpen ? "▼" : "▶",
        cls: "rslatte-icon-only-btn rslatte-milestone-toggle",
      });
      togg.title = isOpen ? "收起" : "展开";
      togg.onclick = (ev) => {
        ev.stopPropagation();
        if (this._expandedMilestones.has(ms.key)) this._expandedMilestones.delete(ms.key);
        else this._expandedMilestones.add(ms.key);
        this.refresh();
      };

      title.createSpan({ text: `${ms.project.projectName} / ${ms.milestoneName}`, cls: "rslatte-milestone-title-text" });

      const badge = row.createDiv({ cls: "rslatte-milestone-badge" });
      badge.setText(`${ms.openTasks.length} 未闭环 · ${ms.done}/${ms.total}`);

      // expanded list
      if (isOpen) {
        const taskWrap = msWrap.createDiv({ cls: "rslatte-milestone-tasks" });
        if (ms.openTasks.length === 0) {
          taskWrap.createDiv({ cls: "rslatte-task-empty", text: "（该里程碑下无未闭环任务）" });
        } else {
          const tl = taskWrap.createDiv({ cls: "rslatte-timeline" });
          for (const it of ms.openTasks.slice(0, 30)) {
            this.renderProjectTaskTimelineItem(tl, ms.project, it);
          }
          if (ms.openTasks.length > 30) {
            taskWrap.createDiv({ cls: "rslatte-task-empty", text: `（仅显示前 30 条，当前未闭环 ${ms.openTasks.length} 条）` });
          }
        }
      }
    }
  }

  private renderProjectTaskTimelineItem(parent: HTMLElement, p: ProjectEntry, it: ProjectTaskItem) {
    const row = parent.createDiv({ cls: "rslatte-timeline-item" });
    row.tabIndex = 0;

    const gutter = row.createDiv({ cls: "rslatte-timeline-gutter" });
    const dot = gutter.createDiv({ cls: "rslatte-timeline-dot" });
    dot.setText(this.statusIcon({ status: it.statusName } as any));
    gutter.createDiv({ cls: "rslatte-timeline-line" });

    const content = row.createDiv({ cls: "rslatte-timeline-content" });
    const titleRow = content.createDiv({ cls: "rslatte-timeline-title-row rslatte-task-row" });
    const text = titleRow.createDiv({ cls: "rslatte-timeline-text rslatte-task-title" });
    renderTextWithContactRefs(this.app, text, String(it.text ?? "(项目任务)").trim());

    // actions (icon-only, compact, right aligned)
    const actions = titleRow.createDiv({ cls: "rslatte-task-actions rslatte-task-actions-compact" });
    const mkBtn = (emoji: string, title: string, onClick: () => void) => {
      const b = actions.createEl("button", { text: emoji, cls: "rslatte-icon-only-btn" });
      b.title = title;
      b.onclick = (ev) => {
        ev.stopPropagation();
        onClick();
      };
      return b;
    };

    mkBtn("✏️", "修改任务", () => {
      new EditProjectTaskModal(this.app, this.plugin, String(p.folderPath ?? ""), it).open();
    });
    const tasklistPath = (p as any)?.tasklistFilePath ?? (p as any)?.tasklist_file_path ?? normalizePath(`${String(p?.folderPath ?? "")}/项目任务清单.md`);
    const refreshAfterProjectTask = async () => {
      try {
        await this.plugin.projectMgr?.refreshDirty?.({ reason: "project_task_action" });
      } catch {}
      try {
        if (tasklistPath && typeof this.plugin.refreshContactInteractionsForTasklistFile === "function") {
          await this.plugin.refreshContactInteractionsForTasklistFile(tasklistPath);
        }
      } catch {}
      this.refresh();
    };
    const setStatusAndRefreshContacts = async (status: "IN_PROGRESS" | "TODO" | "CANCELLED" | "DONE") => {
      if (status === "DONE") {
        new ProjectTaskProgressModal(this.app, this.plugin, String(p.folderPath ?? ""), it, "done", refreshAfterProjectTask).open();
        return;
      }
      await this.plugin.projectMgr.setProjectTaskStatus(String(p.folderPath ?? ""), { taskId: it.taskId, lineNo: it.lineNo }, status);
      await refreshAfterProjectTask();
    };
    // Status action buttons visibility + order follow the same strategy as Output panel
    for (const icon of this.taskActionOrder(String(it.statusName ?? ""))) {
      if (icon === "▶") {
        mkBtn("▶", "标记为 IN_PROGRESS", () => void setStatusAndRefreshContacts("IN_PROGRESS"));
      } else if (icon === "⏸") {
        mkBtn("⏸", "恢复为 TODO", () => void setStatusAndRefreshContacts("TODO"));
      } else if (icon === "⛔") {
        mkBtn("⛔", "标记为 CANCELLED", () => void setStatusAndRefreshContacts("CANCELLED"));
      } else if (icon === "✅") {
        mkBtn("✅", "标记为 DONE", () => void setStatusAndRefreshContacts("DONE"));
      }
    }

    const meta = content.createDiv({ cls: "rslatte-timeline-meta rslatte-task-meta" });
    const created = String(it.created_date ?? "—");
    const due = String(it.planned_end ?? "—");
    meta.setText(`创建日 ${created} · 计划结束日 ${due}`);
    this.attachTimelineMetaTooltip(meta, this.buildProjectTaskItemMetaTooltip(it));

    const from = content.createDiv({ cls: "rslatte-timeline-from" });
    from.setText(`${String(p.projectName ?? "项目")} / ${String(it.milestone ?? "")}`.trim());

    const open = async () => {
      try {
        const filePath = String(it.sourceFilePath ?? (p as any).tasklistFilePath ?? "").trim();
        if (filePath) await this.openTaskInFile(filePath, Number(it.lineNo ?? 0));
        else new Notice("未找到任务所在文件路径");
      } catch (e: any) {
        new Notice(`打开失败：${e?.message ?? String(e)}`);
      }
    };

    row.addEventListener("click", () => void open());
    row.addEventListener("keydown", (ev) => {
      if ((ev as KeyboardEvent).key === "Enter") void open();
    });
  }

  // =========================
  // Reminders (memos) timeline
  // =========================

  /** 是否显示「安排」：未闭环、未失效、尚未安排过 */
  private canShowArrangeMemoButton(m: RSLatteIndexItem): boolean {
    const extra = ((m as any)?.extra ?? {}) as Record<string, string>;
    if (String(extra.arranged_task_uid ?? "").trim()) return false;
    if (String(extra.arranged_schedule_uid ?? "").trim()) return false;
    if (String(extra.memo_arranged ?? "").trim() === "1") return false;
    const st = String((m as any).status ?? "").trim().toUpperCase();
    if (st === "DONE" || st === "CANCELLED") return false;
    if (String(extra.invalidated ?? "").trim() === "1") return false;
    return true;
  }

  /** 仅周期提醒/日程显示「失效/恢复周期」按钮 */
  private isRepeatingMemoOrSchedule(m: RSLatteIndexItem): boolean {
    const extra = ((m as any)?.extra ?? {}) as Record<string, string>;
    let rr = String((m as any)?.repeatRule ?? "").trim().toLowerCase();
    if (!rr) rr = String(extra.repeat_rule ?? "").trim().toLowerCase();
    return !!rr && rr !== "none";
  }

  private renderReminderFlatTimeline(parent: HTMLElement, memos: RSLatteIndexItem[]) {
    const wrap = parent.createDiv({ cls: "rslatte-timeline" });
    const itemsWrap = wrap.createDiv({ cls: "rslatte-timeline-day-items" });
    for (const m of memos) {
      this.renderReminderTimelineItem(itemsWrap, m);
    }
  }

  private renderReminderTimelineItem(parent: HTMLElement, m: RSLatteIndexItem) {
    const row = parent.createDiv({ cls: "rslatte-timeline-item" });
    row.tabIndex = 0;
    // 与 renderMemoAllTimeline 一致，供 tryScrollToMemoRowInPanel / focusMemoRowByFileLine 定位（「今日关注」走本函数，此前缺属性会导致跳转无法高亮）
    row.setAttribute("data-memo-file-path", normalizePath(m.filePath));
    row.setAttribute("data-memo-line-no", String(m.lineNo));

    const gutter = row.createDiv({ cls: "rslatte-timeline-gutter" });
    const dot = gutter.createDiv({ cls: "rslatte-timeline-dot" });
    dot.setText("🔔");
    gutter.createDiv({ cls: "rslatte-timeline-line" });

    const content = row.createDiv({ cls: "rslatte-timeline-content" });
    const titleRow = content.createDiv({ cls: "rslatte-timeline-title-row rslatte-task-row" });
    const title = titleRow.createDiv({ cls: "rslatte-timeline-text rslatte-task-title" });
    renderTextWithContactRefs(this.app, title, this.buildReminderDisplayText(m));
    const actionRow = titleRow.createDiv({ cls: "rslatte-task-actions rslatte-task-actions-compact" });
    const memoRefresh = async () => {
      await this.manualRefreshMemoIndexAndMaybeSync();
      this.refresh();
    };
    const memoBtns: SidePanelCardActionEntry[] = [
      {
        id: "memo_edit",
        kind: "icon",
        icon: "✏️",
        title: "修改提醒信息",
        run: async () => {
          new EditMemoModal(this.app, this.plugin, m).open();
        },
      },
    ];
    const starred = !!(m as any).starred;
    memoBtns.push({
      id: "memo_star",
      kind: "icon",
      icon: starred ? "☆" : "⭐",
      title: starred ? "取消星标" : "星标",
      run: async () => {
        await writeMemoSetStarred(this.plugin.taskRSLatte, m as any, !starred);
        await this.appendUiWorkEvent({
          kind: "memo",
          action: "update",
          summary: `${starred ? "☆" : "⭐"} ${starred ? "取消星标提醒" : "星标提醒"} ${String(m.text ?? m.raw ?? "").trim() || "未命名提醒"}`,
          ref: { uid: (m as any).uid, file_path: m.filePath, line_no: m.lineNo, starred: !starred },
        });
        await memoRefresh();
      },
    });
    const invalidated = String((m as any)?.extra?.invalidated ?? "").trim() === "1";
    if (invalidated || this.isRepeatingMemoOrSchedule(m)) {
      memoBtns.push({
        id: "memo_invalidate",
        kind: "icon",
        icon: invalidated ? "♻️" : "🚫",
        title: invalidated ? "恢复自动生成下一次提醒" : "失效（停止自动生成下一次提醒）",
        run: async () => {
          await writeMemoSetInvalidated(this.plugin.taskRSLatte, m as any, !invalidated);
          await this.appendUiWorkEvent({
            kind: "memo",
            action: "status",
            summary: `${invalidated ? "♻️ 恢复提醒周期" : "🚫 失效提醒"} ${String(m.text ?? m.raw ?? "").trim() || "未命名提醒"}`,
            ref: { uid: (m as any).uid, file_path: m.filePath, line_no: m.lineNo, invalidated: !invalidated },
            metrics: { invalidated: !invalidated ? 1 : 0 },
          });
          await memoRefresh();
        },
      });
    }
    if (this.canShowArrangeMemoButton(m)) {
      memoBtns.push({
        id: "memo_arrange",
        kind: "icon",
        icon: "📌",
        title: "安排（转任务或转日程）",
        run: async () => {
          new ArrangeMemoModal(this.app, this.plugin, m, () => {
            void this.manualRefreshMemoIndexAndMaybeSync();
            this.refresh();
          }).open();
        },
      });
    }
    for (const icon of this.taskActionOrder(String((m as any).status ?? ""))) {
      if (icon === "⛔") {
        memoBtns.push({
          id: "memo_cancel",
          kind: "icon",
          icon: "⛔",
          title: "标记为取消",
          run: async () => {
            await writeMemoApplyStatus(this.plugin.taskRSLatte, m as any, "CANCELLED", { skipWorkEvent: true });
            await this.appendUiWorkEvent({
              kind: "memo",
              action: "cancelled",
              summary: `⛔ 提醒取消 ${String(m.text ?? m.raw ?? "").trim() || "未命名提醒"}`,
              ref: { uid: (m as any).uid, file_path: m.filePath, line_no: m.lineNo, status: "CANCELLED" },
              metrics: { status: "CANCELLED" },
            });
            await memoRefresh();
          },
        });
      } else if (icon === "✅") {
        memoBtns.push({
          id: "memo_done",
          kind: "icon",
          icon: "✅",
          title: "标记为完成",
          run: async () => {
            await writeMemoApplyStatus(this.plugin.taskRSLatte, m as any, "DONE", { skipWorkEvent: true });
            await this.appendUiWorkEvent({
              kind: "memo",
              action: "done",
              summary: `✅ 提醒完成 ${String(m.text ?? m.raw ?? "").trim() || "未命名提醒"}`,
              ref: { uid: (m as any).uid, file_path: m.filePath, line_no: m.lineNo, status: "DONE" },
              metrics: { status: "DONE" },
            });
            await memoRefresh();
          },
        });
      }
    }
    this.mountSidePanelCardActions(actionRow, memoBtns, this.getMoreIdsForSidePanelCard("memo"));

    this.renderReminderUrgencyBadge(content, m);
    this.renderReminderArrangedLinkRow(content, m);

    const meta = content.createDiv({ cls: "rslatte-timeline-meta" });
    meta.setText(this.buildReminderMeta(m));
    this.attachTimelineMetaTooltip(meta, this.buildReminderMetaTooltip(m));

    content.createDiv({ cls: "rslatte-timeline-from", text: this.shortPath(m.filePath) });

    const open = async () => {
      try {
        // 规则：点击卡片（非联系人姓名）始终打开提醒所在日记条目
        await this.openTaskInFile(m.filePath, m.lineNo);
      } catch (e: any) {
        new Notice(`打开失败：${e?.message ?? String(e)}`);
      }
    };

    row.addEventListener("click", () => void open());
    row.addEventListener("keydown", (ev) => {
      if ((ev as KeyboardEvent).key === "Enter") void open();
    });
  }

  /** 任务卡片：meta `linked_schedule_uids` 关联的日程，每条一行；点击在侧栏定位日程区块 */
  private renderTaskLinkedScheduleRows(content: HTMLElement, t: RSLatteIndexItem): void {
    const ex = ((t as any)?.extra ?? {}) as Record<string, string>;
    const raw = String(ex.linked_schedule_uids ?? "").trim();
    if (!raw) return;
    const uids = raw.split(",").map((x) => x.trim()).filter(Boolean);
    if (uids.length === 0) return;
    const wrap = content.createDiv({ cls: "rslatte-task-linked-schedules" });
    for (const uid of uids) {
      const row = wrap.createDiv({ cls: "rslatte-task-linked-schedule-row" });
      row.setText("…");
      row.setAttr("title", "点击：在任务管理侧栏滚动到该日程");
      row.tabIndex = 0;
      row.setAttr("role", "button");
      row.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        void this.navigateToArrangedDerivation("schedule", uid);
      });
      row.addEventListener("keydown", (ev) => {
        if ((ev as KeyboardEvent).key === "Enter") {
          ev.preventDefault();
          ev.stopPropagation();
          void this.navigateToArrangedDerivation("schedule", uid);
        }
      });
      void this.hydrateTaskLinkedScheduleRow(uid, row);
    }
  }

  private async hydrateTaskLinkedScheduleRow(scheduleUid: string, row: HTMLElement): Promise<void> {
    try {
      const it = await this.plugin.taskRSLatte.findScheduleByUid(scheduleUid);
      if (!it) {
        row.setText("（日程未在索引中找到）");
        row.addClass("rslatte-task-linked-schedule-row--missing");
        return;
      }
      const ex = ((it as any)?.extra ?? {}) as Record<string, string>;
      const st = String(ex.start_time ?? "").trim();
      const en = String(ex.end_time ?? "").trim();
      const timeRange = st && en ? `${st}-${en}` : "";
      let desc = String(it.text ?? "").trim();
      if (timeRange && desc.startsWith(timeRange)) desc = desc.slice(timeRange.length).trim();
      const displayDesc = await plainTextFromTextWithContactRefsResolved(
        desc || String(it.text ?? "").trim(),
        (uid) => this.lookupContactDisplayName(uid)
      );
      const date = String((it as any).memoDate ?? "").trim();
      const parts: string[] = [];
      if (timeRange) parts.push(timeRange);
      if (displayDesc) parts.push(displayDesc);
      if (date) parts.push(date);
      row.setText(parts.join(" · ") || "（日程）");
      row.setAttr("title", `点击在任务管理侧栏定位日程\n${parts.join(" · ")}`);
    } catch {
      row.setText("（日程加载失败）");
      row.addClass("rslatte-task-linked-schedule-row--missing");
    }
  }

  /** 已安排提醒：在 tags 与 meta 之间显示关联任务/日程，点击在侧栏定位（找不到则打开笔记） */
  private renderReminderArrangedLinkRow(content: HTMLElement, m: RSLatteIndexItem): void {
    const ex = ((m as any)?.extra ?? {}) as Record<string, string>;
    const taskUid = String(ex.arranged_task_uid ?? "").trim();
    const schUid = String(ex.arranged_schedule_uid ?? "").trim();
    if (taskUid) this.appendArrangedDerivationLink(content, "task", taskUid);
    if (schUid) this.appendArrangedDerivationLink(content, "schedule", schUid);
  }

  /** 已安排任务/日程：灰色类型标签 + 描述 + 创建日，点击在侧栏定位 */
  private appendArrangedDerivationLink(content: HTMLElement, kind: "task" | "schedule", targetUid: string): void {
    const row = content.createDiv({ cls: "rslatte-reminder-arranged-row" });
    row.createSpan({ cls: "rslatte-reminder-arranged-kind", text: kind === "task" ? "任务" : "日程" });
    const descEl = row.createSpan({ cls: "rslatte-reminder-arranged-desc", text: "…" });
    const dateEl = row.createSpan({ cls: "rslatte-reminder-arranged-date" });
    dateEl.setText("创建 …");
    row.setAttr(
      "title",
      kind === "task"
        ? "点击：在任务管理侧栏滚动到该任务；若当前分区未展示则打开所在笔记"
        : "点击：在任务管理侧栏滚动到该日程；若当前分区未展示则打开所在笔记"
    );
    row.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void this.navigateToArrangedDerivation(kind, targetUid);
    });
    row.addEventListener("keydown", (ev) => {
      if ((ev as KeyboardEvent).key === "Enter") {
        ev.preventDefault();
        ev.stopPropagation();
        void this.navigateToArrangedDerivation(kind, targetUid);
      }
    });
    row.tabIndex = 0;
    row.setAttr("role", "button");
    void this.hydrateArrangedDerivationRow(kind, targetUid, row, descEl, dateEl);
  }

  /** 已安排行描述用：将无别名的 C_uid 解析为通讯录 display_name */
  private async lookupContactDisplayName(uid: string): Promise<string | null> {
    const u = String(uid ?? "").trim();
    if (!u) return null;
    try {
      const store = this.plugin.contactsIndex?.getIndexStore?.();
      if (!store) return null;
      const idx = await store.readIndex();
      const hit = (idx?.items ?? []).find((x) => String((x as any)?.contact_uid ?? "").trim() === u);
      const nm = String((hit as any)?.display_name ?? "").trim();
      return nm || null;
    } catch {
      return null;
    }
  }

  private async hydrateArrangedDerivationRow(
    kind: "task" | "schedule",
    targetUid: string,
    row: HTMLElement,
    descEl: HTMLElement,
    dateEl: HTMLElement
  ): Promise<void> {
    try {
      const it =
        kind === "task"
          ? await this.plugin.taskRSLatte.findTaskByUid(targetUid)
          : await this.plugin.taskRSLatte.findScheduleByUid(targetUid);
      if (!it) {
        descEl.setText("索引中未找到");
        dateEl.setText("创建 —");
        row.addClass("rslatte-reminder-arranged-row--missing");
        return;
      }
      const rawDesc = String(it.text || it.raw || "").trim() || "（无描述）";
      const displayDesc = await plainTextFromTextWithContactRefsResolved(rawDesc, (uid) => this.lookupContactDisplayName(uid));
      descEl.setText(displayDesc);
      descEl.setAttr("title", displayDesc);
      const created = String((it as any).created_date ?? "").trim();
      dateEl.setText(created ? `创建 ${created}` : "创建 —");
      const tipBase = row.getAttr("title") ?? "";
      row.setAttr("title", `${tipBase}\n${displayDesc}${created ? `\n创建日：${created}` : ""}`);
    } catch {
      descEl.setText("加载失败");
      dateEl.setText("创建 —");
      row.addClass("rslatte-reminder-arranged-row--missing");
    }
  }

  /** 日程后续任务/提醒/日程（仅日程 meta 记录，点击定位） */
  private async navigateToFollowupTarget(kind: "task" | "memo" | "schedule", uid: string): Promise<void> {
    try {
      if (kind === "task") {
        await this.navigateToArrangedDerivation("task", uid);
        return;
      }
      if (kind === "schedule") {
        await this.navigateToArrangedDerivation("schedule", uid);
        return;
      }
      const it = await this.plugin.taskRSLatte.findMemoByUid(uid);
      if (!it) {
        new Notice("未找到对应提醒（可先刷新提醒索引）");
        return;
      }
      await this.openTaskInFile(it.filePath, it.lineNo);
    } catch (e: any) {
      new Notice(`定位失败：${e?.message ?? String(e)}`);
    }
  }

  private async hydrateScheduleFollowupRow(
    kind: "task" | "memo" | "schedule",
    targetUid: string,
    row: HTMLElement,
    descEl: HTMLElement,
    dateEl: HTMLElement
  ): Promise<void> {
    try {
      if (kind === "task") {
        const it = await this.plugin.taskRSLatte.findTaskByUid(targetUid);
        if (!it) {
          descEl.setText("索引中未找到");
          dateEl.setText("—");
          row.addClass("rslatte-reminder-arranged-row--missing");
          return;
        }
        const rawDesc = String(it.text || it.raw || "").trim() || "（无描述）";
        const displayDesc = await plainTextFromTextWithContactRefsResolved(rawDesc, (uid) => this.lookupContactDisplayName(uid));
        descEl.setText(displayDesc);
        descEl.setAttr("title", displayDesc);
        const ps = String((it as any).planned_start ?? "").trim();
        const pe = String((it as any).planned_end ?? "").trim();
        const datePart = ps ? `计划开始 ${ps}` : pe ? `计划结束 ${pe}` : "—";
        dateEl.setText(datePart);
        row.setAttr("title", `点击定位任务\n${displayDesc}\n${datePart}`);
        return;
      }
      if (kind === "memo") {
        const it = await this.plugin.taskRSLatte.findMemoByUid(targetUid);
        if (!it) {
          descEl.setText("索引中未找到");
          dateEl.setText("—");
          row.addClass("rslatte-reminder-arranged-row--missing");
          return;
        }
        const rawDesc = String(it.text || it.raw || "").trim() || "（无描述）";
        const displayDesc = await plainTextFromTextWithContactRefsResolved(rawDesc, (uid) => this.lookupContactDisplayName(uid));
        descEl.setText(displayDesc);
        descEl.setAttr("title", displayDesc);
        const md = String((it as any).memoDate ?? "").trim();
        const datePart = md ? `提醒日 ${md}` : "—";
        dateEl.setText(datePart);
        row.setAttr("title", `点击定位提醒\n${displayDesc}\n${datePart}`);
        return;
      }
      if (kind === "schedule") {
        const it = await this.plugin.taskRSLatte.findScheduleByUid(targetUid);
        if (!it) {
          descEl.setText("索引中未找到");
          dateEl.setText("—");
          row.addClass("rslatte-reminder-arranged-row--missing");
          return;
        }
        const rawDesc = String(it.text || it.raw || "").trim() || "（无描述）";
        const displayDesc = await plainTextFromTextWithContactRefsResolved(rawDesc, (uid) => this.lookupContactDisplayName(uid));
        descEl.setText(displayDesc);
        descEl.setAttr("title", displayDesc);
        const md = String((it as any).memoDate ?? "").trim();
        const ex = ((it as any)?.extra ?? {}) as Record<string, string>;
        const st = String(ex.start_time ?? "").trim();
        const datePart = md && st ? `📅${md} · ${st}` : md ? `📅${md}` : st || "—";
        dateEl.setText(datePart);
        row.setAttr("title", `点击定位日程\n${displayDesc}\n${datePart}`);
        return;
      }
    } catch {
      descEl.setText("加载失败");
      dateEl.setText("—");
      row.addClass("rslatte-reminder-arranged-row--missing");
    }
  }

  /** 日程描述行去掉时间前缀，便于预填任务/提醒 */
  private stripScheduleLineTimePrefix(raw: string): string {
    return String(raw ?? "").replace(/^\d{1,2}:\d{2}-\d{1,2}:\d{2}\s+/, "").trim();
  }

  private getScheduleItemYmd(m: RSLatteIndexItem): string {
    const memoDate = String((m as any)?.memoDate ?? "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(memoDate)) return memoDate;
    const ex = ((m as any)?.extra ?? {}) as Record<string, string>;
    const sd = String(ex.schedule_date ?? "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(sd) ? sd : "";
  }

  /** 预填新建日程的开始时间（来自原日程 meta） */
  private getScheduleStartTimeHint(m: RSLatteIndexItem): string {
    const ex = ((m as any)?.extra ?? {}) as Record<string, string>;
    const st = String(ex.start_time ?? "").trim();
    return /^\d{2}:\d{2}$/.test(st) ? st : "09:00";
  }

  /** 串联新建任务/提醒/日程并可选将原日程标为结束；afterMarkDone=false 时仅写 followup_*（已结束日程补录） */
  private openScheduleFollowupAddTask(m: RSLatteIndexItem, afterMarkDone: boolean): void {
    const ymd = this.getScheduleItemYmd(m);
    const due = ymd || this.plugin.getTodayKey().slice(0, 10);
    const body = this.stripScheduleLineTimePrefix(String(m.text ?? m.raw ?? ""));
    new AddTaskModal(this.app, this.plugin, {
      modalTitle: afterMarkDone ? "结束日程并新增任务" : "增加后续任务",
      initialText: body,
      initialDue: due,
      skipDefaultNotice: true,
      onCreated: async ({ uid }) => {
        try {
          await this.plugin.taskRSLatte.ensureReady?.();
          const hit = await this.plugin.taskRSLatte.findTaskByUid(uid);
          const tid = (hit as any)?.itemId;
          const patch: Record<string, string> = { followup_task_uid: uid };
          if (tid != null) patch.followup_task_tid = String(tid);
          await this.plugin.taskRSLatte.patchMemoRslatteMetaByUid(m as any, patch);
          if (afterMarkDone) {
            await writeScheduleApplyStatus(this.plugin.taskRSLatte, m as any, "DONE", { skipWorkEvent: true });
            await this.appendUiWorkEvent({
              kind: "schedule",
              action: "done",
              summary: `✅ 日程结束 ${String(m.text ?? m.raw ?? "").trim() || "未命名日程"}`,
              ref: { uid: (m as any).uid, file_path: m.filePath, line_no: m.lineNo, category: "schedule", status: "DONE" },
              metrics: { status: "DONE", category: "schedule" },
            });
          }
          await this.manualRefreshScheduleIndexAndMaybeSync();
          new Notice(afterMarkDone ? "日程已结束，并已记录后续任务" : "已记录后续任务");
          this.refresh();
        } catch (e: any) {
          new Notice(`操作失败：${e?.message ?? String(e)}`);
        }
      },
    }).open();
  }

  private openScheduleFollowupAddMemo(m: RSLatteIndexItem, afterMarkDone: boolean): void {
    const ymd = this.getScheduleItemYmd(m);
    const memoDate = ymd || this.plugin.getTodayKey().slice(0, 10);
    const body = this.stripScheduleLineTimePrefix(String(m.text ?? m.raw ?? ""));
    new AddMemoModal(this.app, this.plugin, {
      modalTitle: afterMarkDone ? "结束日程并新增提醒" : "增加后续提醒",
      initialText: body,
      initialDateYmd: memoDate,
      skipDefaultNotice: true,
      onCreated: async (memoUid) => {
        try {
          await this.plugin.taskRSLatte.ensureReady?.();
          const hit = await this.plugin.taskRSLatte.findMemoByUid(memoUid);
          const mid = (hit as any)?.itemId;
          const patch: Record<string, string> = { followup_memo_uid: memoUid };
          if (mid != null) patch.followup_memo_mid = String(mid);
          await this.plugin.taskRSLatte.patchMemoRslatteMetaByUid(m as any, patch);
          if (afterMarkDone) {
            await writeScheduleApplyStatus(this.plugin.taskRSLatte, m as any, "DONE", { skipWorkEvent: true });
            await this.appendUiWorkEvent({
              kind: "schedule",
              action: "done",
              summary: `✅ 日程结束 ${String(m.text ?? m.raw ?? "").trim() || "未命名日程"}`,
              ref: { uid: (m as any).uid, file_path: m.filePath, line_no: m.lineNo, category: "schedule", status: "DONE" },
              metrics: { status: "DONE", category: "schedule" },
            });
          }
          await this.manualRefreshScheduleIndexAndMaybeSync();
          new Notice(afterMarkDone ? "日程已结束，并已记录后续提醒" : "已记录后续提醒");
          this.refresh();
        } catch (e: any) {
          new Notice(`操作失败：${e?.message ?? String(e)}`);
        }
      },
    }).open();
  }

  private openScheduleFollowupAddSchedule(m: RSLatteIndexItem, afterMarkDone: boolean): void {
    const ymd = this.getScheduleItemYmd(m) || this.plugin.getTodayKey().slice(0, 10);
    const body = this.stripScheduleLineTimePrefix(String(m.text ?? m.raw ?? ""));
    const startGuess = this.getScheduleStartTimeHint(m);
    new AddScheduleModal(this.app, this.plugin, {
      modalTitle: afterMarkDone ? "结束日程并新增日程" : "增加后续日程",
      initialDesc: body,
      initialDateYmd: ymd,
      initialStartTime: startGuess,
      skipDefaultNotice: true,
      onCreated: async ({ uid }) => {
        try {
          await this.plugin.taskRSLatte.ensureReady?.();
          const hit = await this.plugin.taskRSLatte.findScheduleByUid(uid);
          const sid = (hit as any)?.itemId;
          const patch: Record<string, string> = { followup_schedule_uid: uid };
          if (sid != null) patch.followup_schedule_tid = String(sid);
          await this.plugin.taskRSLatte.patchMemoRslatteMetaByUid(m as any, patch);
          if (afterMarkDone) {
            await writeScheduleApplyStatus(this.plugin.taskRSLatte, m as any, "DONE", { skipWorkEvent: true });
            await this.appendUiWorkEvent({
              kind: "schedule",
              action: "done",
              summary: `✅ 日程结束 ${String(m.text ?? m.raw ?? "").trim() || "未命名日程"}`,
              ref: { uid: (m as any).uid, file_path: m.filePath, line_no: m.lineNo, category: "schedule", status: "DONE" },
              metrics: { status: "DONE", category: "schedule" },
            });
          }
          await this.manualRefreshScheduleIndexAndMaybeSync();
          new Notice(afterMarkDone ? "日程已结束，并已记录后续日程" : "已记录后续日程");
          this.refresh();
        } catch (e: any) {
          new Notice(`操作失败：${e?.message ?? String(e)}`);
        }
      },
    }).open();
  }

  private openSchedulePosthocFollowupModal(m: RSLatteIndexItem): void {
    new ScheduleFollowupPostModal(this.app, {
      onAddTask: () => this.openScheduleFollowupAddTask(m, false),
      onAddMemo: () => this.openScheduleFollowupAddMemo(m, false),
      onAddSchedule: () => this.openScheduleFollowupAddSchedule(m, false),
    }).open();
  }

  /** ✅ 一键结束：不写 followup，不弹窗 */
  private async performScheduleDirectEnd(m: RSLatteIndexItem): Promise<void> {
    await writeScheduleApplyStatus(this.plugin.taskRSLatte, m as any, "DONE", { skipWorkEvent: true });
    await this.appendUiWorkEvent({
      kind: "schedule",
      action: "done",
      summary: `✅ 日程结束 ${String(m.text ?? m.raw ?? "").trim() || "未命名日程"}`,
      ref: { uid: (m as any).uid, file_path: m.filePath, line_no: m.lineNo, category: "schedule", status: "DONE" },
      metrics: { status: "DONE", category: "schedule" },
    });
    await this.manualRefreshScheduleIndexAndMaybeSync();
    this.refresh();
  }

  /** ➕：弹窗内选「结束并增加任务/提醒/日程」 */
  private openScheduleEndWithFollowupModal(m: RSLatteIndexItem): void {
    new ScheduleEndModal(this.app, {
      onEndWithTask: () => this.openScheduleFollowupAddTask(m, true),
      onEndWithMemo: () => this.openScheduleFollowupAddMemo(m, true),
      onEndWithSchedule: () => this.openScheduleFollowupAddSchedule(m, true),
    }).open();
  }

  private renderScheduleFollowupRow(content: HTMLElement, m: RSLatteIndexItem): void {
    const ex = ((m as any)?.extra ?? {}) as Record<string, string>;
    const taskUid = String(ex.followup_task_uid ?? "").trim();
    const memoUid = String(ex.followup_memo_uid ?? "").trim();
    const schUid = String(ex.followup_schedule_uid ?? "").trim();
    if (!taskUid && !memoUid && !schUid) return;
    const kind: "task" | "memo" | "schedule" = taskUid ? "task" : memoUid ? "memo" : "schedule";
    const targetUid = taskUid || memoUid || schUid;
    const kindLabel = kind === "task" ? "任务" : kind === "memo" ? "提醒" : "日程";
    const row = content.createDiv({ cls: "rslatte-reminder-arranged-row rslatte-schedule-followup-row" });
    row.createSpan({ cls: "rslatte-schedule-followup-label", text: "后续计划：" });
    row.createSpan({ cls: "rslatte-reminder-arranged-kind", text: kindLabel });
    const descEl = row.createSpan({ cls: "rslatte-reminder-arranged-desc", text: "…" });
    const dateEl = row.createSpan({ cls: "rslatte-reminder-arranged-date", text: "…" });
    row.tabIndex = 0;
    row.setAttr("role", "button");
    row.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void this.navigateToFollowupTarget(kind, targetUid);
    });
    row.addEventListener("keydown", (ev) => {
      if ((ev as KeyboardEvent).key === "Enter") {
        ev.preventDefault();
        ev.stopPropagation();
        void this.navigateToFollowupTarget(kind, targetUid);
      }
    });
    void this.hydrateScheduleFollowupRow(kind, targetUid, row, descEl, dateEl);
  }

  /** 日程关联任务：显示在标题与后续计划之间，样式对齐 rslatte-schedule-followup-row */
  private renderScheduleLinkedTaskRow(content: HTMLElement, m: RSLatteIndexItem): void {
    const ex = ((m as any)?.extra ?? {}) as Record<string, string>;
    const taskUid = String(ex.linked_task_uid ?? "").trim();
    if (!taskUid) return;
    const row = content.createDiv({ cls: "rslatte-reminder-arranged-row rslatte-schedule-followup-row" });
    row.createSpan({ cls: "rslatte-schedule-followup-label", text: "关联任务：" });
    const kindEl = row.createSpan({ cls: "rslatte-reminder-arranged-kind", text: "任务" });
    const descEl = row.createSpan({ cls: "rslatte-reminder-arranged-desc", text: "…" });
    const dateEl = row.createSpan({ cls: "rslatte-reminder-arranged-date", text: "…" });
    row.tabIndex = 0;
    row.setAttr("role", "button");
    row.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void this.navigateToLinkedTaskTarget(taskUid);
    });
    row.addEventListener("keydown", (ev) => {
      if ((ev as KeyboardEvent).key === "Enter") {
        ev.preventDefault();
        ev.stopPropagation();
        void this.navigateToLinkedTaskTarget(taskUid);
      }
    });
    void this.hydrateScheduleLinkedTaskRow(taskUid, row, kindEl, descEl, dateEl);
  }

  private async hydrateScheduleLinkedTaskRow(
    taskUid: string,
    row: HTMLElement,
    kindEl: HTMLElement,
    descEl: HTMLElement,
    dateEl: HTMLElement
  ): Promise<void> {
    try {
      const it = await this.plugin.taskRSLatte.findTaskByUid(taskUid);
      if (it) {
        const rawDesc = String(it.text || it.raw || "").trim() || "（无描述）";
        const displayDesc = await plainTextFromTextWithContactRefsResolved(rawDesc, (uid) => this.lookupContactDisplayName(uid));
        descEl.setText(displayDesc);
        descEl.setAttr("title", displayDesc);
        const pe = String((it as any).planned_end ?? "").trim();
        dateEl.setText(pe ? `计划结束 ${pe}` : "—");
        row.setAttr("title", `点击定位任务\n${displayDesc}${pe ? `\n计划结束：${pe}` : ""}`);
        return;
      }
      const pTask = await this.findProjectTaskByTaskId(taskUid);
      if (!pTask) {
        descEl.setText("索引中未找到");
        dateEl.setText("—");
        row.addClass("rslatte-reminder-arranged-row--missing");
        return;
      }
      kindEl.setText("项目任务");
      const displayDesc = await plainTextFromTextWithContactRefsResolved(String(pTask.task.text || "").trim(), (uid) =>
        this.lookupContactDisplayName(uid)
      );
      descEl.setText(displayDesc || "（无描述）");
      descEl.setAttr("title", displayDesc || "（无描述）");
      const pe = String((pTask.task as any).planned_end ?? "").trim();
      dateEl.setText(pe ? `计划结束 ${pe}` : "—");
      row.setAttr("title", `点击定位项目任务\n${displayDesc}${pe ? `\n计划结束：${pe}` : ""}`);
    } catch {
      descEl.setText("加载失败");
      dateEl.setText("—");
      row.addClass("rslatte-reminder-arranged-row--missing");
    }
  }

  private async navigateToLinkedTaskTarget(taskUid: string): Promise<void> {
    const it = await this.plugin.taskRSLatte.findTaskByUid(taskUid);
    if (it) {
      await this.navigateToArrangedDerivation("task", taskUid);
      return;
    }
    const pTask = await this.findProjectTaskByTaskId(taskUid);
    if (!pTask) {
      new Notice("未找到关联任务（可先刷新索引）");
      return;
    }
    await this.plugin.activateProjectView();
    const ws: any = this.app.workspace as any;
    const leaf = ws.getLeavesOfType?.(VIEW_TYPE_PROJECTS)?.[0];
    const view: any = leaf?.view;
    if (view && typeof view.scrollToProject === "function") {
      await view.scrollToProject(
        String((pTask.project as any).projectId ?? pTask.project.folderPath ?? ""),
        String((pTask.task as any).milestonePath ?? pTask.task.milestone ?? ""),
        String((pTask.task as any).sourceFilePath ?? pTask.project.tasklistFilePath ?? ""),
        Number((pTask.task as any).lineNo ?? -1)
      );
      return;
    }
    await this.openTaskInFile(
      String((pTask.task as any).sourceFilePath ?? pTask.project.tasklistFilePath ?? ""),
      Number((pTask.task as any).lineNo ?? 0)
    );
  }

  private async findProjectTaskByTaskId(taskId: string): Promise<{ project: ProjectEntry; task: ProjectTaskItem } | null> {
    const tid = String(taskId ?? "").trim();
    if (!tid) return null;
    try {
      const snap: any = this.plugin.projectMgr?.getSnapshot?.();
      const projects: ProjectEntry[] = Array.isArray(snap?.projects) ? snap.projects : [];
      for (const p of projects) {
        const tasks: ProjectTaskItem[] = Array.isArray((p as any).taskItems) ? (p as any).taskItems : [];
        const hit = tasks.find((t) => String((t as any).taskId ?? "").trim() === tid);
        if (hit) return { project: p, task: hit };
      }
    } catch {
      // ignore
    }
    return null;
  }

  private async navigateToArrangedDerivation(kind: "task" | "schedule", uid: string): Promise<void> {
    try {
      if (kind === "task") {
        const it = await this.plugin.taskRSLatte.findTaskByUid(uid);
        if (!it) {
          new Notice("未找到对应任务（可先刷新任务索引）");
          return;
        }
        const { task } = this.moduleTabAvailability();
        if (task) {
          this._subTab = "task";
          await this.expandTaskPanelSectionsForFileLine(it.filePath, it.lineNo);
          await this.requestRender();
        }
        const scrolled = await this.tryScrollToTaskRowInPanel(it.filePath, it.lineNo, {
          skipInitialRender: !!task,
        });
        if (!scrolled) await this.openTaskInFile(it.filePath, it.lineNo);
        return;
      }
      const it = await this.plugin.taskRSLatte.findScheduleByUid(uid);
      if (!it) {
        new Notice("未找到对应日程（可先刷新日程索引）");
        return;
      }
      await this.focusScheduleByFileLine(it.filePath, it.lineNo);
    } catch (e: any) {
      new Notice(`定位失败：${e?.message ?? String(e)}`);
    }
  }

  /**
   * 跳转前展开包含该任务的分区：折叠时 `.rslatte-task-list` 为 `display:none`，无法滚动到可见区域并高亮。
   */
  private async expandTaskPanelSectionsForFileLine(filePath: string, lineNo: number): Promise<void> {
    const norm = normalizePath(filePath);
    const ln = Number(lineNo);
    if (!norm || !Number.isFinite(ln)) return;

    let listsData: Awaited<ReturnType<typeof this.plugin.taskRSLatte.getTaskListsForSidePanel>> | null = null;
    try {
      listsData = await this.plugin.taskRSLatte.getTaskListsForSidePanel();
    } catch {
      return;
    }
    if (!listsData) return;

    const match = (it: RSLatteIndexItem) =>
      normalizePath(it.filePath) === norm && Number(it.lineNo) === ln;

    const ids: string[] = [];
    if ((listsData.todayAction ?? []).some(match)) ids.push("todayAction");
    if ((listsData.todayFollowUp ?? []).some(match)) ids.push("todayFollowUp");
    if ((listsData.overdue ?? []).some(match)) ids.push("overdue");
    if ((listsData.otherRisk ?? []).some(match)) ids.push("otherRisk");
    if ((listsData.otherActive ?? []).some(match)) ids.push("otherActive");
    if ((listsData.closedCancelled ?? []).some(match)) ids.push("closedCancelled");
    if ((listsData.closedDone ?? []).some(match)) ids.push("closedDone");

    const fallback = ["todayAction", "todayFollowUp", "overdue", "otherRisk", "otherActive"];
    const toExpand = ids.length > 0 ? ids : fallback;

    const tp: any = (this.plugin.settings as any).taskPanel ?? {};
    tp.collapsedLists = tp.collapsedLists ?? {};
    let changed = false;
    for (const id of toExpand) {
      if (tp.collapsedLists[id] !== false) {
        tp.collapsedLists[id] = false;
        changed = true;
      }
    }
    if (changed) await this.plugin.saveSettings();
  }

  /**
   * 在侧栏 DOM 中查找带 data-task-file-path 的任务行并滚动高亮；找不到返回 false（不弹 Notice）。
   * `skipInitialRender`：调用方已 `requestRender()` 过则置 true，避免连续整页重绘导致侧栏多次闪烁（与 `focusMemoRowByFileLine` 同源）。
   */
  private async tryScrollToTaskRowInPanel(
    filePath: string,
    lineNo: number,
    opts?: { skipInitialRender?: boolean },
  ): Promise<boolean> {
    const normalizedPath = normalizePath(filePath);
    const tryFind = (nodes: HTMLElement[]): HTMLElement | null => {
      for (const item of nodes) {
        const itemPath = item.getAttribute("data-task-file-path");
        const itemLineNo = item.getAttribute("data-task-line-no");
        if (itemPath && normalizePath(itemPath) === normalizedPath && Number(itemLineNo) === lineNo) return item;
      }
      for (const item of nodes) {
        const itemPath = item.getAttribute("data-task-file-path");
        if (itemPath && normalizePath(itemPath) === normalizedPath) return item;
      }
      return null;
    };

    if (!opts?.skipInitialRender) {
      await this.requestRender();
      await new Promise((r) => setTimeout(r, 300));
    } else {
      await new Promise((r) => setTimeout(r, 60));
    }
    const container = this.containerEl.children[1];
    let items = Array.from(container.querySelectorAll<HTMLElement>(".rslatte-timeline-item"));
    let target = tryFind(items);
    if (!target) {
      await this.requestRender();
      await new Promise((r) => setTimeout(r, opts?.skipInitialRender ? 400 : 500));
      items = Array.from(container.querySelectorAll<HTMLElement>(".rslatte-timeline-item"));
      target = tryFind(items);
    }
    if (!target) return false;
    // 与提醒跳转一致：跳过首屏 render 时用 auto，减少与已触发整页 render 叠乘的 smooth 滚动抖动
    target.scrollIntoView({ behavior: opts?.skipInitialRender ? "auto" : "smooth", block: "center" });
    target.addClass("rslatte-task-highlight");
    window.setTimeout(() => target?.removeClass("rslatte-task-highlight"), 2000);
    return true;
  }

  /** 在侧栏 DOM 中查找带 data-schedule-file-path 的日程行并滚动高亮 */
  private async tryScrollToScheduleRowInPanel(
    filePath: string,
    lineNo: number,
    opts?: { skipInitialRender?: boolean }
  ): Promise<boolean> {
    const normalizedPath = normalizePath(filePath);
    const tryFind = (nodes: HTMLElement[]): HTMLElement | null => {
      for (const item of nodes) {
        const itemPath = item.getAttribute("data-schedule-file-path");
        const itemLineNo = item.getAttribute("data-schedule-line-no");
        if (itemPath && normalizePath(itemPath) === normalizedPath && Number(itemLineNo) === lineNo) return item;
      }
      for (const item of nodes) {
        const itemPath = item.getAttribute("data-schedule-file-path");
        const itemLineNo = item.getAttribute("data-schedule-line-no");
        if (itemPath && normalizePath(itemPath) === normalizedPath && itemLineNo !== null) {
          const ln = Number(itemLineNo);
          if (Number.isFinite(ln) && Math.abs(ln - lineNo) <= 2) return item;
        }
      }
      for (const item of nodes) {
        const itemPath = item.getAttribute("data-schedule-file-path");
        if (itemPath && normalizePath(itemPath) === normalizedPath) return item;
      }
      return null;
    };

    if (!opts?.skipInitialRender) {
      await this.requestRender();
      await new Promise((r) => setTimeout(r, 300));
    } else {
      await new Promise((r) => setTimeout(r, 60));
    }
    const container = this.containerEl.children[1];
    let items = Array.from(container.querySelectorAll<HTMLElement>(".rslatte-timeline-item"));
    let target = tryFind(items);
    if (!target) {
      await this.requestRender();
      await new Promise((r) => setTimeout(r, opts?.skipInitialRender ? 400 : 500));
      items = Array.from(container.querySelectorAll<HTMLElement>(".rslatte-timeline-item"));
      target = tryFind(items);
    }
    if (!target) return false;
    target.scrollIntoView({ behavior: opts?.skipInitialRender ? "auto" : "smooth", block: "center" });
    target.addClass("rslatte-task-highlight");
    window.setTimeout(() => target?.removeClass("rslatte-task-highlight"), 2000);
    return true;
  }

  /** 对外：切到「日程安排」子页签并滚动高亮对应日程行（供 Today 等入口调用）。 */
  public async focusScheduleByFileLine(filePath: string, lineNo: number): Promise<void> {
    const { schedule } = this.moduleTabAvailability();
    if (!schedule) {
      await this.openTaskInFile(filePath, lineNo);
      return;
    }
    this._subTab = "schedule";
    await this.requestRender();
    const ok = await this.tryScrollToScheduleRowInPanel(filePath, lineNo, { skipInitialRender: true });
    if (!ok) await this.openTaskInFile(filePath, lineNo);
  }

  /**
   * 在侧栏 DOM 中查找带 data-memo-file-path 的提醒行并滚动高亮（与任务行 data-task-* 区分）。
   */
  private async tryScrollToMemoRowInPanel(
    filePath: string,
    lineNo: number,
    opts?: { skipInitialRender?: boolean }
  ): Promise<boolean> {
    const normalizedPath = normalizePath(filePath);
    const tryFind = (nodes: HTMLElement[]): HTMLElement | null => {
      for (const item of nodes) {
        const itemPath = item.getAttribute("data-memo-file-path");
        const itemLineNo = item.getAttribute("data-memo-line-no");
        if (itemPath && normalizePath(itemPath) === normalizedPath && Number(itemLineNo) === lineNo) return item;
      }
      for (const item of nodes) {
        const itemPath = item.getAttribute("data-memo-file-path");
        const itemLineNo = item.getAttribute("data-memo-line-no");
        if (itemPath && normalizePath(itemPath) === normalizedPath && itemLineNo !== null) {
          const ln = Number(itemLineNo);
          if (Number.isFinite(ln) && Math.abs(ln - lineNo) <= 2) return item;
        }
      }
      for (const item of nodes) {
        const itemPath = item.getAttribute("data-memo-file-path");
        if (itemPath && normalizePath(itemPath) === normalizedPath) return item;
      }
      return null;
    };

    if (!opts?.skipInitialRender) {
      await this.requestRender();
      await new Promise((r) => setTimeout(r, 300));
    } else {
      await new Promise((r) => setTimeout(r, 60));
    }
    const container = this.containerEl.children[1];
    let items = Array.from(container.querySelectorAll<HTMLElement>(".rslatte-timeline-item"));
    let target = tryFind(items);
    if (!target) {
      await this.requestRender();
      await new Promise((r) => setTimeout(r, opts?.skipInitialRender ? 400 : 500));
      items = Array.from(container.querySelectorAll<HTMLElement>(".rslatte-timeline-item"));
      target = tryFind(items);
    }
    if (!target) return false;
    // auto：避免与 focusMemoRowByFileLine 已触发的整页 render 叠加多次 smooth 滚动造成「抖动」
    target.scrollIntoView({ behavior: "auto", block: "center" });
    target.addClass("rslatte-task-highlight");
    window.setTimeout(() => target?.removeClass("rslatte-task-highlight"), 2000);
    return true;
  }

  private moduleTabAvailability(): { memo: boolean; task: boolean; schedule: boolean } {
    const normalizeBool = (v: any, fallback: boolean): boolean => {
      if (v === true || v === "true" || v === 1 || v === "1") return true;
      if (v === false || v === "false" || v === 0 || v === "0") return false;
      if (typeof v === "boolean") return v;
      return fallback;
    };
    const me2: any = (this.plugin.settings as any)?.moduleEnabledV2 ?? {};
    const memo = normalizeBool(me2.memo, this.plugin.isPipelineModuleEnabled("memo"));
    const task = normalizeBool(me2.task, this.plugin.isPipelineModuleEnabled("task"));
    const schedule = normalizeBool(me2.schedule, memo);
    return { memo, task, schedule };
  }

  /** 对外：仅切换任务侧边栏顶层子页签（事项提醒 / 日程安排 / 任务清单）。 */
  public async switchToSubTab(tab: TaskSubTab): Promise<void> {
    const avail = this.moduleTabAvailability();
    if (tab === "memo" && !avail.memo) return;
    if (tab === "schedule" && !avail.schedule) return;
    if (tab === "task" && !avail.task) return;
    if (this._subTab === tab) return;
    this._subTab = tab;
    await this.requestRender();
  }

  /** 切换至「任务清单」子页签并滚动高亮对应任务行；失败则打开源文件。 */
  public async focusTaskRowByFileLine(filePath: string, lineNo: number): Promise<void> {
    const { task } = this.moduleTabAvailability();
    if (!task) {
      await this.openTaskInFile(filePath, lineNo);
      return;
    }
    this._subTab = "task";
    await this.expandTaskPanelSectionsForFileLine(filePath, lineNo);
    await this.requestRender();
    // 已整页 render，勿在 tryScroll 内再 requestRender + 长延迟，避免与 Today→任务跳转叠成多次全量重绘（侧栏闪动）
    const ok = await this.tryScrollToTaskRowInPanel(filePath, lineNo, { skipInitialRender: true });
    if (!ok) await this.openTaskInFile(filePath, lineNo);
  }

  /** 切换至「事项提醒」子页签并滚动高亮对应提醒行；失败则打开源文件。 */
  public async focusMemoRowByFileLine(filePath: string, lineNo: number): Promise<void> {
    const { memo } = this.moduleTabAvailability();
    if (!memo) {
      await this.openTaskInFile(filePath, lineNo);
      return;
    }
    this._subTab = "memo";
    await this.requestRender();
    // 已完整 render 过，避免 tryScroll 内再整页 requestRender 一次导致重复异步拉桶与多次滚动抖动
    const ok = await this.tryScrollToMemoRowInPanel(filePath, lineNo, { skipInitialRender: true });
    if (!ok) await this.openTaskInFile(filePath, lineNo);
  }

  // =========================
  // Memo all-list (no buttons in Step5-2cA)
  // =========================

  private renderMemoAllTimeline(parent: HTMLElement, memos: RSLatteIndexItem[]) {
    for (const m of memos) {
      const row = parent.createDiv({ cls: "rslatte-timeline-item" });
      row.tabIndex = 0;
      row.setAttribute("data-memo-file-path", normalizePath(m.filePath));
      row.setAttribute("data-memo-line-no", String(m.lineNo));

      // 左侧时间轴轨道
      const gutter = row.createDiv({ cls: "rslatte-timeline-gutter" });
      const dot = gutter.createDiv({ cls: "rslatte-timeline-dot" });
      dot.setText(this.statusIcon(m));
      gutter.createDiv({ cls: "rslatte-timeline-line" });

      // 右侧内容
      const content = row.createDiv({ cls: "rslatte-timeline-content" });

      // title + actions
      const titleRow = content.createDiv({ cls: "rslatte-timeline-title-row rslatte-task-row" });
      const title = titleRow.createDiv({ cls: "rslatte-timeline-text rslatte-task-title" });
      renderTextWithContactRefs(this.app, title, this.buildReminderDisplayText(m));

      const actionRow = titleRow.createDiv({ cls: "rslatte-task-actions rslatte-task-actions-compact" });
      const memoRefreshAll = async () => {
        await this.manualRefreshMemoIndexAndMaybeSync();
        this.refresh();
      };
      const memoBtnsAll: SidePanelCardActionEntry[] = [
        {
          id: "memo_edit",
          kind: "icon",
          icon: "✏️",
          title: "修改提醒信息",
          run: async () => {
            new EditMemoModal(this.app, this.plugin, m).open();
          },
        },
      ];
      const starred = !!(m as any).starred;
      memoBtnsAll.push({
        id: "memo_star",
        kind: "icon",
        icon: starred ? "☆" : "⭐",
        title: starred ? "取消星标" : "星标",
        run: async () => {
          await writeMemoSetStarred(this.plugin.taskRSLatte, m as any, !starred);
        await this.appendUiWorkEvent({
          kind: "memo",
          action: "update",
          summary: `${starred ? "☆" : "⭐"} ${starred ? "取消星标提醒" : "星标提醒"} ${String(m.text ?? m.raw ?? "").trim() || "未命名提醒"}`,
          ref: { uid: (m as any).uid, file_path: m.filePath, line_no: m.lineNo, starred: !starred },
        });
          await memoRefreshAll();
        },
      });
    const invalidated = String((m as any)?.extra?.invalidated ?? "").trim() === "1";
    if (invalidated || this.isRepeatingMemoOrSchedule(m)) {
        memoBtnsAll.push({
          id: "memo_invalidate",
          kind: "icon",
          icon: invalidated ? "♻️" : "🚫",
          title: invalidated ? "恢复自动生成下一次提醒" : "失效（停止自动生成下一次提醒）",
          run: async () => {
            await writeMemoSetInvalidated(this.plugin.taskRSLatte, m as any, !invalidated);
            await this.appendUiWorkEvent({
              kind: "memo",
              action: "status",
              summary: `${invalidated ? "♻️ 恢复提醒周期" : "🚫 失效提醒"} ${String(m.text ?? m.raw ?? "").trim() || "未命名提醒"}`,
              ref: { uid: (m as any).uid, file_path: m.filePath, line_no: m.lineNo, invalidated: !invalidated },
              metrics: { invalidated: !invalidated ? 1 : 0 },
            });
            await memoRefreshAll();
          },
        });
      }
      if (this.canShowArrangeMemoButton(m)) {
        memoBtnsAll.push({
          id: "memo_arrange",
          kind: "icon",
          icon: "📌",
          title: "安排（转任务或转日程）",
          run: async () => {
            new ArrangeMemoModal(this.app, this.plugin, m, () => {
              void this.manualRefreshMemoIndexAndMaybeSync();
              this.refresh();
            }).open();
          },
        });
      }
      for (const icon of this.taskActionOrder(String((m as any).status ?? ""))) {
        if (icon === "⛔") {
          memoBtnsAll.push({
            id: "memo_cancel",
            kind: "icon",
            icon: "⛔",
            title: "标记为取消",
            run: async () => {
              await writeMemoApplyStatus(this.plugin.taskRSLatte, m as any, "CANCELLED", { skipWorkEvent: true });
              await this.appendUiWorkEvent({
                kind: "memo",
                action: "cancelled",
                summary: `⛔ 提醒取消 ${String(m.text ?? m.raw ?? "").trim() || "未命名提醒"}`,
                ref: { uid: (m as any).uid, file_path: m.filePath, line_no: m.lineNo, status: "CANCELLED" },
                metrics: { status: "CANCELLED" },
              });
              await memoRefreshAll();
            },
          });
        } else if (icon === "✅") {
          memoBtnsAll.push({
            id: "memo_done",
            kind: "icon",
            icon: "✅",
            title: "标记为完成",
            run: async () => {
              await writeMemoApplyStatus(this.plugin.taskRSLatte, m as any, "DONE", { skipWorkEvent: true });
              await this.appendUiWorkEvent({
                kind: "memo",
                action: "done",
                summary: `✅ 提醒完成 ${String(m.text ?? m.raw ?? "").trim() || "未命名提醒"}`,
                ref: { uid: (m as any).uid, file_path: m.filePath, line_no: m.lineNo, status: "DONE" },
                metrics: { status: "DONE" },
              });
              await memoRefreshAll();
            },
          });
        }
      }
      this.mountSidePanelCardActions(actionRow, memoBtnsAll, this.getMoreIdsForSidePanelCard("memo"));

      this.renderReminderUrgencyBadge(content, m);
      this.renderReminderArrangedLinkRow(content, m);

      // meta
      const meta = content.createDiv({ cls: "rslatte-timeline-meta" });
      meta.setText(this.buildReminderMeta(m));
      this.attachTimelineMetaTooltip(meta, this.buildReminderMetaTooltip(m));

      // file path
      content.createDiv({ cls: "rslatte-timeline-from", text: this.shortPath(m.filePath) });

      const open = async () => {
        try {
          // 规则：点击卡片（非联系人姓名）始终打开提醒所在日记条目
          await this.openTaskInFile(m.filePath, m.lineNo);
        } catch (e: any) {
          new Notice(`打开失败：${e?.message ?? String(e)}`);
        }
      };

      row.addEventListener("click", () => void open());
      row.addEventListener("keydown", (ev) => {
        if ((ev as KeyboardEvent).key === "Enter") void open();
      });
    }
  }

  private renderRecentClosedMemoTimeline(parent: HTMLElement, memos: RSLatteIndexItem[]) {
    for (const m of memos) {
      const row = parent.createDiv({ cls: "rslatte-timeline-item" });
      row.tabIndex = 0;
      row.setAttribute("data-memo-file-path", normalizePath(m.filePath));
      row.setAttribute("data-memo-line-no", String(m.lineNo));
      const gutter = row.createDiv({ cls: "rslatte-timeline-gutter" });
      const dot = gutter.createDiv({ cls: "rslatte-timeline-dot" });
      dot.setText(this.statusIcon(m));
      gutter.createDiv({ cls: "rslatte-timeline-line" });

      const content = row.createDiv({ cls: "rslatte-timeline-content" });
      const titleRow = content.createDiv({ cls: "rslatte-timeline-title-row rslatte-task-row" });
      const title = titleRow.createDiv({ cls: "rslatte-timeline-text rslatte-task-title" });
      renderTextWithContactRefs(this.app, title, this.buildReminderDisplayText(m));

      const actionRow = titleRow.createDiv({ cls: "rslatte-task-actions rslatte-task-actions-compact" });
      const closedMemoBtns: SidePanelCardActionEntry[] = [
        {
          id: "memo_closed_restore",
          kind: "icon",
          icon: "♻️",
          title: "恢复",
          run: async () => {
            const invalidated = String((m as any)?.extra?.invalidated ?? "").trim() === "1";
            const st = String((m as any)?.status ?? "").trim().toUpperCase();
            if (invalidated) {
              await writeMemoSetInvalidated(this.plugin.taskRSLatte, m as any, false);
              await this.appendUiWorkEvent({
                kind: "memo",
                action: "recover",
                summary: `♻️ 恢复提醒周期 ${String(m.text ?? m.raw ?? "").trim() || "未命名提醒"}`,
                ref: { uid: (m as any).uid, file_path: m.filePath, line_no: m.lineNo, invalidated: false },
              });
            }
            if (st === "DONE" || st === "CANCELLED") {
              await writeMemoApplyStatus(this.plugin.taskRSLatte, m as any, "IN_PROGRESS", { skipWorkEvent: true });
              await this.appendUiWorkEvent({
                kind: "memo",
                action: "recover",
                summary: `♻️ 恢复提醒 ${String(m.text ?? m.raw ?? "").trim() || "未命名提醒"}`,
                ref: { uid: (m as any).uid, file_path: m.filePath, line_no: m.lineNo, status: "IN_PROGRESS" },
                metrics: { status: "IN_PROGRESS" },
              });
            }
            await this.manualRefreshMemoIndexAndMaybeSync();
            this.refresh();
          },
        },
      ];
      this.mountSidePanelCardActions(actionRow, closedMemoBtns, this.getMoreIdsForSidePanelCard("memoClosed"));

      this.renderReminderUrgencyBadge(content, m);
      this.renderReminderArrangedLinkRow(content, m);
      const meta = content.createDiv({ cls: "rslatte-timeline-meta" });
      meta.setText(this.buildReminderMeta(m));
      this.attachTimelineMetaTooltip(meta, this.buildReminderMetaTooltip(m));
      content.createDiv({ cls: "rslatte-timeline-from", text: this.shortPath(m.filePath) });

      const open = async () => {
        try {
          await this.openTaskInFile(m.filePath, m.lineNo);
        } catch (e: any) {
          new Notice(`打开失败：${e?.message ?? String(e)}`);
        }
      };
      row.addEventListener("click", () => void open());
      row.addEventListener("keydown", (ev) => {
        if ((ev as KeyboardEvent).key === "Enter") void open();
      });
    }
  }

  private buildReminderDisplayText(m: RSLatteIndexItem): string {
    const base = String(m.text || m.raw || "").trim();
    if (!base) return base;
    const starred = !!(m as any).starred;
    if (!starred) return base;
    return `⭐ ${base}`;
  }

  private buildScheduleMeta(m: RSLatteIndexItem): string {
    const extra = ((m as any)?.extra ?? {}) as Record<string, string>;
    const sm = (this.plugin.settings as any)?.scheduleModule;
    const cat = labelForScheduleCategoryId(sm, String(extra.schedule_category ?? "").trim());
    const date = String((m as any)?.memoDate ?? "").trim() || "—";
    const rrRaw = normalizeRepeatRuleToken(String((m as any)?.repeatRule ?? "").trim().toLowerCase());
    const repeatMap: Record<string, string> = {
      none: "不重复",
      weekly: "每周",
      monthly: "每月",
      quarterly: "每季",
      yearly: "每年",
    };
    const repeat = repeatMap[rrRaw] ?? (rrRaw || "不重复");
    const st = String((m as any)?.status ?? "").trim().toUpperCase();
    const statusMap: Record<string, string> = { TODO: "TODO", IN_PROGRESS: "进行中", DONE: "已完成", CANCELLED: "已取消" };
    return `${cat} · 📅${date} · 🔁${repeat} · ${(statusMap[st] ?? st) || "—"}`;
  }

  private renderScheduleAllTimeline(parent: HTMLElement, memos: RSLatteIndexItem[]) {
    for (const m of memos) {
      const row = parent.createDiv({ cls: "rslatte-timeline-item" });
      row.tabIndex = 0;
      row.setAttribute("data-schedule-file-path", normalizePath(m.filePath));
      row.setAttribute("data-schedule-line-no", String(m.lineNo));
      const gutter = row.createDiv({ cls: "rslatte-timeline-gutter" });
      const dot = gutter.createDiv({ cls: "rslatte-timeline-dot" });
      dot.setText(this.statusIcon(m));
      gutter.createDiv({ cls: "rslatte-timeline-line" });
      const content = row.createDiv({ cls: "rslatte-timeline-content" });
      const titleRow = content.createDiv({ cls: "rslatte-timeline-title-row rslatte-task-row" });
      const title = titleRow.createDiv({ cls: "rslatte-timeline-text rslatte-task-title" });
      renderTextWithContactRefs(this.app, title, this.buildReminderDisplayText(m));
      const actionRow = titleRow.createDiv({ cls: "rslatte-task-actions rslatte-task-actions-compact" });
      const schedRefresh = async () => {
        await this.manualRefreshScheduleIndexAndMaybeSync();
        this.refresh();
      };
      const schedButtons: SidePanelCardActionEntry[] = [
        {
          id: "schedule_edit",
          kind: "icon",
          icon: "✏️",
          title: "修改日程信息",
          run: async () => {
            new EditScheduleModal(this.app, this.plugin, m).open();
          },
        },
      ];
      const starred = !!(m as any).starred;
      schedButtons.push({
        id: "schedule_star",
        kind: "icon",
        icon: starred ? "☆" : "⭐",
        title: starred ? "取消星标" : "星标",
        run: async () => {
          await writeScheduleSetStarred(this.plugin.taskRSLatte, m as any, !starred);
        await this.appendUiWorkEvent({
          kind: "schedule",
          action: "update",
          summary: `${starred ? "☆" : "⭐"} ${starred ? "取消星标日程" : "星标日程"} ${String(m.text ?? m.raw ?? "").trim() || "未命名日程"}`,
          ref: { uid: (m as any).uid, file_path: m.filePath, line_no: m.lineNo, category: "schedule", starred: !starred },
        });
          await schedRefresh();
        },
      });
      const invalidated = String((m as any)?.extra?.invalidated ?? "").trim() === "1";
      if (invalidated || this.isRepeatingMemoOrSchedule(m)) {
        schedButtons.push({
          id: "schedule_invalidate",
          kind: "icon",
          icon: invalidated ? "♻️" : "🚫",
          title: invalidated ? "恢复自动生成下一次日程" : "失效（停止自动生成下一次日程）",
          run: async () => {
            await writeScheduleSetInvalidated(this.plugin.taskRSLatte, m as any, !invalidated);
            await this.appendUiWorkEvent({
              kind: "schedule",
              action: "status",
              summary: `${invalidated ? "♻️ 恢复日程周期" : "🚫 失效日程"} ${String(m.text ?? m.raw ?? "").trim() || "未命名日程"}`,
              ref: { uid: (m as any).uid, file_path: m.filePath, line_no: m.lineNo, category: "schedule", invalidated: !invalidated },
              metrics: { invalidated: !invalidated ? 1 : 0 },
            });
            await schedRefresh();
          },
        });
      }
      const schedSt = String((m as any).status ?? "").trim().toUpperCase();
      for (const icon of this.taskActionOrder(schedSt)) {
        if (icon === "⛔") {
          schedButtons.push({
            id: "schedule_cancel",
            kind: "icon",
            icon: "⛔",
            title: "标记为取消",
            run: async () => {
              await writeScheduleApplyStatus(this.plugin.taskRSLatte, m as any, "CANCELLED", { skipWorkEvent: true });
              await this.appendUiWorkEvent({
                kind: "schedule",
                action: "cancelled",
                summary: `⛔ 日程取消 ${String(m.text ?? m.raw ?? "").trim() || "未命名日程"}`,
                ref: { uid: (m as any).uid, file_path: m.filePath, line_no: m.lineNo, category: "schedule", status: "CANCELLED" },
                metrics: { status: "CANCELLED", category: "schedule" },
              });
              await schedRefresh();
            },
          });
        } else if (icon === "✅") {
          schedButtons.push({
            id: "schedule_end",
            kind: "icon",
            icon: "✅",
            title: "直接结束日程",
            run: async () => {
              await this.performScheduleDirectEnd(m);
            },
          });
          schedButtons.push({
            id: "schedule_end_followup",
            kind: "icon",
            icon: "⏭",
            title: "结束并新增任务、提醒或日程…",
            run: async () => {
              this.openScheduleEndWithFollowupModal(m);
            },
          });
        }
      }
      if (schedSt === "TODO") {
        schedButtons.push({
          id: "schedule_end",
          kind: "icon",
          icon: "✅",
          title: "直接结束日程",
          run: async () => {
            await this.performScheduleDirectEnd(m);
          },
        });
        schedButtons.push({
          id: "schedule_end_followup",
          kind: "icon",
          icon: "⏭",
          title: "结束并新增任务、提醒或日程…",
          run: async () => {
            this.openScheduleEndWithFollowupModal(m);
          },
        });
      }
      this.mountSidePanelCardActions(actionRow, schedButtons, this.getMoreIdsForSidePanelCard("schedule"));
      this.renderReminderUrgencyBadge(content, m);
      this.renderScheduleLinkedTaskRow(content, m);
      this.renderScheduleFollowupRow(content, m);
      this.renderScheduleLinkedOutputRow(content, m);
      const meta = content.createDiv({ cls: "rslatte-timeline-meta" });
      meta.setText(this.buildScheduleMeta(m));
      content.createDiv({ cls: "rslatte-timeline-from", text: this.shortPath(m.filePath) });
      row.onclick = () => void this.openTaskInFile(m.filePath, m.lineNo);
      row.onkeydown = (ev) => {
        if ((ev as KeyboardEvent).key === "Enter") void this.openTaskInFile(m.filePath, m.lineNo);
      };
    }
  }

  private renderRecentClosedScheduleTimeline(parent: HTMLElement, memos: RSLatteIndexItem[]) {
    for (const m of memos) {
      const row = parent.createDiv({ cls: "rslatte-timeline-item" });
      row.tabIndex = 0;
      row.setAttribute("data-schedule-file-path", normalizePath(m.filePath));
      row.setAttribute("data-schedule-line-no", String(m.lineNo));
      const gutter = row.createDiv({ cls: "rslatte-timeline-gutter" });
      const dot = gutter.createDiv({ cls: "rslatte-timeline-dot" });
      dot.setText(this.statusIcon(m));
      gutter.createDiv({ cls: "rslatte-timeline-line" });
      const content = row.createDiv({ cls: "rslatte-timeline-content" });
      const titleRow = content.createDiv({ cls: "rslatte-timeline-title-row rslatte-task-row" });
      const title = titleRow.createDiv({ cls: "rslatte-timeline-text rslatte-task-title" });
      renderTextWithContactRefs(this.app, title, this.buildReminderDisplayText(m));
      const actionRow = titleRow.createDiv({ cls: "rslatte-task-actions rslatte-task-actions-compact" });
      const closedSchedButtons: SidePanelCardActionEntry[] = [
        {
          id: "schedule_closed_restore",
          kind: "icon",
          icon: "♻️",
          title: "恢复",
          run: async () => {
            const invalidated = String((m as any)?.extra?.invalidated ?? "").trim() === "1";
            const st = String((m as any)?.status ?? "").trim().toUpperCase();
            if (invalidated) {
              await writeScheduleSetInvalidated(this.plugin.taskRSLatte, m as any, false);
              await this.appendUiWorkEvent({
                kind: "schedule",
                action: "recover",
                summary: `♻️ 恢复日程周期 ${String(m.text ?? m.raw ?? "").trim() || "未命名日程"}`,
                ref: { uid: (m as any).uid, file_path: m.filePath, line_no: m.lineNo, category: "schedule", invalidated: false },
              });
            }
            if (st === "DONE" || st === "CANCELLED") {
              await writeScheduleApplyStatus(this.plugin.taskRSLatte, m as any, "IN_PROGRESS", { skipWorkEvent: true });
              await this.appendUiWorkEvent({
                kind: "schedule",
                action: "recover",
                summary: `♻️ 恢复日程 ${String(m.text ?? m.raw ?? "").trim() || "未命名日程"}`,
                ref: { uid: (m as any).uid, file_path: m.filePath, line_no: m.lineNo, category: "schedule", status: "IN_PROGRESS" },
                metrics: { status: "IN_PROGRESS", category: "schedule" },
              });
            }
            await this.manualRefreshScheduleIndexAndMaybeSync();
            this.refresh();
          },
        },
      ];
      const exFollow = ((m as any)?.extra ?? {}) as Record<string, string>;
      const hasFollowup =
        String(exFollow.followup_task_uid ?? "").trim() ||
        String(exFollow.followup_memo_uid ?? "").trim() ||
        String(exFollow.followup_schedule_uid ?? "").trim();
      const stClosed = String((m as any)?.status ?? "").trim().toUpperCase();
      if (!hasFollowup && stClosed === "DONE") {
        closedSchedButtons.push({
          id: "schedule_closed_followup",
          kind: "icon",
          icon: "🗂",
          title: "补充后续任务、提醒或日程（写入本日程 meta）",
          run: async () => {
            this.openSchedulePosthocFollowupModal(m);
          },
        });
      }
      this.mountSidePanelCardActions(actionRow, closedSchedButtons, this.getMoreIdsForSidePanelCard("scheduleClosed"));
      this.renderReminderUrgencyBadge(content, m);
      this.renderScheduleLinkedTaskRow(content, m);
      this.renderScheduleFollowupRow(content, m);
      this.renderScheduleLinkedOutputRow(content, m);
      const meta = content.createDiv({ cls: "rslatte-timeline-meta" });
      meta.setText(this.buildScheduleMeta(m));
      content.createDiv({ cls: "rslatte-timeline-from", text: this.shortPath(m.filePath) });
      row.onclick = () => void this.openTaskInFile(m.filePath, m.lineNo);
      row.onkeydown = (ev) => {
        if ((ev as KeyboardEvent).key === "Enter") void this.openTaskInFile(m.filePath, m.lineNo);
      };
    }
  }

  /** 日程 meta `linked_output_id` → 单行展示并可跳转输出侧栏（样式与 `renderScheduleLinkedTaskRow` 一致） */
  private renderScheduleLinkedOutputRow(content: HTMLElement, m: RSLatteIndexItem): void {
    const ex = ((m as any)?.extra ?? {}) as Record<string, string>;
    const outputId = String(ex.linked_output_id ?? "").trim();
    if (!outputId) return;
    const row = content.createDiv({ cls: "rslatte-reminder-arranged-row rslatte-schedule-followup-row" });
    row.createSpan({ cls: "rslatte-schedule-followup-label", text: "关联输出：" });
    const kindEl = row.createSpan({ cls: "rslatte-reminder-arranged-kind", text: "输出" });
    const descEl = row.createSpan({ cls: "rslatte-reminder-arranged-desc", text: "…" });
    const dateEl = row.createSpan({ cls: "rslatte-reminder-arranged-date", text: "…" });
    row.tabIndex = 0;
    row.setAttr("role", "button");
    row.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void this.navigateToLinkedOutputById(outputId);
    });
    row.addEventListener("keydown", (ev) => {
      if ((ev as KeyboardEvent).key === "Enter") {
        ev.preventDefault();
        ev.stopPropagation();
        void this.navigateToLinkedOutputById(outputId);
      }
    });
    void this.hydrateScheduleLinkedOutputRow(outputId, row, kindEl, descEl, dateEl);
  }

  private async hydrateScheduleLinkedOutputRow(
    outputId: string,
    row: HTMLElement,
    kindEl: HTMLElement,
    descEl: HTMLElement,
    dateEl: HTMLElement,
  ): Promise<void> {
    try {
      const snap = await this.plugin.outputRSLatte?.getSnapshot?.();
      const hit = (snap?.items ?? []).find((x) => String(x.outputId ?? "").trim() === outputId);
      if (!hit) {
        descEl.setText("索引中未找到");
        dateEl.setText("—");
        row.addClass("rslatte-reminder-arranged-row--missing");
        row.setAttr("title", `点击尝试跳转输出\noutput_id=${outputId}`);
        return;
      }
      const isP = outputIndexItemIsProjectKind(hit);
      kindEl.setText(isP ? "项目输出" : "输出");
      const title = String(hit.title ?? "").trim() || hit.filePath;
      descEl.setText(title);
      descEl.setAttr("title", title);
      const cd = String(hit.createDate ?? "").trim();
      dateEl.setText(cd ? `创建 ${cd}` : "—");
      row.setAttr(
        "title",
        `点击定位输出\n${isP ? "项目输出" : "输出"}｜${title}${cd ? `\n创建：${cd}` : ""}\n${hit.filePath}`,
      );
    } catch {
      descEl.setText("加载失败");
      dateEl.setText("—");
      row.addClass("rslatte-reminder-arranged-row--missing");
    }
  }

  private async navigateToLinkedOutputById(outputId: string): Promise<void> {
    const id = String(outputId ?? "").trim();
    if (!id) return;
    try {
      const snap = await this.plugin.outputRSLatte?.getSnapshot?.();
      const hit = (snap?.items ?? []).find((x) => String(x.outputId ?? "").trim() === id);
      if (!hit?.filePath) {
        new Notice("未找到关联输出文档");
        return;
      }
      await (this.plugin as any).activateOutputView?.();
      const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_OUTPUTS)[0];
      const v: any = leaf?.view;
      (this.plugin as any).__rslatteOutputFocusPath = normalizePath(hit.filePath);
      if (v && typeof v.openInProgressListFromStats === "function") {
        await v.openInProgressListFromStats();
      }
    } catch (e: any) {
      new Notice(`跳转失败：${e?.message ?? String(e)}`);
    }
  }

  private async queryScheduleBucketsSafe(
    upcomingDays: number,
    recentClosedDays: number
  ): Promise<{ todayFocus: RSLatteIndexItem[]; upcoming: RSLatteIndexItem[]; overdue: RSLatteIndexItem[]; activeOther: RSLatteIndexItem[]; recentClosed: RSLatteIndexItem[] }> {
    const svc: any = this.plugin.taskRSLatte as any;
    if (!svc) return { todayFocus: [], upcoming: [], overdue: [], activeOther: [], recentClosed: [] };
    if (typeof svc.queryScheduleBuckets === "function") {
      try {
        const groups = await svc.queryScheduleBuckets({ upcomingDays, recentClosedDays });
        return {
          todayFocus: Array.isArray(groups?.todayFocus) ? groups.todayFocus : [],
          upcoming: Array.isArray(groups?.upcoming) ? groups.upcoming : [],
          overdue: Array.isArray(groups?.overdue) ? groups.overdue : [],
          activeOther: Array.isArray(groups?.activeOther) ? groups.activeOther : [],
          recentClosed: Array.isArray(groups?.recentClosed) ? groups.recentClosed : [],
        };
      } catch {
        // fallback below
      }
    }
    return { todayFocus: [], upcoming: [], overdue: [], activeOther: [], recentClosed: [] };
  }

  private async queryReminderBucketsSafe(
    upcomingDays: number,
    recentClosedDays: number
  ): Promise<{ todayFocus: RSLatteIndexItem[]; overdue: RSLatteIndexItem[]; activeOther: RSLatteIndexItem[]; recentClosed: RSLatteIndexItem[] }> {
    const svc: any = this.plugin.taskRSLatte as any;
    if (!svc) {
      return { todayFocus: [], overdue: [], activeOther: [], recentClosed: [] };
    }
    if (svc && typeof svc.queryReminderBuckets === "function") {
      try {
        const groups = await svc.queryReminderBuckets({ upcomingDays, recentClosedDays });
        if (groups && typeof groups === "object") {
          return {
            todayFocus: Array.isArray(groups.todayFocus) ? groups.todayFocus : [],
            overdue: Array.isArray(groups.overdue) ? groups.overdue : [],
            activeOther: Array.isArray(groups.activeOther) ? groups.activeOther : [],
            recentClosed: Array.isArray(groups.recentClosed) ? groups.recentClosed : [],
          };
        }
      } catch {
        // fallback below
      }
    }

    const fallback = await svc.queryAllMemosWithTotal({
      maxItems: 200,
      statuses: ["TODO", "IN_PROGRESS", "DONE", "CANCELLED"],
    });
    return this.partitionReminderBuckets(fallback.items ?? [], upcomingDays, recentClosedDays);
  }

  private partitionReminderBuckets(
    items: RSLatteIndexItem[],
    upcomingDays: number,
    recentClosedDays: number
  ): { todayFocus: RSLatteIndexItem[]; overdue: RSLatteIndexItem[]; activeOther: RSLatteIndexItem[]; recentClosed: RSLatteIndexItem[] } {
    const today = getTaskTodayKey(this.plugin.settings as any);
    const dayMs = 24 * 60 * 60 * 1000;
    const toUtc = (ymd: string): number | null => {
      const m = String(ymd ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return null;
      return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    };
    const diff = (ymd: string): number | null => {
      const a = toUtc(today);
      const b = toUtc(ymd);
      if (a == null || b == null) return null;
      return Math.floor((b - a) / dayMs);
    };
    const createdTs = (it: RSLatteIndexItem) => {
      const v = toUtc(String((it as any)?.created_date ?? "").trim());
      return v == null ? Number.MAX_SAFE_INTEGER : v;
    };
    const dueTs = (it: RSLatteIndexItem) => {
      const v = toUtc(String((it as any)?.memoDate ?? "").trim());
      return v == null ? Number.MAX_SAFE_INTEGER : v;
    };

    const todayFocus: RSLatteIndexItem[] = [];
    const overdue: RSLatteIndexItem[] = [];
    const activeOther: RSLatteIndexItem[] = [];
    const recentClosed: RSLatteIndexItem[] = [];

    for (const it of items ?? []) {
      const anyIt: any = it as any;
      const extra = (anyIt?.extra ?? {}) as Record<string, string>;
      const status = String(anyIt?.status ?? "").trim().toUpperCase();
      const invalidated = String(extra.invalidated ?? "").trim() === "1";

      const closedYmd = String(anyIt?.done_date ?? "").trim()
        || String(anyIt?.cancelled_date ?? "").trim()
        || String(extra.invalidated_date ?? "").trim()
        || (invalidated ? String(anyIt?.updated_date ?? "").trim() : "")
        || (invalidated ? String(anyIt?.created_date ?? "").trim() : "");
      const cd = diff(closedYmd);
      if ((status === "DONE" || status === "CANCELLED" || invalidated) && cd != null && cd <= 0 && Math.abs(cd) <= recentClosedDays) {
        recentClosed.push(it);
        continue;
      }
      if (status === "DONE" || status === "CANCELLED" || invalidated) continue;

      const dd = diff(String(anyIt?.memoDate ?? "").trim());
      if (dd != null && dd < 0) overdue.push(it);
      else if (dd != null && dd <= upcomingDays) todayFocus.push(it);
      else activeOther.push(it);
    }

    const todayItems = todayFocus
      .filter((x) => diff(String((x as any)?.memoDate ?? "").trim()) === 0)
      .sort((a, b) => createdTs(a) - createdTs(b));
    const upcomingItems = todayFocus
      .filter((x) => {
        const d = diff(String((x as any)?.memoDate ?? "").trim());
        return d != null && d > 0 && d <= upcomingDays;
      })
      .sort((a, b) => createdTs(a) - createdTs(b));

    overdue.sort((a, b) => dueTs(a) - dueTs(b));
    activeOther.sort((a, b) => dueTs(a) - dueTs(b));
    recentClosed.sort((a, b) => {
      const ad = diff(String((a as any)?.done_date ?? "").trim() || String((a as any)?.cancelled_date ?? "").trim()) ?? -9999;
      const bd = diff(String((b as any)?.done_date ?? "").trim() || String((b as any)?.cancelled_date ?? "").trim()) ?? -9999;
      return ad - bd;
    });

    return { todayFocus: [...todayItems, ...upcomingItems], overdue, activeOther, recentClosed };
  }

  private statusIcon(t: RSLatteIndexItem): string {
    const st = String((t as any).status ?? "").trim();
    const phase = String((t as any).task_phase ?? "").trim();
    if (st === "DONE") return "✅";
    if (st === "CANCELLED") return "⛔";
    if (st === "TODO") return "☐";
    if (st === "IN_PROGRESS" || st === "IN-PROGRESS") {
      if (phase === "waiting_others") return "↻";
      if (phase === "waiting_until") return "⏸";
      return "▶";
    }
    return "⬛";
  }

  /** 状态名称，用于 dot 的 title 悬停提示 */
  private statusDisplayName(t: RSLatteIndexItem): string {
    const st = String((t as any).status ?? "").trim().toUpperCase();
    const phase = String((t as any).task_phase ?? "").trim();
    if (st === "DONE") return "已完成";
    if (st === "CANCELLED") return "已取消";
    if (st === "TODO") return "未开始";
    if (st === "IN_PROGRESS" || st === "IN-PROGRESS") {
      if (phase === "waiting_others") return "跟进中";
      if (phase === "waiting_until") return "等待中";
      return "处理中";
    }
    return "未知";
  }

  private getMoreIdsForSidePanelCard(
    which: "task" | "memo" | "memoClosed" | "schedule" | "scheduleClosed"
  ): Set<string> {
    const s = this.plugin.settings as any;
    const tp = s.taskPanel ?? {};
    const sm = s.scheduleModule ?? {};
    let arr: unknown = [];
    if (which === "task") arr = tp.sidePanelTaskCardActionsInMore;
    else if (which === "memo") arr = tp.sidePanelMemoCardActionsInMore;
    else if (which === "memoClosed") arr = tp.sidePanelMemoClosedCardActionsInMore;
    else if (which === "schedule") arr = sm.sidePanelScheduleCardActionsInMore;
    else arr = sm.sidePanelScheduleClosedCardActionsInMore;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === "string" && x.length > 0));
  }

  /** 更新类按钮统一走编排写 WorkEvent，避免与 service 内直写并存 */
  private async appendUiWorkEvent(p: {
    kind: "task" | "memo" | "schedule";
    action: "update" | "status" | "cancelled" | "done" | "start" | "recover" | "paused" | "continued";
    summary: string;
    ref?: Record<string, any>;
    metrics?: Record<string, any>;
    /** kind=task：供 WorkEvent 写入 contact_uids_* */
    taskContactEnrich?: { taskLine: string; followContactUids?: string[] };
  }): Promise<void> {
    await runExecutionFlowUi(this.plugin, EXECUTION_RECIPE.workEventOnly, {
      sync: false,
      workEvent: buildWorkEventUiAction({
        kind: p.kind,
        action: p.action,
        summary: p.summary,
        ref: p.ref,
        metrics: p.metrics,
        taskContactEnrich: p.kind === "task" ? p.taskContactEnrich : undefined,
      }),
    }, { actionLabel: "记录工作事件" });
  }

  /**
   * 按设置将部分操作收入「⋯」菜单；显隐仍由调用方传入的 buttons 列表决定。
   */
  private mountSidePanelCardActions(
    actionRow: HTMLElement,
    buttons: SidePanelCardActionEntry[],
    moreSet: Set<string>
  ): void {
    const primary: SidePanelCardActionEntry[] = [];
    const more: SidePanelCardActionEntry[] = [];
    for (const b of buttons) {
      if (moreSet.has(b.id)) more.push(b);
      else primary.push(b);
    }

    const runSafe = async (run: () => Promise<void>) => {
      try {
        await run();
      } catch (e: any) {
        new Notice(`操作失败：${e?.message ?? String(e)}`);
      }
    };

    const mountIcon = (parent: HTMLElement, b: Extract<SidePanelCardActionEntry, { kind: "icon" }>) => {
      const el = parent.createEl("button", { text: b.icon, cls: "rslatte-icon-only-btn" });
      el.title = b.title;
      el.onclick = async (ev) => {
        ev.stopPropagation();
        try {
          el.disabled = true;
          await runSafe(b.run);
        } finally {
          el.disabled = false;
        }
      };
    };

    const mountText = (parent: HTMLElement, b: Extract<SidePanelCardActionEntry, { kind: "text" }>) => {
      const el = parent.createEl("button", { text: b.text, cls: "rslatte-text-btn" });
      el.title = b.title;
      el.onclick = async (ev) => {
        ev.stopPropagation();
        try {
          el.disabled = true;
          await runSafe(b.run);
        } finally {
          el.disabled = false;
        }
      };
    };

    for (const b of primary) {
      if (b.kind === "icon") mountIcon(actionRow, b);
      else mountText(actionRow, b);
    }

    if (more.length === 0) return;

    const moreBtn = actionRow.createEl("button", { text: "⋯", cls: "rslatte-icon-only-btn rslatte-card-actions-more" });
    moreBtn.title = "更多操作";
    moreBtn.onclick = (ev) => {
      ev.stopPropagation();
      const menu = new Menu();
      for (const b of more) {
        menu.addItem((item) => {
          const title = b.kind === "icon" ? `${b.icon} ${b.title}` : b.text;
          item.setTitle(title);
          item.onClick(() => {
            void (async () => {
              await runSafe(b.run);
            })();
          });
        });
      }
      menu.showAtMouseEvent(ev);
    };
  }

  /**
   * 任务操作按钮可见性（按状态与 phase）
   * 返回 { icon, title, mode? } 列表，mode 用于区分 ⏸ 是「恢复 TODO」还是「进入等待」
   */
  private taskActionButtons(t: RSLatteIndexItem): Array<{ icon: string; title: string; mode?: "pause" | "wait_until" }> {
    const st = String((t as any).status ?? "").trim().toUpperCase();
    const phase = String((t as any).task_phase ?? "").trim();
    const starred = !!(t as any).starred;
    const out: Array<{ icon: string; title: string; mode?: "pause" | "wait_until" }> = [];

    if (st === "DONE" || st === "CANCELLED") {
      out.push({ icon: "▶", title: "开始处理任务" });
      return out;
    }

    if (st === "TODO") {
      out.push({ icon: "▶", title: "开始处理任务" });
      out.push({ icon: "⛔", title: "取消任务" });
      out.push({ icon: "↪", title: "延期" });
      out.push({ icon: starred ? "☆" : "⭐", title: starred ? "取消星标" : "星标" });
      return out;
    }

    if (st === "IN_PROGRESS" || st === "IN-PROGRESS") {
      if (phase !== "in_progress") out.push({ icon: "▶", title: "开始处理任务" });
      if (phase !== "waiting_others") out.push({ icon: "↻", title: "等待他人处理" });
      if (phase !== "waiting_until") out.push({ icon: "⏸", title: "进入等待状态", mode: "wait_until" });
      out.push({ icon: "⛔", title: "取消任务" });
      out.push({ icon: "✅", title: "完成任务" });
      out.push({ icon: "↪", title: "延期" });
      out.push({ icon: starred ? "☆" : "⭐", title: starred ? "取消星标" : "星标" });
      return out;
    }

    return out;
  }

  /** 项目任务/提醒仍用四状态，返回 ▶ ⏸ ⛔ ✅ 的可见顺序 */
  private taskActionOrder(statusRaw: string): Array<"▶" | "⏸" | "⛔" | "✅"> {
    const st = String(statusRaw || "").trim().toUpperCase();
    if (st === "DONE") return ["▶", "⏸"];
    if (st === "CANCELLED") return ["▶", "⏸"];
    if (st === "IN_PROGRESS" || st === "IN-PROGRESS") return ["⏸", "⛔", "✅"];
    return ["▶", "⛔"];
  }

  private shortPath(path: string): string {
    const p = (path ?? "").replace(/\\/g, "/");
    // 只展示最后两段，避免太长
    const parts = p.split("/").filter(Boolean);
    if (parts.length <= 2) return p;
    return parts.slice(parts.length - 2).join("/");
  }

  /**
   * 任务/提醒/日程侧栏：仅对清单行 `- [ ]`（未开始）、`- [/]`（进行中）打标签，
   * 与解析层 `mark→status`（TODO / IN_PROGRESS）一致；`[x]`/`[-]` 等闭环行不展示标签行。
   */
  private sidebarItemShowsCheckboxTags(it: RSLatteIndexItem): boolean {
    const st = String((it as any).status ?? "").trim().toUpperCase();
    return st === "TODO" || st === "IN_PROGRESS" || st === "IN-PROGRESS";
  }

  /** 周期任务 repeatRule → 侧栏「🔁」后展示文案（仅当已设置非 none 时调用） */
  private taskRepeatRuleDisplayLabel(rrRaw: string | undefined | null): string {
    const r = normalizeRepeatRuleToken(String(rrRaw ?? "").trim().toLowerCase());
    const map: Record<string, string> = {
      weekly: "每周",
      monthly: "每月",
      quarterly: "每季",
      yearly: "每年",
    };
    return map[r] ?? r;
  }

  /** 是否展示 meta 中的周期任务段：不设置 / none 时不展示，降低信息密度 */
  private taskRepeatRuleIsSet(rrRaw: string | undefined | null): boolean {
    const r = String(rrRaw ?? "").trim().toLowerCase();
    return !!r && r !== "none";
  }

  /** 构建任务条目的 meta 文本（与任务清单一致：尽量简洁，优先展示 created/due 与闭环时间） */
  private buildTimelineMeta(it: RSLatteIndexItem): string {
    const parts: string[] = [];
    const pressure = this.getTaskPressureMeta(it);
    if (pressure.label) parts.push(pressure.label);

    const estimateH = (it as any).estimate_h;
    if (estimateH != null && Number(estimateH) > 0) parts.push(`⏱️${Math.round(Number(estimateH))}`);

    const bizCat = String((it as any)?.extra?.task_category ?? "").trim();
    if (bizCat) parts.push(`🏷${bizCat}`);

    if (this.taskRepeatRuleIsSet((it as any)?.repeatRule)) {
      parts.push(`🔁${this.taskRepeatRuleDisplayLabel((it as any)?.repeatRule)}`);
    }

    const created = it.created_date;
    const due = it.planned_end;
    const start = it.actual_start;
    const scheduled = it.planned_start;
    const done = it.done_date;
    const cancelled = it.cancelled_date;

    // created / scheduled / start / due
    if (created) parts.push(`🆕${created}`);
    if (scheduled) parts.push(`⏱${scheduled}`);
    if (start) parts.push(`▶${start}`);
    if (due) parts.push(`📅${due}`);

    // 延期任务：显示延期次数 + 原始截至时间
    const postponeCount = (it as any).postpone_count;
    const originalDue = (it as any).original_due;
    if (postponeCount != null && Number(postponeCount) > 0) {
      const orig = originalDue && /^\d{4}-\d{2}-\d{2}$/.test(String(originalDue)) ? `📌${originalDue}` : "";
      parts.push(`↪${postponeCount}${orig}`);
    }

    // status close time
    if (it.status === "DONE" && done) parts.push(`✅${done}`);
    if (it.status === "CANCELLED" && cancelled) parts.push(`⛔${cancelled}`);

    return parts.join(" / ");
  }

  /** 等待/跟进信息条：从 meta 日期取 YYYY-MM-DD（兼容 ISO 等带时间前缀）。 */
  private taskFollowDateYmd(raw: unknown): string {
    const s = String(raw ?? "").trim();
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : "";
  }

  private buildFollowRowInfo(
    it: RSLatteIndexItem
  ): { contactsText: string; dateLabel: string; dateValue: string; phase: "waiting_until" | "waiting_others" } | null {
    const phaseRaw = String((it as any).task_phase ?? "").trim().toLowerCase();
    const phase = phaseRaw.startsWith("waiting_oth")
      ? "waiting_others"
      : phaseRaw.startsWith("waiting_unti") || phaseRaw === "waiting_until"
        ? "waiting_until"
        : "";
    if (!phase) return null;

    const followRaw = (it as any).follow_contact_uids ?? (it as any).followContactUids;
    const followUids = Array.isArray(followRaw)
      ? followRaw.map((x: any) => String(x ?? "").trim()).filter(Boolean)
      : String(followRaw ?? "").split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
    const waitYmd = this.taskFollowDateYmd((it as any).wait_until);
    const followUpYmd = this.taskFollowDateYmd((it as any).follow_up);
    let dateValue =
      phase === "waiting_others" ? (followUpYmd || waitYmd) : (waitYmd || followUpYmd);
    if (!dateValue) {
      if (followUids.length === 0) return null;
      dateValue = "—";
    }

    const followNamesRaw = (it as any).follow_contact_names ?? (it as any).follow_contact_name;
    const followNames = Array.isArray(followNamesRaw)
      ? followNamesRaw.map((x: any) => String(x ?? "").trim())
      : typeof followNamesRaw === "string"
        ? String(followNamesRaw)
            .split("|")
            .map((x) => x.trim())
            .filter(Boolean)
        : [];
    const contactsText = followUids.length > 0
      ? followUids.map((uid: string, idx: number) => {
          const nm = String(followNames[idx] ?? "").trim() || uid;
          return `[[C_${uid}|${nm}]]`;
        }).join("、")
      : "（未关联联系人）";
    const dateLabel = phase === "waiting_others" ? "下次跟进时间" : "等待到期日";
    return { contactsText, dateLabel, dateValue, phase };
  }

  /** 执行压力摘要：用于任务列表首屏快速判断“先做哪件”。 */
  private getTaskPressureMeta(it: RSLatteIndexItem): { label: string; level: "overdue" | "upcoming" | "active" | "none" } {
    const st = String((it as any).status ?? "").trim().toUpperCase();
    if (st === "DONE" || st === "CANCELLED") return { label: "", level: "none" };

    const phase = this.statusDisplayName(it);
    const due = String((it as any).planned_end ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return { label: `状态:${phase}`, level: "active" };

    const today = getTaskTodayKey(this.plugin.settings?.taskPanel ?? undefined);
    const dayMs = 24 * 60 * 60 * 1000;
    const toUtcDay = (ymd: string) => {
      const [y, m, d] = ymd.split("-").map((n) => Number(n));
      return Date.UTC(y, (m || 1) - 1, d || 1);
    };
    const diffDays = Math.floor((toUtcDay(due) - toUtcDay(today)) / dayMs);
    if (diffDays < 0) return { label: `状态:${phase} / 已超期${Math.abs(diffDays)}天`, level: "overdue" };
    if (diffDays <= 3) return { label: `状态:${phase} / 剩余${diffDays}天`, level: "upcoming" };
    return { label: `状态:${phase} / 剩余${diffDays}天`, level: "active" };
  }

  /**
   * 与 buildTimelineMeta 一一对应的中文说明，供悬停浮窗展示（不依赖图标理解）。
   */
  private buildTimelineMetaTooltip(it: RSLatteIndexItem): string {
    const lines: string[] = [];

    const estimateH = (it as any).estimate_h;
    if (estimateH != null && Number(estimateH) > 0) {
      lines.push(`工时评估：约 ${Math.round(Number(estimateH))} 小时`);
    }
    const bizCatTip = String((it as any)?.extra?.task_category ?? "").trim();
    if (bizCatTip) lines.push(`任务分类：${bizCatTip}`);
    if (this.taskRepeatRuleIsSet((it as any)?.repeatRule)) {
      lines.push(`周期任务：${this.taskRepeatRuleDisplayLabel((it as any)?.repeatRule)}`);
    }
    if (it.created_date) lines.push(`创建日：${it.created_date}`);
    if (it.planned_start) lines.push(`计划开始日：${it.planned_start}`);
    if (it.actual_start) lines.push(`实际开始日：${it.actual_start}`);
    if (it.planned_end) lines.push(`计划结束日：${it.planned_end}`);

    const taskPhase = (it as any).task_phase;
    const waitUntil = (it as any).wait_until;
    if (taskPhase === "waiting_until" && waitUntil) {
      const ymd = this.taskFollowDateYmd(waitUntil);
      if (ymd) lines.push(`等待到期日：${ymd}`);
    }

    const postponeCount = (it as any).postpone_count;
    const originalDue = (it as any).original_due;
    if (postponeCount != null && Number(postponeCount) > 0) {
      let line = `已延期次数：${postponeCount}`;
      if (originalDue && /^\d{4}-\d{2}-\d{2}$/.test(String(originalDue))) {
        line += `；首次延期前计划结束日：${originalDue}`;
      }
      lines.push(line);
    }

    if (it.status === "DONE" && it.done_date) lines.push(`实际完成日：${it.done_date}`);
    if (it.status === "CANCELLED" && it.cancelled_date) lines.push(`实际取消日：${it.cancelled_date}`);

    if (lines.length === 0) return "当前任务暂无日期类信息";
    return lines.join("\n");
  }

  /** 提醒 meta 的中文悬停说明（与 buildReminderMeta 对应） */
  private buildReminderMetaTooltip(m: RSLatteIndexItem): string {
    const lines: string[] = [];
    const cat = String((m.extra as any)?.cat ?? "").trim();
    if (cat) {
      const map: Record<string, string> = {
        dueReminder: "到期提醒",
        generalReminder: "一般提醒",
        important: "一般提醒",
        solarBirthday: "阳历生日",
        lunarBirthday: "农历生日",
        anniversary: "纪念日",
      };
      lines.push(`分类：${map[cat] ?? cat}`);
    }
    if (m.memoDate) lines.push(`提醒日期：${m.memoDate}`);
    else if (m.memoMmdd) lines.push(`提醒月日：${m.memoMmdd}`);
    if (m.created_date) lines.push(`创建日：${m.created_date}`);
    if (m.planned_start) lines.push(`计划开始日：${m.planned_start}`);
    if (m.done_date) lines.push(`实际完成日：${m.done_date}`);
    if (m.cancelled_date) lines.push(`实际取消日：${m.cancelled_date}`);
    const rr = normalizeRepeatRuleToken(String(m.repeatRule ?? "").trim().toLowerCase());
    if (rr && rr !== "none") {
      const map: Record<string, string> = {
        weekly: "每周重复",
        monthly: "每月重复",
        quarterly: "每季重复",
        yearly: "每年重复",
      };
      lines.push(`重复：${map[rr] ?? rr}`);
    }
    if (m.status && m.status !== "UNKNOWN") {
      const map: Record<string, string> = {
        TODO: "状态：待办",
        IN_PROGRESS: "状态：进行中",
        DONE: "状态：已完成",
        CANCELLED: "状态：已取消",
      };
      lines.push(map[m.status] ?? `状态：${m.status}`);
    }
    const ex2 = (m.extra as any) ?? {};
    const at = String(ex2.arranged_task_uid ?? "").trim();
    const asch = String(ex2.arranged_schedule_uid ?? "").trim();
    const ad = String(ex2.arranged_at ?? "").trim();
    if (at) lines.push(`已安排→任务 uid：${at}`);
    if (asch) lines.push(`已安排→日程 uid：${asch}`);
    if (ad && (at || asch || String(ex2.memo_arranged ?? "").trim() === "1")) {
      lines.push(`安排日：${ad}`);
    }
    if (lines.length === 0) return "提醒摘要";
    return lines.join("\n");
  }

  /** 为时间线 meta 绑定悬停说明（原生 title 浮窗，换行在多数浏览器下可显示为多行） */
  private attachTimelineMetaTooltip(meta: HTMLElement, tip: string): void {
    meta.addClass("rslatte-timeline-meta--with-tip");
    meta.setAttr("title", tip);
  }

  /** 项目任务条 meta 的完整中文说明（与任务清单时间线字段一致） */
  private buildProjectTaskItemMetaTooltip(it: ProjectTaskItem): string {
    const lines: string[] = [];
    const estimate_h = (it as any).estimate_h;
    if (estimate_h != null && Number(estimate_h) > 0) {
      lines.push(`工时评估：约 ${Math.round(Number(estimate_h))} 小时`);
    }
    if (it.created_date) lines.push(`创建日：${it.created_date}`);
    if (it.planned_start) lines.push(`计划开始日：${it.planned_start}`);
    if (it.actual_start) lines.push(`实际开始日：${it.actual_start}`);
    if (it.planned_end) lines.push(`计划结束日：${it.planned_end}`);
    const task_phase = (it as any).task_phase;
    const wait_until = (it as any).wait_until;
    if (task_phase === "waiting_until" && wait_until && /^\d{4}-\d{2}-\d{2}$/.test(String(wait_until))) {
      lines.push(`等待到期日：${wait_until}`);
    }
    const postpone_count = (it as any).postpone_count;
    const original_due = (it as any).original_due;
    if (postpone_count != null && Number(postpone_count) > 0) {
      let line = `已延期次数：${postpone_count}`;
      if (original_due && /^\d{4}-\d{2}-\d{2}$/.test(String(original_due))) {
        line += `；首次延期前计划结束日：${original_due}`;
      }
      lines.push(line);
    }
    if (it.statusName === "DONE" && it.done_date) lines.push(`实际完成日：${it.done_date}`);
    if (it.statusName === "CANCELLED" && it.cancelled_date) lines.push(`实际取消日：${it.cancelled_date}`);
    if (lines.length === 0) return "当前项目任务暂无日期类信息";
    return lines.join("\n");
  }

  /** 构建提醒条目的 meta 文本：日期（memoDate/mmdd）+ 重复 + 分类（若有） */
  private buildReminderMeta(m: RSLatteIndexItem): string {
    const parts: string[] = [];

    // category (optional)
    const cat = String((m.extra as any)?.cat ?? "").trim();
    if (cat) {
      const map: Record<string, string> = {
        dueReminder: "到期提醒",
        generalReminder: "一般提醒",
        important: "一般提醒",
        solarBirthday: "阳历生日",
        lunarBirthday: "农历生日",
        anniversary: "纪念日",
      };
      parts.push(map[cat] ?? cat);
    }

    // date
    if (m.memoDate) parts.push(`📅${m.memoDate}`);
    else if (m.memoMmdd) parts.push(`📅${m.memoMmdd}`);

    // repeat rule
    const rr = normalizeRepeatRuleToken(String(m.repeatRule ?? "").trim().toLowerCase());
    if (rr && rr !== "none") {
      const map: Record<string, string> = {
        weekly: "每周",
        monthly: "每月",
        quarterly: "每季",
        yearly: "每年",
      };
      parts.push(`🔁${map[rr] ?? rr}`);
    }

    // status hint (optional but useful when显示多个状态混排)
    if (m.status && m.status !== "UNKNOWN") {
      const map: Record<string, string> = {
        TODO: "TODO",
        IN_PROGRESS: "进行中",
        DONE: "已完成",
        CANCELLED: "已取消",
      };
      parts.push(map[m.status] ?? m.status);
    }

    const ex = (m.extra as any) ?? {};
    if (
      String(ex.memo_arranged ?? "").trim() === "1" ||
      String(ex.arranged_task_uid ?? "").trim() ||
      String(ex.arranged_schedule_uid ?? "").trim()
    ) {
      parts.push("已安排");
    }

    return parts.join(" / ");
  }

  /** 提醒 / 日程卡片：优先读索引 memo_tags、schedule_tags（与根级 tagsDerivedForYmd 一致时），否则现算 */
  private renderReminderUrgencyBadge(container: HTMLElement, m: RSLatteIndexItem): void {
    const panel = (this.plugin.settings as any)?.taskPanel;
    const todayK = calendarTodayYmd();
    const isSched = isScheduleMemoLine(m);
    const indexDay = isSched ? this._scheduleIndexTagsDerivedDay : this._memoIndexTagsDerivedDay;
    const stored = isSched ? (m as any).schedule_tags : (m as any).memo_tags;
    const tags: string[] =
      indexDay === todayK && Array.isArray(stored) && stored.length > 0
        ? (stored as string[])
        : isSched
          ? computeScheduleTags(m, todayK, panel)
          : computeMemoTags(m, todayK, panel);
    if (!tags.length) return;
    const metaMap = isSched ? SCHEDULE_TAG_META : MEMO_TAG_META;
    const colorNames: Record<number, string> = { 1: "red", 2: "orange", 3: "yellow", 4: "green" };
    const tagsRow = container.createDiv({ cls: "rslatte-task-tags-row" });
    for (const key of tags) {
      const info = metaMap[key];
      const label = info?.label ?? key;
      const fullName = info?.fullName ?? key;
      const colorOrder = info?.colorOrder ?? 4;
      const chip = tagsRow.createSpan({ cls: "rslatte-task-tag" });
      chip.setText(label);
      chip.setAttr("title", fullName);
      chip.addClass(`rslatte-task-tag--${colorNames[colorOrder] ?? "green"}`);
    }
  }


  private async openTaskInFile(filePath: string, line: number): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      throw new Error(`找不到文件：${filePath}`);
    }

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file, {
      active: true,
      state: { mode: "source" },
    });

    // 尽力将光标定位到任务行（并滚动到可见）
    window.setTimeout(() => {
      const view: any = leaf.view as any;
      const editor = view?.editor;
      if (!editor) return;
      const ln = Math.max(0, Number(line || 0));
      try {
        editor.setCursor({ line: ln, ch: 0 });
        editor.scrollIntoView({ from: { line: ln, ch: 0 }, to: { line: ln + 1, ch: 0 } }, true);
      } catch { }
    }, 50);
  }

  /**
   * 定位并滚动到指定任务（用于从其他视图跳转）
   * @param filePath 任务文件路径
   * @param lineNo 任务行号（0-based）
   */
  public async scrollToTask(filePath: string, lineNo: number): Promise<void> {
    const normalizedPath = normalizePath(filePath);
    const { task } = this.moduleTabAvailability();
    if (!task) {
      await this.openTaskInFile(filePath, lineNo);
      return;
    }
    this._subTab = "task";
    await this.expandTaskPanelSectionsForFileLine(filePath, lineNo);
    await this.requestRender();
    const ok = await this.tryScrollToTaskRowInPanel(filePath, lineNo, { skipInitialRender: true });
    if (ok) return;

    const container = this.containerEl.children[1];
    const retryItems = Array.from(container.querySelectorAll<HTMLElement>(".rslatte-timeline-item"));
    new Notice(`未找到任务：${filePath}:${lineNo + 1}`);
    if (this.plugin.isDebugLogEnabled()) {
      console.warn(`[RSLatte][TaskView] scrollToTask failed:`, {
        searchPath: normalizedPath,
        searchLineNo: lineNo,
        foundItems: retryItems.length,
        samplePaths: Array.from(retryItems.slice(0, 3)).map((item) => item.getAttribute("data-task-file-path")),
      });
    }
  }

  /** Today 执行统计：任务清单页签 + 「今日处理清单」下各子清单展开 */
  public async openTodayHandlingFromStats(): Promise<void> {
    this._subTab = "task";
    const sAny: any = this.plugin.settings as any;
    if (!sAny.taskPanel) sAny.taskPanel = {};
    const tp = sAny.taskPanel;
    tp.collapsedLists = tp.collapsedLists ?? {};
    for (const id of ["todayAction", "todayFollowUp", "overdue", "otherRisk"] as const) {
      tp.collapsedLists[id] = false;
    }
    await this.plugin.saveSettings();
    // 与 onOpen / 其它跳转一致走 requestRender，避免与并发 render 叠成多次整页重绘；并保证 Today 侧栏 await 时 UI 已更新
    await this.requestRender();
  }
}
