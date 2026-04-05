import { normalizePath, TFile } from "obsidian";
import type { App } from "obsidian";
import type { ContactInteractionEvent, ContactsInteractionEntry } from "../../contactsRSLatte/types";
import type { ContactsInteractionsStore } from "../../contactsRSLatte/indexStore";
import { fnv1a32 } from "../../utils/hash";

function getStore(plugin: { contactsIndex: { getInteractionsStore: () => ContactsInteractionsStore } }): ContactsInteractionsStore {
  return plugin.contactsIndex.getInteractionsStore();
}

/**
 * 将一条手动互动写入主索引（contacts-interactions），并与该联系人笔记文件下已有条目合并。
 */
export async function appendManualContactToInteractionsIndex(
  plugin: { contactsIndex: { getInteractionsStore: () => ContactsInteractionsStore } },
  args: {
    contactUid: string;
    contactFilePath: string;
    snippet: string;
    occurredAtIso: string;
  }
): Promise<void> {
  const st = getStore(plugin);
  const idx = await st.readIndex();
  const path = normalizePath(args.contactFilePath);
  const rec = idx.by_source_file[path];
  const existing = rec?.entries ?? [];
  const mtime = Date.now();
  const sn = String(args.snippet ?? "").trim().slice(0, 500);
  if (!sn) throw new Error("empty snippet");
  const minuteKey = String(args.occurredAtIso).slice(0, 16);
  const ev: ContactInteractionEvent = {
    occurred_at: args.occurredAtIso,
    event_kind: "manual_note",
    summary: sn.slice(0, 500),
  };
  const key = `manual|${minuteKey}|${fnv1a32(sn)}`;
  const newEntry: ContactsInteractionEntry = {
    contact_uid: args.contactUid,
    source_path: path,
    source_type: "manual_note",
    snippet: sn,
    updated_at: args.occurredAtIso,
    key,
    interaction_events: [ev],
    status: "done",
  };
  const merged = [...existing, newEntry];
  await st.applyFileUpdates({ upserts: [{ source_path: path, mtime, entries: merged }] });
}

/** 若 occurred 晚于 frontmatter 中的 last_interaction_at，则更新 */
export async function updateContactLastInteractionAtIfNewer(
  app: App,
  file: TFile,
  occurredAtIso: string
): Promise<void> {
  const cand = String(occurredAtIso ?? "").trim();
  if (!cand) return;
  const candMs = Date.parse(cand);
  if (Number.isNaN(candMs)) return;
  await app.fileManager.processFrontMatter(file, (fm) => {
    const cur = String((fm as any).last_interaction_at ?? "").trim();
    const curMs = cur ? Date.parse(cur) : NaN;
    if (!cur || Number.isNaN(curMs) || candMs > curMs) {
      (fm as any).last_interaction_at = cand;
    }
    (fm as any).updated_at = new Date().toISOString();
  });
}
