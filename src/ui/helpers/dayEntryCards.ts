/**
 * 今日执行 / 今日记录 / 今日核对 等页签共用的「条目卡片」骨架。
 * 类型标签 + 状态圆点 + 描述（联系人引用可渲染）+ 右侧标签芯片。
 */
import type { App } from "obsidian";
import { buildDescPrefix } from "../../taskRSLatte/parser";
import type { RSLatteIndexItem } from "../../taskRSLatte/types";
import { TASK_TAG_META } from "../../taskRSLatte/task/taskTags";
import { MEMO_TAG_META } from "../../taskRSLatte/memo/memoTags";
import { SCHEDULE_TAG_META } from "../../taskRSLatte/schedule/scheduleTags";
import { renderTextWithContactRefs } from "./renderTextWithContactRefs";

/** 任务类卡片上不展示「活跃任务」芯片（与侧栏任务卡一致：活跃为默认态） */
export const DAY_CARD_HIDDEN_TASK_TAG_KEYS = new Set<string>(["活跃任务"]);

const colorNames: Record<number, string> = { 1: "red", 2: "orange", 3: "yellow", 4: "green" };

/**
 * 任务/项目任务状态符号，与 `TaskSidePanelView.statusIcon` 一致：
 * TODO→☐、进行中按 task_phase 区分 ▶/↻/⏸，未知→⬛（避免 TODO 误用 ⏸ 像实心块）。
 */
export function dayCardStatusIcon(st: string, taskPhase?: string): string {
  const s = String(st ?? "").trim().toUpperCase().replace(/-/g, "_");
  if (s === "DONE") return "✅";
  if (s === "CANCELLED") return "⛔";
  if (s === "TODO") return "☐";
  if (s === "IN_PROGRESS") {
    const phase = String(taskPhase ?? "").trim();
    if (phase === "waiting_others") return "↻";
    if (phase === "waiting_until") return "⏸";
    return "▶";
  }
  return "⬛";
}

/** 与 TaskSidePanelView.statusDisplayName 对齐，供圆点 title 使用 */
export function dayCardEntryStatusTitle(it: RSLatteIndexItem): string {
  const st = String((it as any).status ?? "").trim().toUpperCase();
  const phase = String((it as any).task_phase ?? "").trim();
  if (st === "DONE") return "已完成";
  if (st === "CANCELLED") return "已取消";
  if (st === "TODO") return "未开始";
  if (st === "IN_PROGRESS" || st === "IN-PROGRESS") {
    if (phase === "waiting_others") return "跟进中";
    if (phase === "waiting_until") return "等待中";
    return "处理中";
  }
  return "未知";
}

function appendTagChips(row: HTMLElement, tagKeys: string[]): void {
  const visible = tagKeys.filter((k) => k && !DAY_CARD_HIDDEN_TASK_TAG_KEYS.has(k));
  if (!visible.length) return;
  const wrap = row.createDiv({ cls: "rslatte-day-card__tags" });
  for (const key of visible.slice(0, 6)) {
    const info = TASK_TAG_META[key] ?? MEMO_TAG_META[key] ?? SCHEDULE_TAG_META[key];
    const label = info?.label ?? key;
    const fullName = info?.fullName ?? key;
    const colorOrder = info?.colorOrder ?? 4;
    const chip = wrap.createSpan({ cls: "rslatte-day-card__tag rslatte-task-tag" });
    chip.setText(label);
    chip.setAttr("title", fullName);
    chip.addClass(`rslatte-task-tag--${colorNames[colorOrder] ?? "green"}`);
  }
}

function wireCardActivate(card: HTMLElement, onClick: () => void): void {
  card.addClass("rslatte-day-card--interactive");
  card.tabIndex = 0;
  card.setAttr("role", "button");
  card.addEventListener("click", () => void onClick());
  card.addEventListener("keydown", (ev) => {
    if ((ev as KeyboardEvent).key === "Enter" || (ev as KeyboardEvent).key === " ") {
      ev.preventDefault();
      void onClick();
    }
  });
}

export interface DayCardTaskLike {
  status: string;
  text: string;
  starred?: boolean;
  postpone_count?: number;
  complexity?: string;
  task_phase?: string;
}

/**
 * 任务 / 项目任务 共用：左侧类型名 + 状态点 + 描述（含 ⭐↪🧠🍃 前缀）+ 右侧标签。
 */
export function appendDayEntryTaskLikeCard(
  app: App,
  parent: HTMLElement,
  opts: {
    kindLabel: string;
    task: DayCardTaskLike;
    tagKeys: string[];
    onClick: () => void;
  }
): void {
  const card = parent.createDiv({ cls: "rslatte-day-card rslatte-day-card--task" });
  wireCardActivate(card, opts.onClick);
  const main = card.createDiv({ cls: "rslatte-day-card__main" });
  main.createSpan({ cls: "rslatte-day-card__kind", text: opts.kindLabel });
  const dot = main.createSpan({ cls: "rslatte-day-card__dot" });
  dot.setText(dayCardStatusIcon(opts.task.status, opts.task.task_phase));
  dot.setAttr(
    "title",
    dayCardEntryStatusTitle({ status: opts.task.status, task_phase: opts.task.task_phase } as RSLatteIndexItem)
  );
  const desc = main.createDiv({ cls: "rslatte-day-card__desc" });
  const display =
    buildDescPrefix({
      starred: !!opts.task.starred,
      postpone_count: opts.task.postpone_count,
      complexity: opts.task.complexity as any,
    }) + String(opts.task.text ?? "");
  renderTextWithContactRefs(app, desc, display);
  appendTagChips(main, opts.tagKeys);
}

/** 提醒：类型名 + 状态点 + 描述（星标前缀）+ 提醒标签 */
export function appendDayEntryReminderCard(
  app: App,
  parent: HTMLElement,
  opts: {
    memo: RSLatteIndexItem;
    tagKeys: string[];
    onClick: () => void;
  }
): void {
  const m = opts.memo;
  const card = parent.createDiv({ cls: "rslatte-day-card rslatte-day-card--reminder" });
  wireCardActivate(card, opts.onClick);
  const main = card.createDiv({ cls: "rslatte-day-card__main" });
  main.createSpan({ cls: "rslatte-day-card__kind", text: "提醒" });
  const dot = main.createSpan({ cls: "rslatte-day-card__dot" });
  dot.setText(dayCardStatusIcon(String((m as any).status ?? ""), String((m as any).task_phase ?? "")));
  dot.setAttr("title", dayCardEntryStatusTitle(m));
  const desc = main.createDiv({ cls: "rslatte-day-card__desc" });
  const base = String(m.text || m.raw || "").trim();
  const display = (m as any).starred && base ? `⭐ ${base}` : base;
  renderTextWithContactRefs(app, desc, display || "（无描述）");
  appendTagChips(main, opts.tagKeys);
}

/** 日程：类型「日程」+ 描述（可星标前缀）+ 日程标签；无状态圆点（与任务/提醒卡片区分） */
export function appendDayEntryScheduleCard(
  app: App,
  parent: HTMLElement,
  opts: {
    item: RSLatteIndexItem;
    /** 不传则从 item.text/raw 取 */
    displayText?: string;
    tagKeys: string[];
    onClick: () => void;
  }
): void {
  const it = opts.item;
  const card = parent.createDiv({ cls: "rslatte-day-card rslatte-day-card--schedule" });
  wireCardActivate(card, opts.onClick);
  const main = card.createDiv({ cls: "rslatte-day-card__main rslatte-day-card__main--schedule" });
  main.createSpan({ cls: "rslatte-day-card__kind", text: "日程" });
  const desc = main.createDiv({ cls: "rslatte-day-card__desc" });
  const base = String(
    opts.displayText ?? `${String((it as any).text ?? "").trim() || String((it as any).raw ?? "").trim()}`
  ).trim();
  const display = (it as any).starred && base ? `⭐ ${base}` : base;
  renderTextWithContactRefs(app, desc, display || "（无描述）");
  appendTagChips(main, opts.tagKeys);
}
