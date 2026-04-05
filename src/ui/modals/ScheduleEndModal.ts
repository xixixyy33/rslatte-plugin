import { App, ButtonComponent, Modal, Notice } from "obsidian";

/**
 * 日程侧栏「结束并新增」：仅提供任务/提醒/日程三条路径（与 ✅ 直接结束区分）。
 */
export class ScheduleEndModal extends Modal {
  constructor(
    app: App,
    private readonly opts: {
      onEndWithTask: () => void | Promise<void>;
      onEndWithMemo: () => void | Promise<void>;
      onEndWithSchedule: () => void | Promise<void>;
    },
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("结束日程并新增");
    contentEl.createEl("p", {
      text: "将当前日程标为已结束，并打开新建任务/提醒/日程；关联仅写在本日程 meta（followup_*）。若只需结束、不新增，请点卡片上的 ✅。",
      cls: "setting-item-description",
    });

    const run = async (fn: () => void | Promise<void>) => {
      try {
        this.close();
        await fn();
      } catch (e: any) {
        new Notice(`操作失败：${e?.message ?? String(e)}`);
      }
    };

    const row = contentEl.createDiv({ cls: "rslatte-modal-actions" });
    new ButtonComponent(row).setButtonText("结束并增加任务").setCta().onClick(() => void run(this.opts.onEndWithTask));
    new ButtonComponent(row).setButtonText("结束并增加提醒").setCta().onClick(() => void run(this.opts.onEndWithMemo));
    new ButtonComponent(row).setButtonText("结束并增加日程").setCta().onClick(() => void run(this.opts.onEndWithSchedule));
    new ButtonComponent(row).setButtonText("关闭").onClick(() => this.close());
  }
}
