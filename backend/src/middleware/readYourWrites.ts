// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import type { NextFunction, Request, Response } from "express";
import { recordSessionWrite } from "../services/readYourWrites.js";

type RequestWithUser = Request & {
  user?: { walletAddress?: string };
};

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Return a stable authenticated session key; tokens are hashed before storage. */
export function readYourWritesSessionKey(req: Request): string | undefined {
  const request = req as RequestWithUser;
  const authorization = req.headers.authorization;
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : undefined;
  return request.cookies?.token || bearer || request.user?.walletAddress;
}

/** Mark successful authenticated mutations so later reads can avoid lagging replicas. */
export function readYourWritesMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const sessionKey = readYourWritesSessionKey(req);
  if (!sessionKey || READ_METHODS.has(req.method.toUpperCase())) {
    next();
    return;
  }

  res.on("finish", () => {
    if (res.statusCode >= 200 && res.statusCode < 400) {
      recordSessionWrite(sessionKey);
    }
  });
  next();
}
