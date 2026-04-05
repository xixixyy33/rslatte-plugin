import { Notice, type Workspace, type WorkspaceLeaf } from "obsidian";

import type RSLattePlugin from "../main";
import {
  VIEW_TYPE_CALENDAR,
  VIEW_TYPE_CAPTURE,
  VIEW_TYPE_CHECKIN,
  VIEW_TYPE_CONTACTS,
  VIEW_TYPE_FINANCE,
  VIEW_TYPE_HEALTH,
  VIEW_TYPE_HUB,
  VIEW_TYPE_KNOWLEDGE,
  VIEW_TYPE_KNOWLEDGE_PANEL,
  VIEW_TYPE_OUTPUTS,
  VIEW_TYPE_PROJECTS,
  VIEW_TYPE_REVIEW,
  VIEW_TYPE_RSLATTE,
  VIEW_TYPE_TASKS,
  VIEW_TYPE_TIMELINE,
  VIEW_TYPE_TODAY,
} from "../constants/viewTypes";
import { isWorkspacesCorePluginEnabled } from "./obsidianCorePluginGate";
import { CaptureView } from "../ui/views/CaptureView";

/**
 * Obsidian API：createLeafBySplit(..., "horizontal") 时新叶在**下方**（侧栏上下分栏用）。
 */
const SPLIT_NEW_LEAF_BELOW: "horizontal" = "horizontal";

/** 比单测 setViewState 略宽，减少某些版本下扫不到侧栏叶的情况。 */
function isWorkspaceLeafLike(node: any): node is WorkspaceLeaf {
  return (
    !!node &&
    typeof node.detach === "function" &&
    (typeof node.setViewState === "function" || typeof node.getViewType === "function")
  );
}

function workspaceNodeChildren(node: any): any[] {
  if (!node || node.children == null) return [];
  const ch = node.children;
  if (Array.isArray(ch)) return ch;
  try {
    return Array.from(ch as Iterable<any>);
  } catch {
    return [];
  }
}

function firstLeafInNode(node: any): WorkspaceLeaf | null {
  if (!node) return null;
  if (isWorkspaceLeafLike(node)) return node;
  for (const c of workspaceNodeChildren(node)) {
    const f = firstLeafInNode(c);
    if (f) return f;
  }
  return null;
}

function splitTopBottomLeaves(sp: any): { top: WorkspaceLeaf; bottom: WorkspaceLeaf } | null {
  if (!sp || isWorkspaceLeafLike(sp)) return null;
  if (sp.type === "tabs") return null;
  const ch = workspaceNodeChildren(sp);
  if (ch.length < 2) return null;
  const top = firstLeafInNode(ch[0]);
  const bottom = firstLeafInNode(ch[1]);
  return top && bottom ? { top, bottom } : null;
}

function tryGetSideTwoRowLeaves(ws: Workspace, side: "left" | "right"): { top: WorkspaceLeaf; bottom: WorkspaceLeaf } | null {
  const dock = side === "left" ? (ws as any).leftSplit : (ws as any).rightSplit;
  if (!dock?.children?.length) return null;

  const walk = (node: any): { top: WorkspaceLeaf; bottom: WorkspaceLeaf } | null => {
    const got = splitTopBottomLeaves(node);
    if (got) return got;
    for (const c of workspaceNodeChildren(node)) {
      const inner = walk(c);
      if (inner) return inner;
    }
    return null;
  };

  for (const c of dock.children) {
    const got = walk(c);
    if (got) return got;
  }
  return null;
}

async function ensureSideTwoRows(ws: Workspace, side: "left" | "right"): Promise<{ top: WorkspaceLeaf; bottom: WorkspaceLeaf } | null> {
  const existing = tryGetSideTwoRowLeaves(ws, side);
  if (existing) return existing;

  const getSide = side === "left" ? ws.getLeftLeaf.bind(ws) : ws.getRightLeaf.bind(ws);
  const topLeaf = getSide(false);
  if (!topLeaf || typeof ws.createLeafBySplit !== "function") return null;

  ws.setActiveLeaf(topLeaf);
  const bottomLeaf = ws.createLeafBySplit(topLeaf, SPLIT_NEW_LEAF_BELOW);
  if (!bottomLeaf) return null;
  return { top: topLeaf, bottom: bottomLeaf };
}

async function setLeafView(leaf: WorkspaceLeaf, type: string, plugin: RSLattePlugin): Promise<boolean> {
  try {
    if (type === VIEW_TYPE_CONTACTS) {
      (plugin as any).ensureContactsPanelRegistered?.();
    }
    await leaf.setViewState({ type, active: true });
    return true;
  } catch {
    return false;
  }
}

async function setLeafViewFirstMatch(leaf: WorkspaceLeaf, candidates: string[], plugin: RSLattePlugin): Promise<boolean> {
  for (const type of candidates) {
    if (await setLeafView(leaf, type, plugin)) return true;
  }
  console.warn("[RSLatte] quadrant: 无法打开视图，已尝试：", candidates.join(", "));
  return false;
}

function appendSiblingTabInSameStrip(ws: Workspace, anchorLeaf: WorkspaceLeaf): WorkspaceLeaf | null {
  try {
    const parent = (anchorLeaf as any).parent as { children?: unknown[] } | null;
    if (!parent || !Array.isArray(parent.children)) return null;
    const create = (ws as any).createLeafInParent as ((p: unknown, index: number) => WorkspaceLeaf) | undefined;
    if (typeof create !== "function") return null;
    return create.call(ws, parent, parent.children.length);
  } catch (e) {
    console.warn("[RSLatte] appendSiblingTabInSameStrip failed", e);
    return null;
  }
}

function collectLeavesUnderWorkspaceNode(node: any): WorkspaceLeaf[] {
  const acc: WorkspaceLeaf[] = [];
  if (!node) return acc;
  if (isWorkspaceLeafLike(node)) {
    acc.push(node);
    return acc;
  }
  for (const c of workspaceNodeChildren(node)) {
    acc.push(...collectLeavesUnderWorkspaceNode(c));
  }
  return acc;
}

function detachAllLeavesUnderSideDock(ws: Workspace, side: "left" | "right"): void {
  const dock = side === "left" ? (ws as any).leftSplit : (ws as any).rightSplit;
  if (!dock) return;
  for (const leaf of collectLeavesUnderWorkspaceNode(dock)) {
    try {
      leaf.detach();
    } catch {
      /* ignore */
    }
  }
}

const QUADRANT_RSLATTE_VIEW_TYPES: string[] = [
  VIEW_TYPE_CALENDAR,
  VIEW_TYPE_CAPTURE,
  VIEW_TYPE_CHECKIN,
  VIEW_TYPE_CONTACTS,
  VIEW_TYPE_FINANCE,
  VIEW_TYPE_HEALTH,
  VIEW_TYPE_HUB,
  VIEW_TYPE_KNOWLEDGE,
  VIEW_TYPE_KNOWLEDGE_PANEL,
  VIEW_TYPE_OUTPUTS,
  VIEW_TYPE_PROJECTS,
  VIEW_TYPE_REVIEW,
  VIEW_TYPE_RSLATTE,
  VIEW_TYPE_TASKS,
  VIEW_TYPE_TIMELINE,
  VIEW_TYPE_TODAY,
];

function detachAllQuadrantPluginViewsByType(ws: Workspace): void {
  const detachLeavesOfType = (ws as any).detachLeavesOfType as ((viewType: string) => void) | undefined;
  if (typeof detachLeavesOfType !== "function") return;
  for (const t of QUADRANT_RSLATTE_VIEW_TYPES) {
    try {
      detachLeavesOfType.call(ws, t);
    } catch {
      /* ignore */
    }
  }
}

/** 展开左右侧栏（避免载入布局后仍处于收起状态，用户误以为未生效）。WorkspaceSidedock：expand / collapsed + toggle。 */
function expandLeftRightSidedocks(ws: Workspace): void {
  for (const key of ["leftSplit", "rightSplit"] as const) {
    try {
      const dock = (ws as any)[key];
      if (!dock) continue;
      if (typeof dock.expand === "function") {
        dock.expand();
        continue;
      }
      if (dock.collapsed === true && typeof dock.toggle === "function") {
        dock.toggle();
      }
    } catch (e) {
      console.warn(`[RSLatte] quadrant: expand ${key} failed`, e);
    }
  }
}

/**
 * 关 RSLatte 相关叶 + 多轮摘掉 leftSplit/rightSplit 下所有叶（不碰 changeLayout；核心文件树等仍在侧栏时也会被 detach）。
 * @param rounds 多轮 detach，命令「清空侧栏」可略多几轮。
 */
async function clearSideDocksContent(ws: Workspace, rounds: number): Promise<void> {
  detachAllQuadrantPluginViewsByType(ws);
  const n = Math.max(1, Math.min(rounds, 12));
  for (let i = 0; i < n; i++) {
    detachAllLeavesUnderSideDock(ws, "left");
    detachAllLeavesUnderSideDock(ws, "right");
    await new Promise<void>((r) => window.setTimeout(r, 40));
  }
}

async function clearSideDocksBeforeApply(ws: Workspace): Promise<void> {
  await clearSideDocksContent(ws, 3);
}

async function fillTabStrip(
  ws: Workspace,
  startLeaf: WorkspaceLeaf,
  viewGroups: string[][],
  plugin: RSLattePlugin,
): Promise<void> {
  if (!viewGroups.length) return;
  let leaf: WorkspaceLeaf | null = startLeaf;
  ws.setActiveLeaf(leaf);
  await setLeafViewFirstMatch(leaf, viewGroups[0], plugin);
  for (let i = 1; i < viewGroups.length; i++) {
    if (!leaf) break;
    ws.setActiveLeaf(leaf);
    const next = appendSiblingTabInSameStrip(ws, leaf);
    if (!next) {
      console.warn("[RSLatte] quadrant: 无法在侧栏追加页签，已跳过剩余项（索引 " + i + " 起）");
      break;
    }
    leaf = next;
    ws.setActiveLeaf(leaf);
    await setLeafViewFirstMatch(leaf, viewGroups[i], plugin);
  }
}

const LEFT_TOP: string[][] = [["file-explorer"], ["search"], ["bookmarks", "bookmark"], [VIEW_TYPE_CALENDAR], [VIEW_TYPE_HUB]];

const LEFT_BOTTOM: string[][] = [
  [VIEW_TYPE_RSLATTE],
  [VIEW_TYPE_FINANCE],
  [VIEW_TYPE_HEALTH],
  [VIEW_TYPE_CHECKIN],
  [VIEW_TYPE_TASKS],
  [VIEW_TYPE_OUTPUTS],
  [VIEW_TYPE_PROJECTS],
  [VIEW_TYPE_CONTACTS],
];

const RIGHT_TOP: string[][] = [[VIEW_TYPE_CAPTURE], ["tag", "tags"], ["outline"], ["all-properties", "file-properties"]];

const RIGHT_BOTTOM: string[][] = [[VIEW_TYPE_TODAY], [VIEW_TYPE_REVIEW], [VIEW_TYPE_TIMELINE], [VIEW_TYPE_KNOWLEDGE]];

/**
 * 四象限侧栏：先简单清空（RSLatte 按类型关 + 左右 dock 子树多轮 detach），再上下两行 + 页签填充。
 */
export async function applyRslatteQuadrantWorkspaceLayout(plugin: RSLattePlugin): Promise<void> {
  const ws = plugin.app.workspace;
  if (!isWorkspacesCorePluginEnabled(plugin.app)) {
    new Notice("请先打开「设置 → 核心插件」，启用「工作区」后再载入推荐布局。");
    return;
  }

  try {
    await clearSideDocksBeforeApply(ws);

    const left = await ensureSideTwoRows(ws, "left");
    const right = await ensureSideTwoRows(ws, "right");
    if (!left || !right) {
      new Notice("无法拆分左右侧栏。请确认两侧边栏已显示（「外观」中勿隐藏侧栏），再重试。");
      return;
    }

    await fillTabStrip(ws, left.top, LEFT_TOP, plugin);
    await fillTabStrip(ws, left.bottom, LEFT_BOTTOM, plugin);
    await fillTabStrip(ws, right.top, RIGHT_TOP, plugin);
    await fillTabStrip(ws, right.bottom, RIGHT_BOTTOM, plugin);

    expandLeftRightSidedocks(ws);
    window.requestAnimationFrame(() => expandLeftRightSidedocks(ws));
    window.setTimeout(() => expandLeftRightSidedocks(ws), 120);

    window.setTimeout(() => {
      try {
        const capLeaf = ws.getLeavesOfType(VIEW_TYPE_CAPTURE)[0];
        const v = capLeaf?.view;
        if (v instanceof CaptureView) v.openRecordTabFromExternal();
      } catch {
        /* ignore */
      }
      try {
        const todayLeaves = ws.getLeavesOfType(VIEW_TYPE_TODAY);
        if (todayLeaves.length > 0) ws.revealLeaf(todayLeaves[0]);
      } catch {
        /* ignore */
      }
    }, 180);

    new Notice("已应用 RSLatte 四象限侧栏（左上 / 左下 / 右上 / 右下）。");
  } catch (e) {
    console.warn("[RSLatte] applyRslatteQuadrantWorkspaceLayout failed", e);
    new Notice("排版失败，请查看控制台。若侧栏已多次拆分，可在「工作区」中恢复默认布局后再试。");
  }
}

/**
 * 命令「清空左右侧栏」：关闭侧栏内当前所有叶（含 RSLatte 与仍在侧栏的核心视图）；不自动铺四象限。
 */
export async function clearLeftRightSidebarsFromCommand(plugin: RSLattePlugin): Promise<void> {
  const ws = plugin.app.workspace;
  if (!isWorkspacesCorePluginEnabled(plugin.app)) {
    new Notice("请先启用核心插件「工作区」后再使用本命令。");
    return;
  }
  try {
    await clearSideDocksContent(ws, 5);
    expandLeftRightSidedocks(ws);
    window.requestAnimationFrame(() => expandLeftRightSidedocks(ws));
    new Notice("已清空左右侧栏中的视图。需要 RSLatte 排版时请再执行「载入 RSLatte 内置工作区布局」。");
  } catch (e) {
    console.warn("[RSLatte] clearLeftRightSidebarsFromCommand failed", e);
    new Notice("清空侧栏失败，请查看控制台。");
  }
}
