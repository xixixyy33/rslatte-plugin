import { App, ButtonComponent, Modal, Notice, Setting, TextComponent } from "obsidian";
import moment from "moment";
import type RSLattePlugin from "../../main";
import { buildFinanceNoteWithSubcategory, normalizeFinanceSubcategory } from "../../services/finance/financeSubcategory";

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

    let dateInput!: TextComponent;
    let categorySelect!: any;
    let amountText!: TextComponent;
    let noteText!: TextComponent;
    let subcategoryText!: TextComponent;
    let saveBtn!: ButtonComponent;
    let inFlight = false;

    const validate = () => {
      // 验证日期格式
      if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) return false;
      // 验证分类
      if (!selectedCategoryId) return false;
      // 验证金额
      const n = Number(amountRaw);
      return Number.isFinite(n) && n > 0;
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
      } catch { }
    };

    const refreshValidation = () => {
      const ok = validate();
      if (saveBtn) saveBtn.setDisabled(inFlight || !ok);
      return ok;
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
          if (txtComp) {
            try { txtComp.setValue(""); } catch {}
          }
          if (ddComp) {
            try { ddComp.setValue(NONE); } catch {}
          }
          await loadKnownSubs(v);
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
          }, 0);
          refreshValidation();
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
            return;
          }
          if (v === MANUAL) {
            // keep current text input
            return;
          }
          subcategory = normalizeFinanceSubcategory(v);
          try { txtComp?.setValue?.(subcategory); } catch {}
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
        });
      });
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

    // ===== 初始化加载第一个分类的子分类（延迟执行，确保 ddComp 已创建） =====
    const selectedCategory = () => categories.find(c => c.id === selectedCategoryId);
    if (categories.length > 0 && !selectedCategoryId) {
      selectedCategoryId = categories[0].id;
      categorySelect.setValue(selectedCategoryId);
      void loadKnownSubs(selectedCategoryId).then(() => {
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
        }, 50);
      });
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

      setInFlight(true);

      try {
        const dateKey = selectedDate;
        const category = selectedCategory();
        if (!category) {
          new Notice("请选择财务分类");
          setInFlight(false);
          return;
        }

        const nAbs = Number(amountRaw);
        if (!Number.isFinite(nAbs) || nAbs <= 0) {
          new Notice("请输入有效的金额");
          setInFlight(false);
          return;
        }

        const type = category.type; // income | expense
        const signedAmount = type === "expense" ? -nAbs : nAbs;
        const safeNote = buildFinanceNoteWithSubcategory(subcategory, note);

        // ✅ 检查该日期该分类是否已有记录（且未删除）
        let existingRecord: any = null;
        try {
          // 从索引中查找该日期和分类的记录（检查活跃和归档记录，以及统计缓存）
          if (this.plugin.recordRSLatte) {
            // 优先使用统计缓存（包含全量数据，不受归档影响）
            let allRecords: any[] = [];
            try {
              const statsCache = await this.plugin.recordRSLatte.getFinanceStatsCache();
              if (statsCache?.items && statsCache.items.length > 0) {
                allRecords = statsCache.items as any[];
              } else {
                // 回退到主索引（活跃 + 归档）
                const fSnapActive = await this.plugin.recordRSLatte.getFinanceSnapshot(false);
                const fSnapArch = await this.plugin.recordRSLatte.getFinanceSnapshot(true);
                allRecords = [
                  ...(fSnapActive?.items ?? []),
                  ...(fSnapArch?.items ?? [])
                ];
              }
            } catch {
              // 如果获取缓存失败，回退到主索引
              const fSnapActive = await this.plugin.recordRSLatte.getFinanceSnapshot(false);
              const fSnapArch = await this.plugin.recordRSLatte.getFinanceSnapshot(true);
              allRecords = [
                ...(fSnapActive?.items ?? []),
                ...(fSnapArch?.items ?? [])
              ];
            }
            
            // 查找匹配的记录
            existingRecord = allRecords.find(
              (item: any) => {
                // 严格检查：日期和分类ID必须匹配，且记录未删除
                // 支持两种字段名格式：record_date/recordDate, category_id/categoryId
                const itemDate = String(item.record_date || item.recordDate || "").trim();
                const itemCategoryId = String(item.category_id || item.categoryId || "").trim();
                const dateMatch = itemDate === String(dateKey || "").trim();
                const categoryMatch = itemCategoryId === String(category.id || "").trim();
                
                // 检查 is_delete：可能是布尔值、字符串 "true"/"false"、或 undefined/null
                // 支持两种字段名格式：is_delete/isDelete
                const isDeleted = item.is_delete === true || item.isDelete === true || String(item.is_delete || item.isDelete || "").toLowerCase() === "true";
                
                const matches = dateMatch && categoryMatch && !isDeleted;
                
                if (this.plugin.isDebugLogEnabled() && dateMatch && categoryMatch) {
                  console.log(`[RSLatte][AddFinanceRecord] 找到日期和分类匹配的记录:`, {
                    itemDate,
                    itemCategoryId,
                    dateKey,
                    categoryId: category.id,
                    isDeleted,
                    matches
                  });
                }
                
                return matches;
              }
            );
            
            if (this.plugin.isDebugLogEnabled()) {
              console.log(`[RSLatte][AddFinanceRecord] 检查重复记录: dateKey=${dateKey}, categoryId=${category.id}, 扫描了 ${allRecords.length} 条记录, 找到匹配记录=${!!existingRecord}`);
              if (existingRecord) {
                console.log(`[RSLatte][AddFinanceRecord] 找到已有记录:`, existingRecord);
              }
            }
          }
        } catch (e) {
          console.warn("[RSLatte][AddFinanceRecord] 检查已有记录失败", e);
        }

        // ✅ 如果已有未删除的记录，不允许插入
        if (existingRecord) {
          new Notice(`该日期（${dateKey}）和财务分类（${category.name}）已有记录，请先取消已有记录后再插入`);
          setInFlight(false);
          return;
        }

        const payload = {
          record_date: dateKey,
          category_id: category.id,
          amount: signedAmount,
          note: safeNote,
          is_delete: false,
        };

        // 应用记录（新建记录，id 为 0）
        const appliedItem: any = {
          id: 0, // 新建记录，id 为 0
          record_date: dateKey,
          category_id: category.id,
          type,
          amount: Number(signedAmount),
          note: safeNote,
          is_delete: false,
          created_at: new Date().toISOString(),
        };

        // 如果是今天，使用 applyTodayFinanceRecord；历史日期直接写入索引
        const todayKey = this.plugin.getTodayKey();
        if (dateKey === todayKey) {
          this.plugin.applyTodayFinanceRecord(appliedItem);
        }
        // 历史日期：直接写入索引（不需要更新 _todayFinancesMap，因为那是今天的缓存）

        // ✅ 如果使用了子分类且子分类不在分类的子分类列表中，自动添加到列表
        const normalizedSubcat = subcategory ? normalizeFinanceSubcategory(subcategory) : "";
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
            categoryId: category.id,
            categoryName: category.name,
            type,
            amount: Number(signedAmount),
            note: safeNote,
            isDelete: false,
            tsMs: Date.now(),
          });
        } catch (e) {
          console.warn("recordRSLatte upsertFinanceRecord failed", e);
        }

        // ✅ 写入日记
        try {
          const safeCatName = String(category.name ?? "").trim().replace(/\s+/g, "");
          const line = `- ${dateKey} ${type} ${category.id} ${safeCatName || category.id} ${safeNote || "-"} ${signedAmount.toFixed(2)}`;

          await ((this.plugin as any).appendJournalByModule?.("finance", dateKey, [line]) ?? Promise.resolve());
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
              category_id: category.id,
              category_name: category.name || undefined,
              amount: Number(signedAmount),
              subcategory: normalizedSubcat || undefined,
              note: (safeNote || "").trim() || undefined,
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
    }, 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}
