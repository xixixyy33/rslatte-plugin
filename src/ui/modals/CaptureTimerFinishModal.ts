import { App, ButtonComponent, Modal, Notice, Setting, type TFile } from "obsidian";
import type RSLattePlugin from "../../main";
import { writeScheduleCreate } from "../../services/execution/scheduleWriteFacade";
import { runExecutionFlowUi } from "../helpers/runExecutionFlowUi";
import { EXECUTION_RECIPE } from "../../services/execution/executionOrchestrator";
import { buildCaptureWorkEventUi, buildWorkEventScheduleCreateUi } from "../../services/execution/buildExecutionWorkEvents";
import type { CaptureInstantTimerState, CaptureTimerSegment } from "../../services/capture/captureInstantTimer";
import { buildSegmentTimerLog } from "../../services/capture/captureInstantTimer";
import { getDefaultScheduleCategoryId, mountScheduleCategoryDropdown } from "../../taskRSLatte/schedule/scheduleCategory";
import type { ScheduleRepeatRule } from "../../types/scheduleTypes";
import { plainTextFromTextWithContactRefsResolved } from "../helpers/renderTextWithContactRefs";
import { findOutputFileByOutputId } from "../../services/execution/outputScheduleLinkFacade";

type SegmentDraft = {
  text: string;
  dateYmd: string;
  startTime: string;
  durationMin: number;
  raw: CaptureTimerSegment;
};

function toYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function toHm(d: Date): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function calcDurationMin(start: Date, end: Date): number {
  return Math.max(5, Math.round((end.getTime() - start.getTime()) / 60000));
}

export class CaptureTimerFinishModal extends Modal {
  constructor(
    app: App,
    private plugin: RSLattePlugin,
    private state: CaptureInstantTimerState,
    private segments: CaptureTimerSegment[],
    private onDone: () => Promise<void> | void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("结束计时并生成日程");

    const scheduleMod = (this.plugin.settings as any)?.scheduleModule;
    let category = getDefaultScheduleCategoryId(scheduleMod);
    let repeatRule: ScheduleRepeatRule = "none";
    const purpose = String(this.state.purpose ?? "").trim() || "计时记录";

    const drafts: SegmentDraft[] = this.segments.map((s, idx) => ({
      text: this.segments.length > 1 ? `${purpose}（片段${idx + 1}）` : purpose,
      dateYmd: toYmd(s.start),
      startTime: toHm(s.start),
      durationMin: calcDurationMin(s.start, s.end),
      raw: s,
    }));

    new Setting(contentEl)
      .setName("日程分类")
      .addDropdown((d) => {
        category = mountScheduleCategoryDropdown(d, scheduleMod, category, (id) => {
          category = id;
        });
      });

    new Setting(contentEl)
      .setName("重复规则")
      .addDropdown((d) => {
        d.addOption("none", "不重复");
        d.addOption("weekly", "每周");
        d.addOption("monthly", "每月");
        d.addOption("quarterly", "每季");
        d.addOption("yearly", "每年");
        d.setValue(repeatRule);
        d.onChange((v) => (repeatRule = (v as ScheduleRepeatRule) || "none"));
      });

    const linkedTaskInfoCard = contentEl.createDiv({ cls: "rslatte-capture-timer-target-card" });
    const linkedTaskLabelEl = linkedTaskInfoCard.createDiv({
      cls: "rslatte-capture-timer-target-row",
      text: "关联任务",
    });
    linkedTaskLabelEl.addClass("is-label");
    const linkedTaskInfoEl = linkedTaskInfoCard.createDiv({
      cls: "rslatte-capture-timer-target-row",
      text: "-",
    });
    void this.hydrateLinkedTaskInfo(linkedTaskInfoEl);

    const linkedOutInfoCard = contentEl.createDiv({ cls: "rslatte-capture-timer-target-card" });
    const linkedOutLabelEl = linkedOutInfoCard.createDiv({
      cls: "rslatte-capture-timer-target-row",
      text: "关联输出",
    });
    linkedOutLabelEl.addClass("is-label");
    const linkedOutInfoEl = linkedOutInfoCard.createDiv({
      cls: "rslatte-capture-timer-target-row",
      text: "-",
    });
    void this.hydrateLinkedOutputInfo(linkedOutInfoEl);

    contentEl.createEl("h4", { text: "生成片段（可调整）" });
    for (const d of drafts) {
      const row = contentEl.createDiv({ cls: "rslatte-capture-timer-seg-row" });
      new Setting(row).setName("描述").addText((t) => {
        t.setValue(d.text);
        t.onChange((v) => (d.text = String(v ?? "").trim()));
      });
      new Setting(row).setName("日期").addText((t) => {
        t.inputEl.type = "date";
        t.setValue(d.dateYmd);
        t.onChange((v) => (d.dateYmd = String(v ?? "").trim()));
      });
      new Setting(row).setName("开始").addText((t) => {
        t.inputEl.type = "time";
        t.setValue(d.startTime);
        t.onChange((v) => (d.startTime = String(v ?? "").trim()));
      });
      new Setting(row).setName("时长(min)").addText((t) => {
        t.inputEl.type = "number";
        t.setValue(String(d.durationMin));
        t.onChange((v) => {
          const n = Number(v);
          d.durationMin = Number.isFinite(n) ? Math.max(5, Math.floor(n)) : d.durationMin;
        });
      });
    }

    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });
    new ButtonComponent(btnRow)
      .setButtonText("生成日程")
      .setCta()
      .onClick(() => void this.finish(drafts, category, repeatRule));
    new ButtonComponent(btnRow).setButtonText("取消").onClick(() => this.close());
  }

  private async finish(drafts: SegmentDraft[], category: string, repeatRule: ScheduleRepeatRule): Promise<void> {
    for (const d of drafts) {
      if (!d.text || !/^\d{4}-\d{2}-\d{2}$/.test(d.dateYmd) || !/^\d{2}:\d{2}$/.test(d.startTime)) {
        new Notice("请检查片段信息（描述/日期/开始时间）");
        return;
      }
    }
    try {
      const linkedTaskUid = String(this.state.linkedTaskUid ?? "").trim();
      const linkedOutputId = String(this.state.linkedOutputId ?? "").trim();
      const linkedTask = linkedTaskUid ? await this.plugin.taskRSLatte.findTaskByUid(linkedTaskUid) : null;
      let linkedWriteFailed = false;
      let firstScheduleUid: string | undefined;
      let createdScheduleCount = 0;
      for (const d of drafts) {
        const timerLog = buildSegmentTimerLog(this.state, d.raw);
        const uid = await writeScheduleCreate(this.plugin.taskRSLatte, {
          text: d.text,
          scheduleDate: d.dateYmd,
          startTime: d.startTime,
          durationMin: d.durationMin,
          category,
          repeatRule,
          ...(linkedTaskUid ? { linkedTaskUid } : {}),
          ...(linkedOutputId ? { linkedOutputId } : {}),
          timerLog,
        });
        if (!uid) continue;
        createdScheduleCount++;
        if (!firstScheduleUid) firstScheduleUid = uid;
        const [hh, mm] = d.startTime.split(":").map((x) => Number(x));
        const s = new Date(`${d.dateYmd}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`);
        const e = new Date(s.getTime() + d.durationMin * 60000);
        const endHm = `${String(e.getHours()).padStart(2, "0")}:${String(e.getMinutes()).padStart(2, "0")}`;
        await runExecutionFlowUi(this.plugin, EXECUTION_RECIPE.tripleSaveSchedule, {
          facadeResult: { kind: "schedule", uid },
          workEvent: buildWorkEventScheduleCreateUi({
            uid,
            lineText: `${d.startTime}-${endHm} ${d.text}`,
            scheduleDate: d.dateYmd,
            repeatRule,
            scheduleCategory: category,
            startTime: d.startTime,
            endTime: endHm,
            durationMin: d.durationMin,
          }),
          sync: false,
        }, { actionLabel: "计时生成日程" });
        if (uid && linkedTask) {
          const r = await this.plugin.taskRSLatte.appendLinkedScheduleUidToTask(linkedTask as any, uid);
          if (!r.ok) linkedWriteFailed = true;
        }
      }
      if (createdScheduleCount > 0) {
        await runExecutionFlowUi(
          this.plugin,
          EXECUTION_RECIPE.workEventOnly,
          {
            sync: false,
            workEvent: buildCaptureWorkEventUi({
              action: "done",
              summary: `⏹ 计时结束，已生成 ${createdScheduleCount} 条日程`,
              ref: {
                capture_op: "timer_finish_schedules",
                schedule_count: createdScheduleCount,
                segment_count: drafts.length,
                ...(linkedTaskUid ? { linked_task_uid: linkedTaskUid } : {}),
                ...(linkedOutputId ? { linked_output_id: linkedOutputId } : {}),
              },
            }),
          },
          { actionLabel: "快速记录" }
        );
      }
      if (linkedTask) {
        const rr = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "task", "manual_refresh");
        if (!rr.ok) console.warn("[RSLatte][CaptureTimerFinishModal] task manual_refresh failed", rr.error);
      }
      let linkedOutFile: TFile | null = null;
      if (linkedOutputId) {
        linkedOutFile = await findOutputFileByOutputId(this.plugin, linkedOutputId);
        if (firstScheduleUid && linkedOutFile) {
          await this.app.fileManager.processFrontMatter(linkedOutFile, (fm: Record<string, unknown>) => {
            (fm as any).linked_schedule_uid = firstScheduleUid;
          });
          await this.plugin.outputRSLatte?.upsertFile?.(linkedOutFile);
          const or = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "output" as any, "manual_refresh");
          if (!or.ok) console.warn("[RSLatte][CaptureTimerFinishModal] output manual_refresh failed", or.error);
        } else if (firstScheduleUid && !linkedOutFile) {
          console.warn("[RSLatte][CaptureTimerFinishModal] linked output file not found", linkedOutputId);
        }
      }
      await this.onDone();
      if (linkedTaskUid && !linkedTask) {
        new Notice(`已生成 ${drafts.length} 条日程（关联任务未找到：${linkedTaskUid}）`);
      } else if (linkedOutputId && !linkedOutFile) {
        new Notice(`已生成 ${drafts.length} 条日程（关联输出文档未找到：${linkedOutputId}）`);
      } else if (linkedWriteFailed) {
        new Notice(`已生成 ${drafts.length} 条日程（部分任务关联写回失败）`);
      } else {
        new Notice(`已生成 ${drafts.length} 条日程`);
      }
      this.close();
    } catch (e: any) {
      new Notice(`生成失败：${e?.message ?? String(e)}`);
    }
  }

  private async hydrateLinkedOutputInfo(el: HTMLElement): Promise<void> {
    const oid = String(this.state.linkedOutputId ?? "").trim();
    if (!oid) {
      el.setText("-");
      return;
    }
    try {
      await this.plugin.outputRSLatte?.refreshIndexNow?.({ mode: "full" });
      const snap = await this.plugin.outputRSLatte?.getSnapshot?.();
      const hit = (snap?.items ?? []).find((x) => String((x as any)?.outputId ?? "").trim() === oid);
      const title = String((hit as any)?.title ?? "").trim();
      el.setText(title || oid);
    } catch {
      el.setText(oid);
    }
  }

  private async hydrateLinkedTaskInfo(el: HTMLElement): Promise<void> {
    const linkedUid = String(this.state.linkedTaskUid ?? "").trim();
    if (!linkedUid) {
      el.setText("-");
      return;
    }
    try {
      const hit = await this.plugin.taskRSLatte.findTaskByUid(linkedUid);
      const raw = String((hit as any)?.text ?? "").trim();
      const text = await plainTextFromTextWithContactRefsResolved(raw, (uid) => this.lookupContactDisplayName(uid));
      el.setText(text || linkedUid);
    } catch {
      el.setText(linkedUid);
    }
  }

  private async lookupContactDisplayName(uid: string): Promise<string | null> {
    const u = String(uid ?? "").trim();
    if (!u) return null;
    try {
      const store = this.plugin.contactsIndex?.getIndexStore?.();
      if (!store) return null;
      const idx = await store.readIndex();
      const hit = (idx?.items ?? []).find((x) => String((x as any)?.contact_uid ?? "").trim() === u);
      const nm = String((hit as any)?.display_name ?? "").trim();
      return nm || null;
    } catch {
      return null;
    }
  }
}
