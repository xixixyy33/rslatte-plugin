import { Notice } from "obsidian";
import type RSLattePlugin from "../../main";
import type { ExecutionFlowContext } from "../../types/executionFlowTypes";
import { type ExecutionRecipeId } from "../../services/execution/executionRecipes";
import { ExecutionFlowError, runExecutionFlow } from "../../services/execution/executionOrchestrator";

function genClientOpId(recipeId: string): string {
  return `${recipeId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

export async function runExecutionFlowUi(
  plugin: RSLattePlugin,
  recipeId: ExecutionRecipeId,
  ctx: ExecutionFlowContext,
  opts?: { actionLabel?: string; retryOnceOnFail?: boolean }
): Promise<void> {
  const withOpId: ExecutionFlowContext = {
    ...ctx,
    clientOpId: String(ctx.clientOpId ?? "").trim() || genClientOpId(recipeId),
  };
  const actionLabel = String(opts?.actionLabel ?? "操作").trim() || "操作";
  const retryOnce = opts?.retryOnceOnFail !== false;
  try {
    await runExecutionFlow(plugin, recipeId, withOpId);
  } catch (e) {
    if (retryOnce) {
      try {
        await runExecutionFlow(plugin, recipeId, withOpId);
        new Notice(`${actionLabel}重试成功`);
        return;
      } catch (e2) {
        if (e2 instanceof ExecutionFlowError) {
          const r = e2.result;
          new Notice(
            `${actionLabel}失败：${r.errorMessage ?? "未知错误"}（步骤: ${r.failedStepId ?? "-"}，op: ${r.clientOpId ?? "-"}）`
          );
        } else {
          new Notice(`${actionLabel}失败：${(e2 as any)?.message ?? String(e2)}`);
        }
        throw e2;
      }
    }
    if (e instanceof ExecutionFlowError) {
      const r = e.result;
      new Notice(
        `${actionLabel}失败：${r.errorMessage ?? "未知错误"}（步骤: ${r.failedStepId ?? "-"}，op: ${r.clientOpId ?? "-"}）`
      );
    }
    throw e;
  }
}
