// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Router } from "express";
import { authMiddleware, requireAdmin, AuthenticatedRequest } from "../middleware/auth.js";
import {
  publishTosVersion,
  recordAcceptance,
  checkReConsentRequired,
  getCurrentVersion,
  getTosVersion,
  versionsRequiringReConsentSince,
} from "../services/termsOfService.js";

export const tosRouter = Router();

/**
 * GET /api/tos/current
 * Returns the current TOS version metadata (public — no auth required).
 */
tosRouter.get("/current", (_req, res) => {
  const current = getCurrentVersion();
  if (!current) {
    return res.status(404).json({ error: "No TOS version published yet" });
  }
  return res.json(current);
});

/**
 * GET /api/tos/versions/:version
 * Returns metadata for a specific TOS version.
 */
tosRouter.get("/versions/:version", (req, res) => {
  const { version } = req.params;
  const v = getTosVersion(version);
  if (!v) return res.status(404).json({ error: `Version ${version} not found` });
  return res.json(v);
});

/**
 * GET /api/tos/status
 * Returns whether the authenticated user needs to (re-)accept the current TOS.
 */
tosRouter.get("/status", authMiddleware, (req: AuthenticatedRequest, res) => {
  const walletAddress = req.user?.walletAddress;
  if (!walletAddress) return res.status(401).json({ error: "Unauthenticated" });

  const status = checkReConsentRequired(walletAddress);
  return res.json(status);
});

/**
 * GET /api/tos/pending-versions
 * Returns a list of TOS versions newer than the caller's last acceptance that
 * require explicit re-consent, with their change summaries, so the frontend
 * can display a changelog prompt before the user re-consents.
 */
tosRouter.get("/pending-versions", authMiddleware, (req: AuthenticatedRequest, res) => {
  const walletAddress = req.user?.walletAddress;
  if (!walletAddress) return res.status(401).json({ error: "Unauthenticated" });

  const status = checkReConsentRequired(walletAddress);
  if (!status.acceptedVersion) {
    const current = getCurrentVersion();
    return res.json({ versions: current ? [current] : [] });
  }

  const pending = versionsRequiringReConsentSince(status.acceptedVersion);
  return res.json({ versions: pending });
});

/**
 * POST /api/tos/accept
 * Records the authenticated user's acceptance of a specific TOS version.
 */
tosRouter.post("/accept", authMiddleware, (req: AuthenticatedRequest, res) => {
  const walletAddress = req.user?.walletAddress;
  if (!walletAddress) return res.status(401).json({ error: "Unauthenticated" });

  const { version, consentMethod } = req.body as {
    version?: string;
    consentMethod?: "explicit_checkbox" | "api";
  };

  if (!version) {
    return res.status(400).json({ error: "'version' is required" });
  }

  try {
    const acceptance = recordAcceptance(walletAddress, version, {
      ipAddress: req.ip ?? undefined,
      userAgent: req.headers["user-agent"] ?? undefined,
      consentMethod: consentMethod ?? "explicit_checkbox",
    });
    return res.status(201).json(acceptance);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("Unknown TOS version")) {
      return res.status(400).json({ error: message });
    }
    return res.status(500).json({ error: "Failed to record acceptance" });
  }
});

/**
 * POST /api/tos/versions
 * Admin publishes a new TOS version.
 */
tosRouter.post(
  "/versions",
  authMiddleware,
  requireAdmin,
  (req: AuthenticatedRequest, res) => {
    const { version, effectiveAt, summary, requiresReConsent, docText } =
      req.body as {
        version?: string;
        effectiveAt?: string;
        summary?: string;
        requiresReConsent?: boolean;
        docText?: string;
      };

    if (!version || !effectiveAt || !summary || !docText) {
      return res.status(400).json({
        error: "'version', 'effectiveAt', 'summary', and 'docText' are required",
      });
    }

    const effectiveDate = new Date(effectiveAt);
    if (isNaN(effectiveDate.getTime())) {
      return res.status(400).json({ error: "Invalid 'effectiveAt' date" });
    }

    const published = publishTosVersion(
      {
        version,
        effectiveAt: effectiveDate,
        summary,
        requiresReConsent: requiresReConsent ?? true,
      },
      docText
    );

    return res.status(201).json(published);
  }
);
