import { MarkdownView, Notice, TFile } from "obsidian";
import type { App } from "obsidian";
import { normLine } from "../utils/text";

export class NoteNavigator {
  constructor(private app: App) {}

  private getHeadingLevel(line: string): number {
    const m = /^\s*(#{1,6})\s+/.exec(line ?? "");
    return m ? m[1].length : 0;
  }

  private isBlankLine(line: string): boolean {
    return !(line ?? "").trim();
  }

  private getIndent(line: string): number {
    const m = /^\s*/.exec(line ?? "");
    return m ? m[0].length : 0;
  }

  private isListLike(line: string): boolean {
    const s = line ?? "";
    // task list or bullet/ordered list
    if (/^\s*[-*+]\s+\[[ xX\/-]\]\s+/.test(s)) return true;
    if (/^\s*[-*+]\s+/.test(s)) return true;
    if (/^\s*\d+\.\s+/.test(s)) return true;
    return false;
  }

  private isCodeFence(line: string): boolean {
    return /^\s*(```|~~~)/.test(line ?? "");
  }

  /**
   * 打开指定路径的 md 文件并定位到标题行；若标题不存在则插入。
   *
   * @param path vault 内路径
   * @param headingLine 标题行（可写“今日积累”或“### 今日积累”）
   * @param insertBeforeHeading 若不为空：插入到该标题行之前（可写“今日积累”或“### 今日积累”）
   */
  async openNoteAtHeading(path: string, headingLine: string, insertBeforeHeading?: string, parentHeading?: string) {
    const p = (path ?? "").trim();
    if (!p) {
      new Notice("未配置日志路径");
      return;
    }

    const af = this.app.vault.getAbstractFileByPath(p);
    if (!af || !(af instanceof TFile)) {
      new Notice(`未找到日志：${p}`);
      return;
    }

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(af, { active: true });

    // 让 editor ready
    await new Promise((r) => setTimeout(r, 0));

    const view = leaf.view;
    if (!(view instanceof MarkdownView)) {
      new Notice("当前打开的不是 Markdown 文件，无法定位标题");
      return;
    }

    const editor = view.editor;

    let target = (headingLine || "").trim();
    if (!target) return;
    if (!target.startsWith("#")) target = `### ${target}`;

    const targetNorm = normLine(target);

    let lines = editor.getValue().split("\n");
    let lineNo = -1;
    for (let i = 0; i < lines.length; i++) {
      if (normLine(lines[i]) === targetNorm) { lineNo = i; break; }
    }

    if (lineNo === -1) {
      // 如果指定了父目录，先确保父目录存在
      let parentLineNo = -1;
      if (parentHeading) {
        const parentRaw = parentHeading.trim();
        let parent = parentRaw;
        if (!parent.startsWith("#")) parent = `# ${parent}`;
        const parentNorm = normLine(parent);

        // 查找父目录是否存在
        for (let i = 0; i < lines.length; i++) {
          if (normLine(lines[i]) === parentNorm) {
            parentLineNo = i;
            break;
          }
        }

        // 如果父目录不存在，先插入父目录
        if (parentLineNo === -1) {
          // 在文件末尾插入父目录
          let parentInsertLine = lines.length;
          let parentInsertText = "";
          if (parentInsertLine > 0 && !lines[parentInsertLine - 1].trim()) {
            // 如果最后一行是空行，不需要额外换行
          } else {
            parentInsertText += "\n";
          }
          parentInsertText += `${parent}\n\n`;

          editor.replaceRange(parentInsertText, { line: parentInsertLine, ch: 0 });
          await this.app.vault.modify(af, editor.getValue());
          lines = editor.getValue().split("\n");

          // 重新查找父目录位置
          for (let i = 0; i < lines.length; i++) {
            if (normLine(lines[i]) === parentNorm) {
              parentLineNo = i;
              break;
            }
          }
        }
      }

      // 确定插入位置
      let insertLine = lines.length;

      // 如果父目录存在，在父目录下方查找插入位置
      if (parentLineNo >= 0) {
        // 找到父目录段落的结束位置（遇到同级或更高标题）
        const parentLevel = this.getHeadingLevel(lines[parentLineNo]);
        for (let i = parentLineNo + 1; i < lines.length; i++) {
          const lv = this.getHeadingLevel(lines[i]);
          if (lv > 0 && lv <= parentLevel) {
            insertLine = i;
            break;
          }
        }
      } else {
        // 没有父目录，使用原来的逻辑
        const anchorRaw = (insertBeforeHeading ?? "").trim();
        let anchor = anchorRaw;
        if (anchor && !anchor.startsWith("#")) anchor = `### ${anchor}`;
        const anchorNorm = anchor ? normLine(anchor) : "";

        if (anchorNorm) {
          for (let i = 0; i < lines.length; i++) {
            if (normLine(lines[i]) === anchorNorm) { insertLine = i; break; }
          }
        }
      }

      // ✅ 检查插入位置之前是否有 '---' 分隔线，如果有则调整插入位置到 '---' 上方
      if (insertLine > 0) {
        // 从插入位置向上查找第一个非空行
        let checkLine = insertLine - 1;
        while (checkLine >= 0 && this.isBlankLine(lines[checkLine])) checkLine--;
        
        if (checkLine >= 0) {
          const checkLineContent = String(lines[checkLine] ?? "").trim();
          if (/^-{3,}$/.test(checkLineContent)) {
            // 找到 '---' 分隔线，继续向上查找下一个非空行
            let prevNonEmpty = checkLine - 1;
            while (prevNonEmpty >= 0 && this.isBlankLine(lines[prevNonEmpty])) prevNonEmpty--;
            
            if (prevNonEmpty >= 0) {
              // 插入到 '---' 之前的最后一个非空行之后
              insertLine = prevNonEmpty + 1;
            } else {
              // 如果 '---' 之前没有非空行，插入到 '---' 之前
              insertLine = checkLine;
            }
          }
        }
      }

      let insertText = "";
      if (insertLine > 0 && !lines[insertLine - 1].trim()) {
        // no-op
      } else {
        insertText += "\n";
      }
      insertText += `${target}\n\n`;

      editor.replaceRange(insertText, { line: insertLine, ch: 0 });
      await this.app.vault.modify(af, editor.getValue());

      lines = editor.getValue().split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (normLine(lines[i]) === targetNorm) { lineNo = i; break; }
      }

      new Notice(`已创建标题：${target.replace(/^#+\s*/, "")}`);
    }

    // 目标：把光标放到该标题所在段落内容的“末尾空行”的行首，方便继续写。
    // 若末尾没有空行，则在下一个同级/更高标题之前插入 1 行空行（best-effort）。
    lines = editor.getValue().split("\n");
    const level = this.getHeadingLevel(lines[lineNo] ?? target);

    // 找到该标题段落的结束行（遇到同级或更高标题）
    let endLineExcl = lines.length;
    for (let i = lineNo + 1; i < lines.length; i++) {
      const lv = this.getHeadingLevel(lines[i]);
      if (lv > 0 && lv <= level) { endLineExcl = i; break; }
    }

    // 从段落末尾回扫，找到“最后一个非空行”
    let k = endLineExcl - 1;
    while (k > lineNo && this.isBlankLine(lines[k])) k--;

    // ✅ 如果最后一个非空行是 '---' 分隔线，继续向上查找下一个非空行
    if (k > lineNo) {
      const lastNonEmptyLine = String(lines[k] ?? "").trim();
      if (/^-{3,}$/.test(lastNonEmptyLine)) {
        // 这是 '---' 分隔线，继续向上查找下一个非空行
        let prevNonEmpty = k - 1;
        while (prevNonEmpty > lineNo && this.isBlankLine(lines[prevNonEmpty])) prevNonEmpty--;
        if (prevNonEmpty > lineNo) {
          k = prevNonEmpty; // 使用 '---' 之前的最后一个非空行
        } else {
          // 如果 '---' 之前没有非空行，则定位到标题行之后
          k = lineNo;
        }
      }
    }

    let cursorLine = k + 1; // 理想：非空行后第一行（应为空行）

    // 如果没有尾部空行：在 endLineExcl 处插入一个空行（插在下一个标题前）
    if (cursorLine >= endLineExcl) {
      editor.replaceRange("\n", { line: endLineExcl, ch: 0 });
      await this.app.vault.modify(af, editor.getValue());
      lines = editor.getValue().split("\n");
      cursorLine = endLineExcl; // 插入的空行就是这一行
    }

    // 防御：确保不落在标题行本身
    if (cursorLine <= lineNo) cursorLine = lineNo + 1;

    editor.setCursor({ line: cursorLine, ch: 0 });
    editor.scrollIntoView(
      { from: { line: Math.max(cursorLine - 2, 0), ch: 0 }, to: { line: cursorLine + 6, ch: 0 } },
      true
    );
  }

  /**
   * 打开笔记并滚动到指定行（1-based），不修改文件。
   * 用于 Review 周报/月报子窗口等只读定位。
   */
  async openNoteAtLineViewOnly(path: string, lineNo1Based: number) {
    const p = (path ?? "").trim();
    if (!p) {
      new Notice("未配置文件路径");
      return;
    }

    const af = this.app.vault.getAbstractFileByPath(p);
    if (!af || !(af instanceof TFile)) {
      new Notice(`未找到文件：${p}`);
      return;
    }

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(af, { active: true });
    await new Promise((r) => setTimeout(r, 0));

    const view = leaf.view;
    if (!(view instanceof MarkdownView)) {
      new Notice("当前打开的不是 Markdown 文件，无法定位");
      return;
    }

    const editor = view.editor;
    const lines = editor.getValue().split("\n");
    if (lines.length === 0) return;

    let line0 = Math.max(0, Number(lineNo1Based ?? 1) - 1);
    if (Number.isNaN(line0)) line0 = 0;
    if (line0 >= lines.length) line0 = lines.length - 1;

    editor.setCursor({ line: line0, ch: 0 });
    editor.scrollIntoView(
      { from: { line: Math.max(line0 - 2, 0), ch: 0 }, to: { line: line0 + 8, ch: 0 } },
      true,
    );
  }

  /**
   * 打开指定路径的 md 文件并定位到某一行附近；
   * 光标落点规则沿用你之前的要求：落在该段落内容的“末尾空行行首”（多空行取最后一个；没有则补一行空行）。
   *
   * lineNo1Based: 1-based 行号（更符合 UI/索引语义）
   */
  async openNoteAtLine(path: string, lineNo1Based: number) {
    const p = (path ?? "").trim();
    if (!p) {
      new Notice("未配置文件路径");
      return;
    }

    const af = this.app.vault.getAbstractFileByPath(p);
    if (!af || !(af instanceof TFile)) {
      new Notice(`未找到文件：${p}`);
      return;
    }

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(af, { active: true });

    // 让 editor ready
    await new Promise((r) => setTimeout(r, 0));

    const view = leaf.view;
    if (!(view instanceof MarkdownView)) {
      new Notice("当前打开的不是 Markdown 文件，无法定位");
      return;
    }

    const editor = view.editor;
    let lines = editor.getValue().split("\n");
    if (lines.length === 0) lines = [""]; 

    let targetLine = Math.max(0, Number(lineNo1Based ?? 1) - 1);
    if (Number.isNaN(targetLine)) targetLine = 0;
    if (targetLine >= lines.length) targetLine = lines.length - 1;

    // 对于 task/list：尽量把“段落”限定在当前条目块，避免跳到整个列表末尾
    const startLine = targetLine;
    const startIndent = this.getIndent(lines[startLine] ?? "");
    const listLike = this.isListLike(lines[startLine] ?? "");

    let endLine = startLine;
    let i = startLine + 1;

    // 避免 fenced code block 中的误判：若目标行在 code block 内，直接按普通段落处理
    // （这里不做完整 code block 解析，只做轻量 best-effort）

    if (listLike) {
      while (i < lines.length) {
        const cur = lines[i] ?? "";
        if (this.isBlankLine(cur)) break;

        // 新的同级 list item / heading：认为当前条目结束
        const indent = this.getIndent(cur);
        if (indent <= startIndent) {
          if (this.isListLike(cur)) break;
          if (this.getHeadingLevel(cur) > 0) break;
          // 同级普通文本：保守处理为结束（避免跨段落）
          break;
        }

        // 更深缩进：视为当前条目的 continuation
        endLine = i;
        i++;
      }
    } else {
      // 普通段落：走到第一个空行
      while (i < lines.length && !this.isBlankLine(lines[i])) {
        // 遇到标题：段落结束
        if (this.getHeadingLevel(lines[i]) > 0) break;
        endLine = i;
        i++;
      }
    }

    let blankStart = endLine + 1;
    // 若下一行是 fenced code fence，也视为段落边界
    if (blankStart < lines.length && this.isCodeFence(lines[blankStart])) {
      // 插入一个空行，避免落到 fence 上
      editor.replaceRange("\n", { line: blankStart, ch: 0 });
      await this.app.vault.modify(af, editor.getValue());
      lines = editor.getValue().split("\n");
    }

    // 找到段落末尾的空行（多空行取最后一个）
    if (blankStart < lines.length && this.isBlankLine(lines[blankStart])) {
      let j = blankStart;
      while (j < lines.length && this.isBlankLine(lines[j])) j++;
      const cursorLine = Math.max(blankStart, j - 1);
      editor.setCursor({ line: cursorLine, ch: 0 });
      editor.scrollIntoView(
        { from: { line: Math.max(cursorLine - 2, 0), ch: 0 }, to: { line: cursorLine + 6, ch: 0 } },
        true
      );
      return;
    }

    // 没有空行：在段落结束处补一行空行
    editor.replaceRange("\n", { line: blankStart, ch: 0 });
    await this.app.vault.modify(af, editor.getValue());
    const cursorLine = blankStart;
    editor.setCursor({ line: cursorLine, ch: 0 });
    editor.scrollIntoView(
      { from: { line: Math.max(cursorLine - 2, 0), ch: 0 }, to: { line: cursorLine + 6, ch: 0 } },
      true
    );
  }

  /**
   * 打开指定路径的 md 文件并定位到某一行附近：
   * - 光标最终落在“该段落/该任务项”的末尾空行行首（若没有空行则自动补 1 行）
   * - 适用于任务/项目任务等从索引跳转的场景
   *
   * @param path vault 内路径
   * @param lineNo1Based 1-based 行号（来自索引）
   */
  async openNoteAtLineAndParagraphEnd(path: string, lineNo1Based: number) {
    const p = (path ?? "").trim();
    if (!p) {
      new Notice("未指定文件路径");
      return;
    }

    const af = this.app.vault.getAbstractFileByPath(p);
    if (!af || !(af instanceof TFile)) {
      new Notice(`未找到文件：${p}`);
      return;
    }

    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(af, { active: true });
    await new Promise((r) => setTimeout(r, 0));

    const view = leaf.view;
    if (!(view instanceof MarkdownView)) {
      new Notice("当前打开的不是 Markdown 文件，无法定位");
      return;
    }

    const editor = view.editor;
    let lines = editor.getValue().split("\n");
    const target0 = Math.max(0, Math.min((Number(lineNo1Based ?? 1) || 1) - 1, Math.max(lines.length - 1, 0)));

    // Determine the logical end of the block.
    const line = lines[target0] ?? "";
    const baseIndent = this.getIndent(line);
    const listLike = this.isListLike(line);

    // Skip fenced code blocks heuristically: if target line is inside a fence, just place cursor at that line.
    let inFence = false;
    for (let i = 0; i <= target0 && i < lines.length; i++) {
      if (this.isCodeFence(lines[i])) inFence = !inFence;
    }
    if (inFence) {
      editor.setCursor({ line: target0, ch: 0 });
      editor.scrollIntoView({ from: { line: Math.max(target0 - 2, 0), ch: 0 }, to: { line: target0 + 6, ch: 0 } }, true);
      return;
    }

    let endLine = target0;
    for (let i = target0 + 1; i < lines.length; i++) {
      const cur = lines[i] ?? "";
      if (this.isBlankLine(cur)) {
        break;
      }

      // Headings break blocks.
      if (this.getHeadingLevel(cur) > 0) break;

      if (listLike) {
        const ind = this.getIndent(cur);
        // A new list item at same or smaller indent ends the current item block.
        if (ind <= baseIndent && this.isListLike(cur)) {
          break;
        }
        // Continuation lines are usually more indented than the list item.
        if (ind > baseIndent) {
          endLine = i;
          continue;
        }
        // Non-indented non-blank line: treat as block boundary.
        break;
      } else {
        // Normal paragraph: keep going until blank line.
        endLine = i;
      }
    }

    let cursorLine = endLine + 1;

    // If there is a blank-line run, pick the last blank line in that run.
    if (cursorLine < lines.length && this.isBlankLine(lines[cursorLine])) {
      let j = cursorLine;
      while (j < lines.length && this.isBlankLine(lines[j])) j++;
      cursorLine = j - 1;
    } else {
      // No blank line: insert one at cursorLine (best-effort, without breaking content too much).
      editor.replaceRange("\n", { line: cursorLine, ch: 0 });
      await this.app.vault.modify(af, editor.getValue());
      lines = editor.getValue().split("\n");
      cursorLine = Math.min(cursorLine, lines.length - 1);
    }

    editor.setCursor({ line: cursorLine, ch: 0 });
    editor.scrollIntoView({ from: { line: Math.max(cursorLine - 2, 0), ch: 0 }, to: { line: cursorLine + 6, ch: 0 } }, true);
  }
}
