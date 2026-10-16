// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

jest.mock("../services/db.js");
jest.mock("../services/queueService.js");
jest.mock("../services/audit.js");
jest.mock("../services/redis.js");
jest.mock("../utils/logger.js", () => ({
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import { prisma } from "../services/db.js";
import { queueService } from "../services/queueService.js";
import { getCacheValue, setCacheValue } from "../services/redis.js";
import { logAudit } from "../services/audit.js";
import {
  replayEventWindow,
  checkAndIncrementRateLimit,
  MAX_REPLAY_WINDOW_MS,
  MAX_DELIVERIES_PER_REPLAY,
  REPLAY_RATE_LIMIT,
} from "../services/webhookReplayWindow.js";

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockGetCacheValue = getCacheValue as jest.Mock;
const mockSetCacheValue = setCacheValue as jest.Mock;
const mockAddWebhookJob = queueService.addWebhookJob as jest.Mock;
const mockLogAudit = logAudit as jest.Mock;

const SUB_ID = "sub-abc";
const now = new Date("2026-10-01T12:00:00Z");
const from = new Date("2026-10-01T06:00:00Z");
const to = new Date("2026-10-01T12:00:00Z");

function makeDelivery(id: string, topic = "deposit", status = "active") {
  return {
    id,
    topic,
    payload: { deliveryId: id, topic, timestamp: 1, data: { contractId: "C1", borrower: "B1", amount: "100", ledger: 1 } },
    subscriptionId: SUB_ID,
    subscription: { url: "https://example.com/hook", secret: "enc_secret", status, webhookSchemaVersion: 2 },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: rate limit not hit
  mockGetCacheValue.mockResolvedValue(null);
  mockSetCacheValue.mockResolvedValue(undefined);
  mockAddWebhookJob.mockResolvedValue(undefined);
  mockLogAudit.mockImplementation(() => {});
  (mockPrisma.webhookDelivery as any) = { findMany: jest.fn() };
});

// ── Window validation ──────────────────────────────────────────────────────

describe("replayEventWindow – window validation", () => {
  it("rejects a window where 'to' is before 'from'", async () => {
    await expect(
      replayEventWindow({ subscriptionId: SUB_ID, from: to, to: from })
    ).rejects.toThrow("'to' must be after 'from'");
  });

  it("rejects a window exceeding 24 hours", async () => {
    const bigTo = new Date(from.getTime() + MAX_REPLAY_WINDOW_MS + 1);
    await expect(
      replayEventWindow({ subscriptionId: SUB_ID, from, to: bigTo })
    ).rejects.toThrow("cannot exceed");
  });

  it("accepts a window exactly at the 24 h limit", async () => {
    const exactly24h = new Date(from.getTime() + MAX_REPLAY_WINDOW_MS);
    (prisma.webhookDelivery.findMany as jest.Mock).mockResolvedValue([]);
    await expect(
      replayEventWindow({ subscriptionId: SUB_ID, from, to: exactly24h })
    ).resolves.toBeDefined();
  });
});

// ── Scoping to caller's own subscription ──────────────────────────────────

describe("replayEventWindow – subscription scoping", () => {
  it("only queries deliveries belonging to the requested subscription", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    (prisma.webhookDelivery as any) = { findMany };

    await replayEventWindow({ subscriptionId: SUB_ID, from, to });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ subscriptionId: SUB_ID }),
      })
    );
  });

  it("filters by topic when provided", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    (prisma.webhookDelivery as any) = { findMany };

    await replayEventWindow({ subscriptionId: SUB_ID, from, to, topics: ["deposit"] });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ topic: { in: ["deposit"] } }),
      })
    );
  });
});

// ── Queuing and replay flags ───────────────────────────────────────────────

describe("replayEventWindow – queuing", () => {
  it("queues each delivery through the existing job queue", async () => {
    (prisma.webhookDelivery.findMany as jest.Mock).mockResolvedValue([
      makeDelivery("d-1"),
      makeDelivery("d-2"),
    ]);

    const result = await replayEventWindow({ subscriptionId: SUB_ID, from, to });

    expect(mockAddWebhookJob).toHaveBeenCalledTimes(2);
    expect(result.queued).toBe(2);
    expect(result.skipped).toBe(0);
  });

  it("passes original delivery ID as replayOf in the job data", async () => {
    (prisma.webhookDelivery.findMany as jest.Mock).mockResolvedValue([makeDelivery("d-original")]);

    await replayEventWindow({ subscriptionId: SUB_ID, from, to });

    const jobData = mockAddWebhookJob.mock.calls[0][0];
    expect(jobData.replayOf).toBe("d-original");
    expect(jobData.replayRequestId).toEqual(expect.any(String));
  });

  it("skips revoked subscriptions and counts them in skipped", async () => {
    (prisma.webhookDelivery.findMany as jest.Mock).mockResolvedValue([
      makeDelivery("d-1", "deposit", "revoked"),
    ]);

    const result = await replayEventWindow({ subscriptionId: SUB_ID, from, to });

    expect(mockAddWebhookJob).not.toHaveBeenCalled();
    expect(result.queued).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("reports cappedAt when the delivery count hits MAX_DELIVERIES_PER_REPLAY", async () => {
    const deliveries = Array.from({ length: MAX_DELIVERIES_PER_REPLAY }, (_, i) =>
      makeDelivery(`d-${i}`)
    );
    (prisma.webhookDelivery.findMany as jest.Mock).mockResolvedValue(deliveries);

    const result = await replayEventWindow({ subscriptionId: SUB_ID, from, to });

    expect(result.cappedAt).toBe(MAX_DELIVERIES_PER_REPLAY);
  });
});

// ── Rate limiting ──────────────────────────────────────────────────────────

describe("replayEventWindow – rate limiting", () => {
  it("rejects when the rate limit is exhausted", async () => {
    mockGetCacheValue.mockResolvedValue(REPLAY_RATE_LIMIT); // already at max

    await expect(
      replayEventWindow({ subscriptionId: SUB_ID, from, to })
    ).rejects.toThrow("rate limit exceeded");
  });

  it("allows requests below the rate limit and increments the counter", async () => {
    mockGetCacheValue.mockResolvedValue(2); // 2 out of 5 used
    (prisma.webhookDelivery.findMany as jest.Mock).mockResolvedValue([]);

    const result = await replayEventWindow({ subscriptionId: SUB_ID, from, to });

    expect(result).toBeDefined();
    expect(mockSetCacheValue).toHaveBeenCalledWith(
      `replay_rate:${SUB_ID}`,
      3,
      expect.any(Number)
    );
  });
});

// ── Audit trail ───────────────────────────────────────────────────────────

describe("replayEventWindow – audit trail", () => {
  it("records a replay_window_requested audit entry with the request metadata", async () => {
    (prisma.webhookDelivery.findMany as jest.Mock).mockResolvedValue([makeDelivery("d-1")]);

    await replayEventWindow({
      subscriptionId: SUB_ID,
      from,
      to,
      requestorAddress: "G-ACTOR",
    });

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "webhook.replay_window_requested",
        actorAddress: "G-ACTOR",
        metadata: expect.objectContaining({
          subscriptionId: SUB_ID,
          requestId: expect.any(String),
          queued: 1,
        }),
      })
    );
  });
});

// ── Rate limit helper ──────────────────────────────────────────────────────

describe("checkAndIncrementRateLimit", () => {
  it("allows first request (no prior count)", async () => {
    mockGetCacheValue.mockResolvedValue(null);
    const result = await checkAndIncrementRateLimit(SUB_ID);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(REPLAY_RATE_LIMIT - 1);
  });

  it("blocks when count equals REPLAY_RATE_LIMIT", async () => {
    mockGetCacheValue.mockResolvedValue(REPLAY_RATE_LIMIT);
    const result = await checkAndIncrementRateLimit(SUB_ID);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });
});
