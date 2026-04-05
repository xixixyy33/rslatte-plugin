/**
 * 「今日核对」条目行（卡片跳转用）；七分区模型见 `todayReconcileZonesModel.ts`。
 */
export type RecordLineChangeRow = {
  /** 第二行起：状态变更说明 */
  detail: string;
  /** 本地时刻简写（如 HH:mm） */
  timeLabel: string;
};

export type RecordLine = {
  kindLabel: string;
  title: string;
  tags: string[];
  meta: string;
  filePath?: string;
  lineNo?: number;
  /** 更新区多行：有则 `recordReconcileRender` 用两行卡片渲染 */
  changeRows?: RecordLineChangeRow[];
  /** 与 `dayCardStatusIcon` 对齐（如 IN_PROGRESS / DONE） */
  dotStatus?: string;
  /** 进行中子阶段：waiting_others / waiting_until 等 */
  dotTaskPhase?: string;
  /** 扩展：任务 uid、项目 id、联系人 uid、输出路径等，供跳转 */
  ref?: {
    taskUid?: string;
    projectId?: string;
    contactUid?: string;
    outputPath?: string;
    scheduleUid?: string;
  };
};
