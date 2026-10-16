# Ephemeral Preview Databases

Every pull request preview gets its **own** PostgreSQL database, so conflicting
migrations and test data can no longer collide on the shared staging database.

## Lifecycle

| Step | Where | What happens |
| --- | --- | --- |
| Create | `preview-db.yml` → `provision` (PR opened/reopened/pushed) | Restores RDS instance `remit-preview-pr-<n>` from the latest anonymized staging snapshot. Private, single-AZ, IAM auth enabled. Idempotent: a push to an existing PR reuses the instance. |
| Bootstrap | first run only | Creates the `preview_app` role (IAM auth only) via a one-time master password that is generated in memory and immediately rotated to a second random value nobody holds. |
| Migrate | every push | `prisma migrate deploy` with this PR's migrations. |
| Seed | first run only | `npm run db:seed` on top of the anonymized snapshot data. |
| Destroy (close) | `preview-env-teardown.yml` | `preview-db.mjs teardown` deletes the instance, skipping the final snapshot and automated backups. It is listed in the teardown PR comment. |
| Destroy (TTL) | `preview-db.yml` → `ttl-sweep` (hourly) | Deletes any preview database whose `PreviewExpiresAt` tag has passed. Default TTL 72 h (max 168 h). |

## Data

The snapshot is taken from staging, which is refreshed weekly by the
[anonymization pipeline](DATA_ANONYMIZATION_PIPELINE.md). Production data never
reaches a preview database.

## Credentials

No password is stored anywhere. The workflow runs `scripts/preview-db.mjs url`,
which mints an **RDS IAM authentication token valid for 15 minutes** and builds a
`DATABASE_URL` that is masked in the logs. Re-run the workflow (or the `url`
command) for a fresh one.

## Safety

- Only same-repository PRs get a database (fork PRs cannot read AWS credentials).
- PR numbers must be plain integers; identifiers are `remit-preview-pr-<n>`.
- `teardown` refuses to delete an instance unless its tags say `Preview=true`
  and `PreviewPR=<n>`; `sweep` only considers `remit-preview-pr-*` names.
- Tags: `Preview`, `PreviewPR`, `PreviewCreatedAt`, `PreviewExpiresAt`, plus the
  [cost-allocation tags](COST_ALLOCATION_TAG_POLICY.md) (`Service=preview-db`,
  `Environment=preview`, `Owner`, `CostCenter`).

## Configuration (repository variables)

| Variable | Purpose |
| --- | --- |
| `PREVIEW_DB_SNAPSHOT_ID` | Snapshot to restore. Takes precedence. |
| `PREVIEW_DB_SOURCE_INSTANCE` | Staging instance; the newest available automated snapshot is used. |
| `PREVIEW_DB_SUBNET_GROUP`, `PREVIEW_DB_SECURITY_GROUP_IDS` | Private networking. The runner must be able to reach the instance. |
| `PREVIEW_DB_INSTANCE_CLASS` | Defaults to `db.t4g.micro`. |
| `PREVIEW_DB_OWNER`, `PREVIEW_DB_COST_CENTER` | Cost-allocation tag values. |

The AWS identity needs `rds:RestoreDBInstanceFromDBSnapshot`, `rds:Describe*`,
`rds:ModifyDBInstance`, `rds:DeleteDBInstance`, `rds:AddTagsToResource`,
`rds:ListTagsForResource` and `rds-db:connect` for `preview_app`.

## Commands

```bash
node scripts/preview-db.mjs provision --pr 123 --snapshot anon-staging-snap
node scripts/preview-db.mjs url --pr 123          # DATABASE_URL, 15-minute token
node scripts/preview-db.mjs teardown --pr 123
node scripts/preview-db.mjs sweep
node --test scripts/preview-db.test.mjs           # tests (no AWS needed)
```

## Known limits

- The AWS-facing paths (restore, bootstrap against a real instance,
  `REASSIGN OWNED`) are covered by unit tests with a fake RDS client, not an
  end-to-end run; verify on the first real PR.
- The runner must have network access to the private subnet (self-hosted runner
  or VPC connectivity) for the bootstrap and migrate steps.
