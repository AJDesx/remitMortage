# DNS Failover Module

Health-checked Route 53 failover routing for a public endpoint, so a regional
outage moves traffic automatically instead of requiring a manual DNS edit.

See [`docs/DNS_FAILOVER_RUNBOOK.md`](../../../docs/DNS_FAILOVER_RUNBOOK.md)
for the recovery-time budget, failover/failback procedures, and the drill.

## What it creates

| Resource | Purpose |
|----------|---------|
| `aws_route53_health_check.primary` / `.secondary` | Probes each regional endpoint (`HTTPS /api/health` by default). |
| `aws_route53_record.primary` | `PRIMARY` failover record → `primary_target`, health-checked. |
| `aws_route53_record.secondary` | `SECONDARY` failover record → `secondary_target`, health-checked. |
| `aws_cloudwatch_metric_alarm.primary_unhealthy` / `.secondary_unhealthy` | Alert on failover (`alarm_actions`) and failback (`ok_actions`). |
| `aws_sns_topic.failover` | Created only when `alarm_sns_topic_arn` is empty. |

## TTL and recovery-time tuning

Failover is decided by the health check, not the TTL. The two numbers that set
recovery time are:

- `health_check_interval` (default `10`) × `failure_threshold` (default `3`) = **30s detection**
- `primary_ttl` / `secondary_ttl` (default `30`) = **≤30s resolver cache**

With the defaults the module reports `estimated_recovery_seconds = 60`. Lower
`health_check_interval` to `10` and the TTL to `30` for the fastest switch;
raise them to reduce Route 53 health-check cost where a slower RTO is
acceptable.

## Usage

```hcl
module "api_dns_failover" {
  source = "./terraform/dns-failover"

  hosted_zone_name = "remitmortgage.com"
  record_name      = "api.remitmortgage.com"
  primary_target   = "api-primary.example.com"
  secondary_target = "api-secondary.example.com"
  environment      = "production"
  alert_email      = "ops@remitmortgage.com"
  tags = {
    Project     = "RemitMortgage"
    Environment = "production"
  }
}
```

Apply from the directory that contains the module call:

```bash
terraform init
terraform validate
terraform plan
terraform apply
```

## Verify after apply

```bash
terraform output failover_record_fqdn
terraform output estimated_recovery_seconds

aws route53 get-health-check-status \
  --health-check-id "$(terraform output -raw primary_health_check_id)"
```

Then run the scheduled drill (`scripts/dns-failover-drill.mjs`) or trigger the
**DNS Failover Drill** workflow to confirm failover and failback against the
target time. See the runbook for the manual test.
