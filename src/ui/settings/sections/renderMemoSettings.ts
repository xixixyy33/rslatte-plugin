// Auto-split from RSLatteSettingTab.ts to reduce file size and isolate failures.
import { Notice, Setting } from "obsidian";
import { MEMO_CARD_ACTION_CATALOG, MEMO_CLOSED_CARD_ACTION_CATALOG } from "../../../constants/sidePanelCardActions";
import { renderSidePanelCardMoreChecklist } from "../../helpers/renderSidePanelCardMoreSettings";

export type ModuleWrapFactory = (moduleKey: any, title: string, scopeTag?: "global" | "space") => HTMLElement;
export type HeaderButtonsVisibilityAdder = (wrap: HTMLElement, moduleKey: any, defaultShow: boolean) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderMemoSettings(opts: {
  tab: any;
  makeModuleWrap: ModuleWrapFactory;
  addHeaderButtonsVisibilitySetting: HeaderButtonsVisibilityAdder;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addUiHeaderButtonsVisibilitySetting?: any;
}): void {
  const { tab, makeModuleWrap, addHeaderButtonsVisibilitySetting } = opts;
  const plugin = tab.plugin;
  const tp = plugin?.settings?.taskPanel as any;
  try {
    const memoWrap = makeModuleWrap('memo', '提醒管理');
    addHeaderButtonsVisibilitySetting(memoWrap, "memo", true);

    new Setting(memoWrap)
      .setName("即将到期阈值（天）")
      .setDesc("提醒卡片显示“即将到期”黄色标签的时间窗口，默认 5 天。")
      .addText((t) =>
        t.setPlaceholder("5")
          .setValue(String(tp.reminderUpcomingDays ?? 5))
          .onChange(async (v) => {
            const n = Number(v);
            tp.reminderUpcomingDays = Number.isFinite(n) ? Math.max(1, Math.min(30, Math.floor(n))) : 5;
            await tab.saveAndRefreshSidePanelDebounced();
          })
      );

    new Setting(memoWrap)
      .setName("近期完成/取消/失效窗口（天）")
      .setDesc("“近期完成/取消/失效”分组展示过去 N 天闭环条目，范围 7-100。")
      .addText((t) =>
        t.setPlaceholder("30")
          .setValue(String(tp.recentClosedMemoWindowDays ?? 30))
          .onChange(async (v) => {
            const n = Number(v);
            tp.recentClosedMemoWindowDays = Number.isFinite(n) ? Math.max(7, Math.min(100, Math.floor(n))) : 30;
            await tab.saveAndRefreshSidePanelDebounced();
          })
      );

    if (!Array.isArray(tp.sidePanelMemoCardActionsInMore)) tp.sidePanelMemoCardActionsInMore = [];
    if (!Array.isArray(tp.sidePanelMemoClosedCardActionsInMore)) tp.sidePanelMemoClosedCardActionsInMore = [];
    renderSidePanelCardMoreChecklist(memoWrap, {
      heading: "侧栏提醒卡片（活跃）：收纳到「⋯」",
      description:
        "事项提醒主列表与全量提醒列表中的卡片按钮。勾选后收入「⋯」。显隐仍由条目状态决定。按当前空间独立保存。",
      catalog: MEMO_CARD_ACTION_CATALOG,
      getIds: () => tp.sidePanelMemoCardActionsInMore,
      setIds: (n) => {
        tp.sidePanelMemoCardActionsInMore = n;
      },
      save: () => tab.saveAndRefreshSidePanelDebounced(),
    });
    renderSidePanelCardMoreChecklist(memoWrap, {
      heading: "侧栏「近期闭环」提醒卡片：收纳到「⋯」",
      description: "近期完成/取消/失效分组中的提醒卡片（通常为「恢复」）。勾选后收入「⋯」。",
      catalog: MEMO_CLOSED_CARD_ACTION_CATALOG,
      getIds: () => tp.sidePanelMemoClosedCardActionsInMore,
      setIds: (n) => {
        tp.sidePanelMemoClosedCardActionsInMore = n;
      },
      save: () => tab.saveAndRefreshSidePanelDebounced(),
    });

    // 全量提醒清单已下线，不再暴露相关配置项。

  } catch (e: any) {
    console.error("[RSLatte][settings][renderMemoSettings] render failed", e);
    try { new Notice("设置渲染失败（renderMemoSettings），请查看 Console"); } catch {}
  }
}
