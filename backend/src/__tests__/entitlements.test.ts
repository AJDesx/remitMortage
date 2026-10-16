// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import express from "express";
import request from "supertest";

// The admin API tests only care about routing/plan logic, not the admin gate.
jest.mock("../middleware/auth.js", () => ({
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import {
  EntitlementService,
  entitlements,
  FEATURES,
  PLANS,
  findUpgrade,
  requireEntitlement,
  type Feature,
} from "../services/entitlements.js";
import { entitlementsAdminRouter } from "../routes/entitlements.js";

function appWith(service: EntitlementService, feature: Feature) {
  const app = express();
  app.get("/gated", requireEntitlement(feature, service), (_req, res) => res.json({ ok: true }));
  return app;
}

describe("plan entitlements", () => {
  it("denies a feature outside the tenant's plan with upgrade information", async () => {
    const service = new EntitlementService();
    const res = await request(appWith(service, FEATURES.BULK_IMPORT))
      .get("/gated")
      .set("X-Tenant-Id", "acme");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("feature_not_entitled");
    expect(res.body.feature).toBe(FEATURES.BULK_IMPORT);
    expect(res.body.plan).toBe("FREE");
    expect(res.body.upgrade).toMatchObject({ plan: "PRO" });
    expect(res.body.upgrade.addsFeatures).toContain(FEATURES.BULK_IMPORT);
  });

  it("allows a tenant whose plan includes the feature", async () => {
    const service = new EntitlementService();
    service.assignPlan("acme", "PRO");

    const res = await request(appWith(service, FEATURES.BULK_IMPORT))
      .get("/gated")
      .set("X-Tenant-Id", "acme");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("takes effect immediately after a plan change, without a deploy (cache invalidation)", async () => {
    const service = new EntitlementService();
    const app = appWith(service, FEATURES.CHATOPS_ALERTS);

    // FREE lacks the chatops entitlement — the first request is denied and caches FREE.
    const denied = await request(app).get("/gated").set("X-Tenant-Id", "acme");
    expect(denied.status).toBe(403);

    // Upgrade in-process; the cache is invalidated so the very next request passes.
    service.assignPlan("acme", "ENTERPRISE");
    const allowed = await request(app).get("/gated").set("X-Tenant-Id", "acme");
    expect(allowed.status).toBe(200);
  });

  it("picks the cheapest plan that grants a feature", () => {
    expect(findUpgrade("FREE", FEATURES.BULK_IMPORT)?.plan).toBe("PRO");
    expect(findUpgrade("FREE", FEATURES.CHATOPS_ALERTS)?.plan).toBe("ENTERPRISE");
    expect(findUpgrade("PRO", FEATURES.CHATOPS_ALERTS)?.plan).toBe("ENTERPRISE");
    expect(findUpgrade("ENTERPRISE", FEATURES.BULK_IMPORT)).toBeNull();
    expect(PLANS.ENTERPRISE.features).toEqual(expect.arrayContaining(Object.values(FEATURES)));
  });

  it("exposes numeric limits per plan", () => {
    const service = new EntitlementService();
    expect(service.getLimit("acme", "maxActiveLoans")).toBe(10);
    service.assignPlan("acme", "PRO");
    expect(service.getLimit("acme", "maxActiveLoans")).toBe(500);
  });
});

describe("admin entitlements API", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", entitlementsAdminRouter);

  it("assigns a plan and reflects it on the next read", async () => {
    const put = await request(app)
      .put("/api/admin/entitlements/tenant-x")
      .send({ plan: "ENTERPRISE" });
    expect(put.status).toBe(200);
    expect(put.body.plan).toBe("ENTERPRISE");

    const get = await request(app).get("/api/admin/entitlements/tenant-x");
    expect(get.status).toBe(200);
    expect(get.body.plan).toBe("ENTERPRISE");
    expect(get.body.features).toContain(FEATURES.AUDIT_HASH_CHAIN);
    expect(entitlements.isEntitled("tenant-x", FEATURES.AUDIT_HASH_CHAIN)).toBe(true);
  });

  it("rejects an unknown plan", async () => {
    const put = await request(app)
      .put("/api/admin/entitlements/tenant-y")
      .send({ plan: "PLATINUM" });
    expect(put.status).toBe(400);
    expect(put.body.error).toBe("invalid_plan");
  });
});
