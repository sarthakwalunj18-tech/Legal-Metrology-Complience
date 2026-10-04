import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTableConfig } from "drizzle-orm/pg-core";
import { notifications } from "../db/schema.js";

/**
 * Migration/schema drift guard.
 *
 * These migrations are hand-written SQL while the runtime schema is declared in
 * Drizzle, so nothing stops the two from drifting: a column added to `schema.ts`
 * and forgotten in the `.sql` file fails only at runtime, against a live database,
 * on a notification nobody was waiting for.
 *
 * There is no Postgres available in this environment to execute the migration
 * against, so this asserts the cheaper and more common failure instead — that
 * every column and index Drizzle knows about is actually written down in the SQL.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.join(here, "..", "db", "migrations", "0004_notifications.sql");

let passed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1;
    console.log(`   ✓ ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`   ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function run() {
  console.log("==================================================");
  console.log("🗄️  MIGRATION / SCHEMA DRIFT");
  console.log("==================================================");

  const sql = fs.readFileSync(MIGRATION, "utf8");
  const config = getTableConfig(notifications);

  console.log("\n1️⃣ Every declared column is created in the migration");
  for (const column of config.columns) {
    check(
      `column ${column.name} is created`,
      new RegExp(`"${column.name}"\\s`).test(sql),
      `missing from ${path.basename(MIGRATION)}`,
    );
  }

  console.log("\n2️⃣ The primary key is present");
  const pk = config.primaryKeys?.[0];
  for (const column of pk?.columns ?? []) {
    check(`primary key column ${column.name} is declared`, new RegExp(`"${column.name}"`).test(sql));
  }

  console.log("\n3️⃣ Every declared index is created");
  for (const index of config.indexes ?? []) {
    const name = index.config.name;
    check(`index ${name} is created`, sql.includes(name), `missing from ${path.basename(MIGRATION)}`);
  }

  console.log("\n4️⃣ The migration is safe to re-run");
  check("table creation is guarded", /CREATE TABLE IF NOT EXISTS/.test(sql));
  check("every index creation is guarded", !/CREATE INDEX (?!IF NOT EXISTS)/.test(sql));
  check("no destructive statements", !/\b(DROP\s+(TABLE|COLUMN)|TRUNCATE|ALTER COLUMN)\b/i.test(sql));

  console.log("\n5️⃣ The foreign key to the notification owner exists");
  const fks = config.foreignKeys ?? [];
  check("a user foreign key is declared", fks.length > 0);
  check(
    "the foreign key cascades so an officer's inbox dies with them",
    /ON DELETE cascade/i.test(sql),
  );

  console.log("\n==================================================");
  if (failures.length === 0) {
    console.log(`✅ All ${passed} drift checks passed`);
    console.log("==================================================");
    return;
  }

  console.log(`❌ ${failures.length} failed, ${passed} passed`);
  for (const failure of failures) console.log(`   - ${failure}`);
  console.log("==================================================");
  throw new Error("Migration does not match the Drizzle schema");
}

run();