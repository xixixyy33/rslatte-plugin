/**
 * 插件初始化环境检查：尽量用代码读取/创建；无法访问的 Obsidian 项走「说明 + 用户自证」。
 */
import { normalizePath, TFile, TFolder, type App } from "obsidian";

import { getV2DirectoryPaths } from "../../constants/v2Directory";
import type RSLattePlugin from "../../main";
import { listKnowledgePublishTargets, resolveV2RootRel } from "../knowledgePaths";
import {
  canonicalVaultRelativePath,
  collectDirectoryPathsFromSpaceSnapshot,
  ensureFolderChain,
  ensureKnowledgeLibraryTree,
} from "../space/ensureSpaceVaultDirectories";
import { isWorkspacesCorePluginEnabled } from "../../plugin/obsidianCorePluginGate";
import type { RSLattePluginSettings } from "../../types/settings";
import {
  ENV_DEFAULT_DAILY_MD,
  ENV_DEFAULT_MONTHLY_MD,
  ENV_DEFAULT_PROJECT_INFO_MD,
  ENV_DEFAULT_PROJECT_TASKLIST_MD,
  ENV_DEFAULT_QUARTERLY_MD,
  ENV_DEFAULT_WEEKLY_MD,
  ENV_EMPTY_CANVAS_JSON,
  ENV_FALLBACK_PROJECT_ANALYSIS_MD,
} from "./defaultEnvTemplates";

export type EnvCheckStatus = "ok" | "warn" | "fail" | "manual";

export type EnvCheckCategory = "obsidian" | "plugin" | "directory" | "template";

export type EnvCheckItem = {
  id: string;
  category: EnvCheckCategory;
  title: string;
  status: EnvCheckStatus;
  /** 简要说明（当前检测结果） */
  message: string;
  /** 补充说明或操作指引 */
  detail?: string;
  /** 与《空间管理优化方案》§8 一致：未满足则不应依赖完整功能（启动时 Notice 提示） */
  blocking?: boolean;
  /** 是否参与「一键创建目录」 */
  fixDirPath?: string;
  /** 是否参与「一键创建模板」（vault 相对路径） */
  fixTemplatePath?: string;
};

/** 与 RSLatte 文档建议一致：附件子文件夹名 */
export const RECOMMENDED_ATTACHMENT_SUBFOLDER = "attachments";

/** 初始化环境检查中「建议安装」的社区插件（manifest id，与 .obsidian/plugins 下文件夹名一致） */
const RECOMMENDED_OBSIDIAN_PLUGINS: Array<{ id: string; title: string; detail: string }> = [
  {
    id: "obsidian-excalidraw-plugin",
    title: "Excalidraw",
    detail:
      "很好的手绘风格白板工具，适合与项目 Canvas 等能力配合。请在「设置 → 第三方插件」中安装并启用。",
  },
  {
    id: "attachment-management",
    title: "Attachment Management",
    detail:
      "附件管理工具，可自动重命名附件，便于管理 Markdown 中引用的截图等资源。请在「设置 → 第三方插件」中安装并启用。",
  },
  {
    id: "local-backup",
    title: "Local Backup",
    detail: "支持自动备份知识库，降低数据丢失风险。请在「设置 → 第三方插件」中安装并启用。",
  },
];

function isCommunityPluginEnabled(app: App, pluginId: string): boolean {
  try {
    const pl = (app as any).plugins;
    if (!pl) return false;
    const en: Set<string> | undefined = pl.enabledPlugins;
    if (en && typeof en.has === "function") return en.has(pluginId);
    return !!pl.plugins?.[pluginId];
  } catch {
    return false;
  }
}

function tryVaultGetConfig(app: App, key: string): unknown {
  try {
    const fn = (app.vault as any).getConfig;
    if (typeof fn === "function") return fn.call(app.vault, key);
  } catch {
    /* ignore */
  }
  return undefined;
}

function pathExists(app: App, rel: string): "folder" | "file" | "missing" {
  const p = canonicalVaultRelativePath(rel);
  if (!p) return "missing";
  const af = app.vault.getAbstractFileByPath(p);
  if (!af) return "missing";
  if (af instanceof TFolder) return "folder";
  if (af instanceof TFile) return "file";
  return "missing";
}

/**
 * 配置里周/月/季报等常写成无 `.md` 后缀，物理文件应为 `.md`。
 * Canvas / excalidraw 等有明确后缀的不改。
 */
export function resolveEnvTemplateVaultPath(raw: string): string {
  const c = canonicalVaultRelativePath(String(raw ?? "").trim());
  if (!c) return "";
  const lower = c.toLowerCase();
  if (lower.endsWith(".canvas")) return c;
  if (/\.excalidraw\.md$/i.test(c) || /\.excalidraw$/i.test(c)) return c;
  if (/\.[a-z0-9]+$/i.test(c)) return c;
  return `${c}.md`;
}

function envTemplatePathMatchesSetting(settingPath: string, templateRel: string): boolean {
  const s = String(settingPath ?? "").trim();
  if (!s) return false;
  return (
    normalizePath(resolveEnvTemplateVaultPath(s)) === normalizePath(resolveEnvTemplateVaultPath(templateRel))
  );
}

/** 收集当前 settings 下建议存在的业务目录（空间快照字段、V2 顶层、知识库二级等；不含 centralIndexDir，避免与「00-System/.rslatte」重复强校验） */
export function collectEnvCheckDirectoryTargets(settings: RSLattePluginSettings): string[] {
  const out: string[] = [];
  const add = (p: unknown) => {
    if (typeof p !== "string" || !p.trim()) return;
    const c = canonicalVaultRelativePath(p.trim());
    if (c) out.push(c);
  };
  for (const x of collectDirectoryPathsFromSpaceSnapshot(settings as any)) add(x);
  const v2root = resolveV2RootRel(settings);
  if (settings.useV2DirectoryStructure) {
    const vp = getV2DirectoryPaths(v2root);
    add(vp.system);
    add(vp.personal);
    // 环境检查不要求 20-Work 必须存在（可选工作区，用户可不建）
    add(vp.knowledge);
    add(vp.archive);
  }
  for (const t of listKnowledgePublishTargets(settings)) {
    add(t.dir);
  }
  return [...new Set(out.filter(Boolean))];
}

/**
 * Obsidian 存「当前文件下的子文件夹」时，常见值为 `attachments` 或 `./attachments`（甚至带尾部斜杠）。
 * 与建议名比较前做规范化，避免用户已按 UI 填写却仍被标成「建议」。
 */
function normalizeAttachmentSubfolderSegment(raw: unknown): string {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  if (s.startsWith("./")) s = s.slice(2);
  if (s.startsWith(".\\")) s = s.slice(2);
  s = s.replace(/[/\\]+$/, "").trim();
  return s;
}

function isRecommendedAttachmentSubfolderName(attachmentFolderPath: unknown): boolean {
  const seg = normalizeAttachmentSubfolderSegment(attachmentFolderPath);
  if (!seg) return false;
  // 仅建议「单层文件夹名为 attachments」；多段路径仍视为未采纳建议
  if (seg.includes("/") || seg.includes("\\")) return false;
  return seg.toLowerCase() === RECOMMENDED_ATTACHMENT_SUBFOLDER.toLowerCase();
}

/**
 * 附件是否为「当前文件所在文件夹下的指定子文件夹」模式。
 * 排除：与笔记同目录（`.` / `./`）、仅斜杠或 vault 根（`/`）、空值，以及规范化后无文件夹名的情况。
 * 说明：Obsidian 未公开「模式」枚举；以 `attachmentFolderPath` 取值做保守判断。
 */
function isAttachmentSubfolderUnderCurrentFileMode(attachmentFolderPath: unknown): boolean {
  const raw = String(attachmentFolderPath ?? "").trim();
  if (!raw) return false;
  if (raw === "." || raw === "./") return false;
  // 单段或多段仅由 `/` `\` 组成（如 `/`）→ 不是「具名子文件夹」
  if (/^[/\\]+$/.test(raw)) return false;
  const seg = normalizeAttachmentSubfolderSegment(attachmentFolderPath);
  if (!seg) return false;
  if (seg === "." || seg === "..") return false;
  // 以根斜杠开头多为「库根下路径」，不是「当前笔记所在文件夹下的子文件夹」
  if (seg.startsWith("/") || seg.startsWith("\\")) return false;
  if (seg.includes("..")) return false;
  return true;
}

/**
 * 运行全部检查项（不修改 vault）。
 */
export function runPluginEnvChecks(app: App, plugin: RSLattePlugin): EnvCheckItem[] {
  const settings = plugin.settings;
  const items: EnvCheckItem[] = [];

  // —— Obsidian「文件与链接」五项（§8）：依赖 vault.getConfig（非公开 API）——
  const hasGetConfig = typeof (app.vault as any).getConfig === "function";
  if (hasGetConfig) {
    const attachPath = tryVaultGetConfig(app, "attachmentFolderPath");
    const attachOk = isAttachmentSubfolderUnderCurrentFileMode(attachPath);
    const linkFmt = tryVaultGetConfig(app, "newLinkFormat");
    const linkOk = linkFmt === "relative";
    const showAll =
      tryVaultGetConfig(app, "showUnsupportedFiles") ??
      tryVaultGetConfig(app, "alwaysDetectAllFileTypes");
    const trash = tryVaultGetConfig(app, "trashOption");
    const trashOk = trash === "local";
    const subName = String(attachPath ?? "").trim();
    const subNameOk = isRecommendedAttachmentSubfolderName(attachPath);

    items.push({
      id: "obs_attachment_location_mode",
      category: "obsidian",
      title: "附件默认存放路径（必须）",
      status: attachOk ? "ok" : "fail",
      blocking: true,
      message: attachOk
        ? `当前子文件夹名称：${subName || "（已配置）"}`
        : `当前值：${attachPath == null || String(attachPath).trim() === "" ? "空或未读取" : String(attachPath)}`,
      detail:
        "须设为「当前文件所在文件夹下指定的子文件夹」（不是「与当前笔记相同文件夹」）。若值为空、`/`、仅斜杠、`./`、`.` 或无具体文件夹名，请改为子文件夹模式并填写名称（如 attachments）。",
    });
    items.push({
      id: "obs_internal_link_format",
      category: "obsidian",
      title: "内部链接类型（必须）",
      status: linkOk ? "ok" : "fail",
      blocking: true,
      message: `newLinkFormat = ${String(linkFmt)}`,
      detail: "须为「基于当前笔记的相对路径」（配置键通常为 newLinkFormat = relative）。",
    });
    items.push({
      id: "obs_attachment_subfolder_name",
      category: "obsidian",
      title: "子文件夹名称（建议）",
      status: subNameOk ? "ok" : "warn",
      message: subName ? `当前：${subName}` : "未读取",
      detail: `建议填写 **${RECOMMENDED_ATTACHMENT_SUBFOLDER}**，便于全库统一管理与附件归纳，且与 RSLatte 其它能力无路径冲突。`,
    });
    items.push({
      id: "obs_show_unsupported_files",
      category: "obsidian",
      title: "检测所有类型文件（建议）",
      status: showAll === true ? "ok" : "warn",
      message: `showUnsupportedFiles ≈ ${String(showAll)}`,
      detail:
        "建议开启，以便项目管理等场景在文件树/链接中展示和维护非 Markdown 类项目文件。",
    });
    items.push({
      id: "obs_trash_option",
      category: "obsidian",
      title: "删除文件设置（建议）",
      status: trashOk ? "ok" : "warn",
      message: `trashOption = ${String(trash)}`,
      detail:
        "建议设为「移至 Obsidian 回收站（.trash 文件夹）」，误删后仍可找回。请按需清理 .trash，避免长期占用磁盘。",
    });
  } else {
    items.push({
      id: "obs_manual_files_links",
      category: "obsidian",
      title: "Obsidian「文件与链接」（无法自动读取）",
      status: "manual",
      message: "当前环境无法通过 API 读取 vault 配置",
      detail:
        "请打开「设置 → 文件与链接」，自行核对以下五项：（1）附件默认存放路径 = 当前文件所在文件夹下指定的子文件夹；（2）内部链接类型 = 基于当前笔记的相对路径；（3）子文件夹名称建议 attachments；（4）检测所有类型文件建议开启；（5）删除文件建议移至 Obsidian 回收站。完成后勾选下方确认并尽量升级 Obsidian 以支持自动检测。",
    });
  }

  const workspacesOn = isWorkspacesCorePluginEnabled(app);
  items.push({
    id: "obs_core_workspaces",
    category: "obsidian",
    title: "核心插件「工作区」（建议）",
    status: workspacesOn ? "ok" : "warn",
    message: workspacesOn ? "已启用" : "未启用",
    detail:
      "建议启用，便于保存、切换多套界面布局；RSLatte「一键载入内置工作区」与 Obsidian 工作区能力配合使用更顺畅。路径：设置 → 核心插件 → 工作区。",
  });

  // —— 目录 ——
  const dirTargets = [...collectEnvCheckDirectoryTargets(settings)].sort();
  dirTargets.forEach((dir, di) => {
    const ex = pathExists(app, dir);
    items.push({
      id: `dir_${di}_${dir.slice(0, 24).replace(/\W+/g, "_")}`,
      category: "directory",
      title: `目录（必须）：${dir}`,
      status: ex === "folder" ? "ok" : "fail",
      blocking: true,
      message: ex === "folder" ? "文件夹已存在" : ex === "file" ? "路径存在但是文件（应为文件夹）" : "不存在",
      fixDirPath: ex !== "folder" ? dir : undefined,
      detail: ex === "file" ? "请调整设置或重命名冲突文件，或使用下方一键创建（若可自动处理）。" : undefined,
    });
  });

  // —— 模板文件 ——
  const tplPairs: Array<{ id: string; path: string; title: string }> = [
    { id: "tpl_diary", path: settings.diaryTemplate, title: "日记模板" },
    { id: "tpl_weekly", path: settings.weeklyReportTemplatePath ?? "", title: "周报模板" },
    { id: "tpl_monthly", path: settings.monthlyReportTemplatePath ?? "", title: "月报模板" },
    { id: "tpl_quarterly", path: settings.quarterlyReportTemplatePath ?? "", title: "季报模板" },
    { id: "tpl_project_tasklist", path: settings.projectTasklistTemplatePath, title: "项目任务清单模板" },
    { id: "tpl_project_info", path: settings.projectInfoTemplatePath, title: "项目信息模板" },
    { id: "tpl_project_analysis", path: settings.projectAnalysisTemplatePath, title: "项目分析图模板" },
  ];
  for (const t of tplPairs) {
    const raw = String(t.path ?? "").trim();
    if (!raw) {
      items.push({
        id: t.id,
        category: "template",
        title: t.title,
        status: "fail",
        blocking: true,
        message: "设置中路径为空",
        detail: "请在对应模块设置中填写模板路径，或使用下方「一键创建全部缺失模板」。",
      });
      continue;
    }
    const resolved = resolveEnvTemplateVaultPath(raw);
    const ex = pathExists(app, resolved);
    const extlessFile =
      resolved !== raw && pathExists(app, raw) === "file";
    let status: EnvCheckStatus;
    let message: string;
    let fixTemplatePath: string | undefined;
    let detail: string | undefined;

    if (extlessFile) {
      status = "fail";
      message = "已存在无扩展名同名文件（应为 .md）";
      fixTemplatePath = undefined;
      detail = `请删除或重命名为「${resolved}」后再点重新检测或一键创建。`;
    } else if (ex === "file") {
      status = "ok";
      message = "文件已存在";
      fixTemplatePath = undefined;
    } else if (ex === "folder") {
      status = "fail";
      message = "路径是文件夹（应为模板文件）";
      fixTemplatePath = undefined;
      detail = "请更换路径或删除冲突文件夹。";
    } else {
      status = "fail";
      message = "文件不存在";
      fixTemplatePath = resolved;
      if (raw !== resolved) {
        detail = `配置为「${raw}」，将创建 Markdown 文件「${resolved}」。可在设置中改为带 .md 的路径以保持一致。`;
      }
    }

    const titlePath = raw !== resolved ? `${raw} → ${resolved}` : raw;
    items.push({
      id: t.id,
      category: "template",
      title: `${t.title}（${titlePath}）`,
      status,
      blocking: true,
      message,
      fixTemplatePath,
      detail,
    });
  }

  // —— 推荐社区插件（建议，不阻塞初始化）——
  for (const rec of RECOMMENDED_OBSIDIAN_PLUGINS) {
    const on = isCommunityPluginEnabled(app, rec.id);
    items.push({
      id: `rec_plugin_${rec.id.replace(/[^a-z0-9-]+/gi, "_")}`,
      category: "plugin",
      title: `${rec.title}（建议）`,
      status: on ? "ok" : "warn",
      message: on ? "已启用" : "未启用或未安装",
      detail: rec.detail,
    });
  }

  return items;
}

/** 是否存在任一「强制」检查项未通过（blocking === true 且 status === fail；含 Obsidian、目录与模板）。 */
export function hasBlockingPluginEnvFailures(app: App, plugin: RSLattePlugin): boolean {
  return runPluginEnvChecks(app, plugin).some((x) => x.blocking === true && x.status === "fail");
}

/** Obsidian 五项无法 API 读取时，检查弹窗里「人工确认」行使用的 id（与 runPluginEnvChecks 一致） */
export const OBS_MANUAL_FILES_LINKS_ITEM_ID = "obs_manual_files_links";

/**
 * 初始化门禁：强制项是否仍未满足。
 * - 无 getConfig：须 settings.envObsidianFilesLinksManualAck === true（用户在检查弹窗完成初始化后写入）
 * - 任意时刻：存在 blocking 且 fail 的项（含目录）即视为阻塞
 */
export function hasEnvInitMandatoryBlocking(app: App, plugin: RSLattePlugin): boolean {
  const hasGetConfig = typeof (app.vault as any).getConfig === "function";
  if (!hasGetConfig && (plugin.settings as any).envObsidianFilesLinksManualAck !== true) return true;
  return hasBlockingPluginEnvFailures(app, plugin);
}

/** 用户是否已在检查工具中点击「完成初始化」，且当前强制项均已满足 */
export function arePluginModulesUnlocked(app: App, plugin: RSLattePlugin): boolean {
  if ((plugin.settings as any).pluginEnvInitGateCompleted !== true) return false;
  return !hasEnvInitMandatoryBlocking(app, plugin);
}

/**
 * 是否允许在检查弹窗中点击「完成初始化」：
 * - 无 getConfig：须勾选人工确认行
 * - 全部强制项（含目录、模板）均不得为 fail
 */
export function canMarkPluginEnvInitComplete(
  app: App,
  plugin: RSLattePlugin,
  manualObsidianRowChecked: boolean,
): boolean {
  const hasGetConfig = typeof (app.vault as any).getConfig === "function";
  if (!hasGetConfig && !manualObsidianRowChecked) return false;
  return !hasBlockingPluginEnvFailures(app, plugin);
}

/** 一键创建：业务目录 + 知识库树（与新建空间逻辑对齐） */
export async function fixEnvMissingDirectories(app: App, plugin: RSLattePlugin, paths: string[]): Promise<void> {
  const uniq = [...new Set(paths.map((p) => canonicalVaultRelativePath(String(p).trim())).filter(Boolean))];
  for (const p of uniq) {
    await ensureFolderChain(app, p);
  }
  await ensureKnowledgeLibraryTree(app, plugin.settings);
}

/** 在父目录存在前提下创建最小模板；会创建父级文件夹链 */
export async function fixEnvMissingTemplate(
  app: App,
  templateRel: string,
  body: string,
): Promise<void> {
  const p = resolveEnvTemplateVaultPath(templateRel);
  if (!p) return;
  const parent = p.split("/").slice(0, -1).join("/");
  if (parent) await ensureFolderChain(app, parent);
  const ex = app.vault.getAbstractFileByPath(p);
  if (ex instanceof TFile) return;
  if (ex instanceof TFolder) throw new Error(`路径已是文件夹，无法创建模板文件：${p}`);
  await app.vault.create(p, body);
}

export function getTemplateBodyForPath(settings: RSLattePluginSettings, templateRel: string): string | null {
  const p = String(templateRel ?? "").trim();
  if (!p) return null;
  if (envTemplatePathMatchesSetting(settings.diaryTemplate, p)) return ENV_DEFAULT_DAILY_MD;
  if (envTemplatePathMatchesSetting(settings.weeklyReportTemplatePath ?? "", p)) return ENV_DEFAULT_WEEKLY_MD;
  if (envTemplatePathMatchesSetting(settings.monthlyReportTemplatePath ?? "", p)) return ENV_DEFAULT_MONTHLY_MD;
  if (envTemplatePathMatchesSetting(settings.quarterlyReportTemplatePath ?? "", p)) return ENV_DEFAULT_QUARTERLY_MD;
  if (envTemplatePathMatchesSetting(settings.projectTasklistTemplatePath, p)) return ENV_DEFAULT_PROJECT_TASKLIST_MD;
  if (envTemplatePathMatchesSetting(settings.projectInfoTemplatePath, p)) return ENV_DEFAULT_PROJECT_INFO_MD;
  if (envTemplatePathMatchesSetting(settings.projectAnalysisTemplatePath, p)) {
    const r = resolveEnvTemplateVaultPath(settings.projectAnalysisTemplatePath);
    return normalizePath(r).toLowerCase().endsWith(".canvas")
      ? ENV_EMPTY_CANVAS_JSON
      : ENV_FALLBACK_PROJECT_ANALYSIS_MD;
  }
  return `# 模板\n\n`;
}

/**
 * 打开 Obsidian 内置设置页。
 * 注意：「文件与链接」在 Obsidian 1.x 的 tab id 为 **file**（非 files-and-links）。
 */
export function openObsidianSettingsTab(app: App, tabId: string): void {
  const resolved =
    tabId === "files-and-links" ? "file" : tabId;
  try {
    const st = (app as any).setting;
    if (st && typeof st.open === "function") {
      st.open();
      if (typeof st.openTabById === "function") {
        st.openTabById(resolved);
      }
    }
  } catch {
    try {
      const st = (app as any).setting;
      st?.open?.();
      st?.openTabById?.(resolved);
    } catch {
      /* ignore */
    }
  }
}

/**
 * 打开 Obsidian「核心插件」页（启用「工作区」等）。
 * `openTabById` 在 id 不匹配时返回 false 且不切换；需 fallback 到 `settingTabs` + `openTab(tab)`。
 * 从「第三方插件 → 某插件设置」内打开时，延迟再切一次，避免与关闭弹窗竞态。
 */
export function openObsidianCorePluginsTab(app: App): void {
  const tryOpen = (): boolean => {
    const st = (app as any).setting;
    if (!st) return false;
    try {
      if (typeof st.open === "function") st.open();
    } catch {
      /* ignore */
    }
    const byId = st.openTabById as ((id: string) => boolean) | undefined;
    if (typeof byId === "function") {
      for (const id of ["core-plugins", "builtin-plugins"]) {
        try {
          if (byId.call(st, id)) return true;
        } catch {
          /* try next */
        }
      }
    }
    const tabs = st.settingTabs as any[] | undefined;
    const openTab = st.openTab as ((tab: unknown) => void) | undefined;
    if (!Array.isArray(tabs) || typeof openTab !== "function") return false;
    const match = tabs.find((t: any) => {
      const id = String(t?.id ?? "");
      if (id === "core-plugins" || id === "builtin-plugins") return true;
      const name = String(t?.name ?? "");
      return name.includes("核心插件") || /core\s*plugins?/i.test(name);
    });
    if (!match) return false;
    try {
      openTab.call(st, match);
      return true;
    } catch {
      return false;
    }
  };

  if (tryOpen()) return;
  window.setTimeout(() => {
    void tryOpen();
  }, 50);
  window.setTimeout(() => {
    void tryOpen();
  }, 200);
}

/** 打开 Obsidian「第三方插件」页，便于安装或启用社区插件。 */

export function openObsidianCommunityPluginsTab(app: App): void {
  try {
    const st = (app as any).setting;
    if (st && typeof st.open === "function") {
      st.open();
      if (typeof st.openTabById === "function") {
        st.openTabById("community-plugins");
      }
    }
  } catch {
    try {
      const st = (app as any).setting;
      st?.open?.();
      st?.openTabById?.("third-party-plugin");
    } catch {
      /* ignore */
    }
  }
}
