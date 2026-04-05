import { App, ButtonComponent, Modal, Notice, Setting, TextAreaComponent, TextComponent, ToggleComponent } from "obsidian";

import type RSLattePlugin from "../../main";
import type { RSLatteIndexItem } from "../../taskRSLatte/types";
import { nextSolarDateForLunarBirthday } from "../../utils/lunar";
import { writeMemoUpdateBasicInfo } from "../../services/execution/memoWriteFacade";
import { EXECUTION_RECIPE } from "../../services/execution/executionOrchestrator";
import { buildWorkEventUiAction } from "../../services/execution/buildExecutionWorkEvents";
import { runExecutionFlowUi } from "../helpers/runExecutionFlowUi";
import { normalizeRepeatRuleToken } from "../../taskRSLatte/utils";

type MemoCategory = "lunarBirthday" | "solarBirthday" | "anniversary" | "dueReminder" | "generalReminder";

function normalizeCat(v: string): MemoCategory {
  const s = String(v ?? "").trim();
  if (s === "lunarBirthday" || s === "solarBirthday" || s === "anniversary" || s === "dueReminder" || s === "generalReminder") return s;
  // backward compatibility: old "important" maps to "generalReminder"
  if (s === "important") return "generalReminder";
  return "generalReminder";
}

export class EditMemoModal extends Modal {
  constructor(app: App, private plugin: RSLattePlugin, private item: RSLatteIndexItem) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("修改提醒");

    const extra = (this.item.extra ?? {}) as Record<string, any>;

    let text = String(this.item.text || this.item.raw || "").trim();

    // category
    let cat: MemoCategory = normalizeCat(String(extra["cat"] ?? "generalReminder"));

    // date fields
    let dateYmd = String((this.item as any).memoDate ?? "").trim();
    let lunarMmdd = String(extra["lunar"] ?? (this.item as any).memoMmdd ?? "").trim();
    let lunarLeap = String(extra["leap"] ?? "").trim() === "1";
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

    // repeat（历史 seasonly → quarterly）
    let repeatRule = normalizeRepeatRuleToken(String((this.item as any).repeatRule ?? "").trim().toLowerCase()) || "none";

    let textInput!: TextAreaComponent;
    let dateInput!: TextComponent;
    let lunarInput!: TextComponent;
    let leapToggle!: ToggleComponent;
    let repeatDropdown: any;
    let saveBtn!: ButtonComponent;

    const isValidYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test((s ?? "").trim());
    const isValidMmdd = (s: string) => /^\d{2}-\d{2}$/.test((s ?? "").trim());

    let dateSettingEl!: HTMLElement;
    let lunarSettingEl!: HTMLElement;
    let leapSettingEl!: HTMLElement;
    const lockYearly = () => cat === "lunarBirthday" || cat === "solarBirthday" || cat === "anniversary";

    const refresh = () => {
      const t = (text ?? "").trim();
      const okText = !!t;

      const okSolar = !lockYearly() && isValidYmd(dateYmd);
      const okSolarLocked = lockYearly() && isValidYmd(dateYmd); // for solarBirthday/anniversary we still store next ymd
      const okLunar = cat === "lunarBirthday" && isValidMmdd(lunarMmdd);

      const okDate = cat === "lunarBirthday" ? okLunar : (okSolarLocked || okSolar);

      const needContact = cat === "lunarBirthday" || cat === "solarBirthday";
      const okContact = !needContact || extractContactsFromText(text).length > 0;
      saveBtn.setDisabled(!(okText && okDate && okContact));

      // toggle invalid styles
      if (dateInput?.inputEl) dateInput.inputEl.classList.toggle("is-invalid", !!dateYmd && !isValidYmd(dateYmd));
      if (lunarInput?.inputEl) lunarInput.inputEl.classList.toggle("is-invalid", !!lunarMmdd && !isValidMmdd(lunarMmdd));

      // yearly lock
      if (repeatDropdown) {
        const v = lockYearly() ? "yearly" : repeatRule;
        repeatDropdown.setValue(v);
        repeatDropdown.selectEl.disabled = lockYearly();
      }
    };

    const applyCategory = () => {
      // show/hide inputs
      const isLunar = cat === "lunarBirthday";

      dateSettingEl.style.display = isLunar ? "none" : "";
      lunarSettingEl.style.display = isLunar ? "" : "none";
      leapSettingEl.style.display = isLunar ? "" : "none";
      if (lockYearly()) repeatRule = "yearly";
      refresh();
    };

    // ===== fields =====

    const textSetting = new Setting(contentEl)
      .setName("提醒内容")
      .setDesc("建议简短：用于侧边栏提醒与跳转")
      .addTextArea((t) => {
        textInput = t;
        t.setValue(text || "");
        t.inputEl.rows = 3;
        t.onChange((v) => {
          text = (v ?? "").trim();
          refresh();
        });
      });
    const insertRow = textSetting.controlEl.createDiv({ cls: "rslatte-inline-insert-row" });
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
            textInput?.setValue?.(next);
            text = next;
            refresh();
            const ta = textInput?.inputEl;
            if (ta) {
              ta.focus();
              try { ta.setSelectionRange(next.length, next.length); } catch {}
            }
          } catch (e) {
            console.warn("[RSLatte][memo][insertContact] failed", e);
            new Notice("插入联系人失败");
          }
        });
      });

    new Setting(contentEl)
      .setName("分类")
      .addDropdown((d) => {
        d.addOption("solarBirthday", "阳历生日");
        d.addOption("lunarBirthday", "农历生日");
        d.addOption("anniversary", "纪念日");
        d.addOption("dueReminder", "到期提醒");
        d.addOption("generalReminder", "一般提醒");
        d.setValue(cat);
        d.onChange((v) => {
          cat = normalizeCat(v);
          applyCategory();
        });
      });

    // solar date input
    dateSettingEl = new Setting(contentEl)
      .setName("日期（阳历）")
      .setDesc("YYYY-MM-DD")
      .addText((t) => {
        dateInput = t;
        t.inputEl.type = "date";
        // If current memo only has lunar mmdd, try extra.next
        if (!isValidYmd(dateYmd)) {
          const nx = String(extra["next"] ?? "").trim();
          if (isValidYmd(nx)) dateYmd = nx;
        }
        t.setValue(dateYmd || "");
        t.onChange((v) => {
          dateYmd = (v ?? "").trim();
          refresh();
        });
      }).settingEl;

    // lunar mmdd input
    lunarSettingEl = new Setting(contentEl)
      .setName("农历日期（MM-DD）")
      .setDesc("例如：02-02")
      .addText((t) => {
        lunarInput = t;
        t.setPlaceholder("02-02");
        t.setValue(lunarMmdd || "");
        t.onChange((v) => {
          lunarMmdd = (v ?? "").trim();
          refresh();
        });
      }).settingEl;

    leapSettingEl = new Setting(contentEl)
      .setName("闰月")
      .setDesc("仅农历生日需要：是否为闰月")
      .addToggle((tg) => {
        leapToggle = tg;
        tg.setValue(!!lunarLeap);
        tg.onChange((v) => {
          lunarLeap = !!v;
          refresh();
        });
      }).settingEl;

    // repeat dropdown
    new Setting(contentEl)
      .setName("重复")
      .setDesc("重要事项可选；生日/纪念日强制每年")
      .addDropdown((d) => {
        d.addOption("none", "不重复");
        d.addOption("weekly", "每周");
        d.addOption("monthly", "每月");
        d.addOption("quarterly", "每季度");
        d.addOption("yearly", "每年");
        d.setValue(lockYearly() ? "yearly" : repeatRule);
        d.onChange((v) => {
          repeatRule = (v ?? "").trim().toLowerCase();
          refresh();
        });
        repeatDropdown = d;
      });

    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });
    saveBtn = new ButtonComponent(btnRow).setButtonText("保存").setCta().onClick(() => void doSave());
    new ButtonComponent(btnRow).setButtonText("关闭").onClick(() => this.close());

    const doSave = async () => {
      try {
        const t = (text ?? "").trim();
        if (!t) throw new Error("提醒内容不能为空");

        const allowed = new Set(["none", "weekly", "monthly", "quarterly", "yearly"]);
        const rrNorm = normalizeRepeatRuleToken(repeatRule);
        const rr = lockYearly() ? "yearly" : (allowed.has(rrNorm) ? rrNorm : "none");

        const metaExtra: Record<string, string> = { cat };
        const contacts = extractContactsFromText(t);
        const needContact = cat === "lunarBirthday" || cat === "solarBirthday";
        if (needContact && contacts.length === 0) throw new Error("生日提醒内容中必须包含联系人引用（[[C_uid|姓名]]）");

        let memoDate = "";
        if (cat === "lunarBirthday") {
          if (!isValidMmdd(lunarMmdd)) throw new Error("农历日期必须为 MM-DD");
          const nextYmd = nextSolarDateForLunarBirthday(lunarMmdd, lunarLeap);
          memoDate = nextYmd;
          metaExtra["date_type"] = "lunar";
          metaExtra["lunar"] = lunarMmdd;
          metaExtra["leap"] = lunarLeap ? "1" : "0";
          metaExtra["next"] = nextYmd;
        } else {
          // for solar birthday / anniversary / important we store the next solar ymd
          if (!isValidYmd(dateYmd)) throw new Error("日期必须为 YYYY-MM-DD");
          memoDate = dateYmd;
          metaExtra["date_type"] = "solar";
          metaExtra["next"] = memoDate;
        }
        if (contacts.length > 0) {
          metaExtra["follow_contact_uids"] = contacts.map((x) => x.uid).join("|");
          metaExtra["follow_contact_name"] = contacts.map((x) => x.displayName).join("|");
          if (needContact) {
            metaExtra["contact_uid"] = contacts[0].uid;
            metaExtra["contact_name"] = contacts[0].displayName;
          }
        }

        await writeMemoUpdateBasicInfo(this.plugin.taskRSLatte, this.item as any, {
          text: t,
          memoDate,
          repeatRule: rr,
          metaExtra,
        }, { skipWorkEvent: true });
        await runExecutionFlowUi(this.plugin, EXECUTION_RECIPE.updateMemoAndRefresh, {
          sync: (this.plugin.isMemoDbSyncEnabledV2?.() ?? (this.plugin.settings.taskPanel?.enableDbSync !== false)),
          noticeOnError: true,
          workEvent: buildWorkEventUiAction({
            kind: "memo",
            action: "update",
            summary: `✏️ 修改提醒 ${t || "未命名提醒"}`,
            ref: { uid: (this.item as any).uid, file_path: this.item.filePath, line_no: this.item.lineNo },
            metrics: { memo_date: memoDate, repeat_rule: rr },
          }),
        }, { actionLabel: "更新提醒" });

        new Notice("已更新：提醒");
        this.close();
      } catch (e: any) {
        new Notice(`更新失败：${e?.message ?? String(e)}`);
      }
    };

    // initial apply
    applyCategory();

    window.setTimeout(() => {
      textInput?.inputEl?.focus();
      refresh();
    }, 0);
  }

}
