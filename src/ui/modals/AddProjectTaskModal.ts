import { App, ButtonComponent, Modal, Notice, Setting, TextAreaComponent, TextComponent } from "obsidian";

import type RSLattePlugin from "../../main";

/**
 * 新增“项目任务”或“子里程碑”（插入到指定项目的指定里程碑下）
 * 支持切换：任务描述、到期日期(due，必填)、开始日期(start)、计划日期(scheduled)
 * 或：里程碑名称、层级（自动计算为当前层级+1）
 */
export class AddProjectTaskModal extends Modal {
  constructor(
    app: App,
    private plugin: RSLattePlugin,
    private projectFolderPath: string,
    private milestoneName: string,
    private milestoneLevel?: number,
    private milestonePath?: string
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    
    // 切换模式：'task' 或 'milestone'
    let mode: "task" | "milestone" = "task";
    
    // ===== 任务相关状态 =====
    let text = "";
    const today = (() => {
      try {
        // @ts-ignore
        const m = (window as any).moment?.();
        if (m?.format) return m.format("YYYY-MM-DD");
      } catch {
        // ignore
      }
      const d = new Date();
      const yyyy = String(d.getFullYear());
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}`;
    })();
    let due = today;
    let start = "";
    let scheduled = "";

    // ===== 里程碑相关状态 =====
    let newMilestoneName = "";
    const currentLevel = Math.max(1, Math.min(3, Number(this.milestoneLevel ?? 1) || 1));
    const childLevel = Math.min(3, currentLevel + 1) as 1 | 2 | 3;
    const parentPath = String(this.milestonePath ?? this.milestoneName ?? "").trim();

    // ===== UI 组件 =====
    let textInput!: TextAreaComponent;
    let milestoneNameInput!: TextComponent;
    let saveBtn!: ButtonComponent;
    let taskFormContainer!: HTMLElement;
    let milestoneFormContainer!: HTMLElement;

    const isValidYmd = (s: string) => !s || /^\d{4}-\d{2}-\d{2}$/.test(s);

    const refresh = () => {
      if (mode === "task") {
        const dueOk = /^\d{4}-\d{2}-\d{2}$/.test((due ?? "").trim());
        const startOk = isValidYmd((start ?? "").trim());
        const scheduledOk = isValidYmd((scheduled ?? "").trim());
        const ok = (text ?? "").trim().length > 0 && dueOk && startOk && scheduledOk;
        saveBtn?.setDisabled(!ok);
        textInput?.inputEl?.classList.toggle("is-invalid", !(text ?? "").trim());
        return ok;
      } else {
        // milestone mode
        const ok = (newMilestoneName ?? "").trim().length > 0 && childLevel <= 3;
        saveBtn?.setDisabled(!ok);
        milestoneNameInput?.inputEl?.classList.toggle("is-invalid", !(newMilestoneName ?? "").trim());
        return ok;
      }
    };

    const switchMode = (newMode: "task" | "milestone") => {
      mode = newMode;
      if (newMode === "task") {
        this.titleEl.setText("新增项目任务");
        taskFormContainer.style.display = "";
        milestoneFormContainer.style.display = "none";
      } else {
        this.titleEl.setText("新增子里程碑");
        taskFormContainer.style.display = "none";
        milestoneFormContainer.style.display = "";
      }
      refresh();
      window.setTimeout(() => {
        if (newMode === "task") {
          textInput?.inputEl?.focus();
        } else {
          milestoneNameInput?.inputEl?.focus();
        }
      }, 0);
    };

    // ===== 切换按钮 =====
    const switchRow = contentEl.createDiv({ cls: "rslatte-modal-switch-row" });
    switchRow.style.display = "flex";
    switchRow.style.gap = "8px";
    switchRow.style.marginBottom = "16px";
    switchRow.style.paddingBottom = "12px";
    switchRow.style.borderBottom = "1px solid var(--background-modifier-border)";

    const taskBtn = switchRow.createEl("button", {
      text: "📋 新增任务",
      cls: "mod-cta",
    });
    taskBtn.style.flex = "1";
    taskBtn.onclick = () => switchMode("task");

    const milestoneBtn = switchRow.createEl("button", {
      text: "🏁 新增里程碑",
    });
    milestoneBtn.style.flex = "1";
    milestoneBtn.onclick = () => switchMode("milestone");

    // ===== 任务表单容器 =====
    taskFormContainer = contentEl.createDiv();
    const descSetting = new Setting(taskFormContainer)
      .setName("任务描述*")
      .setDesc("只允许单行（回车会被替换为空格），超长内容会自动换行显示")
      .addTextArea((ta) => {
        textInput = ta;
        ta.setValue(text);
        ta.inputEl.rows = 3;
        // wrap display, but still enforce single-line content
        // @ts-ignore
        ta.inputEl.wrap = "soft";
        ta.inputEl.style.whiteSpace = "pre-wrap";
        // allow long tokens to wrap in narrow side panels
        // @ts-ignore
        ta.inputEl.style.overflowWrap = "anywhere";
        // @ts-ignore
        ta.inputEl.style.wordBreak = "break-word";
        ta.inputEl.style.overflowX = "hidden";
        ta.inputEl.style.resize = "vertical";
        ta.inputEl.addEventListener("input", () => {
          // enforce single line
          const cleaned = String(ta.getValue() ?? "")
            .replace(/[\r\n]+/g, " ")
            .replace(/\s{2,}/g, " ");
          if (cleaned !== ta.getValue()) {
            const pos = ta.inputEl.selectionStart ?? cleaned.length;
            ta.setValue(cleaned);
            try {
              ta.inputEl.setSelectionRange(pos, pos);
            } catch {}
          }
          text = cleaned;
          refresh();
        });
        ta.inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            void doSave();
          }
        });
      });

    // 🪪 Insert contact reference (append to end)
    const insertRow = descSetting.controlEl.createDiv({ cls: "rslatte-inline-insert-row" });
    insertRow.style.display = "flex";
    insertRow.style.justifyContent = "flex-end";
    insertRow.style.marginTop = "6px";
    new ButtonComponent(insertRow)
      .setButtonText("🪪 插入联系人")
      .onClick(() => {
        void this.plugin.openContactReferencePicker((ref) => {
          try {
            const cur = textInput?.getValue?.() ?? "";
            const sep = cur && !/\s$/.test(cur) ? " " : "";
            const next = `${cur}${sep}${ref} `;
            textInput?.setValue?.(next);
            text = next;
            refresh();
            const el = textInput?.inputEl;
            if (el) {
              el.focus();
              try { el.setSelectionRange(next.length, next.length); } catch {}
            }
          } catch (e) {
            console.warn("[RSLatte][projectTask][insertContact] failed", e);
            new Notice("插入联系人失败");
          }
        });
      });

    new Setting(contentEl)
      .setName("到期日期*")
      .addText((t) => {
        t.inputEl.type = "date";
        t.setValue(today);
        t.onChange((v) => {
          due = (v ?? "").trim();
          t.inputEl.classList.toggle("is-invalid", !/^\d{4}-\d{2}-\d{2}$/.test(due));
          refresh();
        });
        t.inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            void doSave();
          }
        });
      });

    new Setting(taskFormContainer)
      .setName("开始日期")
      .addText((t) => {
        t.inputEl.type = "date";
        t.setValue("");
        t.onChange((v) => {
          start = (v ?? "").trim();
          t.inputEl.classList.toggle("is-invalid", !isValidYmd(start));
          refresh();
        });
        t.inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            void doSave();
          }
        });
      });

    new Setting(taskFormContainer)
      .setName("计划日期")
      .addText((t) => {
        t.inputEl.type = "date";
        t.setValue("");
        t.onChange((v) => {
          scheduled = (v ?? "").trim();
          t.inputEl.classList.toggle("is-invalid", !isValidYmd(scheduled));
          refresh();
        });
        t.inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            void doSave();
          }
        });
      });

    const hint = taskFormContainer.createDiv({ cls: "rslatte-project-hint" });
    hint.setText(`将插入到里程碑：${this.milestoneName}`);

    // ===== 里程碑表单容器 =====
    milestoneFormContainer = contentEl.createDiv();
    milestoneFormContainer.style.display = "none";

    new Setting(milestoneFormContainer)
      .setName("里程碑名称*")
      .setDesc(`将写入项目任务清单为标题：${"#".repeat(childLevel)}`)
      .addText((t) => {
        milestoneNameInput = t;
        t.setPlaceholder("例如：需求确认");
        t.onChange((v) => {
          newMilestoneName = v ?? "";
          refresh();
        });
        t.inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            void doSave();
          }
        });
      });

    const milestoneHint = milestoneFormContainer.createDiv({ cls: "rslatte-project-hint" });
    milestoneHint.innerHTML = `
      <div>将作为 <strong>${"#".repeat(childLevel)}</strong> 级里程碑插入到：<strong>${parentPath}</strong></div>
      ${childLevel >= 3 ? '<div style="color: var(--text-warning); margin-top: 4px;">⚠️ 已达到最大层级（三级），无法继续添加子里程碑</div>' : ""}
    `;

    // ===== 操作按钮 =====
    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });
    saveBtn = new ButtonComponent(btnRow).setButtonText("保存").setCta().onClick(() => void doSave());
    new ButtonComponent(btnRow).setButtonText("关闭").onClick(() => this.close());

    const doSave = async () => {
      if (!refresh()) return;

      try {
        if (mode === "task") {
          const dueTrim = (due ?? "").trim();
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dueTrim)) {
            new Notice("到期日期为必填，且格式必须为 YYYY-MM-DD");
            return;
          }

          await this.plugin.projectMgr.addTaskToMilestone(
            this.projectFolderPath,
            this.milestoneName,
            (text ?? "").trim(),
            dueTrim,
            (start ?? "").trim(),
            (scheduled ?? "").trim()
          );

          new Notice("已新增项目任务");
        } else {
          // milestone mode
          if (childLevel > 3) {
            new Notice("已达到最大层级（三级），无法继续添加子里程碑");
            return;
          }

          await this.plugin.projectMgr.addMilestone(
            this.projectFolderPath,
            (newMilestoneName ?? "").trim(),
            {
              level: childLevel,
              parentPath: parentPath || undefined,
            }
          );

          new Notice("已新增子里程碑");
        }

        this.plugin.refreshSidePanel();
        this.close();
      } catch (e: any) {
        new Notice(`写入失败：${e?.message ?? String(e)}`);
      }
    };

    // 更新切换按钮样式
    const updateSwitchButtons = () => {
      if (mode === "task") {
        taskBtn.classList.add("mod-cta");
        milestoneBtn.classList.remove("mod-cta");
      } else {
        taskBtn.classList.remove("mod-cta");
        milestoneBtn.classList.add("mod-cta");
      }
    };

    // 包装 switchMode 以更新按钮样式
    const originalSwitchMode = switchMode;
    const wrappedSwitchMode = (newMode: "task" | "milestone") => {
      originalSwitchMode(newMode);
      updateSwitchButtons();
    };

    // 更新按钮点击事件
    taskBtn.onclick = () => wrappedSwitchMode("task");
    milestoneBtn.onclick = () => wrappedSwitchMode("milestone");

    // 初始化：默认显示任务表单
    wrappedSwitchMode("task");

    window.setTimeout(() => {
      textInput?.inputEl?.focus();
      refresh();
    }, 0);
  }
}
