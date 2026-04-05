import { normalizePath } from "obsidian";

export type MissingFinanceDataItem = {
  code: string;
  title: string;
  detail: string;
  hint?: string;
};

export type FinanceAnalysisAlertIndexFile = {
  version: 1;
  generatedAt: string;
  spaceId: string;
  mode: string;
  status: "ok" | "missing_data";
  missingData: MissingFinanceDataItem[];
  summary: {
    missingCount: number;
  };
};

async function ensureFolder(plugin: any, path: string): Promise<void> {
  const p = normalizePath(String(path ?? "").trim());
  if (!p) return;
  const exists = await plugin.app.vault.adapter.exists(p);
  if (exists) return;
  const parts = p.split("/");
  let cur = "";
  for (const seg of parts) {
    cur = cur ? `${cur}/${seg}` : seg;
    const ok = await plugin.app.vault.adapter.exists(cur);
    if (!ok) {
      try {
        await plugin.app.vault.createFolder(cur);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (msg.includes("Folder already exists") || msg.includes("EEXIST")) continue;
        throw e;
      }
    }
  }
}

function detectMissingFinanceData(plugin: any, financeItems: any[]): MissingFinanceDataItem[] {
  const out: MissingFinanceDataItem[] = [];
  const categories = Array.isArray(plugin?.settings?.financeCategories) ? plugin.settings.financeCategories : [];
  const activeCategories = categories.filter((x: any) => !!x?.active);
  const activeIncome = activeCategories.filter((x: any) => String(x?.type ?? "") === "income");
  const activeExpense = activeCategories.filter((x: any) => String(x?.type ?? "") === "expense");

  if (categories.length === 0) {
    out.push({
      code: "MISSING_FINANCE_CATEGORY_LIST",
      title: "缺少财务分类清单",
      detail: "未配置任何财务分类，无法完成分类池统计与告警分析。",
      hint: "请先在设置页新增财务分类，至少包含收入与支出分类。",
    });
  }
  if (activeIncome.length === 0) {
    out.push({
      code: "MISSING_ACTIVE_INCOME_CATEGORY",
      title: "缺少启用中的收入分类",
      detail: "当前没有启用的收入分类，收入类指标（结余率、现金流等）可能失真。",
      hint: "请至少启用一个收入分类。",
    });
  }
  if (activeExpense.length === 0) {
    out.push({
      code: "MISSING_ACTIVE_EXPENSE_CATEGORY",
      title: "缺少启用中的支出分类",
      detail: "当前没有启用的支出分类，支出类统计与告警无法计算。",
      hint: "请至少启用一个支出分类。",
    });
  }
  if (!Array.isArray(financeItems) || financeItems.length === 0) {
    out.push({
      code: "MISSING_FINANCE_RECORDS",
      title: "缺少财务记录",
      detail: "财务索引中没有任何流水，无法生成趋势与告警。",
      hint: "请先新增财务记录并刷新财务模块。",
    });
    return out;
  }

  const validItems = financeItems.filter((x: any) => !x?.isDelete);
  const hasIncome = validItems.some((x: any) => String(x?.type ?? "") === "income");
  const hasExpense = validItems.some((x: any) => String(x?.type ?? "") === "expense");

  if (!hasIncome) {
    out.push({
      code: "MISSING_INCOME_RECORDS",
      title: "缺少收入流水",
      detail: "当前有效财务记录中没有收入项，部分衍生指标不可分析。",
      hint: "请补充至少一条收入流水。",
    });
  }
  if (!hasExpense) {
    out.push({
      code: "MISSING_EXPENSE_RECORDS",
      title: "缺少支出流水",
      detail: "当前有效财务记录中没有支出项，部分衍生指标不可分析。",
      hint: "请补充至少一条支出流水。",
    });
  }
  return out;
}

/** 读取分析诊断索引（不存在或解析失败时返回 null）。`spaceId` 传入时读该空间索引目录（Hub 多空间用）。 */
export async function readFinanceAnalysisAlertIndex(plugin: any, spaceId?: string): Promise<FinanceAnalysisAlertIndexFile | null> {
  try {
    const root = String(
      typeof spaceId === "string" && spaceId.trim()
        ? plugin?.getSpaceIndexDir?.(spaceId.trim())
        : plugin?.getSpaceIndexDir?.()
    ).trim();
    if (!root) return null;
    const path = normalizePath(`${root}/finance-analysis/finance-analysis.alert-index.json`);
    const ok = await plugin.app.vault.adapter.exists(path);
    if (!ok) return null;
    const raw = await plugin.app.vault.adapter.read(path);
    const j = JSON.parse(String(raw ?? "{}"));
    if (!j || typeof j !== "object") return null;
    if (j.version !== 1) return null;
    const missingData = Array.isArray(j.missingData) ? j.missingData : [];
    return {
      version: 1,
      generatedAt: String(j.generatedAt ?? ""),
      spaceId: String(j.spaceId ?? ""),
      mode: String(j.mode ?? ""),
      status: j.status === "missing_data" ? "missing_data" : "ok",
      missingData,
      summary: {
        missingCount: Number(j.summary?.missingCount ?? missingData.length) || 0,
      },
    };
  } catch (e) {
    console.warn("[RSLatte][finance-analysis] read alert index failed", e);
    return null;
  }
}

export async function writeFinanceAnalysisAlertIndex(plugin: any, mode: string): Promise<void> {
  try {
    const spaceId = String(plugin?.getSpaceCtx?.()?.spaceId ?? "default");
    const root = String(plugin?.getSpaceIndexDir?.() ?? "").trim();
    if (!root) return;
    const dir = normalizePath(`${root}/finance-analysis`);
    const path = normalizePath(`${dir}/finance-analysis.alert-index.json`);
    await ensureFolder(plugin, dir);

    const fsnap = await plugin?.recordRSLatte?.getFinanceSnapshot?.(false);
    const items = Array.isArray(fsnap?.items) ? fsnap.items : [];
    const missingData = detectMissingFinanceData(plugin, items);
    const file: FinanceAnalysisAlertIndexFile = {
      version: 1,
      generatedAt: new Date().toISOString(),
      spaceId,
      mode: String(mode ?? ""),
      status: missingData.length > 0 ? "missing_data" : "ok",
      missingData,
      summary: {
        missingCount: missingData.length,
      },
    };
    await plugin.app.vault.adapter.write(path, JSON.stringify(file, null, 2));
  } catch (e) {
    console.warn("[RSLatte][finance-analysis] write alert index failed", e);
  }
}

