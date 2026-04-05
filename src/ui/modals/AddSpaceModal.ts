import { ButtonComponent, Modal, TextComponent, Notice, normalizePath, type App } from "obsidian";
import type RSLattePlugin from "../../main";
import { validateDefaultRootSuffix } from "../../services/space/spaceDirectoryDefaults";

export interface AddSpaceResult {
  name: string;
  /** 完整默认根目录，如 20-Work */
  defaultRootDir: string;
}

export interface AddSpaceModalOptions {
  /** 如 "20-"，由空间编号生成；用户只填后缀 */
  rootPrefix: string;
}

/** 新增空间 Modal：输入空间名称；默认根目录为「固定前缀 + 用户后缀」 */
export class AddSpaceModal extends Modal {
  private result: AddSpaceResult | null = null;
  private resolveCallback: ((result: AddSpaceResult | null) => void) | null = null;

  constructor(
    app: App,
    private plugin: RSLattePlugin,
    private defaultName?: string,
    private opts?: AddSpaceModalOptions,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("新增空间");

    const prefix = String(this.opts?.rootPrefix ?? "").trim();
    const usePrefix = !!prefix;

    contentEl.createEl("p", {
      text: usePrefix
        ? "请输入空间名称与默认根目录后缀。前缀由空间编号自动生成，无需手写；系统将基于完整默认根目录自动生成各模块的默认目录配置。"
        : "请输入空间名称和默认根目录。系统将根据默认根目录自动生成各模块的默认目录配置。",
    });

    const nameContainer = contentEl.createDiv();
    nameContainer.createEl("label", {
      text: "空间名称",
      attr: { style: "display: block; margin-bottom: 4px; font-weight: 600;" },
    });
    const nameInput = new TextComponent(nameContainer);
    nameInput.setPlaceholder("空间名称");
    nameInput.setValue(this.defaultName ?? "");
    nameInput.inputEl.style.width = "100%";
    nameInput.inputEl.style.marginBottom = "12px";

    const rootDirContainer = contentEl.createDiv();
    rootDirContainer.createEl("label", {
      text: usePrefix ? "默认根目录（前缀 + 后缀）" : "默认根目录",
      attr: { style: "display: block; margin-top: 12px; margin-bottom: 4px; font-weight: 600;" },
    });
    rootDirContainer.createEl("p", {
      text: usePrefix
        ? `前缀已固定为「${prefix}」；请填写后缀，例如 Work，完整路径将为 ${prefix}Work`
        : "例如：06-Work。系统将基于此目录生成各模块的默认路径。",
      attr: { style: "margin: 0 0 8px 0; font-size: 12px; color: var(--text-muted);" },
    });

    let rootDirInput: TextComponent;
    if (usePrefix) {
      const row = rootDirContainer.createDiv({ attr: { style: "display: flex; align-items: center; gap: 6px; flex-wrap: wrap;" } });
      row.createSpan({ text: prefix, cls: "rslatte-muted", attr: { style: "font-weight: 600; white-space: nowrap;" } });
      rootDirInput = new TextComponent(row);
      rootDirInput.setPlaceholder("例如：Work");
      rootDirInput.inputEl.style.flex = "1";
      rootDirInput.inputEl.style.minWidth = "120px";
    } else {
      rootDirInput = new TextComponent(rootDirContainer);
      rootDirInput.setPlaceholder("例如：06-Work");
      rootDirInput.inputEl.style.width = "100%";
    }
    rootDirInput.inputEl.style.marginBottom = "12px";

    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions", attr: { style: "margin-top: 16px;" } });

    new ButtonComponent(btnRow)
      .setButtonText("取消")
      .onClick(() => {
        this.result = null;
        this.close();
      });

    new ButtonComponent(btnRow)
      .setButtonText("确认")
      .setCta()
      .onClick(() => {
        const name = nameInput.getValue()?.trim() || "";
        if (!name) {
          new Notice("请输入空间名称");
          return;
        }

        let defaultRootDir = "";
        if (usePrefix) {
          const suf = validateDefaultRootSuffix(rootDirInput.getValue() ?? "");
          if (!suf.ok) {
            new Notice(suf.message);
            return;
          }
          defaultRootDir = normalizePath(`${prefix}${suf.value}`);
        } else {
          const raw = rootDirInput.getValue()?.trim() || "";
          if (!raw) {
            new Notice("请输入默认根目录");
            return;
          }
          defaultRootDir = normalizePath(raw);
        }

        this.result = { name, defaultRootDir };
        this.close();
      });
  }

  onClose() {
    this.contentEl.empty();
    if (this.resolveCallback) {
      this.resolveCallback(this.result);
      this.resolveCallback = null;
    }
  }

  /** 返回 Promise，等待用户输入 */
  async waitForResult(): Promise<AddSpaceResult | null> {
    return new Promise((resolve) => {
      this.resolveCallback = resolve;
      this.open();
    });
  }
}
