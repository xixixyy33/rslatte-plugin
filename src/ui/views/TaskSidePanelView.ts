import { ItemView, Notice, TFile, WorkspaceLeaf, normalizePath } from "obsidian";
import type RSLattePlugin from "../../main";
import { VIEW_TYPE_TASKS } from "../../constants/viewTypes";
import type { BuiltinTaskListDef, BuiltinTaskListId } from "../../types/taskTypes";
import type { RSLatteIndexItem } from "../../taskRSLatte/types";
import type { ProjectEntry, ProjectTaskItem } from "../../projectManager/types";
import { AddTaskModal } from "../modals/AddTaskModal";
import { AddMemoModal } from "../modals/AddMemoModal";
import { EditTaskModal } from "../modals/EditTaskModal";
import { EditMemoModal } from "../modals/EditMemoModal";
import { EditProjectTaskModal } from "../modals/EditProjectTaskModal";
import { createHeaderRow, appendDbSyncIndicator } from "../helpers/moduleHeader";
import { getUiHeaderButtonsVisibility } from "../helpers/uiHeaderButtons";
import { normalizeRunSummaryForUi } from "../helpers/normalizeRunSummaryForUi";
import { renderTextWithContactRefs } from "../helpers/renderTextWithContactRefs";

export class TaskSidePanelView extends ItemView {
  private plugin: RSLattePlugin;
  private _renderSeq = 0;
  // Prevent flicker caused by re-entrant refresh (e.g. DB id write-back triggers refreshSidePanel).
  private _renderPromise: Promise<void> | null = null;
  private _pendingRender = false;

  /** milestone expand state: key = `${projectId}::${milestoneName}` */
  private _expandedMilestones = new Set<string>();

  constructor(leaf: WorkspaceLeaf, plugin: RSLattePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_TASKS; }
  getDisplayText(): string { return "任务管理"; }
  getIcon(): string { return "check-square"; }

  async onOpen() {
    // v26：不再使用侧边栏内部 timer；统一由 main.ts 的 autoRefreshIndexIntervalMin 驱动。
    void this.requestRender();
  }

  async onClose() {
    // nothing
  }

  public refresh() {
    void this.requestRender();
  }

  private async manualRefreshTaskIndexAndMaybeSync(): Promise<void> {
    const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "task", "manual_refresh");
    if (!r.ok) throw new Error(r.error.message);
    // skipped: module disabled / inFlight
  }

  private async manualRefreshMemoIndexAndMaybeSync(): Promise<void> {
    const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "memo", "manual_refresh");
    if (!r.ok) throw new Error(r.error.message);
    // skipped: module disabled / inFlight
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
    if (!taskEnabled && !memoEnabled) {
      // Both modules are off: render nothing.
      return;
    }

    // NOTE(UI): 不再展示模块级“任务管理”标题行；直接以“事项提醒 / 任务清单”等分区标题作为顶层。

    const panel = this.plugin.settings.taskPanel;

    // =========================
    // 事项提醒（备忘录）
    // 规则：memo 模块关闭时，此分区完全不渲染（不显示“模块已关闭”空壳）。
    // =========================
    const showReminders = panel?.showImportantMemosInRSLattePanel !== false;
    if (memoEnabled && showReminders) {
      const memoDays = Math.max(0, Number(panel?.memoLookaheadDays ?? 7));
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
      addMemoBtn.title = "新增备忘（写入今日日记）";
      addMemoBtn.onclick = () => new AddMemoModal(this.app, this.plugin).open();

      // status light + right-aligned actions
      appendDbSyncIndicator(reminderLeft, memoInd);

      if (memoBtnVis.rebuild) {
        const memoRebuildBtn = reminderActions.createEl("button", { text: "🧱", cls: "rslatte-icon-btn" });
              memoRebuildBtn.title = "扫描重建备忘索引（全量）";
              memoRebuildBtn.onclick = async () => {
                const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "memo", "rebuild");
                if (!r.ok) {
                  new Notice(`重建失败：${r.error.message}`);
                  return;
                }
                if (!r.data.skipped) new Notice("备忘索引已重建");
                this.refresh();
              };
      }

      if (memoBtnVis.archive) {
        const memoArchiveBtn = reminderActions.createEl("button", { text: "🗄", cls: "rslatte-icon-btn" });
              memoArchiveBtn.title = "备忘归档（按阈值归档已闭环备忘）";
              memoArchiveBtn.onclick = async () => {
                const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "memo", "manual_archive");
                if (!r.ok) {
                  new Notice(`备忘归档失败：${r.error.message}`);
                  return;
                }
                if (r.data.skipped) return;

                const ui = normalizeRunSummaryForUi(r.data);
                const n = ui.archivedCount;
                const cutoff = ui.cutoffDate;
                if (n > 0) new Notice(`备忘已归档：${n} 条（< ${cutoff}）`);
                else new Notice(`备忘无可归档条目（阈值 < ${cutoff}）`);

                this.refresh();
              };
      }

      if (memoBtnVis.refresh) {
        const memoRefreshBtn = reminderActions.createEl("button", { text: "🔄", cls: "rslatte-icon-btn" });
              memoRefreshBtn.title = "备忘手动刷新（增量索引更新 → 可选 DB 同步）";
              memoRefreshBtn.onclick = async () => {
                const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "memo", "manual_refresh");
                if (!r.ok) {
                  new Notice(`刷新失败：${r.error.message}`);
                  return;
                }
                if (!r.data.skipped) new Notice("备忘索引已刷新");
                this.refresh();
              };
      }
      const reminderSec = container.createDiv({ cls: "rslatte-task-section" });
      const memoWrap = reminderSec.createDiv({ cls: "rslatte-task-list" });
      memoWrap.setText("加载中…");
      try {
        const memos = await Promise.race([
          this.plugin.taskRSLatte.listImportantMemos(memoDays),
          new Promise<never>((_, reject) =>
            window.setTimeout(() => reject(new Error("事项提醒加载超时（请检查索引刷新/文件量是否过大）")), 15_000)
          ),
        ]);
        if (seq !== this._renderSeq) return;
        memoWrap.empty();
        if (!memos.length) {
          memoWrap.createDiv({ cls: "rslatte-task-empty", text: "（未来范围内无事项提醒）" });
        } else {
          this.renderReminderTimeline(memoWrap, memos);
        }
      } catch (e: any) {
        memoWrap.empty();
        memoWrap.createDiv({ cls: "rslatte-task-empty", text: `加载失败：${e?.message ?? String(e)}` });
      }
    }

    // =========================
    // 全量备忘清单（可折叠）
    // =========================
    const memoAllEnabled = (panel as any)?.memoAllEnabled ?? true;
    if (memoEnabled && memoAllEnabled) {
        const collapsed = !!(panel as any)?.collapsedLists?.["memoAll"];
        const sec = container.createDiv({
          cls: collapsed
            ? "rslatte-section rslatte-task-section"
            : "rslatte-section rslatte-task-section rslatte-expanded",
        });

      const titleRow = sec.createDiv({ cls: "rslatte-task-cat-title rslatte-collapsible-head" });
      const titleLeft = titleRow.createDiv({ cls: "rslatte-task-cat-left" });
      const arrow = titleLeft.createEl("span", { cls: "rslatte-collapse-arrow" });
      arrow.setText(collapsed ? "▸" : "▾");
      titleLeft.createEl("h4", { text: "🗒 全量备忘清单" });
      // 全量备忘清单本身不再重复显示状态灯（由上方“事项提醒”标题行统一展示 memo 状态灯）

      titleRow.onclick = async (ev) => {
        ev.stopPropagation();
        const tp: any = (this.plugin.settings as any)?.taskPanel ?? {};
        tp.collapsedLists = tp.collapsedLists ?? {};
        tp.collapsedLists["memoAll"] = !tp.collapsedLists["memoAll"];
        await this.plugin.saveSettings();
        this.refresh();
      };

      const maxItems = Math.max(1, Math.min(200, Number((panel as any)?.memoAllMaxItems ?? 50)));
      const meta = titleRow.createDiv({ cls: "rslatte-task-cat-meta" });
      meta.setText(`按 📅 ↑ / 最多 ${maxItems} 条`);

        const listWrap = sec.createDiv({ cls: "rslatte-task-list" });
        if (!collapsed) listWrap.setText("加载中…");

      try {
        const statuses = Array.isArray((panel as any)?.memoAllStatuses)
          ? (panel as any).memoAllStatuses
          : ["TODO", "IN_PROGRESS"];

        const { items: memos, total } = await Promise.race([
          this.plugin.taskRSLatte.queryAllMemosWithTotal({ maxItems, statuses }),
          new Promise<never>((_, reject) =>
            window.setTimeout(() => reject(new Error("全量备忘清单加载超时（请检查索引刷新/文件量是否过大）")), 15_000)
          ),
        ]);

        if (seq !== this._renderSeq) return;

        meta.setText(`按 📅 ↑ / 最多 ${maxItems} 条 / 共 ${total} 条`);
        listWrap.empty();
        if (collapsed) {
          // keep meta updated; do not render items
        } else if (!memos.length) {
          listWrap.createDiv({ cls: "rslatte-task-empty", text: "（无匹配备忘）" });
        } else {
          this.renderMemoAllTimeline(listWrap, memos);
        }
      } catch (e: any) {
        listWrap.empty();
        listWrap.createDiv({ cls: "rslatte-task-empty", text: `加载失败：${e?.message ?? String(e)}` });
      }
    }

    // =========================
    // 任务清单（task 模块关闭时完全不渲染）
    // =========================
    if (!taskEnabled) {
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
      archiveBtn.title = "任务归档（按阈值归档已闭环任务）";
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
        if (n > 0) new Notice(`任务已归档：${n} 条（< ${cutoff}）`);
        else new Notice(`任务无可归档条目（阈值 < ${cutoff}）`);

        this.refresh();
      };
    }

    if (taskBtnVis.refresh) {
      const refreshBtn = listActions.createEl("button", { text: "🔄", cls: "rslatte-icon-btn" });
      refreshBtn.title = "任务手动刷新（增量索引更新 → 可选 DB 同步）";
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

    // ✅ Step4-2a：里程碑任务清单从「任务管理」侧边栏移除，迁移到「项目管理」侧边栏中展示。
    const builtin = (panel?.builtinLists ?? {}) as Partial<Record<BuiltinTaskListId, BuiltinTaskListDef>>;
    const getCfg = (id: BuiltinTaskListId): BuiltinTaskListDef => {
      const v = builtin[id];
      // 兜底默认值（避免旧配置没有新字段时 UI 空白）
      const defaults: Record<BuiltinTaskListId, BuiltinTaskListDef> = {
        todayTodo: { enabled: true, maxItems: 20, sortField: "due", sortOrder: "asc", defaultCollapsed: false },
        weekTodo: { enabled: true, maxItems: 20, sortField: "due", sortOrder: "asc", defaultCollapsed: false },
        inProgress: { enabled: true, maxItems: 20, sortField: "start", sortOrder: "asc", defaultCollapsed: false },
        overdue: { enabled: true, maxItems: 20, sortField: "due", sortOrder: "asc", defaultCollapsed: false },
        todayDone: { enabled: true, maxItems: 20, sortField: "done", sortOrder: "desc", defaultCollapsed: false },
        cancelled7d: { enabled: true, maxItems: 20, sortField: "cancelled", sortOrder: "desc", defaultCollapsed: false },
        allTasks: { enabled: true, maxItems: 20, sortField: "created", sortOrder: "desc", defaultCollapsed: false },
      };
      return {
        ...(defaults[id]),
        ...(v ?? {}),
        maxItems: Math.min(Math.max(Number((v as any)?.maxItems ?? defaults[id].maxItems), 1), 30),
      };
    };

    const listsDefault: Array<{ id: BuiltinTaskListId; title: string }> = [
      { id: "todayTodo", title: "今日待完成" },
      { id: "weekTodo", title: "待本周完成" },
      { id: "inProgress", title: "进行中任务" },
      { id: "overdue", title: "超期未完成" },
      { id: "todayDone", title: "今日已完成" },
      { id: "cancelled7d", title: "近七天取消任务" },
      { id: "allTasks", title: "全量任务清单" },
    ];

    // ✅ 内置清单显示顺序（设置可调整；旧配置缺失时兜底）
    const defaultOrder: BuiltinTaskListId[] = ["todayTodo", "weekTodo", "inProgress", "overdue", "todayDone", "cancelled7d", "allTasks"];
    const normalizeOrder = (arr: any): BuiltinTaskListId[] => {
      const uniq: BuiltinTaskListId[] = [];
      const seen = new Set<string>();
      for (const x of Array.isArray(arr) ? arr : []) {
        const id = String(x ?? "").trim();
        if (!id) continue;
        if (seen.has(id)) continue;
        if (!defaultOrder.includes(id as BuiltinTaskListId)) continue;
        seen.add(id);
        uniq.push(id as BuiltinTaskListId);
      }
      for (const id of defaultOrder) {
        if (!seen.has(id)) uniq.push(id);
      }
      return uniq;
    };
    const order = normalizeOrder((panel as any)?.builtinListOrder);
    const defMap = new Map(listsDefault.map((x) => [x.id, x] as const));
    const lists = order.map((id) => defMap.get(id)!).filter(Boolean);

    const enabledCount = lists.filter((x) => getCfg(x.id).enabled).length;
    if (enabledCount === 0) {
      const hint = container.createDiv({ cls: "rslatte-task-hint" });
      hint.setText("当前未开启任何任务清单：请到设置 → 任务管理（Side Panel 2）中打开清单展示开关。");
      return;
    }

    // v26：渲染阶段不再自动刷新索引（避免与 main.ts 的 autoRefresh 叠加）。
    // 如需立即刷新，请点击顶部 🔄。

    for (const li of lists) {
      const cfg = getCfg(li.id);
      if (!cfg.enabled) continue;
      // 如果 collapsedLists 中没有记录，则使用清单的 defaultCollapsed 设置
      let collapsed = !!(panel as any)?.collapsedLists?.[li.id];
      if ((panel as any)?.collapsedLists?.[li.id] === undefined) {
        collapsed = !!(cfg.defaultCollapsed ?? false);
      }
      // 展开态：使用更明显的底色区分（折叠态保持默认背景，避免冗余文本提示）
      const sec = container.createDiv({
        cls: collapsed
          ? "rslatte-section rslatte-task-section"
          : "rslatte-section rslatte-task-section rslatte-expanded",
      });

      const titleRow = sec.createDiv({ cls: "rslatte-task-cat-title rslatte-collapsible-head" });
      const titleLeft = titleRow.createDiv({ cls: "rslatte-task-cat-left" });
      const arrow = titleLeft.createEl("span", { cls: "rslatte-collapse-arrow" });
      arrow.setText(collapsed ? "▸" : "▾");
      titleLeft.createEl("h4", { text: li.title });
      titleRow.onclick = async (ev) => {
        ev.stopPropagation();
        const tp: any = (this.plugin.settings as any)?.taskPanel ?? {};
        tp.collapsedLists = tp.collapsedLists ?? {};
        tp.collapsedLists[li.id] = !tp.collapsedLists[li.id];
        await this.plugin.saveSettings();
        this.refresh();
      };

      const meta = titleRow.createDiv({ cls: "rslatte-task-cat-meta" });
      meta.setText(`按 ${cfg.sortField} ${cfg.sortOrder === "desc" ? "↓" : "↑"} / 最多 ${Math.min(cfg.maxItems || 0, 30)} 条`);

      const listWrap = sec.createDiv({ cls: "rslatte-task-list" });
      if (!collapsed) listWrap.setText("加载中…");

      try {
        const { items: tasks, total } = await this.plugin.taskRSLatte.queryBuiltinListWithTotal(li.id, cfg);
        if (seq !== this._renderSeq) return;

        meta.setText(`按 ${cfg.sortField} ${cfg.sortOrder === "desc" ? "↓" : "↑"} / 最多 ${Math.min(cfg.maxItems || 0, 30)} 条 / 共 ${total} 条`);

        listWrap.empty();
        if (collapsed) continue;

        if (tasks.length === 0) {
          const empty = listWrap.createDiv({ cls: "rslatte-task-empty" });
          empty.setText("（无匹配任务）");
          continue;
        }

        // 使用时间轴样式展示（参考 tasks-calendar-wrapper 的侧边栏体验）
        this.renderTimeline(listWrap, tasks, cfg.sortField);
      } catch (e: any) {
        listWrap.empty();
        const err = listWrap.createDiv({ cls: "rslatte-task-empty" });
        err.setText(`加载失败：${e?.message ?? String(e)}`);
      }
    }
  }

  private renderTimeline(parent: HTMLElement, tasks: RSLatteIndexItem[], sortField: string) {
    const wrap = parent.createDiv({ cls: "rslatte-timeline" });

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
        case "due": return toDayKey(anyT.dueDate);
        case "start": return toDayKey(anyT.startDate);
        case "scheduled": return toDayKey(anyT.scheduledDate);
        case "done": return toDayKey(anyT.doneDate);
        case "cancelled": return toDayKey(anyT.cancelledDate);
        case "created": return toDayKey(anyT.createdDate);
        default: return toDayKey(anyT.dueDate) ?? toDayKey(anyT.startDate) ?? toDayKey(anyT.scheduledDate) ?? toDayKey(anyT.doneDate) ?? toDayKey(anyT.createdDate);
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

    for (const t of tasks) {
      const dayKey = pickDateByField(t, sortField);
      if (dayKey) ensureYearHeader(dayKey.slice(0, 4));
      ensureDaySection(dayKey);

      const itemsWrap = daySectionEl!.querySelector<HTMLElement>(".rslatte-timeline-day-items")!;
      this.renderTimelineItem(itemsWrap, t);
    }
  }

  private renderTimelineItem(parent: HTMLElement, t: RSLatteIndexItem) {
    const row = parent.createDiv({ cls: "rslatte-timeline-item" });
    row.tabIndex = 0;
    // 添加标识属性，用于从其他视图跳转定位（使用规范化路径确保匹配）
    const normalizedFilePath = normalizePath(t.filePath);
    row.setAttribute("data-task-file-path", normalizedFilePath);
    row.setAttribute("data-task-line-no", String(t.lineNo));

    // 左侧时间轴轨道
    const gutter = row.createDiv({ cls: "rslatte-timeline-gutter" });
    const dot = gutter.createDiv({ cls: "rslatte-timeline-dot" });
    dot.setText(this.statusIcon(t));
    gutter.createDiv({ cls: "rslatte-timeline-line" });

    // 右侧内容
    const content = row.createDiv({ cls: "rslatte-timeline-content" });

    // title (description)
    const titleRow = content.createDiv({ cls: "rslatte-timeline-title-row rslatte-task-row" });
    const title = titleRow.createDiv({ cls: "rslatte-timeline-text rslatte-task-title" });
    renderTextWithContactRefs(this.app, title, String(t.text || t.raw || ""));

    // actions: icon-only buttons, align right (same row as title)
    // order: ✏️ / ▶ / ✅ / ⛔ / ⏸
    const actionRow = titleRow.createDiv({ cls: "rslatte-task-actions rslatte-task-actions-compact" });

    const mkIconBtn = (parentEl: HTMLElement, text: string, title: string, handler: () => Promise<void>) => {
      const b = parentEl.createEl("button", { text, cls: "rslatte-icon-only-btn" });
      b.title = title;
      b.onclick = async (ev) => {
        ev.stopPropagation();
        try {
          b.disabled = true;
          await handler();
        } catch (e: any) {
          new Notice(`操作失败：${e?.message ?? String(e)}`);
        } finally {
          b.disabled = false;
        }
      };
      return b;
    };

    // ✏️ always available (editing does not change status ordering rules)
    mkIconBtn(actionRow, "✏️", "修改任务信息", async () => {
      new EditTaskModal(this.app, this.plugin, t).open();
    });

    // Status action buttons: visibility + order follow the same strategy as Output panel
    // DONE: ▶ ⏸
    // CANCELLED: ▶ ⏸
    // IN_PROGRESS: ⏸ ⛔ ✅
    // TODO: ▶ ⛔
    for (const icon of this.taskActionOrder(String((t as any).status ?? ""))) {
      if (icon === "▶") {
        mkIconBtn(actionRow, "▶", "标记为进行中", async () => {
          await this.plugin.taskRSLatte.applyTaskStatusAction(t, "IN_PROGRESS");
          await this.manualRefreshTaskIndexAndMaybeSync();
          this.refresh();
        });
      } else if (icon === "⏸") {
        mkIconBtn(actionRow, "⏸", "恢复为 TODO", async () => {
          await this.plugin.taskRSLatte.applyTaskStatusAction(t, "TODO");
          await this.manualRefreshTaskIndexAndMaybeSync();
          this.refresh();
        });
      } else if (icon === "⛔") {
        mkIconBtn(actionRow, "⛔", "标记为取消", async () => {
          await this.plugin.taskRSLatte.applyTaskStatusAction(t, "CANCELLED");
          await this.manualRefreshTaskIndexAndMaybeSync();
          this.refresh();
        });
      } else if (icon === "✅") {
        mkIconBtn(actionRow, "✅", "标记为完成", async () => {
          await this.plugin.taskRSLatte.applyTaskStatusAction(t, "DONE");
          await this.manualRefreshTaskIndexAndMaybeSync();
          this.refresh();
        });
      }
    }

    const meta = content.createDiv({ cls: "rslatte-timeline-meta" });
    meta.setText(this.buildTimelineMeta(t));

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
        const key = `${p.projectId}::${name}`;
        const openTasks = items.filter(
          (it) => String(it.milestone ?? "").trim() === name && (it.statusName === "TODO" || it.statusName === "IN_PROGRESS")
        );
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
    // Status action buttons visibility + order follow the same strategy as Output panel
    for (const icon of this.taskActionOrder(String(it.statusName ?? ""))) {
      if (icon === "▶") {
        mkBtn("▶", "标记为 IN_PROGRESS", () => {
          void this.plugin.projectMgr.setProjectTaskStatus(String(p.folderPath ?? ""), { taskId: it.taskId, lineNo: it.lineNo }, "IN_PROGRESS");
        });
      } else if (icon === "⏸") {
        mkBtn("⏸", "恢复为 TODO", () => {
          void this.plugin.projectMgr.setProjectTaskStatus(String(p.folderPath ?? ""), { taskId: it.taskId, lineNo: it.lineNo }, "TODO");
        });
      } else if (icon === "⛔") {
        mkBtn("⛔", "标记为 CANCELLED", () => {
          void this.plugin.projectMgr.setProjectTaskStatus(String(p.folderPath ?? ""), { taskId: it.taskId, lineNo: it.lineNo }, "CANCELLED");
        });
      } else if (icon === "✅") {
        mkBtn("✅", "标记为 DONE", () => {
          void this.plugin.projectMgr.setProjectTaskStatus(String(p.folderPath ?? ""), { taskId: it.taskId, lineNo: it.lineNo }, "DONE");
        });
      }
    }

    const meta = content.createDiv({ cls: "rslatte-timeline-meta rslatte-task-meta" });
    const created = String(it.createdDate ?? "—");
    const due = String(it.dueDate ?? "—");
    meta.setText(`创建 ${created} · 到期 ${due}`);

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

  private renderReminderTimeline(parent: HTMLElement, memos: RSLatteIndexItem[]) {
    // listImportantMemos 已经把 memoDate 覆盖为「下一次提醒日期（YYYY-MM-DD）」并按日期排序
    const wrap = parent.createDiv({ cls: "rslatte-timeline" });

    let currentYear: string | null = null;
    let currentDay: string | null = null;
    let daySectionEl: HTMLElement | null = null;

    const toDayKey = (iso?: string): string | null => {
      if (!iso) return null;
      const m = String(iso).match(/^(\d{4}-\d{2}-\d{2})/);
      return m ? m[1] : null;
    };

    const formatDayHeader = (dayKey: string): string => {
      const moment = (window as any).moment;
      if (typeof moment === "function") {
        try {
          const mm = moment(dayKey, "YYYY-MM-DD", true);
          if (mm?.isValid?.()) return mm.format("YYYY-MM-DD (ddd)");
        } catch { }
      }
      return dayKey;
    };

    const ensureYearHeader = (year: string) => {
      if (currentYear === year) return;
      currentYear = year;
      wrap.createDiv({ cls: "rslatte-timeline-year", text: year });
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

    for (const m of memos) {
      const anyM: any = m as any;
      const dayKey = toDayKey(anyM.memoDate) ?? toDayKey(anyM.memoMmdd);
      if (dayKey) ensureYearHeader(dayKey.slice(0, 4));
      ensureDaySection(dayKey);

      const itemsWrap = daySectionEl!.querySelector<HTMLElement>(".rslatte-timeline-day-items")!;
      this.renderReminderTimelineItem(itemsWrap, m);
    }
  }

  private renderReminderTimelineItem(parent: HTMLElement, m: RSLatteIndexItem) {
    const row = parent.createDiv({ cls: "rslatte-timeline-item" });
    row.tabIndex = 0;

    const gutter = row.createDiv({ cls: "rslatte-timeline-gutter" });
    const dot = gutter.createDiv({ cls: "rslatte-timeline-dot" });
    dot.setText("🔔");
    gutter.createDiv({ cls: "rslatte-timeline-line" });

    const content = row.createDiv({ cls: "rslatte-timeline-content" });
    content.createDiv({ cls: "rslatte-timeline-text", text: m.text || m.raw });

    const meta = content.createDiv({ cls: "rslatte-timeline-meta" });
    meta.setText(this.buildReminderMeta(m));

    content.createDiv({ cls: "rslatte-timeline-from", text: this.shortPath(m.filePath) });

    const open = async () => {
      try {
        // ✅ 如果是联系人生日备忘，跳转到联系人文件而不是备忘所在的日记文件
        const contactFile = (m as any).extra?.contact_file;
        if (contactFile && typeof contactFile === "string" && contactFile.trim()) {
          const file = this.app.vault.getAbstractFileByPath(contactFile.trim());
          if (file instanceof TFile) {
            const leaf = this.app.workspace.getLeaf(false);
            await leaf.openFile(file, { active: true, state: { mode: "source" } });
            return;
          }
        }
        // 默认行为：打开备忘所在的日记文件
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

  // =========================
  // Memo all-list (no buttons in Step5-2cA)
  // =========================

  private renderMemoAllTimeline(parent: HTMLElement, memos: RSLatteIndexItem[]) {
    for (const m of memos) {
      const row = parent.createDiv({ cls: "rslatte-timeline-item" });
      row.tabIndex = 0;

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
      title.setText(m.text || m.raw);

      const actionRow = titleRow.createDiv({ cls: "rslatte-task-actions rslatte-task-actions-compact" });

      const mkIconBtn = (parentEl: HTMLElement, text: string, tip: string, handler: () => Promise<void>) => {
        const b = parentEl.createEl("button", { text, cls: "rslatte-icon-only-btn" });
        b.title = tip;
        b.onclick = async (ev) => {
          ev.stopPropagation();
          try {
            b.disabled = true;
            await handler();
          } catch (e: any) {
            new Notice(`操作失败：${e?.message ?? String(e)}`);
          } finally {
            b.disabled = false;
          }
        };
        return b;
      };

      // ✏️ edit
      mkIconBtn(actionRow, "✏️", "修改备忘信息", async () => {
        new EditMemoModal(this.app, this.plugin, m).open();
      });

      // status action buttons (same visibility+order as tasks)
      for (const icon of this.taskActionOrder(String((m as any).status ?? ""))) {
        if (icon === "▶") {
          mkIconBtn(actionRow, "▶", "标记为进行中", async () => {
            await this.plugin.taskRSLatte.applyMemoStatusAction(m as any, "IN_PROGRESS");
            await this.manualRefreshMemoIndexAndMaybeSync();
            this.refresh();
          });
        } else if (icon === "⏸") {
          mkIconBtn(actionRow, "⏸", "恢复为 TODO", async () => {
            await this.plugin.taskRSLatte.applyMemoStatusAction(m as any, "TODO");
            await this.manualRefreshMemoIndexAndMaybeSync();
            this.refresh();
          });
        } else if (icon === "⛔") {
          mkIconBtn(actionRow, "⛔", "标记为取消", async () => {
            await this.plugin.taskRSLatte.applyMemoStatusAction(m as any, "CANCELLED");
            await this.manualRefreshMemoIndexAndMaybeSync();
            this.refresh();
          });
        } else if (icon === "✅") {
          mkIconBtn(actionRow, "✅", "标记为完成", async () => {
            await this.plugin.taskRSLatte.applyMemoStatusAction(m as any, "DONE");
            await this.manualRefreshMemoIndexAndMaybeSync();
            this.refresh();
          });
        }
      }

      // meta
      const meta = content.createDiv({ cls: "rslatte-timeline-meta" });
      meta.setText(this.buildReminderMeta(m));

      // file path
      content.createDiv({ cls: "rslatte-timeline-from", text: this.shortPath(m.filePath) });

      const open = async () => {
        try {
          // ✅ 如果是联系人生日备忘，跳转到联系人文件而不是备忘所在的日记文件
          const contactFile = (m as any).extra?.contact_file;
          if (contactFile && typeof contactFile === "string" && contactFile.trim()) {
            const file = this.app.vault.getAbstractFileByPath(contactFile.trim());
            if (file instanceof TFile) {
              const leaf = this.app.workspace.getLeaf(false);
              await leaf.openFile(file, { active: true, state: { mode: "source" } });
              return;
            }
          }
          // 默认行为：打开备忘所在的日记文件
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

  private statusIcon(t: RSLatteIndexItem): string {
    switch (t.status) {
      case "DONE": return "✅";
      case "IN_PROGRESS": return "▶";
      case "CANCELLED": return "⛔";
      case "TODO": return "⏸";
      default: return "⬛";
    }
  }

  /**
   * Status action buttons visibility + order.
   * - DONE: ▶ ⏸
   * - CANCELLED: ▶ ⏸
   * - IN_PROGRESS: ⏸ ⛔ ✅
   * - TODO: ▶ ⛔
   */
  private taskActionOrder(statusRaw: string): Array<"▶" | "⏸" | "⛔" | "✅"> {
    const st = String(statusRaw || "").trim().toUpperCase();
    if (st === "DONE") return ["▶", "⏸"];
    if (st === "CANCELLED") return ["▶", "⏸"];
    if (st === "IN_PROGRESS" || st === "IN-PROGRESS") return ["⏸", "⛔", "✅"];
    // default TODO
    return ["▶", "⛔"];
  }

  private shortPath(path: string): string {
    const p = (path ?? "").replace(/\\/g, "/");
    // 只展示最后两段，避免太长
    const parts = p.split("/").filter(Boolean);
    if (parts.length <= 2) return p;
    return parts.slice(parts.length - 2).join("/");
  }

  /** 构建任务条目的 meta 文本（与任务清单一致：尽量简洁，优先展示 created/due 与闭环时间） */
  private buildTimelineMeta(it: RSLatteIndexItem): string {
    const parts: string[] = [];

    const created = it.createdDate;
    const due = it.dueDate;
    const start = it.startDate;
    const scheduled = it.scheduledDate;
    const done = it.doneDate;
    const cancelled = it.cancelledDate;

    // created / scheduled / start / due
    if (created) parts.push(`🆕${created}`);
    if (scheduled) parts.push(`⏱${scheduled}`);
    if (start) parts.push(`▶${start}`);
    if (due) parts.push(`📅${due}`);

    // status close time
    if (it.status === "DONE" && done) parts.push(`✅${done}`);
    if (it.status === "CANCELLED" && cancelled) parts.push(`⛔${cancelled}`);

    return parts.join(" / ");
  }

  /** 构建备忘条目的 meta 文本：日期（memoDate/mmdd）+ 重复 + 分类（若有） */
  private buildReminderMeta(m: RSLatteIndexItem): string {
    const parts: string[] = [];

    // category (optional)
    const cat = (m.extra as any)?.cat;
    if (cat) {
      const map: Record<string, string> = {
        IMPORTANT: "重要事项",
        SOLAR_BIRTHDAY: "阳历生日",
        LUNAR_BIRTHDAY: "农历生日",
        ANNIVERSARY: "纪念日",
      };
      parts.push(map[String(cat)] ?? String(cat));
    }

    // date
    if (m.memoDate) parts.push(`📅${m.memoDate}`);
    else if (m.memoMmdd) parts.push(`📅${m.memoMmdd}`);

    // repeat rule
    const rr = String(m.repeatRule ?? "").trim();
    if (rr && rr !== "none") {
      const map: Record<string, string> = {
        weekly: "每周",
        monthly: "每月",
        seasonly: "每季",
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

    return parts.join(" / ");
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
    // 规范化路径（确保与存储时一致）
    const normalizedPath = normalizePath(filePath);
    
    // 确保视图已渲染
    await this.requestRender();
    
    // 等待一小段时间确保 DOM 已更新
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // 查找匹配的任务元素
    const container = this.containerEl.children[1];
    const allTaskItems = Array.from(container.querySelectorAll<HTMLElement>(".rslatte-timeline-item"));
    
    let target: HTMLElement | null = null;
    for (const item of allTaskItems) {
      const itemPath = item.getAttribute("data-task-file-path");
      const itemLineNo = item.getAttribute("data-task-line-no");
      // 比较规范化后的路径和行号
      if (itemPath && normalizePath(itemPath) === normalizedPath && Number(itemLineNo) === lineNo) {
        target = item;
        break;
      }
    }
    
    if (!target) {
      // 如果找不到，尝试刷新视图后再找一次
      await this.requestRender();
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const retryItems = Array.from(container.querySelectorAll<HTMLElement>(".rslatte-timeline-item"));
      for (const item of retryItems) {
        const itemPath = item.getAttribute("data-task-file-path");
        const itemLineNo = item.getAttribute("data-task-line-no");
        if (itemPath && normalizePath(itemPath) === normalizedPath && Number(itemLineNo) === lineNo) {
          target = item;
          break;
        }
      }
      
      if (!target) {
        // 如果还是找不到，尝试只匹配文件路径（忽略行号差异）
        for (const item of retryItems) {
          const itemPath = item.getAttribute("data-task-file-path");
          if (itemPath && normalizePath(itemPath) === normalizedPath) {
            target = item;
            break;
          }
        }
      }
      
      if (!target) {
        new Notice(`未找到任务：${filePath}:${lineNo + 1}`);
        if (this.plugin.isDebugLogEnabled()) {
          console.log(`[RSLatte][TaskView] scrollToTask failed:`, {
            searchPath: normalizedPath,
            searchLineNo: lineNo,
            foundItems: retryItems.length,
            samplePaths: Array.from(retryItems.slice(0, 3)).map(item => item.getAttribute("data-task-file-path")),
          });
        }
        return;
      }
    }
    
    // 滚动到目标元素
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    // 添加临时高亮效果
    target.addClass("rslatte-task-highlight");
    setTimeout(() => target?.removeClass("rslatte-task-highlight"), 2000);
  }
}
