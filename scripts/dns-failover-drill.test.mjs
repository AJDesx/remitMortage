// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT
//
// Unit tests for the DNS failover drill evaluator (issue #876). Run with:
//   node --test scripts/dns-failover-drill.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RTO_SECONDS,
  evaluateFailover,
  formatReport,
  parseArgs,
  simulateFailoverDrill,
} from "./dns-failover-drill.mjs";

test("a simulated primary failure shifts traffic within the RTO and fails back", () => {
  const { result, observations } = simulateFailoverDrill({
    sampleIntervalSeconds: 5,
    dnsFailoverDelaySeconds: 30,
    faultClearedAtSeconds: 150,
    dnsFailbackDelaySeconds: 20,
    rtoTargetSeconds: 120,
    failbackTargetSeconds: 120,
  });

  assert.equal(result.passed, true);
  assert.equal(result.failoverOk, true);
  assert.equal(result.failbackOk, true);
  assert.ok(result.failoverSeconds <= 120);
  assert.ok(result.failbackSeconds > result.failoverSeconds);
  // The timeline must actually visit both endpoints.
  assert.ok(observations.some((o) => o.resolvesTo === "secondary"));
  assert.ok(observations.some((o) => o.resolvesTo === "primary" && o.t > result.failoverSeconds));
});

test("failover slower than the RTO target fails the drill", () => {
  const result = evaluateFailover(
    [
      { t: 0, resolvesTo: "primary" },
      { t: 60, resolvesTo: "primary" },
      { t: 150, resolvesTo: "secondary" },
      { t: 180, resolvesTo: "primary" },
    ],
    { rtoTargetSeconds: 120, failbackTargetSeconds: 120, primaryRestoredAtSeconds: 170 }
  );

  assert.equal(result.passed, false);
  assert.equal(result.failoverOk, false);
  assert.equal(result.failoverSeconds, 150);
  assert.match(result.reasons.join(" "), /exceed/i);
});

test("failback is documented and measured", () => {
  const result = evaluateFailover(
    [
      { t: 0, resolvesTo: "primary" },
      { t: 30, resolvesTo: "secondary" },
      { t: 60, resolvesTo: "secondary" },
      { t: 75, resolvesTo: "primary" },
    ],
    { rtoTargetSeconds: 120, failbackTargetSeconds: 30, primaryRestoredAtSeconds: 60 }
  );

  assert.equal(result.failoverSeconds, 30);
  assert.equal(result.failbackSeconds, 75);
  assert.equal(result.failbackOk, true);
  assert.equal(result.passed, true);
});

test("a missing failback fails the drill", () => {
  const result = evaluateFailover(
    [
      { t: 0, resolvesTo: "primary" },
      { t: 30, resolvesTo: "secondary" },
      { t: 90, resolvesTo: "secondary" },
    ],
    { rtoTargetSeconds: 120, failbackTargetSeconds: 60, primaryRestoredAtSeconds: 60 }
  );

  assert.equal(result.passed, false);
  assert.equal(result.failbackOk, false);
  assert.match(result.reasons.join(" "), /failed back/i);
});

test("failback slower than its target fails the drill", () => {
  const result = evaluateFailover(
    [
      { t: 0, resolvesTo: "primary" },
      { t: 30, resolvesTo: "secondary" },
      { t: 200, resolvesTo: "primary" },
    ],
    { rtoTargetSeconds: 120, failbackTargetSeconds: 60, primaryRestoredAtSeconds: 100 }
  );

  assert.equal(result.failoverOk, true);
  assert.equal(result.failbackOk, false);
  assert.equal(result.passed, false);
});

test("traffic that never fails over fails the drill", () => {
  const result = evaluateFailover(
    [
      { t: 0, resolvesTo: "primary" },
      { t: 30, resolvesTo: "primary" },
      { t: 60, resolvesTo: "primary" },
    ],
    { rtoTargetSeconds: 120 }
  );

  assert.equal(result.passed, false);
  assert.equal(result.failoverSeconds, null);
  assert.match(result.reasons.join(" "), /never failed over/i);
});

test("empty observations are rejected rather than passing", () => {
  const result = evaluateFailover([], { rtoTargetSeconds: 120 });
  assert.equal(result.passed, false);
  assert.equal(result.failoverSeconds, null);
});

test("report surfaces the targets and measured times", () => {
  const result = evaluateFailover(
    [
      { t: 0, resolvesTo: "primary" },
      { t: 30, resolvesTo: "secondary" },
      { t: 60, resolvesTo: "primary" },
    ],
    { rtoTargetSeconds: 120, failbackTargetSeconds: 60, primaryRestoredAtSeconds: 45 }
  );
  const report = formatReport(result, { mode: "simulate" });
  assert.match(report, /RTO target\s+: 120s/);
  assert.match(report, /Failover measured\s+: 30s/);
  assert.match(report, /Result\s+: PASS/);
});

test("the default simulation meets the default RTO target", () => {
  const { result } = simulateFailoverDrill();
  assert.equal(result.rtoTargetSeconds, DEFAULT_RTO_SECONDS);
  assert.equal(result.passed, true);
});

test("parseArgs selects live mode when a host is provided", () => {
  const options = parseArgs([
    "--host",
    "api.staging.example.com",
    "--control-url",
    "https://control.example.com",
    "--primary-ip",
    "1.2.3.4",
    "--secondary-ip",
    "5.6.7.8",
    "--environment",
    "staging",
    "--rto",
    "90",
  ]);
  assert.equal(options.mode, "live");
  assert.equal(options.host, "api.staging.example.com");
  assert.equal(options.rtoTargetSeconds, 90);
});

test("parseArgs defaults to simulation", () => {
  const options = parseArgs([]);
  assert.equal(options.mode, "simulate");
});
