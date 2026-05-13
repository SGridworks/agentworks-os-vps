/**
 * Migration 0019: compat_proxy_events table.
 *
 * Records AWOS-side evidence for legacy API calls forwarded during execution
 * subsumption. This is read-only mirror evidence before dual-write.
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
    .get("v19-compat-proxy-events");
  if (existing) return;

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS compat_proxy_events (
      id              TEXT NOT NULL PRIMARY KEY,
      method          TEXT NOT NULL,
      path            TEXT NOT NULL,
      status_code     INTEGER,
      request_hash    TEXT NOT NULL,
      response_hash   TEXT,
      request_bytes   INTEGER NOT NULL DEFAULT 0,
      response_bytes  INTEGER NOT NULL DEFAULT 0,
      run_id          TEXT,
      forwarded_to    TEXT NOT NULL,
      error           TEXT,
      created_at      TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cpe_created ON compat_proxy_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_cpe_path ON compat_proxy_events(path);
    CREATE INDEX IF NOT EXISTS idx_cpe_status ON compat_proxy_events(status_code);
    CREATE INDEX IF NOT EXISTS idx_cpe_run ON compat_proxy_events(run_id);
  `);

  sqlite
    .prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)")
    .run("v19-compat-proxy-events");
}
