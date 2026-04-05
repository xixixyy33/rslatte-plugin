# RSLatte 侧边栏与工作流快捷方式

本文基于当前代码中的命令注册与协议处理器整理（`src/main.ts`）。

## 使用方法

### 方式一：按命令 ID 打开（推荐）

无需额外插件，直接在笔记里写：

```markdown
[链接文本](obsidian://rslatte-command?command=命令ID)
```

例如：

```markdown
[打开 RSLatte 工作台](obsidian://rslatte-command?command=rslatte-hub-open)
```

### 方式二：按模块名打开（更易读）

插件还支持模块名 URI（中英文/旧别名均有兼容）：

```markdown
[链接文本](obsidian://rslatte-open?module=模块名)
```

例如：

```markdown
[打开今日打卡](obsidian://rslatte-open?module=今日打卡)
[打开Today](obsidian://rslatte-open?module=today)
[打开设置](obsidian://rslatte-open?module=设置)
```

> 说明：`obsidian://advanced-uri?...` 仍可用，但依赖 Advanced URI 插件；优先使用上面两种原生方式。

---

## 最新命令 ID 清单

### 工作流与总览

- **RSLatte 工作台**
  ```markdown
  [打开工作台](obsidian://rslatte-command?command=rslatte-hub-open)
  ```
- **快速记录（Capture）**
  ```markdown
  [打开快速记录](obsidian://rslatte-command?command=rslatte-capture-open)
  ```
- **今天（Today）**
  ```markdown
  [打开今天](obsidian://rslatte-command?command=rslatte-open-today-view)
  ```
- **回顾（Review）**
  ```markdown
  [打开回顾](obsidian://rslatte-command?command=rslatte-open-review-panel)
  ```

### 业务侧边栏

- **今日打卡**
  ```markdown
  [打开今日打卡](obsidian://rslatte-command?command=rslatte-open-sidepanel)
  ```
- **任务**
  ```markdown
  [打开任务](obsidian://rslatte-command?command=rslatte-open-taskpanel)
  ```
- **项目**
  ```markdown
  [打开项目](obsidian://rslatte-command?command=rslatte-open-project-panel)
  ```
- **输出**
  ```markdown
  [打开输出](obsidian://rslatte-command?command=rslatte-open-output-panel)
  ```
- **知识管理（工作台）**
  ```markdown
  [打开知识管理](obsidian://rslatte-command?command=rslatte-open-publish-panel)
  ```
- **日程日历**
  ```markdown
  [打开日程日历](obsidian://rslatte-command?command=rslatte-open-calendar)
  ```
- **财务**
  ```markdown
  [打开财务](obsidian://rslatte-command?command=rslatte-open-finance-panel)
  ```
- **健康**
  ```markdown
  [打开健康](obsidian://rslatte-command?command=rslatte-open-health-panel)
  ```
- **打卡**
  ```markdown
  [打开打卡](obsidian://rslatte-command?command=rslatte-open-checkin-panel)
  ```
- **联系人**
  ```markdown
  [打开联系人](obsidian://rslatte-command?command=rslatte-open-contacts-panel)
  ```
- **操作日志（时间轴）**
  ```markdown
  [打开操作日志](obsidian://rslatte-command?command=rslatte-open-timeline)
  ```

### 工具与辅助

- **打开 RSLatte 设置**
  ```markdown
  [打开RSLatte设置](obsidian://rslatte-command?command=rslatte-open-settings)
  ```
- **切换空间**
  ```markdown
  [切换空间](obsidian://rslatte-command?command=rslatte-space-switch)
  ```
- **载入 RSLatte 内置工作区布局**
  ```markdown
  [载入内置布局](obsidian://rslatte-command?command=rslatte-load-bundled-workspace)
  ```
- **清空左右侧栏（不载入四象限）**
  ```markdown
  [清空左右侧栏](obsidian://rslatte-command?command=rslatte-clear-left-right-sidebars)
  ```
- **插入联系人信息（编辑器中）**
  ```markdown
  [插入联系人信息](obsidian://rslatte-command?command=rslatte-contacts-insert-reference)
  ```

---

## 可直接复制的快捷入口组

```markdown
## RSLatte 快速入口

- [🏠 工作台](obsidian://rslatte-command?command=rslatte-hub-open)
- [✍️ 快速记录](obsidian://rslatte-command?command=rslatte-capture-open)
- [🌤 今天](obsidian://rslatte-command?command=rslatte-open-today-view)
- [🔁 回顾](obsidian://rslatte-command?command=rslatte-open-review-panel)
- [📒 今日打卡](obsidian://rslatte-command?command=rslatte-open-sidepanel)
- [📋 任务](obsidian://rslatte-command?command=rslatte-open-taskpanel)
- [📁 项目](obsidian://rslatte-command?command=rslatte-open-project-panel)
- [📄 输出](obsidian://rslatte-command?command=rslatte-open-output-panel)
- [📚 知识](obsidian://rslatte-command?command=rslatte-open-publish-panel)
- [📅 日程日历](obsidian://rslatte-command?command=rslatte-open-calendar)
- [⚙️ 设置](obsidian://rslatte-command?command=rslatte-open-settings)
```

---

## 兼容说明

- URI 执行层对部分旧 ID 仍有兼容映射（例如 `rslatte-dashboard-open`、`rslatte-apply-recommended-workspace`），用于历史笔记链接迁移。
- 旧 ID 不保证继续出现在命令面板中；新文档建议统一使用本文“最新命令 ID 清单”。

## 注意事项

1. 这些链接需要在 Obsidian 内点击才会生效。
2. 请确保 RSLatte 插件已启用。
3. 若将来命令 ID 调整，需要同步更新笔记中的 URI。
