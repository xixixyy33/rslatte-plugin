import { App, ButtonComponent, Modal, Notice } from "obsidian";
import type RSLattePlugin from "../../main";
import type { CaptureTypeRecommendation } from "../../services/capture/captureTypeRecommendation";
import { getTaskTodayKey } from "../../taskRSLatte/task/taskTags";
import { AddMemoModal } from "./AddMemoModal";
import { AddScheduleModal } from "./AddScheduleModal";
import { AddTaskModal } from "./AddTaskModal";

type CaptureQuickAddModalOpts = {
  getDraftText?: () => string;
  recommendation?: CaptureTypeRecommendation | null;
  /** 从待整理某行打开「整理」时传入：任务/提醒/日程保存成功后将该行标为 `- [x]` */
  sourceInboxRef?: { filePath: string; lineNo: number };
};

type CaptureOption = {
  key: "memo" | "task" | "schedule";
  title: string;
  suit: string;
  example: string;
  buttonText: string;
};

const OPTIONS: CaptureOption[] = [
  {
    key: "memo",
    title: "提醒",
    suit: "适合：怕忘记的事",
    example: "例：下周提醒我复查、晚上提醒我取快递",
    buttonText: "选择提醒",
  },
  {
    key: "task",
    title: "任务",
    suit: "适合：需要推进完成的事",
    example: "例：整理周报、跟进合同、提交报销",
    buttonText: "选择任务",
  },
  {
    key: "schedule",
    title: "日程",
    suit: "适合：有明确时间段安排的事",
    example: "例：明天下午 3 点开会、周五 10:00 复盘",
    buttonText: "选择日程",
  },
];

export class CaptureQuickAddModal extends Modal {
  constructor(
    app: App,
    private plugin: RSLattePlugin,
    private opts?: CaptureQuickAddModalOpts
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("rslatte-capture-quickadd-modal");
    this.titleEl.setText("➕ 三合一新增");

    const intro = contentEl.createDiv({ cls: "rslatte-capture-quickadd-intro" });
    intro.setText("先选择条目类型，再进入对应表单填写字段。");
    const draftText = String(this.opts?.getDraftText?.() ?? "").trim();
    if (draftText) {
      const draftRow = contentEl.createDiv({ cls: "rslatte-capture-quickadd-draft" });
      draftRow.createSpan({ cls: "rslatte-capture-quickadd-draft-label", text: "待整理描述：" });
      draftRow.createSpan({ cls: "rslatte-capture-quickadd-draft-text", text: draftText });
      draftRow.setAttribute("title", draftText);
    }
    const recommendation = this.opts?.recommendation ?? null;
    if (recommendation) {
      const rec = contentEl.createDiv({ cls: "rslatte-capture-quickadd-rec" });
      const label = recommendation.type === "memo" ? "提醒" : recommendation.type === "task" ? "任务" : "日程";
      const reason = recommendation.reasons?.[0] ?? "根据条目描述推荐";
      const conf = Math.round((recommendation.confidence ?? 0) * 100);
      rec.setText(`推荐类型：${label}（置信度 ${conf}% · ${reason.replace(/^\[[^\]]+\]\s*/, "")}）`);
    }

    const list = contentEl.createDiv({ cls: "rslatte-capture-quickadd-list" });
    for (const opt of OPTIONS) {
      const card = list.createDiv({ cls: "rslatte-capture-quickadd-card" });
      const isRecommended = recommendation?.type === opt.key;
      if (isRecommended) card.addClass("is-recommended");
      const action = card.createDiv({ cls: "rslatte-capture-quickadd-action" });
      if (isRecommended) {
        action.createSpan({ cls: "rslatte-capture-quickadd-badge", text: "推荐" });
      }
      new ButtonComponent(action)
        .setButtonText(opt.buttonText)
        .setCta()
        .onClick(() => this.openTypedModal(opt.key));
      const text = card.createDiv({ cls: "rslatte-capture-quickadd-text" });
      text.createEl("p", { text: opt.suit });
      text.createEl("p", { text: opt.example });
    }
  }

  onClose(): void {
    this.modalEl.removeClass("rslatte-capture-quickadd-modal");
  }

  /** 整理成功：将来源待整理行标为已完成，并刷新侧栏（含 Capture） */
  private async markSourceInboxDoneIfAny(): Promise<void> {
    const ref = this.opts?.sourceInboxRef;
    if (!ref) return;
    try {
      await (this.plugin as any).updateCaptureInboxLine?.(ref.filePath, ref.lineNo, "x");
      this.plugin.refreshSidePanel?.();
    } catch (e) {
      console.warn("[RSLatte] markSourceInboxDone failed", e);
      new Notice(`待整理条目未能标为已完成：${(e as any)?.message ?? String(e)}`);
    }
  }

  private openTypedModal(kind: CaptureOption["key"]): void {
    const draft = String(this.opts?.getDraftText?.() ?? "").trim();
    const today = getTaskTodayKey((this.plugin.settings as any)?.taskPanel ?? undefined);
    const reopenPicker = () => {
      new CaptureQuickAddModal(this.app, this.plugin, this.opts).open();
    };
    const inboxRef = this.opts?.sourceInboxRef;
    this.close();
    if (kind === "memo") {
      new AddMemoModal(this.app, this.plugin, {
        initialText: draft,
        initialDateYmd: /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : undefined,
        onBackToTypeSelect: reopenPicker,
        ...(inboxRef
          ? {
              onCreated: async () => {
                await this.markSourceInboxDoneIfAny();
                new Notice("已写入今日日记：提醒");
              },
            }
          : {}),
      }).open();
      return;
    }
    if (kind === "task") {
      new AddTaskModal(this.app, this.plugin, {
        initialText: draft,
        initialDue: /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : undefined,
        onBackToTypeSelect: reopenPicker,
        ...(inboxRef
          ? {
              onCreated: async () => {
                await this.markSourceInboxDoneIfAny();
                new Notice("已写入今日日记：任务");
              },
            }
          : {}),
      }).open();
      return;
    }
    new AddScheduleModal(this.app, this.plugin, {
      initialDesc: draft,
      initialDateYmd: /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : undefined,
      onBackToTypeSelect: reopenPicker,
      ...(inboxRef
        ? {
            onCreated: async () => {
              await this.markSourceInboxDoneIfAny();
              new Notice("日程已创建");
            },
          }
        : {}),
    }).open();
  }
}
