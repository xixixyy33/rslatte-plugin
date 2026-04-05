# 快速记录（Capture）

## 概述

**Capture（快速记录）** 是 V2 工作流中的统一速记页：用 **一条输入** 承接想法，再分流为 **今日任务**、**待整理（Inbox 文件）**，或通过 **三合一整理** 落成 **任务 / 提醒 / 日程**。另提供 **「专注」** 子页签：即时计时、可关联任务或输出，结束后按片段 **生成日程**。

- 视图类型：**`rslatte-capture`**  
- 实现类：**`CaptureView`**（`src/ui/views/CaptureView.ts`）  
- 待整理落盘与归档逻辑：**`journalWriter`** 中 **`appendCaptureInbox`** / **`listCaptureInboxItems`** / **`refreshCaptureInbox`** / **`maybeArchiveCaptureFile`** 等（`src/plugin/journalWriter.ts`）

## 如何打开

- **命令**：`rslatte-capture-open`（**「打开侧边栏：快速记录」**）  
- **Hub**：工作流 **「快速记录」** → **`activateWorkflowView("capture")`**（与命令等价）  
- **URI**（见 `main.ts` 中 `moduleMap`）：`obsidian://rslatte-open?module=快速记录`  

**外部跳转**：例如象限布局里从 **Today「今日执行」统计** 打开 Capture 时，会调用 **`openRecordTabFromExternal()`**，保证落在 **「记录」** 子页签而非「专注」。

## 子页签

| 子页签 | 作用 |
|--------|------|
| **记录** | 输入框、主操作按钮、待整理时间轴、三合一入口 |
| **专注** | 即时计时（开始 / 暂停 / 继续 / 结束 / 重置）、显示模式切换、暂停/继续事件日志 |

打开侧栏时若计时状态为 **running**，会自动 **转为 paused**（写入一条 pause 事件），避免后台误跑。

## 「记录」页：输入与快捷键

- **占位提示**：「输入一条待办、想法或记录…」  
- **Enter（不按 Shift）**：等价点击 **「待整理」**，将当前内容写入 Inbox（见下节）。  
- **Shift+Enter**：换行（默认 textarea 行为）。

## 「记录」页：三条主路径

### 1. ☀️ 今日任务

将输入全文写入 **当日日记** 下的 **今日任务**（与任务模块一致），使用 **`getTaskTodayKey(taskPanel)`** 作为「今日」键，与 **Today / Inbox 统计** 口径对齐，避免与纯日历日错位。

成功后走 **`EXECUTION_RECIPE.tripleSaveTask`**（索引刷新、可选 DB 同步、WorkEvent 等），并清空输入框。

### 2. 待整理

将一行追加到 **Inbox 目录** 下、按 **日期文件名** 命名的 Markdown 文件中，行格式为：

`- [ ] <正文> ➕ YYYY-MM-DD`

新文件会带标题 **`## 待整理`**。不依赖「日记路径」配置，只依赖 **`captureModule.captureInboxDir`** 与 **`captureInboxFileNameFormat`**。

### 3. 🗃️ 整理（三合一）

打开 **`CaptureQuickAddModal`**：可从当前输入（或 **带类型推荐**）创建 **任务 / 提醒 / 日程**。从 **待整理某一行** 点 🗃️ 时，会带上 **`sourceInboxRef`**，成功整理后可将该行标为完成（与模态内逻辑一致）。

**➕ 三合一新增**（顶栏）：打开同一模态，**不**预先记一条「打开整理」类 Capture WorkEvent（与工具栏 🗃️「带推荐」略有分工，见源码注释）。

**类型推荐**：**`recommendCaptureItemType`**（`src/services/capture/captureTypeRecommendation.ts`）结合内置规则与设置中的 **`captureTypeRecommendationDict`**（强/弱关键词表，可在设置里 JSON 覆盖）。

## 待整理时间轴

- **↻ 刷新**：调用 **`refreshCaptureInbox`**（扫描 Inbox 目录下 `.md`，对满足条件的文件 **归档**），再刷新侧栏并重绘列表。  
- **展示过滤**：由 **`captureShowStatuses`** 控制是否显示 **todo / done / cancelled / paused**（默认：待办与 paused 显示，已完成/已取消默认隐藏）。** backlog 数量** 与列表 **同一口径**。  
- **每条操作**：  
  - **☀️**：转 **今日任务**（创建任务后将该行标为 `[x]`）  
  - **🗃️**：用该行正文打开三合一整理（带推荐）  
  - **⛔**：标为 **取消**（`[-]`）  

行内勾选状态还支持 **`[/]`（暂不处理）** 等（由 **`updateCaptureInboxLine`** 实现）；列表是否显示取决于设置。

列表按 Inbox 目录内 **所有 .md** 扫描，日期前缀优先来自行尾 **`➕ YYYY-MM-DD`**，否则尝试从 **文件名** 按 `captureInboxFileNameFormat` 解析。

## Inbox 归档

**`maybeArchiveCaptureFile`** 在以下情况后可能被调用：刷新 Inbox、将行标为 `[x]` 或 `[-]` 等。

归档条件（需 **同时** 满足）：

1. 文件名按 **`captureInboxFileNameFormat`** 能解析出日期，且该日期 **早于** 当前 **`getTaskTodayKey`**（即「文件日」已过去）。  
2. 文件内 **不再存在** `[ ]` 或 `[/]` 行（无未完成、无「暂不处理」）。

满足则将整文件移到 **`captureArchiveDir`**（默认 `90-Archive/10-Personal/17-Inbox/` 一类路径，以设置为准），重名则自动加后缀。

## 「专注」子页签

1. **⏳ 开始**：打开 **`CaptureTimerStartModal`**，填写专注说明，可选 **关联任务**（从任务侧栏分组 + 活跃项目任务拉取）或 **关联输出**（未完成/进行中输出项）。  
2. **运行中**：**⏸ 暂停**、**⏹ 结束并生成日程**、**重置**（确认后清空状态，需重新 ⏳ 开始）。  
3. **暂停中**：**▶ 继续**、**⏹ 结束**、**重置**。  
4. **结束**：**`CaptureTimerFinishModal`** 将计时切段（默认 **30 分钟** 粒度片段，过短会提示无法生成日程），为每段填写/确认日程文案、日期、开始时间、时长、分类与重复规则等，通过 **`writeScheduleCreate`** 与统一编排写入。

计时状态持久化在 **`settings.captureModule.captureInstantTimerState`**（随 **`saveSettings`** 保存）。

**显示样式**：顶栏下拉 **数字时钟 / 钟表形式**，与 **设置 → 快速记录** 中的 **`captureTimerDisplayMode`** 同步。

专注相关操作会经 **`buildCaptureWorkEventUi`** 记入 **WorkEvent**（操作日志中可见「快速记录」类条目）。

## 设置项摘要（`captureModule`）

| 项 | 含义 |
|----|------|
| **`captureInboxDir`** | 待整理 `.md` 所在目录（默认 `10-Personal/17-Inbox`） |
| **`captureInboxFileNameFormat`** | 文件名日期格式（默认 `YYYYMMDD` → 如 `20260405.md`） |
| **`captureArchiveDir`** | Inbox 归档目录 |
| **`captureShowStatuses`** | 时间轴中展示哪些勾选状态 |
| **`captureTimerDisplayMode`** | `digital` / `clock` |
| **`captureInstantTimerState`** | 专注计时运行时状态（一般无需手改） |
| **`captureTypeRecommendationDict`** | 三合一打开时的关键词推荐表（可选） |

以上字段在 **多空间** 下属于 **空间级快照**（见 [空间与索引](空间与索引.md)）；换空间后 Inbox 目录可能指向另一套路径，需在 **设置 → 快速记录** 中分别配置。

## 与其他入口的区别

| 入口 | 差异 |
|------|------|
| **今天（Today）** | 聚合今日执行 / 核对 / 记录，不是单条速记表单；统计里可跳转 Capture 或读 Inbox 数量。 |
| **今日打卡侧栏** | 打卡、财务、健康、日记子窗口等 **当日面板**，不承担 Capture 的 Inbox 与三合一流程。 |
| **任务侧栏** | 任务/提醒/日程的 **主工作台**；Capture 是 **更轻的入口**，写完仍可落到同一索引体系。 |

## 延伸阅读

- [《用户手册》](../用户手册.md) — 「Capture（快速记录）」  
- [今天-Today](今天-Today.md) — 执行统计中与 Inbox 的联动  
- [空间与索引](空间与索引.md) — `captureModule` 按空间隔离  
- [操作日志](操作日志.md) — WorkEvent 中的 capture 类事件  

**源码锚点**：`src/ui/views/CaptureView.ts`、`src/ui/modals/CaptureQuickAddModal.ts`、`src/ui/modals/CaptureTimerStartModal.ts`、`src/ui/modals/CaptureTimerFinishModal.ts`、`src/plugin/journalWriter.ts`、`src/services/capture/captureTypeRecommendation.ts`、`src/services/execution/taskWriteFacade.ts`。
