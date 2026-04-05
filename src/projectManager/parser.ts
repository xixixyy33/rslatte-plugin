import type { MilestoneProgress, ProjectTaskItem } from "./types";
import { reconcileTaskDisplayPhase } from "../taskRSLatte/utils";
import { TASK_DESC_PREFIX_STRIP_RE } from "../taskRSLatte/parser";

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
  /** 创建/激活日 YYYY-MM-DD；优先 meta `milestone_created_date`，否则由 ts= 推断 */
  created_date?: string;
  /** 实际完成日 YYYY-MM-DD；优先 `milestone_done_date`，否则由 ts= 推断 */
  done_date?: string;
  /** 实际取消日 YYYY-MM-DD；优先 `milestone_cancelled_date`，否则由 ts= 推断 */
  cancelled_date?: string;
  /** 计划完成日，meta milestone_planned_end */
  planned_end?: string;
  /** 首次延期前计划完成日，meta milestone_original_planned_end */
  original_planned_end?: string;
  /** 里程碑延期次数，meta milestone_postpone_count */
  postpone_count?: number;
  /** 里程碑权重 1–100，meta milestone_weight */
  milestone_weight?: number;
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
    created_date?: string;
    done_date?: string;
    cancelled_date?: string;
    planned_end?: string;
    original_planned_end?: string;
    postpone_count?: number;
    milestone_weight?: number;
  } => {
    // 6-细8：同一里程碑下选最后一条带 milestone_status 的行，在该行上解析所有键；解析兼容乱序
    let lastStatus: "active" | "done" | "cancelled" | undefined = undefined;
    let created_date: string | undefined = undefined;
    let done_date: string | undefined = undefined;
    let cancelled_date: string | undefined = undefined;
    let firstTsDate: string | undefined = undefined;
    let planned_end: string | undefined = undefined;
    let original_planned_end: string | undefined = undefined;
    let postpone_count: number | undefined = undefined;
    let milestone_weight: number | undefined = undefined;
    let lastLineWithStatus: { status: "active" | "done" | "cancelled"; kv: Record<string, string> } | null = null;

    const parseKv = (body: string): Record<string, string> => {
      const kv: Record<string, string> = {};
      body.split(/[;\s]+/).forEach((p) => {
        const eq = p.indexOf("=");
        if (eq > 0) kv[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
      });
      return kv;
    };

    for (let j = Math.max(0, from); j < Math.min(lines.length, to); j++) {
      const s = String(lines[j] ?? "").trim();
      if (!s) continue;
      const mm = s.match(/<!--\s*rslatte:([\s\S]*?)-->/i);
      if (!mm) continue;
      const body = String(mm[1] ?? "");
      const kv = parseKv(body);

      const sm = body.match(/milestone_status\s*=\s*([^;\s]+)\b/i);
      let currentStatus: "active" | "done" | "cancelled" | undefined = undefined;
      if (sm?.[1]) {
        const v = String(sm[1]).trim().toLowerCase();
        if (v === "done") { currentStatus = "done"; lastStatus = "done"; }
        else if (v === "cancelled" || v === "canceled") { currentStatus = "cancelled"; lastStatus = "cancelled"; }
        else if (v === "active" || v === "todo" || v === "open") { currentStatus = "active"; lastStatus = "active"; }
        if (currentStatus) lastLineWithStatus = { status: currentStatus, kv };
      }

      const tsMatch = body.match(/ts\s*=\s*([^;\s]+)\b/i);
      if (tsMatch?.[1]) {
        const dateMatch = String(tsMatch[1]).trim().match(/^(\d{4}-\d{2}-\d{2})/);
        if (dateMatch?.[1]) {
          const dateStr = dateMatch[1];
          if (!firstTsDate) { firstTsDate = dateStr; created_date = dateStr; }
          if (currentStatus === "done") done_date = dateStr;
          else if (currentStatus === "cancelled") cancelled_date = dateStr;
        }
      }
    }

    if (!created_date && firstTsDate) created_date = firstTsDate;

    if (lastLineWithStatus) {
      const k = lastLineWithStatus.kv;
      if (k["milestone_planned_end"] && /^\d{4}-\d{2}-\d{2}$/.test(k["milestone_planned_end"])) planned_end = k["milestone_planned_end"];
      if (k["milestone_original_planned_end"] && /^\d{4}-\d{2}-\d{2}$/.test(k["milestone_original_planned_end"])) original_planned_end = k["milestone_original_planned_end"];
      if (k["milestone_postpone_count"] && /^\d+$/.test(k["milestone_postpone_count"])) postpone_count = Number(k["milestone_postpone_count"]);
      if (k["milestone_weight"] && /^\d+$/.test(k["milestone_weight"])) {
        const w = Number(k["milestone_weight"]);
        if (Number.isFinite(w)) milestone_weight = Math.min(100, Math.max(1, Math.floor(w)));
      }
      // 显式日期键优先于上文从 ts= 推断的 created/done/cancelled（与 service 写入 milestone_*_date 一致）
      if (k["milestone_created_date"] && /^\d{4}-\d{2}-\d{2}$/.test(k["milestone_created_date"])) created_date = k["milestone_created_date"];
      if (k["milestone_done_date"] && /^\d{4}-\d{2}-\d{2}$/.test(k["milestone_done_date"])) done_date = k["milestone_done_date"];
      if (k["milestone_cancelled_date"] && /^\d{4}-\d{2}-\d{2}$/.test(k["milestone_cancelled_date"])) cancelled_date = k["milestone_cancelled_date"];
    }

    return {
      status: lastStatus,
      created_date,
      done_date,
      cancelled_date,
      planned_end,
      original_planned_end,
      postpone_count,
      milestone_weight,
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
    const isL1 = h.level === 1;
    // 二、三级里程碑不维护计划完成日与延期次数字段（索引与衍生仅认一级）
    out.push({
      name: h.name,
      path: h.path,
      level: h.level,
      parentPath: h.parentPath,
      headingLineNo: h.line,
      blockEndLineNo,
      insertBeforeLineNo,
      milestoneStatus: statusAndDates.status,
      created_date: statusAndDates.created_date,
      done_date: statusAndDates.done_date,
      cancelled_date: statusAndDates.cancelled_date,
      planned_end: isL1 ? statusAndDates.planned_end : undefined,
      original_planned_end: isL1 ? statusAndDates.original_planned_end : undefined,
      postpone_count: isL1 ? statusAndDates.postpone_count : undefined,
      milestone_weight: statusAndDates.milestone_weight,
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
      created_date: n.created_date,
      done_date: n.done_date,
      cancelled_date: n.cancelled_date,
      planned_end: n.planned_end,
      original_planned_end: n.original_planned_end,
      postpone_count: n.postpone_count,
      milestone_weight: n.milestone_weight,
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

  /** 📅 优先；否则识别行内 🗓️ 日期为计划完成日（与 `computeTaskTags`·今日应处理一致） */
  const extractPlannedEndYmd = (meta: string): string | undefined => {
    const fromDue = extractDateToken(meta, "📅");
    if (fromDue) return fromDue;
    const m = String(meta).match(/\u{1F5D3}\uFE0F?\s*(\d{4}-\d{2}-\d{2})/u);
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
    const nextLine = lines[i + 1] ?? "";
    if (!taskId) taskId = extractTaskIdFromRSLatte(nextLine);

    /**
     * 与 ProjectManagerService.patchProjectTaskMetaInLines 一致：同条注释内用分号拼接键值，
     * 仅按 `;` 分割（不按空格），否则 progress_note 等含空格的字段会被拆碎导致解析失败。
     * 任务行与下一行均可能有 `<!-- rslatte:... -->`（例如 task_id 在行尾、完整 meta 在下一行），需合并。
     */
    const parseRslatteMetaFromText = (s: string): {
      estimate_h?: number;
      complexity?: "high" | "normal" | "light";
      task_phase?: "todo" | "in_progress" | "waiting_others" | "waiting_until" | "done" | "cancelled";
      progress_note?: string;
      progress_updated?: string;
      wait_until?: string;
      follow_up?: string;
      follow_contact_uids?: string[];
      follow_contact_names?: string[];
      postpone_count?: number;
      original_due?: string;
      starred?: boolean;
      linked_schedule_uids?: string[];
    } => {
      const raw = String(s ?? "");
      const comments = raw.match(/<!--\s*rslatte:[\s\S]*?-->/gi) ?? [];
      const kv: Record<string, string> = {};
      for (const c of comments) {
        const mm = c.match(/<!--\s*rslatte:([^>]*)-->/i);
        const body = (mm?.[1] ?? "").trim();
        const parts = body.split(";").map((p) => p.trim()).filter(Boolean);
        for (const part of parts) {
          const eq = part.indexOf("=");
          if (eq <= 0) continue;
          const k = part.slice(0, eq).trim();
          const v = part.slice(eq + 1).trim();
          if (k) kv[k] = v;
        }
      }
      let estimate_h: number | undefined;
      let complexity: "high" | "normal" | "light" | undefined;
      let task_phase: "todo" | "in_progress" | "waiting_others" | "waiting_until" | "done" | "cancelled" | undefined;
      let progress_note: string | undefined;
      let progress_updated: string | undefined;
      let wait_until: string | undefined;
      let follow_up: string | undefined;
      let follow_contact_uids: string[] | undefined;
      let follow_contact_names: string[] | undefined;
      let postpone_count: number | undefined;
      let original_due: string | undefined;
      let starred: boolean | undefined;
      let linked_schedule_uids: string[] | undefined;
      for (const [k, v] of Object.entries(kv)) {
        if (k === "estimate_h" && /^[\d.]+$/.test(v)) estimate_h = Number(v);
        if (k === "complexity" && (v === "high" || v === "normal" || v === "light")) complexity = v;
        if (
          k === "task_phase" &&
          (v === "todo" ||
            v === "in_progress" ||
            v === "waiting_others" ||
            v === "waiting_until" ||
            v === "done" ||
            v === "cancelled")
        )
          task_phase = v;
        if (k === "progress_note") progress_note = String(v).replace(/\u200B/g, " ");
        if (k === "progress_updated") progress_updated = v;
        if (k === "wait_until" && /^\d{4}-\d{2}-\d{2}$/.test(v)) wait_until = v;
        if (k === "follow_up" && /^\d{4}-\d{2}-\d{2}$/.test(v)) follow_up = v;
        if (k === "follow_contact_uids" && v) follow_contact_uids = v.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
        if (k === "follow_contact_name" && v)
          follow_contact_names = String(v)
            .split("|")
            .map((x) => x.trim())
            .filter(Boolean);
        if (k === "postpone_count" && /^\d+$/.test(v)) postpone_count = Number(v);
        if (k === "original_due" && /^\d{4}-\d{2}-\d{2}$/.test(v)) original_due = v;
        if (k === "starred") starred = v === "1" || v === "true";
        if (k === "linked_schedule_uids" && v) linked_schedule_uids = v.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
      }
      return {
        estimate_h,
        complexity,
        task_phase,
        progress_note,
        progress_updated,
        wait_until,
        follow_up,
        follow_contact_uids,
        follow_contact_names,
        postpone_count,
        original_due,
        starred,
        linked_schedule_uids,
      };
    };
    const metaFromRest = parseRslatteMetaFromText(rest);
    const metaFromNext = parseRslatteMetaFromText(nextLine);
    const nextMeta: ReturnType<typeof parseRslatteMetaFromText> = { ...metaFromRest, ...metaFromNext };

    // 必须与 taskRSLatte / service 一致：用「前置空格 + 图标 + 空格」定位**日期/元数据** token。
    // 不可对 rest 做裸 indexOf("⏳")：行尾计划开始为「⏳ 日期」；延期前缀现为 ↪（旧笔记可能仍为 ⏳）。
    // 🗓️（U+1F5D3）：部分笔记用日历 emoji 代替 📅 作为截止日，需参与切分与 planned_end 解析。
    const TASK_BODY_META_SPLIT_RE = /\s(📅|\u{1F5D3}\uFE0F?|➕|⏳|🛫|✅|❌)\s/u;
    const metaSplit = rest.match(TASK_BODY_META_SPLIT_RE);
    let titlePart: string;
    let metaPart: string;
    if (metaSplit && typeof metaSplit.index === "number") {
      titlePart = rest.slice(0, metaSplit.index).trimEnd();
      metaPart = rest.slice(metaSplit.index).trimStart();
    } else {
      titlePart = rest;
      metaPart = "";
    }
    const titleClean = stripRSLatteComments(titlePart);
    const text2 = titleClean.replace(TASK_DESC_PREFIX_STRIP_RE, "").trim();

    const statusName = toStatusName(statusMark);
    const item: ProjectTaskItem = {
      /** 与里程碑 `path` 一致的全路径（L1 / L2 / L3），供索引与 DB 同步唯一标识 */
      milestone: currentPath,
      milestonePath: currentPath,
      lineNo: i,
      statusMark,
      statusName,
      text: text2,
      rawLine: line,
      taskId,
      created_date: extractDateToken(metaPart, "➕"),
      actual_start: extractDateToken(metaPart, "🛫"),
      planned_start: extractDateToken(metaPart, "⏳"),
      planned_end: extractPlannedEndYmd(metaPart),
      done_date: extractDateToken(metaPart, "✅"),
      cancelled_date: extractDateToken(metaPart, "❌"),
      ...(nextMeta.estimate_h != null && { estimate_h: nextMeta.estimate_h }),
      ...(nextMeta.complexity && { complexity: nextMeta.complexity }),
      ...(nextMeta.task_phase && { task_phase: nextMeta.task_phase }),
      ...(nextMeta.progress_note != null && { progress_note: nextMeta.progress_note }),
      ...(nextMeta.progress_updated && { progress_updated: nextMeta.progress_updated }),
      ...(nextMeta.wait_until && { wait_until: nextMeta.wait_until }),
      ...(nextMeta.follow_up && { follow_up: nextMeta.follow_up }),
      ...(nextMeta.follow_contact_uids && nextMeta.follow_contact_uids.length > 0 && { follow_contact_uids: nextMeta.follow_contact_uids }),
      ...(nextMeta.follow_contact_names && nextMeta.follow_contact_names.length > 0 && { follow_contact_names: nextMeta.follow_contact_names }),
      ...(nextMeta.postpone_count != null && { postpone_count: nextMeta.postpone_count }),
      ...(nextMeta.original_due && { original_due: nextMeta.original_due }),
      ...(nextMeta.starred !== undefined && { starred: nextMeta.starred }),
      ...(nextMeta.linked_schedule_uids && nextMeta.linked_schedule_uids.length > 0 && { linked_schedule_uids: nextMeta.linked_schedule_uids }),
    };
    item.task_phase = reconcileTaskDisplayPhase(item.statusName, item.task_phase, {
      wait_until: item.wait_until,
      follow_up: item.follow_up,
    }) as ProjectTaskItem["task_phase"];
    out.push(item);
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
