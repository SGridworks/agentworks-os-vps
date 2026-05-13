/**
 * Migration 0020: native execution core.
 *
 * Creates the local execution work graph used while AWOS subsumes the legacy
 * coordinator API surface.
 */

import type { Database } from "better-sqlite3";

const HASH = "v20-execution-core";

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
    .get(HASH);
  if (existing) return;

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS execution_companies (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL DEFAULT 'awos',
      source_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS execution_projects (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      company_id TEXT NOT NULL REFERENCES execution_companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL DEFAULT 'awos',
      source_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS execution_agents (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      company_id TEXT REFERENCES execution_companies(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      role TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      config_json TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL DEFAULT 'awos',
      source_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS execution_issues (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      company_id TEXT NOT NULL REFERENCES execution_companies(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES execution_projects(id) ON DELETE CASCADE,
      identifier TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'todo',
      priority TEXT NOT NULL DEFAULT 'medium',
      assignee_agent_id TEXT REFERENCES execution_agents(id) ON DELETE SET NULL,
      parent_issue_id TEXT REFERENCES execution_issues(id) ON DELETE SET NULL,
      blocked_on_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL DEFAULT 'awos',
      source_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS execution_issue_comments (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      issue_id TEXT NOT NULL REFERENCES execution_issues(id) ON DELETE CASCADE,
      author_id TEXT,
      author_label TEXT NOT NULL,
      body TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'awos',
      source_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS execution_runs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      company_id TEXT NOT NULL REFERENCES execution_companies(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES execution_projects(id) ON DELETE SET NULL,
      issue_id TEXT REFERENCES execution_issues(id) ON DELETE SET NULL,
      agent_id TEXT REFERENCES execution_agents(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      started_at TEXT,
      ended_at TEXT,
      summary TEXT,
      source TEXT NOT NULL DEFAULT 'awos',
      source_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS execution_run_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      run_id TEXT NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      message TEXT,
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS execution_cost_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      company_id TEXT NOT NULL REFERENCES execution_companies(id) ON DELETE CASCADE,
      run_id TEXT REFERENCES execution_runs(id) ON DELETE SET NULL,
      issue_id TEXT REFERENCES execution_issues(id) ON DELETE SET NULL,
      provider TEXT,
      model TEXT,
      units REAL NOT NULL DEFAULT 0,
      amount_usd REAL NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS execution_webhook_intakes (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      received_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_exec_companies_tenant ON execution_companies(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_exec_projects_company ON execution_projects(company_id);
    CREATE INDEX IF NOT EXISTS idx_exec_agents_company ON execution_agents(company_id);
    CREATE INDEX IF NOT EXISTS idx_exec_issues_project ON execution_issues(project_id);
    CREATE INDEX IF NOT EXISTS idx_exec_issues_assignee ON execution_issues(assignee_agent_id);
    CREATE INDEX IF NOT EXISTS idx_exec_runs_issue ON execution_runs(issue_id);
    CREATE INDEX IF NOT EXISTS idx_exec_events_run ON execution_run_events(run_id);
    CREATE INDEX IF NOT EXISTS idx_exec_costs_company ON execution_cost_events(company_id);
    CREATE INDEX IF NOT EXISTS idx_exec_intakes_tenant ON execution_webhook_intakes(tenant_id);
  `);

  sqlite.prepare("INSERT INTO __drizzle_migrations (hash) VALUES (?)").run(HASH);
}
