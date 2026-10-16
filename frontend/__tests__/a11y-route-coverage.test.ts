// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Coverage guard for the axe regression suite: every page under src/app must
 * be registered in a11y/routes.json (or explicitly excluded with a reason), so
 * adding a route without scanning it fails CI.
 */

import path from "node:path";
import {
  checkRouteCoverage,
  discoverRoutes,
  hasCoverageProblems,
  loadAllowlist,
  loadRegistry,
  validateAllowlist,
} from "../a11y/lib";

const APP_DIR = path.resolve(__dirname, "..", "src", "app");

describe("axe route coverage", () => {
  const discovered = discoverRoutes(APP_DIR);
  const registry = loadRegistry();
  const problems = checkRouteCoverage(discovered, registry);

  it("discovers the application's pages", () => {
    expect(discovered).toContain("/");
    expect(discovered).toContain("/dashboard");
    expect(discovered.some((r) => r.startsWith("/api"))).toBe(false);
  });

  it("registers every page for scanning (add new routes to a11y/routes.json)", () => {
    expect(problems.unregistered).toEqual([]);
  });

  it("has no stale, duplicate or malformed registry entries", () => {
    expect(problems.stale).toEqual([]);
    expect(problems.duplicates).toEqual([]);
    expect(problems.badUrls).toEqual([]);
    expect(problems.missingReason).toEqual([]);
    expect(hasCoverageProblems(problems)).toBe(false);
  });

  it("has a valid, justified allowlist", () => {
    expect(validateAllowlist(loadAllowlist(), registry)).toEqual([]);
  });
});
