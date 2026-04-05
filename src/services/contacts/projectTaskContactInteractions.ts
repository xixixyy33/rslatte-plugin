/**
 * 根据单个项目任务清单文件构建联系人互动条目（与 projectSpecAtomic 中 project_task 逻辑一致）。
 * 用于项目任务在 UI 中更新后，单独刷新该文件对应的联系人互动索引，使联系人笔记中的动态互动块获取到最新状态。
 *
 * 任务行上无 [[C_xxx]]、仅下一行 meta 含 follow_contact_uids 时也必须入账（弱关联 + 等待/跟进 phase），
 * 故遍历「所有任务行」合并 parseContactRefsFromMarkdown 的 byLine，而非仅遍历 byLine 的键。
 */
import type { App, TFile } from "obsidian";
import { normalizePath } from "obsidian";
import type { ContactsInteractionEntry } from "../../contactsRSLatte/types";
import { extractContactUidFromWikiTarget, parseContactRefsFromMarkdown } from "./contactRefParser";
import { getNearestHeadingTitle } from "../markdown/headingLocator";

const isTaskLine = (lineText: string): boolean => /^\s*[-*+]\s+\[[^\]]\]/.test(String(lineText ?? ""));

function mapStatusFromTaskLine(lineText: string): string {
  const m = String(lineText ?? "").match(/^\s*[-*+]\s+\[([^\]])\]/);
  if (!m) return "unknown";
  const c = String(m[1] ?? "");
  if (c === "x" || c === "X") return "done";
  if (c === " ") return "todo";
  if (c === "-" || c === "/" || c === ">") return "in_progress";
  if (c === "c" || c === "C") return "cancelled";
  return "unknown";
}

function splitContentLines(content: string): string[] {
  return String(content ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

/**
 * 从已读入的项目任务清单正文构建联系人互动条目（与 Pipeline Step4 语义一致）。
 */
export function buildProjectTaskContactEntriesFromMarkdownContent(
  content: string,
  source_path: string,
  updated_at: string
): ContactsInteractionEntry[] {
  const path = normalizePath(String(source_path ?? "").trim());
  if (!path) return [];

  const contentLines = splitContentLines(content);
  const nowIso = String(updated_at ?? new Date().toISOString());

  const allRefs = parseContactRefsFromMarkdown(content, {
    source_path: path,
    source_type: "project_task",
    updated_at: nowIso,
  });

  const byLine = new Map<number, ContactsInteractionEntry[]>();
  for (const e of allRefs) {
    const ln = Number((e as any)?.line_no ?? 0);
    if (!ln) continue;
    const arr = byLine.get(ln) ?? [];
    arr.push(e as any);
    byLine.set(ln, arr);
  }

  const out: ContactsInteractionEntry[] = [];

  for (let ln0 = 0; ln0 < contentLines.length; ln0++) {
    const lineText = String(contentLines[ln0] ?? "");
    if (!isTaskLine(lineText)) continue;
    const ln1 = ln0 + 1;

    const refs0 = byLine.get(ln1) ?? [];
    const refs = refs0.slice();
    for (const r of refs) (r as any).follow_association_type = "strong";

    // 强关联：任务描述中 [[C_xxx]]
    try {
      const re = /\[\[([^\]]+)\]\]/g;
      const found = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = re.exec(lineText)) !== null) {
        const inside = String(m[1] ?? "");
        const target = (inside.split("|")[0] ?? "").trim();
        const uid = extractContactUidFromWikiTarget(target);
        if (uid) found.add(uid);
      }
      if (found.size > 0) {
        const existing = new Set(refs.map((x) => String((x as any)?.contact_uid ?? "").trim()).filter(Boolean));
        const heading = getNearestHeadingTitle(contentLines, ln0);
        const snippet = String(lineText ?? "").trimEnd().slice(0, 240);
        for (const uid of found) {
          if (!uid || existing.has(uid)) continue;
          refs.push({
            contact_uid: uid,
            source_path: path,
            source_type: "project_task",
            snippet,
            line_no: ln1,
            heading,
            updated_at: nowIso,
            key: `${uid}|${path}|project_task|${ln1}`,
            follow_association_type: "strong",
          } as any);
          existing.add(uid);
        }
      }
    } catch {
      // ignore
    }

    // 弱关联：meta 中 follow_contact_uids；并解析 task_phase
    let taskPhase = "";
    try {
      const nextLine = String(contentLines[ln1] ?? "");
      const metaMatch = nextLine.match(/<!--\s*rslatte:([\s\S]*?)-->/i);
      if (metaMatch?.[1]) {
        const body = metaMatch[1].replace(/\s+/g, " ").trim();
        const phaseMatch = body.match(/task_phase=(\S+)/);
        if (phaseMatch?.[1]) taskPhase = String(phaseMatch[1]).trim();
        const followUidsMatch = body.match(/follow_contact_uids=([^;\s]+)/);
        if (followUidsMatch?.[1]) {
          const followUids = followUidsMatch[1].split(/[,;]/).map((s) => s.trim()).filter(Boolean);
          const existing = new Set(refs.map((x) => String((x as any)?.contact_uid ?? "").trim()).filter(Boolean));
          const heading = getNearestHeadingTitle(contentLines, ln0);
          const snippet = String(lineText ?? "").trimEnd().slice(0, 240);
          for (const uid of followUids) {
            if (!uid || existing.has(uid)) continue;
            refs.push({
              contact_uid: uid,
              source_path: path,
              source_type: "project_task",
              snippet,
              line_no: ln1,
              heading,
              updated_at: nowIso,
              key: `${uid}|${path}|project_task|${ln1}`,
              follow_association_type: "weak",
            } as any);
            existing.add(uid);
          }
        }
      }
    } catch {
      // ignore
    }

    if (!refs || refs.length === 0) continue;
    const status = mapStatusFromTaskLine(lineText);
    for (const r of refs) {
      const assoc = (r as any).follow_association_type as "strong" | "weak" | undefined;
      const followStatus: "following" | "ended" =
        assoc === "strong"
          ? status === "done" || status === "cancelled"
            ? "ended"
            : "following"
          : taskPhase === "waiting_others" || taskPhase === "waiting_until"
            ? "following"
            : "ended";
      out.push({
        ...(r as any),
        status,
        follow_status: followStatus,
        task_phase: taskPhase || undefined,
        updated_at: nowIso,
      } as any);
    }
  }

  return out;
}

export async function buildProjectTaskContactEntriesForFile(
  app: App,
  tasklistPath: string
): Promise<{ mtime: number; entries: ContactsInteractionEntry[] }> {
  const path = normalizePath(String(tasklistPath ?? "").trim());
  if (!path) return { mtime: 0, entries: [] };

  const af = app.vault.getAbstractFileByPath(path);
  if (!af || !(af instanceof TFile)) return { mtime: 0, entries: [] };

  const content = await app.vault.read(af);
  const nowIso = new Date().toISOString();
  const mtime = Number((af.stat as any)?.mtime ?? 0);
  const entries = buildProjectTaskContactEntriesFromMarkdownContent(content, path, nowIso);
  return { mtime, entries };
}
