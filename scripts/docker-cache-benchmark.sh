#!/usr/bin/env bash
#
# docker-cache-benchmark.sh — measure how much BuildKit layer caching speeds up
# a rebuild when only source code changed (dependencies unchanged).
#
# Usage: scripts/docker-cache-benchmark.sh <context-dir> <name> <source-file>
#
#   1. cold  : build with an empty cache (fills a local cache directory)
#   2. warm  : touch <source-file> (a code-only change) and rebuild from the cache
#
# Prints one markdown table row and a machine-readable BENCH line:
#   BENCH <name> <cold-seconds> <warm-seconds>
#
# The local cache directory is removed afterwards; it holds image layers and is
# never uploaded or published.

set -euo pipefail

[ $# -eq 3 ] || { echo "usage: $0 <context-dir> <name> <source-file>" >&2; exit 1; }
context="$1" name="$2" source_file="$3"

cache_dir="$(mktemp -d)"
trap 'rm -rf "$cache_dir"; [ -n "${backup:-}" ] && cp "$backup" "$context/$source_file" && rm -f "$backup"' EXIT

build() {
  docker buildx build \
    --cache-from "type=local,src=$cache_dir" \
    --cache-to "type=local,dest=$cache_dir,mode=max" \
    --load -t "bench-$name:latest" "$context" >/dev/null
}

now() { python3 -c 'import time; print(time.time())'; }

t0="$(now)"; build; t1="$(now)"

backup="$(mktemp)"
cp "$context/$source_file" "$backup"
printf '\n// cache-benchmark touch %s\n' "$(date +%s)" >> "$context/$source_file"

t2="$(now)"; build; t3="$(now)"

cold="$(python3 -c "print(round($t1 - $t0, 1))")"
warm="$(python3 -c "print(round($t3 - $t2, 1))")"
saved="$(python3 -c "print(round(100 * (1 - $warm / $cold)))")"

printf '| %s | %ss | %ss | %s%% |\n' "$name" "$cold" "$warm" "$saved"
printf 'BENCH %s %s %s\n' "$name" "$cold" "$warm"
