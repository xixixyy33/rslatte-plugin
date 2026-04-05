/**
 * 核心插件功能模块
 * 包含设置保存、UI刷新、生命周期管理等核心方法
 */
import { Notice } from "obsidian";
import type RSLattePlugin from "../main";
import { VIEW_TYPE_RSLATTE, VIEW_TYPE_TASKS, VIEW_TYPE_PROJECTS, VIEW_TYPE_OUTPUTS, VIEW_TYPE_FINANCE, VIEW_TYPE_HEALTH, VIEW_TYPE_CHECKIN, VIEW_TYPE_CONTACTS, VIEW_TYPE_HUB, VIEW_TYPE_CAPTURE, VIEW_TYPE_TODAY, VIEW_TYPE_KNOWLEDGE, VIEW_TYPE_REVIEW } from "../constants/viewTypes";
import { RSLatteSidePanelView } from "../ui/views/RSLatteSidePanelView";
import { TaskSidePanelView } from "../ui/views/TaskSidePanelView";
import { ProjectSidePanelView } from "../ui/views/ProjectSidePanelView";
import { OutputSidePanelView } from "../ui/views/OutputSidePanelView";
import { FinanceSidePanelView } from "../ui/views/FinanceSidePanelView";
import { HealthSidePanelView } from "../ui/views/HealthSidePanelView";
import { CheckinSidePanelView } from "../ui/views/CheckinSidePanelView";
import { ContactsSidePanelView } from "../ui/views/ContactsSidePanelView";
import { SpaceHubView } from "../ui/views/SpaceHubView";
import { CaptureView } from "../ui/views/CaptureView";
import { TodayView } from "../ui/views/TodayView";
import { KnowledgeView } from "../ui/views/KnowledgeView";
import { ReviewView } from "../ui/views/ReviewView";
import { DEFAULT_SETTINGS } from "../constants/defaults";

export function createCore(plugin: RSLattePlugin) {
  // Private fields for refreshSidePanel debouncing
  let _refreshSidePanelTimer: number | null = null;
  let _refreshSidePanelPending = false;

  return {
    /**
     * v20+：侧边栏刷新合并（防抖）。
     * 
     * 策略：在一个微小窗口内合并刷新（默认 80ms），只执行一次真正的 refresh。
     */
    refreshSidePanel() {
      // ✅ trailing debounce：每次调用都重新计时
      // 目的：避免在一次"写索引/写文件"流程的早期就触发 UI refresh，导致侧边栏渲染到旧状态。
      _refreshSidePanelPending = true;
      if (_refreshSidePanelTimer != null) {
        window.clearTimeout(_refreshSidePanelTimer);
        _refreshSidePanelTimer = null;
      }
      _refreshSidePanelTimer = window.setTimeout(() => {
        _refreshSidePanelTimer = null;
        if (!_refreshSidePanelPending) return;
        _refreshSidePanelPending = false;
        (plugin as any)._refreshSidePanelNow();
      }, 80);
    },

    /**
     * 立即刷新所有侧边栏视图（内部方法）
     */
    _refreshSidePanelNow() {
      plugin.dbg("refresh", "refreshSidePanel");
      // v20+: 统一刷新多个侧边栏（若存在）
      for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_RSLATTE)) {
        const view = leaf.view;
        if (view instanceof RSLatteSidePanelView) view.refresh();
      }
      for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_TASKS)) {
        const view = leaf.view;
        if (view instanceof TaskSidePanelView) view.refresh();
      }
      for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_PROJECTS)) {
        const view = leaf.view;
        if (view instanceof ProjectSidePanelView) view.refresh();
      }
      for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_OUTPUTS)) {
        const view = leaf.view;
        if (view instanceof OutputSidePanelView) view.refresh();
      }
      for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_CONTACTS)) {
        const view = leaf.view;
        if (view instanceof ContactsSidePanelView) view.refresh();
      }
      for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_FINANCE)) {
        const view = leaf.view;
        if (view instanceof FinanceSidePanelView) view.refresh();
      }
      for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_HEALTH)) {
        const view = leaf.view;
        if (view instanceof HealthSidePanelView) view.refresh();
      }
      for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_CHECKIN)) {
        const view = leaf.view;
        if (view instanceof CheckinSidePanelView && typeof view.refresh === "function") {
          view.refresh();
        }
      }
      // 空间切换后项目数据依赖 projectMgr 刷新并触发 refreshSidePanel，此处一并刷新 Hub
      for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_HUB)) {
        const view = leaf.view;
        if (view instanceof SpaceHubView && typeof view.refresh === "function") view.refresh();
      }
      for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_CAPTURE)) {
        const view = leaf.view;
        if (view instanceof CaptureView && typeof view.refresh === "function") view.refresh();
      }
      for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_TODAY)) {
        const view = leaf.view;
        if (view instanceof TodayView && typeof view.refresh === "function") view.refresh();
      }
      for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_KNOWLEDGE)) {
        const view = leaf.view;
        if (view instanceof KnowledgeView && typeof view.refresh === "function") view.refresh();
      }
      for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_REVIEW)) {
        const view = leaf.view;
        if (view instanceof ReviewView && typeof view.refresh === "function") view.refresh();
      }
    },

    /** ===================== Settings façade ===================== */

    async saveSettings(): Promise<boolean> {
      // ✅ 额外校验：禁止复用"历史已删除条目"的 ID（tombstone）
      try {
        if (plugin.recordRSLatte) {
          const v = await plugin.recordRSLatte.validateListIdsNotInTombstones();
          if (!v.ok) {
            new Notice(v.message ?? "保存失败：ID 与历史已删除条目冲突");
            return false;
          }
        }
      } catch (e) {
        console.warn("RSLatte validateListIdsNotInTombstones failed", e);
      }

      // ✅ D9-6：模块关闭 => 强制关闭该模块的 DB sync / 自动归档（避免后台仍尝试同步/归档）
      // - 只在 moduleEnabledV2 显式为 false 时生效
      // - 不改变模块开启时的用户配置
      try {
        const sAny: any = plugin.settings as any;
        const me2: any = sAny?.moduleEnabledV2 ?? {};

        const forceOff = (k: string, paths: Array<[string, string]>) => {
          if (me2?.[k] !== false) return;
          for (const [objKey, field] of paths) {
            if (!sAny[objKey]) sAny[objKey] = {};
            if (sAny[objKey][field] === true) sAny[objKey][field] = false;
          }
        };

        // checkin / finance
        forceOff('checkin', [['checkinPanel', 'enableDbSync'], ['checkinPanel', 'autoArchiveEnabled']]);
        forceOff('finance', [['financePanel', 'enableDbSync'], ['financePanel', 'autoArchiveEnabled']]);

        // task / memo
        forceOff('task', [['taskModule', 'enableDbSync'], ['taskModule', 'autoArchiveEnabled']]);
        forceOff('memo', [['memoModule', 'enableDbSync'], ['memoModule', 'autoArchiveEnabled']]);

        // project / output
        if (me2?.project === false) {
          if (sAny.projectEnableDbSync === true) sAny.projectEnableDbSync = false;
          if (sAny.projectAutoArchiveEnabled === true) sAny.projectAutoArchiveEnabled = false;
        }
        if (me2?.output === false) {
          if (!sAny.outputPanel) sAny.outputPanel = {};
          if (sAny.outputPanel.enableDbSync === true) sAny.outputPanel.enableDbSync = false;
          if (sAny.outputPanel.autoArchiveEnabled === true) sAny.outputPanel.autoArchiveEnabled = false;
        }

        // legacy 聚合字段：避免 UI/旧逻辑出现"模块已关但聚合字段仍为 true"
        try {
          if (!sAny.checkinPanel) sAny.checkinPanel = {};
          if (!sAny.financePanel) sAny.financePanel = {};
          if (!sAny.taskModule) sAny.taskModule = {};
          if (!sAny.memoModule) sAny.memoModule = {};
          if (!sAny.taskPanel) sAny.taskPanel = {};

          sAny.rslattePanelEnableDbSync = (!!sAny.checkinPanel.enableDbSync) || (!!sAny.financePanel.enableDbSync);
          sAny.taskPanel.enableDbSync = (!!sAny.taskModule.enableDbSync) || (!!sAny.memoModule.enableDbSync);
        } catch {
          // ignore
        }
      } catch (e) {
        console.warn('[RSLatte] enforce module-disable policies failed:', e);
      }

      const ok = await (plugin as any).settingsSvc.save(plugin.settings);
      if (!ok) return false;

      // ✅ 打卡项清单/财务分类清单：落入中央索引（用于生命周期管理 + tombstone 维护）
      // moduleEnabled.record=false 时：侧边栏/索引生成机制停用，因此这里也跳过（避免后台仍写索引/触发 DB sync）。
      if (plugin.isPipelineModuleEnabled("checkin") || plugin.isPipelineModuleEnabled("finance")) {
        try {
          void plugin.recordRSLatte?.syncListsIndexFromSettings({ reason: "settings-save" });
        } catch (e) {
          console.warn("RSLatte syncListsIndexFromSettings failed:", e);
        }

        // ✅ 若开启 DB 同步：自动同步清单（替代设置页手动按钮）
        try {
          if ((plugin as any).isRSLatteDbSyncEnabled?.()) {
            const key = JSON.stringify({ c: plugin.settings.checkinItems ?? [], f: plugin.settings.financeCategories ?? [] });
            // 只有在内容变化后才触发一次
            if (key !== (plugin as any)._lastListsSyncKey) {
              (plugin as any)._debouncedSyncListsToDb?.();
            }
          }
        } catch (e) {
          console.warn("RSLatte schedule syncRecordListsToDb failed:", e);
        }
      }

      // ✅ Step4：设置变更后重置自动刷新 timer
      (plugin as any).setupAutoRefreshTimer?.();

      return true;
    },

    /** v26：迁移旧版 Refresh Interval (seconds) -> autoRefreshIndexIntervalMin (min) */
    async migrateRefreshIntervalToAutoRefreshIfNeeded(): Promise<void> {
      try {
        const s: any = plugin.settings as any;
        const defOld = Number((DEFAULT_SETTINGS as any)?.refreshInterval ?? 600);
        const defNew = Number((DEFAULT_SETTINGS as any)?.autoRefreshIndexIntervalMin ?? 30);

        const oldSec = Number(s.refreshInterval ?? defOld);
        const curMinRaw = (s as any).autoRefreshIndexIntervalMin;
        const curMin = Number(curMinRaw ?? defNew);

        // 只有在用户曾修改过旧 refreshInterval，且新字段未显式配置/仍为默认值时才迁移
        if (!Number.isFinite(oldSec) || oldSec <= 0) return;
        if (oldSec === defOld) return;
        if (curMinRaw !== undefined && curMin !== defNew) return;

        const migrated = Math.max(1, Math.ceil(oldSec / 60));
        (s as any).autoRefreshIndexIntervalMin = migrated;

        plugin.dbg("migration", "refreshInterval -> autoRefreshIndexIntervalMin", {
          oldSec,
          migrated,
        });
      } catch (e) {
        console.warn("RSLatte migrateRefreshIntervalToAutoRefreshIfNeeded failed", e);
      }
    },

    /**
     * 插件卸载时的清理工作
     * 注意：onunload 方法本身保留在 main.ts 中，这里只提供清理逻辑
     */
    cleanupOnUnload(): void {
      // Obsidian 会自动销毁 view；这里不做额外处理
      // best-effort: close popover if still open
      try { 
        (plugin as any).closeContactLinkPopover?.(); 
      } catch { }

      // best-effort: close work-event shard file handle (desktop)
      try { 
        void plugin.workEventSvc?.close(); 
      } catch { }
    },

    /**
     * 设置后端 DB 可用性状态
     * @param ready 后端是否可用
     * @param reason 原因（可选）
     */
    setBackendDbReady(ready: boolean, reason?: string): void {
      (plugin as any)._backendDbReady = ready;
      (plugin as any)._backendDbReason = String(reason ?? "");
      (plugin as any)._backendDbCheckedAt = Date.now();
    },

    /**
     * 获取后端 DB 可用性状态
     * @returns 返回 { ready, reason, checkedAt }
     */
    getBackendDbReady(): { ready: boolean | null; reason: string; checkedAt: number } {
      return {
        ready: (plugin as any)._backendDbReady ?? null,
        reason: String((plugin as any)._backendDbReason ?? ""),
        checkedAt: Number((plugin as any)._backendDbCheckedAt ?? 0),
      };
    },
  };
}
