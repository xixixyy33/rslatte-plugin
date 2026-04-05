import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { CaptureTimerResetConfirmModal } from "../modals/CaptureTimerResetConfirmModal";
import type RSLattePlugin from "../../main";
import { getTaskTodayKey } from "../../taskRSLatte/task/taskTags";
import { buildCaptureWorkEventUi, buildWorkEventTaskCreateUi } from "../../services/execution/buildExecutionWorkEvents";
import { EXECUTION_RECIPE } from "../../services/execution/executionOrchestrator";
import { writeTaskTodayCreate } from "../../services/execution/taskWriteFacade";
import { recommendCaptureItemType } from "../../services/capture/captureTypeRecommendation";
import type { CaptureInstantTimerState } from "../../services/capture/captureInstantTimer";
import { buildTimerSegments, calcElapsedSec, formatHms, formatYmdHms, nowIso } from "../../services/capture/captureInstantTimer";
import { VIEW_TYPE_CAPTURE } from "../../constants/viewTypes";
import { DEFAULT_SETTINGS } from "../../constants/defaults";
import { runExecutionFlowUi } from "../helpers/runExecutionFlowUi";
import { CaptureQuickAddModal } from "../modals/CaptureQuickAddModal";
import {
  CaptureTimerStartModal,
  type CaptureTimerStartOutputOption,
  type CaptureTimerStartTaskOption,
} from "../modals/CaptureTimerStartModal";
import { formatOutputDocFolderHintForCapture } from "../helpers/outputCapturePickerPaths";
import { outputIndexItemIsProjectKind } from "../../types/outputTypes";
import { CaptureTimerFinishModal } from "../modals/CaptureTimerFinishModal";
import type { RSLatteIndexItem } from "../../taskRSLatte/types";
import { plainTextFromTextWithContactRefsResolved } from "../helpers/renderTextWithContactRefs";

type InboxItem = { filePath: string; lineNo: number; line: string; status: "todo" | "done" | "cancelled" | "paused"; text: string; addDate?: string };
type CaptureTab = "record" | "focus";

/**
 * V2 工作流：统一快速记录（Capture）
 * 单一输入框，支持「先记下来再归类」：保存为今日任务 或 待整理；时间轴展示积压待整理条目
 */
export class CaptureView extends ItemView {
  private plugin: RSLattePlugin;
  private inputEl: HTMLTextAreaElement | null = null;
  private _renderSeq = 0;
  private _timerTickHandle: number | null = null;
  private _timerDigitalEl: HTMLElement | null = null;
  private _timerClockEl: HTMLElement | null = null;
  private _timerLogEl: HTMLElement | null = null;
  private _activeTab: CaptureTab = "record";

  constructor(leaf: WorkspaceLeaf, plugin: RSLattePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_CAPTURE; }
  getDisplayText(): string { return "快速记录"; }
  getIcon(): string { return "pencil"; }

  async onOpen() {
    this.ensureTimerState();
    this.autoPauseRunningTimerIfNeeded();
    this.startTimerTick();
    void this.render();
  }

  async onClose() {
    this.inputEl = null;
    this.stopTimerTick();
  }

  /** 与 Today「今日执行」、任务面板一致：按任务基准日/时区（`getTaskTodayKey`），避免 Inbox ➕ 与统计「今日新增」日历错位 */
  private getTodayKey(): string {
    return getTaskTodayKey((this.plugin.settings as any)?.taskPanel ?? undefined);
  }

  /** 快速记录侧操作统一写入 kind: capture（经编排 appendWorkEvent） */
  private appendCaptureUiEvent(p: Parameters<typeof buildCaptureWorkEventUi>[0]): void {
    void runExecutionFlowUi(
      this.plugin,
      EXECUTION_RECIPE.workEventOnly,
      { sync: false, workEvent: buildCaptureWorkEventUi(p) },
      { actionLabel: "快速记录" }
    );
  }

  private getCaptureShowStatuses() {
    const cap = (this.plugin.settings as any).captureModule ?? (DEFAULT_SETTINGS as any).captureModule;
    return cap?.captureShowStatuses ?? { todo: true, done: false, cancelled: false, paused: true };
  }

  private ensureTimerState(): CaptureInstantTimerState {
    const cap = ((this.plugin.settings as any).captureModule ??= {});
    const st = (cap.captureInstantTimerState ??= { status: "idle", events: [] });
    if (!Array.isArray(st.events)) st.events = [];
    return st as CaptureInstantTimerState;
  }

  private async saveTimerState(next: CaptureInstantTimerState): Promise<void> {
    const cap = ((this.plugin.settings as any).captureModule ??= {});
    cap.captureInstantTimerState = next;
    try { await this.plugin.saveSettings(); } catch {}
  }

  private startTimerTick(): void {
    this.stopTimerTick();
    this._timerTickHandle = window.setInterval(() => {
      const st = this.ensureTimerState();
      if (st.status === "running" || st.status === "paused") this.updateTimerUiOnly();
    }, 1000);
  }

  private stopTimerTick(): void {
    if (this._timerTickHandle != null) {
      window.clearInterval(this._timerTickHandle);
      this._timerTickHandle = null;
    }
  }

  private updateTimerUiOnly(): void {
    const st = this.ensureTimerState();
    if (st.status !== "running" && st.status !== "paused") return;
    if (!this._timerLogEl) return;
    const now = nowIso();
    const elapsedSec = calcElapsedSec(st, now);
    const elapsed = formatHms(elapsedSec);
    if (this._timerDigitalEl) this._timerDigitalEl.setText(elapsed);

    if (this._timerClockEl) {
      this._timerClockEl.setAttribute("title", `当前计时：${elapsed}`);
      const ss = elapsedSec % 60;
      const mm = Math.floor(elapsedSec / 60) % 60;
      const hh = Math.floor(elapsedSec / 3600) % 12;
      const hHand = this._timerClockEl.querySelector(".rslatte-capture-timer-hand.h") as HTMLElement | null;
      const mHand = this._timerClockEl.querySelector(".rslatte-capture-timer-hand.m") as HTMLElement | null;
      const sHand = this._timerClockEl.querySelector(".rslatte-capture-timer-hand.s") as HTMLElement | null;
      if (hHand) hHand.style.transform = `translateX(-50%) rotate(${hh * 30 + mm * 0.5}deg)`;
      if (mHand) mHand.style.transform = `translateX(-50%) rotate(${mm * 6}deg)`;
      if (sHand) sHand.style.transform = `translateX(-50%) rotate(${ss * 6}deg)`;
    }

    const logLines = this.buildTimerLogLines(st);
    this._timerLogEl.setText(logLines.join("\n"));
  }

  private buildTimerLogLines(st: CaptureInstantTimerState): string[] {
    const lines: string[] = [];
    lines.push(`Start: ${st.startedAt ? formatYmdHms(st.startedAt) : "-"}`);
    const ordered = [...(st.events ?? [])]
      .filter((e) => e.type === "pause" || e.type === "resume")
      .sort((a, b) => a.ts.localeCompare(b.ts));
    if (ordered.length === 0) {
      lines.push("Pause: -");
      lines.push("Resume: -");
      return lines;
    }
    for (const e of ordered) {
      const label = e.type === "pause" ? "Pause" : "Resume";
      lines.push(`${label}: ${formatYmdHms(e.ts)}`);
    }
    // 记录过多时，仅展示最前 1 条和最后 3 条，中间省略，避免占满侧栏
    if (lines.length > 5) {
      const head = lines.slice(0, 1);
      const tail = lines.slice(-3);
      return [...head, "...", ...tail];
    }
    return lines;
  }

  private autoPauseRunningTimerIfNeeded(): void {
    const st = this.ensureTimerState();
    if (st.status !== "running") return;
    const iso = nowIso();
    st.status = "paused";
    st.events = [...(st.events ?? []), { type: "pause", ts: iso }];
    void this.saveTimerState(st);
  }

  private async getTimerTargetText(st: CaptureInstantTimerState): Promise<string> {
    let linkedLine = "关联任务：-";
    const linkedUid = String(st.linkedTaskUid ?? "").trim();
    if (linkedUid) {
      let linkedText = linkedUid;
      try {
        const hit = await this.plugin.taskRSLatte.findTaskByUid(linkedUid);
        const raw = String((hit as any)?.text ?? "").trim();
        const t = await plainTextFromTextWithContactRefsResolved(raw, (uid) => this.lookupContactDisplayName(uid));
        if (t) linkedText = t;
      } catch {
        // ignore
      }
      linkedLine = `关联任务：${linkedText}`;
    }
    let linkedOutLine = "关联输出：-";
    const linkedOid = String(st.linkedOutputId ?? "").trim();
    if (linkedOid) {
      let title = linkedOid;
      try {
        await this.plugin.outputRSLatte?.refreshIndexNow?.({ mode: "full" });
        const snap = await this.plugin.outputRSLatte?.getSnapshot?.();
        const hit = (snap?.items ?? []).find((x) => String((x as any)?.outputId ?? "").trim() === linkedOid);
        const t0 = String((hit as any)?.title ?? "").trim();
        if (t0) title = t0;
      } catch {
        // ignore
      }
      linkedOutLine = `关联输出：${title}`;
    }
    const purpose = await plainTextFromTextWithContactRefsResolved(String(st.purpose ?? "").trim(), (uid) =>
      this.lookupContactDisplayName(uid)
    );
    const focusLine = `正在专注：${purpose || "-"}`;
    return `${focusLine}\n${linkedLine}\n${linkedOutLine}`;
  }

  private async loadActiveTaskOptions(): Promise<CaptureTimerStartTaskOption[]> {
    try {
      const lists = await this.plugin.taskRSLatte.getTaskListsForSidePanel();
      const groups: Array<{ label: string; items: RSLatteIndexItem[] }> = [
        { label: "重点关注", items: lists.focus ?? [] },
        { label: "今日处理", items: lists.todayAction ?? [] },
        { label: "今日跟进", items: lists.todayFollowUp ?? [] },
        { label: "临期/超期", items: lists.overdue ?? [] },
        { label: "风险关注", items: lists.otherRisk ?? [] },
        { label: "其他活跃", items: lists.otherActive ?? [] },
      ];
      const out: CaptureTimerStartTaskOption[] = [];
      const seen = new Set<string>();
      for (const group of groups) {
        for (const item of group.items) {
          const uid = String((item as any)?.uid ?? "").trim();
          if (!uid || seen.has(uid)) continue;
          seen.add(uid);
          const raw = String((item as any)?.text ?? "").trim() || uid;
          const text = await plainTextFromTextWithContactRefsResolved(raw, (id) => this.lookupContactDisplayName(id));
          out.push({
            uid,
            text,
            taskType: "task",
            plannedEnd: String((item as any)?.planned_end ?? "").trim(),
            sectionLabel: group.label,
          });
          if (out.length >= 200) break;
        }
        if (out.length >= 200) break;
      }

      const snap: any = this.plugin.projectMgr?.getSnapshot?.();
      const projects = Array.isArray(snap?.projects) ? snap.projects : [];
      for (const p of projects) {
        const pStatus = String((p as any)?.status ?? "").trim().toLowerCase();
        if (pStatus === "done" || pStatus === "cancelled") continue;
        const pName = String((p as any)?.projectName ?? "").trim();
        const items = Array.isArray((p as any)?.taskItems) ? (p as any).taskItems : [];
        for (const it of items) {
          const st = String((it as any)?.statusName ?? "").trim().toUpperCase();
          if (st !== "TODO" && st !== "IN_PROGRESS") continue;
          const uid = String((it as any)?.taskId ?? "").trim();
          if (!uid || seen.has(uid)) continue;
          seen.add(uid);
          const raw = String((it as any)?.text ?? "").trim() || uid;
          const text = await plainTextFromTextWithContactRefsResolved(raw, (id) => this.lookupContactDisplayName(id));
          const milestone = String((it as any)?.milestonePath ?? (it as any)?.milestone ?? "").trim();
          out.push({
            uid,
            text,
            taskType: "project_task",
            plannedEnd: String((it as any)?.planned_end ?? "").trim(),
            sectionLabel: [pName, milestone].filter(Boolean).join(" / "),
          });
          if (out.length >= 200) break;
        }
        if (out.length >= 200) break;
      }
      const dateRank = (s?: string): number => {
        const ymd = String(s ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!ymd) return Number.MAX_SAFE_INTEGER;
        const y = Number(ymd[1]);
        const m = Number(ymd[2]);
        const d = Number(ymd[3]);
        return Date.UTC(y, m - 1, d);
      };
      out.sort((a, b) => {
        const da = dateRank(a.plannedEnd);
        const db = dateRank(b.plannedEnd);
        if (da !== db) return da - db;
        return String(a.text ?? "").localeCompare(String(b.text ?? ""), "zh-Hans-CN");
      });
      return out.slice(0, 200);
    } catch (e) {
      console.warn("[RSLatte][capture] load active task options failed", e);
      return [];
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

  private async loadOutputOptionsForTimer(): Promise<CaptureTimerStartOutputOption[]> {
    try {
      await this.plugin.outputRSLatte?.refreshIndexNow?.({ mode: "full" });
      const snap = await this.plugin.outputRSLatte?.getSnapshot?.();
      const pool = (snap?.items ?? []).filter((it) => {
        const s = String((it as any)?.status ?? "todo").trim();
        return s === "todo" || s === "in-progress" || s === "waiting_until";
      });
      pool.sort((a, b) => ((b as any)?.mtimeMs ?? 0) - ((a as any)?.mtimeMs ?? 0));
      return pool
        .slice(0, 200)
        .map((it) => {
          const outputId = String((it as any)?.outputId ?? "").trim();
          const title = String((it as any)?.title ?? "").trim() || String((it as any)?.filePath ?? "");
          return {
            outputId,
            title,
            folderHint: formatOutputDocFolderHintForCapture(String((it as any)?.filePath ?? "")),
            isProject: outputIndexItemIsProjectKind(it as any),
          };
        })
        .filter((x) => !!x.outputId);
    } catch (e) {
      console.warn("[RSLatte][capture] load output options for timer failed", e);
      return [];
    }
  }

  private async openStartTimerModal(): Promise<void> {
    const [taskOptions, outputOptions] = await Promise.all([
      this.loadActiveTaskOptions(),
      this.loadOutputOptionsForTimer(),
    ]);
    new CaptureTimerStartModal(this.app, taskOptions, outputOptions, async (payload) => {
      const iso = nowIso();
      const st: CaptureInstantTimerState = {
        status: "running",
        purpose: payload.purpose,
        linkedTaskUid: payload.linkedTaskUid,
        linkedOutputId: payload.linkedOutputId,
        startedAt: iso,
        events: [{ type: "start", ts: iso }],
      };
      await this.saveTimerState(st);
      const purposeRaw = String(payload.purpose ?? "").trim();
      const purposeShort = purposeRaw.length > 40 ? purposeRaw.slice(0, 40) + "…" : purposeRaw;
      this.appendCaptureUiEvent({
        action: "start",
        summary: purposeShort ? `⏳ 专注计时开始：${purposeShort}` : "⏳ 专注计时开始",
        ref: {
          capture_op: "timer_start",
          linked_task_uid: String(payload.linkedTaskUid ?? "").trim() || undefined,
          linked_output_id: String(payload.linkedOutputId ?? "").trim() || undefined,
        },
      });
      new Notice("计时已开始");
      void this.render();
    }).open();
  }

  private async pauseTimer(): Promise<void> {
    const st = this.ensureTimerState();
    if (st.status !== "running") return;
    st.status = "paused";
    st.events = [...(st.events ?? []), { type: "pause", ts: nowIso() }];
    await this.saveTimerState(st);
    this.appendCaptureUiEvent({
      action: "paused",
      summary: "⏸ 专注计时暂停",
      ref: { capture_op: "timer_pause" },
    });
    void this.render();
  }

  private async resumeTimer(): Promise<void> {
    const st = this.ensureTimerState();
    if (st.status !== "paused") return;
    st.status = "running";
    st.events = [...(st.events ?? []), { type: "resume", ts: nowIso() }];
    await this.saveTimerState(st);
    this.appendCaptureUiEvent({
      action: "continued",
      summary: "▶ 专注计时继续",
      ref: { capture_op: "timer_resume" },
    });
    void this.render();
  }

  /** 在「运行/暂停」下重置为未开始：清空时长记录与专注主题、关联任务/输出，需再次 ⏳ 填写并开始 */
  private async performTimerResetToIdle(): Promise<void> {
    const st = this.ensureTimerState();
    if (st.status !== "running" && st.status !== "paused") return;
    const next: CaptureInstantTimerState = { status: "idle", events: [] };
    await this.saveTimerState(next);
    this.appendCaptureUiEvent({
      action: "update",
      summary: "🔄 专注计时已重置",
      ref: { capture_op: "timer_reset" },
    });
    new Notice("已重置，请点 ⏳ 重新开启计时并填写专注内容或关联");
    void this.render();
  }

  private openResetTimerConfirm(): void {
    new CaptureTimerResetConfirmModal(this.app, () => this.performTimerResetToIdle()).open();
  }

  private async finishTimer(): Promise<void> {
    const st = this.ensureTimerState();
    if (st.status !== "running" && st.status !== "paused") return;
    const endIso = nowIso();
    const work = { ...st, endedAt: endIso };
    const segments = buildTimerSegments(work, endIso, 30);
    if (segments.length === 0) {
      new Notice("计时时长过短，未生成日程");
      await this.saveTimerState({ status: "idle", events: [] });
      void this.render();
      return;
    }
    new CaptureTimerFinishModal(this.app, this.plugin, work, segments, async () => {
      await this.saveTimerState({ status: "idle", events: [] });
      void this.render();
    }).open();
  }

  private async saveAsTodayTask() {
    const raw = this.inputEl?.value?.trim() ?? "";
    if (!raw) {
      new Notice("请输入内容");
      return;
    }
    const today = this.getTodayKey();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
      new Notice("无法获取今日日期");
      return;
    }
    try {
      const fr = await writeTaskTodayCreate(this.plugin.taskRSLatte, raw, today, "", "");
      if (!fr) return;
      await runExecutionFlowUi(this.plugin, EXECUTION_RECIPE.tripleSaveTask, {
        facadeResult: { kind: "task", uid: fr.uid, diaryPath: fr.diaryPath },
        workEvent: buildWorkEventTaskCreateUi({
          uid: fr.uid,
          text: raw,
          due: today,
          recordDate: today,
        }),
        sync: (this.plugin as any).isTaskDbSyncEnabledV2?.() ?? (this.plugin.settings.taskPanel?.enableDbSync !== false),
        noticeOnError: true,
      }, { actionLabel: "Capture创建任务" });
      if (this.inputEl) this.inputEl.value = "";
      new Notice("已保存为今日任务");
    } catch (e: any) {
      new Notice(`保存失败：${e?.message ?? String(e)}`);
    }
  }

  private async saveAsInbox() {
    const raw = this.inputEl?.value?.trim() ?? "";
    if (!raw) {
      new Notice("请输入内容");
      return;
    }
    const today = this.getTodayKey();
    try {
      await (this.plugin as any).appendCaptureInbox?.(today, raw);
      this.plugin.refreshSidePanel?.();
      if (this.inputEl) this.inputEl.value = "";
      new Notice("已加入待整理");
      void this.render();
    } catch (e: any) {
      new Notice(`保存失败：${e?.message ?? String(e)}`);
    }
  }

  private async loadInboxItems(): Promise<InboxItem[]> {
    const show = this.getCaptureShowStatuses();
    const raw = await (this.plugin as any).listCaptureInboxItems?.(show);
    const items = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as any)?.items)
        ? (raw as any).items
        : [];
    /** 不再二次过滤为仅 todo：`getCaptureInboxBacklogCount` 与列表均按 `captureShowStatuses`（含「暂不处理」paused） */
    return items as InboxItem[];
  }

  private async getBacklogCount(): Promise<number> {
    return (this.plugin as any).getCaptureInboxBacklogCount?.() ?? 0;
  }

  private openQuickAdd(opts?: {
    draftText?: string;
    withRecommendation?: boolean;
    sourceInboxRef?: { filePath: string; lineNo: number };
  }): void {
    if (opts?.sourceInboxRef) {
      this.appendCaptureUiEvent({
        action: "update",
        summary: "🗃️ 待整理行打开整理",
        ref: {
          capture_op: "open_organize_from_row",
          inbox_file_path: opts.sourceInboxRef.filePath,
          inbox_line_no: opts.sourceInboxRef.lineNo,
        },
      });
    }
    // 顶部 ➕ / 工具栏 🗃️ 整理：打开三合一不记 capture；创建成功由 Add*Modal 写 task|memo|schedule · create
    const draft = String(opts?.draftText ?? this.inputEl?.value ?? "");
    const dict = (this.plugin.settings as any)?.captureModule?.captureTypeRecommendationDict;
    new CaptureQuickAddModal(this.app, this.plugin, {
      getDraftText: () => draft,
      recommendation: opts?.withRecommendation ? recommendCaptureItemType(draft, dict) : null,
      sourceInboxRef: opts?.sourceInboxRef,
    }).open();
  }

  private async updateInboxMark(item: InboxItem, newMark: " " | "x" | "-" | "/") {
    try {
      await (this.plugin as any).updateCaptureInboxLine?.(item.filePath, item.lineNo, newMark);
      this.plugin.refreshSidePanel?.();
      void this.render();
    } catch (e: any) {
      new Notice(`更新失败：${e?.message ?? String(e)}`);
    }
  }

  private async toTodayTask(item: InboxItem) {
    const today = this.getTodayKey();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
      new Notice("无法获取今日日期");
      return;
    }
    try {
      const fr = await writeTaskTodayCreate(this.plugin.taskRSLatte, item.text, today, "", "");
      if (!fr) return;
      const t = String(item.text ?? "").trim();
      await runExecutionFlowUi(this.plugin, EXECUTION_RECIPE.tripleSaveTask, {
        facadeResult: { kind: "task", uid: fr.uid, diaryPath: fr.diaryPath },
        workEvent: buildWorkEventTaskCreateUi({
          uid: fr.uid,
          text: t,
          due: today,
          recordDate: today,
        }),
        sync: (this.plugin as any).isTaskDbSyncEnabledV2?.() !== false,
        noticeOnError: true,
      }, { actionLabel: "待整理转任务" });
      await (this.plugin as any).updateCaptureInboxLine?.(item.filePath, item.lineNo, "x");
      this.plugin.refreshSidePanel?.();
      new Notice("已转为今日任务");
      void this.render();
    } catch (e: any) {
      new Notice(`失败：${e?.message ?? String(e)}`);
    }
  }

  private async render() {
    const seq = ++this._renderSeq;
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("rslatte-capture-view");

    const tabs = container.createDiv({ cls: "rslatte-capture-tabs" });
    const mkTabBtn = (id: CaptureTab, label: string) => {
      const btn = tabs.createEl("button", { cls: "rslatte-capture-tab", text: label, type: "button" });
      if (this._activeTab === id) btn.addClass("is-active");
      btn.onclick = () => {
        if (this._activeTab === id) return;
        this._activeTab = id;
        void this.render();
      };
    };
    mkTabBtn("record", "记录");
    mkTabBtn("focus", "专注");

    if (this._activeTab === "record") {
      await this.renderRecordTab(container, seq);
      return;
    }
    await this.renderFocusTab(container, seq);
  }

  private async renderRecordTab(container: HTMLElement, seq: number): Promise<void> {
    this._timerDigitalEl = null;
    this._timerClockEl = null;
    this._timerLogEl = null;

    const header = container.createDiv({ cls: "rslatte-capture-header" });
    header.createEl("h3", { text: "✍快速记录" });
    const headerActions = header.createDiv({ cls: "rslatte-capture-header-actions" });
    const quickAddBtn = headerActions.createEl("button", {
      cls: "rslatte-capture-quickadd-btn",
      text: "➕",
      title: "三合一新增",
    });
    quickAddBtn.onclick = () => this.openQuickAdd();
    const btnRefresh = headerActions.createEl("button", { cls: "rslatte-capture-inbox-refresh", title: "刷新待整理条目" });
    btnRefresh.createSpan({ cls: "rslatte-capture-inbox-refresh-icon", text: "↻" });
    btnRefresh.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.appendCaptureUiEvent({
        action: "update",
        summary: "↻ 请求刷新待整理",
        ref: { capture_op: "inbox_refresh_click" },
      });
      await (this.plugin as any).refreshCaptureInbox?.();
      this.plugin.refreshSidePanel?.();
      void this.render();
    };

    const wrap = container.createDiv({ cls: "rslatte-capture-body" });
    this.inputEl = wrap.createEl("textarea", {
      placeholder: "输入一条待办、想法或记录…",
      cls: "rslatte-capture-input",
    });
    this.inputEl.rows = 3;
    this.inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        void this.saveAsInbox();
      }
    });

    const actions = container.createDiv({ cls: "rslatte-capture-actions" });
    const btnTask = actions.createEl("button", { text: "☀️今日任务", cls: "mod-cta" });
    btnTask.onclick = () => void this.saveAsTodayTask();
    const btnSort = actions.createEl("button", { text: "🗃️整理" });
    btnSort.onclick = () => this.openQuickAdd({ withRecommendation: true });
    const btnInbox = actions.createEl("button", { text: "待整理" });
    btnInbox.onclick = () => void this.saveAsInbox();

    const inboxSection = container.createDiv({ cls: "rslatte-capture-inbox-section" });
    const backlogCount = await this.getBacklogCount();
    if (seq !== this._renderSeq) return;
    const summary = inboxSection.createDiv({ cls: "rslatte-capture-inbox-summary" });
    summary.createSpan({ text: "待整理条目" });
    summary.createSpan({ cls: "rslatte-capture-inbox-count", text: ` (${backlogCount})` });

    const inboxBody = inboxSection.createDiv({ cls: "rslatte-capture-inbox-body" });

    const items = await this.loadInboxItems();
    if (seq !== this._renderSeq) return;
    if (items.length === 0) {
      inboxBody.createDiv({ cls: "rslatte-muted", text: "暂无待整理条目（或当前展示状态下无数据）" });
      return;
    }
    const normalizeDate = (v?: string): string => {
      const s = String(v ?? "").trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.replace(/-/g, "/");
      return "";
    };
    const timelineWrap = inboxBody.createDiv({ cls: "rslatte-timeline" });
    for (const item of items) {
      const row = timelineWrap.createDiv({ cls: "rslatte-timeline-item rslatte-capture-inbox-item" });
      const content = row.createDiv({ cls: "rslatte-timeline-content" });
      const titleRow = content.createDiv({ cls: "rslatte-timeline-title-row rslatte-task-row rslatte-capture-inbox-row" });
      const datePrefix = normalizeDate(item.addDate);
      const rawText = String(item.text || "（无描述）").trim();
      const line = `${datePrefix || "----/--/--"}  ${rawText}`;
      titleRow.createDiv({ cls: "rslatte-timeline-text rslatte-task-title", text: line.slice(0, 120) });
      const rowActions = titleRow.createDiv({ cls: "rslatte-task-actions rslatte-task-actions-compact" });
      const btnToday = rowActions.createEl("button", { cls: "rslatte-icon-only-btn", title: "转今日任务" });
      btnToday.setText("☀️");
      btnToday.onclick = () => void this.toTodayTask(item);
      const btnSortRow = rowActions.createEl("button", { cls: "rslatte-icon-only-btn", title: "整理到任务/提醒/日程" });
      btnSortRow.setText("🗃️");
      btnSortRow.onclick = () =>
        this.openQuickAdd({
          draftText: item.text,
          withRecommendation: true,
          sourceInboxRef: { filePath: item.filePath, lineNo: item.lineNo },
        });
      const btnCancel = rowActions.createEl("button", { cls: "rslatte-icon-only-btn", title: "取消" });
      btnCancel.setText("⛔");
      btnCancel.onclick = () => void this.updateInboxMark(item, "-");
    }
  }

  private async renderFocusTab(container: HTMLElement, seq: number): Promise<void> {
    this.inputEl = null;
    const timerState = this.ensureTimerState();

    const header = container.createDiv({ cls: "rslatte-capture-header rslatte-capture-header--focus" });
    header.createEl("h3", { text: "专注" });
    const modeWrap = header.createDiv({ cls: "rslatte-capture-header-timer-mode" });
    const sel = modeWrap.createEl("select", {
      cls: "rslatte-capture-timer-display-select",
      attr: {
        "aria-label": "即时计时显示样式",
        title: "digital：数字时钟（默认）；clock：钟表形式（含数字时间）。与设置 → 快速记录一致。",
      },
    });
    const oDigital = sel.createEl("option", { text: "数字时钟", value: "digital" });
    oDigital.value = "digital";
    const oClock = sel.createEl("option", { text: "钟表形式", value: "clock" });
    oClock.value = "clock";
    const curMode = String(((this.plugin.settings as any)?.captureModule?.captureTimerDisplayMode ?? "digital")).trim();
    sel.value = curMode === "clock" ? "clock" : "digital";
    sel.onchange = async () => {
      const v = sel.value === "clock" ? "clock" : "digital";
      if (!this.plugin.settings.captureModule) {
        this.plugin.settings.captureModule = {
          captureInboxDir: (DEFAULT_SETTINGS as any).captureModule.captureInboxDir,
          captureInboxFileNameFormat: (DEFAULT_SETTINGS as any).captureModule.captureInboxFileNameFormat,
          captureArchiveDir: (DEFAULT_SETTINGS as any).captureModule.captureArchiveDir,
          captureShowStatuses: { ...(DEFAULT_SETTINGS as any).captureModule.captureShowStatuses },
        };
      }
      (this.plugin.settings.captureModule as any).captureTimerDisplayMode = v;
      try {
        await this.plugin.saveSettings();
      } catch {
        /* ignore */
      }
      void this.render();
    };
    const headerActions = header.createDiv({ cls: "rslatte-capture-header-actions" });
    if (timerState.status === "idle") {
      const startBtn = headerActions.createEl("button", {
        cls: "rslatte-capture-quickadd-btn",
        text: "⏳",
        title: "即时计时",
      });
      startBtn.onclick = () => void this.openStartTimerModal();
    } else if (timerState.status === "running") {
      const pauseBtn = headerActions.createEl("button", {
        cls: "rslatte-capture-quickadd-btn",
        text: "⏸",
        title: "暂停",
      });
      pauseBtn.onclick = () => void this.pauseTimer();
      const endBtn = headerActions.createEl("button", {
        cls: "rslatte-capture-quickadd-btn",
        text: "⏹",
        title: "结束并生成日程",
      });
      endBtn.onclick = () => void this.finishTimer();
      const resetBtn = headerActions.createEl("button", {
        cls: "rslatte-capture-quickadd-btn rslatte-capture-timer-reset-btn",
        text: "重置",
        title: "重置计时并清空专注主题与关联任务/输出（需确认）",
      });
      resetBtn.onclick = () => this.openResetTimerConfirm();
    } else {
      const resumeBtn = headerActions.createEl("button", {
        cls: "rslatte-capture-quickadd-btn",
        text: "▶",
        title: "继续",
      });
      resumeBtn.onclick = () => void this.resumeTimer();
      const endBtn = headerActions.createEl("button", {
        cls: "rslatte-capture-quickadd-btn",
        text: "⏹",
        title: "结束并生成日程",
      });
      endBtn.onclick = () => void this.finishTimer();
      const resetBtn = headerActions.createEl("button", {
        cls: "rslatte-capture-quickadd-btn rslatte-capture-timer-reset-btn",
        text: "重置",
        title: "重置计时并清空专注主题与关联任务/输出（需确认）",
      });
      resetBtn.onclick = () => this.openResetTimerConfirm();
    }

    const focusSection = container.createDiv({ cls: "rslatte-capture-focus-section" });
    const timerWrap = focusSection.createDiv({ cls: "rslatte-capture-timer-wrap" });
    const targetText = await this.getTimerTargetText(timerState);
    if (seq !== this._renderSeq) return;
    const targetCard = timerWrap.createDiv({ cls: "rslatte-capture-timer-target-card" });
    const rows = String(targetText ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
    for (const row of rows) {
      targetCard.createDiv({ cls: "rslatte-capture-timer-target-row", text: row });
    }
    const mode = String(((this.plugin.settings as any)?.captureModule?.captureTimerDisplayMode ?? "digital")).trim();
    const elapsed = formatHms(calcElapsedSec(timerState, nowIso()));
    this._timerClockEl = null;
    if (mode === "clock") {
      const clock = timerWrap.createDiv({ cls: "rslatte-capture-timer-clock" });
      clock.setAttribute("title", `当前计时：${elapsed}`);
      this._timerClockEl = clock;
      const sec = calcElapsedSec(timerState, nowIso());
      const ss = sec % 60;
      const mm = Math.floor(sec / 60) % 60;
      const hh = Math.floor(sec / 3600) % 12;
      const hHand = clock.createDiv({ cls: "rslatte-capture-timer-hand h" });
      const mHand = clock.createDiv({ cls: "rslatte-capture-timer-hand m" });
      const sHand = clock.createDiv({ cls: "rslatte-capture-timer-hand s" });
      hHand.style.transform = `translateX(-50%) rotate(${hh * 30 + mm * 0.5}deg)`;
      mHand.style.transform = `translateX(-50%) rotate(${mm * 6}deg)`;
      sHand.style.transform = `translateX(-50%) rotate(${ss * 6}deg)`;
      this._timerDigitalEl = null;
    } else {
      this._timerDigitalEl = timerWrap.createDiv({ cls: "rslatte-capture-timer-digital", text: elapsed });
    }
    const log = focusSection.createDiv({ cls: "rslatte-capture-timer-log" });
    this._timerLogEl = log;
    log.setText(this.buildTimerLogLines(timerState).join("\n"));
  }

  /** 外部跳转（如 Today 执行统计）：确保显示「记录」子页签 */
  public openRecordTabFromExternal(): void {
    if (this._activeTab !== "record") {
      this._activeTab = "record";
      void this.render();
    }
  }

  public refresh() {
    void this.render();
  }
}
