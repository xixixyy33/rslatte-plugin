import { App, ButtonComponent, Modal, Notice, Setting, TextAreaComponent } from "obsidian";

import type RSLattePlugin from "../../main";
import type { RSLatteIndexItem } from "../../taskRSLatte/types";

/**
 * Edit basic task fields (same as AddTaskModal):
 * - description
 * - due (required)
 * - start (optional)
 * - scheduled (optional)
 */
export class EditTaskModal extends Modal {
  constructor(app: App, private plugin: RSLattePlugin, private item: RSLatteIndexItem) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("修改任务");

    let text = String(this.item.text || this.item.raw || "").trim();
    let due = String((this.item as any).dueDate || "").trim();
    let start = String((this.item as any).startDate || "").trim();
    let scheduled = String((this.item as any).scheduledDate || "").trim();

    let textInput!: TextAreaComponent;
    let saveBtn!: ButtonComponent;

    const isValidYmd = (s: string) => !s || /^\d{4}-\d{2}-\d{2}$/.test(s);

    const refresh = () => {
      const dueOk = /^\d{4}-\d{2}-\d{2}$/.test((due ?? "").trim());
      const startOk = isValidYmd((start ?? "").trim());
      const scheduledOk = isValidYmd((scheduled ?? "").trim());

      const ok = (text ?? "").trim().length > 0 && dueOk && startOk && scheduledOk;
      saveBtn?.setDisabled(!ok);
      textInput?.inputEl?.classList.toggle("is-invalid", !(text ?? "").trim());
      return ok;
    };

    const descSetting = new Setting(contentEl)
      .setName("任务描述*")
      .addTextArea((t) => {
        textInput = t;
        t.setPlaceholder("例如：买牛奶");
        t.setValue(text);

        // 视觉上允许自动换行，但内容保持单行（禁止换行符）
        const ta = t.inputEl;
        ta.rows = 2;
        ta.style.width = "100%";
        ta.style.resize = "none";
        ta.style.whiteSpace = "pre-wrap";
        ta.style.overflowWrap = "anywhere";
        ta.style.wordBreak = "break-word";

        let inSanitize = false;
        const sanitizeAndResize = () => {
          if (inSanitize) return;
          inSanitize = true;
          try {
            const raw = t.getValue() ?? "";
            const single = raw.replace(/[\r\n]+/g, " ");
            if (single !== raw) {
              const pos = ta.selectionStart ?? single.length;
              t.setValue(single);
              try { ta.setSelectionRange(Math.max(0, pos - 1), Math.max(0, pos - 1)); } catch { }
            }
            text = single;
            ta.style.height = "auto";
            ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
          } finally {
            inSanitize = false;
          }
          refresh();
        };

        t.onChange(() => sanitizeAndResize());
        ta.addEventListener("input", () => sanitizeAndResize());
        ta.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            void doSave();
          }
        });
      });

    // 🪪 Insert contact reference (append to end)
    const insertRow = descSetting.controlEl.createDiv({ cls: "rslatte-inline-insert-row" });
    insertRow.style.display = "flex";
    insertRow.style.justifyContent = "flex-end";
    insertRow.style.marginTop = "6px";
    new ButtonComponent(insertRow)
      .setButtonText("🪪 插入联系人")
      .onClick(() => {
        void this.plugin.openContactReferencePicker((ref) => {
          try {
            const cur = textInput?.getValue?.() ?? "";
            const sep = cur && !/\s$/.test(cur) ? " " : "";
            const next = `${cur}${sep}${ref} `;
            textInput?.setValue?.(next);
            text = next;
            refresh();
            const ta = textInput?.inputEl;
            if (ta) {
              ta.focus();
              try { ta.setSelectionRange(next.length, next.length); } catch {}
            }
          } catch (e) {
            console.warn("[RSLatte][task][insertContact] failed", e);
            new Notice("插入联系人失败");
          }
        });
      });

    new Setting(contentEl)
      .setName("到期日期*")
      .addText((t) => {
        t.inputEl.type = "date";
        if (due) t.setValue(due);
        t.onChange((v) => {
          due = (v ?? "").trim();
          t.inputEl.classList.toggle("is-invalid", !/^\d{4}-\d{2}-\d{2}$/.test(due));
          refresh();
        });
        t.inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            void doSave();
          }
        });
      });

    new Setting(contentEl)
      .setName("开始日期")
      .addText((t) => {
        t.inputEl.type = "date";
        t.setValue(start || "");
        t.onChange((v) => {
          start = (v ?? "").trim();
          t.inputEl.classList.toggle("is-invalid", !isValidYmd(start));
          refresh();
        });
        t.inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            void doSave();
          }
        });
      });

    new Setting(contentEl)
      .setName("计划日期")
      .addText((t) => {
        t.inputEl.type = "date";
        t.setValue(scheduled || "");
        t.onChange((v) => {
          scheduled = (v ?? "").trim();
          t.inputEl.classList.toggle("is-invalid", !isValidYmd(scheduled));
          refresh();
        });
        t.inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            void doSave();
          }
        });
      });

    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });
    saveBtn = new ButtonComponent(btnRow).setButtonText("保存").setCta().onClick(() => void doSave());
    new ButtonComponent(btnRow).setButtonText("关闭").onClick(() => this.close());

    const doSave = async () => {
      if (!refresh()) return;
      try {
        await this.plugin.taskRSLatte.updateTaskBasicInfo(this.item as any, {
          text: (text ?? "").trim(),
          due: (due ?? "").trim(),
          start: (start ?? "").trim(),
          scheduled: (scheduled ?? "").trim(),
        });
        new Notice("已更新任务");
        await this.plugin.taskRSLatte.refreshIndexAndSync({
          // ✅ D3: DB sync 开关完全接管；URL 不可用时强制视为 OFF
          sync: (this.plugin.isTaskDbSyncEnabledV2?.() ?? (this.plugin.settings.taskPanel.enableDbSync !== false)),
          noticeOnError: true,
        });
        this.plugin.refreshSidePanel();
        this.close();
      } catch (e: any) {
        new Notice(`更新失败：${e?.message ?? String(e)}`);
      }
    };

    window.setTimeout(() => {
      textInput?.inputEl?.focus();
      refresh();
    }, 0);
  }
}
