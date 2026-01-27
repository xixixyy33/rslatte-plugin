import { ItemView, WorkspaceLeaf, moment, Notice } from "obsidian";
import type RSLattePlugin from "../../main";
import { VIEW_TYPE_CHECKIN } from "../../constants/viewTypes";
import { AddCheckinRecordModal } from "../modals/AddCheckinRecordModal";
import { RSLATTE_EVENT_SPACE_CHANGED } from "../../constants/space";
import { getUiHeaderButtonsVisibility } from "../helpers/uiHeaderButtons";

const momentFn = moment as any;

export class CheckinSidePanelView extends ItemView {
  private plugin: RSLattePlugin;
  private _renderSeq = 0;
  private _viewMode: "month" | "year" = "month"; // 视图模式：月份或年份
  private _selectedMonth: string = ""; // YYYY-MM 格式
  private _selectedYear: string = ""; // YYYY 格式
  private _selectedCheckinIds: Set<string> = new Set(); // 选中的打卡项ID
  private _checkinSelectionCollapsed: boolean = false;

  constructor(leaf: WorkspaceLeaf, plugin: RSLattePlugin) {
    super(leaf);
    this.plugin = plugin;
    // 默认选择当前月份
    const now = momentFn();
    this._selectedMonth = now.format("YYYY-MM");
    this._selectedYear = now.format("YYYY");
  }

  getViewType(): string { return VIEW_TYPE_CHECKIN; }
  getDisplayText(): string { return "打卡管理"; }
  getIcon(): string { return "check-circle"; }

  async onOpen() {
    // 监听空间切换事件，自动刷新数据
    this.registerEvent(
      (this.app.workspace as any).on(RSLATTE_EVENT_SPACE_CHANGED, () => {
        void this.render();
      })
    );

    const checkinEnabled = this.plugin.isPipelineModuleEnabled("checkin");
    if (!checkinEnabled) {
      void this.render();
      return;
    }
    void this.render();
  }

  async onClose() { }

  private async render() {
    const seq = ++this._renderSeq;
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("rslatte-checkin-panel");

    const checkinEnabled = this.plugin.isPipelineModuleEnabled("checkin");
    if (!checkinEnabled) {
      container.createDiv({ cls: "rslatte-muted", text: "打卡模块未启用" });
      return;
    }

    // ===== 分区一：标题 + 加号按钮 =====
    const headerSection = container.createDiv({ cls: "rslatte-section" });
    const headerRow = headerSection.createDiv({ cls: "rslatte-section-title-row" });
    headerRow.createEl("h3", { text: "✅ 打卡" });
    const headerActions = headerRow.createDiv({ cls: "rslatte-section-title-right" });
    
    // 加号按钮（新增打卡记录）
    const addBtn = headerActions.createEl("button", { text: "➕", cls: "rslatte-icon-btn" });
    addBtn.title = "新增打卡";
    addBtn.onclick = () => {
      new AddCheckinRecordModal(this.app, this.plugin, (_dateKey?: string) => {
        // 新增打卡记录后刷新视图
        void this.render();
      }).open();
    };

    // 重建索引、归档、刷新按钮
    const ckBtnVis = getUiHeaderButtonsVisibility(this.plugin.settings, "checkin");

    if (ckBtnVis.rebuild) {
      const rebuildBtn = headerActions.createEl("button", { text: "🧱", cls: "rslatte-icon-btn" });
      rebuildBtn.title = "扫描重建打卡索引（全量）";
      rebuildBtn.onclick = async () => {
        try {
          rebuildBtn.disabled = true;
          await this.manualRebuild();
        } finally {
          rebuildBtn.disabled = false;
        }
      };
    }

    if (ckBtnVis.archive) {
      const archiveBtn = headerActions.createEl("button", { text: "🗄", cls: "rslatte-icon-btn" });
      archiveBtn.title = "打卡归档（超过阈值天数的打卡索引记录）";
      archiveBtn.onclick = async () => {
        try {
          archiveBtn.disabled = true;
          await this.manualArchive();
        } finally {
          archiveBtn.disabled = false;
        }
      };
    }

    if (ckBtnVis.refresh) {
      const refreshBtn = headerActions.createEl("button", { text: "🔄", cls: "rslatte-icon-btn" });
      refreshBtn.title = "打卡手动刷新（增量）：扫描阈值范围内变更日记";
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
        if (year && /^\d{4}$/.test(year)) {
          const yearNum = parseInt(year, 10);
          if (yearNum >= 2000 && yearNum <= 2100) {
            this._selectedYear = year;
            void this.render();
          } else {
            target.value = this._selectedYear;
          }
        } else if (!year) {
          this._selectedYear = momentFn().format("YYYY");
          target.value = this._selectedYear;
          void this.render();
        } else {
          target.value = this._selectedYear;
        }
      };
      yearInput.onblur = (e) => {
        const target = e.target as HTMLInputElement;
        const year = target.value.trim();
        if (!year || !/^\d{4}$/.test(year)) {
          target.value = this._selectedYear;
        }
      };
    }

    if (seq !== this._renderSeq) return;

    // ===== 分区三：打卡数据区 =====
    const contentSection = container.createDiv({ cls: "rslatte-section" });
    
    // 子分区1：打卡项选择（多选勾选，与操作日志筛选区结构一致）
    const checkinSelectionSection = contentSection.createDiv({ cls: "rslatte-stats-filter-section" });
    const checkinSelectionLabelRow = checkinSelectionSection.createDiv({ cls: "rslatte-stats-filter-label-row" });
    const checkinSelectionLabel = checkinSelectionLabelRow.createDiv({ cls: "rslatte-stats-filter-label rslatte-stats-collapsible-label" });
    checkinSelectionLabel.createSpan({ cls: "rslatte-stats-collapse-icon", text: this._checkinSelectionCollapsed ? "▶" : "▼" });
    checkinSelectionLabel.createSpan({ text: "选择打卡项" });
    checkinSelectionLabel.onclick = () => {
      this._checkinSelectionCollapsed = !this._checkinSelectionCollapsed;
      void this.render();
    };
    checkinSelectionLabel.style.cursor = "pointer";

    let checkinItems: any[] = [];
    try {
      if (this.plugin.recordRSLatte) {
        const lists = await this.plugin.recordRSLatte.getListsSnapshot(false);
        checkinItems = (lists.checkinItems || []).filter((item: any) => item.active && !item.deletedAt);
      }
    } catch (e) {
      console.error("[CheckinPanel] Failed to get checkin items:", e);
    }

    if (checkinItems.length === 0) {
      const checkinOptions = checkinSelectionSection.createDiv({ cls: "rslatte-stats-checkbox-group" });
      if (this._checkinSelectionCollapsed) checkinOptions.style.display = "none";
      checkinOptions.createDiv({ cls: "rslatte-muted", text: "暂无打卡项，请先添加打卡项" });
    } else {
      const checkinSelectionActions = checkinSelectionLabelRow.createDiv({ cls: "rslatte-stats-filter-actions" });
      const selectAllLabel = checkinSelectionActions.createEl("label", { cls: "rslatte-stats-checkbox-label" });
      selectAllLabel.style.margin = "0";
      const selectAllCheckbox = selectAllLabel.createEl("input", { type: "checkbox" });
      const allSelected = checkinItems.every((item: any) => this._selectedCheckinIds.has(item.id));
      selectAllCheckbox.checked = allSelected;
      selectAllLabel.createSpan({ text: "全选" });
      selectAllCheckbox.onchange = (e) => {
        e.stopPropagation();
        if (selectAllCheckbox.checked) {
          checkinItems.forEach((item: any) => this._selectedCheckinIds.add(item.id));
        } else {
          this._selectedCheckinIds.clear();
        }
        void this.render();
      };

      const checkinOptions = checkinSelectionSection.createDiv({ cls: "rslatte-stats-checkbox-group" });
      if (this._checkinSelectionCollapsed) checkinOptions.style.display = "none";
      for (const item of checkinItems) {
        const label = checkinOptions.createEl("label", { cls: "rslatte-stats-checkbox-label" });
        const checkbox = label.createEl("input", { type: "checkbox" });
        checkbox.checked = this._selectedCheckinIds.has(item.id);
        checkbox.onchange = () => {
          if (checkbox.checked) {
            this._selectedCheckinIds.add(item.id);
          } else {
            this._selectedCheckinIds.delete(item.id);
          }
          void this.render();
        };
        label.createSpan({ text: item.name });
      }
    }

    if (seq !== this._renderSeq) return;

    // 子分区2：打卡热力图区
    const heatmapSection = contentSection.createDiv({ cls: "rslatte-checkin-heatmap-section" });
    heatmapSection.createEl("h3", { text: "打卡热力图" });

    if (this._selectedCheckinIds.size === 0) {
      heatmapSection.createDiv({ cls: "rslatte-muted", text: "请至少选择一个打卡项" });
      return;
    }

    // 获取打卡统计缓存
    try {
      const recordRSLatte = (this.plugin as any).recordRSLatte;
      if (!recordRSLatte || typeof recordRSLatte.getCheckinStatsCache !== "function") {
        heatmapSection.createDiv({ cls: "rslatte-stats-error", text: "打卡统计缓存服务未初始化" });
        return;
      }

      const currentSpaceId = this.plugin.getCurrentSpaceId();
      const cache = await recordRSLatte.getCheckinStatsCache(currentSpaceId);
      const cacheItems = cache.items || [];

      // 获取打卡项名称映射
      const checkinNames = new Map<string, string>();
      for (const item of checkinItems) {
        checkinNames.set(item.id, item.name);
      }

      // 根据视图模式筛选数据
      let filteredItems: any[] = [];
      
      if (this._viewMode === "month") {
        const selectedMonthStart = momentFn(this._selectedMonth + "-01");
        const selectedMonthEnd = selectedMonthStart.clone().endOf("month");
        filteredItems = cacheItems.filter((item: any) => {
          const recordDate = momentFn(item.recordDate);
          return recordDate.isSameOrAfter(selectedMonthStart, "day") && recordDate.isSameOrBefore(selectedMonthEnd, "day");
        });
      } else {
        const selectedYearStart = momentFn(this._selectedYear + "-01-01");
        const selectedYearEnd = selectedYearStart.clone().endOf("year");
        filteredItems = cacheItems.filter((item: any) => {
          const recordDate = momentFn(item.recordDate);
          return recordDate.isSameOrAfter(selectedYearStart, "day") && recordDate.isSameOrBefore(selectedYearEnd, "day");
        });
      }

      // 按打卡项分组
      const itemsByCheckinId = new Map<string, Array<{ recordDate: string; isDelete?: boolean }>>();
      for (const item of filteredItems) {
        if (!this._selectedCheckinIds.has(item.checkinId)) continue;
        if (!itemsByCheckinId.has(item.checkinId)) {
          itemsByCheckinId.set(item.checkinId, []);
        }
        itemsByCheckinId.get(item.checkinId)!.push({
          recordDate: item.recordDate,
          isDelete: item.isDelete,
        });
      }

      // 渲染每个选中打卡项的热力图
      if (itemsByCheckinId.size > 0) {
        const heatmapsContainer = heatmapSection.createDiv({ cls: "rslatte-checkin-heatmaps-container" });
        
        // 按打卡项名称排序
        const sortedCheckinIds = Array.from(itemsByCheckinId.keys()).sort((a, b) => {
          const nameA = checkinNames.get(a) || a;
          const nameB = checkinNames.get(b) || b;
          return nameA.localeCompare(nameB);
        });

        for (const checkinId of sortedCheckinIds) {
          const checkinName = checkinNames.get(checkinId) || checkinId;
          const items = itemsByCheckinId.get(checkinId)!;

          const heatmapItem = heatmapsContainer.createDiv({ cls: "rslatte-stats-checkin-heatmap-item" });
          heatmapItem.createEl("h6", { text: checkinName });

          // 渲染热力图（月度或年度），传入打卡项ID和名称以便点击时使用
          if (this._viewMode === "month") {
            this.renderCheckinHeatmapHTML(heatmapItem, this._selectedMonth, items, checkinId, checkinName);
          } else {
            this.renderCheckinHeatmapYearlyHTML(heatmapItem, this._selectedYear, items, checkinId, checkinName);
          }
        }
      } else {
        heatmapSection.createDiv({ cls: "rslatte-muted", text: `该${this._viewMode === "month" ? "月份" : "年份"}暂无选中打卡项的数据` });
      }
    } catch (e) {
      console.error("[CheckinPanel] Failed to render heatmaps:", e);
      heatmapSection.createDiv({ cls: "rslatte-stats-error", text: `渲染失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }

  /** 生成打卡项月度热力图（使用 HTML/CSS 渲染） */
  private renderCheckinHeatmapHTML(container: HTMLElement, yearMonth: string, items: Array<{ recordDate: string; isDelete?: boolean }>, checkinId: string, checkinName: string) {
    // 获取该月的所有日期
    const [year, month] = yearMonth.split("-").map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();
    const dates: string[] = [];
    for (let day = 1; day <= daysInMonth; day++) {
      dates.push(`${yearMonth}-${String(day).padStart(2, "0")}`);
    }

    // 构建热力图数据：日期 -> 是否打卡
    const heatmapData = new Map<string, boolean>();
    for (const date of dates) {
      const hasCheckin = items.some((item) => item.recordDate === date && !item.isDelete);
      heatmapData.set(date, hasCheckin);
    }

    // 创建热力图容器
    const heatmapWrapper = container.createDiv({ cls: "rslatte-stats-checkin-heatmap-wrapper" });
    
    // 添加星期标签行
    const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
    const weekdayRow = heatmapWrapper.createDiv({ cls: "rslatte-stats-heatmap-weekdays" });
    weekdayRow.style.display = "grid";
    weekdayRow.style.gridTemplateColumns = "repeat(7, 1fr)";
    weekdayRow.style.gap = "4px";
    weekdayRow.style.marginBottom = "4px";
    for (let i = 0; i < 7; i++) {
      weekdayRow.createDiv({ cls: "rslatte-stats-heatmap-weekday", text: weekdays[i] });
    }

    // 创建热力图网格
    const heatmapDiv = heatmapWrapper.createDiv({ cls: "rslatte-stats-checkin-heatmap-grid" });

    // 计算第一天的星期
    const firstDate = new Date(year, month - 1, 1);
    const firstDayOfWeek = firstDate.getDay();

    // 添加空白占位（第一周的前几天）
    for (let i = 0; i < firstDayOfWeek; i++) {
      heatmapDiv.createDiv({ cls: "rslatte-stats-heatmap-cell rslatte-stats-heatmap-empty" });
    }

    // 添加日期单元格
    for (const date of dates) {
      const hasCheckin = heatmapData.get(date) || false;
      const day = parseInt(date.slice(8), 10);
      const cell = heatmapDiv.createDiv({
        cls: `rslatte-stats-heatmap-cell ${hasCheckin ? "rslatte-stats-heatmap-checked" : "rslatte-stats-heatmap-unchecked"}`,
        attr: { "data-date": date, "data-day": String(day), title: `${date} ${hasCheckin ? "已打卡" : "未打卡"}` },
      });
      
      // 添加日期标签
      if (day === 1 || day % 7 === 1 || day <= 7) {
        cell.createDiv({ cls: "rslatte-stats-heatmap-day-label", text: String(day) });
      }
      
      // ✅ 添加点击事件：切换打卡状态
      cell.style.cursor = "pointer";
      cell.onclick = () => {
        void this.toggleCheckinForDate(date, checkinId, checkinName);
      };
    }
  }

  /** 生成打卡项年度热力图（使用 HTML/CSS 渲染，每个月一行） */
  private renderCheckinHeatmapYearlyHTML(container: HTMLElement, year: string, items: Array<{ recordDate: string; isDelete?: boolean }>, checkinId: string, checkinName: string) {
    const yearNum = parseInt(year, 10);
    const heatmapWrapper = container.createDiv({ cls: "rslatte-stats-checkin-heatmap-wrapper" });
    
    // 添加星期标签行（只显示一次，在顶部）
    const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
    const weekdayRow = heatmapWrapper.createDiv({ cls: "rslatte-stats-heatmap-weekdays" });
    weekdayRow.style.display = "grid";
    weekdayRow.style.gridTemplateColumns = "repeat(7, 1fr)";
    weekdayRow.style.gap = "4px";
    weekdayRow.style.marginBottom = "4px";
    for (let i = 0; i < 7; i++) {
      weekdayRow.createDiv({ cls: "rslatte-stats-heatmap-weekday", text: weekdays[i] });
    }

    // 为每个月创建一行热力图
    for (let month = 1; month <= 12; month++) {
      // 月份标签和热力图容器（一行）
      const monthRow = heatmapWrapper.createDiv({ cls: "rslatte-checkin-heatmap-yearly-month-row" });
      
      // 月份标签（左侧）
      const monthLabel = monthRow.createDiv({ cls: "rslatte-checkin-heatmap-yearly-month-label" });
      monthLabel.textContent = `${month}月`;
      
      // 热力图网格（右侧）
      const heatmapDiv = monthRow.createDiv({ cls: "rslatte-stats-checkin-heatmap-grid" });
      
      const daysInMonth = new Date(yearNum, month, 0).getDate();
      const firstDate = new Date(yearNum, month - 1, 1);
      const firstDayOfWeek = firstDate.getDay();

      // 添加空白占位（第一周的前几天）
      for (let i = 0; i < firstDayOfWeek; i++) {
        heatmapDiv.createDiv({ cls: "rslatte-stats-heatmap-cell rslatte-stats-heatmap-empty" });
      }

      // 添加该月的所有日期单元格
      for (let day = 1; day <= daysInMonth; day++) {
        const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const hasCheckin = items.some((item) => item.recordDate === date && !item.isDelete);
        const cell = heatmapDiv.createDiv({
          cls: `rslatte-stats-heatmap-cell ${hasCheckin ? "rslatte-stats-heatmap-checked" : "rslatte-stats-heatmap-unchecked"}`,
          attr: { "data-date": date, "data-month": String(month), "data-day": String(day), title: `${date} ${hasCheckin ? "已打卡" : "未打卡"}` },
        });
        
        // 只在月初或每周第一天显示日期标签
        if (day === 1 || day % 7 === 1 || day <= 7) {
          cell.createDiv({ cls: "rslatte-stats-heatmap-day-label", text: String(day) });
        }
        
        // ✅ 添加点击事件：切换打卡状态
        cell.style.cursor = "pointer";
        cell.onclick = () => {
          void this.toggleCheckinForDate(date, checkinId, checkinName);
        };
      }
    }
  }

  /** 切换指定日期的打卡状态 */
  private async toggleCheckinForDate(dateKey: string, checkinId: string, checkinName: string): Promise<void> {
    try {
      // 获取当前空间的打卡记录
      const currentSpaceId = this.plugin.getCurrentSpaceId();
      let existingRecord: any = null;
      
      try {
        if (this.plugin.recordRSLatte) {
          // 优先使用统计缓存
          let allRecords: any[] = [];
          try {
            const statsCache = await this.plugin.recordRSLatte.getCheckinStatsCache(currentSpaceId);
            if (statsCache?.items && statsCache.items.length > 0) {
              allRecords = statsCache.items as any[];
            } else {
              // 回退到主索引
              const cSnapActive = await this.plugin.recordRSLatte.getCheckinSnapshot(false);
              const cSnapArch = await this.plugin.recordRSLatte.getCheckinSnapshot(true);
              allRecords = [
                ...(cSnapActive?.items ?? []),
                ...(cSnapArch?.items ?? [])
              ];
            }
          } catch {
            const cSnapActive = await this.plugin.recordRSLatte.getCheckinSnapshot(false);
            const cSnapArch = await this.plugin.recordRSLatte.getCheckinSnapshot(true);
            allRecords = [
              ...(cSnapActive?.items ?? []),
              ...(cSnapArch?.items ?? [])
            ];
          }
          
          // 查找匹配的记录
          existingRecord = allRecords.find(
            (item: any) => {
              const itemDate = String(item.record_date || item.recordDate || "").trim();
              const itemCheckinId = String(item.checkin_id || item.checkinId || "").trim();
              return itemDate === dateKey && itemCheckinId === checkinId;
            }
          );
        }
      } catch (e) {
        console.warn("[CheckinPanel] Failed to check existing record:", e);
      }

      // 确定目标状态：如果已有未删除记录，则取消打卡；否则打卡
      const isActive = existingRecord && !(existingRecord.is_delete === true || existingRecord.isDelete === true || String(existingRecord.is_delete || existingRecord.isDelete || "").toLowerCase() === "true");
      const targetIsDelete = isActive; // 已打卡 -> 取消 (is_delete=true)

      const payload = {
        record_date: dateKey,
        checkin_id: checkinId,
        note: "",
        is_delete: targetIsDelete,
      } as const;

      // 如果是今天，使用 applyTodayCheckinRecord
      const todayKey = this.plugin.getTodayKey();
      const appliedRecord: any = {
        id: existingRecord?.id || 0,
        record_date: dateKey,
        checkin_id: checkinId,
        note: "",
        is_delete: targetIsDelete,
        created_at: existingRecord?.created_at || new Date().toISOString(),
      };

      if (dateKey === todayKey) {
        this.plugin.applyTodayCheckinRecord(appliedRecord);
      }

      // DB 同步（如果启用）
      const dbSync = (this.plugin as any).isCheckinDbSyncEnabled?.() ?? (this.plugin as any).isRSLatteDbSyncEnabled();
      if (dbSync) {
        try {
          const res = await this.plugin.api.upsertCheckinRecord(payload);
          if (res?.item) {
            if (dateKey === todayKey) {
              this.plugin.applyTodayCheckinRecord(res.item);
            }
          }
        } catch (e: any) {
          console.warn("[CheckinPanel] DB sync failed, using local mode:", e);
          // DB 失败时降级为本地模式
        }
      }

      // ✅ 同步写入中央索引
      try {
        await this.plugin.recordRSLatte?.upsertCheckinRecord({
          recordDate: dateKey,
          checkinId: checkinId,
          checkinName: checkinName,
          note: "",
          isDelete: targetIsDelete,
          tsMs: Date.now(),
        });
      } catch (e) {
        console.warn("recordRSLatte upsertCheckinRecord failed", e);
      }

      // ✅ 写入日记
      try {
        const timeStr = momentFn().format("HH:mm");
        const mark = targetIsDelete ? "❌" : "✅";
        const line = `- ${dateKey} ${timeStr} ${checkinId} ${checkinName} ${mark}`;

        await ((this.plugin as any).appendJournalByModule?.("checkin", dateKey, [line]) ?? Promise.resolve());
      } catch (e: any) {
        new Notice("打卡记录已保存，但写入日记失败");
        await this.plugin.appendAuditLog({
          action: "CHECKIN_JOURNAL_APPEND_FAILED",
          payload,
          error: {
            message: e?.message ?? String(e),
            stack: e?.stack ?? null,
          },
        });
      }

      await this.plugin.saveSettings();
      this.plugin.refreshSidePanel();

      // ✅ Work Event
      try {
        void this.plugin.workEventSvc?.append({
          ts: new Date().toISOString(),
          kind: "checkin",
          action: targetIsDelete ? "delete" : "create",
          source: "ui",
          ref: {
            record_date: dateKey,
            checkin_id: checkinId,
            checkin_name: checkinName,
            is_delete: targetIsDelete,
          },
          summary: `${targetIsDelete ? "❌ 取消打卡" : "✅ 打卡"} ${checkinName}`,
          metrics: { is_delete: targetIsDelete },
        });
      } catch {
        // ignore
      }

      // ✅ 刷新打卡侧边栏
      void this.render();
      
      new Notice(targetIsDelete ? "已取消打卡" : "已打卡");
    } catch (e: any) {
      new Notice(`操作失败：${e?.message ?? String(e)}`);
      console.error("[CheckinPanel] toggleCheckinForDate failed:", e);
    }
  }

  /**
   * 扫描重建：全量扫描 +（可选）DB 同步 +（Engine 层门控）reconcile
   */
  private async manualRebuild(): Promise<void> {
    const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "checkin", "rebuild");
    if (!r.ok) {
      new Notice(`打卡重建失败：${r.error.message}`);
      return;
    }
    if (r.data.skipped) return;

    new Notice(`打卡索引已重建`);
    try { await this.plugin.hydrateTodayFromRecordIndex(); } catch { }
    void this.render();
  }

  /**
   * 手动刷新：增量刷新 +（可选）DB 同步 +（Engine 层门控）reconcile
   */
  private async manualRefresh(): Promise<void> {
    const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "checkin", "manual_refresh");
    if (!r.ok) {
      new Notice(`打卡刷新失败：${r.error.message}`);
      return;
    }
    if (r.data.skipped) return;

    new Notice(`打卡已刷新`);
    try { await this.plugin.hydrateTodayFromRecordIndex(); } catch { }
    void this.render();
  }

  /**
   * 手动归档：归档超过阈值天数的索引记录
   */
  private async manualArchive(): Promise<void> {
    const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "checkin", "manual_archive");
    if (!r.ok) {
      new Notice(`打卡归档失败：${r.error.message}`);
      return;
    }
    if (r.data.skipped) return;

    new Notice(`打卡已归档`);
    void this.render();
  }

  public refresh() { void this.render(); }
}
