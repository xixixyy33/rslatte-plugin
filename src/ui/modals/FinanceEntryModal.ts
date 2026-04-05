import { App, ButtonComponent, Modal, Notice, Setting } from "obsidian";
import type RSLattePlugin from "../../main";
import type { FinanceEntry } from "../../types/rslatteTypes";
import { FINANCE_CYCLE_LABELS, normalizeFinanceCycleType, type FinanceCycleType } from "../../types/rslatteTypes";
import { buildFinanceNoteWithMeta, normalizeFinanceSubcategory } from "../../services/finance/financeSubcategory";

export class FinanceEntryModal extends Modal {
  private plugin: RSLattePlugin;
  private onSubmit: (e: FinanceEntry) => Promise<void>;

  constructor(app: App, plugin: RSLattePlugin, onSubmit: (e: FinanceEntry) => Promise<void>) {
    super(app);
    this.plugin = plugin;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("记一笔账");

    const activeCats = (this.plugin.settings.financeCategories || []).filter(x => x.active);

    let type: "expense" | "income" = "expense";
    let catId = activeCats[0]?.id ?? "";
    let amountStr = "";
    let note = ""; // body note
    let subcategory = "";
    let institutionName = "";
    let cycleType: FinanceCycleType = "none";
    let sceneTags: string[] = [];
    let knownSubs: string[] = [];
    let knownInstitutions: string[] = [];
    let knownSceneTags: string[] = [];

    let ddComp: any = null;
    let txtComp: any = null;

    const MANUAL = "__manual__";
    const NONE = "";

    const refreshKnownSubs = async () => {
      try {
        knownSubs = await (this.plugin.recordRSLatte as any)?.getFinanceSubcategories?.(catId) ?? [];
      } catch {
        knownSubs = [];
      }
      // Rebuild dropdown options (best-effort) when category changes
      try {
        if (!ddComp?.selectEl) return;
        // Reset options map (Obsidian DropdownComponent keeps an internal map)
        (ddComp as any).options = {};
        ddComp.selectEl.options.length = 0;
        ddComp.addOption(NONE, "（无）");
        for (const s of knownSubs) ddComp.addOption(s, s);
        ddComp.addOption(MANUAL, "手动输入");
        const init = subcategory ? (knownSubs.includes(subcategory) ? subcategory : MANUAL) : NONE;
        ddComp.setValue(init);
      } catch {
        // ignore
      }
    };
    const refreshKnownInstitutions = async () => {
      try {
        knownInstitutions = await (this.plugin.recordRSLatte as any)?.getFinanceInstitutions?.(catId) ?? [];
      } catch {
        knownInstitutions = [];
      }
    };
    const refreshKnownSceneTags = async () => {
      try {
        knownSceneTags = await (this.plugin.recordRSLatte as any)?.getFinanceSceneTagsHistory?.() ?? [];
      } catch {
        knownSceneTags = [];
      }
    };

    new Setting(contentEl)
      .setName("类型")
      .addDropdown(dd => {
        dd.addOption("expense", "支出");
        dd.addOption("income", "收入");
        dd.setValue(type);
        dd.onChange(v => { type = v as any; });
      });

    new Setting(contentEl)
      .setName("分类")
      .addDropdown(dd => {
        activeCats.forEach(c => dd.addOption(c.id, `${c.name} (${c.id})`));
        dd.setValue(catId);
        dd.onChange(v => {
          catId = v;
          void refreshKnownSubs();
          void refreshKnownInstitutions();
        });
      });

    // 子分类
    const subRow = new Setting(contentEl)
      .setName("子分类")
      .setDesc("可选；保存后会以【子分类】前缀写入到备注最前方（不入库管理）");

    subRow.addDropdown(dd => {
      ddComp = dd;
      dd.addOption(NONE, "（无）");
      // options will be built by refreshKnownSubs; keep manual for safety
      dd.addOption(MANUAL, "手动输入");
      dd.setValue(NONE);
      dd.onChange(v => {
        if (v === NONE) {
          subcategory = "";
          try { txtComp?.setValue?.(""); } catch {}
          return;
        }
        if (v === MANUAL) return;
        subcategory = normalizeFinanceSubcategory(v);
        try { txtComp?.setValue?.(subcategory); } catch {}
      });

    // 机构名
    {
      const row = new Setting(contentEl)
        .setName("机构名")
        .setDesc("可选；周期类型不为「无周期」时必填");
      const MANUAL_INST = "__manual__";
      const NONE_INST = "";
      let ddInst: any = null;
      let txtInst: any = null;
      row.addDropdown((dd) => {
        ddInst = dd;
        dd.addOption(NONE_INST, "（无）");
        for (const s of knownInstitutions) dd.addOption(s, s);
        dd.addOption(MANUAL_INST, "手动输入");
        dd.setValue(NONE_INST);
        dd.onChange((v) => {
          if (v === NONE_INST) {
            institutionName = "";
            try { txtInst?.setValue?.(""); } catch {}
            return;
          }
          if (v === MANUAL_INST) return;
          institutionName = String(v ?? "").trim();
          try { txtInst?.setValue?.(institutionName); } catch {}
        });
      });
      row.addText((t) => {
        txtInst = t;
        t.setPlaceholder("可选；可新建");
        t.setValue(institutionName);
        t.onChange((v) => {
          institutionName = String(v ?? "").trim().replace(/\s+/g, " ");
          try {
            if (!institutionName) ddInst?.setValue?.(NONE_INST);
            else if (knownInstitutions.includes(institutionName)) ddInst?.setValue?.(institutionName);
            else ddInst?.setValue?.(MANUAL_INST);
          } catch {}
        });
      });
    }

    // 周期类型
    new Setting(contentEl)
      .setName("周期类型")
      .setDesc("必填；非「无周期」时机构名必填")
      .addDropdown((dd) => {
        const order: FinanceCycleType[] = ["none", "weekly", "biweekly", "monthly", "quarterly", "halfyearly", "yearly"];
        for (const key of order) dd.addOption(key, FINANCE_CYCLE_LABELS[key]);
        dd.setValue(cycleType);
        dd.onChange((v) => {
          cycleType = normalizeFinanceCycleType(v);
        });
      });

    // 场景标签
    {
      const row = new Setting(contentEl)
        .setName("场景标签")
        .setDesc("可选；可从历史多选，也可新增");
      const wrap = row.settingEl.createDiv({ cls: "rslatte-subcategories-list" });
      const renderTags = () => {
        wrap.empty();
        for (const tag of sceneTags) {
          const chip = wrap.createSpan({ cls: "rslatte-subcategory-tag", text: tag });
          const rm = chip.createSpan({ cls: "rslatte-subcategory-remove", text: "×" });
          rm.onclick = () => {
            sceneTags = sceneTags.filter((x) => x !== tag);
            renderTags();
          };
        }
      };
      const act = row.settingEl.createDiv({ cls: "rslatte-subcat-inline-actions" });
      const sel = act.createEl("select");
      sel.createEl("option", { text: "从历史标签选择", value: "" });
      for (const t of knownSceneTags) sel.createEl("option", { text: t, value: t });
      const btnSel = act.createEl("button", { text: "添加" });
      const inp = act.createEl("input", { type: "text", attr: { placeholder: "新标签（逗号分隔）" } });
      const btnIn = act.createEl("button", { text: "新增", cls: "mod-cta" });
      const addTag = (tag: string) => {
        const v = String(tag ?? "").trim().replace(/\s+/g, " ");
        if (!v) return;
        if (sceneTags.includes(v)) return;
        sceneTags.push(v);
        renderTags();
      };
      btnSel.onclick = () => addTag(sel.value);
      btnIn.onclick = () => {
        const parts = String(inp.value ?? "").split(/[，,]/g).map((x) => String(x ?? "").trim()).filter(Boolean);
        for (const p of parts) addTag(p);
        inp.value = "";
      };
      renderTags();
    }
    });
    subRow.addText(t => {
      txtComp = t;
      t.setPlaceholder("可选；可新建");
      t.setValue(subcategory);
      t.onChange(v => {
        subcategory = normalizeFinanceSubcategory(v);
        try {
          if (!subcategory) ddComp?.setValue?.(NONE);
          else if (knownSubs.includes(subcategory)) ddComp?.setValue?.(subcategory);
          else ddComp?.setValue?.(MANUAL);
        } catch {}
      });
    });

    const amountText = new Setting(contentEl)
      .setName("金额")
      .setDesc("支持小数，例如 12.34")
      .addText(t => {
        t.setPlaceholder("0.00");
        t.onChange(v => { amountStr = v.trim(); });
      });

    new Setting(contentEl)
      .setName("备注")
      .addText(t => {
        t.setPlaceholder("可选");
        t.onChange(v => { note = v.trim(); });
      });

    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });

    new ButtonComponent(btnRow)
      .setButtonText("取消")
      .onClick(() => this.close());

    new ButtonComponent(btnRow)
      .setButtonText("保存")
      .setCta()
      .onClick(async () => {
        const amt = Number(amountStr);
        if (!catId) { new Notice("请选择分类"); return; }
        if (!Number.isFinite(amt) || amt <= 0) { new Notice("金额必须是大于 0 的数字"); return; }
        if (cycleType !== "none" && !String(institutionName ?? "").trim()) {
          new Notice("周期类型不为“无周期”时，机构名必填");
          return;
        }

        // ✅ 如果使用了子分类且子分类不在分类的子分类列表中，自动添加到列表
        const normalizedSubcat = subcategory ? normalizeFinanceSubcategory(subcategory) : "";
        if (normalizedSubcat) {
          const financeCat = this.plugin.settings.financeCategories?.find(c => c.id === catId);
          if (financeCat) {
            if (!financeCat.subCategories) financeCat.subCategories = [];
            // ✅ 检查是否已存在（不重复）
            if (!financeCat.subCategories.includes(normalizedSubcat)) {
              financeCat.subCategories.push(normalizedSubcat);
              // ✅ 异步保存设置（不阻塞当前流程）
              void this.plugin.saveSettings();
            }
          }
        }
        const financeCat = this.plugin.settings.financeCategories?.find(c => c.id === catId) as any;
        if (financeCat) {
          if (!Array.isArray(financeCat.institutionNames)) financeCat.institutionNames = [];
          const inst = String(institutionName ?? "").trim().replace(/\s+/g, " ");
          if (inst && !financeCat.institutionNames.includes(inst)) {
            financeCat.institutionNames.push(inst);
            void this.plugin.saveSettings();
          }
        }

        const finalNote = buildFinanceNoteWithMeta({
          subcategory,
          institutionName,
          cycleType,
          sceneTags,
          bodyNote: note,
        });
        await this.onSubmit({ type, catId, amount: amt, note: finalNote, institutionName, cycleType, sceneTags });
        this.close();
      });

    amountText.settingEl.addClass("rslatte-modal-amount");

    // init known subcategories
    void Promise.all([refreshKnownSubs(), refreshKnownInstitutions(), refreshKnownSceneTags()]);
  }

  onClose() { this.contentEl.empty(); }
}
