import { App, ButtonComponent, Modal, Notice, Setting, TextAreaComponent, TFile } from "obsidian";
import { normalizePath } from "obsidian";
import type RSLattePlugin from "../../main";
import type { ContactIndexItem } from "../../contactsRSLatte/types";
import { appendManualContactEvent } from "../../services/contacts/contactNoteWriter";
import { appendManualContactToInteractionsIndex, updateContactLastInteractionAtIfNewer } from "../../services/contacts/manualContactInteractionIndex";
import { writeContactsInteractionReplicaSnapshot } from "../../services/contacts/contactsInteractionReplica";
import { bumpManualNewToday, ensureContactsInteractionRollup } from "../../services/contacts/contactInteractionDisplay";
import { VIEW_TYPE_CAPTURE } from "../../constants/viewTypes";

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
    let dtInput!: HTMLInputElement;

    const refresh = () => {
      const ok = (text ?? "").trim().length > 0 && !this.inFlight;
      saveBtn?.setDisabled(!ok);
      return ok;
    };

    const openCaptureHint = () => {
      try {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CAPTURE);
        if (leaves.length > 0) {
          void this.app.workspace.revealLeaf(leaves[0]);
        } else {
          void this.app.workspace.getLeaf(true).setViewState({ type: VIEW_TYPE_CAPTURE, active: true });
        }
      } catch {
        // ignore
      }
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

      const rawDt = String(dtInput?.value ?? "").trim();
      if (!rawDt) {
        new Notice("请选择互动日期与时间");
        return;
      }
      const picked = new Date(rawDt);
      if (Number.isNaN(picked.getTime())) {
        new Notice("日期时间无效");
        return;
      }
      if (picked.getTime() > Date.now() + 60 * 1000) {
        new Notice("不能记录未来时间的互动；请使用 Capture 记录待办。");
        openCaptureHint();
        return;
      }

      this.inFlight = true;
      refresh();

      try {
        const sAny: any = this.plugin.settings as any;
        const cm: any = sAny?.contactsModule ?? {};
        const tp = sAny?.taskPanel;
        ensureContactsInteractionRollup(cm, tp);
        if (!cm.contactsInteractionFirstEnabledAt) {
          cm.contactsInteractionFirstEnabledAt = new Date().toISOString();
        }

        const sectionHeader = String(cm.eventSectionHeader ?? cm.manualEventSectionHeader ?? "## 互动记录").trim() || "## 互动记录";
        const subHeader = String(cm.manualEventSubHeader ?? "### 手动互动").trim();

        const occurredIso = picked.toISOString();

        await appendManualContactEvent(this.app, af, text, {
          sectionHeader,
          subHeader,
          occurredAt: picked,
        });

        await appendManualContactToInteractionsIndex(this.plugin, {
          contactUid: String(this.contact.contact_uid ?? "").trim(),
          contactFilePath: this.contactFilePath,
          snippet: text,
          occurredAtIso: occurredIso,
        });

        await updateContactLastInteractionAtIfNewer(this.app, af, occurredIso);

        bumpManualNewToday(cm, String(this.contact.contact_uid ?? ""));
        sAny.contactsModule = cm;
        await this.plugin.saveSettings();

        const contactsDir = normalizePath(String(cm.contactsDir ?? "90-Contacts").trim() || "90-Contacts");
        await writeContactsInteractionReplicaSnapshot(this.app, {
          contactsDir,
          contactUid: String(this.contact.contact_uid ?? "").trim(),
          getInteractionsStore: () => this.plugin.contactsIndex.getInteractionsStore(),
        });

        try {
          const r = await this.plugin.rebuildContactsIndex();
          if (!(r as any)?.ok) {
            console.warn("[RSLatte][contacts][manualEvent] rebuildContactsIndex not ok", r);
          }
        } catch (e) {
          console.warn("[RSLatte][contacts][manualEvent] rebuildContactsIndex failed", e);
        }

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

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const defaultLocal = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;

    new Setting(contentEl)
      .setName("互动时间")
      .setDesc("默认当前；禁止未来时间（请用 Capture）")
      .addText((t) => {
        const el = t.inputEl;
        el.type = "datetime-local";
        el.classList.add("rslatte-contact-manual-datetime");
        el.value = defaultLocal;
        dtInput = el;
      });

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

    setTimeout(() => {
      try {
        textInput?.inputEl?.focus();
      } catch {}
    }, 50);
  }
}
