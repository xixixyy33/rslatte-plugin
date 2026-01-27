import { App, ButtonComponent, Modal, Setting } from "obsidian";
import type RSLattePlugin from "../../main";
import type { CheckinItemDef } from "../../types/rslatteTypes";

/**
 * 打卡弹窗（仅维护"今日"）：
 * - DB 为事实来源：根据 checkin_records.is_delete 判断是否已打卡
 * - 点击一次 = 自动切换（已打卡 -> 取消；未打卡/已删除 -> 打卡）
 * - 备注写入 checkin_records.note
 * - DB 操作失败：不写日记、不刷新 UI 状态；错误细节写入 audit.log
 */
export class CheckinModal extends Modal {
  constructor(app: App, private plugin: RSLattePlugin, private item: CheckinItemDef) {
    super(app);
  }

  onOpen() {
    void this.render();
  }

  private async render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: `打卡：${this.item.name}` });

    const dateKey = this.plugin.getTodayKey();

    // ✅ 仅在"从未初始化/跨天"时才访问后端，避免每次点按钮都去查 DB
    await ((this.plugin as any).ensureTodayCheckinsInitialized?.() ?? Promise.resolve());
    const existing = this.plugin.getTodayCheckinRecord(this.item.id);

    const isActive = !!existing && !existing.is_delete;
    let note = (existing?.note ?? "").trim();

    contentEl.createEl("p", { text: `日期：${dateKey}（仅维护当天打卡）` });
    contentEl.createEl("p", { text: `当前状态：${isActive ? "已打卡" : "未打卡"}` });

    new Setting(contentEl)
      .setName("备注")
      .setDesc("可选；写入数据库 checkin_records.note")
      .addText((t) => {
        t.setPlaceholder("可选");
        t.setValue(note);
        t.onChange((v) => (note = (v ?? "").trim()));
      });

    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });

    new ButtonComponent(btnRow)
      .setButtonText(isActive ? "取消打卡" : "打卡")
      .setCta()
      .onClick(async () => {
        // ✅ 使用共享的打卡切换业务逻辑
        await this.plugin.performCheckinToggle(this.item, note);
        this.close();
      });

    new ButtonComponent(btnRow)
      .setButtonText("关闭")
      .onClick(() => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}
