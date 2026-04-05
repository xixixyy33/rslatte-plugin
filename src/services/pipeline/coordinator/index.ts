import type { RSLatteModuleKey, RSLatteResult } from "../types";
import type { ModuleRegistry } from "../moduleRegistry";
import type { PipelineEngine } from "../pipelineEngine";
import type { SpaceCtx } from "../../../types/space";

import { moment, Notice } from "obsidian";
// ✅ moment 从 Obsidian 导入，但 TypeScript 类型定义可能不完整，使用类型断言
const momentFn = moment as any;

export type CoordinatorTickResult = {
  ranAutoRefresh: RSLatteModuleKey[];
  ranAutoArchive: RSLatteModuleKey[];
  skipped: Array<{ moduleKey: RSLatteModuleKey; reason: string }>;
};

export type AutoRefreshCoordinatorOptions = {
  registry: ModuleRegistry;
  engine: PipelineEngine;

  /** 模块关闭不调度 */
  isModuleEnabled: (moduleKey: RSLatteModuleKey) => boolean;

  /** 每模块独立 interval（毫秒）。lastAutoRunAt 仅在成功后更新 */
  getIntervalMs: (moduleKey: RSLatteModuleKey) => number;

  /**
   * 可选：auto_refresh 额外门控（例如 record 手动 busy 时跳过 checkin/finance）
   * 返回 false 表示本次 tick 不调度该模块 auto_refresh。
   */
  canAutoRefresh?: (moduleKey: RSLatteModuleKey) => boolean;

  /**
   * 可选：auto_archive 额外门控（默认与 isModuleEnabled 一致）
   */
  canAutoArchive?: (moduleKey: RSLatteModuleKey) => boolean;

  /**
   * tick 完成后的回调（例如刷新 side panel）
   * main.ts timer 回调只调用 coordinator.tick()，所以 side-effect 放这里更合适。
   */
  afterTick?: () => void;

  /**
   * 是否维持旧行为：task / memo / **schedule** 在 auto_refresh 成功后弹 Notice（文案「任务、提醒、日程」）。
   * 默认 true（尽量不改变用户可感知行为）。
   */
  showNoticeForTaskMemo?: boolean;
};

/**
 * **[X-Pipeline]（自动调度单轨）**
 * - `tick` 内 **`auto_refresh` / `auto_archive` 一律 `engine.runE2`**，不再分支 `engine.run`（LEGACY）。
 * - Atomic spec 由 `pipelineManager` + `specRegistry` 注入；无 atomic 时 `runE2` 返回 `SPEC_NOT_ATOMIC`（skipped）。
 * - 各模块语义与门控见《索引优化方案》§7.0.1；`schedule` 的 **legacy** 槽仅为兼容占位，**自动 tick 不经过**。
 */

type ModuleAutoState = {
  lastAutoRunAt?: number; // epoch ms
  lastArchiveDate?: string; // YYYY-MM-DD (local)
};

type AutoRunData = { skipped: boolean; reason?: string };

function isOkAndExecuted(r: RSLatteResult<AutoRunData>): boolean {
  return r.ok && r.data.skipped === false;
}

// ✅ 状态键：spaceId + moduleKey，确保每个空间的模块状态独立
function makeStateKey(spaceId: string, moduleKey: RSLatteModuleKey): string {
  return `${spaceId}:${moduleKey}`;
}

export class AutoRefreshCoordinator {
  private readonly registry: ModuleRegistry;
  private readonly engine: PipelineEngine;
  private readonly isModuleEnabled: (moduleKey: RSLatteModuleKey) => boolean;
  private readonly getIntervalMs: (moduleKey: RSLatteModuleKey) => number;
  private readonly canAutoRefresh?: (moduleKey: RSLatteModuleKey) => boolean;
  private readonly canAutoArchive?: (moduleKey: RSLatteModuleKey) => boolean;
  private readonly afterTick?: () => void;
  private readonly showNoticeForTaskMemo: boolean;

  // ✅ 状态按 spaceId + moduleKey 管理，确保每个空间的模块状态独立
  private readonly state = new Map<string, ModuleAutoState>();

  constructor(opts: AutoRefreshCoordinatorOptions) {
    this.registry = opts.registry;
    this.engine = opts.engine;
    this.isModuleEnabled = opts.isModuleEnabled;
    this.getIntervalMs = opts.getIntervalMs;
    this.canAutoRefresh = opts.canAutoRefresh;
    this.canAutoArchive = opts.canAutoArchive;
    this.afterTick = opts.afterTick;
    this.showNoticeForTaskMemo = opts.showNoticeForTaskMemo ?? true;
  }

  private getState(spaceId: string, moduleKey: RSLatteModuleKey): ModuleAutoState {
    const key = makeStateKey(spaceId, moduleKey);
    let st = this.state.get(key);
    if (!st) {
      st = {};
      this.state.set(key, st);
    }
    return st;
  }

  private todayStr(): string {
    return momentFn().format("YYYY-MM-DD");
  }

  /** 自动调度仅走 E2（与 `runAutoRefreshTick` / 侧栏手动 `runE2` 同源）。 */
  private async runAutoByRoute(
    spaceCtx: SpaceCtx,
    moduleKey: RSLatteModuleKey,
    mode: "auto_refresh" | "auto_archive"
  ): Promise<RSLatteResult<AutoRunData>> {
    const r: any = await this.engine.runE2(spaceCtx, moduleKey, mode);
    return r as RSLatteResult<AutoRunData>;
  }

  /**
   * 单次 tick：
   * - 逐模块判断是否到达 interval，决定是否调度 auto_refresh
   * - 每日一次 per-module auto_archive
   * - 实际执行统一通过 **engine.runE2**
   */
  public async tick(spaceCtx: SpaceCtx): Promise<CoordinatorTickResult> {
    const now = Date.now();
    const today = this.todayStr();

    const ranAutoRefresh: RSLatteModuleKey[] = [];
    const ranAutoArchive: RSLatteModuleKey[] = [];
    const skipped: Array<{ moduleKey: RSLatteModuleKey; reason: string }> = [];

    // 维持旧顺序（registry 的默认 keys 顺序）
    const spaceId = spaceCtx.spaceId || "";
    for (const moduleKey of this.registry.listKeys()) {
      // 模块关闭不调度
      if (!this.isModuleEnabled(moduleKey)) continue;

      const st = this.getState(spaceId, moduleKey);

      // 1) auto_refresh（按 interval）
      const intervalMs = Math.max(0, Number(this.getIntervalMs(moduleKey) ?? 0));

      const due =
        st.lastAutoRunAt === undefined
          ? true
          : intervalMs <= 0
            ? true
            : now - st.lastAutoRunAt >= intervalMs;

      if (due) {
        if (this.canAutoRefresh && this.canAutoRefresh(moduleKey) === false) {
          skipped.push({ moduleKey, reason: "AUTO_REFRESH_BLOCKED" });
        } else {
          if (moduleKey === "output") {
            console.log(`[rslatte] Coordinator: starting auto_refresh for ${moduleKey} in space ${spaceId} (${spaceCtx.space?.name || spaceId})`);
          }
          const r = await this.runAutoByRoute(spaceCtx, moduleKey, "auto_refresh");
          // lastAutoRunAt 仅在成功后更新
          if (isOkAndExecuted(r)) {
            st.lastAutoRunAt = now;
            ranAutoRefresh.push(moduleKey);
            if (moduleKey === "output") {
              console.log(`[rslatte] Coordinator: auto_refresh for ${moduleKey} in space ${spaceId} completed successfully`);
            }
          } else if (r.ok && r.data.skipped) {
            skipped.push({ moduleKey, reason: r.data.reason ?? "SKIPPED" });
            if (moduleKey === "output") {
              console.log(`[rslatte] Coordinator: auto_refresh for ${moduleKey} in space ${spaceId} skipped: ${r.data.reason ?? "SKIPPED"}`);
            }
          } else if (!r.ok) {
            skipped.push({ moduleKey, reason: r.error.code ?? "FAILED" });
            if (moduleKey === "output") {
              console.warn(`[rslatte] Coordinator: auto_refresh for ${moduleKey} in space ${spaceId} failed:`, r.error);
            }
          }
        }
      }

      // 2) auto_archive：每日一次（与 interval 无关）
      if (st.lastArchiveDate !== today) {
        if (this.canAutoArchive && this.canAutoArchive(moduleKey) === false) {
          skipped.push({ moduleKey, reason: "AUTO_ARCHIVE_BLOCKED" });
        } else {
          const a = await this.runAutoByRoute(spaceCtx, moduleKey, "auto_archive");
          if (isOkAndExecuted(a)) {
            st.lastArchiveDate = today;
            ranAutoArchive.push(moduleKey);
          } else if (a.ok && a.data.skipped) {
            skipped.push({ moduleKey, reason: a.data.reason ?? "SKIPPED" });
          } else if (!a.ok) {
            skipped.push({ moduleKey, reason: a.error.code ?? "FAILED" });
          }
        }
      }
    }

    // 维持旧行为：任务域三模块 auto_refresh 成功后弹 Notice（与 E2 路由一致）
    if (this.showNoticeForTaskMemo) {
      const labels: string[] = [];
      if (ranAutoRefresh.includes("task")) labels.push("任务");
      if (ranAutoRefresh.includes("memo")) labels.push("提醒");
      if (ranAutoRefresh.includes("schedule")) labels.push("日程");
      if (labels.length) {
        new Notice(`自动刷新完成：${labels.join("、")}`);
      }
    }

    // tick 收尾（例如刷新 side panel）
    try {
      this.afterTick?.();
    } catch {
      // ignore
    }

    return { ranAutoRefresh, ranAutoArchive, skipped };
  }
}
