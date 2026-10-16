// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

// Shared helpers for flaky-test detection and quarantine (issue #877).
//
// Two data files back the workflow:
//
//   * devops/testing/flaky-history.json — an append-only record of test
//     outcomes per CI run (including retries), used to detect flakiness.
//   * devops/testing/quarantine.json — the quarantine registry. A quarantined
//     test is skipped by the Jest setup (backend/test/flakyQuarantine.cjs) and
//     carries a tracking issue and an expiry so it cannot be forgotten.
//
// Everything here is pure so the detection, expiry and dashboard logic is
// unit-testable without Jest, GitHub, or the network.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "..");
export const REGISTRY_PATH = path.join(REPO_ROOT, "devops/testing/quarantine.json");
export const HISTORY_PATH = path.join(REPO_ROOT, "devops/testing/flaky-history.json");
export const DASHBOARD_PATH = path.join(REPO_ROOT, "docs/FLAKY_TEST_DASHBOARD.md");

export const DEFAULT_QUARANTINE_DAYS = 14;
export const DEFAULT_WARN_WITHIN_DAYS = 7;
export const DEFAULT_MAX_RUNS = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Date helpers ───────────────────────────────────────────────────────────

/** Parse an ISO date/timestamp into a Date, or null when absent/invalid. */
export function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "YYYY-MM-DD" for a Date. */
export function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function startOfDay(date) {
  const copy = new Date(date);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

/** Whole days from `a` to `b` at UTC-day granularity. */
export function daysBetween(a, b) {
  return Math.round((startOfDay(b) - startOfDay(a)) / DAY_MS);
}

export function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

// ── Loading / saving ───────────────────────────────────────────────────────

export function loadRegistry(registryPath = REGISTRY_PATH) {
  const raw = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  return { quarantines: Array.isArray(raw.quarantines) ? raw.quarantines : [] };
}

export function saveRegistry(registry, registryPath = REGISTRY_PATH) {
  fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

export function loadHistory(historyPath = HISTORY_PATH) {
  const raw = JSON.parse(fs.readFileSync(historyPath, "utf8"));
  return { runs: Array.isArray(raw.runs) ? raw.runs : [] };
}

export function saveHistory(history, historyPath = HISTORY_PATH) {
  fs.writeFileSync(historyPath, `${JSON.stringify(history, null, 2)}\n`);
}

// ── Recording outcomes ─────────────────────────────────────────────────────

/**
 * Normalize a `jest --json` report into a history run.
 *
 * Jest exposes a test's final status per assertion; a test that only passed
 * after a retry is still "passed" here, so `retries` is carried through from
 * the assertion when a custom reporter provides it (defaults to 0).
 */
export function normalizeJestReport(report, { runId, at } = {}) {
  const tests = [];
  for (const suite of report.testResults ?? []) {
    for (const assertion of suite.assertionResults ?? []) {
      if (assertion.status !== "passed" && assertion.status !== "failed") continue;
      tests.push({
        name: assertion.fullName || assertion.title,
        file: suite.name ?? suite.testFilePath ?? null,
        status: assertion.status,
        retries: Number.isInteger(assertion.retries) ? assertion.retries : 0,
        durationMs: assertion.duration ?? null,
      });
    }
  }
  return {
    runId: String(runId ?? report.startTime ?? Date.now()),
    at: at ?? new Date().toISOString(),
    tests,
  };
}

/** Append a run, replacing any run with the same id and capping history size. */
export function appendRun(history, run, { maxRuns = DEFAULT_MAX_RUNS } = {}) {
  const runs = history.runs.filter((existing) => existing.runId !== run.runId);
  runs.push(run);
  const trimmed = runs.slice(-maxRuns);
  return { runs: trimmed };
}

// ── Flakiness detection ────────────────────────────────────────────────────

/**
 * Identify flaky tests from recorded history.
 *
 * A test is flaky when, across runs, it both passed and failed, or when it
 * only passed after one or more retries. A test that fails every run is
 * broken (not flaky) and is deliberately excluded — that belongs to a
 * different signal.
 */
export function detectFlaky(history, { minRuns = 2 } = {}) {
  const byName = new Map();

  for (const run of history.runs ?? []) {
    for (const test of run.tests ?? []) {
      if (!byName.has(test.name)) {
        byName.set(test.name, { name: test.name, file: test.file ?? null, passed: 0, failed: 0, retriedPasses: 0, runs: 0 });
      }
      const entry = byName.get(test.name);
      if (!entry.file && test.file) entry.file = test.file;
      entry.runs += 1;
      if (test.status === "failed") entry.failed += 1;
      else if (test.status === "passed") {
        entry.passed += 1;
        if ((test.retries ?? 0) > 0) entry.retriedPasses += 1;
      }
    }
  }

  const flaky = [];
  for (const entry of byName.values()) {
    if (entry.runs < minRuns) continue;
    const mixed = entry.passed > 0 && entry.failed > 0;
    const retried = entry.retriedPasses > 0;
    if (!mixed && !retried) continue;
    const decisive = entry.passed + entry.failed;
    flaky.push({
      ...entry,
      failRate: decisive > 0 ? entry.failed / decisive : 0,
      reason: mixed
        ? `passed ${entry.passed}/${decisive} runs and failed ${entry.failed}`
        : `required a retry to pass in ${entry.retriedPasses} run(s)`,
    });
  }

  return flaky.sort((a, b) => b.failRate - a.failRate || a.name.localeCompare(b.name));
}

// ── Quarantine decisions ───────────────────────────────────────────────────

/** Text match between a Jest full test name and a quarantine fragment. */
export function matchesTest(testName, fragment) {
  const a = String(testName ?? "").toLowerCase();
  const b = String(fragment ?? "").toLowerCase();
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/** "expired" | "expiring" | "active" for one quarantine entry at `now`. */
export function quarantineStatus(entry, now = new Date(), { warnWithinDays = DEFAULT_WARN_WITHIN_DAYS } = {}) {
  const expiry = toDate(entry.expiresAt);
  if (!expiry) return "active";
  const today = startOfDay(now);
  if (startOfDay(expiry) < today) return "expired";
  if (daysBetween(today, startOfDay(expiry)) <= warnWithinDays) return "expiring";
  return "active";
}

/** Quarantines that still suppress a test (not expired). */
export function activeQuarantines(registry, now = new Date()) {
  return (registry.quarantines ?? []).filter((entry) => quarantineStatus(entry, now) !== "expired");
}

export function expiredQuarantines(registry, now = new Date()) {
  return (registry.quarantines ?? []).filter((entry) => quarantineStatus(entry, now) === "expired");
}

export function expiringQuarantines(registry, now = new Date(), options = {}) {
  return (registry.quarantines ?? []).filter((entry) => quarantineStatus(entry, now, options) === "expiring");
}

/** True when an active quarantine fragment matches the test name. */
export function isQuarantined(testName, registry, now = new Date()) {
  return activeQuarantines(registry, now).some((entry) => matchesTest(testName, entry.test));
}

/**
 * Expiry gate: fails when any quarantine has passed its `expiresAt`, so a
 * quarantined test cannot be forgotten indefinitely. `expiring` is advisory.
 */
export function checkQuarantines(registry, now = new Date(), options = {}) {
  const expired = expiredQuarantines(registry, now);
  const expiring = expiringQuarantines(registry, now, options);
  return { ok: expired.length === 0, expired, expiring };
}

/** Add a quarantine entry (idempotent for an active existing match). */
export function addQuarantine(
  registry,
  { test, reason, trackingIssue, owner = "unknown", days = DEFAULT_QUARANTINE_DAYS, now = new Date() }
) {
  if (!test) throw new Error("addQuarantine requires a test name");
  const existing = activeQuarantines(registry, now).find((entry) => matchesTest(test, entry.test));
  if (existing) return { registry, added: false, entry: existing };

  const entry = {
    test,
    reason: reason || "Flaky test quarantined by CI",
    owner,
    trackingIssue: trackingIssue ?? null,
    quarantinedAt: formatDate(now),
    expiresAt: formatDate(addDays(now, days)),
  };
  return { registry: { quarantines: [...registry.quarantines, entry] }, added: true, entry };
}

/** Remove every quarantine entry matching a test fragment. */
export function releaseQuarantine(registry, test) {
  const remaining = registry.quarantines.filter((entry) => !matchesTest(test, entry.test));
  return { registry: { quarantines: remaining }, removed: registry.quarantines.length - remaining.length };
}

// ── Dashboard ──────────────────────────────────────────────────────────────

function latestDate(values) {
  let latest = null;
  for (const value of values) {
    const date = toDate(value);
    if (date && (!latest || date > latest)) latest = date;
  }
  return latest;
}

/**
 * Render the flaky-test dashboard as Markdown.
 *
 * The reference date ("as of") is derived from the data itself — the newest
 * recorded run or quarantine date — so the output is deterministic and the
 * committed dashboard can be diff-checked in CI without drifting with the
 * wall clock.
 */
export function renderDashboard(registry, history) {
  const asOf = latestDate([
    ...(history.runs ?? []).map((run) => run.at),
    ...(registry.quarantines ?? []).map((entry) => entry.quarantinedAt),
  ]);
  const asOfDate = asOf ?? null;

  const lines = [];
  lines.push("# Flaky Test Dashboard");
  lines.push("");
  lines.push("> GENERATED FILE — do not edit by hand.");
  lines.push("> Source: `devops/testing/quarantine.json`, `devops/testing/flaky-history.json`.");
  lines.push("> Generator: `scripts/flaky-quarantine.mjs dashboard`. Policy: `docs/FLAKY_TEST_QUARANTINE.md`.");
  lines.push("");
  lines.push(`As of: ${asOfDate ? formatDate(asOfDate) : "no data recorded"}`);
  lines.push("");

  lines.push("## Quarantined tests");
  lines.push("");
  if ((registry.quarantines ?? []).length === 0) {
    lines.push("_No tests are currently quarantined._");
  } else {
    lines.push("| Test | Owner | Tracking issue | Quarantined | Expires | Age (days) | Status |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const entry of registry.quarantines) {
      const quarantinedAt = toDate(entry.quarantinedAt);
      const age = quarantinedAt && asOfDate ? daysBetween(quarantinedAt, asOfDate) : "—";
      const status = asOfDate ? quarantineStatus(entry, asOfDate) : "unknown";
      const issue = entry.trackingIssue ? `#${entry.trackingIssue}` : "—";
      lines.push(
        `| \`${entry.test}\` | ${entry.owner ?? "—"} | ${issue} | ${entry.quarantinedAt ?? "—"} | ${entry.expiresAt ?? "—"} | ${age} | ${status} |`
      );
    }
  }
  lines.push("");

  lines.push("## Flaky tests detected");
  lines.push("");
  const flaky = detectFlaky(history);
  if (flaky.length === 0) {
    lines.push("_No flaky tests detected in the recorded history._");
  } else {
    lines.push("| Test | Runs | Passed | Failed | Retried passes | Fail rate | Quarantined |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const test of flaky) {
      const quarantined = asOfDate && isQuarantined(test.name, registry, asOfDate) ? "yes" : "no";
      lines.push(
        `| \`${test.name}\` | ${test.runs} | ${test.passed} | ${test.failed} | ${test.retriedPasses} | ${(test.failRate * 100).toFixed(0)}% | ${quarantined} |`
      );
    }
  }
  lines.push("");

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderRegistry(registry) {
  return `${JSON.stringify(registry, null, 2)}\n`;
}

export function renderHistory(history) {
  return `${JSON.stringify(history, null, 2)}\n`;
}
