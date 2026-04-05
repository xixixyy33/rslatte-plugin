import { App, Modal, Setting, Notice } from "obsidian";
import type RSLattePlugin from "../../main";
import type { CheckinItemDef } from "../../types/rslatteTypes";
import { VIEW_TYPE_RSLATTE } from "../../constants/viewTypes";

/**
 * 新增打卡项弹窗
 */
export class AddCheckinItemModal extends Modal {
  private name: string = "";
  private nameError: string = "";
  private readonly newId: string;

  constructor(app: App, private plugin: RSLattePlugin) {
    super(app);
    this.newId = this.generateId();
  }

  onOpen() {
    void this.render();
  }

  private async render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "新增打卡项" });

    // 显示ID（只读）
    new Setting(contentEl)
      .setName("ID")
      .setDesc("自动生成的唯一标识符")
      .addText((text) => {
        text.setValue(this.newId);
        text.inputEl.disabled = true;
        text.inputEl.style.opacity = "0.6";
      });

    // 打卡项名称（必填，不能重复）
    new Setting(contentEl)
      .setName("打卡项名称")
      .setDesc("必填，不能与已有打卡项名称重复")
      .addText((text) => {
        text.setPlaceholder("请输入打卡项名称")
          .onChange((v) => {
            this.name = (v ?? "").trim();
            this.validateName();
            this.updateErrorDisplay();
          });
      });

    // 错误提示
    const errorEl = contentEl.createDiv({ cls: "rslatte-error-text" });
    errorEl.style.display = "none";
    errorEl.style.color = "var(--text-error)";
    errorEl.style.marginTop = "8px";

    // 按钮颜色说明（默认绿色）
    contentEl.createEl("p", { 
      text: "按钮颜色：默认绿色（可在设置中修改）",
      cls: "rslatte-modal-hint"
    });

    // 按钮区域
    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });

    btnRow.createEl("button", { text: "取消", cls: "mod-cta" })
      .addEventListener("click", () => this.close());

    const saveBtn = btnRow.createEl("button", { text: "保存", cls: "mod-cta" });
    saveBtn.addEventListener("click", async () => {
      if (this.validateName()) {
        await this.save();
      }
    });

    this.updateErrorDisplay = () => {
      if (this.nameError) {
        errorEl.textContent = this.nameError;
        errorEl.style.display = "block";
        saveBtn.disabled = true;
      } else {
        errorEl.style.display = "none";
        saveBtn.disabled = !this.name;
      }
    };
  }

  private generateId(): string {
    // 生成类似 CI_XXXXXX 的ID
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let id = "CI_";
    for (let i = 0; i < 6; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id;
  }

  private validateName(): boolean {
    this.nameError = "";
    
    if (!this.name) {
      this.nameError = "打卡项名称不能为空";
      return false;
    }

    // 检查是否与已有名称重复
    const existingItems = this.plugin.settings.checkinItems || [];
    const duplicate = existingItems.some(item => 
      item.name.trim().toLowerCase() === this.name.toLowerCase()
    );

    if (duplicate) {
      this.nameError = "该名称已存在，请使用其他名称";
      return false;
    }

    return true;
  }

  private updateErrorDisplay: () => void = () => {};

  private async save() {
    try {
      const newItem: CheckinItemDef = {
        id: this.newId,
        name: this.name,
        active: true,
        checkinDifficulty: "normal",
        heatColor: undefined, // 默认绿色，不设置heatColor
      };

      if (!this.plugin.settings.checkinItems) {
        this.plugin.settings.checkinItems = [];
      }

      this.plugin.settings.checkinItems.push(newItem);
      await this.plugin.saveSettings();

      new Notice(`打卡项"${this.name}"已添加`);
      this.close();

      // 刷新侧边栏
      const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_RSLATTE)[0]?.view as any;
      if (view && typeof view.render === "function") {
        await view.render();
      }
    } catch (e) {
      new Notice(`保存失败：${e instanceof Error ? e.message : String(e)}`);
      console.error("[RSLatte] Failed to add checkin item:", e);
    }
  }
}
