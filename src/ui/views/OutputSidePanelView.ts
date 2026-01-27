import { ItemView, Notice, TFile, WorkspaceLeaf, normalizePath } from "obsidian";

import type RSLattePlugin from "../../main";
import { getUiHeaderButtonsVisibility } from "../helpers/uiHeaderButtons";
import type { OutputIndexItem, OutputTimelineTimeField, OutputTemplateDef } from "../../types/outputTypes";
import { CreateOutputDocModal } from "../modals/CreateOutputDocModal";
import { AddOutputTemplateModal } from "../modals/AddOutputTemplateModal";
import { normalizeRunSummaryForUi } from "../helpers/normalizeRunSummaryForUi";
import { createHeaderRow } from "../helpers/moduleHeader";

function statusIcon(status: string): string {
  switch ((status || "").trim()) {
    case "done": return "✅";
    case "cancelled": return "⛔";
    case "in-progress": return "▶";
    case "todo": return "⏸";
    default: return "•";
  }
}

function shortPath(path: string): string {
  const p = (path ?? "").replace(/\\/g, "/");
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return parts.slice(parts.length - 2).join("/");
}

function formatYmd(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatYmdHm(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

export class OutputSidePanelView extends ItemView {
  private _renderSeq = 0;

  constructor(leaf: WorkspaceLeaf, private plugin: RSLattePlugin) {
    super(leaf);
  }

  getViewType(): string {
    return "rslatte-outputpanel";
  }

  getDisplayText(): string {
    return "输出管理";
  }

  getIcon(): string {
    return "package";
  }

  async onOpen() {
    await this.render();
  }

  private async setOutputStatus(filePath: string, status: "todo" | "in-progress" | "done" | "cancelled"): Promise<void> {
    const af = this.app.vault.getAbstractFileByPath(filePath);
    if (!(af instanceof TFile)) {
      new Notice("未找到文件：" + filePath);
      return;
    }

    // 读取之前的状态，用于判断具体的 action
    let prevStatus: string = "";
    let hasStartDate = false;
    try {
      const cache = this.app.metadataCache.getFileCache(af);
      if (cache?.frontmatter) {
        prevStatus = String(cache.frontmatter.status ?? "").trim();
        hasStartDate = !!(cache.frontmatter.start || cache.frontmatter.start_time);
      }
    } catch {
      // ignore
    }

    const nowIso = new Date().toISOString();
    await this.app.fileManager.processFrontMatter(af, (fm) => {
      fm.status = status;

      // Keep the date field (done/cancelled) for friendly UI, and store full ISO in *_time.
      // Obsidian's properties panel may treat `done`/`cancelled` as a Date, so we store
      // the precise timestamp in `done_time` / `cancelled_time`.
      const ymd = nowIso.slice(0, 10);

      // === status-specific timestamp rules ===
      if (status === "in-progress") {
        // start/start_time: only write if missing/empty
        const startVal = String((fm as any).start ?? "").trim();
        const startTimeVal = String((fm as any).start_time ?? "").trim();
        if (!startVal) (fm as any).start = ymd;
        if (!startTimeVal) (fm as any).start_time = nowIso;
      }

      if (status === "todo") {
        // no timestamp updates; just status
      }

      if (status === "done") {
        // done/done_time: always override latest value
        (fm as any).done = ymd;
        (fm as any).done_time = nowIso;
      }

      if (status === "cancelled") {
        // cancelled/cancelled_time: always override latest value
        (fm as any).cancelled = ymd;
        (fm as any).cancelled_time = nowIso;
      }

      // === cleanup legacy keys (keep start/start_time when toggling other statuses) ===
      // done legacy
      delete (fm as any).done_date;
      delete (fm as any).doneDate;
      delete (fm as any).completed_time;
      delete (fm as any).completed_date;
      delete (fm as any).completed;

      // cancelled legacy
      delete (fm as any).cancelled_date;
      delete (fm as any).cancel_time;
      delete (fm as any).cancel_date;
      delete (fm as any).deleted_time;
      delete (fm as any).delete_time;
      delete (fm as any).deleted_date;
      delete (fm as any).delete_date;
    });

    // ✅ 等待 metadataCache 更新（processFrontMatter 是异步的，但 metadataCache 更新可能需要一点时间）
    // Obsidian MetadataCache 没有 read 方法，需用 trigger('changed') 方案
    // 强制触发 metadataCache 重新读取文件
    this.app.metadataCache.trigger("changed", af);

    // 再等待一小段时间确保缓存已更新
    await new Promise(resolve => setTimeout(resolve, 50));

    // Refresh output index for immediate UI update
    try {
      await this.plugin.outputRSLatte?.upsertFile(af);
    } catch {
      // ignore
    }

    // If DB sync is enabled, a manual refresh will trigger sync; do it directly for better responsiveness.
    const enableDbSync = !!this.plugin.settings.outputPanel?.enableDbSync;
    if (enableDbSync) {
      const reason = status === "done" ? "mark_done" : status === "cancelled" ? "mark_cancelled" : status === "in-progress" ? "mark_in_progress" : "mark_todo";
      await this.plugin.syncOutputFilesToDb({ reason });
    } else {
      await ((this.plugin as any).writeTodayOutputProgressToJournalFromIndex?.() ?? Promise.resolve());
    }

    // ✅ Work Event (success only)
    // 根据状态变更拆解为具体的 action
    let action: string;
    if (status === "done") {
      action = "done";
    } else if (status === "cancelled") {
      action = "cancelled";
    } else if (status === "in-progress") {
      // 判断是 start 还是 continued
      // 如果之前是 todo 且从未开始过（没有 start/start_time），则是 start（首次开始）
      // 否则是 continued（继续/恢复进行中）
      if (prevStatus === "todo" && !hasStartDate) {
        action = "start"; // 首次开始
      } else {
        action = "continued"; // 继续（恢复进行中）
      }
    } else {
      // status === "todo"
      // 判断是 paused 还是 recover
      // 如果之前是 in-progress，则是 paused（暂停）
      // 如果之前是 done 或 cancelled，则是 recover（恢复待办）
      if (prevStatus === "in-progress") {
        action = "paused"; // 暂停
      } else {
        action = "recover"; // 恢复待办
      }
    }
    
    void this.plugin.workEventSvc?.append({
      ts: nowIso,
      kind: "output",
      action: action as any,
      source: "ui",
      ref: {
        file_path: filePath,
        status,
      },
      summary: `${status === "done" ? "✅ 输出完成" : status === "cancelled" ? "⛔ 输出取消" : status === "in-progress" ? "▶ 输出进行中" : "⏸ 输出待办"} ${af.basename}`,
    });

    // ✅ 重新渲染前，确保索引已更新（清除缓存后重新获取快照）
    await this.plugin.outputRSLatte?.getSnapshot();
    await this.render();
  }

  async render() {
    const seq = ++this._renderSeq;
    const container = this.contentEl;
    container.empty();
    container.addClass("rslatte-sidepanel");

    // ===== Module enable/disable =====
    // UI 优先读取 settings.moduleEnabledV2.output，避免与 legacy 合并逻辑串扰
    const normalizeBool = (v: any, fallback: boolean): boolean => {
      if (v === true || v === "true" || v === 1 || v === "1") return true;
      if (v === false || v === "false" || v === 0 || v === "0") return false;
      if (typeof v === "boolean") return v;
      return fallback;
    };

    const me2: any = (this.plugin.settings as any)?.moduleEnabledV2 ?? {};
    const enabled = normalizeBool(me2.output, this.plugin.isPipelineModuleEnabled("output"));

    // 模块关闭时：侧边栏内容完全不渲染（不显示“已关闭”提示占位）
    if (!enabled) return;

    const settings = this.plugin.settings.outputPanel || ({} as any);

    // ===== Header =====
    const outputHeaderSection = container.createDiv({ cls: "rslatte-section" });
    const { left: outputHeaderLeft, right: outputHeaderActions } = createHeaderRow(
      outputHeaderSection,
      "rslatte-section-title-row",
      "rslatte-section-title-left",
      "rslatte-task-actions",
    );
    outputHeaderLeft.createEl("h3", { text: "📤 输出管理" });
    const outInd = (this.plugin as any).getDbSyncIndicator?.("output");
    if (outInd) {
      const dot = outputHeaderLeft.createEl("span", { text: outInd.icon, cls: "rslatte-project-sync" });
      dot.title = outInd.title;
    }

    // 新增输出文档模板按钮
    const addTemplateBtn = outputHeaderActions.createEl("button", { text: "➕", cls: "rslatte-icon-btn" });
    addTemplateBtn.title = "新增输出文档模板";
    if (!enabled) {
      addTemplateBtn.disabled = true;
    } else {
      addTemplateBtn.onclick = () => {
        new AddOutputTemplateModal(this.app, this.plugin).open();
      };
    }

    const outBtnVis = getUiHeaderButtonsVisibility(this.plugin.settings, "output");

        if (outBtnVis.rebuild) {
      const rebuildBtn = outputHeaderActions.createEl("button", { text: "🧱", cls: "rslatte-icon-btn" });
          rebuildBtn.title = "扫描重建输出文档索引（全量）";
          if (!enabled) {
            rebuildBtn.disabled = true;
          } else {
            rebuildBtn.onclick = () => void this.manualRebuild();
          }
    }

    if (outBtnVis.archive) {
      const archiveBtn = outputHeaderActions.createEl("button", { text: "🗄", cls: "rslatte-icon-btn" });
          archiveBtn.title = "归档（DONE 且超过阈值天数的输出文档）";
          if (!enabled) {
            archiveBtn.disabled = true;
          } else {
            archiveBtn.onclick = () => void this.manualArchive();
          }
    }

    if (outBtnVis.refresh) {
      const refreshBtn = outputHeaderActions.createEl("button", { text: "🔄", cls: "rslatte-icon-btn" });
          refreshBtn.title = "刷新输出文档索引（开启与数据库同步后会同时触发同步）";
          if (!enabled) {
            refreshBtn.disabled = true;
          } else {
            refreshBtn.onclick = () => void this.manualRefresh();
          }
    }
    // ===== Quick Create Buttons =====
    const tplSection = container.createDiv({ cls: "rslatte-section" });
    const tplWrap = tplSection.createDiv({ cls: "rslatte-btn-wrap" });

    const tpls: OutputTemplateDef[] = (settings.templates ?? []).filter((x: any) => x && (x.buttonName || x.docCategory));
    if (!tpls.length) {
      const hint = tplSection.createDiv({ cls: "rslatte-muted" });
      hint.setText("（未配置输出文档模板清单，请先到设置中添加）");
    } else {
      for (const tpl of tpls) {
        const btn = tplWrap.createEl("button", { text: tpl.buttonName || tpl.docCategory, cls: "rslatte-link" });
        btn.onclick = () => this.openCreateModal(tpl);
      }
    }

    // ===== 输出文档列表（分成三个清单） =====
    // ✅ 使用 full 模式：索引包含 done/cancelled，以便「已完成」「取消」清单能正常展示
    // 直接调用 refreshIndexNow 确保数据正确（避免使用旧的 active 模式快照）
    await this.plugin.outputRSLatte?.refreshIndexNow({ mode: "full" });
    
    const snap = await this.plugin.outputRSLatte?.getSnapshot();
    if (seq !== this._renderSeq) return;

    const timeField: OutputTimelineTimeField = settings.timelineTimeField || "mtime";
    const maxItems = Math.max(1, Math.min(50, Number(settings.maxItems ?? 20)));

    // ✅ refreshIndexNow({ mode: "full" }) 会自动调用 archiveIndexForArchivedFiles() 清理主索引
    // 所以主索引中只包含未归档的文件，不需要在 UI 层再做过滤
    const itemsAll = (snap?.items ?? []) as OutputIndexItem[];

    // Sort by the configured field (descending)
    const score = (it: OutputIndexItem): number => {
      switch (timeField) {
        case "create": {
          const day = (it.createDate ?? "").slice(0, 10);
          if (day) return new Date(day + "T00:00:00").getTime();
          return it.ctimeMs ?? 0;
        }
        case "done": {
          const day = (it.doneDate ?? "").slice(0, 10);
          if (day) return new Date(day + "T00:00:00").getTime();
          return 0;
        }
        case "mtime":
        default:
          return it.mtimeMs ?? 0;
      }
    };

    // 分类输出
    const inProgressItems = itemsAll.filter((it) => {
      const st = String(it.status ?? "todo").trim();
      return st === "in-progress" || st === "todo";
    }).sort((a, b) => score(b) - score(a)).slice(0, maxItems);

    const doneItems = itemsAll.filter((it) => {
      const st = String(it.status ?? "todo").trim();
      return st === "done";
    }).sort((a, b) => score(b) - score(a)).slice(0, maxItems);

    const cancelledItems = itemsAll.filter((it) => {
      const st = String(it.status ?? "todo").trim();
      return st === "cancelled";
    }).sort((a, b) => score(b) - score(a)).slice(0, maxItems);

    // ===== 进行中的输出清单 =====
    const inProgressListWrap = container.createDiv({ cls: "rslatte-section rslatte-project-section" });
    const inProgressHeader = inProgressListWrap.createDiv({ cls: "rslatte-section-title-row" });
    
    // 读取折叠状态（默认展开）
    const inProgressCollapsed = (settings as any).outputPanel?.inProgressListCollapsed ?? false;
    
    // 折叠图标和标题
    const inProgressCollapsedIcon = inProgressHeader.createSpan({ 
      cls: "rslatte-stats-collapse-icon", 
      text: inProgressCollapsed ? "▶" : "▼" 
    });
    const inProgressTitleEl = inProgressHeader.createEl("h4", { text: "进行中", cls: "rslatte-section-subtitle" });
    inProgressHeader.style.cursor = "pointer";
    
    // 点击标题切换折叠状态
    inProgressHeader.onclick = () => {
      const newCollapsed = !inProgressCollapsed;
      if (!(settings as any).outputPanel) {
        (settings as any).outputPanel = {};
      }
      (settings as any).outputPanel.inProgressListCollapsed = newCollapsed;
      void this.plugin.saveSettings();
      void this.render();
    };
    
    // 输出列表容器
    const inProgressContainer = inProgressListWrap.createDiv();
    if (inProgressCollapsed) {
      inProgressContainer.style.display = "none";
    }
    
    if (!inProgressItems.length) {
      inProgressContainer.createDiv({ cls: "rslatte-task-empty", text: "（暂无进行中的输出）" });
    } else {
      this.renderTimeline(inProgressContainer, inProgressItems, timeField);
    }

    // ===== 已完成的输出清单 =====
    const doneListWrap = container.createDiv({ cls: "rslatte-section rslatte-project-section" });
    const doneHeader = doneListWrap.createDiv({ cls: "rslatte-section-title-row" });
    
    // 读取折叠状态（默认收起）
    const doneCollapsed = (settings as any).outputPanel?.doneListCollapsed ?? true;
    
    // 折叠图标和标题
    const doneCollapsedIcon = doneHeader.createSpan({ 
      cls: "rslatte-stats-collapse-icon", 
      text: doneCollapsed ? "▶" : "▼" 
    });
    const doneTitleEl = doneHeader.createEl("h4", { text: "已完成", cls: "rslatte-section-subtitle" });
    doneHeader.style.cursor = "pointer";
    
    // 点击标题切换折叠状态
    doneHeader.onclick = () => {
      const newCollapsed = !doneCollapsed;
      if (!(settings as any).outputPanel) {
        (settings as any).outputPanel = {};
      }
      (settings as any).outputPanel.doneListCollapsed = newCollapsed;
      void this.plugin.saveSettings();
      void this.render();
    };
    
    // 输出列表容器
    const doneContainer = doneListWrap.createDiv();
    if (doneCollapsed) {
      doneContainer.style.display = "none";
    }
    
    if (!doneItems.length) {
      doneContainer.createDiv({ cls: "rslatte-task-empty", text: "（暂无已完成的输出）" });
    } else {
      this.renderTimeline(doneContainer, doneItems, timeField);
    }

    // ===== 取消的输出清单 =====
    const cancelledListWrap = container.createDiv({ cls: "rslatte-section rslatte-project-section" });
    const cancelledHeader = cancelledListWrap.createDiv({ cls: "rslatte-section-title-row" });
    
    // 读取折叠状态（默认收起）
    const cancelledCollapsed = (settings as any).outputPanel?.cancelledListCollapsed ?? true;
    
    // 折叠图标和标题
    const cancelledCollapsedIcon = cancelledHeader.createSpan({ 
      cls: "rslatte-stats-collapse-icon", 
      text: cancelledCollapsed ? "▶" : "▼" 
    });
    const cancelledTitleEl = cancelledHeader.createEl("h4", { text: "取消", cls: "rslatte-section-subtitle" });
    cancelledHeader.style.cursor = "pointer";
    
    // 点击标题切换折叠状态
    cancelledHeader.onclick = () => {
      const newCollapsed = !cancelledCollapsed;
      if (!(settings as any).outputPanel) {
        (settings as any).outputPanel = {};
      }
      (settings as any).outputPanel.cancelledListCollapsed = newCollapsed;
      void this.plugin.saveSettings();
      void this.render();
    };
    
    // 输出列表容器
    const cancelledContainer = cancelledListWrap.createDiv();
    if (cancelledCollapsed) {
      cancelledContainer.style.display = "none";
    }
    
    if (!cancelledItems.length) {
      cancelledContainer.createDiv({ cls: "rslatte-task-empty", text: "（暂无取消的输出）" });
    } else {
      this.renderTimeline(cancelledContainer, cancelledItems, timeField);
    }
  }

  public refresh() {
    void this.render();
  }

  private async manualRefresh(): Promise<void> {
    new Notice("开始刷新：输出…");
    const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "output", "manual_refresh");
    if (!r.ok) {
      new Notice(`刷新失败：${r.error.message}（module=output, mode=manual_refresh）`);
      console.warn('[RSLatte][ui] runE2 failed', { moduleKey: "output", mode: "manual_refresh", error: r.error });
      return;
    }
    if (!r.data.skipped) {
      const runId = (r.data as any).runId ? ` (${(r.data as any).runId})` : "";
      new Notice(`输出索引已刷新${runId}`);
    }
    this.refresh();
  }

  private async manualRebuild(): Promise<void> {
    new Notice("开始扫描重建：输出…");
    const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "output", "rebuild");
    if (!r.ok) {
      new Notice(`重建失败：${r.error.message}（module=output, mode=rebuild）`);
      console.warn('[RSLatte][ui] runE2 failed', { moduleKey: "output", mode: "rebuild", error: r.error });
      return;
    }
    if (!r.data.skipped) {
      const runId = (r.data as any).runId ? ` (${(r.data as any).runId})` : "";
      new Notice(`输出索引已重建${runId}`);
    }
    this.refresh();
  }

  private async manualArchive(): Promise<void> {
    new Notice("开始归档：输出…");
    const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "output", "manual_archive");
    if (!r.ok) {
      new Notice(`归档失败：${r.error.message}（module=output, mode=manual_archive）`);
      console.warn('[RSLatte][ui] runE2 failed', { moduleKey: "output", mode: "manual_archive", error: r.error });
      return;
    }
    if (!r.data.skipped) {
      const ui = normalizeRunSummaryForUi(r.data);
      const n = Number(ui.archivedCount ?? 0);
      const runId = (r.data as any).runId ? ` (${(r.data as any).runId})` : "";
      if (n > 0) new Notice(`输出已归档：${n} 项${runId}`);
      else new Notice(`输出无可归档项${runId}`);
    }
    // ✅ 归档后，从索引中移除已归档的文件，并归档索引信息
    await this.plugin.outputRSLatte?.archiveIndexForArchivedFiles?.();
    await this.plugin.outputRSLatte?.refreshIndexNow({ mode: "full" });
    this.refresh();
  }

  private openCreateModal(tpl: OutputTemplateDef) {
    new CreateOutputDocModal(this.app, this.plugin, tpl).open();
  }

  private renderTimeline(parent: HTMLElement, items: OutputIndexItem[], timeField: OutputTimelineTimeField) {
    const wrap = parent.createDiv({ cls: "rslatte-timeline" });

    let currentYear: string | null = null;
    let currentDay: string | null = null;
    let daySectionEl: HTMLElement | null = null;

    const pickDayKey = (it: OutputIndexItem): string | null => {
      const k = this.plugin.outputRSLatte?.pickTimelineDayKey(it, timeField);
      return k ?? null;
    };

    const formatDayHeader = (dayKey: string): string => {
      try {
        // @ts-ignore
        const moment = (window as any).moment;
        if (typeof moment === "function") {
          const mm = moment(dayKey, "YYYY-MM-DD", true);
          if (mm?.isValid?.()) return mm.format("YYYY-MM-DD (ddd)");
        }
      } catch {}
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

    for (const it of items) {
      const dayKey = pickDayKey(it);
      if (dayKey) ensureYearHeader(dayKey.slice(0, 4));
      ensureDaySection(dayKey);

      const itemsWrap = daySectionEl!.querySelector<HTMLElement>(".rslatte-timeline-day-items")!;
      this.renderTimelineItem(itemsWrap, it);
    }
  }

  private renderTimelineItem(parent: HTMLElement, it: OutputIndexItem) {
    const row = parent.createDiv({ cls: "rslatte-timeline-item" });
    row.tabIndex = 0;

    const gutter = row.createDiv({ cls: "rslatte-timeline-gutter" });
    const dot = gutter.createDiv({ cls: "rslatte-timeline-dot" });
    dot.setText(statusIcon(String(it.status ?? "todo")));
    gutter.createDiv({ cls: "rslatte-timeline-line" });

    const content = row.createDiv({ cls: "rslatte-timeline-content" });

    const titleRow = content.createDiv({ cls: "rslatte-timeline-title-row" });
    const title = titleRow.createDiv({ cls: "rslatte-timeline-text" });
    title.setText(it.title);

    const actions = titleRow.createDiv({ cls: "rslatte-output-actions" });
    const st = String(it.status ?? "todo");

    const mkBtn = (
      icon: string,
      title: string,
      next: "todo" | "in-progress" | "done" | "cancelled",
    ) => {
      const b = actions.createEl("button", { text: icon, cls: "rslatte-text-btn" });
      b.title = title;
      b.onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        void this.setOutputStatus(it.filePath, next);
      };
      return b;
    };

    // Button visibility + order rules:
    // - done: ▶ ⏸
    // - cancelled: ▶ ⏸
    // - in-progress: ⏸ ⛔ ✅
    // - todo: ▶ ⛔
    if (st === "done" || st === "cancelled") {
      mkBtn("▶", "进行中（status=in-progress；若 start/start_time 缺失则写入）", "in-progress");
      mkBtn("⏸", "恢复待办（status=todo）", "todo");
    } else if (st === "in-progress") {
      mkBtn("⏸", "暂停/恢复待办（status=todo）", "todo");
      mkBtn("⛔", "取消（status=cancelled；写入 cancelled 时间戳）", "cancelled");
      mkBtn("✅", "完成（status=done；写入 done 时间戳）", "done");
    } else {
      // todo / default
      mkBtn("▶", "进行中（status=in-progress；若 start/start_time 缺失则写入）", "in-progress");
      mkBtn("⛔", "取消（status=cancelled；写入 cancelled 时间戳）", "cancelled");
    }

    const meta = content.createDiv({ cls: "rslatte-timeline-meta" });
    const domains = (it.domains ?? []).join(", ");

    const create = it.createDate || formatYmd(it.ctimeMs);
    const mtime = formatYmdHm(it.mtimeMs);

    const parts: string[] = [];
    if (create) parts.push(`创建 ${create}`);
    if (mtime) parts.push(`修改 ${mtime}`);
    if (domains) parts.push(`领域 ${domains}`);
    if (it.status) parts.push(`状态 ${it.status}`);
    if (it.type) parts.push(`type ${it.type}`);

    meta.setText(parts.join(" · "));

    const from = content.createDiv({ cls: "rslatte-timeline-from" });
    from.setText(shortPath(it.filePath));

    const open = async () => {
      try {
        const af = this.app.vault.getAbstractFileByPath(it.filePath);
        if (!(af instanceof TFile)) {
          new Notice(`文件不存在：${it.filePath}`);
          return;
        }
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(af, { active: true });
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