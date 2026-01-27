import { App, ButtonComponent, Modal, Notice, Setting, TextComponent, normalizePath, TFile, TFolder } from "obsidian";

import type RSLattePlugin from "../../main";
import type { ProjectArchiveTemplateDef } from "../../types/settings";

function sanitizeFileName(name: string): string {
  return (name ?? "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
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
    private project: { folderPath: string; projectName: string },
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
      const ok = hasTpl && hasName;
      createBtn?.setDisabled(!ok);
      if (previewPathEl) {
        const p = calcTargetPath();
        previewPathEl.setText(p || "（请先配置目标相对路径）");
      }
      return ok;
    };

    new Setting(contentEl)
      .setName("选择存档模板")
      .setDesc("从设置中的‘项目存档文件模板清单’选择一个模板")
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
      .setDesc("必填：不需要填写 .md，会自动追加。最终创建路径为：[项目目录]/[目标相对路径]/[文件名称].md")
      .addText((t) => {
        fileNameText = t;
        t.setPlaceholder("例如：插件使用指导");
        t.onChange(() => refresh());
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

      const pn = sanitizeFileName(this.project.projectName);
      const tplRaw = await readTemplate(this.app, tpl.templatePath);
      let content = (tplRaw || `# ${tpl.name || "存档"}\n`);
      content = content.replace(/\{\{projectName\}\}/g, pn);
      content = content.replace(/\{\{project\}\}/g, pn);
      content = content.replace(/\{\{folderPath\}\}/g, this.project.folderPath);
      content = content.replace(/\{\{path\}\}/g, this.project.folderPath);

      const created = await this.app.vault.create(targetPath, content);
      new Notice("已创建：" + targetPath);

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
