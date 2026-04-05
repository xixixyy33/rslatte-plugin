import type { App } from "obsidian";
import { normalizePath } from "obsidian";
import type { ContactsInteractionEntry, ContactsReplicaFirstShardEntry, ContactsReplicaFirstShardFile } from "../../contactsRSLatte/types";
import type { ContactsInteractionsStore } from "../../contactsRSLatte/indexStore";
import { computeDisplayLastAtFromEntries } from "./contactInteractionDisplay";

async function ensureFolderChain(app: App, dirPath: string): Promise<void> {
  const p = normalizePath(String(dirPath ?? "").trim());
  if (!p) return;
  const parts = p.split("/").filter(Boolean);
  let cur = "";
  for (const seg of parts) {
    cur = cur ? `${cur}/${seg}` : seg;
    const ok = await app.vault.adapter.exists(cur);
    if (!ok) {
      try {
        await app.vault.createFolder(cur);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (msg.includes("Folder already exists") || msg.includes("EEXIST")) continue;
        throw e;
      }
    }
  }
}

/**
 * 将当前主索引中该联系人的条目写入 `<contactsDir>/.contacts/<uid>.json`（schema_version 2：`entries` 含 source_type、source_block_id、follow_association_type 等与主索引对齐字段）。
 * - `display_last_at`：与侧栏/6.7.1 相同口径（仅事件 `occurred_at` 的最大值）。
 * 失败仅 console.warn，不抛错。
 */
function toReplicaEntry(e: ContactsInteractionEntry): ContactsReplicaFirstShardEntry {
  const st = String(e.source_type ?? "other").trim() as ContactsReplicaFirstShardEntry["source_type"];
  const out: ContactsReplicaFirstShardEntry = {
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
  const evs = e.interaction_events;
  if (Array.isArray(evs) && evs.length > 0) out.interaction_events = evs.slice();
  return out;
}

export async function writeContactsInteractionReplicaSnapshot(
  app: App,
  args: {
    contactsDir: string;
    contactUid: string;
    getInteractionsStore: () => ContactsInteractionsStore;
  }
): Promise<void> {
  const uid = String(args.contactUid ?? "").trim();
  if (!uid) return;
  const root = normalizePath(String(args.contactsDir ?? "").trim() || "90-Contacts");
  const dir = normalizePath(`${root}/.contacts`);
  try {
    const st = args.getInteractionsStore();
    const idx = await st.readIndex();
    const entries = (idx.by_contact_uid[uid] ?? []).slice() as ContactsInteractionEntry[];
    const replica: ContactsReplicaFirstShardFile = {
      schema_version: 2,
      contact_uid: uid,
      updated_at: new Date().toISOString(),
      display_last_at: computeDisplayLastAtFromEntries(entries),
      entries: entries.map(toReplicaEntry),
    };
    await ensureFolderChain(app, dir);
    const safe = uid.replace(/[^a-zA-Z0-9_-]/g, "_");
    const path = normalizePath(`${dir}/${safe}.json`);
    await app.vault.adapter.write(path, JSON.stringify(replica, null, 2));
  } catch (e) {
    console.warn("[RSLatte][contacts][replica] write failed", e);
  }
}

/**
 * 按主索引 `by_contact_uid` 全量重写各联系人的 `.contacts/<uid>.json`。
 * 用于主索引已由任务/项目等写入、但副本尚未生成或过期时（例如仅「刷新联系人」而未再「记互动」）。
 */
export async function syncAllContactsInteractionReplicasFromStore(
  app: App,
  args: {
    contactsDir: string;
    getInteractionsStore: () => ContactsInteractionsStore;
  }
): Promise<void> {
  try {
    const st = args.getInteractionsStore();
    const idx = await st.readIndex();
    const uids = Object.keys(idx.by_contact_uid ?? {}).filter((u) => String(u ?? "").trim().length > 0);
    for (const uid of uids) {
      await writeContactsInteractionReplicaSnapshot(app, { ...args, contactUid: uid });
    }
  } catch (e) {
    console.warn("[RSLatte][contacts][replica] syncAll failed", e);
  }
}
