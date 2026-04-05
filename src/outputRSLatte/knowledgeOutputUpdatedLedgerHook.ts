import { normalizePath, TFile } from "obsidian";

import type RSLattePlugin from "../main";
import { resolveKnowledgeLibraryRootRel } from "../services/knowledgePaths";
import { appendOutputUpdatedInKnowledgeLedgerEvent } from "./outputHistoryLedger";
import { toLocalOffsetIsoString } from "../utils/localCalendarYmd";

const DEBOUNCE_MS = 5000;

/**
 * vault 内 `30-Knowledge` 下 .md 保存后，若 frontmatter 含 `output_id`，防抖写入台账 `output_updated`。
 */
export function registerKnowledgeOutputUpdatedLedgerHook(plugin: RSLattePlugin): void {
  const pending = new Map<string, number>();

  const flush = (pathNorm: string) => {
    pending.delete(pathNorm);
    const f = plugin.app.vault.getAbstractFileByPath(pathNorm);
    if (!(f instanceof TFile) || f.extension !== "md") return;
    try {
      const cache = plugin.app.metadataCache.getFileCache(f);
      const raw = cache?.frontmatter?.output_id;
      const oid = raw != null ? String(raw).trim() : "";
      if (!oid) return;
      void appendOutputUpdatedInKnowledgeLedgerEvent(plugin, {
        knowledgePath: pathNorm,
        outputId: oid,
        tsIso: toLocalOffsetIsoString(),
      });
    } catch (e) {
      console.warn("RSLatte knowledgeOutputUpdatedLedgerHook flush failed:", pathNorm, e);
    }
  };

  plugin.registerEvent(
    plugin.app.vault.on("modify", (file) => {
      if (!(file instanceof TFile) || file.extension !== "md") return;
      const knRoot = normalizePath(resolveKnowledgeLibraryRootRel(plugin.settings));
      const p = normalizePath(file.path);
      if (p !== knRoot && !p.startsWith(`${knRoot}/`)) return;

      const prev = pending.get(p);
      if (prev != null) window.clearTimeout(prev);
      const tid = window.setTimeout(() => flush(p), DEBOUNCE_MS);
      pending.set(p, tid);
    }),
  );

  plugin.register(() => {
    for (const tid of pending.values()) window.clearTimeout(tid);
    pending.clear();
  });
}
