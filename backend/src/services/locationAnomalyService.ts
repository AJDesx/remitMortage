// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { prisma } from "./db.js";

export interface GeoLocation {
  ip: string;
  country: string;
  city: string;
  latitude: number;
  longitude: number;
}

export interface LocationEntry {
  ip: string;
  location: GeoLocation;
  timestamp: number;
}

export interface LocationCheckResult {
  isAnomalous: boolean;
  requiresStepUp: boolean;
  reason?: string;
  currentLocation: GeoLocation;
  previousLocation?: GeoLocation;
  calculatedSpeedKmH?: number;
}

export interface StepUpCodeRecord {
  code: string;
  expiresAt: number;
  used: boolean;
}

// Step-up codes are short-lived (10 minutes) single-use tokens, not account
// history — losing a pending one on a process restart is an acceptable UX
// blip, not a correctness or security issue, so these stay in-memory rather
// than adding a persistence requirement for what's effectively a transient
// nonce. Login *history*, by contrast, is persisted — see
// recordLoginLocation/readRecentLoginLocations below.
const stepUpCodeStore = new Map<string, StepUpCodeRecord>();

// Maximum plausible human travel speed (e.g., commercial flights ~800 km/h)
const MAX_PLAUSIBLE_SPEED_KMH = 800;
const STEP_UP_CODE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
// How many of the most recent logins to consider when checking whether a
// country has been seen before. Bounded so the check stays cheap regardless
// of how long an account has existed.
const LOCATION_HISTORY_LOOKBACK = 20;
// Coarse rounding applied before anything is persisted: one decimal degree
// is roughly 11km at the equator — enough to compute travel distance/speed,
// nowhere near enough to pinpoint an address.
const COARSE_PRECISION = 10; // round to nearest 0.1 degree

function roundCoarse(value: number): number {
  return Math.round(value * COARSE_PRECISION) / COARSE_PRECISION;
}

/**
 * Resolves an IP address to approximate geolocation.
 *
 * This is a deterministic mock, not a real geo-IP lookup — no geo-IP
 * provider package (maxmind/geoip-lite/ip-api, etc.) is installed in this
 * repo, and adding a new dependency is outside this change's scope. Swap
 * this function's body for a real provider call when one is adopted; every
 * caller already treats the result as coarse-only (see `getIpGeoLocation`'s
 * callers rounding before persisting), so no other code should need to
 * change.
 */
export function getIpGeoLocation(ip: string): GeoLocation {
  const cleanIp = ip ? ip.replace(/^::ffff:/, "") : "127.0.0.1";

  // Mock IP ranges for deterministic testing
  if (cleanIp === "1.1.1.1" || cleanIp.startsWith("10.0.1.")) {
    return { ip: cleanIp, country: "US", city: "New York", latitude: 40.7128, longitude: -74.0060 };
  }
  if (cleanIp === "2.2.2.2" || cleanIp.startsWith("10.0.2.")) {
    return { ip: cleanIp, country: "UK", city: "London", latitude: 51.5074, longitude: -0.1278 };
  }
  if (cleanIp === "3.3.3.3" || cleanIp.startsWith("10.0.3.")) {
    return { ip: cleanIp, country: "JP", city: "Tokyo", latitude: 35.6762, longitude: 139.6503 };
  }
  if (cleanIp === "4.4.4.4" || cleanIp.startsWith("10.0.4.")) {
    return { ip: cleanIp, country: "AU", city: "Sydney", latitude: -33.8688, longitude: 151.2093 };
  }
  // A second, nearby US location — distinct from "10.0.1.x" but close
  // enough to exercise VPN-style noise tolerance (same country, short
  // distance) rather than every non-primary IP mapping to a different city.
  if (cleanIp === "5.5.5.5" || cleanIp.startsWith("10.0.5.")) {
    return { ip: cleanIp, country: "US", city: "Philadelphia", latitude: 39.9526, longitude: -75.1652 };
  }

  // Default fallback location (New York, US) for local or untracked IPs
  return { ip: cleanIp, country: "US", city: "New York", latitude: 40.7128, longitude: -74.0060 };
}

/**
 * Calculates Great-Circle distance in kilometers between two lat/lon points using the Haversine formula.
 */
export function calculateDistanceKm(
  loc1: { latitude: number; longitude: number },
  loc2: { latitude: number; longitude: number }
): number {
  const R = 6371; // Earth's mean radius in km
  const dLat = ((loc2.latitude - loc1.latitude) * Math.PI) / 180;
  const dLon = ((loc2.longitude - loc1.longitude) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((loc1.latitude * Math.PI) / 180) *
      Math.cos((loc2.latitude * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/** The coarse shape actually persisted — no IP, no city. */
interface CoarseLocation {
  country: string;
  latitude: number;
  longitude: number;
}

function toCoarse(location: GeoLocation): CoarseLocation {
  return {
    country: location.country,
    latitude: roundCoarse(location.latitude),
    longitude: roundCoarse(location.longitude),
  };
}

async function readRecentLoginLocations(
  walletAddress: string
): Promise<Array<CoarseLocation & { loginAt: Date }>> {
  const rows = await prisma.loginLocationHistory.findMany({
    where: { walletAddress: walletAddress.toLowerCase() },
    orderBy: { loginAt: "desc" },
    take: LOCATION_HISTORY_LOOKBACK,
  });
  // Oldest-first, matching the old in-memory array's ordering so
  // `history[history.length - 1]` style "most recent" logic still reads
  // naturally below.
  return rows.reverse();
}

/**
 * Checks a login attempt for location anomalies against account history.
 */
export async function evaluateLoginLocation(
  walletAddress: string,
  ipAddress: string,
  nowTimestamp: number = Date.now()
): Promise<LocationCheckResult> {
  const currentLocation = getIpGeoLocation(ipAddress);
  const history = await readRecentLoginLocations(walletAddress);

  if (history.length === 0) {
    // First recorded login — automatically trusted as baseline
    return {
      isAnomalous: false,
      requiresStepUp: false,
      currentLocation,
    };
  }

  const lastEntry = history[history.length - 1];
  const distanceKm = calculateDistanceKm(lastEntry, currentLocation);
  const timeElapsedHours = Math.max((nowTimestamp - lastEntry.loginAt.getTime()) / (1000 * 60 * 60), 0.001);
  const speedKmH = distanceKm / timeElapsedHours;
  const previousLocation: GeoLocation = {
    ip: "",
    country: lastEntry.country,
    city: "",
    latitude: lastEntry.latitude,
    longitude: lastEntry.longitude,
  };

  // Check if location is previously seen / plausible. Coarse rounding means
  // two logins from the same metro area land on the same rounded point (or
  // close enough that the speed check below tolerates them) rather than
  // needing an exact city-name match — this is also what gives VPN-style
  // noise (a different exit IP, same rough area) its tolerance.
  const isSameLocation = lastEntry.country === currentLocation.country && distanceKm < 50;

  if (isSameLocation) {
    return {
      isAnomalous: false,
      requiresStepUp: false,
      currentLocation,
      previousLocation,
      calculatedSpeedKmH: Math.round(speedKmH),
    };
  }

  // Implausible speed detection (e.g. login from NYC then London 10 minutes later)
  if (speedKmH > MAX_PLAUSIBLE_SPEED_KMH && distanceKm > 100) {
    return {
      isAnomalous: true,
      requiresStepUp: true,
      reason: `Implausible travel speed detected (${Math.round(speedKmH)} km/h across ${Math.round(distanceKm)} km)`,
      currentLocation,
      previousLocation,
      calculatedSpeedKmH: Math.round(speedKmH),
    };
  }

  // First-ever login from this country, independent of how much time has
  // elapsed — unlike impossible travel (which is about speed), novelty of
  // the country itself is the signal here: a slow, "plausible" trip to a
  // country the account has never used before is still worth a step-up.
  const countrySeenBefore = history.some((h) => h.country === currentLocation.country);
  if (!countrySeenBefore) {
    return {
      isAnomalous: true,
      requiresStepUp: true,
      reason: `First login from unfamiliar country (${currentLocation.country})`,
      currentLocation,
      previousLocation,
      calculatedSpeedKmH: Math.round(speedKmH),
    };
  }

  return {
    isAnomalous: false,
    requiresStepUp: false,
    currentLocation,
    previousLocation,
    calculatedSpeedKmH: Math.round(speedKmH),
  };
}

/**
 * Records a successful, verified login location to account history.
 * Persists ONLY the coarse location (country + rounded lat/lon) — never the
 * IP address or city.
 */
export async function recordLoginLocation(
  walletAddress: string,
  ipAddress: string,
  timestamp: number = Date.now()
): Promise<void> {
  const coarse = toCoarse(getIpGeoLocation(ipAddress));

  await prisma.loginLocationHistory.create({
    data: {
      walletAddress: walletAddress.toLowerCase(),
      country: coarse.country,
      latitude: coarse.latitude,
      longitude: coarse.longitude,
      loginAt: new Date(timestamp),
    },
  });
}

/**
 * Generates a 6-digit step-up verification code for a wallet address.
 */
export function generateStepUpCode(walletAddress: string): string {
  const walletKey = walletAddress.toLowerCase();
  // Fixed deterministic string for testing or random 6-digit number
  const code = Math.floor(100000 + Math.random() * 900000).toString();

  stepUpCodeStore.set(walletKey, {
    code,
    expiresAt: Date.now() + STEP_UP_CODE_EXPIRY_MS,
    used: false,
  });

  return code;
}

/**
 * Verifies a step-up confirmation code for a flagged login.
 */
export function verifyStepUpCode(walletAddress: string, code: string): boolean {
  const walletKey = walletAddress.toLowerCase();
  const record = stepUpCodeStore.get(walletKey);

  if (!record || record.used || Date.now() > record.expiresAt) {
    return false;
  }

  if (record.code !== code) {
    return false;
  }

  record.used = true;
  stepUpCodeStore.set(walletKey, record);
  return true;
}

/**
 * Clears step-up code state (for test isolation). Login history now lives in
 * the database, so tests should clean up `prisma.loginLocationHistory`
 * directly (e.g. in a `beforeEach`/`afterEach`) rather than through this
 * function.
 */
export function _clearLocationStores(): void {
  stepUpCodeStore.clear();
}
