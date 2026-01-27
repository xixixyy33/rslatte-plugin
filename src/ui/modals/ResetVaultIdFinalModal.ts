import { ButtonComponent, Modal, type App } from "obsidian";
import type RSLattePlugin from "../../main";

/** 两段确认：第二段（最终确认） */
export class ResetVaultIdFinalModal extends Modal {
  constructor(
    app: App,
    private plugin: RSLattePlugin,
    private onExecute: () => Promise<void>
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("最后确认");

    contentEl.createEl("p", {
      text: "即将重新初始化插件数据。点击“确认”后开始执行。",
    });

    const logPath = (this.plugin as any).getAuditLogPath?.() as string | undefined;
    if (logPath) {
      contentEl.createEl("p", { text: `本次操作将记录到审计日志：${logPath}` });
    } else {
      contentEl.createEl("p", { text: "本次操作将记录到插件本地审计日志（audit.log）。" });
    }

    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });

    new ButtonComponent(btnRow)
      .setButtonText("取消")
      .onClick(() => this.close());

    new ButtonComponent(btnRow)
      .setButtonText("确认")
      .setCta()
      .onClick(async () => {
        try {
          await this.onExecute();
        } finally {
          this.close();
        }
      });
  }

  onClose() {
    this.contentEl.empty();
  }
}
