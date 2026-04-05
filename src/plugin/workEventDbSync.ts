import { normalizePath } from "obsidian";

import type RSLattePlugin from "../main";
import type { UpsertWorkEventReq } from "../api";
import { resolveSpaceBaseDir, resolveSpaceStatsDir } from "../services/space/spaceContext";
import type { WorkEvent } from "../services/workEventService";

const BATCH = 100;
const MAX_MONTHS = 36;

type ShardState = { linesConsumed: number };
type SyncStateFile = { shards: Record<string, ShardState> };

function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return hash >>> 0;
}

/** 无 event_id 的历史行：用内容确定性哈希（与行序无关） */
export function deriveStableWorkEventId(ev: WorkEvent): string {
  const existing = String((ev as any)?.event_id ?? "").trim();
  if (existing) return existing;
  const stable = JSON.stringify({
    ts: ev.ts,
    kind: ev.kind,
    action: ev.action,
    source: ev.source ?? "",
    summary: ev.summary ?? "",
    ref: ev.ref ?? null,
    metrics: ev.metrics ?? null,
  });
  return `dg:${djb2(stable).toString(16)}`;
}

function workEventToUpsert(ev: WorkEvent): UpsertWorkEventReq {
  const event_id = deriveStableWorkEventId(ev);
  const payload: Record<string, unknown> = {
    ts: ev.ts,
    kind: ev.kind,
    action: ev.action,
    ref: ev.ref ?? undefined,
    summary: ev.summary,
    metrics: ev.metrics,
    source: ev.source,
    event_id,
    spaceId: (ev as any).spaceId,
  };
  return {
    event_id,
    ts: String(ev.ts ?? ""),
    kind: String(ev.kind ?? ""),
    action: String(ev.action ?? ""),
    source: ev.source ? String(ev.source) : undefined,
    summary: ev.summary != null ? String(ev.summary) : undefined,
    payload,
  };
}

function resolveShardPathForSpace(
  settings: unknown,
  spaceId: string,
  monthKey: string
): string {
  const s: any = settings as any;
  const base = resolveSpaceBaseDir(s as any, spaceId);
  const rel = String(s?.workEventRelPath ?? ".events/work-events.jsonl").trim() || ".events/work-events.jsonl";
  const legacy = normalizePath(`${base}/${rel}`);
  const parts = legacy.split("/").filter(Boolean);
  const file = parts.pop() ?? "work-events.jsonl";
  const dir = parts.join("/");
  const prefix = String(file).replace(/\.jsonl$/i, "") || "work-events";
  return normalizePath(`${dir}/${prefix}-${monthKey}.jsonl`);
}

function syncStatePath(settings: unknown, spaceId: string): string {
  return normalizePath(`${resolveSpaceStatsDir(settings as any, spaceId)}/work-event-db-sync.json`);
}

function toMonthKeyFromDate(d: Date): string {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const mm = m < 10 ? `0${m}` : String(m);
  return `${y}${mm}`;
}

function listMonthKeys(maxMonths: number): string[] {
  const keys: string[] = [];
  const cur = new Date();
  for (let i = 0; i < maxMonths; i++) {
    const d = new Date(cur.getFullYear(), cur.getMonth() - i, 15);
    keys.push(toMonthKeyFromDate(d));
  }
  return keys;
}

async function readTextFile(plugin: RSLattePlugin, path: string): Promise<string> {
  const adapter: any = plugin.app.vault.adapter as any;
  try {
    if (typeof adapter?.exists === "function") {
      const ex = await adapter.exists(path);
      if (!ex) return "";
    }
    if (typeof adapter?.read === "function") return await adapter.read(path);
  } catch {
    /* ignore */
  }
  return "";
}

async function readSyncState(plugin: RSLattePlugin, spaceId: string): Promise<SyncStateFile> {
  const p = syncStatePath(plugin.settings, spaceId);
  try {
    const raw = await readTextFile(plugin, p);
    if (!raw.trim()) return { shards: {} };
    const j = JSON.parse(raw) as SyncStateFile;
    if (j && typeof j === "object" && j.shards && typeof j.shards === "object") return j;
  } catch {
    /* ignore */
  }
  return { shards: {} };
}

async function writeSyncState(plugin: RSLattePlugin, spaceId: string, state: SyncStateFile): Promise<void> {
  const p = syncStatePath(plugin.settings, spaceId);
  const adapter: any = plugin.app.vault.adapter as any;
  try {
    const dir = p.split("/").slice(0, -1).join("/");
    if (dir && adapter?.mkdir) await adapter.mkdir(dir);
    if (typeof adapter?.write === "function") await adapter.write(p, JSON.stringify(state, null, 2));
  } catch {
    /* ignore */
  }
}

export function createWorkEventDbSync(plugin: RSLattePlugin) {
  return {
    /**
     * 将当前空间 JSONL 中尚未同步的行批量 upsert 到后端（与本地双写；非实时，由自动刷新 tick 触发）。
     */
    async syncWorkEventsToDbForSpace(spaceId: string, opts?: { reason?: string }): Promise<void> {
      try {
        if ((plugin as any).isWorkEventDbSyncEnabled?.() !== true) return;
      } catch {
        return;
      }
      if (!(plugin as any).workEventSvc?.isEnabled?.()) return;

      const vaultOk = await (plugin as any).vaultSvc?.ensureVaultReadySafe?.("syncWorkEventsToDb");
      if (!vaultOk) return;
      const db = await (plugin as any).vaultSvc?.checkDbReadySafe?.("syncWorkEventsToDb");
      if (!db?.ok) return;

      const api = (plugin as any).api;
      if (!api?.upsertWorkEventsBatch) return;

      const sid = String(spaceId || "").trim() || (plugin as any).getCurrentSpaceId?.();
      const prevSpace = api.getSpaceId?.() ?? (plugin as any).getCurrentSpaceId?.();
      try {
        api.setSpaceId(sid);
      } catch {
        return;
      }

      let state = await readSyncState(plugin, sid);
      const monthKeys = listMonthKeys(MAX_MONTHS);
      let anyFailed = false;

      try {
        for (const monthKey of monthKeys) {
          const shardPath = resolveShardPathForSpace(plugin.settings, sid, monthKey);
          const content = await readTextFile(plugin, shardPath);
          const lines = content.split("\n").map((x) => x.trim()).filter(Boolean);
          let consumed = state.shards[monthKey]?.linesConsumed ?? 0;
          if (consumed > lines.length) consumed = 0;
          if (consumed === lines.length) continue;

          const slice = lines.slice(consumed);
          const items: UpsertWorkEventReq[] = [];
          for (const line of slice) {
            try {
              const ev = JSON.parse(line) as WorkEvent;
              if (ev && ev.ts && ev.kind && ev.action) items.push(workEventToUpsert(ev));
            } catch {
              /* skip bad line */
            }
          }

          for (let i = 0; i < items.length; i += BATCH) {
            const batch = items.slice(i, i + BATCH);
            if (batch.length === 0) continue;
            try {
              const resp: any = await api.upsertWorkEventsBatch({ items: batch });
              const failed = Number(resp?.failed ?? 0);
              if (failed > 0) {
                anyFailed = true;
                break;
              }
            } catch (e) {
              console.warn("[RSLatte][workEventDb] upsertWorkEventsBatch failed", e);
              anyFailed = true;
              break;
            }
          }

          if (anyFailed) break;

          state = {
            ...state,
            shards: { ...state.shards, [monthKey]: { linesConsumed: lines.length } },
          };
          await writeSyncState(plugin, sid, state);
        }
      } finally {
        try {
          api.setSpaceId(prevSpace);
        } catch {
          /* ignore */
        }
      }

      if (opts?.reason && plugin.isDebugLogEnabled?.()) {
        plugin.dbg("workEventDb", "sync_done", { spaceId: sid, failed: anyFailed });
      }
    },
  };
}
