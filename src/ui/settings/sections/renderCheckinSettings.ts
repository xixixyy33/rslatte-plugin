// Auto-split from RSLatteSettingTab.ts to reduce file size and isolate failures.
import { Notice, Setting } from "obsidian";
import { apiTry } from "../../../api";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import {
  CHECKIN_DIFFICULTY_LABELS,
  normalizeCheckinDifficulty,
  type CheckinDifficulty,
  type CheckinItemDef,
} from "../../../types/rslatteTypes";

export type ModuleWrapFactory = (moduleKey: any, title: string, scopeTag?: "global" | "space") => HTMLElement;
export type HeaderButtonsVisibilityAdder = (wrap: HTMLElement, moduleKey: any, defaultShow: boolean) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderCheckinSettings(opts: {
  tab: any;
  makeModuleWrap: ModuleWrapFactory;
  addHeaderButtonsVisibilitySetting: HeaderButtonsVisibilityAdder;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addUiHeaderButtonsVisibilitySetting?: any;
}): void {
  const { tab, makeModuleWrap, addHeaderButtonsVisibilitySetting } = opts;
  const plugin = tab.plugin;
  const sAny = plugin?.settings as any;
  
  try {
    const checkinWrap = makeModuleWrap('checkin', '打卡管理');
    addHeaderButtonsVisibilitySetting(checkinWrap, "checkin", false);

    // ✅ 异步加载“已在日志/索引中使用过”的 ID 集合：用于锁定 ID 输入框（避免历史记录对不上）
    // 不阻塞首屏渲染，加载完成后仅在首次加载时触发一次 re-render
    const needRerenderForUsedIds = !((tab as any)._usedIdsLoaded);
    void tab.loadListUsedIdLocks?.().then(() => {
      if (needRerenderForUsedIds) tab.display();
    });

    new Setting(checkinWrap)
      .setName("打卡项样式")
      .setDesc("按钮式：按钮+过去30天热力图；Checklist：每项一行（勾选框+近30天次数）。")
      .addDropdown(dd => {
        dd.addOption("buttons", "按钮式（热力图）");
        dd.addOption("checklist", "Checklist（清单）");
        dd.setValue(sAny.checkinDisplayStyle ?? "buttons");
        dd.onChange(async (v) => {
          sAny.checkinDisplayStyle = v as any;
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });


    // ✅ 清单始终允许本地维护；若开启 DB 同步，保存设置时由插件自动尝试同步到 DB（失败不阻断）。

    checkinWrap.createEl("h5", { text: "打卡项清单" });
    // NOTE: 已移除“隐藏未启用项”开关，默认展示全部条目（未启用的条目仍可保留在清单中）

    // ===== 表头行 =====
    const ckHeader = checkinWrap.createDiv({ cls: "rslatte-checkin-table-header" });
    ckHeader.createDiv({ text: "ID", cls: "col col-id" });
    ckHeader.createDiv({ text: "名称", cls: "col col-name" });
    ckHeader.createDiv({ text: "难度", cls: "col col-difficulty" });
    ckHeader.createDiv({ text: "色块", cls: "col col-color" });
    ckHeader.createDiv({ text: "启用", cls: "col col-active" });
    ckHeader.createDiv({ text: "连续", cls: "col col-continuous" });
    ckHeader.createDiv({ text: "", cls: "col col-move" });
    ckHeader.createDiv({ text: "", cls: "col col-move" });
    ckHeader.createDiv({ text: "操作", cls: "col col-action" });

    tab.plugin.settings.checkinItems.forEach((item: CheckinItemDef, idx: number) => {
      const row = new Setting(checkinWrap).setName("");
      let hintEl = row.settingEl.querySelector<HTMLElement>(".rslatte-row-hint");
      if (!hintEl) hintEl = row.settingEl.createDiv({ cls: "rslatte-row-hint" });
      hintEl.style.pointerEvents = "none";

      row.settingEl.addClass("rslatte-checkin-table-row");
      row.settingEl.dataset.idx = String(idx);

      row.addText((t) => {
        t.inputEl.addClass("col", "col-id");
        t.setPlaceholder("DK_xxx");
        t.setValue(item.id ?? "");

        const locked = !!item.fromDb || !!tab.isCheckinIdLockedByUsage?.(item.id);
        t.setDisabled(locked);
        if (locked) {
          t.inputEl.addClass("is-locked");
          t.inputEl.title = item.fromDb
            ? "该条目来自数据库，ID 不允许修改（如需更换请新增一个条目）"
            : "该 ID 已在日志/索引中使用，修改会导致历史记录对不上，因此不允许修改（如需更换请新增一个条目）";
        }

        t.onChange(async (v) => {
          if (locked) return;
          item.id = v.trim();
          tab.refreshCheckinValidationMarks(checkinWrap);
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });

      row.addText((t) => {
        t.inputEl.addClass("col", "col-name");
        // ✅ 添加 data 属性以便焦点恢复时能准确定位（使用 ID 而不是索引，因为删除后索引会变化）
        t.inputEl.setAttribute("data-setting-key", `checkin-name-${item.id}`);
        t.inputEl.setAttribute("data-checkin-id", item.id);
        t.inputEl.setAttribute("data-checkin-idx", String(idx)); // 保留索引作为备用
        t.setPlaceholder("名称")
          .setValue(item.name ?? "")
          .onChange(async (v) => {
            item.name = v.trim();
            tab.refreshCheckinValidationMarks(checkinWrap);
            await tab.saveAndRefreshSidePanelDebounced();
          });
      });

      row.addDropdown((dd) => {
        dd.selectEl.addClass("col", "col-difficulty");
        dd.selectEl.title = "打卡难度";
        const order: CheckinDifficulty[] = ["normal", "high_focus", "light"];
        for (const k of order) {
          dd.addOption(k, CHECKIN_DIFFICULTY_LABELS[k]);
        }
        dd.setValue(normalizeCheckinDifficulty((item as any).checkinDifficulty));
        dd.onChange(async (v) => {
          (item as any).checkinDifficulty = normalizeCheckinDifficulty(v);
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });

      // 热力图颜色（打卡日色块）
      row.addText((t) => {
        t.inputEl.addClass("col", "col-color");
        t.inputEl.type = "color";
        // HTML color input expects #RRGGBB
        const v = String((item as any).heatColor ?? "").trim();
        t.setValue(/^#([0-9a-fA-F]{6})$/.test(v) ? v : "#22c55e");
        t.onChange(async (v2) => {
          // store raw value (can be CSS var in future, but UI uses #RRGGBB)
          (item as any).heatColor = (v2 ?? "").trim();
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });

      row.addToggle((tog) => {
        tog.setValue(!!item.active).onChange(async (v) => {
          item.active = v;
          await tab.saveAndRerender();
        });
      });

      // 连续打卡天数（只读，由刷新/打卡时自动更新）
      row.addText((t) => {
        t.inputEl.addClass("col", "col-continuous");
        t.setValue(String(Math.max(0, item.continuousDays ?? 0)));
        t.setDisabled(true);
        t.inputEl.title = "已连续打卡天数（由刷新打卡数据与打卡操作自动更新）";
      });

      row.addButton((btn) => {
        btn.buttonEl.addClass("col", "col-action");
        btn.setButtonText("↑").onClick(async () => {
          if (idx <= 0) return;
          const arr = tab.plugin.settings.checkinItems;
          [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
          await tab.saveAndRerender();
        });
      });

      row.addButton((btn) => {
        btn.buttonEl.addClass("col", "col-action");
        btn.setButtonText("↓").onClick(async () => {
          const arr = tab.plugin.settings.checkinItems;
          if (idx >= arr.length - 1) return;
          [arr[idx + 1], arr[idx]] = [arr[idx], arr[idx + 1]];
          await tab.saveAndRerender();
        });
      });

      row.addButton((btn) => {
        btn.buttonEl.addClass("col", "col-action");
        btn.setButtonText("删除").setCta().onClick(async () => {
          const ok = confirm(`确认删除打卡项？\n\n${item.name} (${item.id})`);
          if (!ok) return;

          if (item.fromDb) {
            if (!tab.plugin.isRSLatteDbSyncEnabled()) {
              // DB 同步关闭：仅本地删除
              tab.plugin.settings.checkinItems.splice(idx, 1);
              await tab.saveAndRerender();
              return;
            }
            await apiTry("删除打卡项", () => tab.plugin.api.deleteCheckinType(item.id));
            await tab.pullListsFromApiToSettings();
            new Notice("已删除（软删）");
            tab.display();
            tab.plugin.refreshSidePanel();
            return;
          }

          tab.plugin.settings.checkinItems.splice(idx, 1);
          await tab.saveAndRerender();
        });
      });

      if (!item.active) row.settingEl.addClass("is-inactive");
    });

    tab.refreshCheckinValidationMarks(checkinWrap);

    // ✅ 加载"历史已删除 ID（tombstone）"冲突集合，用于设置页直接高亮提示
    // 异步执行，不阻塞 UI 首屏渲染
    // 延迟加载以确保空间切换后数据已同步
    void tab.loadListTombstoneConflicts().then(() => {
      tab.refreshCheckinValidationMarks(checkinWrap);
    });

    new Setting(checkinWrap).addButton((btn) =>
      btn.setButtonText("+ 新增打卡项").setCta().onClick(async () => {
        // ✅ 检查最大值限制（50个）
        const MAX_ITEMS = 50;
        if (tab.plugin.settings.checkinItems.length >= MAX_ITEMS) {
          new Notice(`打卡项清单最多只能有 ${MAX_ITEMS} 个，请先删除一些条目再添加`);
          return;
        }
        
        const id = await tab.plugin.recordRSLatte?.genUniqueListId("DK", {
          checkinItems: tab.plugin.settings.checkinItems,
          financeCategories: tab.plugin.settings.financeCategories,
        });
        tab.plugin.settings.checkinItems.push({
          id: id || tab.genId("DK"),
          name: "新打卡项",
          active: true,
          checkinDifficulty: "normal",
          fromDb: false,
        });
        await tab.saveAndRerender();
      })
    );



    // =========================
    // 财务管理
    // =========================
  } catch (e: any) {
    console.error("[RSLatte][settings][renderCheckinSettings] render failed", e);
    try { new Notice("设置渲染失败（renderCheckinSettings），请查看 Console"); } catch {}
  }
}
