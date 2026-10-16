// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import {
  DASHBOARD_REGION_MIN_HEIGHT,
  DASHBOARD_TABLE_ROWS,
  POOL_OVERVIEW_MIN_HEIGHT,
  SKELETON_LAYOUT,
  tableHeight,
} from "@/lib/skeleton-layout";

/**
 * Layout-matching loading placeholders. Every size comes from
 * `SKELETON_LAYOUT`, which the real content also reserves, so the swap from
 * skeleton to data does not move controls. The shimmer lives in globals.css
 * (`.skeleton`) and is disabled under `prefers-reduced-motion`.
 */

const BLOCK = "skeleton rounded-md bg-slate-800/70";

/** Decorative block; hidden from assistive technology. */
export function Skeleton({
  width,
  height,
  className = "",
}: {
  width?: number | string;
  height?: number | string;
  className?: string;
}) {
  return (
    <div aria-hidden="true" data-skeleton className={`${BLOCK} ${className}`} style={{ width, height }} />
  );
}

function Panel({
  height,
  exact = false,
  children,
  testId,
}: {
  height: number;
  /** Fixed `height` (charts, panels) instead of a `minHeight` (stat cards). */
  exact?: boolean;
  children?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div
      aria-hidden="true"
      data-skeleton-panel
      data-testid={testId}
      className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5"
      style={exact ? { height } : { minHeight: height }}
    >
      {children}
    </div>
  );
}

export function SkeletonStatCard() {
  return (
    <Panel height={SKELETON_LAYOUT.statCard} testId="skeleton-stat-card">
      <Skeleton width="45%" height={10} />
      <Skeleton width="65%" height={28} className="mt-3" />
      <Skeleton width="35%" height={10} className="mt-3" />
    </Panel>
  );
}

export function SkeletonStatGrid({
  count = 4,
  className = "grid grid-cols-2 gap-4 md:grid-cols-4",
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div aria-hidden="true" className={className}>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonStatCard key={i} />
      ))}
    </div>
  );
}

export function SkeletonCard({ height = SKELETON_LAYOUT.card }: { height?: number }) {
  return (
    <Panel height={height} exact testId="skeleton-card">
      <Skeleton width="40%" height={16} />
      <Skeleton width="100%" height={12} className="mt-4" />
      <Skeleton width="85%" height={12} className="mt-3" />
      <Skeleton width="70%" height={12} className="mt-3" />
    </Panel>
  );
}

export function SkeletonChart({ height = SKELETON_LAYOUT.chart }: { height?: number }) {
  return (
    <Panel height={height} exact testId="skeleton-chart">
      <Skeleton width="30%" height={16} />
      <Skeleton width="100%" height={height - 40 - 16 - 16} className="mt-4" />
    </Panel>
  );
}

export function SkeletonTable({
  rows = DASHBOARD_TABLE_ROWS,
  rowHeight = SKELETON_LAYOUT.tableRow,
}: {
  rows?: number;
  rowHeight?: number;
}) {
  return (
    <div
      aria-hidden="true"
      data-testid="skeleton-table"
      className="overflow-hidden rounded-lg border border-slate-800 bg-slate-900/80"
      style={{ height: tableHeight(rows, rowHeight) }}
    >
      <div
        className="flex items-center gap-6 border-b border-slate-800 px-4"
        style={{ height: SKELETON_LAYOUT.tableHeader }}
      >
        <Skeleton width="18%" height={10} />
        <Skeleton width="14%" height={10} />
        <Skeleton width="22%" height={10} />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          data-skeleton-row
          className="flex items-center gap-6 border-b border-slate-800/60 px-4 last:border-b-0"
          style={{ height: rowHeight }}
        >
          <Skeleton width="18%" height={14} />
          <Skeleton width="14%" height={14} />
          <Skeleton width="22%" height={14} />
        </div>
      ))}
    </div>
  );
}

/** Borrower dashboard skeleton: cards, chart and table at real dimensions. */
export function DashboardSkeleton() {
  return (
    <div aria-hidden="true" data-testid="dashboard-skeleton" className="flex flex-col gap-8">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <SkeletonCard />
        <SkeletonCard />
      </div>
      <SkeletonChart />
      <SkeletonTable />
    </div>
  );
}

/** Investor pool overview skeleton: stat row plus the health panel. */
export function PoolOverviewSkeleton() {
  return (
    <div aria-hidden="true" data-testid="pool-overview-skeleton" className="flex flex-col gap-4">
      <SkeletonStatGrid />
      <Panel height={SKELETON_LAYOUT.summaryPanel} exact>
        <Skeleton width="35%" height={12} />
        <Skeleton width="100%" height={12} className="mt-6" />
        <Skeleton width="100%" height={12} className="mt-6" />
      </Panel>
    </div>
  );
}

/**
 * Wraps a region that swaps between a skeleton and real content. Marks the
 * region `aria-busy` while loading, announces `label` to assistive technology,
 * and reserves `minHeight` in both states so nothing jumps.
 */
export function LoadingRegion({
  loading,
  label,
  skeleton,
  minHeight,
  reserve = true,
  className,
  children,
}: {
  loading: boolean;
  /** Spoken to screen readers while loading, e.g. "Loading pool metrics". */
  label: string;
  skeleton: React.ReactNode;
  minHeight?: number;
  /** Set false to skip the reserved height (e.g. while an error is shown). */
  reserve?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      aria-busy={loading}
      data-loading-region
      className={className}
      style={reserve && minHeight ? { minHeight } : undefined}
    >
      {loading ? (
        <>
          <span role="status" className="sr-only">
            {label}
          </span>
          {skeleton}
        </>
      ) : (
        children
      )}
    </div>
  );
}

export { DASHBOARD_REGION_MIN_HEIGHT, POOL_OVERVIEW_MIN_HEIGHT };
