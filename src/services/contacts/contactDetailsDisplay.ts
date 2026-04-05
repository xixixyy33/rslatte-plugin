/**
 * 联系人「详细信息」页签：frontmatter 键的中文名与值的可读格式化（非 JSON 堆砌）
 */

/** 常见联系人 frontmatter 键 → 中文展示名；未命中则回退为原键名 */
export const CONTACT_FM_FIELD_LABELS: Record<string, string> = {
  birthday: "生日",
  company: "公司",
  department: "部门",
  emails: "邮箱",
  im: "即时通讯",
  phones: "电话",
  summary: "摘要",
  type: "类型",
  address: "地址",
  notes: "备注",
  url: "网址",
  website: "网站",
  job_title: "职位",
  title: "职位",
  organization: "组织",
  role: "角色",
  country: "国家",
  region: "地区",
  city: "城市",
  postal_code: "邮编",
  nickname: "昵称",
  gender: "性别",
  pronouns: "称谓",
  timezone: "时区",
  locale: "区域",
  source: "来源",
  uid: "UID",
  id: "编号",
  version: "版本",
  extra: "扩展",
};

/** 嵌套对象内常见英文键 → 中文（用于多行键值展示） */
const NESTED_KEY_LABELS: Record<string, string> = {
  type: "类型",
  month: "月",
  day: "日",
  year: "年",
  leap_month: "闰月",
  note: "备注",
  label: "标签",
  value: "值",
  primary: "主",
  name: "名称",
  email: "邮箱",
  phone: "电话",
};

/** 部分枚举值可读化 */
const ENUM_VALUE_LABELS: Record<string, string> = {
  contact: "联系人",
  personal: "个人",
  organization: "组织",
  lunar: "农历",
  solar: "公历",
};

export function contactFrontmatterFieldLabel(key: string): string {
  const k = String(key ?? "").trim();
  if (!k) return "";
  return CONTACT_FM_FIELD_LABELS[k] ?? k;
}

function nestedKeyLabel(key: string): string {
  const k = String(key ?? "").trim();
  return NESTED_KEY_LABELS[k] ?? k;
}

function formatPrimitiveForDisplay(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "是" : "否";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") {
    const s = v.trim();
    const mapped = ENUM_VALUE_LABELS[s];
    return mapped ?? v;
  }
  return String(v);
}

/** 农历/公历生日对象 */
function formatBirthdayValue(v: Record<string, unknown>): string {
  const t = String(v.type ?? "").trim();
  if (t === "lunar") {
    const leap = v.leap_month === true ? "闰" : "";
    const m = v.month ?? "?";
    const d = v.day ?? "?";
    const note = String(v.note ?? "").trim();
    let s = `农历 ${leap}${m}月${d}日`;
    if (note) s += `\n备注：${note}`;
    return s;
  }
  if (t === "solar" || v.year !== undefined) {
    const y = v.year ?? "";
    const m = v.month ?? "";
    const d = v.day ?? "";
    const parts = [y, m, d].filter((x) => x !== "" && x !== null && x !== undefined);
    if (parts.length > 0) return `公历 ${parts.join("-")}`;
  }
  return formatObjectToKeyValueLines(v, 0);
}

/** 带 label/value/primary 的条目列表（电话、邮箱等） */
function formatLabeledRecordArray(arr: unknown[]): string {
  const lines: string[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") {
      lines.push(formatPrimitiveForDisplay(item));
      continue;
    }
    const o = item as Record<string, unknown>;
    const label = String(o.label ?? "").trim();
    const value = String(o.value ?? "").trim();
    const primary = o.primary === true ? " · 主" : "";
    if (label && value) lines.push(`${label}：${value}${primary}`);
    else if (value) lines.push(`${value}${primary}`);
    else lines.push(formatObjectToKeyValueLines(o, 0));
  }
  return lines.join("\n");
}

function isLabeledRecordArray(arr: unknown[]): boolean {
  if (arr.length === 0) return true;
  return arr.every((x) => {
    if (!x || typeof x !== "object") return false;
    const o = x as Record<string, unknown>;
    return "value" in o || "label" in o;
  });
}

/**
 * 将普通对象格式化为多行「中文键：值」，嵌套时增加缩进。
 */
function formatObjectToKeyValueLines(obj: Record<string, unknown>, depth: number): string {
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
  for (const k of keys) {
    const raw = obj[k];
    const label = nestedKeyLabel(k);
    if (raw === null || raw === undefined) {
      lines.push(`${indent}${label}：—`);
      continue;
    }
    if (typeof raw === "object" && !Array.isArray(raw)) {
      lines.push(`${indent}${label}：`);
      lines.push(formatObjectToKeyValueLines(raw as Record<string, unknown>, depth + 1));
      continue;
    }
    if (Array.isArray(raw)) {
      if (raw.length === 0) {
        lines.push(`${indent}${label}：—`);
        continue;
      }
      lines.push(`${indent}${label}：`);
      const inner = isLabeledRecordArray(raw) ? formatLabeledRecordArray(raw) : formatArrayLines(raw, depth + 1);
      for (const ln of inner.split("\n")) {
        lines.push(`${indent}  ${ln}`);
      }
      continue;
    }
    lines.push(`${indent}${label}：${formatPrimitiveForDisplay(raw)}`);
  }
  return lines.join("\n");
}

function formatArrayLines(arr: unknown[], depth: number): string {
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  arr.forEach((item, i) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      lines.push(`${indent}· ${i + 1}`);
      lines.push(formatObjectToKeyValueLines(item as Record<string, unknown>, depth + 1));
    } else {
      lines.push(`${indent}· ${formatPrimitiveForDisplay(item)}`);
    }
  });
  return lines.join("\n");
}

/**
 * 根据字段键与原始值生成侧栏展示用多行纯文本（不使用 JSON.stringify 作为主展示）。
 */
export function formatContactFrontmatterValue(fieldKey: string, value: unknown): string {
  if (value === null || value === undefined) return "—";
  const key = String(fieldKey ?? "").trim();

  if (typeof value === "string") {
    if (value.length === 0) return "—";
    const t = value.trim();
    if (t.length === 0) return "—";
    return ENUM_VALUE_LABELS[t] !== undefined ? ENUM_VALUE_LABELS[t]! : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return formatPrimitiveForDisplay(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return "—";
    if (key === "phones" || key === "emails" || isLabeledRecordArray(value)) {
      return formatLabeledRecordArray(value);
    }
    return formatArrayLines(value, 0);
  }

  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (key === "birthday" || o.type === "lunar" || o.type === "solar") {
      return formatBirthdayValue(o);
    }
    return formatObjectToKeyValueLines(o, 0);
  }

  return String(value);
}
