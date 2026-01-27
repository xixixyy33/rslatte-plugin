import { App, Modal, Setting, Notice } from "obsidian";
import type RSLattePlugin from "../../main";
import type { JournalPanel } from "../../types/rslatteTypes";
import { VIEW_TYPE_RSLATTE } from "../../constants/viewTypes";

/**
 * 新增日志子窗口弹窗
 */
export class AddJournalPanelModal extends Modal {
  private label: string = "";
  private heading: string = "";
  private maxLines: string = "";
  private labelError: string = "";
  private headingError: string = "";
  private maxLinesError: string = "";
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
    contentEl.createEl("h3", { text: "新增日志子窗口" });

    // 显示ID（只读）
    new Setting(contentEl)
      .setName("ID")
      .setDesc("自动生成的唯一标识符")
      .addText((text) => {
        text.setValue(this.newId);
        text.inputEl.disabled = true;
        text.inputEl.style.opacity = "0.6";
      });

    // 按钮名（必填）
    new Setting(contentEl)
      .setName("按钮名")
      .setDesc("必填，显示在侧边栏的按钮名称")
      .addText((text) => {
        text.setPlaceholder("请输入按钮名")
          .onChange((v) => {
            this.label = (v ?? "").trim();
            this.validateLabel();
            this.updateErrorDisplay();
          });
      });

    // 标题行（必填）
    new Setting(contentEl)
      .setName("标题行")
      .setDesc("必填，在日记中显示的标题（Markdown 格式，例如：### 今天学了什么?）")
      .addText((text) => {
        text.setPlaceholder("### 今天学了什么?")
          .onChange((v) => {
            this.heading = (v ?? "").trim();
            this.validateHeading();
            this.updateErrorDisplay();
          });
      });

    // 行数（必填）
    new Setting(contentEl)
      .setName("行数")
      .setDesc("必填，预览时显示的最大行数（正整数）")
      .addText((text) => {
        text.setPlaceholder("5")
          .onChange((v) => {
            this.maxLines = (v ?? "").trim();
            this.validateMaxLines();
            this.updateErrorDisplay();
          });
        text.inputEl.type = "number";
        text.inputEl.min = "1";
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
      if (this.validateAll()) {
        await this.save();
      }
    });

    this.updateErrorDisplay = () => {
      const allErrors = [this.labelError, this.headingError, this.maxLinesError].filter(Boolean);
      if (allErrors.length > 0) {
        errorEl.textContent = allErrors.join("；");
        errorEl.style.display = "block";
        saveBtn.disabled = true;
      } else {
        errorEl.style.display = "none";
        const isValid = this.label && this.heading && this.maxLines;
        saveBtn.disabled = !isValid;
      }
    };
  }

  private generateId(): string {
    // 生成类似 JP_XXXXXX 的ID
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let id = "JP_";
    for (let i = 0; i < 6; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id;
  }

  private validateLabel(): boolean {
    this.labelError = "";
    
    if (!this.label) {
      this.labelError = "按钮名不能为空";
      return false;
    }

    // 检查是否与已有按钮名重复
    const existingPanels = this.plugin.settings.journalPanels || [];
    const duplicate = existingPanels.some(panel => 
      panel.label.trim().toLowerCase() === this.label.toLowerCase()
    );

    if (duplicate) {
      this.labelError = "该按钮名已存在，请使用其他按钮名";
      return false;
    }

    return true;
  }

  private validateHeading(): boolean {
    this.headingError = "";
    
    if (!this.heading) {
      this.headingError = "标题行不能为空";
      return false;
    }

    return true;
  }

  private validateMaxLines(): boolean {
    this.maxLinesError = "";
    
    if (!this.maxLines) {
      this.maxLinesError = "行数不能为空";
      return false;
    }

    const num = Number.parseInt(this.maxLines, 10);
    if (!Number.isFinite(num) || num < 1) {
      this.maxLinesError = "行数必须是大于0的正整数";
      return false;
    }

    return true;
  }

  private validateAll(): boolean {
    const labelValid = this.validateLabel();
    const headingValid = this.validateHeading();
    const maxLinesValid = this.validateMaxLines();
    return labelValid && headingValid && maxLinesValid;
  }

  private updateErrorDisplay: () => void = () => {};

  private async save() {
    try {
      const maxLinesNum = Number.parseInt(this.maxLines, 10);
      const newPanel: JournalPanel = {
        id: this.newId,
        label: this.label,
        heading: this.heading,
        maxLines: maxLinesNum,
      };

      if (!this.plugin.settings.journalPanels) {
        this.plugin.settings.journalPanels = [];
      }

      this.plugin.settings.journalPanels.push(newPanel);
      await this.plugin.saveSettings();

      new Notice(`日志子窗口"${this.label}"已添加`);
      this.close();

      // 刷新侧边栏
      const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_RSLATTE)[0]?.view as any;
      if (view && typeof view.render === "function") {
        await view.render();
      }
    } catch (e) {
      new Notice(`保存失败：${e instanceof Error ? e.message : String(e)}`);
      console.error("[RSLatte] Failed to add journal panel:", e);
    }
  }
}
