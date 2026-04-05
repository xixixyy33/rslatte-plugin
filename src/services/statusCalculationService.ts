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

    // memo: 逾期未关闭提醒
    if (moduleKey === "memo" && kpi.memo) {
      const o = num(kpi.memo.overdueUnclosed);
      if (o > 0) {
        return {
          hasWarning: true,
          icon: "🟡",
          description: `有 ${o} 条逾期未关闭提醒`,
          severity: "warning",
        };
      }
    }

    // schedule: 逾期未结束块
    if (moduleKey === "schedule" && kpi.schedule) {
      const e = num(kpi.schedule.expectedUnclosedCount);
      if (e > 0) {
        return {
          hasWarning: true,
          icon: "🟡",
          description: `有 ${e} 个日程块已过结束时间仍未关闭`,
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

  /**
   * Hub 同步灯 emoji（§9.3：失败🔴 > 本地 pending🟡 > ok🟢；未启用/未知→⚪）
   */
  static hubSyncEmoji(syncStatus: RSLatteSpaceStatsSyncStatus): string {
    if (syncStatus === "failed") return "🔴";
    if (syncStatus === "pending") return "🟡";
    if (syncStatus === "ok") {
      return "🟢";
    }
    if (syncStatus === "off" || syncStatus === "unknown") return "⚪";
    return "⚪";
  }

  /** Hub 内容灯：1 最优 … 5 最差（与《空间管理优化方案》§9.4 主要阈值对齐的可运行子集） */
  static hubContentLevel(moduleKey: string, kpi: RSLatteModuleKpiByModule | undefined): number {
    if (!kpi) return 2;
    if (moduleKey === "task" && kpi.task) {
      const { overdue, dueTodayTotal, dueTodayDone, next7d } = kpi.task;
      const o = num(overdue);
      const n7 = num(next7d);
      const dtt = num(dueTodayTotal);
      const dtd = num(dueTodayDone);
      if (o >= 5 || (o >= 1 && n7 >= 20)) return 5;
      if ((o >= 1 && o <= 4) || (o === 0 && dtt > 0 && dtd / dtt < 0.5)) return 4;
      if ((o === 0 && dtt > 0 && dtd / dtt >= 0.5 && dtd < dtt) || n7 >= 10) return 3;
      if (o === 0 && (dtt === 0 || dtd === dtt) && n7 <= 9) return n7 <= 3 ? 1 : 2;
      return 2;
    }
    if (moduleKey === "checkin" && kpi.checkin) {
      const { todayDone, todayTotal, streak } = kpi.checkin;
      const tt = num(todayTotal);
      if (tt > 0) {
        const R = todayDone / todayTotal;
        if (R < 0.3) return 5;
        if (R < 0.6) return 4;
        if (R < 0.85) return 3;
        return num(streak) >= 7 ? 1 : 2;
      }
      return 2;
    }
    if (moduleKey === "project" && kpi.project) {
      const { activeProjects: _ap, dueNext14d, overdue } = kpi.project;
      const o = num(overdue);
      const d14 = num(dueNext14d);
      if (o >= 2 || (o === 1 && d14 >= 8)) return 5;
      if ((o === 1 && d14 < 8) || (o === 0 && d14 >= 8)) return 4;
      if (o === 0 && d14 >= 4 && d14 <= 7) return 3;
      if (o === 0 && d14 >= 1 && d14 <= 3) return 2;
      if (o === 0 && d14 === 0 && num(_ap) > 0) return 1;
      return 2;
    }
    if (moduleKey === "output" && kpi.output) {
      const sc = num(kpi.output.staleCount);
      const gw = num(kpi.output.generatedThisWeek);
      if (sc >= 10) return 5;
      if (sc >= 5) return 4;
      if (sc >= 1) return 3;
      if (sc === 0 && gw < 1) return 2;
      return 1;
    }
    if (moduleKey === "contacts" && kpi.contacts) {
      const { touched30d, upcoming30d } = kpi.contacts;
      const u = num(upcoming30d);
      const t = num(touched30d);
      if (u >= 8 && t === 0) return 5;
      if (u >= 5 || (u >= 1 && t === 0)) return 4;
      if (u >= 1 && u <= 4 && t >= 1) return 3;
      if (u === 0 && t >= 1) return t >= 5 ? 1 : 2;
      return 2;
    }
    if (moduleKey === "memo" && kpi.memo) {
      const O = num(kpi.memo.overdueUnclosed);
      const U = num(kpi.memo.dueWithin7dUnclosed);
      const lo =
        O === 0 ? 1 : O <= 2 ? 4 : O === 3 ? 5 : 5;
      const lu =
        U === 0 ? 1 : U <= 8 ? 2 : U <= 15 ? 3 : U <= 24 ? 4 : 5;
      return Math.max(lo, lu);
    }
    if (moduleKey === "schedule" && kpi.schedule) {
      const H = num(kpi.schedule.scheduledHoursNext7d);
      const E = num(kpi.schedule.expectedUnclosedCount);
      const lh =
        H < 8 ? 1 : H < 16 ? 2 : H < 25 ? 3 : H < 36 ? 4 : 5;
      const le =
        E === 0 ? 1 : E <= 2 ? 4 : E === 3 ? 5 : 5;
      return Math.max(lh, le);
    }
    if (moduleKey === "finance" && kpi.finance) {
      const net = kpi.finance.mtdNet;
      if (net === undefined || !Number.isFinite(net)) return 2;
      if (net < -5000) return 5;
      if (net < -1000) return 4;
      if (net < 0) return 3;
      if (net < 3000) return 2;
      return 1;
    }
    return 2;
  }

  static hubContentEmojiFromLevel(level: number): string {
    if (level >= 5) return "🔴";
    if (level === 4) return "🟠";
    if (level === 3) return "🟡";
    if (level === 2) return "🟢";
    return "🔵";
  }

  /** Hub 灯后主文案：优先暴露抬级 KPI（§9.5） */
  static hubPrimaryKpiLine(moduleKey: string, kpi: RSLatteModuleKpiByModule | undefined): string {
    if (!kpi) return "";
    if (moduleKey === "task" && kpi.task) {
      const t = kpi.task;
      const parts: string[] = [];
      if (num(t.overdue) > 0) parts.push(`超期 ${t.overdue}`);
      if (num(t.dueTodayTotal) > 0) parts.push(`今日 ${t.dueTodayDone}/${t.dueTodayTotal}`);
      if (num(t.next7d) > 0) parts.push(`7天内 ${t.next7d}`);
      return parts.join(" · ") || "暂无待关注项";
    }
    if (moduleKey === "checkin" && kpi.checkin) {
      const c = kpi.checkin;
      if (num(c.todayTotal) > 0) {
        return `今日 ${c.todayDone}/${c.todayTotal}` + (num(c.streak) > 0 ? ` · 连续 ${c.streak} 天` : "");
      }
      return num(c.streak) > 0 ? `连续 ${c.streak} 天` : "今日无必打项";
    }
    if (moduleKey === "project" && kpi.project) {
      const p = kpi.project;
      const parts: string[] = [];
      if (num(p.overdue) > 0) parts.push(`超期 ${p.overdue}`);
      if (num(p.dueNext14d) > 0) parts.push(`14天内到期 ${p.dueNext14d}`);
      if (p.activeProjects !== undefined) parts.push(`进行中 ${p.activeProjects}`);
      return parts.join(" · ") || "";
    }
    if (moduleKey === "output" && kpi.output) {
      const o = kpi.output;
      if (num(o.staleCount) > 0) return `超过30天未完成 ${o.staleCount}`;
      return `本周 ${num(o.generatedThisWeek)}`;
    }
    if (moduleKey === "contacts" && kpi.contacts) {
      const c = kpi.contacts;
      return `30天将到 ${num(c.upcoming30d)} · 30天接触 ${num(c.touched30d)}`;
    }
    if (moduleKey === "memo" && kpi.memo) {
      const m = kpi.memo;
      const parts: string[] = [];
      if (num(m.overdueUnclosed) > 0) parts.push(`逾期未关 ${m.overdueUnclosed}`);
      if (num(m.dueWithin7dUnclosed) > 0) parts.push(`7日内待处理 ${m.dueWithin7dUnclosed}`);
      if (parts.length) {
        if (m.total !== undefined) parts.push(`总计 ${m.total}`);
        return parts.join(" · ");
      }
      return `近7天新增 ${num(m.new7d)}` + (m.total !== undefined ? ` · 总计 ${m.total}` : "");
    }
    if (moduleKey === "schedule" && kpi.schedule) {
      const sc = kpi.schedule;
      const parts: string[] = [];
      if (num(sc.scheduledHoursNext7d) > 0) parts.push(`7天内约 ${sc.scheduledHoursNext7d.toFixed(1)}h`);
      if (num(sc.expectedUnclosedCount) > 0) parts.push(`逾期未结束 ${sc.expectedUnclosedCount}`);
      return parts.join(" · ") || "近 7 天无排程";
    }
    if (moduleKey === "finance" && kpi.finance) {
      const f = kpi.finance;
      const parts: string[] = [];
      if (f.mtdNet !== undefined && Number.isFinite(f.mtdNet)) parts.push(`本月净额 ¥${f.mtdNet.toFixed(2)}`);
      if (f.mtdSpend !== undefined && num(f.mtdSpend) !== 0) parts.push(`支出 ¥${f.mtdSpend.toFixed(2)}`);
      return parts.join(" · ") || "";
    }
    return "";
  }

  static hubContentTooltip(moduleKey: string, kpi: RSLatteModuleKpiByModule | undefined, level: number): string {
    const line = StatusCalculationService.hubPrimaryKpiLine(moduleKey, kpi);
    return line ? `内容 ${level} 级：${line}` : `内容 ${level} 级`;
  }

  static hubSyncTooltip(syncStatus: RSLatteSpaceStatsSyncStatus, entry: RSLatteSpaceStatsModuleEntryV1): string {
    const syncTexts: Record<RSLatteSpaceStatsSyncStatus, string> = {
      ok: "DB 同步正常",
      pending: `DB 待同步 ${entry.pending_count || 0} 条`,
      failed: `DB 同步失败 ${entry.failed_count || 0} 条`,
      off: "DB 同步未启用",
      unknown: "DB 同步状态未知",
    };
    return syncTexts[syncStatus] || "同步未知";
  }
}
