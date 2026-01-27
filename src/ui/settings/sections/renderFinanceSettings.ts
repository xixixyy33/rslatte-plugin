// Auto-split from RSLatteSettingTab.ts to reduce file size and isolate failures.
import { Notice, Setting } from "obsidian";
import { apiTry } from "../../../api";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { FinanceCatDef } from "../../../types/rslatteTypes";

export type ModuleWrapFactory = (moduleKey: any, title: string) => HTMLElement;
export type HeaderButtonsVisibilityAdder = (wrap: HTMLElement, moduleKey: any, defaultShow: boolean) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderFinanceSettings(opts: {
  tab: any;
  makeModuleWrap: ModuleWrapFactory;
  addHeaderButtonsVisibilitySetting: HeaderButtonsVisibilityAdder;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addUiHeaderButtonsVisibilitySetting?: any;
}): void {
  const { tab, makeModuleWrap, addHeaderButtonsVisibilitySetting } = opts;
  
  try {
    const financeWrap = makeModuleWrap('finance', '财务管理');
    addHeaderButtonsVisibilitySetting(financeWrap, "finance", false);

    // ✅ 异步加载“已在日志/索引中使用过”的 ID 集合：用于锁定 ID 输入框（避免历史记录对不上）
    // 不阻塞首屏渲染，加载完成后仅在首次加载时触发一次 re-render
    const needRerenderForUsedIds = !((tab as any)._usedIdsLoaded);
    void tab.loadListUsedIdLocks?.().then(() => {
      if (needRerenderForUsedIds) tab.display();
    });

    // ✅ 清单始终允许本地维护；若开启 DB 同步，保存设置时由插件自动尝试同步到 DB（失败不阻断）。

    financeWrap.createEl("h5", { text: "财务分类清单" });

    const finHeader = financeWrap.createDiv({ cls: "rslatte-fin-table-header" });
    finHeader.createDiv({ text: "类型", cls: "col col-type" });
    finHeader.createDiv({ text: "ID", cls: "col col-id" });
    finHeader.createDiv({ text: "名称", cls: "col col-name" });
    finHeader.createDiv({ text: "子分类", cls: "col col-subcats" });
    finHeader.createDiv({ text: "启用", cls: "col col-active" });
    finHeader.createDiv({ text: "", cls: "col col-move" });
    finHeader.createDiv({ text: "", cls: "col col-move" });
    finHeader.createDiv({ text: "操作", cls: "col col-action" });

    tab.plugin.settings.financeCategories.forEach((cat: FinanceCatDef, idx: number) => {
      const row = new Setting(financeWrap).setName("");
      let hintEl = row.settingEl.querySelector<HTMLElement>(".rslatte-row-hint");
      if (!hintEl) hintEl = row.settingEl.createDiv({ cls: "rslatte-row-hint" });
      hintEl.style.pointerEvents = "none";

      row.settingEl.addClass("rslatte-fin-table-row");
      row.settingEl.dataset.idx = String(idx);

      row.addDropdown((dd) => {
        dd.selectEl.addClass("col", "col-type");
        dd.addOption("expense", "支出").addOption("income", "收入");
        dd.setValue(cat.type);
        dd.onChange(async (v) => {
          cat.type = v as "income" | "expense";
          tab.refreshFinanceValidationMarks(financeWrap);
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });

      row.addText((t) => {
        t.inputEl.addClass("col", "col-id");
        t.setPlaceholder("CW_xxx");
        t.setValue(cat.id ?? "");

        const locked = !!cat.fromDb || !!tab.isFinanceIdLockedByUsage?.(cat.id);
        t.setDisabled(locked);
        if (locked) {
          t.inputEl.addClass("is-locked");
          t.inputEl.title = cat.fromDb
            ? "该条目来自数据库，ID 不允许修改（如需更换请新增一个条目）"
            : "该 ID 已在日志/索引中使用，修改会导致历史记录对不上，因此不允许修改（如需更换请新增一个条目）";
        }

        t.onChange(async (v) => {
          if (locked) return;
          cat.id = v.trim();
          tab.refreshFinanceValidationMarks(financeWrap);
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });

      row.addText((t) => {
        t.inputEl.addClass("col", "col-name");
        t.setPlaceholder("名称")
          .setValue(cat.name ?? "")
          .onChange(async (v) => {
            cat.name = v.trim();
            tab.refreshFinanceValidationMarks(financeWrap);
            await tab.saveAndRefreshSidePanelDebounced();
          });
      });

      // ✅ 子分类显示和管理
      const controlEl = row.settingEl.querySelector(".setting-item-control") as HTMLElement;
      if (controlEl) {
        const subCatCell = controlEl.createDiv({ cls: "col col-subcats" });
        const subCatList = subCatCell.createDiv({ cls: "rslatte-subcategories-list" });
        
        // 初始化子分类列表
        if (!cat.subCategories) cat.subCategories = [];
        
        const renderSubCategories = () => {
          subCatList.empty();
          if (cat.subCategories && cat.subCategories.length > 0) {
            cat.subCategories.forEach((subCat: string, subIdx: number) => {
              const tag = subCatList.createSpan({ 
                cls: "rslatte-subcategory-tag",
                text: subCat 
              });
              const removeBtn = tag.createSpan({ 
                cls: "rslatte-subcategory-remove",
                text: "×",
                attr: { title: "删除子分类" }
              });
              removeBtn.onclick = async (e) => {
                e.stopPropagation();
                if (cat.subCategories) {
                  cat.subCategories.splice(subIdx, 1);
                  await tab.saveAndRefreshSidePanelDebounced();
                  renderSubCategories();
                }
              };
            });
          }
          subCatList.createSpan({ 
            cls: "rslatte-subcategory-add",
            text: "+ 添加",
            attr: { title: "添加子分类" }
          }).onclick = async () => {
            const newSubCat = prompt("请输入子分类名称：");
            if (newSubCat && newSubCat.trim()) {
              const normalized = newSubCat.trim();
              if (!cat.subCategories) cat.subCategories = [];
              // ✅ 检查是否已存在（不重复）
              if (!cat.subCategories.includes(normalized)) {
                cat.subCategories.push(normalized);
                await tab.saveAndRefreshSidePanelDebounced();
                renderSubCategories();
              } else {
                new Notice("该子分类已存在");
              }
            }
          };
        };
        renderSubCategories();
      }

      row.addToggle((tog) => {
        tog.setValue(!!cat.active).onChange(async (v) => {
          cat.active = v;
          await tab.saveAndRerender();
        });
      });

      row.addButton((btn) => {
        btn.buttonEl.addClass("col", "col-action");
        btn.setButtonText("↑").onClick(async () => {
          if (idx <= 0) return;
          const arr = tab.plugin.settings.financeCategories;
          [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
          await tab.saveAndRerender();
        });
      });

      row.addButton((btn) => {
        btn.buttonEl.addClass("col", "col-action");
        btn.setButtonText("↓").onClick(async () => {
          const arr = tab.plugin.settings.financeCategories;
          if (idx >= arr.length - 1) return;
          [arr[idx + 1], arr[idx]] = [arr[idx], arr[idx + 1]];
          await tab.saveAndRerender();
        });
      });

      row.addButton((btn) => {
        btn.buttonEl.addClass("col", "col-action");
        btn.setButtonText("删除").setCta().onClick(async () => {
          const ok = confirm(`确认删除财务分类？\n\n${cat.name} (${cat.id})`);
          if (!ok) return;

          if (cat.fromDb) {
            if (!tab.plugin.isRSLatteDbSyncEnabled()) {
              // DB 同步关闭：仅本地删除
              tab.plugin.settings.financeCategories.splice(idx, 1);
              await tab.saveAndRerender();
              return;
            }
            await apiTry("删除财务分类", () => tab.plugin.api.deleteFinanceCategory(cat.id));
            await tab.pullListsFromApiToSettings();
            new Notice("已删除（软删）");
            tab.display();
            tab.plugin.refreshSidePanel();
            return;
          }

          tab.plugin.settings.financeCategories.splice(idx, 1);
          await tab.saveAndRerender();
        });
      });

      if (!cat.active) row.settingEl.addClass("is-inactive");
    });

    tab.refreshFinanceValidationMarks(financeWrap);

    new Setting(financeWrap).addButton((btn) =>
      btn.setButtonText("+ 新增财务分类").setCta().onClick(async () => {
        // ✅ 检查最大值限制（50个）
        const MAX_ITEMS = 50;
        if (tab.plugin.settings.financeCategories.length >= MAX_ITEMS) {
          new Notice(`财务分类清单最多只能有 ${MAX_ITEMS} 个，请先删除一些条目再添加`);
          return;
        }
        
        const id = await tab.plugin.recordRSLatte?.genUniqueListId("CW", {
          checkinItems: tab.plugin.settings.checkinItems,
          financeCategories: tab.plugin.settings.financeCategories,
        });
        tab.plugin.settings.financeCategories.push({
          id: id || tab.genId("CW"),
          name: "新分类",
          type: "expense",
          active: true,
          fromDb: false,
          subCategories: [], // ✅ 初始化子分类列表
        });
        await tab.saveAndRerender();
      })
    );
    // NOTE: 已移除“打卡热力图文件路径 / 财务统计文件路径”配置与侧边栏跳转按钮

    new Setting(financeWrap)
      .setName("侧边栏展示财务支出饼图")
      .setDesc("控制打卡管理侧边栏中的本月/上月支出饼图是否展示")
      .addToggle((tog) => {
        tog.setValue(tab.plugin.settings.rslattePanelShowFinancePieCharts !== false);
        tog.onChange(async (v) => {
          tab.plugin.settings.rslattePanelShowFinancePieCharts = v;
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });

    //（日记管理相关选项已上移到“日记管理”章节）



    // ✅ 加载“历史已删除 ID（tombstone）”冲突集合，用于设置页直接高亮提示
    // 异步执行，不阻塞 UI 首屏渲染
    void tab.loadListTombstoneConflicts().then(() => {
      tab.refreshFinanceValidationMarks(financeWrap);
    });

    // =========================
    // Side Panel 2：任务管理
    // =========================
  } catch (e: any) {
    console.error("[RSLatte][settings][renderFinanceSettings] render failed", e);
    try { new Notice("设置渲染失败（renderFinanceSettings），请查看 Console"); } catch {}
  }
}
