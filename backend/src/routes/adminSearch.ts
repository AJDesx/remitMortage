// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Admin full-text search (issue #826). Operator-only, mounted under /api/admin:
 *   GET /api/admin/search?q=&entities=loans,applicants,documents&page=&pageSize=
 */

import { Router, Response } from "express";
import { requireAdmin, type AuthenticatedRequest } from "../middleware/auth.js";
import { adminSearch, AdminSearchError } from "../services/adminSearch.js";
import logger from "../utils/logger.js";

export const adminSearchRouter = Router();

/**
 * @openapi
 * /api/admin/search:
 *   get:
 *     summary: Full-text search across loans, applicants and KYC documents
 *     description: >
 *       Relevance-ranked, paginated results limited to the record types the
 *       caller may see. Results carry masked, PII-safe snippets and ids only.
 *       Every search is recorded in the audit log.
 *     tags:
 *       - Admin
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string, maxLength: 100 }
 *         description: Words to find; each matches as a prefix ("smi" finds "Smith").
 *       - in: query
 *         name: entities
 *         schema: { type: string, example: "loans,applicants" }
 *         description: Comma-separated subset of loans, applicants, documents.
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, minimum: 1, maximum: 50, default: 20 }
 *     responses:
 *       200:
 *         description: Ranked results.
 *       400:
 *         description: Invalid query or pagination.
 *       403:
 *         description: A requested record type is not permitted for this caller.
 */
adminSearchRouter.get("/search", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const wallet = req.user?.walletAddress;
  try {
    const result = await adminSearch({
      query: req.query.q,
      entities: req.query.entities,
      page: req.query.page,
      pageSize: req.query.pageSize,
      caller: {
        // requireAdmin sets req.user only for wallet sessions; the static key leaves it unset.
        kind: wallet ? "wallet" : "api-key",
        actor: wallet ?? "admin-api-key",
        ipAddress: req.ip,
      },
    });
    return res.json(result);
  } catch (err) {
    if (err instanceof AdminSearchError) {
      return res
        .status(err.httpStatus)
        .json({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
    }
    logger.error("Admin search failed", { err });
    return res.status(500).json({ error: "search_failed" });
  }
});
