import { normalizePath } from "obsidian";
import { DEFAULT_SPACE_ID } from "../../constants/space";
import type { RSLattePluginSettings } from "../../types/settings";
import type { RSLatteSpaceConfig, SpaceCtx, SpaceId } from "../../types/space";

function fallbackDefaultSpace(): RSLatteSpaceConfig {
  return {
    id: DEFAULT_SPACE_ID,
    name: "默认空间",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function getSpaceConfig(settings: RSLattePluginSettings, spaceId: SpaceId): RSLatteSpaceConfig {
  const spaces = settings.spaces || {};
  const hit = spaces[spaceId];
  if (hit && typeof hit === "object") {
    // best-effort: ensure id and name
    const name = String(hit.name ?? "").trim();
    const id = hit.id || spaceId;
    return { 
      ...hit, 
      id,
      // 如果 name 为空，使用默认名称（基于 id）
      name: name || (id === DEFAULT_SPACE_ID ? "默认空间" : `空间 ${id.slice(0, 8)}`),
    };
  }
  const def = spaces[DEFAULT_SPACE_ID];
  if (def && typeof def === "object") {
    const defName = String(def.name ?? "").trim();
    return { 
      ...def, 
      id: def.id || DEFAULT_SPACE_ID,
      name: defName || "默认空间",
    };
  }
  return fallbackDefaultSpace();
}

export function getCurrentSpaceId(settings: RSLattePluginSettings): SpaceId {
  const cur = (settings.currentSpaceId || "").trim();
  if (cur && (settings.spaces?.[cur] ?? null)) return cur;
  return DEFAULT_SPACE_ID;
}

export function buildSpaceCtx(settings: RSLattePluginSettings, spaceId?: SpaceId): SpaceCtx {
  const sid = (spaceId || getCurrentSpaceId(settings) || DEFAULT_SPACE_ID).trim() || DEFAULT_SPACE_ID;
  const space = getSpaceConfig(settings, sid);
  return {
    vaultId: String(settings.vaultId || "").trim(),
    spaceId: sid,
    space,
  };
}

/**
 * Resolve the *root* directory used for all on-disk artifacts (index/queue/stats/events).
 *
 * Priority:
 * - settings.centralIndexDir (new unified field)
 * - extraCandidates (module legacy overrides)
 * - settings.taskPanel.rslatteIndexDir (legacy)
 * - default: 00-System/.rslatte (V2)
 */
export function resolveCentralRootDir(settings: RSLattePluginSettings, extraCandidates?: Array<string | undefined | null>): string {
  const s: any = settings as any;
  const candidates: string[] = [];
  const push = (v: any) => {
    const t = String(v ?? "").trim();
    if (t) candidates.push(t);
  };
  push(s?.centralIndexDir);
  for (const c of extraCandidates ?? []) push(c);
  push(s?.taskPanel?.rslatteIndexDir);
  push("00-System/.rslatte");
  const out = candidates.find((x) => !!x) || "00-System/.rslatte";
  return normalizePath(out);
}

/** Space base folder: <centralRoot>/<spaceId> */
export function resolveSpaceBaseDir(settings: RSLattePluginSettings, spaceId?: SpaceId, extraCandidates?: Array<string | undefined | null>): string {
  const sid = (spaceId || getCurrentSpaceId(settings) || DEFAULT_SPACE_ID).trim() || DEFAULT_SPACE_ID;
  const root = resolveCentralRootDir(settings, extraCandidates);
  return normalizePath(`${root}/${sid}`);
}

/** Index folder: <centralRoot>/<spaceId>/index */
export function resolveSpaceIndexDir(settings: RSLattePluginSettings, spaceId?: SpaceId, extraCandidates?: Array<string | undefined | null>): string {
  return normalizePath(`${resolveSpaceBaseDir(settings, spaceId, extraCandidates)}/index`);
}

/** Queue folder: <centralRoot>/<spaceId>/queue */
export function resolveSpaceQueueDir(settings: RSLattePluginSettings, spaceId?: SpaceId, extraCandidates?: Array<string | undefined | null>): string {
  return normalizePath(`${resolveSpaceBaseDir(settings, spaceId, extraCandidates)}/queue`);
}

/** Stats folder: <centralRoot>/<spaceId>/stats */
export function resolveSpaceStatsDir(settings: RSLattePluginSettings, spaceId?: SpaceId, extraCandidates?: Array<string | undefined | null>): string {
  return normalizePath(`${resolveSpaceBaseDir(settings, spaceId, extraCandidates)}/stats`);
}

/** Events folder: <centralRoot>/<spaceId>/.events */
export function resolveSpaceEventsDir(settings: RSLattePluginSettings, spaceId?: SpaceId, extraCandidates?: Array<string | undefined | null>): string {
  return normalizePath(`${resolveSpaceBaseDir(settings, spaceId, extraCandidates)}/.events`);
}
