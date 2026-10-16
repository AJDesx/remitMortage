# DNS Failover Runbook

## Overview

The public API endpoint (`api.remitmortgage.com` by default) is served by a
Route 53 **health-checked failover** record pair. While the primary regional
endpoint is healthy, Route 53 answers with the `PRIMARY` record. When the
primary fails its health check, Route 53 automatically starts answering with
the `SECONDARY` record — no one edits DNS by hand, which removes the slowest
and most error-prone step from a regional outage.

- Infrastructure: [`devops/terraform/dns-failover/`](../devops/terraform/dns-failover/README.md)
- Alerts: [`devops/prometheus/dns-failover-alerts.yml`](../devops/prometheus/dns-failover-alerts.yml)
- Drill: [`scripts/dns-failover-drill.mjs`](../scripts/dns-failover-drill.mjs) ·
  [workflow](../.github/workflows/dns-failover-drill.yml)

## Architecture

```
                    Route 53 hosted zone (remitmortgage.com)
                    ┌───────────────────────────────────────┐
   client ──query──▶│  api.remitmortgage.com                │
                    │    PRIMARY  ──▶ api-primary   (health ✓)│
                    │    SECONDARY ─▶ api-secondary (health ✓)│
                    └───────────────────────────────────────┘
                              │ health check fails
                              ▼
                    PRIMARY marked UNHEALTHY
                    answers switch to SECONDARY automatically
```

## Recovery-time budget

Failover is triggered by the health check, not by the TTL. The TTL only bounds
how long a resolver can keep serving a cached primary answer after the switch.

| Stage | Setting (default) | Time |
|-------|-------------------|------|
| Probe interval | `health_check_interval = 10s` | — |
| Failures before unhealthy | `failure_threshold = 3` | **≤ 30s detection** |
| Record TTL (resolver cache) | `primary_ttl` / `secondary_ttl = 30s` | **≤ 30s propagation** |
| **Expected recovery time (RTO)** | detection + TTL + margin | **≤ 120s** |

The Terraform module exposes the exact figures as
`estimated_detection_seconds` and `estimated_recovery_seconds`; the drill fails
if the measured failover exceeds `RTO_TARGET_SECONDS` (default `120`).

## Alerts

| Alert | Severity | Meaning |
|-------|----------|---------|
| `DnsPrimaryEndpointUnhealthy` | critical | Primary health check failing — failover is happening. |
| `DnsFailoverDidNotRestoreWithinRto` | page | Primary down **and** public hostname still failing after the RTO. |
| `DnsFailoverTargetUnhealthy` | critical | Secondary is also down — no failover target left. |
| `DnsFailbackCompleted` | info | Traffic returned to the primary (stand down). |

## Automatic failover (normal path)

1. The primary endpoint starts failing its `/api/health` probe.
2. After `failure_threshold` consecutive failures (≈30s) Route 53 marks the
   primary unhealthy and begins serving the `SECONDARY` record.
3. `DnsPrimaryEndpointUnhealthy` fires and pages the on-call team.
4. Traffic reaches the secondary region within the RTO (≤120s).
5. **Stop here and fix the primary region.** Do not delete the failover records
   — they are what is keeping the API up.

No manual DNS change is required for this path.

## Manual failover (break glass)

Use this only when the automatic switch did not happen (for example the health
check itself is misreporting).

```bash
# 1. Confirm the primary is genuinely unhealthy
aws route53 get-health-check-status \
  --health-check-id "$(terraform -chdir=devops/terraform/dns-failover output -raw primary_health_check_id)"

# 2. Force Route 53 to treat the primary as down
aws route53 update-health-check \
  --health-check-id "$(terraform -chdir=devops/terraform/dns-failover output -raw primary_health_check_id)" \
  --disabled

# 3. Verify the public hostname now resolves to the secondary endpoint
dig +short api.remitmortgage.com

# 4. Confirm the API is serving from the secondary region
curl -fsS https://api.remitmortgage.com/api/health

# 5. Record the incident and the measured time from step 2 to step 4
```

Re-enable automatic checks as part of failback (below).

## Failback (documented and tested)

Failback is **automatic** once the primary is healthy again: Route 53 resumes
the `PRIMARY` record as soon as the health check passes. The drill measures
failback against `FAILBACK_TARGET_SECONDS` (default `300s`).

1. Confirm the primary endpoint is healthy:
   ```bash
   curl -fsS https://api-primary.example.com/api/health
   ```
2. If the health check was manually disabled, re-enable it:
   ```bash
   aws route53 update-health-check \
     --health-check-id "$(terraform -chdir=devops/terraform/dns-failover output -raw primary_health_check_id)" \
     --no-disabled
   ```
3. Watch the record switch back and `DnsFailbackCompleted` fire:
   ```bash
   watch -n 10 'dig +short api.remitmortgage.com'
   ```
4. Verify the primary is receiving traffic again and the secondary has drained.
5. Comment on the incident with the measured failover **and** failback times.

## Scheduled failover drill

A weekly drill exercises the failure path against staging and records the
measured recovery time.

- Workflow: **DNS Failover Drill** (`workflow_dispatch`, weekly schedule).
- Simulation (runs on every PR touching the drill or the module):
  ```bash
  node --test scripts/dns-failover-drill.test.mjs
  node scripts/dns-failover-drill.mjs --simulate --rto 120
  ```
- Live drill against staging (requires the `DNS_FAILOVER_*` secrets):
  ```bash
  DNS_FAILOVER_ENVIRONMENT=staging \
  node scripts/dns-failover-drill.mjs \
    --host api.staging.remitmortgage.com \
    --control-url https://staging-control.example.com \
    --primary-ip 1.2.3.4 --secondary-ip 5.6.7.8 \
    --rto 120
  ```

Never point the live drill at production. The workflow refuses to run unless
`--environment staging` is set.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Failover did not trigger | `aws route53 get-health-check-status --health-check-id <primary-id>`; confirm the probe path returns 2xx. |
| DNS still returns the primary | Flush local cache (`ipconfig /flushdns`, `sudo systemd-resolve --flush-caches`); query the zone's nameservers directly with `dig @<ns>`. |
| Secondary serves errors | Confirm the secondary region's app is deployed and its `/api/health` is green before relying on it. |
| `DnsFailoverTargetUnhealthy` fires too | Restore the secondary first — a failed primary plus failed secondary is a full outage. |
| Failover slower than 120s | Lower `primary_ttl`/`health_check_interval` in `devops/terraform/dns-failover` and re-run the drill. |
