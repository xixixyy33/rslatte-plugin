/** 日程分类：内部 id 写入 meta `schedule_category`，展示名用于下拉与侧栏 */

import type { DropdownComponent } from "obsidian";

export type ScheduleCategoryDef = { id: string; label: string };

export const DEFAULT_SCHEDULE_CATEGORY_DEFS: ScheduleCategoryDef[] = [
  { id: "task_execution", label: "任务执行" },
  { id: "meeting", label: "会议" },
  { id: "appointment", label: "预约" },
  { id: "travel", label: "出行" },
  { id: "study", label: "学习" },
];

/** 未在设置中配置时的 id → 中文（兼容旧数据） */
export const LEGACY_SCHEDULE_CATEGORY_LABELS: Record<string, string> = {
  task_execution: "任务执行",
  meeting: "会议",
  appointment: "预约",
  travel: "出行",
  study: "学习",
};

/** 写入 rslatte meta：避免破坏分号分隔 */
export function sanitizeScheduleCategoryIdForMeta(raw: string): string {
  return String(raw ?? "").trim().replace(/[;\s]+/g, "_");
}

export function getScheduleCategoryDefs(scheduleModule: { scheduleCategoryDefs?: ScheduleCategoryDef[] } | undefined): ScheduleCategoryDef[] {
  const raw = scheduleModule?.scheduleCategoryDefs;
  if (Array.isArray(raw) && raw.length > 0) {
    const out: ScheduleCategoryDef[] = [];
    const seen = new Set<string>();
    for (const x of raw) {
      const id = sanitizeScheduleCategoryIdForMeta(String((x as any)?.id ?? ""));
      const label = String((x as any)?.label ?? "").trim() || id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, label });
    }
    if (out.length > 0) return out;
  }
  return DEFAULT_SCHEDULE_CATEGORY_DEFS.map((d) => ({ ...d }));
}

export function getDefaultScheduleCategoryId(scheduleModule: { defaultScheduleCategoryId?: string; scheduleCategoryDefs?: ScheduleCategoryDef[] } | undefined): string {
  const defs = getScheduleCategoryDefs(scheduleModule);
  const def = sanitizeScheduleCategoryIdForMeta(String(scheduleModule?.defaultScheduleCategoryId ?? ""));
  if (def && defs.some((d) => d.id === def)) return def;
  return defs[0]?.id ?? "meeting";
}

export function labelForScheduleCategoryId(
  scheduleModule: { scheduleCategoryDefs?: ScheduleCategoryDef[]; defaultScheduleCategoryId?: string } | undefined,
  id: string | undefined | null
): string {
  const sid = String(id ?? "").trim();
  if (!sid) return "未分类";
  const defs = getScheduleCategoryDefs(scheduleModule);
  const hit = defs.find((d) => d.id === sid);
  if (hit) return hit.label;
  return LEGACY_SCHEDULE_CATEGORY_LABELS[sid] ?? sid;
}

/** 设置页：每行 `内部id|展示名`，无 `|` 则整行作 id，展示名同 id */
export function scheduleCategoryDefsFromLines(text: string): ScheduleCategoryDef[] {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const out: ScheduleCategoryDef[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const pipe = line.indexOf("|");
    let idRaw: string;
    let labelRaw: string;
    if (pipe >= 0) {
      idRaw = line.slice(0, pipe).trim();
      labelRaw = line.slice(pipe + 1).trim();
    } else {
      idRaw = line;
      labelRaw = line;
    }
    const id = sanitizeScheduleCategoryIdForMeta(idRaw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: labelRaw || id });
  }
  return out;
}

export function scheduleCategoryLinesFromDefs(defs: ScheduleCategoryDef[]): string {
  return (defs ?? []).map((d) => `${d.id}|${d.label}`).join("\n");
}

/** 新建日程/录日程弹窗：填充下拉并返回当前选中的合法 id */
export function mountScheduleCategoryDropdown(
  d: DropdownComponent,
  scheduleModule: { scheduleCategoryDefs?: ScheduleCategoryDef[]; defaultScheduleCategoryId?: string } | undefined,
  initialId: string | undefined,
  onChange: (id: string) => void
): string {
  const defs = getScheduleCategoryDefs(scheduleModule);
  const defId = getDefaultScheduleCategoryId(scheduleModule);
  let cur = sanitizeScheduleCategoryIdForMeta(String(initialId ?? ""));
  if (!cur || !defs.some((x) => x.id === cur)) cur = defId;
  for (const x of defs) d.addOption(x.id, x.label);
  d.setValue(cur);
  d.onChange((v) => onChange(String(v)));
  return cur;
}
