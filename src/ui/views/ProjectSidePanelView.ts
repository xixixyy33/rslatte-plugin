import { ItemView, Notice, TFile, TFolder, WorkspaceLeaf, normalizePath } from "obsidian";
import type RSLattePlugin from "../../main";
import { getUiHeaderButtonsVisibility } from "../helpers/uiHeaderButtons";
import { VIEW_TYPE_PROJECTS } from "../../constants/viewTypes";
import { AddProjectModal } from "../modals/AddProjectModal";
import { AddProjectMilestoneModal } from "../modals/AddProjectMilestoneModal";
import { AddProjectTaskModal } from "../modals/AddProjectTaskModal";
import { CreateProjectArchiveDocModal } from "../modals/CreateProjectArchiveDocModal";
import { EditProjectModal } from "../modals/EditProjectModal";
import { EditProjectMilestoneModal } from "../modals/EditProjectMilestoneModal";
import { EditProjectTaskModal } from "../modals/EditProjectTaskModal";
import type { ProjectEntry, MilestoneProgress, ProjectTaskItem } from "../../projectManager/types";
import { DEFAULT_MILESTONE_PATH, resolveEffectiveMilestonePath } from "../../projectManager/parser";
import { normalizeRunSummaryForUi } from "../helpers/normalizeRunSummaryForUi";
import { renderTextWithContactRefs } from "../helpers/renderTextWithContactRefs";
import { createHeaderRow } from "../helpers/moduleHeader";

export class ProjectSidePanelView extends ItemView {
  private plugin: RSLattePlugin;
  private _renderSeq = 0;

  /** project tasklist expand state: key = projectId (stable) */
  private _expandedProjectTasklists = new Set<string>();
  /** milestone expand state: key = `${projectId}::${milestoneName}` */
  private _expandedMilestones = new Set<string>();
  /** archive files list expand state: key = projectId (stable) */
  private _expandedArchiveFiles = new Set<string>();

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
    this._expandedArchiveFiles.clear();
    
    // 立即渲染视图（显示当前数据或"加载中"状态），不等待数据加载，避免阻塞知识库启动
    await this.render();
    
    // 不再自动触发后台加载，避免阻塞知识库启动
    // 用户可以通过点击刷新按钮手动刷新数据
  }

  async onClose() {
    // nothing
  }


  public refresh() {
    void this.render();
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

    projectHeaderLeft.createEl("h3", { text: "📁 项目管理" });

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
          archiveBtn.title = "归档已完成/已取消项目";
          if (!projectEnabled) {
            archiveBtn.disabled = true;
          } else {
            archiveBtn.onclick = async () => {
              new Notice("开始归档：项目…");
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

    // ===== 进行中的项目清单 =====
    const inProgressListWrap = container.createDiv({ cls: "rslatte-section rslatte-project-section" });
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
          const projects = (snap.projects ?? []).filter((p) => {
            const st = String(p.status ?? "").trim();
            return st !== "done" && st !== "cancelled";
          });

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
    const doneListWrap = container.createDiv({ cls: "rslatte-section rslatte-project-section" });
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
        const doneProjects = (snap.projects ?? []).filter((p) => {
          const st = String(p.status ?? "").trim();
          return st === "done";
        });

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

    // ✅ 取消项目清单（始终显示，独立于主列表的加载状态）
    const cancelledListWrap = container.createDiv({ cls: "rslatte-section rslatte-project-section" });
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
        const cancelledProjects = (snap.projects ?? []).filter((p) => {
          const st = String(p.status ?? "").trim();
          return st === "cancelled";
        });

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

  private renderProject(parent: HTMLElement, p: ProjectEntry) {
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

    // DB sync indicator (best-effort) - placed near title
    const moduleDbSyncEnabled = (() => {
  try {
    const fn = (this.plugin as any).isProjectDbSyncEnabled;
    return typeof fn === "function" ? !!fn.call(this.plugin) : false;
  } catch {
    return false;
  }
})();

// DB sync indicator (best-effort) - placed near title
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

    const editBtn = nameWrap.createEl("button", { text: "⚙", cls: "rslatte-icon-btn" });
    editBtn.title = "修改项目信息";
    editBtn.onclick = () => {
      new EditProjectModal(this.app, { projectName: p.projectName, dueYmd: p.due }, async (r) => {
        try {
          await this.plugin.projectMgr.updateProjectInfo(p.folderPath, { projectName: r.projectName, dueYmd: r.dueYmd });
          new Notice("已更新项目信息");
          this.refresh();
        } catch (e: any) {
          new Notice(`操作失败：${e?.message ?? String(e)}`);
        }
      }).open();
    };

    headRow.createDiv({ cls: "rslatte-proj-status-text", text: String(p.status ?? "") });

    // ===== Row 2: 功能按钮（靠右） =====
    const actionsRow = card.createDiv({ cls: "rslatte-proj-actions" });

    const msBtn = actionsRow.createEl("button", { text: "➕", cls: "rslatte-icon-btn" });
    msBtn.title = "添加里程碑";
    msBtn.onclick = () => new AddProjectMilestoneModal(this.app, this.plugin, p.folderPath).open();

    const chartBtn = actionsRow.createEl("button", { text: "📊", cls: "rslatte-icon-btn" });
    chartBtn.title = "打开项目分析图";
    chartBtn.onclick = () => {
      const path = p.analysisFilePath;
      if (!path) {
        new Notice("未找到项目分析图文件");
        return;
      }
      const af = this.app.vault.getAbstractFileByPath(path);
      if (af instanceof TFile) void this.app.workspace.getLeaf(true).openFile(af);
      else new Notice("未找到项目分析图文件");
    };

    const archiveDocBtn = actionsRow.createEl("button", { text: "📄", cls: "rslatte-icon-btn" });
    archiveDocBtn.title = "创建项目存档文件";
    archiveDocBtn.onclick = () => {
      const tpls = (this.plugin.settings.projectArchiveTemplates ?? []).filter((t: any) => !!String(t?.targetRelPath ?? "").trim());
      if (!tpls.length) {
        new Notice("未配置‘项目存档文件模板清单’，请先到设置 → 项目管理中添加");
        return;
      }
      new CreateProjectArchiveDocModal(this.app, this.plugin, { folderPath: p.folderPath, projectName: p.projectName }, tpls as any).open();
    };

    const cancelBtn = actionsRow.createEl("button", { text: "❌", cls: "rslatte-icon-btn" });
    cancelBtn.title = "取消项目";
    cancelBtn.onclick = async () => {
      try {
        await this.plugin.projectMgr.markCancelled(p.folderPath);
        new Notice("项目已取消");
        this.refresh();
      } catch (e: any) {
        new Notice(`操作失败：${e?.message ?? String(e)}`);
      }
    };

    const doneBtn = actionsRow.createEl("button", { text: "✅", cls: "rslatte-icon-btn" });
    doneBtn.title = "完成项目";
    doneBtn.onclick = async () => {
      try {
        await this.plugin.projectMgr.markDone(p.folderPath);
        new Notice("项目已完成");
        this.refresh();
      } catch (e: any) {
        new Notice(`操作失败：${e?.message ?? String(e)}`);
      }
    };

    // meta row
    const meta = card.createDiv({ cls: "rslatte-project-meta" });
    const parts: string[] = [];
    if (p.create) parts.push(`create ${p.create}`);
    if (p.due) parts.push(`due ${p.due}`);
    if (p.start) parts.push(`start ${p.start}`);
    if (parts.length) meta.setText(parts.join(" · "));

    const msWrap = card.createDiv({ cls: "rslatte-project-milestones" });
    if (!p.milestones?.length) {
      msWrap.createDiv({ cls: "rslatte-project-empty", text: "（暂无里程碑）" });
    } else {
      this.renderMilestonesTree(msWrap, p);
    }

    // 项目存档文件清单（可折叠，默认折叠）
    this.renderArchiveFilesList(card, p);
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

    // DB sync indicator (best-effort) - placed near title
    const moduleDbSyncEnabled = (() => {
  try {
    const fn = (this.plugin as any).isProjectDbSyncEnabled;
    return typeof fn === "function" ? !!fn.call(this.plugin) : false;
  } catch {
    return false;
  }
})();

// DB sync indicator (best-effort) - placed near title
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

    const editBtn = nameWrap.createEl("button", { text: "⚙", cls: "rslatte-icon-btn" });
    editBtn.title = "修改项目信息";
    editBtn.onclick = () => {
      new EditProjectModal(this.app, { projectName: p.projectName, dueYmd: p.due }, async (r) => {
        try {
          await this.plugin.projectMgr.updateProjectInfo(p.folderPath, { projectName: r.projectName, dueYmd: r.dueYmd });
          new Notice("已更新项目信息");
          this.refresh();
        } catch (e: any) {
          new Notice(`操作失败：${e?.message ?? String(e)}`);
        }
      }).open();
    };

    headRow.createDiv({ cls: "rslatte-proj-status-text", text: String(p.status ?? "") });

    // ===== Row 2: 功能按钮（靠右）包含恢复按钮 =====
    const actionsRow = card.createDiv({ cls: "rslatte-proj-actions" });

    const recoverBtn = actionsRow.createEl("button", { text: "🔄", cls: "rslatte-icon-btn" });
    recoverBtn.title = "恢复项目";
    recoverBtn.onclick = async () => {
      try {
        await this.plugin.projectMgr.recoverProject(p.folderPath);
        new Notice("项目已恢复");
        this.refresh();
      } catch (e: any) {
        new Notice(`操作失败：${e?.message ?? String(e)}`);
      }
    };

    const chartBtn = actionsRow.createEl("button", { text: "📊", cls: "rslatte-icon-btn" });
    chartBtn.title = "打开项目分析图";
    chartBtn.onclick = () => {
      const path = p.analysisFilePath;
      if (!path) {
        new Notice("未找到项目分析图文件");
        return;
      }
      const af = this.app.vault.getAbstractFileByPath(path);
      if (af instanceof TFile) void this.app.workspace.getLeaf(true).openFile(af);
      else new Notice("未找到项目分析图文件");
    };

    const archiveDocBtn = actionsRow.createEl("button", { text: "📄", cls: "rslatte-icon-btn" });
    archiveDocBtn.title = "创建项目存档文件";
    archiveDocBtn.onclick = () => {
      const tpls = (this.plugin.settings.projectArchiveTemplates ?? []).filter((t: any) => !!String(t?.targetRelPath ?? "").trim());
      if (!tpls.length) {
        new Notice("未配置'项目存档文件模板清单'，请先到设置 → 项目管理中添加");
        return;
      }
      new CreateProjectArchiveDocModal(this.app, this.plugin, { folderPath: p.folderPath, projectName: p.projectName }, tpls as any).open();
    };

    // meta row
    const meta = card.createDiv({ cls: "rslatte-project-meta" });
    const parts: string[] = [];
    if (p.create) parts.push(`create ${p.create}`);
    if (p.due) parts.push(`due ${p.due}`);
    if (p.start) parts.push(`start ${p.start}`);
    if (p.done) parts.push(`done ${p.done}`);
    if (parts.length) meta.setText(parts.join(" · "));

    // 显示里程碑和任务（和进行中的项目一样）
    const msWrap = card.createDiv({ cls: "rslatte-project-milestones" });
    if (!p.milestones?.length) {
      msWrap.createDiv({ cls: "rslatte-project-empty", text: "（暂无里程碑）" });
    } else {
      this.renderMilestonesTree(msWrap, p);
    }

    // 项目存档文件清单（可折叠，默认折叠）
    this.renderArchiveFilesList(card, p);
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

    // DB sync indicator (best-effort) - placed near title
    const moduleDbSyncEnabled = (() => {
      try {
        const fn = (this.plugin as any).isProjectDbSyncEnabled;
        return typeof fn === "function" ? !!fn.call(this.plugin) : false;
      } catch {
        return false;
      }
    })();

    // DB sync indicator (best-effort) - placed near title
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

    const editBtn = nameWrap.createEl("button", { text: "⚙", cls: "rslatte-icon-btn" });
    editBtn.title = "修改项目信息";
    editBtn.onclick = () => {
      new EditProjectModal(this.app, { projectName: p.projectName, dueYmd: p.due }, async (r) => {
        try {
          await this.plugin.projectMgr.updateProjectInfo(p.folderPath, { projectName: r.projectName, dueYmd: r.dueYmd });
          new Notice("已更新项目信息");
          this.refresh();
        } catch (e: any) {
          new Notice(`操作失败：${e?.message ?? String(e)}`);
        }
      }).open();
    };

    headRow.createDiv({ cls: "rslatte-proj-status-text", text: String(p.status ?? "") });

    // ===== Row 2: 功能按钮（靠右）包含恢复按钮 =====
    const actionsRow = card.createDiv({ cls: "rslatte-proj-actions" });

    const recoverBtn = actionsRow.createEl("button", { text: "🔄", cls: "rslatte-icon-btn" });
    recoverBtn.title = "恢复项目";
    recoverBtn.onclick = async () => {
      try {
        await this.plugin.projectMgr.recoverProject(p.folderPath);
        new Notice("项目已恢复");
        this.refresh();
      } catch (e: any) {
        new Notice(`操作失败：${e?.message ?? String(e)}`);
      }
    };

    const chartBtn = actionsRow.createEl("button", { text: "📊", cls: "rslatte-icon-btn" });
    chartBtn.title = "打开项目分析图";
    chartBtn.onclick = () => {
      const path = p.analysisFilePath;
      if (!path) {
        new Notice("未找到项目分析图文件");
        return;
      }
      const af = this.app.vault.getAbstractFileByPath(path);
      if (af instanceof TFile) void this.app.workspace.getLeaf(true).openFile(af);
      else new Notice("未找到项目分析图文件");
    };

    const archiveDocBtn = actionsRow.createEl("button", { text: "📄", cls: "rslatte-icon-btn" });
    archiveDocBtn.title = "创建项目存档文件";
    archiveDocBtn.onclick = () => {
      const tpls = (this.plugin.settings.projectArchiveTemplates ?? []).filter((t: any) => !!String(t?.targetRelPath ?? "").trim());
      if (!tpls.length) {
        new Notice("未配置'项目存档文件模板清单'，请先到设置 → 项目管理中添加");
        return;
      }
      new CreateProjectArchiveDocModal(this.app, this.plugin, { folderPath: p.folderPath, projectName: p.projectName }, tpls as any).open();
    };

    // meta row
    const meta = card.createDiv({ cls: "rslatte-project-meta" });
    const parts: string[] = [];
    if (p.create) parts.push(`create ${p.create}`);
    if (p.due) parts.push(`due ${p.due}`);
    if (p.start) parts.push(`start ${p.start}`);
    if (p.cancelled) parts.push(`cancelled ${p.cancelled}`);
    if (parts.length) meta.setText(parts.join(" · "));
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
      const msKey = `${key}::${name}`;
      const openTasks = items.filter(
        (it) => String(it.milestone ?? "").trim() === name && (it.statusName === "TODO" || it.statusName === "IN_PROGRESS")
      );
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
    // NOTE: Project sidebar only borrows the "timeline" visual style.
    // The actual order MUST stay the same as in the tasklist file.
    const row = parent.createDiv({ cls: "rslatte-timeline-item rslatte-project-task-item" });
    row.tabIndex = 0;
    // 添加标识属性，用于从其他视图跳转定位
    const taskFilePath = normalizePath(String(it.sourceFilePath ?? p.tasklistFilePath ?? "").trim());
    const taskLineNo = Number(it.lineNo ?? -1);
    if (taskFilePath) row.setAttribute("data-project-task-file-path", taskFilePath);
    if (taskLineNo >= 0) row.setAttribute("data-project-task-line-no", String(taskLineNo));

    const gutter = row.createDiv({ cls: "rslatte-timeline-gutter" });
    const dot = gutter.createDiv({ cls: "rslatte-timeline-dot" });
    dot.setText(this.projectTaskStatusIcon(it.statusName));
    // Keep the line for a consistent timeline look (even though we are not sorting by time).
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
    // Status action buttons: visibility + order follow the same strategy as Output panel
    // DONE: ▶ ⏸
    // CANCELLED: ▶ ⏸
    // IN_PROGRESS: ⏸ ⛔ ✅
    // TODO: ▶ ⛔
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

    // meta (no file name; keep compact)
    const meta = content.createDiv({ cls: "rslatte-timeline-meta rslatte-task-meta" });
    const created = String((it as any).createdDate ?? "—");
    const due = String((it as any).dueDate ?? "—");
    meta.setText(`创建 ${created} · 到期 ${due}`);

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

  private projectTaskStatusIcon(statusName?: ProjectTaskItem["statusName"]): string {
    switch (statusName) {
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
    return ["▶", "⛔"];
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

  private renderMilestonesTree(parent: HTMLElement, p: ProjectEntry) {
    const milestones = (p.milestones ?? []) as MilestoneProgress[];
    const allTasks = ((p as any).taskItems ?? []) as ProjectTaskItem[];

    // Build an index for effective-path resolution (cancelled/missing -> parent/default)
    const msIndex = new Map<string, { status?: "active" | "done" | "cancelled"; parentPath?: string }>();
    for (const m of milestones) {
      const path = String((m as any)?.path ?? (m as any)?.name ?? "").trim();
      if (!path) continue;
      msIndex.set(path, {
        status: (m as any)?.milestoneStatus as any,
        parentPath: String((m as any)?.parentPath ?? "").trim() || undefined,
      });
    }

    const effectivePathForTask = (it: ProjectTaskItem): string => {
      const raw = String((it as any).milestonePath ?? (it as any).milestone ?? "").trim();
      return resolveEffectiveMilestonePath(raw, msIndex);
    };

    // Ensure a default milestone node exists in UI when needed (e.g., top-level cancelled/deleted)
    let needDefault = false;
    for (const it of allTasks) {
      if (effectivePathForTask(it) === DEFAULT_MILESTONE_PATH) {
        needDefault = true;
        break;
      }
    }

    const merged: MilestoneProgress[] = [...milestones];
    if (needDefault || (!milestones.length && allTasks.length)) {
      merged.push({
        name: DEFAULT_MILESTONE_PATH,
        path: DEFAULT_MILESTONE_PATH,
        level: 1,
        parentPath: "",
        headingLineNo: 1e9,
        milestoneStatus: "active",
        done: 0,
        todo: 0,
        inprogress: 0,
        cancelled: 0,
        total: 0,
      } as any);
    }

    if (!merged.length) {
      parent.createDiv({ cls: "rslatte-project-empty", text: "（暂无里程碑）" });
      return;
    }


    // Keep the milestone order stable as in the source file.
    const sorted = [...merged].sort((a: any, b: any) => {
      const la = Number(a?.headingLineNo ?? 1e9);
      const lb = Number(b?.headingLineNo ?? 1e9);
      if (la !== lb) return la - lb;
      return String(a?.name ?? "").localeCompare(String(b?.name ?? ""), "zh-Hans-CN");
    });

    const allPaths = new Set<string>();
    for (const m of sorted) {
      const path = String((m as any)?.path ?? (m as any)?.name ?? "").trim();
      if (path) allPaths.add(path);
    }

    const childrenMap = new Map<string, MilestoneProgress[]>();
    const roots: MilestoneProgress[] = [];

    for (const m of sorted) {
      const path = String((m as any)?.path ?? (m as any)?.name ?? "").trim();
      if (!path) continue;
      const parentPath = String((m as any)?.parentPath ?? "").trim();
      if (parentPath && allPaths.has(parentPath)) {
        const arr = childrenMap.get(parentPath) ?? [];
        arr.push(m);
        childrenMap.set(parentPath, arr);
      } else {
        roots.push(m);
      }
    }

    for (const r of roots) {
      this.renderMilestoneNode(parent, p, r, childrenMap, msIndex, effectivePathForTask);
    }
  }

  /** Render one milestone node (row + expanded area), and recursively render its child milestones. */
  private renderMilestoneNode(
    parent: HTMLElement,
    p: ProjectEntry,
    m: MilestoneProgress,
    childrenMap: Map<string, MilestoneProgress[]>,
    _msIndex: Map<string, any>,
    effectivePathForTask: (it: ProjectTaskItem) => string
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
    const editMsBtn = actions.createEl("button", { text: "✏️", cls: "rslatte-icon-only-btn rslatte-ms-action" });
    editMsBtn.title = "修改里程碑";
    editMsBtn.onclick = (ev) => {
      ev.stopPropagation();
      new EditProjectMilestoneModal(this.app, this.plugin, p.folderPath, milestonePath).open();
    };

    if (msStatus === "active") {
      const doneBtn = actions.createEl("button", { text: "✅", cls: "rslatte-icon-only-btn rslatte-ms-action" });
      doneBtn.title = "标记里程碑完成";
      doneBtn.onclick = (ev) => {
        ev.stopPropagation();
        void this.plugin.projectMgr
          .setMilestoneStatus(p.folderPath, milestonePath, "done")
          .catch((e: any) => new Notice(`操作失败：${e?.message ?? String(e)}`));
      };

      const cancelBtn = actions.createEl("button", { text: "⛔", cls: "rslatte-icon-only-btn rslatte-ms-action" });
      cancelBtn.title = "取消里程碑";
      cancelBtn.onclick = (ev) => {
        ev.stopPropagation();
        void this.plugin.projectMgr
          .setMilestoneStatus(p.folderPath, milestonePath, "cancelled")
          .catch((e: any) => new Notice(`操作失败：${e?.message ?? String(e)}`));
      };
    } else {
      const restoreBtn = actions.createEl("button", { text: "⏸", cls: "rslatte-icon-only-btn rslatte-ms-action" });
      restoreBtn.title = "恢复里程碑";
      restoreBtn.onclick = (ev) => {
        ev.stopPropagation();
        void this.plugin.projectMgr
          .setMilestoneStatus(p.folderPath, milestonePath, "active")
          .catch((e: any) => new Notice(`操作失败：${e?.message ?? String(e)}`));
      };
    }

    // Add-task/milestone button (kept compact and aligned with other milestone buttons)
    const addTaskBtn = actions.createEl("button", { text: "➕", cls: "rslatte-icon-only-btn rslatte-ms-action" });
    addTaskBtn.title = "在该里程碑下新增任务或子里程碑";
    addTaskBtn.onclick = (ev) => {
      ev.stopPropagation();
      new AddProjectTaskModal(
        this.app,
        this.plugin,
        p.folderPath,
        milestonePath,
        level,
        milestonePath
      ).open();
    };

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

    if (!isOpen) return;

    const kids = childrenMap.get(milestonePath) ?? [];
    // Keep the task order EXACTLY the same as in the tasklist file: do NOT sort.
    const tasks = allTasks.filter((it) => effectivePathForTask(it) === milestonePath);

    const exp = node.createDiv({ cls: "rslatte-project-ms-expanded" });

    if (tasks.length) {
      const taskWrap = exp.createDiv({ cls: "rslatte-project-ms-tasks" });
      const tl = taskWrap.createDiv({ cls: "rslatte-timeline" });
      for (const it of tasks.slice(0, 30)) {
        this.renderProjectTaskTimelineItem(tl, p, it);
      }
      if (tasks.length > 30) {
        taskWrap.createDiv({ cls: "rslatte-task-empty", text: `（仅显示前 30 条，当前共 ${tasks.length} 条）` });
      }
    } else if (!kids.length) {
      exp.createDiv({ cls: "rslatte-task-empty", text: "（该里程碑下暂无任务）" });
    }

    if (kids.length) {
      const childWrap = exp.createDiv({ cls: "rslatte-project-ms-children" });
      for (const c of kids) {
        // Pass the milestone index map through recursion (avoid relying on outer-scope variables)
        this.renderMilestoneNode(childWrap, p, c, childrenMap, _msIndex, effectivePathForTask);
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

  /**
   * 定位并滚动到指定项目（用于从其他视图跳转）
   * @param projectIdOrFolderPath 项目 ID 或文件夹路径
   * @param milestonePath 可选的里程碑路径，如果提供则自动展开该里程碑及其所有父级里程碑
   * @param taskFilePath 可选的任务文件路径，如果提供则定位到具体的任务项
   * @param taskLineNo 可选的任务行号，如果提供则定位到具体的任务项
   */
  public async scrollToProject(projectIdOrFolderPath: string, milestonePath?: string, taskFilePath?: string, taskLineNo?: number): Promise<void> {
    // 确保视图已渲染
    await this.render();
    
    // 等待一小段时间确保 DOM 已更新
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // 规范化路径
    const normalizedPath = normalizePath(projectIdOrFolderPath);
    
    // 查找匹配的项目元素
    const container = this.containerEl.children[1];
    const allProjectCards = Array.from(container.querySelectorAll<HTMLElement>(".rslatte-project-card"));
    
    let target: HTMLElement | null = null;
    for (const card of allProjectCards) {
      const cardProjectId = card.getAttribute("data-project-id");
      const cardFolderPath = card.getAttribute("data-project-folder-path");
      
      // 优先匹配 projectId，其次匹配 folderPath
      if (cardProjectId === projectIdOrFolderPath || cardProjectId === normalizedPath) {
        target = card;
        break;
      }
      if (cardFolderPath && normalizePath(cardFolderPath) === normalizedPath) {
        target = card;
        break;
      }
    }
    
    if (!target) {
      // 如果找不到，尝试刷新视图后再找一次
      await this.render();
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const retryCards = Array.from(container.querySelectorAll<HTMLElement>(".rslatte-project-card"));
      for (const card of retryCards) {
        const cardProjectId = card.getAttribute("data-project-id");
        const cardFolderPath = card.getAttribute("data-project-folder-path");
        
        if (cardProjectId === projectIdOrFolderPath || cardProjectId === normalizedPath) {
          target = card;
          break;
        }
        if (cardFolderPath && normalizePath(cardFolderPath) === normalizedPath) {
          target = card;
          break;
        }
      }
      
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
            const normalizedProjectPath = normalizePath(projectIdOrFolderPath);
            const project = snap.projects.find((p: any) => {
              const pId = String(p.projectId ?? "").trim();
              const pPath = normalizePath(String(p.folderPath ?? "").trim());
              return pId === projectIdOrFolderPath || pId === normalizedPath || 
                     pPath === normalizedProjectPath || pPath === normalizedPath;
            });
            
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
        }
        
        // 重新渲染以显示展开的里程碑
        await this.render();
        await new Promise(resolve => setTimeout(resolve, 300));
        
        // 重新查找目标（因为重新渲染后 DOM 已更新）
        const containerAfterRender = this.containerEl.children[1];
        const cardsAfterRender = Array.from(containerAfterRender.querySelectorAll<HTMLElement>(".rslatte-project-card"));
        for (const card of cardsAfterRender) {
          const cardProjectId = card.getAttribute("data-project-id");
          const cardFolderPath = card.getAttribute("data-project-folder-path");
          if (cardProjectId === projectIdOrFolderPath || cardProjectId === normalizedPath ||
              (cardFolderPath && normalizePath(cardFolderPath) === normalizedPath)) {
            target = card;
            break;
          }
        }
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
            
            // 精确匹配
            if (normalizedItemPath === normalizedTaskFilePath && itemLineNoNum === taskLineNo) {
              return item;
            }
            
            // 如果路径匹配但行号不匹配，也尝试匹配（可能是行号有偏移）
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
            
            // 如果路径不完全匹配，尝试文件名匹配（处理路径中的特殊字符问题）
            const searchBasename = normalizedTaskFilePath.split(/[/\\]/).pop() || "";
            const itemBasename = normalizedItemPath.split(/[/\\]/).pop() || "";
            if (searchBasename && itemBasename && searchBasename === itemBasename && 
                Math.abs(itemLineNoNum - taskLineNo) <= 5) {
              if (this.plugin.isDebugLogEnabled()) {
                console.log(`[RSLatte][ProjectView] Found task by basename match:`, {
                  searchPath: normalizedTaskFilePath,
                  searchBasename,
                  itemPath: normalizedItemPath,
                  itemBasename,
                  searchLineNo: taskLineNo,
                  foundLineNo: itemLineNoNum,
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
          let retryTargetCard: HTMLElement | null = null;
          for (const card of cardsAfterRender) {
            const cardProjectId = card.getAttribute("data-project-id");
            const cardFolderPath = card.getAttribute("data-project-folder-path");
            if (cardProjectId === projectIdOrFolderPath || cardProjectId === normalizedPath ||
                (cardFolderPath && normalizePath(cardFolderPath) === normalizedPath)) {
              retryTargetCard = card;
              break;
            }
          }
          if (retryTargetCard) {
            taskTarget = findTaskItem(retryTargetCard);
          }
        }
        
        if (!taskTarget) {
          // 如果还是找不到，尝试在整个容器中查找（不限制在项目卡片内）
          const containerAfterRender = this.containerEl.children[1];
          taskTarget = findTaskItem(containerAfterRender as HTMLElement);
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

  /**
   * 获取项目的存档文件列表
   */
  private getProjectArchiveFiles(p: ProjectEntry): TFile[] {
    const archiveFiles: TFile[] = [];
    const templates = (this.plugin.settings.projectArchiveTemplates ?? []) as any[];
    if (!templates.length) return archiveFiles;

    const projectFolder = normalizePath(p.folderPath);
    const projectFolderObj = this.app.vault.getAbstractFileByPath(projectFolder);
    if (!projectFolderObj || !(projectFolderObj instanceof TFolder)) return archiveFiles;

    // 收集所有模板的目标目录路径
    const targetDirs = new Set<string>();
    for (const tpl of templates) {
      const relPath = String(tpl.targetRelPath ?? "").trim();
      if (!relPath) continue;
      // 替换模板变量
      const pn = p.projectName || "";
      let resolvedPath = relPath.replace(/\{\{projectName\}\}/g, pn).replace(/\{\{project\}\}/g, pn);
      resolvedPath = normalizePath(resolvedPath).replace(/^\/+|\/+$/g, "");
      if (resolvedPath) {
        const fullPath = normalizePath(`${projectFolder}/${resolvedPath}`);
        targetDirs.add(fullPath);
      }
    }

    // 扫描所有目标目录下的 .md 文件
    const allFiles = this.app.vault.getMarkdownFiles();
    for (const file of allFiles) {
      const filePath = normalizePath(file.path);
      // 检查文件是否在任何目标目录下
      for (const targetDir of targetDirs) {
        if (filePath.startsWith(targetDir + "/") || filePath === targetDir) {
          archiveFiles.push(file);
          break;
        }
      }
    }

    // 按修改时间倒序排序（最新的在前）
    archiveFiles.sort((a, b) => (b.stat.mtime || 0) - (a.stat.mtime || 0));
    return archiveFiles;
  }

  /**
   * 渲染项目存档文件清单（可折叠，默认折叠）
   */
  private renderArchiveFilesList(card: HTMLElement, p: ProjectEntry) {
    const key = String(p.projectId ?? p.folderPath ?? "").trim();
    if (!key) return;

    const archiveFiles = this.getProjectArchiveFiles(p);
    const isOpen = this._expandedArchiveFiles.has(key);

    const row = card.createDiv({ cls: "rslatte-milestone-row rslatte-project-archive-files-row" });
    const title = row.createDiv({ cls: "rslatte-milestone-title rslatte-milestone-title-clickable" });
    title.onclick = (ev) => {
      ev.stopPropagation();
      if (this._expandedArchiveFiles.has(key)) {
        this._expandedArchiveFiles.delete(key);
      } else {
        this._expandedArchiveFiles.add(key);
      }
      this.refresh();
    };

    const togg = title.createEl("button", {
      text: isOpen ? "▼" : "▶",
      cls: "rslatte-icon-only-btn rslatte-milestone-toggle",
    });
    togg.title = isOpen ? "收起存档文件清单" : "展开存档文件清单";
    togg.onclick = (ev) => {
      ev.stopPropagation();
      title.click();
    };

    title.createSpan({ text: "项目存档文件清单", cls: "rslatte-milestone-title-text" });

    const badge = row.createDiv({ cls: "rslatte-milestone-badge" });
    badge.setText(`${archiveFiles.length} 个文件`);

    if (!isOpen) return;

    const timeline = card.createDiv({ cls: "rslatte-timeline" });
    if (!archiveFiles.length) {
      timeline.createDiv({ cls: "rslatte-task-empty", text: "（暂无存档文件）" });
      return;
    }

    for (const file of archiveFiles) {
      const item = timeline.createDiv({ cls: "rslatte-timeline-item rslatte-archive-file-item" });
      item.tabIndex = 0;
      item.onclick = (ev) => {
        ev.stopPropagation();
        void this.app.workspace.getLeaf(false).openFile(file, { active: true });
      };

      // Timeline gutter with dot and line
      const gutter = item.createDiv({ cls: "rslatte-timeline-gutter" });
      const dot = gutter.createDiv({ cls: "rslatte-timeline-dot" });
      dot.setText("📄");
      gutter.createDiv({ cls: "rslatte-timeline-line" });

      // Timeline content
      const content = item.createDiv({ cls: "rslatte-timeline-content" });
      const titleRow = content.createDiv({ cls: "rslatte-timeline-title-row" });
      
      // 文件名（靠左）
      const link = titleRow.createEl("a", { 
        text: file.basename, 
        cls: "rslatte-timeline-text rslatte-archive-file-link",
        href: file.path 
      });
      link.title = file.path;
      link.onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        void this.app.workspace.getLeaf(false).openFile(file, { active: true });
      };

      // 文件所在目录（靠右，作为 meta）
      const projectPath = normalizePath(p.folderPath);
      const filePath = normalizePath(file.path);
      if (filePath.startsWith(projectPath + "/")) {
        const relPath = filePath.substring(projectPath.length + 1);
        // 提取目录部分（去掉文件名）
        const dirPath = relPath.includes("/") ? relPath.substring(0, relPath.lastIndexOf("/")) : "";
        if (dirPath) {
          const meta = content.createDiv({ cls: "rslatte-timeline-meta" });
          const dirSpan = meta.createSpan({ 
            text: dirPath, 
            cls: "rslatte-timeline-from"
          });
          dirSpan.title = file.path;
        }
      }
    }
  }
}