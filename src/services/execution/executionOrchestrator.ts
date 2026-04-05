import type RSLattePlugin from "../../main";
import type {
  ExecutionFlowContext,
  ExecutionFlowResult,
  ExecutionFlowRunRecord,
  ExecutionFlowRunStepState,
} from "../../types/executionFlowTypes";
import { EXECUTION_RECIPE, type ExecutionRecipeId } from "./executionRecipes";
import { getExecutionRunRecord, upsertExecutionRunRecord } from "./executionRunStore";

type ExecutionStepDef = {
  id: string;
  run: () => Promise<void>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function makeFlowId(): string {
  return `flow:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeErrMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e ?? "unknown error");
}

function buildStepStates(steps: ExecutionStepDef[], old?: ExecutionFlowRunStepState[]): ExecutionFlowRunStepState[] {
  const map = new Map<string, ExecutionFlowRunStepState>();
  for (const s of old ?? []) map.set(s.stepId, s);
  return steps.map((s) => map.get(s.id) ?? { stepId: s.id, status: "pending", updatedAt: nowIso() });
}

function isStepAlreadySuccess(record: ExecutionFlowRunRecord | null, stepId: string): boolean {
  if (!record) return false;
  const hit = (record.stepStates ?? []).find((x) => x.stepId === stepId);
  return hit?.status === "success";
}

function toErrorResult(
  recipeId: ExecutionRecipeId,
  flowId: string,
  clientOpId: string | undefined,
  failedStepId: string,
  errorMessage: string
): ExecutionFlowResult {
  return {
    ok: false,
    recipeId,
    flowId,
    clientOpId,
    status: "failed",
    failedStepId,
    errorMessage,
  };
}

export class ExecutionFlowError extends Error {
  public readonly result: ExecutionFlowResult;

  constructor(result: ExecutionFlowResult) {
    super(
      `[RSLatte][execution] ${result.recipeId} failed` +
      `${result.failedStepId ? ` at ${result.failedStepId}` : ""}` +
      `${result.errorMessage ? `: ${result.errorMessage}` : ""}`
    );
    this.name = "ExecutionFlowError";
    this.result = result;
  }
}

function buildRecipeSteps(
  plugin: RSLattePlugin,
  recipeId: ExecutionRecipeId,
  ctx: ExecutionFlowContext
): ExecutionStepDef[] {
  switch (recipeId) {
    case EXECUTION_RECIPE.tripleSaveTask:
      return [
        { id: "appendWorkEvent", run: () => appendWorkEventStep(plugin, ctx) },
        { id: "refreshTaskMemoIndex", run: () => refreshTaskMemoIndexStep(plugin, ctx) },
        { id: "refreshTaskContacts", run: () => refreshContactInteractionsForTaskFileStep(plugin, ctx) },
        { id: "refreshSidePanel", run: async () => { plugin.refreshSidePanel?.(); } },
      ];
    case EXECUTION_RECIPE.tripleSaveMemo:
      return [
        { id: "appendWorkEvent", run: () => appendWorkEventStep(plugin, ctx) },
        { id: "refreshTaskMemoIndex", run: () => refreshTaskMemoIndexStep(plugin, ctx) },
        { id: "refreshSidePanel", run: async () => { plugin.refreshSidePanel?.(); } },
      ];
    case EXECUTION_RECIPE.tripleSaveSchedule:
      return [
        { id: "appendWorkEvent", run: () => appendWorkEventStep(plugin, ctx) },
        { id: "refreshScheduleE2", run: () => refreshScheduleByE2Step(plugin) },
        { id: "refreshSidePanel", run: async () => { plugin.refreshSidePanel?.(); } },
      ];
    case EXECUTION_RECIPE.workEventOnly:
      return [{ id: "appendWorkEvent", run: () => appendWorkEventStep(plugin, ctx) }];
    case EXECUTION_RECIPE.updateTaskAndRefresh:
      return [
        { id: "appendWorkEvent", run: () => appendWorkEventStep(plugin, ctx) },
        {
          id: "refreshTaskMemoIndex",
          run: () => refreshTaskMemoIndexStep(plugin, { ...ctx, modules: { task: true, memo: true } }),
        },
        // 与 vault 中间一行可能同时含任务与日程 meta：任务写盘后顺带跑 schedule E2，刷新 schedule-index（含 schedule_tags）
        { id: "refreshScheduleE2", run: () => refreshScheduleByE2Step(plugin) },
        { id: "refreshSidePanel", run: async () => { plugin.refreshSidePanel?.(); } },
      ];
    case EXECUTION_RECIPE.updateMemoAndRefresh:
      return [
        { id: "appendWorkEvent", run: () => appendWorkEventStep(plugin, ctx) },
        {
          id: "refreshTaskMemoIndex",
          run: () => refreshTaskMemoIndexStep(plugin, { ...ctx, modules: { memo: true } }),
        },
        { id: "refreshSidePanel", run: async () => { plugin.refreshSidePanel?.(); } },
      ];
    case EXECUTION_RECIPE.updateScheduleAndRefresh:
      return [
        { id: "appendWorkEvent", run: () => appendWorkEventStep(plugin, ctx) },
        { id: "refreshScheduleE2", run: () => refreshScheduleByE2Step(plugin) },
        { id: "refreshSidePanel", run: async () => { plugin.refreshSidePanel?.(); } },
      ];
    case EXECUTION_RECIPE.panelRefreshTaskOnly:
      return [{ id: "refreshTaskE2", run: () => refreshTaskByE2Step(plugin) }];
    case EXECUTION_RECIPE.panelRefreshMemoOnly:
      return [{ id: "refreshMemoE2", run: () => refreshMemoByE2Step(plugin) }];
    case EXECUTION_RECIPE.panelRefreshScheduleOnly:
      return [{ id: "refreshScheduleE2", run: () => refreshScheduleByE2Step(plugin) }];
  }
  throw new Error(`Unknown execution recipe: ${String(recipeId)}`);
}

/**
 * 薄编排：门面已成功写 vault 之后，按配方执行索引刷新、Pipeline、侧栏等副作用。
 * 禁止在本文件内拼 markdown 或绕过门面写任务/提醒/日程行。
 */
export async function runExecutionFlow(
  plugin: RSLattePlugin,
  recipeId: ExecutionRecipeId,
  ctx: ExecutionFlowContext
): Promise<ExecutionFlowResult> {
  const flowId = String(ctx.flowId ?? "").trim() || makeFlowId();
  const clientOpId = String(ctx.clientOpId ?? "").trim() || undefined;
  const steps = buildRecipeSteps(plugin, recipeId, ctx);

  const oldRecord = clientOpId ? await getExecutionRunRecord(plugin, clientOpId) : null;
  if (oldRecord && oldRecord.recipeId === recipeId && oldRecord.status === "success") {
    return {
      ok: true,
      recipeId,
      flowId: oldRecord.flowId || flowId,
      clientOpId,
      status: "deduped",
    };
  }

  let record: ExecutionFlowRunRecord | null = null;
  if (clientOpId) {
    record = oldRecord && oldRecord.recipeId === recipeId
      ? {
        ...oldRecord,
        flowId: oldRecord.flowId || flowId,
        status: "running",
        stepStates: buildStepStates(steps, oldRecord.stepStates),
        updatedAt: nowIso(),
      }
      : {
        clientOpId,
        flowId,
        recipeId,
        status: "running",
        stepStates: buildStepStates(steps),
        updatedAt: nowIso(),
      };
    await upsertExecutionRunRecord(plugin, record);
  }

  for (const step of steps) {
    if (isStepAlreadySuccess(record, step.id)) continue;
    try {
      await step.run();
      if (record) {
        record.stepStates = record.stepStates.map((s) =>
          s.stepId === step.id ? { ...s, status: "success", lastError: undefined, updatedAt: nowIso() } : s
        );
        record.lastError = undefined;
        record.updatedAt = nowIso();
        await upsertExecutionRunRecord(plugin, record);
      }
    } catch (e) {
      const msg = normalizeErrMessage(e);
      if (record) {
        record.status = "partial";
        record.lastError = msg;
        record.stepStates = record.stepStates.map((s) =>
          s.stepId === step.id ? { ...s, status: "failed", lastError: msg, updatedAt: nowIso() } : s
        );
        record.updatedAt = nowIso();
        await upsertExecutionRunRecord(plugin, record);
      }
      const failed = toErrorResult(recipeId, flowId, clientOpId, step.id, msg);
      throw new ExecutionFlowError(failed);
    }
  }

  if (record) {
    record.status = "success";
    record.lastError = undefined;
    record.updatedAt = nowIso();
    await upsertExecutionRunRecord(plugin, record);
  }
  return { ok: true, recipeId, flowId, clientOpId, status: "success" };
}

async function appendWorkEventStep(plugin: RSLattePlugin, ctx: ExecutionFlowContext): Promise<void> {
  const ev = ctx.workEvent;
  if (!ev || !plugin.workEventSvc?.append) return;
  try {
    const next: any = { ...ev };
    if (ctx.clientOpId && !next.event_id) next.event_id = String(ctx.clientOpId);
    if (ctx.sourceRef) {
      next.ref = {
        ...(next.ref ?? {}),
        source_item_type: ctx.sourceRef.itemType,
        source_item_uid: ctx.sourceRef.uid,
        source_file_path: ctx.sourceRef.filePath,
        source_line_no: ctx.sourceRef.lineNo,
      };
    }
    await plugin.workEventSvc.append(next);
  } catch (e) {
    console.warn("[RSLatte][execution] workEvent append failed", e);
  }
}

async function refreshTaskMemoIndexStep(plugin: RSLattePlugin, ctx: ExecutionFlowContext): Promise<void> {
  await plugin.taskRSLatte.refreshIndexAndSync({
    sync: ctx.sync,
    noticeOnError: ctx.noticeOnError ?? true,
    modules: ctx.modules,
  });
}

async function refreshTaskByE2Step(plugin: RSLattePlugin): Promise<void> {
  const r = await plugin.pipelineEngine.runE2(plugin.getSpaceCtx(), "task", "manual_refresh");
  if (!r.ok) throw new Error(r.error?.message ?? "task manual_refresh failed");
}

async function refreshMemoByE2Step(plugin: RSLattePlugin): Promise<void> {
  const r = await plugin.pipelineEngine.runE2(plugin.getSpaceCtx(), "memo", "manual_refresh");
  if (!r.ok) throw new Error(r.error?.message ?? "memo manual_refresh failed");
}

async function refreshScheduleByE2Step(plugin: RSLattePlugin): Promise<void> {
  const r = await plugin.pipelineEngine.runE2(plugin.getSpaceCtx(), "schedule" as any, "manual_refresh");
  if (!r.ok) throw new Error(r.error?.message ?? "schedule manual_refresh failed");
}

async function refreshContactInteractionsForTaskFileStep(
  plugin: RSLattePlugin,
  ctx: ExecutionFlowContext
): Promise<void> {
  const fr = ctx.facadeResult;
  if (!fr || fr.kind !== "task") return;
  const path = fr.diaryPath;
  if (!path || typeof plugin.refreshContactInteractionsForTaskFile !== "function") return;
  try {
    await plugin.refreshContactInteractionsForTaskFile(path);
  } catch (e) {
    console.warn("[RSLatte][execution] refreshContactInteractionsForTaskFile failed", e);
  }
}

export { EXECUTION_RECIPE };
