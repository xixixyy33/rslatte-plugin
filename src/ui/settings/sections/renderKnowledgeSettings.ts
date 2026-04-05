// 知识库二级目录表（§2.3），供「发布到知识库」弹窗组合路径。
import { Notice, Setting } from "obsidian";

import {
  V2_KNOWLEDGE_OUTPUTS,
  V2_KNOWLEDGE_PERMANENT,
  V2_KNOWLEDGE_TOPICS,
} from "../../../constants/v2Directory";
import { isValidKnowledgeFolderSegment, sanitizeKnowledgeFolderSegment } from "../../../services/knowledgePaths";
import type { KnowledgeSecondarySubdirDef, KnowledgeTier1Folder } from "../../../types/knowledgeTypes";
import { DEFAULT_KNOWLEDGE_SECONDARY_SUBDIRS } from "../../../types/knowledgeTypes";

function duplicateIndex(rows: KnowledgeSecondarySubdirDef[], tier1: KnowledgeTier1Folder, folder: string, skipIdx: number): number {
  const seg = sanitizeKnowledgeFolderSegment(folder);
  return rows.findIndex(
    (r, i) => i !== skipIdx && r.tier1 === tier1 && sanitizeKnowledgeFolderSegment(r.folderName) === seg,
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderKnowledgeSettings(opts: {
  tab: any;
  makeModuleWrap: (k: any, title: string, scopeTag?: "global" | "space") => HTMLElement;
  /** 与模块管理表一致：合法 API Base URL 时才可操作 DB 同步 */
  urlCheckable: boolean;
  /** 由关→开时触发 pipeline 全量同步初始化（与打卡/输出等一致） */
  onDbSyncTurnedOn?: () => void;
  /** 保存成功后刷新空间快照与设置页 */
  afterKnowledgeDbSyncChange?: () => void | Promise<void>;
}): void {
  const { tab, makeModuleWrap, urlCheckable, onDbSyncTurnedOn, afterKnowledgeDbSyncChange } = opts;
  const plugin = tab.plugin;

  try {
    const wrap = makeModuleWrap("knowledge", "知识管理", "global");

    const kp = plugin.settings.knowledgePanel ?? { secondarySubdirs: [] };
    plugin.settings.knowledgePanel = kp;
    const rows = (kp.secondarySubdirs ??= []) as KnowledgeSecondarySubdirDef[];

    new Setting(wrap)
      .setName("与数据库同步")
      .setDesc(
        "开启后将知识库轻量索引（knowledge-index.json）同步到后端 knowledge_docs 表；需配置合法的全局 API Base URL。关闭后仅本地索引，不触达后端。",
      )
      .addToggle((tg) => {
        tg.setValue(kp.enableDbSync === true);
        tg.setDisabled(!urlCheckable);
        tg.onChange(async (v) => {
          if (!urlCheckable) return;
          const prev = kp.enableDbSync === true;
          kp.enableDbSync = v;
          const ok = await plugin.saveSettings();
          if (!ok) {
            kp.enableDbSync = prev;
            tg.setValue(prev);
            return;
          }
          if (prev === false && v) {
            onDbSyncTurnedOn?.();
          }
          try {
            await afterKnowledgeDbSyncChange?.();
          } catch {
            /* ignore */
          }
        });
      });

    wrap.createDiv({
      cls: "rslatte-muted",
      text: "一级目录固定为 31-Permanent / 32-Topics / 33-Outputs（与 v2Directory 常量一致）。此处仅维护其下的二级文件夹名；发布到知识库时组合为 30-Knowledge/<一级>/<二级>/…。",
    });

    const table = wrap.createEl("table", { cls: "rslatte-checkin-table" });
    const thead = table.createEl("thead");
    const hr = thead.createEl("tr");
    ["一级目录", "文件夹名", "说明", "排序", "操作"].forEach((h) => hr.createEl("th", { text: h }));
    const tbody = table.createEl("tbody");

    const rerender = () => tab.saveAndRerender();

    rows.forEach((row, idx) => {
      const tr = tbody.createEl("tr");

      const td1 = tr.createEl("td");
      const sel = td1.createEl("select");
      for (const [lab, val] of [
        ["31-Permanent（方法论）", V2_KNOWLEDGE_PERMANENT],
        ["32-Topics（主题）", V2_KNOWLEDGE_TOPICS],
        ["33-Outputs（对外）", V2_KNOWLEDGE_OUTPUTS],
      ] as const) {
        sel.createEl("option", { text: lab, value: val });
      }
      sel.value = row.tier1;
      sel.addEventListener("change", () => {
        row.tier1 = sel.value as KnowledgeTier1Folder;
        void tab.saveAndRefreshSidePanelDebounced();
      });

      const td2 = tr.createEl("td");
      const fn = td2.createEl("input", { type: "text", cls: "col-name" });
      fn.style.width = "100%";
      fn.value = row.folderName ?? "";
      fn.placeholder = "如 Public";
      fn.addEventListener("change", () => {
        const v = String(fn.value ?? "").trim();
        if (v && !isValidKnowledgeFolderSegment(v)) {
          new Notice("文件夹名仅允许字母数字、._- 及中文等，勿含斜杠");
          fn.value = row.folderName ?? "";
          return;
        }
        if (duplicateIndex(rows, row.tier1, v, idx) >= 0) {
          new Notice("同一一级目录下文件夹名不能重复");
          fn.value = row.folderName ?? "";
          return;
        }
        row.folderName = sanitizeKnowledgeFolderSegment(v);
        void tab.saveAndRefreshSidePanelDebounced();
      });

      const td3 = tr.createEl("td");
      const desc = td3.createEl("input", { type: "text", cls: "col-name" });
      desc.style.width = "100%";
      desc.value = row.description ?? "";
      desc.addEventListener("change", () => {
        row.description = desc.value;
        void tab.saveAndRefreshSidePanelDebounced();
      });

      const td4 = tr.createEl("td");
      const sort = td4.createEl("input", { type: "number", cls: "col-name" });
      sort.style.width = "4em";
      sort.value = String(row.sort ?? 0);
      sort.addEventListener("change", () => {
        const n = Math.floor(Number(sort.value));
        row.sort = Number.isFinite(n) ? n : 0;
        void tab.saveAndRefreshSidePanelDebounced();
      });

      const del = tr.createEl("td").createEl("button", { text: "删除", cls: "rslatte-text-btn" });
      del.onclick = async () => {
        rows.splice(idx, 1);
        await plugin.saveSettings();
        rerender();
      };
    });

    new Setting(wrap)
      .setName("添加二级目录")
      .addButton((btn) => {
        btn.setButtonText("添加一行");
        btn.onClick(async () => {
          rows.push({
            tier1: V2_KNOWLEDGE_OUTPUTS,
            folderName: "NewFolder",
            description: "",
            sort: (rows[rows.length - 1]?.sort ?? 0) + 10,
          });
          await plugin.saveSettings();
          rerender();
        });
      });

    new Setting(wrap)
      .setName("恢复默认二级目录")
      .setDesc("用方案 §2.1 种子覆盖整张表（会丢失当前自定义行）")
      .addButton((btn) => {
        btn.setButtonText("恢复默认");
        btn.buttonEl.addClass("mod-warning");
        btn.onClick(async () => {
          kp.secondarySubdirs = DEFAULT_KNOWLEDGE_SECONDARY_SUBDIRS.map((r) => ({ ...r }));
          await plugin.saveSettings();
          new Notice("已恢复默认知识库二级目录");
          rerender();
        });
      });
  } catch (e: any) {
    console.error("[RSLatte][settings][renderKnowledgeSettings] failed", e);
    try {
      new Notice("设置渲染失败（renderKnowledgeSettings）");
    } catch {
      // ignore
    }
  }
}
