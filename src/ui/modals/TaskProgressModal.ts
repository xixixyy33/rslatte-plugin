import { App, ButtonComponent, Modal, Notice, Setting, TextComponent } from "obsidian";

import type RSLattePlugin from "../../main";
import type { RSLatteIndexItem } from "../../taskRSLatte/types";
import { writeTaskApplyStatusWithProgress, writeTaskPostpone } from "../../services/execution/taskWriteFacade";
import { EXECUTION_RECIPE } from "../../services/execution/executionOrchestrator";
import { buildWorkEventUiAction } from "../../services/execution/buildExecutionWorkEvents";
import { runExecutionFlowUi } from "../helpers/runExecutionFlowUi";
import { displayPhaseAfterTaskCheckbox, indexItemTaskDisplayPhase } from "../../taskRSLatte/utils";

export type TaskProgressModalMode = "start" | "waiting_others" | "waiting_until" | "done" | "postpone";

export class TaskProgressModal extends Modal {
  constructor(
    app: App,
    private plugin: RSLattePlugin,
    private item: RSLatteIndexItem,
    private mode: TaskProgressModalMode,
    private onSuccess: () => void | Promise<void>
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("rslatte-modal");

    const titles: Record<TaskProgressModalMode, string> = {
      start: "开始处理任务",
      waiting_others: "等待他人处理",
      waiting_until: "进入等待状态",
      done: "完成任务",
      postpone: "延期",
    };
    this.titleEl.setText(titles[this.mode]);

    const historyProgressNote = String((this.item as any).progress_note ?? "").trim();
    let latestProgress = "";
    let waitUntil = "";
    let followUp = "";
    let followContactUidsStr = Array.isArray((this.item as any).followContactUids) ? (this.item as any).followContactUids.join(",") : "";
    const followContactNameByUid: Record<string, string> = {};
    {
      const uids = Array.isArray((this.item as any).follow_contact_uids) ? (this.item as any).follow_contact_uids : [];
      const names = Array.isArray((this.item as any).follow_contact_names) ? (this.item as any).follow_contact_names : [];
      for (let i = 0; i < Math.min(uids.length, names.length); i++) {
        const uid = String(uids[i] ?? "").trim();
        const nm = String(names[i] ?? "").trim();
        if (uid && nm) followContactNameByUid[uid] = nm;
      }
    }
    let postponeDays = "1";
    let postponeReason = "";

    const estExisting = (this.item as any).estimate_h;
    let estimateHoursStr =
      estExisting != null && estExisting !== "" && Number(estExisting) > 0 ? String(estExisting) : "";

    let latestProgressInput!: TextComponent;
    let estimateHoursInput!: TextComponent;
    let daysInput!: TextComponent;
    let saveBtn!: ButtonComponent;

    const today = (() => {
      try {
        const m = (window as any).moment?.();
        if (m?.format) return m.format("YYYY-MM-DD");
      } catch {}
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    })();

    const tomorrow = (() => {
      try {
        const m = (window as any).moment?.();
        if (m?.add?.().format) return (m as any).add(1, "day").format("YYYY-MM-DD");
      } catch {}
      const d = new Date();
      d.setDate(d.getDate() + 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    })();

    const nowStr = (() => {
      try {
        const m = (window as any).moment?.();
        if (m?.format) return m.format("YYYY-MM-DD HH:mm");
      } catch {}
      const d = new Date();
      const ymd = today;
      const h = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return `${ymd} ${h}:${mm}`;
    })();

    // 「进入等待状态」：日期控件默认显示 today，但须同步到变量，否则用户不改动日期时 wait_until 不会写入 meta
    if (this.mode === "waiting_until") {
      const existing = String((this.item as any).wait_until ?? "")
        .trim()
        .match(/^(\d{4}-\d{2}-\d{2})/);
      waitUntil = existing ? existing[1] : today;
    }

    const statusLabelByMode: Record<TaskProgressModalMode, string> = {
      start: "处理中",
      waiting_others: "跟进中",
      waiting_until: "等待中",
      done: "已完成",
      postpone: "",
    };

    const refresh = () => {
      let ok = true;
      if (this.mode === "waiting_until" && (!waitUntil || !/^\d{4}-\d{2}-\d{2}$/.test(waitUntil))) ok = false;
      if (this.mode === "waiting_others" && followUp && !/^\d{4}-\d{2}-\d{2}$/.test(followUp)) ok = false;
      if (this.mode === "postpone") {
        const d = parseInt(String(postponeDays).trim(), 10);
        if (!Number.isFinite(d) || d < 1) ok = false;
      }
      if (this.mode === "done") {
        const ev = parseFloat(String(estimateHoursStr ?? "").trim().replace(",", "."));
        if (!Number.isFinite(ev) || ev <= 0) ok = false;
      }
      saveBtn?.setDisabled(!ok);
      return ok;
    };

    if (this.mode === "postpone") {
      // 6-细7：不展示历史延期次数，仅记录在 meta
      new Setting(contentEl)
        .setName("延期天数*")
        .addText((t) => {
          daysInput = t;
          t.inputEl.type = "number";
          t.setValue(postponeDays);
          t.onChange((v) => {
            postponeDays = (v ?? "").trim();
            refresh();
          });
        });
      new Setting(contentEl)
        .setName("延期原因说明")
        .addTextArea((t) => {
          t.setValue(postponeReason);
          t.onChange((v) => {
            postponeReason = (v ?? "").trim();
            refresh();
          });
          t.inputEl.rows = 2;
        });
    } else {
      const historyLines = historyProgressNote ? historyProgressNote.split(/\s*\|\|\s*|\n/).filter(Boolean) : [];
      new Setting(contentEl)
        .setName("历史进度信息")
        .setDesc("只读，按时间与状态追加")
        .addTextArea((t) => {
          t.setValue(historyLines.join("\n") || "（暂无）");
          t.inputEl.rows = Math.min(4, Math.max(1, historyLines.length));
          t.inputEl.disabled = true;
          t.inputEl.style.minHeight = "60px";
        });

      new Setting(contentEl)
        .setName("最新进度信息")
        .setDesc("可选，单行填写后提交会追加到历史进度")
        .addText((t) => {
          latestProgressInput = t;
          t.setValue(latestProgress);
          t.setPlaceholder("例如：今日开始推进");
          t.onChange((v) => {
            latestProgress = (v ?? "").trim();
            refresh();
          });
        });

      if (this.mode === "done") {
        new Setting(contentEl)
          .setName("工时评估（小时）*")
          .setDesc("完成任务必填；若此前已填写可在此修改")
          .addText((t) => {
            estimateHoursInput = t;
            t.inputEl.type = "text";
            t.inputEl.inputMode = "decimal";
            t.setValue(estimateHoursStr);
            t.setPlaceholder("例如：2 或 1.5");
            t.onChange((v) => {
              estimateHoursStr = (v ?? "").trim();
              refresh();
            });
          });
      }

      if (this.mode === "waiting_until") {
        new Setting(contentEl)
          .setName("等待到期日*")
          .addText((t) => {
            t.inputEl.type = "date";
            t.setValue(waitUntil);
            t.onChange((v) => {
              waitUntil = (v ?? "").trim();
              refresh();
            });
          });
      }
      if (this.mode === "waiting_others") {
        new Setting(contentEl)
          .setName("下一次跟进时间")
          .setDesc("可选，默认明天，可改为其他日期并写入 meta")
          .addText((t) => {
            t.inputEl.type = "date";
            t.setValue(followUp || tomorrow);
            t.onChange((v) => {
              followUp = (v ?? "").trim();
              refresh();
            });
          });
      }
      if (this.mode === "waiting_others" || this.mode === "waiting_until") {
        const followContactRow = new Setting(contentEl)
          .setName("关联联系人（需跟进）")
          .setDesc("可选，选择后这些联系人在「跟进中/等待中」时会关注此任务");
        followContactRow.addText((t) => {
          t.setPlaceholder("UID 多个用逗号分隔，或点击右侧从通讯录选择");
          t.setValue(followContactUidsStr);
          t.onChange((v) => {
            followContactUidsStr = (v ?? "").trim();
          });
        });
        followContactRow.addButton((btn) => {
          btn.setButtonText("从通讯录选择").onClick(() => {
            (this.plugin as any).openContactReferencePicker?.((_ref: string, item: any) => {
              const uid = String(item?.contact_uid ?? "").trim();
              if (!uid) return;
              const cur = followContactUidsStr.split(/[,;\s]+/).map((s: string) => s.trim()).filter(Boolean);
              if (!cur.includes(uid)) cur.push(uid);
              followContactUidsStr = cur.join(",");
              const name = String(item?.display_name ?? item?.title ?? uid).trim();
              if (name) followContactNameByUid[uid] = name;
              const input = followContactRow.controlEl.querySelector("input");
              if (input) input.value = followContactUidsStr;
            });
          });
        });
      }
    }

    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });
    saveBtn = new ButtonComponent(btnRow).setButtonText("确认").setCta().onClick(() => void doSave());
    new ButtonComponent(btnRow).setButtonText("关闭").onClick(() => this.close());

    const doSave = async () => {
      if (!refresh()) return;

      try {
        if (this.mode === "postpone") {
          const d = parseInt(String(postponeDays).trim(), 10);
          if (!Number.isFinite(d) || d < 1) {
            new Notice("延期天数须为正整数");
            return;
          }
          await writeTaskPostpone(this.plugin.taskRSLatte, this.item as any, d, postponeReason || "无说明");
          const phSnap = indexItemTaskDisplayPhase(this.item as any);
          await runExecutionFlowUi(this.plugin, EXECUTION_RECIPE.updateTaskAndRefresh, {
            sync: this.plugin.isTaskDbSyncEnabledV2?.() ?? (this.plugin.settings.taskPanel.enableDbSync !== false),
            noticeOnError: true,
            workEvent: buildWorkEventUiAction({
              kind: "task",
              action: "update",
              summary: `↪ 延期任务 ${String(this.item.text ?? this.item.raw ?? "").trim() || "未命名任务"}`,
              ref: {
                uid: (this.item as any).uid,
                file_path: this.item.filePath,
                line_no: this.item.lineNo,
                days: d,
                task_phase_before: phSnap,
                task_phase_after: phSnap,
              },
              metrics: { postpone_days: d },
              taskContactEnrich: {
                taskLine: String((this.item as any).raw ?? this.item.text ?? ""),
                followContactUids: Array.isArray((this.item as any).follow_contact_uids)
                  ? (this.item as any).follow_contact_uids.map((x: string) => String(x ?? "").trim()).filter(Boolean)
                  : [],
              },
            }),
          }, { actionLabel: "延期任务" });
          new Notice("已延期");
        } else {
          let progressNoteToSave: string | undefined;
          const latest = (latestProgress ?? "").trim();
          if (latest) {
            const label = statusLabelByMode[this.mode] || "进度";
            const safeContent = latest.replace(/\s+/g, " ").replace(/;/g, "，");
            const newLine = `${nowStr} ${label} ${safeContent}`;
            progressNoteToSave = historyProgressNote ? `${historyProgressNote} || ${newLine}` : newLine;
          }
          const followContactUids = (this.mode === "waiting_others" || this.mode === "waiting_until")
            ? followContactUidsStr.split(/[,;\s]+/).map((s: string) => s.trim()).filter(Boolean)
            : undefined;
          const followContactNames = (this.mode === "waiting_others" || this.mode === "waiting_until")
            ? (followContactUids ?? []).map((uid: string) => {
                const n = String(followContactNameByUid[uid] ?? "").trim();
                return n || uid;
              })
            : undefined;
          let estimateHDone: number | undefined;
          if (this.mode === "done") {
            const ev = parseFloat(String(estimateHoursStr ?? "").trim().replace(",", "."));
            if (!Number.isFinite(ev) || ev <= 0) {
              new Notice("请填写大于 0 的工时评估（小时）");
              return;
            }
            estimateHDone = ev;
          }
          await writeTaskApplyStatusWithProgress(this.plugin.taskRSLatte, this.item as any, this.mode === "done" ? "DONE" : "IN_PROGRESS", {
            progress_note: progressNoteToSave,
            task_phase: this.mode === "start" ? "in_progress" : this.mode === "waiting_others" ? "waiting_others" : "waiting_until",
            wait_until: this.mode === "waiting_until" && waitUntil ? waitUntil : undefined,
            follow_up: this.mode === "waiting_others" && (followUp || tomorrow) ? (followUp || tomorrow) : undefined,
            followContactUids,
            follow_contact_names: followContactNames,
            ...(estimateHDone != null ? { estimate_h: estimateHDone } : {}),
            skipWorkEvent: true,
          });
          const phaseBeforeProg = indexItemTaskDisplayPhase(this.item as any);
          const phaseAfterProg =
            this.mode === "done"
              ? displayPhaseAfterTaskCheckbox("DONE")
              : this.mode === "start"
                ? "in_progress"
                : this.mode === "waiting_others"
                  ? "waiting_others"
                  : "waiting_until";
          const action =
            this.mode === "done" ? "done"
            : this.mode === "start" ? "start"
            : this.mode === "waiting_until" ? "paused"
            : "continued";
          const icon =
            this.mode === "done" ? "✅"
            : this.mode === "start" ? "▶"
            : this.mode === "waiting_until" ? "⏸"
            : "↻";
          const weakForEvent =
            (this.mode === "waiting_others" || this.mode === "waiting_until") && followContactUids?.length
              ? followContactUids
              : Array.isArray((this.item as any).follow_contact_uids)
                ? (this.item as any).follow_contact_uids.map((x: string) => String(x ?? "").trim()).filter(Boolean)
                : [];
          await runExecutionFlowUi(this.plugin, EXECUTION_RECIPE.updateTaskAndRefresh, {
            sync: this.plugin.isTaskDbSyncEnabledV2?.() ?? (this.plugin.settings.taskPanel.enableDbSync !== false),
            noticeOnError: true,
            workEvent: buildWorkEventUiAction({
              kind: "task",
              action,
              summary: `${icon} 任务进展 ${String(this.item.text ?? this.item.raw ?? "").trim() || "未命名任务"}`,
              ref: {
                uid: (this.item as any).uid,
                file_path: this.item.filePath,
                line_no: this.item.lineNo,
                to: this.mode === "done" ? "DONE" : "IN_PROGRESS",
                task_phase: this.mode === "start" ? "in_progress" : this.mode === "waiting_others" ? "waiting_others" : this.mode === "waiting_until" ? "waiting_until" : undefined,
                task_phase_before: phaseBeforeProg,
                task_phase_after: phaseAfterProg,
              },
              taskContactEnrich: {
                taskLine: String((this.item as any).raw ?? this.item.text ?? ""),
                followContactUids: weakForEvent,
              },
            }),
          }, { actionLabel: "更新任务进展" });
          new Notice(this.mode === "done" ? "已完成" : "已更新");
        }

        await this.onSuccess();
        this.close();
      } catch (e: any) {
        new Notice(`操作失败：${e?.message ?? String(e)}`);
      }
    };

    window.setTimeout(() => {
      if (this.mode === "postpone") daysInput?.inputEl?.focus();
      else if (this.mode === "done") estimateHoursInput?.inputEl?.focus();
      else latestProgressInput?.inputEl?.focus();
      refresh();
    }, 0);
  }
}
