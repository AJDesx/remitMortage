#!/usr/bin/env node
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

// Generates the SLO burn-rate Prometheus rules and the Grafana error-budget
// dashboard from devops/slo/slos.json.
//
//   node scripts/generate-slo-artifacts.mjs           # write files
//   node scripts/generate-slo-artifacts.mjs --check   # fail if files are stale

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DASHBOARD_PATH,
  RULES_PATH,
  generateRules,
  loadSpec,
  renderDashboard,
} from "./slo-lib.mjs";

export function renderAll() {
  const spec = loadSpec();
  return [
    [RULES_PATH, generateRules(spec)],
    [DASHBOARD_PATH, renderDashboard(spec)],
  ];
}

function main() {
  const check = process.argv.includes("--check");
  let stale = false;

  for (const [file, content] of renderAll()) {
    const rel = path.relative(process.cwd(), file);
    if (check) {
      const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
      if (current !== content) {
        stale = true;
        console.error(`STALE: ${rel} does not match devops/slo/slos.json`);
      }
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      console.log(`wrote ${rel}`);
    }
  }

  if (stale) {
    console.error("Run: node scripts/generate-slo-artifacts.mjs");
    process.exit(1);
  }
  if (check) console.log("SLO artifacts are up to date.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
