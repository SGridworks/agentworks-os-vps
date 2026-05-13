/**
 * Migration 0015 — adds approval_queue table.
 *
 * Records actions that were routed to human review (route_to_review).
 * Populated by policy-engine when a decision === 'route_to_review'.
 * Consumed by admin-ui via GET /api/approval-queue.
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

  const alreadyMigrated =
    sqlite
      .prepare("SELECT 1 FROM __drizzle_migrations WHERE hash = ?")
      .get("v1-approval-queue-v2") !== undefined;

  // The base table is created in 0000_init. This migration adds the
  // sla_due_at column + a sibling index. The column is nullable: SQLite
  // does not allow non-constant ALTER TABLE defaults, so app code (or a
  // future trigger) is responsible for populating it on insert.
  const columns: Array<{ name: string }> = sqlite
    .pragma("table_info(approval_queue)") as Array<{ name: string }>;
  const hasSlaDueAt = columns.some((c) => c.name === "sla_due_at");
  if (!hasSlaDueAt) {
    sqlite.exec("ALTER TABLE approval_queue ADD COLUMN sla_due_at TEXT");
  }
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_aq_sla ON approval_queue(sla_due_at)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_aq_decision ON approval_queue(policy_decision_id)");

  // Record migration
  sqlite
    .prepare("INSERT OR IGNORE INTO __drizzle_migrations (hash) VALUES (?)")
    .run("v1-approval-queue-v2");
}
