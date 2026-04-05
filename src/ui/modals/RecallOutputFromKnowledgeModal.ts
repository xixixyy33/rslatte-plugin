import {
  App,
  DropdownComponent,
  Modal,
  Notice,
  Setting,
  TFile,
  TFolder,
  normalizePath,
} from "obsidian";

import type RSLattePlugin from "../../main";
import { appendRecallFromKnowledgeLedgerEvent } from "../../outputRSLatte/outputHistoryLedger";
import {
  isValidKnowledgeFolderSegment,
  normalizeExtraRelPath,
  resolveKnowledgeLibraryRootRel,
} from "../../services/knowledgePaths";
import { removeKnowledgeIndexItemByPath, upsertKnowledgeIndexItemByFile } from "../../services/knowledgeIndexWriter";
import { toLocalOffsetIsoString } from "../../utils/localCalendarYmd";

const KNOWLEDGE_ONLY_KEYS = ["knowledge_bucket", "published_at", "published_space_id", "source_output_path", "audience"] as const;

function canonicalVaultPath(p: string): string {
  return normalizePath(String(p ?? "").trim().replace(/^(\.\/)+/, "").replace(/^\/+/, ""));
}

function getParentDir(path: string): string {
  const p = canonicalVaultPath(path);
  const parts = p.split("/");
  parts.pop();
  return parts.join("/");
}

function tryRelativeUnderRoot(path: string, root: string): string {
  const p = canonicalVaultPath(path);
  const r = canonicalVaultPath(root);
  if (!p || !r) return "";
  if (p === r) return "";
  if (!p.startsWith(`${r}/`)) return "";
  return p.slice(r.length + 1);
}

function stripLeadingRecallFolder(relPath: string): string {
  const p = normalizePath(String(relPath ?? "").trim());
  if (!p) return "";
  if (p === "打回继续更新") return "";
  if (p.startsWith("打回继续更新/")) return p.slice("打回继续更新/".length);
  return p;
}

function splitNameAndExt(fileName: string): { stem: string; ext: string } {
  const n = String(fileName ?? "");
  const i = n.lastIndexOf(".");
  if (i <= 0 || i === n.length - 1) return { stem: n, ext: "" };
  return { stem: n.slice(0, i), ext: n.slice(i) };
}

function withNumericSuffix(basePath: string, n: number): string {
  const p = normalizePath(basePath);
  const parts = p.split("/");
  const last = parts.pop() ?? p;
  const { stem, ext } = splitNameAndExt(last);
  const next = `${stem}-${n}${ext}`;
  return normalizePath(parts.length ? `${parts.join("/")}/${next}` : next);
}

function resolveAvailablePath(app: App, preferredPath: string): string {
  const base = normalizePath(preferredPath);
  if (!app.vault.getAbstractFileByPath(base)) return base;
  for (let i = 2; i <= 9999; i++) {
    const cand = withNumericSuffix(base, i);
    if (!app.vault.getAbstractFileByPath(cand)) return cand;
  }
  throw new Error(`无法找到可用路径：${base}`);
}

function lastPathName(path: string): string {
  const p = normalizePath(path);
  const parts = p.split("/");
  return parts[parts.length - 1] ?? "";
}

function replaceLastPathName(path: string, leaf: string): string {
  const p = normalizePath(path);
  const parts = p.split("/");
  if (!parts.length) return leaf;
  parts[parts.length - 1] = leaf;
  return normalizePath(parts.join("/"));
}

function extractDashNumericSuffix(preferredPath: string, resolvedPath: string): string {
  const preferredName = lastPathName(preferredPath);
  const resolvedName = lastPathName(resolvedPath);
  if (!preferredName || preferredName === resolvedName) return "";
  if (!resolvedName.startsWith(`${preferredName}-`)) return "";
  const tail = resolvedName.slice(preferredName.length + 1);
  return /^\d+$/.test(tail) ? `-${tail}` : "";
}

function applySuffixToFileName(fileName: string, suffix: string): string {
  if (!suffix) return fileName;
  const { stem, ext } = splitNameAndExt(fileName);
  return `${stem}${suffix}${ext}`;
}

function baseNameFromDocFolderLeaf(leaf: string, fallbackBaseName: string): string {
  const m = String(leaf ?? "").match(/^【.+?】(.+)$/);
  const fromFolder = String(m?.[1] ?? "").trim();
  return fromFolder || fallbackBaseName;
}

async function copyFolderRecursive(
  app: App,
  plugin: RSLattePlugin,
  srcFolder: TFolder,
  destFolderPath: string,
): Promise<void> {
  for (const child of srcFolder.children) {
    if (child instanceof TFile) {
      const target = normalizePath(`${destFolderPath}/${child.name}`);
      await plugin.ensureDirForPath(target);
      const body = await app.vault.read(child);
      await app.vault.create(target, body);
      continue;
    }
    if (child instanceof TFolder) {
      const sub = normalizePath(`${destFolderPath}/${child.name}`);
      await plugin.ensureDirForPath(`${sub}/.keep`);
      await copyFolderRecursive(app, plugin, child, sub);
    }
  }
}

function stripKnowledgeOnlyKeys(fm: Record<string, unknown>): void {
  for (const k of KNOWLEDGE_ONLY_KEYS) {
    delete fm[k];
  }
}

function publishedSpaceIdFromFile(app: App, f: TFile): string {
  try {
    const cache = app.metadataCache.getFileCache(f);
    const raw = (cache?.frontmatter as Record<string, unknown> | undefined)?.published_space_id;
    return raw != null ? String(raw).trim() : "";
  } catch {
    return "";
  }
}

/**
 * 将 `30-Knowledge` 下的笔记迁回输出存档目录，并以编辑模式打开（§3.7）。
 */
export class RecallOutputFromKnowledgeModal extends Modal {
  constructor(app: App, private plugin: RSLattePlugin, private sourceKnowledgePath: string) {
    super(app);
  }

  onOpen(): void {
    const srcAf = this.app.vault.getAbstractFileByPath(this.sourceKnowledgePath);
    if (!(srcAf instanceof TFile)) {
      new Notice("未找到源文件");
      this.close();
      return;
    }
    if (srcAf.extension !== "md") {
      new Notice("当前仅支持 Markdown");
      this.close();
      return;
    }

    const knowledgeRoot = canonicalVaultPath(resolveKnowledgeLibraryRootRel(this.plugin.settings));
    const srcNorm = canonicalVaultPath(srcAf.path);
    if (srcNorm !== knowledgeRoot && !srcNorm.startsWith(`${knowledgeRoot}/`)) {
      new Notice("仅支持从知识库根（30-Knowledge）下打回");
      this.close();
      return;
    }

    const currentSpaceId = String(this.plugin.getCurrentSpaceId?.() ?? "").trim();
    const publishedSpaceId = publishedSpaceIdFromFile(this.app, srcAf);
    if (!publishedSpaceId) {
      new Notice("该知识文档缺少 published_space_id，无法确认所属空间，禁止打回。");
      this.close();
      return;
    }
    if (!currentSpaceId || publishedSpaceId !== currentSpaceId) {
      new Notice("当前空间与该知识文档所属空间不一致，禁止打回。");
      this.close();
      return;
    }

    const roots = (this.plugin.settings.outputPanel?.archiveRoots ?? [])
      .map((r) => normalizePath(String(r ?? "").trim()))
      .filter(Boolean);
    if (!roots.length) {
      new Notice("请先在设置中配置「输出文档存档目录」archiveRoots");
      this.close();
      return;
    }

    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(`打回输出：${srcAf.basename}`);

    contentEl.createDiv({
      cls: "rslatte-muted",
      text: `从知识库迁回至存档目录，默认 status=in-progress；优先依据 source_output_path 打回到「打回继续更新」目录；并移除知识层字段（knowledge_bucket / published_at / source_output_path 等）。`,
    });

    let destRoot = roots[0] ?? "";
    let extraRel = "";
    let mode: "move" | "copy" = "move";

    new Setting(contentEl)
      .setName("目标存档根")
      .setDesc("来自 outputPanel.archiveRoots")
      .addDropdown((dd: DropdownComponent) => {
        for (const r of roots) dd.addOption(r, r);
        dd.setValue(destRoot);
        dd.onChange((v) => {
          destRoot = v;
        });
      });

    new Setting(contentEl)
      .setName("子路径（可选）")
      .setDesc("相对存档根，如 2026/recall（仅合法路径段）")
      .addText((t) => {
        t.setPlaceholder("留空则直接落在存档根下");
        t.onChange((v) => {
          extraRel = v ?? "";
        });
      });

    new Setting(contentEl)
      .setName("操作")
      .setDesc("移动：知识库中不再保留该路径；复制：知识库原稿保留")
      .addDropdown((dd) => {
        dd.addOption("move", "移动到输出区");
        dd.addOption("copy", "复制到输出区");
        dd.setValue(mode);
        dd.onChange((v) => {
          mode = v === "copy" ? "copy" : "move";
        });
      });

    const row = new Setting(contentEl);
    row.addButton((b) => {
      b.setButtonText("取消");
      b.onClick(() => this.close());
    });
    row.addButton((b) => {
      b.setButtonText("确认打回");
      b.setCta();
      b.onClick(() => void submit());
    });

    const submit = async () => {
      // 兜底：提交前再次校验，避免弹窗打开后空间切换/文档被修改导致误打回
      const liveCurrentSpaceId = String(this.plugin.getCurrentSpaceId?.() ?? "").trim();
      const livePublishedSpaceId = publishedSpaceIdFromFile(this.app, srcAf);
      if (!livePublishedSpaceId || !liveCurrentSpaceId || livePublishedSpaceId !== liveCurrentSpaceId) {
        new Notice("当前空间与该知识文档所属空间不一致，已阻止打回。");
        return;
      }

      const extraNorm = normalizeExtraRelPath(extraRel);
      if (extraNorm.split("/").some((seg) => seg && !isValidKnowledgeFolderSegment(seg))) {
        new Notice("子路径含非法文件夹名");
        return;
      }

      const srcDocFolderPath = getParentDir(srcNorm);
      const srcDocFolderAf = this.app.vault.getAbstractFileByPath(srcDocFolderPath);
      if (!(srcDocFolderAf instanceof TFolder)) {
        new Notice("未找到源文档目录");
        return;
      }
      const cacheBefore = this.app.metadataCache.getFileCache(srcAf);
      const srcFm = { ...(cacheBefore?.frontmatter ?? {}) } as Record<string, unknown>;
      const oidRaw = srcFm.output_id;
      const outputId = oidRaw !== undefined && oidRaw !== null ? String(oidRaw).trim() : "";
      const sourceOutputPath = canonicalVaultPath(String(srcFm.source_output_path ?? ""));
      const sourceDocCategory =
        String(srcFm["文档分类"] ?? srcFm.doc_category ?? "").trim();

      const recallBaseFolder = extraNorm
        ? normalizePath(`${destRoot}/${extraNorm}/打回继续更新`)
        : normalizePath(`${destRoot}/打回继续更新`);
      const sourceRel = tryRelativeUnderRoot(sourceOutputPath, destRoot);
      const sourceRelParentRaw = getParentDir(sourceRel);
      const sourceRelParent = stripLeadingRecallFolder(sourceRelParentRaw);
      let preferredDestDocFolderPath = sourceRelParent
        ? normalizePath(`${recallBaseFolder}/${sourceRelParent}`)
        : normalizePath(`${recallBaseFolder}/${srcDocFolderAf.name}`);
      // 目录名优先与当前主 md 文件名对齐，避免历史链路导致 `-2-2` 叠加。
      if (sourceDocCategory) {
        const alignedLeaf = `【${sourceDocCategory}】${srcAf.basename}`;
        preferredDestDocFolderPath = replaceLastPathName(preferredDestDocFolderPath, alignedLeaf);
      }
      let finalDestDocFolderPath = resolveAvailablePath(this.app, preferredDestDocFolderPath);
      let folderSuffix = extractDashNumericSuffix(preferredDestDocFolderPath, finalDestDocFolderPath);
      let finalBaseName = applySuffixToFileName(srcAf.name, folderSuffix);
      finalBaseName = `${baseNameFromDocFolderLeaf(lastPathName(finalDestDocFolderPath), srcAf.basename)}.md`;
      let finalDestPath = normalizePath(`${finalDestDocFolderPath}/${finalBaseName}`);

      if (normalizePath(finalDestPath) === srcNorm) {
        new Notice("目标与源路径相同");
        return;
      }

      const tsIso = toLocalOffsetIsoString();

      try {
        if (mode === "move") {
          const finalDestParent = getParentDir(finalDestDocFolderPath);
          if (finalDestParent) {
            await this.plugin.ensureDirForPath(`${finalDestParent}/.keep`);
          }
          try {
            await this.app.vault.rename(srcDocFolderAf, finalDestDocFolderPath);
          } catch (e: any) {
            const msg = String(e?.message ?? e ?? "");
            // rename 并发时可能出现“目标已存在”，此处再做一次兜底避让
            if (/already exists|EEXIST|Destination file already exists/i.test(msg)) {
              const retryDocFolderPath = resolveAvailablePath(this.app, preferredDestDocFolderPath);
              const retryParent = getParentDir(retryDocFolderPath);
              if (retryParent) {
                await this.plugin.ensureDirForPath(`${retryParent}/.keep`);
              }
              await this.app.vault.rename(srcDocFolderAf, retryDocFolderPath);
              finalDestDocFolderPath = retryDocFolderPath;
              folderSuffix = extractDashNumericSuffix(preferredDestDocFolderPath, finalDestDocFolderPath);
              finalBaseName = applySuffixToFileName(srcAf.name, folderSuffix);
              finalBaseName = `${baseNameFromDocFolderLeaf(lastPathName(finalDestDocFolderPath), srcAf.basename)}.md`;
              finalDestPath = normalizePath(`${finalDestDocFolderPath}/${finalBaseName}`);
            } else {
              throw e;
            }
          }
        } else {
          await this.plugin.ensureDirForPath(`${finalDestDocFolderPath}/.keep`);
          await copyFolderRecursive(this.app, this.plugin, srcDocFolderAf, finalDestDocFolderPath);
        }

        // 当目录因冲突变为 `-N` 时，主 md 文件名也同步加同后缀，避免目录名与文件名不一致。
        if (finalBaseName !== srcAf.name) {
          const originalDestPath = normalizePath(`${finalDestDocFolderPath}/${srcAf.name}`);
          const originalDestAf = this.app.vault.getAbstractFileByPath(originalDestPath);
          if (originalDestAf instanceof TFile) {
            await this.app.vault.rename(originalDestAf, finalDestPath);
          }
        }

        const destAf = this.app.vault.getAbstractFileByPath(finalDestPath);
        if (!(destAf instanceof TFile)) {
          new Notice("打回后未找到目标文件");
          return;
        }

        await this.app.fileManager.processFrontMatter(destAf, (fm) => {
          const fmw = fm as Record<string, unknown>;
          stripKnowledgeOnlyKeys(fmw);
          fmw.status = "in-progress";
        });

        try {
          this.app.metadataCache.trigger("changed", destAf);
        } catch {
          // ignore
        }
        try {
          if (mode === "move") {
            await removeKnowledgeIndexItemByPath(this.plugin, srcNorm);
          } else {
            await upsertKnowledgeIndexItemByFile(this.plugin, srcAf);
          }
        } catch (e) {
          console.warn("[RSLatte] recall knowledge index delta failed", e);
        }

        try {
          await this.plugin.outputRSLatte?.upsertFile(destAf);
        } catch {
          // ignore
        }
        try {
          await this.plugin.outputRSLatte?.refreshIndexNow?.({ mode: "full" });
        } catch {
          // ignore
        }

        const enableDbSync = !!this.plugin.settings.outputPanel?.enableDbSync;
        if (enableDbSync) await this.plugin.syncOutputFilesToDb({ reason: "recall_from_knowledge" });
        else await ((this.plugin as any).writeTodayOutputProgressToJournalFromIndex?.() ?? Promise.resolve());

        void appendRecallFromKnowledgeLedgerEvent(this.plugin, {
          sourceKnowledgePath: srcNorm,
          destOutputPath: finalDestPath,
          tsIso,
          mode,
          outputId: outputId || undefined,
        });

        void this.plugin.workEventSvc?.append({
          ts: tsIso,
          kind: "output",
          action: "recall",
          source: "ui",
          ref: {
            file_path: finalDestPath,
            source_knowledge_path: srcNorm,
            mode,
            output_id: outputId || undefined,
          },
          summary: `${mode === "move" ? "↩ 已从知识库移回输出" : "↩ 已从知识库复制到输出"} ${finalBaseName}`,
        });

        this.plugin.refreshSidePanel();
        try {
          const leaf = this.app.workspace.getLeaf(false);
          await leaf.openFile(destAf, { active: true, state: { mode: "source" } as any });
        } catch {
          // ignore
        }

        new Notice(mode === "move" ? `已移回：${finalDestPath}` : `已复制到：${finalDestPath}`);
        this.close();
      } catch (e: any) {
        console.error("RecallOutputFromKnowledgeModal failed:", e);
        new Notice(`打回失败：${e?.message ?? String(e)}`);
      }
    };
  }
}
