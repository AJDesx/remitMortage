# Axe Accessibility Regression Tests

Every page in the frontend is scanned with [axe-core](https://github.com/dequelabs/axe-core)
in CI, in both the **light** and **dark** themes. A new **serious** or
**critical** violation fails the build, and so does adding a route that has not
been registered for scanning.

Workflow: [`.github/workflows/a11y-axe.yml`](../.github/workflows/a11y-axe.yml)

## How it works

| File (under `frontend/`) | Purpose |
| --- | --- |
| `a11y/config.json` | Severities that fail the build (`critical`, `serious`), axe tags (WCAG 2.0/2.1 A + AA) and the themes to scan |
| `a11y/routes.json` | Registry of every page and the concrete URL to scan; `excluded` holds routes skipped with a written reason |
| `a11y/allowlist.json` | Reviewed, justified exceptions to the gate |
| `a11y/axe-routes.spec.ts` | Playwright spec: one test per route × theme |
| `a11y/lib.ts` | Route discovery, coverage check, allowlist validation, gating, report formatting |
| `playwright.a11y.config.ts` | Playwright config for the suite (Chromium) |
| `__tests__/a11y-route-coverage.test.ts` | Fails when a page under `src/app` is not in `routes.json`, or when the registry/allowlist is invalid |
| `__tests__/a11y-axe-lib.test.ts` | Unit tests for the gating logic |

The spec sets the theme through the `remitmortgage-theme` localStorage key plus
`prefers-color-scheme`, and asserts `<html data-theme>` matches before scanning.
Protected routes get a placeholder `session` cookie (the middleware only checks
that it exists) and a mock Freighter wallet, so scans cover the rendered UI
rather than a login redirect. Pages that need live data are scanned in whatever
state they render offline (loading, empty, error or 404 states).

## Adding a route

1. Create the page under `src/app/...`.
2. Add it to `frontend/a11y/routes.json`:
   ```json
   { "route": "/my-page", "url": "/my-page" }
   ```
   Dynamic routes need a concrete sample URL: `{ "route": "/tx/[hash]", "url": "/tx/000…" }`.
3. If it truly must not be scanned, add it to `excluded` with a reason of at least
   10 characters instead. Reviewers should challenge exclusions.

Skipping this step fails `__tests__/a11y-route-coverage.test.ts` in CI (and in
`npm test`).

## Fixing vs. allowlisting a violation

Fix the violation whenever possible. If an exception is unavoidable (for
example a third-party widget), add an entry to `a11y/allowlist.json`:

```json
{
  "ruleId": "color-contrast",
  "route": "/invest",
  "theme": "dark",
  "selector": ".recharts-legend",
  "justification": "Third-party chart legend colours cannot be changed; tracked in #123.",
  "reviewedBy": "github-handle",
  "reviewedOn": "2026-06-01",
  "expires": "2026-09-01"
}
```

- `ruleId`, `route` (`"*"` for all routes), `justification` (≥ 20 characters),
  `reviewedBy` and `reviewedOn` are required.
- `theme` and `selector` narrow the exception. `selector` is matched as a
  substring against every violating node's target.
- `expires` is strongly recommended; an expired entry stops applying **and**
  fails validation until it is fixed or re-reviewed.
- The CI report lists allowlist entries that no longer match anything so they
  can be removed.

Allowlist changes are code-reviewed like any other change; `.github/CODEOWNERS`
may require accessibility owners for `frontend/a11y/allowlist.json`.

## Reading the report

Each run writes a Markdown report to the **job summary** and uploads the
`axe-accessibility-report` artifact (`report.md`, `results.json`, the Playwright
`html/` report and per-route raw results in `results/`). Each failing row shows
impact, rule, description, node count, the first offending selector and whether
it was allowlisted.

## Running locally

```bash
cd frontend
npm run test:a11y:axe          # starts `npm run dev` automatically
npx jest __tests__/a11y-route-coverage.test.ts __tests__/a11y-axe-lib.test.ts
```

Reports are written to `frontend/a11y-report/` (git-ignored).
