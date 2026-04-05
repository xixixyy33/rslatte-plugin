/**
 * 财务日记行：主行 + HTML 注释 meta（rslatte:finance:meta）
 * 与 docs/V2改造方案/记录类管理优化方案.md 第七节一致。
 */

import { normalizeFinanceCycleType, type FinanceCycleType } from "../../types/rslatteTypes";
import { buildFinanceNoteWithMeta, normalizeFinanceSubcategory } from "./financeSubcategory";

export type FinanceJournalMetaPayload = {
  entry_id: string;
  subcategory: string;
  institution_name?: string;
  cycle_type?: FinanceCycleType | string;
  /** 周期表行 ID；显式 "none" 表示不入表且异常扫描跳过 */
  cycle_id?: string;
  scene_tags?: string[];
  is_delete?: boolean;
};

const META_PREFIX = "<!-- rslatte:finance:meta ";

/**
 * 财务日记「主行」：与 `recordRSLatte/service.parseDiaryForDay` 中解析规则一致，供扫描与 UI 定位复用。
 */
export const FINANCE_DIARY_MAIN_LINE_RE =
  /^\s*[-*]\s+(?:(❌|✅)\s+)?(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?\s+(income|expense)\s+([A-Za-z0-9_]+)\s+(.*)$/;

/** 匹配整行 HTML 注释内的 JSON */
export const FINANCE_META_LINE_RE = /^\s*<!--\s*rslatte:finance:meta\s+(\{[\s\S]*\})\s*-->\s*$/;

function safeParseSceneTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const x of raw) {
    const s = String(x ?? "").trim();
    if (s) out.push(s);
  }
  return out;
}

export function parseFinanceMetaCommentLine(line: string): FinanceJournalMetaPayload | null {
  const m = String(line ?? "").match(FINANCE_META_LINE_RE);
  if (!m) return null;
  try {
    const o = JSON.parse(m[1]) as Record<string, unknown>;
    const entry_id = String(o.entry_id ?? "").trim();
    const subcategory = normalizeFinanceSubcategory(String(o.subcategory ?? ""));
    if (!entry_id || !subcategory) return null;
    const cycleRaw = o.cycle_id != null ? String(o.cycle_id).trim() : "";
    return {
      entry_id,
      subcategory,
      institution_name: String(o.institution_name ?? "").trim() || undefined,
      cycle_type: o.cycle_type != null ? normalizeFinanceCycleType(String(o.cycle_type)) : "none",
      cycle_id: cycleRaw || undefined,
      scene_tags: safeParseSceneTags(o.scene_tags),
      is_delete: o.is_delete === true,
    };
  } catch {
    return null;
  }
}

export function stringifyFinanceMetaComment(meta: FinanceJournalMetaPayload): string {
  const obj: Record<string, unknown> = {
    entry_id: meta.entry_id,
    subcategory: meta.subcategory,
  };
  if (meta.institution_name) obj.institution_name = meta.institution_name;
  const ct = meta.cycle_type != null ? String(meta.cycle_type) : "none";
  if (ct && ct !== "none") obj.cycle_type = ct;
  const cid = String(meta.cycle_id ?? "").trim();
  if (cid) obj.cycle_id = cid;
  if (meta.scene_tags && meta.scene_tags.length > 0) obj.scene_tags = meta.scene_tags;
  if (meta.is_delete === true) obj.is_delete = true;
  return `${META_PREFIX.trim()} ${JSON.stringify(obj)} -->`;
}

/** 主行 note：子分类/机构；周期信息仅在 meta（不含场景） */
export function buildFinanceMainNoteParts(args: {
  subcategory?: string;
  institutionName?: string;
  cycleType?: FinanceCycleType;
  bodyNote?: string;
}): string {
  return buildFinanceNoteWithMeta({
    subcategory: args.subcategory,
    institutionName: args.institutionName,
    // 周期信息仅放在 meta 行，不再出现在主行 note
    cycleType: "none",
    sceneTags: [],
    bodyNote: args.bodyNote,
  }).trim();
}

/** 财务主行（人类可读）；取消行带 ❌ 与时间 */
export function buildFinanceListItemLine(args: {
  dateKey: string;
  type: "income" | "expense";
  categoryId: string;
  categoryDisplayName: string;
  noteMain: string;
  signedAmount: number;
  isDelete?: boolean;
  cancelTimeHm?: string;
}): string {
  const name = String(args.categoryDisplayName ?? "").trim().replace(/\s+/g, "") || args.categoryId;
  const note = String(args.noteMain ?? "").trim() || "-";
  const amtAbs = Math.abs(Number(args.signedAmount));
  if (args.isDelete) {
    const ts = String(args.cancelTimeHm ?? "").trim() || "00:00";
    return `- ❌ ${args.dateKey} ${ts} ${args.type} ${args.categoryId} ${name} ${note} ${amtAbs.toFixed(2)}`;
  }
  return `- ${args.dateKey} ${args.type} ${args.categoryId} ${name} ${note} ${Number(args.signedAmount).toFixed(2)}`;
}

export function generateFinanceEntryId(): string {
  const rnd = typeof crypto !== "undefined" && crypto.getRandomValues
    ? Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("")
    : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return `FE_${rnd}`;
}

/** 自 mainLineIndex 下一行起跳过空白，返回第一条非空行索引及解析结果 */
export function peekFinanceMetaAfterMain(lines: string[], mainLineIndex: number): { lineIndex: number; meta: FinanceJournalMetaPayload } | null {
  let j = mainLineIndex + 1;
  while (j < lines.length && String(lines[j] ?? "").trim() === "") j++;
  if (j >= lines.length) return null;
  const meta = parseFinanceMetaCommentLine(lines[j] ?? "");
  if (!meta) return null;
  return { lineIndex: j, meta };
}

/**
 * 在已拆分的日记行中查找某条财务记录对应的主行行号（0-based）。
 * 优先按 `entry_id`（meta 下一行）匹配并取文件中最后一次出现，与索引「最后一行 wins」对齐。
 * 无 entry_id 时按日期+类型+分类+金额做尽力匹配（legacy）。
 */
export function findFinanceMainLineIndexInDiaryLines(
  lines: string[],
  dayKey: string,
  opts: {
    entryId?: string;
    categoryId: string;
    type: "income" | "expense";
    amount: number;
    isDelete?: boolean;
  }
): number | null {
  const eid = String(opts.entryId ?? "").trim();
  let lastByEntry: number | null = null;
  if (eid) {
    for (let i = 0; i < lines.length; i++) {
      const m = String(lines[i] ?? "").match(FINANCE_DIARY_MAIN_LINE_RE);
      if (!m) continue;
      const rd = m[2];
      if (rd !== dayKey) continue;
      const type = m[4] === "income" ? "income" : "expense";
      const catId = String(m[5]);
      if (catId !== opts.categoryId || type !== opts.type) continue;
      const mark = (m[1] ?? "") as string;
      const peek = peekFinanceMetaAfterMain(lines, i);
      if (!peek || String(peek.meta.entry_id ?? "").trim() !== eid) continue;
      const wantDel = !!opts.isDelete;
      const lineIsDel = mark === "❌" || peek.meta.is_delete === true;
      if (lineIsDel !== wantDel) continue;
      lastByEntry = i;
    }
    if (lastByEntry != null) return lastByEntry;
  }

  // legacy：同日同分类按金额匹配最后一次
  let lastLegacy: number | null = null;
  const wantAmt = Number(opts.amount ?? 0);
  for (let i = 0; i < lines.length; i++) {
    const m = String(lines[i] ?? "").match(FINANCE_DIARY_MAIN_LINE_RE);
    if (!m) continue;
    const rd = m[2];
    if (rd !== dayKey) continue;
    const type = m[4] === "income" ? "income" : "expense";
    const catId = String(m[5]);
    if (catId !== opts.categoryId || type !== opts.type) continue;
    const mark = (m[1] ?? "") as string;
    const isDelLine = mark === "❌";
    if (!!opts.isDelete !== isDelLine) continue;
    const tail = String(m[6] ?? "").trim();
    const mAmt = tail.match(/([+-]?\d+(?:\.\d+)?)(?!.*[+-]?\d+(?:\.\d+)?)/);
    const amtRaw = mAmt ? Number(mAmt[1]) : NaN;
    if (!Number.isFinite(amtRaw)) continue;
    let amount = amtRaw;
    if (type === "expense" && amount > 0) amount = -Math.abs(amount);
    if (type === "income" && amount < 0) amount = Math.abs(amount);
    if (Math.abs(amount - wantAmt) > 1e-6) continue;
    const peek = peekFinanceMetaAfterMain(lines, i);
    if (peek) continue; // 有 meta 的走 entryId 分支，避免 legacy 误匹配多条
    lastLegacy = i;
  }
  return lastLegacy;
}
