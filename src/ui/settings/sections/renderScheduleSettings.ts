import { Notice, Setting } from "obsidian";
import { DEFAULT_SETTINGS } from "../../../constants/defaults";
import { SCHEDULE_CARD_ACTION_CATALOG, SCHEDULE_CLOSED_CARD_ACTION_CATALOG } from "../../../constants/sidePanelCardActions";
import { renderSidePanelCardMoreChecklist } from "../../helpers/renderSidePanelCardMoreSettings";
import {
  DEFAULT_SCHEDULE_CATEGORY_DEFS,
  getDefaultScheduleCategoryId,
  getScheduleCategoryDefs,
  scheduleCategoryDefsFromLines,
  scheduleCategoryLinesFromDefs,
} from "../../../taskRSLatte/schedule/scheduleCategory";

export type ModuleWrapFactory = (moduleKey: any, title: string, scopeTag?: "global" | "space") => HTMLElement;
export type HeaderButtonsVisibilityAdder = (wrap: HTMLElement, moduleKey: any, defaultShow: boolean) => void;

export function renderScheduleSettings(opts: {
  tab: any;
  makeModuleWrap: ModuleWrapFactory;
  addHeaderButtonsVisibilitySetting: HeaderButtonsVisibilityAdder;
  addUiHeaderButtonsVisibilitySetting?: any;
}): void {
  const { tab, makeModuleWrap, addHeaderButtonsVisibilitySetting } = opts;
  const plugin = tab.plugin;
  const tp = plugin?.settings?.taskPanel as any;
  const sAny = plugin?.settings as any;
  try {
    const wrap = makeModuleWrap("schedule", "日程管理");
    addHeaderButtonsVisibilitySetting(wrap, "schedule", true);

    if (!sAny.scheduleModule) sAny.scheduleModule = {};
    const sm = sAny.scheduleModule as any;
    const defSm = (DEFAULT_SETTINGS as any).scheduleModule ?? {};
    if (!Array.isArray(sm.scheduleCategoryDefs) || sm.scheduleCategoryDefs.length === 0) {
      sm.scheduleCategoryDefs = JSON.parse(JSON.stringify(defSm.scheduleCategoryDefs ?? DEFAULT_SCHEDULE_CATEGORY_DEFS));
    }
    if (!String(sm.defaultScheduleCategoryId ?? "").trim()) {
      sm.defaultScheduleCategoryId = defSm.defaultScheduleCategoryId ?? "meeting";
    }

    wrap.createEl("h5", { text: "日程分类" });

    const mountDefaultScheduleCategoryDropdown = (defaultSetting: Setting) => {
      defaultSetting.controlEl.empty();
      const list = getScheduleCategoryDefs(sm);
      let cur = String(sm.defaultScheduleCategoryId ?? "").trim();
      if (!list.some((d) => d.id === cur)) {
        cur = getDefaultScheduleCategoryId(sm);
        sm.defaultScheduleCategoryId = cur;
      }
      defaultSetting.addDropdown((dd) => {
        for (const n of list) dd.addOption(n.id, `${n.label}（${n.id}）`);
        dd.setValue(cur);
        dd.onChange(async (v) => {
          sm.defaultScheduleCategoryId = v;
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });
    };

    let defaultScheduleCategorySetting!: Setting;

    new Setting(wrap)
      .setName("分类列表")
      .setDesc(
        "每行一条：`内部id|展示名`（如 meeting|会议）。无竖线时整行作为 id，展示名与 id 相同。可增删改；meta 中 `schedule_category` 存 id，改名展示名不改历史条目。"
      )
      .addTextArea((t) => {
        t.setPlaceholder("task_execution|任务执行\nmeeting|会议");
        t.inputEl.rows = 6;
        t.setValue(scheduleCategoryLinesFromDefs(getScheduleCategoryDefs(sm)));
        t.onChange(async (v) => {
          let lines = scheduleCategoryDefsFromLines(v);
          if (lines.length === 0) lines = DEFAULT_SCHEDULE_CATEGORY_DEFS.map((x) => ({ ...x }));
          sm.scheduleCategoryDefs = lines;
          const defId = String(sm.defaultScheduleCategoryId ?? "").trim();
          if (!lines.some((d) => d.id === defId)) sm.defaultScheduleCategoryId = lines[0].id;
          await tab.saveAndRefreshSidePanelDebounced();
          mountDefaultScheduleCategoryDropdown(defaultScheduleCategorySetting);
        });
      });

    defaultScheduleCategorySetting = new Setting(wrap)
      .setName("新建日程默认分类")
      .setDesc("须为上方列表中的某一项 id；按当前空间在 settingsSnapshot 中独立保存。");

    mountDefaultScheduleCategoryDropdown(defaultScheduleCategorySetting);

    new Setting(wrap)
      .setName("即将超期阈值（天）")
      .setDesc("日程卡片显示“即将到期”黄色标签的时间窗口，默认 5 天。")
      .addText((t) =>
        t.setPlaceholder("5")
          .setValue(String(tp.scheduleUpcomingDays ?? 5))
          .onChange(async (v) => {
            const n = Number(v);
            tp.scheduleUpcomingDays = Number.isFinite(n) ? Math.max(1, Math.min(30, Math.floor(n))) : 5;
            await tab.saveAndRefreshSidePanelDebounced();
          })
      );

    new Setting(wrap)
      .setName("近期完成/取消/失效窗口（天）")
      .setDesc("“近期完成/取消/失效”分组展示过去 N 天闭环条目，范围 7-100。")
      .addText((t) =>
        t.setPlaceholder("30")
          .setValue(String(tp.scheduleRecentClosedDays ?? 30))
          .onChange(async (v) => {
            const n = Number(v);
            tp.scheduleRecentClosedDays = Number.isFinite(n) ? Math.max(7, Math.min(100, Math.floor(n))) : 30;
            await tab.saveAndRefreshSidePanelDebounced();
          })
      );

    if (!Array.isArray(sm.sidePanelScheduleCardActionsInMore)) sm.sidePanelScheduleCardActionsInMore = [];
    if (!Array.isArray(sm.sidePanelScheduleClosedCardActionsInMore)) sm.sidePanelScheduleClosedCardActionsInMore = [];
    renderSidePanelCardMoreChecklist(wrap, {
      heading: "侧栏日程卡片（活跃）：收纳到「⋯」",
      description:
        "今日/即将/超期等活跃日程卡片上的按钮。勾选后收入「⋯」。按当前空间在 scheduleModule 中独立保存。",
      catalog: SCHEDULE_CARD_ACTION_CATALOG,
      getIds: () => sm.sidePanelScheduleCardActionsInMore,
      setIds: (n) => {
        sm.sidePanelScheduleCardActionsInMore = n;
      },
      save: () => tab.saveAndRefreshSidePanelDebounced(),
    });
    renderSidePanelCardMoreChecklist(wrap, {
      heading: "侧栏「近期闭环」日程卡片：收纳到「⋯」",
      description: "恢复、后续安排等。勾选后收入「⋯」。",
      catalog: SCHEDULE_CLOSED_CARD_ACTION_CATALOG,
      getIds: () => sm.sidePanelScheduleClosedCardActionsInMore,
      setIds: (n) => {
        sm.sidePanelScheduleClosedCardActionsInMore = n;
      },
      save: () => tab.saveAndRefreshSidePanelDebounced(),
    });
  } catch (e: any) {
    console.error("[RSLatte][settings][renderScheduleSettings] render failed", e);
    try { new Notice("设置渲染失败（renderScheduleSettings），请查看 Console"); } catch {}
  }
}
