/**
 * 插件模块统一入口
 * 将所有拆分的模块整合到一起，方便在 main.ts 中统一应用
 */

import type RSLattePlugin from "../main";
import { createSpaceManagement } from "./spaceManagement";
import { createPluginHelpers } from "./pluginHelpers";
import { createContactsHandler } from "./contactsHandler";
import { createUiNavigation } from "./uiNavigation";
import { createCore } from "./core";
import { createJournalWriter } from "./journalWriter";
import { createOutputManager } from "./outputManager";
import { createRecordSync } from "./recordSync";
import { createPipelineManager } from "./pipelineManager";
import { createMobileSync } from "./mobileSync";

/**
 * 将所有模块混入到主插件类
 * 使用方法：
 * 
 * export default class RSLattePlugin extends Plugin {
 *   // ... 属性声明
 *   
 *   async onload() {
 *     // ... 初始化代码
 *     
 *     // 应用所有模块
 *     Object.assign(this, createAllModules(this));
 *   }
 * }
 */
export function createAllModules(plugin: RSLattePlugin) {
  return {
    ...createSpaceManagement(plugin),
    ...createPluginHelpers(plugin),
    ...createContactsHandler(plugin),
    ...createUiNavigation(plugin),
    ...createCore(plugin),
    ...createJournalWriter(plugin),
    ...createOutputManager(plugin),
    ...createRecordSync(plugin),
    ...createPipelineManager(plugin),
    ...createMobileSync(plugin),
  };
}
