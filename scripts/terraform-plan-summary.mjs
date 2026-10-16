#!/usr/bin/env node
// Terraform Plan Summary Formatter
//
// Turns `terraform show -json <plan>` output into a concise Markdown summary
// for a single, continuously-updated pull request comment. Destructive
// actions (destroy / replace) and security-sensitive resources (IAM,
// networking, secrets, KMS) are listed first.
//
// The summary only ever contains resource addresses, resource types, action
// kinds and the *names* of changed attributes. Attribute values are never
// printed, and free-form text (plan errors) is scrubbed for secret-looking
// content before it is included.
//
// Usage:
//   node scripts/terraform-plan-summary.mjs --out summary.md \
//     --module devops=plan-devops.json \
//     --failed devops/terraform=plan-multiregion.log
//
// See docs/TERRAFORM_PLAN_PR_COMMENT.md.

import fs from "node:fs";
import process from "node:process";

export const COMMENT_MARKER = "<!-- terraform-plan-summary-bot -->";
export const MAX_COMMENT_CHARS = 60000;
const MAX_ERROR_LINES = 40;
const MAX_ROWS_PER_SECTION = 50;
const MAX_ATTRS_SHOWN = 8;

const SECURITY_SENSITIVE_PATTERNS = [
  /^aws_iam_/,
  /^aws_security_group/,
  /^aws_vpc_security_group_/,
  /^aws_network_acl/,
  /^aws_(vpc|subnet|route|route_table|internet_gateway|nat_gateway|vpc_endpoint|vpc_peering)/,
  /^aws_wafv2_/,
  /^aws_secretsmanager_/,
  /^aws_ssm_parameter$/,
  /^aws_kms_/,
  /^aws_acm_/,
  /^aws_s3_bucket_(policy|public_access_block|acl|server_side_encryption)/,
  /^aws_lb_listener/,
  /^aws_cloudfront_(origin_access|distribution)/,
  /^aws_db_(instance|subnet_group|parameter_group)$/,
];

const ACTION_LABELS = {
  create: "add",
  update: "change",
  delete: "destroy",
  replace: "replace",
};

// ── Sanitising ───────────────────────────────────────────────────────────

const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;
const SECRET_TEXT_PATTERNS = [
  /AKIA[0-9A-Z]{16}/g,
  /ASIA[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g,
];
const KEY_VALUE_SECRET_PATTERN =
  /((?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_-]*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi;

/** Removes ANSI colours and anything that looks like a credential from free text. */
export function scrubText(text) {
  let out = String(text ?? "").replace(ANSI_PATTERN, "");
  out = out.replace(KEY_VALUE_SECRET_PATTERN, "$1[REDACTED]");
  for (const pattern of SECRET_TEXT_PATTERNS) out = out.replace(pattern, "[REDACTED]");
  return out;
}

/** Makes a value safe to embed inside inline-code in a Markdown table cell. */
function inlineCode(text) {
  const safe = String(text).replace(/[`|\r\n]/g, "").slice(0, 200);
  return `\`${safe}\``;
}

// ── Plan analysis ────────────────────────────────────────────────────────

/** Collapses Terraform's action array to one of create/update/delete/replace/read/noop. */
export function classifyActions(actions) {
  const list = Array.isArray(actions) ? actions : [];
  if (list.includes("delete") && list.includes("create")) return "replace";
  if (list.includes("delete")) return "delete";
  if (list.includes("create")) return "create";
  if (list.includes("update")) return "update";
  if (list.includes("read")) return "read";
  return "noop";
}

export function isSecuritySensitiveType(type) {
  return SECURITY_SENSITIVE_PATTERNS.some((pattern) => pattern.test(String(type ?? "")));
}

function isTruthyMarker(marker, key) {
  if (marker === true) return true;
  return Boolean(marker && typeof marker === "object" && marker[key]);
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Names of attributes that change, never their values. Attributes marked
 * sensitive are tagged so reviewers know a secret is involved without seeing it.
 */
export function changedAttributeNames(change) {
  const before = change.before && typeof change.before === "object" ? change.before : {};
  const after = change.after && typeof change.after === "object" ? change.after : {};
  const unknown = change.after_unknown && typeof change.after_unknown === "object" ? change.after_unknown : {};
  const names = new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(unknown)]);
  const changed = [];

  for (const name of [...names].sort()) {
    const sensitive =
      isTruthyMarker(change.before_sensitive, name) || isTruthyMarker(change.after_sensitive, name);
    const differs = !sameValue(before[name], after[name]) || Boolean(unknown[name]);
    if (differs) changed.push(sensitive ? `${name} (sensitive)` : name);
  }
  return changed;
}

/** Extracts the reviewable facts from a parsed `terraform show -json` plan. */
export function analysePlan(plan) {
  const changes = [];
  for (const rc of plan?.resource_changes ?? []) {
    const kind = classifyActions(rc.change?.actions);
    if (kind === "noop" || kind === "read") continue;
    changes.push({
      address: rc.address,
      type: rc.type,
      kind,
      securitySensitive: isSecuritySensitiveType(rc.type),
      reason: rc.action_reason ?? null,
      attributes: kind === "update" || kind === "replace" ? changedAttributeNames(rc.change) : [],
    });
  }

  const counts = { create: 0, update: 0, delete: 0, replace: 0 };
  for (const change of changes) counts[change.kind] += 1;

  return {
    changes,
    counts,
    destructive: changes.filter((c) => c.kind === "delete" || c.kind === "replace"),
    sensitive: changes.filter((c) => c.securitySensitive),
  };
}

// ── Markdown rendering ───────────────────────────────────────────────────

function describeCounts(counts) {
  return (
    `**${counts.create}** to add, **${counts.update}** to change, ` +
    `**${counts.delete}** to destroy, **${counts.replace}** to replace`
  );
}

function renderChangeRow(change) {
  const label = ACTION_LABELS[change.kind];
  const flags = [];
  if (change.securitySensitive) flags.push("🔐 security");
  if (change.reason) flags.push(change.reason.replace(/_/g, " "));
  const shown = change.attributes.slice(0, MAX_ATTRS_SHOWN).join(", ");
  const extra = change.attributes.length > MAX_ATTRS_SHOWN ? ` +${change.attributes.length - MAX_ATTRS_SHOWN} more` : "";
  const attrs = change.attributes.length > 0 ? `${shown}${extra}` : "";
  return `| ${label} | ${inlineCode(change.address)} | ${flags.join("; ")} | ${attrs.replace(/[|\r\n]/g, " ")} |`;
}

function renderTable(changes) {
  const rows = changes.slice(0, MAX_ROWS_PER_SECTION).map(renderChangeRow);
  const lines = ["| Action | Resource | Flags | Changed attributes |", "| --- | --- | --- | --- |", ...rows];
  if (changes.length > MAX_ROWS_PER_SECTION) {
    lines.push("", `_…and ${changes.length - MAX_ROWS_PER_SECTION} more not shown._`);
  }
  return lines.join("\n");
}

function renderFailure(name, log) {
  const scrubbed = scrubText(log).replace(/```/g, "'''").trim().split(/\r?\n/);
  const tail = scrubbed.slice(-MAX_ERROR_LINES);
  const truncated = scrubbed.length > tail.length ? `_Showing the last ${tail.length} lines._\n\n` : "";
  return [
    `### ❌ ${inlineCode(name)} — plan failed`,
    "",
    "`terraform plan` did not complete, so no change summary is available for this module. " +
      "The full log is in the workflow run's artifacts.",
    "",
    truncated + "```text",
    tail.join("\n"),
    "```",
  ].join("\n");
}

function renderModule(module) {
  if (module.error !== undefined) return renderFailure(module.name, module.error);

  const analysis = analysePlan(module.plan);
  const { changes, counts, destructive, sensitive } = analysis;
  const lines = [`### ${inlineCode(module.name)}`, ""];

  if (changes.length === 0) {
    lines.push("✅ No infrastructure changes.");
    return lines.join("\n");
  }

  lines.push(describeCounts(counts), "");
  if (destructive.length > 0) {
    lines.push(`> ⚠️ **${destructive.length} destructive change(s)** — resources will be destroyed or replaced.`, "");
  }
  if (sensitive.length > 0) {
    lines.push(`> 🔐 **${sensitive.length} security-sensitive change(s)** — IAM, networking, secrets or encryption.`, "");
  }

  if (destructive.length > 0) {
    lines.push("#### ⚠️ Destructive changes", "", renderTable(destructive), "");
  }
  const sensitiveOnly = sensitive.filter((c) => !destructive.includes(c));
  if (sensitiveOnly.length > 0) {
    lines.push("#### 🔐 Security-sensitive changes", "", renderTable(sensitiveOnly), "");
  }
  const rest = changes.filter((c) => !destructive.includes(c) && !c.securitySensitive);
  if (rest.length > 0) {
    lines.push(
      `<details><summary>Other changes (${rest.length})</summary>`,
      "",
      renderTable(rest),
      "",
      "</details>",
    );
  }
  return lines.join("\n").trimEnd();
}

/**
 * Builds the full comment body for a list of modules, each either
 * `{ name, plan }` or `{ name, error }`.
 */
export function formatSummary(modules, { runUrl, sha } = {}) {
  const analysed = modules.map((m) => (m.error === undefined ? analysePlan(m.plan) : null));
  const failed = modules.filter((m) => m.error !== undefined).length;
  const destructive = analysed.reduce((n, a) => n + (a ? a.destructive.length : 0), 0);
  const sensitive = analysed.reduce((n, a) => n + (a ? a.sensitive.length : 0), 0);

  const lines = [COMMENT_MARKER, "## Terraform plan summary", ""];
  if (failed > 0) lines.push(`> ❌ **${failed} module(s) failed to plan.** Fix the errors below before merging.`, "");
  if (destructive > 0) lines.push(`> ⚠️ **${destructive} destructive change(s)** across all modules.`, "");
  if (sensitive > 0) lines.push(`> 🔐 **${sensitive} security-sensitive change(s)** across all modules.`, "");
  if (modules.length === 0) lines.push("No Terraform modules were affected by this pull request.", "");

  for (const module of modules) lines.push(renderModule(module), "");

  const footer = [];
  if (sha) footer.push(`Commit \`${String(sha).slice(0, 12).replace(/[^0-9a-f]/gi, "")}\``);
  if (runUrl) footer.push(`[workflow run](${runUrl})`);
  footer.push("Values are never shown — only resource names and the names of changed attributes.");
  lines.push("---", `<sub>${footer.join(" · ")}</sub>`);

  let body = lines.join("\n");
  if (body.length > MAX_COMMENT_CHARS) {
    body =
      body.slice(0, MAX_COMMENT_CHARS - 200).trimEnd() +
      "\n\n_…summary truncated; see the workflow run for the full plan._\n";
  }
  return body;
}

// ── CLI ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = { modules: [], out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      options.out = argv[(i += 1)];
    } else if (arg === "--module" || arg === "--failed") {
      const spec = argv[(i += 1)] ?? "";
      const eq = spec.indexOf("=");
      if (eq < 1) throw new Error(`${arg} expects name=path, got "${spec}"`);
      options.modules.push({ failed: arg === "--failed", name: spec.slice(0, eq), file: spec.slice(eq + 1) });
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function loadModule({ failed, name, file }) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    return { name, error: `Could not read ${failed ? "plan log" : "plan JSON"} (${err.code ?? err.message}).` };
  }
  if (failed) return { name, error: raw };
  try {
    return { name, plan: JSON.parse(raw) };
  } catch {
    return { name, error: "Plan output was not valid JSON, so it could not be summarised." };
  }
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const summary = formatSummary(options.modules.map(loadModule), {
    runUrl: process.env.RUN_URL,
    sha: process.env.HEAD_SHA,
  });
  if (options.out) fs.writeFileSync(options.out, summary);
  else process.stdout.write(summary);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
