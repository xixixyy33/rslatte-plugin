import type { RSLattePluginSettings } from "../types/settings";

export async function migrateJumpHeadingsToPanelsIfNeeded(
  settings: RSLattePluginSettings,
  save: () => Promise<void>
) {
  if (Array.isArray(settings.journalPanels) && settings.journalPanels.length > 0) return;

  const legacy: any = (settings as any).todayJumpHeadings;
  if (Array.isArray(legacy) && legacy.length > 0) {
    settings.journalPanels = legacy.map((x: any, idx: number) => ({
      id: `JP_${idx + 1}`,
      label: x.label || x.heading || `子窗口${idx + 1}`,
      heading: x.heading || "### 标题",
      maxLines: 20,
    }));
    await save();
  } else {
    settings.journalPanels = [
      { id: "JP_ACCUM", label: "📝 今日积累", heading: "### 今日积累", maxLines: 20 },
    ];
    await save();
  }
}
