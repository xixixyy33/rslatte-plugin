import { App, ButtonComponent, Modal, Notice, Setting, TextComponent } from "obsidian";

/**
 * 将输出标为 waiting_until，并写入 resume_at（YYYY-MM-DD）。
 */
export class SetOutputWaitingModal extends Modal {
  constructor(
    app: App,
    private titleSuffix: string,
    private onConfirm: (resumeAtYmd: string) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(`等待至指定日期：${this.titleSuffix}`);

    let dateVal = "";
    let btn!: ButtonComponent;

    const refresh = () => {
      const ok = /^\d{4}-\d{2}-\d{2}$/.test(dateVal);
      btn?.setDisabled(!ok);
      return ok;
    };

    new Setting(contentEl)
      .setName("恢复日期")
      .setDesc("到该日（含）起可将状态自动恢复为进行中；也可在到期前手动点「继续」")
      .addText((t: TextComponent) => {
        t.inputEl.type = "date";
        t.onChange((v) => {
          dateVal = (v ?? "").trim();
          refresh();
        });
      });

    const row = new Setting(contentEl);
    row.addButton((b) => {
      b.setButtonText("取消");
      b.onClick(() => this.close());
    });
    row.addButton((b) => {
      btn = b;
      b.setButtonText("确认");
      b.setCta();
      b.onClick(() => void submit());
    });

    const submit = async () => {
      if (!refresh()) {
        new Notice("请选择有效日期");
        return;
      }
      try {
        await this.onConfirm(dateVal);
        this.close();
      } catch (e: any) {
        new Notice(`操作失败：${e?.message ?? String(e)}`);
      }
    };

    refresh();
  }
}
