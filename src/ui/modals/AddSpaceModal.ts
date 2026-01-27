import { ButtonComponent, Modal, TextComponent, Notice, type App } from "obsidian";
import type RSLattePlugin from "../../main";

export interface AddSpaceResult {
  name: string;
  defaultRootDir: string;
}

/** 新增空间 Modal：输入空间名称和默认根目录 */
export class AddSpaceModal extends Modal {
  private result: AddSpaceResult | null = null;
  private resolveCallback: ((result: AddSpaceResult | null) => void) | null = null;

  constructor(
    app: App,
    private plugin: RSLattePlugin,
    private defaultName?: string,
    private defaultRootDir?: string
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("新增空间");

    contentEl.createEl("p", {
      text: "请输入空间名称和默认根目录。系统将根据默认根目录自动生成各模块的默认目录配置。",
    });

    const nameContainer = contentEl.createDiv();
    nameContainer.createEl("label", {
      text: "空间名称",
      attr: { style: "display: block; margin-bottom: 4px; font-weight: 600;" }
    });
    const nameInput = new TextComponent(nameContainer);
    nameInput.setPlaceholder("空间名称");
    nameInput.setValue(this.defaultName ?? "");
    nameInput.inputEl.style.width = "100%";
    nameInput.inputEl.style.marginBottom = "12px";

    const rootDirContainer = contentEl.createDiv();
    rootDirContainer.createEl("label", {
      text: "默认根目录",
      attr: { style: "display: block; margin-top: 12px; margin-bottom: 4px; font-weight: 600;" }
    });
    rootDirContainer.createEl("p", {
      text: "例如：06-Work。系统将基于此目录生成各模块的默认路径。",
      attr: { style: "margin: 0 0 8px 0; font-size: 12px; color: var(--text-muted);" }
    });
    const rootDirInput = new TextComponent(rootDirContainer);
    rootDirInput.setPlaceholder("例如：06-Work");
    rootDirInput.setValue(this.defaultRootDir ?? "");
    rootDirInput.inputEl.style.width = "100%";
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
        const rootDir = rootDirInput.getValue()?.trim() || "";
        
        if (!name) {
          new Notice("请输入空间名称");
          return;
        }
        if (!rootDir) {
          new Notice("请输入默认根目录");
          return;
        }

        this.result = { name, defaultRootDir: rootDir };
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
