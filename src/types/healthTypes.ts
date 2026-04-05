/** 健康卡片：各周期字段 key（与日记 health 行、WorkEvent ref.metric_key 对齐） */

export const HEALTH_DAY_CARD_METRICS = ["weight", "water_cups", "sleep_hours", "diet"] as const;
export type HealthDayCardMetricKey = (typeof HEALTH_DAY_CARD_METRICS)[number];

/** @deprecated 兼容旧名：日卡片指标即原「日维」全集 */
export const HEALTH_DAY_METRIC_KEYS = HEALTH_DAY_CARD_METRICS;

/** 饮食热量档位：主行仅写 emoji；日记文字在 meta.diet_note（≤100 字） */
export const DIET_HEAT_LEVELS = ["🔥🔥🔥", "🔥🔥", "🔥"] as const;

/** 录入下拉的展示文案（存盘值仍为 DIET_HEAT_LEVELS） */
export function dietHeatLevelDropdownLabel(heatValue: string): string {
  const k = String(heatValue ?? "").trim();
  if (k === "🔥🔥🔥") return "高热量🔥🔥🔥";
  if (k === "🔥🔥") return "一般🔥🔥";
  if (k === "🔥") return "低热量🔥";
  return k;
}

/** 旧 diet_level high/normal/low → 火焰档 */
export function mapLegacyDietLevelToHeat(s: string): string {
  const k = String(s ?? "").trim();
  if (k === "high") return "🔥🔥🔥";
  if (k === "normal") return "🔥🔥";
  if (k === "low") return "🔥";
  return k;
}

export function isDietHeatLevel(s: string): boolean {
  return (DIET_HEAT_LEVELS as readonly string[]).includes(String(s ?? "").trim());
}

/** 周卡片：血压合并为一条，索引/日记 value 为 `120/80mmHg`（主行单 token） */
export const HEALTH_WEEK_CARD_METRICS = ["waist", "bp", "rhr"] as const;
export type HealthWeekCardMetricKey = (typeof HEALTH_WEEK_CARD_METRICS)[number];

/** 月卡片：血糖一条、月经一条（value 为紧凑单 token，见 format*） */
export const HEALTH_MONTH_CARD_METRICS = ["glucose", "menstruation"] as const;
export type HealthMonthCardMetricKey = (typeof HEALTH_MONTH_CARD_METRICS)[number];

/** @deprecated 旧饮食等级键，仅兼容扫描/展示 */
export const HEALTH_DIET_LEVEL_KEYS = ["high", "normal", "low"] as const;
export type HealthDietLevelKey = (typeof HEALTH_DIET_LEVEL_KEYS)[number];

const METRIC_LABEL_ZH: Record<string, string> = {
  weight: "体重(kg)",
  water_cups: "饮水量",
  sleep_hours: "睡眠(小时)",
  diet: "饮食",
  diet_level: "饮食·热量等级（旧）",
  diet_text: "饮食·日记文字（旧）",
  waist: "腰围（cm）",
  /** 周卡片合并血压；日记主行指标列「血压」、值列 `120/80mmHg` */
  bp: "血压",
  /** @deprecated 旧版周卡片拆行，仅兼容扫描与侧栏旧数据 */
  bp_systolic: "血压·收缩压",
  /** @deprecated 旧版周卡片拆行 */
  bp_diastolic: "血压·舒张压",
  /** 存盘仍为 rhr；界面统称「心率」 */
  rhr: "心率（次/分）",
  /** 月卡片合并：日记主行「血糖」、值如 `5.1|7.2mmol` */
  glucose: "血糖",
  /** 月卡片合并：起止日+量+痛经，值如 `2026-03-01~2026-03-07|4|n` */
  menstruation: "月经",
  /** @deprecated 旧月卡片拆行 */
  glucose_fasting: "空腹血糖",
  glucose_postprandial: "餐后两小时血糖",
  menstruation_start: "月经·开始日",
  menstruation_end: "月经·结束日",
  menstruation_flow: "月经·量(1-5)",
  menstruation_cramps: "月经·痛经",
};

export function healthMetricLabelZh(metricKey: string): string {
  const k = String(metricKey ?? "").trim();
  return METRIC_LABEL_ZH[k] || k || "健康";
}

/** 日记主行「指标名列」：与 METRIC_LABEL_ZH 一致（人类可读，非 metric_key） */
export function healthMetricMainLineLabel(metricKey: string): string {
  return healthMetricLabelZh(metricKey);
}

/**
 * 日记主行「值」列展示：饮水量为 ml（由杯数 × 每杯容量）；其余与存储 valueToken 一致。
 */
export function healthMainLineValueDisplay(
  metricKey: string,
  valueToken: string,
  opts?: { waterCupMl?: number },
): string {
  const mk = String(metricKey ?? "").trim();
  const raw = String(valueToken ?? "").trim();
  if (mk === "water_cups") {
    const cups = parseInt(raw, 10);
    if (!Number.isFinite(cups) || cups < 0) return raw;
    const mlPer = Math.max(50, Math.min(2000, Number(opts?.waterCupMl) || 500));
    return `${cups * mlPer}ml`;
  }
  if (mk === "bp") {
    const p = parseBloodPressureStorage(raw);
    return p ? `${p.systolic} / ${p.diastolic} mmHg` : raw;
  }
  if (mk === "glucose") {
    const g = parseGlucoseMonthStorage(raw);
    return g ? `空腹 ${g.fasting}/餐后2h ${g.post2h} mmol/L` : raw;
  }
  if (mk === "menstruation") {
    return formatMenstruationMonthDisplay(raw);
  }
  return raw;
}

/** 月血糖存储：`5.1|7.2mmol`（主行单 token） */
export function parseGlucoseMonthStorage(raw: string): { fasting: string; post2h: string } | null {
  const s = String(raw ?? "").trim();
  const m = s.match(/^(\d+(?:\.\d+)?)\|(\d+(?:\.\d+)?)mmol$/i);
  if (!m) return null;
  return { fasting: m[1], post2h: m[2] };
}

export function formatGlucoseMonthStorage(fasting: number, post2h: number): string {
  const f = Math.round(fasting * 10) / 10;
  const p = Math.round(post2h * 10) / 10;
  return `${String(f)}|${String(p)}mmol`;
}

export function validateGlucosePair(fasting: number, post2h: number): string | null {
  const chk = (n: number, label: string) => {
    if (!Number.isFinite(n) || n < 2 || n > 30) return `${label}须在 2～30 mmol/L`;
    return null;
  };
  return chk(fasting, "空腹血糖") || chk(post2h, "餐后两小时血糖");
}

/** 月经合并：`YYYY-MM-DD~YYYY-MM-DD|1-5|y|n` */
export function parseMenstruationMonthStorage(raw: string): {
  start: string;
  end: string;
  flow: number;
  crampsYes: boolean;
} | null {
  const s = String(raw ?? "").trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})\|([1-5])\|([yn])$/i);
  if (!m) return null;
  return {
    start: m[1],
    end: m[2],
    flow: parseInt(m[3], 10),
    crampsYes: m[4].toLowerCase() === "y",
  };
}

export function formatMenstruationMonthStorage(
  start: string,
  end: string,
  flow: number,
  crampsYes: boolean,
): string {
  return `${start}~${end}|${flow}|${crampsYes ? "y" : "n"}`;
}

/** 侧栏/日记主行值列等：日期范围 + 🩸量档；痛经时追加 ⚡ */
export function formatMenstruationMonthDisplay(raw: string): string {
  const p = parseMenstruationMonthStorage(raw);
  if (!p) return String(raw ?? "").trim();
  return `${p.start}~${p.end}🩸${p.flow}${p.crampsYes ? "⚡" : ""}`;
}

/** 解析索引/日记中的血压存储串，如 `120/80mmHg`、`120/80` */
export function parseBloodPressureStorage(raw: string): { systolic: number; diastolic: number } | null {
  const s = String(raw ?? "").trim().replace(/\s+/g, "");
  const m = s.match(/^(\d{1,3})\/(\d{1,3})(?:mmhg)?$/i);
  if (!m) return null;
  const systolic = parseInt(m[1], 10);
  const diastolic = parseInt(m[2], 10);
  if (!Number.isFinite(systolic) || !Number.isFinite(diastolic)) return null;
  return { systolic, diastolic };
}

/** 写入日记主行的单 token（须匹配 HEALTH_DIARY_MAIN_LINE_RE 的值列 \\S+） */
export function formatBloodPressureStorage(systolic: number, diastolic: number): string {
  return `${Math.round(systolic)}/${Math.round(diastolic)}mmHg`;
}

export function validateBloodPressurePair(systolic: number, diastolic: number): string | null {
  if (systolic < 60 || systolic > 250) return "收缩压须在 60～250 mmHg";
  if (diastolic < 40 || diastolic > 150) return "舒张压须在 40～150 mmHg";
  if (systolic <= diastolic) return "收缩压须大于舒张压";
  return null;
}

/** 表单「收缩压/舒张压」原始串，如 `120/80`、`120 / 80` */
export function parseBloodPressureFormRaw(raw: string): { systolic: number; diastolic: number } | null {
  const v = String(raw ?? "").trim();
  const m = v.match(/^(\d{1,3})\s*\/\s*(\d{1,3})$/);
  if (!m) return null;
  const systolic = parseInt(m[1], 10);
  const diastolic = parseInt(m[2], 10);
  if (!Number.isFinite(systolic) || !Number.isFinite(diastolic)) return null;
  return { systolic, diastolic };
}

/**
 * 解析日记主行上 health 后的第一列：兼容旧版英文 metric_key，新版为中文指标名。
 */
export function healthMetricKeyFromMainLineLabel(token: string): string {
  const t = String(token ?? "").trim();
  if (!t) return t;
  if (/^[a-z][a-z0-9_]*$/i.test(t)) return t;
  for (const [key, zh] of Object.entries(METRIC_LABEL_ZH)) {
    if (zh === t) return key;
  }
  return t;
}

export function healthDietLevelLabelZh(key: string): string {
  const k = String(key ?? "").trim();
  if (k === "high") return "高热量";
  if (k === "normal") return "正常";
  if (k === "low") return "低热量";
  return k;
}

export function healthCrampsLabelZh(key: string): string {
  const k = String(key ?? "").trim().toLowerCase();
  if (k === "yes" || k === "y" || k === "true" || k === "1" || k === "是") return "是";
  if (k === "no" || k === "n" || k === "false" || k === "0" || k === "否") return "否";
  return String(key ?? "").trim();
}
