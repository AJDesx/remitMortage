import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildManifest,
  compareManifests,
  contractNameFromFile,
  formatComparison,
  formatSums,
  sha256Hex,
} from "./wasm-hashes.mjs";

const SHA = "a".repeat(40);

function makeWasmDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wasm-hashes-"));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

test("contractNameFromFile maps wasm file names to cargo package names", () => {
  assert.equal(contractNameFromFile("lending_pool.wasm"), "lending-pool");
  assert.equal(contractNameFromFile("escrow.wasm"), "escrow");
});

test("buildManifest hashes every wasm file and ignores other files", () => {
  const dir = makeWasmDir({ "escrow.wasm": "one", "lending_pool.wasm": "two", "notes.txt": "x" });
  const manifest = buildManifest(dir, { commit: SHA, toolchain: "rustc 1.96.0" });
  assert.deepEqual(Object.keys(manifest.contracts), ["escrow", "lending-pool"]);
  assert.equal(manifest.contracts.escrow.sha256, sha256Hex(Buffer.from("one")));
  assert.equal(manifest.contracts.escrow.bytes, 3);
  assert.equal(manifest.commit, SHA);
});

test("buildManifest rejects a non-SHA commit and an empty directory", () => {
  const dir = makeWasmDir({ "escrow.wasm": "one" });
  assert.throws(() => buildManifest(dir, { commit: "HEAD" }), /40-character SHA/);
  assert.throws(() => buildManifest(makeWasmDir({}), { commit: SHA }), /No \.wasm files/);
});

test("formatSums emits sha256sum-compatible lines", () => {
  const dir = makeWasmDir({ "escrow.wasm": "one" });
  const sums = formatSums(buildManifest(dir, { commit: SHA }));
  assert.equal(sums, `${sha256Hex(Buffer.from("one"))}  escrow.wasm\n`);
});

test("compareManifests passes for identical builds", () => {
  const dir = makeWasmDir({ "escrow.wasm": "one", "milestone.wasm": "two" });
  const a = buildManifest(dir, { commit: SHA, toolchain: "t" });
  const b = buildManifest(dir, { commit: SHA, toolchain: "t" });
  const result = compareManifests(a, b);
  assert.equal(result.ok, true);
  assert.match(formatComparison(result), /reproducible: all hashes match/);
});

test("compareManifests fails when a hash differs", () => {
  const a = buildManifest(makeWasmDir({ "escrow.wasm": "one" }), { commit: SHA, toolchain: "t" });
  const b = buildManifest(makeWasmDir({ "escrow.wasm": "ONE" }), { commit: SHA, toolchain: "t" });
  const result = compareManifests(a, b);
  assert.equal(result.ok, false);
  assert.match(formatComparison(result), /MISMATCH {2}escrow/);
});

test("compareManifests fails when contract sets, commit or toolchain differ", () => {
  const base = buildManifest(makeWasmDir({ "escrow.wasm": "one" }), { commit: SHA, toolchain: "t" });
  const extra = buildManifest(makeWasmDir({ "escrow.wasm": "one", "milestone.wasm": "m" }), { commit: SHA, toolchain: "t" });
  assert.equal(compareManifests(base, extra).ok, false);

  const otherCommit = { ...base, commit: "b".repeat(40) };
  const commitResult = compareManifests(base, otherCommit);
  assert.equal(commitResult.ok, false);
  assert.match(commitResult.problems[0], /commit differs/);

  const otherToolchain = { ...base, toolchain: "u" };
  assert.match(compareManifests(base, otherToolchain).problems[0], /toolchain differs/);
});
