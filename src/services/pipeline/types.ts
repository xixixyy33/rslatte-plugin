/**
 * Pipeline shared types (A1)
 *
 * 目标：建立后续工程化分层的“共同语言”。
 * - 模块枚举（字符串联合类型）
 * - 运行模式枚举（字符串联合类型）
 * - 调度状态结构
 * - 统一结果结构
 *
 * ⚠️ 本文件仅提供类型定义：不包含任何对现有代码的引用与调用点改动。
 */

/** 支持的业务模块（与侧边栏/设置项模块保持一致） */
export type RSLatteModuleKey =
  | "task"
  | "memo"
  | "schedule"
  | "checkin"
  | "finance"
  | "health"
  | "project"
  | "output"
  | "contacts"
  | "knowledge";

/**
 * 锁 key：最终用于 Map key 的字符串。
 *
 * Step F3：锁粒度需要包含 vaultId + spaceId，避免不同 space 串互斥。
 * 例如："<vaultId>:<spaceId>:task" / "<vaultId>:<spaceId>:record"
 */
export type RSLatteLockKey = string;

/** 共享锁组（不包含 scope 前缀） */
export type RSLatteLockGroup = RSLatteModuleKey | "record";

/**
 * 刷新/构建模式（与 `gates.evaluateReconcileGate`、`pipelineEngine.runE2` 一致）
 * - auto / auto_refresh：定时增量；不触发 reconcile（规则 0）
 * - manual_refresh：侧栏/命令「手动刷新」；phase=incremental；门控通过时可 atomic reconcile 与 P6 archiveOutOfRange
 * - rebuild：全量重建；门控通过时可 reconcile 与归档
 */
export type RSLattePipelineMode =
  | "auto"
  | "auto_refresh"
  | "auto_archive"
  | "manual_refresh"
  | "manual_archive"
  | "rebuild";

/** 模块级互斥锁（inFlight）状态 */
export type RSLatteModuleInFlight = {
  /** 是否正在执行 */
  active: boolean;
  /** 当前执行模式（active=false 时可为空） */
  mode?: RSLattePipelineMode;
  /**
   * 本次执行的唯一标识（用于日志关联/诊断）。
   * 推荐使用时间戳或随机串；未接入前仅作为类型占位。
   */
  runId?: string;
};

/**
 * 模块调度状态（用于 UI 展示与门控判断）
 *
 * 约定：时间字段使用 ISO 8601 字符串（例如 new Date().toISOString()）。
 */
export interface RSLatteModuleScheduleState {
  moduleKey: RSLatteModuleKey;
  inFlight: RSLatteModuleInFlight;

  /** 最近一次开始执行的时间 */
  lastStartedAt?: string;
  /** 最近一次成功完成的时间 */
  lastSucceededAt?: string;
  /** 最近一次失败的时间 */
  lastFailedAt?: string;

  /** 最近一次失败原因（简短信息） */
  lastErrorMessage?: string;
}

/** 统一错误结构（仅结构化，不绑定具体实现） */
export interface RSLatteError {
  /**
   * 机器可读的错误码（例如："LOCKED" | "NETWORK" | "VALIDATION" 等）。
   * 统一使用大写蛇形命名。
   */
  code: string;
  /** 人类可读的错误信息（可直接展示到 Notice/日志） */
  message: string;
  /** 可选：更详细的上下文信息（用于调试） */
  detail?: unknown;
}

/**
 * 统一结果结构
 * - ok=true  ：携带 data（可选 warnings）
 * - ok=false ：携带 error
 */
export type RSLatteResult<T> =
  | {
      ok: true;
      data: T;
      warnings?: string[];
    }
  | {
      ok: false;
      error: RSLatteError;
    };

/**
 * E2: Unified scan result (P2)
 *
 * 说明：scanFull/scanIncremental 统一输出该结构，供 engine 模板在后续 step 中消费。
 * - 本 step 只补齐扫描结果结构，不改变现有索引存储格式。
 */
export type RSLatteScanMode = "full" | "inc";

export type RSLatteScanResult<TId extends string | number = string> = {
  mode: RSLatteScanMode;
  /** best-effort: changed file paths in vault */
  changedFiles: string[];
  /** newly discovered ids since last index */
  addedIds: TId[];
  /** ids with detected changes (mtime/key) */
  updatedIds: TId[];
  /** ids removed from vault (deleted/moved out of roots) */
  removedIds: TId[];
  meta: {
    scannedAt: number;
    reason?: string;
    /** best-effort: scan detected files with missing uid/id (safe gate for reconcile) */
    uidMissingFiles?: string[];
    /** best-effort: scan detected files failed to parse (safe gate for reconcile) */
    parseErrorFiles?: string[];
  };
};
