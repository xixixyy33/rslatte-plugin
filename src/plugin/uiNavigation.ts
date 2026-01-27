import { Notice, TFile } from "obsidian";
import type RSLattePlugin from "../main";
import { VIEW_TYPE_HUB, VIEW_TYPE_RSLATTE, VIEW_TYPE_TASKS, VIEW_TYPE_PROJECTS, VIEW_TYPE_OUTPUTS, VIEW_TYPE_PUBLISH, VIEW_TYPE_FINANCE, VIEW_TYPE_CHECKIN, VIEW_TYPE_CONTACTS, VIEW_TYPE_DASHBOARD, VIEW_TYPE_MOBILE_OPS } from "../constants/viewTypes";
import { ContactsSidePanelView } from "../ui/views/ContactsSidePanelView";

/**
 * UI 导航和视图激活模块
 * 提供各种视图的激活、文件打开等功能
 */
export function createUiNavigation(plugin: RSLattePlugin) {
  /**
   * 高亮侧边栏窗口（添加高亮类，然后自动移除）
   */
  function highlightLeaf(leaf: any) {
    if (!leaf) return;
    
    // 尝试多种方式访问容器元素（优先使用 view.containerEl）
    const container = (leaf as any).view?.containerEl || (leaf as any).containerEl || (leaf as any).viewEl;
    if (!container) return;
    
    container.addClass("rslatte-sidebar-highlight");
    
    // 1.5 秒后移除高亮类
    window.setTimeout(() => {
      container.removeClass("rslatte-sidebar-highlight");
    }, 1500);
  }

  return {
    /** ===================== View orchestration ===================== */

    async activateHubView() {
      if (!plugin.app.workspace) return;
      const leaves = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_HUB);
      let targetLeaf: any = null;
      if (leaves.length === 0) {
        const leaf = plugin.app.workspace.getRightLeaf(false);
        if (leaf) {
          await leaf.setViewState({
            type: VIEW_TYPE_HUB,
            active: true,
          });
          targetLeaf = leaf;
        }
      } else {
        plugin.app.workspace.revealLeaf(leaves[0]);
        targetLeaf = leaves[0];
      }
      if (targetLeaf) {
        // 等待视图渲染完成后再高亮
        window.setTimeout(() => highlightLeaf(targetLeaf), 100);
      }
    },

    async activateRSLatteView() {
      if (!plugin.app.workspace) return;
      const leaves = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_RSLATTE);
      let targetLeaf: any = null;
      if (leaves.length === 0) {
        const leaf = plugin.app.workspace.getRightLeaf(false);
        if (leaf) {
          await leaf.setViewState({
            type: VIEW_TYPE_RSLATTE,
            active: true,
          });
          targetLeaf = leaf;
        }
      } else {
        plugin.app.workspace.revealLeaf(leaves[0]);
        targetLeaf = leaves[0];
      }
      if (targetLeaf) {
        // 等待视图渲染完成后再高亮
        window.setTimeout(() => highlightLeaf(targetLeaf), 100);
      }
    },

    async activateTaskView() {
      if (!plugin.app.workspace) return;
      const leaves = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_TASKS);
      let targetLeaf: any = null;
      if (leaves.length === 0) {
        const leaf = plugin.app.workspace.getRightLeaf(false);
        if (leaf) {
          await leaf.setViewState({
            type: VIEW_TYPE_TASKS,
            active: true,
          });
          targetLeaf = leaf;
        }
      } else {
        plugin.app.workspace.revealLeaf(leaves[0]);
        targetLeaf = leaves[0];
      }
      if (targetLeaf) {
        // 等待视图渲染完成后再高亮
        window.setTimeout(() => highlightLeaf(targetLeaf), 100);
      }
    },

    async activateProjectView() {
      if (!plugin.app.workspace) return;
      const leaves = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_PROJECTS);
      let targetLeaf: any = null;
      if (leaves.length === 0) {
        const leaf = plugin.app.workspace.getRightLeaf(false);
        if (leaf) {
          await leaf.setViewState({
            type: VIEW_TYPE_PROJECTS,
            active: true,
          });
          targetLeaf = leaf;
        }
      } else {
        plugin.app.workspace.revealLeaf(leaves[0]);
        targetLeaf = leaves[0];
      }
      if (targetLeaf) {
        // 等待视图渲染完成后再高亮
        window.setTimeout(() => highlightLeaf(targetLeaf), 100);
      }
    },

    async activateOutputView() {
      if (!plugin.app.workspace) return;
      const leaves = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_OUTPUTS);
      let targetLeaf: any = null;
      if (leaves.length === 0) {
        const leaf = plugin.app.workspace.getRightLeaf(false);
        if (leaf) {
          await leaf.setViewState({
            type: VIEW_TYPE_OUTPUTS,
            active: true,
          });
          targetLeaf = leaf;
        }
      } else {
        plugin.app.workspace.revealLeaf(leaves[0]);
        targetLeaf = leaves[0];
      }
      if (targetLeaf) {
        // 等待视图渲染完成后再高亮
        window.setTimeout(() => highlightLeaf(targetLeaf), 100);
      }
    },

    async activatePublishView() {
      if (!plugin.app.workspace) return;
      const leaves = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_PUBLISH);
      let targetLeaf: any = null;
      if (leaves.length === 0) {
        const leaf = plugin.app.workspace.getRightLeaf(false);
        if (leaf) {
          await leaf.setViewState({
            type: VIEW_TYPE_PUBLISH,
            active: true,
          });
          targetLeaf = leaf;
        }
      } else {
        plugin.app.workspace.revealLeaf(leaves[0]);
        targetLeaf = leaves[0];
      }
      if (targetLeaf) {
        window.setTimeout(() => highlightLeaf(targetLeaf), 100);
      }
    },

    async activateFinanceView() {
      if (!plugin.app.workspace) return;
      const leaves = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_FINANCE);
      let targetLeaf: any = null;
      if (leaves.length === 0) {
        const leaf = plugin.app.workspace.getRightLeaf(false);
        if (leaf) {
          await leaf.setViewState({
            type: VIEW_TYPE_FINANCE,
            active: true,
          });
          targetLeaf = leaf;
        }
      } else {
        plugin.app.workspace.revealLeaf(leaves[0]);
        targetLeaf = leaves[0];
      }
      if (targetLeaf) {
        // 等待视图渲染完成后再高亮
        window.setTimeout(() => highlightLeaf(targetLeaf), 100);
      }
    },

    async activateCheckinView() {
      if (!plugin.app.workspace) return;
      const leaves = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_CHECKIN);
      let targetLeaf: any = null;
      if (leaves.length === 0) {
        const leaf = plugin.app.workspace.getRightLeaf(false);
        if (leaf) {
          await leaf.setViewState({
            type: VIEW_TYPE_CHECKIN,
            active: true,
          });
          targetLeaf = leaf;
        }
      } else {
        plugin.app.workspace.revealLeaf(leaves[0]);
        targetLeaf = leaves[0];
      }
      if (targetLeaf) {
        // 等待视图渲染完成后再高亮
        window.setTimeout(() => highlightLeaf(targetLeaf), 100);
      }
    },

    /** Contacts panel (C1): placeholder view; only available when moduleEnabledV2.contacts === true */
    ensureContactsPanelRegistered(): void {
      if ((plugin as any)._contactsViewRegistered) return;
      plugin.registerView(VIEW_TYPE_CONTACTS, (leaf) => new ContactsSidePanelView(leaf, plugin));
      (plugin as any)._contactsViewRegistered = true;
    },

    async activateContactsView() {
      // 始终允许打开联系人侧边栏，即使模块未启用
      // 侧边栏内容会显示"联系人模块未启用"提示
      (plugin as any).ensureContactsPanelRegistered?.();

      if (!plugin.app.workspace) return;
      const leaves = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_CONTACTS);
      let targetLeaf: any = null;
      if (leaves.length === 0) {
        const leaf = plugin.app.workspace.getRightLeaf(false);
        if (leaf) {
          await leaf.setViewState({
            type: VIEW_TYPE_CONTACTS,
            active: true,
          });
          targetLeaf = leaf;
        }
      } else {
        plugin.app.workspace.revealLeaf(leaves[0]);
        targetLeaf = leaves[0];
      }
      if (targetLeaf) {
        // 等待视图渲染完成后再高亮
        window.setTimeout(() => highlightLeaf(targetLeaf), 100);
      }
    },

    async activateMobileOpsView() {
      if (!plugin.app.workspace) return;
      const leaves = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_MOBILE_OPS);
      let targetLeaf: any = null;
      if (leaves.length === 0) {
        const leaf = plugin.app.workspace.getRightLeaf(false);
        if (leaf) {
          await leaf.setViewState({
            type: VIEW_TYPE_MOBILE_OPS,
            active: true,
          });
          targetLeaf = leaf;
        }
      } else {
        plugin.app.workspace.revealLeaf(leaves[0]);
        targetLeaf = leaves[0];
      }
      if (targetLeaf) {
        window.setTimeout(() => highlightLeaf(targetLeaf), 100);
      }
    },

    /** When disabling contacts, close existing leaves to ensure UI disappears immediately. */
    closeContactsView(): void {
      if (!plugin.app.workspace) return;
      const leaves = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_CONTACTS);
      for (const leaf of leaves) {
        try {
          leaf.detach();
        } catch {}
      }
    },

    /** 打开某个 panel 对应的标题 */
    async openTodayAtPanel(panelId: string) {
      const panel = (plugin.settings.journalPanels ?? []).find(p => p.id === panelId) ?? (plugin.settings.journalPanels ?? [])[0];
      if (!panel) {
        new Notice("未配置日记子窗口（journalPanels）");
        return;
      }

      // ✅ 获取当前空间的日记配置，确保跳转到正确的空间日记
      const currentSpaceId = plugin.getCurrentSpaceId();
      const spaces = (plugin.settings as any).spaces || {};
      const currentSpace = spaces[currentSpaceId];
      const spaceSnapshot = currentSpace?.settingsSnapshot || {};
      const spaceDiaryPath = spaceSnapshot.diaryPath;
      const spaceDiaryNameFormat = spaceSnapshot.diaryNameFormat;
      const spaceDiaryTemplate = spaceSnapshot.diaryTemplate;
      
      // 临时设置日记配置覆盖（用于空间隔离）
      const originalPathOverride = (plugin.journalSvc as any)._diaryPathOverride;
      const originalFormatOverride = (plugin.journalSvc as any)._diaryNameFormatOverride;
      const originalTemplateOverride = (plugin.journalSvc as any)._diaryTemplateOverride;
      try {
        // 优先使用空间的配置，否则使用全局配置（null 表示使用全局设置）
        plugin.journalSvc.setDiaryPathOverride(
          spaceDiaryPath || null,
          spaceDiaryNameFormat || null,
          spaceDiaryTemplate || null
        );
        
        const today = plugin.getTodayKey();
        await plugin.journalSvc.ensureDailyNoteForDateKey(today);

        const path = plugin.journalSvc.buildDailyNotePathForDateKey(today);
        
        // 获取父目录配置（如果为空则使用默认值"碎碎念"）
        const parentHeading = (plugin.settings.journalPanelParentHeading?.trim() || "碎碎念");
        const parentHeadingFormatted = parentHeading.startsWith("#") ? parentHeading : `# ${parentHeading}`;
        
        await (plugin as any).noteNav?.openNoteAtHeading?.(path, panel.heading, plugin.settings.todayInsertBeforeHeading, parentHeadingFormatted);
      } finally {
        // 恢复原来的覆盖设置
        plugin.journalSvc.setDiaryPathOverride(originalPathOverride, originalFormatOverride, originalTemplateOverride);
      }
    },

    /**
     * 读取所有"日志子窗口"的预览文本（一次读文件，避免重复 IO）。
     * key = panel.id, value = 文本（最多 maxLines 行）
     */
    async readTodayPanelsPreview(): Promise<Record<string, string>> {
      try {
        // ✅ 获取当前空间的日记配置，确保读取正确的空间日记
        const currentSpaceId = plugin.getCurrentSpaceId();
        const spaces = (plugin.settings as any).spaces || {};
        const currentSpace = spaces[currentSpaceId];
        const spaceSnapshot = currentSpace?.settingsSnapshot || {};
        const spaceDiaryPath = spaceSnapshot.diaryPath;
        const spaceDiaryNameFormat = spaceSnapshot.diaryNameFormat;
        const spaceDiaryTemplate = spaceSnapshot.diaryTemplate;
        
        // 临时设置日记配置覆盖（用于空间隔离）
        const originalPathOverride = (plugin.journalSvc as any)._diaryPathOverride;
        const originalFormatOverride = (plugin.journalSvc as any)._diaryNameFormatOverride;
        const originalTemplateOverride = (plugin.journalSvc as any)._diaryTemplateOverride;
        try {
          // 优先使用空间的配置，否则使用全局配置（null 表示使用全局设置）
          plugin.journalSvc.setDiaryPathOverride(
            spaceDiaryPath || null,
            spaceDiaryNameFormat || null,
            spaceDiaryTemplate || null
          );
          
          const key = plugin.getTodayKey();
          return await plugin.journalSvc.readPanelsPreviewForDateKey(key, plugin.settings.journalPanels ?? []);
        } finally {
          // 恢复原来的覆盖设置
          plugin.journalSvc.setDiaryPathOverride(originalPathOverride, originalFormatOverride, originalTemplateOverride);
        }
      } catch (e) {
        console.error("[rslatte] readTodayPanelsPreview failed", e);
        return {};
      }
    },

    /** 读取单个子窗口的预览文本（默认带一个很短的缓存，避免一次渲染多次读取同一文件） */
    async readTodayPanelText(panelId: string, opts?: { force?: boolean }): Promise<string> {
      const force = Boolean(opts?.force);
      const key = plugin.getTodayKey();

      // ✅ 获取当前空间的日记配置，确保读取正确的空间日记
      const currentSpaceId = plugin.getCurrentSpaceId();
      const spaces = (plugin.settings as any).spaces || {};
      const currentSpace = spaces[currentSpaceId];
      const spaceSnapshot = currentSpace?.settingsSnapshot || {};
      const spaceDiaryPath = spaceSnapshot.diaryPath;
      const spaceDiaryNameFormat = spaceSnapshot.diaryNameFormat;
      const spaceDiaryTemplate = spaceSnapshot.diaryTemplate;
      
      // 缓存键需要包含空间ID，确保不同空间的缓存不冲突
      const cacheKey = `${key}_${currentSpaceId}`;
      
      // 2 秒内复用缓存（Obsidian 侧边栏刷新通常是一次 render 触发多次调用）
      if (!force && (plugin as any)._todayPanelPreviewKey === cacheKey && Date.now() - ((plugin as any)._todayPanelPreviewFetchedAt ?? 0) < 2000) {
        return ((plugin as any)._todayPanelPreview as Record<string, string>)?.[panelId] ?? "";
      }

      // 临时设置日记配置覆盖（用于空间隔离）
      const originalPathOverride = (plugin.journalSvc as any)._diaryPathOverride;
      const originalFormatOverride = (plugin.journalSvc as any)._diaryNameFormatOverride;
      const originalTemplateOverride = (plugin.journalSvc as any)._diaryTemplateOverride;
      try {
        // 优先使用空间的配置，否则使用全局配置（null 表示使用全局设置）
        plugin.journalSvc.setDiaryPathOverride(
          spaceDiaryPath || null,
          spaceDiaryNameFormat || null,
          spaceDiaryTemplate || null
        );
        
        const data = await plugin.journalSvc.readPanelsPreviewForDateKey(key, plugin.settings.journalPanels ?? []);
        (plugin as any)._todayPanelPreviewKey = cacheKey;
        (plugin as any)._todayPanelPreviewFetchedAt = Date.now();
        (plugin as any)._todayPanelPreview = data;
        return data?.[panelId] ?? "";
      } catch {
        return "";
      } finally {
        // 恢复原来的覆盖设置
        plugin.journalSvc.setDiaryPathOverride(originalPathOverride, originalFormatOverride, originalTemplateOverride);
      }
    },

    async openVaultPath(path: string) {
      const p = (path ?? "").trim();
      if (!p) {
        new Notice("路径为空");
        return;
      }

      const af = plugin.app.vault.getAbstractFileByPath(p);
      if (!af || !(af instanceof TFile)) {
        new Notice(`未找到文件：${p}`);
        return;
      }

      if (!plugin.app.workspace) return;
      const leaf = plugin.app.workspace.getLeaf(false);
      if (leaf) {
        await leaf.openFile(af, { active: true });
      }
    },

    /** 打开文件并尽力定位到指定行（0-based） */
    async openFileAtLine(filePath: string, lineNo: number): Promise<void> {
      const file = plugin.app.vault.getAbstractFileByPath(filePath);
      if (!file || !(file instanceof TFile)) {
        throw new Error(`找不到文件：${filePath}`);
      }

      if (!plugin.app.workspace) return;
      const leaf = plugin.app.workspace.getLeaf(false);
      if (!leaf) return;
      
      await leaf.openFile(file, { active: true, state: { mode: "source" } });

      window.setTimeout(() => {
        const view: any = leaf.view as any;
        const editor = view?.editor;
        if (!editor) return;
        const ln = Math.max(0, Number(lineNo || 0));
        try {
          editor.setCursor({ line: ln, ch: 0 });
          editor.scrollIntoView({ from: { line: ln, ch: 0 }, to: { line: ln + 1, ch: 0 } }, true);
        } catch { }
      }, 50);
    },

    async openNoteAtHeading(path: string, headingLine: string) {
      return await (plugin as any).noteNav?.openNoteAtHeading?.(path, headingLine);
    },
  };
}
