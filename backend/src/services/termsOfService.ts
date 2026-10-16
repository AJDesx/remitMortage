// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import crypto from "crypto";
import { logAudit } from "./audit.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TosVersion {
  version: string;       // semver-style, e.g. "2.1.0"
  effectiveAt: Date;
  summary: string;       // human-readable changelog for the re-consent prompt
  requiresReConsent: boolean;
  contentHash: string;   // SHA-256 of the canonical document text
}

export interface TosAcceptance {
  acceptanceId: string;
  walletAddress: string;
  version: string;
  acceptedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  consentMethod: "explicit_checkbox" | "api";
}

export interface TosStatus {
  walletAddress: string;
  currentVersion: string;
  acceptedVersion: string | null;
  needsReConsent: boolean;
  pendingVersion: string | null; // version awaiting re-consent
}

// ── In-memory store (replace with Prisma models after schema migration) ───────

const _versions: Map<string, TosVersion> = new Map();
const _acceptances: Map<string, TosAcceptance[]> = new Map(); // walletAddress → []

let _currentVersion: string | null = null;

// ── Version management ────────────────────────────────────────────────────────

export function publishTosVersion(v: Omit<TosVersion, "contentHash">, docText: string): TosVersion {
  const contentHash = crypto.createHash("sha256").update(docText).digest("hex");
  const version: TosVersion = { ...v, contentHash };
  _versions.set(version.version, version);

  if (
    _currentVersion === null ||
    compareSemver(version.version, _currentVersion) > 0
  ) {
    _currentVersion = version.version;
  }

  return version;
}

export function getCurrentVersion(): TosVersion | null {
  if (!_currentVersion) return null;
  return _versions.get(_currentVersion) ?? null;
}

export function getTosVersion(version: string): TosVersion | undefined {
  return _versions.get(version);
}

// ── Acceptance ────────────────────────────────────────────────────────────────

export function recordAcceptance(
  walletAddress: string,
  version: string,
  opts: { ipAddress?: string; userAgent?: string; consentMethod?: TosAcceptance["consentMethod"] }
): TosAcceptance {
  const tosVersion = _versions.get(version);
  if (!tosVersion) throw new Error(`Unknown TOS version: ${version}`);

  const acceptance: TosAcceptance = {
    acceptanceId: crypto.randomUUID(),
    walletAddress,
    version,
    acceptedAt: new Date(),
    ipAddress: opts.ipAddress ?? null,
    userAgent: opts.userAgent ?? null,
    consentMethod: opts.consentMethod ?? "explicit_checkbox",
  };

  const list = _acceptances.get(walletAddress) ?? [];
  list.push(acceptance);
  _acceptances.set(walletAddress, list);

  logAudit({
    action: "tos.accepted",
    actorAddress: walletAddress,
    ipAddress: opts.ipAddress,
    metadata: {
      acceptanceId: acceptance.acceptanceId,
      version,
      consentMethod: acceptance.consentMethod,
      contentHash: tosVersion.contentHash,
    },
  });

  return acceptance;
}

export function getLatestAcceptance(walletAddress: string): TosAcceptance | null {
  const list = _acceptances.get(walletAddress);
  if (!list || list.length === 0) return null;
  return list.reduce((latest, a) =>
    a.acceptedAt > latest.acceptedAt ? a : latest
  );
}

// ── Re-consent check ──────────────────────────────────────────────────────────

/**
 * Returns whether the user must accept the current TOS before continuing.
 * Re-consent is required when:
 *   1. The user has never accepted any version, or
 *   2. A newer version is current and it has `requiresReConsent: true`.
 */
export function checkReConsentRequired(walletAddress: string): TosStatus {
  const current = getCurrentVersion();
  const latest = getLatestAcceptance(walletAddress);

  if (!current) {
    return {
      walletAddress,
      currentVersion: "none",
      acceptedVersion: latest?.version ?? null,
      needsReConsent: false,
      pendingVersion: null,
    };
  }

  if (!latest) {
    return {
      walletAddress,
      currentVersion: current.version,
      acceptedVersion: null,
      needsReConsent: true,
      pendingVersion: current.version,
    };
  }

  if (latest.version === current.version) {
    return {
      walletAddress,
      currentVersion: current.version,
      acceptedVersion: latest.version,
      needsReConsent: false,
      pendingVersion: null,
    };
  }

  // User has an older acceptance — check if any intervening versions require re-consent
  const needsReConsent = versionsRequiringReConsentSince(latest.version).length > 0;

  return {
    walletAddress,
    currentVersion: current.version,
    acceptedVersion: latest.version,
    needsReConsent,
    pendingVersion: needsReConsent ? current.version : null,
  };
}

/**
 * Returns all versions newer than `sinceVersion` that require re-consent,
 * sorted oldest-first.
 */
export function versionsRequiringReConsentSince(sinceVersion: string): TosVersion[] {
  return [..._versions.values()]
    .filter(
      (v) =>
        v.requiresReConsent && compareSemver(v.version, sinceVersion) > 0
    )
    .sort((a, b) => compareSemver(a.version, b.version));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseSemver(v: string): [number, number, number] {
  const parts = v.split(".").map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

export function compareSemver(a: string, b: string): number {
  const [aMaj, aMin, aPat] = parseSemver(a);
  const [bMaj, bMin, bPat] = parseSemver(b);
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return aPat - bPat;
}

export function _clearStore(): void {
  _versions.clear();
  _acceptances.clear();
  _currentVersion = null;
}
