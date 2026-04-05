import type RSLattePlugin from "../../main";
import type { ReviewReconcileModel } from "./reviewReconcileModel";

function fmtDelta(n: number): string {
  if (n > 0) return `+${n}`;
  return String(n);
}

/**
 * Review「核对」页：已闭环及时性（任务/日程/提醒）、环比、输出·项目·联系人客观事实与启发式建议。
 */
export function renderReviewReconcileBody(host: HTMLElement, model: ReviewReconcileModel, _plugin: RSLattePlugin): void {
  void _plugin;
  host.empty();
  host.addClass("rslatte-review-reconcile");

  const scope = host.createDiv({ cls: "rslatte-review-records-block" });
  scope.createDiv({ cls: "rslatte-review-records-block-title", text: "本页侧重" });
  scope.createDiv({
    cls: "rslatte-review-reconcile-note rslatte-muted",
    text: `周期 ${model.startYmd}～${model.endYmd} · 用索引中本周期「已完成」算任务/日程/提醒及时性；用「完成/新建」与项目快照完结、操作日志（发布、联系人动态）等做环比或并列展示。不含开放项清单。详见「执行」页产出与日程耗时；健康/财务见「记录」页。`,
  });

  const blockA = host.createDiv({ cls: "rslatte-review-records-block" });
  blockA.createDiv({ cls: "rslatte-review-records-block-title", text: "A 及时性（基于本周期已闭环记录）" });
  const t = model.timeliness;
  blockA.createDiv({
    cls: "rslatte-review-exec-mod-line",
    text: `任务：本周期内闭环且带有计划结束日的 ${t.taskWithDueClosed} 条中，按时（完成日 ≤ 计划结束日）${t.taskOnTime}、偏晚 ${t.taskLate}；及时率 ${t.taskOnTimeRateText}`,
  });
  blockA.createDiv({
    cls: "rslatte-review-exec-mod-line",
    text: `日程：本周期内标记完成的日程 ${t.scheduleClosedInPeriod} 条，其中完成日与日程日为同一天 ${t.scheduleSameDayClose} 条；当日闭环占比 ${t.scheduleSameDayRateText}`,
  });
  const memoOntime = t.memoDoneWithReminderYmd - t.memoDoneLateAfterReminderYmd;
  blockA.createDiv({
    cls: "rslatte-review-exec-mod-line",
    text: `提醒：本周期内完成且已设置提醒日（memoDate）的 ${t.memoDoneWithReminderYmd} 条中，在提醒日及之前勾选完成 ${memoOntime}、晚于提醒日才完成 ${t.memoDoneLateAfterReminderYmd}；及时率 ${t.memoOnTimeRateText}`,
  });

  const blockB = host.createDiv({ cls: "rslatte-review-records-block" });
  blockB.createDiv({ cls: "rslatte-review-records-block-title", text: "B 较上一同期" });
  const v = model.vsPrev;
  const f = model.periodFacts;
  if (!v.hasPrev) {
    blockB.createDiv({ cls: "rslatte-review-records-note rslatte-muted", text: "无法计算上一等长周期（日期无效）。" });
  } else {
    blockB.createDiv({
      cls: "rslatte-review-records-note rslatte-muted",
      text: `对比区间：${v.prevRangeText}（与当前周期等长）`,
    });
    blockB.createDiv({
      cls: "rslatte-review-exec-mod-line",
      text: `完成：任务 ${fmtDelta(v.tasksDoneDelta)} · 提醒 ${fmtDelta(v.memosDoneDelta)} · 日程 ${fmtDelta(
        v.schedulesDoneDelta,
      )} · 输出 ${fmtDelta(v.outputsDoneDelta)} · 项目完结 ${fmtDelta(v.projectsDoneDelta)}（快照 status=done 且 done 日落在周期内）`,
    });
    blockB.createDiv({
      cls: "rslatte-review-exec-mod-line",
      text: `新增：任务 ${fmtDelta(v.tasksNewDelta)} · 提醒 ${fmtDelta(v.memosNewDelta)} · 日程 ${fmtDelta(
        v.schedulesNewDelta,
      )} · 输出 ${fmtDelta(v.outputsNewDelta)} · 新建联系人 ${fmtDelta(v.contactCreatesDelta)}`,
    });
    blockB.createDiv({
      cls: "rslatte-review-exec-mod-line",
      text: `日志（开操作日志时）：输出发布 ${fmtDelta(v.outputsPublishedDelta)} · 联系人相关事件合计 ${fmtDelta(
        v.contactEventsDelta,
      )}（含新建以外的互动；新建见上行）`,
    });
  }

  blockB.createDiv({ cls: "rslatte-review-reconcile-section-title", text: "本周期事实（与环比并列理解）" });
  blockB.createDiv({
    cls: "rslatte-review-exec-mod-line rslatte-muted",
    text: `项目完结 ${f.projectsDone} 个 · 输出发布（日志）${f.outputsPublished} 次 · 联系人动态（日志）${f.contactEvents} 条 · 长周期完成输出（创建→完成≥21天）${f.outputsDoneLongCycle} 篇`,
  });

  const blockC = host.createDiv({ cls: "rslatte-review-records-block" });
  blockC.createDiv({ cls: "rslatte-review-records-block-title", text: "C 建议（基于 A/B 与周期事实）" });
  if (model.suggestions.length === 0) {
    blockC.createDiv({ cls: "rslatte-review-reconcile-empty rslatte-muted", text: "暂无自动生成的改进句；可结合 A/B 区自行复盘。" });
  } else {
    for (const s of model.suggestions) {
      blockC.createDiv({ cls: "rslatte-review-exec-mod-line", text: s });
    }
  }
}
