// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Signed ChatOps acknowledgement callbacks (issue #860).
 *
 * Slack and Teams POST an interactive action back when an operator clicks
 * "Acknowledge". Both providers sign the raw request body; the callback is only
 * honoured when the signature verifies, so a forged acknowledgement cannot
 * silently clear an alert.
 */

import { Router, Request, Response } from "express";
import { chatOps, ChatOpsProvider } from "../services/chatOps.js";
import logger from "../utils/logger.js";

export const chatOpsRouter = Router();

function withRawBody(req: Request): string {
  const captured = (req as Request & { rawBody?: string }).rawBody;
  if (typeof captured === "string") return captured;
  return JSON.stringify(req.body ?? {});
}

chatOpsRouter.post("/:provider/actions", (req: Request, res: Response) => {
  const provider = req.params.provider === "teams" ? "teams" : "slack";
  const result = chatOps.handleAck(provider as ChatOpsProvider, {
    headers: req.headers as Record<string, string | string[] | undefined>,
    rawBody: withRawBody(req),
  });

  if (!result.ok) {
    logger.warn("[chatops] rejected acknowledgement callback", {
      provider,
      error: result.error,
    });
    return res.status(result.status).json({ error: result.error });
  }

  return res.status(200).json({ ok: true, alertId: result.alertId });
});
