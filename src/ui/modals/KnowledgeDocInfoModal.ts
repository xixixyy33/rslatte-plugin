import { App, Modal, Notice, normalizePath, Setting, TFile } from "obsidian";

import type RSLattePlugin from "../../main";
import {
  canonicalLedgerPathKey,
  readMergedOutputLedgerMaps,
} from "../../outputRSLatte/outputHistoryLedger";
import type { OutputHistoryEvent, OutputLedgerKnowledgeEntry, OutputLedgerSourcePathEntry } from "../../types/outputHistoryTypes";

const PREFERRED_FM_KEYS = [
  "title",
  "output_id",
  "knowledge_bucket",
  "published_at",
  "source_output_path",
  "summary",
  "tags",
  "project_id",
  "project_name",
  "文档分类",
  "doc_category",
  "type",
  "output_document_kind",
  "create",
  "领域",
  "domains",
  "done_time",
  "done",
] as const;

const FM_LABELS_ZH: Record<string, string> = {
  title: "标题",
  output_id: "输出ID",
  knowledge_bucket: "知识分区",
  published_at: "发布时间",
  published_space_id: "发布空间ID",
  published_space_name: "发布空间名",
  source_output_path: "源输出路径",
  summary: "摘要",
  tags: "标签",
  project_id: "项目ID",
  project_name: "项目名称",
  doc_category: "文档分类",
  文档分类: "文档分类",
  type: "类型",
  output_document_kind: "输出文档类型",
  create: "创建日期",
  domains: "领域",
  domain: "领域",
  领域: "领域",
  done_time: "完成时间",
  done: "完成日期",
  status: "状态",
  resume_at: "恢复日期",
};

function canonicalFmKey(k: string): string {
  const s = String(k ?? "").trim();
  if (!s) return s;
  if (s === "doc_category" || s === "文档分类") return "文档分类";
  if (s === "domains" || s === "domain" || s === "领域") return "领域";
  if (s === "done" || s === "done_time") return "done_time";
  return s;
}

function fmLabelZh(k: string): string {
  const key = String(k ?? "").trim();
  const zh = FM_LABELS_ZH[key];
  return zh ? `${zh}（${key}）` : key;
}

function fmValueToString(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).join(", ");
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function actionLabelZh(action: string): string {
  switch (action) {
    case "publish_to_knowledge":
      return "发布到知识库";
    case "recall_from_knowledge":
      return "从知识库打回输出";
    case "output_created":
      return "创建输出稿";
    case "output_updated":
      return "知识库内编辑";
    case "output_archived_from_index":
      return "主索引归档迁出";
    case "output_status_changed":
      return "输出状态变更";
    default:
      return action;
  }
}

function eventDedupKey(ev: OutputHistoryEvent): string {
  return [
    ev.ts ?? "",
    ev.action ?? "",
    ev.knowledge_path ?? "",
    ev.source_output_path ?? "",
    ev.output_id ?? "",
    ev.copied_from_output_id ?? "",
    ev.mode ?? "",
    ev.knowledge_bucket ?? "",
    ev.archive_month_key ?? "",
    ev.note ?? "",
    ev.status_before ?? "",
    ev.status_after ?? "",
    ev.resume_at ?? "",
  ].join("||");
}

function collectSourcePathLedgerEvents(
  bySourceOutputPath: Map<string, OutputLedgerSourcePathEntry>,
  docPathNorm: string,
  fmSourceOutputPath: string,
): OutputHistoryEvent[] {
  const keys = new Set<string>();
  const addKey = (raw: string) => {
    const t = String(raw ?? "").trim();
    if (!t) return;
    keys.add(normalizePath(t));
    keys.add(canonicalLedgerPathKey(t));
  };
  addKey(docPathNorm);
  addKey(fmSourceOutputPath);
  const out: OutputHistoryEvent[] = [];
  for (const k of keys) {
    const ent = bySourceOutputPath.get(k);
    if (ent?.events?.length) out.push(...ent.events);
  }
  return out;
}

/**
 * 合并本篇知识路径台账与源输出台账：仅纳入与「当前 vault 路径 + frontmatter output_id」相关的行，
 * 避免同一源稿多次发布时多篇知识稿显示完全相同的历史。
 * 复制发布生成新 output_id 后，不会继承源稿上的工序/状态记录。
 */
function mergeLedgerDisplayEntryForKnowledgeDoc(
  docPathNorm: string,
  fmOutputId: string,
  kn: OutputLedgerKnowledgeEntry | undefined,
  srcEventsFlat: OutputHistoryEvent[],
): OutputLedgerKnowledgeEntry | undefined {
  const oidDoc = String(fmOutputId ?? "").trim();
  const p = canonicalLedgerPathKey(docPathNorm);

  const includeSrcEvent = (ev: OutputHistoryEvent): boolean => {
    switch (ev.action) {
      case "publish_to_knowledge": {
        const kp = canonicalLedgerPathKey(ev.knowledge_path ?? "");
        return !!kp && kp === p;
      }
      case "recall_from_knowledge": {
        const kp = canonicalLedgerPathKey(ev.knowledge_path ?? "");
        return !!kp && kp === p;
      }
      case "output_updated": {
        const kp = canonicalLedgerPathKey(ev.knowledge_path ?? "");
        return !!kp && kp === p;
      }
      case "output_status_changed":
      case "output_created":
      case "output_archived_from_index": {
        const eid = String(ev.output_id ?? "").trim();
        if (!oidDoc || !eid) return false;
        return eid === oidDoc;
      }
      default:
        return false;
    }
  };

  const evKn = kn?.events ?? [];
  const evSrc = srcEventsFlat.filter(includeSrcEvent);
  if (!evKn.length && !evSrc.length) return undefined;
  const dedup = new Map<string, OutputHistoryEvent>();
  for (const ev of [...evKn, ...evSrc]) {
    dedup.set(eventDedupKey(ev), ev);
  }
  const events = [...dedup.values()].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return {
    output_id: kn?.output_id || oidDoc,
    last_source_output_path: kn?.last_source_output_path,
    last_knowledge_path: kn?.last_knowledge_path,
    last_published_at: kn?.last_published_at,
    last_bucket: kn?.last_bucket,
    events,
  };
}

function renderFrontmatterSection(
  container: HTMLElement,
  fm: Record<string, unknown>,
  spaces?: Record<string, { name?: string }>,
): void {
  const wrap = container.createDiv({ cls: "rslatte-knowledge-doc-info-fm" });
  wrap.createEl("h4", { text: "摘要（Frontmatter）" });

  const preferred = new Set<string>(PREFERRED_FM_KEYS as unknown as string[]);
  const shownCanonical = new Set<string>();
  const rows: { k: string; v: string }[] = [];

  for (const k of PREFERRED_FM_KEYS) {
    if (!(k in fm)) continue;
    const s = fmValueToString(fm[k]).trim();
    if (!s) continue;
    const ck = canonicalFmKey(k);
    // done_time 存在时，done 视为冗余
    if (ck === "done_time" && k === "done" && "done_time" in fm) continue;
    if (shownCanonical.has(ck)) continue;
    shownCanonical.add(ck);
    rows.push({ k, v: s });
  }

  const restKeys = Object.keys(fm)
    .filter((k) => !preferred.has(k) && !k.startsWith("position"))
    .sort();
  for (const k of restKeys) {
    const s = fmValueToString(fm[k]).trim();
    if (!s) continue;
    const ck = canonicalFmKey(k);
    if (shownCanonical.has(ck)) continue;
    shownCanonical.add(ck);
    rows.push({ k, v: s });
  }

  if (!rows.length) {
    wrap.createDiv({ cls: "rslatte-muted", text: "（无 frontmatter 或尚未解析）" });
    return;
  }

  // 补充：发布空间名（由 published_space_id 映射）
  if (!("published_space_name" in fm) && "published_space_id" in fm) {
    const sid = String(fm.published_space_id ?? "").trim();
    const sname = String(spaces?.[sid]?.name ?? "").trim();
    if (sid && sname) rows.push({ k: "published_space_name", v: sname });
  }

  const dl = wrap.createEl("dl", { cls: "rslatte-knowledge-doc-info-dl" });
  for (const { k, v } of rows) {
    dl.createEl("dt", { text: fmLabelZh(k) });
    const dd = dl.createEl("dd", { cls: "rslatte-knowledge-doc-info-dd" });
    dd.setText(v.length > 500 ? `${v.slice(0, 500)}…` : v);
  }
}

function renderLedgerSection(
  container: HTMLElement,
  entry: OutputLedgerKnowledgeEntry | undefined,
): void {
  const wrap = container.createDiv({ cls: "rslatte-knowledge-doc-info-ledger" });
  wrap.createEl("h4", { text: "输出台账（.history）" });

  if (!entry || !entry.events?.length) {
    wrap.createDiv({
      cls: "rslatte-muted",
      text: "暂无台账记录（创建输出、发布到知识库、打回、主索引归档等成功后会逐步写入）。",
    });
    return;
  }

  const meta = wrap.createDiv({ cls: "rslatte-knowledge-doc-info-ledger-meta rslatte-muted" });
  const parts: string[] = [];
  if (entry.output_id) parts.push(`output_id: ${entry.output_id}`);
  if (entry.last_source_output_path) parts.push(`源输出: ${entry.last_source_output_path}`);
  if (entry.last_published_at) parts.push(`最近发布: ${entry.last_published_at}`);
  if (entry.last_bucket) parts.push(`bucket: ${entry.last_bucket}`);
  meta.setText(parts.join(" · "));

  const list = wrap.createDiv({ cls: "rslatte-knowledge-doc-info-events" });
  const events = [...entry.events].sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  for (const ev of events) {
    renderOneEvent(list, ev);
  }
}

function renderOneEvent(list: HTMLElement, ev: OutputHistoryEvent): void {
  const row = list.createDiv({ cls: "rslatte-knowledge-doc-info-event" });

  const head = row.createDiv({ cls: "rslatte-knowledge-doc-info-event-head" });
  head.createSpan({ cls: "rslatte-knowledge-doc-info-event-ts", text: ev.ts });
  head.createSpan({ cls: "rslatte-knowledge-doc-info-event-action", text: actionLabelZh(ev.action) });

  if (ev.source_output_path) {
    row.createDiv({ cls: "rslatte-muted rslatte-knowledge-doc-info-event-line", text: `源输出：${ev.source_output_path}` });
  }
  if (ev.mode) {
    row.createDiv({ cls: "rslatte-muted rslatte-knowledge-doc-info-event-line", text: `方式：${ev.mode === "move" ? "移动" : "复制"}` });
  }
  if (ev.knowledge_bucket) {
    row.createDiv({ cls: "rslatte-muted rslatte-knowledge-doc-info-event-line", text: `分区：${ev.knowledge_bucket}` });
  }
  if (ev.copied_from_output_id) {
    row.createDiv({
      cls: "rslatte-muted rslatte-knowledge-doc-info-event-line",
      text: `复制溯源 output_id：${ev.copied_from_output_id}`,
    });
  }
  if (ev.status_before != null && String(ev.status_before).length) {
    row.createDiv({
      cls: "rslatte-muted rslatte-knowledge-doc-info-event-line",
      text: `状态：${ev.status_before} → ${ev.status_after ?? "（空）"}`,
    });
  } else if (ev.status_after != null && String(ev.status_after).length) {
    row.createDiv({ cls: "rslatte-muted rslatte-knowledge-doc-info-event-line", text: `状态：${ev.status_after}` });
  }
  if (ev.resume_at) {
    row.createDiv({ cls: "rslatte-muted rslatte-knowledge-doc-info-event-line", text: `恢复日 resume_at：${ev.resume_at}` });
  }
  if (ev.archive_month_key) {
    row.createDiv({ cls: "rslatte-muted rslatte-knowledge-doc-info-event-line", text: `归档月份：${ev.archive_month_key}` });
  }
  if (ev.note) {
    row.createDiv({ cls: "rslatte-muted rslatte-knowledge-doc-info-event-line", text: `备注：${ev.note}` });
  }
  const snap = ev.pre_publish_fm_snapshot;
  if (snap && Object.keys(snap).length) {
    const pre = row.createEl("details", { cls: "rslatte-knowledge-doc-info-snap" });
    pre.createEl("summary", { text: "发布前输出稿快照（部分键）" });
    const preTxt = pre.createEl("pre", { cls: "rslatte-knowledge-doc-info-pre" });
    try {
      preTxt.setText(JSON.stringify(snap, null, 2));
    } catch {
      preTxt.setText(String(snap));
    }
  }
}

/**
 * 展示知识库（或任意 md）文档的基础信息：当前 frontmatter + 输出 `.history` 台账中与该路径关联的记录。
 */
export class KnowledgeDocInfoModal extends Modal {
  constructor(app: App, private plugin: RSLattePlugin, private filePath: string) {
    super(app);
  }

  onOpen(): void {
    const af = this.app.vault.getAbstractFileByPath(this.filePath);
    if (!(af instanceof TFile)) {
      new Notice("未找到文件：" + this.filePath);
      this.close();
      return;
    }

    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("rslatte-knowledge-doc-info-modal");

    this.titleEl.setText("文档基础信息");

    contentEl.createDiv({
      cls: "rslatte-muted rslatte-knowledge-doc-info-path",
      text: af.path,
    });

    const cache = this.app.metadataCache.getFileCache(af);
    const fm = { ...(cache?.frontmatter ?? {}) } as Record<string, unknown>;
    const spaces = (((this.plugin.settings as any)?.spaces ?? {}) as Record<string, { name?: string }>);
    renderFrontmatterSection(contentEl, fm, spaces);

    const ledgerHost = contentEl.createDiv();
    ledgerHost.createDiv({ cls: "rslatte-muted", text: "正在加载台账…" });

    new Setting(contentEl).addButton((b) => {
      b.setButtonText("关闭");
      b.onClick(() => this.close());
    });

    void readMergedOutputLedgerMaps(this.app, this.plugin.settings).then(({ byKnowledgePath, bySourceOutputPath }) => {
      const p = normalizePath(af.path);
      const kn =
        byKnowledgePath.get(p) ??
        byKnowledgePath.get(canonicalLedgerPathKey(p));
      const srcPathRaw = String(fm.source_output_path ?? "").trim();
      const srcEventsFlat = collectSourcePathLedgerEvents(bySourceOutputPath, p, srcPathRaw);
      const oidFm = String(fm.output_id ?? "").trim();
      const entry = mergeLedgerDisplayEntryForKnowledgeDoc(p, oidFm, kn, srcEventsFlat);
      ledgerHost.empty();
      renderLedgerSection(ledgerHost, entry);
    });
  }
}
