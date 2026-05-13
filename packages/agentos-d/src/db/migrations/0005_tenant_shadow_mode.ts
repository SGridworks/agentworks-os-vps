/**
 * Migration 0005 — adds shadow_mode + shadow_until to tenants.
 *
 * Tenants get an effective policy mode that policy.check falls back to when
 * the per-request shadowMode argument is unset. shadow_until is an optional
 * auto-flip clock: when the substrate observes a tenant whose shadow_until
 * has passed, it persists shadow_mode=false (auto-flip to enforce).
 *
 * Both columns default to safe values: shadow_mode=true (advisory only),
 * shadow_until=NULL (no clock). Existing rows are backfilled in-place.
 *
 * Forward-only, idempotent via __drizzle_migrations hash.
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
    .get("v5-tenant-shadow-mode");
  if (existing) return;

  const cols = sqlite
    .prepare("PRAGMA table_info(tenants)")
    .all() as Array<{ name: string }>;

  if (!cols.some((c) => c.name === "shadow_mode")) {
    sqlite.exec(`ALTER TABLE tenants ADD COLUMN shadow_mode INTEGER NOT NULL DEFAULT 1;`);
  }
  if (!cols.some((c) => c.name === "shadow_until")) {
    sqlite.exec(`ALTER TABLE tenants ADD COLUMN shadow_until TEXT;`);
  }

  sqlite
    .prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)")
    .run("v5-tenant-shadow-mode");
}
