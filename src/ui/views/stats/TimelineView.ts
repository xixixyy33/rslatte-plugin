import { ItemView, WorkspaceLeaf } from "obsidian";
import type RSLattePlugin from "../../../main";
import { getModuleColor } from "../../../utils/stats/colors";
import type { WorkEvent, WorkEventAction, WorkEventSource, WorkEventKind } from "../../../types/stats/workEvent";
import type { WorkEventService } from "../../../services/workEventService";

export const VIEW_TYPE_TIMELINE = "rslatte-stats-timeline";

export class TimelineView extends ItemView {
  private plugin: RSLattePlugin;
  private _renderSeq = 0;
  private selectedDateStart: string = "";
  private selectedDateEnd: string = "";
  private selectedSpaces: Set<string> = new Set();
  private selectedModules: Set<string> = new Set();
  private selectedActions: Set<WorkEventAction> = new Set();
  private selectedSources: Set<WorkEventSource> = new Set();
  // 折叠状态：true 表示折叠，false 表示展开
  private filtersCollapsed: boolean = true; // 整体筛选器折叠状态（默认收起）
  private dateSectionCollapsed: boolean = false;
  private spaceSectionCollapsed: boolean = false;
  private moduleSectionCollapsed: boolean = false;
  private actionSectionCollapsed: boolean = false;
  private sourceSectionCollapsed: boolean = false;
  
  constructor(leaf: WorkspaceLeaf, plugin: RSLattePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_TIMELINE;
  }

  getDisplayText(): string {
    return "事件时间轴";
  }

  getIcon(): string {
    return "clock";
  }

  async onOpen() {
    // 初始化时默认选择所有空间
    const spaces = (this.plugin as any).workEventReader?.getSpaces() || [];
    if (this.selectedSpaces.size === 0 && spaces.length > 0) {
      spaces.forEach((s: any) => this.selectedSpaces.add(s.id));
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
    // 初始化时默认选择所有操作类型（action）
    if (this.selectedActions.size === 0) {
      const allActions: WorkEventAction[] = ["create", "update", "status", "delete", "archive", "cancelled","done","start","recover","paused","continued"];
      allActions.forEach((a) => this.selectedActions.add(a));
    }
    // 初始化时默认选择所有事件来源（source），含「手机」以显示从手机同步的操作
    if (this.selectedSources.size === 0) {
      const allSources: WorkEventSource[] = ["ui", "auto", "reconcile", "mobile"];
      allSources.forEach((s) => this.selectedSources.add(s));
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
    container.addClass("rslatte-stats-timeline");

    const workEventReader = (this.plugin as any).workEventReader;
    if (!workEventReader) {
      container.createDiv({ cls: "rslatte-stats-empty", text: "统计功能未初始化" });
      return;
    }

    // ===== 分区一：标题 + 加号按钮 =====
    const headerSection = container.createDiv({ cls: "rslatte-section" });
    const headerRow = headerSection.createDiv({ cls: "rslatte-section-title-row" });
    headerRow.createEl("h3", { text: "📜 操作日志" });
    const headerActions = headerRow.createDiv({ cls: "rslatte-section-title-right" });
    
    // 刷新按钮（放在筛选选项标签的右侧）
    const refreshBtn = headerActions.createEl("button", { text: "🔄", cls: "rslatte-icon-btn" });
    refreshBtn.onclick = () => this.refresh();

    // 头部：筛选控件
    const header = container.createDiv({ cls: "rslatte-stats-timeline-header" });
    
    // 整体筛选器折叠标签和刷新按钮容器
    const filtersToggleRow = header.createDiv({ cls: "rslatte-stats-filters-toggle-row" });
    const filtersToggleLabel = filtersToggleRow.createDiv({ cls: "rslatte-stats-filters-toggle-label" });
    const filtersToggleIcon = filtersToggleLabel.createSpan({ 
      cls: "rslatte-stats-collapse-icon", 
      text: this.filtersCollapsed ? "▶" : "▼" 
    });
    filtersToggleLabel.createSpan({ text: "筛选选项", cls: "rslatte-stats-filters-toggle-text" });
    filtersToggleLabel.onclick = () => {
      this.filtersCollapsed = !this.filtersCollapsed;
      void this.render();
    };
    filtersToggleLabel.style.cursor = "pointer";
    
    // 刷新按钮（放在筛选选项标签的右侧）
    //const refreshBtn = filtersToggleRow.createEl("button", { text: "🔄", cls: "rslatte-icon-btn" });
    //refreshBtn.onclick = () => this.refresh();
    
    // 筛选器容器（包含所有筛选区域）
    const filtersContainer = header.createDiv({ cls: "rslatte-stats-filters-container" });
    if (this.filtersCollapsed) {
      filtersContainer.style.display = "none";
    }
    
    // 日期筛选区域
    const dateSection = filtersContainer.createDiv({ cls: "rslatte-stats-filter-section" });
    const dateLabel = dateSection.createDiv({ cls: "rslatte-stats-filter-label rslatte-stats-collapsible-label" });
    const dateToggle = dateLabel.createSpan({ cls: "rslatte-stats-collapse-icon", text: this.dateSectionCollapsed ? "▶" : "▼" });
    dateLabel.createSpan({ text: "日期范围" });
    dateLabel.onclick = () => {
      this.dateSectionCollapsed = !this.dateSectionCollapsed;
      void this.render();
    };
    dateLabel.style.cursor = "pointer";
    
    const dateInputs = dateSection.createDiv({ cls: "rslatte-stats-date-inputs" });
    if (this.dateSectionCollapsed) {
      dateInputs.style.display = "none";
    }
    const dateStartInput = dateInputs.createEl("input", { type: "date", cls: "rslatte-stats-date-input" });
    if (!this.selectedDateStart) {
      const date = new Date();
      date.setDate(date.getDate() - 7);
      this.selectedDateStart = date.toISOString().split("T")[0];
    }
    dateStartInput.value = this.selectedDateStart;
    dateStartInput.onchange = () => {
      this.selectedDateStart = dateStartInput.value;
      void this.render();
    };

    dateInputs.createSpan({ text: "至", cls: "rslatte-stats-date-separator" });

    const dateEndInput = dateInputs.createEl("input", { type: "date", cls: "rslatte-stats-date-input" });
    if (!this.selectedDateEnd) {
      this.selectedDateEnd = new Date().toISOString().split("T")[0];
    }
    dateEndInput.value = this.selectedDateEnd;
    dateEndInput.onchange = () => {
      this.selectedDateEnd = dateEndInput.value;
      void this.render();
    };

    // 空间筛选区域
    const spaceSection = filtersContainer.createDiv({ cls: "rslatte-stats-filter-section" });
    const spaceLabelRow = spaceSection.createDiv({ cls: "rslatte-stats-filter-label-row" });
    const spaceLabel = spaceLabelRow.createDiv({ cls: "rslatte-stats-filter-label rslatte-stats-collapsible-label" });
    const spaceToggle = spaceLabel.createSpan({ cls: "rslatte-stats-collapse-icon", text: this.spaceSectionCollapsed ? "▶" : "▼" });
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
    const moduleSection = filtersContainer.createDiv({ cls: "rslatte-stats-filter-section" });
    const moduleLabelRow = moduleSection.createDiv({ cls: "rslatte-stats-filter-label-row" });
    const moduleLabel = moduleLabelRow.createDiv({ cls: "rslatte-stats-filter-label rslatte-stats-collapsible-label" });
    const moduleToggle = moduleLabel.createSpan({ cls: "rslatte-stats-collapse-icon", text: this.moduleSectionCollapsed ? "▶" : "▼" });
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

    // 操作类型筛选区域
    const actionSection = filtersContainer.createDiv({ cls: "rslatte-stats-filter-section" });
    const actionLabelRow = actionSection.createDiv({ cls: "rslatte-stats-filter-label-row" });
    const actionLabel = actionLabelRow.createDiv({ cls: "rslatte-stats-filter-label rslatte-stats-collapsible-label" });
    const actionToggle = actionLabel.createSpan({ cls: "rslatte-stats-collapse-icon", text: this.actionSectionCollapsed ? "▶" : "▼" });
    actionLabel.createSpan({ text: "操作类型筛选" });
    actionLabel.onclick = () => {
      this.actionSectionCollapsed = !this.actionSectionCollapsed;
      void this.render();
    };
    actionLabel.style.cursor = "pointer";
    
    const actionLabels: Record<WorkEventAction, string> = {
      create: "创建",
      update: "更新",
      status: "状态变更",
      delete: "删除",
      archive: "归档",
      cancelled: "取消",
      done: "完成",
      start: "开始",
      recover: "恢复",
      paused: "暂停",
      continued: "继续",
    };
    
    const allActions: WorkEventAction[] = ["create", "update", "status", "delete", "archive", "cancelled", "done", "start","recover","paused","continued"];
    
    // 全选：[勾选项] 形式
    const actionActions = actionLabelRow.createDiv({ cls: "rslatte-stats-filter-actions" });
    const actionSelectAllLabel = actionActions.createEl("label", { cls: "rslatte-stats-checkbox-label" });
    actionSelectAllLabel.style.margin = "0";
    const actionSelectAllCheckbox = actionSelectAllLabel.createEl("input", { type: "checkbox" });
    const allActionsSelected = allActions.every((action) => this.selectedActions.has(action));
    actionSelectAllCheckbox.checked = allActionsSelected;
    actionSelectAllLabel.createSpan({ text: "全选" });
    actionSelectAllCheckbox.onchange = (e) => {
      e.stopPropagation();
      if (actionSelectAllCheckbox.checked) {
        allActions.forEach((action) => this.selectedActions.add(action));
      } else {
        this.selectedActions.clear();
      }
      void this.render();
    };
    
    const actionOptions = actionSection.createDiv({ cls: "rslatte-stats-checkbox-group" });
    if (this.actionSectionCollapsed) {
      actionOptions.style.display = "none";
    }
    
    allActions.forEach((action) => {
      const label = actionOptions.createEl("label", { cls: "rslatte-stats-checkbox-label" });
      const checkbox = label.createEl("input", { type: "checkbox" });
      checkbox.checked = this.selectedActions.has(action);
      checkbox.onchange = () => {
        if (checkbox.checked) {
          this.selectedActions.add(action);
        } else {
          this.selectedActions.delete(action);
        }
        void this.render();
      };
      label.createSpan({ text: actionLabels[action] || action });
    });

    // 事件来源筛选区域
    const sourceSection = filtersContainer.createDiv({ cls: "rslatte-stats-filter-section" });
    const sourceLabelRow = sourceSection.createDiv({ cls: "rslatte-stats-filter-label-row" });
    const sourceLabel = sourceLabelRow.createDiv({ cls: "rslatte-stats-filter-label rslatte-stats-collapsible-label" });
    const sourceToggle = sourceLabel.createSpan({ cls: "rslatte-stats-collapse-icon", text: this.sourceSectionCollapsed ? "▶" : "▼" });
    sourceLabel.createSpan({ text: "事件来源筛选" });
    sourceLabel.onclick = () => {
      this.sourceSectionCollapsed = !this.sourceSectionCollapsed;
      void this.render();
    };
    sourceLabel.style.cursor = "pointer";
    
    const sourceLabels: Record<WorkEventSource, string> = {
      ui: "用户操作",
      auto: "自动",
      reconcile: "数据同步",
      mobile: "手机",
    };
    
    const allSources: WorkEventSource[] = ["ui", "auto", "reconcile", "mobile"];
    
    // 全选：[勾选项] 形式
    const sourceActions = sourceLabelRow.createDiv({ cls: "rslatte-stats-filter-actions" });
    const sourceSelectAllLabel = sourceActions.createEl("label", { cls: "rslatte-stats-checkbox-label" });
    sourceSelectAllLabel.style.margin = "0";
    const sourceSelectAllCheckbox = sourceSelectAllLabel.createEl("input", { type: "checkbox" });
    const allSourcesSelected = allSources.every((source) => this.selectedSources.has(source));
    sourceSelectAllCheckbox.checked = allSourcesSelected;
    sourceSelectAllLabel.createSpan({ text: "全选" });
    sourceSelectAllCheckbox.onchange = (e) => {
      e.stopPropagation();
      if (sourceSelectAllCheckbox.checked) {
        allSources.forEach((source) => this.selectedSources.add(source));
      } else {
        this.selectedSources.clear();
      }
      void this.render();
    };
    
    const sourceOptions = sourceSection.createDiv({ cls: "rslatte-stats-checkbox-group" });
    if (this.sourceSectionCollapsed) {
      sourceOptions.style.display = "none";
    }
    
    allSources.forEach((source) => {
      const label = sourceOptions.createEl("label", { cls: "rslatte-stats-checkbox-label" });
      const checkbox = label.createEl("input", { type: "checkbox" });
      checkbox.checked = this.selectedSources.has(source);
      checkbox.onchange = () => {
        if (checkbox.checked) {
          this.selectedSources.add(source);
        } else {
          this.selectedSources.delete(source);
        }
        void this.render();
      };
      label.createSpan({ text: sourceLabels[source] || source });
    });


    if (seq !== this._renderSeq) return;

    // 时间轴容器
    const timelineContainer = container.createDiv({ cls: "rslatte-stats-timeline-container" });

    // 检查是否有空间配置（重用上面已声明的 spaces 变量）
    if (spaces.length === 0) {
      timelineContainer.empty();
      timelineContainer.createDiv({
        cls: "rslatte-stats-empty",
        text: "未配置任何空间，请在插件设置中添加空间配置",
      });
      return;
    }

    // 加载数据
    // 使用 UTC 时间确保日期比较准确
    let startDate: Date;
    if (this.selectedDateStart) {
      // 将日期字符串转换为 UTC 时间的开始（00:00:00）
      startDate = new Date(this.selectedDateStart + "T00:00:00.000Z");
    } else {
      const date = new Date();
      date.setDate(date.getDate() - 7);
      date.setHours(0, 0, 0, 0);
      startDate = date;
    }
    
    let endDate: Date;
    if (this.selectedDateEnd) {
      // 将日期字符串转换为 UTC 时间的结束（23:59:59.999）
      endDate = new Date(this.selectedDateEnd + "T23:59:59.999Z");
    } else {
      const date = new Date();
      date.setHours(23, 59, 59, 999);
      endDate = date;
    }
    
    const selectedSpaceIds = Array.from(this.selectedSpaces);

    if (selectedSpaceIds.length === 0) {
      timelineContainer.empty();
      timelineContainer.createDiv({ cls: "rslatte-stats-empty", text: "请至少选择一个空间" });
      return;
    }

    if (this.selectedModules.size === 0) {
      timelineContainer.empty();
      timelineContainer.createDiv({ cls: "rslatte-stats-empty", text: "请至少选择一个模块" });
      return;
    }

    if (this.selectedActions.size === 0) {
      timelineContainer.empty();
      timelineContainer.createDiv({ cls: "rslatte-stats-empty", text: "请至少选择一个操作类型" });
      return;
    }

    if (this.selectedSources.size === 0) {
      timelineContainer.empty();
      timelineContainer.createDiv({ cls: "rslatte-stats-empty", text: "请至少选择一个事件来源" });
      return;
    }

    timelineContainer.createDiv({ cls: "rslatte-stats-loading", text: "加载中..." });

    try {
      const events = await workEventReader.readEventsByDateRange(
        selectedSpaceIds,
        startDate,
        endDate
      );

      if (seq !== this._renderSeq) return;

      timelineContainer.empty();

      // 应用所有筛选条件
      const selectedModuleArray = Array.from(this.selectedModules);
      const selectedActionArray = Array.from(this.selectedActions);
      const selectedSourceArray = Array.from(this.selectedSources);
      
      const filteredEvents = events.filter((event: WorkEvent) => {
        // 模块筛选
        if (!selectedModuleArray.includes(event.kind)) {
          return false;
        }
        
        // 操作类型筛选
        if (!selectedActionArray.includes(event.action)) {
          return false;
        }
        
        // 事件来源筛选（如果没有 source 字段，默认为 "ui"）
        const eventSource: WorkEventSource = event.source || "ui";
        if (!selectedSourceArray.includes(eventSource)) {
          return false;
        }
        
        return true;
      });

      if (filteredEvents.length === 0) {
        timelineContainer.createDiv({ cls: "rslatte-stats-empty", text: "该时间段内没有符合筛选条件的事件" });
        return;
      }

      // 按日期分组事件
      const eventsByDate = this.groupEventsByDate(filteredEvents);

      // 获取空间列表，用于获取空间名称和背景色
      const spacesList = workEventReader.getSpaces();
      type SpaceInfo = { id: string; name: string; backgroundColor?: string };
      const spaceMap = new Map<string, SpaceInfo>(
        spacesList.map((s: SpaceInfo) => [s.id, { id: s.id, name: s.name, backgroundColor: s.backgroundColor }])
      );

      // 使用主插件的时间轴样式
      const timeline = timelineContainer.createDiv({ cls: "rslatte-timeline" });

      // 渲染时间轴（按日期分组，降序）
      const sortedDates = Object.entries(eventsByDate).sort((a, b) => b[0].localeCompare(a[0]));
      for (const [date, dateEvents] of sortedDates) {
        const daySection = timeline.createDiv({ cls: "rslatte-timeline-day" });
        const dayTitle = daySection.createDiv({ cls: "rslatte-timeline-day-title" });
        
        // 格式化日期显示
        const dateObj = new Date(date);
        const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
        const weekday = weekdays[dateObj.getDay()];
        dayTitle.textContent = `${date} (${weekday})`;
        
        const dayItems = daySection.createDiv({ cls: "rslatte-timeline-day-items" });
        
        // 按时间排序事件（降序：最新的在前）
        const sortedEvents = dateEvents.sort((a, b) => b.ts.localeCompare(a.ts));
        
        // 渲染每个事件（都在右侧）
        sortedEvents.forEach((event: WorkEvent) => {
          this.renderTimelineItem(dayItems, event, spaceMap);
        });
      }
    } catch (e) {
      if (seq !== this._renderSeq) return;
      timelineContainer.empty();
      timelineContainer.createDiv({ cls: "rslatte-stats-error", text: `加载失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }

  /** 按日期分组事件 */
  private groupEventsByDate(events: WorkEvent[]): Record<string, WorkEvent[]> {
    const grouped: Record<string, WorkEvent[]> = {};
    for (const event of events) {
      const date = event.ts.slice(0, 10); // YYYY-MM-DD
      if (!grouped[date]) {
        grouped[date] = [];
      }
      grouped[date].push(event);
    }
    return grouped;
  }

  /** 渲染时间轴项目（使用主插件样式） */
  private renderTimelineItem(parent: HTMLElement, event: WorkEvent, spaceMap: Map<string, { id: string; name: string; backgroundColor?: string }>) {
    const row = parent.createDiv({ cls: "rslatte-timeline-item rslatte-stats-timeline-item" });
    row.tabIndex = 0;
    row.dataset.kind = event.kind; // 用于CSS选择器
    
    // 获取空间信息
    const space = spaceMap.get(event.spaceId || "");
    const spaceName = space?.name || event.spaceId || "";
    const spaceBgColor = space?.backgroundColor || "#ffffff";
    
    row.dataset.spaceId = event.spaceId || "";

    // 添加点击事件：跳转到对应模块侧边栏
    row.style.cursor = "pointer";
    row.onclick = async () => {
      await this.navigateToModuleSidebar(event.kind);
    };

    // 左侧时间轴轨道
    const gutter = row.createDiv({ cls: "rslatte-timeline-gutter" });
    
    // 交汇点的加粗实心点（在纵向线上，使用空间颜色）
    const dot = gutter.createDiv({ cls: "rslatte-timeline-dot rslatte-stats-timeline-dot" });
    
    // 在圆点中添加模块图标
    const moduleIcon = this.getModuleIcon(event);
    dot.setText(moduleIcon);
    
    // 获取模块颜色（用于横线）
    const moduleColor = getModuleColor(event.kind, this.plugin.settings);
    
    // 连续的时间轴纵向线（隐藏，使用容器级别的线）
    gutter.createDiv({ cls: "rslatte-timeline-line rslatte-stats-timeline-line" });

    // 右侧内容
    const content = row.createDiv({ cls: "rslatte-timeline-content" });
    content.style.backgroundColor = this.hexToRgba(spaceBgColor, 0.5);
    content.style.borderColor = spaceBgColor;

    // 标题行
    const titleRow = content.createDiv({ cls: "rslatte-timeline-title-row rslatte-task-row" });
    
    // 事件标题容器（不再包含空间标签）
    const title = titleRow.createDiv({ cls: "rslatte-timeline-text rslatte-task-title" });
    title.style.fontWeight="300";
    title.style.fontSize="12px";
    // 提取并显示内容
    const displayText = this.extractDisplayText(event);
    title.appendText(displayText);

    // 元信息（时间、类型、空间、事件来源）
    const meta = content.createDiv({ cls: "rslatte-timeline-meta" });
    const eventDate = new Date(event.ts);
    const timeStr = eventDate.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    const kindLabel = this.getKindLabel(event.kind);
    const actionLabel = this.getActionLabel(event.action);
    const sourceLabel = this.getSourceLabel(event.source || "ui");
    meta.textContent = `${timeStr} · ${kindLabel} · ${actionLabel} · ${spaceName} · ${sourceLabel}`;
  }

  /** 获取事件来源的展示文案（与筛选区「事件来源」一致） */
  private getSourceLabel(source: WorkEventSource): string {
    const labels: Record<WorkEventSource, string> = {
      ui: "用户操作",
      auto: "自动",
      reconcile: "数据同步",
      mobile: "手机",
    };
    return labels[source] ?? source;
  }

  /** 根据事件类型跳转到对应的模块侧边栏 */
  private async navigateToModuleSidebar(kind: WorkEventKind): Promise<void> {
    try {
      switch (kind) {
        case "checkin":
          await this.plugin.activateCheckinView();
          break;
        case "finance":
          await this.plugin.activateFinanceView();
          break;
        case "task":
          await this.plugin.activateTaskView();
          break;
        case "projecttask":
        case "project":
        case "milestone":
          await this.plugin.activateProjectView();
          break;
        case "output":
          await this.plugin.activateOutputView();
          break;
        case "contact":
          await this.plugin.activateContactsView();
          break;
        case "memo":
          // memo 可能显示在任务视图中，或者使用 RSLatte 视图
          await this.plugin.activateTaskView();
          break;
        default:
          // 其他类型（file, sync等）不跳转或跳转到 Hub
          await this.plugin.activateHubView();
          break;
      }
    } catch (e) {
      console.warn("[RSLatte][TimelineView] navigateToModuleSidebar failed", e);
    }
  }

  /** 将十六进制颜色转换为rgba格式 */
  private hexToRgba(hex: string, alpha: number): string {
    // 移除 # 号
    hex = hex.replace("#", "");
    
    // 如果是3位颜色，扩展为6位
    if (hex.length === 3) {
      hex = hex.split("").map(char => char + char).join("");
    }
    
    // 转换为RGB
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  /** 从事件中提取显示文本 */
  private extractDisplayText(event: WorkEvent): string {
    // 优先使用 summary
    if (event.summary) {
      return event.summary;
    }

    // 从 ref 中提取有意义的内容
    if (event.ref) {
      const ref = event.ref;
      
      // 根据不同的 kind 和 action 提取不同的字段
      switch (event.kind) {
        case "checkin":
          const checkinName = ref.checkin_name || ref.checkin_id;
          return checkinName ? `打卡 ${checkinName}` : "打卡";
        case "task":
          const taskText = ref.text || ref.task_title;
          if (taskText) {
            // 如果action是状态变更，添加状态信息
            if (event.action === "status" && ref.to) {
              return `${taskText} (${ref.to})`;
            }
            return taskText;
          }
          return ref.task_id || "任务";
        case "projecttask":
          const projectTaskText = ref.text || ref.task_title;
          if (projectTaskText) {
            // 如果action是状态变更，添加状态信息
            if (event.action === "status" && ref.to) {
              return `${projectTaskText} (${ref.to})`;
            }
            return projectTaskText;
          }
          return ref.task_id || "项目任务";
        case "memo":
          return ref.text || ref.memo_id || "备忘";
        case "finance":
          const amount = ref.amount;
          const category = ref.category_name || ref.category_id;
          if (amount && category) {
            return `${category} ${amount}`;
          }
          return category || amount || "财务记录";
        case "project":
          return ref.project_name || ref.project_id || "项目";
        case "milestone":
          return ref.milestone_name || ref.milestone_id || "里程碑";
        case "output":
          return ref.output_name || ref.output_id || "输出";
        case "contact":
          return ref.display_name || ref.contact_uid || "联系人";
        case "file":
          // 只显示文件名，不显示完整路径
          const filePath = ref.file_path || ref.file_name;
          if (filePath) {
            const fileName = filePath.split("/").pop() || filePath.split("\\").pop() || filePath;
            return fileName;
          }
          return "文件";
        default:
          // 尝试提取常见的文本字段
          return ref.text || ref.name || ref.title || this.getKindLabel(event.kind);
      }
    }

    // 默认返回类型
    return this.getKindLabel(event.kind);
  }

  /** 获取模块标签 */
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

  private getKindLabel(kind: WorkEvent["kind"]): string {
    // 获取用户自定义的模块名称
    const statsSettings = (this.plugin.settings as any)?.statsSettings;
    const moduleNames = statsSettings?.moduleNames || {};
    
    const defaultLabels: Record<WorkEvent["kind"], string> = {
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

  /** 获取操作类型标签 */
  private getActionLabel(action: WorkEventAction): string {
    const actionLabels: Record<WorkEventAction, string> = {
      create: "创建",
      update: "更新",
      status: "状态变更",
      delete: "删除",
      archive: "归档",
      cancelled: "取消",
      done: "完成",
      start: "开始",
      recover: "恢复",
      paused: "暂停",
      continued: "继续",
    };
    
    return actionLabels[action] || action;
  }

  /** 获取模块图标（根据action和kind） */
  private getModuleIcon(event: WorkEvent): string {
    // 根据action确定图标
    if (event.action === "delete" || event.action === "archive") {
      return "⛔";
    }
    
    // 根据kind和action确定图标
    switch (event.kind) {
      case "checkin":
        return "✅";
      case "task":
      case "projecttask":
        if (event.action === "status") {
          const ref = event.ref || {};
          const to = ref.to || "";
          if (to === "DONE") return "✅";
          if (to === "CANCELLED") return "⛔";
          if (to === "IN_PROGRESS") return "▶";
          return "⏸";
        }
        return "▶";
      case "memo":
        return "📝";
      case "finance":
        return "💰";
      case "project":
        return "📁";
      case "milestone":
        return "🎯";
      case "output":
        return "📄";
      case "contact":
        return "👤";
      case "file":
        return "📎";
      case "sync":
        return "🔄";
      default:
        return "•";
    }
  }
}
