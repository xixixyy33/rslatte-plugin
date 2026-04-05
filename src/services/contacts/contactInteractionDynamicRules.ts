/**
 * 联系人「实际互动」与任务阶段/状态规则（与 docs/V2改造方案/03-联系人优化方案.md §6.2 对齐）。
 * 供 WorkEvent 重放与（提醒/日程等）快照合并共用。
 */

/** 弱关联：是否应记一条「离开等待/跟进」类实际互动 */
export function weakWaitingPhaseShouldRecord(phP: string, phN: string): boolean {
  const p = String(phP ?? "").trim();
  const n = String(phN ?? "").trim();
  if (p === n) return false;
  const WAIT = new Set(["waiting_until", "waiting_others"]);
  if (WAIT.has(p) && !WAIT.has(n)) return true;
  if ((p === "waiting_until" && n === "waiting_others") || (p === "waiting_others" && n === "waiting_until")) {
    return true;
  }
  return false;
}

/** 强关联：checkbox 类动作是否应记 status_change（排除与 cancelled 相关的往返）§6.2 */
export function strongTaskStatusChangeShouldRecord(prevStatus: string, nextStatus: string): boolean {
  const ps = String(prevStatus ?? "").trim().toLowerCase();
  const ns = String(nextStatus ?? "").trim().toLowerCase();
  if (ps === ns) return false;
  if (ns === "cancelled") return false;
  if (ps === "cancelled") return false;
  return true;
}

/** §6.5.2 同一条 WorkEvent 多规则命中时的优先级（数值越小越高） */
export const INTERACTION_EVENT_PRIORITY = {
  status_change: 2,
  leave_waiting: 3,
} as const;
