// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Plan-based feature entitlements (issue #859).
 *
 * Tenants are assigned a plan; a plan lists the features it includes and the
 * numeric limits it grants. Entitlement checks run through a small, TTL-cached
 * store so an admin plan change takes effect on the next request without a
 * deploy (the assignment invalidates the cache entry immediately).
 *
 * The store is intentionally in-memory with an optional persistence sink: the
 * backend has no tenant-plan table today, and entitlement lookups must be
 * cheap and available even when the database is degraded (fail closed for
 * gated features, but never crash a request).
 */

import type { Request, RequestHandler } from "express";
import { DEFAULT_TENANT_ID } from "./tenant.js";
import logger from "../utils/logger.js";

export type PlanId = "FREE" | "PRO" | "ENTERPRISE";

/** Feature keys gated by plans. Keep stable — they are referenced from routes. */
export const FEATURES = {
  BULK_IMPORT: "bulk_import",
  CHATOPS_ALERTS: "chatops_alerts",
  AUDIT_HASH_CHAIN: "audit_hash_chain",
  SIEM_EXPORT: "siem_export",
  MULTI_WORKSPACE: "multi_workspace",
  PRIORITY_QUEUE: "priority_queue",
  CUSTOM_BRANDING: "custom_branding",
} as const;

export type Feature = (typeof FEATURES)[keyof typeof FEATURES];

export const ALL_FEATURES: readonly Feature[] = Object.values(FEATURES);

export interface PlanDefinition {
  id: PlanId;
  name: string;
  /** Higher rank = more capable. Used to pick the cheapest upgrade. */
  rank: number;
  features: readonly Feature[];
  limits: Readonly<Record<string, number>>;
}

export const PLANS: Record<PlanId, PlanDefinition> = {
  FREE: {
    id: "FREE",
    name: "Free",
    rank: 0,
    features: [],
    limits: { maxActiveLoans: 10, apiRequestsPerMinute: 60, maxWorkspaces: 1 },
  },
  PRO: {
    id: "PRO",
    name: "Pro",
    rank: 1,
    features: [
      FEATURES.BULK_IMPORT,
      FEATURES.PRIORITY_QUEUE,
      FEATURES.MULTI_WORKSPACE,
      FEATURES.SIEM_EXPORT,
    ],
    limits: { maxActiveLoans: 500, apiRequestsPerMinute: 600, maxWorkspaces: 5 },
  },
  ENTERPRISE: {
    id: "ENTERPRISE",
    name: "Enterprise",
    rank: 2,
    features: ALL_FEATURES,
    limits: { maxActiveLoans: 100_000, apiRequestsPerMinute: 6_000, maxWorkspaces: 100 },
  },
};

export const PLAN_IDS: readonly PlanId[] = ["FREE", "PRO", "ENTERPRISE"];

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && (PLAN_IDS as readonly string[]).includes(value);
}

export interface UpgradeInfo {
  /** Cheapest plan that includes the requested feature. */
  plan: PlanId;
  name: string;
  /** Features the upgrade would add relative to the current plan. */
  addsFeatures: Feature[];
  limits: Readonly<Record<string, number>>;
}

/**
 * Smallest plan (by rank) that includes `feature`, relative to `current`.
 * Returns null when no plan grants the feature.
 */
export function findUpgrade(current: PlanId, feature: Feature): UpgradeInfo | null {
  const currentRank = PLANS[current].rank;
  const candidates = PLAN_IDS.map((id) => PLANS[id])
    .filter((plan) => plan.rank > currentRank && plan.features.includes(feature))
    .sort((a, b) => a.rank - b.rank);

  const target = candidates[0];
  if (!target) return null;

  const currentFeatures = new Set(PLANS[current].features);
  return {
    plan: target.id,
    name: target.name,
    addsFeatures: target.features.filter((f) => !currentFeatures.has(f)),
    limits: target.limits,
  };
}

export interface EntitlementStore {
  get(tenantId: string): PlanId | undefined;
  set(tenantId: string, plan: PlanId): void;
}

/** Default in-memory persistence for plan assignments. */
export class InMemoryEntitlementStore implements EntitlementStore {
  private planByTenant = new Map<string, PlanId>();

  get(tenantId: string): PlanId | undefined {
    return this.planByTenant.get(tenantId);
  }

  set(tenantId: string, plan: PlanId): void {
    this.planByTenant.set(tenantId, plan);
  }
}

const DEFAULT_CACHE_TTL_MS = 60_000;

export class EntitlementService {
  private cache = new Map<string, { planId: PlanId; expiresAt: number }>();

  constructor(
    private store: EntitlementStore = new InMemoryEntitlementStore(),
    private ttlMs: number = DEFAULT_CACHE_TTL_MS
  ) {}

  /** Resolves the plan for a tenant, defaulting to FREE. Cache-through with TTL. */
  getPlanId(tenantId: string, now: number = Date.now()): PlanId {
    const cached = this.cache.get(tenantId);
    if (cached && cached.expiresAt > now) return cached.planId;

    const stored = this.store.get(tenantId);
    const planId = stored && isPlanId(stored) ? stored : "FREE";
    this.cache.set(tenantId, { planId, expiresAt: now + this.ttlMs });
    return planId;
  }

  getPlan(tenantId: string, now: number = Date.now()): PlanDefinition {
    return PLANS[this.getPlanId(tenantId, now)];
  }

  isEntitled(tenantId: string, feature: Feature): boolean {
    return this.getPlan(tenantId).features.includes(feature);
  }

  getLimit(tenantId: string, key: string): number | undefined {
    return this.getPlan(tenantId).limits[key];
  }

  /** Assigns a plan and invalidates the cache so the change is live immediately. */
  assignPlan(tenantId: string, plan: PlanId): PlanDefinition {
    if (!tenantId) throw new Error("tenantId is required");
    this.store.set(tenantId, plan);
    this.cache.delete(tenantId);
    logger.info("[entitlements] plan assigned", { tenantId, plan });
    return PLANS[plan];
  }

  /** Test helper. */
  reset(): void {
    this.cache.clear();
    this.store = new InMemoryEntitlementStore();
  }
}

export const entitlements = new EntitlementService();

/** Tenant id for a request, from the `X-Tenant-Id` header, else the default tenant. */
export function tenantIdForRequest(req: Pick<Request, "headers">): string {
  const header = req.headers["x-tenant-id"];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_TENANT_ID;
}

/**
 * Express middleware that enforces a feature entitlement. When the tenant's
 * plan does not include the feature it responds `403` with the current plan and
 * the cheapest upgrade that grants it.
 */
export function requireEntitlement(
  feature: Feature,
  service: EntitlementService = entitlements
): RequestHandler {
  return (req, res, next) => {
    const tenantId = tenantIdForRequest(req);
    const plan = service.getPlan(tenantId);

    if (plan.features.includes(feature)) return next();

    const upgrade = findUpgrade(plan.id, feature);
    return res.status(403).json({
      error: "feature_not_entitled",
      message: `The ${plan.name} plan does not include the '${feature}' feature.`,
      feature,
      plan: plan.id,
      upgrade,
    });
  };
}
