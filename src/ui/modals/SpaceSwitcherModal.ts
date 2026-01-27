import { App, FuzzySuggestModal, Notice } from "obsidian";
import type RSLattePlugin from "../../main";
import type { RSLatteSpaceConfig } from "../../types/space";

/**
 * Step F1: Global space switcher modal.
 * - Uses UUID as the stable space id (aligned with backend).
 */
export class SpaceSwitcherModal extends FuzzySuggestModal<RSLatteSpaceConfig> {
  private plugin: RSLattePlugin;
  private spaces: RSLatteSpaceConfig[];

  constructor(app: App, plugin: RSLattePlugin, spaces: RSLatteSpaceConfig[]) {
    super(app);
    this.plugin = plugin;
    this.spaces = spaces;

    this.setPlaceholder("切换空间：输入名称或 UUID");
    this.setInstructions([
      { command: "↑↓", purpose: "选择" },
      { command: "Enter", purpose: "切换" },
      { command: "Esc", purpose: "取消" },
    ]);
  }

  getItems(): RSLatteSpaceConfig[] {
    return this.spaces;
  }

  getItemText(item: RSLatteSpaceConfig): string {
    // FuzzySuggestModal 内部可能会包装 item，尝试从 item.item 中获取实际数据
    const actualItem = (item as any)?.item || item;
    const id = String(actualItem?.id ?? "").trim();
    
    // 优先从 actualItem 中读取 name，如果为空或未定义则尝试从 plugin.settings 中重新获取
    let name = actualItem?.name;
    const nameStr = String(name ?? "").trim();
    
    // 如果 name 为空、未定义或 null，尝试从 settings 中重新获取
    if (!nameStr || name === undefined || name === null) {
      try {
        const spacesMap: Record<string, RSLatteSpaceConfig> = (this.plugin.settings as any)?.spaces ?? {};
        const spaceFromSettings = spacesMap[id];
        if (spaceFromSettings) {
          const settingsName = String(spaceFromSettings.name ?? "").trim();
          if (settingsName) {
            name = settingsName;
          }
        }
      } catch {
        // ignore
      }
    }
    
    // 转换为字符串并去除空白
    name = String(name ?? "").trim();
    
    // 如果 name 仍然为空，生成一个默认名称用于搜索
    if (!name) {
      if (id === "00000000-0000-0000-0000-000000000000") {
        name = "默认空间";
      } else if (id) {
        name = `空间 ${id.slice(0, 8)}`;
      } else {
        name = "(unnamed)";
      }
    }
    
    return `${name} ${id}`.trim();
  }

  renderSuggestion(item: RSLatteSpaceConfig, el: HTMLElement): void {
    el.empty();

    // FuzzySuggestModal 内部会对 item 进行包装，实际的空间配置可能在 item.item 中
    // 从日志看，itemKeys 是 ['match', 'item']，说明实际数据在 item.item
    const actualItem = (item as any)?.item || item;

    // 使用实际的空间配置对象
    const targetSpace = actualItem;
    const targetId = String(targetSpace?.id ?? "").trim();

    const cur = this.plugin.getCurrentSpaceId?.() ?? "";
    const isCur = cur && targetId === String(cur).trim();

    // 创建标题容器，包含名称和"当前"标签
    const titleRow = el.createDiv({ cls: "rslatte-suggest-title-row" });
    const title = titleRow.createDiv({ cls: "rslatte-suggest-title" });
    
    // 始终从 plugin.settings 中获取最新的空间名称
    let name = "";
    if (targetId) {
      try {
        const spacesMap: Record<string, RSLatteSpaceConfig> = (this.plugin.settings as any)?.spaces ?? {};
        const spaceFromSettings = spacesMap[targetId];
        if (spaceFromSettings) {
          name = String(spaceFromSettings.name ?? "").trim();
        }
      } catch (e) {
        console.warn("[RSLatte][SpaceSwitcher] renderSuggestion error", e);
      }
    }
    
    // 如果从 settings 中获取不到，尝试从实际的空间配置中读取
    if (!name) {
      name = String(targetSpace?.name ?? "").trim();
    }
    
    // 如果 name 仍然为空，生成一个默认名称
    if (!name) {
      if (targetId === "00000000-0000-0000-0000-000000000000") {
        name = "默认空间";
      } else if (targetId) {
        // 使用 UUID 的前8位作为显示名称
        name = `空间 ${targetId.slice(0, 8)}`;
      } else {
        name = "(unnamed)";
      }
    }
    
    title.setText(name);
    
    // 如果当前空间，在名称后面添加"当前"标签
    if (isCur) {
      const currentBadge = titleRow.createSpan({ cls: "rslatte-suggest-current" });
      currentBadge.setText("当前");
    }

    // ID 显示在下方，使用灰色小字
    const note = el.createDiv({ cls: "rslatte-suggest-note" });
    note.setText(targetId);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onChooseItem(item: RSLatteSpaceConfig, evt?: MouseEvent | KeyboardEvent): void {
    // FuzzySuggestModal 内部可能会包装 item，尝试从 item.item 中获取实际数据
    const actualItem = (item as any)?.item || item;
    const sid = String(actualItem?.id ?? "").trim();
    if (!sid) {
      new Notice("空间缺少 UUID，无法切换。");
      return;
    }

    void this.plugin.switchSpace(sid, { source: "modal" });
  }
}
