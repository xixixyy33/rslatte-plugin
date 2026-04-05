/**
 * ModuleSpec (A2)
 *
 * 目标：用统一的 spec 描述“一个模块必须提供的能力”（增量刷新/重建/归档/reconcile/统计），
 * 作为后续 pipeline coordinator 的共同语言。
 *
 * ⚠️ 本文件仅提供类型/接口与占位实现工厂：不引用现有业务代码，不改任何调用点。
 */

import type { RSLatteModuleKey, RSLattePipelineMode, RSLatteResult, RSLatteError } from "./types";

/** 模块操作名（用于日志/统计） */
export type RSLatteModuleOp =
  | "incrementalRefresh"
  | "rebuild"
  | "archive"
  | "reconcile"
  | "stats";

/** 操作上下文（后续 coordinator 会补全更多字段；A2 只定义最小结构） */
export type RSLatteModuleOpContext = {
  moduleKey: RSLatteModuleKey;
  mode: RSLattePipelineMode;
  op: RSLatteModuleOp;
  /** scope (Step F3): provided by engine when available */
  vaultId?: string;
  spaceId?: string;
  /** ISO time string */
  requestedAt: string;
  /** 可选：触发原因（例如：button_click / interval / command） */
  reason?: string;
};

/**
 * ✅ reconcile 安全门所需的结构化信息（由模块 bridge 上报给 engine）。
 *
 * 约定：
 * - engine 只会在 manual_refresh / rebuild 时读取并判定是否调用 spec.reconcile。
 * - pending/failed 的定义由各模块自行决定（task/memo 使用索引中的 dbSyncState 统计）。
 */
export type RSLatteReconcileGate = {
  /** 本模块本次运行时 DB sync 是否启用（未启用则 reconcile 直接跳过） */
  dbSyncEnabled?: boolean;
  /**
   * 为 true 时：manual_refresh / rebuild 下即使未启用 DB sync 也允许执行 reconcile。
   * 用于仅做本地索引校准、无后端入库的模块（如 health）。
   */
  allowReconcileWithoutDbSync?: boolean;
  /** 同步队列/未入库项的 pending 数（>0 视为队列未清空） */
  pendingCount?: number;
  /** 同步队列/未入库项的 failed 数（>0 视为队列未清空） */
  failedCount?: number;
  /** 本次增量变更量（>200 时建议 rebuild） */
  deltaSize?: number;
  /** 安全门：扫描/索引检测到的“缺 uid / 缺 id”条目数（>0 视为 dirty） */
  uidMissingCount?: number;
  /** 安全门：扫描检测到的解析失败文件数（>0 视为 dirty） */
  parseErrorCount?: number;
  /** dirty 总数（若未填，engine 将基于 uidMissingCount/parseErrorCount 计算） */
  dirtyCount?: number;
};


/** 操作执行后的通用统计/摘要（先定义最小字段，后续可扩展） */
export type RSLatteModuleOpSummary = {
  moduleKey: RSLatteModuleKey;
  mode: RSLattePipelineMode;
  op: RSLatteModuleOp;
  startedAt: string;
  finishedAt: string;
  /** 可选：模块自行上报的计数/耗时等指标 */
  metrics?: Record<string, number>;
  /** 可选：人类可读的补充信息 */
  message?: string;
  /** reconcile 门控信息（engine 读取） */
  gate?: RSLatteReconcileGate;
};

/** 模块统计信息（先定义为可扩展的结构） */
export type RSLatteModuleStats = {
  moduleKey: RSLatteModuleKey;
  /** 例如：indexCount / queuePending / lastSyncAt 等 */
  items?: Record<string, number>;
  /** 例如：版本/目录等 */
  meta?: Record<string, string>;
};

/**
 * 一个模块必须提供的能力声明（接口齐全，允许后续 bridge 到旧逻辑）。
 * - 所有方法都返回统一 RSLatteResult，方便 coordinator 统一编排与容错。
 */
/**
 * Legacy spec（旧版 run() 使用的高层语义接口）
 *
 * ⚠️ Step S5：Registry 内部会将 legacy/atomic 分开存储。
 * 这里保留 ModuleSpec 名称用于兼容既有调用链，并额外导出 ModuleSpecLegacy 作为“明确含义”的别名。
 */
export interface ModuleSpec {
  /** 模块 key（task/memo/checkin/finance/project/output） */
  key: RSLatteModuleKey;

  /** 展示名（用于 UI/日志） */
  label: string;
  /** 兼容字段：历史版本使用 name；保留可选 */
  name?: string;

  /** 增量刷新（auto/manual 都会使用） */
  incrementalRefresh(ctx: RSLatteModuleOpContext): Promise<RSLatteResult<RSLatteModuleOpSummary>>;

  /** 全量重建（rebuild 使用） */
  rebuild(ctx: RSLatteModuleOpContext): Promise<RSLatteResult<RSLatteModuleOpSummary>>;

  /** 归档（通常在 rebuild 时涉及“归档范围外”处理；后续 coordinator 会决定何时调用） */
  archive(ctx: RSLatteModuleOpContext): Promise<RSLatteResult<RSLatteModuleOpSummary>>;

  /** reconcile（manual/rebuild 门控；后续 coordinator 决定何时调用） */
  reconcile(ctx: RSLatteModuleOpContext): Promise<RSLatteResult<RSLatteModuleOpSummary>>;

  /** 统计（用于状态灯/侧边栏指标；后续 coordinator 会按需调用） */
  stats(ctx: RSLatteModuleOpContext): Promise<RSLatteResult<RSLatteModuleStats>>;
}

/** Step S5: 明确语义别名（与 ModuleSpec 等价） */
export type ModuleSpecLegacy = ModuleSpec;

/** 占位错误工厂（A2 bridge/占位实现使用） */
export function notImplementedError(moduleKey: RSLatteModuleKey, op: RSLatteModuleOp): RSLatteError {
  return {
    code: "NOT_IMPLEMENTED",
    message: `Module operation not implemented: ${moduleKey}.${op}`,
    detail: { moduleKey, op },
  };
}

/** 占位 spec 工厂：接口齐全，但所有能力均为 NOT_IMPLEMENTED（用于 registry 先行枚举 6 模块） */
export function createPlaceholderSpec(key: RSLatteModuleKey, name?: string): ModuleSpec {
  const displayName = name ?? key;
  return {
    key,
    label: displayName,
    name: displayName,
    async incrementalRefresh(ctx) {
      return { ok: false, error: notImplementedError(ctx.moduleKey, "incrementalRefresh") };
    },
    async rebuild(ctx) {
      return { ok: false, error: notImplementedError(ctx.moduleKey, "rebuild") };
    },
    async archive(ctx) {
      return { ok: false, error: notImplementedError(ctx.moduleKey, "archive") };
    },
    async reconcile(ctx) {
      return { ok: false, error: notImplementedError(ctx.moduleKey, "reconcile") };
    },
    async stats(ctx) {
      return { ok: false, error: notImplementedError(ctx.moduleKey, "stats") };
    },
  };
}


/* =========================
 * E2: Atomic Spec (new)
 * ========================= */

/** pipeline phase（engine 固化顺序会使用） */
export type RSLattePipelinePhase = "incremental" | "rebuild" | "archive";

/** 原子步骤名（用于日志/统计） */
export type RSLatteAtomicOp =
  | "scanIncremental"
  | "applyDelta"
  | "scanFull"
  | "replaceAll"
  | "archiveOutOfRange"
  | "buildOps"
  | "flushQueue"
  | "reconcile"
  | "stats";

/** 原子步骤上下文（Engine 固化顺序时透传） */
export type RSLatteAtomicOpContext = {
  moduleKey: RSLatteModuleKey;
  mode: RSLattePipelineMode;
  phase: RSLattePipelinePhase;
  op: RSLatteAtomicOp;
  /** scope (Step F3): always provided for runE2(ctx, ...) */
  vaultId?: string;
  spaceId?: string;
  requestedAt: string;
  /** optional：engine runId，便于日志串联 */
  runId?: string;
  reason?: string;
};

/** flushQueue 的统一参数（engine 决定 drainAll/重试策略） */
export type RSLatteFlushQueueOptions = {
  /** drainAll：rebuild 时可强制清空全队列 */
  drainAll?: boolean;
  /** 重试 pending（默认 true for manual/auto） */
  retryPending?: boolean;
  /** 重试 failed（默认 true for manual/auto） */
  retryFailed?: boolean;
};

/**
 * E2 原子能力模型：
 * - spec 只提供“扫描/应用/构建 ops/flush/reconcile/归档策略”的原子能力
 * - 统一顺序由 Engine 固化
 *
 * 说明：scan/apply/build/flush 之间的数据结构由各模块自行决定（unknown），engine 只透传。
 */
export interface ModuleSpecAtomic {
  key: RSLatteModuleKey;
  label: string;
  /** 兼容字段：可选 */
  name?: string;

  scanIncremental(ctx: RSLatteAtomicOpContext): Promise<RSLatteResult<unknown>>;
  applyDelta(ctx: RSLatteAtomicOpContext, scan: unknown): Promise<RSLatteResult<unknown>>;

  scanFull(ctx: RSLatteAtomicOpContext): Promise<RSLatteResult<unknown>>;
  replaceAll(ctx: RSLatteAtomicOpContext, scan: unknown): Promise<RSLatteResult<unknown>>;

  /** 归档范围外（archive 模式必跑；rebuild 模式按回滚点可先不启用） */
  archiveOutOfRange(ctx: RSLatteAtomicOpContext): Promise<RSLatteResult<unknown>>;

  /** 将已应用的变更构建为 DB ops / queue items（dbSyncEnabled=false 时 engine 可跳过） */
  buildOps(ctx: RSLatteAtomicOpContext, applied: unknown): Promise<RSLatteResult<unknown>>;

  /** flush DB queue（pending/failed 重试策略由 engine 决定） */
  flushQueue(ctx: RSLatteAtomicOpContext, opts: RSLatteFlushQueueOptions): Promise<RSLatteResult<unknown>>;

  /** reconcile 安全门信息（engine 读取并判定是否调用 reconcile） */
  getReconcileGate(ctx: RSLatteAtomicOpContext): Promise<RSLatteResult<RSLatteReconcileGate>>;

  /** reconcile（manual + gate allow；rebuild + gate allow） */
  reconcile(ctx: RSLatteAtomicOpContext, input?: { scan?: unknown; applied?: unknown }): Promise<RSLatteResult<RSLatteModuleOpSummary>>;

  /** 更新 stats（供状态灯/tooltip） */
  stats(ctx: RSLatteAtomicOpContext): Promise<RSLatteResult<RSLatteModuleStats>>;
}

export function isAtomicSpec(spec: any): spec is ModuleSpecAtomic {
  return !!spec && typeof spec.scanIncremental === "function" && typeof spec.applyDelta === "function";
}


/** legacy spec 判定（用于 engine.run 兼容） */
export function isLegacySpec(spec: any): spec is ModuleSpec {
  return !!spec && typeof spec.incrementalRefresh === "function" && typeof spec.rebuild === "function";
}


/** 任意 spec：legacy / atomic / 二者兼容 */
export type ModuleSpecAny = ModuleSpec | ModuleSpecAtomic | (ModuleSpec & ModuleSpecAtomic);
