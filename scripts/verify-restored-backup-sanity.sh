#!/bin/bash
#
# Sanity checks for a restored backup, run after restore-latest-backup.ts has
# pg_restore'd the actual latest production backup into a sandbox database.
#
# A restore that merely "completes without error" can still be useless — the
# dump could be stale, truncated mid-table, or taken against a schema several
# migrations behind what the application now expects. This script asserts
# the restore is actually *usable*:
#
#   1. Key tables have at least one row (an empty core table after restoring
#      a production backup means the restore silently dropped data).
#   2. The restored database's latest applied Prisma migration matches the
#      latest migration directory checked out in this run — i.e. the backup
#      isn't schema-stale relative to what's currently deployed.
#
# Usage:
#   SANDBOX_DATABASE_URL=postgres://... ./scripts/verify-restored-backup-sanity.sh
#
# Environment:
#   SANDBOX_DATABASE_URL    Database that was just restored into. Read-only here.
#   MIGRATIONS_DIR          Prisma migrations directory. Default: backend/prisma/migrations
#   CORE_TABLES             Comma-separated list of tables that must be non-empty.
#                           Default: LoanApplication,Borrower,Applicant,AuditLog
#   RESTORED_BACKUP_INFO    Optional path to the JSON restore-latest-backup.ts
#                           wrote ({ backupKey, restoredAt }), included in the report.
#   REPORT_PATH             Optional path for the machine-readable summary.

set -euo pipefail

SANDBOX_DATABASE_URL="${SANDBOX_DATABASE_URL:-}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-backend/prisma/migrations}"
CORE_TABLES="${CORE_TABLES:-LoanApplication,Borrower,Applicant,AuditLog}"
RESTORED_BACKUP_INFO="${RESTORED_BACKUP_INFO:-}"
REPORT_PATH="${REPORT_PATH:-backup-sanity-report.txt}"

if [[ -z "$SANDBOX_DATABASE_URL" ]]; then
  echo "❌ SANDBOX_DATABASE_URL must be set." >&2
  exit 2
fi

if ! command -v psql &> /dev/null; then
  echo "❌ Required binary 'psql' not found on PATH." >&2
  exit 2
fi

if [[ ! -d "$MIGRATIONS_DIR" ]]; then
  echo "❌ Migrations directory not found: $MIGRATIONS_DIR" >&2
  exit 2
fi

STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
FAILURES=()

echo "=========================================="
echo "🩺 Restored Backup Sanity Check"
echo "=========================================="
echo "Started: $STARTED_AT"

BACKUP_KEY="n/a"
if [[ -n "$RESTORED_BACKUP_INFO" && -f "$RESTORED_BACKUP_INFO" ]]; then
  BACKUP_KEY="$(grep -o '"backupKey":[^,}]*' "$RESTORED_BACKUP_INFO" | sed -E 's/.*"backupKey":\s*"([^"]*)".*/\1/')"
  echo "Drilled backup: $BACKUP_KEY"
fi

# ── 1. Core table row counts ──────────────────────────────────────────────
echo ""
echo "▶ Checking core tables are non-empty..."
IFS=',' read -ra TABLES <<< "$CORE_TABLES"
TABLE_REPORT=()
for table in "${TABLES[@]}"; do
  count="$(psql "$SANDBOX_DATABASE_URL" -tAc "SELECT count(*) FROM \"$table\";" 2>/dev/null | tr -d '[:space:]' || echo "ERROR")"
  if [[ "$count" == "ERROR" ]]; then
    FAILURES+=("core table \"$table\" could not be queried after restore (missing from the dump?)")
    TABLE_REPORT+=("$table=ERROR")
  elif [[ "$count" -eq 0 ]]; then
    FAILURES+=("core table \"$table\" has 0 rows after restore")
    TABLE_REPORT+=("$table=0")
  else
    TABLE_REPORT+=("$table=$count")
  fi
  echo "  $table: $count"
done

# ── 2. Schema version (Prisma migration) match ────────────────────────────
echo ""
echo "▶ Checking restored schema version against checked-out migrations..."
LATEST_REPO_MIGRATION="$(ls -1 "$MIGRATIONS_DIR" | grep -E '^[0-9]{14}_' | sort | tail -1)"
echo "  latest migration in repo:     $LATEST_REPO_MIGRATION"

RESTORED_MIGRATION="$(psql "$SANDBOX_DATABASE_URL" -tAc \
  "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1;" \
  2>/dev/null | tr -d '[:space:]' || echo "")"
echo "  latest migration in restore:  ${RESTORED_MIGRATION:-<none found>}"

if [[ -z "$RESTORED_MIGRATION" ]]; then
  FAILURES+=("could not read _prisma_migrations from the restored database — restore may have failed silently")
elif [[ "$RESTORED_MIGRATION" != "$LATEST_REPO_MIGRATION" ]]; then
  FAILURES+=("schema version mismatch: restored backup is at migration \"$RESTORED_MIGRATION\", repo expects \"$LATEST_REPO_MIGRATION\"")
fi

FINISHED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

# ── 3. Write the summary ──────────────────────────────────────────────────
{
  echo "Restored Backup Sanity Check"
  echo "============================"
  echo "started_at=$STARTED_AT"
  echo "finished_at=$FINISHED_AT"
  echo "backup_key=$BACKUP_KEY"
  echo "latest_repo_migration=$LATEST_REPO_MIGRATION"
  echo "latest_restored_migration=${RESTORED_MIGRATION:-<none>}"
  for entry in "${TABLE_REPORT[@]}"; do
    echo "table_rows=$entry"
  done
  if [[ ${#FAILURES[@]} -eq 0 ]]; then
    echo "result=PASS"
  else
    echo "result=FAIL"
    for failure in "${FAILURES[@]}"; do
      echo "failure=$failure"
    done
  fi
} | tee "$REPORT_PATH"

echo ""
if [[ ${#FAILURES[@]} -gt 0 ]]; then
  echo "=========================================="
  echo "❌ Restored backup sanity check FAILED"
  echo "=========================================="
  for failure in "${FAILURES[@]}"; do
    echo "  - $failure" >&2
  done
  exit 1
fi

echo "=========================================="
echo "✅ Restored backup sanity check PASSED"
echo "=========================================="
