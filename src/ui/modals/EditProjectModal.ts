import { App, Modal, Setting } from "obsidian";
import { isYmd } from "../../taskRSLatte/utils";

export type EditProjectResult = {
  projectName: string;
  dueYmd?: string;
};

export class EditProjectModal extends Modal {
  private _projectName: string;
  private _dueYmd: string;
  private readonly _onOk: (r: EditProjectResult) => void;

  constructor(app: App, init: { projectName: string; dueYmd?: string }, onOk: (r: EditProjectResult) => void) {
    super(app);
    this._projectName = (init.projectName ?? "").trim();
    this._dueYmd = (init.dueYmd ?? "").trim();
    this._onOk = onOk;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("修改项目信息");

    new Setting(contentEl)
      .setName("项目名称")
      .setDesc("必填")
      .addText((t) => {
        t.setPlaceholder("请输入项目名称");
        t.setValue(this._projectName);
        t.onChange((v) => (this._projectName = v));
      });

    new Setting(contentEl)
      .setName("截至时间")
      .setDesc("选填，格式 YYYY-MM-DD")
      .addText((t) => {
        t.setPlaceholder("YYYY-MM-DD");
        t.setValue(this._dueYmd);
        t.onChange((v) => (this._dueYmd = v));
      });

    new Setting(contentEl)
      .addButton((b) => {
        b.setButtonText("取消");
        b.onClick(() => this.close());
      })
      .addButton((b) => {
        b.setCta();
        b.setButtonText("确认");
        b.onClick(() => {
          const name = (this._projectName ?? "").trim();
          const due = (this._dueYmd ?? "").trim();
          if (!name) {
            // 不 throw，避免红字堆栈
            this.titleEl.setText("修改项目信息（项目名称为必填）");
            return;
          }
          if (due && !isYmd(due)) {
            this.titleEl.setText("修改项目信息（截至时间格式必须为 YYYY-MM-DD）");
            return;
          }
          this.close();
          this._onOk({ projectName: name, dueYmd: due || undefined });
        });
      });
  }
}
