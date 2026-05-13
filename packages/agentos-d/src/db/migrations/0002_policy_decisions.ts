/**
 * Migration 0002 — adds policy_decisions table (forward-only).
 *
 * Append-only log of every policy engine evaluation. No UPDATE/DELETE allowed.
 * Hash-chained for tamper-evidence. Rows are immutable once written.
 *
 * NOTE: This table is also defined in ../schema.ts via Drizzle.
 * The Drizzle schema is the TypeScript source-of-truth; this migration
 * is the SQLite physical table definition. Keep them in sync.
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
    .get("v2-policy-decisions");
  if (existing) return; // already migrated

  // ---------------------------------------------------------------------------
  // policy_decisions — append-only; no UPDATE/DELETE triggers
  // ---------------------------------------------------------------------------
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS policy_decisions (
      id                          TEXT NOT NULL PRIMARY KEY,
      action_id                   TEXT NOT NULL,

      -- Tenant
      tenant_id                   TEXT NOT NULL,

      -- Actor
      actor_id                    TEXT NOT NULL,
      actor_type                  TEXT NOT NULL
                                   CHECK (actor_type IN ('human','agent','system')),
      actor_label                 TEXT NOT NULL,

      -- Contact (optional)
      contact_type                TEXT CHECK (contact_type IN ('person','business')),
      contact_label               TEXT,
      contact_address             TEXT,

      -- Channel / jurisdiction
      channel                     TEXT CHECK (channel IN ('sms','email','voice','chat','api','crm','other')),
      jurisdiction               TEXT,

      -- Consent
      consent_source              TEXT CHECK (consent_source IN ('written','verbal','inferred','none','unknown')),
      consent_record_ref         TEXT,
      consent_verified            INTEGER DEFAULT 0,

      -- Purpose
      purpose                     TEXT,

      -- Rule pack that produced this decision
      rule_pack_id                TEXT,
      rule_pack_version           TEXT,

      -- Proposed action
      proposed_action_kind        TEXT NOT NULL,
      proposed_action_summary     TEXT NOT NULL,

      -- Evidence snapshot (JSON string)
      evidence_snapshot           TEXT NOT NULL,

      -- Decision
      decision                    TEXT NOT NULL
                                   CHECK (decision IN ('allow','block','route_to_review')),
      decision_reason             TEXT NOT NULL,
      shadow_mode                 INTEGER NOT NULL DEFAULT 0,

      -- Override (optional)
      overridden_by               TEXT,
      overridden_by_label         TEXT,
      original_decision           TEXT CHECK (original_decision IN ('allow','block','route_to_review')),
      override_reason             TEXT,
      overridden_at               TEXT,

      -- Review (populated when reviewer acts on a route_to_review decision)
      reviewed_by                 TEXT,
      reviewed_by_label           TEXT,
      review_decision             TEXT CHECK (review_decision IN ('approve','reject','return_to_author')),
      review_note                 TEXT,
      reviewed_at                 TEXT,

      -- Hash chain (tamper-evident)
      prev_decision_hash          TEXT,
      decision_hash               TEXT NOT NULL,

      -- Timestamps
      proposed_at                 TEXT NOT NULL,
      decided_at                  TEXT NOT NULL,
      created_at                  TEXT NOT NULL,
      updated_at                  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pd_tenant     ON policy_decisions(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_pd_action     ON policy_decisions(action_id);
    CREATE INDEX IF NOT EXISTS idx_pd_decision   ON policy_decisions(decision);
    CREATE INDEX IF NOT EXISTS idx_pd_created    ON policy_decisions(created_at);
    CREATE INDEX IF NOT EXISTS idx_pd_reviewed   ON policy_decisions(reviewed_at);
  `);

  // ---------------------------------------------------------------------------
  // Deny UPDATE and DELETE on policy_decisions (append-only invariant)
  // ---------------------------------------------------------------------------
  sqlite.exec(`
    CREATE TRIGGER IF NOT EXISTS policy_decisions_no_update
    BEFORE UPDATE ON policy_decisions
    BEGIN
      SELECT RAISE(ABORT, 'policy_decisions is append-only: updates are not permitted');
    END;

    CREATE TRIGGER IF NOT EXISTS policy_decisions_no_delete
    BEFORE DELETE ON policy_decisions
    BEGIN
      SELECT RAISE(ABORT, 'policy_decisions is append-only: deletes are not permitted');
    END;
  `);

  // Record migration
  sqlite
    .prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)")
    .run("v2-policy-decisions");
}
