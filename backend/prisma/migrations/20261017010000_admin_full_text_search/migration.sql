-- Issue #826: PostgreSQL full-text search across loans, applicants and KYC
-- documents for the admin search endpoint.
--
-- These are expression GIN indexes: no schema columns, no write-time cost
-- beyond the index itself, and nothing for Prisma to drift from. The query
-- side (src/services/adminSearchSql.ts) repeats each expression verbatim,
-- which is what lets the planner use the index.

-- Enum -> text casts are only STABLE in Postgres, so they cannot appear in an
-- index expression directly. Enum labels never change in place, so a wrapper
-- declared IMMUTABLE is safe and keeps the index usable.
CREATE OR REPLACE FUNCTION search_enum_text(anyenum) RETURNS text AS $$
  SELECT $1::text
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT;

CREATE INDEX "LoanApplication_search_fts_idx" ON "LoanApplication" USING GIN (
  to_tsvector('simple', search_enum_text("status") || ' ' || coalesce("reason", '') || ' ' || coalesce("manualReviewReason", '') || ' ' || coalesce("servicer", ''))
);

CREATE INDEX "Applicant_search_fts_idx" ON "Applicant" USING GIN (
  to_tsvector('simple', "stellarAddress" || ' ' || search_enum_text("verificationStatus"))
);

-- Applicant names are extracted from ID documents by OCR.
CREATE INDEX "KycOcrResult_name_fts_idx" ON "KycOcrResult" USING GIN (
  to_tsvector('simple', regexp_replace(coalesce("extractedName", ''), '[^[:alnum:]]+', ' ', 'g'))
);

CREATE INDEX "KycDocument_name_fts_idx" ON "KycDocument" USING GIN (
  to_tsvector('simple', regexp_replace("originalName", '[^[:alnum:]]+', ' ', 'g'))
);
