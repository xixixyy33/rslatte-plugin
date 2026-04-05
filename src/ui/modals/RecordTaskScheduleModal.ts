import {
  ButtonComponent,
  Modal,
  Notice,
  Setting,
  TextAreaComponent,
  TextComponent,
  TFile,
  moment,
  normalizePath,
} from "obsidian";
import type RSLattePlugin from "../../main";
import type { RSLatteIndexItem } from "../../taskRSLatte/types";
import { buildWorkEventScheduleCreateUi } from "../../services/execution/buildExecutionWorkEvents";
import { EXECUTION_RECIPE } from "../../services/execution/executionOrchestrator";
import { linkOutputFileToSchedule } from "../../services/execution/outputScheduleLinkFacade";
import { writeScheduleCreate } from "../../services/execution/scheduleWriteFacade";
import { runExecutionFlowUi } from "../helpers/runExecutionFlowUi";
import { getDefaultScheduleCategoryId, mountScheduleCategoryDropdown } from "../../taskRSLatte/schedule/scheduleCategory";
import type { ScheduleCategory, ScheduleRepeatRule } from "../../types/scheduleTypes";
import { todayYmd } from "../../taskRSLatte/utils";

const momentFn = moment as any;

/** 任务卡片「录日程」或输出卡片「录日程」共用同一表单与门面链路 */
export type RecordScheduleModalTarget =
  | { kind: "task"; taskItem: RSLatteIndexItem }
  | { kind: "output"; filePath: string };

/**
 * 录日程并关联当前任务或输出：经日程门面创建；任务侧追加 `linked_schedule_uids`；输出侧写 `linked_schedule_uid` 并维护双向关联。
 */
export class RecordTaskScheduleModal extends Modal {
  constructor(
    app: any,
    private plugin: RSLattePlugin,
    private target: RecordScheduleModalTarget,
    private onDone?: () => void | Promise<void>,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(
      this.target.kind === "task" ? "录日程（关联当前任务）" : "录日程（关联当前输出）",
    );

    let desc = "";
    let dateYmd = todayYmd();
    let startTime = "";
    let durationMin = 60;
    let repeatRule: ScheduleRepeatRule = "none";
    const scheduleMod = (this.plugin.settings as any)?.scheduleModule;
    let category: ScheduleCategory = getDefaultScheduleCategoryId(scheduleMod);

    let descInput!: TextAreaComponent;
    let dateInput!: TextComponent;
    let startInput!: TextComponent;
    let durationInput!: TextComponent;
    let saveBtn!: ButtonComponent;

    const isYmd = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "").trim());
    const parseHm = (v: string): string | null => {
      const s = String(v ?? "").trim();
      const m = s.match(/^(\d{1,2}):(\d{1,2})$/);
      if (!m) return null;
      const hh = Number(m[1]);
      const mm = Number(m[2]);
      if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
      if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
      return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    };

    const refresh = () => {
      const okDesc = !!String(desc ?? "").trim();
      const okDate = isYmd(dateYmd);
      const okStart = parseHm(startTime) != null;
      const n = Number(durationMin);
      const okDur = Number.isFinite(n) && n >= 5 && n <= 24 * 60;
      saveBtn?.setDisabled(!(okDesc && okDate && okStart && okDur));
      descInput?.inputEl?.classList.toggle("is-invalid", !okDesc);
      dateInput?.inputEl?.classList.toggle("is-invalid", !okDate);
      startInput?.inputEl?.classList.toggle("is-invalid", !okStart);
      durationInput?.inputEl?.classList.toggle("is-invalid", !okDur);
      return okDesc && okDate && okStart && okDur;
    };

    new Setting(contentEl)
      .setName("日程描述*")
      .addTextArea((t) => {
        descInput = t;
        t.setPlaceholder("例如：和[[C_xxx|张三]]确认需求细节");
        t.inputEl.rows = 3;
        t.onChange((v) => {
          desc = String(v ?? "").replace(/\r?\n+/g, " ");
          if (desc !== (v ?? "")) t.setValue(desc);
          refresh();
        });
      });

    const descControl = (contentEl.lastElementChild as HTMLElement | null)?.querySelector(
      ".setting-item-control",
    ) as HTMLElement | null;
    if (descControl) {
      const row = descControl.createDiv({ cls: "rslatte-inline-insert-row" });
      row.style.display = "flex";
      row.style.justifyContent = "flex-end";
      row.style.marginTop = "6px";
      new ButtonComponent(row)
        .setButtonText("🪪 插入联系人")
        .onClick(() => {
          void this.plugin.openContactReferencePicker((ref) => {
            const cur = descInput?.getValue?.() ?? "";
            const sep = cur && !/\s$/.test(cur) ? " " : "";
            const next = `${cur}${sep}${ref} `;
            descInput?.setValue?.(next);
            desc = next;
            refresh();
            try {
              const el = descInput?.inputEl;
              if (el) el.setSelectionRange(next.length, next.length);
            } catch {
              // ignore
            }
          });
        });
    }

    new Setting(contentEl)
      .setName("日程分类*")
      .addDropdown((d) => {
        category = mountScheduleCategoryDropdown(d, scheduleMod, category, (id) => {
          category = id as ScheduleCategory;
        });
      });

    new Setting(contentEl)
      .setName("日期*")
      .addText((t) => {
        dateInput = t;
        t.inputEl.type = "date";
        t.setValue(dateYmd);
        t.onChange((v) => {
          dateYmd = String(v ?? "").trim();
          refresh();
        });
      });

    new Setting(contentEl)
      .setName("开始时间*")
      .addText((t) => {
        startInput = t;
        t.setPlaceholder("11:30");
        t.onChange((v) => {
          startTime = String(v ?? "").trim();
          refresh();
        });
      });

    new Setting(contentEl)
      .setName("预约时长（分钟）*")
      .addText((t) => {
        durationInput = t;
        t.setPlaceholder("60");
        t.setValue(String(durationMin));
        t.onChange((v) => {
          const n = Math.floor(Number(v));
          durationMin = Number.isFinite(n) ? n : 60;
          refresh();
        });
      });

    new Setting(contentEl)
      .setName("重复规则")
      .addDropdown((d) => {
        d.addOption("none", "不重复");
        d.addOption("weekly", "每周");
        d.addOption("monthly", "每月");
        d.addOption("quarterly", "每季");
        d.addOption("yearly", "每年");
        d.setValue(repeatRule);
        d.onChange((v) => {
          const vv = String(v ?? "none").trim().toLowerCase();
          repeatRule = vv === "weekly" || vv === "monthly" || vv === "quarterly" || vv === "yearly" ? vv : "none";
        });
      });

    new Setting(contentEl).addButton((b) => {
      saveBtn = b;
      b.setButtonText("创建并关联");
      b.setCta();
      b.onClick(() => void doSave());
    });

    const doSave = async () => {
      if (!refresh()) return;
      try {
        const normStart = parseHm(startTime);
        if (!normStart) return;

        if (this.target.kind === "output") {
          const fp = normalizePath(String(this.target.filePath ?? "").trim());
          const outputFile = this.app.vault.getAbstractFileByPath(fp);
          if (!(outputFile instanceof TFile)) {
            new Notice("输出文件不存在");
            return;
          }
          const cache = this.app.metadataCache.getFileCache(outputFile);
          const fm0 = (cache?.frontmatter ?? {}) as Record<string, unknown>;
          const outputId = String(fm0.output_id ?? fm0.outputId ?? "").trim();
          if (!outputId) {
            new Notice("输出文档缺少 output_id");
            return;
          }
          const uid = await writeScheduleCreate(this.plugin.taskRSLatte, {
            text: desc,
            scheduleDate: dateYmd,
            startTime: normStart,
            durationMin,
            category,
            repeatRule,
            linkedOutputId: outputId,
          });
          if (!uid) {
            new Notice("创建日程失败：参数不完整");
            return;
          }
          const endM = momentFn(`${dateYmd} ${normStart}`, "YYYY-MM-DD HH:mm").add(durationMin, "minutes");
          const endTimeStr = endM.format("HH:mm");
          const lineText = `${normStart}-${endTimeStr} ${desc}`.trim();
          await runExecutionFlowUi(
            this.plugin,
            EXECUTION_RECIPE.tripleSaveSchedule,
            {
              facadeResult: { kind: "schedule", uid },
              sourceRef: {
                itemType: "output",
                uid: outputId,
                filePath: fp,
                lineNo: -1,
              },
              clientOpId: `record-output-schedule:${outputId}:${String(uid ?? "")}`,
              workEvent: buildWorkEventScheduleCreateUi({
                uid,
                lineText,
                scheduleDate: dateYmd,
                repeatRule,
                scheduleCategory: category,
                startTime: normStart,
                endTime: endTimeStr,
                durationMin,
                linkedOutputId: outputId,
              }),
              sync: false,
            },
            { actionLabel: "创建输出日程" },
          );
          const sch = await this.plugin.taskRSLatte.findScheduleByUid(uid);
          if (sch) {
            const lr = await linkOutputFileToSchedule(this.plugin, outputFile, sch);
            if (!lr.ok) {
              new Notice(lr.message ?? "日程已创建，但写回输出关联失败");
            } else {
              new Notice("日程已创建并已关联到当前输出");
            }
          } else {
            await this.app.fileManager.processFrontMatter(outputFile, (fm: Record<string, unknown>) => {
              (fm as any).linked_schedule_uid = uid;
            });
            await this.plugin.outputRSLatte?.upsertFile?.(outputFile);
            const ro = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "output" as any, "manual_refresh");
            if (!ro.ok) console.warn("[RSLatte][RecordTaskScheduleModal] output manual_refresh failed", ro.error);
            new Notice("日程已创建；若侧栏未更新请手动刷新输出索引");
          }
          this.plugin.refreshSidePanel?.();
          this.close();
          await this.onDone?.();
          return;
        }

        const taskItem = this.target.taskItem;
        const taskUid = String((taskItem as any)?.uid ?? "").trim();
        const uid = await writeScheduleCreate(this.plugin.taskRSLatte, {
          text: desc,
          scheduleDate: dateYmd,
          startTime: normStart,
          durationMin,
          category,
          repeatRule,
          ...(taskUid ? { linkedTaskUid: taskUid } : {}),
        });
        if (!uid) {
          new Notice("创建日程失败：参数不完整");
          return;
        }
        const endM = momentFn(`${dateYmd} ${normStart}`, "YYYY-MM-DD HH:mm").add(durationMin, "minutes");
        const endTimeStr = endM.format("HH:mm");
        const lineText = `${normStart}-${endTimeStr} ${desc}`.trim();
        await runExecutionFlowUi(this.plugin, EXECUTION_RECIPE.tripleSaveSchedule, {
          facadeResult: { kind: "schedule", uid },
          sourceRef: {
            itemType: "task",
            uid: String((taskItem as any)?.uid ?? ""),
            filePath: String(taskItem.filePath ?? ""),
            lineNo: Number(taskItem.lineNo ?? -1),
          },
          clientOpId: `record-task-schedule:${String((taskItem as any)?.uid ?? "")}:${String(uid ?? "")}`,
          workEvent: buildWorkEventScheduleCreateUi({
            uid,
            lineText,
            scheduleDate: dateYmd,
            repeatRule,
            scheduleCategory: category,
            startTime: normStart,
            endTime: endTimeStr,
            durationMin,
            ...(taskUid ? { linkedTaskUid: taskUid } : {}),
          }),
          sync: false,
        }, { actionLabel: "创建任务日程" });
        const linkR = await this.plugin.taskRSLatte.appendLinkedScheduleUidToTask(taskItem, uid);
        if (!linkR.ok) {
          new Notice(`日程已创建，但关联任务失败：${linkR.reason ?? "未知"}`);
        } else if (!linkR.changed) {
          new Notice("日程已创建（关联列表未变化，可能已存在同一 uid）");
        } else {
          new Notice("日程已创建并已关联到当前任务");
        }
        const r = await this.plugin.pipelineEngine.runE2(this.plugin.getSpaceCtx(), "task", "manual_refresh");
        if (!r.ok) console.warn("[RSLatte][RecordTaskScheduleModal] task manual_refresh failed", r.error);
        this.plugin.refreshSidePanel?.();
        this.close();
        await this.onDone?.();
      } catch (e: any) {
        new Notice(`操作失败：${e?.message ?? String(e)}`);
      }
    };

    refresh();
  }
}
