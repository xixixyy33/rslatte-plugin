/**
 * ModuleRegistry (A2)
 *
 * 目标：管理 7 个模块的 ModuleSpec（task/memo/checkin/finance/project/output/contacts），
 * 支持注册与枚举，供后续 coordinator 编排。
 *
 * ⚠️ 本文件仅提供注册表能力与默认 registry（占位 spec）：不接入现有逻辑，不改任何调用点。
 */

import type { RSLatteModuleKey } from "./types";
import type { ModuleSpecAny, ModuleSpecAtomic, ModuleSpecLegacy } from "./moduleSpec";
import { createPlaceholderSpec, isAtomicSpec, isLegacySpec } from "./moduleSpec";

/**
 * Step S5: Registry 内部存储分层：legacy 与 atomic 分离
 * - legacy?: ModuleSpecLegacy
 * - atomic?: ModuleSpecAtomic
 *
 * 对外使用明确 getter（getLegacy/getAtomic），避免“猜 spec 形态”。
 */
export type ModuleRegistryEntry = {
  key: RSLatteModuleKey;
  /** 展示名（用于 UI/日志） */
  label: string;
  /** 兼容字段：历史版本使用 name */
  name?: string;

  legacy?: ModuleSpecLegacy;
  atomic?: ModuleSpecAtomic;
};

export class ModuleRegistry {
  private readonly entries = new Map<RSLatteModuleKey, ModuleRegistryEntry>();

  /** 注册（同 key 覆盖写入） */
  /**
   * 兼容注册：允许传入 legacy/atomic/二者兼容的 spec。
   * - 若 spec 同时具备 legacy+atomic 能力，则两个槽位都填充。
   * - 若只具备其一，则仅填充对应槽位。
   */
  register(spec: ModuleSpecAny): void {
    const entry: ModuleRegistryEntry = {
      key: spec.key,
      label: (spec as any).label ?? (spec as any).name ?? spec.key,
      name: (spec as any).name,
      legacy: isLegacySpec(spec) ? (spec as ModuleSpecLegacy) : undefined,
      atomic: isAtomicSpec(spec) ? (spec as ModuleSpecAtomic) : undefined,
    };
    this.entries.set(spec.key, entry);
  }

  /** 注册 legacy spec（仅填 legacy 槽位） */
  registerLegacy(spec: ModuleSpecLegacy): void {
    const prev = this.entries.get(spec.key);
    const entry: ModuleRegistryEntry = {
      key: spec.key,
      label: (spec as any).label ?? (spec as any).name ?? spec.key,
      name: (spec as any).name,
      legacy: spec,
      atomic: prev?.atomic,
    };
    this.entries.set(spec.key, entry);
  }

  /** 注册 atomic spec（仅填 atomic 槽位） */
  registerAtomic(spec: ModuleSpecAtomic): void {
    const prev = this.entries.get(spec.key);
    const entry: ModuleRegistryEntry = {
      key: spec.key,
      label: (spec as any).label ?? (spec as any).name ?? spec.key,
      name: (spec as any).name,
      legacy: prev?.legacy,
      atomic: spec,
    };
    this.entries.set(spec.key, entry);
  }

  /** Step S5: 明确 getter：只取 legacy */
  getLegacy(key: RSLatteModuleKey): ModuleSpecLegacy | undefined {
    return this.entries.get(key)?.legacy;
  }

  /** Step S5: 明确 getter：只取 atomic */
  getAtomic(key: RSLatteModuleKey): ModuleSpecAtomic | undefined {
    return this.entries.get(key)?.atomic;
  }

  /** 是否已注册 */
  has(key: RSLatteModuleKey): boolean {
    return this.entries.has(key);
  }

  /** 枚举 keys（按插入顺序） */
  listKeys(): RSLatteModuleKey[] {
    return Array.from(this.entries.keys());
  }

  /** 清空（测试/重置用） */
  clear(): void {
    this.entries.clear();
  }
}

/** 默认支持的 8 个模块（顺序固定，便于后续 coordinator/UI） */
export const DEFAULT_MODULE_KEYS: RSLatteModuleKey[] = [
  "task",
  "memo",
  "checkin",
  "finance",
  "project",
  "output",
  "contacts",
  "publish",
];

/**
 * 创建默认 registry：
 * - 注册 8 个模块的 placeholder spec（接口齐全，便于后续逐步 bridge 到旧逻辑）
 */
export function createDefaultModuleRegistry(
  overrides?: Partial<Record<RSLatteModuleKey, ModuleSpecAny>>
): ModuleRegistry {
  const reg = new ModuleRegistry();

  const regOne = (key: RSLatteModuleKey, label: string) => {
    const o = overrides?.[key];
    if (o) return reg.register(o);
    // placeholder 默认只提供 legacy 能力
    return reg.registerLegacy(createPlaceholderSpec(key, label));
  };

  regOne("task", "Task");
  regOne("memo", "Memo");
  regOne("checkin", "Checkin");
  regOne("finance", "Finance");
  regOne("project", "Project");
  regOne("output", "Output");
  regOne("contacts", "Contacts");
  regOne("publish", "Publish");

  return reg;
}

/** 便捷导出：默认 registry 实例（后续接入时可以直接引用/替换） */
// NOTE: do not export a shared singleton registry; main.ts creates a registry instance per plugin.
