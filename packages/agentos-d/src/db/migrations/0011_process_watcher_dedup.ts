/**
 * Migration 0011 — creates process_watcher_dedup.
 *
 * Cross-tick deduplication table for ProcessWatcher's seven supervisor checks.
 * Prevents the same finding from being posted to the same issue on every
 * heartbeat tick. Uses composite PK (check_id, target_issue_id) for upserts.
 *
 * LEARNINGS §4: schema additions require a committed migration.
 * Dynamic CREATE TABLE was previously inline in checks.ts and dedup.ts.
 * This migration replaces both.
 *
 * Forward-only, idempotent via __drizzle_migrations.
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
    .get("v11-process-watcher-dedup");
  if (existing) return;

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS process_watcher_dedup (
      check_id TEXT NOT NULL,
      target_issue_id TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (check_id, target_issue_id)
    );

    CREATE INDEX IF NOT EXISTS idx_pwd_issue
      ON process_watcher_dedup(target_issue_id);
  `);

  sqlite
    .prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)")
    .run("v11-process-watcher-dedup");
}
