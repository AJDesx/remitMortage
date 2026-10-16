// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Router } from "express";
import { requireAnyApiKey } from "../middleware/apiKeyAuth.js";
import { loadApiKeyQuotaConfig, quotaForPlan, readApiKeyUsage } from "../middleware/apiKeyQuota.js";

export const apiKeyUsageRouter = Router();

/**
 * Self-service usage read for the API key's own owner — authenticated by
 * presenting the key itself (any valid, non-revoked key; no specific scope
 * required), mirroring `GET /api/exports/transactions`'s auth but reading
 * consumption rather than data. This read is never itself metered.
 */
apiKeyUsageRouter.get("/usage", requireAnyApiKey(), async (_req, res) => {
  const apiKey = res.locals.apiKey as { id: string; plan: string; createdAt: Date };
  const config = loadApiKeyQuotaConfig();
  const quota = quotaForPlan(config, apiKey.plan);
  const { requestCount, periodStart, periodEnd } = await readApiKeyUsage(
    apiKey.id,
    apiKey.createdAt,
    config.periodDays
  );

  res.json({
    plan: apiKey.plan,
    quota,
    used: requestCount,
    remaining: Math.max(0, quota - requestCount),
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
  });
});
