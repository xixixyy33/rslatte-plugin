import { App, ButtonComponent, Modal, Notice, TextComponent } from "obsidian";
import type RSLattePlugin from "../../main";
import { buildReviewExecuteModel } from "../helpers/reviewExecuteModel";
import { buildReviewReconcileModel } from "../helpers/reviewReconcileModel";
import { buildReviewRecordsModel } from "../helpers/reviewRecordsModel";
import {
  assessReviewIndexCoverageForPeriod,
  parseReviewPeriodKeyToRange,
  workEventMonthKeysForYmdRange,
} from "../helpers/reviewPeriodCoverage";
import {
  appendReviewSnapshotVersion,
  readManualReviewSnapshotVersions,
  REVIEW_SNAPSHOT_MAX_VERSIONS,
  type ReviewSnapshotGrain,
  type ReviewSnapshotIndexMeta,
} from "../helpers/reviewPeriodSnapshotStore";

export type ReviewHistorySnapshotModalOpts = {
  grain: ReviewSnapshotGrain;
  periodKey: string;
  startYmd: string;
  endYmd: string;
  onSaved: () => void;
};

/**
 * Review 历史周期：确认时间范围、检查主索引归档窗口与 WorkEvent 分片说明后，写入多版本快照（默认最多 3 版）。
 */
export class ReviewHistorySnapshotModal extends Modal {
  private grain: ReviewSnapshotGrain;
  private periodKey: string;
  private startYmd: string;
  private endYmd: string;
  private ackPartial = false;
  private statusEl!: HTMLDivElement;
  private partialRow!: HTMLDivElement;
  private versionsBodyEl!: HTMLDivElement;

  constructor(
    app: App,
    private plugin: RSLattePlugin,
    private opts: ReviewHistorySnapshotModalOpts,
  ) {
    super(app);
    this.grain = opts.grain;
    this.periodKey = opts.periodKey;
    this.startYmd = opts.startYmd;
    this.endYmd = opts.endYmd;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("rslatte-modal", "rslatte-review-snapshot-modal");
    this.titleEl.setText("历史快照更新");

    contentEl.createDiv({
      cls: "rslatte-muted",
      text: "将当前主索引与操作日志（WorkEvent 按月份分片读取）冻结为一份可回退的快照。请先确认周期与数据可用性。",
    });

    const form = contentEl.createDiv({ cls: "rslatte-review-snapshot-form" });
    form.createDiv({ cls: "rslatte-setting-h4", text: "周期" });

    const rowKey = form.createDiv({ cls: "rslatte-review-snapshot-row rslatte-review-snapshot-period-row" });
    rowKey.createSpan({ text: "周期键", cls: "rslatte-review-snapshot-label" });
    const inputWrap = rowKey.createDiv({ cls: "rslatte-review-snapshot-input-wrap" });
    const keyInput = new TextComponent(inputWrap).setValue(this.periodKey);
    keyInput.inputEl.addClass("rslatte-review-snapshot-input");

    new ButtonComponent(rowKey).setButtonText("应用").onClick(() => {
      const parsed = parseReviewPeriodKeyToRange(this.grain, keyInput.getValue());
      if (!parsed.ok) {
        new Notice(parsed.error);
        return;
      }
      this.periodKey = parsed.periodKey;
      this.startYmd = parsed.startYmd;
      this.endYmd = parsed.endYmd;
      keyInput.setValue(this.periodKey);
      rangeEl.setText(`${this.startYmd} ～ ${this.endYmd}`);
      this.refreshAssessment();
    });

    const rangeEl = form.createDiv({
      cls: "rslatte-review-snapshot-range",
      text: `${this.startYmd} ～ ${this.endYmd}`,
    });

    const versionsBlock = form.createDiv({ cls: "rslatte-review-snapshot-versions-block" });
    versionsBlock.createDiv({ cls: "rslatte-setting-h4", text: "可回退的手动快照" });
    this.versionsBodyEl = versionsBlock.createDiv({ cls: "rslatte-review-snapshot-versions-body" });

    this.statusEl = form.createDiv({ cls: "rslatte-review-snapshot-status" });

    this.partialRow = form.createDiv({ cls: "rslatte-review-snapshot-partial" });
    this.partialRow.style.display = "none";
    const cb = this.partialRow.createEl("input", { type: "checkbox" });
    this.partialRow.createSpan({ text: "我已了解：快照可能无法包含已迁出主索引的条目。" });
    cb.addEventListener("change", () => {
      this.ackPartial = cb.checked;
    });

    const footer = contentEl.createDiv({ cls: "rslatte-review-snapshot-footer" });
    new ButtonComponent(footer).setButtonText("重新检查索引与分片").onClick(() => this.refreshAssessment());
    const runBtn = new ButtonComponent(footer).setButtonText("生成快照").setCta();
    runBtn.onClick(() => void this.onGenerate(runBtn));
    new ButtonComponent(footer).setButtonText("取消").onClick(() => this.close());

    this.refreshAssessment();
  }

  private formatSavedAt(iso: string): string {
    const m = (window as any).moment?.(iso);
    if (m && typeof m.isValid === "function" && m.isValid()) {
      return m.format("YYYY-MM-DD HH:mm");
    }
    return iso;
  }

  private async refreshVersionsList(): Promise<void> {
    const spaceId = this.plugin.getCurrentSpaceId();
    const versions = await readManualReviewSnapshotVersions(this.plugin, spaceId, this.grain, this.periodKey);
    this.versionsBodyEl.empty();
    if (versions.length === 0) {
      this.versionsBodyEl.createDiv({
        cls: "rslatte-muted rslatte-review-snapshot-versions-empty",
        text: "暂无手动快照；生成后将显示在此，并可在侧栏用「↩」逐版回退。",
      });
      return;
    }
    this.versionsBodyEl.createDiv({
      cls: "rslatte-muted rslatte-review-snapshot-versions-hint",
      text: `共 ${versions.length} 版（最多 ${REVIEW_SNAPSHOT_MAX_VERSIONS}）；自上而下从新到旧，回退每次删除最上面一版。`,
    });
    versions.forEach((v, i) => {
      const row = this.versionsBodyEl.createDiv({ cls: "rslatte-review-snapshot-version-line" });
      const label = i === 0 ? "第 1 版（最新）" : `第 ${i + 1} 版`;
      row.createSpan({ cls: "rslatte-review-snapshot-version-label", text: `${label} · ` });
      row.createSpan({ text: `保存于 ${this.formatSavedAt(v.savedAt)}` });
    });
  }

  private refreshAssessment(): void {
    const today =
      (this.plugin as any).getTodayKey?.() ?? (window as any).moment?.().format("YYYY-MM-DD") ?? "";
    const ass = assessReviewIndexCoverageForPeriod(this.startYmd, this.endYmd, today, this.plugin.settings, {
      grain: this.grain,
    });
    const months = workEventMonthKeysForYmdRange(this.startYmd, this.endYmd);
    const weHint =
      this.plugin.workEventSvc?.isEnabled?.() === true
        ? `操作日志将读取月份分片：${months.join("、")}（跨月周期会合并多文件）。`
        : "操作日志未开启：快照中依赖 WorkEvent 的统计将为空或回退索引口径。";

    this.statusEl.empty();
    const riskCls =
      ass.risk === "full_outside"
        ? "rslatte-review-snapshot-risk--bad"
        : ass.risk === "partial"
          ? "rslatte-review-snapshot-risk--warn"
          : "rslatte-review-snapshot-risk--ok";
    this.statusEl.createDiv({ cls: `rslatte-review-snapshot-risk ${riskCls}`, text: ass.summary });
    this.statusEl.createDiv({ cls: "rslatte-muted", text: weHint });

    if (ass.risk === "partial") {
      this.partialRow.style.display = "block";
    } else {
      this.partialRow.style.display = "none";
      this.ackPartial = false;
      const cb = this.partialRow.querySelector("input[type=checkbox]") as HTMLInputElement | null;
      if (cb) cb.checked = false;
    }

    (this as any)._lastAssessment = ass;
    (this as any)._lastMonthKeys = months;
    void this.refreshVersionsList();
  }

  private async onGenerate(runBtn: ButtonComponent): Promise<void> {
    const ass = (this as any)._lastAssessment as ReturnType<typeof assessReviewIndexCoverageForPeriod> | undefined;
    const months = ((this as any)._lastMonthKeys as string[]) ?? workEventMonthKeysForYmdRange(this.startYmd, this.endYmd);
    if (!ass) {
      new Notice("请先执行检查");
      return;
    }
    if (!ass.allowSnapshot) {
      new Notice("当前周期超出主索引可靠范围，已阻止生成。");
      return;
    }
    if (ass.risk === "partial" && !this.ackPartial) {
      new Notice("请勾选确认：已了解部分日期可能缺主索引数据。");
      return;
    }

    runBtn.setDisabled(true);
    try {
      const execute = await buildReviewExecuteModel(this.plugin, this.startYmd, this.endYmd, this.grain);
      const reconcile = await buildReviewReconcileModel(this.plugin, this.startYmd, this.endYmd, this.grain);
      const records = await buildReviewRecordsModel(this.plugin, this.startYmd, this.endYmd, this.grain);

      const indexMeta: ReviewSnapshotIndexMeta = {
        risk: ass.risk,
        retentionStartYmd: ass.retentionStartYmd,
        workEventMonthKeys: months,
      };

      const spaceId = this.plugin.getCurrentSpaceId();
      await appendReviewSnapshotVersion(this.plugin, spaceId, this.grain, this.periodKey, {
        savedAt: new Date().toISOString(),
        startYmd: this.startYmd,
        endYmd: this.endYmd,
        indexMeta,
        payload: { execute, reconcile, records },
      });

      new Notice("历史快照已保存（最多保留 3 个版本，可在侧栏回退）。");
      this.opts.onSaved();
      this.close();
    } catch (e) {
      console.warn("[RSLatte] ReviewHistorySnapshotModal generate failed:", e);
      new Notice(`生成快照失败：${(e as any)?.message ?? String(e)}`);
    } finally {
      runBtn.setDisabled(false);
    }
  }
}
