// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Tests for the four-eyes approval queue (issue #841).
 *
 * Acceptance criteria under test:
 * 1. A high-value action executes only after a distinct second admin
 *    approves it (covered at the policy-threshold level here; execution
 *    dispatch itself lives in routes/admin.ts).
 * 2. Self-approval and expired approvals are rejected.
 */

interface Row {
  id: string;
  actionType: string;
  payload: any;
  amount: number | null;
  requestedBy: string;
  status: string;
  approvedBy: string | null;
  approvedAt: Date | null;
  rejectedBy: string | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  executedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

let rows: Row[] = [];
const logAuditMock = jest.fn();
const createInAppNotificationMock = jest.fn();
const loggerWarnMock = jest.fn();

let configOverrides: { fourEyesApproverAddresses: string[]; fourEyesApprovalExpiryHours: number };

jest.mock("../services/db.js", () => ({
  prisma: {
    fourEyesApprovalRequest: {
      create: jest.fn(async ({ data }: any) => {
        const row: Row = {
          id: `req-${rows.length + 1}`,
          approvedBy: null,
          approvedAt: null,
          rejectedBy: null,
          rejectedAt: null,
          rejectionReason: null,
          executedAt: null,
          createdAt: new Date(),
          status: "PENDING",
          ...data,
        };
        rows.push(row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null),
      findMany: jest.fn(async ({ where }: any) =>
        rows.filter((r) => {
          if (where.status && r.status !== where.status) return false;
          if (where.expiresAt?.lte && !(r.expiresAt.getTime() <= where.expiresAt.lte.getTime())) return false;
          return true;
        })
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },
  },
  createInAppNotification: (...args: unknown[]) => createInAppNotificationMock(...args),
}));

jest.mock("../services/audit.js", () => ({
  logAudit: (...args: unknown[]) => logAuditMock(...args),
}));

jest.mock("../utils/logger.js", () => ({
  info: jest.fn(),
  warn: (...args: unknown[]) => loggerWarnMock(...args),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock("../config.js", () => ({
  loadConfig: () => configOverrides,
}));

import {
  FourEyesError,
  approveRequest,
  createApprovalRequest,
  expireDueApprovalRequests,
  rejectRequest,
} from "../services/fourEyesApproval.js";
import { requiresFourEyesApproval } from "../services/fourEyesPolicy.js";

const REQUESTER = "GREQUESTER0000000000000000000000000000000000000000000";
const APPROVER_A = "GAPPROVERA000000000000000000000000000000000000000000000";
const APPROVER_B = "GAPPROVERB000000000000000000000000000000000000000000000";

beforeEach(() => {
  rows = [];
  jest.clearAllMocks();
  configOverrides = {
    fourEyesApproverAddresses: [APPROVER_A.toLowerCase(), APPROVER_B.toLowerCase()],
    fourEyesApprovalExpiryHours: 24,
  };
  delete process.env.ADMIN_WALLET_ADDRESS;
});

describe("requiresFourEyesApproval — threshold boundaries", () => {
  it("does not require approval just under the threshold", () => {
    expect(requiresFourEyesApproval("LOAN_SERVICING_TRANSFER", 49_999.99)).toBe(false);
  });

  it("requires approval exactly at the threshold", () => {
    expect(requiresFourEyesApproval("LOAN_SERVICING_TRANSFER", 50_000)).toBe(true);
  });

  it("requires approval above the threshold", () => {
    expect(requiresFourEyesApproval("LOAN_SERVICING_TRANSFER", 50_000.01)).toBe(true);
  });

  it("always requires approval for an action with no amount threshold, regardless of amount", () => {
    expect(requiresFourEyesApproval("SCORING_MODEL_UPDATE", 0)).toBe(true);
    expect(requiresFourEyesApproval("SCORING_MODEL_UPDATE", null)).toBe(true);
  });

  it("never requires approval for an unregistered action type", () => {
    expect(requiresFourEyesApproval("SOME_UNREGISTERED_ACTION", 1_000_000)).toBe(false);
  });

  it("treats a null/undefined amount as zero for amount-gated actions", () => {
    expect(requiresFourEyesApproval("LOAN_SERVICING_TRANSFER", null)).toBe(false);
  });
});

describe("createApprovalRequest", () => {
  it("persists the request and notifies every eligible approver except the requester", async () => {
    const request = await createApprovalRequest({
      actionType: "LOAN_SERVICING_TRANSFER",
      payload: { loanId: "loan-1" },
      amount: 75_000,
      requestedBy: REQUESTER,
    });

    expect(request.status).toBe("PENDING");
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "FOUR_EYES_REQUEST_CREATED", actorAddress: REQUESTER })
    );
    expect(createInAppNotificationMock).toHaveBeenCalledTimes(2);
    const notified = createInAppNotificationMock.mock.calls.map((c) => c[0].walletAddress);
    expect(notified.sort()).toEqual([APPROVER_A.toLowerCase(), APPROVER_B.toLowerCase()].sort());
  });

  it("never notifies the requester even if their own address is in the approver list", async () => {
    configOverrides.fourEyesApproverAddresses = [REQUESTER.toLowerCase(), APPROVER_A.toLowerCase()];

    await createApprovalRequest({
      actionType: "LOAN_SERVICING_TRANSFER",
      payload: {},
      amount: 75_000,
      requestedBy: REQUESTER,
    });

    const notified = createInAppNotificationMock.mock.calls.map((c) => c[0].walletAddress);
    expect(notified).toEqual([APPROVER_A.toLowerCase()]);
  });

  it("sets expiresAt according to the configured expiry window", async () => {
    configOverrides.fourEyesApprovalExpiryHours = 48;
    const before = Date.now();

    const request = await createApprovalRequest({
      actionType: "LOAN_SERVICING_TRANSFER",
      payload: {},
      amount: 75_000,
      requestedBy: REQUESTER,
    });

    const expectedMs = 48 * 60 * 60 * 1000;
    expect(request.expiresAt.getTime() - before).toBeGreaterThanOrEqual(expectedMs - 1000);
    expect(request.expiresAt.getTime() - before).toBeLessThanOrEqual(expectedMs + 5000);
  });
});

describe("self-approval rejection (acceptance criterion 2)", () => {
  it("rejects an approval attempt by the original requester", async () => {
    const request = await createApprovalRequest({
      actionType: "LOAN_SERVICING_TRANSFER",
      payload: {},
      amount: 75_000,
      requestedBy: REQUESTER,
    });

    await expect(approveRequest(request.id, REQUESTER)).rejects.toMatchObject({ code: "self_approval" });
    const stored = rows.find((r) => r.id === request.id)!;
    expect(stored.status).toBe("PENDING");
  });

  it("rejects a rejection attempt by the original requester too", async () => {
    const request = await createApprovalRequest({
      actionType: "LOAN_SERVICING_TRANSFER",
      payload: {},
      amount: 75_000,
      requestedBy: REQUESTER,
    });

    await expect(rejectRequest(request.id, REQUESTER, "changed my mind")).rejects.toMatchObject({
      code: "self_approval",
    });
  });

  it("is case-insensitive when comparing requester vs approver address", async () => {
    const request = await createApprovalRequest({
      actionType: "LOAN_SERVICING_TRANSFER",
      payload: {},
      amount: 75_000,
      requestedBy: REQUESTER.toLowerCase(),
    });

    await expect(approveRequest(request.id, REQUESTER.toUpperCase())).rejects.toMatchObject({
      code: "self_approval",
    });
  });

  it("succeeds when a distinct, eligible second admin approves", async () => {
    const request = await createApprovalRequest({
      actionType: "LOAN_SERVICING_TRANSFER",
      payload: {},
      amount: 75_000,
      requestedBy: REQUESTER,
    });

    const approved = await approveRequest(request.id, APPROVER_A);

    expect(approved.status).toBe("APPROVED");
    expect(approved.approvedBy).toBe(APPROVER_A);
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "FOUR_EYES_APPROVED" }));
  });

  it("rejects an approver who is a distinct admin but not on the eligible list", async () => {
    const request = await createApprovalRequest({
      actionType: "LOAN_SERVICING_TRANSFER",
      payload: {},
      amount: 75_000,
      requestedBy: REQUESTER,
    });
    const randomWallet = "GRANDOM00000000000000000000000000000000000000000000000";

    await expect(approveRequest(request.id, randomWallet)).rejects.toMatchObject({
      code: "not_eligible_approver",
    });
  });
});

describe("expiry (acceptance criterion 2)", () => {
  it("rejects approving a request past its expiry, and marks it EXPIRED", async () => {
    const request = await createApprovalRequest({
      actionType: "LOAN_SERVICING_TRANSFER",
      payload: {},
      amount: 75_000,
      requestedBy: REQUESTER,
    });
    rows.find((r) => r.id === request.id)!.expiresAt = new Date(Date.now() - 1000);

    await expect(approveRequest(request.id, APPROVER_A)).rejects.toMatchObject({ code: "expired" });

    const stored = rows.find((r) => r.id === request.id)!;
    expect(stored.status).toBe("EXPIRED");
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "FOUR_EYES_EXPIRED" }));
  });

  it("rejects rejecting a request past its expiry too", async () => {
    const request = await createApprovalRequest({
      actionType: "LOAN_SERVICING_TRANSFER",
      payload: {},
      amount: 75_000,
      requestedBy: REQUESTER,
    });
    rows.find((r) => r.id === request.id)!.expiresAt = new Date(Date.now() - 1000);

    await expect(rejectRequest(request.id, APPROVER_A, "too late")).rejects.toMatchObject({ code: "expired" });
  });

  it("does not expire a request still within its window", async () => {
    const request = await createApprovalRequest({
      actionType: "LOAN_SERVICING_TRANSFER",
      payload: {},
      amount: 75_000,
      requestedBy: REQUESTER,
    });

    const approved = await approveRequest(request.id, APPROVER_A);
    expect(approved.status).toBe("APPROVED");
  });

  it("the expiry sweep marks every overdue PENDING request as EXPIRED and leaves others untouched", async () => {
    const overdue = await createApprovalRequest({
      actionType: "LOAN_SERVICING_TRANSFER",
      payload: {},
      amount: 75_000,
      requestedBy: REQUESTER,
    });
    const current = await createApprovalRequest({
      actionType: "LOAN_SERVICING_TRANSFER",
      payload: {},
      amount: 75_000,
      requestedBy: REQUESTER,
    });
    rows.find((r) => r.id === overdue.id)!.expiresAt = new Date(Date.now() - 1000);

    const count = await expireDueApprovalRequests();

    expect(count).toBe(1);
    expect(rows.find((r) => r.id === overdue.id)!.status).toBe("EXPIRED");
    expect(rows.find((r) => r.id === current.id)!.status).toBe("PENDING");
  });
});

describe("other guards", () => {
  it("rejects acting on an already-approved request", async () => {
    const request = await createApprovalRequest({
      actionType: "LOAN_SERVICING_TRANSFER",
      payload: {},
      amount: 75_000,
      requestedBy: REQUESTER,
    });
    await approveRequest(request.id, APPROVER_A);

    await expect(approveRequest(request.id, APPROVER_B)).rejects.toMatchObject({ code: "not_pending" });
  });

  it("rejects acting on an unknown request id", async () => {
    await expect(approveRequest("missing", APPROVER_A)).rejects.toBeInstanceOf(FourEyesError);
    await expect(approveRequest("missing", APPROVER_A)).rejects.toMatchObject({ code: "not_found" });
  });

  it("requires a non-empty reason to reject", async () => {
    const request = await createApprovalRequest({
      actionType: "LOAN_SERVICING_TRANSFER",
      payload: {},
      amount: 75_000,
      requestedBy: REQUESTER,
    });

    await expect(rejectRequest(request.id, APPROVER_A, "")).rejects.toMatchObject({ code: "missing_reason" });
    await expect(rejectRequest(request.id, APPROVER_A, "   ")).rejects.toMatchObject({ code: "missing_reason" });
  });

  it("records a rejection with its reason", async () => {
    const request = await createApprovalRequest({
      actionType: "LOAN_SERVICING_TRANSFER",
      payload: {},
      amount: 75_000,
      requestedBy: REQUESTER,
    });

    const rejected = await rejectRequest(request.id, APPROVER_A, "Servicer not vetted yet");

    expect(rejected.status).toBe("REJECTED");
    expect(rejected.rejectionReason).toBe("Servicer not vetted yet");
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "FOUR_EYES_REJECTED", metadata: expect.objectContaining({ reason: "Servicer not vetted yet" }) })
    );
  });

  it("includes ADMIN_WALLET_ADDRESS as an eligible approver alongside the configured list", async () => {
    process.env.ADMIN_WALLET_ADDRESS = "GSOLEADMIN0000000000000000000000000000000000000000000";
    configOverrides.fourEyesApproverAddresses = [];

    const request = await createApprovalRequest({
      actionType: "LOAN_SERVICING_TRANSFER",
      payload: {},
      amount: 75_000,
      requestedBy: REQUESTER,
    });

    const approved = await approveRequest(request.id, process.env.ADMIN_WALLET_ADDRESS);
    expect(approved.status).toBe("APPROVED");
  });
});
