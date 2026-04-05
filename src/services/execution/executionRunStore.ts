import { normalizePath, type App } from "obsidian";
import type RSLattePlugin from "../../main";
import type { ExecutionFlowRunRecord } from "../../types/executionFlowTypes";

type ExecutionRunStoreFile = {
  version: 1;
  updatedAt: string;
  runs: Record<string, ExecutionFlowRunRecord>;
};

const STORE_FILE_NAME = "execution-run-store.json";
const STORE_VERSION = 1 as const;

function nowIso(): string {
  return new Date().toISOString();
}

async function ensureFolder(app: App, path: string): Promise<void> {
  const p = normalizePath(path);
  if (!p) return;
  if (await app.vault.adapter.exists(p)) return;
  const parts = p.split("/").filter(Boolean);
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    if (!(await app.vault.adapter.exists(cur))) await app.vault.adapter.mkdir(cur);
  }
}

function resolveExecutionStoreDir(plugin: RSLattePlugin): string {
  const fromTaskStore = String((plugin as any)?.taskRSLatte?.store?.getBaseDir?.() ?? "").trim();
  if (fromTaskStore) return normalizePath(fromTaskStore);
  const fromCentral = String((plugin as any)?.settings?.centralIndexDir ?? "").trim();
  if (fromCentral) return normalizePath(fromCentral);
  const fromLegacy = String((plugin as any)?.settings?.taskPanel?.rslatteIndexDir ?? "").trim();
  if (fromLegacy) return normalizePath(fromLegacy);
  return "00-System/.rslatte";
}

function getStorePath(plugin: RSLattePlugin): string {
  return normalizePath(`${resolveExecutionStoreDir(plugin)}/${STORE_FILE_NAME}`);
}

async function readStore(plugin: RSLattePlugin): Promise<ExecutionRunStoreFile> {
  const p = getStorePath(plugin);
  try {
    if (!(await plugin.app.vault.adapter.exists(p))) {
      return { version: STORE_VERSION, updatedAt: nowIso(), runs: {} };
    }
    const raw = await plugin.app.vault.adapter.read(p);
    const parsed = raw ? (JSON.parse(raw) as Partial<ExecutionRunStoreFile>) : {};
    return {
      version: STORE_VERSION,
      updatedAt: String(parsed.updatedAt ?? nowIso()),
      runs: (parsed.runs ?? {}) as Record<string, ExecutionFlowRunRecord>,
    };
  } catch (e) {
    console.warn("[RSLatte][execution] read run store failed, fallback empty", e);
    return { version: STORE_VERSION, updatedAt: nowIso(), runs: {} };
  }
}

async function writeStore(plugin: RSLattePlugin, store: ExecutionRunStoreFile): Promise<void> {
  const p = getStorePath(plugin);
  const dir = normalizePath(p.split("/").slice(0, -1).join("/"));
  await ensureFolder(plugin.app, dir);
  await plugin.app.vault.adapter.write(
    p,
    JSON.stringify(
      {
        version: STORE_VERSION,
        updatedAt: nowIso(),
        runs: store.runs ?? {},
      },
      null,
      2
    )
  );
}

export async function getExecutionRunRecord(
  plugin: RSLattePlugin,
  clientOpId?: string
): Promise<ExecutionFlowRunRecord | null> {
  const opId = String(clientOpId ?? "").trim();
  if (!opId) return null;
  const store = await readStore(plugin);
  return (store.runs?.[opId] ?? null) as ExecutionFlowRunRecord | null;
}

export async function upsertExecutionRunRecord(
  plugin: RSLattePlugin,
  record: ExecutionFlowRunRecord
): Promise<void> {
  const opId = String(record.clientOpId ?? "").trim();
  if (!opId) return;
  const store = await readStore(plugin);
  store.runs[opId] = {
    ...record,
    updatedAt: nowIso(),
  };
  await writeStore(plugin, store);
}

export { resolveExecutionStoreDir, getStorePath as getExecutionRunStorePath };
