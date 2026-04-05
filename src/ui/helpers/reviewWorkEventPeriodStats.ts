import { moment, normalizePath } from "obsidian";
import type RSLattePlugin from "../../main";
import type { ProjectEntry } from "../../projectManager/types";
import type { WorkEvent } from "../../types/stats/workEvent";

const momentFn = moment as any;

function ymdInRange(ymd: string, startYmd: string, endYmd: string): boolean {
  const s = String(ymd ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return s >= startYmd && s <= endYmd;
}

function progressUpdatedLocalYmd(s?: string): string {
  const m = String(s ?? "").trim();
  if (!m) return "";
  const head = m.match(/^(\d{4}-\d{2}-\d{2})/);
  if (head) return head[1];
  const d = momentFn(m);
  return d.isValid() ? d.format("YYYY-MM-DD") : "";
}

function workEventTsLocalYmd(ts: string): string {
  const d = momentFn(String(ts ?? "").trim());
  return d.isValid() ? d.format("YYYY-MM-DD") : "";
}

/** 与 `projectManager` 写入的 WorkEvent.ref 对齐 */
function workEventRefProjectKey(ref?: Record<string, unknown>): string {
  if (!ref || typeof ref !== "object") return "";
  const pid = String(ref.project_id ?? ref.projectId ?? "").trim();
  if (pid) return pid;
  return normalizePath(String(ref.folder_path ?? ref.folderPath ?? "").trim());
}

function isProjectProgressWorkEventKind(kind: string): boolean {
  const k = String(kind ?? "");
  return k === "project" || k === "milestone" || k === "projecttask";
}

/** 同一联系人在列表中只保留一条：优先 `ref.contact_uid`，否则 `ref.file_path` */
function workEventContactDedupKey(e: WorkEvent): string | null {
  const ref = (e.ref ?? {}) as Record<string, unknown>;
  const uid = String(ref.contact_uid ?? ref.contactUid ?? "").trim();
  if (uid) return `u:${uid}`;
  const fp = normalizePath(String(ref.file_path ?? ref.filePath ?? "").trim());
  if (fp) return `p:${fp}`;
  return null;
}

export function projectKeyOfEntry(p: ProjectEntry): string {
  const pid = String(p.projectId ?? "").trim();
  if (pid) return pid;
  return normalizePath(String(p.folderPath ?? "").trim());
}

function isProjectActiveEntry(p: ProjectEntry): boolean {
  const st = String(p.status ?? "").toLowerCase();
  return st !== "done" && st !== "cancelled";
}

/** 单周期内从操作日志聚合的计数 + 项目推进映射（与 Review 执行/核对共用） */
export type ReviewPeriodWorkEventAggregates = {
  outputsPublished: number;
  /** 全部联系人相关事件（执行页「联系人动态」） */
  contactEvents: number;
  /** 新建联系人（核对页环比用，不含更新/归档等推进类） */
  contactCreates: number;
  outputsNew: number;
  tasksCreated: number;
  memosCreated: number;
  schedulesCreated: number;
  projectProgressLastYmdByKey: Map<string, string>;
  /** 周期内 project / milestone / projecttask 事件条数（用于执行页总览 ⏩） */
  projectProgressEventCount: number;
  /** 周期内 kind=project & action=create */
  projectsCreated: number;
  /**
   * 周期内日记任务「进度类」操作日志条数：task 且非 create/done/cancelled（用于执行页总览 ⏩）
   */
  tasksProgressEventCount: number;
  /**
   * 周期内输出「进度类」操作日志：非 create/publish/done/cancelled（用于执行页总览 ⏩）
   */
  outputsProgressEventCount: number;
  /** 周期内联系人动态展示用：同一联系人仅保留 ts 最新一条，再按 ts 降序取最多 3 条（执行页 C 区） */
  contactSamples: WorkEvent[];
  /** 各项目周期内 project/milestone/projecttask 事件，按 ts 降序各最多 3 条 */
  projectProgressRecentByKey: Map<string, WorkEvent[]>;
};

const EMPTY_AGG: ReviewPeriodWorkEventAggregates = {
  outputsPublished: 0,
  contactEvents: 0,
  contactCreates: 0,
  outputsNew: 0,
  tasksCreated: 0,
  memosCreated: 0,
  schedulesCreated: 0,
  projectProgressLastYmdByKey: new Map(),
  projectProgressEventCount: 0,
  projectsCreated: 0,
  tasksProgressEventCount: 0,
  outputsProgressEventCount: 0,
  contactSamples: [],
  projectProgressRecentByKey: new Map(),
};

/**
 * 读取 [startYmd, endYmd] 内 WorkEvent 聚合。未开启操作日志时返回全 0 与空 Map。
 */
export async function readReviewPeriodWorkEventAggregates(
  plugin: RSLattePlugin,
  startYmd: string,
  endYmd: string,
): Promise<ReviewPeriodWorkEventAggregates> {
  const svc = plugin.workEventSvc;
  if (!svc?.isEnabled?.()) {
    return {
      outputsPublished: 0,
      contactEvents: 0,
      contactCreates: 0,
      outputsNew: 0,
      tasksCreated: 0,
      memosCreated: 0,
      schedulesCreated: 0,
      projectProgressLastYmdByKey: new Map(),
      projectProgressEventCount: 0,
      projectsCreated: 0,
      tasksProgressEventCount: 0,
      outputsProgressEventCount: 0,
      contactSamples: [],
      projectProgressRecentByKey: new Map(),
    };
  }
  const z: ReviewPeriodWorkEventAggregates = {
    outputsPublished: 0,
    contactEvents: 0,
    contactCreates: 0,
    outputsNew: 0,
    tasksCreated: 0,
    memosCreated: 0,
    schedulesCreated: 0,
    projectProgressLastYmdByKey: new Map(),
    projectProgressEventCount: 0,
    projectsCreated: 0,
    tasksProgressEventCount: 0,
    outputsProgressEventCount: 0,
    contactSamples: [],
    projectProgressRecentByKey: new Map(),
  };
  const projectProgressEventsBuffer = new Map<string, WorkEvent[]>();
  const contactLatestByKey = new Map<string, WorkEvent>();
  const contactEventsNoDedupKey: WorkEvent[] = [];
  try {
    const startM = momentFn(startYmd, "YYYY-MM-DD", true);
    const endM = momentFn(endYmd, "YYYY-MM-DD", true);
    if (!startM.isValid() || !endM.isValid()) return z;
    const evs = await svc.readEventsByDateRange(
      startM.clone().startOf("day").toDate(),
      endM.clone().endOf("day").toDate(),
    );
    for (const e of evs) {
      if (e.kind === "output" && e.action === "publish") z.outputsPublished += 1;
      if (e.kind === "contact") {
        z.contactEvents += 1;
        if (e.action === "create") z.contactCreates += 1;
        const ck = workEventContactDedupKey(e);
        if (ck) {
          const prev = contactLatestByKey.get(ck);
          if (!prev || String(e.ts ?? "").localeCompare(String(prev.ts ?? "")) > 0) contactLatestByKey.set(ck, e);
        } else {
          contactEventsNoDedupKey.push(e);
        }
      }
      if (e.kind === "output" && e.action === "create") z.outputsNew += 1;
      if (e.kind === "task" && e.action === "create") z.tasksCreated += 1;
      if (e.kind === "memo" && e.action === "create") z.memosCreated += 1;
      if (e.kind === "schedule" && e.action === "create") z.schedulesCreated += 1;
      if (e.kind === "project" && e.action === "create") z.projectsCreated += 1;
      const evYmd = workEventTsLocalYmd(String(e.ts ?? ""));
      if (evYmd && ymdInRange(evYmd, startYmd, endYmd)) {
        if (e.kind === "task") {
          const a = String(e.action ?? "");
          if (a !== "create" && a !== "done" && a !== "cancelled") z.tasksProgressEventCount += 1;
        }
        if (e.kind === "output") {
          const a = String(e.action ?? "");
          if (a !== "create" && a !== "publish" && a !== "done" && a !== "cancelled") z.outputsProgressEventCount += 1;
        }
      }
      if (isProjectProgressWorkEventKind(String(e.kind ?? ""))) {
        const ymd = workEventTsLocalYmd(String(e.ts ?? ""));
        if (!ymd || !ymdInRange(ymd, startYmd, endYmd)) continue;
        z.projectProgressEventCount += 1;
        const pk = workEventRefProjectKey(e.ref as Record<string, unknown> | undefined);
        if (pk) {
          const prev = z.projectProgressLastYmdByKey.get(pk);
          if (!prev || ymd > prev) z.projectProgressLastYmdByKey.set(pk, ymd);
          let buf = projectProgressEventsBuffer.get(pk);
          if (!buf) {
            buf = [];
            projectProgressEventsBuffer.set(pk, buf);
          }
          buf.push(e);
        }
      }
    }
  } catch (e) {
    console.warn("[RSLatte] readReviewPeriodWorkEventAggregates failed:", e);
    return { ...EMPTY_AGG, projectProgressLastYmdByKey: new Map(), contactSamples: [], projectProgressRecentByKey: new Map() };
  }
  const contactMerged = [...contactLatestByKey.values(), ...contactEventsNoDedupKey];
  contactMerged.sort((a, b) => String(b.ts ?? "").localeCompare(String(a.ts ?? "")));
  z.contactSamples = contactMerged.slice(0, 3);
  const projectProgressRecentByKey = new Map<string, WorkEvent[]>();
  for (const [pk, list] of projectProgressEventsBuffer) {
    const sorted = [...list].sort((a, b) => String(b.ts ?? "").localeCompare(String(a.ts ?? "")));
    projectProgressRecentByKey.set(pk, sorted.slice(0, 3));
  }
  z.projectProgressRecentByKey = projectProgressRecentByKey;
  return z;
}

/** 活跃项目在本周期是否有推进（与 `buildReviewExecuteModel` 一致） */
export function listProjectsPushedInPeriod(
  projectList: ProjectEntry[],
  workEventEnabled: boolean,
  ag: ReviewPeriodWorkEventAggregates,
  startYmd: string,
  endYmd: string,
): { p: ProjectEntry; pu: string }[] {
  const rows: { p: ProjectEntry; pu: string }[] = [];
  for (const p of projectList) {
    if (!isProjectActiveEntry(p)) continue;
    const pk = projectKeyOfEntry(p);
    let pu = "";
    if (workEventEnabled) {
      pu = ag.projectProgressLastYmdByKey.get(pk) ?? "";
    } else {
      const raw = progressUpdatedLocalYmd(p.progress_updated);
      if (raw && ymdInRange(raw, startYmd, endYmd)) pu = raw;
    }
    if (pu) rows.push({ p, pu });
  }
  rows.sort((a, b) => b.pu.localeCompare(a.pu));
  return rows;
}

export function countProjectsPushedInPeriod(
  projectList: ProjectEntry[],
  workEventEnabled: boolean,
  ag: ReviewPeriodWorkEventAggregates,
  startYmd: string,
  endYmd: string,
): number {
  return listProjectsPushedInPeriod(projectList, workEventEnabled, ag, startYmd, endYmd).length;
}
