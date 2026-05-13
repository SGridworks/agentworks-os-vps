/**
 * Migration 0017 — adds policy_pack_mode table.
 *
 * Per-pack shadow/enforce override. When a row exists for a pack_id, that
 * mode supersedes the daemon-wide / tenant-wide shadow-mode resolution.
 * One row per pack_id (upsert on PATCH /api/policy/packs/:packId/mode).
 *
 * Idempotent — checks __drizzle_migrations hash before applying.
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
    .get("v17-policy-pack-mode");
  if (existing) return;

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS policy_pack_mode (
      pack_id      TEXT NOT NULL PRIMARY KEY,
      mode         TEXT NOT NULL CHECK (mode IN ('shadow', 'enforce')),
      flipped_by   TEXT,
      flipped_at   TEXT NOT NULL,
      reason       TEXT
    );
  `);

  sqlite
    .prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)")
    .run("v17-policy-pack-mode");
}
