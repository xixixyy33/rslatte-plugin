import { ItemView, Notice, WorkspaceLeaf, moment } from "obsidian";
import type RSLattePlugin from "../../main";
import { VIEW_TYPE_RSLATTE } from "../../constants/viewTypes";

const momentFn = moment as any;
import { CheckinModal } from "../modals/CheckinModal";
import { FinanceRecordModal } from "../modals/FinanceRecordModal";
import { AddCheckinItemModal } from "../modals/AddCheckinItemModal";
import { AddFinanceCategoryModal } from "../modals/AddFinanceCategoryModal";
import { AddJournalPanelModal } from "../modals/AddJournalPanelModal";
import { HealthCardModal } from "../modals/AddHealthRecordModal";
import { EditHealthEntryModal } from "../modals/EditHealthEntryModal";
import { createHeaderRow, appendDbSyncIndicator } from "../helpers/moduleHeader";
import type { HealthRecordIndexItem } from "../../types/recordIndexTypes";
import {
  buildHealthCanonicalHeatPresence,
  findLatestActiveHealthItemForCanonicalToday,
  HEALTH_CANONICAL_METRICS_ORDER,
  healthCanonicalShortLabelZh,
  readHealthMetricsEnabledForUi,
  type HealthCanonicalMetricKey,
} from "../../services/health/healthCanonicalMetrics";
import {
  CHECKIN_DIFFICULTY_LABELS,
  checkinDifficultyEmojiOnly,
  normalizeCheckinDifficulty,
} from "../../types/rslatteTypes";

export class RSLatteSidePanelView extends ItemView {
  private plugin: RSLattePlugin;
  private _renderSeq = 0;

  constructor(leaf: WorkspaceLeaf, plugin: RSLattePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_RSLATTE; }
  getDisplayText(): string { return "今日打卡"; }
  getIcon(): string { return "calendar-check"; }

  async onOpen() {
    // Step E1：按模块开关决定是否初始化（避免关闭模块仍访问后端）
    const checkinEnabled = this.plugin.isPipelineModuleEnabled("checkin");
    const financeEnabled = this.plugin.isPipelineModuleEnabled("finance");
    const healthEnabled = this.plugin.isHealthModuleEnabled();
    if (!checkinEnabled && !financeEnabled && !healthEnabled) {
      void this.render();
      return;
    }

    // 启动/打开侧边栏阶段默认不访问后端：避免 URL 异常时刷红。
    // 需要后端事实来源时，将在用户触发 DB 同步/写入等场景再访问后端。
    if (checkinEnabled) await ((this.plugin as any).ensureTodayCheckinsInitialized?.({ allowDb: false }) ?? Promise.resolve());
    if (financeEnabled) await ((this.plugin as any).ensureTodayFinancesInitialized?.({ allowDb: false }) ?? Promise.resolve());
    void this.render();
  }
  async onClose() { }

  /** 今日打卡侧栏内滚动到打卡 / 财务 / 今日日记分区 */
  public scrollToInspectSection(which: "checkin" | "finance" | "health" | "journal"): void {
    const root = this.containerEl.children[1] as HTMLElement | undefined;
    if (!root) return;
    const el = root.querySelector(`[data-rslatte-inspect="${which}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  /**
   * Checklist 模式：不弹窗，直接切换"今日"打卡状态。
   * - 备注默认为空
   * - 使用共享的打卡切换业务逻辑（performCheckinToggle）
   */
  private async toggleCheckinQuick(item: any): Promise<void> {
    // ✅ 使用共享的打卡切换业务逻辑（备注为空）
    await this.plugin.performCheckinToggle(item, "");
  }

  private async render() {
    const seq = ++this._renderSeq;
    // 不要在 render 时频繁拉取 DB。
    // 打卡状态：启动时初始化一次；后续每次 upsert 成功后回写到本地状态并触发 refresh 即可。

    const todayState = this.plugin.getOrCreateTodayState();
    const container = this.containerEl.children[1];
    container.empty();

    // Step E1：模块开关（与 Engine 一致）
    const checkinEnabled = this.plugin.isPipelineModuleEnabled("checkin");
    const financeEnabled = this.plugin.isPipelineModuleEnabled("finance");
    const healthEnabled = this.plugin.isHealthModuleEnabled();

    const checkins = this.plugin.settings.checkinItems.filter((x) => x.active);
    const finance = this.plugin.settings.financeCategories.filter((x) => x.active);

    const todayKey = this.plugin.getTodayKey();
    // best-effort: index snapshots (used for heatmap + finance stats)
    let checkinIndexItems: any[] = [];
    let financeIndexItems: any[] = [];
    try {
      if (this.plugin.recordRSLatte) {
        const cSnap = await this.plugin.recordRSLatte.getCheckinSnapshot(false);
        checkinIndexItems = (cSnap?.items ?? []) as any[];

        // 仅主索引（active）：归档阈值 ≥90 天，今日打卡展示的当月/上月/本年汇总均在近期，一般仍在 active；与财务侧栏「清单」同源，避免再走统计缓存分支
        const fSnap = await this.plugin.recordRSLatte.getFinanceSnapshot(false);
        financeIndexItems = (fSnap?.items ?? []) as any[];
      }
    } catch {
      // ignore
    }

    // 并发 render：若期间又触发了新的 render，本帧已为过期，勿再向 container 追加（否则会叠两套「今日打卡」）
    if (seq !== this._renderSeq) return;

    // 今日打卡标题
    const todayCheckSection = container.createDiv({ cls: "rslatte-section" });
    const { left: todayCheckLeft, right: todayCheckActions } = createHeaderRow(
      todayCheckSection,
      "rslatte-section-title-row",
      "rslatte-section-title-left",
      "rslatte-task-actions",
    );
    todayCheckLeft.createEl("h3", { text: "🔍 今日打卡" });
    
    // 统一刷新按钮（刷新打卡、财务和今日日记）
    const unifiedRefreshBtn = todayCheckActions.createEl("button", { text: "🔄", cls: "rslatte-icon-btn" });
    unifiedRefreshBtn.title = "刷新打卡、财务和今日日记";
    unifiedRefreshBtn.onclick = async () => {
      try {
        unifiedRefreshBtn.disabled = true;
        // 刷新打卡（不触发 render，只执行刷新逻辑）
        if (checkinEnabled) {
          await this.manualRefreshWithoutRender({ checkin: true, finance: false }, "打卡");
          try { await this.plugin.recomputeCheckinContinuousDaysFromIndex?.(); } catch { }
        }
        // 刷新财务（不触发 render，只执行刷新逻辑）
        if (financeEnabled) {
          await this.manualRefreshWithoutRender({ checkin: false, finance: true }, "财务");
        }
        // 最后统一刷新一次视图（使用 await 确保完成）
        await this.render();
        new Notice("已刷新");
      } catch (e) {
        console.error("[RSLatte] Unified refresh failed:", e);
      } finally {
        unifiedRefreshBtn.disabled = false;
      }
    };

    // NOTE(UI): 移除“打卡/财务”总标题，打卡与财务为并列分区。

    if (checkinEnabled) {
    // ===== 打卡 =====
    const checkinSection = container.createDiv({ cls: "rslatte-section" });
    checkinSection.setAttribute("data-rslatte-inspect", "checkin");
    const { left: ckLeft, right: ckActions } = createHeaderRow(
      checkinSection,
      "rslatte-section-title-row",
      "rslatte-section-title-left",
      "rslatte-task-actions",
    );
    ckLeft.createEl("h3", { text: "✅ 打卡" });
    const ckLight = this.plugin.getDbSyncIndicator?.("checkin");
    appendDbSyncIndicator(ckLeft, ckLight);

    // 新增打卡项按钮
    const ckAddBtn = ckActions.createEl("button", { text: "➕", cls: "rslatte-icon-btn" });
    ckAddBtn.title = "新增打卡项";
    if (!checkinEnabled) {
      ckAddBtn.disabled = true;
    } else {
      ckAddBtn.onclick = () => {
        new AddCheckinItemModal(this.app, this.plugin).open();
      };
    }

      // one item per line: button + 30-day heatmap
      const checkinStyle = (this.plugin.settings.checkinDisplayStyle ?? "buttons");
      const checkinDetailSection = container.createDiv({ cls: "rslatte-section" });
      const checkinList = checkinDetailSection.createDiv({
        cls: checkinStyle === "checklist" ? "rslatte-checklist-list" : "rslatte-record-list",
      });

      for (const item of checkins) {
        const done = !!todayState.checkinsDone[item.id];

        if (checkinStyle === "checklist") {
          // Checklist style: [ ] Name（右上角连续天数角标）难度icon …… (30d count)
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

          const nameWrap = left.createSpan({ cls: "rslatte-checkin-btn-wrap" });
          nameWrap.createEl("span", { text: item.name, cls: done ? "rslatte-checklist-name is-done" : "rslatte-checklist-name" });
          const streakCk = Math.max(0, item.continuousDays ?? 0);
          if (streakCk > 0) {
            const b = nameWrap.createSpan({
              cls: "rslatte-checkin-streak-badge",
              text: streakCk > 99 ? "99+" : String(streakCk),
            });
            b.title = "已连续打卡天数";
          }

          const ckDiffSlot = left.createDiv({ cls: "rslatte-checkin-diff-slot" });
          ckDiffSlot.createSpan({
            cls: "rslatte-checkin-diff-icon",
            text: checkinDifficultyEmojiOnly((item as any).checkinDifficulty),
          });

          row.addEventListener("click", () => { void this.toggleCheckinQuick(item); });

          const right = row.createDiv({ cls: "rslatte-checklist-right" });
          const cnt = this.computeCheckinCountLast30Days(item.id, checkinIndexItems, todayKey);
          const cntEl = right.createEl("span", { text: String(cnt), cls: "rslatte-checklist-count" });
          cntEl.title = `过去30天打卡次数：${cnt}`;
        } else {
          // Button style：按钮（右上角连续天数角标）+ 难度 icon + 30 天热力图
          const row = checkinList.createDiv({ cls: "rslatte-record-row" });
          const diff = normalizeCheckinDifficulty((item as any).checkinDifficulty);

          const wrap = row.createSpan({ cls: "rslatte-checkin-btn-wrap" });
          const btn = wrap.createEl("button", {
            text: item.name,
            cls: done ? "rslatte-btn done" : "rslatte-link",
          });
          btn.title =
            diff === "normal" ? item.name : `${item.name}（${CHECKIN_DIFFICULTY_LABELS[diff]}）`;
          btn.onclick = async (ev) => {
            ev.stopPropagation();
            new CheckinModal(this.app, this.plugin, item).open();
          };

          const streakBtn = Math.max(0, item.continuousDays ?? 0);
          if (streakBtn > 0) {
            const b = wrap.createSpan({
              cls: "rslatte-checkin-streak-badge",
              text: streakBtn > 99 ? "99+" : String(streakBtn),
            });
            b.title = "已连续打卡天数";
          }

          const diffSlot = row.createDiv({ cls: "rslatte-checkin-diff-slot" });
          diffSlot.createSpan({
            cls: "rslatte-checkin-diff-icon",
            text: checkinDifficultyEmojiOnly((item as any).checkinDifficulty),
          });

          // 过去 30 天热力图（一天一个字符）
          this.renderCheckinHeatmap(row, item.id, checkinIndexItems, todayKey);
        }
      }

// NOTE: 已移除“打卡热力图”跳转配置与按钮

    
    }

    if (financeEnabled) {
    // ===== 财务 =====
    const financeSection = container.createDiv({ cls: "rslatte-section" });
    financeSection.setAttribute("data-rslatte-inspect", "finance");
    const { left: finLeft, right: finActions } = createHeaderRow(
      financeSection,
      "rslatte-section-title-row",
      "rslatte-section-title-left",
      "rslatte-task-actions",
    );
    finLeft.createEl("h3", { text: "💰 财务" });
    const finLight = this.plugin.getDbSyncIndicator?.("finance");
    appendDbSyncIndicator(finLeft, finLight);

    // 新增财务分类按钮
    const finAddBtn = finActions.createEl("button", { text: "➕", cls: "rslatte-icon-btn" });
    finAddBtn.title = "新增财务分类";
    if (!financeEnabled) {
      finAddBtn.disabled = true;
    } else {
      finAddBtn.onclick = () => {
        new AddFinanceCategoryModal(this.app, this.plugin).open();
      };
    }
      const financeDetailSection = container.createDiv({ cls: "rslatte-section" });
      // 财务分类按钮：每行一个按钮+支出总额条（左右分区布局）
      // NOTE: categories == active finance categories
      const categories = finance;
      // 财务统计（当月/当年）- 先计算统计，用于显示支出总额条
      // 说明：此处完全基于“财务索引快照 items”计算，不依赖 main.ts 上的额外 helper，避免因重构遗漏导致 UI 不出图。
      const stats = this.computeFinanceStatsFromIndex(financeIndexItems, todayKey);
      
      // 构建分类数据（包含类型和支出金额）
      const categoryData = categories.map((cat: any) => ({
        id: String(cat.id),
        name: String(cat.name),
        type: String(cat.type ?? "expense"), // "income" 或 "expense"
        monthExpense: stats.monthExpenseByCat.get(String(cat.id)) ?? 0,
        category: cat, // 保留原始分类对象
      }));
      
      // 按本月支出从高到低排序（只排序支出分类，收入分类放在最后）
      const expenseCategories = categoryData.filter((c) => c.type === "expense");
      const incomeCategories = categoryData.filter((c) => c.type === "income");
      expenseCategories.sort((a, b) => b.monthExpense - a.monthExpense);
      const sortedCategories = [...expenseCategories, ...incomeCategories];
      
      // 计算最大支出（用于色条宽度比例）
      const maxExpense = expenseCategories.length > 0 
        ? Math.max(...expenseCategories.map(c => c.monthExpense))
        : 0;
      // 渲染财务分类列表：分成两个大分区
      const financeList = financeDetailSection.createDiv({ cls: "rslatte-finance-list-with-bars" });
      
      // 左分区：所有按钮
      const leftColumn = financeList.createDiv({ cls: "rslatte-finance-left-column" });
      // 右分区：所有色条/收入标记
      const rightColumn = financeList.createDiv({ cls: "rslatte-finance-right-column" });
      
      for (const catData of sortedCategories) {
        const cat = catData.category;
        // 检查今日是否有记录
        const todayRows = this.plugin.getTodayFinanceRecords(cat.id).filter((r: any) => !r.is_delete);
        const done = todayRows.length > 0;
        const btnCls = `rslatte-btn ${done ? 'done' : 'todo'}`;
        
        // 左分区：按钮（角标：今日该分类有效笔数）
        const btnRow = leftColumn.createDiv({ cls: "rslatte-finance-btn-row" });
        const wrap = btnRow.createSpan({ cls: "rslatte-finance-btn-wrap" });
        const btn = wrap.createEl("button", { 
          text: catData.name, 
          cls: btnCls 
        });
        if (todayRows.length > 0) {
          const n = todayRows.length;
          wrap.createSpan({
            cls: "rslatte-finance-count-badge",
            text: n > 99 ? "99+" : String(n),
          });
        }
        btn.title = done ? `今日已记 ${todayRows.length} 笔，点击查看或新增` : "点击记账";
        btn.onclick = () => new FinanceRecordModal(this.app, this.plugin, cat).open();

        // 右分区：色条或收入标记
        const rightRow = rightColumn.createDiv({ cls: "rslatte-finance-right-row" });
        
        if (catData.type === "income") {
          // 收入分类：显示文字"收入条目"
          rightRow.createEl("span", { 
            text: "收入条目", 
            cls: "rslatte-finance-income-label" 
          });
        } else {
          // 支出分类：色条容器
          const barContainer = rightRow.createDiv({ cls: "rslatte-finance-bar-container" });
          
          // 色条
          if (catData.monthExpense > 0) {
            const barWidth = maxExpense > 0 
              ? (catData.monthExpense / maxExpense) * 100 
              : 0;
            const bar = barContainer.createDiv({ cls: "rslatte-finance-bar" });
            bar.style.width = `${barWidth}%`;
            bar.style.backgroundColor = "var(--rslatte-heat-on-bg, var(--color-green))";
            bar.title = `${catData.monthExpense.toFixed(2)}`;
            
            // 在绿色填充条内部显示金额（白色加粗，靠右）
            bar.createEl("span", {
              text: catData.monthExpense.toFixed(2),
              cls: "rslatte-finance-bar-amount"
            });
          }
          // 如果支出为0，barContainer 仍然存在，只是没有绿色条和金额，确保宽度对齐
        }
      }
      
      this.renderFinanceStats(financeDetailSection, stats);
      // ✅ 财务饼图已迁移到财务侧边栏（FinanceSidePanelView），此处不再显示

// NOTE: 已移除“财务统计图”跳转配置与按钮

    }

    if (healthEnabled) {
      const healthSection = container.createDiv({ cls: "rslatte-section" });
      healthSection.setAttribute("data-rslatte-inspect", "health");
      const { left: hthLeft, right: hthActions } = createHeaderRow(
        healthSection,
        "rslatte-section-title-row",
        "rslatte-section-title-left",
        "rslatte-task-actions",
      );
      hthLeft.createEl("h3", { text: "❤️ 健康" });
      const openHealthBtn = hthActions.createEl("button", { text: "📋", cls: "rslatte-icon-btn" });
      openHealthBtn.title = "打开健康管理侧栏";
      openHealthBtn.onclick = () => void (this.plugin as any).activateHealthView?.();
      const healthDetail = container.createDiv({ cls: "rslatte-section rslatte-health-inspect-detail" });

      let healthItems: HealthRecordIndexItem[] = [];
      try {
        await this.plugin.recordRSLatte?.ensureReady?.();
        const hs = await this.plugin.recordRSLatte?.getHealthSnapshot(false);
        healthItems = (hs?.items ?? []) as HealthRecordIndexItem[];
      } catch {
        healthItems = [];
      }
      if (seq !== this._renderSeq) return;

      const en = readHealthMetricsEnabledForUi((this.plugin.settings as any).healthPanel);
      for (const canonical of HEALTH_CANONICAL_METRICS_ORDER) {
        if (!en[canonical]) continue;
        const row = healthDetail.createDiv({ cls: "rslatte-health-inspect-row" });
        const todayItem = findLatestActiveHealthItemForCanonicalToday(healthItems, canonical, todayKey);
        const done = !!todayItem;
        const lab = healthCanonicalShortLabelZh(canonical);
        const metricBtn = row.createEl("button", {
          type: "button",
          text: lab,
          cls: `rslatte-btn rslatte-health-inspect-metric-btn ${done ? "done" : "todo"}`,
        });
        metricBtn.title = done ? `今日已记录，点击编辑「${lab}」` : `点击录入今日「${lab}」`;
        metricBtn.onclick = () => {
          if (todayItem) {
            new EditHealthEntryModal(this.app, this.plugin, {
              item: todayItem,
              onSuccess: () => void this.render(),
            }).open();
          } else {
            new HealthCardModal(this.app, this.plugin, {
              singleCanonicalMetric: canonical,
              lockAnchorToToday: true,
              onSuccess: () => void this.render(),
            }).open();
          }
        };
        this.renderHealthMetricHeatmap(row, canonical, healthItems, todayKey);
      }
    }

// ===== 今日日记（可选展示） =====
    if (this.plugin.settings.showJournalPanels !== false) {
      const todaySection = container.createDiv({ cls: "rslatte-section" });
      todaySection.setAttribute("data-rslatte-inspect", "journal");
      // 标题 + 新增按钮
      const { left: todayLeft, right: todayActions } = createHeaderRow(
        todaySection,
        "rslatte-section-title-row",
        "rslatte-section-title-left",
        "rslatte-task-actions",
      );
      todayLeft.createEl("h3", { text: "📅 今日日记" });
      const journalAddBtn = todayActions.createEl("button", { text: "➕", cls: "rslatte-icon-btn" });
      journalAddBtn.title = "新增日志子窗口";
      journalAddBtn.onclick = () => {
        new AddJournalPanelModal(this.app, this.plugin).open();
      };

      const panels = this.plugin.settings.journalPanels || [];
      const todayDetailSection = container.createDiv({ cls: "rslatte-section" });
      const wrap = todayDetailSection.createDiv({ cls: "rslatte-journal-wrap" });
      const previewEls = new Map<string, HTMLElement>();

      panels.forEach((p) => {
        const row = wrap.createDiv({ cls: "rslatte-journal-row" });
        const btn = row.createEl("button", { text: p.label || p.heading, cls: "rslatte-link" });
        btn.onclick = () => ((this.plugin as any).openTodayAtPanel?.(p.id) ?? Promise.resolve());

        const preview = row.createDiv({ cls: "rslatte-journal-preview" });
        preview.setText("…");
        previewEls.set(p.id, preview);
      });

      // 异步填充预览文本（一次读文件，避免按钮逐个 IO）
      try {
        const previews = await ((this.plugin as any).readTodayPanelsPreview?.() ?? Promise.resolve({}));
        if (seq !== this._renderSeq) return; // 防止重复 render 的旧结果覆盖新 UI

        for (const p of panels) {
          const el = previewEls.get(p.id);
          if (!el) continue;
          const text = (previews?.[p.id] ?? "").trimEnd();
          el.empty();
          if (!text) {
            el.addClass("is-empty");
            el.setText("（空）");
          } else {
            el.removeClass("is-empty");
            // 用 <pre> 保留换行；white-space 由 CSS 控制
            el.createEl("pre", { text, cls: "rslatte-journal-pre" });
          }
        }
      } catch {
        // 预览失败不影响主流程
      }
    }

    // 事项提醒模块已移动到「任务管理（Side Panel 2）」中。
  }

  /**
   * 扫描重建：全量扫描 +（可选）DB 同步 +（Engine 层门控）reconcile
   */
  private async manualRebuild(modules: { checkin: boolean; finance: boolean }, labelCn: string): Promise<void> {
    const moduleKey =
      modules.checkin && !modules.finance ? "checkin" : modules.finance && !modules.checkin ? "finance" : null;
    if (!moduleKey) return;

    const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), moduleKey, "rebuild");
    if (!r.ok) {
      new Notice(`${labelCn}重建失败：${r.error.message}`);
      return;
    }
    if (r.data.skipped) return;

    new Notice(`${labelCn}索引已重建`);
    // ✅ 让“按钮是否变绿/财务是否已记账”等 UI 状态以索引为准（避免仅重建索引但 UI 仍显示旧状态）
    try { await this.plugin.hydrateTodayFromRecordIndex(); } catch { }
    this.refresh();
  }

  /**
   * 手动刷新：增量刷新 +（可选）DB 同步 +（Engine 层门控）reconcile
   * - 仅扫描阈值范围内“发生变更”的日记
   * - 若阈值范围内某天日记被删除，则清理该天索引记录（由增量逻辑负责）
   * -（可选）补齐清单后保存 settings，并触发清单/索引 DB sync
   */
  private async manualRefresh(modules: { checkin: boolean; finance: boolean }, labelCn: string): Promise<void> {
    const moduleKey =
      modules.checkin && !modules.finance ? "checkin" : modules.finance && !modules.checkin ? "finance" : null;
    if (!moduleKey) return;

    const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), moduleKey, "manual_refresh");
    if (!r.ok) {
      new Notice(`${labelCn}刷新失败：${r.error.message}`);
      return;
    }
    if (r.data.skipped) return;

    new Notice(`${labelCn}已刷新`);
    // ✅ 增量刷新完成后，用索引回填今日状态（避免需要重启才能看到按钮变绿）
    try { await this.plugin.hydrateTodayFromRecordIndex(); } catch { }
    this.refresh();
  }

  /**
   * 手动刷新（不触发 render）：仅执行刷新逻辑，不刷新视图
   */
  private async manualRefreshWithoutRender(modules: { checkin: boolean; finance: boolean }, labelCn: string): Promise<void> {
    const moduleKey =
      modules.checkin && !modules.finance ? "checkin" : modules.finance && !modules.checkin ? "finance" : null;
    if (!moduleKey) return;

    const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), moduleKey, "manual_refresh");
    if (!r.ok) {
      new Notice(`${labelCn}刷新失败：${r.error.message}`);
      return;
    }
    if (r.data.skipped) return;

    // ✅ 增量刷新完成后，用索引回填今日状态（避免需要重启才能看到按钮变绿）
    try { await this.plugin.hydrateTodayFromRecordIndex(); } catch { }
  }

  /** 手动索引归档：超阈值记录迁入 archive 索引（日记笔记不移动）→ 侧栏重绘 */
  private async manualArchive(modules: { checkin: boolean; finance: boolean }, labelCn: string): Promise<void> {
    const moduleKey =
      modules.checkin && !modules.finance ? "checkin" : modules.finance && !modules.checkin ? "finance" : null;
    if (!moduleKey) return;

    const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), moduleKey, "manual_archive");
    if (!r.ok) {
      new Notice(`${labelCn}索引归档失败：${r.error.message}`);
      return;
    }
    if (r.data.skipped) return;

    new Notice(`${labelCn}索引归档已完成`);
    this.refresh();
  }


  // =========================
  // UI helpers
  // =========================

  /** 健康合并项：过去 30 天是否有有效记录落在该自然日（周/月卡按覆盖日展开）。 */
  private renderHealthMetricHeatmap(
    parentRow: HTMLElement,
    canonical: HealthCanonicalMetricKey,
    allItems: HealthRecordIndexItem[],
    todayKey: string,
  ) {
    const heat = parentRow.createDiv({ cls: "rslatte-heatmap rslatte-health-inspect-heatmap" });
    const presence = buildHealthCanonicalHeatPresence(allItems, canonical, todayKey);
    const end = momentFn(todayKey, "YYYY-MM-DD");
    for (let i = 0; i < 30; i++) {
      const off = 29 - i;
      const d = end.clone().subtract(off, "days").format("YYYY-MM-DD");
      const done = presence[i];
      const cell = heat.createEl("span", { cls: done ? "rslatte-heat-cell is-on" : "rslatte-heat-cell", text: "" });
      cell.style.backgroundColor = done
        ? "var(--interactive-accent, var(--color-purple))"
        : "var(--rslatte-heat-off-bg, rgba(120, 120, 120, 0.60))";
      cell.title = done ? `${d} 已记录` : `${d} 未记录`;
    }
  }

  /** 打卡热力图：过去 30 天，一天一个字符；有打卡则显示色块，无则空格。 */
  private renderCheckinHeatmap(parentRow: HTMLElement, checkinId: string, allItems: any[], todayKey: string) {
    const heat = parentRow.createDiv({ cls: "rslatte-heatmap" });

    const onColor = (this.plugin.settings.checkinItems ?? []).find((x) => String((x as any).id) === String(checkinId))?.heatColor
      || "var(--color-green)";

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

    // render oldest -> newest
    for (let off = 29; off >= 0; off--) {
      const d = end.clone().subtract(off, "days").format("YYYY-MM-DD");
      const st = perDay.get(d);
      const done = !!st && !st.del;
      const cell = heat.createEl("span", { cls: done ? "rslatte-heat-cell is-on" : "rslatte-heat-cell", text: "" });
      // Use a CSS variable with fallback so "off" days remain visible even if the var isn't defined by theme/CSS.
      cell.style.backgroundColor = done
        ? onColor
        : "var(--rslatte-heat-off-bg, rgba(120, 120, 120, 0.60))";
      cell.title = done ? `${d} ✅` : `${d} （未打卡）`;
    }
  }

  /**
   * 过去 30 天打卡次数：按“天”计数（同一天多条只算 1 次；以最新记录为准，isDelete=true 视为未打卡）。
   * 仅用于 UI checklist 的右侧计数展示，不影响任何业务逻辑。
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

  /** 财务统计文案（当月/当年）：不改业务，仅用于侧边栏展示 */
  private renderFinanceStats(parent: HTMLElement, stats: any) {
    const fmt = (n: number) => {
      const v = Number.isFinite(n) ? n : 0;
      // finance amount could be float; keep 2 decimals for readability
      return v.toFixed(2);
    };

    const wrap = parent.createDiv({ cls: "rslatte-fin-stats" });
    wrap.createDiv({
      cls: "rslatte-fin-stats-line",
      text: `本月：支出 ${fmt(stats.monthExpense)} / 收入 ${fmt(stats.monthIncome)}`,
    });
    wrap.createDiv({
      cls: "rslatte-fin-stats-line",
      text: `本年：支出 ${fmt(stats.yearExpense)} / 收入 ${fmt(stats.yearIncome)}`,
    });
  }

  private computeFinanceStatsFromIndex(allItems: any[], todayKey: string) {
    const now = momentFn(todayKey, "YYYY-MM-DD");
    const monthKey = now.format("YYYY-MM");
    const lastMonthKey = now.clone().subtract(1, "month").format("YYYY-MM");
    const yearKey = now.format("YYYY");

    const monthExpenseByCat = new Map<string, number>();
    const lastMonthExpenseByCat = new Map<string, number>();

    let monthExpense = 0;
    let monthIncome = 0;
    let yearExpense = 0;
    let yearIncome = 0;

    for (const it0 of allItems ?? []) {
      const it: any = it0;
      if (!it) continue;
      if (it.isDelete) continue;
      const d = String(it.recordDate ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      const amount = Number(it.amount ?? 0);
      const typ = String(it.type ?? "");
      const catId = String(it.categoryId ?? "");

      const isMonth = d.startsWith(monthKey);
      const isLastMonth = d.startsWith(lastMonthKey);
      const isYear = d.startsWith(yearKey);

      if (typ === "expense") {
        const v = Math.abs(amount);
        if (isMonth) {
          monthExpense += v;
          monthExpenseByCat.set(catId, (monthExpenseByCat.get(catId) ?? 0) + v);
        }
        if (isLastMonth) {
          lastMonthExpenseByCat.set(catId, (lastMonthExpenseByCat.get(catId) ?? 0) + v);
        }
        if (isYear) yearExpense += v;
      } else if (typ === "income") {
        const v = Math.abs(amount);
        if (isMonth) monthIncome += v;
        if (isYear) yearIncome += v;
      }
    }

    const catName = new Map<string, string>();
    for (const c of this.plugin.settings.financeCategories ?? []) {
      catName.set(String(c.id), String(c.name));
    }

    return {
      monthKey,
      lastMonthKey,
      monthExpense,
      monthIncome,
      yearExpense,
      yearIncome,
      monthExpenseByCat,
      lastMonthExpenseByCat,
      catName,
    };
  }

  private renderFinancePieCharts(parent: HTMLElement, stats: any) {
    const wrap = parent.createDiv({ cls: "rslatte-finance-charts" });

    const mkSeries = (m: Map<string, number>) => {
      const arr = Array.from(m.entries()).map(([id, v]) => ({
        id,
        name: stats.catName.get(id) || id || "（未命名）",
        value: v,
      }));
      arr.sort((a, b) => b.value - a.value);
      // limit legend length
      if (arr.length > 8) {
        const top = arr.slice(0, 7);
        const rest = arr.slice(7).reduce((s, x) => s + x.value, 0);
        top.push({ id: "__other__", name: "其他", value: rest });
        return top;
      }
      return arr;
    };

    const blocks: Array<{ title: string; series: any[] }> = [
      { title: `本月支出（${stats.monthKey}）`, series: mkSeries(stats.monthExpenseByCat) },
      { title: `上月支出（${stats.lastMonthKey}）`, series: mkSeries(stats.lastMonthExpenseByCat) },
    ];

    for (const b of blocks) {
      const block = wrap.createDiv({ cls: "rslatte-pie-block" });
      block.createDiv({ cls: "rslatte-pie-title", text: b.title });

      const canvas = block.createEl("canvas", { cls: "rslatte-pie-canvas" }) as HTMLCanvasElement;
      canvas.width = 160;
      canvas.height = 160;
      this.drawPie(canvas, b.series);

      const legend = block.createDiv({ cls: "rslatte-pie-legend" });
      for (const s of b.series) {
        const row = legend.createDiv({ cls: "rslatte-pie-legend-row" });
        row.createEl("span", { cls: "rslatte-pie-swatch", text: "■" }).style.color = this.colorForKey(String(s.id));
        row.createEl("span", { cls: "rslatte-pie-name", text: `${s.name}` });
        row.createEl("span", { cls: "rslatte-pie-val", text: `${Number(s.value).toFixed(0)}` });
      }
    }
  }

  private drawPie(canvas: HTMLCanvasElement, series: Array<{ id: string; value: number }>) {
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
    let a0 = -Math.PI / 2;

    for (const s of series) {
      const v = Number(s.value) || 0;
      if (v <= 0) continue;
      const a1 = a0 + (v / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, a0, a1);
      ctx.closePath();
      ctx.fillStyle = this.colorForKey(String(s.id));
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

}
