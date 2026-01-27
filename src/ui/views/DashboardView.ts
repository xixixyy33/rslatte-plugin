import { ItemView, WorkspaceLeaf, moment, normalizePath } from "obsidian";
import type RSLattePlugin from "../../main";
import { VIEW_TYPE_DASHBOARD } from "../../constants/viewTypes";
import { resolveSpaceIndexDir } from "../../services/spaceContext";
import type { RSLatteIndexFile, RSLatteIndexItem } from "../../taskRSLatte/types";
import { CheckinModal } from "../modals/CheckinModal";
import { FinanceRecordModal } from "../modals/FinanceRecordModal";

const momentFn = moment as any;

/**
 * RSLatte 工作台视图
 * 在侧边栏中展示各个模块的汇总信息
 */
export class DashboardView extends ItemView {
  private plugin: RSLattePlugin;
  private _renderSeq = 0;

  constructor(leaf: WorkspaceLeaf, plugin: RSLattePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_DASHBOARD; }
  getDisplayText(): string { return "RSLatte 工作台"; }
  getIcon(): string { return "layout-dashboard"; }

  async onOpen() {
    void this.render();
  }

  async onClose() {
    // nothing
  }

  /**
   * 刷新工作台数据
   */
  public refresh() {
    void this.render();
  }

  private async render() {
    ++this._renderSeq;
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();

    // 添加样式
    container.addClass("rslatte-dashboard-container");
    this.addStyles();

    const wrapper = container.createDiv({ cls: "rslatte-dashboard" });
    
    // 外层大容器（统一底色）
    const outerContainer = wrapper.createDiv({ cls: "rslatte-dashboard-outer-container" });
    
    // 四个大区块的2x2主网格布局（占满整个窗口）
    const mainGrid = outerContainer.createDiv({ cls: "rslatte-dashboard-main-grid" });
    
    // 【区块一】一行一列（左上）：包含4个子分区（2x2网格）
    const block1 = mainGrid.createDiv({ cls: "rslatte-dashboard-block rslatte-dashboard-block-1" });
    const block1Grid = block1.createDiv({ cls: "rslatte-dashboard-block-grid-2x2" });
    await this.renderCalendar(block1Grid);
    await this.renderTasks(block1Grid);
    await this.renderReminders(block1Grid);
    await this.renderOutputs(block1Grid);

    // 【区块二】一行二列（右上）：今日日志，日志子窗口分两列展示
    const block2 = mainGrid.createDiv({ cls: "rslatte-dashboard-block rslatte-dashboard-block-2" });
    await this.renderJournal(block2);

    // 【区块三】二行一列（左下）：左右两个子分区
    const block3 = mainGrid.createDiv({ cls: "rslatte-dashboard-block rslatte-dashboard-block-3" });
    const block3Grid = block3.createDiv({ cls: "rslatte-dashboard-block-grid-2col" });
    await this.renderCheckins(block3Grid);
    await this.renderFinance(block3Grid);

    // 【区块四】二行二列（右下）：左右两个子分区
    const block4 = mainGrid.createDiv({ cls: "rslatte-dashboard-block rslatte-dashboard-block-4" });
    const block4Grid = block4.createDiv({ cls: "rslatte-dashboard-block-grid-2col" });
    await this.renderProjects(block4Grid);
    await this.renderWorkEvents(block4Grid);
  }

  /**
   * 添加工作台样式
   */
  private addStyles() {
    const styleId = "rslatte-dashboard-styles";
    if (document.getElementById(styleId)) return;

    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      .rslatte-dashboard-container {
        padding: 0;
        overflow: hidden;
        height: 100%;
        background: var(--background-secondary);
      }

      .rslatte-dashboard {
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
      }

      .rslatte-dashboard-outer-container {
        width: 100%;
        height: 100%;
        background: var(--background-secondary);
        padding: 10px;
        box-sizing: border-box;
      }

      .rslatte-dashboard-main-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        grid-template-rows: 1fr 1fr;
        gap: 10px;
        height: 100%;
      }

      .rslatte-dashboard-block {
        display: flex;
        flex-direction: column;
        gap: 10px;
        height: 100%;
        overflow: hidden;
      }

      /* 区块一：2x2子网格 */
      .rslatte-dashboard-block-grid-2x2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        grid-template-rows: auto 1fr;
        gap: 10px;
        height: 100%;
        overflow: hidden;
      }

      /* 区块一的上方两个区块（日历和任务）固定高度 */
      .rslatte-dashboard-block-grid-2x2 > .rslatte-dashboard-section:nth-child(1),
      .rslatte-dashboard-block-grid-2x2 > .rslatte-dashboard-section:nth-child(2) {
        height: 160px;
        min-height: 160px;
        max-height: 160px;
      }

      /* 区块三和四：左右两列 */
      .rslatte-dashboard-block-grid-2col {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
        height: 100%;
        overflow: hidden;
      }

      .rslatte-dashboard-section {
        background: var(--background-secondary);
        border: 1px solid var(--background-modifier-border);
        border-radius: 6px;
        padding: 12px;
        height: 100%;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        position: relative;
      }

      .rslatte-dashboard-calendar-section {
        border: none;
        background: transparent;
        padding: 8px;
      }

      .rslatte-dashboard-section-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
        padding-bottom: 8px;
        border-bottom: 1px solid var(--background-modifier-border);
        position: relative;
      }


      .rslatte-dashboard-reminder-count {
        position: absolute;
        top: 0;
        right: 0;
        font-size: 0.85em;
        color: var(--text-muted);
        font-weight: 500;
      }

      .rslatte-dashboard-section-icon {
        font-size: 1.2em;
      }

      .rslatte-dashboard-section-header h2 {
        margin: 0;
        font-size: 1.1em;
        font-weight: 600;
      }

      .rslatte-dashboard-section-content {
        font-size: 0.9em;
        line-height: 1.6;
        flex: 1;
        overflow-y: auto;
        overflow-x: hidden;
        display: flex;
        flex-direction: column;
      }

      .rslatte-dashboard-section-content p {
        margin: 4px 0;
      }

      /* 操作日志区域特殊处理 */
      .rslatte-dashboard-section-content:has(.rslatte-dashboard-work-event-item) {
        font-size: 0.8em;
        line-height: 1.3;
      }

      .rslatte-dashboard-overview {
        margin-bottom: 15px;
      }

      .rslatte-dashboard-overview h3 {
        margin: 0 0 8px 0;
        font-size: 1em;
        font-weight: 600;
      }

      .rslatte-dashboard-tasks h3,
      .rslatte-dashboard-outputs h3,
      .rslatte-dashboard-finance-stats h3,
      .rslatte-dashboard-finance-categories h3 {
        margin: 0 0 8px 0;
        font-size: 1em;
        font-weight: 600;
      }

      .rslatte-dashboard-task-item,
      .rslatte-dashboard-output-item {
        margin: 4px 0;
      }

      .rslatte-dashboard-task-item a,
      .rslatte-dashboard-output-item a,
      .rslatte-dashboard-project-item a {
        color: var(--link-color);
        text-decoration: none;
        cursor: pointer;
      }

      .rslatte-dashboard-task-item a:hover,
      .rslatte-dashboard-output-item a:hover,
      .rslatte-dashboard-project-item a:hover {
        text-decoration: underline;
      }

      .rslatte-dashboard-project-item {
        margin: 8px 0;
        padding: 10px;
        background: var(--background-secondary);
        border-radius: 6px;
        border: 1px solid var(--background-modifier-border);
      }

      .rslatte-dashboard-project-meta {
        margin: 4px 0;
        font-size: 0.85em;
        color: var(--text-muted);
      }

      .rslatte-dashboard-project-name {
        font-size: 0.9em;
        font-weight: bold;
        color: var(--text-normal);
        flex: 1;
      }

      .rslatte-dashboard-project-dates {
        font-size: 0.85em;
        color: var(--text-muted);
        margin: 4px 0 8px 0;
      }

      .rslatte-dashboard-project-bar-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 6px 0;
      }

      .rslatte-dashboard-project-bar-label {
        font-size: 0.9em;
        color: var(--text-normal);
        min-width: 50px;
      }

      .rslatte-dashboard-project-bar-container {
        flex: 1;
        height: 20px;
        display: flex;
        border-radius: 4px;
        overflow: hidden;
        border: 1px solid var(--color-green);
        background: var(--background-modifier-border);
      }

      .rslatte-dashboard-project-bar-segment {
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
      }

      .rslatte-dashboard-project-bar-segment.rslatte-dashboard-project-bar-green {
        background: var(--color-green);
      }

      .rslatte-dashboard-project-bar-segment.rslatte-dashboard-project-bar-orange {
        background: var(--color-orange);
      }

      .rslatte-dashboard-project-bar-segment.rslatte-dashboard-project-bar-gray {
        background: var(--background-modifier-border);
        border-right: 1px solid var(--color-green);
      }

      .rslatte-dashboard-project-bar-number {
        position: absolute;
        font-size: 0.85em;
        color: white;
        font-weight: bold;
        white-space: nowrap;
        z-index: 1;
      }

      .rslatte-dashboard-journal-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
        width: 100%;
        height: 100%;
        overflow: hidden;
        min-width: 0;
      }

      .rslatte-dashboard-journal-col {
        display: flex;
        flex-direction: column;
        gap: 10px;
        width: 100%;
        height: 100%;
        min-width: 0;
        min-height: 0;
      }

      .rslatte-dashboard-journal-panel {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-width: 0;
        min-height: 0;
        border: 1px solid var(--background-modifier-border);
        border-radius: 4px;
        background: var(--background-secondary);
        overflow: hidden;
      }

      .rslatte-dashboard-journal-panel-header {
        padding: 8px 10px;
        border-bottom: 1px solid var(--background-modifier-border);
        flex-shrink: 0;
        min-width: 0;
      }

      .rslatte-dashboard-journal-panel-header h3 {
        margin: 0;
        font-size: 1em;
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .rslatte-dashboard-journal-panel-content {
        flex: 1;
        padding: 8px;
        overflow: auto;
        white-space: pre;
        font-family: var(--font-monospace);
        font-size: 0.9em;
        line-height: 1.5;
        min-width: 0;
        min-height: 0;
      }

      .rslatte-dashboard-status-dot {
        font-size: 0.8em;
        margin-left: 4px;
      }

      .rslatte-dashboard-task-header {
        cursor: pointer;
        user-select: none;
        transition: background-color 0.2s;
      }

      .rslatte-dashboard-task-header:hover {
        background-color: var(--background-modifier-hover);
      }

      .rslatte-dashboard-task-title {
        user-select: none;
      }

      .rslatte-dashboard-task-stats {
        display: flex;
        flex-direction: column;
        gap: 4px;
        justify-content: center;
        height: 100%;
        overflow-x: auto;
        overflow-y: hidden;
      }

      .rslatte-dashboard-task-stat-line {
        font-size: 0.9em;
        line-height: 1.5;
        white-space: nowrap;
      }

      .rslatte-dashboard-calendar-refresh-btn {
        position: absolute;
        top: 8px;
        right: 8px;
        padding: 4px 8px;
        border: none;
        background: var(--background-secondary);
        border-radius: 4px;
        cursor: pointer;
        font-size: 1em;
        z-index: 10;
        opacity: 0.7;
        transition: opacity 0.2s;
      }

      .rslatte-dashboard-calendar-refresh-btn:hover {
        opacity: 1;
        background: var(--background-modifier-hover);
      }

      .rslatte-dashboard-calendar-space-box {
        position: absolute;
        top: 8px;
        left: 8px;
        padding: 4px 8px;
        border: 1px solid var(--background-modifier-border);
        border-radius: 4px;
        background: var(--background-primary);
        z-index: 10;
      }

      .rslatte-dashboard-calendar-space-text {
        font-size: 0.85em;
        color: var(--text-muted);
      }

      .rslatte-dashboard-calendar-date-box {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        padding: 8px 12px;
        border-radius: 4px;
        background: var(--background-secondary);
        gap: 4px;
      }

      .rslatte-dashboard-calendar-date-text {
        font-size: 1.2em;
        font-weight: 600;
        color: var(--text-normal);
      }

      .rslatte-dashboard-calendar-weekday-text {
        font-size: 0.9em;
        color: var(--text-muted);
      }

      .rslatte-dashboard-calendar-contacts-box {
        position: absolute;
        bottom: 8px;
        left: 8px;
        right: 8px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 6px 10px;
        border: 1px solid var(--background-modifier-border);
        border-radius: 6px;
        transition: background 0.2s ease;
      }

      .rslatte-dashboard-calendar-contacts-box:hover {
        background: var(--background-modifier-hover);
      }

      .rslatte-dashboard-calendar-contacts-title {
        font-size: 0.9em;
        color: var(--text-normal);
        font-weight: 500;
      }

      .rslatte-dashboard-calendar-contacts-count {
        font-size: 0.9em;
        color: var(--text-muted);
        font-weight: 600;
      }

      /* 发布管理区块样式（显示在输出区块下方） */
      .rslatte-dashboard-publish-box {
        margin-top: 12px;
        display: flex;
        bottom: 8px;
        left: 8px;
        right: 8px;
        position: absolute;
        justify-content: space-between;
        align-items: center;
        padding: 6px 10px;
        border: 1px solid var(--background-modifier-border);
        border-radius: 6px;
        transition: background 0.2s ease;
      }

      .rslatte-dashboard-publish-box:hover {
        background: var(--background-modifier-hover);
      }

      .rslatte-dashboard-publish-title {
        font-size: 0.9em;
        color: var(--text-normal);
        font-weight: 500;
      }

      .rslatte-dashboard-publish-count {
        font-size: 0.9em;
        color: var(--text-muted);
        font-weight: 600;
      }

      .rslatte-dashboard-reminder-list {
        display: flex;
        flex-direction: column;
      }

      .rslatte-dashboard-reminder-item {
        display: flex;
        gap: 8px;
        padding: 8px;
        border-radius: 4px;
        transition: background-color 0.2s;
      }



      .rslatte-dashboard-reminder-gutter {
        display: flex;
        flex-direction: column;
        align-items: center;
        flex-shrink: 0;
        width: 20px;
      }

      .rslatte-dashboard-reminder-dot {
        font-size: 1em;
        line-height: 1;
      }

      .rslatte-dashboard-reminder-line {
        flex: 1;
        width: 2px;
        background: var(--background-modifier-border);
        margin-top: 4px;
      }

      .rslatte-dashboard-reminder-content {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .rslatte-dashboard-reminder-text {
        font-weight: 500;
        font-size: 0.9em;
        color: var(--text-normal);
      }

      .rslatte-dashboard-reminder-meta {
        font-size: 0.80em;
        color: var(--text-muted);
      }

      .rslatte-dashboard-reminder-from {
        font-size: 0.8em;
        color: var(--text-muted);
      }

      .rslatte-dashboard-reminder-empty {
        text-align: center;
        color: var(--text-muted);
        font-style: italic;
        padding: 20px;
      }

      .rslatte-dashboard-checkin-item {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 6px 0;
      }

      .rslatte-dashboard-checkin-name {
        flex: 1;
      }

      .rslatte-dashboard-checkin-progress {
        display: flex;
        gap: 2px;
        margin-left: auto;
      }

      .rslatte-dashboard-checkin-block {
        width: 8px;
        height: 8px;
        background: var(--background-modifier-border);
        border-radius: 2px;
      }

      .rslatte-dashboard-checkin-block-filled {
        background: var(--text-success);
      }

      .rslatte-dashboard-journal-panel-header {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .rslatte-dashboard-journal-panel-content {
        min-height: 40px;
        padding: 8px;
        border-radius: 4px;
        border: 1px solid var(--background-modifier-border);
        white-space: pre;
        overflow: auto;
      }

      .rslatte-dashboard-empty {
        color: var(--text-muted);
        font-style: italic;
      }

      /* 操作日志条目样式：单行显示 */
      .rslatte-dashboard-work-event-item {
        margin: 3px 0;
        padding: 2px 0;
        white-space: nowrap;
        line-height: 1.5;
        font-size: 0.85em;
        min-height: 1.5em;
      }

      /* 操作日志容器：整个分区支持横向滚动 */
      .rslatte-dashboard-section-content:has(.rslatte-dashboard-work-event-item) {
        overflow-x: auto;
        overflow-y: auto;
      }

      .rslatte-dashboard-output-tabs {
        display: flex;
        gap: 4px;
        margin-bottom: 10px;
        flex-wrap: wrap;
      }

      .rslatte-dashboard-output-tab {
        padding: 4px 8px;
        border: 1px solid var(--background-modifier-border);
        background: var(--background-primary);
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.85em;
      }

      .rslatte-dashboard-output-tab:hover {
        background: var(--background-modifier-hover);
      }

      .rslatte-dashboard-output-stats {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 8px 0;
      }

      .rslatte-dashboard-output-stat-line {
        font-size: 0.9em;
        color: var(--text-normal);
        line-height: 1.5;
      }

      .rslatte-dashboard-output-overdue {
        color: var(--text-error);
        font-weight: 500;
      }

      /* 财务模块样式 */
      /* 财务列表：两个大分区布局 */
      .rslatte-dashboard-finance-list {
        display: grid;
        grid-template-columns: auto 1fr; /* 左分区自适应，右分区占据剩余空间 */
        gap: 8px;
        width: 100%;
        align-items: start;
      }

      /* 左分区：所有按钮垂直排列 */
      .rslatte-dashboard-finance-left-column {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      /* 右分区：所有色条/收入标记垂直排列 */
      .rslatte-dashboard-finance-right-column {
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: 0;
      }

      /* 按钮行：确保高度与色条行一致 */
      .rslatte-dashboard-finance-btn-row {
        display: flex;
        align-items: center;
        height: 16px; /* 与色条高度一致 */
      }

      .rslatte-dashboard-finance-btn-row .rslatte-btn {
        height: 16px;
        line-height: 16px;
        padding: 0 8px;
        font-size: 0.85em;
      }

      /* 右侧行：确保高度与按钮行一致 */
      .rslatte-dashboard-finance-right-row {
        display: flex;
        align-items: center;
        height: 16px; /* 与按钮高度一致 */
        min-width: 0;
      }

      .rslatte-dashboard-finance-bar-container {
        width: 100%;
        height: 16px;
        background: var(--background-modifier-border);
        border-radius: 3px;
        overflow: hidden; /* 隐藏溢出，但bar内部可以显示金额 */
        position: relative;
        min-width: 0;
      }

      .rslatte-dashboard-finance-bar {
        height: 100%;
        background: var(--color-green);
        transition: width 0.3s ease;
        border-radius: 3px;
        position: relative;
        overflow: visible;
      }

      .rslatte-dashboard-finance-bar-amount {
        position: absolute;
        right: 4px;
        top: 50%;
        transform: translateY(-50%);
        font-size: 0.85em;
        color: white;
        font-weight: bold;
        white-space: nowrap;
        z-index: 1;
      }

      .rslatte-dashboard-finance-income-label {
        font-size: 0.85em;
        color: var(--text-muted);
        font-style: italic;
      }

      /* 打卡模块样式（复用侧边栏样式类） */
      .rslatte-dashboard-section-content .rslatte-record-list,
      .rslatte-dashboard-section-content .rslatte-checklist-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .rslatte-dashboard-section-content .rslatte-record-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      /* 打卡按钮样式：与财务按钮高度一致 */
      .rslatte-dashboard-section-content .rslatte-record-row .rslatte-btn,
      .rslatte-dashboard-section-content .rslatte-record-row .rslatte-link {
        height: 16px;
        line-height: 16px;
        padding: 0 8px;
        font-size: 0.85em;
      }

      .rslatte-dashboard-section-content .rslatte-checklist-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        cursor: pointer;
        padding: 4px 0;
      }

      .rslatte-dashboard-section-content .rslatte-checklist-left {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: 1;
      }

      .rslatte-dashboard-section-content .rslatte-checklist-right {
        display: flex;
        align-items: center;
      }

      .rslatte-dashboard-section-content .rslatte-heatmap {
        display: flex;
        gap: 2px;
        flex: 0 0 auto;
        width: auto; /* 7天热力图，自动宽度 */
      }

      .rslatte-dashboard-section-content .rslatte-heat-cell {
        width: 10px;
        height: 10px;
        border-radius: 2px;
        display: inline-block;
      }

      .rslatte-dashboard-finance-category-item {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 6px 0;
      }

      .rslatte-dashboard-finance-category-btn {
        padding: 4px 8px;
        border: 1px solid var(--background-modifier-border);
        background: var(--background-primary);
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.9em;
        white-space: nowrap;
      }

      .rslatte-dashboard-finance-category-btn:hover {
        background: var(--background-modifier-hover);
      }

      .rslatte-dashboard-project-title-row {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 6px;
      }

      .rslatte-dashboard-project-status {
        font-size: 0.9em;
      }

      .rslatte-dashboard-project-stats-row {
        display: flex;
        gap: 8px;
        margin: 6px 0;
      }

      .rslatte-dashboard-project-badge {
        padding: 2px 6px;
        background: var(--background-modifier-border);
        border-radius: 12px;
        font-size: 0.85em;
        color: var(--text-normal);
      }

      /* 响应式布局 */
      @media (max-width: 1200px) {
        .rslatte-dashboard-main-grid {
          grid-template-columns: 1fr;
          grid-template-rows: auto;
        }

        .rslatte-dashboard-block-grid-2x2 {
          grid-template-columns: 1fr;
          grid-template-rows: auto;
        }

        .rslatte-dashboard-block-grid-2col {
          grid-template-columns: 1fr;
        }

        .rslatte-dashboard-journal-grid {
          grid-template-columns: 1fr;
        }
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * 渲染日历模块（简化版：左上角显示空间名称，左侧显示当前日期框，右上角刷新按钮）
   */
  private async renderCalendar(parent: HTMLElement) {
    const section = parent.createDiv({ cls: "rslatte-dashboard-section rslatte-dashboard-calendar-section" });
    
    // 右上角刷新按钮（无边框，融入背景）
    const refreshBtn = section.createEl("button", { 
      text: "🔄", 
      cls: "rslatte-dashboard-calendar-refresh-btn" 
    });
    refreshBtn.title = "刷新工作台";
    refreshBtn.onclick = () => this.refresh();

    const content = section.createDiv({ cls: "rslatte-dashboard-section-content" });
    
    // 左上角显示当前空间名称（可点击跳转到 Hub）
    const spaceName = "当前空间：" + (this.plugin.getSpaceConfig?.()?.name || this.plugin.getCurrentSpaceId?.() || "默认空间");
    const spaceBox = content.createDiv({ cls: "rslatte-dashboard-calendar-space-box" });
    spaceBox.style.cursor = "pointer";
    spaceBox.title = "点击跳转到 RSLatte Hub";
    spaceBox.onclick = async () => {
      await this.plugin.activateHubView();
    };
    spaceBox.createEl("div", { 
      text: spaceName, 
      cls: "rslatte-dashboard-calendar-space-text" 
    });
    
    const today = this.plugin.getTodayKey();
    const now = momentFn(today, "YYYY-MM-DD");
    const weekday = now.format("dddd");
    
    // 左侧显示当前日期框（居中）
    const dateBox = content.createDiv({ cls: "rslatte-dashboard-calendar-date-box" });
    dateBox.createEl("div", { 
      text: now.format("YYYY-MM-DD"), 
      cls: "rslatte-dashboard-calendar-date-text" 
    });
    dateBox.createEl("div", { 
      text: `(${weekday})`, 
      cls: "rslatte-dashboard-calendar-weekday-text" 
    });
    dateBox.style.cursor = "pointer";
    dateBox.title = "点击跳转到日历视图";
    dateBox.onclick = async () => {
      await this.plugin.activateCalendarView();
    };
    // 联系人模块启用时在时间区块下面显示联系人条
    if (this.plugin.isPipelineModuleEnabled("contacts")) {
      await this.renderContactsBlock(content);
    }
  }

  /**
   * 渲染联系人区块（显示在时间区块下面）
   */
  private async renderContactsBlock(parent: HTMLElement) {
    const contactsBox = parent.createDiv({ cls: "rslatte-dashboard-calendar-contacts-box" });
    contactsBox.style.cursor = "pointer";
    contactsBox.title = "点击跳转到联系人侧边栏";
    contactsBox.onclick = async () => {
      await this.plugin.activateContactsView();
    };

    // 左侧标题
    const titleEl = contactsBox.createDiv({ cls: "rslatte-dashboard-calendar-contacts-title" });
    titleEl.setText("🪪 联系人");

    // 右侧显示 active 联系人数
    const countEl = contactsBox.createDiv({ cls: "rslatte-dashboard-calendar-contacts-count" });
    
    try {
      // 获取当前空间的 active 联系人数
      const activeCount = await this.getActiveContactsCount();
      countEl.setText(String(activeCount));
    } catch (e) {
      console.warn("[RSLatte][Dashboard] Failed to get contacts count:", e);
      countEl.setText("0");
    }
  }

  /**
   * 获取当前空间的 active 联系人数
   */
  private async getActiveContactsCount(): Promise<number> {
    try {
      if (!this.plugin.contactsIndex) {
        return 0;
      }

      const index = await this.plugin.contactsIndex.getIndexStore().readIndex();
      if (!index || !Array.isArray(index.items)) {
        return 0;
      }

      // 过滤出 status === "active" 的联系人
      const activeContacts = index.items.filter((item: any) => {
        const status = String(item.status ?? "").trim().toLowerCase();
        return status === "active";
      });

      return activeContacts.length;
    } catch (e) {
      console.warn("[RSLatte][Dashboard] getActiveContactsCount error:", e);
      return 0;
    }
  }

  /**
   * 渲染事项提醒模块（与侧边栏样式一致，仅显示备忘条目，去掉年份和日期）
   */
  private async renderReminders(parent: HTMLElement) {
    const section = parent.createDiv({ cls: "rslatte-dashboard-section" });
    const header = section.createDiv({ cls: "rslatte-dashboard-section-header rslatte-dashboard-task-header" });
    header.createEl("span", { text: "⏰", cls: "rslatte-dashboard-section-icon" });
    header.createEl("h2", { text: "事项提醒" });
    header.style.cursor = "pointer";
    header.onclick = async () => {
      await this.plugin.activateTaskView();
    };

    // 右上角显示数量（先创建，后续更新）
    const countBadge = header.createDiv({ cls: "rslatte-dashboard-reminder-count" });
    countBadge.setText("0");

    const content = section.createDiv({ cls: "rslatte-dashboard-section-content" });
    
    try {
      if (!this.plugin.isPipelineModuleEnabled("memo")) {
        content.createEl("p", { text: "备忘模块未启用" });
        countBadge.setText("0");
        return;
      }
      if (!this.plugin.taskRSLatte) {
        content.createEl("p", { text: "备忘模块未启用" });
        countBadge.setText("0");
        return;
      }

      // 获取与侧边栏相同的数据范围
      const panel = (this.plugin.settings as any)?.taskPanel;
      const memoDays = Math.max(0, Number(panel?.memoLookaheadDays ?? 7));
      
      const memos = await this.plugin.taskRSLatte.listImportantMemos(memoDays);
      
      // 更新右上角数量
      countBadge.setText(String(memos.length));
      
      if (memos.length === 0) {
        content.createDiv({ cls: "rslatte-dashboard-reminder-empty", text: "（未来范围内无事项提醒）" });
        return;
      }

      // 仅显示备忘条目，不显示年份和日期
      const memoList = content.createDiv({ cls: "rslatte-dashboard-reminder-list" });
      for (const m of memos) {
        this.renderReminderItem(memoList, m);
      }
    } catch (e) {
      content.createEl("p", { text: `错误: ${String(e)}` });
      countBadge.setText("0");
    }
  }

  /**
   * 渲染单个备忘条目（与侧边栏样式一致）
   */
  private renderReminderItem(parent: HTMLElement, m: RSLatteIndexItem) {
    const row = parent.createDiv({ cls: "rslatte-dashboard-reminder-item" });
    row.tabIndex = 0;

    // 左侧时间轴轨道
    const gutter = row.createDiv({ cls: "rslatte-dashboard-reminder-gutter" });
    const dot = gutter.createDiv({ cls: "rslatte-dashboard-reminder-dot" });
    dot.setText("🔔");
    gutter.createDiv({ cls: "rslatte-dashboard-reminder-line" });

    // 右侧内容
    const content = row.createDiv({ cls: "rslatte-dashboard-reminder-content" });
    content.createDiv({ cls: "rslatte-dashboard-reminder-text", text: m.text || m.raw });

    const meta = content.createDiv({ cls: "rslatte-dashboard-reminder-meta" });
    meta.setText(this.buildReminderMeta(m));

    //content.createDiv({ cls: "rslatte-dashboard-reminder-from", text: this.shortPath(m.filePath) });

    // 点击打开文件
    //const open = async () => {
    //  try {
    //    await this.openTaskInFile(m.filePath, m.lineNo);
    //  } catch (e: any) {
    //    new Notice(`打开失败：${e?.message ?? String(e)}`);
    //  }
    //};

    //row.addEventListener("click", () => void open());
    //row.addEventListener("keydown", (ev) => {
    //  if ((ev as KeyboardEvent).key === "Enter") void open();
    //});
  }

  /**
   * 构建备忘元数据（与侧边栏一致）
   */
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

    return parts.join(" ");
  }

  /**
   * 缩短文件路径显示（与侧边栏一致）
   */
  private shortPath(path: string): string {
    if (!path) return "";
    const parts = path.split("/");
    if (parts.length <= 2) return path;
    return parts.slice(-2).join("/");
  }

  // /**
  //  * 打开任务/备忘所在文件（与侧边栏一致）
  //  * 当前未使用，已禁用点击条目跳转功能
  //  */
  // private async openTaskInFile(filePath: string, lineNo: number): Promise<void> {
  //   const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
  //   if (!file || !(file instanceof TFile)) {
  //     throw new Error(`找不到文件：${filePath}`);
  //   }

  //   const leaf = this.plugin.app.workspace.getLeaf(false);
  //   if (!leaf) return;
  //   
  //   await leaf.openFile(file, { active: true, state: { mode: "source" } });

  //   window.setTimeout(() => {
  //     const view: any = leaf.view as any;
  //     const editor = view?.editor;
  //     if (!editor) return;
  //     const ln = Math.max(0, Number(lineNo || 0));
  //     try {
  //       editor.setCursor({ line: ln, ch: 0 });
  //       editor.scrollIntoView({ from: { line: ln, ch: 0 }, to: { line: ln + 1, ch: 0 } }, true);
  //     } catch { }
  //   }, 50);
  // }

  /**
   * Checklist 模式：不弹窗，直接切换"今日"打卡状态
   */
  private async toggleCheckinQuick(item: any): Promise<void> {
    await this.plugin.performCheckinToggle(item, "");
    // 刷新工作台以更新状态
    this.refresh();
  }

  /**
   * 打卡热力图：最近 7 天，一天一个字符；有打卡则显示色块，无则空格
   */
  private renderCheckinHeatmap(parentRow: HTMLElement, checkinId: string, allItems: any[], todayKey: string) {
    const heat = parentRow.createDiv({ cls: "rslatte-heatmap" });

    const onColor = (this.plugin.settings.checkinItems ?? []).find((x) => String((x as any).id) === String(checkinId))?.heatColor
      || "var(--color-green)";

    const end = momentFn(todayKey, "YYYY-MM-DD");
    const start = end.clone().subtract(6, "days"); // 最近7天

    // per-day: keep the latest record (by tsMs, fallback to array order)
    const perDay = new Map<string, { ts: number; del: boolean }>();
    for (let i = 0; i < (allItems?.length ?? 0); i++) {
      const it: any = allItems[i];
      if (!it || String(it.checkinId ?? "") !== String(checkinId)) continue;
      const d = String(it.recordDate ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      const m = momentFn(d, "YYYY-MM-DD");
      if (m.isBefore(start) || m.isAfter(end)) continue;
      const ts = typeof it.tsMs === "number" ? it.tsMs : i;
      const cur = perDay.get(d);
      if (!cur || ts >= cur.ts) {
        perDay.set(d, { ts, del: !!it.isDelete });
      }
    }

    // render oldest -> newest (最近7天)
    for (let off = 6; off >= 0; off--) {
      const d = end.clone().subtract(off, "days").format("YYYY-MM-DD");
      const st = perDay.get(d);
      const done = !!st && !st.del;
      const cell = heat.createEl("span", { cls: done ? "rslatte-heat-cell is-on" : "rslatte-heat-cell", text: "" });
      cell.style.backgroundColor = done
        ? onColor
        : "var(--rslatte-heat-off-bg, rgba(120, 120, 120, 0.60))";
      cell.title = done ? `${d} ✅` : `${d} （未打卡）`;
    }
  }

  /**
   * 过去 30 天打卡次数：按"天"计数（同一天多条只算 1 次；以最新记录为准，isDelete=true 视为未打卡）
   */
  private computeCheckinCountLast30Days(checkinId: string, allItems: any[], todayKey: string): number {
    const end = momentFn(todayKey, "YYYY-MM-DD");
    const start = end.clone().subtract(29, "days");

    // per-day: keep the latest record (by tsMs, fallback to array order)
    const perDay = new Map<string, { ts: number; del: boolean }>();
    for (let i = 0; i < (allItems?.length ?? 0); i++) {
      const it: any = allItems[i];
      if (!it || String(it.checkinId ?? "") !== String(checkinId)) continue;
      const d = String(it.recordDate ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      const m = momentFn(d, "YYYY-MM-DD");
      if (m.isBefore(start) || m.isAfter(end)) continue;
      const ts = typeof it.tsMs === "number" ? it.tsMs : i;
      const cur = perDay.get(d);
      if (!cur || ts >= cur.ts) {
        perDay.set(d, { ts, del: !!it.isDelete });
      }
    }

    let cnt = 0;
    for (const v of perDay.values()) {
      if (!v.del) cnt++;
    }
    return cnt;
  }

  /**
   * 渲染打卡模块（与侧边栏一致）
   */
  private async renderCheckins(parent: HTMLElement) {
    const section = parent.createDiv({ cls: "rslatte-dashboard-section" });
    const header = section.createDiv({ cls: "rslatte-dashboard-section-header rslatte-dashboard-task-header" });
    header.createEl("h2", { text: "✅ 打卡" });
    header.onclick = async () => {
      await this.plugin.activateCheckinView();
    };
    //const statusDot = header.createEl("span", { text: "●", cls: "rslatte-dashboard-status-dot" });
    //statusDot.style.color = "var(--text-success)";

    const content = section.createDiv({ cls: "rslatte-dashboard-section-content" });
    
    try {
      if (!this.plugin.isPipelineModuleEnabled("checkin")) {
        content.createEl("p", { text: "打卡模块未启用" });
        return;
      }
      if (!this.plugin.recordRSLatte) {
        content.createEl("p", { text: "打卡模块未启用" });
        return;
      }

      const todayState = this.plugin.getOrCreateTodayState();
      const todayKey = this.plugin.getTodayKey();
      
      // 获取打卡索引快照
      const checkinIndexItems: any[] = [];
      try {
        const cSnap = await this.plugin.recordRSLatte.getCheckinSnapshot(false);
        checkinIndexItems.push(...((cSnap?.items ?? []) as any[]));
      } catch {
        // ignore
      }

      const checkinItems = this.plugin.settings.checkinItems ?? [];
      const activeItems = checkinItems.filter((x: any) => x.active);
      
      if (activeItems.length === 0) {
        content.createEl("p", { text: "*(空)*" });
        return;
      }

      // 根据设置决定显示模式
      const checkinStyle = (this.plugin.settings.checkinDisplayStyle ?? "buttons");
      const checkinList = content.createDiv({
        cls: checkinStyle === "checklist" ? "rslatte-checklist-list" : "rslatte-record-list",
      });

      for (const item of activeItems) {
        const done = !!todayState.checkinsDone[item.id];

        if (checkinStyle === "checklist") {
          // Checklist style: [ ] Name .......... (30d count)
          const row = checkinList.createDiv({ cls: "rslatte-checklist-row" });
          const left = row.createDiv({ cls: "rslatte-checklist-left" });

          const cb = left.createEl("input", { type: "checkbox", cls: "rslatte-checklist-cb" });
          cb.checked = done;
          // Checklist：不弹窗，直接切换
          cb.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            void this.toggleCheckinQuick(item);
          });

          left.createEl("span", { text: item.name, cls: done ? "rslatte-checklist-name is-done" : "rslatte-checklist-name" });
          row.addEventListener("click", () => { void this.toggleCheckinQuick(item); });

          const right = row.createDiv({ cls: "rslatte-checklist-right" });
          const cnt = this.computeCheckinCountLast30Days(item.id, checkinIndexItems, todayKey);
          const cntEl = right.createEl("span", { text: String(cnt), cls: "rslatte-checklist-count" });
          cntEl.title = `过去30天打卡次数：${cnt}`;
        } else {
          // Button style: button + 7-day heatmap
          const row = checkinList.createDiv({ cls: "rslatte-record-row" });
          const btn = row.createEl("button", {
            text: item.name,
            cls: done ? "rslatte-btn done" : "rslatte-btn todo",
          });
          btn.onclick = async () => { new CheckinModal(this.app, this.plugin, item).open(); };

          // 最近 7 天热力图（一天一个字符）
          this.renderCheckinHeatmap(row, item.id, checkinIndexItems, todayKey);
        }
      }
    } catch (e) {
      content.createEl("p", { text: `错误: ${String(e)}` });
    }
  }

  /**
   * 渲染今日日志模块（区块二：日志子窗口分两列展示）
   */
  private async renderJournal(parent: HTMLElement) {
    const section = parent.createDiv({ cls: "rslatte-dashboard-section" });
    const header = section.createDiv({ cls: "rslatte-dashboard-section-header rslatte-dashboard-task-header" });
    header.createEl("h2", { text: "📅 今日日志" });
    header.onclick = async () => {
      await this.plugin.activateRSLatteView();
    };
    const content = section.createDiv({ cls: "rslatte-dashboard-section-content" });
    
    try {
      const panels = this.plugin.settings.journalPanels ?? [];
      const previews = await ((this.plugin as any).readTodayPanelsPreview?.() ?? Promise.resolve({}));
      
      if (panels.length === 0) {
        content.createEl("p", { text: "*(空)*" });
        return;
      }

      // 日志子窗口分两列展示
      const journalGrid = content.createDiv({ cls: "rslatte-dashboard-journal-grid" });
      const leftCol = journalGrid.createDiv({ cls: "rslatte-dashboard-journal-col" });
      const rightCol = journalGrid.createDiv({ cls: "rslatte-dashboard-journal-col" });

      // 将面板分配到左右两列
      for (let i = 0; i < panels.length; i++) {
        const panel = panels[i];
        const title = panel.label || panel.heading || "未命名";
        const panelContent = previews[panel.id] || "";
        
        const targetCol = i % 2 === 0 ? leftCol : rightCol;
        const panelDiv = targetCol.createDiv({ cls: "rslatte-dashboard-journal-panel" });
        
        // 标题区域
        const panelHeader = panelDiv.createDiv({ cls: "rslatte-dashboard-journal-panel-header" });
        panelHeader.createEl("h3", { text: title });
        
        // 内容区域（可滚动）
        const panelText = panelDiv.createDiv({ cls: "rslatte-dashboard-journal-panel-content" });
        if (panelContent) {
          panelText.textContent = panelContent;
        } else {
          panelText.textContent = "(空)";
          panelText.addClass("rslatte-dashboard-empty");
        }
      }
    } catch (e) {
      content.createEl("p", { text: `错误: ${String(e)}` });
    }
  }

  /**
   * 获取任务统计数据（基于当前空间）
   */
  private async getTaskStats(): Promise<{
    today: { total: number; todo: number; inProgress: number; done: number; cancelled: number };
    overdue: { total: number; todo: number; inProgress: number; done: number; cancelled: number };
    other: { total: number; todo: number; inProgress: number };
    nearDue: { total: number; todo: number; inProgress: number };
  }> {
    const today = momentFn().format("YYYY-MM-DD");
    const now = momentFn();
    const weekLater = now.clone().add(7, "days");

    try {
      // 获取当前空间上下文
      const spaceId = this.plugin.getCurrentSpaceId();
      const spaceIndexDir = resolveSpaceIndexDir(this.plugin.settings, spaceId);
      
      // 读取任务索引文件
      const indexPath = normalizePath(`${spaceIndexDir}/task-index.json`);
      const exists = await this.plugin.app.vault.adapter.exists(indexPath);
      if (!exists) {
        return {
          today: { total: 0, todo: 0, inProgress: 0, done: 0, cancelled: 0 },
          overdue: { total: 0, todo: 0, inProgress: 0, done: 0, cancelled: 0 },
          other: { total: 0, todo: 0, inProgress: 0 },
          nearDue: { total: 0, todo: 0, inProgress: 0 },
        };
      }

      const raw = await this.plugin.app.vault.adapter.read(indexPath);
      const idx: RSLatteIndexFile = raw ? JSON.parse(raw) : { version: 1, updatedAt: new Date().toISOString(), items: [] };
      const items = (idx.items ?? []) as RSLatteIndexItem[];

      // 过滤掉已归档的任务
      const activeItems = items.filter((it) => !(it as any)?.archived);

      // 今日任务（截止日期为今天）
      const todayItems = activeItems.filter((it) => {
        const due = String((it as any)?.dueDate ?? "");
        return due === today;
      });

      // 超期任务（截止日期在今天之前，且未完成/未取消）
      const overdueItems = activeItems.filter((it) => {
        const st = String((it as any)?.status ?? "").toUpperCase();
        if (st === "DONE" || st === "CANCELLED") return false;
        const due = String((it as any)?.dueDate ?? "");
        return due && due.length === 10 && due < today;
      });

      // 其他活跃任务（截止日期在今天之后或没有截止日期，且未完成/未取消）
      const otherItems = activeItems.filter((it) => {
        const st = String((it as any)?.status ?? "").toUpperCase();
        if (st === "DONE" || st === "CANCELLED") return false;
        const due = String((it as any)?.dueDate ?? "");
        if (!due || due.length !== 10) return true;
        return due > today;
      });

      // 近7日即将超期（截止日期在未来7天内）
      const nearDueItems = activeItems.filter((it) => {
        const st = String((it as any)?.status ?? "").toUpperCase();
        if (st === "DONE" || st === "CANCELLED") return false;
        const due = String((it as any)?.dueDate ?? "");
        if (!due || due.length !== 10) return false;
        const dueDate = momentFn(due, "YYYY-MM-DD");
        return dueDate.isAfter(now) && dueDate.isBefore(weekLater);
      });

      const countStatus = (items: RSLatteIndexItem[], status: string): number => {
        return items.filter((it) => {
          const st = String((it as any)?.status ?? "").toUpperCase();
          if (status === "todo") return !st || st === "TODO";
          if (status === "in-progress" || status === "in_progress") return st === "IN_PROGRESS" || st === "IN-PROGRESS";
          if (status === "done") return st === "DONE";
          if (status === "cancelled") return st === "CANCELLED";
          return false;
        }).length;
      };

      return {
        today: {
          total: todayItems.length,
          todo: countStatus(todayItems, "todo"),
          inProgress: countStatus(todayItems, "in-progress"),
          done: countStatus(todayItems, "done"),
          cancelled: countStatus(todayItems, "cancelled"),
        },
        overdue: {
          total: overdueItems.length,
          todo: countStatus(overdueItems, "todo"),
          inProgress: countStatus(overdueItems, "in-progress"),
          done: countStatus(overdueItems, "done"),
          cancelled: countStatus(overdueItems, "cancelled"),
        },
        other: {
          total: otherItems.length,
          todo: countStatus(otherItems, "todo"),
          inProgress: countStatus(otherItems, "in-progress"),
        },
        nearDue: {
          total: nearDueItems.length,
          todo: countStatus(nearDueItems, "todo"),
          inProgress: countStatus(nearDueItems, "in-progress"),
        },
      };
    } catch (e) {
      console.error("[RSLatte][Dashboard] Failed to get task stats:", e);
      return {
        today: { total: 0, todo: 0, inProgress: 0, done: 0, cancelled: 0 },
        overdue: { total: 0, todo: 0, inProgress: 0, done: 0, cancelled: 0 },
        other: { total: 0, todo: 0, inProgress: 0 },
        nearDue: { total: 0, todo: 0, inProgress: 0 },
      };
    }
  }

  /**
   * 渲染任务模块
   */
  private async renderTasks(parent: HTMLElement) {
    const section = parent.createDiv({ cls: "rslatte-dashboard-section" });
    const header = section.createDiv({ cls: "rslatte-dashboard-section-header rslatte-dashboard-task-header" });
    header.createEl("span", { text: "📋", cls: "rslatte-dashboard-section-icon" });
    header.createEl("h2", { text: "任务", cls: "rslatte-dashboard-task-title" });
    header.style.cursor = "pointer";
    header.onclick = async () => {
      await this.plugin.activateTaskView();
    };

    const content = section.createDiv({ cls: "rslatte-dashboard-section-content" });
    
    try {
      if (!this.plugin.isPipelineModuleEnabled("task")) {
        content.createEl("p", { text: "任务模块未启用" });
        return;
      }
      if (!this.plugin.taskRSLatte) {
        content.createEl("p", { text: "任务模块未启用" });
        return;
      }

      const stats = await this.getTaskStats();

      // 精简显示格式
      const statsDiv = content.createDiv({ cls: "rslatte-dashboard-task-stats" });
      
      statsDiv.createEl("div", {
        text: `今日截至${stats.today.total}：⏸${stats.today.todo}，▶${stats.today.inProgress}，✅${stats.today.done}，⛔${stats.today.cancelled}`,
        cls: "rslatte-dashboard-task-stat-line",
      });
      
      statsDiv.createEl("div", {
        text: `超期${stats.overdue.total}：⏸${stats.overdue.todo}，▶${stats.overdue.inProgress}`,
        cls: "rslatte-dashboard-task-stat-line",
      });
      
      statsDiv.createEl("div", {
        text: `其他${stats.other.total}：⏸${stats.other.todo}，▶${stats.other.inProgress}`,
        cls: "rslatte-dashboard-task-stat-line",
      });
      
      statsDiv.createEl("div", {
        text: `近7日即将超期${stats.nearDue.total}：⏸${stats.nearDue.todo}，▶${stats.nearDue.inProgress}`,
        cls: "rslatte-dashboard-task-stat-line",
      });
    } catch (e) {
      content.createEl("p", { text: `错误: ${String(e)}` });
    }
  }

  /**
   * 获取输出统计数据（从当前空间的索引中读取）
   */
  private async getOutputStats(): Promise<{
    total: number;
    byCategory: Record<string, number>;
    overdueCount: number;
  }> {
    try {
      if (!this.plugin.outputRSLatte) {
        return { total: 0, byCategory: {}, overdueCount: 0 };
      }

      const spaceId = this.plugin.getCurrentSpaceId?.();
      const spaceIndexDir = resolveSpaceIndexDir(this.plugin.settings, spaceId, [
        (this.plugin.settings as any)?.outputPanel?.rslatteIndexDir,
        (this.plugin.settings as any)?.outputRSLatteIndexDir,
      ]);

      const { OutputIndexStore } = await import("../../outputRSLatte/indexStore");
      const store = new OutputIndexStore(this.plugin.app, spaceIndexDir);
      const index = await store.readIndex().catch(() => null);
      
      if (!index || !Array.isArray(index.items)) {
        return { total: 0, byCategory: {}, overdueCount: 0 };
      }

      const items = index.items as any[];
      
      // 过滤出正在输出中的文档（未完成、未取消的）
      const activeItems = items.filter((it) => {
        const status = String(it.status ?? "").toLowerCase();
        return status !== "done" && status !== "cancelled";
      });

      // 按docCategory分组统计
      const byCategory: Record<string, number> = {};
      for (const it of activeItems) {
        const cat = String(it.docCategory ?? "未分类").trim();
        const category = cat || "未分类";
        byCategory[category] = (byCategory[category] ?? 0) + 1;
      }

      // 计算超7天未处理的文档数（基于mtimeMs或ctimeMs）
      const now = momentFn();
      const weekAgo = now.clone().subtract(7, "days");
      const overdueCount = activeItems.filter((it) => {
        const mtime = it.mtimeMs;
        const ctime = it.ctimeMs;
        const lastTime = mtime && Number.isFinite(Number(mtime)) ? Number(mtime) : 
                        (ctime && Number.isFinite(Number(ctime)) ? Number(ctime) : null);
        if (!lastTime) return false;
        const lastDate = momentFn(lastTime);
        return lastDate.isBefore(weekAgo);
      }).length;

      return {
        total: activeItems.length,
        byCategory,
        overdueCount,
      };
    } catch (e) {
      console.error("[RSLatte][Dashboard] Failed to get output stats:", e);
      return { total: 0, byCategory: {}, overdueCount: 0 };
    }
  }

  /**
   * 渲染输出模块
   */
  private async renderOutputs(parent: HTMLElement) {
    const section = parent.createDiv({ cls: "rslatte-dashboard-section" });
    const header = section.createDiv({ cls: "rslatte-dashboard-section-header rslatte-dashboard-task-header" });
    header.createEl("span", { text: "📚", cls: "rslatte-dashboard-section-icon" });
    header.createEl("h2", { text: "输出" });
    header.onclick = async () => {
      await this.plugin.activateOutputView();
    };
    const content = section.createDiv({ cls: "rslatte-dashboard-section-content" });
    
    try {
      if (!this.plugin.isPipelineModuleEnabled("output")) {
        content.createEl("p", { text: "输出模块未启用" });
        return;
      }
      if (!this.plugin.outputRSLatte) {
        content.createEl("p", { text: "输出模块未启用" });
        return;
      }

      const stats = await this.getOutputStats();

      // 显示统计数据
      const statsDiv = content.createDiv({ cls: "rslatte-dashboard-output-stats" });
      statsDiv.createEl("div", { 
        text: `当前正在输出文档 ${stats.total}个`,
        cls: "rslatte-dashboard-output-stat-line"
      });

      // 按分类显示（只显示有数据的分类）
      const sortedCategories = Object.entries(stats.byCategory)
        .filter(([_, count]) => count > 0)
        .sort((a, b) => b[1] - a[1]); // 按数量降序

      for (const [cat, count] of sortedCategories) {
        statsDiv.createEl("div", {
          text: `- ${cat}${count}个`,
          cls: "rslatte-dashboard-output-stat-line"
        });
      }

      // 超7天未处理提示
      if (stats.overdueCount > 0) {
        statsDiv.createEl("div", {
          text: `超7天未处理文档有${stats.overdueCount}个，请尽快处理。`,
          cls: "rslatte-dashboard-output-stat-line rslatte-dashboard-output-overdue"
        });
      }

      // 发布模块启用时显示发布管理条，关闭时隐藏
      if (this.plugin.isPipelineModuleEnabled("publish")) {
        await this.renderPublishBlock(content);
      }
    } catch (e) {
      content.createEl("p", { text: `错误: ${String(e)}` });
    }
  }

  /**
   * 渲染发布管理区块（显示在输出区块下方）
   */
  private async renderPublishBlock(parent: HTMLElement) {
    const publishBox = parent.createDiv({ cls: "rslatte-dashboard-publish-box" });
    publishBox.style.cursor = "pointer";
    publishBox.title = "点击跳转到发布管理侧边栏";
    publishBox.onclick = async () => {
      await this.plugin.activatePublishView();
    };

    // 左侧标题
    const titleEl = publishBox.createDiv({ cls: "rslatte-dashboard-publish-title" });
    titleEl.setText("📣 发布管理");

    // 右侧显示发布文档数量
    const countEl = publishBox.createDiv({ cls: "rslatte-dashboard-publish-count" });
    
    try {
      // 获取发布文档数量
      const count = await this.getPublishDocsCount();
      countEl.setText(String(count));
    } catch (e) {
      console.warn("获取发布文档数量失败", e);
      countEl.setText("0");
    }
  }

  /**
   * 获取发布文档数量
   */
  private async getPublishDocsCount(): Promise<number> {
    try {
      if (!this.plugin.publishRSLatte) {
        return 0;
      }
      await this.plugin.publishRSLatte.refreshIndexIfStale(30_000);
      const snap = await this.plugin.publishRSLatte.getSnapshot();
      return (snap?.items ?? []).length;
    } catch (e) {
      console.warn("getPublishDocsCount failed", e);
      return 0;
    }
  }

  /**
   * 获取财务统计数据（从财务统计缓存中读取，包含全量数据）
   */
  private async getFinanceStats(): Promise<{
    expenseByCat: Map<string, number>;
    maxExpense: number;
  }> {
    try {
      if (!this.plugin.recordRSLatte) {
        return { expenseByCat: new Map(), maxExpense: 0 };
      }

      const today = this.plugin.getTodayKey();
      const cache = await this.plugin.recordRSLatte.getFinanceStatsCache();
      const items = cache?.items ?? [];

      const now = momentFn(today, "YYYY-MM-DD");
      const monthKey = now.format("YYYY-MM");

      // 计算本月各分类支出金额
      const expenseByCat = new Map<string, number>();
      for (const it of items) {
        if (it.isDelete) continue;
        const d = String(it.recordDate ?? "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
        if (!d.startsWith(monthKey)) continue;
        if (it.type !== "expense") continue;
        
        const amount = Math.abs(Number(it.amount ?? 0));
        const catId = String(it.categoryId ?? "");
        expenseByCat.set(catId, (expenseByCat.get(catId) ?? 0) + amount);
      }

      // 找出支出最多的分类金额
      const maxExpense = expenseByCat.size > 0 
        ? Math.max(...expenseByCat.values())
        : 0;

      return { expenseByCat, maxExpense };
    } catch (e) {
      console.error("[RSLatte][Dashboard] Failed to get finance stats:", e);
      return { expenseByCat: new Map(), maxExpense: 0 };
    }
  }

  /**
   * 渲染财务模块（每行一个财务分类按钮+色条）
   */
  private async renderFinance(parent: HTMLElement) {
    const section = parent.createDiv({ cls: "rslatte-dashboard-section" });
    const header = section.createDiv({ cls: "rslatte-dashboard-section-header rslatte-dashboard-task-header" });
    header.createEl("span", { text: "💰", cls: "rslatte-dashboard-section-icon" });
    header.createEl("h2", { text: "财务" });
    header.onclick = async () => {
      await this.plugin.activateFinanceView();
    };
    const content = section.createDiv({ cls: "rslatte-dashboard-section-content" });
    
    try {
      if (!this.plugin.isPipelineModuleEnabled("finance")) {
        content.createEl("p", { text: "财务模块未启用" });
        return;
      }
      if (!this.plugin.recordRSLatte) {
        content.createEl("p", { text: "财务模块未启用" });
        return;
      }

      const stats = await this.getFinanceStats();
      const { expenseByCat, maxExpense } = stats;

      // 获取所有活跃的财务分类
      const financeCategories = (this.plugin.settings.financeCategories ?? []).filter((x: any) => x.active);
      
      if (financeCategories.length === 0) {
        content.createEl("p", { text: "*(空)*" });
        return;
      }

      // 构建分类数据（包含类型和支出金额）
      const categoryData = financeCategories.map((cat: any) => ({
        id: String(cat.id),
        name: String(cat.name),
        type: String(cat.type ?? "expense"), // "income" 或 "expense"
        monthExpense: expenseByCat.get(String(cat.id)) ?? 0,
      }));

      // 按本月支出从高到低排序（只排序支出分类，收入分类放在最后）
      const expenseCategories = categoryData.filter((c) => c.type === "expense");
      const incomeCategories = categoryData.filter((c) => c.type === "income");
      expenseCategories.sort((a, b) => b.monthExpense - a.monthExpense);
      const sortedCategories = [...expenseCategories, ...incomeCategories];

      // 渲染财务分类列表：分成两个大分区
      const financeList = content.createDiv({ cls: "rslatte-dashboard-finance-list" });
      
      // 左分区：所有按钮
      const leftColumn = financeList.createDiv({ cls: "rslatte-dashboard-finance-left-column" });
      // 右分区：所有色条/收入标记
      const rightColumn = financeList.createDiv({ cls: "rslatte-dashboard-finance-right-column" });
      
      for (const cat of sortedCategories) {
        // 检查今日是否有记录
        const existing = this.plugin.getTodayFinanceRecord(cat.id);
        const done = !!(existing && (existing as any).is_delete === false);
        const btnCls = done ? "rslatte-btn done" : "rslatte-btn";
        
        // 左分区：按钮
        const btnRow = leftColumn.createDiv({ cls: "rslatte-dashboard-finance-btn-row" });
        const btn = btnRow.createEl("button", { 
          text: cat.name, 
          cls: btnCls 
        });
        btn.onclick = () => new FinanceRecordModal(this.app, this.plugin, cat as any).open();

        // 右分区：色条或收入标记
        const rightRow = rightColumn.createDiv({ cls: "rslatte-dashboard-finance-right-row" });
        
        if (cat.type === "income") {
          // 收入分类：显示文字"收入条目"
          rightRow.createEl("span", { 
            text: "收入条目", 
            cls: "rslatte-dashboard-finance-income-label" 
          });
        } else {
          // 支出分类：色条容器
          const barContainer = rightRow.createDiv({ cls: "rslatte-dashboard-finance-bar-container" });
          
          // 色条
          if (cat.monthExpense > 0) {
            const barWidth = maxExpense > 0 
              ? (cat.monthExpense / maxExpense) * 100 
              : 0;
            const bar = barContainer.createDiv({ cls: "rslatte-dashboard-finance-bar" });
            bar.style.width = `${barWidth}%`;
            bar.style.backgroundColor = "var(--color-green)";
            bar.title = `${cat.monthExpense.toFixed(2)}`;
            
            // 在绿色填充条内部显示金额（白色加粗，靠右）
            bar.createEl("span", {
              text: cat.monthExpense.toFixed(2),
              cls: "rslatte-dashboard-finance-bar-amount"
            });
          }
          // 如果支出为0，barContainer 仍然存在，只是没有绿色条和金额，确保宽度对齐
        }
      }
    } catch (e) {
      content.createEl("p", { text: `错误: ${String(e)}` });
    }
  }

  /**
   * 获取项目统计数据
   */
  private async getProjectStats(): Promise<Array<{
    id: string;
    name: string;
    status: string;
    create?: string;
    due?: string;
    start?: string;
    milestones: {
      active: number;
      done: number;
      cancelled: number;
      total: number;
    };
    tasks: {
      todo: number;
      inProgress: number;
      done: number;
      cancelled: number;
      total: number;
    };
  }>> {
    try {
      if (!this.plugin.projectMgr) {
        return [];
      }

      let snapshot = (this.plugin.projectMgr as any).getSnapshot?.();
      
      // 如果 snapshot 未初始化（updatedAt 为0）或项目列表为空，则触发一次刷新
      // 这样可以确保在插件启动后首次打开工作台时能获取到项目数据
      if (!snapshot || snapshot.updatedAt === 0 || 
          !Array.isArray(snapshot.projects) || snapshot.projects.length === 0) {
        // 触发一次增量刷新，确保项目数据被加载
        try {
          // 检查是否有 markIndexProjectsDirtyAndRefresh 方法
          // ✅ 修复：直接调用方法，保持正确的 this 上下文
          const projectMgr = this.plugin.projectMgr as any;
          if (projectMgr && typeof projectMgr.markIndexProjectsDirtyAndRefresh === "function") {
            await projectMgr.markIndexProjectsDirtyAndRefresh();
            // 等待一小段时间让刷新完成（refreshDirty 是异步的）
            await new Promise(resolve => setTimeout(resolve, 200));
            snapshot = projectMgr.getSnapshot?.();
          }
        } catch (e) {
          console.warn("[RSLatte][Dashboard] Failed to refresh project data:", e);
        }
      }
      
      if (!snapshot || !Array.isArray(snapshot.projects)) {
        return [];
      }

      // 过滤未完成或取消的项目
      const activeProjects = snapshot.projects.filter((p: any) => {
        const status = String(p.status ?? "").toLowerCase();
        return status !== "done";
      });

      return activeProjects.map((p: any) => {
        // 统计里程碑各状态数量
        const milestones = p.milestones ?? [];
        const milestoneStats = {
          active: 0,
          done: 0,
          cancelled: 0,
          total: milestones.length,
        };
        for (const m of milestones) {
          const ms = String(m.milestoneStatus ?? "active").toLowerCase();
          if (ms === "done") milestoneStats.done++;
          else if (ms === "cancelled") milestoneStats.cancelled++;
          else milestoneStats.active++;
        }

        // 统计任务各状态数量（不区分里程碑）
        const tasks = p.taskItems ?? [];
        const taskStats = {
          todo: 0,
          inProgress: 0,
          done: 0,
          cancelled: 0,
          total: tasks.length,
        };
        for (const t of tasks) {
          const status = String(t.statusName ?? "").toUpperCase();
          if (status === "TODO") taskStats.todo++;
          else if (status === "IN_PROGRESS") taskStats.inProgress++;
          else if (status === "DONE") taskStats.done++;
          else if (status === "CANCELLED") taskStats.cancelled++;
        }

        return {
          id: String(p.projectId ?? ""),
          name: String(p.projectName ?? ""),
          status: String(p.status ?? "todo"),
          create: p.create ? String(p.create) : undefined,
          due: p.due ? String(p.due) : undefined,
          start: p.start ? String(p.start) : undefined,
          milestones: milestoneStats,
          tasks: taskStats,
        };
      });
    } catch (e) {
      console.error("[RSLatte][Dashboard] Failed to get project stats:", e);
      return [];
    }
  }

  /**
   * 渲染项目模块
   */
  private async renderProjects(parent: HTMLElement) {
    const section = parent.createDiv({ cls: "rslatte-dashboard-section" });
    const header = section.createDiv({ cls: "rslatte-dashboard-section-header rslatte-dashboard-task-header" });
    header.createEl("h2", { text: "🗂️ 项目" });
    header.onclick = async () => {
      await this.plugin.activateProjectView();
    };
    const content = section.createDiv({ cls: "rslatte-dashboard-section-content" });
    
    try {
      if (!this.plugin.isPipelineModuleEnabled("project")) {
        content.createEl("p", { text: "项目模块未启用" });
        return;
      }
      const projects = await this.getProjectStats();
      
      if (projects.length === 0) {
        content.createEl("p", { text: "*(空)*" });
        return;
      }

      for (const p of projects) {
        const projectItem = content.createDiv({ cls: "rslatte-dashboard-project-item" });
        
        // 项目标题和状态
        const titleRow = projectItem.createDiv({ cls: "rslatte-dashboard-project-title-row" });
        titleRow.createEl("span", { 
          text: p.name, 
          cls: "rslatte-dashboard-project-name" 
        });
        titleRow.createEl("span", { 
          text: p.status, 
          cls: "rslatte-dashboard-project-status" 
        });
        
        // 日期信息
        const dateParts: string[] = [];
        if (p.create) dateParts.push(`create ${p.create}`);
        if (p.start) dateParts.push(`start ${p.start}`);
        if (p.due) dateParts.push(`due ${p.due}`);
        if (dateParts.length > 0) {
          projectItem.createEl("div", {
            text: dateParts.join(" · "),
            cls: "rslatte-dashboard-project-dates",
          });
        }
        
        // 里程碑色条
        const milestoneRow = projectItem.createDiv({ cls: "rslatte-dashboard-project-bar-row" });
        milestoneRow.createEl("span", { 
          text: "里程碑", 
          cls: "rslatte-dashboard-project-bar-label" 
        });
        const milestoneBar = milestoneRow.createDiv({ cls: "rslatte-dashboard-project-bar-container" });
        this.renderStatusBar(milestoneBar, {
          done: p.milestones.done,
          active: p.milestones.active,
          cancelled: p.milestones.cancelled,
          total: p.milestones.total,
        }, true);
        
        // 任务色条
        const taskRow = projectItem.createDiv({ cls: "rslatte-dashboard-project-bar-row" });
        taskRow.createEl("span", { 
          text: "任务", 
          cls: "rslatte-dashboard-project-bar-label" 
        });
        const taskBar = taskRow.createDiv({ cls: "rslatte-dashboard-project-bar-container" });
        this.renderStatusBar(taskBar, {
          done: p.tasks.done,
          inProgress: p.tasks.inProgress,
          todo: p.tasks.todo,
          cancelled: p.tasks.cancelled,
          total: p.tasks.total,
        }, false);
      }
    } catch (e) {
      content.createEl("p", { text: `错误: ${String(e)}` });
    }
  }

  /**
   * 渲染状态色条（里程碑或任务）
   */
  private renderStatusBar(container: HTMLElement, stats: {
    done?: number;
    active?: number;
    inProgress?: number;
    todo?: number;
    cancelled?: number;
    total: number;
  }, isMilestone: boolean = false) {
    if (stats.total === 0) {
      // 空色条，只显示边框
      return;
    }

    // 计算各状态的数量和百分比
    const done = stats.done ?? 0;
    const inProgress = stats.inProgress ?? 0;
    const todo = stats.todo ?? 0;
    const active = stats.active ?? 0;
    const cancelled = stats.cancelled ?? 0;

    if (isMilestone) {
      // 里程碑色条：active/done(绿色), cancelled(灰色带绿边框)
      const activeDone = active + done;
      if (activeDone > 0) {
        const segment = container.createDiv({ cls: "rslatte-dashboard-project-bar-segment rslatte-dashboard-project-bar-green" });
        segment.style.width = `${(activeDone / stats.total) * 100}%`;
        segment.createEl("span", {
          text: String(activeDone),
          cls: "rslatte-dashboard-project-bar-number",
        });
      }
      if (cancelled > 0) {
        const segment = container.createDiv({ cls: "rslatte-dashboard-project-bar-segment rslatte-dashboard-project-bar-gray" });
        segment.style.width = `${(cancelled / stats.total) * 100}%`;
        segment.createEl("span", {
          text: String(cancelled),
          cls: "rslatte-dashboard-project-bar-number",
        });
      }
    } else {
      // 任务色条：done(绿色), inProgress(橙色), todo/cancelled(灰色带绿边框)
      if (done > 0) {
        const segment = container.createDiv({ cls: "rslatte-dashboard-project-bar-segment rslatte-dashboard-project-bar-green" });
        segment.style.width = `${(done / stats.total) * 100}%`;
        segment.createEl("span", {
          text: String(done),
          cls: "rslatte-dashboard-project-bar-number",
        });
      }
      if (inProgress > 0) {
        const segment = container.createDiv({ cls: "rslatte-dashboard-project-bar-segment rslatte-dashboard-project-bar-orange" });
        segment.style.width = `${(inProgress / stats.total) * 100}%`;
        segment.createEl("span", {
          text: String(inProgress),
          cls: "rslatte-dashboard-project-bar-number",
        });
      }
      if (todo > 0) {
        const segment = container.createDiv({ cls: "rslatte-dashboard-project-bar-segment rslatte-dashboard-project-bar-gray" });
        segment.style.width = `${(todo / stats.total) * 100}%`;
        segment.createEl("span", {
          text: String(todo),
          cls: "rslatte-dashboard-project-bar-number",
        });
      }
      if (cancelled > 0) {
        const segment = container.createDiv({ cls: "rslatte-dashboard-project-bar-segment rslatte-dashboard-project-bar-gray" });
        segment.style.width = `${(cancelled / stats.total) * 100}%`;
        segment.createEl("span", {
          text: String(cancelled),
          cls: "rslatte-dashboard-project-bar-number",
        });
      }
    }
  }

  /**
   * 渲染操作日志模块
   */
  private async renderWorkEvents(parent: HTMLElement) {
    const section = parent.createDiv({ cls: "rslatte-dashboard-section" });
    const header = section.createDiv({ cls: "rslatte-dashboard-section-header rslatte-dashboard-task-header" });
    header.createEl("h2", { text: "📜 操作日志" });
    header.onclick = async () => {
      await this.plugin.activateTimelineView();
    };
    const content = section.createDiv({ cls: "rslatte-dashboard-section-content" });
    
    try {
      if (!this.plugin.workEventSvc) {
        content.createEl("p", { text: "操作日志未启用" });
        return;
      }

      const events = await this.plugin.workEventSvc.readLatestEvents(20);
      
      if (events.length === 0) {
        content.createEl("p", { text: "*(空)*" });
        return;
      }

      const icons: Record<string, string> = {
        checkin: "✅",
        finance: "💰",
        task: "📋",
        projecttask: "📋",
        project: "🗂️",
        milestone: "🎯",
        output: "📚",
        contact: "👤",
        file: "📄",
        sync: "🔄",
      };

      const actionTexts: Record<string, string> = {
        create: "创建",
        update: "更新",
        status: "状态变更",
        delete: "删除",
        archive: "归档",
      };

      for (const event of events) {
        const time = momentFn(event.ts).format("MM-DD HH:mm");
        const icon = icons[event.kind] || "📝";
        const action = actionTexts[event.action] || event.action;
        const summary = event.summary || "";
        const fullText = `- ${time} ${icon} ${action} ${summary}`;
        
        const eventItem = content.createEl("p", { 
          text: fullText,
          cls: "rslatte-dashboard-work-event-item"
        });
        // 添加title属性，鼠标悬停时显示完整内容
        eventItem.title = fullText;
      }
    } catch (e) {
      content.createEl("p", { text: `错误: ${String(e)}` });
    }
  }
}
