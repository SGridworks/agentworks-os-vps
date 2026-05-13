/**
 * Migration 0006 — creates tenant_rule_pack_assignments and backfills.
 *
 * Per-tenant rule pack subscription registry. Replaces the implicit "every
 * tenant gets every pack in rule-packs/" behavior with an explicit
 * assignment row, so a healthcare tenant can subscribe to HIPAA without
 * inheriting TCPA real-estate rules and vice versa.
 *
 * Backfill rule: every existing tenant gets `smb-starter` assigned in
 * `enforce` mode. The smb-starter pack is the universal baseline and is
 * safe for any tenant; industry-specific packs (TCPA-RE, fair-housing,
 * HIPAA) are assigned by the operator via the onboarding wizard.
 *
 * Forward-only, idempotent via __drizzle_migrations.
 */

import type { Database } from "better-sqlite3";

const DEFAULT_BACKFILL_PACK_ID = "smb-starter";

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
    .get("v6-tenant-rule-pack-assignments");
  if (existing) return;

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS tenant_rule_pack_assignments (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      pack_id TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'enforce',
      assigned_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (tenant_id, pack_id)
    );
    CREATE INDEX IF NOT EXISTS idx_trp_tenant ON tenant_rule_pack_assignments(tenant_id);
  `);

  // Backfill: assign smb-starter to every existing tenant in enforce mode.
  // The unique (tenant_id, pack_id) constraint makes this idempotent if a
  // partial v6 was applied previously.
  const tenantRows = sqlite
    .prepare("SELECT id FROM tenants")
    .all() as Array<{ id: string }>;

  if (tenantRows.length > 0) {
    const now = new Date().toISOString();
    const insertStmt = sqlite.prepare(
      `INSERT OR IGNORE INTO tenant_rule_pack_assignments
        (id, tenant_id, pack_id, mode, assigned_at, updated_at)
        VALUES (?, ?, ?, 'enforce', ?, ?)`,
    );
    const txn = sqlite.transaction((rows: Array<{ id: string }>) => {
      for (const row of rows) {
        insertStmt.run(
          `${row.id}-${DEFAULT_BACKFILL_PACK_ID}`,
          row.id,
          DEFAULT_BACKFILL_PACK_ID,
          now,
          now,
        );
      }
    });
    txn(tenantRows);
  }

  sqlite
    .prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)")
    .run("v6-tenant-rule-pack-assignments");
}
