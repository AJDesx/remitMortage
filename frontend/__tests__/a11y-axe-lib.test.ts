// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  blockingViolations,
  checkRouteCoverage,
  discoverRoutes,
  formatReport,
  gateViolations,
  hasCoverageProblems,
  unusedAllowlistEntries,
  validateAllowlist,
  type AllowlistEntry,
  type AxeViolation,
  type RouteRegistry,
  type ScanResult,
} from "../a11y/lib";

const CONFIG = { failOnImpacts: ["critical", "serious"] as ("critical" | "serious")[] };
const TODAY = new Date("2026-06-01T00:00:00Z");

function violation(id: string, impact: AxeViolation["impact"], target = "#root"): AxeViolation {
  return { id, impact, help: `${id} help`, nodes: [{ target: [target] }] };
}

function scan(route: string, violations: AxeViolation[], theme: "light" | "dark" = "light"): ScanResult {
  return { route, url: route, theme, violations };
}

function allow(overrides: Partial<AllowlistEntry> = {}): AllowlistEntry {
  return {
    ruleId: "color-contrast",
    route: "/invest",
    justification: "Third-party chart legend colours cannot be changed; tracked in #123.",
    reviewedBy: "a11y-owner",
    reviewedOn: "2026-05-01",
    ...overrides,
  };
}

describe("discoverRoutes", () => {
  it("maps page files to routes, skipping api, route groups and private folders", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "a11y-app-"));
    const touch = (p: string) => {
      fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
      fs.writeFileSync(path.join(root, p), "");
    };
    touch("page.tsx");
    touch("invest/page.tsx");
    touch("help/articles/[slug]/page.tsx");
    touch("(marketing)/about/page.tsx");
    touch("_components/page.tsx");
    touch("api/loans/route.ts");
    touch("api/page.tsx");
    touch("invest/layout.tsx");

    expect(discoverRoutes(root)).toEqual(["/", "/about", "/help/articles/[slug]", "/invest"]);
  });
});

describe("checkRouteCoverage", () => {
  const registry: RouteRegistry = {
    routes: [
      { route: "/", url: "/" },
      { route: "/tx/[hash]", url: "/tx/abc" },
    ],
    excluded: [{ route: "/internal", reason: "Internal tool behind VPN, no end users." }],
  };

  it("passes when every discovered route is registered", () => {
    expect(hasCoverageProblems(checkRouteCoverage(["/", "/tx/[hash]", "/internal"], registry))).toBe(false);
  });

  it("flags a new route that was never registered", () => {
    const problems = checkRouteCoverage(["/", "/tx/[hash]", "/internal", "/brand-new"], registry);
    expect(problems.unregistered).toEqual(["/brand-new"]);
    expect(hasCoverageProblems(problems)).toBe(true);
  });

  it("flags registry entries for routes that were deleted", () => {
    expect(checkRouteCoverage(["/"], registry).stale).toEqual(["/internal", "/tx/[hash]"]);
  });

  it("flags excluded routes without a real reason", () => {
    const bad = { ...registry, excluded: [{ route: "/internal", reason: "" }] };
    expect(checkRouteCoverage(["/", "/tx/[hash]", "/internal"], bad).missingReason).toEqual(["/internal"]);
  });

  it("flags sample URLs that do not match their route or still contain a placeholder", () => {
    const bad: RouteRegistry = {
      routes: [
        { route: "/tx/[hash]", url: "/tx/[hash]" },
        { route: "/invest", url: "/stats" },
      ],
      excluded: [],
    };
    expect(checkRouteCoverage(["/tx/[hash]", "/invest"], bad).badUrls).toEqual(["/tx/[hash]", "/invest"]);
  });

  it("flags routes registered twice or both scanned and excluded", () => {
    const dup: RouteRegistry = {
      routes: [{ route: "/", url: "/" }],
      excluded: [{ route: "/", reason: "Excluded by mistake as well." }],
    };
    expect(checkRouteCoverage(["/"], dup).duplicates).toEqual(["/"]);
  });
});

describe("validateAllowlist", () => {
  const registry: RouteRegistry = { routes: [{ route: "/invest", url: "/invest" }], excluded: [] };

  it("accepts a fully justified entry", () => {
    expect(validateAllowlist([allow()], registry, TODAY)).toEqual([]);
  });

  it("rejects entries without a meaningful justification, reviewer or date", () => {
    const problems = validateAllowlist(
      [allow({ justification: "todo", reviewedBy: "", reviewedOn: "yesterday" })],
      registry,
      TODAY,
    );
    expect(problems.join("\n")).toMatch(/justification/);
    expect(problems.join("\n")).toMatch(/reviewedBy/);
    expect(problems.join("\n")).toMatch(/reviewedOn/);
  });

  it("rejects unknown routes and expired entries", () => {
    const problems = validateAllowlist([allow({ route: "/nope" }), allow({ expires: "2026-01-01" })], registry, TODAY);
    expect(problems.join("\n")).toMatch(/not in a11y\/routes\.json/);
    expect(problems.join("\n")).toMatch(/expired on 2026-01-01/);
  });

  it("allows the wildcard route", () => {
    expect(validateAllowlist([allow({ route: "*" })], registry, TODAY)).toEqual([]);
  });
});

describe("gateViolations", () => {
  const result = scan("/invest", [
    violation("color-contrast", "serious", ".legend"),
    violation("image-alt", "critical", "img.logo"),
    violation("region", "moderate"),
    violation("heading-order", "minor"),
  ]);

  it("only gates violations at or above the configured severity", () => {
    expect(gateViolations(result, CONFIG, [], TODAY).map((v) => v.id)).toEqual(["color-contrast", "image-alt"]);
  });

  it("blocks new serious and critical violations", () => {
    expect(blockingViolations(gateViolations(result, CONFIG, [], TODAY)).map((v) => v.id)).toEqual([
      "color-contrast",
      "image-alt",
    ]);
  });

  it("lets an allowlisted violation through while still blocking the rest", () => {
    const blocking = blockingViolations(gateViolations(result, CONFIG, [allow()], TODAY));
    expect(blocking.map((v) => v.id)).toEqual(["image-alt"]);
  });

  it("scopes an allowlist entry to its route, theme and selector", () => {
    expect(blockingViolations(gateViolations(scan("/stats", result.violations), CONFIG, [allow()], TODAY))).toHaveLength(2);
    expect(blockingViolations(gateViolations(result, CONFIG, [allow({ theme: "dark" })], TODAY))).toHaveLength(2);
    expect(blockingViolations(gateViolations(result, CONFIG, [allow({ selector: ".other" })], TODAY))).toHaveLength(2);
    expect(blockingViolations(gateViolations(result, CONFIG, [allow({ selector: ".legend" })], TODAY))).toHaveLength(1);
  });

  it("ignores expired allowlist entries", () => {
    const expired = allow({ expires: "2026-01-01" });
    expect(blockingViolations(gateViolations(result, CONFIG, [expired], TODAY))).toHaveLength(2);
  });
});

describe("unusedAllowlistEntries", () => {
  it("reports entries that no longer match anything", () => {
    const used = allow();
    const unused = allow({ ruleId: "label" });
    const results = [scan("/invest", [violation("color-contrast", "serious")])];
    expect(unusedAllowlistEntries(results, CONFIG, [used, unused])).toEqual([unused]);
  });
});

describe("formatReport", () => {
  it("reports blocking violations in a readable table", () => {
    const { markdown, blockingCount } = formatReport(
      [scan("/invest", [violation("image-alt", "critical", "img.logo")], "dark")],
      CONFIG,
      [],
      TODAY,
    );
    expect(blockingCount).toBe(1);
    expect(markdown).toMatch(/1 blocking violation/);
    expect(markdown).toMatch(/### `\/invest` \(dark\)/);
    expect(markdown).toMatch(/\*\*FAIL\*\*/);
  });

  it("shows allowlisted violations with their justification and passes", () => {
    const { markdown, blockingCount } = formatReport(
      [scan("/invest", [violation("color-contrast", "serious")])],
      CONFIG,
      [allow()],
      TODAY,
    );
    expect(blockingCount).toBe(0);
    expect(markdown).toMatch(/No blocking violations \(1 allowlisted\)/);
    expect(markdown).toMatch(/allowlisted — Third-party chart legend/);
  });

  it("reports a clean run", () => {
    const { markdown, blockingCount } = formatReport([scan("/", [])], CONFIG, [], TODAY);
    expect(blockingCount).toBe(0);
    expect(markdown).toMatch(/No blocking violations\./);
  });
});
