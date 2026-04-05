// Auto-split from RSLatteSettingTab.ts to reduce file size and isolate failures.
import { Notice, Setting, normalizePath, TFile } from "obsidian";
import { DEFAULT_SETTINGS } from "../../../constants/defaults";
import type { OutputCreateExtraFieldDef } from "../../../types/outputTypes";
import { isReservedOutputFmKey } from "../../../utils/outputYamlExtras";
import { mountOutputTemplatesSection } from "../../outputTemplatesTable";

export type ModuleWrapFactory = (moduleKey: any, title: string, scopeTag?: "global" | "space") => HTMLElement;
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
        .setName("输出笔记归档根目录")
        .setDesc("「笔记归档」：已完成输出文档移动到此根下并保持相对路径（如 99-Archive）。取消类可走各根下 _archived。另伴随「索引归档」（output-index 条目迁出），见模块管理表下说明。")
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
      .setName("输出文档扫描根目录（多行）")
      .setDesc("纳入「输出」中央索引扫描的路径列表（一行一个）。与「输出笔记归档根目录」（已完成文档 **笔记归档** 目的地）不是同一设置。")
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
      .setName("全量重建时扫描旧版物理归档目录")
      .setDesc(
        "开启：🧱 全量仍会扫描「输出笔记归档根目录」及 _archived（兼容曾把 DONE 搬到独立归档夹）。关闭：以「输出文档扫描根目录」+ 磁盘扫描 + 合并 `.history/output-ledger` 为主；DONE 且留在扫描根下的条目仅按下方「索引归档阈值」做索引迁出并写台账。",
      )
      .addToggle((tg) => {
        tg.setValue((op as any).fullRebuildScanLegacyArchiveDirs !== false);
        tg.onChange(async (v) => {
          (op as any).fullRebuildScanLegacyArchiveDirs = v;
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });

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

    // ----- 创建输出 · 自定义属性（§3.2.2） -----
    outputWrap.createEl("h4", { text: "创建输出 · 自定义属性" });
    outputWrap.createDiv({
      cls: "rslatte-muted",
      text: "在新建输出弹窗中追加可编辑项，保存为 YAML 标量；键名不可与 status、output_id、tags、领域、project_id 等保留键重复。",
    });
    const extras = (op.createOutputExtraFields ?? []) as OutputCreateExtraFieldDef[];
    const exTable = outputWrap.createEl("table", { cls: "rslatte-checkin-table" });
    const exHead = exTable.createEl("thead");
    const exHr = exHead.createEl("tr");
    ["键名（英文）", "标签", "占位提示", "多行", "操作"].forEach((h) => exHr.createEl("th", { text: h }));
    const exBody = exTable.createEl("tbody");

    extras.forEach((row, idx) => {
      const tr = exBody.createEl("tr");
      const mkInput = (td: HTMLElement, val: string, onCommit: (v: string) => void) => {
        const inp = td.createEl("input", { type: "text", cls: "col-name" });
        inp.style.width = "100%";
        inp.value = val;
        inp.addEventListener("change", () => onCommit(inp.value));
      };
      mkInput(tr.createEl("td"), row.id ?? "", (v) => {
        const nk = String(v ?? "").trim();
        if (nk && isReservedOutputFmKey(nk)) {
          new Notice("该键名为系统保留");
          return;
        }
        row.id = nk;
        void tab.saveAndRefreshSidePanelDebounced();
      });
      mkInput(tr.createEl("td"), row.label ?? "", (v) => {
        row.label = v;
        void tab.saveAndRefreshSidePanelDebounced();
      });
      mkInput(tr.createEl("td"), row.placeholder ?? "", (v) => {
        row.placeholder = v;
        void tab.saveAndRefreshSidePanelDebounced();
      });
      const tdM = tr.createEl("td");
      const cb = tdM.createEl("input");
      cb.type = "checkbox";
      cb.checked = !!row.multiline;
      cb.addEventListener("change", () => {
        row.multiline = !!cb.checked;
        void tab.saveAndRefreshSidePanelDebounced();
      });
      const del = tr.createEl("td").createEl("button", { text: "删除", cls: "rslatte-text-btn" });
      del.onclick = async () => {
        extras.splice(idx, 1);
        await plugin.saveSettings();
        tab.saveAndRerender();
      };
    });

    new Setting(outputWrap)
      .setName("添加自定义字段")
      .setDesc("新增一行后在「键名」列填写英文 id（如 topic）")
      .addButton((btn) => {
        btn.setButtonText("添加");
        btn.onClick(async () => {
          extras.push({
            id: "",
            label: "新字段",
            placeholder: "",
            multiline: false,
          });
          await plugin.saveSettings();
          tab.saveAndRerender();
        });
      });

    {
      mountOutputTemplatesSection(outputWrap, plugin, {
        afterFieldChange: () => tab.saveAndRefreshSidePanelDebounced(),
        afterStructuralChange: () => tab.saveAndRerender(),
      });
    }

    // =========================
  } catch (e: any) {
    console.error("[RSLatte][settings][renderOutputSettings] render failed", e);
    try { new Notice("设置渲染失败（renderOutputSettings），请查看 Console"); } catch {}
  }
}
