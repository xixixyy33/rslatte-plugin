export type SpaceId = string;

import type { RSLattePluginSettings } from "./settings";

/**
 * Space 配置（Step F0：仅承载元信息；后续 Step 会逐步把模块配置下沉到 space）
 */
export interface RSLatteSpaceConfig {
  /** UUID（与后端一致） */
  id: SpaceId;
  /** 展示名称 */
  name: string;
  /**
   * 业务空间编号（1=默认空间；其余为 2/4/5/6/7/8，见《空间管理优化方案》）。
   * 用于默认根前缀 `{n}0-` 与路径片段拼接，与 id 独立存储。
   */
  spaceNumber?: number;
  /** ISO string */
  createdAt?: string;
  /** ISO string */
  updatedAt?: string;

  /**
   * ✅ Space 级设置快照（Step F5 引入）。
   *
   * 设计说明：为了避免把“按 space 取设置”这件事侵入所有模块（大量改动），
   * 我们采用“切换 space 时交换 settings 中的 space-scoped 字段”的方式：
   * - 全局 settings 保持为“当前 space 的有效设置”
   * - spaces[spaceId].settingsSnapshot 持久化每个 space 的独立配置
   *
   * 后续若需要完全 ctx 化，再逐步改为按 ctx 读取。
   */
  settingsSnapshot?: Partial<RSLattePluginSettings>;
}

/**
 * SpaceCtx：后续所有索引/队列/归档/DB 同步都会以 ctx 作为唯一入口。
 */
export interface SpaceCtx {
  vaultId: string;
  spaceId: SpaceId;
  space: RSLatteSpaceConfig;
}
