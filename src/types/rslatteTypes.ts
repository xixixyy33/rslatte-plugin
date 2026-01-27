export type CheckinItemDef = {
  id: string;
  name: string;
  active: boolean;
  /** 打卡热力图颜色（打卡日色块）。为空则使用默认色。 */
  heatColor?: string;
  fromDb?: boolean;
};

export type FinanceCatDef = {
  id: string;
  name: string;
  type: "income" | "expense";
  active: boolean;
  fromDb?: boolean;
  /** 子分类列表（不重复的字符串数组） */
  subCategories?: string[];
};

export type JournalPanel = {
  id: string;
  label: string;
  heading: string;
  maxLines?: number;
};

export type DailyState = {
  checkinsDone: Record<string, boolean>;
  financeDone: Record<string, boolean>;
};

export type FinanceEntry = {
  type: "income" | "expense";
  catId: string;
  amount: number;
  note: string;
};
