import type { RSLatteSpaceStatsFileV1, RSLatteSpaceStatsModuleEntryV1 } from "../../types/spaceStats";
import { StatusCalculationService } from "../statusCalculationService";
import type { HubJournalSnapshot } from "./hubJournalSnapshot";

/** Hub 告警区单条（扁平列表，渲染时再按空间折叠） */
export type HubFlatAlert = {
  spaceId: string;
  spaceName: string;
  isCurrent: boolean;
  moduleKey: string;
  text: string;
};

const MODULE_LABEL: Record<string, string> = {
  journal: "日记",
  task: "任务",
  memo: "提醒",
  schedule: "日程",
  checkin: "打卡",
  finance: "财务",
  health: "健康",
  project: "项目",
  output: "输出",
  contacts: "联系人",
};

function labelFor(moduleKey: string): string {
  return MODULE_LABEL[moduleKey] || moduleKey;
}

export type HubAlertInputRow = {
  spaceId: string;
  spaceName: string;
  isCurrent: boolean;
  diaryExists: boolean;
  stats: RSLatteSpaceStatsFileV1 | null;
  /** 该空间下已启用的业务模块键（不含 journal） */
  enabledModules: string[];
  /** 今日日记文件与有效字数（与 Hub 卡片日记行一致） */
  journalSnapshot?: HubJournalSnapshot;
  /** 财务分析告警索引 `missingData` 摘要（按空间预读，见 `readFinanceAnalysisAlertIndex`） */
  financeAnalysisExtras?: string[];
  /** 健康分析告警索引 `missingData` 摘要 */
  healthAnalysisExtras?: string[];
};

/**
 * 根据各空间统计与日记存在性生成 Hub 告警列表（§9.2：内容 ≥3 级、同步 pending/failed、日记未创建）。
 */
export function buildHubFlatAlerts(rows: HubAlertInputRow[]): HubFlatAlert[] {
  const out: HubFlatAlert[] = [];
  for (const r of rows) {
    if (!r.diaryExists) {
      out.push({
        spaceId: r.spaceId,
        spaceName: r.spaceName,
        isCurrent: r.isCurrent,
        moduleKey: "journal",
        text: "今日日记未创建",
      });
    }
    const modules = r.stats?.modules ?? {};
    for (const moduleKey of r.enabledModules) {
      const entry = modules[moduleKey] as RSLatteSpaceStatsModuleEntryV1 | undefined;
      if (!entry) continue;
      const sync = entry.sync_status || "unknown";
      const level = StatusCalculationService.hubContentLevel(moduleKey, entry.kpi);
      const modLabel = labelFor(moduleKey);
      if (level >= 3) {
        const line = StatusCalculationService.hubPrimaryKpiLine(moduleKey, entry.kpi);
        out.push({
          spaceId: r.spaceId,
          spaceName: r.spaceName,
          isCurrent: r.isCurrent,
          moduleKey,
          text: line ? `${modLabel}：${line}` : `${modLabel}：内容 ${level} 级需关注`,
        });
      }
      if (sync === "pending" && (entry.pending_count ?? 0) > 0) {
        out.push({
          spaceId: r.spaceId,
          spaceName: r.spaceName,
          isCurrent: r.isCurrent,
          moduleKey,
          text: `${modLabel}：DB 待同步 ${entry.pending_count} 条`,
        });
      }
      if (sync === "failed" && (entry.failed_count ?? 0) > 0) {
        out.push({
          spaceId: r.spaceId,
          spaceName: r.spaceName,
          isCurrent: r.isCurrent,
          moduleKey,
          text: `${modLabel}：DB 同步失败 ${entry.failed_count} 条`,
        });
      }
    }
    if (r.financeAnalysisExtras?.length && r.enabledModules.includes("finance")) {
      const modLabel = labelFor("finance");
      for (const text of r.financeAnalysisExtras) {
        out.push({
          spaceId: r.spaceId,
          spaceName: r.spaceName,
          isCurrent: r.isCurrent,
          moduleKey: "finance",
          text: `${modLabel}（分析索引）：${text}`,
        });
      }
    }
    if (r.healthAnalysisExtras?.length && r.enabledModules.includes("health")) {
      const modLabel = labelFor("health");
      for (const text of r.healthAnalysisExtras) {
        out.push({
          spaceId: r.spaceId,
          spaceName: r.spaceName,
          isCurrent: r.isCurrent,
          moduleKey: "health",
          text: `${modLabel}（分析索引）：${text}`,
        });
      }
    }
  }
  return out;
}
