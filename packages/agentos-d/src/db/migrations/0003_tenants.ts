/**
 * Migration 0003 — creates the tenants table.
 *
 * Source-of-truth for what tenants exist. Other tables already carry a free
 * UUID `tenant_id`; this table is the registry the onboarding wizard writes
 * to and the admin UI lists from. Forward-only.
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
    .get("v3-tenants");
  if (existing) return;

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      industry TEXT,
      vault_root TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tenants_name ON tenants(name);
  `);

  // If the table already existed (from a partial v3 apply), add the column.
  const cols = sqlite
    .prepare("PRAGMA table_info(tenants)")
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "description")) {
    sqlite.exec(`ALTER TABLE tenants ADD COLUMN description TEXT;`);
  }

  sqlite
    .prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)")
    .run("v3-tenants");
}
