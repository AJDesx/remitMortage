import assert from "node:assert/strict";
import test from "node:test";
import {
  findUntagged,
  missingTags,
  renderMarkdown,
  serviceOf,
  summarize,
} from "./report-untagged-resources.mjs";

const full = [
  { Key: "Service", Value: "backend" },
  { Key: "Environment", Value: "prod" },
  { Key: "Owner", Value: "platform-team" },
  { Key: "CostCenter", Value: "core" },
];

test("a fully tagged resource has no missing tags", () => {
  assert.deepEqual(missingTags(full), []);
});

test("reports each missing required tag", () => {
  assert.deepEqual(missingTags([{ Key: "Service", Value: "x" }]), ["Environment", "Owner", "CostCenter"]);
});

test("blank values and wrong-case keys count as missing", () => {
  const tags = [
    { Key: "Service", Value: "   " },
    { Key: "environment", Value: "prod" },
    { Key: "Owner", Value: "me" },
    { Key: "CostCenter", Value: "core" },
  ];
  assert.deepEqual(missingTags(tags), ["Service", "Environment"]);
});

test("a resource with no Tags property is entirely untagged", () => {
  assert.equal(missingTags(undefined).length, 4);
});

test("findUntagged filters compliant resources and sorts by ARN", () => {
  const result = findUntagged([
    { ResourceARN: "arn:aws:s3:::z-bucket", Tags: [] },
    { ResourceARN: "arn:aws:ec2:us-east-1:1:vpc/ok", Tags: full },
    { ResourceARN: "arn:aws:ec2:us-east-1:1:vpc/a", Tags: [{ Key: "Owner", Value: "me" }] },
  ]);
  assert.deepEqual(result.map((r) => r.arn), ["arn:aws:ec2:us-east-1:1:vpc/a", "arn:aws:s3:::z-bucket"]);
  assert.deepEqual(result[1].missing, ["Service", "Environment", "Owner", "CostCenter"]);
});

test("serviceOf extracts the service from an ARN", () => {
  assert.equal(serviceOf("arn:aws:rds:us-east-1:1:db:x"), "rds");
  assert.equal(serviceOf("not-an-arn"), "unknown");
});

test("summarize counts by service", () => {
  const untagged = findUntagged([
    { ResourceARN: "arn:aws:s3:::a", Tags: [] },
    { ResourceARN: "arn:aws:s3:::b", Tags: [] },
    { ResourceARN: "arn:aws:rds:us-east-1:1:db:x", Tags: [] },
  ]);
  assert.deepEqual(summarize(untagged, 5), { total: 5, untagged: 3, compliant: 2, byService: { s3: 2, rds: 1 } });
});

test("markdown report lists untagged resources and their missing tags", () => {
  const untagged = findUntagged([{ ResourceARN: "arn:aws:s3:::a", Tags: [{ Key: "Service", Value: "x" }] }]);
  const md = renderMarkdown(untagged, 2);
  assert.match(md, /Scanned \*\*2\*\* resources: \*\*1\*\* compliant, \*\*1\*\* missing/);
  assert.match(md, /`arn:aws:s3:::a` \| Environment, Owner, CostCenter/);
});

test("markdown report says so when everything is tagged", () => {
  assert.match(renderMarkdown([], 3), /All scanned resources carry the required tags/);
});
