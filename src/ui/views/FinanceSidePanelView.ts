import { ItemView, WorkspaceLeaf, moment, Notice } from "obsidian";
import type RSLattePlugin from "../../main";
import { VIEW_TYPE_FINANCE } from "../../constants/viewTypes";
import { AddFinanceRecordModal } from "../modals/AddFinanceRecordModal";
import { extractFinanceSubcategory } from "../../services/finance/financeSubcategory";
import { getUiHeaderButtonsVisibility } from "../helpers/uiHeaderButtons";

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

  private async render() {
    const seq = ++this._renderSeq;
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("rslatte-finance-panel");

    const financeEnabled = this.plugin.isPipelineModuleEnabled("finance");
    if (!financeEnabled) {
      container.createDiv({ cls: "rslatte-muted", text: "财务模块未启用" });
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
      archiveBtn.title = "财务归档（超过阈值天数的财务索引记录）";
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

    // ===== 分区三：饼图 + 记录清单 =====
    const contentSection = container.createDiv({ cls: "rslatte-section" });
    
    // 获取财务数据
    // ✅ 优先使用主索引（包含完整的 note 信息），统计缓存不包含 note 字段
    let financeIndexItems: any[] = [];
    try {
      if (this.plugin.recordRSLatte) {
        // 获取主索引（活跃 + 归档）
        const fSnapActive = await this.plugin.recordRSLatte.getFinanceSnapshot(false);
        const fSnapArch = await this.plugin.recordRSLatte.getFinanceSnapshot(true);
        financeIndexItems = [
          ...(fSnapActive?.items ?? []),
          ...(fSnapArch?.items ?? [])
        ];
      }
    } catch {
      // ignore
    }

    // 根据视图模式筛选数据（支持两种字段名格式）
    let filteredRecords: any[] = [];
    let periodLabel = "";
    
    if (this._viewMode === "month") {
      // 月份视图
      const selectedMonthStart = momentFn(this._selectedMonth + "-01");
      const selectedMonthEnd = selectedMonthStart.clone().endOf("month");
      periodLabel = this._selectedMonth;
      filteredRecords = financeIndexItems.filter((item: any) => {
        const recordDate = momentFn(item.record_date || item.recordDate);
        return recordDate.isSameOrAfter(selectedMonthStart, "day") && recordDate.isSameOrBefore(selectedMonthEnd, "day");
      });
    } else {
      // 年份视图
      const selectedYearStart = momentFn(this._selectedYear + "-01-01");
      const selectedYearEnd = selectedYearStart.clone().endOf("year");
      periodLabel = this._selectedYear;
      filteredRecords = financeIndexItems.filter((item: any) => {
        const recordDate = momentFn(item.record_date || item.recordDate);
        return recordDate.isSameOrAfter(selectedYearStart, "day") && recordDate.isSameOrBefore(selectedYearEnd, "day");
      });
    }

    // 只显示支出记录（用于饼图）
    const expenseRecords = filteredRecords.filter((item: any) => {
      const isDeleted = item.is_delete === true || item.isDelete === true || String(item.is_delete || item.isDelete || "").toLowerCase() === "true";
      return (item.type === "expense") && !isDeleted;
    });

    // 饼图（受设置页开关控制）
    const showPie = (this.plugin.settings as any).rslattePanelShowFinancePieCharts !== false;
    if (showPie && expenseRecords.length > 0) {
      const pieSection = contentSection.createDiv({ cls: "rslatte-finance-pie-section" });
      this.renderFinancePieChart(pieSection, expenseRecords, periodLabel);
    }

    // 记录清单
    const listSection = contentSection.createDiv({ cls: "rslatte-finance-list-section" });
    
    // 计算统计结果
    let totalIncome = 0;
    let totalExpense = 0;
    for (const record of filteredRecords) {
      const isDeleted = record.is_delete === true || record.isDelete === true || String(record.is_delete || record.isDelete || "").toLowerCase() === "true";
      if (isDeleted) continue;
      const amount = Number(record.amount || 0);
      if (record.type === "income") {
        totalIncome += Math.abs(amount);
      } else if (record.type === "expense") {
        totalExpense += Math.abs(amount);
      }
    }

    // 清单标题 + 统计结果
    const listTitleRow = listSection.createDiv({ cls: "rslatte-finance-list-title-row" });
    listTitleRow.createEl("h3", { text: "财务记录清单" });
    listTitleRow.createSpan({ cls: "rslatte-finance-list-stats", text: `支出 ¥${totalExpense.toFixed(2)}，收入 ¥${totalIncome.toFixed(2)}` });

    // 筛选选项
    const filterBar = listSection.createDiv({ cls: "rslatte-finance-filter-bar" });
    
    // 财务分类筛选
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
      this._filterSubcategory = ""; // 清空子分类筛选
      void this.render();
    };

    // 财务子分类筛选（需要先选择分类）
    const subcategoryFilter = filterBar.createDiv({ cls: "rslatte-finance-filter-item" });
    subcategoryFilter.createEl("label", { text: "财务子分类：", cls: "rslatte-finance-filter-label" });
    const subcategorySelect = subcategoryFilter.createEl("select", { cls: "rslatte-finance-filter-select" });
    subcategorySelect.createEl("option", { text: "全部", value: "" });
    if (this._filterCategoryId) {
      const category = this.plugin.settings.financeCategories.find(c => c.id === this._filterCategoryId);
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

    // 收入/支出筛选
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

    // 应用筛选（在时间筛选的基础上进一步筛选）
    let finalFilteredRecords = filteredRecords.filter((record: any) => {
      // 删除状态筛选
      const isDeleted = record.is_delete === true || record.isDelete === true || String(record.is_delete || record.isDelete || "").toLowerCase() === "true";
      if (isDeleted) return false;

      // 财务分类筛选
      const categoryId = record.category_id || record.categoryId || "";
      if (this._filterCategoryId && categoryId !== this._filterCategoryId) return false;

      // 财务子分类筛选
      if (this._filterSubcategory) {
        const note = record.note || "";
        const { subcategory } = extractFinanceSubcategory(note);
        if (subcategory !== this._filterSubcategory) return false;
      }

      // 收入/支出筛选
      if (this._filterType && record.type !== this._filterType) return false;

      return true;
    });
    
    const emptyMessage = this._viewMode === "month" 
      ? "该月份暂无符合条件的财务记录" 
      : "该年份暂无符合条件的财务记录";
    
    if (finalFilteredRecords.length === 0) {
      listSection.createDiv({ cls: "rslatte-muted", text: emptyMessage });
    } else {
      // 按日期分组显示
      const recordsByDate = new Map<string, any[]>();
      for (const record of finalFilteredRecords) {
        const dateKey = record.record_date || record.recordDate || "";
        if (!dateKey) continue;
        if (!recordsByDate.has(dateKey)) {
          recordsByDate.set(dateKey, []);
        }
        recordsByDate.get(dateKey)!.push(record);
      }

      // 按日期倒序排列
      const sortedDates = Array.from(recordsByDate.keys()).sort().reverse();

      // 使用 timeline 样式
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
  }

  /**
   * 渲染 timeline 样式的财务记录项
   */
  private renderTimelineItem(parent: HTMLElement, record: any, dateKey: string): void {
    const row = parent.createDiv({ cls: "rslatte-timeline-item rslatte-finance-timeline-item" });
    
    const gutter = row.createDiv({ cls: "rslatte-timeline-gutter" });
    const dot = gutter.createDiv({ cls: "rslatte-timeline-dot" });
    const isExpense = record.type === "expense";
    const isDeleted = record.is_delete === true || record.isDelete === true || String(record.is_delete || record.isDelete || "").toLowerCase() === "true";
    dot.setText(isDeleted ? "❌" : (isExpense ? "💰" : "💵"));
    gutter.createDiv({ cls: "rslatte-timeline-line" });

    const content = row.createDiv({ cls: "rslatte-timeline-content" });
    
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

  /**
   * 取消财务记录（与打卡侧边栏的机制一致）
   */
  private async cancelFinanceRecord(record: any, dateKey: string): Promise<void> {
    const categoryId = record.category_id || record.categoryId || "";
    const category = this.plugin.settings.financeCategories.find(c => c.id === categoryId);
    const categoryName = category?.name || categoryId;
    const amount = Number(record.amount || 0);
    const type = record.type || "expense";

    // 构建取消记录的 payload
    const payload = {
      record_date: dateKey,
      category_id: categoryId,
      amount: amount,
      note: record.note || "",
      is_delete: true, // 取消标记
    };

    // 应用取消记录
    const appliedItem: any = {
      id: record.id || 0,
      record_date: dateKey,
      category_id: categoryId,
      type,
      amount: amount,
      note: record.note || "",
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
        categoryId: categoryId,
        categoryName: categoryName,
        type,
        amount: amount,
        note: record.note || "",
        isDelete: true,
        tsMs: Date.now(),
      });
    } catch (e) {
      console.warn("recordRSLatte upsertFinanceRecord failed", e);
    }

    // ✅ 写入日记（取消记录格式）
    try {
      const ts = momentFn().format("HH:mm");
      const amtAbs = Math.abs(amount);
      const safeCatName = String(categoryName ?? "").trim().replace(/\s+/g, "");
      const line = `- ❌ ${dateKey} ${ts} ${type} ${categoryId} ${safeCatName || categoryId} ${record.note || "-"} ${amtAbs.toFixed(2)}`;

      await ((this.plugin as any).appendJournalByModule?.("finance", dateKey, [line]) ?? Promise.resolve());
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
   * 手动归档：归档超过阈值天数的索引记录
   */
  private async manualArchive(): Promise<void> {
    const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "finance", "manual_archive");
    if (!r.ok) {
      new Notice(`财务归档失败：${r.error.message}`);
      return;
    }
    if (r.data.skipped) return;

    new Notice(`财务已归档`);
    void this.render();
  }
}
