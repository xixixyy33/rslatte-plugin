import type { RSLatteReconcileGate } from "./pipeline/moduleSpec";
import type {
  RSLatteSpaceStatsSyncStatus,
  RSLatteModuleKpiByModule,
  RSLatteSpaceStatsModuleEntryV1,
} from "../types/spaceStats";

function num(v: any): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 业务状态（用于显示业务逻辑警告）
 */
export type BusinessStatus = {
  hasWarning: boolean;
  icon: string;
  description: string;
  severity: "warning" | "error";
};

/**
 * 统一的状态计算服务
 * 
 * 目标：将分散在 SpaceHubView 和 spaceStatsService 中的状态计算逻辑统一到这里，
 * 确保状态计算的一致性。
 */
export class StatusCalculationService {
  /**
   * 计算同步状态（从 gate 对象）
   */
  static calculateSyncStatus(gate: RSLatteReconcileGate | undefined): RSLatteSpaceStatsSyncStatus {
    if (!gate) return "unknown";
    if (gate.dbSyncEnabled !== true) return "off";
    const pending = num((gate as any).pendingCount);
    const failed = num((gate as any).failedCount);
    if (failed > 0) return "failed";
    if (pending > 0) return "pending";
    return "ok";
  }

  /**
   * 计算业务状态（从 KPI 数据）
   */
  static calculateBusinessStatus(
    moduleKey: string,
    kpi: RSLatteModuleKpiByModule | undefined
  ): BusinessStatus | null {
    if (!kpi) return null;

    // checkin: 打卡率
    if (moduleKey === "checkin" && kpi.checkin) {
      const { todayDone, todayTotal } = kpi.checkin;
      if (todayTotal > 0) {
        const completionRate = (todayDone / todayTotal) * 100;
        if (completionRate < 30) {
          return {
            hasWarning: true,
            icon: "🔴",
            description: `打卡率 ${completionRate.toFixed(0)}%（${todayDone}/${todayTotal}）`,
            severity: "error",
          };
        } else if (completionRate <= 80) {
          return {
            hasWarning: true,
            icon: "🟡",
            description: `打卡率 ${completionRate.toFixed(0)}%（${todayDone}/${todayTotal}）`,
            severity: "warning",
          };
        } else {
          // 打卡率 > 80%，显示正常状态（hasWarning: true 确保业务状态优先，覆盖同步状态）
          return {
            hasWarning: true,
            icon: "🟢",
            description: `打卡率 ${completionRate.toFixed(0)}%（${todayDone}/${todayTotal}）`,
            severity: "warning",
          };
        }
      }
    }

    // task: 超期任务
    if (moduleKey === "task" && kpi.task) {
      if (kpi.task.overdue > 0) {
        return {
          hasWarning: true,
          icon: "🟡",
          description: `有 ${kpi.task.overdue} 个超期任务`,
          severity: "warning",
        };
      }
    }

    // finance: 净额为负
    if (moduleKey === "finance" && kpi.finance) {
      if (kpi.finance.mtdNet !== undefined && kpi.finance.mtdNet < 0) {
        return {
          hasWarning: true,
          icon: "🟡",
          description: `本月净额为负：¥${kpi.finance.mtdNet.toFixed(2)}`,
          severity: "warning",
        };
      }
    }

    // project: 超期项目
    if (moduleKey === "project" && kpi.project) {
      if (kpi.project.overdue !== undefined && kpi.project.overdue > 0) {
        return {
          hasWarning: true,
          icon: "🟡",
          description: `有 ${kpi.project.overdue} 个超过截至日期的项目`,
          severity: "warning",
        };
      }
    }

    // output: 超过30天未完成
    if (moduleKey === "output" && kpi.output) {
      if (kpi.output.staleCount !== undefined && kpi.output.staleCount > 0) {
        return {
          hasWarning: true,
          icon: "🟡",
          description: `有 ${kpi.output.staleCount} 个超过30天未完成或取消的输出`,
          severity: "warning",
        };
      }
    }

    return null;
  }

  /**
   * 计算最终状态图标（业务状态优先）
   * 
   * 优先级规则：
   * 1. 如果模块未启用，显示 ⚪（灰色圆圈）表示模块已关闭
   * 2. 如果有业务状态警告，优先显示业务状态图标（🟡 或 🔴）
   * 3. 如果没有业务警告，显示同步状态图标（🟢/🟡/🔴/⚪/⚫）
   * 
   * 这样确保用户首先看到业务层面的问题，而不是技术层面的同步状态。
   * 
   * @param _moduleKey 模块键（保留用于未来扩展，当前未使用）
   * @param syncStatus 同步状态
   * @param businessStatus 业务状态（如果有）
   * @param isModuleEnabled 模块是否启用（可选，如果为 false 则显示未启用状态）
   */
  static calculateStatusIcon(
    _moduleKey: string,
    syncStatus: RSLatteSpaceStatsSyncStatus,
    businessStatus: BusinessStatus | null,
    isModuleEnabled: boolean = true
  ): string {
    // 0. 如果模块未启用，显示灰色圆圈
    if (!isModuleEnabled) {
      return "⚪";
    }

    // 1. 业务状态优先（如果有警告）
    if (businessStatus?.hasWarning) {
      return businessStatus.icon;
    }

    // 2. 否则显示同步状态
    const icons: Record<RSLatteSpaceStatsSyncStatus, string> = {
      ok: "🟢",
      pending: "🟡",
      failed: "🔴",
      off: "⚪",
      unknown: "⚫",
    };
    return icons[syncStatus] || "⚫";
  }

  /**
   * 计算状态文字描述（用于 tooltip）
   * 
   * 显示规则：
   * 1. 如果模块未启用，显示"模块已关闭"
   * 2. 对于有业务状态的模块（task, finance, project, output）：
   *    - 如果有业务警告，显示："{业务状态描述} | {同步状态描述}"
   *    - 如果没有业务警告，只显示同步状态描述
   * 3. 对于只有同步状态的模块（checkin, contacts, memo）：
   *    - 只显示同步状态描述
   * 
   * 这样在 tooltip 中同时展示业务状态和同步状态，让用户了解完整的状态信息。
   */
  static calculateStatusText(
    moduleKey: string,
    syncStatus: RSLatteSpaceStatsSyncStatus,
    businessStatus: BusinessStatus | null,
    entry: RSLatteSpaceStatsModuleEntryV1,
    isModuleEnabled: boolean = true
  ): string {
    // 0. 如果模块未启用，显示"模块已关闭"
    if (!isModuleEnabled) {
      return "模块已关闭";
    }

    const parts: string[] = [];

    // 1. 业务状态描述（如果有）
    if (businessStatus?.hasWarning) {
      parts.push(businessStatus.description);
    }

    // 2. 同步状态描述（始终显示）
    const syncTexts: Record<RSLatteSpaceStatsSyncStatus, string> = {
      ok: "DB 同步正常",
      pending: `DB 同步中（待同步：${entry.pending_count || 0}）`,
      failed: `DB 同步失败（失败：${entry.failed_count || 0}）`,
      off: "DB 同步已关闭",
      unknown: "DB 同步状态未知",
    };

    const syncText = syncTexts[syncStatus] || "状态未知";

    // 如果有业务状态，同时显示业务状态和同步状态
    if (businessStatus?.hasWarning) {
      return `${businessStatus.description} | ${syncText}`;
    }

    // 对于只显示同步状态的模块（contacts, memo），只返回同步状态
    // checkin 现在有业务状态，所以不再限制
    if (moduleKey === "contacts" || moduleKey === "memo") {
      return syncText;
    }

    return syncText;
  }
}
