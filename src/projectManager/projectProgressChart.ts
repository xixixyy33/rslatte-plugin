/**
 * 第五节「项目进度图」：从 ProjectEntry 构建甘特时间轴数据（纯函数，供侧栏渲染）。
 */
import type { MilestoneProgress, ProjectEntry, ProjectTaskItem } from "./types";

export type ProgressChartZoom = "week" | "month" | "quarter";
export type ProgressChartTaskSort = "planned_end" | "file_order";
export type ProgressChartMilestoneMode = "overlay" | "separate" | "hidden";
export type ProgressChartSummaryMode = "count" | "hours" | "both";

export interface ProgressChartOptions {
  marginDays: number;
  taskSort: ProgressChartTaskSort;
  zoom: ProgressChartZoom;
  milestoneMode: ProgressChartMilestoneMode;
  summaryMode: ProgressChartSummaryMode;
  /** 为 true 时不生成已完成（DONE）任务的甘特条；空轨不展示 */
  hideDone?: boolean;
}

export type GanttBarPhase = "todo" | "in_progress" | "waiting" | "done" | "cancelled";

export interface GanttBarModel {
  task: ProjectTaskItem;
  /** 开始日期在时间轴上的中心点比例（0～1） */
  startFrac: number;
  /** 结束日期在时间轴上的中心点比例（0～1） */
  endFrac: number;
  /** 是否当天开始当天结束（渲染为单点） */
  isPoint: boolean;
  /** 任务计划结束日超过所属根里程碑计划完成日（异常提示） */
  exceedsMilestonePlannedEnd: boolean;
  /** 短标签（用于 tooltip） */
  label: string;
  phase: GanttBarPhase;
}

export interface GanttTrackModel {
  rootPath: string;
  rootTitle: string;
  bars: GanttBarModel[];
}

export interface MilestoneMarkerModel {
  path: string;
  title: string;
  /** planned_end / done_date / cancelled_date / created_date 中用于落点的 YYYY-MM-DD */
  dateYmd: string;
  kind: "planned" | "done" | "cancelled" | "created";
}

export interface ProgressChartSummary {
  doneCount: number;
  activeCount: number;
  /** 非取消任务总数 */
  totalNonCancelled: number;
  doneHours: number;
  totalHours: number;
  hasAnyEstimate: boolean;
}

export interface ProgressChartModel {
  chartMinYmd: string;
  chartMaxYmd: string;
  totalDays: number;
  pxPerDay: number;
  tracks: GanttTrackModel[];
  milestoneMarkers: MilestoneMarkerModel[];
  summary: ProgressChartSummary;
  /** 无任务且无里程碑（不含仅默认轨）时 true */
  isEmptyProject: boolean;
}

function isYmd(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
}

/** 与轴上「整日」对齐：从 origin 起第 n 天的 YYYY-MM-DD */
export function addDaysYmd(originYmd: string, deltaDays: number): string {
  const [y, m, d] = originYmd.split("-").map((x) => Number(x));
  const t = Date.UTC(y, m - 1, d) + deltaDays * 86400000;
  const dt = new Date(t);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function daysBetweenInclusive(minYmd: string, maxYmd: string): number {
  const [y1, m1, d1] = minYmd.split("-").map(Number);
  const [y2, m2, d2] = maxYmd.split("-").map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

function minYmd(a: string, b: string): string {
  return a <= b ? a : b;
}

function maxYmd(a: string, b: string): string {
  return a >= b ? a : b;
}

function taskPhase(it: ProjectTaskItem): GanttBarPhase {
  const st = String(it.statusName ?? "").toUpperCase();
  if (st === "DONE") return "done";
  if (st === "CANCELLED") return "cancelled";
  if (st === "IN_PROGRESS") {
    const ph = String((it as any).task_phase ?? "").trim();
    if (ph === "waiting_others" || ph === "waiting_until") return "waiting";
    return "in_progress";
  }
  return "todo";
}

function clip(s: string, maxLen: number): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= maxLen) return t;
  return t.slice(0, Math.max(0, maxLen - 1)) + "…";
}

function collectProjectDateSeeds(p: ProjectEntry, tasks: ProjectTaskItem[], roots: MilestoneProgress[]): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (isYmd(v)) out.push(v.trim());
  };
  push(p.created_date);
  push(p.planned_start);
  push(p.planned_end);
  push(p.actual_start);
  push(p.done);
  push(p.cancelled);
  for (const it of tasks) {
    push((it as any).created_date);
    push((it as any).planned_start);
    push((it as any).planned_end);
    push((it as any).actual_start);
    push((it as any).done_date);
    push((it as any).cancelled_date);
  }
  for (const m of roots) {
    push((m as any).created_date);
    push((m as any).planned_end);
    push((m as any).done_date);
    push((m as any).cancelled_date);
  }
  return out;
}

function pxPerDayForZoom(z: ProgressChartZoom): number {
  switch (z) {
    case "week":
      return 10;
    case "quarter":
      return 3;
    case "month":
    default:
      return 5;
  }
}

/**
 * @param effectivePathForTask 与推进区一致：任务所属里程碑路径
 */
export function buildProgressChartModel(
  p: ProjectEntry,
  roots: MilestoneProgress[],
  effectivePathForTask: (it: ProjectTaskItem) => string,
  opts: ProgressChartOptions
): ProgressChartModel {
  const tasks = ((p as any).taskItems ?? []) as ProjectTaskItem[];
  const milestones = (p.milestones ?? []) as MilestoneProgress[];

  const realMilestoneCount = milestones.filter((m) => {
    const path = String((m as any)?.path ?? (m as any)?.name ?? "").trim();
    return !!path;
  }).length;
  const isEmptyProject = tasks.length === 0 && realMilestoneCount === 0;

  const seeds = collectProjectDateSeeds(p, tasks, roots);
  let minD: string | null = null;
  let maxD: string | null = null;
  for (const y of seeds) {
    if (!minD || y < minD) minD = y;
    if (!maxD || y > maxD) maxD = y;
  }

  const today = (() => {
    try {
      const m = (window as any).moment?.();
      if (m?.format) return m.format("YYYY-MM-DD");
    } catch {}
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();

  if (!minD || !maxD) {
    minD = today;
    maxD = today;
  }
  const safeMinD = minD ?? today;
  const safeMaxD = maxD ?? today;
  const minBase = minYmd(safeMinD, today);
  const maxBase = maxYmd(safeMaxD, today);

  const margin = Math.max(0, Math.floor(opts.marginDays || 30));
  const chartMinYmd = addDaysYmd(minBase, -margin);
  const chartMaxYmd = addDaysYmd(maxBase, margin);
  const totalDays = daysBetweenInclusive(chartMinYmd, chartMaxYmd);
  const pxPerDay = pxPerDayForZoom(opts.zoom);

  const span = totalDays;
  const fracByDayCenter = (ymd: string): number => {
    const i = daysBetweenInclusive(chartMinYmd, ymd) - 1;
    return Math.min(1, Math.max(0, (i + 0.5) / span));
  };

  const barForTask = (it: ProjectTaskItem, rootPlannedEndYmd: string): GanttBarModel | null => {
    const st = String(it.statusName ?? "").toUpperCase();
    const plannedStart = isYmd((it as any).planned_start) ? (it as any).planned_start.trim() : "";
    const created = isYmd((it as any).created_date) ? (it as any).created_date.trim() : "";
    const plannedEnd = isYmd((it as any).planned_end) ? (it as any).planned_end.trim() : "";
    const actualStart = isYmd((it as any).actual_start) ? (it as any).actual_start.trim() : "";
    const doneD = isYmd((it as any).done_date) ? (it as any).done_date.trim() : "";
    const canD = isYmd((it as any).cancelled_date) ? (it as any).cancelled_date.trim() : "";

    let leftY = plannedStart || created || actualStart || "";
    let rightY = "";

    if (st === "DONE") rightY = doneD || plannedEnd;
    else if (st === "CANCELLED") rightY = canD || plannedEnd;
    else rightY = plannedEnd;

    if (!rightY && !leftY) return null;
    if (!leftY) leftY = rightY;
    if (!rightY) rightY = leftY;
    if (leftY < chartMinYmd) leftY = chartMinYmd;
    if (rightY > chartMaxYmd) rightY = chartMaxYmd;
    if (leftY > rightY) {
      const t = leftY;
      leftY = rightY;
      rightY = t;
    }

    const startFrac = fracByDayCenter(leftY);
    const endFrac = fracByDayCenter(rightY);
    const isPoint = leftY === rightY;
    const exceedsMilestonePlannedEnd = !!rootPlannedEndYmd && !!plannedEnd && plannedEnd > rootPlannedEndYmd;

    return {
      task: it,
      startFrac,
      endFrac,
      isPoint,
      exceedsMilestonePlannedEnd,
      label: clip(String(it.text ?? "").replace(/^[\s⭐↪🧠🍃⏳]+/, ""), 28),
      phase: taskPhase(it),
    };
  };

  const tracks: GanttTrackModel[] = [];
  for (const root of roots) {
    const rootPath = String((root as any)?.path ?? (root as any)?.name ?? "").trim();
    if (!rootPath) continue;
    const rootTitle = String((root as any)?.name ?? rootPath).trim() || rootPath;
    const rootPlannedEndYmd = isYmd((root as any)?.planned_end) ? String((root as any).planned_end).trim() : "";

    const inTrack = tasks.filter((it) => {
      const ep = effectivePathForTask(it);
      return ep === rootPath || ep.startsWith(rootPath + " / ");
    });

    let ordered = [...inTrack];
    if (opts.taskSort === "file_order") {
      ordered.sort((a, b) => Number(a.lineNo ?? 0) - Number(b.lineNo ?? 0));
    } else {
      ordered.sort((a, b) => {
        const da = isYmd((a as any).planned_end) ? (a as any).planned_end : "\xff";
        const db = isYmd((b as any).planned_end) ? (b as any).planned_end : "\xff";
        if (da !== db) return da.localeCompare(db);
        return Number(a.lineNo ?? 0) - Number(b.lineNo ?? 0);
      });
    }

    const hideDone = !!opts.hideDone;
    const bars: GanttBarModel[] = [];
    for (const it of ordered) {
      if (hideDone && String(it.statusName ?? "").toUpperCase() === "DONE") continue;
      const b = barForTask(it, rootPlannedEndYmd);
      if (b) bars.push(b);
    }
    if (!hideDone || bars.length > 0) {
      tracks.push({ rootPath, rootTitle, bars });
    }
  }

  const milestoneMarkers: MilestoneMarkerModel[] = [];
  if (opts.milestoneMode !== "hidden") {
    for (const m of roots) {
      const path = String((m as any)?.path ?? (m as any)?.name ?? "").trim();
      if (!path) continue;
      const title = String((m as any)?.name ?? path).trim();
      const pushM = (dateYmd: string, kind: MilestoneMarkerModel["kind"]) => {
        if (!isYmd(dateYmd)) return;
        milestoneMarkers.push({ path, title, dateYmd: dateYmd.trim(), kind });
      };
      pushM((m as any).planned_end, "planned");
      pushM((m as any).done_date, "done");
      pushM((m as any).cancelled_date, "cancelled");
      pushM((m as any).created_date, "created");
    }
  }

  let doneCount = 0;
  let activeCount = 0;
  let totalNonCancelled = 0;
  let doneHours = 0;
  let totalHours = 0;
  let hasAnyEstimate = false;
  for (const it of tasks) {
    const st = String(it.statusName ?? "").toUpperCase();
    if (st === "CANCELLED") continue;
    totalNonCancelled++;
    const h = Number((it as any).estimate_h);
    if (Number.isFinite(h) && h > 0) {
      hasAnyEstimate = true;
      totalHours += h;
      if (st === "DONE") doneHours += h;
    }
    if (st === "DONE") doneCount++;
    else activeCount++;
  }

  return {
    chartMinYmd,
    chartMaxYmd,
    totalDays,
    pxPerDay,
    tracks,
    milestoneMarkers,
    summary: {
      doneCount,
      activeCount,
      totalNonCancelled,
      doneHours,
      totalHours,
      hasAnyEstimate,
    },
    isEmptyProject,
  };
}

/** 将 YYYY-MM-DD 映射到时间轴 0～1 */
export function ymdToFrac(chartMinYmd: string, chartMaxYmd: string, ymd: string): number {
  const span = daysBetweenInclusive(chartMinYmd, chartMaxYmd);
  const i = daysBetweenInclusive(chartMinYmd, ymd) - 1;
  return Math.min(1, Math.max(0, i / span));
}
