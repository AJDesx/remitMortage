#!/usr/bin/env bash
# Runs the cost-allocation tag policy test suite:
#   1. OPA unit tests for the Rego policy (tags_test.rego)
#   2. conftest against checked-in plan fixtures: the compliant plan must pass,
#      the non-compliant plan must fail and name the missing tags.
set -euo pipefail
cd "$(dirname "$0")"

opa test tags.rego tags_test.rego -v

conftest test --policy . --namespace terraform.tags fixtures/compliant-plan.json

if out="$(conftest test --policy . --namespace terraform.tags fixtures/non-compliant-plan.json 2>&1)"; then
  echo "FAIL: non-compliant plan was accepted by the tag policy" >&2
  exit 1
fi
grep -q "missing required cost-allocation tag" <<<"$out" || {
  echo "FAIL: non-compliant plan failed for the wrong reason:" >&2
  echo "$out" >&2
  exit 1
}
echo "tag policy fixtures behave as expected"
