// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Scheduled verification of the tamper-evident audit-log hash chain (issue #861).
 *
 * Recomputes the chain over a rolling window and raises an alert when it does
 * not verify, so an altered or deleted audit row is detected without waiting
 * for an on-demand request.
 */

import logger from "../utils/logger.js";
import { verifyAuditRange, type ChainVerification } from "../services/auditChain.js";

export async function runAuditChainVerificationJob(
  windowHours = Number(process.env.AUDIT_CHAIN_VERIFY_WINDOW_HOURS || 24)
): Promise<ChainVerification> {
  const from = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  const result = await verifyAuditRange({ from });

  if (!result.ok) {
    logger.error("[audit-chain] verification FAILED — audit log may have been tampered with", {
      windowHours,
      verified: result.verified,
      brokenAt: result.brokenAt,
    });
  } else {
    logger.info("[audit-chain] verification passed", {
      windowHours,
      verified: result.verified,
      head: result.head,
    });
  }

  return result;
}
