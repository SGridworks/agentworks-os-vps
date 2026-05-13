/**
 * Migration 0002 — adds the missing `updated_at` column to policy_decisions.
 *
 * schema.ts always declared `updatedAt: text("updated_at").notNull()` but the
 * 0000_init migration omitted the column. The drift surfaced when the MCP
 * `policy.check` tool first wrote a row end-to-end:
 *
 *   table policy_decisions has no column named updated_at
 *
 * Same drift would have hit POST /api/policy/evaluate the first time anyone
 * called it; nobody had. Forward-only fix here so existing dev databases
 * don't need a wipe.
 */

import type { Database } from "better-sqlite3";

export function migrate(sqlite: Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  const existing = sqlite
    .prepare("SELECT 1 FROM __drizzle_migrations WHERE hash = ?")
    .get("v2-policy-decisions-updated-at");
  if (existing) return;

  // Check whether the column already exists (older DBs created via raw
  // schema dump may have it).
  const cols = sqlite
    .prepare("PRAGMA table_info(policy_decisions)")
    .all() as Array<{ name: string }>;
  const hasUpdatedAt = cols.some((c) => c.name === "updated_at");

  if (!hasUpdatedAt) {
    sqlite.exec(
      `ALTER TABLE policy_decisions ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';`,
    );
    // Backfill existing rows from created_at so NOT NULL holds for any data
    // already present (defensive — table is usually empty at this point).
    sqlite.exec(
      `UPDATE policy_decisions SET updated_at = created_at WHERE updated_at = '';`,
    );
  }

  sqlite
    .prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)")
    .run("v2-policy-decisions-updated-at");
}
