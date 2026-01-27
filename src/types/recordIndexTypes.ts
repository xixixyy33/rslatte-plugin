export type CheckinRecordIndexItem = {
  recordDate: string; // YYYY-MM-DD
  checkinId: string;
  checkinName?: string;
  note?: string;
  /** true = cancelled/not done */
  isDelete?: boolean;
  /** epoch ms (optional) */
  tsMs?: number;

  /** ===== DB sync meta (per-item) ===== */
  /** deterministic hash derived from business fields */
  dbSourceHash?: string;
  /** last successfully synced hash */
  dbLastSyncedHash?: string;
  /** pending/dirty/synced/failed */
  dbSyncState?: "pending" | "dirty" | "synced" | "failed";
  /** ISO time of last successful sync */
  dbLastSyncedAt?: string;
  /** ISO time of last try (success or fail) */
  dbLastTriedAt?: string;
  dbRetryCount?: number;
  dbLastError?: string;
};

export type FinanceRecordIndexItem = {
  recordDate: string; // YYYY-MM-DD
  categoryId: string;
  categoryName?: string;
  type: "income" | "expense";
  amount: number; // signed amount (income +, expense -)
  note?: string;
  isDelete?: boolean;
  tsMs?: number;

  /** ===== DB sync meta (per-item) ===== */
  dbSourceHash?: string;
  dbLastSyncedHash?: string;
  dbSyncState?: "pending" | "dirty" | "synced" | "failed";
  dbLastSyncedAt?: string;
  dbLastTriedAt?: string;
  dbRetryCount?: number;
  dbLastError?: string;
};

export type CheckinRecordIndexFile = {
  version: number;
  updatedAt: string;
  items: CheckinRecordIndexItem[];
};

export type FinanceRecordIndexFile = {
  version: number;
  updatedAt: string;
  items: FinanceRecordIndexItem[];
};

/** ===== 打卡项清单 / 财务分类清单：中央索引（含软删除与归档） ===== */

export type CheckinItemIndexItem = {
  id: string;
  name: string;
  active: boolean;
  /** ISO time, null/undefined 表示未删除 */
  deletedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type FinanceCatIndexItem = {
  id: string;
  name: string;
  type: "income" | "expense";
  active: boolean;
  deletedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type RSLatteListsIndexFile = {
  version: number;
  updatedAt: string;
  checkinItems: CheckinItemIndexItem[];
  financeCategories: FinanceCatIndexItem[];
  /**
   * Finance subcategories (UI helper only): category_id -> recent-used subcategory names.
   * This does NOT go to DB. It is inferred from finance notes like 【子分类】...
   */
  financeSubcategoriesByCategoryId?: Record<string, string[]>;
  /** ✅ 永久保存：历史已删除 ID，用于防止未来生成/手工修改时发生复用 */
  tombstoneCheckinIds: string[];
  tombstoneFinanceIds: string[];
};

/** ===== 财务统计缓存：轻量级全量数据（仅统计字段，归档时不清除） ===== */

/**
 * 财务统计缓存项：仅包含统计所需的最小字段
 * - 用于侧边栏统计和月度统计，不受归档机制影响
 * - 体积小，只存储统计字段，不存储 note、dbSyncState 等
 * - 包含子分类信息用于统计图表
 */
export type FinanceStatsCacheItem = {
  recordDate: string; // YYYY-MM-DD
  categoryId: string;
  type: "income" | "expense";
  amount: number; // signed amount (income +, expense -)
  subcategory?: string; // 财务子分类（从 note 中提取）
  isDelete?: boolean;
};

export type FinanceStatsCacheFile = {
  version: number;
  updatedAt: string;
  items: FinanceStatsCacheItem[];
};

/** ===== 打卡统计缓存：轻量级全量数据（仅统计字段，归档时不清除） ===== */

/**
 * 打卡统计缓存项：仅包含统计所需的最小字段
 * - 用于月度统计热力图和波形图，不受归档机制影响
 * - 体积小，只存储统计字段，不存储 note、dbSyncState 等
 * - 只记录最终状态（isDelete），不对数据做归档
 */
export type CheckinStatsCacheItem = {
  recordDate: string; // YYYY-MM-DD
  checkinId: string;
  isDelete?: boolean; // true = 未打卡/已取消，false/undefined = 已打卡
};

export type CheckinStatsCacheFile = {
  version: number;
  updatedAt: string;
  items: CheckinStatsCacheItem[];
};

/** ===== 任务统计缓存：轻量级全量数据（仅统计字段，归档时不清除） ===== */

/**
 * 任务统计缓存项：仅包含统计所需的最小字段
 * - 用于月度统计，不受归档机制影响
 * - 体积小，只存储统计字段，不存储 text、raw、dbSyncState 等
 * - 包含任务状态、创建日期、完成日期等关键统计信息
 */
export type TaskStatsCacheItem = {
  uid: string; // 任务唯一标识
  status: "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED"; // 当前状态
  createdDate?: string; // YYYY-MM-DD，任务创建日期
  doneDate?: string; // YYYY-MM-DD，任务完成日期
  cancelledDate?: string; // YYYY-MM-DD，任务取消日期
  dueDate?: string; // YYYY-MM-DD，任务截止日期
  /** 是否已删除（软删除） */
  isDelete?: boolean;
};

export type TaskStatsCacheFile = {
  version: number;
  updatedAt: string;
  items: TaskStatsCacheItem[];
};
