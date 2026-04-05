# 用户手册配图（`docs/manual-screenshots/`）

将实际界面截图保存为 **PNG**（建议宽度约 1200～1600px，兼顾清晰度与体积），**文件名**与下表「文件名」列一致，放入**本目录**。

## 与 `用户手册.md` 的对应关系

在 `docs/用户手册.md` 中搜索 **`〔截图`** 或 **`<!-- screenshot:`** 可定位每个预留块；补齐图片后，可将该预留块**整段替换**为下列任一形式（按发布渠道选择）。

**Markdown（相对 `用户手册.md`）**

```markdown
![简述画面内容](manual-screenshots/01-command-palette-rslatte.png)
```

**Obsidian 库内（若手册与图片均在库中）**

```markdown
![[manual-screenshots/01-command-palette-rslatte.png]]
```

替换后可选：删除原 HTML 注释 `<!-- screenshot:... -->`，避免重复。

## 文件名清单

| 编号 | 文件名 | 建议画面内容 |
|------|--------|----------------|
| 00 | `00-enable-plugin.png` | 第三方插件列表，RSLatte 已启用 |
| 01 | `01-command-palette-rslatte.png` | 命令面板搜索 `RSLatte` |
| 02 | `02-ribbon-rslatte.png` | 左侧功能区 RSLatte 图标 |
| 03 | `03-plugin-env-check-modal.png` | 插件初始化环境检查弹窗 |
| 04 | `04-settings-module-management.png` | 设置中的模块管理/开关 |
| 05 | `05-after-bundled-workspace-layout.png` | 载入内置工作区后的窗口布局 |
| 06 | `06-hub-workspace.png` | RSLatte 工作台（Hub） |
| 07 | `07-sidepanel-today-checkin.png` | 今日打卡侧栏 |
| 08 | `08-sidepanel-tasks.png` | 任务侧栏 |
| 09 | `09-sidepanel-schedule-calendar.png` | 日程日历侧栏 |
| 10 | `10-output-and-publish.png` | 输出侧栏与/或发布到知识库弹窗（可另增 `10b-…`） |
| 11 | `11-view-knowledge.png` | 知识视图（含页签） |
| 12 | `12-sidepanel-checkin.png` | 打卡侧栏 |
| 13 | `13-sidepanel-finance.png` | 财务侧栏 |
| 14 | `14-sidepanel-health.png` | 健康侧栏 |
| 15 | `15-view-capture.png` | 快速记录（Capture） |
| 16 | `16-view-today.png` | 今天（Today） |
| 17 | `17-sidepanel-projects.png` | 项目侧栏 |

如需补充 **回顾（Review）**、**操作日志**、**联系人** 等图，可新增 `18-…`、`19-…` 并在 `用户手册.md` 相应小节旁增加与现有一致的预留块。
