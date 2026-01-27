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

  /** 模块关闭不调度（coordinator 不调用 engine.run） */
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
   * 是否维持旧行为：task/memo auto_refresh 成功后弹 Notice
   * 默认 true（尽量不改变用户可感知行为）。
   */
  showNoticeForTaskMemo?: boolean;
};

/**
 * Step S8: Coordinator 调度选择声明式（表驱动）
 * - record/task/memo = E2
 *   - record 组对应 checkin/finance（共享锁 record）
 * - publish 仅实现 atomic spec，无 legacy，必须走 E2
 * - 其他模块 = legacy（run）
 *
 * ⚠️ 只集中“选择策略”，不改变 tick 的时机/频率/顺序。
 */
const AUTO_PIPELINE_ROUTE: Readonly<Record<RSLatteModuleKey, "E2" | "LEGACY">> = {
  task: "E2",
  memo: "E2",
  checkin: "E2", // record group
  finance: "E2", // record group
  project: "E2",
  output: "E2",
  contacts: "E2",
  publish: "E2", // 仅 atomic spec，无 legacy-capable
} as const;

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

  /**
   * Step S8: 表驱动选择 run/runE2。
   * - 不改变 tick 频率/时机/顺序
   * - 仅集中“模块->执行入口”的路由
   */
  private async runAutoByRoute(
    spaceCtx: SpaceCtx,
    moduleKey: RSLatteModuleKey,
    mode: "auto_refresh" | "auto_archive"
  ): Promise<RSLatteResult<AutoRunData>> {
    const route = AUTO_PIPELINE_ROUTE[moduleKey] ?? "LEGACY";
    const r: any = route === "E2" ? await this.engine.runE2(spaceCtx, moduleKey, mode) : await this.engine.run(spaceCtx, moduleKey, mode);
    // 统一返回形状：至少包含 skipped/reason（Engine 两条路径都满足）
    return r as RSLatteResult<AutoRunData>;
  }

  /**
   * 单次 tick：
   * - 逐模块判断是否到达 interval，决定是否调度 auto_refresh
   * - 每日一次 per-module auto_archive
   * - 实际执行统一通过 engine.run / engine.runE2（逐模块选择）
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

    // 维持旧行为：task/memo auto_refresh 成功后弹 Notice（仅这两个）
    if (this.showNoticeForTaskMemo) {
      const labels: string[] = [];
      if (ranAutoRefresh.includes("task")) labels.push("任务");
      if (ranAutoRefresh.includes("memo")) labels.push("备忘");
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
