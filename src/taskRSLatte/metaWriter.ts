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

function metaLineHasUid(line: string, uid: string): boolean {
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
