// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Request, Response, NextFunction } from "express";
import { prisma } from "../services/db.js";
import { apiKeyQuotaExceededTotal } from "../services/metrics.js";

/**
 * Per-API-key request quotas, metered per billing period.
 *
 * Distinct from `exportRateLimit.ts`'s rolling-window row quota: this counts
 * every request (not a variable row count), is billing-*period*-based
 * rather than a rolling window, and is DB-backed rather than in-memory so
 * usage survives a restart and is consistent across instances — the
 * counter itself (`ApiKeyUsage`) IS the metering data a key owner reads
 * back via `GET /api/keys/usage`.
 */

export interface ApiKeyQuotaConfig {
  /** Billing period length in days. Periods are rolling, anchored to each key's createdAt. */
  periodDays: number;
  /** Request quota for plans without an explicit override. */
  defaultQuota: number;
  /** Per-plan quota overrides, keyed by `ApiKey.plan`. */
  quotaByPlan: Record<string, number>;
}

/**
 * Parses `API_KEY_QUOTA_BY_PLAN`, a comma-separated list of `plan=requests`
 * pairs (e.g. "free=1000,pro=50000,enterprise=1000000"). Malformed or
 * non-positive entries are ignored. Mirrors
 * `exportRateLimit.ts#parseScopeQuotas`'s parsing convention.
 */
export function parsePlanQuotas(raw: string | undefined): Record<string, number> {
  const quotas: Record<string, number> = {};
  if (!raw) return quotas;
  for (const pair of raw.split(",")) {
    const separator = pair.lastIndexOf("=");
    if (separator <= 0) continue;
    const plan = pair.slice(0, separator).trim();
    const requests = parseInt(pair.slice(separator + 1).trim(), 10);
    if (plan && Number.isFinite(requests) && requests > 0) quotas[plan] = requests;
  }
  return quotas;
}

export function loadApiKeyQuotaConfig(env: NodeJS.ProcessEnv = process.env): ApiKeyQuotaConfig {
  const periodDays = parseInt(env.API_KEY_QUOTA_PERIOD_DAYS || "", 10);
  const defaultQuota = parseInt(env.API_KEY_QUOTA_DEFAULT || "", 10);
  return {
    periodDays: Number.isFinite(periodDays) && periodDays > 0 ? periodDays : 30,
    defaultQuota: Number.isFinite(defaultQuota) && defaultQuota > 0 ? defaultQuota : 10_000,
    quotaByPlan: parsePlanQuotas(env.API_KEY_QUOTA_BY_PLAN),
  };
}

export function quotaForPlan(config: ApiKeyQuotaConfig, plan: string): number {
  return config.quotaByPlan[plan] ?? config.defaultQuota;
}

/**
 * The current rolling billing period for a key, anchored to when it was
 * created rather than the calendar — so "period rollover" happens on a
 * fixed cadence relative to the key's own lifetime, not a shared calendar
 * boundary every key would otherwise reset on simultaneously.
 */
export function resolveBillingPeriod(
  keyCreatedAt: Date,
  periodDays: number,
  now: Date = new Date()
): { periodStart: Date; periodEnd: Date } {
  const periodMs = periodDays * 24 * 60 * 60 * 1000;
  const elapsed = Math.max(0, now.getTime() - keyCreatedAt.getTime());
  const periodIndex = Math.floor(elapsed / periodMs);
  const periodStart = new Date(keyCreatedAt.getTime() + periodIndex * periodMs);
  const periodEnd = new Date(periodStart.getTime() + periodMs);
  return { periodStart, periodEnd };
}

/**
 * Increments the current period's counter for `apiKeyId` and returns the
 * post-increment count alongside the period boundaries. A plain upsert:
 * the counter always increments, even for a request later rejected as
 * over-quota — a request that reached this far already cost the backend
 * the work of authenticating and routing it, so it's fair to count it.
 */
export async function recordApiKeyRequest(
  apiKeyId: string,
  keyCreatedAt: Date,
  periodDays: number,
  now: Date = new Date()
): Promise<{ requestCount: number; periodStart: Date; periodEnd: Date }> {
  const { periodStart, periodEnd } = resolveBillingPeriod(keyCreatedAt, periodDays, now);

  const usage = await prisma.apiKeyUsage.upsert({
    where: { apiKeyId_periodStart: { apiKeyId, periodStart } },
    create: { apiKeyId, periodStart, periodEnd, requestCount: 1 },
    update: { requestCount: { increment: 1 } },
  });

  return { requestCount: usage.requestCount, periodStart, periodEnd };
}

/**
 * Current period's usage for `apiKeyId` without incrementing it — for the
 * self-service `GET /api/keys/usage` endpoint, which reads consumption
 * without that read itself counting as a metered request.
 */
export async function readApiKeyUsage(
  apiKeyId: string,
  keyCreatedAt: Date,
  periodDays: number,
  now: Date = new Date()
): Promise<{ requestCount: number; periodStart: Date; periodEnd: Date }> {
  const { periodStart, periodEnd } = resolveBillingPeriod(keyCreatedAt, periodDays, now);
  const usage = await prisma.apiKeyUsage.findUnique({
    where: { apiKeyId_periodStart: { apiKeyId, periodStart } },
  });
  return { requestCount: usage?.requestCount ?? 0, periodStart, periodEnd };
}

/**
 * Meters the request against the caller's per-plan, per-billing-period
 * quota, setting `X-Quota-Limit`/`X-Quota-Remaining`/`X-Quota-Reset` on
 * every response and rejecting with 429 + `Retry-After` once the period's
 * quota is used up. Must be mounted after `requireScopedApiKey` (or any
 * middleware that sets `res.locals.apiKey`), which resolves the key this
 * reads.
 */
export function apiKeyQuotaMiddleware(config: ApiKeyQuotaConfig = loadApiKeyQuotaConfig()) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const apiKey = res.locals.apiKey as { id: string; plan: string; createdAt: Date } | undefined;
    if (!apiKey) {
      // No API key resolved upstream — nothing to meter. Let the request
      // through rather than failing closed on a middleware-ordering bug;
      // requireScopedApiKey is what actually guards access.
      next();
      return;
    }

    const quota = quotaForPlan(config, apiKey.plan);

    try {
      const { requestCount, periodEnd } = await recordApiKeyRequest(
        apiKey.id,
        apiKey.createdAt,
        config.periodDays
      );

      const resetUnixSeconds = Math.ceil(periodEnd.getTime() / 1000);
      res.setHeader("X-Quota-Limit", String(quota));
      res.setHeader("X-Quota-Remaining", String(Math.max(0, quota - requestCount)));
      res.setHeader("X-Quota-Reset", String(resetUnixSeconds));

      if (requestCount > quota) {
        apiKeyQuotaExceededTotal.inc({ plan: apiKey.plan });
        const retryAfter = Math.max(1, resetUnixSeconds - Math.floor(Date.now() / 1000));
        res.setHeader("Retry-After", String(retryAfter));
        res.status(429).json({
          error: "quota_exceeded",
          message: `API key quota of ${quota} requests per billing period exceeded`,
          resetAt: periodEnd.toISOString(),
          retryAfter,
          statusCode: 429,
        });
        return;
      }

      next();
    } catch (err) {
      // Metering failure must never block a request that otherwise passed
      // auth/scope checks — fail open on the quota layer specifically.
      next();
    }
  };
}
