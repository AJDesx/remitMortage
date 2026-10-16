import assert from "node:assert/strict";
import test from "node:test";
import { evaluateBudgets, renderReport } from "./check-image-size-budget.mjs";

const budgets = {
  backend: { maxBytes: 1000, graceUntil: null },
  frontend: { maxBytes: 2000, graceUntil: "2099-01-01" },
};

test("passes when every image is under budget", () => {
  const { results, hasFailure } = evaluateBudgets({
    budgets,
    current: { backend: 900, frontend: 1500 },
    baseline: {},
    today: "2026-01-01",
  });
  assert.equal(hasFailure, false);
  assert.deepEqual(results.map((r) => r.status), ["PASS", "PASS"]);
});

test("fails when an image is over budget with no grace period", () => {
  const { results, hasFailure } = evaluateBudgets({
    budgets,
    current: { backend: 1500 },
    baseline: {},
    today: "2026-01-01",
  });
  assert.equal(hasFailure, true);
  assert.equal(results[0].status, "FAIL");
});

test("warns instead of failing when over budget within an active grace period", () => {
  const { results, hasFailure } = evaluateBudgets({
    budgets,
    current: { frontend: 2500 },
    baseline: {},
    today: "2026-01-01",
  });
  assert.equal(hasFailure, false);
  assert.equal(results[0].status, "WARN");
});

test("fails once the grace period has expired", () => {
  const { results, hasFailure } = evaluateBudgets({
    budgets,
    current: { frontend: 2500 },
    baseline: {},
    today: "2099-06-01",
  });
  assert.equal(hasFailure, true);
  assert.equal(results[0].status, "FAIL");
});

test("flags an image with no budget entry as unconfigured and failing", () => {
  const { results, hasFailure } = evaluateBudgets({
    budgets,
    current: { "new-image": 500 },
    baseline: {},
    today: "2026-01-01",
  });
  assert.equal(hasFailure, true);
  assert.equal(results[0].status, "UNCONFIGURED");
});

test("computes a positive delta against a larger previous build", () => {
  const { results } = evaluateBudgets({
    budgets,
    current: { backend: 900 },
    baseline: { backend: 800 },
    today: "2026-01-01",
  });
  assert.equal(results[0].deltaBytes, 100);
});

test("delta is null when no baseline is available for that image", () => {
  const { results } = evaluateBudgets({
    budgets,
    current: { backend: 900 },
    baseline: {},
    today: "2026-01-01",
  });
  assert.equal(results[0].deltaBytes, null);
});

test("renderReport includes a row per image and a raise-budget pointer when failing", () => {
  const { results } = evaluateBudgets({
    budgets,
    current: { backend: 1500 },
    baseline: { backend: 1000 },
    today: "2026-01-01",
  });
  const report = renderReport(results);
  assert.match(report, /backend/);
  assert.match(report, /CONTAINER_IMAGE_SIZE_BUDGET\.md/);
  assert.match(report, /❌ FAIL/);
});
