import { moment } from "obsidian";
// ✅ moment 从 Obsidian 导入，但 TypeScript 类型定义可能不完整，使用类型断言
const momentFn = moment as any;
import type RSLattePlugin from "../main";
import { DEFAULT_SETTINGS } from "../constants/defaults";
import { resolveCentralRootDir, resolveSpaceBaseDir, resolveSpaceIndexDir, resolveSpaceQueueDir, resolveSpaceStatsDir, resolveSpaceEventsDir } from "../services/space/spaceContext";
import type { DailyState } from "../types/rslatteTypes";
/**
 * 插件辅助工具方法
 * 提供调试日志、日期辅助、路径解析等功能
 */
export function createPluginHelpers(plugin: RSLattePlugin) {
  return {
    /** ===================== Debug logging ===================== */

    /**
     * Debug 日志开关。
     * 注意：onload 的最开始阶段 this.settings 还没加载，所以需要 fallback 到默认配置。
     */
    isDebugLogEnabled(): boolean {
      const v = plugin.settings?.debugLogEnabled;
      if (typeof v === "boolean") return v;
      // fallback to default settings before loadSettings
      return !!(DEFAULT_SETTINGS as any).debugLogEnabled;
    },

    /**
     * Console 日志（受 debugLogEnabled 控制）。
     * 统一前缀：[rslatte][scope]
     */
    dbg(scope: string, message: string, data?: any) {
      if (!plugin.isDebugLogEnabled()) return;
      const prefix = `[rslatte][${scope}]`;
      if (data === undefined) console.log(prefix, message);
      else console.log(prefix, message, data);
    },

    /** ===================== Daily helpers ===================== */

    getTodayKey(): string {
      return momentFn().format("YYYY-MM-DD");
    },

    getYesterdayKey(): string {
      return momentFn().subtract(1, "day").format("YYYY-MM-DD");
    },

    getOrCreateTodayState(): DailyState {
      const key = plugin.getTodayKey();
      const state = plugin.settings.dailyState?.[key];
      if (state) return state;

      const created: DailyState = { checkinsDone: {}, financeDone: {} };
      if (!plugin.settings.dailyState) plugin.settings.dailyState = {};
      plugin.settings.dailyState[key] = created;
      return created;
    },

    /** ===================== Path helpers ===================== */

    /** ✅ 统一中央索引 *根目录*（所有 space 的父目录） */
    getCentralIndexDir(): string {
      return resolveCentralRootDir(plugin.settings as any);
    },

    /** Space base folder: <centralRoot>/<spaceId> */
    getSpaceBaseDir(spaceId?: string): string {
      return resolveSpaceBaseDir(plugin.settings as any, spaceId as any);
    },

    /** Space index folder: <centralRoot>/<spaceId>/index */
    getSpaceIndexDir(spaceId?: string): string {
      return resolveSpaceIndexDir(plugin.settings as any, spaceId as any);
    },

    /** Side Panel 1：中央索引目录（用于打卡/财务记录索引） */
    getRSLattePanelIndexDir(): string {
      // F2: bucket by space -> index lives under <centralRoot>/<spaceId>/index
      return plugin.getSpaceIndexDir();
    },

    /** Space queue folder: <centralRoot>/<spaceId>/queue */
    getSpaceQueueDir(spaceId?: string): string {
      return resolveSpaceQueueDir(plugin.settings as any, spaceId as any);
    },

    /** Space stats folder: <centralRoot>/<spaceId>/stats */
    getSpaceStatsDir(spaceId?: string): string {
      return resolveSpaceStatsDir(plugin.settings as any, spaceId as any);
    },

    /** Space events folder: <centralRoot>/<spaceId>/.events */
    getSpaceEventsDir(spaceId?: string): string {
      return resolveSpaceEventsDir(plugin.settings as any, spaceId as any);
    },
  };
}
