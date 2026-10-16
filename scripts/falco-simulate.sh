#!/usr/bin/env bash
# Copyright (c) 2026 RemitMortgage Protocol Contributors
# SPDX-License-Identifier: MIT
#
# Trigger each custom Falco rule in a STAGING pod and confirm Falco logged it.
# Usage: scripts/falco-simulate.sh [namespace] [deployment]
# See docs/FALCO_RUNTIME_DETECTION.md.
set -euo pipefail

NS="${1:-remitmortgage}"
DEPLOY="${2:-remitmortgage-backend}"
CTX="$(kubectl config current-context)"
if [[ "$CTX" != *staging* ]]; then
  echo "refusing to simulate: current context '$CTX' is not a staging context" >&2
  exit 2
fi

POD="$(kubectl -n "$NS" get pod -l "app=$DEPLOY" -o jsonpath='{.items[0].metadata.name}')"
SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "== 1. interactive shell =="
kubectl -n "$NS" exec -it "$POD" -- sh -c 'exit 0' || true

echo "== 2. sensitive file read =="
kubectl -n "$NS" exec "$POD" -- sh -c 'cat /etc/shadow >/dev/null 2>&1 || true'

echo "== 3. unexpected outbound connection (public IP, port 4444) =="
kubectl -n "$NS" exec "$POD" -- sh -c 'timeout 3 sh -c "echo > /dev/tcp/198.51.100.7/4444" 2>/dev/null || true'

sleep 5
LOGS="$(kubectl -n falco logs -l app.kubernetes.io/name=falco --since-time="$SINCE" --tail=-1 2>/dev/null || true)"
status=0
for rule in \
  "Shell Spawned in RemitMortgage Production Container" \
  "Sensitive File Read in RemitMortgage Container" \
  "Unexpected Outbound Connection from RemitMortgage Container"; do
  if grep -q "$rule" <<<"$LOGS"; then
    echo "DETECTED: $rule"
  else
    echo "MISSING:  $rule" >&2
    status=1
  fi
done
exit $status
