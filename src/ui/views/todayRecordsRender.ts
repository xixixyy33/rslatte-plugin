import type RSLattePlugin from "../../main";
import { createHeaderRow } from "../helpers/moduleHeader";
import type { TodayRecordsModel } from "../helpers/todayRecordsModel";

function journalBarChars(count: number, max: number, width = 8): string {
  const m = Math.max(1, max);
  const filled = Math.round((count / m) * width);
  const f = Math.min(width, Math.max(0, filled));
  return `${"█".repeat(f)}${"░".repeat(width - f)}`;
}

const recordsSectionCls = "rslatte-section rslatte-task-section rslatte-expanded rslatte-today-records-block";

function wireClickableStatCard(el: HTMLElement, onClick: () => void): void {
  el.tabIndex = 0;
  el.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onClick();
  });
  el.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      ev.stopPropagation();
      onClick();
    }
  });
}

function createTodayRecordRecapStatCard(
  parent: HTMLElement,
  title: string,
  bodyText: string,
  onClick: () => void,
): HTMLElement {
  const card = parent.createDiv({ cls: "rslatte-today-stat-item rslatte-today-stat-item--clickable" });
  card.title = "点击查看详情";
  card.createDiv({ cls: "rslatte-today-stat-item-title", text: title });
  card.createDiv({ cls: "rslatte-today-stat-item-body", text: bodyText });
  wireClickableStatCard(card, onClick);
  return card;
}

/**
 * Today 侧栏「今日记录」子页签主体（标题区由 TodayView 绘制）。
 * 分区与「今日执行」对齐：rslatte-today-execute-region-title + rslatte-section-title-row，h4 带 icon。
 */
export function renderTodayRecordsBody(opts: {
  plugin: RSLattePlugin;
  container: HTMLElement;
  model: TodayRecordsModel;
}): void {
  const { plugin, container, model } = opts;
  container.empty();
  container.addClass("rslatte-today-records");

  const statusReg = container.createDiv({ cls: "rslatte-today-execute-region" });
  statusReg.createDiv({
    cls: "rslatte-today-execute-region-title rslatte-today-execute-region-title-first",
    text: "今日记录状态",
  });
  const statusSec = statusReg.createDiv({ cls: recordsSectionCls });
  const { left: stL } = createHeaderRow(
    statusSec,
    "rslatte-section-title-row",
    "rslatte-section-title-left",
    "rslatte-task-actions",
  );
  stL.createEl("h4", { text: "📊 今日记录状态" });
  const lightsRow = statusSec.createDiv({ cls: "rslatte-today-records-status-lights" });
  const L = model.statusLights;
  const statusNav: Array<{ lab: string; on: boolean; title: string; run: () => void }> = [
    {
      lab: "打卡",
      on: L.checkin,
      title: "打开今日打卡 · 打卡分区",
      run: () => void plugin.activateRSLatteView?.({ inspectSection: "checkin" }),
    },
    {
      lab: "财务",
      on: L.finance,
      title: "打开今日打卡 · 财务分区",
      run: () => void plugin.activateRSLatteView?.({ inspectSection: "finance" }),
    },
    {
      lab: "日记",
      on: L.journal,
      title: "打开今日打卡 · 今日日记",
      run: () => void plugin.activateRSLatteView?.({ inspectSection: "journal" }),
    },
    {
      lab: "健康",
      on: L.health,
      title: "打开今日打卡 · 健康分区",
      run: () => void plugin.activateRSLatteView?.({ inspectSection: "health" }),
    },
  ];
  for (const s of statusNav) {
    const cell = lightsRow.createDiv({
      cls: "rslatte-today-records-status-item rslatte-today-records-status-item--clickable",
    });
    cell.title = s.title;
    cell.setText(`${s.lab}${s.on ? "🟢" : "⚪"}`);
    wireClickableStatCard(cell, s.run);
  }


  if (model.checkinEnabled) {
    const reg = container.createDiv({ cls: "rslatte-today-execute-region" });
    reg.createDiv({ cls: "rslatte-today-execute-region-title", text: "打卡" });

    const sec = reg.createDiv({ cls: recordsSectionCls });
    const { left: hL } = createHeaderRow(
      sec,
      "rslatte-section-title-row",
      "rslatte-section-title-left",
      "rslatte-task-actions",
    );
    hL.createEl("h4", { text: "✅ 今日打卡状态" });
    const list = sec.createDiv({ cls: "rslatte-today-records-checkin-status" });
    for (const row of model.checkinStatusRows) {
      const line = list.createDiv({ cls: "rslatte-today-records-clickable-row rslatte-today-records-checkin-status-line" });
      line.title = "打开今日打卡 · 打卡";
      line.createSpan({ text: row.done ? "🟢 " : "⚪ " });
      line.createSpan({ text: row.name });
      if (row.difficultyEmoji) line.createSpan({ text: row.difficultyEmoji });
      line.createSpan({ cls: "rslatte-today-records-streak", text: `🔥${row.streak}` });
      line.onclick = () => void plugin.activateRSLatteView({ inspectSection: "checkin" });
    }

    const recSec = reg.createDiv({ cls: recordsSectionCls });
    const { left: rL } = createHeaderRow(
      recSec,
      "rslatte-section-title-row",
      "rslatte-section-title-left",
      "rslatte-task-actions",
    );
    rL.createEl("h4", { text: "📇 今日打卡记录" });
    const recList = recSec.createDiv({ cls: "rslatte-today-records-cards" });
    if (model.checkinRecords.length === 0) {
      recList.createDiv({ cls: "rslatte-muted", text: "（暂无）" });
    } else {
      for (const r of model.checkinRecords) {
        const card = recList.createDiv({ cls: "rslatte-today-record-card rslatte-clickable" });
        card.title = "打开打卡管理并定位该条（热力图日期格）";
        card.createSpan({ cls: "rslatte-tag", text: r.tag });
        card.createSpan({ cls: "rslatte-tag rslatte-tag-muted", text: r.name });
        card.createSpan({ cls: "rslatte-today-record-card-date", text: r.recordDate });
        card.onclick = () =>
          void plugin.activateCheckinView({ recordDate: r.recordDate, checkinId: r.checkinId });
      }
    }
  }

  if (model.financeEnabled) {
    const reg = container.createDiv({ cls: "rslatte-today-execute-region" });
    reg.createDiv({ cls: "rslatte-today-execute-region-title", text: "财务" });

    const finSt = reg.createDiv({ cls: recordsSectionCls });
    const { left: fL } = createHeaderRow(
      finSt,
      "rslatte-section-title-row",
      "rslatte-section-title-left",
      "rslatte-task-actions",
    );
    fL.createEl("h4", { text: "💰 今日财务记录状态" });
    const row = finSt.createDiv({ cls: "rslatte-today-records-finance-status rslatte-today-records-clickable-row" });
    row.title = "打开今日打卡 · 财务";
    row.createSpan({ text: "今日支出 " });
    row.createSpan({ text: model.financeHasExpense ? "🟢" : "⚪" });
    row.createSpan({ text: "   今日收入 " });
    row.createSpan({ text: model.financeHasIncome ? "🟢" : "⚪" });
    row.onclick = () => void plugin.activateRSLatteView({ inspectSection: "finance" });

    const finRecSec = reg.createDiv({ cls: recordsSectionCls });
    const { left: frL } = createHeaderRow(
      finRecSec,
      "rslatte-section-title-row",
      "rslatte-section-title-left",
      "rslatte-task-actions",
    );
    frL.createEl("h4", { text: "📒 今日财务记录" });
    const frList = finRecSec.createDiv({ cls: "rslatte-today-records-cards" });
    if (model.financeRecords.length === 0) {
      frList.createDiv({ cls: "rslatte-muted", text: "（暂无）" });
    } else {
      for (const r of model.financeRecords) {
        const card = frList.createDiv({ cls: "rslatte-today-record-card rslatte-clickable" });
        card.title = r.entryId
          ? "打开财务管理 · 定位该条流水"
          : "打开财务管理 · 财务记录清单";
        card.createSpan({ cls: "rslatte-tag", text: r.tag });
        card.createSpan({ cls: "rslatte-tag rslatte-tag-muted", text: r.categoryName });
        const mid = card.createSpan({ cls: "rslatte-today-record-card-mid" });
        const sub = r.subcategory ? ` ${r.subcategory}` : "";
        const sign = r.type === "income" ? "+" : "-";
        mid.setText(`${sub} ${sign}¥${r.amountAbs.toFixed(2)}`.trim());
        card.createSpan({ cls: "rslatte-today-record-card-date", text: r.displayDate });
        card.onclick = () =>
          void plugin.activateFinanceView(
            r.entryId
              ? { entryId: r.entryId, recordDate: r.displayDate }
              : { contentTab: "ledger" },
          );
      }
    }

    const alSec = reg.createDiv({ cls: recordsSectionCls });
    const { left: alL } = createHeaderRow(
      alSec,
      "rslatte-section-title-row",
      "rslatte-section-title-left",
      "rslatte-task-actions",
    );
    alL.createEl("h4", { text: "⚠️ 今日财务告警" });
    const alList = alSec.createDiv({ cls: "rslatte-today-records-cards" });
    if (model.financeAlerts.length === 0) {
      alList.createDiv({ cls: "rslatte-muted", text: "（暂无）" });
    } else {
      for (const a of model.financeAlerts) {
        const card = alList.createDiv({ cls: "rslatte-today-record-card rslatte-finance-alert-card rslatte-clickable" });
        card.title = "打开财务管理 · 财务统计明细";
        const top = card.createDiv({ cls: "rslatte-today-finance-alert-top" });
        top.createSpan({ cls: "rslatte-tag", text: `[${a.severityLabel}]` });
        top.createSpan({ text: ` ${a.title}` });
        if (a.message.trim()) {
          card.createDiv({ cls: "rslatte-muted rslatte-today-finance-alert-sub", text: a.message });
        }
        card.onclick = () => void plugin.activateFinanceView({ contentTab: "stats" });
      }
    }
  }

  if (model.healthEnabled) {
    const reg = container.createDiv({ cls: "rslatte-today-execute-region" });
    reg.createDiv({ cls: "rslatte-today-execute-region-title", text: "健康" });

    const hSt = reg.createDiv({ cls: recordsSectionCls });
    const { left: hL } = createHeaderRow(
      hSt,
      "rslatte-section-title-row",
      "rslatte-section-title-left",
      "rslatte-task-actions",
    );
    hL.createEl("h4", { text: "❤️ 今日健康状态" });
    const hrow = hSt.createDiv({ cls: "rslatte-today-records-finance-status rslatte-today-records-clickable-row" });
    hrow.title = "打开今日打卡 · 健康";
    hrow.createSpan({
      text: `日维录入 ${model.healthDayDone} / ${model.healthDayTotal} ｜ 饮水目标 ${model.healthWaterGoalCups} 杯/日`,
    });
    hrow.onclick = () => void plugin.activateRSLatteView({ inspectSection: "health" });

    const hRecSec = reg.createDiv({ cls: recordsSectionCls });
    const { left: hrL } = createHeaderRow(
      hRecSec,
      "rslatte-section-title-row",
      "rslatte-section-title-left",
      "rslatte-task-actions",
    );
    hrL.createEl("h4", { text: "📇 今日健康记录" });
    const hrList = hRecSec.createDiv({ cls: "rslatte-today-records-cards" });
    if (model.healthRecords.length === 0) {
      hrList.createDiv({
        cls: "rslatte-muted",
        text: "（当日日卡片下暂无健康指标；列表来自健康索引，与 WorkEvent 是否开启无关）",
      });
    } else {
      for (const r of model.healthRecords) {
        const card = hrList.createDiv({ cls: "rslatte-today-record-card rslatte-clickable" });
        card.title = r.entryId ? "打开健康管理 · 定位该条" : "打开健康管理";
        card.createSpan({ cls: "rslatte-tag", text: r.tag });
        card.createSpan({ cls: "rslatte-tag rslatte-tag-muted", text: r.metricLabel });
        card.createSpan({ cls: "rslatte-today-record-card-mid", text: r.summaryLine });
        card.createSpan({ cls: "rslatte-today-record-card-date", text: r.displayDate });
        card.onclick = () =>
          void plugin.activateHealthView(
            r.entryId ? { entryId: r.entryId, recordDate: r.displayDate } : { contentTab: "ledger" },
          );
      }
    }

    const hAl = reg.createDiv({ cls: recordsSectionCls });
    const { left: haL } = createHeaderRow(
      hAl,
      "rslatte-section-title-row",
      "rslatte-section-title-left",
      "rslatte-task-actions",
    );
    haL.createEl("h4", { text: "⚠️ 今日健康告警" });
    const haList = hAl.createDiv({ cls: "rslatte-today-records-cards" });
    haList.createDiv({
      cls: "rslatte-muted",
      text: "（尚未接入 health-analysis 快照；与方案差异见文档「落地结果」）",
    });
  }

  if (model.journalEnabled) {
    const reg = container.createDiv({ cls: "rslatte-today-execute-region" });
    reg.createDiv({ cls: "rslatte-today-execute-region-title", text: "日记" });
    const jSec = reg.createDiv({ cls: recordsSectionCls });
    const { left: jL } = createHeaderRow(
      jSec,
      "rslatte-section-title-row",
      "rslatte-section-title-left",
      "rslatte-task-actions",
    );
    jL.createEl("h4", { text: "📝 今日日记记录状态" });
    const jList = jSec.createDiv({ cls: "rslatte-today-records-journal-status" });
    for (const p of model.journalPanelRows) {
      const line = jList.createDiv({ cls: "rslatte-today-records-clickable-row" });
      line.title = "打开今日打卡 · 今日日记";
      line.createSpan({ cls: "rslatte-today-records-subwindow-tag", text: "子窗口" });
      line.createSpan({ text: p.label });
      line.createSpan({ text: p.hasContent ? "🟢" : "⚪" });
      line.onclick = () => void plugin.activateRSLatteView({ inspectSection: "journal" });
    }
  }

  const recap = container.createDiv({ cls: "rslatte-today-execute-region rslatte-today-records-recap" });
  recap.createDiv({ cls: "rslatte-today-execute-region-title", text: "今日复盘摘要" });
  const recapStatList = recap.createDiv({ cls: "rslatte-today-stat-list" });

  if (model.checkinEnabled) {
    const total = Math.max(0, model.summary.checkinTotal);
    const done = Math.min(total, model.summary.checkinDone);
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const ck = createTodayRecordRecapStatCard(
      recapStatList,
      "📊 打卡完成进度",
      `${done} / ${total} · 完成率 ${pct}%`,
      () => void plugin.activateCheckinView?.(),
    );
    const bar = ck.createDiv({ cls: "rslatte-today-records-progress" });
    const fill = bar.createDiv({ cls: "rslatte-today-records-progress-fill" });
    fill.style.width = `${pct}%`;
  }

  if (model.financeEnabled) {
    const { financeExpenseN, financeIncomeN, financeExpenseSum, financeIncomeSum } = model.summary;
    const net = financeIncomeSum - financeExpenseSum;
    const netStr = net >= 0 ? `+¥${net.toFixed(2)}` : `-¥${Math.abs(net).toFixed(2)}`;
    const fi = createTodayRecordRecapStatCard(
      recapStatList,
      "💰 财务记录",
      `支出 ${financeExpenseN} 笔 ｜ 收入 ${financeIncomeN} 笔`,
      () => void plugin.activateFinanceView?.({ contentTab: "stats" }),
    );
    fi.createDiv({
      cls: "rslatte-today-stat-item-hint",
      text: `支出 ¥${financeExpenseSum.toFixed(2)} ｜ 收入 ¥${financeIncomeSum.toFixed(2)}`,
    });
    fi.createDiv({ cls: "rslatte-today-stat-item-hint", text: `净额 ${netStr}` });
  }

  if (model.healthEnabled) {
    const hd = model.summary.healthDayDone;
    const ht = Math.max(1, model.summary.healthDayTotal);
    const hpct = Math.min(100, Math.round((hd / ht) * 100));
    const hk = createTodayRecordRecapStatCard(
      recapStatList,
      "❤️ 健康",
      `日维 ${hd} / ${ht} · 完成度 ${hpct}%`,
      () => void plugin.activateHealthView?.({ contentTab: "ledger" }),
    );
    hk.createDiv({
      cls: "rslatte-today-stat-item-hint",
      text: `饮水目标 ${model.healthWaterGoalCups} 杯/日（设置项）`,
    });
  }

  if (model.journalEnabled) {
    const jo = createTodayRecordRecapStatCard(
      recapStatList,
      "📝 日记写入",
      `总字数 ${model.summary.journalTotalChars}`,
      () => void plugin.activateRSLatteView?.({ inspectSection: "journal" }),
    );
    const maxC = Math.max(1, ...model.summary.journalPanelChars.map((x) => x.count));
    for (const x of model.summary.journalPanelChars) {
      const row = jo.createDiv({ cls: "rslatte-today-records-journal-recap-row" });
      const label = row.createSpan({ cls: "rslatte-today-records-journal-recap-label" });
      label.createSpan({ cls: "rslatte-today-records-subwindow-tag", text: "子窗口" });
      label.createSpan({ text: ` ${x.label} ${x.count}` });
      row.createSpan({ cls: "rslatte-today-records-journal-bar", text: ` ${journalBarChars(x.count, maxC)}` });
    }
  }
}
