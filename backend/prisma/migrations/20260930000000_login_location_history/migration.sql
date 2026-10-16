CREATE TABLE "LoginLocationHistory" (
  "id" TEXT NOT NULL,
  "walletAddress" TEXT NOT NULL,
  "country" TEXT NOT NULL,
  "latitude" DOUBLE PRECISION NOT NULL,
  "longitude" DOUBLE PRECISION NOT NULL,
  "loginAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LoginLocationHistory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LoginLocationHistory_walletAddress_loginAt_idx"
  ON "LoginLocationHistory"("walletAddress", "loginAt");
