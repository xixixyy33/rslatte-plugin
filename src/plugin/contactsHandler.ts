import { Notice, TFile, normalizePath } from "obsidian";
import type RSLattePlugin from "../main";
import type { ContactIndexItem } from "../contactsRSLatte/types";

/**
 * Contacts 链接弹窗处理模块
 * 提供联系人链接的点击弹窗功能
 */
export function createContactsHandler(plugin: RSLattePlugin) {
  return {
    /** ===================== Step C7: Contacts link popover in Reading/Preview ===================== */

    setupContactsLinkPostProcessor(): void {
      // Reading/Preview only: markdown post processor runs on rendered preview.
      plugin.registerMarkdownPostProcessor((el: HTMLElement) => {
        try { plugin.bindContactLinksInEl(el); } catch { }
      });
    },

    bindContactLinksInEl(el: HTMLElement): void {
      const links = el.querySelectorAll('a.internal-link');
      links.forEach((a) => {
        const href = String((a as any).dataset?.href || a.getAttribute('data-href') || a.getAttribute('href') || '').trim();
        const uid = plugin.extractContactUidFromHref(href);
        if (!uid) return;

        const aa = a as HTMLAnchorElement;
        if ((aa.dataset as any)?.rslatteContactsBound === '1') return;
        (aa.dataset as any).rslatteContactsBound = '1';
        (aa.dataset as any).rslatteContactUid = uid;

        aa.addEventListener('click', (evt: MouseEvent) => {
          try {
            // Keep native behaviors: Ctrl/Cmd click, middle click, etc.
            if (evt.ctrlKey || evt.metaKey || evt.shiftKey || evt.altKey) return;
            if (evt.button !== 0) return;
            // Prevent default open-file, and show popover instead.
            evt.preventDefault();
            evt.stopPropagation();

            // Toggle: clicking the same link closes.
            if (plugin._contactLinkPopoverEl && (plugin._contactLinkPopoverEl as any)._anchor === aa) {
              plugin.closeContactLinkPopover();
              return;
            }

            void plugin.showContactLinkPopover(aa, uid);
          } catch {
            // ignore
          }
        }, { capture: true });
      });
    },

    extractContactUidFromHref(href: string): string | null {
      const h = (href ?? '').trim();
      if (!h) return null;
      // Accept: C_<uid>, C_<uid>.md, Work/C_<uid>, Work/C_<uid>.md
      const m = h.match(/(?:^|\/)C_([A-Za-z0-9]+)(?:\.md)?$/);
      return m && m[1] ? m[1] : null;
    },

    closeContactLinkPopover(): void {
      try { plugin._contactLinkPopoverCleanup?.(); } catch { }
      plugin._contactLinkPopoverCleanup = null;
      if (plugin._contactLinkPopoverEl) {
        try { plugin._contactLinkPopoverEl.remove(); } catch { }
      }
      plugin._contactLinkPopoverEl = null;
    },

    async findContactByUid(uid: string): Promise<ContactIndexItem | null> {
      try {
        const store = plugin.contactsIndex.getIndexStore();
        const main = await store.readIndex();
        const hit = (main.items ?? []).find((it) => String(it.contact_uid) === uid);
        if (hit) return hit as any;

        const arch = await store.readArchiveIndex();
        const hit2 = (arch.items ?? []).find((it) => String(it.contact_uid) === uid);
        if (hit2) return hit2 as any;
      } catch {
        // ignore
      }
      return null;
    },

    resolveAvatarResourceFromItem(it: ContactIndexItem): string | null {
      try {
        const avatarRel = String((it as any).avatar_path ?? '').trim();
        if (!avatarRel) return null;
        const folder = String((it as any).file_path ?? '').split('/').slice(0, -1).join('/');
        const full = normalizePath(`${folder}/${avatarRel}`);
        const af = plugin.app.vault.getAbstractFileByPath(full);
        if (af && af instanceof TFile) return plugin.app.vault.getResourcePath(af);
      } catch {
        // ignore
      }
      return null;
    },

    positionPopover(pop: HTMLElement, anchor: HTMLElement): void {
      const rect = anchor.getBoundingClientRect();
      const pad = 10;
      const maxW = 360;

      // Ensure rendered to measure
      const w = Math.min(maxW, pop.getBoundingClientRect().width || maxW);

      let left = rect.left + window.scrollX;
      let top = rect.bottom + window.scrollY + 6;

      const vw = window.innerWidth;
      const vh = window.innerHeight;

      if (left + w + pad > vw + window.scrollX) {
        left = vw + window.scrollX - w - pad;
      }
      if (left < window.scrollX + pad) left = window.scrollX + pad;

      // If overflow bottom, place above
      const ph = pop.getBoundingClientRect().height || 200;
      if (top + ph + pad > vh + window.scrollY) {
        top = rect.top + window.scrollY - ph - 6;
      }
      if (top < window.scrollY + pad) top = window.scrollY + pad;

      pop.style.left = `${Math.round(left)}px`;
      pop.style.top = `${Math.round(top)}px`;
    },

    async showContactLinkPopover(anchor: HTMLElement, uid: string): Promise<void> {
      plugin.closeContactLinkPopover();

      const pop = document.body.createDiv({ cls: 'rslatte-contact-popover' });
      (pop as any)._anchor = anchor;
      const card = pop.createDiv({ cls: 'rslatte-contact-popover-card' });

      const it = await plugin.findContactByUid(uid);

      if (!it) {
        card.createDiv({ cls: 'rslatte-contact-popover-title', text: '联系人不存在' });
        card.createDiv({ cls: 'rslatte-muted', text: `uid: ${uid}` });
        plugin._contactLinkPopoverEl = pop;
        plugin.positionPopover(pop, anchor);

        const onDown = (e: MouseEvent) => {
          if (pop.contains(e.target as Node)) return;
          if (anchor.contains(e.target as Node)) return;
          plugin.closeContactLinkPopover();
        };
        const onKey = (e: KeyboardEvent) => {
          if (e.key === 'Escape') plugin.closeContactLinkPopover();
        };
        document.addEventListener('mousedown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        plugin._contactLinkPopoverCleanup = () => {
          document.removeEventListener('mousedown', onDown, true);
          document.removeEventListener('keydown', onKey, true);
        };
        return;
      }

      const top = card.createDiv({ cls: 'rslatte-contact-popover-top' });
      const avatarWrap = top.createDiv({ cls: 'rslatte-contact-popover-avatar' });
      const avatarUrl = plugin.resolveAvatarResourceFromItem(it);
      if (avatarUrl) {
        const img = avatarWrap.createEl('img', { cls: 'rslatte-contact-popover-avatar-img' });
        img.src = avatarUrl;
        img.alt = it.display_name || uid;
        img.onerror = () => {
          try { img.remove(); } catch { }
          avatarWrap.createDiv({ cls: 'rslatte-contact-popover-avatar-placeholder', text: (it.display_name || uid).slice(0, 1).toUpperCase() });
        };
      } else {
        avatarWrap.createDiv({ cls: 'rslatte-contact-popover-avatar-placeholder', text: (it.display_name || uid).slice(0, 1).toUpperCase() });
      }

      const info = top.createDiv({ cls: 'rslatte-contact-popover-info' });
      info.createDiv({ cls: 'rslatte-contact-popover-name', text: it.display_name || uid });
      if (String(it.title ?? '').trim()) {
        info.createDiv({ cls: 'rslatte-contact-popover-sub', text: String(it.title ?? '').trim() });
      }

      const meta = card.createDiv({ cls: 'rslatte-contact-popover-meta' });
      const group = String((it as any).group_name ?? '').trim();
      const status = String((it as any).status ?? 'active').trim() || 'active';
      const tagTxt = [group ? `组: ${group}` : '', status ? `状态: ${status}` : ''].filter(Boolean).join('  ·  ');
      if (tagTxt) meta.createDiv({ cls: 'rslatte-muted', text: tagTxt });

      const aliases = Array.isArray((it as any).aliases) ? (it as any).aliases : [];
      if (aliases.length) {
        card.createDiv({ cls: 'rslatte-muted', text: `别名: ${aliases.join(', ')}` });
      }

      const tags = Array.isArray((it as any).tags) ? (it as any).tags : [];
      if (tags.length) {
        const row = card.createDiv({ cls: 'rslatte-contact-popover-tags' });
        tags.slice(0, 20).forEach((t: string) => row.createDiv({ cls: 'rslatte-tag', text: String(t) }));
      }

      const actions = card.createDiv({ cls: 'rslatte-contact-popover-actions' });
      const btn = actions.createEl('button', { text: '打开联系人文件' });
      btn.addClass('mod-cta');
      btn.onclick = async () => {
        try {
          const af = plugin.app.vault.getAbstractFileByPath(String((it as any).file_path ?? ''));
          if (af && af instanceof TFile) {
            await plugin.app.workspace.getLeaf('tab').openFile(af);
          } else {
            new Notice('无法打开：联系人文件不存在');
          }
        } finally {
          plugin.closeContactLinkPopover();
        }
      };

      plugin._contactLinkPopoverEl = pop;
      plugin.positionPopover(pop, anchor);

      const onDown = (e: MouseEvent) => {
        if (pop.contains(e.target as Node)) return;
        if (anchor.contains(e.target as Node)) return;
        plugin.closeContactLinkPopover();
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') plugin.closeContactLinkPopover();
      };
      const onScroll = () => plugin.closeContactLinkPopover();
      const onResize = () => plugin.closeContactLinkPopover();

      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', onResize, true);

      plugin._contactLinkPopoverCleanup = () => {
        document.removeEventListener('mousedown', onDown, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onResize, true);
      };
    },
  };
}
