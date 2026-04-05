/** 输出存档区 `.history` 长期 JSON 台账（与《知识类管理优化方案》§3.5.1 对齐） */

export const OUTPUT_LEDGER_VERSION = 1 as const;

export const OUTPUT_HISTORY_DIR = ".history";

export const OUTPUT_LEDGER_FILE = "output-ledger.json";

/** 台账事件类型（可扩展） */
export type OutputHistoryEventAction =
  | "publish_to_knowledge"
  | "recall_from_knowledge"
  | "output_created"
  | "output_updated"
  | "output_archived_from_index"
  /** 输出侧栏等方式修改 status / waiting_until */
  | "output_status_changed";

export type OutputHistoryEvent = {
  ts: string;
  action: OutputHistoryEventAction;
  knowledge_path?: string;
  source_output_path?: string;
  output_id?: string;
  /** 复制发布时：源稿上的 output_id，便于与 event.output_id（新稿）区分溯源 */
  copied_from_output_id?: string;
  knowledge_bucket?: string;
  mode?: "move" | "copy";
  note?: string;
  /** 状态变更前（输出工序台账） */
  status_before?: string;
  /** 状态变更后 */
  status_after?: string;
  /** waiting_until 时的 resume_at（YYYY-MM-DD） */
  resume_at?: string;
  /** 发布前输出稿 frontmatter 摘要（仅存少量键，见 ledger 写入逻辑） */
  pre_publish_fm_snapshot?: Record<string, unknown>;
  /** 主索引归档到按月归档索引时的月份键 YYYY-MM */
  archive_month_key?: string;
};

export type OutputLedgerKnowledgeEntry = {
  output_id?: string;
  last_source_output_path?: string;
  last_knowledge_path?: string;
  last_published_at?: string;
  last_bucket?: string;
  events: OutputHistoryEvent[];
};

/** 按「源输出路径」聚合的事件（创建、主索引迁出归档等，与 byKnowledgePath 互补） */
export type OutputLedgerSourcePathEntry = {
  output_id?: string;
  events: OutputHistoryEvent[];
};

export type OutputLedgerFileV1 = {
  version: 1;
  updated_at?: string;
  byKnowledgePath: Record<string, OutputLedgerKnowledgeEntry>;
  /** 可选：旧文件无此字段时按空处理 */
  bySourceOutputPath?: Record<string, OutputLedgerSourcePathEntry>;
};
