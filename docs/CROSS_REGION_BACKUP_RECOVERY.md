# Cross-Region Backup Recovery

Terraform provisions versioned, AES-256 encrypted S3 replication from the
primary backup bucket to `var.secondary_region`. Objects under `backups/` are
replicated with S3 Replication Time Control, retained for 90 days, and checked
by a CloudWatch alarm when replication latency exceeds the 15-minute recovery
point objective. The replication alarm publishes to the existing failover SNS
topic.

## Configure and verify

Set `backup_bucket_name` and `backup_replica_bucket_name`, then apply the
`devops` Terraform configuration. Confirm both buckets have versioning enabled
and inspect the replication rule:

```bash
aws s3api get-bucket-replication --bucket "$BACKUP_BUCKET" --region us-east-1
aws s3api head-bucket --bucket "$BACKUP_REPLICA_BUCKET" --region eu-west-1
aws s3api list-objects-v2 --bucket "$BACKUP_REPLICA_BUCKET" --prefix backups/ --region eu-west-1
```

The `Backup Verification` workflow runs on the first day of every month and on
manual dispatch. It checks that the replica contains a backup, restores the
latest replicated encrypted object into a disposable PostgreSQL 16 database,
and verifies the restored schema and data. Configure `BACKUP_REPLICA_BUCKET`,
`BACKUP_REPLICA_REGION`, and the existing backup encryption/AWS secrets in the
production environment.

## Recovery procedure

1. Page the on-call owner for `remitmortgage-backup-replication-*` and record
   the last successful replication timestamp.
2. Confirm the latest object in the secondary bucket has a completed version
   and matching S3 checksum/ETag metadata. Do not use an object still marked
   `PENDING` by replication.
3. Restore with `BACKUP_PROVIDER=aws`, `BACKUP_BUCKET` set to the replica
   bucket, `AWS_REGION` set to the secondary region, and the production
   `BACKUP_ENCRYPTION_KEY` into a disposable database first.
4. Run `scripts/verify-restored-backup-sanity.sh`. Promote the restored
   database only after the sanity report passes and the incident commander
   approves the recorded recovery point.
5. After the primary region recovers, stop writes to the temporary database,
   reconcile changes, and follow the multi-region failover runbook before
   switching application traffic back.

Never delete the source backup while investigating replication lag. The S3
replica lifecycle retains noncurrent versions for 30 days to support rollback.