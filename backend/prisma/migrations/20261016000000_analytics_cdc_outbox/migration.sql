-- Issue #890: transactional outbox for warehouse CDC. Only explicitly
-- allowlisted fields are serialized; borrower identifiers, contact details,
-- and arbitrary JSON columns never leave the primary database.
CREATE TABLE "AnalyticsOutbox" (
  "id" BIGSERIAL PRIMARY KEY,
  "eventKey" TEXT NOT NULL UNIQUE,
  "sourceTable" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "payload" JSONB NOT NULL,
  "occurredAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedAt" TIMESTAMPTZ
);

CREATE INDEX "AnalyticsOutbox_pending_id_idx"
  ON "AnalyticsOutbox" ("id") WHERE "publishedAt" IS NULL;
CREATE INDEX "AnalyticsOutbox_pending_createdAt_idx"
  ON "AnalyticsOutbox" ("createdAt") WHERE "publishedAt" IS NULL;

-- Build a versioned, PII-minimized event from an allowlist. Do not replace
-- this with to_jsonb(NEW): new database columns must not leak by default.
CREATE OR REPLACE FUNCTION remit_enqueue_analytics_outbox()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  row_data JSONB := to_jsonb(NEW);
  source_name TEXT := TG_TABLE_NAME;
  source_id TEXT := row_data->>'id';
  event_name TEXT := lower(TG_TABLE_NAME) || '.' || lower(TG_OP);
  safe_payload JSONB;
  event_time TIMESTAMPTZ := CURRENT_TIMESTAMP;
BEGIN
  IF source_name = 'LoanApplication' THEN
    safe_payload := jsonb_strip_nulls(jsonb_build_object(
      'status', row_data->>'status',
      'principal', row_data->>'principal',
      'createdAt', row_data->>'createdAt'
    ));
  ELSIF source_name IN ('LoanRepayment', 'LoanDisbursement') THEN
    safe_payload := jsonb_strip_nulls(jsonb_build_object(
      'amount', row_data->>'amount',
      'contractId', row_data->>'contractId',
      'ledger', row_data->>'ledger',
      'createdAt', row_data->>'createdAt'
    ));
  ELSE
    RAISE EXCEPTION 'Unsupported analytics outbox source: %', source_name;
  END IF;

  IF source_id IS NULL THEN
    RAISE EXCEPTION 'Analytics outbox source % has no id', source_name;
  END IF;

  INSERT INTO "AnalyticsOutbox" (
    "eventKey", "sourceTable", "sourceId", "eventType", "schemaVersion", "payload", "occurredAt"
  ) VALUES (
    source_name || ':' || source_id || ':' || lower(TG_OP) || ':' || txid_current()::text,
    source_name, source_id, event_name, 1, safe_payload, event_time
  ) ON CONFLICT ("eventKey") DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "LoanApplication_analytics_outbox"
  AFTER INSERT OR UPDATE OF "status", "principal" ON "LoanApplication"
  FOR EACH ROW EXECUTE FUNCTION remit_enqueue_analytics_outbox();
CREATE TRIGGER "LoanRepayment_analytics_outbox"
  AFTER INSERT ON "LoanRepayment"
  FOR EACH ROW EXECUTE FUNCTION remit_enqueue_analytics_outbox();
CREATE TRIGGER "LoanDisbursement_analytics_outbox"
  AFTER INSERT ON "LoanDisbursement"
  FOR EACH ROW EXECUTE FUNCTION remit_enqueue_analytics_outbox();

-- Re-runnable bootstrap backfill. eventKey makes repeated invocations safe;
-- callers can backfill bounded date ranges and commit each range separately.
CREATE OR REPLACE FUNCTION remit_backfill_analytics_outbox(p_from TIMESTAMPTZ DEFAULT '-infinity')
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE inserted_count BIGINT := 0;
        batch_count BIGINT := 0;
BEGIN
  INSERT INTO "AnalyticsOutbox" ("eventKey", "sourceTable", "sourceId", "eventType", "schemaVersion", "payload", "occurredAt")
  SELECT 'backfill:LoanApplication:' || l."id", 'LoanApplication', l."id", 'loanapplication.snapshot', 1,
         jsonb_strip_nulls(jsonb_build_object('status', l."status", 'principal', l."principal", 'createdAt', l."createdAt")), l."createdAt"
    FROM "LoanApplication" l WHERE l."createdAt" >= p_from
  ON CONFLICT ("eventKey") DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;

  INSERT INTO "AnalyticsOutbox" ("eventKey", "sourceTable", "sourceId", "eventType", "schemaVersion", "payload", "occurredAt")
  SELECT 'backfill:LoanRepayment:' || r."id", 'LoanRepayment', r."id", 'loanrepayment.snapshot', 1,
         jsonb_strip_nulls(jsonb_build_object('amount', r."amount", 'contractId', r."contractId", 'ledger', r."ledger", 'createdAt', r."createdAt")), r."createdAt"
    FROM "LoanRepayment" r WHERE r."createdAt" >= p_from
  ON CONFLICT ("eventKey") DO NOTHING;
  GET DIAGNOSTICS batch_count = ROW_COUNT;
  inserted_count := inserted_count + batch_count;

  INSERT INTO "AnalyticsOutbox" ("eventKey", "sourceTable", "sourceId", "eventType", "schemaVersion", "payload", "occurredAt")
  SELECT 'backfill:LoanDisbursement:' || d."id", 'LoanDisbursement', d."id", 'loandisbursement.snapshot', 1,
         jsonb_strip_nulls(jsonb_build_object('amount', d."amount", 'contractId', d."contractId", 'ledger', d."ledger", 'createdAt', d."createdAt")), d."createdAt"
    FROM "LoanDisbursement" d WHERE d."createdAt" >= p_from
  ON CONFLICT ("eventKey") DO NOTHING;
  GET DIAGNOSTICS batch_count = ROW_COUNT;
  inserted_count := inserted_count + batch_count;
  RETURN inserted_count;
END;
$$;

-- A lightweight queryable lag surface for the relay/monitoring adapter.
CREATE VIEW "AnalyticsOutboxLag" AS
SELECT COUNT(*)::BIGINT AS "pendingCount",
       COALESCE(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MIN("createdAt")))::BIGINT, 0) AS "oldestPendingSeconds"
  FROM "AnalyticsOutbox"
 WHERE "publishedAt" IS NULL;
