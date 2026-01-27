import { App, Modal, Setting, Notice } from "obsidian";
import type RSLattePlugin from "../../main";
import type { FinanceCatDef } from "../../types/rslatteTypes";
import { VIEW_TYPE_RSLATTE } from "../../constants/viewTypes";

/**
 * 新增财务分类弹窗
 */
export class AddFinanceCategoryModal extends Modal {
  private name: string = "";
  private type: "income" | "expense" = "expense";
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
    contentEl.createEl("h3", { text: "新增财务分类" });

    // 显示ID（只读）
    new Setting(contentEl)
      .setName("ID")
      .setDesc("自动生成的唯一标识符")
      .addText((text) => {
        text.setValue(this.newId);
        text.inputEl.disabled = true;
        text.inputEl.style.opacity = "0.6";
      });

    // 财务分类名称（必填，不能重复）
    new Setting(contentEl)
      .setName("财务分类名称")
      .setDesc("必填，不能与已有财务分类名称重复")
      .addText((text) => {
        text.setPlaceholder("请输入财务分类名称")
          .onChange((v) => {
            this.name = (v ?? "").trim();
            this.validateName();
            this.updateErrorDisplay();
          });
      });

    // 财务分类类型（收入/支出）
    new Setting(contentEl)
      .setName("财务分类类型")
      .setDesc("选择该分类是收入还是支出")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("expense", "支出")
          .addOption("income", "收入")
          .setValue(this.type)
          .onChange((value) => {
            this.type = value as "income" | "expense";
          });
      });

    // 错误提示
    const errorEl = contentEl.createDiv({ cls: "rslatte-error-text" });
    errorEl.style.display = "none";
    errorEl.style.color = "var(--text-error)";
    errorEl.style.marginTop = "8px";

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
    // 生成类似 FC_XXXXXX 的ID
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let id = "FC_";
    for (let i = 0; i < 6; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id;
  }

  private validateName(): boolean {
    this.nameError = "";
    
    if (!this.name) {
      this.nameError = "财务分类名称不能为空";
      return false;
    }

    // 检查是否与已有名称重复
    const existingCategories = this.plugin.settings.financeCategories || [];
    const duplicate = existingCategories.some(cat => 
      cat.name.trim().toLowerCase() === this.name.toLowerCase()
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
      const newCategory: FinanceCatDef = {
        id: this.newId,
        name: this.name,
        type: this.type,
        active: true,
      };

      if (!this.plugin.settings.financeCategories) {
        this.plugin.settings.financeCategories = [];
      }

      this.plugin.settings.financeCategories.push(newCategory);
      await this.plugin.saveSettings();

      new Notice(`财务分类"${this.name}"已添加`);
      this.close();

      // 刷新侧边栏
      const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_RSLATTE)[0]?.view as any;
      if (view && typeof view.render === "function") {
        await view.render();
      }
    } catch (e) {
      new Notice(`保存失败：${e instanceof Error ? e.message : String(e)}`);
      console.error("[RSLatte] Failed to add finance category:", e);
    }
  }
}
