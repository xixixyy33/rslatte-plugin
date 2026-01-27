// Auto-split from RSLatteSettingTab.ts to reduce file size and isolate failures.
import { Notice, Setting } from "obsidian";

export type ModuleWrapFactory = (moduleKey: any, title: string) => HTMLElement;
export type HeaderButtonsVisibilityAdder = (wrap: HTMLElement, moduleKey: any, defaultShow: boolean) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderMemoSettings(opts: {
  tab: any;
  makeModuleWrap: ModuleWrapFactory;
  addHeaderButtonsVisibilitySetting: HeaderButtonsVisibilityAdder;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addUiHeaderButtonsVisibilitySetting?: any;
}): void {
  const { tab, makeModuleWrap, addHeaderButtonsVisibilitySetting } = opts;
  const plugin = tab.plugin;
  const tp = plugin?.settings?.taskPanel as any;
  try {
    const memoWrap = makeModuleWrap('memo', '备忘管理');
    addHeaderButtonsVisibilitySetting(memoWrap, "memo", true);

      new Setting(memoWrap)
      .setName("重要事项（备忘）展示范围")
      .setDesc("侧边栏默认展示：今天 + 未来 N 天")
      .addText((t) =>
        t.setPlaceholder("7")
          .setValue(String(tp.memoLookaheadDays ?? 7))
          .onChange(async (v) => {
            const n = Number(v);
            tp.memoLookaheadDays = Number.isFinite(n) ? Math.max(0, Math.min(365, Math.floor(n))) : 7;
            await tab.saveAndRefreshSidePanelDebounced();
          })
      );


    new Setting(memoWrap)
      .setName("在 RSLatte 侧边栏显示重要事项")
      .setDesc("显示位置：Side Panel 1 → 📅 今日日志 下方")
      .addToggle((tog) =>
        tog.setValue(tp.showImportantMemosInRSLattePanel ?? true)
          .onChange(async (v) => {
            tp.showImportantMemosInRSLattePanel = v;
            await tab.saveAndRefreshSidePanelDebounced();
          })
      );


    // ===== v28：全量备忘清单 =====
    memoWrap.createEl("h5", { text: "全量备忘清单（v28）" });

    new Setting(memoWrap)
      .setName("启用全量备忘清单")
      .setDesc("显示在“事项提醒”下方，便于集中管理所有备忘条目。")
      .addToggle((tog) =>
        tog.setValue(tp.memoAllEnabled ?? true)
          .onChange(async (v) => {
            tp.memoAllEnabled = v;
            await tab.saveAndRefreshSidePanelDebounced();
          })
      );

    new Setting(memoWrap)
      .setName("全量备忘清单最大展示条数")
      .setDesc("侧边栏最多展示多少条（仍会显示过滤后的总数）。")
      .addText((t) =>
        t.setPlaceholder("50")
          .setValue(String(tp.memoAllMaxItems ?? 50))
          .onChange(async (v) => {
            const n = Number(v);
            tp.memoAllMaxItems = Number.isFinite(n) ? Math.max(1, Math.min(200, Math.floor(n))) : 50;
            await tab.saveAndRefreshSidePanelDebounced();
          })
      );

    const ensureMemoAllStatuses = () => {
      const arr = Array.isArray(tp.memoAllStatuses) ? tp.memoAllStatuses : ["TODO", "IN_PROGRESS"];
      const mapped = arr.map((x: any) => String(x || "").trim().toUpperCase());
      const norm = Array.from<string>(new Set<string>(mapped));
      const allowed = new Set<string>(["DONE", "CANCELLED", "TODO", "IN_PROGRESS"]);
      tp.memoAllStatuses = norm.filter((x: string) => allowed.has(x)) as any;
      if (!tp.memoAllStatuses.length) tp.memoAllStatuses = ["TODO", "IN_PROGRESS"] as any;
    };
    ensureMemoAllStatuses();

      // 状态过滤（多选）——样式对齐“输出管理”的列表展示状态
      const statusBox = memoWrap.createDiv({ cls: "rslatte-status-filter" });
    statusBox.createEl("div", { text: "展示状态：", cls: "setting-item-name" });
    const statuses = [
      { key: "TODO" as const, label: "TODO（⏸）" },
      { key: "IN_PROGRESS" as const, label: "IN_PROGRESS（▶）" },
      { key: "DONE" as const, label: "DONE（✅）" },
      { key: "CANCELLED" as const, label: "CANCELLED（⛔）" },
    ];
    const stWrap = statusBox.createDiv({ cls: "rslatte-status-filter-wrap" });
    const setShow = async (st: "DONE" | "CANCELLED" | "TODO" | "IN_PROGRESS", on: boolean) => {
      ensureMemoAllStatuses();
      const cur = new Set<string>(((tp.memoAllStatuses ?? ["TODO", "IN_PROGRESS"]) as any).map((x: any) => String(x)));
      if (on) cur.add(st);
      else cur.delete(st);
      tp.memoAllStatuses = Array.from(cur) as any;
      await tab.saveAndRefreshSidePanelDebounced();
    };
    const has = (st: string): boolean => {
      return ((tp.memoAllStatuses ?? ["TODO", "IN_PROGRESS"]) as any).map((x: any) => String(x)).includes(st);
    };
    for (const st of statuses) {
      const lb = stWrap.createEl("label", { cls: "rslatte-status-filter-item" });
      const cb = lb.createEl("input");
      cb.type = "checkbox";
      cb.checked = has(st.key);
      cb.addEventListener("change", () => void setShow(st.key, cb.checked));
      lb.appendText(" " + st.label);
    }

  } catch (e: any) {
    console.error("[RSLatte][settings][renderMemoSettings] render failed", e);
    try { new Notice("设置渲染失败（renderMemoSettings），请查看 Console"); } catch {}
  }
}
