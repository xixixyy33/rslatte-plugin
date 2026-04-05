import { normalizePath, TFile } from "obsidian";
import type RSLattePlugin from "../../main";
import { writeBackMetaIdByUidRemoveKeys } from "../../taskRSLatte/shared/metaWriter";
import type { RSLatteIndexItem } from "../../taskRSLatte/types";

/** 按 output_id 查 vault 内文件（依赖输出索引） */
export async function findOutputFileByOutputId(plugin: RSLattePlugin, outputId: string): Promise<TFile | null> {
  const id = String(outputId ?? "").trim();
  if (!id) return null;
  try {
    const snap = await plugin.outputRSLatte?.getSnapshot?.();
    const it = (snap?.items ?? []).find((x) => String(x.outputId ?? "").trim() === id);
    if (!it?.filePath) return null;
    const af = plugin.app.vault.getAbstractFileByPath(normalizePath(it.filePath));
    return af instanceof TFile ? af : null;
  } catch {
    return null;
  }
}

export async function clearLinkedOutputFromScheduleMeta(plugin: RSLattePlugin, sch: RSLatteIndexItem): Promise<void> {
  const uid = String((sch as any).uid ?? "").trim();
  const fp = normalizePath(String(sch.filePath ?? ""));
  const ln = Number((sch as any).lineNo ?? 0);
  if (!uid || !fp) return;
  await writeBackMetaIdByUidRemoveKeys(plugin.app, fp, uid, ["linked_output_id"], Number.isFinite(ln) && ln >= 0 ? ln : undefined);
}

export async function clearLinkedScheduleFromOutputFile(plugin: RSLattePlugin, file: TFile): Promise<void> {
  await plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    delete fm.linked_schedule_uid;
    delete fm.linkedScheduleUid;
  });
  await plugin.outputRSLatte?.upsertFile?.(file);
}

/**
 * 输出文档 ⟷ 日程 双向写入：日程 meta `linked_output_id`、输出 YAML `linked_schedule_uid`。
 * 会尽力解除旧关联（同输出原日程、同日程原输出）。
 */
export async function linkOutputFileToSchedule(
  plugin: RSLattePlugin,
  outputFile: TFile,
  schedule: RSLatteIndexItem,
): Promise<{ ok: boolean; message?: string }> {
  const schUid = String((schedule as any).uid ?? "").trim();
  if (!schUid) return { ok: false, message: "日程缺少 uid" };

  const cache = plugin.app.metadataCache.getFileCache(outputFile);
  const fm0 = (cache?.frontmatter ?? {}) as Record<string, unknown>;
  const outputId = String(fm0.output_id ?? fm0.outputId ?? "").trim();
  if (!outputId) return { ok: false, message: "输出文档缺少 output_id" };

  const prevSchUid = String(fm0.linked_schedule_uid ?? fm0.linkedScheduleUid ?? "").trim();
  if (prevSchUid && prevSchUid !== schUid) {
    const prev = await plugin.taskRSLatte.findScheduleByUid(prevSchUid);
    if (prev) {
      const ex = String((prev as any).extra?.linked_output_id ?? "").trim();
      if (ex === outputId) await clearLinkedOutputFromScheduleMeta(plugin, prev);
    }
  }

  const prevOutId = String((schedule as any).extra?.linked_output_id ?? "").trim();
  if (prevOutId && prevOutId !== outputId) {
    const prevFile = await findOutputFileByOutputId(plugin, prevOutId);
    if (prevFile) {
      const pfm = plugin.app.metadataCache.getFileCache(prevFile)?.frontmatter as Record<string, unknown> | undefined;
      if (String(pfm?.linked_schedule_uid ?? pfm?.linkedScheduleUid ?? "").trim() === schUid) {
        await clearLinkedScheduleFromOutputFile(plugin, prevFile);
      }
    }
  }

  await plugin.taskRSLatte.patchMemoRslatteMetaByUid(
    { filePath: schedule.filePath, lineNo: schedule.lineNo, uid: schUid } as RSLatteIndexItem,
    { linked_output_id: outputId },
  );

  await plugin.app.fileManager.processFrontMatter(outputFile, (fm: Record<string, unknown>) => {
    fm.linked_schedule_uid = schUid;
  });
  await plugin.outputRSLatte?.upsertFile?.(outputFile);

  const rs = await plugin.pipelineEngine.runE2(plugin.getSpaceCtx(), "schedule" as any, "manual_refresh");
  if (!rs.ok) console.warn("[outputScheduleLink] schedule refresh failed", rs.error);
  const ro = await plugin.pipelineEngine.runE2(plugin.getSpaceCtx(), "output" as any, "manual_refresh");
  if (!ro.ok) console.warn("[outputScheduleLink] output refresh failed", ro.error);

  return { ok: true };
}
