import { moment } from "obsidian";
import type { WorkEvent } from "../../types/stats/workEvent";
import { enrichWorkEventRefWithTaskContacts } from "../contacts/taskWorkEventContactRef";

const momentFn = moment as any;

/** 与原先 TaskRSLatteService.createTodayTask 内 append 字段对齐 */
export function buildWorkEventTaskCreateUi(p: {
  uid: string;
  text: string;
  due: string;
  scheduled?: string;
  recordDate: string;
  /** 完整任务行（含 `- [ ]`）；缺省则用 text 解析正文内 [[联系人]] */
  taskLine?: string;
  followContactUids?: string[];
}): WorkEvent {
  const scheduled = (p.scheduled ?? "").trim() || undefined;
  const ref = enrichWorkEventRefWithTaskContacts(
    {
      uid: p.uid,
      text: p.text,
      due: p.due,
      ...(scheduled ? { scheduled } : {}),
      record_date: p.recordDate,
    },
    { taskLine: p.taskLine ?? p.text, followContactUids: p.followContactUids }
  );
  return {
    ts: momentFn().format("YYYY-MM-DDTHH:mm:ssZ"),
    kind: "task",
    action: "create",
    source: "ui",
    ref,
    summary: `📝 新建任务 ${p.text}`,
    metrics: { due: p.due, ...(scheduled ? { scheduled } : {}) },
  };
}

/** 与原先 createTodayMemo 内 append 字段对齐 */
export function buildWorkEventMemoCreateUi(p: {
  uid: string;
  text: string;
  memoDate: string;
  repeatRule: string;
  recordDate: string;
  metaExtra?: Record<string, string | number | boolean | undefined | null>;
}): WorkEvent {
  return {
    ts: momentFn().format("YYYY-MM-DDTHH:mm:ssZ"),
    kind: "memo",
    action: "create",
    source: "ui",
    ref: {
      uid: p.uid,
      text: p.text,
      memo_date: p.memoDate,
      repeat_rule: p.repeatRule,
      record_date: p.recordDate,
      ...(p.metaExtra && Object.keys(p.metaExtra).length ? { meta_extra: p.metaExtra as any } : {}),
    },
    summary: `🗒 新建提醒 ${p.text}`,
    metrics: { memo_date: p.memoDate, repeat_rule: p.repeatRule },
  };
}

/** 与原先 createScheduleMemo 经编排写入的字段对齐；`kind` 为 `schedule`（ref 可仍带 category 供兼容） */
export function buildWorkEventScheduleCreateUi(p: {
  uid: string;
  lineText: string;
  scheduleDate: string;
  repeatRule: string;
  scheduleCategory: string;
  startTime: string;
  endTime: string;
  durationMin: number;
  /** 与日程笔记 meta `linked_task_uid` 对齐，供统计/分析 */
  linkedTaskUid?: string;
  /** 与日程笔记 meta `linked_output_id` 对齐 */
  linkedOutputId?: string;
}): WorkEvent {
  const rr = p.repeatRule;
  const ltu = String(p.linkedTaskUid ?? "").trim();
  const loid = String(p.linkedOutputId ?? "").trim();
  return {
    ts: momentFn().format("YYYY-MM-DDTHH:mm:ssZ"),
    kind: "schedule",
    action: "create",
    source: "ui",
    ref: {
      uid: p.uid,
      text: p.lineText,
      memo_date: p.scheduleDate,
      repeat_rule: rr,
      category: "schedule",
      schedule_category: p.scheduleCategory,
      start_time: p.startTime,
      end_time: p.endTime,
      ...(ltu ? { linked_task_uid: ltu } : {}),
      ...(loid ? { linked_output_id: loid } : {}),
    },
    summary: `📅 新建日程 ${p.lineText}`,
    metrics: { memo_date: p.scheduleDate, repeat_rule: rr, duration_min: p.durationMin },
  };
}

/** 更新类按钮通用事件构造：由调用方提供 summary/ref/metrics */
export function buildWorkEventUiAction(p: {
  kind: WorkEvent["kind"];
  action: WorkEvent["action"];
  summary: string;
  ref?: WorkEvent["ref"];
  metrics?: WorkEvent["metrics"];
  /** kind=task 时写入 contact_uids_strong/weak，供联系人互动从 WorkEvent 重放 */
  taskContactEnrich?: { taskLine: string; followContactUids?: string[] | null };
}): WorkEvent {
  let ref = p.ref;
  if (p.kind === "task" && p.taskContactEnrich) {
    ref = enrichWorkEventRefWithTaskContacts(p.ref ?? {}, {
      taskLine: p.taskContactEnrich.taskLine,
      followContactUids: p.taskContactEnrich.followContactUids ?? [],
    });
  }
  return {
    ts: momentFn().format("YYYY-MM-DDTHH:mm:ssZ"),
    kind: p.kind,
    action: p.action,
    source: "ui",
    summary: p.summary,
    ...(ref ? { ref } : {}),
    ...(p.metrics ? { metrics: p.metrics } : {}),
  };
}

/** 快速记录（Capture）统一 kind；`action`/`ref.capture_op` 区分具体操作 */
export function buildCaptureWorkEventUi(p: {
  action: WorkEvent["action"];
  summary: string;
  ref?: WorkEvent["ref"];
  metrics?: WorkEvent["metrics"];
}): WorkEvent {
  return {
    ts: momentFn().format("YYYY-MM-DDTHH:mm:ssZ"),
    kind: "capture",
    action: p.action,
    source: "ui",
    summary: p.summary,
    ...(p.ref ? { ref: p.ref } : {}),
    ...(p.metrics ? { metrics: p.metrics } : {}),
  };
}
