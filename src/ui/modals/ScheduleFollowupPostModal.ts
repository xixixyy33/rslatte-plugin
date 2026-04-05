import { App, ButtonComponent, Modal, Notice } from "obsidian";

/**
 * 已结束且无 followup 记录的日程：补充后续任务 / 提醒 / 日程（仅写本日程 meta）。
 */
export class ScheduleFollowupPostModal extends Modal {
  constructor(
    app: App,
    private readonly opts: {
      onAddTask: () => void | Promise<void>;
      onAddMemo: () => void | Promise<void>;
      onAddSchedule: () => void | Promise<void>;
    }
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("后续安排");
    contentEl.createEl("p", {
      text: "为已结束的日程补充后续任务、提醒或日程；成功后仅在本日程 meta 中记录新条目 uid（任务/提醒/日程侧不回写）。",
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
    new ButtonComponent(row).setButtonText("增加后续任务").setCta().onClick(() => void run(this.opts.onAddTask));
    new ButtonComponent(row).setButtonText("增加后续提醒").setCta().onClick(() => void run(this.opts.onAddMemo));
    new ButtonComponent(row).setButtonText("增加后续日程").setCta().onClick(() => void run(this.opts.onAddSchedule));
    new ButtonComponent(row).setButtonText("关闭").onClick(() => this.close());
  }
}
