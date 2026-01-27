import type { MilestoneProgress, ProjectTaskItem } from "./types";

export const DEFAULT_MILESTONE_PATH = "未指定里程碑";


/** Internal milestone node describing a heading block. */
export type MilestoneNode = {
  /** Leaf heading title. */
  name: string;
  /** Full path (L1 / L2 / L3). */
  path: string;
  /** Heading level (1~3). */
  level: 1 | 2 | 3;
  /** Parent path, if any. */
  parentPath?: string;
  /** Heading line number (0-based). */
  headingLineNo: number;
  /** End of the whole block: stop at next heading with level <= current level (same or higher). */
  blockEndLineNo: number;
  /** Insert point for DIRECT tasks: the first next heading of ANY level (any # count). */
  insertBeforeLineNo: number;
  /** Optional milestone status written under heading as a rslatte comment. */
  milestoneStatus?: "active" | "done" | "cancelled";
  /** Creation timestamp (ISO string) from rslatte comment ts field when milestone_status=active or first created */
  createdDate?: string; // YYYY-MM-DD
  /** Done timestamp (ISO string) from rslatte comment ts field when milestone_status=done */
  doneDate?: string; // YYYY-MM-DD
  /** Cancelled timestamp (ISO string) from rslatte comment ts field when milestone_status=cancelled */
  cancelledDate?: string; // YYYY-MM-DD
};

/**
 * Parse multi-level milestones (max 3 levels) from a project tasklist markdown.
 *
 * Rules:
 * - Milestones are headings: `#` / `##` / `###`.
 * - Path is computed by heading stack: `L1 / L2 / L3`.
 * - `insertBeforeLineNo` is the *first* subsequent heading (any level), so inserting tasks at this point
 *   will never accidentally place them into a child milestone block.
 */
export function parseMilestoneNodes(markdown: string): MilestoneNode[] {
  const text = String(markdown ?? "");
  const lines = text.split(/\r?\n/);
  const parseStatusAndDatesInRange = (from: number, to: number): {
    status?: "active" | "done" | "cancelled";
    createdDate?: string;
    doneDate?: string;
    cancelledDate?: string;
  } => {
    // Scan heading block range [from, to) for milestone_status and timestamps; tolerate multiple/unsorted lines and take the last valid one.
    let lastStatus: "active" | "done" | "cancelled" | undefined = undefined;
    let createdDate: string | undefined = undefined;
    let doneDate: string | undefined = undefined;
    let cancelledDate: string | undefined = undefined;
    let firstTsDate: string | undefined = undefined; // 第一个 ts 日期（用于创建时间）
    
    for (let j = Math.max(0, from); j < Math.min(lines.length, to); j++) {
      const s = String(lines[j] ?? "").trim();
      if (!s) continue;
      const mm = s.match(/<!--\s*rslatte:([\s\S]*?)-->/i);
      if (!mm) continue;
      const body = String(mm[1] ?? "");
      
      // Parse milestone_status
      const sm = body.match(/milestone_status\s*=\s*([^;\s]+)\b/i);
      let currentStatus: "active" | "done" | "cancelled" | undefined = undefined;
      if (sm?.[1]) {
        const v = String(sm[1]).trim().toLowerCase();
        if (v === "done") {
          currentStatus = "done";
          lastStatus = "done";
        } else if (v === "cancelled" || v === "canceled") {
          currentStatus = "cancelled";
          lastStatus = "cancelled";
        } else if (v === "active" || v === "todo" || v === "open") {
          currentStatus = "active";
          lastStatus = "active";
        }
      }
      
      // Parse ts (timestamp) - extract YYYY-MM-DD from ISO string
      const tsMatch = body.match(/ts\s*=\s*([^;\s]+)\b/i);
      if (tsMatch?.[1]) {
        const ts = String(tsMatch[1]).trim();
        // Extract YYYY-MM-DD from ISO timestamp (e.g., "2026-01-23T10:30:00+08:00" -> "2026-01-23")
        const dateMatch = ts.match(/^(\d{4}-\d{2}-\d{2})/);
        if (dateMatch?.[1]) {
          const dateStr = dateMatch[1];
          
          // 记录第一个 ts 作为创建时间（如果还没有创建时间）
          if (!firstTsDate) {
            firstTsDate = dateStr;
            createdDate = dateStr;
          }
          
          // 根据当前状态确定日期类型
          if (currentStatus === "done") {
            doneDate = dateStr;
          } else if (currentStatus === "cancelled") {
            cancelledDate = dateStr;
          }
        }
      }
    }
    
    // 如果没有找到创建时间，但找到了第一个 ts，使用它
    if (!createdDate && firstTsDate) {
      createdDate = firstTsDate;
    }
    
    return {
      status: lastStatus,
      createdDate,
      doneDate,
      cancelledDate,
    };
  };

  type Head = { level: 1 | 2 | 3; name: string; line: number; path: string; parentPath?: string;  };
  const heads: Head[] = [];
  const stack: Array<{ name: string; level: 1 | 2 | 3; path: string }> = [];

  const headingRe = /^(#{1,3})\s+(.+?)\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] ?? "").match(headingRe);
    if (!m) continue;
    const level = Math.min(3, Math.max(1, m[1].length)) as 1 | 2 | 3;
    const name = String(m[2] ?? "").trim();
    if (!name) continue;

    // normalize stack to (level-1)
    while (stack.length >= level) stack.pop();
    const parentPath = stack.length ? stack[stack.length - 1].path : undefined;
    const path = (parentPath ? `${parentPath} / ${name}` : name).trim();
    stack.push({ name, level, path });

    heads.push({ level, name, line: i, path, parentPath });
  }

  // compute blockEndLineNo (same/higher heading) and insertBeforeLineNo (any heading)
  const anyHeadingRe = /^#{1,6}\s+.+/;
  const out: MilestoneNode[] = [];

  for (let idx = 0; idx < heads.length; idx++) {
    const h = heads[idx];

    let insertBeforeLineNo = lines.length;
    for (let j = h.line + 1; j < lines.length; j++) {
      if (anyHeadingRe.test(lines[j] ?? "")) {
        insertBeforeLineNo = j;
        break;
      }
    }

    let blockEndLineNo = lines.length;
    for (let j = h.line + 1; j < lines.length; j++) {
      const m2 = (lines[j] ?? "").match(/^(#{1,6})\s+.+/);
      if (!m2) continue;
      const lvl2 = Math.min(6, Math.max(1, m2[1].length));
      if (lvl2 <= h.level) {
        blockEndLineNo = j;
        break;
      }
    }

    const statusAndDates = parseStatusAndDatesInRange(h.line + 1, insertBeforeLineNo);
    out.push({
      name: h.name,
      path: h.path,
      level: h.level,
      parentPath: h.parentPath,
      headingLineNo: h.line,
      blockEndLineNo,
      insertBeforeLineNo,
      milestoneStatus: statusAndDates.status,
      createdDate: statusAndDates.createdDate,
      doneDate: statusAndDates.doneDate,
      cancelledDate: statusAndDates.cancelledDate,
    });
  }

  return out;
}

/**
 * Parse milestone progress counts.
 *
 * IMPORTANT (per user's requirement A):
 * - Progress only counts DIRECT tasks under the milestone heading.
 * - DIRECT range: (headingLineNo+1) .. (insertBeforeLineNo-1)
 */
export function parseMilestonesAndCounts(markdown: string): MilestoneProgress[] {
  const text = String(markdown ?? "");
  const lines = text.split(/\r?\n/);
  const nodes = parseMilestoneNodes(text);

  const statusChar = (line: string): string | null => {
    const m = (line ?? "").match(/^\s*[-*]\s+\[([ xX\/-])\]/);
    return m ? m[1] : null;
  };

  // keep legacy semantics: "-" is treated as done in progress bar
  const toStatus = (c: string): "done" | "todo" | "inprogress" | null => {
    if (c === "x" || c === "X" || c === "-") return "done";
    if (c === "/") return "inprogress";
    if (c === " ") return "todo";
    return null;
  };

  const out: MilestoneProgress[] = [];
  for (const n of nodes) {
    let done = 0;
    let todo = 0;
    let inprogress = 0;
    const start = Math.min(lines.length, n.headingLineNo + 1);
    const end = Math.min(lines.length, n.insertBeforeLineNo);
    for (let i = start; i < end; i++) {
      const c = statusChar(lines[i] ?? "");
      if (c === null) continue;
      const s = toStatus(c);
      if (s === "done") done++;
      else if (s === "todo") todo++;
      else if (s === "inprogress") inprogress++;
    }
    const total = done + todo + inprogress;
    out.push({
      name: n.name,
      path: n.path,
      level: n.level,
      parentPath: n.parentPath,
      headingLineNo: n.headingLineNo,
      milestoneStatus: n.milestoneStatus,
      createdDate: n.createdDate,
      doneDate: n.doneDate,
      cancelledDate: n.cancelledDate,
      done,
      todo,
      inprogress,
      total,
    });
  }
  return out;
}

/**
 * Parse task items for DB sync.
 * - Assign task.milestone as the CURRENT milestone path (L1 / L2 / L3).
 */
export function parseTaskItems(markdown: string): ProjectTaskItem[] {
  const text = String(markdown ?? "");
  const lines = text.split(/\r?\n/);

  const toStatusName = (c: string): ProjectTaskItem["statusName"] => {
    if (c === "x" || c === "X") return "DONE";
    if (c === "-") return "CANCELLED";
    if (c === "/") return "IN_PROGRESS";
    if (c === " ") return "TODO";
    return "UNKNOWN";
  };

  const extractTaskIdFromRSLatte = (s: string): string | undefined => {
    const raw = String(s ?? "");
    const comments = raw.match(/<!--\s*rslatte:[\s\S]*?-->/gi) ?? [];
    for (const c of comments) {
      const m = c.match(/task_id\s*=\s*([^\s;]+)\b/i);
      if (m?.[1]) return String(m[1]).trim();
    }
    return undefined;
  };

  const stripRSLatteComments = (s: string): string => {
    return String(s ?? "").replace(/<!--\s*rslatte:[\s\S]*?-->/gi, "").trim();
  };

  const extractDateToken = (s: string, token: string): string | undefined => {
    const re = new RegExp(`${token}\\s*(\\d{4}-\\d{2}-\\d{2})`);
    const m = String(s ?? "").match(re);
    return m?.[1];
  };

  // maintain heading stack while scanning
  const stack: Array<{ name: string; level: 1 | 2 | 3; path: string }> = [];
  let currentPath = DEFAULT_MILESTONE_PATH;
  let currentLeaf = DEFAULT_MILESTONE_PATH;

  const headingRe = /^(#{1,3})\s+(.+?)\s*$/;

  const out: ProjectTaskItem[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    const hm = line.match(headingRe);
    if (hm) {
      const level = Math.min(3, Math.max(1, hm[1].length)) as 1 | 2 | 3;
      const name = String(hm[2] ?? "").trim();
      if (name) {
        while (stack.length >= level) stack.pop();
        const parentPath = stack.length ? stack[stack.length - 1].path : "";
        const path = (parentPath ? `${parentPath} / ${name}` : name).trim();
        stack.push({ name, level, path });
        currentPath = path;
        currentLeaf = name;
      }
      continue;
    }

    const m = line.match(/^\s*[-*]\s+\[([ xX\/-])\]\s*(.*?)\s*$/);
    if (!m) continue;
    const statusMark = m[1];
    const rest = (m[2] ?? "").trim();

    let taskId = extractTaskIdFromRSLatte(rest);
    if (!taskId) taskId = extractTaskIdFromRSLatte(lines[i + 1] ?? "");

    const firstTokenIdx = (() => {
      const tokens = ["➕", "🛫", "⏳", "📅", "✅", "❌"]; 
      const idx = tokens.map((t) => rest.indexOf(t)).filter((n) => n >= 0);
      return idx.length ? Math.min(...idx) : -1;
    })();
    const titlePart = firstTokenIdx >= 0 ? rest.slice(0, firstTokenIdx) : rest;
    const metaPart = firstTokenIdx >= 0 ? rest.slice(firstTokenIdx) : "";
    const text2 = stripRSLatteComments(titlePart);

    out.push({
      milestone: currentLeaf,
      milestonePath: currentPath,
      lineNo: i,
      statusMark,
      statusName: toStatusName(statusMark),
      text: text2,
      rawLine: line,
      taskId,
      createdDate: extractDateToken(metaPart, "➕"),
      startDate: extractDateToken(metaPart, "🛫"),
      scheduledDate: extractDateToken(metaPart, "⏳"),
      dueDate: extractDateToken(metaPart, "📅"),
      doneDate: extractDateToken(metaPart, "✅"),
      cancelledDate: extractDateToken(metaPart, "❌"),
    });
  }

  return out;
}

/**
 * Backwards-compatible helper: check if a milestone exists.
 * - Prefer exact path match.
 * - Fallback to leaf name match (only if unique).
 */
export function hasMilestoneHeading(markdown: string, nameOrPath: string): boolean {
  const q = String(nameOrPath ?? "").trim();
  if (!q) return false;
  const nodes = parseMilestoneNodes(markdown);
  if (nodes.some((n) => n.path === q)) return true;
  const byLeaf = nodes.filter((n) => n.name === q);
  return byLeaf.length === 1;
}

export function escapeRegExp(s: string): string {
  return String(s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


/**
 * Resolve the effective milestone path for UI grouping.
 * If the raw milestone is cancelled or missing, bubble up to the nearest active/done parent.
 * Falls back to DEFAULT_MILESTONE_PATH.
 */
export function resolveEffectiveMilestonePath(
  rawPath: string | undefined,
  index: Map<string, { status?: "active" | "done" | "cancelled"; parentPath?: string }>
): string {
  let cur = String(rawPath ?? "").trim();
  if (!cur) return DEFAULT_MILESTONE_PATH;

  // Avoid infinite loops
  for (let guard = 0; guard < 10; guard++) {
    const meta = index.get(cur);
    if (!meta) {
      // Missing milestone: bubble by trimming the last segment of the path.
      const parts = cur.split(" / ").map((s) => s.trim()).filter(Boolean);
      if (parts.length <= 1) return DEFAULT_MILESTONE_PATH;
      parts.pop();
      cur = parts.join(" / ");
      continue;
    }

    if (meta.status !== "cancelled") return cur;

    const parent = String(meta.parentPath ?? "").trim();
    if (parent) {
      cur = parent;
      continue;
    }

    // cancelled but no parentPath: bubble by trimming
    const parts = cur.split(" / ").map((s) => s.trim()).filter(Boolean);
    if (parts.length <= 1) return DEFAULT_MILESTONE_PATH;
    parts.pop();
    cur = parts.join(" / ");
  }

  return DEFAULT_MILESTONE_PATH;
}
