/**
 * Migration 0009 — creates daemon_paused_state.
 *
 * Single-row key-value store for substrate-level pause state.
 * The substrate checks this flag before dispatch, policy.check, and cron ticks.
 * While paused: dispatch returns 503, policy.check returns 503 with reason
 * "substrate_paused", and cron ticks are skipped entirely.
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
    .get("v9-daemon-paused-state");
  if (existing) return;

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS daemon_paused_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton row
      paused INTEGER NOT NULL DEFAULT 0,      -- 0 = running, 1 = paused
      paused_at TEXT,                          -- ISO datetime when paused
      paused_by TEXT,                          -- agent/user who paused
      reason TEXT                              -- free-text reason
    );

    INSERT OR IGNORE INTO daemon_paused_state (id, paused) VALUES (1, 0);
  `);

  sqlite
    .prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)")
    .run("v9-daemon-paused-state");
}
