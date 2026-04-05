import { normalizePath, TFile, TFolder } from "obsidian";

import { getEffectiveV2Root, getV2DirectoryPaths } from "../constants/v2Directory";
import type { KnowledgePanelSettings, KnowledgeSecondarySubdirDef, KnowledgeTier1Folder } from "../types/knowledgeTypes";
import { tier1ToKnowledgeBucket } from "../types/knowledgeTypes";
import type { RSLattePluginSettings } from "../types/settings";

/** Vault 相对路径：解析后的 V2 根（可为 vault 根或 `v2DirectoryRoot`） */
export function resolveV2RootRel(settings: RSLattePluginSettings): string {
  return getEffectiveV2Root("", String(settings.v2DirectoryRoot ?? "").trim());
}

/** `30-Knowledge` 的 vault 相对路径 */
export function resolveKnowledgeLibraryRootRel(settings: RSLattePluginSettings): string {
  const paths = getV2DirectoryPaths(resolveV2RootRel(settings));
  return normalizePath(paths.knowledge);
}

/** 递归收集文件夹下 Markdown（含子文件夹），最多 `limit` 个 */
export function collectMarkdownFilesUnderFolder(folder: TFolder, limit: number, out: TFile[] = []): TFile[] {
  for (const c of folder.children) {
    if (out.length >= limit) return out;
    if (c instanceof TFile && c.extension === "md") {
      out.push(c);
    } else if (c instanceof TFolder) {
      collectMarkdownFilesUnderFolder(c, limit, out);
    }
  }
  return out;
}

const SEG_RE = /^[a-zA-Z0-9._\u4e00-\u9fff-]+$/;

export function sanitizeKnowledgeFolderSegment(name: string): string {
  return String(name ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)[0] ?? "";
}

export function isValidKnowledgeFolderSegment(name: string): boolean {
  const s = sanitizeKnowledgeFolderSegment(name);
  if (!s || s.includes("..")) return false;
  return SEG_RE.test(s);
}

/** 子路径多段：去空白、剔非法段 */
export function normalizeExtraRelPath(raw: string): string {
  return String(raw ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .map((s) => sanitizeKnowledgeFolderSegment(s))
    .filter(Boolean)
    .join("/");
}

/** `30-Knowledge/<tier1>/<二级>/…` */
export function buildKnowledgeSubdirPath(
  settings: RSLattePluginSettings,
  tier1: KnowledgeTier1Folder,
  folderName: string,
): string {
  const base = resolveKnowledgeLibraryRootRel(settings);
  const seg = sanitizeKnowledgeFolderSegment(folderName);
  return normalizePath(`${base}/${tier1}/${seg}`);
}

export type KnowledgePublishTarget = {
  key: string;
  label: string;
  dir: string;
  tier1: KnowledgeTier1Folder;
  bucket: ReturnType<typeof tier1ToKnowledgeBucket>;
};

/** 发布弹窗下拉：按一级、tier1 内 sort、文件夹名排序 */
export function listKnowledgePublishTargets(settings: RSLattePluginSettings): KnowledgePublishTarget[] {
  const kp = settings.knowledgePanel ?? ({} as KnowledgePanelSettings);
  const rows = [...(kp.secondarySubdirs ?? [])].filter((r) => r?.tier1 && sanitizeKnowledgeFolderSegment(r.folderName));
  rows.sort((a, b) => {
    const t = String(a.tier1).localeCompare(String(b.tier1));
    if (t !== 0) return t;
    const sa = a.sort ?? 0;
    const sb = b.sort ?? 0;
    if (sa !== sb) return sa - sb;
    return sanitizeKnowledgeFolderSegment(a.folderName).localeCompare(sanitizeKnowledgeFolderSegment(b.folderName));
  });
  return rows.map((r) => {
    const seg = sanitizeKnowledgeFolderSegment(r.folderName);
    const dir = buildKnowledgeSubdirPath(settings, r.tier1, seg);
    const desc = String(r.description ?? "").trim();
    const label = `${r.tier1}/${seg}${desc ? ` — ${desc}` : ""}`;
    return {
      key: `${r.tier1}|${seg}`,
      label,
      dir,
      tier1: r.tier1,
      bucket: tier1ToKnowledgeBucket(r.tier1),
    };
  });
}
