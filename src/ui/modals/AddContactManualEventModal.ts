import { App, ButtonComponent, Modal, Notice, Setting, TextAreaComponent, TFile } from "obsidian";
import type RSLattePlugin from "../../main";
import type { ContactIndexItem } from "../../contactsRSLatte/types";
import { appendManualContactEvent } from "../../services/contacts/contactNoteWriter";

export class AddContactManualEventModal extends Modal {
  private inFlight = false;

  constructor(
    app: App,
    private plugin: RSLattePlugin,
    private contact: ContactIndexItem,
    private contactFilePath: string,
    private opts?: { onSaved?: () => void }
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    const name = String(this.contact.display_name ?? this.contact.contact_uid ?? "").trim();
    this.titleEl.setText(name ? `记互动：${name}` : "记互动");

    let text = "";
    let textInput!: TextAreaComponent;
    let saveBtn!: ButtonComponent;

    const refresh = () => {
      const ok = (text ?? "").trim().length > 0 && !this.inFlight;
      saveBtn?.setDisabled(!ok);
      return ok;
    };

    const doSave = async () => {
      if (this.inFlight) return;
      if ((text ?? "").trim().length === 0) {
        new Notice("请输入互动内容");
        return;
      }

      const af = this.app.vault.getAbstractFileByPath(this.contactFilePath);
      if (!(af instanceof TFile)) {
        new Notice("联系人文件不存在，无法写入");
        return;
      }

      this.inFlight = true;
      refresh();

      try {
        const sAny: any = this.plugin.settings as any;
        const cm: any = sAny?.contactsModule ?? {};
        const sectionHeader = String(cm.eventSectionHeader ?? cm.manualEventSectionHeader ?? "## 互动记录").trim() || "## 互动记录";
        const subHeader = String(cm.manualEventSubHeader ?? "### 手动互动").trim();

        await appendManualContactEvent(this.app, af, text, {
          sectionHeader,
          subHeader,
        });

        new Notice("已写入互动记录");
        try {
          this.opts?.onSaved?.();
        } catch {
          // ignore
        }
        this.close();
      } catch (e: any) {
        console.warn("[RSLatte][contacts][manualEvent] write failed", e);
        new Notice(`写入失败：${String(e?.message ?? e).slice(0, 120)}`);
      } finally {
        this.inFlight = false;
        refresh();
      }
    };

    new Setting(contentEl)
      .setName("互动内容*")
      .setDesc("将追加到联系人笔记的指定章节下")
      .addTextArea((t) => {
        textInput = t;
        t.setPlaceholder("例如：约了下周三 14:00 讨论需求");
        t.inputEl.rows = 4;
        t.inputEl.style.whiteSpace = "pre-wrap";
        t.onChange((v) => {
          text = String(v ?? "");
          refresh();
        });
        t.inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
            ev.preventDefault();
            void doSave();
          }
        });
      });

    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });

    const cancelBtn = new ButtonComponent(btnRow);
    cancelBtn.setButtonText("取消");
    cancelBtn.onClick(() => this.close());

    saveBtn = new ButtonComponent(btnRow);
    saveBtn.setCta();
    saveBtn.setButtonText("保存");
    saveBtn.onClick(() => void doSave());

    refresh();

    // focus textarea for better UX
    setTimeout(() => {
      try { textInput?.inputEl?.focus(); } catch {}
    }, 50);
  }
}
