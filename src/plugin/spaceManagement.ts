import { Notice } from "obsidian";
import { SpaceSwitcherModal } from "../ui/modals/SpaceSwitcherModal";
import type RSLattePlugin from "../main";
import { DEFAULT_SETTINGS } from "../constants/defaults";
import { DEFAULT_SPACE_ID, RSLATTE_EVENT_SPACE_CHANGED } from "../constants/space";
import {
  getCurrentSpaceId as getCurSpaceIdFromSettings,
  getSpaceConfig as getSpaceConfigFromSettings,
  buildSpaceCtx,
} from "../services/spaceContext";
import { applyPerSpaceSettings, extractPerSpaceSettings } from "../services/spaceSettings";
import { VIEW_TYPE_HUB, VIEW_TYPE_RSLATTE, VIEW_TYPE_TASKS, VIEW_TYPE_PROJECTS, VIEW_TYPE_OUTPUTS, VIEW_TYPE_PUBLISH, VIEW_TYPE_FINANCE, VIEW_TYPE_CONTACTS, VIEW_TYPE_DASHBOARD } from "../constants/viewTypes";
import type { RSLatteSpaceConfig } from "../types/space";

/**
 * Space 管理相关方法
 * 提供空间切换、列表、缓存管理等功能
 */
export function createSpaceManagement(plugin: RSLattePlugin) {
  return {
    // ===== Step F0: SpaceCtx helpers =====
    getCurrentSpaceId(): string {
      try {
        return getCurSpaceIdFromSettings(plugin.settings);
      } catch {
        return (plugin.settings?.currentSpaceId ?? DEFAULT_SPACE_ID) || DEFAULT_SPACE_ID;
      }
    },

    getSpaceConfig(spaceId?: string): RSLatteSpaceConfig {
      const sid = (spaceId || plugin.getCurrentSpaceId() || DEFAULT_SPACE_ID).trim() || DEFAULT_SPACE_ID;
      return getSpaceConfigFromSettings(plugin.settings, sid);
    },

    getSpaceCtx(spaceId?: string) {
      return buildSpaceCtx(plugin.settings, spaceId);
    },

    /** List all spaces in settings (sorted by name, then id). */
    listSpaces(): RSLatteSpaceConfig[] {
      const spacesMap: Record<string, RSLatteSpaceConfig> = (plugin.settings as any)?.spaces ?? {};
      const arr = Object.values(spacesMap)
        .filter(Boolean)
        .map((space) => {
          // 确保每个空间配置都有有效的名称
          const id = String(space?.id ?? "").trim();
          
          // 直接从原始对象读取 name，不要做任何修改
          // 如果 name 为空或未定义，保持原样（不在这里生成默认名称，让显示层处理）
          let name = space?.name;
          if (name !== undefined && name !== null) {
            name = String(name).trim();
          } else {
            name = "";
          }
          
          // 返回新对象，保留原始的 name（即使是空字符串）
          // 注意：不在这里生成默认名称，让 SpaceSwitcherModal 的 renderSuggestion 来处理
          return { 
            ...space, 
            id: id || space?.id || "", 
            name: name || ""  // 保留空字符串，不生成默认名称
          };
        });
      
      arr.sort((a, b) => {
        const an = String(a?.name ?? "").trim().toLowerCase();
        const bn = String(b?.name ?? "").trim().toLowerCase();
        if (an !== bn) return an.localeCompare(bn);
        return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
      });
      return arr;
    },

    /** Open the global space switcher modal. */
    openSpaceSwitcher(): void {
      try {
        const spaces = (plugin as any).listSpaces?.() ?? [];
        if (!spaces.length) {
          new Notice("未配置任何空间。请在设置页的「空间管理」中创建空间。");
          return;
        }
        new SpaceSwitcherModal(plugin.app, plugin, spaces).open();
      } catch (e) {
        console.warn("[RSLatte][space] openSpaceSwitcher failed", e);
        new Notice("打开空间切换器失败。");
      }
    },

    /**
     * Switch current space (global context).
     * - Persists settings via saveRaw to avoid being blocked by list validations.
     * - Emits a workspace event so all RSLatte views can react.
     */
    async switchSpace(spaceId: string, opts?: { source?: string }): Promise<void> {
      const sid = String(spaceId ?? "").trim();
      if (!sid) {
        new Notice("空间 UUID 为空，无法切换。");
        return;
      }

      const cur = plugin.getCurrentSpaceId();
      if (sid === cur) {
        const sp = plugin.getSpaceConfig(sid);
        new Notice(`已在空间：${String(sp?.name ?? sid)}`);
        return;
      }

      const spacesMap: Record<string, RSLatteSpaceConfig> = (plugin.settings as any)?.spaces ?? {};
      const target = spacesMap[sid];
      if (!target) {
        new Notice(`未找到空间：${sid}`);
        return;
      }

      try {
        // 1) persist current space snapshot
        try {
          const curSpace = spacesMap[cur];
          if (curSpace) {
            (plugin.settings as any).spaces[cur] = Object.assign({}, curSpace, {
              updatedAt: new Date().toISOString(),
              settingsSnapshot: extractPerSpaceSettings(plugin.settings),
            });
          }
        } catch {}

        // 2) switch currentSpaceId
        (plugin.settings as any).currentSpaceId = sid;

        // 3) apply target snapshot to global settings (space-scoped keys)
        try {
          const snap = (target as any)?.settingsSnapshot as any;
          applyPerSpaceSettings(plugin.settings, snap ?? {}, DEFAULT_SETTINGS as any);
        } catch (e) {
          console.warn("[RSLatte][space] applyPerSpaceSettings failed", e);
        }

        // 4) touch updatedAt
        try {
          (plugin.settings as any).spaces[sid] = Object.assign({}, target, { updatedAt: new Date().toISOString() });
        } catch {}

        // Persist settings via saveRaw to avoid list validations blocking space switch
        await (plugin as any).settingsSvc?.saveRaw?.(plugin.settings);

        // Step F4: update API header scope and clear any cached data that is space-scoped
        try {
          plugin.api?.setSpaceId?.(sid);
        } catch {}
        (plugin as any).resetSpaceScopedCaches?.();
        
        // ✅ 内存优化：空间切换时清理所有服务的快照缓存
        try {
          plugin.recordRSLatte?.clearAllSnapshots?.();
          plugin.outputRSLatte?.clearAllSnapshots?.();
          plugin.publishRSLatte?.clearAllSnapshots?.();
          (plugin as any).projectMgr?.clearAllSnapshots?.();
        } catch (e) {
          console.warn("[RSLatte][space] Failed to clear snapshots on space switch:", e);
        }

        // Broadcast to any listeners (views/coordinator/etc.)
        try {
          (plugin.app?.workspace as any)?.trigger?.(RSLATTE_EVENT_SPACE_CHANGED, { spaceId: sid, source: opts?.source ?? "unknown" });
        } catch {}

        // Best-effort UI refresh for all existing side panels
        // 使用 setTimeout 确保 settings 已完全保存并应用后再刷新
        // 这样可以确保各个侧边栏在 refresh 时能读取到最新的空间数据
        setTimeout(() => {
          // 主动触发项目数据加载，避免仅打开工作台时无人触发 refreshAll 导致一直为空
          try {
            const pm = (plugin as any).projectMgr;
            if (pm && typeof pm.refreshAll === "function") {
              void pm.refreshAll({ reason: "space_switch", forceSync: false });
            }
          } catch (_) {}
          (plugin as any).refreshAllRSLatteViews?.();
        }, 50);

        const name = String(target?.name ?? sid).trim() || sid;
        new Notice(`已切换到空间：${name}`);
        if (plugin.isDebugLogEnabled()) {
          plugin.dbg("space", "switch", { from: cur, to: sid, source: opts?.source ?? "unknown" });
        }
      } catch (e) {
        console.warn("[RSLatte][space] switchSpace failed", e);
        new Notice("切换空间失败。");
      }
    },

    /** Refresh all RSLatte side panel views (best-effort). */
    refreshAllRSLatteViews(): void {
      try {
        const types = [VIEW_TYPE_HUB, VIEW_TYPE_RSLATTE, VIEW_TYPE_TASKS, VIEW_TYPE_PROJECTS, VIEW_TYPE_OUTPUTS, VIEW_TYPE_PUBLISH, VIEW_TYPE_FINANCE, VIEW_TYPE_CONTACTS, VIEW_TYPE_DASHBOARD];
        const refreshed: string[] = [];
        const failed: string[] = [];
        
        for (const t of types) {
          try {
            const leaves = plugin.app.workspace.getLeavesOfType(t as any) ?? [];
            for (const leaf of leaves) {
              const v: any = (leaf as any)?.view;
              if (v) {
                if (typeof v.refresh === "function") {
                  try {
                    // 调用 refresh，如果是 async 函数则等待
                    const result = v.refresh();
                    if (result && typeof result.then === "function") {
                      // 异步刷新，不等待完成（避免阻塞）
                      result.catch((e: any) => {
                        console.warn(`[RSLatte][space] refresh failed for ${t}:`, e);
                        failed.push(t);
                      });
                    }
                    refreshed.push(t);
                  } catch (e) {
                    console.warn(`[RSLatte][space] refresh error for ${t}:`, e);
                    failed.push(t);
                  }
                } else if (typeof v.requestRender === "function") {
                  try {
                    v.requestRender();
                    refreshed.push(t);
                  } catch (e) {
                    console.warn(`[RSLatte][space] requestRender error for ${t}:`, e);
                    failed.push(t);
                  }
                }
              }
            }
          } catch (e) {
            console.warn(`[RSLatte][space] getLeavesOfType failed for ${t}:`, e);
            failed.push(t);
          }
        }
        
        if (plugin.isDebugLogEnabled()) {
          plugin.dbg("space", "refreshAllRSLatteViews", {
            refreshed: [...new Set(refreshed)],
            failed: [...new Set(failed)],
            totalTypes: types.length,
          });
        }
      } catch (e) {
        console.warn("[RSLatte][space] refreshAllRSLatteViews failed", e);
      }
    },

    /**
     * Reset in-memory caches that are scoped to the current space.
     * - Prevent showing stale data after switching spaces.
     */
    resetSpaceScopedCaches(): void {
      try {
        // DB sync status lights
        (plugin as any)._dbSyncMeta = {};

        // finance summary cache
        (plugin as any)._financeSummaryKey = "";
        (plugin as any)._financeSummaryFetchedAt = 0;
        (plugin as any)._financeSummary = null;

        // today's records cache
        (plugin as any)._todayCheckinsKey = "";
        (plugin as any)._todayCheckinsFetchedAt = 0;
        (plugin as any)._todayCheckinsMap = new Map();

        (plugin as any)._todayFinancesKey = "";
        (plugin as any)._todayFinancesFetchedAt = 0;
        (plugin as any)._todayFinancesMap = new Map();

        // preview cache
        (plugin as any)._todayPanelPreviewKey = "";
        (plugin as any)._todayPanelPreviewFetchedAt = 0;
        (plugin as any)._todayPanelPreview = {};

        // backend readiness cache
        (plugin as any)._backendDbReady = null;

        // Reset service stores to force re-initialization with new space's index directory
        // This ensures task/memo/output/record services read from the correct space-specific index
        try {
          // Task/Memo service - refresh store base dir to use new space's index
          if (plugin.taskRSLatte?.refreshStoreBaseDir) {
            plugin.taskRSLatte.refreshStoreBaseDir();
          }
        } catch (e) {
          console.warn("[RSLatte][space] reset taskRSLatte store failed", e);
        }

        try {
          // Output service - reset store to use new space's index
          if (plugin.outputRSLatte?.resetStore) {
            void plugin.outputRSLatte.resetStore();
          }
        } catch (e) {
          console.warn("[RSLatte][space] reset outputRSLatte store failed", e);
        }

        try {
          // Record service (checkin/finance) - reset store to use new space's index
          if (plugin.recordRSLatte?.resetStore) {
            void plugin.recordRSLatte.resetStore();
          }
        } catch (e) {
          console.warn("[RSLatte][space] reset recordRSLatte store failed", e);
        }

        try {
          // Publish service - reset store to use new space's index
          if (plugin.publishRSLatte?.resetStore) {
            void plugin.publishRSLatte.resetStore();
          }
        } catch (e) {
          console.warn("[RSLatte][space] reset publishRSLatte store failed", e);
        }

        try {
          // Project manager - reset snapshot to use new space's index
          if ((plugin.projectMgr as any)?.resetStore) {
            void (plugin.projectMgr as any).resetStore();
          } else if ((plugin.projectMgr as any)?._snapshot) {
            // Reset to empty snapshot instead of null to avoid "Cannot read properties of null" errors
            (plugin.projectMgr as any)._snapshot = { projects: [], updatedAt: 0 };
          }
          // Also reset index store to force re-initialization with new space's index directory
          if ((plugin.projectMgr as any)?._idxStore) {
            (plugin.projectMgr as any)._idxStore = null;
          }
        } catch (e) {
          console.warn("[RSLatte][space] reset projectMgr store failed", e);
        }
      } catch {
        // ignore
      }
    },
  };
}
