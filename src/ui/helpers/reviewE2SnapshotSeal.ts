import { moment } from "obsidian";
import type RSLattePlugin from "../../main";
import type { ReviewSnapshotGrain } from "./reviewPeriodSnapshotStore";
import {
  e2CompletedReviewSnapshotIsSealed,
  writeE2CompletedReviewSnapshot,
} from "./reviewPeriodSnapshotStore";
import { assessReviewIndexCoverageForPeriod, workEventMonthKeysForYmdRange } from "./reviewPeriodCoverage";
import { buildReviewExecuteModel } from "./reviewExecuteModel";
import { buildReviewReconcileModel } from "./reviewReconcileModel";
import { buildReviewRecordsModel } from "./reviewRecordsModel";

const momentFn = moment as any;

function getTodayYmd(plugin: RSLattePlugin): string {
  return (plugin as any).getTodayKey?.() ?? momentFn().format("YYYY-MM-DD");
}

/** 当前 ISO 周的上一完整周 */
function previousIsoWeekPeriod(todayYmd: string): { periodKey: string; startYmd: string; endYmd: string } | null {
  const t = momentFn(todayYmd, "YYYY-MM-DD", true);
  if (!t.isValid()) return null;
  const start = t.clone().startOf("isoWeek").subtract(1, "week");
  const end = start.clone().endOf("isoWeek");
  const y = start.isoWeekYear();
  const w = start.isoWeek();
  return {
    periodKey: `${y}-W${String(w).padStart(2, "0")}`,
    startYmd: start.format("YYYY-MM-DD"),
    endYmd: end.format("YYYY-MM-DD"),
  };
}

/** 当前自然月的上一完整月 */
function previousCalendarMonthPeriod(todayYmd: string): { periodKey: string; startYmd: string; endYmd: string } | null {
  const t = momentFn(todayYmd, "YYYY-MM-DD", true);
  if (!t.isValid()) return null;
  const start = t.clone().subtract(1, "month").startOf("month");
  const end = start.clone().endOf("month");
  return {
    periodKey: start.format("YYYY-MM"),
    startYmd: start.format("YYYY-MM-DD"),
    endYmd: end.format("YYYY-MM-DD"),
  };
}

function periodIsFullyEnded(endYmd: string, todayYmd: string): boolean {
  return String(todayYmd) > String(endYmd);
}

async function withPluginCurrentSpace<T>(plugin: RSLattePlugin, spaceId: string, fn: () => Promise<T>): Promise<T> {
  const s = plugin.settings as any;
  const prev = String(s.currentSpaceId ?? "").trim();
  if (prev === spaceId) return fn();
  s.currentSpaceId = spaceId;
  try {
    return await fn();
  } finally {
    s.currentSpaceId = prev;
  }
}

/**
 * 在「自动刷新 tick」末尾调用：为上一 ISO 周、上一自然月各尝试写入一条 `review-*.{grain}.*.completed.json`。
 * - 已存在且 `seal=e2_completed_period` 则跳过（快速路径）
 * - 周期须已结束（today > periodEnd）
 * - 主索引 `full_outside` 时不写（与手动快照一致）
 */
export async function runE2SealPreviousPeriodReviewSnapshots(plugin: RSLattePlugin, spaceId: string): Promise<void> {
  await withPluginCurrentSpace(plugin, spaceId, async () => {
    const todayYmd = getTodayYmd(plugin);
    const grains: ReviewSnapshotGrain[] = ["week", "month"];

    for (const grain of grains) {
      const period = grain === "week" ? previousIsoWeekPeriod(todayYmd) : previousCalendarMonthPeriod(todayYmd);
      if (!period) continue;
      if (!periodIsFullyEnded(period.endYmd, todayYmd)) continue;

      try {
        if (await e2CompletedReviewSnapshotIsSealed(plugin, spaceId, grain, period.periodKey)) {
          continue;
        }

        const ass = assessReviewIndexCoverageForPeriod(period.startYmd, period.endYmd, todayYmd, plugin.settings);
        if (!ass.allowSnapshot) {
          if (plugin.isDebugLogEnabled?.()) {
            (plugin as any).dbg?.("reviewE2Seal", "skip_full_outside", { spaceId, grain, periodKey: period.periodKey });
          }
          continue;
        }

        const indexMeta = {
          risk: ass.risk,
          retentionStartYmd: ass.retentionStartYmd,
          workEventMonthKeys: workEventMonthKeysForYmdRange(period.startYmd, period.endYmd),
        };

        const execute = await buildReviewExecuteModel(plugin, period.startYmd, period.endYmd, grain);
        const reconcile = await buildReviewReconcileModel(plugin, period.startYmd, period.endYmd, grain);
        const records = await buildReviewRecordsModel(plugin, period.startYmd, period.endYmd, grain);

        await writeE2CompletedReviewSnapshot(
          plugin,
          spaceId,
          grain,
          period.periodKey,
          period.startYmd,
          period.endYmd,
          indexMeta,
          { execute, reconcile, records },
        );

        if (plugin.isDebugLogEnabled?.()) {
          (plugin as any).dbg?.("reviewE2Seal", "written", { spaceId, grain, periodKey: period.periodKey });
        }
      } catch (e) {
        console.warn(`[RSLatte] reviewE2Seal failed (${grain}):`, e);
      }
    }
  });
}
