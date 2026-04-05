/**
 * Review「记录摘要」C 区：打卡/财务/健康/日记 轻量分析报告（周期内统计 + 可读建议）。
 * 方案见 `Review侧边栏优化方案.md` §4.6.4。
 */
import { moment } from "obsidian";
import type RSLattePlugin from "../../main";
import type { CheckinRecordIndexItem } from "../../types/recordIndexTypes";
import type { CheckinItemDef, JournalPanel } from "../../types/rslatteTypes";
import {
  CHECKIN_DIFFICULTY_LABELS,
  normalizeCheckinDifficulty,
  type CheckinDifficulty,
} from "../../types/rslatteTypes";
import { countJournalMeaningfulChars } from "./todayRecordsModel";
import { readFinanceAnalysisAlertIndex } from "../../services/finance/financeAnalysisAlertIndex";
import {
  readFinanceAlertsSnapshot,
  readFinanceStatsSnapshot,
  type FinanceAnalysisGrain,
  type FinanceAlertSnapshotItem,
} from "../../services/finance/financeAnalysisIndex";
import { readHealthAlertsSnapshot, readHealthStatsSnapshot } from "../../services/health/healthAnalysisIndex";
import { enumerateCalendarMonthKeysBetween } from "./reviewIndexMerge";

const momentFn = moment as any;

/** 与 Review 周期粒度一致，避免与 reviewRecordsModel 循环引用 */
export type ReviewSummaryGrain = "week" | "month" | "quarter";

/** 侧栏行语义色（供 CSS） */
export type ReviewRecordRichLine = {
  text: string;
  tone?: "default" | "muted" | "encourage" | "warn" | "danger";
};

function ymdInRange(ymd: string, startYmd: string, endYmd: string): boolean {
  const s = String(ymd ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return s >= startYmd && s <= endYmd;
}

function enumerateYmdInclusive(startYmd: string, endYmd: string): string[] {
  const out: string[] = [];
  let d = momentFn(startYmd, "YYYY-MM-DD", true);
  const end = momentFn(endYmd, "YYYY-MM-DD", true);
  if (!d.isValid() || !end.isValid()) return out;
  while (d.isSameOrBefore(end, "day")) {
    out.push(d.format("YYYY-MM-DD"));
    d = d.clone().add(1, "day");
  }
  return out;
}

/** 与 finance-analysis 周期键一致（周：`GGGG-[W]WW`） */
export function financePeriodKeyFromReviewStart(startYmd: string, grain: ReviewSummaryGrain): string {
  const m = momentFn(startYmd, "YYYY-MM-DD", true);
  if (!m.isValid()) return "";
  if (grain === "week") return m.format("GGGG-[W]WW");
  if (grain === "quarter") return "";
  return m.format("YYYY-MM");
}

/** 当前 Review 周期的上一完整周/月（与 ISO 周、自然月对齐） */
export function computePrevPeriodYmd(
  grain: ReviewSummaryGrain,
  startYmd: string,
  endYmd: string,
): { prevStartYmd: string; prevEndYmd: string; label: string } | null {
  const s = momentFn(startYmd, "YYYY-MM-DD", true);
  const e = momentFn(endYmd, "YYYY-MM-DD", true);
  if (!s.isValid() || !e.isValid()) return null;
  if (grain === "week") {
    const prevStart = s.clone().subtract(1, "week");
    const prevEnd = prevStart.clone().add(6, "day");
    const y = prevStart.isoWeekYear();
    const w = prevStart.isoWeek();
    return {
      prevStartYmd: prevStart.format("YYYY-MM-DD"),
      prevEndYmd: prevEnd.format("YYYY-MM-DD"),
      label: `上一周（${y}-W${String(w).padStart(2, "0")}）`,
    };
  }
  if (grain === "quarter") {
    const prevStart = s.clone().subtract(1, "quarter").startOf("quarter");
    const prevEnd = prevStart.clone().endOf("quarter");
    const q = Math.floor(prevStart.month() / 3) + 1;
    return {
      prevStartYmd: prevStart.format("YYYY-MM-DD"),
      prevEndYmd: prevEnd.format("YYYY-MM-DD"),
      label: `上一历季（${prevStart.year()}-Q${q}）`,
    };
  }
  const prevStart = s.clone().subtract(1, "month").startOf("month");
  const prevEnd = prevStart.clone().endOf("month");
  return {
    prevStartYmd: prevStart.format("YYYY-MM-DD"),
    prevEndYmd: prevEnd.format("YYYY-MM-DD"),
    label: `上一自然月（${prevStart.format("YYYY-MM")}）`,
  };
}

function longestStreakInOrderedDays(orderedYmds: string[], done: Set<string>): number {
  let best = 0;
  let cur = 0;
  for (const d of orderedYmds) {
    if (done.has(d)) {
      cur++;
      best = Math.max(best, cur);
    } else {
      cur = 0;
    }
  }
  return best;
}

function pct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${Math.round(n * 100)}%`;
}

/** 打卡：周期内有索引记录的项 → 完成率、最长连续、分层建议 */
export async function buildCheckinReviewAnalysis(
  plugin: RSLattePlugin,
  startYmd: string,
  endYmd: string,
  mergedCheckinItems: CheckinRecordIndexItem[],
): Promise<{ lines: ReviewRecordRichLine[]; note?: string }> {
  const lines: ReviewRecordRichLine[] = [];
  if (!plugin.isPipelineModuleEnabled("checkin")) {
    return { lines: [{ text: "打卡模块未启用。", tone: "muted" }] };
  }

  const defs = (plugin.settings.checkinItems ?? []).filter((x: CheckinItemDef) => x.active);
  if (defs.length === 0) {
    return { lines: [{ text: "没有启用的打卡项，请在设置中配置。", tone: "muted" }] };
  }

  const periodDays = enumerateYmdInclusive(startYmd, endYmd);
  const periodLen = periodDays.length;
  if (periodLen === 0) {
    return { lines: [{ text: "周期天数为 0。", tone: "muted" }] };
  }

  const byId = new Map<string, Set<string>>();
  for (const it of mergedCheckinItems) {
    if (it.isDelete) continue;
    if (!ymdInRange(it.recordDate, startYmd, endYmd)) continue;
    const id = String(it.checkinId ?? "").trim();
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, new Set());
    byId.get(id)!.add(String(it.recordDate).trim());
  }

  type Row = {
    id: string;
    name: string;
    difficulty: CheckinDifficulty;
    doneDays: number;
    completion: number;
    longest: number;
    continuity: number;
  };

  const rows: Row[] = [];
  for (const d of defs) {
    const id = String(d.id ?? "").trim();
    if (!id) continue;
    const dates = byId.get(id);
    if (!dates || dates.size === 0) continue;
    const doneDays = periodDays.filter((x) => dates.has(x)).length;
    const completion = doneDays / periodLen;
    const longest = longestStreakInOrderedDays(periodDays, dates);
    const continuity = longest / periodLen;
    rows.push({
      id,
      name: String(d.name ?? id).trim() || id,
      difficulty: normalizeCheckinDifficulty((d as CheckinItemDef).checkinDifficulty),
      doneDays,
      completion,
      longest,
      continuity,
    });
  }

  if (rows.length === 0) {
    return {
      lines: [{ text: `本周期（${startYmd}～${endYmd}）内没有任何打卡项产生台账记录。`, tone: "muted" }],
      note: "若有打卡但未入索引，请在打卡侧栏执行刷新或检查日记落盘。",
    };
  }

  lines.push({
    text: `本周期共 ${periodLen} 天，有打卡记录的启用项 ${rows.length} 个；下方为各履行率与连续度（按完成率从低到高，最多 8 项）。`,
    tone: "muted",
  });

  rows.sort((a, b) => a.completion - b.completion);
  const cap = rows.slice(0, 8);

  for (const r of cap) {
    const diffLabel = CHECKIN_DIFFICULTY_LABELS[r.difficulty];
    lines.push({
      text: `「${r.name}」${diffLabel !== "一般" ? `（${diffLabel}）` : ""}：完成率 ${pct(r.completion)}（${r.doneDays}/${periodLen} 天有记）；最长连续 ${r.longest} 天（连续度 ${pct(r.continuity)}）。`,
    });

    if (r.difficulty === "light") {
      if (r.completion < 0.6 || r.continuity < 0.35) {
        lines.push({
          text: "  → 轻量习惯更适合拉高连续率：建议固定每日时段打卡，减少「想起来才补」的断层。",
          tone: "encourage",
        });
      }
    } else if (r.difficulty === "high_focus") {
      if (r.completion < 0.5) {
        lines.push({
          text: "  → 高脑力项履行率偏低时，可拆成任务侧栏中的具体行动（降低单次负担），仍以打卡作收尾确认。",
          tone: "warn",
        });
      }
    } else if (r.completion < 0.45) {
      lines.push({
        text: "  → 完成率偏低：可检查目标是否过重，或改为更低频次 + 提醒。",
        tone: "muted",
      });
    }
  }

  if (rows.length > 8) {
    lines.push({ text: `另有 ${rows.length - 8} 项未展开，请到打卡侧栏查看明细。`, tone: "muted" });
  }

  return { lines };
}

function rankFinanceSeverity(s: string): number {
  if (s === "high") return 0;
  if (s === "warning") return 1;
  return 2;
}

function filterActiveFinanceAlerts(items: FinanceAlertSnapshotItem[]): FinanceAlertSnapshotItem[] {
  return items.filter((x) => x.status !== "resolved" && x.status !== "ignored");
}

/** 财务：缺失数据诊断 + 本周期快照告警 + 重要条目摘要 */
export async function buildFinanceReviewAnalysis(
  plugin: RSLattePlugin,
  startYmd: string,
  endYmd: string,
  grain: ReviewSummaryGrain,
): Promise<{ lines: ReviewRecordRichLine[]; note?: string }> {
  const lines: ReviewRecordRichLine[] = [];
  if (!plugin.isPipelineModuleEnabled("finance")) {
    return { lines: [{ text: "财务模块未启用。", tone: "muted" }] };
  }

  const alertIdx = await readFinanceAnalysisAlertIndex(plugin);
  if (alertIdx && alertIdx.status === "missing_data" && alertIdx.missingData.length > 0) {
    lines.push({ text: "【数据基础】以下问题会影响分析可信度，建议优先补齐：", tone: "warn" });
    for (const m of alertIdx.missingData.slice(0, 5)) {
      lines.push({
        text: ` · ${m.title}：${m.detail}${m.hint ? `（${m.hint}）` : ""}`,
        tone: "danger",
      });
    }
    if (alertIdx.missingData.length > 5) {
      lines.push({ text: ` … 另有 ${alertIdx.missingData.length - 5} 条诊断见财务分析索引。`, tone: "muted" });
    }
  }

  if (grain === "quarter") {
    const months = enumerateCalendarMonthKeysBetween(startYmd, endYmd);
    lines.push({
      text: `财务分析为自然月粒度；下列按季内历月 ${months.join("、")} 汇总 finance-analysis 快照。`,
      tone: "muted",
    });
    let totalV = 0;
    let sumInc = 0;
    let sumExp = 0;
    let anyStats = false;
    for (const mk of months) {
      const stats = await readFinanceStatsSnapshot(plugin, "month", mk);
      if (stats) {
        anyStats = true;
        totalV += stats.summary.validCount;
        sumInc += stats.summary.incomeTotal;
        sumExp += stats.summary.expenseTotal;
      }
    }
    if (anyStats) {
      lines.push({
        text: `季内合计流水 ${totalV} 条：收入 ${sumInc.toFixed(2)} · 支出 ${sumExp.toFixed(2)} · 结余 ${(sumInc - sumExp).toFixed(2)}（各月快照相加，与台账逐条汇总可能略有差异）。`,
        tone: "muted",
      });
    }
    const seenAlert = new Set<string>();
    const active: FinanceAlertSnapshotItem[] = [];
    let anyAlertsSnap = false;
    for (const mk of months) {
      const alertsSnap = await readFinanceAlertsSnapshot(plugin, "month", mk);
      if (alertsSnap) anyAlertsSnap = true;
      const rawItems = Array.isArray(alertsSnap?.items) ? alertsSnap!.items : [];
      for (const it of filterActiveFinanceAlerts(rawItems)) {
        const k = `${it.title}\0${String(it.message ?? "").slice(0, 120)}`;
        if (seenAlert.has(k)) continue;
        seenAlert.add(k);
        active.push(it);
      }
    }
    active.sort((a, b) => {
      const rs = rankFinanceSeverity(String(a.severity)) - rankFinanceSeverity(String(b.severity));
      if (rs !== 0) return rs;
      return String(b.detectedAt).localeCompare(String(a.detectedAt));
    });
    if (active.length === 0) {
      lines.push({
        text: anyAlertsSnap
          ? "季内各月规则告警：当前无未关闭条目（或尚未写入告警快照）。"
          : "未读取到季内财务告警快照；请在财务侧栏执行分析刷新（生成 finance-analysis）。",
        tone: "muted",
      });
    } else {
      const hi = active.filter((x) => x.severity === "high").length;
      const wa = active.filter((x) => x.severity === "warning").length;
      const no = active.filter((x) => x.severity === "notice").length;
      lines.push({
        text: `季内未关闭告警（去重后）${active.length} 条（高 ${hi} · 警 ${wa} · 知 ${no}）：`,
        tone: wa > 0 || hi > 0 ? "warn" : "muted",
      });
      for (const it of active.slice(0, 8)) {
        const tag = it.severity === "high" ? "高" : it.severity === "warning" ? "警" : "知";
        lines.push({
          text: `【${tag}】${it.title}：${String(it.message ?? "").trim().slice(0, 200)}${String(it.message ?? "").length > 200 ? "…" : ""}`,
          tone: it.severity === "high" ? "danger" : it.severity === "warning" ? "warn" : "default",
        });
      }
      if (active.length > 8) {
        lines.push({ text: `… 另有 ${active.length - 8} 条，请到财务侧栏「分析/告警」查看。`, tone: "muted" });
      }
    }
    return { lines };
  }

  const finGrain: FinanceAnalysisGrain = grain === "week" ? "week" : "month";
  const periodKey = financePeriodKeyFromReviewStart(startYmd, grain);
  if (!periodKey) {
    return { lines, note: "周期键无效。" };
  }

  const stats = await readFinanceStatsSnapshot(plugin, finGrain, periodKey);
  if (stats) {
    const bal = stats.summary.balance;
    const inc = stats.summary.incomeTotal;
    const exp = stats.summary.expenseTotal;
    let s = `本周期（${periodKey}）流水 ${stats.summary.validCount} 条：收入 ${inc.toFixed(2)} · 支出 ${exp.toFixed(2)} · 结余 ${bal.toFixed(2)}`;
    const bu = stats.summary.budgetUsageRatio;
    if (bu != null && Number.isFinite(bu)) {
      s += `；预算口径占用 ${pct(bu)}`;
    }
    lines.push({ text: `${s}。`, tone: "muted" });
  }

  const alertsSnap = await readFinanceAlertsSnapshot(plugin, finGrain, periodKey);
  const rawItems = Array.isArray(alertsSnap?.items) ? alertsSnap!.items : [];
  const active = filterActiveFinanceAlerts(rawItems);
  active.sort((a, b) => {
    const rs = rankFinanceSeverity(String(a.severity)) - rankFinanceSeverity(String(b.severity));
    if (rs !== 0) return rs;
    return String(b.detectedAt).localeCompare(String(a.detectedAt));
  });

  if (active.length === 0) {
    lines.push({
      text: alertsSnap
        ? "本周期规则告警：当前无未关闭条目（或尚未写入告警快照）。"
        : "未读取到本周期财务告警快照；请在财务侧栏执行分析刷新（生成 finance-analysis）。",
      tone: "muted",
    });
  } else {
    const hi = active.filter((x) => x.severity === "high").length;
    const wa = active.filter((x) => x.severity === "warning").length;
    const no = active.filter((x) => x.severity === "notice").length;
    lines.push({
      text: `本周期未关闭告警 ${active.length} 条（高 ${hi} · 警 ${wa} · 知 ${no}），请及时核对流水、补录缺口或优化支出结构：`,
      tone: wa > 0 || hi > 0 ? "warn" : "muted",
    });
    for (const it of active.slice(0, 8)) {
      const tag = it.severity === "high" ? "高" : it.severity === "warning" ? "警" : "知";
      lines.push({
        text: `【${tag}】${it.title}：${String(it.message ?? "").trim().slice(0, 200)}${String(it.message ?? "").length > 200 ? "…" : ""}`,
        tone: it.severity === "high" ? "danger" : it.severity === "warning" ? "warn" : "default",
      });
    }
    if (active.length > 8) {
      lines.push({ text: `… 另有 ${active.length - 8} 条，请到财务侧栏「分析/告警」查看。`, tone: "muted" });
    }
  }

  return { lines };
}

function rankHealthSev(s: string): number {
  if (s === "high") return 0;
  if (s === "warning") return 1;
  return 2;
}

/** 健康：在台账/月快照句之外，补充达标概况 + 月告警列表（高警标红） */
export async function buildHealthReviewAnalysisExtras(
  plugin: RSLattePlugin,
  endYmd: string,
  grain: ReviewSummaryGrain,
): Promise<{ lines: ReviewRecordRichLine[]; note?: string }> {
  const lines: ReviewRecordRichLine[] = [];
  if (!plugin.isHealthModuleEnabled()) {
    return { lines: [] };
  }
  const monthKey = endYmd.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    return { lines: [] };
  }

  const snap = await readHealthStatsSnapshot(plugin, monthKey);
  if (snap) {
    const d = snap.derived;
    const bits: string[] = [];
    if (d?.waterGoalMetDays != null && d?.waterRecordedDays != null) {
      bits.push(`饮水达标 ${d.waterGoalMetDays}/${d.waterRecordedDays} 个有记日`);
    }
    if (d?.sleepRecordedDays != null && d?.daysInMonth != null) {
      bits.push(`睡眠记录覆盖 ${d.sleepRecordedDays}/${d.daysInMonth} 天`);
    }
    const r7 = snap.rolling?.last7Days;
    if (r7?.dayFullCompletionRate != null && Number.isFinite(r7.dayFullCompletionRate)) {
      bits.push(`近7日日卡全项覆盖（快照内定义）≈ ${pct(r7.dayFullCompletionRate)}`);
    }
    if (bits.length) {
      lines.push({ text: `${monthKey} 达标概况：${bits.join("；")}。`, tone: "muted" });
    }
    if (grain === "week") {
      lines.push({
        text: "周视图仍引用周期末所在月的月快照；与 ISO 周边界不完全一致时，以侧栏统计为准。",
        tone: "muted",
      });
    }
    if (grain === "quarter") {
      lines.push({
        text: "季视图下列为季度末历月快照；季内各月请切 Review「月」查看对应月诊断。",
        tone: "muted",
      });
    }
  }

  const alertSnap = await readHealthAlertsSnapshot(plugin, monthKey);
  const items = Array.isArray(alertSnap?.items) ? alertSnap!.items : [];
  const active = items.filter((x: { status?: string }) => x.status !== "resolved" && x.status !== "ignored");
  const validN = snap?.summary?.validCount ?? 0;
  if (active.length > 0) {
    const tail = validN > 0 ? `（${monthKey} 月快照有效聚合 ${validN}；补录与规律记录有助于改善指标质量）` : "";
    lines.push({
      text: `月内未关闭健康规则告警 ${active.length} 条${tail}：`,
      tone: "warn",
    });
  }

  active.sort((a: any, b: any) => rankHealthSev(String(a.severity)) - rankHealthSev(String(b.severity)));

  for (const it of active.slice(0, 8)) {
    const title = String(it?.title ?? "").trim();
    const msg = String(it?.message ?? "").trim();
    const sev = String(it?.severity ?? "notice");
    const tag = sev === "high" ? "高" : sev === "warning" ? "警" : "知";
    lines.push({
      text: `【${tag}】${title}${msg ? `：${msg.slice(0, 160)}${msg.length > 160 ? "…" : ""}` : ""}`,
      tone: sev === "high" ? "danger" : sev === "warning" ? "warn" : "default",
    });
  }

  if (active.length > 8) {
    lines.push({ text: `… 另有 ${active.length - 8} 条，见健康侧栏统计/诊断。`, tone: "muted" });
  }

  if (!alertSnap && plugin.isHealthModuleEnabled()) {
    return { lines, note: `未读取到 ${monthKey} 的 health-analysis 告警快照；请对健康模块执行刷新。` };
  }

  return { lines };
}

async function withJournalSpaceOverride<T>(plugin: RSLattePlugin, run: () => Promise<T>): Promise<T> {
  const currentSpaceId = plugin.getCurrentSpaceId();
  const spaces = (plugin.settings as any).spaces || {};
  const currentSpace = spaces[currentSpaceId];
  const spaceSnapshot = currentSpace?.settingsSnapshot || {};
  const spaceDiaryPath = spaceSnapshot.diaryPath;
  const spaceDiaryNameFormat = spaceSnapshot.diaryNameFormat;
  const spaceDiaryTemplate = spaceSnapshot.diaryTemplate;

  const originalPathOverride = (plugin.journalSvc as any)._diaryPathOverride;
  const originalFormatOverride = (plugin.journalSvc as any)._diaryNameFormatOverride;
  const originalTemplateOverride = (plugin.journalSvc as any)._diaryTemplateOverride;
  try {
    plugin.journalSvc.setDiaryPathOverride(
      spaceDiaryPath || null,
      spaceDiaryNameFormat || null,
      spaceDiaryTemplate || null,
    );
    return await run();
  } finally {
    plugin.journalSvc.setDiaryPathOverride(originalPathOverride, originalFormatOverride, originalTemplateOverride);
  }
}

async function sumMeaningfulCharsForPanel(
  plugin: RSLattePlugin,
  panelId: string,
  panels: JournalPanel[],
  startYmd: string,
  endYmd: string,
): Promise<number> {
  let sum = 0;
  for (const ymd of enumerateYmdInclusive(startYmd, endYmd)) {
    try {
      const fullTexts = await withJournalSpaceOverride(plugin, () =>
        plugin.journalSvc.readPanelsSectionFullTextForDateKey(ymd, panels),
      );
      const text = fullTexts[panelId] ?? "";
      sum += countJournalMeaningfulChars(text);
    } catch {
      // skip day
    }
  }
  return sum;
}

/** 日记：各面板周期内「有意义字符」总量，与上一周/上一月对比 */
export async function buildJournalReviewAnalysis(
  plugin: RSLattePlugin,
  startYmd: string,
  endYmd: string,
  grain: ReviewSummaryGrain,
): Promise<{ lines: ReviewRecordRichLine[]; note?: string }> {
  const lines: ReviewRecordRichLine[] = [];
  if (plugin.settings.showJournalPanels === false) {
    return { lines: [{ text: "日记面板未启用。", tone: "muted" }] };
  }
  const panels: JournalPanel[] = plugin.settings.journalPanels ?? [];
  if (panels.length === 0) {
    return { lines: [{ text: "未配置日记子窗口（journalPanels）。", tone: "muted" }] };
  }

  const prev = computePrevPeriodYmd(grain, startYmd, endYmd);
  const prevLabel = prev?.label ?? "上一周期";

  lines.push({
    text: `以下为各日记子分类（面板）在周期内的记录量（有意义字符累计），并与 ${prevLabel} 对比，便于感知起伏。`,
    tone: "muted",
  });

  for (const p of panels) {
    const id = String(p.id ?? "").trim();
    if (!id) continue;
    const label = String(p.label ?? p.heading ?? id).trim() || id;
    const curChars = await sumMeaningfulCharsForPanel(plugin, id, panels, startYmd, endYmd);
    let prevChars = 0;
    if (prev) {
      prevChars = await sumMeaningfulCharsForPanel(plugin, id, panels, prev.prevStartYmd, prev.prevEndYmd);
    }
    const delta = curChars - prevChars;
    let cmp = "";
    if (prevChars > 0) {
      const r = delta / prevChars;
      cmp = delta >= 0 ? `，较 ${prevLabel} ↑ ${pct(r)}` : `，较 ${prevLabel} ↓ ${pct(-r)}`;
    } else if (curChars > 0) {
      cmp = `，${prevLabel} 无可比基数（当时为 0）`;
    } else {
      cmp = `，${prevLabel} 同为 0`;
    }
    let tone: ReviewRecordRichLine["tone"] = "default";
    if (delta < 0 && prevChars >= 50) tone = "warn";
    else if (delta > 0 && curChars >= 50) tone = "encourage";

    lines.push({
      text: `「${label}」：本周期有意义字约 ${curChars} 字；${prevLabel} 约 ${prevChars} 字${cmp}。`,
      tone,
    });
  }

  return { lines };
}
