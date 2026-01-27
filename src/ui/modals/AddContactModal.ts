import {
  App,
  ButtonComponent,
  Modal,
  Notice,
  Setting,
  ToggleComponent,
  moment,
  normalizePath,
  TFolder,
} from "obsidian";

import type RSLattePlugin from "../../main";
import { computeSortname } from "../../contactsRSLatte/sortname";

type KVPrimary = { label: string; value: string; primary: boolean };
type ImRow = { platform: string; handle: string; primary: boolean };

type AddContactModalOpts = {
  onCreated?: () => Promise<void> | void;
};

function splitList(raw: string): string[] {
  return (raw ?? "")
    .split(/[\n,，;/]+/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

function uniq(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const k = v.trim();
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function sanitizeFolderName(name: string): string {
  const s = (name ?? "").trim();
  if (!s) return "";
  // avoid path traversal / nested folders in a single group
  return s.replace(/[\\/]+/g, "-").trim();
}

function genContactUid(): string {
  // 16 chars-ish, stable enough for local usage
  const ts = Date.now().toString(36).toUpperCase().padStart(8, "0").slice(-8);
  const rnd = Math.random().toString(36).slice(2, 10).toUpperCase().padEnd(8, "X").slice(0, 8);
  return `${ts}${rnd}`;
}

function quoteYamlString(s: string): string {
  // Always quote to reduce edge cases
  return JSON.stringify(String(s ?? ""));
}

function yamlOfValue(v: any, indent: number): string {
  const pad = " ".repeat(indent);
  if (v === null || typeof v === "undefined") return "null";
  if (typeof v === "string") return quoteYamlString(v);
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    const lines: string[] = [];
    for (const it of v) {
      if (it && typeof it === "object" && !Array.isArray(it)) {
        lines.push(`${pad}-`);
        lines.push(yamlOfObject(it, indent + 2));
      } else {
        lines.push(`${pad}- ${yamlOfValue(it, 0)}`);
      }
    }
    return `\n${lines.join("\n")}`;
  }
  if (typeof v === "object") {
    return `\n${yamlOfObject(v, indent)}`;
  }
  return quoteYamlString(String(v));
}

function yamlOfObject(obj: Record<string, any>, indent: number): string {
  const pad = " ".repeat(indent);
  const lines: string[] = [];
  for (const k of Object.keys(obj)) {
    const v = (obj as any)[k];
    if (typeof v === "undefined") continue;
    const rendered = yamlOfValue(v, indent + 2);
    if (rendered.startsWith("\n")) {
      lines.push(`${pad}${k}:`);
      lines.push(rendered.slice(1));
    } else {
      lines.push(`${pad}${k}: ${rendered}`);
    }
  }
  return lines.join("\n");
}

async function ensureFolder(app: App, path: string): Promise<void> {
  const p = normalizePath(path);
  if (!p) return;
  const exists = await app.vault.adapter.exists(p);
  if (exists) return;

  const parts = p.split("/");
  let cur = "";
  for (const seg of parts) {
    cur = cur ? `${cur}/${seg}` : seg;
    const ok = await app.vault.adapter.exists(cur);
    if (ok) continue;
    try {
      await app.vault.createFolder(cur);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes("Folder already exists") || msg.includes("EEXIST")) continue;
      throw e;
    }
  }
}

async function readTemplate(app: App, templatePath: string): Promise<string> {
  const raw = (templatePath ?? "").trim();
  if (!raw) return "";

  const candidates: string[] = [];
  candidates.push(normalizePath(raw));
  if (!/\.md$/i.test(raw)) candidates.push(normalizePath(raw + ".md"));

  for (const p of candidates) {
    const af = app.vault.getAbstractFileByPath(p);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const TFileAny: any = (app as any).vault?.getAbstractFileByPath(p)?.constructor;
    if (af && (af as any).extension === "md") {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await app.vault.read(af as any);
      } catch {
        // ignore
      }
    } else if (af && af instanceof (window as any).TFile) {
      // fallback (in case runtime has TFile global)
      try {
        return await app.vault.read(af as any);
      } catch {
        // ignore
      }
    } else if (af && TFileAny && af instanceof TFileAny) {
      try {
        return await app.vault.read(af as any);
      } catch {
        // ignore
      }
    }
  }
  return "";
}

function applyFrontmatterToTemplate(tplRaw: string, fmYaml: string, vars: Record<string, string>): string {
  const fmBlock = `---\n${fmYaml}\n---\n`;
  const tpl = (tplRaw ?? "").toString();

  const hasFm = /^---\s*\n[\s\S]*?\n---\s*\n?/m.test(tpl);
  let content = tpl;
  if (hasFm) {
    content = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/m, fmBlock);
  } else {
    content = fmBlock + (content ? `\n${content}` : "");
  }

  // Simple placeholder replacement (no dependency on templater)
  for (const [k, v] of Object.entries(vars)) {
    content = content.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), v ?? "");
  }

  // Clear any remaining placeholders to avoid leaking raw template tokens
  // (keeps the file readable even if the template contains extra vars we don't provide yet)
  content = content.replace(/\{\{[^}]+\}\}/g, "");

  // If template body is empty, give a minimal title
  const body = content.replace(/^---[\s\S]*?---\s*\n?/m, "").trim();
  if (!body) {
    content = fmBlock + `\n# ${vars.display_name || vars.displayName || "联系人"}\n`;
  }
  return content;
}

async function writeBinary(app: App, path: string, data: ArrayBuffer): Promise<void> {
  const p = normalizePath(path);
  // Prefer adapter.writeBinary when available
  const adapter: any = app.vault.adapter as any;
  if (adapter && typeof adapter.writeBinary === "function") {
    await adapter.writeBinary(p, data);
    return;
  }
  // Fallback: create or overwrite via vault (createBinary exists in newer Obsidian)
  const af = app.vault.getAbstractFileByPath(p);
  if (!af) {
    const anyVault: any = app.vault as any;
    if (typeof anyVault.createBinary === "function") {
      await anyVault.createBinary(p, data);
      return;
    }
  }
  // Fallback: overwrite existing binary via vault.modifyBinary when available
  const anyVault: any = app.vault as any;
  if (af && typeof anyVault.modifyBinary === "function") {
    await anyVault.modifyBinary(af, data);
    return;
  }

  throw new Error("No supported binary writer found (writeBinary/createBinary/modifyBinary unavailable)");
}

export class AddContactModal extends Modal {
  private opts: AddContactModalOpts;

  constructor(app: App, private plugin: RSLattePlugin, opts?: AddContactModalOpts) {
    super(app);
    this.opts = opts ?? {};
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("新增联系人");

    // Required
    let displayName = "";
    let aliasesRaw = "";
    let groupName = "";
    let title = "";

    // Optional
    let tagsRaw = "";
    let summary = "";
    let company = "";
    let department = "";

    // birthday
    let bType: "solar" | "lunar" = "solar";
    let bMonth = "";
    let bDay = "";
    let bLeap = false;
    let bNote = "";
    let bAddMemo = false; // ✅ 是否添加生日备忘

    const phones: KVPrimary[] = [];
    const emails: KVPrimary[] = [];
    const ims: ImRow[] = [];

    let avatarFile: File | null = null;

    let saveBtn!: ButtonComponent;

    const refreshSaveState = () => {
      const dnOk = (displayName ?? "").trim().length > 0;
      const alOk = uniq(splitList(aliasesRaw)).length > 0;
      const gnOk = (groupName ?? "").trim().length > 0;
      const tOk = (title ?? "").trim().length > 0;
      const ok = dnOk && alOk && gnOk && tOk;
      saveBtn?.setDisabled(!ok);
      return ok;
    };

    // =========================
    // Basic required fields
    // =========================
    new Setting(contentEl)
      .setName("姓名（必填）")
      .setDesc("display_name")
      .addText((t) => {
        t.setPlaceholder("例如：张三");
        t.onChange((v) => {
          displayName = v;
          refreshSaveState();
        });
      });

    new Setting(contentEl)
      .setName("别名（必填，可多项）")
      .setDesc("aliases：用逗号/换行分隔")
      .addTextArea((t) => {
        const ta = t.inputEl;
        ta.rows = 2;
        ta.style.width = "100%";
        t.setPlaceholder("例如：三哥, Zhang San");
        t.onChange((v) => {
          aliasesRaw = v;
          refreshSaveState();
        });
      });

    // Group: use datalist (existing folders) + free text
    const groupSetting = new Setting(contentEl)
      .setName("分组（必填）")
      .setDesc("group_name：对应 contactsDir 下子目录")
      .addText((t) => {
        t.setPlaceholder("例如：Work / Personal");
        // datalist
        const dlId = `rslatte-contacts-group-${Math.random().toString(16).slice(2)}`;
        const dl = document.createElement("datalist");
        dl.id = dlId;
        t.inputEl.setAttr("list", dlId);
        t.inputEl.parentElement?.appendChild(dl);

        // async fill options
        void (async () => {
          try {
            const contactsDir = normalizePath(String((this.plugin.settings as any)?.contactsModule?.contactsDir ?? "90-Contacts").trim() || "90-Contacts");
            const af = this.app.vault.getAbstractFileByPath(contactsDir);
            const dirs: string[] = [];
            if (af && af instanceof TFolder) {
              for (const child of af.children) {
                if (child instanceof TFolder && child.name !== ".attachments" && child.name !== ".rslatte") {
                  dirs.push(child.name);
                }
              }
            }
            dl.empty?.();
            for (const g of dirs) {
              const opt = document.createElement("option");
              opt.value = g;
              dl.appendChild(opt);
            }
          } catch {
            // ignore
          }
        })();

        t.onChange((v) => {
          groupName = v;
          refreshSaveState();
        });
      });
    // avoid eslint unused
    void groupSetting;

    new Setting(contentEl)
      .setName("职务（必填）")
      .setDesc("title")
      .addText((t) => {
        t.setPlaceholder("例如：前端负责人");
        t.onChange((v) => {
          title = v;
          refreshSaveState();
        });
      });

    // =========================
    // Optional simple fields
    // =========================
    contentEl.createEl("hr");
    contentEl.createEl("h4", { text: "可选字段" });

    new Setting(contentEl)
      .setName("标签")
      .setDesc("tags：用逗号/换行分隔")
      .addText((t) => {
        t.setPlaceholder("例如：supplier, frontend");
        t.onChange((v) => (tagsRaw = v));
      });

    new Setting(contentEl)
      .setName("摘要")
      .setDesc("summary")
      .addTextArea((t) => {
        const ta = t.inputEl;
        ta.rows = 3;
        ta.style.width = "100%";
        t.onChange((v) => (summary = v));
      });

    new Setting(contentEl)
      .setName("公司")
      .setDesc("company")
      .addText((t) => {
        t.onChange((v) => (company = v));
      });

    new Setting(contentEl)
      .setName("部门")
      .setDesc("department")
      .addText((t) => {
        t.onChange((v) => (department = v));
      });

    // =========================
    // Avatar
    // =========================
    const avatarWrap = contentEl.createDiv({ cls: "rslatte-contact-modal-block" });
    avatarWrap.createEl("h4", { text: "头像（可选）" });
    const avatarRow = avatarWrap.createDiv({ cls: "rslatte-contact-modal-row" });
    const fileInput = avatarRow.createEl("input", { type: "file" });
    fileInput.setAttr("accept", "image/*");
    const fileName = avatarRow.createDiv({ cls: "rslatte-muted", text: "未选择" });
    const clearBtn = avatarRow.createEl("button", { cls: "rslatte-icon-btn", text: "清除" });
    clearBtn.onclick = () => {
      avatarFile = null;
      fileInput.value = "";
      fileName.setText("未选择");
    };
    fileInput.onchange = () => {
      const f = (fileInput.files && fileInput.files[0]) ? fileInput.files[0] : null;
      avatarFile = f;
      fileName.setText(f ? f.name : "未选择");
    };

    // =========================
    // Multi rows: phones/emails/im
    // =========================
    const renderKvList = (
      root: HTMLElement,
      titleText: string,
      rows: KVPrimary[],
      cols: { labelPh: string; valuePh: string }
    ) => {
      const block = root.createDiv({ cls: "rslatte-contact-modal-block" });
      block.createEl("h4", { text: titleText });
      const list = block.createDiv({ cls: "rslatte-contact-modal-list" });

      const rerender = () => {
        list.empty();
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          const rowEl = list.createDiv({ cls: "rslatte-contact-modal-list-row" });

          const label = rowEl.createEl("input", { type: "text", cls: "col-label", placeholder: cols.labelPh });
          label.value = r.label;
          label.oninput = () => (r.label = label.value);

          const val = rowEl.createEl("input", { type: "text", cls: "col-value", placeholder: cols.valuePh });
          val.value = r.value;
          val.oninput = () => (r.value = val.value);

          const primary = rowEl.createEl("input", { type: "checkbox", cls: "col-primary" });
          primary.checked = !!r.primary;
          primary.onchange = () => {
            const checked = primary.checked;
            for (const it of rows) it.primary = false;
            r.primary = checked;
            rerender();
          };
          rowEl.createDiv({ cls: "col-primary-label", text: "primary" });

          const rm = rowEl.createEl("button", { cls: "rslatte-icon-btn", text: "✖" });
          rm.title = "删除";
          rm.onclick = () => {
            rows.splice(i, 1);
            rerender();
          };
        }
      };

      const addRow = block.createEl("button", { cls: "rslatte-icon-btn", text: "➕ 添加" });
      addRow.onclick = () => {
        rows.push({ label: "", value: "", primary: rows.length === 0 });
        rerender();
      };

      rerender();
    };

    const renderImList = (root: HTMLElement) => {
      const block = root.createDiv({ cls: "rslatte-contact-modal-block" });
      block.createEl("h4", { text: "IM（可多项）" });
      const list = block.createDiv({ cls: "rslatte-contact-modal-list" });

      const rerender = () => {
        list.empty();
        for (let i = 0; i < ims.length; i++) {
          const r = ims[i];
          const rowEl = list.createDiv({ cls: "rslatte-contact-modal-list-row" });

          const platform = rowEl.createEl("input", { type: "text", cls: "col-label", placeholder: "platform" });
          platform.value = r.platform;
          platform.oninput = () => (r.platform = platform.value);

          const handle = rowEl.createEl("input", { type: "text", cls: "col-value", placeholder: "handle" });
          handle.value = r.handle;
          handle.oninput = () => (r.handle = handle.value);

          const primary = rowEl.createEl("input", { type: "checkbox", cls: "col-primary" });
          primary.checked = !!r.primary;
          primary.onchange = () => {
            const checked = primary.checked;
            for (const it of ims) it.primary = false;
            r.primary = checked;
            rerender();
          };
          rowEl.createDiv({ cls: "col-primary-label", text: "primary" });

          const rm = rowEl.createEl("button", { cls: "rslatte-icon-btn", text: "✖" });
          rm.title = "删除";
          rm.onclick = () => {
            ims.splice(i, 1);
            rerender();
          };
        }
      };

      const addRow = block.createEl("button", { cls: "rslatte-icon-btn", text: "➕ 添加" });
      addRow.onclick = () => {
        ims.push({ platform: "", handle: "", primary: ims.length === 0 });
        rerender();
      };

      rerender();
    };

    renderKvList(contentEl, "电话（可多项）", phones, { labelPh: "label", valuePh: "value" });
    renderKvList(contentEl, "邮箱（可多项）", emails, { labelPh: "label", valuePh: "value" });
    renderImList(contentEl);

    // =========================
    // Birthday
    // =========================
    const b = contentEl.createDiv({ cls: "rslatte-contact-modal-block" });
    b.createEl("h4", { text: "生日（可选）" });
    const bRow = b.createDiv({ cls: "rslatte-contact-modal-list-row" });

    const typeSel = bRow.createEl("select", { cls: "col-label" });
    [
      { value: "solar", label: "阳历" },
      { value: "lunar", label: "农历" },
    ].forEach((t) => {
      const opt = typeSel.createEl("option", { value: t.value, text: t.label });
      if (t.value === bType) opt.selected = true;
    });
    typeSel.onchange = () => (bType = typeSel.value as any);

    const monthIn = bRow.createEl("input", { type: "number", cls: "col-value", placeholder: "month" });
    monthIn.min = "1";
    monthIn.max = "12";
    monthIn.value = bMonth;
    monthIn.oninput = () => (bMonth = monthIn.value);

    const dayIn = bRow.createEl("input", { type: "number", cls: "col-value", placeholder: "day" });
    dayIn.min = "1";
    dayIn.max = "31";
    dayIn.value = bDay;
    dayIn.oninput = () => (bDay = dayIn.value);

      const leapWrap = bRow.createDiv({ cls: "rslatte-contact-modal-inline" });
      leapWrap.createSpan({ text: "leap" });
      const leap = new ToggleComponent(leapWrap);
      leap.setValue(bLeap);
      leap.onChange((v) => (bLeap = v));

      const noteIn = b.createEl("input", { type: "text", placeholder: "note", cls: "rslatte-contacts-search" });
      noteIn.oninput = () => (bNote = noteIn.value);

      // ✅ 是否添加生日备忘开关
      const addMemoWrap = b.createDiv({ cls: "rslatte-contact-modal-inline" });
      addMemoWrap.createSpan({ text: "添加生日备忘" });
      const addMemoToggle = new ToggleComponent(addMemoWrap);
      addMemoToggle.setValue(bAddMemo);
      addMemoToggle.onChange((v) => (bAddMemo = v));

    // =========================
    // Actions
    // =========================
    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });
    saveBtn = new ButtonComponent(btnRow)
      .setButtonText("创建")
      .setCta()
      .onClick(() => void doSave());
    new ButtonComponent(btnRow).setButtonText("关闭").onClick(() => this.close());

    const doSave = async () => {
      if (!refreshSaveState()) {
        new Notice("请填写必填字段：姓名 / 别名 / 分组 / 职务");
        return;
      }

      const contactsDir = normalizePath(String((this.plugin.settings as any)?.contactsModule?.contactsDir ?? "90-Contacts").trim() || "90-Contacts");
      const templatePath = normalizePath(String((this.plugin.settings as any)?.contactsModule?.templatePath ?? "99-Templates/t_contact.md").trim() || "99-Templates/t_contact.md");

      const gn = sanitizeFolderName(groupName);
      if (!gn) {
        new Notice("分组不能为空");
        return;
      }

      const uid = genContactUid();
      const now = new Date().toISOString();
      const filePath = normalizePath(`${contactsDir}/${gn}/C_${uid}.md`);
      const attachDir = normalizePath(`${contactsDir}/${gn}/.attachments`);

      // avatar write first (so md can reference it)
      let avatarRel = "";
      if (avatarFile) {
        const name = avatarFile.name || "avatar";
        const ext = (() => {
          const m = name.match(/\.([A-Za-z0-9]+)$/);
          if (m) return m[1].toLowerCase();
          const mt = String((avatarFile as any).type ?? "").toLowerCase();
          if (mt.includes("png")) return "png";
          if (mt.includes("jpeg") || mt.includes("jpg")) return "jpg";
          if (mt.includes("webp")) return "webp";
          return "png";
        })();
        avatarRel = `.attachments/${uid}.${ext}`;
        const fullAvatar = normalizePath(`${contactsDir}/${gn}/${avatarRel}`);
        try {
          await ensureFolder(this.app, attachDir);
          const buf = await avatarFile.arrayBuffer();
          await writeBinary(this.app, fullAvatar, buf);
        } catch (e: any) {
          new Notice(`头像保存失败：${e?.message ?? String(e)}`);
          return;
        }
      }

      // build structured fields
      const aliases = uniq(splitList(aliasesRaw));
      const tags = uniq(splitList(tagsRaw));
      const cleanKv = (rows: KVPrimary[]) =>
        rows
          .map((r) => ({ label: (r.label ?? "").trim(), value: (r.value ?? "").trim(), primary: !!r.primary }))
          .filter((r) => r.label || r.value);
      const cleanIm = (rows: ImRow[]) =>
        rows
          .map((r) => ({ platform: (r.platform ?? "").trim(), handle: (r.handle ?? "").trim(), primary: !!r.primary }))
          .filter((r) => r.platform || r.handle);

      const fmObj: Record<string, any> = {
        type: "contact",
        contact_uid: uid,
        display_name: (displayName ?? "").trim(),
        sortname: computeSortname((displayName ?? "").trim()),
        aliases,
        group_name: gn,
        title: (title ?? "").trim(),
        status: "active",
        cancelled_at: null,
        tags: tags.length ? tags : [],
        summary: (summary ?? "").trim(),
        company: (company ?? "").trim(),
        department: (department ?? "").trim(),
        avatar_path: avatarRel ? avatarRel : "",
        phones: cleanKv(phones),
        emails: cleanKv(emails),
        im: cleanIm(ims).map((r) => ({ platform: r.platform, handle: r.handle, primary: r.primary })),
        birthday: (() => {
          const m = parseInt(bMonth, 10);
          const d = parseInt(bDay, 10);
          if (!m || !d) return null;
          return { type: bType, month: m, day: d, leap_month: !!bLeap, note: (bNote ?? "").trim() };
        })(),
        last_interaction_at: null,
        created_at: now,
        updated_at: now,
        extra: {},
      };

      // =========================
      // Template vars for body placeholders
      // =========================
      const status = String(fmObj.status ?? "active");
      const statusDisplay = status; // keep english to align with existing status field
      const aliasesInline = (aliases ?? []).join(" / ");
      const tagsInline = (tags ?? []).join(" / ");
      const fmtPrimary = (p: boolean) => (p ? " (primary)" : "");
      const phonesLines = cleanKv(phones)
        .map((r) => `- ${(r.label || "phone").trim()}: ${(r.value || "").trim()}${fmtPrimary(!!r.primary)}`)
        .join("\n");
      const emailsLines = cleanKv(emails)
        .map((r) => `- ${(r.label || "email").trim()}: ${(r.value || "").trim()}${fmtPrimary(!!r.primary)}`)
        .join("\n");
      const imLines = cleanIm(ims)
        .map((r) => `- ${(r.platform || "im").trim()}: ${(r.handle || "").trim()}${fmtPrimary(!!r.primary)}`)
        .join("\n");

      const birthdayObj = fmObj.birthday as any | null | undefined;
      const birthdayType = birthdayObj?.type ? String(birthdayObj.type) : "";
      const birthdayDisplayType = birthdayType === "lunar" ? "农历" : birthdayType === "solar" ? "阳历" : "";
      const bMonthV = birthdayObj?.month ? String(birthdayObj.month) : "";
      const bDayV = birthdayObj?.day ? String(birthdayObj.day) : "";
      const bLeapV = typeof birthdayObj?.leap_month === "boolean" ? String(birthdayObj.leap_month) : "";
      const bNoteV = birthdayObj?.note ? String(birthdayObj.note) : "";

      const templateVars: Record<string, string> = {
        // Common keys
        display_name: fmObj.display_name,
        displayName: fmObj.display_name,
        contact_uid: uid,
        contactUid: uid,
        group_name: gn,
        groupName: gn,
        title: fmObj.title,
        status,
        status_display: statusDisplay,
        statusDisplay,
        summary: String(fmObj.summary ?? ""),
        company: String(fmObj.company ?? ""),
        department: String(fmObj.department ?? ""),
        avatar_path: String(fmObj.avatar_path ?? ""),

        // Lists / inline
        aliases_inline: aliasesInline,
        tags_inline: tagsInline,
        phones_lines: phonesLines,
        emails_lines: emailsLines,
        im_lines: imLines,

        // Some templates may still reference YAML placeholders
        aliases: JSON.stringify(aliases ?? []),
        tags: JSON.stringify(tags ?? []),
        phones: JSON.stringify(cleanKv(phones)),
        emails: JSON.stringify(cleanKv(emails)),
        im: JSON.stringify(cleanIm(ims).map((r) => ({ platform: r.platform, handle: r.handle, primary: !!r.primary }))),
        cancelled_at: "null",
        last_interaction_at: "null",
        created_at: now,
        updated_at: now,

        // Birthday dot-keys used by the provided template
        "birthday.type": birthdayType,
        "birthday.month": bMonthV,
        "birthday.day": bDayV,
        "birthday.leap_month": bLeapV,
        "birthday.note": bNoteV,
        birthday_display_type: birthdayDisplayType,

        // Extra fields placeholders
        "extra.note": "",
        "extra.custom_fields": "{}",
        custom_fields_lines: "",
      };

      // remove empty fields for nicer yaml
      if (!fmObj.summary) delete fmObj.summary;
      if (!fmObj.company) delete fmObj.company;
      if (!fmObj.department) delete fmObj.department;
      if (!fmObj.avatar_path) delete fmObj.avatar_path;
      if (!fmObj.phones?.length) delete fmObj.phones;
      if (!fmObj.emails?.length) delete fmObj.emails;
      if (!fmObj.im?.length) delete fmObj.im;
      if (!fmObj.tags?.length) delete fmObj.tags;
      if (!fmObj.birthday) delete fmObj.birthday;
      if (fmObj.extra && Object.keys(fmObj.extra).length === 0) delete fmObj.extra;

      const fmYaml = yamlOfObject(fmObj, 0);

      try {
        await ensureFolder(this.app, normalizePath(`${contactsDir}/${gn}`));
        const tplRaw = await readTemplate(this.app, templatePath);
        const content = applyFrontmatterToTemplate(tplRaw, fmYaml, templateVars);

        const exists = await this.app.vault.adapter.exists(filePath);
        if (exists) {
          new Notice("创建失败：目标文件已存在");
          return;
        }
        await this.app.vault.create(filePath, content);

        // Step C8: DB sync (best-effort, does not block local md)
        try {
          await this.plugin.tryContactsDbSyncByPath(filePath, "create");
        } catch {
          // ignore
        }

        // Work events: append-only stream for timeline/statistics (best-effort)
        try {
          const momentFn = moment as any;
          await (this.plugin as any).workEventSvc?.append({
            ts: new Date().toISOString(),
            kind: "contact",
            action: "create",
            source: "ui",
            ref: {
              contact_uid: uid,
              display_name: fmObj.display_name,
              group_name: gn,
              file_path: filePath,
              status: "active",
            },
            summary: `➕ 新增联系人：${fmObj.display_name}`,
          });
        } catch {
          // ignore
        }

        new Notice("联系人已创建");

        // ✅ 如果启用了生日备忘，创建或更新对应的备忘记录
        if (bAddMemo && fmObj.birthday) {
          try {
            const bMonthNum = parseInt(bMonth, 10);
            const bDayNum = parseInt(bDay, 10);
            if (bMonthNum && bDayNum) {
              await this.plugin.taskRSLatte.createOrUpdateContactBirthdayMemo({
                contactUid: uid,
                contactName: fmObj.display_name,
                contactFile: filePath,
                birthdayType: bType,
                month: bMonthNum,
                day: bDayNum,
                leapMonth: bLeap,
              });
              
              // ✅ 刷新索引以便立即在侧边栏显示
              await this.plugin.taskRSLatte.refreshIndexAndSync({ sync: false, noticeOnError: false });
            }
          } catch (e: any) {
            console.warn("[Contacts][Add] Failed to create/update birthday memo", e);
            // 不阻止联系人创建，仅记录警告
          }
        }

        try {
          await this.opts.onCreated?.();
        } catch {
          // ignore
        }

        this.close();
      } catch (e: any) {
        new Notice(`创建失败：${e?.message ?? String(e)}`);
      }
    };

    window.setTimeout(() => refreshSaveState(), 0);
  }
}
