# API Versioning Policy

> Issue #847. Breaking changes used to ship without notice — integrators
> found out when their integration broke. This is a header-based versioning
> convention plus the deprecation mechanism and process going forward.

## Convention: header-based, not path-based

This API is versioned by an `Api-Version` header, **not** a `/api/v1/...`
URL prefix. Every existing endpoint today is implicitly version `1`
(`CURRENT_API_VERSION` in `backend/src/middleware/apiVersioning.ts`).

- A client **may** send `Api-Version: <n>` to declare what it was built
  against.
- The server **always** echoes the version it actually served back as an
  `Api-Version` response header (set in
  `backend/src/middleware/metricsMiddleware.ts`, right next to where request
  metrics are recorded).
- Introducing a `/api/v1/` path prefix retroactively would itself be a
  breaking change — the exact thing this policy exists to prevent — so path
  versioning is deliberately not adopted for the existing surface. If a
  genuinely incompatible v2 of a specific resource is ever needed, give
  *that* new resource its own path (e.g. `/api/loan-v2/...`) rather than
  renaming the whole API.

## Deprecating an endpoint

Apply the `deprecated()` middleware from `apiVersioning.ts` to the specific
route, giving the method and full mounted path explicitly (so it's
registered — and visible — at startup, not only after the route is first
hit):

```ts
import { deprecated } from "../middleware/apiVersioning.js";

router.get(
  "/old-report",
  deprecated("GET", "/api/old-report", {
    deprecatedOn: "2026-10-15",
    sunsetOn: "2027-01-15",
    successorPath: "/api/new-report",
    note: "Use /api/new-report instead — same fields, paginated.",
  }),
  handler
);
```

This sets, on every response from that route:

| Header | Meaning |
|---|---|
| `Deprecation` | HTTP-date the endpoint was marked deprecated |
| `Sunset` | HTTP-date it will stop working (RFC 8594) |
| `Link: <path>; rel="successor-version"` | Where to migrate to, when a successor exists |
| `X-Deprecation-Notice` | Free-text migration note, for humans reading logs/responses |

No endpoint in this codebase is deprecated as of this policy's introduction
— there is nothing yet superseded enough to warrant it. Don't mark a route
deprecated just to demonstrate the mechanism; wait until there's a real
successor.

## Minimum notice period

- **Minimum 60 days** between `deprecatedOn` and `sunsetOn` for any endpoint
  with known external integrators.
- **Minimum 30 days** for internal-only (admin/dashboard) endpoints.
- The endpoint must keep working, unchanged, for its entire deprecation
  window — deprecation headers are a warning, not a behavior change.

## Changelog policy for breaking changes

This repo's changelog (`CHANGELOG.md`) is generated from [Conventional
Commits](https://www.conventionalcommits.org/) via
`scripts/generate-release-notes.sh` / `.github/changelog-config.cjs`. The
underlying commit parser already recognizes a `BREAKING CHANGE:` (or
`BREAKING-CHANGE:`) footer and lists it in its own section — no tooling
change was needed for this, only this policy requiring it be used:

- **Every commit that removes, renames, or changes the behavior of a public
  endpoint, or shortens a previously-promised deprecation window, MUST
  include a `BREAKING CHANGE:` footer** describing exactly what changed and
  what callers must do, e.g.:

  ```
  feat(loan): remove the legacy /api/loan/summary endpoint

  BREAKING CHANGE: /api/loan/summary (deprecated since 2026-10-15, sunset
  2027-01-15) has been removed. Use GET /api/loan/:id instead — it returns
  the same fields plus history.
  ```

- A PR that deprecates an endpoint (adds `deprecated()`) is **not** a
  breaking change by itself (behavior is unchanged) and doesn't need the
  footer — only the eventual removal does.
- Release notes generated for a tag will then surface every breaking change
  in its own section automatically, ahead of the regular Features/Fixes
  groups, so it's the first thing a reader of the release notes sees.

## Visibility: per-version usage and deprecated endpoints

- `remitmortgage_http_requests_by_version_total{version,method,route}`
  (Prometheus counter, `backend/src/services/metrics.ts`) — scraped via
  `/metrics` like every other metric here.
- `GET /api/admin/api-versions/usage` (admin-gated) — a plain-JSON summary
  for anyone without Prometheus/Grafana handy: total requests per version,
  and the full list of currently-deprecated endpoints with their
  deprecation/sunset dates and successor paths. This is what a retirement
  decision should be based on — if a version's request count has been zero
  for the length of its deprecation window, it's safe to remove.
