DROP TRIGGER IF EXISTS trg_template_version_no_delete ON "NotificationTemplateVersion";
DROP TRIGGER IF EXISTS trg_template_version_content_immutable ON "NotificationTemplateVersion";
DROP FUNCTION IF EXISTS prevent_template_version_delete();
DROP FUNCTION IF EXISTS prevent_live_template_content_change();
DROP TABLE IF EXISTS "NotificationTemplateVersion";
DROP TYPE IF EXISTS "NotificationTemplateStatus";
