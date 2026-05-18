/**
 * Migration 0035 - native AWOS automations.
 *
 * Stores first-party workflow definitions and run history inside the
 * AgentWorks daemon's own SQLite so automations do not depend on n8n or
 * an external workflow engine being available.
 */

import type { Database } from "better-sqlite3";

const HASH = "v35-native-automations";

export function migrate(sqlite: Database): void {
  const existing = sqlite
    .prepare("SELECT 1 FROM __drizzle_migrations WHERE hash = ?")
    .get(HASH);
  if (existing) return;

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS native_automation_workflows (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      name TEXT NOT NULL,
      trigger_kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'paused',
      description TEXT,
      definition_json TEXT NOT NULL,
      source_template_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_native_automation_workflows_company
      ON native_automation_workflows(company_id, status);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_native_automation_workflows_template
      ON native_automation_workflows(company_id, source_template_id)
      WHERE source_template_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS native_automation_runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES native_automation_workflows(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      status TEXT NOT NULL,
      input_json TEXT NOT NULL,
      output_json TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_native_automation_runs_workflow
      ON native_automation_runs(workflow_id, started_at DESC);

    CREATE INDEX IF NOT EXISTS idx_native_automation_runs_company
      ON native_automation_runs(company_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS native_automation_templates (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      name TEXT NOT NULL,
      trigger_kind TEXT NOT NULL,
      description TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'custom',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_native_automation_templates_company
      ON native_automation_templates(company_id, created_at DESC);
  `);

  sqlite.prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)").run(HASH);
}
