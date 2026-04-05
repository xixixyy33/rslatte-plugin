// Auto-split from RSLatteSettingTab.ts to reduce file size and isolate failures.
import { ButtonComponent, Notice, Setting, ToggleComponent, TextComponent, normalizePath, moment } from "obsidian";
import { DEFAULT_SETTINGS } from "../../../constants/defaults";
import { TASK_CARD_ACTION_CATALOG } from "../../../constants/sidePanelCardActions";
import { renderSidePanelCardMoreChecklist } from "../../helpers/renderSidePanelCardMoreSettings";
import {
  DEFAULT_TASK_BUSINESS_CATEGORY_NAMES,
  getTaskBusinessCategories,
} from "../../../taskRSLatte/task/taskBusinessCategory";

export type ModuleWrapFactory = (moduleKey: any, title: string, scopeTag?: "global" | "space") => HTMLElement;
export type HeaderButtonsVisibilityAdder = (wrap: HTMLElement, moduleKey: any, defaultShow: boolean) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderTaskSettings(opts: {
  tab: any;
  makeModuleWrap: ModuleWrapFactory;
  addHeaderButtonsVisibilitySetting: HeaderButtonsVisibilityAdder;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addUiHeaderButtonsVisibilitySetting?: any;
}): void {
  const { tab, makeModuleWrap, addHeaderButtonsVisibilitySetting, addUiHeaderButtonsVisibilitySetting } = opts;
  const plugin = tab.plugin;
  const sAny = plugin?.settings as any;
  const tp = plugin?.settings?.taskPanel as any;
  try {
    const taskWrap = makeModuleWrap('task', '任务管理');
    addHeaderButtonsVisibilitySetting(taskWrap, "task", true);

    new Setting(taskWrap)
      .setName("任务定位（执行闭环）")
      .setDesc("要结果，用任务。任务用于推进并最终完成的事项；纯提醒或纯时间安排请使用提醒/日程。");


    // v26：补齐高级同步参数默认值（兼容旧配置）
    if (tp.upsertBatchSize === undefined || tp.upsertBatchSize === null) tp.upsertBatchSize = 50;
    if (tp.reconcileRequireQueueEmpty === undefined || tp.reconcileRequireQueueEmpty === null) tp.reconcileRequireQueueEmpty = true;
    // v27：reconcile 仅对干净文件执行
    if (tp.reconcileRequireFileClean === undefined || tp.reconcileRequireFileClean === null) tp.reconcileRequireFileClean = true;

    if (tp.fakeActiveThresholdDays === undefined || tp.fakeActiveThresholdDays === null) (tp as any).fakeActiveThresholdDays = 3;
    if (tp.taskBaseDateMode === undefined || tp.taskBaseDateMode === null) (tp as any).taskBaseDateMode = "local";
    if (tp.focusTopN === undefined || tp.focusTopN === null) (tp as any).focusTopN = 3;
    if (tp.overdueWithinDays === undefined || tp.overdueWithinDays === null) (tp as any).overdueWithinDays = 3;
    if (tp.closedTaskWindowDays === undefined || tp.closedTaskWindowDays === null) (tp as any).closedTaskWindowDays = 7;

    taskWrap.createEl("h5", { text: "任务标签与重点关注" });
    new Setting(taskWrap)
      .setName("假活跃阈值（天）")
      .setDesc("处理中/跟进中的任务超过 N 天未更新进度时标为「假活跃」。默认 3。")
      .addText((t) => {
        t.setPlaceholder("3")
          .setValue(String(tp.fakeActiveThresholdDays ?? 3))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            (tp as any).fakeActiveThresholdDays = Number.isFinite(n) && n >= 0 ? n : 3;
            await tab.saveAndRefreshSidePanelDebounced();
          });
        t.inputEl.type = "number";
        t.inputEl.min = "0";
        t.inputEl.max = "365";
      });

    new Setting(taskWrap)
      .setName("重点关注数量")
      .setDesc("任务管理侧栏「重点关注」清单显示条数（重要性 Top N），范围 3–10。默认 3。")
      .addSlider((s) => {
        s.setLimits(3, 10, 1)
          .setValue(Math.min(10, Math.max(3, Number(tp.focusTopN ?? 3) || 3)))
          .onChange(async (v) => {
            (tp as any).focusTopN = Math.min(10, Math.max(3, Math.round(v)));
            await tab.saveAndRefreshSidePanelDebounced();
          });
        s.showTooltip();
      })
      .addExtraButton((b) => {
        b.setIcon("reset")
          .setTooltip("恢复默认 3")
          .onClick(async () => {
            (tp as any).focusTopN = 3;
            await tab.saveAndRefreshSidePanelDebounced();
          });
      });

    new Setting(taskWrap)
      .setName("任务基准日期")
      .setDesc("用于标签与今日清单的「今天」：默认本地日期；可选指定时区以适配跨时区。")
      .addDropdown((d) => {
        d.addOption("local", "本地日期")
          .addOption("zone", "指定时区")
          .setValue(tp.taskBaseDateMode ?? "local")
          .onChange(async (v) => {
            (tp as any).taskBaseDateMode = v === "zone" ? "zone" : "local";
            if ((tp as any).taskBaseDateMode !== "zone") (tp as any).taskBaseTimeZone = undefined;
            await tab.saveAndRefreshSidePanelDebounced();
          });
      })
      .addText((t) => {
        t.setPlaceholder("Asia/Shanghai 或 UTC")
          .setValue(String(tp.taskBaseTimeZone ?? ""))
          .onChange(async (v) => {
            (tp as any).taskBaseTimeZone = v?.trim() || undefined;
            await tab.saveAndRefreshSidePanelDebounced();
          });
        t.inputEl.style.width = "12em";
      });

    new Setting(taskWrap)
      .setName("即将超期天数")
      .setDesc("「超期/即将超期」清单中，到期日在 [今天, 今天+N] 视为即将超期。默认 3，范围 1–30。")
      .addText((t) => {
        t.setPlaceholder("3")
          .setValue(String(tp.overdueWithinDays ?? 3))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            (tp as any).overdueWithinDays = Number.isFinite(n) ? Math.min(30, Math.max(1, n)) : 3;
            await tab.saveAndRefreshSidePanelDebounced();
          });
        t.inputEl.type = "number";
        t.inputEl.min = "1";
        t.inputEl.max = "30";
      });

    new Setting(taskWrap)
      .setName("近期闭环天数")
      .setDesc("「近期取消」「近期完成」的窗口：今天−N ～ 今天。默认 7，范围 1–90。")
      .addText((t) => {
        t.setPlaceholder("7")
          .setValue(String(tp.closedTaskWindowDays ?? 7))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            (tp as any).closedTaskWindowDays = Number.isFinite(n) ? Math.min(90, Math.max(1, n)) : 7;
            await tab.saveAndRefreshSidePanelDebounced();
          });
        t.inputEl.type = "number";
        t.inputEl.min = "1";
        t.inputEl.max = "90";
      });

    if (!Array.isArray(tp.sidePanelTaskCardActionsInMore)) tp.sidePanelTaskCardActionsInMore = [];
    renderSidePanelCardMoreChecklist(taskWrap, {
      heading: "侧栏任务卡片：收纳到「⋯」",
      description:
        "勾选后，在卡片上需要显示该操作时，将其收入行末「⋯」菜单；未勾选则仍显示为图标按钮。配置按当前空间独立保存。",
      catalog: TASK_CARD_ACTION_CATALOG,
      getIds: () => tp.sidePanelTaskCardActionsInMore,
      setIds: (n) => {
        tp.sidePanelTaskCardActionsInMore = n;
      },
      save: () => tab.saveAndRefreshSidePanelDebounced(),
    });

    new Setting(taskWrap)
      .setName("周期任务口径")
      .setDesc("任务侧统一称「周期任务」（底层字段保持 repeatRule/repeat_rule 不变），表示每次都需要重新完成一次。");

    if (!(tp as any).taskBusinessCategories || !Array.isArray((tp as any).taskBusinessCategories) || (tp as any).taskBusinessCategories.length === 0) {
      (tp as any).taskBusinessCategories = [...DEFAULT_TASK_BUSINESS_CATEGORY_NAMES];
    }
    if (!String((tp as any).defaultTaskBusinessCategory ?? "").trim()) {
      (tp as any).defaultTaskBusinessCategory = "工作";
    }

    taskWrap.createEl("h5", { text: "任务业务分类" });

    const toLines = (arr: string[]) => (arr ?? []).filter(Boolean).join("\n");
    const fromLines = (s: string) => (s ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

    const mountDefaultTaskCategoryDropdown = (defaultSetting: Setting) => {
      defaultSetting.controlEl.empty();
      const list = getTaskBusinessCategories(tp);
      let cur = String((tp as any).defaultTaskBusinessCategory ?? "").trim();
      if (!list.includes(cur)) {
        cur = list[0] ?? "工作";
        (tp as any).defaultTaskBusinessCategory = cur;
      }
      defaultSetting.addDropdown((dd) => {
        for (const n of list) dd.addOption(n, n);
        dd.setValue(cur);
        dd.onChange(async (v) => {
          (tp as any).defaultTaskBusinessCategory = v;
          await tab.saveAndRefreshSidePanelDebounced();
        });
      });
    };

    let defaultTaskCategorySetting!: Setting;

    new Setting(taskWrap)
      .setName("分类列表")
      .setDesc(
        "每行一个名称；可增删改。任务 meta 键 `task_category` 存保存时的名称快照，此处改名或删项不会改写已有任务。"
      )
      .addTextArea((t) => {
        t.setPlaceholder("学习\n工作\n生活");
        t.inputEl.rows = 5;
        t.setValue(toLines((tp as any).taskBusinessCategories ?? []));
        t.onChange(async (v) => {
          let lines = fromLines(v);
          if (lines.length === 0) lines = [...DEFAULT_TASK_BUSINESS_CATEGORY_NAMES];
          (tp as any).taskBusinessCategories = lines;
          const def = String((tp as any).defaultTaskBusinessCategory ?? "").trim();
          if (!lines.includes(def)) (tp as any).defaultTaskBusinessCategory = lines[0];
          await tab.saveAndRefreshSidePanelDebounced();
          mountDefaultTaskCategoryDropdown(defaultTaskCategorySetting);
        });
      });

    defaultTaskCategorySetting = new Setting(taskWrap)
      .setName("新建任务默认分类")
      .setDesc("须为上方列表中的某一项；按当前空间在 `settingsSnapshot` 中独立保存。");

    mountDefaultTaskCategoryDropdown(defaultTaskCategorySetting);

    taskWrap.createEl("h5", { text: "扫描范围" });

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

    const taskFoldersSetting = new Setting(taskWrap)
      .setName("任务/提醒数据目录")
      .setDesc("可多选，每行一个目录；递归扫描子文件夹。留空表示扫描整个 vault（不推荐）。")
      .addTextArea((t) => {
        t.setPlaceholder("例如：03-Projects\n01-Daily")
          .setValue(toLines(tp.taskFolders))
          .onChange(async (v) => {
            tp.taskFolders = fromLines(v);
            await tab.saveAndRefreshSidePanelDebounced();
            await updateTaskFoldersStatus();
          });
        t.inputEl.rows = 3;
      });

    // 为任务数据目录添加检查和创建按钮（支持多目录）
    const updateTaskFoldersStatus = async () => {
      const controlEl = taskFoldersSetting.controlEl;
      let statusContainer = controlEl.querySelector(".rslatte-dir-status-container") as HTMLElement;
      if (!statusContainer) {
        statusContainer = controlEl.createDiv({ cls: "rslatte-dir-status-container" });
        statusContainer.style.marginTop = "4px";
      }
      statusContainer.empty();
      
      const dirs = tp.taskFolders || [];
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
            await updateTaskFoldersStatus();
          }
        };
      }
    };
    void updateTaskFoldersStatus();

    new Setting(taskWrap)
      .setName("文档包含 tags（并集）")
      .setDesc("每行一个 tag（可带 # 也可不带）。配置后：文件至少包含其中一个 tag 才会被扫描。")
      .addTextArea((t) => {
        t.setPlaceholder("例如：#project\n#task")
          .setValue(toLines(tp.includeTags))
          .onChange(async (v) => {
            tp.includeTags = fromLines(v);
            await tab.saveAndRefreshSidePanelDebounced();
          });
        t.inputEl.rows = 2;
      });

    new Setting(taskWrap)
      .setName("文档不包含 tags（并集）")
      .setDesc("每行一个 tag（可带 # 也可不带）。配置后：文件若包含任意一个 tag 将被排除。")
      .addTextArea((t) => {
        t.setPlaceholder("例如：#archive\n#trash")
          .setValue(toLines(tp.excludeTags))
          .onChange(async (v) => {
            tp.excludeTags = fromLines(v);
            await tab.saveAndRefreshSidePanelDebounced();
          });
        t.inputEl.rows = 2;
      });

    //（自动归档/阈值/手动归档/DB 同步 已统一到设置「模块管理」表；归档语义见《索引优化方案》§9 / CODE_MAP §3.11.1）

    // NOTE: “新增任务/提醒写入区块”已迁移到「日记管理 → 日志追加清单」中统一配置（H1/H2）。

    taskWrap.createEl("h5", { text: "任务清单" });

    // =========================
    // Side Panel 3：项目管理
    // =========================
  } catch (e: any) {
    console.error("[RSLatte][settings][renderTaskSettings] render failed", e);
    try { new Notice("设置渲染失败（renderTaskSettings），请查看 Console"); } catch {}
  }
}
