import type { App } from "obsidian";
import { extractContactUidFromWikiTarget } from "../../services/contacts/contactRefParser";

export type RenderContactTextOpts = {
  /** When provided, this uid will be highlighted as the current contact (e.g. on contact card). */
  highlightUid?: string | null;
};

function appendText(parentEl: HTMLElement, text: string): void {
  if (!text) return;
  parentEl.createEl("span", { text });
}

function openContactByUid(app: App, uid: string): void {
  try {
    // Use wiki-link resolution, so we don't need to know the folder.
    // It will resolve to existing C_<uid>.md if present.
    void app.workspace.openLinkText(`C_${uid}`, "", false);
  } catch {
    // ignore
  }
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
      sp.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openContactByUid(app, uid);
      });
    } else {
      // Not a contact link, keep original.
      appendText(parentEl, full);
    }

    last = end;
  }

  if (last < text.length) appendText(parentEl, text.slice(last));
}
