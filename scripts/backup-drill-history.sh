#!/bin/bash
#
# Prints the pass/fail history of the real production backup restore drill
# (the real-restore-drill job in .github/workflows/backup-verification.yml),
# so restore reliability trends are visible over time without needing a
# dashboard or a database of its own — the data already lives in the
# workflow's own run history and artifacts; this just renders it as a table.
#
# Usage:
#   gh auth login   # if not already authenticated
#   ./scripts/backup-drill-history.sh [--limit N]
#
# Requires: gh CLI, jq. Run from anywhere inside the repo (uses `gh` which
# infers the repo from the git remote).

set -euo pipefail

LIMIT="20"
if [[ "${1:-}" == "--limit" && -n "${2:-}" ]]; then
  LIMIT="$2"
fi

if ! command -v gh &> /dev/null; then
  echo "❌ gh CLI not found on PATH." >&2
  exit 2
fi

echo "Fetching the last $LIMIT real-restore-drill runs..."
echo ""
printf "%-12s %-10s %-20s %s\n" "DATE" "RESULT" "BACKUP KEY" "RUN"

RUN_IDS=$(gh run list \
  --workflow backup-verification.yml \
  --event schedule \
  --limit "$LIMIT" \
  --json databaseId,createdAt,conclusion \
  -q '.[] | [.databaseId, .createdAt, .conclusion] | @tsv')

while IFS=$'\t' read -r run_id created_at conclusion; do
  [[ -z "$run_id" ]] && continue

  BACKUP_KEY="n/a"
  TMP_DIR="$(mktemp -d)"
  if gh run download "$run_id" -n backup-real-drill-report -D "$TMP_DIR" &> /dev/null; then
    if [[ -f "$TMP_DIR/backup-drill-restored.json" ]]; then
      BACKUP_KEY="$(jq -r '.backupKey // "n/a"' "$TMP_DIR/backup-drill-restored.json" 2>/dev/null || echo "n/a")"
    fi
  fi
  rm -rf "$TMP_DIR"

  DATE="${created_at%%T*}"
  RESULT="${conclusion:-unknown}"
  printf "%-12s %-10s %-20s run/%s\n" "$DATE" "$RESULT" "$BACKUP_KEY" "$run_id"
done <<< "$RUN_IDS"

echo ""
echo "A 'success' row means the drilled backup restored and passed both"
echo "sanity checks (non-empty core tables, matching schema version)."
echo "See docs/BACKUP_RESTORE_DRILL.md for what a failure means and how to"
echo "triage it."
