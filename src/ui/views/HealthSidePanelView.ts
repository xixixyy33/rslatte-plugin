import { ButtonComponent, ItemView, Notice, TFile, WorkspaceLeaf, moment } from "obsidian";
import type RSLattePlugin from "../../main";
import { VIEW_TYPE_HEALTH } from "../../constants/viewTypes";
import { HealthCardModal } from "../modals/AddHealthRecordModal";
import { EditHealthEntryModal } from "../modals/EditHealthEntryModal";
import {
  healthMainLineValueDisplay,
  healthMetricLabelZh,
  isDietHeatLevel,
  mapLegacyDietLevelToHeat,
} from "../../types/healthTypes";
import {
  HEALTH_CANONICAL_METRICS_ORDER,
  healthCanonicalShortLabelZh,
  itemMatchesCanonicalMetricFilter,
  normalizeIndexMetricKeyToCanonical,
} from "../../services/health/healthCanonicalMetrics";
import {
  buildHealthListItemLine,
  findHealthMainLineIndexInDiaryLines,
  normalizeHealthCreatedAtMs,
  normalizeSleepStartHm,
  stringifyHealthMetaComment,
  type HealthJournalMetaPayload,
} from "../../services/health/healthJournalMeta";
import { inferCardRefFromItem, parseMonthCardRef, parseWeekCardRef } from "../../services/health/healthCardRef";
import { readHealthAnalysisAlertIndex } from "../../services/health/healthAnalysisAlertIndex";
import {
  readHealthAnalysisIndex,
  readHealthAlertsSnapshot,
  readHealthStatsSnapshot,
  restoreHealthMonthSnapshotsFromBackup,
  writeHealthAnalysisSnapshotsForMonths,
} from "../../services/health/healthAnalysisIndex";
import type { HealthRecordIndexItem } from "../../types/recordIndexTypes";
import { toLocalOffsetIsoString } from "../../utils/localCalendarYmd";
import { getUiHeaderButtonsVisibility } from "../helpers/uiHeaderButtons";
import {
  collectDayWeightSeries,
  collectWeekWaistSeries,
  getHealthTargetWaistCm,
  getHealthTargetWeightKg,
  loadMergedHealthIndexItems,
  renderHealthWaistTrendChart,
  renderHealthWeightTrendChart,
} from "../helpers/healthWeightTrendChart";

const momentFn = moment as any;

type LedgerPeriodFilter = "all" | "day" | "week" | "month";

/** 健康清单时间轴标题：周期角标（与日记存盘无关，仅展示） */
function ledgerPeriodBracket(period?: string): string {
  const p = String(period ?? "day").trim().toLowerCase();
  if (p === "week") return "【周】";
  if (p === "month") return "【月】";
  return "【日】";
}

function timelineDot(period?: string): string {
  const p = String(period ?? "day").trim().toLowerCase();
  if (p === "week") return "◐";
  if (p === "month") return "●";
  return "○";
}

function normalizeLedgerMetricKey(metricKey: string): string {
  const mk = String(metricKey ?? "").trim();
  if (mk === "diet_level" || mk === "diet_text") return "diet";
  return mk;
}

function itemMatchesMetricFilter(it: HealthRecordIndexItem, filterKey: string): boolean {
  return itemMatchesCanonicalMetricFilter(it, filterKey);
}

function formatLedgerTitleValue(it: HealthRecordIndexItem, waterCupMl?: number): string {
  const mk = String(it.metricKey ?? "").trim();
  const raw = String(it.valueStr ?? "").trim();
  if (mk === "water_cups") {
    return healthMainLineValueDisplay("water_cups", raw, { waterCupMl });
  }
  if (mk === "diet_level") {
    const h = mapLegacyDietLevelToHeat(raw);
    return isDietHeatLevel(h) ? h : raw;
  }
  if (mk === "diet" && isDietHeatLevel(raw)) return raw;
  if (mk === "diet_text") {
    const nt = String(it.note ?? "").trim();
    const vs = raw === "_" || raw === "." || raw === "—" ? "" : raw;
    const t = [vs, nt].filter(Boolean).join(" ").trim();
    return t.length > 24 ? `${t.slice(0, 24)}…` : t;
  }
  if (mk === "diet") {
    return raw === "_" || raw === "." || raw === "—" ? "" : raw;
  }
  if (mk === "menstruation") {
    if (raw === "_" || raw === "." || raw === "—") return "";
    return healthMainLineValueDisplay("menstruation", raw, { waterCupMl: waterCupMl });
  }
  if (mk === "glucose") {
    if (raw === "_" || raw === "." || raw === "—") return "";
    return healthMainLineValueDisplay("glucose", raw, {});
  }
  if (raw === "_" || raw === "." || raw === "—") return "";
  return raw;
}

function ledgerTitleLabelForItem(it: HealthRecordIndexItem): string {
  const mk = String(it.metricKey ?? "").trim();
  const c = normalizeIndexMetricKeyToCanonical(mk);
  if (c) return healthCanonicalShortLabelZh(c);
  return healthMetricLabelZh(mk);
}

function buildLedgerMetaLine(it: HealthRecordIndexItem, cardRef: string): string {
  const parts: string[] = [];
  const w = parseWeekCardRef(cardRef);
  if (w) parts.push(`W${String(w.isoWeek).padStart(2, "0")}`);
  const mo = parseMonthCardRef(cardRef);
  if (mo) parts.push(`M${String(mo.m).padStart(2, "0")}`);
  const mk = String(it.metricKey ?? "").trim();
  const note = String(it.note ?? "").trim();
  if ((mk === "diet" || mk === "diet_text") && note) {
    const short = [...note].length > 40 ? [...note].slice(0, 40).join("") + "…" : note;
    parts.push(`饮食日记：${short}`);
  }
  if (mk === "water_cups") {
    const cups = parseInt(String(it.valueStr ?? "").trim(), 10);
    if (Number.isFinite(cups) && cups >= 0) {
      parts.push(`杯数：${cups} 杯`);
    }
  }
  if (mk === "sleep_hours") {
    const hm = String(it.sleepStartHm ?? "").trim();
    if (hm) parts.push(`入睡：${hm}`);
  }
  return parts.join(" · ");
}

/**
 * 健康管理侧栏：清单（中央索引）时间轴 + 筛选 + 单条编辑；统计（月快照 + 基础/规则告警）；撤销写入日记与索引。
 */
export class HealthSidePanelView extends ItemView {
  private plugin: RSLattePlugin;
  private _renderSeq = 0;
  private _contentTab: "ledger" | "stats" = "ledger";
  /** 「健康统计明细」所选自然月 YYYY-MM */
  private _statsSelectedMonth: string;
  private _pendingNavFlash: { entryId: string; recordDate: string; expectSeq: number } | null = null;
  private _ledgerFilterPeriod: LedgerPeriodFilter = "all";
  private _ledgerFilterMetricKey = "";
  private _ledgerFilterDateKey = "";

  constructor(leaf: WorkspaceLeaf, plugin: RSLattePlugin) {
    super(leaf);
    this.plugin = plugin;
    this._statsSelectedMonth = momentFn().format("YYYY-MM");
  }

  getViewType(): string {
    return VIEW_TYPE_HEALTH;
  }
  getDisplayText(): string {
    return "健康管理";
  }
  getIcon(): string {
    return "heart-pulse";
  }

  async onOpen(): Promise<void> {
    try {
      await this.plugin.recordRSLatte?.ensureReady?.();
    } catch {
      // ignore
    }
    void this.render();
  }

  async onClose(): Promise<void> {}

  /** 外部跳转：清单页签 + 高亮时间轴行（与财务侧栏同构，DOM 就绪后闪动） */
  public applyLedgerNavFocus(opts: { entryId: string; recordDate: string }): void {
    const entryId = String(opts.entryId ?? "").trim();
    const recordDate = String(opts.recordDate ?? "").trim();
    if (!entryId || !/^\d{4}-\d{2}-\d{2}$/.test(recordDate)) return;
    this._contentTab = "ledger";
    this._pendingNavFlash = { entryId, recordDate, expectSeq: this._renderSeq + 1 };
    void this.render();
  }

  public openLedgerContentTab(): void {
    this._contentTab = "ledger";
    void this.render();
  }

  public openStatsContentTab(): void {
    this._contentTab = "stats";
    void this.render();
  }

  public refresh(): void {
    void this.render();
  }

  private escapeForHealthNavSelector(s: string): string {
    const esc = (globalThis as any).CSS?.escape as ((x: string) => string) | undefined;
    return typeof esc === "function" ? esc(s) : s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  private maybeRunNavFlash(seq: number): void {
    const p = this._pendingNavFlash;
    if (!p || p.expectSeq !== seq || seq !== this._renderSeq) return;
    this._pendingNavFlash = null;
    window.requestAnimationFrame(() => {
      window.setTimeout(() => {
        if (seq !== this._renderSeq) return;
        const root = this.containerEl.children[1] as HTMLElement | undefined;
        if (!root) return;
        const idEsc = this.escapeForHealthNavSelector(p.entryId);
        const row = root.querySelector(
          `.rslatte-health-timeline-item[data-entry-id="${idEsc}"]`,
        ) as HTMLElement | null;
        if (!row) return;
        row.scrollIntoView({ block: "nearest", behavior: "smooth" });
        row.addClass("rslatte-health-timeline-item--nav-flash");
        window.setTimeout(() => row.removeClass("rslatte-health-timeline-item--nav-flash"), 2600);
      }, 120);
    });
  }

  private getWaterCupMl(): number {
    const s = (this.plugin.settings as any).healthPanel ?? {};
    return Math.max(50, Math.min(2000, Number(s.waterCupVolumeMl) || 500));
  }

  private pickHealthSourceLine(it: HealthRecordIndexItem): number | null {
    const raw = it.sourceLineMain;
    if (raw === undefined || raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  /** 打开该条健康记录所在日记并滚到主行（与 `FinanceSidePanelView.openFinanceRecordInDiary` 同构） */
  private async openHealthRecordInDiary(it: HealthRecordIndexItem): Promise<void> {
    const dateKey = String(it.recordDate ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      new Notice("记录日期无效，无法打开日记");
      return;
    }

    let filePath = String(it.sourceFilePath ?? "").trim();
    let line0 = this.pickHealthSourceLine(it);

    if (!filePath || line0 === null) {
      const resolvedPath = this.plugin.journalSvc.findDiaryPathForDateKey(dateKey);
      if (!resolvedPath) {
        new Notice("未找到该日期的日记文件");
        return;
      }
      const diaryFile = this.app.vault.getAbstractFileByPath(resolvedPath);
      if (!(diaryFile instanceof TFile)) {
        new Notice(`找不到文件：${resolvedPath}`);
        return;
      }
      const raw = await this.app.vault.read(diaryFile);
      const lines = raw.split("\n");
      const entryId = String(it.entryId ?? "").trim();
      const found = findHealthMainLineIndexInDiaryLines(lines, dateKey, {
        entryId: entryId || undefined,
        metricKey: String(it.metricKey ?? "").trim(),
        valueStr: String(it.valueStr ?? "").trim(),
        isDelete: !!it.isDelete,
        waterCupMl: this.getWaterCupMl(),
      });
      if (found == null) {
        new Notice(
          entryId
            ? "无法在日记中定位该条记录，请尝试「扫描重建」健康索引"
            : "无法在日记中定位该条记录（无 entry_id 时仅支持无 meta 的旧格式），请扫描重建或补全 meta",
        );
        return;
      }
      filePath = resolvedPath;
      line0 = found;
    }

    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      new Notice(`找不到文件：${filePath}`);
      return;
    }

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file, { active: true, state: { mode: "source" } });

    window.setTimeout(() => {
      const view: any = leaf.view as any;
      const editor = view?.editor;
      if (!editor) return;
      const ln = Math.max(0, line0 ?? 0);
      try {
        editor.setCursor({ line: ln, ch: 0 });
        editor.scrollIntoView({ from: { line: ln, ch: 0 }, to: { line: ln + 1, ch: 0 } }, true);
      } catch {
        // ignore
      }
    }, 50);
  }

  private sortLedgerItems(items: HealthRecordIndexItem[]): HealthRecordIndexItem[] {
    return items.slice().sort((a, b) => {
      const dc = String(b.recordDate ?? "").localeCompare(String(a.recordDate ?? ""));
      if (dc !== 0) return dc;
      return (Number(b.tsMs) || 0) - (Number(a.tsMs) || 0);
    });
  }

  private filterLedgerItems(items: HealthRecordIndexItem[]): HealthRecordIndexItem[] {
    return items.filter((it) => {
      const p = String(it.period ?? "day").trim().toLowerCase();
      if (this._ledgerFilterPeriod !== "all" && p !== this._ledgerFilterPeriod) return false;
      const fk = normalizeLedgerMetricKey(this._ledgerFilterMetricKey);
      if (this._ledgerFilterMetricKey && !itemMatchesMetricFilter(it, fk)) return false;
      if (this._ledgerFilterDateKey && String(it.recordDate ?? "").trim() !== this._ledgerFilterDateKey) return false;
      return true;
    });
  }

  private async deleteHealthRecord(it: HealthRecordIndexItem): Promise<void> {
    const entryId = String(it.entryId ?? "").trim();
    const dateKey = String(it.recordDate ?? "").trim();
    if (!entryId) {
      new Notice("该条无 entry_id，请打开对应日记手动标注或扫描重建后再试。");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return;

    try {
      await this.plugin.recordRSLatte?.ensureReady?.();
      const timeHm = momentFn().format("HH:mm");
      const metricKey = String(it.metricKey ?? "").trim();
      const valueStr = String(it.valueStr ?? "").trim();
      const cardRef = String(it.cardRef ?? "").trim() || inferCardRefFromItem(it);
      const main = buildHealthListItemLine({
        anchorDateKey: dateKey,
        metricKey,
        valueToken: valueStr,
        note: it.note ? String(it.note) : undefined,
        timeHm,
        isDelete: true,
        cardDisplay: cardRef,
        waterCupMl: this.getWaterCupMl(),
      });
      const delMeta: HealthJournalMetaPayload = {
        entry_id: entryId,
        metric_key: metricKey,
        period: String(it.period ?? "day").trim() || "day",
        card_ref: cardRef || undefined,
        is_delete: true,
      };
      if (metricKey === "diet" && it.note) delMeta.diet_note = String(it.note).trim().slice(0, 100);
      if (metricKey === "water_cups") {
        const cups = parseInt(valueStr, 10);
        if (Number.isFinite(cups) && cups >= 0) delMeta.cups = Math.min(30, Math.floor(cups));
      }
      const delSsh = normalizeSleepStartHm(String(it.sleepStartHm ?? ""));
      if (metricKey === "sleep_hours" && delSsh) delMeta.sleep_start_hm = delSsh;
      const delCa = normalizeHealthCreatedAtMs(it.createdAtMs) ?? normalizeHealthCreatedAtMs(it.tsMs);
      if (delCa != null) delMeta.created_at_ms = delCa;
      const meta = stringifyHealthMetaComment(delMeta);

      await ((this.plugin as any).appendJournalByModule?.("health", dateKey, [main, meta]) ?? Promise.resolve());

      await this.plugin.recordRSLatte?.upsertHealthRecord({
        recordDate: dateKey,
        entryId,
        metricKey,
        period: String(it.period ?? "day").trim() || "day",
        cardRef: cardRef || undefined,
        valueStr,
        note: it.note ? String(it.note) : undefined,
        sleepStartHm: metricKey === "sleep_hours" ? delSsh : undefined,
        isDelete: true,
        tsMs: Date.now(),
      });

      try {
        await this.plugin.workEventSvc?.append({
          ts: toLocalOffsetIsoString(),
          kind: "health",
          action: "delete",
          source: "ui",
          ref: {
            record_date: dateKey,
            metric_key: metricKey,
            period: String(it.period ?? "day").trim() || "day",
            entry_id: entryId,
          },
          summary: `❌ ${healthMetricLabelZh(metricKey)} ${healthMainLineValueDisplay(metricKey, valueStr, { waterCupMl: this.getWaterCupMl() })}`,
          metrics: { is_delete: true },
        });
      } catch {
        // ignore
      }

      new Notice("已撤销该条健康记录");
      this.plugin.refreshSidePanel();
      void this.render();
    } catch (e: any) {
      new Notice(`撤销失败：${e?.message ?? String(e)}`);
    }
  }

  /** 与「财务记录清单」同构：label 左、控件右、圆角灰底筛选条 */
  private renderLedgerFilters(parent: HTMLElement): void {
    const filterBar = parent.createDiv({ cls: "rslatte-finance-filter-bar" });

    const periodRow = filterBar.createDiv({ cls: "rslatte-finance-filter-item" });
    periodRow.createEl("label", { text: "数据周期：", cls: "rslatte-finance-filter-label" });
    const periodSel = periodRow.createEl("select", { cls: "rslatte-finance-filter-select" });
    const periodOpts: Array<{ v: LedgerPeriodFilter; t: string }> = [
      { v: "all", t: "全部" },
      { v: "day", t: "日" },
      { v: "week", t: "周" },
      { v: "month", t: "月" },
    ];
    for (const o of periodOpts) {
      periodSel.createEl("option", { text: o.t, value: o.v });
    }
    periodSel.value = this._ledgerFilterPeriod;
    periodSel.onchange = () => {
      this._ledgerFilterPeriod = (periodSel.value as LedgerPeriodFilter) || "all";
      void this.render();
    };

    const metricRow = filterBar.createDiv({ cls: "rslatte-finance-filter-item" });
    metricRow.createEl("label", { text: "数据项：", cls: "rslatte-finance-filter-label" });
    const metricSel = metricRow.createEl("select", { cls: "rslatte-finance-filter-select" });
    metricSel.createEl("option", { text: "全部", value: "" });
    const seen = new Set<string>();
    for (const k of HEALTH_CANONICAL_METRICS_ORDER) {
      if (seen.has(k)) continue;
      seen.add(k);
      metricSel.createEl("option", {
        text: healthCanonicalShortLabelZh(k),
        value: k,
      });
    }
    const curFk = normalizeLedgerMetricKey(this._ledgerFilterMetricKey);
    metricSel.value = curFk && seen.has(curFk) ? curFk : "";
    metricSel.onchange = () => {
      this._ledgerFilterMetricKey = String(metricSel.value ?? "").trim();
      void this.render();
    };

    const dateRow = filterBar.createDiv({ cls: "rslatte-finance-filter-item" });
    dateRow.createEl("label", { text: "日记日期：", cls: "rslatte-finance-filter-label" });
    const dateInp = dateRow.createEl("input", {
      cls: "rslatte-finance-filter-date-input",
      type: "date",
      attr: { title: "按写入日记的日期（YYYY-MM-DD）筛选；留空为不过滤" },
    });
    dateInp.value = this._ledgerFilterDateKey || "";
    dateInp.onchange = () => {
      this._ledgerFilterDateKey = String(dateInp.value ?? "").trim().slice(0, 10);
      void this.render();
    };
    const clearDate = dateRow.createEl("button", {
      type: "button",
      cls: "rslatte-finance-filter-date-clear",
      text: "清除",
    });
    clearDate.onclick = () => {
      this._ledgerFilterDateKey = "";
      void this.render();
    };
  }

  /** 与 `FinanceSidePanelView.renderTimelineItem` 同构（竖线 + 圆点 + 标题行 + meta） */
  private renderHealthTimelineItem(parent: HTMLElement, it: HealthRecordIndexItem): void {
    const entryId = String(it.entryId ?? "").trim();
    const cref =
      String(it.cardRef ?? "").trim() ||
      inferCardRefFromItem({
        recordDate: it.recordDate,
        period: it.period,
        cardRef: it.cardRef,
      });
    const valPart = formatLedgerTitleValue(it, this.getWaterCupMl());
    const mk = String(it.metricKey ?? "").trim();
    const periodLo = String(it.period ?? "day").trim().toLowerCase();
    const titleText =
      mk === "menstruation" && periodLo === "month"
        ? (valPart ? `【月】月经周期 ${valPart}` : "【月】月经周期").trim()
        : `${ledgerPeriodBracket(it.period)}${ledgerTitleLabelForItem(it)}${valPart ? ` ${valPart}` : ""}`.trim();
    const metaText = buildLedgerMetaLine(it, cref);

    const row = parent.createDiv({
      cls: "rslatte-timeline-item rslatte-finance-timeline-item rslatte-health-timeline-item",
      attr: entryId ? { "data-entry-id": entryId } : {},
    });
    row.style.cursor = "pointer";
    row.title = "点击打开日记并定位到该条记录";

    row.onclick = async (e) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("button")) return;
      try {
        await this.openHealthRecordInDiary(it);
      } catch (err) {
        console.error("[RSLatte] open health in diary:", err);
        new Notice(String((err as Error)?.message ?? err ?? "打开失败"));
      }
    };

    const gutter = row.createDiv({ cls: "rslatte-timeline-gutter" });
    const dot = gutter.createDiv({ cls: "rslatte-timeline-dot" });
    dot.setText(timelineDot(it.period));
    gutter.createDiv({ cls: "rslatte-timeline-line" });

    const content = row.createDiv({ cls: "rslatte-timeline-content" });
    const titleRow = content.createDiv({ cls: "rslatte-timeline-title-row" });
    const titleEl = titleRow.createDiv({ cls: "rslatte-timeline-text" });
    titleEl.setText(titleText);

    const actions = titleRow.createDiv({ cls: "rslatte-finance-actions" });
    const editBtn = actions.createEl("button", {
      type: "button",
      text: "✏️",
      cls: "rslatte-finance-cancel-icon-btn rslatte-health-ledger-timeline-icon",
    });
    editBtn.disabled = !entryId;
    editBtn.title = entryId ? "修改本条" : "缺少 entry_id，无法编辑";
    editBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!entryId) return;
      new EditHealthEntryModal(this.app, this.plugin, {
        item: it,
        onSuccess: () => void this.render(),
      }).open();
    };

    const delBtn = actions.createEl("button", {
      type: "button",
      text: "❌",
      cls: "rslatte-finance-cancel-icon-btn rslatte-health-ledger-timeline-icon",
    });
    delBtn.disabled = !entryId;
    delBtn.title = entryId ? "撤销该条" : "缺少 entry_id，无法撤销";
    delBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.deleteHealthRecord(it);
    };

    if (metaText) {
      content.createDiv({ cls: "rslatte-timeline-meta", text: metaText });
    }
  }

  private async render(): Promise<void> {
    const seq = ++this._renderSeq;
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("rslatte-health-panel");

    if (!this.plugin.isHealthModuleEnabled()) {
      container.createDiv({ cls: "rslatte-muted", text: "健康模块未启用：请在设置中开启「健康管理」。" });
      return;
    }

    const header = container.createDiv({ cls: "rslatte-section" });
    const headerRow = header.createDiv({ cls: "rslatte-section-title-row" });
    headerRow.createEl("h3", { text: "❤️ 健康" });
    const actions = headerRow.createDiv({ cls: "rslatte-section-title-right" });

    const addBtn = actions.createEl("button", { text: "➕", cls: "rslatte-icon-btn" });
    addBtn.title = "新增健康记录";
    addBtn.onclick = () => {
      new HealthCardModal(this.app, this.plugin, { onSuccess: () => void this.render() }).open();
    };

    const hBtnVis = getUiHeaderButtonsVisibility(this.plugin.settings, "health");
    if (hBtnVis.rebuild) {
      const rebuildBtn = actions.createEl("button", { text: "🧱", cls: "rslatte-icon-btn" });
      rebuildBtn.title = "扫描重建健康索引（全量）";
      rebuildBtn.onclick = async () => {
        try {
          rebuildBtn.disabled = true;
          await this.manualRebuild();
        } finally {
          rebuildBtn.disabled = false;
        }
      };
    }
    if (hBtnVis.archive) {
      const archiveBtn = actions.createEl("button", { text: "🗄", cls: "rslatte-icon-btn" });
      archiveBtn.title = "索引归档：健康（超阈值的记录从主索引迁入 archive）";
      archiveBtn.onclick = async () => {
        try {
          archiveBtn.disabled = true;
          await this.manualArchive();
        } finally {
          archiveBtn.disabled = false;
        }
      };
    }
    if (hBtnVis.refresh) {
      const refreshBtn = actions.createEl("button", { text: "🔄", cls: "rslatte-icon-btn" });
      refreshBtn.title = "健康手动刷新（增量）：扫描阈值范围内变更日记";
      refreshBtn.onclick = async () => {
        try {
          refreshBtn.disabled = true;
          await this.manualRefresh();
        } finally {
          refreshBtn.disabled = false;
        }
      };
    }

    const tabs = container.createDiv({ cls: "rslatte-task-subtabs rslatte-health-subtabs" });
    const mkTab = (id: "ledger" | "stats", label: string) => {
      const btn = tabs.createEl("button", {
        type: "button",
        cls: `rslatte-task-subtab${this._contentTab === id ? " is-active" : ""}`,
        text: label,
      });
      btn.onclick = () => {
        this._contentTab = id;
        void this.render();
      };
    };
    mkTab("ledger", "健康数据清单");
    mkTab("stats", "健康统计明细");

    const body = container.createDiv({ cls: "rslatte-section rslatte-health-panel-body" });

    if (this._contentTab === "stats") {
      await this.renderHealthStatsDetail(body, seq);
      if (seq !== this._renderSeq) return;
    } else {
      let snap: { items?: HealthRecordIndexItem[] } = { items: [] };
      try {
        await this.plugin.recordRSLatte?.ensureReady?.();
        snap = (await this.plugin.recordRSLatte?.getHealthSnapshot(false)) ?? { items: [] };
      } catch (e) {
        console.warn("getHealthSnapshot failed", e);
      }
      if (seq !== this._renderSeq) return;

      const sorted = this.sortLedgerItems((snap.items ?? []).filter((x) => !x.isDelete));
      const active = this.filterLedgerItems(sorted);

      const listSection = body.createDiv({ cls: "rslatte-finance-list-section rslatte-health-ledger-list" });
      const listTitleRow = listSection.createDiv({ cls: "rslatte-finance-list-title-row" });
      listTitleRow.createEl("h3", { text: "健康数据清单" });
      listTitleRow.createSpan({
        cls: "rslatte-finance-list-stats",
        text: `共 ${active.length} 条`,
      });

      this.renderLedgerFilters(listSection);

      const weightFilterOn = normalizeLedgerMetricKey(this._ledgerFilterMetricKey) === "weight";
      if (weightFilterOn) {
        const chartHost = listSection.createDiv({ cls: "rslatte-health-weight-chart-ledger" });
        try {
          const merged = await loadMergedHealthIndexItems(this.plugin);
          if (seq !== this._renderSeq) return;
          const pts = collectDayWeightSeries(merged);
          const targetKg = getHealthTargetWeightKg(this.plugin.settings);
          renderHealthWeightTrendChart(chartHost, pts, targetKg);
        } catch (e) {
          console.warn("[RSLatte] health weight chart:", e);
        }
      }

      const waistFilterOn = normalizeLedgerMetricKey(this._ledgerFilterMetricKey) === "waist";
      if (waistFilterOn) {
        const chartHost = listSection.createDiv({ cls: "rslatte-health-waist-chart-ledger" });
        try {
          const merged = await loadMergedHealthIndexItems(this.plugin);
          if (seq !== this._renderSeq) return;
          const pts = collectWeekWaistSeries(merged);
          const targetCm = getHealthTargetWaistCm(this.plugin.settings);
          renderHealthWaistTrendChart(chartHost, pts, targetCm);
        } catch (e) {
          console.warn("[RSLatte] health waist chart:", e);
        }
      }

      if (active.length === 0) {
        listSection.createDiv({
          cls: "rslatte-muted",
          text:
            sorted.length === 0
              ? "暂无健康记录。点击标题栏右侧 ➕ 录入，或启用健康模块后执行「扫描重建」以从日记导入。"
              : "当前筛选下无记录。可调整上方周期 / 数据项 / 日期，或清除筛选。",
        });
      } else {
        const byDate = new Map<string, HealthRecordIndexItem[]>();
        for (const it of active) {
          const dk = String(it.recordDate ?? "").trim();
          if (!dk) continue;
          if (!byDate.has(dk)) byDate.set(dk, []);
          byDate.get(dk)!.push(it);
        }
        const sortedDates = Array.from(byDate.keys()).sort().reverse();
        const timeline = listSection.createDiv({ cls: "rslatte-timeline" });
        for (const dateKey of sortedDates) {
          const dayItems = byDate.get(dateKey)!;
          const daySection = timeline.createDiv({ cls: "rslatte-timeline-day" });
          daySection.createDiv({ cls: "rslatte-timeline-day-title", text: dateKey });
          const dayWrap = daySection.createDiv({ cls: "rslatte-timeline-day-items" });
          for (const it of dayItems) {
            this.renderHealthTimelineItem(dayWrap, it);
          }
        }
      }
    }

    this.maybeRunNavFlash(seq);
  }

  /**
   * 「健康统计明细」：月份选择、月快照汇总指标、合并项末次值、分析基础告警、当月规则告警（可跳转日记）。
   */
  private async renderHealthStatsDetail(parent: HTMLElement, seq: number): Promise<void> {
    parent.createEl("h3", { text: "健康统计明细", cls: "rslatte-finance-stats-main-title" });

    const monthBlock = parent.createDiv({ cls: "rslatte-finance-stats-block" });
    monthBlock.createEl("h4", { text: "统计月份" });
    const monthRow = monthBlock.createDiv({ cls: "rslatte-finance-stats-kv" });
    monthRow.createSpan({ cls: "rslatte-finance-stats-k", text: "选择" });
    const monthWrap = monthRow.createSpan({ cls: "rslatte-finance-stats-v" });
    const monthInput = monthWrap.createEl("input", { type: "month", cls: "rslatte-input" });
    monthInput.value = this._statsSelectedMonth;
    monthInput.onchange = () => {
      const v = String(monthInput.value ?? "").trim();
      if (/^\d{4}-\d{2}$/.test(v)) {
        this._statsSelectedMonth = v;
        void this.render();
      }
    };
    const snapRow = monthBlock.createDiv({ cls: "rslatte-analysis-snapshot-bar is-health" });
    {
      const smk = this._statsSelectedMonth;
      new ButtonComponent(snapRow)
        .setButtonText("🔄刷新当前年月分析快照")
        .setTooltip(`按当前索引重算 ${smk} 月 stats / 规则告警；写入前轮转备份（与 Review 相同，至多 3 版）`)
        .setCta()
        .onClick(() => {
          void (async () => {
            try {
              await writeHealthAnalysisSnapshotsForMonths(this.plugin, [smk], "stats_tab_refresh", {
                backupExisting: true,
              });
              new Notice(`已刷新 ${smk} 月分析快照（至多保留 3 版）`);
              void this.render();
            } catch (e) {
              console.error("[RSLatte] refresh health month snapshot failed", e);
              new Notice("刷新分析快照失败");
            }
          })();
        });
      new ButtonComponent(snapRow)
        .setButtonText("↩回退快照版本")
        .setTooltip(`将 ${smk} 月的 stats、alerts 各回退一档（需存在 .bak1.json 链）`)
        .onClick(() => {
          void (async () => {
            try {
              const r = await restoreHealthMonthSnapshotsFromBackup(this.plugin, smk);
              if (!r.stats && !r.alerts) {
                new Notice(`${smk} 月暂无可回退的备份（至少先成功刷新过一次才会生成 bak1）`);
                return;
              }
              new Notice(`已回退：stats ${r.stats ? "是" : "否"}，alerts ${r.alerts ? "是" : "否"}`);
              void this.render();
            } catch (e) {
              console.error("[RSLatte] rollback health month snapshot failed", e);
              new Notice("回退快照失败");
            }
          })();
        });
    }

    const mk = this._statsSelectedMonth;
    const [statsSnap, alertsSnap, analysisIdx, baseAlertIdx] = await Promise.all([
      readHealthStatsSnapshot(this.plugin, mk),
      readHealthAlertsSnapshot(this.plugin, mk),
      readHealthAnalysisIndex(this.plugin),
      readHealthAnalysisAlertIndex(this.plugin),
    ]);
    if (seq !== this._renderSeq) return;

    const entryMap = new Map<string, HealthRecordIndexItem>();
    try {
      const [a, b] = await Promise.all([
        this.plugin.recordRSLatte?.getHealthSnapshot?.(false),
        this.plugin.recordRSLatte?.getHealthSnapshot?.(true),
      ]);
      for (const it of [...(a?.items ?? []), ...(b?.items ?? [])]) {
        const eid = String((it as HealthRecordIndexItem)?.entryId ?? "").trim();
        if (eid) entryMap.set(eid, it as HealthRecordIndexItem);
      }
    } catch {
      // ignore
    }
    if (seq !== this._renderSeq) return;

    const sumBlock = parent.createDiv({ cls: "rslatte-finance-stats-block" });
    sumBlock.createEl("h4", { text: `统计汇总（${mk}）` });
    if (statsSnap) {
      sumBlock.createDiv({
        cls: "rslatte-finance-stats-meta",
        text: `读取源：月快照 ${statsSnap.periodKey} · 生成时间 ${statsSnap.generatedAt || "—"}`,
      });
    } else if (analysisIdx?.latest) {
      sumBlock.createDiv({
        cls: "rslatte-muted",
        text: `未命中 ${mk} 的月快照。请先执行健康「刷新」或「重建索引」。索引 latest：${analysisIdx.latest.periodKey}。`,
      });
    } else {
      sumBlock.createDiv({
        cls: "rslatte-muted",
        text: "尚未生成健康分析索引。请先执行健康「刷新」或「重建索引」。",
      });
    }

    const sumGrid = sumBlock.createDiv({ cls: "rslatte-finance-stats-kv" });
    const addKv = (k: string, v: string) => {
      const row = sumGrid.createDiv({ cls: "rslatte-finance-stats-kv-row" });
      row.createSpan({ cls: "rslatte-finance-stats-k", text: k });
      row.createSpan({ cls: "rslatte-finance-stats-v", text: v });
    };
    if (statsSnap) {
      const bp = statsSnap.summary?.byPeriod ?? { day: 0, week: 0, month: 0 };
      addKv("有效条数（月内）", String(statsSnap.summary?.validCount ?? 0));
      addKv("周期分布（日/周/月）", `${bp.day} / ${bp.week} / ${bp.month}`);
      addKv("睡眠<7h 天数（月内）", String(statsSnap.derived?.sleepUnder7Days ?? 0));
      addKv("睡眠<5h 天数（月内）", String(statsSnap.derived?.sleepUnder5Days ?? 0));
      const aw = statsSnap.derived?.avgWeight;
      addKv(
        "体重样本 / 均值",
        `${statsSnap.derived?.weightSamples ?? 0}${aw != null ? ` · ${aw}` : ""}`,
      );
      const as = statsSnap.alertSummary;
      addKv("规则告警（快照计数）", `共 ${as?.total ?? 0}（高 ${as?.high ?? 0} / 警 ${as?.warning ?? 0} / 提示 ${as?.notice ?? 0}）`);
    } else {
      addKv("有效条数", "—");
    }

    const derBlock = parent.createDiv({ cls: "rslatte-finance-stats-block" });
    derBlock.createEl("h4", { text: "衍生指标（本月）" });
    derBlock.createDiv({
      cls: "rslatte-finance-stats-meta",
      text: "日卡按自然日去重（同日多条取最新）；饮水达标对照设置「目标杯数」。",
    });
    if (statsSnap?.derived) {
      const d = statsSnap.derived;
      const goalCups = Math.max(1, Math.min(30, Number((this.plugin.settings as any)?.healthPanel?.waterGoalCups ?? 8) || 8));
      const ul = derBlock.createEl("ul", { cls: "rslatte-finance-stats-cat-list" });
      const pct = (x: number | undefined) => (x != null ? `${Math.round(x * 100)}%` : "—");
      const line = (t: string) => ul.createEl("li", { text: t });
      if (d.sleepRecordedDays != null && d.sleepRecordedDays > 0) {
        line(
          `睡眠：有记录 ${d.sleepRecordedDays} 天 · 日均 ${d.sleepAvgHours ?? "—"} h · <7h 共 ${d.sleepUnder7Days} 天 · <5h 共 ${d.sleepUnder5Days} 天 · 连续 <7h 最长 ${d.maxConsecutiveSleepUnder7 ?? 0} 天`,
        );
      }
      if (d.waterRecordedDays != null && d.waterRecordedDays > 0) {
        line(
          `饮水：有记录 ${d.waterRecordedDays} 天 · 日均 ${d.waterAvgCups ?? "—"} 杯 · 达标（≥${goalCups} 杯）${d.waterGoalMetDays ?? 0} 天 · 在有记录日中占比 ${pct(d.waterGoalMetRateAmongRecorded)}`,
        );
      }
      if (d.weightSamples != null && d.weightSamples > 0) {
        const mm = d.weightMin != null && d.weightMax != null ? ` · 低/高 ${d.weightMin}/${d.weightMax} kg` : "";
        const dl =
          d.weightDeltaFirstLastKg != null ? ` · 首尾日差 ${d.weightDeltaFirstLastKg > 0 ? "+" : ""}${d.weightDeltaFirstLastKg} kg` : "";
        const adj =
          d.weightMaxAdjacentDeltaKg != null && d.weightMaxAdjacentDeltaKg >= 0.1
            ? ` · 相邻日最大波动 ${d.weightMaxAdjacentDeltaKg} kg`
            : "";
        line(`体重：有记录 ${d.weightSamples} 天 · 均值 ${d.avgWeight ?? "—"} kg${mm}${dl}${adj}`);
      }
      if (d.dietRecordedDays != null && d.dietRecordedDays > 0) {
        line(
          `饮食：有记录 ${d.dietRecordedDays} 天 · 高热量档（🔥🔥🔥）${d.dietHighHeatDays ?? 0} 天 · 在有记录日中占比 ${pct(d.dietHighHeatRateAmongRecorded)}`,
        );
      }
      if ((d.waistWeekRecordsInMonth ?? 0) > 0 || d.waistLatestCm != null) {
        line(`周卡·腰围：月内周记录 ${d.waistWeekRecordsInMonth ?? 0} 条 · 最近 ${d.waistLatestCm ?? "—"} cm`);
      }
      if ((d.bpWeekRecordsInMonth ?? 0) > 0 || d.bpLatestSystolic != null) {
        line(
          `周卡·血压：月内周记录 ${d.bpWeekRecordsInMonth ?? 0} 条 · 最近 ${d.bpLatestSystolic ?? "—"}/${d.bpLatestDiastolic ?? "—"} mmHg`,
        );
      }
      if ((d.rhrWeekRecordsInMonth ?? 0) > 0 || d.rhrLatestBpm != null) {
        line(
          `周卡·心率：月内周记录 ${d.rhrWeekRecordsInMonth ?? 0} 条 · 最近 ${d.rhrLatestBpm ?? "—"} 次/分 · 月内均值 ${d.rhrAvgBpm ?? "—"}`,
        );
      }
      if (ul.childElementCount === 0) {
        ul.remove();
        derBlock.createDiv({ cls: "rslatte-muted", text: "本月尚无足够日/周卡数据可汇总衍生指标。" });
      }
    } else if (!statsSnap) {
      derBlock.createDiv({ cls: "rslatte-muted", text: "无月快照时不展示衍生指标。" });
    }

    const rollBlock = parent.createDiv({ cls: "rslatte-finance-stats-block" });
    rollBlock.createEl("h4", { text: "滚动窗口（近7日 / 近30日）" });
    rollBlock.createDiv({
      cls: "rslatte-finance-stats-meta",
      text: "截止日为快照 anchor（历史月用该月最后一天，当月用今天）；数据来自全索引日卡去重。",
    });
    if (statsSnap?.rolling) {
      const r = statsSnap.rolling;
      const gCups = Math.max(1, Math.min(30, Number((this.plugin.settings as any)?.healthPanel?.waterGoalCups ?? 8) || 8));
      const pct = (x: number | undefined) => (x != null ? `${Math.round(x * 100)}%` : "—");
      const fmt = (name: string, b: Record<string, unknown>) => {
        const bits: string[] = [];
        if (b.sleepDaysRecorded) bits.push(`睡眠 ${b.sleepDaysRecorded} 天 · 均 ${b.sleepAvgHours ?? "—"} h`);
        if (b.waterDaysRecorded) {
          bits.push(
            `饮水 ${b.waterDaysRecorded} 天 · 均 ${b.waterAvgCups ?? "—"} 杯 · 达标（≥${gCups}）占比 ${pct(b.waterGoalMetRateAmongRecorded as number | undefined)}`,
          );
        }
        if (b.weightDaysRecorded) {
          let w = `体重 ${b.weightDaysRecorded} 天 · 均 ${b.weightAvgKg ?? "—"} kg`;
          if (b.weightDelta7VsPrev7Kg != null) {
            const dv = b.weightDelta7VsPrev7Kg as number;
            w += ` · 较前7日均 ${dv > 0 ? "+" : ""}${dv} kg`;
          }
          bits.push(w);
        }
        if (b.dietDaysRecorded) {
          bits.push(`饮食有热量档 ${b.dietDaysRecorded} 天 · 高热量 ${b.dietHighHeatDays ?? 0} 天`);
        }
        const dfc = b.dayFullCompletionRate as number | undefined;
        if (dfc != null) {
          bits.push(`日卡「启用项全齐」占比 ${pct(dfc)}`);
        }
        return bits.length ? `${name}（${bits.join("；")}）` : null;
      };
      rollBlock.createDiv({ cls: "rslatte-finance-stats-meta", text: `截止 ${r.anchorYmd}` });
      const ul = rollBlock.createEl("ul", { cls: "rslatte-finance-stats-cat-list" });
      const l7 = fmt("近7日", r.last7Days as unknown as Record<string, unknown>);
      const l30 = fmt("近30日", r.last30Days as unknown as Record<string, unknown>);
      if (l7) ul.createEl("li", { text: l7 });
      if (l30) ul.createEl("li", { text: l30 });
      if (ul.childElementCount === 0) {
        ul.remove();
        rollBlock.createDiv({ cls: "rslatte-muted", text: "滚动窗口内暂无日卡数据。" });
      }
    } else if (statsSnap) {
      rollBlock.createDiv({ cls: "rslatte-muted", text: "当前快照无 rolling 字段，请刷新健康索引后重试。" });
    }

    const canonBlock = parent.createDiv({ cls: "rslatte-finance-stats-block" });
    canonBlock.createEl("h4", { text: "合并项末次值（月内最后一条）" });
    if (statsSnap?.latestByCanonical && Object.keys(statsSnap.latestByCanonical).length) {
      const ul = canonBlock.createEl("ul", { cls: "rslatte-finance-stats-cat-list" });
      for (const c of HEALTH_CANONICAL_METRICS_ORDER) {
        const row = statsSnap.latestByCanonical[c];
        if (!row) continue;
        const label = healthCanonicalShortLabelZh(c);
        const p = row.period === "week" ? "周" : row.period === "month" ? "月" : "日";
        ul.createEl("li", {
          text: `${label}（${p}）：${row.valueStr || "—"} · ${row.recordDate || "—"}`,
        });
      }
    } else {
      canonBlock.createDiv({ cls: "rslatte-muted", text: "无快照或无合并项数据。" });
    }

    const alertBlock = parent.createDiv({ cls: "rslatte-finance-stats-block" });
    alertBlock.createEl("h4", { text: "分析基础告警（健康分析索引）" });
    if (!baseAlertIdx) {
      alertBlock.createDiv({
        cls: "rslatte-muted",
        text: "尚未生成 health-analysis.alert-index.json。请先执行健康「刷新」或「重建索引」。",
      });
    } else {
      alertBlock.createDiv({
        cls: "rslatte-finance-stats-meta",
        text: `状态：${baseAlertIdx.status} · 生成 ${baseAlertIdx.generatedAt || "—"} · 缺失项 ${baseAlertIdx.summary?.missingCount ?? 0}`,
      });
      if (!baseAlertIdx.missingData?.length) {
        alertBlock.createDiv({ cls: "rslatte-muted", text: "当前无「基础数据缺失」类告警。" });
      } else {
        const ul = alertBlock.createEl("ul", { cls: "rslatte-finance-stats-alert-list" });
        for (const it of baseAlertIdx.missingData) {
          const li = ul.createEl("li");
          li.createDiv({ cls: "rslatte-finance-stats-alert-title", text: it.title });
          li.createDiv({ cls: "rslatte-finance-stats-alert-detail", text: it.detail });
          if (it.hint) li.createDiv({ cls: "rslatte-finance-stats-alert-hint", text: `提示：${it.hint}` });
        }
      }
    }

    const ruleBlock = parent.createDiv({ cls: "rslatte-finance-stats-block" });
    ruleBlock.createEl("h4", { text: `规则告警（${mk}）` });
    if (!alertsSnap) {
      ruleBlock.createDiv({
        cls: "rslatte-muted",
        text: `未读取到 ${mk}.alerts.json。刷新/重建索引后会写入当月规则告警快照。`,
      });
    } else {
      ruleBlock.createDiv({
        cls: "rslatte-finance-stats-meta",
        text: `生成 ${alertsSnap.generatedAt || "—"} · 未解决 ${alertsSnap.summary?.total ?? 0}（高 ${alertsSnap.summary?.high ?? 0} / 警 ${alertsSnap.summary?.warning ?? 0} / 提示 ${alertsSnap.summary?.notice ?? 0}）`,
      });
      const items = (alertsSnap.items ?? []).filter((x) => String(x?.status ?? "") !== "resolved");
      if (!items.length) {
        ruleBlock.createDiv({ cls: "rslatte-muted", text: "当前月份无未解决的规则告警。" });
      } else {
        const ul = ruleBlock.createEl("ul", { cls: "rslatte-finance-stats-alert-list" });
        for (const a of items) {
          const li = ul.createEl("li");
          const sev = String(a.severity ?? "notice");
          const st = String(a.status ?? "new");
          li.createDiv({
            cls: "rslatte-finance-stats-alert-title",
            text: `[${sev}] ${a.title}（${st}）`,
          });
          li.createDiv({ cls: "rslatte-finance-stats-alert-detail", text: a.message });
          const ids = Array.isArray(a.relatedEntryIds)
            ? a.relatedEntryIds.map((x) => String(x ?? "").trim()).filter(Boolean)
            : [];
          if (ids.length) {
            const actions = li.createDiv({ cls: "rslatte-finance-stats-meta" });
            for (const eid of ids) {
              const openBtn = actions.createEl("button", {
                type: "button",
                cls: "rslatte-finance-alert-action-btn",
                text: `打开 ${eid.slice(0, 8)}…`,
              });
              openBtn.onclick = async (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const rec = entryMap.get(eid);
                if (!rec) {
                  new Notice("索引中未找到该 entry，可先重建健康索引");
                  return;
                }
                try {
                  await this.openHealthRecordInDiary(rec);
                } catch (err) {
                  console.error("[RSLatte] open health alert entry failed", err);
                  new Notice("打开日记失败");
                }
              };
            }
          }
        }
      }
    }
  }

  /** 扫描重建：全量扫描 +（可选）DB 同步 +（Engine 层门控）reconcile */
  private async manualRebuild(): Promise<void> {
    const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "health", "rebuild");
    if (!r.ok) {
      new Notice(`健康重建失败：${r.error.message}`);
      return;
    }
    if (r.data.skipped) return;
    new Notice("健康索引已重建");
    try {
      await this.plugin.hydrateTodayFromRecordIndex();
    } catch {
      // ignore
    }
    void this.render();
  }

  /** 手动刷新：增量刷新 +（可选）DB 同步 +（Engine 层门控）reconcile */
  private async manualRefresh(): Promise<void> {
    const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "health", "manual_refresh");
    if (!r.ok) {
      new Notice(`健康刷新失败：${r.error.message}`);
      return;
    }
    if (r.data.skipped) return;
    new Notice("健康已刷新");
    try {
      await this.plugin.hydrateTodayFromRecordIndex();
    } catch {
      // ignore
    }
    void this.render();
  }

  /** 手动索引归档：超阈值健康记录迁入 archive */
  private async manualArchive(): Promise<void> {
    const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "health", "manual_archive");
    if (!r.ok) {
      new Notice(`健康索引归档失败：${r.error.message}`);
      return;
    }
    if (r.data.skipped) return;
    new Notice("健康索引归档已完成");
    void this.render();
  }
}
