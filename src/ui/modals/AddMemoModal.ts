import { App, ButtonComponent, Modal, Notice, Setting, TextAreaComponent, TextComponent, normalizePath } from "obsidian";

import type RSLattePlugin from "../../main";
import { buildCaptureWorkEventUi, buildWorkEventMemoCreateUi } from "../../services/execution/buildExecutionWorkEvents";
import { EXECUTION_RECIPE } from "../../services/execution/executionOrchestrator";
import { writeMemoTodayCreate } from "../../services/execution/memoWriteFacade";
import { runExecutionFlowUi } from "../helpers/runExecutionFlowUi";
import { computeSortname } from "../../contactsRSLatte/sortname";
import { nextSolarDateForLunarBirthday } from "../../utils/lunar";

type MemoCategory = "lunarBirthday" | "solarBirthday" | "anniversary" | "dueReminder" | "generalReminder";

function genContactUid(): string {
  const ts = Date.now().toString(36).toUpperCase().padStart(8, "0").slice(-8);
  const rnd = Math.random().toString(36).slice(2, 10).toUpperCase().padEnd(8, "X").slice(0, 8);
  return `${ts}${rnd}`;
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
  if (typeof v === "object") return `\n${yamlOfObject(v, indent)}`;
  return quoteYamlString(String(v));
}

function yamlOfObject(obj: Record<string, any>, indent: number = 0): string {
  const pad = " ".repeat(indent);
  const lines: string[] = [];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
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

export type AddMemoModalFlowOpts = {
  initialText?: string;
  initialDateYmd?: string;
  modalTitle?: string;
  onBackToTypeSelect?: () => void;
  onCreated?: (uid: string) => void | Promise<void>;
  skipDefaultNotice?: boolean;
  /** 来自 Capture 三合一：WorkEvent 记为 kind capture */
  captureQuickRecordWorkEvent?: boolean;
};

export class AddMemoModal extends Modal {
  constructor(app: App, private plugin: RSLattePlugin, private memoFlow?: AddMemoModalFlowOpts) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(this.memoFlow?.modalTitle ?? "新增提醒");

    let category: MemoCategory = "generalReminder";
    let text = String(this.memoFlow?.initialText ?? "");
    const flowDate = String(this.memoFlow?.initialDateYmd ?? "").trim();
    let dateYmd = /^\d{4}-\d{2}-\d{2}$/.test(flowDate) ? flowDate : ""; // YYYY-MM-DD (solar picker)
    let lunarMmdd = "";     // MM-DD
    let lunarLeap = false;
    // 默认：不重复。重要事项允许选择；生日/纪念日强制 yearly。
    let repeatRule = "none";

    let textInput!: TextAreaComponent;
    let dateInput!: TextComponent;
    let lunarInput!: TextComponent;
    let repeatDropdown: any;
    let saveBtn!: ButtonComponent;

    const isValidYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test((s ?? "").trim());
    const isValidMmdd = (s: string) => /^\d{2}-\d{2}$/.test((s ?? "").trim());

    let dateSettingEl!: HTMLElement;
    let lunarSettingEl!: HTMLElement;
    let lunarHintEl!: HTMLElement;
    let textSettingEl!: HTMLElement;
    let contactInfoSettingEl!: HTMLElement;
    let contactInfoInput!: TextComponent;
    let contactInfoRaw = "";
    const extractContactsFromText = (raw: string): Array<{ uid: string; displayName: string }> => {
      const out: Array<{ uid: string; displayName: string }> = [];
      const seen = new Set<string>();
      const re = /\[\[C_([^\]|]+)\|([^\]]+)\]\]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(String(raw ?? ""))) !== null) {
        const uid = String(m[1] ?? "").trim();
        const displayName = String(m[2] ?? "").trim();
        if (!uid || !displayName || seen.has(uid)) continue;
        seen.add(uid);
        out.push({ uid, displayName });
      }
      return out;
    };

    const applyCategory = () => {
      const cat = category;
      const isBirthday = cat === "lunarBirthday" || cat === "solarBirthday";
      const lockYearly = isBirthday || cat === "anniversary";

      // toggle date inputs
      if (cat === "lunarBirthday") {
        dateSettingEl.style.display = "none";
        lunarSettingEl.style.display = "";
      } else {
        dateSettingEl.style.display = "";
        lunarSettingEl.style.display = "none";
      }
      textSettingEl.style.display = isBirthday ? "none" : "";
      contactInfoSettingEl.style.display = isBirthday ? "" : "none";
      // repeat rule
      if (lockYearly) {
        repeatRule = "yearly";
        repeatDropdown?.setValue?.("yearly");
        repeatDropdown?.setDisabled?.(true);
      } else {
        repeatDropdown?.setDisabled?.(false);
        // keep current repeatRule
        if (!repeatRule) repeatRule = "none";
        repeatDropdown?.setValue?.(repeatRule);
      }

      refresh();
    };

    const refresh = () => {
      const isBirthday = category === "lunarBirthday" || category === "solarBirthday";
      const tOk = isBirthday ? true : (text ?? "").trim().length > 0;
      const dOk = category === "lunarBirthday" ? isValidMmdd(lunarMmdd) : isValidYmd(dateYmd);
      const cOk = !isBirthday || !!String(contactInfoRaw ?? "").trim();

      // hint for lunar
      if (category === "lunarBirthday") {
        let hint = "";
        if (isValidMmdd(lunarMmdd)) {
          try {
            const next = nextSolarDateForLunarBirthday(lunarMmdd, lunarLeap);
            hint = `将提醒日期换算为阳历：${next}`;
          } catch {
            hint = "农历日期不合法";
          }
        } else {
          hint = "请输入农历 MM-DD，例如 08-15";
        }
        if (lunarHintEl) lunarHintEl.setText(hint);
      }
      saveBtn?.setDisabled(!(tOk && dOk && cOk));
      textInput?.inputEl?.classList.toggle("is-invalid", !tOk && !isBirthday);
      if (category === "lunarBirthday") {
        lunarInput?.inputEl?.classList.toggle("is-invalid", !dOk);
      } else {
        dateInput?.inputEl?.classList.toggle("is-invalid", !dOk);
      }
      return tOk && dOk && cOk;
    };

    new Setting(contentEl)
      .setName("提醒内容")
      .setDesc("")
      .addTextArea((t) => {
        textInput = t;
        t.setPlaceholder("例如：元旦提醒");
        t.inputEl.rows = 3;
        t.inputEl.style.whiteSpace = "pre-wrap"; // auto wrap for long text
        t.onChange((v) => {
          const raw = v ?? "";
          const cleaned = raw.replace(/\r?\n+/g, " ");
          if (cleaned !== raw) {
            // prevent multi-line input
            t.setValue(cleaned);
            return;
          }
          text = cleaned;
          refresh();
        });
        t.inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            void doSave();
          }
        });
      });
    textSettingEl = contentEl.lastElementChild as HTMLElement;
    const contentSetting = textSettingEl;
    const contentControl = contentSetting?.querySelector(".setting-item-control") as HTMLElement | null;
    if (contentControl) {
      const insertRow = contentControl.createDiv({ cls: "rslatte-inline-insert-row" });
      insertRow.style.display = "flex";
      insertRow.style.justifyContent = "flex-end";
      insertRow.style.marginTop = "6px";
      new ButtonComponent(insertRow)
        .setButtonText("🪪 插入联系人")
        .onClick(() => {
          void this.plugin.openContactReferencePicker((ref) => {
            try {
              const cur = textInput?.getValue?.() ?? "";
              const sep = cur && !/\s$/.test(cur) ? " " : "";
              const next = `${cur}${sep}${ref} `;
              if (category === "lunarBirthday" || category === "solarBirthday") {
                contactInfoRaw = ref;
                contactInfoInput?.setValue?.(ref);
              } else {
                textInput?.setValue?.(next);
                text = next;
              }
              refresh();
              const ta = textInput?.inputEl;
              if (ta && !(category === "lunarBirthday" || category === "solarBirthday")) {
                ta.focus();
                try { ta.setSelectionRange(next.length, next.length); } catch {}
              }
            } catch (e) {
              console.warn("[RSLatte][memo][insertContact] failed", e);
              new Notice("插入联系人失败");
            }
          });
        });
    }

    new Setting(contentEl)
      .setName("提醒分类*")
      .setDesc("")
      .addDropdown((d) => {
        d.addOption("lunarBirthday", "农历生日");
        d.addOption("solarBirthday", "阳历生日");
        d.addOption("anniversary", "纪念日");
        d.addOption("dueReminder", "到期提醒");
        d.addOption("generalReminder", "一般提醒");
        d.setValue(category);
        d.onChange((v) => {
          category = (v as MemoCategory) || "generalReminder";
          applyCategory();
        });
      });

    const contactInfoSetting = new Setting(contentEl)
      .setName("联系人信息")
      .setDesc("")
      .addText((t) => {
        contactInfoInput = t;
        t.setPlaceholder("输入联系人姓名或 [[C_uid|姓名]]");
        t.onChange((v) => {
          contactInfoRaw = String(v ?? "").trim();
          refresh();
        });
      })
      .addButton((b) => {
        b.setButtonText("从通讯录选择");
        b.onClick(() => {
          void this.plugin.openContactReferencePicker((ref) => {
            contactInfoRaw = String(ref ?? "").trim();
            contactInfoInput?.setValue?.(contactInfoRaw);
            refresh();
          });
        });
      });
    contactInfoSettingEl = contactInfoSetting.settingEl;

    // solar date picker
    {
      const s = new Setting(contentEl)
        .setName("日期*")
        .setDesc("")
        .addText((t) => {
          dateInput = t;
          t.inputEl.type = "date";
          t.setValue(dateYmd);
          t.onChange((v) => {
            dateYmd = (v ?? "").trim();
            refresh();
          });
          t.inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
            if (ev.key === "Enter") {
              ev.preventDefault();
              void doSave();
            }
          });
        });
      dateSettingEl = s.settingEl;
    }

    // lunar date input
    {
      const s = new Setting(contentEl)
        .setName("农历日期*")
        .setDesc("")
        .addText((t) => {
          lunarInput = t;
          t.setPlaceholder("例如：08-15");
          t.onChange((v) => {
            lunarMmdd = (v ?? "").trim();
            refresh();
          });
          t.inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
            if (ev.key === "Enter") {
              ev.preventDefault();
              void doSave();
            }
          });
        })
        .addToggle((tg) => {
          tg.setValue(false);
          tg.onChange((v) => {
            lunarLeap = !!v;
            refresh();
          });
        });

      // "闰月" 标记与说明（tooltip）
      // 仅在农历日期场景展示（该 Setting 会随分类显示/隐藏）
      const leapLabel = s.controlEl.createSpan({
        text: "闰月",
        cls: "rslatte-inline-label",
      });
      leapLabel.setAttr(
        "title",
        "仅当日期属于闰月（如“闰四月”）时开启；一般按农历过生日/纪念日不需要开启。",
      );

      // add a hint below
      lunarHintEl = s.descEl.createDiv({ cls: "rslatte-muted" });
      lunarSettingEl = s.settingEl;
    }

    new Setting(contentEl)
      .setName("重复规则")
      .setDesc("")
      .addDropdown((d) => {
        d.addOption("none", "不重复");
        d.addOption("weekly", "每周");
        d.addOption("monthly", "每月");
        d.addOption("quarterly", "每季度");
        d.addOption("yearly", "每年");
        d.setValue(repeatRule);
        d.onChange((v) => {
          repeatRule = v;
          refresh();
        });
        repeatDropdown = d;
      });

    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });
    if (this.memoFlow?.onBackToTypeSelect) {
      new ButtonComponent(btnRow)
        .setButtonText("← 返回类型选择")
        .onClick(() => {
          this.close();
          try {
            this.memoFlow?.onBackToTypeSelect?.();
          } catch {
            // ignore
          }
        });
    }
    saveBtn = new ButtonComponent(btnRow).setButtonText("保存").setCta().onClick(() => void doSave());
    new ButtonComponent(btnRow).setButtonText("关闭").onClick(() => this.close());

    const doSave = async () => {
      if (!refresh()) return;
      try {
        // Category rules
        const cat = category;
        const lockYearly = (cat === "lunarBirthday" || cat === "solarBirthday" || cat === "anniversary");
        const rr = lockYearly ? "yearly" : (repeatRule || "none");

        // Build meta extra (stored in v2 meta line)
        const metaExtra: Record<string, string> = {
          cat,
        };
        let birthdayContact: { uid: string; displayName: string; filePath?: string } | null = null;
        let extraContacts: Array<{ uid: string; displayName: string }> = [];
        if (cat === "lunarBirthday" || cat === "solarBirthday") {
          birthdayContact = await this.resolveContactFromInfoInput(contactInfoRaw, {
            category: cat,
            dateYmd,
            lunarMmdd,
            lunarLeap,
          });
          extraContacts = [{ uid: birthdayContact.uid, displayName: birthdayContact.displayName }];
        } else {
          extraContacts = extractContactsFromText(text);
        }

        let memoDate = "";
        if (cat === "lunarBirthday") {
          const nextYmd = nextSolarDateForLunarBirthday(lunarMmdd, lunarLeap);
          memoDate = nextYmd;
          metaExtra["date_type"] = "lunar";
          metaExtra["lunar"] = lunarMmdd;
          metaExtra["leap"] = lunarLeap ? "1" : "0";
          metaExtra["next"] = nextYmd;
        } else {
          memoDate = dateYmd;
          metaExtra["date_type"] = "solar";
          // ✅ Non-lunar categories also keep an explicit "next" reminder date.
          // It will be advanced automatically when overdue.
          metaExtra["next"] = memoDate;
        }

        if (birthdayContact) {
          metaExtra["contact_uid"] = birthdayContact.uid;
          metaExtra["contact_name"] = birthdayContact.displayName;
          if (birthdayContact.filePath) metaExtra["contact_file"] = birthdayContact.filePath;
        }
        if (extraContacts.length > 0) {
          metaExtra["follow_contact_uids"] = extraContacts.map((x) => x.uid).join("|");
          metaExtra["follow_contact_name"] = extraContacts.map((x) => x.displayName).join("|");
        }

        const finalText = (cat === "lunarBirthday" || cat === "solarBirthday")
          ? `[[C_${birthdayContact?.uid}|${birthdayContact?.displayName}]] 的${cat === "solarBirthday" ? "阳历" : "农历"}生日`
          : text;
        const createdUid = await writeMemoTodayCreate(this.plugin.taskRSLatte, finalText, memoDate, rr, metaExtra);
        if (!createdUid) {
          new Notice("写入失败：未能生成提醒");
          return;
        }
        if (birthdayContact) {
          await this.plugin.taskRSLatte.appendBirthMemoUidToContact(
            birthdayContact.uid,
            createdUid,
            birthdayContact.filePath
          );
        }
        const recordDate = this.plugin.getTodayKey().slice(0, 10);
        const finalShort = finalText.length > 50 ? finalText.slice(0, 50) + "…" : finalText;
        await runExecutionFlowUi(this.plugin, EXECUTION_RECIPE.tripleSaveMemo, {
          facadeResult: { kind: "memo", uid: createdUid },
          workEvent: this.memoFlow?.captureQuickRecordWorkEvent
            ? buildCaptureWorkEventUi({
                action: "create",
                summary: `🗃️ 快速记录→提醒 ${finalShort}`,
                ref: {
                  capture_op: "quickadd_memo",
                  memo_uid: createdUid,
                  memo_date: memoDate,
                  repeat_rule: rr,
                  record_date: recordDate,
                },
              })
            : buildWorkEventMemoCreateUi({
                uid: createdUid,
                text: finalText,
                memoDate,
                repeatRule: rr,
                recordDate,
                metaExtra,
              }),
          sync: (this.plugin.isMemoDbSyncEnabledV2?.() ?? (this.plugin.settings.taskPanel.enableDbSync !== false)),
          noticeOnError: true,
        }, { actionLabel: "创建提醒" });
        if (this.memoFlow?.onCreated) {
          await this.memoFlow.onCreated(createdUid);
          this.close();
          return;
        }
        if (!this.memoFlow?.skipDefaultNotice) new Notice("已写入今日日记：提醒");
        this.close();
      } catch (e: any) {
        new Notice(`写入失败：${e?.message ?? String(e)}`);
      }
    };

    // apply initial category
    applyCategory();

    window.setTimeout(() => {
      if ((text ?? "").trim() && textInput) {
        textInput.setValue(text);
        text = textInput.getValue() ?? "";
      }
      textInput?.inputEl?.focus();
      refresh();
    }, 0);
  }

  private async resolveContactFromInfoInput(
    raw: string,
    birthday?: { category: MemoCategory; dateYmd: string; lunarMmdd: string; lunarLeap: boolean }
  ): Promise<{ uid: string; displayName: string; filePath?: string }> {
    const t = String(raw ?? "").trim();
    if (!t) throw new Error("生日提醒必须填写联系人信息");
    const m = t.match(/^\[\[C_([^\]|]+)\|([^\]]+)\]\]$/);
    if (m) {
      return { uid: String(m[1] ?? "").trim(), displayName: String(m[2] ?? "").trim() };
    }

    const rawName = t;
    const idx = await this.plugin.contactsIndex.getIndexStore().readIndex();
    const usedNames = new Set(
      (idx.items ?? [])
        .map((it: any) => String(it?.display_name ?? "").trim())
        .filter(Boolean)
    );
    let name = rawName;
    if (usedNames.has(name)) {
      let i = 1;
      while (usedNames.has(`${rawName}_${i}`)) i += 1;
      name = `${rawName}_${i}`;
    }

    const contactsDir = normalizePath(String((this.plugin.settings as any)?.contactsModule?.contactsDir ?? "90-Contacts").trim() || "90-Contacts");
    const group = "default";
    await ensureFolder(this.app, normalizePath(`${contactsDir}/${group}`));
    let uid = genContactUid();
    let filePath = normalizePath(`${contactsDir}/${group}/C_${uid}.md`);
    while (await this.app.vault.adapter.exists(filePath)) {
      uid = genContactUid();
      filePath = normalizePath(`${contactsDir}/${group}/C_${uid}.md`);
    }

    const now = new Date().toISOString();
    const fmObj: Record<string, any> = {
      type: "contact",
      contact_uid: uid,
      display_name: name,
      sortname: computeSortname(name),
      aliases: [],
      group_name: group,
      title: "",
      status: "active",
      cancelled_at: null,
      created_at: now,
      updated_at: now,
    };
    if (birthday) {
      if (birthday.category === "lunarBirthday") {
        const [mm, dd] = String(birthday.lunarMmdd ?? "").split("-").map((x) => Number(x));
        if (mm && dd) fmObj.birthday = { type: "lunar", month: mm, day: dd, leap_month: !!birthday.lunarLeap, note: "" };
      } else {
        const mm = String(birthday.dateYmd ?? "").match(/^\d{4}-(\d{2})-(\d{2})$/);
        if (mm) fmObj.birthday = { type: "solar", month: Number(mm[1]), day: Number(mm[2]), leap_month: false, note: "" };
      }
    }
    const body = [
      `# ${name}`,
      "",
      "<!-- rslatte:contact:generated:start -->",
      "## 基本信息",
      `- 姓名：${name}`,
      `- 分组：${group}`,
      "- 职位/头衔：-",
      "- 状态：active",
      "",
      "## 工作信息",
      "",
      "## 联系方式",
      "<!-- rslatte:contact:generated:end -->",
      "",
    ].join("\n");
    await this.app.vault.create(filePath, `---\n${yamlOfObject(fmObj, 0)}\n---\n\n${body}`);
    try { await this.plugin.tryContactsDbSyncByPath(filePath, "create", { quiet: true }); } catch {}
    try { await this.plugin.rebuildContactsIndex(); } catch {}
    return { uid, displayName: name, filePath };
  }
}
