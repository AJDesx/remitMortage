#!/usr/bin/env node
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT
//
// flaky-quarantine.mjs
//
// CLI for the flaky-test detection and quarantine workflow (issue #877):
//
//   check       Fail when a quarantine has expired (the expiry gate).
//   record      Append a `jest --json` report to the flaky history.
//   detect      List flaky tests, marking those already quarantined.
//   quarantine  Add a test to the quarantine registry (opens from CI).
//   release     Remove a test from the registry once it is fixed.
//   dashboard   Regenerate (or --check) docs/FLAKY_TEST_DASHBOARD.md.
//
// See docs/FLAKY_TEST_QUARANTINE.md.

import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  DASHBOARD_PATH,
  HISTORY_PATH,
  REGISTRY_PATH,
  addQuarantine,
  appendRun,
  checkQuarantines,
  detectFlaky,
  isQuarantined,
  loadHistory,
  loadRegistry,
  normalizeJestReport,
  releaseQuarantine,
  renderDashboard,
  saveHistory,
  saveRegistry,
} from "./flaky-lib.mjs";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const [flag, inline] = token.slice(2).split("=");
    if (inline !== undefined) {
      args[flag] = inline;
    } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) {
      args[flag] = argv[++i];
    } else {
      args[flag] = true;
    }
  }
  return args;
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(2);
}

function cmdCheck(args) {
  const registry = loadRegistry(args.registry ?? REGISTRY_PATH);
  const now = args.now ? new Date(args.now) : new Date();
  const { ok, expired, expiring } = checkQuarantines(registry, now, {
    warnWithinDays: args["warn-within"] ? Number(args["warn-within"]) : undefined,
  });

  if (registry.quarantines.length === 0) {
    console.log("✓ No quarantined tests — expiry gate not applicable.");
    return 0;
  }

  for (const entry of expiring) {
    console.log(`⚠ Quarantine expiring soon: "${entry.test}" (expires ${entry.expiresAt}, tracking #${entry.trackingIssue ?? "n/a"})`);
  }
  for (const entry of expired) {
    console.error(`✗ Quarantine EXPIRED: "${entry.test}" (expired ${entry.expiresAt}, tracking #${entry.trackingIssue ?? "n/a"}) — fix the test and release it, or renew with justification.`);
  }

  if (!ok) {
    console.error(`\n${expired.length} quarantine(s) expired and unresolved. Failing the build.`);
    return 1;
  }
  console.log(`✓ ${registry.quarantines.length} quarantine(s) active, none expired.`);
  return 0;
}

function cmdRecord(args) {
  if (!args.results) fail("record requires --results <jest-json>");
  const historyPath = args.history ?? HISTORY_PATH;
  const report = JSON.parse(fs.readFileSync(args.results, "utf8"));
  const history = loadHistory(historyPath);
  const run = normalizeJestReport(report, {
    runId: args["run-id"],
    at: args.at,
  });
  const next = appendRun(history, run, { maxRuns: args["max-runs"] ? Number(args["max-runs"]) : undefined });
  saveHistory(next, historyPath);
  console.log(`✓ Recorded run ${run.runId}: ${run.tests.length} test result(s) → ${historyPath}`);
  return 0;
}

function cmdDetect(args) {
  const history = loadHistory(args.history ?? HISTORY_PATH);
  const registry = loadRegistry(args.registry ?? REGISTRY_PATH);
  const now = args.now ? new Date(args.now) : new Date();
  const flaky = detectFlaky(history, { minRuns: args["min-runs"] ? Number(args["min-runs"]) : undefined }).map(
    (test) => ({ ...test, quarantined: isQuarantined(test.name, registry, now) })
  );

  if (flaky.length === 0) {
    console.log("✓ No flaky tests detected.");
  } else {
    console.log(`Detected ${flaky.length} flaky test(s):`);
    for (const test of flaky) {
      console.log(`  - ${test.name} [${(test.failRate * 100).toFixed(0)}% fail, ${test.runs} runs]${test.quarantined ? " (quarantined)" : ""}`);
    }
  }

  if (args["json-out"]) {
    fs.writeFileSync(args["json-out"], `${JSON.stringify({ generatedFrom: history.runs.length, tests: flaky }, null, 2)}\n`);
    console.log(`Wrote ${args["json-out"]}`);
  }
  return 0;
}

function cmdQuarantine(args) {
  if (!args.test) fail("quarantine requires --test <name>");
  const registryPath = args.registry ?? REGISTRY_PATH;
  const registry = loadRegistry(registryPath);
  const now = args.now ? new Date(args.now) : new Date();
  const { registry: next, added, entry } = addQuarantine(registry, {
    test: args.test,
    reason: typeof args.reason === "string" ? args.reason : undefined,
    trackingIssue: args.issue ? Number(args.issue) : null,
    owner: args.owner ?? process.env.GITHUB_ACTOR ?? "unknown",
    days: args.days ? Number(args.days) : undefined,
    now,
  });
  if (!added) {
    console.log(`✓ "${entry.test}" is already quarantined until ${entry.expiresAt}.`);
    return 0;
  }
  saveRegistry(next, registryPath);
  console.log(`✓ Quarantined "${entry.test}" until ${entry.expiresAt} (tracking #${entry.trackingIssue ?? "n/a"}).`);
  return 0;
}

function cmdRelease(args) {
  if (!args.test) fail("release requires --test <name>");
  const registryPath = args.registry ?? REGISTRY_PATH;
  const registry = loadRegistry(registryPath);
  const { registry: next, removed } = releaseQuarantine(registry, args.test);
  saveRegistry(next, registryPath);
  console.log(removed > 0 ? `✓ Released ${removed} quarantine(s) matching "${args.test}".` : `No quarantine matched "${args.test}".`);
  return 0;
}

function cmdDashboard(args) {
  const registry = loadRegistry(args.registry ?? REGISTRY_PATH);
  const history = loadHistory(args.history ?? HISTORY_PATH);
  const outPath = args.out ?? DASHBOARD_PATH;
  const rendered = renderDashboard(registry, history);

  if (args.check) {
    const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : "";
    if (current !== rendered) {
      console.error(`✗ ${outPath} is out of date. Run: node scripts/flaky-quarantine.mjs dashboard`);
      return 1;
    }
    console.log(`✓ ${outPath} is up to date.`);
    return 0;
  }

  fs.writeFileSync(outPath, rendered);
  console.log(`✓ Wrote ${outPath}`);
  return 0;
}

const HELP = `Flaky test detection and quarantine (issue #877)

Usage:
  node scripts/flaky-quarantine.mjs check [--now <iso>] [--warn-within <days>]
  node scripts/flaky-quarantine.mjs record --results <jest.json> [--run-id <id>] [--history <path>]
  node scripts/flaky-quarantine.mjs detect [--history <path>] [--min-runs <n>] [--json-out <path>]
  node scripts/flaky-quarantine.mjs quarantine --test <name> --issue <n> [--days 14] [--reason "..."]
  node scripts/flaky-quarantine.mjs release --test <name>
  node scripts/flaky-quarantine.mjs dashboard [--check]

Paths default to devops/testing/quarantine.json, devops/testing/flaky-history.json
and docs/FLAKY_TEST_DASHBOARD.md. See docs/FLAKY_TEST_QUARANTINE.md.
`;

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "check";
  const args = parseArgs(command === argv[0] ? argv.slice(1) : argv);

  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  let code;
  try {
    switch (command) {
      case "check":
        code = cmdCheck(args);
        break;
      case "record":
        code = cmdRecord(args);
        break;
      case "detect":
        code = cmdDetect(args);
        break;
      case "quarantine":
        code = cmdQuarantine(args);
        break;
      case "release":
        code = cmdRelease(args);
        break;
      case "dashboard":
        code = cmdDashboard(args);
        break;
      default:
        fail(`Unknown command: ${command}\n\n${HELP}`);
    }
  } catch (error) {
    fail(error.message);
  }
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
