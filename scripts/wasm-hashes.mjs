#!/usr/bin/env node
// WASM hash manifest tooling for reproducible contract builds.
//
// Commands:
//   generate <wasmDir> --commit <sha> [--toolchain <str>] --out <json> [--sums <file>]
//       Hash every *.wasm in <wasmDir> and write a manifest (+ optional
//       sha256sum-style file).
//   compare <manifestA.json> <manifestB.json>
//       Exit 0 when both manifests hold identical hashes for identical
//       contract sets, 1 otherwise (prints a readable table).
//   lookup <manifest.json> <contract>
//       Print the sha256 recorded for <contract> (e.g. "escrow").
//
// See docs/REPRODUCIBLE_BUILDS.md.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export const MANIFEST_VERSION = 1;

export function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/** "lending_pool.wasm" -> "lending-pool" so names match the Cargo package names. */
export function contractNameFromFile(fileName) {
  return path.basename(fileName, ".wasm").replace(/_/g, "-");
}

export function buildManifest(wasmDir, { commit, toolchain = null } = {}) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) {
    throw new Error(`commit must be a full 40-character SHA, got "${commit}"`);
  }
  const files = fs.readdirSync(wasmDir).filter((f) => f.endsWith(".wasm")).sort();
  if (files.length === 0) throw new Error(`No .wasm files found in ${wasmDir}`);

  const contracts = {};
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(wasmDir, file));
    contracts[contractNameFromFile(file)] = { file, sha256: sha256Hex(bytes), bytes: bytes.length };
  }
  return { version: MANIFEST_VERSION, commit, toolchain, contracts };
}

export function formatSums(manifest) {
  return (
    Object.values(manifest.contracts)
      .map((c) => `${c.sha256}  ${c.file}`)
      .join("\n") + "\n"
  );
}

/** Compares two manifests' contract sets and hashes (commit/toolchain must match too). */
export function compareManifests(a, b) {
  const rows = [];
  const names = [...new Set([...Object.keys(a.contracts), ...Object.keys(b.contracts)])].sort();
  for (const name of names) {
    const left = a.contracts[name]?.sha256 ?? null;
    const right = b.contracts[name]?.sha256 ?? null;
    rows.push({ name, left, right, match: left !== null && left === right });
  }
  const problems = [];
  if (a.commit !== b.commit) problems.push(`commit differs: ${a.commit} vs ${b.commit}`);
  if (a.toolchain !== b.toolchain) problems.push(`toolchain differs: ${a.toolchain} vs ${b.toolchain}`);
  const mismatched = rows.filter((r) => !r.match);
  return { ok: mismatched.length === 0 && problems.length === 0, rows, problems };
}

export function formatComparison({ ok, rows, problems }) {
  const lines = rows.map(
    (r) => `${r.match ? "OK      " : "MISMATCH"}  ${r.name.padEnd(24)} ${r.left ?? "(missing)"}  ${r.right ?? "(missing)"}`,
  );
  for (const problem of problems) lines.push(`ERROR: ${problem}`);
  lines.push(ok ? "\nBuilds are reproducible: all hashes match." : "\nBuilds are NOT reproducible.");
  return lines.join("\n");
}

function readManifest(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function main(argv) {
  const [command, ...args] = argv;
  try {
    if (command === "generate") {
      const manifest = buildManifest(args[0], { commit: flag(args, "--commit"), toolchain: flag(args, "--toolchain") });
      const out = flag(args, "--out");
      if (!out) throw new Error("--out is required");
      fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
      const sums = flag(args, "--sums");
      if (sums) fs.writeFileSync(sums, formatSums(manifest));
      return 0;
    }
    if (command === "compare") {
      const result = compareManifests(readManifest(args[0]), readManifest(args[1]));
      console.log(formatComparison(result));
      return result.ok ? 0 : 1;
    }
    if (command === "lookup") {
      const entry = readManifest(args[0]).contracts[args[1]];
      if (!entry) throw new Error(`Contract "${args[1]}" not found in ${args[0]}`);
      console.log(entry.sha256);
      return 0;
    }
    throw new Error("Usage: wasm-hashes.mjs <generate|compare|lookup> ...");
  } catch (err) {
    console.error(err.message);
    return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
