# SLO Error Budgets and Burn-Rate Alerting

Threshold alerts on raw metrics fire on harmless blips and miss slow
degradations. We instead define service level objectives (SLOs) for the key user
journeys and alert on how fast each one is consuming its **error budget**.

## Service level objectives

Window for every SLO: rolling **30 days**.

| SLO | Journey (SLI) | Target | Error budget | Bad event |
| --- | --- | --- | --- | --- |
| `api-availability` | Any public API request succeeds | 99.9% | 0.1% (~43 min/30d) | HTTP 5xx (excl. `/metrics`, `/api/health`) |
| `api-latency` | API requests finish quickly | 95% under 500 ms | 5% | Request slower than 500 ms |
| `tx-submission-success` | Loan and milestone write requests (they build and submit Soroban transactions) succeed | 99.5% | 0.5% | `POST /api/loan*` or `/api/milestone*` returns 5xx |

4xx responses are caller errors and do not consume budget. All SLIs use the
existing `remitmortgage_http_requests_total` and
`remitmortgage_http_request_duration_seconds` metrics; the latency SLI uses the
`le="0.5"` histogram bucket, so changing the bucket layout in
`backend/src/services/metrics.ts` requires updating the SLO.

## Burn-rate alerts

A burn rate of 1 means the budget would be exactly used up at the end of the
window. Each alert needs **both** a long and a short window above its burn rate:
the long window proves the burn is significant, the short one makes the alert
clear quickly once the problem stops.

| Tier | Burn rate | Windows (long / short) | Budget consumed in long window | Severity | Action |
| --- | --- | --- | --- | --- | --- |
| fast | 14.4x | 1h / 5m | 2% | `page` | Pages on-call via PagerDuty |
| medium | 6x | 6h / 30m | 5% | `page` | Pages on-call via PagerDuty |
| slow | 3x | 1d / 2h | 10% | `ticket` | Opens a ticket + Slack |
| gradual | 1x | 3d / 6h | 10% | `ticket` | Opens a ticket + Slack |

A paging alert for an SLO inhibits its ticket alert (`alertmanager.yml`).
Alert names look like `SLOBurnFast_ApiAvailability`.

## Dashboard

`devops/grafana/slo-error-budget-dashboard.json` (import into Grafana, pick the
Prometheus data source) shows, per SLO, the **remaining error budget** gauge
(`slo:error_budget_remaining:ratio`), the budget over time, and the 1h burn rate
against the paging threshold.

## When a budget is exhausted

"Exhausted" means `slo:error_budget_remaining:ratio` is at or below 0 for the
30-day window.

1. **Freeze risky change.** Stop feature releases and non-essential
   infrastructure changes for the affected service. Only reliability fixes,
   security fixes and rollbacks ship.
2. **Name an owner** for the SLO within one business day and open a tracking
   issue linking the dashboard and the burn-rate alerts that fired.
3. **Post-incident review** within five business days for any paging burn that
   contributed, with at least one action item that reduces the burn.
4. **Unfreeze** when the remaining budget is back above 0 (or the engineering
   lead and on-call explicitly accept the risk in the tracking issue).
5. If the budget is exhausted twice in a quarter, revisit the SLO target or
   dedicate the next sprint to reliability work.

Below 25% remaining (orange on the dashboard), releases need a rollback plan
reviewed by the on-call engineer.

## Changing or adding an SLO

1. Edit `devops/slo/slos.json` (target, tiers or a new SLO).
2. Run `node scripts/generate-slo-artifacts.mjs` to regenerate
   `devops/prometheus/slo-burn-rate-alerts.yml` and the dashboard. Never edit
   the generated files by hand.
3. Run the dry-run: `node --test scripts/slo-burn-rate.test.mjs`.

## Dry-run / replay test

`scripts/slo-burn-rate.test.mjs` replays synthetic per-minute failure data
through the same tier definitions the rules are generated from. It asserts, for
example, that a total outage pages within minutes, a sustained 20x burn pages
at about 45 minutes, a 4x burn only opens a ticket (at about 18 hours), a 2x
burn trips only the 3-day ticket, and a one-minute blip or a 0.5x burn never
alerts. It also fails if the committed rules or dashboard drift from the
generator. CI runs it via `.github/workflows/slo-alert-validation.yml`.
