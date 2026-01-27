import { App, ButtonComponent, Modal, Notice, Setting, TextComponent } from "obsidian";
import moment from "moment";
import type RSLattePlugin from "../../main";

const momentFn = moment as any;

/**
 * 新增打卡记录弹窗（支持选择日期）
 * - 可以选择任意日期（支持历史补录）
 * - 提供打卡项、备注字段
 * - 确认后插入到指定日期的日记中
 */
export class AddCheckinRecordModal extends Modal {
  private onSuccess?: (dateKey?: string) => void;

  constructor(app: App, private plugin: RSLattePlugin, onSuccess?: (dateKey?: string) => void) {
    super(app);
    this.onSuccess = onSuccess;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    this.titleEl.setText("新增打卡");

    // 获取所有活跃的打卡项
    let checkinItems: any[] = [];
    try {
      if (this.plugin.recordRSLatte) {
        const lists = await this.plugin.recordRSLatte.getListsSnapshot(false);
        checkinItems = (lists.checkinItems || []).filter((item: any) => item.active && !item.deletedAt);
      }
    } catch (e) {
      console.error("[AddCheckinRecord] Failed to get checkin items:", e);
    }

    if (checkinItems.length === 0) {
      contentEl.createDiv({ cls: "rslatte-muted", text: "请先在设置页添加打卡项" });
      new ButtonComponent(contentEl).setButtonText("关闭").onClick(() => this.close());
      return;
    }

    let selectedDate = momentFn().format("YYYY-MM-DD");
    let selectedCheckinId = "";
    let note = "";

    let dateInput!: TextComponent;
    let checkinSelect!: any;
    let noteText!: TextComponent;
    let saveBtn!: ButtonComponent;
    let inFlight = false;

    const validate = () => {
      // 验证日期格式
      if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) return false;
      // 验证打卡项
      if (!selectedCheckinId) return false;
      return true;
    };

    const setInFlight = (v: boolean) => {
      inFlight = v;
      try {
        saveBtn?.setDisabled(v || !validate());
      } catch { }
      try {
        (dateInput as any)?.setDisabled?.(v);
        (checkinSelect as any)?.setDisabled?.(v);
        (noteText as any)?.setDisabled?.(v);
      } catch { }
    };

    const refreshValidation = () => {
      const ok = validate();
      if (saveBtn) saveBtn.setDisabled(inFlight || !ok);
      return ok;
    };

    // ===== 日期选择 =====
    new Setting(contentEl)
      .setName("日期")
      .setDesc("选择记录日期（支持历史补录）")
      .addText((t) => {
        dateInput = t;
        t.inputEl.type = "date";
        t.setValue(selectedDate);
        t.onChange((v) => {
          selectedDate = (v || "").trim();
          refreshValidation();
        });
      });

    // ===== 打卡项选择 =====
    new Setting(contentEl)
      .setName("打卡项")
      .setDesc("选择打卡项（必填）")
      .addDropdown((dd) => {
        checkinSelect = dd;
        dd.addOption("", "请选择");
        for (const item of checkinItems) {
          dd.addOption(item.id, item.name);
        }
        dd.onChange((v: string) => {
          selectedCheckinId = v;
          refreshValidation();
        });
      });

    // ===== 备注 =====
    new Setting(contentEl)
      .setName("备注")
      .setDesc("可选")
      .addText((t) => {
        noteText = t;
        t.setPlaceholder("可选");
        t.setValue(note);
        t.onChange((v) => (note = (v || "").trim()));
        t.inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            void doSave();
          }
        });
      });

    // ===== 初始化选择第一个打卡项 =====
    if (checkinItems.length > 0 && !selectedCheckinId) {
      selectedCheckinId = checkinItems[0].id;
      checkinSelect.setValue(selectedCheckinId);
    }

    // ===== 操作按钮 =====
    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });
    saveBtn = new ButtonComponent(btnRow)
      .setButtonText("保存")
      .setCta()
      .onClick(() => void doSave());
    new ButtonComponent(btnRow).setButtonText("关闭").onClick(() => this.close());

    const doSave = async () => {
      if (inFlight) return;
      if (!refreshValidation()) return;

      setInFlight(true);

      try {
        const dateKey = selectedDate;
        const checkinItem = checkinItems.find((item: any) => item.id === selectedCheckinId);
        if (!checkinItem) {
          new Notice("请选择打卡项");
          setInFlight(false);
          return;
        }

        // ✅ 检查该日期该打卡项是否已有记录（且未删除）
        let existingRecord: any = null;
        try {
          if (this.plugin.recordRSLatte) {
            // 优先使用统计缓存（包含全量数据，不受归档影响）
            let allRecords: any[] = [];
            try {
              const currentSpaceId = this.plugin.getCurrentSpaceId();
              const statsCache = await this.plugin.recordRSLatte.getCheckinStatsCache(currentSpaceId);
              if (statsCache?.items && statsCache.items.length > 0) {
                allRecords = statsCache.items as any[];
              } else {
                // 回退到主索引（活跃 + 归档）
                const cSnapActive = await this.plugin.recordRSLatte.getCheckinSnapshot(false);
                const cSnapArch = await this.plugin.recordRSLatte.getCheckinSnapshot(true);
                allRecords = [
                  ...(cSnapActive?.items ?? []),
                  ...(cSnapArch?.items ?? [])
                ];
              }
            } catch {
              // 如果获取缓存失败，回退到主索引
              const cSnapActive = await this.plugin.recordRSLatte.getCheckinSnapshot(false);
              const cSnapArch = await this.plugin.recordRSLatte.getCheckinSnapshot(true);
              allRecords = [
                ...(cSnapActive?.items ?? []),
                ...(cSnapArch?.items ?? [])
              ];
            }
            
            // 查找匹配的记录
            existingRecord = allRecords.find(
              (item: any) => {
                // 严格检查：日期和打卡项ID必须匹配，且记录未删除
                // 支持两种字段名格式：record_date/recordDate, checkin_id/checkinId
                const itemDate = String(item.record_date || item.recordDate || "").trim();
                const itemCheckinId = String(item.checkin_id || item.checkinId || "").trim();
                const dateMatch = itemDate === String(dateKey || "").trim();
                const checkinMatch = itemCheckinId === String(checkinItem.id || "").trim();
                
                // 检查 is_delete：可能是布尔值、字符串 "true"/"false"、或 undefined/null
                // 支持两种字段名格式：is_delete/isDelete
                const isDeleted = item.is_delete === true || item.isDelete === true || String(item.is_delete || item.isDelete || "").toLowerCase() === "true";
                
                const matches = dateMatch && checkinMatch && !isDeleted;
                
                if (this.plugin.isDebugLogEnabled() && dateMatch && checkinMatch) {
                  console.log(`[RSLatte][AddCheckinRecord] 找到日期和打卡项匹配的记录:`, {
                    itemDate,
                    itemCheckinId,
                    dateKey,
                    checkinId: checkinItem.id,
                    isDeleted,
                    matches
                  });
                }
                
                return matches;
              }
            );
            
            if (this.plugin.isDebugLogEnabled()) {
              console.log(`[RSLatte][AddCheckinRecord] 检查重复记录: dateKey=${dateKey}, checkinId=${checkinItem.id}, 扫描了 ${allRecords.length} 条记录, 找到匹配记录=${!!existingRecord}`);
              if (existingRecord) {
                console.log(`[RSLatte][AddCheckinRecord] 找到已有记录:`, existingRecord);
              }
            }
          }
        } catch (e) {
          console.warn("[RSLatte][AddCheckinRecord] 检查已有记录失败", e);
        }

        // ✅ 如果已有未删除的记录，不允许插入
        if (existingRecord) {
          new Notice(`该日期（${dateKey}）和打卡项（${checkinItem.name}）已有记录，请先取消已有记录后再插入`);
          setInFlight(false);
          return;
        }

        const payload = {
          record_date: dateKey,
          checkin_id: checkinItem.id,
          note,
          is_delete: false,
        } as const;

        // 应用记录（新建记录，id 为 0）
        const appliedRecord: any = {
          id: 0,
          record_date: dateKey,
          checkin_id: checkinItem.id,
          note,
          is_delete: false,
          created_at: new Date().toISOString(),
        };

        // 如果是今天，使用 applyTodayCheckinRecord
        const todayKey = this.plugin.getTodayKey();
        if (dateKey === todayKey) {
          this.plugin.applyTodayCheckinRecord(appliedRecord);
        }

        // ✅ 同步写入中央索引
        try {
          await this.plugin.recordRSLatte?.upsertCheckinRecord({
            recordDate: dateKey,
            checkinId: checkinItem.id,
            checkinName: checkinItem.name,
            note,
            isDelete: false,
            tsMs: Date.now(),
          });
        } catch (e) {
          console.warn("recordRSLatte upsertCheckinRecord failed", e);
        }

        // ✅ 写入日记
        try {
          const timeStr = momentFn().format("HH:mm");
          const mark = "✅";
          const line = `- ${dateKey} ${timeStr} ${checkinItem.id} ${checkinItem.name} ${mark}${note ? " " + note : ""}`;

          await ((this.plugin as any).appendJournalByModule?.("checkin", dateKey, [line]) ?? Promise.resolve());
        } catch (e: any) {
          new Notice("打卡记录已保存，但写入日记失败");
          await this.plugin.appendAuditLog({
            action: "CHECKIN_JOURNAL_APPEND_FAILED",
            payload,
            error: {
              message: e?.message ?? String(e),
              stack: e?.stack ?? null,
            },
          });
        }

        await this.plugin.saveSettings();
        this.plugin.refreshSidePanel();
        
        // ✅ 刷新打卡侧边栏（如果已打开）
        try {
          const checkinLeaves = this.app.workspace.getLeavesOfType("rslatte-checkinpanel");
          for (const leaf of checkinLeaves) {
            const view = leaf.view as any;
            if (view && typeof view.render === "function") {
              void view.render();
            }
          }
        } catch {
          // ignore
        }

        // ✅ Work Event（新建记录，action 为 create）
        try {
          void this.plugin.workEventSvc?.append({
            ts: new Date().toISOString(),
            kind: "checkin",
            action: "create",
            source: "ui",
            ref: {
              record_date: dateKey,
              checkin_id: checkinItem.id,
              checkin_name: checkinItem.name,
              is_delete: false,
              note: note || undefined,
            },
            summary: `✅ 打卡 ${checkinItem.name}${note ? " - " + note : ""}`.trim(),
            metrics: { is_delete: false },
          });
        } catch {
          // ignore
        }

        new Notice(`已保存 ${dateKey} 的打卡记录`);
        this.close();
        if (this.onSuccess) {
          this.onSuccess(dateKey);
        }
      } catch (e: any) {
        new Notice(`保存失败：${e?.message ?? String(e)}`);
        await this.plugin.appendAuditLog({
          action: "CHECKIN_ADD_FAILED",
          error: {
            message: e?.message ?? String(e),
            stack: e?.stack ?? null,
          },
        });
      } finally {
        setInFlight(false);
      }
    };

    window.setTimeout(() => {
      dateInput?.inputEl?.focus();
      refreshValidation();
    }, 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}
