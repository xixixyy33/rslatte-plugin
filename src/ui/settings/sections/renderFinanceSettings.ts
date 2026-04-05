// Auto-split from RSLatteSettingTab.ts to reduce file size and isolate failures.
import { Notice, Setting } from "obsidian";
import { apiTry } from "../../../api";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type {
  FinanceBudgetConfigFile,
  FinanceCatDef,
  FinanceCyclePlanRow,
  FinanceDataPoolConfigFile,
  FinanceDataPoolItem,
} from "../../../types/rslatteTypes";
import { FINANCE_CYCLE_LABELS, normalizeFinanceCycleType, type FinanceCycleType } from "../../../types/rslatteTypes";
import { generateFinanceCyclePlanId } from "../../../services/finance/financeCyclePlan";
import {
  buildFinanceListItemLine,
  buildFinanceMainNoteParts,
  stringifyFinanceMetaComment,
} from "../../../services/finance/financeJournalMeta";
import { extractFinanceMeta } from "../../../services/finance/financeSubcategory";
import { validateFinanceRuleConfig } from "../../../services/finance/financeRuleValidator";
import {
  cloneDefaultFinanceBudgetConfig,
  cloneDefaultFinancePoolConfig,
  cloneDefaultFinanceRulesConfig,
} from "../../../constants/defaultFinanceVaultConfig";
import { todayLocalYmd, toLocalOffsetIsoString } from "../../../utils/localCalendarYmd";

export type ModuleWrapFactory = (moduleKey: any, title: string, scopeTag?: "global" | "space") => HTMLElement;
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
    const FINANCE_IMPORT_EXPORT_SCHEMA_VERSION = 1;

    const ensureFolder = async (path: string) => {
      const p = String(path ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
      if (!p) return;
      const exists = await tab.plugin.app.vault.adapter.exists(p);
      if (exists) return;
      const parts = p.split("/").filter(Boolean);
      let cur = "";
      for (const seg of parts) {
        cur = cur ? `${cur}/${seg}` : seg;
        const ok = await tab.plugin.app.vault.adapter.exists(cur);
        if (!ok) {
          try {
            await tab.plugin.app.vault.createFolder(cur);
          } catch (e: any) {
            const msg = String(e?.message ?? e);
            if (msg.includes("Folder already exists") || msg.includes("EEXIST")) continue;
            throw e;
          }
        }
      }
    };

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
    finHeader.createDiv({ text: "机构名", cls: "col col-institutions" });
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
        if (!(cat as any).institutionNames) (cat as any).institutionNames = [];
        
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
          }).onclick = () => {
            // Obsidian/Electron 不支持 window.prompt，改为内联输入
            subCatList.querySelectorAll(".rslatte-subcat-inline-add").forEach((el) => el.remove());
            const box = subCatList.createDiv({ cls: "rslatte-subcat-inline-add" });
            const inp = box.createEl("input", {
              type: "text",
              cls: "rslatte-subcat-inline-input",
              attr: { placeholder: "子分类名称" },
            });
            const btnRow = box.createDiv({ cls: "rslatte-subcat-inline-actions" });
            const btnCancel = btnRow.createEl("button", { text: "取消" });
            const btnOk = btnRow.createEl("button", { text: "确定", cls: "mod-cta" });
            const tearDown = () => box.remove();
            btnCancel.onclick = (e) => {
              e.preventDefault();
              tearDown();
            };
            const submit = async () => {
              const normalized = (inp.value ?? "").trim();
              if (!normalized) {
                new Notice("请输入子分类名称");
                return;
              }
              if (!cat.subCategories) cat.subCategories = [];
              if (cat.subCategories.includes(normalized)) {
                new Notice("该子分类已存在");
                return;
              }
              cat.subCategories.push(normalized);
              await tab.saveAndRefreshSidePanelDebounced();
              tearDown();
              renderSubCategories();
            };
            btnOk.onclick = (e) => {
              e.preventDefault();
              void submit();
            };
            inp.addEventListener("keydown", (ev) => {
              if (ev.key === "Enter") {
                ev.preventDefault();
                void submit();
              }
              if (ev.key === "Escape") {
                ev.preventDefault();
                tearDown();
              }
            });
            inp.focus();
          };
        };
        renderSubCategories();

        // 机构名（按分类维护，一对多）
        const institutionCell = controlEl.createDiv({ cls: "col col-institutions" });
        const institutionList = institutionCell.createDiv({ cls: "rslatte-subcategories-list" });
        const renderInstitutions = () => {
          institutionList.empty();
          const arr = Array.isArray((cat as any).institutionNames) ? (cat as any).institutionNames : [];
          arr.forEach((name: string, instIdx: number) => {
            const tag = institutionList.createSpan({
              cls: "rslatte-subcategory-tag",
              text: String(name ?? ""),
            });
            const removeBtn = tag.createSpan({
              cls: "rslatte-subcategory-remove",
              text: "×",
              attr: { title: "删除机构名" },
            });
            removeBtn.onclick = async (e) => {
              e.stopPropagation();
              const cur = Array.isArray((cat as any).institutionNames) ? (cat as any).institutionNames : [];
              cur.splice(instIdx, 1);
              (cat as any).institutionNames = cur;
              await tab.saveAndRefreshSidePanelDebounced();
              renderInstitutions();
            };
          });
          institutionList.createSpan({
            cls: "rslatte-subcategory-add",
            text: "+ 添加",
            attr: { title: "添加机构名" },
          }).onclick = () => {
            institutionList.querySelectorAll(".rslatte-subcat-inline-add").forEach((el) => el.remove());
            const box = institutionList.createDiv({ cls: "rslatte-subcat-inline-add" });
            const inp = box.createEl("input", {
              type: "text",
              cls: "rslatte-subcat-inline-input",
              attr: { placeholder: "机构名" },
            });
            const btnRow = box.createDiv({ cls: "rslatte-subcat-inline-actions" });
            const btnCancel = btnRow.createEl("button", { text: "取消" });
            const btnOk = btnRow.createEl("button", { text: "确定", cls: "mod-cta" });
            const tearDown = () => box.remove();
            btnCancel.onclick = (e) => {
              e.preventDefault();
              tearDown();
            };
            const submit = async () => {
              const v = String(inp.value ?? "").trim().replace(/\s+/g, " ");
              if (!v) {
                new Notice("请输入机构名");
                return;
              }
              if (!(cat as any).institutionNames) (cat as any).institutionNames = [];
              const hit = ((cat as any).institutionNames as string[]).some((x) => String(x).trim() === v);
              if (hit) {
                new Notice("该机构名已存在");
                return;
              }
              (cat as any).institutionNames.push(v);
              await tab.saveAndRefreshSidePanelDebounced();
              tearDown();
              renderInstitutions();
            };
            btnOk.onclick = (e) => {
              e.preventDefault();
              void submit();
            };
            inp.addEventListener("keydown", (ev) => {
              if (ev.key === "Enter") {
                ev.preventDefault();
                void submit();
              } else if (ev.key === "Escape") {
                ev.preventDefault();
                tearDown();
              }
            });
            inp.focus();
          };
        };
        renderInstitutions();
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

    const normalizeImportedFinanceCategories = (raw: unknown): FinanceCatDef[] => {
      const arr = Array.isArray(raw) ? raw : [];
      const out: Array<FinanceCatDef & { institutionNames?: string[] }> = [];
      const idSet = new Set<string>();
      for (const it of arr as any[]) {
        const id = String(it?.id ?? "").trim();
        const name = String(it?.name ?? "").trim();
        const type = String(it?.type ?? "expense") === "income" ? "income" : "expense";
        const active = !!it?.active;
        const subCategories = Array.isArray(it?.subCategories)
          ? Array.from(new Set((it.subCategories as any[]).map((x) => String(x ?? "").trim()).filter(Boolean)))
          : [];
        const institutionNames = Array.isArray(it?.institutionNames)
          ? Array.from(
            new Set(
              (it.institutionNames as any[])
                .map((x) => String(x ?? "").trim().replace(/\s+/g, " "))
                .filter(Boolean)
            )
          )
          : [];
        if (!id || !name) continue;
        if (idSet.has(id)) continue;
        idSet.add(id);
        out.push({ id, name, type, active, fromDb: false, subCategories, institutionNames });
      }
      return out as FinanceCatDef[];
    };

    const exportFinanceCategoriesJson = () => {
      try {
        const items = (tab.plugin.settings.financeCategories ?? []).map((x: FinanceCatDef) => ({
          id: String(x.id ?? "").trim(),
          name: String(x.name ?? "").trim(),
          type: x.type === "income" ? "income" : "expense",
          active: !!x.active,
          subCategories: Array.isArray(x.subCategories)
            ? Array.from(new Set(x.subCategories.map((s) => String(s ?? "").trim()).filter(Boolean)))
            : [],
          institutionNames: Array.isArray((x as any).institutionNames)
            ? Array.from(
              new Set(
                ((x as any).institutionNames as any[])
                  .map((s) => String(s ?? "").trim().replace(/\s+/g, " "))
                  .filter(Boolean)
              )
            )
            : [],
        }));
        const payload = {
          schema_version: FINANCE_IMPORT_EXPORT_SCHEMA_VERSION,
          exported_at: toLocalOffsetIsoString(),
          items,
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        a.download = `finance-categories_${stamp}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        new Notice(`已导出财务分类（${items.length} 条）`);
      } catch (e: any) {
        new Notice(`导出失败：${String(e?.message ?? e).slice(0, 120)}`);
      }
    };

    const importFinanceCategoriesJson = async () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json,.json";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const text = await file.text();
          const parsed = JSON.parse(text);
          const src = Array.isArray(parsed)
            ? parsed
            : Array.isArray((parsed as any)?.items)
              ? (parsed as any).items
              : [];
          const items = normalizeImportedFinanceCategories(src);
          if (items.length === 0) {
            new Notice("导入失败：文件中没有可用的财务分类");
            return;
          }
          const MAX_ITEMS = 50;
          if (items.length > MAX_ITEMS) {
            new Notice(`导入失败：分类数量 ${items.length} 超过上限 ${MAX_ITEMS}`);
            return;
          }
          tab.plugin.settings.financeCategories = items;
          await tab.saveAndRerender();
          new Notice(`已导入财务分类（${items.length} 条）`);
        } catch (e: any) {
          new Notice(`导入失败：${String(e?.message ?? e).slice(0, 120)}`);
        }
      };
      input.click();
    };

    const actionsSetting = new Setting(financeWrap);
    actionsSetting.addButton((btn) =>
      btn.setButtonText("导出 JSON").onClick(() => {
        exportFinanceCategoriesJson();
      })
    );
    actionsSetting.addButton((btn) =>
      btn.setButtonText("导入 JSON").onClick(() => {
        void importFinanceCategoriesJson();
      })
    );
    actionsSetting.addButton((btn) =>
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

    // =========================
    // 数据池 JSON + 预算表（按空间独立文件）
    // =========================
    financeWrap.createEl("h5", { text: "数据池与预算表（JSON 维护 + 表格核查）" });
    financeWrap.createDiv({
      cls: "rslatte-modal-info",
      text: "加载顺序：先数据池（仅依赖财务分类）→ 再预算表（依赖池ID）→ 再规则JSON（后续接入）。下方表格仅用于核查与校验，不允许直接修改。",
    });

    const spaceRoot = String(tab.plugin.getSpaceIndexDir?.() ?? "").trim();
    const cfgDir = spaceRoot ? `${spaceRoot}/finance-config` : "";
    const poolPath = cfgDir ? `${cfgDir}/finance-data-pools.json` : "";
    const budgetPath = cfgDir ? `${cfgDir}/finance-budgets.json` : "";
    const rulesPath = cfgDir ? `${cfgDir}/finance-rules.json` : "";

    /** 与 docs/V2改造方案/05-01-财务统计优化方案JSON存档.md 三、四节一致 */
    const DEFAULT_POOL_TEMPLATE: FinanceDataPoolConfigFile = (() => {
      const o = cloneDefaultFinancePoolConfig();
      o.updated_at = toLocalOffsetIsoString();
      return o;
    })();
    const DEFAULT_BUDGET_TEMPLATE: FinanceBudgetConfigFile = (() => {
      const o = cloneDefaultFinanceBudgetConfig();
      o.updated_at = toLocalOffsetIsoString();
      return o;
    })();
    const DEFAULT_RULES_TEMPLATE: Record<string, unknown> = cloneDefaultFinanceRulesConfig();
    /** 「载入空模板」用最小骨架，与文档全量默认区分 */
    const EMPTY_FINANCE_RULES_TEMPLATE: Record<string, unknown> = {
      version: 1,
      defaults: {},
      assumptions: [],
      rules: {},
    };

    const normPoolId = (s: unknown) => String(s ?? "").trim();
    const normBudgetId = (s: unknown) => String(s ?? "").trim();
    const normCatId = (s: unknown) => String(s ?? "").trim();
    const normName = (s: unknown) => String(s ?? "").trim();
    const normStrList = (v: unknown) =>
      Array.from(
        new Set(
          (Array.isArray(v) ? v : [])
            .map((x) => String(x ?? "").trim().replace(/\s+/g, " "))
            .filter(Boolean)
        )
      );

    const readJsonTextOrDefault = async (path: string, fallbackObj: any): Promise<string> => {
      if (!path) return JSON.stringify(fallbackObj, null, 2);
      try {
        const ok = await tab.plugin.app.vault.adapter.exists(path);
        if (!ok) return JSON.stringify(fallbackObj, null, 2);
        const raw = await tab.plugin.app.vault.adapter.read(path);
        const txt = String(raw ?? "").trim();
        return txt || JSON.stringify(fallbackObj, null, 2);
      } catch {
        return JSON.stringify(fallbackObj, null, 2);
      }
    };

    const writeJsonText = async (path: string, txt: string) => {
      if (!path) {
        new Notice("当前空间 index 目录不可用，无法保存到文件");
        return;
      }
      await ensureFolder(cfgDir);
      await tab.plugin.app.vault.adapter.write(path, txt);
    };

    const poolTextKey = "_financePoolJsonText";
    const budgetTextKey = "_financeBudgetJsonText";
    const rulesTextKey = "_financeRulesJsonText";
    const getPoolText = () => String((tab as any)[poolTextKey] ?? "");
    const getBudgetText = () => String((tab as any)[budgetTextKey] ?? "");
    const getRulesText = () => String((tab as any)[rulesTextKey] ?? "");
    const setPoolText = (v: string) => (((tab as any)[poolTextKey] = v), v);
    const setBudgetText = (v: string) => (((tab as any)[budgetTextKey] = v), v);
    const setRulesText = (v: string) => (((tab as any)[rulesTextKey] = v), v);

    if (!(tab as any)._financePoolBudgetRulesLoadedOnce) {
      (tab as any)._financePoolBudgetRulesLoadedOnce = true;
      void (async () => {
        setPoolText(await readJsonTextOrDefault(poolPath, DEFAULT_POOL_TEMPLATE));
        setBudgetText(await readJsonTextOrDefault(budgetPath, DEFAULT_BUDGET_TEMPLATE));
        setRulesText(await readJsonTextOrDefault(rulesPath, DEFAULT_RULES_TEMPLATE));
        tab.display();
      })();
    }

    const parsePoolConfig = (txt: string): { file: FinanceDataPoolConfigFile | null; errors: string[]; items: FinanceDataPoolItem[] } => {
      const errors: string[] = [];
      try {
        const j = JSON.parse(String(txt ?? ""));
        if (!j || typeof j !== "object") return { file: null, errors: ["数据池 JSON 不是对象"], items: [] };
        if (Number((j as any).schema_version) !== 1) errors.push("数据池 schema_version 必须为 1");
        const itemsRaw = Array.isArray((j as any).items) ? (j as any).items : [];
        const items: FinanceDataPoolItem[] = [];
        for (const it of itemsRaw) {
          const poolId = normPoolId((it as any)?.poolId);
          const poolName = normName((it as any)?.poolName);
          const nodesRaw = Array.isArray((it as any)?.nodes) ? (it as any).nodes : [];
          // 兼容旧结构（单分类）
          const fallbackNode =
            nodesRaw.length === 0 && ((it as any)?.categoryId || (it as any)?.subCategories || (it as any)?.institutionNames)
              ? [{
                financeTypeId: normCatId((it as any)?.categoryId),
                financeTypeName: "",
                subCategories: (it as any)?.subCategories === "ALL" ? "ALL" : normStrList((it as any)?.subCategories),
                institutionNames:
                  (it as any)?.institutionNames === undefined || (it as any)?.institutionNames === "ALL"
                    ? "ALL"
                    : normStrList((it as any)?.institutionNames),
              }]
              : [];
          const finalNodesRaw = nodesRaw.length > 0 ? nodesRaw : fallbackNode;
          const nodes = finalNodesRaw
            .map((n: any) => ({
              financeTypeId: normCatId(n?.financeTypeId),
              financeTypeName: normName(n?.financeTypeName),
              subCategories: n?.subCategories === "ALL" ? "ALL" : normStrList(n?.subCategories),
              institutionNames:
                n?.institutionNames === undefined || n?.institutionNames === "ALL" ? "ALL" : normStrList(n?.institutionNames),
            }))
            .filter((n: any) => !!n.financeTypeId);
          if (!poolId || !poolName) {
            errors.push("存在 poolId/poolName 为空的条目");
            continue;
          }
          if (nodes.length === 0) {
            errors.push(`数据池 ${poolId} 未配置有效 nodes.financeTypeId`);
          }
          items.push({
            poolId,
            poolName,
            nodes,
          });
        }
        const file: FinanceDataPoolConfigFile = {
          schema_version: 1,
          updated_at: String((j as any).updated_at ?? toLocalOffsetIsoString()),
          items,
        };
        return { file, errors, items };
      } catch (e: any) {
        return { file: null, errors: [`数据池 JSON 解析失败：${String(e?.message ?? e).slice(0, 80)}`], items: [] };
      }
    };

    const parseBudgetConfig = (txt: string): { file: FinanceBudgetConfigFile | null; errors: string[]; items: any[] } => {
      const errors: string[] = [];
      try {
        const j = JSON.parse(String(txt ?? ""));
        if (!j || typeof j !== "object") return { file: null, errors: ["预算 JSON 不是对象"], items: [] };
        if (Number((j as any).schema_version) !== 1) errors.push("预算 schema_version 必须为 1");
        const itemsRaw = Array.isArray((j as any).items) ? (j as any).items : [];
        const items = itemsRaw.map((it: any) => ({
          budgetId: normBudgetId(it?.budgetId),
          budgetName: normName(it?.budgetName),
          poolId: normPoolId(it?.poolId),
          amount: Number(it?.amount ?? 0),
          timeGrain: "month",
          enabled: it?.enabled !== false,
        }));
        const file: FinanceBudgetConfigFile = {
          schema_version: 1,
          updated_at: String((j as any).updated_at ?? toLocalOffsetIsoString()),
          items,
        };
        return { file, errors, items };
      } catch (e: any) {
        return { file: null, errors: [`预算 JSON 解析失败：${String(e?.message ?? e).slice(0, 80)}`], items: [] };
      }
    };

    const renderPoolTable = (host: HTMLElement, poolItems: FinanceDataPoolItem[], poolErrors: string[]) => {
      host.empty();
      if (poolErrors.length) {
        host.createDiv({ cls: "rslatte-db-warn", text: poolErrors.join("；") });
      }
      const table = host.createDiv({ cls: "rslatte-fin-pool-table" });
      const head = table.createDiv({ cls: "rslatte-fin-pool-head" });
      ["poolId", "poolName", "financeTypeId", "financeTypeName", "subCategories", "institutionNames", "状态"].forEach((h) =>
        head.createDiv({ text: h })
      );
      const catIdSet = new Set((tab.plugin.settings.financeCategories ?? []).map((c: FinanceCatDef) => String(c.id ?? "").trim()));
      for (const it of poolItems) {
        const nodes = Array.isArray((it as any).nodes) ? (it as any).nodes : [];
        if (nodes.length === 0) {
          const row = table.createDiv({ cls: "rslatte-fin-pool-row" });
          row.createDiv({ text: it.poolId });
          row.createDiv({ text: it.poolName });
          row.createDiv({ text: "（无）", cls: "is-invalid-cell" });
          row.createDiv({ text: "（无）" });
          row.createDiv({ text: "（无）" });
          row.createDiv({ text: "（无）" });
          row.createDiv({ text: "nodes 为空", cls: "is-invalid-cell" });
          continue;
        }
        nodes.forEach((n: any, idx: number) => {
          const row = table.createDiv({ cls: "rslatte-fin-pool-row" });
          row.createDiv({ text: idx === 0 ? it.poolId : "↳" });
          row.createDiv({ text: idx === 0 ? it.poolName : "" });
          const missCat = !!n.financeTypeId && !catIdSet.has(n.financeTypeId);
          row.createDiv({ text: n.financeTypeId || "（未填写）", cls: missCat ? "is-invalid-cell" : "" });
          row.createDiv({ text: n.financeTypeName || "—" });
          row.createDiv({ text: n.subCategories === "ALL" ? "ALL" : (n.subCategories as string[]).join(", ") });
          row.createDiv({ text: (n.institutionNames ?? "ALL") === "ALL" ? "ALL" : (n.institutionNames as string[]).join(", ") });
          row.createDiv({ text: missCat ? "分类缺失" : "OK", cls: missCat ? "is-invalid-cell" : "" });
        });
      }
    };

    const renderBudgetTable = (host: HTMLElement, budgetItems: any[], budgetErrors: string[], poolItems: FinanceDataPoolItem[]) => {
      host.empty();
      if (budgetErrors.length) {
        host.createDiv({ cls: "rslatte-db-warn", text: budgetErrors.join("；") });
      }
      const poolIdSet = new Set(poolItems.map((x) => x.poolId));
      const table = host.createDiv({ cls: "rslatte-fin-budget-table" });
      const head = table.createDiv({ cls: "rslatte-fin-budget-head" });
      ["budgetId", "budgetName", "poolId", "amount", "enabled", "状态"].forEach((h) => head.createDiv({ text: h }));
      for (const it of budgetItems) {
        const row = table.createDiv({ cls: "rslatte-fin-budget-row" });
        row.createDiv({ text: it.budgetId });
        row.createDiv({ text: it.budgetName });
        const missPool = !!it.poolId && !poolIdSet.has(it.poolId);
        row.createDiv({ text: it.poolId || "（未填写）", cls: missPool ? "is-invalid-cell" : "" });
        row.createDiv({ text: Number.isFinite(it.amount) ? String(it.amount) : "0" });
        row.createDiv({ text: it.enabled ? "是" : "否" });
        row.createDiv({ text: missPool ? "池ID不存在" : "OK", cls: missPool ? "is-invalid-cell" : "" });
      }
    };

    const poolTextAreaHost = financeWrap.createDiv({ cls: "rslatte-fin-json-block" });
    const budgetTextAreaHost = financeWrap.createDiv({ cls: "rslatte-fin-json-block" });
    const poolTableHost = financeWrap.createDiv({ cls: "rslatte-fin-json-table-host" });
    const budgetTableHost = financeWrap.createDiv({ cls: "rslatte-fin-json-table-host" });
    const rulesTextAreaHost = financeWrap.createDiv({ cls: "rslatte-fin-json-block" });
    const rulesTableHost = financeWrap.createDiv({ cls: "rslatte-fin-json-table-host" });

    const rerenderPoolBudgetTables = () => {
      const p = parsePoolConfig(getPoolText());
      const b = parseBudgetConfig(getBudgetText());
      renderPoolTable(poolTableHost, p.items, p.errors);
      renderBudgetTable(budgetTableHost, b.items, b.errors, p.items);
    };

    const rerenderRulesTable = () => {
      const p = parsePoolConfig(getPoolText());
      const b = parseBudgetConfig(getBudgetText());
      const vr = validateFinanceRuleConfig({
        ruleText: getRulesText(),
        pool: p.file,
        budget: b.file,
      });
      rulesTableHost.empty();
      if (vr.issues.length) {
        const msg = vr.issues
          .slice(0, 20)
          .map((x) => (x.ruleId ? `[${x.ruleId}] ${x.message}` : x.message))
          .join("；");
        rulesTableHost.createDiv({ cls: "rslatte-db-warn", text: msg + (vr.issues.length > 20 ? `（另有 ${vr.issues.length - 20} 条）` : "") });
      }
      const rules = (vr.file?.rules ?? {}) as Record<string, any>;
      const table = rulesTableHost.createDiv({ cls: "rslatte-fin-rules-table" });
      const head = table.createDiv({ cls: "rslatte-fin-rules-head" });
      ["ruleId", "ruleName", "algorithmId", "targetPoolId", "budgetId", "enabled", "状态"].forEach((h) => head.createDiv({ text: h }));
      const issueByRule = new Map<string, string[]>();
      for (const it of vr.issues) {
        const rid = String(it.ruleId ?? "").trim();
        if (!rid) continue;
        const arr = issueByRule.get(rid) ?? [];
        arr.push(it.message);
        issueByRule.set(rid, arr);
      }
      for (const [rid, r] of Object.entries(rules)) {
        const row = table.createDiv({ cls: "rslatte-fin-rules-row" });
        const issues = issueByRule.get(rid) ?? [];
        row.createDiv({ text: rid, cls: issues.length ? "is-invalid-cell" : "" });
        row.createDiv({ text: String((r as any)?.ruleName ?? "") });
        row.createDiv({ text: String((r as any)?.algorithmId ?? "") });
        row.createDiv({ text: String((r as any)?.target?.targetPoolId ?? "") });
        row.createDiv({ text: String((r as any)?.target?.budgetId ?? "") });
        row.createDiv({ text: (r as any)?.enabled === false ? "否" : "是" });
        row.createDiv({ text: issues.length ? issues[0] : "OK", cls: issues.length ? "is-invalid-cell" : "" });
      }
    };

    new Setting(poolTextAreaHost)
      .setName("数据池 JSON（按空间保存）")
      .setDesc("先维护数据池；下方表格只读核查。分类缺失会标红。")
      .addTextArea((a) => {
        a.inputEl.rows = 8;
        a.setValue(getPoolText() || JSON.stringify(DEFAULT_POOL_TEMPLATE, null, 2));
        a.onChange((v) => {
          setPoolText(v);
          rerenderPoolBudgetTables();
        });
      });
    new Setting(poolTextAreaHost).addButton((b) =>
      b.setButtonText("保存到文件").setCta().onClick(async () => {
        try {
          await writeJsonText(poolPath, getPoolText());
          new Notice("已保存数据池 JSON");
        } catch (e: any) {
          new Notice(`保存失败：${String(e?.message ?? e).slice(0, 120)}`);
        }
      })
    ).addButton((b) =>
      b.setButtonText("载入推荐模板").onClick(async () => {
        const o = cloneDefaultFinancePoolConfig();
        o.updated_at = toLocalOffsetIsoString();
        setPoolText(JSON.stringify(o, null, 2));
        tab.display();
      })
    );

    new Setting(budgetTextAreaHost)
      .setName("预算表 JSON（按空间保存）")
      .setDesc("预算依赖 poolId；不存在会标红提示（该预算不生效）。")
      .addTextArea((a) => {
        a.inputEl.rows = 6;
        a.setValue(getBudgetText() || JSON.stringify(DEFAULT_BUDGET_TEMPLATE, null, 2));
        a.onChange((v) => {
          setBudgetText(v);
          rerenderPoolBudgetTables();
        });
      });
    new Setting(budgetTextAreaHost).addButton((b) =>
      b.setButtonText("保存到文件").setCta().onClick(async () => {
        try {
          await writeJsonText(budgetPath, getBudgetText());
          new Notice("已保存预算表 JSON");
        } catch (e: any) {
          new Notice(`保存失败：${String(e?.message ?? e).slice(0, 120)}`);
        }
      })
    ).addButton((b) =>
      b.setButtonText("载入推荐模板").onClick(async () => {
        const o = cloneDefaultFinanceBudgetConfig();
        o.updated_at = toLocalOffsetIsoString();
        setBudgetText(JSON.stringify(o, null, 2));
        tab.display();
      })
    );

    rerenderPoolBudgetTables();

    new Setting(rulesTextAreaHost)
      .setName("规则 JSON（按空间保存）")
      .setDesc("按当前业务需要维护完整规则 JSON；下方表格只读核查算法/池/预算引用与参数必填项。")
      .addTextArea((a) => {
        a.inputEl.rows = 10;
        a.setValue(getRulesText() || JSON.stringify(DEFAULT_RULES_TEMPLATE as object, null, 2));
        a.onChange((v) => {
          setRulesText(v);
          rerenderRulesTable();
        });
      });
    new Setting(rulesTextAreaHost).addButton((b) =>
      b.setButtonText("保存到文件").setCta().onClick(async () => {
        try {
          await writeJsonText(rulesPath, getRulesText());
          new Notice("已保存规则 JSON");
        } catch (e: any) {
          new Notice(`保存失败：${String(e?.message ?? e).slice(0, 120)}`);
        }
      })
    ).addButton((b) =>
      b.setButtonText("载入推荐模板").onClick(async () => {
        setRulesText(JSON.stringify(cloneDefaultFinanceRulesConfig() as object, null, 2));
        tab.display();
      })
    ).addButton((b) =>
      b.setButtonText("载入空模板").onClick(async () => {
        setRulesText(JSON.stringify(EMPTY_FINANCE_RULES_TEMPLATE, null, 2));
        tab.display();
      })
    );

    rerenderRulesTable();

    financeWrap.createEl("h5", { text: "币种与周期表" });
    new Setting(financeWrap)
      .setName("财务管理默认币种")
      .setDesc("用于展示与后续多币种。全量重建财务索引时，会将本节快照写入 index 目录 finance-management-settings.snapshot.json")
      .addText((t) => {
        t.setValue(String(tab.plugin.settings.financeManagementCurrency ?? "CNY"));
        t.onChange(async (v) => {
          tab.plugin.settings.financeManagementCurrency = v.trim() || "CNY";
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });

    if (!tab.plugin.settings.financeCyclePlans) tab.plugin.settings.financeCyclePlans = [];
    financeWrap.createEl("h5", { text: "周期表" });
    financeWrap.createDiv({
      cls: "rslatte-modal-info",
      text: "周期表：分类 + 子分类 + 机构 + 周期类型 与日记 meta 四元组匹配；meta.cycle_id 指向行 ID。已被索引引用时，请勿改周期类型与机构名（下拉与输入将锁定）。",
    });

    const allCyclePlans = tab.plugin.settings.financeCyclePlans;
    const visibleCyclePlans = allCyclePlans.filter((p: FinanceCyclePlanRow) => !String((p as FinanceCyclePlanRow).deletedAt ?? "").trim());
    const referencedCycleIds = new Set<string>(
      Array.isArray((tab as any)._financeReferencedCycleIds) ? (tab as any)._financeReferencedCycleIds : []
    );
    const referencedLoaded = !!(tab as any)._financeReferencedCycleIdsLoaded;
    if (!referencedLoaded && !(tab as any)._financeReferencedCycleIdsLoading) {
      (tab as any)._financeReferencedCycleIdsLoading = true;
      void (async () => {
        try {
          const active = await tab.plugin.recordRSLatte?.getFinanceSnapshot?.(false);
          const arch = await tab.plugin.recordRSLatte?.getFinanceSnapshot?.(true);
          const items = [...(active?.items ?? []), ...(arch?.items ?? [])] as any[];
          const ids = Array.from(
            new Set(
              items
                .map((x) => String(x?.cycleId ?? x?.cycle_id ?? "").trim())
                .filter((x) => !!x && x !== "none")
            )
          );
          (tab as any)._financeReferencedCycleIds = ids;
        } catch {
          // ignore
        } finally {
          (tab as any)._financeReferencedCycleIdsLoading = false;
          (tab as any)._financeReferencedCycleIdsLoaded = true;
          tab.display();
        }
      })();
    }
    const cycleHost = financeWrap.createDiv({ cls: "rslatte-finance-cycle-plans-block" });
    const cycleHeader = cycleHost.createDiv({ cls: "rslatte-finance-cycle-plan-head" });
    cycleHeader.createSpan({ text: "周期ID" });
    cycleHeader.createSpan({ text: "分类" });
    cycleHeader.createSpan({ text: "子分类" });
    cycleHeader.createSpan({ text: "机构名" });
    cycleHeader.createSpan({ text: "周期类型" });
    cycleHeader.createSpan({ text: "锚点日期" });
    cycleHeader.createSpan({ text: "引用" });
    cycleHeader.createSpan({ text: "宽限天数" });
    cycleHeader.createSpan({ text: "启用" });
    cycleHeader.createSpan({ text: "操作" });

    const copyTextToClipboard = async (text: string): Promise<boolean> => {
      const val = String(text ?? "").trim();
      if (!val) return false;
      try {
        await navigator.clipboard.writeText(val);
        return true;
      } catch {
        try {
          const ta = document.createElement("textarea");
          ta.value = val;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          const ok = document.execCommand("copy");
          ta.remove();
          return !!ok;
        } catch {
          return false;
        }
      }
    };

    const syncMetaCycleTypeByCycleId = async (cycleId: string, cycleType: FinanceCycleType): Promise<void> => {
      const cid = String(cycleId ?? "").trim();
      if (!cid) return;
      try {
        const active = await tab.plugin.recordRSLatte?.getFinanceSnapshot?.(false);
        const arch = await tab.plugin.recordRSLatte?.getFinanceSnapshot?.(true);
        const items = [...(active?.items ?? []), ...(arch?.items ?? [])] as any[];
        const targets = items.filter((x) => {
          const id = String(x?.cycleId ?? x?.cycle_id ?? "").trim();
          const entryId = String(x?.entry_id ?? x?.entryId ?? "").trim();
          const dateKey = String(x?.record_date ?? x?.recordDate ?? "").trim();
          return id === cid && !!entryId && !!dateKey;
        });
        const replacer = (tab.plugin as any).replaceFinanceJournalPairByEntryId as
          | ((dateKey: string, entryId: string, newPair: string[]) => Promise<boolean>)
          | undefined;
        if (!replacer) return;
        let updated = 0;
        for (const r of targets) {
          const entryId = String(r.entry_id ?? r.entryId ?? "").trim();
          const dateKey = String(r.record_date ?? r.recordDate ?? "").trim();
          if (!entryId || !dateKey) continue;
          const parsed = extractFinanceMeta(String(r.note ?? ""));
          const sub = String(r.subcategory ?? "").trim() || parsed.subcategory || "";
          const noteMain = buildFinanceMainNoteParts({
            subcategory: sub,
            institutionName: parsed.institutionName,
            cycleType: cycleType,
            bodyNote: parsed.body,
          });
          const categoryId = String(r.category_id ?? r.categoryId ?? "").trim();
          const category = (tab.plugin.settings.financeCategories ?? []).find((c: any) => c.id === categoryId);
          const categoryName = String(category?.name ?? categoryId ?? "");
          const type = String(r.type ?? "") === "income" ? "income" : "expense";
          const amount = Number(r.amount ?? 0);
          const isDelete =
            r.is_delete === true ||
            r.isDelete === true ||
            String(r.is_delete || r.isDelete || "").toLowerCase() === "true";
          const mainLine = buildFinanceListItemLine({
            dateKey,
            type,
            categoryId,
            categoryDisplayName: categoryName,
            noteMain: noteMain || "-",
            signedAmount: amount,
            isDelete,
          });
          const metaLine = stringifyFinanceMetaComment({
            entry_id: entryId,
            subcategory: sub || "未分类",
            institution_name: parsed.institutionName || undefined,
            cycle_type: cycleType,
            cycle_id: cid,
            scene_tags: parsed.sceneTags,
            is_delete: isDelete,
          });
          const ok = await replacer(dateKey, entryId, [mainLine, metaLine]);
          if (ok) updated++;
        }
        if (updated > 0) {
          new Notice(`已同步 ${updated} 条流水 meta.cycle_type`);
        }
      } catch (e) {
        console.warn("[RSLatte] sync cycle_type by cycle_id failed", e);
      }
    };

    for (const row of visibleCyclePlans) {
      const isReferenced = !!row.referenced || referencedCycleIds.has(String(row.id ?? "").trim());
      const srow = new Setting(cycleHost).setName("");
      srow.settingEl.addClass("rslatte-finance-cycle-plan-row");
      const lockFields = true; // 已保存周期项：锁定分类/子分类/机构名
      const catDefs = tab.plugin.settings.financeCategories ?? [];
      const currentCat = catDefs.find((c: FinanceCatDef) => c.id === row.catId);
      const subOptions = Array.isArray((currentCat as any)?.subCategories) ? (currentCat as any).subCategories : [];
      const instOptions = Array.isArray((currentCat as any)?.institutionNames) ? (currentCat as any).institutionNames : [];

      const controlEl = srow.settingEl.querySelector(".setting-item-control") as HTMLElement | null;
      if (controlEl) {
        controlEl.createDiv({ cls: "rslatte-finance-cycle-id", text: String(row.id ?? "").trim() });
      }
      srow.addDropdown((dd) => {
        dd.addOption("", "（分类）");
        for (const c of catDefs) dd.addOption(c.id, `${c.name} (${c.id})`);
        dd.setValue(String(row.catId ?? ""));
        dd.setDisabled(lockFields);
        dd.onChange(async (v) => {
          row.catId = String(v ?? "").trim();
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });
      srow.addDropdown((dd) => {
        dd.addOption("", "（子分类）");
        for (const s of subOptions) dd.addOption(String(s), String(s));
        const cur = String(row.subcategory ?? "").trim();
        if (cur && !subOptions.includes(cur)) dd.addOption(cur, `（已失效）${cur}`);
        dd.setValue(cur);
        dd.setDisabled(lockFields);
        dd.onChange(async (v) => {
          row.subcategory = String(v ?? "").trim();
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });
      srow.addDropdown((dd) => {
        dd.addOption("", "（机构名）");
        for (const s of instOptions) dd.addOption(String(s), String(s));
        const cur = String(row.institutionName ?? "").trim();
        if (cur && !instOptions.includes(cur)) dd.addOption(cur, `（已失效）${cur}`);
        dd.setValue(cur);
        dd.setDisabled(lockFields);
        dd.onChange(async (v) => {
          row.institutionName = String(v ?? "").trim().replace(/\s+/g, " ");
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });
      srow.addDropdown((dd) => {
        for (const k of Object.keys(FINANCE_CYCLE_LABELS) as FinanceCycleType[]) {
          if (k === "none") continue;
          dd.addOption(k, FINANCE_CYCLE_LABELS[k]);
        }
        dd.setValue(normalizeFinanceCycleType(row.cycleType) === "none" ? "monthly" : normalizeFinanceCycleType(row.cycleType));
        dd.onChange(async (v) => {
          const next = normalizeFinanceCycleType(v);
          row.cycleType = next;
          await tab.saveAndRefreshSidePanelDebounced();
          await syncMetaCycleTypeByCycleId(String(row.id ?? ""), next);
        });
      });
      srow.addText((t) => {
        t.inputEl.type = "date";
        t.setValue(String(row.anchorDate ?? "").slice(0, 10));
        t.onChange(async (v) => {
          row.anchorDate = (v || "").trim().slice(0, 10);
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });
      srow.addButton((btn) => {
        btn.setButtonText(isReferenced ? "●" : "○");
        btn.buttonEl.addClass("rslatte-finance-cycle-ref-lamp", isReferenced ? "is-on" : "is-off");
        btn.setTooltip(isReferenced ? "已被流水引用" : "未被流水引用");
      });
      srow.addText((t) => {
        t.inputEl.type = "number";
        t.inputEl.min = "0";
        t.inputEl.step = "1";
        const cur = Number.isFinite(Number(row.graceDays)) ? Math.max(0, Math.floor(Number(row.graceDays))) : 3;
        t.setValue(String(cur));
        t.onChange(async (v) => {
          const n = Number(v);
          row.graceDays = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 3;
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });
      srow.addToggle((tog) => {
        tog.setValue(row.enabled !== false).onChange(async (v) => {
          row.enabled = v;
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });
      srow.addButton((btn) => {
        btn.setButtonText("复制ID").onClick(async () => {
          const ok = await copyTextToClipboard(String(row.id ?? ""));
          if (!ok) {
            new Notice("复制失败，请手动复制");
            return;
          }
          new Notice(`已复制周期ID：${row.id}`);
        });
      });
      srow.addExtraButton((b) => {
        b.setIcon("trash");
        b.setTooltip("软删除（保留于配置中）");
        b.onClick(async () => {
          if (row.referenced) {
            new Notice("该项已被流水引用，请先在日记中更新或关闭周期行后再软删");
            return;
          }
          const ok = confirm(`软删周期计划 ${row.id}？`);
          if (!ok) return;
          (row as FinanceCyclePlanRow).deletedAt = toLocalOffsetIsoString();
          await tab.saveAndRerender();
        });
      });
      // 行内已用独立列展示：引用/宽限天数/启用，无需重复文字描述
    }
    type FinanceCyclePlanDraft = {
      catId: string;
      subcategory: string;
      institutionName: string;
      cycleType: FinanceCycleType;
      anchorDate: string;
      graceDays: number;
    };
    const getDraft = (): FinanceCyclePlanDraft | null => ((tab as any)._financeCyclePlanDraft ?? null) as FinanceCyclePlanDraft | null;
    const setDraft = (v: FinanceCyclePlanDraft | null) => {
      (tab as any)._financeCyclePlanDraft = v;
    };

    const draft = getDraft();
    if (draft) {
      const drow = new Setting(cycleHost).setName("");
      drow.settingEl.addClass("rslatte-finance-cycle-plan-row", "is-draft");
      const ctrl = drow.settingEl.querySelector(".setting-item-control") as HTMLElement | null;
      if (ctrl) {
        ctrl.createDiv({ cls: "rslatte-finance-cycle-id is-draft", text: "（未保存）" });
      }
      const catDefs = tab.plugin.settings.financeCategories ?? [];
      const currentCat = catDefs.find((c: FinanceCatDef) => c.id === draft.catId);
      const subOptions = Array.isArray((currentCat as any)?.subCategories) ? (currentCat as any).subCategories : [];
      const instOptions = Array.isArray((currentCat as any)?.institutionNames) ? (currentCat as any).institutionNames : [];
      drow.addDropdown((dd) => {
        dd.addOption("", "（分类）");
        for (const c of catDefs) {
          dd.addOption(c.id, `${c.name} (${c.id})`);
        }
        dd.setValue(draft.catId ?? "");
        dd.onChange(async (v) => {
          draft.catId = String(v ?? "").trim();
          draft.subcategory = "";
          draft.institutionName = "";
          await tab.saveAndRerender();
        });
      });
      drow.addDropdown((dd) => {
        dd.addOption("", "（子分类）");
        for (const s of subOptions) dd.addOption(String(s), String(s));
        dd.setValue(String(draft.subcategory ?? ""));
        dd.onChange((v) => {
          draft.subcategory = String(v ?? "").trim();
        });
      });
      drow.addDropdown((dd) => {
        dd.addOption("", "（机构名）");
        for (const s of instOptions) dd.addOption(String(s), String(s));
        dd.setValue(String(draft.institutionName ?? ""));
        dd.onChange((v) => {
          draft.institutionName = String(v ?? "").trim().replace(/\s+/g, " ");
        });
      });
      drow.addDropdown((dd) => {
        for (const k of Object.keys(FINANCE_CYCLE_LABELS) as FinanceCycleType[]) {
          if (k === "none") continue;
          dd.addOption(k, FINANCE_CYCLE_LABELS[k]);
        }
        dd.setValue(normalizeFinanceCycleType(draft.cycleType) === "none" ? "monthly" : normalizeFinanceCycleType(draft.cycleType));
        dd.onChange((v) => {
          draft.cycleType = normalizeFinanceCycleType(v);
        });
      });
      drow.addText((t) => {
        t.inputEl.type = "date";
        t.setValue(String(draft.anchorDate ?? "").slice(0, 10));
        t.onChange((v) => {
          draft.anchorDate = (v || "").trim().slice(0, 10);
        });
      });
      drow.addButton((btn) => {
        btn.setButtonText("○");
        btn.setTooltip("未保存草稿，尚未引用");
        btn.buttonEl.addClass("rslatte-finance-cycle-ref-lamp", "is-off");
      });
      drow.addText((t) => {
        t.inputEl.type = "number";
        t.inputEl.min = "0";
        t.inputEl.step = "1";
        t.setValue(String(Number.isFinite(Number(draft.graceDays)) ? Math.max(0, Math.floor(Number(draft.graceDays))) : 3));
        t.onChange((v) => {
          const n = Number(v);
          draft.graceDays = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 3;
        });
      });
      drow.addToggle((tog) => {
        tog.setValue(true).setDisabled(true);
      });
      drow.addButton((b) => {
        b.setButtonText("保存").setCta().onClick(async () => {
          const catId = String(draft.catId ?? "").trim();
          const subcategory = String(draft.subcategory ?? "").trim();
          const institutionName = String(draft.institutionName ?? "").trim().replace(/\s+/g, " ");
          const cycleType = normalizeFinanceCycleType(draft.cycleType);
          const anchorDate = String(draft.anchorDate ?? "").trim().slice(0, 10);
          if (!catId) {
            new Notice("请先选择分类");
            return;
          }
          if (!subcategory) {
            new Notice("请先填写子分类");
            return;
          }
          if (!institutionName) {
            new Notice("请先填写机构名");
            return;
          }
          if (!anchorDate) {
            new Notice("请先选择锚点日期");
            return;
          }
          allCyclePlans.push({
            id: generateFinanceCyclePlanId(),
            catId,
            subcategory,
            institutionName,
            cycleType: cycleType === "none" ? "monthly" : cycleType,
            anchorDate,
            graceDays: Number.isFinite(Number(draft.graceDays)) ? Math.max(0, Math.floor(Number(draft.graceDays))) : 3,
            enabled: true,
            referenced: false,
          });
          setDraft(null);
          await tab.saveAndRerender();
        });
      });
      drow.addButton((b) => {
        b.setButtonText("取消").onClick(async () => {
          setDraft(null);
          await tab.saveAndRerender();
        });
      });
    }

    if (visibleCyclePlans.length === 0 && !draft) {
      cycleHost.createDiv({ cls: "rslatte-muted", text: "暂无周期项，请点击下方按钮新增。" });
    }

    new Setting(financeWrap).addButton((b) =>
      b.setButtonText("+ 添加周期项").onClick(async () => {
        const existDraft = getDraft();
        if (existDraft) {
          new Notice("当前有未保存的周期项，请先保存或取消");
          return;
        }
        const cats = tab.plugin.settings.financeCategories ?? [];
        const firstId = cats[0]?.id ?? "";
        setDraft({
          catId: firstId,
          subcategory: "",
          institutionName: "",
          cycleType: "monthly",
          anchorDate: todayLocalYmd(),
          graceDays: 3,
        });
        await tab.saveAndRerender();
      })
    );

    new Setting(financeWrap)
      .setName("机构名相似提示 · 忽略列表")
      .setDesc("逗号分隔；归一化后与输入一致则不再提示「相似机构名」")
      .addTextArea((a) => {
        a.inputEl.rows = 2;
        a.setValue((tab.plugin.settings.financeInstitutionSimilarIgnore ?? []).join(", "));
        a.onChange(async (v) => {
          tab.plugin.settings.financeInstitutionSimilarIgnore = v
            .split(/[,，]/)
            .map((x) => x.trim())
            .filter(Boolean);
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });

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
