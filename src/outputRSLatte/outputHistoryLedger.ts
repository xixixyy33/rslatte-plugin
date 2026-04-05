/**
 * 输出发布/召回/索引归档等事件的 **台账**（各 `archiveRoots` 归属根下 `.history/output-ledger.json`）。
 *
 * @see `types/outputTypes.ts` 文件头 §8.4（物理扫描 vs 台账合并）
 * @see `docs/V2改造方案/10-索引优化方案.md` §10.6
 */
import { App, normalizePath, TFile } from "obsidian";

import type RSLattePlugin from "../main";
import type { RSLattePluginSettings } from "../types/settings";
import type {
  OutputLedgerFileV1,
  OutputLedgerKnowledgeEntry,
  OutputLedgerSourcePathEntry,
  OutputHistoryEvent,
} from "../types/outputHistoryTypes";
import {
  OUTPUT_HISTORY_DIR,
  OUTPUT_LEDGER_FILE,
  OUTPUT_LEDGER_VERSION,
} from "../types/outputHistoryTypes";

function emptyLedger(): OutputLedgerFileV1 {
  return { version: OUTPUT_LEDGER_VERSION, byKnowledgePath: {}, bySourceOutputPath: {} };
}

/** 与台账内 knowledge_path / 源路径键一致的去前缀规范化（供 UI 侧比对） */
export function canonicalLedgerPathKey(v: string): string {
  return normalizePath(String(v ?? "").trim().replace(/^(\.\/)+/, "").replace(/^\/+/, ""));
}
function canonicalVaultPath(v: string): string {
  return canonicalLedgerPathKey(v);
}

function pathCandidates(path: string): string[] {
  const raw = String(path ?? "").trim();
  const norm = canonicalVaultPath(raw);
  const set = new Set<string>();
  const push = (v: string) => {
    const s = String(v ?? "").trim();
    if (s) set.add(s);
  };
  push(raw);
  push(norm);
  push(raw.replace(/^(\.\/)+/, ""));
  push(raw.replace(/^\/+/, ""));
  if (norm) {
    push(`./${norm}`);
    push(`/${norm}`);
  }
  return [...set];
}

function getFileByAnyPath(app: App, path: string): TFile | null {
  for (const p of pathCandidates(path)) {
    const af = app.vault.getAbstractFileByPath(p);
    if (af instanceof TFile) return af;
  }
  return null;
}

function parseEvents(raw: unknown): OutputHistoryEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x) => x && typeof x === "object")
    .map((x) => x as OutputHistoryEvent)
    .filter((ev) => typeof ev.ts === "string" && typeof ev.action === "string");
}

function eventDedupKey(ev: OutputHistoryEvent): string {
  return [
    ev.ts ?? "",
    ev.action ?? "",
    ev.knowledge_path ?? "",
    ev.source_output_path ?? "",
    ev.output_id ?? "",
    ev.copied_from_output_id ?? "",
    ev.mode ?? "",
    ev.knowledge_bucket ?? "",
    ev.archive_month_key ?? "",
    ev.note ?? "",
    ev.status_before ?? "",
    ev.status_after ?? "",
    ev.resume_at ?? "",
  ].join("||");
}

function mergeEventsDedup(a: OutputHistoryEvent[], b: OutputHistoryEvent[]): OutputHistoryEvent[] {
  const out = new Map<string, OutputHistoryEvent>();
  for (const ev of [...(a ?? []), ...(b ?? [])]) out.set(eventDedupKey(ev), ev);
  return [...out.values()].sort((x, y) => String(x.ts).localeCompare(String(y.ts)));
}

function coerceSourcePathMap(raw: unknown): Record<string, OutputLedgerSourcePathEntry> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, OutputLedgerSourcePathEntry> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const e = v as Record<string, unknown>;
    out[normalizePath(k)] = {
      output_id: typeof e.output_id === "string" ? e.output_id : undefined,
      events: parseEvents(e.events),
    };
  }
  return out;
}

function coerceLedger(raw: unknown): OutputLedgerFileV1 {
  if (!raw || typeof raw !== "object") return emptyLedger();
  const o = raw as Record<string, unknown>;
  if (o.version !== OUTPUT_LEDGER_VERSION) return emptyLedger();
  const by = o.byKnowledgePath;
  const bySource = coerceSourcePathMap(o.bySourceOutputPath);
  const updated_at = typeof o.updated_at === "string" ? o.updated_at : undefined;
  if (!by || typeof by !== "object") {
    return {
      version: OUTPUT_LEDGER_VERSION,
      updated_at,
      byKnowledgePath: {},
      bySourceOutputPath: bySource,
    };
  }
  const byKnowledgePath: Record<string, OutputLedgerKnowledgeEntry> = {};
  for (const [k, v] of Object.entries(by as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const e = v as Record<string, unknown>;
    const events = parseEvents(e.events);
    byKnowledgePath[normalizePath(k)] = {
      output_id: typeof e.output_id === "string" ? e.output_id : undefined,
      last_source_output_path:
        typeof e.last_source_output_path === "string" ? e.last_source_output_path : undefined,
      last_knowledge_path: typeof e.last_knowledge_path === "string" ? e.last_knowledge_path : undefined,
      last_published_at: typeof e.last_published_at === "string" ? e.last_published_at : undefined,
      last_bucket: typeof e.last_bucket === "string" ? e.last_bucket : undefined,
      events,
    };
  }
  return {
    version: OUTPUT_LEDGER_VERSION,
    updated_at,
    byKnowledgePath,
    bySourceOutputPath: bySource,
  };
}

export function ledgerFilePathForArchiveRoot(archiveRootRel: string): string {
  const r = canonicalVaultPath(archiveRootRel);
  return canonicalVaultPath(`${r}/${OUTPUT_HISTORY_DIR}/${OUTPUT_LEDGER_FILE}`);
}

function normalizeArchiveRoots(settings: RSLattePluginSettings): string[] {
  const raw = settings.outputPanel?.archiveRoots;
  if (!Array.isArray(raw) || !raw.length) return ["10-Personal/12-Notes"];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of raw) {
    const p = canonicalVaultPath(String(x ?? "").trim());
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.length ? out : ["10-Personal/12-Notes"];
}

/** 选取「源输出路径」归属的存档根：最长前缀匹配，否则第一个根 */
export function pickArchiveRootForOutputPath(
  archiveRoots: string[],
  sourceOutputPath: string,
): string | null {
  const norm = canonicalVaultPath(String(sourceOutputPath ?? "").trim());
  if (!norm) return null;
  const sorted = [...archiveRoots].map((x) => canonicalVaultPath(x)).sort((a, b) => b.length - a.length);
  for (const r of sorted) {
    if (norm === r || norm.startsWith(`${r}/`)) return r;
  }
  return sorted[0] ?? null;
}

async function readLedgerFile(app: App, path: string): Promise<OutputLedgerFileV1> {
  const p = canonicalVaultPath(path);
  const f = getFileByAnyPath(app, p);
  try {
    let raw = "";
    if (f instanceof TFile) {
      raw = await app.vault.read(f);
    } else {
      const adapter: any = app.vault.adapter as any;
      if (!adapter?.exists || !(await adapter.exists(p))) return emptyLedger();
      raw = String(await adapter.read(p));
    }
    return coerceLedger(JSON.parse(raw));
  } catch (e) {
    console.warn("RSLatte outputHistoryLedger read failed:", p, e);
    return emptyLedger();
  }
}

async function persistLedger(plugin: RSLattePlugin, ledgerPath: string, ledger: OutputLedgerFileV1): Promise<void> {
  await plugin.ensureDirForPath(ledgerPath);
  const p = canonicalVaultPath(ledgerPath);
  // 并发保护：每次落盘前先读取磁盘最新版本并做并集合并，避免后写覆盖先写。
  const latest = await readLedgerFile(plugin.app, p);
  const mergedKn = mergeLedgerFiles([latest, ledger]);
  const mergedSrc = mergeSourcePathLedgerFiles([latest, ledger]);
  const merged: OutputLedgerFileV1 = {
    version: OUTPUT_LEDGER_VERSION,
    updated_at: ledger.updated_at ?? latest.updated_at,
    byKnowledgePath: Object.fromEntries(mergedKn.entries()),
    bySourceOutputPath: Object.fromEntries(mergedSrc.entries()),
  };
  const json = JSON.stringify(merged, null, 2);
  const f = getFileByAnyPath(plugin.app, p);
  if (f instanceof TFile) {
    await plugin.app.vault.modify(f, json);
    return;
  }
  const adapter: any = plugin.app.vault.adapter as any;
  if (adapter?.write) {
    try {
      // 隐藏目录（如 .history）可能未进入 Vault 索引：直接走 adapter 写入更稳。
      await adapter.write(p, json);
      return;
    } catch {
      // fallback to vault.create below
    }
  }
  try {
    await plugin.app.vault.create(p, json);
  } catch (e: any) {
    // 兼容并发/索引延迟：同一时刻其他流程已创建该文件时，回退为 modify
    const msg = String(e?.message ?? e ?? "");
    if (!/already exists/i.test(msg)) throw e;
    for (let i = 0; i < 8; i++) {
      const hit = getFileByAnyPath(plugin.app, p);
      if (hit instanceof TFile) {
        await plugin.app.vault.modify(hit, json);
        return;
      }
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
    if (adapter?.write) {
      try {
        await adapter.write(p, json);
        return;
      } catch {
        // ignore
      }
    }
    // 缓存仍未命中时不再抛错，避免控制台噪声；后续事件会继续尝试落盘
    return;
  }
}

function mergeLedgerFiles(files: OutputLedgerFileV1[]): Map<string, OutputLedgerKnowledgeEntry> {
  const out = new Map<string, OutputLedgerKnowledgeEntry>();
  for (const file of files) {
    for (const [rawPath, ent] of Object.entries(file.byKnowledgePath ?? {})) {
      const p = normalizePath(rawPath);
      const prev = out.get(p);
      if (!prev) {
        out.set(p, {
          ...ent,
          events: mergeEventsDedup([], ent.events ?? []),
        });
      } else {
        const mergedEvents = mergeEventsDedup(prev.events ?? [], ent.events ?? []);
        out.set(p, {
          output_id: ent.output_id ?? prev.output_id,
          last_source_output_path: ent.last_source_output_path ?? prev.last_source_output_path,
          last_knowledge_path: ent.last_knowledge_path ?? prev.last_knowledge_path,
          last_published_at: ent.last_published_at ?? prev.last_published_at,
          last_bucket: ent.last_bucket ?? prev.last_bucket,
          events: mergedEvents,
        });
      }
    }
  }
  return out;
}

function mergeSourcePathLedgerFiles(files: OutputLedgerFileV1[]): Map<string, OutputLedgerSourcePathEntry> {
  const out = new Map<string, OutputLedgerSourcePathEntry>();
  for (const file of files) {
    for (const [rawPath, ent] of Object.entries(file.bySourceOutputPath ?? {})) {
      const p = normalizePath(rawPath);
      const prev = out.get(p);
      if (!prev) {
        out.set(p, { output_id: ent.output_id, events: mergeEventsDedup([], ent.events ?? []) });
      } else {
        const mergedEvents = mergeEventsDedup(prev.events ?? [], ent.events ?? []);
        out.set(p, {
          output_id: ent.output_id ?? prev.output_id,
          events: mergedEvents,
        });
      }
    }
  }
  return out;
}

/** 合并所有存档根下台账：知识路径 + 源输出路径 */
export async function readMergedOutputLedgerMaps(
  app: App,
  settings: RSLattePluginSettings,
): Promise<{
  byKnowledgePath: Map<string, OutputLedgerKnowledgeEntry>;
  bySourceOutputPath: Map<string, OutputLedgerSourcePathEntry>;
}> {
  const roots = normalizeArchiveRoots(settings);
  if (!roots.length) {
    return { byKnowledgePath: new Map(), bySourceOutputPath: new Map() };
  }
  const files = await Promise.all(roots.map((r) => readLedgerFile(app, ledgerFilePathForArchiveRoot(r))));
  return {
    byKnowledgePath: mergeLedgerFiles(files),
    bySourceOutputPath: mergeSourcePathLedgerFiles(files),
  };
}

/** 合并所有存档根下 `.history/output-ledger.json`，按知识库 vault 路径索引 */
export async function readMergedOutputLedgerByKnowledgePath(
  app: App,
  settings: RSLattePluginSettings,
): Promise<Map<string, OutputLedgerKnowledgeEntry>> {
  const m = await readMergedOutputLedgerMaps(app, settings);
  return m.byKnowledgePath;
}

const SNAPSHOT_FM_KEYS = [
  "output_id",
  "project_id",
  "project_name",
  "projectId",
  "projectName",
  "status",
  "doc_category",
  "文档分类",
  "type",
  "tags",
  "create",
  "domains",
  "领域",
  "output_document_kind",
] as const;

export function pickPrePublishFmSnapshot(srcFm: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of SNAPSHOT_FM_KEYS) {
    const v = srcFm[k];
    if (v !== undefined && v !== null && v !== "") o[k] = v;
  }
  return o;
}

/**
 * 发布到知识库成功后写入台账（单存档根文件，与源输出路径归属的根一致）。
 */
export async function appendPublishToKnowledgeLedgerEvent(
  plugin: RSLattePlugin,
  opts: {
    destKnowledgePath: string;
    sourceOutputPath: string;
    publishedAtIso: string;
    bucket: string;
    mode: "move" | "copy";
    srcFm: Record<string, unknown>;
    outputIdOverride?: string;
  },
): Promise<void> {
  const roots = normalizeArchiveRoots(plugin.settings);
  if (!roots.length) return;

  const root = pickArchiveRootForOutputPath(roots, opts.sourceOutputPath);
  if (!root) return;

  const ledgerPath = ledgerFilePathForArchiveRoot(root);
  const kPath = canonicalVaultPath(opts.destKnowledgePath);

  let ledger = await readLedgerFile(plugin.app, ledgerPath);
  const oidRaw = opts.outputIdOverride ?? opts.srcFm.output_id;
  const outputId = oidRaw !== undefined && oidRaw !== null ? String(oidRaw).trim() : "";

  const srcOid =
    opts.srcFm.output_id !== undefined && opts.srcFm.output_id !== null
      ? String(opts.srcFm.output_id).trim()
      : "";
  const ev: OutputHistoryEvent = {
    ts: opts.publishedAtIso,
    action: "publish_to_knowledge",
    knowledge_path: kPath,
    source_output_path: canonicalVaultPath(opts.sourceOutputPath),
    output_id: outputId || undefined,
    copied_from_output_id:
      opts.mode === "copy" && outputId && srcOid && srcOid !== outputId ? srcOid : undefined,
    knowledge_bucket: opts.bucket,
    mode: opts.mode,
    pre_publish_fm_snapshot: pickPrePublishFmSnapshot(opts.srcFm),
  };

  const prev = ledger.byKnowledgePath[kPath] ?? { events: [] };
  const nextEntry: OutputLedgerKnowledgeEntry = {
    output_id: outputId || prev.output_id,
    last_source_output_path: canonicalVaultPath(opts.sourceOutputPath),
    last_knowledge_path: kPath,
    last_published_at: opts.publishedAtIso,
    last_bucket: opts.bucket,
    events: [...(prev.events ?? []), ev],
  };
  const srcPath = canonicalVaultPath(opts.sourceOutputPath);
  const prevSrc = ledger.bySourceOutputPath?.[srcPath] ?? { events: [] };
  const nextSrcEntry: OutputLedgerSourcePathEntry = {
    output_id: outputId || prevSrc.output_id,
    events: [...(prevSrc.events ?? []), ev],
  };

  ledger = {
    version: OUTPUT_LEDGER_VERSION,
    updated_at: opts.publishedAtIso,
    byKnowledgePath: { ...ledger.byKnowledgePath, [kPath]: nextEntry },
    bySourceOutputPath: { ...(ledger.bySourceOutputPath ?? {}), [srcPath]: nextSrcEntry },
  };

  try {
    await persistLedger(plugin, ledgerPath, ledger);
  } catch (e) {
    console.error("RSLatte appendPublishToKnowledgeLedgerEvent failed:", e);
  }
}

/**
 * 从知识库打回输出成功后追加台账事件（与源知识路径 `byKnowledgePath` 对齐）。
 */
export async function appendRecallFromKnowledgeLedgerEvent(
  plugin: RSLattePlugin,
  opts: {
    sourceKnowledgePath: string;
    destOutputPath: string;
    tsIso: string;
    mode: "move" | "copy";
    outputId?: string;
  },
): Promise<void> {
  const roots = normalizeArchiveRoots(plugin.settings);
  if (!roots.length) return;
  const root = pickArchiveRootForOutputPath(roots, opts.destOutputPath);
  if (!root) return;

  const ledgerPath = ledgerFilePathForArchiveRoot(root);
  const kPath = canonicalVaultPath(opts.sourceKnowledgePath);

  let ledger = await readLedgerFile(plugin.app, ledgerPath);
  const prev = ledger.byKnowledgePath[kPath] ?? { events: [] };

  const ev: OutputHistoryEvent = {
    ts: opts.tsIso,
    action: "recall_from_knowledge",
    knowledge_path: kPath,
    source_output_path: canonicalVaultPath(opts.destOutputPath),
    output_id: opts.outputId,
    mode: opts.mode,
  };

  const nextEntry: OutputLedgerKnowledgeEntry = {
    output_id: opts.outputId ?? prev.output_id,
    last_source_output_path: canonicalVaultPath(opts.destOutputPath),
    last_knowledge_path: kPath,
    last_published_at: prev.last_published_at,
    last_bucket: prev.last_bucket,
    events: [...(prev.events ?? []), ev],
  };

  ledger = {
    version: OUTPUT_LEDGER_VERSION,
    updated_at: opts.tsIso,
    byKnowledgePath: { ...ledger.byKnowledgePath, [kPath]: nextEntry },
    bySourceOutputPath: { ...(ledger.bySourceOutputPath ?? {}) },
  };

  try {
    await persistLedger(plugin, ledgerPath, ledger);
  } catch (e) {
    console.error("RSLatte appendRecallFromKnowledgeLedgerEvent failed:", e);
  }
}

/** 新建输出稿成功后写入 `.history`（按源输出路径聚合） */
/**
 * 输出稿状态（含 waiting_until）变更后写入 bySourceOutputPath，供知识库「基础信息」按 output_id 关联展示。
 */
export async function appendOutputStatusChangedLedgerEvent(
  plugin: RSLattePlugin,
  opts: {
    sourceOutputPath: string;
    outputId?: string;
    tsIso: string;
    statusBefore: string;
    statusAfter: string;
    resumeAtYmd?: string;
    /** 与 work event 对齐的细分动作，如 start / paused */
    detail?: string;
  },
): Promise<void> {
  const roots = normalizeArchiveRoots(plugin.settings);
  if (!roots.length) return;
  const root = pickArchiveRootForOutputPath(roots, opts.sourceOutputPath);
  if (!root) return;

  const ledgerPath = ledgerFilePathForArchiveRoot(root);
  const oPath = canonicalVaultPath(opts.sourceOutputPath);
  let ledger = await readLedgerFile(plugin.app, ledgerPath);

  const prev = ledger.bySourceOutputPath?.[oPath] ?? { events: [] };
  const oid = String(opts.outputId ?? "").trim();
  const ev: OutputHistoryEvent = {
    ts: opts.tsIso,
    action: "output_status_changed",
    source_output_path: oPath,
    output_id: oid || undefined,
    status_before: opts.statusBefore || undefined,
    status_after: opts.statusAfter || undefined,
    resume_at: opts.resumeAtYmd?.trim() || undefined,
    note: opts.detail?.trim() || undefined,
  };
  const nextEntry: OutputLedgerSourcePathEntry = {
    output_id: oid || prev.output_id,
    events: [...(prev.events ?? []), ev],
  };

  ledger = {
    version: OUTPUT_LEDGER_VERSION,
    updated_at: opts.tsIso,
    byKnowledgePath: { ...ledger.byKnowledgePath },
    bySourceOutputPath: { ...(ledger.bySourceOutputPath ?? {}), [oPath]: nextEntry },
  };

  try {
    await persistLedger(plugin, ledgerPath, ledger);
  } catch (e) {
    console.error("RSLatte appendOutputStatusChangedLedgerEvent failed:", e);
  }
}

export async function appendOutputCreatedLedgerEvent(
  plugin: RSLattePlugin,
  opts: {
    sourceOutputPath: string;
    outputId: string;
    tsIso: string;
    origin?: "general" | "project";
  },
): Promise<void> {
  const roots = normalizeArchiveRoots(plugin.settings);
  if (!roots.length) return;
  const root = pickArchiveRootForOutputPath(roots, opts.sourceOutputPath);
  if (!root) return;

  const ledgerPath = ledgerFilePathForArchiveRoot(root);
  const oPath = canonicalVaultPath(opts.sourceOutputPath);
  let ledger = await readLedgerFile(plugin.app, ledgerPath);

  const prev = ledger.bySourceOutputPath?.[oPath] ?? { events: [] };
  const ev: OutputHistoryEvent = {
    ts: opts.tsIso,
    action: "output_created",
    source_output_path: oPath,
    output_id: opts.outputId,
    note: opts.origin === "project" ? "project_archive" : "general",
  };
  const nextEntry: OutputLedgerSourcePathEntry = {
    output_id: opts.outputId || prev.output_id,
    events: [...(prev.events ?? []), ev],
  };

  ledger = {
    version: OUTPUT_LEDGER_VERSION,
    updated_at: opts.tsIso,
    byKnowledgePath: { ...ledger.byKnowledgePath },
    bySourceOutputPath: { ...(ledger.bySourceOutputPath ?? {}), [oPath]: nextEntry },
  };

  try {
    await persistLedger(plugin, ledgerPath, ledger);
  } catch (e) {
    console.error("RSLatte appendOutputCreatedLedgerEvent failed:", e);
  }
}

/** 主索引将条目迁出至按月归档索引时写入 */
export async function appendOutputArchivedFromIndexLedgerEvent(
  plugin: RSLattePlugin,
  opts: {
    sourceOutputPath: string;
    outputId?: string;
    archiveMonthKey: string;
    tsIso: string;
  },
): Promise<void> {
  const roots = normalizeArchiveRoots(plugin.settings);
  if (!roots.length) return;
  const root = pickArchiveRootForOutputPath(roots, opts.sourceOutputPath);
  if (!root) return;

  const ledgerPath = ledgerFilePathForArchiveRoot(root);
  const oPath = canonicalVaultPath(opts.sourceOutputPath);
  let ledger = await readLedgerFile(plugin.app, ledgerPath);

  const prev = ledger.bySourceOutputPath?.[oPath] ?? { events: [] };
  const ev: OutputHistoryEvent = {
    ts: opts.tsIso,
    action: "output_archived_from_index",
    source_output_path: oPath,
    output_id: opts.outputId,
    archive_month_key: opts.archiveMonthKey,
  };
  const nextEntry: OutputLedgerSourcePathEntry = {
    output_id: opts.outputId ?? prev.output_id,
    events: [...(prev.events ?? []), ev],
  };

  ledger = {
    version: OUTPUT_LEDGER_VERSION,
    updated_at: opts.tsIso,
    byKnowledgePath: { ...ledger.byKnowledgePath },
    bySourceOutputPath: { ...(ledger.bySourceOutputPath ?? {}), [oPath]: nextEntry },
  };

  try {
    await persistLedger(plugin, ledgerPath, ledger);
  } catch (e) {
    console.error("RSLatte appendOutputArchivedFromIndexLedgerEvent failed:", e);
  }
}

/**
 * 知识库路径下用户编辑保存后追加（§3.5.1 `output_updated`）。
 * 台账文件归属：优先按该知识路径已有台账里的 `last_source_output_path` 选存档根；否则写入第一个 `archiveRoots`。
 */
export async function appendOutputUpdatedInKnowledgeLedgerEvent(
  plugin: RSLattePlugin,
  opts: {
    knowledgePath: string;
    outputId: string;
    tsIso: string;
  },
): Promise<void> {
  const roots = normalizeArchiveRoots(plugin.settings);
  if (!roots.length) return;

  const kPath = canonicalVaultPath(opts.knowledgePath);
  const oid = String(opts.outputId ?? "").trim();
  if (!kPath || !oid) return;

  const maps = await readMergedOutputLedgerMaps(plugin.app, plugin.settings);
  const prevMerged = maps.byKnowledgePath.get(kPath);

  let root: string | null = null;
  if (prevMerged?.last_source_output_path) {
    root = pickArchiveRootForOutputPath(roots, prevMerged.last_source_output_path);
  }
  if (!root) root = roots[0] ?? null;
  if (!root) return;

  const ledgerPath = ledgerFilePathForArchiveRoot(root);
  let ledger = await readLedgerFile(plugin.app, ledgerPath);
  const prev = ledger.byKnowledgePath[kPath] ?? { events: [] };
  const evs = [...(prev.events ?? [])].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const last = evs[evs.length - 1];

  if (last?.action === "output_updated" && last.ts) {
    const prevMs = new Date(last.ts).getTime();
    if (!Number.isNaN(prevMs) && Date.now() - prevMs < 4000) return;
  }
  if (last?.action === "publish_to_knowledge" && last.ts) {
    const pubMs = new Date(last.ts).getTime();
    if (!Number.isNaN(pubMs) && Date.now() - pubMs < 12000) return;
  }

  const ev: OutputHistoryEvent = {
    ts: opts.tsIso,
    action: "output_updated",
    knowledge_path: kPath,
    output_id: oid,
    note: "knowledge_vault_edit",
  };

  const nextEntry: OutputLedgerKnowledgeEntry = {
    output_id: oid || prev.output_id,
    last_source_output_path: prev.last_source_output_path ?? prevMerged?.last_source_output_path,
    last_knowledge_path: kPath,
    last_published_at: prev.last_published_at ?? prevMerged?.last_published_at,
    last_bucket: prev.last_bucket ?? prevMerged?.last_bucket,
    events: [...(prev.events ?? []), ev],
  };

  ledger = {
    version: OUTPUT_LEDGER_VERSION,
    updated_at: opts.tsIso,
    byKnowledgePath: { ...ledger.byKnowledgePath, [kPath]: nextEntry },
    bySourceOutputPath: { ...(ledger.bySourceOutputPath ?? {}) },
  };

  try {
    await persistLedger(plugin, ledgerPath, ledger);
  } catch (e) {
    console.error("RSLatte appendOutputUpdatedInKnowledgeLedgerEvent failed:", e);
  }
}
