import type RSLattePlugin from "../../main";
import type {
  ReviewExecuteModel,
  ReviewExecuteOverviewStrip,
  ReviewExecuteTaskHourCategorySlice,
  ReviewExecuteTaskHourEntry,
  ReviewExecuteTaskHoursDetail,
  ReviewExecuteTaskModuleBlock,
  ReviewExecuteMemoModuleBlock,
  ReviewExecuteScheduleModuleBlock,
  ReviewExecuteProjectModuleBlock,
  ReviewExecuteOutputModuleBlock,
  ReviewExecuteContactModuleBlock,
} from "./reviewExecuteModel";
import type { ReviewExecuteScheduleVizModel } from "./reviewExecuteScheduleViz";
import { GRID_END_MIN, GRID_START_MIN } from "./reviewExecuteScheduleViz";
import { navigateReviewTimeline } from "./reviewTimelineNavigate";

function formatMinutes(m: number): string {
  if (m >= 60) return `${(m / 60).toFixed(1)} 小时`;
  return `${Math.round(m)} 分钟`;
}

/** C 区日程分类行：紧凑小时，如 4h、1.5h（与 B 区 `duration_min`/起止解析一致） */
function formatCompactScheduleHours(mins: number): string {
  const m = Math.max(0, Math.floor(Number(mins) || 0));
  if (m === 0) return "0h";
  const h = m / 60;
  if (Number.isInteger(h)) return `${h}h`;
  return `${h.toFixed(1)}h`;
}

/** 月历热力：马卡龙色系，低负荷偏浅粉蓝、高负荷偏蜜桃/柠檬黄（柔和 pastel） */
function macaronHeatRgb(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  const stops: [number, number, number][] = [
    [248, 246, 252],
    [218, 235, 248],
    [198, 226, 216],
    [237, 214, 234],
    [255, 218, 200],
    [255, 236, 179],
  ];
  const n = stops.length - 1;
  const p = x * n;
  const i = Math.min(Math.floor(p), n - 1);
  const f = p - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

function rgbToCss([r, g, b]: [number, number, number]): string {
  return `rgb(${r},${g},${b})`;
}

const REVIEW_SCH_BAR_X_TICKS = [0, 5, 10, 15, 20, 25, 30] as const;
const REVIEW_SCH_GRID_TWO_H_MIN = 120;

/** 在柱槽高度内画横向虚线：每 2 小时一条；仅当本周期单日最长 ≥2h 时绘制，且只画在 maxBar 范围内的刻度（不抬高纵轴留白） */
function appendScheduleBarHourGrid(gridHost: HTMLElement, maxBarMinutes: number): void {
  const cap = Math.max(1, maxBarMinutes);
  if (cap < REVIEW_SCH_GRID_TWO_H_MIN) return;
  for (let m = REVIEW_SCH_GRID_TWO_H_MIN; m < cap; m += REVIEW_SCH_GRID_TWO_H_MIN) {
    const line =
      typeof (gridHost as any).createDiv === "function"
        ? (gridHost as any).createDiv({ cls: "rslatte-review-sch-bar-hline" })
        : (() => {
            const el = document.createElement("div");
            el.className = "rslatte-review-sch-bar-hline";
            gridHost.appendChild(el);
            return el;
          })();
    line.style.bottom = `${(m / cap) * 100}%`;
  }
}

/** 根据背景亮度选深/浅字 */
function heatTextColorForRgb(r: number, g: number, b: number): string {
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  return lum > 150 ? "var(--text-normal)" : "rgba(255,255,255,0.95)";
}

function renderScheduleWorkloadLegacy(blockW: HTMLElement, model: ReviewExecuteModel): void {
  const w = model.workload as any;
  const blocks = Number(w.scheduleBlocksInPeriod ?? 0);
  const mins = Number(w.scheduleMinutesTotal ?? 0);
  blockW.createDiv({
    cls: "rslatte-review-exec-mod-line",
    text: `（历史快照）周期内日程块 ${blocks} 个，时长合计约 ${formatMinutes(mins)}（旧版口径：锚点在周期内的全部块）。`,
  });
}

function renderScheduleCharts(blockW: HTMLElement, sv: ReviewExecuteScheduleVizModel): void {
  const sum = blockW.createDiv({
    cls: "rslatte-review-exec-mod-line",
    text: `本周期已完成日程 ${sv.completedCount} 条，时长合计约 ${formatMinutes(sv.completedMinutesTotal)}。`,
  });
  sum.title =
    "仅统计完成日落在本周期且索引可算时长的条目；无起止/时长 meta 的条目不进入下方栅格与堆叠柱。";
  sum.style.marginBottom = "8px";

  // 月视图：分类色卡对应「按天堆叠」柱配色，与月历热力（日总时长色阶）无关，故不展示顶栏图例
  if (sv.categoryLegend.length > 0 && sv.grain !== "month") {
    const leg = blockW.createDiv({ cls: "rslatte-review-sch-legend" });
    for (const c of sv.categoryLegend) {
      const chip = leg.createSpan({ cls: `rslatte-review-sch-legend-chip rslatte-review-sch-cat--${c.slot}`, text: c.label });
      chip.title = c.id;
    }
  }

  if (sv.grain === "week" && sv.weekDayYmds.length > 0) {
    const title = blockW.createDiv({ cls: "rslatte-review-sch-subtitle rslatte-muted", text: "时间栅格（周 · 6:00–22:00，有起止时刻的已完成日程）" });
    title.style.marginTop = "10px";
    const wrap = blockW.createDiv({ cls: "rslatte-review-sch-week-wrap" });
    const head = wrap.createDiv({ cls: "rslatte-review-sch-week-head" });
    head.createDiv({ cls: "rslatte-review-sch-week-corner" });
    for (let i = 0; i < sv.weekDayYmds.length; i++) {
      head.createDiv({ cls: "rslatte-review-sch-week-hcell", text: sv.weekDayLabels[i] ?? sv.weekDayYmds[i] });
    }
    const body = wrap.createDiv({ cls: "rslatte-review-sch-week-body" });
    const tcol = body.createDiv({ cls: "rslatte-review-sch-week-timecol" });
    for (let h = GRID_START_MIN / 60; h < GRID_END_MIN / 60; h++) {
      tcol.createDiv({ cls: "rslatte-review-sch-week-tick", text: `${h}:00` });
    }
    const span = GRID_END_MIN - GRID_START_MIN;
    for (const ymd of sv.weekDayYmds) {
      const col = body.createDiv({ cls: "rslatte-review-sch-week-col" });
      col.dataset.ymd = ymd;
      for (const b of sv.weekGridBlocks) {
        if (b.columnYmd !== ymd) continue;
        const topPct = ((b.startMinOfDay - GRID_START_MIN) / span) * 100;
        const hPct = ((b.endMinOfDay - b.startMinOfDay) / span) * 100;
        const slot = sv.categoryLegend.find((x) => x.id === b.categoryId)?.slot ?? 0;
        const el = col.createDiv({ cls: `rslatte-review-sch-week-block rslatte-review-sch-cat--${slot}` });
        el.title = `${b.title} · ${b.categoryLabel}`;
        el.style.top = `${Math.max(0, topPct)}%`;
        el.style.height = `${Math.max(0.8, hPct)}%`;
      }
    }
  }

  if (sv.grain === "month" && sv.monthHeatCells.length > 0) {
    const title = blockW.createDiv({
      cls: "rslatte-review-sch-subtitle rslatte-muted",
      text: "日历热力（月 · 按完成日汇总时长，马卡龙色阶：低负荷偏浅、高负荷偏蜜桃/浅黄）",
    });
    title.style.marginTop = "12px";

    const padded: (typeof sv.monthHeatCells)[number][] = [...sv.monthHeatCells];
    while (padded.length % 7 !== 0) padded.push(null);
    const numWeekRows = Math.ceil(padded.length / 7);
    const maxM = Math.max(1, ...sv.monthHeatCells.filter(Boolean).map((c) => c!.totalMinutes));

    const outer = blockW.createDiv({ cls: "rslatte-review-sch-month-outer" });
    const core = outer.createDiv({ cls: "rslatte-review-sch-month-core" });
    const yAxis = core.createDiv({ cls: "rslatte-review-sch-month-yaxis" });
    yAxis.createDiv({ cls: "rslatte-review-sch-month-yaxis-spacer" });
    const yWeeks = yAxis.createDiv({ cls: "rslatte-review-sch-month-yaxis-weeks" });
    for (let w = 0; w < numWeekRows; w++) {
      yWeeks.createDiv({ cls: "rslatte-review-sch-month-yaxis-wk", text: `W${w + 1}` });
    }

    const center = core.createDiv({ cls: "rslatte-review-sch-month-center" });
    const grid = center.createDiv({ cls: "rslatte-review-sch-month-grid" });
    grid.style.setProperty("--sch-month-rows", String(numWeekRows));
    for (const cell of padded) {
      if (!cell) {
        grid.createDiv({ cls: "rslatte-review-sch-month-cell rslatte-review-sch-month-cell--pad" });
        continue;
      }
      const c = grid.createDiv({ cls: "rslatte-review-sch-month-cell rslatte-review-sch-month-cell--data" });
      const t = cell.totalMinutes <= 0 ? 0 : cell.totalMinutes / maxM;
      const rgb = macaronHeatRgb(t);
      c.style.background = rgbToCss(rgb);
      const dayNum = cell.ymd.slice(8, 10).replace(/^0/, "") || cell.ymd;
      const tc = heatTextColorForRgb(rgb[0], rgb[1], rgb[2]);
      const numEl = c.createSpan({ cls: "rslatte-review-sch-month-daynum", text: dayNum });
      numEl.style.color = tc;
      if (cell.count > 0) {
        const meta = c.createSpan({ cls: "rslatte-review-sch-month-meta", text: `${cell.count}条` });
        meta.style.color = tc;
        meta.style.opacity = "0.88";
      }
      c.title = `${cell.ymd} · ${cell.count} 条 · ${formatMinutes(cell.totalMinutes)}`;
    }

    const dowFoot = center.createDiv({ cls: "rslatte-review-sch-month-dow-foot" });
    const dowLabels = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
    for (const d of dowLabels) {
      dowFoot.createDiv({ cls: "rslatte-review-sch-month-dow-foot-cell", text: d });
    }

    const legend = outer.createDiv({ cls: "rslatte-review-sch-month-legend" });
    legend.createDiv({ cls: "rslatte-review-sch-month-legend-title", text: "日负荷" });
    const legRow = legend.createDiv({ cls: "rslatte-review-sch-month-legend-row" });
    const legTicks = legRow.createDiv({ cls: "rslatte-review-sch-month-legend-ticks" });
    legTicks.createSpan({ text: "高" });
    legTicks.createSpan({ text: "低" });
    legRow.createDiv({ cls: "rslatte-review-sch-month-legend-bar" });
    const legNote = legend.createDiv({ cls: "rslatte-review-sch-month-legend-note rslatte-muted" });
    legNote.setText(`本图最长柱 ${formatMinutes(maxM)}`);
  }

  const isLongRangeBars = sv.grain === "month" || sv.grain === "quarter";
  const barTitle = blockW.createDiv({
    cls: "rslatte-review-sch-subtitle rslatte-muted",
    text: isLongRangeBars
      ? "按天堆叠（完成日 · 按日程分类堆叠时长；长周期柱宽约 4px，日期见悬停）"
      : "按天堆叠（完成日 · 按日程分类堆叠时长）",
  });
  barTitle.style.marginTop = "12px";
  const maxBar = Math.max(1, ...sv.dayStacks.map((d) => d.totalMinutes));
  const bars = blockW.createDiv({
    cls: `rslatte-review-sch-bars${isLongRangeBars ? " rslatte-review-sch-bars--month" : ""}`,
  });
  if (sv.dayStacks.every((d) => d.totalMinutes <= 0 && d.count <= 0)) {
    bars.createDiv({ cls: "rslatte-review-records-empty rslatte-muted", text: "本周期无已完成日程或无可汇总时长。" });
  } else {
    const xTickSet = new Set<number>(REVIEW_SCH_BAR_X_TICKS);
    sv.dayStacks.forEach((day, dayIdx) => {
      const col = bars.createDiv({ cls: "rslatte-review-sch-bar-col" });
      const dayTip = `${day.ymd} · ${day.count} 条 · ${formatMinutes(day.totalMinutes)}`;
      const stackOuter = col.createDiv({ cls: "rslatte-review-sch-bar-stack-outer" });
      stackOuter.title = dayTip;
      const grid = stackOuter.createDiv({ cls: "rslatte-review-sch-bar-grid" });
      appendScheduleBarHourGrid(grid, maxBar);
      const hScale = day.totalMinutes > 0 ? (day.totalMinutes / maxBar) * 100 : 0;
      const stack = stackOuter.createDiv({ cls: "rslatte-review-sch-bar-stack" });
      stack.title = dayTip;
      stack.style.height = `${Math.max(hScale, day.count > 0 ? 8 : 0)}%`;
      if (day.byCategory.length === 0 && day.count > 0) {
        const unk = stack.createDiv({ cls: "rslatte-review-sch-bar-seg rslatte-review-sch-cat--0" });
        unk.style.flexGrow = String(Math.max(1, day.totalMinutes || 1));
        unk.title = `${day.ymd} · ${day.count} 条 · 无分类或未计时长 · ${formatMinutes(day.totalMinutes)}`;
      } else {
        for (const seg of day.byCategory) {
          const slot = sv.categoryLegend.find((x) => x.id === seg.categoryId)?.slot ?? 0;
          const segEl = stack.createDiv({ cls: `rslatte-review-sch-bar-seg rslatte-review-sch-cat--${slot}` });
          segEl.style.flexGrow = String(Math.max(1, seg.minutes));
          segEl.title = `${day.ymd} · ${seg.categoryLabel} · ${formatMinutes(seg.minutes)}`;
        }
      }
      col.createDiv({ cls: "rslatte-review-sch-bar-label", text: day.barLabel });
      const xTick = col.createDiv({ cls: "rslatte-review-sch-bar-x-tick rslatte-muted" });
      xTick.setText(xTickSet.has(dayIdx) ? String(dayIdx) : "");
      col.title = dayTip;
    });
  }
}

function bindTaskHoursSegmentTooltip(el: HTMLElement, text: string): void {
  try {
    const fn = (el as any).setTooltip as ((t: string) => void) | undefined;
    if (typeof fn === "function") fn.call(el, text);
    else el.title = text;
  } catch {
    el.title = text;
  }
}

/** C 分模块锚点 id（A 总览点击滚动定位） */
const REVIEW_EXEC_MOD_IDS = {
  task: "rslatte-review-exec-mod-task",
  memo: "rslatte-review-exec-mod-memo",
  schedule: "rslatte-review-exec-mod-schedule",
  project: "rslatte-review-exec-mod-project",
  output: "rslatte-review-exec-mod-output",
  contact: "rslatte-review-exec-mod-contact",
} as const;

/** B 时间分析 · 工作量·日程耗时（A 总览「日程」行点击滚动目标） */
const REVIEW_EXEC_B_SCHEDULE_WORKLOAD = "rslatte-review-exec-b-schedule-workload";

function ensureOverviewStrip(model: ReviewExecuteModel): ReviewExecuteOverviewStrip {
  const o = model.overview;
  const defaults: ReviewExecuteOverviewStrip = {
    taskDone: o.tasksDone,
    taskProgressWe: 0,
    taskNew: 0,
    memoDone: o.memosDone,
    memoNew: 0,
    scheduleDone: o.schedulesDone ?? 0,
    scheduleNew: 0,
    projectDone: o.projectsCompletedInPeriod ?? 0,
    projectProgress: o.projectsPushed,
    projectNewWe: 0,
    outputDone: o.outputsDone,
    outputPublished: o.outputsPublished,
    outputProgressWe: 0,
    outputNew: o.outputsNew,
    contactInteract: o.contactEvents,
    contactNew: 0,
  };
  if (!model.overviewStrip) return defaults;
  return { ...defaults, ...model.overviewStrip };
}

function appendOverviewStripMetric(row: HTMLElement, sym: string, symTip: string, num: number): void {
  const part = row.createSpan({ cls: "rslatte-review-exec-strip-part" });
  const s = part.createSpan({ cls: "rslatte-review-exec-strip-sym", text: sym });
  bindTaskHoursSegmentTooltip(s, symTip);
  part.createSpan({ cls: "rslatte-review-exec-strip-num", text: String(num) });
}

function renderOverviewStripRow(
  wrap: HTMLElement,
  label: string,
  anchorId: string,
  metrics: { sym: string; tip: string; n: number }[],
  rowTitle?: string,
): void {
  const row = wrap.createDiv({ cls: "rslatte-review-exec-strip-row" });
  row.title = rowTitle ?? "点击查看下方「C 分模块数据摘要」对应模块";
  row.createSpan({ cls: "rslatte-review-exec-strip-label", text: label });
  if (metrics.length === 0) return;
  appendOverviewStripMetric(row, metrics[0].sym, metrics[0].tip, metrics[0].n);
  for (let i = 1; i < metrics.length; i++) {
    row.createSpan({ cls: "rslatte-review-exec-strip-sep", text: "/" });
    appendOverviewStripMetric(row, metrics[i].sym, metrics[i].tip, metrics[i].n);
  }
  row.addEventListener("click", () => {
    row.ownerDocument.getElementById(anchorId)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function renderReviewExecuteOverviewStrip(blockA: HTMLElement, model: ReviewExecuteModel): void {
  const s = ensureOverviewStrip(model);
  const wrap = blockA.createDiv({ cls: "rslatte-review-exec-overview-strip" });
  renderOverviewStripRow(wrap, "任务", REVIEW_EXEC_MOD_IDS.task, [
    { sym: "✅", tip: "完成", n: s.taskDone },
    { sym: "⏩", tip: "进度更新", n: s.taskProgressWe },
    { sym: "➕", tip: "新增", n: s.taskNew },
  ]);
  renderOverviewStripRow(wrap, "提醒", REVIEW_EXEC_MOD_IDS.memo, [
    { sym: "✅", tip: "完成", n: s.memoDone },
    { sym: "➕", tip: "新增", n: s.memoNew },
  ]);
  renderOverviewStripRow(
    wrap,
    "日程",
    REVIEW_EXEC_B_SCHEDULE_WORKLOAD,
    [
      { sym: "✅", tip: "完成", n: s.scheduleDone },
      { sym: "➕", tip: "新增", n: s.scheduleNew },
    ],
    "点击查看「B 时间分析 · 工作量·日程耗时」",
  );
  renderOverviewStripRow(wrap, "项目", REVIEW_EXEC_MOD_IDS.project, [
    { sym: "✅", tip: "完成", n: s.projectDone },
    { sym: "⏩", tip: "进度更新", n: s.projectProgress },
    { sym: "➕", tip: "新增", n: s.projectNewWe },
  ]);
  renderOverviewStripRow(wrap, "输出", REVIEW_EXEC_MOD_IDS.output, [
    { sym: "✅", tip: "完成", n: s.outputDone },
    { sym: "📤", tip: "发布", n: s.outputPublished },
    { sym: "⏩", tip: "进度更新", n: s.outputProgressWe },
    { sym: "➕", tip: "新增", n: s.outputNew },
  ]);
  renderOverviewStripRow(wrap, "联系人", REVIEW_EXEC_MOD_IDS.contact, [
    { sym: "⏩", tip: "互动更新", n: s.contactInteract },
    { sym: "➕", tip: "新增联系人", n: s.contactNew },
  ]);
}

/** 任务工时：全宽色条 + 默认/悬停分类 Top3 */
function renderReviewTaskHoursDetail(
  blockEh: HTMLElement,
  detail: ReviewExecuteTaskHoursDetail,
  plugin: RSLattePlugin,
): void {
  const summary = blockEh.createDiv({ cls: "rslatte-review-exec-mod-line rslatte-muted" });
  summary.setText(
    `合计约 ${detail.totalHours.toFixed(1)} h（色条按业务分类占比；悬停色块见分类汇总，下方 Top3 随分类切换；点击条目可跳转）。`,
  );

  const wrap = blockEh.createDiv({ cls: "rslatte-review-task-hrs" });
  const bar = wrap.createDiv({ cls: "rslatte-review-task-hrs-bar" });
  const listHost = wrap.createDiv({ cls: "rslatte-review-task-hrs-top3" });

  const renderTop3 = (subtitle: string, entries: ReviewExecuteTaskHourEntry[]) => {
    listHost.empty();
    listHost.createDiv({ cls: "rslatte-review-task-hrs-top3-sub rslatte-muted", text: subtitle });
    const list = listHost.createDiv({ cls: "rslatte-review-task-hrs-top3-list" });
    if (entries.length === 0) {
      list.createDiv({ cls: "rslatte-review-records-empty rslatte-muted", text: "暂无条目" });
      return;
    }
    for (const e of entries) {
      const row = list.createDiv({
        cls: "rslatte-review-task-hrs-top3-line rslatte-review-task-hrs-top3-line--clickable",
      });
      row.setText(e.label);
      row.title = "点击定位到任务/项目任务";
      row.onclick = () => void navigateReviewTimeline(plugin, e.nav);
    }
  };

  renderTop3("工时 Top3（全部）", detail.globalTop3);

  const tipLines = (s: ReviewExecuteTaskHourCategorySlice) =>
    `${s.label}\n总工时 ${s.totalHours.toFixed(1)} h\n共 ${s.taskCount} 条`;

  for (const slice of detail.categories) {
    const seg = bar.createDiv({
      cls: `rslatte-review-task-hrs-seg rslatte-review-task-hrs-seg--${slice.colorSlot}`,
    });
    seg.style.flexGrow = String(Math.max(0.001, slice.totalHours));
    seg.style.flexShrink = "0";
    seg.style.flexBasis = "0";
    bindTaskHoursSegmentTooltip(seg, tipLines(slice));
    seg.addEventListener("mouseenter", () => {
      renderTop3(`「${slice.label}」工时 Top3`, slice.top3);
    });
  }

  wrap.addEventListener("mouseleave", () => {
    renderTop3("工时 Top3（全部）", detail.globalTop3);
  });
}

function renderTaskModuleSection(parent: HTMLElement, model: ReviewExecuteModel, anchorId: string): void {
  const sec = parent.createDiv({ cls: "rslatte-review-exec-mod-section" });
  sec.id = anchorId;
  sec.createDiv({ cls: "rslatte-review-exec-mod-section-title", text: "任务：" });
  const b = model.taskModuleBlock as ReviewExecuteTaskModuleBlock | undefined;
  if (b) {
    const wrap = sec.createDiv({ cls: "rslatte-review-exec-mod-task-body" });
    const line1 = wrap.createDiv({ cls: "rslatte-review-exec-mod-task-line" });
    line1.appendText("· 周期内完成 ");
    line1.createSpan({ cls: "rslatte-review-exec-mod-num", text: String(b.completedInPeriod) });
    line1.appendText(" · 新建 ");
    line1.createSpan({ cls: "rslatte-review-exec-mod-num", text: String(b.created) });
    line1.appendText(" · 完成日晚于计划结束 ");
    line1.createSpan({ cls: "rslatte-review-exec-mod-num", text: String(b.doneAfterPlannedEnd) });
    line1.appendText(" 条");
    const line2 = wrap.createDiv({ cls: "rslatte-review-exec-mod-task-line" });
    line2.appendText("· 工时评估日记任务约 ");
    line2.createSpan({ cls: "rslatte-review-exec-mod-num", text: b.diaryEstimateHours.toFixed(1) });
    line2.appendText("h + 项目任务约 ");
    line2.createSpan({ cls: "rslatte-review-exec-mod-num", text: b.projectEstimateHours.toFixed(1) });
    line2.appendText("h（完成日落在本周期）");
  } else {
    sec.createDiv({ cls: "rslatte-review-exec-mod-line", text: model.modules.task });
  }
}

function renderMemoModuleSection(parent: HTMLElement, model: ReviewExecuteModel, anchorId: string): HTMLElement {
  const sec = parent.createDiv({ cls: "rslatte-review-exec-mod-section" });
  sec.id = anchorId;
  sec.createDiv({ cls: "rslatte-review-exec-mod-section-title", text: "提醒：" });
  const m = model.memoModuleBlock as ReviewExecuteMemoModuleBlock | undefined;
  if (m) {
    const wrap = sec.createDiv({ cls: "rslatte-review-exec-mod-task-body" });
    const line1 = wrap.createDiv({ cls: "rslatte-review-exec-mod-task-line" });
    line1.appendText("· 周期内完成 ");
    line1.createSpan({ cls: "rslatte-review-exec-mod-num", text: String(m.completedInPeriod) });
    line1.appendText(" · 新建 ");
    line1.createSpan({ cls: "rslatte-review-exec-mod-num", text: String(m.created) });
    line1.appendText(" · 完成日晚于提醒日期 ");
    line1.createSpan({ cls: "rslatte-review-exec-mod-num", text: String(m.doneAfterMemoDate) });
    const line2 = wrap.createDiv({ cls: "rslatte-review-exec-mod-task-line" });
    line2.appendText("· 生日");
    line2.createSpan({ cls: "rslatte-review-exec-mod-num", text: String(m.birthdayCount) });
    line2.appendText(" · 纪念日");
    line2.createSpan({ cls: "rslatte-review-exec-mod-num", text: String(m.anniversaryCount) });
    line2.appendText(" · 到期提醒");
    line2.createSpan({ cls: "rslatte-review-exec-mod-num", text: String(m.dueReminderCount) });
    line2.appendText(" · 一般提醒");
    line2.createSpan({ cls: "rslatte-review-exec-mod-num", text: String(m.generalReminderCount) });
    const line3 = wrap.createDiv({ cls: "rslatte-review-exec-mod-task-line" });
    line3.appendText("· 转任务");
    line3.createSpan({ cls: "rslatte-review-exec-mod-num", text: String(m.arrangedToTaskCount) });
    line3.appendText(" · 转日程");
    line3.createSpan({ cls: "rslatte-review-exec-mod-num", text: String(m.arrangedToScheduleCount) });
  } else {
    sec.createDiv({ cls: "rslatte-review-exec-mod-line", text: model.modules.memo });
  }
  return sec;
}

function renderScheduleModuleSection(parent: HTMLElement, model: ReviewExecuteModel, anchorId: string): HTMLElement {
  const sec = parent.createDiv({ cls: "rslatte-review-exec-mod-section" });
  sec.id = anchorId;
  sec.createDiv({ cls: "rslatte-review-exec-mod-section-title", text: "日程：" });
  const s = model.scheduleModuleBlock as ReviewExecuteScheduleModuleBlock | undefined;
  if (s) {
    const wrap = sec.createDiv({ cls: "rslatte-review-exec-mod-task-body" });
    const line1 = wrap.createDiv({ cls: "rslatte-review-exec-mod-task-line" });
    line1.appendText("· 周期内完成 ");
    line1.createSpan({ cls: "rslatte-review-exec-mod-num", text: String(s.completedInPeriod) });
    line1.appendText(" · 新建 ");
    line1.createSpan({ cls: "rslatte-review-exec-mod-num", text: String(s.created) });
    line1.appendText(" · 完成日晚于计划结束 ");
    line1.createSpan({ cls: "rslatte-review-exec-mod-num", text: String(s.doneAfterPlannedEnd) });
    const line2 = wrap.createDiv({ cls: "rslatte-review-exec-mod-task-line" });
    if (s.byCategory.length === 0) {
      line2.addClass("rslatte-muted");
      line2.setText("· 本周期无已完成日程（完成日落在周期内），故无分类汇总。");
    } else {
      line2.appendText("· ");
      s.byCategory.forEach((row, i) => {
        if (i > 0) line2.appendText(" · ");
        line2.appendText(row.categoryLabel);
        line2.createSpan({ cls: "rslatte-review-exec-mod-num", text: String(row.count) });
        line2.appendText("(");
        line2.appendText(formatCompactScheduleHours(row.minutes));
        line2.appendText(")");
      });
      line2.appendText("（完成日落在本周期）");
    }
  } else {
    sec.createDiv({ cls: "rslatte-review-exec-mod-line", text: model.modules.schedule });
  }
  return sec;
}

function renderProjectModuleSection(parent: HTMLElement, model: ReviewExecuteModel, anchorId: string): HTMLElement {
  const sec = parent.createDiv({ cls: "rslatte-review-exec-mod-section" });
  sec.id = anchorId;
  sec.createDiv({ cls: "rslatte-review-exec-mod-section-title", text: "项目：" });
  const b = model.projectModuleBlock as ReviewExecuteProjectModuleBlock | undefined;
  if (b) {
    const wrap = sec.createDiv({ cls: "rslatte-review-exec-mod-task-body" });
    const line1 = wrap.createDiv({ cls: "rslatte-review-exec-mod-task-line" });
    line1.appendText("· 周期内完成 ");
    line1.createSpan({ cls: "rslatte-review-exec-mod-num", text: String(b.completedInPeriod) });
    line1.appendText(" · 周期内有进展的活跃项目 ");
    line1.createSpan({ cls: "rslatte-review-exec-mod-num", text: String(b.pushedActiveCount) });
  } else {
    sec.createDiv({ cls: "rslatte-review-exec-mod-line", text: model.modules.project });
  }
  return sec;
}

function renderOutputModuleSection(parent: HTMLElement, model: ReviewExecuteModel, anchorId: string): HTMLElement {
  const sec = parent.createDiv({ cls: "rslatte-review-exec-mod-section" });
  sec.id = anchorId;
  sec.createDiv({ cls: "rslatte-review-exec-mod-section-title", text: "输出：" });
  const b = model.outputModuleBlock as ReviewExecuteOutputModuleBlock | undefined;
  if (b) {
    const wrap = sec.createDiv({ cls: "rslatte-review-exec-mod-task-body" });
    const line1 = wrap.createDiv({ cls: "rslatte-review-exec-mod-task-line" });
    line1.appendText("· 新建 ");
    line1.createSpan({ cls: "rslatte-review-exec-mod-num", text: String(b.indexNewInPeriod) });
    line1.appendText(" · 完成 ");
    line1.createSpan({ cls: "rslatte-review-exec-mod-num", text: String(b.doneInPeriod) });
    line1.appendText(" · 发布 ");
    line1.createSpan({ cls: "rslatte-review-exec-mod-num", text: String(b.publishedInPeriod) });
  } else {
    sec.createDiv({ cls: "rslatte-review-exec-mod-line", text: model.modules.output });
  }
  return sec;
}

function renderContactModuleSection(parent: HTMLElement, model: ReviewExecuteModel, anchorId: string): HTMLElement {
  const sec = parent.createDiv({ cls: "rslatte-review-exec-mod-section" });
  sec.id = anchorId;
  sec.createDiv({ cls: "rslatte-review-exec-mod-section-title", text: "联系人：" });
  const b = model.contactModuleBlock as ReviewExecuteContactModuleBlock | undefined;
  if (b) {
    const wrap = sec.createDiv({ cls: "rslatte-review-exec-mod-task-body" });
    const line1 = wrap.createDiv({ cls: "rslatte-review-exec-mod-task-line" });
    line1.appendText("· 周期内动态 ");
    line1.createSpan({ cls: "rslatte-review-exec-mod-num", text: String(b.dynamicInPeriod) });
    line1.appendText(" · 其中新建 ");
    line1.createSpan({ cls: "rslatte-review-exec-mod-num", text: String(b.newInPeriod) });
  } else {
    sec.createDiv({ cls: "rslatte-review-exec-mod-line", text: model.modules.contact });
  }
  return sec;
}

function renderExecHighlightGroup(
  parent: HTMLElement,
  label: string,
  build: (listHost: HTMLElement) => void,
): void {
  const wrap = parent.createDiv({ cls: "rslatte-review-exec-highlight-group" });
  wrap.createDiv({ cls: "rslatte-review-exec-highlight-label rslatte-muted", text: label });
  const inner = wrap.createDiv({ cls: "rslatte-review-exec-highlight-list" });
  build(inner);
}

/** Review「执行」页：A 总览 → B 时间分析（工作量/任务工时）→ C 分模块摘要（含各模块 Top） */
export function renderReviewExecuteBody(host: HTMLElement, model: ReviewExecuteModel, plugin: RSLattePlugin): void {
  host.empty();
  host.addClass("rslatte-review-execute");

  const intro = host.createDiv({ cls: "rslatte-review-records-block" });
  intro.createDiv({ cls: "rslatte-review-records-block-title", text: "本页侧重" });
  intro.createDiv({
    cls: "rslatte-review-records-note rslatte-muted",
    text: "用索引与操作日志汇总「本周期新增与完成」与任务工时；「A 周期总览」为单行指标（符号悬停见含义；点击行可跳到 C 区对应模块，或「日程」行跳到「B 时间分析 · 工作量·日程耗时」）。「是否及时、环比、改进建议」在「核对」页。",
  });

  const blockA = host.createDiv({ cls: "rslatte-review-records-block" });
  blockA.createDiv({ cls: "rslatte-review-records-block-title", text: "A 周期总览（数字）" });
  renderReviewExecuteOverviewStrip(blockA, model);

  const blockB = host.createDiv({ cls: "rslatte-review-records-block" });
  blockB.createDiv({ cls: "rslatte-review-records-block-title", text: "B 时间分析" });
  const wlAny = model.workload as any;
  const sv = wlAny.scheduleViz as ReviewExecuteScheduleVizModel | undefined;

  const bWork = blockB.createDiv({ cls: "rslatte-review-exec-b-time-block" });
  bWork.id = REVIEW_EXEC_B_SCHEDULE_WORKLOAD;
  bWork.createDiv({ cls: "rslatte-review-exec-b-time-sub", text: "工作量 · 日程耗时" });
  if (sv && typeof sv.completedCount === "number") {
    renderScheduleCharts(bWork, sv);
  } else {
    renderScheduleWorkloadLegacy(bWork, model);
  }

  const bHours = blockB.createDiv({ cls: "rslatte-review-exec-b-time-block" });
  bHours.createDiv({ cls: "rslatte-review-exec-b-time-sub", text: "任务工时汇总" });
  const detail = model.workload.taskHoursDetail;
  if (detail && detail.categories.length > 0) {
    renderReviewTaskHoursDetail(bHours, detail, plugin);
  } else {
    const diaryH = model.workload.tasksDoneEstimateHours;
    const projH = model.workload.projectTasksDoneEstimateHours ?? 0;
    const totalH = diaryH + projH;
    const anyH = totalH > 0;
    bHours.createDiv({
      cls: "rslatte-review-exec-mod-line",
      text: anyH
        ? `周期内已完成且完成日落在本周期：日记/任务清单约 ${diaryH.toFixed(1)} h + 项目任务约 ${projH.toFixed(1)} h，合计约 ${totalH.toFixed(1)} h（均依赖 meta 中 estimate_h；当前无带工时的明细可画色条）。`
        : "本周期内未汇总到有效工时（estimate_h）。在侧栏将任务或项目任务标为完成时需填写工时评估，或在编辑任务时补充。",
    });
  }

  const blockC = host.createDiv({ cls: "rslatte-review-records-block" });
  blockC.createDiv({ cls: "rslatte-review-records-block-title", text: "C 分模块数据摘要" });
  const h = model.highlights;

  const addModSection = (
    title: string,
    summaryText: string,
    modAnchorId: string,
    setupHighlights?: (hlRoot: HTMLElement) => void,
  ) => {
    const sec = blockC.createDiv({ cls: "rslatte-review-exec-mod-section" });
    sec.id = modAnchorId;
    sec.createDiv({ cls: "rslatte-review-exec-mod-section-title", text: title });
    sec.createDiv({ cls: "rslatte-review-exec-mod-line", text: summaryText });
    if (setupHighlights) {
      const hlRoot = sec.createDiv({ cls: "rslatte-review-exec-mod-highlights" });
      setupHighlights(hlRoot);
    }
  };

  renderTaskModuleSection(blockC, model, REVIEW_EXEC_MOD_IDS.task);

  const memoSec = renderMemoModuleSection(blockC, model, REVIEW_EXEC_MOD_IDS.memo);
  const memoHlRoot = memoSec.createDiv({ cls: "rslatte-review-exec-mod-highlights" });
  renderExecHighlightGroup(memoHlRoot, "重要的提醒 Top5", (memoList) => {
    if (h.memosDone.length === 0) {
      memoList.createDiv({
        cls: "rslatte-review-exec-highlight-empty rslatte-muted",
        text: "无：周期内无完成项，且无「提醒日≤周期末」仍开放的条目；或均未进入排序。",
      });
    } else {
      for (const row of h.memosDone) {
        const line = memoList.createDiv({ cls: "rslatte-review-exec-highlight-line rslatte-review-exec-highlight-line--clickable" });
        line.createDiv({ cls: "rslatte-review-exec-highlight-primary", text: row.primary });
        if (row.secondary) line.createDiv({ cls: "rslatte-review-exec-highlight-sub rslatte-muted", text: row.secondary });
        line.title = "打开任务侧栏并定位提醒行";
        line.onclick = () => void navigateReviewTimeline(plugin, row.nav);
      }
    }
  });

  renderScheduleModuleSection(blockC, model, REVIEW_EXEC_MOD_IDS.schedule);

  const projectSec = renderProjectModuleSection(blockC, model, REVIEW_EXEC_MOD_IDS.project);
  const projectHlRoot = projectSec.createDiv({ cls: "rslatte-review-exec-mod-highlights" });
  renderExecHighlightGroup(projectHlRoot, "周期内完成的项目（含本周期成果）", (projDoneList) => {
    if (h.completedProjects.length === 0) {
      projDoneList.createDiv({
        cls: "rslatte-review-exec-highlight-empty rslatte-muted",
        text: "本周期无「项目完成日」落在周期内的已完成项目（需 frontmatter done 与 status=done 一致）。",
      });
    } else {
      for (const row of h.completedProjects) {
        const line = projDoneList.createDiv({
          cls: "rslatte-review-exec-highlight-line rslatte-review-exec-highlight-line--clickable",
        });
        line.createDiv({ cls: "rslatte-review-exec-highlight-primary", text: row.primary });
        line.createDiv({ cls: "rslatte-review-exec-highlight-sub rslatte-muted", text: row.secondary });
        line.title = "打开项目侧栏";
        const pk = row.projectKey;
        line.onclick = () => void navigateReviewTimeline(plugin, { type: "project_panel", projectKey: pk });
      }
    }
  });
  renderExecHighlightGroup(projectHlRoot, "周期内有进展的项目", (projList) => {
    if (h.projectsPushed.length === 0) {
      projList.createDiv({
        cls: "rslatte-review-exec-highlight-empty rslatte-muted",
        text: "本周期无推进记录（开操作日志：project/milestone/projecttask；未开：progress_updated）。",
      });
    } else {
      for (const row of h.projectsPushed) {
        const line = projList.createDiv({ cls: "rslatte-review-exec-highlight-line rslatte-review-exec-highlight-line--clickable" });
        line.createDiv({ cls: "rslatte-review-exec-highlight-primary", text: row.primary });
        if (row.progressLines?.length) {
          const plist = line.createDiv({ cls: "rslatte-review-exec-highlight-progress-list" });
          for (const pl of row.progressLines) {
            plist.createDiv({ cls: "rslatte-review-exec-highlight-progress-item rslatte-muted", text: pl });
          }
        } else if (row.secondary) {
          line.createDiv({ cls: "rslatte-review-exec-highlight-sub rslatte-muted", text: row.secondary });
        }
        line.title = "打开项目侧栏";
        const pk = row.projectKey;
        line.onclick = () => void navigateReviewTimeline(plugin, { type: "project_panel", projectKey: pk });
      }
    }
  });

  const outputSec = renderOutputModuleSection(blockC, model, REVIEW_EXEC_MOD_IDS.output);
  const outputHlRoot = outputSec.createDiv({ cls: "rslatte-review-exec-mod-highlights" });
  renderExecHighlightGroup(outputHlRoot, "周期内完成的输出", (outList) => {
    if (h.outputsDone.length === 0) {
      outList.createDiv({ cls: "rslatte-review-exec-highlight-empty rslatte-muted", text: "本周期无标记完成的输出。" });
    } else {
      for (const row of h.outputsDone) {
        const line = outList.createDiv({ cls: "rslatte-review-exec-highlight-line rslatte-review-exec-highlight-line--clickable" });
        if (row.doneYmd) {
          const inner = line.createDiv({ cls: "rslatte-review-exec-highlight-output-row" });
          inner.createDiv({ cls: "rslatte-review-exec-highlight-primary", text: row.primary });
          inner.createDiv({ cls: "rslatte-review-exec-highlight-output-date rslatte-muted", text: row.doneYmd });
        } else {
          line.createDiv({ cls: "rslatte-review-exec-highlight-primary", text: row.primary });
        }
        line.title = row.doneYmd ? `打开输出 · 完成 ${row.doneYmd}` : "打开输出文件或侧栏";
        line.onclick = () => void navigateReviewTimeline(plugin, row.nav);
      }
    }
  });

  const contactSec = renderContactModuleSection(blockC, model, REVIEW_EXEC_MOD_IDS.contact);
  const contactHlRoot = contactSec.createDiv({ cls: "rslatte-review-exec-mod-highlights" });
  renderExecHighlightGroup(contactHlRoot, "周期内联系人动态（每人最新一条，至多 3 人）", (ctList) => {
    if (!model.workEventEnabled) {
      ctList.createDiv({
        cls: "rslatte-review-exec-highlight-empty rslatte-muted",
        text: "未开启操作日志时无联系人动态；可开日志后重刷本页。",
      });
    } else if (h.contactsSample.length === 0) {
      ctList.createDiv({
        cls: "rslatte-review-exec-highlight-empty rslatte-muted",
        text: "本周期无联系人相关 WorkEvent。",
      });
    } else {
      for (const row of h.contactsSample) {
        const line = ctList.createDiv({ cls: "rslatte-review-exec-highlight-line rslatte-review-exec-highlight-line--clickable" });
        line.createDiv({ cls: "rslatte-review-exec-highlight-primary", text: row.primary });
        line.createDiv({ cls: "rslatte-review-exec-highlight-sub rslatte-muted", text: row.secondary });
        line.title = "打开联系人笔记或联系人侧栏";
        line.onclick = () => void navigateReviewTimeline(plugin, row.nav);
      }
    }
  });
}
