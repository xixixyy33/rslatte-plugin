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

export type HealthRecordIndexItem = {
  recordDate: string;
  /** 日记 meta 中的 entry_id；无 meta 时为空，按 metric_key 同日合并 */
  entryId?: string;
  metricKey: string;
  /** 默认 day */
  period?: string;
  /** 逻辑卡片标识：D:… / W:… / M:…（meta.card_ref；旧数据可能为空） */
  cardRef?: string;
  /** 主行上的原始值 token（如 8、72.5） */
  valueStr: string;
  note?: string;
  /** 睡眠：meta.sleep_start_hm（HH:mm），仅 metricKey=sleep_hours 时有值 */
  sleepStartHm?: string;
  isDelete?: boolean;
  tsMs?: number;
  /** 与 meta.created_at_ms 一致：本条首次写入时刻（毫秒）；用于补录展示与重建后保留创建时间 */
  createdAtMs?: number;
  sourceFilePath?: string;
  sourceLineMain?: number;

  dbSourceHash?: string;
  dbLastSyncedHash?: string;
  dbSyncState?: "pending" | "dirty" | "synced" | "failed";
  dbLastSyncedAt?: string;
  dbLastTriedAt?: string;
  dbRetryCount?: number;
  dbLastError?: string;
};

export type FinanceRecordIndexItem = {
  recordDate: string; // YYYY-MM-DD
  /** 日记 meta 中的 entry_id；旧数据无 meta 时为空，索引内按 legacy 键合并 */
  entryId?: string;
  categoryId: string;
  categoryName?: string;
  type: "income" | "expense";
  amount: number; // signed amount (income +, expense -)
  /** meta 子分类（有 meta 时优先；统计可与 note 前缀互证） */
  subcategory?: string;
  note?: string;
  /** 机构名（可选；周期账单建议填写） */
  institutionName?: string;
  /** 周期类型（none/weekly/biweekly/monthly/quarterly/halfyearly/yearly） */
  cycleType?: string;
  /** 日记 meta 周期计划 ID（FCP_*）；显式 "none" 表示用户拒绝入表 */
  cycleId?: string;
  /** 场景标签（多选，可空） */
  sceneTags?: string[];
  isDelete?: boolean;
  tsMs?: number;

  /** 该条财务主行所在日记路径（vault 相对路径；由扫描写入，供侧栏跳转） */
  sourceFilePath?: string;
  /** 财务主行在文件中的行号，0-based，与 CodeMirror 编辑器一致 */
  sourceLineMain?: number;

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

export type HealthRecordIndexFile = {
  version: number;
  updatedAt: string;
  items: HealthRecordIndexItem[];
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
  /** 已连续打卡天数（与打卡项清单一致） */
  continuousDays?: number;
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
