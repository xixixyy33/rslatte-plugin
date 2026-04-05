/**
 * V2 知识库目录结构（与 RSLatte v2统一架构草案 对齐）
 * 00-System / 10-Personal / 20-Work / 30-Knowledge / 90-Archive
 * 用于可选配置下「新内容默认写入路径」等；不改变索引/解析/同步机制。
 */
import { normalizePath } from "obsidian";

/** 顶层目录名 */
export const V2_TOP_SYSTEM = "00-System";
export const V2_TOP_PERSONAL = "10-Personal";
export const V2_TOP_WORK = "20-Work";
export const V2_TOP_KNOWLEDGE = "30-Knowledge";
export const V2_TOP_ARCHIVE = "90-Archive";

/** 00-System 子目录 */
export const V2_SYSTEM_INBOX = "00-Inbox";
export const V2_SYSTEM_TEMPLATES = "01-Templates";
export const V2_SYSTEM_VIEWS = "02-Views";
export const V2_SYSTEM_ATTACHMENTS = "03-Attachments";
export const V2_SYSTEM_SCRIPTS = "04-Scripts";

/** 10-Personal 子目录 */
export const V2_PERSONAL_DAILY = "11-Daily";
export const V2_PERSONAL_NOTES = "12-Notes";
export const V2_PERSONAL_PROJECTS = "13-Projects";
export const V2_PERSONAL_REFERENCE = "14-Reference";
export const V2_PERSONAL_CONTACTS = "15-Contacts";
export const V2_PERSONAL_TASKS = "16-Tasks";

/** 20-Work 子目录 */
export const V2_WORK_DAILY = "21-Daily";
export const V2_WORK_NOTES = "22-Notes";
export const V2_WORK_PROJECTS = "23-Projects";
export const V2_WORK_REFERENCE = "24-Reference";
export const V2_WORK_CONTACTS = "25-Contacts";
export const V2_WORK_TASKS = "26-Tasks";

/** 30-Knowledge 子目录 */
export const V2_KNOWLEDGE_PERMANENT = "31-Permanent";
export const V2_KNOWLEDGE_TOPICS = "32-Topics";
export const V2_KNOWLEDGE_OUTPUTS = "33-Outputs";

/** 90-Archive 子目录 */
export const V2_ARCHIVE_PERSONAL = "91-Personal";
export const V2_ARCHIVE_WORK = "92-Work";
export const V2_ARCHIVE_SYSTEM = "93-System";

export type V2DirectoryPaths = {
  system: string;
  personal: string;
  work: string;
  knowledge: string;
  archive: string;
  /** 个人日记目录（10-Personal/11-Daily） */
  personalDaily: string;
  /** 工作日记目录（20-Work/21-Daily） */
  workDaily: string;
  /** 知识输出目录（30-Knowledge/33-Outputs） */
  knowledgeOutputs: string;
};

/**
 * 解析 V2 内容根路径：若配置了 v2DirectoryRoot 则返回 vaultRoot/v2DirectoryRoot，否则返回 vault 根。
 * 用于 useV2DirectoryStructure 为 true 时，新内容可写入 00/10/20/30/90 下的路径。
 */
export function getEffectiveV2Root(vaultRoot: string, v2DirectoryRoot?: string): string {
  const root = String(vaultRoot ?? "").trim() || ".";
  const sub = String(v2DirectoryRoot ?? "").trim();
  if (!sub) return normalizePath(root);
  return normalizePath(`${root}/${sub}`);
}

/**
 * 在给定根目录下解析 v2 目录路径（根目录可为 vault 根或任意子目录）。
 * 不检查目录是否存在；仅做路径拼接。
 */
export function getV2DirectoryPaths(root: string): V2DirectoryPaths {
  const r = normalizePath(String(root ?? "").trim()) || ".";
  return {
    system: normalizePath(`${r}/${V2_TOP_SYSTEM}`),
    personal: normalizePath(`${r}/${V2_TOP_PERSONAL}`),
    work: normalizePath(`${r}/${V2_TOP_WORK}`),
    knowledge: normalizePath(`${r}/${V2_TOP_KNOWLEDGE}`),
    archive: normalizePath(`${r}/${V2_TOP_ARCHIVE}`),
    personalDaily: normalizePath(`${r}/${V2_TOP_PERSONAL}/${V2_PERSONAL_DAILY}`),
    workDaily: normalizePath(`${r}/${V2_TOP_WORK}/${V2_WORK_DAILY}`),
    knowledgeOutputs: normalizePath(`${r}/${V2_TOP_KNOWLEDGE}/${V2_KNOWLEDGE_OUTPUTS}`),
  };
}
