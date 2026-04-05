import { moment, normalizePath } from "obsidian";
import type { HealthRecordIndexItem } from "../../types/recordIndexTypes";
import { isHealthRuleOrBaseAlertEnabled } from "./healthAnalysisGenerationCatalog";
import { buildDayAggregateMapForYmdRange } from "./healthAnalysisIndex";

const momentFn = moment as any;

export type MissingHealthDataItem = {
  code: string;
  title: string;
  detail: string;
  hint?: string;
};

export type HealthAnalysisAlertIndexFile = {
  version: 1;
  generatedAt: string;
  spaceId: string;
  mode: string;
  status: "ok" | "missing_data";
  missingData: MissingHealthDataItem[];
  summary: {
    missingCount: number;
  };
};

async function ensureFolder(plugin: any, path: string): Promise<void> {
  const p = normalizePath(String(path ?? "").trim());
  if (!p) return;
  const exists = await plugin.app.vault.adapter.exists(p);
  if (exists) return;
  const parts = p.split("/");
  let cur = "";
  for (const seg of parts) {
    cur = cur ? `${cur}/${seg}` : seg;
    const ok = await plugin.app.vault.adapter.exists(cur);
    if (!ok) {
      try {
        await plugin.app.vault.createFolder(cur);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (msg.includes("Folder already exists") || msg.includes("EEXIST")) continue;
        throw e;
      }
    }
  }
}

/** 近期日卡/周卡缺口（不依赖「当天 21:00」，仅按索引日期推断） */
function detectRecentGaps(plugin: any, items: HealthRecordIndexItem[]): MissingHealthDataItem[] {
  const out: MissingHealthDataItem[] = [];
  const valid = items.filter((x) => !x.isDelete);
  if (valid.length === 0) return out;

  const hp = (plugin?.settings as any)?.healthPanel ?? {};
  const raw = hp?.healthMetricsEnabled ?? {};
  const anchor = momentFn().format("YYYY-MM-DD");
  const start = momentFn(anchor, "YYYY-MM-DD", true).subtract(45, "days").format("YYYY-MM-DD");
  const map = buildDayAggregateMapForYmdRange(valid, start, anchor);

  if (raw.sleep_hours !== false) {
    let streak = 0;
    for (let i = 0; i < 24; i++) {
      const d = momentFn(anchor, "YYYY-MM-DD", true).subtract(i, "days").format("YYYY-MM-DD");
      if (d < start) break;
      if (!map.get(d)?.sleep) streak++;
      else break;
    }
    if (streak >= 3) {
      out.push({
        code: "HEALTH_GAP_SLEEP_RECENT",
        title: "近期连续无睡眠日卡",
        detail: `自 ${anchor} 往前已连续 ${streak} 个自然日无「睡眠」日卡记录。`,
        hint: "可补录睡眠或执行健康刷新/重建索引。",
      });
    }
  }

  if (raw.water_cups !== false) {
    let streak = 0;
    for (let i = 0; i < 24; i++) {
      const d = momentFn(anchor, "YYYY-MM-DD", true).subtract(i, "days").format("YYYY-MM-DD");
      if (d < start) break;
      if (!map.get(d)?.water) streak++;
      else break;
    }
    if (streak >= 5) {
      out.push({
        code: "HEALTH_GAP_WATER_RECENT",
        title: "近期连续无饮水日卡",
        detail: `自 ${anchor} 往前已连续 ${streak} 个自然日无「饮水」日卡记录。`,
        hint: "可补录饮水或检查目标杯数设置。",
      });
    }
  }

  const since35 = momentFn(anchor, "YYYY-MM-DD", true).subtract(35, "days").format("YYYY-MM-DD");
  const weekChecks: { key: "waist" | "bp" | "rhr"; label: string }[] = [
    { key: "waist", label: "腰围" },
    { key: "bp", label: "血压" },
    { key: "rhr", label: "心率" },
  ];
  for (const { key, label } of weekChecks) {
    if (raw[key] === false) continue;
    const has = valid.some((it) => {
      if (String(it.period ?? "day").trim().toLowerCase() !== "week") return false;
      const dk = String(it.recordDate ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dk) || dk < since35) return false;
      const mk = String(it.metricKey ?? "").trim();
      if (key === "bp") return mk === "bp" || mk === "bp_systolic" || mk === "bp_diastolic";
      return mk === key;
    });
    if (!has) {
      out.push({
        code: `HEALTH_GAP_WEEK_${key.toUpperCase()}`,
        title: `近35天无周卡「${label}」`,
        detail: `索引中近 35 天未见周期为「周」的 ${label} 记录。`,
        hint: "可在本周健康周卡补录，或执行刷新/重建索引。",
      });
    }
  }

  return out;
}

function detectMissingHealthData(plugin: any, items: HealthRecordIndexItem[]): MissingHealthDataItem[] {
  const out: MissingHealthDataItem[] = [];
  const enabled = plugin?.isHealthModuleEnabled?.() === true;
  if (!enabled) {
    out.push({
      code: "HEALTH_MODULE_DISABLED",
      title: "健康模块未启用",
      detail: "当前空间未在「模块管理」中启用健康，索引与统计可能为空。",
      hint: "在设置中开启「健康」后执行刷新或重建索引。",
    });
    return out;
  }

  if (!Array.isArray(items) || items.length === 0) {
    out.push({
      code: "MISSING_HEALTH_RECORDS",
      title: "健康索引中无记录",
      detail: "尚未扫描到任何健康主行，无法生成周期统计与规则告警。",
      hint: "请录入健康数据或对健康模块执行「扫描重建」。",
    });
    return out;
  }

  const valid = items.filter((x) => !x.isDelete);
  if (valid.length === 0) {
    out.push({
      code: "MISSING_HEALTH_ACTIVE_RECORDS",
      title: "健康有效记录为空",
      detail: "索引条目均为删除态，统计与告警无数据可依。",
      hint: "请新增记录或检查日记与索引是否一致。",
    });
  }

  const hp = (plugin?.settings as any)?.healthPanel ?? {};
  const raw = hp?.healthMetricsEnabled ?? {};
  const dayKeys = ["weight", "water_cups", "sleep_hours", "diet"] as const;
  const anyDay = dayKeys.some((k) => raw[k] !== false);
  if (!anyDay) {
    out.push({
      code: "HEALTH_NO_DAY_METRICS_ENABLED",
      title: "未启用任何日数据项",
      detail: "设置中「数据项显示与维护」日维全部被关闭（异常配置），完成度与部分统计将失真。",
      hint: "请在健康管理设置中至少勾选一项日数据项。",
    });
  }

  for (const x of detectRecentGaps(plugin, items)) out.push(x);

  return out;
}

/** 读取健康分析诊断索引（不存在或解析失败时返回 null）。`spaceId` 传入时读该空间索引目录（Hub 多空间用）。 */
export async function readHealthAnalysisAlertIndex(plugin: any, spaceId?: string): Promise<HealthAnalysisAlertIndexFile | null> {
  try {
    const root = String(
      typeof spaceId === "string" && spaceId.trim()
        ? plugin?.getSpaceIndexDir?.(spaceId.trim())
        : plugin?.getSpaceIndexDir?.()
    ).trim();
    if (!root) return null;
    const path = normalizePath(`${root}/health-analysis/health-analysis.alert-index.json`);
    const ok = await plugin.app.vault.adapter.exists(path);
    if (!ok) return null;
    const raw = await plugin.app.vault.adapter.read(path);
    const j = JSON.parse(String(raw ?? "{}"));
    if (!j || typeof j !== "object") return null;
    if (j.version !== 1) return null;
    const missingData = Array.isArray(j.missingData) ? j.missingData : [];
    return {
      version: 1,
      generatedAt: String(j.generatedAt ?? ""),
      spaceId: String(j.spaceId ?? ""),
      mode: String(j.mode ?? ""),
      status: j.status === "missing_data" ? "missing_data" : "ok",
      missingData,
      summary: {
        missingCount: Number(j.summary?.missingCount ?? missingData.length) || 0,
      },
    };
  } catch (e) {
    console.warn("[RSLatte][health-analysis] read alert index failed", e);
    return null;
  }
}

export async function writeHealthAnalysisAlertIndex(plugin: any, mode: string): Promise<void> {
  try {
    const spaceId = String(plugin?.getSpaceCtx?.()?.spaceId ?? "default");
    const root = String(plugin?.getSpaceIndexDir?.() ?? "").trim();
    if (!root) return;
    const dir = normalizePath(`${root}/health-analysis`);
    const path = normalizePath(`${dir}/health-analysis.alert-index.json`);
    await ensureFolder(plugin, dir);

    await plugin?.recordRSLatte?.ensureReady?.();
    const [snapA, snapB] = await Promise.all([
      plugin?.recordRSLatte?.getHealthSnapshot?.(false),
      plugin?.recordRSLatte?.getHealthSnapshot?.(true),
    ]);
    const items: HealthRecordIndexItem[] = [
      ...(Array.isArray(snapA?.items) ? snapA.items : []),
      ...(Array.isArray(snapB?.items) ? snapB.items : []),
    ];
    const hp = (plugin?.settings as any)?.healthPanel ?? {};
    const missingDataAll = detectMissingHealthData(plugin, items);
    const missingData = missingDataAll.filter((x) => isHealthRuleOrBaseAlertEnabled(hp, x.code));
    const file: HealthAnalysisAlertIndexFile = {
      version: 1,
      generatedAt: new Date().toISOString(),
      spaceId,
      mode: String(mode ?? ""),
      status: missingData.length > 0 ? "missing_data" : "ok",
      missingData,
      summary: {
        missingCount: missingData.length,
      },
    };
    await plugin.app.vault.adapter.write(path, JSON.stringify(file, null, 2));
  } catch (e) {
    console.warn("[RSLatte][health-analysis] write alert index failed", e);
  }
}
