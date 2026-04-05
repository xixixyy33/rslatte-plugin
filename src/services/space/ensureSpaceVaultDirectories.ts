import { normalizePath, type App } from "obsidian";

import type { RSLattePluginSettings } from "../../types/settings";
import { DEFAULT_KNOWLEDGE_SECONDARY_SUBDIRS } from "../../types/knowledgeTypes";
import { resolveKnowledgeLibraryRootRel } from "../knowledgePaths";

/**
 * 规范化为与 Obsidian vault 内路径一致的相对路径。
 * 去掉 `./` 前缀，避免 `getAbstractFileByPath('./10-Personal')` 判缺失而实际为 `10-Personal`
 *（与「一键创建」用 adapter 建出的路径不一致）。
 */
export function canonicalVaultRelativePath(rel: string): string {
  let p = normalizePath(String(rel ?? "").trim().replace(/\/+$/, ""));
  for (let i = 0; i < 8 && p.startsWith("./"); i++) {
    p = normalizePath(p.slice(2).trim().replace(/\/+$/, ""));
  }
  if (p === "." || p === "") return "";
  return p;
}

/**
 * 逐级创建 vault 目录（路径可为文件夹路径，不要求以文件结尾）。
 */
export async function ensureFolderChain(app: App, dirPath: string): Promise<void> {
  const p = canonicalVaultRelativePath(String(dirPath ?? ""));
  if (!p) return;
  const parts = p.split("/").filter(Boolean);
  let cur = "";
  for (const seg of parts) {
    cur = cur ? `${cur}/${seg}` : seg;
    try {
      const exists = await app.vault.adapter.exists(cur);
      if (!exists) await app.vault.createFolder(cur);
    } catch (e: unknown) {
      const msg = String((e as { message?: string })?.message ?? e ?? "");
      if (/already exists|exists|EEXIST/i.test(msg)) continue;
      console.warn(`RSLatte ensureFolderChain failed: ${cur}`, e);
    }
  }
}

/** 从空间快照收集需要存在的目录路径（去重） */
export function collectDirectoryPathsFromSpaceSnapshot(snap: Partial<RSLattePluginSettings>): string[] {
  const raw: string[] = [];
  const add = (p: unknown) => {
    if (typeof p !== "string" || !String(p).trim()) return;
    raw.push(normalizePath(String(p).trim().replace(/\/+$/, "")));
  };

  add(snap.diaryPath);

  const tp = snap.taskPanel as { taskFolders?: string[] } | undefined;
  if (Array.isArray(tp?.taskFolders)) {
    for (const x of tp.taskFolders) add(x);
  }

  const cap = snap.captureModule as { captureInboxDir?: string; captureArchiveDir?: string } | undefined;
  add(cap?.captureInboxDir);
  add(cap?.captureArchiveDir);

  add(snap.projectRootDir);
  add(snap.projectArchiveDir);

  const op = snap.outputPanel as { archiveRootDir?: string; archiveRoots?: string[] } | undefined;
  add(op?.archiveRootDir);
  if (Array.isArray(op?.archiveRoots)) {
    for (const x of op.archiveRoots) add(x);
  }

  const cm = snap.contactsModule as { contactsDir?: string; archiveDir?: string } | undefined;
  add(cm?.contactsDir);
  add(cm?.archiveDir);

  return [...new Set(raw.filter(Boolean))];
}

/**
 * 按当前设置确保 `30-Knowledge` 根及「知识管理」中配置的二级目录存在（全库共用，与空间无关）。
 */
export async function ensureKnowledgeLibraryTree(
  app: App,
  settings: RSLattePluginSettings,
): Promise<void> {
  const knRoot = resolveKnowledgeLibraryRootRel(settings);
  await ensureFolderChain(app, knRoot);
  const defs =
    settings.knowledgePanel?.secondarySubdirs?.length ? settings.knowledgePanel.secondarySubdirs : DEFAULT_KNOWLEDGE_SECONDARY_SUBDIRS;
  for (const d of defs) {
    const p = normalizePath(`${knRoot}/${d.tier1}/${d.folderName}`);
    await ensureFolderChain(app, p);
  }
}

/**
 * 新建空间成功后：创建该空间快照中的业务目录，并确保知识库（30-Knowledge）骨架存在。
 */
export async function ensureSpaceSnapshotAndKnowledgeDirs(
  app: App,
  globalSettings: RSLattePluginSettings,
  snapshot: Partial<RSLattePluginSettings>,
): Promise<void> {
  for (const p of collectDirectoryPathsFromSpaceSnapshot(snapshot)) {
    await ensureFolderChain(app, p);
  }
  await ensureKnowledgeLibraryTree(app, globalSettings);
}
