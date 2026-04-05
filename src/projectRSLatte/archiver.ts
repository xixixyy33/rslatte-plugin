import type { ProjectArchiveResult, ProjectRSLatteIndexItem } from "./types";
import { isYmd, monthKeyFromYmd, todayYmd } from "../taskRSLatte/utils";
import { ProjectIndexStore } from "./indexStore";
import { normalizeArchiveThresholdDays } from "../constants/defaults";

function ymdMinusDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map((x) => parseInt(x, 10));
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - Math.max(0, days));
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function closedDate(it: ProjectRSLatteIndexItem): string | null {
  const st = String(it.status ?? "").trim().toLowerCase();
  if (st === "pending_archive") {
    return isYmd((it as any).pending_archive_date ?? "") ? String((it as any).pending_archive_date) : null;
  }
  if (st === "cancelled") return isYmd(it.cancelled_date ?? "") ? String(it.cancelled_date) : null;
  return null;
}

/**
 * 归档项目中央索引：把“早于今天-阈值”的待归档 / 已取消项目从主索引搬迁到 archive/project-archive-YYYY-MM.json
 * - 已完成但未标记待归档的不在此按时间迁出（保留在主索引便于随时查看）
 * - 仅影响索引 JSON，不移动笔记文件夹
 */
export async function archiveProjectIndexByMonths(store: ProjectIndexStore, thresholdDays: number): Promise<ProjectArchiveResult> {
  const th = normalizeArchiveThresholdDays(thresholdDays);
  const cutoff = ymdMinusDays(todayYmd(), th);

  await store.ensureLayout();
  const idx = await store.readIndex();
  const mapFile = await store.readArchiveMap();
  const archiveMap = mapFile.map ?? {};

  const keep: ProjectRSLatteIndexItem[] = [];
  const toArchiveByMonth: Record<string, ProjectRSLatteIndexItem[]> = {};

  for (const it of idx.items ?? []) {
    const pid = String((it as any)?.project_id ?? "").trim();
    if (!pid) {
      keep.push(it);
      continue;
    }

    // 已归档过的直接从主索引剔除（避免“原项目仍在目录里”导致反复归档）
    if (archiveMap[pid]) continue;

    const cd = closedDate(it);
    if (!cd || cd >= cutoff) {
      keep.push(it);
      continue;
    }

    const mk = monthKeyFromYmd(cd);
    (toArchiveByMonth[mk] ??= []).push(it);
  }

  let archivedCount = 0;
  const byMonth: Record<string, number> = {};

  for (const [mk, items] of Object.entries(toArchiveByMonth)) {
    const added = await store.appendToArchive(mk, items);
    if (added > 0) {
      archivedCount += added;
      byMonth[mk] = (byMonth[mk] ?? 0) + added;
      for (const it of items) {
        const pid = String((it as any)?.project_id ?? "").trim();
        if (pid) archiveMap[pid] = mk;
      }
    }
  }

  // 落盘
  await store.writeIndex(keep);
  await store.writeArchiveMap(archiveMap);

  return { archivedCount, byMonth, cutoffDate: cutoff };
}
