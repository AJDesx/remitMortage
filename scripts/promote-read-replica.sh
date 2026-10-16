#!/bin/bash
#
# Automates the multi-region read-replica promotion runbook: connection
# string cutover, replica promotion, and application config update, as a
# single pipeline instead of manual step-by-step commands.
#
# Modes:
#   --dry-run   Validates preconditions (replica lag, replica health, RDS
#               instance status) and prints what WOULD happen. Never calls
#               a mutating AWS API. Exits non-zero if any precondition fails.
#   (default)   Requires --yes in addition — the blast radius of promoting a
#               replica to primary (every write after this point targets the
#               new instance; the old primary is not automatically demoted)
#               means this never runs without an explicit, separate
#               confirmation flag. Re-validates every precondition before
#               doing anything, then: promotes the replica, cuts over the
#               DATABASE_URL secret to its new endpoint, and forces a new
#               application deployment so the cutover actually takes effect.
#
# Usage:
#   ./scripts/promote-read-replica.sh --dry-run
#   ./scripts/promote-read-replica.sh --yes
#
# Environment:
#   REPLICA_DB_INSTANCE_ID         RDS identifier of the replica to promote.
#   REPLICA_DATABASE_URL           psql connection string to the replica, for
#                                  the lag/health precondition checks.
#   DATABASE_SECRET_ARN            Secrets Manager secret ARN holding the
#                                  application's DATABASE_URL.
#   PROMOTED_DATABASE_URL_TEMPLATE Connection string template with the
#                                  literal placeholder __ENDPOINT__, e.g.
#                                  "postgres://user:pass@__ENDPOINT__/db".
#                                  Required only for a real promotion.
#   APP_RUNNER_SERVICE_ARN         App Runner service ARN to redeploy after
#                                  cutover, so it picks up the new secret.
#   DB_REPLICA_LAG_THRESHOLD_SECONDS
#                                  Max acceptable replica lag, in seconds.
#                                  Default 30 — mirrors the application's own
#                                  backend/src/services/dbPoolConfig.ts default.
#   PROMOTION_TIMEOUT_SECONDS      Max time to wait for the promoted instance
#                                  to report "available". Default 900 (15m).
#   REPORT_PATH                    Optional path for the machine-readable summary.

set -euo pipefail

log() { echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] [REPLICA-PROMOTION] $*"; }

DRY_RUN="false"
CONFIRMED="false"
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN="true" ;;
    --yes) CONFIRMED="true" ;;
    *)
      echo "❌ Unknown argument: $arg (expected --dry-run and/or --yes)" >&2
      exit 2
      ;;
  esac
done

REPLICA_DB_INSTANCE_ID="${REPLICA_DB_INSTANCE_ID:-}"
REPLICA_DATABASE_URL="${REPLICA_DATABASE_URL:-}"
DATABASE_SECRET_ARN="${DATABASE_SECRET_ARN:-}"
PROMOTED_DATABASE_URL_TEMPLATE="${PROMOTED_DATABASE_URL_TEMPLATE:-}"
APP_RUNNER_SERVICE_ARN="${APP_RUNNER_SERVICE_ARN:-}"
LAG_THRESHOLD_SECONDS="${DB_REPLICA_LAG_THRESHOLD_SECONDS:-30}"
PROMOTION_TIMEOUT_SECONDS="${PROMOTION_TIMEOUT_SECONDS:-900}"
REPORT_PATH="${REPORT_PATH:-replica-promotion-report.txt}"

if [[ -z "$REPLICA_DB_INSTANCE_ID" || -z "$REPLICA_DATABASE_URL" ]]; then
  echo "❌ REPLICA_DB_INSTANCE_ID and REPLICA_DATABASE_URL must both be set." >&2
  exit 2
fi

for binary in aws psql; do
  if ! command -v "$binary" &> /dev/null; then
    echo "❌ Required binary '$binary' not found on PATH." >&2
    exit 2
  fi
done

STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
FAILURES=()

log "Mode: $([ "$DRY_RUN" == "true" ] && echo "DRY RUN (validate only)" || echo "REAL PROMOTION")"
log "Target replica: $REPLICA_DB_INSTANCE_ID"

# ── Precondition 1: replica is actually a replica, and reachable ─────────
log "Checking replica health..."
IN_RECOVERY="$(psql "$REPLICA_DATABASE_URL" -tAc "SELECT pg_is_in_recovery();" 2>/dev/null | tr -d '[:space:]' || echo "ERROR")"
if [[ "$IN_RECOVERY" == "ERROR" ]]; then
  FAILURES+=("could not connect to replica at REPLICA_DATABASE_URL")
elif [[ "$IN_RECOVERY" != "t" ]]; then
  FAILURES+=("target is not currently a replica (pg_is_in_recovery() = $IN_RECOVERY) — may already be promoted")
else
  log "  replica is healthy and in recovery mode (confirmed standby)"
fi

# ── Precondition 2: replication lag within bounds ─────────────────────────
log "Checking replication lag (threshold: ${LAG_THRESHOLD_SECONDS}s)..."
LAG_SECONDS="ERROR"
if [[ "$IN_RECOVERY" == "t" ]]; then
  LAG_SECONDS="$(psql "$REPLICA_DATABASE_URL" -tAc \
    "SELECT COALESCE(EXTRACT(EPOCH FROM (NOW() - pg_last_xact_replay_timestamp()))::int, 0);" \
    2>/dev/null | tr -d '[:space:]' || echo "ERROR")"
fi
if [[ "$LAG_SECONDS" == "ERROR" ]]; then
  FAILURES+=("could not read replication lag from replica")
elif [[ "$LAG_SECONDS" -gt "$LAG_THRESHOLD_SECONDS" ]]; then
  FAILURES+=("replica lag ${LAG_SECONDS}s exceeds threshold ${LAG_THRESHOLD_SECONDS}s — promoting now would lose up to ${LAG_SECONDS}s of writes")
else
  log "  lag=${LAG_SECONDS}s, within threshold"
fi

# ── Precondition 3: RDS reports the instance as available ─────────────────
log "Checking RDS instance status..."
RDS_STATUS="$(aws rds describe-db-instances \
  --db-instance-identifier "$REPLICA_DB_INSTANCE_ID" \
  --query 'DBInstances[0].DBInstanceStatus' --output text 2>/dev/null || echo "ERROR")"
if [[ "$RDS_STATUS" != "available" ]]; then
  FAILURES+=("RDS instance status is \"$RDS_STATUS\", expected \"available\"")
else
  log "  RDS instance status: available"
fi

# ── Report preconditions ──────────────────────────────────────────────────
{
  echo "Read Replica Promotion"
  echo "======================="
  echo "started_at=$STARTED_AT"
  echo "mode=$([ "$DRY_RUN" == "true" ] && echo dry-run || echo real)"
  echo "replica_instance_id=$REPLICA_DB_INSTANCE_ID"
  echo "replica_lag_seconds=$LAG_SECONDS"
  echo "replica_in_recovery=$IN_RECOVERY"
  echo "rds_status=$RDS_STATUS"
  if [[ ${#FAILURES[@]} -eq 0 ]]; then
    echo "preconditions=PASS"
  else
    echo "preconditions=FAIL"
    for failure in "${FAILURES[@]}"; do
      echo "failure=$failure"
    done
  fi
} | tee "$REPORT_PATH"

if [[ ${#FAILURES[@]} -gt 0 ]]; then
  echo ""
  echo "❌ Preconditions failed — refusing to proceed." >&2
  for failure in "${FAILURES[@]}"; do
    echo "  - $failure" >&2
  done
  exit 1
fi

if [[ "$DRY_RUN" == "true" ]]; then
  echo ""
  log "✅ Dry run complete — all preconditions pass. No changes were made."
  exit 0
fi

# ── Real promotion from here on ───────────────────────────────────────────
if [[ "$CONFIRMED" != "true" ]]; then
  echo "" >&2
  echo "❌ Refusing to promote without explicit confirmation." >&2
  echo "   Preconditions pass. Re-run with --yes to actually promote $REPLICA_DB_INSTANCE_ID." >&2
  exit 3
fi

if [[ -z "$PROMOTED_DATABASE_URL_TEMPLATE" || -z "$DATABASE_SECRET_ARN" || -z "$APP_RUNNER_SERVICE_ARN" ]]; then
  echo "❌ PROMOTED_DATABASE_URL_TEMPLATE, DATABASE_SECRET_ARN and APP_RUNNER_SERVICE_ARN must all be set for a real promotion." >&2
  exit 2
fi

log "Promoting $REPLICA_DB_INSTANCE_ID to standalone primary..."
aws rds promote-read-replica --db-instance-identifier "$REPLICA_DB_INSTANCE_ID" > /dev/null

log "Waiting for the promoted instance to become available (timeout ${PROMOTION_TIMEOUT_SECONDS}s)..."
DEADLINE=$(( $(date +%s) + PROMOTION_TIMEOUT_SECONDS ))
while true; do
  STATUS="$(aws rds describe-db-instances \
    --db-instance-identifier "$REPLICA_DB_INSTANCE_ID" \
    --query 'DBInstances[0].DBInstanceStatus' --output text)"
  if [[ "$STATUS" == "available" ]]; then
    break
  fi
  if [[ "$(date +%s)" -ge "$DEADLINE" ]]; then
    echo "❌ Timed out waiting for promotion; last status was \"$STATUS\"." >&2
    exit 1
  fi
  log "  status=$STATUS, waiting..."
  sleep 15
done
log "  promoted instance is available"

NEW_ENDPOINT="$(aws rds describe-db-instances \
  --db-instance-identifier "$REPLICA_DB_INSTANCE_ID" \
  --query 'DBInstances[0].Endpoint.Address' --output text)"
log "New primary endpoint: $NEW_ENDPOINT"

log "Cutting over DATABASE_URL secret to the new endpoint..."
NEW_DATABASE_URL="${PROMOTED_DATABASE_URL_TEMPLATE//__ENDPOINT__/$NEW_ENDPOINT}"
aws secretsmanager put-secret-value \
  --secret-id "$DATABASE_SECRET_ARN" \
  --secret-string "$NEW_DATABASE_URL" > /dev/null
log "  secret updated"

log "Forcing a new application deployment to pick up the updated secret..."
aws apprunner start-deployment --service-arn "$APP_RUNNER_SERVICE_ARN" > /dev/null
log "  deployment triggered"

FINISHED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
{
  echo "finished_at=$FINISHED_AT"
  echo "new_endpoint=$NEW_ENDPOINT"
  echo "result=PROMOTED"
} | tee -a "$REPORT_PATH"

echo ""
log "✅ Promotion complete. $REPLICA_DB_INSTANCE_ID is now the primary (endpoint: $NEW_ENDPOINT)."
log "   The old primary was NOT demoted or stopped — decommission it separately once traffic is confirmed healthy on the new primary."
