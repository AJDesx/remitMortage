import assert from "node:assert/strict";
import test from "node:test";
import { awsProviderBlocks, providersMissingDefaultTags } from "./check-terraform-default-tags.mjs";

test("accepts a provider with default_tags", () => {
  const src = `provider "aws" {\n  region = "us-east-1"\n  default_tags {\n    tags = local.required_tags\n  }\n}\n`;
  assert.deepEqual(providersMissingDefaultTags(src), []);
});

test("flags a provider without default_tags", () => {
  const src = `provider "aws" {\n  region = var.aws_region\n}\n`;
  assert.equal(providersMissingDefaultTags(src).length, 1);
});

test("checks every aliased provider independently", () => {
  const src = `
provider "aws" {
  default_tags { tags = {} }
}
provider "aws" {
  alias  = "secondary"
  region = "us-west-2"
}`;
  assert.equal(awsProviderBlocks(src).length, 2);
  assert.equal(providersMissingDefaultTags(src).length, 1);
});

test("ignores non-aws providers", () => {
  assert.deepEqual(providersMissingDefaultTags(`provider "random" {}\n`), []);
});
