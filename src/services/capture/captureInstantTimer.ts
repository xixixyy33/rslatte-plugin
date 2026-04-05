export type CaptureTimerStatus = "idle" | "running" | "paused";

export type CaptureTimerEventType = "start" | "pause" | "resume";

export type CaptureTimerEvent = {
  type: CaptureTimerEventType;
  ts: string; // ISO
};

export type CaptureInstantTimerState = {
  status: CaptureTimerStatus;
  purpose?: string;
  linkedTaskUid?: string;
  /** 与 output 文档 frontmatter `output_id` 一致；与 linkedTaskUid 互斥使用（UI 层保证） */
  linkedOutputId?: string;
  startedAt?: string;
  endedAt?: string;
  events: CaptureTimerEvent[];
};

export type CaptureTimerSegment = {
  start: Date;
  end: Date;
};

function parseIso(ts: string): Date | null {
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? d : null;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function formatYmdHms(tsIso: string): string {
  const d = parseIso(tsIso);
  if (!d) return tsIso;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}`;
}

export function formatHms(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function calcElapsedSec(state: CaptureInstantTimerState, nowTsIso: string): number {
  if (!state.startedAt) return 0;
  const start = parseIso(state.startedAt);
  const now = parseIso(nowTsIso);
  if (!start || !now) return 0;
  let total = Math.max(0, Math.floor((now.getTime() - start.getTime()) / 1000));
  const events = [...(state.events ?? [])].sort((a, b) => a.ts.localeCompare(b.ts));
  let pauseStart: Date | null = null;
  let pauseSec = 0;
  for (const ev of events) {
    const t = parseIso(ev.ts);
    if (!t) continue;
    if (ev.type === "pause" && !pauseStart) pauseStart = t;
    if (ev.type === "resume" && pauseStart) {
      pauseSec += Math.max(0, Math.floor((t.getTime() - pauseStart.getTime()) / 1000));
      pauseStart = null;
    }
  }
  if (pauseStart) pauseSec += Math.max(0, Math.floor((now.getTime() - pauseStart.getTime()) / 1000));
  total -= pauseSec;
  return Math.max(0, total);
}

function splitByMidnight(seg: CaptureTimerSegment): CaptureTimerSegment[] {
  const out: CaptureTimerSegment[] = [];
  let cur = new Date(seg.start.getTime());
  while (cur < seg.end) {
    const next = new Date(cur.getTime());
    next.setHours(24, 0, 0, 0);
    const end = next < seg.end ? next : seg.end;
    if (end > cur) out.push({ start: new Date(cur.getTime()), end: new Date(end.getTime()) });
    cur = end;
  }
  return out;
}

export function buildTimerSegments(
  state: CaptureInstantTimerState,
  endIso: string,
  pauseSplitMin: number = 30
): CaptureTimerSegment[] {
  if (!state.startedAt) return [];
  const start = parseIso(state.startedAt);
  const end = parseIso(endIso);
  if (!start || !end || end <= start) return [];
  const thresholdMs = Math.max(1, pauseSplitMin) * 60 * 1000;
  const events = [...(state.events ?? [])].sort((a, b) => a.ts.localeCompare(b.ts));
  const longPauses: Array<{ start: Date; end: Date }> = [];
  let pauseStart: Date | null = null;
  for (const ev of events) {
    const t = parseIso(ev.ts);
    if (!t) continue;
    if (ev.type === "pause" && !pauseStart) pauseStart = t;
    if (ev.type === "resume" && pauseStart) {
      if (t.getTime() - pauseStart.getTime() >= thresholdMs) longPauses.push({ start: pauseStart, end: t });
      pauseStart = null;
    }
  }
  if (pauseStart && end.getTime() - pauseStart.getTime() >= thresholdMs) longPauses.push({ start: pauseStart, end });

  let segments: CaptureTimerSegment[] = [{ start, end }];
  for (const p of longPauses) {
    const next: CaptureTimerSegment[] = [];
    for (const seg of segments) {
      if (p.end <= seg.start || p.start >= seg.end) {
        next.push(seg);
        continue;
      }
      if (p.start > seg.start) next.push({ start: seg.start, end: p.start });
      if (p.end < seg.end) next.push({ start: p.end, end: seg.end });
    }
    segments = next;
  }

  const split: CaptureTimerSegment[] = [];
  for (const seg of segments) split.push(...splitByMidnight(seg));
  return split.filter((s) => s.end.getTime() - s.start.getTime() >= 5 * 60 * 1000);
}

export function buildSegmentTimerLog(state: CaptureInstantTimerState, seg: CaptureTimerSegment): string {
  const inSeg = (ts: string): boolean => {
    const d = parseIso(ts);
    if (!d) return false;
    return d >= seg.start && d <= seg.end;
  };
  const parts: string[] = [];
  parts.push(`Start=${formatYmdHms(seg.start.toISOString())}`);
  for (const ev of state.events ?? []) {
    if (!inSeg(ev.ts)) continue;
    if (ev.type === "pause") parts.push(`Pause=${formatYmdHms(ev.ts)}`);
    if (ev.type === "resume") parts.push(`Resume=${formatYmdHms(ev.ts)}`);
  }
  parts.push(`End=${formatYmdHms(seg.end.toISOString())}`);
  return parts.join("|");
}
