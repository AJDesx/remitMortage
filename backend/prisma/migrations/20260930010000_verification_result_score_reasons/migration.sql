ALTER TABLE "VerificationResult"
  ADD COLUMN "score" INTEGER,
  ADD COLUMN "modelVersion" TEXT,
  ADD COLUMN "scoreBreakdown" JSONB,
  ADD COLUMN "scoreReasons" JSONB;
