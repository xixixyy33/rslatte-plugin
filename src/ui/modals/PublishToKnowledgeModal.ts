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
import { appendPublishToKnowledgeLedgerEvent } from "../../outputRSLatte/outputHistoryLedger";
import {
  isValidKnowledgeFolderSegment,
  listKnowledgePublishTargets,
  normalizeExtraRelPath,
  resolveKnowledgeLibraryRootRel,
} from "../../services/knowledgePaths";
import { upsertKnowledgeIndexItemByFile } from "../../services/knowledgeIndexWriter";
import { toLocalOffsetIsoString } from "../../utils/localCalendarYmd";

function isFileLike(v: unknown): v is TFile {
  const o = v as Record<string, unknown> | null;
  return !!o && typeof o.path === "string" && typeof o.name === "string";
}

function canonicalVaultPath(p: string): string {
  return normalizePath(String(p ?? "").trim().replace(/^(\.\/)+/, "").replace(/^\/+/, ""));
}

function buildPathCandidates(p: string): string[] {
  const raw = String(p ?? "").trim();
  const set = new Set<string>();
  const push = (x: string) => {
    const s = String(x ?? "").trim();
    if (s) set.add(s);
  };
  push(raw);
  push(normalizePath(raw));
  push(canonicalVaultPath(raw));
  push(raw.replace(/^(\.\/)+/, ""));
  push(raw.replace(/^\/+/, ""));
  return [...set];
}

function getParentDir(path: string): string {
  const p = canonicalVaultPath(path);
  const parts = p.split("/");
  parts.pop();
  return parts.join("/");
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

function genUuid(): string {
  const c = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const s4 = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
  return `${s4()}${s4()}-${s4()}-${s4()}-${s4()}-${s4()}${s4()}${s4()}`.toLowerCase();
}

function normalizeTags(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).replace(/^#/, "").trim()).filter(Boolean);
  if (typeof v === "string") {
    return v
      .split(/[,，\s]+/)
      .map((x) => x.replace(/^#/, "").trim())
      .filter(Boolean);
  }
  return [];
}

function estimateWordCountFromMarkdown(md: string): number {
  const s = String(md ?? "")
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/`{3}[\s\S]*?`{3}/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/[#>*_~\-]/g, " ");
  const cjk = (s.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latin = s.match(/[A-Za-z0-9]+/g)?.length ?? 0;
  return cjk + latin;
}

function mergePublishedKnowledgeFm(
  fmw: Record<string, unknown>,
  opts: {
    srcFm: Record<string, unknown>;
    srcPath: string;
    bucket: string;
    publishedAtIso: string;
    publishedSpaceId: string;
    summary?: string;
    wordCount?: number;
  },
): void {
  const s = opts.srcFm;
  const pick = (k: string) => s[k];

  const oid = pick("output_id");
  if (oid !== undefined && oid !== null && String(oid).trim()) fmw.output_id = oid;

  const kind = pick("output_document_kind");
  if (kind !== undefined && kind !== null && String(kind).trim()) fmw.output_document_kind = kind;

  const pid = pick("project_id") ?? pick("projectId");
  if (pid !== undefined && pid !== null && String(pid).trim()) fmw.project_id = pid;

  const pname = pick("project_name") ?? pick("projectName");
  if (pname !== undefined && pname !== null && String(pname).trim()) fmw.project_name = pname;

  const typ = pick("type");
  if (typ !== undefined && typ !== null && String(typ).trim()) fmw.type = typ;

  const dc = pick("文档分类") ?? pick("doc_category");
  if (dc !== undefined && dc !== null && String(dc).trim()) {
    fmw["文档分类"] = dc;
    fmw.doc_category = dc;
  }

  const cr = pick("create");
  if (cr !== undefined && cr !== null && String(cr).trim()) fmw.create = cr;

  const domains = s["领域"] ?? s.domains ?? s.domain;
  if (domains !== undefined && domains !== null) {
    const list = normalizeTags(domains);
    if (list.length) {
      fmw["领域"] = list;
      fmw.domains = list;
    }
  }

  for (const k of ["start", "start_time", "done", "done_time", "cancelled", "cancelled_time", "resume_at", "resumed_time"] as const) {
    const v = pick(k);
    if (v !== undefined && v !== null && String(v).trim()) fmw[k] = v;
  }

  const baseTags = normalizeTags(pick("tags"));
  const merged = [...new Set(baseTags)];
  if (merged.length) fmw.tags = merged;

  fmw.knowledge_bucket = opts.bucket;
  fmw.published_at = opts.publishedAtIso;
  fmw.published_space_id = opts.publishedSpaceId;
  fmw.source_output_path = opts.srcPath;

  const sum = (opts.summary ?? "").trim();
  if (sum) fmw.summary = sum;
  const wc = Number(opts.wordCount ?? 0);
  if (Number.isFinite(wc) && wc > 0) fmw.word_count = Math.floor(wc);
}

/**
 * 将输出文档移动或复制到 `30-Knowledge` 下（路径来自设置中的二级目录表）。
 */
export class PublishToKnowledgeModal extends Modal {
  constructor(app: App, private plugin: RSLattePlugin, private sourcePath: string) {
    super(app);
  }

  onOpen(): void {
    const srcAf = this.app.vault.getAbstractFileByPath(this.sourcePath);
    if (!(srcAf instanceof TFile)) {
      new Notice("未找到源文件");
      this.close();
      return;
    }
    if (srcAf.extension !== "md") {
      new Notice("当前仅支持 Markdown 发布");
      this.close();
      return;
    }

    const targets = listKnowledgePublishTargets(this.plugin.settings);
    if (!targets.length) {
      new Notice('请先在「设置 → 知识管理」中配置「知识库二级目录」');
      this.close();
      return;
    }

    const srcPath0 = srcAf.path;
    const srcCache = this.app.metadataCache.getFileCache(srcAf);
    const srcFmAtOpen = { ...((srcCache?.frontmatter ?? {}) as Record<string, unknown>) };
    const srcKind = String(srcFmAtOpen.output_document_kind ?? "").trim();
    const srcProjectId = String(srcFmAtOpen.project_id ?? srcFmAtOpen.projectId ?? "").trim();
    const isProjectOutput = srcKind === "project" || !!srcProjectId;

    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(`发布到知识库：${srcAf.basename}`);

    contentEl.createDiv({
      cls: "rslatte-muted",
      text: `知识根：${resolveKnowledgeLibraryRootRel(this.plugin.settings)}。优先对外定稿可先选 33-Outputs；不确定放哪可展开下方「三问」。`,
    });

    const det = contentEl.createEl("details", { cls: "rslatte-publish-knowledge-decision" });
    det.createEl("summary", { text: "一级子目录（31 / 32 / 33）放哪？——三问决策（§2.2）" });
    const body = det.createDiv({ cls: "rslatte-muted" });
    body.createEl("p", {
      text: "磁盘上只能选一个父目录，按「首要身份」依次判断：",
    });
    const ol = body.createEl("ol");
    ol.createEl("li", {
      text: "是否已定稿且面向外部受众（博客、对客稿、对外 README 等）？是 → 33-Outputs（纯对内勿放 33）。",
    });
    ol.createEl("li", {
      text: "否则是否长期原子知识 / 方法论库（辞典、原则）？是 → 31-Permanent。",
    });
    ol.createEl("li", {
      text: "否则是否主题系列 / 汇编 / 学习路径？是 → 32-Topics。单篇对外长文仍建议优先 33。",
    });
    body.createEl("p", {
      text: "不要为多维度各拷一份；一篇一个 canonical 路径，其余用链接、标签或专题 MOC。",
    });

    let selectedKey = targets[0]?.key ?? "";
    let extraRel = "";
    let mode: "move" | "copy" = isProjectOutput ? "copy" : "move";
    let summary = "";

    new Setting(contentEl)
      .setName("目标位置")
      .setDesc("来自设置中的二级目录；可再在下方填写更深层子路径")
      .addDropdown((dd: DropdownComponent) => {
        for (const t of targets) dd.addOption(t.key, t.label);
        dd.setValue(selectedKey);
        dd.onChange((v) => {
          selectedKey = v;
        });
      });

    new Setting(contentEl)
      .setName("子路径（可选）")
      .setDesc("相对目标目录，如 2026/notes（仅路径段，勿含文件名）")
      .addText((t) => {
        t.setPlaceholder("例如：2026");
        t.onChange((v) => {
          extraRel = v ?? "";
        });
      });

    new Setting(contentEl)
      .setName("操作")
      .setDesc(
        isProjectOutput
          ? "项目输出仅允许复制到知识库（保留项目侧原稿）"
          : "移动：原输出路径不再存在；复制：原稿保留",
      )
      .addDropdown((dd) => {
        dd.addOption("copy", "复制到知识库");
        if (!isProjectOutput) dd.addOption("move", "移动到知识库");
        dd.setValue(mode);
        dd.onChange((v) => {
          if (isProjectOutput) {
            mode = "copy";
            return;
          }
          mode = v === "move" ? "move" : "copy";
        });
      });

    new Setting(contentEl)
      .setName("摘要 summary（可选）")
      .setDesc("写入知识库稿 frontmatter")
      .addTextArea((ta) => {
        ta.inputEl.rows = 2;
        ta.setPlaceholder("一句话说明");
        ta.onChange((v) => {
          summary = v ?? "";
        });
      });

    const row = new Setting(contentEl);
    row.addButton((b) => {
      b.setButtonText("取消");
      b.onClick(() => this.close());
    });
    row.addButton((b) => {
      b.setButtonText("确认");
      b.setCta();
      b.onClick(() => void submit());
    });

    const submit = async () => {
      if (isProjectOutput) mode = "copy";
      const t = targets.find((x) => x.key === selectedKey);
      if (!t) {
        new Notice("请选择目标位置");
        return;
      }

      const extraNorm = normalizeExtraRelPath(extraRel);
      if (extraNorm.split("/").some((seg) => seg && !isValidKnowledgeFolderSegment(seg))) {
        new Notice("子路径含非法文件夹名");
        return;
      }

      const baseName = srcAf.name;
      const destFolderRaw = extraNorm ? `${t.dir}/${extraNorm}` : t.dir;
      const destFolder = canonicalVaultPath(destFolderRaw);
      const srcParentPath = getParentDir(srcPath0);
      const srcParentAf = this.app.vault.getAbstractFileByPath(srcParentPath);
      if (!(srcParentAf instanceof TFolder)) {
        new Notice("未找到源文档目录");
        return;
      }
      const srcDocFolderName = srcParentAf.name;
      const destDocFolderPath = canonicalVaultPath(`${destFolder}/${srcDocFolderName}`);
      const destPath = canonicalVaultPath(`${destDocFolderPath}/${baseName}`);

      if (normalizePath(destPath) === normalizePath(srcPath0)) {
        new Notice("目标与源路径相同");
        return;
      }

      const exist = this.app.vault.getAbstractFileByPath(destDocFolderPath);
      if (exist) {
        new Notice(`目标目录已存在：${destDocFolderPath}`);
        return;
      }

      const publishedAtIso = toLocalOffsetIsoString();
      const publishedSpaceId = String(this.plugin.getCurrentSpaceId?.() ?? "").trim();
      const copyNewOutputId = mode === "copy" ? genUuid() : "";
      try {
        // move 模式不能预创建目标文档目录，否则后续 rename(folder -> folder) 会报目标已存在
        await this.plugin.ensureDirForPath(`${destFolder}/.keep`);

        const cacheBefore = this.app.metadataCache.getFileCache(srcAf);
        const srcFm = { ...(cacheBefore?.frontmatter ?? {}) } as Record<string, unknown>;
        const srcBody = await this.app.vault.read(srcAf);
        const srcWordCount = estimateWordCountFromMarkdown(srcBody);

        let destAf: TFile | null = null;
        if (mode === "move") {
          await this.app.vault.rename(srcParentAf, destDocFolderPath);
          const moved = this.app.vault.getAbstractFileByPath(destPath);
          destAf = isFileLike(moved) ? moved : srcAf;
        } else {
          await copyFolderRecursive(this.app, this.plugin, srcParentAf, destDocFolderPath);
          const created = this.app.vault.getAbstractFileByPath(destPath);
          destAf = isFileLike(created) ? created : null;
        }
        if (!destAf) {
          destAf = await this.resolveDestFile(destPath);
        }
        if (!destAf) {
          new Notice(`发布后未找到目标文件：${destPath}`);
          return;
        }

        await this.app.fileManager.processFrontMatter(destAf, (fm) => {
          const fmw = fm as Record<string, unknown>;
          mergePublishedKnowledgeFm(fmw, {
            srcFm,
            srcPath: srcPath0,
            bucket: t.bucket,
            publishedAtIso,
            publishedSpaceId,
            summary,
            wordCount: srcWordCount,
          });
          if (copyNewOutputId) fmw.output_id = copyNewOutputId;
          // 知识库稿不保留输出工序状态机字段（§10.2）
          for (const k of [
            "status",
            "resume_at",
            "resume_at_time",
            "resumed_time",
            "start",
            "start_time",
          ] as const) {
            delete fmw[k];
          }
        });
        // 兜底：复制模式再次强制覆盖 output_id，避免极端情况下被旧值回写覆盖
        if (copyNewOutputId) {
          await this.app.fileManager.processFrontMatter(destAf, (fm) => {
            (fm as Record<string, unknown>).output_id = copyNewOutputId;
          });
        }

        try {
          this.app.metadataCache.trigger("changed", destAf);
        } catch {
          // ignore
        }
        try {
          await upsertKnowledgeIndexItemByFile(this.plugin, destAf);
        } catch (e) {
          console.warn("[RSLatte] publish upsertKnowledgeIndexItemByFile failed", e);
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
        if (enableDbSync) await this.plugin.syncOutputFilesToDb({ reason: "publish_to_knowledge" });
        else await ((this.plugin as any).writeTodayOutputProgressToJournalFromIndex?.() ?? Promise.resolve());

        await appendPublishToKnowledgeLedgerEvent(this.plugin, {
          destKnowledgePath: destPath,
          sourceOutputPath: srcPath0,
          publishedAtIso,
          bucket: t.bucket,
          mode,
          srcFm,
          outputIdOverride: copyNewOutputId || undefined,
        });

        void this.plugin.workEventSvc?.append({
          ts: publishedAtIso,
          kind: "output",
          action: "publish",
          source: "ui",
          ref: {
            file_path: destPath,
            source_output_path: srcPath0,
            mode,
            knowledge_bucket: t.bucket,
          },
          summary: `${mode === "move" ? "📚 输出已迁入知识库" : "📚 输出已复制到知识库"} ${baseName}`,
        });

        this.plugin.refreshSidePanel();
        new Notice(mode === "move" ? `已移动到：${destPath}` : `已复制到：${destPath}`);
        this.close();
      } catch (e: any) {
        console.error("PublishToKnowledgeModal failed:", e);
        new Notice(`发布失败：${e?.message ?? String(e)}`);
      }
    };
  }

  private async resolveDestFile(destPath: string): Promise<TFile | null> {
    const candidates = buildPathCandidates(destPath);
    for (let i = 0; i < 8; i++) {
      for (const target of candidates) {
        const af = this.app.vault.getAbstractFileByPath(target);
        if (isFileLike(af)) return af;
      }
      await new Promise((r) => setTimeout(r, 60 * (i + 1)));
    }
    for (const target of candidates) {
      const parent = target.split("/").slice(0, -1).join("/");
      const name = target.split("/").pop() ?? "";
      const folderAf = this.app.vault.getAbstractFileByPath(parent);
      if (folderAf instanceof TFolder) {
        const hit = folderAf.children.find((x) => x instanceof TFile && x.name === name);
        if (hit instanceof TFile) return hit;
      }
    }
    return null;
  }
}
