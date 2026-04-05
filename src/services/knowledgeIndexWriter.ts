import { TFile, TFolder, normalizePath } from "obsidian";

import type RSLattePlugin from "../main";
import { VIEW_TYPE_KNOWLEDGE, VIEW_TYPE_KNOWLEDGE_PANEL } from "../constants/viewTypes";
import {
  collectMarkdownFilesUnderFolder,
  resolveKnowledgeLibraryRootRel,
} from "./knowledgePaths";
import { resolveCentralRootDir } from "./space/spaceContext";
import type { KnowledgeIndexFileV1, KnowledgeIndexItemV1 } from "../types/knowledgeIndexTypes";
import { KNOWLEDGE_INDEX_VERSION } from "../types/knowledgeIndexTypes";
import { toLocalOffsetIsoString } from "../utils/localCalendarYmd";

function isKnowledgeIndexFileV1(raw: unknown): raw is KnowledgeIndexFileV1 {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  return (
    o.version === KNOWLEDGE_INDEX_VERSION &&
    typeof o.updatedAt === "string" &&
    typeof o.knowledgeRoot === "string" &&
    Array.isArray(o.items)
  );
}

/** 读取中央 `knowledge-index.json`（若不存在或格式不符则 null） */
export async function tryReadKnowledgeIndexJson(plugin: RSLattePlugin): Promise<KnowledgeIndexFileV1 | null> {
  try {
    const outPath = normalizePath(`${resolveCentralRootDir(plugin.settings)}/knowledge-index.json`);
    const exists = await plugin.app.vault.adapter.exists(outPath);
    if (!exists) return null;
    // 与写入通道对齐：使用 adapter 直读磁盘，避免 vault 缓存导致“文件已更新但读到旧值”
    const raw = await plugin.app.vault.adapter.read(outPath);
    const j = JSON.parse(raw) as unknown;
    return isKnowledgeIndexFileV1(j) ? j : null;
  } catch {
    return null;
  }
}

const SCAN_CAP = 20_000;
let knowledgeIndexWriteQueue: Promise<void> = Promise.resolve();

function buildIndexOutPath(plugin: RSLattePlugin): string {
  return normalizePath(`${resolveCentralRootDir(plugin.settings)}/knowledge-index.json`);
}

function buildKnowledgeRoot(plugin: RSLattePlugin): string {
  return normalizePath(resolveKnowledgeLibraryRootRel(plugin.settings));
}

function tryGetFolderByPathLoose(plugin: RSLattePlugin, p: string): TFolder | null {
  const raw = String(p ?? "").trim();
  if (!raw) return null;
  const candidates = Array.from(
    new Set([
      raw,
      normalizePath(raw),
      raw.replace(/^\.\/+/, ""),
      normalizePath(raw.replace(/^\.\/+/, "")),
      raw.replace(/^\/+/, ""),
      normalizePath(raw.replace(/^\/+/, "")),
    ].filter(Boolean)),
  );
  for (const c of candidates) {
    const af = plugin.app.vault.getAbstractFileByPath(c);
    if (af instanceof TFolder) return af;
  }
  return null;
}

function buildIndexItem(plugin: RSLattePlugin, f: TFile): KnowledgeIndexItemV1 {
  const cache = plugin.app.metadataCache.getFileCache(f);
  const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
  const oid = fm.output_id != null ? String(fm.output_id).trim() : "";
  const bucket = fm.knowledge_bucket != null ? String(fm.knowledge_bucket).trim() : "";
  const row: KnowledgeIndexItemV1 = {
    path: normalizePath(f.path),
    basename: f.basename,
    mtimeMs: f.stat.mtime,
  };
  if (oid) row.output_id = oid;
  if (bucket) row.knowledge_bucket = bucket;
  const cleanFm: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (!k || k.startsWith("position")) continue;
    cleanFm[k] = v as unknown;
  }
  if (Object.keys(cleanFm).length) row.frontmatter = cleanFm;
  const publishedAt = fm.published_at != null ? String(fm.published_at).trim() : "";
  const publishedSpaceId = fm.published_space_id != null ? String(fm.published_space_id).trim() : "";
  const docCategory =
    (fm["文档分类"] != null ? String(fm["文档分类"]).trim() : "") ||
    (fm.doc_category != null ? String(fm.doc_category).trim() : "");
  const domainsRaw = fm["领域"] ?? fm.domains ?? fm.domain;
  const domains = Array.isArray(domainsRaw)
    ? domainsRaw.map((x) => String(x).trim()).filter(Boolean)
    : (typeof domainsRaw === "string" ? domainsRaw.split(/[,，]+/).map((x) => x.trim()).filter(Boolean) : []);
  const typeV = fm.type != null ? String(fm.type).trim() : "";
  const outputKind = fm.output_document_kind != null ? String(fm.output_document_kind).trim() : "";
  const createV = fm.create != null ? String(fm.create).trim() : "";
  if (publishedAt) row.published_at = publishedAt;
  if (publishedSpaceId) {
    row.published_space_id = publishedSpaceId;
    const spaces = ((plugin.settings as any)?.spaces ?? {}) as Record<string, { name?: string }>;
    const n = String(spaces[publishedSpaceId]?.name ?? "").trim();
    if (n) row.published_space_name = n;
  }
  if (docCategory) row.doc_category = docCategory;
  if (domains.length) row.domains = domains;
  if (typeV) row.type = typeV;
  if (outputKind) row.output_document_kind = outputKind;
  if (createV) row.create = createV;
  return row;
}

function sortIndexItems(items: KnowledgeIndexItemV1[]): void {
  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function writeKnowledgeIndexDoc(plugin: RSLattePlugin, doc: KnowledgeIndexFileV1): Promise<string> {
  const outPath = buildIndexOutPath(plugin);
  const json = JSON.stringify(doc, null, 2);
  let lastErr: unknown = null;
  const runWrite = async () => {
    await plugin.ensureDirForPath(outPath);
    // 直接走 adapter 写入（参考 schedule 索引写法），避免 create/modify 竞态与文件对象可见性差异
    await plugin.app.vault.adapter.write(outPath, json);
  };

  knowledgeIndexWriteQueue = knowledgeIndexWriteQueue
    .catch(() => {
      // keep queue alive after previous failure
    })
    .then(async () => {
      try {
        await runWrite();
      } catch (e) {
        lastErr = e;
      }
    });
  await knowledgeIndexWriteQueue;
  if (lastErr) {
    console.warn("[RSLatte] writeKnowledgeIndexDoc failed:", outPath, lastErr);
    throw lastErr;
  }
  return outPath;
}

function isInKnowledgeRoot(filePath: string, knowledgeRoot: string): boolean {
  const p = normalizePath(filePath);
  const r = normalizePath(knowledgeRoot);
  if (p === r || p.startsWith(`${r}/`)) return true;
  // Windows/macOS 常见大小写差异兜底
  const pl = p.toLowerCase();
  const rl = r.toLowerCase();
  return pl === rl || pl.startsWith(`${rl}/`);
}

function listKnowledgeMarkdownFiles(plugin: RSLattePlugin, knowledgeRoot: string): TFile[] {
  const all = plugin.app.vault.getMarkdownFiles();
  const out: TFile[] = [];
  for (const f of all) {
    if (isInKnowledgeRoot(f.path, knowledgeRoot)) out.push(f);
    if (out.length >= SCAN_CAP) break;
  }
  return out;
}

async function listKnowledgeMarkdownFilesByAdapter(plugin: RSLattePlugin, knowledgeRoot: string): Promise<TFile[]> {
  const out: TFile[] = [];
  const seen = new Set<string>();
  const root = normalizePath(knowledgeRoot);
  const walk = async (dir: string): Promise<void> => {
    let r: { files: string[]; folders: string[] } | null = null;
    try {
      r = await plugin.app.vault.adapter.list(dir);
    } catch {
      return;
    }
    const files = Array.isArray(r?.files) ? r!.files : [];
    const folders = Array.isArray(r?.folders) ? r!.folders : [];
    for (const fp of files) {
      if (out.length >= SCAN_CAP) return;
      const p = normalizePath(String(fp ?? ""));
      if (!/\.md$/i.test(p)) continue;
      if (!isInKnowledgeRoot(p, root)) continue;
      if (seen.has(p)) continue;
      seen.add(p);
      const af = plugin.app.vault.getAbstractFileByPath(p);
      if (af instanceof TFile) out.push(af);
    }
    for (const sub of folders) {
      if (out.length >= SCAN_CAP) return;
      await walk(normalizePath(String(sub ?? "")));
    }
  };
  await walk(root);
  return out;
}

export function refreshKnowledgeViews(plugin: RSLattePlugin): void {
  try {
    const ws: any = plugin.app.workspace as any;
    const leaves = [
      ...(ws?.getLeavesOfType?.(VIEW_TYPE_KNOWLEDGE) ?? []),
      ...(ws?.getLeavesOfType?.(VIEW_TYPE_KNOWLEDGE_PANEL) ?? []),
    ];
    for (const leaf of leaves) {
      const view: any = leaf?.view;
      if (view && typeof view.refresh === "function") view.refresh();
    }
  } catch (e) {
    console.warn("[RSLatte] refreshKnowledgeViews failed:", e);
  }
}

/** 写入 `<centralIndexDir>/knowledge-index.json`（不按 space 分文件） */
export async function rebuildKnowledgeIndexJson(plugin: RSLattePlugin): Promise<{ count: number; path: string }> {
  const knowledgeRoot = buildKnowledgeRoot(plugin);

  const rootAf = tryGetFolderByPathLoose(plugin, knowledgeRoot);
  const items: KnowledgeIndexItemV1[] = [];
  let folderScanCount = 0;
  let fallbackScanCount = 0;
  let adapterScanCount = 0;

  if (rootAf instanceof TFolder) {
    const files = collectMarkdownFilesUnderFolder(rootAf, SCAN_CAP);
    folderScanCount = files.length;
    for (const f of files) {
      items.push(buildIndexItem(plugin, f));
    }
    sortIndexItems(items);
  }
  // 兜底：某些场景下 TFolder children 递归可能暂时为空，回退到“任务索引同风格”的全库候选扫描 + 路径过滤
  if (items.length === 0) {
    try {
      const files = listKnowledgeMarkdownFiles(plugin, knowledgeRoot);
      fallbackScanCount = files.length;
      for (const f of files) {
        items.push(buildIndexItem(plugin, f));
      }
      sortIndexItems(items);
    } catch {
      // ignore fallback failure
    }
  }
  // 兜底2：adapter 递归扫描（比 metadata/vault 缓存更底层）
  if (items.length === 0) {
    try {
      const files = await listKnowledgeMarkdownFilesByAdapter(plugin, knowledgeRoot);
      adapterScanCount = files.length;
      for (const f of files) {
        items.push(buildIndexItem(plugin, f));
      }
      sortIndexItems(items);
    } catch {
      // ignore adapter fallback failure
    }
  }

  const doc: KnowledgeIndexFileV1 = {
    version: KNOWLEDGE_INDEX_VERSION,
    updatedAt: toLocalOffsetIsoString(),
    knowledgeRoot,
    items,
  };

  const outPath = await writeKnowledgeIndexDoc(plugin, doc);
  // 回读校验：避免“扫描有数据但文件仍为空”的静默失败
  const saved = await tryReadKnowledgeIndexJson(plugin);
  const savedCount = Array.isArray(saved?.items) ? saved.items.length : -1;
  if (!saved || savedCount !== items.length) {
    await writeKnowledgeIndexDoc(plugin, doc);
  }
  if ((plugin.settings as any)?.debugLogEnabled === true) {
    console.log("[RSLatte][knowledge][rebuild]", {
      knowledgeRoot,
      hasRootFolder: rootAf instanceof TFolder,
      folderScanCount,
      fallbackScanCount,
      adapterScanCount,
      count: items.length,
      outPath,
    });
  }
  refreshKnowledgeViews(plugin);

  return { count: items.length, path: outPath };
}

export async function upsertKnowledgeIndexItemByFile(
  plugin: RSLattePlugin,
  file: TFile,
): Promise<{ count: number; path: string; updated: boolean }> {
  const knowledgeRoot = buildKnowledgeRoot(plugin);
  if (!isInKnowledgeRoot(file.path, knowledgeRoot) || String(file.extension).toLowerCase() !== "md") {
    return { count: 0, path: buildIndexOutPath(plugin), updated: false };
  }
  const existing = await tryReadKnowledgeIndexJson(plugin);
  const doc: KnowledgeIndexFileV1 = existing ?? {
    version: KNOWLEDGE_INDEX_VERSION,
    updatedAt: "",
    knowledgeRoot,
    items: [],
  };
  const item = buildIndexItem(plugin, file);
  const p = normalizePath(item.path);
  const idx = doc.items.findIndex((x) => normalizePath(x.path) === p);
  if (idx >= 0) doc.items[idx] = item;
  else doc.items.push(item);
  doc.knowledgeRoot = knowledgeRoot;
  doc.updatedAt = toLocalOffsetIsoString();
  sortIndexItems(doc.items);
  const outPath = await writeKnowledgeIndexDoc(plugin, doc);
  refreshKnowledgeViews(plugin);
  return { count: doc.items.length, path: outPath, updated: true };
}

export async function removeKnowledgeIndexItemByPath(
  plugin: RSLattePlugin,
  path: string,
): Promise<{ count: number; path: string; removed: boolean }> {
  const existing = await tryReadKnowledgeIndexJson(plugin);
  if (!existing) return { count: 0, path: buildIndexOutPath(plugin), removed: false };
  const norm = normalizePath(path);
  const before = existing.items.length;
  existing.items = existing.items.filter((x) => normalizePath(x.path) !== norm);
  const removed = existing.items.length !== before;
  if (!removed) return { count: existing.items.length, path: buildIndexOutPath(plugin), removed: false };
  existing.updatedAt = toLocalOffsetIsoString();
  sortIndexItems(existing.items);
  const outPath = await writeKnowledgeIndexDoc(plugin, existing);
  refreshKnowledgeViews(plugin);
  return { count: existing.items.length, path: outPath, removed: true };
}
