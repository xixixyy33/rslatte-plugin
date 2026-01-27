import { DEFAULT_SPACE_ID } from "../constants/space";
import type { RSLattePluginSettings } from "../types/settings";
import type { RSLatteSpaceConfig } from "../types/space";
import { extractPerSpaceSettings } from "./spaceSettings";

export async function migrateSpacesIfNeeded(
  settings: RSLattePluginSettings,
  saveRaw: (s: RSLattePluginSettings) => Promise<void>
): Promise<void> {
  let changed = false;

  const now = new Date().toISOString();

  // 1) spaces
  if (!settings.spaces || typeof settings.spaces !== "object") {
    settings.spaces = {};
    changed = true;
  }

  // 2) ensure default space exists
  const spaces = settings.spaces as Record<string, RSLatteSpaceConfig>;
  if (!spaces[DEFAULT_SPACE_ID]) {
    spaces[DEFAULT_SPACE_ID] = {
      id: DEFAULT_SPACE_ID,
      name: "默认空间",
      createdAt: now,
      updatedAt: now,
      // Step F5：旧配置迁移到 default space 的快照
      settingsSnapshot: extractPerSpaceSettings(settings),
    };
    changed = true;
  } else {
    // best-effort normalize
    const s = spaces[DEFAULT_SPACE_ID];
    if (!s.id) { s.id = DEFAULT_SPACE_ID; changed = true; }
    if (!s.name) { s.name = "默认空间"; changed = true; }
    if (!s.createdAt) { s.createdAt = now; changed = true; }
    if (!s.updatedAt) { s.updatedAt = now; changed = true; }

    // Step F5：确保 default space 有快照（只在缺失时补齐）
    if (!(s as any).settingsSnapshot) {
      (s as any).settingsSnapshot = extractPerSpaceSettings(settings);
      changed = true;
    }
  }

  // 3) currentSpaceId
  const cur = String((settings as any).currentSpaceId ?? "").trim();
  if (!cur || !spaces[cur]) {
    (settings as any).currentSpaceId = DEFAULT_SPACE_ID;
    changed = true;
  }

  // 4) ensure each space has id
  for (const [k, v] of Object.entries(spaces)) {
    if (!v || typeof v !== "object") continue;
    if (!v.id) { (v as any).id = k; changed = true; }
    if (!v.updatedAt) { (v as any).updatedAt = now; changed = true; }
    if (!v.createdAt) { (v as any).createdAt = now; changed = true; }

    // Step F5：为非默认空间补齐快照字段（空对象即可，避免 undefined 判断散落）
    if ((v as any).settingsSnapshot === undefined) {
      (v as any).settingsSnapshot = {};
      changed = true;
    }
  }

  if (changed) {
    await saveRaw(settings);
  }
}
