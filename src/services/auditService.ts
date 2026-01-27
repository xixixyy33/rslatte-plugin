import { normalizePath, type App } from "obsidian";

export class AuditService {
  constructor(
    private app: App,
    private pluginId: string,
    private pluginVersion: string
  ) {}

  /** 审计日志路径：<vault>/.obsidian/plugins/<pluginId>/audit.log */
  getAuditLogPath(): string {
    const configDir = (this.app.vault as any).configDir || ".obsidian";
    return normalizePath(`${configDir}/plugins/${this.pluginId}/audit.log`);
  }

  async ensureDirForPath(filePath: string) {
    const adapter: any = this.app.vault.adapter as any;
    const parts = filePath.split("/").filter(Boolean);
    if (parts.length <= 1) return;

    const dir = parts.slice(0, -1).join("/");
    try {
      if (adapter?.mkdir) await adapter.mkdir(dir);
    } catch {
      // ignore
    }
  }

  /** 追加审计日志（一行 JSONL）。失败不阻断主流程 */
  async appendAuditLog(entry: Record<string, any>) {
    try {
      const adapter: any = this.app.vault.adapter as any;
      const logPath = this.getAuditLogPath();
      await this.ensureDirForPath(logPath);

      const record = {
        ts: new Date().toISOString(),
        action: entry.action ?? "UNKNOWN",
        plugin_version: this.pluginVersion,
        vault_name: this.app.vault.getName(),
        ...entry,
      };

      const line = JSON.stringify(record) + "\n";

      if (typeof adapter.append === "function") {
        await adapter.append(logPath, line);
        return;
      }

      let existing = "";
      try {
        if (adapter?.exists && (await adapter.exists(logPath))) {
          existing = await adapter.read(logPath);
        }
      } catch {}
      await adapter.write(logPath, existing + line);
    } catch (e) {
      console.warn("RSLatte audit log failed:", e);
    }
  }
}
