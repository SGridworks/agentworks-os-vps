/**
 * Migration 0036 - native automation n8n and AI metadata.
 *
 * Adds external bridge sync metadata so native workflows can track n8n
 * compatibility actions without making n8n the source of truth.
 */

import type { Database } from "better-sqlite3";

const HASH = "v36-native-automation-n8n-ai";

export function migrate(sqlite: Database): void {
  const existing = sqlite.prepare("SELECT 1 FROM __drizzle_migrations WHERE hash = ?").get(HASH);
  if (existing) return;

  sqlite.exec(`
    ALTER TABLE native_automation_workflows ADD COLUMN external_engine TEXT;
    ALTER TABLE native_automation_workflows ADD COLUMN external_workflow_id TEXT;
    ALTER TABLE native_automation_workflows ADD COLUMN external_sync_status TEXT;
    ALTER TABLE native_automation_workflows ADD COLUMN external_sync_at TEXT;
    ALTER TABLE native_automation_workflows ADD COLUMN external_sync_error TEXT;

    CREATE INDEX IF NOT EXISTS idx_native_automation_workflows_external
      ON native_automation_workflows(external_engine, external_workflow_id);
  `);

  sqlite.prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)").run(HASH);
}
