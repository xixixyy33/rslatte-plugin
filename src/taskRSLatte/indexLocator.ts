import type { RSLatteParsedLine } from "./types";

/**
 * Index locator (uid-first)
 *
 * - Prefer uid for stable matching.
 * - Fallback to filePath#lineNo for legacy entries or when uid is missing.
 */
export type IndexLocator = {
  posByUid: Map<string, number>;
  posByLoc: Map<string, number>;
};

export function buildIndexLocator(items: Array<Pick<RSLatteParsedLine, "uid" | "filePath" | "lineNo">>): IndexLocator {
  const posByUid = new Map<string, number>();
  const posByLoc = new Map<string, number>();

  (items ?? []).forEach((it: any, i: number) => {
    const uid = String(it?.uid ?? "").trim();
    if (uid) posByUid.set(uid, i);
    posByLoc.set(`${it.filePath}#${it.lineNo}`, i);
  });

  return { posByUid, posByLoc };
}

export function findIndexPos(locator: IndexLocator, hint: { uid?: string; filePath: string; lineNo: number }): number | null {
  const uid = String(hint?.uid ?? "").trim();
  if (uid) {
    const u = locator.posByUid.get(uid);
    if (u !== undefined) return u;
  }
  const k = `${hint.filePath}#${hint.lineNo}`;
  const v = locator.posByLoc.get(k);
  return v === undefined ? null : v;
}
