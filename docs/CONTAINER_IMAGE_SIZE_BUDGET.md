# Container Image Size Budget

## Why We Budget Image Size

A larger production image means slower deploys, slower rollbacks, slower
autoscaling (cold-start pulls), and a larger attack surface. Image size
tends to only grow — an extra dependency, a forgotten `COPY . .`, a dev
tool that leaked into the final stage — unless something actively watches
it. This policy makes that growth visible at PR time instead of being
discovered months later in a deploy-time complaint.

**The policy:** `backend/Dockerfile` and `frontend/Dockerfile` each have a
configured maximum size in `scripts/image-size-budgets.json`. A PR that
pushes a built image over its budget fails CI (or warns, during an
explicit grace period — see below), and every PR shows the size delta
against the most recent build on `main` so the impact is visible in review.

---

## How It Works

Workflow: `.github/workflows/container-image-size-budget.yml`
Script: `scripts/check-image-size-budget.mjs`

- **On every push to `main`** that touches a Dockerfile or either app
  directory, the `record-baseline` job builds both images, measures their
  size with `docker image inspect --format='{{.Size}}'`, and uploads the
  result as the `image-size-baseline` artifact (90-day retention) — the
  same baseline-artifact pattern `cost-drift-detection.yml` uses for
  Infracost snapshots.
- **On every PR** that touches the same paths, the `check-budget` job
  builds both images from the PR branch, measures their size the same
  way, downloads the most recent `main` baseline (`gh run download` against
  the latest successful push run), and runs
  `scripts/check-image-size-budget.mjs` to compare:
  - current size vs. **budget** (`maxBytes` in `image-size-budgets.json`) → pass/warn/fail
  - current size vs. **baseline** (previous build on `main`) → delta, for visibility only
- The resulting markdown table is appended to the job's
  `$GITHUB_STEP_SUMMARY`, so it's visible directly on the PR's checks tab
  without opening logs.
- If no baseline is found yet (first run, or the artifact has expired),
  the delta column reports "n/a" rather than failing — budget enforcement
  never depends on the baseline being present.

---

## Budget / Grace Period Semantics

Each entry in `scripts/image-size-budgets.json`:

```json
{
  "backend": {
    "dockerfile": "backend/Dockerfile",
    "context": "backend",
    "maxBytes": 419430400,
    "graceUntil": null
  }
}
```

| Field | Meaning |
|---|---|
| `maxBytes` | The budget. A build at or under this size passes. |
| `graceUntil` | `null`, or a UTC date `"YYYY-MM-DD"`. While set to a future date, an over-budget image **warns** (posts the report, does not fail CI) instead of failing outright. Once that date passes (or the field is `null`), going over budget **fails** CI. |

Use `graceUntil` when you know a size increase is coming (e.g. a planned
dependency upgrade) and want a window to land it without blocking every
other PR — not as a permanent escape hatch. A grace period with no
expiry defeats the point of the budget.

An image with no entry in `image-size-budgets.json` at all is treated as
a hard failure ("UNCONFIGURED") — a new production image must get a
budget before it ships, not after.

---

## How to Fix a Failing Check

1. Open the PR's `Check Image Size Budget` job summary — it shows exactly
   which image is over, by how much, and the delta against the last
   `main` build.
2. **If the increase is unintentional** (most common), shrink the image:
   - Check for a missed `.dockerignore` entry or an accidental `COPY . .`
     pulling in more than intended.
   - Confirm multi-stage `COPY --from=` only copies the specific
     directories needed (see the existing stage comments in
     `backend/Dockerfile` / `frontend/Dockerfile` for the pattern).
   - Check for a new dependency that could be moved to devDependencies,
     or an Alpine package that isn't actually needed at runtime.
3. **If the increase is legitimate**, raise the budget (see below) rather
   than fighting the checker.

## How to Intentionally Raise a Budget

Raising a budget is a reviewed decision, not a workaround — the PR diff
makes the change explicit:

1. Confirm the new size is the smallest reasonably achievable (see step 2
   above) before raising the ceiling to match it, not above it.
2. Edit `scripts/image-size-budgets.json`, bumping `maxBytes` for the
   affected image. Pick a value with a small amount of headroom above the
   new measured size, not an arbitrary round number.
3. If you need to land the change before the budget bump can be reviewed
   on its own (e.g. an urgent dependency bump), set `graceUntil` to a near
   date instead of silently committing an oversized image — this keeps CI
   green while making the overage visible in every report until the real
   budget bump lands.
4. Open the PR with both the Dockerfile/dependency change and the budget
   change together, so the reviewer sees cause and effect in one diff.

## Running the Check Locally

The script itself takes pre-measured sizes (it never shells out to
Docker), so measure locally first:

```bash
docker build -t remitmortgage-backend:local ./backend
docker build -t remitmortgage-frontend:local ./frontend

jq -n \
  --argjson backend "$(docker image inspect remitmortgage-backend:local --format='{{.Size}}')" \
  --argjson frontend "$(docker image inspect remitmortgage-frontend:local --format='{{.Size}}')" \
  '{backend: $backend, frontend: $frontend}' > /tmp/image-sizes.json

node scripts/check-image-size-budget.mjs /tmp/image-sizes.json
```

Run the script's own unit tests with:

```bash
node --test scripts/check-image-size-budget.test.mjs
```
