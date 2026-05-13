/**
 * Migration 0018 — adds rule_pack_drafts table.
 *
 * Per-pack draft YAML staged before atomic promotion to the active pack.
 * One row per pack_id (upserted on POST /api/policy/packs/:id/draft).
 * On promote, the active pack file is replaced atomically and the draft
 * row is cleared.
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
    .get("v18-rule-pack-drafts");
  if (existing) return;

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS rule_pack_drafts (
      pack_id     TEXT NOT NULL PRIMARY KEY,
      yaml        TEXT NOT NULL,
      saved_by    TEXT,
      saved_at    TEXT NOT NULL
    );
  `);

  sqlite
    .prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)")
    .run("v18-rule-pack-drafts");
}
