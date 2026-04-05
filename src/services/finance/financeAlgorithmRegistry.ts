/**
 * 财务算法注册门：算法存在性 + 参数 schema 的事实源。
 * 说明：
 * - 本文件只负责“有哪些算法”以及“每种算法最小入参要求”，不实现具体计算。
 * - 设置页规则 JSON 校验与未来分析执行器都应复用同一份 registry，避免分裂。
 */

export type FinanceAlgorithmParamRequirement = {
  /** 必填参数键（存在即可；类型更细校验后续补齐） */
  requiredKeys: string[];
  /** 可选参数键（仅用于提示，不阻断） */
  optionalKeys?: string[];
};

export type FinanceAlgorithmSpec = {
  algorithmId: string;
  name: string;
  requirement: FinanceAlgorithmParamRequirement;
  /** 是否要求 targetPoolId */
  needsPool?: boolean;
  /** 是否要求 budgetId */
  needsBudget?: boolean;
};

export function financeAlgorithmRegistry(): Record<string, FinanceAlgorithmSpec> {
  const r: Record<string, FinanceAlgorithmSpec> = {};
  const add = (s: FinanceAlgorithmSpec) => {
    r[s.algorithmId] = s;
  };

  add({
    algorithmId: "ALG_EXPECTED_MISSING",
    name: "预期缺失检测",
    needsPool: true,
    requirement: {
      requiredKeys: ["timeGrain", "expectedSourceMode", "lookbackPeriods", "minExpectedHits", "graceDays"],
      optionalKeys: ["institutionRequired"],
    },
  });

  add({
    algorithmId: "ALG_BASELINE_DEVIATION",
    name: "基线偏离检测（均值/中位数）",
    needsPool: true,
    requirement: {
      requiredKeys: [
        "timeGrain",
        "currentPeriod",
        "statMetric",
        "lookbackPeriods",
        "baselineMethod",
        "compareOperator",
        "thresholdMode",
        "thresholdValue",
        "minSampleSize",
      ],
      optionalKeys: ["partialPeriodStrategy"],
    },
  });

  add({
    algorithmId: "ALG_PERCENTILE_SPIKE",
    name: "分位数尖峰检测（P90/P95）",
    needsPool: true,
    requirement: {
      requiredKeys: ["timeGrain", "valueScope", "lookbackPeriods", "percentile", "compareOperator", "thresholdMultiplier", "minSampleSize"],
      optionalKeys: [],
    },
  });

  add({
    algorithmId: "ALG_COUNT_ANOMALY",
    name: "计数异常检测",
    needsPool: true,
    requirement: {
      requiredKeys: ["timeGrain", "countWindow", "countMode", "countThreshold"],
      optionalKeys: [],
    },
  });

  add({
    algorithmId: "ALG_NEW_ENTITY_GROWTH",
    name: "新增实体增长检测（如新增订阅）",
    needsPool: true,
    requirement: {
      requiredKeys: [
        "timeGrain",
        "currentPeriod",
        "entityKey",
        "lookbackPeriods",
        "historyWindowMode",
        "newEntityDefinition",
        "thresholdMode",
        "thresholdValue",
        "minSampleSize",
      ],
      optionalKeys: ["institutionRequired"],
    },
  });

  add({
    algorithmId: "ALG_DERIVED_METRIC_DEVIATION",
    name: "衍生指标偏离检测（现金流/结余率）",
    needsPool: false,
    requirement: {
      requiredKeys: ["timeGrain", "metricKey", "metricInputs", "compareMode", "compareOperator", "thresholdMode", "thresholdValue", "minSampleSize"],
      optionalKeys: ["lookbackPeriods", "zeroIncomePolicy"],
    },
  });

  add({
    algorithmId: "ALG_BUDGET_BREACH",
    name: "预算超限/预警检测",
    needsPool: true,
    needsBudget: true,
    requirement: {
      requiredKeys: ["timeGrain", "budgetMode", "budgetThreshold", "partialPeriodStrategy"],
      optionalKeys: [],
    },
  });

  // 复合规则：用于“收入下降但支出未收缩”等 AND 条件组合（文档大 JSON 已出现）
  add({
    algorithmId: "ALG_COMPOSITE_AND",
    name: "复合规则（AND）",
    needsPool: false,
    requirement: {
      requiredKeys: ["timeGrain", "conditions"],
      optionalKeys: ["minConditionsHit"],
    },
  });

  // 占比异常：numerator/denominator 两个池
  add({
    algorithmId: "ALG_RATIO_ANOMALY",
    name: "占比异常检测（分子/分母）",
    needsPool: false,
    requirement: {
      // 兼容两种口径：
      // - absolute_threshold：只要求 ratioThreshold
      // - baseline_compare：要求 lookbackPeriods/baselineMethod/minSampleSize + 阈值字段
      // 这里先做“最小必填”以减少对业务 JSON 的侵入；更细的按 ratioMode 分支校验放到 validator 中逐步增强。
      requiredKeys: ["timeGrain", "ratioMode"],
      optionalKeys: ["ratioThreshold", "lookbackPeriods", "baselineMethod", "minSampleSize", "thresholdOffset", "thresholdMultiplier", "compareOperator"],
    },
  });

  // 链式复合：在一个规则内配置 conditions[]，每个 condition 自带 algorithmId/target/params
  add({
    algorithmId: "ALG_COMPOSITE_LINKAGE",
    name: "复合联动规则（conditions 链）",
    needsPool: false,
    requirement: {
      requiredKeys: ["timeGrain", "logicOperator", "windowConstraint", "conditions"],
      optionalKeys: ["minConditionsHit"],
    },
  });

  // 序列关系：例如连续 N 天 A > B
  add({
    algorithmId: "ALG_SEQUENCE_ANOMALY",
    name: "序列关系检测（连续 N 单位）",
    needsPool: false,
    requirement: {
      requiredKeys: ["sequenceUnit", "sequenceLength", "relationOperator"],
      optionalKeys: ["minHitCount"],
    },
  });

  // 绝对阈值：例如单笔 > 500
  add({
    algorithmId: "ALG_ABSOLUTE_THRESHOLD",
    name: "绝对阈值检测",
    needsPool: true,
    requirement: {
      // 与文档大 JSON 对齐：compareTarget + thresholdValue
      requiredKeys: ["timeGrain", "compareTarget", "compareOperator", "thresholdValue"],
      optionalKeys: [],
    },
  });

  // 周期断裂：例如“非预期月份扣费”
  add({
    algorithmId: "ALG_PERIOD_BREAK",
    name: "周期断裂检测（扣费月份偏移）",
    needsPool: true,
    requirement: {
      // 与文档大 JSON 对齐：cycleType + allowedDeviation + lookbackPeriods
      requiredKeys: ["timeGrain", "cycleType", "allowedDeviation", "lookbackPeriods"],
      optionalKeys: ["institutionRequired"],
    },
  });

  return r;
}

