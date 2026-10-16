locals {
  backup_replication_enabled = var.backup_bucket_name != "" && var.backup_replica_bucket_name != ""
  backup_replica_bucket      = var.backup_replica_bucket_name != "" ? var.backup_replica_bucket_name : "remit-mortgage-backups-replica-${var.environment}"
}

data "aws_s3_bucket" "backups" {
  count  = local.backup_replication_enabled ? 1 : 0
  bucket = var.backup_bucket_name
}

resource "aws_s3_bucket" "backup_replica" {
  count    = local.backup_replication_enabled ? 1 : 0
  provider = aws.secondary
  bucket   = local.backup_replica_bucket

  tags = merge(var.tags, { Component = "EncryptedBackupReplica" })
}

resource "aws_s3_bucket_versioning" "backup_replica" {
  count    = local.backup_replication_enabled ? 1 : 0
  provider = aws.secondary
  bucket   = aws_s3_bucket.backup_replica[0].id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backup_replica" {
  count    = local.backup_replication_enabled ? 1 : 0
  provider = aws.secondary
  bucket   = aws_s3_bucket.backup_replica[0].id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backup_replica" {
  count    = local.backup_replication_enabled ? 1 : 0
  provider = aws.secondary
  bucket   = aws_s3_bucket.backup_replica[0].id
  rule {
    id     = "retain-encrypted-backups"
    status = "Enabled"
    filter { prefix = "backups/" }
    expiration { days = 90 }
    noncurrent_version_expiration { noncurrent_days = 30 }
  }
}

resource "aws_iam_role" "backup_replication" {
  count = local.backup_replication_enabled ? 1 : 0
  name  = "remit-mortgage-backup-replication-${var.environment}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17",
    Statement = [{ Effect = "Allow", Principal = { Service = "s3.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "backup_replication" {
  count = local.backup_replication_enabled ? 1 : 0
  role  = aws_iam_role.backup_replication[0].id
  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      { Effect = "Allow", Action = ["s3:GetObjectVersionForReplication", "s3:GetObjectVersionAcl", "s3:GetObjectVersionTagging"], Resource = "${data.aws_s3_bucket.backups[0].arn}/backups/*" },
      { Effect = "Allow", Action = ["s3:ReplicateObject", "s3:ReplicateTags", "s3:ObjectOwnerOverrideToBucketOwner"], Resource = "${aws_s3_bucket.backup_replica[0].arn}/backups/*" }
    ]
  })
}

resource "aws_s3_bucket_versioning" "backups" {
  count  = local.backup_replication_enabled ? 1 : 0
  bucket = data.aws_s3_bucket.backups[0].id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_replication_configuration" "backups" {
  count      = local.backup_replication_enabled ? 1 : 0
  bucket     = data.aws_s3_bucket.backups[0].id
  role       = aws_iam_role.backup_replication[0].arn
  depends_on = [aws_s3_bucket_versioning.backups, aws_s3_bucket_versioning.backup_replica]

  rule {
    id       = "encrypted-backups-cross-region"
    priority = 1
    status   = "Enabled"
    filter { prefix = "backups/" }
    delete_marker_replication { status = "Disabled" }
    destination {
      bucket        = aws_s3_bucket.backup_replica[0].arn
      storage_class = "STANDARD_IA"
      metrics {
        status = "Enabled"
        event_threshold { minutes = 15 }
      }
      replication_time {
        status = "Enabled"
        time { minutes = 15 }
      }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "backup_replication_lag" {
  count               = local.backup_replication_enabled ? 1 : 0
  alarm_name          = "remitmortgage-backup-replication-lag-${var.environment}"
  namespace           = "AWS/S3"
  metric_name         = "ReplicationLatency"
  dimensions          = { SourceBucket = var.backup_bucket_name, DestinationBucket = local.backup_replica_bucket, RuleId = "encrypted-backups-cross-region" }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.backup_replication_lag_threshold_seconds
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching"
  alarm_description   = "Encrypted backup replication exceeded the recovery point objective."
  alarm_actions       = [aws_sns_topic.failover_alerts.arn]
}

output "backup_replica_bucket" {
  value       = local.backup_replication_enabled ? aws_s3_bucket.backup_replica[0].arn : null
  description = "Secondary-region encrypted backup replica bucket"
}