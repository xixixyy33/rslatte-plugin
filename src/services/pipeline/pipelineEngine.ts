/**
 * PipelineEngine skeleton (A3) + reconcile safety gate (C1)
 *
 * 目标：
 * - 主路径：**runE2(ctx, moduleKey, mode)**（侧栏 / coordinator）；**engine.run** 为 legacy 兼容，自动 tick 不调用
 * - per-module 互斥锁（inFlight 拒绝重入）
 * - 统一日志前缀：[RSLatte][moduleKey][mode]
 * - 模块 enabled 判断（disabled => skipped + reason）
 * - ✅ reconcile 安全门集中在 Engine：
 *   - auto 永远禁止 reconcile
 *   - 仅 manual_refresh / rebuild 允许 reconcile
 */

import type { RSLatteLockKey, RSLatteModuleKey, RSLattePipelineMode, RSLatteResult, RSLatteError } from "./types";
import type { SpaceCtx } from "../../types/space";
import type {
  ModuleSpec,
  ModuleSpecAtomic,
  ModuleSpecLegacy,
  RSLatteModuleOpContext,
  RSLatteModuleOpSummary,
  RSLatteReconcileGate,
  RSLatteAtomicOpContext,
  RSLattePipelinePhase,
  RSLatteFlushQueueOptions,
  RSLatteModuleStats,
} from "./moduleSpec";
import type { ModuleRegistry } from "./moduleRegistry";
import { PerModuleInFlightLocks } from "./locks";

import type { PipelineRunResultStable, PipelineRunStep, PipelineRunSummary } from "./runResult";
import { buildScopedLockKey, getLockKeyForModule } from "./lockKeys";
import { evaluateReconcileGate } from "./gates";
import type { ReconcileGateEvaluation } from "./gates";
import { recordLastRunSummary, printRunSummaryDiagnostics, printRunFailureDiagnostics, type PipelineDiagnosticsPrinter } from "./diagnostics";
import {
  logStepStart,
  logStepOk,
  logStepFail,
  logRunSkip,
  logRunUncaught,
  logRunStart,
  logRunOk,
  logRunFail,
  logKeyPath,
  logRunE2Summary,
  logReconcileSkip,
  logReconcileStart,
  logReconcileOk,
  logReconcileFail,
  logEngineError,
  type PipelineLogContext,
} from "./logger";

// ---------------------------------------------------------------------------
// Step S2: stabilize run result shape
//
// - 新增 runSummary（稳定入口）
// - 保留旧字段：summary / gate / steps / reconcile...
//
// 兼容：历史代码可能仍引用 PipelineRunData / PipelineRunDataE2。
// 这里直接 alias 到统一结构，避免扩散修改。
// ---------------------------------------------------------------------------

export type PipelineRunData = PipelineRunResultStable;

export type PipelineRunDataE2Step = PipelineRunStep;

export type PipelineRunDataE2 = PipelineRunResultStable;

export type PipelineEngineOptions = {
  /** 允许外部注入 registry（便于测试/替换实现） */
  registry: ModuleRegistry;

  /** per-module 锁（便于外部共享/观测）；不提供则引擎内部创建 */
  locks?: PerModuleInFlightLocks;

  /** 模块是否启用（后续会桥接到 setting/module switch）；默认全部启用 */
  isModuleEnabled?: (moduleKey: RSLatteModuleKey) => boolean;

  /**
   * Step S9: diagnostics output (opt-in)
   * - enabled(): 是否输出诊断日志（建议绑定到 plugin 的 debugLogEnabled）
   * - printer: 自定义打印函数（默认 console.log）
   */
  debug?: {
    enabled?: () => boolean;
    printer?: PipelineDiagnosticsPrinter;
  };

  /**
   * D9-5: Provide backend touch snapshot used by runE2 summary logs.
   * - urlCheckable: apiBaseUrl is syntactically valid (http/https + URL parse)
   * - backendReady: last known backend DB status (null means unknown)
   */
  getBackendState?: () => { urlCheckable: boolean; backendReady: boolean | null; reason?: string };

  /**
   * Optional hook invoked after `spec.stats()` succeeds.
   * - Best-effort only: engine must not fail if this throws.
   * - Designed for persisting per-space stats/KPI snapshots.
   */
  afterStats?: (args: {
    scope?: { vaultId: string; spaceId: string };
    moduleKey: RSLatteModuleKey;
    mode: RSLattePipelineMode;
    phase: RSLattePipelinePhase;
    runId: string;
    startedAt: string;
    finishedAt: string;
    gate?: RSLatteReconcileGate;
    stats?: RSLatteModuleStats;
  }) => Promise<void>;
};

function makeRunId(): string {
  const rnd = Math.random().toString(16).slice(2, 8);
  return `${Date.now()}_${rnd}`;
}

function ok<T>(data: T, warnings?: string[]): RSLatteResult<T> {
  return warnings?.length ? { ok: true, data, warnings } : { ok: true, data };
}

function fail(code: string, message: string, detail?: unknown): RSLatteResult<never> {
  const error: RSLatteError = { code, message, detail };
  return { ok: false, error };
}


function logPrefix(moduleKey: RSLatteModuleKey, mode: RSLattePipelineMode): string {
  return `[RSLatte][${moduleKey}][${mode}]`;
}

function isSpaceCtx(v: any): v is SpaceCtx {
  return !!v && typeof v === "object" && typeof v.vaultId === "string" && typeof v.spaceId === "string";
}

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isoNow(): string {
  return new Date().toISOString();
}

function lastFinishedAt(steps: PipelineRunStep[], fallback: string): string {
  if (!steps?.length) return fallback;
  const last = steps[steps.length - 1];
  return last?.finishedAt ?? fallback;
}

function buildRunSummary(args: {
  moduleKey: RSLatteModuleKey;
  mode: RSLattePipelineMode;
  runId: string;
  lockKey: RSLatteLockKey;
  startedAt: string;
  finishedAt: string;
  steps: PipelineRunStep[];
  statsBefore?: RSLatteReconcileGate;
  statsAfter?: RSLatteReconcileGate;
  gate?: RSLatteReconcileGate;
  reconcileGate?: ReconcileGateEvaluation;
  legacySummary?: RSLatteModuleOpSummary;
}): PipelineRunSummary {
  return {
    moduleKey: args.moduleKey,
    mode: args.mode,
    runId: args.runId,
    lockKey: args.lockKey,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    steps: args.steps,
    statsBefore: args.statsBefore,
    statsAfter: args.statsAfter,
    gate: args.gate,
    reconcileGate: args.reconcileGate,
    legacySummary: args.legacySummary,
  };
}

// ---------------------------------------------------------------------------
// Step S3: unified execution skeleton for run/runE2
// ---------------------------------------------------------------------------

type ExecOutcome = {
  /** when true, treated as ok+skipped (reason required) */
  skipped?: boolean;
  reason?: string;

  /** legacy summary object kept for UI/compat */
  summary?: RSLatteModuleOpSummary;
  gate?: RSLatteReconcileGate;

  /** for stable runSummary before/after stats */
  gateBefore?: RSLatteReconcileGate;
  gateAfter?: RSLatteReconcileGate;

  /** Step S6: reconcile gate evaluation written into runSummary */
  reconcileGate?: ReconcileGateEvaluation;

  reconcile?: PipelineRunResultStable["reconcile"];
};

type RunWithLockCtx = {
  moduleKey: RSLatteModuleKey;
  mode: RSLattePipelineMode;
  runId: string;
  lockKey: RSLatteLockKey;
  prefix: string;
  startedAt: string;
  steps: PipelineRunStep[];
  step: <T>(phase: RSLattePipelinePhase | "legacy", op: string, fn: () => Promise<RSLatteResult<T>>) => Promise<RSLatteResult<T>>;
};

function errToDetail(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message || String(err), stack: err.stack };
  try {
    return { message: typeof err === "string" ? err : JSON.stringify(err) };
  } catch {
    return { message: String(err) };
  }
}

export class PipelineEngine {
  private readonly registry: ModuleRegistry;
  private readonly locks: PerModuleInFlightLocks;
  private readonly isEnabled: (moduleKey: RSLatteModuleKey) => boolean;
  private readonly diagEnabled: () => boolean;
  private readonly diagPrinter?: PipelineDiagnosticsPrinter;
  private readonly backendState?: () => { urlCheckable: boolean; backendReady: boolean | null; reason?: string };
  private readonly afterStats?: PipelineEngineOptions["afterStats"];

  constructor(opts: PipelineEngineOptions) {
    this.registry = opts.registry;
    this.locks = opts.locks ?? new PerModuleInFlightLocks();
    this.isEnabled = opts.isModuleEnabled ?? (() => true);
    this.diagEnabled = opts.debug?.enabled ?? (() => false);
    this.diagPrinter = opts.debug?.printer;
    this.backendState = opts.getBackendState;
    this.afterStats = opts.afterStats;
  }

  private async invokeAfterStats(args: {
    scope?: { vaultId: string; spaceId: string };
    moduleKey: RSLatteModuleKey;
    mode: RSLattePipelineMode;
    phase: RSLattePipelinePhase;
    runId: string;
    startedAt: string;
    finishedAt: string;
    gate?: RSLatteReconcileGate;
    stats?: RSLatteModuleStats;
  }): Promise<void> {
    if (!this.afterStats) return;
    try {
      await this.afterStats(args);
    } catch (e: any) {
      try {
        console.warn("[RSLatte][pipeline] afterStats hook failed", { moduleKey: args.moduleKey, mode: args.mode, err: String(e?.message ?? e) });
      } catch {
        // ignore
      }
    }
  }

  /**
   * Step F3: normalize run/runE2 overload args.
   * - (ctx, moduleKey, mode)
   * - (moduleKey, mode)
   */
  private normalizeArgs(
    a: SpaceCtx | RSLatteModuleKey,
    b: RSLatteModuleKey | RSLattePipelineMode,
    c?: RSLattePipelineMode
  ): { ctx: { vaultId: string; spaceId: string } | undefined; moduleKey: RSLatteModuleKey; mode: RSLattePipelineMode } {
    if (isSpaceCtx(a)) {
      return {
        ctx: { vaultId: a.vaultId, spaceId: a.spaceId },
        moduleKey: b as RSLatteModuleKey,
        mode: c as RSLattePipelineMode,
      };
    }
    return {
      ctx: undefined,
      moduleKey: a as RSLatteModuleKey,
      mode: b as RSLattePipelineMode,
    };
  }

  private isDiagnosticsEnabled(): boolean {
    try {
      return this.diagEnabled() === true;
    } catch {
      return false;
    }
  }

  private getBackendSnapshot(): { urlCheckable: boolean; backendReady: boolean | null; reason?: string } {
    try {
      const s = this.backendState?.();
      if (s && typeof s.urlCheckable === "boolean") {
        return { urlCheckable: s.urlCheckable, backendReady: (s as any).backendReady ?? null, reason: (s as any).reason };
      }
    } catch {
      // ignore
    }
    return { urlCheckable: false, backendReady: null };
  }

  private extractOpsCount(v: any): number {
    if (v == null) return 0;
    if (Array.isArray(v)) return v.length;
    if (typeof v === "number") return Math.max(0, Math.floor(v));
    // common shapes: {enqueued}, {ops:[]}, {items:[]}, {count}
    try {
      const enq = (v as any).enqueued;
      if (Number.isFinite(Number(enq))) return Math.max(0, Math.floor(Number(enq)));
      const cnt = (v as any).opsCount ?? (v as any).count;
      if (Number.isFinite(Number(cnt))) return Math.max(0, Math.floor(Number(cnt)));
      const ops = (v as any).ops ?? (v as any).items ?? (v as any).queue;
      if (Array.isArray(ops)) return ops.length;
    } catch {
      // ignore
    }
    return 0;
  }

  private simplifyFlushResult(v: any): any {
    if (v == null) return undefined;
    if (typeof v === "string" || typeof v === "number") return v;
    if (Array.isArray(v)) return { length: v.length };
    try {
      const out: any = {};
      const keys = ["flushed", "drained", "skipped", "ok", "failed", "pending", "retry", "retryPending", "retryFailed"];
      for (const k of keys) {
        if ((v as any)[k] !== undefined) out[k] = (v as any)[k];
      }
      // fallback: keep a tiny subset of keys to avoid noisy payload
      if (!Object.keys(out).length) {
        const ks = Object.keys(v).slice(0, 4);
        for (const k of ks) out[k] = (v as any)[k];
      }
      return out;
    } catch {
      return undefined;
    }
  }

  private async runWithLockAndTracing(
    scope: { vaultId: string; spaceId: string } | undefined,
    moduleKey: RSLatteModuleKey,
    mode: RSLattePipelineMode,
    exec: (ctx: RunWithLockCtx) => Promise<RSLatteResult<ExecOutcome>>
  ): Promise<RSLatteResult<PipelineRunData>> {
    const prefix = logPrefix(moduleKey, mode);
    const runId = makeRunId();
    const lockKey = scope
      ? buildScopedLockKey(`${scope.vaultId}:${scope.spaceId}`, moduleKey)
      : // legacy fallback (no scope prefix)
        getLockKeyForModule(moduleKey);
    const startedAt = isoNow();

    const logCtx: PipelineLogContext = { moduleKey, mode, runId, lockKey, prefix };

    // enabled 判断
    if (!this.isEnabled(moduleKey)) {
      logRunSkip(logCtx, "MODULE_DISABLED");
      const finishedAt = isoNow();
      const steps: PipelineRunStep[] = [];
      const runSummary = buildRunSummary({ moduleKey, mode, runId, lockKey, startedAt, finishedAt, steps });
      recordLastRunSummary(runSummary);
      if (this.isDiagnosticsEnabled()) {
        printRunSummaryDiagnostics({ prefix, summary: runSummary, printer: this.diagPrinter });
      }
      return ok({ moduleKey, mode, runId, skipped: true, reason: "MODULE_DISABLED", lockKey, runSummary, steps });
    }

    if (!this.locks.tryAcquire(lockKey, moduleKey, mode, runId)) {
      const cur = this.locks.get(lockKey);
      logRunSkip(logCtx, "IN_FLIGHT", cur ? { inFlight: cur } : undefined);
      const finishedAt = isoNow();
      const steps: PipelineRunStep[] = [];
      const runSummary = buildRunSummary({ moduleKey, mode, runId, lockKey, startedAt, finishedAt, steps });
      recordLastRunSummary(runSummary);
      if (this.isDiagnosticsEnabled()) {
        printRunSummaryDiagnostics({ prefix, summary: runSummary, printer: this.diagPrinter });
      }
      return ok({ moduleKey, mode, runId, skipped: true, reason: "IN_FLIGHT", lockKey, runSummary, steps });
    }

    const steps: PipelineRunStep[] = [];

    const step = async <T>(
      phase: RSLattePipelinePhase | "legacy",
      op: string,
      fn: () => Promise<RSLatteResult<T>>
    ): Promise<RSLatteResult<T>> => {
      const t0 = Date.now();
      const verbose = this.isDiagnosticsEnabled();
      if (verbose) logStepStart(logCtx, op);
      const sAt = isoNow();
      const r = await fn();
      const fAt = isoNow();
      const elapsedMs = Math.max(0, Date.now() - t0);
      steps.push({ phase: String(phase), op, startedAt: sAt, finishedAt: fAt, ok: r.ok, error: r.ok ? undefined : r.error });
      if (!r.ok) {
        logStepFail(logCtx, op, elapsedMs, r.error);
      } else {
        if (verbose) logStepOk(logCtx, op, elapsedMs);
      }
      return r;
    };

    try {
      const ctx: RunWithLockCtx = { moduleKey, mode, runId, lockKey, prefix, startedAt, steps, step };
      const outcomeR = await exec(ctx);
      if (!outcomeR.ok) {
        // diagnostics for failure path (no runSummary assembled)
        if (this.isDiagnosticsEnabled()) {
          printRunFailureDiagnostics({ prefix, moduleKey, mode, runId, lockKey, startedAt, steps, error: outcomeR.error, printer: this.diagPrinter });
        }
        return outcomeR as any;
      }

      const outcome = outcomeR.data;
      const finishedAt = lastFinishedAt(steps, isoNow());

      const gate = outcome.gate;
      const gateBefore = outcome.gateBefore ?? gate;
      const gateAfter = outcome.gateAfter ?? gate;

      const runSummary = buildRunSummary({
        moduleKey,
        mode,
        runId,
        lockKey,
        startedAt,
        finishedAt,
        steps,
        statsBefore: gateBefore,
        statsAfter: gateAfter,
        gate,
        reconcileGate: outcome.reconcileGate,
        legacySummary: outcome.summary,
      });

      // Step S9: record + (optional) print diagnostics
      recordLastRunSummary(runSummary);
      if (this.isDiagnosticsEnabled()) {
        printRunSummaryDiagnostics({ prefix, summary: runSummary, printer: this.diagPrinter });
      }

      return ok({
        moduleKey,
        mode,
        runId,
        skipped: outcome.skipped === true,
        reason: outcome.skipped ? outcome.reason : undefined,
        lockKey,
        runSummary,
        summary: outcome.summary,
        gate,
        steps,
        reconcile: outcome.reconcile,
      });
    } catch (err) {
      const detail = errToDetail(err);
      logRunUncaught(logCtx, detail);
      return fail("UNCAUGHT", "PipelineEngine uncaught error", detail);
    } finally {
      this.locks.release(lockKey, runId);
    }
  }

  /**
   * 统一入口（legacy）。
   *
   * Step F3: prefer run(ctx, moduleKey, mode) so lockKey includes vaultId+spaceId.
   */
  public async run(ctx: SpaceCtx, moduleKey: RSLatteModuleKey, mode: RSLattePipelineMode): Promise<RSLatteResult<PipelineRunData>>;
  public async run(moduleKey: RSLatteModuleKey, mode: RSLattePipelineMode): Promise<RSLatteResult<PipelineRunData>>;
  public async run(a: any, b: any, c?: any): Promise<RSLatteResult<PipelineRunData>> {
    const { ctx, moduleKey, mode } = this.normalizeArgs(a, b, c);
    return this.runWithLockAndTracing(ctx, moduleKey, mode, async (rt) => {
      // Step S5: engine 使用明确 getter（不再猜 spec 形态）
      const spec: ModuleSpecLegacy | undefined = this.registry.getLegacy(moduleKey);
      const logCtx: PipelineLogContext = { moduleKey, mode, runId: rt.runId, lockKey: rt.lockKey, prefix: rt.prefix };
      if (!this.registry.has(moduleKey)) {
        logEngineError(logCtx, "spec not found");
        return fail("SPEC_NOT_FOUND", `ModuleSpec not registered: ${moduleKey}`, { moduleKey, mode });
      }
      if (!spec) {
        logEngineError(logCtx, "spec is not legacy-capable");
        return fail("SPEC_NOT_LEGACY", `ModuleSpec is not legacy-capable: ${moduleKey}`, { moduleKey, mode });
      }
      // 兼容：pickOp/maybeRunReconcile 仍使用 ModuleSpec（legacy）类型
      const legacySpec: ModuleSpec = spec;

      const { opName, fn } = this.pickOp(legacySpec, mode);
      const opCtx: RSLatteModuleOpContext = {
        moduleKey,
        mode,
        op: opName,
        vaultId: ctx?.vaultId,
        spaceId: ctx?.spaceId,
        requestedAt: new Date().toISOString(),
      };

      logRunStart({ moduleKey, mode, runId: rt.runId, lockKey: rt.lockKey, prefix: rt.prefix }, String(opName));
      const res = await rt.step("legacy", String(opName), () => fn(opCtx));
      if (!res.ok) {
        logRunFail({ moduleKey, mode, runId: rt.runId, lockKey: rt.lockKey, prefix: rt.prefix }, String(opName), res.error);
        return { ok: false, error: res.error };
      }
      logRunOk({ moduleKey, mode, runId: rt.runId, lockKey: rt.lockKey, prefix: rt.prefix }, String(opName));

      // ✅ S6: reconcile 安全门（集中评估器）
      const gate: RSLatteReconcileGate | undefined = (res.data as any)?.gate;
      const { reconcile, gateEval } = await this.maybeRunReconcile(legacySpec, opCtx, res.data, rt.runId, rt.prefix, rt.lockKey, gate);
      return ok({ skipped: false, summary: res.data, gate, gateBefore: gate, gateAfter: gate, reconcile, reconcileGate: gateEval });
    });
  }

  /**
   * ✅ E2：原子能力编排入口（顺序固化到 Engine）。
   *
   * - 仅当 spec 实现了 ModuleSpecAtomic 时可用（否则返回 SPEC_NOT_ATOMIC）
   * - 目前不替换旧 run()，方便分步迁移：下一步会逐模块把 spec 切到 atomic 并切换调用点
   */
  /**
   * ✅ E2：原子能力编排入口（顺序固化到 Engine）。
   *
   * Step F3: prefer runE2(ctx, moduleKey, mode) so lockKey includes vaultId+spaceId.
   */
  public async runE2(ctx: SpaceCtx, moduleKey: RSLatteModuleKey, mode: RSLattePipelineMode): Promise<RSLatteResult<PipelineRunDataE2>>;
  public async runE2(moduleKey: RSLatteModuleKey, mode: RSLattePipelineMode): Promise<RSLatteResult<PipelineRunDataE2>>;
  public async runE2(a: any, b: any, c?: any): Promise<RSLatteResult<PipelineRunDataE2>> {
    const { ctx, moduleKey, mode } = this.normalizeArgs(a, b, c);
    if (!ctx) {
      // best-effort warning: missing ctx means cross-space mutual exclusion may happen
      try {
        console.warn("[RSLatte][pipeline] runE2 called without SpaceCtx; lockKey will not include space scope", { moduleKey, mode });
      } catch {
        // ignore
      }
    }
    return this.runWithLockAndTracing(ctx, moduleKey, mode, async (rt) => {
      // Step S5: engine 使用明确 getter（不再猜 spec 形态）
      const spec: ModuleSpecAtomic | undefined = this.registry.getAtomic(moduleKey);
      const logCtx: PipelineLogContext = { moduleKey, mode, runId: rt.runId, lockKey: rt.lockKey, prefix: rt.prefix };
      if (!this.registry.has(moduleKey)) {
        logEngineError(logCtx, "spec not found");
        return fail("SPEC_NOT_FOUND", `ModuleSpec not registered: ${moduleKey}`, { moduleKey, mode });
      }

      if (!spec) {
        logRunSkip(logCtx, "SPEC_NOT_ATOMIC", { message: "spec not atomic (use legacy run)" });
        return ok({ skipped: true, reason: "SPEC_NOT_ATOMIC" });
      }

      const phase: RSLattePipelinePhase =
        mode === "rebuild" ? "rebuild" : mode === "manual_archive" || mode === "auto_archive" ? "archive" : "incremental";

      const verbose = this.isDiagnosticsEnabled();
      if (verbose) logRunStart(logCtx, `E2:${phase}`);

      const mkCtx = (op: any, ph: RSLattePipelinePhase): RSLatteAtomicOpContext => ({
        moduleKey,
        mode,
        phase: ph,
        op,
        vaultId: ctx?.vaultId,
        spaceId: ctx?.spaceId,
        requestedAt: new Date().toISOString(),
        runId: rt.runId,
      });

      // ------- incremental/manual -------
      if (phase === "incremental") {
        let opsCount = 0;
        let flushResult: any = undefined;

        const scanR = await rt.step("incremental", "scanIncremental", () => spec.scanIncremental(mkCtx("scanIncremental", "incremental")));
        if (!scanR.ok) return { ok: false, error: scanR.error };

        if (verbose) logKeyPath(logCtx, "scan");

        const applyR = await rt.step("incremental", "applyDelta", () =>
          spec.applyDelta(mkCtx("applyDelta", "incremental"), scanR.data)
        );
        if (!applyR.ok) return { ok: false, error: applyR.error };

        if (verbose) logKeyPath(logCtx, "applyDelta");

        // pre-build gate: decide dbSync enabled
        const gatePreR = await rt.step("incremental", "getReconcileGate(pre)", () => spec.getReconcileGate(mkCtx("stats", "incremental")));
        if (!gatePreR.ok) return { ok: false, error: gatePreR.error };

        const gateBefore: RSLatteReconcileGate = gatePreR.data ?? {};
        let gate: RSLatteReconcileGate = gateBefore;
        const dbSyncEnabled = gate.dbSyncEnabled === true;

        if (dbSyncEnabled) {
          const buildR = await rt.step("incremental", "buildOps", () => spec.buildOps(mkCtx("buildOps", "incremental"), applyR.data));
          if (!buildR.ok) return { ok: false, error: buildR.error };

          opsCount = this.extractOpsCount(buildR.data);
          if (verbose) logKeyPath(logCtx, "buildOps", { opsCount });

          const flushOpts: RSLatteFlushQueueOptions = { retryPending: true, retryFailed: true, drainAll: false };
          const flushR = await rt.step("incremental", "flushQueue", () => spec.flushQueue(mkCtx("flushQueue", "incremental"), flushOpts));
          if (!flushR.ok) return { ok: false, error: flushR.error };

          flushResult = this.simplifyFlushResult(flushR.data);
          if (verbose) logKeyPath(logCtx, "flushQueue", { flushResult });

          // post-flush gate used for reconcile decision
          const gatePostR = await rt.step("incremental", "getReconcileGate(post)", () => spec.getReconcileGate(mkCtx("stats", "incremental")));
          if (!gatePostR.ok) return { ok: false, error: gatePostR.error };
          gate = gatePostR.data ?? gate;
        }

        const { reconcile: reconcileInfo, gateEval } = await this.maybeRunAtomicReconcile(
          spec,
          mkCtx("reconcile", "incremental"),
          gate,
          { scan: scanR.data, applied: applyR.data },
          rt.prefix,
          rt.lockKey
        );

        // P6: manual_refresh 在门控允许时执行归档（auto 不主动归档）
        if (mode === "manual_refresh" && gateEval?.allowed === true) {
          const archR = await rt.step("incremental", "archiveOutOfRange", () =>
            spec.archiveOutOfRange(mkCtx("archiveOutOfRange", "incremental"))
          );
          if (!archR.ok) return { ok: false, error: archR.error };
          if (verbose) logKeyPath(logCtx, "archive");
        }
        const statsR = await rt.step("incremental", "stats", () => spec.stats(mkCtx("stats", "incremental")));
        if (!statsR.ok) return { ok: false, error: statsR.error };

        const finishedAt = lastFinishedAt(rt.steps, isoNow());

        await this.invokeAfterStats({
          scope: ctx,
          moduleKey,
          mode,
          phase,
          runId: rt.runId,
          startedAt: rt.startedAt,
          finishedAt,
          gate,
          stats: statsR.data,
        });
        const legacySummary: RSLatteModuleOpSummary = {
          moduleKey,
          mode,
          op: "incrementalRefresh",
          startedAt: rt.startedAt,
          finishedAt,
          metrics: {
            pendingCount: num((gate as any).pendingCount),
            failedCount: num((gate as any).failedCount),
            deltaSize: num((gate as any).deltaSize),
          },
          message: "OK",
          gate,
        };

        // D9-5: runE2 summary (always print; keep it concise when verbose=false)
        const b = this.getBackendSnapshot();
        const payload: any = {
          mode,
          dbSyncEnabled: gate.dbSyncEnabled === true,
          urlCheckable: b.urlCheckable,
          backendReady: b.backendReady,
          deltaCount: num((gate as any).deltaSize),
          opsCount,
          flushResult,
        };
        if (verbose) {
          payload.pendingCount = num((gate as any).pendingCount);
          payload.failedCount = num((gate as any).failedCount);
          if (b.reason) payload.backendReason = b.reason;
          payload.reconcileGate = gateEval;
        }
        logRunE2Summary(logCtx, payload);

        return ok({
          skipped: false,
          summary: legacySummary,
          gate,
          gateBefore,
          gateAfter: gate,
          reconcile: reconcileInfo,
          reconcileGate: gateEval,
        });
      }

      // ------- rebuild -------
      if (phase === "rebuild") {
        let opsCount = 0;
        let flushResult: any = undefined;

        const scanR = await rt.step("rebuild", "scanFull", () => spec.scanFull(mkCtx("scanFull", "rebuild")));
        if (!scanR.ok) return { ok: false, error: scanR.error };

        if (verbose) logKeyPath(logCtx, "scan");

        const repR = await rt.step("rebuild", "replaceAll", () => spec.replaceAll(mkCtx("replaceAll", "rebuild"), scanR.data));
        if (!repR.ok) return { ok: false, error: repR.error };

        if (verbose) logKeyPath(logCtx, "applyDelta", { op: "replaceAll" });

        const gatePreR = await rt.step("rebuild", "getReconcileGate(pre)", () => spec.getReconcileGate(mkCtx("stats", "rebuild")));
        if (!gatePreR.ok) return { ok: false, error: gatePreR.error };

        const gateBefore: RSLatteReconcileGate = gatePreR.data ?? {};
        let gate: RSLatteReconcileGate = gateBefore;
        const dbSyncEnabled = gate.dbSyncEnabled === true;

        if (dbSyncEnabled) {
          const buildR = await rt.step("rebuild", "buildOps", () => spec.buildOps(mkCtx("buildOps", "rebuild"), repR.data));
          if (!buildR.ok) return { ok: false, error: buildR.error };

          opsCount = this.extractOpsCount(buildR.data);
          if (verbose) logKeyPath(logCtx, "buildOps", { opsCount });

          const flushOpts: RSLatteFlushQueueOptions = { retryPending: true, retryFailed: true, drainAll: true };
          const flushR = await rt.step("rebuild", "flushQueue(drainAll)", () => spec.flushQueue(mkCtx("flushQueue", "rebuild"), flushOpts));
          if (!flushR.ok) return { ok: false, error: flushR.error };

          flushResult = this.simplifyFlushResult(flushR.data);
          if (verbose) logKeyPath(logCtx, "flushQueue", { flushResult, drainAll: true });

          const gatePostR = await rt.step("rebuild", "getReconcileGate(post)", () => spec.getReconcileGate(mkCtx("stats", "rebuild")));
          if (!gatePostR.ok) return { ok: false, error: gatePostR.error };
          gate = gatePostR.data ?? gate;
        }

        const { reconcile: reconcileInfo, gateEval } = await this.maybeRunAtomicReconcile(
          spec,
          mkCtx("reconcile", "rebuild"),
          gate,
          { scan: scanR.data, applied: repR.data },
          rt.prefix,
          rt.lockKey
        );

        // P6: rebuild 在 replaceAll/flush/reconcile 后，门控允许时执行归档
        if (gateEval?.allowed === true) {
          const archR = await rt.step("rebuild", "archiveOutOfRange", () =>
            spec.archiveOutOfRange(mkCtx("archiveOutOfRange", "rebuild"))
          );
          if (!archR.ok) return { ok: false, error: archR.error };
          if (verbose) logKeyPath(logCtx, "archive");
        }

        const statsR = await rt.step("rebuild", "stats", () => spec.stats(mkCtx("stats", "rebuild")));
        if (!statsR.ok) return { ok: false, error: statsR.error };

        const finishedAt = lastFinishedAt(rt.steps, isoNow());

        await this.invokeAfterStats({
          scope: ctx,
          moduleKey,
          mode,
          phase,
          runId: rt.runId,
          startedAt: rt.startedAt,
          finishedAt,
          gate,
          stats: statsR.data,
        });
        const legacySummary: RSLatteModuleOpSummary = {
          moduleKey,
          mode,
          op: "rebuild",
          startedAt: rt.startedAt,
          finishedAt,
          metrics: {
            pendingCount: num((gate as any).pendingCount),
            failedCount: num((gate as any).failedCount),
            deltaSize: num((gate as any).deltaSize),
          },
          message: "OK",
          gate,
        };

        // D9-5: runE2 summary
        const b = this.getBackendSnapshot();
        const payload: any = {
          mode,
          dbSyncEnabled: gate.dbSyncEnabled === true,
          urlCheckable: b.urlCheckable,
          backendReady: b.backendReady,
          deltaCount: num((gate as any).deltaSize),
          opsCount,
          flushResult,
        };
        if (verbose) {
          payload.pendingCount = num((gate as any).pendingCount);
          payload.failedCount = num((gate as any).failedCount);
          if (b.reason) payload.backendReason = b.reason;
          payload.reconcileGate = gateEval;
        }
        logRunE2Summary(logCtx, payload);

        return ok({
          skipped: false,
          summary: legacySummary,
          gate,
          gateBefore,
          gateAfter: gate,
          reconcile: reconcileInfo,
          reconcileGate: gateEval,
        });
      }

      // ------- archive -------
      {
        let opsCount = 0;
        let flushResult: any = undefined;

        const archR = await rt.step("archive", "archiveOutOfRange", () => spec.archiveOutOfRange(mkCtx("archiveOutOfRange", "archive")));
        if (!archR.ok) return { ok: false, error: archR.error };

        if (verbose) logKeyPath(logCtx, "archive");

        const gatePreR = await rt.step("archive", "getReconcileGate(pre)", () => spec.getReconcileGate(mkCtx("stats", "archive")));
        if (!gatePreR.ok) return { ok: false, error: gatePreR.error };
        const gateBefore: RSLatteReconcileGate = gatePreR.data ?? {};
        let gate: RSLatteReconcileGate = gateBefore;
        const dbSyncEnabled = gate.dbSyncEnabled === true;

        if (dbSyncEnabled) {
          const buildR = await rt.step("archive", "buildOps", () => spec.buildOps(mkCtx("buildOps", "archive"), archR.data));
          if (!buildR.ok) return { ok: false, error: buildR.error };

          opsCount = this.extractOpsCount(buildR.data);
          if (verbose) logKeyPath(logCtx, "buildOps", { opsCount });

          const flushOpts: RSLatteFlushQueueOptions = { retryPending: true, retryFailed: true, drainAll: false };
          const flushR = await rt.step("archive", "flushQueue", () => spec.flushQueue(mkCtx("flushQueue", "archive"), flushOpts));
          if (!flushR.ok) return { ok: false, error: flushR.error };

          flushResult = this.simplifyFlushResult(flushR.data);
          if (verbose) logKeyPath(logCtx, "flushQueue", { flushResult });

          const gatePostR = await rt.step("archive", "getReconcileGate(post)", () => spec.getReconcileGate(mkCtx("stats", "archive")));
          if (!gatePostR.ok) return { ok: false, error: gatePostR.error };
          gate = gatePostR.data ?? gate;
        }

        const statsR = await rt.step("archive", "stats", () => spec.stats(mkCtx("stats", "archive")));
        if (!statsR.ok) return { ok: false, error: statsR.error };

        const finishedAt = lastFinishedAt(rt.steps, isoNow());

        await this.invokeAfterStats({
          scope: ctx,
          moduleKey,
          mode,
          phase,
          runId: rt.runId,
          startedAt: rt.startedAt,
          finishedAt,
          gate,
          stats: statsR.data,
        });

        const legacySummary = archR.data as any as RSLatteModuleOpSummary;
        const gateEval = evaluateReconcileGate({ mode, gate });

        // D9-5: runE2 summary
        const b = this.getBackendSnapshot();
        const payload: any = {
          mode,
          dbSyncEnabled: gate.dbSyncEnabled === true,
          urlCheckable: b.urlCheckable,
          backendReady: b.backendReady,
          deltaCount: num((gate as any).deltaSize),
          opsCount,
          flushResult,
        };
        if (verbose) {
          payload.pendingCount = num((gate as any).pendingCount);
          payload.failedCount = num((gate as any).failedCount);
          if (b.reason) payload.backendReason = b.reason;
          payload.reconcileGate = gateEval;
        }
        logRunE2Summary(logCtx, payload);

        return ok({ skipped: false, summary: legacySummary, gate, gateBefore, gateAfter: gate, reconcileGate: gateEval });
      }
    });
  }


  private async maybeRunAtomicReconcile(
    spec: ModuleSpecAtomic,
    ctx: RSLatteAtomicOpContext,
    gate: RSLatteReconcileGate,
    input: { scan?: unknown; applied?: unknown },
    prefix: string,
    lockKey: RSLatteLockKey
  ): Promise<{ reconcile?: PipelineRunDataE2["reconcile"]; gateEval: ReconcileGateEvaluation }> {
    const gateEval = evaluateReconcileGate({ mode: ctx.mode, gate });

    // auto / non-manual modes: 保持现状（不触发 reconcile，也不返回 skipped 结构）
    if (gateEval.reason === "MODE_NOT_ALLOWED") {
      return { reconcile: undefined, gateEval };
    }

    // 被门控阻断：返回 skipped 结构（兼容旧逻辑）
    if (!gateEval.allowed) {
      const reason = String(gateEval.reason ?? "UNKNOWN");
      // NOTE: atomic reconcile uses ctx (not baseCtx). We must not reference outer-scope vars.
      const runIdForLog = String(ctx.runId ?? "");
      logReconcileSkip({ moduleKey: ctx.moduleKey, mode: ctx.mode, runId: runIdForLog, lockKey: String(lockKey ?? ""), prefix: String(prefix ?? "") }, reason, gateEval.debug);
      return { reconcile: { executed: false, skipped: true, reason }, gateEval };
    }

    const runIdForLog2 = String(ctx.runId ?? "");
    logReconcileStart({ moduleKey: ctx.moduleKey, mode: ctx.mode, runId: runIdForLog2, lockKey, prefix });
    const r = await spec.reconcile(ctx, input);
    if (r.ok) {
      logReconcileOk({ moduleKey: ctx.moduleKey, mode: ctx.mode, runId: runIdForLog2, lockKey, prefix });
      return { reconcile: { executed: true, skipped: false, summary: r.data }, gateEval };
    }

    logReconcileFail({ moduleKey: ctx.moduleKey, mode: ctx.mode, runId: runIdForLog2, lockKey, prefix }, r.error);
    return { reconcile: { executed: true, skipped: false }, gateEval };
  }

  // 未使用的方法，保留以备将来使用
  // private shouldAttemptReconcile(mode: RSLattePipelineMode): boolean {
  //   return mode === "manual_refresh" || mode === "rebuild";
  // }

  private async maybeRunReconcile(
    spec: ModuleSpec,
    baseCtx: RSLatteModuleOpContext,
    summary: RSLatteModuleOpSummary,
    runId: string,
    prefix: string,
    lockKey: RSLatteLockKey,
    gateHint?: RSLatteReconcileGate
  ): Promise<{ reconcile?: PipelineRunData["reconcile"]; gateEval: ReconcileGateEvaluation }> {
    const gate: RSLatteReconcileGate = gateHint ?? (summary as any)?.gate ?? {};
    const gateEval = evaluateReconcileGate({ mode: baseCtx.mode, gate });

    // auto / non-manual modes: 保持现状（不触发 reconcile，也不返回 skipped 结构）
    if (gateEval.reason === "MODE_NOT_ALLOWED") {
      return { reconcile: undefined, gateEval };
    }

    // 被门控阻断：返回 skipped 结构（兼容旧逻辑）
    if (!gateEval.allowed) {
      const reason = String(gateEval.reason ?? "UNKNOWN");
      logReconcileSkip({ moduleKey: baseCtx.moduleKey, mode: baseCtx.mode, runId: String(runId ?? ""), lockKey: String(lockKey ?? ""), prefix: String(prefix ?? "") }, reason, gateEval.debug ?? undefined);
      return { reconcile: { executed: false, skipped: true, reason }, gateEval };
    }

    const recCtx: RSLatteModuleOpContext = {
      moduleKey: baseCtx.moduleKey,
      mode: baseCtx.mode,
      op: "reconcile",
      requestedAt: new Date().toISOString(),
      reason: baseCtx.reason,
    };

    logReconcileStart({ moduleKey: baseCtx.moduleKey, mode: baseCtx.mode, runId, lockKey, prefix });
    const r = await spec.reconcile(recCtx);
    if (r.ok) {
      logReconcileOk({ moduleKey: baseCtx.moduleKey, mode: baseCtx.mode, runId, lockKey, prefix });
      return { reconcile: { executed: true, skipped: false, summary: r.data }, gateEval };
    }

    logReconcileFail({ moduleKey: baseCtx.moduleKey, mode: baseCtx.mode, runId, lockKey, prefix }, r.error);
    return { reconcile: { executed: true, skipped: false }, gateEval };
  }

  /** mode -> spec method mapping */
  private pickOp(
    spec: ModuleSpec,
    mode: RSLattePipelineMode
  ): {
    opName: "incrementalRefresh" | "archive" | "rebuild";
    fn: (ctx: RSLatteModuleOpContext) => Promise<RSLatteResult<RSLatteModuleOpSummary>>;
  } {
    // rebuild：全量重建
    if (mode === "rebuild") {
      return { opName: "rebuild", fn: (ctx) => spec.rebuild(ctx) };
    }

    // manual_archive / auto_archive：归档
    if (mode === "manual_archive" || mode === "auto_archive") {
      return { opName: "archive", fn: (ctx) => spec.archive(ctx) };
    }

    // auto_refresh / auto / manual_refresh：增量刷新
    return { opName: "incrementalRefresh", fn: (ctx) => spec.incrementalRefresh(ctx) };
  }
}
