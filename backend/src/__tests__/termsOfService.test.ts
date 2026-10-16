// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

jest.mock("../services/audit.js");
jest.mock("../utils/logger.js", () => ({
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import { logAudit } from "../services/audit.js";
import {
  publishTosVersion,
  recordAcceptance,
  checkReConsentRequired,
  getCurrentVersion,
  getTosVersion,
  versionsRequiringReConsentSince,
  compareSemver,
  _clearStore,
} from "../services/termsOfService.js";

const mockLogAudit = logAudit as jest.Mock;
const WALLET = "G-USER-1";
const DOC_V1 = "These are the v1 terms of service.";
const DOC_V2 = "These are the updated v2 terms of service.";

function mkVersion(version: string, requiresReConsent = true, doc = DOC_V1) {
  return publishTosVersion(
    {
      version,
      effectiveAt: new Date("2026-01-01"),
      summary: `Changes in ${version}`,
      requiresReConsent,
    },
    doc
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  _clearStore();
  mockLogAudit.mockImplementation(() => {});
});

// ── Publishing ─────────────────────────────────────────────────────────────────

describe("publishTosVersion", () => {
  it("stores the version and makes it the current one", () => {
    mkVersion("1.0.0");
    const current = getCurrentVersion();
    expect(current?.version).toBe("1.0.0");
  });

  it("sets the current version to the highest semver after multiple publishes", () => {
    mkVersion("1.0.0");
    mkVersion("1.2.0");
    mkVersion("1.1.0"); // out of order
    expect(getCurrentVersion()?.version).toBe("1.2.0");
  });

  it("attaches a SHA-256 content hash to the version", () => {
    const v = mkVersion("1.0.0", true, DOC_V1);
    expect(v.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different hashes for different document texts", () => {
    const v1 = mkVersion("1.0.0", true, DOC_V1);
    const v2 = mkVersion("2.0.0", true, DOC_V2);
    expect(v1.contentHash).not.toBe(v2.contentHash);
  });
});

// ── Acceptance ────────────────────────────────────────────────────────────────

describe("recordAcceptance", () => {
  it("records an acceptance and returns it with an acceptanceId", () => {
    mkVersion("1.0.0");
    const a = recordAcceptance(WALLET, "1.0.0", { ipAddress: "1.2.3.4" });
    expect(a.acceptanceId).toEqual(expect.any(String));
    expect(a.version).toBe("1.0.0");
    expect(a.walletAddress).toBe(WALLET);
  });

  it("throws for an unknown version", () => {
    expect(() => recordAcceptance(WALLET, "9.9.9", {})).toThrow("Unknown TOS version");
  });

  it("records a tos.accepted audit entry with the content hash", () => {
    const v = mkVersion("1.0.0");
    recordAcceptance(WALLET, "1.0.0", {});
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "tos.accepted",
        actorAddress: WALLET,
        metadata: expect.objectContaining({
          version: "1.0.0",
          contentHash: v.contentHash,
        }),
      })
    );
  });
});

// ── Re-consent check ──────────────────────────────────────────────────────────

describe("checkReConsentRequired", () => {
  it("requires consent when the user has never accepted any version", () => {
    mkVersion("1.0.0");
    const status = checkReConsentRequired(WALLET);
    expect(status.needsReConsent).toBe(true);
    expect(status.acceptedVersion).toBeNull();
    expect(status.pendingVersion).toBe("1.0.0");
  });

  it("does not require re-consent when the user is on the current version", () => {
    mkVersion("1.0.0");
    recordAcceptance(WALLET, "1.0.0", {});
    const status = checkReConsentRequired(WALLET);
    expect(status.needsReConsent).toBe(false);
    expect(status.pendingVersion).toBeNull();
  });

  it("requires re-consent when a newer version with requiresReConsent is published", () => {
    mkVersion("1.0.0");
    recordAcceptance(WALLET, "1.0.0", {});
    mkVersion("2.0.0", true); // new version requiring re-consent
    const status = checkReConsentRequired(WALLET);
    expect(status.needsReConsent).toBe(true);
    expect(status.currentVersion).toBe("2.0.0");
    expect(status.acceptedVersion).toBe("1.0.0");
  });

  it("does not require re-consent when the only newer version does NOT require it", () => {
    mkVersion("1.0.0");
    recordAcceptance(WALLET, "1.0.0", {});
    mkVersion("1.1.0", false); // patch/minor with no re-consent gate
    const status = checkReConsentRequired(WALLET);
    expect(status.needsReConsent).toBe(false);
  });

  it("returns needsReConsent:false when no TOS version has been published", () => {
    const status = checkReConsentRequired(WALLET);
    expect(status.needsReConsent).toBe(false);
    expect(status.currentVersion).toBe("none");
  });
});

// ── versionsRequiringReConsentSince ───────────────────────────────────────────

describe("versionsRequiringReConsentSince", () => {
  it("returns versions newer than sinceVersion that require re-consent", () => {
    mkVersion("1.0.0");
    mkVersion("1.1.0", false); // no re-consent
    mkVersion("2.0.0", true);  // re-consent required

    const pending = versionsRequiringReConsentSince("1.0.0");
    expect(pending).toHaveLength(1);
    expect(pending[0].version).toBe("2.0.0");
  });

  it("returns versions in ascending semver order", () => {
    mkVersion("1.0.0");
    mkVersion("3.0.0", true);
    mkVersion("2.0.0", true);

    const pending = versionsRequiringReConsentSince("1.0.0");
    expect(pending.map((v) => v.version)).toEqual(["2.0.0", "3.0.0"]);
  });
});

// ── getTosVersion ─────────────────────────────────────────────────────────────

describe("getTosVersion", () => {
  it("returns the published version by its version string", () => {
    mkVersion("1.5.0");
    expect(getTosVersion("1.5.0")?.version).toBe("1.5.0");
  });

  it("returns undefined for an unpublished version", () => {
    expect(getTosVersion("9.9.9")).toBeUndefined();
  });
});

// ── compareSemver ─────────────────────────────────────────────────────────────

describe("compareSemver", () => {
  it.each([
    ["1.0.0", "2.0.0", -1],
    ["2.0.0", "1.0.0", 1],
    ["1.0.0", "1.0.0", 0],
    ["1.0.1", "1.0.0", 1],
    ["1.1.0", "1.0.9", 1],
  ])("compareSemver(%s, %s) has the right sign", (a, b, expected) => {
    const result = compareSemver(a, b);
    if (expected < 0) expect(result).toBeLessThan(0);
    else if (expected > 0) expect(result).toBeGreaterThan(0);
    else expect(result).toBe(0);
  });
});
