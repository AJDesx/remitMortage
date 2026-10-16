# Log Sampling and Volume Cost Controls

## Overview

RemitMortgage's logging volume grows with traffic, and the noisiest lines
(`debug` / `info`) are usually the least valuable. This policy thins those lines
while guaranteeing that the entries which matter — errors, warnings and audit
events — are **never** dropped. It also measures per-service log volume and
raises a Prometheus alert when a service exceeds its configured budget.

Implementation: [`backend/src/utils/logSampling.ts`](../backend/src/utils/logSampling.ts),
wired into the root logger in [`backend/src/utils/logger.ts`](../backend/src/utils/logger.ts).
Alert rules: [`devops/prometheus/log-volume-alerts.yml`](../devops/prometheus/log-volume-alerts.yml).

## Guarantees

| Level            | Sampled? | Notes                                                        |
|------------------|----------|--------------------------------------------------------------|
| `error`          | **Never**| Always emitted, always counted.                              |
| `warn`           | **Never**| Always emitted.                                              |
| audit events     | **Never**| Tagged `audit: true` or `source: "audit"` by `logAuditEvent`. |
| `info`           | Yes      | 1-in-N per level and source (default 1-in-10).               |
| `debug`          | Yes      | 1-in-N per level and source (default 1-in-100).              |
| everything else  | No       | Levels such as `http`, `verbose`, `silly` are kept.          |

The "never drop" guarantee is enforced in code and covered by tests
(`backend/src/__tests__/logSampling.test.ts`) that emit hundreds of errors and
audit events under an aggressive sample rate and assert every one survives.

## How sampling works

Sampling is **deterministic 1-in-N**, not random. Each `(level, source)` pair
has its own counter; every Nth entry is kept. This gives an exact ratio, keeps
the decision cheap, and makes tests reproducible. Because counters are keyed by
source, one noisy module cannot starve another's logs.

A log's `source` defaults to `unknown` unless the caller sets it in metadata
(`logger.info("msg", { source: "eventListener" })`). Helpers already tag their
own source: HTTP access logs use `source: "http"`, and errors use
`source: "error"` (moot — errors are never sampled).

## Configuration

| Variable                          | Default            | Purpose                                                        |
|-----------------------------------|--------------------|----------------------------------------------------------------|
| `LOG_SAMPLING_ENABLED`            | `true` in prod     | Master switch for noisy-level sampling.                        |
| `LOG_SAMPLE_RATE_INFO`            | `10`               | Keep 1 in N `info` lines. `1` keeps all.                       |
| `LOG_SAMPLE_RATE_DEBUG`           | `100`              | Keep 1 in N `debug` lines. `1` keeps all.                      |
| `LOG_SAMPLE_EXEMPT_SOURCES`       | *(empty)*          | Comma-separated sources that bypass sampling entirely.        |
| `LOG_VOLUME_BUDGET_BYTES`         | `1073741824` (1 GiB) | Per-service byte budget for one window.                     |
| `LOG_VOLUME_BUDGET_WINDOW_MS`     | `3600000` (1 h)    | Length of the budget window.                                   |

Outside production, sampling is **off by default** so local runs and tests keep
every line. Malformed or non-positive rates/budgets fall back to the defaults so
a typo can never accidentally disable error logging or the budget alerts.

Sizing the budget: start from real traffic. If a service ingests roughly `X`
bytes/hour of *sampled* logs, set `LOG_VOLUME_BUDGET_BYTES` a comfortable margin
above `X` (for example 1.5x–2x) so the alert fires on genuine step changes — a
retry loop, an exception cascade, or a new verbose call site — rather than
normal variance.

## Metrics

Exported on the `/metrics` endpoint (`backend/src/services/metrics.ts` registry):

| Metric | Type | Labels | Meaning |
|--------|------|--------|---------|
| `remitmortgage_log_entries_total` | Counter | `service`, `level` | Entries emitted after sampling. |
| `remitmortgage_log_entries_dropped_total` | Counter | `service`, `level` | Entries dropped by sampling. |
| `remitmortgage_log_volume_bytes` | Gauge | `service` | Bytes logged in the current window. |
| `remitmortgage_log_volume_budget_bytes` | Gauge | `service` | Configured budget for the window. |
| `remitmortgage_log_volume_utilization_ratio` | Gauge | `service` | `bytes / budget`; `> 1` means over budget. |
| `remitmortgage_log_volume_over_budget` | Gauge | `service` | `1` when over budget, else `0`. |

Bytes are estimated from the serialized log entry and are intentionally
approximate; they are a cost signal, not an exact billing figure.

## Alerting

`devops/prometheus/log-volume-alerts.yml` provides:

- **`LogVolumeBudgetExceeded`** — fires when
  `remitmortgage_log_volume_over_budget > 0` for 5 minutes. This is the
  acceptance criterion: a service over its volume budget triggers an alert.
- **`LogVolumeBudgetApproaching`** — warning at `> 80%` of budget for 15
  minutes, giving room to act before the hard limit.
- **`LogSamplingDropRateHigh`** — informational; surfaces sources being thinned
  at more than 95%, which may indicate a source noisier than the policy assumed.
- **`LogVolumeBudgetNotConfigured`** — fires if the budget gauge is `0`,
  meaning the budget alerts are silently disabled.

## Runbook: responding to `LogVolumeBudgetExceeded`

1. Identify the noisy level and service from
   `remitmortgage_log_entries_total{service=...}` and the matching
   `remitmortgage_log_entries_dropped_total`.
2. Search logs for a recent step change: a retry loop, an exception cascade, or
   a newly added verbose call site in that service.
3. Fix the root cause (reduce the loop, downgrade the level to `debug`, or add a
   `source` exemption only if the volume is genuinely valuable).
4. If the volume is expected and valuable, raise `LOG_VOLUME_BUDGET_BYTES`
   deliberately and record why.
5. Remember: errors, warnings and audit events are never sampled, so this
   volume is **not** the compliance trail and raising the budget does not risk
   losing those entries.

## Testing

`backend/src/__tests__/logSampling.test.ts` covers:

- Configuration parsing and defaults.
- Errors, warnings and audit events surviving an aggressive sample rate.
- Deterministic 1-in-N thinning of `info` / `debug`, per source.
- Exempt sources and the disabled-sampling path.
- End-to-end winston format behaviour through a capture transport.
- Volume accumulation, window rollover, per-service isolation, and the
  over-budget gauge that drives the alert.
