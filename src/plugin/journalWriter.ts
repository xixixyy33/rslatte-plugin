/**
 * Journal 写入相关模块
 * 提供日记写入、项目进度记录等功能
 */
import moment from "moment";
import { normalizePath, TFile, TFolder } from "obsidian";
import type RSLattePlugin from "../main";
import type { JournalAppendModule, JournalAppendRule } from "../types/settings";
import { DEFAULT_SETTINGS } from "../constants/defaults";
import { getTaskTodayKey } from "../taskRSLatte/task/taskTags";
import { peekFinanceMetaAfterMain } from "../services/finance/financeJournalMeta";
import { HEALTH_DIARY_MAIN_LINE_RE, peekHealthMetaAfterMain } from "../services/health/healthJournalMeta";
import { ProjectIndexStore } from "../projectRSLatte/indexStore";
import type { ProjectRSLatteIndexItem } from "../projectRSLatte/types";
import { normalizeHeadingText } from "../utils/text";
import { toLocalOffsetIsoString } from "../utils/localCalendarYmd";

/** 从 Inbox 文件名（无 .md）按 `captureInboxFileNameFormat` 解析出 YYYY-MM-DD；解析失败返回 undefined */
function parseCaptureInboxFileYmd(filePath: string, nameFormat: string): string | undefined {
  const baseName = (filePath.split("/").pop() ?? "").replace(/\.md$/i, "");
  const fileDateM = moment(baseName, nameFormat, true);
  if (!fileDateM.isValid()) return undefined;
  return fileDateM.format("YYYY-MM-DD");
}

/**
 * 从待整理行正文末尾解析「➕ / 全角＋ / ASCII +」后的创建日；用于与「今日新增」统计对齐。
 * 不要求 ➕ 前必有空白（兼容 `正文➕ 2026-03-29`）；支持行尾多空格。
 */
function extractCaptureInboxAddDateAndText(body: string): { text: string; addDate?: string } {
  const b = body.trimEnd();
  const re = /[\s\u00A0\u3000]*(?:\u2795\uFE0F?|\uFF0B|\+)\s*(\d{4}-\d{2}-\d{2})\s*$/u;
  const m = b.match(re);
  if (!m || m.index === undefined) {
    const t = b.trim();
    return { text: t || "（无描述）" };
  }
  const addDate = m[1];
  const stripped = b.slice(0, m.index).trimEnd();
  return { text: stripped.trim() || "（无描述）", addDate };
}

export function createJournalWriter(plugin: RSLattePlugin) {
  return {
    /** ===================== Journal / Navigator façade ===================== */

    async appendLinesToDailyNoteSection(dateKey: string, sectionH2: string, lines: string[]): Promise<void> {
      await plugin.journalSvc.appendLinesToDailyNoteSection(dateKey, sectionH2, lines);
    },

    getJournalAppendRule(module: JournalAppendModule): JournalAppendRule | null {
      const defaultRules = ((DEFAULT_SETTINGS as any).journalAppendRules ?? []) as JournalAppendRule[];
      const rules = (plugin.settings.journalAppendRules ?? defaultRules) as JournalAppendRule[];
      // 强制启用：打卡/财务/健康/任务/提醒/日程（长期写入日记）
      const forced =
        module === "checkin" ||
        module === "finance" ||
        module === "health" ||
        module === "task" ||
        module === "memo" ||
        module === "schedule";
      let r = rules.find((x) => x.module === module) ?? null;
      // 旧库或空间快照未合并时可能缺少 health 等规则，此前会静默不写日记
      if (!r && forced) {
        r = defaultRules.find((x) => x.module === module) ?? null;
      }
      if (!r) return null;
      return { ...r, enabled: forced ? true : !!r.enabled };
    },

    /** 按模块追加写入日记（H1/H2） */
    async appendJournalByModule(module: JournalAppendModule, dateKey: string, lines: string[]): Promise<void> {
      const r = this.getJournalAppendRule(module);
      if (!r) {
        if (lines.length > 0) {
          console.warn(
            `[RSLatte] appendJournalByModule(${module}): 无 journalAppendRules 项且默认值未命中，已跳过写入（请检查设置中的日志追加清单）`,
          );
        }
        return;
      }
      if (!r.enabled) return;

      // ✅ 获取当前空间的日记配置，确保写入到正确的空间日记
      const currentSpaceId = plugin.getCurrentSpaceId();
      const spaces = (plugin.settings as any).spaces || {};
      const currentSpace = spaces[currentSpaceId];
      const spaceSnapshot = currentSpace?.settingsSnapshot || {};
      const spaceDiaryPath = spaceSnapshot.diaryPath;
      const spaceDiaryNameFormat = spaceSnapshot.diaryNameFormat;
      const spaceDiaryTemplate = spaceSnapshot.diaryTemplate;
      
      // 临时设置日记配置覆盖（用于空间隔离）
      const originalPathOverride = (plugin.journalSvc as any)._diaryPathOverride;
      const originalFormatOverride = (plugin.journalSvc as any)._diaryNameFormatOverride;
      const originalTemplateOverride = (plugin.journalSvc as any)._diaryTemplateOverride;
      try {
        // 优先使用空间的配置，否则使用全局配置（null 表示使用全局设置）
        plugin.journalSvc.setDiaryPathOverride(
          spaceDiaryPath || null,
          spaceDiaryNameFormat || null,
          spaceDiaryTemplate || null
        );
        
        // ✅ 统一：按模块规则写入到指定 H1/H2 目录末尾
        // - 若 H1 不存在：追加到文件末尾创建
        // - 若 H2 不存在：追加到该 H1 分区末尾创建
        // - 追加写入：插入到该 H2 分区的末尾（保持目录内的记录顺序）
        await plugin.journalSvc.upsertLinesToDiaryH1H2(dateKey, r.h1, r.h2, lines, { mode: "append" });
      } finally {
        // 恢复原来的覆盖设置
        plugin.journalSvc.setDiaryPathOverride(originalPathOverride, originalFormatOverride, originalTemplateOverride);
      }
    },

    /**
     * 在当日日记全文内定位「财务主行 + meta」且 meta.entry_id 匹配时，替换为 newPair（两行）。
     * @returns 是否替换成功；未找到时返回 false（调用方可改 append）
     */
    async replaceFinanceJournalPairByEntryId(dateKey: string, entryId: string, newPair: string[]): Promise<boolean> {
      const eid = String(entryId ?? "").trim();
      if (!eid || newPair.length < 2) return false;

      const currentSpaceId = plugin.getCurrentSpaceId();
      const spaces = (plugin.settings as any).spaces || {};
      const currentSpace = spaces[currentSpaceId];
      const spaceSnapshot = currentSpace?.settingsSnapshot || {};
      const originalPathOverride = (plugin.journalSvc as any)._diaryPathOverride;
      const originalFormatOverride = (plugin.journalSvc as any)._diaryNameFormatOverride;
      const originalTemplateOverride = (plugin.journalSvc as any)._diaryTemplateOverride;
      try {
        plugin.journalSvc.setDiaryPathOverride(
          spaceSnapshot.diaryPath || null,
          spaceSnapshot.diaryNameFormat || null,
          spaceSnapshot.diaryTemplate || null
        );
        const file = await plugin.journalSvc.ensureDiaryForDateKey(dateKey);
        if (!file) return false;
        const raw = await plugin.app.vault.read(file);
        const linesArr = raw.split(/\r?\n/);
        const finLineRe =
          /^\s*[-*]\s+(?:(❌|✅)\s+)?(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?\s+(income|expense)\s+([A-Za-z0-9_]+)\s+(.*)$/;
        for (let i = 0; i < linesArr.length; i++) {
          const ln = linesArr[i] ?? "";
          if (!finLineRe.test(ln)) continue;
          const peek = peekFinanceMetaAfterMain(linesArr, i);
          if (!peek || peek.meta.entry_id !== eid) continue;
          const endExclusive = peek.lineIndex + 1;
          linesArr.splice(i, endExclusive - i, newPair[0], newPair[1]);
          await plugin.app.vault.modify(file, linesArr.join("\n"));
          return true;
        }
        return false;
      } catch (e) {
        console.warn("[RSLatte] replaceFinanceJournalPairByEntryId failed:", e);
        return false;
      } finally {
        plugin.journalSvc.setDiaryPathOverride(originalPathOverride, originalFormatOverride, originalTemplateOverride);
      }
    },

    /** 健康主行 + meta（entry_id）替换为 newPair（两行） */
    async replaceHealthJournalPairByEntryId(dateKey: string, entryId: string, newPair: string[]): Promise<boolean> {
      const eid = String(entryId ?? "").trim();
      if (!eid || newPair.length < 2) return false;

      const currentSpaceId = plugin.getCurrentSpaceId();
      const spaces = (plugin.settings as any).spaces || {};
      const currentSpace = spaces[currentSpaceId];
      const spaceSnapshot = currentSpace?.settingsSnapshot || {};
      const originalPathOverride = (plugin.journalSvc as any)._diaryPathOverride;
      const originalFormatOverride = (plugin.journalSvc as any)._diaryNameFormatOverride;
      const originalTemplateOverride = (plugin.journalSvc as any)._diaryTemplateOverride;
      try {
        plugin.journalSvc.setDiaryPathOverride(
          spaceSnapshot.diaryPath || null,
          spaceSnapshot.diaryNameFormat || null,
          spaceSnapshot.diaryTemplate || null
        );
        const file = await plugin.journalSvc.ensureDiaryForDateKey(dateKey);
        if (!file) return false;
        const raw = await plugin.app.vault.read(file);
        const linesArr = raw.split(/\r?\n/);
        for (let i = 0; i < linesArr.length; i++) {
          const ln = linesArr[i] ?? "";
          if (!HEALTH_DIARY_MAIN_LINE_RE.test(ln)) continue;
          const m = ln.match(HEALTH_DIARY_MAIN_LINE_RE);
          if (!m || m[2] !== dateKey) continue;
          const peek = peekHealthMetaAfterMain(linesArr, i);
          if (!peek || peek.meta.entry_id !== eid) continue;
          const endExclusive = peek.lineIndex + 1;
          linesArr.splice(i, endExclusive - i, newPair[0], newPair[1]);
          await plugin.app.vault.modify(file, linesArr.join("\n"));
          return true;
        }
        return false;
      } catch (e) {
        console.warn("[RSLatte] replaceHealthJournalPairByEntryId failed:", e);
        return false;
      } finally {
        plugin.journalSvc.setDiaryPathOverride(originalPathOverride, originalFormatOverride, originalTemplateOverride);
      }
    },

    /** V2 Capture：将一条内容追加到「待整理」Inbox 文件（默认 10-Personal/17-Inbox/YYYYMMDD.md），带 ➕ 日期；并写入 work event */
    async appendCaptureInbox(dateKey: string, text: string): Promise<{ filePath: string }> {
      const raw = (text ?? "").trim();
      if (!raw) return { filePath: "" };
      const line = `- [ ] ${raw} ➕ ${dateKey}`;
      const cap = (plugin.settings as any).captureModule ?? (DEFAULT_SETTINGS as any).captureModule;
      const dir = normalizePath(String(cap?.captureInboxDir ?? "10-Personal/17-Inbox").trim() || "10-Personal/17-Inbox");
      const format = String(cap?.captureInboxFileNameFormat ?? "YYYYMMDD").trim() || "YYYYMMDD";
      const fileName = moment(dateKey, "YYYY-MM-DD").format(format) + ".md";
      const filePath = normalizePath(`${dir}/${fileName}`);
      const adapter = plugin.app.vault.adapter;
      try {
        const dirExists = await adapter.exists(dir);
        if (!dirExists) await adapter.mkdir(dir);
        const exists = await adapter.exists(filePath);
        const content = exists ? await adapter.read(filePath) : "";
        const toAppend = content ? (content.trimEnd() + "\n\n" + line) : "## 待整理\n\n" + line;
        await adapter.write(filePath, toAppend);
        try {
          const workEventSvc = (plugin as any).workEventSvc;
          if (workEventSvc?.append) {
            await workEventSvc.append({
              ts: toLocalOffsetIsoString(),
              kind: "capture",
              action: "create",
              source: "ui",
              summary: `待整理: ${raw.length > 50 ? raw.slice(0, 50) + "…" : raw}`,
              ref: { capture_op: "inbox_append", file_path: filePath, add_date: dateKey, text: raw.length > 200 ? raw.slice(0, 200) + "…" : raw },
            });
          }
        } catch {
          // 不阻断主流程
        }
        return { filePath };
      } catch (e) {
        (plugin as any).dbg?.("journalWriter", "appendCaptureInbox failed", { filePath, err: String((e as any)?.message ?? e) });
        throw e;
      }
    },

    /** 列出待整理 Inbox 条目（按 captureShowStatuses 过滤）；用于 Capture 时间轴 */
    async listCaptureInboxItems(showStatuses: { todo?: boolean; done?: boolean; cancelled?: boolean; paused?: boolean }): Promise<Array<{ filePath: string; lineNo: number; line: string; status: "todo" | "done" | "cancelled" | "paused"; text: string; addDate?: string }>> {
      const cap = (plugin.settings as any).captureModule ?? (DEFAULT_SETTINGS as any).captureModule;
      const dir = normalizePath(String(cap?.captureInboxDir ?? "10-Personal/17-Inbox").trim() || "10-Personal/17-Inbox");
      const nameFormat = String(cap?.captureInboxFileNameFormat ?? "YYYYMMDD").trim() || "YYYYMMDD";
      const adapter = plugin.app.vault.adapter;
      const out: Array<{ filePath: string; lineNo: number; line: string; status: "todo" | "done" | "cancelled" | "paused"; text: string; addDate?: string }> = [];
      const listRe = /^\s*-\s+\[([ xX\-/])\]\s+(.+)$/;
      const statusMap: Record<string, "todo" | "done" | "cancelled" | "paused"> = { " ": "todo", x: "done", "-": "cancelled", "/": "paused" };
      try {
        const folder = plugin.app.vault.getAbstractFileByPath(dir);
        const mdTFiles: TFile[] = [];
        if (folder instanceof TFolder) {
          for (const c of folder.children) {
            if (c instanceof TFile && String(c.extension ?? "").toLowerCase() === "md") mdTFiles.push(c);
          }
        } else {
          if (!(await adapter.exists(dir))) return out;
          const listed = (await adapter.list(dir)) as { files?: string[] } | null;
          const names = Array.isArray(listed?.files) ? listed!.files! : [];
          for (const f of names) {
            if (!(f ?? "").toLowerCase().endsWith(".md")) continue;
            const filePath = (f ?? "").includes("/") ? normalizePath(f) : normalizePath(`${dir}/${f}`);
            const tf = plugin.app.vault.getAbstractFileByPath(filePath);
            if (tf instanceof TFile) mdTFiles.push(tf);
          }
        }
        for (const file of mdTFiles) {
          const filePath = file.path;
          const fileYmd = parseCaptureInboxFileYmd(filePath, nameFormat);
          const content = await plugin.app.vault.read(file);
          const lines = (content ?? "").split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(listRe);
            if (!m) continue;
            const mark = m[1];
            const markNorm = mark === " " ? " " : mark.toLowerCase();
            const status = statusMap[markNorm];
            if (!status || !showStatuses[status]) continue;
            const bodyRaw = (m[2] ?? "").trim();
            const { text, addDate: fromLine } = extractCaptureInboxAddDateAndText(bodyRaw);
            const addDate = fromLine ?? fileYmd;
            out.push({ filePath, lineNo: i, line: lines[i], status, text, addDate });
          }
        }
      } catch (e) {
        (plugin as any).dbg?.("journalWriter", "listCaptureInboxItems failed", e);
      }
      return out;
    },

    /** 待整理条目数量：与 Capture 侧栏列表一致，按 `captureShowStatuses` 过滤（不再与列表口径分叉） */
    async getCaptureInboxBacklogCount(): Promise<number> {
      const cap = (plugin.settings as any).captureModule ?? (DEFAULT_SETTINGS as any).captureModule;
      const show = cap?.captureShowStatuses ?? { todo: true, done: false, cancelled: false, paused: true };
      const items = await this.listCaptureInboxItems(show);
      return items.length;
    },

    /** 手动刷新待整理 Inbox：扫描 Inbox 目录下所有 .md，对符合归档条件的文件执行归档；调用方随后可重新 list 以更新时间轴 */
    async refreshCaptureInbox(): Promise<void> {
      const cap = (plugin.settings as any).captureModule ?? (DEFAULT_SETTINGS as any).captureModule;
      const dir = normalizePath(String(cap?.captureInboxDir ?? "10-Personal/17-Inbox").trim() || "10-Personal/17-Inbox");
      const adapter = plugin.app.vault.adapter;
      try {
        if (!(await adapter.exists(dir))) return;
        const list = await adapter.list(dir);
        const mdFiles = (list.files ?? []).filter((f: string) => (f ?? "").endsWith(".md"));
        for (const f of mdFiles) {
          const filePath = (f ?? "").includes("/") ? normalizePath(f) : normalizePath(`${dir}/${f}`);
          await this.maybeArchiveCaptureFile(filePath);
        }
      } catch (e) {
        (plugin as any).dbg?.("journalWriter", "refreshCaptureInbox failed", e);
      }
    },

    /** 更新待整理文件中某一行为新勾选状态（[ ] -> [x]/[-]/[/]），并可能触发归档 */
    async updateCaptureInboxLine(filePath: string, lineNo: number, newMark: " " | "x" | "-" | "/"): Promise<void> {
      const adapter = plugin.app.vault.adapter;
      const content = await adapter.read(filePath);
      const lines = (content ?? "").split(/\r?\n/);
      if (lineNo < 0 || lineNo >= lines.length) return;
      const line = lines[lineNo];
      const m = line.match(/^\s*-\s+\[([ xX\-/])\]\s+(.+)$/);
      if (!m) return;
      const newLine = line.replace(/^\s*-\s+\[[ xX\-/]\]/, `- [${newMark}]`);
      lines[lineNo] = newLine;
      await adapter.write(filePath, lines.join("\n"));
      if (newMark === "x" || newMark === "-") await this.maybeArchiveCaptureFile(filePath);
      try {
        const workEventSvc = (plugin as any).workEventSvc;
        if (workEventSvc?.append) {
          const bodyRaw = (m[2] ?? "").trim();
          const { text: textSnippet } = extractCaptureInboxAddDateAndText(bodyRaw);
          const short = textSnippet.length > 80 ? textSnippet.slice(0, 80) + "…" : textSnippet;
          const baseRef = { capture_op: "inbox_line_update" as const, file_path: filePath, line_no: lineNo, new_mark: newMark, text: short };
          if (newMark === "x") {
            await workEventSvc.append({
              ts: toLocalOffsetIsoString(),
              kind: "capture",
              action: "done",
              source: "ui",
              summary: `✅ 待整理已整理: ${short}`,
              ref: baseRef,
            });
          } else if (newMark === "-") {
            await workEventSvc.append({
              ts: toLocalOffsetIsoString(),
              kind: "capture",
              action: "cancelled",
              source: "ui",
              summary: `⛔ 待整理已取消: ${short}`,
              ref: baseRef,
            });
          } else if (newMark === "/") {
            await workEventSvc.append({
              ts: toLocalOffsetIsoString(),
              kind: "capture",
              action: "paused",
              source: "ui",
              summary: `⏸ 待整理暂不处理: ${short}`,
              ref: baseRef,
            });
          } else {
            await workEventSvc.append({
              ts: toLocalOffsetIsoString(),
              kind: "capture",
              action: "recover",
              source: "ui",
              summary: `♻️ 待整理恢复待处理: ${short}`,
              ref: baseRef,
            });
          }
        }
      } catch {
        // ignore
      }
    },

    /**
     * 若满足则归档到 captureArchiveDir：
     * - 文件名按 `captureInboxFileNameFormat` 能解析出日期，且该日期 **早于** 任务面板「今天」（**当天 Inbox 文件永不归档**）；
     * - 文件中所有快速记录列表行仅为已整理 `[x]` 或已取消 `[-]`（无 `[ ]`、`[/]`）。
     */
    async maybeArchiveCaptureFile(filePath: string): Promise<boolean> {
      const cap = (plugin.settings as any).captureModule ?? (DEFAULT_SETTINGS as any).captureModule;
      const nameFormat = String(cap?.captureInboxFileNameFormat ?? "YYYYMMDD").trim() || "YYYYMMDD";
      const baseName = (filePath.split("/").pop() ?? "").replace(/\.md$/i, "");
      const fileDateM = moment(baseName, nameFormat, true);
      if (!fileDateM.isValid()) return false;
      const fileDateKey = fileDateM.format("YYYY-MM-DD");
      const todayKey = getTaskTodayKey((plugin.settings as any).taskPanel);
      if (fileDateKey >= todayKey) return false;

      const archiveDir = normalizePath(String(cap?.captureArchiveDir ?? "90-Archive/93-System").trim() || "90-Archive/93-System");
      const adapter = plugin.app.vault.adapter;
      const content = await adapter.read(filePath);
      const lines = (content ?? "").split(/\r?\n/);
      const listRe = /^\s*-\s+\[([ xX\-/])\]\s+/;
      let hasTodoOrPaused = false;
      for (const line of lines) {
        const m = line.match(listRe);
        if (!m) continue;
        const mark = m[1];
        if (mark === " " || mark === "/") {
          hasTodoOrPaused = true;
          break;
        }
      }
      if (hasTodoOrPaused) return false;
      const archiveExists = await adapter.exists(archiveDir);
      if (!archiveExists) await adapter.mkdir(archiveDir);
      const name = filePath.split("/").pop() || "inbox.md";
      let dest = normalizePath(`${archiveDir}/${name}`);
      let idx = 0;
      while (await adapter.exists(dest)) {
        idx++;
        const base = name.replace(/\.md$/, "");
        dest = normalizePath(`${archiveDir}/${base}-${idx}.md`);
      }
      await adapter.write(dest, content);
      await adapter.remove(filePath);
      return true;
    },

    /** 按模块覆盖写入日记（H1/H2） */
    async replaceJournalByModule(module: JournalAppendModule, dateKey: string, lines: string[]): Promise<void> {
      const r = this.getJournalAppendRule(module);
      if (!r) return;
      if (!r.enabled) return;
      
      // ✅ 获取当前空间的日记配置，确保写入到正确的空间日记
      const currentSpaceId = plugin.getCurrentSpaceId();
      const spaces = (plugin.settings as any).spaces || {};
      const currentSpace = spaces[currentSpaceId];
      const spaceSnapshot = currentSpace?.settingsSnapshot || {};
      const spaceDiaryPath = spaceSnapshot.diaryPath;
      const spaceDiaryNameFormat = spaceSnapshot.diaryNameFormat;
      const spaceDiaryTemplate = spaceSnapshot.diaryTemplate;
      
      // 临时设置日记配置覆盖（用于空间隔离）
      const originalPathOverride = (plugin.journalSvc as any)._diaryPathOverride;
      const originalFormatOverride = (plugin.journalSvc as any)._diaryNameFormatOverride;
      const originalTemplateOverride = (plugin.journalSvc as any)._diaryTemplateOverride;
      try {
        // 优先使用空间的配置，否则使用全局配置（null 表示使用全局设置）
        plugin.journalSvc.setDiaryPathOverride(
          spaceDiaryPath || null,
          spaceDiaryNameFormat || null,
          spaceDiaryTemplate || null
        );
        
        await plugin.journalSvc.upsertLinesToDiaryH1H2(dateKey, r.h1, r.h2, lines, { mode: "replace" });
      } finally {
        // 恢复原来的覆盖设置
        plugin.journalSvc.setDiaryPathOverride(originalPathOverride, originalFormatOverride, originalTemplateOverride);
      }
    },

    /**
     * 输出进度写入今日日记（基于 WorkEvent）：
     * - 读取今天的 output WorkEvent
     * - 详细记录每个事件（create, start, continued, done, cancelled, paused, recover, archive）
     * - 检查昨天日记的输出进度部分更新时间，如果今天更新过就不再更新
     * - 如果没有事件，写入"当日没有输出进展"
     */
    async writeTodayOutputProgressToJournalFromIndex(): Promise<void> {
      try {
        console.log("[rslatte] writeTodayOutputProgressToJournalFromIndex: starting");
        const rule = this.getJournalAppendRule("output");
        if (!rule) {
          console.log("[rslatte] writeTodayOutputProgressToJournalFromIndex: no rule found for output module (skip)");
          return;
        }
        if (!rule.enabled) {
          console.log("[rslatte] writeTodayOutputProgressToJournalFromIndex: rule is disabled (skip)");
          return;
        }
        console.log("[rslatte] writeTodayOutputProgressToJournalFromIndex: rule found and enabled", { h1: rule.h1, h2: rule.h2 });

        const workEventSvc = plugin.workEventSvc;
        if (!workEventSvc) {
          console.warn("[rslatte] WorkEvent service not available, skipping output progress journal write");
          return;
        }
        if (!workEventSvc.isEnabled()) {
          console.warn("[rslatte] WorkEvent service not enabled, skipping output progress journal write");
          return;
        }

        const todayKey = plugin.getTodayKey();
        const today = (moment as any)(todayKey);
        const todayStart = today.startOf("day").toDate();
        const todayEnd = today.endOf("day").toDate();

        // 计算昨天的日期
        const yesterday = today.clone().subtract(1, "day");
        const yesterdayKey = yesterday.format("YYYY-MM-DD");

        // ✅ 检查昨天日记的输出进度部分更新时间
        const shouldUpdateYesterday = async (): Promise<boolean> => {
          try {
            // 获取当前空间的日记配置
            const currentSpaceId = plugin.getCurrentSpaceId();
            const spaces = (plugin.settings as any).spaces || {};
            const currentSpace = spaces[currentSpaceId];
            const spaceSnapshot = currentSpace?.settingsSnapshot || {};
            const spaceDiaryPath = spaceSnapshot.diaryPath;
            const spaceDiaryNameFormat = spaceSnapshot.diaryNameFormat;

            // 临时设置日记配置覆盖
            const originalPathOverride = (plugin.journalSvc as any)._diaryPathOverride;
            const originalFormatOverride = (plugin.journalSvc as any)._diaryNameFormatOverride;
            try {
              plugin.journalSvc.setDiaryPathOverride(
                spaceDiaryPath || null,
                spaceDiaryNameFormat || null,
                null
              );

              // 查找昨天的日记文件
              const diaryPath = plugin.journalSvc.findDiaryPathForDateKey(yesterdayKey);
              if (!diaryPath) return false;

              const diaryFile = plugin.app.vault.getAbstractFileByPath(diaryPath);
              if (!diaryFile || !(diaryFile instanceof TFile)) return false;

              // 读取日记内容
              const content = await plugin.app.vault.read(diaryFile);
              const lines = content.split(/\r?\n/);

              // 查找输出进度 H2 部分是否存在
              const h1Text = normalizeHeadingText(rule.h1);
              const h2Text = normalizeHeadingText(rule.h2);
              let h2Found = false;
              for (let i = 0; i < lines.length; i++) {
                if (/^#(?!#)\s*/.test(lines[i] ?? "")) {
                  const headingText = normalizeHeadingText(lines[i]);
                  if (headingText === h1Text) {
                    // 找到 H1，查找其下的 H2
                    for (let j = i + 1; j < lines.length; j++) {
                      if (/^##(?!#)\s*/.test(lines[j] ?? "")) {
                        const h2HeadingText = normalizeHeadingText(lines[j]);
                        if (h2HeadingText === h2Text) {
                          h2Found = true;
                          break;
                        }
                      }
                      // 如果遇到下一个 H1，说明 H2 不存在
                      if (/^#(?!#)\s*/.test(lines[j] ?? "")) {
                        break;
                      }
                    }
                    break;
                  }
                }
              }

              if (!h2Found) return false; // H2 不存在，需要写入

              // 检查 H2 部分的最后修改时间（通过文件 mtime）
              const stat = await plugin.app.vault.adapter.stat(diaryPath);
              const mtime = Number((stat as any)?.mtime ?? 0);
              if (!mtime) return false;

              const mtimeDate = (moment as any)(mtime);
              const mtimeDateKey = mtimeDate.format("YYYY-MM-DD");

              // 如果最后修改时间是今天，说明今天已经更新过，不需要再更新
              // 如果还是昨天的日期，需要覆盖一次写入
              return mtimeDateKey === yesterdayKey;
            } finally {
              plugin.journalSvc.setDiaryPathOverride(originalPathOverride, originalFormatOverride, null);
            }
          } catch (e) {
            console.warn("[rslatte] check yesterday diary update time failed", e);
            return false;
          }
        };

        // 读取今天的 output WorkEvent
        const todayEvents: any[] = await workEventSvc.readEventsByFilter({
          kind: ["output"],
          startDate: todayStart,
          endDate: todayEnd,
        });

        console.log(`[rslatte] writeTodayOutputProgressToJournalFromIndex: found ${todayEvents.length} output events for ${todayKey}`, {
          todayStart: toLocalOffsetIsoString(todayStart),
          todayEnd: toLocalOffsetIsoString(todayEnd),
          events: todayEvents.map(e => ({ kind: e.kind, action: e.action, ts: e.ts, file_path: e.ref?.file_path }))
        });

        // 如果没有今天的事件，写入"当日没有输出进展"
        if (todayEvents.length === 0) {
          const lines: string[] = ["- 当日没有输出进展"];
          await this.replaceJournalByModule("output", todayKey, lines);
          return;
        }

        // 格式化时间：ISO 时间戳转换为本地时间 YYYY-MM-DD HH:mm
        const formatTime = (ts: string): string => {
          try {
            const date = new Date(ts);
            return (moment as any)(date).format("YYYY-MM-DD HH:mm");
          } catch {
            return ts;
          }
        };

        // 输出级别事件的图标和文本映射
        const outputActionMap: Record<string, { icon: string; text: string }> = {
          create: { icon: "🆕", text: "创建输出" },
          update: { icon: "📝", text: "输出文件更新" },
          start: { icon: "🛫", text: "输出开始" },
          continued: { icon: "🔄", text: "输出继续" },
          done: { icon: "✅", text: "输出完成" },
          cancelled: { icon: "❌", text: "输出取消" },
          paused: { icon: "⏸", text: "输出暂停" },
          recover: { icon: "🔄", text: "输出恢复" },
          archive: { icon: "📦", text: "输出归档" },
        };

        // 生成输出进度内容（按时间排序）
        const lines: string[] = [];
        const sortedEvents = todayEvents.sort((a, b) => a.ts.localeCompare(b.ts));

        for (const evt of sortedEvents) {
          const actionInfo = outputActionMap[evt.action] || { icon: "📌", text: `输出${evt.action}` };
          const time = formatTime(evt.ts);
          const filePath = String(evt.ref?.file_path ?? "");
          const title = filePath ? filePath.split("/").pop()?.replace(/\.md$/, "") || filePath : "";
          const link = filePath ? `[[${filePath}|${title}]]` : title || "未知文件";

          // 可选：添加其他信息（领域、类型、分类等）
          const parts: string[] = [`- ${actionInfo.icon} ${actionInfo.text}`, link, time];
          const domains = evt.ref?.domains ? String(evt.ref.domains) : "";
          const type = evt.ref?.type ? String(evt.ref.type) : "";
          const category = evt.ref?.docCategory || evt.ref?.category ? String(evt.ref.docCategory || evt.ref.category) : "";
          if (domains) parts.push(`领域:${domains}`);
          if (type) parts.push(`type:${type}`);
          if (category) parts.push(`文档分类:${category}`);

          lines.push(parts.join(" "));
        }

        // 如果没有内容，写入"当日没有输出进展"
        if (lines.length === 0) {
          lines.push("- 当日没有输出进展");
        }

        // 写入今天的日记
        console.log(`[rslatte] writeTodayOutputProgressToJournalFromIndex: writing ${lines.length} lines to journal for ${todayKey}`);
        await this.replaceJournalByModule("output", todayKey, lines);

        // ✅ 检查并更新昨天的日记
        if (await shouldUpdateYesterday()) {
          // 读取昨天的 WorkEvent
          const yesterdayStart = yesterday.startOf("day").toDate();
          const yesterdayEnd = yesterday.endOf("day").toDate();
          const yesterdayEvents: any[] = await workEventSvc.readEventsByFilter({
            kind: ["output"],
            startDate: yesterdayStart,
            endDate: yesterdayEnd,
          });

          if (yesterdayEvents.length === 0) {
            const yesterdayLines: string[] = ["- 当日没有输出进展"];
            await this.replaceJournalByModule("output", yesterdayKey, yesterdayLines);
          } else {
            // 生成昨天的输出进度内容（与今天相同的逻辑）
            const yesterdayLines: string[] = [];
            const sortedYesterdayEvents = yesterdayEvents.sort((a, b) => a.ts.localeCompare(b.ts));

            for (const evt of sortedYesterdayEvents) {
              const actionInfo = outputActionMap[evt.action] || { icon: "📌", text: `输出${evt.action}` };
              const time = formatTime(evt.ts);
              const filePath = String(evt.ref?.file_path ?? "");
              const title = filePath ? filePath.split("/").pop()?.replace(/\.md$/, "") || filePath : "";
              const link = filePath ? `[[${filePath}|${title}]]` : title || "未知文件";

              const parts: string[] = [`- ${actionInfo.icon} ${actionInfo.text}`, link, time];
              const domains = evt.ref?.domains ? String(evt.ref.domains) : "";
              const type = evt.ref?.type ? String(evt.ref.type) : "";
              const category = evt.ref?.docCategory || evt.ref?.category ? String(evt.ref.docCategory || evt.ref.category) : "";
              if (domains) parts.push(`领域:${domains}`);
              if (type) parts.push(`type:${type}`);
              if (category) parts.push(`文档分类:${category}`);

              yesterdayLines.push(parts.join(" "));
            }

            if (yesterdayLines.length === 0) {
              yesterdayLines.push("- 当日没有输出进展");
            }

            await this.replaceJournalByModule("output", yesterdayKey, yesterdayLines);
          }
        }
      } catch (e) {
        console.warn("[rslatte] writeTodayOutputProgressToJournalFromIndex failed", e);
      }
    },

    /**
     * 项目进度写入今日日记（基于 WorkEvent）：
     * - 读取今天的 project/projecttask/milestone WorkEvent
     * - 项目级别事件：详细记录每个事件（create, update, start, done, cancelled, recover）
     * - 里程碑和任务：统计汇总（各操作场景的次数）
     * - 检查昨天日记的项目进度部分更新时间，如果今天更新过就不再更新
     * - 如果没有事件，写入"当日没有项目进展"
     */
    async writeTodayProjectProgressToJournal(force?: boolean): Promise<void> {
      try {
        const rule = this.getJournalAppendRule("project");
        if (!rule || !rule.enabled) return;

        const workEventSvc = plugin.workEventSvc;
        if (!workEventSvc || !workEventSvc.isEnabled()) {
          console.warn("[rslatte] WorkEvent service not enabled, skipping project progress journal write");
          return;
        }

        const todayKey = plugin.getTodayKey();
        const today = (moment as any)(todayKey);
        const todayStart = today.startOf("day").toDate();
        const todayEnd = today.endOf("day").toDate();

        // 计算昨天的日期
        const yesterday = today.clone().subtract(1, "day");
        const yesterdayKey = yesterday.format("YYYY-MM-DD");

        // ✅ 检查昨天日记的项目进度部分更新时间
        const shouldUpdateYesterday = async (): Promise<boolean> => {
          try {
            // 获取当前空间的日记配置
            const currentSpaceId = plugin.getCurrentSpaceId();
            const spaces = (plugin.settings as any).spaces || {};
            const currentSpace = spaces[currentSpaceId];
            const spaceSnapshot = currentSpace?.settingsSnapshot || {};
            const spaceDiaryPath = spaceSnapshot.diaryPath;
            const spaceDiaryNameFormat = spaceSnapshot.diaryNameFormat;

            // 临时设置日记配置覆盖
            const originalPathOverride = (plugin.journalSvc as any)._diaryPathOverride;
            const originalFormatOverride = (plugin.journalSvc as any)._diaryNameFormatOverride;
            try {
              plugin.journalSvc.setDiaryPathOverride(
                spaceDiaryPath || null,
                spaceDiaryNameFormat || null,
                null
              );

              // 查找昨天的日记文件
              const diaryPath = plugin.journalSvc.findDiaryPathForDateKey(yesterdayKey);
              if (!diaryPath) return false;

              const diaryFile = plugin.app.vault.getAbstractFileByPath(diaryPath);
              if (!diaryFile || !(diaryFile instanceof TFile)) return false;

              // 读取日记内容
              const content = await plugin.app.vault.read(diaryFile);
              const lines = content.split(/\r?\n/);

              // 查找项目进度 H2 部分
              const h1Text = normalizeHeadingText(rule.h1);
              const h2Text = normalizeHeadingText(rule.h2);

              // 查找项目进度 H2 部分是否存在
              let h2Found = false;
              for (let i = 0; i < lines.length; i++) {
                if (/^#(?!#)\s*/.test(lines[i] ?? "")) {
                  const headingText = normalizeHeadingText(lines[i]);
                  if (headingText === h1Text) {
                    // 找到 H1，查找其下的 H2
                    for (let j = i + 1; j < lines.length; j++) {
                      if (/^##(?!#)\s*/.test(lines[j] ?? "")) {
                        const h2HeadingText = normalizeHeadingText(lines[j]);
                        if (h2HeadingText === h2Text) {
                          h2Found = true;
                          break;
                        }
                      }
                      // 如果遇到下一个 H1，说明 H2 不存在
                      if (/^#(?!#)\s*/.test(lines[j] ?? "")) {
                        break;
                      }
                    }
                    break;
                  }
                }
              }

              if (!h2Found) return false; // H2 不存在，需要写入

              // 检查 H2 部分的最后修改时间（通过文件 mtime）
              const stat = await plugin.app.vault.adapter.stat(diaryPath);
              const mtime = Number((stat as any)?.mtime ?? 0);
              if (!mtime) return false;

              const mtimeDate = (moment as any)(mtime);
              const mtimeDateKey = mtimeDate.format("YYYY-MM-DD");

              // 如果最后修改时间是今天，说明今天已经更新过，不需要再更新
              // 如果还是昨天的日期，需要覆盖一次写入
              return mtimeDateKey === yesterdayKey;
            } finally {
              plugin.journalSvc.setDiaryPathOverride(originalPathOverride, originalFormatOverride, null);
            }
          } catch (e) {
            console.warn("[rslatte] check yesterday diary update time failed", e);
            return false;
          }
        };

        // 读取今天的项目相关 WorkEvent
        const todayEvents: any[] = await workEventSvc.readEventsByFilter({
          kind: ["project", "projecttask", "milestone"],
          startDate: todayStart,
          endDate: todayEnd,
        });

        // 如果没有今天的事件，写入"当日没有项目进展"
        if (todayEvents.length === 0 && !force) {
          const lines: string[] = ["- 当日没有项目进展"];
          await this.replaceJournalByModule("project", todayKey, lines);
          return;
        }

        // 按项目ID分组事件
        const eventsByProject = new Map<string, { project: any[]; milestone: any[]; projecttask: any[] }>();
        for (const evt of todayEvents) {
          const pid = String(evt.ref?.project_id ?? "").trim();
          if (!pid) continue;

          if (!eventsByProject.has(pid)) {
            eventsByProject.set(pid, { project: [], milestone: [], projecttask: [] });
          }
          const group = eventsByProject.get(pid)!;
          if (evt.kind === "project") {
            group.project.push(evt);
          } else if (evt.kind === "milestone") {
            group.milestone.push(evt);
          } else if (evt.kind === "projecttask") {
            group.projecttask.push(evt);
          }
        }

        // 读取项目索引以获取项目名称和状态
        const indexDir = normalizePath(plugin.getSpaceIndexDir());
        const queueDir = normalizePath(`${plugin.getSpaceQueueDir()}/project`);
        const store = new ProjectIndexStore(plugin.app, indexDir, queueDir);
        const idx = await store.readIndex();
        const items = (idx.items ?? []) as ProjectRSLatteIndexItem[];
        const projectMap = new Map<string, ProjectRSLatteIndexItem>();
        for (const it of items) {
          const pid = String(it.project_id ?? "").trim();
          if (pid) projectMap.set(pid, it);
        }

        // 格式化时间：ISO 时间戳转换为本地时间 YYYY-MM-DD HH:mm
        const formatTime = (ts: string): string => {
          try {
            const date = new Date(ts);
            return (moment as any)(date).format("YYYY-MM-DD HH:mm");
          } catch {
            return ts;
          }
        };

        // 项目级别事件的图标和文本映射
        const projectActionMap: Record<string, { icon: string; text: string }> = {
          create: { icon: "🆕", text: "项目创建" },
          update: { icon: "📝", text: "更新项目信息" },
          start: { icon: "🆕", text: "项目开始" },
          done: { icon: "✅", text: "项目完成" },
          cancelled: { icon: "❌", text: "项目取消" },
          recover: { icon: "🔄", text: "项目恢复" },
        };

        // 生成项目进度内容
        const lines: string[] = [];
        const projectIds = Array.from(eventsByProject.keys()).sort();

        for (const pid of projectIds) {
          const events = eventsByProject.get(pid)!;
          const project = projectMap.get(pid);
          const projectName = project ? String(project.project_name ?? pid) : pid;
          const projectStatus = project ? String(project.status ?? "todo").trim() || "todo" : "todo";

          // 项目标题
          lines.push(`### 【项目】${projectName}（status: ${projectStatus}）`);

          // 项目级别事件：详细记录
          const projectEvents = events.project.sort((a, b) => a.ts.localeCompare(b.ts));
          for (const evt of projectEvents) {
            const actionInfo = projectActionMap[evt.action] || { icon: "📌", text: `项目${evt.action}` };
            const time = formatTime(evt.ts);
            lines.push(`- ${actionInfo.icon} ${actionInfo.text} ${time}`);
          }

          // 里程碑统计汇总
          const milestoneStats = {
            create: 0,
            done: 0,
            cancelled: 0,
            recover: 0,
          };
          for (const evt of events.milestone) {
            if (evt.action === "create") milestoneStats.create++;
            else if (evt.action === "done") milestoneStats.done++;
            else if (evt.action === "cancelled") milestoneStats.cancelled++;
            else if (evt.action === "recover") milestoneStats.recover++;
          }
          const milestoneParts: string[] = [];
          if (milestoneStats.create > 0) milestoneParts.push(`新增 ${milestoneStats.create} 个`);
          if (milestoneStats.done > 0) milestoneParts.push(`完成 ${milestoneStats.done} 个`);
          if (milestoneStats.cancelled > 0) milestoneParts.push(`取消 ${milestoneStats.cancelled} 个`);
          if (milestoneStats.recover > 0) milestoneParts.push(`恢复 ${milestoneStats.recover} 个`);
          if (milestoneParts.length > 0) {
            lines.push(`- 📊 里程碑：${milestoneParts.join("，")}`);
          }

          // 任务统计汇总
          const taskStats = {
            create: 0,
            start: 0,
            continued: 0,
            done: 0,
            cancelled: 0,
            paused: 0,
          };
          for (const evt of events.projecttask) {
            if (evt.action === "create") taskStats.create++;
            else if (evt.action === "start") taskStats.start++;
            else if (evt.action === "continued") taskStats.continued++;
            else if (evt.action === "done") taskStats.done++;
            else if (evt.action === "cancelled") taskStats.cancelled++;
            else if (evt.action === "paused") taskStats.paused++;
          }
          const taskParts: string[] = [];
          if (taskStats.create > 0) taskParts.push(`新增 ${taskStats.create} 个`);
          if (taskStats.start > 0) taskParts.push(`开始 ${taskStats.start} 个`);
          if (taskStats.continued > 0) taskParts.push(`继续 ${taskStats.continued} 个`);
          if (taskStats.done > 0) taskParts.push(`完成 ${taskStats.done} 个`);
          if (taskStats.cancelled > 0) taskParts.push(`取消 ${taskStats.cancelled} 个`);
          if (taskStats.paused > 0) taskParts.push(`暂停 ${taskStats.paused} 个`);
          if (taskParts.length > 0) {
            lines.push(`- 📊 任务：${taskParts.join("，")}`);
          }

          lines.push(""); // 项目之间空一行
        }

        // 移除最后一个空行
        if (lines.length > 0 && lines[lines.length - 1] === "") {
          lines.pop();
        }

        // 如果没有内容，写入"当日没有项目进展"
        if (lines.length === 0) {
          lines.push("- 当日没有项目进展");
        }

        // 写入今天的日记
        await this.replaceJournalByModule("project", todayKey, lines);

        // ✅ 检查并更新昨天的日记
        if (await shouldUpdateYesterday()) {
          // 读取昨天的 WorkEvent
          const yesterdayStart = yesterday.startOf("day").toDate();
          const yesterdayEnd = yesterday.endOf("day").toDate();
          const yesterdayEvents: any[] = await workEventSvc.readEventsByFilter({
            kind: ["project", "projecttask", "milestone"],
            startDate: yesterdayStart,
            endDate: yesterdayEnd,
          });

          if (yesterdayEvents.length === 0) {
            const yesterdayLines: string[] = ["- 当日没有项目进展"];
            await this.replaceJournalByModule("project", yesterdayKey, yesterdayLines);
          } else {
            // 按项目ID分组昨天的事件
            const yesterdayEventsByProject = new Map<string, { project: any[]; milestone: any[]; projecttask: any[] }>();
            for (const evt of yesterdayEvents) {
              const pid = String(evt.ref?.project_id ?? "").trim();
              if (!pid) continue;

              if (!yesterdayEventsByProject.has(pid)) {
                yesterdayEventsByProject.set(pid, { project: [], milestone: [], projecttask: [] });
              }
              const group = yesterdayEventsByProject.get(pid)!;
              if (evt.kind === "project") {
                group.project.push(evt);
              } else if (evt.kind === "milestone") {
                group.milestone.push(evt);
              } else if (evt.kind === "projecttask") {
                group.projecttask.push(evt);
              }
            }

            // 生成昨天的项目进度内容（与今天相同的逻辑）
            const yesterdayLines: string[] = [];
            const yesterdayProjectIds = Array.from(yesterdayEventsByProject.keys()).sort();

            for (const pid of yesterdayProjectIds) {
              const events = yesterdayEventsByProject.get(pid)!;
              const project = projectMap.get(pid);
              const projectName = project ? String(project.project_name ?? pid) : pid;
              const projectStatus = project ? String(project.status ?? "todo").trim() || "todo" : "todo";

              yesterdayLines.push(`### 【项目】${projectName}（status: ${projectStatus}）`);

              const projectEvents = events.project.sort((a, b) => a.ts.localeCompare(b.ts));
              for (const evt of projectEvents) {
                const actionInfo = projectActionMap[evt.action] || { icon: "📌", text: `项目${evt.action}` };
                const time = formatTime(evt.ts);
                yesterdayLines.push(`- ${actionInfo.icon} ${actionInfo.text} ${time}`);
              }

              const milestoneStats = { create: 0, done: 0, cancelled: 0, recover: 0 };
              for (const evt of events.milestone) {
                if (evt.action === "create") milestoneStats.create++;
                else if (evt.action === "done") milestoneStats.done++;
                else if (evt.action === "cancelled") milestoneStats.cancelled++;
                else if (evt.action === "recover") milestoneStats.recover++;
              }
              const milestoneParts: string[] = [];
              if (milestoneStats.create > 0) milestoneParts.push(`新增 ${milestoneStats.create} 个`);
              if (milestoneStats.done > 0) milestoneParts.push(`完成 ${milestoneStats.done} 个`);
              if (milestoneStats.cancelled > 0) milestoneParts.push(`取消 ${milestoneStats.cancelled} 个`);
              if (milestoneStats.recover > 0) milestoneParts.push(`恢复 ${milestoneStats.recover} 个`);
              if (milestoneParts.length > 0) {
                yesterdayLines.push(`- 📊 里程碑：${milestoneParts.join("，")}`);
              }

              const taskStats = { create: 0, start: 0, continued: 0, done: 0, cancelled: 0, paused: 0 };
              for (const evt of events.projecttask) {
                if (evt.action === "create") taskStats.create++;
                else if (evt.action === "start") taskStats.start++;
                else if (evt.action === "continued") taskStats.continued++;
                else if (evt.action === "done") taskStats.done++;
                else if (evt.action === "cancelled") taskStats.cancelled++;
                else if (evt.action === "paused") taskStats.paused++;
              }
              const taskParts: string[] = [];
              if (taskStats.create > 0) taskParts.push(`新增 ${taskStats.create} 个`);
              if (taskStats.start > 0) taskParts.push(`开始 ${taskStats.start} 个`);
              if (taskStats.continued > 0) taskParts.push(`继续 ${taskStats.continued} 个`);
              if (taskStats.done > 0) taskParts.push(`完成 ${taskStats.done} 个`);
              if (taskStats.cancelled > 0) taskParts.push(`取消 ${taskStats.cancelled} 个`);
              if (taskStats.paused > 0) taskParts.push(`暂停 ${taskStats.paused} 个`);
              if (taskParts.length > 0) {
                yesterdayLines.push(`- 📊 任务：${taskParts.join("，")}`);
              }

              yesterdayLines.push("");
            }

            if (yesterdayLines.length > 0 && yesterdayLines[yesterdayLines.length - 1] === "") {
              yesterdayLines.pop();
            }

            if (yesterdayLines.length === 0) {
              yesterdayLines.push("- 当日没有项目进展");
            }

            await this.replaceJournalByModule("project", yesterdayKey, yesterdayLines);
          }
        }
      } catch (e) {
        console.warn("[rslatte] writeTodayProjectProgressToJournal failed", e);
      }
    },
  };
}
