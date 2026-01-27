import { App, normalizePath, TFile } from "obsidian";
import type { RSLattePluginSettings } from "../../types/settings";
import type { WorkEvent } from "../../types/stats/workEvent";

export class WorkEventReader {
  constructor(
    private app: App,
    private settings: RSLattePluginSettings
  ) {}

  /** 获取所有空间列表（仅返回启用的空间） */
  getSpaces(): Array<{ id: string; name: string; backgroundColor?: string }> {
    const statsSettings = (this.settings as any)?.statsSettings;
    if (!statsSettings?.spaces || !Array.isArray(statsSettings.spaces)) {
      return [];
    }
    
    return statsSettings.spaces
      .filter((s: any) => s && s.id && s.id.trim() && (s.enabled !== false))
      .map((s: any) => ({
        id: s.id.trim(),
        name: s.name?.trim() || s.id.trim() || "未命名空间",
        backgroundColor: s.backgroundColor || "#ffffff",
      }));
  }

  /** 获取中央索引目录 */
  private getCentralIndexDir(): string {
    const statsSettings = (this.settings as any)?.statsSettings;
    return statsSettings?.centralIndexDir || this.settings.centralIndexDir || "95-Tasks/.rslatte";
  }

  /** 解析 workevent 文件路径
   * 路径格式：{centralIndexDir}/{spaceId}/.events/work-events-{YYYYMM}.jsonl
   * 或：{centralIndexDir}/{spaceId}/events/work-events-{YYYYMM}.jsonl
   * 例如：95-Tasks/.rslatte/00000000-0000-0000-0000-000000000000/.events/work-events-202601.jsonl
   */
  private getWorkEventPath(spaceId: string, monthKey: string): string {
    const centralDir = this.getCentralIndexDir();
    // 构建路径：centralIndexDir/spaceId/.events/work-events-YYYYMM.jsonl
    return normalizePath(`${centralDir}/${spaceId}/.events/work-events-${monthKey}.jsonl`);
  }
  
  /** 获取备用路径（不带点的 events 目录） */
  private getWorkEventPathAlt(spaceId: string, monthKey: string): string {
    const centralDir = this.getCentralIndexDir();
    // 构建路径：centralIndexDir/spaceId/events/work-events-YYYYMM.jsonl
    return normalizePath(`${centralDir}/${spaceId}/events/work-events-${monthKey}.jsonl`);
  }

  /** 读取指定空间和月份的 workevent 数据 */
  async readEvents(spaceId: string, monthKey: string): Promise<WorkEvent[]> {
    const path = this.getWorkEventPath(spaceId, monthKey);
    const altPath = this.getWorkEventPathAlt(spaceId, monthKey);
    
    try {
      let file = this.app.vault.getAbstractFileByPath(path);
      
      // 如果找不到文件，尝试不带点的 events 目录
      if (!(file instanceof TFile)) {
        file = this.app.vault.getAbstractFileByPath(altPath);
      }
      
      // 如果还是找不到，尝试使用 adapter 直接读取
      if (!(file instanceof TFile)) {
        try {
          const adapter = this.app.vault.adapter;
          if (adapter && typeof (adapter as any).read === "function") {
            const configDir = (this.app.vault.adapter as any).basePath || "";
            
            // 尝试两个路径
            const pathsToTry = [path, altPath];
            for (const tryPath of pathsToTry) {
              const fullPath = tryPath.startsWith(".") 
                ? `${configDir}/${tryPath}` 
                : tryPath;
              
              const exists = await (adapter as any).exists(fullPath);
              if (exists) {
                const content = await (adapter as any).read(fullPath);
                const lines = content.split("\n").filter((line: string) => line.trim());
                const events: WorkEvent[] = [];

                for (const line of lines) {
                  try {
                    const event = JSON.parse(line) as WorkEvent;
                    event.spaceId = spaceId;
                    events.push(event);
                  } catch (e) {
                    console.warn("[RSLatte Stats] Failed to parse event line:", line);
                  }
                }

                return events.sort((a, b) => a.ts.localeCompare(b.ts));
              }
            }
          }
        } catch (e) {
          // 继续尝试其他方式
        }
      }
      
      if (!(file instanceof TFile)) {
        // 文件不存在是正常情况（某个月份可能还没有生成事件文件），使用 debug 级别而不是 warn
        // console.debug(`[RSLatte Stats] Event file not found. Tried paths: ${path}, ${altPath}`);
        return [];
      }

      const content = await this.app.vault.read(file);
      const lines = content.split("\n").filter((line: string) => line.trim());
      const events: WorkEvent[] = [];

      for (const line of lines) {
        try {
          const event = JSON.parse(line) as WorkEvent;
          event.spaceId = spaceId;
          events.push(event);
        } catch (e) {
          // 跳过无效行
          console.warn("[RSLatte Stats] Failed to parse event line:", line);
        }
      }

      return events.sort((a, b) => a.ts.localeCompare(b.ts));
    } catch (e) {
      console.warn(`[RSLatte Stats] Failed to read events from ${path}:`, e);
      return [];
    }
  }

  /** 读取指定日期范围的 events（跨月份） */
  async readEventsByDateRange(
    spaceIds: string[],
    startDate: Date,
    endDate: Date
  ): Promise<WorkEvent[]> {
    const allEvents: WorkEvent[] = [];
    const months = this.getMonthsBetween(startDate, endDate);

    for (const spaceId of spaceIds) {
      for (const monthKey of months) {
        const events = await this.readEvents(spaceId, monthKey);
        
        const filtered = events.filter((e) => {
          const eventDate = new Date(e.ts);
          // 确保使用 UTC 时间进行比较
          const inRange = eventDate >= startDate && eventDate <= endDate;
          return inRange;
        });
        
        allEvents.push(...filtered);
      }
    }

    if (allEvents.length === 0 && spaceIds.length > 0 && months.length > 0) {
      console.warn(`[RSLatte Stats] No events found for spaces ${spaceIds.join(", ")} in months ${months.join(", ")}`);
      console.warn(`[RSLatte Stats] Date range: ${startDate.toISOString()} to ${endDate.toISOString()}`);
    }

    return allEvents.sort((a, b) => a.ts.localeCompare(b.ts));
  }

  /** 获取两个日期之间的所有月份键 */
  private getMonthsBetween(start: Date, end: Date): string[] {
    const months: string[] = [];
    const current = new Date(start.getFullYear(), start.getMonth(), 1);
    const endMonth = new Date(end.getFullYear(), end.getMonth(), 1);

    while (current <= endMonth) {
      const year = current.getFullYear();
      const month = String(current.getMonth() + 1).padStart(2, "0");
      months.push(`${year}${month}`);
      current.setMonth(current.getMonth() + 1);
    }

    return months;
  }

}
