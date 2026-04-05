import { moment, normalizePath } from "obsidian";
import type RSLattePlugin from "../../main";
import type { WorkEvent, WorkEventKind } from "../../types/stats/workEvent";
import type {
  CheckinRecordIndexItem,
  FinanceRecordIndexItem,
  HealthRecordIndexItem,
} from "../../types/recordIndexTypes";
import type { JournalPanel } from "../../types/rslatteTypes";
import type { ReviewTimelineNav } from "./reviewTimelineNavigate";
import { countJournalMeaningfulChars } from "./todayRecordsModel";
import { readHealthStatsSnapshot } from "../../services/health/healthAnalysisIndex";
import { collapseWikiLinksForLineDisplay } from "./renderTextWithContactRefs";
import type { ReviewRecordRichLine } from "./reviewRecordsSummaryAnalysis";
import {
  buildCheckinReviewAnalysis,
  buildFinanceReviewAnalysis,
  buildHealthReviewAnalysisExtras,
  buildJournalReviewAnalysis,
} from "./reviewRecordsSummaryAnalysis";
import {
  buildMonthlyReportVaultPath,
  buildQuarterlyReportVaultPath,
  buildWeeklyReportVaultPath,
  calendarMonthKeyFromStartYmd,
  calendarQuarterKeyFromStartYmd,
  isoWeekKeyFromStartYmd,
} from "../../utils/periodReportPaths";

const momentFn = moment as any;

function ymdInRange(ymd: string, startYmd: string, endYmd: string): boolean {
  const s = String(ymd ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return s >= startYmd && s <= endYmd;
}

async function mergeFinanceIndexItems(rr: NonNullable<RSLattePlugin["recordRSLatte"]>): Promise<FinanceRecordIndexItem[]> {
  const active = await rr.getFinanceSnapshot(false);
  const arch = await rr.getFinanceSnapshot(true);
  const out: FinanceRecordIndexItem[] = [];
  const seen = new Set<string>();
  for (const it of [...(active.items ?? []), ...(arch.items ?? [])]) {
    const x = it as FinanceRecordIndexItem;
    const k = `${x.entryId ?? ""}|${x.recordDate}|${x.categoryId}|${x.type}|${x.amount}|${x.tsMs ?? 0}|${x.isDelete ? 1 : 0}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

async function mergeHealthIndexItems(rr: NonNullable<RSLattePlugin["recordRSLatte"]>): Promise<HealthRecordIndexItem[]> {
  const active = await rr.getHealthSnapshot(false);
  const arch = await rr.getHealthSnapshot(true);
  const out: HealthRecordIndexItem[] = [];
  const seen = new Set<string>();
  for (const it of [...(active.items ?? []), ...(arch.items ?? [])]) {
    const x = it as HealthRecordIndexItem;
    const k = `${x.recordDate}|${x.metricKey}|${x.entryId ?? ""}|${x.valueStr}|${x.tsMs ?? 0}|${x.isDelete ? 1 : 0}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

/** 供记录页分析等复用：打卡索引 active+归档去重合并 */
export async function mergeCheckinIndexItems(rr: NonNullable<RSLattePlugin["recordRSLatte"]>): Promise<CheckinRecordIndexItem[]> {
  const active = await rr.getCheckinSnapshot(false);
  const arch = await rr.getCheckinSnapshot(true);
  const out: CheckinRecordIndexItem[] = [];
  const seen = new Set<string>();
  for (const it of [...(active.items ?? []), ...(arch.items ?? [])]) {
    const x = it as CheckinRecordIndexItem;
    const k = `${x.recordDate}|${x.checkinId}|${x.tsMs ?? 0}|${x.isDelete ? 1 : 0}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

/** 与 Today/记录页一致：按当前空间快照覆盖 journalSvc 的日记路径/模板再执行 */
export async function withJournalSpaceOverride<T>(plugin: RSLattePlugin, run: () => Promise<T>): Promise<T> {
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

function isFinanceCreateKept(e: WorkEvent): boolean {
  if (e.kind !== "finance" || e.action !== "create") return false;
  const ref = e.ref ?? {};
  if (ref.is_delete === true || e.metrics?.is_delete === true) return false;
  const recordDate = String(ref.record_date ?? ref.recordDate ?? "").trim();
  return !!recordDate;
}

function isHealthCreateKept(e: WorkEvent): boolean {
  if (e.kind !== "health" || e.action !== "create") return false;
  const ref = e.ref ?? {};
  if (ref.is_delete === true || e.metrics?.is_delete === true) return false;
  return true;
}

/** 单条时间轴行（结构化展示 + 点击跳转） */
export type ReviewTimelineRow = {
  ymd: string;
  hhmm: string;
  /** 执行类 / 文档类 / 记录类 — 决定模块标签配色 */
  moduleFamily: "execute" | "document" | "record";
  moduleLabel: string;
  actionLabel: string;
  contentText: string;
  nav: ReviewTimelineNav;
};

/** 与 `ReviewView` 周期粒度一致，用于健康月快照与文案提示 */
export type ReviewRecordsGrain = "week" | "month" | "quarter";

export type ReviewPeriodReportSlotModel = {
  kind: "weekly" | "monthly" | "quarterly";
  periodLabel: string;
  vaultPath: string;
  templatePath: string;
  exists: boolean;
  /** 设置中是否配置了对应周报/月报/季报子窗口表（至少一行） */
  panelsConfigured: boolean;
  panelChars: Array<{ id: string; label: string; count: number; heading: string }>;
  totalChars: number;
  anchorYmd: string;
  weekKey: string;
  monthKey: string;
  quarterKey: string;
};

export type ReviewPeriodReportsBundle = {
  weekly?: ReviewPeriodReportSlotModel;
  monthly?: ReviewPeriodReportSlotModel;
  quarterly?: ReviewPeriodReportSlotModel;
};

/**
 * Review「本周/本月记录」页：**仅** 打卡、财务、健康、日记（与「执行/核对」六域分离，避免重复）。
 * 时间轴仅展示 WorkEvent 中 checkin / finance / health。见 `Review侧边栏优化方案.md` §4.3a / §4.6。
 */
export type ReviewRecordsModel = {
  startYmd: string;
  endYmd: string;
  grain: ReviewRecordsGrain;
  workEventEnabled: boolean;
  counts: {
    checkinRecords: number;
    financeRecords: number;
    healthRecords: number;
    /** 周期内至少有一个日记面板有意义字的天数 */
    journalDaysWithContent: number;
  };
  /** 周期内健康台账索引条数对应的去重自然日数（active+归档合并） */
  healthDistinctDays: number;
  /** 记录摘要·健康小节：周期台账句 + health-analysis 月快照摘要（若有） */
  healthSummaryLines: string[];
  healthSummaryNote?: string;
  /** D 区：由 A 区计数生成的短纪要 */
  periodMemoLines: string[];
  timeline: ReviewTimelineRow[];
  timelineNote?: string;
  /** 与 B 区截取逻辑一致，供文案展示 */
  timelineSampleCap: number;
  /** C·打卡：周期内履行率/连续度与分层建议 */
  checkinAnalysisLines: ReviewRecordRichLine[];
  checkinAnalysisNote?: string;
  /** C·财务：缺失诊断 + 本周期 finance-analysis 告警摘要 */
  financeAnalysisLines: ReviewRecordRichLine[];
  financeAnalysisNote?: string;
  /** C·健康：达标概况 + 月告警明细（与 healthSummaryLines 互补） */
  healthAnalysisExtraLines: ReviewRecordRichLine[];
  healthAnalysisExtraNote?: string;
  /** C·日记：各面板有意义字总量 vs 上一对照周期 */
  journalAnalysisLines: ReviewRecordRichLine[];
  journalAnalysisNote?: string;
  /** Review「记录」页顶区：周期周报/月报/季报（见日志管理开关） */
  periodReports?: ReviewPeriodReportsBundle | null;
};

/** 记录页时间轴允许的 WorkEvent kind（不含任务/日程/输出等） */
const RECORD_TAB_EVENT_KINDS = new Set<WorkEventKind>(["checkin", "finance", "health"]);

/** B 区时间轴抽样上限（按 `ts` 倒序截取后与 UI 一致） */
export const REVIEW_RECORDS_TIMELINE_MAX = 48;

const ACTION_ZH: Record<string, string> = {
  create: "创建",
  update: "更新",
  publish: "发布",
  recall: "打回",
  status: "状态",
  delete: "删除",
  archive: "归档",
  cancelled: "取消",
  done: "完成",
  start: "开始",
  recover: "恢复",
  paused: "暂停",
  continued: "继续",
};

const MODULE_LABEL: Partial<Record<WorkEventKind, string>> = {
  checkin: "打卡",
  finance: "财务",
  task: "任务",
  projecttask: "项目任务",
  memo: "提醒",
  schedule: "日程",
  project: "项目",
  milestone: "里程碑",
  output: "输出",
  health: "健康",
  contact: "联系人",
  file: "文件",
  capture: "速记",
  sync: "同步",
};

const MODULE_TAG_MAX_LEN = 28;

function truncModuleTag(s: string): string {
  const t = String(s ?? "").trim();
  if (!t) return t;
  if (t.length <= MODULE_TAG_MAX_LEN) return t;
  return `${t.slice(0, MODULE_TAG_MAX_LEN - 1)}…`;
}

/**
 * 时间轴正文展示：将 `[[目标|显示名]]` 展为显示名，将无管道符的 `[[目标]]` 展为目标文本（去掉 wiki 壳）。
 * 联系人 `[[C_xxx|张三]]` 等在正文区显示为「张三」，模块标签仍用 `resolveTimelineModuleLabel`。
 */
function formatTimelineSummaryForDisplay(raw: string): string {
  return collapseWikiLinksForLineDisplay(raw);
}

/** 模块标签：一律为模块类名（含「联系人」），不用人名；姓名只在正文 `formatTimelineSummaryForDisplay` 中展示 */
function resolveTimelineModuleLabel(e: WorkEvent): string {
  const fallback = MODULE_LABEL[e.kind] ?? e.kind;
  return typeof fallback === "string" ? truncModuleTag(fallback) : String(fallback);
}

function moduleFamilyForKind(kind: WorkEventKind): "execute" | "document" | "record" {
  if (
    kind === "task" ||
    kind === "projecttask" ||
    kind === "schedule" ||
    kind === "memo" ||
    kind === "project" ||
    kind === "milestone" ||
    kind === "contact"
  ) {
    return "execute";
  }
  if (kind === "output" || kind === "file") return "document";
  return "record";
}

function buildNavFromWorkEvent(e: WorkEvent): ReviewTimelineNav {
  const ref = e.ref ?? {};
  const fpRaw = ref.file_path ?? ref.filePath;
  const fp = fpRaw ? normalizePath(String(fpRaw).trim()) : "";
  const lnRaw = ref.line_no ?? ref.lineNo;
  const ln = Number(lnRaw);
  const lineOk = Number.isFinite(ln) && ln >= 0;

  switch (e.kind) {
    case "task":
      if (fp && lineOk) return { type: "task_panel", mode: "task", filePath: fp, lineNo: ln };
      return { type: "sidebar", target: "task" };
    case "projecttask": {
      const folderRaw = String(ref.folder_path ?? ref.folderPath ?? "").trim();
      const folderNorm = folderRaw ? normalizePath(folderRaw) : "";
      const pid = String(ref.project_id ?? ref.projectId ?? "").trim();
      const projectKey = pid || folderNorm;
      const milestonePath = String(ref.milestone ?? "").trim() || undefined;
      if (projectKey && fp && lineOk) {
        return {
          type: "project_panel",
          projectKey,
          milestonePath,
          taskFilePath: fp,
          taskLineNo: ln,
        };
      }
      if (projectKey && milestonePath) {
        return { type: "project_panel", projectKey, milestonePath };
      }
      if (projectKey) {
        return { type: "project_panel", projectKey };
      }
      return { type: "sidebar", target: "project" };
    }
    case "memo":
      if (fp && lineOk) return { type: "task_panel", mode: "memo", filePath: fp, lineNo: ln };
      return { type: "sidebar", target: "task" };
    case "schedule":
      if (fp && lineOk) return { type: "task_panel", mode: "schedule", filePath: fp, lineNo: ln };
      return { type: "sidebar", target: "task" };
    case "health": {
      const entryId = String(ref.entry_id ?? ref.entryId ?? "").trim();
      const recordDate = String(ref.anchor_date ?? ref.record_date ?? ref.recordDate ?? "").trim();
      if (entryId && recordDate) return { type: "health", entryId, recordDate };
      if (recordDate) return { type: "health", recordDate };
      return { type: "sidebar", target: "health" };
    }
    case "finance": {
      const entryId = String(ref.entry_id ?? ref.entryId ?? "").trim();
      const recordDate = String(ref.record_date ?? ref.recordDate ?? "").trim();
      if (entryId && recordDate) return { type: "finance", entryId, recordDate };
      return { type: "sidebar", target: "finance" };
    }
    case "checkin": {
      const recordDate = String(ref.record_date ?? ref.recordDate ?? "").trim();
      const checkinId = String(ref.checkin_id ?? ref.checkinId ?? "").trim();
      if (recordDate && checkinId) return { type: "checkin", recordDate, checkinId };
      return { type: "sidebar", target: "checkin" };
    }
    case "output":
      return { type: "sidebar", target: "output" };
    case "capture":
      return { type: "sidebar", target: "capture" };
    case "file":
      if (fp) return { type: "open_file", filePath: fp };
      return { type: "none" };
    case "project":
    case "milestone":
      return { type: "sidebar", target: "project" };
    case "contact":
      return { type: "sidebar", target: "contacts" };
    default:
      return { type: "none" };
  }
}

function workEventToTimelineRow(e: WorkEvent): ReviewTimelineRow {
  const m = momentFn(e.ts);
  const ymd = m.isValid() ? m.format("YYYY-MM-DD") : "";
  const hhmm = m.isValid() ? m.format("HH:mm") : "";
  const kind = e.kind;
  const moduleLabel = resolveTimelineModuleLabel(e);
  const actionLabel = ACTION_ZH[e.action] ?? e.action;
  const sum = String(e.summary ?? "").trim();
  const contentText = sum
    ? formatTimelineSummaryForDisplay(sum) || `（${kind}）`
    : `（${kind}）`;
  return {
    ymd,
    hhmm,
    moduleFamily: moduleFamilyForKind(kind),
    moduleLabel,
    actionLabel,
    contentText,
    nav: buildNavFromWorkEvent(e),
  };
}

async function countJournalDaysWithContent(plugin: RSLattePlugin, startYmd: string, endYmd: string): Promise<number> {
  if (plugin.settings.showJournalPanels === false) return 0;
  const panels: JournalPanel[] = plugin.settings.journalPanels ?? [];
  if (panels.length === 0) return 0;
  let n = 0;
  for (const ymd of enumerateYmdInclusive(startYmd, endYmd)) {
    try {
      const fullTexts = await withJournalSpaceOverride(plugin, () =>
        plugin.journalSvc.readPanelsSectionFullTextForDateKey(ymd, panels),
      );
      let any = false;
      for (const p of panels) {
        const id = String(p.id ?? "").trim();
        if (!id) continue;
        const text = fullTexts[id] ?? "";
        if (countJournalMeaningfulChars(text) > 0) {
          any = true;
          break;
        }
      }
      if (any) n += 1;
    } catch {
      // 单日失败则跳过
    }
  }
  return n;
}

function buildPeriodMemoLines(
  counts: ReviewRecordsModel["counts"],
  startYmd: string,
  endYmd: string,
  healthDistinctDays: number,
): string[] {
  const { checkinRecords, financeRecords, healthRecords, journalDaysWithContent } = counts;
  const head = `周期 ${startYmd}～${endYmd}`;
  const segs: string[] = [];
  if (checkinRecords > 0) segs.push(`打卡 ${checkinRecords} 条`);
  if (financeRecords > 0) segs.push(`财务 ${financeRecords} 条`);
  if (healthRecords > 0) {
    if (healthDistinctDays > 0) segs.push(`健康 ${healthRecords} 条（${healthDistinctDays} 天有记）`);
    else segs.push(`健康 ${healthRecords} 条`);
  }
  if (journalDaysWithContent > 0) segs.push(`日记有效内容 ${journalDaysWithContent} 天`);
  if (segs.length === 0) {
    return [
      `${head}：打卡/财务/健康/日记在计数上均为空或极少。`,
      "若实际有记，请确认操作日志已开启，或对台账执行刷新。",
    ];
  }
  return [`${head}：${segs.join("，")}。`];
}

async function buildHealthAnalysisSummaryLines(
  plugin: RSLattePlugin,
  grain: ReviewRecordsGrain,
  startYmd: string,
  endYmd: string,
  healthDistinctDays: number,
  healthRecordsCount: number,
): Promise<{ lines: string[]; note?: string }> {
  const lines: string[] = [];
  if (!plugin.isHealthModuleEnabled()) {
    return { lines: ["健康模块未启用。"] };
  }
  lines.push(
    `周期 ${startYmd}～${endYmd}：健康台账 ${healthRecordsCount} 条，分布于 ${healthDistinctDays} 个自然日（索引 active+归档合并，与 A 区计数同源）。`,
  );
  const monthKey = endYmd.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    return { lines };
  }
  const snap = await readHealthStatsSnapshot(plugin, monthKey);
  if (!snap) {
    return {
      lines,
      note: `未读取到 ${monthKey} 的 health-analysis 月快照。请在健康侧栏执行「刷新」或重建健康索引后，在「统计」页查看完整图表。`,
    };
  }
  lines.push(
    `${monthKey} 月快照：有效聚合 ${snap.summary?.validCount ?? 0}；日/周/月卡 ${snap.summary?.byPeriod?.day ?? 0}/${snap.summary?.byPeriod?.week ?? 0}/${snap.summary?.byPeriod?.month ?? 0}。`,
  );
  const d = snap.derived;
  const bits: string[] = [];
  if (d?.sleepAvgHours != null && Number.isFinite(d.sleepAvgHours)) bits.push(`月均睡眠约 ${d.sleepAvgHours.toFixed(1)} h`);
  if (d?.waterAvgCups != null && Number.isFinite(d.waterAvgCups)) bits.push(`月均饮水约 ${d.waterAvgCups.toFixed(1)} 杯`);
  if (d?.avgWeight != null && Number.isFinite(d.avgWeight)) bits.push(`月均体重约 ${d.avgWeight.toFixed(1)} kg`);
  if (bits.length) lines.push(bits.join("；") + "。");
  const as = snap.alertSummary;
  if (as && (as.total > 0 || as.high > 0 || as.warning > 0 || as.notice > 0)) {
    lines.push(`该月告警：高 ${as.high} · 警 ${as.warning} · 知 ${as.notice}（计 ${as.total}）。`);
  }
  if (snap.rolling?.last7Days) {
    const r7 = snap.rolling.last7Days;
    const rbits: string[] = [];
    if (r7.sleepAvgHours != null && Number.isFinite(r7.sleepAvgHours)) {
      rbits.push(`近7日均睡 ${r7.sleepAvgHours.toFixed(1)} h`);
    }
    if (r7.waterAvgCups != null && Number.isFinite(r7.waterAvgCups)) {
      rbits.push(`近7日均饮水 ${r7.waterAvgCups.toFixed(1)} 杯`);
    }
    if (rbits.length) {
      lines.push(`（快照锚日 ${snap.rolling.anchorYmd}）截止近 7 自然日：${rbits.join("，")}。`);
    }
  }
  if (grain === "week") {
    lines.push("提示：月快照按自然月；ISO 周与月边界可能不完全重合。");
  }
  if (grain === "quarter") {
    lines.push("提示：以下为季度末历月健康快照；季内各月可在 Review 切至「月」查看。");
  }
  return { lines };
}

async function buildReviewPeriodReportsBundle(
  plugin: RSLattePlugin,
  startYmd: string,
  opts?: { grain?: ReviewRecordsGrain },
): Promise<ReviewPeriodReportsBundle | null> {
  const wEn = plugin.settings.reviewRecordsWeeklyEnabled === true;
  const mEn = plugin.settings.reviewRecordsMonthlyEnabled === true;
  /** 季视图下始终带季报槽，避免未开「启用季报」时「周期季报」整块空白；开关为 true 时在周/月视图也会预取季报数据（bundle 一并带上）。 */
  const qEn =
    plugin.settings.reviewRecordsQuarterlyEnabled === true || opts?.grain === "quarter";
  if (!wEn && !mEn && !qEn) return null;

  const weeklyPanels: JournalPanel[] = plugin.settings.weeklyJournalPanels ?? [];
  const monthlyPanels: JournalPanel[] = plugin.settings.monthlyJournalPanels ?? [];
  const quarterlyPanels: JournalPanel[] = plugin.settings.quarterlyJournalPanels ?? [];
  const weeklyPanelsConfigured = weeklyPanels.length > 0;
  const monthlyPanelsConfigured = monthlyPanels.length > 0;
  const quarterlyPanelsConfigured = quarterlyPanels.length > 0;

  const weekKey = isoWeekKeyFromStartYmd(startYmd);
  const monthKey = calendarMonthKeyFromStartYmd(startYmd);
  const quarterKey = calendarQuarterKeyFromStartYmd(startYmd);
  const tplW =
    (plugin.settings.weeklyReportTemplatePath ?? "").trim() || "00-System/01-Templates/t_weekly.md";
  const tplM =
    (plugin.settings.monthlyReportTemplatePath ?? "").trim() || "00-System/01-Templates/t_monthly.md";
  const tplQ =
    (plugin.settings.quarterlyReportTemplatePath ?? "").trim() || "00-System/01-Templates/t_quarterly.md";

  return await withJournalSpaceOverride(plugin, async () => {
    const dir = plugin.journalSvc.getResolvedDiaryDir();
    const bundle: ReviewPeriodReportsBundle = {};

    if (wEn && weekKey) {
      const vaultPath = buildWeeklyReportVaultPath(dir, startYmd);
      let exists = false;
      try {
        exists = !!vaultPath && (await plugin.app.vault.adapter.exists(vaultPath));
      } catch {
        exists = false;
      }
      const panelChars: Array<{ id: string; label: string; count: number; heading: string }> = [];
      let totalChars = 0;
      if (exists && weeklyPanelsConfigured && vaultPath) {
        const full = await plugin.journalSvc.readPanelsSectionFullTextForVaultPath(
          vaultPath,
          weeklyPanels,
        );
        for (const p of weeklyPanels) {
          const id = String(p.id ?? "").trim();
          if (!id) continue;
          const n = countJournalMeaningfulChars(full[id] ?? "");
          panelChars.push({
            id,
            label: p.label ?? id,
            count: n,
            heading: String(p.heading ?? "").trim(),
          });
          totalChars += n;
        }
      }
      if (vaultPath) {
        bundle.weekly = {
          kind: "weekly",
          periodLabel: weekKey,
          vaultPath,
          templatePath: tplW,
          exists,
          panelsConfigured: weeklyPanelsConfigured,
          panelChars,
          totalChars,
          anchorYmd: startYmd,
          weekKey,
          monthKey,
          quarterKey: quarterKey || "",
        };
      }
    }

    if (mEn && monthKey) {
      const vaultPath = buildMonthlyReportVaultPath(dir, startYmd);
      let exists = false;
      try {
        exists = !!vaultPath && (await plugin.app.vault.adapter.exists(vaultPath));
      } catch {
        exists = false;
      }
      const panelChars: Array<{ id: string; label: string; count: number; heading: string }> = [];
      let totalChars = 0;
      if (exists && monthlyPanelsConfigured && vaultPath) {
        const full = await plugin.journalSvc.readPanelsSectionFullTextForVaultPath(
          vaultPath,
          monthlyPanels,
        );
        for (const p of monthlyPanels) {
          const id = String(p.id ?? "").trim();
          if (!id) continue;
          const n = countJournalMeaningfulChars(full[id] ?? "");
          panelChars.push({
            id,
            label: p.label ?? id,
            count: n,
            heading: String(p.heading ?? "").trim(),
          });
          totalChars += n;
        }
      }
      if (vaultPath) {
        bundle.monthly = {
          kind: "monthly",
          periodLabel: monthKey,
          vaultPath,
          templatePath: tplM,
          exists,
          panelsConfigured: monthlyPanelsConfigured,
          panelChars,
          totalChars,
          anchorYmd: startYmd,
          weekKey,
          monthKey,
          quarterKey: quarterKey || "",
        };
      }
    }

    if (qEn && quarterKey) {
      const vaultPath = buildQuarterlyReportVaultPath(dir, startYmd);
      let exists = false;
      try {
        exists = !!vaultPath && (await plugin.app.vault.adapter.exists(vaultPath));
      } catch {
        exists = false;
      }
      const panelChars: Array<{ id: string; label: string; count: number; heading: string }> = [];
      let totalChars = 0;
      if (exists && quarterlyPanelsConfigured && vaultPath) {
        const full = await plugin.journalSvc.readPanelsSectionFullTextForVaultPath(
          vaultPath,
          quarterlyPanels,
        );
        for (const p of quarterlyPanels) {
          const id = String(p.id ?? "").trim();
          if (!id) continue;
          const n = countJournalMeaningfulChars(full[id] ?? "");
          panelChars.push({
            id,
            label: p.label ?? id,
            count: n,
            heading: String(p.heading ?? "").trim(),
          });
          totalChars += n;
        }
      }
      if (vaultPath) {
        bundle.quarterly = {
          kind: "quarterly",
          periodLabel: quarterKey,
          vaultPath,
          templatePath: tplQ,
          exists,
          panelsConfigured: quarterlyPanelsConfigured,
          panelChars,
          totalChars,
          anchorYmd: startYmd,
          weekKey: weekKey || "",
          monthKey: monthKey || "",
          quarterKey,
        };
      }
    }

    return bundle;
  });
}

export async function buildReviewRecordsModel(
  plugin: RSLattePlugin,
  startYmd: string,
  endYmd: string,
  grain: ReviewRecordsGrain,
): Promise<ReviewRecordsModel> {
  const workEventEnabled = plugin.workEventSvc?.isEnabled?.() === true;

  const counts = {
    checkinRecords: 0,
    financeRecords: 0,
    healthRecords: 0,
    journalDaysWithContent: 0,
  };

  const timeline: ReviewRecordsModel["timeline"] = [];
  let timelineNote: string | undefined;

  const startM = momentFn(startYmd, "YYYY-MM-DD", true);
  const endM = momentFn(endYmd, "YYYY-MM-DD", true);
  if (!startM.isValid() || !endM.isValid()) {
    return {
      startYmd,
      endYmd,
      grain,
      workEventEnabled,
      counts,
      healthDistinctDays: 0,
      healthSummaryLines: ["周期日期无效。"],
      periodMemoLines: [],
      timeline,
      timelineNote: "周期日期无效",
      timelineSampleCap: REVIEW_RECORDS_TIMELINE_MAX,
      checkinAnalysisLines: [],
      financeAnalysisLines: [],
      healthAnalysisExtraLines: [],
      journalAnalysisLines: [],
      periodReports: null,
    };
  }

  const startDate = startM.clone().startOf("day").toDate();
  const endDate = endM.clone().endOf("day").toDate();

  if (workEventEnabled) {
    try {
      const evs = await plugin.workEventSvc!.readEventsByDateRange(startDate, endDate);
      for (const e of evs) {
        if (e.kind === "checkin" && e.action === "create") {
          const ref = e.ref ?? {};
          if (ref.is_delete === true || e.metrics?.is_delete === true) continue;
          counts.checkinRecords += 1;
        }
        if (isFinanceCreateKept(e)) {
          const rd = String(e.ref?.record_date ?? e.ref?.recordDate ?? "").trim();
          if (ymdInRange(rd, startYmd, endYmd)) counts.financeRecords += 1;
        }
        if (isHealthCreateKept(e)) counts.healthRecords += 1;
      }

      const forTimeline = evs.filter((e) => RECORD_TAB_EVENT_KINDS.has(e.kind));
      forTimeline.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
      const slice = forTimeline.slice(0, REVIEW_RECORDS_TIMELINE_MAX);
      for (const e of slice) {
        const row = workEventToTimelineRow(e);
        if (!row.ymd) continue;
        timeline.push(row);
      }
      timeline.sort((a, b) => {
        const c = b.ymd.localeCompare(a.ymd);
        if (c !== 0) return c;
        return b.hhmm.localeCompare(a.hhmm);
      });
    } catch (e) {
      console.warn("[RSLatte] buildReviewRecordsModel work events failed:", e);
      timelineNote = "加载操作日志失败";
    }
  } else {
    timelineNote =
      "未开启操作日志时，下方时间轴无数据；打卡/财务/健康条数来自台账索引（与「今日记录」索引口径一致）。任务与日程请见「执行」页。";
  }

  if (!workEventEnabled || counts.checkinRecords === 0) {
    if (plugin.recordRSLatte && plugin.isPipelineModuleEnabled("checkin")) {
      try {
        const items = await mergeCheckinIndexItems(plugin.recordRSLatte);
        let n = 0;
        for (const it of items) {
          if (it.isDelete) continue;
          if (ymdInRange(it.recordDate, startYmd, endYmd)) n += 1;
        }
        if (!workEventEnabled) counts.checkinRecords = n;
        else if (counts.checkinRecords === 0) counts.checkinRecords = n;
      } catch {
        // ignore
      }
    }
  }

  if (!workEventEnabled || counts.financeRecords === 0) {
    if (plugin.recordRSLatte && plugin.isPipelineModuleEnabled("finance")) {
      try {
        const items = await mergeFinanceIndexItems(plugin.recordRSLatte);
        let n = 0;
        for (const it of items) {
          if (it.isDelete) continue;
          if (ymdInRange(it.recordDate, startYmd, endYmd)) n += 1;
        }
        if (!workEventEnabled) counts.financeRecords = n;
        else if (counts.financeRecords === 0) counts.financeRecords = n;
      } catch {
        // ignore
      }
    }
  }

  let healthDistinctDays = 0;
  if (plugin.recordRSLatte && plugin.isHealthModuleEnabled()) {
    try {
      const items = await mergeHealthIndexItems(plugin.recordRSLatte);
      const daySet = new Set<string>();
      let indexN = 0;
      for (const it of items) {
        if (it.isDelete) continue;
        if (!ymdInRange(it.recordDate, startYmd, endYmd)) continue;
        indexN += 1;
        daySet.add(String(it.recordDate ?? "").trim());
      }
      healthDistinctDays = daySet.size;
      if (!workEventEnabled) counts.healthRecords = indexN;
      else if (counts.healthRecords === 0) counts.healthRecords = indexN;
    } catch {
      // ignore
    }
  }

  try {
    counts.journalDaysWithContent = await countJournalDaysWithContent(plugin, startYmd, endYmd);
  } catch (e) {
    console.warn("[RSLatte] buildReviewRecordsModel journal sweep failed:", e);
  }

  const healthSummary = await buildHealthAnalysisSummaryLines(
    plugin,
    grain,
    startYmd,
    endYmd,
    healthDistinctDays,
    counts.healthRecords,
  );
  const periodMemoLines = buildPeriodMemoLines(counts, startYmd, endYmd, healthDistinctDays);

  let mergedCheckinForAnalysis: CheckinRecordIndexItem[] = [];
  if (plugin.recordRSLatte && plugin.isPipelineModuleEnabled("checkin")) {
    try {
      mergedCheckinForAnalysis = await mergeCheckinIndexItems(plugin.recordRSLatte);
    } catch {
      // ignore
    }
  }

  const [checkinAn, financeAn, healthEx, journalAn, periodReports] = await Promise.all([
    buildCheckinReviewAnalysis(plugin, startYmd, endYmd, mergedCheckinForAnalysis),
    buildFinanceReviewAnalysis(plugin, startYmd, endYmd, grain),
    buildHealthReviewAnalysisExtras(plugin, endYmd, grain),
    buildJournalReviewAnalysis(plugin, startYmd, endYmd, grain),
    buildReviewPeriodReportsBundle(plugin, startYmd, { grain }),
  ]);

  return {
    startYmd,
    endYmd,
    grain,
    workEventEnabled,
    counts,
    healthDistinctDays,
    healthSummaryLines: healthSummary.lines,
    healthSummaryNote: healthSummary.note,
    periodMemoLines,
    timeline,
    timelineNote,
    timelineSampleCap: REVIEW_RECORDS_TIMELINE_MAX,
    checkinAnalysisLines: checkinAn.lines,
    checkinAnalysisNote: checkinAn.note,
    financeAnalysisLines: financeAn.lines,
    financeAnalysisNote: financeAn.note,
    healthAnalysisExtraLines: healthEx.lines,
    healthAnalysisExtraNote: healthEx.note,
    journalAnalysisLines: journalAn.lines,
    journalAnalysisNote: journalAn.note,
    periodReports,
  };
}
