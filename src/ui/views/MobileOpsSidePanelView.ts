import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import type RSLattePlugin from "../../main";
import type { MobileOp } from "../../api";
import { VIEW_TYPE_MOBILE_OPS } from "../../constants/viewTypes";

export class MobileOpsSidePanelView extends ItemView {
  private plugin: RSLattePlugin;

  constructor(leaf: WorkspaceLeaf, plugin: RSLattePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_MOBILE_OPS;
  }
  getDisplayText(): string {
    return "未同步操作队列";
  }
  getIcon(): string {
    return "smartphone";
  }

  async onOpen() {
    await this.render();
  }

  async onClose() {}

  public refresh() {
    void this.render();
  }

  private briefFromPayload(op: MobileOp): string {
    const p = op.payload as Record<string, unknown>;
    if (!p) return `${op.kind} ${op.action}`;
    if (p.text != null && String(p.text).trim()) return String(p.text).trim().slice(0, 50);
    if (p.title != null && String(p.title).trim()) return String(p.title).trim().slice(0, 50);
    if (p.record_date != null && p.checkin_id != null) return `${p.record_date} ${p.checkin_id}`;
    if (p.record_date != null && p.category_id != null) return `${p.record_date} ${p.category_id} ${p.amount ?? ""}`;
    return `${op.kind} ${op.action}`;
  }

  private formatTime(ts: string): string {
    if (!ts) return "—";
    try {
      const d = new Date(ts.replace("Z", "+00:00"));
      return d.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      return ts.slice(0, 19);
    }
  }

  private async dismissOp(op: MobileOp) {
    try {
      await this.plugin.api.markMobileOpsSynced([op.id]);
      new Notice("已标记为已检查并关闭，该条从列表移除，错误信息仍保留于后端以便回溯");
      await this.render();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice("操作失败：" + msg);
    }
  }

  private async runSyncFromMobile() {
    const syncFromMobile = (this.plugin as any).syncFromMobile;
    if (typeof syncFromMobile !== "function") {
      new Notice("当前版本不支持从手机同步");
      return;
    }
    try {
      const result = await syncFromMobile.call(this.plugin);
      if (result.errors.length > 0 && result.applied === 0) {
        new Notice(result.errors[0] || "同步失败");
      } else if (result.applied > 0) {
        new Notice(`已应用 ${result.applied} 条`);
      }
      await this.render();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice("从手机同步失败：" + msg);
    }
  }

  private async render() {
    const container = this.containerEl.children[1];
    container.empty();

    const section = container.createDiv({ cls: "rslatte-section" });
    const headerRow = section.createDiv({ cls: "rslatte-section-title-row" });
    const left = headerRow.createDiv({ cls: "rslatte-section-title-left" });
    left.createEl("h3", { text: "📱 未同步操作队列" });

    if (!this.plugin.isMobileModuleEnabledV2()) {
      const listWrap = container.createDiv({ cls: "rslatte-section rslatte-mobile-ops-timeline" });
      listWrap.createDiv({ cls: "rslatte-task-empty", text: "手机模块未启用。请在设置 → 模块管理中开启「手机」模块。" });
      return;
    }

    const actions = headerRow.createDiv({ cls: "rslatte-task-actions" });
    const syncBtn = actions.createEl("button", { text: "从手机同步", cls: "rslatte-icon-btn" });
    syncBtn.title = "拉取并应用手机端操作，失败条目仍留在此列表并展示原因";
    syncBtn.onclick = () => this.runSyncFromMobile();

    let ops: MobileOp[] = [];
    try {
      const vaultOk = await (this.plugin as any).vaultSvc?.ensureVaultReadySafe?.("mobile-ops-list");
      if (vaultOk) {
        const resp = await this.plugin.api.listMobileOps({ limit: 200 });
        ops = resp?.ops ?? [];
      }
    } catch (_) {
      // ignore
    }

    const refreshBtn = actions.createEl("button", { text: "🔄", cls: "rslatte-icon-btn" });
    refreshBtn.title = "刷新列表";
    refreshBtn.onclick = () => this.render();

    const sorted = [...ops].sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
    const listWrap = container.createDiv({ cls: "rslatte-section rslatte-mobile-ops-timeline" });

    if (sorted.length === 0) {
      listWrap.createDiv({ cls: "rslatte-task-empty", text: "暂无未同步操作（plugin_synced=false）。点击「从手机同步」拉取并应用。" });
      return;
    }

    const timeline = listWrap.createDiv({ cls: "rslatte-timeline" });
    for (const op of sorted) {
      const row = timeline.createDiv({ cls: "rslatte-timeline-item rslatte-mobile-op-row" });
      const gutter = row.createDiv({ cls: "rslatte-timeline-gutter" });
      gutter.createDiv({ cls: "rslatte-timeline-dot" });
      gutter.createDiv({ cls: "rslatte-timeline-line" });

      const content = row.createDiv({ cls: "rslatte-timeline-content" });
      const top = content.createDiv({ cls: "rslatte-timeline-title-row" });
      const timeSpan = top.createSpan({ cls: "rslatte-mobile-op-time" });
      timeSpan.setText(this.formatTime(op.ts));
      const kindBadge = top.createSpan({ cls: "rslatte-mobile-op-kind" });
      kindBadge.setText(`${op.kind} · ${op.action}`);

      const brief = content.createDiv({ cls: "rslatte-timeline-text" });
      brief.setText(this.briefFromPayload(op));

      if (op.plugin_sync_error) {
        const errWrap = content.createDiv({ cls: "rslatte-mobile-op-error" });
        errWrap.createSpan({ cls: "rslatte-mobile-op-error-label", text: "入库失败：" });
        errWrap.createSpan({ text: op.plugin_sync_error });
        const btnWrap = content.createDiv({ cls: "rslatte-mobile-op-actions" });
        const dismissBtn = btnWrap.createEl("button", { text: "检查并关闭", cls: "rslatte-icon-btn" });
        dismissBtn.title = "将该条标记为已同步（plugin_synced=true），错误信息保留于后端以便回溯";
        dismissBtn.onclick = () => this.dismissOp(op);
      }
    }
  }
}
