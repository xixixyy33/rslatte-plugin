import {
  App,
  ButtonComponent,
  Modal,
  Notice,
  PluginSettingTab,
  Setting,
  TextComponent,
  TFile,
  normalizePath,
  moment,
} from "obsidian";
import type RSLattePlugin from "../../main";
import type { FinanceCatDef, JournalPanel } from "../../types/rslatteTypes";
import { ResetVaultIdConfirmModal } from "../modals/ResetVaultIdConfirmModal";
import { ResetVaultIdFinalModal } from "../modals/ResetVaultIdFinalModal";
import { PluginEnvCheckModal } from "../modals/PluginEnvCheckModal";
import { AddSpaceModal } from "../modals/AddSpaceModal";
import { apiTry, joinApiUrl } from "../../api";
import { DEFAULT_SETTINGS, MIN_ARCHIVE_THRESHOLD_DAYS, archiveThresholdFromUserInput } from "../../constants/defaults";
import { ensureUiHeaderButtonsConfig, setUiHeaderButtonVisibility, getUiHeaderButtonsVisibility } from "../helpers/uiHeaderButtons";
import { normalizeRunSummaryForUi } from "../helpers/normalizeRunSummaryForUi";
import { renderCheckinSettings } from "./sections/renderCheckinSettings";
import { renderFinanceSettings } from "./sections/renderFinanceSettings";
import { renderHealthSettings } from "./sections/renderHealthSettings";
import { renderTaskSettings } from "./sections/renderTaskSettings";
import { renderMemoSettings } from "./sections/renderMemoSettings";
import { renderScheduleSettings } from "./sections/renderScheduleSettings";
import { renderProjectSettings } from "./sections/renderProjectSettings";
import { renderOutputSettings } from "./sections/renderOutputSettings";
import { renderKnowledgeSettings } from "./sections/renderKnowledgeSettings";
import { renderContactsSettings } from "./sections/renderContactsSettings";
import { renderStatsSettings } from "./sections/renderStatsSettings";
import { DEFAULT_SPACE_ID } from "../../constants/space";
import { VIEW_TYPE_KNOWLEDGE } from "../../constants/viewTypes";
import { extractPerSpaceSettings, applyPerSpaceSettings } from "../../services/space/spaceSettings";
import {
  buildDefaultRootPrefix,
  buildSettingsSnapshotForNewSpace,
  pickNextAvailableSpaceNumberForNewSpace,
} from "../../services/space/spaceDirectoryDefaults";
import { ensureSpaceSnapshotAndKnowledgeDirs } from "../../services/space/ensureSpaceVaultDirectories";
import { SpacesIndexService } from "../../services/space/spacesIndexService";
import type { RSLatteSpaceConfig } from "../../types/space";
import type { RSLattePluginSettings } from "../../types/settings";

function rslatteOpenRegisterPage(baseUrl: string): void {
  const b = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!b) {
    new Notice("请先填写有效的 API Base URL");
    return;
  }
  const u = joinApiUrl(b, "/auth/register-page");
  try {
    const w: any = window;
    const e = w.require?.("electron");
    if (e?.shell?.openExternal) {
      e.shell.openExternal(u);
      return;
    }
  } catch {
    /* ignore */
  }
  window.open(u, "_blank");
}

function noticeAndNormalizeArchiveThresholdInput(input: HTMLInputElement): number {
  const { value: n, notifyBelowMin } = archiveThresholdFromUserInput(input.value);
  if (notifyBelowMin) {
    new Notice(`归档阈值不能小于 ${MIN_ARCHIVE_THRESHOLD_DAYS} 天，已改为 ${MIN_ARCHIVE_THRESHOLD_DAYS}。`);
  }
  input.value = String(n);
  return n;
}

export class RSLatteSettingTab extends PluginSettingTab {
  plugin: RSLattePlugin;
  private _lastFinanceCategoriesBackupJson = "";

  private _conflictCheckinIds = new Set<string>();
  private _conflictFinanceIds = new Set<string>();

  /**
   * ✅ 已被“日志/索引记录”引用过的 ID 集合：用于设置页锁定 ID 输入框（防止改动导致历史记录对不上）
   * - checkin: DK_xxx
   * - finance: CW_xxx
   */
  private _usedCheckinIds = new Set<string>();
  private _usedFinanceIds = new Set<string>();
  private _usedIdsLoaded = false;
  private _usedIdsLoading: Promise<void> | null = null;

  // ✅ live-update used-id locks while settings tab is open (after checkin/finance record writes)
  private _usedIdsRefreshTimer: number | null = null;
  private _usedIdsListenerRegistered = false;

  // ✅ 保存和恢复输入框焦点状态
  private _focusedElementInfo: { selector: string; cursorPosition: number; value?: string } | null = null;
  
  // ✅ 保存和恢复滚动位置
  private _savedScrollPosition: number = 0;
  private _savedScrollMarker: string | null = null; // 保存标记元素的标识符

  // ✅ Spaces Index Service (用于维护 spaces-index.json)
  private _spacesIndexService: SpacesIndexService | null = null;

  /**
   * 更新当前空间的 settingsSnapshot，确保 Hub 能获取到最新的模块启用状态
   * 在模块启用/禁用时调用此方法
   */
  private async updateCurrentSpaceSnapshot(): Promise<void> {
    try {
      const currentSpaceId = this.plugin.getCurrentSpaceId();
      const spacesMap: Record<string, RSLatteSpaceConfig> = (this.plugin.settings as any)?.spaces ?? {};
      const currentSpace = spacesMap[currentSpaceId];
      
      if (currentSpace) {
        // 提取当前设置的空间范围配置作为新的快照
        const newSnapshot = extractPerSpaceSettings(this.plugin.settings);
        
        // 更新当前空间的 settingsSnapshot
        (this.plugin.settings as any).spaces[currentSpaceId] = Object.assign({}, currentSpace, {
          updatedAt: new Date().toISOString(),
          settingsSnapshot: newSnapshot,
        });
        
        // 重新应用空间设置到全局 settings，确保 plugin.settings 反映最新状态
        // 这样 isPipelineModuleEnabled 等函数能立即获取到最新的模块启用状态
        const DEFAULT_SETTINGS = await import("../../constants/defaults").then(m => m.DEFAULT_SETTINGS);
        applyPerSpaceSettings(this.plugin.settings, newSnapshot, DEFAULT_SETTINGS as any);
        
        // 保存设置
        await this.plugin.saveSettings();
        
        // 触发 Hub 视图刷新
        this.refreshHubView();
        
        // 触发发布侧边栏刷新（如果已打开）
        this.refreshKnowledgeSidePanel();
      }
    } catch (e) {
      console.warn("[RSLatte][Settings] Failed to update current space snapshot:", e);
    }
  }
  
  /** §4：刷新 Knowledge 工作台视图（若已打开） */
  private refreshKnowledgeSidePanel(): void {
    try {
      const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_KNOWLEDGE);
      for (const leaf of leaves) {
        const view = leaf.view;
        if (view && typeof (view as any).refresh === "function") {
          (view as any).refresh();
        } else if (view && typeof (view as any).render === "function") {
          void (view as any).render();
        }
      }
    } catch (e) {
      console.warn("[RSLatte][Settings] Failed to refresh Knowledge view:", e);
    }
  }

  /**
   * 刷新 Hub 视图（如果已打开）
   */
  private refreshHubView(): void {
    try {
      const leaves = this.app.workspace.getLeavesOfType("rslatte-hub");
      for (const leaf of leaves) {
        const view = leaf.view;
        if (view && typeof (view as any).scheduleRender === "function") {
          (view as any).scheduleRender();
        } else if (view && typeof (view as any).render === "function") {
          void (view as any).render();
        }
      }
    } catch (e) {
      console.warn("[RSLatte][Settings] Failed to refresh Hub view:", e);
    }
  }

  /** Force reload used-id locks from record index (active + archive). */
  private async reloadListUsedIdLocksNow(): Promise<void> {
    this._usedIdsLoaded = false;
    this._usedIdsLoading = null;
    await this.loadListUsedIdLocks();
  }

  /**
   * 从 recordRSLatte 的 tombstone（历史已删除 ID）加载冲突集合。
   * 目的：当出现“ID 与历史已删除条目冲突”时，设置页能直接高亮对应行。
   */
  private async loadListTombstoneConflicts(): Promise<void> {
    try {
      this.clearConflicts();
      const rl: any = (this.plugin as any).recordRSLatte;
      if (!rl || typeof rl.getListTombstones !== "function") return;
      
      // ✅ 延迟一段时间，确保空间切换后数据已同步
      // 这可以避免在空间切换后立即打开设置页时，tombstone 清理逻辑还未执行完成导致的误报
      // 延迟时间略长于空间切换后的视图刷新延迟（50ms），确保所有数据都已同步
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const ts = await rl.getListTombstones();
      const norm = (s: any) => this.normalizeKey(String(s ?? "").trim());
      for (const id of Array.from(ts?.checkin ?? [])) this._conflictCheckinIds.add(norm(id));
      for (const id of Array.from(ts?.finance ?? [])) this._conflictFinanceIds.add(norm(id));
    } catch (e) {
      console.warn("RSLatteSettingTab loadListTombstoneConflicts failed:", e);
    }
  }

  /**
   * ✅ 从 recordRSLatte 的 record index（含 archive）加载“已使用 ID”集合。
   * 这些 ID 一旦被写入过日志/索引，就不允许在设置页修改，否则会导致历史记录对不上。
   *
   * 该方法异步执行，不阻塞设置页首屏渲染。
   */
  public async loadListUsedIdLocks(): Promise<void> {
    if (this._usedIdsLoaded) return;
    if (this._usedIdsLoading) return this._usedIdsLoading;

    this._usedIdsLoading = (async () => {
      try {
        const rl: any = (this.plugin as any).recordRSLatte;
        if (!rl || typeof rl.getCheckinSnapshot !== "function" || typeof rl.getFinanceSnapshot !== "function") {
          this._usedIdsLoaded = true;
          return;
        }

        const norm = (s: any) => this.normalizeKey(String(s ?? "").trim());

        // reset then rebuild (best-effort)
        this._usedCheckinIds.clear();
        this._usedFinanceIds.clear();

        const ck0 = await rl.getCheckinSnapshot(false);
        const ck1 = await rl.getCheckinSnapshot(true);
        for (const it of (ck0?.items ?? [])) {
          const k = norm(it?.checkinId);
          if (k) this._usedCheckinIds.add(k);
        }
        for (const it of (ck1?.items ?? [])) {
          const k = norm(it?.checkinId);
          if (k) this._usedCheckinIds.add(k);
        }

        const fin0 = await rl.getFinanceSnapshot(false);
        const fin1 = await rl.getFinanceSnapshot(true);
        for (const it of (fin0?.items ?? [])) {
          const k = norm(it?.categoryId);
          if (k) this._usedFinanceIds.add(k);
        }
        for (const it of (fin1?.items ?? [])) {
          const k = norm(it?.categoryId);
          if (k) this._usedFinanceIds.add(k);
        }

        this._usedIdsLoaded = true;
      } catch (e) {
        console.warn("RSLatteSettingTab loadListUsedIdLocks failed:", e);
        this._usedIdsLoaded = true;
      } finally {
        this._usedIdsLoading = null;
      }
    })();

    return this._usedIdsLoading;
  }

  public isCheckinIdLockedByUsage(id: any): boolean {
    const k = this.normalizeKey(String(id ?? "").trim());
    return !!(k && this._usedCheckinIds.has(k));
  }

  public isFinanceIdLockedByUsage(id: any): boolean {
    const k = this.normalizeKey(String(id ?? "").trim());
    return !!(k && this._usedFinanceIds.has(k));
  }

  private clearConflicts() {
    this._conflictCheckinIds.clear();
    this._conflictFinanceIds.clear();
  }

  constructor(app: App, plugin: RSLattePlugin) {
    super(app, plugin);
    this.plugin = plugin;
    // 初始化 Spaces Index Service
    this._spacesIndexService = new SpacesIndexService(app, () => plugin.settings);
  }

  display(): void {
    // ✅ Register once: when record index changes (checkin/finance), refresh used-id locks and re-render.
    if (!this._usedIdsListenerRegistered) {
      this._usedIdsListenerRegistered = true;
      try {
        // Use plugin.registerEvent so it is disposed automatically on plugin unload.
        this.plugin.registerEvent(
          (this.app.workspace as any).on("rslatte:recordIndexChanged", (_payload: any) => {
            // debounce to avoid multiple renders within the same runE2 chain
            if (this._usedIdsRefreshTimer) window.clearTimeout(this._usedIdsRefreshTimer);
            this._usedIdsRefreshTimer = window.setTimeout(() => {
              this._usedIdsRefreshTimer = null;
              // Only re-render if settings tab is currently mounted/visible.
              const mounted = !!this.containerEl?.isConnected;
              if (!mounted) {
                // still invalidate cache so next open reads the latest
                this._usedIdsLoaded = false;
                this._usedIdsLoading = null;
                return;
              }
              
              // ✅ 检查是否有输入框正在聚焦，如果有则跳过重新渲染以避免打断用户输入
              const activeElement = document.activeElement;
              if (activeElement && (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement)) {
                // 如果输入框在设置页容器内，延迟重新渲染以避免打断用户输入
                if (this.containerEl.contains(activeElement)) {
                  // 延迟重新渲染，给用户更多时间完成输入
                  // 使用更长的延迟，确保用户有足够时间完成输入
                  setTimeout(() => {
                    // 再次检查是否还在聚焦
                    const stillFocused = document.activeElement === activeElement;
                    if (!stillFocused) {
                      // 如果已经失去焦点，执行重新渲染
                      void this.reloadListUsedIdLocksNow().then(() => {
                        try {
                          this.display();
                        } catch {
                          // ignore
                        }
                      });
                    }
                    // 如果还在聚焦，不执行重新渲染，等待下次事件触发
                  }, 1000); // 延迟1秒，给用户足够时间完成输入
                  return;
                }
              }
              
              void this.reloadListUsedIdLocksNow().then(() => {
                try {
                  this.display();
                } catch {
                  // ignore
                }
              });
            }, 120);
          })
        );
      } catch {
        // ignore
      }
    }

    const { containerEl } = this;

    // Preserve <details> open/close state across re-render (avoid collapsing after each setting change)
    const state: Record<string, boolean> = (this as any)._rslatteCollapsibleState ?? {};
    try {
      containerEl
        .querySelectorAll('details.rslatte-collapsible[data-rslatte-collapsible-key]')
        .forEach((d) => {
          const key = (d as HTMLElement).getAttribute('data-rslatte-collapsible-key') || '';
          if (key) state[key] = (d as HTMLDetailsElement).open;
        });
    } catch {
      // ignore
    }
    (this as any)._rslatteCollapsibleState = state;

    const getOpenState = (key: string, fallback: boolean) => {
      const v = (this as any)._rslatteCollapsibleState?.[key];
      return v === undefined ? fallback : !!v;
    };

    // ✅ 保存当前聚焦的输入框信息（在清空容器前）
    this.saveFocusBeforeRerender();
    
    // ✅ 保存当前滚动位置（在清空容器前）
    // 尝试多种方式查找滚动容器
    let scrollContainer: HTMLElement | null = null;
    
    // 方法1: 查找 .vertical-tab-content
    scrollContainer = containerEl.closest('.vertical-tab-content') as HTMLElement;
    
    // 方法2: 查找 .vertical-tab-content-container
    if (!scrollContainer) {
      scrollContainer = containerEl.closest('.vertical-tab-content-container') as HTMLElement;
    }
    
    // 方法3: 查找 .settings-content
    if (!scrollContainer) {
      scrollContainer = containerEl.closest('.settings-content') as HTMLElement;
    }
    
    // 方法4: 向上查找第一个可滚动的父元素
    if (!scrollContainer) {
      let parent: HTMLElement | null = containerEl.parentElement;
      while (parent) {
        const style = window.getComputedStyle(parent);
        if (style.overflow === 'auto' || style.overflow === 'scroll' || style.overflowY === 'auto' || style.overflowY === 'scroll') {
          scrollContainer = parent;
          break;
        }
        parent = parent.parentElement;
      }
    }
    
    // 方法5: 查找设置页的根容器
    if (!scrollContainer) {
      const settingRoot = containerEl.closest('.vertical-tab-content, .vertical-tab-content-container, [class*="setting"], [class*="tab"]') as HTMLElement;
      if (settingRoot) {
        scrollContainer = settingRoot;
      }
    }
    
    if (scrollContainer && scrollContainer instanceof HTMLElement) {
      this._savedScrollPosition = scrollContainer.scrollTop;
    } else {
      // 如果都没找到，尝试从 window 获取（如果整个页面在滚动）
      this._savedScrollPosition = window.scrollY || window.pageYOffset || 0;
    }

    containerEl.empty();


    // =========================
    // 顶部提示条：DB 同步/后端状态（D9-2）
    // =========================
    {
      const box = containerEl.createDiv({ cls: "rslatte-db-status-box rslatte-top-banner" });

      const touch: any = (this.plugin as any)?.vaultSvc?.shouldTouchBackendNow?.() ?? { ok: false, reason: "", baseUrl: "" };
      const bk: any = (this.plugin as any)?.getBackendDbReady?.() ?? { ready: null, reason: "", checkedAt: 0 };
      const backendReady = bk.ready;

      let text = "";
      if (!touch.ok) {
        const reason = touch.reason ? `（${touch.reason}）` : "";
        text = `DB 同步已全部关闭或 URL 不可用：不检查后端（不影响本地功能）。${reason}`;
        box.toggleClass("is-neutral", true);
      } else if (backendReady === true) {
        text = "数据库已就绪";
        box.toggleClass("is-ok", true);
      } else if (backendReady === false) {
        if (this._dbInitRequired) {
          text = "数据库未初始化：需要执行 001_init.sql（不影响本地功能）。";
        } else {
          const reason = bk.reason || this._dbReason || "后端不可用";
          text = `后端不可用（不影响本地功能）：${reason}`;
        }
        box.toggleClass("is-warn", true);
      } else {
        text = "正在检查后端状态…";
        box.toggleClass("is-neutral", true);
      }
      box.setText(text);
    }


    const sAny: any = this.plugin.settings as any;
    // Ensure moduleEnabled/moduleEnabledV2 exists (default all enabled)
    if (!sAny.moduleEnabled) {
      const d: any = (DEFAULT_SETTINGS as any)?.moduleEnabled ?? { record: true, task: true, project: true, output: true };
      sAny.moduleEnabled = { record: true, task: true, project: true, output: true, ...(d || {}) };
    }    if (!sAny.moduleEnabledV2) {
      const d: any = (DEFAULT_SETTINGS as any)?.moduleEnabledV2 ?? {};
      // 初始化 v2 模块开关：优先从 legacy moduleEnabled 同步，避免升级后“显示启用但实际关闭”
      const legacyRecordOn = (sAny.moduleEnabled?.record === undefined ? true : !!sAny.moduleEnabled.record);
      const legacyTaskOn = (sAny.moduleEnabled?.task === undefined ? true : !!sAny.moduleEnabled.task);
      const legacyProjectOn = (sAny.moduleEnabled?.project === undefined ? true : !!sAny.moduleEnabled.project);
      const legacyOutputOn = (sAny.moduleEnabled?.output === undefined ? true : !!sAny.moduleEnabled.output);

      sAny.moduleEnabledV2 = {
        journal: true,
        checkin: legacyRecordOn,
        finance: legacyRecordOn,
        task: legacyTaskOn,
        memo: legacyTaskOn,
        project: legacyProjectOn,
        output: legacyOutputOn,
        publish: false, // §4：独立发布侧栏已下线
        ...(d || {}),
      };
    } else {
      // 补齐缺省：若 v2 未显式配置，则从 legacy 同步一次
      const me2: any = sAny.moduleEnabledV2;
      const legacyRecordOn = (sAny.moduleEnabled?.record === undefined ? true : !!sAny.moduleEnabled.record);
      const legacyTaskOn = (sAny.moduleEnabled?.task === undefined ? true : !!sAny.moduleEnabled.task);
      const legacyProjectOn = (sAny.moduleEnabled?.project === undefined ? true : !!sAny.moduleEnabled.project);
      const legacyOutputOn = (sAny.moduleEnabled?.output === undefined ? true : !!sAny.moduleEnabled.output);

      if (me2.checkin === undefined) me2.checkin = legacyRecordOn;
      if (me2.finance === undefined) me2.finance = legacyRecordOn;
      if (me2.task === undefined) me2.task = legacyTaskOn;
      if (me2.memo === undefined) me2.memo = legacyTaskOn;
      if (me2.project === undefined) me2.project = legacyProjectOn;
      if (me2.output === undefined) me2.output = legacyOutputOn;
      if (me2.publish === undefined) me2.publish = false; // §4：独立发布侧栏已下线
    }


    const isLegacyEnabled = (k: 'record' | 'task' | 'project' | 'output') => {
      const v = sAny.moduleEnabled?.[k];
      return v === undefined ? true : Boolean(v);
    };

    // ===== v6：模块开关（legacy moduleEnabled）写入工具 =====
    // 说明：当前仍有部分运行时逻辑依赖 settings.moduleEnabled（legacy）。
    // 这里提供一个安全的 setter，避免因为未定义导致 Settings 页渲染中断。
    const setModEnabled = (k: string, on: boolean) => {
      if (!sAny.moduleEnabled) sAny.moduleEnabled = {};
      (sAny.moduleEnabled as any)[k] = !!on;
    };

    // 兼容：曾经有过 setMoEnabled 的拼写（避免运行时报错导致设置页渲染中断）
    const setMoEnabled = setModEnabled;

    const modGateOpen = this.plugin.isPluginEnvInitModuleGateOpen();
    const isV2Enabled = (
      k: 'journal' | 'checkin' | 'finance' | 'health' | 'task' | 'memo' | 'project' | 'output' | 'contacts' | 'knowledge',
    ) => {
      if (!modGateOpen) return false;
      if (k === 'knowledge') return true;
      const me2: any = sAny.moduleEnabledV2 ?? {};
      const direct = me2[k];
      if (k === 'health') return direct === true;
      if (k === 'contacts') return direct === true;
      if (direct !== undefined) return Boolean(direct);
      // fallback to legacy
      if (k === 'checkin' || k === 'finance') return isLegacyEnabled('record');
      if (k === 'memo' || k === 'task') return isLegacyEnabled('task');
      if (k === 'project') return isLegacyEnabled('project');
      if (k === 'output') return isLegacyEnabled('output');
      return true;
    };

    // ===== UI：可折叠设置分组（用于减少长页面滚动） =====
    // - 使用 <details>/<summary>，不引入额外依赖。
    // - 默认：后端信息维护展开，其余模块折叠。
    /** 侧栏折叠标题旁标签：与 `SPACE_SCOPED_SETTING_KEYS` 实际是否隔离一致（见空间管理优化方案文档）。 */
    type SettingsScopeTag = "global" | "space";
    const makeCollapsibleSection = (
      title: string,
      open: boolean = false,
      extraCls: string = "",
      scopeTag?: SettingsScopeTag,
    ): HTMLElement => {
      const cls = ["rslatte-collapsible", extraCls].filter(Boolean).join(" ");
      const details = containerEl.createEl("details", { cls }) as HTMLDetailsElement;
      details.setAttr('data-rslatte-collapsible-key', title);
      details.open = getOpenState(title, !!open);

      // summary 需要可点击；用 rslatte-setting-h2 保持现有视觉风格
      const summary = details.createEl("summary", { cls: "rslatte-collapsible-summary rslatte-setting-h2" });
      const head = summary.createDiv({ cls: "rslatte-collapsible-summary-head" });
      head.createSpan({ text: title });
      if (scopeTag) {
        head.createSpan({
          cls:
            scopeTag === "global"
              ? "rslatte-settings-scope-tag rslatte-settings-scope-global"
              : "rslatte-settings-scope-tag rslatte-settings-scope-space",
          text: scopeTag === "global" ? "全局" : "空间",
        });
      }

      const body = details.createDiv({ cls: "rslatte-collapsible-body" });
      return body;
    };

    // 在任意父容器内创建可折叠分组（用于“后端信息维护”内部再拆出子分组）
    const makeCollapsibleSectionIn = (
      parent: HTMLElement,
      title: string,
      open: boolean = false,
      extraCls: string = "",
      summaryClass: string = "rslatte-setting-h2"
    ): HTMLElement => {
      const cls = ["rslatte-collapsible", extraCls].filter(Boolean).join(" ");
      const details = parent.createEl("details", { cls }) as HTMLDetailsElement;
      details.setAttr('data-rslatte-collapsible-key', title);
      details.open = getOpenState(title, !!open);

      const summary = details.createEl("summary", { cls: `rslatte-collapsible-summary ${summaryClass}` });
      summary.createSpan({ text: title });

      const body = details.createDiv({ cls: "rslatte-collapsible-body" });
      return body;
    };

    const makeModuleWrap = (
      k: 'journal' | 'checkin' | 'finance' | 'health' | 'task' | 'memo' | 'project' | 'output' | 'contacts' | 'knowledge',
      title: string,
      scopeTag: SettingsScopeTag = "space",
    ) => {
      // 模块分组默认折叠
      const body = makeCollapsibleSection(title, false, "rslatte-module-wrap", scopeTag);
      const details = body.parentElement as HTMLDetailsElement | null;
      if (details && !isV2Enabled(k)) details.addClass('is-disabled');
      return body;
    };
    // ===== UI：侧边栏标题栏按钮显隐（仅控制 🧱🗄🔄；➕ 始终展示） =====
    const addHeaderButtonsVisibilitySetting = (
      wrap: HTMLElement,
      moduleKey: "checkin" | "finance" | "memo" | "task" | "project" | "output" | "contacts",
      noteAlwaysPlus: boolean = false,
    ) => {
      ensureUiHeaderButtonsConfig(this.plugin.settings);
      const cur = getUiHeaderButtonsVisibility(this.plugin.settings, moduleKey as any);

      const box = wrap.createDiv({ cls: "rslatte-status-filter" });
      box.createEl("div", { text: "按钮显示：", cls: "setting-item-name" });

      const stWrap = box.createDiv({ cls: "rslatte-status-filter-wrap" });
      const items: Array<{ key: "rebuild" | "archive" | "refresh"; label: string }> = [
        { key: "rebuild", label: "🧱" },
        { key: "archive", label: "🗄" },
        { key: "refresh", label: "🔄" },
      ];

      for (const it of items) {
        const lb = stWrap.createEl("label", { cls: "rslatte-status-filter-item" });
        const cb = lb.createEl("input");
        cb.type = "checkbox";
        cb.checked = (cur as any)[it.key] !== false;
        cb.addEventListener("change", () => {
          setUiHeaderButtonVisibility(this.plugin.settings, moduleKey as any, it.key, cb.checked);
          void this.saveAndRefreshSidePanelDebounced();
        });
        lb.appendText(" " + it.label);
      }

      if (noteAlwaysPlus) {
        wrap.createDiv({ cls: "rslatte-muted", text: "注：➕ 始终展示；此处仅控制 🧱🗄🔄。" });
      }
    };

    // 兼容旧调用点：有些模块（尤其是 Contacts）会用更直观的命名。
    // 之前拆分设置页时，这个变量未定义会导致运行时报错并中断后续设置渲染。
    const addUiHeaderButtonsVisibilitySetting = (
      wrap: HTMLElement,
      moduleKey: "checkin" | "finance" | "memo" | "task" | "project" | "output" | "contacts",
      noteAlwaysPlus: boolean = false,
    ) => addHeaderButtonsVisibilitySetting(wrap, moduleKey, noteAlwaysPlus);

    // =========================
    // ✅ 全局配置（可折叠，默认展开）
    // 说明：以下配置为全局配置，所有空间共用，不应按空间隔离。
    // 包括：Vault ID、DB 同步批量大小、Reconcile 安全门、索引目录、自动刷新索引、自动刷新频率、Debug Log
    // =========================
    const globalConfigWrap = makeCollapsibleSection("全局配置", true, "rslatte-global-config-wrap", "global");

    // ===== DB 初始化检查（受 API Base URL 约束）：只触发一次，完成后重绘一次 =====
    // - API Base URL 为空：视为不可用，但不主动 fetch（避免 Failed to fetch 噪声）
    // - API Base URL 变化：重置状态并重新检测
    const apiBaseUrlTrim = String(this.plugin.settings.apiBaseUrl ?? "").trim();
    const hasApiBaseUrl = apiBaseUrlTrim.length > 0;
    const urlCheckable = (() => {
      if (!apiBaseUrlTrim) return false;
      const lower = apiBaseUrlTrim.toLowerCase();
      if (!(lower.startsWith("http://") || lower.startsWith("https://"))) return false;
      try {
        // eslint-disable-next-line no-new
        new URL(apiBaseUrlTrim);
        return true;
      } catch {
        return false;
      }
    })();
    const anyDbSyncEnabled = (() => {
      const s: any = this.plugin.settings as any;
      const chk = !!(s?.checkinPanel?.enableDbSync);
      const fin = !!(s?.financePanel?.enableDbSync);
      const tsk = !!(s?.taskModule?.enableDbSync);
      const mem = !!(s?.memoModule?.enableDbSync);
      const cts = !!(s?.contactsModule?.enableDbSync);
      const prj = !!(s?.projectEnableDbSync);
      const out = !!(s?.outputPanel?.enableDbSync);
      // legacy 聚合字段仅作为兜底（避免旧配置迁移前误判）
      const legacyRecord = !!(s?.rslattePanelEnableDbSync);
      const legacyTask = !!(s?.taskPanel?.enableDbSync);
      const wev = !!(s?.workEventDbSyncEnabled);
      const kn = !!(s?.knowledgePanel?.enableDbSync);
      const hlth = !!(s?.healthPanel?.enableDbSync);
      const schDb = !!(s?.scheduleModule?.enableDbSync);
      return chk || fin || tsk || mem || cts || prj || out || legacyRecord || legacyTask || wev || kn || hlth || schDb;
    })();
    const shouldTouchBackendNow = urlCheckable && anyDbSyncEnabled;
    const lastCheckedUrl = (this as any)._rslatteDbCheckUrl as string | undefined;
    if (lastCheckedUrl !== apiBaseUrlTrim) {
      (this as any)._rslatteDbCheckUrl = apiBaseUrlTrim;
      this._dbReady = null;
      this._dbReason = "";
      this._dbChecking = false;
    }

    if (!hasApiBaseUrl) {
      // 未配置 URL：不可用，但不触达后端
      this._dbReady = false;
      this._dbReason = "API Base URL 为空";
    } else if (!urlCheckable) {
      // URL 未完成/不合法：不触达后端
      this._dbReady = null;
      this._dbReason = "URL 格式未完成";
    } else if (!anyDbSyncEnabled) {
      // DB sync 全关：不触达后端，也不显示红色错误（不影响本地功能）
      this._dbReady = null;
      this._dbReason = "DB 同步已全部关闭";
    } else if (this._dbReady === null && !this._dbChecking) {
      // 只有在 URL 可检查且至少一个模块开启 DB sync 时，才触达后端做一次性检查
      this._dbChecking = true;
      this.checkDbReady().then(() => {
        this._dbChecking = false;
        this.display();
      });
    }

    // v26：Refresh Interval (seconds) 已废弃。
    // 侧边栏与项目增量刷新已统一由「自动刷新索引（分钟）」驱动（Step4）。

    // Vault ID + 重新初始化按钮（新增）
    new Setting(globalConfigWrap)
      .setName("Vault ID（当前知识库标识）")
      .setDesc("每个知识库首次安装插件时生成一次。用于数据库隔离（vault_id）。")
      .addText(t => {
        t.setValue(this.plugin.settings.vaultId || "");
        t.setDisabled(true);
        t.inputEl.addClass("is-locked");
      })
      .addButton(btn => {
        btn.setButtonText("复制");
        btn.onClick(async () => {
          const id = this.plugin.settings.vaultId || "";
          await navigator.clipboard.writeText(id);
          new Notice("已复制 Vault ID");
        });
      })
      .addButton(btn => {
        btn.setButtonText("重新初始化");
        btn.buttonEl.addClass("mod-warning");
        btn.setDisabled(this._dbReady !== true); // DB 未就绪就不让重置，避免“重置完注册失败”
        btn.onClick(() => {
          // 两段确认
          new ResetVaultIdConfirmModal(this.app, this.plugin, () => {
            new ResetVaultIdFinalModal(this.app, this.plugin, async () => {
              const oldId = this.plugin.settings.vaultId;
              try {
                const newId = await (this.plugin as any).vaultSvc.resetVaultIdAndEnsure();
                new Notice("已重新初始化 Vault ID（新 ID 已生效）");

                // ✅ 需求：重置 vault_id 后，触发所有模块的重建索引
                // - 目标：保证新 vault_id 下的索引/DB 状态一致（避免“旧 vault_id 数据”残留）
                // - 策略：best-effort 顺序执行；单模块失败不阻断其它模块
                try {
                  const pe: any = (this.plugin as any)?.pipelineEngine;
                  if (pe && typeof pe.runE2 === "function") {
                    const modules = ["checkin", "finance", "task", "memo", "project", "output", "contacts"];
                    const spaces = listSpaces();
                    new Notice("Vault ID 已更新：开始重建索引（全部模块，全部空间）");
                    for (const space of spaces) {
                      const ctx = this.plugin.getSpaceCtx(space.id);
                      for (const m of modules) {
                        try {
                          await pe.runE2(ctx, m as any, "rebuild");
                        } catch (e2: any) {
                          // 不中断：只提示该模块失败
                          new Notice(`空间 ${space.name} 模块 ${m} 重建失败：${e2?.message ?? String(e2)}`);
                        }
                      }
                    }
                  }
                } catch {
                  // ignore
                }

                // 额外：把新 ID 放剪贴板，方便你测试
                try { await navigator.clipboard.writeText(newId); } catch { }
                await this.plugin.appendAuditLog({
                  action: "RESET_VAULT_ID_UI_DONE",
                  old_vault_id: oldId || null,
                  new_vault_id: newId,
                });

                this.display(); // 立即刷新显示新的 vaultId
              } catch (e: any) {
                new Notice(`重新初始化失败：${e?.message ?? String(e)}`);
              }
            }).open();
          }).open();
        });
      });

    // Vault 信息同步：将当前知识库名称与空间列表写入后端 vault / vault_space
    new Setting(globalConfigWrap)
      .setName("Vault 信息同步")
      .setDesc("将当前知识库名称与空间列表同步到后端。需已配置 API 且至少开启一项 DB 同步。")
      .addButton(btn => {
        btn.setButtonText("同步到后端");
        btn.onClick(async () => {
          try {
            const ok = await this.plugin.vaultSvc.ensureVaultReadySafe("vault-info-sync");
            if (ok) {
              new Notice("已同步知识库名称与空间列表到后端");
            } else {
              new Notice("同步未执行或失败，请检查 API 配置与 DB 同步开关");
            }
          } catch (e: any) {
            new Notice("同步失败：" + (e?.message ?? String(e)));
          }
        });
      });

    new Setting(globalConfigWrap)
      .setName("插件初始化环境检查")
      .setDesc(
        "首次使用前须在此完成强制项（含 Obsidian、目录、模板）并通过后点击「完成初始化（启用模块）」，业务模块才会按「模块管理」中的开关运行。另含推荐第三方插件建议项。支持一键补齐目录与模板。详见《空间管理优化方案》§8。",
      )
      .addButton((btn) => {
        btn.setButtonText("打开检查…");
        btn.onClick(() => {
          new PluginEnvCheckModal(this.app, this.plugin, () => {
            this.display();
          }).open();
        });
      });

    // ===== 高级同步参数（v2，公用） =====
    // 这些是“后端同步/一致性”策略，放在「后端信息维护」里更符合用户心智。
    // 注意：仅做 UI 归位，不改变任何业务逻辑与设置存储字段。
    globalConfigWrap.createEl("h3", { text: "高级同步参数" });

    // 兼容旧配置：taskPanel 可能尚未存在（例如仅启用打卡/财务时）。
    // 这里需要先补齐最小结构，避免设置页因读取 undefined 而崩溃。
    if (!this.plugin.settings.taskPanel) {
      this.plugin.settings.taskPanel = {
        taskFolders: [],
        includeTags: [],
        excludeTags: [],
        overdueWithinDays: 3,
        closedTaskWindowDays: 7,
      };
    }

    const tp = this.plugin.settings.taskPanel;

    new Setting(globalConfigWrap)
      .setName("DB 同步批量大小（upsert-batch）")
      .setDesc("flushQueue 每批最多同步多少条（默认 50）。数值过大可能导致后端压力增大或超时。")
      .addText((t) =>
        t.setPlaceholder("50")
          .setValue(String(tp.upsertBatchSize ?? 50))
          .onChange(async (v) => {
            const n = Number(v);
            const safe = Number.isFinite(n) ? Math.max(1, Math.min(500, Math.floor(n))) : 50;
            tp.upsertBatchSize = safe;
            await this.saveAndRefreshSidePanelDebounced();
          })
      );

    new Setting(globalConfigWrap)
      .setName("Reconcile 安全门：队列必须为空")
      .setDesc("开启后：仅当同步队列为空时才执行 reconcile（避免 pending/failed 未入库导致误删）。")
      .addToggle((tog) =>
        tog.setValue(tp.reconcileRequireQueueEmpty ?? true)
          .onChange(async (v) => {
            tp.reconcileRequireQueueEmpty = v;
            await this.saveAndRefreshSidePanelDebounced();
          })
      );

    new Setting(globalConfigWrap)
      .setName("Reconcile 安全门：仅对干净文件执行")
      .setDesc("开启后：仅对本次扫描结果中“无 uidMissing（每条任务/提醒都具备 uid）”的文件执行 reconcile，避免部分文件未补齐 uid 时误删。")
      .addToggle((tog) =>
        tog.setValue(tp.reconcileRequireFileClean ?? true)
          .onChange(async (v) => {
            tp.reconcileRequireFileClean = v;
            await this.saveAndRefreshSidePanelDebounced();
          })
      );

    // ===== 索引管理（统一配置） =====
    // 说明：这里仅包含索引目录与自动刷新等“索引生命周期”配置。
    // 模块启用/同步/归档策略移至下方“模块管理”。
    globalConfigWrap.createEl("h3", { text: "索引管理", cls: "rslatte-setting-h3" });

    new Setting(globalConfigWrap)
      .setName("索引目录")
      .setDesc("存放中央索引、同步队列，以及各模块「索引归档」JSON（archive/ 子目录）。与「笔记归档」（移动 Vault 笔记/文件夹）及「日记按月」不同。V2 默认：00-System/.rslatte。")
      .addText(t => {
        const s: any = this.plugin.settings as any;
        t.setPlaceholder("00-System/.rslatte");
        t.setValue(String(s.centralIndexDir ?? "00-System/.rslatte"));
        t.onChange(async (v) => {
          const dir = (v ?? "").trim() || "00-System/.rslatte";
          s.centralIndexDir = dir;

          // 写回旧字段，保证各模块读到一致的目录
          if (s.taskPanel) s.taskPanel.rslatteIndexDir = dir;
          s.projectRSLatteIndexDir = dir;
          if (s.outputPanel) s.outputPanel.rslatteIndexDir = dir;
          s.rslattePanelIndexDir = dir;

          const ok = await this.plugin.saveSettings();
          if (!ok) return;

          try { this.plugin.taskRSLatte?.refreshStoreBaseDir?.(); } catch { }
          try { await this.plugin.recordRSLatte?.resetStore?.(); } catch { }
          try { await this.plugin.outputRSLatte?.resetStore?.(); } catch { }
          this.plugin.refreshSidePanel();
        });
      });

    // V2 知识库目录（00/10/20/30/90）
    new Setting(globalConfigWrap)
      .setName("启用 V2 知识库目录")
      .setDesc("开启后可使用 00-System/10-Personal/20-Work/30-Knowledge/90-Archive 结构；新内容写入路径可后续接轨。")
      .addToggle(t => {
        const s: any = this.plugin.settings as any;
        t.setValue(!!s.useV2DirectoryStructure);
        t.onChange(async (v) => {
          s.useV2DirectoryStructure = !!v;
          await this.plugin.saveSettings();
        });
      });
    new Setting(globalConfigWrap)
      .setName("V2 目录根路径")
      .setDesc("相对 vault 的根路径，为空则使用 vault 根。仅当启用 V2 知识库目录时生效。")
      .addText(t => {
        const s: any = this.plugin.settings as any;
        t.setPlaceholder("（留空=vault 根）");
        t.setValue(String(s.v2DirectoryRoot ?? ""));
        t.onChange(async (v) => {
          s.v2DirectoryRoot = (v ?? "").trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(globalConfigWrap)
      .setName("自动刷新索引")
      .setDesc("定时增量更新索引。若开启 DB sync，则同时做增量同步。")
      .addToggle(t => {
        const s: any = this.plugin.settings as any;
        const cur = s.autoRefreshIndexEnabled;
        t.setValue(cur === undefined ? true : !!cur);
        t.onChange(async (v) => {
          s.autoRefreshIndexEnabled = !!v;
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          this.display();
        });
      });

    new Setting(globalConfigWrap)
      .setName("自动刷新频率（分钟）")
      .setDesc("默认 30 分钟；建议不要小于 5 分钟。")
      .addText(t => {
        const s: any = this.plugin.settings as any;
        const cur = Number(s.autoRefreshIndexIntervalMin ?? 30);
        t.setPlaceholder("30");
        t.setValue(String(cur));
        t.onChange(async (v) => {
          const n = Math.max(1, Math.floor(Number(v ?? 30)));
          s.autoRefreshIndexIntervalMin = (Number.isFinite(n) ? n : 30);
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          // 不强制重绘整个页面，避免输入体验抖动；但若输入非法，这里会被 saveSettings 规范化
        });
      });

    // ===== 数据库同步（独立分组，可折叠，全局配置） =====
    // ✅ 目的：允许用户不启用 DB sync，也能正常使用索引；把 DB 相关配置集中维护。
    // 注意：这是全局配置，所有空间共用。
    const canSync = (() => {
      if (!hasApiBaseUrl) return false;
      if (!urlCheckable) return false;
      if (!anyDbSyncEnabled) return true;
      return this._dbReady === true;
    })();
    const dbSyncWrap = makeCollapsibleSectionIn(
      globalConfigWrap,
      "数据库同步",
      // DB 不可用时默认展开，便于用户看到原因/填写 URL
      !canSync,
      "rslatte-db-sync-wrap",
      "rslatte-setting-h3"
    );

    // 状态提示（原来在“后端信息维护”顶部的红色提示框）
    {
      const box = dbSyncWrap.createDiv({ cls: "rslatte-db-status-box" });
      const touch: any = (this.plugin as any)?.vaultSvc?.shouldTouchBackendNow?.() ?? { ok: false, reason: "", baseUrl: "" };
      const shouldTouch = !!touch.ok;

      const reason = this._dbReason ? `（${this._dbReason}）` : "";
      let text = "";
      if (!hasApiBaseUrl) {
        text = "未配置 API Base URL：数据库同步不可用。";
      } else if (!urlCheckable) {
        text = "URL 格式未完成或不合法：数据库同步不可用。";
      } else if (!anyDbSyncEnabled) {
        text = "数据库同步已全部关闭：不会检查后端连接（不影响本地功能）。";
      } else if (this._dbReady === null) {
        text = "正在检查数据库初始化状态…";
      } else if (this._dbReady === false) {
        if (this._dbInitRequired) {
          text = `数据库未初始化${reason}：需要执行 001_init.sql（不影响本地功能）。`;
        } else {
          text = `后端不可用（不影响本地功能）${reason}。`;
        }
      } else {
        text = "数据库已就绪：可开启模块同步。";
      }
      const sAny: any = this.plugin.settings as any;
      const hasTok = !!String(sAny?.apiAuthAccessToken ?? "").trim();
      if (shouldTouch && this._authRequired === true && !hasTok) {
        text += " 后端已启用账号鉴权：请填写账号密码并点击「登录并保存」。";
      } else if (shouldTouch && this._authRequired === true && hasTok) {
        const hasPass = !!String(sAny?.apiBackendPassword ?? "").trim();
        text += hasPass
          ? " 令牌会在临近过期或鉴权失败时自动续期（凭据已保存在本库配置，请勿分享 vault）。"
          : " 已保存登录令牌；为支持自动续期，请再执行一次「登录并保存」（将把账号密码写入本机配置）。";
      }
      box.setText(text);

      box.toggleClass("is-ok", shouldTouch && this._dbReady === true);
      box.toggleClass("is-warn", shouldTouch && this._dbReady === false);
      box.toggleClass("is-neutral", !shouldTouch || this._dbReady === null);
    }

    new Setting(dbSyncWrap)
      .setName("WorkEvent 同步到数据库")
      .setDesc(
        "与本地 JSONL 双写；随「自动刷新索引」定时批量上传（非实时）。手机端 plugin_date 仅含摘要列表 work_events_recent。"
      )
      .addToggle((cb) => {
        const sAny: any = this.plugin.settings as any;
        cb.setValue(!!sAny.workEventDbSyncEnabled);
        cb.onChange(async (v) => {
          sAny.workEventDbSyncEnabled = !!v;
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          this.display();
        });
      });

    // API Base URL（填写完成后点击“确认”才保存并检查连接；不再使用 600ms 防抖机制）
    {
      const st = new Setting(dbSyncWrap)
        .setName("API Base URL")
        .setDesc("Backend service base URL");
      st.settingEl.addClass("rslatte-wide-input");

      // draft：仅用于输入框展示；只有点击“确认”才会写入 settings 并触发检查
      let draft = String(this.plugin.settings.apiBaseUrl ?? "");
      let textRef: TextComponent | null = null;

      const isUrlCheckableLocal = (u: string): boolean => {
        const trimmed = String(u ?? "").trim();
        if (!trimmed) return false;
        const lower = trimmed.toLowerCase();
        if (!(lower.startsWith("http://") || lower.startsWith("https://"))) return false;
        try {
          // eslint-disable-next-line no-new
          new URL(trimmed);
          return true;
        } catch {
          return false;
        }
      };

      const isAnyDbSyncEnabledNow = (): boolean => {
        const s: any = this.plugin.settings as any;
        const chk = !!(s?.checkinPanel?.enableDbSync);
        const fin = !!(s?.financePanel?.enableDbSync);
        const tsk = !!(s?.taskModule?.enableDbSync);
        const mem = !!(s?.memoModule?.enableDbSync);
        const cts = !!(s?.contactsModule?.enableDbSync);
        const prj = !!(s?.projectEnableDbSync);
        const out = !!(s?.outputPanel?.enableDbSync);
        const legacyRecord = !!(s?.rslattePanelEnableDbSync);
        const legacyTask = !!(s?.taskPanel?.enableDbSync);
        const wev = !!(s?.workEventDbSyncEnabled);
        const kn = !!(s?.knowledgePanel?.enableDbSync);
        const hlth = !!(s?.healthPanel?.enableDbSync);
        const schDb = !!(s?.scheduleModule?.enableDbSync);
        return chk || fin || tsk || mem || cts || prj || out || legacyRecord || legacyTask || wev || kn || hlth || schDb;
      };

      const forceAllDbSyncOff = () => {
        const sAny2: any = this.plugin.settings as any;
        if (!sAny2.checkinPanel) sAny2.checkinPanel = {};
        if (!sAny2.financePanel) sAny2.financePanel = {};
        if (!sAny2.taskModule) sAny2.taskModule = {};
        if (!sAny2.memoModule) sAny2.memoModule = {};
        if (!sAny2.outputPanel) sAny2.outputPanel = {};
        if (!sAny2.contactsModule) sAny2.contactsModule = {};
        sAny2.checkinPanel.enableDbSync = false;
        sAny2.financePanel.enableDbSync = false;
        sAny2.taskModule.enableDbSync = false;
        sAny2.memoModule.enableDbSync = false;
        sAny2.contactsModule.enableDbSync = false;
        sAny2.projectEnableDbSync = false;
        sAny2.outputPanel.enableDbSync = false;
        // legacy 聚合字段也一并关闭
        sAny2.rslattePanelEnableDbSync = false;
        if (!sAny2.taskPanel) sAny2.taskPanel = {};
        sAny2.taskPanel.enableDbSync = false;
        sAny2.workEventDbSyncEnabled = false;
        if (sAny2.knowledgePanel) sAny2.knowledgePanel.enableDbSync = false;
        if (sAny2.healthPanel) sAny2.healthPanel.enableDbSync = false;
        if (!sAny2.scheduleModule) sAny2.scheduleModule = {};
        sAny2.scheduleModule.enableDbSync = false;
      };

      const commitConfirmed = async () => {
        const raw = textRef ? textRef.getValue() : draft;
        const trimmed = String(raw ?? "").trim();
        const prev = String(this.plugin.settings.apiBaseUrl ?? "").trim();

        // 写入 settings + API client baseUrl（URL 变更则清除令牌，避免误用旧站点的 JWT）
        if (trimmed !== prev) {
          this.plugin.settings.apiBaseUrl = trimmed;
          this.plugin.api?.setBaseUrl(this.plugin.settings.apiBaseUrl);
          (this.plugin.settings as any).apiAuthAccessToken = "";
          (this.plugin.settings as any).apiBackendPassword = "";
          this.plugin.api?.setAuthToken(null);
        }

        // URL 为空/不合法：强制视为 OFF（UI 显示 OFF 且禁用）
        if (!trimmed || !isUrlCheckableLocal(trimmed)) {
          forceAllDbSyncOff();
          await this.plugin.saveSettings();

          // 仅更新设置页状态，不触达后端
          this._dbReady = !trimmed ? false : null;
          this._dbReason = !trimmed ? "API Base URL 为空" : "URL 格式未完成";
          (this as any)._rslatteDbCheckUrl = trimmed;
          this.display();
          return;
        }

        await this.plugin.saveSettings();

        // 只有在至少一个模块开启 DB sync 时，才触达后端检查
        if (!isAnyDbSyncEnabledNow()) {
          this._dbReady = null;
          this._dbReason = "DB 同步已全部关闭";
          (this as any)._rslatteDbCheckUrl = trimmed;
          this.display();
          return;
        }

        // 触发一次连接/初始化检查（Safe：失败仅 warn+标记，不抛错）
        (this as any)._rslatteDbCheckUrl = trimmed;
        this._dbReady = null;
        this._dbReason = "";
        if (!this._dbChecking) {
          this._dbChecking = true;
          try {
            await this.checkDbReady();
          } finally {
            this._dbChecking = false;
          }
        }
        this.display();
      };

      st.addText((text) => {
        textRef = text;
        text
          .setPlaceholder("http://localhost:3000")
          .setValue(draft)
          .onChange((value) => {
            draft = value;
          });

        // widen
        try {
          text.inputEl.style.width = "100%";
          text.inputEl.style.minWidth = "420px";
        } catch { }

        // red border：已保存合法 URL、至少一项 DB 同步开启、且 DB 就绪检查未通过（含未初始化）
        const saved = String(this.plugin.settings.apiBaseUrl ?? "").trim();
        const savedCheckable = isUrlCheckableLocal(saved);
        if (savedCheckable && isAnyDbSyncEnabledNow() && this._dbReady === false) {
          st.settingEl.addClass("rslatte-input-danger");
        }
      });

      st.addButton((btn) => {
        btn.setButtonText("确认");
        btn.setCta();
        btn.onClick(() => void commitConfirmed());
      });

      st.addButton((btn) => {
        btn.setButtonText("恢复");
        btn.onClick(() => {
          const cur = String(this.plugin.settings.apiBaseUrl ?? "");
          draft = cur;
          try { textRef?.setValue(cur); } catch { }
        });
      });
    }

    // 后端账号（JWT_SECRET 启用时必填；登录成功后密码写入 data.json 供静默续期，请勿分享 vault）
    {
      let userRef: TextComponent | null = null;
      let passRef: TextComponent | null = null;
      const sAuthAny: any = this.plugin.settings as any;
      const hasAuthToken = !!String(sAuthAny.apiAuthAccessToken ?? "").trim();
      const hasSavedPassword = !!String(sAuthAny.apiBackendPassword ?? "");
      /** 令牌与密码均已保存：视为完整登录，隐藏「登录并保存」以免重复点击 */
      const authSessionSaved = hasAuthToken && hasSavedPassword;

      const stAuth = new Setting(dbSyncWrap).setName("后端账号");
      try {
        stAuth.descEl.remove();
      } catch {
        /* ignore */
      }
      stAuth.settingEl.addClass("rslatte-backend-auth");
      try {
        stAuth.controlEl.empty();
      } catch {
        /* ignore */
      }
      const fieldsRow = stAuth.controlEl.createDiv({ cls: "rslatte-backend-auth-fields" });
      const actionsRow = stAuth.controlEl.createDiv({ cls: "rslatte-backend-auth-actions" });

      userRef = new TextComponent(fieldsRow)
        .setPlaceholder("账号名")
        .setValue(String(sAuthAny.apiBackendUserName ?? ""));
      try {
        userRef.inputEl.style.minWidth = "200px";
      } catch {
        /* ignore */
      }
      if (authSessionSaved) {
        try {
          userRef.setDisabled(true);
        } catch {
          /* ignore */
        }
      }

      passRef = new TextComponent(fieldsRow);
      passRef.inputEl.type = "password";
      passRef.setPlaceholder(authSessionSaved ? "已保存（清除登录后可重填）" : "密码");
      try {
        passRef.inputEl.style.minWidth = "160px";
      } catch {
        /* ignore */
      }
      if (authSessionSaved) {
        try {
          passRef.setValue("");
          passRef.setDisabled(true);
        } catch {
          /* ignore */
        }
      }

      if (authSessionSaved) {
        const savedStateBtn = new ButtonComponent(fieldsRow)
          .setButtonText("已登录 · 令牌已保存")
          .setDisabled(true);
        try {
          savedStateBtn.buttonEl.setAttr("aria-disabled", "true");
        } catch {
          /* ignore */
        }
      } else {
        new ButtonComponent(fieldsRow)
          .setButtonText("登录并保存")
          .setCta()
          .onClick(async () => {
            const base = String(this.plugin.settings.apiBaseUrl ?? "").trim();
            if (!base) {
              new Notice("请先填写并确认 API Base URL");
              return;
            }
            const user = String(userRef?.getValue() ?? "").trim();
            const pass = String(passRef?.getValue() ?? "");
            if (!user || !pass) {
              new Notice("请填写账号名和密码");
              return;
            }
            this.plugin.api.setBaseUrl(base);
            try {
              const r = await this.plugin.api.authLogin(user, pass);
              (this.plugin.settings as any).apiBackendUserName = user;
              (this.plugin.settings as any).apiBackendPassword = pass;
              (this.plugin.settings as any).apiAuthAccessToken = r.access_token;
              this.plugin.api.setAuthToken(r.access_token);
              await this.plugin.saveSettings();
              try {
                passRef?.setValue("");
              } catch {
                /* ignore */
              }
              await this.refreshAuthRequiredFlag();
              new Notice("登录成功");
              this.display();
            } catch (e: any) {
              const m = String(e?.message ?? e ?? "未知错误");
              new Notice("鉴权失败：" + m);
            }
          });
      }

      new ButtonComponent(actionsRow)
        .setButtonText("申请新账号")
        .onClick(() => {
          rslatteOpenRegisterPage(String(this.plugin.settings.apiBaseUrl ?? "").trim());
        });
      new ButtonComponent(actionsRow)
        .setButtonText("清除登录")
        .onClick(async () => {
          (this.plugin.settings as any).apiAuthAccessToken = "";
          (this.plugin.settings as any).apiBackendPassword = "";
          this.plugin.api?.setAuthToken(null);
          await this.plugin.saveSettings();
          new Notice("已清除保存的登录令牌");
          this.display();
        });
    }

    // =========================
    // 空间管理（可折叠，顶层）
    // - 维护 space 清单（新增/复制/删除/重命名）
    // - 切换 space 后，本页其余“模块管理/各模块设置”即代表该 space 的配置
    // =========================
    const spaceMgmtWrap = makeCollapsibleSection("空间管理", true, "rslatte-space-mgmt-wrap", "global");

    const getCurSpaceId = () => {
      try {
        const fn = (this.plugin as any)?.getCurrentSpaceId;
        if (typeof fn === "function") return String(fn.call(this.plugin) ?? "");
      } catch {
        // ignore
      }
      return String((this.plugin.settings as any)?.currentSpaceId ?? DEFAULT_SPACE_ID);
    };

    const listSpaces = (): RSLatteSpaceConfig[] => {
      try {
        const fn = (this.plugin as any)?.listSpaces;
        if (typeof fn === "function") return fn.call(this.plugin) as RSLatteSpaceConfig[];
      } catch {
        // ignore
      }
      const m: Record<string, RSLatteSpaceConfig> = (this.plugin.settings as any)?.spaces ?? {};
      return Object.values(m).filter(Boolean);
    };

    const genUuid = (): string => {
      try {
        const c: any = (globalThis as any)?.crypto;
        if (c && typeof c.randomUUID === "function") return String(c.randomUUID());
      } catch {
        // ignore
      }
      // fallback (not RFC4122 strict, but stable enough for local ids)
      const rnd = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
      return `${rnd()}-${rnd().slice(0, 4)}-${rnd().slice(0, 4)}-${rnd().slice(0, 4)}-${rnd()}${rnd().slice(0, 4)}`;
    };

    const ensureSpacesMap = (): Record<string, RSLatteSpaceConfig> => {
      const sAny: any = this.plugin.settings as any;
      if (!sAny.spaces || typeof sAny.spaces !== "object") sAny.spaces = {};
      return sAny.spaces as Record<string, RSLatteSpaceConfig>;
    };

    const switchToSpace = async (sid: string) => {
      try {
        const fn = (this.plugin as any)?.switchSpace;
        if (typeof fn === "function") {
          await fn.call(this.plugin, sid, { source: "settings" });
          // 更新 spaces-index.json
          await this._spacesIndexService?.updateIndex();
          // switchSpace 内部会触发 view 刷新；这里补一次 settings 自身刷新
          this.display();
          return;
        }
      } catch (e) {
        console.warn("RSLatteSettingTab switchToSpace failed", e);
      }
      new Notice("切换空间失败：插件未提供 switchSpace。");
    };

    const addSpace = async () => {
      const spacesMap = ensureSpacesMap();
      const spaceList = Object.values(spacesMap).filter(Boolean) as RSLatteSpaceConfig[];
      if (spaceList.length >= 7) {
        new Notice("当前已维护 7 个空间，建议整理并删除或合并不再使用的空间后再新增。");
        return;
      }
      const nextNum = pickNextAvailableSpaceNumberForNewSpace(spaceList);
      if (nextNum == null) {
        new Notice("当前已维护 7 个空间，建议整理并删除或合并不再使用的空间后再新增。");
        return;
      }
      const idx = spaceList.length + 1;
      const modal = new AddSpaceModal(this.app, this.plugin, `空间 ${idx}`, {
        rootPrefix: buildDefaultRootPrefix(nextNum),
      });
      const result = await modal.waitForResult();
      if (!result) return;

      const now = new Date().toISOString();
      const sid = genUuid();
      const spaces = ensureSpacesMap();
      if (spaces[sid]) {
        new Notice("空间 UUID 冲突，请重试。");
        return;
      }

      const rootDir = normalizePath(result.defaultRootDir.trim());
      const snapshot: any = buildSettingsSnapshotForNewSpace(nextNum, rootDir, DEFAULT_SETTINGS as any);

      spaces[sid] = {
        id: sid,
        name: result.name,
        spaceNumber: nextNum,
        createdAt: now,
        updatedAt: now,
        settingsSnapshot: snapshot,
      } as any;

      const ok = await this.plugin.saveSettings();
      if (!ok) return;
      try {
        await ensureSpaceSnapshotAndKnowledgeDirs(this.app, this.plugin.settings, snapshot);
      } catch (e) {
        console.warn("RSLatte ensureSpaceSnapshotAndKnowledgeDirs failed:", e);
      }
      // 更新 spaces-index.json
      await this._spacesIndexService?.updateIndex();
      this.display();
      new Notice("已新增空间。");
      void this.plugin.vaultSvc?.ensureVaultReadySafe?.("space-added");
    };

    const duplicateSpace = async (fromId: string) => {
      const spaces = ensureSpacesMap();
      const src = spaces[fromId];
      if (!src) {
        new Notice("未找到要复制的空间。");
        return;
      }
      const spaceList = Object.values(spaces).filter(Boolean) as RSLatteSpaceConfig[];
      if (spaceList.length >= 7) {
        new Notice("当前已维护 7 个空间，无法复制。请先删除或合并不再使用的空间。");
        return;
      }
      const nextNum = pickNextAvailableSpaceNumberForNewSpace(spaceList);
      if (nextNum == null) {
        new Notice("当前已维护 7 个空间，无法复制。请先删除或合并不再使用的空间。");
        return;
      }
      const now = new Date().toISOString();
      const sid = genUuid();
      const copyName = String(src.name ?? "").trim() || fromId;
      const dupSnap = JSON.parse(
        JSON.stringify((src as any).settingsSnapshot ?? extractPerSpaceSettings(this.plugin.settings)),
      ) as Partial<RSLattePluginSettings>;
      spaces[sid] = {
        id: sid,
        name: `${copyName} - 副本`,
        spaceNumber: nextNum,
        createdAt: now,
        updatedAt: now,
        settingsSnapshot: dupSnap,
      } as any;
      const ok = await this.plugin.saveSettings();
      if (!ok) return;
      try {
        await ensureSpaceSnapshotAndKnowledgeDirs(this.app, this.plugin.settings, dupSnap);
      } catch (e) {
        console.warn("RSLatte ensureSpaceSnapshotAndKnowledgeDirs (duplicate) failed:", e);
      }
      // 更新 spaces-index.json
      await this._spacesIndexService?.updateIndex();
      this.display();
      new Notice("已复制空间。");
      void this.plugin.vaultSvc?.ensureVaultReadySafe?.("space-duplicated");
    };

    const deleteSpace = async (sid: string) => {
      if (sid === DEFAULT_SPACE_ID) {
        new Notice("默认空间不可删除。");
        return;
      }
      const spaces = ensureSpacesMap();
      if (!spaces[sid]) {
        new Notice("未找到要删除的空间。");
        return;
      }

      const name = String(spaces[sid]?.name ?? sid);
      const okConfirm = window.confirm(`确定删除空间：${name} ?\n\n注意：仅删除空间配置，不会删除笔记/索引文件。`);
      if (!okConfirm) return;

      const cur = getCurSpaceId();
      delete spaces[sid];

      // 若删除的是当前空间，则切回默认空间
      if (cur === sid) {
        (this.plugin.settings as any).currentSpaceId = DEFAULT_SPACE_ID;
      }
      const ok = await this.plugin.saveSettings();
      if (!ok) return;

      // 若删除的是当前空间，额外触发一次真正的切换（保证快照/缓存/headers 切回）
      if (cur === sid) {
        try {
          await switchToSpace(DEFAULT_SPACE_ID);
        } catch {
          // ignore
        }
      }

      // 更新 spaces-index.json
      await this._spacesIndexService?.updateIndex();
      this.display();
      new Notice("已删除空间。");
      void this.plugin.vaultSvc?.ensureVaultReadySafe?.("space-deleted");
    };

    // Header row: 当前空间和按钮在同一行，按钮靠右
    {
      const curId = getCurSpaceId();
      const sp = ensureSpacesMap()[curId];
      const curName = String(sp?.name ?? curId).trim() || curId;

      const head = spaceMgmtWrap.createDiv({ cls: "rslatte-space-mgmt-head" });
      head.style.display = "flex";
      head.style.justifyContent = "space-between";
      head.style.alignItems = "center";
      
      const currentSpaceText = head.createEl("div", { cls: "rslatte-muted", text: `当前空间：${curName}` });
      
      const btns = head.createDiv({ cls: "rslatte-space-mgmt-actions" });
      btns.style.display = "flex";
      btns.style.gap = "8px";
      
      // 新增空间按钮
      new ButtonComponent(btns)
        .setButtonText("新增空间")
        .onClick(() => void addSpace());
      
      
    }

    // Space list (table style, similar to task list)
    {
      // 创建表格
      const tableWrap = spaceMgmtWrap.createDiv({ cls: "rslatte-tasklist-table-wrap" });
      const table = tableWrap.createEl("table", { cls: "rslatte-tasklist-table" });
      const thead = table.createEl("thead");
      const hr = thead.createEl("tr");
      hr.createEl("th", { text: "" }); // 第一列：当前空间标识
      hr.createEl("th", { text: "空间名称" });
      hr.createEl("th", { text: "编号" });
      hr.createEl("th", { text: "UUID" });
      hr.createEl("th", { text: "日记路径" });
      hr.createEl("th", { text: "日记格式" });
      hr.createEl("th", { text: "操作" });

      const tbody = table.createEl("tbody");
      const spaces = listSpaces();
      if (!spaces.length) {
        spaceMgmtWrap.createDiv({ cls: "rslatte-muted", text: "尚未配置空间。点击上方“新增空间”。" });
        return;
      }

      const curId = getCurSpaceId();
      for (const sp of spaces) {
        const sid = String(sp?.id ?? "").trim();
        if (!sid) continue;

        const isCur = sid === curId;
        const spaceName = String(sp?.name ?? sid).trim() || sid;
        const snapshot = (sp as any)?.settingsSnapshot || {};
        const diaryPath = snapshot.diaryPath || this.plugin.settings.diaryPath || "";
        const diaryNameFormat = snapshot.diaryNameFormat || this.plugin.settings.diaryNameFormat || "YYYYMMDD";

        const tr = tbody.createEl("tr", { cls: isCur ? "rslatte-space-row is-current" : "rslatte-space-row" });

        // 第一列：当前空间标识
        const tdStatus = tr.createEl("td", { cls: "rslatte-space-status" });
        if (isCur) {
          tdStatus.createEl("span", { text: "✅", cls: "rslatte-space-current-mark" });
        }

        // 空间名称（可编辑）
        const tdName = tr.createEl("td", { cls: "rslatte-space-name" });
        const nameInput = tdName.createEl("input", { type: "text", cls: "rslatte-space-name-input" });
        nameInput.value = spaceName;
        nameInput.placeholder = "空间名称";
        nameInput.addEventListener("change", async () => {
          const spacesMap = ensureSpacesMap();
          const cur = spacesMap[sid];
          if (!cur) return;
          cur.name = String(nameInput.value ?? "").trim() || sid;
          (cur as any).updatedAt = new Date().toISOString();
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          // 更新 spaces-index.json
          await this._spacesIndexService?.updateIndex();
          this.display();
          void this.plugin.vaultSvc?.ensureVaultReadySafe?.("space-edited");
        });

        const tdNum = tr.createEl("td", { cls: "rslatte-space-num" });
        tdNum.createEl("span", {
          cls: "rslatte-muted",
          text: typeof sp.spaceNumber === "number" ? String(sp.spaceNumber) : "—",
        });

        // UUID
        const tdUuid = tr.createEl("td", { cls: "rslatte-space-uuid" });
        tdUuid.createEl("code", { text: sid, cls: "rslatte-muted" });

        // 日记路径
        const tdDiaryPath = tr.createEl("td", { cls: "rslatte-space-diary-path" });
        const diaryPathText = diaryPath || "(使用全局设置)";
        tdDiaryPath.createEl("span", { text: diaryPathText, cls: diaryPath ? "" : "rslatte-muted" });

        // 日记格式
        const tdDiaryFormat = tr.createEl("td", { cls: "rslatte-space-diary-format" });
        tdDiaryFormat.createEl("code", { text: diaryNameFormat });

        // 操作按钮
        const tdActions = tr.createEl("td", { cls: "rslatte-space-actions" });
        const actionsContainer = tdActions.createDiv({ cls: "rslatte-space-actions-container" });
        actionsContainer.style.display = "flex";
        actionsContainer.style.gap = "6px";
        
        new ButtonComponent(actionsContainer)
          .setButtonText(isCur ? "当前" : "切换")
          .setDisabled(isCur)
          .onClick(() => void switchToSpace(sid));

        new ButtonComponent(actionsContainer)
          .setButtonText("复制UUID")
          .onClick(async () => {
            try {
              await navigator.clipboard.writeText(sid);
              new Notice(`已复制 UUID: ${sid}`);
            } catch (error: any) {
              new Notice(`复制失败: ${error?.message ?? String(error)}`);
            }
          });

        new ButtonComponent(actionsContainer)
          .setButtonText("删除")
          .setDisabled(sid === DEFAULT_SPACE_ID)
          .onClick(() => void deleteSpace(sid));


      }
    }

    // =========================
    // 模块管理（可折叠，顶层）
    // 说明：与“后端信息维护 / 日志管理 / 打卡管理 ...”同级。
    // =========================

    // 模块管理：启用/同步/归档等写入 SPACE_SCOPED_SETTING_KEYS，随空间快照切换；与《空间管理优化方案》§6.2 一致，侧栏标签为「空间」。
    const moduleMgmtWrap = makeCollapsibleSection("模块管理", false, "rslatte-module-mgmt-wrap", "space");

    const modTableWrap = moduleMgmtWrap.createDiv({ cls: "rslatte-section" });
    modTableWrap.createEl("div", {
      cls: "rslatte-setting-hint",
      text: "归档分三类（与《索引优化方案》§9、CODE_MAP §3.11.1 一致）：①笔记归档——在 Vault 内移动 md/文件夹；②索引归档——中央索引条目写入 archive 分片、主索引瘦身；③日记按月——见下方「日记管理」。本表「自动/手动」：任务/提醒/日程/打卡/财务/健康以索引归档为主；输出、项目含笔记搬迁（并常伴随索引更新）；联系人「立即归档」为笔记归档。",
    });
    if (!modGateOpen) {
      modTableWrap.createEl("div", {
        cls: "rslatte-setting-hint",
        text: "在全局配置中打开「插件初始化环境检查」，强制项（含模板）全部通过后点击「完成初始化」前，下表模块开关将保持关闭且不可编辑（与运行时一致）。",
      });
    }
    const modTable = modTableWrap.createEl("table", { cls: "rslatte-tasklist-table" });
    const modThead = modTable.createEl("thead");
    const modHr = modThead.createEl("tr");
    ["模块", "启用", "数据库同步", "自动归档（索引·每日≤1次）", "归档阈值（天，≥90）", "手动归档", "扫描重建索引"].forEach((h) => modHr.createEl("th", { text: h }));
    const modTbody = modTable.createEl("tbody");

    // 数据库同步由关→开时：写入 forceFull 标记并触发 manual_refresh（与旧「模块与数据库同步」逻辑一致）
    const handleDbSyncToggleOn = (
      v2Key: 'checkin' | 'finance' | 'health' | 'task' | 'memo' | 'schedule' | 'project' | 'output' | 'knowledge',
      label: string
    ) => {
      const sAny2: any = this.plugin.settings as any;
      if (!sAny2.dbSyncForceFullNext) sAny2.dbSyncForceFullNext = {};
      sAny2.dbSyncForceFullNext[v2Key] = true;
      try {
        const pe: any = (this.plugin as any).pipelineEngine;
        if (pe && typeof pe.runE2 === 'function') {
          void (async () => {
            try {
              const ctx = this.plugin.getSpaceCtx();
              const r = await pe.runE2(ctx, v2Key as any, 'manual_refresh');
              if (!r?.ok) {
                new Notice(`同步初始化失败：${label} - ${r?.error?.message ?? 'unknown error'}`);
                return;
              }
              if (r?.data?.skipped) return;
              new Notice(`已开始同步初始化：${label}`);
            } catch (e: any) {
              new Notice(`同步初始化失败：${label} - ${e?.message ?? String(e)}`);
            } finally {
              this.plugin.refreshSidePanel();
            }
          })();
        }
      } catch { /* ignore */ }
    };

    // 当模块从“关闭→开启”时，自动触发一次“扫描重建索引”。
    // 目的：避免用户开启模块后侧边栏/索引仍为空，需要再手动点“扫描重建”。
    // 注意：这里复用每个模块的既有“扫描重建”实现，保持业务逻辑一致。
    const triggerRebuildOnEnable = async (
      v2Key: 'checkin' | 'finance' | 'health' | 'task' | 'memo' | 'schedule' | 'project' | 'output'
    ) => {
      const labelMap: Record<string, string> = {
        checkin: '打卡',
        finance: '财务',
        health: '健康',
        task: '任务',
        memo: '提醒',
        schedule: '日程',
        project: '项目',
        output: '输出',
      };
      const label = labelMap[v2Key] ?? v2Key;

      // Fire-and-forget: 不阻塞设置页 UI。
      void (async () => {
        try {
          // 二次确认：模块未启用则不触发
          const me2: any = (this.plugin.settings as any)?.moduleEnabledV2 ?? {};
          if (me2[v2Key] === false) return;

          const pe: any = (this.plugin as any).pipelineEngine;
          if (!pe || typeof pe.runE2 !== 'function') {
            new Notice(`自动扫描重建失败：${label} - pipelineEngine 未就绪`);
            return;
          }

          // ✅ 空间隔离：使用当前空间的 SpaceCtx
          const ctx = this.plugin.getSpaceCtx();
          const r = await pe.runE2(ctx, v2Key as any, 'rebuild');
          if (!r.ok) {
            new Notice(`自动扫描重建失败：${label} - ${r.error.message}`);
            console.warn('[RSLatte][ui] auto rebuild on enable failed', { moduleKey: v2Key, mode: 'rebuild', error: r.error });
            return;
          }
          if (r.data.skipped) return;

          const runId = (r.data as any).runId ? ` (${(r.data as any).runId})` : '';
          new Notice(`已自动扫描并重建索引：${label}${runId}`);
        } catch (e: any) {
          new Notice(`自动扫描重建失败：${label} - ${e?.message ?? String(e)}`);
        } finally {
          this.plugin.refreshSidePanel();
        }
      })();
    };

    const renderRow = (
      label: string,
      moduleKey: 'record' | 'task' | 'project' | 'output',
      get: () => any,
      set: (patch: any) => void,
      onArchive: () => Promise<void>,
      onRebuild: () => Promise<void>
    ) => {
      const row = modTbody.createEl("tr");
      const enabled = isLegacyEnabled(moduleKey);
      if (!enabled) row.addClass("is-disabled");

      row.createEl("td", { text: label });

      // Enable toggle
      {
        const td = row.createEl("td");
        const cb = td.createEl("input", { type: "checkbox" });
        cb.checked = enabled;
        cb.onchange = async () => {
          sAny.moduleEnabled = sAny.moduleEnabled || {};
          sAny.moduleEnabled[moduleKey] = cb.checked;
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          this.display();
          this.plugin.refreshSidePanel();
        };
      }

      // Auto archive
      {
        const td = row.createEl("td");
        const cb = td.createEl("input", { type: "checkbox" });
        cb.checked = !!get().autoArchiveEnabled;
        cb.disabled = !enabled;
        cb.onchange = async () => {
          set({ autoArchiveEnabled: cb.checked });
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          this.display();
        };
      }

      // Threshold
      {
        const td = row.createEl("td");
        const input = td.createEl("input", { type: "number" });
        (input as HTMLInputElement).min = String(MIN_ARCHIVE_THRESHOLD_DAYS);
        (input as HTMLInputElement).max = "3650";
        (input as HTMLInputElement).style.width = "90px";
        (input as HTMLInputElement).value = String(get().archiveThresholdDays ?? 90);
        (input as HTMLInputElement).disabled = !enabled;
        input.onchange = async () => {
          const n = noticeAndNormalizeArchiveThresholdInput(input as HTMLInputElement);
          set({ archiveThresholdDays: n });
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          this.display();
        };
      }

      // Manual archive
      {
        const td = row.createEl("td");
        const btn = td.createEl("button", { text: "立即归档" });
        btn.addClass("mod-cta");
        btn.disabled = !enabled;
        btn.onclick = async () => {
          try {
            btn.disabled = true;
            await onArchive();
          } finally {
            btn.disabled = !enabled;
            this.plugin.refreshSidePanel();
          }
        };
      }

      // Scan rebuild index
      {
        const td = row.createEl("td");
        const btn = td.createEl("button", { text: "扫描重建" });
        btn.addClass("mod-cta");
        btn.disabled = !enabled;
        btn.onclick = async () => {
          try {
            btn.disabled = true;
            await onRebuild();
          } finally {
            btn.disabled = !enabled;
            this.plugin.refreshSidePanel();
          }
        };
      }
    };
    // v6-2：打卡/财务拆分为两行（v6-3 起拆分逻辑生效）。
    // 兼容：v6-3 之前运行仍可能依赖旧的 record 统一配置（rslattePanelEnableDbSync / rslattePanelAutoArchiveEnabled / rslattePanelArchiveThresholdDays）。
    const ensureCheckinFinanceV2Defaults = () => {
      if (!sAny.moduleEnabledV2) sAny.moduleEnabledV2 = {};
      if (!sAny.checkinPanel) sAny.checkinPanel = {};
      if (!sAny.financePanel) sAny.financePanel = {};

      // 默认值：优先沿用旧 record 统一配置（避免升级后配置突然变化）
      const legacyEnableDb = (sAny.rslattePanelEnableDbSync ?? true);
      const legacyAutoArc = (sAny.rslattePanelAutoArchiveEnabled ?? false);
      const legacyDays = (sAny.rslattePanelArchiveThresholdDays ?? 90);

      if (sAny.moduleEnabledV2.checkin === undefined) sAny.moduleEnabledV2.checkin = true;
      if (sAny.moduleEnabledV2.finance === undefined) sAny.moduleEnabledV2.finance = true;

      if (sAny.checkinPanel.enableDbSync === undefined) sAny.checkinPanel.enableDbSync = legacyEnableDb;
      if (sAny.financePanel.enableDbSync === undefined) sAny.financePanel.enableDbSync = legacyEnableDb;

      if (sAny.checkinPanel.autoArchiveEnabled === undefined) sAny.checkinPanel.autoArchiveEnabled = legacyAutoArc;
      if (sAny.financePanel.autoArchiveEnabled === undefined) sAny.financePanel.autoArchiveEnabled = legacyAutoArc;

      if (sAny.checkinPanel.archiveThresholdDays === undefined) sAny.checkinPanel.archiveThresholdDays = legacyDays;
      if (sAny.financePanel.archiveThresholdDays === undefined) sAny.financePanel.archiveThresholdDays = legacyDays;
    };

    // v6-2 兼容写回：把拆分配置“合并”回旧 record 统一配置，保证 v6-3 前的实际行为仍可控。
    // 合并规则：
    // - record 启用：checkinEnabled || financeEnabled
    // - enableDbSync / autoArchive：任一模块开启则视为开启
    // - archiveThresholdDays：取两者的最大值（更保守，避免意外提前归档）
    const syncRecordUnifiedFromV2 = () => {
      ensureCheckinFinanceV2Defaults();
      const me2 = sAny.moduleEnabledV2;
      const ckOn = !!me2.checkin;
      const fnOn = !!me2.finance;
      const recordOn = (ckOn || fnOn);
      setModEnabled('record', recordOn);

      const ck = sAny.checkinPanel;
      const fn = sAny.financePanel;
      sAny.rslattePanelEnableDbSync = (!!ck.enableDbSync) || (!!fn.enableDbSync);
      sAny.rslattePanelAutoArchiveEnabled = (!!ck.autoArchiveEnabled) || (!!fn.autoArchiveEnabled);
      sAny.rslattePanelArchiveThresholdDays = Math.max(Number(ck.archiveThresholdDays ?? 90), Number(fn.archiveThresholdDays ?? 90));
    };

    const renderRecordV2Row = (
      label: '打卡' | '财务',
      v2Key: 'checkin' | 'finance',
      panelKey: 'checkinPanel' | 'financePanel'
    ) => {
      ensureCheckinFinanceV2Defaults();
      const row = modTbody.createEl('tr');
      const me2: any = sAny.moduleEnabledV2;
      const p2: any = sAny[panelKey];
      const savedEnabled = (me2[v2Key] === undefined ? true : !!me2[v2Key]);
      const enabled = modGateOpen && savedEnabled;
      if (!enabled) row.addClass('is-disabled');

      row.createEl('td', { text: label });

      // 启用（v6-3 生效，但 v6-2 会同步合并到 record 统一配置，避免当前运行失控）
      {
        const td = row.createEl('td');
        const cb = td.createEl('input', { type: 'checkbox' });
        cb.checked = modGateOpen ? savedEnabled : false;
        cb.disabled = !modGateOpen;
        cb.onchange = async () => {
          if (!modGateOpen) return;
          const wasEnabled = (me2[v2Key] === undefined ? true : !!me2[v2Key]);
          const nowEnabled = !!cb.checked;
          me2[v2Key] = cb.checked;
          if (!cb.checked) {
            p2.enableDbSync = false;
            p2.autoArchiveEnabled = false;
          }
          syncRecordUnifiedFromV2();
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          
          // 更新当前空间的 settingsSnapshot，确保 Hub 能获取到最新的模块启用状态
          await this.updateCurrentSpaceSnapshot();
          
          this.display();
          this.plugin.refreshSidePanel();

          // Auto rebuild when module is turned ON
          if (!wasEnabled && nowEnabled) {
            await triggerRebuildOnEnable(v2Key);
          }
        };
      }

      // 数据库同步（从「模块与数据库同步」移入模块管理；非全局，按模块配置）
      {
        const td = row.createEl('td');
        td.setAttribute('data-rslatte-db-sync-td', '1');
        const cb = td.createEl('input', { type: 'checkbox' });
        const dbSyncVal = p2.enableDbSync === undefined ? true : !!p2.enableDbSync;
        cb.checked = dbSyncVal;
        cb.disabled = !enabled || !urlCheckable;
        if (cb.disabled) td.addClass('is-disabled');
        cb.onchange = async () => {
          if (!urlCheckable || !enabled) return;
          const prev = p2.enableDbSync === undefined ? true : !!p2.enableDbSync;
          p2.enableDbSync = !!cb.checked;
          syncRecordUnifiedFromV2();
          if (prev === false && !!cb.checked) handleDbSyncToggleOn(v2Key, label);
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          this.display();
        };
      }

      // 自动归档（每日一次）
      {
        const td = row.createEl('td');
        const cb = td.createEl('input', { type: 'checkbox' });
        cb.checked = !!p2.autoArchiveEnabled;
        cb.disabled = !enabled;
        if (cb.disabled) td.addClass('is-disabled');
        cb.onchange = async () => {
          p2.autoArchiveEnabled = cb.checked;
          syncRecordUnifiedFromV2();
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          this.display();
        };
      }

      // 归档阈值（天）
      {
        const td = row.createEl('td');
        const input = td.createEl('input', { type: 'number' });
        (input as HTMLInputElement).min = String(MIN_ARCHIVE_THRESHOLD_DAYS);
        (input as HTMLInputElement).max = '3650';
        (input as HTMLInputElement).style.width = '90px';
        (input as HTMLInputElement).value = String(p2.archiveThresholdDays ?? 90);
        (input as HTMLInputElement).disabled = !enabled;
        if ((input as HTMLInputElement).disabled) td.addClass('is-disabled');
        input.onchange = async () => {
          const n = noticeAndNormalizeArchiveThresholdInput(input as HTMLInputElement);
          p2.archiveThresholdDays = n;
          syncRecordUnifiedFromV2();
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          this.display();
        };
      }

      // 手动归档（v6-3b：按模块独立归档）
      {
        const td = row.createEl('td');
        const btn = td.createEl('button', { text: '立即归档' });
        btn.addClass('mod-cta');
        btn.disabled = !enabled;
        btn.onclick = async () => {
          try {
            btn.disabled = true;
            // ✅ 空间隔离：使用当前空间的 SpaceCtx
            const ctx = this.plugin.getSpaceCtx();
            const r = await this.plugin.pipelineEngine.runE2(ctx, v2Key as any, "manual_archive");
            if (!r.ok) {
              new Notice(`归档失败：${r.error.message}`);
              return;
            }
            if (r.data.skipped) return;
            new Notice(`索引归档完成：${v2Key === "checkin" ? "打卡" : "财务"}`);
          } catch (e: any) {
            new Notice(`归档失败：${e?.message ?? String(e)}`);
          } finally {
            btn.disabled = !enabled;
            this.plugin.refreshSidePanel();
          }
        };
      }

      // 扫描重建索引（v6-3b：按模块独立重建）
      {
        const td = row.createEl('td');
        const btn = td.createEl('button', { text: '扫描重建' });
        btn.addClass('mod-cta');
        btn.disabled = !enabled;
        btn.onclick = async () => {
          try {
            btn.disabled = true;
            // ✅ 空间隔离：使用当前空间的 SpaceCtx
            const ctx = this.plugin.getSpaceCtx();
            const r = await this.plugin.pipelineEngine.runE2(ctx, v2Key as any, "rebuild");
            if (!r.ok) {
              new Notice(`扫描重建失败：${r.error.message}`);
              return;
            }
            if (r.data.skipped) return;

            new Notice(`${v2Key === "checkin" ? "打卡" : "财务"}已扫描并重建索引`);
          } catch (e: any) {
            new Notice(`扫描重建失败：${e?.message ?? String(e)}`);
          } finally {
            btn.disabled = !enabled;
            this.plugin.refreshSidePanel();
          }
        };
      }
    };

    // 打卡 / 财务 两行（替代原来的“打卡/财务”父行）
    renderRecordV2Row('打卡', 'checkin', 'checkinPanel');
    renderRecordV2Row('财务', 'finance', 'financePanel');

    const ensureHealthV2Defaults = () => {
      if (!sAny.healthPanel) sAny.healthPanel = {};
      const legacyEnableDb = (sAny.rslattePanelEnableDbSync ?? true);
      const legacyAutoArc = (sAny.rslattePanelAutoArchiveEnabled ?? true);
      const legacyDays = (sAny.rslattePanelArchiveThresholdDays ?? 90);
      if (sAny.healthPanel.enableDbSync === undefined) sAny.healthPanel.enableDbSync = legacyEnableDb;
      if (sAny.healthPanel.autoArchiveEnabled === undefined) sAny.healthPanel.autoArchiveEnabled = legacyAutoArc;
      if (sAny.healthPanel.archiveThresholdDays === undefined) sAny.healthPanel.archiveThresholdDays = legacyDays;
    };

    const renderHealthV2Row = () => {
      if (!sAny.moduleEnabledV2) sAny.moduleEnabledV2 = {};
      if (sAny.moduleEnabledV2.health === undefined) sAny.moduleEnabledV2.health = true;
      ensureHealthV2Defaults();

      const row = modTbody.createEl("tr");
      const me2: any = sAny.moduleEnabledV2;
      const p2: any = sAny.healthPanel;
      const savedEnabled = me2.health === true;
      const enabled = modGateOpen && savedEnabled;
      if (!enabled) row.addClass("is-disabled");

      row.createEl("td", { text: "健康" });

      {
        const td = row.createEl("td");
        const cb = td.createEl("input", { type: "checkbox" });
        cb.checked = modGateOpen ? savedEnabled : false;
        cb.disabled = !modGateOpen;
        cb.onchange = async () => {
          if (!modGateOpen) return;
          const wasEnabled = me2.health === true;
          const nowEnabled = !!cb.checked;
          me2.health = nowEnabled;
          if (!cb.checked) {
            p2.enableDbSync = false;
            p2.autoArchiveEnabled = false;
          }
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          await this.updateCurrentSpaceSnapshot();
          this.display();
          this.plugin.refreshSidePanel();
          if (!wasEnabled && nowEnabled) {
            await triggerRebuildOnEnable("health");
          }
        };
      }

      {
        const td = row.createEl("td");
        td.setAttribute("data-rslatte-db-sync-td", "1");
        const cb = td.createEl("input", { type: "checkbox" });
        cb.checked = !!p2.enableDbSync;
        cb.disabled = !enabled || !urlCheckable;
        if (cb.disabled) td.addClass("is-disabled");
        cb.onchange = async () => {
          if (!urlCheckable || !enabled) return;
          const prev = !!p2.enableDbSync;
          p2.enableDbSync = !!cb.checked;
          if (prev === false && !!cb.checked) handleDbSyncToggleOn("health", "健康");
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          this.display();
        };
      }

      {
        const td = row.createEl("td");
        const cb = td.createEl("input", { type: "checkbox" });
        cb.checked = !!p2.autoArchiveEnabled;
        cb.disabled = !enabled;
        if (cb.disabled) td.addClass("is-disabled");
        cb.onchange = async () => {
          p2.autoArchiveEnabled = cb.checked;
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          this.display();
        };
      }

      {
        const td = row.createEl("td");
        const input = td.createEl("input", { type: "number" });
        (input as HTMLInputElement).min = String(MIN_ARCHIVE_THRESHOLD_DAYS);
        (input as HTMLInputElement).max = "3650";
        (input as HTMLInputElement).style.width = "90px";
        (input as HTMLInputElement).value = String(p2.archiveThresholdDays ?? 90);
        (input as HTMLInputElement).disabled = !enabled;
        if ((input as HTMLInputElement).disabled) td.addClass("is-disabled");
        input.onchange = async () => {
          const n = noticeAndNormalizeArchiveThresholdInput(input as HTMLInputElement);
          p2.archiveThresholdDays = n;
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          this.display();
        };
      }

      {
        const td = row.createEl("td");
        const btn = td.createEl("button", { text: "立即归档" });
        btn.addClass("mod-cta");
        btn.disabled = !enabled;
        btn.onclick = async () => {
          try {
            btn.disabled = true;
            const ctx = this.plugin.getSpaceCtx();
            const r = await this.plugin.pipelineEngine.runE2(ctx, "health" as any, "manual_archive");
            if (!r.ok) {
              new Notice(`归档失败：${r.error.message}`);
              return;
            }
            if (r.data.skipped) return;
            new Notice("索引归档完成：健康");
          } catch (e: any) {
            new Notice(`归档失败：${e?.message ?? String(e)}`);
          } finally {
            btn.disabled = !enabled;
            this.plugin.refreshSidePanel();
          }
        };
      }

      {
        const td = row.createEl("td");
        const btn = td.createEl("button", { text: "扫描重建" });
        btn.addClass("mod-cta");
        btn.disabled = !enabled;
        btn.onclick = async () => {
          try {
            btn.disabled = true;
            const ctx = this.plugin.getSpaceCtx();
            const r = await this.plugin.pipelineEngine.runE2(ctx, "health" as any, "rebuild");
            if (!r.ok) {
              new Notice(`扫描重建失败：${r.error.message}`);
              return;
            }
            if (r.data.skipped) return;
            new Notice("健康已扫描并重建索引");
          } catch (e: any) {
            new Notice(`扫描重建失败：${e?.message ?? String(e)}`);
          } finally {
            btn.disabled = !enabled;
            this.plugin.refreshSidePanel();
          }
        };
      }
    };

    renderHealthV2Row();

    // v6-4：任务/提醒拆分为两行（逐步启用）。
    // 兼容：当前运行仍由 taskPanel 作为统一入口（TaskRSLatteService 合并处理）。
    const ensureTaskMemoV2Defaults = () => {
      if (!sAny.moduleEnabledV2) sAny.moduleEnabledV2 = {};
      if (!sAny.taskModule) sAny.taskModule = {};
      if (!sAny.memoModule) sAny.memoModule = {};
      if (!sAny.scheduleModule) sAny.scheduleModule = {};

      const legacyTaskEnabled = (sAny.moduleEnabled?.task ?? true);
      if (sAny.moduleEnabledV2.task === undefined) sAny.moduleEnabledV2.task = legacyTaskEnabled;
      if (sAny.moduleEnabledV2.memo === undefined) sAny.moduleEnabledV2.memo = legacyTaskEnabled;
      if (sAny.moduleEnabledV2.schedule === undefined) sAny.moduleEnabledV2.schedule = legacyTaskEnabled;

      const legacyEnableDb = (sAny.taskPanel?.enableDbSync ?? true);
      const legacyAutoArc = (sAny.taskPanel?.autoArchiveEnabled ?? true);
      const legacyDays = (sAny.taskPanel?.archiveThresholdDays ?? 90);

      if (sAny.taskModule.enableDbSync === undefined) sAny.taskModule.enableDbSync = legacyEnableDb;
      if (sAny.taskModule.autoArchiveEnabled === undefined) sAny.taskModule.autoArchiveEnabled = legacyAutoArc;
      if (sAny.taskModule.archiveThresholdDays === undefined) sAny.taskModule.archiveThresholdDays = legacyDays;

      if (sAny.memoModule.enableDbSync === undefined) sAny.memoModule.enableDbSync = legacyEnableDb;
      if (sAny.memoModule.autoArchiveEnabled === undefined) sAny.memoModule.autoArchiveEnabled = legacyAutoArc;
      if (sAny.memoModule.archiveThresholdDays === undefined) sAny.memoModule.archiveThresholdDays = legacyDays;
      if (sAny.scheduleModule.enableDbSync === undefined) sAny.scheduleModule.enableDbSync = legacyEnableDb;
      if (sAny.scheduleModule.autoArchiveEnabled === undefined) sAny.scheduleModule.autoArchiveEnabled = legacyAutoArc;
      if (sAny.scheduleModule.archiveThresholdDays === undefined) sAny.scheduleModule.archiveThresholdDays = legacyDays;
    };

    // v6-4 兼容写回：把拆分配置“合并”回 taskPanel 的统一配置，保证当前运行行为仍可控。
    // 合并规则：
    // - task 模块启用：taskEnabled || memoEnabled
    // - enableDbSync / autoArchive：任一模块开启则视为开启
    // - archiveThresholdDays：取两者的最大值（更保守，避免意外提前归档）
    const syncTaskUnifiedFromV2 = () => {
      ensureTaskMemoV2Defaults();
      const me2: any = sAny.moduleEnabledV2;
      const taskOn = !!me2.task;
      const memoOn = !!me2.memo;
      setModEnabled('task', taskOn || memoOn);

      const t: any = sAny.taskModule;
      const m: any = sAny.memoModule;
      const sch: any = sAny.scheduleModule ?? {};
      if (!sAny.taskPanel) sAny.taskPanel = {};
      const tp: any = sAny.taskPanel;
      tp.enableDbSync = (!!t.enableDbSync) || (!!m.enableDbSync) || (!!sch.enableDbSync);
      tp.autoArchiveEnabled = (!!t.autoArchiveEnabled) || (!!m.autoArchiveEnabled);
      tp.archiveThresholdDays = Math.max(Number(t.archiveThresholdDays ?? 90), Number(m.archiveThresholdDays ?? 90));
    };

    const renderTaskMemoV2Row = (
      label: '任务' | '提醒',
      v2Key: 'task' | 'memo',
      panelKey: 'taskModule' | 'memoModule'
    ) => {
      ensureTaskMemoV2Defaults();
      const row = modTbody.createEl('tr');
      const me2: any = sAny.moduleEnabledV2;
      const p2: any = sAny[panelKey];
      const savedEnabled = (me2[v2Key] === undefined ? true : !!me2[v2Key]);
      const enabled = modGateOpen && savedEnabled;
      if (!enabled) row.addClass('is-disabled');

      // Row-level control disable helper (module disabled => force-close DB sync & auto-archive, disable all controls).
      // 初始化门禁未通过时整行（含「启用」）一并禁用。
      const controls: Array<HTMLInputElement | HTMLButtonElement> = [];
      const setRowDisabled = (disabled: boolean) => {
        if (disabled) row.addClass('is-disabled');
        else row.removeClass('is-disabled');
        for (const el of controls) {
          el.disabled = disabled;
          // 为包含 disabled 控件的 td 添加置灰样式
          const td = el.closest('td');
          if (td) {
            if (disabled) {
              td.addClass('is-disabled');
            } else {
              td.removeClass('is-disabled');
            }
          }
        }
      };

      row.createEl('td', { text: label });

      // 启用（v6-5 起按模块独立生效；当前会合并写回 taskPanel/legacy.task 作为统一入口）
      {
        const td = row.createEl('td');
        const cb = td.createEl('input', { type: 'checkbox' });
        cb.checked = modGateOpen ? savedEnabled : false;
        cb.disabled = !modGateOpen;
        cb.onchange = async () => {
          if (!modGateOpen) return;
          const wasEnabled = (me2[v2Key] === undefined ? true : !!me2[v2Key]);
          const nowEnabled = !!cb.checked;
          me2[v2Key] = cb.checked;

          // Policy B: module off => force-close DB sync & auto-archive for this module.
          if (!cb.checked) {
            p2.enableDbSync = false;
            p2.autoArchiveEnabled = false;
          }

          syncTaskUnifiedFromV2();
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          
          // 更新当前空间的 settingsSnapshot，确保 Hub 能获取到最新的模块启用状态
          await this.updateCurrentSpaceSnapshot();
          
          this.display();
          this.plugin.refreshSidePanel();

          // Auto rebuild when module is turned ON
          if (!wasEnabled && nowEnabled) {
            await triggerRebuildOnEnable(v2Key as any);
          }
        };
      }

      // 数据库同步（从「模块与数据库同步」移入模块管理；非全局，按模块配置）
      {
        const td = row.createEl('td');
        td.setAttribute('data-rslatte-db-sync-td', '1');
        const cb = td.createEl('input', { type: 'checkbox' });
        const dbSyncVal = p2.enableDbSync === undefined ? true : !!p2.enableDbSync;
        cb.checked = dbSyncVal;
        cb.disabled = !enabled || !urlCheckable;
        if (cb.disabled) td.addClass('is-disabled');
        cb.onchange = async () => {
          if (!urlCheckable || !enabled) return;
          const prev = p2.enableDbSync === undefined ? true : !!p2.enableDbSync;
          p2.enableDbSync = !!cb.checked;
          syncTaskUnifiedFromV2();
          if (prev === false && !!cb.checked) handleDbSyncToggleOn(v2Key, label);
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          this.display();
        };
      }

      // 自动归档（每日一次）
      {
        const td = row.createEl('td');
        const cb = td.createEl('input', { type: 'checkbox' });
        cb.checked = !!p2.autoArchiveEnabled;
        cb.disabled = !enabled;
        if (cb.disabled) td.addClass('is-disabled');
        controls.push(cb);
        cb.onchange = async () => {
          p2.autoArchiveEnabled = cb.checked;
          syncTaskUnifiedFromV2();
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          this.display();
        };
      }

      // 归档阈值（天）
      {
        const td = row.createEl('td');
        const input = td.createEl('input', { type: 'number' });
        (input as HTMLInputElement).min = String(MIN_ARCHIVE_THRESHOLD_DAYS);
        (input as HTMLInputElement).max = '3650';
        (input as HTMLInputElement).style.width = '90px';
        (input as HTMLInputElement).value = String(p2.archiveThresholdDays ?? 90);
        (input as HTMLInputElement).disabled = !enabled;
        if ((input as HTMLInputElement).disabled) td.addClass('is-disabled');
        controls.push(input as HTMLInputElement);
        input.onchange = async () => {
          const n = noticeAndNormalizeArchiveThresholdInput(input as HTMLInputElement);
          p2.archiveThresholdDays = n;
          syncTaskUnifiedFromV2();
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          this.display();
        };
      }

      // 手动归档（当前仍合并执行 taskRSLatte.archiveNow）
      {
        const td = row.createEl('td');
        const btn = td.createEl('button', { text: '立即归档' });
        btn.addClass('mod-cta');
        controls.push(btn);
        btn.onclick = async () => {
          const kind = "手动归档";
          console.log(`[RSLatte][${kind}][${label}] 开始`);
          const t0 = Date.now();
          try {
            btn.disabled = true;
            const r = await this.plugin.taskRSLatte.archiveNow(v2Key === "task" ? { task: true } : { memo: true });
            new Notice(`${kind}完成：${label}（归档 ${r.archivedCount} 条，<= ${r.cutoffDate}）`);
          } catch (e: any) {
            new Notice(`${kind}失败：${e?.message ?? String(e)}`);
          } finally {
            console.log(`[RSLatte][${kind}][${label}] 结束 (${Date.now() - t0}ms)`);
            btn.disabled = false;
            this.plugin.refreshSidePanel();
          }
        };
      }

      // 扫描重建索引（当前仍合并执行 taskRSLatte.refreshIndexAndSync(forceFullSync)）
      {
        const td = row.createEl('td');
        const btn = td.createEl('button', { text: '扫描重建' });
        btn.addClass('mod-cta');
        controls.push(btn);
        btn.onclick = async () => {
          try {
            btn.disabled = true;
            // ✅ 空间隔离：使用当前空间的 SpaceCtx
            const ctx = this.plugin.getSpaceCtx();
            const r = await this.plugin.pipelineEngine.runE2(ctx, v2Key as any, "rebuild");
            if (!r.ok) {
              new Notice(`扫描重建失败：${r.error.message}`);
              return;
            }
            if (r.data.skipped) return;

            new Notice(`已扫描并重建索引：${label}`);
          } catch (e: any) {
            new Notice(`扫描重建失败：${e?.message ?? String(e)}`);
          } finally {
            btn.disabled = false;
            this.plugin.refreshSidePanel();
          }
        };
      }

      // Apply disabled state to all non-enable controls when module is off.
      // The "启用" checkbox is intentionally NOT included in the disabled controls list.
      setRowDisabled(!enabled);
    };

    // 首次进入设置页时也做一次兼容写回，保证显示/运行保持一致
    syncTaskUnifiedFromV2();

    renderTaskMemoV2Row('任务', 'task', 'taskModule');
    renderTaskMemoV2Row('提醒', 'memo', 'memoModule');

    const renderScheduleV2Row = () => {
      ensureTaskMemoV2Defaults();
      const row = modTbody.createEl('tr');
      const me2: any = sAny.moduleEnabledV2;
      const p2: any = sAny.scheduleModule;
      const savedEnabled = (me2.schedule === undefined ? true : !!me2.schedule);
      const enabled = modGateOpen && savedEnabled;
      if (!enabled) row.addClass('is-disabled');

      const controls: Array<HTMLInputElement | HTMLButtonElement> = [];
      const setRowDisabled = (disabled: boolean) => {
        if (disabled) row.addClass('is-disabled');
        else row.removeClass('is-disabled');
        for (const el of controls) {
          el.disabled = disabled;
          const td = el.closest('td');
          if (td) {
            if (disabled) td.addClass('is-disabled');
            else td.removeClass('is-disabled');
          }
        }
      };

      row.createEl('td', { text: '日程' });
      {
        const td = row.createEl('td');
        const cb = td.createEl('input', { type: 'checkbox' });
        cb.checked = modGateOpen ? savedEnabled : false;
        cb.disabled = !modGateOpen;
        cb.onchange = async () => {
          if (!modGateOpen) return;
          const wasEnabled = (me2.schedule === undefined ? true : !!me2.schedule);
          const nowEnabled = !!cb.checked;
          me2.schedule = nowEnabled;
          if (!cb.checked) {
            p2.enableDbSync = false;
            p2.autoArchiveEnabled = false;
          }
          syncTaskUnifiedFromV2();
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          await this.updateCurrentSpaceSnapshot();
          this.display();
          this.plugin.refreshSidePanel();
          if (!wasEnabled && nowEnabled) {
            await triggerRebuildOnEnable('schedule');
          }
        };
      }
      {
        const td = row.createEl('td');
        td.setAttribute('data-rslatte-db-sync-td', '1');
        const cb = td.createEl('input', { type: 'checkbox' });
        const dbSyncVal = p2.enableDbSync === undefined ? true : !!p2.enableDbSync;
        cb.checked = dbSyncVal;
        cb.disabled = !enabled || !urlCheckable;
        if (cb.disabled) td.addClass('is-disabled');
        cb.onchange = async () => {
          if (!urlCheckable || !enabled) return;
          const prev = p2.enableDbSync === undefined ? true : !!p2.enableDbSync;
          p2.enableDbSync = !!cb.checked;
          syncTaskUnifiedFromV2();
          if (prev === false && !!cb.checked) handleDbSyncToggleOn('schedule', '日程');
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          this.display();
        };
      }
      {
        const td = row.createEl('td');
        const cb = td.createEl('input', { type: 'checkbox' });
        cb.checked = !!p2.autoArchiveEnabled;
        controls.push(cb);
        cb.onchange = async () => {
          p2.autoArchiveEnabled = cb.checked;
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          this.display();
        };
      }
      {
        const td = row.createEl('td');
        const input = td.createEl('input', { type: 'number' });
        (input as HTMLInputElement).min = String(MIN_ARCHIVE_THRESHOLD_DAYS);
        (input as HTMLInputElement).max = '3650';
        (input as HTMLInputElement).style.width = '90px';
        (input as HTMLInputElement).value = String(p2.archiveThresholdDays ?? 90);
        controls.push(input as HTMLInputElement);
        input.onchange = async () => {
          const n = noticeAndNormalizeArchiveThresholdInput(input as HTMLInputElement);
          p2.archiveThresholdDays = n;
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          this.display();
        };
      }
      {
        const td = row.createEl('td');
        const btn = td.createEl('button', { text: '立即归档' });
        btn.addClass('mod-cta');
        controls.push(btn);
        btn.onclick = async () => {
          try {
            btn.disabled = true;
            const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "schedule" as any, "manual_archive");
            if (!r.ok) {
              new Notice(`日程归档失败：${r.error.message}`);
              return;
            }
            new Notice("日程归档已执行");
          } finally {
            btn.disabled = false;
            this.plugin.refreshSidePanel();
          }
        };
      }
      {
        const td = row.createEl('td');
        const btn = td.createEl('button', { text: '扫描重建' });
        btn.addClass('mod-cta');
        controls.push(btn);
        btn.onclick = async () => {
          try {
            btn.disabled = true;
            const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "schedule" as any, "rebuild");
            if (!r.ok) {
              new Notice(`扫描重建失败：${r.error.message}`);
              return;
            }
            new Notice("已扫描并重建索引：日程");
          } finally {
            btn.disabled = false;
            this.plugin.refreshSidePanel();
          }
        };
      }
      setRowDisabled(!enabled);
    };
    renderScheduleV2Row();

    // 项目管理（v2：模块开关与侧边栏一致；关闭模块时强制关闭 DB sync / 自动归档）
    const renderProjectV2Row = () => {
      const row = modTbody.createEl('tr');
      const me2: any = sAny.moduleEnabledV2;
      const savedEnabled = (me2.project === undefined ? true : !!me2.project);
      const enabled = modGateOpen && savedEnabled;
      if (!enabled) row.addClass('is-disabled');

      const get = () => ({
        enableDbSync: (sAny.projectEnableDbSync === undefined ? true : !!sAny.projectEnableDbSync),
        autoArchiveEnabled: (sAny.projectAutoArchiveEnabled === undefined ? true : !!sAny.projectAutoArchiveEnabled),
        archiveThresholdDays: (sAny.projectArchiveThresholdDays ?? 90),
      });

      const set = (patch: any) => {
        if (patch.enableDbSync !== undefined) sAny.projectEnableDbSync = !!patch.enableDbSync;
        if (patch.autoArchiveEnabled !== undefined) sAny.projectAutoArchiveEnabled = !!patch.autoArchiveEnabled;
        if (patch.archiveThresholdDays !== undefined) sAny.projectArchiveThresholdDays = patch.archiveThresholdDays;
      };

      const setRowDisabled = (disabled: boolean) => {
        const tds = Array.from(row.children) as HTMLElement[];
        for (let i = 2; i < tds.length; i++) {
          if (tds[i].hasAttribute('data-rslatte-db-sync-td')) {
            // 数据库同步列：根据 disabled 和 urlCheckable 更新状态
            const cb = tds[i].querySelector('input[type="checkbox"]') as HTMLInputElement;
            if (cb) {
              cb.disabled = disabled || !urlCheckable;
              if (cb.disabled) {
                tds[i].addClass('is-disabled');
              } else {
                tds[i].removeClass('is-disabled');
              }
            }
            continue;
          }
          // 更新所有控件的 disabled 状态
          const hasDisabled = tds[i].querySelectorAll('input,button,select,textarea').length > 0;
          tds[i].querySelectorAll('input,button,select,textarea').forEach((el) => {
            (el as any).disabled = disabled;
          });
          // 为包含 disabled 控件的 td 添加置灰样式
          if (hasDisabled) {
            if (disabled) {
              tds[i].addClass('is-disabled');
            } else {
              tds[i].removeClass('is-disabled');
            }
          }
        }
      };

      {
        const nameTd = row.createEl("td", { text: "项目" });
        nameTd.title =
          "项目归档顺序：先笔记归档（移动项目文件夹到归档目录），再索引归档（主索引条目迁入 archive 分片）；一次「立即归档」或自动归档会连续做完两步。";
      }

      // 启用（v2）
      {
        const td = row.createEl('td');
        const cb = td.createEl('input', { type: 'checkbox' });
        cb.checked = modGateOpen ? savedEnabled : false;
        cb.disabled = !modGateOpen;
        cb.onchange = async () => {
          if (!modGateOpen) return;
          const wasEnabled = (me2.project === undefined ? true : !!me2.project);
          const nowEnabled = !!cb.checked;
          me2.project = cb.checked;
          // B：关闭模块时强制关闭 DB sync / 自动归档
          if (!cb.checked) {
            sAny.projectEnableDbSync = false;
            sAny.projectAutoArchiveEnabled = false;
          }
          // legacy 兼容写回（旧逻辑仍可能读取 moduleEnabled.project）
          setModEnabled('project', !!cb.checked);
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          
          // 更新当前空间的 settingsSnapshot，确保 Hub 能获取到最新的模块启用状态
          await this.updateCurrentSpaceSnapshot();
          
          this.display();
          this.plugin.refreshSidePanel();

          // Auto rebuild when module is turned ON
          if (!wasEnabled && nowEnabled) {
            await triggerRebuildOnEnable('project');
          }
        };
      }

      // 数据库同步（从「模块与数据库同步」移入模块管理；非全局，按模块配置）
      {
        const td = row.createEl('td');
        td.setAttribute('data-rslatte-db-sync-td', '1');
        const cb = td.createEl('input', { type: 'checkbox' });
        cb.checked = !!get().enableDbSync;
        cb.disabled = !enabled || !urlCheckable;
        if (cb.disabled) td.addClass('is-disabled');
        cb.onchange = async () => {
          if (!urlCheckable || !enabled) return;
          const prev = !!get().enableDbSync;
          set({ enableDbSync: !!cb.checked });
          if (prev === false && !!cb.checked) handleDbSyncToggleOn('project', '项目');
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          this.display();
        };
      }

      // 自动归档（每日一次）
      {
        const td = row.createEl('td');
        const cb = td.createEl('input', { type: 'checkbox' });
        cb.checked = !!get().autoArchiveEnabled;
        cb.disabled = !enabled;
        cb.onchange = async () => {
          set({ autoArchiveEnabled: cb.checked });
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          this.display();
        };
      }

      // 归档阈值（天）
      {
        const td = row.createEl('td');
        const input = td.createEl('input', { type: 'number' });
        (input as HTMLInputElement).min = String(MIN_ARCHIVE_THRESHOLD_DAYS);
        (input as HTMLInputElement).max = '3650';
        (input as HTMLInputElement).style.width = '90px';
        (input as HTMLInputElement).value = String(get().archiveThresholdDays ?? 90);
        (input as HTMLInputElement).disabled = !enabled;
        input.onchange = async () => {
          const n = noticeAndNormalizeArchiveThresholdInput(input as HTMLInputElement);
          set({ archiveThresholdDays: n });
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          this.display();
        };
      }

      // 手动归档
      {
        const td = row.createEl('td');
        const btn = td.createEl('button', { text: '立即归档' });
        btn.addClass('mod-cta');
        btn.disabled = !enabled;
        btn.onclick = async () => {
          try {
            btn.disabled = true;
            new Notice("开始项目归档（笔记+索引）…");
            // ✅ 空间隔离：使用当前空间的 SpaceCtx
            const ctx = this.plugin.getSpaceCtx();
            const r = await this.plugin.pipelineEngine.runE2(ctx, 'project' as any, 'manual_archive');
            if (!r.ok) {
              new Notice(`归档失败：${r.error.message}（module=project, mode=manual_archive）`);
              console.warn('[RSLatte][ui] manual archive failed', { moduleKey: 'project', mode: 'manual_archive', error: r.error });
              return;
            }
            if (r.data.skipped) return;

            const ui = normalizeRunSummaryForUi(r.data);
            const n = Number(ui.archivedCount ?? 0);
            const runId = (r.data as any).runId ? ` (${(r.data as any).runId})` : '';
            new Notice(n > 0 ? `已归档 ${n} 个项目${runId}` : `无可归档项目${runId}`);
          } catch (e: any) {
            new Notice(`归档失败：${e?.message ?? String(e)}（module=project, mode=manual_archive）`);
          } finally {
            btn.disabled = !enabled;
            this.plugin.refreshSidePanel();
          }
        };
      }

      // 扫描重建索引
      {
        const td = row.createEl('td');
        const btn = td.createEl('button', { text: '扫描重建' });
        btn.addClass('mod-cta');
        btn.disabled = !enabled;
        btn.onclick = async () => {
          try {
            btn.disabled = true;
            new Notice('开始扫描重建：项目…');
            // ✅ 空间隔离：使用当前空间的 SpaceCtx
            const ctx = this.plugin.getSpaceCtx();
            const r = await this.plugin.pipelineEngine.runE2(ctx, 'project' as any, 'rebuild');
            if (!r.ok) {
              new Notice(`扫描重建失败：${r.error.message}（module=project, mode=rebuild）`);
              console.warn('[RSLatte][ui] rebuild failed', { moduleKey: 'project', mode: 'rebuild', error: r.error });
              return;
            }
            if (r.data.skipped) return;

            const runId = (r.data as any).runId ? ` (${(r.data as any).runId})` : '';
            new Notice(`已扫描并重建项目索引${runId}`);
          } catch (e: any) {
            new Notice(`扫描重建失败：${e?.message ?? String(e)}（module=project, mode=rebuild）`);
          } finally {
            btn.disabled = !enabled;
            this.plugin.refreshSidePanel();
          }
        };
      }

      setRowDisabled(!enabled);
    };

    renderProjectV2Row();


    
    // 输出管理（v2：模块开关与侧边栏一致；关闭模块时强制关闭 DB sync / 自动归档）
    const renderOutputV2Row = () => {
      const row = modTbody.createEl('tr');
      const me2: any = sAny.moduleEnabledV2;
      const savedEnabled = (me2.output === undefined ? true : !!me2.output);
      const enabled = modGateOpen && savedEnabled;
      if (!enabled) row.addClass('is-disabled');

      const get = () => {
        const op: any = sAny.outputPanel ?? {};
        return {
          enableDbSync: (op.enableDbSync === undefined ? true : !!op.enableDbSync),
          autoArchiveEnabled: !!op.autoArchiveEnabled,
          archiveThresholdDays: op.archiveThresholdDays ?? 90,
        };
      };

      const set = (patch: any) => {
        if (!sAny.outputPanel) sAny.outputPanel = {};
        if (patch.enableDbSync !== undefined) sAny.outputPanel.enableDbSync = !!patch.enableDbSync;
        if (patch.autoArchiveEnabled !== undefined) sAny.outputPanel.autoArchiveEnabled = !!patch.autoArchiveEnabled;
        if (patch.archiveThresholdDays !== undefined) sAny.outputPanel.archiveThresholdDays = patch.archiveThresholdDays;
      };

      const setRowDisabled = (disabled: boolean) => {
        const tds = Array.from(row.children) as HTMLElement[];
        for (let i = 2; i < tds.length; i++) {
          if (tds[i].hasAttribute('data-rslatte-db-sync-td')) {
            // 数据库同步列：根据 disabled 和 urlCheckable 更新状态
            const cb = tds[i].querySelector('input[type="checkbox"]') as HTMLInputElement;
            if (cb) {
              cb.disabled = disabled || !urlCheckable;
              if (cb.disabled) {
                tds[i].addClass('is-disabled');
              } else {
                tds[i].removeClass('is-disabled');
              }
            }
            continue;
          }
          // 更新所有控件的 disabled 状态
          const hasDisabled = tds[i].querySelectorAll('input,button,select,textarea').length > 0;
          tds[i].querySelectorAll('input,button,select,textarea').forEach((el) => {
            (el as any).disabled = disabled;
          });
          // 为包含 disabled 控件的 td 添加置灰样式
          if (hasDisabled) {
            if (disabled) {
              tds[i].addClass('is-disabled');
            } else {
              tds[i].removeClass('is-disabled');
            }
          }
        }
      };

      row.createEl('td', { text: '输出' });

      // 启用（v2）
      {
        const td = row.createEl('td');
        const cb = td.createEl('input', { type: 'checkbox' });
        cb.checked = modGateOpen ? savedEnabled : false;
        cb.disabled = !modGateOpen;
        cb.onchange = async () => {
          if (!modGateOpen) return;
          const wasEnabled = (me2.output === undefined ? true : !!me2.output);
          const nowEnabled = !!cb.checked;
          me2.output = cb.checked;
          // B：关闭模块时强制关闭 DB sync / 自动归档
          if (!cb.checked) {
            if (!sAny.outputPanel) sAny.outputPanel = {};
            sAny.outputPanel.enableDbSync = false;
            sAny.outputPanel.autoArchiveEnabled = false;
          }
          // legacy 兼容写回（旧逻辑仍可能读取 moduleEnabled.output）
          setModEnabled('output', !!cb.checked);

          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          
          // 更新当前空间的 settingsSnapshot，确保 Hub 能获取到最新的模块启用状态
          await this.updateCurrentSpaceSnapshot();
          
          this.display();
          this.plugin.refreshSidePanel();

          // Auto rebuild when module is turned ON
          if (!wasEnabled && nowEnabled) {
            await triggerRebuildOnEnable('output');
          }
        };
      }

      // 数据库同步（从「模块与数据库同步」移入模块管理；非全局，按模块配置）
      {
        const td = row.createEl('td');
        td.setAttribute('data-rslatte-db-sync-td', '1');
        const cb = td.createEl('input', { type: 'checkbox' });
        cb.checked = !!get().enableDbSync;
        cb.disabled = !enabled || !urlCheckable;
        if (cb.disabled) td.addClass('is-disabled');
        cb.onchange = async () => {
          if (!urlCheckable || !enabled) return;
          const prev = !!get().enableDbSync;
          set({ enableDbSync: !!cb.checked });
          if (prev === false && !!cb.checked) handleDbSyncToggleOn('output', '输出');
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          this.display();
        };
      }

      // 自动归档（每日一次）
      {
        const td = row.createEl('td');
        const cb = td.createEl('input', { type: 'checkbox' });
        cb.checked = !!get().autoArchiveEnabled;
        cb.disabled = !enabled;
        cb.onchange = async () => {
          set({ autoArchiveEnabled: cb.checked });
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          this.display();
        };
      }

      // 归档阈值（天）
      {
        const td = row.createEl('td');
        const input = td.createEl('input', { type: 'number' });
        (input as HTMLInputElement).min = String(MIN_ARCHIVE_THRESHOLD_DAYS);
        (input as HTMLInputElement).max = '3650';
        (input as HTMLInputElement).style.width = '90px';
        (input as HTMLInputElement).value = String(get().archiveThresholdDays ?? 90);
        (input as HTMLInputElement).disabled = !enabled;
        input.onchange = async () => {
          const n = noticeAndNormalizeArchiveThresholdInput(input as HTMLInputElement);
          set({ archiveThresholdDays: n });
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          this.display();
        };
      }

      // 手动归档
      {
        const td = row.createEl('td');
        const btn = td.createEl('button', { text: '立即归档' });
        btn.addClass('mod-cta');
        btn.disabled = !enabled;
        btn.onclick = async () => {
          try {
            btn.disabled = true;
            new Notice("开始输出归档（笔记+索引条目）…");
            // ✅ 空间隔离：使用当前空间的 SpaceCtx
            const ctx = this.plugin.getSpaceCtx();
            const r = await this.plugin.pipelineEngine.runE2(ctx, 'output' as any, 'manual_archive');
            if (!r.ok) {
              new Notice(`归档失败：${r.error.message}（module=output, mode=manual_archive）`);
              console.warn('[RSLatte][ui] manual archive failed', { moduleKey: 'output', mode: 'manual_archive', error: r.error });
              return;
            }
            if (r.data.skipped) return;

            const ui = normalizeRunSummaryForUi(r.data);
            const n = Number(ui.archivedCount ?? 0);
            const runId = (r.data as any).runId ? ` (${(r.data as any).runId})` : '';
            new Notice(n > 0 ? `输出已归档：${n} 项${runId}` : `输出无可归档项${runId}`);
          } catch (e: any) {
            new Notice(`归档失败：${e?.message ?? String(e)}（module=output, mode=manual_archive）`);
          } finally {
            btn.disabled = !enabled;
            this.plugin.refreshSidePanel();
          }
        };
      }

      // 扫描重建索引
      {
        const td = row.createEl('td');
        const btn = td.createEl('button', { text: '扫描重建' });
        btn.addClass('mod-cta');
        btn.disabled = !enabled;
        btn.onclick = async () => {
          try {
            btn.disabled = true;
            new Notice('开始扫描重建：输出…');
            // ✅ 空间隔离：使用当前空间的 SpaceCtx
            const ctx = this.plugin.getSpaceCtx();
            const r = await this.plugin.pipelineEngine.runE2(ctx, 'output' as any, 'rebuild');
            if (!r.ok) {
              new Notice(`扫描重建失败：${r.error.message}（module=output, mode=rebuild）`);
              console.warn('[RSLatte][ui] rebuild failed', { moduleKey: 'output', mode: 'rebuild', error: r.error });
              return;
            }
            if (r.data.skipped) return;

            const runId = (r.data as any).runId ? ` (${(r.data as any).runId})` : '';
            new Notice(`已扫描并重建输出索引${runId}`);
          } catch (e: any) {
            new Notice(`扫描重建失败：${e?.message ?? String(e)}（module=output, mode=rebuild）`);
          } finally {
            btn.disabled = !enabled;
            this.plugin.refreshSidePanel();
          }
        };
      }

      setRowDisabled(!enabled);
    };

    renderOutputV2Row();

    // 联系人管理（vC1：仅骨架；默认关闭）
    const renderContactsV2Row = () => {
      const row = modTbody.createEl('tr');
      const me2: any = (sAny.moduleEnabledV2 ?? (sAny.moduleEnabledV2 = {}));
      const savedEnabled = (me2.contacts === true);
      const enabled = modGateOpen && savedEnabled;
      if (!enabled) row.addClass('is-disabled');

      const get = () => {
        const cm: any = sAny.contactsModule ?? {};
        return {
          enableDbSync: !!cm.enableDbSync,
          autoArchiveEnabled: !!cm.autoArchiveEnabled,
          archiveThresholdDays: cm.archiveThresholdDays ?? 90,
        };
      };

      const set = (patch: any) => {
        if (!sAny.contactsModule) sAny.contactsModule = {};
        if (patch.enableDbSync !== undefined) sAny.contactsModule.enableDbSync = !!patch.enableDbSync;
        if (patch.autoArchiveEnabled !== undefined) sAny.contactsModule.autoArchiveEnabled = !!patch.autoArchiveEnabled;
        if (patch.archiveThresholdDays !== undefined) sAny.contactsModule.archiveThresholdDays = patch.archiveThresholdDays;
      };

      const setRowDisabled = (disabled: boolean) => {
        const tds = Array.from(row.children) as HTMLElement[];
        for (let i = 2; i < tds.length; i++) {
          if (tds[i].hasAttribute('data-rslatte-db-sync-td')) {
            // 数据库同步列：根据 disabled 和 urlCheckable 更新状态
            const cb = tds[i].querySelector('input[type="checkbox"]') as HTMLInputElement;
            if (cb) {
              cb.disabled = disabled || !urlCheckable;
              if (cb.disabled) {
                tds[i].addClass('is-disabled');
              } else {
                tds[i].removeClass('is-disabled');
              }
            }
            continue;
          }
          // 更新所有控件的 disabled 状态
          const hasDisabled = tds[i].querySelectorAll('input,button,select,textarea').length > 0;
          tds[i].querySelectorAll('input,button,select,textarea').forEach((el) => {
            (el as any).disabled = disabled;
          });
          // 为包含 disabled 控件的 td 添加置灰样式
          if (hasDisabled) {
            if (disabled) {
              tds[i].addClass('is-disabled');
            } else {
              tds[i].removeClass('is-disabled');
            }
          }
        }
      };

      row.createEl('td', { text: '联系人' });

      // 启用（v2）
      {
        const td = row.createEl('td');
        const cb = td.createEl('input', { type: 'checkbox' });
        cb.checked = modGateOpen ? savedEnabled : false;
        cb.disabled = !modGateOpen;
        cb.onchange = async () => {
          if (!modGateOpen) return;
          const wasEnabled = me2.contacts === true;
          const nowEnabled = !!cb.checked;
          me2.contacts = cb.checked;

          // 关闭模块时强制关闭 DB sync / 自动归档
          // 注意：不再关闭侧边栏，保持侧边栏打开并显示"联系人模块未启用"提示
          if (!cb.checked) {
            set({ enableDbSync: false, autoArchiveEnabled: false });
          } else {
            this.plugin.ensureContactsPanelRegistered();
            // 在设置页里直接激活右侧 Contacts 视图会导致 Obsidian 设置页被关闭/失焦。
            // 用户仍可通过侧边栏按钮或命令面板手动打开 Contacts 视图。
          }

          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          
          // 更新当前空间的 settingsSnapshot，确保 Hub 能获取到最新的模块启用状态
          await this.updateCurrentSpaceSnapshot();
          
          this.display();
          this.plugin.refreshSidePanel();

          // Contacts 尚未接入 pipeline，无需 auto rebuild
          if (!wasEnabled && nowEnabled) {
            new Notice('Contacts 已启用（Step C1：侧边栏为占位展示）。');
          }
        };
      }

      // 数据库同步（从「模块与数据库同步」移入模块管理；非全局，按模块配置；联系人无 manual_refresh）
      {
        const td = row.createEl('td');
        td.setAttribute('data-rslatte-db-sync-td', '1');
        const cb = td.createEl('input', { type: 'checkbox' });
        cb.checked = !!get().enableDbSync;
        cb.disabled = !enabled || !urlCheckable;
        if (cb.disabled) td.addClass('is-disabled');
        cb.onchange = async () => {
          if (!urlCheckable || !enabled) return;
          set({ enableDbSync: !!cb.checked });
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          this.display();
        };
      }

      // 自动归档（占位）
      {
        const td = row.createEl('td');
        const cb = td.createEl('input', { type: 'checkbox' });
        cb.checked = !!get().autoArchiveEnabled;
        cb.disabled = !enabled;
        cb.onchange = async () => {
          set({ autoArchiveEnabled: cb.checked });
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          this.display();
        };
      }

      // 归档阈值（天）（占位）
      {
        const td = row.createEl('td');
        const input = td.createEl('input', { type: 'number' });
        (input as HTMLInputElement).min = String(MIN_ARCHIVE_THRESHOLD_DAYS);
        (input as HTMLInputElement).max = '3650';
        (input as HTMLInputElement).style.width = '90px';
        (input as HTMLInputElement).value = String(get().archiveThresholdDays ?? 90);
        (input as HTMLInputElement).disabled = !enabled;
        input.onchange = async () => {
          const n = noticeAndNormalizeArchiveThresholdInput(input as HTMLInputElement);
          set({ archiveThresholdDays: n });
          const ok = await this.plugin.saveSettings();
          if (!ok) return;
          this.display();
        };
      }

      // 手动归档（挂钩：C6 实现）
      {
        const td = row.createEl('td');
        const btn = td.createEl('button', { text: '立即归档' });
        btn.addClass('mod-cta');
        btn.disabled = !enabled;
        btn.onclick = async () => {
          try {
            btn.disabled = true;
            new Notice("开始联系人笔记归档…");

            const r = await this.plugin.archiveContactsNow({ reason: 'manual' });
            // archiveContactsNow already shows a notice; here we just refresh UI
            if ((r?.moved ?? 0) === 0) {
              new Notice('没有满足阈值的联系人需要归档。');
            }
          } catch (e: any) {
            new Notice(`Contacts 归档失败：${e?.message ?? String(e)}`);
          } finally {
            btn.disabled = !enabled;
            this.plugin.refreshSidePanel();
          }
        };
      }

      // 扫描重建索引（C2）
      {
        const td = row.createEl('td');
        const btn = td.createEl('button', { text: '扫描重建' });
        btn.addClass('mod-cta');
        btn.disabled = !enabled;
        btn.onclick = async () => {
          try {
            btn.disabled = true;
            new Notice('开始扫描重建：联系人…');

            const r: any = await this.plugin.rebuildContactsIndex();
            if (!r?.ok) {
              new Notice(`扫描重建失败：${r?.error?.message ?? String(r?.error ?? 'unknown')}（module=contacts, mode=rebuild）`);
              console.warn('[RSLatte][ui] contacts rebuild failed', { error: r?.error });
              return;
            }

            const errCnt = (r.parseErrorFiles ?? []).length;
            const msg =
              errCnt > 0
                ? `已扫描并重建联系人索引（${r.count} 条，解析失败 ${errCnt}）`
                : `已扫描并重建联系人索引（${r.count} 条）`;
            new Notice(msg);
          } catch (e: any) {
            new Notice(`扫描重建失败：${e?.message ?? String(e)}（module=contacts, mode=rebuild）`);
          } finally {
            btn.disabled = !enabled;
            this.plugin.refreshSidePanel();
          }
        };
      }

setRowDisabled(!enabled);
    };

    try {
      renderContactsV2Row();
    } catch (e: any) {
      console.error('[RSLatte][ui] renderContactsV2Row failed', e);
    }

// =========================
    // 日记管理（放在打卡管理之前）
    // =========================
    const journalWrap = makeModuleWrap("journal", "日志管理", "space");

    // ===== 日志追加清单（按模块） =====
    journalWrap.createEl("h3", { text: "日志追加清单" });
    journalWrap.createEl("div", {
      cls: "rslatte-setting-hint",
      text: "配置各模块写入今日日记的位置：一级目录（H1）+ 二级目录（H2）。打卡/财务/健康/任务/提醒/日程为强制启用（长期写入日记）；项目/输出可按需开启。",
    });

    if (!this.plugin.settings.journalAppendRules) this.plugin.settings.journalAppendRules = [];
    const journalAppendForceEnabled = new Set(["checkin", "finance", "health", "task", "memo", "schedule"]);
    let journalAppendForceNeedsPersist = false;
    const ensureRule = (module: any, d: any) => {
      const arr: any[] = this.plugin.settings.journalAppendRules as any;
      let r = arr.find((x) => x.module === module);
      if (!r) {
        arr.push({ module, enabled: d.enabled, h1: d.h1, h2: d.h2 });
        return;
      }
      if (journalAppendForceEnabled.has(module)) {
        if (r.enabled !== true) journalAppendForceNeedsPersist = true;
        r.enabled = true;
      } else if (r.enabled === undefined) r.enabled = d.enabled;
      if (!r.h1) r.h1 = d.h1;
      if (!r.h2) r.h2 = d.h2;
    };
    // 补齐模块规则
    ensureRule("checkin", { enabled: true, h1: "# 操作日志", h2: "## 打卡记录" });
    ensureRule("finance", { enabled: true, h1: "# 操作日志", h2: "## 财务记录" });
    ensureRule("task", { enabled: true, h1: "# 任务追踪", h2: "## 新增任务" });
    ensureRule("memo", { enabled: true, h1: "# 任务追踪", h2: "## 新增提醒" });
    ensureRule("schedule", { enabled: true, h1: "# 任务追踪", h2: "## 新增日程" });
    ensureRule("project", { enabled: false, h1: "# 进度更新", h2: "## 项目进度" });
    ensureRule("output", { enabled: false, h1: "# 进度更新", h2: "## 输出进度" });

    if (journalAppendForceNeedsPersist) {
      void this.plugin.saveSettings().catch((e) => {
        console.warn("[RSLatte][settings] persist journalAppendRules forced enabled failed", e);
      });
    }

    const moduleLabel: Record<string, string> = {
      checkin: "打卡",
      finance: "财务记录",
      health: "健康记录",
      task: "任务",
      memo: "提醒",
      schedule: "日程",
      project: "项目（进度汇总）",
      output: "输出（当日变更）",
    };
    const forced = journalAppendForceEnabled;

    const ruleWrap = journalWrap.createDiv({ cls: "rslatte-section" });
    const ruleTable = ruleWrap.createEl("table", { cls: "rslatte-tasklist-table" });
    const ruleThead = ruleTable.createEl("thead");
    const ruleHr = ruleThead.createEl("tr");
    ["模块功能", "是否追加", "记录追加一级目录（H1）", "数据存放二级目录（H2）"].forEach((h) => ruleHr.createEl("th", { text: h }));
    const ruleTbody = ruleTable.createEl("tbody");

    const normalizeH = (raw: string, level: 1 | 2) => {
      const t = (raw ?? "").trim().replace(/^#+\s*/, "");
      if (!t) return level === 1 ? "# " : "## ";
      return level === 1 ? `# ${t}` : `## ${t}`;
    };

    const rules = (this.plugin.settings.journalAppendRules as any[])
      .slice()
      .sort((a, b) => {
        const order = ["checkin", "finance", "health", "task", "memo", "schedule", "project", "output"];
        return order.indexOf(a.module) - order.indexOf(b.module);
      });

    rules.forEach((r) => {
      const tr = ruleTbody.createEl("tr");
      tr.createEl("td", { text: moduleLabel[r.module] ?? String(r.module) });

      // 是否追加
      {
        const td = tr.createEl("td");
        const cb = td.createEl("input", { type: "checkbox" });
        const isForced = forced.has(r.module);
        cb.checked = isForced ? true : !!r.enabled;
        cb.disabled = isForced;
        cb.onchange = async () => {
          r.enabled = !!cb.checked;
          await this.saveAndRefreshSidePanelDebounced();
        };
      }

      // H1
      {
        const td = tr.createEl("td");
        const inp = td.createEl("input", { type: "text" });
        inp.value = r.h1 ?? "";
        inp.onchange = async () => {
          r.h1 = normalizeH(inp.value, 1);
          inp.value = r.h1;
          await this.saveAndRefreshSidePanelDebounced();
        };
      }

      // H2
      {
        const td = tr.createEl("td");
        const inp = td.createEl("input", { type: "text" });
        inp.value = r.h2 ?? "";
        inp.onchange = async () => {
          r.h2 = normalizeH(inp.value, 2);
          inp.value = r.h2;
          await this.saveAndRefreshSidePanelDebounced();
        };
      }
    });

    // ===== 日记模板配置（保持不变） =====
    journalWrap.createEl("h3", { text: "日记模板配置" });
    
    // 辅助函数：检查模板文件是否存在（与 `journalService.readTemplateContent` 一致：无 .md 时补 .md 再测）
    const checkTemplateExists = async (templatePath: string): Promise<boolean> => {
      const raw = String(templatePath ?? "").trim();
      if (!raw) return false;
      try {
        const candidates: string[] = [];
        candidates.push(normalizePath(raw));
        if (!/\.md$/i.test(raw)) candidates.push(normalizePath(`${raw}.md`));
        for (const p of candidates) {
          if (await this.app.vault.adapter.exists(p)) return true;
          const af = this.app.vault.getAbstractFileByPath(p);
          if (af instanceof TFile) return true;
        }
        return false;
      } catch {
        return false;
      }
    };
    
    // 辅助函数：为模板配置添加存在性检查
    const addTemplateCheck = (setting: Setting, templatePathGetter: () => string) => {
      const controlEl = setting.controlEl;
      const statusEl = controlEl.createDiv({ cls: "rslatte-template-status" });
      statusEl.style.marginTop = "4px";
      statusEl.style.fontSize = "12px";
      
      const updateStatus = async () => {
        const templatePath = templatePathGetter();
        if (!templatePath || !templatePath.trim()) {
          statusEl.empty();
          return;
        }
        const exists = await checkTemplateExists(templatePath);
        statusEl.empty();
        if (!exists) {
          const warn = statusEl.createSpan({ cls: "rslatte-template-warning" });
          warn.style.color = "var(--text-error)";
          warn.textContent = "模板文件不存在";
        }
      };
      
      void updateStatus();
      return updateStatus;
    };
    
    const diaryTemplateUpdate = addTemplateCheck(
      new Setting(journalWrap)
        .setName("日记模板")
        .setDesc("当目标日期的日记不存在时，将复制该模板创建新日记，留空则创建空文件。")
        .addText((text) => {
          text
            .setPlaceholder("91-Templates/t_daily.md")
            .setValue(this.plugin.settings.diaryTemplate ?? "")
            .onChange(async (value) => {
              this.plugin.settings.diaryTemplate = (value ?? "").trim();
              await this.saveAndRefreshSidePanelDebounced();
              await diaryTemplateUpdate();
            });
        }),
      () => this.plugin.settings.diaryTemplate ?? ""
    );

    // 辅助函数：检查并创建目录
    const checkAndCreateDir = async (dirPath: string): Promise<boolean> => {
      if (!dirPath || !dirPath.trim()) return false;
      try {
        const normalized = normalizePath(dirPath.trim());
        const exists = await this.app.vault.adapter.exists(normalized);
        if (exists) return true;
        
        // 创建目录（包括所有父目录）
        const parts = normalized.split("/").filter(Boolean);
        let current = "";
        for (const part of parts) {
          current = current ? `${current}/${part}` : part;
          const exists = await this.app.vault.adapter.exists(current);
          if (!exists) {
            await this.app.vault.createFolder(current);
          }
        }
        new Notice(`已创建目录：${normalized}`);
        return true;
      } catch (e: any) {
        new Notice(`创建目录失败：${e?.message ?? String(e)}`);
        return false;
      }
    };

    // 辅助函数：检查目录是否存在
    const checkDirExists = async (dirPath: string): Promise<boolean> => {
      if (!dirPath || !dirPath.trim()) return false;
      try {
        const normalized = normalizePath(dirPath.trim());
        return await this.app.vault.adapter.exists(normalized);
      } catch {
        return false;
      }
    };

    // 辅助函数：为目录配置添加检查和创建按钮
    const addDirCheckButton = (setting: Setting, dirPathGetter: () => string, onCreated?: () => void) => {
      const controlEl = setting.controlEl;
      const statusEl = controlEl.createDiv({ cls: "rslatte-dir-status" });
      statusEl.style.marginTop = "4px";
      statusEl.style.display = "flex";
      statusEl.style.alignItems = "center";
      statusEl.style.gap = "8px";
      
      const updateStatus = async () => {
        const dirPath = dirPathGetter();
        const exists = await checkDirExists(dirPath);
        const warningEl = statusEl.querySelector(".rslatte-dir-warning");
        const btnEl = statusEl.querySelector(".rslatte-dir-create-btn") as HTMLButtonElement;
        
        if (exists) {
          if (warningEl) warningEl.remove();
          if (btnEl) btnEl.style.display = "none";
        } else if (dirPath) {
          if (!warningEl) {
            const warn = statusEl.createDiv({ cls: "rslatte-dir-warning" });
            warn.style.color = "var(--text-error)";
            warn.style.fontSize = "12px";
            warn.textContent = "目录不存在";
            statusEl.insertBefore(warn, btnEl || null);
          }
          if (!btnEl) {
            const btn = statusEl.createEl("button", { cls: "rslatte-dir-create-btn", text: "创建目录" });
            btn.style.fontSize = "12px";
            btn.style.padding = "2px 8px";
            btn.onclick = async () => {
              btn.disabled = true;
              const success = await checkAndCreateDir(dirPathGetter());
              btn.disabled = false;
              if (success) {
                await updateStatus();
                if (onCreated) onCreated();
              }
            };
          } else {
            btnEl.style.display = "inline-block";
          }
        } else {
          if (warningEl) warningEl.remove();
          if (btnEl) btnEl.style.display = "none";
        }
      };
      
      // 初始检查
      void updateStatus();
      
      // 返回更新函数，以便在值改变时调用
      return updateStatus;
    };

    const diaryPathUpdate = addDirCheckButton(
      new Setting(journalWrap)
        .setName("日记路径")
        .setDesc("日记存放目录。打开/写入时会在该目录及其子文件夹中按需查找目标日记。留空表示在整个 vault 中查找。")
        .addText((text) => {
          text
            .setPlaceholder("01-Daily")
            .setValue(this.plugin.settings.diaryPath ?? "")
            .onChange(async (value) => {
              this.plugin.settings.diaryPath = (value ?? "").trim();
              await this.saveAndRefreshSidePanelDebounced();
              await diaryPathUpdate();
            });
        }),
      () => this.plugin.settings.diaryPath ?? ""
    );

    new Setting(journalWrap)
      .setName("日记名称格式")
      .setDesc("moment 格式，不含扩展名。例如：YYYYMMDD。支持包含子目录（如 YYYY/MM/DD）。")
      .addText((text) =>
        text
          .setPlaceholder("YYYYMMDD")
          .setValue(this.plugin.settings.diaryNameFormat ?? "YYYYMMDD")
          .onChange(async (value) => {
            this.plugin.settings.diaryNameFormat = (value ?? "").trim() || "YYYYMMDD";
            await this.saveAndRefreshSidePanelDebounced();
          })
      );

    new Setting(journalWrap)
      .setName("日记按月 · 月目录名")
      .setDesc("「日记按月」：超过阈值的日记文件移入子目录。填写 moment 格式（如 YYYYMM），目标路径为：{{日记路径}}/<月目录>/ 下。与任务/记录等「索引归档」无关。")
      .addText((text) =>
        text
          .setPlaceholder("YYYYMM")
          .setValue(this.plugin.settings.diaryArchiveMonthDirName ?? "YYYYMM")
          .onChange(async (value) => {
            this.plugin.settings.diaryArchiveMonthDirName = (value ?? "").trim() || "YYYYMM";
            await this.saveAndRefreshSidePanelDebounced();
          })
      );

    new Setting(journalWrap)
      .setName("日记按月 · 归档阈值（天）")
      .setDesc("将 today - N 天之前的日记移入上方「月目录」。<=0 关闭。由自动刷新触发（每日最多一次）。非「索引归档」。")
      .addText((text) => {
        text
          .setPlaceholder("30")
          .setValue(String(this.plugin.settings.diaryArchiveThresholdDays ?? 30))
          .onChange(async (value) => {
            const n = Number(String(value ?? "").trim());
            this.plugin.settings.diaryArchiveThresholdDays = Number.isFinite(n) ? n : 30;
            await this.saveAndRefreshSidePanelDebounced();
          });
      });

    new Setting(journalWrap)
      .setName("日记按月 · 立即执行")
      .setDesc("立即将超阈值的日记移入月目录（「日记按月」）。用于测试。不会改写任务/记录等中央索引分片。")
      .addButton((button) => {
        button
          .setButtonText("执行归档")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText("归档中...");
            try {
              const result = await (this.plugin as any).archiveDiariesNow?.();
              if (result) {
                const { moved, scanned, cutoff } = result;
                if (moved > 0) {
                  new Notice(`日记按月完成：移动了 ${moved} 个文件（扫描了 ${scanned} 个，截止日期：${cutoff}）`);
                } else {
                  new Notice(`日记按月完成：未移动文件（扫描了 ${scanned} 个，截止日期：${cutoff}）`);
                }
              } else {
                new Notice("日记按月未执行（归档阈值 <= 0 或日记名称格式含子目录）");
              }
            } catch (e: any) {
              new Notice(`日记按月失败：${e?.message ?? String(e)}`);
            } finally {
              button.setDisabled(false);
              button.setButtonText("执行归档");
            }
          });
      });

    journalWrap.createEl("h3", { text: "Review · 周期简报" });
    journalWrap.createEl("div", {
      cls: "rslatte-setting-hint",
      text: "开启后，Review「记录」页按顶栏粒度展示对应简报：周→周报、月→月报、季→季报。文件在「日记路径」上一级下 weekly/、monthly/、quarterly/（与日记根同级）。子窗口表在下方分别维护；可关闭各视图下的「显示分区」以隐藏对应块。",
    });

    new Setting(journalWrap)
      .setName("在 Review 记录页启用周报")
      .setDesc("关闭时不在 Review 中展示周报按钮。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.reviewRecordsWeeklyEnabled === true).onChange(async (v) => {
          this.plugin.settings.reviewRecordsWeeklyEnabled = !!v;
          await this.saveAndRefreshSidePanelDebounced();
        }),
      );

    new Setting(journalWrap)
      .setName("在 Review 记录页启用月报")
      .setDesc("关闭时不在 Review 中展示月报按钮。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.reviewRecordsMonthlyEnabled === true).onChange(async (v) => {
          this.plugin.settings.reviewRecordsMonthlyEnabled = !!v;
          await this.saveAndRefreshSidePanelDebounced();
        }),
      );

    new Setting(journalWrap)
      .setName("在 Review 记录页启用季报（全局预取）")
      .setDesc(
        "开启后，在周/月/季任意视图下加载记录页时都会带上季报路径与字数。关闭时：周/月视图不预取季报；**顶栏「季」+「本季记录」仍会显示「周期季报」分区**（与月视图下「周期月报」对齐）。季视图统计仍会合并任务/提醒/日程/输出归档分片。",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.reviewRecordsQuarterlyEnabled === true).onChange(async (v) => {
          this.plugin.settings.reviewRecordsQuarterlyEnabled = !!v;
          await this.saveAndRefreshSidePanelDebounced();
        }),
      );

    const weeklyReportTplUpdate = addTemplateCheck(
      new Setting(journalWrap)
        .setName("周报模板路径")
        .setDesc("创建 weekly/*.md 时复制此模板；支持 {{date}} {{dateKey}} {{weekKey}} {{monthKey}} {{diaryName}}。")
        .addText((text) => {
          text
            .setPlaceholder("00-System/01-Templates/t_weekly.md")
            .setValue(this.plugin.settings.weeklyReportTemplatePath ?? "")
            .onChange(async (value) => {
              this.plugin.settings.weeklyReportTemplatePath = (value ?? "").trim();
              await this.saveAndRefreshSidePanelDebounced();
              await weeklyReportTplUpdate();
            });
        }),
      () => this.plugin.settings.weeklyReportTemplatePath ?? "",
    );

    const monthlyReportTplUpdate = addTemplateCheck(
      new Setting(journalWrap)
        .setName("月报模板路径")
        .setDesc("创建 monthly/*.md 时复制此模板；占位符与周报相同。")
        .addText((text) => {
          text
            .setPlaceholder("00-System/01-Templates/t_monthly.md")
            .setValue(this.plugin.settings.monthlyReportTemplatePath ?? "")
            .onChange(async (value) => {
              this.plugin.settings.monthlyReportTemplatePath = (value ?? "").trim();
              await this.saveAndRefreshSidePanelDebounced();
              await monthlyReportTplUpdate();
            });
        }),
      () => this.plugin.settings.monthlyReportTemplatePath ?? "",
    );

    const quarterlyReportTplUpdate = addTemplateCheck(
      new Setting(journalWrap)
        .setName("季报模板路径")
        .setDesc("创建 quarterly/*.md 时复制此模板；占位符含 {{quarterKey}}（如 2026-Q1），其余与周报相同。")
        .addText((text) => {
          text
            .setPlaceholder("00-System/01-Templates/t_quarterly.md")
            .setValue(this.plugin.settings.quarterlyReportTemplatePath ?? "")
            .onChange(async (value) => {
              this.plugin.settings.quarterlyReportTemplatePath = (value ?? "").trim();
              await this.saveAndRefreshSidePanelDebounced();
              await quarterlyReportTplUpdate();
            });
        }),
      () => this.plugin.settings.quarterlyReportTemplatePath ?? "",
    );

    new Setting(journalWrap)
      .setName("周视图：显示「周期周报」分区")
      .setDesc("顶栏选「周」且进入「本周记录」时，是否显示周报按钮与子窗口字数。关闭则周视图下隐藏该块。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.reviewPeriodReportShowWeekly !== false).onChange(async (v) => {
          this.plugin.settings.reviewPeriodReportShowWeekly = !!v;
          await this.saveAndRefreshSidePanelDebounced();
        }),
      );

    new Setting(journalWrap)
      .setName("月视图：显示「周期月报」分区")
      .setDesc("顶栏选「月」且进入「本月记录」时，是否显示月报按钮与子窗口字数。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.reviewPeriodReportShowMonthly !== false).onChange(async (v) => {
          this.plugin.settings.reviewPeriodReportShowMonthly = !!v;
          await this.saveAndRefreshSidePanelDebounced();
        }),
      );

    new Setting(journalWrap)
      .setName("季视图：显示「周期季报」分区")
      .setDesc("顶栏选「季」且进入「本季记录」时，是否显示季报按钮与子窗口字数。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.reviewPeriodReportShowQuarterly !== false).onChange(async (v) => {
          this.plugin.settings.reviewPeriodReportShowQuarterly = !!v;
          await this.saveAndRefreshSidePanelDebounced();
        }),
      );

    journalWrap.createEl("h3", { text: "Review 周报 · 子窗口" });

    journalWrap.createEl("div", {
      cls: "rslatte-setting-hint",
      text: "仅用于 weekly 笔记：按「标题行」匹配 ### 区块统计字数。与今日日记、月报子窗口独立；请在 t_weekly 模板中写入对应标题。",
    });
    this.renderJournalPanelsEditor(journalWrap, "weeklyJournalPanels", "+ 新增周报子窗口");

    journalWrap.createEl("h3", { text: "Review 月报 · 子窗口" });
    journalWrap.createEl("div", {
      cls: "rslatte-setting-hint",
      text: "仅用于 monthly 笔记；与今日日记、周报子窗口独立。",
    });
    this.renderJournalPanelsEditor(journalWrap, "monthlyJournalPanels", "+ 新增月报子窗口");

    journalWrap.createEl("h3", { text: "Review 季报 · 子窗口" });
    journalWrap.createEl("div", {
      cls: "rslatte-setting-hint",
      text: "仅用于 quarterly 笔记；与今日日记、周报、月报子窗口独立。模板默认 00-System/01-Templates/t_quarterly.md。",
    });
    this.renderJournalPanelsEditor(journalWrap, "quarterlyJournalPanels", "+ 新增季报子窗口");

    // ===== 日志子窗口配置（今日日记） =====
    journalWrap.createEl("h3", { text: "日志子窗口配置" });
    journalWrap.createEl("div", {
      cls: "rslatte-setting-hint",
      text: "仅用于按日期打开的日记：侧栏「今日日志」与工作台预览按「标题行」拆块；与上方周报/月报子窗口表无关。",
    });

    new Setting(journalWrap)
      .setName("是否展示日志子窗口")
      .setDesc("关闭时：侧边栏不展示「今日日志」区域（不影响日志追加/日记模板/周报月报）。")
      .addToggle((tog) =>
        tog
          .setValue(this.plugin.settings.showJournalPanels !== false)
          .onChange(async (v) => {
            this.plugin.settings.showJournalPanels = !!v;
            await this.saveAndRefreshSidePanelDebounced();
          })
      );

    // 子窗口父目录配置
    const parentHeadingSetting = new Setting(journalWrap)
      .setName("子窗口父目录")
      .setDesc("一级标题（H1），子窗口将插入到此目录下方。清空时默认使用\"# 碎碎念\"。")
      .addText((text) => {
        const defaultValue = "碎碎念";
        const currentValue = this.plugin.settings.journalPanelParentHeading ?? defaultValue;
        text.setPlaceholder(defaultValue)
          .setValue(currentValue)
          .onChange(async (v) => {
            const trimmed = v.trim();
            if (trimmed === "") {
              // 清空时显示红字提醒
              text.inputEl.style.color = "var(--text-error)";
              // 后台默认使用"碎碎念"
              this.plugin.settings.journalPanelParentHeading = defaultValue;
            } else {
              text.inputEl.style.color = "";
              this.plugin.settings.journalPanelParentHeading = trimmed;
            }
            await this.saveAndRefreshSidePanelDebounced();
          });
        
        // 初始化时检查是否为空
        if (!this.plugin.settings.journalPanelParentHeading || this.plugin.settings.journalPanelParentHeading.trim() === "") {
          text.inputEl.style.color = "var(--text-error)";
        }
      });

    this.renderJournalPanelsEditor(journalWrap, "journalPanels", "+ 新增子窗口");

    // =========================
    // 快速记录（Capture）：待整理写入路径与文件名格式，按空间配置
    // =========================
    const captureWrap = makeCollapsibleSection("快速记录", false, "rslatte-module-wrap", "space");
    if (!this.plugin.settings.captureModule) {
      this.plugin.settings.captureModule = {
        captureInboxDir: "10-Personal/17-Inbox",
        captureInboxFileNameFormat: "YYYYMMDD",
        captureArchiveDir: "90-Archive/93-System",
        captureShowStatuses: { todo: true, done: false, cancelled: false, paused: true },
        captureTypeRecommendationDict: {
          scheduleStrong: ["开会", "会议", "复盘", "约见", "面试", "拜访", "会谈", "课程", "值班"],
          scheduleWeak: ["今天", "明天", "后天", "本周", "下周", "下午", "晚上"],
          memoStrong: ["提醒我", "记得", "别忘", "不要忘", "到时提醒", "生日", "纪念日"],
          memoWeak: ["复查", "取快递", "续费", "到期", "过期", "稍后", "晚点"],
          taskStrong: ["整理", "跟进", "提交", "推进", "完成", "修复", "开发", "实现", "评审"],
          taskWeak: ["周报", "报销", "合同", "方案", "文档", "待办", "todo"],
        },
      };
    }
    new Setting(captureWrap)
      .setName("待整理写入目录")
      .setDesc("「待整理」条目写入的目录（相对 vault）。默认 10-Personal/17-Inbox。每个空间可单独配置。")
      .addText((t) => {
        t.setPlaceholder("10-Personal/17-Inbox")
          .setValue(this.plugin.settings.captureModule?.captureInboxDir ?? "10-Personal/17-Inbox")
          .onChange(async (v) => {
            if (!this.plugin.settings.captureModule) this.plugin.settings.captureModule = { captureInboxDir: "", captureInboxFileNameFormat: "YYYYMMDD", captureArchiveDir: "90-Archive/93-System", captureShowStatuses: { todo: true, done: false, cancelled: false, paused: true } };
            this.plugin.settings.captureModule.captureInboxDir = (v ?? "").trim() || "10-Personal/17-Inbox";
            await this.saveAndRefreshSidePanelDebounced();
          });
      });
    new Setting(captureWrap)
      .setName("待整理文件名格式")
      .setDesc("按日期分文件时使用的 moment 格式（不含扩展名）。如 YYYYMMDD 表示 20260317.md。每个空间可单独配置。")
      .addText((t) => {
        t.setPlaceholder("YYYYMMDD")
          .setValue(this.plugin.settings.captureModule?.captureInboxFileNameFormat ?? "YYYYMMDD")
          .onChange(async (v) => {
            if (!this.plugin.settings.captureModule) this.plugin.settings.captureModule = { captureInboxDir: "10-Personal/17-Inbox", captureInboxFileNameFormat: "", captureArchiveDir: "90-Archive/93-System", captureShowStatuses: { todo: true, done: false, cancelled: false, paused: true } };
            this.plugin.settings.captureModule.captureInboxFileNameFormat = (v ?? "").trim() || "YYYYMMDD";
            await this.saveAndRefreshSidePanelDebounced();
          });
      });
    new Setting(captureWrap)
      .setName("待整理笔记归档目录")
      .setDesc(
        "「笔记归档」：仅当 Inbox 文件名日期 **早于今天**（与任务「今日」一致）且其中快速记录 **全部为已整理/已取消**（无待办、无暂不处理）时，整份 Inbox 文件移入此目录；**当天 Inbox 不归档**。非中央索引分片。默认 90-Archive/93-System。"
      )
      .addText((t) => {
        t.setPlaceholder("90-Archive/93-System")
          .setValue(this.plugin.settings.captureModule?.captureArchiveDir ?? "90-Archive/93-System")
          .onChange(async (v) => {
            if (!this.plugin.settings.captureModule) this.plugin.settings.captureModule = { captureInboxDir: "10-Personal/17-Inbox", captureInboxFileNameFormat: "YYYYMMDD", captureArchiveDir: "", captureShowStatuses: { todo: true, done: false, cancelled: false, paused: true } };
            this.plugin.settings.captureModule.captureArchiveDir = (v ?? "").trim() || "90-Archive/93-System";
            await this.saveAndRefreshSidePanelDebounced();
          });
      });
    new Setting(captureWrap)
      .setName("即时计时显示样式")
      .setDesc("digital：数字时钟（默认）；clock：钟表形式（含数字时间）。")
      .addDropdown((d) => {
        d.addOption("digital", "数字时钟（时:分:秒）");
        d.addOption("clock", "钟表形式");
        d.setValue(String((this.plugin.settings.captureModule as any)?.captureTimerDisplayMode ?? "digital"));
        d.onChange(async (v) => {
          if (!this.plugin.settings.captureModule) this.plugin.settings.captureModule = {
            captureInboxDir: "10-Personal/17-Inbox",
            captureInboxFileNameFormat: "YYYYMMDD",
            captureArchiveDir: "90-Archive/93-System",
            captureShowStatuses: { todo: true, done: false, cancelled: false, paused: true },
          } as any;
          (this.plugin.settings.captureModule as any).captureTimerDisplayMode = v === "clock" ? "clock" : "digital";
          await this.saveAndRefreshSidePanelDebounced();
        });
      });
    const showStatuses = this.plugin.settings.captureModule?.captureShowStatuses ?? { todo: true, done: false, cancelled: false, paused: true };
    captureWrap.createEl("h4", { text: "时间轴展示状态", cls: "rslatte-setting-h4" });
    const statusDesc = captureWrap.createDiv({ cls: "rslatte-muted", text: "勾选后，待整理时间轴中会显示对应状态的条目。默认仅显示「待处理」「暂不处理」。" });
    statusDesc.style.marginBottom = "8px";
    const statusWrap = captureWrap.createDiv({ cls: "rslatte-capture-status-checkboxes" });
    const labels: Array<{ key: keyof typeof showStatuses; label: string }> = [
      { key: "todo", label: "待处理" },
      { key: "paused", label: "暂不处理" },
      { key: "done", label: "已整理" },
      { key: "cancelled", label: "取消" },
    ];
    for (const { key, label } of labels) {
      const row = statusWrap.createDiv({ cls: "rslatte-capture-status-row" });
      const cb = row.createEl("input", { type: "checkbox" });
      cb.checked = !!showStatuses[key];
      cb.onchange = async () => {
        if (!this.plugin.settings.captureModule) this.plugin.settings.captureModule = { captureInboxDir: "10-Personal/17-Inbox", captureInboxFileNameFormat: "YYYYMMDD", captureArchiveDir: "90-Archive/93-System", captureShowStatuses: {} };
        if (!this.plugin.settings.captureModule.captureShowStatuses) this.plugin.settings.captureModule.captureShowStatuses = {};
        this.plugin.settings.captureModule.captureShowStatuses[key] = cb.checked;
        await this.saveAndRefreshSidePanelDebounced();
      };
      row.createSpan({ text: label });
    }

    captureWrap.createEl("h4", { text: "类型推荐词典（高级）", cls: "rslatte-setting-h4" });
    const dictDesc = captureWrap.createDiv({
      cls: "rslatte-muted",
      text: "用于“🗃️整理”时的类型推荐。支持配置六组关键词：schedule/memo/task 的 strong/weak。建议直接编辑 JSON。"
    });
    dictDesc.style.marginBottom = "8px";
    const defaultDict = {
      scheduleStrong: ["开会", "会议", "复盘", "约见", "面试", "拜访", "会谈", "课程", "值班"],
      scheduleWeak: ["今天", "明天", "后天", "本周", "下周", "下午", "晚上"],
      memoStrong: ["提醒我", "记得", "别忘", "不要忘", "到时提醒", "生日", "纪念日"],
      memoWeak: ["复查", "取快递", "续费", "到期", "过期", "稍后", "晚点"],
      taskStrong: ["整理", "跟进", "提交", "推进", "完成", "修复", "开发", "实现", "评审"],
      taskWeak: ["周报", "报销", "合同", "方案", "文档", "待办", "todo"],
    };
    const dictSetting = new Setting(captureWrap).setName("推荐词典 JSON");
    dictSetting.setDesc("保存时会做 JSON 校验。格式错误不会写入设置。");
    dictSetting.addTextArea((ta) => {
      const current = (this.plugin.settings.captureModule as any)?.captureTypeRecommendationDict ?? defaultDict;
      ta.setValue(JSON.stringify(current, null, 2));
      ta.inputEl.rows = 10;
      ta.inputEl.style.width = "100%";
      ta.onChange(async (v) => {
        try {
          const parsed = JSON.parse(String(v ?? "{}"));
          if (!this.plugin.settings.captureModule) {
            this.plugin.settings.captureModule = {
              captureInboxDir: "10-Personal/17-Inbox",
              captureInboxFileNameFormat: "YYYYMMDD",
              captureArchiveDir: "90-Archive/93-System",
              captureShowStatuses: { todo: true, done: false, cancelled: false, paused: true },
            } as any;
          }
          (this.plugin.settings.captureModule as any).captureTypeRecommendationDict = parsed;
          ta.inputEl.classList.remove("is-invalid");
          await this.saveAndRefreshSidePanelDebounced();
        } catch {
          ta.inputEl.classList.add("is-invalid");
        }
      });
    });

        // =========================
    // 打卡管理
    // =========================

    // ===== Side Panel 1~7：各模块设置（拆分到独立文件，避免单文件过长/异常导致设置页截断）
    try { renderCheckinSettings({ tab: this as any, makeModuleWrap, addHeaderButtonsVisibilitySetting, addUiHeaderButtonsVisibilitySetting }); } catch (e) { console.error(e); }
    try { renderFinanceSettings({ tab: this as any, makeModuleWrap, addHeaderButtonsVisibilitySetting, addUiHeaderButtonsVisibilitySetting }); } catch (e) { console.error(e); }
    try {
      renderHealthSettings({ tab: this as any, makeModuleWrap, addHeaderButtonsVisibilitySetting });
    } catch (e) {
      console.error(e);
    }
    try { renderTaskSettings({ tab: this as any, makeModuleWrap, addHeaderButtonsVisibilitySetting, addUiHeaderButtonsVisibilitySetting }); } catch (e) { console.error(e); }
    try { renderMemoSettings({ tab: this as any, makeModuleWrap, addHeaderButtonsVisibilitySetting, addUiHeaderButtonsVisibilitySetting }); } catch (e) { console.error(e); }
    try { renderScheduleSettings({ tab: this as any, makeModuleWrap, addHeaderButtonsVisibilitySetting, addUiHeaderButtonsVisibilitySetting }); } catch (e) { console.error(e); }
    try { renderProjectSettings({ tab: this as any, makeModuleWrap, addHeaderButtonsVisibilitySetting, addUiHeaderButtonsVisibilitySetting }); } catch (e) { console.error(e); }
    try { renderOutputSettings({ tab: this as any, makeModuleWrap, addHeaderButtonsVisibilitySetting, addUiHeaderButtonsVisibilitySetting }); } catch (e) { console.error(e); }
    const afterKnowledgeDbSyncChange = async () => {
      await this.updateCurrentSpaceSnapshot();
      this.display();
      this.plugin.refreshSidePanel();
    };
    try {
      renderKnowledgeSettings({
        tab: this as any,
        makeModuleWrap,
        urlCheckable,
        onDbSyncTurnedOn: () => handleDbSyncToggleOn("knowledge", "知识管理"),
        afterKnowledgeDbSyncChange,
      });
    } catch (e) {
      console.error(e);
    }
    try { renderContactsSettings({ tab: this as any, makeModuleWrap, addHeaderButtonsVisibilitySetting, addUiHeaderButtonsVisibilitySetting }); } catch (e) { console.error(e); }

    // =========================
    // 统计管理（可折叠，顶层，与其他管理标题同级）
    // =========================
    try { renderStatsSettings({ tab: this as any, makeCollapsibleSection }); } catch (e) { console.error(e); }

    // ===== 调试（全局配置） =====
    // ✅ Debug Log 属于全局配置，所有空间共用。
    globalConfigWrap.createEl("h3", { text: "调试", cls: "rslatte-setting-h3" });

    new Setting(globalConfigWrap)
      .setName("Debug Log（控制台日志）")
      .setDesc("开启后会把关键事件调用情况打印到开发者工具 Console（建议过滤： [rslatte] ）")
      .addToggle((tg) => {
        tg.setValue(!!this.plugin.settings.debugLogEnabled);
        tg.onChange(async (v) => {
          this.plugin.settings.debugLogEnabled = v;
          await this.plugin.saveSettings();
          new Notice(v ? "RSLatte Debug Log 已开启（请打开开发者工具 Console）" : "RSLatte Debug Log 已关闭");
          // 立刻打一条，方便确认是否生效
          this.plugin.dbg("settings", "debugLogEnabled =", v);
        });
      });

    // ✅ 内存优化：手动清理快照缓存按钮
    new Setting(globalConfigWrap)
      .setName("清理内存缓存")
      .setDesc("清理所有服务的快照缓存以释放内存。清理后，下次访问时会按需重新加载数据。")
      .addButton((btn) => {
        btn.setButtonText("清理缓存")
          .setCta()
          .onClick(async () => {
            try {
              this.plugin.clearAllSnapshots();
              new Notice("已清理所有快照缓存，内存占用已降低");
            } catch (e: any) {
              new Notice(`清理缓存失败：${e?.message ?? String(e)}`);
              console.warn("[RSLatte] Failed to clear snapshots:", e);
            }
          });
      });

    // ✅ 恢复输入框焦点（如果有保存的焦点信息）
    this.restoreFocus();
    
    // ✅ 恢复滚动位置（在重新渲染后）
    const restoreScroll = () => {
      // 优先使用标记元素定位（更可靠）
      if (this._savedScrollMarker) {
        const markerEl = containerEl.querySelector(`[data-rslatte-scroll-marker="${this._savedScrollMarker}"]`) as HTMLElement;
        if (markerEl) {
          // 尝试多种方式查找滚动容器
          let scrollContainer: HTMLElement | null = null;
          
          // 方法1: 查找 .vertical-tab-content
          scrollContainer = containerEl.closest('.vertical-tab-content') as HTMLElement;
          
          // 方法2: 查找 .vertical-tab-content-container
          if (!scrollContainer) {
            scrollContainer = containerEl.closest('.vertical-tab-content-container') as HTMLElement;
          }
          
          // 方法3: 查找 .settings-content
          if (!scrollContainer) {
            scrollContainer = containerEl.closest('.settings-content') as HTMLElement;
          }
          
          // 方法4: 向上查找第一个可滚动的父元素
          if (!scrollContainer) {
            let parent: HTMLElement | null = containerEl.parentElement;
            while (parent) {
              const style = window.getComputedStyle(parent);
              if (style.overflow === 'auto' || style.overflow === 'scroll' || style.overflowY === 'auto' || style.overflowY === 'scroll') {
                scrollContainer = parent;
                break;
              }
              parent = parent.parentElement;
            }
          }
          
          // 方法5: 查找设置页的根容器
          if (!scrollContainer) {
            const settingRoot = containerEl.closest('.vertical-tab-content, .vertical-tab-content-container, [class*="setting"], [class*="tab"]') as HTMLElement;
            if (settingRoot) {
              scrollContainer = settingRoot;
            }
          }
          
          if (scrollContainer && scrollContainer instanceof HTMLElement) {
            // 计算标记元素相对于滚动容器的位置
            const markerRect = markerEl.getBoundingClientRect();
            const containerRect = scrollContainer.getBoundingClientRect();
            const relativeTop = markerRect.top - containerRect.top + scrollContainer.scrollTop;
            scrollContainer.scrollTop = relativeTop - 20; // 减去一点偏移，让元素稍微靠上一点
            this._savedScrollMarker = null; // 清除标记
            return;
          }
        }
      }
      
      // 如果没有标记元素或找不到，使用保存的滚动位置
      if (this._savedScrollPosition > 0) {
        // 尝试多种方式查找滚动容器（与保存时一致）
        let scrollContainer: HTMLElement | null = null;
        
        // 方法1: 查找 .vertical-tab-content
        scrollContainer = containerEl.closest('.vertical-tab-content') as HTMLElement;
        
        // 方法2: 查找 .vertical-tab-content-container
        if (!scrollContainer) {
          scrollContainer = containerEl.closest('.vertical-tab-content-container') as HTMLElement;
        }
        
        // 方法3: 查找 .settings-content
        if (!scrollContainer) {
          scrollContainer = containerEl.closest('.settings-content') as HTMLElement;
        }
        
        // 方法4: 向上查找第一个可滚动的父元素
        if (!scrollContainer) {
          let parent: HTMLElement | null = containerEl.parentElement;
          while (parent) {
            const style = window.getComputedStyle(parent);
            if (style.overflow === 'auto' || style.overflow === 'scroll' || style.overflowY === 'auto' || style.overflowY === 'scroll') {
              scrollContainer = parent;
              break;
            }
            parent = parent.parentElement;
          }
        }
        
        // 方法5: 查找设置页的根容器
        if (!scrollContainer) {
          const settingRoot = containerEl.closest('.vertical-tab-content, .vertical-tab-content-container, [class*="setting"], [class*="tab"]') as HTMLElement;
          if (settingRoot) {
            scrollContainer = settingRoot;
          }
        }
        
        if (scrollContainer && scrollContainer instanceof HTMLElement) {
          scrollContainer.scrollTop = this._savedScrollPosition;
        } else {
          // 如果都没找到，尝试设置 window 滚动位置
          window.scrollTo(0, this._savedScrollPosition);
        }
        this._savedScrollPosition = 0; // 清除保存的位置
      }
    };
    
    // 使用 requestAnimationFrame + setTimeout 多重延迟确保 DOM 已完全渲染
    requestAnimationFrame(() => {
      setTimeout(() => {
        restoreScroll();
        // 再延迟一次，确保所有异步渲染完成
        setTimeout(() => {
          restoreScroll();
        }, 100);
      }, 10);
    });
  }

  private genId(prefix: "DK" | "CW"): string {
    const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `${prefix}_${rand}`;
  }

  private genPanelId(): string {
    const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `JP_${rand}`;
  }

  /** 子窗口表：今日日记 / 周报 / 月报 各用独立数组 */
  private renderJournalPanelsEditor(
    host: HTMLElement,
    storageKey: "journalPanels" | "weeklyJournalPanels" | "monthlyJournalPanels" | "quarterlyJournalPanels",
    addButtonText: string,
  ): void {
    const s = this.plugin.settings as Record<string, unknown>;
    if (!Array.isArray(s[storageKey])) s[storageKey] = [];
    const panels = s[storageKey] as JournalPanel[];

    const header = host.createDiv({ cls: "rslatte-panel-table-header" });
    header.createDiv({ text: "ID", cls: "col col-id" });
    header.createDiv({ text: "按钮名", cls: "col col-label" });
    header.createDiv({ text: "标题行", cls: "col col-heading" });
    header.createDiv({ text: "行数", cls: "col col-lines" });
    header.createDiv({ text: "操作", cls: "col col-action" });

    panels.forEach((p, idx) => {
      const row = new Setting(host).setName("");
      row.settingEl.addClass("rslatte-panel-table-row");

      row.addText((t) => {
        t.inputEl.addClass("col", "col-id");
        t.setPlaceholder("JP_xxx")
          .setValue(p.id ?? "")
          .onChange(async (v) => {
            p.id = v.trim();
            await this.saveAndRefreshSidePanelDebounced();
          });
      });

      row.addText((t) => {
        t.inputEl.addClass("col", "col-label");
        t.setPlaceholder("📝 今日积累")
          .setValue(p.label ?? "")
          .onChange(async (v) => {
            p.label = v;
            await this.saveAndRefreshSidePanelDebounced();
          });
      });

      row.addText((t) => {
        t.inputEl.addClass("col", "col-heading");
        t.setPlaceholder("### 今日积累")
          .setValue(p.heading ?? "")
          .onChange(async (v) => {
            p.heading = v;
            await this.saveAndRefreshSidePanelDebounced();
          });
      });

      row.addText((t) => {
        t.inputEl.addClass("col", "col-lines");
        t.setPlaceholder("20")
          .setValue(String(p.maxLines ?? 20))
          .onChange(async (v) => {
            const n = Number(v);
            if (!isNaN(n)) p.maxLines = Math.min(Math.max(n, 1), 30);
            await this.saveAndRefreshSidePanelDebounced();
          });
      });

      row.addButton((btn) => {
        btn.buttonEl.addClass("col", "col-action");
        btn.setButtonText("删除").setCta().onClick(async () => {
          panels.splice(idx, 1);
          await this.saveAndRerender();
        });
      });
    });

    new Setting(host).addButton((btn) =>
      btn.setButtonText(addButtonText).setCta().onClick(async () => {
        panels.push({
          id: this.genPanelId(),
          label: "新子窗口",
          heading: "### 新标题",
          maxLines: 20,
        });
        await this.saveAndRerender();
      }),
    );
  }

  private genTaskCatId(): string {
    const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `TC_${rand}`;
  }

  private async saveAndRerender() {
    await this.plugin.saveSettings();
    await this.backupFinanceCategoriesToSpaceConfig();
    // ✅ 在重新渲染前保存焦点（如果用户正在编辑）
    this.saveFocusBeforeRerender();
    this.display();
    this.plugin.refreshSidePanel();
  }

  private _refreshTimer: number | null = null;

  private async saveAndRefreshSidePanelDebounced() {
    // ✅ 不阻止落盘，让用户输入可持久化
    await this.plugin.saveSettings();
    await this.backupFinanceCategoriesToSpaceConfig();

    if (this._refreshTimer) window.clearTimeout(this._refreshTimer);
    this._refreshTimer = window.setTimeout(() => {
      this.plugin.refreshSidePanel();
    }, 150);
  }

  /**
   * 仅做“额外备份”：
   * - 仍以 settings.financeCategories 作为唯一读写来源
   * - 另外写一份到 index/finance-config/finance-categories.json，方便后续统一从 finance-config 读取入库
   */
  private async backupFinanceCategoriesToSpaceConfig() {
    try {
      const spaceRoot = String(this.plugin.getSpaceIndexDir?.() ?? "").trim();
      if (!spaceRoot) return;
      const cfgDir = normalizePath(`${spaceRoot}/finance-config`);
      const cfgPath = normalizePath(`${cfgDir}/finance-categories.json`);

      const items = (this.plugin.settings.financeCategories ?? []).map((x: FinanceCatDef) => ({
        id: String(x.id ?? "").trim(),
        name: String(x.name ?? "").trim(),
        type: x.type === "income" ? "income" : "expense",
        active: !!x.active,
        subCategories: Array.isArray(x.subCategories)
          ? Array.from(new Set(x.subCategories.map((s) => String(s ?? "").trim()).filter(Boolean)))
          : [],
        institutionNames: Array.isArray((x as any).institutionNames)
          ? Array.from(
            new Set(
              ((x as any).institutionNames as any[])
                .map((s) => String(s ?? "").trim().replace(/\s+/g, " "))
                .filter(Boolean)
            )
          )
          : [],
      }));
      const payload = {
        schema_version: 1,
        updated_at: new Date().toISOString(),
        items,
      };
      const json = JSON.stringify(payload, null, 2);
      if (json === this._lastFinanceCategoriesBackupJson) return;

      const adapter = this.plugin.app.vault.adapter;
      const dirExists = await adapter.exists(cfgDir);
      if (!dirExists) await adapter.mkdir(cfgDir);
      await adapter.write(cfgPath, json);
      this._lastFinanceCategoriesBackupJson = json;
    } catch (e) {
      console.warn("[RSLatte][settings] 备份 finance-categories.json 失败", e);
    }
  }

  private isValidId(id: string): boolean {
    const v = (id ?? "").trim();
    if (!v) return false;
    return /^[A-Za-z][A-Za-z0-9_]*$/.test(v);
  }

  private normalizeKey(s: string): string {
    return (s ?? "").trim();
  }

  /** 生成元素的唯一选择器（用于恢复焦点） */
  private generateElementSelector(element: HTMLElement): string {
    // 优先使用 data 属性来标识输入框
    const settingKey = element.getAttribute('data-setting-key');
    if (settingKey) return `[data-setting-key="${settingKey}"]`;
    
    // 尝试通过 name 属性
    const name = element.getAttribute('name');
    if (name) return `[name="${name}"]`;
    
    // 尝试通过 id
    if (element.id) return `#${element.id}`;
    
    // 尝试通过元素自身的 data-checkin-id 属性（用于打卡项等列表项，优先使用 ID 因为更稳定）
    const checkinId = element.getAttribute('data-checkin-id');
    if (checkinId !== null) {
      const tag = element.tagName.toLowerCase();
      const inputType = element.getAttribute('type') ? `[type="${element.getAttribute('type')}"]` : '';
      return `[data-checkin-id="${checkinId}"]${inputType}`;
    }
    
    // 尝试通过元素自身的 data-checkin-idx 属性（作为备用）
    const checkinIdx = element.getAttribute('data-checkin-idx');
    if (checkinIdx !== null) {
      const tag = element.tagName.toLowerCase();
      const inputType = element.getAttribute('type') ? `[type="${element.getAttribute('type')}"]` : '';
      return `[data-checkin-idx="${checkinIdx}"]${inputType}`;
    }
    
    // 尝试通过父元素的 data 属性
    let current: HTMLElement | null = element.parentElement;
    let depth = 0;
    while (current && depth < 5) {
      const parentKey = current.getAttribute('data-setting-key') || current.getAttribute('data-idx');
      if (parentKey) {
        const tag = element.tagName.toLowerCase();
        const inputType = element.getAttribute('type') ? `[type="${element.getAttribute('type')}"]` : '';
        return `[data-setting-key="${parentKey}"] ${tag}${inputType}, [data-idx="${parentKey}"] ${tag}${inputType}`;
      }
      current = current.parentElement;
      depth++;
    }
    
    // 尝试通过父元素的类名和索引
    const parent = element.parentElement;
    if (parent) {
      const parentClasses = parent.className?.split(' ').filter(c => c && !c.startsWith('setting-item'));
      if (parentClasses && parentClasses.length > 0) {
        const parentSelector = parentClasses.map(c => `.${c}`).join('');
        const siblings = Array.from(parent.querySelectorAll(element.tagName.toLowerCase()));
        const index = siblings.indexOf(element);
        if (index >= 0) {
          return `${parentSelector} ${element.tagName.toLowerCase()}:nth-of-type(${index + 1})`;
        }
      }
    }
    
    // 最后的回退：使用标签名和类名
    const tag = element.tagName.toLowerCase();
    const classes = element.className ? `.${element.className.split(' ').filter(c => c).join('.')}` : '';
    return `${tag}${classes}`;
  }

  /** 保存当前聚焦的输入框信息（在重新渲染前调用） */
  private saveFocusBeforeRerender(): void {
    const activeElement = document.activeElement;
    if (activeElement && (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement)) {
      if (this.containerEl.contains(activeElement)) {
        const input = activeElement as HTMLInputElement | HTMLTextAreaElement;
        const selector = this.generateElementSelector(activeElement);
        const cursorPosition = input.selectionStart ?? 0;
        // 同时保存输入框的值，以防重新渲染时值被重置
        const currentValue = input.value;
        this._focusedElementInfo = { 
          selector, 
          cursorPosition,
          value: currentValue // 保存当前值
        } as any;
      }
    }
  }

  /** 恢复输入框焦点（在重新渲染后调用） */
  private restoreFocus(): void {
    if (!this._focusedElementInfo) return;
    
    try {
      const { selector, cursorPosition, value } = this._focusedElementInfo as any;
      // 延迟一点时间确保 DOM 已完全渲染
      setTimeout(() => {
        try {
          // 尝试多个选择器（因为选择器可能包含多个选项）
          const selectors = selector.split(',').map((s: string) => s.trim());
          let element: HTMLInputElement | HTMLTextAreaElement | null = null;
          
          for (const sel of selectors) {
            element = this.containerEl.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
            if (element && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
              break;
            }
          }
          
          if (element && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
            // 如果保存了值且当前值不同，恢复值
            if (value !== undefined && element.value !== value) {
              element.value = value;
              // 触发 change 事件以确保值被保存
              element.dispatchEvent(new Event('input', { bubbles: true }));
            }
            
            element.focus();
            // 恢复光标位置
            if (element.setSelectionRange) {
              const maxPos = element.value?.length || 0;
              const pos = Math.min(Math.max(0, cursorPosition), maxPos);
              element.setSelectionRange(pos, pos);
            }
          }
        } catch {
          // ignore
        } finally {
          // 清除保存的信息
          this._focusedElementInfo = null;
        }
      }, 10);
    } catch {
      this._focusedElementInfo = null;
    }
  }

  private buildDupSet(values: string[]): Set<string> {
    const count = new Map<string, number>();
    for (const raw of values) {
      const v = this.normalizeKey(raw);
      if (!v) continue;
      count.set(v, (count.get(v) ?? 0) + 1);
    }
    const dup = new Set<string>();
    for (const [k, c] of count.entries()) if (c > 1) dup.add(k);
    return dup;
  }

  private canSaveLists(): boolean {
    const checkins = this.plugin.settings.checkinItems ?? [];
    const finance = this.plugin.settings.financeCategories ?? [];

    const ckDupIds = this.buildDupSet(checkins.map(x => x.id));
    const ckDupNames = this.buildDupSet(checkins.map(x => x.name));
    const finDupIds = this.buildDupSet(finance.map(x => x.id));
    const finDupNames = this.buildDupSet(finance.map(x => x.name));

    const hasBadCheckin = checkins.some(x => {
      const id = this.normalizeKey(x.id);
      const nm = this.normalizeKey(x.name);
      return !this.isValidId(x.id) || (id && ckDupIds.has(id)) || (nm && ckDupNames.has(nm));
    });

    const hasBadFinance = finance.some(x => {
      const id = this.normalizeKey(x.id);
      const nm = this.normalizeKey(x.name);
      return !this.isValidId(x.id) || (id && finDupIds.has(id)) || (nm && finDupNames.has(nm));
    });

    return !(hasBadCheckin || hasBadFinance);
  }

  private refreshCheckinValidationMarks(containerEl: HTMLElement) {
    const items = this.plugin.settings.checkinItems;
    const dupIds = this.buildDupSet(items.map(x => x.id));
    const dupNames = this.buildDupSet(items.map(x => x.name));

    const rows = containerEl.querySelectorAll<HTMLElement>(".rslatte-checkin-table-row");
    rows.forEach((rowEl) => {
      const idxStr = rowEl.dataset.idx;
      if (idxStr == null) return;

      const idx = Number(idxStr);
      const item = items[idx];
      if (!item) return;

      const idKey = this.normalizeKey(item.id);
      const nameKey = this.normalizeKey(item.name);

      const idInvalid = !this.isValidId(item.id);
      const idDup = idKey && dupIds.has(idKey);
      const nameDup = nameKey && dupNames.has(nameKey);
      const idConflictDeleted = idKey && this._conflictCheckinIds.has(idKey);

      const reasons: string[] = [];
      if (idInvalid) reasons.push("ID 格式非法：仅允许字母/数字/_，且必须以字母开头");
      if (idDup) reasons.push("ID 重复");
      if (nameDup) reasons.push("名称重复");
      if (idConflictDeleted) reasons.push("ID 与历史已删除条目冲突（请修改 ID）");

      const idInput = rowEl.querySelector<HTMLInputElement>("input.col-id");
      const nameInput = rowEl.querySelector<HTMLInputElement>("input.col-name");

      idInput?.classList.toggle("is-invalid", !!(idInvalid || idDup || idConflictDeleted));
      nameInput?.classList.toggle("is-invalid", !!nameDup);

      if (idInput) idInput.title = reasons.filter(r => r.startsWith("ID")).join("；");
      if (nameInput) nameInput.title = reasons.filter(r => r.startsWith("名称")).join("；");

      const rowBad = !!(idInvalid || idDup || nameDup || idConflictDeleted);
      rowEl.classList.toggle("is-invalid-row", rowBad);

      const hintEl = rowEl.querySelector<HTMLElement>(".rslatte-row-hint");
      if (hintEl) {
        hintEl.setText(reasons.join("；"));
        hintEl.toggleClass("is-hidden", !rowBad);
      }
    });
  }

  private refreshFinanceValidationMarks(containerEl: HTMLElement) {
    const items = this.plugin.settings.financeCategories;
    const dupIds = this.buildDupSet(items.map(x => x.id));
    const dupNames = this.buildDupSet(items.map(x => x.name));

    const rows = containerEl.querySelectorAll<HTMLElement>(".rslatte-fin-table-row");
    rows.forEach((rowEl) => {
      const idxStr = rowEl.dataset.idx;
      if (idxStr == null) return;

      const idx = Number(idxStr);
      const item = items[idx];
      if (!item) return;

      const idKey = this.normalizeKey(item.id);
      const nameKey = this.normalizeKey(item.name);

      const idInvalid = !this.isValidId(item.id);
      const idDup = idKey && dupIds.has(idKey);
      const nameDup = nameKey && dupNames.has(nameKey);
      const idConflictDeleted = idKey && this._conflictFinanceIds.has(idKey);

      const reasons: string[] = [];
      if (idInvalid) reasons.push("ID 格式非法：仅允许字母/数字/_，且必须以字母开头");
      if (idDup) reasons.push("ID 重复");
      if (nameDup) reasons.push("名称重复");
      if (idConflictDeleted) reasons.push("ID 与历史已删除条目冲突（请修改 ID）");

      const idInput = rowEl.querySelector<HTMLInputElement>("input.col-id");
      const nameInput = rowEl.querySelector<HTMLInputElement>("input.col-name");

      idInput?.classList.toggle("is-invalid", !!(idInvalid || idDup || idConflictDeleted));
      nameInput?.classList.toggle("is-invalid", !!nameDup);

      if (idInput) idInput.title = reasons.filter(r => r.startsWith("ID")).join("；");
      if (nameInput) nameInput.title = reasons.filter(r => r.startsWith("名称")).join("；");

      const rowBad = !!(idInvalid || idDup || nameDup || idConflictDeleted);
      rowEl.classList.toggle("is-invalid-row", rowBad);

      const hintEl = rowEl.querySelector<HTMLElement>(".rslatte-row-hint");
      if (hintEl) {
        hintEl.setText(reasons.join("；"));
        hintEl.toggleClass("is-hidden", !rowBad);
      }
    });
  }

  // API Base URL 输入 UX：避免每输入一个字符就触发保存/校验，导致光标丢失与 Failed to fetch 噪声。
  private _apiUrlDraft: string = "";
  private _apiUrlCommitTimer: number | null = null;

  private _dbReady: boolean | null = null;
  private _dbReason: string = "";
  private _dbInitRequired = false;
  private _dbChecking = false;
  /** null=未知；true=服务端要求 Bearer（GET /auth/status） */
  private _authRequired: boolean | null = null;

  private async refreshAuthRequiredFlag(): Promise<void> {
    this._authRequired = null;
    const base = String(this.plugin.settings.apiBaseUrl ?? "").trim();
    if (!base) return;
    const lower = base.toLowerCase();
    if (!(lower.startsWith("http://") || lower.startsWith("https://"))) return;
    try {
      // eslint-disable-next-line no-new
      new URL(base);
    } catch {
      return;
    }
    try {
      this.plugin.api.setBaseUrl(base);
      const st = await this.plugin.api.authStatus();
      this._authRequired = !!st.auth_required;
    } catch {
      this._authRequired = null;
    }
  }

  private async checkDbReady(): Promise<boolean> {
  // ✅ D9：后端触达入口统一（内部包含 shouldTouchBackendNow + ensureVaultReadySafe + dbInitialized）
  const r = await (this.plugin as any)?.vaultSvc?.checkDbReadySafe?.("settings.checkDbReady");
  if (!r) {
    // fallback（理论不应发生）
    this._dbReady = false;
    this._dbInitRequired = false;
    this._dbReason = "后端不可用";
    try { (this.plugin as any).setBackendDbReady?.(false, this._dbReason); } catch {}
    return false;
  }

  this._dbReady = !!r.ok;

  // 仅当后端可达且明确返回 initialized=false 时，才视为“需要 init.sql”
  const initialized = (r as any).initialized;
  const raw = (r as any).raw;
  const reason = String((r as any).reason ?? "");
  const code = raw?.detail?.code ?? raw?.code;

  this._dbInitRequired =
    (raw && raw.initialized === false) ||
    (initialized === false && (code === "DB_NOT_INITIALIZED" || reason.includes("未初始化")));

  this._dbReason = this._dbReady ? "" : reason;

  await this.refreshAuthRequiredFlag();
  // setBackendDbReady 已在 VaultService 内统一维护；这里仅保持 UI 状态即可
  return !!r.ok;
}

  private async pullListsFromApiToSettings(): Promise<void> {
    const [cks, fins] = await Promise.all([
      apiTry("拉取打卡清单", () => this.plugin.api.listCheckinTypes(undefined)),
      apiTry("拉取财务分类清单", () => this.plugin.api.listFinanceCategories(undefined)),
    ]);

    const prevCk = new Map((this.plugin.settings.checkinItems ?? []).map((it: any) => [String(it?.id ?? ""), it]));
    this.plugin.settings.checkinItems = (cks || []).map((x) => {
      const id = String(x.checkin_id ?? "");
      const prev = prevCk.get(id) as any;
      return {
        id: x.checkin_id,
        name: x.checkin_name,
        active: !!x.status,
        fromDb: true,
        // 后端暂无难度字段：从本地同 ID 条目保留，避免拉清单覆盖为默认
        checkinDifficulty: prev?.checkinDifficulty,
      };
    });

    this.plugin.settings.financeCategories = (fins || []).map((x) => {
      const prev = (this.plugin.settings.financeCategories ?? []).find(
        (it: any) => String(it?.id ?? "") === String(x.category_id ?? "")
      ) as any;
      const rawInst = (x as any).institution_names ?? (x as any).institutionNames;
      const instFromApi = Array.isArray(rawInst)
        ? rawInst.map((s: string) => String(s ?? "").trim()).filter(Boolean)
        : null;
      return {
        id: x.category_id,
        name: x.category_name,
        type: x.category_type,
        active: !!x.status,
        fromDb: true,
        subCategories: (x as any).sub_categories || (x as any).subCategories || [],
        institutionNames:
          instFromApi !== null
            ? instFromApi
            : Array.isArray(prev?.institutionNames)
              ? prev.institutionNames
              : [],
      };
    });

    await this.plugin.saveSettings();
  }

  private async pushListsToApiFromSettings(): Promise<void> {
    const ckPayload = (this.plugin.settings.checkinItems || []).map((x) => ({
      checkin_id: x.id.trim(),
      checkin_name: x.name.trim(),
      status: !!x.active,
    }));
    await apiTry("保存打卡清单", () => this.plugin.api.upsertCheckinTypes(ckPayload));

    const finPayload = (this.plugin.settings.financeCategories || []).map((x) => ({
      category_id: x.id.trim(),
      category_name: x.name.trim(),
      category_type: x.type,
      status: !!x.active,
      sub_categories: (x.subCategories || []).filter((sc: string) => sc && sc.trim()).map((sc: string) => sc.trim()),
      institution_names: (Array.isArray((x as any).institutionNames) ? (x as any).institutionNames : [])
        .map((s: string) => String(s ?? "").trim())
        .filter(Boolean),
    }));
    await apiTry("保存财务分类清单", () => this.plugin.api.upsertFinanceCategories(finPayload));
  }
}

type FinanceEntry = {
  type: "income" | "expense";
  catId: string;
  amount: number;
  note: string;
};
