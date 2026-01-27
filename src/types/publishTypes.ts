export type PublishRecord = {
  /** 发布通道 */
  channel: string;
  /** 发布时间 (YYYY-MM-DD) */
  publishDate: string;
  /** 发布文档关联（去掉敏感信息的文档存档位置） */
  relatedDocPath?: string;
  /** 发布说明 */
  note?: string;
  /** 记录时间戳 */
  timestamp?: string;
};

export type PublishIndexItem = {
  /** 文件路径 */
  filePath: string;
  /** 文件标题（basename） */
  title: string;
  /** 文档分类 */
  docCategory?: string;
  /** 领域列表 */
  domains?: string[];
  /** 类型 */
  type?: string;
  /** 发布类型（从文件属性中读取，对应发布通道） */
  publishType?: string;
  /** 发布记录列表 */
  publishRecords: PublishRecord[];
  /** 文件创建时间 */
  ctimeMs?: number;
  /** 文件修改时间 */
  mtimeMs?: number;
  /** 创建日期 (YYYY-MM-DD) */
  createDate?: string;
};

export type PublishIndexFile = {
  version: number;
  updatedAt: string;
  items: PublishIndexItem[];
};

export type PublishPanelSettings = {
  /** 发布管理的文档目录（可指定多个） */
  documentDirs: string[];
  /** 发布通道选项列表 */
  publishChannels: string[];
};
