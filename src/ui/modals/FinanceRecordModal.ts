import { App, ButtonComponent, Modal, Notice, Setting, TextComponent } from "obsidian";
import moment from "moment";

import type RSLattePlugin from "../../main";

const momentFn = moment as any;
import type { FinanceCatDef } from "../../types/rslatteTypes";
import { buildFinanceNoteWithSubcategory, extractFinanceSubcategory, normalizeFinanceSubcategory } from "../../services/finance/financeSubcategory";

/**
 * 财务录入（当日单条）：
 * - 每个分类每天只维护一条（DB 以 vault_id + record_date + category_id 唯一）
 * - 绿色按钮：表示当日已有有效记录（is_delete=false），点开可“更新/取消”
 * - 灰色按钮：表示未记录或已取消（is_delete=true），点开可“新增/恢复”
 * - 不提供历史补录：日期固定为今天
 */
export class FinanceRecordModal extends Modal {
  constructor(app: App, private plugin: RSLattePlugin, private cat: FinanceCatDef) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    const render = async () => {
      contentEl.empty();

      await ((this.plugin as any).ensureTodayFinancesInitialized?.() ?? Promise.resolve());

      const dateKey = this.plugin.getTodayKey();
      const existing = this.plugin.getTodayFinanceRecord(this.cat.id);
      const existedAndActive = !!(existing && existing.is_delete === false);

      this.titleEl.setText(existedAndActive ? `账单（已记录）：${this.cat.name}` : `记账：${this.cat.name}`);

      const type = this.cat.type; // income | expense

      let amountRaw = "";
      let note = ""; // body note (without subcategory prefix)
      let subcategory = "";

      if (existing) {
      // amount 存在符号（收入正、支出负）。输入框永远让用户输“正数”。
      const absAmt = Math.abs(Number((existing as any).amount));
      if (Number.isFinite(absAmt) && absAmt > 0) amountRaw = absAmt.toFixed(2);
      const parsed = extractFinanceSubcategory((existing as any).note ?? "");
      subcategory = parsed.subcategory;
      note = parsed.body;
    }
      // Prefetch known subcategories for this category (from lists index, best-effort)
      let knownSubs: string[] = [];
      try {
        knownSubs = await this.plugin.recordRSLatte?.getFinanceSubcategories?.(this.cat.id) ?? [];
      } catch {
        knownSubs = [];
      }


      const normalizeAmountAbs = (s: string) => {
      const v = (s ?? "").trim();
      if (!v) return NaN;
      const n = Number(v);
      if (!Number.isFinite(n)) return NaN;
      return Math.abs(n);
    };

      const buildSignedAmount = (absAmount: number) => {
      const fixed = Number(absAmount.toFixed(2));
      return type === "expense" ? -fixed : fixed;
    };

      const safeNote = (s: string) => (s ?? "").trim().replace(/\s+/g, " ");

      let amountText!: TextComponent;
      let saveBtn!: ButtonComponent;
      let cancelBillBtn: ButtonComponent | null = null;
      let inFlight = false;

      const validateAmount = () => {
      const n = normalizeAmountAbs(amountRaw);
      return Number.isFinite(n) && n > 0;
    };

      const setInFlight = (v: boolean) => {
        inFlight = v;
        try {
          saveBtn?.setDisabled(v || !validateAmount());
        } catch { }
        try {
          if (cancelBillBtn) cancelBillBtn.setDisabled(v);
        } catch { }
        try {
          (amountText as any)?.setDisabled?.(v);
        } catch { }
        try {
          if ((amountText as any)?.inputEl) (amountText as any).inputEl.disabled = v;
        } catch { }
      };

      const refreshValidationUI = () => {
      const ok = validateAmount();
      amountText?.inputEl?.classList.toggle("is-invalid", !ok);
      if (saveBtn) {
        saveBtn.setDisabled(inFlight || !ok);
      }
      return ok;
    };

      // ===== 顶部信息 =====
      const info = contentEl.createDiv({ cls: "rslatte-modal-info" });
      if (existedAndActive && existing) {
      const absAmt = Math.abs(Number((existing as any).amount));
      info.setText(`今日已记录：${absAmt.toFixed(2)}（${type === "expense" ? "支出" : "收入"}）`);
    } else {
      info.setText("仅维护今日账单（不支持历史补录）");
    }

      // ===== 金额 =====
      new Setting(contentEl)
      .setName("金额")
      .setDesc(type === "expense" ? "支出：请输入金额数" : "收入：请输入金额数")
      .addText((t) => {
        amountText = t;
        t.inputEl.addClass("rslatte-amount-input");
        t.setPlaceholder("例如 12.34");
        t.setValue(amountRaw);
        t.onChange((v) => {
          amountRaw = (v || "").trim();
          refreshValidationUI();
        });

        t.inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            void doUpsert(false);
          }
        });
      });

      // ===== 备注 =====
      new Setting(contentEl)
      .setName("备注")
      .setDesc("可选；填写完金额回车即可保存")
      .addText((t) => {
        t.setPlaceholder("可选");
        t.setValue(note);
        t.onChange((v) => (note = (v || "").trim()));
        t.inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            void doUpsert(false);
          }
        });
      });

      // ===== 子分类（写入到备注前缀【子分类】） =====
      // UI: dropdown (recent used) + text input (manual)
      {
        const row = new Setting(contentEl)
          .setName("子分类")
          .setDesc("可选；保存后会以【子分类】前缀写入到备注最前方（不入库管理）");

        const MANUAL = "__manual__";
        const NONE = "";

        let ddComp: any = null;
        let txtComp: any = null;

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

    // ===== 操作按钮 =====
    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });

    const primaryText = existedAndActive ? "更新" : "保存";
    saveBtn = new ButtonComponent(btnRow)
      .setButtonText(primaryText)
      .setCta()
      .onClick(() => void doUpsert(false));

    if (existedAndActive) {
      cancelBillBtn = new ButtonComponent(btnRow)
        .setButtonText("取消本笔")
        .onClick(() => void doUpsert(true));
      cancelBillBtn.buttonEl.addClass("mod-warning");
    }

    new ButtonComponent(btnRow).setButtonText("关闭").onClick(() => this.close());

    const doUpsert = async (toDelete: boolean) => {
      if (inFlight) return;
      if (!toDelete && !refreshValidationUI()) return;

      // Prevent repeated clicks / Enter spamming.
      setInFlight(true);

      const nAbs = normalizeAmountAbs(amountRaw);
      const signedAmount = Number.isFinite(nAbs) ? buildSignedAmount(nAbs) : (existing ? Number((existing as any).amount) : 0);
      const catId = this.cat.id;
      const catName = this.cat.name;

      const payload = {
        record_date: dateKey,
        category_id: this.cat.id,
        amount: signedAmount,
        note: safeNote(buildFinanceNoteWithSubcategory(subcategory, note)),
        is_delete: !!toDelete,
      };

      // ✅ UI 与后端入库解耦：
      // - 这里始终先落本地（按钮状态/索引/日志），并立刻关闭窗口；
      // - DB 入库由后续 auto/manual refresh 的 record sync 机制重试（带 backoff），避免后端异常时重复触发。
      const appliedItem: any = {
        id: existing ? Number((existing as any).id ?? 0) : 0,
        record_date: dateKey,
        category_id: this.cat.id,
        type,
        amount: Number(signedAmount),
        note: payload.note,
        is_delete: toDelete,
        created_at: existing ? (existing as any).created_at ?? new Date().toISOString() : new Date().toISOString(),
      };

      this.plugin.applyTodayFinanceRecord(appliedItem);

      // ✅ 如果使用了子分类且子分类不在分类的子分类列表中，自动添加到列表
      const normalizedSubcat = subcategory ? normalizeFinanceSubcategory(subcategory) : "";
      if (normalizedSubcat && !toDelete) {
        const financeCat = this.plugin.settings.financeCategories?.find(c => c.id === this.cat.id);
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

      // ✅ 无论是否 DB，同步写入“打卡/财务中央索引”
      try {
        await this.plugin.recordRSLatte?.upsertFinanceRecord({
          recordDate: dateKey,
          categoryId: this.cat.id,
          categoryName: this.cat.name,
          type,
          amount: Number(signedAmount),
          note: payload.note,
          isDelete: toDelete,
          tsMs: Date.now(),
        });
      } catch (e) {
        console.warn("recordRSLatte upsertFinanceRecord failed", e);
      }

      try {

        // ✅ 写入日志（取消用“不可解析”格式避免影响统计）
        const ts = moment().format("HH:mm");
        const amtAbs = Math.abs(Number(signedAmount));
        const mark = toDelete ? "❌" : "✅";
        // 说明：为便于未来“扫描重建索引”，正常记录行也写入【分类ID + 分类名称】
        // 格式：- 2026-01-03 expense CW_UZGMNY 日用品 - -20.00
        const safeCatName = String(this.cat.name ?? "").trim().replace(/\s+/g, "");
        const line = toDelete
          ? `- ${mark} ${dateKey} ${ts} ${type} ${this.cat.id} ${safeCatName || this.cat.id} ${payload.note || "-"} ${amtAbs.toFixed(2)}`
          : `- ${dateKey} ${type} ${this.cat.id} ${safeCatName || this.cat.id} ${payload.note || "-"} ${signedAmount.toFixed(2)}`;

        try {
          // ✅ 按“日志追加清单”配置写入日记（强制启用：财务）
          await ((this.plugin as any).appendJournalByModule?.("finance", dateKey, [line]) ?? Promise.resolve());
        } catch (e: any) {
          new Notice("账单已保存，但写入日记失败（详情已写入审计日志）");
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
        // ✅ 先刷新按钮，再异步刷新统计数据（不阻断 UI 关闭）
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
        
        void this.plugin.refreshFinanceSummaryFromApi(true);

        // ✅ Work Event（失败不阻断）
        try {
          void this.plugin.workEventSvc?.append({
            ts: new Date().toISOString(),
            kind: "finance",
            action: toDelete ? "delete" : (existedAndActive ? "update" : "create"),
            source: "ui",
            ref: {
              record_date: dateKey,
              category_id: catId,
              category_name: catName || undefined,
              amount: Number(signedAmount),
              subcategory: normalizeFinanceSubcategory(subcategory) || undefined,
              note: (payload.note || "").trim() || undefined,
              is_delete: toDelete,
            },
            summary: `${toDelete ? "❌ 取消账单" : (existedAndActive ? "✏️ 更新账单" : "💰 新增账单")} ${catName || catId} ${Number(signedAmount)}`,
            metrics: { amount: Number(signedAmount), is_delete: toDelete },
          });
        } catch {
          // ignore
        }

        new Notice(toDelete ? "已取消今日账单" : (existedAndActive ? "已更新账单" : "已保存记账"));
        this.close();
      } catch (e: any) {
        // ✅ 理论上不会走到这里：这里只兜底 UI 更新失败
        await this.plugin.appendAuditLog({
          action: "FINANCE_UI_APPLY_FAILED",
          payload,
          error: {
            message: e?.message ?? String(e),
            stack: e?.stack ?? null,
          },
        });
      } finally {
        // If modal is still open for any reason, re-enable UI.
        try { setInFlight(false); } catch { }
      }
    };

    window.setTimeout(() => {
      amountText?.inputEl?.focus();
      refreshValidationUI();
    }, 0);
    };

    void render().catch((e) => {
      console.warn("ensureTodayFinancesInitialized/render failed", e);
      new Notice("初始化账单信息失败");
      this.close();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
