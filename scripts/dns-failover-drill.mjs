#!/usr/bin/env node
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT
//
// dns-failover-drill.mjs
//
// Drives the health-checked DNS failover drill described in
// docs/DNS_FAILOVER_RUNBOOK.md. It has two modes:
//
//   * --simulate (default): build a deterministic observation timeline and
//     evaluate it. This is what CI and the unit tests run — no AWS required.
//   * live: block the primary health check through a staging control endpoint,
//     poll DNS until the hostname resolves to the secondary IP (failover), then
//     restore the primary and poll until it resolves back (failback).
//
// The evaluation is a pure function (`evaluateFailover`) so the RTO/failback
// logic is unit-testable without touching DNS or Route 53.
//
// Exit codes: 0 = drill passed, 1 = target missed / drill failed, 2 = misconfig.

import { resolve4 } from "node:dns/promises";
import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const DEFAULT_RTO_SECONDS = 120;
export const DEFAULT_FAILBACK_SECONDS = 300;
export const DEFAULT_SAMPLE_INTERVAL_SECONDS = 5;

/**
 * Evaluate a failover drill timeline.
 *
 * `observations` is a list of `{ t, resolvesTo }` samples where `resolvesTo` is
 * `"primary" | "secondary" | "none"`, with `t` in seconds since the drill
 * started. Returns measured failover/failback times and whether each met its
 * target.
 *
 * @param {Array<{t:number, resolvesTo:string}>} observations
 * @param {{rtoTargetSeconds?:number, failbackTargetSeconds?:number, primaryRestoredAtSeconds?:number|null}} [options]
 */
export function evaluateFailover(observations, options = {}) {
  const rtoTargetSeconds = options.rtoTargetSeconds ?? DEFAULT_RTO_SECONDS;
  const failbackTargetSeconds = options.failbackTargetSeconds ?? DEFAULT_FAILBACK_SECONDS;
  const primaryRestoredAtSeconds = options.primaryRestoredAtSeconds ?? null;
  const reasons = [];

  if (!Array.isArray(observations) || observations.length === 0) {
    return {
      passed: false,
      failoverSeconds: null,
      failbackSeconds: null,
      failoverOk: false,
      failbackOk: false,
      rtoTargetSeconds,
      failbackTargetSeconds,
      reasons: ["No DNS observations were supplied"],
    };
  }

  const sorted = [...observations].sort((a, b) => a.t - b.t);

  let sawPrimary = sorted[0].resolvesTo === "primary";
  let failoverSeconds = null;
  let failbackSeconds = null;

  for (const observation of sorted) {
    if (observation.resolvesTo === "primary") {
      sawPrimary = true;
      if (failoverSeconds !== null && failbackSeconds === null) {
        failbackSeconds = observation.t;
      }
    } else if (
      observation.resolvesTo === "secondary" &&
      sawPrimary &&
      failoverSeconds === null
    ) {
      failoverSeconds = observation.t;
    }
  }

  const failoverOk = failoverSeconds !== null && failoverSeconds <= rtoTargetSeconds;
  if (failoverSeconds === null) {
    reasons.push("Traffic never failed over to the secondary endpoint");
  } else if (!failoverOk) {
    reasons.push(
      `Failover took ${failoverSeconds}s, exceeding the ${rtoTargetSeconds}s RTO target`
    );
  }

  let failbackOk = true;
  if (failoverSeconds !== null && failbackSeconds === null) {
    failbackOk = false;
    reasons.push("Traffic never failed back to the primary endpoint");
  } else if (failbackSeconds !== null && primaryRestoredAtSeconds !== null) {
    const failbackLatency = failbackSeconds - primaryRestoredAtSeconds;
    failbackOk = failbackLatency <= failbackTargetSeconds;
    if (!failbackOk) {
      reasons.push(
        `Failback took ${failbackLatency}s after restoration, exceeding the ${failbackTargetSeconds}s target`
      );
    }
  }

  return {
    passed: failoverOk && failbackOk,
    failoverSeconds,
    failbackSeconds,
    failoverOk,
    failbackOk,
    rtoTargetSeconds,
    failbackTargetSeconds,
    reasons,
  };
}

/**
 * Build a deterministic failover→failback timeline and evaluate it.
 *
 * @param {{sampleIntervalSeconds?:number, faultInjectedAtSeconds?:number, dnsFailoverDelaySeconds?:number, faultClearedAtSeconds?:number, dnsFailbackDelaySeconds?:number, rtoTargetSeconds?:number, failbackTargetSeconds?:number}} [scenario]
 */
export function simulateFailoverDrill(scenario = {}) {
  const {
    sampleIntervalSeconds = DEFAULT_SAMPLE_INTERVAL_SECONDS,
    faultInjectedAtSeconds = 0,
    dnsFailoverDelaySeconds = 30,
    faultClearedAtSeconds = 150,
    dnsFailbackDelaySeconds = 20,
    rtoTargetSeconds = DEFAULT_RTO_SECONDS,
    failbackTargetSeconds = DEFAULT_FAILBACK_SECONDS,
  } = scenario;

  const failoverTime = faultInjectedAtSeconds + dnsFailoverDelaySeconds;
  const failbackTime = faultClearedAtSeconds + dnsFailbackDelaySeconds;
  const end = failbackTime + sampleIntervalSeconds;

  const observations = [];
  for (let t = 0; t <= end; t += sampleIntervalSeconds) {
    let resolvesTo;
    if (t < failoverTime) resolvesTo = "primary";
    else if (t < failbackTime) resolvesTo = "secondary";
    else resolvesTo = "primary";
    observations.push({ t, resolvesTo });
  }

  const result = evaluateFailover(observations, {
    rtoTargetSeconds,
    failbackTargetSeconds,
    primaryRestoredAtSeconds: faultClearedAtSeconds,
  });

  return {
    observations,
    result,
    scenario: {
      faultInjectedAtSeconds,
      dnsFailoverDelaySeconds,
      faultClearedAtSeconds,
      dnsFailbackDelaySeconds,
      rtoTargetSeconds,
      failbackTargetSeconds,
    },
  };
}

/** Human-readable drill summary. */
export function formatReport(result, { mode = "simulate" } = {}) {
  const lines = [];
  lines.push("=== DNS Failover Drill Report ===");
  lines.push(`Mode               : ${mode}`);
  lines.push(`RTO target         : ${result.rtoTargetSeconds}s`);
  lines.push(`Failback target    : ${result.failbackTargetSeconds}s`);
  lines.push(
    `Failover measured  : ${result.failoverSeconds === null ? "never" : `${result.failoverSeconds}s`}`
  );
  lines.push(
    `Failback measured  : ${result.failbackSeconds === null ? "never" : `${result.failbackSeconds}s`}`
  );
  lines.push(`Result             : ${result.passed ? "PASS" : "FAIL"}`);
  if (result.reasons.length > 0) {
    lines.push("Reasons            :");
    for (const reason of result.reasons) lines.push(`  - ${reason}`);
  }
  return lines.join("\n");
}

// ── Live drill (staging only) ──────────────────────────────────────────────

async function resolvesTo(host, expectedIp) {
  try {
    const addresses = await resolve4(host);
    return addresses.includes(expectedIp);
  } catch {
    return false;
  }
}

async function pollUntil(host, expectedIp, deadline, { label, sampleIntervalSeconds }) {
  const startedAt = Date.now();
  while (Date.now() < deadline) {
    if (await resolvesTo(host, expectedIp)) {
      return Math.round((Date.now() - startedAt) / 1000);
    }
    await new Promise((resolve) => setTimeout(resolve, sampleIntervalSeconds * 1000));
  }
  return null;
}

async function runLiveDrill(options) {
  const {
    host,
    controlUrl,
    primaryIp,
    secondaryIp,
    environment,
    rtoTargetSeconds,
    failbackTargetSeconds,
    sampleIntervalSeconds,
  } = options;

  if (environment !== "staging") {
    throw new Error("Refusing live drill: --environment must be staging");
  }
  if (!host || !controlUrl || !primaryIp || !secondaryIp) {
    throw new Error(
      "Live drill requires --host, --control-url, --primary-ip and --secondary-ip"
    );
  }

  const startedAt = Date.now();
  const restore = async () => {
    try {
      await fetch(`${controlUrl.replace(/\/$/, "")}/restore`, { method: "POST" });
    } catch {
      // best effort — the trap must not mask the original failure
    }
  };

  try {
    await fetch(`${controlUrl.replace(/\/$/, "")}/block-health-check`, { method: "POST" });

    const failoverSeconds = await pollUntil(
      host,
      secondaryIp,
      startedAt + (rtoTargetSeconds + 120) * 1000,
      { label: "failover", sampleIntervalSeconds }
    );

    let failbackSeconds = null;
    if (failoverSeconds !== null) {
      await restore();
      const failbackStartedAt = Date.now();
      const elapsed = await pollUntil(
        host,
        primaryIp,
        failbackStartedAt + (failbackTargetSeconds + 120) * 1000,
        { label: "failback", sampleIntervalSeconds }
      );
      failbackSeconds = elapsed;
    }

    const observations = [
      { t: 0, resolvesTo: "primary" },
      { t: failoverSeconds ?? rtoTargetSeconds + 120, resolvesTo: failoverSeconds === null ? "primary" : "secondary" },
      { t: (failoverSeconds ?? 0) + (failbackSeconds ?? failbackTargetSeconds + 120), resolvesTo: failbackSeconds === null ? "secondary" : "primary" },
    ];

    return evaluateFailover(observations, {
      rtoTargetSeconds,
      failbackTargetSeconds,
      primaryRestoredAtSeconds: failoverSeconds,
    });
  } finally {
    await restore();
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const options = {
    mode: "simulate",
    rtoTargetSeconds: DEFAULT_RTO_SECONDS,
    failbackTargetSeconds: DEFAULT_FAILBACK_SECONDS,
    sampleIntervalSeconds: DEFAULT_SAMPLE_INTERVAL_SECONDS,
    jsonOut: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--simulate":
        options.mode = "simulate";
        break;
      case "--host":
        options.host = argv[++i];
        options.mode = "live";
        break;
      case "--control-url":
        options.controlUrl = argv[++i];
        break;
      case "--primary-ip":
        options.primaryIp = argv[++i];
        break;
      case "--secondary-ip":
        options.secondaryIp = argv[++i];
        break;
      case "--environment":
        options.environment = argv[++i];
        break;
      case "--rto":
        options.rtoTargetSeconds = Number(argv[++i]);
        break;
      case "--failback":
        options.failbackTargetSeconds = Number(argv[++i]);
        break;
      case "--interval":
        options.sampleIntervalSeconds = Number(argv[++i]);
        break;
      case "--json-out":
        options.jsonOut = argv[++i];
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown option: ${arg}`);
        }
    }
  }

  options.environment = options.environment ?? process.env.DNS_FAILOVER_ENVIRONMENT ?? "";
  options.host = options.host ?? process.env.DNS_FAILOVER_HOST;
  options.controlUrl = options.controlUrl ?? process.env.DNS_FAILOVER_CONTROL_URL;
  options.primaryIp = options.primaryIp ?? process.env.DNS_FAILOVER_PRIMARY_IP;
  options.secondaryIp = options.secondaryIp ?? process.env.DNS_FAILOVER_SECONDARY_IP;

  return options;
}

const HELP = `DNS failover drill

Usage:
  node scripts/dns-failover-drill.mjs --simulate [--rto 120] [--json-out file]
  node scripts/dns-failover-drill.mjs --host <h> --control-url <url> \\
    --primary-ip <ip> --secondary-ip <ip> --environment staging [--rto 120]

Options:
  --simulate           Run the deterministic simulation (default).
  --host               Public hostname to poll (enables live mode).
  --control-url        Staging control endpoint exposing POST /block-health-check and /restore.
  --primary-ip         IP the hostname should resolve to when healthy.
  --secondary-ip       IP the hostname should resolve to during failover.
  --environment        Must be "staging" for a live drill.
  --rto                Failover RTO target in seconds (default ${DEFAULT_RTO_SECONDS}).
  --failback           Failback target in seconds (default ${DEFAULT_FAILBACK_SECONDS}).
  --interval           DNS poll interval in seconds (default ${DEFAULT_SAMPLE_INTERVAL_SECONDS}).
  --json-out           Write the result JSON to this path.
  -h, --help           Show this help.
`;

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(2);
  }

  if (options.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  let result;
  try {
    if (options.mode === "live") {
      result = await runLiveDrill(options);
    } else {
      result = simulateFailoverDrill({
        sampleIntervalSeconds: options.sampleIntervalSeconds,
        rtoTargetSeconds: options.rtoTargetSeconds,
        failbackTargetSeconds: options.failbackTargetSeconds,
      }).result;
    }
  } catch (error) {
    console.error(`✗ Drill failed to run: ${error.message}`);
    process.exit(2);
  }

  console.log(formatReport(result, { mode: options.mode }));

  const artifact = {
    mode: options.mode,
    timestamp: new Date().toISOString(),
    host: options.host ?? null,
    environment: options.environment || null,
    ...result,
  };
  if (options.jsonOut) {
    fs.writeFileSync(options.jsonOut, `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(`\nWrote ${options.jsonOut}`);
  }

  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
