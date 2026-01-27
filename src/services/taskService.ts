import { App, TFile, moment } from "obsidian";
import type { ParsedTaskItem, TaskCategoryDef, TaskDateField, TaskPanelSettings, TaskTimeRangeDef } from "../types/taskTypes";

/**
 * 任务解析与筛选（不依赖第三方插件）。
 * 参考 Tasks 插件的常见标记：
 * - checkbox: - [ ] / - [x] / - [/] / - [-]
 * - dates: 📅 due, ⏳ scheduled, 🛫 start, ➕ created, ✅ done, ❌ cancelled
 */
export class TaskService {
  constructor(private app: App, private settings: TaskPanelSettings) { }

  setSettings(s: TaskPanelSettings) {
    this.settings = s;
  }

  /** 读取所有候选 md 文件（目录过滤 + tag 包含/排除） */
  private listCandidateFiles(): TFile[] {
    const folders = (this.settings.taskFolders ?? []).map(x => (x ?? "").trim()).filter(Boolean);
    const includeTags = this.normalizeTags(this.settings.includeTags ?? []);
    const excludeTags = this.normalizeTags(this.settings.excludeTags ?? []);

    const md = this.app.vault.getMarkdownFiles();
    const inFolders = (f: TFile) => {
      if (folders.length === 0) return true;
      const p = (f.path ?? "").replace(/\\/g, "/");
      return folders.some(dir => {
        const d = dir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
        return p === d || p.startsWith(d + "/");
      });
    };

    const tagOk = (f: TFile) => {
      if (includeTags.length === 0 && excludeTags.length === 0) return true;
      const cache = this.app.metadataCache.getFileCache(f);
      const tags = new Set<string>();
      const collect = (t?: string) => {
        if (!t) return;
        const tt = (t.startsWith("#") ? t.slice(1) : t).trim();
        if (tt) tags.add(tt);
      };

      // inline tags
      (cache?.tags ?? []).forEach(x => collect(x.tag));
      // frontmatter tags
      const fmTags = cache?.frontmatter?.tags;
      if (Array.isArray(fmTags)) fmTags.forEach(collect);
      else if (typeof fmTags === "string") fmTags.split(/[,\s]+/).forEach(collect);

      if (includeTags.length > 0) {
        const hit = includeTags.some(t => tags.has(t));
        if (!hit) return false;
      }
      if (excludeTags.length > 0) {
        const hit = excludeTags.some(t => tags.has(t));
        if (hit) return false;
      }
      return true;
    };

    return md.filter(f => inFolders(f) && tagOk(f));
  }

  private normalizeTags(tags: string[]): string[] {
    return (tags ?? []).map(x => (x ?? "").trim()).filter(Boolean).map(x => x.startsWith("#") ? x.slice(1) : x);
  }

  /** 将“今日/本周/本月/本季度”解析为 YYYY-MM-DD */
  private resolveDateToken(token: string): string | undefined {
    const t = (token ?? "").trim();
    if (!t) return undefined;

    // YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;

    const lower = t.toLowerCase();
    const momentFn = moment as any;
    const isToday = t === "今日" || t === "今天" || lower === "today";
    if (isToday) return momentFn().format("YYYY-MM-DD");

    const isWeek = t === "本周" || t === "本週" || lower === "this_week" || lower === "thisweek";
    if (isWeek) return momentFn().startOf("week").format("YYYY-MM-DD");

    const isMonth = t === "本月" || lower === "this_month" || lower === "thismonth";
    if (isMonth) return momentFn().startOf("month").format("YYYY-MM-DD");

    const isQuarter = t === "本季度" || lower === "this_quarter" || lower === "thisquarter";
    if (isQuarter) return momentFn().startOf("quarter").format("YYYY-MM-DD");

    return undefined;
  }

  /** 解析单行 task（返回 null 表示不是 task） */
  private parseTaskLine(line: string, filePath: string, lineNo: number): ParsedTaskItem | null {
    const m = /^\s*[-*]\s+\[(.{1})\]\s+(.*)$/.exec(line);
    if (!m) return null;

    const statusMark = (m[1] ?? "").slice(0, 1);
    const rawText = m[2] ?? "";

    // Dates (Tasks plugin style)
    const pick = (emoji: string): string | undefined => {
      // Use `u` flag for emoji safety
      const r = new RegExp(`${emoji}\\s*(\\d{4}-\\d{2}-\\d{2})`, "u");
      const mm = r.exec(rawText);
      return mm?.[1];
    };

    const due = pick("📅");
    const scheduled = pick("⏳");
    const start = pick("🛫");
    const created = pick("➕");
    const done = pick("✅");
    const cancelled = pick("❌");

    // remove known metadata tokens from display text
    let text = rawText;
    const metaTokens = ["📅", "⏳", "🛫", "➕", "✅", "❌", "🔁"];
    for (const e of metaTokens) {
      text = text.replace(new RegExp(`${e}\\s*\\d{4}-\\d{2}-\\d{2}`, "gu"), "");
    }
    // common priority emojis in Tasks plugin (ignore if present)
    text = text.replace(/\s*[⏫🔼🔽⏬]\s*/gu, " ");
    text = text.replace(/\s+/g, " ").trim();

    const statusName = this.mapStatus(statusMark, { done, cancelled });

    return {
      filePath,
      line: lineNo,
      rawLine: line,
      text,
      statusMark,
      statusName,
      due,
      scheduled,
      start,
      created,
      done,
      cancelled,
    };
  }

  private mapStatus(mark: string, dates: { done?: string; cancelled?: string }): ParsedTaskItem["statusName"] {
    const m = (mark ?? "").trim();
    if (m === "x" || m === "X") return "DONE";
    if (m === "/") return "IN_PROGRESS";
    if (m === "-") return "CANCELLED";
    if (m === "") return "TODO"; // [ ] gives space, but after trim it's ""
    // fallback using dates
    if (dates.cancelled) return "CANCELLED";
    if (dates.done) return "DONE";
    return "UNKNOWN";
  }

  private getFieldDate(t: ParsedTaskItem, field: TaskDateField): string | undefined {
    return (t as any)[field] as string | undefined;
  }

  private statusMatches(task: ParsedTaskItem, statuses: string[]): boolean {
    const wanted = (statuses ?? []).map(x => (x ?? "").trim()).filter(Boolean);
    if (wanted.length === 0) return true;

    const mark = (task.statusMark ?? "").trim();
    const name = (task.statusName ?? "UNKNOWN").toUpperCase();

    return wanted.some(s => {
      const ss = s.trim();
      if (!ss) return false;
      if (ss.length === 1) return ss === mark || (ss === " " && mark === "");
      return ss.toUpperCase() === name;
    });
  }

  private rangesMatch(task: ParsedTaskItem, ranges: TaskTimeRangeDef[]): boolean {
    const rs = (ranges ?? []).filter(Boolean);
    if (rs.length === 0) return true;

    for (const r of rs) {
      const left = this.getFieldDate(task, r.field);
      const right = this.resolveDateToken(r.value);
      if (!left || !right) return false; // 没有该时间字段就无法命中该过滤器

      // compare by YYYY-MM-DD string is safe for lexical compare
      const a = left;
      const b = right;
      switch (r.op) {
        case ">": if (!(a > b)) return false; break;
        case ">=": if (!(a >= b)) return false; break;
        case "<": if (!(a < b)) return false; break;
        case "<=": if (!(a <= b)) return false; break;
        default: return false;
      }
    }
    return true;
  }

  /** 查询某个分类下的任务 */
  async queryCategory(category: TaskCategoryDef): Promise<ParsedTaskItem[]> {
    const max = Math.min(Math.max(Number(category.maxItems || 0), 1), 30);

    const files = this.listCandidateFiles();
    const all: ParsedTaskItem[] = [];
    for (const f of files) {
      const text = await this.app.vault.read(f);
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const task = this.parseTaskLine(lines[i], f.path, i);
        if (!task) continue;
        if (!this.statusMatches(task, category.statuses ?? [])) continue;
        if (!this.rangesMatch(task, category.timeRanges ?? [])) continue;
        all.push(task);
      }
    }

    // sort by chosen field
    const field = category.sortField;
    const order = category.sortOrder;

    const getKey = (t: ParsedTaskItem) => this.getFieldDate(t, field);
    all.sort((a, b) => {
      const ka = getKey(a);
      const kb = getKey(b);
      const aMiss = !ka;
      const bMiss = !kb;
      if (aMiss && bMiss) {
        // stable-ish
        if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
        return a.line - b.line;
      }
      if (aMiss) return 1;
      if (bMiss) return -1;

      if (ka === kb) {
        if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
        return a.line - b.line;
      }
      const cmp = ka! < kb! ? -1 : 1;
      return order === "desc" ? -cmp : cmp;
    });

    return all.slice(0, max);
  }
}
