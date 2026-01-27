import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { RSLattePluginSettings } from "../types/settings";
import type { PublishIndexFile, PublishIndexItem, PublishPanelSettings, PublishRecord } from "../types/publishTypes";
import { PublishIndexStore } from "./indexStore";
import { resolveSpaceIndexDir } from "../services/spaceContext";

function toDayKeyFromMs(ms?: number): string | null {
  if (!ms || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function normalizeDomains(v: any): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
  if (typeof v === "string") {
    return v.split(/[,，]+/).map(x => x.trim()).filter(Boolean);
  }
  return [];
}

function toIsoDate(v: any): string | undefined {
  if (!v) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : undefined;
}

/**
 * 从文档中解析发布记录
 * 支持两种格式：
 * 1. 旧格式：<!-- publish:channel=xxx;date=YYYY-MM-DD;relatedDoc=xxx;note=xxx;ts=xxx -->
 * 2. 新格式：在"发布信息清单"标题下的列表项，带有 rslatte 注释
 *    - 📣 ${channel} | ${publishDate} | ${note} | 📎 ${relatedDocPath}
 *      <!-- rslatte:publish:channel=xxx;date=YYYY-MM-DD;relatedDoc=xxx;note=xxx;ts=xxx -->
 */
function parsePublishRecords(content: string): PublishRecord[] {
  const records: PublishRecord[] = [];
  
  // 优先解析新格式（rslatte:publish 注释）
  const newFormatRegex = /<!--\s*rslatte:publish:([^>]+)\s*-->/g;
  let match;
  
  while ((match = newFormatRegex.exec(content)) !== null) {
    const params = match[1];
    const record: Partial<PublishRecord> = {};
    
    // 解析参数（支持值中包含等号和分号的情况）
    const paramRegex = /(\w+)=([^;]+?)(?=;\w+=|$)/g;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(params)) !== null) {
      const key = paramMatch[1];
      let value = paramMatch[2].trim();
      // 尝试解码，如果失败则使用原始值
      try {
        value = decodeURIComponent(value);
      } catch {
        // 如果解码失败，使用原始值
      }
      
      if (key === "channel") record.channel = value;
      else if (key === "date") record.publishDate = value;
      else if (key === "relatedDoc") record.relatedDocPath = value;
      else if (key === "note") record.note = value;
      else if (key === "ts") record.timestamp = value;
    }
    
    if (record.channel && record.publishDate) {
      records.push({
        channel: record.channel,
        publishDate: record.publishDate,
        relatedDocPath: record.relatedDocPath,
        note: record.note,
        timestamp: record.timestamp || new Date().toISOString(),
      });
    }
  }
  
  // 兼容旧格式（publish: 注释，不带 rslatte 前缀）
  if (records.length === 0) {
    const oldFormatRegex = /<!--\s*publish:([^>]+)\s*-->/g;
    let oldMatch;
    
    while ((oldMatch = oldFormatRegex.exec(content)) !== null) {
      const params = oldMatch[1];
      const record: Partial<PublishRecord> = {};
      
      const paramRegex = /(\w+)=([^;]+?)(?=;\w+=|$)/g;
      let paramMatch;
      while ((paramMatch = paramRegex.exec(params)) !== null) {
        const key = paramMatch[1];
        let value = paramMatch[2].trim();
        try {
          value = decodeURIComponent(value);
        } catch {
          // 如果解码失败，使用原始值
        }
        
        if (key === "channel") record.channel = value;
        else if (key === "date") record.publishDate = value;
        else if (key === "relatedDoc") record.relatedDocPath = value;
        else if (key === "note") record.note = value;
        else if (key === "ts") record.timestamp = value;
      }
      
      if (record.channel && record.publishDate) {
        records.push({
          channel: record.channel,
          publishDate: record.publishDate,
          relatedDocPath: record.relatedDocPath,
          note: record.note,
          timestamp: record.timestamp || new Date().toISOString(),
        });
      }
    }
  }
  
  return records;
}

export class PublishRSLatteService {
  private store: PublishIndexStore | null = null;
  private snapshot: PublishIndexFile | null = null;
  private lastFullScanAt = 0;
  
  // ✅ 内存优化：快照访问时间戳（用于过期清理）
  private snapshotLastAccess = 0;
  
  // ✅ 快照过期时间：5分钟（300000毫秒）
  private readonly SNAPSHOT_EXPIRE_MS = 5 * 60 * 1000;

  constructor(
    private host: {
      app: App;
      settingsRef: () => RSLattePluginSettings;
      refreshSidePanel: () => void;
    }
  ) {}

  private get settings(): PublishPanelSettings {
    const s = this.host.settingsRef();
    const op = s.publishPanel;
    return op as any;
  }

  private getIndexBaseDir(): string {
    const s: any = this.host.settingsRef() as any;
    // ✅ 使用全局的中央索引目录，不维护自己的配置
    const centralIndexDir = String(s.centralIndexDir ?? "95-Tasks/.rslatte").trim() || "95-Tasks/.rslatte";
    return resolveSpaceIndexDir(s, undefined, [centralIndexDir]);
  }

  public async ensureReady(): Promise<void> {
    if (this.store) return;
    this.store = new PublishIndexStore(this.host.app, this.getIndexBaseDir());
    await this.store.ensureLayout();
    // ✅ 内存优化：不再预加载快照，改为按需加载
  }

  /**
   * ✅ 内存优化：清理过期的快照
   */
  private cleanupExpiredSnapshots(): void {
    const now = Date.now();
    if (this.snapshot && now - this.snapshotLastAccess > this.SNAPSHOT_EXPIRE_MS) {
      this.snapshot = null;
    }
  }

  /**
   * ✅ 内存优化：手动清理所有快照（供内存紧张时调用）
   */
  public clearAllSnapshots(): void {
    this.snapshot = null;
    this.snapshotLastAccess = 0;
  }

  public async resetStore(): Promise<void> {
    this.store = null;
    this.clearAllSnapshots();
    this.lastFullScanAt = 0;
    await this.ensureReady();
  }

  public async getSnapshot(): Promise<PublishIndexFile> {
    await this.ensureReady();
    
    // ✅ 内存优化：清理过期快照
    this.cleanupExpiredSnapshots();
    
    if (!this.snapshot) {
      this.snapshot = await this.store!.readIndex();
    }
    this.snapshotLastAccess = Date.now();
    return this.snapshot;
  }

  private normalizeRootList(list: any): string[] {
    return (list ?? [])
      .map((x: any) => normalizePath(String(x ?? "").trim()))
      .filter((x: string) => !!x);
  }

  /**
   * 从文件构建索引项
   */
  public async buildItemFromFile(file: TFile): Promise<PublishIndexItem | null> {
    try {
      const cache = this.host.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter ?? ({} as any);

      const title = file.basename;
      const docCategory = fm?.["文档分类"] ? String(fm["文档分类"]).trim() : undefined;
      const domains = normalizeDomains(fm?.["领域"] ?? fm?.domains ?? fm?.domain);
      const type = fm?.type ? String(fm.type).trim() : undefined;
      const publishType = fm?.发布类型 ? String(fm.发布类型).trim() : undefined;

      // 读取文件内容以解析发布记录
      let publishRecords: PublishRecord[] = [];
      try {
        const content = await this.host.app.vault.read(file);
        publishRecords = parsePublishRecords(content);
      } catch {
        // ignore
      }

      const createDate = toIsoDate(fm?.create ?? fm?.created ?? fm?.created_date) ?? toDayKeyFromMs(file.stat?.ctime) ?? undefined;

      return {
        filePath: file.path,
        title,
        docCategory,
        domains,
        type,
        publishType,
        publishRecords,
        ctimeMs: file.stat?.ctime,
        mtimeMs: file.stat?.mtime,
        createDate,
      };
    } catch (e) {
      console.warn("PublishRSLatte buildItemFromFile failed:", e);
      return null;
    }
  }

  /**
   * 刷新索引：扫描指定目录
   */
  public async refreshIndexNow(): Promise<void> {
    await this.ensureReady();

    const op = this.settings;
    const scanRoots = this.normalizeRootList(op?.documentDirs ?? []);

    if (!scanRoots.length) {
      const prev = await this.getSnapshot();
      this.snapshot = {
        version: 1,
        updatedAt: new Date().toISOString(),
        items: (prev?.items ?? []) as PublishIndexItem[],
      };
      await this.store!.writeIndex(this.snapshot);
      this.lastFullScanAt = Date.now();
      return;
    }

    const items: PublishIndexItem[] = [];
    const seen = new Set<string>();

    const scanFolder = async (folder: TFolder) => {
      for (const ch of folder.children) {
        if (ch instanceof TFolder) {
          await scanFolder(ch);
        } else if (ch instanceof TFile) {
          if (ch.extension.toLowerCase() !== "md") continue;
          if (seen.has(ch.path)) continue;
          seen.add(ch.path);
          const it = await this.buildItemFromFile(ch);
          if (it) items.push(it);
        }
      }
    };

    const scanPath = async (p: string) => {
      const af = this.host.app.vault.getAbstractFileByPath(p);
      if (!af) return;
      if (af instanceof TFolder) {
        await scanFolder(af);
      } else if (af instanceof TFile) {
        if (af.extension.toLowerCase() === "md") {
          if (seen.has(af.path)) return;
          seen.add(af.path);
          const it = await this.buildItemFromFile(af);
          if (it) items.push(it);
        }
      }
    };

    for (const r of scanRoots) {
      await scanPath(r);
    }

    // 按修改时间排序
    items.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));

    this.snapshot = {
      version: 1,
      updatedAt: new Date().toISOString(),
      items,
    };
    await this.store!.writeIndex(this.snapshot);
    this.lastFullScanAt = Date.now();
  }

  /**
   * 更新单个文件的索引
   */
  public async upsertFile(file: TFile): Promise<void> {
    await this.ensureReady();
    const it = await this.buildItemFromFile(file);
    if (!it) return;

    const snap = await this.getSnapshot();
    const items = (snap.items ?? []).filter(x => x.filePath !== file.path);
    items.push(it);
    items.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));

    this.snapshot = {
      version: 1,
      updatedAt: new Date().toISOString(),
      items,
    };
    await this.store!.writeIndex(this.snapshot);
  }

  /**
   * 节流刷新：如果距离上次刷新时间小于指定间隔，则跳过
   */
  public async refreshIndexIfStale(minIntervalMs: number = 30_000): Promise<void> {
    const now = Date.now();
    if (now - this.lastFullScanAt < minIntervalMs) return;
    try {
      await this.refreshIndexNow();
    } catch (e) {
      console.warn("PublishRSLatte refreshIndex failed:", e);
    }
  }
}
