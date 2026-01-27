import { App, ButtonComponent, Modal, Notice, Setting, TextAreaComponent, TextComponent, ToggleComponent } from "obsidian";

import type RSLattePlugin from "../../main";
import { nextSolarDateForLunarBirthday } from "../../utils/lunar";

type MemoCategory = "lunarBirthday" | "solarBirthday" | "anniversary" | "important";

export class AddMemoModal extends Modal {
  constructor(app: App, private plugin: RSLattePlugin) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("新增备忘");

    let category: MemoCategory = "important";
    let text = "";
    let dateYmd = "";       // YYYY-MM-DD (solar picker)
    let lunarMmdd = "";     // MM-DD
    let lunarLeap = false;
    // 默认：不重复。重要事项允许选择；生日/纪念日强制 yearly。
    let repeatRule = "none";

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
    let lunarHintEl!: HTMLElement;

    const applyCategory = () => {
      const cat = category;
      const lockYearly = (cat === "lunarBirthday" || cat === "solarBirthday" || cat === "anniversary");

      // toggle date inputs
      if (cat === "lunarBirthday") {
        dateSettingEl.style.display = "none";
        lunarSettingEl.style.display = "";
      } else {
        dateSettingEl.style.display = "";
        lunarSettingEl.style.display = "none";
      }

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
      const tOk = (text ?? "").trim().length > 0;
      const dOk = category === "lunarBirthday" ? isValidMmdd(lunarMmdd) : isValidYmd(dateYmd);

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

      saveBtn?.setDisabled(!(tOk && dOk));
      textInput?.inputEl?.classList.toggle("is-invalid", !tOk);
      if (category === "lunarBirthday") {
        lunarInput?.inputEl?.classList.toggle("is-invalid", !dOk);
      } else {
        dateInput?.inputEl?.classList.toggle("is-invalid", !dOk);
      }
      return tOk && dOk;
    };

    new Setting(contentEl)
      .setName("备忘内容*")
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

    new Setting(contentEl)
      .setName("备忘分类*")
      .setDesc("")
      .addDropdown((d) => {
        d.addOption("lunarBirthday", "农历生日");
        d.addOption("solarBirthday", "阳历生日");
        d.addOption("anniversary", "纪念日");
        d.addOption("important", "重要事项");
        d.setValue(category);
        d.onChange((v) => {
          category = (v as MemoCategory) || "important";
          applyCategory();
        });
      });

    // solar date picker
    {
      const s = new Setting(contentEl)
        .setName("日期*")
        .setDesc("")
        .addText((t) => {
          dateInput = t;
          t.inputEl.type = "date";
          t.setValue("");
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
          leapToggle = tg;
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
        d.addOption("seasonly", "每季度");
        d.addOption("yearly", "每年");
        d.setValue(repeatRule);
        d.onChange((v) => {
          repeatRule = v;
          refresh();
        });
        repeatDropdown = d;
      });

    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });
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

        await this.plugin.taskRSLatte.createTodayMemo(text, memoDate, rr, metaExtra);
        new Notice("已写入今日日记：备忘");
        await this.plugin.taskRSLatte.refreshIndexAndSync({
          // ✅ D3: DB sync 开关完全接管；URL 不可用时强制视为 OFF
          sync: (this.plugin.isMemoDbSyncEnabledV2?.() ?? (this.plugin.settings.taskPanel.enableDbSync !== false)),
          // 手动新增后立刻刷新：允许修复 uid/meta（避免新条目因缺 uid 而无法进入缓存/队列）
          noticeOnError: true,
        });
        this.plugin.refreshSidePanel();
        this.close();
      } catch (e: any) {
        new Notice(`写入失败：${e?.message ?? String(e)}`);
      }
    };

    // apply initial category
    applyCategory();

    window.setTimeout(() => {
      textInput?.inputEl?.focus();
      refresh();
    }, 0);
  }
}
