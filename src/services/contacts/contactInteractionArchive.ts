import type { App } from "obsidian";
import { normalizePath } from "obsidian";
import type { ContactInteractionArchiveEventRecord, ContactInteractionEvent } from "../../contactsRSLatte/types";
import { toIsoNow } from "../../taskRSLatte/utils";

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

function safeUidFilePart(uid: string): string {
  return String(uid ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown";
}

export type ContactInteractionArchiveManifest = {
  schema_version: 1;
  contact_uid: string;
  updated_at: string;
  /** 溢出归档分片文件名；全量读取：首片 `<uid>.json` 窗口 ∪ 按本数组顺序读各分片 */
  archive_shard_files: string[];
};

/** 分片文件：schema_version 2 使用 `records`（与首片条目对齐的来源字段 + 单条 event） */
export type ContactInteractionArchiveShardFile = {
  schema_version: 2;
  contact_uid: string;
  shard_index: number;
  updated_at: string;
  records: ContactInteractionArchiveEventRecord[];
};

function utf8ByteLength(s: string): number {
  try {
    return new TextEncoder().encode(s).length;
  } catch {
    return s.length;
  }
}

function ms(iso: string | undefined): number {
  const t = Date.parse(String(iso ?? ""));
  return Number.isNaN(t) ? 0 : t;
}

export function shardFileNameForIndex(safe: string, index: number): string {
  return `${safe}_${String(index).padStart(3, "0")}.json`;
}

/** 将 v1 仅含 events 的分片转为 v2 records（无来源信息时占位） */
function migrateV1EventsToRecords(
  contactUid: string,
  events: ContactInteractionEvent[]
): ContactInteractionArchiveEventRecord[] {
  return (events ?? []).map((ev) => ({
    source_path: "",
    source_type: "other",
    event: ev,
  }));
}

function normalizeShardFromDisk(
  uid: string,
  shardIndex: number,
  o: any
): ContactInteractionArchiveShardFile {
  if (o && o.schema_version === 2 && Array.isArray(o.records)) {
    return {
      schema_version: 2,
      contact_uid: String(o.contact_uid ?? uid),
      shard_index: Number(o.shard_index ?? shardIndex) || shardIndex,
      updated_at: String(o.updated_at ?? ""),
      records: o.records as ContactInteractionArchiveEventRecord[],
    };
  }
  if (o && o.schema_version === 1 && Array.isArray(o.events)) {
    return {
      schema_version: 2,
      contact_uid: String(o.contact_uid ?? uid),
      shard_index: Number(o.shard_index ?? shardIndex) || shardIndex,
      updated_at: String(o.updated_at ?? ""),
      records: migrateV1EventsToRecords(uid, o.events as ContactInteractionEvent[]),
    };
  }
  return {
    schema_version: 2,
    contact_uid: uid,
    shard_index: shardIndex,
    updated_at: toIsoNow(),
    records: [],
  };
}

/**
 * 将裁出主索引窗口的互动记录追加到 `.contacts/<safe>_NNN.json`，并维护 `.contacts/<safe>.manifest.json`。
 */
export async function appendContactInteractionOverflowArchive(
  app: App,
  args: {
    contactsDir: string;
    contactUid: string;
    records: ContactInteractionArchiveEventRecord[];
    maxShardBytes: number;
  }
): Promise<void> {
  const uid = String(args.contactUid ?? "").trim();
  const queue = [...(args.records ?? [])]
    .filter((r) => r && r.event && String(r.event.occurred_at ?? "").trim())
    .sort((a, b) => ms(a.event.occurred_at) - ms(b.event.occurred_at));
  if (!uid || queue.length === 0) return;

  const root = normalizePath(String(args.contactsDir ?? "").trim() || "90-Contacts");
  const dir = normalizePath(`${root}/.contacts`);
  const safe = safeUidFilePart(uid);
  const maxB = Math.max(4096, Math.min(20 * 1024 * 1024, Number(args.maxShardBytes ?? 1048576) || 1048576));

  await ensureFolderChain(app, dir);

  const manifestPath = normalizePath(`${dir}/${safe}.manifest.json`);

  let manifest: ContactInteractionArchiveManifest = {
    schema_version: 1,
    contact_uid: uid,
    updated_at: toIsoNow(),
    archive_shard_files: [],
  };
  try {
    if (await app.vault.adapter.exists(manifestPath)) {
      const raw = await app.vault.adapter.read(manifestPath);
      const parsed = JSON.parse(raw || "{}");
      if (parsed && parsed.schema_version === 1 && Array.isArray(parsed.archive_shard_files)) {
        manifest = {
          schema_version: 1,
          contact_uid: String(parsed.contact_uid ?? uid),
          updated_at: String(parsed.updated_at ?? ""),
          archive_shard_files: parsed.archive_shard_files.map((x: any) => String(x ?? "").trim()).filter(Boolean),
        };
      }
    }
  } catch {
    // fresh
  }

  const readShard = async (fileName: string): Promise<ContactInteractionArchiveShardFile> => {
    const p = normalizePath(`${dir}/${fileName}`);
    const m = fileName.match(/_(\d{3})\.json$/);
    const idx = m ? Number(m[1]) : 1;
    try {
      if (await app.vault.adapter.exists(p)) {
        const raw = await app.vault.adapter.read(p);
        const o = JSON.parse(raw || "{}");
        return normalizeShardFromDisk(uid, idx, o);
      }
    } catch {
      // ignore
    }
    return {
      schema_version: 2,
      contact_uid: uid,
      shard_index: idx,
      updated_at: toIsoNow(),
      records: [],
    };
  };

  const writeShard = async (fileName: string, shard: ContactInteractionArchiveShardFile): Promise<void> => {
    const p = normalizePath(`${dir}/${fileName}`);
    const out: ContactInteractionArchiveShardFile = { ...shard, updated_at: toIsoNow() };
    await app.vault.adapter.write(p, JSON.stringify(out, null, 2));
    if (!manifest.archive_shard_files.includes(fileName)) manifest.archive_shard_files.push(fileName);
  };

  let shardIndex =
    manifest.archive_shard_files.length > 0
      ? Math.max(
          ...manifest.archive_shard_files.map((fn) => {
            const m = fn.match(/_(\d{3})\.json$/);
            return m ? Number(m[1]) : 0;
          })
        )
      : 0;
  if (shardIndex < 1) shardIndex = 1;

  let fileName = manifest.archive_shard_files.length > 0 ? manifest.archive_shard_files[manifest.archive_shard_files.length - 1]! : shardFileNameForIndex(safe, shardIndex);
  let shard = await readShard(fileName);

  while (queue.length > 0) {
    const row = queue[0]!;
    const trial: ContactInteractionArchiveShardFile = {
      ...shard,
      records: [...(shard.records ?? []), row],
      updated_at: toIsoNow(),
    };
    const sz = utf8ByteLength(JSON.stringify(trial, null, 2));

    if (sz > maxB && (shard.records?.length ?? 0) > 0) {
      await writeShard(fileName, shard);
      shardIndex += 1;
      fileName = shardFileNameForIndex(safe, shardIndex);
      shard = {
        schema_version: 2,
        contact_uid: uid,
        shard_index: shardIndex,
        updated_at: toIsoNow(),
        records: [],
      };
      continue;
    }
    if (sz > maxB && (shard.records?.length ?? 0) === 0) {
      shard = trial;
      queue.shift();
      await writeShard(fileName, shard);
      shardIndex += 1;
      fileName = shardFileNameForIndex(safe, shardIndex);
      shard = {
        schema_version: 2,
        contact_uid: uid,
        shard_index: shardIndex,
        updated_at: toIsoNow(),
        records: [],
      };
      continue;
    }
    shard = trial;
    queue.shift();
  }

  if ((shard.records?.length ?? 0) > 0) {
    await writeShard(fileName, shard);
  }

  manifest.updated_at = toIsoNow();
  manifest.contact_uid = uid;
  await app.vault.adapter.write(manifestPath, JSON.stringify(manifest, null, 2));
}
