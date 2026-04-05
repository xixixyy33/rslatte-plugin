/**
 * ## 输出索引：物理扫描 vs 台账合并（§8.4 / 《代码结构优化方案》）
 *
 * **单一数据源说明**（避免只读 `service.ts` 或只读设置文案导致理解偏半套）：
 *
 * 1. **主扫描根（磁盘 walk）**
 *    - 配置项：**`outputPanel.archiveRoots`**（可多根），与运行时 **`OutputRSLatteService.collectProjectProFilesRoots()`** 发现的各项目 **`…/pro_files`** 合并、去重后，作为 **active / full 的第一步**递归扫描来源（见 `mergeOutputPrimaryScanRoots`）。
 *    - 空列表：**不扫 Vault**，保留上一快照与 `cancelledArchiveDirs` 缓存，避免误全库扫描。
 *
 * 2. **旧版物理归档目录（可选的第二段磁盘 walk）**
 *    - 仅 **`refreshIndexNow({ mode: "full" })`** 且 **`fullRebuildScanLegacyArchiveDirs !== false`（默认 true）** 时追加：
 *      - **`archiveRootDir`**（如 `99-Archive`，DONE 笔记归档目的地）；
 *      - 各顶层扫描根推导出的 **`{top}/_archived`**（取消类历史布局），与快照中已缓存的取消归档目录合并发现。
 *    - 设为 **false** 时：主流程以 **扫描根 + 台账** 为主，减少对独立归档树的依赖；DONE 仍留在知识库路径下的条目靠 **索引时间窗归档** + 台账事件（见下）。
 *
 * 3. **台账 `.history/output-ledger.json`（合并，非替代扫描）**
 *    - 文件位置：每个 **`archiveRoots` 归属根** 下的 **`.history/output-ledger.json`**（见 `outputHistoryLedger.ts`）。
 *    - **全量/active 扫描结束后**执行 **`readMergedOutputLedgerMaps` → `mergeLedgerKnowledgePathsIntoScan`**：把台账里记录、但本次磁盘 walk 尚未收录的 **知识库 `.md` 路径** 补进索引（发布到知识库后主流程可不依赖再扫物理归档目录）。
 *    - **索引归档迁出**时写入 **`output_archived_from_index`** 等事件，仍落回归属根下台账。
 *
 * **执行顺序（与实现对齐）**：扫描 `archiveRoots`+`pro_files` →（full 且未关 legacy）`archiveRootDir` + `_archived` → **合并台账知识库路径** → 写主索引 → `archiveIndexForArchivedFiles`（§10.6）。
 *
 * **产品/索引权威文档**：`docs/V2改造方案/10-索引优化方案.md` **§10.6**；Pipeline 行为见 **`outputSpecAtomic`** 与 **`outputRefreshScanPlan.ts`**（`buildOutputRefreshScanPlan` 描述 legacy 开关与模式）。
 */

/** 设置「创建输出」弹窗中追加的自定义 YAML 标量（§3.2.2） */
export type OutputCreateExtraFieldDef = {
  /** YAML 键名（英文 id） */
  id: string;
  /** 弹窗展示标签 */
  label: string;
  placeholder?: string;
  /** 多行时使用 | 块写入 */
  multiline?: boolean;
};

export type OutputTemplateScope = "general" | "project";

/** 输出生命周期状态（与 §10.1 对齐，含 waiting_until） */
export type OutputDocStatus = "todo" | "in-progress" | "waiting_until" | "done" | "cancelled";

export type OutputTimelineTimeField = "mtime" | "create" | "done";
export type OutputListFilterMode = "general" | "project" | "all";

export type OutputTemplateDef = {
  /** Stable id used in settings UI */
  id: string;

  /** 一般 / 项目；缺省按 general */
  templateScope?: OutputTemplateScope;

  /** 关闭后不出现在任何创建入口；缺省 true */
  enabled?: boolean;

  /** 项目模板：相对项目根目录的子路径（与 CreateProjectArchiveDocModal 的 targetRelPath 对齐） */
  projectTargetRelPath?: string;

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

  /**
   * 输出文档扫描根（可多根）：全量/增量重建时 **第一段磁盘递归** 的起点；并与各项目 **`pro_files`** 合并（见 `mergeOutputPrimaryScanRoots`）。
   * 台账文件 **`.history/output-ledger.json`** 也按归属根挂在此类路径下（§8.4 文件头说明）。
   */
  archiveRoots: string[];

  /**
   * 全量重建（🧱）时是否仍扫描「输出笔记归档根目录」与各顶层的 `_archived`。
   * - **true（默认）**：兼容曾将 DONE 笔记搬到 `archiveRootDir`、取消类进 `_archived` 的旧库。
   * - **false**：主流程以「输出文档扫描根目录」+ `.history/output-ledger` 合并为准；DONE 且留在扫描根（如知识库目录）下的条目按 **archiveThresholdDays** 仅做 **索引归档**，并写台账 `output_archived_from_index`。
   * @see 本文件顶部 §8.4、`buildOutputRefreshScanPlan`、《索引优化方案》§10.6
   */
  fullRebuildScanLegacyArchiveDirs?: boolean;

  /** Quick create button templates */
  templates: OutputTemplateDef[];

  /** Which time field to group and sort on the timeline */
  timelineTimeField: OutputTimelineTimeField;

  /** Max items shown in the list (1-50) */
  maxItems: number;

  /** 各模板 id -> 快速创建次数（用于侧栏 Top4） */
  templateCreateCounts?: Record<string, number>;

  /** 进行中/已完成/取消清单：是否显示一般输出（output_document_kind 非 project 且无 project_id） */
  listFilterShowGeneral?: boolean;

  /** 清单：是否显示项目输出 */
  listFilterShowProject?: boolean;

  /** 清单筛查模式：一般输出 / 项目输出 / 全部输出 */
  listFilterMode?: OutputListFilterMode;

  /** 创建输出弹窗：自定义属性定义（值写入 YAML 标量；禁止与保留键冲突） */
  createOutputExtraFields?: OutputCreateExtraFieldDef[];

  /** 侧栏「进行中」清单折叠 */
  inProgressListCollapsed?: boolean;
  /** 侧栏「已完成」清单折叠 */
  doneListCollapsed?: boolean;
  /** 侧栏「取消」清单折叠 */
  cancelledListCollapsed?: boolean;

  /** 侧栏主区页签：`list` 正在输出清单；`knowledge_publish` 发布管理（浏览 30-Knowledge、打回） */
  sidePanelMainTab?: "list" | "knowledge_publish";

  /** @deprecated 已废弃：侧边栏现在按三个清单（进行中/已完成/取消）分类显示所有状态，不再需要此过滤选项 */
  showStatuses?: OutputDocStatus[];
};

export type OutputIndexItem = {
  /** Unique output identifier persisted in frontmatter: output_id */
  outputId?: string;

  filePath: string;
  title: string;

  /** general | project（frontmatter: output_document_kind） */
  outputDocumentKind?: "general" | "project";

  docCategory?: string;
  tags?: string[];
  type?: string;
  status?: OutputDocStatus | string;

  projectId?: string;
  projectName?: string;

  /** YYYY-MM-DD，来自 resume_at */
  resumeAt?: string;

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

  /** 关联日程 uid（frontmatter `linked_schedule_uid`，与 schedule-index 条目 uid 一致） */
  linkedScheduleUid?: string;
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

/** 归一化模板行（加载设置后调用） */
export function normalizeOutputTemplateDef(t: Partial<OutputTemplateDef> & Record<string, unknown>): void {
  if (t.templateScope !== "general" && t.templateScope !== "project") t.templateScope = "general";
  if (t.enabled === undefined) t.enabled = true;
}

/** 侧栏快速创建：仅 general 且启用 */
export function isQuickCreateOutputTemplate(t: OutputTemplateDef | null | undefined): boolean {
  if (!t || !(t.buttonName || t.docCategory)) return false;
  if (t.enabled === false) return false;
  const scope = t.templateScope ?? "general";
  return scope === "general";
}

/** 索引项是否归为「项目输出」（筛选用） */
export function outputIndexItemIsProjectKind(it: OutputIndexItem): boolean {
  const k = String(it.outputDocumentKind ?? "").trim();
  if (k === "project") return true;
  if (String(it.projectId ?? "").trim()) return true;
  return false;
}
