/**
 * Initial migration — creates the four core tables:
 * policy_decisions, scanner_findings, approval_queue, action_log
 *
 * All tables use text primary keys (UUIDs) for cross-platform simplicity.
 * Drizzle will track this migration via its _drizzle_migrations table.
 */

import type { Database } from "better-sqlite3";

export function migrate(sqlite: Database): void {
  // Drizzle tracks applied migrations via this table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  // Check if already applied (hash = 'v0-init' for this migration)
  const existing = sqlite
    .prepare("SELECT 1 FROM __drizzle_migrations WHERE hash = ?")
    .get("v0-init");
  if (existing) return; // already migrated

  // ---- policy_decisions ----
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS policy_decisions (
      id                          TEXT NOT NULL PRIMARY KEY,
      action_id                   TEXT NOT NULL,
      tenant_id                   TEXT NOT NULL,

      -- Actor
      actor_id                    TEXT NOT NULL,
      actor_type                  TEXT NOT NULL CHECK (actor_type IN ('human','agent','system')),
      actor_label                 TEXT NOT NULL,

      -- Contact (optional)
      contact_type                TEXT CHECK (contact_type IN ('person','business')),
      contact_label               TEXT,
      contact_address             TEXT,

      -- Channel / jurisdiction
      channel                     TEXT CHECK (channel IN ('sms','email','voice','chat','api','crm','other')),
      jurisdiction                TEXT,

      -- Consent
      consent_source              TEXT CHECK (consent_source IN ('written','verbal','inferred','none','unknown')),
      consent_record_ref         TEXT,
      consent_verified           INTEGER DEFAULT 0,

      -- Purpose
      purpose                     TEXT,
      rule_pack_id                TEXT,
      rule_pack_version           TEXT,

      -- Proposed action
      proposed_action_kind       TEXT NOT NULL,
      proposed_action_summary    TEXT NOT NULL,

      -- Evidence
      evidence_snapshot          TEXT NOT NULL,

      -- Decision
      decision                    TEXT NOT NULL CHECK (decision IN ('allow','block','route_to_review')),
      decision_reason             TEXT NOT NULL,
      shadow_mode                INTEGER NOT NULL DEFAULT 0,

      -- Override (optional)
      overridden_by               TEXT,
      overridden_by_label         TEXT,
      original_decision          TEXT CHECK (original_decision IN ('allow','block','route_to_review')),
      override_reason            TEXT,
      overridden_at               TEXT,

      -- Review (optional)
      reviewed_by                 TEXT,
      reviewed_by_label           TEXT,
      review_decision            TEXT CHECK (review_decision IN ('approve','reject','return_to_author')),
      review_note                TEXT,
      reviewed_at                 TEXT,

      -- Hash chain
      prev_decision_hash         TEXT,
      decision_hash              TEXT NOT NULL,

      -- Timestamps
      proposed_at                TEXT NOT NULL,
      decided_at                 TEXT NOT NULL,
      created_at                 TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pd_tenant ON policy_decisions(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_pd_action ON policy_decisions(action_id);
    CREATE INDEX IF NOT EXISTS idx_pd_decision ON policy_decisions(decision);
    CREATE INDEX IF NOT EXISTS idx_pd_created ON policy_decisions(created_at);
  `);

  // ---- scanner_findings ----
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS scanner_findings (
      id                          TEXT NOT NULL PRIMARY KEY,
      tenant_id                   TEXT NOT NULL,

      origin_kind                 TEXT NOT NULL DEFAULT 'scanner_finding'
                                   CHECK (origin_kind IN ('scanner_finding')),
      origin_id                   TEXT NOT NULL,

      severity                    TEXT NOT NULL
                                   CHECK (severity IN ('critical','high','medium','low','info')),

      rule_id                     TEXT,
      title                       TEXT NOT NULL,
      description                 TEXT NOT NULL,
      remediation                 TEXT,

      affected_endpoint           TEXT,

      status                      TEXT NOT NULL DEFAULT 'open'
                                   CHECK (status IN ('open','resolved')),

      resolved_by                 TEXT,
      resolved_at                 TEXT,
      resolution_note             TEXT,

      created_at                  TEXT NOT NULL,
      updated_at                  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sf_tenant ON scanner_findings(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_sf_status ON scanner_findings(status);
    CREATE INDEX IF NOT EXISTS idx_sf_severity ON scanner_findings(severity);
  `);

  // ---- approval_queue ----
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS approval_queue (
      id                          TEXT NOT NULL PRIMARY KEY,
      policy_decision_id          TEXT NOT NULL,

      tenant_id                   TEXT NOT NULL,
      actor_label                 TEXT NOT NULL,
      proposed_action_kind        TEXT NOT NULL,
      proposed_action_summary     TEXT NOT NULL,
      decision_reason             TEXT NOT NULL,

      status                      TEXT NOT NULL DEFAULT 'pending'
                                   CHECK (status IN ('pending','approved','rejected','returned')),

      reviewed_by                 TEXT,
      reviewed_by_label           TEXT,
      review_note                 TEXT,
      reviewed_at                 TEXT,

      created_at                  TEXT NOT NULL,
      updated_at                  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_aq_tenant ON approval_queue(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_aq_status ON approval_queue(status);
    CREATE INDEX IF NOT EXISTS idx_aq_created ON approval_queue(created_at);
  `);

  // ---- action_log ----
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS action_log (
      id                          TEXT NOT NULL PRIMARY KEY,
      tenant_id                   TEXT NOT NULL,

      actor_id                    TEXT NOT NULL,
      actor_type                  TEXT NOT NULL CHECK (actor_type IN ('human','agent','system')),
      actor_label                 TEXT NOT NULL,

      action_kind                 TEXT NOT NULL,
      payload_snapshot            TEXT NOT NULL,

      vault_refs                  TEXT NOT NULL,
      conversation_refs           TEXT NOT NULL,
      project_refs                TEXT NOT NULL,

      policy_decision_id          TEXT,

      proposed_at                 TEXT NOT NULL,
      logged_at                   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_al_tenant ON action_log(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_al_actor ON action_log(actor_id);
    CREATE INDEX IF NOT EXISTS idx_al_action_kind ON action_log(action_kind);
    CREATE INDEX IF NOT EXISTS idx_al_logged ON action_log(logged_at);
  `);

  // Record migration
  sqlite
    .prepare(
      "INSERT INTO __drizzle_migrations (hash) VALUES (?)"
    )
    .run("v0-init");
}
