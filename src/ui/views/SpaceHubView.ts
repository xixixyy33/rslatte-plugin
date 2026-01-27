import { ItemView, WorkspaceLeaf, normalizePath } from "obsidian";
import type RSLattePlugin from "../../main";
import { VIEW_TYPE_HUB } from "../../constants/viewTypes";
import type { RSLatteSpaceStatsFileV1, RSLatteSpaceStatsModuleEntryV1 } from "../../types/spaceStats";
import { resolveSpaceStatsDir } from "../../services/spaceContext";
import { SpaceStatsService } from "../../services/spaceStatsService";
import { RSLATTE_EVENT_DB_SYNC_STATUS_CHANGED, RSLATTE_EVENT_SPACE_STATS_UPDATED } from "../../constants/space";
import { StatusCalculationService } from "../../services/statusCalculationService";

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
  getDisplayText(): string { return "RSLatte Hub"; }
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
          const moduleKeys = ["task", "memo", "checkin", "finance", "project", "output", "contacts"];
          for (const key of moduleKeys) {
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
      memo: "备忘",
      checkin: "打卡",
      finance: "财务",
      project: "项目",
      output: "输出",
      contacts: "联系人",
      publish: "发布",
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
        const { total, new7d } = kpi.memo;
        if (total !== undefined) parts.push(`总计: ${total}`);
        if (new7d > 0) parts.push(`新${new7d}天: ${new7d}`);
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
      
      // Publish KPI
      if (kpi.publish) {
        const { publishedCount, unpublishedCount } = kpi.publish;
        if (publishedCount !== undefined) parts.push(`已发布: ${publishedCount}`);
        if (unpublishedCount !== undefined) parts.push(`未发布: ${unpublishedCount}`);
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
        return (this.plugin as any).isFinanceModuleEnabled?.() ?? true;
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

  private getModuleStatusIcon(moduleKey: string, entry: RSLatteSpaceStatsModuleEntryV1, spaceId?: string): string {
    // 检查模块是否启用
    const isEnabled = this.isModuleEnabledInSpace(moduleKey, spaceId);
    
    // 发布模块默认显示绿色（🟢），因为不支持数据库同步
    if (moduleKey === "publish" && isEnabled) {
      return "🟢";
    }
    
    // 使用统一的状态计算服务
    const syncStatus = entry.sync_status || "unknown";
    const businessStatus = StatusCalculationService.calculateBusinessStatus(moduleKey, entry.kpi);
    return StatusCalculationService.calculateStatusIcon(moduleKey, syncStatus, businessStatus, isEnabled);
  }

  /** 获取状态灯的含义说明 */
  private getModuleStatusTooltip(moduleKey: string, entry: RSLatteSpaceStatsModuleEntryV1, spaceId?: string): string {
    // 检查模块是否启用
    const isEnabled = this.isModuleEnabledInSpace(moduleKey, spaceId);
    
    // 发布模块特殊处理：显示已发布/未发布数量
    if (moduleKey === "publish" && isEnabled && entry.kpi?.publish) {
      const { publishedCount = 0, unpublishedCount = 0 } = entry.kpi.publish;
      return `已发布: ${publishedCount} · 未发布: ${unpublishedCount}`;
    }
    
    // 使用统一的状态计算服务
    const syncStatus = entry.sync_status || "unknown";
    const businessStatus = StatusCalculationService.calculateBusinessStatus(moduleKey, entry.kpi);
    return StatusCalculationService.calculateStatusText(moduleKey, syncStatus, businessStatus, entry, isEnabled);
  }

  private async render() {
    const seq = ++this._renderSeq;

    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("rslatte-hub");

    const header = container.createDiv({ cls: "rslatte-hub-header" });
    header.createDiv({ cls: "rslatte-hub-title", text: "RSLatte Hub" });
    
    const headerRight = header.createDiv({ cls: "rslatte-hub-header-right" });
    const curSpaceId = this.plugin.getCurrentSpaceId();
    const curSpaceConfig = this.plugin.getSpaceConfig(curSpaceId);
    const curName = curSpaceConfig?.name ?? curSpaceId;
    headerRight.createSpan({ cls: "rslatte-hub-sub", text: `当前：${curName}` });

    const btnRefresh = headerRight.createEl("button", { text: "刷新" });
    btnRefresh.addClass("mod-cta");
    btnRefresh.onclick = () => this.refresh();

    const btnSwitch = headerRight.createEl("button", { text: "切换空间" });
    btnSwitch.onclick = () => this.plugin.openSpaceSwitcher();

    const grid = container.createDiv({ cls: "rslatte-hub-grid" });

    // List all spaces
    const spaces = ((this.plugin as any).listSpaces?.() ?? []);

    if (seq !== this._renderSeq) return;

    if (spaces.length === 0) {
      const empty = grid.createDiv({ cls: "rslatte-hub-empty" });
      empty.createDiv({ text: "未配置任何空间" });
      empty.createDiv({ cls: "rslatte-muted", text: "请在设置页的「空间管理」中创建空间" });
      return;
    }

    // Create a card for each space with module statistics
    for (const space of spaces) {
      if (this.plugin.isDebugLogEnabled()) {
        console.log(`[RSLatte][Hub][DEBUG] Rendering space: id=${space.id}, name=${space.name}`);
      }
      const card = grid.createDiv({ cls: "rslatte-hub-card" });
      if (space.id === curSpaceId) {
        card.addClass("rslatte-hub-card-active");
      }

      const top = card.createDiv({ cls: "rslatte-hub-card-top" });
      top.createDiv({ cls: "rslatte-hub-card-title", text: space.name || space.id });
      
      // 右上角按钮区域
      const topRight = top.createDiv({ cls: "rslatte-hub-card-top-right" });
      
      if (space.id === curSpaceId) {
        // 当前空间：显示"当前"标记（按钮样式，白底绿字）
        const btnCurrent = topRight.createEl("button", { text: "当前", cls: "rslatte-hub-card-current-btn" });
        btnCurrent.addClass("rslatte-hub-card-current");
      } else {
        // 非当前空间：显示"切换到此空间"按钮
        const btnSwitch = topRight.createEl("button", { text: "切换到此空间", cls: "rslatte-hub-card-switch-btn" });
        btnSwitch.onclick = () => {
          void ((this.plugin as any).switchSpace?.(space.id, { source: "hub" }) ?? Promise.resolve());
        };
      }

      // Load statistics for this space
      let stats = await this.readSpaceStats(space.id);
      if (stats && stats.modules) {
        const checkinStats = stats.modules.checkin;
        const financeStats = stats.modules.finance;
        if (this.plugin.isDebugLogEnabled()) {
          if (checkinStats) {
            console.log(`[RSLatte][Hub][DEBUG] Space ${space.id} (${space.name}) checkin stats:`, checkinStats.counts);
          }
          if (financeStats) {
            console.log(`[RSLatte][Hub][DEBUG] Space ${space.id} (${space.name}) finance stats:`, financeStats.counts);
          }
        }
      }
      
      // 检查是否需要刷新统计数据
      // 1. 统计文件不存在
      // 2. 统计文件为空（没有模块数据）
      // 3. 统计文件中缺少启用的模块数据（数据不完整）
      let needsRefresh = !stats || !stats.modules || Object.keys(stats.modules).length === 0;
      
      if (!needsRefresh && stats && stats.modules) {
        // 检查是否所有启用的模块都有数据
        const enabledModules: string[] = [];
        const moduleKeys = ["task", "memo", "checkin", "finance", "project", "output", "contacts", "publish"];
        for (const key of moduleKeys) {
          try {
            // 使用统一的模块启用检查方法，传入 spaceId
            if (this.isModuleEnabledInSpace(key, space.id)) {
              enabledModules.push(key);
            }
          } catch {
            // ignore
          }
        }
        
        // 如果某个启用的模块在统计文件中没有数据，需要刷新
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
      
      // If no stats file exists or stats are incomplete, try to refresh stats from module files
      if (needsRefresh) {
        try {
          const ctx = this.plugin.getSpaceCtx(space.id);
          const statsService = new SpaceStatsService(this.plugin);
          // 获取所有启用的模块
          const enabledModules: string[] = [];
          const moduleKeys = ["task", "memo", "checkin", "finance", "project", "output", "contacts", "publish"];
          for (const key of moduleKeys) {
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
              console.log(`[RSLatte][Hub] All modules disabled for space ${space.id}, skipping refresh to avoid infinite loop`);
            }
            // 不刷新，直接使用空的统计数据
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
            // Re-read after refresh
            stats = await this.readSpaceStats(space.id);
          }
        } catch (e) {
          console.warn(`[RSLatte][Hub] Failed to refresh stats for space ${space.id}:`, e);
        }
      }
      
      // 对于发布模块，需要单独获取数据（因为发布模块不在 spaceStatsService 中处理）
      // 无论是否需要刷新其他模块，都要检查发布模块的数据
      if (this.isModuleEnabledInSpace("publish", space.id)) {
        try {
          // 如果 stats 还没有初始化，先初始化
          if (!stats) {
            const ctx = this.plugin.getSpaceCtx(space.id);
            stats = {
              schema_version: 1,
              updated_at: new Date().toISOString(),
              vault_id: ctx.vaultId,
              space_id: ctx.spaceId,
              modules: {},
              agg: { pending_total: 0, failed_total: 0, modules_enabled: 0 },
            };
          }
          
          // 检查是否需要更新发布模块的数据（如果数据不存在或已过期）
          const publishEntry = stats.modules?.publish;
          const needsUpdate = !publishEntry || 
            (publishEntry.updated_at && Date.now() - new Date(publishEntry.updated_at).getTime() > 30_000); // 30秒过期
          
          if (needsUpdate) {
            await this.plugin.publishRSLatte?.refreshIndexIfStale(30_000);
            const publishSnap = await this.plugin.publishRSLatte?.getSnapshot();
            if (publishSnap?.items) {
              const itemsAll = publishSnap.items as any[];
              const publishedCount = itemsAll.filter((it: any) => it.publishType && it.publishType.trim() !== "").length;
              const unpublishedCount = itemsAll.length - publishedCount;
              
              if (!stats.modules) stats.modules = {};
              
              // 创建或更新发布模块的统计数据
              stats.modules.publish = {
                updated_at: new Date().toISOString(),
                module_key: "publish",
                sync_status: "off", // 发布模块不支持数据库同步
                pending_count: 0,
                failed_count: 0,
                counts: {
                  total: itemsAll.length,
                  published: publishedCount,
                  unpublished: unpublishedCount,
                },
                kpi: {
                  publish: {
                    publishedCount,
                    unpublishedCount,
                  },
                },
              };
              
              // 保存统计数据到文件
              try {
                const statsPath = normalizePath(`${resolveSpaceStatsDir(this.plugin.settings, space.id)}/space.json`);
                const statsDir = normalizePath(statsPath.split("/").slice(0, -1).join("/"));
                
                // 确保目录存在（递归创建）
                if (statsDir) {
                  const parts = statsDir.split("/").filter(Boolean);
                  let cur = "";
                  for (const seg of parts) {
                    cur = cur ? `${cur}/${seg}` : seg;
                    try {
                      const exists = await this.app.vault.adapter.exists(cur);
                      if (!exists) {
                        await this.app.vault.createFolder(cur);
                      }
                    } catch (e: any) {
                      const msg = String(e?.message ?? e);
                      if (msg.includes("Folder already exists") || msg.includes("EEXIST")) continue;
                      // 继续尝试创建其他目录
                    }
                  }
                }
                
                // 写入文件
                const text = JSON.stringify(stats, null, 2);
                const fileExists = await this.app.vault.adapter.exists(statsPath);
                if (fileExists) {
                  await this.app.vault.adapter.write(statsPath, text);
                } else {
                  await this.app.vault.create(statsPath, text);
                }
              } catch (writeErr) {
                console.warn(`[RSLatte][Hub] Failed to save publish stats for space ${space.id}:`, writeErr);
              }
            }
          }
        } catch (e) {
          console.warn(`[RSLatte][Hub] Failed to get publish stats for space ${space.id}:`, e);
        }
      }
      
      // 显示所有模块（包括未启用的模块）
      const modulesList = card.createDiv({ cls: "rslatte-hub-card-modules" });
      
      // 日记状态行（显示在每个空间的最前面）
      {
        const todayKey = this.plugin.getTodayKey();
        const spaceSnapshot = space.settingsSnapshot as any;
        const spaceDiaryPath = spaceSnapshot?.diaryPath;
        const spaceDiaryNameFormat = spaceSnapshot?.diaryNameFormat;
        
        // 临时设置日记配置覆盖（按空间）
        const originalPathOverride = (this.plugin.journalSvc as any)._diaryPathOverride;
        const originalFormatOverride = (this.plugin.journalSvc as any)._diaryNameFormatOverride;
        try {
          this.plugin.journalSvc.setDiaryPathOverride(
            spaceDiaryPath || null,
            spaceDiaryNameFormat || null
          );
          
          // 检查今日日记是否存在
          const todayDiaryFile = this.plugin.journalSvc.findDiaryFileForDateKey(todayKey);
          const diaryExists = !!todayDiaryFile;
          
          const journalRow = modulesList.createDiv({ cls: "rslatte-hub-module-row" });
          const journalLeft = journalRow.createDiv({ cls: "rslatte-hub-module-left" });
          
          // 状态图标：未创建 → ⚪，已创建 → 🟢
          const journalIcon = journalLeft.createSpan({ 
            cls: "rslatte-hub-module-icon", 
            text: diaryExists ? "🟢" : "⚪"
          });
          journalIcon.title = diaryExists ? "今日日记已创建" : "今日日记未创建";
          journalIcon.setAttribute("aria-label", journalIcon.title);
          
          // 模块名称
          const journalNameContainer = journalLeft.createSpan({ cls: "rslatte-hub-module-name-container" });
          journalNameContainer.createSpan({ cls: "rslatte-hub-module-name", text: "日记" });
          
          // 右侧状态文本
          const journalRight = journalRow.createDiv({ cls: "rslatte-hub-module-right" });
          journalRight.createDiv({ 
            cls: "rslatte-hub-module-stats", 
            text: diaryExists ? "今日已创建" : "今日未创建"
          });
        } finally {
          // 恢复原始日记配置
          this.plugin.journalSvc.setDiaryPathOverride(originalPathOverride, originalFormatOverride);
        }
      }
      
      // 定义所有可能的模块键（按顺序）
      const allModuleKeys = ["checkin", "contacts", "finance", "memo", "output", "project", "publish", "task"];
      
      // 遍历所有可能的模块，确保即使统计文件中没有数据，未启用的模块也能显示
      for (const moduleKey of allModuleKeys) {
        const entry = stats?.modules?.[moduleKey] as RSLatteSpaceStatsModuleEntryV1 | undefined;
        const isEnabled = this.isModuleEnabledInSpace(moduleKey, space.id);
        
        // ✅ 调试日志：检查模块启用状态
        if (this.plugin.isDebugLogEnabled() && moduleKey === "finance") {
          console.log(`[RSLatte][Hub][DEBUG] Module ${moduleKey} in space ${space.id}: isEnabled=${isEnabled}, hasEntry=${!!entry}`);
        }
        
        // 如果模块启用但统计文件中没有数据，跳过（可能是数据还在生成中，避免显示空白）
        if (isEnabled && !entry) {
          continue;
        }

        const moduleRow = modulesList.createDiv({ cls: "rslatte-hub-module-row" });
        
        const moduleLeft = moduleRow.createDiv({ cls: "rslatte-hub-module-left" });
        
        // 创建状态图标（如果模块未启用，使用空 entry 但会显示灰色圆圈）
        const displayEntry: RSLatteSpaceStatsModuleEntryV1 = entry || {
          updated_at: "",
          module_key: moduleKey as any,
          sync_status: "off",
          pending_count: 0,
          failed_count: 0,
          counts: {},
          kpi: {},
        };
        
        const statusIcon = moduleLeft.createSpan({ 
          cls: "rslatte-hub-module-icon", 
          text: this.getModuleStatusIcon(moduleKey, displayEntry, space.id) 
        });
        // 添加 tooltip 说明状态灯含义（同时显示业务状态和同步状态）
        statusIcon.title = this.getModuleStatusTooltip(moduleKey, displayEntry, space.id);
        statusIcon.setAttribute("aria-label", this.getModuleStatusTooltip(moduleKey, displayEntry, space.id));
        
        // 模块名称和状态标记
        const moduleNameContainer = moduleLeft.createSpan({ cls: "rslatte-hub-module-name-container" });
        moduleNameContainer.createSpan({ cls: "rslatte-hub-module-name", text: this.getModuleLabel(moduleKey) });
        
        // 如果模块未启用，显示"模块已关闭"标记
        //if (!isEnabled) {
        //  const disabledTag = moduleNameContainer.createSpan({ 
        //    cls: "rslatte-hub-module-disabled-tag", 
        //    text: "（模块已关闭）" 
        //  });
        //  disabledTag.style.marginLeft = "4px";
        //  disabledTag.style.fontSize = "0.85em";
        //  disabledTag.style.color = "var(--text-muted)";
        //}

        const moduleRight = moduleRow.createDiv({ cls: "rslatte-hub-module-right" });
        
        // ✅ 如果模块未启用，无论是否有历史数据，都显示"模块已关闭"
        if (!isEnabled) {
          moduleRight.createDiv({ 
            cls: "rslatte-hub-module-stats", 
            text: "模块已关闭" 
          });
        } else if (entry) {
          // 模块已启用且有统计数据，显示统计数据
          moduleRight.createDiv({ 
            cls: "rslatte-hub-module-stats", 
            text: this.formatModuleStats(entry) 
          });
        } else {
          // 启用的模块但没有数据（不应该出现，但为了安全）
          moduleRight.createDiv({ 
            cls: "rslatte-hub-module-stats", 
            text: "暂无数据" 
          });
        }
      }
      
      // 显示聚合信息（仅当有统计数据时）
      if (stats && stats.modules && Object.keys(stats.modules).length > 0) {

        // Aggregate info
        if (stats.agg) {
          const { pending_total, failed_total } = stats.agg;
          if (pending_total > 0 || failed_total > 0) {
            const agg = card.createDiv({ cls: "rslatte-hub-card-agg" });
            if (pending_total > 0) agg.createSpan({ text: `待同步: ${pending_total}` });
            if (failed_total > 0) agg.createSpan({ text: `失败: ${failed_total}`, cls: "rslatte-hub-error" });
          }
        }
      } else {
        card.createDiv({ cls: "rslatte-muted", text: "暂无统计数据" });
      }
    }
  }
}
