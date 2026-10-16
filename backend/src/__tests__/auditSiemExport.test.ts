// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

jest.mock("../services/db.js");
jest.mock("../services/audit.js");
jest.mock("../utils/logger.js", () => ({
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import { prisma } from "../services/db.js";
import { logAudit } from "../services/audit.js";
import {
  exportAuditLogToSiem,
  buildExportChainHash,
  formatAsCef,
  formatAsNdjson,
  SIEM_EXPORT_PAGE_SIZE,
  SIEM_MAX_WINDOW_DAYS,
  AuditExportEvent,
} from "../services/auditSiemExport.js";

const mockLogAudit = logAudit as jest.Mock;

const from = new Date("2026-08-01T00:00:00Z");
const to = new Date("2026-08-02T00:00:00Z");
const SECRET = "test-hmac-secret";

function makeRow(id: string, action = "loan.approved", createdAt?: Date) {
  return {
    id,
    action,
    actorAddress: "G-ACTOR",
    ipAddress: "10.0.0.1",
    metadata: { loanId: "L1" },
    createdAt: createdAt ?? new Date("2026-08-01T06:00:00Z"),
  };
}

function makeEvent(id: string): AuditExportEvent {
  return {
    id,
    action: "loan.approved",
    actorAddress: "G-ACTOR",
    ipAddress: "10.0.0.1",
    metadata: { loanId: "L1" },
    createdAt: new Date("2026-08-01T06:00:00Z").toISOString(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLogAudit.mockImplementation(() => {});
  (prisma.auditLog as any) = { findMany: jest.fn() };
});

// ── Window validation ─────────────────────────────────────────────────────────

describe("exportAuditLogToSiem – window validation", () => {
  it("rejects when 'to' is before 'from'", async () => {
    await expect(
      exportAuditLogToSiem({ from: to, to: from }, SECRET, async () => {})
    ).rejects.toThrow("'to' must be after 'from'");
  });

  it(`rejects windows exceeding ${SIEM_MAX_WINDOW_DAYS} days`, async () => {
    const bigTo = new Date(
      from.getTime() + (SIEM_MAX_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1_000
    );
    await expect(
      exportAuditLogToSiem({ from, to: bigTo }, SECRET, async () => {})
    ).rejects.toThrow(`cannot exceed ${SIEM_MAX_WINDOW_DAYS} days`);
  });
});

// ── Pagination ────────────────────────────────────────────────────────────────

describe("exportAuditLogToSiem – pagination", () => {
  it("calls onPage for each page of results", async () => {
    const page1 = Array.from({ length: SIEM_EXPORT_PAGE_SIZE }, (_, i) =>
      makeRow(`r-${i}`)
    );
    const page2 = [makeRow("r-last")];

    const findMany = jest.fn()
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2)
      .mockResolvedValueOnce([]);
    (prisma.auditLog as any) = { findMany };

    const pages: string[][] = [];
    await exportAuditLogToSiem({ from, to }, SECRET, async (lines) => {
      pages.push(lines);
    });

    expect(pages).toHaveLength(2);
    expect(pages[0]).toHaveLength(SIEM_EXPORT_PAGE_SIZE);
    expect(pages[1]).toHaveLength(1);
  });

  it("reports correct totalEvents across pages", async () => {
    const findMany = jest.fn()
      .mockResolvedValueOnce(Array.from({ length: 10 }, (_, i) => makeRow(`r-${i}`)))
      .mockResolvedValueOnce([]);
    (prisma.auditLog as any) = { findMany };

    const result = await exportAuditLogToSiem({ from, to }, SECRET, async () => {});
    expect(result.totalEvents).toBe(10);
  });

  it("uses keyset pagination (passes last id as cursor)", async () => {
    const page1 = Array.from({ length: SIEM_EXPORT_PAGE_SIZE }, (_, i) =>
      makeRow(`r-${i}`)
    );
    const findMany = jest.fn()
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce([]);
    (prisma.auditLog as any) = { findMany };

    await exportAuditLogToSiem({ from, to }, SECRET, async () => {});

    const secondCall = findMany.mock.calls[1][0];
    expect(secondCall.where.id).toEqual({ gt: `r-${SIEM_EXPORT_PAGE_SIZE - 1}` });
  });
});

// ── Filters ───────────────────────────────────────────────────────────────────

describe("exportAuditLogToSiem – filters", () => {
  it("passes action filter to the query when provided", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    (prisma.auditLog as any) = { findMany };

    await exportAuditLogToSiem(
      { from, to, actions: ["loan.approved"] },
      SECRET,
      async () => {}
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ action: { in: ["loan.approved"] } }),
      })
    );
  });

  it("passes actorAddress filter when provided", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    (prisma.auditLog as any) = { findMany };

    await exportAuditLogToSiem(
      { from, to, actorAddress: "G-TEST" },
      SECRET,
      async () => {}
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ actorAddress: "G-TEST" }),
      })
    );
  });
});

// ── Format helpers ────────────────────────────────────────────────────────────

describe("formatAsNdjson", () => {
  it("produces valid JSON for each event", () => {
    const line = formatAsNdjson(makeEvent("e-1"));
    const parsed = JSON.parse(line);
    expect(parsed.id).toBe("e-1");
    expect(parsed.action).toBe("loan.approved");
  });
});

describe("formatAsCef", () => {
  it("starts with the CEF header prefix", () => {
    const line = formatAsCef(makeEvent("e-1"));
    expect(line).toMatch(/^CEF:0\|RemitMortgage\|AuditLog/);
  });

  it("includes the event id and action in the CEF output", () => {
    const line = formatAsCef(makeEvent("e-cef"));
    expect(line).toContain("e-cef");
    expect(line).toContain("loan.approved");
  });

  it("includes the actor address in the extension", () => {
    const line = formatAsCef(makeEvent("e-actor"));
    expect(line).toContain("suser=G-ACTOR");
  });
});

// ── Hash-chain integrity ──────────────────────────────────────────────────────

describe("buildExportChainHash", () => {
  it("produces a hex string", () => {
    const hash = buildExportChainHash(["line1", "line2"], SECRET);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces the same hash for the same input", () => {
    const lines = ["a", "b", "c"];
    expect(buildExportChainHash(lines, SECRET)).toBe(
      buildExportChainHash(lines, SECRET)
    );
  });

  it("produces a different hash when a line is changed", () => {
    const base = buildExportChainHash(["a", "b"], SECRET);
    const modified = buildExportChainHash(["a", "B"], SECRET);
    expect(base).not.toBe(modified);
  });

  it("produces a different hash with a different secret", () => {
    const lines = ["line"];
    const h1 = buildExportChainHash(lines, "secret-1");
    const h2 = buildExportChainHash(lines, "secret-2");
    expect(h1).not.toBe(h2);
  });

  it("export result includes the chain hash", async () => {
    (prisma.auditLog as any) = {
      findMany: jest.fn().mockResolvedValue([makeRow("r-1")]),
    };

    const result = await exportAuditLogToSiem({ from, to }, SECRET, async () => {});
    expect(result.chainHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── Audit trail ───────────────────────────────────────────────────────────────

describe("exportAuditLogToSiem – audit trail", () => {
  it("records an audit.siem_export_completed entry on success", async () => {
    (prisma.auditLog as any) = {
      findMany: jest.fn().mockResolvedValue([makeRow("r-1")]),
    };

    await exportAuditLogToSiem(
      { from, to, requestorAddress: "G-ADMIN" },
      SECRET,
      async () => {}
    );

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "audit.siem_export_completed",
        actorAddress: "G-ADMIN",
        metadata: expect.objectContaining({
          exportId: expect.any(String),
          totalEvents: 1,
          chainHash: expect.any(String),
        }),
      })
    );
  });
});
