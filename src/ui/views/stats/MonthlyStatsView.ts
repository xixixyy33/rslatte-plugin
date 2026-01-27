import { ItemView, WorkspaceLeaf, Notice, MarkdownRenderer } from "obsidian";
import type RSLattePlugin from "../../../main";
import type { MonthlyStats, SpaceMonthlyStats, ModuleMonthlyStats } from "../../../types/stats/monthlyStats";
import type { WorkEventKind, WorkEvent } from "../../../types/stats/workEvent";
import type { FinanceStatsCacheItem, TaskStatsCacheItem } from "../../../types/recordIndexTypes";
import type { WorkEventService } from "../../../services/workEventService";

export const VIEW_TYPE_MONTHLY_STATS = "rslatte-stats-monthly";

export class MonthlyStatsView extends ItemView {
  private plugin: RSLattePlugin;
  private _renderSeq = 0;
  private selectedMonth: string = "";
  private selectedSpaces: Set<string> = new Set();
  private selectedModules: Set<string> = new Set();
  // 折叠状态：true 表示折叠，false 表示展开
  private filtersCollapsed: boolean = false; // 整体筛选器折叠状态
  private spaceSectionCollapsed: boolean = false;
  private moduleSectionCollapsed: boolean = false;

  constructor(leaf: WorkspaceLeaf, plugin: RSLattePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_MONTHLY_STATS;
  }

  getDisplayText(): string {
    return "月度统计数据";
  }

  getIcon(): string {
    return "bar-chart-2";
  }

  async onOpen() {
    // 初始化时默认选择所有空间
    const workEventReader = (this.plugin as any).workEventReader;
    if (workEventReader) {
      const spaces = workEventReader.getSpaces() || [];
      if (this.selectedSpaces.size === 0 && spaces.length > 0) {
        spaces.forEach((s: any) => this.selectedSpaces.add(s.id));
      }
    }
    // 初始化时默认选择所有启用的模块（从注册表获取）
    const allModules = this.getModulesFromRegistry();
    const statsSettings = (this.plugin.settings as any)?.statsSettings;
    const moduleEnabled = statsSettings?.moduleEnabled || {};
    // 只选择启用的模块（未设置的默认为启用）
    const enabledModules = allModules.filter((m: WorkEventKind) => moduleEnabled[m] !== false);
    if (this.selectedModules.size === 0) {
      enabledModules.forEach((m: WorkEventKind) => this.selectedModules.add(m));
    }
    await this.render();
  }

  async onClose() {
    // nothing
  }

  public refresh() {
    void this.render();
  }

  private async render() {
    const seq = ++this._renderSeq;
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("rslatte-stats-monthly");

    const monthlyStatsGenerator = (this.plugin as any).monthlyStatsGenerator;
    if (!monthlyStatsGenerator) {
      container.createDiv({ cls: "rslatte-stats-empty", text: "统计功能未初始化" });
      return;
    }

    // 主容器使用纵向布局，分为三个区块
    const mainContainer = container.createDiv({ cls: "rslatte-stats-monthly-main-container" });
    
    // 区块1：筛选项分区
    const filtersPanel = mainContainer.createDiv({ cls: "rslatte-stats-monthly-filters-panel" });
    
    // 第一个子分区：月份选择和操作按钮
    const monthActionsRow = filtersPanel.createDiv({ cls: "rslatte-stats-monthly-month-actions-row" });
    
    // 月份选择（靠左）
    const monthSelector = monthActionsRow.createDiv({ cls: "rslatte-stats-monthly-selector" });
    monthSelector.createSpan({ text: "选择月份：" });

    const monthInput = monthSelector.createEl("input", { type: "month" , cls: "rslatte-finance-month-input" });
    const now = new Date();
    const defaultMonth = this.selectedMonth || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    monthInput.value = defaultMonth;
    monthInput.onchange = () => {
      this.selectedMonth = monthInput.value;
      void this.render();
    };

    // 操作按钮（靠右）
    const actions = monthActionsRow.createDiv({ cls: "rslatte-stats-monthly-actions" });
    
    const generateBtn = actions.createEl("button", { text: "生成统计", cls: "mod-cta" });
    generateBtn.onclick = async () => {
      const month = monthInput.value;
      if (!month) {
        new Notice("请选择月份");
        return;
      }
      generateBtn.disabled = true;
      generateBtn.textContent = "生成中...";
      try {
        await monthlyStatsGenerator.generateForMonth(month);
        new Notice(`已生成 ${month} 的统计数据`);
        await this.render();
      } catch (e) {
        new Notice(`生成失败：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        generateBtn.disabled = false;
        generateBtn.textContent = "生成统计";
      }
    };

    const refreshBtn = actions.createEl("button", { text: "刷新" });
    refreshBtn.onclick = () => this.refresh();

    // 第二个子分区：筛选选项
    const workEventReader = (this.plugin as any).workEventReader;
    if (workEventReader) {
      const filtersContainer = filtersPanel.createDiv({ cls: "rslatte-stats-monthly-filters-container" });
      
      // 整体筛选器折叠标签
      const filtersToggleRow = filtersContainer.createDiv({ cls: "rslatte-stats-filters-toggle-row" });
      const filtersToggleLabel = filtersToggleRow.createDiv({ cls: "rslatte-stats-filters-toggle-label" });
      filtersToggleLabel.createSpan({ 
        cls: "rslatte-stats-collapse-icon", 
        text: this.filtersCollapsed ? "▶" : "▼" 
      });
      filtersToggleLabel.createSpan({ text: "筛选选项", cls: "rslatte-stats-filters-toggle-text" });
      filtersToggleLabel.onclick = () => {
        this.filtersCollapsed = !this.filtersCollapsed;
        void this.render();
      };
      filtersToggleLabel.style.cursor = "pointer";
      
      // 筛选器内容区域（包含所有筛选区域）
      const filtersContent = filtersContainer.createDiv({ cls: "rslatte-stats-monthly-filters-content" });
      if (this.filtersCollapsed) {
        filtersContent.style.display = "none";
      }
      
      // 空间筛选区域
      const spaceSection = filtersContent.createDiv({ cls: "rslatte-stats-filter-section" });
      const spaceLabelRow = spaceSection.createDiv({ cls: "rslatte-stats-filter-label-row" });
      const spaceLabel = spaceLabelRow.createDiv({ cls: "rslatte-stats-filter-label rslatte-stats-collapsible-label" });
      spaceLabel.createSpan({ cls: "rslatte-stats-collapse-icon", text: this.spaceSectionCollapsed ? "▶" : "▼" });
      spaceLabel.createSpan({ text: "空间筛选" });
      spaceLabel.onclick = () => {
        this.spaceSectionCollapsed = !this.spaceSectionCollapsed;
        void this.render();
      };
      spaceLabel.style.cursor = "pointer";
      
      const spaces = workEventReader.getSpaces();

      // 全选：[勾选项] 形式
      const spaceActions = spaceLabelRow.createDiv({ cls: "rslatte-stats-filter-actions" });
      const spaceSelectAllLabel = spaceActions.createEl("label", { cls: "rslatte-stats-checkbox-label" });
      spaceSelectAllLabel.style.margin = "0";
      spaceSelectAllLabel.style.cursor = "pointer";
      const spaceSelectAllCheckbox = spaceSelectAllLabel.createEl("input", { type: "checkbox" });
      const allSpacesSelected = spaces.length > 0 && spaces.every((s: any) => this.selectedSpaces.has(s.id));
      spaceSelectAllCheckbox.checked = allSpacesSelected;
      spaceSelectAllLabel.createSpan({ text: "全选" });
      
      // 阻止事件冒泡到父元素（避免触发空间筛选区域的折叠）
      spaceSelectAllLabel.onclick = (e) => {
        e.stopPropagation();
        // 让label的点击行为自然触发checkbox的change事件
      };
      
      spaceSelectAllCheckbox.onchange = (e) => {
        e.stopPropagation();
        // 根据checkbox的当前状态更新选择
        // 注意：这里需要读取checkbox的实际状态，因为label点击时状态已经改变
        const isChecked = spaceSelectAllCheckbox.checked;
        if (isChecked) {
          spaces.forEach((s: any) => this.selectedSpaces.add(s.id));
        } else {
          this.selectedSpaces.clear();
        }
        void this.render();
      };
      
      // 确保checkbox点击事件能正常工作且不冒泡
      spaceSelectAllCheckbox.onclick = (e) => {
        e.stopPropagation();
      };

      const spaceOptions = spaceSection.createDiv({ cls: "rslatte-stats-checkbox-group" });
      if (this.spaceSectionCollapsed) {
        spaceOptions.style.display = "none";
      }
      if (spaces.length === 0) {
        spaceOptions.createDiv({
          cls: "rslatte-stats-warning",
          text: "未配置任何空间，请在插件设置中添加空间配置",
        });
      } else {
        
        spaces.forEach((space: any) => {
          const label = spaceOptions.createEl("label", { cls: "rslatte-stats-checkbox-label" });
          const checkbox = label.createEl("input", { type: "checkbox" });
          checkbox.checked = this.selectedSpaces.has(space.id);
          checkbox.onchange = () => {
            if (checkbox.checked) {
              this.selectedSpaces.add(space.id);
            } else {
              this.selectedSpaces.delete(space.id);
            }
            void this.render();
          };
          label.createSpan({ text: space.name });
        });
      }

      // 模块筛选区域
      const moduleSection = filtersContent.createDiv({ cls: "rslatte-stats-filter-section" });
      const moduleLabelRow = moduleSection.createDiv({ cls: "rslatte-stats-filter-label-row" });
      const moduleLabel = moduleLabelRow.createDiv({ cls: "rslatte-stats-filter-label rslatte-stats-collapsible-label" });
      moduleLabel.createSpan({ cls: "rslatte-stats-collapse-icon", text: this.moduleSectionCollapsed ? "▶" : "▼" });
      moduleLabel.createSpan({ text: "模块筛选" });
      moduleLabel.onclick = () => {
        this.moduleSectionCollapsed = !this.moduleSectionCollapsed;
        void this.render();
      };
      moduleLabel.style.cursor = "pointer";
      
      // 从注册表获取模块列表
      const allModules = this.getModulesFromRegistry();
      
      // 清理 selectedModules，移除不在注册表中的模块
      const validModules = new Set(allModules);
      for (const moduleKey of Array.from(this.selectedModules)) {
        if (!validModules.has(moduleKey as WorkEventKind)) {
          this.selectedModules.delete(moduleKey);
        }
      }
      
      // 获取用户自定义的模块名称，如果没有则使用默认名称
      const statsSettings = (this.plugin.settings as any)?.statsSettings;
      const moduleNames = statsSettings?.moduleNames || {};
      const moduleEnabled = statsSettings?.moduleEnabled || {};
      
      // 构建模块标签映射（使用用户自定义名称或注册表中的模块名称）
      const moduleLabels: Record<string, string> = {};
      for (const moduleId of allModules) {
        moduleLabels[moduleId] = moduleNames[moduleId] || this.getModuleDefaultName(moduleId);
      }

      // 获取所有启用的模块键
      const enabledModuleKeys = Object.keys(moduleLabels).filter((key) => moduleEnabled[key] !== false);

      // 全选：[勾选项] 形式
      const moduleActions = moduleLabelRow.createDiv({ cls: "rslatte-stats-filter-actions" });
      const moduleSelectAllLabel = moduleActions.createEl("label", { cls: "rslatte-stats-checkbox-label" });
      moduleSelectAllLabel.style.margin = "0";
      const moduleSelectAllCheckbox = moduleSelectAllLabel.createEl("input", { type: "checkbox" });
      const allModulesSelected = enabledModuleKeys.length > 0 && enabledModuleKeys.every((key) => this.selectedModules.has(key));
      moduleSelectAllCheckbox.checked = allModulesSelected;
      moduleSelectAllLabel.createSpan({ text: "全选" });
      moduleSelectAllCheckbox.onchange = (e) => {
        e.stopPropagation();
        if (moduleSelectAllCheckbox.checked) {
          enabledModuleKeys.forEach((key) => this.selectedModules.add(key));
        } else {
          this.selectedModules.clear();
        }
        void this.render();
      };

      const moduleOptions = moduleSection.createDiv({ cls: "rslatte-stats-checkbox-group" });
      if (this.moduleSectionCollapsed) {
        moduleOptions.style.display = "none";
      }
      
      // 只显示启用的模块（未设置的默认为启用）
      Object.entries(moduleLabels).forEach(([moduleKey, moduleLabel]) => {
        // 检查模块是否启用（未设置的默认为启用）
        if (moduleEnabled[moduleKey] === false) {
          return; // 跳过未启用的模块
        }
        
        const label = moduleOptions.createEl("label", { cls: "rslatte-stats-checkbox-label" });
        const checkbox = label.createEl("input", { type: "checkbox" });
        checkbox.checked = this.selectedModules.has(moduleKey);
        checkbox.onchange = () => {
          if (checkbox.checked) {
            this.selectedModules.add(moduleKey);
          } else {
            this.selectedModules.delete(moduleKey);
          }
          void this.render();
        };
        label.createSpan({ text: moduleLabel });
      });
    }

    if (seq !== this._renderSeq) return;

    const month = monthInput.value;
    if (!month) {
      // 区块2：月度统计标题
      const titleSection = mainContainer.createDiv({ cls: "rslatte-stats-monthly-title-section" });
      titleSection.createEl("h2", { text: "月度统计数据" });
      
      // 区块3：统计数据（空状态）
      const statsSection = mainContainer.createDiv({ cls: "rslatte-stats-monthly-stats-section" });
      statsSection.createDiv({ cls: "rslatte-stats-empty", text: "请选择月份" });
      return;
    }

    // 区块2：月度统计标题
    const titleSection = mainContainer.createDiv({ cls: "rslatte-stats-monthly-title-section" });
    titleSection.createEl("h2", { text: `月度统计数据 - ${month}` });

    // 区块3：统计数据分区
    const statsSection = mainContainer.createDiv({ cls: "rslatte-stats-monthly-stats-section" });
    
    // 加载统计数据
    statsSection.createDiv({ cls: "rslatte-stats-loading", text: "加载中..." });

    try {
      let stats = await monthlyStatsGenerator.loadStats(month);

      // 如果统计数据不存在，尝试生成
      if (!stats) {
        stats = await monthlyStatsGenerator.generateForMonth(month);
      }

      if (seq !== this._renderSeq) return;

      statsSection.empty();

      if (!stats) {
        statsSection.createDiv({ cls: "rslatte-stats-empty", text: "该月份暂无统计数据，请点击「生成统计」按钮生成" });
        return;
      }

      // 渲染统计数据
      await this.renderStats(statsSection, stats);
    } catch (e) {
      if (seq !== this._renderSeq) return;
      statsSection.empty();
      statsSection.createDiv({ cls: "rslatte-stats-error", text: `加载失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }

  /** 渲染统计数据 */
  private async renderStats(container: HTMLElement, stats: MonthlyStats) {
    // 应用筛选条件
    const selectedSpaceIds = Array.from(this.selectedSpaces);
    const selectedModuleArray = Array.from(this.selectedModules);
    
    // 过滤空间
    const filteredSpaces: Record<string, SpaceMonthlyStats> = {};
    for (const [spaceId, spaceStats] of Object.entries(stats.spaces)) {
      if (selectedSpaceIds.length === 0 || selectedSpaceIds.includes(spaceId)) {
        // 过滤模块
        const filteredModules: Record<string, ModuleMonthlyStats> = {};
        for (const [kind, moduleStats] of Object.entries(spaceStats.modules)) {
          if (selectedModuleArray.length === 0 || selectedModuleArray.includes(kind)) {
            filteredModules[kind] = moduleStats;
          }
        }
        // 只有当空间有至少一个模块时才添加
        if (Object.keys(filteredModules).length > 0) {
          filteredSpaces[spaceId] = {
            ...spaceStats,
            modules: filteredModules,
          };
        }
      }
    }

    // 如果没有筛选结果，显示提示
    if (Object.keys(filteredSpaces).length === 0) {
      container.createDiv({ cls: "rslatte-stats-empty", text: "没有符合筛选条件的数据" });
      return;
    }

    // 按空间渲染（筛选后的）- 每个空间一个分区
    for (const [spaceId, spaceStats] of Object.entries(filteredSpaces)) {
      // 空间分区
      const spaceSection = container.createDiv({ cls: "rslatte-stats-monthly-space-section" });
      spaceSection.createEl("h3", { text: spaceStats.spaceName || spaceId });

      // 按模块渲染（筛选后的）- 每个模块一个分区
      for (const [kind, moduleStats] of Object.entries(spaceStats.modules)) {
        await this.renderModuleStats(spaceSection, kind as WorkEventKind, moduleStats, stats.yearMonth, spaceId);
      }
    }
  }

  /** 渲染单个模块的统计 */
  private async renderModuleStats(container: HTMLElement, kind: WorkEventKind, stats: ModuleMonthlyStats, yearMonth?: string, spaceId?: string) {
    // 模块分区
    const moduleSection = container.createDiv({ cls: "rslatte-stats-monthly-module-section" });
    moduleSection.createEl("h4", { text: this.getKindLabel(kind) });

    // 图表容器（使用 flex 布局，允许一行显示多个图表）
    const LinearChart = moduleSection.createDiv({ cls: "rslatte-stats-monthly-chart" });
    // 项目、项目任务、里程碑、备忘、联系人、输出模块：使用事件折线图
    if (["project", "projecttask", "milestone", "memo", "contact", "output","task","checkin","finance"].includes(kind)) {
      const month = yearMonth || this.selectedMonth || "";
      await this.renderModuleEventLineChart(LinearChart, kind, stats, month, spaceId);
      
      // 统计指标（放在模块分区中，不在图表容器中）
      const metricsbox = moduleSection.createDiv({ cls: "rslatte-stats-monthly-chart" });
      const metrics = metricsbox.createDiv({ cls: "rslatte-stats-monthly-metrics" });
      metrics.createEl("h5", { text: "统计指标" });
      metrics.createDiv({ text: `总事件数：${stats.totalEvents}` });
      if (stats.metrics.averagePerDay) {
        metrics.createDiv({ text: `日均事件数：${stats.metrics.averagePerDay}` });
      }
      if (stats.metrics.peakDay) {
        metrics.createDiv({ text: `峰值日期：${stats.metrics.peakDay}（${stats.metrics.peakDayCount} 个事件）` });
      }
      if (kind === "task") {
        const chartsContainer = moduleSection.createDiv({ cls: "rslatte-stats-monthly-chart" });
        await this.renderTaskStats(moduleSection, chartsContainer, stats, month, spaceId);
      }
      if (kind === "checkin") {
        const chartsContainer = moduleSection.createDiv({ cls: "rslatte-stats-monthly-chart" });
        await this.renderCheckinStats(moduleSection, chartsContainer, stats, month, spaceId);
      }
      if (kind === "finance") {
        const chartsContainer = moduleSection.createDiv({ cls: "rslatte-stats-monthly-module-charts" });
        await this.renderFinanceStats(moduleSection, chartsContainer, stats, month, spaceId);
      }
      return;
    }




    // 其他模块：保持原有的图表
    // 饼图：按操作类型分布
    if (Object.keys(stats.byAction).length > 0) {
      const pieChart = chartsContainer.createDiv({ cls: "rslatte-stats-monthly-chart" });
      pieChart.createEl("h5", { text: "操作类型分布" });
      const pieMermaid = this.generatePieChart(kind, stats.byAction);
      const pieContainer = pieChart.createDiv({ cls: "rslatte-stats-mermaid-container" });
      await MarkdownRenderer.render(
        this.app,
        `\`\`\`mermaid\n${pieMermaid}\n\`\`\``,
        pieContainer,
        "",
        this
      );
    }

    // 折线图：每日事件数
    if (Object.keys(stats.byDay).length > 0) {
      const lineChart = chartsContainer.createDiv({ cls: "rslatte-stats-monthly-chart" });
      lineChart.createEl("h5", { text: "每日事件趋势" });
      const lineMermaid = this.generateLineChart(kind, stats.byDay);
      const lineContainer = lineChart.createDiv({ cls: "rslatte-stats-mermaid-container" });
      await MarkdownRenderer.render(
        this.app,
        `\`\`\`mermaid\n${lineMermaid}\n\`\`\``,
        lineContainer,
        "",
        this
      );
    }

    // 统计指标
    const metrics = moduleSection.createDiv({ cls: "rslatte-stats-monthly-metrics" });
    metrics.createDiv({ text: `总事件数：${stats.totalEvents}` });
    if (stats.metrics.averagePerDay) {
      metrics.createDiv({ text: `日均事件数：${stats.metrics.averagePerDay}` });
    }
    if (stats.metrics.peakDay) {
      metrics.createDiv({ text: `峰值日期：${stats.metrics.peakDay}（${stats.metrics.peakDayCount} 个事件）` });
    }
    if (stats.metrics.totalAmount !== undefined) {
      metrics.createDiv({ text: `总金额：¥${stats.metrics.totalAmount.toFixed(2)}` });
    }
  }

  /** 生成饼图 Mermaid 代码 */
  private generatePieChart(kind: WorkEventKind, byAction: Record<string, number>): string {
    const entries = Object.entries(byAction)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10); // 最多显示10个

    let mermaid = "pie title " + this.getKindLabel(kind) + " 操作类型分布\n";
    for (const [action, count] of entries) {
      mermaid += `  "${action}" : ${count}\n`;
    }
    return mermaid;
  }

  /** 生成折线图 Mermaid 代码 */
  private generateLineChart(kind: WorkEventKind, byDay: Record<string, number>): string {
    const days = Object.keys(byDay).sort();
    if (days.length === 0) return "";

    let mermaid = "xychart-beta\n";
    mermaid += `    title "${this.getKindLabel(kind)} 每日事件趋势"\n`;
    mermaid += `    x-axis [${days.map((d) => d.slice(5)).join(", ")}]\n`;
    mermaid += `    y-axis "事件数" 0 --> ${Math.max(...Object.values(byDay))}\n`;
    mermaid += `    line [${days.map((d) => byDay[d]).join(", ")}]\n`;

    return mermaid;
  }

  /** 渲染打卡统计（使用新的热力图和波形图） */
  private async renderCheckinStats(chartsContainer: HTMLElement, _moduleSection: HTMLElement, _stats: ModuleMonthlyStats, yearMonth: string, spaceId?: string) {
    try {
      // 获取打卡统计缓存
      const recordRSLatte = (this.plugin as any).recordRSLatte;
      if (!recordRSLatte || typeof recordRSLatte.getCheckinStatsCache !== "function") {
        chartsContainer.createDiv({ cls: "rslatte-stats-error", text: "打卡统计缓存服务未初始化" });
        return;
      }

      // 传入空间ID以获取特定空间的缓存数据
      const cache = await recordRSLatte.getCheckinStatsCache(spaceId);
      const cacheItems = cache.items || [];

      if (!yearMonth) {
        chartsContainer.createDiv({ cls: "rslatte-stats-error", text: "无法确定月份" });
        return;
      }

      // 筛选出当前月份的数据
      const monthItems = cacheItems.filter((item: { recordDate: string }) => item.recordDate.startsWith(yearMonth));

      // 按打卡项分组
      const itemsByCheckinId = new Map<string, Array<{ recordDate: string; isDelete?: boolean }>>();
      for (const item of monthItems) {
        if (!itemsByCheckinId.has(item.checkinId)) {
          itemsByCheckinId.set(item.checkinId, []);
        }
        itemsByCheckinId.get(item.checkinId)!.push({
          recordDate: item.recordDate,
          isDelete: item.isDelete,
        });
      }

      // 获取打卡项名称映射
      const checkinNames = await this.getCheckinNames();

      // 渲染每个打卡项的热力图
      if (itemsByCheckinId.size > 0) {
        const heatmapbox = _moduleSection.createDiv({ cls: "rslatte-stats-monthly-chart" });
        
        const heatmapsTitle = heatmapbox.createDiv({ cls: "rslatte-stats-monthly-chart-noborder" });
        heatmapsTitle.createEl("h5", { text: `打卡项月度热力图（共 ${itemsByCheckinId.size} 项）` });

        const heatmapsSection = heatmapbox.createDiv({ cls: "rslatte-stats-checkin-heatmaps" });
        // 按打卡项名称排序
        const sortedCheckinIds = Array.from(itemsByCheckinId.keys()).sort((a, b) => {
          const nameA = checkinNames.get(a) || a;
          const nameB = checkinNames.get(b) || b;
          return nameA.localeCompare(nameB);
        });

        for (const checkinId of sortedCheckinIds) {
          const checkinName = checkinNames.get(checkinId) || checkinId;
          const items = itemsByCheckinId.get(checkinId)!;

          const heatmapContainer = heatmapsSection.createDiv({ cls: "rslatte-stats-checkin-heatmap-item" });
          heatmapContainer.createEl("h6", { text: checkinName });

          // 使用 HTML/CSS 渲染热力图
          this.renderCheckinHeatmapHTML(heatmapContainer, yearMonth, items);
        }
      }

      // 渲染波形图：横轴日期，纵轴当日完成打卡项数量
      const waveformSection = _moduleSection.createDiv({ cls: "rslatte-stats-checkin-waveform" });
      waveformSection.createEl("h5", { text: "每日完成打卡项数量" });

      // 按日期和打卡项去重，统计每日完成的打卡项数量（isDelete 不为 true 的项）
      const dailyCheckinSet = new Map<string, Set<string>>();
      for (const item of monthItems) {
        if (!item.isDelete) {
          const date = item.recordDate;
          if (!dailyCheckinSet.has(date)) {
            dailyCheckinSet.set(date, new Set());
          }
          dailyCheckinSet.get(date)!.add(item.checkinId);
        }
      }

      // 转换为每日计数
      const dailyCompletedCounts: Record<string, number> = {};
      for (const [date, checkinIds] of dailyCheckinSet.entries()) {
        dailyCompletedCounts[date] = checkinIds.size;
      }

      // 生成波形图 Mermaid 代码
      if (Object.keys(dailyCompletedCounts).length > 0) {
        const waveformMermaid = this.generateCheckinWaveform(yearMonth, dailyCompletedCounts);
        const waveformContainer = waveformSection.createDiv({ cls: "rslatte-stats-mermaid-container" });
        await MarkdownRenderer.render(
          this.app,
          `\`\`\`mermaid\n${waveformMermaid}\n\`\`\``,
          waveformContainer,
          "",
          this
        );
      } else {
        waveformSection.createDiv({ cls: "rslatte-stats-empty", text: "该月暂无打卡数据" });
      }
    } catch (e) {
      chartsContainer.createDiv({ cls: "rslatte-stats-error", text: `渲染打卡统计失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }

  /** 获取打卡项名称映射 */
  private async getCheckinNames(): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    try {
      const recordRSLatte = (this.plugin as any).recordRSLatte;
      if (recordRSLatte && typeof recordRSLatte.getListsSnapshot === "function") {
        const lists = await recordRSLatte.getListsSnapshot(false);
        const checkinItems = lists.checkinItems || [];
        for (const item of checkinItems) {
          if (item.active && !item.deletedAt) {
            names.set(item.id, item.name);
          }
        }
      }
    } catch (e) {
      console.warn("[RSLatte] Failed to get checkin names:", e);
    }
    return names;
  }

  /** 生成打卡项月度热力图（使用 HTML/CSS 渲染） */
  private renderCheckinHeatmapHTML(container: HTMLElement, yearMonth: string, items: Array<{ recordDate: string; isDelete?: boolean }>) {
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
      
      // 添加日期标签（仅显示日期，不显示完整日期字符串，避免拥挤）
      // 只在每月的第一天或每周的第一天显示日期，或者根据单元格大小决定
      if (day === 1 || day % 7 === 1 || day <= 7) {
        cell.createDiv({ cls: "rslatte-stats-heatmap-day-label", text: String(day) });
      }
    }
  }

  /** 生成打卡波形图 Mermaid 代码（横轴日期，纵轴当日完成打卡项数量） */
  private generateCheckinWaveform(yearMonth: string, dailyCounts: Record<string, number>): string {
    // 获取该月的所有日期
    const [year, month] = yearMonth.split("-").map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();
    const dates: string[] = [];
    for (let day = 1; day <= daysInMonth; day++) {
      dates.push(`${yearMonth}-${String(day).padStart(2, "0")}`);
    }

    // 构建数据数组
    const counts = dates.map((date) => dailyCounts[date] || 0);
    const maxCount = Math.max(...counts, 1); // 至少为1，避免除零

    // 生成 Mermaid xychart
    let mermaid = "xychart-beta\n";
    mermaid += `    title "${yearMonth} 每日完成打卡项数量"\n`;
    mermaid += `    x-axis [${dates.map((d) => d.slice(8)).join(", ")}]\n`;
    mermaid += `    y-axis "完成数量" 0 --> ${maxCount}\n`;
    mermaid += `    line [${counts.join(", ")}]\n`;

    return mermaid;
  }

  /** 从 WorkEventService 注册表获取所有模块ID列表 */
  private getModulesFromRegistry(): WorkEventKind[] {
    const workEventSvc = (this.plugin as any)?.workEventSvc as WorkEventService | undefined;
    if (!workEventSvc) {
      return [];
    }

    try {
      // 获取注册表
      const registry = workEventSvc.getRegistry();
      
      // 从注册表中提取所有唯一的 kind 值
      const kindSet = new Set<WorkEventKind>();
      
      for (const entry of registry.entries) {
        kindSet.add(entry.kind);
      }
      
      // 转换为数组并排序
      return Array.from(kindSet).sort();
    } catch (error) {
      console.warn("[RSLatte] 从注册表获取模块列表失败:", error);
      return [];
    }
  }

  /** 获取模块的默认名称（从注册表或使用默认映射） */
  private getModuleDefaultName(moduleId: WorkEventKind): string {
    const workEventSvc = (this.plugin as any)?.workEventSvc as WorkEventService | undefined;
    if (workEventSvc) {
      try {
        const registry = workEventSvc.getRegistry();
        // 查找该模块的第一个注册项，获取模块名称
        for (const entry of registry.entries) {
          if (entry.kind === moduleId && entry.module) {
            return entry.module;
          }
        }
      } catch (error) {
        // 忽略错误，使用默认映射
      }
    }
    
    // 如果注册表中没有，使用默认映射
    const defaultNames: Record<WorkEventKind, string> = {
      checkin: "打卡",
      finance: "财务",
      task: "任务",
      projecttask: "项目任务",
      memo: "备忘",
      contact: "联系人",
      project: "项目",
      milestone: "里程碑",
      output: "输出",
      file: "文件",
      sync: "同步",
    };
    
    return defaultNames[moduleId] || moduleId;
  }

  /** 获取模块标签 */
  private getKindLabel(kind: WorkEventKind): string {
    // 获取用户自定义的模块名称
    const statsSettings = (this.plugin.settings as any)?.statsSettings;
    const moduleNames = statsSettings?.moduleNames || {};
    
    const defaultLabels: Record<WorkEventKind, string> = {
      checkin: "打卡",
      finance: "财务",
      task: "任务",
      projecttask: "项目任务",
      memo: "备忘",
      contact: "联系人",
      project: "项目",
      milestone: "里程碑",
      output: "输出",
      file: "文件",
      sync: "同步",
    };
    
    return moduleNames[kind] || defaultLabels[kind] || kind;
  }

  /** 渲染财务统计（使用新的图表） */
  private async renderFinanceStats(chartsContainer: HTMLElement, moduleSection: HTMLElement, _stats: ModuleMonthlyStats, yearMonth: string, spaceId?: string) {
    try {
      // 获取财务统计缓存
      const recordRSLatte = (this.plugin as any).recordRSLatte;
      if (!recordRSLatte || typeof recordRSLatte.getFinanceStatsCache !== "function") {
        chartsContainer.createDiv({ cls: "rslatte-stats-error", text: "财务统计缓存服务未初始化" });
        return;
      }

      // 传入空间ID以获取特定空间的缓存数据
      const cache = await recordRSLatte.getFinanceStatsCache(spaceId);
      const cacheItems = cache.items || [];

      // 检查调试开关
      const s: any = this.plugin.settings;
      const isDebugEnabled = s?.debugLogEnabled === true;

      if (!yearMonth) {
        chartsContainer.createDiv({ cls: "rslatte-stats-error", text: "无法确定月份" });
        return;
      }

      // 过滤出指定月份的数据（isDelete 不为 true）
      const monthItems = cacheItems.filter(
        (item: FinanceStatsCacheItem) => item.recordDate.startsWith(yearMonth) && !item.isDelete
      );

      // 调试日志：只在调试开关启用时输出
      if (isDebugEnabled) {
        console.log(`[RSLatte][FinanceStats][DEBUG] spaceId: ${spaceId}, cache items count: ${cacheItems.length}`);
        if (cacheItems.length > 0) {
          const sampleDates = cacheItems.slice(0, 5).map((item: FinanceStatsCacheItem) => item.recordDate);
          console.log(`[RSLatte][FinanceStats][DEBUG] Sample dates from cache:`, sampleDates);
        }
        console.log(`[RSLatte][FinanceStats][DEBUG] Filtered month items count: ${monthItems.length} for ${yearMonth}`);
        if (monthItems.length > 0) {
          const uniqueDates = [...new Set(monthItems.map((item: FinanceStatsCacheItem) => item.recordDate))].sort();
          console.log(`[RSLatte][FinanceStats][DEBUG] Unique dates in month:`, uniqueDates);
        }
      }

      if (monthItems.length === 0) {
        chartsContainer.createDiv({ cls: "rslatte-stats-empty", text: "该月份没有财务数据" });
        return;
      }

      // 获取财务分类名称
      const categoryMap = await this.getFinanceCategoryNames(spaceId);

      // 分离收入和支出
      const incomeItems = monthItems.filter((item: FinanceStatsCacheItem) => item.type === "income");
      const expenseItems = monthItems.filter((item: FinanceStatsCacheItem) => item.type === "expense");

      // 图一：支出饼图（按分类）
      if (expenseItems.length > 0) {
        const expensePieSection = moduleSection.createDiv({ cls: "rslatte-stats-monthly-chart" });
        expensePieSection.createEl("h5", { text: "支出分类占比" });
        const expensePieMermaid = this.generateFinanceCategoryPieChart(expenseItems, categoryMap, "expense");
        const expensePieContainer = expensePieSection.createDiv({ cls: "rslatte-stats-mermaid-container" });
        await MarkdownRenderer.render(
          this.app,
          `\`\`\`mermaid\n${expensePieMermaid}\n\`\`\``,
          expensePieContainer,
          "",
          this
        );
      }
      // 图六：收入饼图（分类-子分类）
      if (incomeItems.length > 0) {
        const incomePieSection = moduleSection.createDiv({ cls: "rslatte-stats-monthly-chart" });
        incomePieSection.createEl("h5", { text: "收入分类-子分类占比" });
        const incomePieMermaid = this.generateFinanceSubcategoryPieChart(incomeItems, categoryMap);
        const incomePieContainer = incomePieSection.createDiv({ cls: "rslatte-stats-mermaid-container" });
        await MarkdownRenderer.render(
          this.app,
          `\`\`\`mermaid\n${incomePieMermaid}\n\`\`\``,
          incomePieContainer,
          "",
          this
        );
      }

      // 图四：总事件数图（统计指标放在模块分区中）
      const metricsSection = moduleSection.createDiv({ cls: "rslatte-stats-monthly-chart" });
      metricsSection.createEl("h5", { text: "统计指标" });
      const totalEvents = monthItems.length;
      const daysInMonth = new Date(yearMonth + "-01").getDate();
      const averagePerDay = (totalEvents / daysInMonth).toFixed(2);
      
      // 计算峰值日期
      const dailyCounts: Record<string, number> = {};
      for (const item of monthItems) {
        dailyCounts[item.recordDate] = (dailyCounts[item.recordDate] || 0) + 1;
      }
      let peakDay = "";
      let peakDayCount = 0;
      for (const [date, count] of Object.entries(dailyCounts)) {
        if (count > peakDayCount) {
          peakDayCount = count;
          peakDay = date;
        }
      }

      // 计算收入总额和支出总额
      const incomeTotal = incomeItems.reduce((sum: number, item: FinanceStatsCacheItem) => sum + Math.abs(item.amount), 0);
      const expenseTotal = expenseItems.reduce((sum: number, item: FinanceStatsCacheItem) => sum + Math.abs(item.amount), 0);

      metricsSection.createDiv({ text: `总事件数：${totalEvents}` });
      metricsSection.createDiv({ text: `日均事件数：${averagePerDay}` });
      if (peakDay) {
        metricsSection.createDiv({ text: `峰值日期：${peakDay}（${peakDayCount} 个事件）` });
      }
      metricsSection.createDiv({ text: `收入总额：¥${incomeTotal.toFixed(2)}` });
      metricsSection.createDiv({ text: `支出总额：¥${expenseTotal.toFixed(2)}` });

      // 图五：子分类总额top3
      if (expenseItems.length > 0) {
        const subcategoryTop3Section = moduleSection.createDiv({ cls: "rslatte-stats-monthly-chart" });
        subcategoryTop3Section.createEl("h5", { text: "支出子分类总额 Top 3" });
        const subcategoryTop3 = this.getSubcategoryTop3(expenseItems, categoryMap);
        const subcategoryList = subcategoryTop3Section.createDiv({ cls: "rslatte-stats-subcategory-list" });
        for (const item of subcategoryTop3) {
          subcategoryList.createDiv({ text: `${item.label}：¥${item.amount.toFixed(2)}` });
        }
      }
      // 图三：日支出波动图
      if (expenseItems.length > 0) {
        const dailyExpenseSection = moduleSection.createDiv({ cls: "rslatte-stats-monthly-chart" });
        dailyExpenseSection.createEl("h5", { text: "日支出波动图" });
        
        // 调试日志：只在调试开关启用时输出
        if (isDebugEnabled) {
          console.log(`[RSLatte][FinanceChart][DEBUG] Generating chart for ${yearMonth}, total items: ${expenseItems.length}`);
          const dailyAmounts: Record<string, number> = {};
          for (const item of expenseItems) {
            dailyAmounts[item.recordDate] = (dailyAmounts[item.recordDate] || 0) + Math.abs(item.amount);
          }
          console.log(`[RSLatte][FinanceChart][DEBUG] Daily amounts keys:`, Object.keys(dailyAmounts));
          const daysInMonth = new Date(yearMonth + "-01").getDate();
          console.log(`[RSLatte][FinanceChart][DEBUG] Days in month: ${daysInMonth}, dates will be generated: ${daysInMonth} dates`);
        }
        
        const dailyExpenseMermaid = this.generateDailyExpenseChart(expenseItems, yearMonth, isDebugEnabled);
        const dailyExpenseContainer = dailyExpenseSection.createDiv({ cls: "rslatte-stats-mermaid-container" });
        await MarkdownRenderer.render(
          this.app,
          `\`\`\`mermaid\n${dailyExpenseMermaid}\n\`\`\``,
          dailyExpenseContainer,
          "",
          this
        );
      }
    } catch (e) {
      console.error("[RSLatte][MonthlyStats] Failed to render finance stats:", e);
      chartsContainer.createDiv({ cls: "rslatte-stats-error", text: `渲染财务统计失败：${String(e)}` });
    }
  }

  /** 获取财务分类名称映射 */
  private async getFinanceCategoryNames(_spaceId?: string): Promise<Map<string, string>> {
    const categoryMap = new Map<string, string>();
    try {
      const recordRSLatte = (this.plugin as any).recordRSLatte;
      if (recordRSLatte && typeof recordRSLatte.getListsSnapshot === "function") {
        const lists = await recordRSLatte.getListsSnapshot(false);
        if (lists.financeCategories) {
          for (const cat of lists.financeCategories) {
            if (cat.active !== false) {
              categoryMap.set(cat.id, cat.name || cat.id);
            }
          }
        }
      }
    } catch (e) {
      console.warn("[RSLatte][MonthlyStats] Failed to get finance category names:", e);
    }
    return categoryMap;
  }

  /** 生成财务分类饼图（支出） */
  private generateFinanceCategoryPieChart(
    items: FinanceStatsCacheItem[],
    categoryMap: Map<string, string>,
    _type: "income" | "expense"
  ): string {
    // 按分类汇总金额
    const categoryAmounts: Record<string, number> = {};
    for (const item of items) {
      const categoryName = categoryMap.get(item.categoryId) || item.categoryId;
      categoryAmounts[categoryName] = (categoryAmounts[categoryName] || 0) + Math.abs(item.amount);
    }

    // 转换为饼图数据
    const pieData: Array<{ label: string; value: number }> = [];
    for (const [category, amount] of Object.entries(categoryAmounts)) {
      pieData.push({ label: category, value: amount });
    }

    // 按金额降序排序
    pieData.sort((a, b) => b.value - a.value);

    // 生成 Mermaid 饼图
    const lines: string[] = ["pie title 支出分类占比"];
    for (const item of pieData) {
      lines.push(`    "${item.label}" : ${item.value.toFixed(2)}`);
    }

    return lines.join("\n");
  }

  /** 生成日支出波动图 */
  private generateDailyExpenseChart(items: FinanceStatsCacheItem[], yearMonth: string, isDebugEnabled: boolean = false): string {
    // 按日期汇总支出
    const dailyAmounts: Record<string, number> = {};
    for (const item of items) {
      dailyAmounts[item.recordDate] = (dailyAmounts[item.recordDate] || 0) + Math.abs(item.amount);
    }

    // 获取月份的所有日期
    // 注意：new Date(yearMonth + "-01") 创建的是该月第一天的日期
    // getDate() 返回的是该日期对象所在月份的天数（1-31）
    // 但这里应该使用 getDate() 获取该日期是几号，然后计算该月有多少天
    // 正确的方式是：创建下个月的第一天，然后减去1天，再获取日期
    const year = parseInt(yearMonth.split("-")[0]);
    const month = parseInt(yearMonth.split("-")[1]);
    const daysInMonth = new Date(year, month, 0).getDate(); // 获取该月的天数
    
    const dates: string[] = [];
    const amounts: number[] = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const date = `${yearMonth}-${String(day).padStart(2, "0")}`;
      // 格式化为只显示日期（01、02、03），不包含月份
      const dateLabel = String(day).padStart(2, "0"); // 从 day=1 得到 "01"
      dates.push(dateLabel);
      amounts.push(dailyAmounts[date] || 0);
    }

    // 调试日志：只在调试开关启用时输出
    if (isDebugEnabled) {
      console.log(`[RSLatte][FinanceChart][DEBUG] yearMonth: ${yearMonth}, year: ${year}, month: ${month}, daysInMonth: ${daysInMonth}`);
      console.log(`[RSLatte][FinanceChart][DEBUG] Total dates generated: ${dates.length}, amounts with data: ${amounts.filter(a => a > 0).length}`);
      console.log(`[RSLatte][FinanceChart][DEBUG] First 10 dates:`, dates.slice(0, 10));
      console.log(`[RSLatte][FinanceChart][DEBUG] Last 10 dates:`, dates.slice(-10));
      console.log(`[RSLatte][FinanceChart][DEBUG] First 10 amounts:`, amounts.slice(0, 10));
    }

    // 调试：检查数据（只在调试开关启用时输出）
    // 注意：这个方法没有直接访问 plugin.settings，所以需要在调用时检查
    // 为了保持一致性，我们不在这个方法内部检查，而是在调用处传入标志

    // 生成 Mermaid xychart（使用折线图显示波动趋势）
    // 日期标签包含连字符，需要用引号包裹（Mermaid xychart-beta 要求）
    const maxAmount = Math.max(...amounts, 100);
    let mermaid = "xychart-beta\n";
    mermaid += `    title "日支出波动图"\n`;
    // 为每个日期标签添加引号，确保正确解析
    // 注意：如果日期太多，Mermaid 可能无法正确渲染，所以只显示有数据的日期范围
    const hasDataDates: string[] = [];
    const hasDataAmounts: number[] = [];
    for (let i = 0; i < dates.length; i++) {
      hasDataDates.push(dates[i]);
      hasDataAmounts.push(amounts[i]);
    }
    
    mermaid += `    x-axis [${hasDataDates.map((d) => `"${d}"`).join(", ")}]\n`;
    mermaid += `    y-axis "支出金额" 0 --> ${maxAmount}\n`;
    mermaid += `    line [${hasDataAmounts.join(", ")}]\n`;

    return mermaid;
  }

  /** 获取子分类总额 Top 3 */
  private getSubcategoryTop3(
    items: FinanceStatsCacheItem[],
    categoryMap: Map<string, string>
  ): Array<{ label: string; amount: number }> {
    // 按分类-子分类汇总金额
    const subcategoryAmounts: Record<string, number> = {};
    for (const item of items) {
      const categoryName = categoryMap.get(item.categoryId) || item.categoryId;
      const subcategory = item.subcategory || "未分类";
      const label = `${categoryName}-${subcategory}`;
      subcategoryAmounts[label] = (subcategoryAmounts[label] || 0) + Math.abs(item.amount);
    }

    // 转换为数组并排序
    const result: Array<{ label: string; amount: number }> = [];
    for (const [label, amount] of Object.entries(subcategoryAmounts)) {
      result.push({ label, amount });
    }
    result.sort((a, b) => b.amount - a.amount);

    // 返回 Top 3
    return result.slice(0, 3);
  }

  /** 生成财务子分类饼图（收入，分类-子分类） */
  private generateFinanceSubcategoryPieChart(
    items: FinanceStatsCacheItem[],
    categoryMap: Map<string, string>
  ): string {
    // 按分类-子分类汇总金额
    const subcategoryAmounts: Record<string, number> = {};
    for (const item of items) {
      const categoryName = categoryMap.get(item.categoryId) || item.categoryId;
      const subcategory = item.subcategory || "未分类";
      const label = `${categoryName}-${subcategory}`;
      subcategoryAmounts[label] = (subcategoryAmounts[label] || 0) + Math.abs(item.amount);
    }

    // 转换为饼图数据
    const pieData: Array<{ label: string; value: number }> = [];
    for (const [label, amount] of Object.entries(subcategoryAmounts)) {
      pieData.push({ label, value: amount });
    }

    // 按金额降序排序
    pieData.sort((a, b) => b.value - a.value);

    // 生成 Mermaid 饼图
    const lines: string[] = ["pie title 收入分类-子分类占比"];
    for (const item of pieData) {
      lines.push(`    "${item.label}" : ${item.value.toFixed(2)}`);
    }

    return lines.join("\n");
  }

  /** 渲染任务统计（使用新的图表和统计信息） */
  private async renderTaskStats(chartsContainer: HTMLElement, moduleSection: HTMLElement, stats: ModuleMonthlyStats, yearMonth: string, spaceId?: string) {
    try {
      if (!yearMonth) {
        chartsContainer.createDiv({ cls: "rslatte-stats-error", text: "无法确定月份" });
        return;
      }

      // 检查调试开关
      const s: any = this.plugin.settings;
      const isDebugEnabled = s?.debugLogEnabled === true;

      // 图一：总事件数图（统计指标放在模块分区中）
      const metricsSection = moduleSection.createDiv({ cls: "rslatte-stats-monthly-metrics" });
      metricsSection.createEl("h5", { text: "业务数据统计" });
      //metricsSection.createDiv({ text: `总事件数：${stats.totalEvents}` });

      // 图三：任务统计（放在模块分区中）
      //const taskStatsSection = moduleSection.createDiv({ cls: "rslatte-stats-task-stats" });
      //taskStatsSection.createEl("h5", { text: "任务统计" });

      // 从任务统计缓存计算统计信息
      const recordRSLatte = (this.plugin as any).recordRSLatte;
      if (!recordRSLatte || typeof recordRSLatte.getTaskStatsCache !== "function") {
        metricsSection.createDiv({ cls: "rslatte-stats-error", text: "任务统计服务未初始化" });
        return;
      }

      const taskCache = await recordRSLatte.getTaskStatsCache(spaceId);
      const taskStats = this.calculateTaskStatsFromCache(taskCache.items, yearMonth, isDebugEnabled);
      
      // 本月任务新增
      metricsSection.createDiv({ text: `本月任务新增 ${taskStats.totalCreated} 条` });
      const createdDetails = metricsSection.createDiv({ cls: "rslatte-stats-task-stats-details" });
      createdDetails.createDiv({ text: ` - 其中解决 ${taskStats.createdAndDone} 条` });
      createdDetails.createDiv({ text: ` - 进行中 ${taskStats.createdAndInProgress} 条` });
      createdDetails.createDiv({ text: ` - 未开始 ${taskStats.createdAndTodo} 条` });

      // 本月任务完成
      metricsSection.createDiv({ text: `本月任务完成 ${taskStats.totalCompleted} 条` });
      const completedDetails = metricsSection.createDiv({ cls: "rslatte-stats-task-stats-details" });
      completedDetails.createDiv({ text: ` - 其中超期完成 ${taskStats.completedOverdue} 条` });
      completedDetails.createDiv({ text: ` - 完成周期超7天 ${taskStats.completedOver7Days} 条` });

      // 本月截至当前遗留任务
      metricsSection.createDiv({ text: `本月截至当前遗留 ${taskStats.totalRemaining} 条任务未解决` });
      const remainingDetails = metricsSection.createDiv({ cls: "rslatte-stats-task-stats-details" });
      remainingDetails.createDiv({ text: ` - 进行中 ${taskStats.remainingInProgress} 条` });
      remainingDetails.createDiv({ text: ` - 未开始 ${taskStats.remainingTodo} 条` });

    } catch (e) {
      console.error("[RSLatte][MonthlyStats] Failed to render task stats:", e);
      chartsContainer.createDiv({ cls: "rslatte-stats-error", text: `渲染任务统计失败：${String(e)}` });
    }
  }

  /** 渲染模块事件折线图（用于项目、项目任务、里程碑、备忘、联系人、输出、打卡、财务、任务） */
  private async renderModuleEventLineChart(
    chartsContainer: HTMLElement,
    kind: WorkEventKind,
    _stats: ModuleMonthlyStats,
    yearMonth: string,
    spaceId?: string
  ): Promise<void> {
    try {
      if (!yearMonth) {
        chartsContainer.createDiv({ cls: "rslatte-stats-error", text: "无法确定月份" });
        return;
      }

      // 从 WorkEventReader 获取原始事件数据
      const workEventReader = (this.plugin as any).workEventReader;
      if (!workEventReader) {
        chartsContainer.createDiv({ cls: "rslatte-stats-error", text: "事件读取服务未初始化" });
        return;
      }

      // 获取该月的原始事件数据
      const parts = yearMonth.split("-");
      const year = Number(parts[0]);
      const month = Number(parts[1]);
      const monthKey = `${year}${String(month).padStart(2, "0")}`;
      
      let moduleEvents: WorkEvent[] = [];
      if (spaceId) {
        moduleEvents = await workEventReader.readEvents(spaceId, monthKey);
      } else {
        // 如果没有指定空间ID，尝试从所有空间获取
        const spaces = workEventReader.getSpaces() || [];
        for (const space of spaces) {
          const events = await workEventReader.readEvents(space.id, monthKey);
          moduleEvents.push(...events);
        }
      }

      // 过滤出该模块的事件
      const moduleEventsOnly = moduleEvents.filter(e => e.kind === kind);

      // 检查调试开关
      const s: any = this.plugin.settings;
      const isDebugEnabled = s?.debugLogEnabled === true;

      // 判断模块类型：打卡和财务使用 create/update/delete，其他模块使用 create/start/complete
      const isCreateUpdateDeleteType = kind === "checkin" || kind === "finance";

      // 按日期统计操作的数量
      const createByDay: Record<string, number> = {};
      const startByDay: Record<string, number> = {}; // status 变更为 IN_PROGRESS（用于项目等模块）
      const completeByDay: Record<string, number> = {}; // status 变更为 DONE（用于项目等模块）
      const updateByDay: Record<string, number> = {}; // update 动作（用于打卡、财务模块）
      const deleteByDay: Record<string, number> = {}; // delete 动作（用于打卡、财务模块）

      for (const event of moduleEventsOnly) {
        const day = event.ts.slice(0, 10); // YYYY-MM-DD

        if (event.action === "create") {
          createByDay[day] = (createByDay[day] || 0) + 1;
        } else if (isCreateUpdateDeleteType) {
          // 打卡和财务模块：统计 update 和 delete
          if (event.action === "update") {
            updateByDay[day] = (updateByDay[day] || 0) + 1;
          } else if (event.action === "delete") {
            deleteByDay[day] = (deleteByDay[day] || 0) + 1;
          }
        } else {
          // 其他模块：统计 status 变更
          if (event.action === "status") {
            // 状态可能在 ref.to 或 metrics.status 中
            const status = String((event.ref as any)?.to || event.metrics?.status || "").toUpperCase();
            if (status === "IN_PROGRESS") {
              startByDay[day] = (startByDay[day] || 0) + 1;
            } else if (status === "DONE") {
              completeByDay[day] = (completeByDay[day] || 0) + 1;
            }
          }
        }
      }

      // 调试日志
      if (isDebugEnabled) {
        console.log(`[RSLatte][${kind}Stats][DEBUG] ${kind} events count: ${moduleEventsOnly.length}`);
        console.log(`[RSLatte][${kind}Stats][DEBUG] Create events by day:`, Object.keys(createByDay).length, "days");
        if (isCreateUpdateDeleteType) {
          console.log(`[RSLatte][${kind}Stats][DEBUG] Update events by day:`, Object.keys(updateByDay).length, "days");
          console.log(`[RSLatte][${kind}Stats][DEBUG] Delete events by day:`, Object.keys(deleteByDay).length, "days");
        } else {
          console.log(`[RSLatte][${kind}Stats][DEBUG] Start events by day:`, Object.keys(startByDay).length, "days");
          console.log(`[RSLatte][${kind}Stats][DEBUG] Complete events by day:`, Object.keys(completeByDay).length, "days");
        }
      }

      // 生成事件折线图
      const hasData = isCreateUpdateDeleteType
        ? (Object.keys(createByDay).length > 0 || Object.keys(updateByDay).length > 0 || Object.keys(deleteByDay).length > 0)
        : (Object.keys(createByDay).length > 0 || Object.keys(startByDay).length > 0 || Object.keys(completeByDay).length > 0);

      if (hasData) {
        const label = this.getKindLabel(kind);
        const lineChartSection = chartsContainer.createDiv({ cls: "rslatte-stats-monthly-chart-noborder" });
        lineChartSection.createEl("h5", { text: `${label}事件折线图` });
        const lineChartMermaid = isCreateUpdateDeleteType
          ? this.generateModuleEventLineChart(
              createByDay,
              updateByDay,
              deleteByDay,
              yearMonth,
              kind,
              isDebugEnabled
            )
          : this.generateModuleEventLineChart(
              createByDay,
              startByDay,
              completeByDay,
              yearMonth,
              kind,
              isDebugEnabled
            );
        const lineChartContainer = lineChartSection.createDiv({ cls: "rslatte-stats-mermaid-container" });
        await MarkdownRenderer.render(
          this.app,
          `\`\`\`mermaid\n${lineChartMermaid}\n\`\`\``,
          lineChartContainer,
          "",
          this
        );
        
        // 添加图例（等待图表渲染后从 DOM 读取实际颜色）
        const legendContainer = lineChartSection.createDiv({ cls: "rslatte-stats-chart-legend" });
        legendContainer.style.display = "flex";
        legendContainer.style.gap = "16px";
        legendContainer.style.justifyContent = "center";
        legendContainer.style.marginTop = "8px";
        legendContainer.style.fontSize = "12px";
        legendContainer.style.color = "var(--text-muted)";
        
        // 等待图表渲染完成后，从 DOM 读取实际线条颜色
        setTimeout(() => {
          this.updateChartLegend(legendContainer, lineChartContainer, kind);
        }, 500);
      }
    } catch (e) {
      console.error(`[RSLatte][MonthlyStats] Failed to render ${kind} event line chart:`, e);
      chartsContainer.createDiv({ cls: "rslatte-stats-error", text: `渲染${this.getKindLabel(kind)}事件折线图失败：${String(e)}` });
    }
  }

  /** 生成模块事件折线图（支持两种模式：新增/开始/完成 或 新增/修改/删除） */
  private generateModuleEventLineChart(
    createByDay: Record<string, number>,
    secondByDay: Record<string, number>, // 可能是 start/update
    thirdByDay: Record<string, number>, // 可能是 complete/delete
    yearMonth: string,
    kind: WorkEventKind,
    isDebugEnabled: boolean = false
  ): string {
    // 判断模块类型：打卡和财务使用 create/update/delete，其他模块使用 create/start/complete
    const isCreateUpdateDeleteType = kind === "checkin" || kind === "finance";
    const secondLabel = isCreateUpdateDeleteType ? "修改" : "开始";
    const thirdLabel = isCreateUpdateDeleteType ? "删除" : "完成";
    // 获取月份的所有日期
    const year = parseInt(yearMonth.split("-")[0]);
    const month = parseInt(yearMonth.split("-")[1]);
    const daysInMonth = new Date(year, month, 0).getDate();

    // 生成所有日期标签（只显示日期，不带月份）
    const dates: string[] = [];
    const createAmounts: number[] = [];
    const secondAmounts: number[] = [];
    const thirdAmounts: number[] = [];

    for (let day = 1; day <= daysInMonth; day++) {
      const date = `${yearMonth}-${String(day).padStart(2, "0")}`;
      const dateLabel = String(day).padStart(2, "0");
      dates.push(dateLabel);
      createAmounts.push(createByDay[date] || 0);
      secondAmounts.push(secondByDay[date] || 0);
      thirdAmounts.push(thirdByDay[date] || 0);
    }

    // 调试日志
    if (isDebugEnabled) {
      const label = this.getKindLabel(kind);
      console.log(`[RSLatte][${label}Chart][DEBUG] Generating ${kind} event chart for ${yearMonth}`);
      console.log(`[RSLatte][${label}Chart][DEBUG] Days with create events:`, Object.keys(createByDay).sort());
      console.log(`[RSLatte][${label}Chart][DEBUG] Days with ${secondLabel} events:`, Object.keys(secondByDay).sort());
      console.log(`[RSLatte][${label}Chart][DEBUG] Days with ${thirdLabel} events:`, Object.keys(thirdByDay).sort());
    }

    // 计算最大值用于设置 Y 轴
    const maxValue = Math.max(
      ...createAmounts,
      ...secondAmounts,
      ...thirdAmounts,
      1 // 至少为1，避免除零
    );

    // 生成 Mermaid xychart（三条折线）
    const label = this.getKindLabel(kind);
    let mermaid = "xychart-beta\n";
    mermaid += `    title "${label}事件折线图"\n`;
    mermaid += `    x-axis [${dates.map((d) => `"${d}"`).join(", ")}]\n`;
    mermaid += `    y-axis "事件数" 0 --> ${maxValue}\n`;
    mermaid += `    line "新增" [${createAmounts.join(", ")}]\n`;
    mermaid += `    line "${secondLabel}" [${secondAmounts.join(", ")}]\n`;
    mermaid += `    line "${thirdLabel}" [${thirdAmounts.join(", ")}]\n`;

    return mermaid;
  }

  /** 更新折线图图例，从实际渲染的图表中读取线条颜色（通用方法） */
  private updateChartLegend(legendContainer: HTMLElement, chartContainer: HTMLElement, kind?: WorkEventKind): void {
    try {
      // 查找 Mermaid 渲染的 SVG
      const svg = chartContainer.querySelector("svg");
      if (!svg) {
        // 如果找不到 SVG，使用默认颜色
        this.createDefaultLegend(legendContainer, kind);
        return;
      }

      // 查找所有折线路径（path 元素，通常是折线）
      const paths = Array.from(svg.querySelectorAll("path[stroke]"));
      
      // 过滤出有 stroke 且不是透明的路径
      const linePaths = paths.filter(path => {
        const stroke = (path as SVGPathElement).getAttribute("stroke");
        return stroke && stroke !== "none" && stroke !== "transparent";
      });

      // 获取计算后的实际颜色（考虑 CSS 样式）
      const lineColors: string[] = [];
      for (const path of linePaths) {
        const computedStyle = window.getComputedStyle(path as Element);
        const strokeColor = computedStyle.stroke || (path as SVGPathElement).getAttribute("stroke");
        if (strokeColor && strokeColor !== "none" && !lineColors.includes(strokeColor)) {
          lineColors.push(strokeColor);
        }
      }

      // 如果找到了颜色，使用实际颜色；否则使用默认颜色
      // 注意：Mermaid 按 line 声明的顺序渲染
      // 判断模块类型：打卡和财务使用 create/update/delete，其他模块使用 create/start/complete
      const isCreateUpdateDeleteType = kind === "checkin" || kind === "finance";
      const secondLabel = isCreateUpdateDeleteType ? "修改" : "开始";
      const thirdLabel = isCreateUpdateDeleteType ? "删除" : "完成";
      
      const legendItems = [
        { label: "新增", color: lineColors[0] || "#FF6B6B" },
        { label: secondLabel, color: lineColors[1] || "#4ECDC4" },
        { label: thirdLabel, color: lineColors[2] || "#95E1D3" }
      ];

      // 清空现有图例
      legendContainer.empty();

      // 创建图例项
      for (const item of legendItems) {
        const legendItem = legendContainer.createDiv();
        legendItem.style.display = "flex";
        legendItem.style.alignItems = "center";
        legendItem.style.gap = "6px";
        
        const colorIndicator = legendItem.createSpan();
        colorIndicator.style.width = "12px";
        colorIndicator.style.height = "2px";
        colorIndicator.style.backgroundColor = item.color;
        colorIndicator.style.display = "inline-block";
        
        const label = legendItem.createSpan();
        label.textContent = item.label;
      }
      } catch (e) {
        console.warn("[RSLatte] Failed to update chart legend:", e);
        // 如果出错，使用默认图例
        this.createDefaultLegend(legendContainer, kind);
      }
  }


  /** 创建默认图例（当无法读取实际颜色时使用） */
  private createDefaultLegend(legendContainer: HTMLElement, kind?: WorkEventKind): void {
    // 判断模块类型：打卡和财务使用 create/update/delete，其他模块使用 create/start/complete
    const isCreateUpdateDeleteType = kind === "checkin" || kind === "finance";
    const secondLabel = isCreateUpdateDeleteType ? "修改" : "开始";
    const thirdLabel = isCreateUpdateDeleteType ? "删除" : "完成";
    
    const legendItems = [
      { label: "新增", color: "#FF6B6B" },
      { label: secondLabel, color: "#4ECDC4" },
      { label: thirdLabel, color: "#95E1D3" }
    ];

    legendContainer.empty();

    for (const item of legendItems) {
      const legendItem = legendContainer.createDiv();
      legendItem.style.display = "flex";
      legendItem.style.alignItems = "center";
      legendItem.style.gap = "6px";
      
      const colorIndicator = legendItem.createSpan();
      colorIndicator.style.width = "12px";
      colorIndicator.style.height = "2px";
      colorIndicator.style.backgroundColor = item.color;
      colorIndicator.style.display = "inline-block";
      
      const label = legendItem.createSpan();
      label.textContent = item.label;
    }
  }

  /** 从任务统计缓存计算任务统计信息 */
  private calculateTaskStatsFromCache(items: TaskStatsCacheItem[], yearMonth: string, isDebugEnabled: boolean = false): {
    totalCreated: number;
    createdAndDone: number;
    createdAndInProgress: number;
    createdAndTodo: number;
    totalCompleted: number;
    completedOverdue: number;
    completedOver7Days: number;
    totalRemaining: number;
    remainingInProgress: number;
    remainingTodo: number;
  } {
    const result = {
      totalCreated: 0,
      createdAndDone: 0,
      createdAndInProgress: 0,
      createdAndTodo: 0,
      totalCompleted: 0,
      completedOverdue: 0,
      completedOver7Days: 0,
      totalRemaining: 0,
      remainingInProgress: 0,
      remainingTodo: 0,
    };

    // 过滤出未删除的任务
    const activeItems = items.filter(item => !item.isDelete);

    // 遍历所有任务项，统计各项指标
    for (const item of activeItems) {
      const status = (item.status || "TODO").toUpperCase();
      
      // 统计本月新增的任务
      if (item.createdDate && item.createdDate.startsWith(yearMonth)) {
        result.totalCreated++;
        
        // 统计本月新增任务的最终状态
        if (status === "DONE") {
          result.createdAndDone++;
        } else if (status === "IN_PROGRESS") {
          result.createdAndInProgress++;
        } else {
          result.createdAndTodo++;
        }
      }

      // 统计本月完成的任务
      if (item.doneDate && item.doneDate.startsWith(yearMonth)) {
        result.totalCompleted++;
        
        // 检查是否超期完成（完成日期 > 截止日期）
        if (item.dueDate && item.doneDate > item.dueDate) {
          result.completedOverdue++;
        }

        // 检查完成周期是否超7天（完成日期 - 创建日期 > 7天）
        if (item.createdDate) {
          const createDate = new Date(item.createdDate);
          const doneDate = new Date(item.doneDate);
          const daysDiff = Math.floor((doneDate.getTime() - createDate.getTime()) / (1000 * 60 * 60 * 24));
          if (daysDiff > 7) {
            result.completedOver7Days++;
          }
        }
      }
    }

    // 统计遗留任务（本月内创建且未完成的任务）
    const today = new Date().toISOString().slice(0, 10);
    const year = parseInt(yearMonth.split("-")[0]);
    const month = parseInt(yearMonth.split("-")[1]);
    const daysInMonth = new Date(year, month, 0).getDate();
    const monthEndDate = new Date(year, month - 1, daysInMonth, 23, 59, 59, 999).toISOString().slice(0, 10);
    const cutoffDate = today <= monthEndDate ? today : monthEndDate;

    for (const item of activeItems) {
      // 只统计本月创建的任务
      if (!item.createdDate || !item.createdDate.startsWith(yearMonth)) continue;
      
      const itemStatus = (item.status || "TODO").toUpperCase();
      
      // 如果已取消，不算遗留
      if (itemStatus === "CANCELLED") continue;
      
      // 如果已完成，且完成日期在本月或之前，不算遗留
      if (item.doneDate && item.doneDate <= cutoffDate) continue;

      // 未完成的任务计入遗留
      result.totalRemaining++;
      if (itemStatus === "IN_PROGRESS") {
        result.remainingInProgress++;
      } else {
        result.remainingTodo++;
      }
    }

    // 调试日志
    if (isDebugEnabled) {
      console.log(`[RSLatte][TaskStats][DEBUG] Calculated task stats:`, result);
    }

    return result;
  }
}
