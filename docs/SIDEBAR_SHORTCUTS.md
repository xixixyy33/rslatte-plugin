# RSLatte 侧边栏快捷方式

在 Markdown 文件中，您可以使用以下链接来快速打开各种侧边栏视图。

## 使用方法

### 方式一：使用 RSLatte 自定义 URI（推荐，无需额外插件）

在 Markdown 文件中，使用以下格式创建链接：

```markdown
[链接文本](obsidian://rslatte-command?command=命令ID)
```

### 方式二：使用 Advanced URI 插件

如果您已安装 Advanced URI 插件，也可以使用：

```markdown
[链接文本](obsidian://advanced-uri?command=命令ID)
```

> **注意**：如果遇到 "Unrecognized URI action: advanced-uri" 错误，请使用方式一，或安装并启用 Advanced URI 插件。

## 可用的侧边栏快捷方式

### 主要视图

- **RSLatte 视图（空间中心）**
  ```markdown
  [打开 RSLatte 视图](obsidian://rslatte-command?command=rslatte-hub-open)
  ```

- **工作台**
  ```markdown
  [打开工作台](obsidian://rslatte-command?command=rslatte-dashboard-open)
  ```

- **今日检查**
  ```markdown
  [打开今日检查](obsidian://rslatte-command?command=rslatte-open-sidepanel)
  ```

### 功能模块

- **项目管理**
  ```markdown
  [打开项目管理](obsidian://rslatte-command?command=rslatte-open-project-panel)
  ```

- **任务管理**
  ```markdown
  [打开任务管理](obsidian://rslatte-command?command=rslatte-open-taskpanel)
  ```

- **输出管理**
  ```markdown
  [打开输出管理](obsidian://rslatte-command?command=rslatte-open-output-panel)
  ```

- **发布管理**
  ```markdown
  [打开发布管理](obsidian://rslatte-command?command=rslatte-open-publish-panel)
  ```

- **财务管理**
  ```markdown
  [打开财务管理](obsidian://rslatte-command?command=rslatte-open-finance-panel)
  ```

- **打卡记录**
  ```markdown
  [打开打卡记录](obsidian://rslatte-command?command=rslatte-open-checkin-panel)
  ```

- **联系人管理**
  ```markdown
  [打开联系人管理](obsidian://rslatte-command?command=rslatte-open-contacts-panel)
  ```

### 统计视图

- **时间轴视图**
  ```markdown
  [打开时间轴](obsidian://rslatte-command?command=rslatte-open-timeline)
  ```

- **月度统计**
  ```markdown
  [打开月度统计](obsidian://rslatte-command?command=rslatte-open-monthly-stats)
  ```

- **日历**
  ```markdown
  [打开日历](obsidian://rslatte-command?command=rslatte-open-calendar)
  ```

### 其他功能

- **切换空间**
  ```markdown
  [切换空间](obsidian://rslatte-command?command=rslatte-space-switch)
  ```

## 示例：创建快捷按钮组

您可以在笔记中创建一个快捷按钮组，例如：

```markdown
## 快速访问

- [📊 工作台](obsidian://rslatte-command?command=rslatte-dashboard-open)
- [📁 项目管理](obsidian://rslatte-command?command=rslatte-open-project-panel)
- [✅ 任务管理](obsidian://rslatte-command?command=rslatte-open-taskpanel)
- [📄 输出管理](obsidian://rslatte-command?command=rslatte-open-output-panel)
- [📅 日历](obsidian://rslatte-command?command=rslatte-open-calendar)
```

## 使用按钮语法（如果支持）

某些 Obsidian 主题或插件可能支持按钮语法：

```markdown
[打开工作台](obsidian://rslatte-command?command=rslatte-dashboard-open){.button}
```

## 注意事项

1. 这些链接需要在 Obsidian 中点击才能生效
2. 确保插件已启用并已注册相应的命令
3. 如果命令 ID 发生变化，需要更新链接
