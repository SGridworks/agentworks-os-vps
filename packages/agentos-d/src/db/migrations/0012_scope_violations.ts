/**
 * Migration 0012 — creates scope_violations.
 *
 * Append-only log of scope-guard revert events.
 * Each row represents one commit that was reverted by the coordinator-side
 * scope-guard daemon because it touched files outside the agent's lane.
 *
 * The scope-guard daemon writes a row via POST /api/admin/scope-violations
 * each time it reverts. AgentWorks OS reads via GET /api/admin/scope-violations
 * for health metrics and the admin UI surface.
 *
 * LEARNINGS §4: schema additions require a committed migration.
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
    .get("v12-scope-violations");
  if (existing) return;

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS scope_violations (
      id               TEXT PRIMARY KEY,  -- UUID
      reverted_from_commit TEXT NOT NULL, -- the commit hash that was reverted
      agent_run_id    TEXT,              -- run ID of the offending agent
      agent_id        TEXT,              -- agent ID
      agent_role      TEXT,              -- e.g. BackendEngineer, FrontendEngineer
      files           TEXT NOT NULL,     -- JSON array of reverted file paths
      reason          TEXT,              -- scope-guard reason or lane violation type
      reverted_at     TEXT NOT NULL,     -- ISO datetime when revert occurred
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sv_agent_id
      ON scope_violations(agent_id);

    CREATE INDEX IF NOT EXISTS idx_sv_reverted_at
      ON scope_violations(reverted_at);
  `);

  sqlite
    .prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)")
    .run("v12-scope-violations");
}
