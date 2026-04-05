import type { FinanceCycleType } from "./rslatteTypes";

export type FinanceRuleSeverity = "high" | "warning" | "notice";

export type FinanceRuleResultPolicy = {
  cooldownDays?: number;
  dedupeKeyMode?: string;
  allowPartialPeriod?: boolean;
};

export type FinanceRuleMessage = {
  title: string;
  template: string;
};

export type FinanceRuleTarget = {
  /** 引用数据池 poolId（DP_*） */
  targetPoolId?: string;
  /** 引用预算表 budgetId（BUDGET_*） */
  budgetId?: string;
};

export type FinanceRuleFilters = {
  institutionNames?: string[];
  cycleTypes?: FinanceCycleType[];
  includeSceneTags?: string[];
  excludeSceneTags?: string[];
  sceneTagPolicy?: string;
};

export type FinanceRuleSpec = {
  ruleName: string;
  enabled: boolean;
  ruleGroup?: string;
  algorithmId: string;
  severity: FinanceRuleSeverity;
  order?: number;
  target?: FinanceRuleTarget;
  filters?: FinanceRuleFilters;
  params?: Record<string, unknown>;
  message: FinanceRuleMessage;
  resultPolicy?: FinanceRuleResultPolicy;
};

export type FinanceRuleConfigFile = {
  version: 1;
  defaults?: Record<string, unknown>;
  assumptions?: Array<{ name: string; detail: string }>;
  rules: Record<string, FinanceRuleSpec>;
};

export type FinanceRuleValidationIssueLevel = "error" | "warning";

export type FinanceRuleValidationIssue = {
  level: FinanceRuleValidationIssueLevel;
  ruleId?: string;
  code: string;
  message: string;
  hint?: string;
};

