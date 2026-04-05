import { App, ButtonComponent, Modal, Notice } from "obsidian";

import type RSLattePlugin from "../../main";
import {
  canMarkPluginEnvInitComplete,
  fixEnvMissingDirectories,
  fixEnvMissingTemplate,
  getTemplateBodyForPath,
  openObsidianCommunityPluginsTab,
  openObsidianCorePluginsTab,
  openObsidianSettingsTab,
  runPluginEnvChecks,
  type EnvCheckItem,
  type EnvCheckStatus,
} from "../../services/envCheck/pluginEnvCheck";

/**
 * 设置页「插件初始化环境检查」：展示检测项、手动确认勾选项、一键创建目录/模板。
 */
export class PluginEnvCheckModal extends Modal {
  private items: EnvCheckItem[] = [];
  private manualChecked = new Set<string>();
  private completeEnvBtn: ButtonComponent | null = null;
  private dirBatchBtn: ButtonComponent | null = null;
  private tplBatchBtn: ButtonComponent | null = null;

  constructor(
    app: App,
    private plugin: RSLattePlugin,
    /** 初始化成功并保存后回调，用于刷新设置页（否则「模块管理」等仍按旧门禁状态置灰） */
    private readonly onAfterEnvInitComplete?: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("rslatte-modal", "rslatte-env-check-modal");

    this.titleEl.setText("插件初始化环境检查");
    contentEl.createDiv({
      cls: "rslatte-muted",
      text: "尽量自动检测 Obsidian「文件与链接」五项，并建议启用核心插件「工作区」。目录与模板均为强制项，须全部通过后才能点「完成初始化」。请按顺序：先高亮的一键创建目录，再一键创建模板（目录未通过时模板按钮会置灰）。推荐社区插件仅为建议。改完设置或磁盘后请点「重新检测」。",
    });

    const toolbar = contentEl.createDiv({ cls: "rslatte-env-check-toolbar" });
    new ButtonComponent(toolbar).setButtonText("重新检测").setCta().onClick(() => {
      this.refreshBody();
    });
    contentEl.createDiv({
      cls: "rslatte-env-check-recheck-hint rslatte-muted",
      text: "提示：凡在 Obsidian「设置」或资源管理器中的手动操作，完成后都需再点「重新检测」才会更新状态。",
    });

    this.bodyEl = contentEl.createDiv({ cls: "rslatte-env-check-body" });

    const batch = contentEl.createDiv({ cls: "rslatte-env-check-batch" });
    batch.createDiv({
      cls: "rslatte-muted",
      text: "批量：有缺失时对应按钮会高亮；无缺失则置灰。须先补齐目录，再创建模板。",
    });
    const batchBtns = batch.createDiv({ cls: "rslatte-env-check-actions" });
    this.dirBatchBtn = new ButtonComponent(batchBtns)
      .setButtonText("一键创建全部缺失目录（含知识库二级）")
      .onClick(() => void this.onFixDirectories());
    this.tplBatchBtn = new ButtonComponent(batchBtns)
      .setButtonText("一键创建全部缺失模板")
      .onClick(() => void this.onFixTemplates());

    const footer = contentEl.createDiv({ cls: "rslatte-env-check-footer" });
    footer.createDiv({
      cls: "rslatte-muted",
      text: "Obsidian 强制项、全部目录与模板强制项均通过后，点击下方高亮按钮确认完成初始化。未满足时该按钮置灰。若无法自动读取 Obsidian 配置，请先勾选上方「人工确认」项。",
    });
    this.completeEnvBtn = new ButtonComponent(footer).setButtonText("完成初始化（启用模块）");
    this.completeEnvBtn.onClick(() => void this.onCompleteInit());

    this.refreshBody();
  }

  private bodyEl!: HTMLDivElement;

  private refreshCompleteButtonState(): void {
    if (!this.completeEnvBtn) return;
    const manualOk = this.manualChecked.has("obs_manual_files_links");
    const can = canMarkPluginEnvInitComplete(this.app, this.plugin, manualOk);
    this.completeEnvBtn.setDisabled(!can);
    this.completeEnvBtn.buttonEl.toggleClass("mod-cta", can);
  }

  /** 是否存在未通过的目录强制项 */
  private directoriesNeedFix(): boolean {
    return this.items.some((x) => x.category === "directory" && x.status !== "ok");
  }

  /** 是否存在可通过批量创建的缺失模板 */
  private templatesBatchFixable(): boolean {
    return this.items.some((x) => x.category === "template" && !!x.fixTemplatePath);
  }

  private refreshBatchButtonsState(): void {
    const dirsNeed = this.directoriesNeedFix();
    const tplCan = this.templatesBatchFixable();
    const dirsOk = !dirsNeed;

    if (this.dirBatchBtn) {
      this.dirBatchBtn.setDisabled(!dirsNeed);
      this.dirBatchBtn.buttonEl.toggleClass("mod-cta", dirsNeed);
    }
    if (this.tplBatchBtn) {
      const tplActive = dirsOk && tplCan;
      this.tplBatchBtn.setDisabled(!tplActive);
      this.tplBatchBtn.buttonEl.toggleClass("mod-cta", tplActive);
    }
  }

  private refreshBody(): void {
    this.items = runPluginEnvChecks(this.app, this.plugin);
    this.bodyEl.empty();

    const groups: Record<string, EnvCheckItem[]> = {};
    for (const it of this.items) {
      groups[it.category] = groups[it.category] ?? [];
      groups[it.category].push(it);
    }

    const order: EnvCheckItem["category"][] = ["obsidian", "directory", "template", "plugin"];
    const titles: Record<string, string> = {
      obsidian: "1. Obsidian 环境与建议（含「文件与链接」）",
      directory: "2. 目录检查（设置与 V2 结构）",
      template: "3. 模板检查（Markdown / Canvas，强制）",
      plugin: "4. 推荐社区插件（建议）",
    };

    for (const cat of order) {
      const list = groups[cat];
      if (!list?.length) continue;
      this.bodyEl.createEl("h3", { text: titles[cat] ?? cat, cls: "rslatte-env-check-h3" });
      for (const it of list) {
        this.renderRow(it);
      }
    }
    this.refreshBatchButtonsState();
    this.refreshCompleteButtonState();
  }

  private renderRow(it: EnvCheckItem): void {
    const row = this.bodyEl.createDiv({ cls: "rslatte-env-check-row" });
    row.addClass(`rslatte-env-check-row--${it.status}`);
    if (it.blocking && it.status === "fail") row.addClass("rslatte-env-check-row--blocking-fail");

    const head = row.createDiv({ cls: "rslatte-env-check-row-head" });
    head.createSpan({ cls: "rslatte-env-check-badge", text: statusLabel(it.status, it.blocking) });
    head.createSpan({ cls: "rslatte-env-check-title", text: it.title });

    row.createDiv({ cls: "rslatte-env-check-msg", text: it.message });
    if (it.detail) {
      row.createDiv({ cls: "rslatte-env-check-detail rslatte-muted", text: it.detail });
    }

    if (it.status === "manual") {
      const id = it.id;
      const lab = row.createEl("label", { cls: "rslatte-env-check-manual" });
      const cb = lab.createEl("input");
      cb.type = "checkbox";
      cb.checked = this.manualChecked.has(id);
      cb.onchange = () => {
        if (cb.checked) this.manualChecked.add(id);
        else this.manualChecked.delete(id);
        this.refreshCompleteButtonState();
      };
      lab.appendText(" 我已按说明自行确认（改完后请点「重新检测」）");
    }

    const actions = row.createDiv({ cls: "rslatte-env-check-row-actions" });
    if (it.category === "obsidian") {
      if (it.id !== "obs_core_workspaces") {
        new ButtonComponent(actions).setButtonText("打开「文件与链接」").onClick(() => {
          const app = this.app;
          // 从「设置 → 插件」里再打开 Modal 时，不先关掉弹窗可能导致 setting.open 被挡住或焦点异常
          this.close();
          window.setTimeout(() => openObsidianSettingsTab(app, "file"), 10);
        });
      } else {
        new ButtonComponent(actions).setButtonText("打开「核心插件」").onClick(() => {
          this.close();
          // 与关闭弹窗、设置页重绘错开；openObsidianCorePluginsTab 内另有延迟重试
          window.setTimeout(() => openObsidianCorePluginsTab(this.app), 30);
        });
      }
    }
    if (it.category === "plugin") {
      new ButtonComponent(actions).setButtonText("打开「第三方插件」").onClick(() => {
        this.close();
        window.setTimeout(() => openObsidianCommunityPluginsTab(this.app), 10);
      });
    }
    if (it.category === "template" && it.fixTemplatePath) {
      const dirOk = !this.directoriesNeedFix();
      const rowTpl = new ButtonComponent(actions).setButtonText("创建此模板");
      rowTpl.setDisabled(!dirOk);
      if (!dirOk) rowTpl.buttonEl.title = "请先完成「一键创建全部缺失目录」";
      rowTpl.onClick(() => void this.onFixOneTemplate(it.fixTemplatePath!));
    }
    if (!actions.childElementCount) actions.remove();
  }

  private async onFixOneTemplate(rel: string): Promise<void> {
    if (this.directoriesNeedFix()) {
      new Notice("请先完成「一键创建全部缺失目录」，再创建模板。");
      return;
    }
    try {
      const body = getTemplateBodyForPath(this.plugin.settings, rel);
      if (body == null) {
        new Notice("无法匹配模板类型，请先在设置中配置对应模板路径");
        return;
      }
      await fixEnvMissingTemplate(this.app, rel, body);
      new Notice("已尝试创建该模板文件");
      this.refreshBody();
    } catch (e: any) {
      new Notice(`创建模板失败：${e?.message ?? String(e)}`);
    }
  }

  private async onFixDirectories(): Promise<void> {
    const missing = this.items.filter((x) => x.fixDirPath && x.status !== "ok").map((x) => x.fixDirPath!);
    if (!missing.length) {
      new Notice("没有需要创建的目录");
      return;
    }
    try {
      await fixEnvMissingDirectories(this.app, this.plugin, missing);
      new Notice(`已尝试创建 ${missing.length} 条路径（含知识库树）`);
      this.refreshBody();
    } catch (e: any) {
      new Notice(`创建目录失败：${e?.message ?? String(e)}`);
    }
  }

  private async onCompleteInit(): Promise<void> {
    const manualOk = this.manualChecked.has("obs_manual_files_links");
    if (!canMarkPluginEnvInitComplete(this.app, this.plugin, manualOk)) {
      new Notice("仍有未满足的强制项：请按说明修复后点「重新检测」，或在无法自动检测时勾选人工确认项。");
      return;
    }
    const s: any = this.plugin.settings as any;
    s.pluginEnvInitGateCompleted = true;
    const hasGetConfig = typeof (this.app.vault as any).getConfig === "function";
    if (!hasGetConfig) s.envObsidianFilesLinksManualAck = true;
    const ok = await this.plugin.saveSettings();
    if (!ok) return;
    new Notice("初始化已完成，模块将按「模块管理」中的开关启用。");
    try {
      this.plugin.refreshSidePanel?.();
    } catch {
      /* ignore */
    }
    this.close();
    const refresh = this.onAfterEnvInitComplete;
    if (refresh) {
      window.setTimeout(() => {
        try {
          refresh();
        } catch (e) {
          console.warn("[RSLatte] onAfterEnvInitComplete failed", e);
        }
      }, 0);
    }
  }

  private async onFixTemplates(): Promise<void> {
    if (this.directoriesNeedFix()) {
      new Notice("请先完成「一键创建全部缺失目录」，再创建模板。");
      return;
    }
    const targets = this.items.filter((x) => x.fixTemplatePath && x.category === "template");
    if (!targets.length) {
      new Notice("没有需要创建的模板文件");
      return;
    }
    let n = 0;
    try {
      for (const t of targets) {
        const p = t.fixTemplatePath!;
        const body = getTemplateBodyForPath(this.plugin.settings, p);
        if (body == null) continue;
        await fixEnvMissingTemplate(this.app, p, body);
        n++;
      }
      new Notice(`已尝试创建 ${n} 个模板文件`);
      this.refreshBody();
    } catch (e: any) {
      new Notice(`创建模板失败：${e?.message ?? String(e)}`);
    }
  }

  onClose(): void {
    this.completeEnvBtn = null;
    this.dirBatchBtn = null;
    this.tplBatchBtn = null;
    this.contentEl.empty();
  }
}

function statusLabel(s: EnvCheckStatus, blocking?: boolean): string {
  switch (s) {
    case "ok":
      return "通过";
    case "warn":
      return "建议";
    case "fail":
      return blocking ? "未过" : "缺失";
    case "manual":
      return "人工";
    default:
      return s;
  }
}
