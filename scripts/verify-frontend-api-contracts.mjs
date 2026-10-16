#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const [spec, contract, mocks] = await Promise.all([
  readJson("backend/openapi.json"),
  readJson("contracts/api/frontend-consumer.json"),
  readJson("frontend/__tests__/fixtures/frontend-api-contract-mocks.json"),
]);
const errors = [];
const expectedKeys = new Set();

for (const endpoint of contract.endpoints) {
  const key = `${endpoint.method.toUpperCase()} ${endpoint.path}`;
  expectedKeys.add(key);
  const operation = spec.paths?.[endpoint.path]?.[endpoint.method.toLowerCase()];
  if (!operation) {
    errors.push(`${key}: not present in backend OpenAPI`);
    continue;
  }
  for (const status of endpoint.responses) {
    if (!operation.responses?.[String(status)]) errors.push(`${key}: backend OpenAPI no longer declares response ${status}`);
    if (!mocks[key]?.[String(status)]) errors.push(`${key}: frontend mock is missing response ${status}`);
  }
  for (const status of Object.keys(mocks[key] ?? {})) {
    if (!endpoint.responses.map(String).includes(status)) errors.push(`${key}: frontend mock has undeclared response ${status}`);
  }
}

for (const key of Object.keys(mocks)) if (!expectedKeys.has(key)) errors.push(`${key}: mock has no consumer contract`);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`Verified ${contract.endpoints.length} frontend API expectations and matching mocks against backend OpenAPI.`);
