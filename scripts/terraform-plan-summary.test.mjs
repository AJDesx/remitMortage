import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMENT_MARKER,
  analysePlan,
  changedAttributeNames,
  classifyActions,
  formatSummary,
  isSecuritySensitiveType,
  scrubText,
} from "./terraform-plan-summary.mjs";

const SECRET_VALUE = "hunter2-super-secret-db-password";

const SAMPLE_PLAN = {
  format_version: "1.2",
  resource_changes: [
    {
      address: "aws_s3_bucket.logs",
      type: "aws_s3_bucket",
      change: { actions: ["create"], before: null, after: { bucket: "logs-prod" } },
    },
    {
      address: "aws_db_instance.main",
      type: "aws_db_instance",
      change: {
        actions: ["update"],
        before: { password: "old-secret-value", instance_class: "db.t3.small" },
        after: { password: SECRET_VALUE, instance_class: "db.t3.medium" },
        before_sensitive: { password: true },
        after_sensitive: { password: true },
        after_unknown: {},
      },
    },
    {
      address: "aws_iam_role_policy.task",
      type: "aws_iam_role_policy",
      change: {
        actions: ["update"],
        before: { policy: "{\"old\":true}" },
        after: { policy: "{\"new\":true}" },
      },
    },
    {
      address: "aws_ecs_service.api",
      type: "aws_ecs_service",
      action_reason: "replace_because_cannot_update",
      change: {
        actions: ["delete", "create"],
        before: { name: "api", launch_type: "EC2" },
        after: { name: "api", launch_type: "FARGATE" },
      },
    },
    {
      address: "aws_sns_topic.old",
      type: "aws_sns_topic",
      change: { actions: ["delete"], before: { name: "old" }, after: null },
    },
    {
      address: "aws_security_group.web",
      type: "aws_security_group",
      change: { actions: ["create"], before: null, after: { name: "web" } },
    },
    {
      address: "aws_lambda_function.unchanged",
      type: "aws_lambda_function",
      change: { actions: ["no-op"], before: {}, after: {} },
    },
  ],
};

// ── classification ───────────────────────────────────────────────────────

test("classifyActions maps terraform action arrays to a single kind", () => {
  assert.equal(classifyActions(["create"]), "create");
  assert.equal(classifyActions(["update"]), "update");
  assert.equal(classifyActions(["delete"]), "delete");
  assert.equal(classifyActions(["delete", "create"]), "replace");
  assert.equal(classifyActions(["create", "delete"]), "replace");
  assert.equal(classifyActions(["no-op"]), "noop");
  assert.equal(classifyActions(["read"]), "read");
  assert.equal(classifyActions(undefined), "noop");
});

test("isSecuritySensitiveType flags IAM, networking, secrets and KMS only", () => {
  for (const type of ["aws_iam_role", "aws_security_group_rule", "aws_vpc", "aws_secretsmanager_secret", "aws_kms_key"]) {
    assert.equal(isSecuritySensitiveType(type), true, type);
  }
  for (const type of ["aws_sns_topic", "aws_ecs_service", "aws_cloudwatch_metric_alarm"]) {
    assert.equal(isSecuritySensitiveType(type), false, type);
  }
});

// ── analysis ─────────────────────────────────────────────────────────────

test("analysePlan counts actions and skips no-op resources", () => {
  const { counts, changes, destructive, sensitive } = analysePlan(SAMPLE_PLAN);
  assert.deepEqual(counts, { create: 2, update: 2, delete: 1, replace: 1 });
  assert.equal(changes.length, 6);
  assert.deepEqual(destructive.map((c) => c.address).sort(), ["aws_ecs_service.api", "aws_sns_topic.old"]);
  assert.ok(sensitive.some((c) => c.address === "aws_iam_role_policy.task"));
  assert.ok(sensitive.some((c) => c.address === "aws_security_group.web"));
});

test("changedAttributeNames lists names only and tags sensitive attributes", () => {
  const names = changedAttributeNames(SAMPLE_PLAN.resource_changes[1].change);
  assert.deepEqual(names, ["instance_class", "password (sensitive)"]);
});

test("changedAttributeNames includes attributes that are unknown until apply", () => {
  const names = changedAttributeNames({ before: { arn: "a" }, after: { arn: "a" }, after_unknown: { id: true } });
  assert.deepEqual(names, ["id"]);
});

// ── formatting ───────────────────────────────────────────────────────────

test("formatSummary carries the update marker and totals", () => {
  const body = formatSummary([{ name: "devops", plan: SAMPLE_PLAN }]);
  assert.ok(body.startsWith(COMMENT_MARKER));
  assert.match(body, /\*\*2\*\* to add, \*\*2\*\* to change, \*\*1\*\* to destroy, \*\*1\*\* to replace/);
});

test("formatSummary calls out destructive and security-sensitive changes before other changes", () => {
  const body = formatSummary([{ name: "devops", plan: SAMPLE_PLAN }]);
  const destructiveAt = body.indexOf("Destructive changes");
  const sensitiveAt = body.indexOf("Security-sensitive changes");
  const otherAt = body.indexOf("Other changes");
  assert.ok(destructiveAt > -1 && sensitiveAt > destructiveAt && otherAt > sensitiveAt);
  assert.match(body, /2 destructive change\(s\)/);
  assert.match(body, /replace because cannot update/);
  assert.ok(body.indexOf("aws_ecs_service.api") < otherAt);
  assert.ok(body.indexOf("aws_iam_role_policy.task") < otherAt);
});

test("formatSummary never includes attribute values, sensitive or otherwise", () => {
  const body = formatSummary([{ name: "devops", plan: SAMPLE_PLAN }]);
  assert.ok(!body.includes(SECRET_VALUE));
  assert.ok(!body.includes("old-secret-value"));
  assert.ok(!body.includes("db.t3.medium"));
  assert.ok(!body.includes("FARGATE"));
  assert.match(body, /password \(sensitive\)/);
});

test("formatSummary reports a clean plan", () => {
  const body = formatSummary([{ name: "devops", plan: { resource_changes: [] } }]);
  assert.match(body, /No infrastructure changes/);
  assert.ok(!body.includes("destructive"));
});

test("formatSummary renders a readable failure and scrubs secrets from the log", () => {
  const log = [
    "\u001b[31mError: Invalid provider configuration\u001b[0m",
    "db_password = \"hunter2-super-secret-db-password\"",
    "aws key AKIAABCDEFGHIJKLMNOP leaked",
  ].join("\n");
  const body = formatSummary([{ name: "devops/terraform", error: log }]);
  assert.match(body, /1 module\(s\) failed to plan/);
  assert.match(body, /plan failed/);
  assert.match(body, /Invalid provider configuration/);
  assert.ok(!body.includes("hunter2"));
  assert.ok(!body.includes("AKIAABCDEFGHIJKLMNOP"));
  assert.ok(!body.includes("\u001b"));
});

test("formatSummary keeps failing modules alongside successful ones", () => {
  const body = formatSummary([
    { name: "devops", plan: SAMPLE_PLAN },
    { name: "devops/terraform", error: "boom" },
  ]);
  assert.match(body, /plan failed/);
  assert.match(body, /1 destructive|2 destructive/);
});

test("formatSummary neutralises markdown-breaking characters in resource addresses", () => {
  const plan = {
    resource_changes: [
      {
        address: "aws_iam_role.a`|\nb",
        type: "aws_iam_role",
        change: { actions: ["create"], before: null, after: {} },
      },
    ],
  };
  const body = formatSummary([{ name: "devops", plan }]);
  assert.match(body, /`aws_iam_role\.ab`/);
});

test("formatSummary truncates oversized output", () => {
  const resource_changes = Array.from({ length: 3000 }, (_, i) => ({
    address: `aws_sns_topic.t${i}`,
    type: "aws_sns_topic",
    change: { actions: ["create"], before: null, after: {} },
  }));
  const body = formatSummary([{ name: "devops", plan: { resource_changes } }]);
  assert.ok(body.length <= 60000);
});

// ── scrubText ────────────────────────────────────────────────────────────

test("scrubText redacts key/value secrets, bearer tokens and private keys", () => {
  const out = scrubText(
    "password=abc123 token: xyz789\nAuthorization: Bearer abcdefghijklmnop\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
  );
  assert.ok(!out.includes("abc123"));
  assert.ok(!out.includes("xyz789"));
  assert.ok(!out.includes("abcdefghijklmnop"));
  assert.ok(!out.includes("MIIE"));
});
