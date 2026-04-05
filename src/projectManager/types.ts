// Project status stored in project info frontmatter and synced to DB.
// Use "in-progress" as the canonical in-progress status (legacy values may still exist in old files).
// 合法迁移与侧栏分区语义见 `projectStatus.ts`（§8.3）；中文展示见 `projectDerivatives.projectStatusDisplayZh`。
export type ProjectStatus = "todo" | "in-progress" | "done" | "cancelled" | "pending_archive" | string;

export type MilestoneTaskStatus = "done" | "todo" | "inprogress";

export interface MilestoneProgress {
  /** Leaf milestone title (the heading text without leading #). */
  name: string;
  /** Full path for multi-level milestones: L1 / L2 / L3. Unique within a project. */
  path?: string;
  /** Heading level (1~3). */
  level?: number;
  /** Parent milestone path (if any). */
  parentPath?: string;
  /** Heading line number (0-based) in source file. Useful for stable ordering. */
  headingLineNo?: number;
  /** Milestone status written under heading in tasklist file. */
  milestoneStatus?: "active" | "done" | "cancelled";
  /** 创建/激活日 (YYYY-MM-DD)；优先 meta milestone_created_date，否则由 ts= 推断 */
  created_date?: string;
  /** 实际完成日 (YYYY-MM-DD)；优先 milestone_done_date，否则由 ts= 推断 */
  done_date?: string;
  /** 实际取消日 (YYYY-MM-DD)；优先 milestone_cancelled_date，否则由 ts= 推断 */
  cancelled_date?: string;
  /** 计划完成日 (YYYY-MM-DD)，meta milestone_planned_end；仅一级里程碑维护 */
  planned_end?: string;
  /** 首次延期前计划完成日，meta milestone_original_planned_end */
  original_planned_end?: string;
  /** 里程碑延期次数，meta milestone_postpone_count */
  postpone_count?: number;
  /** 里程碑权重 1–100，meta milestone_weight；缺省按 1 */
  milestone_weight?: number;
  done: number;
  todo: number;
  inprogress: number;
  cancelled?: number;
  total: number;
  /** 快照衍生：milestone_active / milestone_done / milestone_cancelled；一级另有 milestone_overdue、milestone_soon_overdue、milestone_postponed */
  milestone_tags?: string[];
}

export interface ProjectTaskItem {
  /** 所属里程碑全路径（与清单内 `path` 一致），非仅末级标题名 */
  milestone: string;
  /** 与 `milestone` 相同，优先读取用于解析 */
  milestonePath?: string;
  lineNo: number; // 0-based in file
  statusMark: string; // " ", "/", "x", "-"
  statusName: "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED" | "UNKNOWN";
  text: string;
  rawLine: string;

  /** Stable id embedded in the task description: <!-- rslatte:task_id=... --> */
  taskId?: string;

  /** 第六节 6.6 snake_case：任务行 token 对应 */
  created_date?: string;   // ➕
  actual_start?: string;   // 🛫
  planned_start?: string;  // ⏳
  planned_end?: string;    // 📅
  done_date?: string;     // ✅
  cancelled_date?: string; // ❌

  /** Source file for write-back (usually tasklistFilePath) */
  sourceFilePath?: string;

  /** 工时评估（小时），来自下一行 meta estimate_h */
  estimate_h?: number;
  /** 任务复杂度，来自下一行 meta complexity */
  complexity?: "high" | "normal" | "light";

  /** 任务展示阶段（含闭环），来自 meta task_phase；与任务清单 reconcile 后取值一致 */
  task_phase?: "todo" | "in_progress" | "waiting_others" | "waiting_until" | "done" | "cancelled";
  /** 进度备注，来自 meta progress_note */
  progress_note?: string;
  /** 进度最后更新时间，来自 meta progress_updated */
  progress_updated?: string;
  /** 等待到期日 YYYY-MM-DD，来自 meta wait_until */
  wait_until?: string;
  /** 下一次跟进时间 YYYY-MM-DD，来自 meta follow_up */
  follow_up?: string;
  /** 关联联系人 UID 列表，来自 meta follow_contact_uids */
  follow_contact_uids?: string[];
  /** 关联联系人展示名（与 follow_contact_uids 顺序一致），来自 meta follow_contact_name（| 分隔） */
  follow_contact_names?: string[];
  /** 已延期次数，来自 meta postpone_count */
  postpone_count?: number;
  /** 首次延期前计划结束日，来自 meta original_due */
  original_due?: string;
  /** 是否星标，来自 meta starred */
  starred?: boolean;
  /** 关联日程 uid 列表，来自 meta linked_schedule_uids（逗号分隔） */
  linked_schedule_uids?: string[];

  // --- 快照衍生（第十节 项目 index 数据优化，由 applyProjectSnapshotDerivatives 写入）---
  /** 与任务清单 `task_tags` 语义对齐 + 可选 `next_action` */
  project_task_tags?: string[];
  importance_score?: number;
  importance_is_risk?: boolean;
  importance_is_today_action?: boolean;
  /** 是否为所属一级里程碑轨道的当前「下一步」 */
  is_next_action_for_l1?: boolean;
  /** 对应一级里程碑 `path` */
  next_action_root_path?: string;
}

export interface ProjectEntry {
  folderPath: string;
  projectId: string;
  projectName: string;
  status: ProjectStatus;
  /** 创建日 (YYYY-MM-DD)，frontmatter created_date，原 create */
  created_date?: string;
  /** 计划开始日，frontmatter planned_start */
  planned_start?: string;
  /** 计划结束日 (必填)，frontmatter planned_end，原 due */
  planned_end?: string;
  /** 实际开始日，frontmatter actual_start，原 start */
  actual_start?: string;
  /** 实际完成日，frontmatter done */
  done?: string;
  /** 实际取消日，frontmatter cancelled */
  cancelled?: string;
  /** 标记待笔记归档日 YYYY-MM-DD；status=pending_archive 时由「待归档」按钮写入 */
  pending_archive_at?: string;
  /** 首次延期前计划结束日，frontmatter original_planned_end */
  original_planned_end?: string;
  /** 项目延期次数，frontmatter postpone_count */
  postpone_count?: number;
  /** 最近一次延期原因，frontmatter postpone_reason */
  postpone_reason?: string;

  infoFilePath: string;
  tasklistFilePath: string;
  analysisFilePath?: string;

  milestones: MilestoneProgress[];
  taskItems?: ProjectTaskItem[];
  /** 最近一次刷新时间（ms） */
  refreshedAt: number;
  /** 最近一次参与增量判断的文件 hash/mtime key */
  mtimeKey: string;
  /** 项目最后进展更新时间，frontmatter progress_updated */
  progress_updated?: string;

  // ===== DB sync meta (best-effort, surfaced in UI) =====
  dbSyncStatus?: "ok" | "pending" | "error" | "off" | string;
  dbSyncedAt?: string; // ISO
  dbLastError?: string;
  dbPendingOps?: number;

  /** 快照衍生：risk_*、project_overdue、project_postponed、project_soon_overdue、stale_progress 等 */
  project_tags?: string[];
  /** 快照衍生：status 中文展示（第九节 9.4 概要） */
  project_status_display_zh?: string;
  /** 衍生计算所使用的任务面板「今日」键（与 getTaskTodayKey 比较可失效重算） */
  projectDerivedForYmd?: string;
}

export interface ProjectSnapshot {
  projects: ProjectEntry[];
  updatedAt: number;
}
