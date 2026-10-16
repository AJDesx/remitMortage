// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import { formatReport, loadAllowlist, loadConfig, unusedAllowlistEntries, type ScanResult } from "./lib";

/** Builds a readable Markdown report from the per-route results and the CI job summary. */
export default async function globalTeardown() {
  const reportDir = path.resolve(__dirname, "..", "a11y-report");
  const resultsDir = path.join(reportDir, "results");
  if (!fs.existsSync(resultsDir)) return;

  const results = fs
    .readdirSync(resultsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(resultsDir, f), "utf8")) as ScanResult);

  const config = loadConfig();
  const allowlist = loadAllowlist();
  const { markdown } = formatReport(results, config, allowlist);
  const unused = unusedAllowlistEntries(results, config, allowlist);
  const notes = unused.length
    ? [
        "",
        "### Unused allowlist entries",
        "",
        "These no longer match any violation and can be removed from `a11y/allowlist.json`:",
        ...unused.map((e) => `- \`${e.ruleId}\` on \`${e.route}\``),
        "",
      ].join("\n")
    : "";

  fs.writeFileSync(path.join(reportDir, "report.md"), markdown + notes);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + notes + "\n");
  }
}
