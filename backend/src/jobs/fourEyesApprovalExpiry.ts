// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Scheduled sweep expiring overdue four-eyes approval requests (issue #841).
 * Expiry is also enforced lazily on approve/reject, but this keeps the
 * pending-queue listing accurate without anyone needing to try acting on a
 * stale request first.
 */

import logger from "../utils/logger.js";
import { expireDueApprovalRequests } from "../services/fourEyesApproval.js";

export async function runFourEyesApprovalExpiryJob(): Promise<{ expired: number }> {
  const expired = await expireDueApprovalRequests();
  if (expired > 0) {
    logger.info(`[four-eyes] Expired ${expired} overdue approval request(s).`);
  }
  return { expired };
}
