/**
 * Pipeline locks (A3, E2)
 *
 * 目标：
 * - 提供互斥锁（inFlight）能力，用于拒绝重入
 * - ✅ E2：支持“共享锁 key”（例如 record 组用于 checkin/finance 共享互斥）
 *
 * 约定：
 * - lockKey 规则为单一来源：见 `lockKeys.ts`（Step S4）
 * - 这里仅实现“按 lockKey 维度”的互斥与 inFlight 诊断
 */

import type { RSLatteLockKey, RSLatteModuleKey, RSLattePipelineMode } from "./types";

export type InFlightLockState = {
  /** 互斥维度（moduleKey 或共享组 key） */
  lockKey: RSLatteLockKey;
  /** 实际触发的模块（用于日志诊断） */
  moduleKey: RSLatteModuleKey;
  mode: RSLattePipelineMode;
  runId: string;
  startedAt: string;
};

/**
 * 互斥锁：
 * - tryAcquire()：若已 inFlight 返回 false
 * - release()   ：释放锁（支持 runId 校验，防止误释放）
 */
export class PerModuleInFlightLocks {
  private readonly active = new Map<RSLatteLockKey, InFlightLockState>();

  public isInFlight(lockKey: RSLatteLockKey): boolean {
    return this.active.has(lockKey);
  }

  public get(lockKey: RSLatteLockKey): InFlightLockState | undefined {
    return this.active.get(lockKey);
  }

  public tryAcquire(lockKey: RSLatteLockKey, moduleKey: RSLatteModuleKey, mode: RSLattePipelineMode, runId: string): boolean {
    if (this.active.has(lockKey)) return false;
    this.active.set(lockKey, {
      lockKey,
      moduleKey,
      mode,
      runId,
      startedAt: new Date().toISOString(),
    });
    return true;
  }

  /**
   * 释放锁。
   * - 若提供 runId，则只在 runId 匹配时释放。
   */
  public release(lockKey: RSLatteLockKey, runId?: string): void {
    const cur = this.active.get(lockKey);
    if (!cur) return;
    if (runId && cur.runId !== runId) return;
    this.active.delete(lockKey);
  }
}
