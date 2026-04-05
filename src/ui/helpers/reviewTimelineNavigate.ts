import { Notice, normalizePath, TFile } from "obsidian";
import type RSLattePlugin from "../../main";
import { VIEW_TYPE_PROJECTS, VIEW_TYPE_TASKS } from "../../constants/viewTypes";
import { ProjectSidePanelView } from "../views/ProjectSidePanelView";
import { TaskSidePanelView } from "../views/TaskSidePanelView";

/** Review 记录页时间轴点击跳转（由 WorkEvent ref 推导） */
export type ReviewTimelineNav =
  | { type: "none" }
  | { type: "task_panel"; mode: "task" | "memo" | "schedule"; filePath: string; lineNo: number }
  | {
      type: "project_panel";
      projectKey: string;
      milestonePath?: string;
      taskFilePath?: string;
      taskLineNo?: number;
    }
  | { type: "health"; entryId?: string; recordDate?: string }
  | { type: "finance"; entryId?: string; recordDate?: string }
  | { type: "checkin"; checkinId?: string; recordDate?: string }
  | { type: "open_file"; filePath: string }
  | { type: "sidebar"; target: "project" | "contacts" | "output" | "capture" | "finance" | "health" | "checkin" | "task" }
  /** Review「A 周期记录摘要」chip：打开对应侧栏并切到相关子页签 */
  | { type: "record_summary"; section: "checkin" | "finance" | "health" | "journal" }
  /** Review 记录页 C·健康小节：打开健康侧栏「统计」页签（health-analysis） */
  | { type: "health_stats" };

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function afterTaskView(plugin: RSLattePlugin, fn: (v: TaskSidePanelView) => void | Promise<void>): Promise<void> {
  const act = (plugin as any).activateTaskView as (() => Promise<void>) | undefined;
  if (act) await act();
  await delay(220);
  const leaves = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_TASKS);
  const v = leaves[0]?.view;
  if (v instanceof TaskSidePanelView) await fn(v);
}

export async function navigateReviewTimeline(plugin: RSLattePlugin, nav: ReviewTimelineNav): Promise<void> {
  try {
    switch (nav.type) {
      case "none":
        return;
      case "task_panel": {
        const fp = normalizePath(nav.filePath);
        const ln = nav.lineNo;
        if (nav.mode === "task") {
          await afterTaskView(plugin, (v) => void v.focusTaskRowByFileLine(fp, ln));
        } else if (nav.mode === "memo") {
          await afterTaskView(plugin, (v) => void v.focusMemoRowByFileLine(fp, ln));
        } else {
          await afterTaskView(plugin, (v) => void v.focusScheduleByFileLine(fp, ln));
        }
        return;
      }
      case "project_panel": {
        const act = (plugin as any).activateProjectView as (() => Promise<void>) | undefined;
        if (act) await act();
        await delay(280);
        const leaves = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_PROJECTS);
        const v = leaves[0]?.view;
        if (v instanceof ProjectSidePanelView) {
          const tf = String(nav.taskFilePath ?? "").trim() ? normalizePath(String(nav.taskFilePath)) : "";
          const tl = nav.taskLineNo;
          const hasTaskPin =
            !!tf && tl !== undefined && Number.isFinite(tl) && tl >= 0;
          await v.scrollToProject(
            nav.projectKey,
            nav.milestonePath?.trim() || undefined,
            hasTaskPin ? tf : undefined,
            hasTaskPin ? tl : undefined,
          );
        }
        return;
      }
      case "health_stats": {
        const h = (plugin as any).activateHealthView as
          | ((o?: { contentTab?: "ledger" | "stats" }) => Promise<void>)
          | undefined;
        await h?.({ contentTab: "stats" });
        return;
      }
      case "health": {
        const h = (plugin as any).activateHealthView as
          | ((o?: { entryId?: string; recordDate?: string; contentTab?: "ledger" | "stats" }) => Promise<void>)
          | undefined;
        if (!h) return;
        const eid = String(nav.entryId ?? "").trim();
        const rd = String(nav.recordDate ?? "").trim();
        if (eid && rd) await h({ entryId: eid, recordDate: rd });
        else await h(rd ? { contentTab: "ledger" } : undefined);
        return;
      }
      case "finance": {
        const f = (plugin as any).activateFinanceView as
          | ((o?: { entryId?: string; recordDate?: string; contentTab?: "ledger" | "stats" }) => Promise<void>)
          | undefined;
        if (!f) return;
        const eid = String(nav.entryId ?? "").trim();
        const rd = String(nav.recordDate ?? "").trim();
        if (eid && rd) await f({ entryId: eid, recordDate: rd });
        else await f({ contentTab: "ledger" });
        return;
      }
      case "checkin": {
        const c = (plugin as any).activateCheckinView as
          | ((o?: { recordDate?: string; checkinId?: string }) => Promise<void>)
          | undefined;
        if (!c) return;
        const rd = String(nav.recordDate ?? "").trim();
        const cid = String(nav.checkinId ?? "").trim();
        if (rd && cid) await c({ recordDate: rd, checkinId: cid });
        else await c();
        return;
      }
      case "open_file": {
        const p = normalizePath(nav.filePath);
        const af = plugin.app.vault.getAbstractFileByPath(p);
        if (af instanceof TFile) {
          const leaf = plugin.app.workspace.getLeaf(false);
          await leaf.openFile(af);
        } else {
          new Notice("未找到对应文件");
        }
        return;
      }
      case "record_summary": {
        const p = plugin as any;
        const sec = nav.section;
        if (sec === "finance") {
          await p.activateFinanceView?.({ contentTab: "ledger" });
          return;
        }
        if (sec === "health") {
          await p.activateHealthView?.({ contentTab: "ledger" });
          return;
        }
        if (sec === "checkin") {
          await p.activateCheckinView?.();
          return;
        }
        if (sec === "journal") {
          await p.activateRSLatteView?.({ inspectSection: "journal" });
          return;
        }
        return;
      }
      case "sidebar": {
        const p = plugin as any;
        switch (nav.target) {
          case "project":
            await p.activateProjectView?.();
            break;
          case "contacts":
            await p.activateContactsView?.();
            break;
          case "output":
            await p.activateOutputView?.();
            break;
          case "capture":
            await p.activateCaptureView?.();
            break;
          case "finance":
            await p.activateFinanceView?.({ contentTab: "ledger" });
            break;
          case "health":
            await p.activateHealthView?.({ contentTab: "ledger" });
            break;
          case "checkin":
            await p.activateCheckinView?.();
            break;
          case "task":
            await p.activateTaskView?.();
            break;
          default:
            break;
        }
        return;
      }
      default:
        return;
    }
  } catch (e: any) {
    console.warn("[RSLatte] navigateReviewTimeline failed:", e);
    new Notice(`跳转失败：${e?.message ?? String(e)}`);
  }
}
