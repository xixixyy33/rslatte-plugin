import { App, Modal, Setting } from "obsidian";
import { isYmd } from "../../taskRSLatte/utils";

export type EditProjectResult = {
  projectName: string;
  planned_end?: string;
  planned_start?: string;
};

export class EditProjectModal extends Modal {
  private _projectName: string;
  private _plannedEnd: string;
  private _plannedStart: string;
  private readonly _onOk: (r: EditProjectResult) => void;

  constructor(app: App, init: { projectName: string; planned_end?: string; planned_start?: string }, onOk: (r: EditProjectResult) => void) {
    super(app);
    this._projectName = (init.projectName ?? "").trim();
    this._plannedEnd = (init.planned_end ?? "").trim();
    this._plannedStart = (init.planned_start ?? "").trim();
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
      .setName("计划开始日")
      .setDesc("选填，格式 YYYY-MM-DD")
      .addText((t) => {
        t.inputEl.type = "date";
        t.setPlaceholder("YYYY-MM-DD");
        t.setValue(this._plannedStart);
        t.onChange((v) => (this._plannedStart = (v ?? "").trim()));
      });

    new Setting(contentEl)
      .setName("计划结束日")
      .setDesc("必填，格式 YYYY-MM-DD")
      .addText((t) => {
        t.inputEl.type = "date";
        t.setPlaceholder("YYYY-MM-DD");
        t.setValue(this._plannedEnd);
        t.onChange((v) => (this._plannedEnd = (v ?? "").trim()));
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
          const plannedEnd = (this._plannedEnd ?? "").trim();
          const plannedStart = (this._plannedStart ?? "").trim();
          if (!name) {
            this.titleEl.setText("修改项目信息（项目名称为必填）");
            return;
          }
          if (!plannedEnd || !isYmd(plannedEnd)) {
            this.titleEl.setText("修改项目信息（计划结束日为必填，格式 YYYY-MM-DD）");
            return;
          }
          if (plannedStart && !isYmd(plannedStart)) {
            this.titleEl.setText("修改项目信息（计划开始日格式必须为 YYYY-MM-DD）");
            return;
          }
          this.close();
          this._onOk({ projectName: name, planned_end: plannedEnd, planned_start: plannedStart || undefined });
        });
      });
  }
}
