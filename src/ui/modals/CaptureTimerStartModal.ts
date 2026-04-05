import { App, ButtonComponent, DropdownComponent, Modal, Notice, Setting } from "obsidian";

export type CaptureTimerLinkKind = "none" | "task" | "output";

export type CaptureTimerStartPayload = {
  purpose: string;
  linkKind: CaptureTimerLinkKind;
  linkedTaskUid?: string;
  linkedOutputId?: string;
};

export type CaptureTimerStartTaskOption = {
  uid: string;
  text: string;
  taskType?: "task" | "project_task";
  plannedEnd?: string;
  sectionLabel?: string;
};

export type CaptureTimerStartOutputOption = {
  outputId: string;
  title: string;
  folderHint: string;
  isProject: boolean;
};

export class CaptureTimerStartModal extends Modal {
  constructor(
    app: App,
    private taskOptions: CaptureTimerStartTaskOption[],
    private outputOptions: CaptureTimerStartOutputOption[],
    private onStart: (payload: CaptureTimerStartPayload) => Promise<void> | void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("⏳ 即时计时");

    let purpose = "";
    let linkKind: CaptureTimerLinkKind = "none";
    let linkedTaskUid: string | undefined;
    let linkedOutputId: string | undefined;
    let startBtn!: ButtonComponent;

    const refresh = () => {
      const hasAssoc =
        (linkKind === "task" && !!linkedTaskUid) || (linkKind === "output" && !!linkedOutputId);
      const ok = !!purpose.trim() || hasAssoc;
      startBtn?.setDisabled(!ok);
    };

    new Setting(contentEl)
      .setName("关联类型")
      .setDesc("默认不关联；选「任务」或「输出」后展开对应清单（节省弹窗空间）。")
      .addDropdown((dd: DropdownComponent) => {
        dd.addOption("none", "无");
        dd.addOption("task", "任务");
        dd.addOption("output", "输出");
        dd.setValue(linkKind);
        dd.onChange((v) => {
          linkKind = (v as CaptureTimerLinkKind) || "none";
          if (linkKind !== "task") linkedTaskUid = undefined;
          if (linkKind !== "output") linkedOutputId = undefined;
          rebuildAssocSection();
          refresh();
        });
      });

    const assocHost = contentEl.createDiv({ cls: "rslatte-capture-timer-assoc-host" });

    let searchQuery = "";
    let outputSearchQuery = "";

    const matchesTaskSearch = (item: CaptureTimerStartTaskOption, q: string): boolean => {
      const s = q.trim().toLowerCase();
      if (!s) return true;
      const typeLabel = item.taskType === "project_task" ? "项目任务" : "任务";
      const hay = [item.text, item.uid, item.sectionLabel ?? "", item.plannedEnd ?? "", typeLabel]
        .join("\n")
        .toLowerCase();
      return hay.includes(s);
    };

    const matchesOutputSearch = (item: CaptureTimerStartOutputOption, q: string): boolean => {
      const s = q.trim().toLowerCase();
      if (!s) return true;
      const kind = item.isProject ? "项目输出" : "输出";
      return `${kind}\n${item.title}\n${item.outputId}\n${item.folderHint}`.toLowerCase().includes(s);
    };

    const rebuildTaskList = (list: HTMLElement) => {
      list.empty();
      if (this.taskOptions.length === 0) {
        list.createDiv({ cls: "rslatte-capture-timer-task-empty", text: "暂无活跃任务" });
        return;
      }
      const filtered = this.taskOptions.filter((it) => matchesTaskSearch(it, searchQuery));
      if (filtered.length === 0) {
        list.createDiv({
          cls: "rslatte-capture-timer-task-empty",
          text: searchQuery.trim() ? "没有匹配当前关键字的任务" : "暂无活跃任务",
        });
        return;
      }
      for (const item of filtered) {
        const btn = list.createEl("button", {
          cls: "rslatte-capture-timer-task-item",
          type: "button",
          title: item.text || item.uid,
        });
        btn.createSpan({
          cls: `rslatte-capture-timer-task-type-tag ${item.taskType === "project_task" ? "is-project-task" : "is-task"}`,
          text: item.taskType === "project_task" ? "项目任务" : "任务",
        });
        btn.createSpan({
          cls: "rslatte-capture-timer-task-item-text",
          text: item.text || item.uid,
        });
        const badge = btn.createSpan({
          cls: "rslatte-capture-timer-task-item-badge",
          text: item.sectionLabel ? ` · ${item.sectionLabel}` : "",
        });
        if (!item.sectionLabel) badge.remove();
        if (linkedTaskUid === item.uid) btn.addClass("is-selected");
        btn.onclick = () => {
          if (linkedTaskUid === item.uid) {
            linkedTaskUid = undefined;
            btn.removeClass("is-selected");
          } else {
            linkedTaskUid = item.uid;
            list.querySelectorAll(".rslatte-capture-timer-task-item.is-selected").forEach((el) => {
              el.removeClass("is-selected");
            });
            btn.addClass("is-selected");
          }
          refresh();
        };
      }
    };

    const rebuildOutputList = (list: HTMLElement) => {
      list.empty();
      if (this.outputOptions.length === 0) {
        list.createDiv({ cls: "rslatte-capture-timer-task-empty", text: "暂无进行中/待办输出（可先刷新输出索引）" });
        return;
      }
      const filtered = this.outputOptions.filter((it) => matchesOutputSearch(it, outputSearchQuery));
      const show = filtered.slice(0, 30);
      if (!show.length) {
        list.createDiv({
          cls: "rslatte-capture-timer-task-empty",
          text: outputSearchQuery.trim() ? "没有匹配当前关键字的输出" : "暂无输出",
        });
        return;
      }
      for (const item of show) {
        const btn = list.createEl("button", {
          cls: "rslatte-capture-timer-task-item rslatte-capture-timer-output-item",
          type: "button",
          title: `${item.title}\n${item.folderHint}\n${item.outputId}`,
        });
        btn.createSpan({
          cls: `rslatte-capture-timer-output-kind-tag ${item.isProject ? "is-project" : "is-general"}`,
          text: item.isProject ? "项目输出" : "输出",
        });
        const mid = btn.createDiv({ cls: "rslatte-capture-timer-output-item-mid" });
        mid.createSpan({ cls: "rslatte-capture-timer-output-item-title", text: item.title });
        mid.createSpan({ cls: "rslatte-capture-timer-output-item-folder", text: item.folderHint || "—" });
        if (linkedOutputId === item.outputId) btn.addClass("is-selected");
        btn.onclick = () => {
          if (linkedOutputId === item.outputId) {
            linkedOutputId = undefined;
            btn.removeClass("is-selected");
          } else {
            linkedOutputId = item.outputId;
            list.querySelectorAll(".rslatte-capture-timer-output-item.is-selected").forEach((el) => {
              el.removeClass("is-selected");
            });
            btn.addClass("is-selected");
          }
          refresh();
        };
      }
    };

    const rebuildAssocSection = () => {
      assocHost.empty();
      if (linkKind === "task") {
        let list!: HTMLElement;
        new Setting(assocHost)
          .setName("关联任务（可选）")
          .setDesc("从当前活跃任务中点选；已选任务时可不填计时目的。")
          .addText((t) => {
            t.setPlaceholder("关键字过滤…");
            t.inputEl.classList.add("rslatte-capture-timer-task-search");
            t.inputEl.setAttribute("aria-label", "按关键字过滤任务列表");
            t.onChange((v) => {
              searchQuery = String(v ?? "");
              rebuildTaskList(list);
            });
          });
        const taskWrap = assocHost.createDiv({ cls: "rslatte-capture-timer-task-picker-wrap" });
        list = taskWrap.createDiv({ cls: "rslatte-capture-timer-task-list" });
        rebuildTaskList(list);
      } else if (linkKind === "output") {
        let list!: HTMLElement;
        new Setting(assocHost)
          .setName("关联输出（可选）")
          .setDesc("默认展示最多 30 条进行中/待办输出；可关键字过滤。")
          .addText((t) => {
            t.setPlaceholder("关键字过滤…");
            t.inputEl.classList.add("rslatte-capture-timer-task-search");
            t.inputEl.setAttribute("aria-label", "按关键字过滤输出列表");
            t.onChange((v) => {
              outputSearchQuery = String(v ?? "");
              rebuildOutputList(list);
            });
          });
        const outWrap = assocHost.createDiv({ cls: "rslatte-capture-timer-task-picker-wrap" });
        list = outWrap.createDiv({ cls: "rslatte-capture-timer-task-list" });
        rebuildOutputList(list);
      }
      refresh();
    };

    rebuildAssocSection();

    new Setting(contentEl)
      .setName("计时目的（可选）")
      .setDesc("填写本次计时要做什么；已关联任务或输出时可留空。")
      .addText((t) => {
        t.inputEl.setAttribute("aria-label", "计时目的");
        t.setPlaceholder("例如：筛选一台符合需求的相机");
        t.onChange((v) => {
          purpose = String(v ?? "");
          refresh();
        });
      });

    contentEl.createDiv({
      cls: "rslatte-capture-timer-start-hint rslatte-muted",
      text: "ℹ️ 计时器结束时会生成对应日程，至少需要 5 分钟",
    });

    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });
    startBtn = new ButtonComponent(btnRow)
      .setButtonText("开始计时")
      .setCta()
      .onClick(async () => {
        const hasAssoc =
          (linkKind === "task" && !!linkedTaskUid) || (linkKind === "output" && !!linkedOutputId);
        if (!purpose.trim() && !hasAssoc) {
          new Notice("请填写计时目的，或选择关联任务/输出");
          return;
        }
        await this.onStart({
          purpose: purpose.trim(),
          linkKind,
          linkedTaskUid: linkKind === "task" ? linkedTaskUid : undefined,
          linkedOutputId: linkKind === "output" ? linkedOutputId : undefined,
        });
        this.close();
      });
    new ButtonComponent(btnRow).setButtonText("取消").onClick(() => this.close());
    refresh();
  }
}
