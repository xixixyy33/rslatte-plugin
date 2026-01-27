/** 规范化标题文本：比较时忽略 # 级别，只比较标题内容 */
export function normalizeHeadingText(s: string): string {
  return (s ?? "").trim().replace(/^#+\s*/, "").trim();
}

/**
 * 用于“查找标题行/提取区块内容”的宽松归一化：
 * - 去掉 markdown 标题的 #
 * - 去掉标题前后可能出现的 emoji/符号（例如 "### 📝 今日积累"）
 * - 压缩空白
 *
 * 目的：配置里写 "### 今日积累" 也能匹配到正文里的 "### 📝 今日积累"。
 */
export function normalizeHeadingKey(s: string): string {
  let t = normalizeHeadingText(s);

  // 去掉前后“非字母/数字”的字符（emoji、符号、标点等）
  // 注意：使用 Unicode 属性转义，需要现代 JS（Obsidian/Electron 支持）。
  try {
    t = t.replace(/^[^\p{L}\p{N}]+/gu, "");
    t = t.replace(/[^\p{L}\p{N}]+$/gu, "");
  } catch {
    // fallback（不支持 \p{} 时）：至少去掉常见前缀符号
    t = t.replace(/^[^A-Za-z0-9\u4e00-\u9fa5]+/g, "");
    t = t.replace(/[^A-Za-z0-9\u4e00-\u9fa5]+$/g, "");
  }

  return t.replace(/\s+/g, " ").trim();
}

/** 把任意输入转成标准 H2（## xxx） */
export function toH2(title: string): string {
  const t = normalizeHeadingText(title);
  return `## ${t}`;
}

/** 行尾 trim，用于标题查找的“严格相等”比较 */
export function normLine(s: string): string {
  return (s ?? "").trimEnd();
}


/** Normalize a line for exact comparison: trim only line-end spaces */
export function normalizeLine(s: string): string {
  return (s ?? "").replace(/\r?\n/g, "").trimEnd();
}
