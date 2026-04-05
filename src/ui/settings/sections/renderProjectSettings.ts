// Auto-split from RSLatteSettingTab.ts to reduce file size and isolate failures.
import { ButtonComponent, Notice, Setting, ToggleComponent, TextComponent, normalizePath, moment, TFile } from "obsidian";
import { DEFAULT_SETTINGS } from "../../../constants/defaults";
import {
  PROJECT_CARD_ACTION_CATALOG,
  PROJECT_MILESTONE_CARD_ACTION_CATALOG,
  PROJECT_TASK_CARD_ACTION_CATALOG,
} from "../../../constants/sidePanelCardActions";
import { renderSidePanelCardMoreChecklist } from "../../helpers/renderSidePanelCardMoreSettings";

export type ModuleWrapFactory = (moduleKey: any, title: string, scopeTag?: "global" | "space") => HTMLElement;
export type HeaderButtonsVisibilityAdder = (wrap: HTMLElement, moduleKey: any, defaultShow: boolean) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderProjectSettings(opts: {
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
    const projectWrap = makeModuleWrap('project', '项目管理');
    addHeaderButtonsVisibilitySetting(projectWrap, "project", true);

    projectWrap.createEl("div", {
      cls: "rslatte-setting-hint",
      text: "项目归档一次固定两步：① 先把符合条件的项目文件夹移到下方「项目笔记归档目录」；② 再在同一次流程里把主索引（project-index）中对应条目迁出到 archive 分片（索引瘦身）。不会只做其中一步。",
    });

    if (!sAny.projectPanel) sAny.projectPanel = {};
    if (sAny.projectPanel.projectAdvanceDescMaxLen === undefined || sAny.projectPanel.projectAdvanceDescMaxLen === null) sAny.projectPanel.projectAdvanceDescMaxLen = 36;
    if (sAny.projectPanel.projectSearchDefaultLimit === undefined || sAny.projectPanel.projectSearchDefaultLimit === null) sAny.projectPanel.projectSearchDefaultLimit = 5;
    new Setting(projectWrap)
      .setName("项目搜索默认条数")
      .setDesc("「项目进度管理」页签中，无筛选条件时按最后进展更新时间列出的最近项目条数（默认 5）。")
      .addText((t) => {
        t.setPlaceholder("5")
          .setValue(String(sAny.projectPanel?.projectSearchDefaultLimit ?? 5))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            sAny.projectPanel.projectSearchDefaultLimit = Number.isFinite(n) && n >= 1 ? Math.min(500, n) : 5;
            await tab.saveAndRefreshSidePanelDebounced();
          });
        t.inputEl.type = "number";
        t.inputEl.min = "1";
        t.inputEl.max = "500";
      });
    new Setting(projectWrap)
      .setName("推进区任务描述最大长度")
      .setDesc("项目卡片推进区中每条下一步任务描述的截断字数，默认 36。")
      .addText((t) => {
        t.setPlaceholder("36")
          .setValue(String(sAny.projectPanel?.projectAdvanceDescMaxLen ?? 36))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            sAny.projectPanel.projectAdvanceDescMaxLen = Number.isFinite(n) && n >= 1 ? Math.min(200, n) : 36;
            await tab.saveAndRefreshSidePanelDebounced();
          });
        t.inputEl.type = "number";
        t.inputEl.min = "1";
        t.inputEl.max = "200";
      });

    if (sAny.projectPanel.progressChartMarginDays === undefined || sAny.projectPanel.progressChartMarginDays === null) {
      sAny.projectPanel.progressChartMarginDays = DEFAULT_SETTINGS.projectPanel?.progressChartMarginDays ?? 30;
    }
    new Setting(projectWrap)
      .setName("进度图时间轴余量（天）")
      .setDesc("「项目进度管理」内「项目进度图」甘特轴在数据日期之外左右各延伸的天数；默认 30（约一月），可填 0～120。")
      .addText((t) => {
        t.setPlaceholder("30")
          .setValue(String(sAny.projectPanel?.progressChartMarginDays ?? 30))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            sAny.projectPanel.progressChartMarginDays = Number.isFinite(n) && n >= 0 ? Math.min(120, n) : 30;
            await tab.saveAndRefreshSidePanelDebounced();
          });
        t.inputEl.type = "number";
        t.inputEl.min = "0";
        t.inputEl.max = "120";
      });

    new Setting(projectWrap)
      .setName("里程碑即将超期天数")
      .setDesc("planned_end 在今天之后且 <= N 天内时标为「即将超期」（用于里程碑/任务清单的标签行）。默认 3。")
      .addText((t) => {
        t.setPlaceholder("3")
          .setValue(String(sAny.projectPanel?.progressMilestoneUpcomingDays ?? 3))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            sAny.projectPanel.progressMilestoneUpcomingDays = Number.isFinite(n) && n >= 0 ? Math.min(30, n) : 3;
            await tab.saveAndRefreshSidePanelDebounced();
          });
        t.inputEl.type = "number";
        t.inputEl.min = "0";
        t.inputEl.max = "30";
      });

    new Setting(projectWrap)
      .setName("项目概要「即将超期」天数")
      .setDesc(
        "项目计划完成日在今天之后且 <= N 天内时，在概要「当前状态」与 project-index 的 project_tags 中标记 project_soon_overdue。默认 5（与里程碑即将超期天数独立）。"
      )
      .addText((t) => {
        t.setPlaceholder("5")
          .setValue(String(sAny.projectPanel?.progressProjectUpcomingDays ?? 5))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            sAny.projectPanel.progressProjectUpcomingDays = Number.isFinite(n) && n >= 0 ? Math.min(30, n) : 5;
            await tab.saveAndRefreshSidePanelDebounced();
          });
        t.inputEl.type = "number";
        t.inputEl.min = "0";
        t.inputEl.max = "30";
      });

    if (!Array.isArray(sAny.projectPanel.sidePanelProjectTaskCardActionsInMore)) {
      sAny.projectPanel.sidePanelProjectTaskCardActionsInMore = [];
    }
    if (!Array.isArray(sAny.projectPanel.sidePanelProjectMilestoneCardActionsInMore)) {
      sAny.projectPanel.sidePanelProjectMilestoneCardActionsInMore = [];
    }
    if (!Array.isArray(sAny.projectPanel.sidePanelProjectCardActionsInMore)) {
      sAny.projectPanel.sidePanelProjectCardActionsInMore = [];
    }

    renderSidePanelCardMoreChecklist(projectWrap, {
      heading: "项目管理侧栏：项目任务卡片收纳到「⋯」",
      description: "勾选后在项目任务卡片中收入「⋯」菜单；未勾选保持为直接图标按钮。",
      catalog: PROJECT_TASK_CARD_ACTION_CATALOG,
      getIds: () => sAny.projectPanel.sidePanelProjectTaskCardActionsInMore,
      setIds: (n) => {
        sAny.projectPanel.sidePanelProjectTaskCardActionsInMore = n;
      },
      save: () => tab.saveAndRefreshSidePanelDebounced(),
    });
    renderSidePanelCardMoreChecklist(projectWrap, {
      heading: "项目管理侧栏：里程碑卡片收纳到「⋯」",
      description: "勾选后在里程碑卡片中收入「⋯」菜单；未勾选保持为直接图标按钮。",
      catalog: PROJECT_MILESTONE_CARD_ACTION_CATALOG,
      getIds: () => sAny.projectPanel.sidePanelProjectMilestoneCardActionsInMore,
      setIds: (n) => {
        sAny.projectPanel.sidePanelProjectMilestoneCardActionsInMore = n;
      },
      save: () => tab.saveAndRefreshSidePanelDebounced(),
    });
    renderSidePanelCardMoreChecklist(projectWrap, {
      heading: "项目管理侧栏：项目卡片收纳到「⋯」",
      description: "勾选后在项目卡片中收入「⋯」菜单；未勾选保持为直接图标按钮。",
      catalog: PROJECT_CARD_ACTION_CATALOG,
      getIds: () => sAny.projectPanel.sidePanelProjectCardActionsInMore,
      setIds: (n) => {
        sAny.projectPanel.sidePanelProjectCardActionsInMore = n;
      },
      save: () => tab.saveAndRefreshSidePanelDebounced(),
    });

    const normOrEmpty = (v: string) => normalizePath((v ?? "").trim());

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

    const projectRootDirUpdate = addDirCheckButton(
      new Setting(projectWrap)
        .setName("项目目录")
        .setDesc("指定存放项目文件的文件夹（每个子文件夹=一个项目），例如：03-Projects")
        .addText((t) => {
          t.setPlaceholder("03-Projects");
          t.setValue(tab.plugin.settings.projectRootDir || "");
          t.onChange(async (v) => {
            tab.plugin.settings.projectRootDir = normOrEmpty(v);
            await tab.saveAndRefreshSidePanelDebounced();
            await projectRootDirUpdate();
          });
        }),
      () => tab.plugin.settings.projectRootDir || ""
    );

    const projectArchiveDirUpdate = addDirCheckButton(
      new Setting(projectWrap)
        .setName("项目笔记归档目录")
        .setDesc("第①步「笔记归档」目的地：「待归档」或「已取消」且超过归档阈值的项目文件夹移入此目录；随后在同一次归档中完成第②步「索引归档」。已完成项目须先在侧栏点「标记待归档」才会在超阈值后被移动。该目录不参与项目根扫描与重建。")
        .addText((t) => {
          t.setPlaceholder("03-Projects/_archived");
          t.setValue(tab.plugin.settings.projectArchiveDir || "");
          t.onChange(async (v) => {
            tab.plugin.settings.projectArchiveDir = normOrEmpty(v);
            await tab.saveAndRefreshSidePanelDebounced();
            await projectArchiveDirUpdate();
          });
        }),
      () => tab.plugin.settings.projectArchiveDir || ""
    );

    const projectTasklistTemplateUpdate = addTemplateCheck(
      new Setting(projectWrap)
        .setName("项目任务清单模板")
        .setDesc("创建项目时，用该模板生成 '项目任务清单.md'")
        .addText((t) => {
          t.setPlaceholder("91-Templates/t_project_tasklist.md");
          t.setValue(tab.plugin.settings.projectTasklistTemplatePath || "");
          t.onChange(async (v) => {
            tab.plugin.settings.projectTasklistTemplatePath = normOrEmpty(v);
            await tab.saveAndRefreshSidePanelDebounced();
            await projectTasklistTemplateUpdate();
          });
        }),
      () => tab.plugin.settings.projectTasklistTemplatePath || ""
    );

    const projectInfoTemplateUpdate = addTemplateCheck(
      new Setting(projectWrap)
        .setName("项目信息模板")
        .setDesc("创建项目时，用该模板生成 ‘项目信息.md’")
        .addText((t) => {
          t.setPlaceholder("91-Templates/t_project_info.md");
          t.setValue(tab.plugin.settings.projectInfoTemplatePath || "");
          t.onChange(async (v) => {
            tab.plugin.settings.projectInfoTemplatePath = normOrEmpty(v);
            await tab.saveAndRefreshSidePanelDebounced();
            await projectInfoTemplateUpdate();
          });
        }),
      () => tab.plugin.settings.projectInfoTemplatePath || ""
    );

    const projectAnalysisTemplateUpdate = addTemplateCheck(
      new Setting(projectWrap)
        .setName("项目分析图模板")
        .setDesc("创建项目时，用该模板生成 ‘[项目名称]-项目分析图’ 文件（.md / .canvas 等后缀随模板路径）")
        .addText((t) => {
          t.setPlaceholder("00-System/01-Templates/t_project_canvas.canvas");
          t.setValue(tab.plugin.settings.projectAnalysisTemplatePath || "");
          t.onChange(async (v) => {
            tab.plugin.settings.projectAnalysisTemplatePath = normOrEmpty(v);
            await tab.saveAndRefreshSidePanelDebounced();
            await projectAnalysisTemplateUpdate();
          });
        }),
      () => tab.plugin.settings.projectAnalysisTemplatePath || ""
    );

    // ===== 项目存档文件模板清单（方案A：每个项目一个按钮，点击后下拉选择模板） =====
    {
      projectWrap.createEl("h4", { text: "项目存档文件模板清单" });
      projectWrap.createDiv({ cls: "rslatte-muted", text: "用于在项目侧边栏中快速创建项目存档文件（与上面的‘标准项目文档模板’分开维护）。目标相对路径填写创建文件的目录；模板路径指定创建所用的模板文件。" });

      const templates = (tab.plugin.settings.projectArchiveTemplates ?? []) as any[];
      tab.plugin.settings.projectArchiveTemplates = templates;

      const ensureTplId = (tpl: any) => {
        if (tpl.id) return;
        tpl.id = `PT_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      };

      const tableWrap = projectWrap.createDiv({ cls: "rslatte-tasklist-table-wrap" });
      const table = tableWrap.createEl("table", { cls: "rslatte-tasklist-table rslatte-archive-tpl-table" });
      const thead = table.createEl("thead");
      const hr = thead.createEl("tr");
      ["⭐", "名称", "目标相对路径", "模板路径", "打开", "操作"].forEach((h) => hr.createEl("th", { text: h }));
      const tbody = table.createEl("tbody");

      const mkTextInput = (td: HTMLElement, val: string, placeholder: string, onCommit: (v: string) => void) => {
        const inp = td.createEl("input", { cls: "rslatte-archive-tpl-text" });
        inp.type = "text";
        inp.value = val;
        inp.placeholder = placeholder;
        const commit = () => onCommit(inp.value);
        inp.addEventListener("change", commit);
        inp.addEventListener("blur", commit);
        return inp;
      };

      const mkCheck = (td: HTMLElement, checked: boolean, onCommit: (v: boolean) => void) => {
        const chk = td.createEl("input");
        chk.type = "checkbox";
        chk.checked = checked;
        chk.addEventListener("change", () => onCommit(chk.checked));
        return chk;
      };

      const renderTplRow = (tpl: any, idx: number) => {
        ensureTplId(tpl);
        const tr = tbody.createEl("tr");

        // favorite（常用/收藏）
        {
          const td = tr.createEl("td");
          mkCheck(td, !!tpl.favorite, (v) => {
            tpl.favorite = v;
            void tab.saveAndRefreshSidePanelDebounced();
          });
        }

        // 名称
        {
          const td = tr.createEl("td");
          mkTextInput(td, tpl.name || "", "例如：插件使用指导", (v) => {
            tpl.name = (v ?? "").trim();
            void tab.saveAndRefreshSidePanelDebounced();
          });
        }

        // 目标相对路径：目录（相对项目文件夹）
        {
          const td = tr.createEl("td");
          mkTextInput(td, tpl.targetRelPath || "", "如：pro_files", (v) => {
            const vv = normalizePath((v ?? "").trim()).replace(/^\/+|\/+$/g, "");
            tpl.targetRelPath = vv;
            void tab.saveAndRefreshSidePanelDebounced();
          });
        }

        // 模板路径：创建所用模板文件（带文件存在性检查）
        {
          const td = tr.createEl("td");
          const templateInput = td.createEl("input", { cls: "rslatte-archive-tpl-text" });
          templateInput.type = "text";
          templateInput.value = tpl.templatePath || "";
          templateInput.placeholder = "如：91-Templates/h_project/t_xxx.md";
          
          // 检查模板文件是否存在
          const checkTemplateExists = async () => {
            const path = normalizePath(templateInput.value.trim());
            if (!path) {
              templateInput.style.color = "";
              return;
            }
            
            // 尝试多种路径格式（支持带或不带 .md 后缀）
            const candidates: string[] = [path];
            if (!/\.md$/i.test(path)) {
              candidates.push(path + ".md");
            }
            
            let exists = false;
            for (const p of candidates) {
              try {
                const file = plugin.app.vault.getAbstractFileByPath(p);
                if (file && file instanceof TFile) {
                  exists = true;
                  break;
                }
              } catch {
                // ignore
              }
            }
            
            // 如果文件不存在，将文本颜色设置为红色
            if (!exists) {
              templateInput.style.color = "var(--text-error)";
            } else {
              templateInput.style.color = "";
            }
          };
          
          templateInput.addEventListener("change", () => {
            tpl.templatePath = normalizePath((templateInput.value ?? "").trim());
            void tab.saveAndRefreshSidePanelDebounced();
            void checkTemplateExists();
          });
          templateInput.addEventListener("blur", () => {
            tpl.templatePath = normalizePath((templateInput.value ?? "").trim());
            void tab.saveAndRefreshSidePanelDebounced();
            void checkTemplateExists();
          });
          
          // 初始检查
          void checkTemplateExists();
        }

        // 打开
        {
          const td = tr.createEl("td");
          mkCheck(td, tpl.openAfterCreate !== false, (v) => {
            tpl.openAfterCreate = v;
            void tab.saveAndRefreshSidePanelDebounced();
          });
        }

        // 操作
        {
          const tdOps = tr.createEl("td");
          const del = tdOps.createEl("button", { text: "删除", cls: "rslatte-text-btn" });
          del.onclick = () => {
            templates.splice(idx, 1);
            void tab.saveAndRerender();
          };
        }
      };

      templates.forEach((tpl, idx) => renderTplRow(tpl, idx));

      new Setting(projectWrap)
        .setName("新增存档模板")
        .setDesc("添加一条项目存档文件模板记录")
        .addButton((btn) => {
          btn.setButtonText("添加");
          btn.setCta();
          btn.onClick(async () => {
            templates.push({
              id: `PT_${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
              name: "存档文件",
              targetRelPath: "pro_files",
              templatePath: "91-Templates/h_project/t_project_archive.md",
              openAfterCreate: true,
              favorite: false,
            });
            await tab.saveAndRerender();
          });
        });
    }

    // =========================
    // Side Panel 4：输出管理
    // =========================
  } catch (e: any) {
    console.error("[RSLatte][settings][renderProjectSettings] render failed", e);
    try { new Notice("设置渲染失败（renderProjectSettings），请查看 Console"); } catch {}
  }
}
