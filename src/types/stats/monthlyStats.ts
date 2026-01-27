import type { WorkEventKind } from "./workEvent";

export interface MonthlyStats {
  yearMonth: string; // YYYY-MM
  generatedAt: string; // ISO string
  spaces: Record<string, SpaceMonthlyStats>;
}

export interface SpaceMonthlyStats {
  spaceId: string;
  spaceName: string;
  modules: Record<WorkEventKind, ModuleMonthlyStats>;
  summary: {
    totalEvents: number;
    totalByKind: Record<WorkEventKind, number>;
    totalByAction: Record<string, number>;
  };
}

export interface ModuleMonthlyStats {
  kind: WorkEventKind;
  totalEvents: number;
  byAction: Record<string, number>;
  byDay: Record<string, number>; // YYYY-MM-DD -> count
  metrics: {
    totalAmount?: number; // for finance
    totalCount?: number; // for task/memo/etc
    averagePerDay?: number;
    peakDay?: string; // YYYY-MM-DD
    peakDayCount?: number;
  };
}
