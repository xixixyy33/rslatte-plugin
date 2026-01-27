/**
 * Step S6: Reconcile Gate evaluator (single source)
 *
 * 目标：把 reconcile 门控规则收敛到 evaluateReconcileGate(...)
 * - 不改变 gate 规则，仅集中实现
 * - 输出 {allowed, reason, debug}
 */

import type { RSLattePipelineMode } from "./types";
import type { RSLatteReconcileGate } from "./moduleSpec";

export type ReconcileGateReason =
  | "MODE_NOT_ALLOWED"
  | "DBSYNC_DISABLED"
  | "QUEUE_NOT_EMPTY"
  | "DIRTY_FILES"
  | "DELTA_TOO_LARGE";

export type ReconcileGateEvaluation = {
  allowed: boolean;
  reason?: ReconcileGateReason;
  /** 便于 tooltip/debug log 的结构化信息（不影响业务逻辑） */
  debug?: {
    mode: RSLattePipelineMode;
    thresholdDeltaSize: number;
    dbSyncEnabled: boolean;
    pendingCount: number;
    failedCount: number;
    deltaSize?: number;
    uidMissingCount: number;
    parseErrorCount: number;
    dirtyCount: number;
    gate?: RSLatteReconcileGate;
  };
};

export function evaluateReconcileGate(args: {
  mode: RSLattePipelineMode;
  gate?: RSLatteReconcileGate;
  /** 与既有实现保持一致：deltaSize > 200 视为过大 */
  deltaTooLargeThreshold?: number;
}): ReconcileGateEvaluation {
  const threshold = Number.isFinite(args.deltaTooLargeThreshold as any)
    ? Number(args.deltaTooLargeThreshold)
    : 200;

  const gate: RSLatteReconcileGate = args.gate ?? {};
  const pending = toNum((gate as any).pendingCount);
  const failed = toNum((gate as any).failedCount);

  const uidMissingCount = toNum((gate as any).uidMissingCount);
  const parseErrorCount = toNum((gate as any).parseErrorCount);
  const dirtyCount = toNum((gate as any).dirtyCount) || (uidMissingCount + parseErrorCount);

  const deltaRaw = (gate as any).deltaSize;
  const deltaN = Number(deltaRaw);
  const deltaSize = Number.isFinite(deltaN) ? deltaN : undefined;

  const dbSyncEnabled = gate.dbSyncEnabled === true;

  const debug = {
    mode: args.mode,
    thresholdDeltaSize: threshold,
    dbSyncEnabled,
    pendingCount: pending,
    failedCount: failed,
    deltaSize,
    uidMissingCount,
    parseErrorCount,
    dirtyCount,
    gate,
  };

  // 规则 0：仅 manual_refresh / rebuild 可能 reconcile；其余模式一律不允许
  if (!(args.mode === "manual_refresh" || args.mode === "rebuild")) {
    return { allowed: false, reason: "MODE_NOT_ALLOWED", debug };
  }

  // 规则 1：dbSync 未启用
  if (!dbSyncEnabled) {
    return { allowed: false, reason: "DBSYNC_DISABLED", debug };
  }

  // 规则 2：队列未清空（pending/failed > 0）
  if (pending > 0 || failed > 0) {
    return { allowed: false, reason: "QUEUE_NOT_EMPTY", debug };
  }

  // 规则 2.5：仅对“干净文件”执行（无 uidMissing / parseError）
  if (dirtyCount > 0) {
    return { allowed: false, reason: "DIRTY_FILES", debug };
  }

  // 规则 3：delta 过大（>200）建议 rebuild
  if (typeof deltaSize === "number" && deltaSize > threshold) {
    return { allowed: false, reason: "DELTA_TOO_LARGE", debug };
  }

  return { allowed: true, debug };
}

function toNum(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
