import {
  V2_KNOWLEDGE_OUTPUTS,
  V2_KNOWLEDGE_PERMANENT,
  V2_KNOWLEDGE_TOPICS,
} from "../constants/v2Directory";

/** 知识库一级子目录（与 `v2Directory.ts` 锁定一致） */
export type KnowledgeTier1Folder =
  | typeof V2_KNOWLEDGE_PERMANENT
  | typeof V2_KNOWLEDGE_TOPICS
  | typeof V2_KNOWLEDGE_OUTPUTS;

/** 设置表格：各一级目录下的二级路径段 */
export type KnowledgeSecondarySubdirDef = {
  tier1: KnowledgeTier1Folder;
  /** 二级文件夹名（单段，如 `Public`，不含 `/`） */
  folderName: string;
  /** 说明（仅设置页展示） */
  description?: string;
  sort?: number;
};

export type KnowledgePanelSettings = {
  secondarySubdirs: KnowledgeSecondarySubdirDef[];
  /** 与 `knowledge_docs` 入库对齐；默认关，需合法 `apiBaseUrl` */
  enableDbSync?: boolean;
  /** 已执行：从配置中剔除曾随默认种子提供的 5 个二级目录（仅一次，避免环境检查仍要求创建） */
  legacyDefaultSubdirsPruned2026?: boolean;
};

/** 与 `knowledge_bucket` 枚举对应 */
export type KnowledgeBucket = "permanent" | "topics" | "outputs";

export function tier1ToKnowledgeBucket(tier1: KnowledgeTier1Folder): KnowledgeBucket {
  if (tier1 === V2_KNOWLEDGE_PERMANENT) return "permanent";
  if (tier1 === V2_KNOWLEDGE_TOPICS) return "topics";
  return "outputs";
}

/** 新安装默认种子（§2.1） */
export const DEFAULT_KNOWLEDGE_SECONDARY_SUBDIRS: KnowledgeSecondarySubdirDef[] = [
  { tier1: V2_KNOWLEDGE_PERMANENT, folderName: "Principles", description: "原则", sort: 10 },
  { tier1: V2_KNOWLEDGE_PERMANENT, folderName: "Patterns", description: "模式", sort: 20 },
  { tier1: V2_KNOWLEDGE_PERMANENT, folderName: "Heuristics", description: "启发式 / 经验法则", sort: 40 },
  { tier1: V2_KNOWLEDGE_TOPICS, folderName: "Personal-Management", description: "个人管理等主题域", sort: 10 },
  { tier1: V2_KNOWLEDGE_TOPICS, folderName: "Obsidian-Plugin", description: "工具 / 插件", sort: 20 },
  { tier1: V2_KNOWLEDGE_OUTPUTS, folderName: "Public", description: "博客、开源 README、公开分享", sort: 10 },
  { tier1: V2_KNOWLEDGE_OUTPUTS, folderName: "Project-Deliverables", description: "对外交付类产出", sort: 20 },
  { tier1: V2_KNOWLEDGE_OUTPUTS, folderName: "Reusable-Docs", description: "可跨项目对外复用文档", sort: 30 },
];

function knowledgeSecondaryKey(r: Pick<KnowledgeSecondarySubdirDef, "tier1" | "folderName">): string {
  return `${r.tier1}|${String(r.folderName ?? "").trim()}`;
}

/** 已从默认种子移除的（tier1|folderName）；启动迁移时从持久化配置剔除一次 */
export const REMOVED_LEGACY_KNOWLEDGE_SECONDARY_KEYS = new Set<string>([
  knowledgeSecondaryKey({ tier1: V2_KNOWLEDGE_PERMANENT, folderName: "Checklists" }),
  knowledgeSecondaryKey({ tier1: V2_KNOWLEDGE_PERMANENT, folderName: "Glossary" }),
  knowledgeSecondaryKey({ tier1: V2_KNOWLEDGE_TOPICS, folderName: "Finance-Analysis" }),
  knowledgeSecondaryKey({ tier1: V2_KNOWLEDGE_TOPICS, folderName: "Linux" }),
  knowledgeSecondaryKey({ tier1: V2_KNOWLEDGE_TOPICS, folderName: "Cpp" }),
]);

export function withoutRemovedLegacyKnowledgeSubdirs(
  rows: KnowledgeSecondarySubdirDef[] | undefined,
): KnowledgeSecondarySubdirDef[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => !REMOVED_LEGACY_KNOWLEDGE_SECONDARY_KEYS.has(knowledgeSecondaryKey(r)));
}
