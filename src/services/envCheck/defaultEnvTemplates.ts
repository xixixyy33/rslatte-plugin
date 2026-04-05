/**
 * 插件「一键创建缺失模板」使用的缺省正文，与标准库路径
 * `00-System/01-Templates/t_*.md` / `t_project_canvas.canvas` 对齐。
 */

export const ENV_DEFAULT_DAILY_MD = `---
status: in-progress
type: diary
tags:
  - have_task
---

---
# 碎碎念
---
### 📚 今天学了什么？ 



### 💡 今天的想法 



### 🔗 与知识库的连接 



### ✅ 今天开展的工作




---
# 操作日志
---
## 打卡记录

## 财务记录

---
# 任务追踪
---
## 新增任务

## 新增提醒

## 新增日程

---
# 进度更新
---
## 项目进度

## 输出进度


`;

export const ENV_DEFAULT_WEEKLY_MD = `---
status: done
type: weekly
tags:
  - have_task
---
## 🌤 本周概览
- 本周核心结论：
- 本周整体状态：顺畅 / 忙乱 / 偏离 / 恢复中
- 本周完成度自评：★☆☆☆☆ ~ ★★★★★

## 📊 本周关键数据



## ⚠️ 本周主要问题


## 🔍 本周高价值事件


## 🎯 下周计划


## 📝 复盘一句话
`;

export const ENV_DEFAULT_MONTHLY_MD = `---
status: done
type: monthly
tags:
  - have_task
---
## 🌍 本月概览
- 本月关键词：
- 本月整体评价：稳定推进 / 压力较大 / 节奏失衡 / 明显进步
- 本月满意度：★☆☆☆☆ ~ ★★★★★

## 📊 本月关键数据


## 🏆 本月最重要的进展


## ⚠️ 本月主要问题与模式


## 📈 本月趋势判断


## 🎯 下月重点


## 📝 阶段总结
`;

export const ENV_DEFAULT_QUARTERLY_MD = `---
status: done
type: seasonly
tags:
  - have_task
---
## 🧭一、本季度概览  
  
### 1. 季度关键词  
- 关键词1：  
- 关键词2：  
- 关键词3：  
  
### 2. 一句话总结  
> 用 1~2 句话概括本季度整体表现、重点变化和总体状态。  
  
### 3. 总体评价  
- 完成度：{{高 / 中 / 低}}  
- 工作节奏：{{稳定 / 偏忙 / 失衡}}  
- 状态评价：{{良好 / 一般 / 需调整}}  
  
---  
  
## 🏆二、本季度核心成果  
  

  
## 📌三、关键项目进展  
  
  

## 📊四、数据复盘  
  

## ✨五、亮点与经验  

  
## ⚠️六、问题与风险  

  

## 🔭七、下季度计划  
  


`;

export const ENV_DEFAULT_PROJECT_INFO_MD = `---
type: project
project_id:
project_name:
status:
start:
due:
done:
create:
tags:
  - project
---
`;

export const ENV_DEFAULT_PROJECT_TASKLIST_MD = `---
type: project
project_id:
project_name:
tags:
  - project
  - have_task
---
`;

/** Obsidian Canvas 空白文件最小合法 JSON */
export const ENV_EMPTY_CANVAS_JSON = `{}`;

/** 非 Canvas 时的项目分析模板兜底（用户自定义为 .md 等时） */
export const ENV_FALLBACK_PROJECT_ANALYSIS_MD = `# 项目分析图

> 可替换为 Canvas / Excalidraw 或嵌入白板链接。

`;
