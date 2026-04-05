import { ItemView, Notice, WorkspaceLeaf, moment, normalizePath } from "obsidian";
import type RSLattePlugin from "../../main";
import { VIEW_TYPE_CALENDAR, VIEW_TYPE_TASKS } from "../../constants/viewTypes";
import { RSLATTE_EVENT_SPACE_CHANGED } from "../../constants/space";
import { getTaskTodayKey } from "../../taskRSLatte/task/taskTags";
import { labelForScheduleCategoryId } from "../../taskRSLatte/schedule/scheduleCategory";
import { TaskSidePanelView } from "./TaskSidePanelView";
import {
  buildScheduleDaySwimlaneSegments,
  dayHasScheduleTimeOverlap,
  densityDotsForCount,
  formatScheduleTimeSummary,
  getScheduleDayOverlapRegions,
  groupScheduleItemsByDate,
  isScheduleInProgressNow,
  scheduleItemOverlapKeys,
  scheduleItemStableKey,
  sortSchedulesForDay,
  stripRedundantScheduleTimeRangePrefix,
} from "../helpers/scheduleCalendarModel";
import { resolveScheduleCalendarLinkFlags, type ScheduleCalendarLinkFlags } from "../helpers/scheduleCalendarLinkResolve";
import { renderTextWithContactRefsResolved } from "../helpers/renderTextWithContactRefs";
import type { RSLatteIndexItem } from "../../taskRSLatte/types";

const momentFn = moment as any;

export class CalendarView extends ItemView {
  private plugin: RSLattePlugin;
  private _renderSeq = 0;
  /** 当前浏览月 YYYY-MM */
  private _currentMonth = "";
  /** 选中日期 YYYY-MM-DD（第三区数据源） */
  private _selectedDate = "";

  constructor(leaf: WorkspaceLeaf, plugin: RSLattePlugin) {
    super(leaf);
    this.plugin = plugin;
    const now = momentFn();
    this._currentMonth = now.format("YYYY-MM");
    this._selectedDate = "";
  }

  getViewType(): string {
    return VIEW_TYPE_CALENDAR;
  }
  getDisplayText(): string {
    return "日程日历";
  }
  getIcon(): string {
    return "calendar";
  }

  async onOpen() {
    this.registerEvent(
      (this.app.workspace as any).on(RSLATTE_EVENT_SPACE_CHANGED, () => {
        void this.render();
      })
    );
    void this.render();
  }

  async onClose() {}

  private todayKey(): string {
    return getTaskTodayKey(this.plugin.settings?.taskPanel ?? undefined);
  }

  /** 换月时保持「日」若新月中存在，否则钳到月末 */
  private syncSelectedToCurrentMonth(): void {
    const monthStart = momentFn(this._currentMonth, "YYYY-MM").startOf("month");
    const lastDay = monthStart.clone().endOf("month").date();
    const cur = momentFn(this._selectedDate, "YYYY-MM-DD", true);
    if (!cur.isValid() || !cur.isSame(monthStart, "month")) {
      const today = momentFn(this.todayKey(), "YYYY-MM-DD", true);
      if (today.isValid() && today.isSame(monthStart, "month")) {
        this._selectedDate = this.todayKey();
      } else {
        this._selectedDate = monthStart.format("YYYY-MM-DD");
      }
      return;
    }
    const d = Math.min(cur.date(), lastDay);
    this._selectedDate = monthStart.clone().date(d).format("YYYY-MM-DD");
  }

  private async render() {
    const seq = ++this._renderSeq;
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("rslatte-calendar-panel");
    container.addClass("rslatte-schedule-calendar");

    const scheduleEnabled = this.plugin.isPipelineModuleEnabled("schedule");
    if (!scheduleEnabled) {
      container.createDiv({ cls: "rslatte-muted", text: "日程模块未启用（可在设置中开启）" });
      return;
    }

    if (!this._selectedDate) {
      this._selectedDate = this.todayKey();
    }
    this.syncSelectedToCurrentMonth();

    let scheduleItems: RSLatteIndexItem[] = [];
    try {
      await this.plugin.taskRSLatte.ensureReady();
      scheduleItems = await this.plugin.taskRSLatte.readScheduleIndexItems();
    } catch (e) {
      console.warn("[RSLatte][ScheduleCalendar] readScheduleIndexItems failed", e);
    }

    if (seq !== this._renderSeq) return;

    const byDate = groupScheduleItemsByDate(scheduleItems);
    const monthStart = momentFn(this._currentMonth, "YYYY-MM").startOf("month");
    const monthEnd = momentFn(this._currentMonth, "YYYY-MM").endOf("month");
    const firstDayOfWeek = monthStart.day();
    const daysInMonth = monthEnd.date();
    const todayYmd = this.todayKey();

    // —— 分区一：日历头 ——
    const head = container.createDiv({ cls: "rslatte-schedule-cal-head" });
    const titleRow = head.createDiv({ cls: "rslatte-schedule-cal-head-row" });
    const ym = titleRow.createDiv({ cls: "rslatte-schedule-cal-ym" });
    ym.setText(monthStart.format("YYYY年 M月"));

    const actions = titleRow.createDiv({ cls: "rslatte-schedule-cal-head-actions" });
    const prevBtn = actions.createEl("button", { type: "button", text: "◀", cls: "rslatte-schedule-cal-nav-btn" });
    prevBtn.title = "上一月";
    prevBtn.onclick = () => {
      this._currentMonth = momentFn(this._currentMonth, "YYYY-MM").subtract(1, "month").format("YYYY-MM");
      this.syncSelectedToCurrentMonth();
      void this.render();
    };
    const nextBtn = actions.createEl("button", { type: "button", text: "▶", cls: "rslatte-schedule-cal-nav-btn" });
    nextBtn.title = "下一月";
    nextBtn.onclick = () => {
      this._currentMonth = momentFn(this._currentMonth, "YYYY-MM").add(1, "month").format("YYYY-MM");
      this.syncSelectedToCurrentMonth();
      void this.render();
    };
    const todayBtn = actions.createEl("button", { type: "button", text: "回到今天", cls: "rslatte-schedule-cal-today-btn" });
    todayBtn.title = "切换到本月并选中任务日「今天」";
    todayBtn.onclick = () => {
      this._currentMonth = momentFn(this.todayKey(), "YYYY-MM-DD").format("YYYY-MM");
      this._selectedDate = this.todayKey();
      void this.render();
    };

    // —— 分区二：迷你日历 ——
    const gridWrap = container.createDiv({ cls: "rslatte-schedule-cal-grid-wrap" });
    const calendarTable = gridWrap.createEl("table", { cls: "rslatte-calendar-table rslatte-schedule-cal-table" });
    const thead = calendarTable.createEl("thead");
    const headerRow = thead.createEl("tr");
    const weekDays = ["日", "一", "二", "三", "四", "五", "六"];
    for (const day of weekDays) {
      headerRow.createEl("th", { text: day, cls: "rslatte-calendar-weekday" });
    }

    const tbody = calendarTable.createEl("tbody");
    let currentDate = monthStart.clone();
    let row = tbody.createEl("tr");
    for (let i = 0; i < firstDayOfWeek; i++) {
      row.createEl("td", { cls: "rslatte-calendar-day-empty" });
    }

    for (let day = 1; day <= daysInMonth; day++) {
      if (row.children.length >= 7) {
        row = tbody.createEl("tr");
      }

      const dateKey = currentDate.format("YYYY-MM-DD");
      const isToday = dateKey === todayYmd;
      const isSelected = dateKey === this._selectedDate;
      const dayItems = byDate.get(dateKey) ?? [];
      const n = dayItems.length;
      const dots = densityDotsForCount(n);
      const conflict = dayHasScheduleTimeOverlap(dayItems);

      const cls = [
        "rslatte-calendar-day",
        "rslatte-schedule-cal-day",
        isToday ? "rslatte-schedule-cal-day--today" : "",
        isSelected ? "rslatte-schedule-cal-day--selected" : "",
      ]
        .filter(Boolean)
        .join(" ");

      const dayCell = row.createEl("td", { cls });

      const inner = dayCell.createDiv({ cls: "rslatte-schedule-cal-day-inner" });
      inner.createDiv({ cls: "rslatte-schedule-cal-day-num", text: String(day) });

      const dotsWrap = inner.createDiv({ cls: "rslatte-schedule-cal-dots" });
      for (let di = 0; di < dots; di++) {
        dotsWrap.createSpan({ cls: "rslatte-schedule-cal-dot" });
      }
      if (conflict) {
        const mark = inner.createSpan({ cls: "rslatte-schedule-cal-conflict", text: "!" });
        mark.title = "当日有日程时间段重叠";
      }

      dayCell.onclick = () => {
        this._selectedDate = dateKey;
        void this.render();
      };

      currentDate.add(1, "day");
    }

    while (row.children.length < 7) {
      row.createEl("td", { cls: "rslatte-calendar-day-empty" });
    }

    // —— 分区三：日程展开区 ——
    const expand = container.createDiv({ cls: "rslatte-schedule-cal-expand" });
    const selItems = sortSchedulesForDay(byDate.get(this._selectedDate) ?? []);
    expand.createDiv({ cls: "rslatte-schedule-cal-expand-title", text: `选中日程 · ${this._selectedDate}` });

    const nowM = momentFn();
    const nowMins = nowM.hour() * 60 + nowM.minute();

    if (selItems.length === 0) {
      expand.createDiv({ cls: "rslatte-schedule-cal-empty", text: "当日暂无日程" });
    } else {
      const linkFlagMap = await resolveScheduleCalendarLinkFlags(this.plugin, selItems);
      const { segments: swimSegs, laneCount } = buildScheduleDaySwimlaneSegments(selItems);
      const lanePx = 14;
      const laneGap = 3;
      const railPad = 4;
      const innerH = railPad * 2 + laneCount * lanePx + Math.max(0, laneCount - 1) * laneGap;
      const scaleMarks: { label: string; frac: number; align: "start" | "center" | "end" }[] = [
        { label: "00:00", frac: 0, align: "start" },
        { label: "06:00", frac: 6 / 24, align: "center" },
        { label: "12:00", frac: 12 / 24, align: "center" },
        { label: "18:00", frac: 18 / 24, align: "center" },
        { label: "24:00", frac: 1, align: "end" },
      ];

      /** 先建列表并登记 key，泳道条 mouseenter 时才能高亮对应行 */
      const keyToRowEl = new Map<string, HTMLElement>();
      const list = expand.createDiv({ cls: "rslatte-schedule-cal-list" });
      const schedMod = (this.plugin.settings as any)?.scheduleModule;
      const overlapKeys = scheduleItemOverlapKeys(selItems);
      for (const it of selItems) {
        const rowEl = list.createDiv({ cls: "rslatte-schedule-cal-item" });
        if (isScheduleInProgressNow(it, this._selectedDate, todayYmd, nowMins)) {
          rowEl.addClass("is-in-progress");
        }
        const itemKey = scheduleItemStableKey(it);
        rowEl.dataset.rslatteScheduleKey = itemKey;
        keyToRowEl.set(itemKey, rowEl);
        if (overlapKeys.has(itemKey)) {
          rowEl.addClass("rslatte-schedule-cal-item--overlap");
        }
        const extra = ((it as any)?.extra ?? {}) as Record<string, unknown>;
        const catId = String(extra.schedule_category ?? "").trim();
        const catLabel = catId ? labelForScheduleCategoryId(schedMod, catId) : "";
        const top = rowEl.createDiv({ cls: "rslatte-schedule-cal-item-top" });
        const topLeft = top.createDiv({ cls: "rslatte-schedule-cal-item-top-left" });
        topLeft.createSpan({ cls: "rslatte-schedule-cal-item-time", text: formatScheduleTimeSummary(it) });
        if (catLabel) {
          topLeft.createSpan({ cls: "rslatte-schedule-cal-item-cat", text: catLabel });
        }
        this.mountScheduleLinkIconsOnCardRow(top, linkFlagMap.get(itemKey));

        const rawDesc = stripRedundantScheduleTimeRangePrefix(it, String((it as any)?.text ?? "").trim());
        const stDone = String((it as any)?.status ?? "").toUpperCase() === "DONE";
        const textHost = rowEl.createDiv({ cls: "rslatte-schedule-cal-item-text" });
        if (stDone) {
          textHost.createSpan({ cls: "rslatte-schedule-cal-item-done-prefix", text: "✅ " });
        }
        const textBody = textHost.createSpan({ cls: "rslatte-schedule-cal-item-text-body" });
        if (!rawDesc) {
          textBody.setText("（无标题）");
        } else {
          try {
            await renderTextWithContactRefsResolved(this.app, textBody, rawDesc, (uid) =>
              this.lookupContactDisplayName(uid)
            );
          } catch {
            textBody.setText(rawDesc);
          }
        }
        if (overlapKeys.has(itemKey)) {
          const badge = rowEl.createSpan({ cls: "rslatte-schedule-cal-overlap-badge", text: "叠" });
          badge.title = "与其他日程时间段重叠";
        }

        const fp = normalizePath(String((it as any)?.filePath ?? ""));
        const ln = Number((it as any)?.lineNo ?? 0);
        rowEl.style.cursor = "pointer";
        rowEl.title = "打开任务侧栏 · 日程安排并定位";
        rowEl.onclick = () => {
          void this.openScheduleInTaskPanel(fp, ln);
        };
      }

      const rail = expand.createDiv({ cls: "rslatte-schedule-cal-rail" });
      list.before(rail);

      const track = rail.createDiv({ cls: "rslatte-schedule-cal-rail-track" });
      track.style.minHeight = `${innerH}px`;
      const railInner = rail.createDiv({ cls: "rslatte-schedule-cal-rail-inner" });
      railInner.style.height = `${innerH}px`;

      for (const m of scaleMarks) {
        const vl = railInner.createDiv({
          cls: `rslatte-schedule-cal-rail-scale-vline rslatte-schedule-cal-rail-scale-vline--${m.align}`,
        });
        vl.style.left = `${m.frac * 100}%`;
        vl.style.height = `${innerH}px`;
        vl.title = m.label;
      }

      const overlapRegions = getScheduleDayOverlapRegions(selItems);
      for (const reg of overlapRegions) {
        const mid = (reg.start + reg.end) / 2;
        const line = railInner.createDiv({ cls: "rslatte-schedule-cal-rail-overlap-line" });
        line.style.left = `${(mid / 1440) * 100}%`;
        line.style.height = `${innerH}px`;
        line.style.top = "0";
        line.title = "该时刻附近有多条日程重叠";
      }

      for (const s of swimSegs) {
        const seg = railInner.createDiv({ cls: "rslatte-schedule-cal-rail-seg" });
        seg.style.left = `${s.leftPct}%`;
        seg.style.width = `${s.widthPct}%`;
        const topPx = railPad + s.lane * (lanePx + laneGap);
        seg.style.top = `${topPx}px`;
        seg.style.height = `${lanePx - 2}px`;
        if (isScheduleInProgressNow(s.item, this._selectedDate, todayYmd, nowMins)) {
          seg.addClass("is-in-progress");
        }
        const sk = scheduleItemStableKey(s.item);
        seg.dataset.rslatteScheduleKey = sk;
        seg.addClass("rslatte-schedule-cal-rail-seg--interactive");
        const onSegEnter = () => {
          const row = keyToRowEl.get(sk);
          if (row) row.addClass("rslatte-schedule-cal-item--rail-hover");
        };
        const onSegLeave = () => {
          const row = keyToRowEl.get(sk);
          if (row) row.removeClass("rslatte-schedule-cal-item--rail-hover");
        };
        seg.addEventListener("mouseenter", onSegEnter);
        seg.addEventListener("mouseleave", onSegLeave);
        const lf = linkFlagMap.get(sk);
        this.mountScheduleLinkIconsOnRailSeg(seg, lf);
      }
      if (this._selectedDate === todayYmd) {
        const tick = railInner.createDiv({ cls: "rslatte-schedule-cal-now-tick" });
        tick.style.left = `${(nowMins / 1440) * 100}%`;
        tick.style.height = `${innerH}px`;
        tick.style.top = "0";
        tick.title = "当前时刻";
      }

      const scale = rail.createDiv({ cls: "rslatte-schedule-cal-rail-scale" });
      for (const m of scaleMarks) {
        const tickEl = scale.createSpan({
          cls: `rslatte-schedule-cal-rail-scale-label rslatte-schedule-cal-rail-scale-label--${m.align}`,
          text: m.label,
        });
        tickEl.style.left = `${m.frac * 100}%`;
      }
    }
  }

  private mountScheduleLinkIconsOnRailSeg(seg: HTMLElement, flags: ScheduleCalendarLinkFlags | undefined): void {
    if (!flags || (!flags.task && !flags.projectTask && !flags.output)) return;
    const wrap = seg.createDiv({ cls: "rslatte-schedule-cal-link-icons rslatte-schedule-cal-link-icons--rail" });
    this.appendScheduleLinkIconNodes(wrap, flags);
  }

  private mountScheduleLinkIconsOnCardRow(top: HTMLElement, flags: ScheduleCalendarLinkFlags | undefined): void {
    if (!flags || (!flags.task && !flags.projectTask && !flags.output)) return;
    const wrap = top.createDiv({ cls: "rslatte-schedule-cal-link-icons rslatte-schedule-cal-link-icons--card" });
    this.appendScheduleLinkIconNodes(wrap, flags);
  }

  /** 与 Today「今日核对」轨迹泳道条带图标一致：🗂 任务 · 🎯 项目任务 · 📄 输出 */
  private appendScheduleLinkIconNodes(wrap: HTMLElement, flags: ScheduleCalendarLinkFlags): void {
    if (flags.task) {
      const el = wrap.createSpan({ cls: "rslatte-schedule-cal-link-emoji", text: "🗂" });
      el.title = "关联任务";
    }
    if (flags.projectTask) {
      const el = wrap.createSpan({ cls: "rslatte-schedule-cal-link-emoji", text: "🎯" });
      el.title = "关联项目任务";
    }
    if (flags.output) {
      const el = wrap.createSpan({ cls: "rslatte-schedule-cal-link-emoji", text: "📄" });
      el.title = "关联输出";
    }
  }

  private async lookupContactDisplayName(uid: string): Promise<string | null> {
    const u = String(uid ?? "").trim();
    if (!u) return null;
    try {
      const store = this.plugin.contactsIndex?.getIndexStore?.();
      if (!store) return null;
      const idx = await store.readIndex();
      const hit = (idx?.items ?? []).find((x) => String((x as any)?.contact_uid ?? "").trim() === u);
      const nm = String((hit as any)?.display_name ?? "").trim();
      return nm || null;
    } catch {
      return null;
    }
  }

  private async openScheduleInTaskPanel(filePath: string, lineNo: number): Promise<void> {
    if (!filePath) return;
    try {
      await this.plugin.activateTaskView();
      const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_TASKS)[0];
      const v = leaf?.view;
      if (v instanceof TaskSidePanelView) {
        await v.focusScheduleByFileLine(filePath, lineNo);
        return;
      }
    } catch (e: any) {
      new Notice(`跳转失败：${e?.message ?? String(e)}`);
    }
  }

  public refresh(): void {
    void this.render();
  }
}
