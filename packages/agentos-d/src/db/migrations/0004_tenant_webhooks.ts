/**
 * Migration 0004 — creates the tenant_webhooks table.
 *
 * Per-tenant webhook registry. Used by the substrate to fire HTTP notifications
 * on substrate events (initially: approval_queue.enqueued). Operators register
 * a URL + an optional shared secret; the substrate POSTs JSON.
 *
 * No outbound email by design — webhooks are the operator's choice of bridge
 * to whatever messaging system they run.
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
    .get("v4-tenant-webhooks");
  if (existing) return;

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS tenant_webhooks (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      url TEXT NOT NULL,
      events TEXT NOT NULL,
      secret TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_webhooks_tenant ON tenant_webhooks(tenant_id);
  `);

  sqlite
    .prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)")
    .run("v4-tenant-webhooks");
}
