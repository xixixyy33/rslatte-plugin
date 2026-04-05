import type { FinanceBudgetConfigFile, FinanceDataPoolConfigFile } from "../../types/rslatteTypes";
import type { FinanceRuleConfigFile, FinanceRuleValidationIssue } from "../../types/financeRuleTypes";
import { financeAlgorithmRegistry } from "./financeAlgorithmRegistry";

function asObj(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object") return null;
  if (Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function asStr(v: unknown): string {
  return String(v ?? "").trim();
}

function hasKey(o: Record<string, unknown> | null, k: string): boolean {
  if (!o) return false;
  return Object.prototype.hasOwnProperty.call(o, k);
}

function collectPoolRefsFromObj(o: Record<string, unknown> | null): string[] {
  if (!o) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (!k.toLowerCase().endsWith("poolid")) continue;
    const s = asStr(v);
    if (s) out.push(s);
  }
  return out;
}

function collectPoolRefsFromRuleLike(ruleLike: Record<string, unknown> | null): string[] {
  const out: string[] = [];
  const target = asObj(ruleLike?.target);
  const params = asObj(ruleLike?.params);
  out.push(...collectPoolRefsFromObj(target));
  // metricInputs 里也可能引用 poolId
  const metricInputs = asObj(params?.metricInputs);
  out.push(...collectPoolRefsFromObj(metricInputs));
  return Array.from(new Set(out));
}

export function validateFinanceRuleConfig(args: {
  ruleText: string;
  pool?: FinanceDataPoolConfigFile | null;
  budget?: FinanceBudgetConfigFile | null;
}): { file: FinanceRuleConfigFile | null; issues: FinanceRuleValidationIssue[] } {
  const issues: FinanceRuleValidationIssue[] = [];
  let file: FinanceRuleConfigFile | null = null;

  let parsed: any;
  try {
    parsed = JSON.parse(String(args.ruleText ?? ""));
  } catch (e: any) {
    issues.push({
      level: "error",
      code: "RULE_JSON_PARSE_ERROR",
      message: `规则 JSON 解析失败：${String(e?.message ?? e).slice(0, 120)}`,
    });
    return { file: null, issues };
  }

  const root = asObj(parsed);
  if (!root) {
    issues.push({ level: "error", code: "RULE_JSON_NOT_OBJECT", message: "规则 JSON 顶层必须是对象" });
    return { file: null, issues };
  }
  if (Number(root.version) !== 1) {
    issues.push({ level: "warning", code: "RULE_JSON_VERSION", message: "建议 version=1（当前不为 1）" });
  }

  const rulesObj = asObj(root.rules);
  if (!rulesObj) {
    issues.push({ level: "error", code: "RULES_MISSING", message: "缺少 rules 对象" });
    return { file: null, issues };
  }

  const poolIds = new Set<string>();
  if (args.pool?.items?.length) {
    for (const p of args.pool.items as any[]) {
      const pid = asStr(p?.poolId);
      if (pid) poolIds.add(pid);
    }
  }
  const budgetIds = new Set<string>();
  if (args.budget?.items?.length) {
    for (const b of args.budget.items as any[]) {
      const bid = asStr(b?.budgetId);
      if (bid) budgetIds.add(bid);
    }
  }

  const reg = financeAlgorithmRegistry();

  const outRules: Record<string, any> = {};
  for (const [ruleId, raw] of Object.entries(rulesObj)) {
    const rid = asStr(ruleId);
    const robj = asObj(raw);
    if (!rid || !robj) continue;
    outRules[rid] = raw;

    const algorithmId = asStr(robj.algorithmId);
    if (!algorithmId) {
      issues.push({ level: "error", ruleId: rid, code: "ALGORITHM_MISSING", message: "缺少 algorithmId" });
      continue;
    }
    const spec = reg[algorithmId];
    if (!spec) {
      issues.push({
        level: "error",
        ruleId: rid,
        code: "ALGORITHM_UNKNOWN",
        message: `算法不存在：${algorithmId}`,
        hint: "请先在算法注册门中登记该 algorithmId",
      });
      continue;
    }

    const target = asObj(robj.target);
    const params = asObj(robj.params);
    const budgetId = asStr(target?.budgetId);

    const poolRefs = collectPoolRefsFromRuleLike(robj);
    if (spec.needsPool && poolRefs.length === 0) {
      issues.push({
        level: "error",
        ruleId: rid,
        code: "POOL_REF_REQUIRED",
        message: "该算法要求引用数据池（target.*PoolId 或 params.metricInputs.*PoolId）",
      });
    }
    for (const pid of poolRefs) {
      if (poolIds.size > 0 && !poolIds.has(pid)) {
        issues.push({
          level: "error",
          ruleId: rid,
          code: "TARGET_POOL_NOT_FOUND",
          message: `数据池不存在：${pid}`,
          hint: "请先在「数据池 JSON」中维护该 poolId，或修正规则引用",
        });
      }
    }
    if (spec.needsBudget && !budgetId) {
      issues.push({ level: "error", ruleId: rid, code: "BUDGET_REQUIRED", message: "该算法要求 target.budgetId" });
    }
    if (budgetId && budgetIds.size > 0 && !budgetIds.has(budgetId)) {
      issues.push({
        level: "error",
        ruleId: rid,
        code: "BUDGET_NOT_FOUND",
        message: `预算不存在：${budgetId}`,
        hint: "请先在「预算表 JSON」中维护该 budgetId，或修正规则引用",
      });
    }

    // params 最小键校验
    for (const k of spec.requirement.requiredKeys) {
      if (!hasKey(params, k)) {
        issues.push({
          level: "error",
          ruleId: rid,
          code: "PARAM_MISSING",
          message: `参数缺失：params.${k}`,
          hint: `算法「${spec.name}」要求提供：${spec.requirement.requiredKeys.join(", ")}`,
        });
      }
    }

    // 复合规则结构：conditions 数组（支持 COMPOSITE_AND / COMPOSITE_LINKAGE）
    if (algorithmId === "ALG_COMPOSITE_AND" || algorithmId === "ALG_COMPOSITE_LINKAGE") {
      const conds = (params as any)?.conditions;
      if (!Array.isArray(conds) || conds.length === 0) {
        issues.push({
          level: "error",
          ruleId: rid,
          code: "COMPOSITE_CONDITIONS_MISSING",
          message: "复合规则缺少 params.conditions（数组）",
        });
      } else {
        // 一层递归校验每个 condition
        for (const c of conds as any[]) {
          const cid = asStr(c?.conditionId) || "condition";
          const calg = asStr(c?.algorithmId);
          if (!calg) {
            issues.push({ level: "error", ruleId: rid, code: "COND_ALGORITHM_MISSING", message: `条件 ${cid} 缺少 algorithmId` });
            continue;
          }
          const cspec = reg[calg];
          if (!cspec) {
            issues.push({ level: "error", ruleId: rid, code: "COND_ALGORITHM_UNKNOWN", message: `条件 ${cid} 算法不存在：${calg}` });
            continue;
          }
          const cparams = asObj(c?.params);
          for (const k of cspec.requirement.requiredKeys) {
            if (!hasKey(cparams, k)) {
              issues.push({
                level: "error",
                ruleId: rid,
                code: "COND_PARAM_MISSING",
                message: `条件 ${cid} 参数缺失：params.${k}`,
              });
            }
          }
          const cPoolRefs = collectPoolRefsFromRuleLike(asObj(c) as any);
          if (cspec.needsPool && cPoolRefs.length === 0) {
            issues.push({ level: "error", ruleId: rid, code: "COND_POOL_REF_REQUIRED", message: `条件 ${cid} 要求引用数据池（*PoolId）` });
          }
          for (const pid of cPoolRefs) {
            if (poolIds.size > 0 && !poolIds.has(pid)) {
              issues.push({ level: "error", ruleId: rid, code: "COND_POOL_NOT_FOUND", message: `条件 ${cid} 数据池不存在：${pid}` });
            }
          }
        }
      }
    }
  }

  file = {
    version: 1,
    defaults: (root.defaults ?? undefined) as any,
    assumptions: Array.isArray(root.assumptions) ? (root.assumptions as any) : undefined,
    rules: outRules,
  };

  return { file, issues };
}

