// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import crypto from "crypto";
import { prisma } from "./db.js";
import { queueService } from "./queueService.js";
import { logAudit } from "./audit.js";
import { getCacheValue, setCacheValue } from "./redis.js";
import logger from "../utils/logger.js";
import type { EventTopic } from "./webhook.js";

/** Hard cap on the replay time window per request. */
export const MAX_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1_000; // 24 h

/** How many window-replay requests a single subscription may make per hour. */
export const REPLAY_RATE_LIMIT = 5;
const REPLAY_RATE_LIMIT_WINDOW_SECONDS = 3_600;

/** Maximum deliveries queued in a single replay request. */
export const MAX_DELIVERIES_PER_REPLAY = 500;

export interface ReplayWindowRequest {
  subscriptionId: string;
  from: Date;
  to: Date;
  topics?: EventTopic[];
  requestorAddress?: string;
}

export interface ReplayWindowResult {
  requestId: string;
  queued: number;
  skipped: number;
  cappedAt: number | null;
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

function rateLimitKey(subscriptionId: string): string {
  return `replay_rate:${subscriptionId}`;
}

export async function checkAndIncrementRateLimit(
  subscriptionId: string
): Promise<{ allowed: boolean; remaining: number }> {
  const key = rateLimitKey(subscriptionId);
  try {
    const current = (await getCacheValue<number>(key)) ?? 0;
    if (current >= REPLAY_RATE_LIMIT) {
      return { allowed: false, remaining: 0 };
    }
    await setCacheValue(key, current + 1, REPLAY_RATE_LIMIT_WINDOW_SECONDS);
    return { allowed: true, remaining: REPLAY_RATE_LIMIT - current - 1 };
  } catch {
    logger.warn("[webhookReplay] rate-limit check unavailable, allowing request");
    return { allowed: true, remaining: REPLAY_RATE_LIMIT - 1 };
  }
}

// ── Replay ────────────────────────────────────────────────────────────────────

/**
 * Queues a re-delivery of every event a subscriber received in the given time
 * window, scoped strictly to their own subscription.  Each job is enqueued
 * through the normal delivery queue so replays cannot starve live traffic.
 *
 * Each replayed delivery carries:
 *   - Original event ID in the payload (`replayOf`)
 *   - The replay-request correlation ID (`replayRequestId`)
 *   - `X-Webhook-Replay: true` header (added by the worker / dispatcher)
 */
export async function replayEventWindow(
  req: ReplayWindowRequest
): Promise<ReplayWindowResult> {
  const windowMs = req.to.getTime() - req.from.getTime();

  if (windowMs <= 0) {
    throw new Error("'to' must be after 'from'");
  }
  if (windowMs > MAX_REPLAY_WINDOW_MS) {
    throw new Error(
      `Replay window cannot exceed ${MAX_REPLAY_WINDOW_MS / 3_600_000} hours`
    );
  }

  const { allowed } = await checkAndIncrementRateLimit(req.subscriptionId);
  if (!allowed) {
    throw new Error(
      "Replay rate limit exceeded — maximum 5 window-replay requests per subscription per hour"
    );
  }

  const where: Record<string, unknown> = {
    subscriptionId: req.subscriptionId, // scope to caller's own subscription
    createdAt: { gte: req.from, lte: req.to },
  };
  if (req.topics && req.topics.length > 0) {
    where.topic = { in: req.topics };
  }

  const deliveries = await prisma.webhookDelivery.findMany({
    where,
    orderBy: { createdAt: "asc" },
    take: MAX_DELIVERIES_PER_REPLAY,
    select: {
      id: true,
      topic: true,
      payload: true,
      subscriptionId: true,
      subscription: {
        select: {
          url: true,
          secret: true,
          status: true,
          webhookSchemaVersion: true,
        },
      },
    },
  });

  const requestId = crypto.randomUUID();
  let queued = 0;
  let skipped = 0;

  for (const delivery of deliveries) {
    const sub = delivery.subscription as {
      url: string;
      secret: string;
      status: string;
      webhookSchemaVersion: number;
    };

    if (sub.status === "revoked") {
      skipped++;
      continue;
    }

    try {
      await queueService.addWebhookJob(
        {
          subscriptionId: delivery.subscriptionId,
          url: sub.url,
          encryptedSecret: sub.secret,
          topic: delivery.topic as EventTopic,
          data: (delivery.payload as any).data,
          webhookSchemaVersion: sub.webhookSchemaVersion ?? 2,
          // Replay metadata forwarded to the worker so it can set the header
          replayOf: delivery.id,
          replayRequestId: requestId,
        } as any,
        { priority: 10 } // lower priority than live traffic
      );
      queued++;
    } catch (err) {
      logger.error("[webhookReplay] failed to enqueue replay job", {
        deliveryId: delivery.id,
        error: err instanceof Error ? err.message : String(err),
      });
      skipped++;
    }
  }

  const cappedAt =
    deliveries.length === MAX_DELIVERIES_PER_REPLAY
      ? MAX_DELIVERIES_PER_REPLAY
      : null;

  logAudit({
    action: "webhook.replay_window_requested",
    actorAddress: req.requestorAddress,
    metadata: {
      subscriptionId: req.subscriptionId,
      requestId,
      from: req.from.toISOString(),
      to: req.to.toISOString(),
      topics: req.topics ?? null,
      queued,
      skipped,
      cappedAt,
    },
  });

  return { requestId, queued, skipped, cappedAt };
}
