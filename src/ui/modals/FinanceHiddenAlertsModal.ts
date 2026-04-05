import { App, ButtonComponent, Modal } from "obsidian";

export type HiddenAlertItem = {
  key: string;
  hiddenUntil: string;
};

/**
 * 已隐藏告警管理：查看、逐条恢复、全部恢复。
 */
export class FinanceHiddenAlertsModal extends Modal {
  constructor(
    app: App,
    private items: HiddenAlertItem[],
    private onRestoreOne: (key: string) => Promise<void>,
    private onRestoreAll: () => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("已隐藏告警管理");
    this.contentEl.empty();

    this.contentEl.createDiv({
      cls: "rslatte-modal-info",
      text: `当前共 ${this.items.length} 条隐藏规则（按隐藏截止时间展示）。`,
    });

    const actionsTop = this.contentEl.createDiv({ cls: "rslatte-modal-actions" });
    new ButtonComponent(actionsTop)
      .setButtonText("全部恢复")
      .setCta()
      .onClick(async () => {
        await this.onRestoreAll();
        this.close();
      });
    new ButtonComponent(actionsTop).setButtonText("关闭").onClick(() => this.close());

    if (!this.items.length) {
      this.contentEl.createDiv({ cls: "rslatte-muted", text: "暂无隐藏告警。" });
      return;
    }

    const list = this.contentEl.createDiv({ cls: "rslatte-finance-stats-sub" });
    for (const it of this.items) {
      const row = list.createDiv({ cls: "rslatte-section-title-row" });
      const left = row.createDiv();
      const label = this.labelForHiddenKey(it.key);
      left.setText(`${label} · 截止 ${it.hiddenUntil || "—"}`);

      const right = row.createDiv({ cls: "rslatte-section-title-right" });
      new ButtonComponent(right)
        .setButtonText("恢复")
        .onClick(async () => {
          await this.onRestoreOne(it.key);
          this.close();
        });
    }
  }

  private labelForHiddenKey(key: string): string {
    const s = String(key ?? "");
    if (s.startsWith("fp:")) return `指纹 ${s.slice(3, 11)}`;
    if (s.startsWith("raw:")) {
      const body = s.slice(4);
      const first = body.split("|")[0] || body;
      return `规则 ${first}`;
    }
    return s.slice(0, 40);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

