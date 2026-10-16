// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT
//
// Jest setup that skips quarantined tests (issue #877).
//
// It is a no-op unless FLAKY_QUARANTINE_ENABLED=true AND the quarantine
// registry (devops/testing/quarantine.json) has an entry whose expiry has not
// passed. When active, it wraps global.test/global.it so a test whose full
// name matches an active quarantine is registered with `.skip`.
//
// Kept defensive: it must never throw, because it runs for every test file.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const REGISTRY_PATH = path.join(REPO_ROOT, "devops", "testing", "quarantine.json");

function startOfDay(value) {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function loadActiveQuarantines(now = new Date()) {
  if (process.env.FLAKY_QUARANTINE_ENABLED !== "true") return [];
  try {
    if (!fs.existsSync(REGISTRY_PATH)) return [];
    const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
    const today = startOfDay(now);
    return (registry.quarantines || []).filter((entry) => {
      if (!entry || !entry.test) return false;
      if (!entry.expiresAt) return true;
      return startOfDay(entry.expiresAt) >= today;
    });
  } catch {
    return [];
  }
}

function matches(testName, fragment) {
  const a = String(testName || "").toLowerCase();
  const b = String(fragment || "").toLowerCase();
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function instrument(quarantines) {
  if (quarantines.length === 0) return;

  const shouldSkip = (name) => quarantines.some((entry) => matches(name, entry.test));

  const wrap = (original) => {
    if (typeof original !== "function") return original;
    const wrapped = function (name, fn, timeout) {
      if (shouldSkip(name)) return original.skip(name, fn, timeout);
      return original(name, fn, timeout);
    };
    for (const key of Object.getOwnPropertyNames(original)) {
      if (["length", "name", "prototype", "arguments", "caller"].includes(key)) continue;
      try {
        Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(original, key));
      } catch {
        // ignore non-configurable descriptors
      }
    }
    return wrapped;
  };

  try {
    const originalTest = global.test;
    const originalIt = global.it;
    const wrappedTest = wrap(originalTest);
    global.test = wrappedTest;
    global.it = originalIt === originalTest ? wrappedTest : wrap(originalIt);
    global.__FLAKY_QUARANTINE__ = { active: quarantines.length };
  } catch {
    // Never let the quarantine hook break the suite.
  }
}

instrument(loadActiveQuarantines());
