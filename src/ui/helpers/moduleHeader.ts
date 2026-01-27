export type DbSyncIndicator = { icon: string; title: string };

/**
 * Standard header row layout used across SidePanel views.
 *
 * Left: title / collapse arrow / subtitle
 * Right: db-sync indicator + action buttons
 */
export function createHeaderRow(
  parent: HTMLElement,
  rowCls: string,
  leftCls: string,
  rightCls: string = "rslatte-task-actions",
) {
  const row = (parent as any).createDiv({ cls: rowCls }) as HTMLElement;
  const left = (row as any).createDiv({ cls: leftCls }) as HTMLElement;
  const right = (row as any).createDiv({ cls: rightCls }) as HTMLElement;
  return { row, left, right };
}

/** Append a DB sync indicator (icon + tooltip) into the right-side container. */
export function appendDbSyncIndicator(
  right: HTMLElement,
  ind?: DbSyncIndicator | null,
  cls: string = "rslatte-project-sync",
) {
  if (!ind) return null;
  const el = (right as any).createEl("span", { cls, text: ind.icon }) as HTMLElement;
  el.title = ind.title;
  return el;
}
