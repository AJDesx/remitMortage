// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import express from "express";
import request from "supertest";
import {
  parsePlanQuotas,
  loadApiKeyQuotaConfig,
  resolveBillingPeriod,
  quotaForPlan,
  apiKeyQuotaMiddleware,
  recordApiKeyRequest,
  readApiKeyUsage,
  type ApiKeyQuotaConfig,
} from "../middleware/apiKeyQuota";

// DB-backed metering needs a working (if fake) prisma.apiKeyUsage — a bare
// jest.fn() stub can't support counting accuracy or rollover assertions.
// Each test uses its own apiKeyId, so one array shared across the file
// never leaks state between tests.
jest.mock("../services/db.js", () => {
  type Row = { apiKeyId: string; periodStart: Date; periodEnd: Date; requestCount: number };
  const rows: Row[] = [];

  function find(apiKeyId: string, periodStart: Date): Row | undefined {
    return rows.find((r) => r.apiKeyId === apiKeyId && r.periodStart.getTime() === periodStart.getTime());
  }

  return {
    prisma: {
      apiKeyUsage: {
        upsert: jest.fn(
          async ({
            where,
            create,
            update,
          }: {
            where: { apiKeyId_periodStart: { apiKeyId: string; periodStart: Date } };
            create: Row;
            update: { requestCount: { increment: number } };
          }) => {
            const { apiKeyId, periodStart } = where.apiKeyId_periodStart;
            const existing = find(apiKeyId, periodStart);
            if (existing) {
              existing.requestCount += update.requestCount.increment;
              return { ...existing };
            }
            const row: Row = { ...create };
            rows.push(row);
            return { ...row };
          }
        ),
        findUnique: jest.fn(
          async ({ where }: { where: { apiKeyId_periodStart: { apiKeyId: string; periodStart: Date } } }) => {
            const { apiKeyId, periodStart } = where.apiKeyId_periodStart;
            const existing = find(apiKeyId, periodStart);
            return existing ? { ...existing } : null;
          }
        ),
      },
    },
  };
});

describe("parsePlanQuotas / loadApiKeyQuotaConfig", () => {
  it("parses plan=requests pairs and ignores malformed entries", () => {
    expect(parsePlanQuotas("free=1000, pro=50000,bad,x=-5,=3")).toEqual({
      free: 1000,
      pro: 50000,
    });
    expect(parsePlanQuotas(undefined)).toEqual({});
  });

  it("falls back to defaults when env values are missing or invalid", () => {
    expect(loadApiKeyQuotaConfig({})).toEqual({
      periodDays: 30,
      defaultQuota: 10_000,
      quotaByPlan: {},
    });
    expect(
      loadApiKeyQuotaConfig({
        API_KEY_QUOTA_PERIOD_DAYS: "7",
        API_KEY_QUOTA_DEFAULT: "500",
        API_KEY_QUOTA_BY_PLAN: "pro=20000",
      })
    ).toEqual({ periodDays: 7, defaultQuota: 500, quotaByPlan: { pro: 20000 } });
  });

  it("resolves a plan's quota, falling back to the default for unknown plans", () => {
    const config: ApiKeyQuotaConfig = { periodDays: 30, defaultQuota: 100, quotaByPlan: { pro: 999 } };
    expect(quotaForPlan(config, "pro")).toBe(999);
    expect(quotaForPlan(config, "unknown-plan")).toBe(100);
  });
});

describe("resolveBillingPeriod", () => {
  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  const DAY_MS = 24 * 60 * 60 * 1000;

  it("stays within the first period until a full period has elapsed", () => {
    const period = resolveBillingPeriod(createdAt, 30, new Date(createdAt.getTime() + 29 * DAY_MS));
    expect(period.periodStart).toEqual(createdAt);
    expect(period.periodEnd).toEqual(new Date(createdAt.getTime() + 30 * DAY_MS));
  });

  it("rolls over to a new period exactly at the period boundary", () => {
    const period = resolveBillingPeriod(createdAt, 30, new Date(createdAt.getTime() + 30 * DAY_MS));
    expect(period.periodStart).toEqual(new Date(createdAt.getTime() + 30 * DAY_MS));
    expect(period.periodEnd).toEqual(new Date(createdAt.getTime() + 60 * DAY_MS));
  });

  it("advances by whole periods for a gap spanning multiple periods", () => {
    const period = resolveBillingPeriod(createdAt, 30, new Date(createdAt.getTime() + 95 * DAY_MS));
    // 95 days / 30-day periods = period index 3 (days 90-120).
    expect(period.periodStart).toEqual(new Date(createdAt.getTime() + 90 * DAY_MS));
    expect(period.periodEnd).toEqual(new Date(createdAt.getTime() + 120 * DAY_MS));
  });
});

describe("recordApiKeyRequest / readApiKeyUsage", () => {
  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  const DAY_MS = 24 * 60 * 60 * 1000;

  it("counts accurately across repeated requests in the same period", async () => {
    const apiKeyId = "key-count-accuracy";
    for (let i = 1; i <= 5; i++) {
      const { requestCount } = await recordApiKeyRequest(apiKeyId, createdAt, 30, createdAt);
      expect(requestCount).toBe(i);
    }
    const usage = await readApiKeyUsage(apiKeyId, createdAt, 30, createdAt);
    expect(usage.requestCount).toBe(5);
  });

  it("reading usage never increments it", async () => {
    const apiKeyId = "key-read-is-free";
    await recordApiKeyRequest(apiKeyId, createdAt, 30, createdAt);
    await readApiKeyUsage(apiKeyId, createdAt, 30, createdAt);
    await readApiKeyUsage(apiKeyId, createdAt, 30, createdAt);
    const usage = await readApiKeyUsage(apiKeyId, createdAt, 30, createdAt);
    expect(usage.requestCount).toBe(1);
  });

  it("resets the count once the billing period rolls over", async () => {
    const apiKeyId = "key-rollover";
    await recordApiKeyRequest(apiKeyId, createdAt, 30, createdAt);
    await recordApiKeyRequest(apiKeyId, createdAt, 30, new Date(createdAt.getTime() + 10 * DAY_MS));
    const stillInPeriod = await readApiKeyUsage(apiKeyId, createdAt, 30, new Date(createdAt.getTime() + 29 * DAY_MS));
    expect(stillInPeriod.requestCount).toBe(2);

    // Past the 30-day boundary: a fresh period, fresh count.
    const nextPeriod = new Date(createdAt.getTime() + 31 * DAY_MS);
    const afterRollover = await readApiKeyUsage(apiKeyId, createdAt, 30, nextPeriod);
    expect(afterRollover.requestCount).toBe(0);

    await recordApiKeyRequest(apiKeyId, createdAt, 30, nextPeriod);
    expect((await readApiKeyUsage(apiKeyId, createdAt, 30, nextPeriod)).requestCount).toBe(1);
  });
});

describe("apiKeyQuotaMiddleware", () => {
  function buildApp(apiKeyId: string, plan: string, config: ApiKeyQuotaConfig) {
    // Fixed once per key, not re-created per request — `resolveBillingPeriod`
    // keys its period on this value, so a fresh Date() on every request
    // would put each request in a (very slightly) different period and the
    // counter would never actually accumulate.
    const createdAt = new Date();
    const app = express();
    app.get(
      "/resource",
      (_req, res, next) => {
        res.locals.apiKey = { id: apiKeyId, plan, createdAt };
        next();
      },
      apiKeyQuotaMiddleware(config),
      (_req, res) => res.json({ ok: true })
    );
    return app;
  }

  it("sets usage headers and allows requests within quota", async () => {
    const config: ApiKeyQuotaConfig = { periodDays: 30, defaultQuota: 3, quotaByPlan: {} };
    const app = buildApp("key-within-quota", "default", config);

    const first = await request(app).get("/resource");
    expect(first.status).toBe(200);
    expect(first.headers["x-quota-limit"]).toBe("3");
    expect(first.headers["x-quota-remaining"]).toBe("2");
    expect(first.headers["x-quota-reset"]).toBeDefined();
  });

  it("returns 429 with a reset time once the quota is exceeded", async () => {
    const config: ApiKeyQuotaConfig = { periodDays: 30, defaultQuota: 2, quotaByPlan: {} };
    const app = buildApp("key-over-quota", "default", config);

    expect((await request(app).get("/resource")).status).toBe(200);
    expect((await request(app).get("/resource")).status).toBe(200);

    const blocked = await request(app).get("/resource");
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ error: "quota_exceeded", statusCode: 429 });
    expect(blocked.body.resetAt).toBeDefined();
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(blocked.headers["x-quota-remaining"]).toBe("0");
  });

  it("applies the per-plan quota override instead of the default", async () => {
    const config: ApiKeyQuotaConfig = { periodDays: 30, defaultQuota: 1_000_000, quotaByPlan: { pro: 1 } };
    const app = buildApp("key-plan-override", "pro", config);

    const first = await request(app).get("/resource");
    expect(first.headers["x-quota-limit"]).toBe("1");
    expect((await request(app).get("/resource")).status).toBe(429);
  });

  it("meters each API key independently", async () => {
    const config: ApiKeyQuotaConfig = { periodDays: 30, defaultQuota: 1, quotaByPlan: {} };
    const appA = buildApp("key-independent-a", "default", config);
    const appB = buildApp("key-independent-b", "default", config);

    expect((await request(appA).get("/resource")).status).toBe(200);
    expect((await request(appA).get("/resource")).status).toBe(429);
    // A different key's quota is untouched by A's usage.
    expect((await request(appB).get("/resource")).status).toBe(200);
  });
});
