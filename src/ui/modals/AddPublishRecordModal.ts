import { App, ButtonComponent, Modal, Notice, Setting, SuggestModal, TextComponent, TFile } from "obsidian";
import type RSLattePlugin from "../../main";

function todayYmd(): string {
  try {
    // @ts-ignore
    const m = (window as any).moment?.();
    if (m?.format) return m.format("YYYY-MM-DD");
  } catch {}
  const d = new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

class FilePathSuggestModal extends SuggestModal<string> {
  constructor(app: App, private onSelect: (path: string) => void) {
    super(app);
  }

  getSuggestions(query: string): string[] {
    const allFiles = this.app.vault.getMarkdownFiles();
    const queryLower = query.toLowerCase();
    return allFiles
      .map(f => f.path)
      .filter(path => path.toLowerCase().includes(queryLower))
      .slice(0, 50);
  }

  renderSuggestion(path: string, el: HTMLElement) {
    el.setText(path);
  }

  onChooseSuggestion(path: string, _evt: MouseEvent | KeyboardEvent) {
    this.onSelect(path);
  }
}

export class AddPublishRecordModal extends Modal {
  constructor(
    app: App,
    private plugin: RSLattePlugin,
    private filePath: string
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    this.titleEl.setText("新增发布记录");

    const settings = this.plugin.settings.publishPanel || ({} as any);
    const channels = (settings.publishChannels ?? []) as string[];

    let channel = channels.length > 0 ? channels[0] : "";
    let publishDate = todayYmd();
    let relatedDocPath = "";
    let note = "";

    let publishDateInput!: TextComponent;
    let saveBtn!: ButtonComponent;

    const refresh = () => {
      const ok = channel.trim().length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(publishDate);
      saveBtn?.setDisabled(!ok);
      publishDateInput?.inputEl?.classList.toggle("is-invalid", !/^\d{4}-\d{2}-\d{2}$/.test(publishDate));
      return ok;
    };

    // 发布通道
    new Setting(contentEl)
      .setName("发布通道*")
      .setDesc(channels.length === 0 ? "请先在设置中配置发布通道选项（发布管理 → 发布通道选项）" : "必填，选择发布通道")
      .addDropdown((d) => {
        d.addOption("", channels.length === 0 ? "（未配置）" : "请选择");
        for (const ch of channels) {
          d.addOption(ch, ch);
        }
        if (channels.length > 0) {
          d.setValue(channel);
        }
        d.onChange((v) => {
          channel = v;
          refresh();
        });
      });

    // 发布时间
    new Setting(contentEl)
      .setName("发布时间*")
      .setDesc("必填，日期格式：YYYY-MM-DD")
      .addText((t) => {
        publishDateInput = t;
        t.setPlaceholder("YYYY-MM-DD");
        t.setValue(publishDate);
        t.inputEl.type = "date";
        t.onChange((v) => {
          publishDate = v ?? "";
          refresh();
        });
        t.inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            void doSave();
          }
        });
      });

    // 发布文档关联
    new Setting(contentEl)
      .setName("发布文档关联")
      .setDesc("可选，记录发布时去掉敏感信息的文档存档位置，支持手动输入和自动补全")
      .addText((t) => {
        t.setPlaceholder("输入或选择文档路径");
        t.setValue(relatedDocPath);
        t.onChange((v) => {
          relatedDocPath = v ?? "";
        });
        // 添加自动补全按钮
        const inputContainer = t.inputEl.parentElement;
        if (inputContainer) {
          const autocompleteBtn = inputContainer.createEl("button", {
            text: "🔍",
            cls: "rslatte-autocomplete-btn"
          });
          autocompleteBtn.title = "选择文件";
          autocompleteBtn.onclick = () => {
            new FilePathSuggestModal(this.app, (path) => {
              relatedDocPath = path;
              t.setValue(path);
            }).open();
          };
        }
      });

    // 发布说明
    new Setting(contentEl)
      .setName("发布说明")
      .setDesc("可选，发布记录的备注信息")
      .addTextArea((t) => {
        t.setPlaceholder("(可选) 发布说明");
        t.setValue(note);
        t.onChange((v) => {
          note = v ?? "";
        });
        t.inputEl.rows = 3;
      });

    const btnRow = new Setting(contentEl);

    btnRow.addButton((btn) => {
      btn.setButtonText("取消");
      btn.onClick(() => this.close());
    });

    btnRow.addButton((btn) => {
      saveBtn = btn;
      btn.setButtonText("保存");
      btn.setCta();
      btn.onClick(() => void doSave());
    });

    const doSave = async () => {
      if (!refresh()) {
        new Notice("请填写必填项");
        return;
      }

      try {
        const af = this.app.vault.getAbstractFileByPath(this.filePath);
        if (!(af instanceof TFile)) {
          new Notice("未找到文件：" + this.filePath);
          return;
        }

        // 读取文件内容
        const content = await this.app.vault.read(af);
        
        // 构建发布记录（可读的markdown格式）
        // 格式：📣 ${channel} | ${publishDate} | ${note} | 📎 ${relatedDocPath}
        // 在 rslatte 注释中保存完整信息用于解析
        const nowIso = new Date().toISOString();
        const recordParts: string[] = [`📣 ${channel}`, publishDate];
        if (note) {
          recordParts.push(note);
        }
        if (relatedDocPath) {
          recordParts.push(`📎 ${relatedDocPath}`);
        }
        const recordLine = recordParts.join(" | ");
        
        // 构建 rslatte 注释（用于解析）
        const params: string[] = [];
        params.push(`channel=${encodeURIComponent(channel)}`);
        params.push(`date=${publishDate}`);
        if (relatedDocPath) {
          params.push(`relatedDoc=${encodeURIComponent(relatedDocPath)}`);
        }
        if (note) {
          params.push(`note=${encodeURIComponent(note)}`);
        }
        params.push(`ts=${nowIso}`);
        const recordComment = `<!-- rslatte:publish:${params.join(";")} -->`;
        
        // 检查是否已有"发布信息清单"标题
        const publishSectionRegex = /^#\s+发布信息清单\s*$/m;
        const sectionMatch = content.match(publishSectionRegex);
        
        let newContent: string;
        if (sectionMatch) {
          // 如果已有标题，找到标题后的最后一个列表项位置，在其后追加
          const sectionIndex = content.indexOf(sectionMatch[0]);
          const afterSection = content.slice(sectionIndex + sectionMatch[0].length);
          
          // 查找最后一个列表项（以 - 开头，后面跟着 rslatte 注释）
          const listItemRegex = /^(\s*-\s+[^\n]+(?:\n\s+<!--[^>]+-->)?\s*)/gm;
          let lastMatch: RegExpExecArray | null = null;
          let match: RegExpExecArray | null;
          while ((match = listItemRegex.exec(afterSection)) !== null) {
            lastMatch = match;
          }
          
          if (lastMatch) {
            // 在最后一个列表项后追加
            const insertPos = sectionIndex + sectionMatch[0].length + lastMatch.index + lastMatch[0].length;
            newContent = content.slice(0, insertPos) + `- ${recordLine}\n  ${recordComment}\n` + content.slice(insertPos);
          } else {
            // 如果没有列表项，在标题后直接添加
            const insertPos = sectionIndex + sectionMatch[0].length;
            const afterTitle = content.slice(insertPos);
            const leadingNewlines = afterTitle.match(/^\s*\n*/)?.[0] || "\n\n";
            newContent = content.slice(0, insertPos) + leadingNewlines + `- ${recordLine}\n  ${recordComment}` + content.slice(insertPos + leadingNewlines.length);
          }
        } else {
          // 如果没有标题，在文件末尾添加标题和记录
          newContent = content.trim() + "\n\n# 发布信息清单\n\n- " + recordLine + "\n  " + recordComment;
        }
        
        await this.app.vault.modify(af, newContent);

        // 如果有关联文档，更新关联文档的发布类型属性
        if (relatedDocPath) {
          try {
            const relatedFile = this.app.vault.getAbstractFileByPath(relatedDocPath);
            if (relatedFile instanceof TFile) {
              await this.app.fileManager.processFrontMatter(relatedFile, (fm) => {
                (fm as any)["发布类型"] = channel;
              });
            }
          } catch (e) {
            console.warn("更新关联文档发布类型失败", e);
          }
        }

        // 等待缓存更新后更新索引
        await new Promise((resolve) => setTimeout(resolve, 100));
        await this.plugin.publishRSLatte?.upsertFile(af);

        new Notice("发布记录已添加");
        this.close();
        
        // 刷新侧边栏
        this.plugin.refreshSidePanel();
      } catch (e: any) {
        new Notice(`保存失败：${e?.message ?? String(e)}`);
        console.error("AddPublishRecordModal save failed", e);
      }
    };

    refresh();
  }
}
