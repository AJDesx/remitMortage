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

function requiredProperties(schema, seen = new Set()) {
  if (!schema) return new Set();
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return new Set();
    seen.add(schema.$ref);
    const target = schema.$ref.replace(/^#\//, "").split("/").reduce((value, part) => value?.[part.replace(/~1/g, "/").replace(/~0/g, "~")], spec);
    return requiredProperties(target, seen);
  }
  const properties = new Set(schema.required ?? []);
  for (const child of schema.allOf ?? []) for (const property of requiredProperties(child, seen)) properties.add(property);
  return properties;
}

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
  const successSchema = operation.responses?.[String(endpoint.successStatus)]?.content?.["application/json"]?.schema;
  const backendFields = requiredProperties(successSchema);
  const mockFields = new Set(Object.keys(mocks[key]?.[String(endpoint.successStatus)] ?? {}));
  for (const field of endpoint.requiredFields ?? []) {
    if (!backendFields.has(field)) errors.push(`${key}: backend response schema no longer requires ${field}`);
    if (!mockFields.has(field)) errors.push(`${key}: frontend success mock is missing ${field}`);
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
