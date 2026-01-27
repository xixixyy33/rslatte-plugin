import { App, TFile } from "obsidian";

/**
 * Compute a stable sortname for contacts.
 *
 * - English / digits: normalized upper-case string.
 * - Chinese: best-effort Pinyin INITIALS using localeCompare boundaries (zero-dependency).
 *
 * This is designed for A-Z grouping and predictable ordering.
 */

// 23 letters (no I, U, V) commonly used by Chinese pinyin initial mapping
const LETTERS = "ABCDEFGHJKLMNOPQRSTWXYZ";
// 23 boundary characters used to map a Han character to its pinyin initial via localeCompare
// Ref: widely used front-end mapping trick (阿/八/嚓/…/匝)
//
// NOTE: In some Chromium/ICU builds, using "昔" as the X-boundary can mis-bucket
// characters like "西" into W (because "西" may sort before "昔").
// Using "西" as the X-boundary is more stable for common names (西/谢/肖/…)
// while keeping the overall A-Z bucketing behavior.
const BOUNDARIES = "阿八嚓哒妸发旮哈讥咔垃麻拏噢啪期然撒塌挖西压匝";

const zhCollator = new Intl.Collator("zh-Hans-u-co-pinyin", {
  usage: "sort",
  sensitivity: "base",
  numeric: true,
  ignorePunctuation: true,
});

function isAsciiLetterOrDigit(ch: string): boolean {
  return /^[A-Za-z0-9]$/.test(ch);
}

function isHan(ch: string): boolean {
  // CJK Unified Ideographs (basic plane) is enough for most names
  return /[\u4E00-\u9FFF]/.test(ch);
}

function mapHanToInitial(ch: string): string {
  if (!ch) return "#";
  // Anything <= first boundary is 'A'
  if (zhCollator.compare(ch, BOUNDARIES[0]) < 0) return "A";

  for (let i = 0; i < LETTERS.length - 1; i++) {
    const b0 = BOUNDARIES[i];
    const b1 = BOUNDARIES[i + 1];
    if (zhCollator.compare(ch, b0) >= 0 && zhCollator.compare(ch, b1) < 0) {
      return LETTERS[i];
    }
  }
  // last bucket: >= 匝
  return LETTERS[LETTERS.length - 1];
}

/**
 * Compute sortname.
 *
 * Example:
 * - "李四" -> "LS"
 * - "John Doe" -> "JOHN DOE"
 */
export function computeSortname(displayName: string): string {
  const raw = (displayName ?? "").trim();
  if (!raw) return "";

  const out: string[] = [];
  for (const ch of raw) {
    if (isAsciiLetterOrDigit(ch)) {
      out.push(ch.toUpperCase());
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      // keep a single space for readability (English)
      if (out.length > 0 && out[out.length - 1] !== " ") out.push(" ");
      continue;
    }
    if (isHan(ch)) {
      out.push(mapHanToInitial(ch));
      continue;
    }
    // skip punctuation/symbols
  }

  const s = out.join("").replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Ensure frontmatter.sortname exists and matches computed value.
 * Best-effort; failures should not break the main flow.
 */
export async function ensureSortnameInFrontmatter(app: App, file: TFile, displayName: string): Promise<void> {
  const desired = computeSortname(displayName);
  if (!desired) return;

  try {
    // metadataCache may be stale; we only use it to avoid unnecessary writes
    const cached = app.metadataCache.getFileCache(file)?.frontmatter as any;
    const cur = typeof cached?.sortname === "string" ? String(cached.sortname).trim() : "";
    if (cur === desired) return;

    await app.fileManager.processFrontMatter(file, (fm: any) => {
      const now = typeof fm.sortname === "string" ? String(fm.sortname).trim() : "";
      if (now !== desired) fm.sortname = desired;
    });

    // processFrontMatter may fail silently for dot-folders or stale caches.
    // Verify the actual file text contains sortname in YAML; if not, fallback to raw patch.
    const ok = await verifyYamlHasSortname(app, file);
    if (!ok) {
      await fallbackPatchSortname(app, file, desired);
    }
  } catch {
    // swallow errors; do not block index rebuild
    try {
      await fallbackPatchSortname(app, file, desired);
    } catch {
      // ignore
    }
  }
}

async function verifyYamlHasSortname(app: App, file: TFile): Promise<boolean> {
  try {
    const text = await app.vault.cachedRead(file);
    const fm = extractFrontmatterBlock(text);
    if (!fm) return false;
    return /^\s*sortname\s*:/m.test(fm);
  } catch {
    return false;
  }
}

function extractFrontmatterBlock(text: string): string | null {
  const src = text ?? "";
  if (!src.startsWith("---")) return null;
  const idx = src.indexOf("\n---", 3);
  if (idx < 0) return null;
  // include trailing newline after opening --- for regex simplicity
  return src.slice(0, idx + 4);
}

/**
 * Fallback patch: directly edit file text to ensure YAML has sortname.
 * Best-effort; keeps other frontmatter keys intact.
 */
async function fallbackPatchSortname(app: App, file: TFile, desired: string): Promise<void> {
  const text = await app.vault.read(file);
  const src = text ?? "";

  // Case 1: has YAML frontmatter
  if (src.startsWith("---")) {
    const end = src.indexOf("\n---", 3);
    if (end > 0) {
      const fmBlock = src.slice(0, end + 4);
      const rest = src.slice(end + 4);

      // Update existing sortname line if present
      if (/^\s*sortname\s*:/m.test(fmBlock)) {
        const updated = fmBlock.replace(/^\s*sortname\s*:\s*.*$/m, `sortname: ${desired}`);
        if (updated !== fmBlock) {
          await app.vault.modify(file, updated + rest);
        }
        return;
      }

      // Insert sortname after display_name if present, else before closing ---
      let insertAt = fmBlock.lastIndexOf("\n---");
      const m = fmBlock.match(/^\s*display_name\s*:\s*.*$/m);
      if (m && typeof m.index === "number") {
        // insert on next line after display_name line
        const lineEnd = fmBlock.indexOf("\n", m.index);
        if (lineEnd >= 0) insertAt = lineEnd + 1;
      }

      const patched = fmBlock.slice(0, insertAt) + `sortname: ${desired}\n` + fmBlock.slice(insertAt);
      await app.vault.modify(file, patched + rest);
      return;
    }
  }

  // Case 2: no YAML frontmatter -> create one
  const patched = `---\nsortname: ${desired}\n---\n` + src;
  await app.vault.modify(file, patched);
}

/**
 * Get group bucket letter from sortname.
 */
export function bucketFromSortname(sortname: string, fallbackName?: string): string {
  const s = (sortname ?? "").trim();
  const first = s ? s[0] : ((fallbackName ?? "").trim()[0] ?? "");
  if (!first) return "#";
  if (/[A-Za-z]/.test(first)) return first.toUpperCase();
  return "#";
}
