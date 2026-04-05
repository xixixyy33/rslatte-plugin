/**
 * 健康分析：统计指标块与告警项清单（设置页表格 + 生成时过滤）。
 * 缺省或未列出的键视为启用（true）。
 */

export type HealthStatsMetricCatalogRow = {
  id: string;
  title: string;
  desc: string;
};

export type HealthRuleAlertCatalogRow = {
  id: string;
  title: string;
  desc: string;
  /** `rule`：月规则告警 ruleId；`base`：health-analysis.alert-index.json 中的 code */
  kind: "rule" | "base";
};

/** 写入 `*.stats.json` 时可按块关闭的指标分组 */
export const HEALTH_STATS_METRIC_CATALOG: readonly HealthStatsMetricCatalogRow[] = [
  {
    id: "stats_summary",
    title: "月内汇总",
    desc: "有效条数、按日/周/月计数、各合并项出现次数（canonicalTally）。",
  },
  {
    id: "stats_latest",
    title: "合并项末次值",
    desc: "本月内每一合并项最后一条记录的日期与取值预览。",
  },
  {
    id: "stats_derived_sleep",
    title: "衍生指标 · 睡眠",
    desc: "有记录日数、日均时长、<7h/<5h 天数、连续偏少 streak 等。",
  },
  {
    id: "stats_derived_water",
    title: "衍生指标 · 饮水",
    desc: "有记录日数、达标日数与占比、日均杯数（对照饮水目标）。",
  },
  {
    id: "stats_derived_weight",
    title: "衍生指标 · 体重",
    desc: "有记录日数、均值、低/高、首尾日差、相邻日最大波动。",
  },
  {
    id: "stats_derived_diet",
    title: "衍生指标 · 饮食",
    desc: "有记录日数、高热量天数及在有记录日中的占比。",
  },
  {
    id: "stats_derived_week_cards",
    title: "衍生指标 · 周卡",
    desc: "腰围/血压/心率在本月周卡中的条数与最新或均值类汇总。",
  },
  {
    id: "stats_rolling",
    title: "滚动窗口（近 7 / 近 30 自然日）",
    desc: "以 anchor 为截止的日卡去重桶：睡眠/饮水/体重/饮食及日卡全项完成率等。",
  },
];

/** 规则告警 ruleId + 基础诊断 code（与实现字符串一致） */
export const HEALTH_RULE_ALERT_CATALOG: readonly HealthRuleAlertCatalogRow[] = [
  { id: "HEALTH_RULE_SLEEP_LT_5H", kind: "rule", title: "睡眠过少（日）", desc: "单日睡眠 <5 小时。" },
  { id: "HEALTH_RULE_SLEEP_LT_6H", kind: "rule", title: "睡眠偏少（日）", desc: "单日睡眠 <6 小时。" },
  { id: "HEALTH_RULE_SLEEP_LT_7H", kind: "rule", title: "睡眠不足（日·提示）", desc: "单日睡眠 <7 小时。" },
  { id: "HEALTH_RULE_BP_EMERGENCY", kind: "rule", title: "血压紧急关注线（周）", desc: "收缩压>180 或 舒张压>120。" },
  { id: "HEALTH_RULE_BP_HIGH", kind: "rule", title: "血压偏高（周）", desc: "≥140/90。" },
  { id: "HEALTH_RULE_BP_STAGE1", kind: "rule", title: "血压升高一期（周）", desc: "130–139 或 80–89。" },
  { id: "HEALTH_RULE_RHR_HIGH", kind: "rule", title: "心率偏高（周）", desc: ">100 次/分。" },
  { id: "HEALTH_RULE_RHR_BORDERLINE_HIGH", kind: "rule", title: "心率偏高边缘（周）", desc: "90–100 次/分。" },
  { id: "HEALTH_RULE_RHR_LOW", kind: "rule", title: "心率偏低（关注）", desc: "<50 次/分。" },
  { id: "HEALTH_RULE_GLUCOSE_DM_RANGE", kind: "rule", title: "血糖·糖尿病诊断参考线（月）", desc: "空腹≥7.0 或 餐后2h≥11.1 mmol/L。" },
  { id: "HEALTH_RULE_GLUCOSE_ATTENTION", kind: "rule", title: "血糖·需关注（月）", desc: "空腹≥6.2 或 餐后≥7.9。" },
  { id: "HEALTH_RULE_GLUCOSE_BORDERLINE", kind: "rule", title: "血糖·边界值（月）", desc: "空腹 5.6–6.2 或 餐后 7.8–7.9。" },
  { id: "HEALTH_RULE_MENSES_LONG", kind: "rule", title: "经期偏长（月）", desc: "记录经期 >7 天。" },
  { id: "HEALTH_RULE_MENSES_FLOW_HIGH", kind: "rule", title: "月经量档偏高（月）", desc: "量档为最高档。" },
  { id: "HEALTH_RULE_SLEEP_STREAK_LT7", kind: "rule", title: "连续多日睡眠 <7h（月）", desc: "自然月内连续 <7h streak。" },
  { id: "HEALTH_RULE_SLEEP_STREAK_LT5", kind: "rule", title: "连续多日睡眠 <5h（月）", desc: "自然月内连续 <5h streak。" },
  { id: "HEALTH_RULE_WEIGHT_DAY_JUMP", kind: "rule", title: "相邻日体重波动较大（月）", desc: "月内相邻有记录日体重差 ≥1.5 kg。" },
  { id: "HEALTH_RULE_SLEEP_ROLL7_AVG_LT6", kind: "rule", title: "近7日平均睡眠 <6h", desc: "滚动窗口。" },
  { id: "HEALTH_RULE_SLEEP_ROLL7_AVG_LT7", kind: "rule", title: "近7日平均睡眠 <7h", desc: "滚动窗口。" },
  { id: "HEALTH_RULE_DAY_FULL_ROLL7_LT70", kind: "rule", title: "近7日日卡全项完成率 <70%", desc: "按启用日项。" },
  { id: "HEALTH_RULE_SLEEP_ROLL7_ALL_DAYS_LT7H", kind: "rule", title: "近7日凡有记录日均 <7h", desc: "至少 5 天有睡眠记录。" },
  { id: "HEALTH_RULE_DIET_HIGH_STREAK7", kind: "rule", title: "近7日高热量饮食偏多", desc: "滚动窗口。" },
  { id: "HEALTH_RULE_WATER_LOW_ROLL7", kind: "rule", title: "近7日饮水达标率偏低", desc: "滚动窗口。" },
  { id: "HEALTH_RULE_WEIGHT_7D_UP", kind: "rule", title: "近7日体重均值上升", desc: "相对前 7 日均。" },
  { id: "HEALTH_RULE_SLEEP_ROLL30_AVG_LT7", kind: "rule", title: "近30日平均睡眠 <7h", desc: "滚动窗口。" },
  { id: "HEALTH_RULE_DIET_HIGH_RATIO30", kind: "rule", title: "近30日高热量占比较高", desc: "滚动窗口。" },
  { id: "HEALTH_RULE_WATER_LOW_ROLL30", kind: "rule", title: "近30日饮水达标率偏低", desc: "滚动窗口。" },
  { id: "HEALTH_RULE_WAIST_4W_VS_PREV4W_UP3", kind: "rule", title: "近4周腰围均值较前4周升 ≥3cm", desc: "周卡。" },
  { id: "HEALTH_RULE_RHR_LAST_WEEK_VS_8W_MEAN_PLUS10", kind: "rule", title: "最近周卡心率高于近8周均值 ≥10", desc: "周卡。" },
  { id: "HEALTH_RULE_COMBO_BP_RHR_ELEVATED_AND_SLEEP_ROLL7", kind: "rule", title: "组合：血压/心率偏高 + 近7睡眠偏少", desc: "本月记录 + 滚动睡眠。" },
  { id: "HEALTH_RULE_COMBO_WEIGHT_UP_HEAT_SLEEP", kind: "rule", title: "组合：体重升 + 高热量 + 睡眠不足", desc: "近7日滚动。" },
  { id: "HEALTH_RULE_MENSES_CYCLE_INTERVAL", kind: "rule", title: "月经周期间隔偏离常见范围", desc: "索引内最近两次开始日间隔非 21～35 天。" },
  { id: "HEALTH_MODULE_DISABLED", kind: "base", title: "基础：健康模块未启用", desc: "alert-index 诊断项。" },
  { id: "MISSING_HEALTH_RECORDS", kind: "base", title: "基础：索引中无健康记录", desc: "alert-index。" },
  { id: "MISSING_HEALTH_ACTIVE_RECORDS", kind: "base", title: "基础：有效健康记录为空", desc: "alert-index。" },
  { id: "HEALTH_NO_DAY_METRICS_ENABLED", kind: "base", title: "基础：未启用任何日数据项", desc: "alert-index。" },
  { id: "HEALTH_GAP_SLEEP_RECENT", kind: "base", title: "基础：近期连续无睡眠日卡", desc: "alert-index。" },
  { id: "HEALTH_GAP_WATER_RECENT", kind: "base", title: "基础：近期连续无饮水日卡", desc: "alert-index。" },
  { id: "HEALTH_GAP_WEEK_WAIST", kind: "base", title: "基础：近35天无周卡腰围", desc: "alert-index。" },
  { id: "HEALTH_GAP_WEEK_BP", kind: "base", title: "基础：近35天无周卡血压", desc: "alert-index。" },
  { id: "HEALTH_GAP_WEEK_RHR", kind: "base", title: "基础：近35天无周卡心率", desc: "alert-index。" },
];

export function isHealthStatsMetricOutputEnabled(healthPanel: any, metricId: string): boolean {
  const raw = healthPanel?.healthStatsMetricsEnabled ?? {};
  return raw[metricId] !== false;
}

export function isHealthRuleOrBaseAlertEnabled(healthPanel: any, alertId: string): boolean {
  const raw = healthPanel?.healthRuleAlertsEnabled ?? {};
  return raw[alertId] !== false;
}
