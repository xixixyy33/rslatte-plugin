import type { ContactsInteractionEntry, ContactsInteractionSourceType } from "../../contactsRSLatte/types";
import { getNearestHeadingTitle } from "../markdown/headingLocator";

export type ParseContactRefsOpts = {
  /** vault-relative path of the source file (used in InteractionEntry) */
  source_path: string;
  /** source type for later rendering/filtering */
  source_type: ContactsInteractionSourceType;
  /** ISO timestamp for this parse run (defaults to now) */
  updated_at?: string;
  /**
   * When true, ignore refs inside fenced code blocks (``` or ~~~).
   * Default: true
   */
  ignore_code_fence?: boolean;
  /**
   * Maximum snippet length. Default: 240
   */
  snippet_max_len?: number;
};

function normLine(line: string): string {
  return String(line ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function shortenSnippet(s: string, maxLen: number): string {
  const t = String(s ?? "").trimEnd();
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen - 1) + "…";
}

function extractUidFromTarget(target: string): string | null {
  const raw = String(target ?? "").trim();
  if (!raw) return null;

  // Typical: "C_<uid>" or "C_<uid>.md"
  // Also allow fullpath: "90-Contacts/.../C_<uid>.md"
  const base = raw.split("/").pop() ?? raw;
  const name = base.replace(/\.md$/i, "");
  const m = /^C_([A-Za-z0-9_-]+)$/.exec(name);
  if (m && m[1]) return String(m[1]);

  // Fallback: search substring "C_<uid>" in the basename.
  const m2 = /(C_([A-Za-z0-9_-]+))/i.exec(name);
  if (m2 && m2[2]) return String(m2[2]);
  return null;
}

/**
 * Exported helper for other modules (task/project) to extract contact_uid from a wiki-link target.
 * It supports:
 * - C_<uid>
 * - path/to/C_<uid>
 * - C_<uid>.md
 */
export function extractContactUidFromWikiTarget(target: string): string | null {
  return extractUidFromTarget(target);
}

/**
 * Parse contact references from markdown text.
 *
 * Supported forms:
 * - [[C_<uid>|Display Name]]
 * - [[C_<uid>]]
 * - optional: [[path/to/C_<uid>.md|...]] (extract uid from basename)
 */
export function parseContactRefsFromMarkdown(text: string, opts: ParseContactRefsOpts): ContactsInteractionEntry[] {
  const source_path = String(opts.source_path ?? "").trim();
  const source_type = opts.source_type;
  if (!source_path) return [];
  if (!source_type) return [];

  const updated_at = String(opts.updated_at ?? new Date().toISOString());
  const ignoreFence = opts.ignore_code_fence !== false;
  const maxLen = Math.max(40, Number(opts.snippet_max_len ?? 240));

  const normalized = normLine(text ?? "");
  const lines = normalized.split("\n");

  const out: ContactsInteractionEntry[] = [];
  const seen = new Set<string>();

  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] ?? "");

    if (ignoreFence && /^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }

    if (ignoreFence && inFence) continue;

    if (!line.includes("[[")) continue;

    const snippet = shortenSnippet(line.trimEnd(), maxLen);
    if (!snippet.trim()) continue;

    // Find all wiki links in this line.
    // Note: keep simple and fast (no catastrophic backtracking): [[...]] without nested ]
    const re = /\[\[([^\]]+)\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const inside = String(m[1] ?? "");
      if (!inside) continue;

      // split target and alias: target|alias
      const target = inside.split("|")[0] ?? "";
      const uid = extractUidFromTarget(target);
      if (!uid) continue;

      const contact_uid = uid;
      const heading = getNearestHeadingTitle(lines, i);

      // 1-based line_no for better UX when jumping
      const line_no = i + 1;
      const key = `${contact_uid}|${source_path}|${source_type}|${line_no}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        contact_uid,
        source_path,
        source_type,
        snippet,
        line_no,
        heading,
        updated_at,
        key,
      });
    }
  }

  return out;
}
