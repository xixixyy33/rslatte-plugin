import { App, Modal } from "obsidian";

import type RSLattePlugin from "../../main";
import { mountOutputTemplatesSection } from "../outputTemplatesTable";
import { AddOutputTemplateModal } from "./AddOutputTemplateModal";

/**
 * 输出侧栏「管理模板」：与设置页共用 mountOutputTemplatesSection。
 */
export class ManageOutputTemplatesModal extends Modal {
  constructor(app: App, private plugin: RSLattePlugin) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("输出模板");
    this.remount();
  }

  private remount(): void {
    this.contentEl.empty();
    const wrap = this.contentEl.createDiv();
    const head = wrap.createDiv({ cls: "rslatte-modal-actions" });
    const addBtn = head.createEl("button", { text: "➕ 新增模板（表单）", cls: "mod-cta" });
    addBtn.onclick = () => {
      new AddOutputTemplateModal(this.app, this.plugin, async () => {
        this.remount();
      }).open();
    };

    mountOutputTemplatesSection(wrap, this.plugin, {
      afterFieldChange: async () => {
        await this.plugin.saveSettings();
        this.plugin.refreshSidePanel?.();
      },
      afterStructuralChange: async () => {
        this.remount();
      },
      showAddControl: false,
    });
  }
}
