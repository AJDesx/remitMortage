// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT
//
// Unit tests for flaky-test detection and quarantine (issue #877).
// Run: node --test scripts/flaky-quarantine.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DASHBOARD_PATH,
  addQuarantine,
  appendRun,
  checkQuarantines,
  detectFlaky,
  isQuarantined,
  loadHistory,
  loadRegistry,
  matchesTest,
  normalizeJestReport,
  quarantineStatus,
  releaseQuarantine,
  renderDashboard,
} from "./flaky-lib.mjs";

const DAY = 24 * 60 * 60 * 1000;

function jestReport(rows) {
  return {
    testResults: [
      {
        name: "src/__tests__/sample.test.ts",
        assertionResults: rows.map((row) => ({
          fullName: row.name,
          title: row.name,
          status: row.status,
          duration: 5,
          retries: row.retries,
        })),
      },
    ],
  };
}

function run(runId, at, rows) {
  return normalizeJestReport(jestReport(rows), { runId, at });
}

// ── recording ─────────────────────────────────────────────────────────────

test("normalizeJestReport keeps passed/failed and drops pending", () => {
  const normalized = normalizeJestReport(
    jestReport([
      { name: "a passes", status: "passed" },
      { name: "b fails", status: "failed" },
      { name: "c skipped", status: "pending" },
      { name: "d retried", status: "passed", retries: 2 },
    ]),
    { runId: "r1", at: "2026-01-01T00:00:00Z" }
  );

  assert.equal(normalized.runId, "r1");
  assert.deepEqual(normalized.tests.map((t) => t.name), ["a passes", "b fails", "d retried"]);
  assert.equal(normalized.tests[2].retries, 2);
  assert.equal(normalized.tests[0].file, "src/__tests__/sample.test.ts");
});

test("appendRun replaces a duplicate run id and caps history", () => {
  let history = { runs: [] };
  history = appendRun(history, run("r1", "2026-01-01T00:00:00Z", [{ name: "a", status: "passed" }]));
  history = appendRun(history, run("r2", "2026-01-02T00:00:00Z", [{ name: "a", status: "failed" }]));
  history = appendRun(history, run("r1", "2026-01-03T00:00:00Z", [{ name: "a", status: "passed" }]));

  assert.deepEqual(history.runs.map((r) => r.runId).sort(), ["r1", "r2"]);
  assert.equal(history.runs.find((r) => r.runId === "r1").at, "2026-01-03T00:00:00Z");

  const capped = appendRun({ runs: history.runs }, run("r3", "2026-01-04T00:00:00Z", []), { maxRuns: 2 });
  assert.equal(capped.runs.length, 2);
  assert.equal(capped.runs[capped.runs.length - 1].runId, "r3");
});

// ── detection ─────────────────────────────────────────────────────────────

test("detectFlaky flags a test that both passes and fails", () => {
  const history = {
    runs: [
      run("r1", "2026-01-01T00:00:00Z", [{ name: "flakey", status: "passed" }]),
      run("r2", "2026-01-02T00:00:00Z", [{ name: "flakey", status: "failed" }]),
      run("r3", "2026-01-03T00:00:00Z", [{ name: "flakey", status: "passed" }]),
    ],
  };
  const flaky = detectFlaky(history);
  assert.equal(flaky.length, 1);
  assert.equal(flaky[0].name, "flakey");
  assert.equal(flaky[0].passed, 2);
  assert.equal(flaky[0].failed, 1);
  assert.match(flaky[0].reason, /passed 2\/3/);
});

test("detectFlaky flags a test that only passed on retry", () => {
  const history = {
    runs: [
      run("r1", "2026-01-01T00:00:00Z", [{ name: "retry only", status: "passed", retries: 1 }]),
      run("r2", "2026-01-02T00:00:00Z", [{ name: "retry only", status: "passed" }]),
    ],
  };
  const flaky = detectFlaky(history);
  assert.equal(flaky.length, 1);
  assert.equal(flaky[0].retriedPasses, 1);
  assert.match(flaky[0].reason, /retry/i);
});

test("detectFlaky ignores always-passing and always-failing tests", () => {
  const history = {
    runs: [
      run("r1", "2026-01-01T00:00:00Z", [{ name: "stable", status: "passed" }, { name: "broken", status: "failed" }]),
      run("r2", "2026-01-02T00:00:00Z", [{ name: "stable", status: "passed" }, { name: "broken", status: "failed" }]),
    ],
  };
  assert.deepEqual(detectFlaky(history), []);
});

test("detectFlaky respects minRuns for retry-only flakes", () => {
  const history = {
    runs: [run("r1", "2026-01-01T00:00:00Z", [{ name: "one-retry", status: "passed", retries: 1 }])],
  };
  assert.deepEqual(detectFlaky(history, { minRuns: 2 }), []);
  assert.equal(detectFlaky(history, { minRuns: 1 }).length, 1);
});

// ── quarantine decisions ──────────────────────────────────────────────────

test("matchesTest matches exact and fragment names case-insensitively", () => {
  assert.equal(matchesTest("describe > does x", "describe > does x"), true);
  assert.equal(matchesTest("describe > does x", "does x"), true);
  assert.equal(matchesTest("does x", "describe > does x"), true);
  assert.equal(matchesTest("a", "b"), false);
});

test("quarantineStatus distinguishes active, expiring and expired", () => {
  const entry = { test: "x", expiresAt: "2026-01-15" };
  assert.equal(quarantineStatus(entry, new Date("2026-01-01T00:00:00Z")), "active");
  assert.equal(quarantineStatus(entry, new Date("2026-01-12T00:00:00Z")), "expiring");
  assert.equal(quarantineStatus(entry, new Date("2026-01-16T00:00:00Z")), "expired");
});

test("checkQuarantines fails only when something has expired", () => {
  const registry = {
    quarantines: [
      { test: "fresh", expiresAt: "2026-02-01", trackingIssue: 1 },
      { test: "stale", expiresAt: "2026-01-10", trackingIssue: 2 },
    ],
  };
  const inTime = checkQuarantines(registry, new Date("2026-01-05T00:00:00Z"), { warnWithinDays: 7 });
  assert.equal(inTime.ok, true);
  assert.equal(inTime.expired.length, 0);
  assert.deepEqual(inTime.expiring.map((e) => e.test), ["stale"]);

  const late = checkQuarantines(registry, new Date("2026-01-20T00:00:00Z"));
  assert.equal(late.ok, false);
  assert.deepEqual(late.expired.map((e) => e.test), ["stale"]);
});

test("addQuarantine sets an expiry window and is idempotent", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const first = addQuarantine({ quarantines: [] }, { test: "flakey", trackingIssue: 7, days: 14, now });
  assert.equal(first.added, true);
  assert.equal(first.entry.expiresAt, "2026-01-15");

  const second = addQuarantine(first.registry, { test: "flakey", trackingIssue: 8, now });
  assert.equal(second.added, false);
  assert.equal(second.entry.trackingIssue, 7);
});

test("isQuarantined ignores expired entries and releaseQuarantine removes matches", () => {
  const registry = { quarantines: [{ test: "old flake", expiresAt: "2026-01-01" }] };
  assert.equal(isQuarantined("old flake", registry, new Date("2026-01-05T00:00:00Z")), false);
  assert.equal(isQuarantined("old flake", registry, new Date("2025-12-30T00:00:00Z")), true);

  const { removed } = releaseQuarantine(registry, "old flake");
  assert.equal(removed, 1);
});

// ── dashboard ─────────────────────────────────────────────────────────────

test("renderDashboard reports quarantine age and detected flakes", () => {
  const registry = {
    quarantines: [
      { test: "describe > does x", owner: "abimbolaalabi", trackingIssue: 42, quarantinedAt: "2026-01-01", expiresAt: "2026-01-15" },
    ],
  };
  const history = {
    runs: [
      run("r1", "2026-01-05T00:00:00Z", [{ name: "describe > does x", status: "failed" }]),
      run("r2", "2026-01-06T00:00:00Z", [{ name: "describe > does x", status: "passed" }]),
    ],
  };
  const markdown = renderDashboard(registry, history);
  assert.match(markdown, /As of: 2026-01-06/);
  assert.match(markdown, /describe > does x/);
  assert.match(markdown, /#42/);
  assert.match(markdown, /\| 5 \| active \|/);
  assert.match(markdown, /Flaky tests detected/);
});

test("renderDashboard is deterministic for the same data", () => {
  const registry = { quarantines: [] };
  const history = { runs: [] };
  assert.equal(renderDashboard(registry, history), renderDashboard(registry, history));
});

test("committed dashboard matches the generator output", () => {
  const rendered = renderDashboard(loadRegistry(), loadHistory());
  assert.equal(fs.readFileSync(DASHBOARD_PATH, "utf8"), rendered);
});

// ── end-to-end ────────────────────────────────────────────────────────────

test("a detected flaky test is quarantined, then fails the build once it expires", () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "flaky-"));
  const registryPath = path.join(workdir, "quarantine.json");
  const historyPath = path.join(workdir, "history.json");
  fs.writeFileSync(registryPath, JSON.stringify({ quarantines: [] }));
  fs.writeFileSync(
    historyPath,
    JSON.stringify({
      runs: [
        run("r1", "2026-01-01T00:00:00Z", [{ name: "flaky e2e", status: "passed" }]),
        run("r2", "2026-01-02T00:00:00Z", [{ name: "flaky e2e", status: "failed" }]),
      ],
    })
  );

  const flaky = detectFlaky(loadHistory(historyPath));
  assert.equal(flaky.length, 1);

  const registry = loadRegistry(registryPath);
  const { registry: next } = addQuarantine(registry, {
    test: flaky[0].name,
    trackingIssue: 99,
    now: new Date("2026-01-02T00:00:00Z"),
    days: 14,
  });
  fs.writeFileSync(registryPath, JSON.stringify(next, null, 2));

  assert.equal(isQuarantined("flaky e2e", loadRegistry(registryPath), new Date("2026-01-10T00:00:00Z")), true);

  const gateLater = checkQuarantines(loadRegistry(registryPath), new Date("2026-01-20T00:00:00Z"));
  assert.equal(gateLater.ok, false, "an expired quarantine must fail the gate");
  assert.equal(gateLater.expired[0].trackingIssue, 99);
});
