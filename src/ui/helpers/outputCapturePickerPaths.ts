import { normalizePath } from "obsidian";

/**
 * Capture 关联输出清单：展示「Notes 目录下」相对路径提示。
 * - 去掉文件名；若父目录名与文档 basename（无 .md）相同则再向上一级（常见「文档名/文档名.md」结构）。
 * - 若路径中存在名称含 `note` 的段（不区分大小写），仅保留其后的目录段。
 */
export function formatOutputDocFolderHintForCapture(filePath: string): string {
  const norm = normalizePath(String(filePath ?? "").trim());
  if (!norm) return "—";
  const segments = norm.split("/").filter(Boolean);
  if (segments.length < 2) return "—";
  const fileName = segments[segments.length - 1] ?? "";
  const baseName = fileName.replace(/\.md$/i, "");
  let dirSegments = segments.slice(0, -1);
  if (dirSegments.length && dirSegments[dirSegments.length - 1] === baseName) {
    dirSegments = dirSegments.slice(0, -1);
  }
  const noteIdx = dirSegments.findIndex((s) => /note/i.test(s));
  const afterNotes = noteIdx >= 0 ? dirSegments.slice(noteIdx + 1) : dirSegments;
  if (!afterNotes.length) return "—";
  return afterNotes.join("/");
}
