// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

// Shared SLO helpers: load the SLO spec, generate the Prometheus rules and the
// Grafana dashboard from it, and replay synthetic error ratios through the
// same multi-window burn-rate logic the generated alerts encode.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "..");
export const SLO_SPEC_PATH = path.join(REPO_ROOT, "devops/slo/slos.json");
export const RULES_PATH = path.join(REPO_ROOT, "devops/prometheus/slo-burn-rate-alerts.yml");
export const DASHBOARD_PATH = path.join(REPO_ROOT, "devops/grafana/slo-error-budget-dashboard.json");

const RUNBOOK_URL =
  "https://github.com/AstronLabs/remitMortage/blob/main/docs/SLO_ERROR_BUDGET_POLICY.md";

export function loadSpec(specPath = SLO_SPEC_PATH) {
  return JSON.parse(fs.readFileSync(specPath, "utf8"));
}

/** "5m" | "2h" | "3d" → minutes. */
export function durationMinutes(text) {
  const match = /^(\d+)([mhd])$/.exec(text);
  if (!match) throw new Error(`Unsupported duration: ${text}`);
  const value = Number(match[1]);
  return value * { m: 1, h: 60, d: 1440 }[match[2]];
}

const clean = (n) => Number(n.toPrecision(10));

/** Allowed error ratio: 1 - target (e.g. 99.9% → 0.001). */
export function errorBudget(slo) {
  return clean(1 - slo.target);
}

/** Error ratio above which a tier's windows count as burning too fast. */
export function burnThreshold(slo, tier) {
  return clean(tier.burnRate * errorBudget(slo));
}

/** Share of the whole-period budget a tier consumes over its long window. */
export function budgetConsumed(spec, tier) {
  return (tier.burnRate * durationMinutes(tier.longWindow)) / (spec.windowDays * 1440);
}

export function windowsUsed(spec) {
  const set = new Set([`${spec.windowDays}d`]);
  spec.tiers.forEach((t) => {
    set.add(t.longWindow);
    set.add(t.shortWindow);
  });
  return [...set].sort((a, b) => durationMinutes(a) - durationMinutes(b));
}

const indent = (text, spaces) =>
  text
    .split("\n")
    .map((line) => (line ? " ".repeat(spaces) + line : line))
    .join("\n");

export function generateRules(spec) {
  const out = [];
  out.push(`# GENERATED FILE — do not edit by hand.
# Source: devops/slo/slos.json   Generator: scripts/generate-slo-artifacts.mjs
#
# Multi-window, multi-burn-rate SLO alerts (Google SRE Workbook, ch. 5).
# A tier fires only when BOTH its long and short windows burn error budget
# faster than the tier's burn rate, so brief blips do not page and recoveries
# resolve quickly. Fast burns ("page") go to PagerDuty; slow burns ("ticket")
# open a lower-severity ticket. Policy: docs/SLO_ERROR_BUDGET_POLICY.md.
#
#   # prometheus.yml
#   rule_files:
#     - /etc/prometheus/rules/slo-burn-rate-alerts.yml

groups:`);

  out.push(`  - name: remitmortgage-slo-recording
    interval: 30s
    rules:`);
  for (const slo of spec.slos) {
    for (const window of windowsUsed(spec)) {
      const expr = slo.errorRatioExpr.replaceAll("{{window}}", window);
      out.push(`      - record: slo:sli_error:ratio_rate${window}
        expr: |
${indent(expr, 10)}
        labels:
          slo: ${slo.id}`);
    }
    out.push(`      - record: slo:error_budget_remaining:ratio
        expr: |
          1 - (slo:sli_error:ratio_rate${spec.windowDays}d{slo="${slo.id}"} / ${errorBudget(slo)})
        labels:
          slo: ${slo.id}`);
  }

  out.push(`
  - name: remitmortgage-slo-burn-rate
    interval: 30s
    rules:`);
  for (const slo of spec.slos) {
    for (const tier of spec.tiers) {
      const budget = errorBudget(slo);
      const consumed = (budgetConsumed(spec, tier) * 100).toFixed(1);
      const alertName = `SLOBurn${tier.name[0].toUpperCase()}${tier.name.slice(1)}_${slo.id
        .split("-")
        .map((p) => p[0].toUpperCase() + p.slice(1))
        .join("")}`;
      out.push(`      - alert: ${alertName}
        expr: |
          slo:sli_error:ratio_rate${tier.longWindow}{slo="${slo.id}"} > (${tier.burnRate} * ${budget})
          and
          slo:sli_error:ratio_rate${tier.shortWindow}{slo="${slo.id}"} > (${tier.burnRate} * ${budget})
        for: ${tier.for}
        labels:
          severity: ${tier.severity}
          team: ops
          component: ${slo.component}
          slo: ${slo.id}
          burn_tier: ${tier.name}
        annotations:
          summary: >-
            ${slo.title} SLO is burning error budget at ${tier.burnRate}x over ${tier.longWindow} and ${tier.shortWindow}.
          description: >-
            At this rate ${consumed}% of the ${spec.windowDays}-day error budget
            (target ${(slo.target * 100).toFixed(2).replace(/\.?0+$/, "")}%) is consumed within ${tier.longWindow}. SLI: ${slo.journey}
          runbook_url: ${RUNBOOK_URL}`);
    }
  }
  return out.join("\n") + "\n";
}

export function generateDashboard(spec) {
  const ds = { type: "prometheus", uid: "${DS_PROMETHEUS}" };
  const panels = [];
  let id = 1;
  const w = Math.floor(24 / spec.slos.length);

  spec.slos.forEach((slo, i) => {
    panels.push({
      id: id++,
      type: "gauge",
      title: `${slo.title} — error budget remaining (${spec.windowDays}d)`,
      description: `${slo.journey} Target ${(slo.target * 100).toFixed(2)}%.`,
      datasource: ds,
      gridPos: { h: 8, w, x: i * w, y: 0 },
      targets: [
        {
          refId: "A",
          expr: `slo:error_budget_remaining:ratio{slo="${slo.id}"}`,
          instant: true,
        },
      ],
      fieldConfig: {
        defaults: {
          unit: "percentunit",
          min: 0,
          max: 1,
          thresholds: {
            mode: "absolute",
            steps: [
              { color: "red", value: null },
              { color: "orange", value: 0.25 },
              { color: "green", value: 0.5 },
            ],
          },
        },
        overrides: [],
      },
      options: { showThresholdLabels: false, showThresholdMarkers: true },
    });
  });

  panels.push({
    id: id++,
    type: "timeseries",
    title: "Error budget remaining over time",
    datasource: ds,
    gridPos: { h: 9, w: 12, x: 0, y: 8 },
    targets: spec.slos.map((slo, i) => ({
      refId: String.fromCharCode(65 + i),
      expr: `slo:error_budget_remaining:ratio{slo="${slo.id}"}`,
      legendFormat: slo.title,
    })),
    fieldConfig: { defaults: { unit: "percentunit", min: 0, max: 1 }, overrides: [] },
  });

  const fast = spec.tiers[0];
  panels.push({
    id: id++,
    type: "timeseries",
    title: `Burn rate (1h) — page at ${fast.burnRate}x`,
    description:
      "1.0 means the error budget would be exactly used up at the end of the SLO window.",
    datasource: ds,
    gridPos: { h: 9, w: 12, x: 12, y: 8 },
    targets: spec.slos.map((slo, i) => ({
      refId: String.fromCharCode(65 + i),
      expr: `slo:sli_error:ratio_rate1h{slo="${slo.id}"} / ${errorBudget(slo)}`,
      legendFormat: slo.title,
    })),
    fieldConfig: {
      defaults: {
        unit: "none",
        min: 0,
        thresholds: {
          mode: "absolute",
          steps: [
            { color: "green", value: null },
            { color: "orange", value: spec.tiers.find((t) => t.severity === "ticket").burnRate },
            { color: "red", value: fast.burnRate },
          ],
        },
        custom: { thresholdsStyle: { mode: "line" } },
      },
      overrides: [],
    },
  });

  return {
    title: "SLO Error Budgets",
    uid: "remitmortgage-slo-error-budgets",
    tags: ["slo", "reliability", "generated"],
    timezone: "utc",
    schemaVersion: 39,
    version: 1,
    refresh: "1m",
    time: { from: "now-7d", to: "now" },
    templating: {
      list: [
        {
          name: "DS_PROMETHEUS",
          label: "Prometheus",
          type: "datasource",
          query: "prometheus",
        },
      ],
    },
    panels,
  };
}

export function renderDashboard(spec) {
  return JSON.stringify(generateDashboard(spec), null, 2) + "\n";
}

/**
 * Replay a synthetic per-minute error-ratio series through the burn-rate
 * tiers of one SLO, assuming constant traffic (so window ratio = mean of the
 * per-minute ratios; history before minute 0 is error-free).
 *
 * Returns, for each tier, the first minute its alert would fire (condition
 * true on both windows continuously for the tier's `for` duration), or null.
 */
export function replay(spec, slo, errorRatioAt, durationMinutesTotal) {
  const prefix = new Float64Array(durationMinutesTotal + 1);
  for (let t = 0; t < durationMinutesTotal; t++) {
    prefix[t + 1] = prefix[t] + errorRatioAt(t);
  }
  const windowMean = (end, windowMin) => {
    const start = Math.max(0, end - windowMin);
    return (prefix[end] - prefix[start]) / windowMin;
  };

  const results = {};
  for (const tier of spec.tiers) {
    const threshold = burnThreshold(slo, tier);
    const longMin = durationMinutes(tier.longWindow);
    const shortMin = durationMinutes(tier.shortWindow);
    const forMin = durationMinutes(tier.for);
    let activeSince = null;
    let firedAt = null;

    for (let t = 1; t <= durationMinutesTotal; t++) {
      const burning =
        windowMean(t, longMin) > threshold && windowMean(t, shortMin) > threshold;
      if (burning) {
        if (activeSince === null) activeSince = t;
        if (t - activeSince >= forMin) {
          firedAt = t;
          break;
        }
      } else {
        activeSince = null;
      }
    }
    results[tier.name] = firedAt === null ? null : { minute: firedAt, severity: tier.severity };
  }
  return results;
}
