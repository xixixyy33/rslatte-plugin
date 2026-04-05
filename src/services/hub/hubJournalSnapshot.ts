import { TFile } from "obsidian";
import type RSLattePlugin from "../../main";
import { countJournalMeaningfulChars } from "../../ui/helpers/todayRecordsModel";

/** 与 Review / 今日记录一致：有效字数阈值（> 视为「有实质内容」） */
export const HUB_JOURNAL_MEANINGFUL_OK_THRESHOLD = 10;

export type HubJournalSnapshot = {
  fileExists: boolean;
  meaningfulChars: number;
};

/**
 * 按空间日记路径解析今日日记文件并统计有效字数（与 `todayRecordsModel.countJournalMeaningfulChars` 同源）。
 */
export async function computeHubJournalSnapshot(
  plugin: RSLattePlugin,
  space: { settingsSnapshot?: unknown }
): Promise<HubJournalSnapshot> {
  const todayKey = plugin.getTodayKey();
  const spaceSnapshot = space.settingsSnapshot as { diaryPath?: string; diaryNameFormat?: string } | undefined;
  const spaceDiaryPath = spaceSnapshot?.diaryPath;
  const spaceDiaryNameFormat = spaceSnapshot?.diaryNameFormat;
  const journalSvc = plugin.journalSvc as any;
  const originalPathOverride = journalSvc._diaryPathOverride;
  const originalFormatOverride = journalSvc._diaryNameFormatOverride;
  try {
    journalSvc.setDiaryPathOverride(spaceDiaryPath || null, spaceDiaryNameFormat || null);
    const f = journalSvc.findDiaryFileForDateKey(todayKey);
    if (!(f instanceof TFile)) {
      return { fileExists: false, meaningfulChars: 0 };
    }
    const raw = await plugin.app.vault.read(f);
    return { fileExists: true, meaningfulChars: countJournalMeaningfulChars(raw) };
  } catch {
    return { fileExists: false, meaningfulChars: 0 };
  } finally {
    journalSvc.setDiaryPathOverride(originalPathOverride, originalFormatOverride);
  }
}

/** 有文件时的内容灯级别（无文件时 Hub 仍用 ⚪，不采用本级别） */
export function hubJournalContentLevel(snapshot: HubJournalSnapshot): number {
  if (!snapshot.fileExists) return 2;
  if (snapshot.meaningfulChars > HUB_JOURNAL_MEANINGFUL_OK_THRESHOLD) return 1;
  if (snapshot.meaningfulChars > 0) return 2;
  return 3;
}
