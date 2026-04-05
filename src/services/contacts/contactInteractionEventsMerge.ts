import type { ContactInteractionEvent, ContactsInteractionEntry } from "../../contactsRSLatte/types";

/** 与 indexStore.entryKey 一致 */
export function interactionEntryKey(e: ContactsInteractionEntry): string {
  const k = String((e as any).key ?? "").trim();
  if (k) return k;
  const ln = (e.line_no ?? -1) as number;
  return `${e.contact_uid}|${e.source_path}|${e.source_type}|${ln}`;
}

const STATUS_CN: Record<string, string> = {
  todo: "待办",
  in_progress: "进行中",
  done: "已完成",
  cancelled: "已取消",
  blocked: "阻塞",
  unknown: "未知",
};

function statusLabel(s: string): string {
  const t = String(s ?? "").trim().toLowerCase();
  return (STATUS_CN[t] ?? t) || "—";
}

function buildStatusChangeSummary(prev: ContactsInteractionEntry, next: ContactsInteractionEntry): string {
  const ps = String(prev.status ?? "").trim().toLowerCase();
  const ns = String(next.status ?? "").trim().toLowerCase();
  if (ps !== ns) {
    return `状态 ${statusLabel(ps)} → ${statusLabel(ns)}`;
  }
  return "有更新";
}

/** 日程/提醒：仅「完成」闭环记一条（§6.2） */
function shouldAppendMemoScheduleComplete(prev: ContactsInteractionEntry, next: ContactsInteractionEntry): boolean {
  const ps = String(prev.status ?? "").trim().toLowerCase();
  const ns = String(next.status ?? "").trim().toLowerCase();
  return ps !== ns && ns === "done" && ps !== "done";
}

function dedupeKey(ev: ContactInteractionEvent): string {
  const t = String(ev.occurred_at ?? "").slice(0, 16);
  const s = String(ev.summary ?? "").trim();
  return `${t}|${s}`;
}

/**
 * 在写入 contacts-interactions 前合并「上一次的条目」与「本次解析的条目」。
 * - 任务/项目任务的 interaction_events 不在此追加，改由 WorkEvent 重放（见 rebuildTaskProjectInteractionEventsFromWorkEvents）。
 * - 提醒/日程等仍在此按快照 diff 追加（§6.2）。
 */
export function mergeInteractionEventsWithPrevious(
  prevEntries: ContactsInteractionEntry[] | undefined,
  nextEntries: ContactsInteractionEntry[],
  nowIso: string,
  opts?: { maxEventsPerEntry?: number }
): ContactsInteractionEntry[] {
  const maxEv = Math.max(5, Math.min(200, Number(opts?.maxEventsPerEntry ?? 80) || 80));
  const prevByKey = new Map<string, ContactsInteractionEntry>();
  for (const e of prevEntries ?? []) {
    prevByKey.set(interactionEntryKey(e), e);
  }

  const out: ContactsInteractionEntry[] = [];
  for (const next of nextEntries) {
    const k = interactionEntryKey(next);
    const prev = prevByKey.get(k);
    const sourceType = String(next.source_type ?? "").trim();

    if (sourceType === "task" || sourceType === "project_task") {
      out.push({ ...next, interaction_events: undefined });
      continue;
    }

    const oldEvents = [...(prev?.interaction_events ?? [])];

    if (!prev) {
      const ev0 = Array.isArray(next.interaction_events) && next.interaction_events.length > 0 ? next.interaction_events : undefined;
      out.push({ ...next, interaction_events: ev0?.length ? ev0 : undefined });
      continue;
    }

    const stP = String(prev.status ?? "").trim().toLowerCase();
    const stN = String(next.status ?? "").trim().toLowerCase();
    const phP = String((prev as any).task_phase ?? "").trim();
    const phN = String((next as any).task_phase ?? "").trim();
    const foP = String(prev.follow_status ?? "");
    const foN = String(next.follow_status ?? "");

    const trackable = sourceType === "memo" || sourceType === "schedule";
    let append = false;
    let eventKind: ContactInteractionEvent["event_kind"] = "status_change";
    let summary = "";

    if (sourceType === "memo" || sourceType === "schedule") {
      if (shouldAppendMemoScheduleComplete(prev, next)) {
        append = true;
        eventKind = "complete";
        summary = "完成";
      }
    } else {
      const changed = stP !== stN || phP !== phN || foP !== foN;
      if (changed) {
        append = true;
        eventKind = "status_change";
        summary = buildStatusChangeSummary(prev, next);
      }
    }

    if (!trackable || !append) {
      const evFromNext = Array.isArray(next.interaction_events) && next.interaction_events.length > 0 ? next.interaction_events : null;
      const ev = evFromNext ?? (oldEvents.length ? oldEvents : undefined);
      out.push({ ...next, interaction_events: ev?.length ? ev : undefined });
      continue;
    }

    const ev: ContactInteractionEvent = {
      occurred_at: nowIso,
      event_kind: eventKind,
      summary,
    };
    const dk = dedupeKey(ev);
    const exists = oldEvents.some((e) => dedupeKey(e) === dk);
    let merged = exists ? oldEvents : [...oldEvents, ev];
    if (merged.length > maxEv) merged = merged.slice(-maxEv);

    out.push({ ...next, interaction_events: merged.length ? merged : undefined });
  }

  return out;
}
