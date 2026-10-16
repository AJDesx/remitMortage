"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useCallback, useState } from "react";
import { Download, ImageDown } from "lucide-react";
import {
  buildCsv,
  chartExportFilename,
  downloadTextFile,
  exportChartPng,
  type ChartExportData,
  type ChartSeries,
} from "@/lib/chart-export";

interface ChartExportControlsProps {
  /** Chart title; baked into the PNG and used in announcements. */
  chartTitle: string;
  /** Base for the file name, e.g. "volume-trends". */
  fileBase: string;
  /** The exact rows/columns currently displayed in the chart. */
  data: ChartExportData;
  /** Legend entries rendered into the PNG export. */
  legend: ChartSeries[];
  /** Returns the DOM container wrapping the chart's <svg>. */
  getChartContainer: () => HTMLElement | null;
  /** Optional time-range qualifier appended to the file name (e.g. "1y"). */
  timeRange?: string;
  /** Disables the controls while the chart is loading. */
  disabled?: boolean;
}

/**
 * PNG/CSV export controls for a chart. CSV always reflects the data the
 * chart is currently drawing (including active time ranges), PNG includes
 * the chart title and legend. Completion is announced via a live region.
 */
export default function ChartExportControls({
  chartTitle,
  fileBase,
  data,
  legend,
  getChartContainer,
  timeRange,
  disabled = false,
}: ChartExportControlsProps) {
  const [announcement, setAnnouncement] = useState("");
  const [exporting, setExporting] = useState(false);

  const hasData = data.rows.length > 0;
  const inert = disabled || exporting || !hasData;

  const handleCsv = useCallback(() => {
    const filename = chartExportFilename(fileBase, "csv", { timeRange });
    downloadTextFile(filename, buildCsv(data));
    setAnnouncement(`${chartTitle} data exported as ${filename}.`);
  }, [chartTitle, data, fileBase, timeRange]);

  const handlePng = useCallback(async () => {
    const container = getChartContainer();
    const filename = chartExportFilename(fileBase, "png", { timeRange });
    setExporting(true);
    try {
      await exportChartPng({ container, title: chartTitle, legend, filename });
      setAnnouncement(`${chartTitle} exported as ${filename}.`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown error.";
      setAnnouncement(`Export failed for ${chartTitle}. ${reason}`);
    } finally {
      setExporting(false);
    }
  }, [chartTitle, fileBase, getChartContainer, legend, timeRange]);

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={handleCsv}
        disabled={inert}
        aria-label={`Export ${chartTitle} data as CSV`}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800/70 text-slate-300 border border-slate-700 hover:border-cyan-500/50 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
      >
        <Download className="w-3.5 h-3.5" aria-hidden="true" />
        CSV
      </button>
      <button
        type="button"
        onClick={handlePng}
        disabled={inert}
        aria-label={`Export ${chartTitle} as PNG image with title and legend`}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800/70 text-slate-300 border border-slate-700 hover:border-cyan-500/50 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
      >
        <ImageDown className="w-3.5 h-3.5" aria-hidden="true" />
        {exporting ? "Exporting…" : "PNG"}
      </button>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
