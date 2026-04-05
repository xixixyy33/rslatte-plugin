import { App, ButtonComponent, Modal, Notice, Setting, TextComponent } from "obsidian";
import moment from "moment";

import type RSLattePlugin from "../../main";
import type { FinanceRecordIndexItem } from "../../types/recordIndexTypes";

const momentFn = moment as any;
import type { FinanceCatDef } from "../../types/rslatteTypes";
import { FINANCE_CYCLE_LABELS, normalizeFinanceCycleType, type FinanceCycleType } from "../../types/rslatteTypes";
import { extractFinanceMeta, normalizeFinanceSubcategory } from "../../services/finance/financeSubcategory";
import {
  buildFinanceListItemLine,
  buildFinanceMainNoteParts,
  generateFinanceEntryId,
  stringifyFinanceMetaComment,
} from "../../services/finance/financeJournalMeta";
import { interactiveResolveCycleMetaForSave } from "../../services/finance/financeCycleInteractive";

type FormMode = "list" | "add" | "edit";

/**
 * 分类今日台账（同日同分类多条 entry_id）+ 内嵌新增/编辑表单。
 */
export class FinanceRecordModal extends Modal {
  private formMode: FormMode = "list";
  /** 编辑中的索引项（来自 recordRSLatte） */
  private editingIndex: FinanceRecordIndexItem | null = null;

  constructor(app: App, private plugin: RSLattePlugin, private cat: FinanceCatDef) {
    super(app);
  }

  onOpen() {
    this.formMode = "list";
    this.editingIndex = null;
    void this.renderRoot();
  }

  private async loadTodayItems(): Promise<FinanceRecordIndexItem[]> {
    await this.plugin.recordRSLatte?.ensureReady?.();
    return (
      (await this.plugin.recordRSLatte?.getTodayFinanceRecordsForCategory?.(this.cat.id, {
        activeOnly: true,
      })) ?? []
    );
  }

  private async renderRoot() {
    const { contentEl } = this;
    contentEl.empty();
    await ((this.plugin as any).ensureTodayFinancesInitialized?.() ?? Promise.resolve());

    if (this.formMode === "list") {
      await this.renderList(contentEl);
      return;
    }
    await this.renderForm(contentEl, this.formMode === "add" ? null : this.editingIndex);
  }

  private async renderList(container: HTMLElement) {
    const items = await this.loadTodayItems();
    this.titleEl.setText(`今日 · ${this.cat.name}`);

    if (items.length === 0) {
      container.createDiv({ cls: "rslatte-modal-info", text: "暂无记录" });
    } else {
      for (const it of items) {
        const sub = normStr(it.subcategory) || extractFinanceMeta(it.note ?? "").subcategory || "（未分类）";
        const abs = Math.abs(Number(it.amount ?? 0));
        const card = container.createDiv({ cls: "rslatte-finance-ledger-card" });
        card.createDiv({
          cls: "rslatte-finance-ledger-card-title",
          text: `${sub} · ${abs.toFixed(2)}`,
        });
        const body = extractFinanceMeta(it.note ?? "").body;
        if (body) {
          card.createDiv({ cls: "rslatte-finance-ledger-card-note", text: body });
        }
        const row = card.createDiv({ cls: "rslatte-finance-ledger-card-actions" });
        new ButtonComponent(row)
          .setButtonText("编辑")
          .onClick(() => {
            this.formMode = "edit";
            this.editingIndex = it;
            void this.renderRoot();
          });
        new ButtonComponent(row)
          .setButtonText("取消本笔")
          .onClick(() => {
            this.formMode = "edit";
            this.editingIndex = it;
            void this.renderForm(this.contentEl, it, true);
          });
      }
    }

    const actions = container.createDiv({ cls: "rslatte-modal-actions" });
    new ButtonComponent(actions)
      .setButtonText("➕ 新增一条")
      .setCta()
      .onClick(() => {
        this.formMode = "add";
        this.editingIndex = null;
        void this.renderRoot();
      });
    new ButtonComponent(actions).setButtonText("关闭").onClick(() => this.close());
  }

  private async renderForm(container: HTMLElement, existing: FinanceRecordIndexItem | null, onlyCancel = false) {
    container.empty();
    const dateKey = this.plugin.getTodayKey();
    const type = this.cat.type;

    this.titleEl.setText(
      existing && !onlyCancel ? `编辑 · ${this.cat.name}` : onlyCancel ? `取消本笔 · ${this.cat.name}` : `新增 · ${this.cat.name}`
    );

    let amountRaw = "";
    let note = "";
    let subcategory = "";
    let institutionName = "";
    let cycleType: FinanceCycleType = "none";
    let sceneTags: string[] = [];
    let priorCycleId = "";

    if (existing && !onlyCancel) {
      const absAmt = Math.abs(Number(existing.amount));
      if (Number.isFinite(absAmt) && absAmt > 0) amountRaw = absAmt.toFixed(2);
      const parsed = extractFinanceMeta(existing.note ?? "");
      subcategory = normStr(existing.subcategory) || parsed.subcategory;
      institutionName = parsed.institutionName;
      cycleType = normalizeFinanceCycleType(parsed.cycleType);
      sceneTags = parsed.sceneTags ?? [];
      note = parsed.body;
      priorCycleId = normStr((existing as any)?.cycleId);
    } else if (existing && onlyCancel) {
      priorCycleId = normStr((existing as any)?.cycleId);
    }

    let knownSubs: string[] = [];
    let knownInstitutions: string[] = [];
    let knownSceneTags: string[] = [];
    try {
      knownSubs = await this.plugin.recordRSLatte?.getFinanceSubcategories?.(this.cat.id) ?? [];
    } catch {
      knownSubs = [];
    }
    try {
      knownInstitutions = await this.plugin.recordRSLatte?.getFinanceInstitutions?.(this.cat.id) ?? [];
    } catch {
      knownInstitutions = [];
    }
    try {
      knownSceneTags = await this.plugin.recordRSLatte?.getFinanceSceneTagsHistory?.() ?? [];
    } catch {
      knownSceneTags = [];
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
    let inFlight = false;

    const validateAmount = () => {
      if (onlyCancel) return true;
      const n = normalizeAmountAbs(amountRaw);
      if (!(Number.isFinite(n) && n > 0)) return false;
      if (cycleType !== "none" && !String(institutionName ?? "").trim()) return false;
      return true;
    };

    const setInFlight = (v: boolean) => {
      inFlight = v;
      try {
        saveBtn?.setDisabled(v || !validateAmount());
      } catch {
        /* ignore */
      }
      try {
        (amountText as any)?.setDisabled?.(v);
      } catch {
        /* ignore */
      }
      try {
        if ((amountText as any)?.inputEl) (amountText as any).inputEl.disabled = v || onlyCancel;
      } catch {
        /* ignore */
      }
    };

    const refreshValidationUI = () => {
      const ok = validateAmount();
      amountText?.inputEl?.classList.toggle("is-invalid", !onlyCancel && !ok);
      if (saveBtn) saveBtn.setDisabled(inFlight || (!onlyCancel && !ok));
      return ok;
    };

    if (!onlyCancel) {
      new Setting(container)
        .setName("金额")
        .setDesc(type === "expense" ? "支出：请输入正数" : "收入：请输入正数")
        .addText((t) => {
          amountText = t;
          t.inputEl.addClass("rslatte-amount-input");
          t.setPlaceholder("例如 12.34");
          t.setValue(amountRaw);
          t.onChange((v) => {
            amountRaw = (v || "").trim();
            refreshValidationUI();
          });
        });

      new Setting(container)
        .setName("备注")
        .setDesc("可选")
        .addText((t) => {
          t.setPlaceholder("可选");
          t.setValue(note);
          t.onChange((v) => (note = (v || "").trim()));
        });

      {
        const row = new Setting(container).setName("子分类").setDesc("必填");
        const MANUAL = "__manual__";
        const NONE = "";
        let ddComp: any = null;
        let txtComp: any = null;
        row.addDropdown((dd) => {
          ddComp = dd;
          dd.addOption(NONE, "（选择）");
          for (const s of knownSubs) dd.addOption(s, s);
          dd.addOption(MANUAL, "手动输入");
          const init = knownSubs.includes(subcategory) ? subcategory : subcategory ? MANUAL : NONE;
          dd.setValue(init);
          dd.onChange((v) => {
            if (v === NONE) {
              subcategory = "";
              try {
                txtComp?.setValue?.("");
              } catch {
                /* ignore */
              }
              return;
            }
            if (v === MANUAL) return;
            subcategory = normalizeFinanceSubcategory(v);
            try {
              txtComp?.setValue?.(subcategory);
            } catch {
              /* ignore */
            }
          });
        });
        row.addText((t) => {
          txtComp = t;
          t.setPlaceholder("必填");
          t.setValue(subcategory);
          t.onChange((v) => {
            subcategory = normalizeFinanceSubcategory(v);
            try {
              if (!subcategory) ddComp?.setValue?.(NONE);
              else if (knownSubs.includes(subcategory)) ddComp?.setValue?.(subcategory);
              else ddComp?.setValue?.(MANUAL);
            } catch {
              /* ignore */
            }
          });
        });
      }

      {
        const row = new Setting(container).setName("机构名").setDesc("非「无周期」时必填");
        const MANUAL_INST = "__manual__";
        const NONE_INST = "";
        let ddInst: any = null;
        let txtInst: any = null;
        row.addDropdown((dd) => {
          ddInst = dd;
          dd.addOption(NONE_INST, "（无）");
          for (const s of knownInstitutions) dd.addOption(s, s);
          dd.addOption(MANUAL_INST, "手动输入");
          const init = knownInstitutions.includes(institutionName) ? institutionName : institutionName ? MANUAL_INST : NONE_INST;
          dd.setValue(init);
          dd.onChange((v) => {
            if (v === NONE_INST) {
              institutionName = "";
              try {
                txtInst?.setValue?.("");
              } catch {
                /* ignore */
              }
              refreshValidationUI();
              return;
            }
            if (v === MANUAL_INST) {
              refreshValidationUI();
              return;
            }
            institutionName = String(v ?? "").trim();
            try {
              txtInst?.setValue?.(institutionName);
            } catch {
              /* ignore */
            }
            refreshValidationUI();
          });
        });
        row.addText((t) => {
          txtInst = t;
          t.setPlaceholder("可选");
          t.setValue(institutionName);
          t.onChange((v) => {
            institutionName = String(v ?? "").trim().replace(/\s+/g, " ");
            try {
              if (!institutionName) ddInst?.setValue?.(NONE_INST);
              else if (knownInstitutions.includes(institutionName)) ddInst?.setValue?.(institutionName);
              else ddInst?.setValue?.(MANUAL_INST);
            } catch {
              /* ignore */
            }
            refreshValidationUI();
          });
        });
      }

      new Setting(container)
        .setName("周期类型")
        .setDesc("非「无周期」时机构名必填")
        .addDropdown((dd) => {
          const order: FinanceCycleType[] = ["none", "weekly", "biweekly", "monthly", "quarterly", "halfyearly", "yearly"];
          for (const key of order) dd.addOption(key, FINANCE_CYCLE_LABELS[key]);
          dd.setValue(cycleType);
          dd.onChange((v) => {
            cycleType = normalizeFinanceCycleType(v);
            refreshValidationUI();
          });
        });

      {
        const row = new Setting(container).setName("场景标签").setDesc("仅写入 meta，不出现在主行");
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
          const parts = String(inp.value ?? "")
            .split(/[，,]/g)
            .map((x) => String(x ?? "").trim())
            .filter(Boolean);
          for (const p of parts) addTag(p);
          inp.value = "";
        };
        renderTags();
      }
    } else if (existing) {
      const absAmt = Math.abs(Number(existing.amount));
      amountRaw = Number.isFinite(absAmt) ? absAmt.toFixed(2) : "";
      container.createDiv({
        cls: "rslatte-modal-info",
        text: `将取消本笔：${absAmt.toFixed(2)}（${type === "expense" ? "支出" : "收入"}）`,
      });
    }

    const btnRow = container.createDiv({ cls: "rslatte-modal-actions" });

    new ButtonComponent(btnRow)
      .setButtonText("返回列表")
      .onClick(() => {
        this.formMode = "list";
        this.editingIndex = null;
        void this.renderRoot();
      });

    saveBtn = new ButtonComponent(btnRow)
      .setButtonText(onlyCancel ? "确认取消" : "保存")
      .setCta()
      .onClick(() => void doSave(onlyCancel));

    new ButtonComponent(btnRow).setButtonText("关闭").onClick(() => this.close());

    const doSave = async (toDelete: boolean) => {
      if (inFlight) return;
      if (!toDelete && !onlyCancel && !refreshValidationUI()) return;
      if (cycleType !== "none" && !String(institutionName ?? "").trim() && !toDelete && !onlyCancel) {
        new Notice("周期类型不为「无周期」时，机构名必填");
        return;
      }

      const normalizedSub = normalizeFinanceSubcategory(subcategory);
      if (!toDelete && !onlyCancel && !normalizedSub) {
        new Notice("子分类不能为空");
        return;
      }

      const nAbs = normalizeAmountAbs(amountRaw);
      const prior = existing;
      const priorEntryId = normStr(prior?.entryId);
      const priorSub = normStr(prior?.subcategory) || extractFinanceMeta(prior?.note ?? "").subcategory;
      const subChanged = !!priorEntryId && normalizeFinanceSubcategory(priorSub) !== normalizedSub && !toDelete && !onlyCancel;

      const signedAmount =
        toDelete || onlyCancel
          ? buildSignedAmount(normalizeAmountAbs(amountRaw || String(Math.abs(Number(prior?.amount ?? 0)))))
          : Number.isFinite(nAbs)
            ? buildSignedAmount(nAbs)
            : Number(prior?.amount ?? 0);

      if (!toDelete && !onlyCancel) {
        const siblings =
          (await this.plugin.recordRSLatte?.getTodayFinanceRecordsForCategory?.(this.cat.id, { activeOnly: true })) ?? [];
        const dup = siblings.filter((x) => {
          const sid = normStr(x.entryId);
          if (priorEntryId && sid === priorEntryId) return false;
          const ssub = normStr(x.subcategory) || extractFinanceMeta(x.note ?? "").subcategory;
          return normalizeFinanceSubcategory(ssub) === normalizedSub && Math.abs(Number(x.amount)) === Math.abs(Number(signedAmount));
        });
        if (dup.length > 0) {
          const ok = window.confirm("今日已有非常相似的一笔（同子分类、同金额），是否仍要保存？");
          if (!ok) return;
        }
      }

      let cycleIdForNew: string | undefined = undefined;
      if (!toDelete && !onlyCancel) {
        const c = await interactiveResolveCycleMetaForSave(this.plugin, {
          catId: this.cat.id,
          subcategory: normalizedSub,
          institutionName,
          cycleType,
          recordDateKey: dateKey,
        });
        if (c == null) return;
        cycleIdForNew = c.cycleIdForMeta;
      }

      const cancelCycleId = normStr((prior as any)?.cycleId) || normStr(priorCycleId) || undefined;

      setInFlight(true);

      let entryId = priorEntryId || generateFinanceEntryId();
      const noteMain = toDelete || onlyCancel
        ? buildFinanceMainNoteParts({
            subcategory: normStr(prior?.subcategory) || priorSub || normalizedSub,
            institutionName: prior ? extractFinanceMeta(prior.note ?? "").institutionName : institutionName,
            cycleType: prior ? normalizeFinanceCycleType(extractFinanceMeta(prior.note ?? "").cycleType) : cycleType,
            bodyNote: prior ? extractFinanceMeta(prior.note ?? "").body : note,
          })
        : buildFinanceMainNoteParts({
            subcategory: normalizedSub,
            institutionName,
            cycleType,
            bodyNote: note,
          });

      const runJournal = async (
        eid: string,
        del: boolean,
        signed: number,
        meta: {
          subcategory: string;
          institution_name?: string;
          cycle_type: FinanceCycleType;
          cycle_id?: string;
          scene_tags: string[];
        },
        mainNote: string
      ) => {
        const metaLine = stringifyFinanceMetaComment({
          entry_id: eid,
          subcategory: meta.subcategory,
          institution_name: meta.institution_name,
          cycle_type: meta.cycle_type,
          cycle_id: meta.cycle_id,
          scene_tags: meta.scene_tags,
          is_delete: del ? true : undefined,
        });
        const mainLine = buildFinanceListItemLine({
          dateKey,
          type,
          categoryId: this.cat.id,
          categoryDisplayName: this.cat.name,
          noteMain: safeNote(mainNote) || "-",
          signedAmount: signed,
          isDelete: del,
          cancelTimeHm: momentFn().format("HH:mm"),
        });
        const pair = [mainLine, metaLine];
        const replacer = (this.plugin as any).replaceFinanceJournalPairByEntryId as
          | ((dk: string, id: string, p: string[]) => Promise<boolean>)
          | undefined;
        const useReplace = !!priorEntryId && eid === priorEntryId;
        if (useReplace) {
          const ok = replacer ? await replacer(dateKey, eid, pair) : false;
          if (!ok) {
            await ((this.plugin as any).appendJournalByModule?.("finance", dateKey, pair) ?? Promise.resolve());
          }
        } else {
          await ((this.plugin as any).appendJournalByModule?.("finance", dateKey, pair) ?? Promise.resolve());
        }
      };

      try {
        const priorMeta = prior ? extractFinanceMeta(prior.note ?? "") : null;
        if (subChanged && priorEntryId) {
          const oldSigned = Number(prior?.amount ?? signedAmount);
          await runJournal(
            priorEntryId,
            true,
            oldSigned,
            {
              subcategory: normStr(prior?.subcategory) || priorSub || normalizedSub,
              institution_name: priorMeta?.institutionName || undefined,
              cycle_type: priorMeta ? normalizeFinanceCycleType(priorMeta.cycleType) : "none",
              cycle_id: cancelCycleId,
              scene_tags: priorMeta?.sceneTags ?? [],
            },
            buildFinanceMainNoteParts({
              subcategory: normStr(prior?.subcategory) || priorSub,
              institutionName: priorMeta?.institutionName ?? "",
              cycleType: priorMeta ? normalizeFinanceCycleType(priorMeta.cycleType) : "none",
              bodyNote: priorMeta?.body ?? "",
            })
          );
          entryId = generateFinanceEntryId();
          await runJournal(
            entryId,
            false,
            signedAmount,
            {
              subcategory: normalizedSub,
              institution_name: institutionName || undefined,
              cycle_type: cycleType,
              cycle_id: cycleIdForNew,
              scene_tags: sceneTags,
            },
            noteMain
          );

          const oldSignedAmt = Number(prior?.amount ?? signedAmount);
          const cancelIdx: FinanceRecordIndexItem = {
            recordDate: dateKey,
            entryId: priorEntryId,
            categoryId: this.cat.id,
            categoryName: this.cat.name,
            type,
            subcategory: normStr(prior?.subcategory) || priorSub,
            amount: oldSignedAmt,
            note: buildFinanceMainNoteParts({
              subcategory: normStr(prior?.subcategory) || priorSub,
              institutionName: priorMeta?.institutionName ?? "",
              cycleType: priorMeta ? normalizeFinanceCycleType(priorMeta.cycleType) : "none",
              bodyNote: priorMeta?.body ?? "",
            }),
            institutionName: priorMeta?.institutionName || undefined,
            cycleType: priorMeta ? normalizeFinanceCycleType(priorMeta.cycleType) : "none",
            cycleId: cancelCycleId,
            sceneTags: priorMeta?.sceneTags?.length ? priorMeta.sceneTags : undefined,
            isDelete: true,
            tsMs: Date.now(),
          };
          const newIdx: FinanceRecordIndexItem = {
            recordDate: dateKey,
            entryId,
            categoryId: this.cat.id,
            categoryName: this.cat.name,
            type,
            subcategory: normalizedSub,
            amount: signedAmount,
            note: noteMain,
            institutionName: institutionName || undefined,
            cycleType,
            cycleId: cycleIdForNew === undefined ? undefined : cycleIdForNew,
            sceneTags: sceneTags.length ? sceneTags : undefined,
            isDelete: false,
            tsMs: Date.now(),
          };
          await this.plugin.recordRSLatte?.upsertFinanceRecord?.(cancelIdx);
          await this.plugin.recordRSLatte?.upsertFinanceRecord?.(newIdx);
          this.plugin.applyTodayFinanceRecord({
            id: 0,
            record_date: dateKey,
            category_id: this.cat.id,
            entry_id: priorEntryId,
            amount: Number(cancelIdx.amount),
            note: cancelIdx.note,
            is_delete: true,
            created_at: new Date().toISOString(),
          });
          this.plugin.applyTodayFinanceRecord({
            id: 0,
            record_date: dateKey,
            category_id: this.cat.id,
            entry_id: entryId,
            amount: Number(newIdx.amount),
            note: newIdx.note,
            is_delete: false,
            created_at: new Date().toISOString(),
          });
          const financeCat = this.plugin.settings.financeCategories?.find((c) => c.id === this.cat.id) as any;
          if (financeCat) {
            if (!Array.isArray(financeCat.institutionNames)) financeCat.institutionNames = [];
            const inst = String(institutionName ?? "").trim().replace(/\s+/g, " ");
            if (inst && !financeCat.institutionNames.includes(inst)) financeCat.institutionNames.push(inst);
            if (normalizedSub && !financeCat.subCategories) financeCat.subCategories = [];
            if (normalizedSub && financeCat.subCategories && !financeCat.subCategories.includes(normalizedSub)) {
              financeCat.subCategories.push(normalizedSub);
            }
          }
          await this.plugin.saveSettings();
          this.plugin.refreshSidePanel();
          try {
            const financeLeaves = this.app.workspace.getLeavesOfType("rslatte-financepanel");
            for (const leaf of financeLeaves) {
              const view = leaf.view as any;
              if (view && typeof view.refresh === "function") void view.refresh();
            }
          } catch {
            /* ignore */
          }
          void this.plugin.refreshFinanceSummaryFromApi(true);
          new Notice("已保存（子分类变更：已取消旧条并新建）");
          this.formMode = "list";
          this.editingIndex = null;
          setInFlight(false);
          await this.renderRoot();
          return;
        } else if (toDelete || onlyCancel) {
          if (!priorEntryId) {
            new Notice("旧记录无 entry_id，请重建索引或手工补 meta 后再取消");
            setInFlight(false);
            return;
          }
          await runJournal(
            priorEntryId,
            true,
            Number(prior?.amount ?? signedAmount),
            {
              subcategory: normStr(prior?.subcategory) || priorSub || normalizedSub,
              institution_name: priorMeta?.institutionName || undefined,
              cycle_type: priorMeta ? normalizeFinanceCycleType(priorMeta.cycleType) : "none",
              cycle_id: cancelCycleId,
              scene_tags: priorMeta?.sceneTags ?? [],
            },
            buildFinanceMainNoteParts({
              subcategory: normStr(prior?.subcategory) || priorSub,
              institutionName: priorMeta?.institutionName ?? "",
              cycleType: priorMeta ? normalizeFinanceCycleType(priorMeta.cycleType) : "none",
              bodyNote: priorMeta?.body ?? "",
            })
          );
        } else if (priorEntryId) {
          await runJournal(
            priorEntryId,
            false,
            signedAmount,
            {
              subcategory: normalizedSub,
              institution_name: institutionName || undefined,
              cycle_type: cycleType,
              cycle_id: cycleIdForNew,
              scene_tags: sceneTags,
            },
            noteMain
          );
        } else {
          entryId = generateFinanceEntryId();
          await runJournal(
            entryId,
            false,
            signedAmount,
            {
              subcategory: normalizedSub,
              institution_name: institutionName || undefined,
              cycle_type: cycleType,
              cycle_id: cycleIdForNew,
              scene_tags: sceneTags,
            },
            noteMain
          );
        }

        const indexItem: FinanceRecordIndexItem = {
          recordDate: dateKey,
          entryId: toDelete || onlyCancel ? priorEntryId : entryId,
          categoryId: this.cat.id,
          categoryName: this.cat.name,
          type,
          subcategory: toDelete || onlyCancel ? normStr(prior?.subcategory) || priorSub : normalizedSub,
          amount: toDelete || onlyCancel ? Number(prior?.amount ?? signedAmount) : signedAmount,
          note: noteMain,
          institutionName:
            toDelete || onlyCancel ? priorMeta?.institutionName || undefined : institutionName || undefined,
          cycleType:
            (toDelete || onlyCancel) && priorMeta
              ? normalizeFinanceCycleType(priorMeta.cycleType)
              : cycleType,
          cycleId:
            toDelete || onlyCancel
              ? cancelCycleId
              : cycleIdForNew === undefined
                ? undefined
                : cycleIdForNew,
          sceneTags:
            toDelete || onlyCancel
              ? priorMeta?.sceneTags?.length
                ? priorMeta.sceneTags
                : undefined
              : sceneTags.length
                ? sceneTags
                : undefined,
          isDelete: !!(toDelete || onlyCancel),
          tsMs: Date.now(),
        };

        await this.plugin.recordRSLatte?.upsertFinanceRecord?.(indexItem);

        this.plugin.applyTodayFinanceRecord({
          id: 0,
          record_date: dateKey,
          category_id: this.cat.id,
          entry_id: indexItem.entryId,
          amount: Number(indexItem.amount),
          note: indexItem.note,
          is_delete: !!indexItem.isDelete,
          created_at: new Date().toISOString(),
        });

        const financeCat = this.plugin.settings.financeCategories?.find((c) => c.id === this.cat.id) as any;
        if (financeCat && !toDelete && !onlyCancel) {
          if (!Array.isArray(financeCat.institutionNames)) financeCat.institutionNames = [];
          const inst = String(institutionName ?? "").trim().replace(/\s+/g, " ");
          if (inst && !financeCat.institutionNames.includes(inst)) financeCat.institutionNames.push(inst);
          if (normalizedSub && !financeCat.subCategories) financeCat.subCategories = [];
          if (normalizedSub && financeCat.subCategories && !financeCat.subCategories.includes(normalizedSub)) {
            financeCat.subCategories.push(normalizedSub);
          }
        }

        await this.plugin.saveSettings();
        this.plugin.refreshSidePanel();
        try {
          const financeLeaves = this.app.workspace.getLeavesOfType("rslatte-financepanel");
          for (const leaf of financeLeaves) {
            const view = leaf.view as any;
            if (view && typeof view.refresh === "function") void view.refresh();
          }
        } catch {
          /* ignore */
        }
        void this.plugin.refreshFinanceSummaryFromApi(true);

        new Notice(toDelete || onlyCancel ? "已取消本笔" : priorEntryId ? "已更新" : "已保存");
        this.formMode = "list";
        this.editingIndex = null;
        await this.renderRoot();
      } catch (e: any) {
        new Notice("保存失败（详见控制台）");
        console.warn("FinanceRecordModal save failed", e);
      } finally {
        setInFlight(false);
      }
    };

    if (!onlyCancel) {
      window.setTimeout(() => {
        amountText?.inputEl?.focus();
        refreshValidationUI();
      }, 0);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

function normStr(v: unknown): string {
  return String(v ?? "").trim();
}
