export const VIEW_TYPE_RSLATTE = "rslatte-sidepanel";
export const VIEW_TYPE_TASKS  = "rslatte-taskpanel";
export const VIEW_TYPE_SCHEDULE = "rslatte-schedulepanel";
export const VIEW_TYPE_PROJECTS = "rslatte-projectpanel";
export const VIEW_TYPE_OUTPUTS = "rslatte-outputpanel";
export const VIEW_TYPE_CONTACTS = "rslatte-contactspanel";
export const VIEW_TYPE_FINANCE = "rslatte-financepanel";
export const VIEW_TYPE_HEALTH = "rslatte-healthpanel";
export const VIEW_TYPE_CHECKIN = "rslatte-checkinpanel";
export const VIEW_TYPE_HUB = "rslatte-hub";
export const VIEW_TYPE_TIMELINE = "rslatte-stats-timeline";
export const VIEW_TYPE_CALENDAR = "rslatte-calendar";

/** V2 工作流：统一快速记录页 */
export const VIEW_TYPE_CAPTURE = "rslatte-capture";
/** V2 工作流：今日执行页 */
export const VIEW_TYPE_TODAY = "rslatte-today";
/** V2 知识沉淀与输出页（输出+发布串联） */
export const VIEW_TYPE_KNOWLEDGE = "rslatte-knowledge";
/** V2 知识库 · 独立侧栏（与工作台 Knowledge 同 UI，不同 VIEW_TYPE 便于并排） */
export const VIEW_TYPE_KNOWLEDGE_PANEL = "rslatte-knowledge-panel";
/** V2 统一回顾页 */
export const VIEW_TYPE_REVIEW = "rslatte-review";

// --- V2 工作流页面 ID（统一入口导航用，与现有 viewTypes 映射）---
export type WorkflowViewId = "capture" | "today" | "projects" | "review" | "knowledge" | "worklog";

/** Hub / 工作流条按钮顺序：快速记录、今天、项目、回顾、知识、操作日志 */
export const WORKFLOW_VIEW_IDS: WorkflowViewId[] = [
  "capture",
  "today",
  "projects",
  "review",
  "knowledge",
  "worklog",
];

/** V2 工作流 ID → 视图类型（worklog → 操作日志时间轴） */
export const WORKFLOW_TO_VIEW_TYPE: Record<WorkflowViewId, string> = {
  capture: VIEW_TYPE_CAPTURE,
  today: VIEW_TYPE_TODAY,
  projects: VIEW_TYPE_PROJECTS,
  review: VIEW_TYPE_REVIEW,
  knowledge: VIEW_TYPE_KNOWLEDGE,
  worklog: VIEW_TYPE_TIMELINE,
};

export const WORKFLOW_VIEW_LABELS: Record<WorkflowViewId, string> = {
  capture: "快速记录",
  today: "今天",
  projects: "项目",
  review: "回顾",
  knowledge: "知识",
  worklog: "操作日志",
};