# RSLatte Plugin

> Build Your Life with Flavor

RSLatte 是 Obsidian 插件，用于管理任务、项目、输出文档、财务、打卡、联系人、备忘等，并提供数据同步、统计分析与自动归档。

## 功能概览

| 模块 | 说明 |
|------|------|
| 任务 | 任务追踪、状态管理、自动归档 |
| 项目 | 项目、里程碑、任务清单 |
| 输出 | 输出文档管理、模板创建 |
| 发布 | 发布记录与渠道追踪 |
| 打卡 | 日常打卡、热力图 |
| 财务 | 收支流水、分类统计 |
| 联系人 | 联系人信息、生日提醒 |
| 备忘 | 备忘事项 |
| 工作台 | 信息概览、统计分析 |
| 同步 | 与后端数据库 / 手机端同步 |

## 安装

1. 打开 Obsidian → 设置 → 第三方插件 → 关闭安全模式
2. 浏览社区插件，搜索 **RSLatte** 安装；或从 [Releases](https://github.com/xixixyy33/rslatte-plugin/releases) 下载 `main.js`、`manifest.json`、`styles.css`，放入库的 `/.obsidian/plugins/rslatte-plugin/` 目录
3. 启用插件

## 快速开始

- **中央索引目录**：默认 `95-Tasks/.rslatte`，可在设置中修改
- **API 同步**：设置 → RSLatte → 填写 API 基础地址、Vault ID
- **模块开关**：在设置中按需启用任务、项目、财务等模块

## 文档

- [用户手册](docs/用户手册.md) — 功能说明与使用技巧
- [集成指南](docs/INTEGRATION_GUIDE.md) — 嵌入其他插件 / 二次开发
- [侧边栏快捷键](docs/SIDEBAR_SHORTCUTS.md) — 命令与快捷键

## 开发与构建

```bash
npm install
npm run build          # 构建插件
npm run build:release  # 构建并同步到 plugin-release / code-release
```

## 环境要求

- Obsidian 1.5.0+
- 仅桌面端（`isDesktopOnly`）

## 许可证

ISC

## 作者

xixi
