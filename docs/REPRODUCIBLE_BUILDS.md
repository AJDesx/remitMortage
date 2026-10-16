# Reproducible Contract Builds

Auditors and users should not have to trust that the WASM deployed on-chain
corresponds to the reviewed source. Every contract in `contracts/` is built so
that **the same commit produces byte-identical WASM**, CI enforces it, and
anyone can check a deployed contract against its source commit.

## What makes the build reproducible

| Input | How it is pinned |
| --- | --- |
| Rust toolchain | [`contracts/rust-toolchain.toml`](../contracts/rust-toolchain.toml) (exact version, `wasm32v1-none` target) |
| Dependencies | `cargo build --locked` against the committed `contracts/Cargo.lock` |
| Source | `git archive <commit>` — only committed files, never the working tree |
| Build path | always `/tmp/remitmortgage-repro/src`, so absolute paths cannot differ |
| Machine-specific paths | `--remap-path-prefix` for the source dir, cargo home and rust sysroot |
| Cargo state | fresh `CARGO_HOME` and `CARGO_TARGET_DIR`, `CARGO_INCREMENTAL=0` |
| Profile | `[profile.release]` in `contracts/Cargo.toml` (`opt-level="z"`, `lto`, `codegen-units=1`, `strip="symbols"`) |

Changing the toolchain version changes every hash. Bump it deliberately and
note it in the release.

## Build command

```bash
scripts/reproducible-build.sh --commit <full-sha> --out dist/reproducible
```

It wraps this exact cargo invocation (run inside the archived `contracts/`):

```bash
CARGO_HOME=/tmp/remitmortgage-repro/cargo-home \
CARGO_TARGET_DIR=/tmp/remitmortgage-repro/target \
CARGO_INCREMENTAL=0 \
RUSTFLAGS="--remap-path-prefix=/tmp/remitmortgage-repro/src=/build \
           --remap-path-prefix=/tmp/remitmortgage-repro/cargo-home=/cargo \
           --remap-path-prefix=<rust-sysroot>=/rust" \
cargo build --locked --release --target wasm32v1-none \
  --workspace --exclude integration-tests --exclude budget-tests
```

Output in `--out`: the `*.wasm` files, `SHA256SUMS` and `wasm-hashes.json`
(`{ version, commit, toolchain, contracts: { name: { file, sha256, bytes } } }`).

The hashed artifact is the raw `cargo build` output. It is **not** passed
through `stellar contract optimize`/`wasm-opt`; deploy these exact files if you
want a deployment to be verifiable. (`scripts/build.sh` is the developer
convenience build and is not covered by this guarantee.)

## CI enforcement

[`.github/workflows/reproducible-build.yml`](../.github/workflows/reproducible-build.yml)
builds the commit twice on two separate fresh runners (`build` matrix `a`/`b`),
then the `compare` job fails if any hash differs, a contract is missing from
one side, or the files are not byte-identical (`cmp`). Both builds are kept as
artifacts for 30 days so a mismatch can be diffed.

## Published hashes

When a `v*` tag is pushed and the two builds agree, the `publish-hashes` job
attaches `wasm-hashes-<tag>.json` and `SHA256SUMS-<tag>.txt` to the GitHub
Release. Each file records the full commit SHA next to every contract hash.

## Verifying a deployed contract (external reviewers)

Prerequisites: `git`, `rustup`, `node` ≥ 18, and the
[Stellar CLI](https://developers.stellar.org/docs/tools/cli).

1. Check out the repository and find the release commit from the release's
   `wasm-hashes-<tag>.json` (`commit` field).
2. Run:

   ```bash
   scripts/verify-deployed-contract.sh \
     --contract escrow \
     --commit <full-sha> \
     --contract-id <C...deployed contract id> \
     --network testnet \
     --manifest wasm-hashes-<tag>.json     # optional cross-check
   ```

   The script rebuilds from the commit, downloads the deployed WASM with
   `stellar contract fetch`, and compares SHA-256 hashes. If you already know
   the on-chain WASM hash, pass `--wasm-hash <hex>` instead of
   `--contract-id`/`--network`.
3. Exit code `0` and `VERIFIED` means the deployed code is exactly what the
   commit builds. `1` means a mismatch (deployed code, release manifest or
   commit disagree); `2` is a usage or tooling error.

## Troubleshooting a mismatch

- Confirm `--commit` is the **full** SHA that was actually released.
- Confirm the same `rustc --version` appears in the manifest's `toolchain` field.
- Re-run on a clean machine; the script already ignores uncommitted changes.
- Compare the CI artifacts `repro-build-a` / `repro-build-b` with `cmp` or
  `wasm-tools print` to find the differing section.

## Tests

The manifest/compare tooling is covered by:

```bash
node --test scripts/wasm-hashes.test.mjs
```
