import { App, ButtonComponent, Modal, Notice, Setting } from "obsidian";
import type RSLattePlugin from "../../main";
import type { FinanceEntry } from "../../types/rslatteTypes";
import { buildFinanceNoteWithSubcategory, normalizeFinanceSubcategory } from "../../services/finance/financeSubcategory";

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
    let knownSubs: string[] = [];

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

        const finalNote = buildFinanceNoteWithSubcategory(subcategory, note);
        await this.onSubmit({ type, catId, amount: amt, note: finalNote });
        this.close();
      });

    amountText.settingEl.addClass("rslatte-modal-amount");

    // init known subcategories
    void refreshKnownSubs();
  }

  onClose() { this.contentEl.empty(); }
}
