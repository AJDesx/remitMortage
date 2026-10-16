-- Issue #825: admin-managed notification template versioning.
-- Templates are stored per (key, locale) as numbered versions in
-- Draft / Published / Superseded states. Sends read the Published version, so
-- wording changes and rollbacks need no deploy and have a full history.

CREATE TYPE "NotificationTemplateStatus" AS ENUM ('Draft', 'Published', 'Superseded');

CREATE TABLE "NotificationTemplateVersion" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "locale" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "NotificationTemplateStatus" NOT NULL DEFAULT 'Draft',
  "subject" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "changeNote" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedBy" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "publishedBy" TEXT,
  "publishedAt" TIMESTAMP(3),
  CONSTRAINT "NotificationTemplateVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationTemplateVersion_key_locale_version_key"
  ON "NotificationTemplateVersion"("key", "locale", "version");
CREATE INDEX "NotificationTemplateVersion_key_locale_status_idx"
  ON "NotificationTemplateVersion"("key", "locale", "status");

-- At most one live version per template and locale; a concurrent publish that
-- would create a second one fails instead of leaving sends ambiguous.
CREATE UNIQUE INDEX "NotificationTemplateVersion_one_published_key"
  ON "NotificationTemplateVersion"("key", "locale")
  WHERE "status" = 'Published';

-- Content of a version that has been (or is) live must never change: edits
-- are new versions. Only status / publish metadata may be updated.
CREATE OR REPLACE FUNCTION prevent_live_template_content_change() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'Draft'
     AND (NEW."subject" IS DISTINCT FROM OLD."subject" OR NEW."body" IS DISTINCT FROM OLD."body") THEN
    RAISE EXCEPTION 'NotificationTemplateVersion % is no longer a draft; its content is immutable', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_template_version_content_immutable
  BEFORE UPDATE ON "NotificationTemplateVersion"
  FOR EACH ROW EXECUTE FUNCTION prevent_live_template_content_change();

CREATE OR REPLACE FUNCTION prevent_template_version_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'NotificationTemplateVersion history is append-only: DELETE is not allowed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_template_version_no_delete
  BEFORE DELETE ON "NotificationTemplateVersion"
  FOR EACH ROW EXECUTE FUNCTION prevent_template_version_delete();
