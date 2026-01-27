/**
 * Best-effort heading locator for markdown.
 *
 * Given a list of markdown lines and a 0-based line index, returns the nearest
 * preceding heading text (H1-H6) that is not inside a fenced code block.
 *
 * - Returns only the heading title (without leading #)
 * - Does not attempt to build a full heading path (can be extended later)
 */

export function getNearestHeadingTitle(lines: string[], lineIndex: number): string | undefined {
  if (!Array.isArray(lines) || lines.length === 0) return undefined;
  const idx = Math.min(Math.max(0, lineIndex), lines.length - 1);

  // Determine fence state up to idx (inclusive).
  // This keeps the function independent (no external parser dependency).
  let inFence = false;
  for (let i = 0; i <= idx; i++) {
    const ln = String(lines[i] ?? "");
    if (/^\s*(```|~~~)/.test(ln)) {
      inFence = !inFence;
    }
  }

  if (inFence) {
    // If current line is inside a code fence, we still try to find the nearest
    // heading before the opening fence by scanning upward and toggling fences.
    // To keep it simple and safe, return undefined.
    return undefined;
  }

  // Scan upward to find the nearest heading.
  // Also skip headings that appear inside fenced code blocks.
  let fence = false;
  for (let i = idx; i >= 0; i--) {
    const ln = String(lines[i] ?? "");
    if (/^\s*(```|~~~)/.test(ln)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;

    const m = /^\s*(#{1,6})\s+(.+?)\s*$/.exec(ln);
    if (!m) continue;
    const title = String(m[2] ?? "").trim();
    if (!title) continue;
    return title;
  }

  return undefined;
}
