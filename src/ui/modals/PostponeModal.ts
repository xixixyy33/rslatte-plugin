import { App, ButtonComponent, Modal, Notice, Setting } from "obsidian";

/**
 * 项目/里程碑延期弹窗：必填延期天数，选填原因。
 * 6-细7：不展示历史延期次数。
 */
export class PostponeModal extends Modal {
  constructor(
    app: App,
    private titleText: string,
    private onConfirm: (days: number, reason?: string) => void | Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(this.titleText);

    let daysStr = "";
    let reason = "";

    new Setting(contentEl)
      .setName("延期天数*")
      .setDesc("必填，正整数")
      .addText((t) => {
        t.inputEl.type = "number";
        t.setPlaceholder("例如 3");
        t.onChange((v) => (daysStr = (v ?? "").trim()));
      });

    new Setting(contentEl)
      .setName("延期原因说明")
      .setDesc("选填")
      .addTextArea((t) => {
        t.setPlaceholder("可选");
        t.onChange((v) => (reason = (v ?? "").trim()));
      });

    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });
    new ButtonComponent(btnRow).setButtonText("取消").onClick(() => this.close());
    new ButtonComponent(btnRow).setCta().setButtonText("确认").onClick(async () => {
      const d = parseInt(daysStr, 10);
      if (!Number.isFinite(d) || d < 1) {
        new Notice("延期天数须为正整数");
        return;
      }
      this.close();
      try {
        await this.onConfirm(d, reason || undefined);
      } catch (e: any) {
        new Notice(e?.message ?? "延期失败");
      }
    });
  }
}
