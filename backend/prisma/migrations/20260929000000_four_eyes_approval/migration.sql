-- Issue #841: four-eyes approval queue for high-value/sensitive admin
-- actions. A pending request's payload is replayed to actually perform the
-- action once a distinct second admin approves it.

CREATE TABLE "FourEyesApprovalRequest" (
  "id" TEXT NOT NULL,
  "actionType" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "amount" DOUBLE PRECISION,
  "requestedBy" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "approvedBy" TEXT,
  "approvedAt" TIMESTAMP(3),
  "rejectedBy" TEXT,
  "rejectedAt" TIMESTAMP(3),
  "rejectionReason" TEXT,
  "executedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FourEyesApprovalRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FourEyesApprovalRequest_status_expiresAt_idx" ON "FourEyesApprovalRequest"("status", "expiresAt");
CREATE INDEX "FourEyesApprovalRequest_requestedBy_idx" ON "FourEyesApprovalRequest"("requestedBy");
CREATE INDEX "FourEyesApprovalRequest_actionType_status_idx" ON "FourEyesApprovalRequest"("actionType", "status");
