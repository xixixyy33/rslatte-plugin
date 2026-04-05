import {
  DropdownComponent,
  ItemView,
  Menu,
  Notice,
  Setting,
  TFile,
  TFolder,
  ToggleComponent,
  WorkspaceLeaf,
  normalizePath,
} from "obsidian";
import type RSLattePlugin from "../../main";
import { getUiHeaderButtonsVisibility } from "../helpers/uiHeaderButtons";
import { VIEW_TYPE_PROJECTS, VIEW_TYPE_TASKS } from "../../constants/viewTypes";
import { AddProjectModal } from "../modals/AddProjectModal";
import { AddProjectMilestoneModal } from "../modals/AddProjectMilestoneModal";
import { AddProjectTaskModal } from "../modals/AddProjectTaskModal";
import { CreateProjectArchiveDocModal } from "../modals/CreateProjectArchiveDocModal";
import { mergeProjectArchiveTemplatesForModal } from "../../outputRSLatte/mergeProjectArchiveTemplates";
import { EditProjectModal } from "../modals/EditProjectModal";
import { EditProjectMilestoneModal } from "../modals/EditProjectMilestoneModal";
import { EditProjectTaskModal } from "../modals/EditProjectTaskModal";
import { AddScheduleModal } from "../modals/AddScheduleModal";
import { PostponeModal } from "../modals/PostponeModal";
import { ProjectTaskProgressModal } from "../modals/ProjectTaskProgressModal";
import type { ProjectEntry, MilestoneProgress, ProjectTaskItem } from "../../projectManager/types";
import { DAY_CARD_HIDDEN_TASK_TAG_KEYS } from "../helpers/dayEntryCards";
import { normalizeRunSummaryForUi } from "../helpers/normalizeRunSummaryForUi";
import { renderTextWithContactRefs } from "../helpers/renderTextWithContactRefs";
import { createHeaderRow } from "../helpers/moduleHeader";
import { buildDescPrefix } from "../../taskRSLatte/parser";
import { getTaskTodayKey, TASK_TAG_KEYS, TASK_TAG_META } from "../../taskRSLatte/task/taskTags";
import {
  computeProjectRiskSummary,
  computeWeightedMilestoneProgressRatio,
  countProjectIncompleteTasks,
  countProjectTasksExcludingCancelled,
  progressUpdatedToMs,
} from "../../projectManager/projectRiskAndProgress";
import { getProjectMilestoneRootsAndResolver } from "../../projectManager/milestoneTreeUtils";
import {
  pickNextActionTaskForL1Track,
  getProjectTaskTagsOrCompute,
  projectStatusDisplayZh,
} from "../../projectManager/projectDerivatives";
import {
  canMarkPendingArchive,
  isProjectCancelledSectionMember,
  isProjectClosedForUiSummary,
  isProjectDoneSectionMember,
  isProjectPendingArchiveSectionMember,
  isProjectShownInInProgressList,
  normalizeProjectStatus,
  projectProgressFilterCategory,
} from "../../projectManager/projectStatus";
import { addDaysYmd, buildProgressChartModel, ymdToFrac, type ProgressChartOptions } from "../../projectManager/projectProgressChart";

/** 存档文件按「项目根相对路径」构建的目录树（侧栏多级展示） */
interface ArchiveDirTree {
  subdirs: Map<string, ArchiveDirTree>;
  files: TFile[];
}

type ProjectCardAction = {
  id: string;
  icon: string;
  title: string;
  run: () => void | Promise<void>;
};

/**
 * 从「项目 ID 或项目根文件夹路径」解析快照中的项目。
 * **必须先按 folderPath**，再按 projectId：否则当某项目的 projectId 与另一项目的文件夹路径字符串相同（或异常数据）时，
 * 会误命中错误项目，表现为 Today 跳转高亮/详情与点击项不一致。
 */
function resolveProjectEntryByIdOrFolderPath(all: ProjectEntry[], key: string): ProjectEntry | undefined {
  const k = String(key ?? "").trim();
  if (!k) return undefined;
  const norm = normalizePath(k);
  const byPath = all.find((x) => normalizePath(String(x.folderPath ?? "").trim()) === norm);
  if (byPath) return byPath;
  return all.find((x) => String(x.projectId ?? "").trim() === k);
}

const PROGRESS_SORT_KEY_LABELS: Record<string, string> = {
  progress_updated: "最后进展更新时间",
  planned_end: "计划结束日",
  created_date: "创建日",
  actual_start: "实际开始日",
  done: "实际完成日",
  cancelled: "取消日",
  pending_archive: "待归档标记日",
  name: "项目名称",
};

/** 里程碑任务清单「任务标签」筛选项（与 `getProjectTaskTagsOrCompute` 的 key 对齐） */
const PROJECT_PROGRESS_TASK_TAG_FILTER_KEYS: string[] = [...TASK_TAG_KEYS, "next_action"];

export type ScrollToProjectNavOpts = {
  /** 从 Today 等入口带入：写入标签筛选，收窄列表便于对准目标任务 */
  applyTaskTagKeys?: string[];
  /** 保证该任务状态在状态筛选中可见（如 DONE 任务） */
  ensureTaskStatus?: string;
};

export class ProjectSidePanelView extends ItemView {
  private plugin: RSLattePlugin;
  private _renderSeq = 0;

  /** project tasklist expand state: key = projectId (stable) */
  private _expandedProjectTasklists = new Set<string>();
  /** milestone expand state: key = `${projectId}::${milestoneName}` */
  private _expandedMilestones = new Set<string>();
  /** 存档树子目录是否展开：`${projectKey}::${相对项目根的路径}` */
  private _expandedArchiveDirs = new Set<string>();
  /** 从 Today 等跳转后短暂高亮对应里程碑行（`${projectKey}::${milestonePath}`） */
  private _milestoneNavFlashMsKey: string | null = null;
  private _milestoneNavFlashUntil = 0;

  private mountProjectCardActions(
    host: HTMLElement,
    actions: ProjectCardAction[],
    moreIds: Set<string>
  ): void {
    const inline = actions.filter((a) => !moreIds.has(a.id));
    const inMore = actions.filter((a) => moreIds.has(a.id));
    const mk = (parent: HTMLElement, a: ProjectCardAction) => {
      const b = parent.createEl("button", { text: a.icon, cls: "rslatte-icon-only-btn" });
      b.title = a.title;
      b.onclick = (ev) => {
        ev.stopPropagation();
        void Promise.resolve(a.run()).catch((e: any) => new Notice(`操作失败：${e?.message ?? String(e)}`));
      };
    };
    for (const a of inline) mk(host, a);
    if (!inMore.length) return;
    const moreBtn = host.createEl("button", { text: "…", cls: "rslatte-icon-only-btn" });
    moreBtn.title = "更多操作";
    moreBtn.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const menu = new Menu();
      for (const a of inMore) {
        menu.addItem((it) => {
          it.setTitle(`${a.icon} ${a.title}`);
          it.onClick(() => void Promise.resolve(a.run()).catch((e: any) => new Notice(`操作失败：${e?.message ?? String(e)}`)));
        });
      }
      menu.showAtMouseEvent(ev);
    };
  }

  private getProjectTaskCardMoreIds(): Set<string> {
    const panel = ((this.plugin.settings as any)?.projectPanel ?? {}) as Record<string, any>;
    const raw = panel.sidePanelProjectTaskCardActionsInMore;
    return new Set(Array.isArray(raw) ? raw.map((x) => String(x ?? "").trim()).filter(Boolean) : []);
  }

  private getProjectMilestoneCardMoreIds(): Set<string> {
    const panel = ((this.plugin.settings as any)?.projectPanel ?? {}) as Record<string, any>;
    const raw = panel.sidePanelProjectMilestoneCardActionsInMore;
    return new Set(Array.isArray(raw) ? raw.map((x) => String(x ?? "").trim()).filter(Boolean) : []);
  }

  private getProjectCardMoreIds(): Set<string> {
    const panel = ((this.plugin.settings as any)?.projectPanel ?? {}) as Record<string, any>;
    const raw = panel.sidePanelProjectCardActionsInMore;
    return new Set(Array.isArray(raw) ? raw.map((x) => String(x ?? "").trim()).filter(Boolean) : []);
  }

  constructor(leaf: WorkspaceLeaf, plugin: RSLattePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_PROJECTS; }
  getDisplayText(): string { return "项目管理"; }
  getIcon(): string { return "folder-kanban"; }

  async onOpen() {
    // Step4-2a: 默认全部收起（项目任务清单与各里程碑展开状态不跨会话保留）
    // 用户每次打开侧边栏时，从“全收起”的一致状态开始。
    this._expandedProjectTasklists.clear();
    this._expandedMilestones.clear();
    this._expandedArchiveDirs.clear();

    // 第八节 SWR：仅在 ensureReady 尚未成功完成前尝试灌入 `project-panel-hydrate.json`，先 render 再后台 ensureReady+refresh；否则阻塞式 ensureReady。
    const tOpen = this.plugin.isDebugLogEnabled() ? performance.now() : 0;
    if (this.plugin.isPipelineModuleEnabled("project")) {
      const ver = String(this.plugin.manifest?.version ?? "0.0.1");
      let usedHydrateFastPath = false;
      try {
        if (!this.plugin.projectMgr.isEnsureReadySettled()) {
          const hydrated = await this.plugin.projectMgr.tryReadPanelHydrateSnapshot(ver);
          if (hydrated && (hydrated.projects?.length ?? 0) > 0) {
            this.plugin.projectMgr.applyPanelHydrateSnapshot(hydrated);
            usedHydrateFastPath = true;
            new Notice("已显示缓存的项目列表，后台同步中…", 3500);
          }
        }
      } catch (e) {
        console.warn("[RSLatte][ProjectView] panel hydrate read failed", e);
      }

      try {
        if (!usedHydrateFastPath) {
          const tEr = this.plugin.isDebugLogEnabled() ? performance.now() : 0;
          await this.plugin.projectMgr.ensureReady();
          if (this.plugin.isDebugLogEnabled()) {
            this.plugin.dbg("projectPanel", "onOpen: ensureReady done", { ms: +(performance.now() - tEr).toFixed(1) });
          }
        }
      } catch (e) {
        console.warn("[RSLatte] projectMgr.ensureReady on ProjectSidePanel open failed", e);
      }

      if (usedHydrateFastPath) {
        void this.runProjectPanelHydrateFollowUp();
      } else {
        void this.plugin.projectMgr.writePanelHydrateSnapshot().catch((e) => {
          console.warn("[RSLatte][ProjectView] writePanelHydrateSnapshot failed", e);
        });
      }
    }
    const tRender0 = this.plugin.isDebugLogEnabled() ? performance.now() : 0;
    await this.render();
    if (this.plugin.isDebugLogEnabled() && tOpen) {
      this.plugin.dbg("projectPanel", "onOpen: render done", {
        renderMs: +(performance.now() - tRender0).toFixed(1),
        totalOnOpenMs: +(performance.now() - tOpen).toFixed(1),
      });
    }
  }

  async onClose() {
    // 从工作区移除/卸载本视图时（非仅折叠侧栏）：下次再打开项目管理时从「项目清单」开始。
    // 同一会话内多侧栏并存、切换焦点时本视图通常不卸载，故仍可记住「项目进度管理」。
    try {
      const sAny: any = this.plugin.settings as any;
      if (!sAny.projectPanel) sAny.projectPanel = {};
      sAny.projectPanel.mainTab = "list";
      await this.plugin.saveSettings();
    } catch (e) {
      console.warn("[RSLatte][ProjectView] mainTab reset on view close failed", e);
    }
  }


  public refresh() {
    void this.render();
  }

  /** 第八节：hydrate 首帧后后台 ensureReady + 增量刷新 + 落盘快照；失败则 Notice（不受调试开关限制） */
  private async runProjectPanelHydrateFollowUp(): Promise<void> {
    try {
      await this.plugin.projectMgr.ensureReady();
      await this.plugin.projectMgr.refreshDirty({ reason: "panel_open_swr" });
      await this.plugin.projectMgr.writePanelHydrateSnapshot();
      this.refresh();
    } catch (e) {
      new Notice("项目数据刷新失败，列表可能已过期；请尝试点击刷新", 8000);
      console.warn("[RSLatte] 数据可能过期（项目管理）", e);
    }
  }

  private async render() {
    const seq = ++this._renderSeq;

    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("rslatte-project-panel");

    // Step E1：模块开关（与 Engine 一致）
    const projectEnabled = this.plugin.isPipelineModuleEnabled("project");

    // 模块关闭：侧边栏内容完全隐藏（不显示标题/按钮/列表）
    if (!projectEnabled) {
      return;
    }

    // header
    const projectHeaderSection = container.createDiv({ cls: "rslatte-section" });
    const { left: projectHeaderLeft, right: projectHeaderActions } = createHeaderRow(
      projectHeaderSection,
      "rslatte-section-title-row",
      "rslatte-section-title-left",
      "rslatte-task-actions",
    );

    projectHeaderLeft.createEl("h3", { text: "🎯 项目管理" });

    // module-level DB sync indicator (same style as output/task)
    const dot = projectHeaderLeft.createEl("span", { text: "…", cls: "rslatte-project-sync" });
    dot.title = "同步状态：加载中…";

    const updateDot = () => {
      try {
        const ind = (this.plugin as any).getDbSyncIndicator?.("project");
        if (!ind || typeof ind !== "object") {
          dot.textContent = "";
          dot.title = "";
          dot.style.display = "none";
          return;
        }
        const iconText = String((ind as any).icon ?? "");
        dot.textContent = iconText;
        dot.title = String((ind as any).title ?? "");
        dot.style.display = iconText ? "" : "none";
      } catch {
        dot.textContent = "";
        dot.title = "";
        dot.style.display = "none";
      }
    };

    // 初次渲染立即更新一次（若后台 init 已完成，可直接显示 🟢/🟡/🔴）
    updateDot();


    const projBtnVis = getUiHeaderButtonsVisibility(this.plugin.settings, "project");

    const addBtn = projectHeaderActions.createEl("button", { text: "➕", cls: "rslatte-icon-btn" });
    addBtn.title = "新增项目";
    if (!projectEnabled) {
      addBtn.disabled = true;
    } else {
      addBtn.onclick = () => new AddProjectModal(this.app, this.plugin).open();
    }

        if (projBtnVis.rebuild) {
      const rebuildBtn = projectHeaderActions.createEl("button", { text: "🧱", cls: "rslatte-icon-btn" });
          rebuildBtn.title = "扫描重建项目索引（全量）";
          if (!projectEnabled) {
            rebuildBtn.disabled = true;
          } else {
            rebuildBtn.onclick = async () => {
              new Notice("开始扫描重建：项目…");
              const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "project", "rebuild");
              if (!r.ok) {
                new Notice(`重建失败：${r.error.message}（module=project, mode=rebuild）`);
                console.warn('[RSLatte][ui] runE2 failed', { moduleKey: 'project', mode: 'rebuild', error: r.error });
                return;
              }
              if (!r.data.skipped) {
                const runId = (r.data as any).runId ? ` (${(r.data as any).runId})` : '';
                new Notice(`项目索引已重建${runId}`);
              }
              this.refresh();
            };
          }
    }

    if (projBtnVis.archive) {
      const archiveBtn = projectHeaderActions.createEl("button", { text: "🗄", cls: "rslatte-icon-btn" });
          archiveBtn.title =
            "项目归档两步（一次完成）：① 移动项目文件夹到归档目录；② 再将主索引条迁出到 archive 分片。不会只做其中一步。";
          if (!projectEnabled) {
            archiveBtn.disabled = true;
          } else {
            archiveBtn.onclick = async () => {
              new Notice("开始项目归档（笔记+索引）…");
              const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "project", "manual_archive");
              if (!r.ok) {
                new Notice(`归档失败：${r.error.message}（module=project, mode=manual_archive）`);
                console.warn('[RSLatte][ui] runE2 failed', { moduleKey: 'project', mode: 'manual_archive', error: r.error });
                return;
              }
              if (!r.data.skipped) {
                const ui = normalizeRunSummaryForUi(r.data);
                const n = Number(ui.archivedCount ?? 0);
                const runId = (r.data as any).runId ? ` (${(r.data as any).runId})` : '';
                if (n > 0) new Notice(`已归档 ${n} 个项目${runId}`);
                else new Notice(`无可归档项目${runId}`);
              }
              this.refresh();
            };
          }
    }

    if (projBtnVis.refresh) {
      const refreshBtn = projectHeaderActions.createEl("button", { text: "🔄", cls: "rslatte-icon-btn" });
          refreshBtn.title = "刷新（增量）项目清单";
          if (!projectEnabled) {
            refreshBtn.disabled = true;
          } else {
            refreshBtn.onclick = async () => {
              new Notice("开始刷新：项目…");
              const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "project", "manual_refresh");
              if (!r.ok) {
                new Notice(`刷新失败：${r.error.message}（module=project, mode=manual_refresh）`);
                console.warn('[RSLatte][ui] runE2 failed', { moduleKey: 'project', mode: 'manual_refresh', error: r.error });
                return;
              }
              if (!r.data.skipped) {
                const runId = (r.data as any).runId ? ` (${(r.data as any).runId})` : '';
                new Notice(`项目索引已刷新${runId}`);
              }
              // ✅ 刷新后强制写入项目进度到日记（即使检测不到更新，也检查统计变化）
              await (this.plugin as any).writeTodayProjectProgressToJournal?.(true);
              this.refresh();
            };
          }
    }

    const ppTabs = (this.plugin.settings as any).projectPanel ?? {};
    if (ppTabs.mainTab !== "list" && ppTabs.mainTab !== "progress") ppTabs.mainTab = "list";

    const tabRow = container.createDiv({ cls: "rslatte-project-panel-tabs" });
    const tabListBtn = tabRow.createEl("button", { cls: "rslatte-project-panel-tab", text: "项目清单" });
    const tabProgBtn = tabRow.createEl("button", { cls: "rslatte-project-panel-tab", text: "项目进度管理" });
    tabListBtn.toggleClass("is-active", ppTabs.mainTab === "list");
    tabProgBtn.toggleClass("is-active", ppTabs.mainTab === "progress");
    tabListBtn.onclick = async () => {
      ppTabs.mainTab = "list";
      await this.plugin.saveSettings();
      void this.render();
    };
    tabProgBtn.onclick = async () => {
      ppTabs.mainTab = "progress";
      await this.plugin.saveSettings();
      void this.render();
    };

    if (ppTabs.mainTab === "progress") {
      this.renderProgressManagementTab(container);
      return;
    }

    const listRoot = container.createDiv({ cls: "rslatte-project-list-tab-root" });

    // ===== 进行中的项目清单 =====
    const inProgressListWrap = listRoot.createDiv({ cls: "rslatte-section rslatte-project-section" });
    const inProgressHeader = inProgressListWrap.createDiv({ cls: "rslatte-section-title-row" });
    
    // 读取折叠状态（默认展开）
    const inProgressCollapsed = (this.plugin.settings as any).projectPanel?.inProgressListCollapsed ?? false;
    
    // 折叠图标和标题
    const inProgressCollapsedIcon = inProgressHeader.createSpan({ 
      cls: "rslatte-stats-collapse-icon", 
      text: inProgressCollapsed ? "▶" : "▼" 
    });
    const inProgressTitleEl = inProgressHeader.createEl("h4", { text: "进行中的项目", cls: "rslatte-section-subtitle" });
    inProgressHeader.style.cursor = "pointer";
    
    // 点击标题切换折叠状态
    inProgressHeader.onclick = () => {
      const newCollapsed = !inProgressCollapsed;
      // 保存到设置
      if (!(this.plugin.settings as any).projectPanel) {
        (this.plugin.settings as any).projectPanel = {};
      }
      (this.plugin.settings as any).projectPanel.inProgressListCollapsed = newCollapsed;
      void this.plugin.saveSettings();
      // 重新渲染
      void this.render();
    };
    
    // 项目列表容器
    const inProgressProjectsContainer = inProgressListWrap.createDiv();
    if (inProgressCollapsed) {
      inProgressProjectsContainer.style.display = "none";
    }
    
    // 快速检查是否有数据，如果有则立即显示，如果没有则显示"加载中"
    const initialSnap = this.plugin.projectMgr.getSnapshot();
    const hasProjects = initialSnap && (initialSnap.projects ?? []).length > 0;
    
    if (hasProjects) {
      // 如果有数据，立即渲染（不等待刷新）
      try {
        const snap = this.plugin.projectMgr.getSnapshot();
        if (!snap) {
          inProgressProjectsContainer.createDiv({ cls: "rslatte-task-empty", text: "（加载失败：项目快照为空）" });
        } else {
          const projects = (snap.projects ?? []).filter((p) => isProjectShownInInProgressList(p.status));

          if (!projects.length) {
            inProgressProjectsContainer.createDiv({ cls: "rslatte-task-empty", text: "（暂无进行中的项目）" });
          } else {
            projects
              .sort((a, b) => (a.projectName || "").localeCompare(b.projectName || "", "zh-Hans-CN"))
              .forEach((p) => this.renderProject(inProgressProjectsContainer, p));
          }
        }
        // 不再自动触发后台刷新，避免循环调用导致 UI 卡死
        // refreshDirty 会自动触发 refreshSidePanel()，不需要手动刷新
      } catch (e: any) {
        inProgressProjectsContainer.empty();
        inProgressProjectsContainer.createDiv({ cls: "rslatte-task-empty", text: `加载失败：${e?.message ?? String(e)}` });
      }
    } else {
      // 如果没有数据，先显示"加载中"，然后异步检查索引并加载数据
      inProgressProjectsContainer.createDiv({ cls: "rslatte-project-hint", text: "（数据加载中…）" });
      
      // 在后台异步检查索引并加载数据
      void (async () => {
        try {
          // 检查索引是否存在
          const hasIndexData = await (this.plugin.projectMgr as any).checkIndexHasData?.();
          if (!hasIndexData) {
            // 索引不存在，说明确实没有项目数据，更新 UI 显示"暂无项目数据"
            if (inProgressProjectsContainer && inProgressProjectsContainer.parentElement) {
              inProgressProjectsContainer.empty();
              inProgressProjectsContainer.createDiv({ cls: "rslatte-task-empty", text: "（暂无进行中的项目）" });
            }
            updateDot();
            return;
          }
          
          // 索引存在，触发加载数据
          await this.loadAndRenderDataInBackground(inProgressProjectsContainer, updateDot);
        } catch (e) {
          // 如果检查索引失败，仍然尝试加载数据
          console.warn("[RSLatte][ProjectView] check index failed:", e);
          await this.loadAndRenderDataInBackground(inProgressProjectsContainer, updateDot);
        }
      })();
    }

    // ===== 已完成的项目清单 =====
    const doneListWrap = listRoot.createDiv({ cls: "rslatte-section rslatte-project-section" });
    const doneHeader = doneListWrap.createDiv({ cls: "rslatte-section-title-row" });
    
    // 读取折叠状态（默认折叠）
    const doneCollapsed = (this.plugin.settings as any).projectPanel?.doneListCollapsed ?? true;
    
    // 折叠图标和标题
    const doneCollapsedIcon = doneHeader.createSpan({ 
      cls: "rslatte-stats-collapse-icon", 
      text: doneCollapsed ? "▶" : "▼" 
    });
    const doneTitleEl = doneHeader.createEl("h4", { text: "已完成的项目", cls: "rslatte-section-subtitle" });
    doneHeader.style.cursor = "pointer";
    
    // 点击标题切换折叠状态
    doneHeader.onclick = () => {
      const newCollapsed = !doneCollapsed;
      // 保存到设置
      if (!(this.plugin.settings as any).projectPanel) {
        (this.plugin.settings as any).projectPanel = {};
      }
      (this.plugin.settings as any).projectPanel.doneListCollapsed = newCollapsed;
      void this.plugin.saveSettings();
      // 重新渲染
      void this.render();
    };
    
    // 项目列表容器
    const doneProjectsContainer = doneListWrap.createDiv();
    if (doneCollapsed) {
      doneProjectsContainer.style.display = "none";
    }
    
    try {
      const snap = this.plugin.projectMgr.getSnapshot();
      if (!snap) {
        doneProjectsContainer.createDiv({ cls: "rslatte-task-empty", text: "（加载失败：项目快照为空）" });
      } else {
        const doneProjects = (snap.projects ?? []).filter((p) => isProjectDoneSectionMember(p.status));

        if (!doneProjects.length) {
          doneProjectsContainer.createDiv({ cls: "rslatte-task-empty", text: "（暂无已完成的项目）" });
        } else {
          doneProjects
            .sort((a, b) => (a.projectName || "").localeCompare(b.projectName || "", "zh-Hans-CN"))
            .forEach((p) => this.renderDoneProject(doneProjectsContainer, p));
        }
      }
    } catch (e: any) {
      doneProjectsContainer.empty();
      doneProjectsContainer.createDiv({ cls: "rslatte-task-empty", text: `加载失败：${e?.message ?? String(e)}` });
    }

    // ===== 待归档项目（已点「标记待归档」，超阈值后将随笔记归档移入归档目录）=====
    const pendListWrap = listRoot.createDiv({ cls: "rslatte-section rslatte-project-section" });
    const pendHeader = pendListWrap.createDiv({ cls: "rslatte-section-title-row" });
    const pendCollapsed = (this.plugin.settings as any).projectPanel?.pendingArchiveListCollapsed ?? true;
    const pendCollapsedIcon = pendHeader.createSpan({
      cls: "rslatte-stats-collapse-icon",
      text: pendCollapsed ? "▶" : "▼",
    });
    pendHeader.createEl("h4", { text: "待归档项目", cls: "rslatte-section-subtitle" });
    pendHeader.style.cursor = "pointer";
    pendHeader.onclick = () => {
      const newCollapsed = !pendCollapsed;
      if (!(this.plugin.settings as any).projectPanel) {
        (this.plugin.settings as any).projectPanel = {};
      }
      (this.plugin.settings as any).projectPanel.pendingArchiveListCollapsed = newCollapsed;
      void this.plugin.saveSettings();
      void this.render();
    };
    const pendProjectsContainer = pendListWrap.createDiv();
    if (pendCollapsed) {
      pendProjectsContainer.style.display = "none";
    }
    try {
      const snapP = this.plugin.projectMgr.getSnapshot();
      if (!snapP) {
        pendProjectsContainer.createDiv({ cls: "rslatte-task-empty", text: "（加载失败：项目快照为空）" });
      } else {
        const pendProjects = (snapP.projects ?? []).filter((p) => isProjectPendingArchiveSectionMember(p.status));
        if (!pendProjects.length) {
          pendProjectsContainer.createDiv({ cls: "rslatte-task-empty", text: "（暂无待归档项目）" });
        } else {
          pendProjects
            .sort((a, b) => (a.projectName || "").localeCompare(b.projectName || "", "zh-Hans-CN"))
            .forEach((p) => this.renderPendingArchiveProject(pendProjectsContainer, p));
        }
      }
    } catch (e: any) {
      pendProjectsContainer.empty();
      pendProjectsContainer.createDiv({ cls: "rslatte-task-empty", text: `加载失败：${e?.message ?? String(e)}` });
    }

    // ✅ 取消项目清单（始终显示，独立于主列表的加载状态）
    const cancelledListWrap = listRoot.createDiv({ cls: "rslatte-section rslatte-project-section" });
    const cancelledHeader = cancelledListWrap.createDiv({ cls: "rslatte-section-title-row" });
    
    // 读取折叠状态（默认折叠）
    const collapsed = (this.plugin.settings as any).projectPanel?.cancelledListCollapsed ?? true;
    
    // 折叠图标和标题
    const collapsedIcon = cancelledHeader.createSpan({ 
      cls: "rslatte-stats-collapse-icon", 
      text: collapsed ? "▶" : "▼" 
    });
    const titleEl = cancelledHeader.createEl("h4", { text: "取消项目清单", cls: "rslatte-section-subtitle" });
    cancelledHeader.style.cursor = "pointer";
    
    // 点击标题切换折叠状态
    cancelledHeader.onclick = () => {
      const newCollapsed = !collapsed;
      // 保存到设置
      if (!(this.plugin.settings as any).projectPanel) {
        (this.plugin.settings as any).projectPanel = {};
      }
      (this.plugin.settings as any).projectPanel.cancelledListCollapsed = newCollapsed;
      void this.plugin.saveSettings();
      // 重新渲染
      void this.render();
    };
    
    // 项目列表容器
    const cancelledProjectsContainer = cancelledListWrap.createDiv();
    if (collapsed) {
      cancelledProjectsContainer.style.display = "none";
    }
    
    try {
      const snap = this.plugin.projectMgr.getSnapshot();
      if (!snap) {
        cancelledProjectsContainer.createDiv({ cls: "rslatte-task-empty", text: "（加载失败：项目快照为空）" });
      } else {
        const cancelledProjects = (snap.projects ?? []).filter((p) => isProjectCancelledSectionMember(p.status));

        if (!cancelledProjects.length) {
          cancelledProjectsContainer.createDiv({ cls: "rslatte-task-empty", text: "（暂无取消的项目）" });
        } else {
          cancelledProjects
            .sort((a, b) => (a.projectName || "").localeCompare(b.projectName || "", "zh-Hans-CN"))
            .forEach((p) => this.renderCancelledProject(cancelledProjectsContainer, p));
        }
      }
    } catch (e: any) {
      cancelledProjectsContainer.empty();
      cancelledProjectsContainer.createDiv({ cls: "rslatte-task-empty", text: `加载失败：${e?.message ?? String(e)}` });
    }
  }


  /** 后台异步加载并渲染数据（当没有数据时） */
  private async loadAndRenderDataInBackground(container: HTMLElement, updateDot: () => void) {
    try {
      // 检查当前快照是否为空（可能是在空间切换后或知识库重新打开后）
      let initialSnap = this.plugin.projectMgr.getSnapshot();
      let hasProjects = initialSnap && (initialSnap.projects ?? []).length > 0;
      
      // 如果快照为空，尝试从索引快速加载数据
      if (!hasProjects) {
        try {
          // 检查索引是否存在且有数据
          const hasIndexData = await (this.plugin.projectMgr as any).checkIndexHasData?.();
          if (hasIndexData) {
            // 索引存在，标记所有索引中的项目为 dirty，然后增量刷新
            // 这样会正确解析文件并构建完整的树形结构
            await (this.plugin.projectMgr as any).markIndexProjectsDirtyAndRefresh?.();
          } else {
            // 索引不存在或为空，需要全量扫描重建索引
            // 等待刷新完成，以便检查是否真的有项目数据
            await this.plugin.projectMgr.refreshAll({ reason: "open_view_after_space_switch", forceSync: false });
          }
          // 刷新后写入项目进度到日记（等待刷新完成后再写入）
          await (this.plugin as any).writeTodayProjectProgressToJournal?.();
        } catch (e) {
          console.warn("[RSLatte][ProjectView] background load failed:", e);
        }
      } else {
        // 如果有数据，只做轻量级的增量刷新，不阻塞
        // 使用 void 确保不阻塞
        await this.plugin.projectMgr.refreshDirty({ reason: "open_view" });
        // 刷新后写入项目进度到日记（等待刷新完成后再写入）
        await (this.plugin as any).writeTodayProjectProgressToJournal?.();
      }
      
      // 等待一小段时间，让刷新操作完成
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // 检查刷新后的快照，看是否真的有项目数据
      const finalSnap = this.plugin.projectMgr.getSnapshot();
      const finalHasProjects = finalSnap && (finalSnap.projects ?? []).length > 0;
      
      if (!finalHasProjects) {
        // 如果刷新后仍然没有项目数据，说明确实没有项目，更新 UI 显示"暂无项目数据"
        // 检查 container 是否仍然存在（没有被 refreshSidePanel 重新渲染）
        if (container && container.parentElement) {
          container.empty();
          container.createDiv({ cls: "rslatte-task-empty", text: "（暂无进行中的项目）" });
        }
        // 如果 container 已经被重新渲染，说明 refreshSidePanel 已经触发了重新渲染
        // 此时 render() 会再次检查，但由于我们已经尝试过加载，应该显示"暂无项目数据"
        // 为了避免循环，我们需要在 render() 中也添加类似的检查
      } else {
        // 如果有数据，refreshDirty/refreshAll/autoSync 会自动触发 refreshSidePanel()
        // refreshSidePanel() 会调用 this.refresh() -> this.render()
        // 此时 render() 会检测到 hasProjects 为 true，正常渲染项目列表
      }
      
      // 更新状态灯
      updateDot();
    } catch (e: any) {
      if (container && container.parentElement) {
        container.empty();
        container.createDiv({ cls: "rslatte-task-empty", text: `加载失败：${e?.message ?? String(e)}` });
      }
    }
  }

  /** 顶栏与概要：优先快照衍生中文状态（第九节 9.4） */
  private projectHeadStatusText(p: ProjectEntry): string {
    const z = String((p as any).project_status_display_zh ?? "").trim();
    return z || projectStatusDisplayZh(p.status);
  }

  private renderProject(parent: HTMLElement, p: ProjectEntry) {
    const card = parent.createDiv({ cls: "rslatte-project-card" });
    // 添加标识属性，用于从其他视图跳转定位
    const projectId = String(p.projectId ?? "").trim();
    const folderPath = normalizePath(String(p.folderPath ?? "").trim());
    if (projectId) card.setAttribute("data-project-id", projectId);
    if (folderPath) card.setAttribute("data-project-folder-path", folderPath);
    // ===== Row 1: 项目名 + 同步灯 | 右侧 status（操作在「项目进度管理」） =====
    const headRow = card.createDiv({ cls: "rslatte-proj-headrow" });
    const nameWrap = headRow.createDiv({ cls: "rslatte-proj-namewrap" });

    const title = nameWrap.createEl("div", { cls: "rslatte-proj-title rslatte-project-title", text: p.projectName });
    title.title = "打开项目任务清单";
    title.onclick = () => {
      const af = this.app.vault.getAbstractFileByPath(p.tasklistFilePath);
      if (af instanceof TFile) void this.app.workspace.getLeaf(true).openFile(af);
    };

    this.maybeAppendProjectDbSyncIcon(nameWrap, p);

    headRow.createDiv({ cls: "rslatte-proj-status-text", text: this.projectHeadStatusText(p) });

    // 项目操作（延期/里程碑/分析图/存档/取消/完成等）已迁至「项目进度管理」详情，清单卡片仅保留信息与「查看项目进度」入口。

    // meta row（风险等级标签在最前，与时间信息同行）
    const meta = card.createDiv({ cls: "rslatte-project-meta" });
    const parts: string[] = [];
    if (p.created_date) parts.push(`创建 ${p.created_date}`);
    if (p.planned_end) parts.push(`计划结束 ${p.planned_end}`);
    if (p.actual_start) parts.push(`开始 ${p.actual_start}`);
    if (p.progress_updated) parts.push(`进展 ${p.progress_updated}`);
    this.fillProjectMetaWithRisk(meta, p, parts);

    // V2 推进区：每里程碑两行（1 名称+未完成数；2 下一步+图标+描述+标签+计划结束日）
    const advanceRow = card.createDiv({ cls: "rslatte-project-advance" });
    const taskPanel = this.plugin.settings?.taskPanel ?? undefined;
    const today = getTaskTodayKey(taskPanel);
    const descMaxLen = Math.max(1, Math.min(200, Number((this.plugin.settings as any).projectPanel?.projectAdvanceDescMaxLen ?? 36)));
    const { roots, effectivePathForTask } = this.getProjectRootsAndPathResolver(p);
    const allTasks = (p.taskItems ?? []) as ProjectTaskItem[];

    if (!roots.length) {
      advanceRow.createDiv({ cls: "rslatte-project-advance-empty", text: "暂无里程碑" });
    } else {
      const listWrap = advanceRow.createDiv({ cls: "rslatte-project-advance-next-list" });
      for (const root of roots) {
        const milestonePath = String((root as any)?.path ?? (root as any)?.name ?? "").trim();
        const milestoneName = String((root as any)?.name ?? milestonePath).trim();
        const subtreeTasks = allTasks.filter((it) => {
          const ep = effectivePathForTask(it);
          if (!ep || !milestonePath) return false;
          return ep === milestonePath || ep.startsWith(milestonePath + " / ");
        });
        const activeTasks = subtreeTasks.filter((t) => t.statusName !== "DONE" && t.statusName !== "CANCELLED");
        const nextTask = pickNextActionTaskForL1Track(allTasks, milestonePath, effectivePathForTask);

        const itemRow = listWrap.createDiv({ cls: "rslatte-project-advance-next-item" });
        const row1 = itemRow.createDiv({ cls: "rslatte-project-advance-next-row1" });
        row1.createSpan({ cls: "rslatte-project-advance-ms-name", text: milestoneName });
        const countSpan = row1.createSpan({ cls: "rslatte-project-advance-count" });
        countSpan.setText(`未完成 ${activeTasks.length}`);
        countSpan.title = "在项目进度管理中打开本项目，展开「项目里程碑/任务清单」并展开该里程碑，查看其下全部任务";
        countSpan.style.cursor = "pointer";
        countSpan.onclick = async () => {
          const panel = (this.plugin.settings as any).projectPanel ?? {};
          panel.mainTab = "progress";
          const projectKey = String(p.projectId ?? p.folderPath ?? "").trim();
          panel.progressSelectedProjectId = projectKey || normalizePath(String(p.folderPath ?? "").trim());
          panel.progressSearchCollapsed = true;
          panel.milestonesListCollapsed = false;
          try {
            await this.plugin.saveSettings();
            await this.scrollToProject(panel.progressSelectedProjectId, milestonePath);
          } catch (e) {
            console.warn("[RSLatte][ProjectView] advance 未完成 navigate failed", e);
          }
        };

        const row2 = itemRow.createDiv({ cls: "rslatte-project-advance-next-row2" });
        if (nextTask) {
          row2.createSpan({ cls: "rslatte-project-advance-next-label", text: "下一步" });
          const iconSpan = row2.createSpan({ cls: "rslatte-project-advance-icon", text: this.projectTaskStatusIcon(nextTask) });
          iconSpan.title = this.projectTaskStatusDisplayName(nextTask);
          const descSpan = row2.createEl("span", { cls: "rslatte-project-advance-desc" });
          const descText = (nextTask.text || "（无描述）").slice(0, descMaxLen);
          descSpan.setText(descText + (nextTask.text && nextTask.text.length > descMaxLen ? "…" : ""));
          descSpan.title = nextTask.text || "";
          descSpan.style.cursor = "pointer";
          descSpan.onclick = () => {
            const projectKey = String(p.projectId ?? p.folderPath ?? "").trim();
            const filePath = String(nextTask.sourceFilePath ?? p.tasklistFilePath ?? "").trim();
            const panel = (this.plugin.settings as any).projectPanel ?? {};
            panel.mainTab = "progress";
            panel.progressSelectedProjectId = projectKey || normalizePath(String(p.folderPath ?? "").trim());
            panel.progressSearchCollapsed = true;
            void this.plugin.saveSettings().then(() => {
              void this.scrollToProject(projectKey, milestonePath, filePath, nextTask.lineNo);
            });
          };
          const tags = getProjectTaskTagsOrCompute(nextTask, today, taskPanel);
          if (tags.length > 0) {
            const tagsWrap = row2.createSpan({ cls: "rslatte-task-tags-row rslatte-project-advance-tags" });
            const colorNames: Record<number, string> = { 1: "red", 2: "orange", 3: "yellow", 4: "green" };
            for (const key of tags) {
              const info = TASK_TAG_META[key];
              const chip = tagsWrap.createSpan({ cls: "rslatte-task-tag" });
              chip.setText(info?.label ?? key);
              chip.setAttr("title", info?.fullName ?? key);
              chip.addClass(`rslatte-task-tag--${colorNames[info?.colorOrder ?? 4] ?? "green"}`);
            }
          }
          const dueYmd = String(nextTask.planned_end ?? "").trim();
          if (/^\d{4}-\d{2}-\d{2}$/.test(dueYmd)) {
            row2.createSpan({ cls: "rslatte-project-advance-due", text: `⏳ ${dueYmd}` });
          }
        } else {
          const hintSpan = row2.createSpan({ cls: "rslatte-project-advance-hint" });
          hintSpan.setText(subtreeTasks.length === 0 ? "待添加任务" : "已全部完成");
        }
      }
    }

    this.renderProjectProgressNavRow(card, p);
  }

  /**
   * 渲染「项目里程碑/任务清单」：进度管理页内**整块始终可见**，一级里程碑默认折叠，由「全部展开 / 全部收起」控制。
   */
  private renderMilestonesSection(card: HTMLElement, p: ProjectEntry) {
    const msWrap = card.createDiv({ cls: "rslatte-section rslatte-project-section rslatte-project-milestones" });

    const milestones = (p.milestones ?? []) as MilestoneProgress[];
    const taskItems = (p.taskItems ?? []) as ProjectTaskItem[];
    const milestoneCount = milestones.length;
    const taskCount = taskItems.length;
    const activeCount = taskItems.filter((t) => t.statusName !== "DONE" && t.statusName !== "CANCELLED").length;

    const projectKey = String(p.projectId ?? p.folderPath ?? "").trim();
    const sAny: any = this.plugin.settings as any;
    if (!sAny.projectPanel) sAny.projectPanel = {};
    const pp = sAny.projectPanel;
    const allowedStatuses = new Set(["TODO", "IN_PROGRESS", "DONE", "CANCELLED"]);
    const rawStatuses = Array.isArray(pp.progressTaskListFilterStatuses) ? pp.progressTaskListFilterStatuses : [];
    const selectedStatusSet = new Set<string>(rawStatuses.filter((x: string) => allowedStatuses.has(String(x))));
    if (selectedStatusSet.size === 0) {
      selectedStatusSet.clear();
      selectedStatusSet.add("TODO");
      selectedStatusSet.add("IN_PROGRESS");
      selectedStatusSet.add("DONE");
      selectedStatusSet.add("CANCELLED");
      pp.progressTaskListFilterStatuses = Array.from(selectedStatusSet);
      void this.plugin.saveSettings();
    }
    const limitOptions = [10, 20, 30, 50, 100];
    const rawLimit = Number(pp.progressTaskListDisplayLimit ?? 10);
    const displayLimit = limitOptions.includes(rawLimit) ? rawLimit : 10;
    if (!limitOptions.includes(rawLimit)) {
      pp.progressTaskListDisplayLimit = displayLimit;
      void this.plugin.saveSettings();
    }

    const rawTagKeys = Array.isArray(pp.progressTaskListFilterTagKeys) ? pp.progressTaskListFilterTagKeys : [];
    const selectedTagSet = new Set(
      rawTagKeys.map((x) => String(x ?? "").trim()).filter((x) => PROJECT_PROGRESS_TASK_TAG_FILTER_KEYS.includes(x))
    );

    const headerRow = msWrap.createDiv({ cls: "rslatte-project-progress-section-header-row" });
    const headerLeft = headerRow.createDiv({ cls: "rslatte-project-progress-section-header-left" });
    headerLeft.createSpan({ cls: "rslatte-project-progress-section-title", text: "项目里程碑/任务清单" });
    headerRow.createDiv({ cls: "rslatte-project-progress-section-badge", text: `里程碑 ${milestoneCount} 任务 ${taskCount} 未完成 ${activeCount}` });

    const toolRow = msWrap.createDiv({ cls: "rslatte-project-progress-section-toolbar" });
    const expandAllBtn = toolRow.createEl("button", { text: "全部展开", cls: "rslatte-project-progress-toolbar-btn" });
    expandAllBtn.title = "展开所有里程碑节点（含子里程碑）";
    expandAllBtn.onclick = (ev) => {
      ev.stopPropagation();
      this.expandAllMilestoneKeysForProject(p, projectKey);
      this.refresh();
    };
    const collapseAllBtn = toolRow.createEl("button", { text: "全部收起", cls: "rslatte-project-progress-toolbar-btn" });
    collapseAllBtn.title = "收起所有里程碑，仅保留一级行";
    collapseAllBtn.onclick = (ev) => {
      ev.stopPropagation();
      if (projectKey) {
        const prefix = `${projectKey}::`;
        for (const k of Array.from(this._expandedMilestones)) {
          if (k.startsWith(prefix)) this._expandedMilestones.delete(k);
        }
      }
      this.refresh();
    };

    const statusOptions: Array<{ key: "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED"; label: string }> = [
      { key: "TODO", label: "待办" },
      { key: "IN_PROGRESS", label: "进行中" },
      { key: "DONE", label: "已完成" },
      { key: "CANCELLED", label: "已取消" },
    ];
    const statusAllKeys = statusOptions.map((o) => o.key);
    const persistStatuses = async () => {
      pp.progressTaskListFilterStatuses = statusOptions
        .map((o) => o.key)
        .filter((k) => selectedStatusSet.has(k));
      if (!Array.isArray(pp.progressTaskListFilterStatuses) || pp.progressTaskListFilterStatuses.length === 0) {
        pp.progressTaskListFilterStatuses = ["TODO", "IN_PROGRESS", "DONE", "CANCELLED"];
      }
      await this.plugin.saveSettings();
    };
    this.mountProgressTaskListMultiSelectDropdown(toolRow, {
      anchorLabel: "状态",
      allKeys: statusAllKeys,
      optionList: statusOptions,
      selected: selectedStatusSet,
      mode: "status",
      persist: persistStatuses,
    });

    const tagOptionList = PROJECT_PROGRESS_TASK_TAG_FILTER_KEYS.map((key) => ({
      key,
      label: TASK_TAG_META[key]?.label ?? key,
    }));
    const persistTags = async () => {
      pp.progressTaskListFilterTagKeys = PROJECT_PROGRESS_TASK_TAG_FILTER_KEYS.filter((k) => selectedTagSet.has(k));
      await this.plugin.saveSettings();
    };
    this.mountProgressTaskListMultiSelectDropdown(toolRow, {
      anchorLabel: "任务标签",
      allKeys: PROJECT_PROGRESS_TASK_TAG_FILTER_KEYS,
      optionList: tagOptionList,
      selected: selectedTagSet,
      mode: "tags",
      persist: persistTags,
    });

    // 展示条数
    const limitWrap = toolRow.createDiv({ cls: "rslatte-project-progress-toolbar-item" });
    limitWrap.createSpan({ cls: "rslatte-muted", text: "显示：" });
    const limitSel = limitWrap.createEl("select", { cls: "rslatte-proj-gantt-select" });
    for (const n of limitOptions) limitSel.createEl("option", { text: String(n), attr: { value: String(n) } });
    limitSel.value = String(displayLimit);
    limitSel.onchange = () => {
      const n = Number(limitSel.value);
      pp.progressTaskListDisplayLimit = limitOptions.includes(n) ? n : 10;
      void this.plugin.saveSettings();
      this.refresh();
    };

    const bodyWrap = msWrap.createDiv({ cls: "rslatte-project-ms-section-body rslatte-project-progress-section-body" });
    if (!milestones.length) {
      bodyWrap.createDiv({ cls: "rslatte-project-empty", text: "（暂无里程碑）" });
    } else {
      this.renderMilestonesTree(bodyWrap, p, {
        statuses: new Set(statusOptions.map((o) => o.key).filter((k) => selectedStatusSet.has(k))),
        tagKeys: selectedTagSet.size > 0 ? selectedTagSet : undefined,
        limit: displayLimit,
      });
    }
  }

  /** 将当前项目下所有里程碑 path 加入展开集合（与 renderMilestoneNode 的 msKey 一致） */
  private expandAllMilestoneKeysForProject(p: ProjectEntry, projectKey: string) {
    if (!projectKey) return;
    const all = (p.milestones ?? []) as MilestoneProgress[];
    for (const m of all) {
      const path = String((m as any)?.path ?? (m as any)?.name ?? "").trim();
      if (!path) continue;
      this._expandedMilestones.add(`${projectKey}::${path}`);
    }
  }

  /**
   * 里程碑工具栏：下拉多选（状态 / 任务标签）。内含「全部勾选」「全部取消」。
   */
  private mountProgressTaskListMultiSelectDropdown(
    toolRow: HTMLElement,
    opts: {
      anchorLabel: string;
      allKeys: string[];
      optionList: Array<{ key: string; label: string }>;
      selected: Set<string>;
      mode: "status" | "tags";
      persist: () => void | Promise<void>;
    }
  ): void {
    const wrap = toolRow.createDiv({ cls: "rslatte-ms-filter-dd" });
    const btn = wrap.createEl("button", {
      type: "button",
      cls: "rslatte-ms-filter-dd-trigger",
    });
    const panel = wrap.createDiv({ cls: "rslatte-ms-filter-dd-panel" });
    panel.style.display = "none";

    const syncBtnText = () => {
      const n = opts.allKeys.filter((k) => opts.selected.has(k)).length;
      btn.setText(`${opts.anchorLabel}（${n}/${opts.allKeys.length}）▾`);
    };
    syncBtnText();

    const rebuild = () => {
      panel.empty();
      const actions = panel.createDiv({ cls: "rslatte-ms-filter-dd-bulk" });
      const allOn = actions.createEl("button", { type: "button", text: "全部勾选", cls: "rslatte-ms-filter-dd-bulk-btn" });
      const allOff = actions.createEl("button", { type: "button", text: "全部取消", cls: "rslatte-ms-filter-dd-bulk-btn" });
      allOn.onclick = (ev) => {
        ev.stopPropagation();
        for (const k of opts.allKeys) opts.selected.add(k);
        void Promise.resolve(opts.persist()).then(() => this.refresh());
      };
      allOff.onclick = (ev) => {
        ev.stopPropagation();
        if (opts.mode === "tags") {
          opts.selected.clear();
        } else {
          opts.selected.clear();
          opts.selected.add("TODO");
          opts.selected.add("IN_PROGRESS");
        }
        void Promise.resolve(opts.persist()).then(() => this.refresh());
      };

      for (const o of opts.optionList) {
        const lb = panel.createEl("label", { cls: "rslatte-ms-filter-dd-item" });
        const cb = lb.createEl("input");
        cb.type = "checkbox";
        cb.checked = opts.selected.has(o.key);
        cb.onchange = () => {
          if (cb.checked) opts.selected.add(o.key);
          else opts.selected.delete(o.key);
          if (opts.mode === "status" && opts.selected.size === 0) {
            opts.selected.add("TODO");
            opts.selected.add("IN_PROGRESS");
            opts.selected.add("DONE");
            opts.selected.add("CANCELLED");
          }
          void Promise.resolve(opts.persist()).then(() => this.refresh());
        };
        lb.createSpan({ text: " " + o.label });
      }
    };
    rebuild();

    let closer: ((e: MouseEvent) => void) | null = null;
    const close = () => {
      panel.style.display = "none";
      if (closer) {
        document.removeEventListener("click", closer, true);
        closer = null;
      }
    };

    btn.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const open = panel.style.display !== "none";
      if (open) {
        close();
        return;
      }
      syncBtnText();
      rebuild();
      panel.style.display = "block";
      closer = (e: MouseEvent) => {
        if (!wrap.contains(e.target as Node)) close();
      };
      window.setTimeout(() => document.addEventListener("click", closer!, true), 0);
    };

    panel.onclick = (ev) => ev.stopPropagation();
  }

  /**
   * 渲染已完成的项目卡片（完整版，显示里程碑和任务，包含恢复按钮）
   */
  private renderDoneProject(parent: HTMLElement, p: ProjectEntry) {
    const card = parent.createDiv({ cls: "rslatte-project-card" });
    // 添加标识属性，用于从其他视图跳转定位
    const projectId = String(p.projectId ?? "").trim();
    const folderPath = normalizePath(String(p.folderPath ?? "").trim());
    if (projectId) card.setAttribute("data-project-id", projectId);
    if (folderPath) card.setAttribute("data-project-folder-path", folderPath);
    // ===== Row 1: 项目名 + 同步灯 + 编辑按钮 | 右侧 status 文本 =====
    const headRow = card.createDiv({ cls: "rslatte-proj-headrow" });
    const nameWrap = headRow.createDiv({ cls: "rslatte-proj-namewrap" });

    const title = nameWrap.createEl("div", { cls: "rslatte-proj-title rslatte-project-title", text: p.projectName });
    title.title = "打开项目任务清单";
    title.onclick = () => {
      const af = this.app.vault.getAbstractFileByPath(p.tasklistFilePath);
      if (af instanceof TFile) void this.app.workspace.getLeaf(true).openFile(af);
    };

    this.maybeAppendProjectDbSyncIcon(nameWrap, p);

    headRow.createDiv({ cls: "rslatte-proj-status-text", text: this.projectHeadStatusText(p) });

    // 恢复/分析图/存档等操作在「项目进度管理」详情中提供。

    // meta row（风险标签同行首）
    const meta = card.createDiv({ cls: "rslatte-project-meta" });
    const parts: string[] = [];
    if (p.created_date) parts.push(`创建 ${p.created_date}`);
    if (p.planned_end) parts.push(`计划结束 ${p.planned_end}`);
    if (p.actual_start) parts.push(`开始 ${p.actual_start}`);
    if (p.done) parts.push(`完成 ${p.done}`);
    if (p.progress_updated) parts.push(`进展 ${p.progress_updated}`);
    this.fillProjectMetaWithRisk(meta, p, parts);

    this.renderProjectProgressNavRow(card, p);
  }

  /**
   * 渲染取消的项目卡片（简化版，不显示里程碑和任务）
   */
  private renderCancelledProject(parent: HTMLElement, p: ProjectEntry) {
    const card = parent.createDiv({ cls: "rslatte-project-card" });
    // 添加标识属性，用于从其他视图跳转定位
    const projectId = String(p.projectId ?? "").trim();
    const folderPath = normalizePath(String(p.folderPath ?? "").trim());
    if (projectId) card.setAttribute("data-project-id", projectId);
    if (folderPath) card.setAttribute("data-project-folder-path", folderPath);
    
    // ===== Row 1: 项目名 + 同步灯 + 编辑按钮 | 右侧 status 文本 =====
    const headRow = card.createDiv({ cls: "rslatte-proj-headrow" });
    const nameWrap = headRow.createDiv({ cls: "rslatte-proj-namewrap" });

    const title = nameWrap.createEl("div", { cls: "rslatte-proj-title rslatte-project-title", text: p.projectName });
    title.title = "打开项目任务清单";
    title.onclick = () => {
      const af = this.app.vault.getAbstractFileByPath(p.tasklistFilePath);
      if (af instanceof TFile) void this.app.workspace.getLeaf(true).openFile(af);
    };

    this.maybeAppendProjectDbSyncIcon(nameWrap, p);

    headRow.createDiv({ cls: "rslatte-proj-status-text", text: this.projectHeadStatusText(p) });

    // 恢复/分析图/存档等在「项目进度管理」详情中提供。

    // meta row（风险标签同行首）
    const meta = card.createDiv({ cls: "rslatte-project-meta" });
    const parts: string[] = [];
    if (p.created_date) parts.push(`创建 ${p.created_date}`);
    if (p.planned_end) parts.push(`计划结束 ${p.planned_end}`);
    if (p.actual_start) parts.push(`开始 ${p.actual_start}`);
    if (p.cancelled) parts.push(`取消 ${p.cancelled}`);
    if (p.progress_updated) parts.push(`进展 ${p.progress_updated}`);
    this.fillProjectMetaWithRisk(meta, p, parts);

    this.renderProjectProgressNavRow(card, p);
  }

  /** 待归档：保留完成日展示，并显示 pending_archive_at */
  private renderPendingArchiveProject(parent: HTMLElement, p: ProjectEntry) {
    const card = parent.createDiv({ cls: "rslatte-project-card" });
    const projectId = String(p.projectId ?? "").trim();
    const folderPath = normalizePath(String(p.folderPath ?? "").trim());
    if (projectId) card.setAttribute("data-project-id", projectId);
    if (folderPath) card.setAttribute("data-project-folder-path", folderPath);

    const headRow = card.createDiv({ cls: "rslatte-proj-headrow" });
    const nameWrap = headRow.createDiv({ cls: "rslatte-proj-namewrap" });
    const title = nameWrap.createEl("div", { cls: "rslatte-proj-title rslatte-project-title", text: p.projectName });
    title.title = "打开项目任务清单";
    title.onclick = () => {
      const af = this.app.vault.getAbstractFileByPath(p.tasklistFilePath);
      if (af instanceof TFile) void this.app.workspace.getLeaf(true).openFile(af);
    };
    this.maybeAppendProjectDbSyncIcon(nameWrap, p);
    headRow.createDiv({ cls: "rslatte-proj-status-text", text: this.projectHeadStatusText(p) });

    const meta = card.createDiv({ cls: "rslatte-project-meta" });
    const parts: string[] = [];
    if (p.done) parts.push(`完成 ${p.done}`);
    const pa = String((p as any).pending_archive_at ?? "").trim();
    if (pa) parts.push(`待归档标记 ${pa}`);
    if (p.planned_end) parts.push(`计划结束 ${p.planned_end}`);
    if (p.progress_updated) parts.push(`进展 ${p.progress_updated}`);
    this.fillProjectMetaWithRisk(meta, p, parts);
    this.renderProjectProgressNavRow(card, p);
  }

  private renderProjectTasklistToggle(card: HTMLElement, p: ProjectEntry) {
    const key = String(p.projectId ?? p.folderPath ?? "").trim();
    if (!key) return;

    const items = (p.taskItems ?? []) as ProjectTaskItem[];
    const openCount = items.filter((it) => it.statusName === "TODO" || it.statusName === "IN_PROGRESS").length;
    const totalCount = items.length;

    const row = card.createDiv({ cls: "rslatte-milestone-row rslatte-project-tasklist-row" });
    const isOpen = this._expandedProjectTasklists.has(key);

    // Toggle button placed INSIDE the title area, so it visually sticks to the milestone title.
    const title = row.createDiv({ cls: "rslatte-milestone-title rslatte-milestone-title-clickable" });
    // allow clicking the title area to toggle
    title.onclick = (ev) => {
      ev.stopPropagation();
      if (this._expandedProjectTasklists.has(key)) {
        this._expandedProjectTasklists.delete(key);
        // 关闭项目任务清单时，同步清空该项目下所有里程碑的展开状态，确保再次展开时“默认收起”。
        const prefix = `${key}::`;
        for (const k of Array.from(this._expandedMilestones)) {
          if (k.startsWith(prefix)) this._expandedMilestones.delete(k);
        }
      } else {
        this._expandedProjectTasklists.add(key);
      }
      this.refresh();
    };
    const togg = title.createEl("button", {
      text: isOpen ? "▼" : "▶",
      cls: "rslatte-icon-only-btn rslatte-milestone-toggle",
    });
    togg.title = isOpen ? "收起任务清单" : "展开任务清单";
    togg.onclick = (ev) => {
      ev.stopPropagation();
      title.click();
    };

    title.createSpan({ text: "任务清单", cls: "rslatte-milestone-title-text" });

    const badge = row.createDiv({ cls: "rslatte-milestone-badge" });
    badge.setText(`${openCount} 未闭环 · 共 ${totalCount} 条`);

    if (!isOpen) return;

    const wrap = card.createDiv({ cls: "rslatte-task-list" });
    if (!items.length) {
      wrap.createDiv({ cls: "rslatte-task-empty", text: "（暂无项目任务）" });
      return;
    }

    // build milestone list (level-1 milestones only in step4-2a)
    const milestones: Array<{
      key: string;
      milestoneName: string;
      done: number;
      total: number;
      openTasks: ProjectTaskItem[];
    }> = [];

    for (const m of (p.milestones ?? [])) {
      const name = String((m as any).name ?? "").trim();
      if (!name) continue;
      const mPath = String((m as any).path ?? name).trim();
      const msKey = `${key}::${mPath}`;
      const openTasks = items.filter((it) => {
        const tp = String((it as any).milestonePath ?? it.milestone ?? "").trim();
        return tp === mPath && (it.statusName === "TODO" || it.statusName === "IN_PROGRESS");
      });
      milestones.push({
        key: msKey,
        milestoneName: name,
        done: Number((m as any).done ?? 0),
        total: Number((m as any).total ?? 0),
        openTasks,
      });
    }

    if (!milestones.length) {
      wrap.createDiv({ cls: "rslatte-task-empty", text: "（未解析到里程碑：请在项目任务清单中用 # 里程碑标题）" });
      return;
    }

    for (const ms of milestones) {
      const msRow = wrap.createDiv({ cls: "rslatte-milestone-row" });
      const msOpen = this._expandedMilestones.has(ms.key);

      const msTitle = msRow.createDiv({ cls: "rslatte-milestone-title" });
      // 允许点击标题区域也切换展开/收起（提升可用性）
      msTitle.onclick = (ev) => {
        ev.stopPropagation();
        if (this._expandedMilestones.has(ms.key)) this._expandedMilestones.delete(ms.key);
        else this._expandedMilestones.add(ms.key);
        this.refresh();
      };
      const msTog = msTitle.createEl("button", {
        text: msOpen ? "▼" : "▶",
        cls: "rslatte-icon-only-btn rslatte-milestone-toggle",
      });
      msTog.title = msOpen ? "收起" : "展开";
      msTog.onclick = (ev) => {
        ev.stopPropagation();
        if (this._expandedMilestones.has(ms.key)) this._expandedMilestones.delete(ms.key);
        else this._expandedMilestones.add(ms.key);
        this.refresh();
      };

      msTitle.createSpan({ text: ms.milestoneName, cls: "rslatte-milestone-title-text" });

      const msBadge = msRow.createDiv({ cls: "rslatte-milestone-badge" });
      msBadge.setText(`${ms.openTasks.length} 未闭环 · ${ms.done}/${ms.total}`);

      if (!msOpen) continue;
      const taskWrap = wrap.createDiv({ cls: "rslatte-milestone-tasks" });
      if (!ms.openTasks.length) {
        taskWrap.createDiv({ cls: "rslatte-task-empty", text: "（该里程碑下无未闭环任务）" });
        continue;
      }
      const tl = taskWrap.createDiv({ cls: "rslatte-timeline" });
      for (const it of ms.openTasks.slice(0, 30)) {
        this.renderProjectTaskTimelineItem(tl, p, it);
      }
      if (ms.openTasks.length > 30) {
        taskWrap.createDiv({ cls: "rslatte-task-empty", text: `（仅显示前 30 条，当前未闭环 ${ms.openTasks.length} 条）` });
      }
    }
  }

  private renderProjectTaskTimelineItem(parent: HTMLElement, p: ProjectEntry, it: ProjectTaskItem) {
    // 与任务管理侧栏任务条格式一致：状态点、描述（含首字符标记）、meta 同 buildTimelineMeta 风格，操作按钮同任务清单；不显示 rslatte-timeline-from。
    const row = parent.createDiv({ cls: "rslatte-timeline-item rslatte-project-task-item" });
    row.tabIndex = 0;
    const taskFilePath = normalizePath(String(it.sourceFilePath ?? p.tasklistFilePath ?? "").trim());
    const taskLineNo = Number(it.lineNo ?? -1);
    if (taskFilePath) row.setAttribute("data-project-task-file-path", taskFilePath);
    if (taskLineNo >= 0) row.setAttribute("data-project-task-line-no", String(taskLineNo));

    const gutter = row.createDiv({ cls: "rslatte-timeline-gutter" });
    const dot = gutter.createDiv({ cls: "rslatte-timeline-dot" });
    dot.setText(this.projectTaskStatusIcon(it));
    dot.title = this.projectTaskStatusDisplayName(it);
    gutter.createDiv({ cls: "rslatte-timeline-line" });

    const content = row.createDiv({ cls: "rslatte-timeline-content" });
    const titleRow = content.createDiv({ cls: "rslatte-timeline-title-row rslatte-task-row" });
    const titleEl = titleRow.createDiv({ cls: "rslatte-timeline-text rslatte-task-title" });
    const displayText = buildDescPrefix({
      starred: !!(it as any).starred,
      postpone_count: (it as any).postpone_count ?? 0,
      complexity: (it as any).complexity,
    }) + String(it.text ?? "(项目任务)").trim();
    renderTextWithContactRefs(this.app, titleEl, displayText);

    const actions = titleRow.createDiv({ cls: "rslatte-task-actions rslatte-task-actions-compact" });

    const tasklistPath = (p as any)?.tasklistFilePath ?? (p as any)?.tasklist_file_path ?? normalizePath(`${String(p?.folderPath ?? "")}/项目任务清单.md`);
    const refreshAfter = async () => {
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

    const cardActions: ProjectCardAction[] = [
      {
        id: "project_task_edit",
        icon: "✏️",
        title: "修改任务信息",
        run: () => {
          new EditProjectTaskModal(this.app, this.plugin, String(p.folderPath ?? ""), it).open();
        },
      },
    ];

    for (const btn of this.projectTaskActionButtons(it)) {
      if (btn.icon === "▶") {
        cardActions.push({
          id: "project_task_start",
          icon: "▶",
          title: btn.title,
          run: () => {
            new ProjectTaskProgressModal(this.app, this.plugin, String(p.folderPath ?? ""), it, "start", refreshAfter).open();
          },
        });
      } else if (btn.icon === "↻") {
        cardActions.push({
          id: "project_task_wait_others",
          icon: "↻",
          title: btn.title,
          run: () => {
            new ProjectTaskProgressModal(this.app, this.plugin, String(p.folderPath ?? ""), it, "waiting_others", refreshAfter).open();
          },
        });
      } else if (btn.icon === "⏸") {
        if (btn.mode === "pause") {
          cardActions.push({
            id: "project_task_pause",
            icon: "⏸",
            title: btn.title,
            run: () => {
              void this.plugin.projectMgr.setProjectTaskStatus(String(p.folderPath ?? ""), { taskId: it.taskId, lineNo: it.lineNo }, "TODO");
              void refreshAfter();
            },
          });
        } else {
          cardActions.push({
            id: "project_task_wait_until",
            icon: "⏸",
            title: btn.title,
            run: () => {
              new ProjectTaskProgressModal(this.app, this.plugin, String(p.folderPath ?? ""), it, "waiting_until", refreshAfter).open();
            },
          });
        }
      } else if (btn.icon === "⛔") {
        cardActions.push({
          id: "project_task_cancel",
          icon: "⛔",
          title: btn.title,
          run: () => {
            void this.plugin.projectMgr.setProjectTaskStatus(String(p.folderPath ?? ""), { taskId: it.taskId, lineNo: it.lineNo }, "CANCELLED");
            void refreshAfter();
          },
        });
      } else if (btn.icon === "✅") {
        cardActions.push({
          id: "project_task_done",
          icon: "✅",
          title: btn.title,
          run: () => {
            new ProjectTaskProgressModal(this.app, this.plugin, String(p.folderPath ?? ""), it, "done", refreshAfter).open();
          },
        });
      } else if (btn.icon === "↪") {
        cardActions.push({
          id: "project_task_postpone",
          icon: "↪",
          title: btn.title,
          run: () => {
            new ProjectTaskProgressModal(this.app, this.plugin, String(p.folderPath ?? ""), it, "postpone", refreshAfter).open();
          },
        });
      } else if (btn.icon === "⭐") {
        cardActions.push({
          id: "project_task_star",
          icon: "⭐",
          title: btn.title,
          run: () => {
            void this.plugin.projectMgr.setProjectTaskStarred(String(p.folderPath ?? ""), { taskId: it.taskId, lineNo: it.lineNo }, it, true);
            void refreshAfter();
          },
        });
      } else if (btn.icon === "☆") {
        cardActions.push({
          id: "project_task_star",
          icon: "☆",
          title: btn.title,
          run: () => {
            void this.plugin.projectMgr.setProjectTaskStarred(String(p.folderPath ?? ""), { taskId: it.taskId, lineNo: it.lineNo }, it, false);
            void refreshAfter();
          },
        });
      } else if (btn.icon === "📅") {
        cardActions.push({
          id: "project_task_record_schedule",
          icon: "📅",
          title: btn.title,
          run: async () => {
            new AddScheduleModal(this.app, this.plugin, {
              initialDesc: String(it.text ?? "").trim() || "项目任务执行",
              initialLinkedTaskUid: String(it.taskId ?? "").trim() || undefined,
              modalTitle: "录日程（关联项目任务）",
              onCreated: async ({ uid }) => {
                await this.plugin.projectMgr.appendLinkedScheduleUidToProjectTask(
                  String(p.folderPath ?? ""),
                  { taskId: String(it.taskId ?? "").trim() || undefined, lineNo: Number(it.lineNo ?? -1) },
                  String(uid ?? "")
                );
                await refreshAfter();
              },
            }).open();
          },
        });
      }
    }
    this.mountProjectCardActions(
      actions,
      cardActions,
      this.getProjectTaskCardMoreIds()
    );

    const taskPanel = this.plugin.settings?.taskPanel ?? undefined;
    const today = getTaskTodayKey(taskPanel);
    const taskTags = getProjectTaskTagsOrCompute(it, today, taskPanel);
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

    this.renderProjectTaskFollowRow(content, it);
    this.renderProjectTaskLinkedScheduleRows(content, it);

    const meta = content.createDiv({ cls: "rslatte-timeline-meta rslatte-task-meta" });
    meta.setText(this.buildProjectTaskTimelineMeta(it));
    this.attachProjectTaskMetaTooltip(meta, this.buildProjectTaskTimelineMetaTooltip(it));
    // 项目任务不显示 rslatte-timeline-from（任务清单中为来源文件路径）

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

  private renderProjectTaskFollowRow(content: HTMLElement, it: ProjectTaskItem): void {
    const info = this.buildProjectTaskFollowRowInfo(it);
    if (!info) return;
    const followRow = content.createDiv({ cls: "rslatte-task-follow-row" });
    const phrasePrefix = info.phase === "waiting_until" ? "等待" : "跟进";
    followRow.createSpan({ cls: "rslatte-task-follow-label", text: phrasePrefix });
    const contactsEl = followRow.createSpan({ cls: "rslatte-task-follow-contacts" });
    renderTextWithContactRefs(this.app, contactsEl, info.contactsText);
    followRow.createSpan({ cls: "rslatte-task-follow-status", text: "处理中" });
    followRow.createSpan({ cls: "rslatte-task-follow-date", text: ` · ${info.dateLabel}：${info.dateValue}` });
    //if (info.progressNoteSnippet) {
      //const noteEl = followRow.createSpan({ cls: "rslatte-task-follow-note", text: ` · ${info.progressNoteSnippet}` });
      //noteEl.setAttr("title", info.progressNoteSnippet);
    //}
  }

  private buildProjectTaskFollowRowInfo(
    it: ProjectTaskItem
  ): {
    contactsText: string;
    dateLabel: string;
    dateValue: string;
    phase: "waiting_until" | "waiting_others";
    progressNoteSnippet?: string;
  } | null {
    const phaseRaw = String((it as any).task_phase ?? (it as any).taskPhase ?? "").trim().toLowerCase();
    const phaseNorm = phaseRaw.replace(/[\s-]+/g, "_");
    const phase = phaseNorm.startsWith("waiting_oth")
      ? "waiting_others"
      : phaseNorm.startsWith("waiting_unti") || phaseNorm === "waiting_until"
        ? "waiting_until"
        : "";
    if (!phase) return null;
    const followRaw = (it as any).follow_contact_uids ?? (it as any).followContactUids;
    const followUids = Array.isArray(followRaw)
      ? followRaw.map((x: any) => String(x ?? "").trim()).filter(Boolean)
      : String(followRaw ?? "").split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
    const ymdPrefix = (v: unknown): string => {
      const m = String(v ?? "").trim().match(/^(\d{4}-\d{2}-\d{2})/);
      return m ? m[1] : "";
    };
    const waitUntil = ymdPrefix((it as any).wait_until ?? (it as any).waitUntil);
    const followUp = ymdPrefix((it as any).follow_up ?? (it as any).followUp);
    let dateValue = phase === "waiting_others" ? (followUp || waitUntil) : (waitUntil || followUp);
    if (!dateValue) dateValue = "—";

    const progressRaw = String((it as any).progress_note ?? "")
      .replace(/\u200B/g, " ")
      .trim();
    let progressNoteSnippet: string | undefined;
    if (progressRaw) {
      progressNoteSnippet = progressRaw.length > 100 ? `${progressRaw.slice(0, 100)}…` : progressRaw;
    }

    const nameList: string[] = Array.isArray((it as any).follow_contact_names)
      ? ((it as any).follow_contact_names as string[]).map((x) => String(x ?? "").trim())
      : Array.isArray((it as any).followContactNames)
        ? ((it as any).followContactNames as string[]).map((x) => String(x ?? "").trim())
        : [];
    const contactsText = followUids.length > 0
      ? followUids.map((uid: string, idx: number) => {
          const rawUid = String(uid ?? "").trim();
          const contactUid = rawUid.startsWith("C_") ? rawUid.slice(2) : rawUid;
          const metaName = String(nameList[idx] ?? "").trim();
          const alias = metaName && metaName !== contactUid ? metaName : contactUid;
          return `[[C_${contactUid}|${alias}]]`;
        }).join("、")
      : "（未关联联系人）";
    const dateLabel = phase === "waiting_others" ? "下次跟进时间" : "等待到期日";

    const hasAny =
      followUids.length > 0 || progressRaw.length > 0 || dateValue !== "—";
    if (!hasAny) return null;

    return { contactsText, dateLabel, dateValue, phase, progressNoteSnippet };
  }

  private renderProjectTaskLinkedScheduleRows(content: HTMLElement, it: ProjectTaskItem): void {
    const linked = Array.isArray((it as any).linked_schedule_uids)
      ? ((it as any).linked_schedule_uids as string[]).map((x) => String(x ?? "").trim()).filter(Boolean)
      : [];
    if (!linked.length) return;
    for (const uid of linked.slice(0, 5)) {
      const row = content.createDiv({ cls: "rslatte-task-linked-schedule-row" });
      row.setText("加载中…");
      row.setAttr("title", "点击定位到任务管理侧边栏对应日程");
      row.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        void this.focusScheduleInTaskPanelByUid(uid);
      });
      row.addEventListener("keydown", (ev) => {
        if ((ev as KeyboardEvent).key === "Enter") {
          ev.preventDefault();
          ev.stopPropagation();
          void this.focusScheduleInTaskPanelByUid(uid);
        }
      });
      row.tabIndex = 0;
      row.setAttr("role", "button");
      void this.hydrateProjectTaskLinkedScheduleRow(uid, row);
    }
  }

  private async hydrateProjectTaskLinkedScheduleRow(scheduleUid: string, row: HTMLElement): Promise<void> {
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
      const date = String((it as any).memoDate ?? "").trim();
      const parts: string[] = [];
      if (timeRange) parts.push(timeRange);
      if (desc) parts.push(desc);
      if (date) parts.push(date);
      row.setText(parts.join(" · ") || "（日程）");
      row.setAttr("title", `点击定位到任务管理侧边栏对应日程\n${parts.join(" · ")}`);
    } catch {
      row.setText("（日程加载失败）");
      row.addClass("rslatte-task-linked-schedule-row--missing");
    }
  }

  private async focusScheduleInTaskPanelByUid(scheduleUid: string): Promise<void> {
    try {
      const it = await this.plugin.taskRSLatte.findScheduleByUid(scheduleUid);
      if (!it) {
        new Notice("未找到对应日程（可先刷新日程索引）");
        return;
      }
      await this.plugin.activateTaskView();
      const ws: any = this.app.workspace as any;
      const leaf = ws.getLeavesOfType?.(VIEW_TYPE_TASKS)?.[0];
      const view: any = leaf?.view;
      if (view && typeof view.focusScheduleByFileLine === "function") {
        await view.focusScheduleByFileLine(it.filePath, it.lineNo);
        return;
      }
      await this.openTaskInFile(it.filePath, it.lineNo);
    } catch (e: any) {
      new Notice(`定位日程失败：${e?.message ?? String(e)}`);
    }
  }

  /** 与任务清单一致：未开始☐、处理中▶、跟进中↻、等待中⏸、已完成✅、已取消⛔ */
  private projectTaskStatusIcon(it: ProjectTaskItem): string {
    const statusName = it.statusName;
    if (statusName === "DONE") return "✅";
    if (statusName === "CANCELLED") return "⛔";
    if (statusName === "TODO") return "☐";
    if (statusName === "IN_PROGRESS") {
      const phase = (it as any).task_phase;
      if (phase === "waiting_others") return "↻";
      if (phase === "waiting_until") return "⏸";
      return "▶";
    }
    return "⬛";
  }

  private projectTaskStatusDisplayName(it: ProjectTaskItem): string {
    const statusName = it.statusName;
    if (statusName === "DONE") return "已完成";
    if (statusName === "CANCELLED") return "已取消";
    if (statusName === "TODO") return "未开始";
    if (statusName === "IN_PROGRESS") {
      const phase = (it as any).task_phase;
      if (phase === "waiting_others") return "跟进中";
      if (phase === "waiting_until") return "等待中";
      return "处理中";
    }
    return "未知";
  }

  /**
   * 项目任务操作按钮（与任务管理 TaskSidePanelView.taskActionButtons 显隐一致）：
   * - 未开始: ▶ ⛔ ↪ ⭐/☆（不展示 ↻ / ⏸）
   * - 处理中: ↻ ⏸ 进入等待 ⛔ ✅ ↪ ⭐/☆（不显示「开始处理任务」）
   * - 跟进中: ▶ ⏸ 进入等待 ⛔ ✅ ↪ ⭐/☆（不显示 ↻）
   * - 等待中: ▶ ↻ ⛔ ✅ ↪ ⭐/☆（不显示 ⏸）
   * - 已完成/已取消: 仅 ▶
   */
  private projectTaskActionButtons(it: ProjectTaskItem): Array<{ icon: string; title: string; mode?: "pause" }> {
    const status = String(it.statusName ?? "").trim().toUpperCase();
    const phase = (it as any).task_phase;
    const starred = !!(it as any).starred;

    if (status === "DONE" || status === "CANCELLED") {
      return [{ icon: "▶", title: "开始处理任务" }];
    }
    const list: Array<{ icon: string; title: string; mode?: "pause" }> = [];
    const isInProgressPhase = status === "IN_PROGRESS" && (phase === "in_progress" || !phase);
    if (!isInProgressPhase) {
      list.push({ icon: "▶", title: "开始处理任务" });
    }
    if (status === "IN_PROGRESS") {
      if (phase !== "waiting_others") list.push({ icon: "↻", title: "等待他人处理" });
      if (phase !== "waiting_until") list.push({ icon: "⏸", title: "进入等待状态" });
    }
    list.push({ icon: "⛔", title: "标记为已取消" });
    if (status === "IN_PROGRESS") list.push({ icon: "✅", title: "完成任务" });
    if (status === "IN_PROGRESS") list.push({ icon: "📅", title: "录日程" });
    list.push({ icon: "↪", title: "延期" });
    list.push(starred ? { icon: "☆", title: "取消星标" } : { icon: "⭐", title: "星标" });
    return list;
  }

  /** 与任务清单 buildTimelineMeta 同格式：⏱️ / 🆕 / ⏱ / ▶ / 📅 / ⏸ / ↪(延期) / ✅ / ⛔ */
  private buildProjectTaskTimelineMeta(it: ProjectTaskItem): string {
    const parts: string[] = [];
    const estimate_h = (it as any).estimate_h;
    if (estimate_h != null && Number(estimate_h) > 0) parts.push(`⏱️${Math.round(Number(estimate_h))}`);
    const created_date = (it as any).created_date;
    const planned_end = (it as any).planned_end;
    const actual_start = (it as any).actual_start;
    const planned_start = (it as any).planned_start;
    const done_date = (it as any).done_date;
    const cancelled_date = (it as any).cancelled_date;
    const wait_until = (it as any).wait_until;
    const postpone_count = (it as any).postpone_count;
    const original_due = (it as any).original_due;
    if (created_date) parts.push(`🆕${created_date}`);
    if (planned_start) parts.push(`⏱${planned_start}`);
    if (actual_start) parts.push(`▶${actual_start}`);
    if (planned_end) parts.push(`📅${planned_end}`);
    if ((it as any).task_phase === "waiting_until" && wait_until && /^\d{4}-\d{2}-\d{2}$/.test(String(wait_until))) parts.push(`⏸${wait_until}`);
    if (postpone_count != null && Number(postpone_count) > 0) {
      const orig = original_due && /^\d{4}-\d{2}-\d{2}$/.test(String(original_due)) ? `📌${original_due}` : "";
      parts.push(`↪${postpone_count}${orig}`);
    }
    if (it.statusName === "DONE" && done_date) parts.push(`✅${done_date}`);
    if (it.statusName === "CANCELLED" && cancelled_date) parts.push(`⛔${cancelled_date}`);
    return parts.join(" / ");
  }

  /** 与 buildProjectTaskTimelineMeta 一一对应的中文说明（悬停 title，与任务管理侧栏一致） */
  private buildProjectTaskTimelineMetaTooltip(it: ProjectTaskItem): string {
    const lines: string[] = [];
    const estimate_h = (it as any).estimate_h;
    if (estimate_h != null && Number(estimate_h) > 0) {
      lines.push(`工时评估：约 ${Math.round(Number(estimate_h))} 小时`);
    }
    if ((it as any).created_date) lines.push(`创建日：${(it as any).created_date}`);
    if ((it as any).planned_start) lines.push(`计划开始日：${(it as any).planned_start}`);
    if ((it as any).actual_start) lines.push(`实际开始日：${(it as any).actual_start}`);
    if ((it as any).planned_end) lines.push(`计划结束日：${(it as any).planned_end}`);
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
    if (it.statusName === "DONE" && (it as any).done_date) lines.push(`实际完成日：${(it as any).done_date}`);
    if (it.statusName === "CANCELLED" && (it as any).cancelled_date) lines.push(`实际取消日：${(it as any).cancelled_date}`);
    if (lines.length === 0) return "当前项目任务暂无日期类信息";
    return lines.join("\n");
  }

  private attachProjectTaskMetaTooltip(meta: HTMLElement, tip: string): void {
    meta.addClass("rslatte-timeline-meta--with-tip");
    meta.setAttr("title", tip);
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

  /** 返回项目的一级里程碑 roots 与任务所属里程碑路径解析函数，供推进区与里程碑树共用 */
  private getProjectRootsAndPathResolver(p: ProjectEntry): {
    roots: MilestoneProgress[];
    effectivePathForTask: (it: ProjectTaskItem) => string;
    childrenMap: Map<string, MilestoneProgress[]>;
    msIndex: Map<string, { status?: "active" | "done" | "cancelled"; parentPath?: string }>;
  } {
    return getProjectMilestoneRootsAndResolver(p);
  }

  private renderMilestonesTree(
    parent: HTMLElement,
    p: ProjectEntry,
    opts?: { statuses?: Set<string>; tagKeys?: Set<string>; limit?: number }
  ) {
    const { roots, effectivePathForTask, childrenMap, msIndex } = this.getProjectRootsAndPathResolver(p);
    if (!roots.length) {
      parent.createDiv({ cls: "rslatte-project-empty", text: "（暂无里程碑）" });
      return;
    }
    for (const r of roots) {
      this.renderMilestoneNode(parent, p, r, childrenMap, msIndex, effectivePathForTask, opts);
    }
  }

  /** Render one milestone node (row + expanded area), and recursively render its child milestones. */
  private renderMilestoneNode(
    parent: HTMLElement,
    p: ProjectEntry,
    m: MilestoneProgress,
    childrenMap: Map<string, MilestoneProgress[]>,
    _msIndex: Map<string, any>,
    effectivePathForTask: (it: ProjectTaskItem) => string,
    opts?: { statuses?: Set<string>; tagKeys?: Set<string>; limit?: number }
  ) {

    const projectKey = String((p as any).projectId ?? p.folderPath ?? "").trim();
    const milestoneName = String((m as any).name ?? "").trim();
    const milestonePath = String((m as any).path ?? milestoneName).trim();
    const level = Math.max(1, Math.min(3, Number((m as any).level ?? 1) || 1));
    const msStatus = (() => {
      const s = String((m as any).milestoneStatus ?? "active").trim().toLowerCase();
      if (s === "done") return "done" as const;
      if (s === "cancelled" || s === "canceled") return "cancelled" as const;
      return "active" as const;
    })();

    const msKey = `${projectKey}::${milestonePath}`;
    const isOpen = this._expandedMilestones.has(msKey);

    // Progress counts include the whole subtree: this milestone + all child milestones' tasks.
    const allTasks = ((p as any).taskItems ?? []) as ProjectTaskItem[];
    const prefix = milestonePath ? `${milestonePath} / ` : "";
    const subtreeTasks = allTasks.filter((it) => {
      const ep = effectivePathForTask(it);
      if (!ep || !milestonePath) return false;
      const pfx = milestonePath ? `${milestonePath} / ` : "";
      return ep === milestonePath || ep.startsWith(pfx);
    });
    const subtreeCounts = subtreeTasks.reduce(
      (acc, it) => {
        const st = String((it as any).statusName ?? "").trim();
        if (st === "DONE") acc.done += 1;
        else if (st === "IN_PROGRESS") acc.inprogress += 1;
        else if (st === "CANCELLED") acc.cancelled += 1;
        else acc.todo += 1;
        acc.total += 1;
        return acc;
      },
      { total: 0, done: 0, todo: 0, inprogress: 0, cancelled: 0 }
    );

    const node = parent.createDiv({ cls: `rslatte-project-ms-node rslatte-project-ms-level-${level}` });
    const row = node.createDiv({ cls: "rslatte-project-ms-row rslatte-ms-row" });
    row.classList.toggle("rslatte-ms-status-done", msStatus === "done");
    row.classList.toggle("rslatte-ms-status-cancelled", msStatus === "cancelled");
    if (
      this._milestoneNavFlashMsKey &&
      Date.now() < this._milestoneNavFlashUntil &&
      msKey === this._milestoneNavFlashMsKey
    ) {
      row.addClass("rslatte-project-ms-row--nav-flash");
    }

    // left: toggle + milestone name
    const nameWrap = row.createDiv({ cls: "rslatte-project-ms-name" });
    // 点击标题区域切换展开/收起（不影响右侧按钮/进度条点击）
    nameWrap.onclick = (ev) => {
      ev.stopPropagation();
      if (this._expandedMilestones.has(msKey)) this._expandedMilestones.delete(msKey);
      else this._expandedMilestones.add(msKey);
      this.refresh();
    };
    const togg = nameWrap.createEl("button", {
      text: isOpen ? "▼" : "▶",
      cls: "rslatte-icon-only-btn rslatte-ms-toggle",
    });
    togg.title = isOpen ? "收起" : "展开";
    togg.onclick = (ev) => {
      ev.stopPropagation();
      nameWrap.click();
    };
    const nameText = nameWrap.createSpan({ cls: "rslatte-project-ms-name-text", text: milestoneName });
    // Hover shows the full path (一级 / 二级 / 三级)
    nameText.title = milestonePath;
    if (msStatus === "done") nameWrap.createSpan({ cls: "rslatte-ms-status-badge", text: "✅" });
    else if (msStatus === "cancelled") nameWrap.createSpan({ cls: "rslatte-ms-status-badge", text: "⛔" });

    // right side: milestone actions (right aligned) + fixed-width progress
    const right = row.createDiv({ cls: "rslatte-ms-right" });

    const actions = right.createDiv({ cls: "rslatte-ms-actions" });
    const msActions: ProjectCardAction[] = [
      {
        id: "milestone_edit",
        icon: "✏️",
        title: "修改里程碑",
        run: () => {
          new EditProjectMilestoneModal(this.app, this.plugin, p.folderPath, milestonePath).open();
        },
      },
    ];
    if (msStatus === "active") {
      msActions.push(
        {
          id: "milestone_done",
          icon: "✅",
          title: "标记里程碑完成",
          run: async () => {
            await this.plugin.projectMgr.setMilestoneStatus(p.folderPath, milestonePath, "done");
          },
        },
        {
          id: "milestone_cancel",
          icon: "⛔",
          title: "取消里程碑",
          run: async () => {
            await this.plugin.projectMgr.setMilestoneStatus(p.folderPath, milestonePath, "cancelled");
          },
        },
        ...(level === 1
          ? ([
              {
                id: "milestone_postpone",
                icon: "↪",
                title: "里程碑延期",
                run: () => {
                  new PostponeModal(this.app, "里程碑延期", async (days, reason) => {
                    await this.plugin.projectMgr.postponeMilestone(p.folderPath, milestonePath, days, reason);
                    new Notice("已延期");
                    this.refresh();
                  }).open();
                },
              },
            ] as ProjectCardAction[])
          : []),
      );
    } else {
      msActions.push({
        id: "milestone_restore",
        icon: "⏸",
        title: "恢复里程碑",
        run: async () => {
          await this.plugin.projectMgr.setMilestoneStatus(p.folderPath, milestonePath, "active");
        },
      });
    }
    msActions.push({
      id: "milestone_add",
      icon: "➕",
      title: "在该里程碑下新增任务或子里程碑",
      run: () => {
        new AddProjectTaskModal(this.app, this.plugin, p.folderPath, milestonePath, level, milestonePath).open();
      },
    });
    this.mountProjectCardActions(actions, msActions, this.getProjectMilestoneCardMoreIds());

    const prog = right.createDiv({ cls: "rslatte-project-progress" });
    prog.title = `进度（含子里程碑任务）：DONE ${subtreeCounts.done} / TODO ${subtreeCounts.todo} / IN_PROGRESS ${subtreeCounts.inprogress} / CANCELLED ${subtreeCounts.cancelled} · 共 ${subtreeCounts.total}`;
    prog.onclick = (ev) => {
      ev.stopPropagation();
      const ln = Number((m as any).headingLineNo ?? -1);
      if (Number.isFinite(ln) && ln >= 0) void this.openTaskInFile(p.tasklistFilePath, ln);
      else void this.plugin.openNoteAtHeading(p.tasklistFilePath, `${"#".repeat(level)} ${milestoneName}`);
    };

    const total = Math.max(0, subtreeCounts.total || 0);
    const bar = prog.createDiv({ cls: "rslatte-project-progress-bar" });

    const seg = (cls: string, n: number, labelText: string) => {
      const d = bar.createDiv({ cls: cls + " rslatte-project-progress-seg" });
      d.style.flexGrow = String(Math.max(0, n));
      d.style.flexBasis = "0";
      if (labelText) d.createDiv({ cls: "rslatte-project-progress-seg-label", text: labelText });
      return d;
    };

    // Show numeric labels inside segments (compact). Width is handled by CSS.
    const label = (n: number) => (n > 0 ? String(n) : "");
    seg("rslatte-project-progress-done", subtreeCounts.done, label(subtreeCounts.done));
    seg("rslatte-project-progress-todo", subtreeCounts.todo, label(subtreeCounts.todo));
    seg(
      "rslatte-project-progress-inprogress",
      subtreeCounts.inprogress,
      label(subtreeCounts.inprogress)
    );
    seg(
      "rslatte-project-progress-cancelled",
      subtreeCounts.cancelled,
      label(subtreeCounts.cancelled)
    );

    // 第三节：里程碑两行（状态+时间；标签行：超期/延期 + 子树任务标签汇总）
    const taskPanel = this.plugin.settings?.taskPanel;
    const today = getTaskTodayKey(taskPanel);
    const pp: any = (this.plugin.settings as any).projectPanel ?? {};
    const milestoneSoonDays = Math.max(0, Math.min(30, Number(pp.progressMilestoneUpcomingDays ?? 3) || 3));

    const toYmdPrefix = (s?: unknown): string | null => {
      if (!s) return null;
      const m = String(s).trim().match(/^(\d{4}-\d{2}-\d{2})/);
      return m ? m[1] : null;
    };
    const ymdToMs = (ymd: string): number => {
      const [y, m, d] = ymd.split("-").map((x) => Number(x));
      return Date.UTC(y, m - 1, d);
    };
    const todayMs = ymdToMs(today);

    const msStatusText = msStatus === "active" ? "进行中" : msStatus === "done" ? "已完成" : "已取消";
    const startText = (m as any).created_date ?? "—";
    const isL1Ms = level === 1;
    const plannedEndYmd = isL1Ms ? toYmdPrefix((m as any).planned_end) : null;
    const plannedEndText = isL1Ms ? ((m as any).planned_end ?? "—") : "—";

    const metaLine = node.createDiv({ cls: "rslatte-project-ms-meta-line" });
    metaLine.createSpan({ text: `状态：${msStatusText}` });
    metaLine.createSpan({ text: `开始：${startText}` });
    metaLine.createSpan({ text: `计划完成：${plannedEndText}` });

    const tagRow = node.createDiv({ cls: "rslatte-task-tags-row rslatte-project-ms-tags-line" });

    const plannedEndMs = plannedEndYmd ? ymdToMs(plannedEndYmd) : null;
    const daysUntilDue = plannedEndMs == null ? null : Math.floor((plannedEndMs - todayMs) / 86400000);
    const postponeCount = Math.max(0, Number((m as any).postpone_count ?? 0) || 0);
    const mTags = ((m as any).milestone_tags ?? []) as string[];
    const derivedChips = mTags.length > 0;

    // 一级里程碑：超期 / 即将超期 / 延期 优先读快照衍生 milestone_tags
    if (msStatus === "active" && isL1Ms) {
      if (derivedChips) {
        if (mTags.includes("milestone_overdue")) {
          const chip = tagRow.createSpan({ cls: "rslatte-task-tag rslatte-task-tag--red", text: "超期" });
          chip.setAttr("title", plannedEndYmd ? `里程碑计划完成日：${plannedEndYmd}` : "里程碑已超期");
        } else if (mTags.includes("milestone_soon_overdue")) {
          const chip = tagRow.createSpan({ cls: "rslatte-task-tag rslatte-task-tag--orange", text: "即将超期" });
          chip.setAttr(
            "title",
            plannedEndYmd
              ? `里程碑计划完成日：${plannedEndYmd}（${milestoneSoonDays} 天内）`
              : `距计划完成日在 ${milestoneSoonDays} 天内`,
          );
        }
      } else if (plannedEndYmd != null && daysUntilDue != null) {
        if (daysUntilDue < 0) {
          const chip = tagRow.createSpan({ cls: "rslatte-task-tag rslatte-task-tag--red", text: "超期" });
          chip.setAttr("title", `里程碑计划完成日：${plannedEndYmd}`);
        } else if (daysUntilDue <= milestoneSoonDays) {
          const chip = tagRow.createSpan({ cls: "rslatte-task-tag rslatte-task-tag--orange", text: "即将超期" });
          chip.setAttr("title", `里程碑计划完成日：${plannedEndYmd}（${milestoneSoonDays} 天内）`);
        }
      }
    }
    if (msStatus === "active" && isL1Ms) {
      if (derivedChips && mTags.includes("milestone_postponed")) {
        const chip = tagRow.createSpan({ cls: "rslatte-task-tag rslatte-task-tag--orange", text: "延期" });
        chip.setAttr("title", `延期次数：${postponeCount}（>=1）`);
      } else if (!derivedChips && postponeCount >= 1) {
        const chip = tagRow.createSpan({ cls: "rslatte-task-tag rslatte-task-tag--orange", text: "延期" });
        chip.setAttr("title", `延期次数：${postponeCount}（>=1）`);
      }
    }

    // 子树任务标签汇总：遍历子里程碑任务后聚合
    const taskTagCounts = new Map<string, number>();
    for (const it of subtreeTasks) {
      const tags = getProjectTaskTagsOrCompute(it, today, taskPanel);
      for (const key of tags) taskTagCounts.set(key, (taskTagCounts.get(key) ?? 0) + 1);
    }

    const colorNames: Record<number, string> = { 1: "red", 2: "orange", 3: "yellow", 4: "green" };
    const addTaskTag = (tagKey: string, label: string) => {
      const cnt = taskTagCounts.get(tagKey) ?? 0;
      if (cnt <= 0) return;
      const info = TASK_TAG_META[tagKey];
      const colorOrder = info?.colorOrder ?? 4;
      const clsColor = colorNames[colorOrder] ?? "green";
      const chip = tagRow.createSpan({
        cls: `rslatte-task-tag rslatte-task-tag--${clsColor}`,
        text: `${label} ${cnt}`,
      });
      chip.setAttr("title", `${info?.fullName ?? tagKey}（${cnt}）`);
    };

    addTaskTag("今日应处理", "今日任务");
    addTaskTag("已超期", "任务已超期");
    addTaskTag("已延期", "任务延期");
    addTaskTag("高拖延风险", "任务拖延");
    addTaskTag("等待跟进", "任务等待跟进");
    addTaskTag("假活跃", "任务假活跃");

    if (!isOpen) return;

    const kids = childrenMap.get(milestonePath) ?? [];
    // Keep the task order EXACTLY the same as in the tasklist file: do NOT sort.
    const allowedStatuses = opts?.statuses;
    const allowedTagKeys = opts?.tagKeys;
    const matchesStatus = (it: ProjectTaskItem): boolean => {
      if (!allowedStatuses || allowedStatuses.size === 0) return true;
      const st = String((it as any)?.statusName ?? "TODO").trim().toUpperCase();
      return allowedStatuses.has(st);
    };
    const matchesTags = (it: ProjectTaskItem): boolean => {
      if (!allowedTagKeys || allowedTagKeys.size === 0) return true;
      const tags = getProjectTaskTagsOrCompute(it, today, taskPanel);
      return tags.some((t) => allowedTagKeys.has(t));
    };
    const tasks = allTasks.filter(
      (it) => effectivePathForTask(it) === milestonePath && matchesStatus(it) && matchesTags(it)
    );
    const displayLimit = Math.max(1, Number(opts?.limit ?? 30));

    const exp = node.createDiv({ cls: "rslatte-project-ms-expanded" });

    if (tasks.length) {
      const taskWrap = exp.createDiv({ cls: "rslatte-project-ms-tasks" });
      const tl = taskWrap.createDiv({ cls: "rslatte-timeline" });
      for (const it of tasks.slice(0, displayLimit)) {
        this.renderProjectTaskTimelineItem(tl, p, it);
      }
      if (tasks.length > displayLimit) {
        taskWrap.createDiv({ cls: "rslatte-task-empty", text: `（仅显示前 ${displayLimit} 条，当前共 ${tasks.length} 条）` });
      }
    } else if (!kids.length) {
      exp.createDiv({ cls: "rslatte-task-empty", text: "（该里程碑下暂无任务）" });
    }

    if (kids.length) {
      const childWrap = exp.createDiv({ cls: "rslatte-project-ms-children" });
      for (const c of kids) {
        // Pass the milestone index map through recursion (avoid relying on outer-scope variables)
        this.renderMilestoneNode(childWrap, p, c, childrenMap, _msIndex, effectivePathForTask, opts);
      }
    }
  }

  private shortStatusText(statusName?: string): string {
    switch (statusName) {
      case "DONE": return "✓";
      case "IN_PROGRESS": return "…";
      case "CANCELLED": return "✕";
      case "TODO":
      default:
        return "○";
    }
  }

  private nextStatus(statusName?: string): "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED" {
    switch (statusName) {
      case "TODO": return "IN_PROGRESS";
      case "IN_PROGRESS": return "DONE";
      case "DONE": return "CANCELLED";
      case "CANCELLED":
      default:
        return "TODO";
    }
  }

  /** 在已渲染的 `.rslatte-project-card` 中定位项目：优先 `folderPath`，避免 `projectId` 与路径字符串冲突时误命中。 */
  private findMatchingProjectCardInList(cards: HTMLElement[], projectIdOrFolderPath: string): HTMLElement | null {
    const raw = String(projectIdOrFolderPath ?? "").trim();
    if (!raw) return null;
    const norm = normalizePath(raw);
    for (const card of cards) {
      const fp = card.getAttribute("data-project-folder-path");
      if (fp && normalizePath(fp) === norm) return card;
    }
    for (const card of cards) {
      const id = card.getAttribute("data-project-id");
      if (id && (id === raw || normalizePath(id) === norm)) return card;
    }
    return null;
  }

  /**
   * 定位并滚动到指定项目（用于从其他视图跳转）
   * @param projectIdOrFolderPath 项目 ID 或文件夹路径
   * @param milestonePath 可选的里程碑路径，如果提供则自动展开该里程碑及其所有父级里程碑
   * @param taskFilePath 可选的任务文件路径，如果提供则定位到具体的任务项
   * @param taskLineNo 可选的任务行号，如果提供则定位到具体的任务项
   * @param navOpts 可选：从 Today 等入口带入时写入里程碑清单的标签/状态筛选，便于对准目标任务
   */
  public async scrollToProject(
    projectIdOrFolderPath: string,
    milestonePath?: string,
    taskFilePath?: string,
    taskLineNo?: number,
    navOpts?: ScrollToProjectNavOpts
  ): Promise<void> {
    // 任务行仅渲染在「项目进度管理」→ 选中项目的「项目里程碑/任务清单」内；若留在「项目清单」页签则找不到 .rslatte-project-task-item
    const wantsTaskFocus =
      !!String(taskFilePath ?? "").trim() && taskLineNo !== undefined && taskLineNo >= 0;
    if (wantsTaskFocus) {
      const sAny: any = this.plugin.settings as any;
      if (!sAny.projectPanel) sAny.projectPanel = {};
      const pp = sAny.projectPanel;
      pp.mainTab = "progress";
      const snap = this.plugin.projectMgr?.getSnapshot?.();
      const all = (snap?.projects ?? []) as ProjectEntry[];
      const key = String(projectIdOrFolderPath ?? "").trim();
      let selId = key;
      const p = resolveProjectEntryByIdOrFolderPath(all, key);
      if (p) {
        selId = String(p.projectId ?? "").trim() || normalizePath(String(p.folderPath ?? "").trim());
      }
      pp.progressSelectedProjectId = selId;
      pp.progressSearchCollapsed = true;
      pp.progressProjectPickerExpanded = false;

      const tagKeysIn = navOpts?.applyTaskTagKeys;
      if (Array.isArray(tagKeysIn) && tagKeysIn.length > 0) {
        const cleaned = [
          ...new Set(
            tagKeysIn
              .map((x) => String(x ?? "").trim())
              .filter((x) => PROJECT_PROGRESS_TASK_TAG_FILTER_KEYS.includes(x) && !DAY_CARD_HIDDEN_TASK_TAG_KEYS.has(x))
          ),
        ];
        if (cleaned.length > 0) pp.progressTaskListFilterTagKeys = cleaned;
      }
      const ensureSt = String(navOpts?.ensureTaskStatus ?? "").trim().toUpperCase();
      const allowedStat = new Set(["TODO", "IN_PROGRESS", "DONE", "CANCELLED"]);
      if (ensureSt && allowedStat.has(ensureSt)) {
        const cur = new Set(
          Array.isArray(pp.progressTaskListFilterStatuses)
            ? pp.progressTaskListFilterStatuses.filter((x: string) => allowedStat.has(String(x).toUpperCase()))
            : []
        );
        if (cur.size === 0) {
          (["TODO", "IN_PROGRESS", "DONE", "CANCELLED"] as const).forEach((x) => cur.add(x));
        }
        cur.add(ensureSt as "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED");
        pp.progressTaskListFilterStatuses = Array.from(cur) as Array<"TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED">;
      }

      await this.plugin.saveSettings();
    }

    // 确保视图已渲染
    await this.render();
    
    // 等待一小段时间确保 DOM 已更新
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // 规范化路径
    const normalizedPath = normalizePath(projectIdOrFolderPath);
    
    // 查找匹配的项目元素
    const container = this.containerEl.children[1];
    const allProjectCards = Array.from(container.querySelectorAll<HTMLElement>(".rslatte-project-card"));
    let target: HTMLElement | null = this.findMatchingProjectCardInList(allProjectCards, projectIdOrFolderPath);
    
    if (!target) {
      // 如果找不到，尝试刷新视图后再找一次
      await this.render();
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const retryCards = Array.from(container.querySelectorAll<HTMLElement>(".rslatte-project-card"));
      target = this.findMatchingProjectCardInList(retryCards, projectIdOrFolderPath);
      
      if (!target) {
        new Notice(`未找到项目：${projectIdOrFolderPath}`);
        if (this.plugin.isDebugLogEnabled()) {
          console.log(`[RSLatte][ProjectView] scrollToProject failed:`, {
            searchKey: projectIdOrFolderPath,
            normalizedPath,
            foundCards: retryCards.length,
            sampleIds: Array.from(retryCards.slice(0, 3)).map(card => card.getAttribute("data-project-id")),
            samplePaths: Array.from(retryCards.slice(0, 3)).map(card => card.getAttribute("data-project-folder-path")),
          });
        }
        return;
      }
    }
    
    // 如果提供了里程碑路径，自动展开该里程碑及其所有父级里程碑
    if (milestonePath) {
      const projectKey = target.getAttribute("data-project-id") || target.getAttribute("data-project-folder-path") || projectIdOrFolderPath;
      if (projectKey) {
        // 尝试从项目快照中获取实际的里程碑路径列表，进行精确匹配
        let actualMilestonePath: string | null = null;
        try {
          const snap = this.plugin.projectMgr?.getSnapshot?.();
          if (snap?.projects) {
            const project = resolveProjectEntryByIdOrFolderPath(snap.projects as ProjectEntry[], projectIdOrFolderPath);
            
            if (project && project.milestones) {
              // 查找匹配的里程碑路径
              const normalizedMilestonePath = milestonePath.trim();
              
              // 精确匹配
              const exactMatch = project.milestones.find((m: any) => {
                const mPath = String(m.path ?? m.name ?? "").trim();
                return mPath === normalizedMilestonePath || mPath.endsWith(` / ${normalizedMilestonePath}`) ||
                       normalizedMilestonePath.endsWith(` / ${mPath}`) || normalizedMilestonePath === mPath;
              });
              
              if (exactMatch && exactMatch.path) {
                actualMilestonePath = String(exactMatch.path).trim();
              } else {
                // 部分匹配：查找包含该路径的里程碑
                const partialMatch = project.milestones.find((m: any) => {
                  const mPath = String(m.path ?? m.name ?? "").trim();
                  return mPath.includes(normalizedMilestonePath) || normalizedMilestonePath.includes(mPath);
                });
                
                if (partialMatch && partialMatch.path) {
                  actualMilestonePath = String(partialMatch.path).trim();
                } else {
                  // 如果找不到匹配，使用原始路径
                  actualMilestonePath = normalizedMilestonePath;
                }
              }
            } else {
              actualMilestonePath = milestonePath.trim();
            }
          } else {
            actualMilestonePath = milestonePath.trim();
          }
        } catch (err: any) {
          if (this.plugin.isDebugLogEnabled()) {
            console.warn("[RSLatte][ProjectView] Failed to find milestone path:", err);
          }
          actualMilestonePath = milestonePath.trim();
        }
        
        if (actualMilestonePath) {
          // 解析里程碑路径，展开所有父级里程碑
          // 里程碑路径格式可能是："七、存档和发布" 或 "七、存档和发布 / 7.3 分发"
          const pathParts = actualMilestonePath.split(/[\/\\]/).map(p => p.trim()).filter(p => p);
          
          // 展开所有父级里程碑（包括自身）
          for (let i = 0; i < pathParts.length; i++) {
            const partialPath = pathParts.slice(0, i + 1).join(" / ");
            const msKey = `${projectKey}::${partialPath}`;
            this._expandedMilestones.add(msKey);
          }
          
          if (this.plugin.isDebugLogEnabled()) {
            console.log(`[RSLatte][ProjectView] Expanding milestones:`, {
              projectKey,
              milestonePath,
              actualMilestonePath,
              expandedKeys: Array.from(this._expandedMilestones).filter(k => k.startsWith(`${projectKey}::`)),
            });
          }

          const projForFlash = resolveProjectEntryByIdOrFolderPath(
            (this.plugin.projectMgr?.getSnapshot?.()?.projects ?? []) as ProjectEntry[],
            projectIdOrFolderPath
          );
          if (projForFlash && actualMilestonePath) {
            const flashPk = String(projForFlash.projectId ?? projForFlash.folderPath ?? "").trim();
            this._milestoneNavFlashMsKey = `${flashPk}::${actualMilestonePath}`;
            this._milestoneNavFlashUntil = Date.now() + 2800;
          }
        }
        
        // 重新渲染以显示展开的里程碑
        await this.render();
        await new Promise(resolve => setTimeout(resolve, 300));
        
        // 重新查找目标（因为重新渲染后 DOM 已更新）
        const containerAfterRender = this.containerEl.children[1];
        const cardsAfterRender = Array.from(containerAfterRender.querySelectorAll<HTMLElement>(".rslatte-project-card"));
        const t2 = this.findMatchingProjectCardInList(cardsAfterRender, projectIdOrFolderPath);
        if (t2) target = t2;
      }
    }
    
    // 如果提供了任务文件路径和行号，定位到具体的任务项
    if (taskFilePath && taskLineNo !== undefined && taskLineNo >= 0) {
      const normalizedTaskFilePath = normalizePath(taskFilePath);
      
      // 使用更新后的 target（如果里程碑已展开，target 已经更新）
      const targetCard = target;
      
      if (targetCard) {
        // 查找任务项的辅助函数
        const findTaskItem = (container: HTMLElement): HTMLElement | null => {
          const allTaskItems = Array.from(container.querySelectorAll<HTMLElement>(".rslatte-project-task-item"));
          
          if (this.plugin.isDebugLogEnabled()) {
            console.log(`[RSLatte][ProjectView] Searching for task item:`, {
              searchPath: normalizedTaskFilePath,
              searchLineNo: taskLineNo,
              totalItems: allTaskItems.length,
              sampleItems: Array.from(allTaskItems.slice(0, 5)).map(item => ({
                path: item.getAttribute("data-project-task-file-path"),
                lineNo: item.getAttribute("data-project-task-line-no"),
                pathNormalized: item.getAttribute("data-project-task-file-path") ? normalizePath(item.getAttribute("data-project-task-file-path")!) : null,
              })),
            });
          }
          
          for (const item of allTaskItems) {
            const itemFilePath = item.getAttribute("data-project-task-file-path");
            const itemLineNo = item.getAttribute("data-project-task-line-no");
            
            if (!itemFilePath || itemLineNo === null) continue;
            
            const normalizedItemPath = normalizePath(itemFilePath);
            const itemLineNoNum = Number(itemLineNo);
            
            // 仅精确匹配 vault 相对路径 + 行号；不在多项目间做「同名文件/行号容差」模糊匹配，避免 Today 跳转高亮到错误项目。
            if (normalizedItemPath === normalizedTaskFilePath && itemLineNoNum === taskLineNo) {
              return item;
            }
            // 同一文件内允许小范围行号漂移（编辑增删行）
            if (normalizedItemPath === normalizedTaskFilePath && Math.abs(itemLineNoNum - taskLineNo) <= 2) {
              if (this.plugin.isDebugLogEnabled()) {
                console.log(`[RSLatte][ProjectView] Found task with line number offset:`, {
                  searchLineNo: taskLineNo,
                  foundLineNo: itemLineNoNum,
                  offset: Math.abs(itemLineNoNum - taskLineNo),
                });
              }
              return item;
            }
          }
          return null;
        };
        
        // 第一次尝试查找
        let taskTarget = findTaskItem(targetCard);
        
        if (!taskTarget) {
          // 如果找不到，等待更长时间后再次尝试（里程碑可能还在展开中）
          await new Promise(resolve => setTimeout(resolve, 500));
          // 重新查找项目卡片（因为重新渲染后 DOM 已更新）
          const containerAfterRender = this.containerEl.children[1];
          const cardsAfterRender = Array.from(containerAfterRender.querySelectorAll<HTMLElement>(".rslatte-project-card"));
          const retryTargetCard = this.findMatchingProjectCardInList(cardsAfterRender, projectIdOrFolderPath);
          if (retryTargetCard) taskTarget = findTaskItem(retryTargetCard);
        }
        
        if (taskTarget) {
          if (this.plugin.isDebugLogEnabled()) {
            console.log(`[RSLatte][ProjectView] Found task item:`, {
              taskFilePath: normalizedTaskFilePath,
              taskLineNo,
              element: taskTarget,
              classes: taskTarget.className,
            });
          }
          // 滚动到任务项
          taskTarget.scrollIntoView({ behavior: "smooth", block: "center" });
          // 仅高亮任务项，不高亮整个项目块
          // 使用 classList.add 确保类名正确添加
          taskTarget.classList.add("rslatte-project-task-highlight");
          // 强制触发重绘
          void taskTarget.offsetHeight;
          // 验证类名是否已添加
          if (this.plugin.isDebugLogEnabled()) {
            console.log(`[RSLatte][ProjectView] Added highlight class, current classes:`, taskTarget.className);
          }
          setTimeout(() => {
            taskTarget?.classList.remove("rslatte-project-task-highlight");
          }, 2000);
          return;
        } else {
          // 如果还是找不到任务项，记录调试信息
          const allTaskItems = Array.from(targetCard.querySelectorAll<HTMLElement>(".rslatte-project-task-item"));
          if (this.plugin.isDebugLogEnabled()) {
            console.log(`[RSLatte][ProjectView] Task item not found:`, {
              taskFilePath: normalizedTaskFilePath,
              taskLineNo,
              foundItems: allTaskItems.length,
              samplePaths: Array.from(allTaskItems.slice(0, 5)).map(item => ({
                path: item.getAttribute("data-project-task-file-path"),
                lineNo: item.getAttribute("data-project-task-line-no"),
              })),
            });
          }
        }
      }
    }
    
    // 如果没有提供任务信息或找不到任务项，滚动到项目块（但不高亮）
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  /** 递归收集某文件夹下所有文件（去重用 path 作键） */
  private collectFilesUnderFolder(folder: TFolder, byPath: Map<string, TFile>) {
    for (const c of folder.children) {
      if (c instanceof TFile) {
        if (this.shouldShowArchiveFile(c)) {
          byPath.set(normalizePath(c.path), c);
        }
      } else if (c instanceof TFolder) {
        this.collectFilesUnderFolder(c, byPath);
      }
    }
  }

  /**
   * 项目存档清单过滤：
   * - 过滤 Office 编辑临时文件（如 "~$xxx.xlsx"）
   * - 过滤常见编辑器缓存/交换文件
   */
  private shouldShowArchiveFile(file: TFile): boolean {
    const name = String(file.name ?? "").trim();
    const lower = name.toLowerCase();
    if (!name) return false;

    // Office/WPS 临时锁文件
    if (name.startsWith("~$")) return false;

    // 常见编辑器临时/交换文件
    if (lower.endsWith(".tmp") || lower.endsWith(".temp") || lower.endsWith(".swp") || lower.endsWith(".swo")) {
      return false;
    }
    if (name.endsWith("~")) return false;

    return true;
  }

  /**
   * 获取项目的存档文件列表：来自设置中「存档模板」的目标目录；并**并集**项目下 `pro_files`（若存在），
   * 避免未配置模板或仅配子目录时漏列常见存档目录。
   */
  private getProjectArchiveFiles(p: ProjectEntry): TFile[] {
    const templates = (this.plugin.settings.projectArchiveTemplates ?? []) as any[];
    const projectFolder = normalizePath(p.folderPath);
    const projectFolderObj = this.app.vault.getAbstractFileByPath(projectFolder);
    if (!projectFolderObj || !(projectFolderObj instanceof TFolder)) return [];

    const targetDirs = new Set<string>();
    for (const tpl of templates) {
      const relPath = String(tpl.targetRelPath ?? "").trim();
      if (!relPath) continue;
      const pn = p.projectName || "";
      let resolvedPath = relPath.replace(/\{\{projectName\}\}/g, pn).replace(/\{\{project\}\}/g, pn);
      resolvedPath = normalizePath(resolvedPath).replace(/^\/+|\/+$/g, "");
      if (resolvedPath) {
        targetDirs.add(normalizePath(`${projectFolder}/${resolvedPath}`));
      }
    }

    const defaultProFiles = normalizePath(`${projectFolder}/pro_files`);
    const proFolder = this.app.vault.getAbstractFileByPath(defaultProFiles);
    if (proFolder instanceof TFolder) {
      targetDirs.add(defaultProFiles);
    }

    if (targetDirs.size === 0) return [];

    const byPath = new Map<string, TFile>();
    for (const dir of targetDirs) {
      const fo = this.app.vault.getAbstractFileByPath(dir);
      if (fo instanceof TFolder) {
        this.collectFilesUnderFolder(fo, byPath);
      }
    }

    const archiveFiles = Array.from(byPath.values());
    archiveFiles.sort((a, b) => (b.stat.mtime || 0) - (a.stat.mtime || 0));
    return archiveFiles;
  }

  private archiveDirExpandKey(projectKey: string, relDir: string): string {
    return `${projectKey}::${normalizePath(relDir)}`;
  }

  /** 按项目根相对路径将存档文件归入目录树 */
  private buildArchiveDirTree(projectPath: string, files: TFile[]): ArchiveDirTree {
    const root: ArchiveDirTree = { subdirs: new Map(), files: [] };
    const proj = normalizePath(projectPath);
    for (const file of files) {
      const fp = normalizePath(file.path);
      if (!fp.startsWith(proj + "/")) continue;
      const rel = normalizePath(fp.substring(proj.length + 1));
      const parts = rel.split("/").filter(Boolean);
      if (!parts.length) continue;
      const dirParts = parts.slice(0, -1);
      let node = root;
      for (const seg of dirParts) {
        if (!node.subdirs.has(seg)) {
          node.subdirs.set(seg, { subdirs: new Map(), files: [] });
        }
        node = node.subdirs.get(seg)!;
      }
      node.files.push(file);
    }
    return root;
  }

  /** 收集树中所有目录的相对路径（用于「全部展开」） */
  private collectArchiveTreeDirRelPaths(node: ArchiveDirTree, prefix: string, out: Set<string>) {
    for (const [seg, sub] of node.subdirs) {
      const fp = prefix ? `${prefix}/${seg}` : seg;
      out.add(fp);
      this.collectArchiveTreeDirRelPaths(sub, fp, out);
    }
  }

  private isArchiveDirTreeEmpty(node: ArchiveDirTree): boolean {
    return node.files.length === 0 && node.subdirs.size === 0;
  }

  /** 单行：左文件名、右相对项目目录（缩进与树层级一致） */
  private renderArchiveFileRow(parent: HTMLElement, file: TFile, projectPath: string, depth: number) {
    const row = parent.createDiv({ cls: "rslatte-archive-file-item" });
    row.style.setProperty("--archive-depth", String(depth));
    row.tabIndex = 0;
    row.title = file.path;
    row.onclick = (ev) => {
      ev.stopPropagation();
      void this.app.workspace.getLeaf(false).openFile(file, { active: true });
    };

    const left = row.createDiv({ cls: "rslatte-archive-file-left" });
    const ext = String(file.extension ?? "").trim().toLowerCase() || "file";
    const cache = this.app.metadataCache.getFileCache(file);
    const outputId = String((cache as any)?.frontmatter?.output_id ?? "").trim();
    const isOutputManaged = ext === "md" && outputId.length > 0;

    if (isOutputManaged) {
      left.createSpan({ cls: "rslatte-archive-file-tag rslatte-archive-file-tag-output", text: "输出" });
    }

    const link = left.createEl("a", {
      text: file.basename,
      cls: "rslatte-archive-file-link",
      href: file.path,
    });
    link.title = file.path;
    link.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void this.app.workspace.getLeaf(false).openFile(file, { active: true });
    };

    left.createSpan({ cls: "rslatte-archive-file-tag rslatte-archive-file-tag-ext", text: ext });

    const proj = normalizePath(projectPath);
    const filePath = normalizePath(file.path);
    let dirLabel = "";
    if (filePath.startsWith(proj + "/")) {
      const relPath = filePath.substring(proj.length + 1);
      dirLabel = relPath.includes("/") ? relPath.substring(0, relPath.lastIndexOf("/")) : "";
    }
    const dirSpan = row.createSpan({ cls: "rslatte-archive-file-dir", text: dirLabel || "—" });
    dirSpan.setAttr("title", file.path);
  }

  /**
   * 递归渲染存档目录树：先子目录（可折叠），再本层文件。
   * @param relDir 当前 node 对应相对项目根的路径（根为 ""）
   */
  private renderArchiveTreeNodes(
    parent: HTMLElement,
    node: ArchiveDirTree,
    projectKey: string,
    projectPath: string,
    depth: number,
    relDir: string
  ) {
    const sortedFiles = [...node.files].sort((a, b) => (b.stat.mtime || 0) - (a.stat.mtime || 0));
    for (const file of sortedFiles) {
      this.renderArchiveFileRow(parent, file, projectPath, depth);
    }

    const dirNames = Array.from(node.subdirs.keys()).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
    for (const seg of dirNames) {
      const sub = node.subdirs.get(seg)!;
      const subRel = relDir ? `${relDir}/${seg}` : seg;
      const expandKey = this.archiveDirExpandKey(projectKey, subRel);
      const isOpen = this._expandedArchiveDirs.has(expandKey);

      const dirRow = parent.createDiv({ cls: "rslatte-archive-dir-row" });
      dirRow.style.setProperty("--archive-depth", String(depth));
      const togg = dirRow.createEl("button", {
        text: isOpen ? "▼" : "▶",
        cls: "rslatte-icon-only-btn rslatte-ms-toggle rslatte-archive-dir-toggle",
      });
      togg.title = isOpen ? "收起子目录" : "展开子目录";
      togg.onclick = (ev) => {
        ev.stopPropagation();
        if (this._expandedArchiveDirs.has(expandKey)) this._expandedArchiveDirs.delete(expandKey);
        else this._expandedArchiveDirs.add(expandKey);
        this.refresh();
      };
      const label = dirRow.createSpan({ cls: "rslatte-archive-dir-label", text: seg });
      label.title = subRel;

      if (isOpen) {
        const branch = parent.createDiv({ cls: "rslatte-archive-tree-branch" });
        this.renderArchiveTreeNodes(branch, sub, projectKey, projectPath, depth + 1, subRel);
      }
    }
  }

  /**
   * 渲染项目存档文件清单：标题 + 工具栏「全部展开/全部折叠」+ 按子目录分层的树（无整块折叠按钮）。
   */
  private renderArchiveFilesList(card: HTMLElement, p: ProjectEntry) {
    const key = String(p.projectId ?? p.folderPath ?? "").trim();
    if (!key) return;

    const archiveFiles = this.getProjectArchiveFiles(p);
    const projectPath = normalizePath(p.folderPath);

    const sec = card.createDiv({ cls: "rslatte-section rslatte-project-section rslatte-project-archive-section" });
    const headerRow = sec.createDiv({ cls: "rslatte-project-progress-section-header-row" });
    const headerLeft = headerRow.createDiv({ cls: "rslatte-project-progress-section-header-left" });
    headerLeft.createSpan({ cls: "rslatte-project-progress-section-title", text: "项目存档文件清单" });
    headerRow.createDiv({ cls: "rslatte-project-progress-section-badge", text: `${archiveFiles.length} 个文件` });

    const toolRow = sec.createDiv({ cls: "rslatte-project-progress-section-toolbar" });
    const expandTreeBtn = toolRow.createEl("button", { text: "全部展开", cls: "rslatte-project-progress-toolbar-btn" });
    expandTreeBtn.title = "展开所有子目录";
    expandTreeBtn.onclick = (ev) => {
      ev.stopPropagation();
      const tree = this.buildArchiveDirTree(projectPath, archiveFiles);
      const paths = new Set<string>();
      this.collectArchiveTreeDirRelPaths(tree, "", paths);
      for (const rel of paths) {
        this._expandedArchiveDirs.add(this.archiveDirExpandKey(key, rel));
      }
      this.refresh();
    };
    const collapseTreeBtn = toolRow.createEl("button", { text: "全部折叠", cls: "rslatte-project-progress-toolbar-btn" });
    collapseTreeBtn.title = "收起所有子目录";
    collapseTreeBtn.onclick = (ev) => {
      ev.stopPropagation();
      const prefix = `${key}::`;
      for (const k of Array.from(this._expandedArchiveDirs)) {
        if (k.startsWith(prefix)) this._expandedArchiveDirs.delete(k);
      }
      this.refresh();
    };

    const listWrap = sec.createDiv({ cls: "rslatte-archive-file-list rslatte-project-progress-section-body" });
    if (!archiveFiles.length) {
      listWrap.createDiv({ cls: "rslatte-task-empty", text: "（暂无存档文件）" });
      return;
    }

    const tree = this.buildArchiveDirTree(projectPath, archiveFiles);
    if (this.isArchiveDirTreeEmpty(tree)) {
      listWrap.createDiv({ cls: "rslatte-task-empty", text: "（暂无存档文件）" });
      return;
    }

    this.renderArchiveTreeNodes(listWrap, tree, key, projectPath, 0, "");
  }

  /** `.rslatte-project-meta` 行首：风险等级标签 + 时间信息文案 */
  private fillProjectMetaWithRisk(meta: HTMLElement, p: ProjectEntry, parts: string[]) {
    const taskPanel = this.plugin.settings?.taskPanel;
    const today = getTaskTodayKey(taskPanel);
    const r = computeProjectRiskSummary(p, today);
    const chip = meta.createSpan({ cls: `rslatte-task-tag rslatte-task-tag--${r.colorSuffix}`, text: r.levelLabel });
    chip.setAttr("title", `风险分 ${r.score}（卡片仅显示等级）`);
    if (parts.length) {
      const textSpan = meta.createSpan({ cls: "rslatte-project-meta-text" });
      textSpan.setText(parts.join(" · "));
    }
  }

  /** 打开「项目进度管理」页签并选中指定项目（供 Today 等入口复用） */
  public async openProgressTabForProject(p: ProjectEntry): Promise<void> {
    const sAny: any = this.plugin.settings as any;
    if (!sAny.projectPanel) sAny.projectPanel = {};
    const pp = sAny.projectPanel;
    pp.mainTab = "progress";
    const id = String(p.projectId ?? "").trim();
    pp.progressSelectedProjectId = id || normalizePath(String(p.folderPath ?? "").trim());
    pp.progressSearchCollapsed = true;
    await this.plugin.saveSettings();
    await this.render();
  }

  /** 推进区（或 meta）下一行靠右：打开「项目进度管理」并选中当前项目 */
  private renderProjectProgressNavRow(card: HTMLElement, p: ProjectEntry) {
    const row = card.createDiv({ cls: "rslatte-project-progress-nav-row" });
    const btn = row.createEl("button", { text: "查看项目进度", cls: "rslatte-project-progress-nav-btn" });
    btn.onclick = async () => {
      await this.openProgressTabForProject(p);
    };
  }

  private getProjectSortRaw(p: ProjectEntry, key: string): string | number | null | undefined {
    switch (key) {
      case "planned_end":
        return p.planned_end ?? null;
      case "created_date":
        return p.created_date ?? null;
      case "done":
        return p.done ?? null;
      case "cancelled":
        return p.cancelled ?? null;
      case "pending_archive":
        return (p as any).pending_archive_at ?? null;
      case "actual_start":
        return p.actual_start ?? null;
      case "name":
        return p.projectName ?? "";
      case "progress_updated":
      default:
        return progressUpdatedToMs(p.progress_updated);
    }
  }

  private compareProjectsForSort(a: ProjectEntry, b: ProjectEntry, key: string, asc: boolean): number {
    const va = this.getProjectSortRaw(a, key);
    const vb = this.getProjectSortRaw(b, key);
    const missA = va == null || va === "";
    const missB = vb == null || vb === "";
    if (missA && missB) return 0;
    if (missA) return 1;
    if (missB) return -1;
    let cmp: number;
    if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
    else cmp = String(va).localeCompare(String(vb), "zh-Hans-CN");
    return asc ? cmp : -cmp;
  }

  /** 项目状态多选按钮展示文案 */
  private buildProjectProgressStatusFilterSummary(panel: Record<string, any>): string {
    const t = panel.progressFilterStatusTodo !== false;
    const i = panel.progressFilterStatusInProgress !== false;
    const d = panel.progressFilterStatusDone !== false;
    const c = panel.progressFilterStatusCancelled !== false;
    if (t && i && d && c) return "全部状态";
    const parts: string[] = [];
    if (t) parts.push("待开始");
    if (i) parts.push("进行中");
    if (d) parts.push("已完成");
    if (c) parts.push("已取消");
    return parts.length ? parts.join("、") : "未选择";
  }

  /** 「项目进度管理」页签 */
  private renderProgressManagementTab(container: HTMLElement) {
    const pp = (this.plugin.settings as any).projectPanel ?? {};
    const limit = Math.max(1, Math.min(500, Number(pp.projectSearchDefaultLimit ?? 5) || 5));

    const snap = this.plugin.projectMgr.getSnapshot();
    const all = (snap?.projects ?? []) as ProjectEntry[];

    const searchSection = container.createDiv({ cls: "rslatte-section rslatte-project-section" });
    const searchHeader = searchSection.createDiv({ cls: "rslatte-section-title-row" });
    const searchCollapsed = !!pp.progressSearchCollapsed;
    searchHeader.createSpan({ cls: "rslatte-stats-collapse-icon", text: searchCollapsed ? "▶" : "▼" });
    searchHeader.createEl("h4", { text: "项目查找", cls: "rslatte-section-subtitle" });
    searchHeader.style.cursor = "pointer";
    searchHeader.onclick = async () => {
      pp.progressSearchCollapsed = !pp.progressSearchCollapsed;
      await this.plugin.saveSettings();
      void this.render();
    };

    const searchBody = searchSection.createDiv();
    if (searchCollapsed) searchBody.style.display = "none";

    const nameQ = String(pp.progressFilterName ?? "").trim();
    const stTodo = pp.progressFilterStatusTodo !== false;
    const stIng = pp.progressFilterStatusInProgress !== false;
    const stDone = pp.progressFilterStatusDone !== false;
    const stCan = pp.progressFilterStatusCancelled !== false;
    const sortKey = String(pp.progressSortKey ?? "progress_updated");
    const sortAsc = !!pp.progressSortAsc;

    const nameRow = searchBody.createDiv({ cls: "rslatte-project-filter-row rslatte-project-name-search-row" });
    const nameEl = nameRow.createEl("input", { type: "text", cls: "rslatte-project-search-name" });
    nameEl.value = pp.progressFilterName ?? "";
    nameEl.placeholder = "项目名称（模糊），回车查询";
    nameEl.addEventListener("keydown", async (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      pp.progressFilterName = nameEl.value;
      await this.plugin.saveSettings();
      void this.render();
    });

    const toolRow = searchBody.createDiv({ cls: "rslatte-project-progress-toolbar" });

    const statusWrap = toolRow.createDiv({ cls: "rslatte-project-toolbar-status" });
    statusWrap.createDiv({ cls: "rslatte-project-toolbar-label", text: "项目状态" });
    const statusBtn = statusWrap.createEl("button", {
      type: "button",
      cls: "rslatte-project-status-multibtn",
      text: this.buildProjectProgressStatusFilterSummary(pp),
    });
    const panelOpen = !!pp.progressStatusFilterOpen;
    const statusPanel = statusWrap.createDiv({ cls: "rslatte-project-status-panel" });
    if (!panelOpen) statusPanel.style.display = "none";

    statusBtn.onclick = async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      pp.progressStatusFilterOpen = !panelOpen;
      await this.plugin.saveSettings();
      void this.render();
    };

    const persistStatusOpenAndRender = async () => {
      pp.progressStatusFilterOpen = true;
      await this.plugin.saveSettings();
      void this.render();
    };

    const allFour = stTodo && stIng && stDone && stCan;
    const someFour = stTodo || stIng || stDone || stCan;
    const allLab = statusPanel.createEl("label", { cls: "rslatte-project-status-panel-row" });
    const allCb = allLab.createEl("input", { type: "checkbox" });
    allCb.checked = allFour;
    allCb.indeterminate = !allFour && someFour;
    allLab.createSpan({ text: " 全选" });
    allCb.onchange = async () => {
      const v = allCb.checked;
      pp.progressFilterStatusTodo = v;
      pp.progressFilterStatusInProgress = v;
      pp.progressFilterStatusDone = v;
      pp.progressFilterStatusCancelled = v;
      await persistStatusOpenAndRender();
    };

    const mkStatusRow = (
      label: string,
      field: "progressFilterStatusTodo" | "progressFilterStatusInProgress" | "progressFilterStatusDone" | "progressFilterStatusCancelled",
      checked: boolean
    ) => {
      const lab = statusPanel.createEl("label", { cls: "rslatte-project-status-panel-row" });
      const cb = lab.createEl("input", { type: "checkbox" });
      cb.checked = checked;
      lab.createSpan({ text: ` ${label}` });
      cb.onchange = async () => {
        pp[field] = cb.checked;
        await persistStatusOpenAndRender();
      };
    };
    mkStatusRow("待开始", "progressFilterStatusTodo", stTodo);
    mkStatusRow("进行中", "progressFilterStatusInProgress", stIng);
    mkStatusRow("已完成", "progressFilterStatusDone", stDone);
    mkStatusRow("已取消", "progressFilterStatusCancelled", stCan);

    const sortWrap = toolRow.createDiv({ cls: "rslatte-project-toolbar-sort" });
    sortWrap.createDiv({ cls: "rslatte-project-toolbar-label", text: "排序" });
    const sortInner = sortWrap.createDiv({ cls: "rslatte-project-toolbar-control" });
    const sortDd = new DropdownComponent(sortInner);
    sortDd.addOption("progress_updated", "最后进展更新时间");
    sortDd.addOption("planned_end", "计划结束日");
    sortDd.addOption("created_date", "创建日");
    sortDd.addOption("actual_start", "实际开始日");
    sortDd.addOption("done", "实际完成日");
    sortDd.addOption("cancelled", "取消日");
    sortDd.addOption("pending_archive", "待归档标记日");
    sortDd.addOption("name", "项目名称");
    sortDd.setValue(sortKey);
    sortDd.onChange(async (v) => {
      pp.progressSortKey = v;
      await this.plugin.saveSettings();
      void this.render();
    });

    const ordWrap = toolRow.createDiv({ cls: "rslatte-project-toolbar-order" });
    const ordRow = ordWrap.createDiv({ cls: "rslatte-project-toolbar-order-row" });
    ordRow.createSpan({ cls: "rslatte-project-toolbar-label rslatte-project-toolbar-label--inline", text: "顺序" });
    const ordInner = ordRow.createDiv({ cls: "rslatte-project-toolbar-control rslatte-project-toolbar-toggle-wrap" });
    const ordTg = new ToggleComponent(ordInner);
    ordTg.setValue(sortAsc);
    ordTg.setTooltip("关闭=降序，开启=升序");
    ordTg.onChange(async (v) => {
      pp.progressSortAsc = v;
      await this.plugin.saveSettings();
      void this.render();
    });

    const noFilter = !nameQ && stTodo && stIng && stDone && stCan;

    const selIdEarly = String(pp.progressSelectedProjectId ?? "").trim();
    const selectedEarly = selIdEarly ? resolveProjectEntryByIdOrFolderPath(all, selIdEarly) : undefined;
    const pickerExpanded = !!pp.progressProjectPickerExpanded;

    const matchesFilter = (p: ProjectEntry) => {
      const cat = projectProgressFilterCategory(p);
      if (cat === "todo" && !stTodo) return false;
      if (cat === "in-progress" && !stIng) return false;
      if (cat === "done" && !stDone) return false;
      if (cat === "cancelled" && !stCan) return false;
      if (cat === "other" && !stIng) return false;
      if (nameQ && !(String(p.projectName ?? "").toLowerCase().includes(nameQ.toLowerCase()))) return false;
      return true;
    };

    let displayList: ProjectEntry[];
    if (noFilter) {
      displayList = [...all]
        .sort((a, b) => this.compareProjectsForSort(a, b, sortKey, sortAsc))
        .slice(0, limit);
    } else {
      displayList = all.filter(matchesFilter).sort((a, b) => this.compareProjectsForSort(a, b, sortKey, sortAsc));
    }

    /** 第八节 8-2：未选中项目时默认不渲染大表，仅筛选项 + 空态；需列表时点「显示可选项目列表」 */
    const showProjectTable = !!selectedEarly || pickerExpanded;
    if (!showProjectTable) {
      const pickRow = searchBody.createDiv({ cls: "rslatte-project-filter-row" });
      const showListBtn = pickRow.createEl("button", { text: "显示可选项目列表", cls: "mod-cta" });
      showListBtn.onclick = async () => {
        pp.progressProjectPickerExpanded = true;
        await this.plugin.saveSettings();
        void this.render();
      };
      pickRow.createSpan({
        cls: "rslatte-project-hint",
        text: "也可在「项目清单」卡片点「查看项目进度」直接选中项目。",
      });
    } else {
      const tableHint = searchBody.createDiv({ cls: "rslatte-project-hint" });
      const sortLabel = PROGRESS_SORT_KEY_LABELS[sortKey] ?? sortKey;
      tableHint.setText(
        noFilter
          ? `无筛选：按「${sortLabel}」${sortAsc ? "升序" : "降序"}展示最近 ${limit} 条（可在设置中修改「项目搜索默认条数」）。`
          : `共 ${displayList.length} 条（已应用筛选/排序；缺排序字段的项目排在最后）。`
      );

      const table = searchBody.createDiv({ cls: "rslatte-project-search-table" });
      const head = table.createDiv({ cls: "rslatte-project-search-table-head" });
      ["状态", "项目名称", "实际开始", "完成/取消/待归档日"].forEach((h) => {
        head.createSpan({ cls: "rslatte-project-search-table-cell", text: h });
      });
      for (const p of displayList) {
        const stNorm = normalizeProjectStatus(p.status);
        const row = table.createDiv({ cls: "rslatte-project-search-table-row" });
        row.onclick = async () => {
          pp.progressSelectedProjectId = String(p.projectId ?? "").trim() || normalizePath(String(p.folderPath ?? "").trim());
          pp.progressSearchCollapsed = true;
          pp.progressProjectPickerExpanded = false;
          await this.plugin.saveSettings();
          void this.render();
        };
        row.createSpan({ cls: "rslatte-project-search-table-cell", text: String(stNorm) || "—" });
        const nameCell = row.createSpan({ cls: "rslatte-project-search-table-cell rslatte-project-search-table-name" });
        nameCell.setText(p.projectName ?? "—");
        row.createSpan({ cls: "rslatte-project-search-table-cell", text: p.actual_start ?? "—" });
        const endCell = row.createSpan({ cls: "rslatte-project-search-table-cell" });
        endCell.setText(
          stNorm === "cancelled"
            ? p.cancelled ?? "—"
            : stNorm === "pending_archive"
              ? (p as any).pending_archive_at ?? "—"
              : stNorm === "done"
                ? p.done ?? "—"
                : "—"
        );
      }
    }

    const selId = String(pp.progressSelectedProjectId ?? "").trim();
    const selected = selId ? resolveProjectEntryByIdOrFolderPath(all, selId) : undefined;

    if (selected && searchCollapsed) {
      const switchBar = container.createDiv({ cls: "rslatte-project-detail-switch" });
      const sw = switchBar.createEl("button", { text: "切换项目", cls: "rslatte-project-detail-switch-btn" });
      sw.onclick = async () => {
        pp.progressSearchCollapsed = false;
        await this.plugin.saveSettings();
        void this.render();
      };
    }

    if (!selected) {
      container.createDiv({
        cls: "rslatte-task-empty",
        text: "未选中项目。请使用上方筛选后点「显示可选项目列表」选择，或从「项目清单」点击「查看项目进度」。",
      });
      return;
    }

    this.renderProgressDetailView(container, selected);
  }

  /** 标题旁 DB 同步指示灯（设置开启 DB 同步时） */
  private maybeAppendProjectDbSyncIcon(nameWrap: HTMLElement, p: ProjectEntry) {
    const moduleDbSyncEnabled = (() => {
      try {
        const fn = (this.plugin as any).isProjectDbSyncEnabled;
        return typeof fn === "function" ? !!fn.call(this.plugin) : false;
      } catch {
        return false;
      }
    })();
    const st = moduleDbSyncEnabled ? String(p.dbSyncStatus ?? "").trim() : "off";
    if (st && st !== "off") {
      const icon = st === "ok" ? "🟢" : st === "pending" ? "🟡" : st === "error" ? "🔴" : "⚪";
      const s = nameWrap.createEl("span", { cls: "rslatte-project-sync", text: icon });
      const tip: string[] = [];
      if (p.dbSyncedAt) tip.push(`synced ${p.dbSyncedAt}`);
      if (p.dbPendingOps && p.dbPendingOps > 0) tip.push(`pending ${p.dbPendingOps}`);
      if (p.dbLastError) tip.push(`error ${p.dbLastError}`);
      s.title = tip.join("\n") || `db sync: ${st}`;
    }
  }

  private appendProjectEditButton(nameWrap: HTMLElement, p: ProjectEntry) {
    const editBtn = nameWrap.createEl("button", { text: "⚙", cls: "rslatte-icon-btn" });
    editBtn.title = "修改项目信息";
    editBtn.onclick = () => {
      new EditProjectModal(this.app, { projectName: p.projectName, planned_end: p.planned_end, planned_start: p.planned_start }, async (r) => {
        try {
          await this.plugin.projectMgr.updateProjectInfo(p.folderPath, { projectName: r.projectName, planned_end: r.planned_end, planned_start: r.planned_start });
          new Notice("已更新项目信息");
          this.refresh();
        } catch (e: any) {
          new Notice(`操作失败：${e?.message ?? String(e)}`);
        }
      }).open();
    };
  }

  private appendProjectChartAndArchiveActions(list: ProjectCardAction[], p: ProjectEntry): void {
    list.push({
      id: "project_chart",
      icon: "📊",
      title: "打开项目分析图",
      run: () => {
        const path = p.analysisFilePath;
        if (!path) {
          new Notice("未找到项目分析图文件");
          return;
        }
        const af = this.app.vault.getAbstractFileByPath(path);
        if (af instanceof TFile) void this.app.workspace.getLeaf(true).openFile(af);
        else new Notice("未找到项目分析图文件");
      },
    });
    list.push({
      id: "project_archive_doc",
      icon: "📄",
      title: "创建项目存档文件",
      run: () => {
        const tpls = mergeProjectArchiveTemplatesForModal(this.plugin).filter((t) => !!String(t?.targetRelPath ?? "").trim());
        if (!tpls.length) {
          new Notice("未配置项目存档模板：请在「设置 → 输出管理」添加范围=项目的模板（填写项目内相对路径），或使用旧版「项目管理」模板清单");
          return;
        }
        const pid = String(p.projectId ?? "").trim();
        if (!pid) {
          new Notice("当前项目缺少 project_id，请先刷新项目索引或检查项目信息文件");
          return;
        }
        new CreateProjectArchiveDocModal(this.app, this.plugin, { folderPath: p.folderPath, projectName: p.projectName, projectId: pid }, tpls as any).open();
      },
    });
  }

  /**
   * 项目操作按钮：进行中 → 延期/里程碑/分析图/存档/取消/完成；已完成 → 待归档 + 恢复…；待归档/已取消 → 恢复/分析图/存档。
   * （原在「项目清单」卡片第二行，现仅在此与进度详情中使用。）
   */
  private fillProjectManagementActionButtons(actionsRow: HTMLElement, p: ProjectEntry) {
    const stNorm = normalizeProjectStatus(p.status);
    const actions: ProjectCardAction[] = [];
    if (isProjectClosedForUiSummary(p.status)) {
      if (canMarkPendingArchive(stNorm)) {
        actions.push({
          id: "project_mark_pending_archive",
          icon: "🗄",
          title: "标记待归档（超阈值后随笔记归档移入归档目录）",
          run: async () => {
            try {
              await this.plugin.projectMgr.markPendingArchive(p.folderPath);
              new Notice("已标记为待归档");
            } catch (e: any) {
              new Notice(String(e?.message ?? e));
            }
            this.refresh();
          },
        });
      }
      actions.push({
        id: "project_recover",
        icon: "🔄",
        title: stNorm === "pending_archive" ? "取消待归档（恢复为已完成）" : "恢复项目",
        run: async () => {
          await this.plugin.projectMgr.recoverProject(p.folderPath);
          new Notice(stNorm === "pending_archive" ? "已恢复为已完成" : "项目已恢复");
          this.refresh();
        },
      });
      this.appendProjectChartAndArchiveActions(actions, p);
      this.mountProjectCardActions(actionsRow, actions, this.getProjectCardMoreIds());
      return;
    }

    if (stNorm === "in-progress" && p.planned_end) {
      actions.push({
        id: "project_postpone",
        icon: "↪",
        title: "项目延期",
        run: () => {
          new PostponeModal(this.app, "项目延期", async (days, reason) => {
            await this.plugin.projectMgr.postponeProject(p.folderPath, days, reason);
            new Notice("已延期");
            this.refresh();
          }).open();
        },
      });
    }

    actions.push({
      id: "project_add_milestone",
      icon: "➕",
      title: "添加里程碑",
      run: () => new AddProjectMilestoneModal(this.app, this.plugin, p.folderPath).open(),
    });
    this.appendProjectChartAndArchiveActions(actions, p);
    actions.push(
      {
        id: "project_cancel",
        icon: "❌",
        title: "取消项目",
        run: async () => {
          await this.plugin.projectMgr.markCancelled(p.folderPath);
          new Notice("项目已取消");
          this.refresh();
        },
      },
      {
        id: "project_done",
        icon: "✅",
        title: "完成项目",
        run: async () => {
          await this.plugin.projectMgr.markDone(p.folderPath);
          new Notice("项目已完成");
          this.refresh();
        },
      }
    );
    this.mountProjectCardActions(
      actionsRow,
      actions,
      this.getProjectCardMoreIds()
    );
  }

  private renderProjectSummaryForProgress(card: HTMLElement, p: ProjectEntry) {
    const wrap = card.createDiv({ cls: "rslatte-project-summary" });
    const stNorm = normalizeProjectStatus(p.status);
    const taskPanel = this.plugin.settings?.taskPanel;
    const today = getTaskTodayKey(taskPanel);
    const pp = this.plugin.settings?.projectPanel ?? {};
    const projectSoonN = Math.max(0, Math.min(30, Number((pp as any).progressProjectUpcomingDays ?? 5) || 5));
    const r = computeProjectRiskSummary(p, today);
    const inc = countProjectIncompleteTasks(p.taskItems);
    const tot = countProjectTasksExcludingCancelled(p.taskItems);

    const row = (k: string, v: string) => {
      const line = wrap.createDiv({ cls: "rslatte-project-summary-row" });
      line.createSpan({ cls: "rslatte-project-summary-k", text: k });
      line.createSpan({ cls: "rslatte-project-summary-v", text: v });
    };

    const toYmdPrefix = (s?: unknown): string | null => {
      if (!s) return null;
      const m = String(s).trim().match(/^(\d{4}-\d{2}-\d{2})/);
      return m ? m[1] : null;
    };
    const ymdToMs = (ymd: string): number => {
      const [y, m, d] = ymd.split("-").map((x) => Number(x));
      return Date.UTC(y, m - 1, d);
    };
    const todayMs = ymdToMs(today);

    const isClosed = isProjectClosedForUiSummary(p.status);
    const postponeCount = Math.max(0, Number(p.postpone_count ?? 0) || 0);
    const plannedEndYmd = toYmdPrefix(p.planned_end);
    const plannedEndMs = plannedEndYmd ? ymdToMs(plannedEndYmd) : null;
    const daysUntilDue = plannedEndMs == null ? null : Math.floor((plannedEndMs - todayMs) / 86400000);

    const progressUpdatedYmd = toYmdPrefix(p.progress_updated);
    const daysSinceProgressUpdated =
      progressUpdatedYmd != null ? Math.floor((todayMs - ymdToMs(progressUpdatedYmd)) / 86400000) : null;

    const isOverdue = !isClosed && plannedEndYmd != null && daysUntilDue != null && daysUntilDue <= 0;
    const isDelay = !isClosed && postponeCount >= 1;
    const isSoonOverdue =
      !isClosed && plannedEndYmd != null && daysUntilDue != null && daysUntilDue > 0 && daysUntilDue <= projectSoonN;
    const isFakeActive = !isClosed && progressUpdatedYmd != null && daysSinceProgressUpdated != null && daysSinceProgressUpdated >= 5;

    const ptags = (p as any).project_tags;
    const useSnapshotHints =
      String((p as any).projectDerivedForYmd ?? "").trim() === today && Array.isArray(ptags) && ptags.length > 0;
    const hintSet = useSnapshotHints ? new Set(ptags as string[]) : null;
    // 快照与本地现算取并集，避免 project_tags 为空数组或漏标时提示 chip 全丢
    const isOverdueChip = hintSet ? hintSet.has("project_overdue") || isOverdue : isOverdue;
    const isDelayChip = hintSet ? hintSet.has("project_postponed") || isDelay : isDelay;
    const isSoonOverdueChip = hintSet ? hintSet.has("project_soon_overdue") || isSoonOverdue : isSoonOverdue;
    const isFakeActiveChip = hintSet ? hintSet.has("stale_progress") || isFakeActive : isFakeActive;

    const statusLine = wrap.createDiv({ cls: "rslatte-project-summary-row" });
    statusLine.createSpan({ cls: "rslatte-project-summary-k", text: "当前状态" });
    const statusV = statusLine.createDiv({ cls: "rslatte-project-summary-v rslatte-project-summary-v--wrap" });
    statusV.createSpan({ text: this.projectHeadStatusText(p) });
    const addTagChip = (cls: string, text: string, title?: string) => {
      const chip = statusV.createSpan({ cls: `rslatte-task-tag ${cls}`, text });
      if (title) chip.setAttr("title", title);
    };
    if (isOverdueChip) addTagChip("rslatte-task-tag--red", "超期", `计划完成日：${plannedEndYmd}`);
    if (isDelayChip) addTagChip("rslatte-task-tag--orange", "延期", `延期次数：${postponeCount}`);
    if (isSoonOverdueChip)
      addTagChip("rslatte-task-tag--orange", "即将超期", `计划完成日：${plannedEndYmd}（${projectSoonN} 天内）`);
    if (isFakeActiveChip)
      addTagChip("rslatte-task-tag--orange", "假活跃", `近 ${daysSinceProgressUpdated ?? "—"} 天未更新进展`);

    const showProgress = stNorm === "in-progress";
    if (showProgress) {
      const ratio = computeWeightedMilestoneProgressRatio(p.milestones);
      const pct = Math.round(ratio * 1000) / 10;
      const pctClamped = Math.min(100, Math.max(0, pct));
      const progressRow = wrap.createDiv({ cls: "rslatte-project-summary-row" });
      progressRow.createSpan({ cls: "rslatte-project-summary-k", text: "总进度" });
      const progressV = progressRow.createDiv({ cls: "rslatte-project-summary-v" });
      const barOut = progressV.createDiv({ cls: "rslatte-project-summary-progress" });
      barOut.setAttr("title", `里程碑加权约 ${pctClamped}%`);
      const barTier =
        pctClamped >= 80 ? "rslatte-project-summary-progress-inner--high" : pctClamped >= 40 ? "rslatte-project-summary-progress-inner--mid" : "rslatte-project-summary-progress-inner--low";
      const barIn = barOut.createDiv({ cls: `rslatte-project-summary-progress-inner ${barTier}` });
      barIn.style.width = `${pctClamped}%`;
    }

    row("实际开始日", p.actual_start ?? "—");
    row("计划结束日", p.planned_end ?? "—");

    let dueRemainText = "—";
    if (plannedEndYmd == null) {
      dueRemainText = "—";
    } else if (daysUntilDue == null) {
      dueRemainText = "—";
    } else if (daysUntilDue > 0) {
      dueRemainText = `剩余 ${daysUntilDue} 天`;
    } else if (daysUntilDue === 0) {
      dueRemainText = "今日为计划完成日";
    } else {
      dueRemainText = `已超期 ${-daysUntilDue} 天`;
    }
    row("剩余天数 / 已超期天数", dueRemainText);

    row("最近进展更新", p.progress_updated ?? "—");

    const riskLine = wrap.createDiv({ cls: "rslatte-project-summary-row" });
    riskLine.createSpan({ cls: "rslatte-project-summary-k", text: "风险" });
    const riskV = riskLine.createDiv({ cls: "rslatte-project-summary-v rslatte-project-summary-v--wrap" });
    const riskChip = riskV.createSpan({ cls: `rslatte-task-tag rslatte-task-tag--${r.colorSuffix}`, text: r.levelLabel });
    riskChip.setAttr("title", `风险分 ${r.score}（卡片仅显示等级）`);
    riskV.createSpan({ text: `· 风险分 ${r.score}` });

    row("未完成任务数", `未完成 ${inc} 项；任务总数 ${tot}（不含已取消）`);
  }

  private renderProgressDetailView(container: HTMLElement, p: ProjectEntry) {
    const card = container.createDiv({ cls: "rslatte-project-card rslatte-project-progress-detail" });
    // 与清单卡片一致，供 scrollToProject 等按 projectId / 文件夹路径定位 DOM
    const projectId = String(p.projectId ?? "").trim();
    const folderPath = normalizePath(String(p.folderPath ?? "").trim());
    if (projectId) card.setAttribute("data-project-id", projectId);
    if (folderPath) card.setAttribute("data-project-folder-path", folderPath);

    const headRow = card.createDiv({ cls: "rslatte-proj-headrow" });
    const nameWrap = headRow.createDiv({ cls: "rslatte-proj-namewrap" });
    const title = nameWrap.createEl("div", { cls: "rslatte-proj-title rslatte-project-title", text: p.projectName });
    title.title = "打开项目任务清单";
    title.onclick = () => {
      const af = this.app.vault.getAbstractFileByPath(p.tasklistFilePath);
      if (af instanceof TFile) void this.app.workspace.getLeaf(true).openFile(af);
    };
    this.maybeAppendProjectDbSyncIcon(nameWrap, p);
    this.appendProjectEditButton(nameWrap, p);
    headRow.createDiv({ cls: "rslatte-proj-status-text", text: this.projectHeadStatusText(p) });

    const detailActions = card.createDiv({ cls: "rslatte-proj-actions rslatte-project-progress-detail-actions" });
    this.fillProjectManagementActionButtons(detailActions, p);

    const progressSectionKey = String(p.projectId ?? p.folderPath ?? "").trim();

    const sumSec = card.createDiv({ cls: "rslatte-section rslatte-project-section" });
    const sumHdr = sumSec.createDiv({ cls: "rslatte-project-progress-section-header-row" });
    const sumLeft = sumHdr.createDiv({ cls: "rslatte-project-progress-section-header-left" });
    sumLeft.createSpan({ cls: "rslatte-project-progress-section-title", text: "项目概要" });
    const sumBody = sumSec.createDiv({ cls: "rslatte-project-summary-body rslatte-project-progress-section-body" });
    this.renderProjectSummaryForProgress(sumBody, p);

    this.renderMilestonesSection(card, p);

    const chartSec = card.createDiv({ cls: "rslatte-section rslatte-project-section" });
    const chartHdr = chartSec.createDiv({ cls: "rslatte-project-progress-section-header-row" });
    const chartLeft = chartHdr.createDiv({ cls: "rslatte-project-progress-section-header-left" });
    chartLeft.createSpan({ cls: "rslatte-project-progress-section-title", text: "项目进度图" });
    const chartCollapsed = progressSectionKey ? this.isProgressChartCollapsed(progressSectionKey) : false;
    const chartTog = chartHdr.createEl("button", {
      text: chartCollapsed ? "▶" : "▼",
      cls: "rslatte-icon-only-btn rslatte-ms-toggle rslatte-project-progress-chart-toggle",
    });
    chartTog.title = chartCollapsed ? "展开进度图区域" : "收起进度图区域";
    chartTog.onclick = (ev) => {
      ev.stopPropagation();
      if (!progressSectionKey) return;
      void this.toggleProgressChartCollapsed(progressSectionKey);
    };
    if (!chartCollapsed) {
      const chartBody = chartSec.createDiv({ cls: "rslatte-project-progress-section-body rslatte-proj-gantt-root" });
      this.renderProjectProgressChartBody(chartBody, p, progressSectionKey);
    }

    this.renderArchiveFilesList(card, p);
  }

  private isProgressChartCollapsed(projectKey: string): boolean {
    const pp = (this.plugin.settings as any).projectPanel ?? {};
    const keys: string[] = pp.progressChartCollapsedKeys ?? [];
    return keys.includes(projectKey);
  }

  private async toggleProgressChartCollapsed(projectKey: string): Promise<void> {
    const sAny: any = this.plugin.settings as any;
    if (!sAny.projectPanel) sAny.projectPanel = {};
    const arr: string[] = [...(sAny.projectPanel.progressChartCollapsedKeys ?? [])];
    const i = arr.indexOf(projectKey);
    if (i >= 0) arr.splice(i, 1);
    else arr.push(projectKey);
    sAny.projectPanel.progressChartCollapsedKeys = arr;
    await this.plugin.saveSettings();
    this.refresh();
  }

  /** 第五节「项目进度图」：甘特时间轴 + 汇总 + 里程碑线 */
  private renderProjectProgressChartBody(container: HTMLElement, p: ProjectEntry, projectKey: string) {
    const sAny: any = this.plugin.settings as any;
    const pp = sAny.projectPanel ?? {};
    const marginDays = Math.max(0, Math.min(120, Number(pp.progressChartMarginDays ?? 30) || 30));
    const taskSort = pp.progressChartTaskSort === "file_order" ? "file_order" : "planned_end";
    const zoom = pp.progressChartZoom === "week" || pp.progressChartZoom === "quarter" ? pp.progressChartZoom : "month";
    const summaryMode: ProgressChartOptions["summaryMode"] =
      pp.progressChartSummaryMode === "count" || pp.progressChartSummaryMode === "hours" || pp.progressChartSummaryMode === "both"
        ? pp.progressChartSummaryMode
        : "both";
    const hideDone = !!pp.progressChartHideDone;

    const { roots, effectivePathForTask } = this.getProjectRootsAndPathResolver(p);
    const model = buildProgressChartModel(p, roots, effectivePathForTask, {
      marginDays,
      taskSort,
      zoom,
      milestoneMode: "overlay",
      summaryMode,
      hideDone,
    });

    if (model.isEmptyProject) {
      container.createDiv({
        cls: "rslatte-proj-gantt-empty",
        text: "暂无任务与里程碑，添加后在时间轴上查看进度。",
      });
      return;
    }

    const persist = async (patch: Record<string, unknown>) => {
      if (!sAny.projectPanel) sAny.projectPanel = {};
      Object.assign(sAny.projectPanel, patch);
      await this.plugin.saveSettings();
      this.refresh();
    };

    const tb = container.createDiv({ cls: "rslatte-proj-gantt-toolbar" });
    const mkSelect = (label: string, value: string, options: { v: string; t: string }[], onPick: (v: string) => void) => {
      const lab = tb.createEl("label", { cls: "rslatte-proj-gantt-toolbar-item" });
      lab.createSpan({ text: label + " " });
      const sel = lab.createEl("select", { cls: "rslatte-proj-gantt-select" });
      for (const o of options) sel.createEl("option", { text: o.t, attr: { value: o.v } });
      sel.value = value;
      sel.onchange = () => onPick(sel.value);
    };

    mkSelect(
      "缩放",
      zoom,
      [
        { v: "week", t: "周" },
        { v: "month", t: "月" },
        { v: "quarter", t: "季" },
      ],
      (v) => void persist({ progressChartZoom: v })
    );
    mkSelect(
      "同轨排序",
      taskSort,
      [
        { v: "planned_end", t: "计划结束日" },
        { v: "file_order", t: "文件顺序" },
      ],
      (v) => void persist({ progressChartTaskSort: v })
    );
    mkSelect(
      "汇总",
      summaryMode,
      [
        { v: "count", t: "条数" },
        { v: "hours", t: "工时" },
        { v: "both", t: "二者" },
      ],
      (v) => void persist({ progressChartSummaryMode: v })
    );

    const hideBtnWrap = tb.createDiv({ cls: "rslatte-proj-gantt-toolbar-item" });
    const hideBtn = hideBtnWrap.createEl("button", {
      cls: "rslatte-proj-gantt-hide-done-btn",
      text: hideDone ? "显示已完成" : "隐藏已完成",
    });
    hideBtn.title = hideDone ? "点击后在进度图上显示已完成任务" : "点击后隐藏已完成任务，仅看进行中/待办";
    hideBtn.onclick = () => void persist({ progressChartHideDone: !hideDone });

    const sum = model.summary;
    const sumRow = container.createDiv({ cls: "rslatte-proj-gantt-summary" });
    const showCount = summaryMode === "count" || summaryMode === "both";
    const showHours = (summaryMode === "hours" || summaryMode === "both") && sum.hasAnyEstimate;
    if (showCount) {
      sumRow.createSpan({
        cls: "rslatte-proj-gantt-summary-item",
        text: `任务：已完成 ${sum.doneCount} / 非取消 ${sum.totalNonCancelled}`,
      });
    }
    if (showHours) {
      sumRow.createSpan({
        cls: "rslatte-proj-gantt-summary-item",
        text: `工时：已完成约 ${Math.round(sum.doneHours * 10) / 10}h / 已估算合计 ${Math.round(sum.totalHours * 10) / 10}h`,
      });
    }
    if (summaryMode === "hours" && !sum.hasAnyEstimate) {
      sumRow.createSpan({ cls: "rslatte-proj-gantt-summary-item", text: "无工时评估（estimate_h），已隐藏工时条。" });
    }

    container.createDiv({
      cls: "rslatte-proj-gantt-range",
      text: `范围 ${model.chartMinYmd} ~ ${model.chartMaxYmd}（左右余量 ${marginDays} 天，设置项可改）`,
    });

    const chartPxW = model.totalDays * model.pxPerDay;
    const labelColW = 100;
    const wideW = labelColW + chartPxW;

    const scroll = container.createDiv({ cls: "rslatte-proj-gantt-scroll" });
    const wide = scroll.createDiv({ cls: "rslatte-proj-gantt-wide" });
    wide.style.width = `${wideW}px`;

    const mkAxisRow = (parent: HTMLElement) => {
      const row = parent.createDiv({ cls: "rslatte-proj-gantt-row" });
      row.createDiv({ cls: "rslatte-proj-gantt-label", text: "" });
      const chart = row.createDiv({ cls: "rslatte-proj-gantt-chart" });
      chart.style.width = `${chartPxW}px`;
      return { row, chart };
    };

    const { row: axisRow, chart: axisChart } = mkAxisRow(wide);
    axisChart.addClass("rslatte-proj-gantt-axis");
    for (let d = 0; d < model.totalDays; d += 7) {
      const ymd = addDaysYmd(model.chartMinYmd, d);
      const tick = axisChart.createDiv({ cls: "rslatte-proj-gantt-tick" });
      tick.style.left = `${(d / model.totalDays) * 100}%`;
      tick.createSpan({ cls: "rslatte-proj-gantt-tick-label", text: ymd.slice(5) });
    }

    const visMarkers = model.milestoneMarkers.filter((m) => m.dateYmd >= model.chartMinYmd && m.dateYmd <= model.chartMaxYmd);
    // 任务改为“点线”后，里程碑也按日期中心落点，避免同日看起来有偏移。
    const markerXFrac = (m: (typeof visMarkers)[number]): number => {
      const t = ymdToFrac(model.chartMinYmd, model.chartMaxYmd, m.dateYmd);
      return Math.min(1, Math.max(0, t + 0.5 / model.totalDays));
    };
    const markerKindLabel = (k: (typeof visMarkers)[number]["kind"]): string => {
      if (k === "planned") return "计划";
      if (k === "done") return "完成";
      if (k === "cancelled") return "取消";
      return "创建";
    };
    const markerKindPriority = (k: (typeof visMarkers)[number]["kind"]): number => {
      // 颜色优先级：planned 覆盖 created；其余按业务语义靠前
      if (k === "cancelled") return 4;
      if (k === "done") return 3;
      if (k === "planned") return 2;
      return 1; // created
    };
    const groupedMarkers = (() => {
      const byDate = new Map<string, typeof visMarkers>();
      for (const m of visMarkers) {
        const arr = byDate.get(m.dateYmd) ?? [];
        arr.push(m);
        byDate.set(m.dateYmd, arr);
      }
      const groups = Array.from(byDate.entries())
        .map(([dateYmd, items]) => {
          const sorted = [...items].sort((a, b) => markerKindPriority(b.kind) - markerKindPriority(a.kind));
          const primary = sorted[0];
          const x = markerXFrac(primary);
          const lines = sorted.map((it) => `- ${it.title} · ${markerKindLabel(it.kind)} · ${it.dateYmd}`);
          const title = sorted.length > 1
            ? `共 ${sorted.length} 条里程碑：\n${lines.join("\n")}`
            : `${sorted[0].title} · ${markerKindLabel(sorted[0].kind)} · ${sorted[0].dateYmd}`;
          return { dateYmd, items: sorted, primaryKind: primary.kind, x, title };
        })
        .sort((a, b) => a.dateYmd.localeCompare(b.dateYmd));
      return groups;
    })();

    for (const tr of model.tracks) {
      const row = wide.createDiv({ cls: "rslatte-proj-gantt-row" });
      row.createDiv({ cls: "rslatte-proj-gantt-label", text: tr.rootTitle });
      const chart = row.createDiv({ cls: "rslatte-proj-gantt-chart" });
      chart.style.width = `${chartPxW}px`;
      const lane = chart.createDiv({ cls: "rslatte-proj-gantt-lane" });
      const laneH = Math.max(22, tr.bars.length * 14 + 6);
      lane.style.minHeight = `${laneH}px`;
      tr.bars.forEach((b, bi) => {
        const jumpToTaskInList = () => {
          const filePath = String((b.task as any)?.sourceFilePath ?? p.tasklistFilePath ?? "").trim();
          const lineNo = Number((b.task as any)?.lineNo ?? -1);
          void this.scrollToProject(projectKey, tr.rootPath, filePath || undefined, lineNo >= 0 ? lineNo : undefined);
        };

        const seg = lane.createDiv({ cls: "rslatte-proj-gantt-seg-row" });
        seg.style.top = `${4 + bi * 14}px`;

        const x0 = Math.min(b.startFrac, b.endFrac);
        const x1 = Math.max(b.startFrac, b.endFrac);

        if (!b.isPoint) {
          const line = seg.createDiv({
            cls: `rslatte-proj-gantt-seg-line rslatte-proj-gantt-seg-line--${b.phase}`,
          });
          if (b.exceedsMilestonePlannedEnd) line.addClass("rslatte-proj-gantt-seg-line--anomaly");
          line.style.left = `${x0 * 100}%`;
          line.style.width = `${Math.max(0.08, (x1 - x0) * 100)}%`;
          line.title = b.exceedsMilestonePlannedEnd
            ? `${b.label}（超出里程碑计划完成日，建议检查）`
            : `${b.label}（点击定位到上方任务清单）`;
          line.onclick = jumpToTaskInList;
        }

        const dot = seg.createDiv({
          cls: `rslatte-proj-gantt-seg-dot rslatte-proj-gantt-seg-dot--${b.phase}`,
        });
        if (b.exceedsMilestonePlannedEnd) dot.addClass("rslatte-proj-gantt-seg-dot--anomaly");
        dot.style.left = `${(b.isPoint ? b.startFrac : x1) * 100}%`;
        dot.title = b.exceedsMilestonePlannedEnd
          ? `${b.label}（超出里程碑计划完成日，建议检查）`
          : `${b.label}（点击定位到上方任务清单）`;
        dot.onclick = jumpToTaskInList;
      });
    }

    if (groupedMarkers.length) {
      // 里程碑竖线贯穿整图：从时间轴下边缘到图表底部（跨所有轨道行）
      const fullOv = wide.createDiv({ cls: "rslatte-proj-gantt-overlay-full" });
      fullOv.style.left = `${labelColW}px`;
      fullOv.style.width = `${chartPxW}px`;
      fullOv.style.top = `${axisRow.offsetHeight}px`;
      fullOv.style.bottom = "0";
      for (const g of groupedMarkers) {
        const line = fullOv.createDiv({ cls: `rslatte-proj-gantt-ms-line rslatte-proj-gantt-ms-line--${g.primaryKind}` });
        line.style.left = `${g.x * 100}%`;
        line.title = g.title;
      }
    }
  }

  /** Today 执行统计：切到「项目清单」主页签（非进度页签） */
  public async openProjectListTabFromStats(): Promise<void> {
    const sAny: any = this.plugin.settings as any;
    if (!sAny.projectPanel) sAny.projectPanel = {};
    sAny.projectPanel.mainTab = "list";
    await this.plugin.saveSettings();
    void this.render();
  }
}