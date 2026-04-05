import type RSLattePlugin from "../main";
import type { ProjectArchiveTemplateDef } from "../types/settings";
import type { OutputTemplateDef } from "../types/outputTypes";

/**
 * 项目侧「创建项目存档文件」下拉：合并 outputPanel 中 project 模板与 legacy projectArchiveTemplates（同 id 优先输出管理中的定义）。
 */
export function mergeProjectArchiveTemplatesForModal(plugin: RSLattePlugin): ProjectArchiveTemplateDef[] {
  const legacy = (plugin.settings.projectArchiveTemplates ?? []) as ProjectArchiveTemplateDef[];
  const withProFilesPrefix = (rel: string): string => {
    const s = String(rel ?? "").trim().replace(/^\/+|\/+$/g, "");
    if (!s) return "pro_files";
    if (s === "pro_files" || s.startsWith("pro_files/")) return s;
    return `pro_files/${s}`;
  };
  const fromOutput: ProjectArchiveTemplateDef[] = (plugin.settings.outputPanel?.templates ?? [])
    .filter((t: OutputTemplateDef) => !!t && t.templateScope === "project" && t.enabled !== false)
    .filter((t) => String(t.projectTargetRelPath ?? "").trim())
    .map((t) => ({
      id: t.id,
      name: t.buttonName || t.docCategory || t.id,
      templatePath: t.templatePath,
      targetRelPath: withProFilesPrefix(String(t.projectTargetRelPath ?? "").trim()),
      openAfterCreate: true,
      favorite: false,
      tags: t.tags,
      type: t.type,
      docCategory: t.docCategory,
    }));

  const byId = new Map<string, ProjectArchiveTemplateDef>();
  for (const t of fromOutput) byId.set(t.id, t);
  for (const t of legacy) {
    if (!byId.has(t.id)) byId.set(t.id, t);
  }
  return Array.from(byId.values());
}
