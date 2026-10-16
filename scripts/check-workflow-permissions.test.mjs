import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { auditRepo } from "./check-workflow-permissions.mjs";

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-permissions-"));
  fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  return dir;
}

function writeWorkflow(repo, name, contents) {
  fs.writeFileSync(path.join(repo, ".github", "workflows", name), contents);
}

test("flags a job with no top-level or job-level permissions", () => {
  const repo = makeRepo();
  writeWorkflow(
    repo,
    "no-perms.yml",
    [
      "name: No Perms",
      "on: push",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "",
    ].join("\n")
  );

  const { errors } = auditRepo(repo);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, path.join(".github", "workflows", "no-perms.yml"));
  assert.deepEqual(errors[0].jobs, ["build"]);
});

test("accepts a top-level permissions block covering every job", () => {
  const repo = makeRepo();
  writeWorkflow(
    repo,
    "top-level.yml",
    [
      "name: Top Level",
      "on: push",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "",
    ].join("\n")
  );

  const { errors } = auditRepo(repo);
  assert.equal(errors.length, 0);
});

test("accepts job-level permissions even without a top-level block", () => {
  const repo = makeRepo();
  writeWorkflow(
    repo,
    "job-level.yml",
    [
      "name: Job Level",
      "on: push",
      "jobs:",
      "  analyze:",
      "    runs-on: ubuntu-latest",
      "    permissions:",
      "      # comment lines inside the block must not truncate parsing",
      "      security-events: write",
      "      contents: read",
      "    steps:",
      "      - uses: github/codeql-action/analyze@v3",
      "",
    ].join("\n")
  );

  const { errors, warnings } = auditRepo(repo);
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 0);
});

test("warns when a write scope has no matching usage step", () => {
  const repo = makeRepo();
  writeWorkflow(
    repo,
    "unused-write.yml",
    [
      "name: Unused Write",
      "on: push",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    permissions:",
      "      contents: read",
      "      issues: write",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - run: echo hi",
      "",
    ].join("\n")
  );

  const { errors, warnings } = auditRepo(repo);
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].scope, "issues");
  assert.equal(warnings[0].job, "build");
});

test("does not warn when a write scope matches a known usage step", () => {
  const repo = makeRepo();
  writeWorkflow(
    repo,
    "used-write.yml",
    [
      "name: Used Write",
      "on: push",
      "jobs:",
      "  open-issue:",
      "    runs-on: ubuntu-latest",
      "    permissions:",
      "      issues: write",
      "    steps:",
      "      - uses: actions/github-script@v7",
      "        with:",
      "          script: |",
      "            await github.rest.issues.create({});",
      "",
    ].join("\n")
  );

  const { errors, warnings } = auditRepo(repo);
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 0);
});
