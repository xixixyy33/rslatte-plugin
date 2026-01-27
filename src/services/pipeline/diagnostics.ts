import type { RSLatteModuleKey } from "./types";
import type { PipelineRunStep, PipelineRunSummary } from "./runResult";

/**
 * Step S9: Pipeline diagnostics helper
 *
 * 目标：不改业务逻辑，仅让回归更快。
 * - 记录最近一次 run summary（per-module）
 * - debug 开关开启时，输出结构化 summary：steps / statsBefore/After / gate / lockKey
 */

const _lastByModule = new Map<RSLatteModuleKey, PipelineRunSummary>();

export function recordLastRunSummary(summary: PipelineRunSummary): void {
  try {
    _lastByModule.set(summary.moduleKey, summary);
  } catch {
    // ignore
  }
}

function elapsedMsFromIso(startedAt?: string, finishedAt?: string): number {
  const s = Date.parse(startedAt ?? "");
  const f = Date.parse(finishedAt ?? "");
  if (!Number.isFinite(s) || !Number.isFinite(f)) return 0;
  return Math.max(0, f - s);
}

function simplifySteps(steps: PipelineRunStep[]): Array<{
  phase: string;
  op: string;
  ok: boolean;
  elapsedMs: number;
}> {
  return (steps ?? []).map((s) => ({
    phase: String((s as any).phase ?? ""),
    op: String((s as any).op ?? ""),
    ok: (s as any).ok === true,
    elapsedMs: elapsedMsFromIso((s as any).startedAt, (s as any).finishedAt),
  }));
}

export type PipelineDiagnosticsPrinter = (prefix: string, message: string, data?: any) => void;

/**
 * 输出结构化 runSummary。
 *
 * - 不改变日志前缀规范：由调用方传入 prefix（应为 [RSLatte][moduleKey][mode]）
 * - 建议仅在 debug 开关开启时调用
 */
export function printRunSummaryDiagnostics(args: {
  prefix: string;
  summary: PipelineRunSummary;
  printer?: PipelineDiagnosticsPrinter;
}): void {
  const { prefix, summary, printer } = args;
  const p: PipelineDiagnosticsPrinter = printer ?? ((pf, msg, data) => {
    if (data === undefined) console.log(pf, msg);
    else console.log(pf, msg, data);
  });

  const payload = {
    moduleKey: summary.moduleKey,
    mode: summary.mode,
    runId: summary.runId,
    lockKey: summary.lockKey,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    steps: simplifySteps(summary.steps ?? []),
    statsBefore: summary.statsBefore,
    statsAfter: summary.statsAfter,
    gate: summary.gate,
    reconcileGate: (summary as any).reconcileGate,
    legacyMetrics: (summary.legacySummary as any)?.metrics,
  };

  p(prefix, "diag runSummary", payload);
}

export function printRunFailureDiagnostics(args: {
  prefix: string;
  moduleKey: RSLatteModuleKey;
  mode: any;
  runId: string;
  lockKey: any;
  startedAt: string;
  steps: PipelineRunStep[];
  error: any;
  printer?: PipelineDiagnosticsPrinter;
}): void {
  const { prefix, moduleKey, mode, runId, lockKey, startedAt, steps, error, printer } = args;
  const p: PipelineDiagnosticsPrinter = printer ?? ((pf, msg, data) => {
    if (data === undefined) console.log(pf, msg);
    else console.log(pf, msg, data);
  });

  const payload = {
    moduleKey,
    mode,
    runId,
    lockKey,
    startedAt,
    steps: simplifySteps(steps ?? []),
    error,
  };

  p(prefix, "diag run failed", payload);
}
