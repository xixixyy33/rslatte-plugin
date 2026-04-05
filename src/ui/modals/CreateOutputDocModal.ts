import { App, ButtonComponent, Modal, Notice, Setting, TextComponent, normalizePath, TFile } from "obsidian";

import type RSLattePlugin from "../../main";
import { appendOutputCreatedLedgerEvent } from "../../outputRSLatte/outputHistoryLedger";
import type { OutputCreateExtraFieldDef, OutputTemplateDef } from "../../types/outputTypes";
import { formatYamlScalarLine, isReservedOutputFmKey } from "../../utils/outputYamlExtras";
import { toLocalOffsetIsoString } from "../../utils/localCalendarYmd";

function todayYmd(): string {
  try {
    // @ts-ignore
    const m = (window as any).moment?.();
    if (m?.format) return m.format("YYYY-MM-DD");
  } catch {}
  const d = new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function sanitizeFileName(name: string): string {
  // Windows reserved and Obsidian path separators
  return (name ?? "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCommaList(raw: string): string[] {
  return (raw ?? "")
    .split(/[,，]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function genUuid(): string {
  const c = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const s4 = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
  return `${s4()}${s4()}-${s4()}-${s4()}-${s4()}-${s4()}${s4()}${s4()}`.toLowerCase();
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

function stripFrontmatter(md: string): string {
  const s = md ?? "";
  const m = s.match(/^---\s*\n[\s\S]*?\n---\s*\n?/);
  if (!m) return s;
  return s.slice(m[0].length);
}

function buildFrontmatter(args: {
  outputId: string;
  tags: string[];
  type?: string;
  status: string;
  create: string;
  docCategory?: string;
  domains: string[];
  outputDocumentKind?: "general" | "project";
  extraEntries?: { id: string; value: string; multiline?: boolean }[];
}): string {
  const lines: string[] = [];
  lines.push("---");

  if (args.tags?.length) {
    lines.push("tags:");
    for (const t of args.tags) lines.push(`  - ${t}`);
  }

  if (args.type) lines.push(`type: ${args.type}`);
  if (args.docCategory) lines.push(`文档分类: ${args.docCategory}`);

  // stable id (for DB sync / cross-file tracking)
  if (args.outputId) lines.push(`output_id: ${args.outputId}`);

  // requirement: create date stored in properties
  lines.push(`create: ${args.create}`);
  lines.push(`status: ${args.status}`);
  lines.push(`output_document_kind: ${args.outputDocumentKind ?? "general"}`);

  // domains list (even if empty)
  if (args.domains?.length) {
    lines.push("领域:");
    for (const d of args.domains) lines.push(`  - ${d}`);
  } else {
    lines.push("领域: []");
  }

  if (args.extraEntries?.length) {
    for (const e of args.extraEntries) {
      const k = String(e.id ?? "").trim();
      const v = String(e.value ?? "").trim();
      if (!k || !v) continue;
      if (isReservedOutputFmKey(k)) continue;
      if (e.multiline) {
        lines.push(`${k}: |`);
        for (const ln of v.split(/\r?\n/)) lines.push(`  ${ln}`);
      } else {
        lines.push(`${k}: ${formatYamlScalarLine(v)}`);
      }
    }
  }

  lines.push("---");
  return lines.join("\n");
}

export class CreateOutputDocModal extends Modal {
  constructor(app: App, private plugin: RSLattePlugin, private tpl: OutputTemplateDef) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    this.titleEl.setText(`创建输出文档：${this.tpl.buttonName || this.tpl.docCategory || ""}`);

    let subDir = "";
    let fileName = "";
    let domainsRaw = "";

    let fileNameInput!: TextComponent;
    let domainsInput!: TextComponent;
    let createBtn!: ButtonComponent;

    const refresh = () => {
      const nameOk = sanitizeFileName(fileName).length > 0;
      const domainsOk = parseCommaList(domainsRaw).length > 0;
      const ok = nameOk && domainsOk;
      createBtn?.setDisabled(!ok);
      fileNameInput?.inputEl?.classList.toggle("is-invalid", !nameOk);
      domainsInput?.inputEl?.classList.toggle("is-invalid", !domainsOk);
      return ok;
    };

    new Setting(contentEl)
      .setName("存档子目录")
      .setDesc("可选：为空时直接创建在模板的存档目录；可写多级目录，如：2026/01")
      .addText((t) => {
        t.setPlaceholder("(可选) 例如：2026/01");
        t.onChange((v) => {
          subDir = (v ?? "").trim();
        });
      });

    new Setting(contentEl)
      .setName("文件名称*")
      .setDesc("必填：最终文件名会拼接文档分类前缀，例如：【读书笔记】你的标题")
      .addText((t) => {
        fileNameInput = t;
        t.setPlaceholder("例如：xxx读后感");
        t.onChange((v) => {
          fileName = v ?? "";
          refresh();
        });
        t.inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            void doCreate();
          }
        });
      });

    new Setting(contentEl)
      .setName("领域*")
      .setDesc("必填：多个用英文逗号分隔，创建后写入属性‘领域’(list)")
      .addText((t) => {
        domainsInput = t;
        t.setPlaceholder("(必填) 例如：OS,Security,Database");
        t.onChange((v) => {
          domainsRaw = v ?? "";
          refresh();
        });
      });

    const op0 = this.plugin.settings.outputPanel;
    const extraDefs = [...(op0?.createOutputExtraFields ?? [])].filter(
      (d: OutputCreateExtraFieldDef) => d?.id && !isReservedOutputFmKey(String(d.id).trim()),
    );
    const extraValues: Record<string, string> = {};
    for (const d of extraDefs) {
      extraValues[d.id] = "";
      const stExtra = new Setting(contentEl).setName(d.label || d.id).setDesc(`写入 YAML 键：${d.id}`);
      if (d.multiline) {
        stExtra.addTextArea((ta) => {
          ta.setPlaceholder(d.placeholder ?? "");
          ta.inputEl.rows = 4;
          ta.onChange((v) => {
            extraValues[d.id] = v ?? "";
          });
        });
      } else {
        stExtra.addText((t) => {
          t.setPlaceholder(d.placeholder ?? "");
          t.onChange((v) => {
            extraValues[d.id] = v ?? "";
          });
        });
      }
    }

    const btnRow = new Setting(contentEl);

    btnRow.addButton((btn) => {
      btn.setButtonText("取消");
      btn.onClick(() => this.close());
    });

    btnRow.addButton((btn) => {
      createBtn = btn;
      btn.setButtonText("创建");
      btn.setCta();
      btn.onClick(() => void doCreate());
    });

    const doCreate = async () => {
      if (!refresh()) {
        if (parseCommaList(domainsRaw).length === 0) {
          new Notice("领域不能为空，请至少填写一个领域");
        }
        return;
      }

      const baseName = sanitizeFileName(fileName);
      const cat = (this.tpl.docCategory ?? "").trim();
      const title = cat ? `【${cat}】${baseName}` : baseName;

      const baseFolder = (() => {
        const base = normalizePath((this.tpl.archiveDir ?? "").trim());
        const extra = normalizePath((subDir ?? "").trim());
        if (extra) return normalizePath(`${base}/${extra}`);
        return base;
      })();

      if (!baseFolder) {
        new Notice("未配置存档目录，请先在设置中完善模板配置");
        return;
      }

      // ✅ 创建以文件名称命名的目录
      const docFolder = normalizePath(`${baseFolder}/${title}`);
      
      // 如果目录已存在，添加序号
      const exists = (p: string) => !!this.app.vault.getAbstractFileByPath(p);
      let finalDocFolder = docFolder;
      if (exists(finalDocFolder)) {
        let i = 2;
        while (exists(normalizePath(`${baseFolder}/${title}-${i}`))) i++;
        finalDocFolder = normalizePath(`${baseFolder}/${title}-${i}`);
      }

      // 文件放在目录下，文件名使用基础名称（不含分类前缀）
      let path = normalizePath(`${finalDocFolder}/${baseName}.md`);
      
      // 如果文件已存在，添加序号
      if (exists(path)) {
        let i = 2;
        while (exists(normalizePath(`${finalDocFolder}/${baseName}-${i}.md`))) i++;
        path = normalizePath(`${finalDocFolder}/${baseName}-${i}.md`);
      }

      const create = todayYmd();
      const outputId = genUuid();
      const domains = parseCommaList(domainsRaw);
      const tags = ["output"];

      const extraEntries = extraDefs.map((d) => ({
        id: d.id,
        value: extraValues[d.id] ?? "",
        multiline: d.multiline,
      }));

      const fm = buildFrontmatter({
        outputId,
        tags,
        type: (this.tpl.type ?? "").trim() || undefined,
        status: "todo",
        create,
        docCategory: cat || undefined,
        domains,
        outputDocumentKind: "general",
        extraEntries,
      });

      const tplRaw = await readTemplate(this.app, this.tpl.templatePath);
      const tplBody = stripFrontmatter(tplRaw);

      let body = (tplBody ?? "");
      body = body.replace(/\{\{title\}\}/g, title);
      body = body.replace(/\{\{fileName\}\}/g, baseName);
      body = body.replace(/\{\{docCategory\}\}/g, cat);
      body = body.replace(/\{\{type\}\}/g, (this.tpl.type ?? "").trim());
      body = body.replace(/\{\{date\}\}/g, create);
      body = body.replace(/\{\{create\}\}/g, create);
      body = body.replace(/\{\{output_id\}\}/g, outputId);
      body = body.replace(/\{\{domains\}\}/g, domains.join(", "));

      const content = `${fm}\n\n${body}`.trimEnd() + "\n";

      try {
        // ensure folder exists
        await this.plugin.ensureDirForPath(path);
        const created = await this.app.vault.create(path, content);

        // upsert to central index (cheap)
        void this.plugin.outputRSLatte?.upsertFile(created);
        this.plugin.refreshSidePanel();

        void appendOutputCreatedLedgerEvent(this.plugin, {
          sourceOutputPath: created.path,
          outputId,
          tsIso: toLocalOffsetIsoString(),
          origin: "general",
        });

        // open file
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(created, { active: true });

        // ✅ Work Event (success only)
        void this.plugin.workEventSvc?.append({
          ts: toLocalOffsetIsoString(),
          kind: "output",
          action: "create",
          source: "ui",
          ref: {
            output_id: outputId,
            file_path: created.path,
            title,
            doc_category: cat || undefined,
            type: (this.tpl.type ?? "").trim() || undefined,
            domains,
          },
          summary: `📄 新建输出 ${title}`,
        });

        const op = this.plugin.settings.outputPanel;
        if (op && this.tpl.id) {
          if (!op.templateCreateCounts) op.templateCreateCounts = {};
          const tid = this.tpl.id;
          op.templateCreateCounts[tid] = (op.templateCreateCounts[tid] ?? 0) + 1;
          await this.plugin.saveSettings();
        }

        new Notice(`已创建：${created.basename}`);
        this.close();
      } catch (e: any) {
        console.error("CreateOutputDoc failed:", e);
        new Notice(`创建失败：${e?.message ?? String(e)}`);
      }
    };

    refresh();
  }
}
