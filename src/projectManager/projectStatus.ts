/**
 * §8.3 项目状态机（《代码结构优化方案》）
 *
 * 约定 frontmatter `status` 的规范值与**合法迁移**，供 `ProjectManagerService`、侧栏、进度筛选、风险统计、DB 字段映射共用。
 * **中文展示**仍以 `projectDerivatives.projectStatusDisplayZh` 为唯一入口。
 *
 * 合法迁移（产品语义）：
 * - **标记待归档**：仅 **`done` → `pending_archive`**（写入 `pending_archive_at`）；**禁止**对 `cancelled` / `pending_archive` / `todo` / `in-progress` 调用。
 * - **恢复**：**`pending_archive` → `done`**（清除待归档字段）；**`cancelled` 或 `done`（非待归档）→ `in-progress`**（清除取消相关字段）。
 * - **完成 / 取消**：见 `markDone` / `markCancelled`（会清除互斥字段）。
 */

import type { ProjectStatus } from "./types";

/** 规范化项目 status（兼容 legacy 拼写）；未知字符串原样保留以满足 `ProjectStatus` 类型。 */
export function normalizeProjectStatus(input: unknown): ProjectStatus {
  const raw = String(input ?? "").trim();
  const t = raw.toLowerCase();
  if (!t) return "todo";
  if (t === "todo") return "todo";
  if (t === "done") return "done";
  if (t === "cancelled" || t === "canceled") return "cancelled";
  if (t === "in-progress" || t === "inprogress" || t === "in_progress") return "in-progress";
  if (t === "pending_archive" || t === "pending-archive" || t === "pendingarchive") return "pending_archive";
  return raw as ProjectStatus;
}

/** 是否允许 `markPendingArchive`（仅已完成）。 */
export function canMarkPendingArchive(st: unknown): boolean {
  return normalizeProjectStatus(st) === "done";
}

const ERR_PENDING_ARCHIVE_ONLY_FROM_DONE = "仅「已完成」的项目可标记为待归档";

/** 与 `markPendingArchive` 内校验一致；不通过时抛错。 */
export function assertCanMarkPendingArchive(st: unknown): void {
  if (!canMarkPendingArchive(st)) {
    throw new Error(ERR_PENDING_ARCHIVE_ONLY_FROM_DONE);
  }
}

/** `recoverProject` 写回 frontmatter 与 WorkEvent.ref.status 的决策（不含副作用）。 */
export function getRecoverProjectTransition(current: unknown): {
  nextFmStatus: "done" | "in-progress";
  refStatus: "done" | "in-progress";
  clearPendingArchiveFields: boolean;
  clearCancelledFields: boolean;
  workEventSummaryPrefix: string;
} {
  const cur = normalizeProjectStatus(current);
  if (cur === "pending_archive") {
    return {
      nextFmStatus: "done",
      refStatus: "done",
      clearPendingArchiveFields: true,
      clearCancelledFields: false,
      workEventSummaryPrefix: "↩ 取消待归档",
    };
  }
  return {
    nextFmStatus: "in-progress",
    refStatus: "in-progress",
    clearPendingArchiveFields: false,
    clearCancelledFields: true,
    workEventSummaryPrefix: "🔄 项目恢复",
  };
}

/** 「进行中项目」主列表：排除完成、取消、待归档（与侧栏第一节一致）。 */
export function isProjectShownInInProgressList(st: unknown): boolean {
  const n = normalizeProjectStatus(st);
  return n !== "done" && n !== "cancelled" && n !== "pending_archive";
}

/** 「已完成的项目」区块：仅 `done`（不含 `pending_archive`，待归档有独立区块）。 */
export function isProjectDoneSectionMember(st: unknown): boolean {
  return normalizeProjectStatus(st) === "done";
}

/** 「待归档项目」区块。 */
export function isProjectPendingArchiveSectionMember(st: unknown): boolean {
  return normalizeProjectStatus(st) === "pending_archive";
}

/** 「取消项目」区块。 */
export function isProjectCancelledSectionMember(st: unknown): boolean {
  return normalizeProjectStatus(st) === "cancelled";
}

/**
 * 「项目进度管理」筛选归类：待归档与已完成同属 **done** 组（勾选「已完成」时两者都可见）。
 * 未知 status 归入 **other**，与「进行中」筛选联动行为与旧实现一致。
 */
export function projectProgressFilterCategory(p: { status?: unknown }): "todo" | "in-progress" | "done" | "cancelled" | "other" {
  const raw = String(p.status ?? "").trim().toLowerCase();
  if (raw === "todo") return "todo";
  if (raw === "pending_archive") return "done";
  if (raw === "done") return "done";
  if (raw === "cancelled" || raw === "canceled") return "cancelled";
  if (raw === "in-progress" || raw === "inprogress" || raw === "in_progress") return "in-progress";
  return "other";
}

/** 风险分等：未「结案」——进行中/待开始等（排除 done、pending_archive、cancelled）。 */
export function isProjectOpenForRiskSummary(st: unknown): boolean {
  const n = normalizeProjectStatus(st);
  return n !== "done" && n !== "pending_archive" && n !== "cancelled";
}

/** 写入任务清单等场景：若当前项目已为终态则不要把 status 强行改成 in-progress。 */
export function isProjectTerminalForCoerceInProgress(st: unknown): boolean {
  const n = normalizeProjectStatus(st);
  return n === "done" || n === "cancelled" || n === "pending_archive";
}

/**
 * 侧栏摘要/延期判断等：**结案态**（与 `fillProjectManagementActionButtons` 分支一致）。
 * 含美式 `canceled`；未知大小写先 toLowerCase。
 */
export function isProjectClosedForUiSummary(st: unknown): boolean {
  const raw = String(st ?? "").trim().toLowerCase();
  return raw === "done" || raw === "pending_archive" || raw === "cancelled" || raw === "canceled";
}

/** 笔记归档 `archiveDoneAndCancelledNow`：仅搬迁待归档与已取消。 */
export function isProjectEligibleForFolderArchiveByStatus(st: unknown): boolean {
  const n = normalizeProjectStatus(st);
  return n === "pending_archive" || n === "cancelled";
}
