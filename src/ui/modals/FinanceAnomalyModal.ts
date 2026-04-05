import { App, ButtonComponent, Modal, Notice, Setting, TextAreaComponent } from "obsidian";
import { TFile } from "obsidian";

import type RSLattePlugin from "../../main";
import type {
  FinanceAnomalyCycleIdMissingItem,
  FinanceAnomalyDuplicateCrossFileItem,
  FinanceAnomalyDuplicateItem,
  FinanceAnomalyLegacyItem,
} from "../../types/financeAnomalyTypes";
import { extractFinanceMeta, normalizeFinanceSubcategory } from "../../services/finance/financeSubcategory";
import { generateFinanceEntryId, peekFinanceMetaAfterMain, stringifyFinanceMetaComment } from "../../services/finance/financeJournalMeta";
import { generateFinanceCyclePlanId, findFinanceCyclePlanByQuadruple, normFinanceInstitution } from "../../services/finance/financeCyclePlan";
import type { FinanceCyclePlanRow } from "../../types/rslatteTypes";
import { normalizeFinanceCycleType } from "../../types/rslatteTypes";

const FIN_MAIN_RE =
  /^\s*[-*]\s+(?:(❌|✅)\s+)?(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?\s+(income|expense)\s+([A-Za-z0-9_]+)\s+(.*)$/;

/**
 * 生成新 meta 前确认：回车触发「确认」（非输入框内时由全局 keydown 兜底）。
 */
class GenerateFinanceMetaConfirmModal extends Modal {
  constructor(app: App, private onConfirm: () => void | Promise<void>) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("生成新的 meta");
    this.contentEl.createDiv({
      cls: "rslatte-modal-info",
      text: "当前操作将给该条目生成新的 entry_id，请确认当前条目非重复记录。",
    });

    const row = this.contentEl.createDiv({ cls: "rslatte-modal-actions" });
    new ButtonComponent(row)
      .setButtonText("取消")
      .onClick(() => this.close());

    const confirmBtn = new ButtonComponent(row)
      .setButtonText("确认")
      .setCta()
      .onClick(async () => {
        try {
          await Promise.resolve(this.onConfirm());
        } finally {
          this.close();
        }
      });

    window.setTimeout(() => confirmBtn.buttonEl.focus(), 20);

    this.registerDomEvent(
      this.modalEl,
      "keydown",
      (evt: KeyboardEvent) => {
        if (evt.key !== "Enter") return;
        const tag = (evt.target as HTMLElement | null)?.tagName;
        if (tag === "TEXTAREA" || tag === "INPUT") return;
        // 焦点在按钮上时交给默认行为（取消/确认各自响应回车）
        if (tag === "BUTTON") return;
        evt.preventDefault();
        void confirmBtn.buttonEl.click();
      },
      { capture: true }
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * 财务异常记录清单：无 meta 的 legacy 主行、同一文件内重复 entry_id、跨文件重复 entry_id。
 */
export class FinanceAnomalyModal extends Modal {
  constructor(app: App, private plugin: RSLattePlugin) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText("财务异常清单");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createDiv({
      cls: "rslatte-modal-info",
      text: "正在扫描日记目录…",
    });

    void this.runScanAndRender(contentEl);
  }

  /** 写入成功后重新扫描并重绘内容区，避免仍显示已修复项导致重复点击 */
  private async refreshAnomalyList(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.createDiv({
      cls: "rslatte-modal-info",
      text: "正在刷新清单…",
    });
    await this.runScanAndRender(this.contentEl);
  }

  private async runScanAndRender(container: HTMLElement) {
    try {
      await this.plugin.recordRSLatte?.ensureReady?.();
      const r = await this.plugin.recordRSLatte?.scanFinanceAnomalies?.();
      container.empty();

      if (!r) {
        container.createDiv({ text: "无法扫描（recordRSLatte 未就绪）", cls: "rslatte-muted" });
        return;
      }

      const crossN = r.duplicateCrossFiles?.length ?? 0;
      const cycN = r.cycleIdMissing?.length ?? 0;
      container.createDiv({
        cls: "rslatte-modal-info",
        text: `已扫描 ${r.scannedFileCount} 个日记文件 · legacy ${r.legacy.length} 条 · 同文件重复 entry_id ${r.duplicates.length} 组 · 跨文件重复 entry_id ${crossN} 组 · 周期项缺 cycle_id ${cycN} 条`,
      });

      if (r.legacy.length === 0 && r.duplicates.length === 0 && crossN === 0 && cycN === 0) {
        container.createDiv({ cls: "rslatte-setting-item", text: "未发现异常。" });
      }

      if (r.legacy.length > 0) {
        container.createEl("h4", { text: "一、无合法 meta / 无 entry_id（legacy）" });
        container.createDiv({
          cls: "rslatte-muted",
          text: "请在主行下一行插入 meta 注释，或删除无效主行。可点「插入建议 meta 行」自动写入主行紧邻下一行。",
        });
        for (const it of r.legacy) {
          this.renderLegacyCard(container, it);
        }
      }

      if (r.duplicates.length > 0) {
        container.createEl("h4", { text: "二、同一文件内重复 entry_id" });
        container.createDiv({
          cls: "rslatte-muted",
          text: "请保留一组主行+meta，对其余重复块可点「生成新的 meta」确认后直接改写日记中的 meta 行，或删除整块。",
        });
        for (const it of r.duplicates) {
          this.renderDuplicateCard(container, it);
        }
      }

      if (crossN > 0) {
        container.createEl("h4", { text: "三、跨文件重复 entry_id" });
        container.createDiv({
          cls: "rslatte-muted",
          text: "同一 id 出现在多个日记文件中（常见于复制日记后只改了主行日期）。请对其中若干条「生成新的 meta」确认后直接替换该文件中的 meta 行，或删除误复制块。成功写入后会尽力刷新财务索引。",
        });
        for (const it of r.duplicateCrossFiles) {
          this.renderCrossFileDuplicateCard(container, it);
        }
      }

      if (cycN > 0) {
        container.createEl("h4", { text: "四、周期流水缺少 cycle_id" });
        container.createDiv({
          cls: "rslatte-muted",
          text: "meta 中 cycle_type 非「无周期」但未写 cycle_id。可加入周期表并写入 ID，或忽略（meta 写 cycle_id 为 none）。",
        });
        for (const it of r.cycleIdMissing ?? []) {
          this.renderCycleIdMissingCard(container, it);
        }
      }

      new Setting(container).addButton((b) => b.setButtonText("关闭").onClick(() => this.close()));
    } catch (e) {
      container.empty();
      container.createDiv({ text: `扫描失败：${String((e as any)?.message ?? e)}`, cls: "rslatte-error" });
      console.warn("[RSLatte] scanFinanceAnomalies UI failed", e);
    }
  }

  private renderLegacyCard(parent: HTMLElement, it: FinanceAnomalyLegacyItem) {
    const card = parent.createDiv({ cls: "rslatte-finance-anomaly-card" });
    card.createDiv({
      cls: "rslatte-finance-anomaly-card-title",
      text: `${it.filePath}  ·  第 ${it.lineNumber} 行  ·  ${it.dayKey}`,
    });
    if (it.categoryId) {
      card.createDiv({ cls: "rslatte-muted", text: `分类 ID：${it.categoryId}` });
    }
    const ta = new TextAreaComponent(card);
    ta.setValue(it.preview);
    ta.inputEl.rows = 2;
    ta.inputEl.addClass("rslatte-finance-anomaly-preview");
    ta.setDisabled(true);

    const sub = this.subcategoryFromMainLine(it.preview);
    const suggestedMeta = stringifyFinanceMetaComment({
      entry_id: generateFinanceEntryId(),
      subcategory: sub,
    });

    const row = card.createDiv({ cls: "rslatte-finance-anomaly-actions" });
    new ButtonComponent(row)
      .setButtonText("打开记录所在文件")
      .onClick(() => void this.openFile(it.filePath));
    new ButtonComponent(row)
      .setButtonText("插入建议 meta 行")
      .setTooltip("在主行（清单所示行号）紧邻下一行自动插入下方建议的 meta")
      .onClick(() => void this.insertSuggestedMetaForLegacy(it, suggestedMeta));
    card.createDiv({ cls: "rslatte-finance-anomaly-code", text: suggestedMeta });
  }

  private renderCrossFileDuplicateCard(parent: HTMLElement, it: FinanceAnomalyDuplicateCrossFileItem) {
    const card = parent.createDiv({ cls: "rslatte-finance-anomaly-card" });
    card.createDiv({
      cls: "rslatte-finance-anomaly-card-title",
      text: `entry_id：${it.entryId}（${it.occurrences.length} 处 · 跨 ${new Set(it.occurrences.map((o) => o.filePath)).size} 个文件）`,
    });
    for (const oc of it.occurrences) {
      const row = card.createDiv({ cls: "rslatte-finance-anomaly-dup-row" });
      row.createSpan({
        text: `${oc.filePath}  ·  L${oc.lineNumber}  ·  ${oc.dayKey}  ·  `,
        cls: "rslatte-finance-anomaly-ln",
      });
      row.createSpan({ text: oc.preview, cls: "rslatte-finance-anomaly-preview-inline" });

      new ButtonComponent(row)
        .setButtonText("打开记录所在文件")
        .onClick(() => void this.openFile(oc.filePath));
      new ButtonComponent(row)
        .setButtonText("生成新的 meta")
        .setTooltip("确认后直接替换该主行下一行的 meta 注释为新 entry_id")
        .onClick(() =>
          new GenerateFinanceMetaConfirmModal(this.app, () =>
            this.replaceFinanceMetaWithNewEntryId(oc.filePath, oc.lineNumber)
          ).open()
        );
    }
  }

  private renderDuplicateCard(parent: HTMLElement, it: FinanceAnomalyDuplicateItem) {
    const card = parent.createDiv({ cls: "rslatte-finance-anomaly-card" });
    card.createDiv({
      cls: "rslatte-finance-anomaly-card-title",
      text: `${it.filePath}  ·  entry_id：${it.entryId}`,
    });
    for (let k = 0; k < it.mainLineNumbers.length; k++) {
      const ln = it.mainLineNumbers[k];
      const pv = it.previews[k] ?? "";
      const row = card.createDiv({ cls: "rslatte-finance-anomaly-dup-row" });
      row.createSpan({ text: `主行 L${ln}：`, cls: "rslatte-finance-anomaly-ln" });
      row.createSpan({ text: pv, cls: "rslatte-finance-anomaly-preview-inline" });

      new ButtonComponent(row)
        .setButtonText("打开记录所在文件")
        .onClick(() => void this.openFile(it.filePath));
      new ButtonComponent(row)
        .setButtonText("生成新的 meta")
        .setTooltip("确认后直接替换该主行下一行的 meta 注释为新 entry_id")
        .onClick(() =>
          new GenerateFinanceMetaConfirmModal(this.app, () =>
            this.replaceFinanceMetaWithNewEntryId(it.filePath, ln)
          ).open()
        );
    }
  }

  /** 从主行文本解析 tail 中的子分类前缀 */
  private subcategoryFromMainLine(mainLine: string): string {
    const m = mainLine.match(FIN_MAIN_RE);
    if (!m) return "未分类";
    const tail = String(m[6] ?? "");
    const { subcategory } = extractFinanceMeta(tail);
    return subcategory ? String(subcategory).trim() : "未分类";
  }

  private async refreshFinanceIndexBestEffort(): Promise<void> {
    try {
      await this.plugin.recordRSLatte?.refreshIndexIncrementalFromDiary?.({
        updateLists: true,
        modules: { checkin: false, finance: true },
      });
    } catch (e) {
      console.warn("[RSLatte] refresh finance index after finance meta write:", e);
    }
  }

  /**
   * legacy：在主行（1-based）下一行插入建议的 meta 整行（跳过空白后若已有合法 meta 则跳过）。
   */
  private async insertSuggestedMetaForLegacy(it: FinanceAnomalyLegacyItem, suggestedMetaLine: string): Promise<void> {
    const af = this.app.vault.getAbstractFileByPath(it.filePath);
    if (!(af instanceof TFile)) {
      new Notice("找不到文件");
      return;
    }
    try {
      const raw = await this.app.vault.read(af);
      const nl = raw.includes("\r\n") ? "\r\n" : "\n";
      const lines = raw.split(/\r?\n/);
      const i = it.lineNumber - 1;
      if (i < 0 || i >= lines.length) {
        new Notice("行号无效");
        return;
      }
      const mainTrim = String(lines[i] ?? "").trim();
      const previewTrim = String(it.preview ?? "").trim();
      // 扫描端 preview 可能截断为 200 字，故用前缀匹配
      if (
        previewTrim &&
        mainTrim !== previewTrim &&
        !mainTrim.startsWith(previewTrim)
      ) {
        new Notice("该主行内容与扫描时不一致，请刷新异常清单后再试，或手工核对行号");
        return;
      }
      const peek = peekFinanceMetaAfterMain(lines, i);
      if (peek) {
        new Notice("主行下已有合法 meta，无需插入");
        return;
      }
      const next = [...lines];
      next.splice(it.lineNumber, 0, suggestedMetaLine);
      await this.app.vault.modify(af, next.join(nl));
      new Notice("已插入 meta 行并写入笔记");
      await this.refreshFinanceIndexBestEffort();
      await this.refreshAnomalyList();
    } catch (e) {
      console.warn("[RSLatte] insertSuggestedMetaForLegacy failed", e);
      new Notice(`写入失败：${String((e as Error)?.message ?? e)}`);
    }
  }

  /**
   * 定位财务主行（1-based 行号）紧邻的 meta 行，写入新 entry_id（其余 meta 字段沿用），并 `vault.modify` 落盘。
   */
  private async replaceFinanceMetaWithNewEntryId(filePath: string, mainLineNumber: number): Promise<void> {
    const af = this.app.vault.getAbstractFileByPath(filePath);
    if (!(af instanceof TFile)) {
      new Notice("找不到文件");
      return;
    }
    try {
      const raw = await this.app.vault.read(af);
      const nl = raw.includes("\r\n") ? "\r\n" : "\n";
      const lines = raw.split(/\r?\n/);
      const i = mainLineNumber - 1;
      if (i < 0 || i >= lines.length) {
        new Notice("行号无效");
        return;
      }
      const peek = peekFinanceMetaAfterMain(lines, i);
      if (!peek) {
        new Notice("未找到主行下一行的合法 meta，无法自动替换");
        return;
      }
      const m = peek.meta;
      const newMetaLine = stringifyFinanceMetaComment({
        entry_id: generateFinanceEntryId(),
        subcategory: m.subcategory,
        institution_name: m.institution_name,
        cycle_type: m.cycle_type,
        cycle_id: m.cycle_id,
        scene_tags: m.scene_tags,
        is_delete: m.is_delete === true ? true : undefined,
      });
      const next = [...lines];
      next[peek.lineIndex] = newMetaLine;
      await this.app.vault.modify(af, next.join(nl));
      new Notice("已替换 meta 行并写入笔记");
      await this.refreshFinanceIndexBestEffort();
      await this.refreshAnomalyList();
    } catch (e) {
      console.warn("[RSLatte] replaceFinanceMetaWithNewEntryId failed", e);
      new Notice(`写入失败：${String((e as Error)?.message ?? e)}`);
    }
  }

  private renderCycleIdMissingCard(parent: HTMLElement, it: FinanceAnomalyCycleIdMissingItem) {
    const card = parent.createDiv({ cls: "rslatte-finance-anomaly-card" });
    card.createDiv({
      cls: "rslatte-finance-anomaly-card-title",
      text: `${it.filePath} · L${it.lineNumber} · ${it.dayKey} · ${it.entryId}`,
    });
    card.createDiv({
      cls: "rslatte-muted",
      text: `分类 ${it.categoryId ?? ""} · 子类 ${it.subcategory ?? ""} · 机构 ${it.institutionName ?? ""} · 周期 ${it.cycleType ?? ""}`,
    });
    const row = card.createDiv({ cls: "rslatte-finance-anomaly-actions" });
    new ButtonComponent(row).setButtonText("打开所在文件").onClick(() => void this.openFile(it.filePath));
    new ButtonComponent(row).setButtonText("加入周期表").onClick(() => void this.joinCycleTableFromAnomaly(it));
    new ButtonComponent(row).setButtonText("忽略").onClick(() => void this.ignoreCycleIdMissingAnomaly(it));
  }

  private async patchFinanceMetaCycleId(
    filePath: string,
    mainLineNumber1Based: number,
    cycleIdValue: string
  ): Promise<void> {
    const af = this.app.vault.getAbstractFileByPath(filePath);
    if (!(af instanceof TFile)) {
      new Notice("找不到文件");
      return;
    }
    try {
      const raw = await this.app.vault.read(af);
      const nl = raw.includes("\r\n") ? "\r\n" : "\n";
      const lines = raw.split(/\r?\n/);
      const i = mainLineNumber1Based - 1;
      if (i < 0 || i >= lines.length) {
        new Notice("行号无效");
        return;
      }
      const peek = peekFinanceMetaAfterMain(lines, i);
      if (!peek) {
        new Notice("未找到主行下一行的 meta");
        return;
      }
      const m = peek.meta;
      const newLine = stringifyFinanceMetaComment({
        entry_id: m.entry_id,
        subcategory: m.subcategory,
        institution_name: m.institution_name,
        cycle_type: m.cycle_type,
        cycle_id: cycleIdValue,
        scene_tags: m.scene_tags,
        is_delete: m.is_delete === true ? true : undefined,
      });
      const next = [...lines];
      next[peek.lineIndex] = newLine;
      await this.app.vault.modify(af, next.join(nl));
      new Notice("已更新 cycle_id");
      await this.refreshFinanceIndexBestEffort();
      await this.refreshAnomalyList();
    } catch (e) {
      console.warn("[RSLatte] patchFinanceMetaCycleId failed", e);
      new Notice(`写入失败：${String((e as Error)?.message ?? e)}`);
    }
  }

  private async joinCycleTableFromAnomaly(it: FinanceAnomalyCycleIdMissingItem): Promise<void> {
    try {
      const catId = String(it.categoryId ?? "").trim();
      const sub = normalizeFinanceSubcategory(String(it.subcategory ?? ""));
      const inst = normFinanceInstitution(String(it.institutionName ?? ""));
      const ct = normalizeFinanceCycleType(it.cycleType ?? "none");
      if (!catId || !sub || !inst || ct === "none") {
        new Notice("分类/子分类/机构/周期不完整，请先在日记或 meta 中补全");
        return;
      }
      const plans = this.plugin.settings.financeCyclePlans ?? [];
      if (!this.plugin.settings.financeCyclePlans) this.plugin.settings.financeCyclePlans = plans;
      let plan = findFinanceCyclePlanByQuadruple(plans, catId, sub, inst, ct);
      if (!plan) {
        const row: FinanceCyclePlanRow = {
          id: generateFinanceCyclePlanId(),
          catId,
          subcategory: sub,
          institutionName: inst,
          cycleType: ct,
          anchorDate: String(it.dayKey ?? "").slice(0, 10),
          graceDays: 0,
          enabled: true,
          referenced: false,
        };
        plans.push(row);
        plan = row;
        await this.plugin.saveSettings();
      }
      await this.patchFinanceMetaCycleId(it.filePath, it.lineNumber, plan.id);
    } catch (e) {
      console.warn("[RSLatte] joinCycleTableFromAnomaly failed", e);
      new Notice(`失败：${String((e as Error)?.message ?? e)}`);
    }
  }

  private async ignoreCycleIdMissingAnomaly(it: FinanceAnomalyCycleIdMissingItem): Promise<void> {
    await this.patchFinanceMetaCycleId(it.filePath, it.lineNumber, "none");
  }

  private async openFile(path: string) {
    const af = this.app.vault.getAbstractFileByPath(path);
    if (!af || !(af instanceof TFile)) {
      new Notice("找不到文件");
      return;
    }
    await this.app.workspace.getLeaf(true).openFile(af);
    new Notice("已打开笔记，请按清单中的行号定位");
  }

  onClose() {
    this.contentEl.empty();
  }
}
