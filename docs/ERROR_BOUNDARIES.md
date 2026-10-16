# Error Boundaries & In-App Problem Reports (#835)

A render crash shows a friendly fallback instead of a blank page.

- `app/error.tsx` (and `dashboard`, `invest`, `repay`, `settings`, `admin`) are Next route-level boundaries; they render `RouteErrorFallback` inside the app layout. `components/ErrorBoundary.tsx` wraps client subtrees (optional `resetKey` clears the error on navigation).
- The fallback shows an error ID (`ERR-XXXXXXXXXXXX`), **Try again** (re-renders the segment) and **Report a problem**.
- On crash the (scrubbed) exception is sent to Sentry tagged with `error_id` and the anonymized `route`.
- **Report a problem** sends Sentry user feedback linked to that event (`associatedEventId`) with the error ID, anonymized route and coarse context (browser family, viewport, locale, online flag, timestamp).

## Personal data

`lib/error-report.ts#scrubText` runs on the error message/stack and the user's free text before anything is sent. It removes emails, Stellar/EVM addresses and secret keys, JWT/Bearer tokens, long hex (tx hashes), UUIDs, card-like numbers, phone numbers, IPv4 addresses and sensitive query parameters. Routes drop query/hash and replace numeric, UUID and address segments with `[id]`. No user id, wallet or email is attached. Scrubbing is pattern-based; add a pattern to `SCRUBBERS` (with a test) if a new identifier format appears.

Tests: `frontend/__tests__/error-boundary.test.tsx` (thrown render error, recovery, scrubbing, report payload).
