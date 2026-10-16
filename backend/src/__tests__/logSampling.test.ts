// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Tests for log sampling and volume cost controls (issue #875).
 *
 * The acceptance criteria these cover:
 *   - Noisy debug/info logs are sampled.
 *   - Errors and audit events are NEVER dropped.
 *   - A service over its volume budget is reported so Prometheus can alert.
 */

import { Writable } from "stream";
import winston from "winston";

import { metricsRegistry } from "../services/metrics.js";
import {
  DEFAULT_DEBUG_SAMPLE_RATE,
  DEFAULT_INFO_SAMPLE_RATE,
  DEFAULT_VOLUME_BUDGET_BYTES,
  getLogSamplingConfig,
  getLogVolumeWindowBytes,
  initLogSampling,
  logSamplingFormat,
  recordLogVolume,
  resetLogSamplingState,
  resolveLogSamplingConfig,
  shouldKeepLog,
} from "../utils/logSampling.js";

/** Read a single metric value out of the shared registry. */
async function metricValue(
  name: string,
  labelFilter?: Record<string, string>
): Promise<number | undefined> {
  const text = await metricsRegistry.getSingleMetricAsString(name);
  const line = text
    .split("\n")
    .find(
      (l) =>
        l.startsWith(name) &&
        !l.startsWith(`${name}_`) &&
        (labelFilter === undefined ||
          Object.entries(labelFilter).every(([k, v]) =>
            l.includes(`${k}="${v}"`)
          ))
    );
  if (!line) return undefined;
  return Number(line.slice(line.lastIndexOf(" ") + 1));
}

/**
 * A winston logger wired to the sampling format and an in-memory sink, so the
 * tests exercise the real format pipeline rather than reimplementing it.
 */
function captureLogger(): { logger: winston.Logger; sink: string[] } {
  const sink: string[] = [];
  const stream = new Writable({
    objectMode: true,
    write(info, _enc, cb) {
      sink.push(String(info.message));
      cb();
    },
  });

  const logger = winston.createLogger({
    level: "debug",
    format: winston.format.combine(logSamplingFormat(), winston.format.json()),
    transports: [new winston.transports.Stream({ stream })],
  });

  return { logger, sink };
}

/** Let the Stream transport flush before asserting. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  resetLogSamplingState();
  initLogSampling({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
});

describe("resolveLogSamplingConfig", () => {
  it("defaults to disabled outside production, keeping every entry", () => {
    const config = resolveLogSamplingConfig({
      NODE_ENV: "development",
    } as NodeJS.ProcessEnv);

    expect(config.enabled).toBe(false);
    expect(config.infoSampleRate).toBe(DEFAULT_INFO_SAMPLE_RATE);
    expect(config.debugSampleRate).toBe(DEFAULT_DEBUG_SAMPLE_RATE);
    expect(config.volumeBudgetBytes).toBe(DEFAULT_VOLUME_BUDGET_BYTES);
  });

  it("defaults to enabled in production", () => {
    expect(
      resolveLogSamplingConfig({ NODE_ENV: "production" } as NodeJS.ProcessEnv)
        .enabled
    ).toBe(true);
  });

  it("honours explicit overrides, including disabling in production", () => {
    const config = resolveLogSamplingConfig({
      NODE_ENV: "production",
      LOG_SAMPLING_ENABLED: "false",
      LOG_SAMPLE_RATE_INFO: "3",
      LOG_SAMPLE_RATE_DEBUG: "7",
      LOG_VOLUME_BUDGET_BYTES: "2048",
      LOG_VOLUME_BUDGET_WINDOW_MS: "1000",
      LOG_SAMPLE_EXEMPT_SOURCES: "Audit, Billing",
    } as NodeJS.ProcessEnv);

    expect(config.enabled).toBe(false);
    expect(config.infoSampleRate).toBe(3);
    expect(config.debugSampleRate).toBe(7);
    expect(config.volumeBudgetBytes).toBe(2048);
    expect(config.volumeBudgetWindowMs).toBe(1000);
    expect(config.exemptSources).toEqual(["audit", "billing"]);
  });

  it("rejects malformed rates and budgets, falling back to defaults", () => {
    const config = resolveLogSamplingConfig({
      NODE_ENV: "production",
      LOG_SAMPLE_RATE_INFO: "0",
      LOG_SAMPLE_RATE_DEBUG: "abc",
      LOG_VOLUME_BUDGET_BYTES: "-5",
    } as NodeJS.ProcessEnv);

    expect(config.infoSampleRate).toBe(DEFAULT_INFO_SAMPLE_RATE);
    expect(config.debugSampleRate).toBe(DEFAULT_DEBUG_SAMPLE_RATE);
    expect(config.volumeBudgetBytes).toBe(DEFAULT_VOLUME_BUDGET_BYTES);
  });
});

describe("shouldKeepLog", () => {
  beforeEach(() => {
    initLogSampling({
      NODE_ENV: "production",
      LOG_SAMPLE_RATE_INFO: "10",
      LOG_SAMPLE_RATE_DEBUG: "100",
    } as NodeJS.ProcessEnv);
  });

  it("never samples errors, warnings or audit entries", () => {
    for (let i = 0; i < 1000; i++) {
      expect(shouldKeepLog({ level: "error" })).toBe(true);
      expect(shouldKeepLog({ level: "warn" })).toBe(true);
      expect(shouldKeepLog({ level: "info", audit: true })).toBe(true);
      expect(
        shouldKeepLog({ level: "info", source: "audit" })
      ).toBe(true);
    }
  });

  it("samples info deterministically at 1-in-N", () => {
    let kept = 0;
    for (let i = 0; i < 100; i++) {
      if (shouldKeepLog({ level: "info", source: "http" })) kept++;
    }
    expect(kept).toBe(10);
  });

  it("samples debug more aggressively than info", () => {
    let kept = 0;
    for (let i = 0; i < 1000; i++) {
      if (shouldKeepLog({ level: "debug", source: "http" })) kept++;
    }
    expect(kept).toBe(10);
  });

  it("counts each source independently", () => {
    const sourceA = Array.from({ length: 10 }, () =>
      shouldKeepLog({ level: "info", source: "a" })
    ).filter(Boolean).length;
    const sourceB = Array.from({ length: 10 }, () =>
      shouldKeepLog({ level: "info", source: "b" })
    ).filter(Boolean).length;

    expect(sourceA).toBe(1);
    expect(sourceB).toBe(1);
  });

  it("keeps every entry for exempt sources", () => {
    initLogSampling({
      NODE_ENV: "production",
      LOG_SAMPLE_RATE_INFO: "10",
      LOG_SAMPLE_EXEMPT_SOURCES: "billing",
    } as NodeJS.ProcessEnv);

    let kept = 0;
    for (let i = 0; i < 100; i++) {
      if (shouldKeepLog({ level: "info", source: "billing" })) kept++;
    }
    expect(kept).toBe(100);
  });

  it("keeps every entry when sampling is disabled", () => {
    initLogSampling({
      NODE_ENV: "development",
      LOG_SAMPLE_RATE_INFO: "1000",
    } as NodeJS.ProcessEnv);

    let kept = 0;
    for (let i = 0; i < 100; i++) {
      if (shouldKeepLog({ level: "info", source: "http" })) kept++;
    }
    expect(kept).toBe(100);
    expect(getLogSamplingConfig().enabled).toBe(false);
  });
});

describe("winston integration", () => {
  it("keeps every error while dropping most info in a mixed stream", async () => {
    initLogSampling({
      NODE_ENV: "production",
      LOG_SAMPLE_RATE_INFO: "10",
    } as NodeJS.ProcessEnv);

    const { logger, sink } = captureLogger();

    for (let i = 0; i < 100; i++) {
      logger.info(`info-${i}`, { source: "svc" });
    }
    for (let i = 0; i < 50; i++) {
      logger.error(`error-${i}`);
    }
    await flush();

    const errors = sink.filter((m) => m.startsWith("error-"));
    const infos = sink.filter((m) => m.startsWith("info-"));

    expect(errors).toHaveLength(50);
    expect(infos).toHaveLength(10);
  });

  it("never drops audit events, even when tagged only by source", async () => {
    initLogSampling({
      NODE_ENV: "production",
      LOG_SAMPLE_RATE_INFO: "1000",
    } as NodeJS.ProcessEnv);

    const { logger, sink } = captureLogger();

    for (let i = 0; i < 200; i++) {
      logger.info(`audit-${i}`, { source: "audit", audit: true });
    }
    await flush();

    expect(sink.filter((m) => m.startsWith("audit-"))).toHaveLength(200);
  });

  it("keeps all info when sampling is disabled", async () => {
    initLogSampling({ NODE_ENV: "test" } as NodeJS.ProcessEnv);

    const { logger, sink } = captureLogger();
    for (let i = 0; i < 20; i++) {
      logger.info(`line-${i}`, { source: "svc" });
    }
    await flush();

    expect(sink).toHaveLength(20);
  });
});

describe("volume budget", () => {
  beforeEach(() => {
    initLogSampling({
      NODE_ENV: "production",
      LOG_VOLUME_BUDGET_BYTES: "1000",
      LOG_VOLUME_BUDGET_WINDOW_MS: "60000",
    } as NodeJS.ProcessEnv);
  });

  it("accumulates bytes and flags a service over budget", async () => {
    const t0 = 1_000_000;
    recordLogVolume("api", 400, t0);
    recordLogVolume("api", 400, t0 + 10);
    expect(getLogVolumeWindowBytes("api")).toBe(800);
    await expect(
      metricValue("remitmortgage_log_volume_over_budget", { service: "api" })
    ).resolves.toBe(0);

    recordLogVolume("api", 400, t0 + 20);
    expect(getLogVolumeWindowBytes("api")).toBe(1200);
    await expect(
      metricValue("remitmortgage_log_volume_over_budget", { service: "api" })
    ).resolves.toBe(1);
    await expect(
      metricValue("remitmortgage_log_volume_utilization_ratio", {
        service: "api",
      })
    ).resolves.toBeCloseTo(1.2);
  });

  it("resets the window once it elapses", async () => {
    const t0 = 5_000_000;
    recordLogVolume("api", 900, t0);
    expect(getLogVolumeWindowBytes("api")).toBe(900);

    recordLogVolume("api", 100, t0 + 60_000);
    expect(getLogVolumeWindowBytes("api")).toBe(100);
    await expect(
      metricValue("remitmortgage_log_volume_over_budget", { service: "api" })
    ).resolves.toBe(0);
  });

  it("tracks services independently", async () => {
    const t0 = 9_000_000;
    recordLogVolume("api", 900, t0);
    recordLogVolume("worker", 100, t0);

    expect(getLogVolumeWindowBytes("api")).toBe(900);
    expect(getLogVolumeWindowBytes("worker")).toBe(100);
    await expect(
      metricValue("remitmortgage_log_volume_over_budget", { service: "worker" })
    ).resolves.toBe(0);
  });

  it("registers every log metric on the shared registry", async () => {
    const exposition = await metricsRegistry.metrics();

    for (const name of [
      "remitmortgage_log_entries_total",
      "remitmortgage_log_entries_dropped_total",
      "remitmortgage_log_volume_bytes",
      "remitmortgage_log_volume_budget_bytes",
      "remitmortgage_log_volume_utilization_ratio",
      "remitmortgage_log_volume_over_budget",
    ]) {
      expect(exposition).toContain(name);
    }
  });
});
