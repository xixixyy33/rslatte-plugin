import { moment } from "obsidian";

const momentFn = moment as any;

export function isValidId(id: string): boolean {
  const v = (id ?? "").trim();
  if (!v) return false;
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(v);
}

export function normalizeKey(s: string): string {
  return (s ?? "").trim();
}

export function buildDupSet(values: string[]): Set<string> {
  const count = new Map<string, number>();
  for (const raw of values) {
    const v = normalizeKey(raw);
    if (!v) continue;
    count.set(v, (count.get(v) ?? 0) + 1);
  }
  const dup = new Set<string>();
  for (const [k, c] of count.entries()) if (c > 1) dup.add(k);
  return dup;
}

export function genId(prefix: "DK" | "CW"): string {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}_${rand}`;
}

export function genPanelId(): string {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `JP_${rand}`;
}

/** 项目 ID：要求在知识库内唯一（后续会做冲突校验） */
export function genProjectId(): string {
  // 例：PRJ_20251231_193045_AB12CD
  const stamp = momentFn().format("YYYYMMDD_HHmmss");
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `PRJ_${stamp}_${rand}`;
}

/** 文件 ID：用于在文件被重命名后仍能稳定定位 */
export function genFileId(): string {
  // 例：FID_20251231_193045_AB12CD
  const stamp = momentFn().format("YYYYMMDD_HHmmss");
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `FID_${stamp}_${rand}`;
}
