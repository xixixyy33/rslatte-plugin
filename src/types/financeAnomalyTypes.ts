/**
 * 财务日记扫描异常（第六节「异常记录清单」）
 */

/** 主行匹配财务格式但无合法 meta（或 meta 缺 entry_id / 子分类） */
export type FinanceAnomalyLegacyItem = {
  kind: "legacy_no_meta";
  filePath: string;
  /** 从文件名解析的 YYYY-MM-DD */
  dayKey: string;
  /** 1-based 行号（财务主行） */
  lineNumber: number;
  /** 主行截断预览 */
  preview: string;
  categoryId?: string;
};

/** 同一文件内同一 entry_id 出现多组「主行+meta」 */
export type FinanceAnomalyDuplicateItem = {
  kind: "duplicate_entry_id";
  filePath: string;
  dayKey: string;
  entryId: string;
  /** 每组重复对应的主行 1-based 行号 */
  mainLineNumbers: number[];
  /** 与 mainLineNumbers 对齐的预览 */
  previews: string[];
};

/** 同一 entry_id 出现在至少两个不同日记文件中（例如复制日记后只改了主行日期未换新 id） */
export type FinanceAnomalyDuplicateCrossFileItem = {
  kind: "duplicate_entry_id_cross_file";
  entryId: string;
  occurrences: Array<{
    filePath: string;
    dayKey: string;
    lineNumber: number;
    preview: string;
  }>;
};

/** cycle_type≠none 但 meta 缺少 cycle_id（或为空，且非显式跳过） */
export type FinanceAnomalyCycleIdMissingItem = {
  kind: "cycle_id_missing";
  filePath: string;
  dayKey: string;
  lineNumber: number;
  preview: string;
  entryId: string;
  categoryId?: string;
  subcategory?: string;
  institutionName?: string;
  cycleType?: string;
};

export type FinanceAnomalyScanResult = {
  legacy: FinanceAnomalyLegacyItem[];
  duplicates: FinanceAnomalyDuplicateItem[];
  duplicateCrossFiles: FinanceAnomalyDuplicateCrossFileItem[];
  cycleIdMissing: FinanceAnomalyCycleIdMissingItem[];
  scannedFileCount: number;
};
