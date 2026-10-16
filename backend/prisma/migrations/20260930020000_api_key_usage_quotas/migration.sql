ALTER TABLE "ApiKey"
  ADD COLUMN "plan" TEXT NOT NULL DEFAULT 'default';

CREATE TABLE "ApiKeyUsage" (
  "id" TEXT NOT NULL,
  "apiKeyId" TEXT NOT NULL,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "requestCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ApiKeyUsage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApiKeyUsage_apiKeyId_periodStart_key"
  ON "ApiKeyUsage"("apiKeyId", "periodStart");
CREATE INDEX "ApiKeyUsage_apiKeyId_periodStart_idx"
  ON "ApiKeyUsage"("apiKeyId", "periodStart");
ALTER TABLE "ApiKeyUsage"
  ADD CONSTRAINT "ApiKeyUsage_apiKeyId_fkey"
  FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
