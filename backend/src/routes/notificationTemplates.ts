// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Notification template versioning admin surface (issue #825). Operator-only,
 * mounted under /api/admin:
 *   GET  /api/admin/notification-templates                          — templates, allowed variables, live version per locale
 *   GET  /api/admin/notification-templates/:key/versions?locale=    — version history, newest first
 *   POST /api/admin/notification-templates/:key/versions            — create a draft
 *   PUT  /api/admin/notification-templates/versions/:versionId      — edit a draft
 *   POST /api/admin/notification-templates/versions/:versionId/publish
 *   POST /api/admin/notification-templates/:key/preview             — render with sample data
 *   POST /api/admin/notification-templates/:key/rollback            — restore an earlier live version
 */

import { Router, Response } from "express";
import { requireAdmin, type AuthenticatedRequest } from "../middleware/auth.js";
import {
  createDraft,
  updateDraft,
  publishVersion,
  rollbackTemplate,
  previewTemplate,
  listVersions,
  listTemplates,
  NotificationTemplateError,
} from "../services/notificationTemplates.js";
import logger from "../utils/logger.js";

export const notificationTemplatesAdminRouter = Router();

function actorOf(req: AuthenticatedRequest) {
  return { actor: req.user?.walletAddress ?? "admin-api-key", ipAddress: req.ip };
}

function handleError(err: unknown, res: Response, logMessage: string, fallbackCode: string) {
  if (err instanceof NotificationTemplateError) {
    return res
      .status(err.httpStatus)
      .json({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
  }
  logger.error(logMessage, { err });
  return res.status(500).json({ error: fallbackCode });
}

const BASE = "/notification-templates";

notificationTemplatesAdminRouter.get(BASE, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json({ templates: await listTemplates() });
  } catch (err) {
    return handleError(err, res, "Notification template list failed", "failed_to_list_templates");
  }
});

notificationTemplatesAdminRouter.get(`${BASE}/:key/versions`, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const locale = typeof req.query.locale === "string" ? req.query.locale : undefined;
    return res.json({ versions: await listVersions(String(req.params.key), locale) });
  } catch (err) {
    return handleError(err, res, "Notification template versions failed", "failed_to_list_versions");
  }
});

notificationTemplatesAdminRouter.post(`${BASE}/:key/versions`, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const body = req.body ?? {};
  try {
    const draft = await createDraft({
      key: String(req.params.key),
      locale: body.locale,
      subject: body.subject,
      body: body.body,
      changeNote: body.changeNote,
      ...actorOf(req),
    });
    return res.status(201).json(draft);
  } catch (err) {
    return handleError(err, res, "Notification template draft failed", "template_draft_failed");
  }
});

notificationTemplatesAdminRouter.put(`${BASE}/versions/:versionId`, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const body = req.body ?? {};
  try {
    const updated = await updateDraft({
      versionId: String(req.params.versionId),
      subject: body.subject,
      body: body.body,
      changeNote: body.changeNote,
      ...actorOf(req),
    });
    return res.json(updated);
  } catch (err) {
    return handleError(err, res, "Notification template update failed", "template_update_failed");
  }
});

notificationTemplatesAdminRouter.post(
  `${BASE}/versions/:versionId/publish`,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const published = await publishVersion({ versionId: String(req.params.versionId), ...actorOf(req) });
      return res.json(published);
    } catch (err) {
      return handleError(err, res, "Notification template publish failed", "template_publish_failed");
    }
  }
);

notificationTemplatesAdminRouter.post(`${BASE}/:key/preview`, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const body = req.body ?? {};
  try {
    return res.json(
      await previewTemplate({
        key: String(req.params.key),
        versionId: body.versionId,
        subject: body.subject,
        body: body.body,
        sampleData: body.sampleData,
      })
    );
  } catch (err) {
    return handleError(err, res, "Notification template preview failed", "template_preview_failed");
  }
});

notificationTemplatesAdminRouter.post(`${BASE}/:key/rollback`, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const body = req.body ?? {};
  try {
    const restored = await rollbackTemplate({
      key: String(req.params.key),
      locale: body.locale,
      toVersion: body.toVersion,
      reason: body.reason,
      ...actorOf(req),
    });
    return res.json(restored);
  } catch (err) {
    return handleError(err, res, "Notification template rollback failed", "template_rollback_failed");
  }
});
