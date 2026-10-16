#!/usr/bin/env bash
# Verify a deployed Soroban contract against its source commit.
#
# Rebuilds the contract reproducibly from <commit> (scripts/reproducible-build.sh)
# and compares its sha256 with the code hash of the deployed contract.
#
# Usage:
#   scripts/verify-deployed-contract.sh --contract <name> --commit <sha> \
#       (--contract-id <C...> --network <net> | --wasm-hash <sha256>) \
#       [--manifest <wasm-hashes.json>]
#
#   --contract     package name, e.g. escrow, lending-pool
#   --commit       full commit SHA the deployment is claimed to come from
#   --contract-id  deployed contract id; its WASM is fetched with the Stellar CLI
#   --network      stellar network name (testnet, mainnet, ...)
#   --wasm-hash    on-chain WASM hash (hex) instead of fetching by contract id
#   --manifest     published release wasm-hashes.json; also cross-checked
#
# Exit codes: 0 verified, 1 mismatch, 2 usage/tooling error.
# See docs/REPRODUCIBLE_BUILDS.md.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACT="" COMMIT="" CONTRACT_ID="" NETWORK="" WASM_HASH="" MANIFEST=""

while [ $# -gt 0 ]; do
  case "$1" in
    --contract)    CONTRACT="${2:-}"; shift 2 ;;
    --commit)      COMMIT="${2:-}"; shift 2 ;;
    --contract-id) CONTRACT_ID="${2:-}"; shift 2 ;;
    --network)     NETWORK="${2:-}"; shift 2 ;;
    --wasm-hash)   WASM_HASH="${2:-}"; shift 2 ;;
    --manifest)    MANIFEST="${2:-}"; shift 2 ;;
    -h|--help)     sed -n '2,22p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$CONTRACT" ] || [ -z "$COMMIT" ]; then
  echo "--contract and --commit are required (see --help)." >&2; exit 2
fi
if [ -z "$WASM_HASH" ] && { [ -z "$CONTRACT_ID" ] || [ -z "$NETWORK" ]; }; then
  echo "Provide --wasm-hash, or both --contract-id and --network." >&2; exit 2
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# 1. Deployed code hash.
if [ -z "$WASM_HASH" ]; then
  command -v stellar >/dev/null 2>&1 || { echo "Stellar CLI not found; install it or pass --wasm-hash." >&2; exit 2; }
  stellar contract fetch --id "$CONTRACT_ID" --network "$NETWORK" --out-file "$WORK_DIR/deployed.wasm"
  WASM_HASH="$(sha256sum "$WORK_DIR/deployed.wasm" | cut -d' ' -f1)"
fi
WASM_HASH="$(echo "$WASM_HASH" | tr 'A-F' 'a-f')"

# 2. Local reproducible rebuild.
"$REPO_ROOT/scripts/reproducible-build.sh" --commit "$COMMIT" --out "$WORK_DIR/build" >/dev/null
BUILT_COMMIT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).commit)' "$WORK_DIR/build/wasm-hashes.json")"
LOCAL_HASH="$(node "$REPO_ROOT/scripts/wasm-hashes.mjs" lookup "$WORK_DIR/build/wasm-hashes.json" "$CONTRACT")"

echo "Contract:        $CONTRACT"
echo "Source commit:   $BUILT_COMMIT"
echo "Rebuilt hash:    $LOCAL_HASH"
echo "Deployed hash:   $WASM_HASH"

STATUS=0

# 3. Optional cross-check against the published release manifest.
if [ -n "$MANIFEST" ]; then
  PUBLISHED_HASH="$(node "$REPO_ROOT/scripts/wasm-hashes.mjs" lookup "$MANIFEST" "$CONTRACT")"
  echo "Published hash:  $PUBLISHED_HASH"
  if [ "$PUBLISHED_HASH" != "$LOCAL_HASH" ]; then
    echo "MISMATCH: local rebuild differs from the published release manifest." >&2
    STATUS=1
  fi
fi

if [ "$LOCAL_HASH" != "$WASM_HASH" ]; then
  echo "MISMATCH: deployed contract does NOT match a reproducible build of $BUILT_COMMIT." >&2
  STATUS=1
fi

if [ "$STATUS" -eq 0 ]; then
  echo "VERIFIED: deployed code matches source commit $BUILT_COMMIT."
fi
exit "$STATUS"
