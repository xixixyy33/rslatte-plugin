/**
 * 任务/项目任务 WorkEvent.ref 中的联系人关联字段约定（与强弱关联分离）：
 * - contact_uids_strong：正文 [[C_xxx]] 解析出的 uid 列表（可多）
 * - contact_uids_weak：meta follow_contact_uids 维护的多人列表
 *
 * 联系人互动索引刷新时按条目 follow_association_type 选用对应字段过滤 WorkEvent。
 */
import { extractContactUidFromWikiTarget } from "./contactRefParser";

export const WORK_EVENT_CONTACT_UIDS_STRONG = "contact_uids_strong";
export const WORK_EVENT_CONTACT_UIDS_WEAK = "contact_uids_weak";

/** 从任务行正文提取 wiki 联系人 uid（不含弱关联 meta） */
export function extractStrongContactUidsFromTaskLine(line: string): string[] {
  const t = String(line ?? "");
  const re = /\[\[([^\]]+)\]\]/g;
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const target = (String(m[1] ?? "").split("|")[0] ?? "").trim();
    const uid = extractContactUidFromWikiTarget(target);
    if (uid && !seen.has(uid)) {
      seen.add(uid);
      out.push(uid);
    }
  }
  return out;
}

function normUidList(arr: string[] | undefined | null): string[] {
  if (!arr?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of arr) {
    const u = String(x ?? "").trim();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

/**
 * 写入任务/项目任务 WorkEvent 前合并联系人字段（不删除 ref 已有其它键）。
 */
export function enrichWorkEventRefWithTaskContacts(
  ref: Record<string, any> | undefined,
  ctx: { taskLine?: string; followContactUids?: string[] | null }
): Record<string, any> {
  const base = { ...(ref ?? {}) };
  const strong = ctx.taskLine ? extractStrongContactUidsFromTaskLine(ctx.taskLine) : [];
  const weak = normUidList(ctx.followContactUids ?? []);
  if (strong.length) base[WORK_EVENT_CONTACT_UIDS_STRONG] = strong;
  if (weak.length) base[WORK_EVENT_CONTACT_UIDS_WEAK] = weak;
  return base;
}

export function readContactUidsStrongWeak(ref: Record<string, any> | undefined): { strong: string[]; weak: string[] } {
  const r = ref ?? {};
  const strong = Array.isArray(r[WORK_EVENT_CONTACT_UIDS_STRONG])
    ? normUidList(r[WORK_EVENT_CONTACT_UIDS_STRONG] as string[])
    : typeof r[WORK_EVENT_CONTACT_UIDS_STRONG] === "string"
      ? normUidList(String(r[WORK_EVENT_CONTACT_UIDS_STRONG]).split(/[,;\s]+/))
      : [];
  const weak = Array.isArray(r[WORK_EVENT_CONTACT_UIDS_WEAK])
    ? normUidList(r[WORK_EVENT_CONTACT_UIDS_WEAK] as string[])
    : typeof r[WORK_EVENT_CONTACT_UIDS_WEAK] === "string"
      ? normUidList(String(r[WORK_EVENT_CONTACT_UIDS_WEAK]).split(/[,;\s]+/))
      : [];
  return { strong, weak };
}
