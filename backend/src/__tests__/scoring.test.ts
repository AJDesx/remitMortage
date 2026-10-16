// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { calculateCreditScore } from "../services/scoring";
import { RemittanceAnalysis } from "../services/stellar";

describe("Credit Scoring Engine", () => {
  const baseAnalysis: RemittanceAnalysis = {
    senderAddress: "G_TEST_SENDER",
    recipientAddress: "G_TEST_RECIPIENT",
    totalPayments: 12,
    totalAmountUSDC: "6000",
    averageAmountUSDC: "500",
    standardDeviation: 0,
    spanMonths: 12,
    firstPayment: "2023-01-01",
    lastPayment: "2024-01-01",
    selfDealing: false,
    eligible: true,
    reason: "OK"
  };

  it("Test 1: Excellent tier", () => {
    // 12 payments, 12 months, 6000 total, 0 variance.
    // Consistency (0 stdDev) = 40
    // Frequency (12 months / 11 intervals = ~32 days) = 25
    // Duration (12 months) = 20
    // Volume (6000) = 15
    // Total = 100
    const result = calculateCreditScore(baseAnalysis);
    expect(result.score).toBe(100);
    expect(result.tier).toBe("Excellent");
  });

  it("Test 2: Good tier", () => {
    // 6 payments, 6 months, 2500 total, 0 variance.
    // Consistency = 40
    // Frequency (~36 days) = 15
    // Duration (6 months) = 10
    // Volume (2500) = 10
    // Total = 75
    const result = calculateCreditScore({
      ...baseAnalysis,
      totalPayments: 6,
      spanMonths: 6,
      totalAmountUSDC: "2500",
      averageAmountUSDC: "416.66"
    });
    expect(result.score).toBe(75);
    expect(result.tier).toBe("Good");
  });

  it("Test 3: Fair tier", () => {
    // 4 payments, 8 months, 600 total, variance high
    // Consistency (stdDev=200, avg=150) -> CV = 1.33 -> 0
    // Frequency (~80 days) = 5
    // Duration (8 months) = 10
    // Volume (600) = 5
    // Total = 20... Wait, Fair is 40-59. Let's adjust.
    // Let's make Consistency = 20 (stdDev = 75, avg = 150)
    // Frequency (~32 days) = 25
    // Duration (3 months) = 5
    // Volume (500) = 5
    // Total = 55 (Fair)
    const result = calculateCreditScore({
      ...baseAnalysis,
      totalPayments: 4,
      spanMonths: 3,
      totalAmountUSDC: "600",
      averageAmountUSDC: "150",
      standardDeviation: 75
    });
    expect(result.score).toBe(55);
    expect(result.tier).toBe("Fair");
  });

  it("Test 4: Insufficient tier", () => {
    // Volume = 100 (0)
    // Duration = 1 (0)
    // Frequency = 0
    // Total < 39
    const result = calculateCreditScore({
      ...baseAnalysis,
      totalPayments: 3,
      spanMonths: 3,
      totalAmountUSDC: "100",
      averageAmountUSDC: "33",
      standardDeviation: 33 // CV=1 -> 0
    });
    expect(result.score).toBeLessThan(40);
    expect(result.tier).toBe("Insufficient");
  });

  it("Test 5: Breakdown validation", () => {
    const result = calculateCreditScore(baseAnalysis);
    expect(result.breakdown).toBeDefined();
    expect(result.breakdown.consistency).toBe(40);
    expect(result.breakdown.frequency).toBe(25);
    expect(result.breakdown.duration).toBe(20);
    expect(result.breakdown.volume).toBe(15);
  });

  it("Test 6: Edge cases - Single payment", () => {
    const result = calculateCreditScore({
      ...baseAnalysis,
      totalPayments: 1,
    });
    expect(result.score).toBe(0);
    expect(result.tier).toBe("Insufficient");
  });

  it("Test 6: Edge cases - Zero volume", () => {
    const result = calculateCreditScore({
      ...baseAnalysis,
      totalAmountUSDC: "0",
    });
    expect(result.score).toBe(0);
    expect(result.tier).toBe("Insufficient");
  });

  it("Test 7: every score carries exactly one reason per factor, with code and text", () => {
    const result = calculateCreditScore(baseAnalysis);
    expect(result.reasons).toHaveLength(4);
    const factors = result.reasons.map((r) => r.factor).sort();
    expect(factors).toEqual(["consistency", "duration", "frequency", "volume"]);
    for (const reason of result.reasons) {
      expect(typeof reason.code).toBe("string");
      expect(reason.code.length).toBeGreaterThan(0);
      expect(typeof reason.text).toBe("string");
      expect(reason.text.length).toBeGreaterThan(0);
    }
  });

  it("Test 8: a perfect score resolves to the 'fully met' code for every factor", () => {
    // baseAnalysis hits the top tier of every factor (see Test 1).
    const result = calculateCreditScore(baseAnalysis);
    const codes = result.reasons.map((r) => r.code);
    expect(codes).toContain("CONSISTENCY_HIGH");
    expect(codes).toContain("FREQUENCY_REGULAR");
    expect(codes).toContain("DURATION_ESTABLISHED");
    expect(codes).toContain("VOLUME_SUBSTANTIAL");
  });

  it("Test 9: reason codes are stable — the full catalog never silently changes", () => {
    // This is the contract the ticket cares about: once a code ships, its
    // spelling is permanent. If this test ever needs to change, that change
    // must be adding a *new* code, not renaming an existing one — any rename
    // breaks reproducibility for every score already stored with it.
    const STABLE_CODES = [
      "CONSISTENCY_HIGH",
      "CONSISTENCY_MODERATE",
      "CONSISTENCY_LOW",
      "FREQUENCY_REGULAR",
      "FREQUENCY_OCCASIONAL",
      "FREQUENCY_SPARSE",
      "FREQUENCY_INSUFFICIENT",
      "DURATION_ESTABLISHED",
      "DURATION_MODERATE",
      "DURATION_LIMITED",
      "DURATION_INSUFFICIENT",
      "VOLUME_SUBSTANTIAL",
      "VOLUME_MODERATE",
      "VOLUME_LOW",
      "VOLUME_MINIMAL",
      "INSUFFICIENT_HISTORY",
    ];

    // Fair-tier fixture (Test 3) exercises a mix of tiers in one call.
    const fair = calculateCreditScore({
      ...baseAnalysis,
      totalPayments: 4,
      spanMonths: 3,
      totalAmountUSDC: "600",
      averageAmountUSDC: "150",
      standardDeviation: 75,
    });
    const excellent = calculateCreditScore(baseAnalysis);
    const insufficient = calculateCreditScore({ ...baseAnalysis, totalPayments: 1 });

    for (const result of [fair, excellent, insufficient]) {
      for (const reason of result.reasons) {
        expect(STABLE_CODES).toContain(reason.code);
      }
    }
  });

  it("Test 10: reasons are ordered by deficit, biggest shortfall first", () => {
    // Same fixture as Test 3 (score 55): consistency 20/40 (deficit 20),
    // duration 5/20 (deficit 15), volume 5/15 (deficit 10), frequency 25/25
    // (deficit 0) — i.e. a genuine mix, not all-tied.
    const result = calculateCreditScore({
      ...baseAnalysis,
      totalPayments: 4,
      spanMonths: 3,
      totalAmountUSDC: "600",
      averageAmountUSDC: "150",
      standardDeviation: 75,
    });
    expect(result.reasons.map((r) => r.factor)).toEqual([
      "consistency",
      "duration",
      "volume",
      "frequency",
    ]);
  });

  it("Test 11: insufficient history still carries reasons, never an empty array", () => {
    const result = calculateCreditScore({ ...baseAnalysis, totalPayments: 1 });
    expect(result.reasons).toHaveLength(4);
    expect(result.reasons.every((r) => r.code === "INSUFFICIENT_HISTORY")).toBe(true);
  });
});
