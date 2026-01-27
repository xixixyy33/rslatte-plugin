/**
 * Step S2: RunResult / RunSummary stabilization.
 *
 * 目标：
 * - 定义稳定的 PipelineRunSummary（start/end/steps/statsBefore/after/gate/lockKey）
 * - Engine 组装统一填充该结构
 * - 保留旧结构字段（例如 result.summary.metrics / result.gate / result.steps）
 *   通过映射填充，避免 UI / 调度层额外 if/else。
 */

import type { RSLatteError, RSLatteLockKey, RSLatteModuleKey, RSLattePipelineMode } from "./types";
import type { RSLatteModuleOpSummary, RSLatteReconcileGate } from "./moduleSpec";
import type { ReconcileGateEvaluation } from "./gates";

/** 单步执行记录（与 E2 step 结构保持一致） */
export type PipelineRunStep = {
  phase: string;
  op: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  error?: RSLatteError;
};

/**
 * ✅ 稳定化的 RunSummary（UI / coordinator / debug 统一读取该结构）
 * - statsBefore / statsAfter：优先承载 reconcile gate（pre/post），不引入额外 stats 调用
 */
export type PipelineRunSummary = {
  moduleKey: RSLatteModuleKey;
  mode: RSLattePipelineMode;
  runId: string;

  lockKey: RSLatteLockKey;

  startedAt: string;
  finishedAt: string;

  steps: PipelineRunStep[];

  /** pre gate（可选） */
  statsBefore?: RSLatteReconcileGate;
  /** post gate（可选） */
  statsAfter?: RSLatteReconcileGate;

  /** 兼容字段：最终 gate（通常等于 statsAfter） */
  gate?: RSLatteReconcileGate;

  /** Step S6: reconcile gate evaluation (allowed/reason/debug) */
  reconcileGate?: ReconcileGateEvaluation;

  /**
   * 旧结构兼容：
   * - legacySummary.metrics（归档 count 等）
   * - legacySummary.message（cutoffDate 等）
   */
  legacySummary?: RSLatteModuleOpSummary;
};

/**
 * 统一结果结构（稳定版）。
 *
 * 说明：
 * - runSummary 为稳定入口
 * - 同时保留旧字段：summary/gate/steps/reconcile...
 */
export type PipelineRunResultStable = {
  moduleKey: RSLatteModuleKey;
  mode: RSLattePipelineMode;
  runId: string;
  skipped: boolean;
  reason?: string;

  lockKey: RSLatteLockKey;

  runSummary: PipelineRunSummary;

  // -----------------
  // Legacy / Compatibility fields
  // -----------------

  /** 旧：模块 summary（例如 mkSummary 返回） */
  summary?: RSLatteModuleOpSummary;
  /** 旧：E2 gate 顶层字段 */
  gate?: RSLatteReconcileGate;
  /** 旧：E2 steps 顶层字段 */
  steps?: PipelineRunStep[];

  /** 旧：reconcile 结构 */
  reconcile?: {
    executed: boolean;
    skipped?: boolean;
    reason?: string;
    summary?: RSLatteModuleOpSummary;
  };
};
