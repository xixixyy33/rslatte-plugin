import { App, ItemView, Notice, TFile, TFolder, WorkspaceLeaf, moment, normalizePath } from "obsidian";
import type RSLattePlugin from "../../main";

const momentFn = moment as any;
import { VIEW_TYPE_CONTACTS, VIEW_TYPE_TASKS, VIEW_TYPE_PROJECTS } from "../../constants/viewTypes";
import { getUiHeaderButtonsVisibility } from "../helpers/uiHeaderButtons";
import { appendDbSyncIndicator, createHeaderRow } from "../helpers/moduleHeader";
import type { ContactIndexItem, ContactsIndexFile, ContactsInteractionEntry, ContactsInteractionSourceType } from "../../contactsRSLatte/types";
import { bucketFromSortname, computeSortname } from "../../contactsRSLatte/sortname";
import { AddContactModal } from "../modals/AddContactModal";
import { EditContactModal } from "../modals/EditContactModal";
import { AddContactManualEventModal } from "../modals/AddContactManualEventModal";
import { replaceContactDynamicGeneratedBlock } from "../../services/contacts/contactNoteWriter";
import { renderTextWithContactRefs } from "../helpers/renderTextWithContactRefs";

type StatusFilter = "all" | "active" | "cancelled";

function isTruthyStr(v: any): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function normLower(s: string): string {
  return (s ?? "").toLowerCase();
}

function firstInitial(name: string): string {
  const s = (name ?? "").trim();
  if (!s) return "?";
  // Chinese or other scripts: first char is ok.
  return s.slice(0, 1).toUpperCase();
}

export class ContactsSidePanelView extends ItemView {
  private plugin: RSLattePlugin;

  private q: string = "";
  // Draft query text in the input box. Commit to `q` only on explicit search action.
  // This prevents refresh() from re-rendering the input on every key stroke, which breaks
  // IME (e.g. Chinese) composition and can cause the "only one letter" symptom.
  private qDraft: string = "";
  private group: string = "All";
  private status: StatusFilter = "active";
  private selectedUid: string | null = null;

  // Step5: dynamic interactions filters (read from .rslatte/contacts-interactions.json)
  private dynLimit: number = 20;
  private dynIncompleteOnly: boolean = false;
  private dynSourceType: ContactsInteractionSourceType | "all" = "all";

  // Step6: avoid overlapping writes to contact note generated block
  private dynMdWriteInFlight: Set<string> = new Set();

  // Step6: avoid repeated note writes during rapid UI refresh.
  private dynBlockWriteInFlight: Set<string> = new Set();

  // Prevent overlapping async refresh() calls from rendering twice (causing duplicated UI)
  private refreshRunning: boolean = false;
  private refreshPending: boolean = false;
  private refreshSeq: number = 0;

  constructor(leaf: WorkspaceLeaf, plugin: RSLattePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CONTACTS;
  }

  getDisplayText(): string {
    return "联系人管理";
  }

  getIcon(): string {
    return "user";
  }

  async onOpen() {
    void this.refresh();
  }

  async onClose() {
    // nothing
  }

  private isModuleEnabled(): boolean {
    const me2: any = (this.plugin.settings as any)?.moduleEnabledV2 ?? {};
    return !!me2.contacts;
  }

  private getContactsDir(): string {
    const sAny: any = this.plugin.settings as any;
    return String(sAny?.contactsModule?.contactsDir ?? "90-Contacts");
  }

  private getArchiveDir(): string {
    const sAny: any = this.plugin.settings as any;
    const contactsDir = normalizePath((this.getContactsDir() ?? "").trim() || "90-Contacts");
    const defArc = normalizePath(`${contactsDir}/_archived`);
    return normalizePath(String(sAny?.contactsModule?.archiveDir ?? defArc));
  }

  /** If archiveDir is inside contactsDir, return its top-level folder name; otherwise null. */
  private getArchiveFolderNameIfInsideRoot(): string | null {
    const rootPath = normalizePath((this.getContactsDir() ?? "").trim() || "90-Contacts");
    const arc = normalizePath((this.getArchiveDir() ?? "").trim());
    if (!arc || arc === rootPath) return null;
    if (!arc.startsWith(rootPath + "/")) return null;
    const rest = arc.slice(rootPath.length + 1);
    const seg = (rest.split("/")[0] ?? "").trim();
    return seg || null;
  }

  private async listGroupsFromDir(app: App): Promise<string[]> {
    const rootPath = normalizePath((this.getContactsDir() ?? "").trim() || "90-Contacts");
    const af = app.vault.getAbstractFileByPath(rootPath);
    if (!af || !(af instanceof TFolder)) return [];

    const archiveFolderName = this.getArchiveFolderNameIfInsideRoot();

    const out: string[] = [];
    for (const c of af.children) {
      if (!(c instanceof TFolder)) continue;
      const n = c.name ?? "";
      if (!n) continue;
      if (n === ".attachments" || n === ".rslatte") continue;
      if (archiveFolderName && n === archiveFolderName) continue;
      if (n.startsWith(".")) continue;
      out.push(n);
    }
    out.sort((a, b) => a.localeCompare(b));
    return out;
  }

  private async readIndex(): Promise<ContactsIndexFile> {
    try {
      return await this.plugin.contactsIndex.getIndexStore().readIndex();
    } catch {
      return { version: 1, updatedAt: new Date().toISOString(), items: [], parseErrorFiles: [] };
    }
  }

  private filterItems(items: ContactIndexItem[]): ContactIndexItem[] {
    const q = normLower(this.q.trim());
    const group = this.group;
    const status = this.status;

    const matchQ = (it: ContactIndexItem) => {
      if (!q) return true;
      const name = normLower(it.display_name ?? "");
      const aliases = (it.aliases ?? []).map(normLower);
      const tags = (it.tags ?? []).map(normLower);
      return (
        name.includes(q) ||
        aliases.some((a) => a.includes(q)) ||
        tags.some((t) => t.includes(q))
      );
    };

    const matchGroup = (it: ContactIndexItem) => {
      if (!group || group === "All") return true;
      return String(it.group_name ?? "").trim() === group;
    };

    const matchStatus = (it: ContactIndexItem) => {
      const s = String(it.status ?? "active").trim() || "active";
      if (status === "all") return true;
      if (status === "active") return s !== "cancelled";
      return s === "cancelled";
    };

    const out = items.filter((it) => matchQ(it) && matchGroup(it) && matchStatus(it));
    const sortKey = (it: ContactIndexItem): string => {
      const sn = String(it.sortname ?? "").trim();
      return (sn || computeSortname(it.display_name ?? "") || it.display_name || it.contact_uid || "").toUpperCase();
    };
    out.sort((a, b) => {
      const ak = sortKey(a);
      const bk = sortKey(b);
      const c = ak.localeCompare(bk);
      if (c !== 0) return c;
      return (a.display_name ?? "").localeCompare(b.display_name ?? "");
    });
    return out;
  }

  private resolveAvatarResource(it: ContactIndexItem): string | null {
    const avatarRel = (it.avatar_path ?? "").trim();
    if (!avatarRel) return null;

    const folder = it.file_path.split("/").slice(0, -1).join("/");
    const full = normalizePath(`${folder}/${avatarRel}`);
    const af = this.app.vault.getAbstractFileByPath(full);
    if (af && af instanceof TFile) {
      return this.app.vault.getResourcePath(af);
    }
    return null;
  }

  private async openContactFile(it: ContactIndexItem): Promise<void> {
    const af = this.app.vault.getAbstractFileByPath(it.file_path);
    if (!af || !(af instanceof TFile)) {
      new Notice("无法打开：联系人文件不存在");
      return;
    }
    await this.app.workspace.getLeaf("tab").openFile(af);
  }

  private getContactFile(it: ContactIndexItem): TFile | null {
    const af = this.app.vault.getAbstractFileByPath(it.file_path);
    if (!af || !(af instanceof TFile)) return null;
    return af;
  }

  private async openEditModal(it: ContactIndexItem): Promise<void> {
    const f = this.getContactFile(it);
    if (!f) {
      new Notice("无法编辑：联系人文件不存在");
      return;
    }
    new EditContactModal(this.app, this.plugin, f, {
      onUpdated: async () => {
        const r = await this.plugin.rebuildContactsIndex();
        if ((r as any)?.ok) {
          this.plugin.refreshSidePanel();
        }
      },
    }).open();
  }

  // --------------------------------
  // Step5: Dynamic interactions (read-only)
  // --------------------------------

  private statusIconForInteraction(e: ContactsInteractionEntry): string {
    const st = String(e.status ?? "").trim();
    if (!st) return "•";
    switch (st) {
      case "done": return "✅";
      case "cancelled": return "⛔";
      case "in_progress": return "▶️";
      case "blocked": return "🛑";
      case "todo": return "⬜";
      default: return "❔";
    }
  }

  private truncateText(s: string, maxLen: number): string {
    const t = String(s ?? "");
    if (t.length <= maxLen) return t;
    return t.slice(0, Math.max(0, maxLen - 1)) + "…";
  }

  /**
   * Normalize interaction snippet for display.
   * - Remove markdown task checkbox prefix like "- [ ]", "- [x]", "- [/]".
   * - Keep the rest of the line intact (including contact pills).
   */
  private normalizeInteractionSnippetForDisplay(s: string): string {
    const t = String(s ?? "");
    return t.replace(/^\s*[-*+]\s*\[[^\]]*\]\s*/u, "");
  }

  private sourceShortLabel(path: string): string {
    const p = String(path ?? "");
    const seg = p.split("/").pop() ?? p;
    return seg || p;
  }

  private async openInteractionSource(e: ContactsInteractionEntry): Promise<void> {
    const p = String(e.source_path ?? "").trim();
    if (!p) return;
    
    const sourceType = String(e.source_type ?? "").trim();
    const ln1 = Number(e.line_no ?? 0);
    
    // 如果是任务类型，跳转到任务侧边栏并定位到对应任务
    if (sourceType === "task" && ln1 >= 0) {
      try {
        // 激活任务侧边栏
        await this.plugin.activateTaskView();
        
        // 获取任务侧边栏视图实例
        const taskLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TASKS);
        if (taskLeaves.length > 0) {
          const taskView = taskLeaves[0].view as any;
          if (taskView && typeof taskView.scrollToTask === "function") {
            // 等待一小段时间确保视图已渲染
            await new Promise(resolve => setTimeout(resolve, 100));
            await taskView.scrollToTask(p, ln1);
            return;
          }
        }
      } catch (err: any) {
        console.warn("[RSLatte][contacts] Failed to jump to task view:", err);
        // 如果跳转失败，fallback 到打开文件
      }
    }
    
    // 如果是项目任务类型，跳转到项目侧边栏并定位到对应项目
    if (sourceType === "project_task") {
      try {
        // 从项目任务清单文件路径推断项目文件夹路径
        // 项目任务清单文件路径格式：${folderPath}/项目任务清单.md
        const normalizedPath = normalizePath(p);
        let projectFolderPath: string | null = null;
        
        // 尝试匹配 "项目任务清单.md" 结尾
        if (normalizedPath.endsWith("/项目任务清单.md") || normalizedPath.endsWith("\\项目任务清单.md")) {
          projectFolderPath = normalizedPath.replace(/[/\\]项目任务清单\.md$/i, "");
        } else if (normalizedPath.endsWith("项目任务清单.md")) {
          // 处理没有斜杠的情况（理论上不应该发生）
          projectFolderPath = normalizedPath.replace(/项目任务清单\.md$/i, "");
        }
        
        if (projectFolderPath) {
          // 尝试从项目管理服务获取任务的完整里程碑路径
          let milestonePath: string | undefined = undefined;
          
          try {
            // 从项目管理服务获取项目快照
            const snap = this.plugin.projectMgr?.getSnapshot?.();
            if (snap?.projects) {
              // 查找对应的项目
              const normalizedProjectPath = normalizePath(projectFolderPath);
              const project = snap.projects.find((p: any) => 
                normalizePath(String(p.folderPath ?? "")) === normalizedProjectPath
              );
              
              if (project && project.taskItems && ln1 >= 0) {
                // 查找对应行号的任务
                const task = project.taskItems.find((t: any) => 
                  Number(t.lineNo ?? -1) === ln1 && 
                  normalizePath(String(t.sourceFilePath ?? project.tasklistFilePath ?? "")) === normalizedPath
                );
                
                if (task && task.milestonePath) {
                  milestonePath = String(task.milestonePath).trim();
                } else if (task && task.milestone) {
                  // 如果没有 milestonePath，使用 milestone 字段
                  milestonePath = String(task.milestone).trim();
                }
              }
            }
          } catch (err: any) {
            // 如果获取失败，尝试使用 heading 字段作为后备
            if (this.plugin.isDebugLogEnabled()) {
              console.warn("[RSLatte][contacts] Failed to get milestone path from project manager:", err);
            }
          }
          
          // 如果仍然没有里程碑路径，尝试使用 heading 字段
          if (!milestonePath) {
            const heading = String(e.heading ?? "").trim();
            if (heading) {
              milestonePath = heading;
            }
          }
          
          // 激活项目侧边栏
          await this.plugin.activateProjectView();
          
          // 获取项目侧边栏视图实例
          const projectLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PROJECTS);
          if (projectLeaves.length > 0) {
            const projectView = projectLeaves[0].view as any;
            if (projectView && typeof projectView.scrollToProject === "function") {
              // 等待一小段时间确保视图已渲染
              await new Promise(resolve => setTimeout(resolve, 100));
              // 传递任务文件路径和行号，以便定位到具体的任务项
              await projectView.scrollToProject(projectFolderPath, milestonePath, normalizedPath, ln1);
              return;
            }
          }
        }
      } catch (err: any) {
        console.warn("[RSLatte][contacts] Failed to jump to project view:", err);
        // 如果跳转失败，fallback 到打开文件
      }
    }
    
    // 非任务类型或跳转失败时，打开源文件
    const af = this.app.vault.getAbstractFileByPath(p);
    if (!af || !(af instanceof TFile)) {
      new Notice("无法打开：源文件不存在");
      return;
    }

    // Prefer line-based jump so the user lands close to the task/paragraph.
    try {
      if (ln1 > 0 && (this.plugin as any).noteNav?.openNoteAtLineAndParagraphEnd) {
        await (this.plugin as any).noteNav.openNoteAtLineAndParagraphEnd(p, ln1);
        return;
      }
      if (ln1 > 0 && (this.plugin as any).noteNav?.openNoteAtLine) {
        await (this.plugin as any).noteNav.openNoteAtLine(p, ln1);
        return;
      }
    } catch {
      // fallthrough
    }

    await this.app.workspace.getLeaf("tab").openFile(af);
  }

  private async readDynamicInteractionsForSelected(): Promise<ContactsInteractionEntry[]> {
    if (!this.selectedUid) return [];
    try {
      const st = this.plugin.contactsIndex.getInteractionsStore();
      return await st.queryByContactUid(this.selectedUid, {
        limit: this.dynLimit,
        incompleteOnly: this.dynIncompleteOnly,
        sourceType: this.dynSourceType,
      });
    } catch {
      return [];
    }
  }

  private openManualEventModal(it: ContactIndexItem): void {
    const filePath = String(it.file_path ?? "").trim();
    if (!filePath) {
      new Notice("联系人文件路径为空，无法记互动");
      return;
    }
    new AddContactManualEventModal(this.app, this.plugin, it, filePath, {
      onSaved: () => {
        // No need to rebuild contacts index (frontmatter unchanged).
        // Keep UI responsive; user can open note to verify.
      },
    }).open();
  }

  // --------------------------------
  // Step6: Mirror dynamic summary into contact note (controlled generated block)
  // --------------------------------

  private async refreshDynamicSummaryBlockForContact(it: ContactIndexItem): Promise<void> {
    const uid = String(it?.contact_uid ?? "").trim();
    if (!uid) return;
    if (this.dynMdWriteInFlight.has(uid)) return;

    const f = this.getContactFile(it);
    if (!f) return;

    this.dynMdWriteInFlight.add(uid);
    try {
      const st = this.plugin.contactsIndex.getInteractionsStore();
      const entries = await st.queryByContactUid(uid, { limit: 20, incompleteOnly: false, sourceType: "all" });

      const items = (entries ?? []).map((e) => ({
        statusIcon: this.statusIconForInteraction(e),
        source_type: String(e.source_type ?? "").trim(),
        snippet: String(e.snippet ?? ""),
        source_path: String(e.source_path ?? ""),
        line_no: typeof e.line_no === "number" ? e.line_no : Number(e.line_no ?? 0) || undefined,
        heading: String(e.heading ?? "").trim() || undefined,
      }));

      const sAny: any = this.plugin.settings as any;
      const cm: any = sAny?.contactsModule ?? {};
      const sectionHeader = String(cm.eventSectionHeader ?? cm.manualEventSectionHeader ?? "## 互动记录").trim() || "## 互动记录";
      const subHeader = String(cm.dynamicEventSubHeader ?? "### 动态互动").trim();

      await replaceContactDynamicGeneratedBlock(this.app, f, items, { limit: 20, sectionHeader, subHeader });
    } catch (e: any) {
      console.warn("[RSLatte][contacts] refresh dynamic block failed", e);
    } finally {
      this.dynMdWriteInFlight.delete(uid);
    }
  }

  private triggerSearch(nextQ: string) {
    void this.commitSearch(nextQ);
  }

  private async commitSearch(nextQ: string) {
    // Keep draft in sync so re-render preserves latest user input.
    this.qDraft = String(nextQ ?? "");
    this.q = this.qDraft.trim();
    this.selectedUid = null;
    await this.refresh();
  }

  private renderHeader(container: HTMLElement, index: ContactsIndexFile, groups: string[]) {
    const sec = container.createDiv({ cls: "rslatte-section" });
    // Header row layout should align with other side panels:
    // Left: title + db-sync light; Right: compact icon buttons.
    const { left, right: actions } = createHeaderRow(
      sec,
      "rslatte-section-title-row",
      "rslatte-section-title-left",
      "rslatte-task-actions",
    );
    left.createEl("h3", { text: "🪪 联系人" });
    actions.addClass("rslatte-contacts-actions");

    // DB 同步状态灯（与其他模块对齐）
    try {
      const ind = this.plugin.getDbSyncIndicator("contacts");
      appendDbSyncIndicator(left, ind);
    } catch {
      // ignore
    }

    const addBtn = actions.createEl("button", { text: "➕", cls: "rslatte-icon-btn" });
    addBtn.title = "新增联系人";
    addBtn.onclick = () => {
      new AddContactModal(this.app, this.plugin, {
        onCreated: async () => {
          // best effort: rebuild index & refresh UI
          const r = await this.plugin.rebuildContactsIndex();
          if ((r as any)?.ok) {
            this.plugin.refreshSidePanel();
          }
        },
      }).open();
    };

    

    const btnVis = getUiHeaderButtonsVisibility(this.plugin.settings, "contacts");

    
    if (btnVis.rebuild) {
      const rebuildBtn = actions.createEl("button", { text: "🧱", cls: "rslatte-icon-btn" });
      rebuildBtn.title = "重建联系人索引（全量扫描）";
      rebuildBtn.onclick = async () => {
        new Notice("开始重建：联系人…");
        try {
          const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "contacts", "rebuild");
          if (r.ok) {
            if (r.data?.skipped) {
              new Notice("联系人重建：已跳过（门控/互斥）");
            } else {
              new Notice("联系人重建完成");
            }
          } else {
            new Notice(`联系人重建失败：${(r as any)?.error ?? "unknown"}`);
          }
        } catch (e: any) {
          new Notice(`联系人重建失败：${e?.message ?? e}`);
          console.warn("[RSLatte][contacts] rebuild failed", e);
        } finally {
          await this.refresh();
        }
      };
    }


    if (btnVis.archive) {
      const archiveBtn = actions.createEl("button", { text: "🗄", cls: "rslatte-icon-btn" });
      archiveBtn.title = "立即归档（仅 cancelled 且超阈值）";
      archiveBtn.onclick = async () => {
        try {
          const r: any = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "contacts", "manual_archive");
          const data: any = (r as any)?.data;
          const summary: any = data?.summary;
          const archivedCount = Number(summary?.metrics?.archivedCount ?? summary?.metrics?.movedCount ?? 0);
          if ((r as any)?.ok && data?.skipped) {
            new Notice("归档跳过：已有任务在运行中");
          } else if (archivedCount > 0) {
            new Notice(`已归档 ${archivedCount} 个联系人`);
          } else {
            new Notice("无可归档联系人（未超过阈值或非 cancelled）");
          }
        } catch (e: any) {
          new Notice(`归档失败：${e?.message ?? e}`);
          console.warn("[RSLatte][contacts] archive failed", e);
        } finally {
          await this.refresh();
        }
      };
    }

    if (btnVis.refresh) {
      const refreshBtn = actions.createEl("button", { text: "🔄", cls: "rslatte-icon-btn" });
      refreshBtn.title = "刷新联系人列表（重新读取索引）";
      refreshBtn.onclick = async () => {
        new Notice("开始刷新：联系人…");
        try {
          const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "contacts", "manual_refresh");
          if (r.ok) {
            if (r.data?.skipped) {
              new Notice("联系人刷新：已跳过（门控/互斥）");
            }
          } else {
            new Notice(`联系人刷新失败：${String((r as any)?.error?.message ?? (r as any)?.error?.code ?? "unknown").slice(0, 120)}`);
          }
        } catch (e: any) {
          console.warn("[Contacts][manual_refresh] failed:", e);
          new Notice(`联系人刷新失败：${String(e?.message ?? e).slice(0, 120)}`);
        } finally {
          await this.refresh();
        }
      };
    }
    const sec2 = container.createDiv({ cls: "rslatte-section" });
    const meta = sec2.createDiv({ cls: "rslatte-muted" });
    const countText = `共 ${index.items.length} 条`;
    meta.setText(countText);

    // Controls
    const ctrl = sec2.createDiv({ cls: "rslatte-contacts-controls" });

    // Search
    const searchRow = ctrl.createDiv({ cls: "rslatte-contacts-row" });
    const input = searchRow.createEl("input", {
      type: "text",
      cls: "rslatte-contacts-search",
      placeholder: "搜索：姓名 / alias / tag",
    });
    // Use draft value so input won't be reset on refresh.
    input.value = this.qDraft || this.q;

    // IME (Chinese) safe input handling
    let isComposing = false;
    input.addEventListener("compositionstart", () => {
      isComposing = true;
    });
    input.addEventListener("compositionend", () => {
      isComposing = false;
      this.qDraft = input.value;
    });
    input.addEventListener("input", () => {
      // During composition, only update draft; do NOT refresh.
      this.qDraft = input.value;
      if (isComposing) return;
    });

    const doSearch = () => {
      this.triggerSearch(input.value);
      // keep focus for quick iterative searches
      input.focus();
    };

    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doSearch();
      }
    });

    const searchBtn = searchRow.createEl("button", { text: "🔍", cls: "rslatte-icon-btn rslatte-contacts-search-btn" });
    searchBtn.title = "搜索";
    searchBtn.onclick = doSearch;

    // Group + Status
    const filterRow = ctrl.createDiv({ cls: "rslatte-contacts-row" });

    const groupSel = filterRow.createEl("select", { cls: "rslatte-contacts-select" });
    const groupOptions = ["All", ...groups];
    for (const g of groupOptions) {
      const opt = groupSel.createEl("option", { text: g, value: g });
      if (g === this.group) opt.selected = true;
    }
    groupSel.addEventListener("change", () => {
      this.group = groupSel.value;
      this.selectedUid = null;
      void this.refresh();
    });

    const statusSel = filterRow.createEl("select", { cls: "rslatte-contacts-select" });
    const statusOptions: Array<{ v: StatusFilter; label: string }> = [
      { v: "active", label: "active" },
      { v: "cancelled", label: "cancelled" },
      { v: "all", label: "all" },
    ];
    for (const s of statusOptions) {
      const opt = statusSel.createEl("option", { text: s.label, value: s.v });
      if (s.v === this.status) opt.selected = true;
    }
    statusSel.addEventListener("change", () => {
      this.status = statusSel.value as StatusFilter;
      this.selectedUid = null;
      void this.refresh();
    });
  }

  private renderList(container: HTMLElement, items: ContactIndexItem[]) {
    const sec = container.createDiv({ cls: "rslatte-section" });
    //sec.createEl("h4", { text: "列表" });

    // Timeline-style list, grouped by initial (align with other module lists)
    const wrap = sec.createDiv({ cls: "rslatte-timeline" });
    if (items.length === 0) {
      wrap.createDiv({ cls: "rslatte-muted", text: "无匹配联系人" });
      return;
    }

    const alphaBucket = (it: ContactIndexItem): string => {
      const sn = String(it.sortname ?? "").trim() || computeSortname(it.display_name ?? "");
      return bucketFromSortname(sn, it.display_name ?? it.contact_uid);
    };

    const dotText = (it: ContactIndexItem): string => {
      const sn = String(it.sortname ?? "").trim() || computeSortname(it.display_name ?? "");
      if (sn) return sn[0].toUpperCase();
      return firstInitial(it.display_name ?? it.contact_uid);
    };

    const groups = new Map<string, ContactIndexItem[]>();
    for (const it of items) {
      const key = alphaBucket(it);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(it);
    }
    const keys = Array.from(groups.keys()).sort((a, b) => {
      if (a === "#" && b !== "#") return 1;
      if (b === "#" && a !== "#") return -1;
      return a.localeCompare(b);
    });

    for (const k of keys) {
      const day = wrap.createDiv({ cls: "rslatte-timeline-day" });
      day.createDiv({ cls: "rslatte-timeline-day-title", text: k });
      const dayItems = day.createDiv({ cls: "rslatte-timeline-day-items" });

      const arr = groups.get(k) ?? [];
      arr.sort((a, b) => {
        const ak = String(a.sortname ?? "").trim() || computeSortname(a.display_name ?? "");
        const bk = String(b.sortname ?? "").trim() || computeSortname(b.display_name ?? "");
        const c = ak.localeCompare(bk);
        if (c !== 0) return c;
        return (a.display_name ?? "").localeCompare(b.display_name ?? "");
      });

      for (let i = 0; i < arr.length; i++) {
        const it = arr[i];
        const row = dayItems.createDiv({ cls: "rslatte-timeline-item rslatte-contacts-timeline-item" });
        if (this.selectedUid && this.selectedUid === it.contact_uid) {
          row.addClass("is-selected");
        }

        const gutter = row.createDiv({ cls: "rslatte-timeline-gutter" });
        gutter.createDiv({ cls: "rslatte-timeline-dot", text: dotText(it) });
        if (i !== arr.length - 1) {
          gutter.createDiv({ cls: "rslatte-timeline-line" });
        }

        const content = row.createDiv({ cls: "rslatte-timeline-content" });
        const titleRow = content.createDiv({ cls: "rslatte-timeline-title-row" });
        const name = titleRow.createDiv({ cls: "rslatte-timeline-text", text: it.display_name || it.contact_uid });
        name.title = it.display_name || it.contact_uid;

        const meta = content.createDiv({ cls: "rslatte-timeline-meta" });
        const title = (it.title ?? "").trim();
        const grp = (it.group_name ?? "").trim();
        const s = String(it.status ?? "active").trim() || "active";
        const parts: string[] = [];
        if (title) parts.push(title);
        if (grp) parts.push(grp);
        if (s === "cancelled") parts.push("cancelled");
        meta.setText(parts.join(" · "));

        row.addEventListener("click", () => {
          this.selectedUid = it.contact_uid;
          void this.refresh();
        });
      }
    }
  }

  private renderCard(container: HTMLElement, items: ContactIndexItem[], dynEntries?: ContactsInteractionEntry[]) {
    if (!this.selectedUid) return;
    const it = items.find((x) => x.contact_uid === this.selectedUid);
    if (!it) {
      this.selectedUid = null;
      return;
    }

    const sec = container.createDiv({ cls: "rslatte-section" });
    //sec.createEl("h3", { text: "名片" });

    const card = sec.createDiv({ cls: "rslatte-contact-card" });

    // Make the whole header area clickable to open the underlying contact file
    const top = card.createDiv({ cls: "rslatte-contact-card-top rslatte-contact-card-top-link" });
    top.title = "点击打开联系人文件";
    top.addEventListener("click", () => {
      void this.openContactFile(it);
    });
    const avatarWrap = top.createDiv({ cls: "rslatte-contact-avatar" });
    const avatarSrc = this.resolveAvatarResource(it);
    if (avatarSrc) {
      const img = avatarWrap.createEl("img", { cls: "rslatte-contact-avatar-img" });
      img.src = avatarSrc;
      img.alt = it.display_name;
      img.onerror = () => {
        img.remove();
        avatarWrap.addClass("is-placeholder");
        avatarWrap.createDiv({ cls: "rslatte-contact-avatar-placeholder", text: firstInitial(it.display_name) });
      };
    } else {
      avatarWrap.addClass("is-placeholder");
      avatarWrap.createDiv({ cls: "rslatte-contact-avatar-placeholder", text: firstInitial(it.display_name) });
    }

    const head = top.createDiv({ cls: "rslatte-contact-head" });
    const nameEl = head.createDiv({ cls: "rslatte-contact-name rslatte-contact-name-link", text: it.display_name });
    const meta = head.createDiv({ cls: "rslatte-contact-meta" });
    const metaParts: string[] = [];
    if (isTruthyStr(it.title)) metaParts.push(it.title.trim());
    if (isTruthyStr(it.group_name)) metaParts.push(it.group_name.trim());
    const s = String(it.status ?? "active").trim() || "active";
    if (s === "cancelled") metaParts.push("cancelled");
    meta.setText(metaParts.join(" · "));

    const body = card.createDiv({ cls: "rslatte-contact-body" });

    // aliases
    if ((it.aliases ?? []).length > 0) {
      const row = body.createDiv({ cls: "rslatte-contact-field" });
      row.createDiv({ cls: "rslatte-contact-field-k", text: "aliases" });
      row.createDiv({ cls: "rslatte-contact-field-v", text: (it.aliases ?? []).join(" / ") });
    }

    // tags
    if ((it.tags ?? []).length > 0) {
      const row = body.createDiv({ cls: "rslatte-contact-field" });
      row.createDiv({ cls: "rslatte-contact-field-k", text: "tags" });
      const v = row.createDiv({ cls: "rslatte-contact-field-v" });
      for (const t of it.tags ?? []) {
        v.createSpan({ cls: "rslatte-contact-chip", text: t });
      }
    }

    // status detail
    const st = body.createDiv({ cls: "rslatte-contact-field" });
    st.createDiv({ cls: "rslatte-contact-field-k", text: "status" });
    const sv = st.createDiv({ cls: "rslatte-contact-field-v" });
    sv.createSpan({ cls: "rslatte-contact-chip", text: s });
    if (s === "cancelled" && isTruthyStr(it.cancelled_at)) {
      sv.createSpan({ cls: "rslatte-muted", text: `  (${it.cancelled_at})` });
    }

    const actions = card.createDiv({ cls: "rslatte-contact-actions" });

    // Step 1: manual interaction entry (static)
    const manualBtn = actions.createEl("button", { cls: "rslatte-icon-btn", text: "📝" });
    manualBtn.title = "记互动（写入联系人笔记）";
    manualBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.openManualEventModal(it);
    });

    const editBtn = actions.createEl("button", { cls: "rslatte-icon-btn", text: "✏️" });
    editBtn.title = "编辑";
    editBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void this.openEditModal(it);
    });

    // C6: cancel/restore
    const statusNow = String(it.status ?? "active").trim() || "active";
    if (statusNow === "active") {
      const cancelBtn = actions.createEl("button", { cls: "rslatte-icon-btn", text: "⛔" });
      cancelBtn.title = "取消";
      cancelBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void this.setCancelled(it, true);
      });
    } else {
      const restoreBtn = actions.createEl("button", { cls: "rslatte-icon-btn", text: "✅" });
      restoreBtn.title = "恢复";
      restoreBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void this.setCancelled(it, false);
      });
    }

    // Step5: dynamic interactions (read-only, rendered from index)
    const dynWrap = card.createDiv({ cls: "rslatte-contact-dynamic" });
    const dynTitleRow = dynWrap.createDiv({ cls: "rslatte-contact-dynamic-title" });
    dynTitleRow.createDiv({ text: "动态互动", cls: "rslatte-contact-dynamic-title-text" });

    const ctrlRow = dynWrap.createDiv({ cls: "rslatte-contact-dynamic-controls" });

    // source type
    const typeSel = ctrlRow.createEl("select", { cls: "rslatte-contacts-select" });
    const typeOptions: Array<{ v: ContactsInteractionSourceType | "all"; label: string }> = [
      { v: "all", label: "全部" },
      { v: "task", label: "任务" },
      { v: "project_task", label: "项目任务" },
    ];
    for (const o of typeOptions) {
      const opt = typeSel.createEl("option", { value: o.v, text: o.label });
      if (o.v === this.dynSourceType) opt.selected = true;
    }
    typeSel.addEventListener("change", () => {
      this.dynSourceType = typeSel.value as any;
      void this.refresh();
    });

    // incomplete toggle
    const incBtn = ctrlRow.createEl("button", { cls: "rslatte-icon-btn", text: this.dynIncompleteOnly ? "☑️ 仅未完成" : "☐ 全部" });
    incBtn.title = this.dynIncompleteOnly ? "仅未完成（done/cancelled 隐藏）" : "显示全部";
    incBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.dynIncompleteOnly = !this.dynIncompleteOnly;
      void this.refresh();
    });

    // limit
    const limitSel = ctrlRow.createEl("select", { cls: "rslatte-contacts-select" });
    const limits = [10, 20, 50];
    for (const n of limits) {
      const opt = limitSel.createEl("option", { value: String(n), text: `最近 ${n} 条` });
      if (n === this.dynLimit) opt.selected = true;
    }
    limitSel.addEventListener("change", () => {
      this.dynLimit = Math.max(1, Math.min(200, Number(limitSel.value) || 20));
      void this.refresh();
    });

    const list = dynWrap.createDiv({ cls: "rslatte-contact-dynamic-list" });
    const entries = dynEntries ?? [];
    if (entries.length === 0) {
      list.createDiv({ cls: "rslatte-muted", text: "暂无动态互动（来自任务/项目任务的联系人引用）" });
    } else {
      for (const e of entries) {
        // Render with the same timeline look as task/project task lists.
        const row = list.createDiv({ cls: "rslatte-timeline-item rslatte-contact-dynamic-timeline-item" });
        row.tabIndex = 0;

        const gutter = row.createDiv({ cls: "rslatte-timeline-gutter" });
        const dot = gutter.createDiv({ cls: "rslatte-timeline-dot" });
        dot.setText(this.statusIconForInteraction(e));
        dot.title = String(e.status ?? "");
        gutter.createDiv({ cls: "rslatte-timeline-line" });

        const content = row.createDiv({ cls: "rslatte-timeline-content" });
        const titleRow = content.createDiv({ cls: "rslatte-timeline-title-row rslatte-task-row" });

        const snFull = this.normalizeInteractionSnippetForDisplay(String(e.snippet ?? ""));
        const sn = this.truncateText(snFull, 160);
        const snEl = titleRow.createDiv({ cls: "rslatte-timeline-text rslatte-task-title" });
        renderTextWithContactRefs(this.app, snEl, sn, { highlightUid: this.selectedUid });
        snEl.title = snFull;

        const actions = titleRow.createDiv({ cls: "rslatte-task-actions rslatte-task-actions-compact" });
        const srcBtn = actions.createEl("button", { cls: "rslatte-icon-only-btn", text: "↗" });
        srcBtn.title = `打开源文件：${e.source_path}`;
        srcBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          void this.openInteractionSource(e);
        });

        const meta = content.createDiv({ cls: "rslatte-timeline-meta rslatte-task-meta" });
        const metaParts: string[] = [];
        metaParts.push(String(e.source_type ?? ""));
        if (isTruthyStr(e.heading)) metaParts.push(e.heading.trim());
        meta.setText(metaParts.join(" · "));

        const from = content.createDiv({ cls: "rslatte-timeline-from" });
        // Show full path instead of basename to match diary/task list style.
        from.setText(String(e.source_path ?? ""));
        from.title = e.source_path;

        const open = () => void this.openInteractionSource(e);
        row.addEventListener("click", open);
        row.addEventListener("keydown", (ev) => {
          if ((ev as KeyboardEvent).key === "Enter") open();
        });
      }
    }

    // Step6: mirror a compact dynamic summary into the contact note (controlled generated block).
    // Best-effort + non-blocking: does not affect UI rendering even if write fails.
    void this.refreshDynamicSummaryBlockForContact(it);
  }

  private async setCancelled(it: ContactIndexItem, cancelled: boolean): Promise<void> {
    const filePath = String(it.file_path ?? "").trim();
    const af = this.app.vault.getAbstractFileByPath(filePath);
    if (!(af instanceof TFile)) {
      new Notice("联系人文件不存在，无法更新状态");
      return;
    }

    const nowIso = new Date().toISOString();

    try {
      await this.app.fileManager.processFrontMatter(af, (fm) => {
        (fm as any).status = cancelled ? "cancelled" : "active";
        (fm as any).cancelled_at = cancelled ? nowIso : null;
        (fm as any).updated_at = nowIso;
      });

      // Step C8: DB sync (best-effort)
      try {
        await this.plugin.tryContactsDbSyncByPath(af.path, cancelled ? "cancel" : "restore");
      } catch {
        // ignore
      }

      // Work events (best-effort)
      try {
        // 当 cancelled 为 true 时，使用 action: "cancelled"，否则使用 action: "status"
        const action = cancelled ? "cancelled" : "status";
        await (this.plugin as any).workEventSvc?.append({
          ts: new Date().toISOString(),
          kind: "contact",
          action: action as any,
          source: "ui",
          ref: {
            contact_uid: it.contact_uid,
            display_name: it.display_name,
            group_name: it.group_name,
            file_path: af.path,
            status: cancelled ? "cancelled" : "active",
          },
          summary: `${cancelled ? "⛔" : "✅"} 联系人状态：${it.display_name} → ${cancelled ? "cancelled" : "active"}`,
        });
      } catch {
        // ignore
      }

      // refresh index and UI
      await this.plugin.rebuildContactsIndex();
      await this.refresh();
    } catch (e: any) {
      new Notice(`更新联系人状态失败：${e?.message ?? String(e)}`);
    }
  }

  public async refresh(): Promise<void> {
    // Avoid interleaving renders (e.g. timer + click + manual refresh) which may cause duplicated UI.
    if (this.refreshRunning) {
      this.refreshPending = true;
      return;
    }
    this.refreshRunning = true;
    const seq = ++this.refreshSeq;

    try {
      // Use ItemView.contentEl instead of containerEl.children[1] to avoid layout changes.
      const container = this.contentEl;
      container.empty();

      if (!this.isModuleEnabled()) {
        // 模块关闭：显示提示信息（与财务模块保持一致）
        container.createDiv({ cls: "rslatte-muted", text: "联系人模块未启用" });
        return;
      }

      const index = await this.readIndex();
      if (seq !== this.refreshSeq) return;
      const groupsFromDir = await this.listGroupsFromDir(this.app);
      if (seq !== this.refreshSeq) return;
      const groupsFromIndex = Array.from(
        new Set((index.items ?? []).map((x) => String(x.group_name ?? "").trim()).filter((x) => !!x))
      );
      const groups = Array.from(new Set([...groupsFromDir, ...groupsFromIndex])).sort((a, b) => a.localeCompare(b));

      // sanity: keep selected group valid
      if (this.group !== "All" && !groups.includes(this.group)) {
        this.group = "All";
        this.selectedUid = null;
      }

      this.renderHeader(container, index, groups);

      const filtered = this.filterItems(index.items ?? []);
      // if selected item got filtered out, clear selection
      if (this.selectedUid && !filtered.some((x) => x.contact_uid === this.selectedUid)) {
        this.selectedUid = null;
      }

      const dyn = await this.readDynamicInteractionsForSelected();
      if (seq !== this.refreshSeq) return;
      this.renderCard(container, filtered, dyn);
      this.renderList(container, filtered);
    } finally {
      this.refreshRunning = false;
      if (this.refreshPending) {
        this.refreshPending = false;
        // Run one more refresh to coalesce multiple requests.
        void this.refresh();
      }
    }
  }
}
