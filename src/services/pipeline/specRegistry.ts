/**
 * SpecRegistry helpers
 *
 * Step P1: attach Project/Output atomic specs as thin adapters so that
 * engine.runE2("project"|"output", "rebuild") can be used without changing
 * existing business semantics.
 *
 * ## 归档 / 重建语义（§8.1）
 *
 * - **`rebuildActiveOnly`**：日常 `rebuild`/`refresh` 的 `replaceAll`（及联系人本地写回）——活跃根为主，不默认全扫归档树。
 * - **`rebuildAfterPhysicalArchive`**：`archiveOutOfRange` 在物理搬迁后对齐主索引与归档分片/双索引。
 *
 * 各模块登记见 **`rebuildScopeSemantics.ts`** 的 **`PIPELINE_ATOMIC_REBUILD_SCOPE_REGISTRY`**（`contacts` / `project` / `output`）。
 */

import type { RSLatteModuleKey } from "./types";
import type { ModuleSpecAny } from "./moduleSpec";
import { createProjectSpecAtomic } from "./specs/projectSpecAtomic";
import { createOutputSpecAtomic } from "./specs/outputSpecAtomic";
import { createContactsSpecAtomic } from "./specs/contactsSpecAtomic";
import { createTaskSpecAtomic } from "./specs/taskSpecAtomic";
import { createMemoSpecAtomic } from "./specs/memoSpecAtomic";
import { createScheduleSpecAtomic } from "./specs/scheduleSpecAtomic";
import { createCheckinSpecAtomic } from "./specs/checkinSpecAtomic";
import { createFinanceSpecAtomic } from "./specs/financeSpecAtomic";
import { createHealthSpecAtomic } from "./specs/healthSpecAtomic";
import { createKnowledgeSpecAtomic } from "./specs/knowledgeSpecAtomic";
import { PIPELINE_ATOMIC_REBUILD_SCOPE_REGISTRY } from "./rebuildScopeSemantics";

/** §8.1 模块登记（侧载引用，避免仅文档型常量被 tree-shake 误删） */
export { PIPELINE_ATOMIC_REBUILD_SCOPE_REGISTRY };

export function withProjectOutputAtomicSpecs(
  plugin: any,
  overrides: Partial<Record<RSLatteModuleKey, ModuleSpecAny>>
): Partial<Record<RSLatteModuleKey, ModuleSpecAny>> {
  const next: Partial<Record<RSLatteModuleKey, ModuleSpecAny>> = { ...(overrides ?? {}) };

  const taskLegacy = next.task;
  const memoLegacy = next.memo;
  const checkinLegacy = next.checkin;
  const financeLegacy = next.finance;
  const healthLegacy = (next as any).health;
  const projectLegacy = next.project;
  const outputLegacy = next.output;
  const contactsLegacy = (next as any).contacts;
  const scheduleLegacy = (next as any).schedule;

  // Merge: keep legacy behavior for engine.run, add atomic behavior for engine.runE2
  // ✅ D3: task atomic spec extracted to file; DB sync toggle fully governs queue/flush/reconcile
  next.task = { ...(taskLegacy as any), ...(createTaskSpecAtomic(plugin) as any) } as any;
  // ✅ D4: memo atomic spec extracted to file; DB sync toggle fully governs queue/flush/reconcile
  next.memo = { ...(memoLegacy as any), ...(createMemoSpecAtomic(plugin) as any) } as any;
  // ✅ schedule：atomic 为自动/手动 E2 主路径（coordinator tick 一律 runE2）
  (next as any).schedule = { ...(scheduleLegacy as any), ...(createScheduleSpecAtomic(plugin) as any) } as any;
  // ✅ D5: checkin atomic spec extracted to file; DB sync toggle fully governs queue/flush/reconcile
  next.checkin = { ...(checkinLegacy as any), ...(createCheckinSpecAtomic(plugin) as any) } as any;
  // ✅ D6: finance atomic spec extracted to file; DB sync toggle fully governs queue/flush/reconcile
  next.finance = { ...(financeLegacy as any), ...(createFinanceSpecAtomic(plugin) as any) } as any;
  (next as any).health = { ...(healthLegacy as any), ...(createHealthSpecAtomic(plugin) as any) } as any;
  next.project = { ...(projectLegacy as any), ...(createProjectSpecAtomic(plugin) as any) } as any;
  next.output = { ...(outputLegacy as any), ...(createOutputSpecAtomic(plugin) as any) } as any;
  (next as any).contacts = { ...(contactsLegacy as any), ...(createContactsSpecAtomic(plugin) as any) } as any;
  (next as any).knowledge = { ...((next as any).knowledge as any), ...(createKnowledgeSpecAtomic(plugin) as any) } as any;

  return next;
}
