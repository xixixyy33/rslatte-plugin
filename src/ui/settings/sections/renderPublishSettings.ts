// Auto-split from RSLatteSettingTab.ts to reduce file size and isolate failures.
import { Notice, Setting, normalizePath } from "obsidian";
import { DEFAULT_SETTINGS } from "../../../constants/defaults";

export type ModuleWrapFactory = (moduleKey: any, title: string) => HTMLElement;
export type HeaderButtonsVisibilityAdder = (wrap: HTMLElement, moduleKey: any, defaultShow: boolean) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderPublishSettings(opts: {
  tab: any;
  makeModuleWrap: ModuleWrapFactory;
  addHeaderButtonsVisibilitySetting: HeaderButtonsVisibilityAdder;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addUiHeaderButtonsVisibilitySetting?: any;
}): void {
  const { tab, makeModuleWrap, addHeaderButtonsVisibilitySetting } = opts;
  const plugin = tab.plugin;
  
  try {
    const publishWrap = makeModuleWrap('publish', '发布管理');
    addHeaderButtonsVisibilitySetting(publishWrap, "publish", false);

    const pp = (tab.plugin.settings.publishPanel ?? (DEFAULT_SETTINGS as any).publishPanel) as any;
    tab.plugin.settings.publishPanel = pp;

    // 辅助函数：分割多行文本为数组
    const splitLines = (v: string): string[] => {
      return String(v ?? "")
        .split(/\r?\n/)
        .map((s) => normalizePath(s.trim()))
        .filter((s) => !!s);
    };

    // 文档目录配置
    const documentDirsSetting = new Setting(publishWrap)
      .setName("发布管理的文档目录")
      .setDesc("用于扫描发布管理的文档；一行一个目录，例如：\n00-Inbox/发布\n02-Notes/发布")
      .addTextArea((ta) => {
        ta.setPlaceholder("00-Inbox/发布\n02-Notes/发布");
        ta.setValue((pp.documentDirs ?? []).join("\n"));
        ta.onChange(async (v) => {
          pp.documentDirs = splitLines(v);
          await tab.saveAndRefreshSidePanelDebounced();
        });
        ta.inputEl.rows = 4;
      });

    // 发布通道配置
    const publishChannelsSetting = new Setting(publishWrap)
      .setName("发布通道选项")
      .setDesc("发布通道下拉框的选项，一行一个，例如：\n微信公众号\n知乎\n博客")
      .addTextArea((ta) => {
        ta.setPlaceholder("微信公众号\n知乎\n博客");
        ta.setValue((pp.publishChannels ?? []).join("\n"));
        ta.onChange(async (v) => {
          pp.publishChannels = splitLines(v);
          await tab.saveAndRefreshSidePanelDebounced();
        });
        ta.inputEl.rows = 4;
      });

    // ✅ 发布管理使用全局的中央索引目录（centralIndexDir），不维护自己的配置
  } catch (e: any) {
    console.error("renderPublishSettings failed", e);
    new Notice(`发布管理设置渲染失败：${e?.message ?? String(e)}`);
  }
}
