import { App, ButtonComponent, Modal, Notice, Setting, TextComponent, normalizePath, TFile, TFolder } from "obsidian";

import type RSLattePlugin from "../../main";
import { appendOutputCreatedLedgerEvent } from "../../outputRSLatte/outputHistoryLedger";
import type { ProjectArchiveTemplateDef } from "../../types/settings";
import { toLocalOffsetIsoString } from "../../utils/localCalendarYmd";

function sanitizeFileName(name: string): string {
  return (name ?? "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCommaList(raw: string): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeSubdir(raw: string): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const parts = s
    .replace(/\\/g, "/")
    .split("/")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => x.replace(/[\\/:*?"<>|]/g, "-").replace(/\.+$/g, "").trim())
    .filter(Boolean);
  return parts.join("/");
}

async function ensureFolder(app: App, path: string): Promise<void> {
  const norm = normalizePath(path).replace(/\/+$/g, "");
  if (!norm) return;

  const parts = norm.split("/").filter(Boolean);
  let cur = "";
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p;
    const af = app.vault.getAbstractFileByPath(cur);
    if (af && af instanceof TFile) throw new Error(`路径冲突：${cur} 已存在同名文件`);
    if (!af) {
      try {
        await app.vault.createFolder(cur);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (msg.includes("Folder already exists") || msg.includes("EEXIST")) continue;
        throw e;
      }
    }
  }
}

function stripFrontmatter(md: string): string {
  const s = md ?? "";
  const m = s.match(/^---\s*\n[\s\S]*?\n---\s*\n?/);
  if (!m) return s;
  return s.slice(m[0].length);
}

function genUuid(): string {
  const c = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const s4 = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
  return `${s4()}${s4()}-${s4()}-${s4()}-${s4()}-${s4()}${s4()}${s4()}`.toLowerCase();
}

function todayYmd(): string {
  try {
    const m = (window as any).moment?.();
    if (m?.format) return m.format("YYYY-MM-DD");
  } catch {}
  const d = new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function buildProjectOutputFrontmatter(args: {
  outputId: string;
  create: string;
  projectId: string;
  projectName: string;
  tags: string[];
  domains: string[];
  type?: string;
  docCategory?: string;
}): string {
  const lines: string[] = ["---"];
  if (args.tags?.length) {
    lines.push("tags:");
    for (const t of args.tags) lines.push(`  - ${t}`);
  }
  if (args.type) lines.push(`type: ${args.type}`);
  if (args.docCategory) lines.push(`文档分类: ${args.docCategory}`);
  lines.push(`output_id: ${args.outputId}`);
  lines.push(`create: ${args.create}`);
  lines.push(`status: todo`);
  lines.push(`output_document_kind: project`);
  lines.push(`project_id: ${args.projectId}`);
  lines.push(`project_name: ${args.projectName}`);
  if (args.domains?.length) {
    lines.push("领域:");
    for (const d of args.domains) lines.push(`  - ${d}`);
  } else {
    lines.push("领域: []");
  }
  lines.push("---");
  return lines.join("\n");
}

async function readTemplate(app: App, templatePath: string): Promise<string> {
  const raw = (templatePath ?? "").trim();
  if (!raw) return "";

  const candidates: string[] = [];
  candidates.push(raw);
  if (!/\.md$/i.test(raw) && !/\.excalidraw$/i.test(raw)) candidates.push(raw + ".md");

  for (const p of candidates) {
    const af = app.vault.getAbstractFileByPath(p);
    if (af && af instanceof TFile) {
      try {
        return await app.vault.read(af);
      } catch {
        return "";
      }
    }
  }
  return "";
}

export class CreateProjectArchiveDocModal extends Modal {
  constructor(
    app: App,
    private plugin: RSLattePlugin,
    private project: { folderPath: string; projectName: string; projectId: string },
    private templates: ProjectArchiveTemplateDef[]
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    this.titleEl.setText(`创建项目存档文件：${this.project.projectName}`);

    // ===== templates ordering: favorites -> recent -> others =====
    const maxRecent = 8;
    const rawRecentIds = (this.plugin.settings as any)?.projectArchiveTemplateRecentIds as string[] | undefined;
    const recentIds = (rawRecentIds ?? []).filter(Boolean);
    const byId = new Map<string, ProjectArchiveTemplateDef>();
    (this.templates ?? []).forEach((t) => byId.set(t.id, t));

    // sanitize recent ids (drop missing)
    const validRecentIds = recentIds.filter((id) => byId.has(id));
    if (rawRecentIds && validRecentIds.join("|") !== recentIds.join("|")) {
      (this.plugin.settings as any).projectArchiveTemplateRecentIds = validRecentIds.slice(0, maxRecent);
      // best-effort save (don't block modal open)
      void this.plugin.saveSettings();
    }

    const favs = (this.templates ?? []).filter((t) => !!t.favorite);
    const recents = validRecentIds.map((id) => byId.get(id)!).filter((t) => t && !t.favorite);
    const favSet = new Set(favs.map((t) => t.id));
    const recentSet = new Set(recents.map((t) => t.id));
    const others = (this.templates ?? []).filter((t) => !favSet.has(t.id) && !recentSet.has(t.id));
    const ordered = [...favs, ...recents, ...others];

    let selectedId = (validRecentIds[0] ?? "") || (favs[0]?.id ?? "") || (ordered?.[0]?.id ?? "");
    let previewPathEl: HTMLElement;
    let fileNameText!: TextComponent;
    let domainsText!: TextComponent;
    let subdirText!: TextComponent;
    let domainsRaw = "";
    let subdirRaw = "";
    let createBtn!: ButtonComponent;

    const getTpl = () => ordered.find((t) => t.id === selectedId) ?? ordered[0];

    const rememberRecent = async (tplId: string) => {
      const id = String(tplId || "").trim();
      if (!id) return;
      const cur = (((this.plugin.settings as any).projectArchiveTemplateRecentIds ?? []) as string[]).filter(Boolean);
      const next = [id, ...cur.filter((x) => x !== id)].slice(0, maxRecent);
      (this.plugin.settings as any).projectArchiveTemplateRecentIds = next;
      try {
        await this.plugin.saveSettings();
      } catch {
        // ignore
      }
    };

    const getFileName = () => {
      const raw = (fileNameText?.getValue() ?? "").trim();
      const nm = sanitizeFileName(raw);
      if (!nm) return "";
      return /\.md$/i.test(nm) ? nm : `${nm}.md`;
    };

    const calcTargetDir = () => {
      const tpl = getTpl();
      if (!tpl) return "";

      const pn = sanitizeFileName(this.project.projectName);
      const rel = String(tpl.targetRelPath ?? "").trim();
      let rel2 = rel;
      rel2 = rel2.replace(/\{\{projectName\}\}/g, pn);
      rel2 = rel2.replace(/\{\{project\}\}/g, pn);
      rel2 = rel2.replace(/^\/+|\/+$/g, "");
      if (!rel2) rel2 = "pro_files";
      else if (rel2 !== "pro_files" && !rel2.startsWith("pro_files/")) rel2 = `pro_files/${rel2}`;
      const extra = normalizeSubdir(subdirRaw);
      if (extra) rel2 = `${rel2}/${extra}`;

      const full = normalizePath(`${this.project.folderPath}/${rel2}`).replace(/\/+$/g, "");
      return full;
    };

    const calcTargetPath = () => {
      const dir = calcTargetDir();
      if (!dir) return "";
      const fn = getFileName();
      if (!fn) return normalizePath(`${dir}/(请填写文件名称).md`);
      return normalizePath(`${dir}/${fn}`);
    };

    const refresh = () => {
      const tpl = getTpl();
      const hasTpl = !!tpl && !!String(tpl.targetRelPath ?? "").trim();
      const hasName = !!getFileName();
      const hasDomains = parseCommaList(domainsRaw).length > 0;
      const ok = hasTpl && hasName && hasDomains;
      createBtn?.setDisabled(!ok);
      domainsText?.inputEl?.classList.toggle("is-invalid", !hasDomains);
      if (previewPathEl) {
        const p = calcTargetPath();
        previewPathEl.setText(p || "（请先配置目标相对路径）");
      }
      return ok;
    };

    new Setting(contentEl)
      .setName("选择存档模板")
      .setDesc("合并自「设置 → 输出管理」中范围=项目的模板，以及旧版「项目存档文件模板清单」")
      .addDropdown((dd) => {
        for (const t of ordered) {
          const label = t.favorite
            ? `⭐ ${t.name || t.id}`
            : validRecentIds.includes(t.id)
              ? `🕒 ${t.name || t.id}`
              : (t.name || t.id);
          dd.addOption(t.id, label);
        }
        dd.setValue(selectedId);
        dd.onChange((v) => {
          selectedId = v;
          refresh();
        });
      });

    new Setting(contentEl)
      .setName("文件名称")
      .setDesc("必填：不需要填写 .md，会自动追加。最终创建路径为：[项目目录]/pro_files/[模板相对路径]/[文件名称].md")
      .addText((t) => {
        fileNameText = t;
        t.setPlaceholder("例如：插件使用指导");
        t.onChange(() => refresh());
      });

    new Setting(contentEl)
      .setName("存档子目录")
      .setDesc("可选：为空时直接使用模板路径；填写后会在项目内模板路径后追加一层（支持多级）")
      .addText((t) => {
        subdirText = t;
        t.setPlaceholder("可选 例如：2026/Q1");
        t.onChange((v) => {
          subdirRaw = v ?? "";
          refresh();
        });
      });

    new Setting(contentEl)
      .setName("领域*")
      .setDesc("必填：多个用英文逗号分隔，创建后写入属性‘领域’(list)")
      .addText((t) => {
        domainsText = t;
        t.setPlaceholder("必填 例如：OS,Security");
        t.onChange((v) => {
          domainsRaw = v ?? "";
          refresh();
        });
      });

    const preview = new Setting(contentEl)
      .setName("目标文件路径")
      .setDesc("最终创建/打开的文件路径（目标相对路径支持 {{projectName}} 占位符）");
    previewPathEl = preview.controlEl.createDiv({ cls: "rslatte-muted" });

    const btnRow = new Setting(contentEl);
    btnRow.addButton((btn) => {
      btn.setButtonText("取消");
      btn.onClick(() => this.close());
    });

    btnRow.addButton((btn) => {
      createBtn = btn;
      btn.setButtonText("创建/打开");
      btn.setCta();
      btn.onClick(() => void doCreate());
    });

    const doCreate = async () => {
      if (!refresh()) {
        if (!getFileName()) new Notice("请输入文件名称");
        else if (parseCommaList(domainsRaw).length === 0) new Notice("领域不能为空，请至少填写一个领域");
        return;
      }

      const tpl = getTpl();
      if (!tpl) return;

      const targetPath = calcTargetPath();
      if (!targetPath) return;

      const existing = this.app.vault.getAbstractFileByPath(targetPath);
      if (existing instanceof TFile) {
        await rememberRecent(tpl.id);
        if (tpl.openAfterCreate !== false) {
          await this.app.workspace.getLeaf(true).openFile(existing);
        }
        new Notice("已打开：" + targetPath);
        this.close();
        return;
      }
      if (existing instanceof TFolder) {
        new Notice("创建失败：目标路径是文件夹：" + targetPath);
        return;
      }

      // ensure parent folders
      const parent = normalizePath(targetPath.split("/").slice(0, -1).join("/"));
      if (parent) await ensureFolder(this.app, parent);

      const pid = String(this.project.projectId ?? "").trim();
      if (!pid) {
        new Notice("项目缺少 project_id，无法按输出契约写入 frontmatter");
        return;
      }

      const pn = sanitizeFileName(this.project.projectName);
      const create = todayYmd();
      const outputId = genUuid();
      const tags = (tpl.tags ?? []).map((t) => String(t).replace(/^#/, "").trim()).filter(Boolean);
      if (!tags.includes("output")) tags.push("output");
      const domains = parseCommaList(domainsRaw);

      const fm = buildProjectOutputFrontmatter({
        outputId,
        create,
        projectId: pid,
        projectName: this.project.projectName,
        tags,
        domains,
        type: (tpl.type ?? "").trim() || undefined,
        docCategory: (tpl.docCategory ?? "").trim() || undefined,
      });

      const tplRaw = await readTemplate(this.app, tpl.templatePath);
      let body = stripFrontmatter(tplRaw || `# ${tpl.name || "存档"}\n`);
      body = body.replace(/\{\{projectName\}\}/g, pn);
      body = body.replace(/\{\{project\}\}/g, pn);
      body = body.replace(/\{\{folderPath\}\}/g, this.project.folderPath);
      body = body.replace(/\{\{path\}\}/g, this.project.folderPath);
      body = body.replace(/\{\{output_id\}\}/g, outputId);
      body = body.replace(/\{\{date\}\}/g, create);
      body = body.replace(/\{\{create\}\}/g, create);
      body = body.replace(/\{\{domains\}\}/g, domains.join(", "));

      const content = `${fm}\n\n${body}`.trimEnd() + "\n";

      const created = await this.app.vault.create(targetPath, content);
      new Notice("已创建：" + targetPath);

      void this.plugin.outputRSLatte?.upsertFile(created);
      this.plugin.refreshSidePanel();

      void appendOutputCreatedLedgerEvent(this.plugin, {
        sourceOutputPath: created.path,
        outputId,
        tsIso: toLocalOffsetIsoString(),
        origin: "project",
      });

      void this.plugin.workEventSvc?.append({
        ts: toLocalOffsetIsoString(),
        kind: "output",
        action: "create",
        source: "ui",
        ref: {
          output_id: outputId,
          file_path: created.path,
          project_id: pid,
          doc_category: (tpl.docCategory ?? "").trim() || undefined,
        },
        summary: `📄 新建项目输出 ${created.basename}`,
      });

      await rememberRecent(tpl.id);

      if (tpl.openAfterCreate !== false) {
        await this.app.workspace.getLeaf(true).openFile(created);
      }

      // best-effort: refresh project index for this folder
      try {
        // Creating file triggers vault events, which should mark folder dirty.
        await this.plugin.projectMgr?.refreshDirty?.({ reason: "create_archive_doc" });
      } catch {}

      this.close();
    };

    refresh();
  }
}
