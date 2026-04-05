/**
 * 任务/提醒/日程设置页：侧栏卡片按钮「收入 ⋯」勾选列表。
 */

export function renderSidePanelCardMoreChecklist(
  parent: HTMLElement,
  opts: {
    heading: string;
    description: string;
    catalog: Array<{ id: string; icon: string; label: string }>;
    getIds: () => string[] | undefined;
    setIds: (next: string[]) => void;
    save: () => Promise<void>;
  }
): void {
  parent.createEl("h5", { text: opts.heading });
  parent.createEl("p", {
    cls: "rslatte-settings-hint rslatte-card-more-settings-desc",
    text: opts.description,
  });
  const box = parent.createDiv({ cls: "rslatte-card-more-settings" });

  const readSet = (): Set<string> => {
    const raw = opts.getIds();
    const arr = Array.isArray(raw) ? raw : [];
    return new Set(arr.filter((x) => typeof x === "string" && x.length > 0));
  };

  for (const row of opts.catalog) {
    const rowEl = box.createDiv({ cls: "rslatte-card-more-settings-row" });
    rowEl.createSpan({
      cls: "rslatte-card-more-settings-label",
      text: `${row.icon} ${row.label}`.trim(),
    });
    const cb = rowEl.createEl("input", { type: "checkbox", cls: "rslatte-card-more-settings-cb" });
    cb.checked = readSet().has(row.id);
    cb.addEventListener("change", async () => {
      const next = readSet();
      if (cb.checked) next.add(row.id);
      else next.delete(row.id);
      opts.setIds(Array.from(next));
      await opts.save();
    });
  }
}
