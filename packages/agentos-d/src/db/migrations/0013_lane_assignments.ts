/**
 * Migration 0013 — adds lane_assignments table.
 *
 * lane_assignments: append-only trace of every issue that entered the
 * auto-assign pipeline. Records the lane match result, the assigned agent,
 * and — once the issue is closed/done — the resolution outcome.
 *
 * This is the feedback signal for diagnosing whether agent-lanes.json
 * patterns are actually routing work correctly.
 *
 * Resolution values:
 *   completed  — assigned agent finished the issue (status → done)
 *   closed      — issue closed without completion (cancelled, blocked, etc.)
 *   escalated   — reassigned outside the lane system after initial assignment
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
    .get("v13-lane-assignments");
  if (existing) return;

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS lane_assignments (
      id                            TEXT NOT NULL PRIMARY KEY,
      issue_id                      TEXT NOT NULL,

      -- Tenant (for multi-tenant isolation)
      tenant_id                     TEXT NOT NULL,

      -- Input to the lane matcher
      issue_description             TEXT NOT NULL,
      extracted_paths               TEXT NOT NULL DEFAULT '[]',  -- JSON array

      -- Lane match result
      matched_role                  TEXT,
      lane_match_reason             TEXT NOT NULL,
      ambiguous                     INTEGER NOT NULL DEFAULT 0,
      triage                        INTEGER NOT NULL DEFAULT 0,

      -- Agent assignment
      assigned_agent_id             TEXT,
      assigned_at                   TEXT,   -- ISO datetime

      -- Resolution (updated when issue status → done/closed)
      resolved_at                   TEXT,   -- ISO datetime
      resolution                    TEXT    CHECK (resolution IN ('completed','closed','escalated')),

      -- Timestamps
      created_at                    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_la_tenant     ON lane_assignments(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_la_issue      ON lane_assignments(issue_id);
    CREATE INDEX IF NOT EXISTS idx_la_role       ON lane_assignments(matched_role);
    CREATE INDEX IF NOT EXISTS idx_la_triage     ON lane_assignments(triage);
    CREATE INDEX IF NOT EXISTS idx_la_resolved   ON lane_assignments(resolved_at);
    CREATE INDEX IF NOT EXISTS idx_la_created    ON lane_assignments(created_at);
  `);

  sqlite
    .prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)")
    .run("v13-lane-assignments");
}
