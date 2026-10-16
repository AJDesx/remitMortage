// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Single source of truth for the dimensions shared by skeleton placeholders and
 * the real content they stand in for. The real cards/rows reserve the same
 * `minHeight`/`height` (see `MetricCard`, admin overview cards, milestone rows),
 * so swapping skeleton → content does not shift the layout.
 */
export const SKELETON_LAYOUT = {
  /** Stat / KPI card (invest pool metrics, admin pool overview). */
  statCard: 108,
  /** Gap between stat cards and between stacked regions (Tailwind gap-4). */
  gap: 16,
  /** Large dashboard section gap (Tailwind space-y-8). */
  sectionGap: 32,
  /** Generic dashboard card / panel. */
  card: 256,
  /** Chart canvas including its title row. */
  chart: 320,
  /** Table header row. */
  tableHeader: 48,
  /** Table / list row. */
  tableRow: 72,
  /** Health / summary panel under the investor stat cards. */
  summaryPanel: 200,
} as const;

/** Total height of a skeleton (or reserved) table with `rows` data rows. */
export function tableHeight(rows: number, rowHeight: number = SKELETON_LAYOUT.tableRow): number {
  return SKELETON_LAYOUT.tableHeader + rows * rowHeight;
}

/** Number of data rows used by the dashboard skeletons. */
export const DASHBOARD_TABLE_ROWS = 4;

/** Borrower dashboard: card row + chart + table, separated by `sectionGap`. */
export const DASHBOARD_REGION_MIN_HEIGHT =
  SKELETON_LAYOUT.card +
  SKELETON_LAYOUT.sectionGap +
  SKELETON_LAYOUT.chart +
  SKELETON_LAYOUT.sectionGap +
  tableHeight(DASHBOARD_TABLE_ROWS);

/** Investor pool overview: stat row + summary panel. */
export const POOL_OVERVIEW_MIN_HEIGHT =
  SKELETON_LAYOUT.statCard + SKELETON_LAYOUT.gap + SKELETON_LAYOUT.summaryPanel;
