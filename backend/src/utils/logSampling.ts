// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Log sampling and volume cost controls (issue #875).
 *
 * Log volume and cost grow without bound, and high-volume low-value lines
 * drown out the entries that matter. This module adds:
 *
 *   1. Deterministic sampling of noisy `debug` / `info` lines, per level and
 *      per `source`, configured through the environment.
 *   2. A hard guarantee that `error`, `warn` and audit entries are never
 *      sampled — see {@link NEVER_SAMPLED_LEVELS}.
 *   3. Per-service volume accounting in a rolling budget window, exported as
 *      Prometheus metrics so `devops/prometheus/log-volume-alerts.yml` can
 *      page when a service exceeds its budget.
 *
 * ── Why deterministic 1-in-N and not random sampling ────────────────────────
 *
 * Random sampling makes tests flaky and makes "did we keep this line?" depend
 * on the RNG. Counting per (level, source) and keeping every Nth entry gives an
 * exact ratio, is trivially unit-testable, and keeps the decision cheap.
 *
 * ── Integration point ───────────────────────────────────────────────────────
 *
 * {@link logSamplingFormat} is a winston format that returns `false` to drop an
 * entry (the documented logform filtering contract) and records the volume /
 * sampling counters as a side effect. It is wired into the root logger in
 * `utils/logger.ts`, so every call site is covered without changes.
 */

import winston from "winston";
import { Counter, Gauge } from "prom-client";

import { metricsRegistry } from "../services/metrics.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default service label when no `service` is present on the entry. */
export const DEFAULT_SERVICE_NAME = "remitmortgage-backend";

/** Levels that are never sampled, regardless of configuration. */
export const NEVER_SAMPLED_LEVELS: ReadonlySet<string> = new Set([
  "error",
  "warn",
  "audit",
]);

/** Default 1-in-N keep ratio for `info` lines. */
export const DEFAULT_INFO_SAMPLE_RATE = 10;

/** Default 1-in-N keep ratio for `debug` lines. */
export const DEFAULT_DEBUG_SAMPLE_RATE = 100;

/** Default per-service log budget for one window (1 GiB). */
export const DEFAULT_VOLUME_BUDGET_BYTES = 1024 * 1024 * 1024;

/** Default budget window (1 hour). */
export const DEFAULT_VOLUME_BUDGET_WINDOW_MS = 60 * 60 * 1000;

export interface LogSamplingConfig {
  /** Whether sampling of noisy levels is active at all. */
  enabled: boolean;
  /** Keep 1 in N `info` lines (1 = keep all). */
  infoSampleRate: number;
  /** Keep 1 in N `debug` lines (1 = keep all). */
  debugSampleRate: number;
  /** Sources that are exempt from sampling entirely. */
  exemptSources: readonly string[];
  /** Per-service byte budget for one window. */
  volumeBudgetBytes: number;
  /** Length of the volume budget window, in milliseconds. */
  volumeBudgetWindowMs: number;
}

/** Parse a positive integer, falling back on malformed or non-positive input. */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Sampling defaults to on in production and off elsewhere unless overridden. */
function resolveEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.LOG_SAMPLING_ENABLED === "true") return true;
  if (env.LOG_SAMPLING_ENABLED === "false") return false;
  return env.NODE_ENV === "production";
}

/** Read the sampling / budget configuration from the environment. */
export function resolveLogSamplingConfig(
  env: NodeJS.ProcessEnv = process.env
): LogSamplingConfig {
  return {
    enabled: resolveEnabled(env),
    infoSampleRate: parsePositiveInt(
      env.LOG_SAMPLE_RATE_INFO,
      DEFAULT_INFO_SAMPLE_RATE
    ),
    debugSampleRate: parsePositiveInt(
      env.LOG_SAMPLE_RATE_DEBUG,
      DEFAULT_DEBUG_SAMPLE_RATE
    ),
    exemptSources: String(env.LOG_SAMPLE_EXEMPT_SOURCES || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    volumeBudgetBytes: parsePositiveInt(
      env.LOG_VOLUME_BUDGET_BYTES,
      DEFAULT_VOLUME_BUDGET_BYTES
    ),
    volumeBudgetWindowMs: parsePositiveInt(
      env.LOG_VOLUME_BUDGET_WINDOW_MS,
      DEFAULT_VOLUME_BUDGET_WINDOW_MS
    ),
  };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** Entries emitted after sampling, by service and level. */
export const logEntriesTotal = new Counter({
  name: "remitmortgage_log_entries_total",
  help: "Log entries emitted after sampling, by service and level.",
  labelNames: ["service", "level"] as const,
  registers: [metricsRegistry],
});

/** Entries dropped by sampling, by service and level. */
export const logEntriesDroppedTotal = new Counter({
  name: "remitmortgage_log_entries_dropped_total",
  help: "Log entries dropped by sampling, by service and level.",
  labelNames: ["service", "level"] as const,
  registers: [metricsRegistry],
});

/** Bytes logged by a service in the current budget window. */
export const logVolumeBytes = new Gauge({
  name: "remitmortgage_log_volume_bytes",
  help: "Bytes logged by a service in the current budget window.",
  labelNames: ["service"] as const,
  registers: [metricsRegistry],
});

/** Configured per-window log volume budget for a service. */
export const logVolumeBudgetBytes = new Gauge({
  name: "remitmortgage_log_volume_budget_bytes",
  help: "Configured log volume budget (bytes per window) for a service.",
  labelNames: ["service"] as const,
  registers: [metricsRegistry],
});

/** Window bytes as a fraction of the budget; > 1 means over budget. */
export const logVolumeUtilizationRatio = new Gauge({
  name: "remitmortgage_log_volume_utilization_ratio",
  help: "Log volume as a fraction of the configured per-window budget.",
  labelNames: ["service"] as const,
  registers: [metricsRegistry],
});

/** 1 when a service has exceeded its window budget, otherwise 0. */
export const logVolumeOverBudget = new Gauge({
  name: "remitmortgage_log_volume_over_budget",
  help: "1 when a service has exceeded its log volume budget, otherwise 0.",
  labelNames: ["service"] as const,
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// Sampling state
// ---------------------------------------------------------------------------

let config: LogSamplingConfig = resolveLogSamplingConfig();

/** Per (level|source) counters powering deterministic 1-in-N sampling. */
const sampleCounters = new Map<string, number>();

/** Read the effective configuration. */
export function getLogSamplingConfig(): LogSamplingConfig {
  return config;
}

/**
 * (Re)load configuration from the environment and clear sampling counters.
 * Called once at logger construction; tests call it with an explicit env.
 */
export function initLogSampling(
  env: NodeJS.ProcessEnv = process.env
): LogSamplingConfig {
  config = resolveLogSamplingConfig(env);
  sampleCounters.clear();
  // Publish the configured budget up front so the metric exists (and the
  // "not configured" guard alert can stay quiet) before the first log line.
  logVolumeBudgetBytes.set(
    { service: DEFAULT_SERVICE_NAME },
    config.volumeBudgetBytes
  );
  return config;
}

/** Test hook — clears counters and volume windows without touching config. */
export function resetLogSamplingState(): void {
  sampleCounters.clear();
  volumeWindows.clear();
}

/** Keep ratio for a level; anything not debug/info keeps every entry. */
export function sampleRateForLevel(
  level: string,
  cfg: LogSamplingConfig = config
): number {
  switch (level.toLowerCase()) {
    case "debug":
      return cfg.debugSampleRate;
    case "info":
      return cfg.infoSampleRate;
    default:
      return 1;
  }
}

export interface LogSamplingDecisionInput {
  level: string;
  source?: string;
  /** Explicit audit marker. Audit entries are never sampled. */
  audit?: boolean;
}

/**
 * Decide whether one entry survives sampling.
 *
 * Errors, warnings and audit events always survive. Sampling only ever thins
 * `debug` / `info` lines, and only when enabled and the source is not exempt.
 * The decision is a pure function of the config plus an internal per
 * (level, source) counter, so it is deterministic and testable.
 */
export function shouldKeepLog(input: LogSamplingDecisionInput): boolean {
  const level = String(input.level).toLowerCase();
  const source = (input.source ?? "unknown").toLowerCase();

  if (
    input.audit === true ||
    source === "audit" ||
    NEVER_SAMPLED_LEVELS.has(level)
  ) {
    return true;
  }
  if (!config.enabled) return true;
  if (config.exemptSources.includes(source)) return true;

  const rate = sampleRateForLevel(level);
  if (rate <= 1) return true;

  const key = `${level}|${source}`;
  const count = (sampleCounters.get(key) ?? 0) + 1;
  sampleCounters.set(key, count);
  return count % rate === 0;
}

// ---------------------------------------------------------------------------
// Volume budget accounting
// ---------------------------------------------------------------------------

interface VolumeWindow {
  /** Start of the current window (epoch ms). */
  start: number;
  /** Bytes recorded in this window. */
  bytes: number;
}

const volumeWindows = new Map<string, VolumeWindow>();

/**
 * Record bytes logged by a service, rolling the window when it elapses, and
 * republish the budget gauges. The clock is injectable for deterministic tests.
 */
export function recordLogVolume(
  service: string,
  bytes: number,
  now: number = Date.now()
): void {
  if (bytes <= 0) return;

  let window = volumeWindows.get(service);
  if (!window || now - window.start >= config.volumeBudgetWindowMs || now < window.start) {
    window = { start: now, bytes: 0 };
    volumeWindows.set(service, window);
  }
  window.bytes += bytes;
  publishVolume(service, window);
}

function publishVolume(service: string, window: VolumeWindow): void {
  const budget = config.volumeBudgetBytes;
  const ratio = budget > 0 ? window.bytes / budget : 0;

  logVolumeBytes.set({ service }, window.bytes);
  logVolumeBudgetBytes.set({ service }, budget);
  logVolumeUtilizationRatio.set({ service }, ratio);
  logVolumeOverBudget.set({ service }, ratio > 1 ? 1 : 0);
}

/** Bytes a service has logged in its current window (0 when none). */
export function getLogVolumeWindowBytes(service: string): number {
  return volumeWindows.get(service)?.bytes ?? 0;
}

// ---------------------------------------------------------------------------
// Winston integration
// ---------------------------------------------------------------------------

/** Best-effort serialized size of a log entry, in bytes. */
export function estimateLogBytes(info: Record<string, unknown>): number {
  try {
    return Buffer.byteLength(JSON.stringify(info)) || 1;
  } catch {
    const message = typeof info.message === "string" ? info.message : "";
    return Buffer.byteLength(message) || 1;
  }
}

/** True when an entry is an audit event and must bypass sampling. */
export function isAuditEntry(
  info: Record<string, unknown>,
  source: string,
  level: string
): boolean {
  return info.audit === true || source === "audit" || level === "audit";
}

/**
 * Winston format implementing the policy. Drops sampled-out entries (returns
 * `false`) and records the emitted / dropped / volume counters otherwise.
 */
export const logSamplingFormat = winston.format((info) => {
  const level = String(info.level ?? "info").toLowerCase();
  const source = typeof info.source === "string" ? info.source : "unknown";
  const service =
    typeof info.service === "string" ? info.service : DEFAULT_SERVICE_NAME;
  const audit = isAuditEntry(info, source.toLowerCase(), level);

  if (shouldKeepLog({ level, source, audit })) {
    logEntriesTotal.inc({ service, level });
    recordLogVolume(service, estimateLogBytes(info));
    return info;
  }

  logEntriesDroppedTotal.inc({ service, level });
  return false;
});
