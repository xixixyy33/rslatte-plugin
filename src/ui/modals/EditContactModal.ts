import {
  App,
  ButtonComponent,
  Modal,
  Notice,
  Setting,
  TextComponent,
  ToggleComponent,
  TFile,
  moment,
  normalizePath,
  parseYaml,
} from "obsidian";

import type RSLattePlugin from "../../main";
import { computeSortname } from "../../contactsRSLatte/sortname";

type KVPrimary = { label: string; value: string; primary: boolean };
type ImRow = { platform: string; handle: string; primary: boolean };

type EditContactModalOpts = {
  onUpdated?: () => Promise<void> | void;
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
  return s.replace(/[\\/]+/g, "-").trim();
}

function quoteYamlString(s: string): string {
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

function extractFrontmatterBlock(text: string): { yaml: string; body: string } {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return { yaml: "", body: text };
  return { yaml: m[1] ?? "", body: text.slice(m[0].length) };
}

function buildFileTextWithFrontmatter(bodyWithoutFm: string, fmYaml: string): string {
  const fmBlock = `---\n${fmYaml}\n---\n`;
  // bodyWithoutFm keeps exactly the user's正文（包括前导空行）
  return fmBlock + (bodyWithoutFm ?? "");
}

// =========================
// Contact body: generated snapshot
// =========================
const CONTACT_GEN_START = "<!-- rslatte:contact:generated:start -->";
const CONTACT_GEN_END = "<!-- rslatte:contact:generated:end -->";

function joinSlash(values: any): string {
  if (!Array.isArray(values)) return "";
  const xs = values.map((x) => String(x ?? "").trim()).filter(Boolean);
  return xs.join(" / ");
}

function renderKvLines(rows: any): string[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const out: string[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const label = String((r as any).label ?? "").trim();
    const value = String((r as any).value ?? "").trim();
    if (!label && !value) continue;
    if (label && value) out.push(`- ${label}：${value}`);
    else out.push(`- ${label || value}`);
  }
  return out;
}

function renderImLines(rows: any): string[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const out: string[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const platform = String((r as any).platform ?? "").trim();
    const handle = String((r as any).handle ?? "").trim();
    if (!platform && !handle) continue;
    if (platform && handle) out.push(`- ${platform}：${handle}`);
    else out.push(`- ${platform || handle}`);
  }
  return out;
}

function renderGeneratedContactSection(obj: Record<string, any>): string {
  const displayName = String(obj.display_name ?? "").trim();
  const aliases = joinSlash(obj.aliases);
  const groupName = String(obj.group_name ?? "").trim();
  const title = String(obj.title ?? "").trim();
  const status = String(obj.status ?? "").trim();
  const tags = joinSlash(obj.tags);

  const summary = String(obj.summary ?? "").trim();
  const company = String(obj.company ?? "").trim();
  const department = String(obj.department ?? "").trim();

  const phones = renderKvLines(obj.phones);
  const emails = renderKvLines(obj.emails);
  const im = renderImLines(obj.im);

  const lines: string[] = [];
  lines.push(CONTACT_GEN_START);
  lines.push("## 基本信息");
  if (displayName) lines.push(`- 姓名：${displayName}`);
  if (aliases) lines.push(`- 别名：${aliases}`);
  if (groupName) lines.push(`- 分组：${groupName}`);
  if (title) lines.push(`- 职位/头衔：${title}`);
  if (status) lines.push(`- 状态：${status}`);
  if (tags) lines.push(`- 标签：${tags}`);
  lines.push("");
  lines.push("## 工作信息");
  if (company) lines.push(`- 公司：${company}`);
  if (department) lines.push(`- 部门：${department}`);
  if (summary) lines.push(`- 简介：${summary}`);
  lines.push("");
  lines.push("## 联系方式");
  if (phones.length) {
    lines.push("### 电话（phones）");
    lines.push(...phones);
    lines.push("");
  }
  if (emails.length) {
    lines.push("### 邮箱（emails）");
    lines.push(...emails);
    lines.push("");
  }
  if (im.length) {
    lines.push("### 即时通讯（im）");
    lines.push(...im);
    lines.push("");
  }
  lines.push(CONTACT_GEN_END);
  return lines.join("\n").trim() + "\n";
}

function upsertGeneratedContactSection(body: string, obj: Record<string, any>): string {
  const src = String(body ?? "");
  const gen = renderGeneratedContactSection(obj);

  // 1) Replace marker-based block if exists
  const sIdx = src.indexOf(CONTACT_GEN_START);
  const eIdx = src.indexOf(CONTACT_GEN_END);
  if (sIdx >= 0 && eIdx > sIdx) {
    const endPos = eIdx + CONTACT_GEN_END.length;
    return src.slice(0, sIdx) + gen + src.slice(endPos).replace(/^\n+/, "\n");
  }

  // 2) Replace legacy generated section if it looks like auto snapshot
  const legacyStart = src.match(/^##\s+基本信息\s*$/m);
  if (legacyStart && typeof legacyStart.index === "number") {
    const startPos = legacyStart.index;
    const tail = src.slice(startPos);
    // Heuristic: must include some known fields shortly after
    const headSample = tail.slice(0, 1200);
    const looksAuto = /-\s*姓名：/.test(headSample) || /-\s*别名：/.test(headSample) || /-\s*公司：/.test(headSample);
    if (looksAuto) {
      // End at next H2 that is not one of the contact snapshot headings
      const endRe = /^##\s+(?!基本信息|工作信息|联系方式)\S.*$/m;
      const endM = tail.slice(1).match(endRe);
      const endPos = endM && typeof endM.index === "number" ? (startPos + 1 + endM.index) : src.length;
      return src.slice(0, startPos) + gen + src.slice(endPos).replace(/^\n+/, "\n");
    }
  }

  // 3) Insert after the first H1 if present, otherwise prepend.
  const h1 = src.match(/^#\s+.*$/m);
  if (h1 && typeof h1.index === "number") {
    const insertPos = h1.index + h1[0].length;
    const after = src.slice(insertPos);
    const sep = after.startsWith("\n\n") ? "\n\n" : "\n\n";
    return src.slice(0, insertPos) + sep + gen + after.replace(/^\n+/, "\n");
  }
  return gen + "\n" + src.replace(/^\n+/, "\n");
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

async function writeBinary(app: App, path: string, data: ArrayBuffer): Promise<void> {
  const p = normalizePath(path);
  const adapter: any = app.vault.adapter as any;
  if (adapter && typeof adapter.writeBinary === "function") {
    await adapter.writeBinary(p, data);
    return;
  }
  const af = app.vault.getAbstractFileByPath(p);
  const anyVault: any = app.vault as any;
  if (!af && typeof anyVault.createBinary === "function") {
    await anyVault.createBinary(p, data);
    return;
  }
  if (af && typeof anyVault.modifyBinary === "function") {
    await anyVault.modifyBinary(af, data);
    return;
  }
  throw new Error("No supported binary writer found (writeBinary/createBinary/modifyBinary unavailable)");
}

function fileNameUidFallback(file: TFile): string {
  const m = (file.name ?? "").match(/^C_(.+?)\.md$/i);
  return (m?.[1] ?? "").trim();
}

function normalizeRows(rows: KVPrimary[]): KVPrimary[] {
  return rows
    .map((r) => ({
      label: (r.label ?? "").trim(),
      value: (r.value ?? "").trim(),
      primary: !!r.primary,
    }))
    .filter((r) => r.label || r.value);
}

function normalizeImRows(rows: ImRow[]): ImRow[] {
  return rows
    .map((r) => ({
      platform: (r.platform ?? "").trim(),
      handle: (r.handle ?? "").trim(),
      primary: !!r.primary,
    }))
    .filter((r) => r.platform || r.handle);
}

function enforceSinglePrimary<T extends { primary: boolean }>(rows: T[]): void {
  let seen = false;
  for (const r of rows) {
    if (!r.primary) continue;
    if (!seen) {
      seen = true;
      continue;
    }
    r.primary = false;
  }
}

export class EditContactModal extends Modal {
  private opts: EditContactModalOpts;
  private file: TFile;

  constructor(app: App, private plugin: RSLattePlugin, file: TFile, opts?: EditContactModalOpts) {
    super(app);
    this.file = file;
    this.opts = opts ?? {};
  }

  private getContactsDir(): string {
    const sAny: any = this.plugin.settings as any;
    return String(sAny?.contactsModule?.contactsDir ?? "90-Contacts");
  }

  private getNowIso(): string {
    return new Date().toISOString();
  }

  private async loadFrontmatterObject(): Promise<Record<string, any>> {
    const cache = this.app.metadataCache.getFileCache(this.file);
    const fm = (cache as any)?.frontmatter;
    if (fm && typeof fm === "object") {
      // Obsidian frontmatter includes internal keys like position; drop them.
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(fm)) {
        if (k === "position") continue;
        out[k] = v;
      }
      return out;
    }

    // fallback: parse YAML block from raw file
    const raw = await this.app.vault.read(this.file);
    const { yaml } = extractFrontmatterBlock(raw);
    if (!yaml.trim()) return {};
    try {
      const obj = parseYaml(yaml);
      return (obj && typeof obj === "object") ? (obj as any) : {};
    } catch {
      return {};
    }
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("编辑联系人");

    void (async () => {
      const fm0 = await this.loadFrontmatterObject();

      // Required
      let displayName = String(fm0.display_name ?? "");
      let aliasesRaw = Array.isArray(fm0.aliases) ? (fm0.aliases as any[]).join(", ") : String(fm0.aliases ?? "");
      let groupName = String(fm0.group_name ?? "");
      let title = String(fm0.title ?? "");

      // Optional
      let status: "active" | "cancelled" = (String(fm0.status ?? "active") === "cancelled") ? "cancelled" : "active";
      let cancelledAt = fm0.cancelled_at ?? null;
      let tagsRaw = Array.isArray(fm0.tags) ? (fm0.tags as any[]).join(", ") : String(fm0.tags ?? "");
      let summary = String(fm0.summary ?? "");
      let company = String(fm0.company ?? "");
      let department = String(fm0.department ?? "");
      let avatarPath = String(fm0.avatar_path ?? "");

      // birthday
      const b0 = (fm0.birthday && typeof fm0.birthday === "object") ? fm0.birthday : {};
      let bType: "solar" | "lunar" = (String((b0 as any).type ?? "solar") === "lunar") ? "lunar" : "solar";
      let bMonth = (typeof (b0 as any).month === "number") ? String((b0 as any).month) : String((b0 as any).month ?? "");
      let bDay = (typeof (b0 as any).day === "number") ? String((b0 as any).day) : String((b0 as any).day ?? "");
      let bLeap = !!(b0 as any).leap_month;
      let bNote = String((b0 as any).note ?? "");
      // ✅ 是否添加生日备忘（从 extra.birthday_memo 读取，如果没有则默认为 false）
      let bAddMemo = !!(fm0.extra && typeof fm0.extra === "object" && (fm0.extra as any).birthday_memo);

      // arrays
      let phones: KVPrimary[] = Array.isArray(fm0.phones) ? (fm0.phones as any[]).map((r) => ({
        label: String(r?.label ?? ""),
        value: String(r?.value ?? ""),
        primary: !!r?.primary,
      })) : [];
      let emails: KVPrimary[] = Array.isArray(fm0.emails) ? (fm0.emails as any[]).map((r) => ({
        label: String(r?.label ?? ""),
        value: String(r?.value ?? ""),
        primary: !!r?.primary,
      })) : [];
      let im: ImRow[] = Array.isArray(fm0.im) ? (fm0.im as any[]).map((r) => ({
        platform: String(r?.platform ?? ""),
        handle: String(r?.handle ?? ""),
        primary: !!r?.primary,
      })) : [];

      enforceSinglePrimary(phones);
      enforceSinglePrimary(emails);
      enforceSinglePrimary(im);

      // uid stability
      const contactUid = String(fm0.contact_uid ?? fileNameUidFallback(this.file) ?? "").trim();
      if (!contactUid) {
        new Notice("无法识别 contact_uid（文件名也不符合 C_<uid>.md），将按当前 frontmatter 保存");
      }

      // avatar upload
      let avatarFile: File | null = null;

      const help = contentEl.createDiv({ cls: "rslatte-muted" });
      help.setText("仅更新 frontmatter；正文保持不变。更新后会刷新索引与侧边栏。\n注意：group_name 变更会移动文件（文件名固定 C_<uid>.md）。");

      const errEl = contentEl.createDiv({ cls: "rslatte-error" });
      errEl.hide();

      const validate = () => {
        const aliases = uniq(splitList(aliasesRaw));
        const ok = !!displayName.trim() && aliases.length > 0 && !!sanitizeFolderName(groupName) && !!title.trim();
        return { ok, aliases };
      };

      const setErr = (msg: string) => {
        if (!msg) {
          errEl.hide();
          errEl.setText("");
        } else {
          errEl.show();
          errEl.setText(msg);
        }
      };

      // Basic fields
      new Setting(contentEl)
        .setName("姓名（display_name）")
        .setDesc("必填")
        .addText((t) => {
          t.setValue(displayName);
          t.onChange((v) => {
            displayName = v;
            setErr("");
          });
        });

      new Setting(contentEl)
        .setName("别名（aliases）")
        .setDesc("必填，逗号/换行分隔")
        .addText((t) => {
          t.setValue(aliasesRaw);
          t.onChange((v) => {
            aliasesRaw = v;
            setErr("");
          });
        });

      new Setting(contentEl)
        .setName("分组（group_name）")
        .setDesc("必填：对应 contactsDir 下子目录")
        .addText((t) => {
          t.setValue(groupName);
          t.onChange((v) => {
            groupName = v;
            setErr("");
          });
        });

      new Setting(contentEl)
        .setName("职位/头衔（title）")
        .setDesc("必填")
        .addText((t) => {
          t.setValue(title);
          t.onChange((v) => {
            title = v;
            setErr("");
          });
        });

      // Status (read-only toggle for now; cancel/restore is C6)
      new Setting(contentEl)
        .setName("状态（status）")
        .setDesc("C5 允许编辑，但建议用 C6 的取消/恢复按钮")
        .addToggle((t) => {
          t.setValue(status === "cancelled");
          t.onChange((v) => {
            status = v ? "cancelled" : "active";
            if (status === "active") cancelledAt = null;
            setErr("");
          });
        });

      new Setting(contentEl)
        .setName("标签（tags）")
        .setDesc("选填，逗号/换行分隔")
        .addText((t) => {
          t.setValue(tagsRaw);
          t.onChange((v) => {
            tagsRaw = v;
          });
        });

      new Setting(contentEl)
        .setName("简介（summary）")
        .setDesc("选填")
        .addTextArea((t) => {
          t.setValue(summary);
          t.onChange((v) => {
            summary = v;
          });
        });

      new Setting(contentEl)
        .setName("公司（company）")
        .setDesc("选填")
        .addText((t) => {
          t.setValue(company);
          t.onChange((v) => {
            company = v;
          });
        });

      new Setting(contentEl)
        .setName("部门（department）")
        .setDesc("选填")
        .addText((t) => {
          t.setValue(department);
          t.onChange((v) => {
            department = v;
          });
        });

      // Avatar
      const avatarWrap = contentEl.createDiv({ cls: "rslatte-contact-modal-block" });
      avatarWrap.createEl("h4", { text: "头像（可选）" });
      const avatarRow = avatarWrap.createDiv({ cls: "rslatte-contact-modal-row" });
      const fileInput = avatarRow.createEl("input", { type: "file" });
      fileInput.setAttr("accept", "image/*");
      const fileName = avatarRow.createDiv({ cls: "rslatte-muted", text: avatarPath ? avatarPath : "未选择" });
      const clearBtn = avatarRow.createEl("button", { cls: "rslatte-icon-btn", text: "清除" });
      clearBtn.onclick = () => {
        avatarFile = null;
        fileInput.value = "";
        fileName.setText(avatarPath ? avatarPath : "未选择");
      };
      fileInput.onchange = () => {
        const f = (fileInput.files && fileInput.files[0]) ? fileInput.files[0] : null;
        avatarFile = f;
        fileName.setText(f ? f.name : (avatarPath ? avatarPath : "未选择"));
      };

      // Phones/Emails/IM blocks
      const renderKvBlock = (
        titleText: string,
        rows: KVPrimary[],
        onChange: () => void,
      ) => {
        const block = contentEl.createDiv({ cls: "rslatte-contact-modal-block" });
        block.createEl("h4", { text: titleText });
        const list = block.createDiv({ cls: "rslatte-contact-modal-list" });

        const rerender = () => {
          list.empty();
          for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            const rowEl = list.createDiv({ cls: "rslatte-contact-modal-list-row" });

            const label = rowEl.createEl("input", { type: "text", cls: "col-label", placeholder: "label" });
            label.value = r.label;
            label.oninput = () => {
              r.label = label.value;
              onChange();
            };

            const val = rowEl.createEl("input", { type: "text", cls: "col-value", placeholder: "value" });
            val.value = r.value;
            val.oninput = () => {
              r.value = val.value;
              onChange();
            };

            const primary = rowEl.createEl("input", { type: "checkbox", cls: "col-primary" });
            primary.checked = !!r.primary;
            primary.onchange = () => {
              const checked = primary.checked;
              for (const it of rows) it.primary = false;
              r.primary = checked;
              onChange();
              rerender();
            };
            rowEl.createDiv({ cls: "col-primary-label", text: "primary" });

            const rm = rowEl.createEl("button", { cls: "rslatte-icon-btn", text: "✖" });
            rm.title = "删除";
            rm.onclick = () => {
              rows.splice(i, 1);
              onChange();
              rerender();
            };
          }
        };

        const addRow = block.createEl("button", { cls: "rslatte-icon-btn", text: "➕ 添加" });
        addRow.onclick = () => {
          rows.push({ label: "", value: "", primary: rows.length === 0 });
          onChange();
          rerender();
        };
        rerender();
      };

      const renderImBlock = (rows: ImRow[], onChange: () => void) => {
        const block = contentEl.createDiv({ cls: "rslatte-contact-modal-block" });
        block.createEl("h4", { text: "IM（可多项）" });
        const list = block.createDiv({ cls: "rslatte-contact-modal-list" });

        const rerender = () => {
          list.empty();
          for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            const rowEl = list.createDiv({ cls: "rslatte-contact-modal-list-row" });

            const platform = rowEl.createEl("input", { type: "text", cls: "col-label", placeholder: "platform" });
            platform.value = r.platform;
            platform.oninput = () => {
              r.platform = platform.value;
              onChange();
            };

            const handle = rowEl.createEl("input", { type: "text", cls: "col-value", placeholder: "handle" });
            handle.value = r.handle;
            handle.oninput = () => {
              r.handle = handle.value;
              onChange();
            };

            const primary = rowEl.createEl("input", { type: "checkbox", cls: "col-primary" });
            primary.checked = !!r.primary;
            primary.onchange = () => {
              const checked = primary.checked;
              for (const it of rows) it.primary = false;
              r.primary = checked;
              onChange();
              rerender();
            };
            rowEl.createDiv({ cls: "col-primary-label", text: "primary" });

            const rm = rowEl.createEl("button", { cls: "rslatte-icon-btn", text: "✖" });
            rm.title = "删除";
            rm.onclick = () => {
              rows.splice(i, 1);
              onChange();
              rerender();
            };
          }
        };

        const addRow = block.createEl("button", { cls: "rslatte-icon-btn", text: "➕ 添加" });
        addRow.onclick = () => {
          rows.push({ platform: "", handle: "", primary: rows.length === 0 });
          onChange();
          rerender();
        };
        rerender();
      };

      renderKvBlock("电话（可多项）", phones, () => {
        enforceSinglePrimary(phones);
      });
      renderKvBlock("邮箱（可多项）", emails, () => {
        enforceSinglePrimary(emails);
      });
      renderImBlock(im, () => {
        enforceSinglePrimary(im);
      });

      // Birthday (optional)
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
      noteIn.value = bNote;
      noteIn.oninput = () => (bNote = noteIn.value);

      // ✅ 是否添加生日备忘开关
      const addMemoWrap = b.createDiv({ cls: "rslatte-contact-modal-inline" });
      addMemoWrap.createSpan({ text: "添加生日备忘" });
      const addMemoToggle = new ToggleComponent(addMemoWrap);
      addMemoToggle.setValue(bAddMemo);
      addMemoToggle.onChange((v) => (bAddMemo = v));

      // Footer buttons
      const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });
      let saveBtn!: ButtonComponent;
      
      const refreshSaveDisabled = () => {
        const v = validate();
        saveBtn?.setDisabled(!v.ok);
      };

      saveBtn = new ButtonComponent(btnRow)
        .setButtonText("保存")
        .setCta();
      new ButtonComponent(btnRow).setButtonText("关闭").onClick(() => this.close());

      refreshSaveDisabled();

      // Hook to update disabled state on input changes
      const mutation = new MutationObserver(() => refreshSaveDisabled());
      mutation.observe(contentEl, { subtree: true, childList: true, attributes: true });

      saveBtn.onClick(async () => {
        const v = validate();
        if (!v.ok) {
          setErr("请填写必填项：姓名 / 别名（至少一个） / 分组 / 职位");
          return;
        }

        const newGroup = sanitizeFolderName(groupName);
        if (!newGroup) {
          setErr("分组（group_name）不合法");
          return;
        }

        // Normalize arrays
        phones = normalizeRows(phones);
        emails = normalizeRows(emails);
        im = normalizeImRows(im);
        enforceSinglePrimary(phones);
        enforceSinglePrimary(emails);
        enforceSinglePrimary(im);

        const tags = uniq(splitList(tagsRaw));

        // Read raw file (preserve body)
        const rawBefore = await this.app.vault.read(this.file);
        const { yaml: oldYaml, body } = extractFrontmatterBlock(rawBefore);
        let baseObj: Record<string, any> = {};
        try {
          baseObj = oldYaml.trim() ? ((parseYaml(oldYaml) as any) ?? {}) : {};
        } catch {
          baseObj = {};
        }
        if (!baseObj || typeof baseObj !== "object") baseObj = {};

        const oldStatus = String(baseObj.status ?? fm0.status ?? "active").trim() || "active";

        const nowIso = this.getNowIso();
        const createdAt = String(baseObj.created_at ?? fm0.created_at ?? nowIso);
        const lastInteractionAt = baseObj.last_interaction_at ?? fm0.last_interaction_at ?? null;

        // cancelled_at consistency
        let cancelled_at: any = baseObj.cancelled_at ?? fm0.cancelled_at ?? null;
        if (status === "active") cancelled_at = null;
        if (status === "cancelled") {
          // keep existing cancelled_at, otherwise set now
          if (!cancelled_at) cancelled_at = nowIso;
        }

        // Resolve move
        const contactsDir = normalizePath((this.getContactsDir() ?? "").trim() || "90-Contacts");
        const oldGroup = String(baseObj.group_name ?? fm0.group_name ?? "").trim();
        const oldFolder = normalizePath(`${contactsDir}/${sanitizeFolderName(oldGroup || newGroup)}`);
        const newFolder = normalizePath(`${contactsDir}/${newGroup}`);
        const uidForPath = contactUid || fileNameUidFallback(this.file) || "";
        const newFilePath = normalizePath(`${newFolder}/C_${uidForPath}.md`);

        // avatar path / move
        let newAvatarPath = String(avatarPath ?? "").trim();

        try {
          await ensureFolder(this.app, newFolder);
          await ensureFolder(this.app, normalizePath(`${newFolder}/.attachments`));

          // If avatar replaced, write new binary into new folder
          if (avatarFile) {
            const ext = (avatarFile.name.split(".").pop() || "png").toLowerCase();
            const rel = `.attachments/${uidForPath}.${ext}`;
            const abs = normalizePath(`${newFolder}/${rel}`);
            const data = await avatarFile.arrayBuffer();
            await writeBinary(this.app, abs, data);
            newAvatarPath = rel;
          } else {
            // If group changed and old avatar exists in old folder, move it (best-effort)
            const rel = String(baseObj.avatar_path ?? fm0.avatar_path ?? "").trim();
            if (rel && oldFolder !== newFolder) {
              const oldAbs = normalizePath(`${oldFolder}/${rel}`);
              const af = this.app.vault.getAbstractFileByPath(oldAbs);
              if (af && af instanceof TFile) {
                const destAbs = normalizePath(`${newFolder}/${rel}`);
                // ensure attachments exists
                await ensureFolder(this.app, normalizePath(`${newFolder}/.attachments`));
                await this.app.fileManager.renameFile(af, destAbs);
                newAvatarPath = rel;
              }
            }
          }
        } catch (e: any) {
          // Avatar / folder ops failed should not block contact save
          console.warn("[Contacts][Edit] avatar/folder ops failed", e);
        }

        // Merge updates (preserve unknown keys)
        const merged: Record<string, any> = {
          ...baseObj,
          type: "contact",
          contact_uid: uidForPath,
          display_name: displayName.trim(),
          sortname: computeSortname(displayName.trim()),
          aliases: v.aliases,
          group_name: newGroup,
          title: title.trim(),
          status,
          cancelled_at,
          tags,
          summary: summary || "",
          company: company || "",
          department: department || "",
          avatar_path: newAvatarPath || "",
          phones,
          emails,
          im,
          birthday: {
            type: bType,
            month: Number(bMonth) || 0,
            day: Number(bDay) || 0,
            leap_month: !!bLeap,
            note: bNote || "",
          },
          last_interaction_at: lastInteractionAt ?? null,
          created_at: createdAt,
          updated_at: nowIso,
          extra: {
            ...(baseObj.extra && typeof baseObj.extra === "object" ? baseObj.extra : {}),
            birthday_memo: bAddMemo,
          },
        };

        // Write: keep body, but refresh the generated snapshot section so正文不会与属性（frontmatter）脱节
        const fmYaml = yamlOfObject(merged, 0);
        const nextBody = upsertGeneratedContactSection(body, merged);
        const nextText = buildFileTextWithFrontmatter(nextBody, fmYaml);

        // Apply file move if needed
        try {
          if (normalizePath(this.file.path) !== newFilePath) {
            await this.app.fileManager.renameFile(this.file, newFilePath);
            // refresh file reference
            const af2 = this.app.vault.getAbstractFileByPath(newFilePath);
            if (af2 && af2 instanceof TFile) this.file = af2;
          }
        } catch (e: any) {
          console.warn("[Contacts][Edit] move file failed", e);
          // If move fails, still update at old path
        }

        try {
          await this.app.vault.modify(this.file, nextText);

        // Step C8: DB sync (best-effort)
        try {
          await this.plugin.tryContactsDbSyncByPath(this.file.path, "update");
        } catch {
          // ignore
        }

        // Work events (best-effort)
        try {
          const action = oldStatus !== status ? "status" : "update";
          const momentFn = moment as any;
          await (this.plugin as any).workEventSvc?.append({
            ts: new Date().toISOString(),
            kind: "contact",
            action,
            source: "ui",
            ref: {
              contact_uid: uidForPath,
              display_name: displayName.trim(),
              group_name: newGroup,
              old_group_name: oldGroup || undefined,
              file_path: this.file.path,
              status,
            },
            summary: action === "status"
              ? `${status === "cancelled" ? "⛔" : "✅"} 联系人状态：${displayName.trim()} → ${status}`
              : `✏️ 更新联系人：${displayName.trim()}`,
          });
        } catch {
          // ignore
        }
        } catch (e: any) {
          new Notice(`保存失败：${String(e?.message ?? e)}`);
          return;
        }

        new Notice("联系人已更新");

        // ✅ 如果启用了生日备忘，创建或更新对应的备忘记录
        if (bAddMemo && merged.birthday && merged.birthday.month && merged.birthday.day) {
          try {
            const bMonthNum = Number(merged.birthday.month);
            const bDayNum = Number(merged.birthday.day);
            if (bMonthNum && bDayNum) {
              await this.plugin.taskRSLatte.createOrUpdateContactBirthdayMemo({
                contactUid: uidForPath,
                contactName: displayName.trim(),
                contactFile: this.file.path,
                birthdayType: bType,
                month: bMonthNum,
                day: bDayNum,
                leapMonth: bLeap,
              });
              
              // ✅ 刷新索引以便立即在侧边栏显示
              await this.plugin.taskRSLatte.refreshIndexAndSync({ sync: false, noticeOnError: false });
            }
          } catch (e: any) {
            console.warn("[Contacts][Edit] Failed to create/update birthday memo", e);
            // 不阻止联系人更新，仅记录警告
          }
        } else if (!bAddMemo) {
          // ✅ 如果关闭了生日备忘开关，删除已存在的生日备忘
          try {
            const existingMemo = await this.plugin.taskRSLatte.findContactBirthdayMemo(uidForPath);
            if (existingMemo) {
              // 标记为取消状态（而不是删除，保留历史记录）
              await this.plugin.taskRSLatte.applyMemoStatusAction(existingMemo as any, "CANCELLED");
              await this.plugin.taskRSLatte.refreshIndexAndSync({ sync: false, noticeOnError: false });
            }
          } catch (e: any) {
            console.warn("[Contacts][Edit] Failed to cancel birthday memo", e);
          }
        }

        this.close();
        try {
          await this.opts.onUpdated?.();
        } catch {
          // ignore
        }
      });
    })();
  }
}
