import { ButtonComponent, Modal, type App } from "obsidian";

/** 专注即时计时：重置为未开始状态，清空主题与关联任务/输出前的确认 */
export class CaptureTimerResetConfirmModal extends Modal {
  constructor(
    app: App,
    private onConfirmed: () => void | Promise<void>,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("重置专注计时");

    contentEl.createEl("p", {
      text:
        "确定要重置吗？当前累计时长与暂停记录将被清空，「正在专注」主题及关联任务、关联输出也会清除。重置后请点 ⏳ 重新开启计时并填写信息。",
    });

    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });

    new ButtonComponent(btnRow)
      .setButtonText("取消")
      .onClick(() => this.close());

    new ButtonComponent(btnRow)
      .setButtonText("确认重置")
      .setCta()
      .onClick(() => {
        this.close();
        void Promise.resolve(this.onConfirmed()).catch((e) => {
          console.warn("[RSLatte][capture] timer reset failed", e);
        });
      });
  }

  onClose() {
    this.contentEl.empty();
  }
}
