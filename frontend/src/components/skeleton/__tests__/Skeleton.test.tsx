// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import fs from "fs";
import path from "path";
import { render, screen } from "@testing-library/react";
import {
  DashboardSkeleton,
  LoadingRegion,
  PoolOverviewSkeleton,
  SkeletonChart,
  SkeletonStatCard,
  SkeletonTable,
} from "../Skeleton";
import {
  DASHBOARD_REGION_MIN_HEIGHT,
  DASHBOARD_TABLE_ROWS,
  POOL_OVERVIEW_MIN_HEIGHT,
  SKELETON_LAYOUT,
  tableHeight,
} from "@/lib/skeleton-layout";

const px = (el: HTMLElement, prop: "height" | "minHeight") => parseFloat(el.style[prop]);

describe("skeleton dimensions", () => {
  it("stat card reserves the shared stat-card height", () => {
    render(<SkeletonStatCard />);
    expect(px(screen.getByTestId("skeleton-stat-card"), "minHeight")).toBe(SKELETON_LAYOUT.statCard);
  });

  it("table skeleton height equals header + rows at the real row height", () => {
    render(<SkeletonTable rows={3} />);
    const table = screen.getByTestId("skeleton-table");
    expect(px(table, "height")).toBe(tableHeight(3));
    expect(table.querySelectorAll("[data-skeleton-row]")).toHaveLength(3);
  });

  it("chart skeleton uses the real chart height", () => {
    render(<SkeletonChart />);
    expect(px(screen.getByTestId("skeleton-chart"), "height")).toBe(SKELETON_LAYOUT.chart);
  });

  it("dashboard skeleton parts add up to the reserved region height", () => {
    const { getByTestId } = render(<DashboardSkeleton />);
    const root = getByTestId("dashboard-skeleton");
    const total =
      px(root.querySelector("[data-testid=skeleton-card]") as HTMLElement, "height") +
      SKELETON_LAYOUT.sectionGap +
      px(getByTestId("skeleton-chart"), "height") +
      SKELETON_LAYOUT.sectionGap +
      px(getByTestId("skeleton-table"), "height");

    expect(total).toBe(DASHBOARD_REGION_MIN_HEIGHT);
    expect(root.querySelectorAll("[data-skeleton-row]")).toHaveLength(DASHBOARD_TABLE_ROWS);
  });

  it("pool overview skeleton parts add up to the reserved region height", () => {
    const { getByTestId, getAllByTestId } = render(<PoolOverviewSkeleton />);
    const stat = px(getAllByTestId("skeleton-stat-card")[0], "minHeight");
    const panel = px(
      getByTestId("pool-overview-skeleton").querySelector(
        ":scope > [data-skeleton-panel]"
      ) as HTMLElement,
      "height"
    );
    expect(stat + SKELETON_LAYOUT.gap + panel).toBe(POOL_OVERVIEW_MIN_HEIGHT);
  });
});

describe("LoadingRegion", () => {
  it("is aria-busy with a status label while loading, and hides the skeleton from AT", () => {
    const { container } = render(
      <LoadingRegion
        loading
        label="Loading pool metrics"
        skeleton={<SkeletonTable rows={2} />}
        minHeight={400}
      >
        <p>content</p>
      </LoadingRegion>
    );
    const region = container.querySelector("[data-loading-region]") as HTMLElement;
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Loading pool metrics");
    expect(screen.getByTestId("skeleton-table")).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByText("content")).not.toBeInTheDocument();
  });

  it("occupies the same space before and after content arrives", () => {
    const skeleton = <SkeletonTable rows={2} />;
    const { container, rerender } = render(
      <LoadingRegion loading label="Loading" skeleton={skeleton} minHeight={DASHBOARD_REGION_MIN_HEIGHT}>
        <p>content</p>
      </LoadingRegion>
    );
    const region = container.querySelector("[data-loading-region]") as HTMLElement;
    const loadingHeight = region.style.minHeight;

    rerender(
      <LoadingRegion
        loading={false}
        label="Loading"
        skeleton={skeleton}
        minHeight={DASHBOARD_REGION_MIN_HEIGHT}
      >
        <p>content</p>
      </LoadingRegion>
    );

    expect(region).toHaveAttribute("aria-busy", "false");
    expect(screen.getByText("content")).toBeInTheDocument();
    expect(region.style.minHeight).toBe(loadingHeight);
    expect(parseFloat(loadingHeight)).toBe(DASHBOARD_REGION_MIN_HEIGHT);
  });

  it("skips the reserved height when told not to (e.g. error state)", () => {
    const { container } = render(
      <LoadingRegion loading={false} label="Loading" skeleton={null} minHeight={500} reserve={false}>
        <p>error</p>
      </LoadingRegion>
    );
    expect((container.querySelector("[data-loading-region]") as HTMLElement).style.minHeight).toBe("");
  });
});

describe("reduced motion", () => {
  const css = fs.readFileSync(path.join(__dirname, "../../../app/globals.css"), "utf8");

  it("animates the shimmer by default", () => {
    expect(css).toMatch(/\.skeleton\s*\{[^}]*animation:\s*skeleton-shimmer/);
  });

  it("disables the shimmer under prefers-reduced-motion", () => {
    const block = css.match(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.skeleton\s*\{([^}]*)\}/
    );
    expect(block).not.toBeNull();
    expect(block![1]).toMatch(/animation:\s*none/);
  });
});
