import { App, ButtonComponent, Modal, Notice, normalizePath, Setting, TFile, TFolder } from "obsidian";

import type RSLattePlugin from "../../main";
import type { OutputCreateExtraFieldDef } from "../../types/outputTypes";
import { isReservedOutputFmKey } from "../../utils/outputYamlExtras";
import { toLocalOffsetIsoString } from "../../utils/localCalendarYmd";

function parseCommaList(raw: string): string[] {
  return (raw ?? "")
    .split(/[,，]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function sanitizeFileName(name: string): string {
  return (name ?? "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function fmToString(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).join(", ");
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function normalizeDomainsFm(fm: Record<string, unknown>): string[] {
  const v = fm["领域"] ?? fm.domains ?? fm.domain;
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") return parseCommaList(v);
  return [];
}

/**
 * 修正输出文档 frontmatter（与 CreateOutputDocModal 可对齐的字段 + 设置中的扩展键）。
 * 只读：output_id、create、status。
 */
export class EditOutputMetaModal extends Modal {
  constructor(app: App, private plugin: RSLattePlugin, private filePath: string) {
    super(app);
  }

  onOpen(): void {
    const af = this.app.vault.getAbstractFileByPath(this.filePath);
    if (!(af instanceof TFile)) {
      new Notice("未找到文件：" + this.filePath);
      this.close();
      return;
    }

    const cache = this.app.metadataCache.getFileCache(af);
    const fm = { ...(cache?.frontmatter ?? {}) } as Record<string, unknown>;
    const st = String(fm.status ?? "todo").trim();
    let docCategory = String(fm["文档分类"] ?? fm.doc_category ?? "").trim();
    const initialDocCategory = docCategory;
    const initialBaseName = af.basename;
    let fileName = af.basename;
    let typeV = String(fm.type ?? "").trim();
    let domainsRaw = normalizeDomainsFm(fm).join(", ");
    let projectName = String(fm.project_name ?? fm.projectName ?? "").trim();
    let resumeAt = String(fm.resume_at ?? "").trim().slice(0, 10);
    const hasProject = !!String(fm.project_id ?? fm.projectId ?? "").trim() || String(fm.output_document_kind ?? "").trim() === "project";

    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(`修正输出：${af.basename}`);

    new Setting(contentEl).setName("output_id").addText((t) => {
      t.setValue(String(fm.output_id ?? ""));
      t.setDisabled(true);
    });
    new Setting(contentEl).setName("create").addText((t) => {
      t.setValue(String(fm.create ?? ""));
      t.setDisabled(true);
    });
    new Setting(contentEl).setName("status").addText((t) => {
      t.setValue(st);
      t.setDisabled(true);
    });

    new Setting(contentEl)
      .setName("文件名称*")
      .setDesc("仅文件名，不含扩展名；保存时会同步重命名“文档分类+文件名称”目录")
      .addText((t) => {
        t.setValue(fileName);
        t.onChange((v) => {
          fileName = v ?? "";
        });
      });

    const defs = (this.plugin.settings.outputPanel?.createOutputExtraFields ?? []).filter(
      (d: OutputCreateExtraFieldDef) => d?.id && !isReservedOutputFmKey(d.id),
    );
    const extraVals: Record<string, string> = {};
    for (const d of defs) {
      extraVals[d.id] = fm[d.id] === undefined || fm[d.id] === null ? "" : fmToString(fm[d.id]);
    }

    new Setting(contentEl)
      .setName("文档分类*")
      .setDesc("对应模板 docCategory / 属性「文档分类」")
      .addText((t) => {
        t.setValue(docCategory);
        t.onChange((v) => {
          docCategory = (v ?? "").trim();
        });
      });

    new Setting(contentEl)
      .setName("type*")
      .addText((t) => {
        t.setValue(typeV);
        t.onChange((v) => {
          typeV = (v ?? "").trim();
        });
      });

    new Setting(contentEl)
      .setName("领域*")
      .setDesc("必填：多个用英文逗号分隔，写入「领域」列表")
      .addText((t) => {
        t.setValue(domainsRaw);
        t.onChange((v) => {
          domainsRaw = v ?? "";
        });
      });

    if (hasProject) {
      new Setting(contentEl)
        .setName("project_name*")
        .setDesc("必填：展示用项目名称（请与项目重命名策略一致）")
        .addText((t) => {
          t.setValue(projectName);
          t.onChange((v) => {
            projectName = (v ?? "").trim();
          });
        });
    }

    if (st === "waiting_until") {
      new Setting(contentEl)
        .setName("resume_at")
        .setDesc("等待结束日 YYYY-MM-DD")
        .addText((t) => {
          t.inputEl.type = "date";
          t.setValue(resumeAt);
          t.onChange((v) => {
            resumeAt = (v ?? "").trim().slice(0, 10);
          });
        });
    }

    for (const d of defs) {
      const stSet = new Setting(contentEl).setName(d.label || d.id).setDesc(`键：${d.id}`);
      if (d.multiline) {
        stSet.addTextArea((ta) => {
          ta.setPlaceholder(d.placeholder ?? "");
          ta.setValue(extraVals[d.id] ?? "");
          ta.inputEl.rows = 4;
          ta.onChange((v) => {
            extraVals[d.id] = v ?? "";
          });
        });
      } else {
        stSet.addText((t) => {
          t.setPlaceholder(d.placeholder ?? "");
          t.setValue(extraVals[d.id] ?? "");
          t.onChange((v) => {
            extraVals[d.id] = v ?? "";
          });
        });
      }
    }

    let saveBtn: ButtonComponent | undefined;
    const row = new Setting(contentEl);
    row.addButton((b) => {
      b.setButtonText("取消");
      b.onClick(() => this.close());
    });
    row.addButton((b) => {
      saveBtn = b;
      b.setButtonText("保存");
      b.setCta();
      b.onClick(() => void doSave());
    });

    const doSave = async () => {
      const sanitizedBaseName = sanitizeFileName(fileName);
      if (!sanitizedBaseName) {
        new Notice("文件名称不能为空");
        return;
      }
      const domains = parseCommaList(domainsRaw);
      if (!docCategory.trim()) {
        new Notice("文档分类不能为空");
        return;
      }
      if (!typeV.trim()) {
        new Notice("type 不能为空");
        return;
      }
      if (domains.length === 0) {
        new Notice("领域不能为空");
        return;
      }
      if (hasProject && !projectName.trim()) {
        new Notice("project_name 不能为空");
        return;
      }
      if (st === "waiting_until") {
        const ra = resumeAt.trim().slice(0, 10);
        if (ra && !/^\d{4}-\d{2}-\d{2}$/.test(ra)) {
          new Notice("resume_at 格式应为 YYYY-MM-DD");
          return;
        }
      }

      if (!saveBtn) return;
      saveBtn.setDisabled(true);
      try {
        let targetFile = af;
        const oldTitle = initialDocCategory ? `【${initialDocCategory}】${initialBaseName}` : initialBaseName;
        const newTitle = docCategory ? `【${docCategory}】${sanitizedBaseName}` : sanitizedBaseName;
        const oldParentPath = normalizePath(targetFile.path.split("/").slice(0, -1).join("/"));
        const oldParentName = oldParentPath.split("/").pop() ?? "";
        const oldParentDir = oldParentPath.split("/").slice(0, -1).join("/");
        const oldFolderAf = this.app.vault.getAbstractFileByPath(oldParentPath);
        let nextParentPath = oldParentPath;

        // 仅当父目录符合“文档分类+文件名称”约定时，才联动重命名目录
        const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const oldFolderMatch = oldParentName.match(new RegExp(`^${esc(oldTitle)}(?:-(\\d+))?$`));
        if (oldFolderAf instanceof TFolder && oldFolderMatch && oldTitle !== newTitle) {
          // 目录命名以“当前目标文件名”为主，不继承旧目录后缀，避免出现 `-2-2` 级联。
          let wantedFolderPath = normalizePath(`${oldParentDir}/${newTitle}`);
          const exists = (p: string) => !!this.app.vault.getAbstractFileByPath(p);
          if (wantedFolderPath !== oldParentPath && exists(wantedFolderPath)) {
            let i = 2;
            while (exists(normalizePath(`${oldParentDir}/${newTitle}-${i}`))) i++;
            wantedFolderPath = normalizePath(`${oldParentDir}/${newTitle}-${i}`);
          }
          if (wantedFolderPath !== oldParentPath) {
            await this.app.vault.rename(oldFolderAf, wantedFolderPath);
            nextParentPath = wantedFolderPath;
          }
        }

        // 文件名重命名
        let wantedFilePath = normalizePath(`${nextParentPath}/${sanitizedBaseName}.md`);
        const exists = (p: string) => !!this.app.vault.getAbstractFileByPath(p);
        if (normalizePath(targetFile.path) !== wantedFilePath && exists(wantedFilePath)) {
          let i = 2;
          while (exists(normalizePath(`${nextParentPath}/${sanitizedBaseName}-${i}.md`))) i++;
          wantedFilePath = normalizePath(`${nextParentPath}/${sanitizedBaseName}-${i}.md`);
        }
        if (normalizePath(targetFile.path) !== wantedFilePath) {
          await this.app.vault.rename(targetFile, wantedFilePath);
          const renamedAf = this.app.vault.getAbstractFileByPath(wantedFilePath);
          if (renamedAf instanceof TFile) targetFile = renamedAf;
        }

        await this.app.fileManager.processFrontMatter(targetFile, (fmw: Record<string, unknown>) => {
          if (docCategory) {
            fmw["文档分类"] = docCategory;
            fmw.doc_category = docCategory;
          } else {
            delete fmw["文档分类"];
            delete fmw.doc_category;
          }

          if (typeV) fmw.type = typeV;
          else delete fmw.type;

          fmw["领域"] = domains.length ? domains : [];
          fmw.domains = domains.length ? domains : [];

          // tags 固定由创建链路维护为 output；此处不提供修改入口

          if (hasProject) {
            if (projectName) fmw.project_name = projectName;
            else delete fmw.project_name;
          }

          if (st === "waiting_until") {
            const ra = resumeAt.trim().slice(0, 10);
            if (ra) fmw.resume_at = ra;
            else delete fmw.resume_at;
          }

          for (const d of defs) {
            const v = (extraVals[d.id] ?? "").trim();
            if (!v) delete fmw[d.id];
            else fmw[d.id] = v;
          }
        });

        try {
          this.app.metadataCache.trigger("changed", targetFile);
        } catch {
          // ignore
        }
        await new Promise((r) => setTimeout(r, 50));
        try {
          await this.plugin.outputRSLatte?.upsertFile(targetFile);
        } catch {
          // ignore
        }
        const enableDbSync = !!this.plugin.settings.outputPanel?.enableDbSync;
        if (enableDbSync) await this.plugin.syncOutputFilesToDb({ reason: "edit_output_meta" });
        else await ((this.plugin as any).writeTodayOutputProgressToJournalFromIndex?.() ?? Promise.resolve());

        void this.plugin.workEventSvc?.append({
          ts: toLocalOffsetIsoString(),
          kind: "output",
          action: "update",
          source: "ui",
          ref: { file_path: targetFile.path },
          summary: `✏️ 修正输出属性 ${targetFile.basename}`,
        });

        this.plugin.refreshSidePanel();
        new Notice("已保存");
        this.close();
      } catch (e: any) {
        console.error("EditOutputMetaModal failed:", e);
        new Notice(`保存失败：${e?.message ?? String(e)}`);
      } finally {
        saveBtn.setDisabled(false);
      }
    };
  }
}
