import { normalizePath, type App } from "obsidian";
import type { RSLattePluginSettings } from "../../types/settings";
import type { RSLatteSpaceConfig } from "../../types/space";


/**
 * Spaces Index Service
 * 
 * 在中央索引目录下维护 spaces-index.json 文件，包含所有空间的信息。
 * 当空间配置发生变化时，自动更新该文件。
 */

export interface SpaceIndexItem {
  /** 空间 UUID */
  id: string;
  /** 空间名称 */
  name: string;
  /** 业务空间编号（1 / 2 / 4…） */
  spaceNumber?: number;
  /** 创建时间（ISO 字符串） */
  createdAt: string;
  /** 更新时间（ISO 字符串） */
  updatedAt: string;
  /** 是否为当前激活的空间 */
  isCurrent?: boolean;
  /** 日记路径 */
  diaryPath?: string;
  /** 日记格式 */
  diaryNameFormat?: string;
}

export interface SpacesIndex {
  /** 版本号（用于未来兼容性） */
  version: number;
  /** 更新时间（ISO 字符串） */
  updatedAt: string;
  /** 当前激活的空间 ID */
  currentSpaceId: string;
  /** 空间列表 */
  spaces: SpaceIndexItem[];
}

/**
 * 确保目录存在
 */
async function ensureFolder(app: App, path: string): Promise<void> {
  if (!path) return;
  const p = normalizePath(path);
  const parts = p.split("/").filter(Boolean);
  let cur = "";
  for (const seg of parts) {
    cur = cur ? `${cur}/${seg}` : seg;
    try {
      const ok = await app.vault.adapter.exists(cur);
      if (!ok) await app.vault.createFolder(cur);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes("Folder already exists") || msg.includes("EEXIST")) continue;
      // keep going best-effort
    }
  }
}

/**
 * 写入 JSON 文件
 */
async function writeJson(app: App, path: string, obj: any): Promise<void> {
  const p = normalizePath(path);
  await ensureFolder(app, p.split("/").slice(0, -1).join("/"));
  const text = JSON.stringify(obj, null, 2);
  const ok = await app.vault.adapter.exists(p);
  if (ok) {
    await app.vault.adapter.write(p, text);
    return;
  }
  await app.vault.create(p, text);
}

export class SpacesIndexService {
  constructor(
    private app: App,
    private settingsRef: () => RSLattePluginSettings
  ) {}

  /**
   * 获取中央索引目录
   */
  private getCentralIndexDir(): string {
    const s = this.settingsRef();
    return normalizePath((s?.centralIndexDir ?? "00-System/.rslatte").trim() || "00-System/.rslatte");
  }

  /**
   * 获取 spaces-index.json 文件路径
   */
  private getIndexFilePath(): string {
    const baseDir = this.getCentralIndexDir();
    return normalizePath(`${baseDir}/spaces-index.json`);
  }

  /**
   * 从设置中提取空间信息并生成索引
   */
  private buildSpacesIndex(): SpacesIndex {
    const s = this.settingsRef();
    const spacesMap: Record<string, RSLatteSpaceConfig> = (s as any)?.spaces ?? {};
    const currentSpaceId = String((s as any)?.currentSpaceId ?? "");
    const now = new Date().toISOString();

    const spaces: SpaceIndexItem[] = Object.values(spacesMap)
      .filter((sp) => sp && sp.id)
      .map((sp) => {
        const snapshot = (sp as any)?.settingsSnapshot || {};
        const diaryPath = snapshot.diaryPath || s.diaryPath || "";
        const diaryNameFormat = snapshot.diaryNameFormat || s.diaryNameFormat || "YYYYMMDD";

        return {
          id: String(sp.id ?? "").trim(),
          name: String(sp.name ?? sp.id ?? "").trim() || String(sp.id ?? ""),
          spaceNumber: typeof sp.spaceNumber === "number" ? sp.spaceNumber : undefined,
          createdAt: String(sp.createdAt ?? now),
          updatedAt: String(sp.updatedAt ?? now),
          isCurrent: sp.id === currentSpaceId,
          diaryPath: diaryPath || undefined,
          diaryNameFormat: diaryNameFormat || undefined,
        };
      })
      .sort((a, b) => {
        // 当前空间排在第一位
        if (a.isCurrent && !b.isCurrent) return -1;
        if (!a.isCurrent && b.isCurrent) return 1;
        // 然后按名称排序
        return a.name.localeCompare(b.name);
      });

    return {
      version: 1,
      updatedAt: now,
      currentSpaceId: currentSpaceId || "",
      spaces,
    };
  }

  /**
   * 更新 spaces-index.json 文件
   */
  async updateIndex(): Promise<void> {
    try {
      const index = this.buildSpacesIndex();
      const path = this.getIndexFilePath();
      await writeJson(this.app, path, index);
    } catch (e: any) {
      console.warn("[RSLatte] Failed to update spaces-index.json:", e);
      // 不抛出错误，避免影响主流程
    }
  }
}
