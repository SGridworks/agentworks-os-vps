/**
 * Migration 0007 — creates dispatch_queue.
 *
 * The dispatch queue records substrate-initiated tasks bound for an agent.
 * Routes write a row when n8n / REST callers ask the substrate to hand a
 * task to a target agent; the row sits at status='queued' until an adapter
 * (or operator) picks it up and transitions it through 'dispatched' to
 * 'completed' or 'failed'.
 *
 * v1 doesn't ship a worker that drains the queue — adapters poll it on
 * their own cadence, or webhook fan-out can be wired later. The substrate
 * just guarantees a durable, tenant-scoped, append-friendly record of
 * what was asked for.
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
    .get("v7-dispatch-queue");
  if (existing) return;

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_queue (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      task_kind TEXT NOT NULL,
      target_agent_id TEXT NOT NULL,
      input TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      policy_decision_id TEXT,
      created_at TEXT NOT NULL,
      dispatched_at TEXT,
      completed_at TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dispatch_tenant ON dispatch_queue(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_dispatch_status ON dispatch_queue(status);
    CREATE INDEX IF NOT EXISTS idx_dispatch_target ON dispatch_queue(target_agent_id);
  `);

  sqlite
    .prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)")
    .run("v7-dispatch-queue");
}
