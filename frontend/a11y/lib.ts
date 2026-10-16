// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Pure helpers for the axe accessibility regression suite: route discovery and
 * coverage checks, allowlist validation/matching, severity gating and report
 * formatting. Kept free of browser and Playwright imports so Jest can test it.
 */

import fs from "node:fs";
import path from "node:path";

export type Impact = "minor" | "moderate" | "serious" | "critical";
export type Theme = "light" | "dark";

export interface A11yConfig {
  failOnImpacts: Impact[];
  tags: string[];
  themes: Theme[];
}

export interface RouteEntry {
  route: string;
  url: string;
}

export interface ExcludedRoute {
  route: string;
  reason: string;
}

export interface RouteRegistry {
  routes: RouteEntry[];
  excluded: ExcludedRoute[];
}

export interface AllowlistEntry {
  ruleId: string;
  /** Route pattern (e.g. "/invest") or "*" for every route. */
  route: string;
  /** Limit to one theme; omit for both. */
  theme?: Theme;
  /** Substring of an axe node target; omit to allow the rule on the whole route. */
  selector?: string;
  justification: string;
  reviewedBy: string;
  /** ISO date (YYYY-MM-DD). */
  reviewedOn: string;
  /** ISO date after which the exception stops applying and validation fails. */
  expires?: string;
}

export interface AxeNode {
  target: unknown[];
  html?: string;
  failureSummary?: string;
}

export interface AxeViolation {
  id: string;
  impact?: Impact | null;
  help: string;
  helpUrl?: string;
  nodes: AxeNode[];
}

export interface ScanResult {
  route: string;
  url: string;
  theme: Theme;
  violations: AxeViolation[];
}

export interface GatedViolation extends AxeViolation {
  allowlisted: boolean;
  allowlistReason?: string;
}

// ── Route discovery & coverage ───────────────────────────────────────────

/** Finds every `page.tsx` under `appDir` and returns its Next.js route pattern. */
export function discoverRoutes(appDir: string): string[] {
  const routes: string[] = [];

  const walk = (dir: string, segments: string[]) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // The API tree holds route handlers, not pages; `_private` and `@slot`
        // folders are not URL segments.
        if (entry.name === "api" && segments.length === 0) continue;
        if (entry.name.startsWith("_") || entry.name.startsWith("@")) continue;
        const isGroup = /^\(.+\)$/.test(entry.name);
        walk(path.join(dir, entry.name), isGroup ? segments : [...segments, entry.name]);
      } else if (/^page\.(tsx|ts|jsx|js|mdx)$/.test(entry.name)) {
        routes.push("/" + segments.join("/"));
      }
    }
  };

  walk(appDir, []);
  return [...new Set(routes)].sort();
}

function routeToRegExp(route: string): RegExp {
  const source = route
    .split("/")
    .map((segment) => {
      if (/^\[\[?\.\.\..+\]\]?$/.test(segment)) return ".+";
      if (/^\[.+\]$/.test(segment)) return "[^/]+";
      return segment.replace(/[.*+?^${}()|\\]/g, "\\$&");
    })
    .join("/");
  return new RegExp(`^${source || "/"}/?$`);
}

export interface CoverageProblems {
  /** Routes that exist in src/app but are neither scanned nor excluded. */
  unregistered: string[];
  /** Registered or excluded routes that no longer exist in src/app. */
  stale: string[];
  /** Excluded routes without a justification. */
  missingReason: string[];
  /** Registered URLs that do not match their route pattern. */
  badUrls: string[];
  /** Routes listed more than once, or both scanned and excluded. */
  duplicates: string[];
}

export function checkRouteCoverage(discovered: string[], registry: RouteRegistry): CoverageProblems {
  const found = new Set(discovered);
  const scanned = registry.routes.map((r) => r.route);
  const excluded = registry.excluded.map((r) => r.route);
  const known = new Set([...scanned, ...excluded]);

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const route of [...scanned, ...excluded]) {
    if (seen.has(route)) duplicates.add(route);
    seen.add(route);
  }

  return {
    unregistered: discovered.filter((route) => !known.has(route)),
    stale: [...known].filter((route) => !found.has(route)).sort(),
    missingReason: registry.excluded.filter((r) => !r.reason || r.reason.trim().length < 10).map((r) => r.route),
    badUrls: registry.routes
      .filter((r) => r.url.includes("[") || !routeToRegExp(r.route).test(r.url.split("?")[0]))
      .map((r) => r.route),
    duplicates: [...duplicates].sort(),
  };
}

export function hasCoverageProblems(problems: CoverageProblems): boolean {
  return Object.values(problems).some((list) => list.length > 0);
}

// ── Allowlist ────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Returns human-readable problems with allowlist entries; empty when valid. */
export function validateAllowlist(entries: AllowlistEntry[], registry: RouteRegistry, today = new Date()): string[] {
  const problems: string[] = [];
  const todayIso = today.toISOString().slice(0, 10);
  const knownRoutes = new Set(registry.routes.map((r) => r.route));

  entries.forEach((entry, index) => {
    const label = `allowlist[${index}] (${entry.ruleId ?? "?"} @ ${entry.route ?? "?"})`;
    if (!entry.ruleId) problems.push(`${label}: ruleId is required`);
    if (!entry.route) problems.push(`${label}: route is required ("*" for all routes)`);
    else if (entry.route !== "*" && !knownRoutes.has(entry.route)) {
      problems.push(`${label}: route is not in a11y/routes.json`);
    }
    if (!entry.justification || entry.justification.trim().length < 20) {
      problems.push(`${label}: justification must explain the exception (min 20 characters)`);
    }
    if (!entry.reviewedBy) problems.push(`${label}: reviewedBy is required`);
    if (!entry.reviewedOn || !ISO_DATE.test(entry.reviewedOn)) problems.push(`${label}: reviewedOn must be YYYY-MM-DD`);
    if (entry.theme && entry.theme !== "light" && entry.theme !== "dark") problems.push(`${label}: theme must be light or dark`);
    if (entry.expires) {
      if (!ISO_DATE.test(entry.expires)) problems.push(`${label}: expires must be YYYY-MM-DD`);
      else if (entry.expires < todayIso) problems.push(`${label}: expired on ${entry.expires}; fix the violation or re-review`);
    }
  });
  return problems;
}

function nodeTargets(node: AxeNode): string {
  return node.target.map((t) => (Array.isArray(t) ? t.join(" ") : String(t))).join(" ");
}

function findAllowlistEntry(
  violation: AxeViolation,
  route: string,
  theme: Theme,
  allowlist: AllowlistEntry[],
  today: string,
): AllowlistEntry | undefined {
  return allowlist.find((entry) => {
    if (entry.ruleId !== violation.id) return false;
    if (entry.route !== "*" && entry.route !== route) return false;
    if (entry.theme && entry.theme !== theme) return false;
    if (entry.expires && entry.expires < today) return false;
    if (!entry.selector) return true;
    const selector = entry.selector;
    return violation.nodes.every((node) => nodeTargets(node).includes(selector));
  });
}

// ── Gating ───────────────────────────────────────────────────────────────

/** Violations at or above the configured severity, marked when allowlisted. */
export function gateViolations(
  result: Pick<ScanResult, "route" | "theme" | "violations">,
  config: Pick<A11yConfig, "failOnImpacts">,
  allowlist: AllowlistEntry[],
  today = new Date(),
): GatedViolation[] {
  const todayIso = today.toISOString().slice(0, 10);
  return result.violations
    .filter((v) => v.impact && config.failOnImpacts.includes(v.impact))
    .map((v) => {
      const entry = findAllowlistEntry(v, result.route, result.theme, allowlist, todayIso);
      return { ...v, allowlisted: Boolean(entry), allowlistReason: entry?.justification };
    });
}

export function blockingViolations(gated: GatedViolation[]): GatedViolation[] {
  return gated.filter((v) => !v.allowlisted);
}

/** Allowlist entries that matched no gated violation in any scan, so they can be pruned. */
export function unusedAllowlistEntries(
  results: ScanResult[],
  config: Pick<A11yConfig, "failOnImpacts">,
  allowlist: AllowlistEntry[],
): AllowlistEntry[] {
  const used = new Set<AllowlistEntry>();
  for (const result of results) {
    for (const v of result.violations) {
      if (!v.impact || !config.failOnImpacts.includes(v.impact)) continue;
      const entry = findAllowlistEntry(v, result.route, result.theme, allowlist, "0000-00-00");
      if (entry) used.add(entry);
    }
  }
  return allowlist.filter((entry) => !used.has(entry));
}

// ── Report ───────────────────────────────────────────────────────────────

function cell(text: string): string {
  return text.replace(/[|\r\n`]/g, " ").slice(0, 160);
}

export function formatReport(
  results: ScanResult[],
  config: Pick<A11yConfig, "failOnImpacts">,
  allowlist: AllowlistEntry[],
  today = new Date(),
): { markdown: string; blockingCount: number } {
  let blockingCount = 0;
  let allowlistedCount = 0;
  const sections: string[] = [];

  for (const result of [...results].sort((a, b) => (a.route + a.theme).localeCompare(b.route + b.theme))) {
    const gated = gateViolations(result, config, allowlist, today);
    const blocking = blockingViolations(gated);
    blockingCount += blocking.length;
    allowlistedCount += gated.length - blocking.length;
    if (gated.length === 0) continue;

    const rows = gated.map((v) => {
      const first = v.nodes[0] ? cell(nodeTargets(v.nodes[0])) : "";
      const status = v.allowlisted ? `allowlisted — ${cell(v.allowlistReason ?? "")}` : "**FAIL**";
      return `| ${v.impact} | \`${cell(v.id)}\` | ${cell(v.help)} | ${v.nodes.length} | \`${first}\` | ${status} |`;
    });
    sections.push(
      `### \`${result.route}\` (${result.theme})`,
      "",
      "| Impact | Rule | Description | Nodes | First node | Status |",
      "| --- | --- | --- | --- | --- | --- |",
      ...rows,
      "",
    );
  }

  const header = [
    "## Axe accessibility report",
    "",
    `Scanned **${results.length}** route/theme combinations (${new Set(results.map((r) => r.route)).size} routes). ` +
      `Failing on: ${config.failOnImpacts.join(", ")}.`,
    "",
    blockingCount === 0
      ? `✅ No blocking violations${allowlistedCount ? ` (${allowlistedCount} allowlisted)` : ""}.`
      : `❌ **${blockingCount} blocking violation(s)** (${allowlistedCount} allowlisted).`,
    "",
  ];
  return { markdown: [...header, ...sections].join("\n"), blockingCount };
}

// ── Loading ──────────────────────────────────────────────────────────────

export const A11Y_DIR = path.resolve(__dirname);

export function loadJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(A11Y_DIR, file), "utf8")) as T;
}

export const loadConfig = () => loadJson<A11yConfig>("config.json");
export const loadRegistry = () => loadJson<RouteRegistry>("routes.json");
export const loadAllowlist = () => loadJson<{ entries: AllowlistEntry[] }>("allowlist.json").entries;
