#!/usr/bin/env node
// Reports existing AWS resources that are missing the required cost-allocation
// tags (Service, Environment, Owner, CostCenter). Companion to the Terraform
// plan policy in devops/policy/tags, which only guards *new* changes.
//
// Usage:
//   node scripts/report-untagged-resources.mjs [--region us-east-1]
//        [--format markdown|json] [--output <file>] [--fail-on-untagged]
//   node scripts/report-untagged-resources.mjs --input resources.json   # offline
//
// Data source: Resource Groups Tagging API `get-resources`. Resources the API
// does not index (a few services never surface fully-untagged resources) are
// out of scope; see docs/COST_ALLOCATION_TAG_POLICY.md.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const REQUIRED_TAGS = ["Service", "Environment", "Owner", "CostCenter"];

/** Tags are case-sensitive in AWS; accept only exact keys with a non-blank value. */
export function missingTags(tagList, required = REQUIRED_TAGS) {
  const present = new Map((tagList ?? []).map((t) => [t.Key, t.Value]));
  return required.filter((key) => {
    const value = present.get(key);
    return typeof value !== "string" || value.trim() === "";
  });
}

/** @param resources Tagging API `ResourceTagMappingList` entries. */
export function findUntagged(resources, required = REQUIRED_TAGS) {
  return resources
    .map((r) => ({
      arn: r.ResourceARN,
      service: serviceOf(r.ResourceARN),
      missing: missingTags(r.Tags, required),
    }))
    .filter((r) => r.missing.length > 0)
    .sort((a, b) => a.arn.localeCompare(b.arn));
}

export function serviceOf(arn) {
  const parts = String(arn).split(":");
  return parts[0] === "arn" && parts[2] ? parts[2] : "unknown";
}

export function summarize(untagged, total) {
  const byService = {};
  for (const r of untagged) byService[r.service] = (byService[r.service] ?? 0) + 1;
  return { total, untagged: untagged.length, compliant: total - untagged.length, byService };
}

export function renderMarkdown(untagged, total, required = REQUIRED_TAGS) {
  const s = summarize(untagged, total);
  const lines = [
    "# Untagged AWS resources",
    "",
    `Required tags: ${required.map((t) => `\`${t}\``).join(", ")}`,
    "",
    `Scanned **${s.total}** resources: **${s.compliant}** compliant, **${s.untagged}** missing one or more required tags.`,
    "",
  ];
  if (untagged.length === 0) {
    lines.push("All scanned resources carry the required tags.");
    return lines.join("\n") + "\n";
  }
  lines.push("| Service | Untagged |", "| --- | --- |");
  for (const [svc, n] of Object.entries(s.byService).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    lines.push(`| ${svc} | ${n} |`);
  }
  lines.push("", "| Resource | Missing tags |", "| --- | --- |");
  for (const r of untagged) lines.push(`| \`${r.arn}\` | ${r.missing.join(", ")} |`);
  return lines.join("\n") + "\n";
}

function fetchAllResources(region) {
  const resources = [];
  let token;
  do {
    const args = ["resourcegroupstaggingapi", "get-resources", "--region", region, "--output", "json"];
    if (token) args.push("--pagination-token", token);
    const page = JSON.parse(execFileSync("aws", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
    resources.push(...(page.ResourceTagMappingList ?? []));
    token = page.PaginationToken || undefined;
  } while (token);
  return resources;
}

function parseArgs(argv) {
  const opts = { region: process.env.AWS_REGION || "us-east-1", format: "markdown" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--region") opts.region = argv[++i];
    else if (a === "--format") opts.format = argv[++i];
    else if (a === "--output") opts.output = argv[++i];
    else if (a === "--input") opts.input = argv[++i];
    else if (a === "--fail-on-untagged") opts.failOnUntagged = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!["markdown", "json"].includes(opts.format)) throw new Error(`unknown format: ${opts.format}`);
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const resources = opts.input
    ? JSON.parse(readFileSync(opts.input, "utf8")).ResourceTagMappingList
    : fetchAllResources(opts.region);
  const untagged = findUntagged(resources);
  const out =
    opts.format === "json"
      ? JSON.stringify({ summary: summarize(untagged, resources.length), untagged }, null, 2) + "\n"
      : renderMarkdown(untagged, resources.length);
  if (opts.output) writeFileSync(opts.output, out);
  else process.stdout.write(out);
  if (opts.failOnUntagged && untagged.length > 0) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
