/**
 * Migration 0001 — adds policy_rules and policy_violations tables.
 *
 * policy_rules: stores authored TCPA/OdessaRule rule packs authored per tenant.
 * policy_violations: log of rule evaluations that produced a block/route_to_review.
 */

import type { Database } from "better-sqlite3";

export function migrate(sqlite: Database): void {
  // Drizzle tracks applied migrations via __drizzle_migrations
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  const existing = sqlite
    .prepare("SELECT 1 FROM __drizzle_migrations WHERE hash = ?")
    .get("v1-policy-tables");
  if (existing) return; // already migrated

  // ---- policy_rules ----
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS policy_rules (
      id                          TEXT NOT NULL PRIMARY KEY,
      tenant_id                   TEXT NOT NULL,

      -- Identity
      name                        TEXT NOT NULL,
      version                     TEXT NOT NULL,
      description                 TEXT,

      -- Source
      source                      TEXT NOT NULL CHECK (source IN ('tcpa','odessa_rule','custom')),
      enabled                     INTEGER NOT NULL DEFAULT 1,

      -- Rule content (JSON snapshot of the rule pack)
      rules_snapshot              TEXT NOT NULL,

      -- Metadata
      created_by                  TEXT NOT NULL,
      created_at                  TEXT NOT NULL,
      updated_at                  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pr_tenant ON policy_rules(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_pr_source ON policy_rules(source);
    CREATE INDEX IF NOT EXISTS idx_pr_enabled ON policy_rules(enabled);
  `);

  // ---- policy_violations ----
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS policy_violations (
      id                          TEXT NOT NULL PRIMARY KEY,
      tenant_id                   TEXT NOT NULL,

      -- Source decision
      policy_decision_id          TEXT NOT NULL,
      policy_rule_id              TEXT NOT NULL,

      -- Violation details
      violation_kind              TEXT NOT NULL
                                   CHECK (violation_kind IN (
                                     'unverified_consent','no_consent_record',
                                     'wrong_channel','wrong_jurisdiction',
                                     'purpose_mismatch','missing_required_field',
                                     'rate_limit_exceeded','other'
                                   )),
      message                    TEXT NOT NULL,

      -- Severity at time of decision
      severity                    TEXT NOT NULL
                                   CHECK (severity IN ('critical','high','medium','low','info')),

      -- Status
      status                      TEXT NOT NULL DEFAULT 'open'
                                   CHECK (status IN ('open','acknowledged','resolved','waived')),

      -- Resolution
      resolved_by                 TEXT,
      resolved_at                 TEXT,
      resolution_note             TEXT,

      -- Timestamps
      created_at                  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pv_tenant   ON policy_violations(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_pv_decision ON policy_violations(policy_decision_id);
    CREATE INDEX IF NOT EXISTS idx_pv_rule     ON policy_violations(policy_rule_id);
    CREATE INDEX IF NOT EXISTS idx_pv_status   ON policy_violations(status);
    CREATE INDEX IF NOT EXISTS idx_pv_created  ON policy_violations(created_at);
  `);

  // Record migration
  sqlite
    .prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)")
    .run("v1-policy-tables");
}
