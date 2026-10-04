-- ---------------------------------------------------------------------------
-- 0004_notifications.sql
--
-- Backwards compatible additive migration:
--   * creates the per-officer notification inbox table
--   * every index is created with IF NOT EXISTS, so re-running is safe
--   * nothing is renamed or dropped
--
-- Until this migration is applied, notification writes fall back to the
-- in-memory store (see DBRepo.insertNotification), so the app stays correct on an
-- un-migrated database rather than erroring.
-- ---------------------------------------------------------------------------

-- Per-officer inbox -------------------------------------------------------------
-- Deliberately separate from audit_logs: audit is an immutable record of who did
-- what, notifications are a personal, dismissable inbox.
CREATE TABLE IF NOT EXISTS "notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "type" varchar(60) NOT NULL,
  "title" varchar(200) NOT NULL,
  "body" text,
  "resource_type" varchar(60),
  "resource_id" varchar(255),
  "href" varchar(255),
  "read_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "notifications_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
    ON DELETE cascade ON UPDATE no action
);

-- Inbox listing is always "mine, newest first"; the partial index keeps the
-- unread-count query cheap as the table grows.
CREATE INDEX IF NOT EXISTS notifications_user_id_idx ON "notifications" ("user_id");
CREATE INDEX IF NOT EXISTS notifications_created_at_idx ON "notifications" ("created_at");
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON "notifications" ("user_id", "read_at")
  WHERE "read_at" IS NULL;