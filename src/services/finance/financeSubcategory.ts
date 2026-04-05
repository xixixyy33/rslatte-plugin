/**
 * Finance subcategory helpers.
 *
 * Legacy format:
 *   【子分类】备注正文
 *
 * New meta format (all optional, can appear together at beginning):
 *   【子分类:xxx】【机构:yyy】【周期:monthly】【场景:a|b】备注正文
 */

import { normalizeFinanceCycleType, type FinanceCycleType } from "../../types/rslatteTypes";

export function normalizeFinanceSubcategory(input: string): string {
  let s = String(input ?? "").trim();
  // Strip surrounding brackets if user pasted them.
  s = s.replace(/^【+/, "").replace(/】+$/, "");
  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  // Avoid crazy long values (UI/analytics only)
  if (s.length > 50) s = s.slice(0, 50).trim();
  return s;
}

export function extractFinanceSubcategory(note: string): { subcategory: string; body: string } {
  const meta = extractFinanceMeta(note);
  return { subcategory: meta.subcategory, body: meta.body };
}

/**
 * Build a note string with (optional) subcategory prefix.
 * Always strips existing leading 【...】 first to avoid duplicates.
 */
export function buildFinanceNoteWithSubcategory(subcategory: string, bodyNote: string): string {
  return buildFinanceNoteWithMeta({ subcategory, bodyNote });
}

export type FinanceNoteMeta = {
  subcategory: string;
  institutionName: string;
  cycleType: FinanceCycleType;
  sceneTags: string[];
  body: string;
};

function normalizeInstitutionName(input: string): string {
  let s = String(input ?? "").trim();
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 50) s = s.slice(0, 50).trim();
  return s;
}

function normalizeSceneTags(tags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tags ?? []) {
    const v = String(t ?? "").trim().replace(/\s+/g, " ");
    if (!v) continue;
    if (v.length > 20) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= 20) break;
  }
  return out;
}

export function extractFinanceMeta(note: string): FinanceNoteMeta {
  const raw = String(note ?? "").trim();
  let rest = raw;
  let subcategory = "";
  let institutionName = "";
  let cycleType: FinanceCycleType = "none";
  let sceneTags: string[] = [];

  while (true) {
    const m = rest.match(/^\s*【([^】]{1,120})】\s*/);
    if (!m) break;
    const token = String(m[1] ?? "").trim();
    rest = rest.slice(m[0].length);

    const colonIdx = token.indexOf(":");
    if (colonIdx > 0) {
      const key = token.slice(0, colonIdx).trim();
      const val = token.slice(colonIdx + 1).trim();
      if (key === "子分类" && val) subcategory = normalizeFinanceSubcategory(val);
      else if (key === "机构" && val) institutionName = normalizeInstitutionName(val);
      else if (key === "周期" && val) cycleType = normalizeFinanceCycleType(val);
      else if (key === "场景" && val) sceneTags = normalizeSceneTags(val.split("|"));
      continue;
    }

    // legacy: first plain 【xxx】 token as subcategory
    if (!subcategory) {
      const legacySub = normalizeFinanceSubcategory(token);
      if (legacySub) {
        subcategory = legacySub;
        continue;
      }
    }
    // unknown token: put it back into body and stop parsing meta
    rest = `【${token}】 ${rest}`.trim();
    break;
  }

  return {
    subcategory,
    institutionName,
    cycleType,
    sceneTags,
    body: rest.trim(),
  };
}

export function buildFinanceNoteWithMeta(args: {
  subcategory?: string;
  institutionName?: string;
  cycleType?: FinanceCycleType;
  sceneTags?: string[];
  bodyNote?: string;
}): string {
  const extracted = extractFinanceMeta(String(args.bodyNote ?? ""));
  const body = extracted.body;
  const sub = normalizeFinanceSubcategory(String(args.subcategory ?? extracted.subcategory ?? ""));
  const inst = normalizeInstitutionName(String(args.institutionName ?? extracted.institutionName ?? ""));
  const cycle = normalizeFinanceCycleType(args.cycleType ?? extracted.cycleType ?? "none");
  const tags = normalizeSceneTags(Array.isArray(args.sceneTags) ? args.sceneTags : extracted.sceneTags);

  const parts: string[] = [];
  if (sub) parts.push(`【子分类:${sub}】`);
  if (inst) parts.push(`【机构:${inst}】`);
  if (cycle !== "none") parts.push(`【周期:${cycle}】`);
  if (tags.length > 0) parts.push(`【场景:${tags.join("|")}】`);
  const head = parts.join("");
  if (!head) return body.trim();
  return body ? `${head} ${body}` : head;
}
