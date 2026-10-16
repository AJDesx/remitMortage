# Flaky Test Detection and Quarantine

## Overview

Intermittently failing tests erode trust in CI: people re-run instead of
investigating, and real regressions hide behind noise. This policy records test
outcomes over time, identifies genuinely flaky tests, and lets a flaky test be
**quarantined** (skipped) while a tracking issue is opened automatically — with
a hard expiry so it cannot be forgotten.

## Components

| Piece | Path | Role |
|-------|------|------|
| Detection + quarantine logic | `scripts/flaky-lib.mjs` | Pure functions (detect, match, expire, render). |
| CLI | `scripts/flaky-quarantine.mjs` | `check` / `record` / `detect` / `quarantine` / `release` / `dashboard`. |
| Tests | `scripts/flaky-quarantine.test.mjs` | `node --test` unit + end-to-end coverage. |
| Quarantine registry | `devops/testing/quarantine.json` | The list of quarantined tests. |
| Outcome history | `devops/testing/flaky-history.json` | Append-only per-run test outcomes. |
| Jest skip hook | `backend/test/flakyQuarantine.cjs` | Skips quarantined tests (`setupFilesAfterEnv`). |
| Dashboard | `docs/FLAKY_TEST_DASHBOARD.md` | Generated: quarantines + age + detected flakes. |
| Workflow | `.github/workflows/flaky-test-quarantine.yml` | Gate on PRs; detect + auto-quarantine on schedule. |

## Detecting flaky tests

Each CI run's `jest --json` output is normalized and appended to
`devops/testing/flaky-history.json`. A test is **flaky** when, across recorded
runs, it:

- both **passed and failed** (mixed outcomes), or
- only passed **after a retry**.

A test that fails *every* run is a real breakage, not a flake, and is
deliberately not flagged. Detection needs at least two recorded runs
(`--min-runs`, default 2), so a single CI run never quarantines anything.

```bash
node scripts/flaky-quarantine.mjs record --results jest-results.json --run-id "$GITHUB_RUN_ID"
node scripts/flaky-quarantine.mjs detect --json-out flaky-detected.json
```

## Quarantining a test

A quarantine entry names the test, links a tracking issue, and sets an expiry:

```json
{
  "test": "describe > the flaky case",
  "reason": "Intermittent timeout under CI load",
  "owner": "abimbolaalabi",
  "trackingIssue": 123,
  "quarantinedAt": "2026-10-16",
  "expiresAt": "2026-10-30"
}
```

When `FLAKY_QUARANTINE_ENABLED=true`, the Jest setup in
`backend/test/flakyQuarantine.cjs` wraps `test`/`it` so any test whose name
matches an **active** (non-expired) entry is registered with `.skip`. The hook
is a no-op by default, so local runs and unrelated CI jobs are unaffected.

The scheduled workflow does the full loop automatically: it detects flaky
tests, opens a tracking issue (`[Flaky] <test>`), adds a quarantine entry, and
opens a pull request with the updated registry and dashboard.

## Expiry — the anti-forgetting rule

The default quarantine window is **14 days** (`--days`), and the gate starts
warning **7 days** before expiry. When a quarantine passes its `expiresAt`
without being resolved:

```bash
node scripts/flaky-quarantine.mjs check
# ✗ Quarantine EXPIRED: "..." — fix the test and release it, or renew with justification.
# exit 1 → the build fails
```

The `flaky-test-quarantine` workflow runs this on every pull request, so an
expired quarantine blocks merges until the test is fixed and released
(`release --test <name>`) or the quarantine is explicitly renewed with a new
expiry and a note on the tracking issue.

## Dashboard

`docs/FLAKY_TEST_DASHBOARD.md` is generated and lists:

- every quarantined test with owner, tracking issue, quarantine date, expiry,
  **age in days**, and status (`active` / `expiring` / `expired`);
- every detected flaky test with its pass/fail split, retried passes, fail
  rate, and whether it is quarantined.

The reference date is derived from the recorded data, so the file is
deterministic and CI verifies it is in sync:

```bash
node scripts/flaky-quarantine.mjs dashboard          # regenerate
node scripts/flaky-quarantine.mjs dashboard --check  # fail if stale
```

## Runbook

1. **Alert** — the scheduled workflow opens `[Flaky] <test>` with the pass/fail
   history and quarantines the test (PR).
2. **Triage** — reproduce locally; look for time/order/network dependence,
   shared state, or missing `await`. See the tracking issue.
3. **Fix** — open a PR that fixes the test, then `release --test "<name>"`
   (or delete the entry) and regenerate the dashboard.
4. **Expiring warning** — the gate warns 7 days out. Either land the fix or
   renew: `quarantine --test "<name>" --issue <n> --days 14 --reason "..."`.
5. **Never** let an entry silently expire — that fails the build by design.

## Relationship to coverage thresholds

`docs/TEST_COVERAGE_THRESHOLDS.md` treats a temporarily quarantined suite as a
justified reason to lower a coverage floor. When you do that, link the
tracking issue from step 1 so the floor can be raised again once the quarantine
is released.
