// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

jest.mock("../services/db.js");
jest.mock("../services/audit.js");
jest.mock("../utils/logger.js", () => ({
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import { prisma } from "../services/db.js";
import { logAudit } from "../services/audit.js";
import {
  submitErasureRequest,
  attachLegalHold,
  liftLegalHold,
  decideErasureRequest,
  executeErasure,
  getErasureRequest,
  createLegalHold,
  isHoldActive,
  activeHoldsFor,
  _clearStore,
} from "../services/erasureWorkflow.js";

const mockLogAudit = logAudit as jest.Mock;
const WALLET = "G-USER-WALLET";
const ADMIN = "G-ADMIN-WALLET";

beforeEach(() => {
  jest.clearAllMocks();
  _clearStore();
  mockLogAudit.mockImplementation(() => {});
  // Default: no active loan
  (prisma.loanApplication as any) = { findFirst: jest.fn().mockResolvedValue(null) };
});

// ── Submit ─────────────────────────────────────────────────────────────────────

describe("submitErasureRequest", () => {
  it("creates a request in pending status when no holds apply", async () => {
    const req = await submitErasureRequest(WALLET, WALLET);
    expect(req.status).toBe("pending");
    expect(req.walletAddress).toBe(WALLET);
    expect(req.holds).toHaveLength(0);
  });

  it("returns the existing request instead of creating a duplicate", async () => {
    const first = await submitErasureRequest(WALLET, WALLET);
    const second = await submitErasureRequest(WALLET, WALLET);
    expect(second.requestId).toBe(first.requestId);
  });

  it("automatically attaches a legal hold when the borrower has an active loan", async () => {
    (prisma.loanApplication as any) = {
      findFirst: jest.fn().mockResolvedValue({ id: "loan-1" }),
    };

    const req = await submitErasureRequest(WALLET, WALLET);
    expect(req.status).toBe("legal_hold");
    expect(req.holds).toHaveLength(1);
    expect(req.holds[0].reason).toBe("active_loan");
  });

  it("records a gdpr.erasure_request_submitted audit entry", async () => {
    await submitErasureRequest(WALLET, WALLET);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "gdpr.erasure_request_submitted" })
    );
  });
});

// ── Legal holds ───────────────────────────────────────────────────────────────

describe("attachLegalHold / liftLegalHold", () => {
  it("blocks an erasure request by setting status to legal_hold", async () => {
    const req = await submitErasureRequest(WALLET, WALLET);
    const hold = createLegalHold("regulatory_investigation", ADMIN);
    attachLegalHold(req.requestId, hold, ADMIN);

    const updated = getErasureRequest(req.requestId)!;
    expect(updated.status).toBe("legal_hold");
    expect(updated.holds).toHaveLength(1);
  });

  it("restores pending status once all holds are lifted", async () => {
    const req = await submitErasureRequest(WALLET, WALLET);
    const hold = createLegalHold("fraud_review", ADMIN);
    attachLegalHold(req.requestId, hold, ADMIN);
    liftLegalHold(req.requestId, hold.holdId, ADMIN);

    const updated = getErasureRequest(req.requestId)!;
    expect(updated.status).toBe("pending");
    expect(activeHoldsFor(updated)).toHaveLength(0);
  });

  it("keeps status as legal_hold when one of two holds remains", async () => {
    const req = await submitErasureRequest(WALLET, WALLET);
    const h1 = createLegalHold("fraud_review", ADMIN);
    const h2 = createLegalHold("tax_compliance", ADMIN);
    attachLegalHold(req.requestId, h1, ADMIN);
    attachLegalHold(req.requestId, h2, ADMIN);
    liftLegalHold(req.requestId, h1.holdId, ADMIN);

    const updated = getErasureRequest(req.requestId)!;
    expect(updated.status).toBe("legal_hold");
    expect(activeHoldsFor(updated)).toHaveLength(1);
  });

  it("records audit entries for attach and lift", async () => {
    const req = await submitErasureRequest(WALLET, WALLET);
    const hold = createLegalHold("other", ADMIN);
    attachLegalHold(req.requestId, hold, ADMIN);
    liftLegalHold(req.requestId, hold.holdId, ADMIN);

    const actions = mockLogAudit.mock.calls.map((c: any[]) => c[0].action);
    expect(actions).toContain("gdpr.legal_hold_attached");
    expect(actions).toContain("gdpr.legal_hold_lifted");
  });

  it("throws when attaching a hold to a non-existent request", () => {
    const hold = createLegalHold("other", ADMIN);
    expect(() => attachLegalHold("bad-id", hold, ADMIN)).toThrow("not found");
  });
});

// ── isHoldActive ─────────────────────────────────────────────────────────────

describe("isHoldActive", () => {
  it("returns true for a hold with no expiry and not lifted", () => {
    const hold = createLegalHold("other", ADMIN);
    expect(isHoldActive(hold)).toBe(true);
  });

  it("returns false for a lifted hold", () => {
    const hold = createLegalHold("other", ADMIN);
    hold.liftedAt = new Date();
    expect(isHoldActive(hold)).toBe(false);
  });

  it("returns false for an expired hold", () => {
    const hold = createLegalHold("other", ADMIN, new Date("2000-01-01"));
    expect(isHoldActive(hold)).toBe(false);
  });

  it("returns true for a hold whose expiry is in the future", () => {
    const hold = createLegalHold("other", ADMIN, new Date("2099-01-01"));
    expect(isHoldActive(hold)).toBe(true);
  });
});

// ── Decision ──────────────────────────────────────────────────────────────────

describe("decideErasureRequest", () => {
  it("approves a request with no active holds", async () => {
    const req = await submitErasureRequest(WALLET, WALLET);
    const updated = decideErasureRequest({
      requestId: req.requestId,
      decidedBy: ADMIN,
      decision: "approve",
      reason: "verified no active loans",
    });
    expect(updated.status).toBe("approved");
  });

  it("rejects a request", async () => {
    const req = await submitErasureRequest(WALLET, WALLET);
    const updated = decideErasureRequest({
      requestId: req.requestId,
      decidedBy: ADMIN,
      decision: "reject",
      reason: "duplicate request",
    });
    expect(updated.status).toBe("rejected");
  });

  it("throws when approving a request that still has active holds", async () => {
    const req = await submitErasureRequest(WALLET, WALLET);
    const hold = createLegalHold("regulatory_investigation", ADMIN);
    attachLegalHold(req.requestId, hold, ADMIN);

    expect(() =>
      decideErasureRequest({
        requestId: req.requestId,
        decidedBy: ADMIN,
        decision: "approve",
        reason: "oops",
      })
    ).toThrow("active legal hold");
  });
});

// ── Execute ───────────────────────────────────────────────────────────────────

describe("executeErasure", () => {
  it("completes the erasure and records a scrub log", async () => {
    const req = await submitErasureRequest(WALLET, WALLET);
    decideErasureRequest({
      requestId: req.requestId,
      decidedBy: ADMIN,
      decision: "approve",
      reason: "ok",
    });

    const completed = await executeErasure(req.requestId, ADMIN);
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBeInstanceOf(Date);
    expect(completed.scrubLog.length).toBeGreaterThan(0);
  });

  it("throws when attempting to execute a non-approved request", async () => {
    const req = await submitErasureRequest(WALLET, WALLET);
    await expect(executeErasure(req.requestId, ADMIN)).rejects.toThrow("status");
  });

  it("records a gdpr.erasure_completed audit entry", async () => {
    const req = await submitErasureRequest(WALLET, WALLET);
    decideErasureRequest({
      requestId: req.requestId,
      decidedBy: ADMIN,
      decision: "approve",
      reason: "ok",
    });
    await executeErasure(req.requestId, ADMIN);

    const actions = mockLogAudit.mock.calls.map((c: any[]) => c[0].action);
    expect(actions).toContain("gdpr.erasure_completed");
  });
});
