# Live loan-application index check

This migration targets two frequently used `deletedAt: null` query shapes in
`src/services/loanStore.ts`: `getPendingApplications` filters by `status`, and
`getApplicationsByBorrower` filters loan applications by `applicantId`. Both
indexes contain only live rows. The migration uses `CONCURRENTLY`, so run it
without wrapping it in an explicit transaction.

To compare the plans on a representative database, capture these before and
after applying the migration (substitute representative values):

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM "LoanApplication"
WHERE "status" = 'Pending' AND "deletedAt" IS NULL;

EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM "LoanApplication"
WHERE "applicantId" = 'representative-applicant-id'
  AND "deletedAt" IS NULL;
```

The expected index names are `LoanApplication_live_status_idx` and
`LoanApplication_live_applicantId_createdAt_idx`. PostgreSQL may correctly
choose a sequential scan for small tables or low-selectivity values; confirm
with production-like row counts and compare `Execution Time`, buffer reads,
and index size rather than forcing an index scan. Index size can be checked
with:

```sql
SELECT indexrelname,
       pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE indexrelname IN (
  'LoanApplication_live_status_idx',
  'LoanApplication_live_applicantId_createdAt_idx'
);
```

The partial indexes omit soft-deleted entries. They coexist with the existing
Prisma-managed indexes because Prisma's schema DSL cannot represent a partial
index. Reassess the plans and sizes after deployment before considering removal
of any existing index.
