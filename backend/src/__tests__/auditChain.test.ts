// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

jest.mock("../services/db.js", () => ({
  prisma: {
    auditLog: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
  },
}));

import { prisma } from "../services/db.js";
import {
  CHAIN_HASH_KEY,
  CHAIN_PREV_KEY,
  GENESIS_PREV_HASH,
  InMemoryChainHeadSink,
  buildChain,
  computeChainHash,
  publishChainHead,
  verifyAuditRange,
  verifyChain,
  type AuditEntryInput,
} from "../services/auditChain.js";

const baseEntries: AuditEntryInput[] = [
  {
    id: "1",
    action: "login",
    actorAddress: "GABC",
    ipAddress: "127.0.0.1",
    metadata: { ok: true },
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  },
  {
    id: "2",
    action: "deposit",
    actorAddress: "GABC",
    ipAddress: "127.0.0.2",
    metadata: { amount: "100" },
    createdAt: new Date("2026-01-01T00:01:00.000Z"),
  },
  {
    id: "3",
    action: "withdraw",
    actorAddress: "GDEF",
    ipAddress: "127.0.0.3",
    metadata: { amount: "40" },
    createdAt: new Date("2026-01-01T00:02:00.000Z"),
  },
];

/** Serialises a built chain back into "stored" rows (hash fields in metadata). */
function storedRows(entries: AuditEntryInput[]) {
  return buildChain(entries).map((entry) => ({
    id: entry.id,
    action: entry.action,
    actorAddress: entry.actorAddress,
    ipAddress: entry.ipAddress,
    createdAt: entry.createdAt,
    metadata: {
      ...(entry.metadata ?? {}),
      [CHAIN_PREV_KEY]: entry.chainPrevHash,
      [CHAIN_HASH_KEY]: entry.chainHash,
    },
  }));
}

describe("audit hash chain", () => {
  it("verifies an untouched chain", () => {
    const result = verifyChain(storedRows(baseEntries));
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(3);
    expect(result.head).toBe(buildChain(baseEntries)[2].chainHash);
  });

  it("detects a modified entry", () => {
    const rows = storedRows(baseEntries);
    rows[1] = { ...rows[1], action: "tampered" };

    const result = verifyChain(rows);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toMatchObject({ index: 1, id: "2", reason: "hash_mismatch" });
  });

  it("detects a deleted entry", () => {
    const rows = storedRows(baseEntries);
    const deleted = [rows[0], rows[2]];

    const result = verifyChain(deleted);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toMatchObject({ index: 1, reason: "previous_hash_mismatch" });
  });

  it("excludes the reserved chain keys from the hashed content", () => {
    const plain: AuditEntryInput = {
      id: "x",
      action: "login",
      actorAddress: null,
      ipAddress: null,
      metadata: { a: 1 },
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const withKeys: AuditEntryInput = {
      ...plain,
      metadata: { a: 1, [CHAIN_HASH_KEY]: "whatever", [CHAIN_PREV_KEY]: "other" },
    };
    expect(computeChainHash(withKeys, GENESIS_PREV_HASH)).toBe(
      computeChainHash(plain, GENESIS_PREV_HASH)
    );
  });

  it("publishes the chain head to an external sink", async () => {
    const sink = new InMemoryChainHeadSink();
    const head = await publishChainHead(storedRows(baseEntries), sink);

    expect(sink.heads).toHaveLength(1);
    expect(sink.latest).toEqual(head);
    expect(head.count).toBe(3);
    expect(head.hash).toBe(buildChain(baseEntries)[2].chainHash);
  });
});

describe("verifyAuditRange", () => {
  beforeEach(() => jest.clearAllMocks());

  it("verifies rows read from the database", async () => {
    (prisma.auditLog.findMany as jest.Mock).mockResolvedValue(storedRows(baseEntries));
    (prisma.auditLog.findFirst as jest.Mock).mockResolvedValue(null);

    const result = await verifyAuditRange({});
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(3);
  });

  it("fails when a database row was altered", async () => {
    const rows = storedRows(baseEntries);
    rows[2] = { ...rows[2], metadata: { ...(rows[2].metadata as object), amount: "9999" } };
    (prisma.auditLog.findMany as jest.Mock).mockResolvedValue(rows);
    (prisma.auditLog.findFirst as jest.Mock).mockResolvedValue(null);

    const result = await verifyAuditRange({});
    expect(result.ok).toBe(false);
    expect(result.brokenAt?.id).toBe("3");
  });
});
