import { App, TFile, normalizePath } from "obsidian";
import { moment } from "obsidian";

import { RSLattePluginSettings } from "../types/settings";
import type { JournalPanel } from "../types/rslatteTypes";
import { AuditService } from "./auditService";
import { normalizeHeadingKey, normalizeHeadingText, toH2 } from "../utils/text";

/**
 * 日记服务（插件自管理，不依赖 core daily-notes 配置）
 *
 * 约定：
 * - diaryPath：提供日记存放目录；会按需遍历该目录的子文件夹查找目标日记
 * - diaryNameFormat：moment 格式（如 YYYYMMDD）；可用于生成文件名（不含 .md）
 * - diaryTemplate：模板文件路径（可选）；日记不存在时用模板创建
 *
 * 注意：不自动写入 “#YYYYMMDD” 这种一级标题；模板要不要写标题由模板决定。
 */
export class JournalService {
  constructor(
    private app: App,
    private settings: RSLattePluginSettings,
    private audit: AuditService
  ) {}

  // ===== 日记路径解析（含缓存）=====
  private _dateKeyToPath = new Map<string, string>();
  private _diaryPathOverride: string | null = null; // 临时覆盖的日记路径（用于空间隔离）
  private _diaryNameFormatOverride: string | null = null; // 临时覆盖的日记名称格式（用于空间隔离）
  private _diaryTemplateOverride: string | null = null; // 临时覆盖的日记模板（用于空间隔离）

  /**
   * 设置临时的日记配置覆盖（用于空间隔离）
   * @param diaryPath 空间的日记路径，如果为 null 则使用全局设置
   * @param diaryNameFormat 空间的日记名称格式，如果为 null 则使用全局设置
   * @param diaryTemplate 空间的日记模板，如果为 null 则使用全局设置
   */
  public setDiaryPathOverride(diaryPath: string | null, diaryNameFormat?: string | null, diaryTemplate?: string | null): void {
    this._diaryPathOverride = diaryPath;
    if (diaryNameFormat !== undefined) {
      this._diaryNameFormatOverride = diaryNameFormat;
    }
    if (diaryTemplate !== undefined) {
      this._diaryTemplateOverride = diaryTemplate;
    }
    // 清除缓存，因为路径改变了
    this._dateKeyToPath.clear();
  }

  private getDiaryDir(): string {
    // 优先使用临时覆盖的路径（用于空间隔离）
    if (this._diaryPathOverride !== null) {
      const raw = this._diaryPathOverride.trim();
      const norm = normalizePath(raw).replace(/\/+$/g, "");
      return norm;
    }
    const raw = (this.settings.diaryPath ?? "").trim();
    // normalizePath 会把重复 // 等规整掉；但不会自动去掉末尾 /，这里手动处理
    const norm = normalizePath(raw).replace(/\/+$/g, "");
    return norm;
  }

  private getDiaryNameBase(dateKey: string): string {
    // 优先使用临时覆盖的格式（用于空间隔离）
    const raw = this._diaryNameFormatOverride ?? this.settings.diaryNameFormat ?? "YYYYMMDD";
    const fmt = raw.trim() || "YYYYMMDD";
    const momentFn = moment as any;
    return momentFn(dateKey, "YYYY-MM-DD").format(fmt);
  }

  /**
   * 生成“期望创建”的日记路径（不保证存在）
   * - 如果 diaryNameFormat 里包含 "/"（例如 YYYY/MM/DD），会自然形成子目录
   */
  private buildTargetDiaryPath(dateKey: string): string {
    const dir = this.getDiaryDir();
    const base = this.getDiaryNameBase(dateKey); // may include /
    const rel = normalizePath(`${base}.md`);
    return dir ? normalizePath(`${dir}/${rel}`) : rel;
  }

  /** 在 diaryPath（含子目录）中查找指定日期的日记文件（存在则返回路径） */
  public findDiaryPathForDateKey(dateKey: string): string | null {
    const cached = this._dateKeyToPath.get(dateKey);
    if (cached) {
      const af = this.app.vault.getAbstractFileByPath(cached);
      if (af && af instanceof TFile) return cached;
      this._dateKeyToPath.delete(dateKey);
    }

    // 1) 优先：按“期望路径”精确命中（支持 YYYY/MM/DD 这种格式）
    const target = this.buildTargetDiaryPath(dateKey);
    const exact = this.app.vault.getAbstractFileByPath(target);
    if (exact && exact instanceof TFile) {
      this._dateKeyToPath.set(dateKey, target);
      return target;
    }

    // 2) 若 diaryNameFormat 产生了子目录（含 /），通常不需要再模糊查找
    //    但为了满足“遍历子文件夹”的需求，仅对“纯文件名”格式做一次遍历查找
    const base = this.getDiaryNameBase(dateKey);
    if (base.includes("/")) return null;

    const dir = this.getDiaryDir();
    const files = this.app.vault.getMarkdownFiles();
    const prefix = dir ? (dir.endsWith("/") ? dir : `${dir}/`) : "";

    let best: TFile | null = null;
    for (const f of files) {
      if (prefix && !f.path.startsWith(prefix)) continue;
      if (f.basename !== base) continue;

      // 选择最“浅”的路径（更短），避免同名重复时随机命中
      if (!best || f.path.length < best.path.length) best = f;
    }

    if (best) {
      this._dateKeyToPath.set(dateKey, best.path);
      return best.path;
    }
    return null;
  }

  /** 查找指定日期的日记文件（存在则返回文件对象） */
  public findDiaryFileForDateKey(dateKey: string): TFile | null {
    const p = this.findDiaryPathForDateKey(dateKey);
    if (!p) return null;
    const af = this.app.vault.getAbstractFileByPath(p);
    return af && af instanceof TFile ? af : null;
  }

  /** 读取模板内容（若存在） */
  private async readTemplateContent(templatePath: string): Promise<string> {
    const raw = (templatePath ?? "").trim();
    if (!raw) return "";

    // Obsidian 文件树通常隐藏 .md 扩展名，用户很容易只填 `91-Templates/t_daily`。
    // vault.getAbstractFileByPath 需要精确路径，所以这里做一次兼容：
    // - 先按原样查
    // - 若无 .md 且查不到，再补 `.md` 试一次
    const candidates: string[] = [];
    candidates.push(raw);
    if (!/\.md$/i.test(raw)) candidates.push(raw + ".md");

    let af: any = null;
    for (const p of candidates) {
      const f = this.app.vault.getAbstractFileByPath(p);
      if (f) { af = f; break; }
    }
    if (!af || !(af instanceof TFile)) return "";

    return await this.app.vault.read(af);
  }

  /**
   * 生成新日记初始内容策略：
   * - 若配置了模板：复制模板内容（这里仅做简单变量替换，不依赖 templater）
   * - 若无模板：创建空文件（不写入一级标题）
   */
  private async buildNewDiaryContent(dateKey: string): Promise<string> {
    const momentFn = moment as any;
    const d = momentFn(dateKey, "YYYY-MM-DD");
    const base = this.getDiaryNameBase(dateKey);

    // 优先使用临时覆盖的模板（用于空间隔离）
    const tplPath = (this._diaryTemplateOverride ?? this.settings.diaryTemplate ?? "").trim();
    const tpl = tplPath ? await this.readTemplateContent(tplPath) : "";
    if (tpl && tpl.trim()) {
      // 简单变量替换（不强依赖 templater）
      return tpl
        .replace(/\{\{date\}\}/g, d.format("YYYY-MM-DD"))
        .replace(/\{\{dateKey\}\}/g, d.format("YYYY-MM-DD"))
        .replace(/\{\{diaryName\}\}/g, base)
        .replace(/\{\{diaryFileName\}\}/g, base);
    }

    // ✅ 不写入 “#YYYYMMDD” 标题
    return "";
  }

  /** 确保某天的日记文件存在；不存在则按“日记模板信息”创建 */
  public async ensureDiaryForDateKey(dateKey: string): Promise<TFile> {
    const existed = this.findDiaryFileForDateKey(dateKey);
    if (existed) return existed;

    const path = this.buildTargetDiaryPath(dateKey);

    await this.audit.ensureDirForPath(path);

    const content = await this.buildNewDiaryContent(dateKey);
    const created = await this.app.vault.create(path, content);

    this._dateKeyToPath.set(dateKey, created.path);

    return created;
  }

  // ===== 追加写入区块 =====

  /**
   * 确保 H2 目录存在：若不存在则插入
   * 插入策略：
   * - settings.appendAnchorHeading 为空：追加到文件尾
   * - 不为空：插入到“该标题行”后面（匹配任意级别 #，只比较标题文本）
   */
  private ensureH2Section(lines: string[], h2Heading: string): { lines: string[]; headingLineIndex: number } {
    const target = toH2(h2Heading).trimEnd();
    const targetText = normalizeHeadingText(target);

    // 1) 已存在（只认 H2）
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(#+)\s+(.*)$/);
      if (!m) continue;
      const text = normalizeHeadingText(lines[i]);
      if (m[1] === "##" && text === targetText) {
        return { lines, headingLineIndex: i };
      }
    }

    // 2) 计算插入点
    let insertAt = lines.length;
    const anchorRaw = (this.settings.appendAnchorHeading ?? "").trim();
    if (anchorRaw) {
      const anchorText = normalizeHeadingText(anchorRaw);

      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^(#+)\s+(.*)$/);
        if (!m) continue;
        const text = normalizeHeadingText(lines[i]);
        if (text === anchorText) {
          insertAt = i + 1; // 插在锚点后面
          break;
        }
      }
    }

    // 3) 组织插入块（保证美观空行）
    const block: string[] = [];

    if (insertAt > 0 && lines[insertAt - 1].trim() !== "") block.push("");
    block.push(target);
    block.push("");

    const newLines = [...lines.slice(0, insertAt), ...block, ...lines.slice(insertAt)];

    const headingIdx = insertAt + (block[0] === "" ? 1 : 0);
    return { lines: newLines, headingLineIndex: headingIdx };
  }

  /**
   * 区块范围：从目标 H2 开始，到下一个 H1/H2 为止。
   * 目标区块内允许出现 H3/H4 等子标题，仍视为该区块内容的一部分。
   */
  public async appendLinesToDiarySection(dateKey: string, sectionH2: string, linesToAppend: string[]) {
    // ✅ 开关：允许关闭日志追加
    if (!this.settings.enableJournalAppend) return;

    const file = await this.ensureDiaryForDateKey(dateKey);
    const raw = await this.app.vault.read(file);
    let lines = raw.split("\n");

    // 1) 确保 H2 标题存在（按 anchor 插入策略）
    const ensured = this.ensureH2Section(lines, sectionH2);
    lines = ensured.lines;

    // 2) 找区块结束：遇到下一个 "# " 或 "## " 就结束
    const start = ensured.headingLineIndex;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^#{1,2}\s+/.test(lines[i])) { end = i; break; }
    }

    // 3) 计算插入点：默认插入到分区末尾。
    //    但如果分区末尾是 Markdown 分隔线 '---'，则插入到 '---' 上方。
    //    这可以避免你用 '---' 分隔段落时，新内容被追加到分隔线之后。
    let insertAt = end;
    {
      // 在 [start+1, end) 范围内从后往前找最后一个非空行
      let lastNonEmpty = -1;
      for (let i = end - 1; i > start; i--) {
        if (String(lines[i] ?? "").trim() !== "") { lastNonEmpty = i; break; }
      }
      if (lastNonEmpty >= 0) {
        const t = String(lines[lastNonEmpty] ?? "").trim();
        // Markdown horizontal rule (at least 3 hyphens)
        if (/^-{3,}$/.test(t)) {
          insertAt = lastNonEmpty; // 插到 '---' 上方
        }
      }
    }

    // 4) 插入内容
    const block = [...linesToAppend, ""];
    lines.splice(insertAt, 0, ...block);

    await this.app.vault.modify(file, lines.join("\n"));
  }

  // =========================
  // H1/H2 hierarchical upsert
  // =========================

  private normalizeH1(raw: string): string {
    const t = String(raw ?? "").trim();
    const text = t.replace(/^#+\s*/, "").trim();
    return `# ${text || "操作日志"}`;
  }

  private normalizeH2(raw: string): string {
    const t = String(raw ?? "").trim();
    const text = t.replace(/^#+\s*/, "").trim();
    return `## ${text || "记录"}`;
  }

  /**
   * 在指定范围内查找某级标题（H1/H2），按“标题文本”匹配（忽略 # 级别差异与空格）。
   * - preferLast=true：从后往前找，命中最后一个（更符合“追加到末尾”的直觉）
   */
  private findHeadingLine(
    lines: string[],
    level: 1 | 2,
    headingTextRaw: string,
    start: number,
    end: number,
    preferLast: boolean
  ): number {
    const wantText = normalizeHeadingText(headingTextRaw);
    if (!wantText) return -1;

    const iter = (fn: (i: number) => boolean) => {
      if (preferLast) {
        for (let i = end - 1; i >= start; i--) {
          if (fn(i)) return i;
        }
      } else {
        for (let i = start; i < end; i++) {
          if (fn(i)) return i;
        }
      }
      return -1;
    };

    return iter((i) => {
      const ln = String(lines[i] ?? "");
      const m = ln.match(/^(#+)\s*(.*)$/);
      if (!m) return false;
      const lv = m[1].length;
      if (level === 1 && lv !== 1) return false;
      if (level === 2 && lv !== 2) return false;
      const text = normalizeHeadingText(ln);
      return text === wantText;
    });
  }

  /**
   * 在日记中确保存在 H1 与其下的 H2，并对该 H2 分区内容做 append / replace。
   * - append: 追加到分区末尾
   * - replace: 覆盖分区内容（保留标题行）
   */
  public async upsertLinesToDiaryH1H2(
    dateKey: string,
    h1Raw: string,
    h2Raw: string,
    linesPayload: string[],
    opts?: { mode?: "append" | "replace" }
  ): Promise<void> {
    const mode = (opts?.mode ?? "append") as any;
    const h1 = this.normalizeH1(h1Raw);
    const h2 = this.normalizeH2(h2Raw);
    const file = await this.ensureDailyNoteForDateKey(dateKey);
    if (!file) return;

    const content = await this.app.vault.read(file);
    const lines = content.split(/\r?\n/);

    // ensure H1（按标题文本匹配；若重复出现，取最后一个）
    const h1Text = normalizeHeadingText(h1);
    let idxH1 = this.findHeadingLine(lines, 1, h1Text, 0, lines.length, true);
    if (idxH1 < 0) {
      // append H1 at end
      if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
      idxH1 = lines.length;
      lines.push(h1);
      lines.push("");
    }

    // find H1 end (next H1) — 只认真正的一级标题（#），允许 `#标题` 或 `# 标题`
    let endH1 = lines.length;
    for (let i = idxH1 + 1; i < lines.length; i++) {
      if (/^#(?!#)\s*/.test(lines[i] ?? "")) {
        endH1 = i;
        break;
      }
    }

    // ensure H2 within H1 section
    const h2Text = normalizeHeadingText(h2);
    let idxH2 = this.findHeadingLine(lines, 2, h2Text, idxH1 + 1, endH1, true);
    if (idxH2 < 0) {
      // ✅ 二级目录不存在：追加到该一级目录（H1）范围的末尾（即 endH1 前）
      let insertPos = endH1;
      // keep a blank line before inserting a new H2 if needed
      if (insertPos > 0 && lines[insertPos - 1].trim() !== "") {
        lines.splice(insertPos, 0, "");
        insertPos++;
        endH1++;
      }
      lines.splice(insertPos, 0, h2, "");
      idxH2 = insertPos;
      endH1 += 2;
    }

    // find H2 end within H1: next heading of level 1 or 2, or endH1
    let endH2 = endH1;
    for (let i = idxH2 + 1; i < endH1; i++) {
      const ln = lines[i] ?? "";
      if (/^#{1,2}\s+/.test(ln)) {
        endH2 = i;
        break;
      }
    }

    // region to operate: between idxH2+1 .. endH2
    // 默认追加到分区末尾，但如果分区末尾是 '---' 分隔线，则插到分隔线之上。
    let insertAt = endH2;
    {
      let lastNonEmpty = -1;
      for (let i = endH2 - 1; i > idxH2; i--) {
        if (String(lines[i] ?? "").trim() !== "") { lastNonEmpty = i; break; }
      }
      if (lastNonEmpty >= 0) {
        const t = String(lines[lastNonEmpty] ?? "").trim();
        if (/^-{3,}$/.test(t)) {
          insertAt = lastNonEmpty;
        }
      }
    }
    const payload = (linesPayload ?? []).filter((x) => x !== undefined && x !== null).map((x) => String(x));

    if (mode === "replace") {
      lines.splice(idxH2 + 1, endH2 - (idxH2 + 1), ...payload);
    } else {
      // append
      // ensure last line before insertAt ends with blank line? keep as-is
      lines.splice(insertAt, 0, ...payload);
    }

    await this.app.vault.modify(file, lines.join("\n"));
  }
  /**
   * 直接将 lines 追加到当日日记文件末端（保持插入顺序与日志顺序一致）
   * - 不依赖 H1/H2 定位
   * - 自动确保日记文件存在
   */
  async appendLinesToDiaryEnd(dateKey: string, linesPayload: string[]): Promise<void> {
    const file = await this.ensureDailyNoteForDateKey(dateKey);
    if (!file) return;

    const payload = (linesPayload ?? []).filter((x) => x !== undefined && x !== null).map((x) => String(x));
    if (payload.length === 0) return;

    const content = await this.app.vault.read(file);
    const normalized = content.endsWith("\n") || content.length === 0 ? content : (content + "\n");

    // 如果文件末尾不是空行，为了可读性插入一个空行再追加
    let prefix = normalized;
    if (prefix.length > 0) {
      const lines = prefix.split(/\r?\n/);
      const last = lines.length ? lines[lines.length - 1] : "";
      if (String(last ?? "").trim() !== "") {
        prefix += "\n";
      }
    }

    const appended = prefix + payload.join("\n") + "\n";
    await this.app.vault.modify(file, appended);
  }


  // ===== 兼容：旧方法名（保持主逻辑少改动） =====

  /** @deprecated 建议用 ensureDiaryForDateKey / findDiaryPathForDateKey */
  public async ensureDailyNoteForDateKey(dateKey: string): Promise<TFile> {
    return this.ensureDiaryForDateKey(dateKey);
  }

  /** @deprecated 建议用 findDiaryPathForDateKey */
  public buildDailyNotePathForDateKey(dateKey: string): string {
    // 若存在已写入/已存在的日记，优先返回真实路径；否则返回“期望创建路径”
    return this.findDiaryPathForDateKey(dateKey) ?? this.buildTargetDiaryPath(dateKey);
  }

  /** @deprecated 建议用 appendLinesToDiarySection */
  public async appendLinesToDailyNoteSection(dateKey: string, sectionH2: string, linesToAppend: string[]) {
    return this.appendLinesToDiarySection(dateKey, sectionH2, linesToAppend);
  }

  // =========================
  // 日志子窗口预览
  // =========================

  /**
   * 一次性读取并解析多个 panel 的预览文本（避免每个按钮重复读文件）。
   * - panel.heading：匹配标题行（忽略 # 级别差异，只比较标题文本）
   * - maxLines：截断到 1..30 行
   */
  public async readPanelsPreviewForDateKey(dateKey: string, panels: JournalPanel[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    try {
      if (!Array.isArray(panels) || panels.length === 0) return out;

      const targetPath = await this.findDiaryPathForDateKey(dateKey);
      if (!targetPath) return out;

      const af = this.app.vault.getAbstractFileByPath(targetPath);
      if (!af || !(af instanceof TFile)) return out;

      const raw = await this.app.vault.read(af);
      const lines = raw.split("\n").map((l) => l.replace(/\r$/, ""));

      // 预先扫描所有标题行，按“标题文本 key”建立索引（忽略 # 级别、忽略多余空格）
      const headings: { idx: number; level: number; key: string }[] = [];
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^(#+)\s*(.*)$/);
        if (!m) continue;
        const level = m[1].length;
        const text = normalizeHeadingText(lines[i]);
        const key = normalizeHeadingKey(text);
        if (!key) continue;
        headings.push({ idx: i, level, key });
      }

      for (const p of panels) {
        const id = (p?.id ?? "").trim();
        if (!id) continue;

        const wantedText = normalizeHeadingText(p.heading ?? "");
        const wantedKey = normalizeHeadingKey(wantedText);
        if (!wantedKey) {
          out[id] = "";
          continue;
        }

        const found = headings.find((h) => h.key === wantedKey);
        if (!found) {
          out[id] = "";
          continue;
        }

        // 区块开始：标题行之后，跳过空行
        let start = found.idx + 1;
        while (start < lines.length && lines[start].trim() === "") start++;

        // 区块结束：遇到“级别 <= 当前标题级别”的下一条标题
        let end = lines.length;
        for (let i = start; i < lines.length; i++) {
          const m = lines[i].match(/^(#+)\s+/);
          if (!m) continue;
          const level2 = m[1].length;
          if (level2 <= found.level) {
            end = i;
            break;
          }
        }

        // 取内容
        let contentLines = lines.slice(start, end);

        // 去掉开头空行（保险）
        while (contentLines.length && contentLines[0].trim() === "") contentLines.shift();

        const max = Math.min(Math.max(p.maxLines ?? 20, 1), 30);
        const preview = contentLines.slice(0, max).join("\n").trimEnd();

        out[id] = preview;
      }

      return out;
    } catch (e) {
      console.error("[rslatte] readPanelsPreviewForDateKey failed", e);
      return out;
    }
  }
}
