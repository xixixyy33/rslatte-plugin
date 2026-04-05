import { normalizePath } from "obsidian";

import type RSLattePlugin from "../main";
import { tryReadKnowledgeIndexJson } from "../services/knowledgeIndexWriter";
import type { KnowledgeIndexItemV1 } from "../types/knowledgeIndexTypes";
import type { UpsertKnowledgeDocReq } from "../api";

const BATCH = 200;

function itemToUpsert(it: KnowledgeIndexItemV1, knowledgeRootNorm: string): UpsertKnowledgeDocReq {
  const fp = normalizePath(String(it.path ?? ""));
  const row: UpsertKnowledgeDocReq = {
    file_path: fp,
    basename: String(it.basename ?? ""),
    mtime_ms: Number(it.mtimeMs),
    knowledge_root: knowledgeRootNorm || undefined,
    is_delete: false,
  };
  if (it.output_id != null && String(it.output_id).trim()) row.output_id = String(it.output_id).trim();
  if (it.knowledge_bucket != null && String(it.knowledge_bucket).trim()) row.knowledge_bucket = String(it.knowledge_bucket).trim();
  if (it.published_at != null && String(it.published_at).trim()) row.published_at = String(it.published_at).trim();
  if (it.published_space_id != null && String(it.published_space_id).trim()) row.published_space_id = String(it.published_space_id).trim();
  if (it.doc_category != null && String(it.doc_category).trim()) row.doc_category = String(it.doc_category).trim();
  if (it.type != null && String(it.type).trim()) row.type = String(it.type).trim();
  if (it.output_document_kind != null && String(it.output_document_kind).trim())
    row.output_document_kind = String(it.output_document_kind).trim();
  if (it.create != null && String(it.create).trim()) row.source_create = String(it.create).trim();
  if (Array.isArray(it.domains) && it.domains.length) row.domains = it.domains.map((d) => String(d));
  if (it.frontmatter && typeof it.frontmatter === "object") row.meta_sync = { ...it.frontmatter } as Record<string, unknown>;
  return row;
}

export function createKnowledgeSync(plugin: RSLattePlugin) {
  return {
    async syncKnowledgeIndexToDbNow(opts?: { reason?: string }): Promise<void> {
      try {
        if ((plugin as any).isKnowledgeDbSyncEnabled?.() !== true) return;
      } catch {
        return;
      }
      const vaultOk = await (plugin as any).vaultSvc?.ensureVaultReadySafe?.("syncKnowledgeIndexToDbNow");
      if (!vaultOk) return;
      const db = await (plugin as any).vaultSvc?.checkDbReadySafe?.("syncKnowledgeIndexToDbNow");
      if (!db?.ok) return;

      const api = (plugin as any).api;
      if (!api?.upsertKnowledgeDocsBatch) return;

      const idx = await tryReadKnowledgeIndexJson(plugin);
      const kr = normalizePath(String(idx?.knowledgeRoot ?? ""));
      const items = (idx?.items ?? []) as KnowledgeIndexItemV1[];
      const payloads = items.map((it) => itemToUpsert(it, kr));

      const mark = (ok: boolean, failed: number) => {
        try {
          (plugin as any).markDbSyncWithCounts?.("knowledge", {
            ok,
            pendingCount: 0,
            failedCount: failed,
            err: failed ? String(opts?.reason ?? "batch_failed") : undefined,
          });
        } catch {
          /* ignore */
        }
      };

      if (payloads.length === 0) {
        mark(true, 0);
        return;
      }

      let failed = 0;
      for (let i = 0; i < payloads.length; i += BATCH) {
        const batch = payloads.slice(i, i + BATCH);
        try {
          const resp: any = await api.upsertKnowledgeDocsBatch({ items: batch });
          failed += Number(resp?.failed ?? 0);
        } catch (e) {
          failed += batch.length;
          console.warn("[RSLatte][knowledge] upsertKnowledgeDocsBatch failed", e);
        }
      }
      mark(failed === 0, failed);
    },
  };
}
