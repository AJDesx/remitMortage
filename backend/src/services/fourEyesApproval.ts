// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Four-eyes approval queue for high-value admin actions (issue #841).
 *
 * `createApprovalRequest` is called by an admin route INSTEAD of performing
 * the action immediately, whenever `fourEyesPolicy.ts` says the action/amount
 * requires it. The route's exact arguments are stored as `payload` so the
 * same action can be replayed verbatim once a distinct second admin calls
 * `approveRequest`. Every request, approval, rejection and expiry is written
 * to the audit trail.
 */

import { prisma } from "./db.js";
import { logAudit } from "./audit.js";
import { createInAppNotification } from "./db.js";
import { loadConfig } from "../config.js";
import logger from "../utils/logger.js";
import { getActionDefinition } from "./fourEyesPolicy.js";

export type FourEyesErrorCode =
  | "not_found"
  | "not_pending"
  | "expired"
  | "self_approval"
  | "not_eligible_approver"
  | "missing_reason";

export class FourEyesError extends Error {
  constructor(message: string, public readonly code: FourEyesErrorCode) {
    super(message);
  }
}

export interface CreateApprovalRequestInput {
  actionType: string;
  payload: Record<string, unknown>;
  amount?: number | null;
  requestedBy: string;
}

function isExpired(request: { expiresAt: Date }): boolean {
  return request.expiresAt.getTime() <= Date.now();
}

/** Every wallet address allowed to approve a request, lowercased, de-duplicated. */
function eligibleApproverAddresses(): string[] {
  const config = loadConfig();
  const addresses = new Set<string>(config.fourEyesApproverAddresses);
  const adminWallet = process.env.ADMIN_WALLET_ADDRESS?.toLowerCase();
  if (adminWallet) addresses.add(adminWallet);
  return Array.from(addresses);
}

function isEligibleApprover(address: string): boolean {
  return eligibleApproverAddresses().includes(address.toLowerCase());
}

export async function createApprovalRequest(input: CreateApprovalRequestInput) {
  const def = getActionDefinition(input.actionType);
  const expiresAt = new Date(Date.now() + loadConfig().fourEyesApprovalExpiryHours * 60 * 60 * 1000);

  const request = await prisma.fourEyesApprovalRequest.create({
    data: {
      actionType: input.actionType,
      payload: input.payload as any,
      amount: input.amount ?? null,
      requestedBy: input.requestedBy,
      expiresAt,
    },
  });

  await logAudit({
    action: "FOUR_EYES_REQUEST_CREATED",
    actorAddress: input.requestedBy,
    metadata: { requestId: request.id, actionType: input.actionType, amount: input.amount ?? null },
  });

  await notifyEligibleApprovers(request.id, input.actionType, def?.description ?? input.actionType, input.requestedBy);

  return request;
}

async function notifyEligibleApprovers(
  requestId: string,
  actionType: string,
  description: string,
  requestedBy: string
): Promise<void> {
  const approvers = eligibleApproverAddresses().filter((addr) => addr !== requestedBy.toLowerCase());
  for (const approver of approvers) {
    try {
      await createInAppNotification({
        walletAddress: approver,
        title: "Approval needed: high-value admin action",
        message: `${description} is pending your approval (requested by ${requestedBy}).`,
        variant: "warning",
        metadata: { type: "FOUR_EYES_APPROVAL_REQUESTED", requestId, actionType },
      });
    } catch (err) {
      // Best-effort — a notification failure must never block the request
      // from existing in the queue.
      logger.warn("[four-eyes] Failed to notify eligible approver", { approver, requestId, err });
    }
  }
}

export async function getApprovalRequest(id: string) {
  return prisma.fourEyesApprovalRequest.findUnique({ where: { id } });
}

export async function listPendingApprovalRequests(limit = 100) {
  return prisma.fourEyesApprovalRequest.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
}

/**
 * Validates and records an approval decision. Does NOT execute the action —
 * callers execute the stored `payload` themselves after this resolves, then
 * mark it executed via `markExecuted`, so a failure partway through
 * execution never looks like it was silently approved without a record.
 */
export async function approveRequest(id: string, approverAddress: string) {
  const request = await requirePendingAndNotSelf(id, approverAddress);

  if (!isEligibleApprover(approverAddress)) {
    throw new FourEyesError("This address is not an eligible approver.", "not_eligible_approver");
  }

  const updated = await prisma.fourEyesApprovalRequest.update({
    where: { id },
    data: { status: "APPROVED", approvedBy: approverAddress, approvedAt: new Date() },
  });

  await logAudit({
    action: "FOUR_EYES_APPROVED",
    actorAddress: approverAddress,
    metadata: { requestId: id, actionType: request.actionType, requestedBy: request.requestedBy },
  });

  return updated;
}

export async function rejectRequest(id: string, approverAddress: string, reason: string) {
  if (!reason || !reason.trim()) {
    throw new FourEyesError("A rejection reason is required.", "missing_reason");
  }

  const request = await requirePendingAndNotSelf(id, approverAddress);

  if (!isEligibleApprover(approverAddress)) {
    throw new FourEyesError("This address is not an eligible approver.", "not_eligible_approver");
  }

  const updated = await prisma.fourEyesApprovalRequest.update({
    where: { id },
    data: {
      status: "REJECTED",
      rejectedBy: approverAddress,
      rejectedAt: new Date(),
      rejectionReason: reason.trim(),
    },
  });

  await logAudit({
    action: "FOUR_EYES_REJECTED",
    actorAddress: approverAddress,
    metadata: { requestId: id, actionType: request.actionType, requestedBy: request.requestedBy, reason: reason.trim() },
  });

  return updated;
}

/**
 * Shared guard for approve/reject: the request must exist, still be
 * PENDING, not have expired (expiring it on the way out if so), and the
 * caller must not be the original requester.
 */
async function requirePendingAndNotSelf(id: string, callerAddress: string) {
  const request = await prisma.fourEyesApprovalRequest.findUnique({ where: { id } });
  if (!request) {
    throw new FourEyesError("Approval request not found.", "not_found");
  }
  if (request.status !== "PENDING") {
    throw new FourEyesError(`Request is already ${request.status.toLowerCase()}.`, "not_pending");
  }
  if (isExpired(request)) {
    await expireOne(request.id);
    throw new FourEyesError("This request has expired.", "expired");
  }
  if (request.requestedBy.toLowerCase() === callerAddress.toLowerCase()) {
    throw new FourEyesError("You cannot approve or reject your own request.", "self_approval");
  }
  return request;
}

export async function markExecuted(id: string) {
  return prisma.fourEyesApprovalRequest.update({
    where: { id },
    data: { executedAt: new Date() },
  });
}

async function expireOne(id: string) {
  await prisma.fourEyesApprovalRequest.update({
    where: { id },
    data: { status: "EXPIRED" },
  });
  await logAudit({ action: "FOUR_EYES_EXPIRED", metadata: { requestId: id } });
}

/**
 * Sweeps every PENDING request past its expiry and marks it EXPIRED. Run on
 * a schedule (jobs/fourEyesApprovalExpiry.ts) so a request that nobody acts
 * on doesn't sit "approvable" forever — expiry is enforced lazily on
 * approve/reject too, but the sweep makes it visible in the queue listing
 * without waiting for someone to try acting on it.
 */
export async function expireDueApprovalRequests(): Promise<number> {
  const due = await prisma.fourEyesApprovalRequest.findMany({
    where: { status: "PENDING", expiresAt: { lte: new Date() } },
    select: { id: true },
  });
  for (const { id } of due) {
    await expireOne(id);
  }
  return due.length;
}
