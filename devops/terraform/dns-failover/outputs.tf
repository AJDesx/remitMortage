# Outputs for the health-checked DNS failover module (issue #876).

output "failover_record_fqdn" {
  description = "Fully-qualified name of the failover record."
  value       = aws_route53_record.primary.fqdn
}

output "primary_health_check_id" {
  description = "Route 53 health check ID for the primary endpoint (used by the failover drill)."
  value       = aws_route53_health_check.primary.id
}

output "secondary_health_check_id" {
  description = "Route 53 health check ID for the secondary endpoint."
  value       = aws_route53_health_check.secondary.id
}

output "failover_alerts_topic_arn" {
  description = "SNS topic ARN notified on failover and failback events."
  value       = local.alerts_topic_arn
}

output "estimated_detection_seconds" {
  description = "Time for Route 53 to mark the primary unhealthy (health_check_interval * failure_threshold)."
  value       = var.health_check_interval * var.failure_threshold
}

output "estimated_recovery_seconds" {
  description = "Documented RTO: detection time plus the longest record TTL resolvers must expire."
  value       = var.health_check_interval * var.failure_threshold + max(var.primary_ttl, var.secondary_ttl)
}
