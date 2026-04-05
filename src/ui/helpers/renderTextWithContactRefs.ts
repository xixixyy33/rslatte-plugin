import type { App } from "obsidian";
import { extractContactUidFromWikiTarget } from "../../services/contacts/contactRefParser";
import { VIEW_TYPE_CONTACTS } from "../../constants/viewTypes";

export type RenderContactTextOpts = {
  /** When provided, this uid will be highlighted as the current contact (e.g. on contact card). */
  highlightUid?: string | null;
};

function appendText(parentEl: HTMLElement, text: string): void {
  if (!text) return;
  parentEl.createEl("span", { text });
}

async function openContactByUid(app: App, uid: string): Promise<void> {
  try {
    const ws: any = app.workspace as any;
    let leaf: any = ws.getLeavesOfType(VIEW_TYPE_CONTACTS)?.[0];
    if (!leaf) {
      const right = ws.getRightLeaf?.(false);
      if (right) {
        await right.setViewState({ type: VIEW_TYPE_CONTACTS, active: true });
        leaf = right;
      }
    }
    if (leaf) {
      ws.revealLeaf?.(leaf);
      const view: any = leaf.view;
      if (view && typeof view.focusContactByUid === "function") {
        await view.focusContactByUid(uid);
        return;
      }
    }
    // fallback：若侧栏聚焦失败，则退回打开联系人文件
    void app.workspace.openLinkText(`C_${uid}`, "", false);
  } catch {
    // ignore
  }
}

/**
 * 侧栏列表一行摘要：将 `[[目标|显示名]]` 折为显示名；无 `|` 时将 `[[目标]]` 折为目标文本（去掉 wiki 壳）。
 * 与记录页时间轴 `formatTimelineSummaryForDisplay` 一致，用于提醒类卡片避免出现 `[[...|...]]`  raw。
 */
export function collapseWikiLinksForLineDisplay(raw: string): string {
  let s = String(raw ?? "");
  s = s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, (_m, _left, right) => String(right ?? "").trim());
  s = s.replace(/\[\[([^\]]+)\]\]/g, (_m, inner) => String(inner ?? "").trim());
  return s.replace(/\s+/g, " ").trim();
}

/**
 * 将文本中的联系人引用 `[[C_<uid>|姓名]]` / `[[C_<uid>]]` 转为纯展示名（无括号、不可点）。
 * 与 {@link renderTextWithContactRefs} 的 label 规则一致；非联系人 `[[...]]` 原样保留。
 */
export function plainTextFromTextWithContactRefs(rawText: string): string {
  const text = String(rawText ?? "");
  if (!text) return "";

  const re = /\[\[([^\]]+?)\]\]/g;
  let out = "";
  let last = 0;

  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    const full = m[0];
    const inside = m[1] ?? "";
    const start = m.index ?? 0;
    const end = start + full.length;

    if (start > last) out += text.slice(last, start);

    const parts = inside.split("|");
    const target = String(parts[0] ?? "").trim();
    const alias = parts.length > 1 ? parts.slice(1).join("|").trim() : "";

    const uid = extractContactUidFromWikiTarget(target);
    if (uid) {
      const label = alias || (target.startsWith("C_") ? target.slice(2) : uid);
      out += label;
    } else {
      out += full;
    }

    last = end;
  }

  if (last < text.length) out += text.slice(last);
  return out;
}

/**
 * 同 {@link plainTextFromTextWithContactRefs}，但对无别名的 `[[C_<uid>]]` 可经 `lookupDisplayName` 解析为通讯录展示名。
 */
export async function plainTextFromTextWithContactRefsResolved(
  rawText: string,
  lookupDisplayName: (uid: string) => Promise<string | null>
): Promise<string> {
  const text = String(rawText ?? "");
  if (!text) return "";

  const re = /\[\[([^\]]+?)\]\]/g;
  let out = "";
  let last = 0;

  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    const full = m[0];
    const inside = m[1] ?? "";
    const start = m.index ?? 0;
    const end = start + full.length;

    if (start > last) out += text.slice(last, start);

    const parts = inside.split("|");
    const target = String(parts[0] ?? "").trim();
    const alias = parts.length > 1 ? parts.slice(1).join("|").trim() : "";

    const uid = extractContactUidFromWikiTarget(target);
    if (uid) {
      let label = alias;
      if (!label) {
        const resolved = await lookupDisplayName(uid);
        label = resolved || (target.startsWith("C_") ? target.slice(2) : uid);
      }
      out += label;
    } else {
      out += full;
    }

    last = end;
  }

  if (last < text.length) out += text.slice(last);
  return out;
}

/**
 * Render a line of text that might include contact references like [[C_<uid>|Name]].
 * - Does NOT use innerHTML (safe).
 * - Removes the [[...]] wrapper for contacts and renders them as clickable pills.
 */
export function renderTextWithContactRefs(app: App, parentEl: HTMLElement, rawText: string, opts?: RenderContactTextOpts): void {
  parentEl.empty();

  const text = String(rawText ?? "");
  if (!text) return;

  const re = /\[\[([^\]]+?)\]\]/g;
  let last = 0;

  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    const full = m[0];
    const inside = m[1] ?? "";
    const start = m.index ?? 0;
    const end = start + full.length;

    if (start > last) appendText(parentEl, text.slice(last, start));

    // Allow '|' in alias by joining back.
    const parts = inside.split("|");
    const target = String(parts[0] ?? "").trim();
    const alias = parts.length > 1 ? parts.slice(1).join("|").trim() : "";

    const uid = extractContactUidFromWikiTarget(target);
    if (uid) {
      const label = alias || (target.startsWith("C_") ? target.slice(2) : uid);
      const sp = parentEl.createEl("span", { text: label, cls: "rslatte-contact-ref" });
      sp.dataset.contactUid = uid;
      if (opts?.highlightUid && opts.highlightUid === uid) sp.addClass("is-current");
      sp.title = `打开联系人：${label}`;
      sp.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        await openContactByUid(app, uid);
      });
    } else {
      // Not a contact link, keep original.
      appendText(parentEl, full);
    }

    last = end;
  }

  if (last < text.length) appendText(parentEl, text.slice(last));
}

/**
 * 与 {@link renderTextWithContactRefs} 相同的安全 DOM 渲染，但对无别名的 `[[C_<uid>]]` 经 `lookupDisplayName` 异步解析展示名。
 */
export async function renderTextWithContactRefsResolved(
  app: App,
  parentEl: HTMLElement,
  rawText: string,
  lookupDisplayName: (uid: string) => Promise<string | null>,
  opts?: RenderContactTextOpts
): Promise<void> {
  parentEl.empty();

  const text = String(rawText ?? "");
  if (!text) return;

  const re = /\[\[([^\]]+?)\]\]/g;
  let last = 0;

  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    const full = m[0];
    const inside = m[1] ?? "";
    const start = m.index ?? 0;
    const end = start + full.length;

    if (start > last) appendText(parentEl, text.slice(last, start));

    const parts = inside.split("|");
    const target = String(parts[0] ?? "").trim();
    const alias = parts.length > 1 ? parts.slice(1).join("|").trim() : "";

    const uid = extractContactUidFromWikiTarget(target);
    if (uid) {
      let label = alias;
      if (!label) {
        const resolved = await lookupDisplayName(uid);
        label = resolved || (target.startsWith("C_") ? target.slice(2) : uid);
      }
      const sp = parentEl.createEl("span", { text: label, cls: "rslatte-contact-ref" });
      sp.dataset.contactUid = uid;
      if (opts?.highlightUid && opts.highlightUid === uid) sp.addClass("is-current");
      sp.title = `打开联系人：${label}`;
      sp.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        await openContactByUid(app, uid);
      });
    } else {
      appendText(parentEl, full);
    }

    last = end;
  }

  if (last < text.length) appendText(parentEl, text.slice(last));
}
