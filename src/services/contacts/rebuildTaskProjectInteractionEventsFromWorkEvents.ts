/**
 * 联系人互动索引刷新时：任务/项目任务的 interaction_events 由 WorkEvent 流重放生成，
 * 不再依赖 prev/next 快照 diff（见 docs/V2改造方案/03-联系人优化方案.md §6、CODE_MAP 3.8）。
 */
import { normalizePath } from "obsidian";
import type { ContactInteractionEvent, ContactsInteractionEntry } from "../../contactsRSLatte/types";
import type { WorkEvent } from "../../types/stats/workEvent";
import type { WorkEventService } from "../workEventService";
import {
  INTERACTION_EVENT_PRIORITY,
  strongTaskStatusChangeShouldRecord,
  weakWaitingPhaseShouldRecord,
} from "./contactInteractionDynamicRules";
import { readContactUidsStrongWeak } from "./taskWorkEventContactRef";
import { toLocalOffsetIsoString } from "../../utils/localCalendarYmd";

const REPLAY_MONTHS = 6;

function dedupeInteractionKey(ev: ContactInteractionEvent): string {
  const t = String(ev.occurred_at ?? "").slice(0, 16);
  const k = String(ev.event_kind ?? "");
  const s = String(ev.summary ?? "").trim();
  return `${t}|${k}|${s}`;
}

/** 将 task_phase 粗映射为联系人语义上的「状态」用于强关联 checkbox 规则 */
function phaseToContactStatus(phase: string): string {
  const p = String(phase ?? "").trim().toLowerCase();
  if (p === "done") return "done";
  if (p === "cancelled") return "cancelled";
  if (p === "todo") return "todo";
  if (p === "in_progress" || p === "waiting_others" || p === "waiting_until") return "in_progress";
  return p || "unknown";
}

function workEventMatchesEntry(ev: WorkEvent, entry: ContactsInteractionEntry): boolean {
  const ref = ev.ref ?? {};
  const fp = normalizePath(String(ref.file_path ?? "").trim());
  const ep = normalizePath(String(entry.source_path ?? "").trim());
  if (!fp || !ep || fp !== ep) return false;

  const stable = String((entry as any).source_block_id ?? "").trim();
  if (stable) {
    const uid = String(ref.uid ?? "").trim();
    const tid = String(ref.task_id ?? "").trim();
    if (uid && uid === stable) return true;
    if (tid && tid === stable) return true;
  }

  const lnEv = Number(ref.line_no);
  const lnEn = Number(entry.line_no ?? -1);
  if (Number.isFinite(lnEv) && lnEn > 0) {
    if (lnEv + 1 === lnEn || lnEv === lnEn) return true;
  }
  return !stable;
}

function workEventTargetsContact(ev: WorkEvent, entry: ContactsInteractionEntry): boolean {
  const { strong, weak } = readContactUidsStrongWeak(ev.ref);
  const uid = String(entry.contact_uid ?? "").trim();
  if (!uid) return false;
  const assoc = String((entry as any).follow_association_type ?? "").trim();
  if (assoc === "weak") {
    if (weak.length > 0) return weak.includes(uid);
    if (strong.length > 0) return false;
    return workEventMatchesEntry(ev, entry);
  }
  if (strong.length > 0) return strong.includes(uid);
  if (weak.length > 0) return false;
  return workEventMatchesEntry(ev, entry);
}

/**
 * §6.5.0：仅 update、且无 checkbox 目标 to 的，视为「仅改 meta」类，不产生实际互动。
 */
function workEventIsMetaOnlyUpdate(ev: WorkEvent): boolean {
  if (String(ev.action ?? "") !== "update") return false;
  const to = String(ev.ref?.to ?? "").trim();
  return !to;
}

function pickCandidatesForEntry(ev: WorkEvent, entry: ContactsInteractionEntry): ContactInteractionEvent[] {
  if (workEventIsMetaOnlyUpdate(ev)) return [];

  const ref = ev.ref ?? {};
  const phB = String(ref.task_phase_before ?? "").trim();
  const phA = String(ref.task_phase_after ?? "").trim();
  const assoc = String((entry as any).follow_association_type ?? "").trim();

  type Cand = { rank: number; ev: ContactInteractionEvent };
  const cands: Cand[] = [];

  if (weakWaitingPhaseShouldRecord(phB, phA)) {
    const summary = `阶段 ${phB || "—"} → ${phA || "—"}`;
    cands.push({
      rank: INTERACTION_EVENT_PRIORITY.leave_waiting,
      ev: {
        occurred_at: String(ev.ts ?? "").trim() || toLocalOffsetIsoString(),
        event_kind: "leave_waiting",
        summary,
      },
    });
  }

  if (assoc !== "weak") {
    const stB = phaseToContactStatus(phB);
    const stA = phaseToContactStatus(phA);
    if (strongTaskStatusChangeShouldRecord(stB, stA)) {
      const summary =
        String(ev.summary ?? "").trim().slice(0, 220) ||
        `状态 ${stB || "—"} → ${stA || "—"}`;
      cands.push({
        rank: INTERACTION_EVENT_PRIORITY.status_change,
        ev: {
          occurred_at: String(ev.ts ?? "").trim() || toLocalOffsetIsoString(),
          event_kind: "status_change",
          summary,
        },
      });
    }
  }

  if (cands.length === 0) return [];

  if (assoc === "weak") {
    return cands.filter((c) => c.rank === INTERACTION_EVENT_PRIORITY.leave_waiting).map((c) => c.ev);
  }

  let best = cands[0]!;
  for (const c of cands) {
    if (c.rank < best.rank) best = c;
  }
  return [best.ev];
}

function rebuildEventsForOneEntry(entry: ContactsInteractionEntry, pool: WorkEvent[]): ContactInteractionEvent[] {
  const st = String(entry.source_type ?? "");
  if (st !== "task" && st !== "project_task") return [];

  const kinds = new Set(["task", "projecttask"]);
  const matched = pool.filter((e) => kinds.has(String(e.kind ?? "")) && workEventMatchesEntry(e, entry) && workEventTargetsContact(e, entry));

  matched.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  const out: ContactInteractionEvent[] = [];
  const seen = new Set<string>();
  for (const ev of matched) {
    for (const ie of pickCandidatesForEntry(ev, entry)) {
      const dk = dedupeInteractionKey(ie);
      if (seen.has(dk)) continue;
      seen.add(dk);
      out.push(ie);
    }
  }
  out.sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
  const maxEv = 80;
  if (out.length > maxEv) return out.slice(-maxEv);
  return out;
}

export async function rebuildTaskProjectInteractionEventsFromWorkEvents(
  workEventSvc: WorkEventService | null | undefined,
  entries: ContactsInteractionEntry[]
): Promise<ContactsInteractionEntry[]> {
  if (!workEventSvc || typeof workEventSvc.readEventsByDateRange !== "function") {
    return entries;
  }

  const end = new Date();
  const start = new Date();
  start.setMonth(start.getMonth() - REPLAY_MONTHS);

  let pool: WorkEvent[] = [];
  try {
    pool = await workEventSvc.readEventsByDateRange(start, end);
  } catch {
    return entries;
  }

  pool = pool.filter((e) => e.kind === "task" || e.kind === "projecttask");

  return entries.map((e) => {
    const st = String(e.source_type ?? "");
    if (st !== "task" && st !== "project_task") return e;
    const interaction_events = rebuildEventsForOneEntry(e, pool);
    return {
      ...e,
      interaction_events: interaction_events.length ? interaction_events : undefined,
    };
  });
}
