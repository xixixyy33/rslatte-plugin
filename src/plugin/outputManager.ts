/**
 * Output 管理和归档模块
 * 提供输出文件的DB同步、归档等功能
 */
import { moment, TFile, TFolder, normalizePath } from "obsidian";
// ✅ moment 从 Obsidian 导入，但 TypeScript 类型定义可能不完整，使用类型断言
const momentFn = moment as any;
import { apiTry } from "../api";
import type RSLattePlugin from "../main";

export function createOutputManager(plugin: RSLattePlugin) {
  return {
    // =========================
    // Output management: DB sync + auto archive
    // =========================

    genUuid(): string {
      const c = (globalThis as any).crypto;
      if (c?.randomUUID) return c.randomUUID();
      const s4 = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
      return `${s4()}${s4()}-${s4()}-${s4()}-${s4()}-${s4()}${s4()}${s4()}`.toLowerCase();
    },

    parseDocCategoryFromBasename(basename: string): string {
      const m = String(basename ?? "").match(/^【([^】]+)】/);
      return (m?.[1] ?? "").trim();
    },

    normStatus(raw: string | undefined): "todo" | "in-progress" | "done" | "cancelled" {
      const s = String(raw ?? "todo").trim();
      if (s === "todo" || s === "in-progress" || s === "done" || s === "cancelled") return s;
      return "todo";
    },

    hashList(vals: string[] | undefined): string {
      return (vals ?? []).map((x) => String(x).trim()).filter(Boolean).sort().join("|");
    },

    async ensureOutputIdInFile(file: TFile): Promise<string> {
      // use existing frontmatter if present, otherwise write one
      let current: string = "";
      try {
        const cache = plugin.app.metadataCache.getFileCache(file);
        const fm = cache?.frontmatter ?? ({} as any);
        current = String(fm?.output_id ?? "").trim();
      } catch {}

      if (current) return current;

      const id = this.genUuid();
      await plugin.app.fileManager.processFrontMatter(file, (fm) => {
        if (!fm.output_id) fm.output_id = id;
      });
      return id;
    },

    async ensureCancelledInfoInFile(file: TFile, fallbackTimeMs?: number): Promise<{ cancelledTimeIso: string; cancelledDate: string }> {
      let cancelled: string = "";
      try {
        const cache = plugin.app.metadataCache.getFileCache(file);
        const fm = cache?.frontmatter ?? ({} as any);
        cancelled = String(
          fm?.cancelled_time ?? fm?.cancelled ?? fm?.cancel_time ?? fm?.deleted_time ?? fm?.delete_time ?? ""
        ).trim();
      } catch {}

      const toIso = (v: any): string => {
        if (!v) return "";
        try {
          const d = typeof v === "number" ? new Date(v) : new Date(String(v));
          if (Number.isNaN(d.getTime())) return "";
          return d.toISOString();
        } catch {
          return "";
        }
      };

      let iso = toIso(cancelled);
      if (!iso) iso = toIso(fallbackTimeMs ?? file.stat?.mtime ?? Date.now());
      const date = momentFn(iso).format("YYYY-MM-DD");

      // persist if missing to stabilize future derivations
      // - keep `cancelled` as a friendly date field
      // - store precise timestamp in `cancelled_time`
      if (!cancelled) {
        await plugin.app.fileManager.processFrontMatter(file, (fm) => {
          (fm as any).cancelled = date;
          (fm as any).cancelled_time = iso;

          // clean legacy keys to avoid multiple representations
          delete (fm as any).cancel_time;
          delete (fm as any).cancelled_date;
          delete (fm as any).cancel_date;
          delete (fm as any).deleted_time;
          delete (fm as any).delete_time;
          delete (fm as any).deleted_date;
          delete (fm as any).delete_date;
        });
      }

      return { cancelledTimeIso: iso, cancelledDate: date };
    },

    async syncOutputFilesToDb(opts?: { reason?: string }): Promise<void> {
      if (!(plugin as any).isOutputDbSyncEnabled?.()) return;

      // ✅ C0：确保 vaultReadySafe（内部会判断 shouldTouchBackendNow）；不满足条件/失败则直接返回
      const vaultOk = await (plugin as any).vaultSvc?.ensureVaultReadySafe?.("syncOutputFilesToDb");
      if (!vaultOk) return;

      await plugin.outputRSLatte.ensureReady();
      // snapshot might be stale (but refresh is handled by UI). Here we just use existing snapshot.
      const snap = await plugin.outputRSLatte.getSnapshot();
      const items = (snap.items ?? []) as any[];

      // 读取上次同步状态，用于：
      // - 合并保留失败标记（便于刷新重试）
      // - 统计变化（未来可用于增量优化）
      const prevSync = await plugin.outputRSLatte.readSyncState().catch(() => ({ byId: {} } as any));
      const prevById: Record<string, any> = (prevSync as any)?.byId ?? {};

      const today = momentFn().format("YYYY-MM-DD");
      const initAllOps = String(opts?.reason ?? "").toLowerCase().includes("rebuild");

      const files: any[] = [];
      const currentById: Record<string, any> = {};
      // file_ops:
      // - 日常同步：基于索引推断"当天全量【创建/修改/完成/删除】"，避免同一天多次同步后 file_ops 为空。
      // - 重建索引：初始化所有文件的【创建/修改/完成/删除】操作记录（按 op_time 推断 op_date），用于后端补全历史。
      const fileOps: any[] = [];

      for (const it of items) {
        const af = plugin.app.vault.getAbstractFileByPath(it.filePath);
        if (!(af instanceof TFile)) continue;

        const outputId = it.outputId || (await this.ensureOutputIdInFile(af));

        const tags: string[] = (it.tags ?? []).map((x: any) => String(x).replace(/^#/, "").trim()).filter(Boolean);
        const domains: string[] = (it.domains ?? []).map((x: any) => String(x).trim()).filter(Boolean);

        const status = this.normStatus(it.status);
        const type = (it.type ? String(it.type).trim() : "") || null;

        const docCategory = (it.docCategory ? String(it.docCategory).trim() : "") || this.parseDocCategoryFromBasename(af.basename) || "未分类";

        const created_time = it.ctimeMs ? new Date(it.ctimeMs).toISOString() : null;
        const modified_time = it.mtimeMs ? new Date(it.mtimeMs).toISOString() : null;
        // Prefer full timestamp stored in frontmatter `done` (indexed as doneTime)
        const done_time = (it as any).doneTime
          ? String((it as any).doneTime)
          : it.doneDate
            ? new Date(String(it.doneDate) + "T00:00:00").toISOString()
            : null;

        // cancelled info: stored in frontmatter `cancelled` (preferred), fallback to mtime
        let cancelled_date: string | null = null;
        let cancelled_time: string | null = null;
        if (status === "cancelled") {
          const fallbackMs = Number(it.mtimeMs ?? af.stat?.mtime ?? Date.now());
          const info = await this.ensureCancelledInfoInFile(af, fallbackMs);
          cancelled_time = info.cancelledTimeIso;
          cancelled_date = info.cancelledDate;
        }

        files.push({
          output_id: outputId,
          file_path: af.path,
          file_name: af.name,
          doc_category: docCategory,
          status,
          type,
          tags,
          domains,
          created_time,
          modified_time,
          done_time,
          cancelled_date,
          extra: {
            create_date: it.createDate ?? null,
            done_date: it.doneDate ?? null,
          },
        });

        const tagsHash = this.hashList(tags);
        const domainsHash = this.hashList(domains);
        currentById[outputId] = {
          filePath: af.path,
          mtimeMs: it.mtimeMs,
          status,
          type: type ?? undefined,
          tagsHash,
          domainsHash,
          // keep previous DB sync markers if present
          dbSyncState: prevById[outputId]?.dbSyncState,
          dbLastError: prevById[outputId]?.dbLastError,
          dbRetryCount: prevById[outputId]?.dbRetryCount,
          dbLastTriedAt: prevById[outputId]?.dbLastTriedAt,
          dbLastOkAt: prevById[outputId]?.dbLastOkAt,
        };

        // per-file ops
        // 规则：同一文件同一天可能同时发生 创建/修改/完成，需要分别记录为多条，便于分析。
        // 顺序：created -> updated -> done -> deleted
        const reason = opts?.reason ?? "manual";
        const pushOp = (kind: "created" | "updated" | "done" | "deleted", opTimeIso: string | null, extra?: any) => {
          if (!opTimeIso) return;
          const d = momentFn(opTimeIso).format("YYYY-MM-DD");
          const opDate = initAllOps ? d : today;
          // 日常同步只记录今天；重建索引则按真实日期初始化
          if (!initAllOps && d !== today) return;
          fileOps.push({
            output_id: outputId,
            op_date: opDate,
            op_kind: kind,
            op_time: opTimeIso,
            source: reason,
            extra: extra ?? {},
          });
        };

        // created / updated
        pushOp("created", created_time, { ctime_ms: it.ctimeMs ?? null });
        pushOp("updated", modified_time, { mtime_ms: it.mtimeMs ?? null });
        // done
        if (status === "done") {
          pushOp("done", done_time ?? modified_time, { done_date: it.doneDate ?? null });
        }
        // cancelled
        if (status === "cancelled") {
          pushOp("deleted", cancelled_time ?? modified_time, { cancelled_date });
        }
      }

      // === push to backend ===
      const countBy = (arr: any[], k: string) => arr.filter((x) => x.op_kind === k).length;

      const chunk = <T>(arr: T[], size: number): T[][] => {
        const out: T[][] = [];
        const n = Math.max(1, Math.floor(size));
        for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
        return out;
      };

      const FILE_BATCH = 50;
      const OPS_BATCH = 200;

      const upsertFilesBatched = async (): Promise<{ anyFailed: boolean; lastErr?: any }> => {
        let anyFailed = false;
        let lastErr: any = null;
        const batches = chunk(files, FILE_BATCH);
        for (const b of batches) {
          const triedAt = new Date().toISOString();
          try {
            // files-only upsert (avoid repeating giant files list when syncing many days)
            await apiTry("输出文档同步", () => plugin.api.outputFilesSync({ sync_mode: "full", files: b }));
            const okAt = new Date().toISOString();
            for (const f of b) {
              const id = String(f.output_id);
              currentById[id] = {
                ...(currentById[id] ?? {}),
                dbSyncState: "ok",
                dbLastError: undefined,
                dbLastTriedAt: triedAt,
                dbLastOkAt: okAt,
                dbRetryCount: Number((currentById[id] ?? {}).dbRetryCount ?? 0),
              };
            }
          } catch (e: any) {
            anyFailed = true;
            lastErr = e;
            const msg = e?.data?.detail?.message || e?.message || String(e);
            for (const f of b) {
              const id = String(f.output_id);
              const prevTries = Number((currentById[id] ?? {}).dbRetryCount ?? 0);
              currentById[id] = {
                ...(currentById[id] ?? {}),
                dbSyncState: "failed",
                dbLastError: String(msg),
                dbLastTriedAt: triedAt,
                dbRetryCount: prevTries + 1,
              };
            }
            // continue to next batch, keep marking failures for later manual retry
          }
        }
        return { anyFailed, lastErr };
      };

      const pushDailyOpsBatched = async (opDate: string, ops: any[]) => {
        // split ops to keep payload bounded
        const batches = chunk(ops ?? [], OPS_BATCH);
        if (!batches.length) batches.push([]);
        for (const part of batches) {
          const payload = {
            sync_mode: "full",
            // daily ops can be synced without repeating `files`
            files: [],
          daily_ops: {
            op_date: opDate,
            created_count: countBy(part, "created"),
            modified_count: countBy(part, "updated"),
            moved_count: 0,
            deleted_count: countBy(part, "deleted"),
            updated_count: countBy(part, "done"),
            done_count: countBy(part, "done"),
            ops: part,
            },
          };
          try {
            await apiTry("输出操作同步", () => plugin.api.outputFilesSync(payload));
          } catch (e: any) {
            // best-effort: continue syncing other days
            console.warn(`[RSLatte][output] sync daily_ops for ${opDate} failed:`, e);
          }
        }
      };

      // 1) upsert files
      const fileSyncResult = await upsertFilesBatched();

      // 2) upsert file_ops grouped by date (daily_ops)
      const opsByDate = new Map<string, any[]>();
      for (const op of fileOps) {
        const d = String(op.op_date ?? "");
        if (!d) continue;
        if (!opsByDate.has(d)) opsByDate.set(d, []);
        opsByDate.get(d)!.push(op);
      }

      for (const [opDate, ops] of opsByDate.entries()) {
        await pushDailyOpsBatched(opDate, ops);
      }

      // 3) persist sync state
      await plugin.outputRSLatte.writeSyncState({ byId: currentById });

      // 4) best-effort status light update
      try {
        const total = files.length;
        const failed = Object.values(currentById).filter((x: any) => x.dbSyncState === "failed").length;
        const pending = total - failed - Object.values(currentById).filter((x: any) => x.dbSyncState === "ok").length;
        (plugin as any).markDbSyncWithCounts?.("output", {
          ok: !fileSyncResult.anyFailed && failed === 0,
          pendingCount: pending,
          failedCount: failed,
          err: fileSyncResult.lastErr ? String(fileSyncResult.lastErr) : undefined,
        });
      } catch {
        // ignore
      }
    },

    async archiveOutputFilesNow(_opts?: { reason?: string }): Promise<number> {
      const op: any = (plugin.settings as any).outputPanel ?? {};
      const archiveRoot = normalizePath(String(op.archiveRootDir ?? "99-Archive").trim() || "99-Archive");
      const days = Math.max(1, Number(op.archiveThresholdDays ?? 90));
      const cutoffDate = momentFn().subtract(Math.floor(days), "days").format("YYYY-MM-DD");

      await plugin.outputRSLatte.ensureReady();
      // ✅ 使用 active 模式：archiveOutputFilesNow 会自己处理归档逻辑，不需要 refreshIndexNow 自动清理
      await plugin.outputRSLatte.refreshIndexNow({ mode: "active" });

      const snap = await plugin.outputRSLatte.getSnapshot();
      const items = (snap.items ?? []) as any[];

      let moved = 0;

      const exists = (p: string) => !!plugin.app.vault.getAbstractFileByPath(p);

      for (const it of items) {
        const st = this.normStatus(it.status);

        // ✅ 仅归档：status in {done,cancelled}
        if (st !== "done" && st !== "cancelled") continue;

        // ✅ 必须存在完成/取消日期字段；否则跳过（避免误移动）
        const dateKey = st === "done" ? String(it.doneDate ?? it.done ?? "") : String(it.cancelledDate ?? it.cancelled ?? "");
        if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(dateKey)) continue;

        // ✅ 比较：done/cancelled <= cutoffDate
        if (dateKey > cutoffDate) continue;

        const af = plugin.app.vault.getAbstractFileByPath(it.filePath);
        if (!(af instanceof TFile)) continue;

        // DONE：已在全局归档目录内则跳过
        if (st === "done" && af.path.startsWith(archiveRoot + "/")) continue;

        // CANCELLED：已在 <top>/_archived 内则跳过
        if (st === "cancelled") {
          const parts = af.path.split("/").filter(Boolean);
          if (parts.length >= 2 && parts[1] === "_archived") continue;
          if (af.path.startsWith("_archived/")) continue;
        }

        // ✅ 获取文件所在的目录（新结构：文件在以其名称命名的目录下）
        const fileDir = normalizePath(af.path.substring(0, af.path.lastIndexOf("/")));
        const fileName = af.path.substring(af.path.lastIndexOf("/") + 1);
        const dirName = fileDir.substring(fileDir.lastIndexOf("/") + 1);
        const fileNameWithoutExt = fileName.replace(/\.md$/i, "");
        
        // 判断新结构：
        // 1. 目录名等于文件名（不含扩展名）- 旧判断逻辑
        // 2. 目录名包含【分类】前缀，且去掉【分类】后等于文件名（不含扩展名）- 新结构
        // 3. 目录名以【开头，说明是带分类前缀的完整标题
        const isNewStructure = 
          dirName === fileNameWithoutExt || 
          (dirName.startsWith("【") && dirName.includes("】") && dirName.replace(/^【[^】]+】/, "") === fileNameWithoutExt) ||
          (dirName.startsWith("【") && dirName.endsWith("】" + fileNameWithoutExt));
        
        let destDir = "";
        let destFile = "";

        if (st === "done") {
          // DONE -> 99-Archive/<原目录路径>
          if (isNewStructure) {
            // 新结构：移动整个目录
            destDir = normalizePath(`${archiveRoot}/${fileDir}`);
          } else {
            // 旧结构：保持原有逻辑（移动单个文件）
            destFile = normalizePath(`${archiveRoot}/${af.path}`);
          }
        } else {
          // CANCELLED -> <top>/_archived/<rest>
          const parts = (isNewStructure ? fileDir : af.path).split("/").filter(Boolean);
          if (parts.length >= 2) {
            const top = parts[0];
            const rest = parts.slice(1).join("/");
            if (isNewStructure) {
              destDir = normalizePath(`${top}/_archived/${rest}`);
            } else {
              destFile = normalizePath(`${top}/_archived/${rest}`);
            }
          } else {
            // fallback: file at vault root
            if (isNewStructure) {
              destDir = normalizePath(`_archived/${fileDir}`);
            } else {
              destFile = normalizePath(`_archived/${af.path}`);
            }
          }
        }

        if (isNewStructure) {
          // ✅ 新结构：移动整个目录
          // 检查目标目录是否存在
          if (exists(destDir)) {
            let i = 2;
            const baseDirName = destDir.substring(destDir.lastIndexOf("/") + 1);
            const parentDir = destDir.substring(0, destDir.lastIndexOf("/"));
            while (exists(normalizePath(`${parentDir}/${baseDirName}-${i}`))) i++;
            destDir = normalizePath(`${parentDir}/${baseDirName}-${i}`);
          }
          
          // 使用 vault.rename 移动整个目录（包括所有子文件和子文件夹）
          const dir = plugin.app.vault.getAbstractFileByPath(fileDir);
          if (dir && dir instanceof TFolder) {
            await (plugin as any).ensureDirForPath?.(destDir);
            // 使用 vault.rename 移动整个文件夹
            await plugin.app.vault.rename(dir, destDir);
          }
        } else {
          // 旧结构：移动单个文件（保持向后兼容）
          // avoid overwrite
          if (exists(destFile)) {
            const base = destFile.replace(/\.md$/i, "");
            let i = 2;
            while (exists(normalizePath(`${base}-${i}.md`))) i++;
            destFile = normalizePath(`${base}-${i}.md`);
          }

          await (plugin as any).ensureDirForPath?.(destFile);
          await plugin.app.fileManager.renameFile(af, destFile);
        }
        
        // ✅ Work Event (success only)
        try {
          // 计算文件的最终路径
          let finalPath = "";
          if (isNewStructure) {
            // 新结构：目录已移动，文件路径是 destDir + 相对路径
            finalPath = normalizePath(`${destDir}/${fileName}`);
          } else {
            // 旧结构：文件已移动
            finalPath = destFile;
          }
          
          void plugin.workEventSvc?.append({
            ts: new Date().toISOString(),
            kind: "output",
            action: "archive",
            source: "auto",
            ref: {
              file_path: it.filePath,
              old_file_path: it.filePath,
              new_file_path: finalPath,
              status: st,
              date_key: dateKey,
            },
            summary: `🗄 归档输出 ${af.basename} (${st === "done" ? "已完成" : "已取消"})`,
            metrics: { archive_date: dateKey },
          });
        } catch {
          // ignore
        }
        
        moved++;
      }

      // After moving, refresh index for consistent UI/DB sync
      // ✅ 归档后，先使用 full 模式刷新索引（扫描归档目录，更新文件路径），然后清理主索引
      try {
        // 先刷新索引，让索引包含移动后的新路径
        await plugin.outputRSLatte.refreshIndexNow({ mode: "full" });
        // refreshIndexNow({ mode: "full" }) 会自动调用 archiveIndexForArchivedFiles() 清理主索引
        // 所以这里不需要再手动调用 archiveIndexForArchivedFiles()
      } catch (e) {
        // 如果刷新失败，尝试手动清理索引
        try {
          await plugin.outputRSLatte?.archiveIndexForArchivedFiles?.();
        } catch {}
      }

      return moved;
    },
  };
}
