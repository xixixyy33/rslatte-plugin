// Auto-split from RSLatteSettingTab.ts to reduce file size and isolate failures.
import { ButtonComponent, Notice, Setting, ToggleComponent, TextComponent, normalizePath, moment } from "obsidian";
import { DEFAULT_SETTINGS } from "../../../constants/defaults";

export type ModuleWrapFactory = (moduleKey: any, title: string) => HTMLElement;
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


    // v26：补齐高级同步参数默认值（兼容旧配置）
    if (tp.upsertBatchSize === undefined || tp.upsertBatchSize === null) tp.upsertBatchSize = 50;
    if (tp.reconcileRequireQueueEmpty === undefined || tp.reconcileRequireQueueEmpty === null) tp.reconcileRequireQueueEmpty = true;
    // v27：reconcile 仅对干净文件执行
    if (tp.reconcileRequireFileClean === undefined || tp.reconcileRequireFileClean === null) tp.reconcileRequireFileClean = true;

    // 兼容旧配置：补齐内置清单配置
    if (!tp.builtinLists) (tp as any).builtinLists = {};
    const bl = (tp.builtinLists ?? {}) as any;
    const ensureBL = (id: string, d: any) => {
      if (!bl[id]) bl[id] = d;
      if (bl[id].enabled === undefined) bl[id].enabled = d.enabled;
      if (!bl[id].maxItems) bl[id].maxItems = d.maxItems;
      if (!bl[id].sortField) bl[id].sortField = d.sortField;
      if (!bl[id].sortOrder) bl[id].sortOrder = d.sortOrder;
      if (bl[id].defaultCollapsed === undefined) bl[id].defaultCollapsed = d.defaultCollapsed ?? false;
    };
    ensureBL("todayTodo", { enabled: true, maxItems: 20, sortField: "due", sortOrder: "asc", defaultCollapsed: false });
    ensureBL("weekTodo", { enabled: true, maxItems: 20, sortField: "due", sortOrder: "asc", defaultCollapsed: false });
    ensureBL("inProgress", { enabled: true, maxItems: 20, sortField: "start", sortOrder: "asc", defaultCollapsed: false });
    ensureBL("overdue", { enabled: true, maxItems: 20, sortField: "due", sortOrder: "asc", defaultCollapsed: false });
    ensureBL("todayDone", { enabled: true, maxItems: 20, sortField: "done", sortOrder: "desc", defaultCollapsed: false });
    ensureBL("cancelled7d", { enabled: true, maxItems: 20, sortField: "cancelled", sortOrder: "desc", defaultCollapsed: false });
    ensureBL("allTasks", { enabled: true, maxItems: 20, sortField: "created", sortOrder: "desc", defaultCollapsed: false });

    const toLines = (arr: string[]) => (arr ?? []).filter(Boolean).join("\n");
    const fromLines = (s: string) => (s ?? "").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
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
      .setName("任务/备忘数据目录")
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

    //（自动归档/阈值/手动归档/DB 同步 开关已统一配置）

    // NOTE: “新增任务/备忘写入区块”已迁移到「日记管理 → 日志追加清单」中统一配置（H1/H2）。

    taskWrap.createEl("h5", { text: "任务清单" });

    const fieldOptions: Record<string, string> = {
      due: "due(📅)",
      start: "start(🛫)",
      scheduled: "scheduled(⏳)",
      created: "created(➕)",
      done: "done(✅)",
      cancelled: "cancelled(❌)",
    };

    const listDefs: Array<{ id: string; title: string; desc: string }> = [
      { id: "todayTodo", title: "今日待完成", desc: "due=今天 且 状态 TODO/[ ] 或 IN_PROGRESS[/]" },
      { id: "weekTodo", title: "待本周完成", desc: "due 在本周 且 状态 TODO/[ ] 或 IN_PROGRESS[/]" },
      { id: "inProgress", title: "进行中任务", desc: "状态 IN_PROGRESS[/]，或 start<今天 的 TODO/[ ]" },
      { id: "overdue", title: "超期未完成", desc: "due<今天 且 状态 TODO/[ ] 或 IN_PROGRESS[/]" },
      { id: "todayDone", title: "今日已完成", desc: "done=今天 或 cancelled=今天" },
      { id: "cancelled7d", title: "近七天取消任务", desc: "状态 CANCELLED[-] 且 cancelled 在近 7 天内" },
      { id: "allTasks", title: "全量任务清单", desc: "所有未归档任务，不限制状态和日期" },
    ];

	    // ✅ 内置清单显示顺序（可在设置中用 ↑↓ 调整）
	    const defaultOrder = ["todayTodo", "weekTodo", "inProgress", "overdue", "todayDone", "cancelled7d", "allTasks"];
	    const normalizeOrder = (arr: any): string[] => {
	      const uniq: string[] = [];
	      const seen = new Set<string>();
	      for (const x of Array.isArray(arr) ? arr : []) {
	        const id = String(x ?? "").trim();
	        if (!id) continue;
	        if (seen.has(id)) continue;
	        seen.add(id);
	        uniq.push(id);
	      }
	      // 补齐缺失项（保持 defaultOrder 的相对顺序）
	      for (const id of defaultOrder) {
	        if (!seen.has(id)) uniq.push(id);
	      }
	      // 仅保留合法的内置 ID
	      return uniq.filter((id) => defaultOrder.includes(id));
	    };
	    (tp as any).builtinListOrder = normalizeOrder((tp as any).builtinListOrder);

	    const listDefMap = new Map(listDefs.map((x) => [x.id, x] as const));
	    const listDefsOrdered = ((tp as any).builtinListOrder as string[])
	      .map((id) => listDefMap.get(id))
	      .filter(Boolean) as Array<{ id: string; title: string; desc: string }>;

    const getBL = (id: string) => (tp.builtinLists as any)[id] as any;

    // 表格化展示：一行一个清单
    const tableWrap = taskWrap.createDiv({ cls: "rslatte-tasklist-table-wrap" });
    const table = tableWrap.createEl("table", { cls: "rslatte-tasklist-table" });
    const thead = table.createEl("thead");
    const hr = thead.createEl("tr");
    hr.createEl("th", { text: "清单名" });
    hr.createEl("th", { text: "是否展示" });
    hr.createEl("th", { text: "最大展示数量" });
    hr.createEl("th", { text: "排列顺序" });
	    hr.createEl("th", { text: "显示顺序" });
	    hr.createEl("th", { text: "默认收起" });

    const tbody = table.createEl("tbody");

    const makeNumberInput = (parent: HTMLElement, value: number, onCommit: (n: number) => Promise<void>) => {
      const input = parent.createEl("input");
      input.type = "number";
      input.min = "1";
      input.max = "30";
      input.step = "1";
      input.value = String(value);
      input.classList.add("rslatte-tasklist-num");
      const commit = async () => {
        const n = Number(input.value);
        const nn = Number.isFinite(n) ? Math.min(Math.max(n, 1), 30) : 20;
        input.value = String(nn);
        await onCommit(nn);
      };
      input.addEventListener("change", () => void commit());
      input.addEventListener("blur", () => void commit());
      return input;
    };

    const makeSelect = (parent: HTMLElement, options: Array<{ value: string; label: string }>, value: string, onCommit: (v: string) => Promise<void>) => {
      const sel = parent.createEl("select");
      sel.classList.add("dropdown");
      options.forEach((o) => {
        const opt = sel.createEl("option", { text: o.label });
        opt.value = o.value;
      });
      sel.value = value;
      sel.addEventListener("change", () => void onCommit(sel.value));
      return sel;
    };

	    listDefsOrdered.forEach((li) => {
      const cfg = getBL(li.id);
      const tr = tbody.createEl("tr");

      // 清单名（含说明）
      const tdName = tr.createEl("td", { cls: "rslatte-tasklist-name" });
      tdName.createEl("div", { text: li.title, cls: "rslatte-tasklist-title" });
      tdName.createEl("div", { text: li.desc, cls: "rslatte-tasklist-desc" });

      // 是否展示
      const tdEnable = tr.createEl("td", { cls: "rslatte-tasklist-enable" });
      const chk = tdEnable.createEl("input");
      chk.type = "checkbox";
      chk.checked = cfg.enabled ?? true;
      chk.addEventListener("change", () => {
        cfg.enabled = chk.checked;
        void tab.saveAndRefreshSidePanelDebounced();
      });

      // 最大展示数量
      const tdMax = tr.createEl("td", { cls: "rslatte-tasklist-max" });
      makeNumberInput(tdMax, Number(cfg.maxItems ?? 20), async (nn) => {
        cfg.maxItems = nn;
        await tab.saveAndRefreshSidePanelDebounced();
      });

      // 排列顺序：字段 + 升序/降序
      const tdSort = tr.createEl("td", { cls: "rslatte-tasklist-sort" });
      const fieldSel = makeSelect(
        tdSort,
        Object.entries(fieldOptions).map(([k, v]) => ({ value: k, label: v })),
        cfg.sortField ?? "due",
        async (v) => {
          cfg.sortField = v as any;
          await tab.saveAndRefreshSidePanelDebounced();
        }
      );
      fieldSel.classList.add("rslatte-tasklist-sort-field");

      const orderSel = makeSelect(
        tdSort,
        [
          { value: "asc", label: "升序" },
          { value: "desc", label: "降序" },
        ],
        cfg.sortOrder ?? "asc",
        async (v) => {
          cfg.sortOrder = v as any;
          await tab.saveAndRefreshSidePanelDebounced();
        }
      );
      orderSel.classList.add("rslatte-tasklist-sort-order");

	      // 显示顺序（↑↓）：修改 builtinListOrder 并重绘设置表
	      const tdOrder = tr.createEl("td", { cls: "rslatte-tasklist-order" });
	      const curOrder = (tp as any).builtinListOrder as string[];
	      const idx = curOrder.indexOf(li.id);
	      const upBtn = tdOrder.createEl("button", { text: "↑", cls: "rslatte-icon-btn" });
	      upBtn.title = "上移";
	      upBtn.disabled = idx <= 0;
	      upBtn.onclick = async () => {
	        const arr = [...((tp as any).builtinListOrder as string[])];
	        const i = arr.indexOf(li.id);
	        if (i <= 0) return;
	        [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
	        (tp as any).builtinListOrder = normalizeOrder(arr);
	        await tab.saveAndRerender();
	      };

	      const downBtn = tdOrder.createEl("button", { text: "↓", cls: "rslatte-icon-btn" });
	      downBtn.title = "下移";
	      downBtn.disabled = idx < 0 || idx >= curOrder.length - 1;
	      downBtn.onclick = async () => {
	        const arr = [...((tp as any).builtinListOrder as string[])];
	        const i = arr.indexOf(li.id);
	        if (i < 0 || i >= arr.length - 1) return;
	        [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
	        (tp as any).builtinListOrder = normalizeOrder(arr);
	        await tab.saveAndRerender();
	      };
	      
	      // 默认收起（所有清单都支持）
	      const tdCollapsed = tr.createEl("td", { cls: "rslatte-tasklist-collapsed" });
	      const collapsedChk = tdCollapsed.createEl("input");
	      collapsedChk.type = "checkbox";
	      collapsedChk.checked = cfg.defaultCollapsed ?? false;
	      collapsedChk.addEventListener("change", () => {
	        cfg.defaultCollapsed = collapsedChk.checked;
	        void tab.saveAndRefreshSidePanelDebounced();
	      });
    });

    // =========================
    // Side Panel 3：项目管理
    // =========================
  } catch (e: any) {
    console.error("[RSLatte][settings][renderTaskSettings] render failed", e);
    try { new Notice("设置渲染失败（renderTaskSettings），请查看 Console"); } catch {}
  }
}
