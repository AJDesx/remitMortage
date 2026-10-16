// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

// Dry-run for the SLO burn-rate alerts: replays synthetic failure data through
// the tier definitions in devops/slo/slos.json (the same spec the Prometheus
// rules are generated from) and checks fast burns page, slow burns ticket, and
// harmless blips stay quiet. Run: node --test scripts/slo-burn-rate.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  DASHBOARD_PATH,
  RULES_PATH,
  budgetConsumed,
  burnThreshold,
  durationMinutes,
  errorBudget,
  generateRules,
  loadSpec,
  renderDashboard,
  replay,
} from "./slo-lib.mjs";

const spec = loadSpec();
const availability = spec.slos.find((s) => s.id === "api-availability");
const MIN = 1;
const HOUR = 60;
const DAY = 1440;

const run = (slo, fn, minutes) => replay(spec, slo, fn, minutes);
const fired = (result) => Object.entries(result).filter(([, v]) => v).map(([k]) => k);

// ── spec sanity ──────────────────────────────────────────────────────────

test("every SLO has an explicit target, window and ratio expression", () => {
  assert.equal(spec.windowDays, 30);
  assert.deepEqual(
    spec.slos.map((s) => s.id),
    ["api-availability", "api-latency", "tx-submission-success"]
  );
  for (const slo of spec.slos) {
    assert.ok(slo.target > 0 && slo.target < 1, `${slo.id} target`);
    assert.match(slo.errorRatioExpr, /\{\{window\}\}/, `${slo.id} expr`);
  }
});

test("error budgets are 1 - target without float noise", () => {
  assert.equal(errorBudget(availability), 0.001);
  assert.equal(errorBudget(spec.slos.find((s) => s.id === "api-latency")), 0.05);
  assert.equal(errorBudget(spec.slos.find((s) => s.id === "tx-submission-success")), 0.005);
});

test("tiers follow the SRE workbook budget-consumption table", () => {
  const consumed = Object.fromEntries(
    spec.tiers.map((t) => [t.name, Number((budgetConsumed(spec, t) * 100).toFixed(1))])
  );
  assert.deepEqual(consumed, { fast: 2, medium: 5, slow: 10, gradual: 10 });
  assert.deepEqual(
    spec.tiers.map((t) => t.severity),
    ["page", "page", "ticket", "ticket"]
  );
  for (const t of spec.tiers) {
    assert.ok(durationMinutes(t.shortWindow) < durationMinutes(t.longWindow));
  }
});

// ── replay: pages ────────────────────────────────────────────────────────

test("a total outage pages within a few minutes", () => {
  const result = run(availability, () => 1, 2 * HOUR);
  assert.equal(result.fast.severity, "page");
  assert.ok(result.fast.minute <= 5, `fast burn paged at minute ${result.fast.minute}`);
});

test("a sustained 20x burn pages once the 1h window crosses 14.4x", () => {
  const rate = 20 * errorBudget(availability); // 2% errors
  const result = run(availability, () => rate, 3 * HOUR);
  // 1h mean reaches 1.44% after 1.44/2 * 60 = 43.2 minutes, plus the 2m `for`.
  assert.equal(result.fast.severity, "page");
  assert.ok(result.fast.minute >= 43 && result.fast.minute <= 47, `got ${result.fast.minute}`);
});

test("a 7x burn skips the fast page but pages on the 6h tier", () => {
  const rate = 7 * errorBudget(availability);
  const result = run(availability, () => rate, 12 * HOUR);
  assert.equal(result.fast, null);
  assert.equal(result.medium.severity, "page");
  // 6h mean reaches 6x after 6/7 of 6h ≈ 308 minutes.
  assert.ok(result.medium.minute >= 305 && result.medium.minute <= 315, `got ${result.medium.minute}`);
});

// ── replay: tickets ──────────────────────────────────────────────────────

test("a 4x slow burn opens a ticket and never pages", () => {
  const rate = 4 * errorBudget(availability);
  const result = run(availability, () => rate, 2 * DAY);
  assert.equal(result.fast, null);
  assert.equal(result.medium, null);
  assert.equal(result.slow.severity, "ticket");
  // 1d mean reaches 3x after 3/4 of a day = 18h.
  assert.ok(result.slow.minute >= 18 * HOUR && result.slow.minute <= 18 * HOUR + 30, `got ${result.slow.minute}`);
});

test("a 2x creeping burn only trips the lowest-severity 3-day ticket", () => {
  const rate = 2 * errorBudget(availability);
  const result = run(availability, () => rate, 4 * DAY);
  assert.deepEqual(fired(result), ["gradual"]);
  assert.equal(result.gradual.severity, "ticket");
  // 3d mean reaches 1x after 1/2 of 3d = 36h.
  assert.ok(result.gradual.minute >= 36 * HOUR && result.gradual.minute <= 36 * HOUR + 30, `got ${result.gradual.minute}`);
});

// ── replay: quiet cases ──────────────────────────────────────────────────

test("a burn at half the budget rate never alerts", () => {
  const rate = 0.5 * errorBudget(availability);
  assert.deepEqual(fired(run(availability, () => rate, 4 * DAY)), []);
});

test("a harmless one-minute blip never alerts", () => {
  const blip = (t) => (t >= 100 && t < 100 + MIN ? 0.3 : 0);
  assert.deepEqual(fired(run(availability, blip, DAY)), []);
});

test("a burn that stops resolves before the slow tiers can trip", () => {
  // 20x for 20 minutes then clean: 1h mean never exceeds 14.4x.
  const rate = 20 * errorBudget(availability);
  const result = run(availability, (t) => (t < 20 ? rate : 0), 2 * DAY);
  assert.deepEqual(fired(result), []);
});

test("thresholds scale with each SLO's own error budget", () => {
  for (const slo of spec.slos) {
    const outage = run(slo, () => 1, 2 * HOUR);
    assert.equal(outage.fast.severity, "page", `${slo.id} pages on total outage`);

    const justBelow = 0.9 * burnThreshold(slo, spec.tiers[3]);
    assert.deepEqual(fired(run(slo, () => justBelow, 4 * DAY)), [], `${slo.id} quiet below 1x`);
  }
});

// ── generated artifacts ──────────────────────────────────────────────────

test("committed Prometheus rules match the generator output", () => {
  assert.equal(fs.readFileSync(RULES_PATH, "utf8"), generateRules(spec));
});

test("committed Grafana dashboard matches the generator output", () => {
  assert.equal(fs.readFileSync(DASHBOARD_PATH, "utf8"), renderDashboard(spec));
});

test("rules define a paging and a ticketing alert for every SLO", () => {
  const rules = fs.readFileSync(RULES_PATH, "utf8");
  for (const slo of spec.slos) {
    for (const tier of spec.tiers) {
      const expected = `slo:sli_error:ratio_rate${tier.longWindow}{slo="${slo.id}"} > (${tier.burnRate} * ${errorBudget(slo)})`;
      assert.ok(rules.includes(expected), `${slo.id}/${tier.name} threshold missing`);
    }
    assert.ok(rules.includes(`record: slo:error_budget_remaining:ratio`));
  }
  assert.match(rules, /severity: page/);
  assert.match(rules, /severity: ticket/);
});

test("dashboard shows remaining error budget for each SLO", () => {
  const dashboard = JSON.parse(fs.readFileSync(DASHBOARD_PATH, "utf8"));
  const gauges = dashboard.panels.filter((p) => p.type === "gauge");
  assert.equal(gauges.length, spec.slos.length);
  for (const slo of spec.slos) {
    assert.ok(
      gauges.some((g) => g.targets[0].expr === `slo:error_budget_remaining:ratio{slo="${slo.id}"}`),
      `${slo.id} gauge`
    );
  }
});
