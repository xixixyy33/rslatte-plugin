import { App, ItemView, Notice, TFile, TFolder, WorkspaceLeaf, normalizePath } from "obsidian";

import type RSLattePlugin from "../../main";
import {
  collectMarkdownFilesUnderFolder,
  resolveKnowledgeLibraryRootRel,
} from "../../services/knowledgePaths";
import { VIEW_TYPE_KNOWLEDGE, VIEW_TYPE_KNOWLEDGE_PANEL, VIEW_TYPE_TASKS } from "../../constants/viewTypes";
import { getUiHeaderButtonsVisibility } from "../helpers/uiHeaderButtons";
import {
  isQuickCreateOutputTemplate,
  outputIndexItemIsProjectKind,
  type OutputIndexItem,
  type OutputListFilterMode,
  type OutputTimelineTimeField,
  type OutputTemplateDef,
} from "../../types/outputTypes";
import { localYmdFromInstant, outputDoneLocalYmd, toLocalOffsetIsoString } from "../../utils/localCalendarYmd";
import { CreateOutputDocModal } from "../modals/CreateOutputDocModal";
import { AddOutputTemplateModal } from "../modals/AddOutputTemplateModal";
import { ManageOutputTemplatesModal } from "../modals/ManageOutputTemplatesModal";
import { SetOutputWaitingModal } from "../modals/SetOutputWaitingModal";
import { EditOutputMetaModal } from "../modals/EditOutputMetaModal";
import { PublishToKnowledgeModal } from "../modals/PublishToKnowledgeModal";
import { RecallOutputFromKnowledgeModal } from "../modals/RecallOutputFromKnowledgeModal";
import { RecordTaskScheduleModal } from "../modals/RecordTaskScheduleModal";
import type { RSLatteIndexItem } from "../../taskRSLatte/types";
import { appendOutputStatusChangedLedgerEvent } from "../../outputRSLatte/outputHistoryLedger";
import { normalizeRunSummaryForUi } from "../helpers/normalizeRunSummaryForUi";
import { createHeaderRow } from "../helpers/moduleHeader";
import { plainTextFromTextWithContactRefsResolved } from "../helpers/renderTextWithContactRefs";

function fileOutputIdLower(app: App, f: TFile): string {
  try {
    const c = app.metadataCache.getFileCache(f);
    const raw = c?.frontmatter?.output_id;
    return raw != null ? String(raw).trim().toLowerCase() : "";
  } catch {
    return "";
  }
}


function statusIcon(status: string): string {
  switch ((status || "").trim()) {
    case "done": return "✅";
    case "cancelled": return "⛔";
    case "in-progress": return "▶";
    case "waiting_until": return "⏸";
    case "todo": return "☐";
    default: return "•";
  }
}

function shortPath(path: string): string {
  const p = (path ?? "").replace(/\\/g, "/");
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return parts.slice(parts.length - 2).join("/");
}

function tryGetFolderByPathLoose(app: App, p: string): TFolder | null {
  const raw = String(p ?? "").trim();
  if (!raw) return null;
  const candidates = Array.from(
    new Set([
      raw,
      normalizePath(raw),
      raw.replace(/^\.\/+/, ""),
      normalizePath(raw.replace(/^\.\/+/, "")),
      raw.replace(/^\/+/, ""),
      normalizePath(raw.replace(/^\/+/, "")),
    ].filter(Boolean)),
  );
  for (const c of candidates) {
    const af = app.vault.getAbstractFileByPath(c);
    if (af instanceof TFolder) return af;
  }
  return null;
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

function shortIso(s: unknown): string {
  const v = typeof s === "string" ? s.trim() : "";
  if (v.length >= 10) return v.slice(0, 10);
  return "";
}

function normalizeVaultPath(p: unknown): string {
  return normalizePath(String(p ?? "").trim());
}

type OutputCopyRecord = {
  copiedYmd: string;
  bucketLabel: string;
  knowledgePath: string;
};

export class OutputSidePanelView extends ItemView {
  private _renderSeq = 0;
  // 折叠状态：会话内记忆；每次视图重新打开时重置为默认值
  private _inProgressCollapsed = false;
  private _doneGeneralCollapsed = false;
  private _doneProjectCollapsed = true;
  private _cancelledCollapsed = true;
  /** 「发布管理」页签内搜索关键字（仅内存，不写入设置） */
  private _knowledgePublishSearch = "";
  /** 搜索输入草稿：仅回车时提交到 _knowledgePublishSearch */
  private _knowledgePublishSearchDraft = "";
  /** 独立按 `output_id` 精确匹配（有值时优先于综合搜索） */
  private _knowledgePublishOutputId = "";
  /** output_id 输入草稿：仅回车时提交到 _knowledgePublishOutputId */
  private _knowledgePublishOutputIdDraft = "";
  private _copyRecordMap = new Map<string, OutputCopyRecord[]>();

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
    // 每次打开侧栏（含重开 Obsidian 后首次打开）都回到默认展开策略
    this._inProgressCollapsed = false;
    this._doneGeneralCollapsed = false;
    this._doneProjectCollapsed = true;
    this._cancelledCollapsed = true;
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
    let outputIdForLedger = "";
    try {
      const cache = this.app.metadataCache.getFileCache(af);
      if (cache?.frontmatter) {
        prevStatus = String(cache.frontmatter.status ?? "").trim();
        hasStartDate = !!(cache.frontmatter.start || cache.frontmatter.start_time);
        const oid = cache.frontmatter.output_id;
        outputIdForLedger = oid != null ? String(oid).trim() : "";
      }
    } catch {
      // ignore
    }

    const now = new Date();
    const nowIso = toLocalOffsetIsoString(now);
    /** 用户本机日历日，勿用 `nowIso.slice(0,10)`（那是 UTC 日，跨日附近会差一天） */
    const ymdLocal = localYmdFromInstant(now) ?? nowIso.slice(0, 10);
    await this.app.fileManager.processFrontMatter(af, (fm) => {
      fm.status = status;

      if (status === "in-progress" && prevStatus === "waiting_until") {
        delete (fm as any).resume_at;
        delete (fm as any).resume_at_time;
      }

      // Keep the date field (done/cancelled) for friendly UI, and store full ISO in *_time.
      // Obsidian's properties panel may treat `done`/`cancelled` as a Date, so we store
      // the precise timestamp in `done_time` / `cancelled_time`.
      // === status-specific timestamp rules ===
      if (status === "in-progress") {
        // start/start_time: only write if missing/empty
        const startVal = String((fm as any).start ?? "").trim();
        const startTimeVal = String((fm as any).start_time ?? "").trim();
        if (!startVal) (fm as any).start = ymdLocal;
        if (!startTimeVal) (fm as any).start_time = nowIso;
      }

      if (status === "todo") {
        // no timestamp updates; just status
      }

      if (status === "done") {
        // done/done_time: always override latest value
        (fm as any).done = ymdLocal;
        (fm as any).done_time = nowIso;
      }

      if (status === "cancelled") {
        // cancelled/cancelled_time: always override latest value
        (fm as any).cancelled = ymdLocal;
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

    // 等待一小段时间，给 metadataCache 自然刷新窗口
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

    void appendOutputStatusChangedLedgerEvent(this.plugin, {
      sourceOutputPath: filePath,
      outputId: outputIdForLedger || undefined,
      tsIso: nowIso,
      statusBefore: prevStatus,
      statusAfter: status,
      detail: action,
    });

    // ✅ 重新渲染前，确保索引已更新（清除缓存后重新获取快照）
    await this.plugin.outputRSLatte?.getSnapshot();
    await this.render();
  }

  private async setOutputWaitingUntil(filePath: string, resumeAtYmd: string): Promise<void> {
    const af = this.app.vault.getAbstractFileByPath(filePath);
    if (!(af instanceof TFile)) {
      new Notice("未找到文件：" + filePath);
      return;
    }
    const ymd = resumeAtYmd.trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
      new Notice("恢复日期格式无效");
      return;
    }
    let prevStatus = "";
    let outputIdForLedger = "";
    try {
      const cache = this.app.metadataCache.getFileCache(af);
      if (cache?.frontmatter) {
        prevStatus = String(cache.frontmatter.status ?? "").trim();
        const oid = cache.frontmatter.output_id;
        outputIdForLedger = oid != null ? String(oid).trim() : "";
      }
    } catch {
      // ignore
    }

    const nowIso = toLocalOffsetIsoString();
    await this.app.fileManager.processFrontMatter(af, (fm: any) => {
      fm.status = "waiting_until";
      fm.resume_at = ymd;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      await this.plugin.outputRSLatte?.upsertFile(af);
    } catch {
      // ignore
    }
    const enableDbSync = !!this.plugin.settings.outputPanel?.enableDbSync;
    if (enableDbSync) {
      await this.plugin.syncOutputFilesToDb({ reason: "mark_waiting_until" });
    } else {
      await ((this.plugin as any).writeTodayOutputProgressToJournalFromIndex?.() ?? Promise.resolve());
    }
    void this.plugin.workEventSvc?.append({
      ts: nowIso,
      kind: "output",
      action: "paused",
      source: "ui",
      ref: { file_path: filePath, status: "waiting_until", resume_at: ymd },
      summary: `⏳ 输出等待至 ${ymd} ${af.basename}`,
    });
    void appendOutputStatusChangedLedgerEvent(this.plugin, {
      sourceOutputPath: filePath,
      outputId: outputIdForLedger || undefined,
      tsIso: nowIso,
      statusBefore: prevStatus,
      statusAfter: "waiting_until",
      resumeAtYmd: ymd,
      detail: "waiting_until",
    });
    await this.plugin.outputRSLatte?.getSnapshot();
    await this.render();
  }

  async render() {
    const seq = ++this._renderSeq;
    const container = this.contentEl;
    container.empty();
    container.addClass("rslatte-sidepanel");
    container.addClass("rslatte-output-sidepanel");
    const pendingFocusPathRaw = String((this.plugin as any).__rslatteOutputFocusPath ?? "").trim();
    const pendingFocusPath = pendingFocusPathRaw ? normalizePath(pendingFocusPathRaw) : "";
    if (pendingFocusPath) (this.plugin as any).__rslatteOutputFocusPath = "";

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

    const stickyTop = container.createDiv({ cls: "rslatte-output-sticky-top" });

    // ===== Header =====
    const outputHeaderSection = stickyTop.createDiv({ cls: "rslatte-section" });
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

    const manageTplBtn = outputHeaderActions.createEl("button", { text: "📋", cls: "rslatte-icon-btn" });
    manageTplBtn.title = "管理模板（与设置中模板表一致）";
    manageTplBtn.onclick = () => {
      new ManageOutputTemplatesModal(this.app, this.plugin).open();
    };

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
          archiveBtn.title = "笔记归档 + 索引更新：将 DONE 且超阈值的输出文档移入归档根，并迁出主索引条目";
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
    // ===== Quick Create Buttons（仅一般模板；Top4 + ...） =====
    const tplSection = stickyTop.createDiv({ cls: "rslatte-section" });
    tplSection.style.position = "relative";
    tplSection.createDiv({ cls: "rslatte-muted", text: "快速创建" });
    const tplWrap = tplSection.createDiv({ cls: "rslatte-btn-wrap" });

    const quickTpls: OutputTemplateDef[] = (settings.templates ?? []).filter(isQuickCreateOutputTemplate);
    const counts = settings.templateCreateCounts ?? {};
    const sortedQuick = [...quickTpls].sort((a, b) => (counts[b.id] ?? 0) - (counts[a.id] ?? 0));
    const top4 = sortedQuick.slice(0, 4);
    const moreTpls = sortedQuick.slice(4);

    if (!sortedQuick.length) {
      const hint = tplSection.createDiv({ cls: "rslatte-muted" });
      hint.setText("（无可用的一般模板：请在设置或「管理模板」中添加，范围设为「一般」并启用）");
    } else {
      for (const tpl of top4) {
        const btn = tplWrap.createEl("button", { text: tpl.buttonName || tpl.docCategory, cls: "rslatte-link" });
        btn.onclick = () => this.openCreateModal(tpl);
      }
      if (moreTpls.length) {
        const moreBtn = tplWrap.createEl("button", { text: "...", cls: "rslatte-link rslatte-output-more-btn" });
        moreBtn.title = `更多模板（${moreTpls.length}）`;
        let pop: HTMLElement | null = null;
        const closePop = () => {
          pop?.remove();
          pop = null;
        };
        moreBtn.onclick = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (pop) {
            closePop();
            return;
          }
          pop = document.body.createDiv({ cls: "rslatte-output-more-pop" });
          const moreWrap = pop.createDiv({ cls: "rslatte-btn-wrap" });
          for (const tpl of moreTpls) {
            const b2 = moreWrap.createEl("button", { text: tpl.buttonName || tpl.docCategory, cls: "rslatte-link" });
            b2.onclick = () => {
              closePop();
              this.openCreateModal(tpl);
            };
          }
          // 浮窗贴近「...」按钮，同时限制在可视窗口内。
          const btnRect = moreBtn.getBoundingClientRect();
          const pad = 8;
          const maxW = Math.max(220, Math.min(520, window.innerWidth - 24));
          pop.style.maxWidth = `${maxW}px`;
          pop.style.position = "fixed";
          pop.style.visibility = "hidden";
          pop.style.left = "0px";
          pop.style.top = "0px";
          requestAnimationFrame(() => {
            if (!pop) return;
            const pRect = pop.getBoundingClientRect();
            let left = btnRect.left;
            let top = btnRect.bottom + 6;
            if (left + pRect.width > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - pRect.width - pad);
            if (top + pRect.height > window.innerHeight - pad) top = Math.max(pad, btnRect.top - pRect.height - 6);
            pop.style.left = `${Math.round(left)}px`;
            pop.style.top = `${Math.round(top)}px`;
            pop.style.visibility = "visible";
          });
          const off = (e: MouseEvent) => {
            if (!pop) return;
            const t = e.target as Node | null;
            if (t && (pop.contains(t) || moreBtn.contains(t))) return;
            document.removeEventListener("mousedown", off, true);
            closePop();
          };
          document.addEventListener("mousedown", off, true);
        };
      }
    }

    // ===== 主区页签：正在输出 | 发布管理（§3.7） =====
    const mainTab =
      (settings as any).sidePanelMainTab === "knowledge_publish" ? "knowledge_publish" : "list";
    const tabRow = stickyTop.createDiv({ cls: "rslatte-section rslatte-output-main-tab-section" });
    const tabsWrap = tabRow.createDiv({ cls: "rslatte-output-main-tabs" });
    const mkMainTab = (id: "list" | "knowledge_publish", label: string) => {
      const btn = tabsWrap.createEl("button", { text: label, cls: "rslatte-output-main-tab" });
      if (mainTab === id) btn.addClass("is-active");
      btn.onclick = () => {
        (settings as any).sidePanelMainTab = id;
        void this.plugin.saveSettings();
        void this.render();
      };
    };
    mkMainTab("list", "正在输出");
    mkMainTab("knowledge_publish", "历史发布清单");

    const mainBody = container.createDiv({ cls: "rslatte-output-main-body" });
    if (mainTab === "knowledge_publish") {
      await this.renderKnowledgePublishSection(mainBody, seq);
      return;
    }

    // ===== 输出文档列表（分成三个清单） =====
    // ✅ 使用 full 模式：索引包含 done/cancelled，以便「已完成」「取消」清单能正常展示
    // 直接调用 refreshIndexNow 确保数据正确（避免使用旧的 active 模式快照）
    await this.plugin.outputRSLatte?.refreshIndexNow({ mode: "full" });
    try {
      await this.plugin.outputRSLatte?.resumeWaitingOutputsIfDue?.();
    } catch {
      // ignore
    }

    const snap = await this.plugin.outputRSLatte?.getSnapshot();
    if (seq !== this._renderSeq) return;

    const timeField: OutputTimelineTimeField = settings.timelineTimeField || "mtime";
    const maxItems = Math.max(1, Math.min(50, Number(settings.maxItems ?? 20)));

    // ✅ refreshIndexNow({ mode: "full" }) 会自动调用 archiveIndexForArchivedFiles() 清理主索引
    // 所以主索引中只包含未归档的文件，不需要在 UI 层再做过滤
    const normalizeListFilterMode = (v: unknown): OutputListFilterMode | null => {
      if (v === "general" || v === "project" || v === "all") return v;
      return null;
    };
    const resolvedFilterMode = (() => {
      const m = normalizeListFilterMode((settings as any).listFilterMode);
      if (m) return m;
      const g = settings.listFilterShowGeneral !== false;
      const p = settings.listFilterShowProject !== false;
      if (g && !p) return "general" as const;
      if (!g && p) return "project" as const;
      return "all" as const;
    })();
    const rawItems = (snap?.items ?? []) as OutputIndexItem[];
    const passKind = (it: OutputIndexItem): boolean => {
      if (resolvedFilterMode === "all") return true;
      const isP = outputIndexItemIsProjectKind(it);
      if (resolvedFilterMode === "project") return isP;
      return !isP;
    };
    const itemsAll = rawItems.filter(passKind);
    this._copyRecordMap = await this.buildOutputCopyRecordMap();
    if (seq !== this._renderSeq) return;

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

    // 清单筛查：一般 / 项目 / 全部（持久化）
    const filterRow = mainBody.createDiv({ cls: "rslatte-section" });
    filterRow.createSpan({ text: "清单筛查：", cls: "rslatte-muted" });
    const sel = filterRow.createEl("select");
    sel.style.marginLeft = "8px";
    sel.add(new Option("一般输出", "general"));
    sel.add(new Option("项目输出", "project"));
    sel.add(new Option("全部输出", "all"));
    sel.value = resolvedFilterMode;
    sel.addEventListener("change", () => {
      const v = normalizeListFilterMode(sel.value) ?? "all";
      (settings as any).listFilterMode = v;
      // 兼容旧字段，避免其它代码路径读取时语义不一致
      (settings as any).listFilterShowGeneral = v !== "project";
      (settings as any).listFilterShowProject = v !== "general";
      void this.plugin.saveSettings();
      void this.render();
    });

    // 分类输出
    const inProgressItems = itemsAll.filter((it) => {
      const st = String(it.status ?? "todo").trim();
      return st === "in-progress" || st === "todo" || st === "waiting_until";
    }).sort((a, b) => score(b) - score(a)).slice(0, maxItems);

    const doneItems = itemsAll.filter((it) => {
      const st = String(it.status ?? "todo").trim();
      return st === "done";
    }).sort((a, b) => score(b) - score(a)).slice(0, maxItems);
    const doneProjectItems = doneItems.filter((it) => outputIndexItemIsProjectKind(it));
    const doneGeneralItems = doneItems.filter((it) => !outputIndexItemIsProjectKind(it));

    const cancelledItems = itemsAll.filter((it) => {
      const st = String(it.status ?? "todo").trim();
      return st === "cancelled";
    }).sort((a, b) => score(b) - score(a)).slice(0, maxItems);

    const renderOutputListSection = (
      title: string,
      items: OutputIndexItem[],
      collapsed: boolean,
      onToggle: (next: boolean) => void,
      emptyText: string,
    ) => {
      const wrap = mainBody.createDiv({ cls: "rslatte-section rslatte-project-section" });
      const header = wrap.createDiv({ cls: "rslatte-output-list-header" });
      header.style.cursor = "pointer";
      const left = header.createDiv({ cls: "rslatte-output-list-header-left" });
      left.createSpan({ cls: "rslatte-output-list-toggle", text: collapsed ? "▶" : "▼" });
      left.createSpan({ cls: "rslatte-output-list-title", text: title });
      header.createSpan({ cls: "rslatte-output-list-count", text: String(items.length) });
      header.onclick = () => onToggle(!collapsed);

      const body = wrap.createDiv({ cls: "rslatte-output-list-body" });
      if (collapsed) body.style.display = "none";
      if (!items.length) body.createDiv({ cls: "rslatte-task-empty", text: emptyText });
      else this.renderTimeline(body, items, timeField, pendingFocusPath || undefined);
    };

    renderOutputListSection(
      "进行中",
      inProgressItems,
      this._inProgressCollapsed,
      (next) => {
        this._inProgressCollapsed = next;
        void this.render();
      },
      "（暂无进行中的输出）",
    );

    renderOutputListSection(
      "项目输出已完成",
      doneProjectItems,
      this._doneProjectCollapsed,
      (next) => {
        this._doneProjectCollapsed = next;
        void this.render();
      },
      "（暂无已完成的项目输出）",
    );

    renderOutputListSection(
      "一般输出已完成",
      doneGeneralItems,
      this._doneGeneralCollapsed,
      (next) => {
        this._doneGeneralCollapsed = next;
        void this.render();
      },
      "（暂无已完成的一般输出）",
    );

    renderOutputListSection(
      "取消",
      cancelledItems,
      this._cancelledCollapsed,
      (next) => {
        this._cancelledCollapsed = next;
        void this.render();
      },
      "（暂无取消的输出）",
    );
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
    new Notice("开始输出归档（笔记+索引条目）…");
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

  private async buildOutputCopyRecordMap(): Promise<Map<string, OutputCopyRecord[]>> {
    const map = new Map<string, OutputCopyRecord[]>();
    const root = normalizePath(resolveKnowledgeLibraryRootRel(this.plugin.settings));
    const rootAf = tryGetFolderByPathLoose(this.app, root);
    if (!(rootAf instanceof TFolder)) return map;
    const currentSpaceId = String(this.plugin.getCurrentSpaceId?.() ?? "").trim();
    const files = collectMarkdownFilesUnderFolder(rootAf, 5000);
    const rank = (ymd: string) => Date.parse(`${ymd || "1970-01-01"}T00:00:00`) || 0;
    const put = (k: string, rec: OutputCopyRecord) => {
      const arr = map.get(k) ?? [];
      arr.push(rec);
      arr.sort((a, b) => rank(b.copiedYmd) - rank(a.copiedYmd));
      map.set(k, arr);
    };
    for (const f of files) {
      const cache = this.app.metadataCache.getFileCache(f);
      const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
      const spaceId = String(fm.published_space_id ?? "").trim();
      if (!spaceId || spaceId !== currentSpaceId) continue;
      const copiedYmd = shortIso(fm.published_at ?? fm.publishedAt) || formatYmd(f.stat.mtime);
      const rel = f.path.startsWith(`${root}/`) ? f.path.slice(root.length + 1) : f.path;
      const seg = rel.split("/").filter(Boolean);
      const bucketLabel = `${seg[0] ?? "-"}/${seg[1] ?? "-"}`;
      const rec: OutputCopyRecord = { copiedYmd, bucketLabel, knowledgePath: normalizeVaultPath(f.path) };
      const oid = String(fm.output_id ?? "").trim().toLowerCase();
      if (oid) put(`oid:${oid}`, rec);
      const src = normalizeVaultPath(fm.source_output_path);
      if (src) put(`src:${src}`, rec);
    }
    return map;
  }

  private async gotoKnowledgeByCopyRecord(path: string) {
    (this.plugin as any).__rslatteKnowledgeFocusPath = normalizeVaultPath(path);
    const ws: any = this.app.workspace as any;
    if (!ws) return;
    const knowledgeLeaves = ws.getLeavesOfType?.(VIEW_TYPE_KNOWLEDGE) ?? [];
    if (knowledgeLeaves.length > 0) {
      ws.revealLeaf(knowledgeLeaves[0]);
      const v = knowledgeLeaves[0]?.view as any;
      if (v && typeof v.refresh === "function") v.refresh();
      return;
    }
    const panelLeaves = ws.getLeavesOfType?.(VIEW_TYPE_KNOWLEDGE_PANEL) ?? [];
    if (panelLeaves.length > 0) {
      ws.revealLeaf(panelLeaves[0]);
      const v = panelLeaves[0]?.view as any;
      if (v && typeof v.refresh === "function") v.refresh();
      return;
    }
    const open = (this.plugin as any).activateKnowledgeView;
    if (typeof open === "function") await open.call(this.plugin);
  }

  private getCopyRecordsForItem(it: OutputIndexItem): OutputCopyRecord[] {
    const oid = String(it.outputId ?? "").trim().toLowerCase();
    const src = normalizeVaultPath(it.filePath);
    const fromOid = oid ? (this._copyRecordMap.get(`oid:${oid}`) ?? []) : [];
    const fromSrc = this._copyRecordMap.get(`src:${src}`) ?? [];
    const merged = [...fromOid, ...fromSrc];
    const seen = new Set<string>();
    const uniq: OutputCopyRecord[] = [];
    for (const r of merged) {
      const k = `${r.copiedYmd}|${r.knowledgePath}`;
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push(r);
    }
    uniq.sort((a, b) => b.copiedYmd.localeCompare(a.copiedYmd));
    return uniq;
  }

  private renderTimeline(parent: HTMLElement, items: OutputIndexItem[], timeField: OutputTimelineTimeField, focusPath?: string) {
    const wrap = parent.createDiv({ cls: "rslatte-timeline" });

    const pickDayKey = (it: OutputIndexItem): string | null => {
      const k = this.plugin.outputRSLatte?.pickTimelineDayKey(it, timeField);
      return k ?? null;
    };

    for (const it of items) {
      pickDayKey(it); // 预留时间轴 dayKey 计算，避免后续排序策略变化时遗漏依赖
      this.renderTimelineItem(wrap, it, focusPath);
    }
  }

  private renderTimelineItem(parent: HTMLElement, it: OutputIndexItem, focusPath?: string) {
    const row = parent.createDiv({ cls: "rslatte-timeline-item" });
    row.tabIndex = 0;

    const gutter = row.createDiv({ cls: "rslatte-timeline-gutter" });
    const dot = gutter.createDiv({ cls: "rslatte-timeline-dot" });
    dot.setText(statusIcon(String(it.status ?? "todo")));
    gutter.createDiv({ cls: "rslatte-timeline-line" });

    const content = row.createDiv({ cls: "rslatte-timeline-content" });
    if (focusPath && normalizePath(String(it.filePath ?? "")) === normalizePath(focusPath)) {
      row.addClass("rslatte-knowledge-focus-highlight");
      requestAnimationFrame(() => row.scrollIntoView({ behavior: "smooth", block: "center" }));
    }

    const titleRow = content.createDiv({ cls: "rslatte-timeline-title-row" });
    const title = titleRow.createDiv({ cls: "rslatte-timeline-text" });
    title.setText(it.title);

    const actions = titleRow.createDiv({ cls: "rslatte-output-actions" });
    const st = String(it.status ?? "todo");

    if (st === "todo" || st === "in-progress" || st === "waiting_until") {
      const editMeta = actions.createEl("button", { text: "✏️", cls: "rslatte-text-btn" });
      editMeta.title = "修正属性（文档分类、领域、扩展字段等）";
      editMeta.onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        new EditOutputMetaModal(this.app, this.plugin, it.filePath).open();
      };
      const linkSch = actions.createEl("button", { text: "📅", cls: "rslatte-text-btn" });
      linkSch.title = "录日程（关联当前输出，与任务侧录日程相同）";
      linkSch.onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        new RecordTaskScheduleModal(this.app, this.plugin, { kind: "output", filePath: it.filePath }, () => {
          this.refresh();
        }).open();
      };
    }

    if (st === "done") {
      const pub = actions.createEl("button", { text: "📚", cls: "rslatte-text-btn" });
      pub.title = "发布到知识库（仅已完成输出可发布）";
      pub.onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        new PublishToKnowledgeModal(this.app, this.plugin, it.filePath).open();
      };
    }

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

    // §3.6 输出条目操作按钮
    // - todo: ✏️ ▶ ⛔
    // - in-progress: ✏️ ↻ ✅ ⛔
    // - waiting_until: ✏️ ▶ ⛔
    // - done/cancelled: ♻️（回到 in-progress）
    if (st === "done" || st === "cancelled") {
      mkBtn("♻️", "草稿（回到进行中）", "in-progress");
    } else if (st === "in-progress") {
      const w = actions.createEl("button", { text: "↻", cls: "rslatte-text-btn" });
      w.title = "等待至指定日期（status=waiting_until，写入 resume_at）";
      w.onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        new SetOutputWaitingModal(this.app, it.title, async (ymd) => {
          await this.setOutputWaitingUntil(it.filePath, ymd);
        }).open();
      };
      mkBtn("✅", "完成（status=done；写入 done 时间戳）", "done");
      mkBtn("⛔", "取消（status=cancelled；写入 cancelled 时间戳）", "cancelled");
    } else if (st === "waiting_until") {
      mkBtn("▶", "继续（立即恢复进行中）", "in-progress");
      mkBtn("⛔", "取消（status=cancelled；写入 cancelled 时间戳）", "cancelled");
    } else {
      // todo / default
      mkBtn("▶", "进行中（status=in-progress；若 start/start_time 缺失则写入）", "in-progress");
      mkBtn("⛔", "取消（status=cancelled；写入 cancelled 时间戳）", "cancelled");
    }

    const tagsRow = content.createDiv({ cls: "rslatte-output-tags-row" });
    const kind = outputIndexItemIsProjectKind(it) ? "项目" : "一般";
    tagsRow.createSpan({ cls: "rslatte-output-tag rslatte-output-tag-kind", text: kind });
    const docCategory = String(it.docCategory ?? "").trim();
    if (docCategory) tagsRow.createSpan({ cls: "rslatte-output-tag rslatte-output-tag-doccat", text: docCategory });
    for (const d of (it.domains ?? []).map((x) => String(x).trim()).filter(Boolean)) {
      tagsRow.createSpan({ cls: "rslatte-output-tag rslatte-output-tag-domain", text: d });
    }

    const schUid = String(it.linkedScheduleUid ?? "").trim();
    if (schUid) {
      const schedRow = content.createDiv({ cls: "rslatte-reminder-arranged-row rslatte-schedule-followup-row" });
      schedRow.createSpan({ cls: "rslatte-schedule-followup-label", text: "" });
      schedRow.createSpan({ cls: "rslatte-reminder-arranged-kind", text: "日程" });
      const schedDescEl = schedRow.createSpan({ cls: "rslatte-reminder-arranged-desc", text: "…" });
      const schedDateEl = schedRow.createSpan({ cls: "rslatte-reminder-arranged-date", text: "…" });
      schedRow.tabIndex = 0;
      schedRow.setAttr("role", "button");
      schedRow.setAttr("title", "点击：在任务管理侧栏定位该日程");
      void this.hydrateOutputLinkedScheduleRow(schUid, schedRow, schedDescEl, schedDateEl);
    }

    const meta = content.createDiv({ cls: "rslatte-timeline-meta" });
    const create = it.createDate || formatYmd(it.ctimeMs);
    const mtime = formatYmd(it.mtimeMs);
    const done = outputDoneLocalYmd(it.doneDate, it.doneTime) || shortIso(it.doneDate) || shortIso(it.doneTime);
    const af = this.app.vault.getAbstractFileByPath(it.filePath);
    let start = "";
    if (af instanceof TFile) {
      try {
        const cache = this.app.metadataCache.getFileCache(af);
        const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
        start = shortIso(fm.start ?? fm.start_time);
      } catch {
        // ignore
      }
    }

    const parts: string[] = [];
    const statusLabel = st === "waiting_until" ? "wait_until" : st;
    if (statusLabel) parts.push(statusLabel);
    if (create) parts.push(`🆕${create}`);
    if (start) parts.push(`▶${start}`);
    if (mtime) parts.push(`📝${mtime}`);
    if (st === "waiting_until" && it.resumeAt) parts.push(`⌛${it.resumeAt}`);
    if (st === "done" && done) parts.push(`✅${done}`);

    meta.setText(parts.join(" / "));

    if (st === "done") {
      const records = this.getCopyRecordsForItem(it);
      if (records.length) {
        const wrap = content.createDiv({ cls: "rslatte-output-copy-records" });
        for (const rec of records) {
          const copyRow = wrap.createDiv({ cls: "rslatte-output-copy-record-row" });
          copyRow.setText(`复制记录：${rec.copiedYmd} ${rec.bucketLabel}`);
          copyRow.setAttr("title", `点击跳转到知识库文档\n${rec.knowledgePath}`);
          copyRow.tabIndex = 0;
          copyRow.setAttr("role", "button");
          copyRow.onclick = (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            void this.gotoKnowledgeByCopyRecord(rec.knowledgePath);
          };
          copyRow.onkeydown = (ev: KeyboardEvent) => {
            if (ev.key !== "Enter") return;
            ev.preventDefault();
            ev.stopPropagation();
            void this.gotoKnowledgeByCopyRecord(rec.knowledgePath);
          };
        }
      }
    }

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
        await leaf.openFile(af, { active: true, state: { mode: "source" } as any });
      } catch (e: any) {
        new Notice(`打开失败：${e?.message ?? String(e)}`);
      }
    };

    row.addEventListener("click", () => void open());
    row.addEventListener("keydown", (ev) => {
      if ((ev as KeyboardEvent).key === "Enter") void open();
    });
  }

  /** 输出侧栏 ·「历史发布清单」：搜索 + output_id，展示最近发布文档 */
  private async renderKnowledgePublishSection(container: HTMLElement, seq: number): Promise<void> {
    const section = container.createDiv({ cls: "rslatte-section rslatte-output-knowledge-publish" });
    section.createDiv({
      cls: "rslatte-muted",
      text: "支持搜索与 output_id 查询；默认展示当前空间最近发布的 30 个输出文档。",
    });

    const knowledgeRoot = normalizePath(resolveKnowledgeLibraryRootRel(this.plugin.settings));
    const rootAf = tryGetFolderByPathLoose(this.app, knowledgeRoot);
    if (!(rootAf instanceof TFolder)) {
      section.createDiv({ cls: "rslatte-muted", text: `未找到知识库文件夹：${knowledgeRoot}` });
      return;
    }

    const mainPanel = section.createDiv({ cls: "rslatte-output-knowledge-main-panel" });
    const searchRow = mainPanel.createDiv({ cls: "rslatte-output-knowledge-search-row" });
    searchRow.createSpan({ text: "搜索", cls: "rslatte-muted" });
    const inp = searchRow.createEl("input", { type: "search", cls: "rslatte-output-knowledge-search-input" });
    inp.placeholder = "标题、路径、output_id…";
    if (!this._knowledgePublishSearchDraft) this._knowledgePublishSearchDraft = this._knowledgePublishSearch;
    inp.value = this._knowledgePublishSearchDraft;
    inp.addEventListener("input", () => {
      this._knowledgePublishSearchDraft = inp.value;
    });
    inp.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      this._knowledgePublishSearch = this._knowledgePublishSearchDraft.trim();
      void this.render();
    });

    const idRow = mainPanel.createDiv({ cls: "rslatte-output-knowledge-search-row" });
    idRow.createSpan({ text: "output_id", cls: "rslatte-muted" });
    const idInp = idRow.createEl("input", { type: "search", cls: "rslatte-output-knowledge-search-input" });
    idInp.placeholder = "粘贴 ID，精确匹配（至多 10 条）";
    if (!this._knowledgePublishOutputIdDraft) this._knowledgePublishOutputIdDraft = this._knowledgePublishOutputId;
    idInp.value = this._knowledgePublishOutputIdDraft;
    idInp.addEventListener("input", () => {
      this._knowledgePublishOutputIdDraft = idInp.value;
    });
    idInp.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      this._knowledgePublishOutputId = this._knowledgePublishOutputIdDraft.trim();
      void this.render();
    });

    const limit = 2000;
    const currentSpaceId = String(this.plugin.getCurrentSpaceId?.() ?? "").trim();
    const allFiles = collectMarkdownFilesUnderFolder(rootAf, limit);
    const files = allFiles.filter((f) => {
      try {
        const cache = this.app.metadataCache.getFileCache(f);
        const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
        const spaceId = String(fm.published_space_id ?? "").trim();
        return !!spaceId && spaceId === currentSpaceId;
      } catch {
        return false;
      }
    });
    const normalize = (s: string) => s.trim().toLowerCase();
    const idQ = this._knowledgePublishOutputId.trim().toLowerCase();
    const idQCompact = idQ.replace(/\s+/g, "");
    const q = normalize(this._knowledgePublishSearch);

    const publishedMs = (f: TFile): number => {
      try {
        const cache = this.app.metadataCache.getFileCache(f);
        const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
        const raw = fm.published_at ?? fm.publishedAt;
        if (typeof raw === "number" && Number.isFinite(raw)) return raw;
        if (typeof raw === "string" && raw.trim()) {
          const ms = Date.parse(raw.trim());
          if (Number.isFinite(ms)) return ms;
        }
      } catch {
        // ignore
      }
      return f.stat.mtime;
    };

    files.sort((a, b) => publishedMs(b) - publishedMs(a));
    const topN = 30;
    let filtered: TFile[] = [];
    if (idQ) {
      filtered = files
        .filter((f) => {
          const oid = fileOutputIdLower(this.app, f);
          if (!oid) return false;
          if (oid === idQ) return true;
          return oid.replace(/\s+/g, "") === idQCompact;
        })
        .slice(0, topN);
    } else if (!q) {
      filtered = files.slice(0, topN);
    } else {
      filtered = files.filter((f) => {
        const path = f.path.toLowerCase();
        const base = f.basename.toLowerCase();
        const oid = fileOutputIdLower(this.app, f);
        return path.includes(q) || base.includes(q) || oid.includes(q);
      }).slice(0, topN);
    }

    if (seq !== this._renderSeq) return;

    if (!filtered.length) {
      const emptyHint = idQ ? "无匹配 output_id" : q ? "无匹配条目" : "当前空间暂无发布到知识库的文档";
      mainPanel.createDiv({ cls: "rslatte-task-empty", text: emptyHint });
      return;
    }

    const hint = idQ
      ? `output_id「${this._knowledgePublishOutputId.trim()}」：显示前 ${topN} 条（按发布时间降序）。`
      : q
        ? `搜索「${this._knowledgePublishSearch.trim()}」：显示前 ${topN} 条（按发布时间降序）。`
        : `当前空间最近发布：前 ${topN} 条（按发布时间降序）。`;
    mainPanel.createDiv({ cls: "rslatte-muted", text: hint });

    const list = mainPanel.createDiv({ cls: "rslatte-timeline" });
    for (const f of filtered) {
      const rel = f.path.startsWith(`${knowledgeRoot}/`) ? f.path.slice(knowledgeRoot.length + 1) : f.path;
      this.renderPublishedHistoryItem(list, f, rel, publishedMs(f));
    }
    if (allFiles.length >= limit) {
      mainPanel.createDiv({
        cls: "rslatte-muted",
        text: `当前范围扫描上限 ${limit} 篇，更多请缩小目录或搜索。仅展示 frontmatter 含 published_space_id 且等于当前空间的文档。`,
      });
    }
  }

  private renderPublishedHistoryItem(parent: HTMLElement, file: TFile, relPath: string, publishedMs: number) {
    const row = parent.createDiv({ cls: "rslatte-timeline-item" });
    row.tabIndex = 0;
    const gutter = row.createDiv({ cls: "rslatte-timeline-gutter" });
    const dot = gutter.createDiv({ cls: "rslatte-timeline-dot" });
    dot.setText("📚");
    gutter.createDiv({ cls: "rslatte-timeline-line" });

    const content = row.createDiv({ cls: "rslatte-timeline-content" });
    const titleRow = content.createDiv({ cls: "rslatte-timeline-title-row" });
    titleRow.createDiv({ cls: "rslatte-timeline-text", text: file.basename });
    const actions = titleRow.createDiv({ cls: "rslatte-output-actions" });
    const readB = actions.createEl("button", { text: "阅读", cls: "rslatte-text-btn" });
    readB.onclick = (e) => {
      e.stopPropagation();
      void this.openKnowledgeFilePreview(file.path);
    };
    const recallB = actions.createEl("button", { text: "打回输出", cls: "rslatte-text-btn" });
    recallB.onclick = (e) => {
      e.stopPropagation();
      new RecallOutputFromKnowledgeModal(this.app, this.plugin, file.path).open();
    };

    const meta = content.createDiv({ cls: "rslatte-timeline-meta" });
    const pubAt = formatYmdHm(publishedMs);
    meta.setText(pubAt ? `发布 ${pubAt}` : "发布信息缺失");
    content.createDiv({ cls: "rslatte-timeline-from", text: relPath });

    row.onclick = () => void this.openKnowledgeFilePreview(file.path);
    row.onkeydown = (ev: KeyboardEvent) => {
      if (ev.key === "Enter") void this.openKnowledgeFilePreview(file.path);
    };
  }

  private async openKnowledgeFilePreview(filePath: string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(filePath);
    if (!(f instanceof TFile)) {
      new Notice("未找到文件");
      return;
    }
    try {
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(f, { active: true, state: { mode: "preview" } as any });
    } catch (e: any) {
      console.warn("openKnowledgeFilePreview", e);
      new Notice(`打开失败：${e?.message ?? String(e)}`);
    }
  }

  /** Today 执行统计：正在输出 → 进行中清单展开 */
  public async openInProgressListFromStats(): Promise<void> {
    const sAny: any = this.plugin.settings as any;
    if (!sAny.outputPanel) sAny.outputPanel = {};
    sAny.outputPanel.sidePanelMainTab = "list";
    this._inProgressCollapsed = false;
    await this.plugin.saveSettings();
    void this.render();
  }

  /** 外部跳转：高亮时间轴中指定路径的条目（需先置 `__rslatteOutputFocusPath` 或由此方法写入） */
  public async focusTimelineItemByFilePath(filePath: string): Promise<void> {
    const p = normalizePath(String(filePath ?? "").trim());
    if (!p) return;
    (this.plugin as any).__rslatteOutputFocusPath = p;
    await this.openInProgressListFromStats();
  }

  /** 与任务侧栏「关联任务/日程」行同款样式；描述解析对齐 `hydrateTaskLinkedScheduleRow` */
  private hydrateOutputLinkedScheduleRow(
    scheduleUid: string,
    schedRow: HTMLElement,
    descEl: HTMLElement,
    dateEl: HTMLElement,
  ): void {
    const uid = String(scheduleUid ?? "").trim();
    if (!uid) return;
    void (async () => {
      try {
        const sch = await this.plugin.taskRSLatte.findScheduleByUid(uid);
        if (!sch) {
          descEl.setText("索引中未找到");
          dateEl.setText("—");
          schedRow.addClass("rslatte-reminder-arranged-row--missing");
          schedRow.setAttr("title", `output 关联日程 uid=${uid}（可刷新日程索引）`);
          return;
        }
        const ex = ((sch as any)?.extra ?? {}) as Record<string, string>;
        const st = String(ex.start_time ?? "").trim();
        const en = String(ex.end_time ?? "").trim();
        const timeRange = st && en ? `${st}-${en}` : "";
        let rawLine = String(sch.text ?? "").trim();
        if (timeRange && rawLine.startsWith(timeRange)) rawLine = rawLine.slice(timeRange.length).trim();
        const displayDesc = await plainTextFromTextWithContactRefsResolved(
          rawLine || String(sch.text ?? "").trim(),
          (cid) => this.lookupContactDisplayName(cid),
        );
        const parts: string[] = [];
        if (timeRange) parts.push(timeRange);
        if (displayDesc) parts.push(displayDesc);
        const lineDesc = parts.join(" ").trim() || "（无描述）";
        descEl.setText(lineDesc);
        descEl.setAttr("title", lineDesc);
        const date = String((sch as any).memoDate ?? "").trim();
        dateEl.setText(date ? `日程日 ${date}` : "—");
        schedRow.setAttr(
          "title",
          `点击在任务管理侧栏定位日程\n${timeRange ? `${timeRange} ` : ""}${displayDesc}${date ? `\n日程日：${date}` : ""}`,
        );
        const openSch = (ev: Event) => {
          ev.preventDefault();
          ev.stopPropagation();
          void this.jumpToLinkedSchedule(sch);
        };
        schedRow.onclick = openSch;
        schedRow.onkeydown = (ev: KeyboardEvent) => {
          if (ev.key === "Enter") openSch(ev);
        };
      } catch {
        descEl.setText("加载失败");
        dateEl.setText("—");
        schedRow.addClass("rslatte-reminder-arranged-row--missing");
      }
    })();
  }

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

  private async jumpToLinkedSchedule(sch: RSLatteIndexItem): Promise<void> {
    try {
      await (this.plugin as any).activateTaskView?.();
      const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_TASKS)[0];
      const v: any = leaf?.view;
      if (v && typeof v.focusScheduleByFileLine === "function") {
        await v.focusScheduleByFileLine(sch.filePath, sch.lineNo);
        return;
      }
      new Notice("无法打开任务管理侧栏");
    } catch (e: any) {
      new Notice(`跳转失败：${e?.message ?? String(e)}`);
    }
  }
}