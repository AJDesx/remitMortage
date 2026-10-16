// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Admin API for plan-based feature entitlements (issue #859).
 *
 * Lets an admin read a tenant's current plan and features, and assign a new
 * plan. Assigning a plan invalidates the entitlement cache immediately, so the
 * change takes effect on the next request without a deploy.
 */

import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { entitlements, isPlanId, PLAN_IDS } from "../services/entitlements.js";

export const entitlementsAdminRouter = Router();

entitlementsAdminRouter.get("/entitlements/:tenantId", requireAdmin, (req, res) => {
  const tenantId = String(req.params.tenantId ?? "");
  const plan = entitlements.getPlan(tenantId);
  return res.json({
    tenantId,
    plan: plan.id,
    features: plan.features,
    limits: plan.limits,
  });
});

entitlementsAdminRouter.put("/entitlements/:tenantId", requireAdmin, (req, res) => {
  const tenantId = String(req.params.tenantId ?? "");
  const plan = (req.body ?? {}).plan;
  if (!isPlanId(plan)) {
    return res.status(400).json({ error: "invalid_plan", allowed: PLAN_IDS });
  }

  const updated = entitlements.assignPlan(tenantId, plan);
  return res.json({
    tenantId,
    plan: updated.id,
    features: updated.features,
    limits: updated.limits,
  });
});
