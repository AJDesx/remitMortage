-- Keep the two high-traffic live-loan query paths out of the soft-deleted
-- portion of LoanApplication. Prisma does not model partial indexes, so these
-- indexes are intentionally managed by SQL.
--
-- CREATE INDEX CONCURRENTLY must run outside an explicit transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "LoanApplication_live_status_idx"
  ON "LoanApplication" ("status")
  WHERE "deletedAt" IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "LoanApplication_live_applicantId_createdAt_idx"
  ON "LoanApplication" ("applicantId", "createdAt")
  WHERE "deletedAt" IS NULL;
