import { ButtonComponent, Modal, type App } from "obsidian";
import type RSLattePlugin from "../../main";

/** 两段确认：第一段（危险提示） */
export class ResetVaultIdConfirmModal extends Modal {
  constructor(
    app: App,
    private plugin: RSLattePlugin,
    private onConfirmed: () => void
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("⚠️ 重新初始化 Vault ID");

    contentEl.createEl("p", {
      text:
        "该操作将生成新的 Vault ID，用于数据库隔离。执行后，插件将无法再获取旧 Vault ID 对应的历史数据。",
    });

    contentEl.createEl("p", { text: "请谨慎评估后再操作。" });

    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });

    new ButtonComponent(btnRow)
      .setButtonText("取消")
      .onClick(() => this.close());

    new ButtonComponent(btnRow)
      .setButtonText("确认")
      .setCta()
      .onClick(() => {
        this.close();
        this.onConfirmed();
      });
  }

  onClose() {
    this.contentEl.empty();
  }
}
