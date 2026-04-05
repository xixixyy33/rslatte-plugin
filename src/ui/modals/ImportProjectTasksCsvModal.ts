import { App, ButtonComponent, Modal, Notice, Setting } from "obsidian";

import type RSLattePlugin from "../../main";
import { resolveProjectTaskDateBounds, validateProjectTaskDates } from "../../utils/projectDateConstraints";

type CsvTaskRow = {
  lineNo: number;
  text: string;
  planned_start?: string;
  planned_end: string;
  estimate_h?: number;
};

type CsvPreviewRow = CsvTaskRow & { error?: string };

const CSV_HEADERS = ["任务描述", "计划开始日", "计划结束日", "工时评估"] as const;

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\"") {
      if (inQuote && line[i + 1] === "\"") {
        cur += "\"";
        i++;
      } else {
        inQuote = !inQuote;
      }
      continue;
    }
    if (ch === "," && !inQuote) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => String(s ?? "").trim());
}

function normalizeLooseYmd(v: string): string {
  const raw = String(v ?? "").trim();
  if (!raw) return "";
  const m = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return raw;
  const mm = String(Number(m[2])).padStart(2, "0");
  const dd = String(Number(m[3])).padStart(2, "0");
  return `${m[1]}-${mm}-${dd}`;
}

function isYmd(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "").trim());
}

function parseCsvRows(text: string): CsvPreviewRow[] {
  const allLines = String(text ?? "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((x) => x.trimEnd());
  const firstNonEmpty = allLines.findIndex((x) => String(x ?? "").trim().length > 0);
  if (firstNonEmpty < 0) return [];
  const lines = allLines.slice(firstNonEmpty);

  if (!lines.length) return [];
  const header = parseCsvLine(lines[0] ?? "");
  const norm = (s: string) => String(s ?? "").trim().toLowerCase();
  const expected = CSV_HEADERS.map((x) => norm(x));
  const headerOk =
    header.length >= 4 &&
    norm(header[0]) === expected[0] &&
    norm(header[1]) === expected[1] &&
    norm(header[2]) === expected[2] &&
    norm(header[3]) === expected[3];
  if (!headerOk) {
    return [
      {
        lineNo: 1,
        text: "",
        planned_end: "",
        error: `表头不匹配，需为：${CSV_HEADERS.join("、")}`,
      },
    ];
  }

  const out: CsvPreviewRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const ln = i + 1;
    const line = String(lines[i] ?? "").trim();
    if (!line) continue;
    const cols = parseCsvLine(line);
    const textVal = String(cols[0] ?? "").trim();
    const startVal = normalizeLooseYmd(String(cols[1] ?? ""));
    const endVal = normalizeLooseYmd(String(cols[2] ?? ""));
    const estRaw = String(cols[3] ?? "").trim();

    let err = "";
    if (!textVal) err = "任务描述为空";
    else if (!isYmd(endVal)) err = "计划结束日格式错误（需 YYYY-MM-DD 或 YYYY/M/D）";
    else if (startVal && !isYmd(startVal)) err = "计划开始日格式错误（需 YYYY-MM-DD 或 YYYY/M/D）";
    else if (estRaw && !/^\d+(\.\d+)?$/.test(estRaw)) err = "工时评估需为数字";

    out.push({
      lineNo: ln,
      text: textVal,
      planned_start: startVal || undefined,
      planned_end: endVal,
      estimate_h: estRaw ? Number(estRaw) : undefined,
      error: err || undefined,
    });
  }
  return out;
}

function applyProjectTaskBoundsToCsvRows(
  rows: CsvPreviewRow[],
  plugin: RSLattePlugin,
  projectFolderPath: string,
  milestonePath: string,
): void {
  const bounds = resolveProjectTaskDateBounds(
    plugin.projectMgr.getSnapshot().projects,
    projectFolderPath,
    String(milestonePath ?? "").trim(),
  );
  for (const r of rows) {
    if (r.error) continue;
    const v = validateProjectTaskDates({
      plannedStart: r.planned_start,
      plannedEnd: r.planned_end,
      bounds,
    });
    if (!v.ok) r.error = v.messages.join("；");
  }
}

function decodeCsvTextFromBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  if (!bytes.length) return "";
  const hasExpectedHeader = (txt: string): boolean => {
    try {
      const lines = String(txt ?? "")
        .replace(/^\uFEFF/, "")
        .split(/\r?\n/);
      const first = lines.find((x) => String(x ?? "").trim().length > 0) ?? "";
      const h = parseCsvLine(first).map((x) => String(x ?? "").trim().toLowerCase());
      const e = CSV_HEADERS.map((x) => String(x ?? "").trim().toLowerCase());
      return h.length >= 4 && h[0] === e[0] && h[1] === e[1] && h[2] === e[2] && h[3] === e[3];
    } catch {
      return false;
    }
  };
  // UTF-16 LE BOM: FF FE
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  // UTF-16 BE BOM: FE FF
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes);
  }
  // Heuristic: lots of zero bytes usually indicates UTF-16
  let zeroCnt = 0;
  const probe = Math.min(bytes.length, 512);
  for (let i = 0; i < probe; i++) {
    if (bytes[i] === 0) zeroCnt++;
  }
  if (zeroCnt > probe / 6) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  // Try UTF-8 first
  const utf8Text = new TextDecoder("utf-8").decode(bytes);
  if (hasExpectedHeader(utf8Text)) return utf8Text;

  // Fallback: GBK/GB18030（Windows 中文 Excel 常见）
  try {
    const gbText = new TextDecoder("gb18030").decode(bytes);
    if (hasExpectedHeader(gbText)) return gbText;
    return gbText;
  } catch {
    // Some runtimes may not support gb18030 label.
  }

  return utf8Text;
}

function csvTemplateContent(): string {
  return [
    "任务描述,计划开始日,计划结束日,工时评估",
    "示例任务A,2026-04-01,2026-04-03,4",
    "示例任务B,2026/4/3,2026/4/6,6.5",
  ].join("\n");
}

function downloadTemplateCsv(filename: string, content: string): void {
  const blob = new Blob([`\uFEFF${content}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 500);
}

export class ImportProjectTasksCsvModal extends Modal {
  constructor(
    app: App,
    private plugin: RSLattePlugin,
    private projectFolderPath: string,
    private milestoneName: string,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("批量导入项目任务（CSV）");

    contentEl.createDiv({
      cls: "rslatte-muted",
      text: `目标里程碑：${this.milestoneName}。支持列：任务描述、计划开始日、计划结束日、工时评估。`,
    });

    let rows: CsvPreviewRow[] = [];
    const summaryEl = contentEl.createDiv({ cls: "rslatte-muted" });
    const listWrap = contentEl.createDiv();
    listWrap.style.maxHeight = "280px";
    listWrap.style.overflow = "auto";
    listWrap.style.marginTop = "8px";
    listWrap.style.border = "1px solid var(--background-modifier-border)";
    listWrap.style.borderRadius = "6px";
    listWrap.style.padding = "6px";
    const btnRow = contentEl.createDiv({ cls: "rslatte-modal-actions" });
    const confirmBtn = new ButtonComponent(btnRow).setButtonText("确认并批量创建").setCta();
    confirmBtn.setDisabled(true);
    new ButtonComponent(btnRow).setButtonText("关闭").onClick(() => this.close());

    const renderPreview = () => {
      listWrap.empty();
      const okRows = rows.filter((r) => !r.error);
      const errRows = rows.filter((r) => !!r.error);
      summaryEl.setText(`解析 ${rows.length} 条：可导入 ${okRows.length}，错误 ${errRows.length}`);
      confirmBtn.setButtonText(`确认并批量创建（${okRows.length}）`);
      confirmBtn.setDisabled(okRows.length === 0 || errRows.length > 0);

      if (!rows.length) {
        listWrap.createDiv({ cls: "rslatte-muted", text: "尚未导入 CSV。" });
        return;
      }
      for (const r of rows) {
        const row = listWrap.createDiv();
        row.addClass("rslatte-csv-import-preview-row");
        if (r.error) row.addClass("rslatte-csv-import-row-error");
        row.style.padding = "4px 2px";
        row.style.borderBottom = "1px dashed var(--background-modifier-border)";
        const head = `L${r.lineNo} · ${r.text || "（空）"} · ${r.planned_start || "-"} ~ ${r.planned_end || "-"}`;
        row.createDiv({ text: head });
        if (r.estimate_h != null) row.createDiv({ cls: "rslatte-muted", text: `工时评估：${r.estimate_h}h` });
        if (r.error) {
          const e = row.createDiv({ text: `错误：${r.error}` });
          e.style.color = "var(--text-error)";
        }
      }
    };

    new Setting(contentEl)
      .setName("模板下载")
      .setDesc("先下载模板，按列填充后再导入")
      .addButton((b) =>
        b.setButtonText("下载 CSV 模板").onClick(() => {
          downloadTemplateCsv("项目任务导入模板.csv", csvTemplateContent());
          new Notice("已触发模板下载");
        }),
      );

    const importSetting = new Setting(contentEl)
      .setName("选择 CSV 文件")
      .setDesc("支持 UTF-8/BOM；日期支持 YYYY-MM-DD 或 YYYY/M/D");

    const picker = importSetting.controlEl.createEl("input", { type: "file" });
    picker.accept = ".csv,text/csv";
    picker.onchange = async () => {
      const f = picker.files?.[0];
      if (!f) return;
      try {
        const buf = await f.arrayBuffer();
        const text = decodeCsvTextFromBuffer(buf);
        rows = parseCsvRows(text);
        applyProjectTaskBoundsToCsvRows(rows, this.plugin, this.projectFolderPath, this.milestoneName);
        renderPreview();
      } catch (e: any) {
        new Notice(`读取 CSV 失败：${e?.message ?? String(e)}`);
      }
    };

    confirmBtn.onClick(async () => {
      const okRows = rows.filter((r) => !r.error);
      if (!okRows.length) {
        new Notice("没有可导入数据");
        return;
      }
      try {
        const res = await this.plugin.projectMgr.addTasksToMilestoneBatch(
          this.projectFolderPath,
          this.milestoneName,
          okRows.map((r) => ({
            text: r.text,
            dueDate: r.planned_end,
            scheduledDate: r.planned_start,
            estimateH: r.estimate_h,
          })),
        );
        new Notice(`已批量创建 ${res.created} 条项目任务`);
        this.plugin.refreshSidePanel();
        this.close();
      } catch (e: any) {
        new Notice(`批量创建失败：${e?.message ?? String(e)}`);
      }
    });

    renderPreview();
  }
}

