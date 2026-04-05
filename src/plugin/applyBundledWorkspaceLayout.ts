import type RSLattePlugin from "../main";

import { applyRslatteQuadrantWorkspaceLayout } from "./quadrantWorkspaceLayout";

/**
 * 「一键载入」推荐工作区：四象限侧栏 + 各页签视图；载入前仅 detach RSLatte 叶并多轮清空 left/right dock（见 `quadrantWorkspaceLayout.ts`）。
 * 需启用核心插件「工作区」；不依赖 `changeLayout` JSON（无法可靠表达多页签与上下分栏）。
 */
export async function applyRslatteBundledWorkspaceLayout(plugin: RSLattePlugin): Promise<void> {
  const ws = plugin.app.workspace as any;
  if (!ws.layoutReady) {
    ws.onLayoutReady(() => void applyRslatteBundledWorkspaceLayout(plugin));
    return;
  }
  await applyRslatteQuadrantWorkspaceLayout(plugin);
}
