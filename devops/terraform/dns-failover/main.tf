# Health-checked DNS failover (issue #876)
#
# Provisions Route 53 failover routing for a public endpoint: a PRIMARY record
# backed by a Route 53 health check and a SECONDARY record that Route 53 serves
# automatically when the primary is unhealthy. A regional outage therefore
# moves traffic without anyone editing DNS by hand.
#
# ── Tuned TTLs ─────────────────────────────────────────────────────────────
#
# Failover is decided by Route 53 health checks, not by TTL. TTL only controls
# how long resolvers cache the answer after the switch, so it is set low
# (default 30s) to bound how long a client can keep hitting the dead primary.
# Detection time is `health_check_interval * failure_threshold` (default 10s x
# 3 = 30s). Both are exposed as outputs so the runbook's RTO stays in sync.
#
# See docs/DNS_FAILOVER_RUNBOOK.md for the recovery-time budget and failback
# procedure.

terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 5.100.0"
    }
  }
}

# ── Existing hosted zone ────────────────────────────────────────────────────
# Referenced rather than created so this module can adopt the zone that already
# serves the domain (data source, not a new aws_route53_zone).
data "aws_route53_zone" "this" {
  name         = var.hosted_zone_name
  private_zone = false
}

locals {
  name_prefix = replace(var.record_name, ".", "-")
}

# ── Health checks (one per regional endpoint) ───────────────────────────────
resource "aws_route53_health_check" "primary" {
  fqdn              = var.primary_target
  port              = var.health_check_port
  type              = var.health_check_type
  resource_path     = var.health_check_path
  request_interval  = var.health_check_interval
  failure_threshold = var.failure_threshold
  enable_sni        = var.health_check_type == "HTTPS"
  measure_latency   = true

  tags = merge(var.tags, { Name = "${local.name_prefix}-primary" })
}

resource "aws_route53_health_check" "secondary" {
  fqdn              = var.secondary_target
  port              = var.health_check_port
  type              = var.health_check_type
  resource_path     = var.health_check_path
  request_interval  = var.health_check_interval
  failure_threshold = var.failure_threshold
  enable_sni        = var.health_check_type == "HTTPS"
  measure_latency   = true

  tags = merge(var.tags, { Name = "${local.name_prefix}-secondary" })
}

# ── Failover records ────────────────────────────────────────────────────────
resource "aws_route53_record" "primary" {
  zone_id        = data.aws_route53_zone.this.zone_id
  name           = var.record_name
  type           = var.record_type
  ttl            = var.primary_ttl
  set_identifier = "primary-${var.environment}"
  records        = [var.primary_target]
  health_check_id = aws_route53_health_check.primary.id

  failover_routing_policy {
    type = "PRIMARY"
  }
}

resource "aws_route53_record" "secondary" {
  zone_id        = data.aws_route53_zone.this.zone_id
  name           = var.record_name
  type           = var.record_type
  ttl            = var.secondary_ttl
  set_identifier = "secondary-${var.environment}"
  records        = [var.secondary_target]
  health_check_id = aws_route53_health_check.secondary.id

  failover_routing_policy {
    type = "SECONDARY"
  }
}

# ── Alerts for failover / failback events ───────────────────────────────────
resource "aws_sns_topic" "failover" {
  count = var.alarm_sns_topic_arn == "" ? 1 : 0
  name  = "${local.name_prefix}-dns-failover-${var.environment}"
  tags  = var.tags
}

resource "aws_sns_topic_subscription" "failover_email" {
  count     = var.alarm_sns_topic_arn == "" && var.alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.failover[0].arn
  protocol  = "email"
  endpoint  = var.alert_email
}

locals {
  created_topic_arn = try(aws_sns_topic.failover[0].arn, "")
  alerts_topic_arn  = var.alarm_sns_topic_arn != "" ? var.alarm_sns_topic_arn : local.created_topic_arn
}

# Fires on failover (alarm_actions) and again on failback (ok_actions) so the
# on-call team sees both the switch and the recovery.
resource "aws_cloudwatch_metric_alarm" "primary_unhealthy" {
  alarm_name          = "${local.name_prefix}-primary-unhealthy-${var.environment}"
  namespace           = "AWS/Route53"
  metric_name         = "HealthCheckStatus"
  dimensions          = { HealthCheckId = aws_route53_health_check.primary.id }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_description   = "Primary endpoint ${var.primary_target} is unhealthy — Route 53 is failing ${var.record_name} over to ${var.secondary_target}."
  alarm_actions       = [local.alerts_topic_arn]
  ok_actions          = [local.alerts_topic_arn]
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "secondary_unhealthy" {
  alarm_name          = "${local.name_prefix}-secondary-unhealthy-${var.environment}"
  namespace           = "AWS/Route53"
  metric_name         = "HealthCheckStatus"
  dimensions          = { HealthCheckId = aws_route53_health_check.secondary.id }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_description   = "Secondary endpoint ${var.secondary_target} is unhealthy — there is no healthy failover target for ${var.record_name}."
  alarm_actions       = [local.alerts_topic_arn]
  ok_actions          = [local.alerts_topic_arn]
  tags                = var.tags
}
