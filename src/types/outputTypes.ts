export type OutputDocStatus = "todo" | "in-progress" | "done" | "cancelled";

export type OutputTimelineTimeField = "mtime" | "create" | "done";

export type OutputTemplateDef = {
  /** Stable id used in settings UI */
  id: string;

  /** Button label in the output side panel */
  buttonName: string;

  /** Document category used in title prefix: 【文档分类】 */
  docCategory: string;

  /** Template file path in vault (optional). If no extension is provided, .md will be tried */
  templatePath: string;

  /** Archive directory, e.g. 00-Inbox/食谱 */
  archiveDir: string;

  /** Default tags written to frontmatter */
  tags: string[];

  /** Custom type written to frontmatter */
  type: string;
};

export type OutputPanelSettings = {
  /** 输出中央索引目录（用于保存 output-index.json / sync-state.json 等） */
  rslatteIndexDir: string;

  /** 与后端数据库同步开关 */
  enableDbSync: boolean;

  /** 自动归档输出文件（每日一次） */
  autoArchiveEnabled: boolean;

  /** 归档阈值（天）。DONE 的文件最后修改时间超过该值则归档 */
  archiveThresholdDays: number;

  /** 归档目录根，例如：99-Archive；归档后路径为：99-Archive/<原路径> */
  archiveRootDir: string;

  /** 上次自动归档执行日期（YYYY-MM-DD），用于每日一次 */
  archiveLastRunKey?: string;

  /** One or more archive root folders used for scanning output docs */
  archiveRoots: string[];

  /** Quick create button templates */
  templates: OutputTemplateDef[];

  /** Which time field to group and sort on the timeline */
  timelineTimeField: OutputTimelineTimeField;

  /** Max items shown in the list (1-50) */
  maxItems: number;

  /** @deprecated 已废弃：侧边栏现在按三个清单（进行中/已完成/取消）分类显示所有状态，不再需要此过滤选项 */
  showStatuses?: OutputDocStatus[];
};

export type OutputIndexItem = {
  /** Unique output identifier persisted in frontmatter: output_id */
  outputId?: string;

  filePath: string;
  title: string;

  docCategory?: string;
  tags?: string[];
  type?: string;
  status?: OutputDocStatus | string;

  /** YYYY-MM-DD */
  createDate?: string;
  /** YYYY-MM-DD */
  doneDate?: string;

  /** ISO datetime string (best-effort, when status is done) */
  doneTime?: string;

  /** YYYY-MM-DD (when status is cancelled) */
  cancelledDate?: string;

  /** ISO datetime string (best-effort, when status is cancelled) */
  cancelledTime?: string;

  /** Domains list (frontmatter key: 领域) */
  domains?: string[];

  ctimeMs?: number;
  mtimeMs?: number;
};

export type OutputIndexFile = {
  version: number;
  updatedAt: string;

  /**
   * Indexed output items.
   * NOTE: This includes active + archived items; side panel can filter by status/path as needed.
   */
  items: OutputIndexItem[];

  /**
   * Discovered per-top-level cancelled archive dirs, e.g. "02-Notes/_archived".
   * Used to avoid scanning the entire vault while still indexing cancelled docs.
   */
  cancelledArchiveDirs?: string[];
};

