import { Notice, type Plugin } from "obsidian";
import type { RSLattePluginSettings } from "../types/settings";
import { buildDupSet, isValidId } from "../utils/id";

export class SettingsService {
  private _lastSaveBlockAt = 0;

  constructor(
    private plugin: Plugin,
    private defaults: RSLattePluginSettings
  ) {}

  async load(): Promise<RSLattePluginSettings> {
    const data = await this.plugin.loadData();
    // Object.assign 只做浅合并：settings 内部对象/数组整体以持久化数据为准
    return Object.assign({}, this.defaults, data ?? {});
  }

  /** ✅ 统一入口：先 trim 再校验；校验失败则阻止落盘 */
  async save(settings: RSLattePluginSettings): Promise<boolean> {

    this.normalizeListsBeforeSave(settings);

    const v = this.validateListsBeforeSave(settings);
    if (!v.ok) {
      this.notifySaveBlocked(v.message!);
      return false;
    }

    await this.plugin.saveData(settings);
    return true;
  }


  /** 仅用于关键元数据（例如 vaultId）落盘：不做任何校验 */
  async saveRaw(settings: RSLattePluginSettings): Promise<void> {
    await this.plugin.saveData(settings);
  }


  normalizeListsBeforeSave(settings: RSLattePluginSettings) {
    settings.checkinItems?.forEach(x => {
      x.id = (x.id ?? "").trim();
      x.name = (x.name ?? "").trim();
    });
    settings.financeCategories?.forEach(x => {
      x.id = (x.id ?? "").trim();
      x.name = (x.name ?? "").trim();
    });
  }

  validateListsBeforeSave(settings: RSLattePluginSettings): { ok: boolean; message?: string } {
    const ck = settings.checkinItems ?? [];
    const fin = settings.financeCategories ?? [];

    const ckDupIds = buildDupSet(ck.map(x => x.id));
    const ckDupNames = buildDupSet(ck.map(x => x.name));
    const ckBadId = ck.some(x => !isValidId(x.id));

    const finDupIds = buildDupSet(fin.map(x => x.id));
    const finDupNames = buildDupSet(fin.map(x => x.name));
    const finBadId = fin.some(x => !isValidId(x.id));

    const reasons: string[] = [];
    if (ckBadId || finBadId) reasons.push("存在 ID 格式非法（仅允许字母/数字/_ 且以字母开头）");
    if (ckDupIds.size || finDupIds.size) reasons.push("存在 ID 重复");
    if (ckDupNames.size || finDupNames.size) reasons.push("存在 名称 重复");

    if (reasons.length) return { ok: false, message: `配置未保存：${reasons.join("；")}` };
    return { ok: true };
  }

  private notifySaveBlocked(msg: string) {
    const now = Date.now();
    if (now - this._lastSaveBlockAt < 1200) return;
    this._lastSaveBlockAt = now;
    new Notice(msg);
  }
}
