import { normalizePath } from "obsidian";

import { DEFAULT_SETTINGS } from "../../constants/defaults";
import { DEFAULT_SPACE_ID } from "../../constants/space";
import type { RSLattePluginSettings } from "../../types/settings";
import type { RSLatteSpaceConfig } from "../../types/space";
import { extractPerSpaceSettings } from "./spaceSettings";

/** 与《空间管理优化方案》一致：含默认空间 1，共 7 个；3、9 保留给 30-/90- 语义，不分配 */
export const ALLOWED_SPACE_NUMBERS = [1, 2, 4, 5, 6, 7, 8] as const;

export function isAllowedSpaceNumber(n: number): boolean {
  return (ALLOWED_SPACE_NUMBERS as readonly number[]).includes(n);
}

/** 默认根目录前缀：`{编号}0-`，如 `20-` */
export function buildDefaultRootPrefix(spaceNum: number): string {
  return `${spaceNum}0-`;
}

export function validateDefaultRootSuffix(suffix: string): { ok: true; value: string } | { ok: false; message: string } {
  const v = String(suffix ?? "").trim();
  if (!v) return { ok: false, message: "请填写默认根目录后缀" };
  if (/[\/\\]/.test(v)) return { ok: false, message: "后缀中不能包含路径分隔符" };
  if (!/^[A-Za-z0-9\u4e00-\u9fff. _-]+$/.test(v)) {
    return { ok: false, message: "后缀仅允许字母、数字、中文、空格、._-" };
  }
  return { ok: true, value: v };
}

/**
 * 为「新增空间」挑选下一个可用编号（不含 1，1 仅默认空间）。
 * 已满返回 null。
 */
export function pickNextAvailableSpaceNumberForNewSpace(spaceList: RSLatteSpaceConfig[]): number | null {
  const used = new Set<number>();
  for (const sp of spaceList) {
    const n = sp.spaceNumber;
    if (typeof n === "number" && isAllowedSpaceNumber(n)) used.add(n);
  }
  const free = (ALLOWED_SPACE_NUMBERS as readonly number[]).find((num) => num !== 1 && !used.has(num));
  return free === undefined ? null : free;
}

/**
 * 迁移：默认空间固定编号 1；其余空间按可用编号顺序补齐。
 */
export function migrateSpaceNumbersInSettings(spaces: Record<string, RSLatteSpaceConfig>): boolean {
  let changed = false;

  if (spaces[DEFAULT_SPACE_ID]) {
    if (spaces[DEFAULT_SPACE_ID].spaceNumber !== 1) {
      spaces[DEFAULT_SPACE_ID].spaceNumber = 1;
      changed = true;
    } else if (spaces[DEFAULT_SPACE_ID].spaceNumber == null) {
      spaces[DEFAULT_SPACE_ID].spaceNumber = 1;
      changed = true;
    }
  }

  const used = new Set<number>();
  for (const sp of Object.values(spaces)) {
    const n = sp?.spaceNumber;
    if (typeof n === "number" && isAllowedSpaceNumber(n)) used.add(n);
  }

  for (const id of Object.keys(spaces)) {
    if (id === DEFAULT_SPACE_ID) continue;
    if (typeof spaces[id].spaceNumber === "number" && isAllowedSpaceNumber(spaces[id].spaceNumber!)) continue;
    const free = (ALLOWED_SPACE_NUMBERS as readonly number[]).find((num) => num !== 1 && !used.has(num));
    if (free === undefined) break;
    spaces[id].spaceNumber = free;
    used.add(free);
    changed = true;
  }

  return changed;
}

function seg(spaceNumStr: string, tail: string): string {
  return `${spaceNumStr}${tail}`;
}

/**
 * 按《空间管理优化方案》§2「其他空间」列生成空间级目录快照（不含 centralIndexDir 等全局项）。
 */
export function buildSettingsSnapshotForNewSpace(
  spaceNum: number,
  defaultRootRaw: string,
  baseDefaults: RSLattePluginSettings = DEFAULT_SETTINGS as unknown as RSLattePluginSettings,
): Partial<RSLattePluginSettings> {
  const n = String(spaceNum);
  const R = normalizePath(defaultRootRaw.trim());
  const snap = extractPerSpaceSettings(baseDefaults) as Record<string, unknown>;

  snap.diaryPath = `${R}/${seg(n, "1-Daily")}/diary`;
  snap.diaryTemplate = baseDefaults.diaryTemplate;

  const tp = (snap.taskPanel as Record<string, unknown> | undefined) ?? {};
  snap.taskPanel = {
    ...tp,
    taskFolders: [`${R}/${seg(n, "1-Daily")}`],
  };

  const cap = baseDefaults.captureModule
    ? (JSON.parse(JSON.stringify(baseDefaults.captureModule)) as Record<string, unknown>)
    : {};
  snap.captureModule = {
    ...cap,
    captureInboxDir: `${R}/${seg(n, "7-Inbox")}`,
    captureArchiveDir: `90-Archive/${R}/${seg(n, "7-Inbox")}/`,
  };

  snap.projectRootDir = `${R}/${seg(n, "3-Projects")}`;
  snap.projectArchiveDir = `90-Archive/${R}/${seg(n, "3-Projects")}`;
  snap.projectTasklistTemplatePath = baseDefaults.projectTasklistTemplatePath;
  snap.projectInfoTemplatePath = baseDefaults.projectInfoTemplatePath;
  snap.projectAnalysisTemplatePath = baseDefaults.projectAnalysisTemplatePath;

  const op = (snap.outputPanel as Record<string, unknown> | undefined) ?? {};
  snap.outputPanel = {
    ...op,
    archiveRootDir: `90-Archive/${R}/${seg(n, "2-Notes")}`,
    archiveRoots: [`${R}/${seg(n, "2-Notes")}`],
  };

  const cm = (snap.contactsModule as Record<string, unknown> | undefined) ?? {};
  snap.contactsModule = {
    ...cm,
    contactsDir: `${R}/${seg(n, "5-Contacts")}`,
    archiveDir: `90-Archive/${R}/${seg(n, "5-Contacts")}`,
  };

  // 与其它业务模块一致：新空间默认启用「健康」；健康模块自动归档默认勾选
  const me2 = { ...((snap.moduleEnabledV2 as Record<string, boolean> | undefined) ?? {}) };
  me2.health = true;
  snap.moduleEnabledV2 = me2 as RSLattePluginSettings["moduleEnabledV2"];
  const hp0 = (snap.healthPanel as Record<string, unknown> | undefined) ?? {};
  snap.healthPanel = {
    ...hp0,
    autoArchiveEnabled: true,
  } as RSLattePluginSettings["healthPanel"];

  return snap as Partial<RSLattePluginSettings>;
}
