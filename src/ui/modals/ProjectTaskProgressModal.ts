import { App, ButtonComponent, Modal, Notice, Setting, TextAreaComponent, TextComponent, normalizePath } from "obsidian";

import type RSLattePlugin from "../../main";
import type { ProjectTaskItem } from "../../projectManager/types";

export type ProjectTaskProgressModalMode = "start" | "waiting_others" | "waiting_until" | "done" | "postpone";

export class ProjectTaskProgressModal extends Modal {
  constructor(
    app: App,
    private plugin: RSLattePlugin,
    private projectFolderPath: string,
    private task: ProjectTaskItem,
    private mode: ProjectTaskProgressModalMode,
    private onSuccess: () => void | Promise<void>
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("rslatte-modal");

    const titles: Record<ProjectTaskProgressModalMode, string> = {
      start: "开始处理任务",
      waiting_others: "等待他人处理",
      waiting_until: "进入等待状态",
      done: "完成任务",
      postpone: "延期",
    };
    this.titleEl.setText(titles[this.mode]);

    const historyProgressNote = String((this.task as any).progressNote ?? "").trim();
    let latestProgress = "";
    let waitUntil = "";
    let followUp = "";
    let followContactUidsStr = Array.isArray((this.task as any).followContactUids) ? (this.task as any).followContactUids.join(",") : "";
    const followContactNameByUid = new Map<string, string>();
    {
      const initUids = Array.isArray((this.task as any).follow_contact_uids)
        ? (this.task as any).follow_contact_uids
        : Array.isArray((this.task as any).followContactUids)
          ? (this.task as any).followContactUids
          : [];
      const initNames = Array.isArray((this.task as any).follow_contact_names)
        ? (this.task as any).follow_contact_names
        : Array.isArray((this.task as any).followContactNames)
          ? (this.task as any).followContactNames
          : [];
      for (let i = 0; i < initUids.length; i++) {
        const uid = String(initUids[i] ?? "").trim();
        const name = String(initNames[i] ?? "").trim();
        // meta 曾误把 uid 写入 follow_contact_name，忽略以便保存时从索引重新解析
        if (uid && name && name !== uid) followContactNameByUid.set(uid, name);
      }
    }
    let postponeDays = "1";
    let postponeReason = "";

    const ptEst = (this.task as any).estimate_h ?? (this.task as any).estimateH;
    let estimateHoursStr =
      ptEst != null && ptEst !== "" && Number(ptEst) > 0 ? String(ptEst) : "";

    let latestProgressInput!: TextComponent;
    let estimateHoursInput!: TextComponent;
    let waitUntilInput!: TextComponent;
    let daysInput!: TextComponent;
    let reasonInput!: TextAreaComponent;
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
      const h = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return `${today} ${h}:${mm}`;
    })();

    if (this.mode === "waiting_until") {
      const raw = String((this.task as any).wait_until ?? (this.task as any).waitUntil ?? "")
        .trim()
        .match(/^(\d{4}-\d{2}-\d{2})/);
      waitUntil = raw ? raw[1] : today;
    }

    const statusLabelByMode: Record<ProjectTaskProgressModalMode, string> = {
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

    const ref = { taskId: this.task.taskId, lineNo: this.task.lineNo };
    const projectPath = this.projectFolderPath;

    if (this.mode === "postpone") {
      // 6-细7：不展示历史延期次数
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
          reasonInput = t;
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
          .setName("等待到期日期*")
          .addText((t) => {
            waitUntilInput = t;
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
          .setDesc("可选，选择后这些联系人在「跟进中/等待中」时会关注此项目任务");
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
              // 与 TaskProgressModal 一致：索引项为 display_name / title（非 camelCase displayName）
              const displayName = String(item?.display_name ?? item?.title ?? "").trim();
              if (displayName) followContactNameByUid.set(uid, displayName);
              const cur = followContactUidsStr.split(/[,;\s]+/).map((s: string) => s.trim()).filter(Boolean);
              if (!cur.includes(uid)) cur.push(uid);
              followContactUidsStr = cur.join(",");
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
          await this.plugin.projectMgr.postponeProjectTask(projectPath, ref, d, postponeReason || "无说明");
          new Notice("已延期");
        } else if (this.mode === "done") {
          const ev = parseFloat(String(estimateHoursStr ?? "").trim().replace(",", "."));
          if (!Number.isFinite(ev) || ev <= 0) {
            new Notice("请填写大于 0 的工时评估（小时）");
            return;
          }
          await this.plugin.projectMgr.setProjectTaskStatus(projectPath, ref, "DONE", { estimateH: ev });
          new Notice("已完成");
        } else {
          let progressNoteToSave: string | undefined;
          const latest = (latestProgress ?? "").trim();
          if (latest) {
            const label = statusLabelByMode[this.mode] || "进度";
            const safeContent = latest.replace(/\s+/g, " ").replace(/;/g, "，");
            progressNoteToSave = historyProgressNote ? `${historyProgressNote} || ${nowStr} ${label} ${safeContent}` : `${nowStr} ${label} ${safeContent}`;
          }
          const followContactUids = (this.mode === "waiting_others" || this.mode === "waiting_until")
            ? followContactUidsStr.split(/[,;\s]+/).map((s: string) => s.trim()).filter(Boolean)
            : undefined;
          const resolveFollowContactDisplayNames = async (uids: string[]): Promise<string[]> => {
            const out: string[] = [];
            for (const uid of uids) {
              let n = String(followContactNameByUid.get(uid) ?? "").trim();
              if (!n || n === uid) {
                try {
                  const hit = await (this.plugin as any).findContactByUid?.(uid);
                  const dn = String(hit?.display_name ?? "").trim();
                  if (dn) n = dn;
                } catch {
                  // ignore
                }
              }
              out.push(n || uid);
            }
            return out;
          };
          const followContactNames =
            (this.mode === "waiting_others" || this.mode === "waiting_until") && Array.isArray(followContactUids)
              ? await resolveFollowContactDisplayNames(followContactUids)
              : undefined;
          await this.plugin.projectMgr.setProjectTaskPhase(projectPath, ref, this.mode === "start" ? "in_progress" : this.mode === "waiting_others" ? "waiting_others" : "waiting_until", {
            progressNote: progressNoteToSave,
            waitUntil: this.mode === "waiting_until" && waitUntil ? waitUntil : undefined,
            followUp: this.mode === "waiting_others" && (followUp || tomorrow) ? (followUp || tomorrow) : undefined,
            followContactUids,
            followContactNames,
          });
          new Notice("已更新");
        }

        const folder = String(this.projectFolderPath ?? "").trim();
        if (folder && typeof this.plugin.refreshContactInteractionsForTasklistFile === "function") {
          try {
            const snap = (this.plugin.projectMgr as any)?.getSnapshot?.() as any;
            const projects = Array.isArray(snap?.projects) ? snap.projects : [];
            const proj = projects.find((x: any) => normalizePath(String(x?.folderPath ?? x?.folder_path ?? "").trim()) === normalizePath(folder));
            const tasklistPath = (proj as any)?.tasklistFilePath ?? (proj as any)?.tasklist_file_path ?? normalizePath(`${folder}/项目任务清单.md`);
            await this.plugin.refreshContactInteractionsForTasklistFile(tasklistPath);
          } catch (e) {
            console.warn("[RSLatte] refreshContactInteractions after project task update failed", e);
          }
        }

        await this.onSuccess();
        this.plugin.refreshSidePanel();
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
