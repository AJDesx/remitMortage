#!/usr/bin/env node
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT
//
// check-workflow-permissions.mjs
//
// Least-privilege audit for GitHub Actions workflows (docs/WORKFLOW_PERMISSIONS_AUDIT.md).
//
// A workflow's GITHUB_TOKEN defaults to broad read/write permissions unless a
// `permissions:` block is declared. This script scans every file in
// .github/workflows/ and flags two classes of finding:
//
//   ERROR   — the workflow has no top-level `permissions:` block AND at
//             least one of its jobs has no job-level `permissions:` block
//             either, so that job runs with the default (overly broad)
//             token permissions. Fails CI.
//
//   WARNING — a job (or the workflow default) grants a write scope
//             (contents, packages, issues, pull-requests, id-token,
//             security-events) but no step in that job matches a known
//             usage pattern for that scope. This is a heuristic — it does
//             not fail CI, it just asks a human to confirm the grant is
//             still needed.
//
// Exit codes
//   0 — no ERROR findings (warnings may still be printed)
//   1 — one or more ERROR findings

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const WRITE_SCOPES = [
  "contents",
  "packages",
  "issues",
  "pull-requests",
  "id-token",
  "security-events",
  "actions",
  "deployments",
  "checks",
  "statuses",
];

// Heuristics: for a given write scope, the step patterns that plausibly
// justify granting it. Matched against the raw text of a job's steps.
const SCOPE_USAGE_PATTERNS = {
  contents: [
    /git push/i,
    /git commit/i,
    /action-gh-release/i,
    /create-pull-request/i,
    /git-auto-commit-action/i,
    /gh pr merge/i,
    /actions\/checkout@/i, // read usage; write grants still need a stronger signal below
  ],
  packages: [/docker push/i, /docker\/login-action/i, /docker\/build-push-action/i, /packages\.npmjs|npm publish/i],
  issues: [/issues\.create/i, /issues\.update/i, /issues\.createComment/i, /gh issue/i, /github-script/i],
  "pull-requests": [
    /create-pull-request/i,
    /pulls\.create/i,
    /pulls\.update/i,
    /pulls\.createReview/i,
    /gh pr /i,
    /github-script/i,
    /infracost comment/i,
  ],
  "id-token": [/configure-aws-credentials/i, /cosign/i, /azure\/login/i, /google-github-actions\/auth/i],
  "security-events": [/upload-sarif/i, /codeql-action/i],
  actions: [/codeql-action/i, /upload-sarif/i],
  deployments: [/deployments\.create/i, /create-deployment/i],
  checks: [/checks\.create/i, /checks\.update/i],
  statuses: [/statuses\.create/i, /createCommitStatus/i],
};

// contents:write specifically needs a *write* signal, not just checkout.
const CONTENTS_WRITE_PATTERNS = SCOPE_USAGE_PATTERNS.contents.filter(
  (re) => re.source !== /actions\/checkout@/i.source
);

function listWorkflowFiles(workflowsDir) {
  if (!fs.existsSync(workflowsDir)) return [];
  return fs
    .readdirSync(workflowsDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => path.join(workflowsDir, f));
}

// Splits a workflow file's source into { topLevelPermissions, jobs }, where
// jobs is an array of { name, startLine, text, hasOwnPermissions, grantedScopes }.
function parseWorkflow(src) {
  const lines = src.split("\n");

  const topLevelPermsIdx = lines.findIndex((l) => /^permissions:\s*$/.test(l) || /^permissions:\s*\{/.test(l));
  const topLevelGranted = topLevelPermsIdx === -1 ? [] : readPermissionBlock(lines, topLevelPermsIdx);

  const jobsIdx = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const jobs = [];
  if (jobsIdx !== -1) {
    const jobHeaderRe = /^  ([A-Za-z0-9_.-]+):\s*$/;
    const nextTopLevelRe = /^[A-Za-z]/;

    let i = jobsIdx + 1;
    let current = null;
    const flush = (endLine) => {
      if (current) {
        current.text = lines.slice(current.startLine, endLine).join("\n");
        current.hasOwnPermissions = /^ {4}permissions:\s*$/m.test(current.text) || /^ {4}permissions:\s*\{/m.test(current.text);
        current.grantedScopes = current.hasOwnPermissions
          ? readPermissionBlock(lines, current.startLine + current.text.split("\n").findIndex((l) => /^ {4}permissions:/.test(l)))
          : [];
        jobs.push(current);
      }
    };

    for (; i < lines.length; i++) {
      const line = lines[i];
      if (nextTopLevelRe.test(line)) {
        flush(i);
        current = null;
        continue;
      }
      const m = line.match(jobHeaderRe);
      if (m) {
        flush(i);
        current = { name: m[1], startLine: i };
      }
    }
    flush(lines.length);
  }

  return { topLevelGranted, hasTopLevelPermissions: topLevelPermsIdx !== -1, jobs };
}

// Reads the indented `scope: value` lines following a `permissions:` header.
function readPermissionBlock(lines, headerIdx) {
  const granted = [];
  const headerIndent = lines[headerIdx].match(/^(\s*)/)[1].length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent <= headerIndent) break;
    const m = line.match(/^\s*([a-z-]+):\s*(read|write|none)\s*(#.*)?$/);
    if (m) granted.push({ scope: m[1], level: m[2] });
    else break;
  }
  return granted;
}

function auditFile(filePath, repoRoot) {
  const rel = path.relative(repoRoot, filePath);
  const src = fs.readFileSync(filePath, "utf8");
  const { topLevelGranted, hasTopLevelPermissions, jobs } = parseWorkflow(src);

  const errors = [];
  const warnings = [];

  if (jobs.length === 0) {
    // No jobs found — nothing to audit structurally, skip.
    return { errors, warnings };
  }

  const jobsWithoutOwnPermissions = jobs.filter((j) => !j.hasOwnPermissions);
  if (!hasTopLevelPermissions && jobsWithoutOwnPermissions.length > 0) {
    errors.push({
      file: rel,
      jobs: jobsWithoutOwnPermissions.map((j) => j.name),
      detail:
        `No top-level permissions: block, and job(s) ` +
        `${jobsWithoutOwnPermissions.map((j) => `"${j.name}"`).join(", ")} ` +
        `declare no job-level permissions: block either — they run with the ` +
        `default (broad) GITHUB_TOKEN permissions.`,
      fix:
        `Add a top-level \`permissions:\n  contents: read\` block (or a job-level ` +
        `one on each affected job) scoped to what each job's steps actually need.`,
    });
  }

  // WARNING pass: for every scope granted write, at top level or per-job,
  // confirm the job(s) it applies to actually reference a matching usage.
  for (const scope of WRITE_SCOPES) {
    const topGrant = topLevelGranted.find((g) => g.scope === scope && g.level === "write");
    for (const job of jobs) {
      const grant = job.grantedScopes.find((g) => g.scope === scope && g.level === "write") ?? (job.hasOwnPermissions ? null : topGrant);
      if (!grant) continue;
      const patterns = scope === "contents" ? CONTENTS_WRITE_PATTERNS : SCOPE_USAGE_PATTERNS[scope] ?? [];
      const matched = patterns.some((re) => re.test(job.text));
      if (!matched) {
        warnings.push({
          file: rel,
          job: job.name,
          scope,
          detail: `Job "${job.name}" is granted "${scope}: write" but no step matches a known usage pattern for it.`,
          fix: `Confirm "${scope}: write" is still needed for "${job.name}"; if not, drop it to "read" or remove it.`,
        });
      }
    }
  }

  return { errors, warnings };
}

export function auditRepo(repoRoot) {
  const workflowsDir = path.join(repoRoot, ".github", "workflows");
  const files = listWorkflowFiles(workflowsDir);
  const errors = [];
  const warnings = [];
  for (const file of files) {
    const result = auditFile(file, repoRoot);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }
  return { filesScanned: files.length, errors, warnings };
}

function main() {
  const repoRoot = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();

  if (!fs.existsSync(repoRoot)) {
    console.error(`Directory not found: ${repoRoot}`);
    process.exit(1);
  }

  const { filesScanned, errors, warnings } = auditRepo(repoRoot);

  if (filesScanned === 0) {
    console.log("No workflow files found under .github/workflows — nothing to check.");
    process.exit(0);
  }

  if (warnings.length > 0) {
    console.warn(`⚠ ${warnings.length} permission grant(s) with no matching usage step found:\n`);
    for (const w of warnings) {
      console.warn(`  File  : ${w.file}`);
      console.warn(`  Job   : ${w.job}`);
      console.warn(`  Scope : ${w.scope}: write`);
      console.warn(`  Fix   : ${w.fix}`);
      console.warn("");
    }
  }

  if (errors.length === 0) {
    console.log(
      `✓ Workflow permissions check passed — ${filesScanned} file(s) scanned, every job has explicit least-privilege permissions.`
    );
    process.exit(0);
  }

  console.error(`✗ Workflow permissions check FAILED — ${errors.length} file(s) with missing permissions:\n`);
  for (const e of errors) {
    console.error(`  File  : ${e.file}`);
    console.error(`  Jobs  : ${e.jobs.join(", ")}`);
    console.error(`  Detail: ${e.detail}`);
    console.error(`  Fix   : ${e.fix}`);
    console.error("");
  }

  console.error(
    "Policy: every workflow must declare least-privilege permissions, either as a\n" +
    "top-level `permissions:` block or explicitly on every job.\n" +
    "See docs/WORKFLOW_PERMISSIONS_AUDIT.md for the full policy and how to fix each finding."
  );

  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
