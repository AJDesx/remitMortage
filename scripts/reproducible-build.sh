#!/usr/bin/env bash
# Reproducible contract build.
#
# Builds every deployable Soroban contract from a clean `git archive` of a
# commit, at a fixed absolute path, with a pinned toolchain (contracts/
# rust-toolchain.toml), `--locked` dependencies, an isolated cargo home and
# target dir, and path remapping. The same commit therefore yields
# byte-identical WASM on any machine.
#
# Usage: scripts/reproducible-build.sh [--commit <ref>] [--out <dir>]
#   --commit  git ref to build (default: HEAD). The working tree is NOT used,
#             so uncommitted changes can never leak into the artifacts.
#   --out     output directory (default: dist/reproducible)
#
# Output: <out>/*.wasm, <out>/SHA256SUMS, <out>/wasm-hashes.json
#
# See docs/REPRODUCIBLE_BUILDS.md.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMMIT_REF="HEAD"
OUT_DIR="$REPO_ROOT/dist/reproducible"

while [ $# -gt 0 ]; do
  case "$1" in
    --commit) COMMIT_REF="${2:?--commit needs a value}"; shift 2 ;;
    --out)    OUT_DIR="${2:?--out needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,19p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# Fixed, user-independent build location: absolute paths can leak into the
# WASM (panic locations, crate metadata), so every build uses the same one.
BUILD_ROOT="${REPRO_BUILD_ROOT:-/tmp/remitmortgage-repro}"
SRC_DIR="$BUILD_ROOT/src"
CARGO_HOME_DIR="$BUILD_ROOT/cargo-home"
TARGET_DIR="$BUILD_ROOT/target"

COMMIT_SHA="$(git -C "$REPO_ROOT" rev-parse --verify "${COMMIT_REF}^{commit}")"
SOURCE_DATE_EPOCH="$(git -C "$REPO_ROOT" show -s --format=%ct "$COMMIT_SHA")"
export SOURCE_DATE_EPOCH

echo "==> Building commit $COMMIT_SHA"

rm -rf "$BUILD_ROOT"
mkdir -p "$SRC_DIR" "$CARGO_HOME_DIR"
git -C "$REPO_ROOT" archive "$COMMIT_SHA" contracts | tar -x -C "$SRC_DIR"

# Ensure the pinned toolchain from contracts/rust-toolchain.toml is installed.
if command -v rustup >/dev/null 2>&1; then
  (cd "$SRC_DIR/contracts" && { rustup show active-toolchain >/dev/null 2>&1 || rustup toolchain install; })
fi

SYSROOT="$(cd "$SRC_DIR/contracts" && rustc --print sysroot)"
RUSTC_VERSION="$(cd "$SRC_DIR/contracts" && rustc --version)"
echo "==> Toolchain: $RUSTC_VERSION"

# Remap every machine-specific absolute path to a stable one.
REMAP="--remap-path-prefix=$SRC_DIR=/build --remap-path-prefix=$CARGO_HOME_DIR=/cargo --remap-path-prefix=$SYSROOT=/rust"

# The isolated CARGO_HOME keeps the build hermetic; RUSTUP_HOME must stay
# pointed at the real toolchain store so the pinned toolchain is still found.
if command -v rustup >/dev/null 2>&1; then
  export RUSTUP_HOME="${RUSTUP_HOME:-$(rustup show home)}"
fi
(
  cd "$SRC_DIR/contracts"
  env \
    CARGO_HOME="$CARGO_HOME_DIR" \
    CARGO_TARGET_DIR="$TARGET_DIR" \
    CARGO_INCREMENTAL=0 \
    RUSTFLAGS="$REMAP" \
    cargo build --locked --release --target wasm32v1-none \
      --workspace --exclude integration-tests --exclude budget-tests
)

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
cp "$TARGET_DIR"/wasm32v1-none/release/*.wasm "$OUT_DIR"/

node "$REPO_ROOT/scripts/wasm-hashes.mjs" generate "$OUT_DIR" \
  --commit "$COMMIT_SHA" \
  --toolchain "$RUSTC_VERSION" \
  --out "$OUT_DIR/wasm-hashes.json" \
  --sums "$OUT_DIR/SHA256SUMS"

echo "==> Done. Artifacts and hashes in $OUT_DIR"
cat "$OUT_DIR/SHA256SUMS"
