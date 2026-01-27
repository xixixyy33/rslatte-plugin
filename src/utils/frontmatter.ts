import type { App, TFile } from "obsidian";

function escapeRegExp(s: string): string {
  return String(s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function safeRead(app: App, file: TFile): Promise<string> {
  try {
    return await app.vault.read(file);
  } catch {
    return "";
  }
}

/**
 * YAML 标量格式化：尽量用 JSON.stringify 生成双引号字符串，避免 ':' '#' 等导致 YAML 歧义。
 *
 * 注意：这不是完整 YAML 序列化，仅用于单行 `key: value` 的安全写入。
 */
export function formatYamlScalar(v: any): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  const s = String(v);
  return JSON.stringify(s);
}

/**
 * 仅修改文件头部 YAML frontmatter（文本级别），避免触发 processFrontMatter 在某些 Excalidraw 文件上的重写副作用。
 *
 * 规则：
 * - 若文件以 --- 开头且存在 frontmatter，则只替换/补齐指定 key 的“单行值”。
 * - 若不存在 frontmatter，则在文件开头插入一个新的 frontmatter。
 * - 不触碰其余正文（尤其是 Excalidraw 的 ```compressed-json 块）。
 */
export async function patchYamlFrontmatterText(app: App, file: TFile, updates: Record<string, any>): Promise<void> {
  const text = await safeRead(app, file);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const cleanUpdates: Array<[string, any]> = Object.entries(updates || {}).filter(([k]) => !!String(k || "").trim());
  if (cleanUpdates.length === 0) return;

  const fmMatch = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!fmMatch) {
    // 插入新 frontmatter（保持正文完全不变）
    const fmLines = cleanUpdates.map(([k, v]) => `${k}: ${formatYamlScalar(v)}`.trimEnd());
    const injected = ["---", ...fmLines, "---", ""].join(eol) + text;
    await app.vault.modify(file, injected);
    return;
  }

  const fmText = fmMatch[1];
  const fmLines = fmText.split(/\r?\n/);

  const setLine = (key: string, value: any) => {
    const re = new RegExp(`^(${escapeRegExp(key)})\\s*:\\s*(.*)$`);
    const idx = fmLines.findIndex((l) => re.test(l));
    const newLine = `${key}: ${formatYamlScalar(value)}`.trimEnd();
    if (idx >= 0) fmLines[idx] = newLine;
    else fmLines.push(newLine);
  };

  for (const [k, v] of cleanUpdates) setLine(k, v);

  const newFmBlock = ["---", ...fmLines, "---"].join(eol);
  const after = text.slice(fmMatch[0].length);
  const next = newFmBlock + eol + after;
  await app.vault.modify(file, next);
}

/**
 * 简易 frontmatter 读取：默认优先 metadataCache；缺失时从文本解析一层 key:value（单行）。
 *
 * 注意：当文件刚被 plugin 写入（例如 processFrontMatter / modify）时，metadataCache 可能短时间
 * 仍返回旧值。此时可传入 { preferCache: false } 来强制从文本读取，确保 UI 立即反映最新状态。
 */
export async function readFrontmatter(
  app: App,
  file: TFile,
  opts?: { preferCache?: boolean }
): Promise<Record<string, any>> {
  const preferCache = opts?.preferCache !== false;
  if (preferCache) {
    const cached = app.metadataCache.getFileCache(file)?.frontmatter;
    if (cached) return { ...cached };
  }

  const text = await safeRead(app, file);
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return {};
  const fmText = m[1];
  const out: Record<string, any> = {};
  for (const line of fmText.split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z0-9_\-]+)\s*:\s*(.*?)\s*$/);
    if (!mm) continue;
    const k = mm[1];
    let v: any = mm[2];
    v = v.replace(/^['"]|['"]$/g, "");
    out[k] = v;
  }
  return out;
}
