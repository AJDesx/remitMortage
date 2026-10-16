#!/usr/bin/env bash
# Copyright (c) 2026 RemitMortgage Protocol Contributors
# SPDX-License-Identifier: MIT
#
# Drain a node in the STAGING cluster and assert that every PodDisruptionBudget
# keeps its minimum number of ready replicas for the whole drain.
#
# Usage: scripts/pdb-drain-test.sh <node-name> [namespace]
# Exits non-zero if any app dips below its PDB's currentHealthy floor.
# See docs/POD_DISRUPTION_BUDGETS.md.
set -euo pipefail

NODE="${1:?usage: $0 <node-name> [namespace]}"
NS="${2:-remitmortgage}"
CTX="$(kubectl config current-context)"
if [[ "$CTX" != *staging* ]]; then
  echo "refusing to drain: current context '$CTX' is not a staging context" >&2
  exit 2
fi

violations=0
snapshot() {
  # name desiredHealthy currentHealthy
  kubectl -n "$NS" get pdb -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.desiredHealthy}{" "}{.status.currentHealthy}{"\n"}{end}'
}

echo "== before drain (node $NODE) =="
kubectl -n "$NS" get pods -o wide
snapshot

kubectl cordon "$NODE"
kubectl drain "$NODE" --ignore-daemonsets --delete-emptydir-data --timeout=300s &
DRAIN_PID=$!

while kill -0 "$DRAIN_PID" 2>/dev/null; do
  while read -r name desired current; do
    [[ -z "${name:-}" ]] && continue
    if (( current < desired )); then
      echo "VIOLATION: pdb/$name has $current healthy, needs $desired" >&2
      violations=$((violations + 1))
    fi
  done < <(snapshot)
  sleep 2
done
wait "$DRAIN_PID" || echo "drain exited non-zero (evictions blocked by a PDB are retried and expected)"

echo "== after drain =="
kubectl -n "$NS" get pods -o wide
snapshot
kubectl uncordon "$NODE"

if (( violations > 0 )); then
  echo "FAIL: $violations PDB violations during drain" >&2
  exit 1
fi
echo "PASS: no PDB went below its minimum available replicas"
