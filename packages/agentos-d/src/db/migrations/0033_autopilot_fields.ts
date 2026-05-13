/**
 * Migration 0033 — adds autopilot fields to approval_queue table.
 *
 * Adds:
 * - autopilot_decision: enum(allow, needsApproval, risky) - the autopilot bucket decision
 * - risk_score: numeric(3,2) - risk score 0.0 to 1.0
 * - reasons: jsonb - array of canonical reason strings
 * - idempotency_key: string - for idempotent dispatch operations
 * - dispatched_at: timestamp - when the action was auto-dispatched
 */

import type { Database } from "better-sqlite3";

const HASH = "v33-autopilot-fields";

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
    .get(HASH);
  if (existing) return;

  // Add autopilot fields
  sqlite.exec(`
    ALTER TABLE approval_queue ADD COLUMN autopilot_decision TEXT 
      CHECK (autopilot_decision IN ('allow', 'needsApproval', 'risky'));
  `);
  
  sqlite.exec(`
    ALTER TABLE approval_queue ADD COLUMN risk_score REAL 
      CHECK (risk_score >= 0.0 AND risk_score <= 1.0);
  `);
  
  sqlite.exec(`
    ALTER TABLE approval_queue ADD COLUMN reasons TEXT; -- JSON array of strings
  `);
  
  sqlite.exec(`
    ALTER TABLE approval_queue ADD COLUMN idempotency_key TEXT;
  `);
  
  sqlite.exec(`
    ALTER TABLE approval_queue ADD COLUMN dispatched_at TEXT;
  `);

  // Create index on idempotency_key for fast lookup
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_aq_idempotency_key ON approval_queue(idempotency_key);
  `);

  // Create index on autopilot_decision for filtering
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_aq_autopilot_decision ON approval_queue(autopilot_decision);
  `);

  sqlite.prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)").run(HASH);
}