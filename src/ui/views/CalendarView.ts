import { ItemView, WorkspaceLeaf, moment, Notice } from "obsidian";
import type RSLattePlugin from "../../main";
import { VIEW_TYPE_CALENDAR } from "../../constants/viewTypes";
import { RSLATTE_EVENT_SPACE_CHANGED } from "../../constants/space";

const momentFn = moment as any;

export class CalendarView extends ItemView {
  private plugin: RSLattePlugin;
  private _renderSeq = 0;
  private _currentMonth: string = ""; // YYYY-MM 格式

  constructor(leaf: WorkspaceLeaf, plugin: RSLattePlugin) {
    super(leaf);
    this.plugin = plugin;
    const now = momentFn();
    this._currentMonth = now.format("YYYY-MM");
  }

  getViewType(): string { return VIEW_TYPE_CALENDAR; }
  getDisplayText(): string { return "日历"; }
  getIcon(): string { return "calendar"; }

  async onOpen() {
    // 监听空间切换事件，自动刷新数据
    this.registerEvent(
      (this.app.workspace as any).on(RSLATTE_EVENT_SPACE_CHANGED, () => {
        void this.render();
      })
    );
    void this.render();
  }

  async onClose() { }

  private async render() {
    ++this._renderSeq;
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("rslatte-calendar-panel");

    // 获取当前空间配置
    const currentSpaceId = this.plugin.getCurrentSpaceId();
    const spaceConfig = this.plugin.getSpaceConfig(currentSpaceId);
    const spaceSnapshot = spaceConfig?.settingsSnapshot as any;
    const spaceDiaryPath = spaceSnapshot?.diaryPath;
    const spaceDiaryNameFormat = spaceSnapshot?.diaryNameFormat;

    // 临时设置日记配置覆盖（按空间）
    const originalPathOverride = (this.plugin.journalSvc as any)._diaryPathOverride;
    const originalFormatOverride = (this.plugin.journalSvc as any)._diaryNameFormatOverride;
    try {
      this.plugin.journalSvc.setDiaryPathOverride(
        spaceDiaryPath || null,
        spaceDiaryNameFormat || null
      );

      // 获取当前月份的第一天和最后一天
      const monthStart = momentFn(this._currentMonth, "YYYY-MM").startOf("month");
      const monthEnd = momentFn(this._currentMonth, "YYYY-MM").endOf("month");
      const firstDayOfWeek = monthStart.day(); // 0 = 周日, 1 = 周一, ...
      const daysInMonth = monthEnd.date();

      // 标题和月份切换
      const header = container.createDiv({ cls: "rslatte-calendar-header" });
      const titleRow = header.createDiv({ cls: "rslatte-calendar-title-row" });

      // 年份和月份标题
      const yearMonthTitle = titleRow.createDiv({ cls: "rslatte-calendar-year-month-title" });
      const yearTitle = yearMonthTitle.createDiv({ cls: "rslatte-calendar-year-title" });
      yearTitle.createSpan({ text: monthStart.format("YYYY  ") });

      const monthTitle = yearMonthTitle.createDiv({ cls: "rslatte-calendar-month-title" });
      monthTitle.createSpan({ text: monthStart.format("MM") });

      const navBtnRow = titleRow.createDiv({ cls: "rslatte-calendar-nav-btn-row" });
      const prevBtn = navBtnRow.createEl("button", { text: "◀", cls: "rslatte-calendar-nav-btn" });
      prevBtn.onclick = () => {
        const prevMonth = momentFn(this._currentMonth, "YYYY-MM").subtract(1, "month");
        this._currentMonth = prevMonth.format("YYYY-MM");
        void this.render();
      };

      const nextBtn = navBtnRow.createEl("button", { text: "▶", cls: "rslatte-calendar-nav-btn" });
      nextBtn.onclick = () => {
        const nextMonth = momentFn(this._currentMonth, "YYYY-MM").add(1, "month");
        this._currentMonth = nextMonth.format("YYYY-MM");
        void this.render();
      };

      // 获取打卡、财务、任务数据（用于显示状态灯）
      const checkinData: Map<string, boolean> = new Map();
      const financeData: Map<string, boolean> = new Map();
      const taskData: Map<string, boolean> = new Map();

      try {
        if (this.plugin.isPipelineModuleEnabled("checkin")) {
          const checkinSnap = await this.plugin.recordRSLatte.getCheckinSnapshot(false);
          const items = (checkinSnap?.items ?? []) as any[];
          for (const it of items) {
            const d = String(it.recordDate ?? "").trim();
            if (d && !it.isDelete) checkinData.set(d, true);
          }
        }
        if (this.plugin.isPipelineModuleEnabled("finance")) {
          const financeSnap = await this.plugin.recordRSLatte.getFinanceSnapshot(false);
          const items = (financeSnap?.items ?? []) as any[];
          for (const it of items) {
            const d = String(it.recordDate ?? "").trim();
            if (d && !it.isDelete) financeData.set(d, true);
          }
        }
        if (this.plugin.isPipelineModuleEnabled("task")) {
          try {
            await this.plugin.taskRSLatte.ensureReady();
            const taskIndex = await (this.plugin.taskRSLatte as any).store?.readIndex("task");
            const items = (taskIndex?.items ?? []) as any[];
            for (const it of items) {
              const dates = [it.dueDate, it.startDate, it.scheduledDate, it.doneDate].filter(Boolean) as string[];
              for (const d of dates) {
                if (d && it.status !== "CANCELLED") taskData.set(d, true);
              }
            }
          } catch (e) {
            console.warn("[RSLatte][Calendar] Failed to load task data:", e);
          }
        }
      } catch (e) {
        console.warn("[RSLatte][Calendar] Failed to load checkin/finance/task data:", e);
      }

      // 日历表格
      const calendarTable = container.createEl("table", { cls: "rslatte-calendar-table" });
      const thead = calendarTable.createEl("thead");
      const headerRow = thead.createEl("tr");
      const weekDays = ["日", "一", "二", "三", "四", "五", "六"];
      for (const day of weekDays) {
        headerRow.createEl("th", { text: day, cls: "rslatte-calendar-weekday" });
      }

      const tbody = calendarTable.createEl("tbody");
      let currentDate = monthStart.clone();
      
      // 第一行：填充月初空白 + 第一周的日期
      let row = tbody.createEl("tr");
      for (let i = 0; i < firstDayOfWeek; i++) {
        row.createEl("td", { cls: "rslatte-calendar-day-empty" });
      }
      
      for (let day = 1; day <= daysInMonth; day++) {
        if (row.children.length >= 7) {
          row = tbody.createEl("tr");
        }
        
        const dateKey = currentDate.format("YYYY-MM-DD");
        const isToday = dateKey === this.plugin.getTodayKey();
        
        const dayCell = row.createEl("td", {
          cls: `rslatte-calendar-day ${isToday ? "rslatte-calendar-day-today" : ""}`,
        });

        const dayInner = dayCell.createDiv({ cls: "rslatte-calendar-day-inner" });
        dayInner.createDiv({ cls: "rslatte-calendar-day-number", text: String(day) });
        const statusLights = dayInner.createDiv({ cls: "rslatte-calendar-day-status" });

        const diaryExists = !!this.plugin.journalSvc.findDiaryFileForDateKey(dateKey);
        const hasCheckin = checkinData.has(dateKey);
        const hasFinance = financeData.has(dateKey);
        const hasTask = taskData.has(dateKey);

        // 四个状态灯纵向排列：1 日记 2 打卡 3 财务 4 任务（4px 圆点，右侧）
        const addLight = (on: boolean, title: string) => {
          const s = statusLights.createSpan({ cls: "rslatte-calendar-status-light" });
          if (on) s.addClass("is-on");
          s.title = title;
        };
        addLight(diaryExists, diaryExists ? "日记已创建" : "日记未创建");
        addLight(hasCheckin, hasCheckin ? "有打卡记录" : "无打卡记录");
        addLight(hasFinance, hasFinance ? "有财务记录" : "无财务记录");
        addLight(hasTask, hasTask ? "有任务" : "无任务");
        
        // 点击日期跳转到日记
        dayCell.onclick = async () => {
          try {
            // 确保日记存在（不存在则创建）
            const diaryFile = await this.plugin.journalSvc.ensureDiaryForDateKey(dateKey);
            
            // 打开日记文件
            const leaf = this.app.workspace.getLeaf(false);
            await leaf.openFile(diaryFile, { active: true });
          } catch (e: any) {
            new Notice(`打开日记失败：${e?.message ?? String(e)}`);
          }
        };
        
        currentDate.add(1, "day");
      }
      
      // 填充月末空白
      while (row.children.length < 7) {
        row.createEl("td", { cls: "rslatte-calendar-day-empty" });
      }

    } finally {
      // 恢复原始日记配置
      this.plugin.journalSvc.setDiaryPathOverride(originalPathOverride, originalFormatOverride);
    }
  }
}
