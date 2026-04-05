/**
 * 输出文档模板表格：供「设置 → 输出管理」与「输出侧栏 → 管理模板」弹窗共用。
 */
import { Setting } from "obsidian";
import type RSLattePlugin from "../main";
import type { OutputPanelSettings } from "../types/outputTypes";
import { EditOutputTemplateModal } from "./modals/EditOutputTemplateModal";

export type OutputTemplatesTableHooks = {
  /** 兼容旧调用方：当前模板表改为只读后不再使用 */
  afterFieldChange: () => Promise<void>;
  /** 增删行后：设置页需整页重绘；弹窗可重挂载本表格 */
  afterStructuralChange?: () => Promise<void>;
  /** 是否显示底部“新增模板”行（默认 true） */
  showAddControl?: boolean;
};

export function mountOutputTemplatesSection(
  outputWrap: HTMLElement,
  plugin: RSLattePlugin,
  hooks: OutputTemplatesTableHooks
): void {
  const op = plugin.settings.outputPanel ?? ({} as OutputPanelSettings);
  if (!plugin.settings.outputPanel) {
    (plugin.settings as any).outputPanel = op;
  }

  outputWrap.createEl("h4", { text: "输出文档模板清单" });
  outputWrap.createDiv({
    cls: "rslatte-muted",
    text: "每条「一般」模板可出现在侧栏快速创建；「项目」模板仅在项目侧栏「创建项目存档文件」中选择。该表为只读预览，请在操作列点击「编辑」打开单独弹窗修改。tags 固定为 output，不在此处维护。",
  });

  const templates = (op.templates ?? []) as any[];
  op.templates = templates;
  const templateRootRel = "00-System/01-Templates";
  const outputRootRel = String(op.archiveRoots?.[0] ?? "00-Inbox").trim();

  const stripPrefixForDisplay = (raw: string, prefix: string): string => {
    const v = String(raw ?? "").trim().replace(/\\/g, "/");
    const p = String(prefix ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!v || !p) return v;
    if (v === p) return "/";
    if (v.startsWith(p + "/")) return v.slice(p.length + 1);
    return v;
  };

  const ensureTplId = (tpl: any) => {
    if (tpl.id) return;
    tpl.id = `OT_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  };

  const table = outputWrap.createEl("table", { cls: "rslatte-checkin-table rslatte-output-templates-table" });
  const thead = table.createEl("thead");
  const hr = thead.createEl("tr");
  const headers = ["启用", "范围", "项目内路径", "按钮名称", "文档分类", "文档模板", "存档目录", "type", "操作"] as const;
  headers.forEach((h) => hr.createEl("th", { text: h }));
  const tbody = table.createEl("tbody");

  const renderTplRow = (tpl: any, idx: number) => {
    ensureTplId(tpl);
    if (tpl.templateScope !== "general" && tpl.templateScope !== "project") {
      tpl.templateScope = "general";
    }
    if (tpl.enabled === undefined) tpl.enabled = true;

    const tr = tbody.createEl("tr");
    const mkCell = (label: string) => {
      const td = tr.createEl("td");
      td.setAttr("data-label", label);
      return td;
    };

    const mkReadonly = (td: HTMLElement, val: string) => {
      td.createDiv({
        cls: "rslatte-output-template-readonly",
        text: String(val ?? "").trim() || "—",
      });
    };

    // 启用
    const tdEn = mkCell("启用");
    mkReadonly(tdEn, tpl.enabled === false ? "否" : "是");

    // 范围 general | project
    const tdSc = mkCell("范围");
    mkReadonly(tdSc, tpl.templateScope === "project" ? "项目" : "一般");

    const tdRel = mkCell("项目内路径");
    mkReadonly(tdRel, tpl.projectTargetRelPath || "");
    mkReadonly(mkCell("按钮名称"), tpl.buttonName || "");
    mkReadonly(mkCell("文档分类"), tpl.docCategory || "");
    mkReadonly(mkCell("文档模板"), stripPrefixForDisplay(tpl.templatePath || "", templateRootRel));
    mkReadonly(mkCell("存档目录"), stripPrefixForDisplay(tpl.archiveDir || "", outputRootRel));
    mkReadonly(mkCell("type"), tpl.type || "");

    const tdOps = mkCell("操作");
    const edit = tdOps.createEl("button", { text: "编辑", cls: "rslatte-text-btn" });
    edit.onclick = () => {
      new EditOutputTemplateModal(plugin.app, plugin, idx, async () => {
        await hooks.afterStructuralChange?.();
      }).open();
    };
    const del = tdOps.createEl("button", { text: "删除", cls: "rslatte-text-btn" });
    del.onclick = () => {
      const label = String(tpl.buttonName || tpl.docCategory || tpl.id || "该模板").trim();
      const ok = window.confirm(`确认删除模板「${label}」吗？此操作不可撤销。`);
      if (!ok) return;
      templates.splice(idx, 1);
      void plugin.saveSettings();
      hooks.afterStructuralChange?.();
    };
  };

  templates.forEach((tpl, idx) => renderTplRow(tpl, idx));

  if (hooks.showAddControl !== false) {
    new Setting(outputWrap)
      .setName("新增模板")
      .setDesc("添加一条输出文档模板记录")
      .addButton((btn) => {
        btn.setButtonText("添加");
        btn.setCta();
        btn.onClick(async () => {
          templates.push({
            id: `OT_${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
            buttonName: "新建",
            docCategory: "输出",
            templatePath: "",
            archiveDir: (op.archiveRoots?.[0] ?? "00-Inbox"),
            tags: ["output"],
            type: "",
            templateScope: "general",
            enabled: true,
            projectTargetRelPath: "",
          });
          await plugin.saveSettings();
          hooks.afterStructuralChange?.();
        });
      });
  }
}
