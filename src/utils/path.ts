import { normalizePath } from "obsidian";

/**
 * 支持用户在配置里写 "[[path/to/file]]" 的情况，抽取实际路径。
 */
export function unwrapWikiLinkPath(input: string): string {
  const s = String(input ?? "").trim();
  const m = s.match(/^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/);
  return m ? m[1].trim() : s;
}

/** 统一路径规范化（trim + normalizePath） */
export function normPath(p: string): string {
  return normalizePath(String(p ?? "").trim());
}

/** 分析图命名规范："[项目名称]-项目分析图.md" */
export function makeProjectAnalysisFilename(projectName: string): string {
  const name = String(projectName ?? "").trim();
  return `${name}-项目分析图.md`;
}
