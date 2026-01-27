import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";

import type RSLattePlugin from "../../main";
import type { PublishIndexItem } from "../../types/publishTypes";
import { AddPublishRecordModal } from "../modals/AddPublishRecordModal";
import { createHeaderRow } from "../helpers/moduleHeader";

function shortPath(path: string): string {
  const p = (path ?? "").replace(/\\/g, "/");
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return parts.slice(parts.length - 2).join("/");
}

function formatYmd(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export class PublishSidePanelView extends ItemView {
  private _renderSeq = 0;
  private _filterDocCategory: string = "";
  private _filterDomain: string = "";
  private _filterPublishType: string = "";
  // 树形结构展开状态
  private _expandedCategories = new Set<string>(); // key = docCategory
  private _expandedCategoryDomains = new Set<string>(); // key = `${docCategory}::${domain}`
  // 发布时间趋势折叠状态
  private _publishTrendCollapsed: boolean = true;

  constructor(leaf: WorkspaceLeaf, private plugin: RSLattePlugin) {
    super(leaf);
  }

  getViewType(): string {
    return "rslatte-publishpanel";
  }

  getDisplayText(): string {
    return "发布管理";
  }

  getIcon(): string {
    return "megaphone";
  }

  async onOpen() {
    await this.render();
  }

  public refresh() {
    void this.render();
  }

  private async manualRefresh(): Promise<void> {
    new Notice("开始刷新：发布管理…");
    try {
      await this.plugin.publishRSLatte?.refreshIndexNow();
      new Notice("发布管理索引已刷新");
    } catch (e: any) {
      new Notice(`刷新失败：${e?.message ?? String(e)}`);
      console.warn('[RSLatte][ui] publish refresh failed', e);
    }
    this.refresh();
  }

  async render() {
    const seq = ++this._renderSeq;
    const container = this.contentEl;
    container.empty();
    container.addClass("rslatte-sidepanel");

    const publishEnabled = this.plugin.isPipelineModuleEnabled("publish");
    if (!publishEnabled) {
      container.createDiv({ cls: "rslatte-muted", text: "发布模块未启用" });
      return;
    }

    const settings = this.plugin.settings.publishPanel || ({} as any);

    // ===== Header =====
    const publishHeaderSection = container.createDiv({ cls: "rslatte-section" });
    const { left: publishHeaderLeft, right: publishHeaderActions } = createHeaderRow(
      publishHeaderSection,
      "rslatte-section-title-row",
      "rslatte-section-title-left",
      "rslatte-task-actions",
    );
    publishHeaderLeft.createEl("h3", { text: "📣 发布管理" });

    const refreshBtn = publishHeaderActions.createEl("button", { text: "🔄", cls: "rslatte-icon-btn" });
    refreshBtn.title = "刷新发布管理索引";
    refreshBtn.onclick = () => void this.manualRefresh();

    // 先刷新索引（如果过期）
    await this.plugin.publishRSLatte?.refreshIndexIfStale(30_000);
    const snap = await this.plugin.publishRSLatte?.getSnapshot();
    if (seq !== this._renderSeq) return;

    const itemsAll = (snap?.items ?? []) as PublishIndexItem[];

    // ===== Statistics Area =====
    const statsSection = container.createDiv({ cls: "rslatte-section" });
    // ===== 发布状态概览 =====
    const statusOverview = statsSection.createDiv({ cls: "rslatte-publish-status-overview" });
    const publishedCount = itemsAll.filter(it => it.publishType && it.publishType.trim() !== "").length;
    const unpublishedCount = itemsAll.length - publishedCount;
    const statusCard = statusOverview.createDiv({ cls: "rslatte-publish-status-card" });
    statusCard.createDiv({ cls: "rslatte-publish-status-item" }).createEl("span", { 
      text: `已发布: ${publishedCount}`,
      cls: "rslatte-publish-status-published"
    });
    statusCard.createDiv({ cls: "rslatte-publish-status-item" }).createEl("span", { 
      text: `未发布: ${unpublishedCount}`,
      cls: "rslatte-publish-status-unpublished"
    });    
    // 领域统计
    statsSection.createEl("h4", { text: "领域统计", cls: "rslatte-section-subtitle" });
    
    // 统计领域
    const domainCounts: Record<string, number> = {};
    for (const it of itemsAll) {
      const domains = it.domains ?? [];
      for (const d of domains) {
        domainCounts[d] = (domainCounts[d] ?? 0) + 1;
      }
    }

    const wordCloudContainer = statsSection.createDiv({ cls: "rslatte-publish-wordcloud" });
    const domainEntries = Object.entries(domainCounts).sort((a, b) => b[1] - a[1]);
    
    if (domainEntries.length === 0) {
      wordCloudContainer.createDiv({ cls: "rslatte-muted", text: "（暂无领域数据）" });
    } else {
      for (const [domain, count] of domainEntries) {
        const tag = wordCloudContainer.createEl("span", { 
          cls: "rslatte-publish-domain-tag",
          text: `${domain} (${count})`
        });
        tag.style.fontSize = `${Math.min(16, 10 + count * 2)}px`;
        tag.onclick = () => {
          this._filterDomain = this._filterDomain === domain ? "" : domain;
          this.render();
        };
        if (this._filterDomain === domain) {
          tag.addClass("rslatte-publish-domain-tag-active");
        }
      }
    }

    // 发布通道统计
    statsSection.createEl("h4", { text: "发布通道统计", cls: "rslatte-section-subtitle" });
    const channelCounts: Record<string, number> = {};
    for (const it of itemsAll) {
      for (const record of it.publishRecords ?? []) {
        const ch = record.channel;
        if (ch) {
          channelCounts[ch] = (channelCounts[ch] ?? 0) + 1;
        }
      }
    }
    const channelCloudContainer = statsSection.createDiv({ cls: "rslatte-publish-wordcloud" });
    const channelEntries = Object.entries(channelCounts).sort((a, b) => b[1] - a[1]);
    
    if (channelEntries.length === 0) {
      channelCloudContainer.createDiv({ cls: "rslatte-muted", text: "（暂无发布通道数据）" });
    } else {
      for (const [channel, count] of channelEntries) {
        const tag = channelCloudContainer.createEl("span", { 
          cls: "rslatte-publish-domain-tag",
          text: `${channel} (${count})`
        });
        tag.style.fontSize = `${Math.min(16, 10 + count * 2)}px`;
      }
    }

    // 发布时间趋势
    //const trendSection = container.createDiv({ cls: "rslatte-section" });
    const trendHeader = statsSection.createDiv({ cls: "rslatte-section-title-row" });
    const trendTitle = trendHeader.createDiv({ cls: "rslatte-section-title-left" });
    const trendToggle = trendTitle.createSpan({ 
      cls: "rslatte-stats-collapse-icon", 
      text: this._publishTrendCollapsed ? "▶" : "▼" 
    });
    trendTitle.createEl("h4", { text: "发布时间趋势", cls: "rslatte-section-subtitle" });
    trendTitle.style.cursor = "pointer";
    trendTitle.onclick = () => {
      this._publishTrendCollapsed = !this._publishTrendCollapsed;
      this.render();
    };

    if (!this._publishTrendCollapsed) {
      const monthCounts: Record<string, number> = {};
      for (const it of itemsAll) {
        for (const record of it.publishRecords ?? []) {
          const date = record.publishDate;
          if (date) {
            const monthKey = date.substring(0, 7); // YYYY-MM
            monthCounts[monthKey] = (monthCounts[monthKey] ?? 0) + 1;
          }
        }
      }
      const trendContainer = statsSection.createDiv({ cls: "rslatte-publish-trend-list" });
      const monthEntries = Object.entries(monthCounts).sort((a, b) => b[0].localeCompare(a[0]));
      
      if (monthEntries.length === 0) {
        trendContainer.createDiv({ cls: "rslatte-muted", text: "（暂无发布记录）" });
      } else {
        for (const [month, count] of monthEntries) {
          const trendItem = trendContainer.createDiv({ cls: "rslatte-publish-trend-item" });
          trendItem.createEl("span", { text: month, cls: "rslatte-publish-trend-month" });
          trendItem.createEl("span", { text: `${count}次`, cls: "rslatte-publish-trend-count" });
        }
      }
    }

    // ===== Filter Area =====
    const filterSection = container.createDiv({ cls: "rslatte-section" });

    // ===== File List =====
    let filteredItems = itemsAll;
    
    if (this._filterDocCategory) {
      filteredItems = filteredItems.filter(it => it.docCategory === this._filterDocCategory);
    }
    if (this._filterDomain) {
      filteredItems = filteredItems.filter(it => (it.domains ?? []).includes(this._filterDomain));
    }
    if (this._filterPublishType) {
      if (this._filterPublishType === "__unpublished__") {
        filteredItems = filteredItems.filter(it => !it.publishType || it.publishType.trim() === "");
      } else {
        filteredItems = filteredItems.filter(it => it.publishType === this._filterPublishType);
      }
    }

    // 按修改时间排序
    filteredItems.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
    //const listSection = container.createDiv({ cls: "rslatte-section" });
    const listHeader = filterSection.createDiv({ cls: "rslatte-section-title-row" });
    listHeader.createEl("h4", { text: "文件清单", cls: "rslatte-section-subtitle" });
    
    // 全部展开/收起按钮
    const listActions = listHeader.createDiv({ cls: "rslatte-task-actions" });
    const expandAllBtn = listActions.createEl("button", { text: "全部展开", cls: "rslatte-text-btn" });
    expandAllBtn.title = "展开所有分类和领域";
    expandAllBtn.onclick = () => {
      // 收集所有分类和领域（需要先构建树结构来确定所有领域）
      const tree: Record<string, Record<string, PublishIndexItem[]>> = {};
      for (const it of filteredItems) {
        if (!it.docCategory) continue;
        if (!tree[it.docCategory]) {
          tree[it.docCategory] = {};
        }
        const domains = it.domains ?? [];
        if (domains.length === 0) {
          if (!tree[it.docCategory]["__no_domain__"]) {
            tree[it.docCategory]["__no_domain__"] = [];
          }
          tree[it.docCategory]["__no_domain__"].push(it);
        } else {
          for (const domain of domains) {
            if (!tree[it.docCategory][domain]) {
              tree[it.docCategory][domain] = [];
            }
            tree[it.docCategory][domain].push(it);
          }
        }
      }
      
      // 收集所有分类和领域
      const categories = new Set<string>();
      const categoryDomains = new Set<string>();
      for (const [category, categoryData] of Object.entries(tree)) {
        categories.add(category);
        for (const domain of Object.keys(categoryData)) {
          categoryDomains.add(`${category}::${domain}`);
        }
      }
      
      this._expandedCategories = new Set(categories);
      this._expandedCategoryDomains = new Set(categoryDomains);
      this.render();
    };
    const collapseAllBtn = listActions.createEl("button", { text: "全部收起", cls: "rslatte-text-btn" });
    collapseAllBtn.title = "收起所有分类和领域";
    collapseAllBtn.onclick = () => {
      this._expandedCategories.clear();
      this._expandedCategoryDomains.clear();
      this.render();
    };
    //const filterHeader = filterSection.createDiv({ cls: "rslatte-section-title-row" });
    //filterHeader.createEl("h4", { text: "筛选", cls: "rslatte-section-subtitle" });
    
    const filterContainer = filterSection.createDiv({ cls: "rslatte-publish-filters" });
    
    // 文档分类筛选
    const docCategoryFilter = filterContainer.createDiv({ cls: "rslatte-filter-item" });
    docCategoryFilter.createEl("label", { text: "文档分类：" });
    const docCategorySelect = docCategoryFilter.createEl("select", { cls: "rslatte-filter-select" });
    docCategorySelect.createEl("option", { text: "全部", value: "" });
    const docCategories = new Set<string>();
    for (const it of itemsAll) {
      if (it.docCategory) docCategories.add(it.docCategory);
    }
    for (const cat of Array.from(docCategories).sort()) {
      const opt = docCategorySelect.createEl("option", { text: cat, value: cat });
      if (this._filterDocCategory === cat) opt.selected = true;
    }
    docCategorySelect.onchange = () => {
      this._filterDocCategory = docCategorySelect.value;
      this.render();
    };

    // 领域筛选
    const domainFilter = filterContainer.createDiv({ cls: "rslatte-filter-item" });
    domainFilter.createEl("label", { text: "领域：" });
    const domainSelect = domainFilter.createEl("select", { cls: "rslatte-filter-select" });
    domainSelect.createEl("option", { text: "全部", value: "" });
    for (const domain of Array.from(new Set(Object.keys(domainCounts))).sort()) {
      const opt = domainSelect.createEl("option", { text: `${domain} (${domainCounts[domain]})`, value: domain });
      if (this._filterDomain === domain) opt.selected = true;
    }
    domainSelect.onchange = () => {
      this._filterDomain = domainSelect.value;
      this.render();
    };

    // 发布类型筛选
    const publishTypeFilter = filterContainer.createDiv({ cls: "rslatte-filter-item" });
    publishTypeFilter.createEl("label", { text: "发布类型：" });
    const publishTypeSelect = publishTypeFilter.createEl("select", { cls: "rslatte-filter-select" });
    publishTypeSelect.createEl("option", { text: "全部", value: "" });
    publishTypeSelect.createEl("option", { text: "未发布", value: "__unpublished__" });
    const publishTypes = new Set<string>();
    for (const it of itemsAll) {
      if (it.publishType) publishTypes.add(it.publishType);
    }
    for (const pt of Array.from(publishTypes).sort()) {
      const opt = publishTypeSelect.createEl("option", { text: pt, value: pt });
      if (this._filterPublishType === pt) opt.selected = true;
    }
    publishTypeSelect.onchange = () => {
      this._filterPublishType = publishTypeSelect.value;
      this.render();
    };

    
    if (filteredItems.length === 0) {
      filterSection.createDiv({ cls: "rslatte-task-empty", text: "（暂无文件）" });
    } else {
      this.renderTreeList(filterSection, filteredItems);
    }
  }

  private renderTreeList(parent: HTMLElement, items: PublishIndexItem[]) {
    // 按分类和领域组织数据
    const tree: Record<string, Record<string, PublishIndexItem[]>> = {};
    const uncategorized: PublishIndexItem[] = [];
    
    for (const it of items) {
      if (!it.docCategory) {
        uncategorized.push(it);
        continue;
      }
      if (!tree[it.docCategory]) {
        tree[it.docCategory] = {};
      }
      const domains = it.domains ?? [];
      if (domains.length === 0) {
        if (!tree[it.docCategory]["__no_domain__"]) {
          tree[it.docCategory]["__no_domain__"] = [];
        }
        tree[it.docCategory]["__no_domain__"].push(it);
      } else {
        for (const domain of domains) {
          if (!tree[it.docCategory][domain]) {
            tree[it.docCategory][domain] = [];
          }
          tree[it.docCategory][domain].push(it);
        }
      }
    }

    const treeContainer = parent.createDiv({ cls: "rslatte-publish-tree" });

    // 渲染分类
    const categories = Object.keys(tree).sort();
    for (const category of categories) {
      const categoryKey = category;
      const isCategoryExpanded = this._expandedCategories.has(categoryKey);
      const categoryData = tree[category];
      
      // 统计该分类下的文件总数（去重）
      const categoryFileSet = new Set<string>();
      for (const domainItems of Object.values(categoryData)) {
        for (const item of domainItems) {
          categoryFileSet.add(item.filePath);
        }
      }
      const categoryFileCount = categoryFileSet.size;
      
      const categoryRow = treeContainer.createDiv({ cls: "rslatte-publish-tree-category" });
      const categoryHeader = categoryRow.createDiv({ cls: "rslatte-publish-tree-header" });
      const categoryToggle = categoryHeader.createSpan({ 
        cls: "rslatte-stats-collapse-icon", 
        text: isCategoryExpanded ? "▼" : "▶" 
      });
      categoryHeader.createEl("span", { 
        text: category,
        cls: "rslatte-publish-tree-category-name"
      });
      categoryHeader.createEl("span", { 
        text: `${categoryFileCount}`,
        cls: "rslatte-publish-tree-count"
      });
      categoryHeader.style.cursor = "pointer";
      categoryHeader.onclick = () => {
        if (isCategoryExpanded) {
          this._expandedCategories.delete(categoryKey);
          // 同时收起该分类下的所有领域
          for (const domain of Object.keys(categoryData)) {
            this._expandedCategoryDomains.delete(`${categoryKey}::${domain}`);
          }
        } else {
          this._expandedCategories.add(categoryKey);
        }
        this.render();
      };

      if (isCategoryExpanded) {
        const categoryContent = categoryRow.createDiv({ cls: "rslatte-publish-tree-content" });
        
        // 渲染领域
        const domains = Object.keys(categoryData).sort();
        for (const domain of domains) {
          const domainKey = `${categoryKey}::${domain}`;
          const isDomainExpanded = this._expandedCategoryDomains.has(domainKey);
          const domainItems = categoryData[domain];
          
          // 去重：一个文件可能属于多个领域，但在这里只显示一次
          const uniqueItems = new Map<string, PublishIndexItem>();
          for (const item of domainItems) {
            if (!uniqueItems.has(item.filePath)) {
              uniqueItems.set(item.filePath, item);
            }
          }
          const uniqueItemsList = Array.from(uniqueItems.values());
          
          const domainRow = categoryContent.createDiv({ cls: "rslatte-publish-tree-domain" });
          const domainHeader = domainRow.createDiv({ cls: "rslatte-publish-tree-header" });
          const domainToggle = domainHeader.createSpan({ 
            cls: "rslatte-stats-collapse-icon", 
            text: isDomainExpanded ? "▼" : "▶" 
          });
          domainHeader.style.paddingLeft = "6px";
          domainHeader.createEl("span", { 
            text: domain === "__no_domain__" ? "（无领域）" : domain,
            cls: "rslatte-publish-tree-domain-name"
          });
          domainHeader.createEl("span", { 
            text: `${uniqueItemsList.length}`,
            cls: "rslatte-publish-tree-count"
          });
          domainHeader.style.cursor = "pointer";
          domainHeader.onclick = () => {
            if (isDomainExpanded) {
              this._expandedCategoryDomains.delete(domainKey);
            } else {
              this._expandedCategoryDomains.add(domainKey);
            }
            this.render();
          };

          if (isDomainExpanded) {
            const domainContent = domainRow.createDiv({ cls: "rslatte-publish-tree-content" });
            // 渲染文件列表
            const fileList = domainContent.createDiv({ cls: "rslatte-timeline" });
            const sortedItems = uniqueItemsList.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
            for (const it of sortedItems) {
              this.renderTimelineItem(fileList, it);
            }
          }
        }
      }
    }

    // 渲染未分类的文件
    if (uncategorized.length > 0) {
      const uncategorizedRow = treeContainer.createDiv({ cls: "rslatte-publish-tree-category" });
      const uncategorizedHeader = uncategorizedRow.createDiv({ cls: "rslatte-publish-tree-header" });
      uncategorizedHeader.createEl("span", { 
        text: "（未分类）",
        cls: "rslatte-publish-tree-category-name"
      });
      uncategorizedHeader.createEl("span", { 
        text: `${uncategorized.length}`,
        cls: "rslatte-publish-tree-count"
      });
      const uncategorizedContent = uncategorizedRow.createDiv({ cls: "rslatte-publish-tree-content" });
      const uncategorizedList = uncategorizedContent.createDiv({ cls: "rslatte-timeline" });
      for (const it of uncategorized.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))) {
        this.renderTimelineItem(uncategorizedList, it);
      }
    }
  }

  private renderTimeline(parent: HTMLElement, items: PublishIndexItem[]) {
    const wrap = parent.createDiv({ cls: "rslatte-timeline" });

    for (const it of items) {
      this.renderTimelineItem(wrap, it);
    }
  }

  private renderTimelineItem(parent: HTMLElement, it: PublishIndexItem) {
    const row = parent.createDiv({ cls: "rslatte-timeline-item" });
    row.tabIndex = 0;

    const gutter = row.createDiv({ cls: "rslatte-timeline-gutter" });
    const dot = gutter.createDiv({ cls: "rslatte-timeline-dot" });
    dot.setText(it.publishType ? "📣" : "📄");
    gutter.createDiv({ cls: "rslatte-timeline-line" });

    const content = row.createDiv({ cls: "rslatte-timeline-content" });

    const titleRow = content.createDiv({ cls: "rslatte-timeline-title-row" });
    const title = titleRow.createDiv({ cls: "rslatte-timeline-text" });
    title.setText(it.title);

    const actions = titleRow.createDiv({ cls: "rslatte-output-actions" });

    // 只有发布类型为空或没有的才显示"新增发布信息"按钮
    if (!it.publishType || it.publishType.trim() === "") {
      const addBtn = actions.createEl("button", { text: "➕", cls: "rslatte-text-btn" });
      addBtn.title = "新增发布记录";
      addBtn.onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        new AddPublishRecordModal(this.app, this.plugin, it.filePath).open();
      };
    }

    // 元信息：只显示 type 和领域
    const meta = content.createDiv({ cls: "rslatte-timeline-meta" });
    const parts: string[] = [];
    if (it.type) parts.push(`type ${it.type}`);
    if (it.domains && it.domains.length > 0) {
      parts.push(`领域 ${it.domains.join(", ")}`);
    }
    meta.setText(parts.join(" · ") || "（无）");

    // 发布信息
    if (it.publishRecords && it.publishRecords.length > 0) {
      const publishInfo = content.createDiv({ cls: "rslatte-timeline-publish-info" });
      for (const record of it.publishRecords) {
        const recordEl = publishInfo.createDiv({ cls: "rslatte-publish-record" });
        recordEl.createEl("span", { 
          text: `📣 ${record.channel} | ${record.publishDate}`,
          cls: "rslatte-publish-record-main"
        });
        if (record.note) {
          recordEl.createEl("span", { 
            text: ` | ${record.note}`,
            cls: "rslatte-publish-record-note"
          });
        }
        if (record.relatedDocPath) {
          recordEl.createEl("span", { 
            text: ` | 📎 ${shortPath(record.relatedDocPath)}`,
            cls: "rslatte-publish-record-doc"
          });
        }
      }
    }

    const from = content.createDiv({ cls: "rslatte-timeline-from" });
    from.setText(shortPath(it.filePath));

    const open = async () => {
      try {
        const af = this.app.vault.getAbstractFileByPath(it.filePath);
        if (!(af instanceof TFile)) {
          new Notice(`文件不存在：${it.filePath}`);
          return;
        }
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(af, { active: true });
      } catch (e: any) {
        new Notice(`打开失败：${e?.message ?? String(e)}`);
      }
    };

    row.addEventListener("click", () => void open());
    row.addEventListener("keydown", (ev) => {
      if ((ev as KeyboardEvent).key === "Enter") void open();
    });
  }
}
