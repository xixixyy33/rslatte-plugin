# RSLatte Plugin

> Build Your Life with Flavor

RSLatte 是面向 Obsidian 桌面端的个人管理插件，围绕「执行 + 产出 + 生活记录」构建一体化工作流：  
任务、项目、输出、知识、财务、打卡、健康、联系人、日程、回顾、操作日志等能力统一在同一笔记库中协同运行。

## 当前版本能力

- **工作流入口**：工作台（Hub）、快速记录（Capture）、今天（Today）、回顾（Review）
- **业务侧边栏**：任务、项目、输出、知识管理、日程日历、今日打卡、财务、健康、打卡、联系人、操作日志
- **知识与输出联动**：输出发布到知识库、知识视图浏览
- **空间与索引**：多空间、中央索引目录、刷新/重建/归档
- **可选后端同步**：按模块控制 DB 同步（需配置 API Base URL 与 Vault ID）

## 安装

1. 打开 Obsidian → **设置** → **第三方插件**（按需关闭安全模式）
2. 社区插件搜索 **RSLatte** 安装；或从 [Releases](https://github.com/xixixyy33/rslatte-plugin/releases) 下载发布文件手动安装
3. 启用插件

## 快速开始

1. 打开 **RSLatte 设置**，先完成 **插件初始化环境检查**
2. 完成初始化后，按需启用模块（任务/项目/输出/财务等）
3. 建议先执行一次 **载入 RSLatte 内置工作区布局**
4. 从 **RSLatte 工作台** 或命令面板开始使用

## 文档

- [用户指南 / 用户手册](docs/用户指南/用户手册.md)（推荐入口）
- [用户指南 / 特性详解索引](docs/用户指南/特性详解/README.md)
- [侧边栏与工作流快捷方式](docs/SIDEBAR_SHORTCUTS.md)
- [产品介绍](docs/产品介绍.md)
- [代码地图](docs/CODE_MAP.md)

## 开发与构建

```bash
npm install
npm run build          # 构建 main.js
npm run build:release  # 构建并执行 sync-release.js
```

`build:release` 默认会同步到：

- `plugin-release/rslatte-plugin`（构建产物）
- `public-release/rslatte-plugin`（分发目录 + zip）
- `code-release/rslatte-plugin`（源码发布目录，已按规则过滤敏感/历史方案内容）

## 环境要求

- Obsidian `1.5.0+`
- 仅桌面端（`isDesktopOnly: true`）

## 许可证

[ISC](LICENSE)

## 作者

xixi
