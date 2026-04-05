import { App, ButtonComponent, Modal, Notice, Setting, TextComponent } from "obsidian";
import moment from "moment";
import type RSLattePlugin from "../../main";
import { extractFinanceMeta, normalizeFinanceSubcategory } from "../../services/finance/financeSubcategory";
import {
  buildFinanceListItemLine,
  buildFinanceMainNoteParts,
  generateFinanceEntryId,
  stringifyFinanceMetaComment,
} from "../../services/finance/financeJournalMeta";
import { FINANCE_CYCLE_LABELS, normalizeFinanceCycleType, type FinanceCycleType } from "../../types/rslatteTypes";
import { interactiveResolveCycleMetaForSave } from "../../services/finance/financeCycleInteractive";
import { findAnyEnabledFinanceCyclePlanSameTriple, findConflictingEnabledFinanceCyclePlan } from "../../services/finance/financeCyclePlan";
import {
  collectAllFinanceInstitutionNames,
  suggestSimilarInstitutionNames,
} from "../../services/finance/financeInstitutionSimilarity";

const momentFn = moment as any;

/**
 * 新增财务记录弹窗（支持选择日期）
 * - 可以选择任意日期（支持历史补录）
 * - 提供财务分类、子分类、金额、备注字段
 * - 确认后插入到指定日期的日记中
 */
export class AddFinanceRecordModal extends Modal {
  private onSuccess?: (dateKey?: string) => void;

  constructor(app: App, private plugin: RSLattePlugin, onSuccess?: (dateKey?: string) => void) {
    super(app);
    this.onSuccess = onSuccess;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    this.titleEl.setText("新增财务记录");

    const categories = this.plugin.settings.financeCategories.filter((x) => x.active);
    if (categories.length === 0) {
      contentEl.createDiv({ cls: "rslatte-muted", text: "请先在设置页添加财务分类" });
      new ButtonComponent(contentEl).setButtonText("关闭").onClick(() => this.close());
      return;
    }

    let selectedDate = momentFn().format("YYYY-MM-DD");
    let selectedCategoryId = "";
    let amountRaw = "";
    let note = "";
    let subcategory = "";
    let institutionName = "";
    let cycleType: FinanceCycleType = "none";
    let sceneTags: string[] = [];

    let dateInput!: TextComponent;
    let categorySelect!: any;
    let amountText!: TextComponent;
    let noteText!: TextComponent;
    let subcategoryText!: TextComponent;
    let saveBtn!: ButtonComponent;
    let inFlight = false;
    let institutionDdComp: any = null;
    let institutionTxtComp: any = null;
    let sceneTagsPool: string[] = [];
    let sceneTagsWrap: HTMLElement | null = null;
    let instSimilarEl: HTMLElement | null = null;
    let cycleHintEl: HTMLElement | null = null;
    let institutionRowEl: HTMLElement | null = null;
    let cycleRowEl: HTMLElement | null = null;
    let cycleDdEl: HTMLSelectElement | null = null;
    const INST_MANUAL = "__manual__";
    const INST_NONE = "";

    const getCycleConflict = () => {
      if (!selectedCategoryId) return null;
      const sub = normalizeFinanceSubcategory(subcategory);
      const inst = String(institutionName ?? "").trim();
      if (!sub || !inst || cycleType === "none") return null;
      return findConflictingEnabledFinanceCyclePlan(
        this.plugin.settings.financeCyclePlans,
        selectedCategoryId,
        sub,
        inst,
        cycleType
      );
    };

    const validate = () => {
      // 验证日期格式
      if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) return false;
      // 验证分类
      if (!selectedCategoryId) return false;
      // 验证金额
      const n = Number(amountRaw);
      if (!(Number.isFinite(n) && n > 0)) return false;
      // 周期不为无周期时，机构必填
      if (cycleType !== "none" && !institutionName.trim()) return false;
      if (getCycleConflict()) return false;
      return true;
    };

    const setInFlight = (v: boolean) => {
      inFlight = v;
      try {
        saveBtn?.setDisabled(v || !validate());
      } catch { }
      try {
        (dateInput as any)?.setDisabled?.(v);
        (categorySelect as any)?.setDisabled?.(v);
        (amountText as any)?.setDisabled?.(v);
        (noteText as any)?.setDisabled?.(v);
        (subcategoryText as any)?.setDisabled?.(v);
        (institutionTxtComp as any)?.setDisabled?.(v);
        (institutionDdComp as any)?.setDisabled?.(v);
      } catch { }
    };

    const refreshValidation = () => {
      const ok = validate();
      if (saveBtn) saveBtn.setDisabled(inFlight || !ok);
      return ok;
    };

    const refreshAuxHints = () => {
      try {
        if (instSimilarEl) {
          instSimilarEl.empty();
          const all = collectAllFinanceInstitutionNames(this.plugin.settings.financeCategories);
          const sug = suggestSimilarInstitutionNames(
            institutionName,
            all,
            this.plugin.settings.financeInstitutionSimilarIgnore
          );
          const hasSimilar = sug.length > 0;
          institutionTxtComp?.inputEl?.classList?.toggle("rslatte-input-warning", hasSimilar);
          institutionDdComp?.selectEl?.classList?.toggle("rslatte-input-warning", hasSimilar);
          institutionRowEl?.classList?.toggle("rslatte-warning-row", hasSimilar);
          if (sug.length) {
            const box = instSimilarEl.createDiv({ cls: "rslatte-finance-inline-hint rslatte-finance-inline-hint-warning" });
            box.createSpan({ text: "机构名与已有 " });
            sug.forEach((name, idx) => {
              if (idx > 0) box.createSpan({ text: "、" });
              box.createEl("b", { text: `「${name}」` });
            });
            box.createSpan({ text: " 较接近，可优先选用以减少分裂（非强制）。" });
          }
        }
        if (cycleHintEl) {
          cycleHintEl.empty();
          const conflict = getCycleConflict();
          cycleDdEl?.classList?.toggle("is-invalid", !!conflict);
          cycleRowEl?.classList?.toggle("is-invalid-row", !!conflict);
          if (conflict) {
            const box = cycleHintEl.createDiv({ cls: "rslatte-finance-inline-hint rslatte-finance-inline-hint-error" });
            box.createSpan({ text: "周期冲突：本分类+子类+机构已存在 " });
            box.createEl("b", { text: `「${FINANCE_CYCLE_LABELS[normalizeFinanceCycleType(conflict.cycleType)]}」` });
            box.createSpan({ text: `，当前选择「${FINANCE_CYCLE_LABELS[cycleType]}」不可保存。请改为已存在周期或改为「无周期」。` });
            return;
          }
          if (cycleType === "none" && selectedCategoryId && normalizeFinanceSubcategory(subcategory) && institutionName.trim()) {
            const hit = findAnyEnabledFinanceCyclePlanSameTriple(
              this.plugin.settings.financeCyclePlans,
              selectedCategoryId,
              subcategory,
              institutionName
            );
            if (hit) {
              const box = cycleHintEl.createDiv({ cls: "rslatte-finance-inline-hint rslatte-finance-inline-hint-info" });
              box.createSpan({ text: "提示：周期表已有 " });
              box.createEl("b", { text: `「${FINANCE_CYCLE_LABELS[normalizeFinanceCycleType(hit.cycleType)]}」` });
              box.createSpan({ text: " 与本条分类+子类+机构一致；当前记为无周期流水（允许）。" });
            }
          }
        }
      } catch {
        /* ignore */
      }
    };

    // ===== 日期选择 =====
    new Setting(contentEl)
      .setName("日期")
      .setDesc("选择记录日期（支持历史补录）")
      .addText((t) => {
        dateInput = t;
        t.inputEl.type = "date";
        t.setValue(selectedDate);
        t.onChange((v) => {
          selectedDate = (v || "").trim();
          refreshValidation();
        });
      });

    // ===== 财务分类 =====
    // 预加载已知子分类（当分类改变时更新）
    let knownSubs: string[] = [];
    let knownInstitutions: string[] = [];
    const loadKnownSubs = async (catId: string) => {
      if (!catId) {
        knownSubs = [];
        return;
      }
      try {
        knownSubs = await this.plugin.recordRSLatte?.getFinanceSubcategories?.(catId) ?? [];
      } catch {
        knownSubs = [];
      }
    };
    const loadKnownInstitutions = async (catId: string) => {
      if (!catId) {
        knownInstitutions = [];
        return;
      }
      try {
        knownInstitutions = await this.plugin.recordRSLatte?.getFinanceInstitutions?.(catId) ?? [];
      } catch {
        knownInstitutions = [];
      }
      // fallback to settings list
      if (knownInstitutions.length === 0) {
        const cat = this.plugin.settings.financeCategories.find((x) => x.id === catId) as any;
        knownInstitutions = Array.isArray(cat?.institutionNames) ? cat.institutionNames : [];
      }
    };
    const loadSceneTagsHistory = async () => {
      try {
        sceneTagsPool = await this.plugin.recordRSLatte?.getFinanceSceneTagsHistory?.() ?? [];
      } catch {
        sceneTagsPool = [];
      }
    };
    
    // 子分类UI：下拉框 + 手动输入（与 FinanceRecordModal 一致）
    const MANUAL = "__manual__";
    const NONE = "";
    let ddComp: any = null;
    let txtComp: any = null;
    
    new Setting(contentEl)
      .setName("财务分类")
      .setDesc("选择财务分类（必填）")
      .addDropdown((dd) => {
        categorySelect = dd;
        dd.addOption("", "请选择");
        for (const cat of categories) {
          dd.addOption(cat.id, cat.name);
        }
        dd.onChange(async (v: string) => {
          selectedCategoryId = v;
          // ✅ 当分类改变时，清空子分类并更新子分类列表
          subcategory = "";
          institutionName = "";
          if (txtComp) {
            try { txtComp.setValue(""); } catch {}
          }
          if (institutionTxtComp) {
            try { institutionTxtComp.setValue(""); } catch {}
          }
          if (ddComp) {
            try { ddComp.setValue(NONE); } catch {}
          }
          if (institutionDdComp) {
            try { institutionDdComp.setValue(INST_NONE); } catch {}
          }
          await loadKnownSubs(v);
          await loadKnownInstitutions(v);
          // 重新渲染下拉框选项（延迟执行，确保 ddComp 已创建）
          window.setTimeout(() => {
            if (ddComp) {
              try {
                ddComp.selectEl.empty();
                ddComp.addOption(NONE, "（无）");
                for (const s of knownSubs) ddComp.addOption(s, s);
                ddComp.addOption(MANUAL, "手动输入");
                ddComp.setValue(NONE);
              } catch (e) {
                console.warn("更新子分类下拉框失败", e);
              }
            }
            if (institutionDdComp) {
              try {
                institutionDdComp.selectEl.empty();
                institutionDdComp.addOption(INST_NONE, "（无）");
                for (const s of knownInstitutions) institutionDdComp.addOption(s, s);
                institutionDdComp.addOption(INST_MANUAL, "手动输入");
                institutionDdComp.setValue(INST_NONE);
              } catch (e) {
                console.warn("更新机构名下拉框失败", e);
              }
            }
          }, 0);
          refreshValidation();
          refreshAuxHints();
        });
      });

    // ===== 子分类（紧跟在财务分类后面） =====
    {
      const row = new Setting(contentEl)
        .setName("子分类")
        .setDesc("可选；保存后会以【子分类】前缀写入到备注最前方（不入库管理）");

      row.addDropdown((dd) => {
        ddComp = dd;
        dd.addOption(NONE, "（无）");
        for (const s of knownSubs) dd.addOption(s, s);
        dd.addOption(MANUAL, "手动输入");

        const init = knownSubs.includes(subcategory) ? subcategory : (subcategory ? MANUAL : NONE);
        dd.setValue(init);
        dd.onChange((v) => {
          if (v === NONE) {
            subcategory = "";
            try { txtComp?.setValue?.(""); } catch {}
            refreshAuxHints();
            return;
          }
          if (v === MANUAL) {
            refreshAuxHints();
            return;
          }
          subcategory = normalizeFinanceSubcategory(v);
          try { txtComp?.setValue?.(subcategory); } catch {}
          refreshAuxHints();
        });
      });

      row.addText((t) => {
        txtComp = t;
        subcategoryText = t;
        t.setPlaceholder("可选；可新建");
        t.setValue(subcategory);
        t.onChange((v) => {
          subcategory = normalizeFinanceSubcategory(v);
          try {
            if (!subcategory) ddComp?.setValue?.(NONE);
            else if (knownSubs.includes(subcategory)) ddComp?.setValue?.(subcategory);
            else ddComp?.setValue?.(MANUAL);
          } catch {}
          refreshAuxHints();
        });
      });
    }

    // ===== 机构名 =====
    {
      const row = new Setting(contentEl)
        .setName("机构名")
        .setDesc("可选；周期类型不为「无周期」时必填（按财务分类维护）");
      institutionRowEl = row.settingEl;
      row.addDropdown((dd) => {
        institutionDdComp = dd;
        dd.addOption(INST_NONE, "（无）");
        for (const s of knownInstitutions) dd.addOption(s, s);
        dd.addOption(INST_MANUAL, "手动输入");
        const init = knownInstitutions.includes(institutionName) ? institutionName : (institutionName ? INST_MANUAL : INST_NONE);
        dd.setValue(init);
        dd.onChange((v) => {
          if (v === INST_NONE) {
            institutionName = "";
            try { institutionTxtComp?.setValue?.(""); } catch {}
            refreshValidation();
            refreshAuxHints();
            return;
          }
          if (v === INST_MANUAL) {
            refreshValidation();
            refreshAuxHints();
            return;
          }
          institutionName = String(v ?? "").trim();
          try { institutionTxtComp?.setValue?.(institutionName); } catch {}
          refreshValidation();
          refreshAuxHints();
        });
      });
      row.addText((t) => {
        institutionTxtComp = t;
        t.setPlaceholder("可选；可新建");
        t.setValue(institutionName);
        t.onChange((v) => {
          institutionName = String(v ?? "").trim().replace(/\s+/g, " ");
          try {
            if (!institutionName) institutionDdComp?.setValue?.(INST_NONE);
            else if (knownInstitutions.includes(institutionName)) institutionDdComp?.setValue?.(institutionName);
            else institutionDdComp?.setValue?.(INST_MANUAL);
          } catch {}
          refreshValidation();
          refreshAuxHints();
        });
      });
      instSimilarEl = row.settingEl.createDiv({ cls: "rslatte-finance-inst-similar" });
    }

    // ===== 周期类型 =====
    new Setting(contentEl)
      .setName("周期类型")
      .setDesc("必填；非「无周期」时机构名必填")
      .addDropdown((dd) => {
        cycleRowEl = dd.selectEl.closest(".setting-item") as HTMLElement | null;
        cycleDdEl = dd.selectEl;
        const order: FinanceCycleType[] = ["none", "weekly", "biweekly", "monthly", "quarterly", "halfyearly", "yearly"];
        for (const key of order) dd.addOption(key, FINANCE_CYCLE_LABELS[key]);
        dd.setValue(cycleType);
        dd.onChange((v) => {
          cycleType = normalizeFinanceCycleType(v);
          refreshValidation();
          refreshAuxHints();
        });
      });
    cycleHintEl = contentEl.createDiv({ cls: "rslatte-finance-cycle-hint" });

    // ===== 场景标签 =====
    {
      const row = new Setting(contentEl)
        .setName("场景标签")
        .setDesc("可选；可从历史标签多选，也可手动新增");
      const container = row.settingEl.createDiv({ cls: "rslatte-fin-scene-tags-editor" });
      sceneTagsWrap = container.createDiv({ cls: "rslatte-subcategories-list" });
      const renderSceneTags = () => {
        if (!sceneTagsWrap) return;
        sceneTagsWrap.empty();
        for (const tag of sceneTags) {
          const chip = sceneTagsWrap.createSpan({ cls: "rslatte-subcategory-tag", text: tag });
          const rm = chip.createSpan({ cls: "rslatte-subcategory-remove", text: "×" });
          rm.onclick = () => {
            sceneTags = sceneTags.filter((x) => x !== tag);
            renderSceneTags();
          };
        }
      };
      const actionRow = container.createDiv({ cls: "rslatte-subcat-inline-actions" });
      const select = actionRow.createEl("select");
      select.createEl("option", { text: "从历史标签选择", value: "" });
      for (const t of sceneTagsPool) select.createEl("option", { text: t, value: t });
      const addSel = actionRow.createEl("button", { text: "添加" });
      const input = actionRow.createEl("input", { type: "text", attr: { placeholder: "新标签（可多个，逗号分隔）" } });
      const addManual = actionRow.createEl("button", { text: "新增", cls: "mod-cta" });
      const addTag = (tag: string) => {
        const v = String(tag ?? "").trim().replace(/\s+/g, " ");
        if (!v) return;
        if (sceneTags.includes(v)) return;
        sceneTags.push(v);
        renderSceneTags();
      };
      addSel.onclick = () => addTag(select.value);
      addManual.onclick = () => {
        const parts = String(input.value ?? "").split(/[，,]/g).map((x) => String(x ?? "").trim()).filter(Boolean);
        for (const p of parts) addTag(p);
        input.value = "";
      };
      renderSceneTags();
    }

    // ===== 金额 =====
    new Setting(contentEl)
      .setName("金额")
      .setDesc("请输入金额数（必填）")
      .addText((t) => {
        amountText = t;
        t.inputEl.addClass("rslatte-amount-input");
        t.setPlaceholder("例如 12.34");
        t.setValue(amountRaw);
        t.onChange((v) => {
          amountRaw = (v || "").trim();
          refreshValidation();
        });
        t.inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            void doSave();
          }
        });
      });

    // ===== 备注 =====
    new Setting(contentEl)
      .setName("备注")
      .setDesc("可选")
      .addText((t) => {
        noteText = t;
        t.setPlaceholder("可选");
        t.setValue(note);
        t.onChange((v) => (note = (v || "").trim()));
        t.inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            void doSave();
          }
        });
      });

    // ===== 初始化加载第一个分类的子分类/机构（延迟执行，确保组件已创建） =====
    const selectedCategory = () => categories.find(c => c.id === selectedCategoryId);
    if (categories.length > 0 && !selectedCategoryId) {
      selectedCategoryId = categories[0].id;
      categorySelect.setValue(selectedCategoryId);
      void Promise.all([loadKnownSubs(selectedCategoryId), loadKnownInstitutions(selectedCategoryId), loadSceneTagsHistory()]).then(() => {
        // 延迟更新下拉框选项，确保 ddComp 已创建
        window.setTimeout(() => {
          if (ddComp) {
            try {
              ddComp.selectEl.empty();
              ddComp.addOption(NONE, "（无）");
              for (const s of knownSubs) ddComp.addOption(s, s);
              ddComp.addOption(MANUAL, "手动输入");
              ddComp.setValue(NONE);
            } catch (e) {
              console.warn("初始化子分类下拉框失败", e);
            }
          }
          if (institutionDdComp) {
            try {
              institutionDdComp.selectEl.empty();
              institutionDdComp.addOption(INST_NONE, "（无）");
              for (const s of knownInstitutions) institutionDdComp.addOption(s, s);
              institutionDdComp.addOption(INST_MANUAL, "手动输入");
              institutionDdComp.setValue(INST_NONE);
            } catch (e) {
              console.warn("初始化机构下拉框失败", e);
            }
          }
        }, 50);
      });
    } else {
      void loadSceneTagsHistory();
    }

    // ===== 操作按钮 =====
    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });
    saveBtn = new ButtonComponent(btnRow)
      .setButtonText("保存")
      .setCta()
      .onClick(() => void doSave());
    new ButtonComponent(btnRow).setButtonText("关闭").onClick(() => this.close());

    const doSave = async () => {
      if (inFlight) return;
      if (!refreshValidation()) return;

      try {
        const dateKey = selectedDate;
        const category = selectedCategory();
        if (!category) {
          new Notice("请选择财务分类");
          return;
        }

        const nAbs = Number(amountRaw);
        if (!Number.isFinite(nAbs) || nAbs <= 0) {
          new Notice("请输入有效的金额");
          return;
        }

        const type = category.type; // income | expense
        const signedAmount = type === "expense" ? -nAbs : nAbs;
        if (cycleType !== "none" && !institutionName.trim()) {
          new Notice("周期类型不为“无周期”时，机构名必填");
          return;
        }
        const normalizedSubcat = normalizeFinanceSubcategory(subcategory);
        if (!normalizedSubcat) {
          new Notice("子分类不能为空");
          return;
        }

        const noteMain = buildFinanceMainNoteParts({
          subcategory: normalizedSubcat,
          institutionName,
          cycleType,
          bodyNote: note,
        });

        if (dateKey === this.plugin.getTodayKey()) {
          const siblings =
            (await this.plugin.recordRSLatte?.getTodayFinanceRecordsForCategory?.(category.id, { activeOnly: true })) ?? [];
          const dup = siblings.filter((x) => {
            const ssub = String(x.subcategory ?? "").trim() || extractFinanceMeta(x.note ?? "").subcategory;
            return normalizeFinanceSubcategory(ssub) === normalizedSubcat && Math.abs(Number(x.amount)) === Math.abs(Number(signedAmount));
          });
          if (dup.length > 0) {
            const ok = window.confirm("今日该分类已有非常相似的一笔（同子分类、同金额），是否仍要保存？");
            if (!ok) return;
          }
        }

        const cycRes = await interactiveResolveCycleMetaForSave(this.plugin, {
          catId: category.id,
          subcategory: normalizedSubcat,
          institutionName,
          cycleType,
          recordDateKey: dateKey,
        });
        if (cycRes == null) return;

        setInFlight(true);

        const entryId = generateFinanceEntryId();
        const payload = {
          record_date: dateKey,
          category_id: category.id,
          entry_id: entryId,
          amount: signedAmount,
          note: noteMain,
          is_delete: false,
        };

        // 应用记录（新建记录，id 为 0）
        const appliedItem: any = {
          id: 0, // 新建记录，id 为 0
          record_date: dateKey,
          category_id: category.id,
          entry_id: entryId,
          type,
          amount: Number(signedAmount),
          note: noteMain,
          institution_name: institutionName || undefined,
          cycle_type: cycleType,
          scene_tags: sceneTags,
          is_delete: false,
          created_at: new Date().toISOString(),
        };

        // 如果是今天，使用 applyTodayFinanceRecord；历史日期直接写入索引
        const todayKey = this.plugin.getTodayKey();
        if (dateKey === todayKey) {
          this.plugin.applyTodayFinanceRecord(appliedItem);
        }
        // 历史日期：直接写入索引（不需要更新 _todayFinancesMap，因为那是今天的缓存）

        const financeCat = this.plugin.settings.financeCategories?.find(c => c.id === category.id) as any;
        if (financeCat) {
          if (!Array.isArray(financeCat.institutionNames)) financeCat.institutionNames = [];
          const inst = String(institutionName ?? "").trim().replace(/\s+/g, " ");
          if (inst && !financeCat.institutionNames.includes(inst)) financeCat.institutionNames.push(inst);
        }

        // ✅ 如果使用了子分类且子分类不在分类的子分类列表中，自动添加到列表
        if (normalizedSubcat) {
          if (!category.subCategories) category.subCategories = [];
          if (!category.subCategories.includes(normalizedSubcat)) {
            category.subCategories.push(normalizedSubcat);
            void this.plugin.saveSettings();
          }
        }

        // ✅ 同步写入中央索引
        try {
          await this.plugin.recordRSLatte?.upsertFinanceRecord({
            recordDate: dateKey,
            entryId,
            categoryId: category.id,
            categoryName: category.name,
            type,
            subcategory: normalizedSubcat,
            amount: Number(signedAmount),
            note: noteMain,
            institutionName: institutionName || undefined,
            cycleType: cycleType,
            cycleId: cycRes.cycleIdForMeta === undefined ? undefined : cycRes.cycleIdForMeta,
            sceneTags: sceneTags,
            isDelete: false,
            tsMs: Date.now(),
          });
        } catch (e) {
          console.warn("recordRSLatte upsertFinanceRecord failed", e);
        }

        // ✅ 写入日记（主行 + meta）
        try {
          const mainLine = buildFinanceListItemLine({
            dateKey,
            type,
            categoryId: category.id,
            categoryDisplayName: category.name,
            noteMain: noteMain || "-",
            signedAmount,
            isDelete: false,
          });
          const metaLine = stringifyFinanceMetaComment({
            entry_id: entryId,
            subcategory: normalizedSubcat,
            institution_name: institutionName || undefined,
            cycle_type: cycleType,
            cycle_id: cycRes.cycleIdForMeta,
            scene_tags: sceneTags,
          });
          await ((this.plugin as any).appendJournalByModule?.("finance", dateKey, [mainLine, metaLine]) ?? Promise.resolve());
        } catch (e: any) {
          new Notice("财务记录已保存，但写入日记失败");
          await this.plugin.appendAuditLog({
            action: "FINANCE_JOURNAL_APPEND_FAILED",
            payload,
            error: {
              message: e?.message ?? String(e),
              stack: e?.stack ?? null,
            },
          });
        }

        await this.plugin.saveSettings();
        this.plugin.refreshSidePanel();
        
        // ✅ 刷新财务侧边栏（如果已打开）
        try {
          const financeLeaves = this.app.workspace.getLeavesOfType("rslatte-financepanel");
          for (const leaf of financeLeaves) {
            const view = leaf.view as any;
            if (view && typeof view.refresh === "function") {
              void view.refresh();
            }
          }
        } catch {
          // ignore
        }

        // ✅ Work Event（新建记录，action 为 create）
        try {
          void this.plugin.workEventSvc?.append({
            ts: new Date().toISOString(),
            kind: "finance",
            action: "create", // 新增记录，始终为 create
            source: "ui",
            ref: {
              record_date: dateKey,
              entry_id: entryId,
              type,
              category_id: category.id,
              category_name: category.name || undefined,
              amount: Number(signedAmount),
              subcategory: normalizedSubcat || undefined,
              institution_name: institutionName || undefined,
              cycle_type: cycleType,
              scene_tags: sceneTags,
              note: (noteMain || "").trim() || undefined,
              is_delete: false,
            },
            summary: `💰 新增账单 ${category.name || category.id} ${Number(signedAmount)}（日期：${dateKey}）`,
            metrics: { amount: Number(signedAmount), is_delete: false },
          });
        } catch {
          // ignore
        }

        new Notice(`已保存 ${dateKey} 的财务记录`);
        this.close();
        if (this.onSuccess) {
          this.onSuccess(dateKey);
        }
      } catch (e: any) {
        new Notice(`保存失败：${e?.message ?? String(e)}`);
        await this.plugin.appendAuditLog({
          action: "FINANCE_ADD_FAILED",
          error: {
            message: e?.message ?? String(e),
            stack: e?.stack ?? null,
          },
        });
      } finally {
        setInFlight(false);
      }
    };

    window.setTimeout(() => {
      dateInput?.inputEl?.focus();
      refreshValidation();
      refreshAuxHints();
    }, 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}
