import {
  HEALTH_CANONICAL_DAY_KEYS,
  HEALTH_CANONICAL_METRICS_ORDER,
  type HealthCanonicalMetricKey,
  readHealthMetricsEnabledFlags,
} from "./healthCanonicalMetrics";

/** 设置页保存前：日维至少勾选一项 */
export function validateHealthMetricsEnabledForSave(healthPanel: any): string | null {
  const flags = readHealthMetricsEnabledFlags(healthPanel ?? {});
  const anyDay = HEALTH_CANONICAL_DAY_KEYS.some((k) => flags[k]);
  if (!anyDay) return "日数据项至少保留一项（体重 / 饮水量 / 睡眠 / 饮食中须勾选至少一个）";
  return null;
}

/** 将 Partial 记录规范为完整 9 键（未写的键视为 true），供写入 settings */
export function normalizeHealthMetricsEnabledPayload(
  partial: Partial<Record<HealthCanonicalMetricKey, boolean>> | undefined,
): Record<HealthCanonicalMetricKey, boolean> {
  const p = partial ?? {};
  const out = {} as Record<HealthCanonicalMetricKey, boolean>;
  for (const k of HEALTH_CANONICAL_METRICS_ORDER) {
    out[k] = p[k] !== false;
  }
  return out;
}
