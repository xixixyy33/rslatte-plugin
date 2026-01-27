import type { RSLattePluginSettings } from "../types/settings";

/**
 * Step F5：Space-scoped settings.
 *
 * 目标：让“每个 space 一套配置”在不大规模改动代码的情况下落地。
 *
 * 做法：把这些 key 视为 space-scoped：
 * - 切换 space 时：
 *   1) 把当前 settings 的这些字段快照写入 spaces[cur].settingsSnapshot
 *   2) 用目标 spaces[next].settingsSnapshot 覆盖 settings 的这些字段
 *
 * 这样现有代码继续读写 plugin.settings.*，但语义变为“当前 space 的设置”。
 */

// 仅选择“最可能需要按 space 隔离”的字段；全局字段如 apiBaseUrl/vaultId 等保持共享。
export const SPACE_SCOPED_SETTING_KEYS: Array<keyof RSLattePluginSettings> = [
  // module on/off + policies
  "moduleEnabled",
  "moduleEnabledV2",
  "checkinPanel",
  "financePanel",
  "taskModule",
  "memoModule",
  "projectModule" as any, // 兼容：部分版本可能存在 projectModule 字段
  "outputModule" as any,  // 兼容：部分版本可能存在 outputModule 字段
  "contactsModule",

  // list defs / ui cache
  "checkinItems",
  "checkinDisplayStyle",
  "financeCategories",
  "dailyState",

  // log headings / prefixes (通常与模块配置绑定)
  "financeLogHeading",
  "financeLogLinePrefix",
  "checkinLogHeading",
  "checkinLogLinePrefix",

  // panels
  "taskPanel",
  "journalPanels",
  "showJournalPanels",
  "journalAppendRules",

  // project/output/publish panel settings (若存在)
  "projectPanel" as any,
  "outputPanel" as any,
  "publishPanel" as any,
  "projectArchiveTemplates" as any,
  
  // project management settings (按空间隔离：不同空间可能有不同的项目目录和模板)
  "projectRootDir" as any,
  "projectArchiveDir" as any,
  "projectTasklistTemplatePath" as any,
  "projectInfoTemplatePath" as any,
  "projectAnalysisTemplatePath" as any,
  "projectArchiveTemplateRecentIds" as any,
  
  // project management legacy fields (旧字段，用于兼容)
  "projectEnableDbSync" as any,
  "projectAutoArchiveEnabled" as any,
  "projectRSLatteIndexDir" as any,
  "projectArchiveThresholdDays" as any,
  "projectArchiveLastRunKey" as any,
  
  // record management legacy fields (打卡/财务旧字段，用于兼容)
  "rslattePanelIndexDir" as any,
  "rslattePanelEnableDbSync" as any,
  "rslattePanelAutoArchiveEnabled" as any,
  "rslattePanelArchiveThresholdDays" as any,
  "rslattePanelArchiveLastRunKey" as any,
  "rslattePanelLastDiaryScanMs" as any,
  "rslattePanelShowFinancePieCharts" as any,
  
  // journal/diary settings (日志管理：不同空间可能有不同的日记路径和模板)
  "diaryTemplate" as any,
  "diaryPath" as any,
  "diaryNameFormat" as any,
  "diaryArchiveMonthDirName" as any,
  "diaryArchiveThresholdDays" as any,
  "diaryArchiveLastRunKey" as any,
  
  // ✅ 以下字段为全局配置，不应按空间隔离，已从 SPACE_SCOPED_SETTING_KEYS 中移除：
  // - autoRefreshIndexEnabled: 全局自动刷新开关
  // - autoRefreshIndexIntervalMin: 全局自动刷新频率
  // - centralIndexDir: 全局中央索引目录
  // - workEventEnabled: 全局 WorkEvent 开关
  // - workEventRelPath: 全局 WorkEvent 路径
  // - vaultId: 全局 Vault ID（已在注释中说明，但为明确性再次强调）
  // - apiBaseUrl: 全局 API Base URL（已在注释中说明，但为明确性再次强调）
  // - debugLogEnabled: 全局调试日志开关（已在注释中说明，但为明确性再次强调）
  
  // UI header buttons visibility (UI按钮显隐：不同空间可能有不同的UI配置)
  "uiHeaderButtons" as any,
];

function clone<T>(v: T): T {
  // settings 是纯 JSON 结构，使用 JSON clone 足够且最稳。
  return v === undefined ? (v as any) : (JSON.parse(JSON.stringify(v)) as T);
}

/** Extract a space-scoped snapshot from current settings. */
export function extractPerSpaceSettings(settings: RSLattePluginSettings): Partial<RSLattePluginSettings> {
  const out: Partial<RSLattePluginSettings> = {};
  for (const k of SPACE_SCOPED_SETTING_KEYS) {
    const v = (settings as any)[k];
    if (v !== undefined) (out as any)[k] = clone(v);
  }
  return out;
}

/** Reset space-scoped keys to defaults, then overlay snapshot (if any). */
export function applyPerSpaceSettings(
  settings: RSLattePluginSettings,
  snapshot: Partial<RSLattePluginSettings> | undefined,
  defaults: RSLattePluginSettings
): void {
  // 1) reset all space-scoped keys to defaults
  for (const k of SPACE_SCOPED_SETTING_KEYS) {
    const dv = (defaults as any)[k];
    if (dv === undefined) {
      // 若 defaults 未定义该字段，则清空以避免把上一空间的值“带过去”
      try {
        delete (settings as any)[k];
      } catch {
        (settings as any)[k] = undefined;
      }
      continue;
    }
    (settings as any)[k] = clone(dv);
  }

  // 2) overlay
  if (!snapshot) return;
  for (const [k, v] of Object.entries(snapshot)) {
    if (!(SPACE_SCOPED_SETTING_KEYS as readonly string[]).includes(k)) continue;
    (settings as any)[k] = clone(v as any);
  }
}
