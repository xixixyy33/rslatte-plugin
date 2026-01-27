import { App, FuzzyMatch, FuzzySuggestModal, Notice } from "obsidian";
import type { ContactIndexItem } from "../../contactsRSLatte/types";

/**
 * C3/C7: Insert contact reference into current editor.
 * Preferred syntax: [[C_<uid>|Name]]
 *
 * MVP: uses contacts index (main + archive) provided by caller.
 */
export class InsertContactReferenceModal extends FuzzySuggestModal<ContactIndexItem> {
  private items: ContactIndexItem[];

  private onPickRef: (ref: string, item: ContactIndexItem) => void;

  // Keep plugin for future use (e.g., analytics), but avoid tight coupling.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
  // @ts-ignore - Reserved for future use
  private _plugin: any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(app: App, plugin: any, items: ContactIndexItem[], onPickRef: (ref: string, item: ContactIndexItem) => void) {
    super(app);
    this._plugin = plugin;
    this.items = items;
    this.onPickRef = onPickRef;
    this.setPlaceholder("搜索联系人：姓名 / alias / tag");
    this.setInstructions([
      { command: "↑↓", purpose: "选择" },
      { command: "Enter", purpose: "插入引用" },
      { command: "Esc", purpose: "取消" },
    ]);
  }

  getItems(): ContactIndexItem[] {
    return this.items;
  }

  /**
   * Obsidian's fuzzy search can be unfriendly to CJK in some environments.
   * Provide a deterministic substring fallback so Chinese names like "西西" can always be found.
   */
  getSuggestions(query: string): FuzzyMatch<ContactIndexItem>[] {
    const q = String(query ?? "").trim();
    if (!q) {
      return this.items.map((item) => ({ item, match: { score: 0, matches: [] } }));
    }

    const qLower = q.toLowerCase();
    const out: FuzzyMatch<ContactIndexItem>[] = [];
    for (const it of this.items) {
      const hay = this.getItemText(it);
      if (!hay) continue;
      // Keep original case for CJK direct match + lower-case for latin.
      if (hay.includes(q) || hay.toLowerCase().includes(qLower)) {
        out.push({ item: it, match: { score: 0, matches: [] } });
      }
    }
    return out;
  }

  getItemText(item: ContactIndexItem): string {
    const name = String(item.display_name ?? "");
    const alias = Array.isArray(item.aliases) ? item.aliases.join(" ") : "";
    const tags = Array.isArray(item.tags) ? item.tags.join(" ") : "";
    const group = String(item.group_name ?? "");
    const sortname = String((item as any).sortname ?? "");
    const uid = String((item as any).contact_uid ?? "");
    // Put searchable fields together. We'll render suggestion UI separately.
    return `${name} ${alias} ${tags} ${group} ${sortname} ${uid}`.trim();
  }

  renderSuggestion(item: FuzzyMatch<ContactIndexItem>, el: HTMLElement): void {
    el.empty();

    // FuzzySuggestModal 内部会对 item 进行包装，实际数据在 item.item 中
    const actualItem = (item as any)?.item || item;
    const name = String(actualItem.display_name ?? actualItem.contact_uid ?? "").trim();
    const subtitleParts: string[] = [];
    if (actualItem.title) subtitleParts.push(String(actualItem.title));
    if (actualItem.group_name) subtitleParts.push(String(actualItem.group_name));
    if (actualItem.status) subtitleParts.push(String(actualItem.status));

    el.createDiv({ cls: "rslatte-suggest-title", text: name });
    if (subtitleParts.length > 0) {
      el.createDiv({ cls: "rslatte-suggest-note", text: subtitleParts.join(" · ") });
    }
  }

  /**
   * Compatibility note:
   * - Obsidian's modal base calls onChooseItem(item, evt)
   * - Some environments/plugins may end up calling onChooseSuggestion(item, evt)
   *
   * We implement both and add a safe fallback when item is unexpectedly undefined.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onChooseItem(item: ContactIndexItem, _evt?: MouseEvent | KeyboardEvent): void {
    // In rare cases, Obsidian may invoke the callback with an undefined item
    // (e.g., IME interactions / custom suggester wrappers). Fallback to the
    // first suggestion of current query so insertion still works.
    const suggestions = this.getSuggestions(String((this as any).inputEl?.value ?? "").trim());
    const firstMatch = suggestions[0];
    const resolved: ContactIndexItem | undefined =
      (item as any) ?? (firstMatch ? ((firstMatch as any)?.item || firstMatch) : undefined);

    if (!resolved) {
      new Notice("未选择到联系人条目，无法插入。请重试。");
      return;
    }

    const uid = String(resolved.contact_uid ?? "").trim();
    if (!uid) {
      new Notice("联系人缺少 contact_uid，无法插入。");
      return;
    }

    const rawName = String(resolved.display_name ?? uid).trim();
    // Avoid breaking wiki-link syntax.
    const safeName = rawName.replace(/[\[\]\|]/g, "").trim() || uid;
    const ref = `[[C_${uid}|${safeName}]]`;

    try {
      this.onPickRef?.(ref, resolved);
    } catch (e) {
      console.warn("[RSLatte][contacts][insert] onPickRef failed", e);
      new Notice("插入联系人引用失败。");
    }
  }

  // Some Obsidian builds/third-party wrappers use onChooseSuggestion instead.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onChooseSuggestion(item: FuzzyMatch<ContactIndexItem>, evt: MouseEvent | KeyboardEvent): void {
    // FuzzySuggestModal 内部会对 item 进行包装，实际数据在 item.item 中
    const actualItem = (item as any)?.item || item;
    this.onChooseItem(actualItem, evt);
  }
}
