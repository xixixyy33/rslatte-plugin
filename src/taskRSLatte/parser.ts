import type { RSLatteItemType, RSLatteParsedLine, RSLatteStatus } from "./types";
import { fnv1a32 } from "../utils/hash";
import { normalizeRepeatRuleToken, reconcileTaskDisplayPhase } from "./utils";

const TASK_LINE_RE = /^\s*-\s*\[(.)\]\s+(.*)$/;

// tokens: 📅 due / memo date, ➕ created, ✅ done, ❌ cancelled, 🛫 start, ⏳ scheduled
// IMPORTANT: Always use the `u` flag when dealing with emoji tokens.
// Without `u`, JS RegExp may treat emoji as surrogate halves, which can accidentally strip only
// half of an emoji (leaving an unpaired surrogate like "\uD83D"). That will break JSON encoding
// and backend validation.
//
// NOTE: Some editors/platforms will insert a variation selector (U+FE0F) after emoji,
// e.g. "📅️" instead of "📅". To be robust, we match an optional \uFE0F and strip it
// before comparing icons.
const DATE_TOKEN_RE = /(📅\uFE0F?|➕\uFE0F?|✅\uFE0F?|❌\uFE0F?|🛫\uFE0F?|⏳\uFE0F?)\s*(\d{4}-\d{2}-\d{2}|\d{2}-\d{2})/gu;
const REPEAT_TOKEN_RE = /\s*🔁\uFE0F?\s*([A-Za-z_]+)\b/gu;

// 描述首字符标记：⭐、延期 **↪**（旧库曾用 ⏳ 作延期前缀，仍参与 strip）、复杂度 🧠|🍃。计划开始日仍用行尾 ⏳ YYYY-MM-DD，勿与延期混淆。
export const TASK_DESC_PREFIX_STRIP_RE = /^(\s*)(⭐\uFE0F?)?(\s*)(↪\uFE0F?|⏳\uFE0F?)?(\s*)(🧠\uFE0F?|🍃\uFE0F?)?\s*/u;
const DESC_PREFIX_RE = TASK_DESC_PREFIX_STRIP_RE;

const RSLATTE_COMMENT_RE = /<!--\s*rslatte:([^>]*)-->/i;

// v2 meta comment line (indented, on the next line)
// Backward compatible: accept legacy "ledger:" prefix from older vaults.
// NOTE: Some historic files may store meta as a multi-line HTML comment block:
//   <!--
//   ledger:uid=...;type=memo;...
//   -->
// So we cannot rely on a single-line regex only.
const RSLATTE_META_LINE_RE = /^\s*<!--\s*(?:rslatte|ledger):([^>]*)-->\s*$/i;

type MetaBlock = { start: number; end: number; raw: string; kv: Record<string, string> };

function extractMetaPayloadFromComment(commentRaw: string): string | null {
  const s = (commentRaw ?? "").replace(/\r/g, "");
  // normalize whitespace so multi-line blocks work
  const norm = s.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  // find the first occurrence of rslatte: / ledger:
  const m = norm.match(/(?:^|\s)(?:rslatte|ledger):(.+)$/i);
  if (!m) return null;
  return String(m[1] ?? "").trim();
}

function tryReadMetaBlock(lines: string[], startIdx: number): MetaBlock | null {
  const line0 = lines[startIdx] ?? "";
  if (!line0.includes("<!--")) return null;

  // 1) single-line comment
  const single = line0.match(/^\s*<!--([\s\S]*?)-->\s*$/);
  if (single) {
    const payload = extractMetaPayloadFromComment(single[1] ?? "");
    if (!payload) return null;
    return { start: startIdx, end: startIdx, raw: String(single[1] ?? ""), kv: parseCommentKV(payload) };
  }

  // 2) multi-line block: accumulate until we see -->
  let raw = line0;
  let end = startIdx;
  const maxLookahead = 8; // safety
  for (let k = 1; k <= maxLookahead && startIdx + k < lines.length; k++) {
    raw += "\n" + (lines[startIdx + k] ?? "");
    end = startIdx + k;
    if ((lines[startIdx + k] ?? "").includes("-->")) break;
  }
  if (!raw.includes("-->")) return null;

  // extract inside <!-- ... -->
  const inside = raw.replace(/^[\s\S]*?<!--/m, "").replace(/-->[\s\S]*$/m, "");
  const payload = extractMetaPayloadFromComment(inside);
  if (!payload) return null;
  return { start: startIdx, end, raw: inside, kv: parseCommentKV(payload) };
}

function collectFollowingMetaBlocks(lines: string[], startIdx: number): MetaBlock[] {
  const blocks: MetaBlock[] = [];
  let j = startIdx;
  // allow a single blank line between list item and meta (some notes had that)
  if ((lines[j] ?? "").trim() === "" && (lines[j + 1] ?? "").includes("<!--")) j += 1;

  while (j < lines.length) {
    const ln = lines[j] ?? "";
    if (!ln.includes("<!--")) break;
    const b = tryReadMetaBlock(lines, j);
    if (!b) break;
    blocks.push(b);
    j = b.end + 1;
    // continue if next is also a comment start (supports duplicated meta blocks)
  }
  return blocks;
}

function buildRSLatteMetaLine(kv: Record<string, string>): string {
  const uid = (kv["uid"] ?? "").trim();
  const type = (kv["type"] ?? kv["rslatte:type"] ?? "").trim();
  const tid = (kv["tid"] ?? kv["task_id"] ?? "").trim();
  const mid = (kv["mid"] ?? kv["memo_id"] ?? "").trim();

  const ordered: string[] = [];
  if (uid) ordered.push(`uid=${uid}`);
  if (type) ordered.push(`type=${type}`);
  if (tid) ordered.push(`tid=${tid}`);
  if (mid) ordered.push(`mid=${mid}`);

  // keep other keys
  for (const k of Object.keys(kv)) {
    if (k === "uid" || k === "type" || k === "rslatte:type" || k === "tid" || k === "task_id" || k === "mid" || k === "memo_id") continue;
    const v = (kv[k] ?? "").trim();
    if (!v) continue;
    ordered.push(`${k}=${v}`);
  }

  // indent as a child line of the list item
  return `  <!-- rslatte:${ordered.join(";")} -->`;
}

function genUid(): string {
  // v2: lg_ + 8~12 short random chars
  const rnd = Math.random().toString(16).slice(2); // hex
  const short = rnd.slice(0, 10); // 10 chars
  return `lg_${short}`;
}

function isValidUid(u?: string): boolean {
  const s = (u ?? "").trim();
  return /^lg_[a-f0-9]{8,12}$/i.test(s);
}

function markToStatus(mark: string): RSLatteStatus {
  const m = (mark ?? " ").trim();
  if (m === "x" || m === "X") return "DONE";
  if (m === "/") return "IN_PROGRESS";
  if (m === "-") return "CANCELLED";
  if (m === "") return "TODO";
  // tasks 插件还可能出现其他 mark（例如 ?），这里统一 UNKNOWN
  return "UNKNOWN";
}

function parseCommentKV(raw: string): Record<string, string> {
  const txt = (raw ?? "").trim();
  if (!txt) return {};

  // 支持两种写法：
  // 1) <!-- rslatte:type=task;tid=123 -->
  // 2) <!-- rslatte:type=task tid=123 -->
  const parts = txt
    .replace(/\s+/g, " ")
    .split(/[;\s]+/g)
    .map((x) => x.trim())
    .filter(Boolean);

  const kv: Record<string, string> = {};
  for (const p of parts) {
    const m = p.match(/^([A-Za-z0-9_\-:]+)=(.+)$/);
    if (!m) continue;
    const k = m[1].trim();
    const v = m[2].trim();
    if (k) kv[k] = v;
  }
  return kv;
}

function stripTokens(text: string): string {
  let t = (text ?? "");
  // remove comment
  t = t.replace(RSLATTE_COMMENT_RE, "");
  // remove date tokens
  t = t.replace(DATE_TOKEN_RE, "");
  // remove repeat token
  t = t.replace(REPEAT_TOKEN_RE, "");
  // cleanup spaces
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

/** 去掉描述首字符标记 ⭐↪🧠🍃（↪ 为延期；兼容旧 ⏳ 延期前缀），返回纯描述部分（不包含日期 token） */
function stripDescPrefix(body: string): string {
  return (body ?? "").replace(DESC_PREFIX_RE, "").trimStart();
}

/**
 * 根据任务属性构建描述首字符标记（顺序：⭐ ↪ 🧠|🍃），写入任务行时使用；延期用 ↪，避免与计划开始 ⏳ 冲突
 */
export function buildDescPrefix(opts: {
  starred?: boolean;
  postpone_count?: number;
  complexity?: string;
}): string {
  const parts: string[] = [];
  if (opts.starred) parts.push("⭐");
  if (opts.postpone_count != null && opts.postpone_count > 0) parts.push("↪");
  if (opts.complexity === "high") parts.push("🧠");
  else if (opts.complexity === "light") parts.push("🍃");
  return parts.length ? parts.join("") + " " : "";
}

function normalizeItemType(s?: string): RSLatteItemType | null {
  const v = (s ?? "").trim().toLowerCase();
  if (v === "task") return "task";
  if (v === "memo") return "memo";
  // 日程在存储上复用 memo 索引，但 meta.type 使用 schedule 以便语义区分。
  if (v === "schedule") return "memo";
  return null;
}

export function parseRSLatteLine(filePath: string, lineNo: number, rawLine: string): RSLatteParsedLine | null {
  const m = (rawLine ?? "").match(TASK_LINE_RE);
  if (!m) return null;

  const mark = m[1] ?? " ";
  const body = m[2] ?? "";

  const commentMatch = body.match(RSLATTE_COMMENT_RE);
  const commentRaw = commentMatch?.[1]?.trim() ?? "";
  const kv = parseCommentKV(commentRaw);

  // 支持 key: type=task 或 rslatte:type=task
  const typeFromKV = kv["type"] ?? kv["rslatte:type"];
  const itemType: RSLatteItemType = normalizeItemType(typeFromKV) ?? "task";

  let tid: number | undefined;
  let mid: number | undefined;
  const tidStr = kv["tid"] ?? kv["task_id"];
  const midStr = kv["mid"] ?? kv["memo_id"];
  if (tidStr && /^\d+$/.test(tidStr)) tid = Number(tidStr);
  if (midStr && /^\d+$/.test(midStr)) mid = Number(midStr);

  const uidStr = kv["uid"];

  const bodyWithoutPrefix = stripDescPrefix(body);
  const parsed: RSLatteParsedLine = {
    itemType,
    uid: isValidUid(uidStr) ? String(uidStr) : undefined,
    filePath,
    lineNo,
    raw: rawLine,
    text: stripTokens(bodyWithoutPrefix),
    status: markToStatus(mark),
    sourceHash: "",
    rslatteComment: commentRaw || undefined,
    extra: {},
  };

  // parse dates
  let dm: RegExpExecArray | null;
  const bodyWithoutComment = body.replace(RSLATTE_COMMENT_RE, "");
  while ((dm = DATE_TOKEN_RE.exec(bodyWithoutComment)) !== null) {
    const icon = String(dm[1] ?? "").replace(/\uFE0F/g, "");
    const val = dm[2];

    if (icon === "➕" && /^\d{4}-\d{2}-\d{2}$/.test(val)) parsed.created_date = val;
    if (icon === "✅" && /^\d{4}-\d{2}-\d{2}$/.test(val)) parsed.done_date = val;
    if (icon === "❌" && /^\d{4}-\d{2}-\d{2}$/.test(val)) parsed.cancelled_date = val;
    if (icon === "🛫" && /^\d{4}-\d{2}-\d{2}$/.test(val)) parsed.actual_start = val;
    if (icon === "⏳" && /^\d{4}-\d{2}-\d{2}$/.test(val)) parsed.planned_start = val;

    if (icon === "📅") {
      if (itemType === "memo") {
        if (/^\d{4}-\d{2}-\d{2}$/.test(val)) parsed.memoDate = val;
        else if (/^\d{2}-\d{2}$/.test(val)) parsed.memoMmdd = val;
      } else {
        if (/^\d{4}-\d{2}-\d{2}$/.test(val)) parsed.planned_end = val;
      }
    }
  }

  // repeat
  let rm: RegExpExecArray | null;
  while ((rm = REPEAT_TOKEN_RE.exec(bodyWithoutComment)) !== null) {
    parsed.repeatRule = (rm[1] ?? "").trim();
  }
  if (parsed.repeatRule) {
    parsed.repeatRule = normalizeRepeatRuleToken(String(parsed.repeatRule).trim().toLowerCase());
  }

  // ✅ 解析额外的元数据（如 contact_file, contact_uid）存储到 extra 字段
  const contactFile = kv["contact_file"];
  const contactUid = kv["contact_uid"];
  if (contactFile || contactUid) {
    parsed.extra = parsed.extra || {};
    if (contactFile) parsed.extra.contact_file = String(contactFile).trim();
    if (contactUid) parsed.extra.contact_uid = String(contactUid).trim();
  }

  if (Object.keys(parsed.extra || {}).length === 0) delete parsed.extra;

  // build hash (stable-ish)
  // Exclude rslatte HTML comment from hash so write-back tid/mid doesn't trigger a false update.
  const normRaw = rawLine.replace(RSLATTE_COMMENT_RE, "").trimEnd();
  parsed.sourceHash = fnv1a32(`${itemType}|${filePath}|${lineNo}|${normRaw}`);

  if (tid != null) parsed.tid = tid;
  if (mid != null) parsed.mid = mid;

  return parsed;
}

/**
 * v2: Parse an entire markdown file.
 * - Supports "task line + next-line meta comment".
 * - When opts.fixUidAndMeta=true, ensures every parsed item has a uid and a meta line.
 *   (It migrates legacy inline rslatte comments into the next-line meta comment when fixUidAndMeta=true.)
 */
export function parseRSLatteFile(
  filePath: string,
  content: string,
  opts?: { fixUidAndMeta?: boolean }
): { tasks: RSLatteParsedLine[]; memos: RSLatteParsedLine[]; updatedContent?: string } {
  const fix = opts?.fixUidAndMeta === true;
  const lines = (content ?? "").split(/\r?\n/);
  let changed = false;

  const tasks: RSLatteParsedLine[] = [];
  const memos: RSLatteParsedLine[] = [];

  // Track uid uniqueness within this file
  const used = new Set<string>();

  const ensureUniqueUid = (u: string): string => {
    let uid = u;
    while (!isValidUid(uid) || used.has(uid)) {
      uid = genUid();
    }
    used.add(uid);
    return uid;
  };

  /**
   * When v2 meta lines override itemType (task <-> memo), some fields parsed from the list line
   * become inconsistent (e.g. 📅 parsed into planned_end when itemType was still "task").
   * Reconcile type-dependent fields after itemType is finalized.
   */
  const reconcileTypeDependentFields = (p: RSLatteParsedLine) => {
    const rr = String(p.repeatRule ?? "").trim().toLowerCase();

    if (p.itemType === "memo") {
      // If the list line was initially treated as a task, 📅 would have been parsed into planned_end.
      if (!p.memoDate && p.planned_end && /^\d{4}-\d{2}-\d{2}$/.test(p.planned_end)) {
        p.memoDate = p.planned_end;
        delete (p as any).planned_end;
      }

      // For yearly repeating memos, backend expects memo_mmdd (MM-DD). Derive it from memoDate.
      if (rr === "yearly") {
        if (!p.memoMmdd && p.memoDate && /^\d{4}-\d{2}-\d{2}$/.test(p.memoDate)) {
          p.memoMmdd = p.memoDate.slice(5); // "MM-DD"
        }
      }
    } else {
      // If meta line overrides back to task, ensure 📅 sits in planned_end.
      if (!p.planned_end && p.memoDate && /^\d{4}-\d{2}-\d{2}$/.test(p.memoDate)) {
        p.planned_end = p.memoDate;
      }
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const parsed = parseRSLatteLine(filePath, i, raw);
    if (!parsed) continue;

		// merge meta blocks if present (supports multi-line legacy "ledger:" blocks)
		const metaBlocks = collectFollowingMetaBlocks(lines, i + 1);
		if (metaBlocks.length > 0) {
			// If duplicated/conflicting blocks exist, prefer memo over task.
			const pick =
				metaBlocks.find((b) => normalizeItemType(b.kv["type"] ?? b.kv["rslatte:type"]) === "memo") ?? metaBlocks[0];
			const kv = pick.kv;

			const t2 = normalizeItemType(kv["type"] ?? kv["rslatte:type"]);
			if (t2) parsed.itemType = t2;

			const uid2 = kv["uid"];
			if (isValidUid(uid2)) {
				parsed.uid = String(uid2);
				parsed.metaLineNo = pick.start;
			}

			const tidStr = kv["tid"] ?? kv["task_id"];
			const midStr = kv["mid"] ?? kv["memo_id"];
			if (tidStr && /^\d+$/.test(tidStr)) parsed.tid = Number(tidStr);
			if (midStr && /^\d+$/.test(midStr)) parsed.mid = Number(midStr);

			// keep other meta kv into parsed.extra for later indexing/UI usage
			const core = new Set(["uid", "type", "rslatte:type", "tid", "task_id", "mid", "memo_id"]);
			parsed.extra = parsed.extra ?? {};
			for (const [k, v] of Object.entries(kv)) {
				const kk = String(k ?? "").trim();
				if (!kk || core.has(kk)) continue;
				const vv = String(v ?? "").trim();
				if (!vv) continue;
				parsed.extra[kk] = vv;
			}
			// meta type=schedule 在 core 中不落 extra，但 schedule-index 分桶依赖 extra.type
			if (parsed.itemType === "memo") {
				const rawT = String(kv["type"] ?? kv["rslatte:type"] ?? "").trim().toLowerCase();
				if (rawT === "schedule") {
					parsed.extra.type = "schedule";
				}
			}
			// 通用扩展字段：任务/提醒都支持星标
			const star = kv["starred"];
			if (star === "1" || star === "true") parsed.starred = true;
			else if (star === "0" || star === "false") parsed.starred = false;

			// 任务扩展字段：从下一行 meta 写入顶层（第六节 snake_case）
			if (parsed.itemType === "task") {
				const phase = kv["task_phase"];
				if (phase) parsed.task_phase = phase;
				const note = kv["progress_note"];
				if (note != null) parsed.progress_note = String(note).replace(/\u200B/g, " ");
				const updated = kv["progress_updated"];
				if (updated) parsed.progress_updated = updated;
				const wait = kv["wait_until"];
				if (wait) parsed.wait_until = wait;
				const followUp = kv["follow_up"];
				if (followUp && /^\d{4}-\d{2}-\d{2}$/.test(String(followUp))) parsed.follow_up = followUp;
				const pc = kv["postpone_count"];
				if (pc != null && /^\d+$/.test(String(pc))) parsed.postpone_count = Number(pc);
				const origDue = kv["original_due"];
				if (origDue) parsed.original_due = origDue;
				const est = kv["estimate_h"];
				if (est != null && /^[\d.]+$/.test(String(est))) parsed.estimate_h = Number(est);
				const comp = kv["complexity"];
				if (comp === "high" || comp === "normal" || comp === "light") parsed.complexity = comp;
				const followUids = kv["follow_contact_uids"];
				if (followUids && typeof followUids === "string") {
					const arr = String(followUids).split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
					if (arr.length) parsed.follow_contact_uids = arr;
				}
				const followNames = kv["follow_contact_name"];
				if (followNames && typeof followNames === "string") {
					const arr = String(followNames).split("|").map((s) => s.trim()).filter(Boolean);
					if (arr.length) parsed.follow_contact_names = arr;
				}
				const imp = kv["importance_score"] ?? kv["importance"];
				if (imp != null && /^\d+$/.test(String(imp))) parsed.importance_score = Number(imp);
			}
		}

    // After meta line merge, itemType may have changed (task <-> memo). Fix related fields.
    reconcileTypeDependentFields(parsed);
    if (parsed.itemType === "task") {
      parsed.task_phase = reconcileTaskDisplayPhase(parsed.status, parsed.task_phase, {
        wait_until: parsed.wait_until,
        follow_up: parsed.follow_up,
      });
    }

    // legacy inline comment kv (on task line)
    const inlineCommentMatch = raw.match(RSLATTE_COMMENT_RE);
    const inlineCommentRaw = inlineCommentMatch?.[1]?.trim() ?? "";
    const inlineKv = parseCommentKV(inlineCommentRaw);
    const hasInline = !!inlineCommentRaw;
    const iInsertedTaskLineIdx = i;

    if (fix) {
      // Ensure uid exists & is unique
      let uid = (parsed.uid && isValidUid(parsed.uid)) ? String(parsed.uid) : "";
      if (!isValidUid(uid)) {
        uid = genUid();
      }
      uid = ensureUniqueUid(uid);
      if (uid !== parsed.uid) {
        parsed.uid = uid;
        changed = true;
      }
      parsed.uidMissing = false;

			// Ensure meta line exists (and normalize legacy multi-line blocks), then merge legacy inline kv into it
			const metaIdx = i + 1;
			let metaKv: Record<string, string> = {};
			const blocks = collectFollowingMetaBlocks(lines, metaIdx);
			if (blocks.length > 0) {
				// prefer memo block if any (also removes previously-inserted wrong task meta)
				const pick =
					blocks.find((b) => normalizeItemType(b.kv["type"] ?? b.kv["rslatte:type"]) === "memo") ?? blocks[0];
				metaKv = { ...pick.kv };

				// normalize: remove optional blank line + ALL consecutive meta blocks, insert a single rslatte meta line
				const delStart = metaIdx; // always normalize to be directly after the list item
				const delEnd = blocks[blocks.length - 1].end;
				lines.splice(delStart, delEnd - delStart + 1, buildRSLatteMetaLine(metaKv));
				parsed.metaLineNo = delStart;
				changed = true;
				// Since we ensured a meta line at metaIdx, advance i to skip it
				i += 1;
			} else {
				// insert meta line right after
				metaKv = { uid, type: parsed.itemType };
				lines.splice(metaIdx, 0, buildRSLatteMetaLine(metaKv));
				parsed.metaLineNo = metaIdx;
				changed = true;
				// Since we inserted a line, advance i to skip the meta line we just inserted
				i += 1;
			}

      // Fill meta kv
      metaKv["uid"] = uid;
      const keepScheduleType = parsed.itemType === "memo"
        && (
          String(metaKv["type"] ?? "").trim().toLowerCase() === "schedule"
          || String((parsed.extra ?? {})["cat"] ?? "").trim() === "schedule"
          || String((parsed.extra ?? {})["type"] ?? "").trim().toLowerCase() === "schedule"
        );
      metaKv["type"] = keepScheduleType ? "schedule" : parsed.itemType;
      if (parsed.itemType === "memo" && String(metaKv["type"] ?? "").trim().toLowerCase() === "schedule") {
        parsed.extra = parsed.extra ?? {};
        parsed.extra.type = "schedule";
        delete metaKv["cat"];
      }
      // merge legacy inline kv: only fill missing keys
      for (const k of Object.keys(inlineKv)) {
        const v = (inlineKv[k] ?? "").trim();
        if (!v) continue;
        if (!metaKv[k] || !(metaKv[k] ?? "").trim()) {
          metaKv[k] = v;
        }
      }

      // write meta line
      lines[parsed.metaLineNo] = buildRSLatteMetaLine(metaKv);

      // strip legacy inline comment from task line (keep tokens)
      if (hasInline) {
        const cleaned = raw
          .replace(RSLATTE_COMMENT_RE, "")
          .replace(/\s{2,}/g, " ")
          .replace(/\s+$/g, "");
        if (cleaned !== raw) {
          lines[iInsertedTaskLineIdx] = cleaned;
          parsed.raw = cleaned;
          changed = true;
        }
      }
    } else {
      // auto refresh: just mark missing
      if (!parsed.uid || !isValidUid(parsed.uid)) parsed.uidMissing = true;
      if (parsed.uid && isValidUid(parsed.uid)) {
        if (!used.has(parsed.uid)) used.add(parsed.uid);
      }
    }

    if (parsed.itemType === "memo") memos.push(parsed);
    else tasks.push(parsed);
  }

  const updatedContent = changed ? lines.join("\n") : undefined;
  return { tasks, memos, updatedContent };
}
