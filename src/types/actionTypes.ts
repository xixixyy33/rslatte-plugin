/**
 * V2 行动体系：任务与提醒在视图层的统一抽象
 * 不改变 taskRSLatte 存储，仅提供统一状态/流转的视图模型
 */
import type { RSLatteIndexItem } from "../taskRSLatte/types";

/** 行动项统一状态（与 RSLatteStatus 对齐） */
export type ActionStatus = "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED" | "UNKNOWN";

/** 行动项类型 */
export type ActionItemKind = "task" | "memo";

/**
 * 行动项视图模型：任务与提醒在「行动总览」中的统一呈现
 * 基于 RSLatteIndexItem，增加展示用字段
 */
export interface ActionItemView {
  /** 来源：task 索引 或 memo 索引 */
  kind: ActionItemKind;
  /** 统一状态 */
  status: ActionStatus;
  /** 展示用标题/描述 */
  text: string;
  /** 到期日（任务有；提醒可能用 memoDate） */
  dueDate?: string;
  /** 完成/取消日期 */
  doneDate?: string;
  cancelledDate?: string;
  /** 文件路径（用于跳转） */
  filePath: string;
  lineNo: number;
  /** 原始索引项，便于后续操作 */
  raw: RSLatteIndexItem;
}

export function toActionStatus(s: string | undefined): ActionStatus {
  const st = String(s ?? "").toUpperCase();
  if (st === "TODO" || st === "IN_PROGRESS" || st === "DONE" || st === "CANCELLED") return st;
  if (st === "IN-PROGRESS") return "IN_PROGRESS";
  return "UNKNOWN";
}

/** 将任务/提醒索引项转为行动项视图 */
export function toActionItemView(it: RSLatteIndexItem): ActionItemView {
  const kind: ActionItemKind = (it as any).itemType === "memo" ? "memo" : "task";
  const status = toActionStatus((it as any).status);
  return {
    kind,
    status,
    text: (it as any).text ?? "",
    dueDate: (it as any).planned_end,
    doneDate: (it as any).done_date,
    cancelledDate: (it as any).cancelled_date,
    filePath: (it as any).filePath ?? "",
    lineNo: (it as any).lineNo ?? 0,
    raw: it,
  };
}
