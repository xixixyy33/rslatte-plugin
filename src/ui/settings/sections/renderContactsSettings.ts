// Auto-split from RSLatteSettingTab.ts to reduce file size and isolate failures.
import { ButtonComponent, Notice, Setting, ToggleComponent, TextComponent, normalizePath, moment } from "obsidian";
import { DEFAULT_SETTINGS } from "../../../constants/defaults";

export type ModuleWrapFactory = (moduleKey: any, title: string) => HTMLElement;
export type HeaderButtonsVisibilityAdder = (wrap: HTMLElement, moduleKey: any, defaultShow: boolean) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderContactsSettings(opts: {
  tab: any;
  makeModuleWrap: ModuleWrapFactory;
  addHeaderButtonsVisibilitySetting: HeaderButtonsVisibilityAdder;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addUiHeaderButtonsVisibilitySetting?: any;
}): void {
  const { tab, makeModuleWrap, addHeaderButtonsVisibilitySetting, addUiHeaderButtonsVisibilitySetting } = opts;
  const plugin = tab.plugin;
  const sAny = plugin?.settings as any;
  
  try {
    const contactsWrap = makeModuleWrap('contacts', '联系人管理');

    const cm = (tab.plugin.settings.contactsModule ?? (DEFAULT_SETTINGS as any).contactsModule) as any;
    tab.plugin.settings.contactsModule = cm;


    // UI：侧边栏标题按钮显示控制（➕始终展示，此处仅控制 🗄🧱🔄）
    addUiHeaderButtonsVisibilitySetting(contactsWrap, "contacts", true);


    // 辅助函数：检查并创建目录
    const checkAndCreateDir = async (dirPath: string): Promise<boolean> => {
      if (!dirPath || !dirPath.trim()) return false;
      try {
        const normalized = normalizePath(dirPath.trim());
        const exists = await plugin.app.vault.adapter.exists(normalized);
        if (exists) return true;
        
        // 创建目录（包括所有父目录）
        const parts = normalized.split("/").filter(Boolean);
        let current = "";
        for (const part of parts) {
          current = current ? `${current}/${part}` : part;
          const exists = await plugin.app.vault.adapter.exists(current);
          if (!exists) {
            await plugin.app.vault.createFolder(current);
          }
        }
        new Notice(`已创建目录：${normalized}`);
        return true;
      } catch (e: any) {
        new Notice(`创建目录失败：${e?.message ?? String(e)}`);
        return false;
      }
    };

    // 辅助函数：检查目录是否存在
    const checkDirExists = async (dirPath: string): Promise<boolean> => {
      if (!dirPath || !dirPath.trim()) return false;
      try {
        const normalized = normalizePath(dirPath.trim());
        return await plugin.app.vault.adapter.exists(normalized);
      } catch {
        return false;
      }
    };

    // 辅助函数：为目录配置添加检查和创建按钮
    const addDirCheckButton = (setting: Setting, dirPathGetter: () => string) => {
      const controlEl = setting.controlEl;
      const statusEl = controlEl.createDiv({ cls: "rslatte-dir-status" });
      statusEl.style.marginTop = "4px";
      statusEl.style.display = "flex";
      statusEl.style.alignItems = "center";
      statusEl.style.gap = "8px";
      
      const updateStatus = async () => {
        const dirPath = dirPathGetter();
        const exists = await checkDirExists(dirPath);
        const warningEl = statusEl.querySelector(".rslatte-dir-warning");
        const btnEl = statusEl.querySelector(".rslatte-dir-create-btn") as HTMLButtonElement;
        
        if (exists) {
          if (warningEl) warningEl.remove();
          if (btnEl) btnEl.style.display = "none";
        } else if (dirPath) {
          if (!warningEl) {
            const warn = statusEl.createDiv({ cls: "rslatte-dir-warning" });
            warn.style.color = "var(--text-error)";
            warn.style.fontSize = "12px";
            warn.textContent = "目录不存在";
            statusEl.insertBefore(warn, btnEl || null);
          }
          if (!btnEl) {
            const btn = statusEl.createEl("button", { cls: "rslatte-dir-create-btn", text: "创建目录" });
            btn.style.fontSize = "12px";
            btn.style.padding = "2px 8px";
            btn.onclick = async () => {
              btn.disabled = true;
              const success = await checkAndCreateDir(dirPathGetter());
              btn.disabled = false;
              if (success) {
                await updateStatus();
              }
            };
          } else {
            btnEl.style.display = "inline-block";
          }
        } else {
          if (warningEl) warningEl.remove();
          if (btnEl) btnEl.style.display = "none";
        }
      };
      
      void updateStatus();
      return updateStatus;
    };

    const contactsDirUpdate = addDirCheckButton(
      new Setting(contactsWrap)
        .setName("联系人目录（contactsDir）")
        .setDesc("联系人根目录（分组=子目录名）。示例：90-Contacts")
        .addText((t) => {
          t.setPlaceholder("90-Contacts");
          t.setValue(String(cm.contactsDir ?? "90-Contacts"));
          t.onChange(async (v) => {
            cm.contactsDir = normalizePath(String(v ?? "").trim()) || "90-Contacts";
            await tab.saveAndRefreshSidePanelDebounced();
            await contactsDirUpdate();
          });
        }),
      () => String(cm.contactsDir ?? "90-Contacts")
    );

    // 辅助函数：检查模板文件是否存在
    const checkTemplateExists = async (templatePath: string): Promise<boolean> => {
      if (!templatePath || !templatePath.trim()) return false;
      try {
        const normalized = normalizePath(templatePath.trim());
        return await plugin.app.vault.adapter.exists(normalized);
      } catch {
        return false;
      }
    };

    // 辅助函数：为模板配置添加存在性检查
    const addTemplateCheck = (setting: Setting, templatePathGetter: () => string) => {
      const controlEl = setting.controlEl;
      const statusEl = controlEl.createDiv({ cls: "rslatte-template-status" });
      statusEl.style.marginTop = "4px";
      statusEl.style.fontSize = "12px";
      
      const updateStatus = async () => {
        const templatePath = templatePathGetter();
        if (!templatePath || !templatePath.trim()) {
          statusEl.empty();
          return;
        }
        const exists = await checkTemplateExists(templatePath);
        statusEl.empty();
        if (!exists) {
          const warn = statusEl.createSpan({ cls: "rslatte-template-warning" });
          warn.style.color = "var(--text-error)";
          warn.textContent = "模板文件不存在";
        }
      };
      
      void updateStatus();
      return updateStatus;
    };

    const contactsTemplateUpdate = addTemplateCheck(
      new Setting(contactsWrap)
        .setName("模板路径（t_contact.md）")
        .setDesc("用于新增联系人时渲染生成 md（C4 实现）。")
        .addText((t) => {
          t.setPlaceholder("91-Templates/t_contact.md");
          t.setValue(String(cm.templatePath ?? "91-Templates/t_contact.md"));
          t.onChange(async (v) => {
            cm.templatePath = normalizePath(String(v ?? "").trim()) || "91-Templates/t_contact.md";
            await tab.saveAndRefreshSidePanelDebounced();
            await contactsTemplateUpdate();
          });
        }),
      () => String(cm.templatePath ?? "91-Templates/t_contact.md")
    );

    const defArc = normalizePath(`${String(cm.contactsDir ?? "90-Contacts")}/_archived`);
    const contactsArchiveDirUpdate = addDirCheckButton(
      new Setting(contactsWrap)
        .setName("联系人归档目录（archiveDir）")
        .setDesc("归档后的联系人会移动到该目录下，并保持 {group_name}/C_<uid>.md 的相对结构。留空则默认：{contactsDir}/_archived")
        .addText((t) => {
          const cur = normalizePath(String(cm.archiveDir ?? defArc));
          t.setPlaceholder(defArc);
          t.setValue(cur);
          t.onChange(async (v) => {
            const nv = normalizePath(String(v ?? "").trim());
            cm.archiveDir = nv || defArc;
            await tab.saveAndRefreshSidePanelDebounced();
            await contactsArchiveDirUpdate();
          });
        }),
      () => {
        const defArc = normalizePath(`${String(cm.contactsDir ?? "90-Contacts")}/_archived`);
        return normalizePath(String(cm.archiveDir ?? defArc));
      }
    );


    // Step 1：互动写入联系人 md 的目标章节/子标题（手动/动态共用）
    new Setting(contactsWrap)
      .setName("互动写入章节")
      .setDesc("点击『记互动』或写入『动态互动摘要』时，会把内容写入该章节下。默认：## 互动记录")
      .addText((t) => {
        t.setPlaceholder("## 互动记录");
        t.setValue(String(cm.eventSectionHeader ?? cm.manualEventSectionHeader ?? "## 互动记录"));
        t.onChange(async (v) => {
          cm.eventSectionHeader = String(v ?? "").trim() || "## 互动记录";
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });

    new Setting(contactsWrap)
      .setName("手动互动子标题")
      .setDesc("留空则直接写在章节下；默认：### 手动互动")
      .addText((t) => {
        t.setPlaceholder("### 手动互动");
        t.setValue(String(cm.manualEventSubHeader ?? "### 手动互动"));
        t.onChange(async (v) => {
          cm.manualEventSubHeader = String(v ?? "").trim();
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });

    new Setting(contactsWrap)
      .setName("动态互动子标题")
      .setDesc("动态引用聚合摘要写入的子标题；留空则直接写在章节下。默认：### 动态互动")
      .addText((t) => {
        t.setPlaceholder("### 动态互动");
        t.setValue(String(cm.dynamicEventSubHeader ?? "### 动态互动"));
        t.onChange(async (v) => {
          cm.dynamicEventSubHeader = String(v ?? "").trim();
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });

  } catch (e: any) {
    console.error("[RSLatte][settings][renderContactsSettings] render failed", e);
    try { new Notice("设置渲染失败（renderContactsSettings），请查看 Console"); } catch {}
  }
}
