# 手机端手账数据管理设计方案

## 1. 目标与范围

- **数据来源**：利用现有后端 DB 同步数据。
- **手机端形态**：PWA（Progressive Web App），支持内网同步与外网离线。
- **手机端能力**：备忘（新增、提醒）、任务（新增、更新状态）、打卡（仅今日）、财务（仅今日）。
- **后端策略**：接口仅内网可访问；外网时手机离线使用，连回内网后上传离线操作并拉取最新数据。
- **Obsidian 插件**：提供「从手机同步」按钮，从数据库拉取手机操作记录，将备忘/任务/打卡/财务刷新到对应 MD，并生成事件来源为「手机」的操作记录。

## 2. 整体架构

```
┌─────────────────┐     内网      ┌─────────────────┐     同步      ┌─────────────────┐
│  手机 PWA       │ ◄──────────► │  后端 API       │ ◄──────────► │  Obsidian 插件   │
│  备忘/任务/     │  上传离线记录  │  DB + 手机操作   │  拉取手机操作  │  写入 MD +       │
│  打卡/财务(今日)│  拉取活跃数据  │  记录存储       │  写入本地     │  写 WorkEvent    │
└─────────────────┘              └─────────────────┘              └─────────────────┘
        │                                  │                                  │
        │ 外网离线                          │ 仅内网                             │ 与现有
        ▼                                  ▼                                   ▼
  本地 IndexedDB/                         PostgreSQL/                     Vault MD +
  离线操作队列                            mobile_ops 等                     JSONL 事件
```

## 3. 后端接口约定

### 3.1 手机操作记录（供 Obsidian 拉取）

- **GET** `/mobile/ops?since=<iso>&limit=<n>`
  - `since`：可选，只返回该时间之后的操作。
  - `limit`：可选，默认 200，最大 500。
- **响应**：`{ ok: boolean, ops: MobileOp[], next_since?: string }`

**MobileOp 结构**（与 `api.ts` 中类型一致）：

- `id`: string
- `ts`: string (ISO)
- `kind`: `"memo"` | `"task"` | `"checkin"` | `"finance"`
- `action`: `"create"` | `"update"` | `"delete"`
- `payload`: 见下
- `applied?`: boolean（后端是否已写入主表，如打卡/财务通常为 true）

**payload 示例**：

- **checkin**: `{ record_date, checkin_id, note?, is_delete? }`
- **finance**: `{ record_date, category_id, amount, note?, is_delete? }`
- **task**: `{ uid?, text, status?, due_date?, file_path?, line_no?, ... }`
- **memo**: `{ text, memo_date?, remind_days?, file_path?, ... }`

### 3.2 手机端上传离线操作（供 PWA 调用）

- **POST** `/mobile/ops/upload`
  - Body: `{ ops: MobileOp[] }`
  - 后端落库「手机操作记录」；打卡/财务可同时写入主表（或由定时任务合并）。

### 3.3 手机端拉取最新数据（连回内网后）

- 备忘/任务：拉取「当前活跃」列表（如 GET /rslatte-items 或现有任务/备忘接口），用于覆盖 PWA 本地缓存。
- 打卡/财务：拉取「今日」打卡记录与财务记录（如现有 `listCheckinRecords` / `listFinanceRecords` 今日范围），以及打卡项/财务分类清单；PWA 仅展示当日打卡状态与当日财务条目。

## 4. 手机 PWA 行为简述

- **外网**：所有操作仅写本地（IndexedDB + 离线队列），可设置提醒、查看当日打卡/财务状态（基于上次同步的清单与今日数据缓存）。
- **内网**：
  1. 上传离线操作队列到 `POST /mobile/ops/upload`；
  2. 拉取备忘与任务最新活跃数据，刷新本地；
  3. 拉取打卡项/财务分类清单 + 今日打卡/今日财务，仅展示当日状态。

## 5. Obsidian 插件行为（已实现与扩展点）

### 5.1 已实现

- **事件来源**：`WorkEventSource` 增加 `"mobile"`，所有由「从手机同步」产生的操作记录均带 `source: "mobile"`。
- **API**：`listMobileOps(params?)`，调用 `GET /mobile/ops`，未实现时返回 `{ ok: false, ops: [] }` 不阻塞。
- **从手机同步**（`syncFromMobile()`）：
  1. 拉取手机操作记录（`listMobileOps`）；
  2. 对每条 **checkin**：写入中央索引 + 今日日记对应 H2，并追加一条 `source: "mobile"` 的 WorkEvent；
  3. 对每条 **finance**：同上；
  4. 对 **task / memo**：当前仅写入 WorkEvent（source: "mobile"），不直接写 MD；
  5. 同步结束后，强制从 DB 刷新今日打卡/今日财务状态（`syncTodayCheckinsFromDb(true)`、`syncTodayFinancesFromDb(true)`），并刷新侧边栏。
- **入口**：
  - 今日检查侧边栏标题右侧「📱」按钮；
  - 命令：`rslatte-sync-from-mobile`（「从手机同步」）。

### 5.2 扩展点（任务/备忘写入 MD）

- 若后端在手机操作记录中携带 `file_path` / `line_no` 或能映射到「应写入的日记/文件」，插件可在此处扩展：按 `task` / `memo` 的 payload 调用现有任务/备忘写入逻辑，将内容写入对应 MD，再写 WorkEvent。
- 也可采用「仅同步 DB 状态 + 插件侧重建索引」的方式：后端将手机端的任务/备忘同步到现有任务/备忘表，Obsidian 通过现有「从 DB 拉取」流程」间接获得更新，无需在 `syncFromMobile` 中单独写 MD。

## 6. 数据流小结

| 端     | 内网时 | 外网时 |
|--------|--------|--------|
| 手机   | 上传离线操作；拉取最新备忘/任务与当日打卡/财务 | 仅本地操作，记入离线队列 |
| 后端   | 接收上传、落库手机操作与主表；提供 `/mobile/ops` 与现有 API | 不可达 |
| Obsidian | 点击「从手机同步」→ 拉取 `/mobile/ops` → 写打卡/财务到 MD 与索引，写 WorkEvent(source: mobile)，并刷新今日状态 | 不同步（或可提示「需内网」） |

## 7. 参考文件

- 类型与 API：`src/api.ts`（MobileOp*、listMobileOps）
- 同步逻辑：`src/plugin/mobileSync.ts`
- 事件来源：`src/types/stats/workEvent.ts`、`src/services/workEventService.ts`（WorkEventSource）
- 今日检查 UI：`src/ui/views/RSLatteSidePanelView.ts`（📱 按钮）
- 命令注册：`src/main.ts`（rslatte-sync-from-mobile）
