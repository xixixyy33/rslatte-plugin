import { App, normalizePath, TFile, Notice } from "obsidian";
import type { RSLattePluginSettings } from "../../types/settings";
import { WorkEventReader } from "./WorkEventReader";
import { resolveSpaceStatsDir } from "../spaceContext";
import type { MonthlyStats, SpaceMonthlyStats, ModuleMonthlyStats } from "../../types/stats/monthlyStats";
import type { WorkEvent, WorkEventKind } from "../../types/stats/workEvent";

export class MonthlyStatsGenerator {
  constructor(
    private app: App,
    private settings: RSLattePluginSettings,
    private eventReader: WorkEventReader
  ) {}

  /** 生成指定月份的统计数据（为每个空间单独生成并保存） */
  async generateForMonth(yearMonth: string): Promise<MonthlyStats | null> {
    try {
      // 解析年月
      const parts = yearMonth.split("-");
      const year = Number(parts[0]);
      const month = Number(parts[1]);
      if (!year || !month) {
        throw new Error(`Invalid yearMonth format: ${yearMonth}`);
      }

      // 计算该月的开始和结束日期
      // startDate: 该月第一天 00:00:00
      const startDate = new Date(year, month - 1, 1, 0, 0, 0, 0);
      // endDate: 该月最后一天 23:59:59.999
      // new Date(year, month, 0) 创建上个月的最后一天，即当前月的天数
      const daysInMonth = new Date(year, month, 0).getDate();
      const endDate = new Date(year, month - 1, daysInMonth, 23, 59, 59, 999);

      // 获取所有空间
      const spaces = this.eventReader.getSpaces();
      const spaceStats: Record<string, SpaceMonthlyStats> = {};

      // 检查调试开关
      const s: any = this.settings as any;
      const isDebugEnabled = s?.debugLogEnabled === true;

      // 为每个空间生成统计并保存到各自的 stats 目录
      for (const space of spaces) {
        const monthKey = `${year}${String(month).padStart(2, "0")}`;
        const events = await this.eventReader.readEvents(space.id, monthKey);
        
        // 调试日志：检查读取到的事件
        if (isDebugEnabled) {
          console.log(`[RSLatte][MonthlyStats][DEBUG] Space ${space.id}, monthKey: ${monthKey}, total events read: ${events.length}`);
          if (events.length > 0) {
            const eventDates = events.map(e => e.ts.slice(0, 10)).filter((v, i, a) => a.indexOf(v) === i).sort();
            console.log(`[RSLatte][MonthlyStats][DEBUG] Unique event dates in file:`, eventDates);
            // 检查财务事件
            const financeEvents = events.filter(e => e.kind === "finance");
            if (financeEvents.length > 0) {
              const financeDates = financeEvents.map(e => e.ts.slice(0, 10)).filter((v, i, a) => a.indexOf(v) === i).sort();
              console.log(`[RSLatte][MonthlyStats][DEBUG] Finance events count: ${financeEvents.length}, unique dates:`, financeDates);
            } else {
              console.log(`[RSLatte][MonthlyStats][DEBUG] No finance events found in WorkEvent file`);
            }
          }
        }
        
        // 过滤到指定月份
        const monthEvents = events.filter((e) => {
          const eventDate = new Date(e.ts);
          return eventDate >= startDate && eventDate <= endDate;
        });

        // 调试日志：检查过滤后的事件
        if (isDebugEnabled) {
          console.log(`[RSLatte][MonthlyStats][DEBUG] After date filter (${startDate.toISOString()} to ${endDate.toISOString()}): ${monthEvents.length} events`);
          if (monthEvents.length > 0) {
            const monthEventDates = monthEvents.map(e => e.ts.slice(0, 10)).filter((v, i, a) => a.indexOf(v) === i).sort();
            console.log(`[RSLatte][MonthlyStats][DEBUG] Unique dates after filter:`, monthEventDates);
            // 检查财务事件
            const financeMonthEvents = monthEvents.filter(e => e.kind === "finance");
            if (financeMonthEvents.length > 0) {
              const financeMonthDates = financeMonthEvents.map(e => e.ts.slice(0, 10)).filter((v, i, a) => a.indexOf(v) === i).sort();
              console.log(`[RSLatte][MonthlyStats][DEBUG] Finance events after filter: ${financeMonthEvents.length}, unique dates:`, financeMonthDates);
            }
          }
        }

        if (monthEvents.length > 0) {
          // 获取启用的模块列表
          const statsSettings = (this.settings as any)?.statsSettings;
          const moduleEnabled = statsSettings?.moduleEnabled || {};
          
          // 过滤掉未启用的模块的事件
          const enabledMonthEvents = monthEvents.filter((e) => {
            // 如果模块未设置或为 undefined，默认为启用
            return moduleEnabled[e.kind] !== false;
          });
          
          const spaceStat = this.generateSpaceStats(space.id, space.name, enabledMonthEvents);
          spaceStats[space.id] = spaceStat;
          
          // 调试日志：检查生成的统计数据
          if (isDebugEnabled && spaceStat.modules.finance) {
            const financeByDay = spaceStat.modules.finance.byDay || {};
            const financeDates = Object.keys(financeByDay).sort();
            console.log(`[RSLatte][MonthlyStats][DEBUG] Generated finance stats - totalEvents: ${spaceStat.modules.finance.totalEvents}, byDay dates:`, financeDates);
          }
          
          // 为每个空间单独保存统计数据
          await this.saveSpaceStats(space.id, yearMonth, spaceStat);
        }
      }

      const stats: MonthlyStats = {
        yearMonth,
        generatedAt: new Date().toISOString(),
        spaces: spaceStats,
      };

      return stats;
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      console.error(`[RSLatte Stats] Failed to generate stats for ${yearMonth}:`, e);
      
      // 如果是文件已存在的错误，提供更友好的提示
      if (errorMessage.includes("already exists") || errorMessage.includes("File already exists")) {
        new Notice(`统计数据已存在，已自动更新 ${yearMonth} 的统计数据`);
        // 即使报错，也尝试重新加载并返回统计数据
        return await this.loadStats(yearMonth);
      } else {
        new Notice(`生成月度统计失败：${errorMessage}`);
        return null;
      }
    }
  }

  /** 生成单个空间的月度统计 */
  private generateSpaceStats(
    spaceId: string,
    spaceName: string,
    events: WorkEvent[]
  ): SpaceMonthlyStats {
    const modules: Record<WorkEventKind, ModuleMonthlyStats> = {} as any;
    const totalByKind: Record<WorkEventKind, number> = {} as any;
    const totalByAction: Record<string, number> = {};

    // 按模块分组统计
    const eventsByKind: Record<WorkEventKind, WorkEvent[]> = {} as any;
    for (const event of events) {
      if (!eventsByKind[event.kind]) {
        eventsByKind[event.kind] = [];
      }
      eventsByKind[event.kind].push(event);

      // 统计总数
      totalByKind[event.kind] = (totalByKind[event.kind] || 0) + 1;
      totalByAction[event.action] = (totalByAction[event.action] || 0) + 1;
    }

    // 为每个模块生成统计
    for (const [kind, kindEvents] of Object.entries(eventsByKind)) {
      modules[kind as WorkEventKind] = this.generateModuleStats(kind as WorkEventKind, kindEvents);
    }

    return {
      spaceId,
      spaceName,
      modules,
      summary: {
        totalEvents: events.length,
        totalByKind,
        totalByAction,
      },
    };
  }

  /** 生成单个模块的月度统计 */
  private generateModuleStats(kind: WorkEventKind, events: WorkEvent[]): ModuleMonthlyStats {
    const byAction: Record<string, number> = {};
    const byDay: Record<string, number> = {};
    let totalAmount = 0;

    for (const event of events) {
      // 按操作类型统计
      byAction[event.action] = (byAction[event.action] || 0) + 1;

      // 按日期统计
      const day = event.ts.slice(0, 10); // YYYY-MM-DD
      byDay[day] = (byDay[day] || 0) + 1;

      // 累计金额（财务模块）
      if (kind === "finance" && event.metrics?.amount) {
        totalAmount += Number(event.metrics.amount) || 0;
      }
    }

    // 计算峰值日期
    let peakDay = "";
    let peakDayCount = 0;
    for (const [day, count] of Object.entries(byDay)) {
      if (count > peakDayCount) {
        peakDayCount = count;
        peakDay = day;
      }
    }

    const daysInMonth = Object.keys(byDay).length;
    const averagePerDay = daysInMonth > 0 ? events.length / daysInMonth : 0;

    return {
      kind,
      totalEvents: events.length,
      byAction,
      byDay,
      metrics: {
        totalAmount: kind === "finance" ? totalAmount : undefined,
        totalCount: events.length,
        averagePerDay: Math.round(averagePerDay * 100) / 100,
        peakDay,
        peakDayCount,
      },
    };
  }

  /** 获取指定空间的月度统计数据目录 */
  private getSpaceStatsDir(spaceId: string): string {
    return resolveSpaceStatsDir(this.settings, spaceId);
  }

  /** 保存单个空间的统计数据到文件 */
  private async saveSpaceStats(spaceId: string, yearMonth: string, spaceStat: SpaceMonthlyStats): Promise<void> {
    const dir = this.getSpaceStatsDir(spaceId);
    const fileName = `monthly-${yearMonth}.json`;
    const path = normalizePath(`${dir}/${fileName}`);

    try {
      // 确保目录存在
      const dirExists = await this.app.vault.adapter.exists(dir);
      if (!dirExists) {
        await this.app.vault.createFolder(dir);
      }

      // 写入文件（只保存单个空间的统计数据）
      const content = JSON.stringify(spaceStat, null, 2);
      
      // 先检查文件是否存在
      const fileExists = await this.app.vault.adapter.exists(path);
      if (fileExists) {
        // 文件已存在，使用 modify 更新
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          await this.app.vault.modify(file, content);
        } else {
          // 如果获取不到文件对象，尝试删除后重新创建
          await this.app.vault.adapter.remove(path);
          await this.app.vault.create(path, content);
        }
      } else {
        // 文件不存在，创建新文件
        try {
          await this.app.vault.create(path, content);
        } catch (createError: any) {
          // 如果创建时仍然报错 "File already exists"，说明文件在检查后又被创建了
          // 此时尝试获取文件并修改
          if (createError?.message?.includes("already exists") || createError?.message?.includes("File already exists")) {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
              await this.app.vault.modify(file, content);
            } else {
              throw createError;
            }
          } else {
            throw createError;
          }
        }
      }
    } catch (e) {
      console.error(`[RSLatte Stats] Failed to save stats to ${path}:`, e);
      throw e;
    }
  }

  /** 读取已保存的月度统计（从所有空间的 stats 目录加载并合并） */
  async loadStats(yearMonth: string): Promise<MonthlyStats | null> {
    try {
      // 获取所有空间
      const spaces = this.eventReader.getSpaces();
      const spaceStats: Record<string, SpaceMonthlyStats> = {};

      // 从每个空间的 stats 目录加载统计数据
      for (const space of spaces) {
        const dir = this.getSpaceStatsDir(space.id);
        const fileName = `monthly-${yearMonth}.json`;
        const path = normalizePath(`${dir}/${fileName}`);

        try {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (file instanceof TFile) {
            const content = await this.app.vault.read(file);
            const spaceStat = JSON.parse(content) as SpaceMonthlyStats;
            spaceStats[space.id] = spaceStat;
          }
        } catch (e) {
          // 某个空间的统计文件不存在或读取失败，跳过
          console.warn(`[RSLatte Stats] Failed to load stats for space ${space.id} from ${path}:`, e);
        }
      }

      // 如果没有任何统计数据，返回 null
      if (Object.keys(spaceStats).length === 0) {
        return null;
      }

      // 合并所有空间的统计数据
      return {
        yearMonth,
        generatedAt: new Date().toISOString(),
        spaces: spaceStats,
      };
    } catch (e) {
      console.warn(`[RSLatte Stats] Failed to load stats for ${yearMonth}:`, e);
      return null;
    }
  }

  /** 列出所有已生成的月度统计（从所有空间的 stats 目录收集） */
  async listGeneratedMonths(): Promise<string[]> {
    try {
      const monthsSet = new Set<string>();
      
      // 获取所有空间
      const spaces = this.eventReader.getSpaces();
      
      // 从每个空间的 stats 目录收集月份
      for (const space of spaces) {
        const dir = this.getSpaceStatsDir(space.id);
        try {
          const dirExists = await this.app.vault.adapter.exists(dir);
          if (!dirExists) continue;

          const files = this.app.vault.getFiles().filter((f) => {
            const parent = f.parent?.path;
            return parent === dir && f.name.startsWith("monthly-") && f.name.endsWith(".json");
          });

          files.forEach((f) => {
            const match = f.name.match(/monthly-(\d{4}-\d{2})\.json/);
            if (match) {
              monthsSet.add(match[1]);
            }
          });
        } catch (e) {
          console.warn(`[RSLatte Stats] Failed to list months for space ${space.id}:`, e);
        }
      }

      return Array.from(monthsSet)
        .sort()
        .reverse();
    } catch (e) {
      console.warn(`[RSLatte Stats] Failed to list generated months:`, e);
      return [];
    }
  }
}
