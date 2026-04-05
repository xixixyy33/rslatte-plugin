import type { App } from "obsidian";

/** 是否已启用 Obsidian 核心插件「工作区」 */
export function isWorkspacesCorePluginEnabled(app: App): boolean {
  try {
    const ip = (app as any).internalPlugins;
    if (!ip?.plugins) return false;
    const w = ip.plugins.workspaces;
    return !!(w && w.enabled === true);
  } catch {
    return false;
  }
}
