import { normalizePath } from "obsidian";
import type {
  ContactInteractionArchiveEventRecord,
  ContactInteractionEvent,
  ContactsInteractionEntry,
  ContactsInteractionsIndexFile,
} from "../../contactsRSLatte/types";
import { fnv1a32 } from "../../taskRSLatte/utils";

function ms(iso: string | undefined): number {
  const t = Date.parse(String(iso ?? ""));
  return Number.isNaN(t) ? 0 : t;
}

/** 与 merge 中 dedupe 语义一致，用于窗口裁剪时的去重与集合比较 */
export function interactionEventDedupeKey(ev: ContactInteractionEvent): string {
  const t = String(ev.occurred_at ?? "").slice(0, 16);
  const s = String(ev.summary ?? "").trim();
  return `${t}|${s}`;
}

function toArchiveSourceFields(e: ContactsInteractionEntry): Omit<ContactInteractionArchiveEventRecord, "event"> {
  const st = String(e.source_type ?? "other").trim() as ContactInteractionArchiveEventRecord["source_type"];
  const out: Omit<ContactInteractionArchiveEventRecord, "event"> = {
    source_path: String(e.source_path ?? "").trim(),
    source_type: st || "other",
  };
  const sid = String(e.stable_source_id ?? "").trim();
  if (sid) out.stable_source_id = sid;
  if (typeof e.line_no === "number" && !Number.isNaN(e.line_no)) out.line_no = e.line_no;
  const k = String(e.key ?? "").trim();
  if (k) out.key = k;
  const bid = String(e.source_block_id ?? "").trim();
  if (bid) out.source_block_id = bid;
  const fa = e.follow_association_type;
  if (fa === "strong" || fa === "weak") out.follow_association_type = fa;
  return out;
}

/**
 * §6.9：按「先每 source、再全局」裁剪某联系人在主索引窗口内的事件；就地修改 `idx` 中对应条目。
 * @returns 被裁出窗口、应写入归档分片的记录（含来源字段 + `event`，按 `event.occurred_at` 升序）
 */
export function trimInteractionEventsForContactUid(
  idx: ContactsInteractionsIndexFile,
  contactUid: string,
  limits: { maxPerContact: number; maxPerSource: number },
  entryKeyOf: (e: ContactsInteractionEntry) => string
): ContactInteractionArchiveEventRecord[] {
  const uid = String(contactUid ?? "").trim();
  if (!uid) return [];
  const bucket = idx.by_contact_uid?.[uid];
  if (!bucket || bucket.length === 0) return [];

  type Tagged = { ev: ContactInteractionEvent; entry: ContactsInteractionEntry; entryKey: string; sourceType: string; dk: string };
  const seen = new Set<string>();
  const flat: Tagged[] = [];
  for (const e of bucket) {
    const ek = entryKeyOf(e);
    const st = String(e.source_type ?? "other").trim() || "other";
    for (const ev of e.interaction_events ?? []) {
      const dk = `${ek}::${interactionEventDedupeKey(ev)}`;
      if (seen.has(dk)) continue;
      seen.add(dk);
      flat.push({ ev, entry: e, entryKey: ek, sourceType: st, dk });
    }
  }
  if (flat.length === 0) return [];

  const perSourceMax = Math.max(1, limits.maxPerSource);
  const globalMax = Math.max(1, limits.maxPerContact);

  const byType = new Map<string, Tagged[]>();
  for (const x of flat) {
    if (!byType.has(x.sourceType)) byType.set(x.sourceType, []);
    byType.get(x.sourceType)!.push(x);
  }
  let afterPerSource: Tagged[] = [];
  for (const [, xs] of byType) {
    xs.sort((a, b) => ms(b.ev.occurred_at) - ms(a.ev.occurred_at));
    afterPerSource.push(...xs.slice(0, perSourceMax));
  }
  afterPerSource.sort((a, b) => ms(b.ev.occurred_at) - ms(a.ev.occurred_at));
  const kept = afterPerSource.slice(0, globalMax);

  const keptId = new Set(kept.map((k) => k.dk));
  const removed: ContactInteractionArchiveEventRecord[] = [];
  for (const x of flat) {
    if (!keptId.has(x.dk)) {
      removed.push({
        ...toArchiveSourceFields(x.entry),
        event: x.ev,
      });
    }
  }
  removed.sort((a, b) => ms(a.event.occurred_at) - ms(b.event.occurred_at));

  const keptByEntry = new Map<string, ContactInteractionEvent[]>();
  for (const k of kept) {
    if (!keptByEntry.has(k.entryKey)) keptByEntry.set(k.entryKey, []);
    keptByEntry.get(k.entryKey)!.push(k.ev);
  }
  for (const e of bucket) {
    const ek = entryKeyOf(e);
    const arr = keptByEntry.get(ek);
    if (!arr || arr.length === 0) {
      e.interaction_events = undefined;
    } else {
      arr.sort((a, b) => ms(a.occurred_at) - ms(b.occurred_at));
      e.interaction_events = arr;
    }
  }

  const paths = new Set(bucket.map((e) => normalizePath(String(e.source_path ?? "").trim())).filter(Boolean));
  for (const p of paths) {
    const rec = idx.by_source_file[p];
    if (rec?.entries) {
      rec.entries_digest = fnvDigest(rec.entries);
    }
  }

  return removed;
}

/** 与 indexStore.computeDigest 等价（供裁剪后刷新 digest） */
function fnvDigest(entries: ContactsInteractionEntry[]): string {
  const compact = (entries ?? []).map((e) => ({
    k: entryKeyLoose(e),
    s: e.status ?? "",
    sn: e.snippet ?? "",
    h: e.heading ?? "",
  }));
  return fnv1a32(JSON.stringify(compact));
}

function entryKeyLoose(e: ContactsInteractionEntry): string {
  const k = String((e as any).key ?? "").trim();
  if (k) return k;
  const ln = (e.line_no ?? -1) as number;
  return `${e.contact_uid}|${e.source_path}|${e.source_type}|${ln}`;
}
