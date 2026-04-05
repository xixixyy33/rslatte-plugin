import { Notice, Setting } from "obsidian";
import {
  HEALTH_STATS_METRIC_CATALOG,
  HEALTH_RULE_ALERT_CATALOG,
} from "../../../services/health/healthAnalysisGenerationCatalog";
import {
  HEALTH_CANONICAL_DAY_KEYS,
  HEALTH_CANONICAL_MONTH_KEYS,
  HEALTH_CANONICAL_WEEK_KEYS,
  healthCanonicalShortLabelZh,
  type HealthCanonicalMetricKey,
} from "../../../services/health/healthCanonicalMetrics";
import { validateHealthMetricsEnabledForSave } from "../../../services/health/healthMetricsSettings";

export type ModuleWrapFactory = (moduleKey: any, title: string, scopeTag?: "global" | "space") => HTMLElement;
export type HeaderButtonsVisibilityAdder = (wrap: HTMLElement, moduleKey: any, defaultShow: boolean) => void;

/** 健康管理设置（饮水目标等；启用开关在设置页「模块管理」→「健康」行） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderHealthSettings(opts: {
  tab: any;
  makeModuleWrap: ModuleWrapFactory;
  addHeaderButtonsVisibilitySetting: HeaderButtonsVisibilityAdder;
}): void {
  const { tab, makeModuleWrap, addHeaderButtonsVisibilitySetting } = opts;
  const plugin = tab.plugin;
  const sAny = plugin?.settings as any;

  const wrap = makeModuleWrap("health", "健康管理");

  addHeaderButtonsVisibilitySetting(wrap, "health", false);

  wrap.createDiv({
    cls: "rslatte-muted",
    text: "启用/关闭请在上文「模块管理」表格中勾选「健康」。本页参数与模块开关均随当前空间保存（切换空间后各自独立）；健康类 WorkEvent 写入当前空间根目录下的 .events 分片，与 resolveSpaceBaseDir 一致。",
  });

  new Setting(wrap)
    .setName("饮水目标（杯/日）")
    .setDesc("用于今日记录中日录入完成度等展示的分母（首期仅配置项，完成度算法随 WorkEvent 数据逐步收紧）。")
    .addText((tx) => {
      const cur = Math.max(1, Math.min(30, Number(sAny.healthPanel?.waterGoalCups ?? 8) || 8));
      tx.inputEl.type = "number";
      tx.inputEl.min = "1";
      tx.inputEl.max = "30";
      tx.setValue(String(cur)).onChange(async (v) => {
        const n = Math.max(1, Math.min(30, parseInt(String(v).trim(), 10) || 8));
        if (!sAny.healthPanel) sAny.healthPanel = {};
        sAny.healthPanel.waterGoalCups = n;
        await tab.saveAndRefreshSidePanelDebounced?.();
      });
    });

  new Setting(wrap)
    .setName("目标体重（kg）")
    .setDesc("健康清单筛选「体重」或编辑日卡体重时显示的折线图参考线（虚线）；用于对比当前趋势与目标差异。默认 55。")
    .addText((tx) => {
      const def = 55;
      const curRaw = Number(sAny.healthPanel?.targetWeightKg);
      const cur = Number.isFinite(curRaw) && curRaw > 0 && curRaw < 500 ? curRaw : def;
      tx.inputEl.type = "number";
      tx.inputEl.min = "30";
      tx.inputEl.max = "200";
      tx.inputEl.step = "0.1";
      tx.setValue(String(cur)).onChange(async (v) => {
        const n = parseFloat(String(v).trim());
        const next = Number.isFinite(n) && n > 0 && n < 500 ? Math.round(n * 10) / 10 : def;
        if (!sAny.healthPanel) sAny.healthPanel = {};
        sAny.healthPanel.targetWeightKg = next;
        await tab.saveAndRefreshSidePanelDebounced?.();
      });
    });

  new Setting(wrap)
    .setName("目标腰围（cm）")
    .setDesc("健康清单筛选「腰围」或编辑周卡腰围时显示的折线图参考线（虚线）；默认 75。")
    .addText((tx) => {
      const def = 75;
      const curRaw = Number(sAny.healthPanel?.targetWaistCm);
      const cur = Number.isFinite(curRaw) && curRaw > 0 && curRaw < 250 ? curRaw : def;
      tx.inputEl.type = "number";
      tx.inputEl.min = "40";
      tx.inputEl.max = "200";
      tx.inputEl.step = "0.1";
      tx.setValue(String(cur)).onChange(async (v) => {
        const n = parseFloat(String(v).trim());
        const next = Number.isFinite(n) && n > 0 && n < 250 ? Math.round(n * 10) / 10 : def;
        if (!sAny.healthPanel) sAny.healthPanel = {};
        sAny.healthPanel.targetWaistCm = next;
        await tab.saveAndRefreshSidePanelDebounced?.();
      });
    });

  new Setting(wrap)
    .setName("每杯水量（ml）")
    .setDesc("日卡片「点杯」饮水时，用杯数 × 本值换算毫升并展示（默认 500）。")
    .addText((tx) => {
      const cur = Math.max(50, Math.min(2000, Number(sAny.healthPanel?.waterCupVolumeMl ?? 500) || 500));
      tx.inputEl.type = "number";
      tx.inputEl.min = "50";
      tx.inputEl.max = "2000";
      tx.setValue(String(cur)).onChange(async (v) => {
        const n = Math.max(50, Math.min(2000, parseInt(String(v).trim(), 10) || 500));
        if (!sAny.healthPanel) sAny.healthPanel = {};
        sAny.healthPanel.waterCupVolumeMl = n;
        await tab.saveAndRefreshSidePanelDebounced?.();
      });
    });

  const metricsSection = wrap.createDiv({
    cls: "rslatte-setting-subblock rslatte-health-metrics-enabled-block",
  });
  metricsSection.createDiv({
    cls: "rslatte-setting-subblock-title",
    text: "数据项显示与维护",
  });
  metricsSection.createDiv({
    cls: "rslatte-muted",
    text: "取消勾选后：今日打卡与健康清单等界面将隐藏该项；健康卡片弹窗中对应页签仅在仍有任一启用项时显示。日数据项须至少保留一项；周、月数据项可全部关闭（关闭后周卡片/月卡片页签不再出现）。",
  });

  const metricsCard = metricsSection.createDiv({ cls: "rslatte-health-metrics-enabled-card" });
  const rowForKeys = (title: string, keys: readonly HealthCanonicalMetricKey[]) => {
    const block = metricsCard.createDiv({ cls: "rslatte-health-metrics-enabled-group" });
    block.createDiv({ cls: "rslatte-health-metrics-enabled-group-title", text: title });
    const grid = block.createDiv({ cls: "rslatte-health-metrics-enabled-grid" });
    for (const key of keys) {
      const lab = healthCanonicalShortLabelZh(key);
      const labEl = grid.createEl("label", { cls: "rslatte-health-metric-toggle" });
      const cb = labEl.createEl("input", { type: "checkbox" });
      if (!sAny.healthPanel) sAny.healthPanel = {};
      if (!sAny.healthPanel.healthMetricsEnabled) sAny.healthPanel.healthMetricsEnabled = {};
      const cur = sAny.healthPanel.healthMetricsEnabled[key] !== false;
      cb.checked = cur;
      labEl.createSpan({ text: lab });
      cb.addEventListener("change", async () => {
        if (!sAny.healthPanel) sAny.healthPanel = {};
        if (!sAny.healthPanel.healthMetricsEnabled) sAny.healthPanel.healthMetricsEnabled = {};
        const next = !!cb.checked;
        if (!next && HEALTH_CANONICAL_DAY_KEYS.includes(key)) {
          const trial = { ...sAny.healthPanel.healthMetricsEnabled, [key]: false };
          const err = validateHealthMetricsEnabledForSave({ healthMetricsEnabled: trial });
          if (err) {
            cb.checked = true;
            new Notice(err);
            return;
          }
        }
        sAny.healthPanel.healthMetricsEnabled[key] = next;
        await tab.saveAndRefreshSidePanelDebounced?.();
      });
    }
  };
  rowForKeys("日数据项", HEALTH_CANONICAL_DAY_KEYS);
  rowForKeys("周数据项", HEALTH_CANONICAL_WEEK_KEYS);
  rowForKeys("月数据项", HEALTH_CANONICAL_MONTH_KEYS);

  const analysisSection = wrap.createDiv({
    cls: "rslatte-setting-subblock rslatte-health-analysis-gen-block",
  });
  analysisSection.createDiv({
    cls: "rslatte-setting-subblock-title",
    text: "健康统计与分析生成",
  });
  analysisSection.createDiv({
    cls: "rslatte-muted",
    text: "以下为「写入空间索引 health-analysis」的统计块与告警项清单。取消勾选后不再生成对应数据（刷新/重建健康索引后生效），便于减负或逐项核对原始记录与快照是否一致。与上方「数据项显示与维护」独立：后者管录入界面，本节管分析产物。",
  });

  const ensureHp = () => {
    if (!sAny.healthPanel) sAny.healthPanel = {};
    return sAny.healthPanel;
  };

  const renderToggleTable = (
    parent: HTMLElement,
    title: string,
    catalog: readonly { id: string; title: string; desc: string }[],
    storageKey: "healthStatsMetricsEnabled" | "healthRuleAlertsEnabled",
  ) => {
    parent.createDiv({ cls: "rslatte-health-analysis-gen-table-title", text: title });
    const table = parent.createEl("table", { cls: "rslatte-health-analysis-gen-table" });
    const thead = table.createEl("thead");
    const hr = thead.createEl("tr");
    hr.createEl("th", { text: "生成", cls: "rslatte-health-analysis-gen-col-check" });
    hr.createEl("th", { text: "名称" });
    hr.createEl("th", { text: "说明 / 标识" });
    const tbody = table.createEl("tbody");
    for (const row of catalog) {
      const tr = tbody.createEl("tr");
      const td0 = tr.createEl("td", { cls: "rslatte-health-analysis-gen-col-check" });
      const cb = td0.createEl("input", { type: "checkbox" });
      const hp = ensureHp();
      if (!hp[storageKey]) hp[storageKey] = {};
      const bag = hp[storageKey] as Record<string, boolean>;
      cb.checked = bag[row.id] !== false;
      cb.addEventListener("change", async () => {
        const h = ensureHp();
        if (!h[storageKey]) h[storageKey] = {};
        (h[storageKey] as Record<string, boolean>)[row.id] = !!cb.checked;
        await tab.saveAndRefreshSidePanelDebounced?.();
      });
      tr.createEl("td", { text: row.title });
      const tdDesc = tr.createEl("td");
      tdDesc.createDiv({ text: row.desc });
      tdDesc.createEl("code", { cls: "rslatte-health-analysis-gen-id", text: row.id });
    }
  };

  renderToggleTable(
    analysisSection,
    "统计指标（写入各自然月 stats 快照）",
    HEALTH_STATS_METRIC_CATALOG,
    "healthStatsMetricsEnabled",
  );

  const ruleRows = HEALTH_RULE_ALERT_CATALOG.filter((r) => r.kind === "rule");
  const baseRows = HEALTH_RULE_ALERT_CATALOG.filter((r) => r.kind === "base");
  const alertsWrap = analysisSection.createDiv({ cls: "rslatte-health-analysis-gen-alerts-wrap" });
  renderToggleTable(alertsWrap, "规则告警（写入各月 alerts 快照）", ruleRows, "healthRuleAlertsEnabled");
  renderToggleTable(alertsWrap, "基础诊断（写入 health-analysis.alert-index.json）", baseRows, "healthRuleAlertsEnabled");
}
