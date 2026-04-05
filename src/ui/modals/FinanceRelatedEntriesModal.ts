import { App, ButtonComponent, Modal } from "obsidian";

export type FinanceRelatedEntryItem = {
  entryId: string;
  recordDate: string;
  categoryName: string;
  subcategory?: string;
  amount: number;
  type: "income" | "expense";
  institutionName?: string;
};

/**
 * 告警关联记录集弹窗：用于查看 relatedEntryIds 对应的财务条目，并逐条跳转。
 */
export class FinanceRelatedEntriesModal extends Modal {
  constructor(
    app: App,
    private titleText: string,
    private items: FinanceRelatedEntryItem[],
    private onOpenOne: (entryId: string) => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.titleText || "关联财务记录");
    this.contentEl.empty();

    if (!this.items.length) {
      this.contentEl.createDiv({ cls: "rslatte-muted", text: "没有可展示的关联记录。" });
      new ButtonComponent(this.contentEl.createDiv({ cls: "rslatte-modal-actions" }))
        .setButtonText("关闭")
        .onClick(() => this.close());
      return;
    }

    this.contentEl.createDiv({
      cls: "rslatte-modal-info",
      text: `共 ${this.items.length} 条关联记录。点击“打开”可跳转到对应日记定位。`,
    });

    const list = this.contentEl.createDiv({ cls: "rslatte-finance-stats-sub" });
    for (const it of this.items) {
      const row = list.createDiv({ cls: "rslatte-section-title-row" });
      const left = row.createDiv();
      const amountText = `${it.type === "income" ? "+" : "-"}¥${Math.abs(Number(it.amount || 0)).toFixed(2)}`;
      const sub = it.subcategory ? `【${it.subcategory}】` : "";
      const inst = it.institutionName ? ` · ${it.institutionName}` : "";
      left.setText(`${it.recordDate} · ${it.categoryName}${sub} ${amountText}${inst}`);

      const right = row.createDiv({ cls: "rslatte-section-title-right" });
      const openBtn = new ButtonComponent(right)
        .setButtonText("打开")
        .onClick(async () => {
          await this.onOpenOne(it.entryId);
        });
      openBtn.buttonEl.title = `entry_id: ${it.entryId}`;
    }

    const actions = this.contentEl.createDiv({ cls: "rslatte-modal-actions" });
    new ButtonComponent(actions).setButtonText("关闭").onClick(() => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

