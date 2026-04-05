import { App, TFile, moment } from "obsidian";
import type { ContactInteractionEvent } from "../../contactsRSLatte/types";
import type { TaskPanelSettings } from "../../types/taskTypes";
import { compactInteractionEventSummaryForDisplay, formatIsoForDisplay } from "./contactInteractionDisplay";
// ✅ moment 从 Obsidian 导入，但 TypeScript 类型定义可能不完整，使用类型断言
const momentFn = moment as any;

export type ManualContactEventWriteOpts = {
  /** e.g. "## 互动记录" */
  sectionHeader: string;
  /** optional: e.g. "### 手动互动（纪要）". If empty, write directly under section. */
  subHeader?: string;
  /** timestamp format shown in bullet. default: YYYY-MM-DD HH:mm */
  timeFormat?: string;
  /** optional: add a trailing wiki link or markdown link */
  sourceLink?: string;
  /** 指定互动发生时刻（本地）；不传则使用「当下」 */
  occurredAt?: Date;
};

function isHeaderLine(line: string): boolean {
  return /^#{1,6}\s+/.test((line ?? "").trim());
}

function headerLevel(line: string): number {
  const m = /^\s*(#{1,6})\s+/.exec(line ?? "");
  return m ? m[1].length : 0;
}

function normalizeHeader(h: string): string {
  return String(h ?? "").trim();
}

function ensureEndsWithNewline(s: string): string {
  if (!s.endsWith("\n")) return s + "\n";
  return s;
}

function buildBulletLines(ts: string, content: string, sourceLink?: string): string[] {
  const raw = String(content ?? "").trim();
  const cleaned = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = cleaned.split("\n").map((x) => x.trimEnd());
  const first = (parts[0] ?? "").trim();
  const suffix = sourceLink ? ` ${sourceLink}` : "";
  const out: string[] = [`- ${ts} ${first}${suffix}`.trimEnd()];
  for (let i = 1; i < parts.length; i++) {
    const ln = parts[i].trim();
    if (!ln) continue;
    out.push(`  ${ln}`);
  }
  return out;
}

/**
 * Append a manual interaction bullet into a contact md file under a specific section/subheader.
 * - Does NOT rely on Dataview
 * - Does NOT create extra files
 * - Best-effort: if file reading fails, throws (caller can catch)
 */
export async function appendManualContactEvent(app: App, file: TFile, content: string, opts: ManualContactEventWriteOpts): Promise<void> {
  const sectionHeader = normalizeHeader(opts.sectionHeader) || "## 互动记录";
  const subHeader = normalizeHeader(opts.subHeader ?? "");
  const timeFmt = String(opts.timeFormat ?? "YYYY-MM-DD HH:mm");

  const ts = opts.occurredAt ? momentFn(opts.occurredAt).format(timeFmt) : momentFn().format(timeFmt);
  const bulletLines = buildBulletLines(ts, content, opts.sourceLink);
  if ((content ?? "").trim().length === 0) throw new Error("empty content");

  const raw = await app.vault.read(file);
  const text = raw.replace(/\r\n/g, "\n");
  const lines = text.split("\n");

  const findExactLine = (target: string, start: number, end: number): number => {
    const t = target.trim();
    if (!t) return -1;
    for (let i = start; i < end; i++) {
      if ((lines[i] ?? "").trim() === t) return i;
    }
    return -1;
  };

  const insertLinesAt = (idx: number, newLines: string[]) => {
    lines.splice(idx, 0, ...newLines);
  };

  const sectionLine = findExactLine(sectionHeader, 0, lines.length);

  // Helper: find end index (exclusive) of a section/header block.
  const findBlockEnd = (startLine: number, level: number): number => {
    for (let i = startLine + 1; i < lines.length; i++) {
      if (!isHeaderLine(lines[i])) continue;
      const lv = headerLevel(lines[i]);
      if (lv > 0 && lv <= level) return i;
    }
    return lines.length;
  };

  const ensureBlankLine = (idx: number) => {
    if (idx < 0 || idx > lines.length) return;
    const prev = lines[idx - 1] ?? "";
    if (idx === 0) return;
    if (prev.trim() !== "") {
      insertLinesAt(idx, [""]);
    }
  };

  if (sectionLine < 0) {
    // append new section at end
    // ensure file ends with a newline and has a blank line before new section
    // remove trailing empty lines at end to keep tidy (but keep one)
    while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") {
      lines.pop();
    }
    lines.push("");
    lines.push(sectionHeader);
    if (subHeader) {
      lines.push("");
      lines.push(subHeader);
    }
    lines.push("");
    lines.push(...bulletLines);
    lines.push("");
  } else {
    const secLevel = headerLevel(sectionHeader);
    const secEnd = findBlockEnd(sectionLine, secLevel);

    if (subHeader) {
      const subLine = findExactLine(subHeader, sectionLine + 1, secEnd);
      if (subLine < 0) {
        // create subHeader near end of section
        let insertAt = secEnd;
        // trim trailing blank lines inside section
        while (insertAt > sectionLine + 1 && (lines[insertAt - 1] ?? "").trim() === "") {
          insertAt--;
        }
        // ensure blank line before subHeader
        ensureBlankLine(insertAt);
        insertLinesAt(insertAt, [subHeader, "", ...bulletLines, ""]);
      } else {
        const subLevel = headerLevel(subHeader);
        const subEnd = findBlockEnd(subLine, subLevel);
        let insertAt = subEnd;
        while (insertAt > subLine + 1 && (lines[insertAt - 1] ?? "").trim() === "") {
          insertAt--;
        }
        ensureBlankLine(insertAt);
        insertLinesAt(insertAt, [...bulletLines, ""]);
      }
    } else {
      // write directly under section
      let insertAt = secEnd;
      while (insertAt > sectionLine + 1 && (lines[insertAt - 1] ?? "").trim() === "") {
        insertAt--;
      }
      ensureBlankLine(insertAt);
      insertLinesAt(insertAt, [...bulletLines, ""]);
    }
  }

  const outText = ensureEndsWithNewline(lines.join("\n"));
  await app.vault.modify(file, outText);
}

// ---------------------------------------------
// Step 6: Controlled generated block (dynamic)
// ---------------------------------------------

export type DynamicContactSummaryItem = {
  statusIcon?: string; // pre-rendered icon (e.g. ✅)，应与任务管理侧栏一致（见 statusIconForInteractionWithPhase）
  source_type?: string; // e.g. task / project_task
  snippet: string;
  source_path: string;
  line_no?: number;
  heading?: string;
  /** 关注中/已结束，用于在动态块中显示文字标签，与任务管理侧栏一致 */
  follow_status?: "following" | "ended";
  /** 实际互动记录（状态变更等），渲染为主条目下的子列表 */
  interaction_events?: ContactInteractionEvent[];
};

export type ReplaceGeneratedBlockResult = {
  changed: boolean;
  created: boolean;
};

/** 仅按 status 的图标（不区分 phase），保留用于非任务类条目。 */
export function statusIconForInteractionStatus(status: string): string {
  const st = String(status ?? "").trim();
  if (!st) return "•";
  switch (st) {
    case "done": return "✅";
    case "cancelled": return "⛔";
    case "in_progress": return "▶";
    case "blocked": return "🛑";
    case "todo": return "☐";
    default: return "•";
  }
}

/**
 * 根据 status + task_phase 返回与任务管理侧栏一致的图标：
 * done→✅, cancelled→⛔, todo→☐, in_progress+waiting_others→↻, in_progress+waiting_until→⏸, in_progress→▶
 */
export function statusIconForInteractionWithPhase(status: string, taskPhase?: string): string {
  const st = String(status ?? "").trim().toLowerCase();
  const phase = String(taskPhase ?? "").trim();
  if (!st) return "•";
  if (st === "done") return "✅";
  if (st === "cancelled") return "⛔";
  if (st === "todo") return "☐";
  if (st === "in_progress") {
    if (phase === "waiting_others") return "↻";
    if (phase === "waiting_until") return "⏸";
    return "▶";
  }
  if (st === "blocked") return "🛑";
  return "•";
}

const DYN_START = "<!-- rslatte:contact:dynamic:start -->";
const DYN_END = "<!-- rslatte:contact:dynamic:end -->";
/** 旧版/手改注释可能带下划线，识别以便替换并统一写回 canonical 标记 */
const LEGACY_DYN_START = "<!-- rs_latte:contact:dynamic:start -->";
const LEGACY_DYN_END = "<!-- rs_latte:contact:dynamic:end -->";

function lineIsDynStart(line: string): boolean {
  const t = (line ?? "").trim();
  return t === DYN_START || t === LEGACY_DYN_START;
}

function lineIsDynEnd(line: string): boolean {
  const t = (line ?? "").trim();
  return t === DYN_END || t === LEGACY_DYN_END;
}

function normalizeNewlines(text: string): string {
  return String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// 未使用的函数，保留以备将来使用
// function sourceShortLabel(path: string): string {
//   const p = String(path ?? "");
//   const seg = p.split("/").pop() ?? p;
//   return seg || p;
// }

function truncateOneLine(s: string, maxLen: number): string {
  const one = String(s ?? "").replace(/\s+/g, " ").trim();
  if (one.length <= maxLen) return one;
  return one.slice(0, Math.max(0, maxLen - 1)) + "…";
}

function stripTaskCheckboxPrefix(s: string): string {
  const t = String(s ?? "");
  return t.replace(/^\s*[-*+]\s*\[[^\]]*\]\s*/u, "");
}

function formatEventLineTime(iso: string): string {
  const s = String(iso ?? "").trim();
  if (!s) return "";
  return s.length >= 16 ? s.slice(0, 16).replace("T", " ") : s;
}

function buildDynamicSummaryLines(
  items: DynamicContactSummaryItem[],
  limit: number,
  taskPanel?: TaskPanelSettings | null,
): string[] {
  const out: string[] = [];
  const take = Math.max(0, Math.min(Number(limit ?? 20) || 20, 200));
  const list = (items ?? []).slice(0, take);

  if (list.length === 0) {
    out.push("- （暂无来自任务/项目任务的动态引用）");
    return out;
  }

  for (const it of list) {
    const icon = String(it.statusIcon ?? "•").trim() || "•";
    const st = String(it.source_type ?? "").trim();
    const followStatus = (it.follow_status ?? "") as "following" | "ended" | "";
    const followLabel =
      followStatus && (st === "task" || st === "project_task")
        ? (followStatus === "following" ? "**关注中** " : "**已结束** ")
        : "";
    const sn = truncateOneLine(stripTaskCheckboxPrefix(it.snippet ?? ""), 140);
    const fileLabel = String(it.source_path ?? "");
    const link = `[[${it.source_path}|${fileLabel}]]`;
    const ln = Number(it.line_no ?? 0);
    const lnPart = ln > 0 ? ` (L${ln})` : "";
    const head = String(it.heading ?? "").trim();
    const headPart = head ? ` · ${head}` : "";
    const stPart = st ? `(${st}) ` : "";
    out.push(`- ${icon} ${followLabel}${stPart}${sn} — ${link}${lnPart}${headPart}`.trim());

    const evs = [...(it.interaction_events ?? [])].sort(
      (a, b) => Date.parse(String(a.occurred_at ?? "")) - Date.parse(String(b.occurred_at ?? ""))
    );
    for (const ev of evs) {
      const t = formatIsoForDisplay(String(ev.occurred_at ?? ""), taskPanel);
      const sum = compactInteractionEventSummaryForDisplay(String(ev.summary ?? "").trim(), it.snippet ?? "");
      const line = sum ? `${t} · ${sum}` : t;
      if (line) out.push(`  - ${line}`);
    }
  }
  return out;
}

/**
 * Replace (or create) a controlled generated block inside a contact note.
 *
 * The note contains:
 *   <!-- rslatte:contact:dynamic:start -->
 *   ...generated content...
 *   <!-- rslatte:contact:dynamic:end -->
 *
 * Rules:
 * - Only replace the content between the first valid start/end pair.
 * - Remove any additional duplicated blocks (best-effort) to avoid repeated blocks.
 * - Do not scan other notes; only touches the given file.
 */
export async function replaceContactDynamicGeneratedBlock(
  app: App,
  file: TFile,
  items: DynamicContactSummaryItem[],
  opts?: { limit?: number; sectionHeader?: string; subHeader?: string; taskPanel?: TaskPanelSettings },
): Promise<ReplaceGeneratedBlockResult> {
  const limit = Math.max(1, Math.min(Number(opts?.limit ?? 20) || 20, 200));
  const sectionHeader = normalizeHeader(opts?.sectionHeader ?? "## 互动记录") || "## 互动记录";
  const subHeader = normalizeHeader(opts?.subHeader ?? "");

  const raw = await app.vault.read(file);
  const text = normalizeNewlines(raw);
  const lines = text.split("\n");

  const gen = buildDynamicSummaryLines(items, limit, opts?.taskPanel);
  const blockLines = [DYN_START, ...gen, DYN_END];

  const findExactLine = (target: string, start: number, end: number): number => {
    const t = String(target ?? "").trim();
    if (!t) return -1;
    for (let i = start; i < end; i++) {
      if ((lines[i] ?? "").trim() === t) return i;
    }
    return -1;
  };

  const insertLinesAt = (idx: number, newLines: string[]) => {
    lines.splice(idx, 0, ...newLines);
  };

  const findBlockEnd = (startLine: number, level: number): number => {
    for (let i = startLine + 1; i < lines.length; i++) {
      if (!isHeaderLine(lines[i])) continue;
      const lv = headerLevel(lines[i]);
      if (lv > 0 && lv <= level) return i;
    }
    return lines.length;
  };

  const ensureBlankLine = (idx: number) => {
    if (idx <= 0 || idx > lines.length) return;
    if ((lines[idx - 1] ?? "").trim() !== "") insertLinesAt(idx, [""]); 
  };

  // 1) Ensure the target section/subheader exists and compute the target range.
  let sectionLine = findExactLine(sectionHeader, 0, lines.length);
  let secEnd = -1;
  if (sectionLine < 0) {
    // append section at EOF
    while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
    if (lines.length > 0) lines.push("");
    lines.push(sectionHeader);
    if (subHeader) {
      lines.push("");
      lines.push(subHeader);
    }
    lines.push("");
    sectionLine = findExactLine(sectionHeader, 0, lines.length);
  }
  const secLevel = headerLevel(sectionHeader);
  secEnd = findBlockEnd(sectionLine, secLevel);

  let targetStart = sectionLine + 1;
  let targetEnd = secEnd;
  if (subHeader) {
    let subLine = findExactLine(subHeader, sectionLine + 1, secEnd);
    if (subLine < 0) {
      // create subHeader near end of section
      let insertAt = secEnd;
      while (insertAt > sectionLine + 1 && (lines[insertAt - 1] ?? "").trim() === "") insertAt--;
      ensureBlankLine(insertAt);
      insertLinesAt(insertAt, [subHeader, ""]);
      subLine = findExactLine(subHeader, sectionLine + 1, lines.length);
      // section end might shift
      secEnd = findBlockEnd(sectionLine, secLevel);
    }
    const subLevel = headerLevel(subHeader);
    const subEnd = findBlockEnd(subLine, subLevel);
    targetStart = subLine + 1;
    targetEnd = subEnd;
  }

  // 2) Find all blocks across file (pairs). We'll keep at most one within target range.
  const blocks: Array<{ s: number; e: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lineIsDynStart(lines[i] ?? "")) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (lineIsDynEnd(lines[j] ?? "")) {
        blocks.push({ s: i, e: j });
        i = j;
        break;
      }
    }
  }

  // Choose the first block that is fully inside target range.
  let keepIndex = -1;
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k];
    if (b.s >= targetStart && b.e < targetEnd) { keepIndex = k; break; }
  }

  // Remove all blocks except the kept one (if any).
  // Splice from bottom to top to keep indices stable.
  for (let k = blocks.length - 1; k >= 0; k--) {
    if (k === keepIndex) continue;
    const b = blocks[k];
    lines.splice(b.s, b.e - b.s + 1);
  }

  let created = false;

  // Recompute target range after deletions (best-effort)
  sectionLine = findExactLine(sectionHeader, 0, lines.length);
  secEnd = sectionLine >= 0 ? findBlockEnd(sectionLine, headerLevel(sectionHeader)) : lines.length;
  targetStart = sectionLine + 1;
  targetEnd = secEnd;
  if (subHeader) {
    const subLine2 = findExactLine(subHeader, sectionLine + 1, secEnd);
    const subEnd2 = subLine2 >= 0 ? findBlockEnd(subLine2, headerLevel(subHeader)) : secEnd;
    targetStart = (subLine2 >= 0 ? subLine2 + 1 : sectionLine + 1);
    targetEnd = subEnd2;
  }

  // 3) Replace existing kept block (if any) OR insert a new block at end of target range.
  let s = -1;
  let e = -1;
  for (let i = targetStart; i < targetEnd; i++) {
    if (lineIsDynStart(lines[i] ?? "")) { s = i; break; }
  }
  if (s >= 0) {
    for (let j = s + 1; j < targetEnd; j++) {
      if (lineIsDynEnd(lines[j] ?? "")) { e = j; break; }
    }
  }

  if (s >= 0 && e > s) {
    const existing = lines.slice(s, e + 1).join("\n");
    const next = blockLines.join("\n");
    if (existing !== next) lines.splice(s, e - s + 1, ...blockLines);
  } else {
    // Insert new block near end of target region.
    let insertAt = targetEnd;
    while (insertAt > targetStart && (lines[insertAt - 1] ?? "").trim() === "") insertAt--;
    ensureBlankLine(insertAt);
    insertLinesAt(insertAt, [...blockLines, ""]);
    created = true;
  }

  const outText = ensureEndsWithNewline(lines.join("\n"));
  const changed = outText !== ensureEndsWithNewline(text);
  if (changed) {
    await app.vault.modify(file, outText);
  }
  return { changed, created };
}
