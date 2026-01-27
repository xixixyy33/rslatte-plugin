# main.ts 模块集成指南

## 已拆分的模块

1. ✅ **`src/plugin/spaceManagement.ts`** - 空间管理相关方法
2. ✅ **`src/plugin/pluginHelpers.ts`** - 插件辅助工具（调试日志、日期、路径）
3. ✅ **`src/plugin/contactsHandler.ts`** - 联系人链接处理相关方法
4. ✅ **`src/plugin/uiNavigation.ts`** - UI导航和视图激活相关方法
5. ⚠️ **`src/plugin/moduleEnablers.ts`** - 模块启用判断（部分，有私有字段访问问题）

## 集成步骤

### 1. 修复私有字段访问问题

由于这些模块需要访问 `main.ts` 中的私有字段，需要将相关私有字段改为 `protected`：

在 `main.ts` 中，将以下私有字段改为 `protected`：

```typescript
// 需要修改的字段（示例）
protected settingsSvc: SettingsService;  // 原来是 private
protected _dbSyncMeta: ...;  // 原来是 private
protected _financeSummaryKey: string = "";  // 原来是 private
// ... 其他需要访问的私有字段
```

或者，使用类型断言绕过检查（不推荐，但可以作为临时方案）：

```typescript
// 在模块中使用类型断言
const pluginAny = plugin as any;
pluginAny.settingsSvc = ...;
```

### 2. 在 main.ts 中集成模块

在 `main.ts` 的 `onload()` 方法中，导入并应用模块：

```typescript
import { createAllModules } from "./plugin/index";

export default class RSLattePlugin extends Plugin {
  // ... 现有代码

  async onload() {
    // ... 现有初始化代码

    // 应用所有拆分的模块
    Object.assign(this, createAllModules(this));

    // ... 其他代码
  }
}
```

或者在类的构造函数中应用：

```typescript
constructor(app: App, manifest: PluginManifest) {
  super(app, manifest);
  Object.assign(this, createAllModules(this));
}
```

### 3. 从 main.ts 中移除已拆分的方法

集成完成后，从 `main.ts` 中删除以下方法（它们已迁移到对应模块）：

#### spaceManagement.ts
- `getCurrentSpaceId()`
- `getSpaceConfig()`
- `getSpaceCtx()`
- `listSpaces()`
- `openSpaceSwitcher()`
- `switchSpace()`
- `refreshAllRSLatteViews()`
- `resetSpaceScopedCaches()`

#### pluginHelpers.ts
- `isDebugLogEnabled()`
- `dbg()`
- `getTodayKey()`
- `getOrCreateTodayState()`
- `getRSLattePanelIndexDir()`
- `getCentralIndexDir()`
- `getSpaceBaseDir()`
- `getSpaceIndexDir()`
- `getSpaceQueueDir()`
- `getSpaceStatsDir()`
- `getSpaceEventsDir()`

#### contactsHandler.ts
- `setupContactsLinkPostProcessor()`
- `bindContactLinksInEl()`
- `extractContactUidFromHref()`
- `closeContactLinkPopover()`
- `findContactByUid()`
- `resolveAvatarResourceFromItem()`
- `positionPopover()`
- `showContactLinkPopover()`

#### uiNavigation.ts
- `activateHubView()`
- `activateRSLatteView()`
- `activateTaskView()`
- `activateProjectView()`
- `activateOutputView()`
- `activateContactsView()`
- `ensureContactsPanelRegistered()`
- `closeContactsView()`
- `openTodayAtPanel()`
- `readTodayPanelsPreview()`
- `readTodayPanelText()`
- `openVaultPath()`
- `openFileAtLine()`
- `openNoteAtHeading()`

## 注意事项

1. **私有字段访问**：需要将相关私有字段改为 `protected` 或使用类型断言
2. **方法依赖**：确保拆分的模块中没有相互依赖的方法
3. **测试**：集成后需要测试所有功能是否正常

## 剩余未拆分的大模块

由于复杂性和私有字段依赖，以下模块建议保留在 `main.ts` 中或后续逐步迁移：

1. **Pipeline Engine** (`createPipelineEngine`) - 约500行，复杂
2. **Record 同步** (`autoSyncRecordListsToDb`, `autoSyncRecordIndexToDb` 等) - 约1000行
3. **Journal 写入** (`appendJournalByModule`, `writeTodayOutputProgressToJournal` 等) - 约300行
4. **Output 管理** (`syncOutputFilesToDb`, `archiveOutputFilesNow` 等) - 约500行
5. **Contacts DB 同步** (`tryContactsDbSyncByPaths`, `archiveContactsNow` 等) - 约700行
6. **自动刷新** (`setupAutoRefreshTimer`, `runAutoRefreshTick` 等) - 约300行

这些模块可以在后续根据需要逐步拆分。
