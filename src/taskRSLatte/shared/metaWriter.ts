import type { App, TFile } from "obsidian";

// v2 meta comment line (indented, on the next line)
// Backward compatible: accept legacy "ledger:" prefix from older vaults.
const RSLATTE_META_LINE_RE = /^\s*<!--\s*(?:rslatte|ledger):([^>]*)-->\s*$/i;

function parseCommentKV(raw: string): Record<string, string> {
  const txt = (raw ?? "").trim();
  if (!txt) return {};

  // supports:
  // 1) "uid=...;type=task;tid=123"
  // 2) "uid=... type=task tid=123"
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

  // keep other keys (stable-ish)
  for (const k of Object.keys(kv)) {
    if (
      k === "uid" ||
      k === "type" ||
      k === "rslatte:type" ||
      k === "tid" ||
      k === "task_id" ||
      k === "mid" ||
      k === "memo_id"
    ) {
      continue;
    }
    const v = (kv[k] ?? "").trim();
    if (!v) continue;
    ordered.push(`${k}=${v}`);
  }

  // indent as a child line of the list item
  return `  <!-- rslatte:${ordered.join(";")} -->`;
}

function isRSLatteMetaLine(line: string): boolean {
  return !!(line ?? "").match(RSLATTE_META_LINE_RE);
}

/** 解析 meta 后比对 `uid=` 主键，避免 `followup_schedule_uid=同值` 误匹配子串 `uid=` */
export function metaLineHasUid(line: string, uid: string): boolean {
  const m = (line ?? "").match(RSLATTE_META_LINE_RE);
  if (!m) return false;
  const kv = parseCommentKV((m[1] ?? "").trim());
  return String(kv["uid"] ?? "").trim() === uid;
}

function patchMetaLine(line: string, patch: Record<string, string>): { line: string; changed: boolean } {
  const m = (line ?? "").match(RSLATTE_META_LINE_RE);
  if (!m) return { line, changed: false };
  const kv = parseCommentKV((m[1] ?? "").trim());
  let changed = false;
  for (const [k, v] of Object.entries(patch)) {
    const nv = String(v ?? "").trim();
    if (!nv) continue;
    if (String(kv[k] ?? "").trim() !== nv) {
      kv[k] = nv;
      changed = true;
    }
  }
  if (!changed) return { line, changed: false };
  return { line: buildRSLatteMetaLine(kv), changed: true };
}

/** 仅当行匹配 uid 时对 meta 行打补丁，用于批量写回 importance 等 */
export function patchMetaLineIfUid(
  line: string,
  uid: string,
  patch: Record<string, string>
): { line: string; changed: boolean } | null {
  if (!metaLineHasUid(line, uid)) return null;
  return patchMetaLine(line, patch);
}

/**
 * Update tid/mid in the v2 meta comment line by uid.
 * - Prefer the hint lineNo (task lineNo + 1) for performance.
 * - Fallback to full scan if not found.
 */
export async function writeBackMetaIdByUid(
  app: App,
  filePath: string,
  uid: string,
  patch: Record<string, string>,
  hintTaskLineNo?: number
): Promise<{ ok: boolean; changed: boolean; reason?: string }>{
  if (!uid || !filePath) return { ok: false, changed: false, reason: "missing uid or filePath" };

  const af = app.vault.getAbstractFileByPath(filePath);
  if (!af) return { ok: false, changed: false, reason: "file not found" };
  const file = af as TFile;

  const content = await app.vault.read(file);
  const lines = (content ?? "").split(/\r?\n/);
  let changed = false;

  const tryIdxs: number[] = [];
  if (typeof hintTaskLineNo === "number" && hintTaskLineNo >= 0) {
    // meta line is usually right after task line
    tryIdxs.push(hintTaskLineNo + 1);
    // a bit wider window for safety
    tryIdxs.push(hintTaskLineNo + 2);
    tryIdxs.push(hintTaskLineNo);
  }

  const visited = new Set<number>();
  const tryPatchAt = (idx: number): boolean => {
    if (idx < 0 || idx >= lines.length) return false;
    if (visited.has(idx)) return false;
    visited.add(idx);
    const line = lines[idx];
    if (!isRSLatteMetaLine(line)) return false;
    if (!metaLineHasUid(line, uid)) return false;
    const r = patchMetaLine(line, patch);
    if (r.changed) {
      lines[idx] = r.line;
      changed = true;
    }
    return true;
  };

  for (const idx of tryIdxs) {
    if (tryPatchAt(idx)) break;
  }

  if (!changed) {
    // If hint didn't find anything, scan full file
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!isRSLatteMetaLine(line)) continue;
      if (!metaLineHasUid(line, uid)) continue;
      const r = patchMetaLine(line, patch);
      if (r.changed) {
        lines[i] = r.line;
        changed = true;
      }
      break;
    }
  }

  if (!changed) return { ok: true, changed: false };
  await app.vault.modify(file, lines.join("\n"));
  return { ok: true, changed: true };
}

function removeKeysFromMetaLine(line: string, uid: string, keys: string[]): { line: string; changed: boolean } {
  if (!metaLineHasUid(line, uid)) return { line, changed: false };
  const m = (line ?? "").match(RSLATTE_META_LINE_RE);
  if (!m) return { line, changed: false };
  const kv = parseCommentKV((m[1] ?? "").trim());
  let changed = false;
  for (const k of keys) {
    const kk = String(k ?? "").trim();
    if (!kk) continue;
    if (Object.prototype.hasOwnProperty.call(kv, kk)) {
      delete (kv as any)[kk];
      changed = true;
    }
  }
  if (!changed) return { line, changed: false };
  return { line: buildRSLatteMetaLine(kv), changed: true };
}

/**
 * 从匹配 uid 的 meta 行中删除指定键（如清空 `task_category`）。
 */
export async function writeBackMetaIdByUidRemoveKeys(
  app: App,
  filePath: string,
  uid: string,
  keys: string[],
  hintTaskLineNo?: number
): Promise<{ ok: boolean; changed: boolean; reason?: string }> {
  const ks = (keys ?? []).map((k) => String(k ?? "").trim()).filter(Boolean);
  if (!uid || !filePath || ks.length === 0) return { ok: false, changed: false, reason: "missing uid, filePath or keys" };

  const af = app.vault.getAbstractFileByPath(filePath);
  if (!af) return { ok: false, changed: false, reason: "file not found" };
  const file = af as TFile;

  const content = await app.vault.read(file);
  const lines = (content ?? "").split(/\r?\n/);
  let changed = false;

  const tryIdxs: number[] = [];
  if (typeof hintTaskLineNo === "number" && hintTaskLineNo >= 0) {
    tryIdxs.push(hintTaskLineNo + 1);
    tryIdxs.push(hintTaskLineNo + 2);
    tryIdxs.push(hintTaskLineNo);
  }

  const visited = new Set<number>();
  const tryRemoveAt = (idx: number): boolean => {
    if (idx < 0 || idx >= lines.length) return false;
    if (visited.has(idx)) return false;
    visited.add(idx);
    const line = lines[idx];
    if (!isRSLatteMetaLine(line)) return false;
    if (!metaLineHasUid(line, uid)) return false;
    const r = removeKeysFromMetaLine(line, uid, ks);
    if (r.changed) {
      lines[idx] = r.line;
      changed = true;
    }
    return true;
  };

  for (const idx of tryIdxs) {
    if (tryRemoveAt(idx)) break;
  }

  if (!changed) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!isRSLatteMetaLine(line)) continue;
      if (!metaLineHasUid(line, uid)) continue;
      const r = removeKeysFromMetaLine(line, uid, ks);
      if (r.changed) {
        lines[i] = r.line;
        changed = true;
      }
      break;
    }
  }

  if (!changed) return { ok: true, changed: false };
  await app.vault.modify(file, lines.join("\n"));
  return { ok: true, changed: true };
}

function mergeLinkedScheduleUidIntoMetaLine(
  line: string,
  taskUid: string,
  scheduleUid: string
): { line: string; changed: boolean } {
  if (!metaLineHasUid(line, taskUid)) return { line, changed: false };
  const m = (line ?? "").match(RSLATTE_META_LINE_RE);
  if (!m) return { line, changed: false };
  const kv = parseCommentKV((m[1] ?? "").trim());
  const su = String(scheduleUid ?? "").trim();
  if (!su) return { line, changed: false };
  const parts = String(kv.linked_schedule_uids ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (parts.includes(su)) return { line, changed: false };
  parts.push(su);
  kv.linked_schedule_uids = parts.join(",");
  /** 录日程关联写入时同步刷新「进度最后更新时间」，与侧栏/标签口径一致 */
  kv.progress_updated = new Date().toISOString();
  return { line: buildRSLatteMetaLine(kv), changed: true };
}

/**
 * 在任务条目的下一行 meta 中追加 `linked_schedule_uids`（逗号分隔），并更新 `progress_updated`；不改任务勾选行与任务状态。
 */
export async function appendLinkedScheduleUidToTaskMeta(
  app: App,
  filePath: string,
  taskUid: string,
  scheduleUid: string,
  hintTaskLineNo?: number
): Promise<{ ok: boolean; changed: boolean; reason?: string }> {
  const tu = String(taskUid ?? "").trim();
  const su = String(scheduleUid ?? "").trim();
  if (!tu || !su || !filePath) return { ok: false, changed: false, reason: "missing uid or filePath" };

  const af = app.vault.getAbstractFileByPath(filePath);
  if (!af) return { ok: false, changed: false, reason: "file not found" };
  const file = af as TFile;

  const content = await app.vault.read(file);
  const lines = (content ?? "").split(/\r?\n/);
  let changed = false;

  const tryIdxs: number[] = [];
  if (typeof hintTaskLineNo === "number" && hintTaskLineNo >= 0) {
    tryIdxs.push(hintTaskLineNo + 1);
    tryIdxs.push(hintTaskLineNo + 2);
    tryIdxs.push(hintTaskLineNo);
  }

  const visited = new Set<number>();
  const tryMergeAt = (idx: number): boolean => {
    if (idx < 0 || idx >= lines.length) return false;
    if (visited.has(idx)) return false;
    visited.add(idx);
    const line = lines[idx];
    if (!isRSLatteMetaLine(line)) return false;
    if (!metaLineHasUid(line, tu)) return false;
    const r = mergeLinkedScheduleUidIntoMetaLine(line, tu, su);
    if (r.changed) {
      lines[idx] = r.line;
      changed = true;
    }
    return true;
  };

  for (const idx of tryIdxs) {
    if (tryMergeAt(idx)) break;
  }

  if (!changed) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!isRSLatteMetaLine(line)) continue;
      const r = mergeLinkedScheduleUidIntoMetaLine(line, tu, su);
      if (r.changed) {
        lines[i] = r.line;
        changed = true;
      }
      if (changed) break;
    }
  }

  if (!changed) return { ok: true, changed: false };
  await app.vault.modify(file, lines.join("\n"));
  return { ok: true, changed: true };
}
