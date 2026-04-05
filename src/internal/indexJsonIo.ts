import { App, TFile, TFolder, normalizePath } from "obsidian";

/**
 * 中央索引 JSON / 文本索引读写薄封装（**[X-JSON-IO]**，《索引优化方案》§8）。
 *
 * **§8.6（《代码结构优化方案》）**：task / record / output / project / contacts 五域各自的 **`indexStore.ts`**（各 `*RSLatte` 包内）已统一经本模块
 * **`readJsonVaultFirst` / `writeJsonRaceSafe`** 或 **`readTextVaultFirst` / `writeTextRaceSafe`**；vault 优先读、adapter 回退、写路径竞态处理。
 * **勾选表**：`docs/CODE_MAP.md` §3.11「§8.6 各 `*IndexStore`」。
 *
 * **约束**：新增「中央/空间分桶」类索引 JSON 时，**禁止**再新增裸 **`vault.adapter.write(..., JSON.stringify(...))`** 主路径，应走本模块或先抽成 `*IndexStore` 再接入。
 */

export type IndexJsonIoContext = {
  /** 错误信息前缀，如 RSLatteIndexStore */
  label: string;
};

function conflictDetail(ctx: IndexJsonIoContext, detail: string): string {
  return `${ctx.label}: ${detail}`;
}

/**
 * 逐级创建目录；路径上某段若为已存在文件则抛错（与现 IndexStore 一致）。
 */
export async function ensureFolderChain(app: App, path: string, ctx: IndexJsonIoContext): Promise<void> {
  const norm = normalizePath(path).replace(/\/+$/g, "");
  if (!norm) return;

  const parts = norm.split("/").filter(Boolean);
  let cur = "";
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p;
    const af = app.vault.getAbstractFileByPath(cur);
    if (af && af instanceof TFile) {
      throw new Error(conflictDetail(ctx, `path conflicts with an existing file: ${cur}`));
    }
    if (!af) {
      try {
        await app.vault.createFolder(cur);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (msg.includes("Folder already exists") || msg.includes("EEXIST")) {
          continue;
        }
        throw e;
      }
    }
  }
}

/** 该路径上存在可读 TFile，或 adapter 报告文件存在（用于主路径 / Legacy 路径判定）。 */
export async function pathExistsVaultOrAdapter(app: App, path: string): Promise<boolean> {
  const norm = normalizePath(path);
  const af = app.vault.getAbstractFileByPath(norm);
  if (af instanceof TFile) return true;
  try {
    return await app.vault.adapter.exists(norm);
  } catch {
    return false;
  }
}

/**
 * 先 vault（TFile）再 adapter；JSON 解析失败或 IO 异常返回 fallback。
 */
export async function readJsonVaultFirst<T>(app: App, path: string, fallback: T): Promise<T> {
  const norm = normalizePath(path);

  const af = app.vault.getAbstractFileByPath(norm);
  if (af instanceof TFile) {
    try {
      const raw = await app.vault.read(af);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  }

  try {
    const exists = await app.vault.adapter.exists(norm);
    if (!exists) return fallback;
    const raw = await app.vault.adapter.read(norm);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 先 vault（TFile）再 adapter；读失败或文件不存在返回 `null`（与联系人索引原 `readTextFile` 一致）。
 */
export async function readTextVaultFirst(app: App, path: string): Promise<string | null> {
  const norm = normalizePath(path);

  const af = app.vault.getAbstractFileByPath(norm);
  if (af instanceof TFile) {
    try {
      return await app.vault.read(af);
    } catch {
      return null;
    }
  }

  try {
    const exists = await app.vault.adapter.exists(norm);
    if (!exists) return null;
    return await app.vault.adapter.read(norm);
  } catch {
    return null;
  }
}

async function writeRawRaceSafe(app: App, path: string, content: string, ctx: IndexJsonIoContext): Promise<void> {
  const norm = normalizePath(path);
  await ensureFolderChain(app, norm.split("/").slice(0, -1).join("/"), ctx);

  const existing = app.vault.getAbstractFileByPath(norm);

  if (existing instanceof TFile) {
    await app.vault.modify(existing, content);
    return;
  }
  if (existing instanceof TFolder) {
    throw new Error(conflictDetail(ctx, `file path conflicts with an existing folder: ${norm}`));
  }

  try {
    await app.vault.create(norm, content);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.includes("File already exists") || msg.includes("EEXIST")) {
      const af2 = app.vault.getAbstractFileByPath(norm);
      if (af2 instanceof TFile) {
        await app.vault.modify(af2, content);
        return;
      }
      await app.vault.adapter.write(norm, content);
      return;
    }
    throw e;
  }
}

/**
 * 原始文本写入；父目录 ensure；create 遇 EEXIST 则 modify 或 adapter.write（供联系人索引 + `safeJsonParse` 链路）。
 */
export async function writeTextRaceSafe(app: App, path: string, text: string, ctx: IndexJsonIoContext): Promise<void> {
  await writeRawRaceSafe(app, path, text ?? "", ctx);
}

/**
 * `JSON.stringify(obj, null, 2)` 写入；父目录 ensure；create 遇 EEXIST 则 modify 或 adapter.write。
 */
export async function writeJsonRaceSafe(app: App, path: string, obj: unknown, ctx: IndexJsonIoContext): Promise<void> {
  const content = JSON.stringify(obj, null, 2);
  await writeRawRaceSafe(app, path, content, ctx);
}
