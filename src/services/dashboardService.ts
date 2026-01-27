import { TFile, normalizePath, moment } from "obsidian";
import type RSLattePlugin from "../main";

const momentFn = moment as any;

/**
 * RSLatte 工作台服务
 * 用于生成和更新工作台文档
 */
export class DashboardService {
  constructor(private plugin: RSLattePlugin) {}

  /**
   * 获取工作台文档路径
   */
  private getDashboardPath(): string {
    const s = this.plugin.settings as any;
    const path = String(s?.dashboardPath ?? "RSLatte 工作台.md").trim() || "RSLatte 工作台.md";
    return normalizePath(path);
  }

  /**
   * 生成工作台文档内容（使用 DataviewJS 动态展示）
   */
  async generateDashboardContent(): Promise<string> {
    const today = this.plugin.getTodayKey();
    const now = momentFn(today, "YYYY-MM-DD");

    const lines: string[] = [];

    // 标题
    lines.push("# RSLatte 工作台");
    lines.push("");
    lines.push(`*最后更新: ${now.format("YYYY-MM-DD HH:mm:ss")}*`);
    lines.push("");

    // 日历模块
    lines.push("## 📅 日历");
    lines.push("");
    lines.push("```dataviewjs");
    lines.push("const today = dv.date('today');");
    lines.push("const month = today.toFormat('M月 YYYY');");
    lines.push("const weekday = today.toFormat('dddd');");
    lines.push("dv.paragraph(`**${month}**`);");
    lines.push("dv.paragraph(`今天：${today.toFormat('YYYY-MM-DD')} (${weekday})`);");
    lines.push("```");
    lines.push("");

    // 事项提醒模块
    lines.push("## ⏰ 事项提醒");
    lines.push("");
    lines.push("```dataviewjs");
    lines.push("// TODO: 实现事项提醒的查询逻辑");
    lines.push("dv.paragraph('*(空)*');");
    lines.push("```");
    lines.push("");

    // 打卡模块
    lines.push("## ✅ 打卡");
    lines.push("");
    lines.push("```dataviewjs");
    lines.push("const { app } = this.app;");
    lines.push("const plugin = app.plugins.plugins['rslatte-plugin'];");
    lines.push("if (!plugin) {");
    lines.push("  dv.paragraph('插件未加载');");
    lines.push("} else {");
    lines.push("  (async () => {");
    lines.push("    try {");
    lines.push("      const recordRSLatte = plugin.recordRSLatte;");
    lines.push("      if (!recordRSLatte) {");
    lines.push("        dv.paragraph('打卡模块未启用');");
    lines.push("        return;");
    lines.push("      }");
    lines.push("      const today = plugin.getTodayKey();");
    lines.push("      const snap = await recordRSLatte.getCheckinSnapshot(false);");
    lines.push("      const todayItems = (snap?.items ?? []).filter(it => it.recordDate === today && !it.isDelete);");
    lines.push("      const checkinItems = plugin.settings.checkinItems ?? [];");
    lines.push("      const activeItems = checkinItems.filter(x => x.active);");
    lines.push("      if (activeItems.length === 0) {");
    lines.push("        dv.paragraph('*(空)*');");
    lines.push("        return;");
    lines.push("      }");
    lines.push("      for (const item of activeItems) {");
    lines.push("        const done = todayItems.some(it => String(it.checkinId) === String(item.id));");
    lines.push("        const status = done ? '✅' : '⬜';");
    lines.push("        dv.paragraph(`${status} ${item.name}`);");
    lines.push("      }");
    lines.push("    } catch (e) {");
    lines.push("      dv.paragraph(`错误: ${e.message}`);");
    lines.push("    }");
    lines.push("  })();");
    lines.push("}");
    lines.push("```");
    lines.push("");

    // 今日日志模块
    lines.push("## 📝 今日日志");
    lines.push("");
    lines.push("```dataviewjs");
    lines.push("const { app } = this.app;");
    lines.push("const plugin = app.plugins.plugins['rslatte-plugin'];");
    lines.push("if (!plugin) {");
    lines.push("  dv.paragraph('插件未加载');");
    lines.push("} else {");
    lines.push("  (async () => {");
    lines.push("    try {");
    lines.push("      const panels = plugin.settings.journalPanels ?? [];");
    lines.push("      const previews = await plugin.readTodayPanelsPreview?.() ?? {};");
    lines.push("      if (panels.length === 0) {");
    lines.push("        dv.paragraph('*(空)*');");
    lines.push("        return;");
    lines.push("      }");
    lines.push("      for (const panel of panels) {");
    lines.push("        const title = panel.title || panel.heading || '未命名';");
    lines.push("        const content = previews[panel.id] || '';");
    lines.push("        dv.header(3, title);");
    lines.push("        dv.paragraph(content || '*(空)*');");
    lines.push("      }");
    lines.push("    } catch (e) {");
    lines.push("      dv.paragraph(`错误: ${e.message}`);");
    lines.push("    }");
    lines.push("  })();");
    lines.push("}");
    lines.push("```");
    lines.push("");

    // 任务模块
    lines.push("## 📋 任务");
    lines.push("");
    lines.push("### 任务总览");
    lines.push("");
    lines.push("```dataviewjs");
    lines.push("const { app } = this.app;");
    lines.push("const plugin = app.plugins.plugins['rslatte-plugin'];");
    lines.push("if (!plugin) {");
    lines.push("  dv.paragraph('插件未加载');");
    lines.push("} else {");
    lines.push("  (async () => {");
    lines.push("    try {");
    lines.push("      const taskRSLatte = plugin.taskRSLatte;");
    lines.push("      if (!taskRSLatte) {");
    lines.push("        dv.paragraph('任务模块未启用');");
    lines.push("        return;");
    lines.push("      }");
    lines.push("      const today = plugin.getTodayKey();");
    lines.push("      const tasks = await taskRSLatte.listTodayTasks?.() ?? [];");
    lines.push("      const overdueTasks = await taskRSLatte.listOverdueTasks?.() ?? [];");
    lines.push("      const activeTasks = await taskRSLatte.listActiveTasks?.() ?? [];");
    lines.push("      ");
    lines.push("      const countStatus = (tasks, status) => {");
    lines.push("        return tasks.filter(t => String(t.status ?? 'todo').toLowerCase() === status.toLowerCase()).length;");
    lines.push("      };");
    lines.push("      ");
    lines.push("      const todayStats = {");
    lines.push("        todo: countStatus(tasks, 'todo'),");
    lines.push("        inProgress: countStatus(tasks, 'in-progress') + countStatus(tasks, 'in_progress'),");
    lines.push("        done: countStatus(tasks, 'done'),");
    lines.push("        cancelled: countStatus(tasks, 'cancelled')");
    lines.push("      };");
    lines.push("      ");
    lines.push("      const overdueStats = {");
    lines.push("        todo: countStatus(overdueTasks, 'todo'),");
    lines.push("        inProgress: countStatus(overdueTasks, 'in-progress') + countStatus(overdueTasks, 'in_progress'),");
    lines.push("        done: countStatus(overdueTasks, 'done'),");
    lines.push("        cancelled: countStatus(overdueTasks, 'cancelled')");
    lines.push("      };");
    lines.push("      ");
    lines.push("      const activeStats = {");
    lines.push("        todo: countStatus(activeTasks, 'todo'),");
    lines.push("        inProgress: countStatus(activeTasks, 'in-progress') + countStatus(activeTasks, 'in_progress')");
    lines.push("      };");
    lines.push("      ");
    lines.push("      const nearDueCount = activeTasks.filter(t => {");
    lines.push("        if (!t.dueDate) return false;");
    lines.push("        const due = dv.date(t.dueDate);");
    lines.push("        const now = dv.date('today');");
    lines.push("        const weekLater = now.plus({ days: 7 });");
    lines.push("        return due > now && due < weekLater;");
    lines.push("      }).length;");
    lines.push("      ");
    lines.push("      dv.paragraph(`计划今日完成任务${tasks.length}个，未开始${todayStats.todo}，进行中${todayStats.inProgress}个，已完成${todayStats.done}个，取消${todayStats.cancelled}个。`);");
    lines.push("      dv.paragraph(`超期任务${overdueTasks.length}，未开始${overdueStats.todo}，进行中${overdueStats.inProgress}个，已完成${overdueStats.done}个，取消${overdueStats.cancelled}个。`);");
    lines.push("      dv.paragraph(`未达截止日期的活跃任务${activeTasks.length}个，进行中${activeStats.inProgress}个，未开始${activeStats.todo}个，近7日即将超期${nearDueCount}个。`);");
    lines.push("    } catch (e) {");
    lines.push("      dv.paragraph(`错误: ${e.message}`);");
    lines.push("    }");
    lines.push("  })();");
    lines.push("}");
    lines.push("```");
    lines.push("");
    lines.push("### 今日任务");
    lines.push("");
    lines.push("```dataviewjs");
    lines.push("const { app } = this.app;");
    lines.push("const plugin = app.plugins.plugins['rslatte-plugin'];");
    lines.push("if (!plugin) {");
    lines.push("  dv.paragraph('插件未加载');");
    lines.push("} else {");
    lines.push("  (async () => {");
    lines.push("    try {");
    lines.push("      const taskRSLatte = plugin.taskRSLatte;");
    lines.push("      if (!taskRSLatte) {");
    lines.push("        dv.paragraph('任务模块未启用');");
    lines.push("        return;");
    lines.push("      }");
    lines.push("      const tasks = await taskRSLatte.listTodayTasks?.() ?? [];");
    lines.push("      if (tasks.length === 0) {");
    lines.push("        dv.paragraph('*(空)*');");
    lines.push("        return;");
    lines.push("      }");
    lines.push("      for (const task of tasks.slice(0, 10)) {");
    lines.push("        const status = task.status === 'done' ? 'x' : ' ';");
    lines.push("        const link = `[${task.title}](obsidian://rslatte-task?uid=${task.uid})`;");
    lines.push("        dv.paragraph(`- [${status}] ${link}`);");
    lines.push("      }");
    lines.push("      if (tasks.length > 10) {");
    lines.push("        dv.paragraph(`*...还有 ${tasks.length - 10} 个任务*`);");
    lines.push("      }");
    lines.push("    } catch (e) {");
    lines.push("      dv.paragraph(`错误: ${e.message}`);");
    lines.push("    }");
    lines.push("  })();");
    lines.push("}");
    lines.push("```");
    lines.push("");

    // 输出模块
    lines.push("## 📚 输出");
    lines.push("");
    lines.push("### 输出总览");
    lines.push("");
    lines.push("```dataviewjs");
    lines.push("const { app } = this.app;");
    lines.push("const plugin = app.plugins.plugins['rslatte-plugin'];");
    lines.push("if (!plugin) {");
    lines.push("  dv.paragraph('插件未加载');");
    lines.push("} else {");
    lines.push("  (async () => {");
    lines.push("    try {");
    lines.push("      const outputRSLatte = plugin.outputRSLatte;");
    lines.push("      if (!outputRSLatte) {");
    lines.push("        dv.paragraph('输出模块未启用');");
    lines.push("        return;");
    lines.push("      }");
    lines.push("      const outputs = await outputRSLatte.listActiveOutputs?.() ?? [];");
    lines.push("      const byCategory = {};");
    lines.push("      for (const o of outputs) {");
    lines.push("        const cat = o.category ?? '未分类';");
    lines.push("        byCategory[cat] = (byCategory[cat] ?? 0) + 1;");
    lines.push("      }");
    lines.push("      const now = dv.date('today');");
    lines.push("      const weekAgo = now.minus({ days: 7 });");
    lines.push("      const overdueCount = outputs.filter(o => {");
    lines.push("        if (!o.updatedAt) return false;");
    lines.push("        const updated = dv.date(o.updatedAt);");
    lines.push("        return updated < weekAgo;");
    lines.push("      }).length;");
    lines.push("      ");
    lines.push("      dv.paragraph(`当前正在输出中${outputs.length}个文档`);");
    lines.push("      for (const [cat, count] of Object.entries(byCategory)) {");
    lines.push("        dv.paragraph(`- ${cat} ${count}个`);");
    lines.push("      }");
    lines.push("      if (overdueCount > 0) {");
    lines.push("        dv.paragraph(`超7天未处理文档有${overdueCount}个，请尽快处理`);");
    lines.push("      }");
    lines.push("    } catch (e) {");
    lines.push("      dv.paragraph(`错误: ${e.message}`);");
    lines.push("    }");
    lines.push("  })();");
    lines.push("}");
    lines.push("```");
    lines.push("");
    lines.push("### 正在输出中");
    lines.push("");
    lines.push("```dataviewjs");
    lines.push("const { app } = this.app;");
    lines.push("const plugin = app.plugins.plugins['rslatte-plugin'];");
    lines.push("if (!plugin) {");
    lines.push("  dv.paragraph('插件未加载');");
    lines.push("} else {");
    lines.push("  (async () => {");
    lines.push("    try {");
    lines.push("      const outputRSLatte = plugin.outputRSLatte;");
    lines.push("      if (!outputRSLatte) {");
    lines.push("        dv.paragraph('输出模块未启用');");
    lines.push("        return;");
    lines.push("      }");
    lines.push("      const outputs = await outputRSLatte.listActiveOutputs?.() ?? [];");
    lines.push("      if (outputs.length === 0) {");
    lines.push("        dv.paragraph('*(空)*');");
    lines.push("        return;");
    lines.push("      }");
    lines.push("      for (const output of outputs.slice(0, 10)) {");
    lines.push("        const link = `[${output.title}](obsidian://rslatte-output?id=${output.id})`;");
    lines.push("        dv.paragraph(`- ${link} (${output.category ?? '未分类'})`);");
    lines.push("      }");
    lines.push("      if (outputs.length > 10) {");
    lines.push("        dv.paragraph(`*...还有 ${outputs.length - 10} 个输出*`);");
    lines.push("      }");
    lines.push("    } catch (e) {");
    lines.push("      dv.paragraph(`错误: ${e.message}`);");
    lines.push("    }");
    lines.push("  })();");
    lines.push("}");
    lines.push("```");
    lines.push("");

    // 财务模块
    lines.push("## 💰 财务");
    lines.push("");
    lines.push("### 财务统计");
    lines.push("");
    lines.push("```dataviewjs");
    lines.push("const { app } = this.app;");
    lines.push("const plugin = app.plugins.plugins['rslatte-plugin'];");
    lines.push("if (!plugin) {");
    lines.push("  dv.paragraph('插件未加载');");
    lines.push("} else {");
    lines.push("  (async () => {");
    lines.push("    try {");
    lines.push("      const recordRSLatte = plugin.recordRSLatte;");
    lines.push("      if (!recordRSLatte) {");
    lines.push("        dv.paragraph('财务模块未启用');");
    lines.push("        return;");
    lines.push("      }");
    lines.push("      const today = plugin.getTodayKey();");
    lines.push("      const cache = await recordRSLatte.getFinanceStatsCache();");
    lines.push("      const items = cache?.items ?? [];");
    lines.push("      ");
    lines.push("      const now = dv.date(today);");
    lines.push("      const monthKey = now.toFormat('YYYY-MM');");
    lines.push("      const yearKey = now.toFormat('YYYY');");
    lines.push("      ");
    lines.push("      let monthExpense = 0, monthIncome = 0;");
    lines.push("      let yearExpense = 0, yearIncome = 0;");
    lines.push("      const expenseByCat = new Map();");
    lines.push("      ");
    lines.push("      for (const it of items) {");
    lines.push("        if (it.isDelete) continue;");
    lines.push("        const d = String(it.recordDate ?? '');");
    lines.push("        if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(d)) continue;");
    lines.push("        const amount = Math.abs(Number(it.amount ?? 0));");
    lines.push("        const isMonth = d.startsWith(monthKey);");
    lines.push("        const isYear = d.startsWith(yearKey);");
    lines.push("        ");
    lines.push("        if (it.type === 'expense') {");
    lines.push("          if (isMonth) monthExpense += amount;");
    lines.push("          if (isYear) yearExpense += amount;");
    lines.push("          const catId = String(it.categoryId ?? '');");
    lines.push("          if (isMonth) {");
    lines.push("            expenseByCat.set(catId, (expenseByCat.get(catId) ?? 0) + amount);");
    lines.push("          }");
    lines.push("        } else if (it.type === 'income') {");
    lines.push("          if (isMonth) monthIncome += amount;");
    lines.push("          if (isYear) yearIncome += amount;");
    lines.push("        }");
    lines.push("      }");
    lines.push("      ");
    lines.push("      const catName = new Map();");
    lines.push("      for (const c of plugin.settings.financeCategories ?? []) {");
    lines.push("        catName.set(String(c.id), String(c.name));");
    lines.push("      }");
    lines.push("      ");
    lines.push("      dv.paragraph(`本月支出: ${monthExpense.toFixed(2)} | 本月收入: ${monthIncome.toFixed(2)}`);");
    lines.push("      dv.paragraph(`本年支出: ${yearExpense.toFixed(2)} | 本年收入: ${yearIncome.toFixed(2)}`);");
    lines.push("    } catch (e) {");
    lines.push("      dv.paragraph(`错误: ${e.message}`);");
    lines.push("    }");
    lines.push("  })();");
    lines.push("}");
    lines.push("```");
    lines.push("");
    lines.push("### 分类统计");
    lines.push("");
    lines.push("```dataviewjs");
    lines.push("const { app } = this.app;");
    lines.push("const plugin = app.plugins.plugins['rslatte-plugin'];");
    lines.push("if (!plugin) {");
    lines.push("  dv.paragraph('插件未加载');");
    lines.push("} else {");
    lines.push("  (async () => {");
    lines.push("    try {");
    lines.push("      const recordRSLatte = plugin.recordRSLatte;");
    lines.push("      if (!recordRSLatte) {");
    lines.push("        dv.paragraph('财务模块未启用');");
    lines.push("        return;");
    lines.push("      }");
    lines.push("      const today = plugin.getTodayKey();");
    lines.push("      const cache = await recordRSLatte.getFinanceStatsCache();");
    lines.push("      const items = cache?.items ?? [];");
    lines.push("      ");
    lines.push("      const now = dv.date(today);");
    lines.push("      const monthKey = now.toFormat('YYYY-MM');");
    lines.push("      ");
    lines.push("      const expenseByCat = new Map();");
    lines.push("      ");
    lines.push("      for (const it of items) {");
    lines.push("        if (it.isDelete) continue;");
    lines.push("        const d = String(it.recordDate ?? '');");
    lines.push("        if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(d)) continue;");
    lines.push("        const amount = Math.abs(Number(it.amount ?? 0));");
    lines.push("        const isMonth = d.startsWith(monthKey);");
    lines.push("        ");
    lines.push("        if (it.type === 'expense' && isMonth) {");
    lines.push("          const catId = String(it.categoryId ?? '');");
    lines.push("          expenseByCat.set(catId, (expenseByCat.get(catId) ?? 0) + amount);");
    lines.push("        }");
    lines.push("      }");
    lines.push("      ");
    lines.push("      const catName = new Map();");
    lines.push("      for (const c of plugin.settings.financeCategories ?? []) {");
    lines.push("        catName.set(String(c.id), String(c.name));");
    lines.push("      }");
    lines.push("      ");
    lines.push("      const categories = Array.from(expenseByCat.entries())");
    lines.push("        .map(([id, amount]) => ({ name: catName.get(id) || id, amount }))");
    lines.push("        .sort((a, b) => b.amount - a.amount);");
    lines.push("      ");
    lines.push("      if (categories.length === 0) {");
    lines.push("        dv.paragraph('*(空)*');");
    lines.push("        return;");
    lines.push("      }");
    lines.push("      ");
    lines.push("      const maxAmount = Math.max(...categories.map(c => c.amount));");
    lines.push("      ");
    lines.push("      for (const cat of categories) {");
    lines.push("        const barLength = Math.min(20, Math.floor(cat.amount / maxAmount * 20));");
    lines.push("        const bar = '█'.repeat(barLength);");
    lines.push("        dv.paragraph(`- ${cat.name}: ${cat.amount.toFixed(2)} ${bar}`);");
    lines.push("      }");
    lines.push("    } catch (e) {");
    lines.push("      dv.paragraph(`错误: ${e.message}`);");
    lines.push("    }");
    lines.push("  })();");
    lines.push("}");
    lines.push("```");
    lines.push("");

    // 项目模块
    lines.push("## 🗂️ 项目");
    lines.push("");
    lines.push("```dataviewjs");
    lines.push("const { app } = this.app;");
    lines.push("const plugin = app.plugins.plugins['rslatte-plugin'];");
    lines.push("if (!plugin) {");
    lines.push("  dv.paragraph('插件未加载');");
    lines.push("} else {");
    lines.push("  (async () => {");
    lines.push("    try {");
    lines.push("      const projectMgr = plugin.projectMgr;");
    lines.push("      if (!projectMgr) {");
    lines.push("        dv.paragraph('项目模块未启用');");
    lines.push("        return;");
    lines.push("      }");
    lines.push("      const projects = await projectMgr.listProjects?.() ?? [];");
    lines.push("      if (projects.length === 0) {");
    lines.push("        dv.paragraph('*(空)*');");
    lines.push("        return;");
    lines.push("      }");
    lines.push("      for (const p of projects.slice(0, 10)) {");
    lines.push("        const link = `[${p.name}](obsidian://rslatte-project?id=${p.id})`;");
    lines.push("        const status = p.status === 'in-progress' ? '🔄' : p.status === 'done' ? '✅' : '📋';");
    lines.push("        dv.paragraph(`- ${status} ${link}`);");
    lines.push("        dv.paragraph(`  - 里程碑: ${p.milestonesDone ?? 0}/${p.milestonesTotal ?? 0} | 任务: ${p.tasksDone ?? 0}/${p.tasksTotal ?? 0}`);");
    lines.push("        dv.paragraph(`  - 创建: ${p.createDate ?? '-'} | 开始: ${p.startDate || '-'} | 截止: ${p.dueDate || '-'}`);");
    lines.push("      }");
    lines.push("      if (projects.length > 10) {");
    lines.push("        dv.paragraph(`*...还有 ${projects.length - 10} 个项目*`);");
    lines.push("      }");
    lines.push("    } catch (e) {");
    lines.push("      dv.paragraph(`错误: ${e.message}`);");
    lines.push("    }");
    lines.push("  })();");
    lines.push("}");
    lines.push("```");
    lines.push("");

    // 操作日志模块
    lines.push("## 📜 操作日志");
    lines.push("");
    lines.push("```dataviewjs");
    lines.push("const { app } = this.app;");
    lines.push("const plugin = app.plugins.plugins['rslatte-plugin'];");
    lines.push("if (!plugin) {");
    lines.push("  dv.paragraph('插件未加载');");
    lines.push("} else {");
    lines.push("  (async () => {");
    lines.push("    try {");
    lines.push("      const workEventSvc = plugin.workEventSvc;");
    lines.push("      if (!workEventSvc) {");
    lines.push("        dv.paragraph('操作日志未启用');");
    lines.push("        return;");
    lines.push("      }");
    lines.push("      const events = await workEventSvc.readLatestEvents(20);");
    lines.push("      if (events.length === 0) {");
    lines.push("        dv.paragraph('*(空)*');");
    lines.push("        return;");
    lines.push("      }");
    lines.push("      ");
    lines.push("      const icons = {");
    lines.push("        checkin: '✅',");
    lines.push("        finance: '💰',");
    lines.push("        task: '📋',");
    lines.push("        projecttask: '📋',");
    lines.push("        project: '🗂️',");
    lines.push("        milestone: '🎯',");
    lines.push("        output: '📚',");
    lines.push("        contact: '👤',");
    lines.push("        file: '📄',");
    lines.push("        sync: '🔄'");
    lines.push("      };");
    lines.push("      ");
    lines.push("      const actionTexts = {");
    lines.push("        create: '创建',");
    lines.push("        update: '更新',");
    lines.push("        status: '状态变更',");
    lines.push("        delete: '删除',");
    lines.push("        archive: '归档'");
    lines.push("      };");
    lines.push("      ");
    lines.push("      for (const event of events) {");
    lines.push("        const time = dv.date(event.ts).toFormat('MM-dd HH:mm');");
    lines.push("        const icon = icons[event.kind] || '📝';");
    lines.push("        const action = actionTexts[event.action] || event.action;");
    lines.push("        const summary = event.summary || '';");
    lines.push("        dv.paragraph(`- ${time} ${icon} ${action} ${summary}`);");
    lines.push("      }");
    lines.push("    } catch (e) {");
    lines.push("      dv.paragraph(`错误: ${e.message}`);");
    lines.push("    }");
    lines.push("  })();");
    lines.push("}");
    lines.push("```");
    lines.push("");

    return lines.join("\n");
  }


  /**
   * 生成并打开工作台文档
   */
  async generateAndOpenDashboard(): Promise<void> {
    try {
      const path = this.getDashboardPath();
      const content = await this.generateDashboardContent();

      // 检查文件是否存在
      const existing = this.plugin.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        // 更新现有文件
        await this.plugin.app.vault.modify(existing, content);
      } else {
        // 创建新文件
        await this.plugin.app.vault.create(path, content);
      }

      // 打开文件
      const file = this.plugin.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        const leaf = this.plugin.app.workspace.getLeaf(false);
        if (leaf) {
          await leaf.openFile(file, { active: true });
        }
      }
    } catch (e) {
      console.error("[RSLatte] generateAndOpenDashboard failed:", e);
    }
  }
}
