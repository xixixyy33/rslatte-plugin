import type { RSLattePluginSettings, UiModuleKey, UiHeaderButtonVisibility } from "../../types/settings";

/**
 * UI-only config: header action buttons visibility.
 * Controls only 🧱🗄🔄. The ➕ button (where exists) is always visible.
 */
export function getUiHeaderButtonsVisibility(
  settings: RSLattePluginSettings,
  moduleKey: UiModuleKey,
): UiHeaderButtonVisibility {
  const cfg = (settings as any).uiHeaderButtons?.[moduleKey] as Partial<UiHeaderButtonVisibility> | undefined;
  return {
    rebuild: cfg?.rebuild !== false,
    archive: cfg?.archive !== false,
    refresh: cfg?.refresh !== false,
  };
}

export function ensureUiHeaderButtonsConfig(settings: RSLattePluginSettings): void {
  const s: any = settings as any;
  if (!s.uiHeaderButtons) s.uiHeaderButtons = {};
  const mk = ["checkin", "finance", "memo", "task", "project", "output", "contacts"] as const;
  for (const k of mk) {
    if (!s.uiHeaderButtons[k]) s.uiHeaderButtons[k] = { rebuild: true, archive: true, refresh: true };
    if (s.uiHeaderButtons[k].rebuild === undefined) s.uiHeaderButtons[k].rebuild = true;
    if (s.uiHeaderButtons[k].archive === undefined) s.uiHeaderButtons[k].archive = true;
    if (s.uiHeaderButtons[k].refresh === undefined) s.uiHeaderButtons[k].refresh = true;
  }
}

export function setUiHeaderButtonVisibility(
  settings: RSLattePluginSettings,
  moduleKey: UiModuleKey,
  key: keyof UiHeaderButtonVisibility,
  on: boolean,
): void {
  ensureUiHeaderButtonsConfig(settings);
  const s: any = settings as any;
  s.uiHeaderButtons[moduleKey][key] = !!on;
}
