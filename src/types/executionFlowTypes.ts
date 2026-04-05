/**
 * 执行类「门面写笔记 → 编排副作用」共用类型（对齐 docs/V2改造方案/执行类管理优化方案.md）。
 */

import type { WorkEvent } from "./stats/workEvent";

/** 与 taskRSLatte.refreshIndexAndSync 的 modules 对齐；避免 types ↔ service 循环依赖故本地声明 */
export type ExecutionRefreshModules = { task?: boolean; memo?: boolean };

export type ExecutionFacadeResultTask = { kind: "task"; uid: string; diaryPath?: string };
export type ExecutionFacadeResultMemo = { kind: "memo"; uid: string };
export type ExecutionFacadeResultSchedule = { kind: "schedule"; uid: string };

export type ExecutionFacadeResult =
  | ExecutionFacadeResultTask
  | ExecutionFacadeResultMemo
  | ExecutionFacadeResultSchedule;

/** 转化类流程：门面入参侧预留（实现逐场景补全） */
export type ExecutionSourceRef = {
  itemType: "task" | "memo" | "schedule" | "output";
  uid: string;
  filePath: string;
  lineNo: number;
};

export type ExecutionFlowContext = {
  /** 门面成功后的定位结果（编排内用于联系人互动刷新等） */
  facadeResult?: ExecutionFacadeResult;
  /** 转化类：与方案第五节 sourceRef 对齐 */
  sourceRef?: ExecutionSourceRef;
  clientOpId?: string;
  flowId?: string;
  /** 写入工作事件流（时间轴/统计）；省略则本配方不记 event。 */
  workEvent?: WorkEvent;
  /** 传给 refreshIndexAndSync；省略则刷新 task + memo（与历史行为一致） */
  sync: boolean;
  noticeOnError?: boolean;
  modules?: ExecutionRefreshModules;
};

export type ExecutionFlowStepStatus = "pending" | "success" | "failed";

export type ExecutionFlowRunStatus = "running" | "partial" | "success";

export type ExecutionFlowRunStepState = {
  stepId: string;
  status: ExecutionFlowStepStatus;
  lastError?: string;
  updatedAt: string;
};

export type ExecutionFlowRunRecord = {
  clientOpId: string;
  flowId: string;
  recipeId: string;
  status: ExecutionFlowRunStatus;
  stepStates: ExecutionFlowRunStepState[];
  lastError?: string;
  updatedAt: string;
};

export type ExecutionFlowResult = {
  ok: boolean;
  recipeId: string;
  flowId: string;
  clientOpId?: string;
  status: "success" | "partial" | "deduped" | "failed";
  failedStepId?: string;
  errorMessage?: string;
};
