# Workflow Permissions Audit

## Why This Exists

The `GITHUB_TOKEN` injected into every Actions run defaults to broad
read/write permissions across the whole repository unless a workflow
explicitly declares otherwise. A workflow that never touches issues, PRs,
packages, or the Security tab still carries a token that *could* write to
all of them — so a compromised action (a malicious third-party `uses:`, a
supply-chain-poisoned dependency invoked from a `run:` step, …) inherits
that same broad write access.

**The policy:** every workflow must declare least-privilege permissions —
either a top-level `permissions:` block that covers every job, or an
explicit `permissions:` block on every individual job — scoped to only
what that job's steps actually use. `contents: read` is the floor for
anything that checks out the repo; nothing is granted write access unless
a step in that job demonstrably needs it.

---

## CI Enforcement

`scripts/check-workflow-permissions.mjs` scans every file in
`.github/workflows/` and reports two classes of finding:

- **ERROR** (fails CI) — a workflow has no top-level `permissions:` block
  *and* at least one of its jobs has no job-level `permissions:` block
  either, so that job runs with the default (broad) token.
- **WARNING** (reported, does not fail CI) — a job is granted a write
  scope (`contents`, `packages`, `issues`, `pull-requests`, `id-token`,
  `security-events`, …) but no step in that job matches a known usage
  pattern for it. This is a heuristic text scan, not a full YAML/semantic
  analysis — a WARNING asks a human to double-check the grant is still
  needed, it is not proof the grant is wrong.

Run it locally from the repo root:

```bash
node scripts/check-workflow-permissions.mjs
```

---

## Audit Results (this pass)

31 workflow files were scanned.

**27 files had no explicit permissions anywhere** (no top-level block, and
at least one job with no job-level block), so their jobs ran with the
default broad token. Of those, **2 were false positives** on a naive
"has a top-level `permissions:` block?" check — `codeql.yml` and
`multi-region-chaos.yml` already declare an explicit `permissions:` block
on *every one* of their jobs, just with no (redundant) top-level block —
so the scanner treats a job-level block as equally compliant and does not
flag them. The remaining **25 files were fixed** in this pass:

### Fixed with a plain `contents: read` default

No job in these files writes anything — every step is a checkout, a
build, a test run, or an artifact upload (read-only against the GitHub
API). A single top-level block covers them:

`backup-verification.yml`, `blue-green-deploy.yml`, `checks.yml`, `ci.yml`,
`contracts.yml`, `dr-drill.yml`, `e2e-milestone-disbursement.yml`,
`e2e-onboarding.yml`, `gitleaks.yml`, `license-header.yml`,
`migration-rollback.yml`, `mutation-tests.yml`, `perf-test.yml`,
`prisma-drift.yml`, `staging-load-test.yml`, `terraform-backend-check.yml`,
`terraform-pinning.yml`, `tls-cert-expiry.yml`, `visual-regression.yml`,
`webhook-burst-load.yml`.

### Fixed with a scoped write grant

| Workflow | Scope granted | Why |
|---|---|---|
| `base-image-update.yml` | `contents: write`, `pull-requests: write` | Opens an automated PR via `peter-evans/create-pull-request` with updated base-image digests. |
| `sbom.yml` | `contents: write` | Attaches generated SBOM files to a GitHub Release via `softprops/action-gh-release`. |
| `pentest-schedule-reminder.yml` | `issues: write` | Opens the quarterly pentest-scheduling tracking issue via `actions/github-script`. |
| `security-checks.yml` (workflow default `contents: read`; `trivy-backend-scan` / `trivy-frontend-scan` jobs only) | `security-events: write`, `actions: read` | Only the two Trivy jobs upload SARIF to the Security tab (`github/codeql-action/upload-sarif`); the other 8 jobs in this file (npm pinning, license compliance, Snyk scans, IDOR/redirect coverage, SRI check) stay at `contents: read`. |
| `terraform-drift-detection.yml` (workflow default `contents: read`; `drift-main` / `drift-multiregion` jobs only) | `issues: write` | Only these two jobs open a GitHub issue on detected drift; the `summary` job just reads prior job outputs and stays at `contents: read`. |

### Already compliant, no change needed

`codeql.yml`, `multi-region-chaos.yml` — every job already declares its
own least-privilege `permissions:` block (see above).

`container-signing.yml`, `cost-drift-detection.yml`,
`dependabot-auto-merge.yml`, `infracost.yml`,
`pentest-findings-dashboard.yml`, `preview-env-teardown.yml`,
`release.yml`, `stale-preview-sweep.yml` — each already carries a
top-level `permissions:` block scoped to what its job(s) actually use
(verified against the usage heuristic above: `id-token`+`packages` for
cosign/ECR in `container-signing.yml`; `issues: write` for the
`github-script` issue-create in `cost-drift-detection.yml`; `gh pr
review`/`gh pr merge` in `dependabot-auto-merge.yml`; `infracost comment
github` in `infracost.yml`; `issues.create`/`issues.update` in
`pentest-findings-dashboard.yml`; the PR-comment `github-script` steps in
`preview-env-teardown.yml` and `stale-preview-sweep.yml`; `git commit`/
`git push` for the changelog bump in `release.yml`).

No WARNING-class findings (a granted write scope with no matching usage
step) survived in the final state of the 31 files — every write grant in
the repository today maps to a concrete step that uses it.

---

## How to Fix a Failing Check

1. Run `node scripts/check-workflow-permissions.mjs` to see exactly which
   file/job is missing a block.
2. Add a `permissions:` block:
   - **Top-level**, right after the `on:` block, if every job in the file
     needs the same scopes (or just `contents: read`).
   - **Job-level**, nested under the specific job, if only some jobs in a
     multi-job file need elevated scopes — see `security-checks.yml` or
     `terraform-drift-detection.yml` for the pattern (a top-level
     `contents: read` default, with the one or two jobs that write
     somewhere opting into exactly the scope they use).
3. Grant the narrowest scope that the job's steps actually need — start
   from `contents: read` and add exactly one write scope per capability
   the steps use (see the table above for the mapping from action/call to
   scope).
4. Re-run the check locally before pushing.

## How to Raise a Warning-Class Grant

If the scanner warns that a write scope has no matching usage step,
either:
- **Remove the grant** if the step that used to need it was deleted, or
- **Add a usage pattern** to `SCOPE_USAGE_PATTERNS` in
  `scripts/check-workflow-permissions.mjs` if the step is there but uses
  a tool/call the heuristic doesn't recognize yet (e.g. a new CLI that
  wraps the GitHub API), so the next audit doesn't re-flag a legitimate
  grant.

The heuristic is intentionally a text scan, not a full semantic analyzer —
treat a WARNING as "please confirm," not "this is definitely wrong."
