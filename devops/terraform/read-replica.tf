# Cross-Region RDS Read Replica
#
# Provisions (opt-in, disabled by default) a cross-region read replica of the
# primary database managed in devops/main.tf (aws_db_instance.postgres), in
# the secondary region already configured for indexer failover in
# multi-region-failover.tf. This is the target the promotion automation
# (scripts/promote-read-replica.sh, .github/workflows/replica-promotion.yml)
# drills against — see docs/MULTI_REGION_READ_REPLICA_PROMOTION.md.
#
# Disabled by default (enable_db_read_replica = false) so existing
# environments are unaffected; enable it in a non-production tfvars to stand
# up a replica to test the promotion pipeline against.

variable "enable_db_read_replica" {
  type        = bool
  description = "Whether to provision the cross-region RDS read replica used by the promotion drill"
  default     = false
}

variable "primary_db_instance_arn" {
  type        = string
  description = "ARN of the primary RDS instance to replicate (devops/main.tf's aws_db_instance.postgres). Required cross-region — RDS needs the ARN, not just the identifier, for a cross-region replicate_source_db."
  default     = ""
}

variable "read_replica_instance_class" {
  type        = string
  description = "Instance class for the read replica"
  default     = "db.t3.micro"
}

resource "aws_db_instance" "read_replica" {
  count    = var.enable_db_read_replica ? 1 : 0
  provider = aws.secondary

  identifier          = "remit-mortgage-db-replica-${var.environment}"
  replicate_source_db = var.primary_db_instance_arn
  instance_class      = var.read_replica_instance_class
  publicly_accessible = false
  skip_final_snapshot = true

  tags = var.tags
}

output "read_replica_identifier" {
  description = "RDS instance identifier of the read replica, if enabled (input to scripts/promote-read-replica.sh)"
  value       = var.enable_db_read_replica ? aws_db_instance.read_replica[0].identifier : null
}

output "read_replica_endpoint" {
  description = "Connection endpoint of the read replica, if enabled"
  value       = var.enable_db_read_replica ? aws_db_instance.read_replica[0].endpoint : null
}
