export type CaptureItemType = "memo" | "task" | "schedule";

export type CaptureTypeRecommendationDict = {
  scheduleStrong: string[];
  scheduleWeak: string[];
  memoStrong: string[];
  memoWeak: string[];
  taskStrong: string[];
  taskWeak: string[];
};

export type CaptureTypeRecommendation = {
  type: CaptureItemType;
  scores: Record<CaptureItemType, number>;
  confidence: number;
  reasons: string[];
};

export const DEFAULT_CAPTURE_TYPE_RECOMMENDATION_DICT: CaptureTypeRecommendationDict = {
  scheduleStrong: ["开会", "会议", "复盘", "约见", "面试", "拜访", "会谈", "课程", "值班"],
  scheduleWeak: ["今天", "明天", "后天", "本周", "下周", "下午", "晚上"],
  memoStrong: ["提醒我", "记得", "别忘", "不要忘", "到时提醒", "生日", "纪念日"],
  memoWeak: ["复查", "取快递", "续费", "到期", "过期", "稍后", "晚点"],
  taskStrong: ["整理", "跟进", "提交", "推进", "完成", "修复", "开发", "实现", "评审"],
  taskWeak: ["周报", "报销", "合同", "方案", "文档", "待办", "todo"],
};

type RegexRule = {
  type: CaptureItemType;
  score: number;
  pattern: RegExp;
  reason: string;
};

const RULES: RegexRule[] = [
  // 日程：强调“时间点 + 时间段 + 会议类事件”
  { type: "schedule", score: 7, pattern: /\b([01]?\d|2[0-3])[:：][0-5]\d\b/, reason: "包含明确时间（HH:mm）" },
  { type: "schedule", score: 6, pattern: /((上午|中午|下午|晚上)?\s*\d{1,2}\s*点(\d{1,2}分)?)/, reason: "包含具体钟点" },
  { type: "schedule", score: 5, pattern: /(开会|会议|复盘|约见|面试|拜访|会谈|课程|上课|值班)/, reason: "包含事件安排语义" },
  { type: "schedule", score: 3, pattern: /(明天|后天|今晚|明早|明晚|周[一二三四五六日天]|下周|本周)/, reason: "包含相对日期语义" },

  // 提醒：强调“别忘/记得/到时通知”
  { type: "memo", score: 8, pattern: /(提醒我|提醒下|提醒一下|记得|别忘|不要忘|到时提醒)/, reason: "包含提醒意图词" },
  { type: "memo", score: 5, pattern: /(复查|取快递|生日|纪念日|周年|续费|缴费|到期|过期)/, reason: "包含提醒高频场景词" },
  { type: "memo", score: 3, pattern: /(稍后|晚点|过会|回头)/, reason: "包含轻提醒语义" },

  // 任务：强调“推进、交付、完成”
  { type: "task", score: 7, pattern: /(整理|跟进|提交|推进|完成|修复|开发|编写|实现|对齐|评审|处理|排查|梳理)/, reason: "包含推进/完成动作词" },
  { type: "task", score: 5, pattern: /(周报|报销|合同|方案|PR|代码|文档|清单|材料|计划)/i, reason: "包含交付对象词" },
  { type: "task", score: 3, pattern: /(待办|todo|to-do|办一下)/i, reason: "包含待办语义" },
];

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function scoreByPatterns(text: string): {
  scores: Record<CaptureItemType, number>;
  reasonsByType: Record<CaptureItemType, string[]>;
} {
  const scores: Record<CaptureItemType, number> = { memo: 0, task: 0, schedule: 0 };
  const reasonsByType: Record<CaptureItemType, string[]> = { memo: [], task: [], schedule: [] };
  for (const rule of RULES) {
    if (!rule.pattern.test(text)) continue;
    scores[rule.type] += rule.score;
    reasonsByType[rule.type].push(rule.reason);
  }
  return { scores, reasonsByType };
}

function normalizeDict(dict?: Partial<CaptureTypeRecommendationDict> | null): CaptureTypeRecommendationDict {
  const ensure = (arr: unknown, fallback: string[]): string[] =>
    Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : fallback;
  const d = dict ?? {};
  return {
    scheduleStrong: ensure(d.scheduleStrong, DEFAULT_CAPTURE_TYPE_RECOMMENDATION_DICT.scheduleStrong),
    scheduleWeak: ensure(d.scheduleWeak, DEFAULT_CAPTURE_TYPE_RECOMMENDATION_DICT.scheduleWeak),
    memoStrong: ensure(d.memoStrong, DEFAULT_CAPTURE_TYPE_RECOMMENDATION_DICT.memoStrong),
    memoWeak: ensure(d.memoWeak, DEFAULT_CAPTURE_TYPE_RECOMMENDATION_DICT.memoWeak),
    taskStrong: ensure(d.taskStrong, DEFAULT_CAPTURE_TYPE_RECOMMENDATION_DICT.taskStrong),
    taskWeak: ensure(d.taskWeak, DEFAULT_CAPTURE_TYPE_RECOMMENDATION_DICT.taskWeak),
  };
}

function scoreByDictionary(
  text: string,
  dict: CaptureTypeRecommendationDict,
  scores: Record<CaptureItemType, number>,
  reasonsByType: Record<CaptureItemType, string[]>
): void {
  const apply = (
    type: CaptureItemType,
    words: string[],
    scoreEach: number,
    label: string
  ) => {
    for (const w of words) {
      if (!w || !text.includes(w)) continue;
      scores[type] += scoreEach;
      reasonsByType[type].push(`${label}词命中：${w}`);
    }
  };
  apply("schedule", dict.scheduleStrong, 5, "日程强");
  apply("schedule", dict.scheduleWeak, 2, "日程弱");
  apply("memo", dict.memoStrong, 5, "提醒强");
  apply("memo", dict.memoWeak, 2, "提醒弱");
  apply("task", dict.taskStrong, 5, "任务强");
  apply("task", dict.taskWeak, 2, "任务弱");
}

function applyConflictAdjustments(
  text: string,
  scores: Record<CaptureItemType, number>,
  reasonsByType: Record<CaptureItemType, string[]>
): void {
  // 同时命中提醒与日程时，若存在明确时间，优先日程；否则偏提醒
  const hasExactTime = /\b([01]?\d|2[0-3])[:：][0-5]\d\b/.test(text) || /((上午|中午|下午|晚上)?\s*\d{1,2}\s*点(\d{1,2}分)?)/.test(text);
  const hasReminderIntent = /(提醒我|记得|别忘|不要忘|到时提醒)/.test(text);
  if (hasExactTime && hasReminderIntent) {
    scores.schedule += 2;
    reasonsByType.schedule.push("提醒语句中带具体时间，偏日程");
  } else if (!hasExactTime && hasReminderIntent) {
    scores.memo += 2;
    reasonsByType.memo.push("提醒语句无具体时间，偏提醒");
  }

  // 带“完成/提交”等交付动作时，提高任务分，避免被普通时间词误导
  if (/(完成|提交|推进|修复|实现|跟进)/.test(text)) {
    scores.task += 2;
    reasonsByType.task.push("包含交付动作，偏任务");
  }
}

function pickBest(scores: Record<CaptureItemType, number>): {
  best: CaptureItemType;
  second: CaptureItemType;
} {
  const rank: CaptureItemType[] = ["task", "memo", "schedule"];
  const sorted = [...rank].sort((a, b) => scores[b] - scores[a] || rank.indexOf(a) - rank.indexOf(b));
  return { best: sorted[0], second: sorted[1] };
}

function calcConfidence(best: number, second: number, total: number): number {
  if (total <= 0) return 0.35;
  const gap = Math.max(0, best - second);
  // 基于“领先差值 + 领先占比”估计置信度
  const byGap = gap / 10;
  const byShare = best / total;
  return clamp01(0.25 + byGap * 0.45 + byShare * 0.4);
}

export function recommendCaptureItemType(
  rawText: string,
  dict?: Partial<CaptureTypeRecommendationDict> | null
): CaptureTypeRecommendation {
  const text = String(rawText ?? "").trim();
  const mergedDict = normalizeDict(dict);
  if (!text) {
    const scores: Record<CaptureItemType, number> = { memo: 0, task: 1, schedule: 0 };
    return { type: "task", scores, confidence: 0.35, reasons: ["空文本，默认推荐任务"] };
  }

  const { scores, reasonsByType } = scoreByPatterns(text);
  scoreByDictionary(text, mergedDict, scores, reasonsByType);
  applyConflictAdjustments(text, scores, reasonsByType);
  const { best, second } = pickBest(scores);
  const total = scores.memo + scores.task + scores.schedule;
  const confidence = calcConfidence(scores[best], scores[second], total);

  // 无规则命中时兜底：有时间词倾向日程；有提醒词倾向提醒；否则任务
  if (total <= 0) {
    if (/(今天|明天|后天|周[一二三四五六日天]|\d{1,2}[:：]\d{2})/.test(text)) {
      scores.schedule += 2;
      return { type: "schedule", scores, confidence: 0.4, reasons: ["仅命中弱时间线索，暂推荐日程"] };
    }
    if (/(提醒|记得|别忘|不要忘)/.test(text)) {
      scores.memo += 2;
      return { type: "memo", scores, confidence: 0.4, reasons: ["仅命中弱提醒线索，暂推荐提醒"] };
    }
    scores.task += 2;
    return { type: "task", scores, confidence: 0.4, reasons: ["未命中明显规则，默认推荐任务"] };
  }

  return {
    type: best,
    scores,
    confidence,
    reasons: reasonsByType[best].slice(0, 3),
  };
}
