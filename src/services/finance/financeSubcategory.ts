/**
 * Finance subcategory helpers.
 *
 * We store subcategory as a prefix at the very beginning of note:
 *   【子分类】备注正文
 */

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
  const raw = String(note ?? "");
  const m = raw.match(/^\s*【([^】]{1,80})】\s*/);
  if (!m) return { subcategory: "", body: raw.trim() };
  const sub = normalizeFinanceSubcategory(m[1]);
  const body = raw.slice(m[0].length).trim();
  return { subcategory: sub, body };
}

/**
 * Build a note string with (optional) subcategory prefix.
 * Always strips existing leading 【...】 first to avoid duplicates.
 */
export function buildFinanceNoteWithSubcategory(subcategory: string, bodyNote: string): string {
  const body = extractFinanceSubcategory(bodyNote).body; // strip existing prefix if any
  const sub = normalizeFinanceSubcategory(subcategory);
  if (!sub) return body.trim();
  return body ? `【${sub}】${body.startsWith(" ") ? "" : " "}${body}` : `【${sub}】`;
}
