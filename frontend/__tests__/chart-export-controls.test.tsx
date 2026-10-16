// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import ChartExportControls from "../src/components/charts/ChartExportControls";
import type { ChartExportData } from "../src/lib/chart-export";

// Capture blobs handed to the downloader without touching the real DOM APIs.
const downloaded: Array<{ filename: string; content: string }> = [];
jest.mock("../src/lib/chart-export", () => {
  const actual = jest.requireActual("../src/lib/chart-export");
  return {
    ...actual,
    downloadTextFile: jest.fn((filename: string, content: string) => {
      downloaded.push({ filename, content });
    }),
    downloadBlobFile: jest.fn(),
  };
});

import { downloadTextFile } from "../src/lib/chart-export";

const DATA: ChartExportData = {
  columns: ["Month", "Deposits (USDC)"],
  rows: [
    ["2026-01", 100],
    ["2026-02", 250],
  ],
};

function renderControls(overrides: Partial<React.ComponentProps<typeof ChartExportControls>> = {}) {
  return render(
    <ChartExportControls
      chartTitle="Volume Trends (USDC)"
      fileBase="volume-trends"
      data={DATA}
      legend={[{ label: "Deposits", color: "#6366f1" }]}
      getChartContainer={() => document.querySelector("#chart") as HTMLElement}
      {...overrides}
    />
  );
}

beforeEach(() => {
  downloaded.length = 0;
  jest.clearAllMocks();
});

describe("ChartExportControls", () => {
  it("exports the currently displayed rows as CSV with a predictable name", () => {
    renderControls();

    fireEvent.click(screen.getByRole("button", { name: /export .* as csv/i }));

    expect(downloaded).toHaveLength(1);
    expect(downloaded[0].filename).toMatch(/^volume-trends-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(downloaded[0].content).toBe("Month,Deposits (USDC)\n2026-01,100\n2026-02,250\n");
  });

  it("includes the time-range qualifier in the file name when given", () => {
    renderControls({
      fileBase: "roi-projection",
      timeRange: "1y",
      chartTitle: "Portfolio ROI Projection (1y)",
    });

    fireEvent.click(screen.getByRole("button", { name: /export .* as csv/i }));

    expect(downloaded[0].filename).toMatch(/^roi-projection-1y-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it("reflects a changed data set (e.g. new filter) in the next export", () => {
    const { rerender } = renderControls();
    // Simulate the chart re-rendering with different on-screen rows.
    const filtered: ChartExportData = {
      columns: ["Month", "Deposits (USDC)"],
      rows: [["2026-02", 250]],
    };
    rerender(
      <ChartExportControls
        chartTitle="Volume Trends (USDC)"
        fileBase="volume-trends"
        data={filtered}
        legend={[{ label: "Deposits", color: "#6366f1" }]}
        getChartContainer={() => null}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /export .* as csv/i }));
    expect(downloaded[0].content).toBe("Month,Deposits (USDC)\n2026-02,250\n");
  });

  it("announces a successful CSV export via a live region", async () => {
    renderControls();
    fireEvent.click(screen.getByRole("button", { name: /export .* as csv/i }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/exported as volume-trends-/i)
    );
  });

  it("disables exports while loading or when the chart has no data", () => {
    const { rerender } = renderControls({ disabled: true });
    expect(screen.getByRole("button", { name: /export .* as csv/i })).toBeDisabled();

    rerender(
      <ChartExportControls
        chartTitle="Volume Trends (USDC)"
        fileBase="volume-trends"
        data={{ columns: ["Month"], rows: [] }}
        legend={[]}
        getChartContainer={() => null}
      />
    );
    expect(screen.getByRole("button", { name: /export .* as csv/i })).toBeDisabled();
  });

  it("announces a PNG export failure without throwing", async () => {
    renderControls();
    fireEvent.click(screen.getByRole("button", { name: /export .* as png/i }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/export failed/i));
    expect(downloadTextFile).not.toHaveBeenCalled();
  });
});
