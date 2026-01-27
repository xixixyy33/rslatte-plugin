import { moment } from "obsidian";
import type { App } from "obsidian";
import { JournalService } from "./journalService";

export type FinanceSummary = {
  monthIncome: number; monthExpense: number;
  yearIncome: number; yearExpense: number;
};

export class FinanceSummaryService {
  constructor(
    private app: App,
    private journalSvc: JournalService,
    private getTodayKey: () => string
  ) {}

  /**
   * 财务汇总当前实现 = 从“今日日记文件”里解析流水行并计算本月/本年。
   * ⚠️ 这并不是跨天累计，只适用于“你把所有流水都追加在同一个文件”的情况。
   */
  async calcFinanceSummaryFromNotes(): Promise<FinanceSummary> {
    const momentFn = moment as any;
    const now = momentFn();
    const monthPrefix = now.format("YYYY-MM");
    const yearPrefix = now.format("YYYY");

    const file = this.journalSvc.findDiaryFileForDateKey(this.getTodayKey());
    if (!file) {
      return { monthIncome: 0, monthExpense: 0, yearIncome: 0, yearExpense: 0 };
    }

    const raw = await this.app.vault.read(file);
    const lines = raw.split("\n");

    const re = /^\s*[-*]\s+(\d{4}-\d{2}-\d{2})\s+(income|expense)\s+([A-Za-z0-9_]+)\s+(.+?)\s+([+-]\d+(?:\.\d+)?)\b/;

    let monthIncome = 0, monthExpense = 0, yearIncome = 0, yearExpense = 0;

    for (const line of lines) {
      const m = line.match(re);
      if (!m) continue;

      const dateStr = m[1];
      const type = m[2] as "income" | "expense";
      const amt = Number(m[5]);
      if (!Number.isFinite(amt)) continue;

      const absAmt = Math.abs(amt);

      if (dateStr.startsWith(yearPrefix)) {
        if (type === "income") yearIncome += absAmt;
        else yearExpense += absAmt;
      }
      if (dateStr.startsWith(monthPrefix)) {
        if (type === "income") monthIncome += absAmt;
        else monthExpense += absAmt;
      }
    }

    return { monthIncome, monthExpense, yearIncome, yearExpense };
  }
}
