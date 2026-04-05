import { ItemView, Notice, WorkspaceLeaf, normalizePath } from "obsidian";
import type RSLattePlugin from "../../main";
import { VIEW_TYPE_HUB, WORKFLOW_VIEW_IDS, WORKFLOW_VIEW_LABELS, type WorkflowViewId } from "../../constants/viewTypes";
import type {
  RSLatteSpaceStatsFileV1,
  RSLatteSpaceStatsModuleEntryV1,
  RSLatteSpaceStatsSyncStatus,
} from "../../types/spaceStats";
import { resolveSpaceStatsDir } from "../../services/space/spaceContext";
import { SpaceStatsService } from "../../services/space/spaceStatsService";
import { RSLATTE_EVENT_DB_SYNC_STATUS_CHANGED, RSLATTE_EVENT_SPACE_STATS_UPDATED } from "../../constants/space";
import { StatusCalculationService } from "../../services/statusCalculationService";
import { buildHubFlatAlerts, type HubAlertInputRow } from "../../services/hub/hubAlertsBuilder";
import { readFinanceAnalysisAlertIndex } from "../../services/finance/financeAnalysisAlertIndex";
import { readHealthAnalysisAlertIndex } from "../../services/health/healthAnalysisAlertIndex";
import {
  computeHubJournalSnapshot,
  hubJournalContentLevel,
  HUB_JOURNAL_MEANINGFUL_OK_THRESHOLD,
  type HubJournalSnapshot,
} from "../../services/hub/hubJournalSnapshot";

/** Hub 卡片内业务模块顺序（日记行单独渲染在最后） */
const HUB_CARD_MODULE_KEYS = [
  "task",
  "memo",
  "schedule",
  "checkin",
  "finance",
  "health",
  "project",
  "output",
  "contacts",
] as const;

export class SpaceHubView extends ItemView {
  private plugin: RSLattePlugin;
  private _renderSeq = 0;
  private _isRefreshing = false; // 标记是否正在刷新
  private _renderTimer: number | null = null; // 防抖定时器

  constructor(leaf: WorkspaceLeaf, plugin: RSLattePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_HUB; }
  getDisplayText(): string { return "RSLatte工作台"; }
  getIcon(): string { return "layout-dashboard"; }

  async onOpen() {
    // 先快速渲染一次（显示已有的统计数据）
    void this.render();
    
    // 然后在后台异步刷新所有空间的统计数据，确保数据是最新的
    // 这样不会阻塞初始渲染，用户可以看到现有数据，同时后台更新数据
    // 注意：refresh() 会设置 _isRefreshing = true，防止事件触发的多次渲染
    void this.refresh();
    
    // 方案A：监听 DB 同步状态变化事件，自动刷新统计数据
    this.registerEvent(
      (this.app.workspace as any).on(RSLATTE_EVENT_DB_SYNC_STATUS_CHANGED, async (event: { moduleKey: string; spaceId: string; pendingCount: number; failedCount: number; status: string }) => {
        if (this.plugin.isDebugLogEnabled()) {
          console.log(`[RSLatte][Hub] DB sync status changed event received:`, event);
        }
        
        // 刷新对应空间的统计数据
        if (event.spaceId) {
          try {
            const ctx = this.plugin.getSpaceCtx(event.spaceId);
            const statsService = new SpaceStatsService(this.plugin);
            // 只刷新对应模块的统计数据
            await statsService.refreshSpaceStats(ctx, [event.moduleKey as any], true);
          } catch (e) {
            console.warn(`[RSLatte][Hub] Failed to refresh stats for space ${event.spaceId} after DB sync status change:`, e);
          }
        }
        
        // 重新渲染视图（使用防抖，避免刷新过程中多次渲染）
        this.scheduleRender();
      })
    );
    
    // 同时监听统计文件更新事件
    // @ts-ignore - 自定义事件类型
    this.registerEvent(
      (this.app.workspace as any).on(RSLATTE_EVENT_SPACE_STATS_UPDATED, async (event: { spaceId: string; moduleKey: string; updatedAt: string }) => {
        if (this.plugin.isDebugLogEnabled()) {
          console.log(`[RSLatte][Hub] Space stats updated event received:`, event);
        }
        // 重新渲染视图以显示最新数据（使用防抖，避免刷新过程中多次渲染）
        this.scheduleRender();
      })
    );
  }

  async onClose() {
    // 清理防抖定时器
    if (this._renderTimer !== null) {
      clearTimeout(this._renderTimer);
      this._renderTimer = null;
    }
    this._isRefreshing = false;
  }

  /**
   * 防抖渲染：避免短时间内多次渲染导致界面闪烁
   */
  private scheduleRender() {
    // 如果正在刷新，延迟渲染（等待刷新完成）
    if (this._isRefreshing) {
      return;
    }
    
    // 清除之前的定时器
    if (this._renderTimer !== null) {
      clearTimeout(this._renderTimer);
    }
    
    // 设置新的定时器，300ms 后渲染（防抖）
    this._renderTimer = window.setTimeout(() => {
      this._renderTimer = null;
      void this.render();
    }, 300);
  }

  public async refresh() {
    // 标记正在刷新，禁用事件触发的渲染
    this._isRefreshing = true;
    
    // 清除防抖定时器，避免刷新过程中触发渲染
    if (this._renderTimer !== null) {
      clearTimeout(this._renderTimer);
      this._renderTimer = null;
    }
    
    try {
      // 强制刷新统计数据（手动刷新按钮触发）
      const spaces = ((this.plugin as any).listSpaces?.() ?? []);
      
      // 记录刷新开始时间
      const refreshStartTime = Date.now();
      if (this.plugin.isDebugLogEnabled()) {
        console.log(`[RSLatte][Hub] Starting manual refresh for ${spaces.length} spaces`);
      }
      
      // 并行刷新所有空间的统计数据
      const refreshPromises = spaces.map(async (space: any) => {
        try {
          const ctx = this.plugin.getSpaceCtx(space.id);
          const statsService = new SpaceStatsService(this.plugin);
          // 获取所有启用的模块
          const enabledModules: string[] = [];
          for (const key of HUB_CARD_MODULE_KEYS) {
            try {
              // 使用统一的模块启用检查方法，传入 spaceId
              if (this.isModuleEnabledInSpace(key, space.id)) {
                enabledModules.push(key);
              }
            } catch {
              // ignore
            }
          }
          
          // ✅ 如果所有模块都关闭了，跳过刷新，避免触发事件导致无限循环
          if (enabledModules.length === 0) {
            if (this.plugin.isDebugLogEnabled()) {
              console.log(`[RSLatte][Hub] All modules disabled for space ${space.id}, skipping refresh`);
            }
            return; // 跳过刷新
          }
          
          // 强制刷新（force=true）确保从队列文件读取最新数据
          await statsService.refreshSpaceStats(
            ctx, 
            enabledModules as any, 
            true // force=true 确保获取最准确的数据
          );
          
          if (this.plugin.isDebugLogEnabled()) {
            console.log(`[RSLatte][Hub] Completed refresh for space ${space.id}`);
          }
        } catch (e) {
          console.warn(`[RSLatte][Hub] Failed to refresh stats for space ${space.id}:`, e);
        }
      });
      
      // 等待所有空间的刷新完成
      try {
        await Promise.all(refreshPromises);
        const refreshDuration = Date.now() - refreshStartTime;
        if (this.plugin.isDebugLogEnabled()) {
          console.log(`[RSLatte][Hub] All spaces refreshed in ${refreshDuration}ms`);
        }
      } catch (e) {
        console.warn(`[RSLatte][Hub] Error during refresh:`, e);
      }
    } finally {
      // 刷新完成，解除刷新标记
      this._isRefreshing = false;
      
      // 刷新完成后，立即渲染一次（不使用防抖，确保用户看到最新数据）
      void this.render();
    }
  }

  private async readSpaceStats(spaceId: string): Promise<RSLatteSpaceStatsFileV1 | null> {
    try {
      const statsPath = normalizePath(`${resolveSpaceStatsDir(this.plugin.settings, spaceId)}/space.json`);
      if (this.plugin.isDebugLogEnabled()) {
        console.log(`[RSLatte][Hub][DEBUG] Reading stats for spaceId: ${spaceId}, path: ${statsPath}`);
      }
      const exists = await this.app.vault.adapter.exists(statsPath);
      if (!exists) {
        if (this.plugin.isDebugLogEnabled()) {
          console.log(`[RSLatte][Hub][DEBUG] Stats file does not exist for spaceId: ${spaceId}`);
        }
        return null;
      }
      const raw = await this.app.vault.adapter.read(statsPath);
      if (!raw) return null;
      const stats = JSON.parse(raw) as RSLatteSpaceStatsFileV1;
      if (this.plugin.isDebugLogEnabled()) {
        console.log(`[RSLatte][Hub][DEBUG] Read stats for spaceId: ${spaceId}, space_id in file: ${stats.space_id}, modules:`, Object.keys(stats.modules || {}));
      }
      return stats;
    } catch (e) {
      if (this.plugin.isDebugLogEnabled()) {
        console.warn(`[RSLatte][Hub][DEBUG] Error reading stats for spaceId: ${spaceId}:`, e);
      }
      return null;
    }
  }

  private getModuleLabel(moduleKey: string): string {
    const labels: Record<string, string> = {
      task: "任务",
      memo: "提醒",
      schedule: "日程",
      checkin: "打卡",
      finance: "财务",
      health: "健康",
      project: "项目",
      output: "输出",
      contacts: "联系人",
      journal: "日记",
    };
    return labels[moduleKey] || moduleKey;
  }

  private formatModuleStats(entry: RSLatteSpaceStatsModuleEntryV1): string {
    const parts: string[] = [];
    
    // Counts
    if (entry.counts) {
      const { total, active, archived } = entry.counts;
      if (total !== undefined) parts.push(`总数: ${total}`);
      if (active !== undefined) parts.push(`活跃: ${active}`);
      if (archived !== undefined && archived > 0) parts.push(`归档: ${archived}`);
    }

    // KPI
    if (entry.kpi) {
      const kpi = entry.kpi;
      
      // Task KPI
      if (kpi.task) {
        const { overdue, dueTodayTotal, dueTodayDone, next7d } = kpi.task;
        if (overdue > 0) parts.push(`超期: ${overdue}`);
        if (dueTodayTotal > 0) parts.push(`今日: ${dueTodayDone}/${dueTodayTotal}`);
        if (next7d > 0) parts.push(`7天内: ${next7d}`);
      }
      
      // Memo KPI
      if (kpi.memo) {
        const { total, new7d, overdueUnclosed, dueWithin7dUnclosed } = kpi.memo;
        if (total !== undefined) parts.push(`总计: ${total}`);
        if (overdueUnclosed != null && overdueUnclosed > 0) parts.push(`逾期未关: ${overdueUnclosed}`);
        if (dueWithin7dUnclosed != null && dueWithin7dUnclosed > 0) parts.push(`7日内待处理: ${dueWithin7dUnclosed}`);
        if (new7d > 0) parts.push(`近7天新增: ${new7d}`);
      }

      if (kpi.schedule) {
        const { scheduledHoursNext7d, expectedUnclosedCount } = kpi.schedule;
        if (scheduledHoursNext7d > 0) parts.push(`7天内排程: ${scheduledHoursNext7d.toFixed(1)}h`);
        if (expectedUnclosedCount > 0) parts.push(`逾期未结束: ${expectedUnclosedCount}`);
      }
      
      // Checkin KPI
      if (kpi.checkin) {
        const { todayDone, todayTotal, streak } = kpi.checkin;
        if (todayTotal > 0) parts.push(`今日: ${todayDone}/${todayTotal}`);
        if (streak > 0) parts.push(`连续: ${streak}天`);
      }
      
      // Finance KPI
      if (kpi.finance) {
        const { mtdSpend, mtdNet } = kpi.finance;
        if (mtdSpend !== undefined && mtdSpend !== 0) parts.push(`本月支出: ¥${mtdSpend.toFixed(2)}`);
        if (mtdNet !== undefined) parts.push(`本月净额: ¥${mtdNet.toFixed(2)}`);
      }
      
      // Project KPI
      if (kpi.project) {
        const { activeProjects, dueNext14d, overdue } = kpi.project;
        if (activeProjects !== undefined) parts.push(`进行中: ${activeProjects}`);
        if (overdue !== undefined && overdue > 0) parts.push(`超期: ${overdue}`);
        if (dueNext14d > 0) parts.push(`14天内到期: ${dueNext14d}`);
      }
      
      // Output KPI
      if (kpi.output) {
        const { generatedThisWeek, staleCount } = kpi.output;
        if (generatedThisWeek !== undefined) parts.push(`本周: ${generatedThisWeek}`);
        if (staleCount !== undefined && staleCount > 0) parts.push(`超过30天未完成: ${staleCount}`);
      }
      
      // Contacts KPI
      if (kpi.contacts) {
        const { touched30d, upcoming30d } = kpi.contacts;
        if (touched30d > 0) parts.push(`30天接触: ${touched30d}`);
        if (upcoming30d > 0) parts.push(`30天将到: ${upcoming30d}`);
      }
      
    }

    return parts.join(" · ") || "暂无数据";
  }

  /**
   * 检查模块是否启用（按空间区分）
   * 优先从空间的 settingsSnapshot 中读取，如果没有则使用全局设置
   */
  private isModuleEnabledInSpace(moduleKey: string, spaceId?: string): boolean {
    try {
      if ((this.plugin as any).isPluginEnvInitModuleGateOpen?.() !== true) return false;
      // 如果提供了 spaceId，从对应空间的配置中读取
      if (spaceId) {
        const spaceConfig = this.plugin.getSpaceConfig(spaceId);
        if (spaceConfig?.settingsSnapshot) {
          const spaceSettings = spaceConfig.settingsSnapshot as any;
          
          // 检查空间的 moduleEnabledV2
          const v2 = spaceSettings?.moduleEnabledV2;
          if (v2) {
            // 首先检查直接对应的键
            if (typeof v2[moduleKey] === "boolean") {
              return v2[moduleKey];
            }
            
            // 对于特殊模块，检查对应的字段
            if (moduleKey === "finance" && typeof v2.finance === "boolean") {
              return v2.finance;
            }
            if (moduleKey === "checkin" && typeof v2.checkin === "boolean") {
              return v2.checkin;
            }
            if (moduleKey === "contacts" && typeof v2.contacts === "boolean") {
              return v2.contacts;
            }
          }
          
          // 检查空间的 moduleEnabled（旧版本）
          const old = spaceSettings?.moduleEnabled;
          if (old) {
            const oldKeyMap: Record<string, string> = {
              task: "task",
              memo: "task",
              checkin: "record",
              finance: "record",
              project: "project",
              output: "output",
            };
            const oldKey = oldKeyMap[moduleKey] || moduleKey;
            if (typeof old[oldKey] === "boolean") {
              return old[oldKey];
            }
          }
        }
      }
      
      // 如果没有空间配置或空间配置中没有设置，使用全局设置
      // 优先使用插件提供的检查方法（更准确）
      if ((this.plugin as any).isPipelineModuleEnabled) {
        return (this.plugin as any).isPipelineModuleEnabled(moduleKey);
      }
      
      // Fallback: 直接从全局设置中检查
      const s: any = this.plugin.settings as any;
      const v2 = s?.moduleEnabledV2;
      if (v2 && typeof v2[moduleKey] === "boolean") {
        return v2[moduleKey];
      }
      
      // 对于特定模块，使用专门的检查方法（这些方法检查全局设置）
      // 注意：这些方法只检查全局设置，不检查空间配置，所以放在最后作为兜底
      if (moduleKey === "finance") {
        return (this.plugin as any).isFinanceModuleEnabled?.() ?? false;
      }
      
      if (moduleKey === "contacts") {
        return (this.plugin as any).isContactsModuleEnabledV2?.() ?? false;
      }

      // 检查旧版本的模块启用设置（moduleEnabled）
      const old = s?.moduleEnabled;
      // 模块键映射（旧版本）
      const oldKeyMap: Record<string, string> = {
        task: "task",
        memo: "task", // memo 和 task 共用同一个启用开关（旧版本）
        checkin: "record", // checkin 属于 record 模块
        finance: "record", // finance 属于 record 模块
        project: "project",
        output: "output",
      };
      const oldKey = oldKeyMap[moduleKey] || moduleKey;
      if (old && typeof old[oldKey] === "boolean") {
        return old[oldKey];
      }

      // 默认启用（向后兼容）
      return true;
    } catch (e) {
      console.warn(`[RSLatte][Hub] Error checking if module ${moduleKey} is enabled for space ${spaceId}:`, e);
      return true; // 出错时默认启用，避免影响现有功能
    }
  }

  private listEnabledHubModules(spaceId: string): string[] {
    const enabled: string[] = [];
    for (const key of HUB_CARD_MODULE_KEYS) {
      try {
        if (this.isModuleEnabledInSpace(key, spaceId)) enabled.push(key);
      } catch {
        // ignore
      }
    }
    return enabled;
  }

  /** 读取并必要时补全 space.json（与原先卡片内逻辑一致） */
  private async loadStatsForHubSpace(space: { id: string; name?: string; settingsSnapshot?: unknown }, seq: number): Promise<{
    space: { id: string; name?: string; settingsSnapshot?: unknown };
    stats: RSLatteSpaceStatsFileV1 | null;
    diaryExists: boolean;
    journalSnapshot: HubJournalSnapshot;
  } | null> {
    if (seq !== this._renderSeq) return null;
    let stats = await this.readSpaceStats(space.id);
    let needsRefresh = !stats || !stats.modules || Object.keys(stats.modules).length === 0;
    if (!needsRefresh && stats && stats.modules) {
      const enabledModules = this.listEnabledHubModules(space.id);
      for (const key of enabledModules) {
        if (!stats.modules[key]) {
          if (this.plugin.isDebugLogEnabled()) {
            console.log(`[RSLatte][Hub][DEBUG] Module ${key} is enabled but missing in stats file for space ${space.id}`);
          }
          needsRefresh = true;
          break;
        }
      }
    }
    if (needsRefresh) {
      try {
        const ctx = this.plugin.getSpaceCtx(space.id);
        const statsService = new SpaceStatsService(this.plugin);
        const enabledModules = this.listEnabledHubModules(space.id);
        if (enabledModules.length === 0) {
          if (this.plugin.isDebugLogEnabled()) {
            console.log(`[RSLatte][Hub] All modules disabled for space ${space.id}, skipping refresh to avoid infinite loop`);
          }
          stats = {
            schema_version: 1,
            updated_at: new Date().toISOString(),
            vault_id: ctx.vaultId,
            space_id: ctx.spaceId,
            modules: {},
            agg: { pending_total: 0, failed_total: 0, modules_enabled: 0 },
          };
        } else {
          await statsService.refreshSpaceStats(ctx, enabledModules as any);
          stats = await this.readSpaceStats(space.id);
        }
      } catch (e) {
        console.warn(`[RSLatte][Hub] Failed to refresh stats for space ${space.id}:`, e);
      }
    }
    const journalSnapshot = await computeHubJournalSnapshot(this.plugin, space);
    const diaryExists = journalSnapshot.fileExists;
    return { space, stats, diaryExists, journalSnapshot };
  }

  /** 切换空间告警页签（供卡片定位与页签点击共用） */
  private activateHubAlertTabForSpace(spaceId: string): void {
    const root = this.containerEl.children[1];
    if (!root) return;
    const tabsRow = root.querySelector(".rslatte-hub-alert-tabs");
    const panelsWrap = root.querySelector(".rslatte-hub-alert-panels");
    if (!tabsRow || !panelsWrap) return;
    for (const t of tabsRow.querySelectorAll(".rslatte-hub-alert-tab")) {
      const el = t as HTMLElement;
      if (el.dataset.rslatteHubAlertTabSpace === spaceId) el.addClass("rslatte-hub-alert-tab--active");
      else el.removeClass("rslatte-hub-alert-tab--active");
    }
    for (const p of panelsWrap.querySelectorAll(".rslatte-hub-alert-panel")) {
      const el = p as HTMLElement;
      if (el.dataset.rslatteHubAlertPanelSpace === spaceId) el.addClass("rslatte-hub-alert-panel--active");
      else el.removeClass("rslatte-hub-alert-panel--active");
    }
  }

  /** 当前空间页签下：全部展开 / 全部折叠模块告警子清单 */
  private setHubAlertModulesOpenAll(open: boolean): void {
    const root = this.containerEl.children[1];
    if (!root) return;
    const active = root.querySelector(".rslatte-hub-alert-panel--active") as HTMLElement | null;
    if (!active) return;
    for (const d of active.querySelectorAll(".rslatte-hub-alert-module")) {
      (d as HTMLDetailsElement).open = open;
    }
  }

  private fillHubAlertsSection(section: HTMLElement, rows: HubAlertInputRow[]): void {
    section.empty();
    const alerts = buildHubFlatAlerts(rows);
    section.createDiv({ cls: "rslatte-hub-alerts-title", text: "空间告警" });
    if (rows.length === 0) {
      section.createDiv({ cls: "rslatte-hub-alerts-empty rslatte-muted", text: "暂无空间" });
      return;
    }
    const spaceOrder = [...rows].sort((a, b) => (a.isCurrent === b.isCurrent ? 0 : a.isCurrent ? -1 : 1));
    const uniqueRows: HubAlertInputRow[] = [];
    const seen = new Set<string>();
    for (const r of spaceOrder) {
      if (seen.has(r.spaceId)) continue;
      seen.add(r.spaceId);
      uniqueRows.push(r);
    }
    const curSpaceId = this.plugin.getCurrentSpaceId();
    const idSet = new Set(uniqueRows.map((r) => r.spaceId));
    const defaultTabSpaceId = idSet.has(curSpaceId) ? curSpaceId : uniqueRows[0]!.spaceId;

    const tabsRow = section.createDiv({ cls: "rslatte-hub-alert-tabs" });
    const toolbar = section.createDiv({ cls: "rslatte-hub-alert-toolbar" });
    const btnExpandAll = toolbar.createEl("button", {
      cls: "rslatte-hub-alert-bulk-btn",
      type: "button",
      text: "全部展开",
    });
    btnExpandAll.title = "展开当前空间页签下所有模块清单";
    btnExpandAll.onclick = () => this.setHubAlertModulesOpenAll(true);
    const btnCollapseAll = toolbar.createEl("button", {
      cls: "rslatte-hub-alert-bulk-btn",
      type: "button",
      text: "全部折叠",
    });
    btnCollapseAll.title = "折叠当前空间页签下所有模块清单";
    btnCollapseAll.onclick = () => this.setHubAlertModulesOpenAll(false);
    const panelsWrap = section.createDiv({ cls: "rslatte-hub-alert-panels" });

    for (const r of uniqueRows) {
      const tab = tabsRow.createEl("button", {
        cls: "rslatte-hub-alert-tab",
        type: "button",
        text: r.spaceName || r.spaceId,
      });
      tab.dataset.rslatteHubAlertTabSpace = r.spaceId;
      if (r.spaceId === defaultTabSpaceId) tab.addClass("rslatte-hub-alert-tab--active");
      if (r.isCurrent) tab.addClass("rslatte-hub-alert-tab--current-space");

      const panel = panelsWrap.createDiv({ cls: "rslatte-hub-alert-panel" });
      panel.dataset.rslatteHubAlertPanelSpace = r.spaceId;
      if (r.spaceId === defaultTabSpaceId) panel.addClass("rslatte-hub-alert-panel--active");

      const body = panel.createDiv({ cls: "rslatte-hub-alert-panel-body" });
      const st = r.stats;
      if (st?.agg && ((st.agg.pending_total ?? 0) > 0 || (st.agg.failed_total ?? 0) > 0)) {
        const aggEl = body.createDiv({ cls: "rslatte-hub-alert-agg rslatte-muted" });
        const bits: string[] = [];
        if ((st.agg.pending_total ?? 0) > 0) bits.push(`待同步 ${st.agg.pending_total}`);
        if ((st.agg.failed_total ?? 0) > 0) bits.push(`同步失败 ${st.agg.failed_total}`);
        aggEl.setText(bits.join(" · "));
      }

      const appendModuleAlertDetails = (
        moduleKey: string,
        summaryText: string,
        modAlerts: { text: string }[],
        dedupeAgainst?: string
      ) => {
        const modDet = body.createEl("details", { cls: "rslatte-hub-alert-module" });
        modDet.dataset.rslatteAlertSpace = r.spaceId;
        modDet.dataset.rslatteAlertModule = moduleKey;
        const sum = modDet.createEl("summary", { cls: "rslatte-hub-alert-module-summary" });
        sum.createSpan({ cls: "rslatte-hub-alert-module-label", text: this.getModuleLabel(moduleKey) });
        const btn = sum.createEl("button", {
          cls: "rslatte-hub-alert-open-sidebar",
          text: "侧栏",
          type: "button",
        });
        btn.title = "打开对应模块侧栏（需当前空间）";
        btn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.openHubModuleRow(r.spaceId, moduleKey);
        };
        const modBody = modDet.createDiv({ cls: "rslatte-hub-alert-module-body" });
        modBody.createDiv({ cls: "rslatte-hub-alert-kpi", text: summaryText });
        const extra = dedupeAgainst
          ? modAlerts.filter((a) => a.text !== dedupeAgainst)
          : modAlerts;
        for (const item of extra) {
          modBody.createDiv({ cls: "rslatte-hub-alert-line", text: item.text });
        }
      };

      for (const moduleKey of HUB_CARD_MODULE_KEYS) {
        const entry = st?.modules?.[moduleKey] as RSLatteSpaceStatsModuleEntryV1 | undefined;
        const isEnabled = this.isModuleEnabledInSpace(moduleKey, r.spaceId);
        if (!isEnabled && !entry) continue;
        const modLabel = this.getModuleLabel(moduleKey);
        let summaryText: string;
        if (!isEnabled) summaryText = "模块已关闭";
        else if (entry) summaryText = this.formatHubModuleStatsText(moduleKey, entry);
        else summaryText = "暂无数据";
        const modAlerts = alerts.filter((a) => a.spaceId === r.spaceId && a.moduleKey === moduleKey);
        const primaryKpi =
          isEnabled && entry ? StatusCalculationService.hubPrimaryKpiLine(moduleKey, entry.kpi) : "";
        const dedupeKey = primaryKpi ? `${modLabel}：${primaryKpi}` : "";
        appendModuleAlertDetails(moduleKey, summaryText, modAlerts, dedupeKey || undefined);
      }

      {
        const modKey = "journal";
        const js = r.journalSnapshot;
        let summaryText: string;
        if (!js?.fileExists) summaryText = "今日日记未创建";
        else if (js.meaningfulChars > HUB_JOURNAL_MEANINGFUL_OK_THRESHOLD) {
          summaryText = `今日日记已达标（有效字>${HUB_JOURNAL_MEANINGFUL_OK_THRESHOLD}）`;
        } else if (js.meaningfulChars > 0) {
          summaryText = `今日日记有效字 ${js.meaningfulChars}（未达 ${HUB_JOURNAL_MEANINGFUL_OK_THRESHOLD}）`;
        } else {
          summaryText = "今日日记无实质内容";
        }
        const modAlerts = alerts.filter((a) => a.spaceId === r.spaceId && a.moduleKey === modKey);
        const dedupeKey = !js?.fileExists ? "今日日记未创建" : "";
        appendModuleAlertDetails(modKey, summaryText, modAlerts, dedupeKey || undefined);
      }
    }

    for (const tab of tabsRow.querySelectorAll(".rslatte-hub-alert-tab")) {
      const btn = tab as HTMLButtonElement;
      btn.onclick = () => {
        const sid = btn.dataset.rslatteHubAlertTabSpace;
        if (sid) this.activateHubAlertTabForSpace(sid);
      };
    }
  }

  /** 按空间预读财务/健康分析告警索引，写入 `hubInputRows`（供 `buildHubFlatAlerts` 追加条目） */
  private async enrichHubInputRowsWithAnalysisIndices(rows: HubAlertInputRow[]): Promise<void> {
    await Promise.all(
      rows.map(async (r) => {
        try {
          if (r.enabledModules.includes("finance")) {
            const idx = await readFinanceAnalysisAlertIndex(this.plugin, r.spaceId);
            if (idx?.status === "missing_data" && idx.missingData?.length) {
              r.financeAnalysisExtras = idx.missingData.slice(0, 4).map((m) => {
                const d = String(m.detail ?? "").trim();
                const short = d.length > 100 ? `${d.slice(0, 100)}…` : d;
                return short ? `${m.title}：${short}` : m.title;
              });
            }
          }
          if (r.enabledModules.includes("health")) {
            const idx = await readHealthAnalysisAlertIndex(this.plugin, r.spaceId);
            if (idx?.status === "missing_data" && idx.missingData?.length) {
              r.healthAnalysisExtras = idx.missingData.slice(0, 4).map((m) => {
                const d = String(m.detail ?? "").trim();
                const short = d.length > 100 ? `${d.slice(0, 100)}…` : d;
                return short ? `${m.title}：${short}` : m.title;
              });
            }
          }
        } catch (e) {
          console.warn(`[RSLatte][Hub] enrichHubInputRowsWithAnalysisIndices failed space=${r.spaceId}`, e);
        }
      })
    );
  }

  /** 切换到对应空间页签、仅展开目标模块子清单（同面板内其余模块先折叠）并滚到该 `<details>` */
  private scrollHubAlertIntoView(spaceId: string, moduleKey: string): void {
    const root = this.containerEl.children[1];
    if (!root) return;
    this.activateHubAlertTabForSpace(spaceId);
    const panel = root.querySelector(
      `.rslatte-hub-alert-panel[data-rslatte-hub-alert-panel-space="${spaceId}"]`
    ) as HTMLElement | null;
    const sel = `.rslatte-hub-alert-module[data-rslatte-alert-space="${spaceId}"][data-rslatte-alert-module="${moduleKey}"]`;
    const scope = panel ?? root;
    const el = scope.querySelector(sel) as HTMLElement | null;
    if (!el) {
      new Notice("当前无对应告警模块");
      return;
    }
    const collapseHost = (panel ?? el.closest(".rslatte-hub-alert-panel")) as HTMLElement | null;
    if (collapseHost) {
      for (const d of collapseHost.querySelectorAll(".rslatte-hub-alert-module")) {
        (d as HTMLDetailsElement).open = false;
      }
    }
    (el as HTMLDetailsElement).open = true;
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    el.addClass("rslatte-hub-alert-module--flash");
    window.setTimeout(() => el.removeClass("rslatte-hub-alert-module--flash"), 1200);
  }

  /** 整行点击：打开对应侧栏（非当前空间先 Notice） */
  private openHubModuleRow(spaceId: string, moduleKey: string): void {
    const cur = this.plugin.getCurrentSpaceId();
    if (spaceId !== cur) {
      new Notice("请先切换到该空间后再从工作台打开侧栏模块");
      return;
    }
    const p = this.plugin as any;
    switch (moduleKey) {
      case "journal":
        void p.activateRSLatteView?.({ inspectSection: "journal" });
        break;
      case "task":
        void p.activateTaskView?.({ subTab: "task" });
        break;
      case "memo":
        void p.activateTaskView?.({ subTab: "memo" });
        break;
      case "schedule":
        void p.activateTaskView?.({ subTab: "schedule" });
        break;
      case "checkin":
        void p.activateCheckinView?.();
        break;
      case "finance":
        void p.activateFinanceView?.();
        break;
      case "health":
        void p.activateHealthView?.();
        break;
      case "project":
        void p.activateProjectView?.();
        break;
      case "output":
        void p.activateOutputView?.();
        break;
      case "contacts":
        void p.activateContactsView?.();
        break;
      default:
        break;
    }
  }

  private formatHubModuleStatsText(moduleKey: string, entry: RSLatteSpaceStatsModuleEntryV1): string {
    const primary = StatusCalculationService.hubPrimaryKpiLine(moduleKey, entry.kpi);
    if (primary) return primary;
    return this.formatModuleStats(entry);
  }

  private appendHubSpaceCard(
    grid: HTMLElement,
    pack: { space: any; stats: RSLatteSpaceStatsFileV1 | null; diaryExists: boolean; journalSnapshot: HubJournalSnapshot },
    curSpaceId: string,
    seq: number
  ): void {
    if (seq !== this._renderSeq) return;
    const { space, stats, journalSnapshot } = pack;
    if (this.plugin.isDebugLogEnabled()) {
      console.log(`[RSLatte][Hub][DEBUG] Rendering space: id=${space.id}, name=${space.name}`);
    }
    const card = grid.createDiv({ cls: "rslatte-hub-card" });
    if (space.id === curSpaceId) card.addClass("rslatte-hub-card-active");

    const top = card.createDiv({ cls: "rslatte-hub-card-top" });
    top.createDiv({ cls: "rslatte-hub-card-title", text: space.name || space.id });
    const topRight = top.createDiv({ cls: "rslatte-hub-card-top-right" });
    if (space.id === curSpaceId) {
      const btnCurrent = topRight.createEl("button", { text: "当前", cls: "rslatte-hub-card-current-btn" });
      btnCurrent.addClass("rslatte-hub-card-current");
    } else {
      const btnSwitchCard = topRight.createEl("button", { text: "切换到此空间", cls: "rslatte-hub-card-switch-btn" });
      btnSwitchCard.onclick = () => {
        void ((this.plugin as any).switchSpace?.(space.id, { source: "hub" }) ?? Promise.resolve());
      };
    }

    const modulesList = card.createDiv({ cls: "rslatte-hub-card-modules rslatte-hub-modules-compact" });

    const attachChipClick = (chip: HTMLElement, moduleKey: string, isEnabled: boolean) => {
      chip.addClass("rslatte-hub-mod-chip--actionable");
      chip.title = isEnabled
        ? "单击定位下方空间告警中该模块；Alt+单击打开侧栏"
        : "单击定位下方空间告警（模块已关闭）；Alt+单击不可用";
      chip.onclick = (ev: MouseEvent) => {
        if (ev.altKey && isEnabled) {
          ev.preventDefault();
          ev.stopPropagation();
          this.openHubModuleRow(space.id, moduleKey);
          return;
        }
        this.scrollHubAlertIntoView(space.id, moduleKey);
      };
    };

    for (const moduleKey of HUB_CARD_MODULE_KEYS) {
      const entry = stats?.modules?.[moduleKey] as RSLatteSpaceStatsModuleEntryV1 | undefined;
      const isEnabled = this.isModuleEnabledInSpace(moduleKey, space.id);
      if (this.plugin.isDebugLogEnabled() && moduleKey === "finance") {
        console.log(`[RSLatte][Hub][DEBUG] Module ${moduleKey} in space ${space.id}: isEnabled=${isEnabled}, hasEntry=${!!entry}`);
      }
      if (!isEnabled && !entry) continue;

      const displayEntry: RSLatteSpaceStatsModuleEntryV1 = entry || {
        updated_at: "",
        module_key: moduleKey as any,
        sync_status: "off",
        pending_count: 0,
        failed_count: 0,
        counts: {},
        kpi: {},
      };
      const syncStatus = (displayEntry.sync_status || "unknown") as RSLatteSpaceStatsSyncStatus;
      const contentLevel = isEnabled ? StatusCalculationService.hubContentLevel(moduleKey, displayEntry.kpi) : 2;
      const contentEmoji = isEnabled ? StatusCalculationService.hubContentEmojiFromLevel(contentLevel) : "🟠";
      const syncEmoji = StatusCalculationService.hubSyncEmoji(syncStatus);

      const chip = modulesList.createDiv({ cls: "rslatte-hub-mod-chip" });
      chip.dataset.rslatteHubRowSpace = space.id;
      chip.dataset.rslatteHubRowModule = moduleKey;
      attachChipClick(chip, moduleKey, isEnabled);

      const contentLight = chip.createSpan({ cls: "rslatte-hub-light rslatte-hub-light--content", text: contentEmoji });
      contentLight.title = isEnabled
        ? StatusCalculationService.hubContentTooltip(moduleKey, displayEntry.kpi, contentLevel)
        : "模块未启用";
      contentLight.setAttribute("aria-label", contentLight.title);

      chip.createSpan({ cls: "rslatte-hub-mod-chip-name", text: this.getModuleLabel(moduleKey) });

      const syncLight = chip.createSpan({ cls: "rslatte-hub-light rslatte-hub-light--sync", text: syncEmoji });
      syncLight.title = StatusCalculationService.hubSyncTooltip(syncStatus, displayEntry);
      syncLight.setAttribute("aria-label", syncLight.title);
    }

    {
      const chip = modulesList.createDiv({
        cls: "rslatte-hub-mod-chip rslatte-hub-mod-chip--journal rslatte-hub-mod-chip--actionable",
      });
      chip.dataset.rslatteHubRowSpace = space.id;
      chip.dataset.rslatteHubRowModule = "journal";
      chip.title = "单击定位下方「日记」告警；Alt+单击打开今日打卡·日记";
      chip.onclick = (ev: MouseEvent) => {
        if (ev.altKey) {
          ev.preventDefault();
          ev.stopPropagation();
          this.openHubModuleRow(space.id, "journal");
          return;
        }
        this.scrollHubAlertIntoView(space.id, "journal");
      };
      const jLevel = hubJournalContentLevel(journalSnapshot);
      const journalEmoji = journalSnapshot.fileExists
        ? StatusCalculationService.hubContentEmojiFromLevel(jLevel)
        : "⚪";
      const journalIcon = chip.createSpan({
        cls: "rslatte-hub-light rslatte-hub-light--content rslatte-hub-light--journal",
        text: journalEmoji,
      });
      journalIcon.title = !journalSnapshot.fileExists
        ? "今日日记未创建"
        : journalSnapshot.meaningfulChars > HUB_JOURNAL_MEANINGFUL_OK_THRESHOLD
          ? `今日日记有效字 ${journalSnapshot.meaningfulChars}（已达标）`
          : journalSnapshot.meaningfulChars > 0
            ? `今日日记有效字 ${journalSnapshot.meaningfulChars}（未达 ${HUB_JOURNAL_MEANINGFUL_OK_THRESHOLD}）`
            : "今日日记无实质内容";
      journalIcon.setAttribute("aria-label", journalIcon.title);
      chip.createSpan({ cls: "rslatte-hub-mod-chip-name", text: this.getModuleLabel("journal") });
    }
  }

  private async render() {
    const seq = ++this._renderSeq;

    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("rslatte-hub");

    const header = container.createDiv({ cls: "rslatte-hub-header" });
    const titleWrap = header.createDiv({ cls: "rslatte-hub-title-wrap" });
    titleWrap.createDiv({ cls: "rslatte-hub-title", text: "RSLatte工作台" });
    titleWrap.createDiv({ cls: "rslatte-hub-subtitle rslatte-muted", text: "空间与工作流入口" });
    const headerRight = header.createDiv({ cls: "rslatte-hub-header-right" });
    const curSpaceId = this.plugin.getCurrentSpaceId();
    const curSpaceConfig = this.plugin.getSpaceConfig(curSpaceId);
    const curName = curSpaceConfig?.name ?? curSpaceId;
    headerRight.createSpan({ cls: "rslatte-hub-sub", text: `当前：${curName}` });

    const btnRefresh = headerRight.createEl("button", { text: "全部刷新" });
    btnRefresh.addClass("mod-cta");
    btnRefresh.title = "并行刷新所有空间中已启用模块的 space.json（强制从队列取数）";
    btnRefresh.onclick = () => this.refresh();

    const btnSwitch = headerRight.createEl("button", { text: "切换空间" });
    btnSwitch.onclick = () => this.plugin.openSpaceSwitcher();

    const workflowSection = container.createDiv({ cls: "rslatte-hub-workflow" });
    workflowSection.createDiv({ cls: "rslatte-hub-workflow-title", text: "工作流" });
    const workflowBtns = workflowSection.createDiv({ cls: "rslatte-hub-workflow-btns" });
    const btnCalendar = workflowBtns.createEl("button", {
      text: "日程日历",
      cls: "rslatte-hub-workflow-btn",
    });
    btnCalendar.title = "打开日程日历侧栏";
    btnCalendar.onclick = () => void this.plugin.activateCalendarView();
    const btnTodayInspect = workflowBtns.createEl("button", {
      text: "今日打卡",
      cls: "rslatte-hub-workflow-btn",
    });
    btnTodayInspect.title = "打开今日打卡侧栏（打卡、财务、健康、日记等）";
    btnTodayInspect.onclick = () => void this.plugin.activateRSLatteView();
    for (const id of WORKFLOW_VIEW_IDS) {
      const btn = workflowBtns.createEl("button", {
        text: WORKFLOW_VIEW_LABELS[id],
        cls: "rslatte-hub-workflow-btn",
      });
      btn.onclick = () => {
        void (this.plugin as any).activateWorkflowView?.(id as WorkflowViewId);
      };
    }

    const grid = container.createDiv({ cls: "rslatte-hub-grid" });

    const spaces = ((this.plugin as any).listSpaces?.() ?? []) as any[];

    if (seq !== this._renderSeq) return;

    if (spaces.length === 0) {
      const empty = grid.createDiv({ cls: "rslatte-hub-empty" });
      empty.createDiv({ text: "未配置任何空间" });
      empty.createDiv({ cls: "rslatte-muted", text: "请在设置页的「空间管理」中创建空间" });
      const alertsEmpty = container.createDiv({ cls: "rslatte-hub-alerts" });
      this.fillHubAlertsSection(alertsEmpty, []);
      return;
    }

    const hubInputRows: HubAlertInputRow[] = [];
    const loadedPacks: Array<{
      space: any;
      stats: RSLatteSpaceStatsFileV1 | null;
      diaryExists: boolean;
      journalSnapshot: HubJournalSnapshot;
    }> = [];

    if (seq !== this._renderSeq) return;

    for (const space of spaces) {
      const pack = await this.loadStatsForHubSpace(space, seq);
      if (!pack) return;
      if (this.plugin.isDebugLogEnabled() && pack.stats?.modules) {
        const checkinStats = pack.stats.modules.checkin;
        const financeStats = pack.stats.modules.finance;
        if (checkinStats) console.log(`[RSLatte][Hub][DEBUG] Space ${space.id} (${space.name}) checkin stats:`, checkinStats.counts);
        if (financeStats) console.log(`[RSLatte][Hub][DEBUG] Space ${space.id} (${space.name}) finance stats:`, financeStats.counts);
      }
      loadedPacks.push(pack);
      hubInputRows.push({
        spaceId: space.id,
        spaceName: space.name || space.id,
        isCurrent: space.id === curSpaceId,
        diaryExists: pack.diaryExists,
        stats: pack.stats,
        enabledModules: this.listEnabledHubModules(space.id),
        journalSnapshot: pack.journalSnapshot,
      });
    }

    const curPackIdx = loadedPacks.findIndex((p) => p.space.id === curSpaceId);
    if (curPackIdx > 0) {
      const curPack = loadedPacks.splice(curPackIdx, 1)[0];
      if (curPack) loadedPacks.unshift(curPack);
    }

    if (seq !== this._renderSeq) return;

    await this.enrichHubInputRowsWithAnalysisIndices(hubInputRows);
    if (seq !== this._renderSeq) return;

    for (const pack of loadedPacks) {
      this.appendHubSpaceCard(grid, pack, curSpaceId, seq);
    }

    if (seq !== this._renderSeq) return;
    const alertsSection = container.createDiv({ cls: "rslatte-hub-alerts" });
    this.fillHubAlertsSection(alertsSection, hubInputRows);
  }
}
