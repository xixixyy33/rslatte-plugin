/**
 * 机构名相似度提示（跨分类汇总 institutionNames）
 */

import { normFinanceInstitution } from "./financeCyclePlan";

function normKey(s: string): string {
  return normFinanceInstitution(s).toLowerCase();
}

/** 小编辑距离（仅用于短字符串） */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1);
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[n]!;
}

function isIgnored(typedKey: string, ignoreList: string[] | undefined): boolean {
  if (!typedKey || !ignoreList?.length) return false;
  const set = new Set(ignoreList.map((x) => normKey(String(x ?? ""))).filter(Boolean));
  return set.has(typedKey);
}

/**
 * 返回建议机构名列表（不含与输入完全相同的项；不强制）
 */
export function suggestSimilarInstitutionNames(
  typed: string,
  allNames: string[],
  ignoreList?: string[]
): string[] {
  const raw = normFinanceInstitution(typed);
  if (raw.length < 2) return [];
  const typedKey = normKey(raw);
  if (isIgnored(typedKey, ignoreList)) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  const maxDist = raw.length <= 8 ? 1 : 2;

  for (const n of allNames) {
    const name = normFinanceInstitution(n);
    if (!name) continue;
    const nk = normKey(name);
    if (nk === typedKey) continue;
    if (seen.has(nk)) continue;

    let hit = false;
    if (typedKey.length >= 2 && nk.length >= 2) {
      if (nk.includes(typedKey) || typedKey.includes(nk)) hit = true;
    }
    if (!hit && levenshtein(typedKey, nk) <= maxDist) hit = true;

    if (hit) {
      seen.add(nk);
      out.push(name);
      if (out.length >= 5) break;
    }
  }
  return out;
}

/** 从设置中收集全部机构名（所有分类） */
export function collectAllFinanceInstitutionNames(financeCategories: { institutionNames?: string[] }[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const cat of financeCategories ?? []) {
    for (const x of cat?.institutionNames ?? []) {
      const v = normFinanceInstitution(String(x ?? ""));
      if (!v) continue;
      const k = v.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(v);
    }
  }
  return out;
}
