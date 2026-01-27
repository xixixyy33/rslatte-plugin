import { App, Modal, Setting, Notice, normalizePath, TFile, AbstractInputSuggest } from "obsidian";
import type RSLattePlugin from "../../main";
import type { OutputTemplateDef } from "../../types/outputTypes";
import { VIEW_TYPE_OUTPUTS } from "../../constants/viewTypes";

/**
 * 文件路径自动补全建议
 */
class FilePathSuggest extends AbstractInputSuggest<string> {
  private files: TFile[];
  private onSelectCb?: (path: string) => void;

  constructor(app: App, inputEl: HTMLInputElement, onSelect?: (path: string) => void) {
    super(app, inputEl);
    this.files = app.vault.getMarkdownFiles();
    this.onSelectCb = onSelect;
  }

  getSuggestions(inputStr: string): string[] {
    const query = inputStr.toLowerCase().trim();
    if (!query) {
      return this.files.slice(0, 20).map(f => f.path);
    }
    return this.files
      .filter(file => file.path.toLowerCase().includes(query))
      .slice(0, 20)
      .map(f => f.path);
  }

  renderSuggestion(path: string, el: HTMLElement): void {
    el.createEl("div", { text: path });
  }

  selectSuggestion(path: string, _evt: MouseEvent | KeyboardEvent): void {
    this.setValue(path);
    // 通过 onSelect 回调更新状态（回调会更新输入框和验证）
    this.onSelectCb?.(path);
    this.close();
  }
}

/**
 * 文件夹路径自动补全建议
 */
class FolderPathSuggest extends AbstractInputSuggest<string> {
  private folders: string[];
  private onSelectCb?: (path: string) => void;

  constructor(app: App, inputEl: HTMLInputElement, onSelect?: (path: string) => void) {
    super(app, inputEl);
    this.folders = [""].concat(
      app.vault.getAllFolders().map(f => f.path)
    );
    this.onSelectCb = onSelect;
  }

  getSuggestions(inputStr: string): string[] {
    const query = inputStr.toLowerCase().trim();
    if (!query) {
      return this.folders.slice(0, 20);
    }
    return this.folders
      .filter(folder => folder.toLowerCase().includes(query))
      .slice(0, 20);
  }

  renderSuggestion(path: string, el: HTMLElement): void {
    el.createEl("div", { text: path || "/" });
  }

  selectSuggestion(path: string, _evt: MouseEvent | KeyboardEvent): void {
    this.setValue(path);
    // 通过 onSelect 回调更新状态（回调会更新输入框和验证）
    this.onSelectCb?.(path);
    this.close();
  }
}

/**
 * 新增输出文档模板弹窗
 */
export class AddOutputTemplateModal extends Modal {
  private buttonName: string = "";
  private docCategory: string = "";
  private templatePath: string = "";
  private archiveDir: string = "";
  private tags: string = "output";
  private type: string = "";
  
  private buttonNameError: string = "";
  private docCategoryError: string = "";
  private templatePathError: string = "";
  private archiveDirError: string = "";
  private tagsError: string = "";
  private typeError: string = "";
  
  private readonly newId: string;
  private existingTypes: Set<string> = new Set();

  constructor(app: App, private plugin: RSLattePlugin) {
    super(app);
    this.newId = this.generateId();
  }

  async onOpen() {
    await this.loadData();
    void this.render();
  }

  private async loadData() {
    // 加载已有的 type 列表
    const op = this.plugin.settings.outputPanel || ({} as any);
    const templates = (op.templates || []) as OutputTemplateDef[];
    this.existingTypes = new Set(templates.map(t => t.type).filter(Boolean));
    
    // 设置默认存档目录
    if (!this.archiveDir && op.archiveRoots && op.archiveRoots.length > 0) {
      this.archiveDir = op.archiveRoots[0];
    }
  }

  private async render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "新增输出文档模板" });

    // 显示ID（只读）
    new Setting(contentEl)
      .setName("ID")
      .setDesc("自动生成的唯一标识符")
      .addText((text) => {
        text.setValue(this.newId);
        text.inputEl.disabled = true;
        text.inputEl.style.opacity = "0.6";
      });

    // 按钮名称（必填）
    new Setting(contentEl)
      .setName("按钮名称")
      .setDesc("必填，显示在侧边栏的按钮名称")
      .addText((text) => {
        text.setPlaceholder("请输入按钮名称")
          .onChange((v) => {
            this.buttonName = (v ?? "").trim();
            this.validateButtonName();
            this.updateErrorDisplay();
          });
      });

    // 文档分类（必填）
    new Setting(contentEl)
      .setName("文档分类")
      .setDesc("必填，用于文档标题前缀，例如：食谱、课程笔记")
      .addText((text) => {
        text.setPlaceholder("请输入文档分类")
          .onChange((v) => {
            this.docCategory = (v ?? "").trim();
            this.validateDocCategory();
            this.updateErrorDisplay();
          });
      });

    // 文档模板（必填，使用 Obsidian 的文件路径自动补全）
    const templateSetting = new Setting(contentEl)
      .setName("文档模板")
      .setDesc("必填，选择已有的模板文件（.md 文件），支持自动补全");
    
    const templateInput = templateSetting.controlEl.createEl("input", {
      type: "text",
      placeholder: "输入或选择模板文件路径",
      cls: "rslatte-template-input"
    });
    templateInput.value = this.templatePath;
    templateInput.style.width = "100%";

    const applyTemplatePath = () => {
      this.templatePath = normalizePath(templateInput.value);
      this.validateTemplatePath();
      this.updateErrorDisplay();
    };

    // 使用文件路径自动补全；选择时通过 onSelect 同步写入并校验
    new FilePathSuggest(this.app, templateInput, (path) => {
      // 规范化路径并更新输入框和状态
      const normalized = normalizePath(path.trim());
      // 去掉前导斜杠
      const cleanPath = normalized.startsWith("/") ? normalized.substring(1) : normalized;
      templateInput.value = cleanPath;
      this.templatePath = cleanPath;
      this.validateTemplatePath();
      this.updateErrorDisplay();
    });

    templateInput.addEventListener("input", () => applyTemplatePath());

    // 存档目录（必填，使用 Obsidian 的文件夹路径自动补全）
    const archiveSetting = new Setting(contentEl)
      .setName("存档目录")
      .setDesc("必填，文档保存的目录路径（可以手动输入不存在的目录），支持自动补全");
    
    const archiveInput = archiveSetting.controlEl.createEl("input", {
      type: "text",
      placeholder: "输入或选择存档目录",
      cls: "rslatte-archive-input"
    });
    archiveInput.value = this.archiveDir;
    archiveInput.style.width = "100%";

    // 使用文件夹路径自动补全；选择时通过 onSelect 同步写入并校验
    new FolderPathSuggest(this.app, archiveInput, (path) => {
      // 规范化路径并更新输入框和状态
      const normalized = normalizePath(path.trim());
      // 去掉前导斜杠
      const cleanPath = normalized.startsWith("/") ? normalized.substring(1) : normalized;
      archiveInput.value = cleanPath;
      this.archiveDir = cleanPath;
      this.validateArchiveDir();
      this.updateErrorDisplay();
    });

    archiveInput.addEventListener("input", () => {
      this.archiveDir = normalizePath(archiveInput.value);
      this.validateArchiveDir();
      this.updateErrorDisplay();
    });

    // tags（必填，默认为output，可以通过","提供多个tags）
    new Setting(contentEl)
      .setName("tags")
      .setDesc("必填，多个标签用逗号分隔，默认为 output（如果没有写 output，存档时会自动加上 output）")
      .addText((text) => {
        text.setPlaceholder("output")
          .setValue(this.tags)
          .onChange((v) => {
            this.tags = (v ?? "").trim();
            this.validateTags();
            this.updateErrorDisplay();
          });
      });

    // type（必填，默认为空字符串，不能写清单中已经存在的type）
    new Setting(contentEl)
      .setName("type")
      .setDesc("必填，自定义类型（可以为空字符串，但不能与已有模板的 type 重复）")
      .addText((text) => {
        text.setPlaceholder("请输入 type（可以为空）")
          .setValue(this.type)
          .onChange((v) => {
            this.type = (v ?? "").trim();
            this.validateType();
            this.updateErrorDisplay();
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
      if (this.validateAll()) {
        await this.save();
      }
    });

    this.updateErrorDisplay = () => {
      const allErrors = [
        this.buttonNameError,
        this.docCategoryError,
        this.templatePathError,
        this.archiveDirError,
        this.tagsError,
        this.typeError
      ].filter(Boolean);
      
      if (allErrors.length > 0) {
        errorEl.textContent = allErrors.join("；");
        errorEl.style.display = "block";
        saveBtn.disabled = true;
      } else {
        errorEl.style.display = "none";
        const isValid = this.buttonName && this.docCategory && this.templatePath && 
                       this.archiveDir && this.tags;
        saveBtn.disabled = !isValid;
      }
    };
  }

  private generateId(): string {
    // 生成类似 OT_XXXXXX 的ID
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let id = "OT_";
    for (let i = 0; i < 6; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id;
  }

  private validateButtonName(): boolean {
    this.buttonNameError = "";
    
    if (!this.buttonName) {
      this.buttonNameError = "按钮名称不能为空";
      return false;
    }

    // 检查是否与已有按钮名称重复
    const op = this.plugin.settings.outputPanel || ({} as any);
    const templates = (op.templates || []) as OutputTemplateDef[];
    const duplicate = templates.some(tpl => 
      tpl.buttonName.trim().toLowerCase() === this.buttonName.toLowerCase()
    );

    if (duplicate) {
      this.buttonNameError = "该按钮名称已存在，请使用其他按钮名称";
      return false;
    }

    return true;
  }

  private validateDocCategory(): boolean {
    this.docCategoryError = "";
    
    if (!this.docCategory) {
      this.docCategoryError = "文档分类不能为空";
      return false;
    }

    return true;
  }

  private validateTemplatePath(): boolean {
    this.templatePathError = "";
    
    if (!this.templatePath) {
      this.templatePathError = "文档模板不能为空";
      return false;
    }

    // 检查文件是否存在
    let normalized = normalizePath(this.templatePath.trim());
    // 去掉前导斜杠（Obsidian 路径不应以 / 开头）
    if (normalized.startsWith("/")) {
      normalized = normalized.substring(1);
    }

    const candidates: string[] = [normalized];
    // 如果没有 .md 扩展名，添加它
    if (!/\.md$/i.test(normalized)) {
      candidates.push(normalized + ".md");
    }

    let exists = false;
    let foundPath = "";
    for (const path of candidates) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file && file instanceof TFile) {
        exists = true;
        foundPath = path;
        break;
      }
    }

    if (!exists) {
      // 如果还是找不到，尝试在所有 markdown 文件中搜索（处理路径不匹配的情况）
      const allFiles = this.app.vault.getMarkdownFiles();
      const searchName = normalized.split("/").pop()?.replace(/\.md$/i, "") || "";
      if (searchName) {
        const matched = allFiles.find(f => {
          const fileName = f.basename.toLowerCase();
          const pathLower = f.path.toLowerCase();
          return fileName === searchName.toLowerCase() || 
                 pathLower.includes(searchName.toLowerCase());
        });
        if (matched) {
          exists = true;
          foundPath = matched.path;
          // 更新 templatePath 为实际找到的路径
          this.templatePath = matched.path;
        }
      }
    }

    if (!exists) {
      this.templatePathError = "模板文件不存在，请选择已有的文件";
      return false;
    }

    // 如果找到了文件但路径不同，更新 templatePath
    if (foundPath && foundPath !== normalized && foundPath !== this.templatePath) {
      this.templatePath = foundPath;
    }

    return true;
  }

  private validateArchiveDir(): boolean {
    this.archiveDirError = "";
    
    if (!this.archiveDir) {
      this.archiveDirError = "存档目录不能为空";
      return false;
    }

    return true;
  }

  private validateTags(): boolean {
    this.tagsError = "";
    
    if (!this.tags) {
      this.tagsError = "tags 不能为空";
      return false;
    }

    return true;
  }

  private validateType(): boolean {
    this.typeError = "";
    
    // type 可以为空字符串，但不能是 undefined 或 null
    // 由于我们在 onChange 中已经 trim，这里 this.type 应该是字符串
    // 检查是否与已有的 type 重复（空字符串不检查重复）
    if (this.type && this.existingTypes.has(this.type)) {
      this.typeError = "该 type 已存在，请使用其他 type";
      return false;
    }

    return true;
  }

  private validateAll(): boolean {
    const buttonNameValid = this.validateButtonName();
    const docCategoryValid = this.validateDocCategory();
    const templatePathValid = this.validateTemplatePath();
    const archiveDirValid = this.validateArchiveDir();
    const tagsValid = this.validateTags();
    const typeValid = this.validateType();
    
    return buttonNameValid && docCategoryValid && templatePathValid && 
           archiveDirValid && tagsValid && typeValid;
  }

  private updateErrorDisplay: () => void = () => {};

  private async save() {
    try {
      // 解析 tags（逗号分隔）
      const tagsArray = this.tags
        .split(/[,，]+/)
        .map(t => t.trim())
        .filter(Boolean);
      
      // 确保包含 output
      if (!tagsArray.includes("output")) {
        tagsArray.push("output");
      }

      const newTemplate: OutputTemplateDef = {
        id: this.newId,
        buttonName: this.buttonName,
        docCategory: this.docCategory,
        templatePath: normalizePath(this.templatePath),
        archiveDir: normalizePath(this.archiveDir),
        tags: tagsArray,
        type: this.type,
      };

      const op = this.plugin.settings.outputPanel || ({} as any);
      if (!op.templates) {
        op.templates = [];
      }
      if (!this.plugin.settings.outputPanel) {
        this.plugin.settings.outputPanel = op;
      }

      op.templates.push(newTemplate);
      await this.plugin.saveSettings();

      new Notice(`输出文档模板"${this.buttonName}"已添加`);
      this.close();

      // 刷新侧边栏
      const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_OUTPUTS)[0]?.view as any;
      if (view && typeof view.render === "function") {
        await view.render();
      }
    } catch (e) {
      new Notice(`保存失败：${e instanceof Error ? e.message : String(e)}`);
      console.error("[RSLatte] Failed to add output template:", e);
    }
  }
}
