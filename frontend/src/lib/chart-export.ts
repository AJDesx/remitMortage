// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Chart export helpers (PNG + CSV).
 *
 * CSV exports are built from the exact rows the chart is currently drawing,
 * so an export always matches what is on screen (including any active time
 * range or filters). PNG exports serialize the chart's own `<svg>` and
 * redraw it on a canvas with the chart title and a legend added.
 */

export interface ChartSeries {
  label: string;
  color: string;
}

export interface ChartExportData {
  columns: string[];
  rows: (string | number)[][];
}

/** Escape a single CSV field per RFC 4180. */
export function escapeCsvValue(value: string | number): string {
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Build a CSV document (header row + data rows) from chart data. */
export function buildCsv(data: ChartExportData): string {
  const lines = [data.columns.map(escapeCsvValue).join(",")];
  for (const row of data.rows) {
    lines.push(row.map(escapeCsvValue).join(","));
  }
  // Trailing newline so the file ends cleanly in spreadsheets.
  return `${lines.join("\n")}\n`;
}

/**
 * Predictable export file names: `<base>-<YYYY-MM-DD>.<ext>`, e.g.
 * `volume-trends-2026-10-16.csv`. When a time-range qualifier is given it is
 * appended before the date, e.g. `roi-projection-1y-2026-10-16.png`.
 */
export function chartExportFilename(
  baseName: string,
  extension: "csv" | "png",
  options: { timeRange?: string; now?: Date } = {}
): string {
  const now = options.now ?? new Date();
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  const range = options.timeRange ? `-${options.timeRange.toLowerCase()}` : "";
  return `${baseName}${range}-${date}.${extension}`;
}

/** Trigger a browser download for a text payload (CSV). */
export function downloadTextFile(filename: string, content: string, mime = "text/csv"): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  downloadBlobFile(filename, blob);
}

/** Trigger a browser download for a binary payload (PNG). */
export function downloadBlobFile(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export interface ChartPngExportOptions {
  /** Container element that wraps the recharts `<svg>`. */
  container: HTMLElement | null;
  /** Title rendered above the chart inside the exported image. */
  title: string;
  /** Legend entries rendered under the chart inside the exported image. */
  legend: ChartSeries[];
  /** Fully-resolved file name, e.g. from {@link chartExportFilename}. */
  filename: string;
  /** Canvas background; matches the dark card background by default. */
  background?: string;
}

const PADDING = 24;
const TITLE_HEIGHT = 38;
const LEGEND_HEIGHT = 30;
const MIN_CHART_WIDTH = 320;
const MIN_CHART_HEIGHT = 200;

/**
 * Export a chart as a PNG image. The chart's own SVG is serialized and
 * redrawn on a canvas with the title and legend baked in, then downloaded.
 * Rejects when no chart SVG is found in the container.
 */
export async function exportChartPng(options: ChartPngExportOptions): Promise<void> {
  const { container, title, legend, filename } = options;
  const background = options.background ?? "#0b122d";

  const svg = container?.querySelector("svg.recharts-surface") ?? container?.querySelector("svg");
  if (!svg) {
    throw new Error("No chart SVG found to export.");
  }

  const rect = svg.getBoundingClientRect();
  const chartWidth = Math.max(
    rect.width || Number(svg.getAttribute("width")) || MIN_CHART_WIDTH,
    MIN_CHART_WIDTH
  );
  const chartHeight = Math.max(
    rect.height || Number(svg.getAttribute("height")) || MIN_CHART_HEIGHT,
    MIN_CHART_HEIGHT
  );

  // Clone the SVG with explicit dimensions so it rasterizes at chart size.
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(chartWidth));
  clone.setAttribute("height", String(chartHeight));
  if (!clone.getAttribute("font-family")) {
    clone.setAttribute("font-family", "sans-serif");
  }
  // Recharts axis text often relies on CSS classes; give unstyled text a
  // legible color for the dark export background.
  for (const text of Array.from(clone.querySelectorAll("text"))) {
    if (!text.getAttribute("fill") && !text.getAttribute("style")?.includes("fill")) {
      text.setAttribute("fill", "#94a3b8");
    }
  }

  const serialized = new XMLSerializer().serializeToString(clone);
  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`;

  const image = await loadImage(svgUrl);

  const width = chartWidth + PADDING * 2;
  const height = PADDING * 2 + TITLE_HEIGHT + chartHeight + (legend.length > 0 ? LEGEND_HEIGHT : 0);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas 2D is not available in this browser.");
  }

  // Background + title.
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#f1f5f9";
  context.font = "600 16px sans-serif";
  context.textBaseline = "top";
  context.fillText(title, PADDING, PADDING);

  // The chart itself.
  context.drawImage(image, PADDING, PADDING + TITLE_HEIGHT, chartWidth, chartHeight);

  // Legend under the chart.
  if (legend.length > 0) {
    let x = PADDING;
    const y = PADDING + TITLE_HEIGHT + chartHeight + 8;
    context.font = "12px sans-serif";
    context.textBaseline = "middle";
    for (const entry of legend) {
      context.fillStyle = entry.color;
      context.fillRect(x, y - 5, 12, 12);
      context.fillStyle = "#cbd5e1";
      context.fillText(entry.label, x + 18, y + 1);
      x += 18 + context.measureText(entry.label).width + 20;
    }
  }

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error("Could not encode chart image."));
    }, "image/png");
  });

  downloadBlobFile(filename, blob);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load chart image data."));
    image.src = src;
  });
}
