# Environment Configuration

## Demo Mode

RemitMortgage supports a **demo / sandbox mode** that lets frontend developers and
integration testers exercise API routes without a live Stellar network. When
enabled, certain endpoints skip real contract interactions and return mock data.

### Enabling Demo Mode

Set the following environment variable:

```env
DEMO_MODE=true
```

### What Demo Mode Affects

The following routes are demo-gated and return mock responses when the flag is on:

- Loan repayment and disbursement endpoints
- Escrow deposit and release operations
- Milestone proposal and approval flows

A separate request rate limiter (`demo-rate-limit.ts`) caps demo endpoints at
10 requests per minute per IP to prevent abuse.

### Demo Mode Middleware

The `requireDemo` middleware (`backend/src/utils/demo.ts`) returns a 403 when a
demo-gated route is accessed without the flag set. Apply it to any route that
should only function in demo mode:

```ts
import { requireDemo } from "../utils/demo.js";
router.post("/loan/repay", requireDemo, repayHandler);
```

### Rate Limiting

When `DEMO_MODE=true`, a strict rate limiter is active on demo-gated routes.
See `backend/src/utils/demo-rate-limit.ts` for configuration details.

---

## General Configuration

Refer to `.env.example` at the project root for the full list of supported
environment variables, including Stellar network settings, database connection
strings, CORS origins, contract IDs, and API keys.

### Product usage analytics

Product usage analytics is enabled by default. Set the following variable to
`false` to disable frontend tracking and backend persistence without changing
application code:

```env
ANALYTICS_ENABLED=false
NEXT_PUBLIC_ANALYTICS_ENABLED=false
```

Authenticated events are buffered through the existing Redis/BullMQ analytics
queue and persisted in PostgreSQL in batches. Run the backend worker with the
same Redis configuration as the API process so queued events are drained.

## Request Payload Limits

Every request is checked by `backend/src/middleware/payloadLimits.ts` before the
body is parsed: `Content-Length` first, then the streamed size, then the JSON
nesting depth and array length. Violations return `413` with a machine-readable
`error` (`payload_too_large`, `json_too_deep`, `json_array_too_long`) and
increment `remitmortgage_payload_rejected_total{reason,route}`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PAYLOAD_MAX_BYTES` | `102400` | Default maximum body size (bytes) |
| `PAYLOAD_MAX_JSON_DEPTH` | `20` | Default maximum JSON nesting depth |
| `PAYLOAD_MAX_ARRAY_LENGTH` | `1000` | Default maximum elements in any one array |

Larger limits are explicit, per route, in `DEFAULT_ROUTE_LIMITS`
(`/api/kyc`, `/api/loan/import` and the email-events webhook). Add an entry
there rather than raising the global defaults.

## Graceful Shutdown

On `SIGTERM`/`SIGINT` the API fails `/api/health` and `/api/health/ready`
immediately, stops accepting connections, lets in-flight requests finish, drains
queue workers (jobs still running at the timeout are requeued), then closes
queues, Redis and the database. `/api/health/live` keeps returning `200`
throughout, so point liveness probes there and readiness probes at
`/api/health/ready`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SHUTDOWN_REQUEST_TIMEOUT_MS` | `15000` | How long in-flight requests may run before connections are closed |
| `SHUTDOWN_JOB_TIMEOUT_MS` | `15000` | How long running jobs may run before they are requeued |

Keep the larger of the two (plus ~5s) below the orchestrator's
`terminationGracePeriodSeconds`.

## Admin Search

| Variable | Default | Meaning |
| --- | --- | --- |
| `ADMIN_SEARCH_API_KEY_ENTITIES` | `loans,applicants` | Record types the static admin API key may search (`loans`, `applicants`, `documents`). Admin wallet sessions can search all three. |
