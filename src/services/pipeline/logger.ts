import type { RSLatteLockKey, RSLatteModuleKey, RSLattePipelineMode, RSLatteError } from "./types";

/**
 * Step S7: Pipeline step logger
 *
 * Goals:
 * - keep prefix convention: [RSLatte][moduleKey][mode]
 * - standardize step logs: start / ok / fail
 * - always include: runId / lockKey / moduleKey / mode / elapsedMs
 */

export type PipelineLogContext = {
  moduleKey: RSLatteModuleKey;
  mode: RSLattePipelineMode;
  runId: string;
  lockKey: RSLatteLockKey;
  /** MUST start with [RSLatte][moduleKey][mode] */
  prefix: string;
};

type BaseFields = {
  runId: string;
  lockKey: RSLatteLockKey;
  moduleKey: RSLatteModuleKey;
  mode: RSLattePipelineMode;
};

function base(ctx: PipelineLogContext): BaseFields {
  return {
    runId: ctx.runId,
    lockKey: ctx.lockKey,
    moduleKey: ctx.moduleKey,
    mode: ctx.mode,
  };
}

export function logStepStart(ctx: PipelineLogContext, op: string): void {
  console.log(`${ctx.prefix} step start`, { op, ...base(ctx) });
}

export function logStepOk(ctx: PipelineLogContext, op: string, elapsedMs: number): void {
  console.log(`${ctx.prefix} step ok`, { op, elapsedMs, ...base(ctx) });
}

export function logStepFail(ctx: PipelineLogContext, op: string, elapsedMs: number, error: RSLatteError): void {
  console.error(`${ctx.prefix} step fail`, { op, elapsedMs, error, ...base(ctx) });
}

export function logRunSkip(ctx: PipelineLogContext, reason: string, extra?: any): void {
  // Keep message stable and prefixed; payload always includes base fields.
  console.warn(`${ctx.prefix} skipped`, { reason, ...base(ctx), ...(extra ? { extra } : {}) });
}

export function logRunStart(ctx: PipelineLogContext, op: string): void {
  console.log(`${ctx.prefix} start`, { op, ...base(ctx) });
}

export function logRunOk(ctx: PipelineLogContext, op: string): void {
  console.log(`${ctx.prefix} success`, { op, ...base(ctx) });
}

export function logRunFail(ctx: PipelineLogContext, op: string, error: RSLatteError): void {
  console.error(`${ctx.prefix} failed`, { op, error, ...base(ctx) });
}

export function logRunUncaught(ctx: PipelineLogContext, detail: any): void {
  console.error(`${ctx.prefix} uncaught`, { ...base(ctx), error: detail });
}


export function logReconcileSkip(ctx: PipelineLogContext, reason: string, debug?: any): void {
  if (reason === "DELTA_TOO_LARGE") {
    console.warn(`${ctx.prefix} reconcile skipped: ${reason} (suggest rebuild)`, { ...base(ctx), ...(debug ? { debug } : {}) });
    return;
  }
  console.log(`${ctx.prefix} reconcile skipped: ${reason}`, { ...base(ctx), ...(debug ? { debug } : {}) });
}

export function logReconcileStart(ctx: PipelineLogContext): void {
  console.log(`${ctx.prefix} reconcile start`, { ...base(ctx) });
}

export function logReconcileOk(ctx: PipelineLogContext): void {
  console.log(`${ctx.prefix} reconcile success`, { ...base(ctx) });
}

export function logReconcileFail(ctx: PipelineLogContext, error: RSLatteError): void {
  console.error(`${ctx.prefix} reconcile failed`, { error, ...base(ctx) });
}


export function logEngineError(ctx: PipelineLogContext, message: string, extra?: any): void {
  console.error(`${ctx.prefix} error: ${message}`, { ...base(ctx), ...(extra ? { extra } : {}) });
}

export function logEngineWarn(ctx: PipelineLogContext, message: string, extra?: any): void {
  console.warn(`${ctx.prefix} warn: ${message}`, { ...base(ctx), ...(extra ? { extra } : {}) });
}

/**
 * D9-5: Key-path logs for faster debugging.
 *
 * Intended usage:
 * - debug on: print these logs so users can see scan/apply/build/flush/archive at a glance
 * - debug off: usually don't call these (keep console clean)
 */
export function logKeyPath(ctx: PipelineLogContext, step: "scan" | "applyDelta" | "buildOps" | "flushQueue" | "archive", data?: any): void {
  if (data === undefined) console.log(`${ctx.prefix} ${step}`);
  else console.log(`${ctx.prefix} ${step}`, { ...base(ctx), ...data });
}

/**
 * D9-5: Per runE2 summary output (one-line style).
 * - debug off: keep payload small
 * - debug on: callers may pass a richer payload
 */
export function logRunE2Summary(ctx: PipelineLogContext, payload: any): void {
  console.log(`${ctx.prefix} summary`, { ...base(ctx), ...payload });
}
