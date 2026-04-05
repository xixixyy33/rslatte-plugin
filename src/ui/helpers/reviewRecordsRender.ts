import { Notice, TFile } from "obsidian";
import type RSLattePlugin from "../../main";
import { VIEW_TYPE_REVIEW } from "../../constants/viewTypes";
import { buildReviewExecuteModel } from "./reviewExecuteModel";
import { formatReviewExecuteModelForPeriodReportPaste } from "./reviewExecutePlainTextForPaste";
import {
  withJournalSpaceOverride,
  type ReviewPeriodReportSlotModel,
  type ReviewRecordsModel,
} from "./reviewRecordsModel";
import type { ReviewRecordRichLine } from "./reviewRecordsSummaryAnalysis";
import { navigateReviewTimeline, type ReviewTimelineNav } from "./reviewTimelineNavigate";

function refreshReviewLeaves(plugin: RSLattePlugin): void {
  try {
    for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_REVIEW)) {
      const v = leaf.view as { refresh?: () => void };
      v?.refresh?.();
    }
  } catch {
    // ignore
  }
}

function journalBarCharsReview(count: number, max: number, width = 8): string {
  if (max <= 0 || count <= 0) return "·".repeat(width);
  const n = Math.min(width, Math.max(1, Math.round((count / max) * width)));
  return "█".repeat(n) + "·".repeat(width - n);
}

function richLineClass(tone: ReviewRecordRichLine["tone"]): string {
  switch (tone) {
    case "muted":
      return "rslatte-review-records-line--muted";
    case "encourage":
      return "rslatte-review-records-line--encourage";
    case "warn":
      return "rslatte-review-records-line--warn";
    case "danger":
      return "rslatte-review-records-line--danger";
    default:
      return "";
  }
}
/** 渲染 Review「记录」页签：与「执行 / 核对」同系信息架构 — 本页侧重 → 周期简报 → A → B → C → D */
export function renderReviewRecordsBody(host: HTMLElement, model: ReviewRecordsModel, plugin: RSLattePlugin): void {
  host.empty();
  host.addClass("rslatte-review-records");

  const scope = host.createDiv({ cls: "rslatte-review-records-block" });
  scope.createDiv({ cls: "rslatte-review-records-block-title", text: "本页侧重" });
  scope.createDiv({
    cls: "rslatte-review-reconcile-note rslatte-muted",
    text: `周期 ${model.startYmd}～${model.endYmd} · 本页仅汇总打卡、财务、健康、日记（与 §4.3a 记录四域一致）。任务/提醒/日程/项目/输出/联系人见「执行」；已闭环及时性与环比见「核对」。${
      model.workEventEnabled
        ? " 操作日志已开启：A 区打卡/财务/健康优先以日志计数，索引可在对应项为 0 时垫补。"
        : " 操作日志未开启：A 区打卡/财务/健康来自台账索引；B 区时间轴无数据；请以芯片数字为准。"
    }`,
  });

  const pr = model.periodReports;
  const grain = model.grain;
  const showWeeklyPartition =
    grain === "week" && !!pr?.weekly && plugin.settings.reviewPeriodReportShowWeekly !== false;
  const showMonthlyPartition =
    grain === "month" && !!pr?.monthly && plugin.settings.reviewPeriodReportShowMonthly !== false;
  const showQuarterlyPartition =
    grain === "quarter" && !!pr?.quarterly && plugin.settings.reviewPeriodReportShowQuarterly !== false;

  if (showWeeklyPartition || showMonthlyPartition || showQuarterlyPartition) {
    const prHost = host.createDiv({ cls: "rslatte-review-records-block rslatte-review-period-reports-block" });
    prHost.createDiv({
      cls: "rslatte-review-records-block-title",
      text: showWeeklyPartition ? "周期周报" : showMonthlyPartition ? "周期月报" : "周期季报",
    });

    const appendCopyExecSummaryButton = (row: HTMLElement) => {
      const copyExecBtn = row.createEl("button", {
        cls: "rslatte-review-period-report-copy-exec",
        text: "复制执行摘要",
      });
      copyExecBtn.title =
        "复制当前周期「执行」页的 A 总览数字 + C 分模块摘要（Markdown），便于贴入周报/月报/季报";
      copyExecBtn.onclick = () => {
        void (async () => {
          try {
            const execModel = await buildReviewExecuteModel(
              plugin,
              model.startYmd,
              model.endYmd,
              model.grain,
            );
            const md = formatReviewExecuteModelForPeriodReportPaste(execModel);
            await navigator.clipboard.writeText(md);
            new Notice("已复制本周期执行摘要，可到周报/月报/季报中粘贴");
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            new Notice(`复制失败：${msg}`);
            console.error("[RSLatte] copy execute summary for period report failed", e);
          }
        })();
      };
    };

    if (showWeeklyPartition) {
      prHost.createDiv({
        cls: "rslatte-review-reconcile-note rslatte-muted",
        text: `当前为「周」视图。以周期起点 ${model.startYmd} 得 ISO 周键；文件在「日记路径」的上一级下的 weekly/（与日记根目录同级）。子窗口见设置「Review 周报 · 子窗口」；字数忽略空白与整行 ---。`,
      });
    } else if (showMonthlyPartition) {
      prHost.createDiv({
        cls: "rslatte-review-reconcile-note rslatte-muted",
        text: `当前为「月」视图。历月取 ${model.startYmd} 所在月；文件在「日记路径」的上一级下的 monthly/（与日记根目录同级）。子窗口见设置「Review 月报 · 子窗口」。`,
      });
    } else {
      prHost.createDiv({
        cls: "rslatte-review-reconcile-note rslatte-muted",
        text: `当前为「季」视图。历季取 ${model.startYmd} 所在历季；文件在「日记路径」的上一级下的 quarterly/（与日记根目录同级）。子窗口见设置「Review 季报 · 子窗口」。`,
      });
    }

    const mountSlot = (slot: ReviewPeriodReportSlotModel) => {
      const wrap = prHost.createDiv({ cls: "rslatte-review-period-report-slot" });
      const btnRow = wrap.createDiv({ cls: "rslatte-review-period-report-actions" });
      const btn = btnRow.createEl("button", {
        cls: `rslatte-review-period-report-btn${slot.exists ? " rslatte-review-period-report-btn--exists" : " rslatte-review-period-report-btn--missing"}`,
        text:
          slot.kind === "weekly"
            ? `周报 ${slot.periodLabel}`
            : slot.kind === "monthly"
              ? `月报 ${slot.periodLabel}`
              : `季报 ${slot.periodLabel}`,
      });
      btn.title = slot.exists ? "已存在：点击打开" : "不存在：点击按模板创建并打开";
      btn.onclick = () => {
        void (async () => {
          try {
            const file = await withJournalSpaceOverride(plugin, async () =>
              plugin.journalSvc.ensureWeeklyOrMonthlyReportFile({
                vaultPath: slot.vaultPath,
                templatePath: slot.templatePath,
                anchorYmd: slot.anchorYmd,
                weekKey: slot.weekKey,
                monthKey: slot.monthKey,
                quarterKey: slot.quarterKey,
              }),
            );
            await plugin.app.workspace.getLeaf(false).openFile(file);
            refreshReviewLeaves(plugin);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            new Notice(`周期简报创建或打开失败：${msg}`);
            console.error("[RSLatte] period report open/create failed", e);
          }
        })();
      };

      appendCopyExecSummaryButton(btnRow);

      if (slot.panelsConfigured === false) {
        wrap.createDiv({
          cls: "rslatte-review-reconcile-note rslatte-muted",
          text:
            slot.kind === "weekly"
              ? "设置中未配置「Review 周报 · 子窗口」表时，仅显示按钮，不统计周报分区字数。"
              : slot.kind === "monthly"
                ? "设置中未配置「Review 月报 · 子窗口」表时，仅显示按钮，不统计月报分区字数。"
                : "设置中未配置「Review 季报 · 子窗口」表时，仅显示按钮，不统计季报分区字数。",
        });
        return;
      }

      if (!slot.exists) return;

      const statTitle = wrap.createDiv({
        cls: "rslatte-review-period-report-stats-title rslatte-muted",
        text: `有意义字合计 ${slot.totalChars}`,
      });
      statTitle.style.marginTop = "6px";
      statTitle.style.fontSize = "12px";

      const maxC = Math.max(1, ...slot.panelChars.map((x) => x.count));
      for (const x of slot.panelChars) {
        const row = wrap.createDiv({
          cls: "rslatte-review-period-report-panel-row rslatte-review-period-report-panel-row--clickable",
        });
        row.title = "点击打开该周期简报并定位到本子窗口内容区";
        const label = row.createSpan({ cls: "rslatte-review-period-report-panel-label" });
        label.createSpan({ cls: "rslatte-today-records-subwindow-tag", text: "子窗口" });
        label.createSpan({ text: ` ${x.label} ${x.count}` });
        row.createSpan({
          cls: "rslatte-review-period-report-panel-bar rslatte-muted",
          text: journalBarCharsReview(x.count, maxC),
        });
        row.onclick = () => {
          void (async () => {
            try {
              await withJournalSpaceOverride(plugin, async () =>
                plugin.journalSvc.ensureWeeklyOrMonthlyReportFile({
                  vaultPath: slot.vaultPath,
                  templatePath: slot.templatePath,
                  anchorYmd: slot.anchorYmd,
                  weekKey: slot.weekKey,
                  monthKey: slot.monthKey,
                  quarterKey: slot.quarterKey,
                }),
              );
              const line = await withJournalSpaceOverride(plugin, async () =>
                plugin.journalSvc.getJournalPanelJumpLine1Based(slot.vaultPath, x.heading),
              );
              if (line == null) {
                const af = plugin.app.vault.getAbstractFileByPath(slot.vaultPath);
                if (af instanceof TFile) await plugin.app.workspace.getLeaf(false).openFile(af);
                new Notice(
                  x.heading.trim()
                    ? "未在文档中找到该子窗口对应标题，已仅打开文件"
                    : "该子窗口未配置标题，已仅打开文件",
                );
                refreshReviewLeaves(plugin);
                return;
              }
              await plugin.noteNavigator.openNoteAtLineViewOnly(slot.vaultPath, line);
              refreshReviewLeaves(plugin);
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              new Notice(`打开或定位失败：${msg}`);
              console.error("[RSLatte] period report panel jump failed", e);
            }
          })();
        };
      }
    };

    const activeSlot = showWeeklyPartition
      ? pr?.weekly
      : showMonthlyPartition
        ? pr?.monthly
        : pr?.quarterly;
    if (activeSlot) mountSlot(activeSlot);
  }

  const blockA = host.createDiv({ cls: "rslatte-review-records-block" });
  blockA.createDiv({ cls: "rslatte-review-records-block-title", text: "A 周期记录摘要" });
  blockA.createDiv({
    cls: "rslatte-review-exec-mod-line rslatte-muted",
    text: "以下为周期内计数；芯片可跳转对应侧栏。日记「天」= 至少一个已配置日记面板内有有效字内容的日子（非 WorkEvent）。",
  });
  const row = blockA.createDiv({ cls: "rslatte-review-records-stats" });
  const addSummaryChip = (
    text: string,
    section: "checkin" | "finance" | "health" | "journal",
    hint?: string,
  ) => {
    const el = row.createSpan({ cls: "rslatte-review-records-chip rslatte-review-records-chip--clickable", text });
    const parts = [hint, "点击打开对应侧栏"].filter(Boolean);
    el.title = parts.join(" · ");
    el.onclick = () => void navigateReviewTimeline(plugin, { type: "record_summary", section });
  };

  const c = model.counts;
  addSummaryChip(`打卡✓${c.checkinRecords}`, "checkin", "条：日志 checkin+create，或为 0 时用索引垫补");
  addSummaryChip(`财务💰${c.financeRecords}`, "finance", "条：日志 finance+create 且记账日在周期内，或为 0 时用索引垫补");
  addSummaryChip(`健康📝${c.healthRecords}`, "health", "条：日志 health+create，或为 0 时用索引；记录摘要·健康含去重日");
  addSummaryChip(`日记📔${c.journalDaysWithContent}天`, "journal", "周期内至少一面板有有效字的天数");

  const blockB = host.createDiv({ cls: "rslatte-review-records-block" });
  blockB.createDiv({ cls: "rslatte-review-records-block-title", text: "B 时间分析 · 记录类轴" });
  blockB.createDiv({
    cls: "rslatte-review-reconcile-note rslatte-muted",
    text: `抽样展示打卡/财务/健康三类 WorkEvent，按时间倒序，最多 ${model.timelineSampleCap} 条；与执行页任务类时间轴隔离。正文经内链折叠为显示名（与执行提醒同源）。`,
  });
  if (model.timelineNote) {
    blockB.createDiv({ cls: "rslatte-review-records-note rslatte-muted", text: model.timelineNote });
  }
  if (model.timeline.length === 0 && model.workEventEnabled && !model.timelineNote) {
    blockB.createDiv({
      cls: "rslatte-review-records-empty rslatte-muted",
      text: "本周期内无打卡/财务/健康相关操作日志（或均被过滤）。",
    });
  } else if (model.timeline.length > 0) {
    let lastYmd = "";
    const list = blockB.createDiv({ cls: "rslatte-review-records-timeline" });
    for (const trow of model.timeline) {
      if (trow.ymd !== lastYmd) {
        lastYmd = trow.ymd;
        list.createDiv({ cls: "rslatte-review-records-timeline-day", text: trow.ymd });
      }
      const lineEl = list.createDiv({ cls: "rslatte-review-tl-line" });
      lineEl.createSpan({ cls: "rslatte-review-tl-time rslatte-muted", text: trow.hhmm });
      const main = lineEl.createDiv({ cls: "rslatte-review-tl-main" });
      main.createSpan({
        cls: `rslatte-review-tl-tag rslatte-review-tl-mod rslatte-review-tl-mod--${trow.moduleFamily}`,
        text: trow.moduleLabel,
      });
      main.createSpan({ cls: "rslatte-review-tl-tag rslatte-review-tl-act", text: trow.actionLabel });
      main.createSpan({ cls: "rslatte-review-tl-content", text: trow.contentText });

      if (trow.nav.type !== "none") {
        lineEl.addClass("rslatte-review-tl-line--clickable");
        lineEl.title = "点击打开对应模块";
        lineEl.onclick = () => void navigateReviewTimeline(plugin, trow.nav);
      }
    }
  }

  const blockC = host.createDiv({ cls: "rslatte-review-records-block" });
  blockC.createDiv({ cls: "rslatte-review-records-block-title", text: "C 记录摘要" });
  blockC.createDiv({
    cls: "rslatte-review-reconcile-note rslatte-muted",
    text: `按四域分列分析报告（打卡履行/财务告警/健康达标与规则/日记子类字数环比）。A 区条数与下列统计同源或互补；健康台账句仍保留，月快照以周期末所在月为准。`,
  });

  /** C 区小节：整区可点，跳转对应侧栏（无底部文字链） */
  const appendRichSub = (
    title: string,
    richLines: ReviewRecordRichLine[],
    tailNote: string | undefined,
    nav: ReviewTimelineNav | undefined,
    clickHint?: string,
  ) => {
    const sub = blockC.createDiv({ cls: "rslatte-review-records-subsection" });
    if (nav) {
      sub.addClass("rslatte-review-records-subsection--clickable");
      sub.title = clickHint ?? "点击打开对应侧栏";
      sub.onclick = () => void navigateReviewTimeline(plugin, nav);
    }
    sub.createDiv({ cls: "rslatte-review-records-subtitle", text: title });
    for (const rl of richLines) {
      const extra = richLineClass(rl.tone);
      sub.createDiv({
        cls: ["rslatte-review-exec-mod-line", extra].filter(Boolean).join(" "),
        text: rl.text,
      });
    }
    if (tailNote) {
      sub.createDiv({ cls: "rslatte-review-records-note rslatte-muted", text: tailNote });
    }
  };

  const appendPlainLinesSub = (
    title: string,
    bodyLines: string[],
    tailNote: string | undefined,
    nav: ReviewTimelineNav | undefined,
  ) => {
    const rich: ReviewRecordRichLine[] = bodyLines.map((text) => ({ text }));
    appendRichSub(title, rich, tailNote, nav);
  };

  const checkinTail =
    [model.workEventEnabled ? undefined : "未开操作日志时，索引口径与今日记录一致。", model.checkinAnalysisNote]
      .filter(Boolean)
      .join(" ") || undefined;
  appendRichSub(
    "打卡",
    [
      {
        text: `周期 ${model.startYmd}～${model.endYmd}：台账 ${c.checkinRecords} 条（A 区同源）。`,
        tone: "muted",
      },
      ...model.checkinAnalysisLines,
    ],
    checkinTail,
    { type: "record_summary", section: "checkin" },
    "点击本区任意位置打开打卡侧栏",
  );

  const financeTail =
    [model.workEventEnabled ? undefined : "未开操作日志时，条数与 A 区芯片同源（索引）。", model.financeAnalysisNote]
      .filter(Boolean)
      .join(" ") || undefined;
  appendRichSub(
    "财务",
    [
      {
        text: `周期 ${model.startYmd}～${model.endYmd}：台账 ${c.financeRecords} 条（A 区同源）。`,
        tone: "muted",
      },
      ...model.financeAnalysisLines,
    ],
    financeTail,
    { type: "record_summary", section: "finance" },
    "点击本区任意位置打开财务侧栏 · 台账",
  );

  const healthSub = blockC.createDiv({
    cls: "rslatte-review-records-subsection rslatte-review-records-subsection--clickable",
  });
  healthSub.title = "点击本区任意位置打开健康侧栏 · 统计";
  healthSub.onclick = () => void navigateReviewTimeline(plugin, { type: "health_stats" });
  healthSub.createDiv({ cls: "rslatte-review-records-subtitle", text: "健康" });
  for (const line of model.healthSummaryLines) {
    healthSub.createDiv({ cls: "rslatte-review-exec-mod-line", text: line });
  }
  if (model.healthSummaryNote) {
    healthSub.createDiv({ cls: "rslatte-review-records-note rslatte-muted", text: model.healthSummaryNote });
  }
  for (const rl of model.healthAnalysisExtraLines) {
    const extra = richLineClass(rl.tone);
    healthSub.createDiv({
      cls: ["rslatte-review-exec-mod-line", extra].filter(Boolean).join(" "),
      text: rl.text,
    });
  }
  if (model.healthAnalysisExtraNote) {
    healthSub.createDiv({ cls: "rslatte-review-records-note rslatte-muted", text: model.healthAnalysisExtraNote });
  }

  const panelsOn = plugin.settings.showJournalPanels !== false;
  const panels = plugin.settings.journalPanels ?? [];
  if (!panelsOn || panels.length === 0) {
    appendPlainLinesSub(
      "日记",
      ["当前未启用可扫描的日记面板（设置中关闭或未配置面板）。"],
      undefined,
      undefined,
    );
  } else {
    const journalTail =
      [
        `周期内「至少一面板有有效字」的天数：${c.journalDaysWithContent} 天（A 区芯片）。`,
        model.journalAnalysisNote,
      ]
        .filter(Boolean)
        .join(" ") || undefined;
    appendRichSub(
      "日记",
      model.journalAnalysisLines,
      journalTail,
      { type: "record_summary", section: "journal" },
      "点击本区任意位置打开 RSLatte 侧栏 · 日记区",
    );
  }

  const blockD = host.createDiv({ cls: "rslatte-review-records-block" });
  blockD.createDiv({ cls: "rslatte-review-records-block-title", text: "D 周期纪要" });
  blockD.createDiv({
    cls: "rslatte-review-exec-mod-line rslatte-muted",
    text: "由 A 区四类计数自动拼句（非 LLM）；健康含「N 天有记」时与索引去重日一致。",
  });
  for (const line of model.periodMemoLines) {
    blockD.createDiv({ cls: "rslatte-review-exec-mod-line", text: line });
  }
}
