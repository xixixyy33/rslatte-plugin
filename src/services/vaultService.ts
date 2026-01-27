import { apiTry, RSLatteApiClient, type VaultSyncReq } from "../api";
import { DEFAULT_SPACE_ID } from "../constants/space";
import type { RSLattePluginSettings } from "../types/settings";
import type { SettingsService } from "./settingsService";
import type { AuditService } from "./auditService";

export type VaultServiceHost = {
  settings: RSLattePluginSettings;
  api: RSLatteApiClient;
  /** 用于显示 Notice/刷新 UI 的回调 */
  refreshSidePanel: () => void;
  /** 数据库连接 OK 且有模块开启 DB 同步时，ensure 后用于同步 vault 名称与空间列表 */
  getVaultSyncPayload?: () => VaultSyncReq;
  /** 用于侧边栏状态灯：DB sync 开启但后端不可用时标红 */
  setBackendDbReady?: (ready: boolean, reason?: string) => void;
};

export class VaultService {
  /** console.warn 节流：避免 URL 不可用时刷屏 */
  private _lastWarnAt = 0;
  private _lastWarnMsg = "";

  /**
   * ✅ 后端探测/初始化接口的短期缓存（避免 UI 频繁 refresh 时重复触达 ensure/initialized）
   * - 只做很短 TTL（默认 1500ms），不会让状态“长时间不更新”
   */
  private _ensureVaultPromise: Promise<boolean> | null = null;
  private _ensureVaultAt = 0;
  private _dbReadyPromise: Promise<{ ok: boolean; initialized: boolean; reason: string; raw?: any }> | null = null;
  private _dbReadyAt = 0;

  /** warn 最小间隔（ms） */
  private static readonly WARN_THROTTLE_MS = 10_000;

  /** ensure/initialized 的短缓存 TTL（ms） */
  private static readonly TOUCH_CACHE_TTL_MS = 1500;

  constructor(
    private host: VaultServiceHost,
    private settingsSvc: SettingsService,
    private auditSvc: AuditService
  ) {}

  /**
   * ✅ 后端触达条件：
   * - URL 必须是 http/https
   * - 且至少一个模块开启 DB sync
   */
  public shouldTouchBackendNow(): { ok: boolean; reason: string; baseUrl: string } {
    const s: any = this.host.settings as any;
    const baseUrl = String(s.apiBaseUrl ?? "").trim();
    if (!baseUrl) return { ok: false, reason: "URL 未配置", baseUrl };

    // 必须 http/https
    const lower = baseUrl.toLowerCase();
    if (!(lower.startsWith("http://") || lower.startsWith("https://"))) {
      return { ok: false, reason: "URL 必须以 http/https 开头", baseUrl };
    }
    try {
      // eslint-disable-next-line no-new
      new URL(baseUrl);
    } catch {
      return { ok: false, reason: "URL 格式不合法", baseUrl };
    }

    // 至少一个模块开启 DB sync
    const enabledV2: any = s.moduleEnabledV2 ?? {};
    const moduleOn = (k: string): boolean => {
      // contacts：新模块默认关闭；undefined 也视为关闭，避免旧 vault 误开启
      if (k === "contacts") return enabledV2?.contacts === true;
      const v = enabledV2?.[k];
      return v !== false; // undefined 视为开启（兼容旧配置）
    };

    const anyDbSync = [
      // v6-3b (record split)
      moduleOn("checkin") && !!s.checkinPanel?.enableDbSync,
      moduleOn("finance") && !!s.financePanel?.enableDbSync,

      // v6-5.x (task/memo)
      moduleOn("task") && !!s.taskModule?.enableDbSync,
      moduleOn("memo") && !!s.memoModule?.enableDbSync,

      // v23+ project/output
      moduleOn("project") && !!s.projectEnableDbSync,
      moduleOn("output") && !!s.outputPanel?.enableDbSync,

      // vC1 contacts (placeholder)
      moduleOn("contacts") && !!s.contactsModule?.enableDbSync,

      // legacy record flag
      !!s.rslattePanelEnableDbSync,
    ].some(Boolean);

    if (!anyDbSync) return { ok: false, reason: "DB 同步已全部关闭", baseUrl };
    return { ok: true, reason: "", baseUrl };
  }

  private warnThrottled(msg: string, err?: any): void {
    const now = Date.now();
    const sameMsg = msg === this._lastWarnMsg;
    if (sameMsg && now - this._lastWarnAt < VaultService.WARN_THROTTLE_MS) return;

    this._lastWarnAt = now;
    this._lastWarnMsg = msg;

    const debug = !!(this.host.settings as any)?.debugLogEnabled;
    if (debug && err) console.warn(msg, err);
    else console.warn(msg);
  }


  private classifyBackendError(e: any): { kind: "connection" | "auth" | "init" | "other"; reason: string; initRequired: boolean } {
    const status = e?.status ?? e?.data?.status_code ?? e?.data?.detail?.status_code;
    const detail = e?.data?.detail;
    const msgRaw =
      (typeof detail === "string" ? detail : detail?.message) ||
      e?.data?.reason ||
      e?.message ||
      String(e);
    const msg = String(msgRaw ?? "").trim();
    const code = e?.data?.detail?.code ?? e?.data?.code;

    if (status === 401 || status === 403) {
      return { kind: "auth", reason: `鉴权失败（HTTP ${status}）`, initRequired: false };
    }

    if (code === "DB_NOT_INITIALIZED" || msg.includes("DB_NOT_INITIALIZED") || msg.includes("未初始化") || msg.toLowerCase().includes("not initialized")) {
      return { kind: "init", reason: "数据库未初始化", initRequired: true };
    }

    const name = String(e?.name ?? "");
    const lower = msg.toLowerCase();

    const isTimeout = name === "AbortError" || lower.includes("timeout") || lower.includes("timed out");
    const isDns = lower.includes("enotfound") || lower.includes("dns") || lower.includes("name not resolved");
    const isRefused = lower.includes("econnrefused") || lower.includes("connection refused") || lower.includes("refused");
    const isNetwork = lower.includes("failed to fetch") || lower.includes("networkerror") || lower.includes("network error");

    if (isTimeout || isDns || isRefused || isNetwork) {
      const reason = isTimeout ? "连接超时" : isDns ? "DNS/地址解析失败" : isRefused ? "连接被拒绝" : "网络连接失败";
      return { kind: "connection", reason, initRequired: false };
    }

    return { kind: "other", reason: msg || "后端不可用", initRequired: false };
  }

  private genUuid(): string {
    const c = (globalThis as any).crypto;
    if (c?.randomUUID) return c.randomUUID();

    const s4 = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
    return `${s4()}${s4()}-${s4()}-${s4()}-${s4()}-${s4()}${s4()}${s4()}`.toLowerCase();
  }

  /**
   * Vault Ready 三步：
   * Step1: settings 中没有 vaultId 就生成并落盘（保证“同一 vault 永久一致”）
   * Step2: 给 api client 注入 vaultId header（所有请求携带 X-Vault-Id）
   * Step3: 调后端 ensureVault：后端创建/检查该 vaultId 的隔离空间（幂等）
   */
  async ensureVaultReady(opts?: { ensureBackend?: boolean; tolerateErrors?: boolean; reason?: string }): Promise<void> {
    if (!this.host.settings.vaultId?.trim()) {
      this.host.settings.vaultId = this.genUuid();
      await this.settingsSvc.saveRaw(this.host.settings);
    }

    this.host.api.setVaultId(this.host.settings.vaultId);
    // Step F4: always attach space scope header (X-Space-Id)
    try {
      (this.host.api as any)?.setSpaceId?.((this.host.settings as any)?.currentSpaceId ?? DEFAULT_SPACE_ID);
    } catch {
      // ignore
    }

    // ✅ 启动阶段：避免无意义的网络请求导致 console 红字刷屏。
    // - ensureBackend=false：仅保证本地 vaultId 与 header 就绪，不触发后端请求。
    const ensureBackend = opts?.ensureBackend !== false;
    const baseUrl = (this.host.settings.apiBaseUrl || "").trim();
    if (!ensureBackend) return;
    if (!baseUrl) return; // 未配置后端地址：不做请求

    // ✅ D9：后端触达必须通过 shouldTouchBackendNow（URL 校验 + 至少一项 DB sync 开启）
    const touch = this.shouldTouchBackendNow();
    if (!touch.ok) return;

    try {
      await apiTry("注册/检查 vault_id", () => this.host.api.ensureVault());
    } catch (e: any) {
      // tolerateErrors=true：best-effort，不抛出；仅 warn（节流）+ 标记后端不可用。
      if (opts?.tolerateErrors) {
        const c = this.classifyBackendError(e);
        try { this.host.setBackendDbReady?.(false, c.reason); } catch {}
        this.warnThrottled(`RSLatte 后端不可达（${opts?.reason ?? ""}）：${c.reason}`, e);
        return;
      }
      throw e;
    }
  }

  /**
   * ✅ Safe 版本：
   * - URL 未配置/不合法/DB sync 全关：绝不触达后端
   * - 即使请求失败：仅 console.warn（节流）+ setBackendDbReady(false)
   * - 绝不 throw（不阻断任何模块基础功能）
   */
  async ensureVaultReadySafe(reason?: string): Promise<boolean> {
    // Step1-2: vaultId + header 注入（本地动作，永不触网）
    try {
      await this.ensureVaultReady({ ensureBackend: false });
    } catch (e) {
      // should not happen, but keep safe
      this.warnThrottled(`RSLatte ensureVaultReadySafe(local) failed：${String((e as any)?.message ?? e)}`);
      return false;
    }

    const touch = this.shouldTouchBackendNow();
    if (!touch.ok) {
      try { this.host.setBackendDbReady?.(false, touch.reason); } catch {}
      return false;
    }

    // ✅ 短期缓存：避免同一波 UI refresh 触发多次 ensure
    const now = Date.now();
    if (this._ensureVaultPromise && (now - this._ensureVaultAt) < VaultService.TOUCH_CACHE_TTL_MS) {
      return this._ensureVaultPromise;
    }
    this._ensureVaultAt = now;
    this._ensureVaultPromise = (async () => {
      try {
        await this.host.api.ensureVault();
        try { this.host.setBackendDbReady?.(true, ""); } catch {}
        if (this.host.getVaultSyncPayload) {
          try {
            const payload = this.host.getVaultSyncPayload();
            const syncResp = await this.host.api.syncVaultInfo(payload);
            if (syncResp.ok === false) {
              this.warnThrottled(`RSLatte vault 信息同步失败：${(syncResp as any).reason ?? "unknown"}`);
            }
          } catch (_) {
            // best-effort，不因同步失败影响 ensure 结果
          }
        }
        return true;
      } catch (e: any) {
        const c = this.classifyBackendError(e);
        try { this.host.setBackendDbReady?.(false, c.reason); } catch {}
        this.warnThrottled(`RSLatte 后端不可达（${reason ?? ""}）：${c.reason}`, e);
        return false;
      }
    })();
    return this._ensureVaultPromise;
  }

  /**
   * ✅ Safe DB Ready 检查（统一入口）
   * - 内部会先 ensureVaultReadySafe（其内部已判断 shouldTouchBackendNow）
   * - 失败仅 warn（节流），绝不 throw
   * - 返回 { ok, initialized, reason }
   */
  async checkDbReadySafe(reason?: string): Promise<{ ok: boolean; initialized: boolean; reason: string; raw?: any }> {
    const touch = this.shouldTouchBackendNow();
    if (!touch.ok) {
      const r = { ok: false, initialized: false, reason: touch.reason || "后端未启用" };
      try { this.host.setBackendDbReady?.(false, r.reason); } catch {}
      return r;
    }

    // ✅ 短期缓存：避免一次 refreshSidePanel 刷新多个视图时重复触达 initialized
    const now = Date.now();
    if (this._dbReadyPromise && (now - this._dbReadyAt) < VaultService.TOUCH_CACHE_TTL_MS) {
      return this._dbReadyPromise;
    }
    this._dbReadyAt = now;
    this._dbReadyPromise = this._checkDbReadySafeImpl(reason);
    return this._dbReadyPromise;
  }

  private async _checkDbReadySafeImpl(reason?: string): Promise<{ ok: boolean; initialized: boolean; reason: string; raw?: any }> {
    const touch = this.shouldTouchBackendNow();
    if (!touch.ok) {
      const r = { ok: false, initialized: false, reason: touch.reason || "后端未启用" };
      try { this.host.setBackendDbReady?.(false, r.reason); } catch {}
      return r;
    }

    const ensured = await this.ensureVaultReadySafe(reason ? `${reason}.checkDbReady` : "checkDbReadySafe");
    if (!ensured) {
      const r = { ok: false, initialized: false, reason: "后端不可用" };
      try { this.host.setBackendDbReady?.(false, r.reason); } catch {}
      return r;
    }

    try {
      // 不使用 api.checkDbReady：避免抛错；用 dbInitialized 取结构化结果
      const raw: any = await this.host.api.dbInitialized();
      const ok = !!(raw && raw.ok !== false);
      const initialized = !!(raw && raw.initialized);
      let reason2 = String(raw?.reason ?? "");
      // ✅ D9-7：仅当后端明确返回 initialized=false 时，才提示“未初始化”
      if (ok && !initialized) reason2 = "数据库未初始化";
      if (!reason2 && !(ok && initialized)) reason2 = "数据库不可用";
      const ready = ok && initialized;

      try { this.host.setBackendDbReady?.(ready, ready ? "" : reason2); } catch {}
      return { ok: ready, initialized, reason: reason2, raw };
    } catch (e: any) {
      const c = this.classifyBackendError(e);
      try { this.host.setBackendDbReady?.(false, c.reason); } catch {}
      this.warnThrottled(`RSLatte 后端不可达（${reason ?? "checkDbReadySafe"}）：${c.reason}`, e);
      return { ok: false, initialized: false, reason: c.reason, raw: e?.data };
    }
  }

  /** ✅ 重置 vaultId（两段确认后调用） */
  async resetVaultIdAndEnsure(): Promise<string> {
    const oldId = (this.host.settings.vaultId || "").trim();
    const newId = this.genUuid();

    await this.auditSvc.appendAuditLog({
      action: "RESET_VAULT_ID",
      old_vault_id: oldId || null,
      new_vault_id: newId,
      note: "user_confirmed",
    });

    this.host.settings.vaultId = newId;
    await this.settingsSvc.saveRaw(this.host.settings);

    this.host.api.setVaultId(newId);
    // ✅ D9：统一后端触达入口（内部会做 shouldTouchBackendNow 判断 + warn 节流）
    await this.ensureVaultReadySafe("resetVaultIdAndEnsure");

    this.host.refreshSidePanel();
    return newId;
  }
}
