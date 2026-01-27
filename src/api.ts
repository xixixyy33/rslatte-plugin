import { Notice } from "obsidian";
import { DEFAULT_SPACE_ID } from "./constants/space";


export type ApiCheckinType = {
  checkin_id: string;
  checkin_name: string;
  status: boolean;
  order_no: number;
  created_at: string;
};

export type ApiFinanceCategory = {
  category_id: string;
  category_name: string;
  category_type: "income" | "expense";
  status: boolean;
  order_no: number;
  created_at: string;
};

export type ApiFinanceRecord = {
  id: number;
  record_date: string;        // YYYY-MM-DD
  category_id: string;
  amount: number;             // signed
  note?: string;
  is_delete?: boolean;
  created_at: string;
  updated_at?: string;
};

export type ApiCheckinRecord = {
  id: number;
  record_date: string;
  checkin_id: string;
  note?: string;
  is_delete?: boolean;
  created_at: string;
};

// =========================
// RSLatte Items (Task / Memo)
// =========================

export type RSLatteItemType = "task" | "memo";
export type RSLatteStatus = "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED" | "UNKNOWN";

export type RSLatteItemPayload = {
  item_id?: number;
  /** v2: stable id from markdown meta line (preferred). */
  uid?: string;
  item_type: RSLatteItemType;
  status: RSLatteStatus;
  text: string;
  raw?: string;
  file_path: string;
  line_no: number;
  source_hash?: string;

  // task dates
  created_date?: string;
  due_date?: string;
  start_date?: string;
  scheduled_date?: string;
  done_date?: string;
  cancelled_date?: string;

  // memo fields
  memo_date?: string;
  memo_mmdd?: string;
  repeat_rule?: "none" | "weekly" | "monthly" | "seasonly" | "yearly";
  remind_days?: number;
  priority?: number;
  last_notified_date?: string;
};

// =========================
// v2 Upsert Batch (uid-first)
// =========================

export type RSLatteItemsUpsertBatchReq = { items: RSLatteItemPayload[] };

export type RSLatteUpsertResult = {
  ok: boolean;
  item_type: RSLatteItemType;
  uid?: string;
  item_id?: number;
  message?: string;
};

export type RSLatteItemsUpsertBatchResp = { results: RSLatteUpsertResult[] };

export type RSLatteSyncOp = {
  op_id: string;
  action: "create" | "update" | "delete";
  item: RSLatteItemPayload;
};

export type RSLatteSyncBatchReq = { ops: RSLatteSyncOp[] };

export type RSLatteSyncResult = {
  op_id: string;
  ok: boolean;
  action: string;
  item_type: RSLatteItemType;
  item_id?: number;
  message?: string;
};

export type RSLatteSyncBatchResp = { results: RSLatteSyncResult[] };

export type RSLatteItemsListResp = { items: any[] };
export type RSLatteItemsGetReq = { ids: number[] };
export type RSLatteItemsGetResp = { items: any[] };

// =========================
// RSLatte Items Exists (Lightweight)
// =========================

export type RSLatteItemsExistsReq = { ids: number[] };

export type RSLatteItemsExistsResp =
  | { type: "task" | "memo"; exists: number[]; missing: number[] }
  | {
      type: "all";
      task: { exists: number[]; missing: number[] };
      memo: { exists: number[]; missing: number[] };
    };

// =========================
// Projects / Milestones Exists (Lightweight)
// =========================

export type ProjectsExistsReq = { ids: string[] };
export type ProjectsExistsResp = { type: "project"; exists: string[]; missing: string[] };

export type MilestonesExistsReq = { ids: string[] };
export type MilestonesExistsResp = { type: "milestone"; exists: string[]; missing: string[] };

// =========================
// Reconcile (Post-rebuild DB cleanup)
// =========================

export type RSLatteItemsReconcileReq = {
  /** The file paths scanned in this rebuild; used as scope to limit DB cleanup. */
  scope_file_paths: string[];
  /**
   * UIDs that are present in files after rebuild sync; rows not in this set will be marked deleted.
   * Preferred field (v2).
   */
  present_uids?: string[];
  /**
   * Legacy: numeric DB IDs that are present in files after rebuild sync.
   * Kept for backwards compatibility.
   */
  present_ids?: number[];
  dry_run?: boolean;
};

export type RSLatteItemsReconcileResp = {
  ok: boolean;
  item_type: RSLatteItemType;
  dry_run?: boolean;
  scope_files?: number;
  keep_ids?: number;
  marked_deleted?: number;
  candidates?: number;
};

export type RecordReconcileReq = {
  /** Optional: backend can parse dates from file names, but scope_dates is recommended. */
  scope_file_paths?: string[];
  /** Preferred: YYYY-MM-DD dates in the rebuild scope. */
  scope_dates?: string[];
  /** Composite keys like 'YYYY-MM-DD|CK_xxx' (checkin) or 'YYYY-MM-DD|CAT_xxx' (finance). */
  present_comp_keys: string[];
  dry_run?: boolean;
};

export type RecordReconcileResp = {
  ok: boolean;
  dry_run?: boolean;
  scope_dates?: number;
  keep?: number;
  marked_deleted?: number;
  candidates?: number;
};

export type OutputFilesReconcileReq = {
  scope_file_paths: string[];
  dry_run?: boolean;
};

export type OutputFilesReconcileResp = {
  ok: boolean;
  dry_run?: boolean;
  scope_files?: number;
  prefixes?: number;
  keep_paths?: number;
  marked_deleted?: number;
  candidates?: number;
};

export type ProjectsReconcileReq = {
  present_project_ids: string[];
  dry_run?: boolean;
};

export type ProjectsReconcileResp = {
  ok: boolean;
  dry_run?: boolean;
  keep?: number;
  marked_deleted?: number;
  candidates?: number;
};

export type CreateFinanceRecordReq = {
  record_date: string;
  category_id: string;
  amount: number;             // signed
  note?: string;
};

export type CreateCheckinRecordReq = {
  record_date: string;
  checkin_id: string;
  note?: string;
};

export type UpsertCheckinRecordReq = {
  record_date: string;
  checkin_id: string;
  note?: string;
  /** 软删标记：false=有效打卡，true=取消打卡 */
  is_delete: boolean;
};

export type UpsertFinanceRecordReq = {
  record_date: string;
  category_id: string;
  amount: number;
  note?: string;
  /** 软删标记：false=有效记录，true=取消当日账单 */
  is_delete: boolean;
};

// =====================
// Records batch upsert
// =====================

export type UpsertCheckinRecordBatchReq = {
  items: UpsertCheckinRecordReq[];
};

export type UpsertFinanceRecordBatchReq = {
  items: UpsertFinanceRecordReq[];
};

// =====================
// Contacts batch upsert
// =====================

export type ContactsUpsertItem = {
  contact_uid: string;
  display_name: string;
  aliases?: string[];
  group_name: string;
  title: string;
  status?: "active" | "cancelled";
  cancelled_at?: string | null;
  tags?: string[];
  summary?: string | null;
  company?: string | null;
  department?: string | null;
  file_path: string;
  avatar_path?: string | null;
  phones?: any[];
  emails?: any[];
  im?: any[];
  birthday?: any | null;
  last_interaction_at?: string | null;
  extra?: any;
  archived_at?: string | null;
  is_delete?: boolean;
  created_at?: string | null;
  updated_at?: string | null;
};

export type ContactsUpsertBatchReq = {
  items: ContactsUpsertItem[];
};

export type ContactsUpsertBatchResp = {
  ok: boolean;
  count: number;
};

export type BatchUpsertResult<TItem = any> =
  | { ok: true; index: number; item?: TItem }
  | { ok: false; index: number; error?: string; status_code?: number };

export type BatchUpsertResp<TItem = any> = {
  ok: boolean;
  total: number;
  success: number;
  failed: number;
  results: BatchUpsertResult<TItem>[];
};

// =====================
// Stats
// =====================

export type ApiFinanceSummaryStats = {
  kind: "finance_summary";
  as_of: string; // YYYY-MM-DD
  finance: {
    month: { income: number; expense: number };
    year: { income: number; expense: number };
  };
};

export type DbInitializedResp =
  | { ok: true; initialized: boolean; schema_version?: string | null }
  | { ok: false; initialized?: boolean; reason: string };

export type EnsureVaultResp =
  | { ok: true; vault_id: string; existed: boolean }
  | { ok: false; reason: string };

/** 信息同步：知识库名称 + 空间列表 */
export type VaultSyncSpaceItem = { space_id: string; space_name?: string | null; is_active: boolean };
export type VaultSyncReq = {
  vault_name?: string | null;
  spaces?: VaultSyncSpaceItem[] | null;
};
export type VaultSyncResp =
  | { ok: true; vault_id: string; vault_name_updated?: boolean; spaces_updated?: number }
  | { ok: false; reason?: string };

// =====================
// 手机端操作记录（PWA 上传，Obsidian 拉取后写入本地 MD）
// =====================

export type MobileOpKind = "memo" | "task" | "checkin" | "finance" | "project";
export type MobileOpAction = "create" | "update" | "delete" | "upsert_item";

export type MobileOpPayloadCheckin = {
  record_date: string; // YYYY-MM-DD
  checkin_id: string;
  note?: string;
  is_delete?: boolean;
};

export type MobileOpPayloadFinance = {
  record_date: string;
  category_id: string;
  amount: number;
  note?: string;
  /** 子分类名称（来自 finance_category.sub_categories），同步到 PC 时会合并进 note */
  sub_category?: string;
  is_delete?: boolean;
};

export type MobileOpPayloadTask = {
  uid?: string;
  text: string;
  status?: string;
  due_date?: string;
  file_path?: string;
  line_no?: number;
  [key: string]: any;
};

export type MobileOpPayloadMemo = {
  text: string;
  memo_date?: string;
  remind_days?: number;
  file_path?: string;
  [key: string]: any;
};

/** 手机端项目任务 upsert_item：payload.item 含 item_id、status、source_file_path、source_line 等 */
export type MobileOpPayloadProject = {
  project_id: string;
  item: {
    item_id: string;
    item_type: string;
    status?: string;
    title?: string;
    source_file_path?: string;
    source_line?: number;
    [key: string]: any;
  };
};

export type MobileOp = {
  id: string;
  ts: string; // ISO
  kind: MobileOpKind;
  action: MobileOpAction;
  payload: MobileOpPayloadCheckin | MobileOpPayloadFinance | MobileOpPayloadTask | MobileOpPayloadMemo | MobileOpPayloadProject;
  /** 后端是否已应用到 DB（打卡/财务通常已写入；任务/备忘可能仅记录操作） */
  applied?: boolean;
  /** 后端置错信息（如 uid 已存在），该条不应用、不标记已同步，供手机端展示提示 */
  plugin_sync_error?: string;
};

export type MobileOpsListReq = {
  since?: string; // ISO，只返回该时间之后的操作
  limit?: number;
};

export type MobileOpsListResp = {
  ok: boolean;
  ops: MobileOp[];
  next_since?: string;
};

type FetchOpts = {
  timeoutMs?: number;
};

function joinUrl(base: string, path: string) {
  // NOTE: 用户可能会误把文档里的分隔符（例如 "·"）粘贴进 baseUrl，
  // 例如 "http://192.168.1.40:8008/·"，会导致请求变成 "/·/db/initialized" 并 404。
  // 这里做一次温和清洗：仅去掉末尾的 "/·" 或 "/•" 片段，避免影响正常 URL。
  let b = (base || "").trim();
  b = b.replace(/\/\s*[·•\u00B7]+\s*\/?\s*$/, ""); // 去掉末尾的 /· 或 /•（以及可能的变体）
  b = b.replace(/\/+$/, "");

  const p = (path || "").trim().replace(/^\/+/, "");
  return `${b}/${p}`;
}

class ApiError extends Error {
  status?: number;
  data?: any;
  constructor(message: string, status?: number, data?: any) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

/**
 * ✅ 通用 JSON fetch
 * - 支持外部传 headers（包含 vault header）
 */
async function fetchJson<T>(url: string, init?: RequestInit, opts?: FetchOpts): Promise<T> {
  const controller = new AbortController();
  const t = window.setTimeout(() => controller.abort(), opts?.timeoutMs ?? 8000);

  try {
    const resp = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });

    const text = await resp.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (!resp.ok) {
      const detail = data?.detail;
      const msg =
        (typeof detail === "string" ? detail : detail?.message) ||
        data?.reason ||
        `HTTP ${resp.status} ${resp.statusText}`;

      throw new ApiError(msg, resp.status, data);
    }

    return data as T;
  } finally {
    window.clearTimeout(t);
  }
}

export type UpsertCheckinTypeReq = {
  checkin_id: string;
  checkin_name: string;
  status: boolean;
};

export type UpsertFinanceCategoryReq = {
  category_id: string;
  category_name: string;
  category_type: "income" | "expense";
  status: boolean;
};

export class RSLatteApiClient {
  private baseUrl: string;
  private vaultId: string | null = null;
  private spaceId: string = DEFAULT_SPACE_ID;

  constructor(baseUrl: string, vaultId?: string, spaceId?: string) {
    this.baseUrl = baseUrl;
    if (vaultId) this.vaultId = vaultId;
    if (spaceId) this.setSpaceId(spaceId);
  }

  setBaseUrl(url: string) {
    this.baseUrl = url;
  }

  setVaultId(vaultId: string) {
    this.vaultId = (vaultId ?? "").trim() || null;
  }

  setSpaceId(spaceId: string) {
    const sid = String(spaceId ?? "").trim();
    this.spaceId = sid || DEFAULT_SPACE_ID;
  }

  private url(path: string) {
    return joinUrl(this.baseUrl, path);
  }

  /** ✅ 统一 headers：把 vault_id 放进 header */
  private buildHeaders(extra?: Record<string, string>, opts?: { allowNoVault?: boolean }) {
    const h: Record<string, string> = { ...(extra ?? {}) };
    if (this.vaultId) h["X-Vault-Id"] = this.vaultId;

    // ✅ Space scope header (UUID). Always attach; default is all-zero UUID.
    // If caller provided X-Space-Id explicitly, keep it (but still ensure non-empty).
    if (!String(h["X-Space-Id"] ?? "").trim()) {
      h["X-Space-Id"] = this.spaceId || DEFAULT_SPACE_ID;
    }

    // 默认：除非明确 allowNoVault，否则 vaultId 必须存在
    if (!opts?.allowNoVault && !h["X-Vault-Id"]) {
      throw new ApiError("Missing vault_id header (X-Vault-Id)", 400, {
        detail: { code: "MISSING_VAULT_ID", message: "缺少 X-Vault-Id" },
      });
    }
    return h;
  }

  /** ✅ RSLatteApiClient 内部统一走这里，确保 header 统一 */
  private async _fetch<T>(
    path: string,
    init?: RequestInit,
    fetchOpts?: FetchOpts,
    headerOpts?: { allowNoVault?: boolean }
  ): Promise<T> {
    const headers = this.buildHeaders((init?.headers as any) ?? undefined, headerOpts);
    return fetchJson<T>(this.url(path), { ...(init ?? {}), headers }, fetchOpts);
  }

  // =========================
  // 4.3 ✅ ensureVault
  // =========================
  async ensureVault(): Promise<EnsureVaultResp> {
    // 这里默认要求 vaultId 必须存在（main.ts 已保证生成）
    return this._fetch<EnsureVaultResp>("/vault/ensure", { method: "POST" }, { timeoutMs: 5000 });
  }

  /**
   * 信息同步：更新后端 vault 表（vault_name）与 vault_space 表（空间列表）。
   * 在 DB 连接正常且开启 DB 同步时，ensure 或空间增删改后调用。
   */
  async syncVaultInfo(payload: VaultSyncReq): Promise<VaultSyncResp> {
    return this._fetch<VaultSyncResp>("/vault/sync", {
      method: "POST",
      body: JSON.stringify({
        vault_name: payload.vault_name ?? undefined,
        spaces: payload.spaces ?? undefined,
      }),
    }, { timeoutMs: 5000 });
  }

  // =========================
  // DB status
  // =========================
  async dbInitialized(): Promise<DbInitializedResp> {
    // 是否允许无 vaultId 调用：你可以选
    // 如果你想严格一点：删掉 allowNoVault
    return this._fetch<DbInitializedResp>(
      "/db/initialized",
      { method: "GET" },
      { timeoutMs: 5000 },
      { allowNoVault: true }
    );
  }

  /**
   * 兼容旧代码：检查 DB 是否可用（已初始化）。
   * - 返回 true：DB 可用
   * - 若不可用：抛错（交给 apiTry 弹 Notice）
   */
  async checkDbReady(): Promise<boolean> {
    const r = await this.dbInitialized();
    if (r && typeof r === "object" && "ok" in r) {
      if ((r as any).ok === true) {
        // ok=true 但 initialized=false 也视为不可用
        if ((r as any).initialized) return true;
        throw new ApiError("数据库未初始化", 503, { detail: { code: "DB_NOT_INITIALIZED", message: "数据库未初始化" } });
      }
      const reason = (r as any).reason || "数据库不可用";
      throw new ApiError(reason, 503, { detail: { code: "DB_NOT_READY", message: reason } });
    }
    throw new ApiError("数据库不可用", 503, { detail: { code: "DB_NOT_READY", message: "数据库不可用" } });
  }

  // =========================
  // RSLatte Items (Task / Memo)
  // =========================

  /** POST /rslatte-items/sync-batch */
  async rslatteItemsSyncBatch(payload: RSLatteSyncBatchReq): Promise<RSLatteSyncBatchResp> {
    return this._fetch<RSLatteSyncBatchResp>(
      "/rslatte-items/sync-batch",
      { method: "POST", body: JSON.stringify(payload) }
    );
  }

  /** POST /rslatte-items/upsert-batch?item_type=task|memo (v2 uid-first) */
  async rslatteItemsUpsertBatch(itemType: RSLatteItemType, payload: RSLatteItemsUpsertBatchReq): Promise<RSLatteItemsUpsertBatchResp> {
    const it = encodeURIComponent(itemType);
    return this._fetch<RSLatteItemsUpsertBatchResp>(
      `/rslatte-items/upsert-batch?item_type=${it}`,
      { method: "POST", body: JSON.stringify(payload) }
    );
  }

  /** GET /rslatte-items?type=task|memo&updated_after=... */
  async listRSLatteItems(params: { type: RSLatteItemType; updated_after?: string }): Promise<RSLatteItemsListResp> {
    const qs: string[] = [];
    if (params?.type) qs.push(`type=${encodeURIComponent(params.type)}`);
    if (params?.updated_after) qs.push(`updated_after=${encodeURIComponent(params.updated_after)}`);
    const q = qs.length ? `?${qs.join("&")}` : "";
    return this._fetch<RSLatteItemsListResp>(`/rslatte-items${q}`, { method: "GET" });
  }

  /** POST /rslatte-items/get body: { ids:[1,2] } */
  async getRSLatteItemsByIds(payload: RSLatteItemsGetReq): Promise<RSLatteItemsGetResp> {
    return this._fetch<RSLatteItemsGetResp>(
      "/rslatte-items/get",
      { method: "POST", body: JSON.stringify(payload) }
    );
  }

  /** POST /rslatte-items/exists body: { ids:[1,2] } (lightweight existence check) */
  async rslatteItemsExists(
    payload: RSLatteItemsExistsReq,
    params?: { type?: RSLatteItemType; include_deleted?: boolean }
  ): Promise<RSLatteItemsExistsResp> {
    const qs: string[] = [];
    if (params?.type) qs.push(`type=${encodeURIComponent(params.type)}`);
    if (params?.include_deleted) qs.push(`include_deleted=true`);
    const q = qs.length ? `?${qs.join("&")}` : "";
    return this._fetch<RSLatteItemsExistsResp>(
      `/rslatte-items/exists${q}`,
      { method: "POST", body: JSON.stringify(payload) }
    );
  }

  /** POST /rslatte-items/reconcile?item_type=task|memo */
  async rslatteItemsReconcile(
    item_type: RSLatteItemType,
    payload: RSLatteItemsReconcileReq
  ): Promise<RSLatteItemsReconcileResp> {
    const it = encodeURIComponent(item_type);
    return this._fetch<RSLatteItemsReconcileResp>(
      `/rslatte-items/reconcile?item_type=${it}`,
      { method: "POST", body: JSON.stringify(payload) }
    );
  }

  // =========================
  // Projects / Milestones Exists (Lightweight)
  // =========================

  /** POST /projects/exists body: { ids:["PJ_..."] } */
  async projectsExists(
    payload: ProjectsExistsReq,
    params?: { include_deleted?: boolean }
  ): Promise<ProjectsExistsResp> {
    const qs: string[] = [];
    if (params?.include_deleted) qs.push(`include_deleted=true`);
    const q = qs.length ? `?${qs.join("&")}` : "";
    return this._fetch<ProjectsExistsResp>(
      `/projects/exists${q}`,
      { method: "POST", body: JSON.stringify(payload) }
    );
  }

  /** POST /milestones/exists body: { ids:["PID::MS::..."] }
   *  - 建议带 project_id，避免跨项目同名里程碑误判
   */
  async milestonesExists(
    payload: MilestonesExistsReq,
    params?: { project_id?: string; include_deleted?: boolean }
  ): Promise<MilestonesExistsResp> {
    const qs: string[] = [];
    if (params?.project_id) qs.push(`project_id=${encodeURIComponent(params.project_id)}`);
    if (params?.include_deleted) qs.push(`include_deleted=true`);
    const q = qs.length ? `?${qs.join("&")}` : "";
    return this._fetch<MilestonesExistsResp>(
      `/milestones/exists${q}`,
      { method: "POST", body: JSON.stringify(payload) }
    );
  }

  // =========================
  // Reconcile (Post-rebuild DB cleanup)
  // =========================

  /** POST /checkin-records/reconcile */
  async checkinRecordsReconcile(payload: RecordReconcileReq): Promise<RecordReconcileResp> {
    return this._fetch<RecordReconcileResp>(
      `/checkin-records/reconcile`,
      { method: "POST", body: JSON.stringify(payload) }
    );
  }

  /** POST /finance-records/reconcile */
  async financeRecordsReconcile(payload: RecordReconcileReq): Promise<RecordReconcileResp> {
    return this._fetch<RecordReconcileResp>(
      `/finance-records/reconcile`,
      { method: "POST", body: JSON.stringify(payload) }
    );
  }

  /** POST /output-files/reconcile */
  async outputFilesReconcile(payload: OutputFilesReconcileReq): Promise<OutputFilesReconcileResp> {
    return this._fetch<OutputFilesReconcileResp>(
      `/output-files/reconcile`,
      { method: "POST", body: JSON.stringify(payload) }
    );
  }

  /** POST /projects/reconcile */
  async projectsReconcile(payload: ProjectsReconcileReq): Promise<ProjectsReconcileResp> {
    return this._fetch<ProjectsReconcileResp>(
      `/projects/reconcile`,
      { method: "POST", body: JSON.stringify(payload) }
    );
  }

  // =========================
  // Checkin types
  // =========================
  async listCheckinTypes(status?: boolean, includeDeleted: boolean = false): Promise<ApiCheckinType[]> {
    const qs: string[] = [];
    if (status !== undefined) qs.push(`status=${status ? "true" : "false"}`);
    if (includeDeleted) qs.push(`include_deleted=true`);
    const q = qs.length ? `?${qs.join("&")}` : "";
    const r = await this._fetch<{ items: ApiCheckinType[] }>(`/checkin-types${q}`, { method: "GET" });
    return r.items ?? [];
  }

  /**
   * Upsert checkin types.
   *
   * Backend enforces an additional UNIQUE constraint on active (vault_id, checkin_name).
   * If user recreated an item with the same name but a different id, naive upsert-by-id
   * would hit `uq_checkin_type_name_active`.
   *
   * To keep sync stable (and prevent 500), we reuse the existing id for the same name
   * when an active row already exists.
   */
  async upsertCheckinTypes(payload: UpsertCheckinTypeReq[]) {
    const normName = (s: string) => (s || "").trim();
    const normId = (s: string) => (s || "").trim();

    // Remove empties early
    const incoming = (payload ?? [])
      .map((x) => ({
        ...x,
        checkin_id: normId((x as any)?.checkin_id),
        checkin_name: normName((x as any)?.checkin_name),
      }))
      .filter((x) => x.checkin_id && x.checkin_name);

    // Fast path: 如果传入的 payload 为空，直接返回，不调用后端接口
    if (!incoming.length) {
      return { ok: true, count: 0 } as any;
    }

    // Build name->existing_id map from backend (active only)
    // ✅ 只有在 incoming 数组非空时才调用 listCheckinTypes，避免不必要的 API 调用
    let existing: ApiCheckinType[] = [];
    try {
      // 先尝试获取所有记录（包括已删除的），确保能检测到所有已存在的 name
      existing = await this.listCheckinTypes(undefined, true);
    } catch {
      // 如果失败，尝试只获取未删除的记录
      try {
        existing = await this.listCheckinTypes(undefined, false);
      } catch {
        existing = [];
      }
    }
    const name2id = new Map<string, string>();
    for (const t of existing ?? []) {
      const n = normName((t as any)?.checkin_name);
      const id = normId((t as any)?.checkin_id);
      if (n && id) {
        // ✅ 如果同一个 name 对应多个 id，优先使用活跃状态的 id（status = true），否则使用第一个
        const isActive = (t as any)?.status === true;
        if (!name2id.has(n)) {
          name2id.set(n, id);
        } else if (isActive) {
          // ✅ 如果当前记录是活跃的，优先使用它（覆盖非活跃的记录）
          name2id.set(n, id);
        }
      }
    }
    
    // ✅ 调试日志：记录检测到的已存在记录
    if (name2id.size > 0) {
      console.log(`[RSLatte][API] Found ${name2id.size} existing checkin names in current vault:`, Array.from(name2id.entries()).map(([n, id]) => `${n} -> ${id}`));
    }

    // Rewrite ids by name to avoid unique(name) violations and de-duplicate
    // ✅ 同时基于 checkin_id 和 checkin_name 去重，避免同一请求中重复的 name 导致后端唯一约束冲突
    const fixed: UpsertCheckinTypeReq[] = [];
    const seenIds = new Set<string>();
    const seenNames = new Set<string>(); // ✅ 添加 name 去重，避免同一请求中相同 name 但不同 id 的情况
    for (const it of incoming) {
      const n = normName((it as any)?.checkin_name);
      let id = normId((it as any)?.checkin_id);
      const originalId = id;
      
      // ✅ 如果 name 已存在，使用现有的 id（避免 name 唯一约束冲突）
      const existingId = name2id.get(n);
      if (existingId && existingId !== id) {
        // ✅ 发现 name 已存在但 id 不同，重写 id 以避免唯一约束冲突
        console.log(`[RSLatte][API] Rewriting checkin_id for duplicate name: "${n}" (${originalId} -> ${existingId})`);
        id = existingId;
      }
      
      // ✅ 去重：如果 id 或 name 已处理过，跳过（优先保留第一个）
      if (!id || !n) {
        continue;
      }
      
      // ✅ 如果 name 已处理过，跳过（避免同一请求中重复的 name）
      if (seenNames.has(n)) {
        console.warn(`[RSLatte][API] Skipping duplicate checkin_name in same request: "${n}" (id: ${id})`);
        continue;
      }
      
      // ✅ 如果 id 已处理过，跳过（避免同一请求中重复的 id）
      if (seenIds.has(id)) {
        console.warn(`[RSLatte][API] Skipping duplicate checkin_id in same request: ${id} (name: "${n}")`);
        continue;
      }
      
      seenIds.add(id);
      seenNames.add(n);
      fixed.push({
        ...it,
        checkin_id: id,
        checkin_name: n,
      });
    }
    
    // ✅ 调试日志：如果重写了 id 或过滤了重复项，记录信息
    if (fixed.length !== incoming.length || name2id.size > 0) {
      console.log(`[RSLatte][API] upsertCheckinTypes: incoming=${incoming.length}, fixed=${fixed.length}, existing_names=${name2id.size}`);
    }

    return this._fetch<{ ok: boolean; count: number }>(
      "/checkin-types/upsert",
      { method: "POST", body: JSON.stringify(fixed) }
    );
  }

  async deleteCheckinType(checkin_id: string) {
    const id = (checkin_id || "").trim();
    return this._fetch<{ ok: boolean }>(
      `/checkin-types/${encodeURIComponent(id)}/delete`,
      { method: "POST" }
    );
  }

  // =========================
  // Finance categories
  // =========================
  async listFinanceCategories(status?: boolean, includeDeleted: boolean = false): Promise<ApiFinanceCategory[]> {
    const qs: string[] = [];
    if (status !== undefined) qs.push(`status=${status ? "true" : "false"}`);
    if (includeDeleted) qs.push(`include_deleted=true`);
    const q = qs.length ? `?${qs.join("&")}` : "";
    const r = await this._fetch<{ items: ApiFinanceCategory[] }>(`/finance-categories${q}`, { method: "GET" });
    return r.items ?? [];
  }

  async upsertFinanceCategories(payload: UpsertFinanceCategoryReq[]) {
    return this._fetch<{ ok: boolean; count: number }>(
      "/finance-categories/upsert",
      { method: "POST", body: JSON.stringify(payload) }
    );
  }

  async deleteFinanceCategory(category_id: string) {
    const id = (category_id || "").trim();
    return this._fetch<{ ok: boolean }>(
      `/finance-categories/${encodeURIComponent(id)}/delete`,
      { method: "POST" }
    );
  }


  async listFinanceRecords(date_from?: string, date_to?: string, includeDeleted = false) {
    const qs: string[] = [];
    if (date_from) qs.push(`date_from=${encodeURIComponent(date_from)}`);
    if (date_to) qs.push(`date_to=${encodeURIComponent(date_to)}`);
    if (includeDeleted) qs.push(`include_deleted=true`);
    const q = qs.length ? `?${qs.join("&")}` : "";
    return this._fetch<{ items: ApiFinanceRecord[] }>(
      `/finance-records${q}`,
      { method: "GET" }
    );
  }


  async listCheckinRecords(date_from?: string, date_to?: string, includeDeleted = false) {
    const qs: string[] = [];
    if (date_from) qs.push(`date_from=${encodeURIComponent(date_from)}`);
    if (date_to) qs.push(`date_to=${encodeURIComponent(date_to)}`);
    if (includeDeleted) qs.push(`include_deleted=true`);
    const q = qs.length ? `?${qs.join("&")}` : "";
    return this._fetch<{ items: ApiCheckinRecord[] }>(
      `/checkin-records${q}`,
      { method: "GET" }
    );
  }

  /**
   * 拉取手机端操作记录（供 Obsidian「从手机同步」使用）。
   * 后端需提供 GET /mobile/ops?since=...&limit=...，返回 PWA 上传的未处理操作。
   */
  async listMobileOps(params?: MobileOpsListReq): Promise<MobileOpsListResp> {
    const qs: string[] = [];
    if (params?.since) qs.push(`since=${encodeURIComponent(params.since)}`);
    if (params?.limit != null) qs.push(`limit=${Math.min(500, Math.max(1, params.limit))}`);
    const q = qs.length ? `?${qs.join("&")}` : "";
    try {
      const r = await this._fetch<MobileOpsListResp>(`/mobile/ops${q}`, { method: "GET" });
      return r ?? { ok: true, ops: [] };
    } catch (e) {
      // 后端未实现该接口时返回空列表，不阻塞
      return { ok: false, ops: [] };
    }
  }

  /**
   * 标记这批手机操作已被插件成功写入，后端将设为 plugin_synced=true，下次拉取只返回未同步的，避免重复写入。
   */
  async markMobileOpsSynced(ids: string[]): Promise<{ ok: boolean; count?: number }> {
    if (!ids?.length) return { ok: true, count: 0 };
    const r = await this._fetch<{ ok: boolean; count?: number }>("/mobile/ops/mark-synced", {
      method: "POST",
      body: JSON.stringify({ ids }),
    });
    return r ?? { ok: true, count: 0 };
  }

  /**
   * Obsidian 应用某条操作失败时调用，将失败原因写入该条的 plugin_sync_error，供 mobile 拉取展示。
   */
  async reportMobileOpError(id: string, error: string): Promise<{ ok: boolean }> {
    if (!id?.trim()) return { ok: true };
    const r = await this._fetch<{ ok: boolean }>("/mobile/ops/report-sync-error", {
      method: "POST",
      body: JSON.stringify({ id: id.trim(), error: (error ?? "").trim() || "应用失败" }),
    });
    return r ?? { ok: true };
  }

  /**
   * 触发 backend 强制执行 mobile JSON 同步（拉取 operator 入库、刷新 plugin_date、锁定 mobile）。
   * 用于「从手机同步」开始时；仅当 backend 配置了 mobile_sync_config 时成功。
   */
  async mobileSyncRunNow(): Promise<{ ok: boolean; message?: string }> {
    try {
      const r = await this._fetch<{ ok: boolean; message?: string }>("/mobile/sync/run-now", {
        method: "POST",
      });
      return r ?? { ok: false, message: "unknown" };
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) };
    }
  }

  /**
   * 同步全部完成后调用：清空 operator、刷新 plugin_date、解锁 mobile。
   * 仅当此前调过 mobileSyncRunNow 且流程走完时调用。
   */
  async mobileSyncComplete(): Promise<{ ok: boolean; message?: string }> {
    try {
      const r = await this._fetch<{ ok: boolean; message?: string }>("/mobile/sync/complete", {
        method: "POST",
      });
      return r ?? { ok: false, message: "unknown" };
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) };
    }
  }

  /**
   * 同步手机模块配置到后端（vault 默认 + 按空间覆盖），供 PWA GET /mobile/config 按当前空间读取。
   */
  async setVaultMobileModuleConfig(payload: {
    mobile_module_enabled?: boolean;
    space_overrides?: Record<string, boolean>;
  }): Promise<void> {
    const body: Record<string, unknown> = {};
    if (payload.mobile_module_enabled !== undefined) body.mobile_module_enabled = payload.mobile_module_enabled;
    if (payload.space_overrides !== undefined && Object.keys(payload.space_overrides).length >= 0) body.space_overrides = payload.space_overrides;
    await this._fetch<{ ok: boolean }>("/vault/config", {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  /**
   * 兼容旧代码：仅设置 vault 默认开关（等同于 setVaultMobileModuleConfig({ mobile_module_enabled })）。
   */
  async setVaultMobileModuleEnabled(enabled: boolean): Promise<void> {
    await this.setVaultMobileModuleConfig({ mobile_module_enabled: enabled });
  }

  // =========================
  // Records: upsert / delete (for simplified UI)
  // =========================

  async upsertCheckinRecord(payload: UpsertCheckinRecordReq) {
    // 后端可能返回两种形态：
    // 1) { ok: true, item: {...} }
    // 2) 直接返回记录对象 {...}
    const r: any = await this._fetch<any>(
      "/checkin-records/upsert",
      { method: "POST", body: JSON.stringify(payload) }
    );
    if (r && typeof r === "object" && "item" in r) return r as { ok: true; item: ApiCheckinRecord };
    return { ok: true, item: r as ApiCheckinRecord };
  }

  /** ✅ Batch upsert: POST /checkin-records/upsert-batch */
  async upsertCheckinRecordsBatch(payload: UpsertCheckinRecordBatchReq): Promise<BatchUpsertResp<ApiCheckinRecord>> {
    return this._fetch<BatchUpsertResp<ApiCheckinRecord>>(
      "/checkin-records/upsert-batch",
      { method: "POST", body: JSON.stringify(payload) }
    );
  }

  async deleteCheckinRecord(record_id: number) {
    const r: any = await this._fetch<any>(
      `/checkin-records/${encodeURIComponent(String(record_id))}/delete`,
      { method: "POST" }
    );
    if (r && typeof r === "object" && "item" in r) return r as { ok: true; item: ApiCheckinRecord };
    return { ok: true, item: r as ApiCheckinRecord };
  }

  async upsertFinanceRecord(payload: UpsertFinanceRecordReq) {
    const r: any = await this._fetch<any>(
      "/finance-records/upsert",
      { method: "POST", body: JSON.stringify(payload) }
    );
    if (r && typeof r === "object" && "item" in r) return r as { ok: true; item: ApiFinanceRecord };
    return { ok: true, item: r as ApiFinanceRecord };
  }

  /** ✅ Batch upsert: POST /finance-records/upsert-batch */
  async upsertFinanceRecordsBatch(payload: UpsertFinanceRecordBatchReq): Promise<BatchUpsertResp<ApiFinanceRecord>> {
    return this._fetch<BatchUpsertResp<ApiFinanceRecord>>(
      "/finance-records/upsert-batch",
      { method: "POST", body: JSON.stringify(payload) }
    );
  }

  /** ✅ Batch upsert: POST /contacts/upsert-batch */
  async upsertContactsBatch(payload: ContactsUpsertBatchReq): Promise<ContactsUpsertBatchResp> {
    return this._fetch<ContactsUpsertBatchResp>(
      "/contacts/upsert-batch",
      { method: "POST", body: JSON.stringify(payload) }
    );
  }


  async deleteFinanceRecord(record_id: number) {
    const r: any = await this._fetch<any>(
      `/finance-records/${encodeURIComponent(String(record_id))}/delete`,
      { method: "POST" }
    );
    if (r && typeof r === "object" && "item" in r) return r as { ok: true; item: ApiFinanceRecord };
    return { ok: true, item: r as ApiFinanceRecord };
  }

  // =========================
  // Stats
  // =========================

  /**
   * 统一统计接口：GET /stats?kind=...&as_of=...
   * - kind 目前支持 finance_summary
   */
  async getStats(kind: string, as_of?: string) {
    const qs: string[] = [`kind=${encodeURIComponent(kind)}`];
    if (as_of) qs.push(`as_of=${encodeURIComponent(as_of)}`);
    const q = `?${qs.join("&")}`;
    return this._fetch<any>(`/stats${q}`, { method: "GET" });
  }

  // =========================
  // Projects
  // =========================

  /** POST /projects/upsert */
  async projectsUpsert(payload: any): Promise<any> {
    // 后端接口为 List[...]，这里兼容单对象与数组两种传参
    const bodyPayload = Array.isArray(payload) ? payload : [payload];
    return this._fetch<any>(
      `/projects/upsert`,
      { method: "POST", body: JSON.stringify(bodyPayload) }
    );
  }

  /** POST /projects/{project_id}/items/replace */
  async projectItemsReplace(project_id: string, payload: any): Promise<any> {
    const id = encodeURIComponent((project_id || "").trim());
    return this._fetch<any>(
      `/projects/${id}/items/replace`,
      { method: "POST", body: JSON.stringify(payload) }
    );
  }

  /** POST /projects/{project_id}/items/upsert */
  async projectItemsUpsert(project_id: string, payload: any): Promise<any> {
    const id = encodeURIComponent((project_id || "").trim());
    return this._fetch<any>(
      `/projects/${id}/items/upsert`,
      { method: "POST", body: JSON.stringify(payload) }
    );
  }

  /** POST /output-files/sync */
  async outputFilesSync(payload: any): Promise<any> {
    return this._fetch<any>(
      `/output-files/sync`,
      { method: "POST", body: JSON.stringify(payload) }
    );
  }

}

/**
 * UI 友好包装：失败时给 Notice（并 rethrow 让调用方决定后续）
 */
export async function apiTry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    const status = e?.status;
    const detail = e?.data?.detail;
    const code = detail?.code;

    const msg =
      (typeof detail === "string" ? detail : detail?.message) ||
      e?.data?.reason ||
      e?.message ||
      String(e);

    const extra = [
      status ? `HTTP ${status}` : null,
      code ? `code=${code}` : null,
    ].filter(Boolean).join(" ");

    new Notice(`${label}失败：${msg}${extra ? ` (${extra})` : ""}`);

    // main.ts 还需要 rethrow 去写 audit.log
    throw e;
  }
}
