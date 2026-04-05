import { normalizePath } from "obsidian";
import type RSLattePlugin from "../../main";
import { resolveSpaceBaseDir } from "../../services/space/spaceContext";
import type { ReviewExecuteModel } from "./reviewExecuteModel";
import type { ReviewReconcileModel } from "./reviewReconcileModel";
import type { ReviewRecordsModel } from "./reviewRecordsModel";

/** 默认保留快照版本数（含当前最新；回退会删最新一条） */
export const REVIEW_SNAPSHOT_MAX_VERSIONS = 3;

export type ReviewSnapshotGrain = "week" | "month" | "quarter";

export type ReviewSnapshotIndexMeta = {
  risk: "none" | "partial" | "full_outside";
  retentionStartYmd: string;
  workEventMonthKeys: string[];
};

export type ReviewSnapshotBundleV1 = {
  execute: ReviewExecuteModel;
  reconcile: ReviewReconcileModel;
  records: ReviewRecordsModel;
};

export type ReviewSnapshotVersionV1 = {
  savedAt: string;
  startYmd: string;
  endYmd: string;
  indexMeta: ReviewSnapshotIndexMeta;
  payload: ReviewSnapshotBundleV1;
};

type ReviewSnapshotFileV1 = {
  format: 1;
  spaceId: string;
  grain: ReviewSnapshotGrain;
  periodKey: string;
  versions: ReviewSnapshotVersionV1[];
};

function safePeriodKeyForFile(periodKey: string): string {
  return String(periodKey ?? "")
    .trim()
    .replace(/[^\w.-]+/g, "_");
}

export function reviewSnapshotFilePath(
  plugin: RSLattePlugin,
  spaceId: string,
  grain: ReviewSnapshotGrain,
  periodKey: string,
): string {
  const base = resolveSpaceBaseDir(plugin.settings, spaceId);
  const dir = normalizePath(`${base}/review-snapshots`);
  const pk = safePeriodKeyForFile(periodKey);
  return normalizePath(`${dir}/review-${grain}-${pk}.json`);
}

/** E2 自动刷新封印的「已完成周期」快照：文件名带 `.completed` 便于 exists 快速跳过 */
export function e2CompletedReviewSnapshotFilePath(
  plugin: RSLattePlugin,
  spaceId: string,
  grain: ReviewSnapshotGrain,
  periodKey: string,
): string {
  const base = resolveSpaceBaseDir(plugin.settings, spaceId);
  const dir = normalizePath(`${base}/review-snapshots`);
  const pk = safePeriodKeyForFile(periodKey);
  return normalizePath(`${dir}/review-${grain}-${pk}.completed.json`);
}

const E2_SEAL = "e2_completed_period" as const;

type ReviewE2CompletedFileV1 = {
  format: 1;
  seal: typeof E2_SEAL;
  spaceId: string;
  grain: ReviewSnapshotGrain;
  periodKey: string;
  savedAt: string;
  startYmd: string;
  endYmd: string;
  indexMeta: ReviewSnapshotIndexMeta;
  payload: ReviewSnapshotBundleV1;
};

/** 存在且 JSON 含合法 seal 时视为已完成封印（可跳过生成） */
export async function e2CompletedReviewSnapshotIsSealed(
  plugin: RSLattePlugin,
  spaceId: string,
  grain: ReviewSnapshotGrain,
  periodKey: string,
): Promise<boolean> {
  const path = e2CompletedReviewSnapshotFilePath(plugin, spaceId, grain, periodKey);
  try {
    const ex = await plugin.app.vault.adapter.exists(path);
    if (!ex) return false;
    const raw = await plugin.app.vault.adapter.read(path);
    const j = JSON.parse(raw) as ReviewE2CompletedFileV1;
    return j?.format === 1 && j?.seal === E2_SEAL && !!j?.payload?.execute;
  } catch {
    return false;
  }
}

export async function readE2CompletedReviewSnapshotAsVersion(
  plugin: RSLattePlugin,
  spaceId: string,
  grain: ReviewSnapshotGrain,
  periodKey: string,
): Promise<ReviewSnapshotVersionV1 | null> {
  const path = e2CompletedReviewSnapshotFilePath(plugin, spaceId, grain, periodKey);
  try {
    const ex = await plugin.app.vault.adapter.exists(path);
    if (!ex) return null;
    const raw = await plugin.app.vault.adapter.read(path);
    const j = JSON.parse(raw) as ReviewE2CompletedFileV1;
    if (j?.format !== 1 || j.seal !== E2_SEAL || !j.payload) return null;
    return {
      savedAt: j.savedAt,
      startYmd: j.startYmd,
      endYmd: j.endYmd,
      indexMeta: j.indexMeta,
      payload: j.payload,
    };
  } catch (e) {
    console.warn("[RSLatte] readE2CompletedReviewSnapshotAsVersion failed:", e);
    return null;
  }
}

export async function writeE2CompletedReviewSnapshot(
  plugin: RSLattePlugin,
  spaceId: string,
  grain: ReviewSnapshotGrain,
  periodKey: string,
  startYmd: string,
  endYmd: string,
  indexMeta: ReviewSnapshotIndexMeta,
  payload: ReviewSnapshotBundleV1,
): Promise<void> {
  await ensureSnapshotDir(plugin, spaceId);
  const path = e2CompletedReviewSnapshotFilePath(plugin, spaceId, grain, periodKey);
  const doc: ReviewE2CompletedFileV1 = {
    format: 1,
    seal: E2_SEAL,
    spaceId,
    grain,
    periodKey,
    savedAt: new Date().toISOString(),
    startYmd,
    endYmd,
    indexMeta,
    payload,
  };
  await plugin.app.vault.adapter.write(path, JSON.stringify(doc, null, 2));
}

async function ensureSnapshotDir(plugin: RSLattePlugin, spaceId: string): Promise<string> {
  const base = resolveSpaceBaseDir(plugin.settings, spaceId);
  const dir = normalizePath(`${base}/review-snapshots`);
  const ok = await plugin.app.vault.adapter.exists(dir);
  if (!ok) await plugin.app.vault.adapter.mkdir(dir);
  return dir;
}

async function readSnapshotFile(
  plugin: RSLattePlugin,
  path: string,
): Promise<ReviewSnapshotFileV1 | null> {
  try {
    const ex = await plugin.app.vault.adapter.exists(path);
    if (!ex) return null;
    const raw = await plugin.app.vault.adapter.read(path);
    const j = JSON.parse(raw) as ReviewSnapshotFileV1;
    if (!j || j.format !== 1 || !Array.isArray(j.versions)) return null;
    return j;
  } catch (e) {
    console.warn("[RSLatte] readSnapshotFile failed:", e);
    return null;
  }
}

/** 当前（最新）快照版本；无则 null */
export async function readLatestReviewSnapshotVersion(
  plugin: RSLattePlugin,
  spaceId: string,
  grain: ReviewSnapshotGrain,
  periodKey: string,
): Promise<ReviewSnapshotVersionV1 | null> {
  const h = await readReviewSnapshotHead(plugin, spaceId, grain, periodKey);
  return h.latest;
}

export type ReviewSnapshotHead = {
  latest: ReviewSnapshotVersionV1 | null;
  /** 横幅用：手动多版为真实个数；仅 E2 封印时为 1 */
  totalVersions: number;
  /** 手动 `review-*.json` 内的版本条数（>0 时才允许「回退快照」） */
  manualVersionCount: number;
  /** 当前展示来自 E2 自动封印文件（非手动多版本文件） */
  isE2SealedDisplay: boolean;
};

/** 读快照：优先手动多版本文件；否则回退 E2 `.completed.json` */
/** 读取手动多版本文件中的版本列表（[0] 为最新）；无文件或为空则 `[]`。不含 E2 `.completed.json`。 */
export async function readManualReviewSnapshotVersions(
  plugin: RSLattePlugin,
  spaceId: string,
  grain: ReviewSnapshotGrain,
  periodKey: string,
): Promise<ReviewSnapshotVersionV1[]> {
  const path = reviewSnapshotFilePath(plugin, spaceId, grain, periodKey);
  const doc = await readSnapshotFile(plugin, path);
  const v = doc?.versions;
  if (!Array.isArray(v) || v.length === 0) return [];
  return v.slice();
}

export async function readReviewSnapshotHead(
  plugin: RSLattePlugin,
  spaceId: string,
  grain: ReviewSnapshotGrain,
  periodKey: string,
): Promise<ReviewSnapshotHead> {
  const path = reviewSnapshotFilePath(plugin, spaceId, grain, periodKey);
  const doc = await readSnapshotFile(plugin, path);
  const versions = doc?.versions ?? [];
  const manualLatest = versions[0] ?? null;
  const manualVersionCount = versions.length;
  if (manualLatest) {
    return {
      latest: manualLatest,
      totalVersions: manualVersionCount,
      manualVersionCount,
      isE2SealedDisplay: false,
    };
  }
  const e2 = await readE2CompletedReviewSnapshotAsVersion(plugin, spaceId, grain, periodKey);
  if (e2) {
    return {
      latest: e2,
      totalVersions: 1,
      manualVersionCount: 0,
      isE2SealedDisplay: true,
    };
  }
  return { latest: null, totalVersions: 0, manualVersionCount: 0, isE2SealedDisplay: false };
}

export async function listReviewSnapshotVersionCount(
  plugin: RSLattePlugin,
  spaceId: string,
  grain: ReviewSnapshotGrain,
  periodKey: string,
): Promise<number> {
  const h = await readReviewSnapshotHead(plugin, spaceId, grain, periodKey);
  return h.totalVersions;
}

export async function appendReviewSnapshotVersion(
  plugin: RSLattePlugin,
  spaceId: string,
  grain: ReviewSnapshotGrain,
  periodKey: string,
  version: ReviewSnapshotVersionV1,
): Promise<void> {
  await ensureSnapshotDir(plugin, spaceId);
  const path = reviewSnapshotFilePath(plugin, spaceId, grain, periodKey);
  let doc = await readSnapshotFile(plugin, path);
  if (!doc) {
    doc = { format: 1, spaceId, grain, periodKey, versions: [] };
  }
  doc.versions.unshift(version);
  if (doc.versions.length > REVIEW_SNAPSHOT_MAX_VERSIONS) {
    doc.versions = doc.versions.slice(0, REVIEW_SNAPSHOT_MAX_VERSIONS);
  }
  await plugin.app.vault.adapter.write(path, JSON.stringify(doc, null, 2));
}

/**
 * 回退：删除最新一条版本；若无版本则删文件。
 * @returns 剩余版本数
 */
export async function rollbackLatestReviewSnapshot(
  plugin: RSLattePlugin,
  spaceId: string,
  grain: ReviewSnapshotGrain,
  periodKey: string,
): Promise<number> {
  const path = reviewSnapshotFilePath(plugin, spaceId, grain, periodKey);
  const doc = await readSnapshotFile(plugin, path);
  if (!doc || doc.versions.length === 0) return 0;
  doc.versions.shift();
  if (doc.versions.length === 0) {
    try {
      await plugin.app.vault.adapter.remove(path);
    } catch (e) {
      console.warn("[RSLatte] rollback snapshot remove file failed:", e);
    }
    return 0;
  }
  await plugin.app.vault.adapter.write(path, JSON.stringify(doc, null, 2));
  return doc.versions.length;
}
