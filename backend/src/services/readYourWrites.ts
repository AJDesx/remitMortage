// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { Counter } from "prom-client";
import { getRedisClient } from "./redis.js";

const MARKER_PREFIX = "db:read-your-writes:";
const localWrites = new Map<string, number>();
const FALLBACK_TTL_SECONDS = 120;

export const readYourWritesPrimaryFallbacks = new Counter({
  name: "remitmortgage_read_your_writes_primary_fallbacks_total",
  help: "Reads routed to the primary while a session write may not be replicated.",
});

function markerKey(sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex");
  return `${MARKER_PREFIX}${digest}`;
}

function markerTtlSeconds(): number {
  const configured = Number(process.env.READ_YOUR_WRITES_WINDOW_SECONDS);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : FALLBACK_TTL_SECONDS;
}

export function readYourWritesEnabled(): boolean {
  return process.env.READ_YOUR_WRITES_ENABLED !== "false";
}

/** True until the replica's replay timestamp has passed this session's write. */
export function replicaHasCaughtUp(
  lastWriteAt: number,
  replicaLagSeconds: number,
  now = Date.now()
): boolean {
  return Number.isFinite(lastWriteAt) &&
    Number.isFinite(replicaLagSeconds) &&
    replicaLagSeconds >= 0 &&
    now - lastWriteAt >= replicaLagSeconds * 1000;
}

/** Record a successful write for the authenticated wallet/session. */
export function recordSessionWrite(sessionId: string, writtenAt = Date.now()): void {
  if (!readYourWritesEnabled() || !sessionId) return;

  const key = markerKey(sessionId);
  localWrites.set(key, writtenAt);
  const ttlSeconds = markerTtlSeconds();
  const redis = getRedisClient();
  if (redis) {
    void redis.setex(key, ttlSeconds, String(writtenAt)).catch(() => undefined);
  }
}

/**
 * Choose the primary while this session's latest successful write may still
 * be missing from the replica. Redis shares markers between API instances;
 * the in-process copy keeps single-instance deployments safe if Redis is off.
 */
export async function shouldReadFromPrimary(
  sessionId: string | undefined,
  replicaLagSeconds: number | null,
  now = Date.now()
): Promise<boolean> {
  if (!readYourWritesEnabled() || !sessionId) return false;

  const key = markerKey(sessionId);
  const ttlMs = markerTtlSeconds() * 1000;
  let lastWriteAt = localWrites.get(key);
  const redis = getRedisClient();
  if (redis) {
    try {
      const value = await redis.get(key);
      const parsed = value === null ? undefined : Number(value);
      if (Number.isFinite(parsed)) lastWriteAt = Math.max(lastWriteAt ?? 0, parsed!);
    } catch {
      // The in-process marker remains a safe fallback for this instance.
    }
  }

  if (lastWriteAt === undefined || now - lastWriteAt >= ttlMs) {
    localWrites.delete(key);
    return false;
  }

  if (replicaLagSeconds !== null && replicaHasCaughtUp(lastWriteAt, replicaLagSeconds, now)) {
    localWrites.delete(key);
    if (redis) void redis.del(key).catch(() => undefined);
    return false;
  }

  readYourWritesPrimaryFallbacks.inc();
  return true;
}

/** Reset local state for isolated tests. */
export function clearReadYourWritesMarkers(): void {
  localWrites.clear();
}
