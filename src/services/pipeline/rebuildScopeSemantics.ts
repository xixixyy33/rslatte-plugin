/**
 * Pipeline Atomic：**索引重建**与**物理归档后索引对齐**的语义标签（《代码结构优化方案》§8.1）。
 *
 * ## `rebuildActiveOnly`（常量 {@link PIPELINE_REBUILD_ACTIVE_ONLY}）
 *
 * 指 `runE2` 下 **`rebuild` / `manual_refresh` / `auto_refresh`** 的 **`replaceAll`（及联系人侧的本地索引写回）**所代表的**日常本地重建**口径：
 * - 以业务**活跃根**为主，**不**为降低成本去全量遍历模块配置的**物理归档树**（各模块实现细节见对应 `*SpecAtomic`）。
 * - **联系人**：`rebuildAndWrite`，`listContactFiles` 排除 `archiveDir`。
 * - **项目**：`refreshAll`，子文件夹枚举跳过 `projectArchiveDir`。
 * - **输出**：`refreshIndexNow({ mode: "full" })`；是否扩展遍历旧归档树由 **`outputPanel.fullRebuildScanLegacyArchiveDirs`** 决定。
 *
 * 注意：**`scanFull`** 在部分模块仅用于门控/差分元数据，其遍历范围**可以**与 `replaceAll` 最终 I/O 不完全一致（输出模块见 `outputSpecAtomic` 内注释）。
 *
 * ## `rebuildAfterPhysicalArchive`（常量 {@link PIPELINE_REBUILD_AFTER_PHYSICAL_ARCHIVE}）
 *
 * 指 Vault 内**笔记/文件夹已迁到归档目的地之后**，刷新索引与分片、使 JSON 与磁盘对齐的路径：
 * - **联系人**：`archiveContactsNow` / `manual_archive` 末尾 **`rebuildContactsAllIndexes`**。
 * - **项目**：`archiveDoneAndCancelledNow` 末尾 **`archiveIndexNow`**（含 `archiveProjectIndexByMonths`）。
 * - **输出**：物理搬迁 + **`archiveIndexForArchivedFiles`** 等与 `outputRSLatte` / `outputManager` 编排一致。
 *
 * 新模块接 Atomic 时：在 `create*SpecAtomic` 文件头标明上述标签，并在 {@link PIPELINE_ATOMIC_REBUILD_SCOPE_REGISTRY} 增一行登记。
 */

/** 日常 Pipeline 重建（活跃根为主，不默认全扫归档树） */
export const PIPELINE_REBUILD_ACTIVE_ONLY = "rebuildActiveOnly" as const;

/** 物理归档完成后的主索引 / 归档分片 / 双索引对齐 */
export const PIPELINE_REBUILD_AFTER_PHYSICAL_ARCHIVE = "rebuildAfterPhysicalArchive" as const;

export type PipelineRebuildScopeTag =
  | typeof PIPELINE_REBUILD_ACTIVE_ONLY
  | typeof PIPELINE_REBUILD_AFTER_PHYSICAL_ARCHIVE;

/** 维护者查表：各模块 `replaceAll`/本地写回 与 `archiveOutOfRange` 对应的 §8.1 语义（非运行时分支） */
export const PIPELINE_ATOMIC_REBUILD_SCOPE_REGISTRY: Record<
  string,
  {
    readonly replaceAllLocalRebuild: PipelineRebuildScopeTag;
    readonly archiveOutOfRange: PipelineRebuildScopeTag | "n/a";
    readonly notes?: string;
  }
> = {
  contacts: {
    replaceAllLocalRebuild: PIPELINE_REBUILD_ACTIVE_ONLY,
    archiveOutOfRange: PIPELINE_REBUILD_AFTER_PHYSICAL_ARCHIVE,
    notes: "§8.5：本地 rebuildAndWrite 仅 active；buildOps/flushQueue 经 listAllContactMdPathsForDbSync 主+归档全量 upsert（contactsSpecAtomic 文件头）。",
  },
  project: {
    replaceAllLocalRebuild: PIPELINE_REBUILD_ACTIVE_ONLY,
    archiveOutOfRange: PIPELINE_REBUILD_AFTER_PHYSICAL_ARCHIVE,
    notes: "refreshAll 排除 projectArchiveDir；归档末尾 archiveIndexNow。",
  },
  output: {
    replaceAllLocalRebuild: PIPELINE_REBUILD_ACTIVE_ONLY,
    archiveOutOfRange: PIPELINE_REBUILD_AFTER_PHYSICAL_ARCHIVE,
    notes: "replaceAll→refreshIndexNow(full)；scanFull 差分可能含 archive 根路径，与 fullRebuildScanLegacyArchiveDirs 并存时以服务端实现为准。",
  },
};
