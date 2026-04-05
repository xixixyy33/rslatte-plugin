# RSLatte Plugin 代码地图（CODE_MAP）

> **用途**：供 AI/开发者快速定位业务对应代码路径，减少全量扫描与 token 消耗。  
> **维护**：优先维护「功能小节路径清单」准确；「最后更新」按天记录，每天最多一行，仅登记阶段性/结构性改动。  
> **文档权威**：索引/Pipeline/归档等**技术事实**以 **本文** 与 **`docs/V2改造方案/`**（如《索引优化方案》）为准；**`docs/用户手册.md`** 可能滞后，**勿**作为主要参考。  
> **新索引落盘默认**：**按空间** `…/<spaceId>/index`（`spaceContext.resolveSpaceIndexDir`）；**仅**全库元数据等特殊需求用中央根（`knowledge-index`、`spaces-index` 类），见《索引优化方案》§7.14。

**最后更新（按天）**：
- 2026-04-03：**一键工作区**：**`quadrantWorkspaceLayout.ts`**（四象限：`createLeafBySplit(..., "horizontal")` 上下两行 + **`getLeaf("tab")`** 页签；**`applyBundledWorkspaceLayout.ts`** 入口）；ribbon 随核心「工作区」显隐（**`main.syncRslatteWorkspaceLayoutRibbon`**）；**`obsidianCorePluginGate`** + **`pluginEnvCheck`** / **`PluginEnvCheckModal`**；命令 **`rslatte-load-bundled-workspace`** / 别名 **`rslatte-apply-recommended-workspace`**；可选 **`rslatte-workspace-preset.json`**（构建复制，非主路径）。
- 2026-04-02：**§8.7**《代码结构优化方案》：`utils/archiveBatchYield.ts`（`yieldIfArchiveBatchBoundary`）；`projectManager/service.ts` **`archiveDoneAndCancelledNow`**、`main.ts` **`archiveContactsNow`** 可选 **`batchLimit`**（每 N 次成功 rename 后 rAF/setTimeout 让出）；**`isDebugLogEnabled`** 下 **`perf`**：`rename phase` / `move phase`（moved、耗时、skipped/reason）。见方案 **§5.4**「归档批操作」。
- 2026-04-01：**§8.6** CODE_MAP §3.11「各 `*IndexStore` 与 indexJsonIo」勾选表 + `indexJsonIo.ts` 文件头约束；列未迁移的 `adapter.write` 索引。**§8.5 联系人** `contactsSpecAtomic` 文件头 + `listAllPaths`/`buildOps`/`flushQueue`/`rebuildActiveOnlyIndexes` 注释；`main.listAllContactMdPathsForDbSync`；`rebuildScopeSemantics.contacts.notes`。**§8.4 输出** `types/outputTypes.ts` 文件头 + `outputRefreshScanPlan.ts` + `service.refreshIndexNow` 接线；`outputSpecAtomic` / `outputHistoryLedger` 注释链到《索引优化方案》§10.6。**§8.3** `projectManager/projectStatus.ts`（`normalizeProjectStatus`、`getRecoverProjectTransition`、侧栏分区/isClosed/风险/衍生共用）。**§8.2** `pipeline/helpers/archiveOrchestration.ts`（`runContactsPreArchiveEnsureMainIndex` / `runContactsPostPhysicalArchiveSteps`、`runOutputPreArchiveRefreshIndexFull` / `runOutputPostPhysicalArchiveRefresh`、`runProjectPostPhysicalArchiveSteps`）。**§8.1 Pipeline** `rebuildScopeSemantics.ts`（`PIPELINE_REBUILD_ACTIVE_ONLY` / `PIPELINE_REBUILD_AFTER_PHYSICAL_ARCHIVE`、`PIPELINE_ATOMIC_REBUILD_SCOPE_REGISTRY`）；`specRegistry` re-export；`contactsSpecAtomic` **`rebuildActiveOnlyIndexes`**；`project`/`output` Atomic 注释对齐。**项目** `status=pending_archive` + `pending_archive_at`；侧栏「待归档」区与 🗄 标记；`archiveDoneAndCancelledNow` 仅搬 **待归档/已取消** 超阈值（已完成不自动搬）；`archiveProjectIndexByMonths` 同步；`refreshAll` 仍不扫 `projectArchiveDir`。**联系人** Pipeline `rebuild`/`contactsSpecAtomic` 仅 `rebuildAndWrite`（不扫归档目录）；笔记归档后 `rebuildContactsAllIndexes`。**UI/文案**：「备忘→提醒」；「今日打卡」侧栏与工作流条；「RSLatte 工作台」统一展示（删 `DashboardView`，Hub 双灯/KPI/告警区、`SpaceHubView`/`statusCalculationService`/`styles.css`，见《空间管理优化方案》§9）。**Review**：`grain: quarter`、`reviewIndexMerge` 归档拼周期、`reviewPeriodSnapshotStore`、季报 `buildReviewPeriodReportsBundle`、`quarterlyJournalPanels` 等。**[X-JSON-IO]**：`internal/indexJsonIo` → task/record/output/project/contacts 各 `indexStore`（《索引优化方案》§8）。**[X-Pipeline]**：`schedule` 自动 `runE2`；**coordinator 单轨 `runE2`**（删 `AUTO_PIPELINE_ROUTE`/`engine.run` 分支）；《索引优化方案》**§7.0.2**；`tagsDerivedForYmd` 契约（§7.2.1）；§3.11；**project** legacy **`incrementalRefresh` → `USE_ATOMIC_SPEC`**，`projectSpecAtomic.applyDelta` 补 **`writeTodayProjectProgressToJournal`**。**[X-归档]**：§1.2～1.3、§3.11、文首文档权威；不维护用户手册归档专节。**《索引优化方案》§10 / §10.5 / §10.6**：`rebuild` 主链路；记录类 **`scanAllDiaryDates`**；任务域 **`getTaskScanFolders()`**；输出 **台账合并 + 索引时间窗归档**。**Hub/统计 续**：财务/健康分析告警读 **`spaceId`**、告警 Alt 定位与按空间页签、`.rslatte-hub-card-active`；`spaceStats` 提醒 O/U、日程 H/E、`schedule`+`health`、`countMobileOpsPending`/`hubJournalSnapshot`。**衍生索引** 与主索引触发：《记录类管理优化方案》「衍生索引刷新契约」；§3.6-1/3.7 Pipeline 行。**模块启用同源（§0.4）**：`pipelineModuleEnabled.ts`；`ensureAutoRefreshCoordinator`；`main.isPipelineModuleEnabled`；`spaceStats`；财务 `?? false`；**Review 执行** `buildReviewExecuteModel` 门控。**Pipeline 双轨收敛**：删 **`autoRefreshIncrementalAndMaybeSync`**（插件 API）、**`ProjectManager.autoRefreshIncrementalAndSync`**；统一 **`runAutoRefreshTick`**。**归档用语**：§3.11.1（**笔记归档** / **索引归档** / **日记按月**）。
- 2026-03-31：**健康**：`healthPanel.targetWeightKg` / **`targetWaistCm`（默认 75）**、`healthWeightTrendChart.ts`（体重日卡 / 腰围周卡趋势 + 目标虚线；`collectWeekWaistSeries`）；`renderHealthSettings`。**Pipeline**：`healthSpecAtomic.applyDelta` 与 `financeSpecAtomic` 对齐，empty/有增量均写 `health-analysis`（`writeHealthAnalysisAlertIndex` + `writeHealthAnalysisSnapshotsAndIndex`）。**Review 记录 C 分析报告**：`reviewRecordsSummaryAnalysis.ts`（打卡履行率/连续度/难度建议；财务 `finance-analysis` 诊断+本周期告警；健康达标+月规则告警行；日记面板有意义字环比）；并入 `buildReviewRecordsModel`；**Review 记录 C**：「C 记录摘要」下分四小节（`reviewRecordsRender`、`styles.css` `.rslatte-review-records-subsection`）。**Review 记录页版式**：`reviewRecordsRender` 本页侧重 + A～D 与执行/核对同系；`REVIEW_RECORDS_TIMELINE_MAX`/`timelineSampleCap`；`reviewRecordsModel` 纪要含健康去重日；方案 §4.6.2。**Review 核对扩展（仍无开放清单）**：`reviewReconcileModel` 增加 **提醒** memoDate 及时性、**项目完结**（快照 `done`∈周期）、输出 **长周期完成**（创建→完成≥21 天）、日志 **发布/联系人事件** 与环比；`reviewReconcileRender` A/B/C 同步。**Review 核对页收敛**：`reviewReconcileModel`/`reviewReconcileRender` **仅** A 及时性（已闭环）+ B 环比（完成/新建）+ C 启发式建议；移除 `contactFollowUps`、`unclosed`、`risk`、`outputsMissingId` 等（方案 §4.5 续 15）。**Review 执行页版式**：**A 总览** 改为单行 `✅/⏩/➕/📤` 指标（`overviewStrip`、`reviewWorkEventPeriodStats` 增 `tasksProgressEventCount`/`outputsProgressEventCount`/`projectProgressEventCount`/`projectsCreated`；C 区 `id=rslatte-review-exec-mod-*` 锚点滚动）→ **B 时间分析** → **C 分模块**（**无** 原 D 下周期承接块）；`reviewExecuteRender`、`styles.css`；方案 §4.3b/§4.4。**C 区日程**：`scheduleModuleBlock` + `renderScheduleModuleSection`（周期内完成/新建/完成日晚于计划结束；**仅展示本周期有完成条目的分类** × 条数与可解析时长，`labelForScheduleCategoryId`）。**C 区项目**：`projectModuleBlock` + `renderProjectModuleSection`；**有进展**列表展示 `projectProgressRecentByKey` 每项目至多 3 条 WorkEvent 摘要；已去掉「缺一级下一步」计数与 D 桥接句。**C 区输出**：`outputModuleBlock`/`renderOutputModuleSection`，**新建**为索引 `createDate` 周期内条数（与 A 区 `➕` 的 WE 新建可不一致）；不再展示索引与日志差。**C 区联系人**：`contactModuleBlock`/`renderContactModuleSection`；`contactSamples` 在 `reviewWorkEventPeriodStats` 内按 `contact_uid`/`file_path` **每人仅保留最新一条**后再取至多 3 条。
- 2026-03-31：**Review** §4.3a + **§4.3b** + **§4.3c/§4.10** + **§4.4 执行子页签全量** + **§4.2.2 刷新/历史快照**（`reviewPeriodSnapshotStore`：`.completed.json` E2 封印；**`reviewE2SnapshotSeal`** ← **`pipelineManager.runAutoRefreshTick`**；`reviewPeriodCoverage` / **`ReviewHistorySnapshotModal`**；**`reviewWorkEventPeriodStats.ts`**：`contactSamples`；**`reviewExecuteModel`**（`grain`、日程仅「工作量」区、**`reviewExecuteScheduleViz`** 周栅格/月热力/按天堆叠柱；**工时**：`tasksDoneEstimateHours` + **`projectTasksDoneEstimateHours`**）+ **`reviewExecuteRender`**（含 **`taskHoursDetail`** 任务工时全宽色条+分类悬停 Top3）；方案见 `Review侧边栏优化方案.md`）+ `reviewReconcile*`、`activateReviewView`、记录 C/D、`styles.css` Review 工具条/横幅/弹窗/日程图。**周期简报**（日志管理、`weeklyJournalPanels`/`monthlyJournalPanels` 与 `journalPanels` 分离、`periodReportPaths.ts`、`ensureWeeklyOrMonthlyReportFile`、`periodReports`）；**记录页**「复制执行摘要」→ **`reviewExecutePlainTextForPaste`**（仅 A 总览 + C 分模块摘要 Markdown）+ `reviewRecordsRender`。**任务/项目任务标完成**须填 **estimate_h**（可改已有值）：`TaskProgressModal`/`ProjectTaskProgressModal`/`EditProjectTaskModal`（状态 DONE）、**`TaskSidePanelView`** 项目时间线 ✅ → `ProjectTaskProgressModal`；写回 **`applyTaskStatusWithProgress`** / **`setProjectTaskStatus(..., opts?)`**。
- 2026-03-30：**今日记录**顶栏四灯（`todayRecordsModel`/`todayRecordsRender`）；**今日核对**日程轨迹与日历泳道同源（`scheduleCalendarModel`/`recordReconcileRender`）、`openRecordLine`、项目任务·联系人互动与 WorkEvent 回写、打卡/财务清单按任务日；**健康**日记主行/`createdAtMs`·刷新 reconcile、九项合并与 `healthMetricsEnabled` 热力图（`healthCanonicalMetrics`/`RSLatteSidePanelView`/`MenstruationRangePickerModal`）、**健康统计** `health-analysis` 月快照与告警（`healthAnalysisAlertIndex`/`healthAnalysisIndex`，`healthSpecAtomic` 写入，`HealthSidePanelView` 统计页）。**Review** `ReviewView`：周期栏单行工具条；**记录**子页签 **`reviewRecordsModel` / `reviewRecordsRender`**（A 周期计数 + B WorkEvent 抽样轴；输出新增走 `outputRSLatte` 索引）；执行/核对仍为目录骨架。侧栏无「时间轴」链接（`Review侧边栏优化方案.md` §4.2 / §4.8 P1）。
- 2026-03-29：**时间与日历**（`localCalendarYmd`/`toIsoNow`）+ **今日核对**更新区跳转（`openRecordLine`：任务→`focusTaskRowByFileLine`、项目任务→`scrollToProject`）与 NA（`is_next_action_for_l1`/`buildProjectNextActionRecordLines`，`Today优化方案.md` §2.5）；**Capture Inbox**（`journalWriter.listCaptureInboxItems` TFolder 枚举、`todayExecuteStats` 今日新增归一、`execute_stats_inbox` 调试）；**今日核对·更新区** 任务/项目任务 WorkEvent `task_phase_*`、`todayReconcileZonesModel`/`recordReconcileRender.renderDayCardsForUpdateLines` 与 `styles.css` 两行卡片。
- 2026-03-28：**Review/UI 大收敛**：删月度统计与 `ActionsView`，Review 链任务+时间轴；`styles.css` 清理月度/行动样式并补统计设置空间表（`Review侧边栏优化方案.md`）。**侧栏** 任务三子页签，输出/Knowledge/Today 等卡片与弹窗收敛；**输出↔日程** `outputScheduleLinkFacade`、`RecordTaskScheduleModal`（output）、Capture 关联输出；Pipeline **`runE2`**、去 **`publishRSLatte`**。**索引** `tagsDerivedForYmd`+各 `*_tags`、`taskRSLatte`/`indexMerge`、Record 并入 Today。**项目** `applyProjectSnapshotDerivatives`/`milestone_tags`/`project_tags`→`project-index`。**Today** 执行清单+执行统计（`todayExecuteStats`、`Today优化方案.md` §1）、今日记录 §3；**日程日历** 重叠与角标（`dayHasScheduleTimeOverlap`）。**其它** `pluginEnvCheck`、`scrollToProject`+`ScrollToProjectNavOpts`、里程碑导航闪动。见 `代码结构优化方案.md`、`空间管理优化方案.md` §8。
- 2026-03-27：空间相关服务迁入 **`src/services/space/`**；空间管理落地（编号、目录默认值、新建空间落盘、`AddSpaceModal`）；知识库台账与 `output_status_changed` 等；输出侧栏「发布管理」重构为「历史发布清单」（搜索 / output_id + 最近发布 30 条）。
- 2026-03-26：知识类与输出链路阶段性收敛（知识侧栏/发布管理整合、发布与打回台账、模板管理与项目输出路径修复、CSV 批量导入、搜索交互优化、复制发布生成新 `output_id`）。
- 2026-03-25：财务索引重建语义与异常检测完善（含跨文件重复、时间轴定位、重建一致性）。
- 2026-03-24：联系人互动索引与归档机制增强，财务分析预警索引补齐，财务录入字段扩展。
- 2026-03-23：任务/日程/Capture 主流程增强（计时、推荐、卡片操作收纳、执行流账本），联系人交互首批落地。
- 2026-03-22：任务安排描述显示优化（联系人引用展平）。
- 2026-03-21：任务与日程关联定位能力首批落地。

---

## 1. 项目目录结构（简要）

```
rslatte-plugin/
├── src/                    # 源码（TypeScript）
│   ├── main.ts             # 插件主类、生命周期、视图/命令注册
│   ├── api.ts              # 后端 API 客户端
│   ├── plugin/             # 插件能力模块（mixin 注入；**`pipelineModuleEnabled.ts`**：`buildPipelineModuleIsEnabled` 与 `pipelineManager`/coordinator/`main.isPipelineModuleEnabled` 同源 §1.1）
│   ├── constants/          # 常量（viewTypes、defaults、space）
│   ├── internal/           # 内部复用（**`indexJsonIo.ts`**：各 *IndexStore 统一 JSON 读写 **[X-JSON-IO]**）
│   ├── types/              # 类型定义
│   ├── utils/              # 工具函数
│   ├── ui/                 # 界面：views、modals、settings、helpers
│   ├── services/           # 业务服务与 Pipeline（空间相关见 **`services/space/`**）
│   ├── taskRSLatte/        # 任务/提醒：索引、同步、归档
│   ├── projectManager/     # 项目管理
│   ├── projectRSLatte/     # 项目同步队列等
│   ├── outputRSLatte/      # 输出文档管理
│   ├── recordRSLatte/      # 打卡/财务记录索引与同步
│   ├── contactsRSLatte/    # 联系人索引与服务
│   └── rslatteSync/        # 同步：scanPipeline、reconcile、upsertFlusher
├── docs/                   # 文档（含本 CODE_MAP；V2 方案目录 `docs/V2改造方案/`，索引机制总册见 **`索引优化方案.md`**）
├── build.js                # 构建脚本（esbuild）
├── sync-release.js         # 发布同步脚本
├── styles.css              # 插件样式
├── manifest.json           # Obsidian 插件清单
├── main.js / main.js.map   # 构建产物（勿直接编辑）
├── rslatte-workspace-preset.json  # 工作区 changeLayout 预设（由 build.js 从 src/plugin 复制）
└── package.json
```

---

## 2. 入口与插件装配

| 职责 | 路径 |
|------|------|
| 插件主类、onload/onunload、全局服务初始化、视图与命令注册 | `src/main.ts` |
| 各能力模块统一挂载（space、ui、core、journal、output、record、pipeline、mobile） | `src/plugin/index.ts` → `createAllModules()` |
| 各模块实现（按需查阅） | `src/plugin/spaceManagement.ts`, `core.ts`, `uiNavigation.ts`, `journalWriter.ts`, `outputManager.ts`, `recordSync.ts`, `pipelineManager.ts`, `mobileSync.ts`, `contactsHandler.ts`, `pluginHelpers.ts` |

---

## 3. 业务功能 → 代码路径清单

按「功能域」列出主要文件，便于按功能优化时只读相关路径。

### 3.1 任务（Task）

| 角色 | 路径 |
|------|------|
| 服务入口、索引/同步/归档 | `src/taskRSLatte/service.ts`（含 **`findTaskByUid`** / **`findScheduleByUid`**（侧栏跳转定位）；**`markMemoAsArrangedAfterDerivation`**：安排后 DONE + meta `arranged_task_uid` / `arranged_schedule_uid`；**`applyMemoStatusAction`** 支持 `skipPeriodicReschedule` 避免周期提醒误生成下一条） |
| 任务列表解析、元数据 | `src/taskRSLatte/parser.ts` |
| 索引存储、定位、同步队列、归档、键与类型 | `src/taskRSLatte/indexStore.ts`（**`readIndex`/`writeIndex`**：`task` / `memo` / **`schedule`** → **`schedule-index.json`**；合并保留 **`tagsDerivedForYmd`** 等根字段）, **`indexMerge/`**（task/memo/schedule 索引衍生与日程按文件合并）, **`task/`** / **`memo/`** / **`schedule/`**（各类型标签与分类，各含 **`index.ts`** 汇总导出）, **`shared/`**（**`metaWriter`**：uid/tid/mid、**`appendLinkedScheduleUidToTaskMeta`** 等）, `indexLocator.ts`, `syncQueue.ts`, `archiver.ts`, `keys.ts`, **`types.ts`**（**`RSLatteIndexFile.tagsDerivedForYmd`**：与业务日一致时侧栏/今日直读 **`task_tags`/`memo_tags`/`schedule_tags`**，见《索引优化方案》§7.2）, `utils.ts` |
| Pipeline 原子能力（rebuild/sync） | `src/services/pipeline/specs/taskSpecAtomic.ts` |
| 侧栏视图 | `src/ui/views/TaskSidePanelView.ts`（顶层改为三子页签：**事项提醒 / 日程安排 / 任务清单**；`事项提醒` 与 `日程安排` 保留分组折叠与各自刷新/重建/归档；`任务清单` 保留重点关注→今日处理→其他活跃→近期闭环；任务 **`task_tags`**、提醒 **`memo_tags`**、日程 **`schedule_tags`** 芯片（`renderReminderUrgencyBadge` 读索引或现算）、`renderTaskLinkedScheduleRows`（meta **`linked_schedule_uids`**）、**`renderScheduleLinkedOutputRow`**（日程 meta **`linked_output_id`** → 跳转输出侧栏）、`renderReminderArrangedLinkRow`、`rslatte-timeline-meta` 悬停 title、**卡片操作「⋯」**：`mountSidePanelCardActions` + `getMoreIdsForSidePanelCard`）；`src/ui/views/CaptureView.ts`（待整理条目：**🗃️ 整理**、➕转任务、状态按钮；**专注页** 即时计时、**`CaptureTimerResetConfirmModal`** 确认后重置计时并清空主题与关联；读取 `captureModule.captureTypeRecommendationDict` 做类型推荐） |
| 设置项 | `src/ui/settings/sections/renderTaskSettings.ts`（假活跃阈值、任务基准日期/时区、重点关注数量、即将超期天数、近期闭环天数；**任务业务分类**列表 + **按空间默认分类**；**侧栏任务卡片收纳 ⋯**） |
| 任务标签计算与展示 | `src/taskRSLatte/task/taskTags.ts`（computeTaskTags、getTaskTodayKey、TASK_TAG_META）；`src/taskRSLatte/utils.ts`（reconcileTaskDisplayPhase：checkbox 与 task_phase 对齐）；**`indexMerge/taskIndexMerge.ts`**（**`applyTaskIndexDerivedFields`** → **`task_tags`**）；Today 侧栏 `src/ui/views/TodayView.ts` 经 **`taskRSLatte/task`** 引用 |
| 任务重要性计算与重点关注 | `src/taskRSLatte/task/taskImportance.ts`（**`computeTaskImportanceFromTags`**、`computeTaskImportance`、**`getTopImportantTasks`（可选 `indexTagsDay` 读索引）**、**`isInCandidatePoolFromTags`**）；**`applyTaskIndexDerivedFields`** 内单次标签后写 **importance_***；`getTaskListsForSidePanel` 在 **`tagsDerivedForYmd===today`** 时跳重复标签；TaskSidePanelView「重点关注」；renderTaskSettings focusTopN（3–10）；业务分类见 **`task/taskBusinessCategory.ts`** |
| 弹窗 | `src/ui/modals/AddTaskModal.ts`, `EditTaskModal.ts`, `TaskProgressModal.ts`（任务清单）；`AddProjectTaskModal.ts`, `EditProjectTaskModal.ts`（项目任务）；`ArrangeMemoModal.ts`（任务侧栏提醒 **安排**：转任务/转日程，回写 `arranged_*` meta 与 `- [x]`）；**`RecordTaskScheduleModal.ts`**（任务/输出卡片 **📅 录日程**：`writeScheduleCreate` + `tripleSaveSchedule`；任务侧 **`appendLinkedScheduleUidToTask`**；输出侧 **`linkedOutputId`** + **`linkOutputFileToSchedule`**）；**`CaptureQuickAddModal.ts`**（Capture 三合一类型引导，支持推荐标记）；`CaptureTimerStartModal.ts`、`CaptureTimerFinishModal.ts`（即时计时：关联任务/输出、`linked_task_uid` / **`linked_output_id`** / 回写 **`linked_schedule_uid`**） |
| Capture 推荐算法 | `src/services/capture/captureTypeRecommendation.ts`（基于描述关键词/时间模式推荐 提醒/任务/日程） |
| Capture 计时拆分算法 | `src/services/capture/captureInstantTimer.ts`（计时状态、暂停阈值分段、跨天拆分、timer_log 片段生成） |
| 类型 | `src/types/taskTypes.ts`, `src/taskRSLatte/types.ts`（含 taskPhase、progressNote、starred、estimateH、complexity、taskTags、importanceScore 等扩展） |

**计划结束日 写入范围与规范（任务侧）**：**due** 为历史键名；任务无 frontmatter，计划结束日由任务行 **📅** 与 meta（如 **original_due**、**postpone_count**）表示。**需写入计划结束日的文件**：任务清单所在的 **.md**（由设置或索引确定）。若与项目层命名统一，文案上使用「计划结束日」。

**与项目层 6-A / 6-B（摘要）**：凡需写计划结束日的**项目**文件均写 **planned_end**、不写 **due**；写入新 frontmatter 时删除旧键 **create / due / start**（读取仍兼容旧键）。**项目侧需写 planned_end 的文件**：**项目信息.md**、**项目任务清单.md**（或 项目清单.md）；**项目分析图**（`file_role=project_analysis`）仅同步项目名，不写入时间键。**细化约定**：创建日固定为操作当天、弹窗不提供修改；**planned_end** 创建/编辑项目**必填**；无 **planned_end** 不可点项目延期；同条 rslatte 注释内键**解析兼容乱序**；项目/里程碑延期原因写入 **postpone_reason** / **milestone_postpone_reason**（最后一次）；延期弹窗**天数必填**、原因可选、不展示历史延期次数；项目 **done/cancelled** 后仍保留 planned_end 与延期相关字段供历史与进度图。

### 3.2 提醒（Memo）

| 角色 | 路径 |
|------|------|
| Pipeline 原子能力 | `src/services/pipeline/specs/memoSpecAtomic.ts` |
| 设置项 | `src/ui/settings/sections/renderMemoSettings.ts`（**侧栏提醒卡片收纳 ⋯**：`sidePanelMemoCardActionsInMore` / `sidePanelMemoClosedCardActionsInMore`） |
| 衍生标签（入 `memo-index`） | `src/taskRSLatte/memo/memoTags.ts`（**`computeMemoTags`**、**`MEMO_TAG_META`**、**`calendarTodayYmd`**）；**`indexMerge/memoIndexMerge.ts`**（**`filterParsedLinesForMemoIndex`**、**`applyMemoIndexDerivedFields`**）；`src/taskRSLatte/service.ts`（**`writeMemoIndexWithDerivedTags`**、`getMemoIndexTagsDerivedDay`；与 **`queryReminderBuckets`** 窗口一致） |

（提醒与任务共用 taskRSLatte 索引体系，底层技术键仍为 memo，见 3.1。）

**与日程的索引边界**：解析得到的 `extra.cat=schedule` 行**不写入** `memo-index.json`（`service.ts` 的 `mergeIntoIndex("memo")`、以及 `rslatteSync/scanPipeline.ts` 产出 memos 时均过滤）；提醒侧 `listImportantMemos` / `queryAllMemosWithTotal` / `queryReminderBuckets` 也会跳过日程行，避免历史脏数据干扰。**日程清单**以 `schedule-index.json` 与 `queryScheduleBuckets` 为准（见 3.2-1）。

### 3.2-1 日程（Schedule）

| 角色 | 路径 |
|------|------|
| 类型 | `src/types/scheduleTypes.ts` |
| 日程分类 id/展示名、默认项、下拉挂载 | `src/taskRSLatte/schedule/scheduleCategory.ts`（`schedule_category` meta 存 id；侧栏展示用 `labelForScheduleCategoryId`） |
| 新建弹窗 | `src/ui/modals/AddScheduleModal.ts` |
| 编辑弹窗 | `src/ui/modals/EditScheduleModal.ts`（任务管理侧栏「日程安排」✏️；**勿**用 `EditMemoModal`） |
| 结束日程（✅ 直接结束 / ➕ 弹窗内结束并建任务或提醒或日程） | `ScheduleEndModal.ts`（仅三条「结束并增加*」+ 关闭）；侧栏 **`performScheduleDirectEnd`**；**`ScheduleFollowupPostModal.ts`**（已结束且无 followup 时「后续安排」）；**`renderScheduleFollowupRow`**；**`patchMemoRslatteMetaByUid`**；meta 见 `scheduleTypes.ts` |
| 新增日程弹窗串联 | `AddScheduleModal` 可选 `AddScheduleModalFlowOpts`（`onCreated`、预填） |
| 录日程 / 提醒转日程 | `src/ui/modals/RecordTaskScheduleModal.ts`, `src/ui/modals/ArrangeMemoModal.ts` |
| `AddTaskModal` / `AddMemoModal` 串联预填 | 可选第 3 参 `flow` / `memoFlow`（`onCreated`、`initialText`、日期预填等） |
| 服务与周期生成 | `src/taskRSLatte/service.ts`（`createScheduleMemo`、**`updateScheduleBasicInfo`**、**`patchMemoRslatteMetaByUid`**、日程周期自动生成与提前闭环生成；**`mergeIntoIndex("schedule")`** 写 **`schedule-index.json`** + **`schedule_tags`** / **`tagsDerivedForYmd`** + **`e2AutoCreateNextMemoEntries`**；**`readScheduleIndexItems`**；**`findScheduleByUid`** / **`queryScheduleBuckets`** 经 **`store.readIndex("schedule")`**） |
| 索引合并（与 pipeline 共用） | `src/taskRSLatte/indexMerge/`（**`scheduleIndexMerge.ts`**：`normalizeScheduleItems`、`mergeScheduleItemsByFiles`、`applyScheduleIndexDerivedFields`；**`index.ts`** 汇总导出；与 **`taskIndexMerge` / `memoIndexMerge`** 并列） |
| Pipeline 原子能力 | `src/services/pipeline/specs/scheduleSpecAtomic.ts`（增量/全量/归档均委托 **`taskRSLatte.mergeIntoIndex("schedule", …)`**；联系人互动块逻辑不变） |
| 衍生标签算法 | `src/taskRSLatte/schedule/scheduleTags.ts`（**`computeScheduleTags`**、**`SCHEDULE_TAG_META`**）；`src/taskRSLatte/service.ts`（**`getScheduleIndexTagsDerivedDay`**） |
| 设置项 | `src/ui/settings/sections/renderScheduleSettings.ts`（**日程分类列表** + **新建日程默认分类**；**侧栏日程卡片收纳 ⋯**：`scheduleModule.sidePanelScheduleCardActionsInMore` / `sidePanelScheduleClosedCardActionsInMore`；与 `src/services/space/spaceSettings.ts` 中 `scheduleModule` 按空间隔离） |
| 入口与命令 | `src/main.ts`, `src/constants/viewTypes.ts`（`VIEW_TYPE_SCHEDULE`、`打开侧边栏：日程`）；**日程日历侧栏** `VIEW_TYPE_CALENDAR` + **`scheduleCalendarModel.ts`** |

### 3.2-2 执行类门面与编排（任务 / 提醒 / 日程 · V2）

与 `docs/V2改造方案/执行类管理优化方案.md` 中 **统一新增/更新服务**、**编排层**、**各模块入口与转化** 对齐的代码骨架：**写笔记**仍由 `TaskRSLatteService` 实现；**索引刷新、联系人互动、侧栏、schedule 的 E2 manual_refresh** 等单次操作副作用经 **`runExecutionFlow`** 按 **`EXECUTION_RECIPE`** 执行，避免在 Modal/View 内复制长链 `async`。当前已补 **执行状态账本**（`execution-run-store.json`）与 **UI 统一调用层**（`runExecutionFlowUi`）。

| 角色 | 路径 |
|------|------|
| 流程上下文类型 | `src/types/executionFlowTypes.ts` |
| 配方常量 | `src/services/execution/executionRecipes.ts`（`EXECUTION_RECIPE`：`execution.tripleSave.task` / `memo` / `schedule`） |
| 薄编排入口 | `src/services/execution/executionOrchestrator.ts`（`runExecutionFlow`：Step 化执行、幂等短路、部分成功续跑；**`updateTaskAndRefresh`** 在 task+memo 索引刷新后追加 **`refreshScheduleE2`**，与 `schedule-index` 对齐） |
| 执行状态账本 | `src/services/execution/executionRunStore.ts`（落地到 `centralIndexDir/execution-run-store.json`） |
| UI 统一执行入口 | `src/ui/helpers/runExecutionFlowUi.ts`（统一 `clientOpId`、失败重试一次、统一 Notice） |
| WorkEvent 载荷构造 | `src/services/execution/buildExecutionWorkEvents.ts`（与原先 `TaskRSLatteService` 内字段对齐） |
| 任务写笔记门面（推荐入口） | `src/services/execution/taskWriteFacade.ts`（`writeTaskTodayCreate` → `createTodayTask`） |
| 提醒写笔记门面 | `src/services/execution/memoWriteFacade.ts`（`writeMemoTodayCreate`） |
| 日程写笔记门面 | `src/services/execution/scheduleWriteFacade.ts`（`writeScheduleCreate`） |

**已接入编排的 UI 路径**：`AddTaskModal`、`AddMemoModal`、`AddScheduleModal`、`CaptureView`、`EditTaskModal`、`EditMemoModal`、`EditScheduleModal`、`TaskProgressModal`、`ArrangeMemoModal`、`RecordTaskScheduleModal`、`TaskSidePanelView`（刷新与 workEvent-only）。**WorkEvent** 由编排写入（`ctx.workEvent`）。

### 3.3 项目（Project）

**侧栏与信息架构（与实现对照）**：标题行下一行为双页签 **「项目清单」**（默认）与 **「项目进度管理」**；打开侧栏时优先渲染清单，进度管理内里程碑树/任务/进度图/存档在**首次进入该页签或切换项目**时再加载。清单页：进行中 / 已完成 / **待归档** / 取消；卡片**瘦身**，里程碑树、存档、原卡片上的操作按钮迁至**进度管理**详情顶区；卡片保留推进区（两行「下一步」）、**「查看项目进度」**（切页签并选中项目）、风险等级 chip。进度管理页：**可折叠项目搜索**（状态多选、名称模糊、多维度排序；无筛选时空态为**最近 N 条**，N 见设置 `projectSearchDefaultLimit`）；详情自上而下四块 **项目概要 → 里程碑/任务树 → 项目进度图 → 存档树**；`settings.projectPanel.mainTab`（`list` | `progress`）与 `onClose` 写回清单等规则见代码。**风险分 V1**、**里程碑权重 `milestone_weight`（1–100）** 与加权总进度：`projectRiskAndProgress.ts`。**项目进度图（甘特）**已落地：`projectProgressChart.ts` + `ProjectSidePanelView`「项目进度图」区块 + `styles.css` 中 `rslatte-proj-gantt-*`；设置含 **进度图时间轴余量（天）** `progressChartMarginDays`、折叠键 `progressChartCollapsedKeys` 等（见下表与 `renderProjectSettings`）。

**计划结束日与 frontmatter**：**due** 为已废弃写入键，使用 **planned_end**；项目侧需写计划结束日的文件与 **6-A/6-B**、延期字段等约定见 **§3.1 任务**段末「与项目层 6-A / 6-B（摘要）」（与任务小节同一套口径，避免重复）。

| 角色 | 路径 |
|------|------|
| 服务、解析、类型 | `src/projectManager/service.ts`（`ensureReady` 单例 Promise + vault 监听只注册一次；启动路径**一次** `readIndex` 判断有数据并标脏；**F4** 循环 `refreshDirty` 直至 dirty 清空；`commitSnapshot` 内 **`applyProjectSnapshotDerivatives`**（含 **`progressMilestoneUpcomingDays`**、**`progressProjectUpcomingDays`**）；`toRSLatteItem` 写入 **`project_tags`** / **`project_status_display_zh`**；`tryReadPanelHydrateSnapshot` / `applyPanelHydrateSnapshot`（灌入后同样跑衍生）/ `writePanelHydrateSnapshot`（`project-panel-hydrate.json`）；`isEnsureReadySettled`；`clearAllSnapshots` 清空 `_ensureReadyPromise`、`_ensureReadySettled` 并删 hydrate；**perf**：调试日志下 `[rslatte][projectMgr] perf`；**里程碑计划完成日**：`addMilestone`/`patchMilestoneMetaAugment`/`postponeMilestone` **仅一级**；二三级保存或降级时剥离 `milestone_planned_end`）, **`projectStatus.ts`（§8.3：状态规范化与迁移、笔记归档 eligibility、侧栏/UI 共用）**, `parser.ts`（`parseMilestoneNodes`：**二三级**不产出 `planned_end`/`original_planned_end`/`postpone_count`；`parseTaskItems`：任务 **`milestone`/`milestonePath` 为里程碑全路径**；任务行与下一行合并解析 `<!-- rslatte:... -->`，键值仅按 `;` 分割，与 `patchProjectTaskMetaInLines` 一致）, `types.ts` |
| 快照衍生（第十节 index 优化） | `src/projectManager/projectDerivatives.ts`（`applyProjectSnapshotDerivatives` 传入 **`progressMilestoneUpcomingDays`**、**`progressProjectUpcomingDays`**；**`project_tags`**（`risk_*`、`project_overdue` 含当日、`project_postponed`、`project_soon_overdue`、`stale_progress`）与 **`project_status_display_zh`**（`projectStatusDisplayZh`）；一级里程碑 **`milestone_tags`** 含 `milestone_overdue` / `milestone_soon_overdue` / `milestone_postponed`；`pickNextActionTaskForL1Track` 按任务 **`planned_end` 升序**；`getProjectTaskTagsOrCompute`）；`milestoneTreeUtils.ts`（`getProjectMilestoneRootsAndResolver`） |
| 风险分 V1、三级里程碑加权总进度 | `src/projectManager/projectRiskAndProgress.ts`（`computeProjectRiskSummary` 里程碑超期项**仅一级**；`computeWeightedMilestoneProgressRatio`、`progressUpdatedToMs`、`daysBetweenYmd` 等） |
| 项目进度图（甘特）数据模型 | `src/projectManager/projectProgressChart.ts`（`buildProgressChartModel`、`ymdToFrac`、`addDaysYmd`；轴余量、缩放 px/日、同轨排序、里程碑点、汇总） |
| 同步队列等 | `src/projectRSLatte/`（如 `syncQueue.ts` 等）；`persistIndexAndEnqueueSync` 的 **`replace_items`**：`milestone_id` / `source_anchor` 与解析层一致，用里程碑 **全路径 `path`**（含二级/三级） |
| Pipeline 原子能力 | `src/services/pipeline/specs/projectSpecAtomic.ts` |
| 侧栏视图 | `src/ui/views/ProjectSidePanelView.ts`（双页签；推进区「下一步」与 **`pickNextActionTaskForL1Track`** 一致；项目任务标签 **`getProjectTaskTagsOrCompute`**；`onOpen`：**首次 ensure 未完成前**可读 hydrate → 先 `render`，后台 `ensureReady`+`refreshDirty`+写 hydrate（弱 Notice）；否则 `await ensureReady()`；**进度管理**未选中时默认仅筛选项 +「显示可选项目列表」+ 下方空态，`projectPanel.progressProjectPickerExpanded`；**项目进度图** `renderProjectProgressChartBody`、折叠 `progressChartCollapsedKeys`） |
| 设置项 | `src/ui/settings/sections/renderProjectSettings.ts`（文首 **`rslatte-setting-hint`**：**项目归档**先 **笔记归档**（移文件夹到 `projectArchiveDir`）再 **索引归档**（主索引条迁出 archive 分片）；`projectAdvanceDescMaxLen`；**项目搜索默认条数** `projectSearchDefaultLimit`；**进度图时间轴余量（天）** `progressChartMarginDays`；**里程碑即将超期天数** `progressMilestoneUpcomingDays`；**项目概要即将超期天数** `progressProjectUpcomingDays`）；其余 `progressChartZoom` / `TaskSort` / `MilestoneMode` / `SummaryMode` / **`progressChartHideDone`（工具栏「隐藏已完成」）** 等在进度图工具栏内持久化；侧栏折叠/页签等见 `settings.projectPanel`（`constants/defaults.ts`） |
| 弹窗 | `src/ui/modals/AddProjectModal.ts`, `EditProjectModal.ts`（创建/编辑项目：计划开始日、计划结束日）；`AddProjectMilestoneModal.ts`, `EditProjectMilestoneModal.ts`（**仅一级**显示/写入 `milestone_planned_end`；**`milestone_weight` 1–100**）；`AddProjectTaskModal.ts`（子里程碑仅名称+权重，无计划完成日；任务表单含 **CSV 批量导入入口**）、`ImportProjectTasksCsvModal.ts`（模板下载、CSV 解析、清单确认、批量创建）、`EditProjectTaskModal.ts`, `ProjectTaskProgressModal.ts`, `PostponeModal.ts`（项目任务与项目/里程碑延期：**里程碑延期仅一级**）；`CreateProjectArchiveDocModal.ts`（模板源：`mergeProjectArchiveTemplatesForModal` 合并 **`outputPanel.templates`** 中 `templateScope=project` 与 legacy **`projectArchiveTemplates`**；新增 **`领域*` 必填** + **存档子目录（可选）**，路径为模板相对路径后追加子目录） |

### 3.4 输出（Output）

| 角色 | 路径 |
|------|------|
| 服务、索引存储 | `src/outputRSLatte/service.ts`（含 **`resumeWaitingOutputsIfDue`**、`buildItemFromFile`、`syncFolderNameByMdFileName`、`mergeLedgerKnowledgePathsIntoScan`（合并 **`.history/output-ledger.json`** 中知识库路径）、**`archiveIndexForArchivedFiles`**（物理归档路径 **或** DONE+在 **`archiveRoots`** 下且超过 **`archiveThresholdDays`** 的**索引归档**，并 **`appendOutputArchivedFromIndexLedgerEvent`**）；**`fullRebuildScanLegacyArchiveDirs`** 关闭时 🧱 全量**不**扫 `archiveRootDir`/`_archived`、**§8.4** `outputRefreshScanPlan.ts`（`mergeOutputPrimaryScanRoots`、`buildOutputRefreshScanPlan`）、**`types/outputTypes.ts` 文件头**（扫描根 vs 台账合并说明））；`indexStore.ts`；**项目存档模板合并** `mergeProjectArchiveTemplates.ts` |
| Pipeline 原子能力 | `src/services/pipeline/specs/outputSpecAtomic.ts` |
| 输出管理（插件能力） | `src/plugin/outputManager.ts` |
| 侧栏视图 | `src/ui/views/OutputSidePanelView.ts`（**分区一～二 + 主 Tab** **`rslatte-output-sticky-top` 吸顶**；**正在输出 \| 历史发布清单**；正在输出卡片：title 下 tags 行（项目/一般、文档分类、领域），**tags 与 meta 间** 关联日程行（FM **`linked_schedule_uid`**）、**📅 关联日程**；meta 统一状态与时间序列（`🆕/▶/📝/⌛/✅`），点击卡片以**编辑模式**打开；历史发布清单：仅 **搜索 / output_id** 两查询，默认展示当前空间最近发布 **30** 条（按发布时间降序，列表条目样式与输出清单一致，不按 year/day 分组），支持阅读与打回 `RecallOutputFromKnowledgeModal`；…） |
| 设置项 | `src/ui/settings/sections/renderOutputSettings.ts`（含 **创建输出 · 自定义属性** 表）；**模板表** `src/ui/outputTemplatesTable.ts`（`mountOutputTemplatesSection`） |
| 弹窗 | `AddOutputTemplateModal.ts`, `CreateOutputDocModal.ts`、**`EditOutputMetaModal.ts`**（侧栏 ✏️）、**`PublishToKnowledgeModal.ts`**（侧栏 📚）、**`ManageOutputTemplatesModal.ts`**、**`SetOutputWaitingModal.ts`**；项目侧 **`CreateProjectArchiveDocModal.ts`**（与输出管理项目模板同源 + `output_document_kind: project`） |
| 输出↔日程门面 | `src/services/execution/outputScheduleLinkFacade.ts`；Capture 计时输出清单目录提示 **`src/ui/helpers/outputCapturePickerPaths.ts`**（`formatOutputDocFolderHintForCapture`） |
| YAML 工具 | `src/utils/outputYamlExtras.ts`（`isReservedOutputFmKey`、`formatYamlScalarLine`） |
| 类型 | `src/types/outputTypes.ts` |

### 3.4-1 知识库路径与发布（P0.6 / §3.5）

| 角色 | 路径 |
|------|------|
| 设置 | `src/ui/settings/sections/renderKnowledgeSettings.ts`（`knowledgePanel.secondarySubdirs` 表；恢复 §2.1 默认） |
| 路径解析 | `src/services/knowledgePaths.ts`（`resolveKnowledgeLibraryRootRel`、`listKnowledgePublishTargets`、`buildKnowledgeSubdirPath`、**`collectMarkdownFilesUnderFolder`**） |
| 类型与默认种子 | `src/types/knowledgeTypes.ts`（`DEFAULT_KNOWLEDGE_SECONDARY_SUBDIRS`） |
| 输出台账（§3.5.1） | `src/types/outputHistoryTypes.ts`、`src/outputRSLatte/outputHistoryLedger.ts`（**`byKnowledgePath` + `bySourceOutputPath`**；**发布 / 打回 / 创建输出 / 主索引归档迁出 / `output_updated` / `output_status_changed`**；落盘前事件合并去重，避免台账膨胀）；**`src/outputRSLatte/knowledgeOutputUpdatedLedgerHook.ts`**（`main` **`registerKnowledgeOutputUpdatedLedgerHook`**） |
| 知识轻量索引（§5.3） | `src/types/knowledgeIndexTypes.ts`、`src/services/knowledgeIndexWriter.ts`（**`rebuildKnowledgeIndexJson`**、**`tryReadKnowledgeIndexJson`**）；`src/services/pipeline/specs/knowledgeSpecAtomic.ts`（`specRegistry` 合并 **`knowledge`**）；**`pipelineManager`**：`knowledge` **不参与定时自动跑**；**`outputSpecAtomic.replaceAll` 成功后顺带重建** |
| Knowledge 视图 | `src/ui/views/KnowledgeView.ts`（双 **`VIEW_TYPE`** + **`host: sidepanel`**；三页签：**随便看看 / 知识库概览 / 知识库清单**；随便看看支持 `👁‍🗨/📋/🔗`；清单支持一级/二级折叠与**全部展开/全部折叠**；知识卡片 tags 行（空间/项目一般/领域/文档分类）、`from` 路径裁剪；卡片点击以**阅读模式**打开；概览含 24 周趋势、领域洞察、标签云与联动清单；**优先** `tryReadKnowledgeIndexJson`；**`KnowledgeDocInfoModal`**） |
| 弹窗 | `src/ui/modals/PublishToKnowledgeModal.ts`（移动/复制至 `30-Knowledge/...`，写入 `knowledge_bucket`/`published_at`/`source_output_path` 等；**写台账**；**§2.2 三问** `<details>`） |
| 弹窗 | `src/ui/modals/RecallOutputFromKnowledgeModal.ts`（从 `30-Knowledge` **打回**至 `archiveRoots`；**台账** `recall_from_knowledge`；`WorkEventAction.recall`） |
| 弹窗 | `src/ui/modals/KnowledgeDocInfoModal.ts`（单篇：**frontmatter 摘要** + **`readMergedOutputLedgerMaps`**：**本篇 `byKnowledgePath`** + 按 **`output_id` / 本篇路径** 过滤的源输出事件，避免多篇知识稿共用同源台账） |
| 设置根键 | `RSLattePluginSettings.knowledgePanel`（`src/types/settings.ts`、`constants/defaults.ts`、`main` 合并） |

### 3.5 发布（Publish）— 已并入输出/知识流程（§4）

**当前状态**：旧独立发布模块已完成物理删除（不再保留 `publishRSLatte` 服务、独立侧栏、Publish atomic spec、publish 面板设置类型）。  
**兼容策略**：保留命令 ID `rslatte-open-publish-panel`，行为重定向到 Knowledge 工作台；URI/模块名中的 `publish` 同样重定向。  
**功能入口**：发布与打回走 **3.4 输出侧栏「历史发布清单」** 与 **3.4-1 知识库路径与发布**（`PublishToKnowledgeModal` / `RecallOutputFromKnowledgeModal`）。

### 3.6 打卡（Checkin）

**连续打卡天数 `continuousDays`（存储在 `settings.checkinItems`）**：表示从「今天」起向前连续有有效打卡的天数；侧栏等处 `continuousDays > 0` 时展示「连续 N 天」。**更新规则**：用户打卡时若昨日有该打卡项有效记录则 `+1`，否则置 `1`；取消打卡不自动递减（由后续刷新纠正）。**刷新打卡数据 / 今日统一刷新打卡**（`CheckinSidePanelView` / `RSLatteSidePanelView`）：在 `hydrateTodayFromRecordIndex` 之后调用 **`recomputeCheckinContinuousDaysFromIndex()`**，按 `getEffectiveCheckinRecordDates` 从今天向前重算 streak（补打卡后亦正确）。轻量 **`normalizeCheckinContinuousDays`** 仍保留但不再作为刷新主路径（其「昨日有记录则跳过」会导致补打卡后连续数不更新）。依赖 `recordRSLatte.hasEffectiveCheckinRecordOnDate`、`getEffectiveCheckinRecordDates`（见 `recordRSLatte/service.ts`）。

**打卡难度 `checkinDifficulty`**（`settings.checkinItems`，仅本地展示）：`normal` | `high_focus` | `light`，默认「一般」；设置页表格「难度」列；今日侧栏 / 打卡管理侧栏名称旁 🧠/🍃。不参与 `lists` 中央索引字段；从后端拉清单时同 ID 保留本地难度（`pullListsFromApiToSettings`）。

| 角色 | 路径 |
|------|------|
| 记录索引与同步（与财务共用 recordRSLatte） | `src/recordRSLatte/service.ts`, `indexStore.ts` |
| Pipeline 原子能力 | `src/services/pipeline/specs/checkinSpecAtomic.ts` |
| 侧栏视图 | `src/ui/views/CheckinSidePanelView.ts` |
| 设置项 | `src/ui/settings/sections/renderCheckinSettings.ts` |
| 弹窗 | `src/ui/modals/AddCheckinRecordModal.ts`, `AddCheckinItemModal.ts`, `CheckinModal.ts` |
| 连续打卡天数更新 | `src/main.ts`（`recomputeCheckinContinuousDaysFromIndex`：刷新/重建后；`normalizeCheckinContinuousDays`：保留；打卡点击时更新 `continuousDays`）；`CheckinSidePanelView` / `RSLatteSidePanelView` 刷新后调用 recompute |

### 3.6-1 健康（Health）

| 角色 | 路径 |
|------|------|
| 视图类型与侧栏 | `src/constants/viewTypes.ts`（`VIEW_TYPE_HEALTH`）；`src/ui/views/HealthSidePanelView.ts`（标题栏 🧱🗄🔄 + ➕；**清单** / **健康统计明细** 子页签：月快照汇总、合并项末次、**`readHealthAnalysisAlertIndex`**、**`readHealthAlertsSnapshot`**、关联 **entry** 打开日记；清单页：`getHealthSnapshot`、**按日记日期降序时间轴**、**点击条目打开日记并定位主行**（`findHealthMainLineIndexInDiaryLines` / `sourceLineMain`）、筛选；筛选 **体重** / **腰围** 时 **`healthWeightTrendChart`**（日卡体重折线 + `targetWeightKg` 默认 55；周卡腰围折线 + `targetWaistCm` 默认 75）；✏️`EditHealthEntryModal`（日卡体重 / 周卡腰围编辑时同上趋势图并高亮锚日）、❌撤销、导航高亮）；`src/main.ts`（`registerView`、命令）；`src/plugin/uiNavigation.ts`（`activateHealthView`） |
| 记录索引与扫描 | `src/recordRSLatte/service.ts`（`health` 模块开关、`getHealthSnapshot`、`upsertHealth`/`upsertHealthRecord`（合并 **`createdAtMs`**）、扫描/归档与 `healthSnap`；**`parseDiaryForDay`** 健康行：meta 含合法 **`created_at_ms`** 时写入 **`createdAtMs`** 并优先作 **`tsMs`**）；`src/recordRSLatte/indexStore.ts`（`health-record-index.json`）；`src/types/recordIndexTypes.ts`（`HealthRecordIndexItem`） |
| 日记行与替换 | `src/services/health/healthJournalMeta.ts`（主行 / meta：`cups`、`diet_note`、**`sleep_start_hm`**、**`created_at_ms`** / **`normalizeHealthCreatedAtMs`** / **`findHealthMainLineIndexInDiaryLines`**）；`src/plugin/journalWriter.ts`（`appendJournalByModule` / `replaceHealthJournalPairByEntryId`，`JournalAppendModule` 含 `health`） |
| Pipeline | `src/services/pipeline/specs/healthSpecAtomic.ts`（**`applyDelta`（含 empty）**、**`replaceAll`、成功后的 `reconcile`** 均写 **`writeHealthAnalysisAlertIndex` + `writeHealthAnalysisSnapshotsAndIndex`**；触发表见 **`记录类管理优化方案.md`** **「衍生索引刷新契约」**）。`specRegistry.ts`；`lockKeys` / `moduleRegistry` / `coordinator` / `pipelineManager` |
| 设置（按空间） | **启用与维护**：`src/ui/settings/RSLatteSettingTab.ts`（`renderHealthV2Row`：`moduleEnabledV2.health`、`healthPanel` 的 DB 同步/自动归档/阈值/手动归档/扫描重建；**日志追加清单** `journalAppendRules.health`）；**参数**：`src/ui/settings/sections/renderHealthSettings.ts`（`waterGoalCups` / **`healthMetricsEnabled` 九项勾选** / **统计与告警生成表格**：`healthStatsMetricsEnabled`、`healthRuleAlertsEnabled`，清单见 **`healthAnalysisGenerationCatalog.ts`**）；`src/types/settings.ts`；`src/constants/defaults.ts`；`src/services/space/spaceSettings.ts` |
| 合并项与热力归因 | `src/services/health/healthCanonicalMetrics.ts`（含 **`findLatestActiveHealthItemForCanonicalToday`**）；`src/services/health/healthMetricsSettings.ts`（设置保存校验） |
| 健康分析索引与告警 | `src/services/health/healthAnalysisGenerationCatalog.ts`（统计块与告警项 **id 清单**，供设置勾选 **`healthStatsMetricsEnabled` / `healthRuleAlertsEnabled`**）；`src/services/health/healthAnalysisAlertIndex.ts`（`writeHealthAnalysisAlertIndex` / `readHealthAnalysisAlertIndex`；**近期缺口** 连续无睡眠/饮水日卡、近35天无周卡项；**按设置过滤** `missingData`；复用 **`buildDayAggregateMapForYmdRange`**）；`src/services/health/healthAnalysisIndex.ts`（`writeHealthAnalysisSnapshotsAndIndex`、`applyHealthStatsMetricOutputFilters`、**规则告警按设置过滤**；`readHealthAnalysisIndex` 等；月快照 **`derived` + `rolling`**；**仅自然月** `snapshots/month/*.stats.json` / `*.alerts.json` + `health-analysis.index.json`） |
| 弹窗 / 卡片录入 | `src/ui/modals/AddHealthRecordModal.ts`（日·周·月；按 **`healthMetricsEnabled`** 裁剪页签与字段；**`singleCanonicalMetric`**；**月**月经起止用 **`MenstruationRangePickerModal.ts`**）；`EditHealthEntryModal.ts`；`healthTypes.ts`；`healthCardRef.ts` |
| 今日打卡分区 | `src/ui/views/RSLatteSidePanelView.ts`（`data-rslatte-inspect="health"`：**合并项名为 `rslatte-btn`**，绿=当前日/周/月卡片已有→`EditHealthEntryModal`，白→`HealthCardModal`（`singleCanonicalMetric` + **`lockAnchorToToday`**）+ 30 日热力图；`findLatestActiveHealthItemForCanonicalToday`） |
| 今日记录 | `src/ui/helpers/todayRecordsModel.ts`（`buildTodayRecordsModel`、`statusLights`：打卡/财务/健康 仅 **「今日」** 条、日记 **`countJournalMeaningfulChars` 合计**；健康日完成度按 **启用日项**）；`src/ui/views/todayRecordsRender.ts`（顶栏 **今日记录状态** 四灯）；`src/types/healthTypes.ts`（`HEALTH_DAY_CARD_METRICS` 等） |
| WorkEvent | `src/services/workEventService.ts`（`kind: "health"` create/update/delete）；统计侧 `src/types/stats/workEvent.ts`、`src/utils/stats/colors.ts`、`src/ui/views/stats/TimelineView.ts` |
| 刷新 | `src/plugin/core.ts`、`src/plugin/spaceManagement.ts`（`VIEW_TYPE_HEALTH`） |

### 3.7 财务（Finance）

| 角色 | 路径 |
|------|------|
| 记录索引与同步（与打卡共用 recordRSLatte） | `src/recordRSLatte/service.ts`（`entryId` 维度 upsert/扫描解析/归档合并键、`getTodayFinanceRecordsForCategory`、`scanFinanceAnomalies`）, `indexStore.ts` |
| 日记财务 meta 与主行 | `src/services/finance/financeJournalMeta.ts`（`FE_*` / **`cycle_id`**（`FCP_*` 或 `none`）、meta 注释 JSON、主行不含场景；**`FINANCE_DIARY_MAIN_LINE_RE`** 与解析一致；**`findFinanceMainLineIndexInDiaryLines`** 侧栏跳转降级定位） |
| 周期表与交互 | `src/services/finance/financeCyclePlan.ts`（四元组匹配、冲突检测）、`financeCycleInteractive.ts`（弹窗 confirm 入表 / 启用 / `none`）、`financeInstitutionSimilarity.ts`（机构名相似提示） |
| 索引侧财务管理快照 | `src/recordRSLatte/indexStore.ts` → **`finance-management-settings.snapshot.json`**（重建财务索引后写入） |
| 日记按 entry 替换块 | `src/plugin/journalWriter.ts` → `replaceFinanceJournalPairByEntryId` |
| 汇总与统计 | `src/services/financeSummary.ts`（含 FinanceSummaryService）；`src/services/finance/financeAnalysisAlertIndex.ts`（`writeFinanceAnalysisAlertIndex` / **`readFinanceAnalysisAlertIndex`**；缺失基础数据诊断；输出/读取 `finance-analysis.alert-index.json`）；`src/services/finance/financeAnalysisIndex.ts`（`writeFinanceAnalysisSnapshotsAndIndex`：生成 **`finance-analysis.index.json`** 与 `snapshots/day|week|month/*.stats.json|*.alerts.json`，回填 `latest/snapshots/activeAlerts/configHashes`）；`src/services/finance/financeRulesAnalysis.ts`（规则分析执行器：输出/读取 `finance-rules.alerts.json`；首批算法执行闭环）；`src/services/finance/financeAlgorithmRegistry.ts`（财务算法注册门）；`src/services/finance/financeRuleValidator.ts`（规则 JSON 静态校验：算法/池/预算/参数） |
| Pipeline 原子能力 | `src/services/pipeline/specs/financeSpecAtomic.ts`（**`applyDelta` / `replaceAll`** 后写 `finance-analysis` 告警与快照；**`reconcile` 尾不写**——见 **`记录类管理优化方案.md`** **「衍生索引刷新契约」**） |
| 侧栏视图 | `src/ui/views/FinanceSidePanelView.ts`（**页签**：「财务记录清单」= 仅 **active** 财务索引上的饼图+筛选+时间轴；「财务统计明细」= **active+archive 合并** 后的期间收支配比/分类汇总等，与 `HealthSidePanelView` 清单/统计口径一致；`readFinanceAnalysisAlertIndex`、`scanFinanceAnomalies` 等；时间轴点击打开日记并定位主行；标题栏 ⚠ → `FinanceAnomalyModal`） |
| 今日打卡内财务汇总 | `src/ui/views/RSLatteSidePanelView.ts`：**仅** `getFinanceSnapshot(false)` + `computeFinanceStatsFromIndex`（当月色条等；归档阈值 ≥90 时近期数据一般在 active；**不**再读 `getFinanceStatsCache`） |
| 设置项 | `src/ui/settings/sections/renderFinanceSettings.ts`（财务分类清单：子分类/机构名维护；**周期表**、币种、机构名忽略列表；JSON 导入/导出） |
| 弹窗 | `src/ui/modals/AddFinanceRecordModal.ts`, `AddFinanceCategoryModal.ts`, `FinanceRecordModal.ts`（分类今日台账 + §1.1 相似确认 + **周期入表 / cycle_id**）, `FinanceAnomalyModal.ts`（legacy / 重复 `entry_id` / **缺 cycle_id**）, `FinanceEntryModal.ts`, `FinanceRelatedEntriesModal.ts`（业务告警 `relatedEntryIds` 记录集弹窗与逐条跳转）, `FinanceHiddenAlertsModal.ts`（已隐藏告警管理：逐条恢复 / 全部恢复） |
| 今日缓存 / DB 水合 | `src/main.ts`（`getTodayFinanceRecords`、`_todayFinancesMap` 按分类数组）；`src/plugin/recordSync.ts` |
| 类型 | `src/types/recordIndexTypes.ts`、`src/types/financeAnomalyTypes.ts`、`src/api.ts`（`ApiFinanceRecord.entry_id`）等 |

### 3.8 联系人（Contacts）

**任务/项目任务 ↔ 联系人（两种关联）**：**强关联（strong）** — 描述正文中出现 `[[C_xxx]]`，`follow_association_type=strong`；在任务**整段活跃期**（非 done/cancelled）为「关注中」，仅 done/cancelled 为「已结束」。**弱关联（weak）** — 下一行 meta **`follow_contact_uids=...`**；仅当 `task_phase` 为 **waiting_others** 或 **waiting_until** 时为「关注中」，其余为「已结束」。条目写入 `ContactsInteractionEntry` 的 `follow_status`、`task_phase`、`follow_association_type`。**项目任务清单构建互动索引时**须遍历**全部任务行**再合并弱关联 meta（不可仅依赖正文含 wiki 链接的行），否则「等待/跟进」仅选联系人、未写 `[[C_xxx]]` 时侧栏无记录。

**任务/项目任务 · 实际互动（`interaction_events`）与 WorkEvent**：动态**条目**仍由任务/项目索引与 `projectTaskContactInteractions` 等生成；条目下的 **实际互动**不再依赖 `contactInteractionEventsMerge` 对任务类做 prev/next diff，改为：`WorkEvent.ref` 写入 **`contact_uids_strong`** / **`contact_uids_weak`**（`taskWorkEventContactRef.ts` 的 `enrichWorkEventRefWithTaskContacts`，任务在 `taskRSLatte/service.ts`，项目任务在 `projectManager/service.ts`，侧栏经 `buildWorkEventUiAction` 的 **`taskContactEnrich`**）；`indexStore.applyFileUpdates` 合并后 **`rebuildTaskProjectInteractionEventsFromWork`** → `rebuildTaskProjectInteractionEventsFromWorkEvents.ts` 按约 6 个月 WorkEvent 重放。规则与优先级见 `contactInteractionDynamicRules.ts`。

**刷新与动态块**：`indexStore.applyFileUpdates` 落盘后通过 `ContactsInteractionsContext.refreshContactNoteDynamicBlocksForUids` 回写受影响联系人 md；`main.ts` 另有 `refreshAllContactNoteDynamicBlocks`（全量按索引重写动态区），供侧栏「刷新联系人」在 task/memo/schedule/project 跑完后调用。单文件入口见 `refreshContactInteractionsForTasklistFile`、`refreshContactInteractionsForTaskFile`。`contactNoteWriter.replaceContactDynamicGeneratedBlock` 在 `<!-- rslatte:contact:dynamic:start/end -->`（兼容 `rs_latte`）之间写入列表。

**主索引 `last_interaction_at`**：与侧栏「最后互动」同一时刻；由 `computeLastInteractionAtForContactIndex` 落盘（任务基准为**时区**时用带偏移的本地钟面串，避免仅见 UTC `Z` 与界面 `HH:mm` 不一致）。`indexService.rebuild` 扫描后按 `contacts-interactions.json` 覆盖；`applyFileUpdates` / `rewriteSourcePaths` 后经 `syncContactsIndexLastInteractionAtForUids` → `syncLastInteractionAtForContactUids` 回写受影响 uid。

| 角色 | 路径 |
|------|------|
| 索引服务与存储、类型 | `src/contactsRSLatte/indexService.ts`, `indexStore.ts`, `types.ts`（ContactsInteractionEntry：follow_status、task_phase、follow_association_type） |
| 联系人笔记写入、动态块 | `src/services/contacts/contactNoteWriter.ts`（replaceContactDynamicGeneratedBlock、statusIconForInteractionWithPhase；手动互动支持 `occurredAt`） |
| 互动展示与统计、副本快照 | `src/services/contacts/contactInteractionDisplay.ts`；`src/services/contacts/manualContactInteractionIndex.ts`（手动写入主索引）；`src/services/contacts/contactsInteractionReplica.ts`（`syncAll…`：`rebuildAndWrite` 后按主索引补写 `.contacts/<uid>.json`） |
| §6.9 窗口裁剪与溢出归档 | `src/services/contacts/contactInteractionWindowTrim.ts`（每 source + 全局上限；裁出项为 `ContactInteractionArchiveEventRecord[]`）；`src/services/contacts/contactInteractionArchive.ts`（分片 `schema_version: 2` 字段 `records`，含 source_path/type/block_id/follow_association 等 + `event`）；`indexStore.applyFileUpdates` 内裁剪 → 归档 → 首片快照 |
| 主索引 interaction_events 合并 | `src/services/contacts/contactInteractionEventsMerge.ts`（**提醒/日程等**仍合并；**任务/项目任务**不在此追加实际互动）；`src/contactsRSLatte/indexStore.ts` 的 `applyFileUpdates` 写入前合并，并可 **`rebuildTaskProjectInteractionEventsFromWork`** |
| 任务/项目任务 · WorkEvent 联系人字段与重放 | `src/services/contacts/taskWorkEventContactRef.ts`；`rebuildTaskProjectInteractionEventsFromWorkEvents.ts`；`contactInteractionDynamicRules.ts`；`main.ts` 注册 `rebuildTaskProjectInteractionEventsFromWork` |
| 联系人详细信息页签（中文键名、值格式化） | `src/services/contacts/contactDetailsDisplay.ts` |
| 项目任务→联系人互动 | `src/services/contacts/projectTaskContactInteractions.ts`（`buildProjectTaskContactEntriesFromMarkdownContent`、`buildProjectTaskContactEntriesForFile`） |
| Pipeline 原子能力 | `src/services/pipeline/specs/contactsSpecAtomic.ts`（**rebuild / refresh**：仅 `rebuildAndWrite`，不扫归档目录；**§8.5** `buildOps`/`flushQueue` 经 **`listAllContactMdPathsForDbSync`** 主+归档全量 DB upsert，与本地索引范围**有意不一致**；**笔记归档** `main.archiveContactsNow` 成功后 `rebuildContactsAllIndexes`）；任务/项目写入 contacts-interactions 见 `taskSpecAtomic.ts`、`projectSpecAtomic.ts` |
| 插件侧联系人逻辑、刷新入口 | `src/plugin/contactsHandler.ts`；`src/main.ts`（refreshContactInteractionsForTasklistFile、refreshContactInteractionsForTaskFile、refreshContactNoteDynamicBlockForUids、refreshAllContactNoteDynamicBlocks） |
| 侧栏视图 | `src/ui/views/ContactsSidePanelView.ts`（🔄：contacts + task/memo/schedule/project manual_refresh 后 `refreshAllContactNoteDynamicBlocks`） |
| 设置项 | `src/ui/settings/sections/renderContactsSettings.ts` |
| 弹窗 | `src/ui/modals/AddContactModal.ts`, `EditContactModal.ts`, `InsertContactReferenceModal.ts`, `AddContactManualEventModal.ts`（日期时间、禁止未来、主索引 + 副本） |

### 3.9 统计与操作日志（Stats & Timeline）

| 角色 | 路径 |
|------|------|
| 工作事件流与读取 | `src/services/workEventService.ts`, `src/services/stats/WorkEventReader.ts` |
| 状态计算、空间统计 | `src/services/statusCalculationService.ts`, `spaceStatsService.ts` |
| 时间线视图 | `src/ui/views/stats/TimelineView.ts` |
| 日程日历侧栏 | `src/ui/views/CalendarView.ts`（**schedule-index** 月历 + 选日展开；**`scheduleCalendarModel.ts`**：密度点、重叠竖线/「叠」标、条带/进行中、`stripRedundantScheduleTimeRangePrefix`；**`scheduleCalendarLinkResolve.ts`**：关联任务/项目任务/输出图标；**`renderTextWithContactRefs`**：描述内联系人引用展平） |
| 设置项 | `src/ui/settings/sections/renderStatsSettings.ts` |
| 类型 | `src/types/stats/workEvent.ts`；`src/types/spaceStats.ts` |
| 工具 | `src/utils/stats/colors.ts` |

### 3.10 空间（Space）与 Hub

| 角色 | 路径 |
|------|------|
| 空间管理（切换、配置） | `src/plugin/spaceManagement.ts`（`refreshAllRSLatteViews` 含 **`VIEW_TYPE_TODAY`**） |
| **空间服务子目录** | `src/services/space/`：**`spaceContext`**（索引/队列/统计路径解析）、**`spaceSettings`**（`SPACE_SCOPED_SETTING_KEYS`）、**`spaceDirectoryDefaults`**（编号与 **`buildSettingsSnapshotForNewSpace`**：新空间默认 **`moduleEnabledV2.health: true`**、**`healthPanel.autoArchiveEnabled: true`**）、**`spaceMigrations`**、**`spacesIndexService`**（`spaces-index.json`）、**`spaceStatsService`**、**`ensureSpaceVaultDirectories`**（新建空间后落盘） |
| **插件初始化环境检查** | `src/services/envCheck/pluginEnvCheck.ts`（`runPluginEnvChecks`、`hasBlockingPluginEnvFailures`、Obsidian「文件与链接」五项、**建议核心插件「工作区」**、`RECOMMENDED_ATTACHMENT_SUBFOLDER`、目录/模板一键修复）；弹窗 **`PluginEnvCheckModal.ts`**（**`openObsidianCorePluginsTab`**）；启动 **`main.ts`** `onLayoutReady` 在必过项失败时 **Notice** |
| **一键四象限侧栏** | **`src/plugin/quadrantWorkspaceLayout.ts`**（`applyRslatteQuadrantWorkspaceLayout`：侧栏 horizontal 分两行 + `getLeaf("tab")` 页签）；**`applyBundledWorkspaceLayout.ts`** 为入口；**`obsidianCorePluginGate.ts`**（`isWorkspacesCorePluginEnabled`）；可选遗留 **`rslatte-workspace-preset.json`**（构建复制，非主路径） |
| Hub 视图 | `src/ui/views/SpaceHubView.ts`（告警区按空间页签、双灯、KPI 在告警子清单、卡片定位与 `hubAlertsBuilder`）；**Hub 辅助** `src/services/hub/`（`hubJournalSnapshot`） |
| 空间切换弹窗、添加空间 | `src/ui/modals/SpaceSwitcherModal.ts`, `AddSpaceModal.ts` |
| 常量 | `src/constants/space.ts` |
| 类型 | `src/types/space.ts`（**`spaceNumber`**） |

### 3.11 Pipeline（统一刷新/重建/同步）

| 角色 | 路径 |
|------|------|
| 引擎与协调器 | `src/services/pipeline/pipelineEngine.ts`, `src/services/pipeline/coordinator/index.ts` |
| 模块注册与 Spec 注册 | `src/services/pipeline/moduleRegistry.ts`, `specRegistry.ts`；**§8.1** `rebuildScopeSemantics.ts`；**§8.2** `helpers/archiveOrchestration.ts`（联系人/输出/项目「搬迁后」固定步骤；`main` / `outputManager` / `projectManager` 调用） |
| 各模块 Spec 实现 | `src/services/pipeline/specs/*.ts`（见上各节） |
| 类型 | `src/services/pipeline/types.ts`；`moduleSpec`（如存在） |
| 插件内 Pipeline 封装 | `src/plugin/pipelineManager.ts` |
| **索引 JSON 薄封装 [X-JSON-IO]** | `src/internal/indexJsonIo.ts`（`ensureFolderChain`、`pathExistsVaultOrAdapter`、`readJsonVaultFirst`、`readTextVaultFirst`、`writeJsonRaceSafe`、`writeTextRaceSafe`；见《索引优化方案》§8） |

#### §8.6 各 `*IndexStore` 与 `indexJsonIo`（勾选表 · 继续落地）

> **约定**：下列路径为业务主索引 / 队列 JSON 的**规范落点**；**已接** [X-JSON-IO]。**其它**仍用 `adapter.write` 写 JSON 的模块见表下说明，迁移时逐项改，勿与新索引混标准。

| 域 | `*IndexStore` 路径 | vault 优先读 | race-safe 写 | 备注 |
|----|-------------------|--------------|--------------|------|
| 任务 | `src/taskRSLatte/indexStore.ts` | `readJsonVaultFirst` | `writeJsonRaceSafe` | ✅ |
| 记录 | `src/recordRSLatte/indexStore.ts` | `readJsonVaultFirst` | `writeJsonRaceSafe` | ✅ 多子索引文件同套 API |
| 输出 | `src/outputRSLatte/indexStore.ts` | `readJsonVaultFirst` | `writeJsonRaceSafe` | ✅ |
| 项目 | `src/projectRSLatte/indexStore.ts` | `readJsonVaultFirst` | `writeJsonRaceSafe` | ✅ 含 archive-map、sync-queue |
| 联系人 | `src/contactsRSLatte/indexStore.ts` | `readTextVaultFirst` | `writeTextRaceSafe` | ✅ 主索引 + 互动索引走文本管线 + `safeJsonParse` |

**尚未纳入上表、仍常见裸 `adapter.write` 的索引类 JSON**（后续 P1 可迁 `indexJsonIo`）：`src/services/space/spacesIndexService.ts`；`src/services/knowledgeIndexWriter.ts`；`src/services/finance/financeAnalysisIndex.ts`、`financeAnalysisAlertIndex.ts`；`src/services/health/healthAnalysisIndex.ts`、`healthAnalysisAlertIndex.ts` 等。**新增**此类文件时不要复制上述模式，优先直接走 **`internal/indexJsonIo`**。

**入口约束（避免绕过 Atomic）**：

- 各模块 **`rebuild` 与 `scanFull`/`replaceAll` 主链路对照表**：见《索引优化方案》**§10**。  
- 侧栏/设置页等 **UI 手动刷新、重建、归档**，默认调用 `pipelineEngine.runE2(ctx, module, mode)`（`manual_refresh` / `rebuild` / `manual_archive`）。  
- 若模块已在 `specRegistry.ts` 合并 Atomic spec，**不要**在 UI 里直接调用底层 `indexWriter` / `refreshIndexNow` / 私有 service 作为主入口（否则会导致日志口径、门控与步骤链不一致）。  
- 仅在确有必要的例外场景（需写在对应方案文档）才允许绕过 `runE2`；例外代码旁需加注释说明原因与回归风险。  
- 新增模块接入时，优先补齐 Atomic 的 `scanIncremental + applyDelta`、`scanFull + replaceAll`、`getReconcileGate + stats`，并保持 debug 日志模板一致：`[RSLatte][module][mode] step start/done`。

**[X-Pipeline] 自动刷新（单轨）**：`src/services/pipeline/coordinator/index.ts` — **`tick` 一律 `engine.runE2`**（已移除 `AUTO_PIPELINE_ROUTE` / `engine.run` 分支）。`task` / `memo` / `schedule` 与 record/project/output/contacts/knowledge 等均依赖各自 **Atomic**；`schedule` 的 legacy 槽为占位，**不得**作自动调度主路径。**`project` / `output`** 的 legacy **`incrementalRefresh`** 为 **`USE_ATOMIC_SPEC`** 占位（仅 `engine.run` 兼容）。说明见 `moduleRegistry.ts` 文件头、`specRegistry.ts`；收敛审计见《索引优化方案》**§7.0.2**。

**[X-归档]**：记录类 **A**（`active` + `archive/` **单文件**）与任务/输出/项目等 **B**（**月分片 JSON + map**）对照见《索引优化方案》**§1.2**；§1.3 为文档化落地方案。维护 §3 各模块表时可旁注 **`[X-归档-A]`** / **`[X-归档-B]`**。

#### 3.11.1 归档中文用语（与《索引优化方案》**§9** 一致）

> 设置页「模块管理」表头旁有简述；代码标识符（`manual_archive`、`archiveNow`、`diaryArchive*` 等）**不改名**，文档与 UI 用下列中文 **区分语义**。

| 中文用语 | 含义（用户可见描述） | 典型代码 / 设置键（保留） |
|----------|----------------------|---------------------------|
| **笔记归档** | Vault 内 **移动** 笔记文件或项目文件夹，路径变更 | `projectArchiveDir` + `archiveDoneAndCancelledNow`；输出 `archiveRootDir` / `_archived`；联系人 `contactsModule.archiveDir` + `archiveContactsNow`；Capture `captureArchiveDir`（Inbox 整理） |
| **索引归档** | **不搬笔记正文**（或仅间接）：把条目从 **主索引 JSON** 迁到 `…/archive/` 分片，主索引瘦身 | `taskRSLatte.archiveNow` / `archiver.ts`；`recordRSLatte.archiveNow`；`outputRSLatte.archiveIndexForArchivedFiles`；`archiveProjectIndexByMonths`；Pipeline `runE2(..., "manual_archive")`（多数模块）；联系人互动 **`contactInteractionArchive`（溢出分片）** 亦属索引侧扩展 |
| **日记按月** | 日记文件按阈值移入 **`{{diaryPath}}/<YYYYMM>/`** | `diaryArchiveThresholdDays`、`diaryArchiveMonthDirName`、`archiveDiariesNow` / `autoArchiveDiariesIfNeeded` |

**复合**：**项目** 手动/自动归档常 **先笔记归档（文件夹）** 再 **索引归档**（`archiveIndexNow`）。**输出** 手动归档以 **笔记搬迁** 为主，并伴随 **主索引条目迁出**。

### 3.12 同步（DB/后端）

| 角色 | 路径 |
|------|------|
| API 客户端 | `src/api.ts` |
| 扫描与对账、刷新 | `src/rslatteSync/scanPipeline.ts`, `reconcileRunner.ts`, `upsertFlusher.ts` |
| 记录同步（打卡/财务等） | `src/plugin/recordSync.ts` |

### 3.13 日记与笔记

| 角色 | 路径 |
|------|------|
| 日记服务、笔记导航 | `src/services/journalService.ts`（含 **`readPanelsPreviewForDateKey`** / **`readPanelsSectionFullTextForDateKey`** / **`readPanelsSectionFullTextForVaultPath`**；**`ensureWeeklyOrMonthlyReportFile`** / **`getJournalPanelJumpLine1Based`**（Review 周期简报与子窗口跳转）；Today「今日记录」字数统计）, `noteNavigator.ts`（**`openNoteAtLineViewOnly`**：只读定位行）；**周期路径** `src/utils/periodReportPaths.ts`（`weekly/`、`monthly/` 在 **diaryPath 上一级**，与日记根目录同级） |
| 日记写入（插件能力） | `src/plugin/journalWriter.ts` |
| 弹窗 | `src/ui/modals/AddJournalPanelModal.ts` |

**V2 Capture 待整理 Inbox**：待整理条目写入、列表、归档与手动刷新均在 `journalWriter.ts`（`appendCaptureInbox`、`listCaptureInboxItems`、`getCaptureInboxBacklogCount`、`updateCaptureInboxLine`、`maybeArchiveCaptureFile`、`refreshCaptureInbox`）；**归档**：文件名按 `captureInboxFileNameFormat` 解析出的日期须 **早于** `getTaskTodayKey(taskPanel)`，且列表行仅剩 `[x]`/`[-]`（无 `[ ]`、`[/]`）；**当天 Inbox 不归档**。视图与时间轴为 `src/ui/views/CaptureView.ts`。

### 3.14 设置与全局 UI

| 角色 | 路径 |
|------|------|
| 设置页主入口 | `src/ui/settings/RSLatteSettingTab.ts`（折叠 **`summary`**：**全局/空间** 角标；语义见 `docs/V2改造方案/空间管理优化方案.md` **§6.4**；**全局配置** 内 **插件初始化环境检查 → 打开检查…**） |
| 各模块设置区块 | `src/ui/settings/sections/render*.ts`（见上各节） |
| 侧栏入口视图（今日打卡） | `src/ui/views/RSLatteSidePanelView.ts`；`src/constants/viewTypes.ts`（`WORKFLOW_VIEW_IDS` 等供工作台工作流条） |
| V2 工作流导航常量与映射 | `src/constants/viewTypes.ts`（`WorkflowViewId`、`WORKFLOW_TO_VIEW_TYPE`、`WORKFLOW_VIEW_LABELS`） |
| V2 知识库目录常量与路径 | `src/constants/v2Directory.ts`（00/10/20/30/90、`getV2DirectoryPaths`、`getEffectiveV2Root`） |

---

## 4. 视图类型与实现对应（VIEW_TYPE → View 类）

| 常量（viewTypes.ts） | 视图文件 |
|----------------------|----------|
| rslatte-sidepanel | RSLatteSidePanelView.ts |
| rslatte-taskpanel | TaskSidePanelView.ts |
| rslatte-projectpanel | ProjectSidePanelView.ts |
| rslatte-outputpanel | OutputSidePanelView.ts |
| rslatte-financepanel | FinanceSidePanelView.ts |
| rslatte-checkinpanel | CheckinSidePanelView.ts |
| rslatte-hub | SpaceHubView.ts |
| rslatte-stats-timeline | stats/TimelineView.ts |
| rslatte-calendar | CalendarView.ts（展示名「日程日历」；`activateCalendarView`） |
| rslatte-contactspanel | ContactsSidePanelView.ts（在 uiNavigation 中注册） |
| rslatte-capture | CaptureView.ts（V2 快速记录） |
| rslatte-today | TodayView.ts（V2：**今日执行**＝执行清单区+执行统计区；统计聚合 **`todayExecuteStats.ts`**；**今日重点**、**今日行动**、**等待/跟进**、**今日日程**、**超期/风险** 用 **`dayEntryCards.ts`**（日程另 `appendDayEntryScheduleCard`）；**项目推进** §1.3c→**`openProgressTabForProject`**；渲染前项目数据：**`!isEnsureReadySettled` 时 `tryReadPanelHydrateSnapshot` + `applyPanelHydrateSnapshot`，再 `projectMgr.ensureReady()`**；**今日核对** 子页签：`recordReconcileRender.ts` + `recordTodayModel.ts`（仅 `RecordLine` 类型）；**今日记录** 子页签：**`todayRecordsModel.ts`**（`buildTodayRecordsModel`）+ **`todayRecordsRender.ts`**（`renderTodayRecordsBody`）；跳转 **`uiNavigation.activateRSLatteView({ inspectSection })`** / **`activateFinanceView({ contentTab })`**；**`RSLatteSidePanelView`** 分区锚点 **`data-rslatte-inspect`**；**`FinanceSidePanelView.openLedgerContentTab` / `openStatsContentTab`**） |
| rslatte-knowledge | KnowledgeView.ts（V2：**随便看看 / 知识库概览 / 知识库清单**，含基础信息弹窗与知识索引驱动统计） |
| rslatte-knowledge-panel | KnowledgeView.ts（**`host: sidepanel`**，与 `rslatte-knowledge` 同 UI；**无单独命令**，新入口统一 **`activateKnowledgeView`（Hub）**；旧布局中已钉住的 panel leaf 仍可用；`activateKnowledgePanelView` 已等同 Hub 知识入口） |
| rslatte-review | ReviewView.ts（§4.3a 三子页签；**§4.2.2** 进行中刷新 / 手动多版本 / **`.completed.json`（E2）** / `reviewE2SnapshotSeal` / `reviewPeriodSnapshotStore` / `reviewPeriodCoverage` / **`ReviewHistorySnapshotModal`**；**§4.3** `activateReviewView`/`markPendingReviewOpen`/`ReviewDeepLinkOpts`；`reviewExecute*`、`reviewReconcile*`、`reviewRecords*`（含 **`reviewRecordsSummaryAnalysis`**）、`reviewTimelineNavigate`）；见 **`Review侧边栏优化方案.md`** |

### 4.1 V2 工作流页面 ID（阶段 1：Capture/Today 独立视图）

| 工作流 ID | 视图类型 | 说明 |
|-----------|----------|------|
| capture | rslatte-capture (CaptureView) | 统一快速记录：单一输入，保存为今日任务或待整理；待整理时间轴（按年/日分组、与任务清单样式一致）、状态圆点、四操作（转今日任务/已整理/取消/暂不处理）、手动刷新触发 00-Inbox 扫描与归档 |
| today | rslatte-today (TodayView) | **今日执行**：顶栏任务日+刷新；**执行清单**+**执行统计**（见上表）。**今日记录** / **今日核对** 为 Today 内子页签；见 `Today优化方案.md` §3 |
| projects | rslatte-projectpanel | 项目推进 |
| review | rslatte-review (ReviewView) | **周期回顾**：链式打开 **`plugin.activateReviewView({ grain, periodKey, periodOffset, subTab })`**；Hub 工作流按钮「回顾」→ `activateWorkflowView("review")` |
| knowledge | rslatte-knowledge (KnowledgeView) | 三页签：**随便看看**、**知识库概览**、**知识库清单**；发布到知识库 / 打回在输出侧栏 **发布管理** 页签 |
| worklog | rslatte-stats-timeline (TimelineView) | **操作日志**：Hub 工作流按钮「操作日志」→ `activateWorkflowView("worklog")` → **`plugin.activateTimelineView()`** |

工作流入口：RSLatte工作台 顶部「工作流」按钮区（**日程日历** → **今日打卡** → `WORKFLOW_VIEW_IDS`…）。激活：`plugin.activateWorkflowView(workflowId)`、`activateRSLatteView()`。命令：**打开侧边栏：快速记录** 等；`plugin.activateCaptureView()` 打开 Capture 并切到「记录」子页签（Today 执行统计等复用）。

**Today 与工作台**：Today 三子页签 **今日执行** / **今日核对** / **今日记录**（记录类打卡·财务·日记与跳转）；工作台（Dashboard）提供统计、多模块跳转与日志预览。

**今日核对**：仍在 **TodayView**「今日核对」子页签（非 Hub 工作流独立按钮；`buildTodayReconcileZonesModel` + `renderRecordReconcileBody` 等）；卡片点击：`openRecordLine`。**Knowledge**：KnowledgeView 三页签；发布到知识库 / 打回在输出侧栏 **发布管理** 页签。

**Review**：**`activateReviewView`/`markPendingReviewOpen`**（§4.3）+ **`ReviewView`**（§4.2.2：**进行中刷新**、手动多版本、**`.completed.json` E2 封印**、**回退仅手动**）。**E2 封印**：**`reviewE2SnapshotSeal.runE2SealPreviousPeriodReviewSnapshots`** ← **`pipelineManager` `runAutoRefreshTick`**（每空间 `tick` 后）。**快照/覆盖**：`reviewPeriodSnapshotStore`、`reviewPeriodCoverage`、`ReviewHistorySnapshotModal`。**执行**：`reviewExecuteModel`（`buildReviewExecuteModel(..., grain)`、**`reviewExecuteScheduleViz`**）+ **`reviewWorkEventPeriodStats`**（含 **`contactSamples`**）/`reviewExecuteRender`、**`reviewExecutePlainTextForPaste`**（贴周报/月报：A+C 摘要）；**核对**：`reviewReconcileModel`/`reviewReconcileRender`（A：**任务/日程/提醒**已闭环及时性；B：完成/新建环比 + **项目完结** + 日志 **发布/联系人事件** 环比；`periodFacts`：长周期完成输出等；C：建议；**无**开放项 D 区）；**记录**：`reviewRecordsModel`（**`reviewRecordsSummaryAnalysis`**）/`reviewRecordsRender`、`reviewTimelineNavigate`。方案 **`Review侧边栏优化方案.md`** §4.2.2 / §4.3 / §4.3a / §4.4 / §4.8 / **§4.3c·§4.10** / **§4.6.4**。

**Hub 与工作台**：Hub 副标题「空间与工作流入口」；工作台副标题「统计总览与各模块跳转」。**联系人关系中枢**：Knowledge 页底部「关系 · 联系人」跳转联系人视图；联系人视图内「联动 · 项目 / 任务管理」跳转项目与任务管理侧栏。**V2 目录**：`constants/v2Directory.ts` 定义 00-System/10-Personal/20-Work/30-Knowledge/90-Archive；设置项 `useV2DirectoryStructure`、`v2DirectoryRoot`；新内容写入路径可后续接轨。

---

## 5. 使用说明与维护约定

- **知识类产品与跨模块交互（输出 / 项目产出 / 发布·知识）**：见 `docs/V2改造方案/知识类管理优化方案.md`（与本文 **3.3 项目**、**3.4 输出**、**3.5 发布**、`KnowledgeView` 对照阅读）。
- **`src/` 目录治理、重复逻辑抽象与性能热点地图**：见 `docs/V2改造方案/代码结构优化方案.md`（与本文 **§1 目录结构**、**§3 各业务域** 对照阅读）。
- **按功能优化时**：在「3. 业务功能 → 代码路径清单」中查对应小节，只打开/引用列出的路径，可显著减少扫描与 token 消耗。
- **新增模块时**：在 `src/` 下增加目录或文件后，在本文档对应小节补充「角色 + 路径」行，并在 2/4 节补入口或视图映射。
- **移动/重命名文件时**：全局替换本文件中旧路径为新路径，并在「最后更新（按天）」补一条当天摘要。
- **维护节奏**：优先保证各功能小节路径准确；小型优化（样式微调、文案、轻微交互）可不写更新记录；仅在阶段性/结构性改动时记录，且同一天合并为一行。
