# Automated Database Backup Restore Drill

## Why This Exists

A backup that has never been restored is not a backup — it's an unverified
assumption. This drill proves, on a recurring schedule, that the actual
latest production backup can be downloaded, decrypted, and restored into a
usable database, and alerts a human the moment that stops being true.

Two separate jobs in `.github/workflows/backup-verification.yml` work
together:

| Job | Trigger | What it proves |
|---|---|---|
| `verify-restore` | Every PR touching the drill's own inputs | The drill *mechanism* (dump → restore → diff) still works, using a disposable, freshly-seeded database. No real backups or prod credentials involved. |
| `real-restore-drill` | Monthly (`0 4 1 * *`) + manual dispatch | The *real* drill: downloads and restores the actual latest object from the production backups bucket, then sanity-checks it. |

Only `real-restore-drill` answers the question that matters operationally —
"if we needed to restore right now, would it work?" — so it's the one that
pages on failure.

---

## What the Real Drill Does

1. **`backend/scripts/restore-latest-backup.ts`** finds the most recently
   created object under `backups/` in the configured bucket
   (`DatabaseBackupService.getLatestBackupKey()`) and calls
   `restoreFromBackup()` — the same download → decrypt → `pg_restore`
   path used in a real incident — against a throwaway sandbox Postgres.
   It writes `{ backupKey, restoredAt }` to a JSON file so later steps (and
   history tooling) know exactly which backup was drilled.
2. **`scripts/verify-restored-backup-sanity.sh`** then asserts the restore
   is actually *usable*, not just "completed without error":
   - **Row-count sanity** — every table in `CORE_TABLES` (default:
     `LoanApplication,Borrower,Applicant,AuditLog`) has at least one row.
     An empty core table after restoring a real production backup means
     data silently went missing.
   - **Schema version match** — the restored database's most recently
     *applied* Prisma migration (`_prisma_migrations.migration_name`,
     ordered by `finished_at`) must equal the latest migration directory
     checked out from `backend/prisma/migrations/`. A mismatch means the
     backup is schema-stale relative to what's currently deployed — still
     worth triaging even though it isn't always a hard outage (e.g. a
     backup taken just before a deploy will always lag by one migration).
3. Both the restored-backup info and the sanity report are uploaded as the
   `backup-real-drill-report` artifact (90-day retention).
4. On failure, an email alert goes out via `dawidd6/action-send-mail@v3`
   (same `ALERT_SMTP_*` / `ALERT_EMAIL_TO` secrets used by
   `dr-drill.yml`).

### Credentials

`real-restore-drill` runs under the `production` GitHub Environment and
needs:

- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — read access to the
  backups bucket (the same secrets other workflows in this repo already
  use via `aws-actions/configure-aws-credentials@v4`).
- `BACKUP_BUCKET` — the bucket `DatabaseBackupService` uploads to.
- `BACKUP_ENCRYPTION_KEY` — the key backups were encrypted with. Must
  match whatever `backend/src/jobs/backupScheduler.ts` uses in production
  (`BACKUP_ENCRYPTION_KEY` env var there too) or every restore attempt
  fails decryption.

None of these are available to a `pull_request` run — intentionally; the
`verify-restore` job exists precisely so the mechanism can be tested
without needing them.

---

## A Decryption Bug Fixed Along the Way

Building this drill surfaced a real bug in
`backend/src/services/databaseBackup.ts`: `encryptFile()` derives its key
as `sha256(encryptionKey)`, generates a random IV, and **prepends that IV
to the output file** before the ciphertext — but `decryptFile()` was using
the deprecated, keyless `createDecipher("aes-256-cbc", decryptionKey)`
API, which neither strips that prepended IV nor derives the key the same
way. Restoring a real backup would have failed decryption outright, which
this drill would have caught on its very first real run. `decryptFile()`
now reads the first 16 bytes as the IV, derives the key the same way
`encryptFile()` does, and decrypts with `createDecipheriv` — matching the
encrypt side exactly.

---

## Viewing Restore Reliability Trends

Each run's artifact expires after 90 days, but the workflow run history
itself does not. `scripts/backup-drill-history.sh` renders that history as
a table (date, pass/fail, which backup was drilled) by combining `gh run
list` with the `backup-real-drill-report` artifact of each run still
within its retention window:

```bash
./scripts/backup-drill-history.sh            # last 20 scheduled runs
./scripts/backup-drill-history.sh --limit 50
```

Use this before every quarterly reliability review, or whenever a restore
incident raises "how long has this actually been broken?" — a string of
`failure` rows pinpoints when it started, independent of how long ago the
underlying artifacts expired.

---

## How to Triage a Failure

1. Open the failing run's `backup-real-drill-report` artifact —
   `backup-sanity-report.txt` names the exact failure(s)
   (`core table "X" has 0 rows`, `schema version mismatch: ...`, or a
   restore-step failure logged before the sanity script even ran).
2. **Restore step failed outright** (before any sanity check ran) — check:
   - Are `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`BACKUP_BUCKET` still
     valid for the `production` environment?
   - Does `BACKUP_ENCRYPTION_KEY` still match what production backups were
     actually encrypted with? A rotated key without updating this secret
     looks identical to a corrupted backup.
   - Is there a backup object under `backups/` at all? `executeBackup()`
     may itself be failing silently — check `backupScheduler.ts`'s logs.
3. **Restore succeeded, sanity check failed on row counts** — the backup
   itself may be stale or the dump may have been taken mid-truncation.
   Check the backup's upload timestamp against when the affected table was
   last known non-empty in production.
4. **Restore succeeded, schema version mismatch** — confirm whether this is
   expected lag (backup predates the latest deploy by one migration) or a
   genuine problem (the restored migration doesn't exist in
   `backend/prisma/migrations/` at all, suggesting drift between what's
   deployed and what's in this repo — see
   `docs/terraform-drift-remediation.md` sibling concerns, though this is
   an application-schema, not infrastructure, drift).

## Running the Real Drill's Steps Locally

```bash
# 1. Point at a throwaway sandbox database.
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/sandbox
export BACKUP_ENCRYPTION_KEY=<the real key>
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... BACKUP_BUCKET=...

cd backend
npx tsx scripts/restore-latest-backup.ts --out ../backup-drill-restored.json
cd ..

# 2. Sanity-check what just got restored.
SANDBOX_DATABASE_URL=$DATABASE_URL \
RESTORED_BACKUP_INFO=backup-drill-restored.json \
  ./scripts/verify-restored-backup-sanity.sh
```
