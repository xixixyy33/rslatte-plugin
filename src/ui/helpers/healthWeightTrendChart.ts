/**
 * 健康侧栏：体重（日卡）/ 腰围（周卡）折线趋势 + 目标虚线参考。
 */
import type RSLattePlugin from "../../main";
import type { HealthRecordIndexItem } from "../../types/recordIndexTypes";
import { normalizeIndexMetricKeyToCanonical } from "../../services/health/healthCanonicalMetrics";

export type HealthWeightPoint = { ymd: string; kg: number; tsMs: number };
export type HealthWaistPoint = { ymd: string; cm: number; tsMs: number };

/** 读取设置中的目标体重（kg），默认 55 */
export function getHealthTargetWeightKg(settings: unknown): number {
  const v = Number((settings as any)?.healthPanel?.targetWeightKg);
  if (!Number.isFinite(v) || v <= 0 || v >= 500) return 55;
  return Math.round(v * 10) / 10;
}

/** 读取设置中的目标腰围（cm），默认 75 */
export function getHealthTargetWaistCm(settings: unknown): number {
  const v = Number((settings as any)?.healthPanel?.targetWaistCm);
  if (!Number.isFinite(v) || v <= 0 || v > 250) return 75;
  return Math.round(v * 10) / 10;
}

/** active + 归档健康索引合并（与 Review 记录页 health 合并口径一致，用于趋势全长） */
export async function loadMergedHealthIndexItems(plugin: RSLattePlugin): Promise<HealthRecordIndexItem[]> {
  const rr = plugin.recordRSLatte;
  if (!rr) return [];
  try {
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
  } catch {
    return [];
  }
}

/** 仅日卡体重：同日多条取 tsMs 最新 */
export function collectDayWeightSeries(items: HealthRecordIndexItem[]): HealthWeightPoint[] {
  const byDay = new Map<string, { kg: number; tsMs: number }>();
  for (const it of items) {
    if (it.isDelete) continue;
    if (normalizeIndexMetricKeyToCanonical(String(it.metricKey ?? "")) !== "weight") continue;
    const p = String(it.period ?? "day").trim().toLowerCase();
    if (p !== "day") continue;
    const ymd = String(it.recordDate ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) continue;
    const kg = parseFloat(String(it.valueStr ?? "").trim());
    if (!Number.isFinite(kg) || kg <= 0 || kg > 500) continue;
    const tsMs = Number(it.tsMs) || 0;
    const prev = byDay.get(ymd);
    if (!prev || tsMs >= prev.tsMs) byDay.set(ymd, { kg, tsMs });
  }
  return Array.from(byDay.entries())
    .map(([ymd, v]) => ({ ymd, kg: v.kg, tsMs: v.tsMs }))
    .sort((a, b) => a.ymd.localeCompare(b.ymd));
}

/** 仅周卡腰围：同 recordDate（周锚日）多条取 tsMs 最新 */
export function collectWeekWaistSeries(items: HealthRecordIndexItem[]): HealthWaistPoint[] {
  const byKey = new Map<string, { cm: number; tsMs: number }>();
  for (const it of items) {
    if (it.isDelete) continue;
    if (normalizeIndexMetricKeyToCanonical(String(it.metricKey ?? "")) !== "waist") continue;
    const p = String(it.period ?? "week").trim().toLowerCase();
    if (p !== "week") continue;
    const ymd = String(it.recordDate ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) continue;
    const cm = parseFloat(String(it.valueStr ?? "").trim());
    if (!Number.isFinite(cm) || cm < 0 || cm > 200) continue;
    const tsMs = Number(it.tsMs) || 0;
    const prev = byKey.get(ymd);
    if (!prev || tsMs >= prev.tsMs) byKey.set(ymd, { cm, tsMs });
  }
  return Array.from(byKey.entries())
    .map(([ymd, v]) => ({ ymd, cm: v.cm, tsMs: v.tsMs }))
    .sort((a, b) => a.ymd.localeCompare(b.ymd));
}

function renderScalarTrendChart(
  host: HTMLElement,
  points: Array<{ ymd: string; value: number }>,
  target: number,
  labels: {
    title: string;
    empty: string;
    svgTitle: string;
    pointTip: (ymd: string, v: number) => string;
  },
  style: { cssWrap: string; titleCls: string; emptyCls: string },
  opts: { highlightYmd?: string; yFloorPad: number; yMinSpan: number },
): void {
  host.empty();
  host.addClass(style.cssWrap);

  host.createDiv({
    cls: style.titleCls,
    text: labels.title,
  });

  if (points.length === 0) {
    host.createDiv({
      cls: `rslatte-muted ${style.emptyCls}`,
      text: labels.empty,
    });
    return;
  }

  const W = 360;
  const H = 152;
  const padL = 44;
  const padR = 10;
  const padT = 16;
  const padB = 30;
  const pw = W - padL - padR;
  const ph = H - padT - padB;

  const vals = points.map((p) => p.value);
  const minData = Math.min(...vals, target);
  const maxData = Math.max(...vals, target);
  const spanRaw = maxData - minData;
  let yMin = minData - Math.max(opts.yFloorPad, spanRaw * 0.12);
  let yMax = maxData + Math.max(opts.yFloorPad, spanRaw * 0.12);
  if (yMax - yMin < opts.yMinSpan) {
    yMin -= opts.yFloorPad;
    yMax += opts.yFloorPad;
  }
  const ySpan = yMax - yMin || 1;

  const n = points.length;
  const xAt = (i: number) => padL + (n <= 1 ? pw / 2 : (pw * i) / (n - 1));
  const yAt = (v: number) => padT + ph - ((v - yMin) / ySpan) * ph;

  const poly = points.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.value).toFixed(1)}`).join(" ");
  const targetY = yAt(target);

  const svg = host.createSvg("svg", {
    attr: {
      viewBox: `0 0 ${W} ${H}`,
      width: "100%",
      height: String(H),
      preserveAspectRatio: "xMidYMid meet",
    },
    cls: "rslatte-health-metric-trend-svg",
  });
  svg.createSvg("title").setText(labels.svgTitle);

  svg.createSvg("line", {
    attr: {
      x1: padL,
      y1: targetY,
      x2: W - padR,
      y2: targetY,
    },
    cls: "rslatte-health-metric-trend-target-line",
  });

  svg.createSvg("polyline", {
    attr: { points: poly, fill: "none", "stroke-width": "2", "stroke-linejoin": "round", "stroke-linecap": "round" },
    cls: "rslatte-health-metric-trend-line",
  });

  const fmt = (v: number) => (Math.round(v * 10) / 10).toFixed(1);
  points.forEach((p, i) => {
    const c = svg.createSvg("circle", {
      attr: {
        cx: xAt(i),
        cy: yAt(p.value),
        r: opts.highlightYmd === p.ymd ? 5 : 3,
      },
      cls:
        "rslatte-health-metric-trend-dot" +
        (opts.highlightYmd === p.ymd ? " rslatte-health-metric-trend-dot--focus" : ""),
    });
    c.createSvg("title").setText(labels.pointTip(p.ymd, p.value));
  });

  svg.createSvg("text", {
    attr: { x: 4, y: padT + 4, "font-size": "10" },
    cls: "rslatte-health-metric-trend-axis",
  }).setText(fmt(yMax));
  svg.createSvg("text", {
    attr: { x: 4, y: padT + ph, "font-size": "10" },
    cls: "rslatte-health-metric-trend-axis",
  }).setText(fmt(yMin));
  svg.createSvg("text", {
    attr: { x: padL, y: H - 6, "font-size": "10" },
    cls: "rslatte-health-metric-trend-axis",
  }).setText(points[0].ymd);
  if (n > 1) {
    svg.createSvg("text", {
      attr: { x: padL + pw, y: H - 6, "text-anchor": "end", "font-size": "10" },
      cls: "rslatte-health-metric-trend-axis",
    }).setText(points[n - 1].ymd);
  }
}

/**
 * 在容器内绘制 SVG：折线为实测，水平虚线为目标体重；可选高亮某日（编辑/对应当前条）。
 */
export function renderHealthWeightTrendChart(
  host: HTMLElement,
  points: HealthWeightPoint[],
  targetKg: number,
  opts?: { highlightYmd?: string },
): void {
  const asVal = points.map((p) => ({ ymd: p.ymd, value: p.kg }));
  renderScalarTrendChart(
    host,
    asVal,
    targetKg,
    {
      title: `体重趋势（日卡，共 ${points.length} 天）· 虚线为目标 ${targetKg} kg`,
      empty: "暂无日卡体重数据。在日记中录入日卡体重后，将在此显示波动。",
      svgTitle: `体重 kg，目标 ${targetKg} kg`,
      pointTip: (ymd, v) => `${ymd} · ${v} kg`,
    },
    {
      cssWrap: "rslatte-health-weight-chart-wrap",
      titleCls: "rslatte-health-weight-chart-title",
      emptyCls: "rslatte-health-weight-chart-empty",
    },
    { highlightYmd: opts?.highlightYmd, yFloorPad: 0.5, yMinSpan: 0.4 },
  );
}

/** 腰围趋势（周卡，横轴为记录锚日）+ 目标腰围虚线 */
export function renderHealthWaistTrendChart(
  host: HTMLElement,
  points: HealthWaistPoint[],
  targetCm: number,
  opts?: { highlightYmd?: string },
): void {
  const asVal = points.map((p) => ({ ymd: p.ymd, value: p.cm }));
  renderScalarTrendChart(
    host,
    asVal,
    targetCm,
    {
      title: `腰围趋势（周卡，共 ${points.length} 条）· 虚线为目标 ${targetCm} cm`,
      empty: "暂无周卡腰围数据。在健康周卡中录入腰围后，将在此显示波动。",
      svgTitle: `腰围 cm，目标 ${targetCm} cm`,
      pointTip: (ymd, v) => `${ymd} · ${v} cm`,
    },
    {
      cssWrap: "rslatte-health-waist-chart-wrap",
      titleCls: "rslatte-health-waist-chart-title",
      emptyCls: "rslatte-health-waist-chart-empty",
    },
    { highlightYmd: opts?.highlightYmd, yFloorPad: 1, yMinSpan: 2 },
  );
}
