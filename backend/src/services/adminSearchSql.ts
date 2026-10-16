// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * SQL for admin full-text search (issue #826).
 *
 * The tsvector expressions below are used twice and MUST stay identical:
 *   - in the GIN expression indexes (prisma/migrations/20261017010000_admin_full_text_search)
 *   - in the search queries, because Postgres only uses an expression index
 *     when the query repeats the indexed expression exactly.
 * __tests__/adminSearch.test.ts asserts the migration contains every
 * expression verbatim, so the two cannot drift apart silently.
 *
 * Everything is `simple` (no stemming or stop words): the data is names,
 * wallet addresses and status labels, where "Smith" must not be stemmed and a
 * word like "pending" must not be dropped. Prefix matching (`smi:*`) covers
 * name fragments.
 */

export const LOAN_VECTOR =
  `to_tsvector('simple', search_enum_text("status") || ' ' || coalesce("reason", '') || ' ' || coalesce("manualReviewReason", '') || ' ' || coalesce("servicer", ''))`;

export const APPLICANT_VECTOR = `to_tsvector('simple', "stellarAddress" || ' ' || search_enum_text("verificationStatus"))`;

/** Applicant names come from KYC OCR; punctuation is turned into spaces so "Mary-Ann O'Neil" tokenises into words. */
export const OCR_NAME_VECTOR = `to_tsvector('simple', regexp_replace(coalesce("extractedName", ''), '[^[:alnum:]]+', ' ', 'g'))`;

export const DOCUMENT_VECTOR = `to_tsvector('simple', regexp_replace("originalName", '[^[:alnum:]]+', ' ', 'g'))`;

/**
 * Each query returns one row per matching record:
 *   id, rank (0..1, higher is better), sources (which kind of field matched),
 *   total (matches before LIMIT, same on every row), plus display columns.
 * $1 = tsquery text, $2 = row limit.
 */
const Q = `to_tsquery('simple', $1)`;
const RANK = (vec: string) => `ts_rank_cd(${vec}, ${Q}, 32)`;

export const LOAN_SEARCH_SQL = `
WITH hits AS (
  SELECT l."id", ${RANK(LOAN_VECTOR)} AS rank, 'record' AS source
    FROM "LoanApplication" l
   WHERE l."deletedAt" IS NULL AND ${LOAN_VECTOR} @@ ${Q}
  UNION ALL
  SELECT l."id", ${RANK(OCR_NAME_VECTOR)} AS rank, 'name' AS source
    FROM "KycOcrResult" o
    JOIN "Applicant" a ON a."stellarAddress" = o."applicantAddress"
    JOIN "LoanApplication" l ON l."applicantId" = a."id"
   WHERE l."deletedAt" IS NULL AND a."deletedAt" IS NULL AND ${OCR_NAME_VECTOR} @@ ${Q}
), best AS (
  SELECT "id", MAX(rank) AS rank, array_agg(DISTINCT source) AS sources
    FROM hits GROUP BY "id"
)
SELECT b."id", b.rank, b.sources, COUNT(*) OVER () AS total,
       l."status"::text AS status, l."createdAt" AS "createdAt",
       a."stellarAddress" AS "applicantAddress"
  FROM best b
  JOIN "LoanApplication" l ON l."id" = b."id"
  JOIN "Applicant" a ON a."id" = l."applicantId"
 WHERE a."deletedAt" IS NULL
 ORDER BY b.rank DESC, b."id"
 LIMIT $2`;

export const APPLICANT_SEARCH_SQL = `
WITH hits AS (
  SELECT a."id", ${RANK(APPLICANT_VECTOR)} AS rank, 'record' AS source
    FROM "Applicant" a
   WHERE a."deletedAt" IS NULL AND ${APPLICANT_VECTOR} @@ ${Q}
  UNION ALL
  SELECT a."id", ${RANK(OCR_NAME_VECTOR)} AS rank, 'name' AS source
    FROM "KycOcrResult" o
    JOIN "Applicant" a ON a."stellarAddress" = o."applicantAddress"
   WHERE a."deletedAt" IS NULL AND ${OCR_NAME_VECTOR} @@ ${Q}
), best AS (
  SELECT "id", MAX(rank) AS rank, array_agg(DISTINCT source) AS sources
    FROM hits GROUP BY "id"
)
SELECT b."id", b.rank, b.sources, COUNT(*) OVER () AS total,
       a."verificationStatus"::text AS status, a."createdAt" AS "createdAt",
       a."stellarAddress" AS "applicantAddress"
  FROM best b
  JOIN "Applicant" a ON a."id" = b."id"
 ORDER BY b.rank DESC, b."id"
 LIMIT $2`;

export const DOCUMENT_SEARCH_SQL = `
WITH hits AS (
  SELECT d."id", ${RANK(DOCUMENT_VECTOR)} AS rank, 'record' AS source
    FROM "KycDocument" d
    JOIN "Applicant" a ON a."id" = d."applicantId"
   WHERE a."deletedAt" IS NULL AND ${DOCUMENT_VECTOR} @@ ${Q}
  UNION ALL
  SELECT d."id", ${RANK(OCR_NAME_VECTOR)} AS rank, 'name' AS source
    FROM "KycOcrResult" o
    JOIN "KycDocument" d ON d."documentId" = o."documentId"
    JOIN "Applicant" a ON a."id" = d."applicantId"
   WHERE a."deletedAt" IS NULL AND ${OCR_NAME_VECTOR} @@ ${Q}
), best AS (
  SELECT "id", MAX(rank) AS rank, array_agg(DISTINCT source) AS sources
    FROM hits GROUP BY "id"
)
SELECT b."id", b.rank, b.sources, COUNT(*) OVER () AS total,
       d."originalName" AS "originalName", d."uploadedAt" AS "createdAt",
       a."stellarAddress" AS "applicantAddress"
  FROM best b
  JOIN "KycDocument" d ON d."id" = b."id"
  JOIN "Applicant" a ON a."id" = d."applicantId"
 ORDER BY b.rank DESC, b."id"
 LIMIT $2`;
