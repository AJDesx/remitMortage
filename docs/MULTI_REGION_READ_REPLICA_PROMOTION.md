# Multi-Region Read Replica Promotion

## Scope Note

`devops/MULTI_REGION_FAILOVER_GUIDE.md` documents this repository's existing
multi-region failover runbook — but that runbook is entirely about the
**indexer/API DNS failover** (Route 53 health checks over EC2 instances in
`devops/terraform/multi-region-failover.tf`). There was no written or
codified runbook for **database read-replica promotion**, and no RDS read
replica provisioned anywhere in Terraform. This document and the tooling it
describes are the first version of that — not a conversion of an existing
manual doc, but the promotion procedure made explicit and automated from
the ground up, following the same dry-run/confirmation conventions already
established by this repo's other operational scripts
(`scripts/chaos-failover.sh`, `scripts/dr-drill.sh`).

---

## The Automation

`scripts/promote-read-replica.sh` runs the full procedure as one pipeline
instead of an operator typing AWS CLI commands by hand mid-incident:

1. **Validate preconditions** (always, in every mode):
   - **Replica health** — `pg_is_in_recovery()` on the replica must be
     `true` (it's actually currently a standby, not already promoted or
     some unrelated database).
   - **Replication lag** — computed the same way
     `backend/src/services/db.ts`'s `getReadReplicaLagSeconds()` does
     (`EXTRACT(EPOCH FROM (NOW() - pg_last_xact_replay_timestamp()))`),
     checked against `DB_REPLICA_LAG_THRESHOLD_SECONDS` (default 30,
     matching `backend/src/services/dbPoolConfig.ts`'s default). Promoting
     with excessive lag means losing however many seconds of writes are
     still unreplicated.
   - **RDS instance status** — must report `available`.
2. **`--dry-run`** stops here. It prints the precondition results and
   exits — zero AWS mutations, regardless of whether preconditions passed
   or failed.
3. **A real promotion** (no `--dry-run`) re-validates every precondition
   above, then additionally **requires `--yes`** — omitting it exits with
   a clear message to re-run with the flag, so a promotion never happens
   as a side effect of forgetting a flag. Only once confirmed:
   - **Replica promotion** — `aws rds promote-read-replica`, then polls
     until the instance reports `available` again (timeout
     `PROMOTION_TIMEOUT_SECONDS`, default 900s).
   - **Connection string cutover** — writes the new primary's endpoint into
     `DATABASE_SECRET_ARN` via `aws secretsmanager put-secret-value`
     (the same secret `devops/main.tf`'s App Runner service already reads
     `DATABASE_URL` from — see `var.database_secret_arn` there).
   - **Application config update** — `aws apprunner start-deployment` on
     `APP_RUNNER_SERVICE_ARN`, forcing the running service to restart and
     pick up the newly-cut-over secret (App Runner, like most platforms,
     reads secrets once at task start — the cutover above does nothing
     until something forces a redeploy).

The old primary is **not** touched — it's left running and is not
automatically demoted, stopped, or deleted. Decommissioning it is a
separate, deliberate step once the new primary is confirmed healthy, not
something this script should do as a side effect of promotion.

### Required configuration

| Variable | Used for |
|---|---|
| `REPLICA_DB_INSTANCE_ID` | RDS identifier of the replica to promote |
| `REPLICA_DATABASE_URL` | Direct psql connection to the replica, for the health/lag preconditions |
| `DATABASE_SECRET_ARN` | Secrets Manager secret the application reads `DATABASE_URL` from |
| `PROMOTED_DATABASE_URL_TEMPLATE` | Connection string template with a literal `__ENDPOINT__` placeholder, e.g. `postgres://user:pass@__ENDPOINT__/remitmortgage` — only required for a real promotion |
| `APP_RUNNER_SERVICE_ARN` | App Runner service to redeploy after cutover |
| `DB_REPLICA_LAG_THRESHOLD_SECONDS` | Optional, default 30 |
| `PROMOTION_TIMEOUT_SECONDS` | Optional, default 900 |

## The Workflow

`.github/workflows/replica-promotion.yml` wraps the script in
`workflow_dispatch` with two inputs — `environment` (`staging` /
`production`) and `dry_run` (boolean, **defaults to `true`**). Running it
is layered with three independent safety mechanisms, not just the one in
the script:

1. `dry_run` defaults to `true` — an operator has to deliberately flip it.
2. The job runs under the chosen GitHub **Environment**, so a production
   promotion is additionally gated by whatever required-reviewer
   protection rule that environment has configured — a second person has
   to approve the run before it starts.
3. The script's own `--yes` requirement, which the workflow only passes
   when `dry_run` is `false`.

Secrets (`REPLICA_DB_INSTANCE_ID`, `REPLICA_DATABASE_URL`,
`DATABASE_SECRET_ARN`, `PROMOTED_DATABASE_URL_TEMPLATE`,
`APP_RUNNER_SERVICE_ARN`, plus the repo's existing `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY`) are scoped per-environment, so `staging` and
`production` runs can never accidentally point at each other's instances.

## Testing Against a Non-Production Setup

`devops/terraform/read-replica.tf` adds an **opt-in** (disabled by default)
cross-region read replica of the primary database, reusing the
primary/secondary provider aliases `devops/terraform/multi-region-failover.tf`
already sets up:

```hcl
# In a non-production tfvars:
enable_db_read_replica  = true
primary_db_instance_arn = "<ARN of devops/main.tf's aws_db_instance.postgres, in that environment>"
```

To test the automation end to end against that non-prod replica:

```bash
# 1. Stand up the replica in a staging workspace.
cd devops/terraform
terraform apply -var enable_db_read_replica=true -var primary_db_instance_arn=<arn>

# 2. Dry run — confirms the script can see and read the real replica.
gh workflow run replica-promotion.yml -f environment=staging -f dry_run=true

# 3. Once satisfied, a real promotion against the SAME non-prod replica —
#    never run dry_run=false against `environment=production` until this
#    has been exercised successfully in staging.
gh workflow run replica-promotion.yml -f environment=staging -f dry_run=false
```

This is the same "exercise it for real against non-prod before trusting it
in prod" approach already used by `multi-region-chaos.yml` (which only ever
targets the `staging` GitHub Environment).

## Triaging a Failed Dry Run

The dry run's report (`replica-promotion-report.txt`, uploaded as the
`replica-promotion-report-<run-id>` artifact) names exactly which
precondition failed:

- **`could not connect to replica`** — check `REPLICA_DATABASE_URL`,
  security group rules between the GitHub-hosted runner's egress and the
  RDS instance, and that the instance hasn't already been promoted by a
  previous run.
- **`target is not currently a replica`** — it was already promoted (by a
  prior run, or manually) and this script is now pointed at a standalone
  primary. Re-point it at an actual replica, or there's nothing to do.
- **`replica lag exceeds threshold`** — either wait for the replica to
  catch up, or, if this is urgent enough to accept the data loss, re-run
  with a knowingly higher `DB_REPLICA_LAG_THRESHOLD_SECONDS` — never edit
  the script to skip the check.
- **`RDS instance status is "..."`** — the instance is mid-maintenance,
  mid-backup, or otherwise not in a promotable state; wait and retry.
