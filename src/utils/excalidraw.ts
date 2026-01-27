/**
 * Excalidraw 的 Markdown 文件通常包含：
 * - "## Drawing" 标题
 * - 一个 ```compressed-json 代码块
 *
 * 这些函数用于“判定/防呆”，不做任何改写。
 */

export function isExcalidrawMarkdown(text: string): boolean {
  const t = String(text ?? "");
  return /(^|\r?\n)##\s+Drawing\s*(\r?\n|$)/.test(t) && /```compressed-json/.test(t);
}

/**
 * 某些文件可能并不是 Markdown（例如纯 JSON），此时不应尝试插入/修改 frontmatter。
 */
export function looksLikeJsonDocument(text: string): boolean {
  const head = String(text ?? "").slice(0, 128).trimStart();
  return head.startsWith("{") || head.startsWith("[");
}
