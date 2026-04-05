/** 中央 `knowledge-index.json`（§5.3，与《知识类管理优化方案》对齐） */

export const KNOWLEDGE_INDEX_VERSION = 1 as const;

export type KnowledgeIndexItemV1 = {
  path: string;
  basename: string;
  mtimeMs: number;
  output_id?: string;
  knowledge_bucket?: string;
  /** frontmatter 全量快照（去掉 position 等编辑器内部键） */
  frontmatter?: Record<string, unknown>;
  /** 常用派生字段，便于概览统计直接读索引 */
  published_at?: string;
  published_space_id?: string;
  published_space_name?: string;
  doc_category?: string;
  domains?: string[];
  type?: string;
  output_document_kind?: string;
  create?: string;
};

export type KnowledgeIndexFileV1 = {
  version: typeof KNOWLEDGE_INDEX_VERSION;
  updatedAt: string;
  knowledgeRoot: string;
  items: KnowledgeIndexItemV1[];
};
