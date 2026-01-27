/**
 * SpecRegistry helpers
 *
 * Step P1: attach Project/Output atomic specs as thin adapters so that
 * engine.runE2("project"|"output", "rebuild") can be used without changing
 * existing business semantics.
 */

import type { RSLatteModuleKey } from "./types";
import type { ModuleSpecAny } from "./moduleSpec";
import { createProjectSpecAtomic } from "./specs/projectSpecAtomic";
import { createOutputSpecAtomic } from "./specs/outputSpecAtomic";
import { createContactsSpecAtomic } from "./specs/contactsSpecAtomic";
import { createTaskSpecAtomic } from "./specs/taskSpecAtomic";
import { createMemoSpecAtomic } from "./specs/memoSpecAtomic";
import { createCheckinSpecAtomic } from "./specs/checkinSpecAtomic";
import { createFinanceSpecAtomic } from "./specs/financeSpecAtomic";
import { createPublishSpecAtomic } from "./specs/publishSpecAtomic";

export function withProjectOutputAtomicSpecs(
  plugin: any,
  overrides: Partial<Record<RSLatteModuleKey, ModuleSpecAny>>
): Partial<Record<RSLatteModuleKey, ModuleSpecAny>> {
  const next: Partial<Record<RSLatteModuleKey, ModuleSpecAny>> = { ...(overrides ?? {}) };

  const taskLegacy = next.task;
  const memoLegacy = next.memo;
  const checkinLegacy = next.checkin;
  const financeLegacy = next.finance;
  const projectLegacy = next.project;
  const outputLegacy = next.output;
  const contactsLegacy = (next as any).contacts;
  const publishLegacy = (next as any).publish;

  // Merge: keep legacy behavior for engine.run, add atomic behavior for engine.runE2
  // ✅ D3: task atomic spec extracted to file; DB sync toggle fully governs queue/flush/reconcile
  next.task = { ...(taskLegacy as any), ...(createTaskSpecAtomic(plugin) as any) } as any;
  // ✅ D4: memo atomic spec extracted to file; DB sync toggle fully governs queue/flush/reconcile
  next.memo = { ...(memoLegacy as any), ...(createMemoSpecAtomic(plugin) as any) } as any;
  // ✅ D5: checkin atomic spec extracted to file; DB sync toggle fully governs queue/flush/reconcile
  next.checkin = { ...(checkinLegacy as any), ...(createCheckinSpecAtomic(plugin) as any) } as any;
  // ✅ D6: finance atomic spec extracted to file; DB sync toggle fully governs queue/flush/reconcile
  next.finance = { ...(financeLegacy as any), ...(createFinanceSpecAtomic(plugin) as any) } as any;
  next.project = { ...(projectLegacy as any), ...(createProjectSpecAtomic(plugin) as any) } as any;
  next.output = { ...(outputLegacy as any), ...(createOutputSpecAtomic(plugin) as any) } as any;
  (next as any).contacts = { ...(contactsLegacy as any), ...(createContactsSpecAtomic(plugin) as any) } as any;
  // ✅ 发布模块 atomic spec：只支持 rebuild，不支持数据库同步和归档
  (next as any).publish = { ...(publishLegacy as any), ...(createPublishSpecAtomic(plugin) as any) } as any;

  return next;
}
