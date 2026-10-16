#!/usr/bin/env node
// Fails when an AWS provider block in the repo's Terraform does not set
// `default_tags`. Static companion to the plan policy in devops/policy/tags:
// it catches a new root module or provider alias before a plan is needed.
//
// Usage: node scripts/check-terraform-default-tags.mjs [root-dir ...]

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set([".git", ".terraform", "node_modules"]);

/** Returns the body of each `provider "aws" { ... }` block (brace-matched). */
export function awsProviderBlocks(source) {
  const blocks = [];
  const re = /provider\s+"aws"\s*\{/g;
  let m;
  while ((m = re.exec(source))) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
      i++;
    }
    blocks.push(source.slice(re.lastIndex, i - 1));
  }
  return blocks;
}

export function providersMissingDefaultTags(source) {
  return awsProviderBlocks(source).filter((body) => !/\bdefault_tags\s*\{/.test(body));
}

function* tfFiles(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* tfFiles(p);
    else if (name.endsWith(".tf")) yield p;
  }
}

function main() {
  const roots = process.argv.slice(2);
  if (roots.length === 0) roots.push("devops", "infrastructure");
  const failures = [];
  for (const root of roots) {
    for (const file of tfFiles(root)) {
      const bad = providersMissingDefaultTags(readFileSync(file, "utf8"));
      if (bad.length) failures.push(`${file}: ${bad.length} aws provider block(s) without default_tags`);
    }
  }
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log("all aws provider blocks set default_tags");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
