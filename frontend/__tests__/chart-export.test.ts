// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  buildCsv,
  chartExportFilename,
  escapeCsvValue,
  exportChartPng,
} from "../src/lib/chart-export";

describe("escapeCsvValue", () => {
  it("passes plain values through", () => {
    expect(escapeCsvValue("deposits")).toBe("deposits");
    expect(escapeCsvValue(1500)).toBe("1500");
  });

  it("quotes values containing commas, quotes, or newlines", () => {
    expect(escapeCsvValue("a,b")).toBe('"a,b"');
    expect(escapeCsvValue('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvValue("line1\nline2")).toBe('"line1\nline2"');
  });
});

describe("buildCsv", () => {
  it("emits a header row followed by the data rows", () => {
    const csv = buildCsv({
      columns: ["Month", "Deposits (USDC)"],
      rows: [
        ["2026-01", 1200],
        ["2026-02", 900],
      ],
    });
    expect(csv).toBe("Month,Deposits (USDC)\n2026-01,1200\n2026-02,900\n");
  });

  it("matches exactly the rows the chart displays", () => {
    // Simulate the volume chart's on-screen data after a filter.
    const displayed = [
      { month: "2026-03", deposits: 500, repayments: 200, disbursements: 100 },
      { month: "2026-04", deposits: 700, repayments: 300, disbursements: 150 },
    ];
    const csv = buildCsv({
      columns: ["Month", "Deposits (USDC)", "Repayments (USDC)", "Disbursements (USDC)"],
      rows: displayed.map((d) => [d.month, d.deposits, d.repayments, d.disbursements]),
    });

    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(displayed.length + 1);
    displayed.forEach((point, index) => {
      expect(lines[index + 1]).toBe(
        `${point.month},${point.deposits},${point.repayments},${point.disbursements}`
      );
    });
  });

  it("handles empty data sets", () => {
    expect(buildCsv({ columns: ["A"], rows: [] })).toBe("A\n");
  });
});

describe("chartExportFilename", () => {
  const now = new Date("2026-10-16T12:00:00");

  it("produces predictable names from base, date and extension", () => {
    expect(chartExportFilename("volume-trends", "csv", { now })).toBe(
      "volume-trends-2026-10-16.csv"
    );
    expect(chartExportFilename("loan-performance", "png", { now })).toBe(
      "loan-performance-2026-10-16.png"
    );
  });

  it("appends a lower-cased time range qualifier", () => {
    expect(chartExportFilename("roi-projection", "csv", { timeRange: "1Y", now })).toBe(
      "roi-projection-1y-2026-10-16.csv"
    );
    expect(chartExportFilename("roi-projection", "png", { timeRange: "Max", now })).toBe(
      "roi-projection-max-2026-10-16.png"
    );
  });

  it("pads single-digit months and days", () => {
    expect(chartExportFilename("volume-trends", "csv", { now: new Date("2026-01-05T00:00:00") })).toBe(
      "volume-trends-2026-01-05.csv"
    );
  });
});

describe("exportChartPng", () => {
  it("rejects when the container has no chart SVG", async () => {
    const container = document.createElement("div");
    await expect(
      exportChartPng({ container, title: "T", legend: [], filename: "t.png" })
    ).rejects.toThrow(/no chart svg/i);
  });

  it("rejects for a null container", async () => {
    await expect(
      exportChartPng({ container: null, title: "T", legend: [], filename: "t.png" })
    ).rejects.toThrow(/no chart svg/i);
  });
});
