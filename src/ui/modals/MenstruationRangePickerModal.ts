import { App, ButtonComponent, Modal } from "obsidian";
import moment from "moment";

const momentFn = moment as any;

export type MenstruationRangePickerOpts = {
  /** 已选开始 YYYY-MM-DD */
  initialStart?: string;
  /** 已选结束 YYYY-MM-DD */
  initialEnd?: string;
  /** 打开时日历默认落到的月份（YYYY-MM-DD 任一天） */
  anchorHint?: string;
  onConfirm: (startKey: string, endKey: string) => void;
};

function normDateKey(s: string): string {
  const t = String(s ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : "";
}

/**
 * 单月历内点选月经起止：第一次点为开始，第二次为结束（若早于开始则自动对调）；可翻月。
 * 仅点一天后点「确定」视为起止同一天。
 */
export class MenstruationRangePickerModal extends Modal {
  private viewY: number;
  private viewM: number;
  private pickStart: string | null;
  private pickEnd: string | null;
  private gridHost!: HTMLDivElement;
  private hintEl!: HTMLDivElement;
  private confirmBtn!: ButtonComponent;
  private navLabelEl!: HTMLSpanElement;

  constructor(
    app: App,
    private readonly opts: MenstruationRangePickerOpts,
  ) {
    super(app);
    const hint = normDateKey(opts.anchorHint ?? "") || normDateKey(opts.initialStart ?? "") || momentFn().format("YYYY-MM-DD");
    const m = momentFn(hint, "YYYY-MM-DD", true);
    this.viewY = m.isValid() ? m.year() : momentFn().year();
    this.viewM = m.isValid() ? m.month() + 1 : momentFn().month() + 1;
    const is = normDateKey(opts.initialStart ?? "");
    const ie = normDateKey(opts.initialEnd ?? "");
    this.pickStart = is || null;
    this.pickEnd = ie || null;
    if (this.pickStart && this.pickEnd && this.pickStart > this.pickEnd) {
      const t = this.pickStart;
      this.pickStart = this.pickEnd;
      this.pickEnd = t;
    }
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("rslatte-menstruation-range-picker-modal");

    this.titleEl.setText("选择月经起止日期");
    this.hintEl = contentEl.createDiv({ cls: "rslatte-mrp-hint rslatte-muted" });
    this.syncHint();

    const nav = contentEl.createDiv({ cls: "rslatte-mrp-nav" });
    new ButtonComponent(nav).setButtonText("‹").onClick(() => {
      this.shiftMonth(-1);
    });
    this.navLabelEl = nav.createSpan({ cls: "rslatte-mrp-nav-label" });
    new ButtonComponent(nav).setButtonText("›").onClick(() => {
      this.shiftMonth(1);
    });

    const head = contentEl.createDiv({ cls: "rslatte-mrp-weekhead" });
    const wds = ["一", "二", "三", "四", "五", "六", "日"];
    for (const w of wds) head.createSpan({ cls: "rslatte-mrp-weekhead-cell", text: w });

    this.gridHost = contentEl.createDiv({ cls: "rslatte-mrp-grid" });
    this.renderGrid();

    new ButtonComponent(contentEl).setButtonText("清除本次选择").onClick(() => {
      this.pickStart = null;
      this.pickEnd = null;
      this.syncHint();
      this.renderGrid();
      this.syncConfirm();
    });

    const foot = contentEl.createDiv({ cls: "rslatte-mrp-footer" });
    new ButtonComponent(foot).setButtonText("取消").onClick(() => this.close());
    this.confirmBtn = new ButtonComponent(foot).setButtonText("确定").setCta();
    this.confirmBtn.onClick(() => this.submit());
    this.syncConfirm();
  }

  private shiftMonth(delta: number): void {
    const d = momentFn(`${this.viewY}-${String(this.viewM).padStart(2, "0")}-01`, "YYYY-MM-DD", true).add(delta, "month");
    this.viewY = d.year();
    this.viewM = d.month() + 1;
    this.renderGrid();
    this.syncNavLabel();
  }

  private syncNavLabel(): void {
    this.navLabelEl.setText(`${this.viewY} 年 ${this.viewM} 月`);
  }

  private syncHint(): void {
    if (!this.pickStart) {
      this.hintEl.setText("在下方月历中点选第一天；再点选最后一天（可跨月翻页）。");
    } else if (!this.pickEnd) {
      this.hintEl.setText(`已开始：${this.pickStart}。请再点选结束日，或直接点「确定」视为仅一天。`);
    } else {
      this.hintEl.setText(`已选：${this.pickStart} ～ ${this.pickEnd}`);
    }
  }

  private syncConfirm(): void {
    this.confirmBtn.setDisabled(!this.pickStart);
  }

  private submit(): void {
    if (!this.pickStart) return;
    const s = this.pickStart;
    const e = this.pickEnd || this.pickStart;
    const a = s <= e ? s : e;
    const b = s <= e ? e : s;
    this.opts.onConfirm(a, b);
    this.close();
  }

  private onDayClick(key: string): void {
    if (!this.pickStart || (this.pickStart && this.pickEnd)) {
      this.pickStart = key;
      this.pickEnd = null;
    } else {
      let a = this.pickStart;
      let b = key;
      if (b < a) {
        const t = a;
        a = b;
        b = t;
      }
      this.pickStart = a;
      this.pickEnd = b;
    }
    this.syncHint();
    this.renderGrid();
    this.syncConfirm();
  }

  private cellInRange(key: string): "edge-start" | "edge-end" | "mid" | "none" {
    if (!this.pickStart) return "none";
    const end = this.pickEnd || this.pickStart;
    const lo = this.pickStart <= end ? this.pickStart : end;
    const hi = this.pickStart <= end ? end : this.pickStart;
    if (key < lo || key > hi) return "none";
    if (key === lo && key === hi) return "edge-start";
    if (key === lo) return "edge-start";
    if (key === hi) return "edge-end";
    return "mid";
  }

  private renderGrid(): void {
    this.gridHost.empty();
    this.syncNavLabel();

    const first = momentFn(`${this.viewY}-${String(this.viewM).padStart(2, "0")}-01`, "YYYY-MM-DD", true);
    if (!first.isValid()) return;
    const startGrid = first.clone().startOf("isoWeek");
    let cur = startGrid.clone();
    for (let r = 0; r < 6; r++) {
      const row = this.gridHost.createDiv({ cls: "rslatte-mrp-row" });
      for (let c = 0; c < 7; c++) {
        const key = cur.format("YYYY-MM-DD");
        const inMonth = cur.month() + 1 === this.viewM;
        const ir = this.cellInRange(key);
        const cell = row.createEl("button", {
          type: "button",
          cls: "rslatte-mrp-day",
          text: cur.format("D"),
        });
        if (!inMonth) cell.addClass("rslatte-mrp-day--muted");
        if (ir === "mid") cell.addClass("rslatte-mrp-day--range");
        if (ir === "edge-start" || ir === "edge-end") cell.addClass("rslatte-mrp-day--edge");
        cell.onclick = (ev) => {
          ev.preventDefault();
          this.onDayClick(key);
        };
        cur.add(1, "day");
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
