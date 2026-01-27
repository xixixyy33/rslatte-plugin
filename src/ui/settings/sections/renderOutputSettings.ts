// Auto-split from RSLatteSettingTab.ts to reduce file size and isolate failures.
import { Notice, Setting, normalizePath, TFile } from "obsidian";
import { DEFAULT_SETTINGS } from "../../../constants/defaults";

export type ModuleWrapFactory = (moduleKey: any, title: string) => HTMLElement;
export type HeaderButtonsVisibilityAdder = (wrap: HTMLElement, moduleKey: any, defaultShow: boolean) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderOutputSettings(opts: {
  tab: any;
  makeModuleWrap: ModuleWrapFactory;
  addHeaderButtonsVisibilitySetting: HeaderButtonsVisibilityAdder;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addUiHeaderButtonsVisibilitySetting?: any;
}): void {
  const { tab, makeModuleWrap, addHeaderButtonsVisibilitySetting } = opts;
  const plugin = tab.plugin;
  
  try {
    const outputWrap = makeModuleWrap('output', '输出管理');
    addHeaderButtonsVisibilitySetting(outputWrap, "output", false);


    const op = (tab.plugin.settings.outputPanel ?? (DEFAULT_SETTINGS as any).outputPanel) as any;
    tab.plugin.settings.outputPanel = op;

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

    const archiveRootDirUpdate = addDirCheckButton(
      new Setting(outputWrap)
        .setName("归档目录")
        .setDesc("归档根目录，例如：99-Archive；归档后路径保持原相对路径")
        .addText((t) => {
          t.setPlaceholder("99-Archive");
          t.setValue(String(op.archiveRootDir ?? "99-Archive"));
          t.onChange(async (v) => {
            op.archiveRootDir = normalizePath(String(v ?? "").trim()) || "99-Archive";
            await tab.saveAndRefreshSidePanelDebounced();
            await archiveRootDirUpdate();
          });
        }),
      () => op.archiveRootDir ?? "99-Archive"
    );

    //（手动归档已统一到 Vault ID 下方的配置表）

    const splitLines = (v: string): string[] => {
      return String(v ?? "")
        .split(/\r?\n/)
        .map((s) => normalizePath(s.trim()))
        .filter((s) => !!s);
    };

    const archiveRootsSetting = new Setting(outputWrap)
      .setName("输出文档存档目录（根目录）")
      .setDesc("用于扫描输出文档中央索引；一行一个目录，例如：00-Inbox\n02-Notes")
      .addTextArea((ta) => {
        ta.setPlaceholder("00-Inbox\n02-Notes");
        ta.setValue((op.archiveRoots ?? []).join("\n"));
        ta.onChange(async (v) => {
          op.archiveRoots = splitLines(v);
          await tab.saveAndRefreshSidePanelDebounced();
          void tab.plugin.outputRSLatte?.ensureReady();
          await updateArchiveRootsStatus();
        });
        ta.inputEl.rows = 3;
      });

    // 为输出文档存档目录添加检查和创建按钮（支持多目录）
    const updateArchiveRootsStatus = async () => {
      const controlEl = archiveRootsSetting.controlEl;
      let statusContainer = controlEl.querySelector(".rslatte-dir-status-container") as HTMLElement;
      if (!statusContainer) {
        statusContainer = controlEl.createDiv({ cls: "rslatte-dir-status-container" });
        statusContainer.style.marginTop = "4px";
      }
      statusContainer.empty();
      
      const dirs = op.archiveRoots || [];
      if (dirs.length === 0) return;
      
      for (const dir of dirs) {
        if (!dir || !dir.trim()) continue;
        const exists = await checkDirExists(dir);
        if (exists) continue;
        
        const statusEl = statusContainer.createDiv({ cls: "rslatte-dir-status" });
        statusEl.style.display = "flex";
        statusEl.style.alignItems = "center";
        statusEl.style.gap = "8px";
        statusEl.style.marginBottom = "4px";
        
        const warn = statusEl.createDiv({ cls: "rslatte-dir-warning" });
        warn.style.color = "var(--text-error)";
        warn.style.fontSize = "12px";
        warn.textContent = `目录不存在：${dir}`;
        
        const btn = statusEl.createEl("button", { cls: "rslatte-dir-create-btn", text: "创建目录" });
        btn.style.fontSize = "12px";
        btn.style.padding = "2px 8px";
        btn.onclick = async () => {
          btn.disabled = true;
          const success = await checkAndCreateDir(dir);
          btn.disabled = false;
          if (success) {
            await updateArchiveRootsStatus();
          }
        };
      }
    };
    void updateArchiveRootsStatus();

    new Setting(outputWrap)
      .setName("Timeline 时间字段")
      .setDesc("文档列表分组与排序使用的时间字段")
      .addDropdown((dd) => {
        dd.addOption("mtime", "最后修改时间");
        dd.addOption("create", "创建时间（create 属性）");
        dd.addOption("done", "完成时间（done/done_date 属性）");
        dd.setValue(String(op.timelineTimeField ?? "mtime"));
        dd.onChange(async (v) => {
          op.timelineTimeField = v;
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });

    new Setting(outputWrap)
      .setName("最大文件列表数量")
      .setDesc("1-50")
      .addText((t) => {
        t.setPlaceholder("20");
        t.setValue(String(op.maxItems ?? 20));
        t.onChange(async (v) => {
          const n = Math.max(1, Math.min(50, Math.floor(Number(v || 20))));
          op.maxItems = Number.isFinite(n) ? n : 20;
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });


    {
    outputWrap.createEl("h4", { text: "输出文档模板清单" });
    outputWrap.createDiv({ cls: "rslatte-muted", text: "每条记录对应侧边栏一个快速创建按钮" });

    const templates = (op.templates ?? []) as any[];
    op.templates = templates;

    const ensureTplId = (tpl: any) => {
      if (tpl.id) return;
      tpl.id = `OT_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    };

    const table = outputWrap.createEl("table", { cls: "rslatte-checkin-table" });
    const thead = table.createEl("thead");
    const hr = thead.createEl("tr");
    ["按钮名称", "文档分类", "文档模板", "存档目录", "tags", "type", "操作"].forEach((h) => hr.createEl("th", { text: h }));
    const tbody = table.createEl("tbody");

    const toCsv = (arr: any): string => {
      if (!arr) return "";
      const a = Array.isArray(arr) ? arr : String(arr).split(",");
      return a.map((s) => String(s).trim()).filter(Boolean).join(",");
    };

    const parseCsv = (v: string): string[] => {
      return String(v ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    };

    const renderTplRow = async (tpl: any, idx: number) => {
      ensureTplId(tpl);
      const tr = tbody.createEl("tr");

      const mkInput = (td: HTMLElement, cls: string, val: string, onCommit: (v: string) => void) => {
        const inp = td.createEl("input", { cls });
        inp.type = "text";
        inp.value = val;
        inp.addEventListener("change", () => onCommit(inp.value));
        return inp;
      };

      const mkTextarea = (td: HTMLElement, cls: string, val: string, onCommit: (v: string) => void) => {
        const ta = td.createEl("textarea", { cls });
        ta.value = val;
        ta.style.width = "100%";
        ta.style.minHeight = "2em";
        ta.style.resize = "vertical";
        ta.style.whiteSpace = "pre-wrap";
        ta.style.wordWrap = "break-word";
        ta.addEventListener("change", () => onCommit(ta.value));
        return ta;
      };

      mkInput(tr.createEl("td"), "col-name", tpl.buttonName || "", (v) => { tpl.buttonName = v; void tab.saveAndRefreshSidePanelDebounced(); });
      mkInput(tr.createEl("td"), "col-name", tpl.docCategory || "", (v) => { tpl.docCategory = v; void tab.saveAndRefreshSidePanelDebounced(); });
      
      // 文档模板：使用 textarea 并检查文件是否存在
      const templateTd = tr.createEl("td");
      const templateInput = templateTd.createEl("textarea", { cls: "col-path" });
      templateInput.value = tpl.templatePath || "";
      templateInput.style.width = "100%";
      templateInput.style.minHeight = "2em";
      templateInput.style.resize = "vertical";
      templateInput.style.whiteSpace = "pre-wrap";
      templateInput.style.wordWrap = "break-word";
      
      // 检查文件是否存在
      const checkTemplateExists = async () => {
        const path = normalizePath(templateInput.value.trim());
        if (!path) {
          templateInput.style.color = "";
          return;
        }
        
        const candidates: string[] = [path];
        if (!/\.md$/i.test(path)) {
          candidates.push(path + ".md");
        }
        
        let exists = false;
        for (const p of candidates) {
          const file = plugin.app.vault.getAbstractFileByPath(p);
          if (file && file instanceof TFile) {
            exists = true;
            break;
          }
        }
        
        if (!exists) {
          templateInput.style.color = "var(--text-error)";
        } else {
          templateInput.style.color = "";
        }
      };
      
      templateInput.addEventListener("change", () => {
        tpl.templatePath = normalizePath(templateInput.value.trim());
        void tab.saveAndRefreshSidePanelDebounced();
        void checkTemplateExists();
      });
      void checkTemplateExists();
      
      // 存档目录：使用 textarea
      const archiveTd = tr.createEl("td");
      const archiveInput = archiveTd.createEl("textarea", { cls: "col-path" });
      archiveInput.value = tpl.archiveDir || "";
      archiveInput.style.width = "100%";
      archiveInput.style.minHeight = "2em";
      archiveInput.style.resize = "vertical";
      archiveInput.style.whiteSpace = "pre-wrap";
      archiveInput.style.wordWrap = "break-word";
      archiveInput.addEventListener("change", () => {
        tpl.archiveDir = normalizePath(archiveInput.value.trim());
        void tab.saveAndRefreshSidePanelDebounced();
      });
      
      // tags：使用 textarea
      const tagsTd = tr.createEl("td");
      const tagsInput = tagsTd.createEl("textarea", { cls: "col-tags" });
      tagsInput.value = toCsv(tpl.tags);
      tagsInput.style.width = "100%";
      tagsInput.style.minHeight = "2em";
      tagsInput.style.resize = "vertical";
      tagsInput.style.whiteSpace = "pre-wrap";
      tagsInput.style.wordWrap = "break-word";
      tagsInput.addEventListener("change", () => {
        tpl.tags = parseCsv(tagsInput.value);
        void tab.saveAndRefreshSidePanelDebounced();
      });
      
      // type：使用 textarea
      const typeTd = tr.createEl("td");
      const typeInput = typeTd.createEl("textarea", { cls: "col-type" });
      typeInput.value = tpl.type || "";
      typeInput.style.width = "100%";
      typeInput.style.minHeight = "2em";
      typeInput.style.resize = "vertical";
      typeInput.style.whiteSpace = "pre-wrap";
      typeInput.style.wordWrap = "break-word";
      typeInput.addEventListener("change", () => {
        tpl.type = typeInput.value.trim();
        void tab.saveAndRefreshSidePanelDebounced();
      });

      const tdOps = tr.createEl("td");
      const del = tdOps.createEl("button", { text: "删除", cls: "rslatte-text-btn" });
      del.onclick = () => {
        templates.splice(idx, 1);
        void tab.saveAndRerender();
      };
    };

    templates.forEach((tpl, idx) => void renderTplRow(tpl, idx));

    new Setting(outputWrap)
      .setName("新增模板")
      .setDesc("添加一条输出文档模板记录")
      .addButton((btn) => {
        btn.setButtonText("添加");
        btn.setCta();
        btn.onClick(async () => {
          templates.push({
            id: `OT_${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
            buttonName: "新建",
            docCategory: "输出",
            templatePath: "",
            archiveDir: (op.archiveRoots?.[0] ?? "00-Inbox"),
            tags: [],
            type: "",
          });
          await tab.saveAndRerender();
        });
      });

    }

    // =========================
  } catch (e: any) {
    console.error("[RSLatte][settings][renderOutputSettings] render failed", e);
    try { new Notice("设置渲染失败（renderOutputSettings），请查看 Console"); } catch {}
  }
}
