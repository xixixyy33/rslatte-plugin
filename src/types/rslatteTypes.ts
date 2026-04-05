/** 打卡难度：设置页与侧栏展示；不参与索引/连续天数计算 */
export type CheckinDifficulty = "normal" | "high_focus" | "light";

export const CHECKIN_DIFFICULTY_LABELS: Record<CheckinDifficulty, string> = {
  normal: "一般",
  high_focus: "高脑力 🧠",
  light: "轻量任务 🍃",
};

export function normalizeCheckinDifficulty(v: unknown): CheckinDifficulty {
  if (v === "high_focus" || v === "light") return v;
  return "normal";
}

/** 侧栏等非「一般」时显示简短后缀，避免拥挤 */
export function formatCheckinDifficultyBadge(v: unknown): string {
  const d = normalizeCheckinDifficulty(v);
  if (d === "normal") return "";
  if (d === "high_focus") return " 🧠";
  return " 🍃";
}

/** 仅难度 emoji（无前置空格），用于按钮左侧固定宽列；「一般」返回空串，列宽仍由 CSS 保留 */
export function checkinDifficultyEmojiOnly(v: unknown): string {
  const d = normalizeCheckinDifficulty(v);
  if (d === "high_focus") return "🧠";
  if (d === "light") return "🍃";
  return "";
}

export type CheckinItemDef = {
  id: string;
  name: string;
  active: boolean;
  /** 打卡难度，默认「一般」 */
  checkinDifficulty?: CheckinDifficulty;
  /** 打卡热力图颜色（打卡日色块）。为空则使用默认色。 */
  heatColor?: string;
  fromDb?: boolean;
  /** 已连续打卡天数（刷新时根据昨日是否有记录重置为 0，打卡时根据昨日是否打卡 +1 或置 1） */
  continuousDays?: number;
};

export type FinanceCatDef = {
  id: string;
  name: string;
  type: "income" | "expense";
  active: boolean;
  fromDb?: boolean;
  /** 子分类列表（不重复的字符串数组） */
  subCategories?: string[];
  /** 机构名列表（不重复的字符串数组，按分类维护） */
  institutionNames?: string[];
};

/** 财务周期类型（默认 none） */
export type FinanceCycleType = "none" | "weekly" | "biweekly" | "monthly" | "quarterly" | "halfyearly" | "yearly";

export const FINANCE_CYCLE_LABELS: Record<FinanceCycleType, string> = {
  none: "无周期",
  weekly: "每周",
  biweekly: "每两周",
  monthly: "每月",
  quarterly: "每季度",
  halfyearly: "每半年",
  yearly: "每年",
};

export function normalizeFinanceCycleType(v: unknown): FinanceCycleType {
  const s = String(v ?? "").trim();
  if (s === "weekly" || s === "biweekly" || s === "monthly" || s === "quarterly" || s === "halfyearly" || s === "yearly") {
    return s;
  }
  return "none";
}

/**
 * 财务周期表（设置侧主数据，与日记 meta.cycle_id 关联）
 * @see docs/V2改造方案/记录类管理优化方案.md「已定稿 · 1」
 */
export type FinanceCyclePlanRow = {
  id: string;
  catId: string;
  /** 子分类（不允许空字符串；与匹配键一致） */
  subcategory: string;
  institutionName: string;
  cycleType: FinanceCycleType;
  /** 预期锚点 YYYY-MM-DD */
  anchorDate: string;
  graceDays: number;
  enabled: boolean;
  /** 财务管理重建索引后维护：是否有流水引用该周期 ID */
  referenced?: boolean;
  /** 软删除 ISO 时间；保留行不物理删除 */
  deletedAt?: string;
};

/**
 * 财务数据池（DP_*）：规则/预算/统计的基础输入。
 * - 依赖财务分类清单（catId、子分类、机构名）
 * - 支持按机构名进一步收敛（可选）
 */
export type FinanceDataPoolSubcategorySelector = "ALL" | string[];
export type FinanceDataPoolInstitutionSelector = "ALL" | string[];

export type FinanceDataPoolNode = {
  financeTypeId: string; // CW_*
  financeTypeName?: string;
  subCategories: FinanceDataPoolSubcategorySelector;
  institutionNames?: FinanceDataPoolInstitutionSelector;
};

export type FinanceDataPoolItem = {
  poolId: string; // DP_*
  poolName: string;
  /** 跨财务分类聚合节点（至少 1 个） */
  nodes: FinanceDataPoolNode[];
};

export type FinanceDataPoolConfigFile = {
  schema_version: 1;
  updated_at: string;
  items: FinanceDataPoolItem[];
};

export type FinanceBudgetItem = {
  budgetId: string; // BUD_*
  budgetName: string;
  /** 绑定数据池 ID（DP_*） */
  poolId: string;
  /** 预算金额（正数） */
  amount: number;
  /** 生效周期粒度（先做 month；后续可扩展 week/quarter/year） */
  timeGrain: "month";
  enabled: boolean;
};

export type FinanceBudgetConfigFile = {
  schema_version: 1;
  updated_at: string;
  items: FinanceBudgetItem[];
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
  institutionName?: string;
  cycleType?: FinanceCycleType;
  sceneTags?: string[];
};
