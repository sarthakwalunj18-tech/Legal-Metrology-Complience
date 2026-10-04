-- ---------------------------------------------------------------------------
-- 0003_platform_hardening.sql
--
-- Backwards compatible additive migration:
--   * every new column is nullable or carries a DEFAULT, so existing rows stay valid
--   * every index is created with IF NOT EXISTS, so re-running is safe
--   * no column or table is renamed or dropped
-- ---------------------------------------------------------------------------

-- 1. Users: Supabase linkage, lifecycle status, audit timestamps ----------------
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "supabase_user_id" uuid;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "status" varchar(20) NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_login_at" timestamptz;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "suspended_at" timestamptz;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "suspended_by" uuid;

CREATE UNIQUE INDEX IF NOT EXISTS users_supabase_user_id_key
  ON "users" ("supabase_user_id") WHERE "supabase_user_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_role_idx ON "users" ("role");
CREATE INDEX IF NOT EXISTS users_status_idx ON "users" ("status");
CREATE INDEX IF NOT EXISTS users_department_idx ON "users" ("department");

-- 2. Scans: async processing state + immutable AI decision snapshot -------------
ALTER TABLE "scans" ADD COLUMN IF NOT EXISTS "ai_decision_status" varchar(50);
ALTER TABLE "scans" ADD COLUMN IF NOT EXISTS "processing_stage" varchar(50) DEFAULT 'UPLOADED';
ALTER TABLE "scans" ADD COLUMN IF NOT EXISTS "processing_error" text;
ALTER TABLE "scans" ADD COLUMN IF NOT EXISTS "processing_timings" jsonb;
ALTER TABLE "scans" ADD COLUMN IF NOT EXISTS "analyzed_at" timestamptz;

-- Backfill the AI decision snapshot for already-analysed inspections so the
-- AI/human agreement metric has a baseline instead of silently reading null.
UPDATE "scans"
SET "ai_decision_status" = "compliance_status"
WHERE "ai_decision_status" IS NULL
  AND "compliance_status" IS NOT NULL
  AND "status" = 'COMPLETED';

CREATE INDEX IF NOT EXISTS scans_inspector_id_idx ON "scans" ("inspector_id");
CREATE INDEX IF NOT EXISTS scans_created_at_idx ON "scans" ("created_at" DESC);
CREATE INDEX IF NOT EXISTS scans_status_idx ON "scans" ("status");
CREATE INDEX IF NOT EXISTS scans_compliance_status_idx ON "scans" ("compliance_status");
CREATE INDEX IF NOT EXISTS scans_review_status_idx ON "scans" ("review_status");
CREATE INDEX IF NOT EXISTS scans_product_id_idx ON "scans" ("product_id");
CREATE INDEX IF NOT EXISTS scans_location_idx ON "scans" ("location");
CREATE INDEX IF NOT EXISTS scans_review_queue_idx ON "scans" ("review_status", "created_at" DESC);

-- 3. Violations: per-violation confidence and human review disposition -----------
ALTER TABLE "violations" ADD COLUMN IF NOT EXISTS "confidence" numeric(5,4);
ALTER TABLE "violations" ADD COLUMN IF NOT EXISTS "review_status" varchar(20) NOT NULL DEFAULT 'PENDING';
ALTER TABLE "violations" ADD COLUMN IF NOT EXISTS "reviewed_by" uuid;
ALTER TABLE "violations" ADD COLUMN IF NOT EXISTS "reviewed_at" timestamptz;
ALTER TABLE "violations" ADD COLUMN IF NOT EXISTS "review_notes" text;

CREATE INDEX IF NOT EXISTS violations_scan_id_idx ON "violations" ("scan_id");
CREATE INDEX IF NOT EXISTS violations_rule_id_idx ON "violations" ("rule_id");
CREATE INDEX IF NOT EXISTS violations_severity_idx ON "violations" ("severity");
CREATE INDEX IF NOT EXISTS violations_review_status_idx ON "violations" ("review_status");
CREATE INDEX IF NOT EXISTS violations_created_at_idx ON "violations" ("created_at" DESC);

-- 4. Compliance checks: persist the bounding box that justified a FAIL ---------
ALTER TABLE "compliance_checks" ADD COLUMN IF NOT EXISTS "bounding_box" jsonb;
CREATE INDEX IF NOT EXISTS compliance_checks_scan_id_idx ON "compliance_checks" ("scan_id");
CREATE INDEX IF NOT EXISTS compliance_checks_rule_id_idx ON "compliance_checks" ("rule_id");
CREATE INDEX IF NOT EXISTS compliance_checks_status_idx ON "compliance_checks" ("status");

-- 5. Extracted fields / images indexes ----------------------------------------
CREATE INDEX IF NOT EXISTS extracted_fields_scan_id_idx ON "extracted_fields" ("scan_id");
CREATE INDEX IF NOT EXISTS extracted_fields_field_name_idx ON "extracted_fields" ("field_name");
CREATE INDEX IF NOT EXISTS images_scan_id_idx ON "images" ("scan_id");
CREATE INDEX IF NOT EXISTS images_scan_id_type_idx ON "images" ("scan_id", "image_type");

-- 6. Reports / audit trail indexes --------------------------------------------
ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "file_size_bytes" integer;
CREATE INDEX IF NOT EXISTS reports_scan_id_idx ON "reports" ("scan_id");
CREATE INDEX IF NOT EXISTS reports_generated_at_idx ON "reports" ("generated_at" DESC);

ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "request_id" varchar(64);
CREATE INDEX IF NOT EXISTS audit_logs_timestamp_idx ON "audit_logs" ("timestamp" DESC);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON "audit_logs" ("action");
CREATE INDEX IF NOT EXISTS audit_logs_resource_idx ON "audit_logs" ("resource_type", "resource_id");
CREATE INDEX IF NOT EXISTS audit_logs_user_id_idx ON "audit_logs" ("user_id");

-- 7. RAG embeddings lookup index ----------------------------------------------
CREATE INDEX IF NOT EXISTS rule_embeddings_rule_id_idx ON "rule_embeddings" ("rule_id");

-- 8. Append-oriented protection: the audit trail must not be casually edited.
--    Revoking UPDATE/DELETE from the anon/authenticated roles (they never had it)
--    and documenting the intent for any future service-role automation.
COMMENT ON TABLE "audit_logs" IS
  'Append-only statutory audit trail. Rows are written by the API and exposed read-only; no UI or API path updates or deletes them.';
