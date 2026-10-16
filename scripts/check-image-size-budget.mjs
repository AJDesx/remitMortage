#!/usr/bin/env node
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT
//
// check-image-size-budget.mjs
//
// Compares the size of freshly-built Docker images against a configured
// per-image budget (scripts/image-size-budgets.json), and — when a baseline
// from a previous build is supplied — reports the size delta so a PR's
// image-size impact is visible in review.
//
// This script does not build or inspect images itself (no docker calls) —
// the workflow builds the images with `docker build` and measures each one's
// size with `docker image inspect --format='{{.Size}}'`, then passes the
// results in as a small JSON file. Keeping the docker calls out of this
// script keeps it pure and unit-testable.
//
// Usage:
//   node scripts/check-image-size-budget.mjs <current-sizes.json> [baseline-sizes.json] [report.md]
//
//   current-sizes.json  — required. { "<imageKey>": <sizeBytes>, ... }
//   baseline-sizes.json — optional. Same shape, from the previous build
//                         (e.g. the last successful build on the base branch).
//                         Only used to compute a delta for the report; its
//                         absence never affects pass/fail.
//   report.md           — optional. Path to also write the markdown report to
//                         (in addition to stdout), so a workflow can append it
//                         to $GITHUB_STEP_SUMMARY.
//
// Budget config (scripts/image-size-budgets.json):
//   { "<imageKey>": { "maxBytes": <number>, "graceUntil": "YYYY-MM-DD" | null } }
//
//   maxBytes   — the budget. A build at or under this size passes.
//   graceUntil — while set to a future UTC date, an over-budget image WARNS
//                instead of failing CI, giving time to either shrink the
//                image or deliberately raise the budget (see
//                docs/CONTAINER_IMAGE_SIZE_BUDGET.md). Once that date has
//                passed (or the field is null), going over budget fails CI.
//
// Exit codes
//   0 — every image is within budget (or within an active grace period)
//   1 — one or more images are over budget outside any grace period, or the
//       inputs could not be read

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function formatBytes(bytes) {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MiB`;
}

function formatDelta(deltaBytes) {
  const sign = deltaBytes > 0 ? "+" : deltaBytes < 0 ? "−" : "±";
  return `${sign}${formatBytes(Math.abs(deltaBytes))}`;
}

// Pure evaluation: given budgets, current sizes, an optional baseline, and
// "today" (UTC yyyy-mm-dd, injectable for tests), returns a per-image result
// list plus whether any result is a hard failure.
export function evaluateBudgets({ budgets, current, baseline = {}, today }) {
  const results = [];

  for (const [key, sizeBytes] of Object.entries(current)) {
    const budget = budgets[key];
    if (!budget) {
      results.push({
        key,
        sizeBytes,
        status: "UNCONFIGURED",
        detail: `No budget entry for "${key}" in scripts/image-size-budgets.json`,
      });
      continue;
    }

    const overBudget = sizeBytes > budget.maxBytes;
    const inGracePeriod = Boolean(budget.graceUntil) && today <= budget.graceUntil;
    const baselineBytes = baseline[key];
    const deltaBytes = typeof baselineBytes === "number" ? sizeBytes - baselineBytes : null;

    let status;
    if (!overBudget) status = "PASS";
    else if (inGracePeriod) status = "WARN";
    else status = "FAIL";

    results.push({
      key,
      sizeBytes,
      maxBytes: budget.maxBytes,
      deltaBytes,
      status,
      graceUntil: budget.graceUntil ?? null,
    });
  }

  const hasFailure = results.some((r) => r.status === "FAIL" || r.status === "UNCONFIGURED");
  return { results, hasFailure };
}

export function renderReport(results) {
  const lines = [
    "## Container Image Size Budget",
    "",
    "| Image | Size | Budget | Delta vs. previous build | Status |",
    "|---|---|---|---|---|",
  ];

  for (const r of results) {
    if (r.status === "UNCONFIGURED") {
      lines.push(`| ${r.key} | ${formatBytes(r.sizeBytes)} | — | — | ⚠️ UNCONFIGURED |`);
      continue;
    }
    const delta = r.deltaBytes === null ? "n/a (no previous build found)" : formatDelta(r.deltaBytes);
    const icon = { PASS: "✅", WARN: "⚠️", FAIL: "❌" }[r.status];
    const budgetCell =
      r.status === "WARN"
        ? `${formatBytes(r.maxBytes)} (grace until ${r.graceUntil})`
        : formatBytes(r.maxBytes);
    lines.push(`| ${r.key} | ${formatBytes(r.sizeBytes)} | ${budgetCell} | ${delta} | ${icon} ${r.status} |`);
  }

  const failing = results.filter((r) => r.status === "FAIL");
  const unconfigured = results.filter((r) => r.status === "UNCONFIGURED");
  const warning = results.filter((r) => r.status === "WARN");

  lines.push("");
  if (failing.length > 0 || unconfigured.length > 0) {
    lines.push(
      "**Over budget.** See [`docs/CONTAINER_IMAGE_SIZE_BUDGET.md`](../blob/main/docs/CONTAINER_IMAGE_SIZE_BUDGET.md) " +
        "for how to shrink the image or raise the budget."
    );
  } else if (warning.length > 0) {
    lines.push(
      "**Over budget, but within the grace period** — this will start failing CI once the grace " +
        "period ends. See `docs/CONTAINER_IMAGE_SIZE_BUDGET.md`."
    );
  } else {
    lines.push("All images are within their configured budget.");
  }

  return lines.join("\n") + "\n";
}

function main() {
  const [currentPath, baselinePath, reportPath] = process.argv.slice(2);

  if (!currentPath) {
    console.error(
      "Usage: node scripts/check-image-size-budget.mjs <current-sizes.json> [baseline-sizes.json] [report.md]"
    );
    process.exit(1);
  }

  const repoRoot = process.cwd();
  const budgetsPath = path.join(repoRoot, "scripts", "image-size-budgets.json");

  let budgets;
  let current;
  let baseline = {};

  try {
    budgets = readJson(budgetsPath);
    current = readJson(currentPath);
    if (baselinePath && fs.existsSync(baselinePath)) {
      baseline = readJson(baselinePath);
    }
  } catch (err) {
    console.error(`✗ Failed to read inputs: ${err.message}`);
    process.exit(1);
  }

  const today = new Date().toISOString().slice(0, 10);
  const { results, hasFailure } = evaluateBudgets({ budgets, current, baseline, today });
  const report = renderReport(results);

  console.log(report);
  if (reportPath) fs.writeFileSync(reportPath, report);

  process.exit(hasFailure ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
