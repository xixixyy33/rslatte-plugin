/**
 * Journal 写入相关模块
 * 提供日记写入、项目进度记录等功能
 */
import moment from "moment";
import { normalizePath, TFile } from "obsidian";
import type RSLattePlugin from "../main";
import type { JournalAppendModule, JournalAppendRule } from "../types/settings";
import { DEFAULT_SETTINGS } from "../constants/defaults";
import { ProjectIndexStore } from "../projectRSLatte/indexStore";
import type { ProjectRSLatteIndexItem } from "../projectRSLatte/types";
import { normalizeHeadingText } from "../utils/text";

export function createJournalWriter(plugin: RSLattePlugin) {
  return {
    /** ===================== Journal / Navigator façade ===================== */

    async appendLinesToDailyNoteSection(dateKey: string, sectionH2: string, lines: string[]): Promise<void> {
      await plugin.journalSvc.appendLinesToDailyNoteSection(dateKey, sectionH2, lines);
    },

    getJournalAppendRule(module: JournalAppendModule): JournalAppendRule | null {
      const rules = (plugin.settings.journalAppendRules ?? (DEFAULT_SETTINGS as any).journalAppendRules ?? []) as JournalAppendRule[];
      const r = rules.find((x) => x.module === module) ?? null;
      if (!r) return null;

      // 强制启用：打卡/财务/任务/备忘（这些数据的存档在日记中）
      const forced = module === "checkin" || module === "finance" || module === "task" || module === "memo";
      return { ...r, enabled: forced ? true : !!r.enabled };
    },

    /** 按模块追加写入日记（H1/H2） */
    async appendJournalByModule(module: JournalAppendModule, dateKey: string, lines: string[]): Promise<void> {
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
          console.warn("[rslatte] writeTodayOutputProgressToJournalFromIndex: no rule found for output module");
          return;
        }
        if (!rule.enabled) {
          console.warn("[rslatte] writeTodayOutputProgressToJournalFromIndex: rule is disabled", rule);
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
          todayStart: todayStart.toISOString(),
          todayEnd: todayEnd.toISOString(),
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
