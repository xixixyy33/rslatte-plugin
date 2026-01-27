// Auto-split from RSLatteSettingTab.ts to reduce file size and isolate failures.
import { Notice, WorkspaceLeaf } from "obsidian";
import type { WorkEventKind } from "../../../types/stats/workEvent";
import type { RSLatteSpaceConfig } from "../../../types/space";
import type { WorkEventService } from "../../../services/workEventService";

/** 生成随机十六进制颜色 */
function generateRandomHexColor(): string {
  const hue = Math.floor(Math.random() * 360);
  const saturation = 60 + Math.floor(Math.random() * 40);
  const lightness = 45 + Math.floor(Math.random() * 15);
  
  const l = lightness / 100;
  const a = (saturation * Math.min(l, 1 - l)) / 100;
  const f = (n: number) => {
    const k = (n + hue / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** 从 WorkEventService 注册表中获取所有模块 */
function getAllModulesFromRegistry(workEventSvc?: WorkEventService): Array<{ id: WorkEventKind; defaultName: string }> {
  // 如果没有 workEventSvc，返回空数组（向后兼容）
  if (!workEventSvc) {
    return [];
  }

  try {
    // 获取注册表
    const registry = workEventSvc.getRegistry();
    
    // 从注册表中提取所有唯一的 kind 值，并收集对应的模块名称
    const kindMap = new Map<WorkEventKind, string>();
    
    for (const entry of registry.entries) {
      const kind = entry.kind;
      // 如果该 kind 还没有记录，或者当前条目的模块名称更合适，则更新
      if (!kindMap.has(kind)) {
        kindMap.set(kind, entry.module);
      }
    }
    
    // 转换为数组格式，按 kind 排序（保持顺序一致）
    const modules = Array.from(kindMap.entries())
      .map(([id, module]) => ({
        id,
        defaultName: module || id, // 如果模块名称为空，使用 kind 作为默认名称
      }))
      .sort((a, b) => a.id.localeCompare(b.id)); // 按 kind 字母序排序
    
    return modules;
  } catch (error) {
    console.warn("[RSLatte] 从注册表获取模块列表失败:", error);
    return [];
  }
}

export type CollapsibleSectionFactory = (title: string, open: boolean, extraCls: string) => HTMLElement;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderStatsSettings(opts: {
  tab: any;
  makeCollapsibleSection: CollapsibleSectionFactory;
}): void {
  const { tab, makeCollapsibleSection } = opts;
  const plugin = tab.plugin;
  const sAny = plugin?.settings as any;

  // 确保 statsSettings 存在
  if (!sAny.statsSettings) {
    sAny.statsSettings = {};
  }
  const statsSettings = sAny.statsSettings;

  // 确保 spaces 数组存在
  if (!Array.isArray(statsSettings.spaces)) {
    statsSettings.spaces = [];
  }

  // 确保 moduleColors 对象存在
  if (!statsSettings.moduleColors || typeof statsSettings.moduleColors !== "object") {
    statsSettings.moduleColors = {};
  }

  // 确保 moduleNames 对象存在（用于存储用户自定义的模块名称）
  if (!statsSettings.moduleNames || typeof statsSettings.moduleNames !== "object") {
    statsSettings.moduleNames = {};
  }

  // 确保 moduleEnabled 对象存在（用于存储模块是否开启）
  if (!statsSettings.moduleEnabled || typeof statsSettings.moduleEnabled !== "object") {
    statsSettings.moduleEnabled = {};
  }

  // =========================
  // 统计管理（可折叠，顶层，与其他管理标题同级）
  // =========================
  const statsMgmtWrap = makeCollapsibleSection("统计管理", false, "rslatte-stats-mgmt-wrap");

  // 获取主插件的空间列表
  const listSpaces = (): RSLatteSpaceConfig[] => {
    try {
      const fn = (plugin as any)?.listSpaces;
      if (typeof fn === "function") return fn.call(plugin) as RSLatteSpaceConfig[];
    } catch {
      // ignore
    }
    const m: Record<string, RSLatteSpaceConfig> = sAny?.spaces ?? {};
    return Object.values(m).filter(Boolean);
  };

  // ===== 空间清单 =====
  statsMgmtWrap.createEl("h3", { text: "空间清单" });
  statsMgmtWrap.createEl("p", {
    text: "管理统计功能中的空间配置。空间信息自动从主插件配置中加载。",
    cls: "setting-item-description",
  });

  // 同步空间列表：从主插件配置中加载空间，并合并到 statsSettings.spaces
  const syncSpacesFromMainConfig = () => {
    const mainSpaces = listSpaces();
    const existingStatsSpaces = statsSettings.spaces as Array<{
      id: string;
      name: string;
      backgroundColor?: string;
      enabled?: boolean;
    }>;

    for (const mainSpace of mainSpaces) {
      if (!mainSpace.id) continue;

      const existingIndex = existingStatsSpaces.findIndex((s) => s.id === mainSpace.id);
      if (existingIndex >= 0) {
        // 更新现有空间（保留用户的自定义设置，如背景色、enabled 状态）
        const existing = existingStatsSpaces[existingIndex];
        existing.name = mainSpace.name || existing.name || mainSpace.id;
        // 如果用户没有设置背景色，则使用随机颜色（但不自动保存，只在用户修改时保存）
        // existing.backgroundColor 保持原值或使用随机颜色（仅在渲染时使用）
        // 保留现有的 enabled 状态，如果未设置则默认为 false
        if (existing.enabled === undefined) {
          existing.enabled = false;
        }
      } else {
        // 添加新空间
        existingStatsSpaces.push({
          id: mainSpace.id,
          name: mainSpace.name || mainSpace.id,
          backgroundColor: generateRandomHexColor(), // 初始时设置随机颜色
          enabled: false, // 默认关闭
        });
      }
    }

    // 移除主配置中不存在的空间（保留用户可能手动添加的，但这种情况不应该发生）
    // 这里我们只移除那些在主配置中找不到的空间
    const mainSpaceIds = new Set(mainSpaces.map((s) => s.id).filter(Boolean));
    statsSettings.spaces = existingStatsSpaces.filter((s) => mainSpaceIds.has(s.id));

    return existingStatsSpaces;
  };

  // 初始同步并保存（如果有新空间或新颜色）
  const initialSpaces = syncSpacesFromMainConfig();
  let needsSave = false;
  
  // 检查是否有新空间需要保存随机颜色
  for (const space of initialSpaces) {
    if (!space.backgroundColor) {
      space.backgroundColor = generateRandomHexColor();
      needsSave = true;
    }
  }
  
  // 检查模块颜色（从注册表获取模块列表）
  const workEventSvc = (plugin as any)?.workEventSvc as WorkEventService | undefined;
  const modules = getAllModulesFromRegistry(workEventSvc);
  const moduleColors = statsSettings.moduleColors as Record<string, string>;
  for (const module of modules) {
    if (!moduleColors[module.id]) {
      moduleColors[module.id] = generateRandomHexColor();
      needsSave = true;
    }
  }
  
  if (needsSave) {
    void tab.plugin.saveSettings();
  }

  // 表头容器
  const spaceTableContainer = statsMgmtWrap.createDiv({ cls: "rslatte-stats-space-table-container" });
  
  // 表头
  const spaceHeader = spaceTableContainer.createDiv({ cls: "rslatte-stats-space-table-header" });
  spaceHeader.createDiv({ text: "空间名称", cls: "col col-name" });
  spaceHeader.createDiv({ text: "配色", cls: "col col-color" });
  spaceHeader.createDiv({ text: "是否统计", cls: "col col-enabled" });

  // 渲染空间列表
  const renderSpaceList = () => {
    // 先同步一次，确保列表是最新的
    const spaces = syncSpacesFromMainConfig();

    // 清空现有行（除了表头）
    const existingRows = spaceTableContainer.querySelectorAll(".rslatte-stats-space-table-row");
    existingRows.forEach((row) => row.remove());

    if (spaces.length === 0) {
      const emptyRow = spaceTableContainer.createDiv({ cls: "rslatte-stats-space-table-row" });
      emptyRow.createDiv({
        cls: "rslatte-stats-empty-hint",
        text: "暂无空间配置，请在「空间管理」中添加空间",
      });
      return;
    }

    spaces.forEach((space, index) => {
      const row = spaceTableContainer.createDiv({ cls: "rslatte-stats-space-table-row" });
      row.dataset.idx = String(index);
      row.dataset.spaceId = space.id;

      // 空间名称列（只读，从主配置中获取）
      const nameCol = row.createDiv({ cls: "col col-name" });
      nameCol.textContent = space.name || space.id;

      // 配色列
      const colorCol = row.createDiv({ cls: "col col-color" });
      const colorInput = colorCol.createEl("input", {
        type: "color",
        cls: "col-color-input",
      });
      // 确保有背景色（应该已经在初始化时设置了）
      colorInput.value = space.backgroundColor || "#ffffff";
      colorInput.onchange = async (e) => {
        const target = e.target as HTMLInputElement;
        space.backgroundColor = target.value;
        const ok = await tab.plugin.saveSettings();
        if (!ok) return;
      };

      // 是否统计开关列
      const enabledCol = row.createDiv({ cls: "col col-enabled" });
      const enabledToggle = enabledCol.createEl("input", {
        type: "checkbox",
        cls: "col-enabled-toggle",
      });
      enabledToggle.checked = space.enabled === true; // 默认为 false
      enabledToggle.onchange = async (e) => {
        const target = e.target as HTMLInputElement;
        space.enabled = target.checked;
        const ok = await tab.plugin.saveSettings();
        if (!ok) return;
        // 刷新统计视图
        const refreshAllViews = (plugin as any)?.refreshAllViews;
        if (typeof refreshAllViews === "function") {
          refreshAllViews.call(plugin);
        } else {
          // 如果没有 refreshAllViews 方法，手动刷新打开的视图
          const workspace = plugin.app.workspace;
          workspace.getLeavesOfType("rslatte-stats-timeline").forEach((leaf: WorkspaceLeaf) => {
            const view = leaf.view as any;
            if (view && typeof view.refresh === "function") {
              view.refresh();
            }
          });
          workspace.getLeavesOfType("rslatte-stats-monthly").forEach((leaf: WorkspaceLeaf) => {
            const view = leaf.view as any;
            if (view && typeof view.refresh === "function") {
              view.refresh();
            }
          });
        }
      };
    });
  };

  // 刷新按钮
  const refreshSpacesBtn = statsMgmtWrap.createEl("button", {
    text: "刷新空间列表",
    cls: "mod-cta",
  });
  refreshSpacesBtn.style.marginTop = "10px";
  refreshSpacesBtn.onclick = () => {
    renderSpaceList();
    new Notice("已刷新空间列表");
  };

  // 初始渲染
  renderSpaceList();

  // ===== 模块清单 =====
  statsMgmtWrap.createEl("h3", { text: "模块清单" });
  statsMgmtWrap.createEl("p", {
    text: "管理统计功能中的模块配置。模块ID由系统管理，用户可自定义模块名称、配色和是否开启。",
    cls: "setting-item-description",
  });

  // 模块表格容器
  const moduleTableContainer = statsMgmtWrap.createDiv({ cls: "rslatte-stats-module-table-container" });
  
  // 表头
  const moduleHeader = moduleTableContainer.createDiv({ cls: "rslatte-stats-module-table-header" });
  moduleHeader.createDiv({ text: "模块名称", cls: "col col-name" });
  moduleHeader.createDiv({ text: "模块ID", cls: "col col-id" });
  moduleHeader.createDiv({ text: "配色", cls: "col col-color" });
  moduleHeader.createDiv({ text: "是否开启", cls: "col col-enabled" });

  // 渲染模块列表
  const renderModuleList = () => {
    // 从注册表获取模块列表
    const workEventSvc = (plugin as any)?.workEventSvc as WorkEventService | undefined;
    const modules = getAllModulesFromRegistry(workEventSvc);
    
    if (modules.length === 0) {
      // 清空现有行
      const existingRows = moduleTableContainer.querySelectorAll(".rslatte-stats-module-table-row");
      existingRows.forEach((row) => row.remove());
      
      // 显示提示信息
      const emptyRow = moduleTableContainer.createDiv({ cls: "rslatte-stats-module-table-row" });
      emptyRow.createDiv({
        cls: "rslatte-stats-empty-hint",
        text: "暂无模块配置，请确保 WorkEventService 已初始化",
      });
      return;
    }
    
    const moduleNames = statsSettings.moduleNames as Record<string, string>;
    const moduleColors = statsSettings.moduleColors as Record<string, string>;
    const moduleEnabled = statsSettings.moduleEnabled as Record<string, boolean>;

    // 清空现有行（除了表头）
    const existingRows = moduleTableContainer.querySelectorAll(".rslatte-stats-module-table-row");
    existingRows.forEach((row) => row.remove());

    modules.forEach((module: { id: WorkEventKind; defaultName: string }) => {
      const row = moduleTableContainer.createDiv({ cls: "rslatte-stats-module-table-row" });
      row.dataset.moduleId = module.id;

      // 模块名称列（可编辑）
      const nameCol = row.createDiv({ cls: "col col-name" });
      const nameInput = nameCol.createEl("input", {
        type: "text",
        cls: "col-name-input",
      });
      nameInput.value = moduleNames[module.id] || module.defaultName;
      nameInput.onchange = async (e) => {
        const target = e.target as HTMLInputElement;
        moduleNames[module.id] = target.value.trim() || module.defaultName;
        const ok = await tab.plugin.saveSettings();
        if (!ok) return;
      };

      // 模块ID列（只读）
      const idCol = row.createDiv({ cls: "col col-id" });
      idCol.textContent = module.id;
      idCol.style.fontFamily = "var(--font-monospace)";
      idCol.style.fontSize = "11px";
      idCol.style.color = "var(--text-muted)";

      // 配色列
      const colorCol = row.createDiv({ cls: "col col-color" });
      const colorInput = colorCol.createEl("input", {
        type: "color",
        cls: "col-color-input",
      });
      // 确保有颜色（应该已经在初始化时设置了）
      colorInput.value = moduleColors[module.id] || "#757575";
      colorInput.onchange = async (e) => {
        const target = e.target as HTMLInputElement;
        moduleColors[module.id] = target.value;
        const ok = await tab.plugin.saveSettings();
        if (!ok) return;
        // 刷新统计视图
        const workspace = plugin.app.workspace;
        workspace.getLeavesOfType("rslatte-stats-timeline").forEach((leaf: WorkspaceLeaf) => {
          const view = leaf.view as any;
          if (view && typeof view.refresh === "function") {
            view.refresh();
          }
        });
        workspace.getLeavesOfType("rslatte-stats-monthly").forEach((leaf: WorkspaceLeaf) => {
          const view = leaf.view as any;
          if (view && typeof view.refresh === "function") {
            view.refresh();
          }
        });
      };

      // 是否开启开关列
      const enabledCol = row.createDiv({ cls: "col col-enabled" });
      const enabledToggle = enabledCol.createEl("input", {
        type: "checkbox",
        cls: "col-enabled-toggle",
      });
      // 默认为开启（如果未设置，则视为开启）
      enabledToggle.checked = moduleEnabled[module.id] !== false;
      enabledToggle.onchange = async (e) => {
        const target = e.target as HTMLInputElement;
        moduleEnabled[module.id] = target.checked;
        const ok = await tab.plugin.saveSettings();
        if (!ok) return;
        // 刷新统计视图
        const workspace = plugin.app.workspace;
        workspace.getLeavesOfType("rslatte-stats-timeline").forEach((leaf: WorkspaceLeaf) => {
          const view = leaf.view as any;
          if (view && typeof view.refresh === "function") {
            view.refresh();
          }
        });
        workspace.getLeavesOfType("rslatte-stats-monthly").forEach((leaf: WorkspaceLeaf) => {
          const view = leaf.view as any;
          if (view && typeof view.refresh === "function") {
            view.refresh();
          }
        });
      };
    });
  };

  // 初始渲染
  renderModuleList();
}
