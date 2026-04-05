/**
 * 输出 frontmatter：扩展字段键校验与 YAML 标量行格式化（与 §10.3 / §3.2.2 对齐）。
 */

/** 禁止出现在「创建输出 · 自定义属性」中的键（含中文别名） */
export const OUTPUT_FM_RESERVED_KEYS = new Set<string>([
  "tags",
  "type",
  "doc_category",
  "文档分类",
  "output_id",
  "create",
  "status",
  "output_document_kind",
  "project_id",
  "project_name",
  "projectId",
  "projectName",
  "domains",
  "领域",
  "domain",
  "start",
  "start_time",
  "done",
  "done_time",
  "cancelled",
  "cancelled_time",
  "resume_at",
  "resume_at_time",
  "resumed_time",
  "created",
  "created_date",
]);

export function isReservedOutputFmKey(k: string): boolean {
  const key = String(k ?? "").trim();
  if (!key) return true;
  if (OUTPUT_FM_RESERVED_KEYS.has(key)) return true;
  if (key.startsWith("_")) return true;
  return false;
}

/** 单行标量：含特殊字符时用双引号 */
export function formatYamlScalarLine(v: string): string {
  const raw = String(v ?? "");
  if (raw === "") return '""';
  const needsQuote =
    /[:\#\[\]{}&*!?|>'"%@`\n\r]/.test(raw) ||
    raw !== raw.trim() ||
    raw === "true" ||
    raw === "false" ||
    raw === "null" ||
    /^[+-]?(Infinity|inf|NaN)$/i.test(raw) ||
    /^[\d.+-]+$/.test(raw);
  if (!needsQuote) return raw;
  const esc = raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
  return `"${esc}"`;
}
