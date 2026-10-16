# Analytics warehouse CDC foundation

The primary PostgreSQL database writes selected loan lifecycle changes to
`AnalyticsOutbox` in the same transaction as the source row. The migration
currently captures loan application create/status/principal changes, loan
repayments, and disbursements. The payload is constructed from an explicit
field allowlist; borrower IDs, wallet addresses, names, contact details, and
arbitrary source-row JSON are excluded. Do not serialize a complete source
row into this table.

Each row has `schemaVersion` (currently `1`), `eventType`, `sourceTable`,
`sourceId`, and a JSON payload. Consumers should branch on `schemaVersion`,
ignore fields they do not recognize, and preserve the original event for
replay. Introduce incompatible payload changes as a new schema version and
keep readers compatible with the previous version through the migration
window.

## Backfill and delivery

After deploying the migration, run bounded backfills during a controlled
window, for example:

```sql
SELECT remit_backfill_analytics_outbox('2026-01-01 00:00:00+00');
```

The function is idempotent and accepts a lower timestamp bound. Run smaller
time ranges for large installations. The unique event key prevents duplicate
backfill rows and normal source-trigger events from being mistaken for a
backfill. A relay should read pending rows in increasing `id` order, publish
the versioned envelope to the warehouse, then set `publishedAt` only after the
warehouse acknowledges the write. Use bounded batches and retry with the
same event key so delivery is at least once and warehouse ingestion can be
idempotent.

The migration provides `AnalyticsOutboxLag` with pending row count and age of
the oldest pending event. Alert when `oldestPendingSeconds > 300` for five
minutes, or when pending count rises continuously; tune the threshold to the
warehouse's agreed freshness SLO. The view is a database monitoring surface,
not a running relay or a Prometheus exporter.

This change establishes the transactional capture, PII-minimized envelope,
backfill entry point, and lag query. A warehouse-specific relay, credentials,
retention policy, and production alert wiring must be configured for the
selected warehouse before events are exported.
