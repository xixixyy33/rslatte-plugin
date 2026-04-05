import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import type RSLattePlugin from "../../main";
import { VIEW_TYPE_REVIEW } from "../../constants/viewTypes";
import { buildReviewRecordsModel } from "../helpers/reviewRecordsModel";
import { renderReviewRecordsBody } from "../helpers/reviewRecordsRender";
import { buildReviewExecuteModel } from "../helpers/reviewExecuteModel";
import { renderReviewExecuteBody } from "../helpers/reviewExecuteRender";
import { buildReviewReconcileModel } from "../helpers/reviewReconcileModel";
import { renderReviewReconcileBody } from "../helpers/reviewReconcileRender";
import { ReviewHistorySnapshotModal } from "../modals/ReviewHistorySnapshotModal";
import {
  readReviewSnapshotHead,
  rollbackLatestReviewSnapshot,
  REVIEW_SNAPSHOT_MAX_VERSIONS,
  type ReviewSnapshotHead,
} from "../helpers/reviewPeriodSnapshotStore";

const moment = (window as any).moment;

type ReviewGrain = "week" | "month" | "quarter";
type ReviewSubTab = "execute" | "reconcile" | "records";

/** 供 `activateReviewView` / Hub 链式打开；与方案 `Review侧边栏优化方案.md` §4.3 query 对齐 */
export type ReviewDeepLinkOpts = {
  grain?: ReviewGrain;
  /** 周：`YYYY-Www`（如 2026-W13）；月：`YYYY-MM`；季：`YYYY-Q1`～`Q4` */
  periodKey?: string;
  /** 相对「当前日历周/月/季」的偏移，与顶栏「上一/下一周期」一致 */
  periodOffset?: number;
  subTab?: ReviewSubTab;
};

let _pendingReviewOpen: Partial<ReviewDeepLinkOpts> | null = null;

/** 在打开或刷新 `ReviewView` 前调用；下一帧 `render` 会消费并清空 */
export function markPendingReviewOpen(opts: ReviewDeepLinkOpts): void {
  _pendingReviewOpen = { ...(_pendingReviewOpen ?? {}), ...opts };
}

function drainPendingReviewOpen(): Partial<ReviewDeepLinkOpts> | null {
  const p = _pendingReviewOpen;
  _pendingReviewOpen = null;
  return p;
}

/** 将 `periodKey` 转为相对当前周/月/季的 `_periodOffset`（失败返回 null） */
export function computeReviewPeriodOffset(grain: ReviewGrain, periodKey: string): number | null {
  const mmt = moment as undefined | ((inp?: any, fmt?: any, strict?: any) => any);
  if (!mmt) return null;
  const key = String(periodKey ?? "").trim();
  if (grain === "week") {
    const m = key.match(/^(\d{4})-W(\d{2})$/i);
    if (!m) return null;
    const y = Number(m[1]);
    const w = Number(m[2]);
    if (!Number.isFinite(y) || !Number.isFinite(w) || w < 1 || w > 53) return null;
    const cur = mmt().startOf("isoWeek");
    const tgt = mmt().isoWeekYear(y).isoWeek(w).startOf("isoWeek");
    if (!tgt.isValid()) return null;
    return tgt.diff(cur, "weeks");
  }
  if (grain === "quarter") {
    const mq = key.match(/^(\d{4})-Q([1-4])$/i);
    if (!mq) return null;
    const y = Number(mq[1]);
    const q = Number(mq[2]);
    if (!Number.isFinite(y) || !Number.isFinite(q)) return null;
    const cur = mmt().startOf("quarter");
    const tgt = mmt({ year: y, month: (q - 1) * 3, day: 1 }).startOf("quarter");
    if (!tgt.isValid()) return null;
    return tgt.diff(cur, "quarters");
  }
  const m2 = key.match(/^(\d{4})-(\d{2})$/);
  if (!m2) return null;
  const y = Number(m2[1]);
  const mo = Number(m2[2]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) return null;
  const cur = mmt().startOf("month");
  const tgt = mmt({ year: y, month: mo - 1, day: 1 }).startOf("month");
  if (!tgt.isValid()) return null;
  return tgt.diff(cur, "months");
}

type ReviewPeriodInfo = {
  title: string;
  periodKey: string;
  statusLabel: string;
  startYmd: string;
  endYmd: string;
};

/**
 * V2 回顾侧栏：周期控制 + 三子页签（内容域见 `Review侧边栏优化方案.md` §4.3a）。
 * 深度打开：`plugin.activateReviewView(opts)` / `markPendingReviewOpen`（§4.3）。
 */
export class ReviewView extends ItemView {
  private plugin: RSLattePlugin;
  private _renderSeq = 0;
  private _grain: ReviewGrain = "week";
  /** 相对「当前」周/月/季的偏移：0 为本周期，-1 上一周期，+1 下一周期 */
  private _periodOffset = 0;
  private _subTab: ReviewSubTab = "execute";
  /** 已结束周期：按空间+粒度+periodKey 缓存快照头信息，避免切换子页签反复读盘 */
  private _snapHeadCache: { key: string; head: ReviewSnapshotHead } | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: RSLattePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_REVIEW;
  }
  getDisplayText(): string {
    return "回顾";
  }
  getIcon(): string {
    return "clipboard-list";
  }

  async onOpen() {
    await this.render();
  }

  async onClose() {}

  private getTodayKey(): string {
    return (this.plugin as any).getTodayKey?.() ?? (moment ? moment().format("YYYY-MM-DD") : "");
  }

  /** 当前选中周期的展示标题、边界与状态（与方案 §4.3 一致） */
  private computePeriod(): ReviewPeriodInfo {
    if (!moment) {
      return { title: "—", periodKey: "", statusLabel: "—", startYmd: "", endYmd: "" };
    }
    const today = this.getTodayKey();
    let start = moment();
    if (this._grain === "week") {
      start = moment().add(this._periodOffset, "weeks").startOf("isoWeek");
    } else if (this._grain === "month") {
      start = moment().add(this._periodOffset, "months").startOf("month");
    } else {
      start = moment().add(this._periodOffset, "quarters").startOf("quarter");
    }
    let end = start.clone();
    if (this._grain === "week") end = start.clone().endOf("isoWeek");
    else if (this._grain === "month") end = start.clone().endOf("month");
    else end = start.clone().endOf("quarter");
    const startYmd = start.format("YYYY-MM-DD");
    const endYmd = end.format("YYYY-MM-DD");
    let periodKey: string;
    if (this._grain === "week") {
      const w = start.isoWeek();
      const y = start.isoWeekYear();
      periodKey = `${y}-W${String(w).padStart(2, "0")}`;
    } else if (this._grain === "month") {
      periodKey = start.format("YYYY-MM");
    } else {
      const q = Math.floor(start.month() / 3) + 1;
      periodKey = `${start.year()}-Q${q}`;
    }
    const tM = moment(today, "YYYY-MM-DD", true);
    const inRange =
      tM.isValid() &&
      tM.isSameOrAfter(startYmd, "day") &&
      tM.isSameOrBefore(endYmd, "day");
    const statusLabel = inRange ? "进行中" : "已结束";
    return { title: periodKey, periodKey, statusLabel, startYmd, endYmd };
  }

  private async render(): Promise<void> {
    const seq = ++this._renderSeq;
    const pending = drainPendingReviewOpen();
    if (pending) {
      if (pending.grain === "week" || pending.grain === "month" || pending.grain === "quarter") {
        this._grain = pending.grain;
      }
      if (pending.periodOffset !== undefined && Number.isFinite(pending.periodOffset)) {
        this._periodOffset = Math.trunc(pending.periodOffset);
      } else if (pending.periodKey && String(pending.periodKey).trim()) {
        const off = computeReviewPeriodOffset(this._grain, String(pending.periodKey).trim());
        if (off !== null) this._periodOffset = off;
      }
      if (pending.subTab === "execute" || pending.subTab === "reconcile" || pending.subTab === "records") {
        this._subTab = pending.subTab;
      }
    }

    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("rslatte-review-view");

    const period = this.computePeriod();
    const inProgress = period.statusLabel === "进行中";
    const spaceId = this.plugin.getCurrentSpaceId();
    const snapCacheKey = `${spaceId}|${this._grain}|${period.periodKey}`;

    let snapHead: ReviewSnapshotHead = { latest: null, totalVersions: 0 };
    if (inProgress) {
      this._snapHeadCache = null;
    } else {
      if (!this._snapHeadCache || this._snapHeadCache.key !== snapCacheKey) {
        snapHead = await readReviewSnapshotHead(this.plugin, spaceId, this._grain, period.periodKey);
        if (seq !== this._renderSeq) return;
        this._snapHeadCache = { key: snapCacheKey, head: snapHead };
      } else {
        snapHead = this._snapHeadCache.head;
      }
    }

    const head = container.createDiv({ cls: "rslatte-review-head" });

    const cycleBar = head.createDiv({ cls: "rslatte-review-cycle-bar" });
    const toolbar = cycleBar.createDiv({ cls: "rslatte-review-cycle-toolbar" });
    const toolbarLeft = toolbar.createDiv({ cls: "rslatte-review-cycle-toolbar-left" });
    const mkGrainBtn = (g: ReviewGrain, label: string) => {
      const b = toolbarLeft.createEl("button", { text: label, cls: "rslatte-review-cycle-btn" });
      if (this._grain === g) b.addClass("is-active");
      b.onclick = () => {
        if (this._grain === g) return;
        this._grain = g;
        this._periodOffset = 0;
        void this.render();
      };
    };
    mkGrainBtn("week", "周");
    mkGrainBtn("month", "月");
    mkGrainBtn("quarter", "季");
    const prevBtn = toolbarLeft.createEl("button", { text: "← 上一周期", cls: "rslatte-review-cycle-nav-btn" });
    prevBtn.onclick = () => {
      this._periodOffset -= 1;
      void this.render();
    };
    const nextBtn = toolbarLeft.createEl("button", { text: "下一周期 →", cls: "rslatte-review-cycle-nav-btn" });
    nextBtn.onclick = () => {
      this._periodOffset += 1;
      void this.render();
    };
    const toolbarRight = toolbar.createDiv({ cls: "rslatte-review-cycle-toolbar-right" });
    const iconBtnCls = "rslatte-review-cycle-icon-btn";

    if (inProgress) {
      const refreshCycle = toolbarRight.createEl("button", { text: "🔄", cls: `rslatte-review-cycle-refresh ${iconBtnCls}` });
      refreshCycle.setAttribute("aria-label", "刷新当前周期");
      refreshCycle.title = "刷新当前周期";
      refreshCycle.onclick = () => void this.render();
    } else {
      const histSnapBtn = toolbarRight.createEl("button", {
        text: "🔄",
        cls: `rslatte-review-cycle-snapshot-btn ${iconBtnCls}`,
      });
      histSnapBtn.setAttribute("aria-label", "刷新历史快照");
      histSnapBtn.title = "刷新历史快照";
      histSnapBtn.onclick = () => {
        new ReviewHistorySnapshotModal(this.app, this.plugin, {
          grain: this._grain,
          periodKey: period.periodKey,
          startYmd: period.startYmd,
          endYmd: period.endYmd,
          onSaved: () => {
            this._snapHeadCache = null;
            void this.render();
          },
        }).open();
      };

      if (snapHead.manualVersionCount > 0) {
        const rb = toolbarRight.createEl("button", { text: "↩", cls: `rslatte-review-cycle-rollback-btn ${iconBtnCls}` });
        rb.setAttribute("aria-label", "回退快照版本");
        rb.title = "回退快照版本";
        rb.onclick = async () => {
          const ok = window.confirm(
            `确定回退快照？将删除「${period.periodKey}」手动快照中最新一版${
              snapHead.manualVersionCount > 1 ? "，并显示上一版或实时索引" : "，本周期将改显示实时索引或 E2 封印"
            }。`,
          );
          if (!ok) return;
          const left = await rollbackLatestReviewSnapshot(this.plugin, spaceId, this._grain, period.periodKey);
          this._snapHeadCache = null;
          new Notice(left > 0 ? `已回退手动快照，当前剩余 ${left} 版。` : "已清空手动快照；若存在 E2 自动封印仍可能显示。");
          void this.render();
        };
      }
    }

    const titleRow = cycleBar.createDiv({ cls: "rslatte-review-cycle-title-row" });
    const titleLeft = titleRow.createDiv({ cls: "rslatte-review-cycle-title-left" });
    titleLeft.createEl("span", { cls: "rslatte-review-cycle-title", text: period.title || "—" });
    titleLeft.createSpan({
      cls: "rslatte-review-cycle-range rslatte-muted",
      text: ` ${period.startYmd} ~ ${period.endYmd}`,
    });
    titleRow.createSpan({
      cls: `rslatte-review-cycle-status-tag${inProgress ? " is-in-progress" : " is-ended"}`,
      text: period.statusLabel || "—",
    });

    const tabs = head.createDiv({ cls: "rslatte-task-subtabs rslatte-review-subtabs" });
    const execLabel =
      this._grain === "week" ? "本周执行" : this._grain === "month" ? "本月执行" : "本季执行";
    const recLabel =
      this._grain === "week" ? "本周核对" : this._grain === "month" ? "本月核对" : "本季核对";
    const logLabel =
      this._grain === "week" ? "本周记录" : this._grain === "month" ? "本月记录" : "本季记录";
    const addTab = (id: ReviewSubTab, label: string) => {
      const btn = tabs.createEl("button", { text: label, cls: "rslatte-task-subtab" });
      if (this._subTab === id) btn.addClass("is-active");
      btn.onclick = () => {
        if (this._subTab === id) return;
        this._subTab = id;
        void this.render();
      };
    };
    addTab("execute", execLabel);
    addTab("reconcile", recLabel);
    addTab("records", logLabel);

    const tabBody = container.createDiv({ cls: "rslatte-review-tab-body" });
    if (!inProgress && snapHead.latest) {
      const ban = tabBody.createDiv({ cls: "rslatte-review-snapshot-banner" });
      const saved = snapHead.latest.savedAt
        ? new Date(snapHead.latest.savedAt).toLocaleString()
        : "—";
      const src = snapHead.isE2SealedDisplay
        ? `E2 自动刷新生成的「已完成」封印（文件名含 .completed.json）`
        : `手动历史快照（${snapHead.manualVersionCount}/${REVIEW_SNAPSHOT_MAX_VERSIONS} 版）`;
      ban.setText(`当前显示 ${src} · 保存于 ${saved}。进行中周期始终为实时数据。`);
    } else if (!inProgress && !snapHead.latest) {
      tabBody.createDiv({
        cls: "rslatte-review-snapshot-banner rslatte-review-snapshot-banner--live",
        text:
          this._grain === "quarter"
            ? "未生成历史快照：本季统计已合并主索引与归档分片中的任务/提醒/日程/输出；操作日志仍按日期范围读取。"
            : "未生成历史快照：以下为实时主索引与操作日志计算结果；若周期较旧，主索引可能因归档而不完整。",
      });
    }
    if (inProgress && this._grain === "quarter") {
      tabBody.createDiv({
        cls: "rslatte-review-reconcile-note rslatte-muted",
        text: "本季进行中：统计已合并归档索引分片（任务/提醒/日程/输出），与周/月视图口径不同。",
      });
    }
    const outlineHost = tabBody.createDiv({ cls: "rslatte-review-outline-host" });
    if (this._subTab === "execute") {
      outlineHost.createDiv({ cls: "rslatte-review-records-loading rslatte-muted", text: "加载中…" });
      try {
        let model;
        if (!inProgress && snapHead.latest) {
          model = snapHead.latest.payload.execute;
        } else {
          model = await buildReviewExecuteModel(this.plugin, period.startYmd, period.endYmd, this._grain);
        }
        if (seq !== this._renderSeq) return;
        outlineHost.empty();
        renderReviewExecuteBody(outlineHost, model, this.plugin);
      } catch (e) {
        console.warn("[RSLatte] Review execute tab failed:", e);
        if (seq !== this._renderSeq) return;
        outlineHost.empty();
        outlineHost.createDiv({
          cls: "rslatte-review-records-error",
          text: "执行页数据加载失败，请稍后重试。",
        });
      }
    } else if (this._subTab === "reconcile") {
      outlineHost.createDiv({ cls: "rslatte-review-records-loading rslatte-muted", text: "加载中…" });
      try {
        let model;
        if (!inProgress && snapHead.latest) {
          model = snapHead.latest.payload.reconcile;
        } else {
          model = await buildReviewReconcileModel(this.plugin, period.startYmd, period.endYmd, this._grain);
        }
        if (seq !== this._renderSeq) return;
        outlineHost.empty();
        renderReviewReconcileBody(outlineHost, model, this.plugin);
      } catch (e) {
        console.warn("[RSLatte] Review reconcile tab failed:", e);
        if (seq !== this._renderSeq) return;
        outlineHost.empty();
        outlineHost.createDiv({
          cls: "rslatte-review-records-error",
          text: "核对页数据加载失败，请稍后重试。",
        });
      }
    } else {
      outlineHost.createDiv({ cls: "rslatte-review-records-loading rslatte-muted", text: "加载中…" });
      try {
        let model;
        if (!inProgress && snapHead.latest) {
          model = snapHead.latest.payload.records;
        } else {
          model = await buildReviewRecordsModel(this.plugin, period.startYmd, period.endYmd, this._grain);
        }
        if (seq !== this._renderSeq) return;
        outlineHost.empty();
        renderReviewRecordsBody(outlineHost, model, this.plugin);
      } catch (e) {
        console.warn("[RSLatte] Review records tab failed:", e);
        if (seq !== this._renderSeq) return;
        outlineHost.empty();
        outlineHost.createDiv({
          cls: "rslatte-review-records-error",
          text: "记录页数据加载失败，请稍后重试。",
        });
      }
    }
  }

  public refresh() {
    void this.render();
  }
}
