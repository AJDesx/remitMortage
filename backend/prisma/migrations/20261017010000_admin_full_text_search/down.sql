DROP INDEX IF EXISTS "KycDocument_name_fts_idx";
DROP INDEX IF EXISTS "KycOcrResult_name_fts_idx";
DROP INDEX IF EXISTS "Applicant_search_fts_idx";
DROP INDEX IF EXISTS "LoanApplication_search_fts_idx";
DROP FUNCTION IF EXISTS search_enum_text(anyenum);
