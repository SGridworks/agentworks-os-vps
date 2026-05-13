/**
 * Migration 0016 — adds signing columns to evidence_reports.
 *
 * Adds: html_size, pdf_hash, hmac, signed_at
 *
 * For fresh installs this is redundant with 0008's CREATE TABLE definition
 * (which this migration also fixes), but existing installations that ran 0008
 * when it had only 7 columns need these additions.
 *
 * Idempotent: safe to re-run; each column is added only if absent.
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
      .get("v1-evidence-reports-signing-v1") !== undefined;

  if (!alreadyMigrated) {
    // Fix 0008's CREATE TABLE to include all 12 columns (fresh install path).
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS evidence_reports (
        id                              TEXT NOT NULL,
        tenant_id                       TEXT NOT NULL,
        report_id                       TEXT NOT NULL,
        period_start                    TEXT NOT NULL,
        period_end                      TEXT NOT NULL,
        generated_at                    TEXT NOT NULL,
        engine_name                     TEXT NOT NULL,
        status                          TEXT NOT NULL DEFAULT 'pending',

        -- Signing / rendering artefacts
        html_size          INTEGER NOT NULL DEFAULT 0,
        pdf_byte_length    INTEGER NOT NULL DEFAULT 0,
        pdf_base64         TEXT,
        pdf_hash           TEXT,
        hmac               TEXT,
        signed_at          TEXT,

        -- Report body
        summary_json       TEXT NOT NULL,

        -- Error tracking
        error              TEXT,

        -- Timestamps
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,

        PRIMARY KEY (id),
        UNIQUE (tenant_id, period_start, period_end)
      );

      CREATE INDEX IF NOT EXISTS idx_er_tenant  ON evidence_reports(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_er_period  ON evidence_reports(period_start, period_end);
      CREATE INDEX IF NOT EXISTS idx_er_status  ON evidence_reports(status);
    `);

    // For existing installs where 0008 already created the table, add missing columns.
    const existingColumns: Array<{ name: string }> = sqlite.pragma(
      "table_info(evidence_reports)",
    ) as Array<{ name: string }>;
    const haveCol = (name: string) =>
      existingColumns.some((c) => c.name === name);

    if (!haveCol("html_size")) {
      sqlite.exec(
        "ALTER TABLE evidence_reports ADD COLUMN html_size INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!haveCol("pdf_byte_length")) {
      sqlite.exec(
        "ALTER TABLE evidence_reports ADD COLUMN pdf_byte_length INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!haveCol("pdf_base64")) {
      sqlite.exec(
        "ALTER TABLE evidence_reports ADD COLUMN pdf_base64 TEXT",
      );
    }
    if (!haveCol("pdf_hash")) {
      sqlite.exec(
        "ALTER TABLE evidence_reports ADD COLUMN pdf_hash TEXT",
      );
    }
    if (!haveCol("hmac")) {
      sqlite.exec(
        "ALTER TABLE evidence_reports ADD COLUMN hmac TEXT",
      );
    }
    if (!haveCol("signed_at")) {
      sqlite.exec(
        "ALTER TABLE evidence_reports ADD COLUMN signed_at TEXT",
      );
    }
  }

  sqlite
    .prepare("INSERT OR IGNORE INTO __drizzle_migrations (hash) VALUES (?)")
    .run("v1-evidence-reports-signing-v1");
}
