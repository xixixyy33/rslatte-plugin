import { App, ItemView, Notice, normalizePath, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import type RSLattePlugin from "../../main";
import { VIEW_TYPE_KNOWLEDGE, VIEW_TYPE_KNOWLEDGE_PANEL, VIEW_TYPE_OUTPUTS } from "../../constants/viewTypes";
import {
  tryReadKnowledgeIndexJson,
  upsertKnowledgeIndexItemByFile,
} from "../../services/knowledgeIndexWriter";
import {
  collectMarkdownFilesUnderFolder,
  resolveKnowledgeLibraryRootRel,
} from "../../services/knowledgePaths";
import { KnowledgeDocInfoModal } from "../modals/KnowledgeDocInfoModal";
import {
  addDaysLocalYmd,
  localYmdFromInstant,
  todayLocalYmd,
  weekStartMondayLocalYmd,
} from "../../utils/localCalendarYmd";

type KnowledgeTab = "random" | "overview" | "library";

/** `workspace`：工作台；`sidepanel`：独立侧栏（§5.2 最小落地） */
export type KnowledgeViewHost = "workspace" | "sidepanel";

const KNOWLEDGE_LIBRARY_SCAN_LIMIT = 5000;
const KNOWLEDGE_REC_WINDOW_DAYS = 30;
const KNOWLEDGE_REC_READ_KEY = "recent_read_dates";
const OVERVIEW_WEEKS = 24;

function tryGetFolderByPathLoose(app: App, p: string): TFolder | null {
  const raw = String(p ?? "").trim();
  if (!raw) return null;
  const candidates = Array.from(
    new Set([
      raw,
      normalizePath(raw),
      raw.replace(/^\.\/+/, ""),
      normalizePath(raw.replace(/^\.\/+/, "")),
      raw.replace(/^\/+/, ""),
      normalizePath(raw.replace(/^\/+/, "")),
    ].filter(Boolean)),
  );
  for (const c of candidates) {
    const af = app.vault.getAbstractFileByPath(c);
    if (af instanceof TFolder) return af;
  }
  return null;
}

function relPathUnderRoot(filePath: string, rootNorm: string): string {
  const p = normalizePath(filePath);
  if (p === rootNorm) return "";
  if (p.startsWith(`${rootNorm}/`)) return p.slice(rootNorm.length + 1);
  return p;
}

function shortIso(d: unknown): string {
  const s = typeof d === "string" ? d : "";
  if (s.length >= 10) return s.slice(0, 10);
  return s;
}

function ymdToday(): string {
  return todayLocalYmd();
}

function daysSinceYmd(ymd: string): number {
  if (!ymd) return 9999;
  const t = Date.parse(`${ymd}T00:00:00`);
  if (!Number.isFinite(t)) return 9999;
  return Math.floor((Date.now() - t) / 86400000);
}

function parseRecentReadDates(raw: unknown): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    const s = shortIso(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) out.push(s);
  };
  if (Array.isArray(raw)) {
    for (const x of raw) push(x);
  } else if (typeof raw === "string") {
    for (const part of raw.split(/[,\s;|]+/)) push(part);
  }
  return [...new Set(out)].slice(0, 3);
}

function readPublishedYmd(fm: Record<string, unknown>, f: TFile): string {
  const p = shortIso(fm.published_at ?? fm.publishedAt);
  if (p) return p;
  return localYmdFromInstant(new Date(f.stat.mtime)) ?? "";
}

function hasRecentReadWithinDays(readDates: string[], days: number): boolean {
  return readDates.some((d) => daysSinceYmd(d) <= days);
}

function pickDotSymbol(publishedYmd: string, readDates: string[]): string {
  if (daysSinceYmd(publishedYmd) <= KNOWLEDGE_REC_WINDOW_DAYS) return "✅";
  if (hasRecentReadWithinDays(readDates, KNOWLEDGE_REC_WINDOW_DAYS)) return "✅";
  return "☐";
}

type KnowledgeFileMeta = {
  file: TFile;
  relPath: string;
  l1: string;
  l2: string;
  publishedYmd: string;
  readDates: string[];
  outputId: string;
  fm: Record<string, unknown>;
};

type WeeklyTrendPoint = {
  weekKey: string;
  weekLabel: string;
  created: number;
  done: number;
  published: number;
  publishedWordCount: number;
};

type MixedDocItem = {
  source: "knowledge" | "output";
  path: string;
  title: string;
  dirLabel: string;
  outputKind: string;
  status: string;
  spaceId: string;
  spaceName: string;
  mtimeMs: number;
};

function parseYmdLoose(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return localYmdFromInstant(s) ?? "";
}

function addDays(ymd: string, n: number): string {
  return addDaysLocalYmd(ymd, n);
}

function weekLabel(weekStart: string): string {
  const end = addDays(weekStart, 6).slice(5);
  return `${weekStart.slice(5)}~${end}`;
}

function weekKeyOfYmd(ymd: string): string {
  const m = String(ymd ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  return weekStartMondayLocalYmd(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function fmDomains(fm: Record<string, unknown>): string[] {
  const raw = fm["领域"] ?? fm.domains ?? fm.domain;
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);
  if (typeof raw === "string") return raw.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
  return [];
}

function fmDocCategory(fm: Record<string, unknown>): string {
  return String(fm["文档分类"] ?? fm.doc_category ?? "").trim();
}

function normalizeWordCount(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function displayKnowledgeFromPath(filePath: string, rootNorm: string): string {
  const rel = relPathUnderRoot(filePath, rootNorm)
    .replace(/^30-Knowledge\//i, "")
    .replace(/^90-Knowledge\//i, "");
  const segs = rel.split("/").filter(Boolean);
  if (!segs.length) return rel;
  // 去掉文件名
  if (segs.length >= 1) segs.pop();
  // 去掉末尾“【文档分类】文件名(-n)”目录
  if (segs.length >= 1 && /^【.+】.+(?:-\d+)?$/.test(segs[segs.length - 1])) {
    segs.pop();
  }
  return segs.join("/") || rel;
}

/**
 * V2 知识沉淀与输出页：知识库浏览 + 输出索引串联；支持查看单篇「基础信息」（frontmatter + 输出台账）
 */
export class KnowledgeView extends ItemView {
  private plugin: RSLattePlugin;
  private _renderSeq = 0;
  private _tab: KnowledgeTab = "library";
  private _overviewDomain = "";
  private _overviewCategory = "";
  private _preserveScrollOnNextRender = false;
  private _dailyRecDay = "";
  private _dailyRecPaths: string[] = [];
  private _l1Collapsed = new Map<string, boolean>();
  private _l2Collapsed = new Map<string, boolean>();

  constructor(leaf: WorkspaceLeaf, plugin: RSLattePlugin, private readonly host: KnowledgeViewHost = "workspace") {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return this.host === "sidepanel" ? VIEW_TYPE_KNOWLEDGE_PANEL : VIEW_TYPE_KNOWLEDGE;
  }
  getDisplayText(): string {
    return "知识管理（工作台）";
  }
  getIcon(): string { return "book"; }

  async onOpen() {
    // 每次打开视图默认回到「随便看看」
    this._tab = "random";
    void this.render();
  }

  async onClose() {}

  private openDocInfoModal(filePath: string) {
    new KnowledgeDocInfoModal(this.app, this.plugin, filePath).open();
  }

  private async refreshKnowledgeIndex(): Promise<void> {
    try {
      new Notice("开始刷新：知识…");
      const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "knowledge" as any, "manual_refresh");
      if (!r.ok) {
        new Notice(`刷新失败：${r.error.message}（module=knowledge, mode=manual_refresh）`);
        console.warn("[RSLatte][ui] runE2 failed", { moduleKey: "knowledge", mode: "manual_refresh", error: r.error });
        return;
      }
      const doc = await tryReadKnowledgeIndexJson(this.plugin);
      const n = Array.isArray((doc as any)?.items) ? (doc as any).items.length : 0;
      new Notice(`知识索引已刷新（${n} 篇）`);
      void this.render();
    } catch (e: any) {
      new Notice(`刷新知识索引失败：${e?.message ?? String(e)}`);
    }
  }

  private async rebuildKnowledgeIndex(): Promise<void> {
    try {
      new Notice("开始扫描重建：知识…");
      const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "knowledge" as any, "rebuild");
      if (!r.ok) {
        new Notice(`重建失败：${r.error.message}（module=knowledge, mode=rebuild）`);
        console.warn("[RSLatte][ui] runE2 failed", { moduleKey: "knowledge", mode: "rebuild", error: r.error });
        return;
      }
      const doc = await tryReadKnowledgeIndexJson(this.plugin);
      const n = Array.isArray((doc as any)?.items) ? (doc as any).items.length : 0;
      new Notice(`知识索引已重建（${n} 篇）`);
      void this.render();
    } catch (e: any) {
      new Notice(`重建知识索引失败：${e?.message ?? String(e)}`);
    }
  }

  private attachRowOpenHandlers(row: HTMLElement, filePath: string) {
    row.style.cursor = "pointer";
    row.onclick = () => {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (file instanceof TFile) {
        const leaf = this.app.workspace.getLeaf(false);
        void leaf.openFile(file, { active: true, state: { mode: "preview" } as any });
      }
    };
  }

  private collectKnowledgeMetas(rootAf: TFolder, rootNorm: string): KnowledgeFileMeta[] {
    const files = collectMarkdownFilesUnderFolder(rootAf, KNOWLEDGE_LIBRARY_SCAN_LIMIT);
    const metas: KnowledgeFileMeta[] = [];
    const rootBase = normalizePath(rootNorm).split("/").filter(Boolean).pop() ?? "";
    for (const f of files) {
      const relPath = relPathUnderRoot(f.path, rootNorm) || f.basename;
      const segs = relPath.split("/").filter(Boolean);
      // 去掉最外层知识库目录（如 30-Knowledge），一级直接展示其下子目录（如 31-Permanent）
      const trimmedSegs = segs[0] === rootBase ? segs.slice(1) : segs;
      const l1 = trimmedSegs[0] || "未分一级目录";
      const l2 = trimmedSegs[1] || "未分二级目录";
      const cache = this.app.metadataCache.getFileCache(f);
      const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
      const publishedYmd = readPublishedYmd(fm, f);
      const readDates = parseRecentReadDates(fm[KNOWLEDGE_REC_READ_KEY]);
      const outputId = String(fm.output_id ?? "").trim();
      metas.push({ file: f, relPath, l1, l2, publishedYmd, readDates, outputId, fm });
    }
    metas.sort((a, b) => {
      const d = Date.parse(`${b.publishedYmd}T00:00:00`) - Date.parse(`${a.publishedYmd}T00:00:00`);
      if (Number.isFinite(d) && d !== 0) return d;
      return b.file.stat.mtime - a.file.stat.mtime;
    });
    return metas;
  }

  private computeWeeklyTrends(metas: KnowledgeFileMeta[], outputItems: any[]): WeeklyTrendPoint[] {
    const now = new Date();
    const curWeek = weekStartMondayLocalYmd(now);
    const weekKeys: string[] = [];
    for (let i = OVERVIEW_WEEKS - 1; i >= 0; i--) weekKeys.push(addDays(curWeek, -7 * i));
    const map = new Map<string, WeeklyTrendPoint>();
    for (const wk of weekKeys) {
      map.set(wk, {
        weekKey: wk,
        weekLabel: wk.slice(5),
        created: 0,
        done: 0,
        published: 0,
        publishedWordCount: 0,
      });
    }
    for (const m of metas) {
      const wk = weekKeyOfYmd(m.publishedYmd);
      const p = map.get(wk);
      if (!p) continue;
      p.published += 1;
      p.publishedWordCount += normalizeWordCount(m.fm.word_count);
      p.weekLabel = weekLabel(p.weekKey);
    }
    for (const it of outputItems) {
      const c = parseYmdLoose((it as any).createDate);
      const d = parseYmdLoose((it as any).doneDate ?? (it as any).doneTime);
      if (c) {
        const p = map.get(weekKeyOfYmd(c));
        if (p) p.created += 1;
      }
      if (d) {
        const p = map.get(weekKeyOfYmd(d));
        if (p) p.done += 1;
      }
    }
    const out = [...map.values()];
    out.sort((a, b) => a.weekKey.localeCompare(b.weekKey));
    for (const p of out) p.weekLabel = weekLabel(p.weekKey);
    return out;
  }

  private renderSimpleLineChart(parent: HTMLElement, title: string, series: { name: string; color: string; values: number[] }[], labels: string[]): void {
    const card = parent.createDiv({ cls: "rslatte-knowledge-overview-chart-card" });
    card.createEl("h4", { text: title, cls: "rslatte-knowledge-overview-subtitle" });
    const w = 760;
    const h = 220;
    const padL = 34;
    const padR = 14;
    const padT = 10;
    const padB = 28;
    const maxY = Math.max(1, ...series.flatMap((s) => s.values));
    const x = (i: number) => padL + (i * (w - padL - padR)) / Math.max(1, labels.length - 1);
    const y = (v: number) => padT + (h - padT - padB) * (1 - v / maxY);
    const svg = card.createSvg("svg", { attr: { viewBox: `0 0 ${w} ${h}` } });
    svg.addClass("rslatte-knowledge-overview-chart");
    const axis = svg.createSvg("path", { attr: { d: `M${padL},${padT} L${padL},${h - padB} L${w - padR},${h - padB}`, stroke: "currentColor", fill: "none", "stroke-width": "1", opacity: "0.45" } });
    void axis;
    const ticks = 4;
    for (let i = 1; i <= ticks; i++) {
      const tv = (maxY * i) / ticks;
      const ty = y(tv);
      svg.createSvg("line", { attr: { x1: String(padL), y1: String(ty), x2: String(w - padR), y2: String(ty), stroke: "currentColor", opacity: "0.12" } });
    }
    for (const s of series) {
      const d = s.values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(v)}`).join(" ");
      svg.createSvg("path", { attr: { d, stroke: s.color, fill: "none", "stroke-width": "2" } });
    }
    const lx = labels.length > 1 ? [0, Math.floor((labels.length - 1) / 2), labels.length - 1] : [0];
    for (const i of lx) {
      const tx = x(i);
      const t = labels[i] ?? "";
      const textEl = svg.createSvg("text", { attr: { x: String(tx), y: String(h - 8), "text-anchor": "middle", "font-size": "10", opacity: "0.8" } });
      textEl.setText(t);
    }
    const legend = card.createDiv({ cls: "rslatte-knowledge-overview-legend" });
    for (const s of series) {
      const it = legend.createDiv({ cls: "rslatte-knowledge-overview-legend-item" });
      it.createSpan({ cls: "rslatte-knowledge-overview-legend-dot" }).setAttr("style", `background:${s.color}`);
      it.createSpan({ text: s.name });
    }
  }

  private outputDirAfterNotes(path: string): string {
    const segs = normalizePath(path).split("/").filter(Boolean);
    const i = segs.findIndex((x) => x.toLowerCase() === "notes");
    const picked = i >= 0 ? segs.slice(i + 1, -1) : segs.slice(Math.max(0, segs.length - 3), -1);
    return picked.join("/") || "（根目录）";
  }

  private knowledgeDirL1L2(path: string, rootNorm: string): string {
    const rel = relPathUnderRoot(path, rootNorm);
    const segs = rel.split("/").filter(Boolean);
    return `${segs[0] ?? "未分一级目录"}/${segs[1] ?? "未分二级目录"}`;
  }

  private async gotoKnowledgePath(path: string): Promise<void> {
    (this.plugin as any).__rslatteKnowledgeFocusPath = normalizePath(path);
    const ws: any = this.app.workspace as any;
    const leaves = [...(ws.getLeavesOfType?.(VIEW_TYPE_KNOWLEDGE) ?? []), ...(ws.getLeavesOfType?.(VIEW_TYPE_KNOWLEDGE_PANEL) ?? [])];
    if (leaves.length) {
      ws.revealLeaf(leaves[0]);
      const v = leaves[0]?.view as any;
      if (v && typeof v.refresh === "function") v.refresh();
      return;
    }
    const open = (this.plugin as any).activateKnowledgeView;
    if (typeof open === "function") await open.call(this.plugin);
  }

  private async gotoOutputPath(path: string): Promise<void> {
    (this.plugin as any).__rslatteOutputFocusPath = normalizePath(path);
    const ws: any = this.app.workspace as any;
    const leaves = ws.getLeavesOfType?.(VIEW_TYPE_OUTPUTS) ?? [];
    if (leaves.length) {
      ws.revealLeaf(leaves[0]);
      const v = leaves[0]?.view as any;
      if (v && typeof v.refresh === "function") v.refresh();
      return;
    }
    const open = (this.plugin as any).activateOutputPanelView;
    if (typeof open === "function") await open.call(this.plugin);
  }

  private async markKnowledgeRead(file: TFile): Promise<void> {
    const today = ymdToday();
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      const obj = fm as Record<string, unknown>;
      const prev = parseRecentReadDates(obj[KNOWLEDGE_REC_READ_KEY]);
      const merged = [today, ...prev.filter((d) => d !== today)].slice(0, 3);
      obj[KNOWLEDGE_REC_READ_KEY] = merged;
    });
    try {
      await upsertKnowledgeIndexItemByFile(this.plugin, file);
    } catch (e) {
      console.warn("[RSLatte] markKnowledgeRead upsertKnowledgeIndexItemByFile failed", e);
    }
    new Notice(`已记录阅读：${file.basename}`);
    void this.render();
  }

  private copyKnowledgeOutputId(m: KnowledgeFileMeta): void {
    const oid = String(m.outputId ?? "").trim();
    if (!oid) {
      new Notice("该文档没有 output_id");
      return;
    }
    const nav: any = navigator as any;
    const write = nav?.clipboard?.writeText;
    if (typeof write !== "function") {
      new Notice(`output_id：${oid}`);
      return;
    }
    void write.call(nav.clipboard, oid)
      .then(() => new Notice(`已复制 output_id：${oid}`))
      .catch(() => new Notice(`output_id：${oid}`));
  }

  private renderKnowledgeTimelineRow(
    parent: HTMLElement,
    m: KnowledgeFileMeta,
    rootNorm: string,
    isFocus = false,
    opts?: { showReadBtn?: boolean; showCopyIdBtn?: boolean },
  ) {
    const row = parent.createDiv({ cls: "rslatte-timeline-item rslatte-knowledge-timeline-item" });
    row.tabIndex = 0;
    const gutter = row.createDiv({ cls: "rslatte-timeline-gutter" });
    const dot = gutter.createDiv({ cls: "rslatte-timeline-dot" });
    dot.setText(pickDotSymbol(m.publishedYmd, m.readDates));
    gutter.createDiv({ cls: "rslatte-timeline-line" });

    const content = row.createDiv({ cls: "rslatte-timeline-content" });
    const titleRow = content.createDiv({ cls: "rslatte-timeline-title-row" });
    titleRow.createDiv({ cls: "rslatte-timeline-text", text: m.file.basename });
    const actions = titleRow.createDiv({ cls: "rslatte-output-actions" });
    if (opts?.showReadBtn) {
      const readBtn = actions.createEl("button", { text: "👁‍🗨", cls: "rslatte-text-btn" });
      readBtn.title = "已读";
      readBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        void this.markKnowledgeRead(m.file);
      };
    }
    const infoBtn = actions.createEl("button", { text: "📋", cls: "rslatte-text-btn" });
    infoBtn.title = "基础信息";
    infoBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.openDocInfoModal(m.file.path);
    };
    if (opts?.showCopyIdBtn) {
      const copyBtn = actions.createEl("button", { text: "🔗", cls: "rslatte-text-btn" });
      copyBtn.title = "复制 output_id";
      copyBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.copyKnowledgeOutputId(m);
      };
    }

    const tagsRow = content.createDiv({ cls: "rslatte-output-tags-row" });
    const publishedSpaceId = String(m.fm.published_space_id ?? "").trim();
    const spaces = (((this.plugin.settings as any)?.spaces ?? {}) as Record<string, { name?: string }>);
    const spaceName = String(spaces[publishedSpaceId]?.name ?? "").trim() || (publishedSpaceId ? publishedSpaceId : "默认空间");
    tagsRow.createSpan({ cls: "rslatte-output-tag rslatte-output-tag-space", text: spaceName });
    const kind = String(m.fm.output_document_kind ?? "").trim() === "project" ? "项目" : "一般";
    tagsRow.createSpan({ cls: "rslatte-output-tag rslatte-output-tag-kind", text: kind });
    for (const d of fmDomains(m.fm)) {
      tagsRow.createSpan({ cls: "rslatte-output-tag rslatte-output-tag-domain", text: d });
    }
    const docCategory = fmDocCategory(m.fm);
    if (docCategory) tagsRow.createSpan({ cls: "rslatte-output-tag rslatte-output-tag-doccat", text: docCategory });

    const meta = content.createDiv({ cls: "rslatte-timeline-meta" });
    const recentReadText = m.readDates.length ? `最近阅读 ${m.readDates.join(" / ")}` : "最近阅读 无";
    meta.setText(`发布 ${m.publishedYmd} · ${recentReadText}`);
    content.createDiv({ cls: "rslatte-timeline-from", text: displayKnowledgeFromPath(m.file.path, rootNorm) });

    if (isFocus) {
      row.addClass("rslatte-knowledge-focus-highlight");
      requestAnimationFrame(() => row.scrollIntoView({ behavior: "smooth", block: "center" }));
    }

    this.attachRowOpenHandlers(row, m.file.path);
  }

  private renderRandomTab(content: HTMLElement, rootNorm: string, metas: KnowledgeFileMeta[]) {
    content.createDiv({ cls: "rslatte-knowledge-section-title", text: "随便看看（推荐 3 篇）" });
    if (!metas.length) {
      content.createDiv({ cls: "rslatte-muted", text: "当前知识库暂无文档。" });
      return;
    }
    const today = ymdToday();
    // 当天推荐名单固定：点已看后保留在名单中，只隐藏眼睛按钮；次日再重算 3 篇
    if (this._dailyRecDay !== today || this._dailyRecPaths.length === 0) {
      const scored = metas.map((m) => {
        const publishDays = daysSinceYmd(m.publishedYmd);
        const lastReadDays = m.readDates.length ? Math.min(...m.readDates.map(daysSinceYmd)) : 9999;
        const unreadBoost = m.readDates.length ? 0 : 80;
        const freshnessBoost = Math.max(0, 60 - publishDays) * 1.2;
        const longNotReadBoost = Math.min(lastReadDays, 120) * 0.8;
        const overReadPenalty = m.readDates.length >= 3 && lastReadDays <= 7 ? 30 : 0;
        const score = unreadBoost + freshnessBoost + longNotReadBoost - overReadPenalty;
        return { m, score };
      });
      scored.sort((a, b) => b.score - a.score || b.m.file.stat.mtime - a.m.file.stat.mtime);
      this._dailyRecDay = today;
      this._dailyRecPaths = scored.slice(0, 3).map((x) => normalizePath(x.m.file.path));
    }
    const byPath = new Map<string, KnowledgeFileMeta>();
    for (const m of metas) byPath.set(normalizePath(m.file.path), m);
    let top = this._dailyRecPaths
      .map((p) => byPath.get(p))
      .filter((x): x is KnowledgeFileMeta => !!x)
      .slice(0, 3);
    if (top.length === 0) {
      // 非递归兜底：避免极端场景下重复递归导致堆栈溢出
      const fallback = metas.slice().sort((a, b) => b.file.stat.mtime - a.file.stat.mtime).slice(0, 3);
      top = fallback;
      this._dailyRecDay = today;
      this._dailyRecPaths = fallback.map((m) => normalizePath(m.file.path));
    }
    const list = content.createDiv({ cls: "rslatte-timeline" });
    for (const m of top) {
      const readToday = m.readDates.includes(today);
      this.renderKnowledgeTimelineRow(list, m, rootNorm, false, { showReadBtn: !readToday, showCopyIdBtn: true });
    }
    content.createDiv({
      cls: "rslatte-muted rslatte-knowledge-subhint",
      text: "当天固定推荐 3 篇：点击已看仅隐藏眼睛按钮；次日按前一日阅读记录重新计算推荐。",
    });
  }

  private renderOverviewTab(content: HTMLElement, metas: KnowledgeFileMeta[], rootNorm: string, outputItems: any[]) {
    content.createDiv({ cls: "rslatte-knowledge-section-title", text: "知识库概览" });
    const total = metas.length;
    const recentPub = metas.filter((m) => daysSinceYmd(m.publishedYmd) <= 30).length;
    const recentRead = metas.filter((m) => hasRecentReadWithinDays(m.readDates, 30)).length;
    const unread = metas.filter((m) => !m.readDates.length).length;
    const stale = metas.filter((m) => daysSinceYmd(m.publishedYmd) > 30 && !hasRecentReadWithinDays(m.readDates, 30)).length;
    const byL1 = new Map<string, number>();
    for (const m of metas) byL1.set(m.l1, (byL1.get(m.l1) ?? 0) + 1);
    const l1Summary = [...byL1.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

    const card = content.createDiv({ cls: "rslatte-knowledge-overview-card" });
    card.createDiv({ cls: "rslatte-knowledge-overview-item", text: `文档总数：${total}` });
    card.createDiv({ cls: "rslatte-knowledge-overview-item", text: `近 30 天发布：${recentPub}` });
    card.createDiv({ cls: "rslatte-knowledge-overview-item", text: `近 30 天阅读：${recentRead}` });
    card.createDiv({ cls: "rslatte-knowledge-overview-item", text: `从未阅读：${unread}` });
    card.createDiv({ cls: "rslatte-knowledge-overview-item", text: `超 30 天且近 30 天未读：${stale}` });
    if (l1Summary.length) {
      const line = l1Summary.map(([k, v]) => `${k}: ${v}`).join(" · ");
      content.createDiv({ cls: "rslatte-muted rslatte-knowledge-subhint", text: `一级目录分布：${line}` });
    }

    const trends = this.computeWeeklyTrends(metas, outputItems);
    this.renderSimpleLineChart(
      content,
      "最近24周：新增 / 完成 / 发布 文档数",
      [
        { name: "新增", color: "#409eff", values: trends.map((x) => x.created) },
        { name: "完成", color: "#67c23a", values: trends.map((x) => x.done) },
        { name: "发布", color: "#e6a23c", values: trends.map((x) => x.published) },
      ],
      trends.map((x) => x.weekLabel),
    );
    this.renderSimpleLineChart(
      content,
      "最近24周：发布文档 word_count 总数",
      [{ name: "word_count", color: "#f56c6c", values: trends.map((x) => x.publishedWordCount) }],
      trends.map((x) => x.weekLabel),
    );

    const domainStats = new Map<string, { written: number; published: number; lastWriteDay: number; lastPublishDay: number }>();
    for (const it of outputItems) {
      const fmDomains = ((it as any).domains ?? []) as string[];
      const createYmd = parseYmdLoose((it as any).createDate);
      const writeDay = createYmd ? daysSinceYmd(createYmd) : 9999;
      for (const d of fmDomains) {
        const s = domainStats.get(d) ?? { written: 0, published: 0, lastWriteDay: 9999, lastPublishDay: 9999 };
        s.written += 1;
        s.lastWriteDay = Math.min(s.lastWriteDay, writeDay);
        domainStats.set(d, s);
      }
    }
    for (const m of metas) {
      const ds = fmDomains(m.fm);
      const pd = daysSinceYmd(m.publishedYmd);
      for (const d of ds) {
        const s = domainStats.get(d) ?? { written: 0, published: 0, lastWriteDay: 9999, lastPublishDay: 9999 };
        s.published += 1;
        s.lastPublishDay = Math.min(s.lastPublishDay, pd);
        domainStats.set(d, s);
      }
    }
    const domainRows = [...domainStats.entries()].map(([domain, s]) => ({
      domain,
      ...s,
      gap: s.written - s.published,
      ratio: s.written > 0 ? s.published / s.written : 0,
    }));
    domainRows.sort((a, b) => b.published - a.published || b.written - a.written);
    const activeTop = domainRows.slice(0, 5).map((x) => `${x.domain}（发布${x.published}/写作${x.written}）`).join(" · ") || "（暂无）";
    const writeMorePublishLess = [...domainRows]
      .filter((x) => x.written >= 2 && x.ratio < 0.5)
      .sort((a, b) => b.gap - a.gap)
      .slice(0, 5)
      .map((x) => `${x.domain}（差值${x.gap}）`)
      .join(" · ") || "（暂无）";
    const staleWrite = [...domainRows].filter((x) => x.lastWriteDay >= 56).sort((a, b) => b.lastWriteDay - a.lastWriteDay).slice(0, 5).map((x) => `${x.domain}（${x.lastWriteDay}天）`).join(" · ") || "（暂无）";
    const stalePub = [...domainRows].filter((x) => x.lastPublishDay >= 56).sort((a, b) => b.lastPublishDay - a.lastPublishDay).slice(0, 5).map((x) => `${x.domain}（${x.lastPublishDay}天）`).join(" · ") || "（暂无）";
    const insight = content.createDiv({ cls: "rslatte-knowledge-overview-insight" });
    insight.createDiv({ text: `近期最活跃领域：${activeTop}` });
    insight.createDiv({ text: `写得多但发得少：${writeMorePublishLess}` });
    insight.createDiv({ text: `长期没有输出（>=8周）：${staleWrite}` });
    insight.createDiv({ text: `长期没有沉淀（>=8周）：${stalePub}` });

    const domainCloudTitle = content.createEl("h4", { text: "领域标签云", cls: "rslatte-knowledge-overview-subtitle" });
    void domainCloudTitle;
    const cloud = content.createDiv({ cls: "rslatte-publish-wordcloud" });
    const domainCounts = new Map<string, number>();
    for (const m of metas) for (const d of fmDomains(m.fm)) domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1);
    const domains = [...domainCounts.entries()].sort((a, b) => b[1] - a[1]);
    if (!domains.length) {
      cloud.createDiv({ cls: "rslatte-muted", text: "（暂无领域）" });
      return;
    }
    for (const [d, c] of domains) {
      const tag = cloud.createEl("span", { cls: "rslatte-publish-domain-tag", text: `${d} (${c})` });
      tag.style.fontSize = `${Math.min(18, 11 + c * 1.5)}px`;
      if (this._overviewDomain === d) tag.addClass("rslatte-publish-domain-tag-active");
      tag.onclick = () => {
        this._preserveScrollOnNextRender = true;
        this._overviewDomain = this._overviewDomain === d ? "" : d;
        this._overviewCategory = "";
        void this.render();
      };
    }
    if (!this._overviewDomain) return;

    const catsMap = new Map<string, number>();
    for (const m of metas) {
      const ds = fmDomains(m.fm);
      if (!ds.includes(this._overviewDomain)) continue;
      const cat = fmDocCategory(m.fm) || "未分类";
      catsMap.set(cat, (catsMap.get(cat) ?? 0) + 1);
    }
    content.createEl("h4", { text: `文档分类标签云（${this._overviewDomain}）`, cls: "rslatte-knowledge-overview-subtitle" });
    const catCloud = content.createDiv({ cls: "rslatte-publish-wordcloud" });
    for (const [cat, cnt] of [...catsMap.entries()].sort((a, b) => b[1] - a[1])) {
      const tag = catCloud.createEl("span", { cls: "rslatte-publish-domain-tag", text: `${cat} (${cnt})` });
      if (this._overviewCategory === cat) tag.addClass("rslatte-publish-domain-tag-active");
      tag.onclick = () => {
        this._preserveScrollOnNextRender = true;
        this._overviewCategory = this._overviewCategory === cat ? "" : cat;
        void this.render();
      };
    }
    if (!this._overviewCategory) return;

    const currentSpaceId = String(this.plugin.getCurrentSpaceId?.() ?? "").trim();
    const items: MixedDocItem[] = [];
    for (const m of metas) {
      const ds = fmDomains(m.fm);
      if (!ds.includes(this._overviewDomain)) continue;
      const cat = fmDocCategory(m.fm) || "未分类";
      if (cat !== this._overviewCategory) continue;
      const sid = String(m.fm.published_space_id ?? "").trim();
      const sname = String(this.plugin.getSpaceConfig?.(sid)?.name ?? (sid ? sid : "默认空间"));
      items.push({
        source: "knowledge",
        path: m.file.path,
        title: m.file.basename,
        dirLabel: this.knowledgeDirL1L2(m.file.path, rootNorm),
        outputKind: String(m.fm.output_document_kind ?? "general"),
        status: "",
        spaceId: sid,
        spaceName: sname,
        mtimeMs: m.file.stat.mtime,
      });
    }
    for (const it of outputItems) {
      const ds = ((it as any).domains ?? []) as string[];
      if (!ds.includes(this._overviewDomain)) continue;
      const cat = String((it as any).docCategory ?? "").trim() || "未分类";
      if (cat !== this._overviewCategory) continue;
      const path = String((it as any).filePath ?? "").trim();
      if (!path) continue;
      const sname = String(this.plugin.getSpaceConfig?.(currentSpaceId)?.name ?? "默认空间");
      items.push({
        source: "output",
        path,
        title: String((it as any).title ?? "").trim() || path.split("/").pop() || "未命名",
        dirLabel: this.outputDirAfterNotes(path),
        outputKind: String((it as any).outputDocumentKind ?? "general"),
        status: String((it as any).status ?? "").trim(),
        spaceId: currentSpaceId,
        spaceName: sname,
        mtimeMs: Number((it as any).mtimeMs ?? 0),
      });
    }
    items.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const list = content.createDiv({ cls: "rslatte-knowledge-overview-list" });
    for (const it of items) {
      const row = list.createDiv({ cls: "rslatte-knowledge-overview-item2" });
      const line1 = row.createDiv({ cls: "rslatte-knowledge-overview-line1" });
      line1.createSpan({ cls: "rslatte-knowledge-chip", text: it.source === "knowledge" ? "知识" : "输出" });
      const titleEl = line1.createSpan({ cls: "rslatte-knowledge-overview-title", text: it.title });
      const dirEl = line1.createSpan({ cls: "rslatte-knowledge-overview-dir", text: it.dirLabel });
      const line2 = row.createDiv({ cls: "rslatte-knowledge-overview-line2" });
      line2.createSpan({ cls: "rslatte-knowledge-chip", text: it.outputKind === "project" ? "项目" : "一般" });
      if (it.source === "output" && it.status) line2.createSpan({ cls: "rslatte-knowledge-chip", text: `状态:${it.status}` });
      line2.createSpan({ cls: "rslatte-knowledge-chip", text: `空间:${it.spaceName}` });
      const hoverText = [
        `来源：${it.source === "knowledge" ? "知识" : "输出"}`,
        `文件名：${it.title}`,
        `目录：${it.dirLabel}`,
        `类型：${it.outputKind === "project" ? "项目" : "一般"}`,
        it.source === "output" ? `状态：${it.status || "（空）"}` : "",
        `空间：${it.spaceName}`,
        `路径：${it.path}`,
      ].filter(Boolean).join("\n");
      row.title = hoverText;
      titleEl.title = hoverText;
      dirEl.title = hoverText;
      row.style.cursor = "pointer";
      row.onclick = () => {
        if (it.source === "knowledge") {
          void this.gotoKnowledgePath(it.path);
          return;
        }
        if (it.spaceId && it.spaceId !== currentSpaceId) {
          new Notice(`请切换到「${it.spaceName}」空间查看该输出`);
          return;
        }
        void this.gotoOutputPath(it.path);
      };
    }
  }

  private renderLibraryTab(content: HTMLElement, rootNorm: string, metas: KnowledgeFileMeta[], focusPath?: string) {
    if (!metas.length) {
      content.createDiv({ cls: "rslatte-muted", text: "该目录下暂无 Markdown 文件。" });
      return;
    }
    const listActions = content.createDiv({ cls: "rslatte-task-actions" });
    const expandAllBtn = listActions.createEl("button", { text: "全部展开", cls: "rslatte-text-btn" });
    expandAllBtn.onclick = () => {
      const l1Set = new Set<string>();
      const l2Set = new Set<string>();
      for (const m of metas) {
        l1Set.add(`l1:${m.l1}`);
        l2Set.add(`l2:${m.l1}/${m.l2}`);
      }
      for (const k of l1Set) this._l1Collapsed.set(k, false);
      for (const k of l2Set) this._l2Collapsed.set(k, false);
      void this.render();
    };
    const collapseAllBtn = listActions.createEl("button", { text: "全部折叠", cls: "rslatte-text-btn" });
    collapseAllBtn.onclick = () => {
      const l1Set = new Set<string>();
      const l2Set = new Set<string>();
      for (const m of metas) {
        l1Set.add(`l1:${m.l1}`);
        l2Set.add(`l2:${m.l1}/${m.l2}`);
      }
      for (const k of l1Set) this._l1Collapsed.set(k, true);
      for (const k of l2Set) this._l2Collapsed.set(k, true);
      void this.render();
    };
    const g1 = new Map<string, Map<string, KnowledgeFileMeta[]>>();
    for (const m of metas) {
      if (!g1.has(m.l1)) g1.set(m.l1, new Map());
      const g2 = g1.get(m.l1)!;
      if (!g2.has(m.l2)) g2.set(m.l2, []);
      g2.get(m.l2)!.push(m);
    }
    if (focusPath) {
      const hit = metas.find((m) => normalizePath(m.file.path) === normalizePath(focusPath));
      if (hit) {
        this._l1Collapsed.set(`l1:${hit.l1}`, false);
        this._l2Collapsed.set(`l2:${hit.l1}/${hit.l2}`, false);
      }
    }
    const l1Names = [...g1.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    for (const l1 of l1Names) {
      const l1Key = `l1:${l1}`;
      const l1Collapsed = this._l1Collapsed.get(l1Key) ?? false;
      const l2Map = g1.get(l1)!;
      const l1Count = [...l2Map.values()].reduce((acc, arr) => acc + arr.length, 0);

      const sec = content.createDiv({ cls: "rslatte-section rslatte-project-section" });
      const h1 = sec.createDiv({ cls: "rslatte-output-list-header" });
      const left = h1.createDiv({ cls: "rslatte-output-list-header-left" });
      left.createSpan({ cls: "rslatte-output-list-toggle", text: l1Collapsed ? "▶" : "▼" });
      left.createSpan({ cls: "rslatte-output-list-title", text: l1 });
      h1.createSpan({ cls: "rslatte-output-list-count", text: String(l1Count) });
      h1.style.cursor = "pointer";
      h1.onclick = () => {
        this._l1Collapsed.set(l1Key, !l1Collapsed);
        void this.render();
      };
      const l1Body = sec.createDiv({ cls: "rslatte-output-list-body" });
      if (l1Collapsed) {
        l1Body.style.display = "none";
        continue;
      }

      const l2Names = [...l2Map.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
      for (const l2 of l2Names) {
        const arr = l2Map.get(l2)!;
        const l2Key = `l2:${l1}/${l2}`;
        const l2Collapsed = this._l2Collapsed.get(l2Key) ?? false;
        const sec2 = l1Body.createDiv({ cls: "rslatte-knowledge-l2-wrap" });
        const h2 = sec2.createDiv({ cls: "rslatte-output-list-header rslatte-knowledge-l2-header" });
        const left2 = h2.createDiv({ cls: "rslatte-output-list-header-left" });
        left2.createSpan({ cls: "rslatte-output-list-toggle", text: l2Collapsed ? "▶" : "▼" });
        left2.createSpan({ cls: "rslatte-output-list-title", text: l2 });
        h2.createSpan({ cls: "rslatte-output-list-count", text: String(arr.length) });
        h2.style.cursor = "pointer";
        h2.onclick = () => {
          this._l2Collapsed.set(l2Key, !l2Collapsed);
          void this.render();
        };
        const l2Body = sec2.createDiv({ cls: "rslatte-output-list-body" });
        if (l2Collapsed) {
          l2Body.style.display = "none";
          continue;
        }
        const list = l2Body.createDiv({ cls: "rslatte-timeline" });
        for (const m of arr) {
          const isFocus = !!focusPath && normalizePath(m.file.path) === normalizePath(focusPath);
          this.renderKnowledgeTimelineRow(list, m, rootNorm, isFocus, { showReadBtn: false, showCopyIdBtn: true });
        }
      }
    }
  }

  private async render() {
    const seq = ++this._renderSeq;
    const container = this.containerEl.children[1] as HTMLElement;
    const preserveScroll = this._preserveScrollOnNextRender;
    const prevScrollTop = preserveScroll ? container.scrollTop : 0;
    this._preserveScrollOnNextRender = false;
    container.empty();
    container.addClass("rslatte-knowledge-view");
    try {
      const pendingFocusPathRaw = String((this.plugin as any).__rslatteKnowledgeFocusPath ?? "").trim();
      const pendingFocusPath = pendingFocusPathRaw ? normalizePath(pendingFocusPathRaw) : "";
      if (pendingFocusPath) this._tab = "library";

      const header = container.createDiv({ cls: "rslatte-knowledge-header" });
      const headerTop = header.createDiv({ cls: "rslatte-section-title-row" });
      headerTop.createEl("h3", { text: "Knowledge" });
      const headerActions = headerTop.createDiv({ cls: "rslatte-task-actions" });
      const refreshBtn = headerActions.createEl("button", { text: "🔄", cls: "rslatte-icon-btn" });
      refreshBtn.title = "刷新知识索引";
      refreshBtn.onclick = () => void this.refreshKnowledgeIndex();
      const rebuildBtn = headerActions.createEl("button", { text: "🧱", cls: "rslatte-icon-btn" });
      rebuildBtn.title = "扫描重建知识索引（全量）";
      rebuildBtn.onclick = () => void this.rebuildKnowledgeIndex();

      const tabs = container.createDiv({ cls: "rslatte-knowledge-tabs" });
      const tabList: { id: KnowledgeTab; label: string }[] = [
        { id: "random", label: "随便看看" },
        { id: "overview", label: "知识库概览" },
        { id: "library", label: "知识库清单" },
      ];
      for (const { id, label } of tabList) {
        const btn = tabs.createEl("button", { text: label, cls: "rslatte-knowledge-tab" });
        if (this._tab === id) btn.addClass("is-active");
        btn.onclick = () => {
          this._tab = id;
          void this.render();
        };
      }

      const rootRel = resolveKnowledgeLibraryRootRel(this.plugin.settings);
      const rootNorm = normalizePath(rootRel);
      const [indexDocShared, outSnapShared] = await Promise.all([
        tryReadKnowledgeIndexJson(this.plugin),
        this.plugin.outputRSLatte?.getSnapshot?.() ?? Promise.resolve(undefined),
      ]);
      if (seq !== this._renderSeq) return;

      const outs = (outSnapShared?.items ?? []) as any[];
      void indexDocShared;

      const content = container.createDiv({ cls: "rslatte-knowledge-content" });
      const rootAf = tryGetFolderByPathLoose(this.app, rootNorm);
      if (!(rootAf instanceof TFolder)) {
        content.createDiv({
          cls: "rslatte-muted",
          text: `未找到知识库文件夹，请确认 V2 目录或设置中的库根。期望路径：${rootNorm}`,
        });
        return;
      }
      const metas = this.collectKnowledgeMetas(rootAf, rootNorm);
      if (seq !== this._renderSeq) return;

      if (this._tab === "random") {
        this.renderRandomTab(content, rootNorm, metas);
        return;
      }
      if (this._tab === "overview") {
        this.renderOverviewTab(content, metas, rootNorm, outs);
        return;
      }
      this.renderLibraryTab(content, rootNorm, metas, pendingFocusPath || undefined);
      if (pendingFocusPath) (this.plugin as any).__rslatteKnowledgeFocusPath = "";
    } catch (e) {
      console.error("[RSLatte][KnowledgeView] render failed", e);
      container.empty();
      container.addClass("rslatte-knowledge-view");
      container.createDiv({ cls: "rslatte-muted", text: "Knowledge 视图渲染失败，请点击右上角刷新重试。" });
    } finally {
      if (preserveScroll) {
        requestAnimationFrame(() => {
          container.scrollTop = prevScrollTop;
        });
      }
    }
  }

  public refresh() {
    void this.render();
  }
}
