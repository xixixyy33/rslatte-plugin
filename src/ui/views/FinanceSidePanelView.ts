import { ButtonComponent, ItemView, TFile, WorkspaceLeaf, moment, Notice, normalizePath } from "obsidian";
import type RSLattePlugin from "../../main";
import { VIEW_TYPE_FINANCE } from "../../constants/viewTypes";
import { AddFinanceRecordModal } from "../modals/AddFinanceRecordModal";
import { FinanceAnomalyModal } from "../modals/FinanceAnomalyModal";
import { FinanceHiddenAlertsModal } from "../modals/FinanceHiddenAlertsModal";
import { FinanceRelatedEntriesModal, type FinanceRelatedEntryItem } from "../modals/FinanceRelatedEntriesModal";
import { extractFinanceMeta, extractFinanceSubcategory } from "../../services/finance/financeSubcategory";
import {
  buildFinanceListItemLine,
  buildFinanceMainNoteParts,
  findFinanceMainLineIndexInDiaryLines,
  stringifyFinanceMetaComment,
} from "../../services/finance/financeJournalMeta";
import { getUiHeaderButtonsVisibility } from "../helpers/uiHeaderButtons";
import { readFinanceAnalysisAlertIndex } from "../../services/finance/financeAnalysisAlertIndex";
import {
  readFinanceAlertsSnapshot,
  readFinanceAnalysisIndex,
  readFinanceStatsSnapshot,
  restoreFinanceMonthSnapshotsFromBackup,
  writeFinanceAnalysisSnapshotsForMonths,
} from "../../services/finance/financeAnalysisIndex";
import { readFinanceRulesAlertSnapshot } from "../../services/finance/financeRulesAnalysis";
import type { FinanceAnomalyScanResult } from "../../types/financeAnomalyTypes";

const momentFn = moment as any;

export class FinanceSidePanelView extends ItemView {
  private plugin: RSLattePlugin;
  private _renderSeq = 0;
  private _viewMode: "month" | "year" = "month"; // 视图模式：月份或年份
  private _selectedMonth: string = ""; // YYYY-MM 格式
  private _selectedYear: string = ""; // YYYY 格式
  private _filterCategoryId: string = ""; // 筛选：财务分类ID
  private _filterSubcategory: string = ""; // 筛选：财务子分类
  private _filterType: "" | "income" | "expense" = ""; // 筛选：收入/支出
  /** 侧栏主体页签：流水清单 / 统计与告警 */
  private _financeContentTab: "ledger" | "stats" = "ledger";
  /** 统计页告警筛选 */
  private _statsAlertSeverityFilter: "" | "high" | "warning" | "notice" = "";
  private _statsAlertStatusFilter: "" | "new" | "ongoing" | "resolved" | "ignored" = "";
  private _statsAlertRuleGroupFilter: string = "";
  private _statsAlertPage: number = 1;
  private static readonly STATS_ALERT_PAGE_SIZE = 12;
  /** 清单时间轴行高亮（expectSeq 与本次 render 对齐） */
  private _pendingFinanceNavFlash: { entryId: string; recordDate: string; expectSeq: number } | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: RSLattePlugin) {
    super(leaf);
    this.plugin = plugin;
    // 默认选择当前月份
    const now = momentFn();
    this._selectedMonth = now.format("YYYY-MM");
    this._selectedYear = now.format("YYYY");
  }

  getViewType(): string { return VIEW_TYPE_FINANCE; }
  getDisplayText(): string { return "财务管理"; }
  getIcon(): string { return "wallet"; }

  async onOpen() {
    const financeEnabled = this.plugin.isPipelineModuleEnabled("finance");
    if (!financeEnabled) {
      void this.render();
      return;
    }

    await ((this.plugin as any).ensureTodayFinancesInitialized?.({ allowDb: false }) ?? Promise.resolve());
    void this.render();
  }

  async onClose() { }

  /**
   * 外部跳转：财务记录清单 + 按账单月份筛选，并在时间轴上高亮对应 entry_id 行。
   */
  public applyLedgerNavFocus(opts: { entryId: string; recordDate: string }): void {
    const entryId = String(opts.entryId ?? "").trim();
    const recordDate = String(opts.recordDate ?? "").trim();
    if (!entryId || !/^\d{4}-\d{2}-\d{2}$/.test(recordDate)) return;
    this._financeContentTab = "ledger";
    this._viewMode = "month";
    this._selectedMonth = recordDate.slice(0, 7);
    this._filterCategoryId = "";
    this._filterSubcategory = "";
    this._filterType = "";
    this._pendingFinanceNavFlash = {
      entryId,
      recordDate,
      expectSeq: this._renderSeq + 1,
    };
    void this.render();
  }

  private escapeForFinanceNavSelector(s: string): string {
    const esc = (globalThis as any).CSS?.escape as ((x: string) => string) | undefined;
    return typeof esc === "function" ? esc(s) : s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  private maybeRunFinanceNavFlash(seq: number): void {
    const p = this._pendingFinanceNavFlash;
    if (!p || p.expectSeq !== seq || seq !== this._renderSeq) return;
    this._pendingFinanceNavFlash = null;
    const key = { entryId: p.entryId, recordDate: p.recordDate };
    window.requestAnimationFrame(() => {
      window.setTimeout(() => {
        if (seq !== this._renderSeq) return;
        const root = this.containerEl.children[1] as HTMLElement | undefined;
        if (!root) return;
        const idEsc = this.escapeForFinanceNavSelector(key.entryId);
        const row = root.querySelector(
          `.rslatte-finance-timeline-item[data-entry-id="${idEsc}"]`,
        ) as HTMLElement | null;
        if (!row) return;
        row.scrollIntoView({ block: "nearest", behavior: "smooth" });
        row.addClass("rslatte-finance-timeline-item--nav-flash");
        window.setTimeout(() => row.removeClass("rslatte-finance-timeline-item--nav-flash"), 2600);
      }, 120);
    });
  }

  private async render() {
    const seq = ++this._renderSeq;
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("rslatte-finance-panel");

    const financeEnabled = this.plugin.isPipelineModuleEnabled("finance");
    if (!financeEnabled) {
      container.createDiv({ cls: "rslatte-muted", text: "财务模块未启用" });
      this.maybeRunFinanceNavFlash(seq);
      return;
    }

    // ===== 分区一：标题 + 加号按钮 =====
    const headerSection = container.createDiv({ cls: "rslatte-section" });
    const headerRow = headerSection.createDiv({ cls: "rslatte-section-title-row" });
    headerRow.createEl("h3", { text: "💰 财务" });
    const headerActions = headerRow.createDiv({ cls: "rslatte-section-title-right" });
    
    // 加号按钮
    const addBtn = headerActions.createEl("button", { text: "➕", cls: "rslatte-icon-btn" });
    addBtn.title = "新增财务记录";
    addBtn.onclick = () => {
      new AddFinanceRecordModal(this.app, this.plugin, (_dateKey?: string) => {
        // 新增记录后刷新视图
        void this.render();
      }).open();
    };

    const anomalyBtn = headerActions.createEl("button", { text: "⚠", cls: "rslatte-icon-btn" });
    anomalyBtn.title = "财务异常清单（无 meta / 同文件或跨文件重复 entry_id）";
    anomalyBtn.onclick = () => {
      new FinanceAnomalyModal(this.app, this.plugin).open();
    };

    // 重建索引、归档、刷新按钮
    const finBtnVis = getUiHeaderButtonsVisibility(this.plugin.settings, "finance");

    if (finBtnVis.rebuild) {
      const rebuildBtn = headerActions.createEl("button", { text: "🧱", cls: "rslatte-icon-btn" });
      rebuildBtn.title = "扫描重建财务索引（全量）";
      rebuildBtn.onclick = async () => {
        try {
          rebuildBtn.disabled = true;
          await this.manualRebuild();
        } finally {
          rebuildBtn.disabled = false;
        }
      };
    }

    if (finBtnVis.archive) {
      const archiveBtn = headerActions.createEl("button", { text: "🗄", cls: "rslatte-icon-btn" });
      archiveBtn.title = "索引归档：财务（超阈值的记录从主索引迁入 archive，日记中的笔记不移动）";
      archiveBtn.onclick = async () => {
        try {
          archiveBtn.disabled = true;
          await this.manualArchive();
        } finally {
          archiveBtn.disabled = false;
        }
      };
    }

    if (finBtnVis.refresh) {
      const refreshBtn = headerActions.createEl("button", { text: "🔄", cls: "rslatte-icon-btn" });
      refreshBtn.title = "财务手动刷新（增量）：扫描阈值范围内变更日记";
      refreshBtn.onclick = async () => {
        try {
          refreshBtn.disabled = true;
          await this.manualRefresh();
        } finally {
          refreshBtn.disabled = false;
        }
      };
    }

    // ===== 分区二：时间筛选（月份/年份） =====
    const filterSection = container.createDiv({ cls: "rslatte-section" });
    const filterRow = filterSection.createDiv({ cls: "rslatte-finance-filter-row" });
    
    // 视图模式切换按钮
    const modeToggle = filterRow.createDiv({ cls: "rslatte-finance-mode-toggle" });
    const monthBtn = modeToggle.createEl("button", { 
      text: "月份", 
      cls: `rslatte-finance-mode-btn ${this._viewMode === "month" ? "is-active" : ""}` 
    });
    monthBtn.onclick = () => {
      this._viewMode = "month";
      void this.render();
    };
    const yearBtn = modeToggle.createEl("button", { 
      text: "年份", 
      cls: `rslatte-finance-mode-btn ${this._viewMode === "year" ? "is-active" : ""}` 
    });
    yearBtn.onclick = () => {
      this._viewMode = "year";
      void this.render();
    };
    
    // 根据视图模式显示不同的选择器
    if (this._viewMode === "month") {
      filterRow.createEl("label", { text: "选择月份：", cls: "rslatte-finance-filter-label" });
      const monthInput = filterRow.createEl("input", { type: "month", cls: "rslatte-finance-month-input" });
      monthInput.value = this._selectedMonth;
      monthInput.onchange = (e) => {
        const target = e.target as HTMLInputElement;
        this._selectedMonth = target.value || momentFn().format("YYYY-MM");
        void this.render();
      };
    } else {
      filterRow.createEl("label", { text: "选择年份：", cls: "rslatte-finance-filter-label" });
      const yearInput = filterRow.createEl("input", { type: "number", cls: "rslatte-finance-year-input" });
      yearInput.value = this._selectedYear;
      yearInput.min = "2000";
      yearInput.max = "2100";
      yearInput.placeholder = "YYYY";
      yearInput.onchange = (e) => {
        const target = e.target as HTMLInputElement;
        const year = target.value.trim();
        // 验证年份格式（4位数字，2000-2100之间）
        if (year && /^\d{4}$/.test(year)) {
          const yearNum = parseInt(year, 10);
          if (yearNum >= 2000 && yearNum <= 2100) {
            this._selectedYear = year;
            void this.render();
          } else {
            // 如果年份超出范围，恢复为当前年份
            target.value = this._selectedYear;
          }
        } else if (!year) {
          // 如果为空，使用当前年份
          this._selectedYear = momentFn().format("YYYY");
          target.value = this._selectedYear;
          void this.render();
        } else {
          // 格式不正确，恢复原值
          target.value = this._selectedYear;
        }
      };
      // 添加失焦事件，确保即使输入不完整也能恢复
      yearInput.onblur = (e) => {
        const target = e.target as HTMLInputElement;
        const year = target.value.trim();
        if (!year || !/^\d{4}$/.test(year)) {
          target.value = this._selectedYear;
        }
      };
    }

    // ===== 分区三：侧栏主体（「财务记录清单」|「财务统计明细」） =====
    const contentSection = container.createDiv({ cls: "rslatte-section" });

    // 财务数据：与健康侧栏一致——「清单」仅 active；「统计明细」合并 active + 索引归档
    let financeLedgerItems: any[] = [];
    let financeStatsItems: any[] = [];
    try {
      if (this.plugin.recordRSLatte) {
        const fSnapActive = await this.plugin.recordRSLatte.getFinanceSnapshot(false);
        financeLedgerItems = [...(fSnapActive?.items ?? [])];
        const fSnapArch = await this.plugin.recordRSLatte.getFinanceSnapshot(true);
        financeStatsItems = [...(fSnapActive?.items ?? []), ...(fSnapArch?.items ?? [])];
      }
    } catch {
      // ignore
    }

    const itemsInPeriod =
      this._financeContentTab === "stats" ? financeStatsItems : financeLedgerItems;

    // 根据视图模式筛选数据（支持两种字段名格式）
    let filteredRecords: any[] = [];
    let periodLabel = "";

    if (this._viewMode === "month") {
      // 月份视图
      const selectedMonthStart = momentFn(this._selectedMonth + "-01");
      const selectedMonthEnd = selectedMonthStart.clone().endOf("month");
      periodLabel = this._selectedMonth;
      filteredRecords = itemsInPeriod.filter((item: any) => {
        const recordDate = momentFn(item.record_date || item.recordDate);
        return recordDate.isSameOrAfter(selectedMonthStart, "day") && recordDate.isSameOrBefore(selectedMonthEnd, "day");
      });
    } else {
      // 年份视图
      const selectedYearStart = momentFn(this._selectedYear + "-01-01");
      const selectedYearEnd = selectedYearStart.clone().endOf("year");
      periodLabel = this._selectedYear;
      filteredRecords = itemsInPeriod.filter((item: any) => {
        const recordDate = momentFn(item.record_date || item.recordDate);
        return recordDate.isSameOrAfter(selectedYearStart, "day") && recordDate.isSameOrBefore(selectedYearEnd, "day");
      });
    }

    const tabRow = contentSection.createDiv({ cls: "rslatte-finance-panel-tabs" });
    const tabLedgerBtn = tabRow.createEl("button", {
      type: "button",
      cls: `rslatte-finance-panel-tab ${this._financeContentTab === "ledger" ? "is-active" : ""}`,
      text: "财务记录清单",
    });
    tabLedgerBtn.onclick = () => {
      this._financeContentTab = "ledger";
      void this.render();
    };
    const tabStatsBtn = tabRow.createEl("button", {
      type: "button",
      cls: `rslatte-finance-panel-tab ${this._financeContentTab === "stats" ? "is-active" : ""}`,
      text: "财务统计明细",
    });
    tabStatsBtn.onclick = () => {
      this._financeContentTab = "stats";
      void this.render();
    };

    const tabBody = contentSection.createDiv({ cls: "rslatte-finance-tab-body" });

    if (this._financeContentTab === "stats") {
      await this.renderFinanceStatsDetail(tabBody, filteredRecords, periodLabel, seq);
      if (seq !== this._renderSeq) return;
      return;
    }

    // —— 财务记录清单：饼图 + 筛选 + 时间轴 ——
    const expenseRecords = filteredRecords.filter((item: any) => {
      const isDel = this.isFinanceRecordDeleted(item);
      return item.type === "expense" && !isDel;
    });

    const showPie = (this.plugin.settings as any).rslattePanelShowFinancePieCharts !== false;
    if (showPie && expenseRecords.length > 0) {
      const pieSection = tabBody.createDiv({ cls: "rslatte-finance-pie-section" });
      this.renderFinancePieChart(pieSection, expenseRecords, periodLabel);
    }

    const listSection = tabBody.createDiv({ cls: "rslatte-finance-list-section" });

    let totalIncome = 0;
    let totalExpense = 0;
    for (const record of filteredRecords) {
      if (this.isFinanceRecordDeleted(record)) continue;
      const amount = Number(record.amount || 0);
      if (record.type === "income") {
        totalIncome += Math.abs(amount);
      } else if (record.type === "expense") {
        totalExpense += Math.abs(amount);
      }
    }

    const listTitleRow = listSection.createDiv({ cls: "rslatte-finance-list-title-row" });
    listTitleRow.createEl("h3", { text: "财务记录清单" });
    listTitleRow.createSpan({
      cls: "rslatte-finance-list-stats",
      text: `支出 ¥${totalExpense.toFixed(2)}，收入 ¥${totalIncome.toFixed(2)}`,
    });

    const filterBar = listSection.createDiv({ cls: "rslatte-finance-filter-bar" });

    const categoryFilter = filterBar.createDiv({ cls: "rslatte-finance-filter-item" });
    categoryFilter.createEl("label", { text: "财务分类：", cls: "rslatte-finance-filter-label" });
    const categorySelect = categoryFilter.createEl("select", { cls: "rslatte-finance-filter-select" });
    categorySelect.createEl("option", { text: "全部", value: "" });
    for (const cat of this.plugin.settings.financeCategories) {
      const opt = categorySelect.createEl("option", { text: cat.name, value: cat.id });
      if (cat.id === this._filterCategoryId) opt.selected = true;
    }
    categorySelect.onchange = (e) => {
      this._filterCategoryId = (e.target as HTMLSelectElement).value;
      this._filterSubcategory = "";
      void this.render();
    };

    const subcategoryFilter = filterBar.createDiv({ cls: "rslatte-finance-filter-item" });
    subcategoryFilter.createEl("label", { text: "财务子分类：", cls: "rslatte-finance-filter-label" });
    const subcategorySelect = subcategoryFilter.createEl("select", { cls: "rslatte-finance-filter-select" });
    subcategorySelect.createEl("option", { text: "全部", value: "" });
    if (this._filterCategoryId) {
      const category = this.plugin.settings.financeCategories.find((c) => c.id === this._filterCategoryId);
      if (category?.subCategories && category.subCategories.length > 0) {
        for (const sub of category.subCategories) {
          const opt = subcategorySelect.createEl("option", { text: sub, value: sub });
          if (sub === this._filterSubcategory) opt.selected = true;
        }
      }
    }
    subcategorySelect.onchange = (e) => {
      this._filterSubcategory = (e.target as HTMLSelectElement).value;
      void this.render();
    };
    if (!this._filterCategoryId) {
      subcategorySelect.disabled = true;
    }

    const typeFilter = filterBar.createDiv({ cls: "rslatte-finance-filter-item" });
    typeFilter.createEl("label", { text: "类型：", cls: "rslatte-finance-filter-label" });
    const typeSelect = typeFilter.createEl("select", { cls: "rslatte-finance-filter-select" });
    typeSelect.createEl("option", { text: "全部", value: "" });
    typeSelect.createEl("option", { text: "支出", value: "expense" });
    typeSelect.createEl("option", { text: "收入", value: "income" });
    typeSelect.value = this._filterType;
    typeSelect.onchange = (e) => {
      this._filterType = (e.target as HTMLSelectElement).value as "" | "income" | "expense";
      void this.render();
    };

    const finalFilteredRecords = filteredRecords.filter((record: any) => {
      if (this.isFinanceRecordDeleted(record)) return false;
      const categoryId = record.category_id || record.categoryId || "";
      if (this._filterCategoryId && categoryId !== this._filterCategoryId) return false;
      if (this._filterSubcategory) {
        const note = record.note || "";
        const { subcategory } = extractFinanceSubcategory(note);
        if (subcategory !== this._filterSubcategory) return false;
      }
      if (this._filterType && record.type !== this._filterType) return false;
      return true;
    });

    const emptyMessage =
      this._viewMode === "month" ? "该月份暂无符合条件的财务记录" : "该年份暂无符合条件的财务记录";

    if (finalFilteredRecords.length === 0) {
      listSection.createDiv({ cls: "rslatte-muted", text: emptyMessage });
    } else {
      const recordsByDate = new Map<string, any[]>();
      for (const record of finalFilteredRecords) {
        const dateKey = record.record_date || record.recordDate || "";
        if (!dateKey) continue;
        if (!recordsByDate.has(dateKey)) {
          recordsByDate.set(dateKey, []);
        }
        recordsByDate.get(dateKey)!.push(record);
      }

      const sortedDates = Array.from(recordsByDate.keys()).sort().reverse();
      const timeline = listSection.createDiv({ cls: "rslatte-timeline" });

      for (const dateKey of sortedDates) {
        const dateRecords = recordsByDate.get(dateKey)!;
        const daySection = timeline.createDiv({ cls: "rslatte-timeline-day" });
        daySection.createDiv({ cls: "rslatte-timeline-day-title", text: dateKey });
        const dayItems = daySection.createDiv({ cls: "rslatte-timeline-day-items" });

        for (const record of dateRecords) {
          this.renderTimelineItem(dayItems, record, dateKey);
        }
      }
    }

    if (seq !== this._renderSeq) return;
    this.maybeRunFinanceNavFlash(seq);
  }

  private isFinanceRecordDeleted(record: any): boolean {
    return (
      record.is_delete === true ||
      record.isDelete === true ||
      String(record.is_delete || record.isDelete || "").toLowerCase() === "true"
    );
  }

  /**
   * 「财务统计明细」页签：期间汇总、分类支出排行、分析索引缺失类告警、技术异常摘要与周期内条目样本
   */
  private async renderFinanceStatsDetail(
    parent: HTMLElement,
    periodRecords: any[],
    periodLabel: string,
    seq: number
  ): Promise<void> {
    parent.createEl("h3", { text: "财务统计明细", cls: "rslatte-finance-stats-main-title" });
    const snapActionRow = parent.createDiv({ cls: "rslatte-analysis-snapshot-bar" });
    if (this._viewMode === "month") {
      const mk = this._selectedMonth;
      new ButtonComponent(snapActionRow)
        .setButtonText("🔄刷新当前年月分析快照")
        .setTooltip(`按当前索引重算 ${mk} 月 stats / 规则告警；写入前轮转备份（与 Review 相同，主文件 + bak1 + bak2 共 3 版）`)
        .setCta()
        .onClick(() => {
          void (async () => {
            try {
              await writeFinanceAnalysisSnapshotsForMonths(this.plugin, [mk], "stats_tab_refresh", {
                backupExisting: true,
              });
              new Notice(`已刷新 ${mk} 月分析快照（至多保留 3 版）`);
              void this.render();
            } catch (e) {
              console.error("[RSLatte] refresh finance month snapshot failed", e);
              new Notice("刷新分析快照失败，请查看控制台");
            }
          })();
        });
      new ButtonComponent(snapActionRow)
        .setButtonText("↩回退快照版本")
        .setTooltip(`将 ${mk} 月的 stats、alerts 各回退一档（需存在 .bak1.json 链）`)
        .onClick(() => {
          void (async () => {
            try {
              const r = await restoreFinanceMonthSnapshotsFromBackup(this.plugin, mk);
              if (!r.stats && !r.alerts) {
                new Notice(`${mk} 月暂无可回退的备份（至少先成功刷新过一次才会生成 bak1）`);
                return;
              }
              new Notice(`已回退：stats ${r.stats ? "是" : "否"}，alerts ${r.alerts ? "是" : "否"}`);
              void this.render();
            } catch (e) {
              console.error("[RSLatte] rollback finance month snapshot failed", e);
              new Notice("回退快照失败");
            }
          })();
        });
    } else {
      snapActionRow.createEl("div", {
        cls: "rslatte-muted",
        text: "「年份」视图下请切换到「月份」后，再使用快照按钮。",
      });
    }
    const ruleGroupOf = (ruleId: string): string => {
      const s = String(ruleId ?? "").trim();
      const m = s.match(/^RULE_([A-Z0-9]+)_/);
      return (m?.[1] ?? "").toLowerCase();
    };
    const entryIdToRecord = new Map<string, any>();
    try {
      const [fActive, fArch] = await Promise.all([
        this.plugin.recordRSLatte?.getFinanceSnapshot?.(false),
        this.plugin.recordRSLatte?.getFinanceSnapshot?.(true),
      ]);
      const all = [
        ...(Array.isArray((fActive as any)?.items) ? (fActive as any).items : []),
        ...(Array.isArray((fArch as any)?.items) ? (fArch as any).items : []),
      ];
      for (const r of all) {
        const eid = String((r as any)?.entryId ?? (r as any)?.entry_id ?? "").trim();
        if (!eid) continue;
        entryIdToRecord.set(eid, r);
      }
    } catch {
      // ignore
    }
    const mountRelatedEntryButton = (actionsEl: HTMLElement, parentEl: HTMLElement, alert: any) => {
      const ids = Array.isArray(alert?.relatedEntryIds) ? alert.relatedEntryIds.map((x: any) => String(x ?? "").trim()).filter(Boolean) : [];
      if (!ids.length) return;
      const items: FinanceRelatedEntryItem[] = [];
      for (const eid of ids) {
        const rec = entryIdToRecord.get(eid);
        if (!rec) continue;
        const dateKey = String((rec as any)?.recordDate ?? (rec as any)?.record_date ?? "").trim();
        const cid = String((rec as any)?.categoryId ?? (rec as any)?.category_id ?? "");
        const cat = this.plugin.settings.financeCategories.find((c) => c.id === cid);
        items.push({
          entryId: eid,
          recordDate: dateKey,
          categoryName: cat?.name || cid || "（未分类）",
          subcategory: String((rec as any)?.subcategory ?? "").trim() || undefined,
          amount: Number((rec as any)?.amount ?? 0),
          type: String((rec as any)?.type ?? "expense") === "income" ? "income" : "expense",
          institutionName: String((rec as any)?.institutionName ?? "").trim() || undefined,
        });
      }
      const relatedBtn = actionsEl.createEl("button", { cls: "rslatte-finance-alert-action-btn is-primary", text: `关联${ids.length}条` });
      relatedBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!items.length) {
          new Notice("索引中未找到这些关联记录，请先尝试重建财务索引");
          return;
        }
        new FinanceRelatedEntriesModal(
          this.app,
          `${String(alert?.title ?? "告警")} · 关联记录`,
          items,
          async (entryId: string) => {
            const rec = entryIdToRecord.get(entryId);
            if (!rec) {
              new Notice(`未找到 entry_id=${entryId} 的记录`);
              return;
            }
            const dateKey = String((rec as any)?.recordDate ?? (rec as any)?.record_date ?? "").trim();
            try {
              await this.openFinanceRecordInDiary(rec, dateKey);
            } catch (err) {
              console.error("[RSLatte] open related finance by entry_id failed", err);
              new Notice("打开关联财务记录失败");
            }
          }
        ).open();
      };
      if (!items.length) {
        parentEl.createDiv({ cls: "rslatte-muted", text: "索引中未找到这些关联 entry_id 的记录（可尝试先重建财务索引）。" });
      }
    };
    const passAlertFilter = (a: any): boolean => {
      const sev = String(a?.severity ?? "").toLowerCase();
      const st = String(a?.status ?? "").toLowerCase();
      const rg = ruleGroupOf(String(a?.ruleId ?? ""));
      if (this._statsAlertSeverityFilter && sev !== this._statsAlertSeverityFilter) return false;
      if (this._statsAlertStatusFilter && st !== this._statsAlertStatusFilter) return false;
      if (this._statsAlertRuleGroupFilter && rg !== this._statsAlertRuleGroupFilter) return false;
      return true;
    };
    const getAlertVisibilityKey = (a: any): string => {
      const fp = String((a as any)?.alertFingerprint ?? "").trim();
      if (fp) return `fp:${fp}`;
      const rid = String((a as any)?.ruleId ?? "").trim();
      const ep = String((a as any)?.effectivePeriod ?? periodLabel).trim();
      const msg = String((a as any)?.message ?? "").trim();
      return `raw:${rid}|${ep}|${msg}`;
    };
    const hiddenMap = await this.readFinanceAlertHiddenMap();
    const isAlertVisible = (a: any): boolean => {
      const key = getAlertVisibilityKey(a);
      const until = String(hiddenMap[key] ?? "").trim();
      if (!until) return true;
      const now = Date.now();
      const ms = Date.parse(until);
      if (!Number.isFinite(ms)) return true;
      return ms <= now;
    };
    const hideAlertForDays = async (a: any, days: number) => {
      const key = getAlertVisibilityKey(a);
      const next = await this.readFinanceAlertHiddenMap();
      const until = momentFn().add(Math.max(1, days), "days").toISOString();
      next[key] = until;
      await this.writeFinanceAlertHiddenMap(next);
      new Notice(`已确认：该告警将在 ${Math.max(1, days)} 天内隐藏`);
      void this.render();
    };
    const listHiddenAlertItems = () => {
      const entries = Object.entries(hiddenMap)
        .map(([key, hiddenUntil]) => ({ key, hiddenUntil: String(hiddenUntil ?? "") }))
        .filter((x) => !!x.hiddenUntil);
      entries.sort((a, b) => String(a.hiddenUntil).localeCompare(String(b.hiddenUntil)));
      return entries;
    };
    const collectPoolRefsFromObj = (o: Record<string, any> | null | undefined): string[] => {
      if (!o || typeof o !== "object") return [];
      const out: string[] = [];
      for (const [k, v] of Object.entries(o)) {
        if (!String(k).toLowerCase().endsWith("poolid")) continue;
        const s = String(v ?? "").trim();
        if (s) out.push(s);
      }
      return out;
    };
    const collectPoolRefsFromRuleLike = (ruleLike: Record<string, any> | null | undefined): string[] => {
      if (!ruleLike || typeof ruleLike !== "object") return [];
      const target = (ruleLike as any).target ?? {};
      const params = (ruleLike as any).params ?? {};
      const metricInputs = (params as any).metricInputs ?? {};
      const refs = [
        ...collectPoolRefsFromObj(target),
        ...collectPoolRefsFromObj(metricInputs),
      ];
      const conds = Array.isArray((params as any).conditions) ? (params as any).conditions : [];
      for (const c of conds) refs.push(...collectPoolRefsFromRuleLike(c));
      return Array.from(new Set(refs.filter(Boolean)));
    };
    const isSingleRecordRule = (ruleLike: Record<string, any> | null | undefined): boolean => {
      const params = ((ruleLike as any)?.params ?? {}) as Record<string, any>;
      const compareTarget = String(params?.compareTarget ?? "").trim();
      const valueScope = String(params?.valueScope ?? "").trim();
      if (compareTarget === "single_record" || valueScope === "single_record") return true;
      const conds = Array.isArray((params as any).conditions) ? (params as any).conditions : [];
      return conds.some((c: any) => isSingleRecordRule(c));
    };

    // 读取 index/snapshot：月视图直读单月；年视图按月快照聚合
    const monthKeyForSnapshot = this._viewMode === "month" ? this._selectedMonth : "";
    const yearMonthKeys =
      this._viewMode === "year"
        ? Array.from({ length: 12 }, (_x, i) => `${this._selectedYear}-${String(i + 1).padStart(2, "0")}`)
        : [];
    const [analysisIndex, monthStatsSnapshot, monthAlertsSnapshot, yearStatsSnapshots, yearAlertsSnapshots] = await Promise.all([
      readFinanceAnalysisIndex(this.plugin),
      monthKeyForSnapshot ? readFinanceStatsSnapshot(this.plugin, "month", monthKeyForSnapshot) : Promise.resolve(null),
      monthKeyForSnapshot ? readFinanceAlertsSnapshot(this.plugin, "month", monthKeyForSnapshot) : Promise.resolve(null),
      this._viewMode === "year"
        ? Promise.all(yearMonthKeys.map((k) => readFinanceStatsSnapshot(this.plugin, "month", k)))
        : Promise.resolve([]),
      this._viewMode === "year"
        ? Promise.all(yearMonthKeys.map((k) => readFinanceAlertsSnapshot(this.plugin, "month", k)))
        : Promise.resolve([]),
    ]);
    if (seq !== this._renderSeq) return;

    // 读取数据池配置（用于 DP_* 显示名）
    const poolNameById = new Map<string, string>();
    try {
      const root = String((this.plugin as any)?.getSpaceIndexDir?.() ?? "").trim();
      if (root) {
        const p = normalizePath(`${root}/finance-config/finance-data-pools.json`);
        const ok = await this.app.vault.adapter.exists(p);
        if (ok) {
          const raw = await this.app.vault.adapter.read(p);
          const j = JSON.parse(String(raw ?? "{}"));
          const items = Array.isArray(j?.items) ? j.items : [];
          for (const it of items) {
            const pid = String(it?.poolId ?? "").trim();
            if (!pid) continue;
            const label = String(it?.poolName ?? it?.title ?? pid).trim();
            poolNameById.set(pid, label || pid);
          }
        }
      }
    } catch {
      // ignore
    }

    let totalIncome = 0;
    let totalExpense = 0;
    let validCount = 0;
    const incomeByCat = new Map<string, number>();
    const expenseByCat = new Map<string, number>();

    for (const r of periodRecords) {
      if (this.isFinanceRecordDeleted(r)) continue;
      validCount++;
      const amt = Math.abs(Number(r.amount || 0));
      const cid = String(r.category_id || r.categoryId || "");
      const cat = this.plugin.settings.financeCategories.find((c) => c.id === cid);
      const cname = cat?.name || cid || "（未分类）";
      if (r.type === "income") {
        totalIncome += amt;
        incomeByCat.set(cname, (incomeByCat.get(cname) ?? 0) + amt);
      } else if (r.type === "expense") {
        totalExpense += amt;
        expenseByCat.set(cname, (expenseByCat.get(cname) ?? 0) + amt);
      }
    }

    const surplus = totalIncome - totalExpense;
    const yearStatsValid = (yearStatsSnapshots ?? []).filter((x) => !!x);
    const yearAlertsValid = (yearAlertsSnapshots ?? []).filter((x) => !!x);
    const mergedYearPoolStats = new Map<string, number>();
    for (const s of yearStatsValid as any[]) {
      const ps = s?.poolStats ?? {};
      for (const [k, v] of Object.entries(ps)) {
        mergedYearPoolStats.set(String(k), (mergedYearPoolStats.get(String(k)) ?? 0) + Number(v ?? 0));
      }
    }
    const mergedYearAlert = {
      total: (yearAlertsValid as any[]).reduce((n, x) => n + Number(x?.summary?.total ?? 0), 0),
      high: (yearAlertsValid as any[]).reduce((n, x) => n + Number(x?.summary?.high ?? 0), 0),
      warning: (yearAlertsValid as any[]).reduce((n, x) => n + Number(x?.summary?.warning ?? 0), 0),
      notice: (yearAlertsValid as any[]).reduce((n, x) => n + Number(x?.summary?.notice ?? 0), 0),
    };

    const statsFromSnapshot = this._viewMode === "month" ? monthStatsSnapshot : null;
    const kpiValidCount =
      this._viewMode === "year"
        ? (yearStatsValid as any[]).reduce((n, x) => n + Number(x?.summary?.validCount ?? 0), 0)
        : statsFromSnapshot
          ? Number(statsFromSnapshot.summary?.validCount ?? 0)
          : validCount;
    const kpiIncome =
      this._viewMode === "year"
        ? (yearStatsValid as any[]).reduce((n, x) => n + Number(x?.summary?.incomeTotal ?? 0), 0)
        : statsFromSnapshot
          ? Number(statsFromSnapshot.summary?.incomeTotal ?? 0)
          : totalIncome;
    const kpiExpense =
      this._viewMode === "year"
        ? (yearStatsValid as any[]).reduce((n, x) => n + Number(x?.summary?.expenseTotal ?? 0), 0)
        : statsFromSnapshot
          ? Number(statsFromSnapshot.summary?.expenseTotal ?? 0)
          : totalExpense;
    const kpiBalance =
      this._viewMode === "year"
        ? (yearStatsValid as any[]).reduce((n, x) => n + Number(x?.summary?.balance ?? 0), 0)
        : statsFromSnapshot
          ? Number(statsFromSnapshot.summary?.balance ?? 0)
          : surplus;

    const sumBlock = parent.createDiv({ cls: "rslatte-finance-stats-block" });
    sumBlock.createEl("h4", { text: `统计汇总（${periodLabel}）` });
    if (this._viewMode === "month" && monthStatsSnapshot) {
      sumBlock.createDiv({
        cls: "rslatte-finance-stats-meta",
        text: `读取源：snapshot（月）${monthStatsSnapshot.periodKey} · 生成时间 ${monthStatsSnapshot.generatedAt || "—"}`,
      });
    } else if (this._viewMode === "year" && yearStatsValid.length > 0) {
      sumBlock.createDiv({
        cls: "rslatte-finance-stats-meta",
        text: `读取源：snapshot（月聚合）· 命中 ${yearStatsValid.length}/12 个月`,
      });
    } else if (analysisIndex?.latest) {
      sumBlock.createDiv({
        cls: "rslatte-muted",
        text: `未命中当期 snapshot，当前显示为现算结果（latest: ${analysisIndex.latest.periodKey}）。`,
      });
    }
    const sumGrid = sumBlock.createDiv({ cls: "rslatte-finance-stats-kv" });
    const addKv = (k: string, v: string) => {
      const row = sumGrid.createDiv({ cls: "rslatte-finance-stats-kv-row" });
      row.createSpan({ cls: "rslatte-finance-stats-k", text: k });
      row.createSpan({ cls: "rslatte-finance-stats-v", text: v });
    };
    addKv("有效笔数", String(kpiValidCount));
    addKv("总收入", `¥${kpiIncome.toFixed(2)}`);
    addKv("总支出", `¥${kpiExpense.toFixed(2)}`);
    addKv("结余（收入−支出）", `¥${kpiBalance.toFixed(2)}`);
    if (this._viewMode === "month" && monthStatsSnapshot?.summary?.budgetUsageRatio != null) {
      const pct = Number(monthStatsSnapshot.summary.budgetUsageRatio) * 100;
      addKv("预算使用率", `${pct.toFixed(1)}%`);
    }

    const expBlock = parent.createDiv({ cls: "rslatte-finance-stats-block" });
    expBlock.createEl("h4", { text: "数据池汇总（本期间）" });
    const periodPoolEntries =
      this._viewMode === "year"
        ? [...mergedYearPoolStats.entries()]
        : monthStatsSnapshot
          ? Object.entries(monthStatsSnapshot.poolStats ?? {}).map(([k, v]) => [k, Number(v ?? 0)] as [string, number])
          : [];
    const periodPoolMap = new Map<string, number>(periodPoolEntries.map(([k, v]) => [String(k), Number(v ?? 0)]));
    if (periodPoolEntries.length > 0) {
      const sortedPool = periodPoolEntries
        .filter(([_k, v]) => Number(v) > 0)
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .slice(0, 12);
      if (sortedPool.length === 0) {
        expBlock.createDiv({ cls: "rslatte-muted", text: "snapshot 中暂无正向数据池金额。" });
      } else {
        const ul = expBlock.createEl("ul", { cls: "rslatte-finance-stats-cat-list" });
        for (const [pid, v] of sortedPool) {
          const li = ul.createEl("li");
          const pName = poolNameById.get(String(pid)) || String(pid);
          li.setText(`${pName}（${pid}）：¥${Number(v).toFixed(2)}`);
        }
      }
      expBlock.createDiv({ cls: "rslatte-muted", text: "注：统计按数据池口径展示（已优先映射池名称），用于稳定承接规则与预算分析。" });
    } else {
      expBlock.createDiv({ cls: "rslatte-muted", text: "未命中 snapshot，当前回退到现算分类统计。" });
    }

    const incBlock = parent.createDiv({ cls: "rslatte-finance-stats-block" });
    incBlock.createEl("h4", { text: "衍生指标（本期间）" });
    const derived =
      this._viewMode === "year"
        ? {
            cashflow_gap: kpiExpense - kpiIncome,
            surplus_rate: kpiIncome > 0 ? (kpiIncome - kpiExpense) / kpiIncome : undefined,
          }
        : monthStatsSnapshot?.derivedMetrics;
    if (derived) {
      const ul = incBlock.createEl("ul", { cls: "rslatte-finance-stats-cat-list" });
      ul.createEl("li", { text: `现金流缺口（支出-收入）：${Number(derived.cashflow_gap ?? 0).toFixed(2)}` });
      if (derived.surplus_rate != null) ul.createEl("li", { text: `结余率：${(Number(derived.surplus_rate) * 100).toFixed(2)}%` });
      if ((derived as any).free_expense_ratio != null) ul.createEl("li", { text: `自由支出占收入比：${(Number((derived as any).free_expense_ratio) * 100).toFixed(2)}%` });
      if ((derived as any).essential_expense_ratio != null) ul.createEl("li", { text: `刚需支出占收入比：${(Number((derived as any).essential_expense_ratio) * 100).toFixed(2)}%` });
    } else {
      incBlock.createDiv({ cls: "rslatte-muted", text: "未命中 snapshot 衍生指标，后续会继续补齐。" });
    }

    const alertBlock = parent.createDiv({ cls: "rslatte-finance-stats-block" });
    alertBlock.createEl("h4", { text: "分析基础告警（财务分析索引）" });
    const idx = await readFinanceAnalysisAlertIndex(this.plugin);
    if (seq !== this._renderSeq) return;

    // 期间级门闩：当前视图期间无有效流水时，给出显式告警（避免误以为“无告警=数据正常”）
    const periodMissingItems: Array<{ title: string; detail: string; hint?: string }> = [];
    if (this._viewMode === "month") {
      if (kpiValidCount <= 0) {
        periodMissingItems.push({
          title: "当前月份缺少财务流水",
          detail: `所选月份 ${this._selectedMonth} 没有有效财务记录，统计与规则结果可能为空或不完整。`,
          hint: "请在该月份补录收入/支出流水后再执行财务刷新或重建。",
        });
      }
    } else {
      if (kpiValidCount <= 0) {
        periodMissingItems.push({
          title: "当前年份缺少财务流水",
          detail: `所选年份 ${this._selectedYear} 没有有效财务记录，统计与规则结果可能为空或不完整。`,
          hint: "请在该年份补录流水后再执行财务刷新或重建。",
        });
      }
    }
    if (periodMissingItems.length) {
      alertBlock.createDiv({
        cls: "rslatte-db-warn",
        text: `期间门闩：${periodMissingItems.map((x) => x.title).join("；")}`,
      });
      const ul = alertBlock.createEl("ul", { cls: "rslatte-finance-stats-alert-list" });
      for (const it of periodMissingItems) {
        const li = ul.createEl("li");
        li.createDiv({ cls: "rslatte-finance-stats-alert-title", text: it.title });
        li.createDiv({ cls: "rslatte-finance-stats-alert-detail", text: it.detail });
        if (it.hint) li.createDiv({ cls: "rslatte-finance-stats-alert-hint", text: `提示：${it.hint}` });
      }
    }

    if (!idx) {
      alertBlock.createDiv({
        cls: "rslatte-muted",
        text: "尚未生成 finance-analysis.alert-index.json。请先执行财务「刷新」或「重建索引」。",
      });
    } else {
      const meta = alertBlock.createDiv({ cls: "rslatte-finance-stats-meta" });
      meta.setText(
        `索引状态：${idx.status} · 生成时间 ${idx.generatedAt || "—"} · 缺失项 ${idx.summary?.missingCount ?? 0}`
      );
      if (!idx.missingData?.length) {
        alertBlock.createDiv({ cls: "rslatte-muted", text: "当前无「基础数据缺失」类告警。" });
      } else {
        const ul = alertBlock.createEl("ul", { cls: "rslatte-finance-stats-alert-list" });
        for (const it of idx.missingData) {
          const li = ul.createEl("li");
          li.createDiv({ cls: "rslatte-finance-stats-alert-title", text: it.title });
          const d = li.createDiv({ cls: "rslatte-finance-stats-alert-detail" });
          d.setText(it.detail);
          if (it.hint) {
            li.createDiv({ cls: "rslatte-finance-stats-alert-hint", text: `提示：${it.hint}` });
          }
        }
      }
    }

    const bizBlock = parent.createDiv({ cls: "rslatte-finance-stats-block" });
    bizBlock.createEl("h4", { text: "业务告警（规则 JSON 分析结果）" });

    // 动态空池告警：按当前期间扫描「已启用规则 -> 依赖池 -> poolStats」
    const generatedPoolEmptyAlerts: any[] = [];
    try {
      const root = String((this.plugin as any)?.getSpaceIndexDir?.() ?? "").trim();
      if (root) {
        const rulesPath = normalizePath(`${root}/finance-config/finance-rules.json`);
        const okRules = await this.app.vault.adapter.exists(rulesPath);
        if (okRules && periodPoolMap.size > 0) {
          const rawRules = await this.app.vault.adapter.read(rulesPath);
          const jRules = JSON.parse(String(rawRules ?? "{}"));
          const rulesObj = jRules && typeof jRules === "object" && jRules.rules && typeof jRules.rules === "object"
            ? (jRules.rules as Record<string, any>)
            : {};
          for (const [ruleId, rule] of Object.entries(rulesObj)) {
            if (!rule || typeof rule !== "object") continue;
            if ((rule as any).enabled === false) continue;
            const pools = collectPoolRefsFromRuleLike(rule as any);
            if (!pools.length) continue;
            const missingPools = pools.filter((pid) => Number(periodPoolMap.get(pid) ?? 0) <= 0);
            if (!missingPools.length) continue;
            const singleLike = isSingleRecordRule(rule as any);
            const severity = singleLike ? "warning" : "notice";
            const rg = ruleGroupOf(String(ruleId));
            generatedPoolEmptyAlerts.push({
              severity,
              status: "new",
              ruleId: String(ruleId),
              title: singleLike ? "规则依赖数据池为空（单条类）" : "规则依赖数据池为空（周期类）",
              message: `${String((rule as any)?.message?.title ?? ruleId)}：当前期间以下依赖池无数据：${missingPools.join("、")}`,
              algorithmId: String((rule as any)?.algorithmId ?? ""),
              relatedEntryIds: [],
              ruleGroup: rg,
              explain: { missingPools, poolCount: pools.length, singleRecordLike: singleLike },
              _syntheticPoolEmpty: true,
            });
          }
        }
      }
    } catch (e) {
      console.warn("[RSLatte] build synthetic pool-empty alerts failed", e);
    }
    // 月视图必须只使用 snapshots/month/{YYYY-MM}.alerts.json；勿回退到 finance-rules.alerts.json
    //（后者在刷新时固定按「当前月」生成，会导致选 2 月却看到 3 月告警）。
    const allAlertsForGroups: any[] =
      this._viewMode === "year"
        ? (yearAlertsValid as any[]).flatMap((x: any) => (Array.isArray(x?.items) ? x.items : []))
        : Array.isArray(monthAlertsSnapshot?.items)
          ? monthAlertsSnapshot!.items
          : [];
    allAlertsForGroups.push(...generatedPoolEmptyAlerts);
    const groupSet = new Set<string>();
    for (const a of allAlertsForGroups) {
      const g = ruleGroupOf(String(a?.ruleId ?? ""));
      if (g) groupSet.add(g);
    }
    const groupOptions = [...groupSet].sort();
    if (this._statsAlertRuleGroupFilter && !groupSet.has(this._statsAlertRuleGroupFilter)) {
      this._statsAlertRuleGroupFilter = "";
    }
    const filterBar = bizBlock.createDiv({ cls: "rslatte-finance-filter-bar" });
    const sevWrap = filterBar.createDiv({ cls: "rslatte-finance-filter-item" });
    sevWrap.createEl("label", { text: "严重度：", cls: "rslatte-finance-filter-label" });
    const sevSel = sevWrap.createEl("select", { cls: "rslatte-finance-filter-select" });
    sevSel.createEl("option", { value: "", text: "全部" });
    sevSel.createEl("option", { value: "high", text: "high" });
    sevSel.createEl("option", { value: "warning", text: "warning" });
    sevSel.createEl("option", { value: "notice", text: "notice" });
    sevSel.value = this._statsAlertSeverityFilter;
    sevSel.onchange = (e) => {
      this._statsAlertSeverityFilter = String((e.target as HTMLSelectElement).value || "") as any;
      this._statsAlertPage = 1;
      void this.render();
    };
    const stWrap = filterBar.createDiv({ cls: "rslatte-finance-filter-item" });
    stWrap.createEl("label", { text: "状态：", cls: "rslatte-finance-filter-label" });
    const stSel = stWrap.createEl("select", { cls: "rslatte-finance-filter-select" });
    stSel.createEl("option", { value: "", text: "全部" });
    stSel.createEl("option", { value: "new", text: "new" });
    stSel.createEl("option", { value: "ongoing", text: "ongoing" });
    stSel.createEl("option", { value: "resolved", text: "resolved" });
    stSel.createEl("option", { value: "ignored", text: "ignored" });
    stSel.value = this._statsAlertStatusFilter;
    stSel.onchange = (e) => {
      this._statsAlertStatusFilter = String((e.target as HTMLSelectElement).value || "") as any;
      this._statsAlertPage = 1;
      void this.render();
    };
    const rgWrap = filterBar.createDiv({ cls: "rslatte-finance-filter-item" });
    rgWrap.createEl("label", { text: "分组：", cls: "rslatte-finance-filter-label" });
    const rgSel = rgWrap.createEl("select", { cls: "rslatte-finance-filter-select" });
    rgSel.createEl("option", { value: "", text: "全部" });
    for (const g of groupOptions) rgSel.createEl("option", { value: g, text: g });
    rgSel.value = this._statsAlertRuleGroupFilter;
    rgSel.onchange = (e) => {
      this._statsAlertRuleGroupFilter = String((e.target as HTMLSelectElement).value || "");
      this._statsAlertPage = 1;
      void this.render();
    };
    const mgmtWrap = filterBar.createDiv({ cls: "rslatte-finance-filter-item" });
    const mgmtBtn = mgmtWrap.createEl("button", { cls: "rslatte-finance-cancel-icon-btn", text: `已隐藏告警管理（${listHiddenAlertItems().length}）` });
    mgmtBtn.title = "查看/恢复短期隐藏的告警";
    mgmtBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const items = listHiddenAlertItems();
      new FinanceHiddenAlertsModal(
        this.app,
        items,
        async (key: string) => {
          const next = await this.readFinanceAlertHiddenMap();
          delete next[key];
          await this.writeFinanceAlertHiddenMap(next);
          new Notice("已恢复该隐藏告警");
          void this.render();
        },
        async () => {
          await this.writeFinanceAlertHiddenMap({});
          new Notice("已恢复全部隐藏告警");
          void this.render();
        }
      ).open();
    };
    const biz = await readFinanceRulesAlertSnapshot(this.plugin);
    if (seq !== this._renderSeq) return;
    if (this._viewMode === "year" && yearAlertsValid.length > 0) {
      bizBlock.createDiv({
        cls: "rslatte-finance-stats-meta",
        text: `读取源：alerts snapshot（月聚合）· 命中 ${yearAlertsValid.length}/12 个月 · 告警 ${mergedYearAlert.total}（high ${mergedYearAlert.high} / warning ${mergedYearAlert.warning} / notice ${mergedYearAlert.notice}）`,
      });
      const syntheticYearAlerts = generatedPoolEmptyAlerts.filter((a) => passAlertFilter(a) && isAlertVisible(a));
      if (syntheticYearAlerts.length > 0) {
        const syn = bizBlock.createDiv({ cls: "rslatte-finance-stats-sub" });
        syn.createEl("h5", { text: `期间动态空池告警（${syntheticYearAlerts.length} 条）` });
        const ul = syn.createEl("ul", { cls: "rslatte-finance-stats-alert-list" });
        for (const a of syntheticYearAlerts.slice(0, 6)) {
          const li = ul.createEl("li");
          li.createDiv({
            cls: "rslatte-finance-stats-alert-title",
            text: `${String(a.severity).toUpperCase()} · [${String(a.status)}] · ${a.title}`,
          });
          li.createDiv({ cls: "rslatte-finance-stats-alert-detail", text: a.message });
          const actions = li.createDiv({ cls: "rslatte-finance-alert-actions" });
          const ack = actions.createEl("button", { cls: "rslatte-finance-alert-action-btn is-secondary", text: "确认" });
          ack.title = "短期隐藏该告警（7天）";
          ack.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            void hideAlertForDays(a, 7);
          };
        }
      }
      const monthList = bizBlock.createDiv({ cls: "rslatte-finance-stats-sub" });
      monthList.createEl("h5", { text: "按月告警（可展开，展示每月前 6 条）" });
      for (let i = 0; i < yearMonthKeys.length; i++) {
        const mKey = yearMonthKeys[i];
        const mSnap: any = (yearAlertsSnapshots as any[])[i];
        if (!mSnap) continue;
        const details = monthList.createEl("details");
        const summary = details.createEl("summary");
        summary.setText(
          `${mKey} · ${Number(mSnap?.summary?.total ?? 0)} 条（high ${Number(mSnap?.summary?.high ?? 0)} / warning ${Number(mSnap?.summary?.warning ?? 0)} / notice ${Number(mSnap?.summary?.notice ?? 0)}）`
        );
        const items = Array.isArray(mSnap?.items) ? mSnap.items : [];
        const filteredItems = items.filter((a: any) => passAlertFilter(a));
        if (items.length === 0) {
          details.createDiv({ cls: "rslatte-muted", text: "该月无告警。" });
          continue;
        }
        if (filteredItems.length === 0) {
          details.createDiv({ cls: "rslatte-muted", text: "该月无符合筛选条件的告警。" });
          continue;
        }
        const ul = details.createEl("ul", { cls: "rslatte-finance-stats-alert-list" });
        for (const a of filteredItems.slice(0, 6)) {
          const li = ul.createEl("li");
          li.createDiv({
            cls: "rslatte-finance-stats-alert-title",
            text: `${a.severity?.toUpperCase?.() ?? ""} · [${String(a.status ?? "new")}] · ${a.title}`,
          });
          li.createDiv({ cls: "rslatte-finance-stats-alert-detail", text: a.message });
          const actions = li.createDiv({ cls: "rslatte-finance-actions" });
          mountRelatedEntryButton(actions, li, a);
          const ack = actions.createEl("button", { cls: "rslatte-finance-cancel-icon-btn", text: "确认" });
          ack.title = "短期隐藏该告警（7天）";
          ack.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            void hideAlertForDays(a, 7);
          };
        }
        if (filteredItems.length > 6) {
          details.createDiv({ cls: "rslatte-muted", text: `… 另有 ${filteredItems.length - 6} 条` });
        }
      }
    } else if (this._viewMode === "month" && !monthAlertsSnapshot) {
      bizBlock.createDiv({
        cls: "rslatte-finance-stats-meta",
        text: `未命中所选月份 ${this._selectedMonth} 的规则告警快照（finance-analysis/snapshots/month/${this._selectedMonth}.alerts.json）。请执行财务「刷新」或「重建索引」以生成该月数据。为避免误读，此处不展示全局 finance-rules.alerts.json（其「本期」为最近一次刷新时的自然月，可能与所选月份不一致）。`,
      });
      const synthOnly = generatedPoolEmptyAlerts.filter((a) => passAlertFilter(a) && isAlertVisible(a));
      if (synthOnly.length === 0) {
        bizBlock.createDiv({
          cls: "rslatte-muted",
          text: "当前无可展示的期间内规则告警（若已有快照仍为空，表示该月规则分析无命中条目）。",
        });
      } else {
        const syn = bizBlock.createDiv({ cls: "rslatte-finance-stats-sub" });
        syn.createEl("h5", { text: `期间动态空池告警（${synthOnly.length} 条）` });
        const ul = syn.createEl("ul", { cls: "rslatte-finance-stats-alert-list" });
        const cap = FinanceSidePanelView.STATS_ALERT_PAGE_SIZE;
        for (const a of synthOnly.slice(0, cap)) {
          const li = ul.createEl("li");
          li.createDiv({
            cls: "rslatte-finance-stats-alert-title",
            text: `${String(a.severity).toUpperCase()} · [${String(a.status)}] · ${a.title}`,
          });
          li.createDiv({ cls: "rslatte-finance-stats-alert-detail", text: a.message });
          const actions = li.createDiv({ cls: "rslatte-finance-alert-actions" });
          const ack = actions.createEl("button", { cls: "rslatte-finance-alert-action-btn is-secondary", text: "确认" });
          ack.title = "短期隐藏该告警（7天）";
          ack.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            void hideAlertForDays(a, 7);
          };
        }
        if (synthOnly.length > cap) {
          syn.createDiv({ cls: "rslatte-muted", text: `… 另有 ${synthOnly.length - cap} 条` });
        }
      }
    } else if (monthAlertsSnapshot) {
      bizBlock.createDiv({
        cls: "rslatte-finance-stats-meta",
        text: `读取源：alerts snapshot（月）${monthAlertsSnapshot.periodKey} · 生成时间 ${monthAlertsSnapshot.generatedAt || "—"} · 告警 ${monthAlertsSnapshot.summary?.total ?? monthAlertsSnapshot.items?.length ?? 0}（high ${monthAlertsSnapshot.summary?.high ?? 0} / warning ${monthAlertsSnapshot.summary?.warning ?? 0} / notice ${monthAlertsSnapshot.summary?.notice ?? 0}）`,
      });
      const alerts = [...(Array.isArray(monthAlertsSnapshot.items) ? monthAlertsSnapshot.items : []), ...generatedPoolEmptyAlerts]
        .filter((a) => passAlertFilter(a) && isAlertVisible(a));
      if (alerts.length === 0) {
        bizBlock.createDiv({ cls: "rslatte-muted", text: "当前周期无符合筛选条件的告警。" });
      } else {
        const pageSize = FinanceSidePanelView.STATS_ALERT_PAGE_SIZE;
        const totalPages = Math.max(1, Math.ceil(alerts.length / pageSize));
        let currentPage = Math.min(Math.max(1, this._statsAlertPage), totalPages);
        this._statsAlertPage = currentPage;
        const listHost = bizBlock.createDiv();
        const pagerHost = bizBlock.createDiv({ cls: "rslatte-finance-actions" });
        const renderPage = () => {
          listHost.empty();
          pagerHost.empty();
          const start = (currentPage - 1) * pageSize;
          const end = Math.min(alerts.length, start + pageSize);
          const pageAlerts = alerts.slice(start, end);
          const ul = listHost.createEl("ul", { cls: "rslatte-finance-stats-alert-list" });
          for (const a of pageAlerts) {
            const li = ul.createEl("li");
            li.createDiv({
              cls: "rslatte-finance-stats-alert-title",
              text: `${a.severity?.toUpperCase?.() ?? ""} · [${String((a as any).status ?? "new")}] · ${a.title}`,
            });
            li.createDiv({ cls: "rslatte-finance-stats-alert-detail", text: a.message });
            const extra = [];
            if (a.ruleId) extra.push(a.ruleId);
            if (a.algorithmId) extra.push(a.algorithmId);
            if (extra.length) li.createDiv({ cls: "rslatte-finance-stats-alert-hint", text: extra.join(" · ") });
            const actions = li.createDiv({ cls: "rslatte-finance-alert-actions" });
            mountRelatedEntryButton(actions, li, a);
            const ack = actions.createEl("button", { cls: "rslatte-finance-alert-action-btn is-secondary", text: "确认" });
            ack.title = "短期隐藏该告警（7天）";
            ack.onclick = (e) => {
              e.preventDefault();
              e.stopPropagation();
              void hideAlertForDays(a, 7);
            };
          }
          const firstBtn = pagerHost.createEl("button", { cls: "rslatte-finance-cancel-icon-btn", text: "<<" });
          firstBtn.title = "第一页";
          firstBtn.disabled = currentPage <= 1;
          firstBtn.onclick = () => {
            if (currentPage <= 1) return;
            currentPage = 1;
            this._statsAlertPage = currentPage;
            renderPage();
          };
          const prevBtn = pagerHost.createEl("button", { cls: "rslatte-finance-cancel-icon-btn", text: "上一页" });
          prevBtn.disabled = currentPage <= 1;
          prevBtn.onclick = () => {
            if (currentPage <= 1) return;
            currentPage -= 1;
            this._statsAlertPage = currentPage;
            renderPage();
          };
          pagerHost.createSpan({ cls: "rslatte-muted", text: `第 ${currentPage}/${totalPages} 页` });
          const nextBtn = pagerHost.createEl("button", { cls: "rslatte-finance-cancel-icon-btn", text: "下一页" });
          nextBtn.disabled = currentPage >= totalPages;
          nextBtn.onclick = () => {
            if (currentPage >= totalPages) return;
            currentPage += 1;
            this._statsAlertPage = currentPage;
            renderPage();
          };
          const lastBtn = pagerHost.createEl("button", { cls: "rslatte-finance-cancel-icon-btn", text: ">>" });
          lastBtn.title = "最后一页";
          lastBtn.disabled = currentPage >= totalPages;
          lastBtn.onclick = () => {
            if (currentPage >= totalPages) return;
            currentPage = totalPages;
            this._statsAlertPage = currentPage;
            renderPage();
          };
        };
        renderPage();
      }
    } else if (!biz) {
      bizBlock.createDiv({
        cls: "rslatte-muted",
        text: "尚未生成 finance-rules.alerts.json。请先执行财务「刷新」或「重建索引」。",
      });
    } else {
      bizBlock.createDiv({
        cls: "rslatte-finance-stats-meta",
        text: `生成时间 ${biz.generatedAt || "—"} · 本期 ${biz.periodKey || "—"} · 告警 ${biz.summary?.total ?? biz.alerts?.length ?? 0}（high ${biz.summary?.high ?? 0} / warning ${biz.summary?.warning ?? 0} / notice ${biz.summary?.notice ?? 0}）`,
      });
      if (biz.issues?.length) {
        bizBlock.createDiv({
          cls: "rslatte-db-warn",
          text: `规则执行前置问题：${biz.issues.slice(0, 6).join("；")}${biz.issues.length > 6 ? "…" : ""}`,
        });
      }
      const alerts = [...(Array.isArray(biz.alerts) ? biz.alerts : []), ...generatedPoolEmptyAlerts]
        .filter((a) => passAlertFilter(a) && isAlertVisible(a));
      if (alerts.length === 0) {
        bizBlock.createDiv({ cls: "rslatte-muted", text: "当前周期无符合筛选条件的告警。" });
      } else {
        const pageSize = FinanceSidePanelView.STATS_ALERT_PAGE_SIZE;
        const totalPages = Math.max(1, Math.ceil(alerts.length / pageSize));
        let currentPage = Math.min(Math.max(1, this._statsAlertPage), totalPages);
        this._statsAlertPage = currentPage;
        const listHost = bizBlock.createDiv();
        const pagerHost = bizBlock.createDiv({ cls: "rslatte-finance-actions" });
        const renderPage = () => {
          listHost.empty();
          pagerHost.empty();
          const start = (currentPage - 1) * pageSize;
          const end = Math.min(alerts.length, start + pageSize);
          const pageAlerts = alerts.slice(start, end);
          const ul = listHost.createEl("ul", { cls: "rslatte-finance-stats-alert-list" });
          for (const a of pageAlerts) {
            const li = ul.createEl("li");
            li.createDiv({
              cls: "rslatte-finance-stats-alert-title",
              text: `${a.severity?.toUpperCase?.() ?? ""} · [${String((a as any).status ?? "new")}] · ${a.title}`,
            });
            li.createDiv({ cls: "rslatte-finance-stats-alert-detail", text: a.message });
            const extra = [];
            if (a.algorithmId) extra.push(a.algorithmId);
            if (extra.length) li.createDiv({ cls: "rslatte-finance-stats-alert-hint", text: extra.join(" · ") });
            const actions = li.createDiv({ cls: "rslatte-finance-alert-actions" });
            mountRelatedEntryButton(actions, li, a);
            const ack = actions.createEl("button", { cls: "rslatte-finance-alert-action-btn is-secondary", text: "确认" });
            ack.title = "短期隐藏该告警（7天）";
            ack.onclick = (e) => {
              e.preventDefault();
              e.stopPropagation();
              void hideAlertForDays(a, 7);
            };
          }
          const firstBtn = pagerHost.createEl("button", { cls: "rslatte-finance-cancel-icon-btn", text: "<<" });
          firstBtn.title = "第一页";
          firstBtn.disabled = currentPage <= 1;
          firstBtn.onclick = () => {
            if (currentPage <= 1) return;
            currentPage = 1;
            this._statsAlertPage = currentPage;
            renderPage();
          };
          const prevBtn = pagerHost.createEl("button", { cls: "rslatte-finance-cancel-icon-btn", text: "上一页" });
          prevBtn.disabled = currentPage <= 1;
          prevBtn.onclick = () => {
            if (currentPage <= 1) return;
            currentPage -= 1;
            this._statsAlertPage = currentPage;
            renderPage();
          };
          pagerHost.createSpan({ cls: "rslatte-muted", text: `第 ${currentPage}/${totalPages} 页` });
          const nextBtn = pagerHost.createEl("button", { cls: "rslatte-finance-cancel-icon-btn", text: "下一页" });
          nextBtn.disabled = currentPage >= totalPages;
          nextBtn.onclick = () => {
            if (currentPage >= totalPages) return;
            currentPage += 1;
            this._statsAlertPage = currentPage;
            renderPage();
          };
          const lastBtn = pagerHost.createEl("button", { cls: "rslatte-finance-cancel-icon-btn", text: ">>" });
          lastBtn.title = "最后一页";
          lastBtn.disabled = currentPage >= totalPages;
          lastBtn.onclick = () => {
            if (currentPage >= totalPages) return;
            currentPage = totalPages;
            this._statsAlertPage = currentPage;
            renderPage();
          };
        };
        renderPage();
      }
    }

    const techBlock = parent.createDiv({ cls: "rslatte-finance-stats-block" });
    techBlock.createEl("h4", { text: "流水技术异常（日记扫描）" });
    techBlock.createDiv({
      cls: "rslatte-muted",
      text: "以下为索引完整性问题（无 meta、重复 entry_id、缺 cycle_id 等）。与「规则 JSON / 预算超限」类业务告警不同；后者待分析引擎产出 alerts 快照后并入本节。",
    });

    let scan: FinanceAnomalyScanResult | null = null;
    try {
      scan = (await this.plugin.recordRSLatte?.scanFinanceAnomalies?.()) ?? null;
    } catch (e) {
      console.warn("[RSLatte] scanFinanceAnomalies in stats tab failed", e);
    }
    if (seq !== this._renderSeq) return;

    if (!scan) {
      techBlock.createDiv({ cls: "rslatte-muted", text: "无法执行扫描（记录服务未就绪）。" });
    } else {
      techBlock.createDiv({
        cls: "rslatte-finance-stats-meta",
        text: `摘要：无合法 meta ${scan.legacy.length} · 同文件重复 entry_id ${scan.duplicates.length} · 跨文件重复 ${scan.duplicateCrossFiles.length} · 缺 cycle_id ${scan.cycleIdMissing.length}（已扫日记 ${scan.scannedFileCount} 个）`,
      });
      const openBtn = techBlock.createEl("button", {
        type: "button",
        cls: "mod-cta rslatte-finance-stats-open-anomaly",
        text: "打开完整异常清单…",
      });
      openBtn.onclick = () => {
        new FinanceAnomalyModal(this.app, this.plugin).open();
      };

      const dayInPeriod = (dayKey: string) => {
        if (this._viewMode === "month") return String(dayKey).startsWith(this._selectedMonth);
        return String(dayKey).startsWith(`${this._selectedYear}-`);
      };

      const periodCycleMissing = scan.cycleIdMissing.filter((x) => dayInPeriod(x.dayKey));
      if (periodCycleMissing.length > 0) {
        const sub = techBlock.createDiv({ cls: "rslatte-finance-stats-sub" });
        sub.createEl("h5", {
          text: `本视图期间 · 缺 cycle_id（${periodCycleMissing.length} 条，展示前 12 条）`,
        });
        const ul = sub.createEl("ul", { cls: "rslatte-finance-stats-entry-list" });
        for (const it of periodCycleMissing.slice(0, 12)) {
          const li = ul.createEl("li");
          li.setText(`${it.dayKey} 行 ${it.lineNumber} · ${String(it.preview ?? "").slice(0, 96)}`);
        }
        if (periodCycleMissing.length > 12) {
          sub.createDiv({
            cls: "rslatte-muted",
            text: `… 另有 ${periodCycleMissing.length - 12} 条，请在「异常清单」中查看或修复。`,
          });
        }
      }
    }
  }

  /**
   * 渲染 timeline 样式的财务记录项
   */
  private renderTimelineItem(parent: HTMLElement, record: any, dateKey: string): void {
    const row = parent.createDiv({ cls: "rslatte-timeline-item rslatte-finance-timeline-item" });
    const entryIdForNav = String(record.entry_id || record.entryId || "").trim();
    if (entryIdForNav) row.dataset.entryId = entryIdForNav;
    row.style.cursor = "pointer";
    row.title = "点击打开日记并定位到该条记录";
    
    const gutter = row.createDiv({ cls: "rslatte-timeline-gutter" });
    const dot = gutter.createDiv({ cls: "rslatte-timeline-dot" });
    const isExpense = record.type === "expense";
    const isDeleted = record.is_delete === true || record.isDelete === true || String(record.is_delete || record.isDelete || "").toLowerCase() === "true";
    dot.setText(isDeleted ? "❌" : (isExpense ? "💰" : "💵"));
    gutter.createDiv({ cls: "rslatte-timeline-line" });

    const content = row.createDiv({ cls: "rslatte-timeline-content" });

    row.onclick = async (e) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("button")) return;
      try {
        await this.openFinanceRecordInDiary(record, dateKey);
      } catch (err) {
        console.error("[RSLatte] open finance in diary:", err);
        new Notice(String((err as Error)?.message ?? err ?? "打开失败"));
      }
    };

    // 标题行
    const titleRow = content.createDiv({ cls: "rslatte-timeline-title-row" });
    
    // 分类名称（修复 undefined 问题）
    const categoryId = record.category_id || record.categoryId || "";
    const category = this.plugin.settings.financeCategories.find(c => c.id === categoryId);
    const categoryName = category?.name || categoryId || "（未分类）";
    
    // 子分类（优先从统计缓存的 subcategory 字段获取，否则从 note 中提取）
    const note = record.note || "";
    let subcategory = record.subcategory || ""; // 统计缓存可能有 subcategory 字段
    if (!subcategory && note) {
      const extracted = extractFinanceSubcategory(note);
      subcategory = extracted.subcategory;
    }
    const subcategoryText = subcategory ? `【${subcategory}】` : "";
    
    const amount = Number(record.amount || 0);
    const amountText = isExpense ? `-¥${Math.abs(amount).toFixed(2)}` : `+¥${Math.abs(amount).toFixed(2)}`;
    
    const title = titleRow.createDiv({ cls: "rslatte-timeline-text" });
    title.setText(`${categoryName}${subcategoryText} ${amountText}`);
    
    // 取消按钮（仅对未取消的记录显示）- 使用❌样式，无边框和底色
    if (!isDeleted) {
      const actions = titleRow.createDiv({ cls: "rslatte-finance-actions" });
      const cancelBtn = actions.createEl("button", { text: "❌", cls: "rslatte-finance-cancel-icon-btn" });
      cancelBtn.title = "取消此财务记录";
      cancelBtn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await this.cancelFinanceRecord(record, dateKey);
        void this.render();
      };
    }

    // 备注信息（始终显示，如果有的话）
    // 从 note 中提取去除子分类后的正文
    if (note) {
      const { body: noteBody } = extractFinanceSubcategory(note);
      if (noteBody.trim()) {
        const meta = content.createDiv({ cls: "rslatte-timeline-meta" });
        meta.setText(noteBody.trim());
      }
    }
  }

  /** 从索引的 source 字段解析 0-based 主行行号；缺失时为 null */
  private pickFinanceSourceLine(record: any): number | null {
    const raw = record.sourceLineMain ?? record.source_line_main;
    if (raw === undefined || raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  /**
   * 打开该条财务所在日记，并将光标滚到主行（与 TaskSidePanelView.openTaskInFile 一致）
   */
  private async openFinanceRecordInDiary(record: any, dateKey: string): Promise<void> {
    let filePath = String(record.sourceFilePath ?? record.source_file_path ?? "").trim();
    let line0 = this.pickFinanceSourceLine(record);

    if (!filePath || line0 === null) {
      const resolvedPath = this.plugin.journalSvc.findDiaryPathForDateKey(dateKey);
      if (!resolvedPath) {
        new Notice("未找到该日期的日记文件");
        return;
      }
      const diaryFile = this.app.vault.getAbstractFileByPath(resolvedPath);
      if (!(diaryFile instanceof TFile)) {
        new Notice(`找不到文件：${resolvedPath}`);
        return;
      }
      const raw = await this.app.vault.read(diaryFile);
      const lines = raw.split("\n");
      const categoryId = String(record.category_id || record.categoryId || "");
      const type = (record.type || "expense") as "income" | "expense";
      const amount = Number(record.amount || 0);
      const entryId = String(record.entry_id || record.entryId || "").trim();
      const isDeleted =
        record.is_delete === true ||
        record.isDelete === true ||
        String(record.is_delete || record.isDelete || "").toLowerCase() === "true";
      const found = findFinanceMainLineIndexInDiaryLines(lines, dateKey, {
        entryId: entryId || undefined,
        categoryId,
        type,
        amount,
        isDelete: isDeleted,
      });
      if (found == null) {
        new Notice("无法在日记中定位该条记录，请尝试「扫描重建财务索引」");
        return;
      }
      filePath = resolvedPath;
      line0 = found;
    }

    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      new Notice(`找不到文件：${filePath}`);
      return;
    }

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file, { active: true, state: { mode: "source" } });

    window.setTimeout(() => {
      const view: any = leaf.view as any;
      const editor = view?.editor;
      if (!editor) return;
      const ln = Math.max(0, line0 ?? 0);
      try {
        editor.setCursor({ line: ln, ch: 0 });
        editor.scrollIntoView({ from: { line: ln, ch: 0 }, to: { line: ln + 1, ch: 0 } }, true);
      } catch {
        // ignore
      }
    }, 50);
  }

  /**
   * 取消财务记录（与打卡侧边栏的机制一致）
   */
  private async cancelFinanceRecord(record: any, dateKey: string): Promise<void> {
    const categoryId = record.category_id || record.categoryId || "";
    const category = this.plugin.settings.financeCategories.find(c => c.id === categoryId);
    const categoryName = category?.name || categoryId;
    const amount = Number(record.amount || 0);
    const type = (record.type || "expense") as "income" | "expense";
    const entryId = String(record.entry_id || record.entryId || "").trim();
    if (!entryId) {
      new Notice("该记录无 entry_id，请「扫描重建索引」或从今日打卡使用带 meta 的流程记账后再取消");
      return;
    }

    const priorMeta = extractFinanceMeta(String(record.note || ""));
    const sub =
      String(record.subcategory || "").trim() ||
      priorMeta.subcategory ||
      extractFinanceSubcategory(String(record.note || "")).subcategory ||
      "";
    const noteMain = buildFinanceMainNoteParts({
      subcategory: sub,
      institutionName: priorMeta.institutionName,
      cycleType: priorMeta.cycleType,
      bodyNote: priorMeta.body,
    });

    const priorCycleId =
      String((record as any)?.cycleId ?? (record as any)?.cycle_id ?? "").trim() || undefined;

    // 构建取消记录的 payload
    const payload = {
      record_date: dateKey,
      category_id: categoryId,
      entry_id: entryId,
      amount: amount,
      note: noteMain,
      is_delete: true, // 取消标记
    };

    // 应用取消记录
    const appliedItem: any = {
      id: record.id || 0,
      record_date: dateKey,
      category_id: categoryId,
      entry_id: entryId,
      type,
      amount: amount,
      note: noteMain,
      is_delete: true,
      created_at: record.created_at || new Date().toISOString(),
    };

    // 如果是今天的记录，更新今日缓存；历史日期不需要更新缓存
    const todayKey = this.plugin.getTodayKey();
    if (dateKey === todayKey) {
      this.plugin.applyTodayFinanceRecord(appliedItem);
    }

    // ✅ 同步写入中央索引
    try {
      await this.plugin.recordRSLatte?.upsertFinanceRecord({
        recordDate: dateKey,
        entryId,
        categoryId: categoryId,
        categoryName: categoryName,
        type,
        subcategory: sub || undefined,
        amount: amount,
        note: noteMain,
        institutionName: priorMeta.institutionName || undefined,
        cycleType: priorMeta.cycleType,
        cycleId: priorCycleId,
        sceneTags: priorMeta.sceneTags?.length ? priorMeta.sceneTags : undefined,
        isDelete: true,
        tsMs: Date.now(),
      });
    } catch (e) {
      console.warn("recordRSLatte upsertFinanceRecord failed", e);
    }

    // ✅ 写入日记（主行 + meta，与索引一致）
    try {
      const mainLine = buildFinanceListItemLine({
        dateKey,
        type,
        categoryId,
        categoryDisplayName: String(categoryName),
        noteMain: noteMain || "-",
        signedAmount: amount,
        isDelete: true,
        cancelTimeHm: momentFn().format("HH:mm"),
      });
      const metaLine = stringifyFinanceMetaComment({
        entry_id: entryId,
        subcategory: sub || "未分类",
        institution_name: priorMeta.institutionName || undefined,
        cycle_type: priorMeta.cycleType,
        cycle_id: priorCycleId,
        scene_tags: priorMeta.sceneTags,
        is_delete: true,
      });
      const pair = [mainLine, metaLine];
      const replacer = (this.plugin as any).replaceFinanceJournalPairByEntryId as
        | ((dk: string, id: string, p: string[]) => Promise<boolean>)
        | undefined;
      const ok = replacer ? await replacer(dateKey, entryId, pair) : false;
      if (!ok) {
        await ((this.plugin as any).appendJournalByModule?.("finance", dateKey, pair) ?? Promise.resolve());
      }
    } catch (e: any) {
      new Notice("取消记录已保存，但写入日记失败");
      await this.plugin.appendAuditLog({
        action: "FINANCE_CANCEL_JOURNAL_APPEND_FAILED",
        payload,
        error: {
          message: e?.message ?? String(e),
          stack: e?.stack ?? null,
        },
      });
    }

    await this.plugin.saveSettings();
    this.plugin.refreshSidePanel();
    
    // ✅ 刷新财务侧边栏（如果已打开）
    try {
      const financeLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_FINANCE);
      for (const leaf of financeLeaves) {
        const view = leaf.view as any;
        if (view && typeof view.refresh === "function") {
          void view.refresh();
        }
      }
    } catch {
      // ignore
    }

    // ✅ Work Event（记录取消的日期）
    try {
      void this.plugin.workEventSvc?.append({
        ts: new Date().toISOString(),
        kind: "finance",
        action: "delete",
        source: "ui",
        ref: {
          record_date: dateKey,
          category_id: categoryId,
          category_name: categoryName || undefined,
          amount: amount,
          note: (record.note || "").trim() || undefined,
          is_delete: true,
          cancelled_date: dateKey, // ✅ 告知取消的日期
        },
        summary: `❌ 取消账单 ${categoryName || categoryId} ${amount}（日期：${dateKey}）`,
        metrics: { amount: amount, is_delete: true, cancelled_date: dateKey },
      });
    } catch {
      // ignore
    }

    new Notice(`已取消 ${dateKey} 的账单：${categoryName}`);
  }

  /**
   * 渲染财务支出饼图（单月）- 支持鼠标悬停显示分类信息
   */
  private renderFinancePieChart(parent: HTMLElement, expenseRecords: any[], monthKey: string) {
    // 按分类统计支出（支持两种字段名格式）
    const expenseByCat = new Map<string, number>();
    const catNameMap = new Map<string, string>();

    for (const record of expenseRecords) {
      const catId = record.category_id || record.categoryId || "";
      if (!catId) continue;
      const amount = Math.abs(Number(record.amount || 0));
      expenseByCat.set(catId, (expenseByCat.get(catId) || 0) + amount);

      if (!catNameMap.has(catId)) {
        const category = this.plugin.settings.financeCategories.find(c => c.id === catId);
        catNameMap.set(catId, category?.name || catId || "（未命名）");
      }
    }

    if (expenseByCat.size === 0) {
      parent.createDiv({ cls: "rslatte-muted", text: "该月份无支出记录" });
      return;
    }

    // 生成饼图数据
    const series = Array.from(expenseByCat.entries())
      .map(([id, value]) => ({
        id,
        name: catNameMap.get(id) || id || "（未命名）",
        value,
      }))
      .sort((a, b) => b.value - a.value);

    // 限制图例长度
    let displaySeries = series;
    if (series.length > 8) {
      const top = series.slice(0, 7);
      const rest = series.slice(7).reduce((s, x) => s + x.value, 0);
      top.push({ id: "__other__", name: "其他", value: rest });
      displaySeries = top;
    }

    const block = parent.createDiv({ cls: "rslatte-pie-block" });
    block.createDiv({ cls: "rslatte-pie-title", text: `${monthKey} 支出` });

    const canvas = block.createEl("canvas", { cls: "rslatte-pie-canvas" }) as HTMLCanvasElement;
    canvas.width = 160;
    canvas.height = 160;
    this.drawPie(canvas, displaySeries);

    // 图例支持多列显示（根据侧边栏宽度自适应）
    const legend = block.createDiv({ cls: "rslatte-pie-legend" });
    for (const s of displaySeries) {
      const row = legend.createDiv({ cls: "rslatte-pie-legend-row" });
      row.createEl("span", { cls: "rslatte-pie-swatch", text: "■" }).style.color = this.colorForKey(String(s.id));
      row.createEl("span", { cls: "rslatte-pie-name", text: `${s.name}` });
      row.createEl("span", { cls: "rslatte-pie-val", text: `${Number(s.value).toFixed(0)}` });
    }
  }

  private drawPie(
    canvas: HTMLCanvasElement,
    series: Array<{ id: string; value: number; name?: string }>
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const total = series.reduce((s, x) => s + (Number(x.value) || 0), 0);
    if (total <= 0) {
      ctx.fillText("（无支出）", 40, 80);
      return;
    }

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const r = Math.min(cx, cy) - 4;
    // 从顶部开始（-Math.PI/2），顺时针绘制
    let a0 = -Math.PI / 2;

    for (const s of series) {
      const v = Number(s.value) || 0;
      if (v <= 0) continue;
      const a1 = a0 + (v / total) * Math.PI * 2;
      const color = this.colorForKey(String(s.id));
      
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, a0, a1);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      a0 = a1;
    }

    // hole (donut) for readability
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = getComputedStyle(canvas).getPropertyValue("--background-primary") || "#111";
    ctx.fill();

    ctx.fillStyle = getComputedStyle(canvas).getPropertyValue("--text-normal") || "#ddd";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(total.toFixed(0), cx, cy);
  }

  private colorForKey(key: string): string {
    // stable HSL based on FNV-like hash
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const hue = Math.abs(h) % 360;
    return `hsl(${hue} 65% 55%)`;
  }

  private async readFinanceAlertHiddenMap(): Promise<Record<string, string>> {
    try {
      const root = String((this.plugin as any)?.getSpaceIndexDir?.() ?? "").trim();
      if (!root) return {};
      const p = normalizePath(`${root}/finance-analysis/finance-alert-visibility.json`);
      const ok = await this.app.vault.adapter.exists(p);
      if (!ok) return {};
      const raw = await this.app.vault.adapter.read(p);
      const j = JSON.parse(String(raw ?? "{}"));
      if (!j || typeof j !== "object") return {};
      const map = j.hiddenUntilByKey;
      return map && typeof map === "object" ? (map as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  private async writeFinanceAlertHiddenMap(map: Record<string, string>): Promise<void> {
    try {
      const root = String((this.plugin as any)?.getSpaceIndexDir?.() ?? "").trim();
      if (!root) return;
      const dir = normalizePath(`${root}/finance-analysis`);
      const p = normalizePath(`${dir}/finance-alert-visibility.json`);
      const exists = await this.app.vault.adapter.exists(dir);
      if (!exists) {
        try { await this.app.vault.createFolder(dir); } catch {}
      }
      const payload = {
        version: 1,
        updatedAt: new Date().toISOString(),
        hiddenUntilByKey: map,
      };
      await this.app.vault.adapter.write(p, JSON.stringify(payload, null, 2));
    } catch (e) {
      console.warn("[RSLatte] write finance alert visibility failed", e);
    }
  }

  public refresh() { void this.render(); }

  /**
   * 扫描重建：全量扫描 +（可选）DB 同步 +（Engine 层门控）reconcile
   */
  private async manualRebuild(): Promise<void> {
    const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "finance", "rebuild");
    if (!r.ok) {
      new Notice(`财务重建失败：${r.error.message}`);
      return;
    }
    if (r.data.skipped) return;

    new Notice(`财务索引已重建`);
    try { await this.plugin.hydrateTodayFromRecordIndex(); } catch { }
    void this.render();
  }

  /**
   * 手动刷新：增量刷新 +（可选）DB 同步 +（Engine 层门控）reconcile
   */
  private async manualRefresh(): Promise<void> {
    const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "finance", "manual_refresh");
    if (!r.ok) {
      new Notice(`财务刷新失败：${r.error.message}`);
      return;
    }
    if (r.data.skipped) return;

    new Notice(`财务已刷新`);
    try { await this.plugin.hydrateTodayFromRecordIndex(); } catch { }
    void this.render();
  }

  /**
   * 手动索引归档：超阈值财务记录迁入 archive（日记笔记不移动）
   */
  private async manualArchive(): Promise<void> {
    const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "finance", "manual_archive");
    if (!r.ok) {
      new Notice(`财务索引归档失败：${r.error.message}`);
      return;
    }
    if (r.data.skipped) return;

    new Notice(`财务索引归档已完成`);
    void this.render();
  }

  /** 外部导航：财务记录清单页签 */
  public openLedgerContentTab(): void {
    this._financeContentTab = "ledger";
    void this.render();
  }

  /** 外部导航：财务统计明细（含告警）页签 */
  public openStatsContentTab(): void {
    this._financeContentTab = "stats";
    void this.render();
  }
}
