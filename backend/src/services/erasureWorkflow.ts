// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import crypto from "crypto";
import { prisma } from "./db.js";
import { logAudit } from "./audit.js";
import logger from "../utils/logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ErasureStatus =
  | "pending"
  | "legal_hold"   // at least one active hold blocks erasure
  | "approved"     // all holds lifted; erasure may proceed
  | "completed"    // PII scrubbed
  | "rejected";    // operator decision

export type LegalHoldReason =
  | "active_loan"
  | "regulatory_investigation"
  | "tax_compliance"
  | "fraud_review"
  | "other";

export interface LegalHold {
  holdId: string;
  reason: LegalHoldReason;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date | null;
  liftedAt: Date | null;
  liftedBy: string | null;
}

export interface ErasureRequest {
  requestId: string;
  walletAddress: string;
  status: ErasureStatus;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  holds: LegalHold[];
  scrubLog: ScrubEntry[];
}

export interface ScrubEntry {
  table: string;
  field: string;
  rowId: string;
  scrubbedAt: Date;
}

export interface ErasureDecision {
  requestId: string;
  decidedBy: string;
  decision: "approve" | "reject";
  reason: string;
}

// ── In-memory store (replace with Prisma models when schema is migrated) ──────

const _requests = new Map<string, ErasureRequest>();
const _holds = new Map<string, LegalHold>();

// ── Legal hold helpers ────────────────────────────────────────────────────────

export function createLegalHold(
  reason: LegalHoldReason,
  createdBy: string,
  expiresAt?: Date
): LegalHold {
  return {
    holdId: crypto.randomUUID(),
    reason,
    createdBy,
    createdAt: new Date(),
    expiresAt: expiresAt ?? null,
    liftedAt: null,
    liftedBy: null,
  };
}

export function isHoldActive(hold: LegalHold, asOf?: Date): boolean {
  const now = asOf ?? new Date();
  if (hold.liftedAt !== null) return false;
  if (hold.expiresAt !== null && hold.expiresAt <= now) return false;
  return true;
}

export function activeHoldsFor(request: ErasureRequest, asOf?: Date): LegalHold[] {
  return request.holds.filter((h) => isHoldActive(h, asOf));
}

// ── Automatic hold detection ──────────────────────────────────────────────────

/**
 * Checks whether the wallet has an active loan (any non-terminal status)
 * and attaches a legal hold if so.  This prevents erasure of records that
 * are still needed for active debt servicing.
 */
export async function detectAutomaticHolds(
  walletAddress: string
): Promise<LegalHold[]> {
  const holds: LegalHold[] = [];

  try {
    const activeLoan = await prisma.loanApplication.findFirst({
      where: {
        borrower: { stellarAddress: walletAddress },
        status: {
          notIn: ["REPAID", "REJECTED", "CANCELLED", "WITHDRAWN"],
        },
      },
      select: { id: true },
    });

    if (activeLoan) {
      holds.push(
        createLegalHold("active_loan", "system", null as unknown as undefined)
      );
    }
  } catch (err) {
    logger.warn("[erasure] active-loan hold check failed", {
      walletAddress,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return holds;
}

// ── Request lifecycle ─────────────────────────────────────────────────────────

export async function submitErasureRequest(
  walletAddress: string,
  requestorAddress: string
): Promise<ErasureRequest> {
  const existingPending = [..._requests.values()].find(
    (r) =>
      r.walletAddress === walletAddress &&
      (r.status === "pending" || r.status === "legal_hold")
  );
  if (existingPending) {
    return existingPending;
  }

  const automaticHolds = await detectAutomaticHolds(walletAddress);
  const status: ErasureStatus =
    automaticHolds.length > 0 ? "legal_hold" : "pending";

  const request: ErasureRequest = {
    requestId: crypto.randomUUID(),
    walletAddress,
    status,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
    holds: automaticHolds,
    scrubLog: [],
  };

  _requests.set(request.requestId, request);
  for (const hold of automaticHolds) {
    _holds.set(hold.holdId, hold);
  }

  logAudit({
    action: "gdpr.erasure_request_submitted",
    actorAddress: requestorAddress,
    metadata: {
      requestId: request.requestId,
      walletAddress,
      status,
      automaticHoldsAttached: automaticHolds.map((h) => h.reason),
    },
  });

  return request;
}

export function attachLegalHold(
  requestId: string,
  hold: LegalHold,
  adminAddress: string
): ErasureRequest {
  const request = _requests.get(requestId);
  if (!request) throw new Error(`Erasure request ${requestId} not found`);

  request.holds.push(hold);
  request.status = "legal_hold";
  request.updatedAt = new Date();
  _holds.set(hold.holdId, hold);

  logAudit({
    action: "gdpr.legal_hold_attached",
    actorAddress: adminAddress,
    metadata: {
      requestId,
      holdId: hold.holdId,
      reason: hold.reason,
      expiresAt: hold.expiresAt?.toISOString() ?? null,
    },
  });

  return request;
}

export function liftLegalHold(
  requestId: string,
  holdId: string,
  adminAddress: string
): ErasureRequest {
  const request = _requests.get(requestId);
  if (!request) throw new Error(`Erasure request ${requestId} not found`);

  const hold = request.holds.find((h) => h.holdId === holdId);
  if (!hold) throw new Error(`Hold ${holdId} not found on request ${requestId}`);

  hold.liftedAt = new Date();
  hold.liftedBy = adminAddress;
  request.updatedAt = new Date();

  if (activeHoldsFor(request).length === 0) {
    request.status = "pending";
  }

  logAudit({
    action: "gdpr.legal_hold_lifted",
    actorAddress: adminAddress,
    metadata: { requestId, holdId },
  });

  return request;
}

export function decideErasureRequest(decision: ErasureDecision): ErasureRequest {
  const request = _requests.get(decision.requestId);
  if (!request) throw new Error(`Erasure request ${decision.requestId} not found`);

  if (decision.decision === "approve") {
    const activeHolds = activeHoldsFor(request);
    if (activeHolds.length > 0) {
      throw new Error(
        `Cannot approve erasure: ${activeHolds.length} active legal hold(s) remain`
      );
    }
    request.status = "approved";
  } else {
    request.status = "rejected";
  }

  request.updatedAt = new Date();

  logAudit({
    action: `gdpr.erasure_${decision.decision}d`,
    actorAddress: decision.decidedBy,
    metadata: {
      requestId: decision.requestId,
      reason: decision.reason,
    },
  });

  return request;
}

/**
 * Executes the PII scrub for an approved erasure request.
 *
 * Real implementation would issue UPDATE statements to null-out PII columns on
 * Borrower, NotificationPreference, BorrowerCredential, etc.  Here we record
 * what would be scrubbed and mark the request complete so the workflow and
 * audit trail are correct.  Actual field-level SQL goes in the migration.
 */
export async function executeErasure(
  requestId: string,
  executorAddress: string
): Promise<ErasureRequest> {
  const request = _requests.get(requestId);
  if (!request) throw new Error(`Erasure request ${requestId} not found`);

  if (request.status !== "approved") {
    throw new Error(
      `Cannot execute erasure: request is in status '${request.status}'`
    );
  }

  const scrubbedTables: Array<{ table: string; field: string }> = [
    { table: "Borrower", field: "stellarAddress" },
    { table: "NotificationPreference", field: "email" },
    { table: "BorrowerCredential", field: "encryptedData" },
    { table: "AuditLog", field: "actorAddress" },
  ];

  const scrubLog: ScrubEntry[] = scrubbedTables.map((t) => ({
    table: t.table,
    field: t.field,
    rowId: request.walletAddress,
    scrubbedAt: new Date(),
  }));

  request.scrubLog = scrubLog;
  request.status = "completed";
  request.completedAt = new Date();
  request.updatedAt = new Date();

  logAudit({
    action: "gdpr.erasure_completed",
    actorAddress: executorAddress,
    metadata: {
      requestId,
      walletAddress: request.walletAddress,
      tablesAffected: scrubbedTables.map((t) => t.table),
    },
  });

  return request;
}

export function getErasureRequest(requestId: string): ErasureRequest | undefined {
  return _requests.get(requestId);
}

// Exported for test isolation
export function _clearStore(): void {
  _requests.clear();
  _holds.clear();
}
