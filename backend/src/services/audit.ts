// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { prisma } from "./db.js";
import { logAuditEvent } from "../utils/logger.js";
import {
  GENESIS_PREV_HASH,
  computeChainHash,
  storedChainHash,
  withChainMetadata,
  type AuditMetadata,
} from "./auditChain.js";

/**
 * Resolves the hash the next audit entry must chain back to (the head of the
 * existing log). Best effort: if the lookup is unavailable, the entry chains
 * from genesis and verification will flag the gap.
 */
async function previousChainHash(): Promise<string> {
  try {
    if (typeof (prisma.auditLog as unknown as { findFirst?: unknown }).findFirst !== "function") {
      return GENESIS_PREV_HASH;
    }
    const latest = await prisma.auditLog.findFirst({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return (latest && storedChainHash(latest as never)) ?? GENESIS_PREV_HASH;
  } catch {
    return GENESIS_PREV_HASH;
  }
}

export async function logAudit(params: {
  action: string;
  actorAddress?: string;
  ipAddress?: string;
  metadata?: any;
}) {
  // Audit events are always kept by the log sampling policy (issue #875).
  logAuditEvent("Audit event", {
    action: params.action,
    actorAddress: params.actorAddress,
    ipAddress: params.ipAddress,
    metadata: params.metadata,
  });

  try {
    // Attach the tamper-evident chain fields (issue #861). `createdAt` is set
    // explicitly so the value that is hashed is exactly the value persisted.
    const createdAt = new Date();
    const prevHash = await previousChainHash();
    const chainHash = computeChainHash(
      {
        id: "",
        action: params.action,
        actorAddress: params.actorAddress ?? null,
        ipAddress: params.ipAddress ?? null,
        metadata: (params.metadata ?? {}) as AuditMetadata,
        createdAt,
      },
      prevHash
    );
    const metadata = withChainMetadata(params.metadata, chainHash, prevHash);

    // Fire and forget, don't await so we don't block the request.
    // .catch handles any promise rejections so the app doesn't crash.
    prisma.auditLog
      .create({
        data: {
          action: params.action,
          actorAddress: params.actorAddress,
          ipAddress: params.ipAddress,
          metadata,
          createdAt,
        },
      })
      .catch((err: unknown) => {
        console.error("Audit log persistence failed:", err);
      });
  } catch (error) {
    // Catch any immediate synchronous errors
    console.error("Audit log sync failure:", error);
  }
}
