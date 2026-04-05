// Auto-split from RSLatteSettingTab.ts to reduce file size and isolate failures.
import { ButtonComponent, Notice, Setting, ToggleComponent, TextComponent, normalizePath, moment } from "obsidian";
import { DEFAULT_SETTINGS } from "../../../constants/defaults";

export type ModuleWrapFactory = (moduleKey: any, title: string, scopeTag?: "global" | "space") => HTMLElement;
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

    new Setting(contactsWrap)
      .setName("分组目录黑名单（groupDirBlacklist）")
      .setDesc("用于分组建议与创建校验。逗号分隔，默认：templates, _archived")
      .addText((t) => {
        const cur = Array.isArray(cm.groupDirBlacklist) ? cm.groupDirBlacklist : ["templates", "_archived"];
        t.setPlaceholder("templates, _archived");
        t.setValue(cur.join(", "));
        t.onChange(async (v) => {
          const next = String(v ?? "")
            .split(/[,\n，]+/g)
            .map((x) => x.trim())
            .filter(Boolean);
          cm.groupDirBlacklist = next.length > 0 ? next : ["templates", "_archived"];
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });

    const defArc = normalizePath(`${String(cm.contactsDir ?? "90-Contacts")}/_archived`);
    const contactsArchiveDirUpdate = addDirCheckButton(
      new Setting(contactsWrap)
        .setName("联系人笔记归档目录（archiveDir）")
        .setDesc("「笔记归档」：已取消且过阈值的联系人 md 移动到该目录下，保持 {group_name}/C_<uid>.md 相对结构。留空默认 {contactsDir}/_archived。互动索引溢出分片属「索引归档」，见下方 §6.9。")
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
      .setDesc("动态引用聚合摘要写入该子标题下；留空则直接写在章节下。默认：### 动态互动（与侧栏「互动记录」页签展示分离）")
      .addText((t) => {
        t.setPlaceholder("### 动态互动");
        t.setValue(String(cm.dynamicEventSubHeader ?? "### 动态互动"));
        t.onChange(async (v) => {
          cm.dynamicEventSubHeader = String(v ?? "").trim();
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });

    new Setting(contactsWrap)
      .setName("超期未联系（自然日）")
      .setDesc("距「最后互动」日期超过该天数则名片区第三行显示超期。默认 30。")
      .addText((t) => {
        t.setPlaceholder("30");
        t.setValue(String(cm.contactFollowupOverdueDays ?? 30));
        t.onChange(async (v) => {
          const n = Math.floor(Number(String(v ?? "").trim()) || 30);
          cm.contactFollowupOverdueDays = Math.max(1, Math.min(3650, n));
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });

    new Setting(contactsWrap)
      .setName("主索引每联系人互动事件上限（全局）")
      .setDesc("第六章索引裁剪用；当前侧栏仍以主索引为准。默认 100。")
      .addText((t) => {
        t.setPlaceholder("100");
        t.setValue(String(cm.interactionEventsMaxPerContactInIndex ?? 100));
        t.onChange(async (v) => {
          const n = Math.floor(Number(String(v ?? "").trim()) || 100);
          cm.interactionEventsMaxPerContactInIndex = Math.max(10, Math.min(5000, n));
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });

    new Setting(contactsWrap)
      .setName("主索引每 source 上限（每联系人）")
      .setDesc("第六章索引裁剪用。默认 10。")
      .addText((t) => {
        t.setPlaceholder("10");
        t.setValue(String(cm.interactionEventsMaxPerSourcePerContact ?? 10));
        t.onChange(async (v) => {
          const n = Math.floor(Number(String(v ?? "").trim()) || 10);
          cm.interactionEventsMaxPerSourcePerContact = Math.max(1, Math.min(500, n));
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });

    new Setting(contactsWrap)
      .setName("互动索引归档 · 溢出分片最大字节（§6.9）")
      .setDesc("「索引归档」：主索引裁出窗口的事件写入 `.contacts/<uid>_NNN.json`；单文件达上限则写入下一片。与「笔记归档」移动联系人 md 不同。默认 1048576（1MB）。")
      .addText((t) => {
        t.setPlaceholder("1048576");
        t.setValue(String(cm.contactInteractionArchiveShardMaxBytes ?? 1048576));
        t.onChange(async (v) => {
          const n = Math.floor(Number(String(v ?? "").trim()) || 1048576);
          cm.contactInteractionArchiveShardMaxBytes = Math.max(4096, Math.min(20 * 1024 * 1024, n));
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });

    new Setting(contactsWrap)
      .setName("动态条目下展示最近几条互动时间")
      .setDesc("title 与 meta 之间预览 interaction_events。默认 3。")
      .addText((t) => {
        t.setPlaceholder("3");
        t.setValue(String(cm.interactionTimelinePreviewCount ?? 3));
        t.onChange(async (v) => {
          const n = Math.floor(Number(String(v ?? "").trim()) || 3);
          cm.interactionTimelinePreviewCount = Math.max(0, Math.min(20, n));
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });

    new Setting(contactsWrap)
      .setName("详细信息页签：frontmatter 黑名单（键名）")
      .setDesc("逗号分隔，不展示的 YAML 键名；用于隐藏敏感或冗余项。")
      .addTextArea((t) => {
        const cur = Array.isArray(cm.contactDetailsFieldBlacklist) ? cm.contactDetailsFieldBlacklist : [];
        t.setPlaceholder("phone, email");
        t.setValue(cur.join(", "));
        t.inputEl.rows = 2;
        t.onChange(async (v) => {
          const next = String(v ?? "")
            .split(/[,\n，]+/g)
            .map((x) => x.trim())
            .filter(Boolean);
          cm.contactDetailsFieldBlacklist = next;
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });

  } catch (e: any) {
    console.error("[RSLatte][settings][renderContactsSettings] render failed", e);
    try { new Notice("设置渲染失败（renderContactsSettings），请查看 Console"); } catch {}
  }
}
