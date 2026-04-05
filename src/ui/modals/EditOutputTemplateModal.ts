import { App, Modal, Notice, Setting, normalizePath, TFile } from "obsidian";
import type RSLattePlugin from "../../main";
import type { OutputTemplateDef } from "../../types/outputTypes";

/**
 * 编辑输出模板条目（由模板清单的「编辑」按钮打开）
 */
export class EditOutputTemplateModal extends Modal {
  private draft!: OutputTemplateDef;
  private readonly outputRootRel: string;
  private readonly templateRootRel: string;

  private buttonNameError = "";
  private docCategoryError = "";
  private templatePathError = "";
  private archiveDirError = "";
  private typeError = "";
  private projectTargetRelPathError = "";

  private updateErrorDisplay: () => void = () => {};

  constructor(
    app: App,
    private plugin: RSLattePlugin,
    private readonly rowIndex: number,
    private readonly onSaved?: () => Promise<void>
  ) {
    super(app);
    const roots = (((this.plugin.settings.outputPanel as any)?.archiveRoots ?? []) as string[])
      .map((s) => normalizePath(String(s ?? "").trim()))
      .filter(Boolean);
    this.outputRootRel = roots[0] ?? "00-Inbox";
    this.templateRootRel = "00-System/01-Templates";
  }

  onOpen(): void {
    const templates = ((this.plugin.settings.outputPanel as any)?.templates ?? []) as OutputTemplateDef[];
    const src = templates[this.rowIndex];
    if (!src) {
      new Notice("未找到要编辑的模板条目");
      this.close();
      return;
    }
    this.draft = {
      ...src,
      tags: Array.isArray(src.tags) ? [...src.tags] : [],
    };
    const ar = normalizePath(String(this.draft.archiveDir ?? "").trim());
    const rootPrefix = `${this.outputRootRel}/`;
    this.draft.archiveDir = ar === this.outputRootRel ? "" : ar.startsWith(rootPrefix) ? ar.slice(rootPrefix.length) : ar;
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("编辑输出模板");

    new Setting(contentEl)
      .setName("ID")
      .setDesc("模板唯一标识（只读）")
      .addText((text) => {
        text.setValue(String(this.draft.id ?? ""));
        text.inputEl.disabled = true;
      });

    new Setting(contentEl)
      .setName("按钮名称")
      .setDesc("必填")
      .addText((text) => {
        text.setValue(String(this.draft.buttonName ?? ""));
        text.onChange((v) => {
          this.draft.buttonName = String(v ?? "").trim();
          this.validateButtonName();
          this.updateErrorDisplay();
        });
      });

    new Setting(contentEl)
      .setName("文档分类")
      .setDesc("必填")
      .addText((text) => {
        text.setValue(String(this.draft.docCategory ?? ""));
        text.onChange((v) => {
          this.draft.docCategory = String(v ?? "").trim();
          this.validateDocCategory();
          this.updateErrorDisplay();
        });
      });

    new Setting(contentEl)
      .setName("文档模板")
      .setDesc(`必填，仅允许 ${this.templateRootRel} 下的 md 文件`)
      .addText((text) => {
        text.setValue(String(this.draft.templatePath ?? ""));
        text.onChange((v) => {
          this.draft.templatePath = normalizePath(String(v ?? "").trim());
          this.validateTemplatePath();
          this.updateErrorDisplay();
        });
      });

    new Setting(contentEl)
      .setName("存档目录")
      .setDesc(`填写输出目录下的子目录（不需要写 ${this.outputRootRel}）；最终路径为 ${this.outputRootRel}/你填写的目录`)
      .addText((text) => {
        text.setValue(String(this.draft.archiveDir ?? ""));
        text.onChange((v) => {
          const raw = normalizePath(String(v ?? "").trim());
          const rootPrefix = `${this.outputRootRel}/`;
          this.draft.archiveDir = raw === this.outputRootRel ? "" : raw.startsWith(rootPrefix) ? raw.slice(rootPrefix.length) : raw;
          this.validateArchiveDir();
          this.updateErrorDisplay();
        });
      });

    new Setting(contentEl)
      .setName("type")
      .setDesc("可留空；非空时不可与其他模板重复")
      .addText((text) => {
        text.setValue(String(this.draft.type ?? ""));
        text.onChange((v) => {
          this.draft.type = String(v ?? "").trim();
          this.validateType();
          this.updateErrorDisplay();
        });
      });

    new Setting(contentEl)
      .setName("模板范围")
      .setDesc("一般：输出侧栏快速创建；项目：仅项目存档入口")
      .addDropdown((dd) => {
        dd.addOption("general", "一般");
        dd.addOption("project", "项目");
        dd.setValue(this.draft.templateScope === "project" ? "project" : "general");
        dd.onChange((v) => {
          this.draft.templateScope = v === "project" ? "project" : "general";
          this.validateProjectTargetRelPath();
          this.updateErrorDisplay();
        });
      });

    new Setting(contentEl)
      .setName("项目内路径")
      .setDesc("当模板范围为「项目」时建议填写")
      .addText((text) => {
        text.setValue(String(this.draft.projectTargetRelPath ?? ""));
        text.onChange((v) => {
          this.draft.projectTargetRelPath = normalizePath(String(v ?? "").trim()).replace(/^\/+|\/+$/g, "");
          this.validateProjectTargetRelPath();
          this.updateErrorDisplay();
        });
      });

    new Setting(contentEl)
      .setName("启用")
      .setDesc("关闭后不出现在创建入口")
      .addToggle((tg) => {
        tg.setValue(this.draft.enabled !== false);
        tg.onChange((v) => {
          this.draft.enabled = !!v;
        });
      });

    const errorEl = contentEl.createDiv({ cls: "rslatte-error-text" });
    errorEl.style.display = "none";
    errorEl.style.color = "var(--text-error)";
    errorEl.style.marginTop = "8px";

    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });
    btnRow.createEl("button", { text: "取消", cls: "mod-cta" }).onclick = () => this.close();
    const saveBtn = btnRow.createEl("button", { text: "保存", cls: "mod-cta" });
    saveBtn.onclick = async () => {
      if (!this.validateAll()) return;
      await this.save();
    };

    this.updateErrorDisplay = () => {
      const allErrors = [
        this.buttonNameError,
        this.docCategoryError,
        this.templatePathError,
        this.archiveDirError,
        this.typeError,
        this.projectTargetRelPathError,
      ].filter(Boolean);
      if (allErrors.length > 0) {
        errorEl.textContent = allErrors.join("；");
        errorEl.style.display = "block";
        saveBtn.disabled = true;
        return;
      }
      errorEl.style.display = "none";
      saveBtn.disabled = false;
    };

    this.validateAll();
    this.updateErrorDisplay();
  }

  private validateButtonName(): boolean {
    this.buttonNameError = "";
    if (!String(this.draft.buttonName ?? "").trim()) {
      this.buttonNameError = "按钮名称不能为空";
      return false;
    }
    const templates = (((this.plugin.settings.outputPanel as any)?.templates ?? []) as OutputTemplateDef[]).filter((_, i) => i !== this.rowIndex);
    const duplicate = templates.some((tpl) => String(tpl.buttonName ?? "").trim().toLowerCase() === String(this.draft.buttonName ?? "").trim().toLowerCase());
    if (duplicate) {
      this.buttonNameError = "该按钮名称已存在";
      return false;
    }
    return true;
  }

  private validateDocCategory(): boolean {
    this.docCategoryError = String(this.draft.docCategory ?? "").trim() ? "" : "文档分类不能为空";
    return !this.docCategoryError;
  }

  private validateTemplatePath(): boolean {
    this.templatePathError = "";
    const p = String(this.draft.templatePath ?? "").trim();
    if (!p) {
      this.templatePathError = "文档模板不能为空";
      return false;
    }
    const normalized = normalizePath(p);
    if (!(normalized === this.templateRootRel || normalized.startsWith(this.templateRootRel + "/"))) {
      this.templatePathError = `模板文件必须位于 ${this.templateRootRel} 下`;
      return false;
    }
    const candidates = [/\.md$/i.test(normalized) ? normalized : `${normalized}.md`, normalized];
    const exists = candidates.some((x) => this.app.vault.getAbstractFileByPath(x) instanceof TFile);
    if (!exists) {
      this.templatePathError = "模板文件不存在";
      return false;
    }
    return true;
  }

  private validateArchiveDir(): boolean {
    this.archiveDirError = "";
    return !this.archiveDirError;
  }

  private validateType(): boolean {
    this.typeError = "";
    const nextType = String(this.draft.type ?? "").trim();
    if (!nextType) return true;
    const templates = (((this.plugin.settings.outputPanel as any)?.templates ?? []) as OutputTemplateDef[]).filter((_, i) => i !== this.rowIndex);
    const duplicate = templates.some((tpl) => String(tpl.type ?? "").trim() === nextType);
    if (duplicate) {
      this.typeError = "该 type 已存在";
      return false;
    }
    return true;
  }

  private validateProjectTargetRelPath(): boolean {
    this.projectTargetRelPathError = "";
    if (this.draft.templateScope !== "project") return true;
    if (!String(this.draft.projectTargetRelPath ?? "").trim()) {
      this.projectTargetRelPathError = "项目模板必须填写项目内路径";
      return false;
    }
    return true;
  }

  private validateAll(): boolean {
    return (
      this.validateButtonName() &&
      this.validateDocCategory() &&
      this.validateTemplatePath() &&
      this.validateArchiveDir() &&
      this.validateType() &&
      this.validateProjectTargetRelPath()
    );
  }

  private async save(): Promise<void> {
    const op = (this.plugin.settings.outputPanel ?? {}) as any;
    const templates = (op.templates ?? []) as OutputTemplateDef[];
    if (!templates[this.rowIndex]) {
      new Notice("模板条目不存在，可能已被删除");
      return;
    }
    const relArchive = normalizePath(String(this.draft.archiveDir ?? "").trim());
    const fullArchive = relArchive ? normalizePath(`${this.outputRootRel}/${relArchive}`) : this.outputRootRel;
    templates[this.rowIndex] = {
      ...templates[this.rowIndex],
      ...this.draft,
      buttonName: String(this.draft.buttonName ?? "").trim(),
      docCategory: String(this.draft.docCategory ?? "").trim(),
      templatePath: normalizePath(String(this.draft.templatePath ?? "").trim()),
      archiveDir: fullArchive,
      tags: ["output"],
      type: String(this.draft.type ?? "").trim(),
      templateScope: this.draft.templateScope === "project" ? "project" : "general",
      enabled: this.draft.enabled !== false,
      projectTargetRelPath: normalizePath(String(this.draft.projectTargetRelPath ?? "").trim()).replace(/^\/+|\/+$/g, ""),
    };
    op.templates = templates;
    this.plugin.settings.outputPanel = op;
    await this.plugin.saveSettings();
    new Notice("模板已更新");
    await this.onSaved?.();
    this.close();
  }
}
