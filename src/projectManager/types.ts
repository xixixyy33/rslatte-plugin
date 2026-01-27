// Project status stored in project info frontmatter and synced to DB.
// Use "in-progress" as the canonical in-progress status (legacy values may still exist in old files).
export type ProjectStatus = "todo" | "in-progress" | "done" | "cancelled" | string;

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
  /** Creation date (YYYY-MM-DD) from rslatte comment ts field */
  createdDate?: string;
  /** Done date (YYYY-MM-DD) from rslatte comment ts field when milestone_status=done */
  doneDate?: string;
  /** Cancelled date (YYYY-MM-DD) from rslatte comment ts field when milestone_status=cancelled */
  cancelledDate?: string;
  done: number;
  todo: number;
  inprogress: number;
  cancelled?: number;
  total: number;
}

export interface ProjectTaskItem {
  milestone: string;
  /** Full milestone path (L1 / L2 / L3). */
  milestonePath?: string;
  lineNo: number; // 0-based in file
  statusMark: string; // " ", "/", "x", "-"
  statusName: "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED" | "UNKNOWN";
  text: string;
  rawLine: string;

  /** Stable id embedded in the task description: <!-- rslatte:task_id=... --> */
  taskId?: string;

  /** Optional Task Calendar Wrapper style dates (YYYY-MM-DD) */
  createdDate?: string;   // ➕
  startDate?: string;     // 🛫
  scheduledDate?: string; // ⏳
  dueDate?: string;       // 📅
  doneDate?: string;      // ✅
  cancelledDate?: string; // ❌

  /** Source file for write-back (usually tasklistFilePath) */
  sourceFilePath?: string;
}

export interface ProjectEntry {
  folderPath: string;
  projectId: string;
  projectName: string;
  status: ProjectStatus;
  create?: string;
  due?: string;
  start?: string;
  done?: string;
  cancelled?: string;

  infoFilePath: string;
  tasklistFilePath: string;
  analysisFilePath?: string;

  milestones: MilestoneProgress[];
  taskItems?: ProjectTaskItem[];
  /** 最近一次刷新时间（ms） */
  refreshedAt: number;
  /** 最近一次参与增量判断的文件 hash/mtime key */
  mtimeKey: string;

  // ===== DB sync meta (best-effort, surfaced in UI) =====
  dbSyncStatus?: "ok" | "pending" | "error" | "off" | string;
  dbSyncedAt?: string; // ISO
  dbLastError?: string;
  dbPendingOps?: number;
}

export interface ProjectSnapshot {
  projects: ProjectEntry[];
  updatedAt: number;
}
