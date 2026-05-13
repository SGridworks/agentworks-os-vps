/**
 * Migration 0014 — adds contact_id and contact_consent_source columns to policy_decisions.
 *
 * contact_id: optional UUID reference to an external contacts table. Used when
 *   the action involves a specific contact record (e.g. CRM lookup) so the
 *   decision can be joined back to the contact's consent record without
 *   denormalizing consent data into policy_decisions.
 *
 * contact_consent_source: preserves the consent_source value at decision time
 *   even when no contact_id is present. This decouples the consent source from
 *   the contact_id column — a contact may exist with no captured consent, or
 *   consent may be captured without a persistent contact record.
 *
 * LEARNINGS §4: schema additions require a committed migration.
 * Idempotent — checks __drizzle_migrations hash before applying.
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
    .get("v14-contact-consent-fields");
  if (existing) return;

  // Idempotent column-add: contact_id is a nullable UUID reference. The
  // earlier draft of this migration also renamed consent_source to
  // contact_consent_source, but no code path read the renamed column and
  // the rename broke every drizzle insert. The rename is retired; the
  // existing consent_source column stays as-is and continues to do the
  // same job (consent source for the contact involved in the action).
  const columns: Array<{ name: string }> = sqlite
    .pragma("table_info(policy_decisions)") as Array<{ name: string }>;
  const hasContactId = columns.some((c) => c.name === "contact_id");
  if (!hasContactId) {
    sqlite.exec("ALTER TABLE policy_decisions ADD COLUMN contact_id TEXT");
  }
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS idx_policy_decisions_contact_id ON policy_decisions(contact_id)",
  );

  sqlite
    .prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)")
    .run("v14-contact-consent-fields");
}
