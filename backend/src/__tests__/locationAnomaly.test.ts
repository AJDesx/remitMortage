// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import express from "express";
import request from "supertest";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import { Keypair } from "@stellar/stellar-sdk";
import { verificationRouter } from "../routes/verification";
import {
  evaluateLoginLocation,
  recordLoginLocation,
  calculateDistanceKm,
  getIpGeoLocation,
  generateStepUpCode,
  verifyStepUpCode,
  _clearLocationStores,
} from "../services/locationAnomalyService";
import { _setEntry } from "../services/challengeStore";

// Login location history is persisted via prisma.loginLocationHistory, so
// the db module mock needs a working (if fake) implementation of it rather
// than the bare jest.fn() stubs the other mocked exports use — tests below
// record a login then immediately re-query it to evaluate the next one.
// Each test uses its own distinct wallet address (existing convention), so
// a single array shared across the whole file never leaks state between
// tests — no explicit clearing is needed.
jest.mock("../services/db.js", () => {
  type FakeRow = {
    walletAddress: string;
    country: string;
    latitude: number;
    longitude: number;
    loginAt: Date;
  };
  const rows: FakeRow[] = [];

  return {
    upsertApplicant: jest.fn().mockResolvedValue({ id: "applicant-1" }),
    createVerificationResult: jest.fn().mockResolvedValue({ id: "verification-1" }),
    getNotificationPreference: jest.fn().mockResolvedValue(null),
    prisma: {
      loginLocationHistory: {
        create: jest.fn(async ({ data }: { data: FakeRow }) => {
          const row = { ...data };
          rows.push(row);
          return row;
        }),
        findMany: jest.fn(
          async ({
            where,
            orderBy,
            take,
          }: {
            where: { walletAddress: string };
            orderBy?: { loginAt: "asc" | "desc" };
            take?: number;
          }) => {
            const matching = rows
              .filter((r) => r.walletAddress === where.walletAddress)
              .sort((a, b) =>
                orderBy?.loginAt === "asc"
                  ? a.loginAt.getTime() - b.loginAt.getTime()
                  : b.loginAt.getTime() - a.loginAt.getTime()
              );
            return take ? matching.slice(0, take) : matching;
          }
        ),
      },
    },
  };
});

jest.mock("../middleware/rateLimit.js", () => ({
  verificationChallengeRateLimiter: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => next(),
  verificationOwnershipRateLimiter: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => next(),
}));

jest.mock("../services/email.js", () => ({
  sendEmail: jest.fn().mockResolvedValue(true),
  getBrandedHtml: jest.fn((_title: string, body: string) => body),
}));

jest.mock("../services/audit.js", () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

function signStellarChallenge(keypair: Keypair, challenge: string): string {
  return Buffer.from(keypair.sign(Buffer.from(challenge, "utf8"))).toString("hex");
}

describe("Anomalous Location Detection Service", () => {
  beforeEach(() => {
    _clearLocationStores();
  });

  it("should correctly compute distance between New York and London", () => {
    const ny = getIpGeoLocation("1.1.1.1");
    const london = getIpGeoLocation("2.2.2.2");
    const dist = calculateDistanceKm(ny, london);
    expect(dist).toBeGreaterThan(5000);
    expect(dist).toBeLessThan(6000);
  });

  it("should evaluate initial login as trusted baseline", async () => {
    const result = await evaluateLoginLocation("GAAA_BASELINE_TEST", "1.1.1.1");
    expect(result.isAnomalous).toBe(false);
    expect(result.requiresStepUp).toBe(false);
  });

  it("should flag implausible travel speed jumps across locations", async () => {
    const wallet = "GAAA_SPEED_TEST";
    const now = Date.now();

    // Baseline login in New York
    await recordLoginLocation(wallet, "1.1.1.1", now);

    // Login attempt from London 5 minutes later
    const result = await evaluateLoginLocation(wallet, "2.2.2.2", now + 5 * 60 * 1000);
    expect(result.isAnomalous).toBe(true);
    expect(result.requiresStepUp).toBe(true);
    expect(result.reason).toContain("Implausible travel speed detected");
  });

  it("should allow plausible location logins without step-up", async () => {
    const wallet = "GAAA_PLAUSIBLE_TEST";
    const now = Date.now();

    await recordLoginLocation(wallet, "1.1.1.1", now);

    // Login from same location 1 hour later
    const result = await evaluateLoginLocation(wallet, "10.0.1.5", now + 60 * 60 * 1000);
    expect(result.isAnomalous).toBe(false);
    expect(result.requiresStepUp).toBe(false);
  });

  it("should tolerate VPN-style noise: a moderate jump within the same country is not flagged", async () => {
    const wallet = "GAAA_VPN_NOISE_TEST";
    const now = Date.now();

    // Baseline login in New York.
    await recordLoginLocation(wallet, "1.1.1.1", now);

    // A different exit IP ~130km away (Philadelphia) an hour later — the
    // kind of jump a VPN or mobile-network IP reassignment produces. Same
    // country, well within plausible travel speed: must not be flagged.
    const result = await evaluateLoginLocation(wallet, "5.5.5.5", now + 60 * 60 * 1000);
    expect(result.isAnomalous).toBe(false);
    expect(result.requiresStepUp).toBe(false);
  });

  it("should flag a first login from a new country even after a long, speed-plausible gap", async () => {
    const wallet = "GAAA_NEW_COUNTRY_SLOW_TEST";
    const now = Date.now();

    // Baseline login in New York.
    await recordLoginLocation(wallet, "1.1.1.1", now);

    // London, 10 hours later: ~557 km/h, well under the implausible-speed
    // threshold (800 km/h) — a legitimate-looking trip. It's still the
    // account's first-ever login from the UK, so it must still be flagged;
    // novelty of the country doesn't depend on how fast the trip was.
    const result = await evaluateLoginLocation(wallet, "2.2.2.2", now + 10 * 60 * 60 * 1000);
    expect(result.calculatedSpeedKmH).toBeLessThan(800);
    expect(result.isAnomalous).toBe(true);
    expect(result.requiresStepUp).toBe(true);
    expect(result.reason).toContain("unfamiliar country");
  });

  it("should not flag a login from a country already seen in history", async () => {
    const wallet = "GAAA_KNOWN_COUNTRY_TEST";
    const now = Date.now();

    // Two prior logins in the US (NY, then Philadelphia-ish via 10.0.1.x).
    await recordLoginLocation(wallet, "1.1.1.1", now);
    await recordLoginLocation(wallet, "10.0.1.9", now + 60 * 60 * 1000);

    // A third US login, still plausible speed: known country, not flagged.
    const result = await evaluateLoginLocation(wallet, "1.1.1.1", now + 2 * 60 * 60 * 1000);
    expect(result.isAnomalous).toBe(false);
    expect(result.requiresStepUp).toBe(false);
  });

  it("should generate and verify step-up codes correctly", () => {
    const wallet = "GAAA_CODE_TEST";
    const code = generateStepUpCode(wallet);
    expect(code).toHaveLength(6);

    const isValid = verifyStepUpCode(wallet, code);
    expect(isValid).toBe(true);

    // Code cannot be reused
    const isReusedValid = verifyStepUpCode(wallet, code);
    expect(isReusedValid).toBe(false);
  });
});

describe("Anomalous Login Location & Step-Up Endpoints Integration", () => {
  let app: express.Express;

  beforeEach(() => {
    _clearLocationStores();
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api/verification", verificationRouter);
  });

  it("should issue normal session on plausible location verification", async () => {
    const keypair = Keypair.random();
    const walletAddress = keypair.publicKey();
    const challenge = "RemitMortgage-verify-plausible";

    _setEntry(walletAddress, {
      challenge,
      expiresAt: Date.now() + 10000,
      used: false,
    });

    const res = await request(app)
      .post("/api/verification/verify-ownership")
      .set("X-Forwarded-For", "1.1.1.1")
      .send({
        walletAddress,
        network: "stellar",
        challenge,
        signature: signStellarChallenge(keypair, challenge),
      });

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(res.body.stepUpRequired).toBe(false);
    expect(res.headers["set-cookie"]).toBeDefined();
  });

  it("should trigger step-up requirement when logging in from implausible location", async () => {
    const keypair = Keypair.random();
    const walletAddress = keypair.publicKey();

    // Register initial baseline login in NY
    await recordLoginLocation(walletAddress, "1.1.1.1", Date.now());

    const challenge = "RemitMortgage-verify-anomalous";
    _setEntry(walletAddress, {
      challenge,
      expiresAt: Date.now() + 10000,
      used: false,
    });

    // Attempt login from Tokyo 1 minute later
    const res = await request(app)
      .post("/api/verification/verify-ownership")
      .set("X-Forwarded-For", "3.3.3.3")
      .send({
        walletAddress,
        network: "stellar",
        challenge,
        signature: signStellarChallenge(keypair, challenge),
      });

    expect(res.status).toBe(202);
    expect(res.body.verified).toBe(true);
    expect(res.body.stepUpRequired).toBe(true);
    expect(res.body.stepUpCode).toBeDefined();

    const code = res.body.stepUpCode;

    // Verify step-up code
    const stepUpRes = await request(app)
      .post("/api/verification/step-up")
      .set("X-Forwarded-For", "3.3.3.3")
      .send({
        walletAddress,
        network: "stellar",
        code,
      });

    expect(stepUpRes.status).toBe(200);
    expect(stepUpRes.body.verified).toBe(true);
    expect(stepUpRes.body.stepUpCompleted).toBe(true);
    expect(stepUpRes.headers["set-cookie"]).toBeDefined();
  });

  it("should reject invalid step-up code", async () => {
    const res = await request(app)
      .post("/api/verification/step-up")
      .send({
        walletAddress: "GAAA_INVALID",
        network: "stellar",
        code: "000000",
      });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_step_up_code");
  });
});
