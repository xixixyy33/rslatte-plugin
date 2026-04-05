/**
 * 模块启用判断相关方法
 * 提供各种模块是否启用、DB同步是否启用等判断方法
 */
import type RSLattePlugin from "../main";

export function createModuleEnablers(plugin: RSLattePlugin) {
  const self = {
    // ==========================
    // v6-5.1：任务/提醒"拆分配置"的运行时 getter
    // ==========================

    /** v6-5.1：任务模块是否启用 */
    isTaskModuleEnabledV2(): boolean {
      const s: any = plugin.settings as any;
      const v2 = s?.moduleEnabledV2;
      if (typeof v2?.task === "boolean") return v2.task;
      const old = s?.moduleEnabled;
      if (typeof old?.task === "boolean") return old.task;
      return true;
    },

    /** v6-5.1：提醒模块是否启用 */
    isMemoModuleEnabledV2(): boolean {
      const s: any = plugin.settings as any;
      const v2 = s?.moduleEnabledV2;
      if (typeof v2?.memo === "boolean") return v2.memo;
      const old = s?.moduleEnabled;
      if (typeof old?.task === "boolean") return old.task;
      return true;
    },

    /** v6-5.1：任务模块 DB sync 是否启用 */
    isTaskDbSyncEnabledV2(): boolean {
      if (!plugin.isTaskModuleEnabledV2()) return false;

      const apiBaseUrl = String((plugin.settings as any)?.apiBaseUrl ?? "").trim();
      if (!apiBaseUrl) return false;
      const lower = apiBaseUrl.toLowerCase();
      if (!(lower.startsWith("http://") || lower.startsWith("https://"))) return false;
      try {
        // eslint-disable-next-line no-new
        new URL(apiBaseUrl);
      } catch {
        return false;
      }

      const v = (plugin.settings as any)?.taskModule?.enableDbSync;
      if (typeof v === "boolean") return v;
      return self.isTaskDbSyncEnabled();
    },

    /** v6-5.1：提醒模块 DB sync 是否启用 */
    isMemoDbSyncEnabledV2(): boolean {
      if (!plugin.isMemoModuleEnabledV2()) return false;

      const apiBaseUrl = String((plugin.settings as any)?.apiBaseUrl ?? "").trim();
      if (!apiBaseUrl) return false;
      const lower = apiBaseUrl.toLowerCase();
      if (!(lower.startsWith("http://") || lower.startsWith("https://"))) return false;
      try {
        // eslint-disable-next-line no-new
        new URL(apiBaseUrl);
      } catch {
        return false;
      }

      const v = (plugin.settings as any)?.memoModule?.enableDbSync;
      if (typeof v === "boolean") return v;
      return self.isTaskDbSyncEnabled();
    },

    /** vC1：contacts 模块是否启用 */
    isContactsModuleEnabledV2(): boolean {
      const s: any = plugin.settings as any;
      const v2 = s?.moduleEnabledV2;
      return v2?.contacts === true;
    },

    /** vC1：contacts DB sync 是否启用 */
    isContactsDbSyncEnabledV2(): boolean {
      if (!plugin.isContactsModuleEnabledV2()) return false;

      const apiBaseUrl = String((plugin.settings as any)?.apiBaseUrl ?? "").trim();
      if (!apiBaseUrl) return false;
      const lower = apiBaseUrl.toLowerCase();
      if (!(lower.startsWith("http://") || lower.startsWith("https://"))) return false;
      try {
        // eslint-disable-next-line no-new
        new URL(apiBaseUrl);
      } catch {
        return false;
      }

      const v = (plugin.settings as any)?.contactsModule?.enableDbSync;
      return v === true;
    },

    isProjectModuleEnabledV2(): boolean {
      const s: any = plugin.settings as any;
      const v2 = s?.moduleEnabledV2;
      if (typeof v2?.project === "boolean") return v2.project;
      const old = s?.moduleEnabled;
      if (typeof old?.project === "boolean") return old.project;
      return true;
    },

    /** project DB sync 是否启用 */
    isProjectDbSyncEnabled(): boolean {
      if (!plugin.isProjectModuleEnabledV2()) return false;

      const apiBaseUrl = String((plugin.settings as any)?.apiBaseUrl ?? "").trim();
      if (!apiBaseUrl) return false;
      const lower = apiBaseUrl.toLowerCase();
      if (!(lower.startsWith("http://") || lower.startsWith("https://"))) return false;
      try {
        // eslint-disable-next-line no-new
        new URL(apiBaseUrl);
      } catch {
        return false;
      }

      const v = (plugin.settings as any)?.projectEnableDbSync;
      return typeof v === "boolean" ? v : true;
    },

    isModuleEnabled(key: "record" | "task" | "project" | "output"): boolean {
      const me: any = (plugin.settings as any)?.moduleEnabled ?? {};
      const v = me[key];
      return v === undefined ? true : Boolean(v);
    },

    isTaskDbSyncEnabled(): boolean {
      const tp: any = (plugin.settings as any).taskPanel ?? {};
      const v = tp.enableDbSync;
      return v === undefined ? true : Boolean(v);
    },

    isOutputDbSyncEnabled(): boolean {
      // output module enabled?
      const s: any = plugin.settings as any;
      const v2 = s?.moduleEnabledV2;
      if (typeof v2?.output === "boolean" && v2.output === false) return false;
      const oldEnabled = s?.moduleEnabled;
      if (typeof oldEnabled?.output === "boolean" && oldEnabled.output === false) return false;

      // URL must be checkable (http/https + parseable); otherwise force OFF
      const apiBaseUrl = String(s?.apiBaseUrl ?? "").trim();
      if (!apiBaseUrl) return false;
      const lower = apiBaseUrl.toLowerCase();
      if (!(lower.startsWith("http://") || lower.startsWith("https://"))) return false;
      try {
        // eslint-disable-next-line no-new
        new URL(apiBaseUrl);
      } catch {
        return false;
      }

      const v = s?.outputPanel?.enableDbSync;
      return v === true;
    },
  };
  return self;
}
